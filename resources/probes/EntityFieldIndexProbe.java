import java.sql.ResultSet;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import kd.bos.db.DB;
import kd.bos.db.DBRoute;
import kd.bos.db.ResultSetHandler;

/**
 * 影响面索引的**字段归属一侧**：本 ISV 的设计态实体里，某个字段标识属于哪张单据、
 * 在表头还是分录/子分录、挂在哪个分录下。结论走 JSON 旁路（`[PROBE-JSON] t=field`），
 * 由 driver.mjs impact build 收走。
 *
 * 只读。不 readMeta、不改任何东西。
 *
 * 为什么要有：**字段标识只在一张单据内唯一**。实测本工程 374 个源码里出现过的字段标识里
 * 103 个（28%）挂在不止一张单据上（`zlgd_org` 10 张、`zlgd_year` 5 张）。没有归属时
 * `impact zlgd_year` 会把五张毫不相干的单据并成一个「影响面」，那是巧合的并集不是影响面。
 *
 * 坑：**别按「枚举实体 + readMeta 逐个读」做**，理由同 PluginIndexProbe（readMeta 几百毫秒
 * 一个）。设计态 XML 就在 t_meta_entitydesign 的 FDATA 里，纯 indexOf 扫标签流，
 * 实测 635KB 的大单 8ms 扫完。
 *
 * XML 形状（实测 zlgd_sys_test_bill）：
 *   BillEntity      表头容器，Key=实体标识，无 ParentId
 *   EntryEntity     分录，无 ParentId
 *   SubEntryEntity  子分录，ParentId=所属 EntryEntity 的 Id
 *   *Field          字段（TextField/DecimalField/ComboField/BasedataField/OrgField/…），
 *                   ParentId 指所属分录的 Id；**没有 ParentId 就是表头字段**
 * 继承来的原厂字段（billno / billstatus）不在子单据的设计里 —— 那本来也不该进召回集；
 * 但每张单从哪继承要报出来（t=fieldbase，见 bases），否则「没收到」会被当成「不在这张单上」。
 *
 * 扫的是**全部**本 ISV 实体设计（本工程 2547 份 / 41MB），不能像 PluginIndexProbe 那样用
 * `fdata like` 前置过滤 —— 要回答的正是「这个 key 全库有几张单」，过滤掉的那部分就是答案。
 * 实测总耗时 75 秒，其中扫描只占 0.2 秒，剩下全是把 41MB XML 拉回来的网络时间。
 *
 *   IDX_ISV            只扫这个 ISV 的元数据，默认取本工程 ISV
 *   IDX_FIELDS         只报这些字段标识的归属，逗号分隔（driver 从源码索引里的字段集推）。
 *   IDX_FIELDS_FILE    同上，一行一个（白名单长到装不进环境变量时用这个）。
 *                      两个都不给就全报 —— 那是几十万条，只在人工排查时用
 *   IDX_ENTITIES       只报这些实体上的归属，逗号分隔（driver 从源码索引里的实体集推）。
 *   IDX_ENTITIES_FILE  同上，一行一个。都不给就不按实体过滤。
 *                      **跨单据同名的总数不受它影响**，那个数走 t=fieldowners，统计的始终是
 *                      全库 —— 「zlgd_org 全库 234 张单都有」这句话本身就是判据
 *   IDX_ALL_ON_ENTITIES=1  IDX_ENTITIES 上的字段全报，不看 IDX_FIELDS；t=fieldowners 报全库每个标识。
 *                      代码碰过、挂了插件的单据字段收全，「这张单有没有这个字段」才答得了
 *                      （全库扫描本来就要读每份设计，收全不多花时间）
 *   IDX_SCAN_FILE      补扫：只重扫这些实体，一行一个；它们的字段全报，不看白名单，不报 t=fieldowners。
 *                      查不到的就是删掉了
 *
 * t=fieldowners 带 on=[实体…]：全库带这个标识的单据清单。补扫只重扫变了的单，把它们从每份清单里
 * 拿出来、按现在的样子放回去，所以清单要整份留着，不只留代码用到的那些标识。
 *
 * t=billname：每份实体设计的中文名（t_meta_entitydesign_l 的 FNAME，zh_CN；真机 2026-10-04 确认，
 * 设计 XML 根上的 <Name> 是同一个值）。本工程扩展平台单据时，扩展设计有自己的编号
 * （zlgd_im_saloutbill_ext），FMASTERID 指回原单（im_saloutbill）——插件登记和代码用的都是原单编号，
 * 所以带上 base=原单编号。全量扫报本 ISV 每一份，补扫只报重扫的那几份。
 */
