import java.sql.ResultSet;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

import kd.bos.db.DB;
import kd.bos.db.DBRoute;
import kd.bos.db.ResultSetHandler;

/**
 * 影响面索引的**元数据一侧**：本 ISV 的设计态元数据里，哪个插件类登记在哪张单据/布局上。
 * 结论走 JSON 旁路（`[PROBE-JSON] t=binding`），由 driver.mjs impact build 收走。
 *
 * 只读。不 readMeta、不改任何东西。
 *
 * 坑：**别按「枚举布局 + readMeta 逐个读」做**。实测 readMeta(Form) 430ms/个，
 * 本工程 2220 张 zlgd_ 布局要 956 秒，超验收线（60 秒）16 倍，而且 PrintMetadata
 * 会在强转 FormMetadata 时抛 ClassCastException。设计态元数据本身就在
 * t_meta_formdesign / t_meta_entitydesign 的 FDATA（XML 全文）里，一条 SQL 全扫完，
 * 插件类名从 XML 全文里摘。
 *
 * 事实：这三张表都有 **FISV** 列，所以「本 ISV 的元数据」是查得到的，不用靠标识前缀猜。
 * 表单插件在 formdesign 的 FDATA 里，**操作插件和校验器在 entitydesign 的 FDATA 里**，
 * **打印插件在 t_svc_printmeta 的 FDATA 里** —— 少扫一张就整族插件没有绑定关系。
 * 打印模板本体是 `bos_print_meta`/`t_svc_printmeta`；`bos_manageprinttpl` 只是目录，没有设计内容。
 *
 * 上面那句「少扫一张就整族没有绑定关系」在 2026-09-04 又应验了四次。当时只扫这三张表，
 * 拿源码索引的 pluginType 和绑定结果对一遍，缺口是明摆着的：convert 10 个类命中 0、
 * task 26 个命中 1、api.webservice 一族 18 个命中 0、workflow 一族 7 个命中 0。
 * **而它报的不是「这一族我没扫」，是「无绑定」** —— 使用者会当成「这个插件没挂在任何单据上，
 * 改它不影响别处」。假阴性比缺失危险，所以后面四处一并扫，并在 summary 里报 sites=扫过哪些位置。
 *
 * 四处的表、类名落在哪一列，都是真机 information_schema + 逐列 count(like) 问出来的，不是猜的：
 *
 *   task      t_sch_taskdefine（路由 sys）        FCLASSNAME 直接是类名，FNUMBER 是任务编码
 *   api       t_open_apiservice（路由 sys）       FCLASSNAME=自定义 API 实现类、FPLUGIN=API 插件，
 *                                                FBIZOBJECT 就是它写的那张单
 *   convert   T_BOTP_ConvertRule（路由 sys.meta） FDATA 全文（和 formdesign 一个套路），
 *                                                源单/目标单在 FSOURCEENTITYNUMBER/FTARGETENTITYNUMBER
 *   workflow  t_wf_gebytearray.FCONTENT（BPMN XML 全文）join t_wf_procdef 拿 FENTRABILL；
 *             参与人插件另在 t_wf_participantmodel.FVALUE，join FPROCDEFID 拿同一列
 *
 * 三个坑，踩过了记这里：
 *   1. 元数据库的路由 key 是 **sys.meta**，`DBRoute.of("meta")` 报 datacenter not set。
 *   2. `t_wf_plugininfos` 这张表名字最像正解（FPROCNUMBER/FNODENUMBER/FPLUGIN/FENTRABILL 齐全），
 *      但本账套 **0 行** —— 它是汇总表，不能当判据。真正有货的是 gebytearray 里的 BPMN 全文。
 *   3. 这四处**一律不按 FISV 过滤**，只按包前缀 like。`t_sch_taskdefine` 有 FISV，但客户自己建的
 *      任务定义未必登记成本 ISV；包前缀本身已经锁死归属，ISV 过滤只会误杀。
 *
 * 除绑定外还报 `t=name`：**编号 → 人嘴里的名字**（模板名、任务名、接口名、转换规则名、流程名）。
 * 需求是用名字提的、编号是查出来的，没有这一层，用户刚说完话那一轮就只剩措辞相似度可用。
 * 名称列**先问再取**（`select * from 表 where 1=2` 拿列清单），确认不了就报「这一族没有名称列」
 * 并跳过 —— 见 scanNames。
 *
 *   IDX_PKGS      要找的 Java 包前缀，逗号分隔（必填，driver 从源码索引的类名推）
 *   IDX_ISV       只扫这个 ISV 的元数据，默认取本工程 ISV
 *   IDX_ONLY_FILE 只重扫这些行：一行「位置<TAB>编号」（编号即登记里的 layout，见 MetaChangeProbe）。
 *                 给了它，没点名的位置整个不扫；点名的编号查不到行，就是那一行删掉了（不报登记）。
 *                 补扫快照时用，汇总行带 partial=true。编号含引号、反斜杠或控制字符的行拼不进查询，
 *                 跳过并在汇总行 skipped 里原样报出（「位置 编号」），同批其它行照扫
 */