public class EntityFieldIndexProbe {

    /** 一个带 Key 的 XML 块 */
    static final class Block {
        final String name;
        String key;
        String id;
        String parentId;

        Block(String n) {
            name = n;
        }
    }

    public static void run() {
        String isv = env("IDX_ISV", IsvGuard.ISV);
        if (isv.isEmpty()) {
            throw new IllegalArgumentException("拿不到 ISV：给 IDX_ISV，或跑 driver.mjs doctor 看 isv 这一项");
        }
        if (!isv.matches("[A-Za-z0-9]+")) {
            //FISV 要拼进 SQL 字面量，形状先卡死
            throw new IllegalArgumentException("ISV 形状不合法（只允许字母数字）：" + isv);
        }
        final Set<String> scanOnly = names("IDX_SCAN");
        if (!scanOnly.isEmpty()) {
            partial(isv, scanOnly);
            return;
        }
        final boolean all = !env("IDX_ALL_ON_ENTITIES", "").isEmpty();
        final Set<String> want = names("IDX_FIELDS");
        final Set<String> onlyOn = names("IDX_ENTITIES");
        final Set<String> emitted = new HashSet<String>();
        System.out.println("[PROBE] ISV=" + isv + (all ? "  单据字段收全" : "")
                + "  字段 " + (want.isEmpty() ? "全部" : String.valueOf(want.size()))
                + "  实体 " + (onlyOn.isEmpty() ? "全部" : String.valueOf(onlyOn.size())));

        final long[] stat = new long[4];   // 0=实体数 1=扫过的字符 2=报出的记录 3=扫描毫秒
        final Map<String, Set<String>> owners = new LinkedHashMap<String, Set<String>>();
        final List<String> scanned = new ArrayList<String>();
        long t0 = System.currentTimeMillis();
        DB.query(DBRoute.meta, "select fnumber, fdata from t_meta_entitydesign"
                + " where fisv = " + lit(isv) + " and fdata is not null",
                new ResultSetHandler<Void>() {
                    public Void handle(ResultSet rs) throws Exception {
                        while (rs.next()) {
                            String entity = rs.getString(1);
                            String data = rs.getString(2);
                            if (data == null) {
                                continue;
                            }
                            stat[0]++;
                            if (onlyOn.isEmpty() || onlyOn.contains(entity)) {
                                scanned.add(entity);
                            }
                            stat[1] += data.length();
                            long m0 = System.currentTimeMillis();
                            List<Block> blocks = walk(data);
                            stat[3] += System.currentTimeMillis() - m0;
                            emitAll(entity, blocks, all ? ALL : want, onlyOn, owners, stat, emitted);
                        }
                        return null;
                    }
                });
        long ms = System.currentTimeMillis() - t0;
        int multi = 0;
        int counted = 0;
        for (Map.Entry<String, Set<String>> e : owners.entrySet()) {
            //全库有几张单带这个标识 —— 判「这个 key 到底指不指得准一张单」就靠它，
            //跟 IDX_ENTITIES 过滤无关，所以每个 key 都要报，哪怕一条归属都没报出去。
            //收全时 owners 里是全库每个标识，整份报出去；下面的计数只算白名单和收进来的那些
            owners(e.getKey(), e.getValue());
            if (all && !want.contains(e.getKey()) && !emitted.contains(e.getKey())) {
                continue;
            }
            counted++;
            if (e.getValue().size() > 1) {
                multi++;
            }
        }
        int named = billNames(isv, null);
        int bases = bases(isv, scanned);
        ProbeJson.emit("field-summary", "mode", all ? "all" : "asked", "entities", stat[0], "rows", stat[2],
                "isv", isv, "bases", bases);
        System.out.println("[PROBE] 实体设计 " + stat[0] + " 份 / " + (stat[1] / 1024 / 1024)
                + "MB XML → 字段归属 " + stat[2] + " 条，覆盖 " + counted + " 个标识（其中 "
                + multi + " 个跨单据同名），单据中文名 " + named + " 个，扫描 " + stat[3] + "ms / 总 " + ms + "ms");
    }

    /**
     * 单据中文名：一份设计一条，`only` 为 null 就是本 ISV 全部。
     * 多语言表里同一份设计可能有不止一行 zh_CN（实体、表单各一行，名字相同），按编号只报第一行。
     */
    private static int billNames(String isv, List<String> only) {
        final Set<String> seen = new HashSet<String>();
        DB.query(DBRoute.meta, "select m.fnumber, p.fnumber, l.fname from t_meta_entitydesign m"
                + " left join t_meta_entitydesign p on p.fid = m.fmasterid and m.fmasterid <> m.fid"
                + " join t_meta_entitydesign_l l on l.fid = m.fid and l.flocaleid = 'zh_CN'"
                + " where m.fisv = " + lit(isv) + (only == null ? "" : " and m.fnumber in (" + quoted(only) + ")"),
                new ResultSetHandler<Void>() {
                    public Void handle(ResultSet rs) throws Exception {
                        while (rs.next()) {
                            String bill = nz(rs.getString(1));
                            String name = nz(rs.getString(3)).trim();
                            if (bill.isEmpty() || name.isEmpty() || !seen.add(bill)) {
                                continue;
                            }
                            ProbeJson.emit("billname", "entity", bill, "base", nz(rs.getString(2)), "name", name);
                        }
                        return null;
                    }
                });
        return seen.size();
    }

    /**
     * 每张扫过的单从哪继承（`t=fieldbase`）：本 ISV 的父设计（近的在前），和链上第一份别家的设计
     * （`outside`，多半是原厂模板 bos_billtpl）。
     *
     * 这里只扫各单自己的设计 XML，继承来的字段（billno、billstatus，或本 ISV 模板上的字段）不在里面。
     * 不报这条，「这张单的字段收全了」就会被读成「没收到的字段就不在这张单上」——真机上
     * zlgd_sys_test_bill.billno 被说成「不在这张单上」就是这么来的。
     * 只读三列不拉 FDATA；父设计查不到时 outside 记它的 FID，判不了就当别家的。
     */
    private static int bases(final String isv, List<String> entities) {
        if (entities.isEmpty()) {
            return 0;
        }
        final Map<String, String[]> byFid = new HashMap<String, String[]>();
        final Map<String, String[]> own = new HashMap<String, String[]>();
        DB.query(DBRoute.meta, "select fid, fnumber, fparentid, fisv from t_meta_entitydesign",
                new ResultSetHandler<Void>() {
                    public Void handle(ResultSet rs) throws Exception {
                        while (rs.next()) {
                            String[] d = {nz(rs.getString(2)), nz(rs.getString(3)).trim(), nz(rs.getString(4))};
                            byFid.put(nz(rs.getString(1)), d);
                            if (isvOf(d).equals(isv) && !own.containsKey(d[0])) {
                                own.put(d[0], d);
                            }
                        }
                        return null;
                    }
                });
        int n = 0;
        for (String entity : entities) {
            String[] d = own.get(entity);
            if (d == null) {
                continue;
            }
            List<String> parents = new ArrayList<String>();
            String outside = "";
            String at = d[1];
            for (int guard = 0; !at.isEmpty() && guard < 16; guard++) {
                String[] p = byFid.get(at);
                if (p == null) {
                    outside = at;
                    break;
                }
                if (!isvOf(p).equals(isv)) {
                    outside = p[0];
                    break;
                }
                parents.add(p[0]);
                at = p[1];
            }
            ProbeJson.emit("fieldbase", "entity", entity, "outside", outside, "parents", parents);
            n++;
        }
        return n;
    }

    private static String isvOf(String[] design) {
        return design[2];
    }

    /** 收全时传给 emitAll 的「白名单」：空集就是不按标识过滤。 */
    private static final Set<String> ALL = java.util.Collections.<String>emptySet();

    private static void owners(String key, Set<String> on) {
        List<String> list = new ArrayList<String>(on);
        java.util.Collections.sort(list);
        ProbeJson.emit("fieldowners", "key", key, "entities", list.size(), "on", list);
    }