public class PluginIndexProbe {

    /**
     * 从 XML 全文里摘以某个包前缀开头的全限定名。
     *
     * 用 indexOf 定位再左右扩边界，**不用正则全文扫**：单张单据的 FDATA 有 19 万字符，
     * 一个 `标识符(\.标识符)+` 的通配正则要把每一段文本都试一遍，全量下这部分就是几十秒。
     * indexOf 只在真出现包前缀的位置做事。
     */
    private static void extract(String data, String pkg, Set<String> out) {
        int i = data.indexOf(pkg);
        while (i >= 0) {
            if (i > 0 && isIdentPart(data.charAt(i - 1))) {
                //前面还连着标识符字符，说明这是别的名字的尾巴，不是包名开头
                i = data.indexOf(pkg, i + 1);
                continue;
            }
            int e = i + pkg.length();
            while (e < data.length() && (isIdentPart(data.charAt(e)) || data.charAt(e) == '.')) {
                e++;
            }
            while (e > i && data.charAt(e - 1) == '.') {
                e--;
            }
            if (e > i + pkg.length()) {
                out.add(data.substring(i, e));
            }
            i = data.indexOf(pkg, Math.max(e, i + 1));
        }
    }

    private static boolean isIdentPart(char c) {
        return c == '_' || c == '$' || (c >= '0' && c <= '9')
                || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
    }

    public static void run() throws Exception {
        List<String> pkgs = new ArrayList<String>();
        for (String p : req("IDX_PKGS", "要找的 Java 包前缀，逗号分隔，如 zlgd.").split(",")) {
            p = p.trim();
            if (p.isEmpty()) {
                continue;
            }
            if (!p.matches("[A-Za-z0-9_$.]+")) {
                //前缀要拼进 SQL 的 like 字面量，形状先卡死
                throw new IllegalArgumentException("包前缀形状不合法：" + p);
            }
            pkgs.add(p.endsWith(".") ? p : p + ".");
        }
        if (pkgs.isEmpty()) {
            throw new IllegalArgumentException("IDX_PKGS 里一个包前缀都没有");
        }
        String isv = env("IDX_ISV", IsvGuard.ISV);
        if (isv.isEmpty()) {
            throw new IllegalArgumentException("拿不到 ISV：给 IDX_ISV，或跑 driver.mjs doctor 看 isv 这一项");
        }
        if (!isv.matches("[A-Za-z0-9]+")) {
            //FISV 要拼进 SQL 字面量，形状先卡死
            throw new IllegalArgumentException("ISV 形状不合法（只允许字母数字）：" + isv);
        }
        ONLY.putAll(only(env("IDX_ONLY_FILE", "")));
        System.out.println("[PROBE] ISV=" + isv + "  包前缀=" + pkgs
                + (PARTIAL ? "  只重扫 " + ONLY : ""));
        if (!SKIPPED.isEmpty()) {
            System.out.println("[PROBE] 跳过 " + SKIPPED.size() + " 行（编号含引号、反斜杠或控制字符，拼不进查询）：" + SKIPPED);
        }

        long t0 = System.currentTimeMillis();
        final Map<String, String> entityNumberById = new HashMap<String, String>();
        //补扫只要点了名的布局所属的实体：全表 4 万多行要 1.9 秒，比补扫本身还慢；不补布局就一行都不要
        String byId = !PARTIAL ? ""
                : ONLY.containsKey("form")
                ? " where fid in (select fentityid from t_meta_formdesign where 1=1" + in("form", "fnumber") + ")"
                : " where 1=2";
        DB.query(DBRoute.meta, "select fid, fnumber from t_meta_entitydesign" + byId,
                new ResultSetHandler<Void>() {
                    public Void handle(ResultSet rs) throws Exception {
                        while (rs.next()) {
                            entityNumberById.put(rs.getString(1), rs.getString(2));
                        }
                        return null;
                    }
                });
        System.out.println("[PROBE] 实体 id→标识 " + entityNumberById.size() + " 条，"
                + (System.currentTimeMillis() - t0) + "ms");

        //把「含不含本 ISV 的包名」推给数据库：本工程 2220 张 zlgd_ 布局里只有几百张真登记了插件，
        //不加这个前置过滤就要把几百 MB 的 XML 全文拉回进程再扔掉。
        StringBuilder like = new StringBuilder();
        for (String p : pkgs) {
            like.append(like.length() == 0 ? " and (" : " or ").append("fdata like '%").append(p).append("%'");
        }
        like.append(')');

        Scan form = scan("form", pkgs, entityNumberById,
                "select fnumber, fentityid, fdata from t_meta_formdesign"
                        + " where fisv = '" + isv + "' and fdata is not null" + like + in("form", "fnumber"));
        Scan entity = scan("entity", pkgs, entityNumberById,
                "select fnumber, fnumber, fdata from t_meta_entitydesign"
                        + " where fisv = '" + isv + "' and fdata is not null" + like + in("entity", "fnumber"));

        //打印模板：本体在 t_svc_printmeta（不是 bos_manageprinttpl，那是目录），插件类名以
        //"ClassName":"…" 出现在 FDATA 里，FBILLFORMID 就是绑的单据。不扫这张表的后果实测：
        //本工程 35 个打印插件**一个都没有绑定**，而打印又是需求的大头
        Scan tpl = scanTpl(isv, pkgs, like.toString());

        //下面四处不在设计态元数据库里，各是各的表、各是各的读法（见文件头）
        Scan sch = scanSch(pkgs);
        Scan api = scanApi(pkgs);
        Scan botp = scanBotp(pkgs);
        Scan wf = scanWf(pkgs);

        scanNames(tpl, sch, api, botp, wf);

        Scan[] all = new Scan[]{form, entity, tpl, sch, api, botp, wf};
        Set<String> classes = new TreeSet<String>();
        int rows = 0;
        int binds = 0;
        for (Scan one : all) {
            classes.addAll(one.classes);
            rows += one.rows;
            binds += one.bindings;
        }
        System.out.println("[PROBE] 合计 " + binds + " 条登记，"
                + classes.size() + " 个插件类，" + rows + " 份设计态元数据，"
                + (System.currentTimeMillis() - t0) + "ms");
        //人读行和 JSON 旁路同源：上面这条结论下面这条 summary 也有。
        //sites 是**这次扫过哪些注册位置**：少了哪一族，查询侧要能说「这一族没扫」而不是「无绑定」。
        ProbeJson.emit("binding-summary", "isv", isv,
                "partial", PARTIAL,
                "skipped", SKIPPED,
                "scanned", rows,
                "bindings", binds,
                "classes", classes.size(),
                "sites", SITES,
                "ms", System.currentTimeMillis() - t0);
    }

    /** IDX_ONLY_FILE 读出来的「位置 → 编号」。 */
    private static final Map<String, List<String>> ONLY = new HashMap<String, List<String>>();

    /** 给了 IDX_ONLY_FILE 就是补扫：没点名的位置整个不扫，哪怕点名的行全被跳过也不退回全量。 */
    private static boolean PARTIAL = false;

    /** 补扫时拼不进 SQL 字面量、只好跳过的行，原样「位置 编号」，在汇总行里报出去。 */
    private static final List<String> SKIPPED = new ArrayList<String>();

    /**
     * 编号能不能原样放进单引号字面量：只挡引号、反斜杠和控制字符，别的一律放行。
     *
     * 编号是元数据库里本来就有的值，形状由平台定，不由这里定：开放平台接口的编号是路径式的
     * （`trd/share/ticketflow/recsettlestatue`），先前按「字母数字 _.$#-」白名单卡，
     * 一条新建接口就让整批补扫抛异常；快照不推进、下次喂同一批行再失败，元数据侧就永远停在那天。
     * 挡下的三类是字面量里真会出事的字符（反斜杠在 MySQL 默认模式下是转义符），
     * 这种行跳过并报出，不拖垮同批的其它行。
     */
    static boolean literalSafe(String number) {
        for (int i = 0; i < number.length(); i++) {
            char c = number.charAt(i);
            if (c == '\'' || c == '\\' || c < 0x20 || c == 0x7f) {
                return false;
            }
        }
        return true;
    }