    /**
     * 补扫：只重扫点了名的实体，字段全报。不拉全库 XML —— 那是 75 秒，补扫要在几秒内交还常驻 JVM。
     */
    private static void partial(String isv, Set<String> scanOnly) {
        final long t0 = System.currentTimeMillis();
        final long[] stat = new long[4];
        final Map<String, Set<String>> ignored = new HashMap<String, Set<String>>();
        final Set<String> none = new HashSet<String>();
        final Set<String> sink = new HashSet<String>();
        final List<String> scanned = new ArrayList<String>();
        List<String> entities = shaped(scanOnly);
        for (int from = 0; from < entities.size(); from += BATCH) {
            List<String> part = entities.subList(from, Math.min(entities.size(), from + BATCH));
            DB.query(DBRoute.meta, "select fnumber, fdata from t_meta_entitydesign where fisv = " + lit(isv)
                    + " and fdata is not null and fnumber in (" + quoted(part) + ")", new ResultSetHandler<Void>() {
                        public Void handle(ResultSet rs) throws Exception {
                            while (rs.next()) {
                                String data = rs.getString(2);
                                if (data == null) {
                                    continue;
                                }
                                stat[0]++;
                                scanned.add(rs.getString(1));
                                emitAll(rs.getString(1), walk(data), ALL, none, ignored, stat, sink);
                            }
                            return null;
                        }
                    });
            billNames(isv, part);
        }
        int bases = bases(isv, scanned);
        ProbeJson.emit("field-summary", "mode", "partial", "entities", stat[0], "rows", stat[2],
                "isv", isv, "bases", bases);
        System.out.println("[PROBE] 补扫实体 " + stat[0] + " / " + scanOnly.size() + " 份 → 字段 " + stat[2]
                + " 条，" + (System.currentTimeMillis() - t0) + "ms");
    }

    /**
     * 能拼进 SQL 的 in 字面量的那些：实体标识只有字母数字下划线，别的形状不可能是实体。
     *
     * 点名清单来自登记里「挂在哪张单」那一列，没写业务对象的开放平台接口在那里填的是接口编号
     * （`trd/share/ticketflow/recsettlestatue`）。它不是实体，查也查不到行，和完整重建里
     * 「没有字段」是同一个结果；先前在这里抛异常，一条接口就让整批补扫失败、快照永远停住。
     */
    private static List<String> shaped(Set<String> values) {
        List<String> out = new ArrayList<String>();
        List<String> skipped = new ArrayList<String>();
        for (String v : values) {
            (v.matches("[A-Za-z0-9_]+") ? out : skipped).add(v);
        }
        if (!skipped.isEmpty()) {
            System.out.println("[PROBE] 不是实体标识的形状，按没有字段算：" + skipped);
        }
        return out;
    }

    /** 一条 in 最多带几个值。 */
    private static final int BATCH = 100;

    private static String quoted(List<String> values) {
        StringBuilder b = new StringBuilder();
        for (String v : values) {
            b.append(b.length() == 0 ? "" : ",").append(lit(v));
        }
        return b.toString();
    }

    /**
     * 白名单：`IDX_X` 逗号分隔，或 `IDX_X_FILE` 一行一个。
     * 有文件这条路是因为**白名单会长到装不进环境变量** —— 本工程扩了 sink 之后源码里出现过的
     * 字段标识上千个，几万字符。装不下时不报错、静默截断，那是最难查的那种错。
     */
    private static Set<String> names(String key) {
        Set<String> out = new HashSet<String>();
        String file = env(key + "_FILE", "");
        if (!file.isEmpty()) {
            try {
                for (String line : new String(java.nio.file.Files.readAllBytes(
                        java.nio.file.Paths.get(file)), "UTF-8").split("\n")) {
                    add(out, line);
                }
            } catch (java.io.IOException e) {
                throw new IllegalArgumentException(key + "_FILE 读不了：" + file, e);
            }
            return out;
        }
        for (String k : env(key, "").split(",")) {
            add(out, k);
        }
        return out;
    }

    private static void add(Set<String> out, String raw) {
        String k = raw.trim();
        if (!k.isEmpty()) {
            out.add(k);
        }
    }