    private static Map<String, List<String>> only(String file) throws java.io.IOException {
        Map<String, List<String>> out = new HashMap<String, List<String>>();
        if (file.isEmpty()) {
            return out;
        }
        PARTIAL = true;
        for (String line : new String(java.nio.file.Files.readAllBytes(java.nio.file.Paths.get(file)), "UTF-8")
                .split("\n")) {
            int tab = line.indexOf('\t');
            if (tab <= 0) {
                continue;
            }
            String site = line.substring(0, tab).trim();
            String number = line.substring(tab + 1).trim();
            if (!SITES.contains(site) || number.isEmpty()) {
                continue;
            }
            if (!literalSafe(number)) {
                SKIPPED.add(site + " " + number);
                continue;
            }
            List<String> list = out.get(site);
            if (list == null) {
                list = new ArrayList<String>();
                out.put(site, list);
            }
            list.add(number);
        }
        if (out.isEmpty() && SKIPPED.isEmpty()) {
            //给了文件却一行都没认出来：多半是文件格式错了，宁可报错也不当成「没东西要补」
            throw new IllegalArgumentException("IDX_ONLY_FILE 里一行「位置<TAB>编号」都没有：" + file);
        }
        return out;
    }

    /** 补扫时这一处要不要扫：全量扫一律扫，补扫只扫点了名的位置。 */
    private static boolean skip(String site) {
        return PARTIAL && !ONLY.containsKey(site);
    }

    /** 补扫时拼 " and 列 in ('a','b')"；全量扫返回空串。引号、反斜杠 only() 已挡在外面。 */
    private static String in(String site, String col) {
        List<String> numbers = ONLY.get(site);
        if (numbers == null) {
            return "";
        }
        StringBuilder b = new StringBuilder(" and ").append(col).append(" in (");
        for (int i = 0; i < numbers.size(); i++) {
            b.append(i == 0 ? "'" : ",'").append(numbers.get(i)).append('\'');
        }
        return b.append(')').toString();
    }

    /** 这次扫过的注册位置。加一处扫描就往这里加一个名字，查询侧靠它区分「没扫」和「没绑」。 */
    private static final List<String> SITES = java.util.Arrays.asList(
            "form", "entity", "print", "task", "api", "convert", "workflow");

    /**
     * 名称目录：**编号 → 人嘴里的那个名字**。
     *
     * 为什么非要它：需求是用名字提的（「金相双语报告打歪了」「采购合同审批流走不通」），
     * 编号是查出来的。没有这一层，第一轮召回（用户刚说完话、还没探查）就只剩自然语言相似度，
     * 而措辞相似永远不能确立身份。
     *
     * 上一版没有这一层，改从台账正文学 2–6 字滑动窗口当名字。真数据上它退化成噪声：
     * 14 个对象学出 7215 条「名称」，「这次改的是发货单的数量单位」因为含「单的」两个字
     * 就命中了内部加工记录的取样部位字段。**一句话里碰巧出现的字不是对象的名字。**
     *
     * 这里的做法是**先问再取，不猜列名**：每一族先用 `select * from 表 where 1=2` 拿列清单
     * （DbColumnProbe 验过的路子，只要元数据不要数据），确认 FNAME 落在本表还是多语言 _L 表，
     * 确认不了就报「这一族没有名称列」并跳过 —— 报「没有名字」也远好过编一列出来。
     */
    private static void scanNames(Scan print, Scan sch, Scan api, Scan botp, Scan wf) {
        long t0 = System.currentTimeMillis();
        int got = 0;
        got += names("print", DBRoute.of("sys"), "t_svc_printmeta", "fnumber", print.ids);
        got += names("task", DBRoute.of("sys"), "t_sch_taskdefine", "fnumber", sch.ids);
        got += names("api", DBRoute.of("sys"), "t_open_apiservice", "fnumber", api.ids);
        got += names("convert", DBRoute.of("sys.meta"), "t_botp_convertrule", "fid", botp.ids);
        got += names("workflow", DBRoute.of("wfs"), "t_wf_procdef", "fkey", wf.ids);
        System.out.println("[PROBE] 名称目录 " + got + " 条，" + (System.currentTimeMillis() - t0) + "ms");
    }