    /** 把一份设计态 XML 摊成「字段 → 实体 / 层级 / 所属分录」并报出去 */
    private static void emitAll(String entity, List<Block> blocks, Set<String> want,
                                Set<String> onlyOn, Map<String, Set<String>> owners, long[] stat,
                                Set<String> emitted) {
        Map<String, Block> byId = new HashMap<String, Block>();
        for (Block b : blocks) {
            if (b.id != null) {
                byId.put(b.id, b);
            }
        }
        for (Block b : blocks) {
            boolean isField = b.name.endsWith("Field");
            //分录容器本身也报：源码里 getEntryEntity("zlgd_entryentity") /
            //getDynamicObjectCollection(...) 拿到的是分录 key，跟字段 key 混在同一个池子里。
            //不报的话它们全落进「归属不明」，看起来像元数据查不到，其实是根本不是字段
            boolean isBox = "EntryEntity".equals(b.name) || "SubEntryEntity".equals(b.name);
            if ((!isField && !isBox) || b.key == null || b.key.isEmpty()) {
                continue;
            }
            if (!want.isEmpty() && !want.contains(b.key)) {
                continue;
            }
            String level = "header";
            String entry = "";
            String parentEntry = "";
            if (isBox) {
                //分录容器：level 就是它自己是什么，entry 指向自己
                level = "SubEntryEntity".equals(b.name) ? "subentry" : "entry";
                entry = b.key;
                Block owner = b.parentId == null ? null : byId.get(b.parentId);
                parentEntry = owner == null ? "" : nz(owner.key);
                emit(entity, b.key, level, entry, parentEntry, "container", owners, stat, onlyOn, emitted);
                continue;
            }
            Block p = b.parentId == null || b.parentId.isEmpty() ? null : byId.get(b.parentId);
            if (p != null && "SubEntryEntity".equals(p.name)) {
                level = "subentry";
                entry = nz(p.key);
                //子分录再往上那一层分录也报出来：查「谁碰了这条分录」时用得上
                Block up = p.parentId == null ? null : byId.get(p.parentId);
                parentEntry = up == null ? "" : nz(up.key);
            } else if (p != null && "EntryEntity".equals(p.name)) {
                level = "entry";
                entry = nz(p.key);
            } else if (p != null && !"BillEntity".equals(p.name)) {
                //ParentId 指到别的东西（多半是分组面板）—— 别猜成表头，如实标 unknown
                level = "unknown";
                entry = nz(p.key);
            }
            emit(entity, b.key, level, entry, parentEntry, "field", owners, stat, onlyOn, emitted);
        }
    }

    private static void emit(String entity, String key, String level, String entry,
                             String parentEntry, String kind, Map<String, Set<String>> owners,
                             long[] stat, Set<String> onlyOn, Set<String> emitted) {
        //先记全库归属（判重名用），再决定这一条要不要报出去
        Set<String> s = owners.get(key);
        if (s == null) {
            s = new HashSet<String>();
            owners.put(key, s);
        }
        s.add(entity);
        if (!onlyOn.isEmpty() && !onlyOn.contains(entity)) {
            return;
        }
        ProbeJson.emit("field", "entity", entity, "key", key, "level", level,
                "entry", entry, "parentEntry", parentEntry, "kind", kind);
        stat[2]++;
        emitted.add(key);
    }

    /**
     * 扫标签流，收集「直接带 Key 子元素」的块。
     *
     * 不用正则：一份 FDATA 有几十万字符，通配正则要把每一段文本都试一遍；indexOf 只在
     * 真出现尖括号的位置做事，实测 635KB 8ms。
     */
    static List<Block> walk(String d) {
        List<Block> out = new ArrayList<Block>();
        List<Block> stack = new ArrayList<Block>();
        int i = 0;
        while (true) {
            int lt = d.indexOf('<', i);
            if (lt < 0) {
                break;
            }
            int gt = d.indexOf('>', lt);
            if (gt < 0) {
                break;
            }
            String tag = d.substring(lt + 1, gt);
            i = gt + 1;
            if (tag.startsWith("?") || tag.startsWith("!") || tag.endsWith("/")) {
                continue;
            }
            if (tag.startsWith("/")) {
                if (!stack.isEmpty()) {
                    Block b = stack.remove(stack.size() - 1);
                    if (b.key != null) {
                        out.add(b);
                    }
                }
                continue;
            }
            int sp = tag.indexOf(' ');
            String name = sp < 0 ? tag : tag.substring(0, sp);
            //叶子标量（<Key>v</Key> 这种）：值直接挂到父块上，不入栈
            int close = d.indexOf("</" + name + ">", i);
            if (close >= 0 && close == d.indexOf('<', i)) {
                if (!stack.isEmpty()) {
                    String v = d.substring(i, close);
                    Block p = stack.get(stack.size() - 1);
                    if ("Key".equals(name)) {
                        p.key = v;
                    } else if ("Id".equals(name)) {
                        p.id = v;
                    } else if ("ParentId".equals(name)) {
                        p.parentId = v;
                    }
                }
                i = close + name.length() + 3;
                continue;
            }
            stack.add(new Block(name));
        }
        return out;
    }

    private static String nz(String s) {
        return s == null ? "" : s;
    }

    /** SQL 字面量：形状已经卡死过，这里只是别让单引号拼错 */
    private static String lit(String s) {
        return "'" + s + "'";
    }

    private static String env(String k, String def) {
        String v = System.getenv(k);
        return v == null || v.trim().isEmpty() ? def : v;
    }
}