    /**
     * 一族的名称。只给这次真绑到的编号取名 —— 全库的模板名有几千条，取回来也没人查。
     *
     * @param idCol 这一族对外报的那个编号所在的列（和 binding 的 layout 同源，否则对不上）
     */
    private static int names(final String site, DBRoute route, String table, String idCol,
                             final Set<String> wanted) {
        if (wanted.isEmpty()) {
            return 0;
        }
        Set<String> own = columnsOf(route, table);
        if (own.isEmpty()) {
            System.out.println("[PROBE]   name " + site + " 问不到列清单，这一族没有名称");
            return 0;
        }
        String sql;
        if (own.contains("FNAME")) {
            sql = "select " + idCol + ", fname from " + table;
        } else {
            Set<String> loc = columnsOf(route, table + "_l");
            if (!loc.contains("FNAME") || !loc.contains("FID") || !own.contains("FID")) {
                //报出来，别静默：使用者要能知道「这一族没名字」，而不是以为它没名字
                System.out.println("[PROBE]   name " + site + " 没有名称列（本表无 FNAME，"
                        + table + "_l " + (loc.isEmpty() ? "问不到" : "无 FNAME/FID 或本表无 FID")
                        + "），这一族只能按编号查");
                return 0;
            }
            sql = "select m." + idCol + ", l.fname from " + table + " m join " + table + "_l l"
                    + " on l.fid = m.fid" + (loc.contains("FLOCALEID") ? " where l.flocaleid = 'zh_CN'" : "");
        }
        final int[] n = new int[]{0};
        try {
            DB.query(route, sql, new ResultSetHandler<Void>() {
                public Void handle(ResultSet rs) throws Exception {
                    while (rs.next()) {
                        String id = nz(rs.getString(1));
                        String name = nz(rs.getString(2));
                        if (id.isEmpty() || name.isEmpty() || !wanted.contains(id)) {
                            continue;
                        }
                        n[0]++;
                        ProbeJson.emit("name", "site", site, "id", id, "name", name);
                    }
                    return null;
                }
            });
        } catch (Exception e) {
            System.out.println("[PROBE]   name " + site + " 取名失败（" + e.getClass().getSimpleName()
                    + "），这一族只能按编号查");
            return 0;
        }
        System.out.println("[PROBE]   name " + site + " " + n[0] + " / " + wanted.size() + " 个编号有名字");
        return n[0];
    }

    /**
     * 一张表上到底有哪些列 —— `where 1=2` 只要元数据不要数据，不扫表。
     *
     * 表不存在就返回空集：`_l` 多语言表不是每一族都有，那不是错误，是这一族没有名称通道。
     */
    private static Set<String> columnsOf(DBRoute route, String table) {
        final Set<String> out = new LinkedHashSet<String>();
        try {
            DB.query(route, "/*dialect*/select * from " + table + " where 1=2",
                    new ResultSetHandler<Void>() {
                        public Void handle(ResultSet rs) throws Exception {
                            java.sql.ResultSetMetaData md = rs.getMetaData();
                            for (int i = 1; i <= md.getColumnCount(); i++) {
                                out.add(md.getColumnLabel(i).toUpperCase());
                            }
                            return null;
                        }
                    });
        } catch (Exception e) {
            return java.util.Collections.emptySet();
        }
        return out;
    }

    /** 拼 " and (列 like '%前缀%' or …)"。 */
    private static String likeOn(String col, List<String> pkgs) {
        StringBuilder b = new StringBuilder();
        for (String p : pkgs) {
            b.append(b.length() == 0 ? " and (" : " or ")
                    .append(col).append(" like '%").append(p).append("%'");
        }
        return b.append(')').toString();
    }

    /**
     * 调度任务（后台任务）。FCLASSNAME 直接就是类名，不是 XML 全文；这里仍旧走 extract，
     * 只为把「前面连着别的标识符」这种脏值一起挡掉。
     *
     * 它没有「挂在哪张单据上」这回事。能被人拿来提需求的标识是任务编码 FNUMBER
     * （「XX 定时任务半夜没跑」），所以 entity 报编码：报空会让 impact query 打印一行
     * 空绑定，比不报更难懂。
     */
    private static Scan scanSch(final List<String> pkgs) {
        final Scan s = new Scan();
        final long t0 = System.currentTimeMillis();
        if (skip("task")) {
            return s;
        }
        DB.query(DBRoute.of("sys"), "select fnumber, fclassname from t_sch_taskdefine"
                        + " where fclassname is not null" + likeOn("fclassname", pkgs) + in("task", "fnumber"),
                new ResultSetHandler<Void>() {
                    public Void handle(ResultSet rs) throws Exception {
                        while (rs.next()) {
                            s.rows++;
                            String number = nz(rs.getString(1));
                            String cls = rs.getString(2);
                            if (cls == null) {
                                continue;
                            }
                            Set<String> hit = new LinkedHashSet<String>();
                            for (String p : pkgs) {
                                extract(cls, p, hit);
                            }
                            for (String fqcn : hit) {
                                s.bind(fqcn, number.isEmpty() ? fqcn : number, number, "task");
                            }
                        }
                        return null;
                    }
                });
        report("task 调度任务定义", s, t0);
        return s;
    }

    /**
     * 开放平台 API。两列都要读：FCLASSNAME 是自定义 API 的实现类，FPLUGIN 是挂在 API 上的
     * 插件（序列化/反序列化那一族），只读一列会漏掉另一半。
     *
     * FBIZOBJECT 就是这个接口写的那张单 —— 这是四处里唯一能给出真实业务对象的一处，
     * 别退回接口编码，那样 impact query 就串不起「改这个反序列化插件影响哪张单」。
     */
    private static Scan scanApi(final List<String> pkgs) {
        final Scan s = new Scan();
        final long t0 = System.currentTimeMillis();
        if (skip("api")) {
            return s;
        }
        DB.query(DBRoute.of("sys"),
                "select fnumber, fbizobject, fclassname, fplugin from t_open_apiservice"
                        + " where (" + inner("fclassname", pkgs) + " or " + inner("fplugin", pkgs) + ")"
                        + in("api", "fnumber"),
                new ResultSetHandler<Void>() {
                    public Void handle(ResultSet rs) throws Exception {
                        while (rs.next()) {
                            s.rows++;
                            String number = nz(rs.getString(1));
                            String bill = nz(rs.getString(2));
                            Set<String> hit = new LinkedHashSet<String>();
                            for (String p : pkgs) {
                                extract(nz(rs.getString(3)), p, hit);
                                extract(nz(rs.getString(4)), p, hit);
                            }
                            for (String fqcn : hit) {
                                s.bind(fqcn, bill.isEmpty() ? number : bill, number, "api");
                            }
                        }
                        return null;
                    }
                });
        report("api 开放平台接口", s, t0);
        return s;
    }

    /**
     * BOTP 单据转换规则。和 formdesign 一个套路：整份规则序列化在 FDATA 里，类名从全文摘。
     *
     * **一条规则报两条绑定**（源单一条、目标单一条）：转换插件读源单写目标单，只报一边，
     * 另一边的需求就召回不到它。
     */
    private static Scan scanBotp(final List<String> pkgs) {
        final Scan s = new Scan();
        final long t0 = System.currentTimeMillis();
        if (skip("convert")) {
            return s;
        }
        //元数据库的路由 key 是 sys.meta；DBRoute.of("meta") 在这条链上报 datacenter not set
        DB.query(DBRoute.of("sys.meta"),
                "select fid, fsourceentitynumber, ftargetentitynumber, fenabled, fdata"
                        + " from t_botp_convertrule where fdata is not null" + likeOn("fdata", pkgs)
                        + in("convert", "fid"),
                new ResultSetHandler<Void>() {
                    public Void handle(ResultSet rs) throws Exception {
                        while (rs.next()) {
                            s.rows++;
                            String id = nz(rs.getString(1));
                            String src = nz(rs.getString(2));
                            String dst = nz(rs.getString(3));
                            boolean on = !"0".equals(nz(rs.getString(4)));
                            String data = rs.getString(5);
                            if (data == null) {
                                continue;
                            }
                            Set<String> hit = new LinkedHashSet<String>();
                            for (String p : pkgs) {
                                extract(data, p, hit);
                            }
                            for (String fqcn : hit) {
                                if (!src.isEmpty()) {
                                    s.bind(fqcn, src, id, "convert", on);
                                }
                                if (!dst.isEmpty() && !dst.equals(src)) {
                                    s.bind(fqcn, dst, id, "convert", on);
                                }
                            }
                        }
                        return null;
                    }
                });
        report("convert BOTP 转换规则", s, t0);
        return s;
    }

    /**
     * 工作流。两处来源，都要 join t_wf_procdef 才能拿到挂靠单据：
     *
     *   1. 流程/节点插件在已部署的 BPMN XML 里 —— t_wf_gebytearray.FCONTENT，
     *      按 FDEPLOYMENTID 关联流程定义。
     *   2. 参与人插件在 t_wf_participantmodel.FVALUE，按 FPROCDEFID 关联。
     *
     * 这一处**按 (类, 单据, 流程 key) 去重**：一个流程在库里有很多版本，不去重的话同一个插件会报出
     * 几十条登记，查询侧的「×N 布局」就变成版本数，读的人会以为它挂了几十个地方。
     * 去重带上流程 key：原来只按 (类, 单据)，同一插件挂在同一张单的两个流程上只报先扫到的那个，
     * 报哪个看 SQL 返回顺序，按流程 key 补扫时就对不上完整重建。
     * 另外工作流没有 ISV 归属列（wf_model 上就没有），所以这里只有包前缀这一道判据。
     */
    private static Scan scanWf(final List<String> pkgs) {
        final Scan s = new Scan();
        s.dedupe = true;
        final long t0 = System.currentTimeMillis();
        if (skip("workflow")) {
            return s;
        }
        wfSide(s, pkgs, "select p.fentrabill, p.fkey, b.fcontent from t_wf_gebytearray b"
                + " join t_wf_procdef p on p.fdeploymentid = b.fdeploymentid"
                + " where b.fcontent is not null" + likeOn("b.fcontent", pkgs) + in("workflow", "p.fkey"));
        wfSide(s, pkgs, "select p.fentrabill, p.fkey, m.fvalue from t_wf_participantmodel m"
                + " join t_wf_procdef p on p.fid = m.fprocdefid"
                + " where m.fvalue is not null" + likeOn("m.fvalue", pkgs) + in("workflow", "p.fkey"));
        report("workflow 流程定义与参与人", s, t0);
        return s;
    }

    private static void wfSide(final Scan s, final List<String> pkgs, String sql) {
        DB.query(DBRoute.of("wfs"), sql, new ResultSetHandler<Void>() {
            public Void handle(ResultSet rs) throws Exception {
                while (rs.next()) {
                    s.rows++;
                    String bill = nz(rs.getString(1));
                    String key = nz(rs.getString(2));
                    String data = rs.getString(3);
                    if (data == null) {
                        continue;
                    }
                    Set<String> hit = new LinkedHashSet<String>();
                    for (String p : pkgs) {
                        extract(data, p, hit);
                    }
                    for (String fqcn : hit) {
                        s.bind(fqcn, bill.isEmpty() ? key : bill, key, "workflow");
                    }
                }
                return null;
            }
        });
    }

    /** likeOn 去掉开头的 " and "，用在已经自带 where 的地方。 */
    private static String inner(String col, List<String> pkgs) {
        return likeOn(col, pkgs).substring(" and ".length());
    }

    private static void report(String what, Scan s, long t0) {
        System.out.println("[PROBE] " + what + " " + s.rows + " 行 → 登记 " + s.bindings
                + " 条 / 类 " + s.classes.size() + " 个，" + (System.currentTimeMillis() - t0) + "ms");
    }

    private static String nz(String v) {
        return v == null ? "" : v.trim();
    }

    /**
     * 打印模板一侧。跟表单/实体两侧的差别：模板**自己也是个可以被人拿来提需求的标识**
     * （「58 模板委托单号显示不全」），所以除了 binding 还要单报一条 template。
     */
    private static Scan scanTpl(String isv, final List<String> pkgs, String like) {
        final Scan s = new Scan();
        final long t0 = System.currentTimeMillis();
        if (skip("print")) {
            return s;
        }
        DB.query(DBRoute.of("sys"), "select fnumber, fbillformid, fdata from t_svc_printmeta"
                + " where fisv = '" + isv + "' and fdata is not null" + like + in("print", "fnumber"),
                new ResultSetHandler<Void>() {
                    public Void handle(ResultSet rs) throws Exception {
                        while (rs.next()) {
                            s.rows++;
                            String number = rs.getString(1);
                            String bill = rs.getString(2);
                            String data = rs.getString(3);
                            if (data == null) {
                                continue;
                            }
                            Set<String> hit = new LinkedHashSet<String>();
                            for (String p : pkgs) {
                                extract(data, p, hit);
                            }
                            ProbeJson.emit("template", "number", number, "entity", bill,
                                    "classes", new ArrayList<String>(hit));
                            for (String fqcn : hit) {
                                s.classes.add(fqcn);
                                s.bindings++;
                                if (number != null && !number.isEmpty()) {
                                    s.ids.add(number);
                                }
                                ProbeJson.emit("binding", "class", fqcn, "entity", bill,
                                        "layout", number, "kind", "print");
                            }
                        }
                        return null;
                    }
                });
        System.out.println("[PROBE] print 模板本体 " + s.rows + " 份 → 登记 " + s.bindings
                + " 条 / 类 " + s.classes.size() + " 个，" + (System.currentTimeMillis() - t0) + "ms");
        return s;
    }

    private static final class Scan {
        int rows;
        int bindings;
        final Set<String> classes = new LinkedHashSet<String>();
        /** 这一族真绑到的编号。名称目录只给它们取名：全库的名字取回来也没人查。 */
        final Set<String> ids = new LinkedHashSet<String>();
        /** 同一 (类, 实体, 编号) 只报一次。默认关着：布局侧的重复正是「×N 布局」那个计数的来源。 */
        boolean dedupe;
        private final Set<String> seen = new LinkedHashSet<String>();

        void bind(String fqcn, String entity, String layout, String kind) {
            bind(fqcn, entity, layout, kind, true);
        }

        void bind(String fqcn, String entity, String layout, String kind, boolean enabled) {
            if (dedupe && !seen.add(fqcn + '\u0000' + entity + '\u0000' + layout)) {
                return;
            }
            classes.add(fqcn);
            bindings++;
            if (layout != null && !layout.isEmpty()) {
                ids.add(layout);
            }
            if (enabled) {
                ProbeJson.emit("binding", "class", fqcn, "entity", entity, "layout", layout, "kind", kind);
            } else {
                ProbeJson.emit("binding", "class", fqcn, "entity", entity, "layout", layout,
                        "kind", kind, "enabled", Boolean.FALSE);
            }
        }
    }

    /**
     * FDATA 是 XML 全文。逐行流式处理、当场摘完就丢：本工程单张单据的 FDATA 就有 19 万字符，
     * 全量攒进内存是几百 MB。
     */
    private static Scan scan(final String kind, final List<String> pkgs,
                             final Map<String, String> entityNumberById, String sql) {
        final Scan s = new Scan();
        final long t0 = System.currentTimeMillis();
        if (skip(kind)) {
            return s;
        }
        DB.query(DBRoute.meta, sql, new ResultSetHandler<Void>() {
            public Void handle(ResultSet rs) throws Exception {
                while (rs.next()) {
                    s.rows++;
                    String layout = rs.getString(1);
                    String entityId = rs.getString(2);
                    String data = rs.getString(3);
                    if (data == null) {
                        continue;
                    }
                    String entity = entityNumberById.get(entityId);
                    if (entity == null) {
                        //formdesign 的 FENTITYID 指不到实体行时退回布局标识：宁可粗一点，
                        //也不能让这条登记整个消失
                        entity = layout;
                    }
                    Set<String> hit = new LinkedHashSet<String>();
                    for (String p : pkgs) {
                        extract(data, p, hit);
                    }
                    for (String fqcn : hit) {
                        s.classes.add(fqcn);
                        s.bindings++;
                        ProbeJson.emit("binding", "class", fqcn, "entity", entity,
                                "layout", layout, "kind", kind);
                    }
                }
                return null;
            }
        });
        System.out.println("[PROBE] " + kind + " 设计态 " + s.rows + " 份 → 登记 " + s.bindings
                + " 条 / 类 " + s.classes.size() + " 个，" + (System.currentTimeMillis() - t0) + "ms");
        return s;
    }

    private static String req(String key, String what) {
        String v = System.getenv(key);
        if (v == null || v.trim().isEmpty()) {
            throw new IllegalArgumentException("需要环境变量 " + key + "（" + what + "）");
        }
        return v.trim();
    }

    private static String env(String k, String def) {
        String v = System.getenv(k);
        return v == null || v.trim().isEmpty() ? def : v;
    }
}
