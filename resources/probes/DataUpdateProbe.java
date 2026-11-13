import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

import kd.bos.dataentity.OperateOption;
import kd.bos.dataentity.entity.DynamicObject;
import kd.bos.dataentity.entity.DynamicObjectCollection;
import kd.bos.dataentity.metadata.IDataEntityProperty;
import kd.bos.db.tx.TX;
import kd.bos.db.tx.TXHandle;
import kd.bos.entity.MainEntityType;
import kd.bos.entity.operate.result.OperationResult;
import kd.bos.orm.query.QFilter;
import kd.bos.servicehelper.BusinessDataServiceHelper;
import kd.bos.servicehelper.QueryServiceHelper;
import kd.bos.servicehelper.operation.OperationServiceHelper;
import kd.bos.servicehelper.operation.SaveServiceHelper;

/**
 * 修改数据：在共享环境里改几条已有数据的字段值，默认直接落库（整批一个事务，任何一步不成功整批回滚），PREVIEW=1 只预演。
 *
 * 为什么要它：验逻辑常常要把现有数据改成某个状态（结论改成不合格、数量改成 0、日期改到上个月），
 * 临时探针只准读。这个探针和 DataSeedProbe 一起，是模型往共享环境写业务数据的全部入口，
 * S27 起（用户 2026-09-19 定：连的必然是纯测试环境）加 APPLY=1 直接落库，不用确认，走常驻进程；
 * 预演（PREVIEW=1）可选。
 *
 * **原值和新值由本探针报，不由模型转述**：逐条逐字段读出原值、设上新值，每一格发一条
 * `t=data-change`，回执据此留下原值——数据不会自己改回来，要恢复只能照原值再改一次。
 *
 * 边界（写死在代码里，没有开关）：
 *   - 不限 ISV（2026-09-15 用户决定：测试环境，只写数据不改元数据），写入目标是 `data:<单据标识>`；
 *   - 只改字段值，不新建、不删除单据（新建用 DataSeedProbe）；
 *   - 一次最多 50 条，按条件选中超过 50 条就整批不跑；整批在**一个事务**里，任何一条没存成就整批回滚；
 *   - 存完在事务里按 pk 回读一遍：要改的字段有一个不是新值（多半是插件在保存时又改了它）就算没改成；
 *   - 改前快照：选中的每条数据、每个要改字段的原值算成一个指纹打出来。给了 -Dcosmic.baseline 且对不上
 *     就中止（S23 用户确认过的快照用它核对）；S27 起不用确认，Harness 不再传，落库按现在的原值直接改。
 *
 * TX 只回滚数据库：保存操作链上插件发的消息、调的接口不回滚（测试环境已放开，Harness 只在提醒里说一句）。
 *
 * UPD_ENTITY=单据标识（必填，单据或基础资料，原厂的也行）
 * UPD_PKS=pk1,pk2  按 pk 选中要改的数据
 * UPD_NUMBERS=WTD-0001,WTD-0002  按单据编号（基础资料是编码）选中要改的数据
 * UPD_WHERE=billstatus = A; zlgd_jyjl is null  按条件选中，写法同 DataQueryProbe 的 QUERY_WHERE（; 是并且，| 是或者），命中超过 50 条整批不跑
 * UPD_SET=zlgd_jyjl=2;zlgd_qty=0  选中的每条都改成这组值，写法同 cosmic_run op 的 --set（分录 `分录[0].字段`，基础资料给 id 或编码，写 null 清空）
 * UPD_ROWS=每条改成不同的值时用，逐行写：`[row] 编号或pk` 起一条，下面跟 `set=…`；给了它就不看 UPD_PKS / UPD_NUMBERS / UPD_WHERE / UPD_SET
 * UPD_OP=save  用哪个操作保存，默认 save（校验器和插件照跑）；写 direct 表示直接存库、不走校验器和插件（改已审核单据时用）
 * PREVIEW=1  只预演：回滚事务里跑一遍、不落库，要起冷进程（约 40 秒起）；不给就直接落库（测试环境，不用确认；APPLY=1 同样落库）
 *
 * 默认落库、PREVIEW=1 才预演是 S37 批 8（2026-09-28）改的：以前不带 APPLY 就是预演，模型每次先预演再落库，
 * 而落库本来就整批回滚、预演没有多一层保护，却每次多一个冷进程（09-28 复测 7 次预演约 6 分钟）。Harness 把没给 PREVIEW 的换算成 APPLY=1。
 */
public class DataUpdateProbe {

    /** 一次最多改几条。确认单要逐条列原值和新值，再多用户就看不过来了。 */
    static final int MAX_ROWS = 50;

    private static final class Row {
        String label;
        Object pk;
        String set = "";
        DynamicObject obj;
        List<String[]> pairs = new ArrayList<String[]>();
        List<String> before = new ArrayList<String>();
        List<String> expect = new ArrayList<String>();
    }

    public static void run() throws Exception {
        boolean apply = "1".equals(System.getenv("APPLY")) && !"1".equals(System.getenv("PREVIEW"));
        String entity = req("UPD_ENTITY");
        String op = env("UPD_OP", "save");
        boolean direct = "direct".equalsIgnoreCase(op);

        System.out.println("[PROBE] 模式=" + (apply ? "APPLY 真落库" : "dry-run 回滚事务里预演，不落库")
                + "  保存方式=" + (direct ? "直接存库（不走校验器和插件）" : "操作 " + op + "（校验器和插件照跑）"));
        IsvGuard.assertDataTarget(entity);
        MainEntityType met = MetaResolve.type(entity);
        ProbeJson.emit("data-entity", "entity", entity, "name", String.valueOf(met.getDisplayName()),
                "op", direct ? "direct" : op);

        List<String> problems = new ArrayList<String>();
        List<Row> rows = select(entity, met, problems);
        if (problems.isEmpty() && rows.isEmpty()) {
            problems.add("一条数据都没选中：检查 UPD_PKS / UPD_NUMBERS / UPD_WHERE，先用 DataQueryProbe 查一遍");
        }
        if (rows.size() > MAX_ROWS) {
            problems.add("一次最多改 " + MAX_ROWS + " 条，这次选中 " + rows.size() + " 条，收紧条件");
        }
        //字段名先核（和造数、run op、run print 同一处），核过了才去库里取数据
        Set<String> sets = new LinkedHashSet<String>();
        for (Row row : rows) {
            sets.add(row.set);
        }
        for (String set : sets) {
            for (String[] w : OpSandbox.wrongPaths(met, set)) {
                problems.add(entity + " " + w[0] + " —— " + w[1]);
            }
        }
        if (problems.isEmpty()) {
            load(entity, met, rows, problems);
        }
        if (!problems.isEmpty()) {
            for (String p : problems) {
                System.out.println("[PROBE] ✗ " + p);
            }
            throw new IllegalArgumentException("UPD_* 入参有 " + problems.size() + " 处问题（见上方 ✗ 行），一条都没改");
        }

        String baseline = snapshot(rows);
        System.out.println("[PROBE] 改前快照=" + baseline + "（" + rows.size() + " 条）");
        if (apply) {
            String confirmed = System.getProperty("cosmic.baseline", "").trim();
            if (!confirmed.isEmpty() && !confirmed.equals(baseline)) {
                System.out.println("[PROBE] 未落库：改前数据和预演时不一样了（确认时 " + confirmed + "，现在 " + baseline
                        + "），一条都没改。确认单上的原值已经不是真的，重新 dry-run、重新确认");
                throw new IllegalStateException("改前快照变了");
            }
        }

        for (Row row : rows) {
            System.out.println("[PROBE] --- " + row.label + "（pk=" + row.pk + "）---");
            List<String> unresolved = OpSandbox.applySets(met, row.obj, row.set);
            if (!unresolved.isEmpty()) {
                problems.add(row.label + "：基础资料没取到 " + String.join("、", unresolved));
            }
            for (int i = 0; i < row.pairs.size(); i++) {
                ExpectSpec.Pos pos = ExpectSpec.Pos.parse(row.pairs.get(i)[0]);
                row.expect.add(stable(read(row.obj, pos)));
                String after = shown(row.obj, pos, row.pairs.get(i)[1]);
                System.out.println("[PROBE]   " + row.pairs.get(i)[0] + "：" + row.before.get(i) + " → " + after);
                ProbeJson.emit("data-change", "entity", entity, "label", row.label, "pk", String.valueOf(row.pk),
                        "number", numberOf(row.obj), "field", row.pairs.get(i)[0], "name", fieldName(met, pos),
                        "before", row.before.get(i), "after", after);
            }
        }
        if (!problems.isEmpty()) {
            for (String p : problems) {
                System.out.println("[PROBE] ✗ " + p);
            }
            throw new IllegalStateException("有 " + problems.size() + " 条数据的字段设不上，整批不跑");
        }

        boolean allOk = true;
        long t0 = System.currentTimeMillis();
        DynamicObject[] objs = new DynamicObject[rows.size()];
        for (int i = 0; i < rows.size(); i++) {
            objs[i] = rows.get(i).obj;
        }
        //整批一个事务。预演：先 markRollback，跑完什么都不留。落库：只有全部存成、回读都是新值才提交
        try (TXHandle tx = TX.beginNew()) {
            if (!apply) {
                tx.markRollback();
            }
            try {
                if (direct) {
                    SaveServiceHelper.save(objs);
                    System.out.println("[PROBE] 直接存库 " + objs.length + " 条（没走校验器和插件）");
                } else {
                    OperationResult r = OperationServiceHelper.executeOperate(op, entity, objs, OperateOption.create());
                    System.out.println("[PROBE] 执行 " + op + "：");
                    OpSandbox.report(met, r);
                    if (r == null || !r.isSuccess() || r.getSuccessPkIds().size() != objs.length) {
                        System.out.println("[PROBE] !! " + op + " 没有全部成功（成功 "
                                + (r == null ? 0 : r.getSuccessPkIds().size()) + "/" + objs.length + "）");
                        allOk = false;
                    }
                }
                if (allOk) {
                    allOk = readBack(entity, rows, "存完回读");
                }
            } catch (Throwable t) {
                allOk = false;
                System.out.println("[PROBE] 抛异常 " + OpSandbox.brief(t));
                OpSandbox.explain(t);
            }
            if (apply && !allOk) {
                tx.markRollback();
            }
        }
        System.out.println("[PROBE] 耗时 " + (System.currentTimeMillis() - t0) + "ms");

        if (!allOk) {
            System.out.println("[PROBE] !! 没改成，整批已回滚，库里的数据还是原值（原因看上面的结果和异常）");
            throw new IllegalStateException("没改成");
        }
        if (!apply) {
            System.out.println("[PROBE] dry-run 结束，未写入（" + rows.size() + " 条都在回滚事务里存通了、回读是新值）。"
                    + "要落库就去掉 PREVIEW=1 再跑（测试环境，不用确认）");
            return;
        }
        //提交之后再读一次：事务里读到的新值不等于提交后库里的新值
        if (!readBack(entity, rows, "提交后回读")) {
            System.out.println("[PROBE] !! 已经提交，但提交后回读有字段不是新值，按没改成处理，去库里核对");
            throw new IllegalStateException("提交后回读不对");
        }
        System.out.println("[PROBE] 数据已修改 " + rows.size() + " 条，提交后回读都是新值。");
    }

    /** 选中要改的数据。UPD_ROWS 逐条点名；否则 UPD_PKS / UPD_NUMBERS / UPD_WHERE 三选一，配 UPD_SET。 */
    private static List<Row> select(String entity, MainEntityType met, List<String> problems) {
        List<Row> out = new ArrayList<Row>();
        String spec = env("UPD_ROWS", "");
        if (!spec.isEmpty()) {
            Row cur = null;
            for (String raw : spec.split("\n")) {
                String line = raw.trim();
                if (line.isEmpty()) {
                    continue;
                }
                if (line.startsWith("[row]")) {
                    cur = new Row();
                    cur.label = line.substring("[row]".length()).trim();
                    if (cur.label.isEmpty()) {
                        problems.add("UPD_ROWS 里 [row] 后面要写这条数据的编号或 pk");
                    } else {
                        cur.pk = pkOf(entity, met, cur.label, problems);
                    }
                    out.add(cur);
                    continue;
                }
                if (cur == null || !line.startsWith("set=")) {
                    problems.add("UPD_ROWS 看不懂这一行「" + line + "」：先写 [row] 编号或pk，下面跟 set=…");
                    continue;
                }
                cur.set = line.substring("set=".length()).trim();
            }
            Set<Object> seen = new LinkedHashSet<Object>();
            for (Row row : out) {
                if (row.pk != null && !seen.add(String.valueOf(row.pk))) {
                    problems.add("UPD_ROWS 里同一条数据写了两次：" + row.label);
                }
                if (row.set.isEmpty()) {
                    problems.add(row.label + " 没有 set=…，不知道要改成什么");
                }
            }
            return out;
        }

        String set = env("UPD_SET", "");
        String pks = env("UPD_PKS", "");
        String numbers = env("UPD_NUMBERS", "");
        String where = env("UPD_WHERE", "");
        int given = (pks.isEmpty() ? 0 : 1) + (numbers.isEmpty() ? 0 : 1) + (where.isEmpty() ? 0 : 1);
        if (given != 1) {
            problems.add("UPD_PKS / UPD_NUMBERS / UPD_WHERE 要且只能给一个（这次给了 " + given + " 个），或者改用 UPD_ROWS");
            return out;
        }
        if (set.isEmpty()) {
            problems.add("缺 UPD_SET：不知道要把选中的数据改成什么");
        }
        List<String> labels = new ArrayList<String>();
        if (!pks.isEmpty() || !numbers.isEmpty()) {
            for (String one : (pks.isEmpty() ? numbers : pks).split(",")) {
                if (!one.trim().isEmpty()) {
                    labels.add(one.trim());
                }
            }
            for (String label : labels) {
                Row row = new Row();
                row.label = label;
                row.pk = pks.isEmpty() ? byNumber(entity, met, label, problems) : byPk(entity, label, problems);
                row.set = set;
                out.add(row);
            }
            return out;
        }
        List<QFilter> filters = DataQueryProbe.where(met, where, new ArrayList<String>(), new boolean[]{false},
                problems);
        if (!problems.isEmpty()) {
            return out;
        }
        QFilter[] qfs = filters.toArray(new QFilter[0]);
        System.out.println("[PROBE] 条件：" + DataQueryProbe.describe(qfs));
        //多取一条：只为知道是不是超过了上限
        Set<Object> ids = new LinkedHashSet<Object>();
        for (DynamicObject hit : QueryServiceHelper.query(entity, "id", qfs, "id", MAX_ROWS * 4 + 1)) {
            ids.add(hit.get("id"));
        }
        for (Object id : ids) {
            Row row = new Row();
            row.pk = id;
            row.label = String.valueOf(id);
            row.set = set;
            out.add(row);
        }
        System.out.println("[PROBE] 按条件选中 " + out.size() + " 条");
        return out;
    }

    /** 读出每条完整数据，记下每个要改字段的原值。字段已经核过（{@link OpSandbox#wrongPaths}），这里只查值转不转得过去。 */
    private static void load(String entity, MainEntityType met, List<Row> rows, List<String> problems) {
        for (Row row : rows) {
            if (row.pk == null) {
                continue;
            }
            row.obj = BusinessDataServiceHelper.loadSingle(row.pk, entity);
            String no = numberOf(row.obj);
            if (no != null) {
                row.label = no;
            }
            row.pairs = ExpectSpec.pairs(row.set);
            for (String[] pair : row.pairs) {
                ExpectSpec.Pos pos = ExpectSpec.Pos.parse(pair[0]);
                IDataEntityProperty p = ExpectSpec.propAt(met, pos);
                if (p == null) {
                    continue;
                }
                try {
                    ExpectSpec.convert(p, pair[1]);
                } catch (Throwable t) {
                    problems.add(row.label + "：" + pair[0] + " 的值「" + pair[1] + "」转不过去：" + OpSandbox.brief(t));
                }
                row.before.add(shown(row.obj, pos, null));
            }
        }
    }

    /** 存完在事务里（或提交后）按 pk 重读，要改的字段必须都是新值。 */
    private static boolean readBack(String entity, List<Row> rows, String when) {
        boolean ok = true;
        for (Row row : rows) {
            DynamicObject fresh = BusinessDataServiceHelper.loadSingle(row.pk, entity);
            for (int i = 0; i < row.pairs.size(); i++) {
                ExpectSpec.Pos pos = ExpectSpec.Pos.parse(row.pairs.get(i)[0]);
                String got = stable(read(fresh, pos));
                if (!got.equals(row.expect.get(i))) {
                    ok = false;
                    System.out.println("[PROBE] !! " + when + " " + row.label + " 的 " + row.pairs.get(i)[0] + " 是 "
                            + shown(fresh, pos, null) + "，不是要改成的值 —— 多半是保存时插件又改了它");
                }
            }
        }
        return ok;
    }

    /** 选中的数据和它们的原值合成一个指纹：换了一条、原值变了一个，指纹都会变。 */
    private static String snapshot(List<Row> rows) throws Exception {
        StringBuilder sb = new StringBuilder();
        for (Row row : rows) {
            sb.append(row.pk).append('\n');
            for (String[] pair : row.pairs) {
                sb.append(pair[0]).append('=').append(stable(read(row.obj, ExpectSpec.Pos.parse(pair[0])))).append('\n');
            }
        }
        byte[] hash = MessageDigest.getInstance("SHA-256").digest(sb.toString().getBytes(StandardCharsets.UTF_8));
        StringBuilder hex = new StringBuilder();
        for (int i = 0; i < 8; i++) {
            hex.append(String.format("%02x", hash[i]));
        }
        return hex.toString();
    }

    private static Object byPk(String entity, String raw, List<String> problems) {
        Object id = raw;
        try {
            id = Long.valueOf(raw);
        } catch (NumberFormatException ignored) {
            //非数字主键的单据照原样查
        }
        DynamicObject hit = QueryServiceHelper.queryOne(entity, "id", new QFilter[]{new QFilter("id", "=", id)});
        if (hit == null) {
            problems.add(entity + " 里没有 pk=" + raw + " 的数据");
            return null;
        }
        return hit.get("id");
    }

    private static Object byNumber(String entity, MainEntityType met, String number, List<String> problems) {
        String key = numberKey(met);
        if (key == null) {
            problems.add(entity + " 上既没有 billno 也没有 number，按编号选不了，改用 UPD_PKS");
            return null;
        }
        DynamicObjectCollection hits = QueryServiceHelper.query(entity, "id",
                new QFilter[]{new QFilter(key, "=", number)}, "id", 2);
        if (hits.size() != 1) {
            problems.add(entity + " 里" + key + "=" + number + " 的数据有 " + hits.size() + " 条，要正好 1 条");
            return null;
        }
        return hits.get(0).get("id");
    }

    /** UPD_ROWS 的标签：先当 pk 找，找不到再当编号找。 */
    private static Object pkOf(String entity, MainEntityType met, String label, List<String> problems) {
        if (label.matches("\\d+")) {
            DynamicObject hit = QueryServiceHelper.queryOne(entity, "id",
                    new QFilter[]{new QFilter("id", "=", Long.valueOf(label))});
            if (hit != null) {
                return hit.get("id");
            }
        }
        return byNumber(entity, met, label, problems);
    }

    private static String numberKey(MainEntityType met) {
        for (String key : new String[]{"billno", "number"}) {
            if (met.getProperties().containsKey(key)) {
                return key;
            }
        }
        return null;
    }

    static String numberOf(DynamicObject obj) {
        for (String key : new String[]{"billno", "number"}) {
            if (obj.getDataEntityType().getProperties().containsKey(key)) {
                String v = obj.getString(key);
                return v == null || v.isEmpty() ? null : v;
            }
        }
        return null;
    }

    /** 分录行不存在时返回一个标记，不抛：「原来没有这一行」本身就是要给用户看的原值。 */
    static Object read(DynamicObject obj, ExpectSpec.Pos pos) {
        try {
            return ExpectSpec.valueOf(obj, pos);
        } catch (RuntimeException e) {
            return NO_ROW;
        }
    }

    static final Object NO_ROW = new Object();

    /** 字段给人看的名字：表头字段就是字段名；分录字段带上「分录名 第几行」。 */
    static String fieldName(MainEntityType met, ExpectSpec.Pos pos) {
        IDataEntityProperty p = ExpectSpec.propAt(met, pos);
        String name = p == null ? pos.field : String.valueOf(p.getDisplayName());
        if (pos.entry == null) {
            return name;
        }
        Object entry = met.getProperties().get(pos.entry);
        String entryName = entry instanceof IDataEntityProperty
                ? String.valueOf(((IDataEntityProperty) entry).getDisplayName()) : pos.entry;
        return entryName + " 第" + (pos.row + 1) + "行 " + name;
    }

    /** 确认单里的一格：基础资料写「编码 名称」，空写「空」，日期到秒，布尔写是/否。 */
    static String shown(DynamicObject obj, ExpectSpec.Pos pos, String raw) {
        Object v = read(obj, pos);
        if (v == NO_ROW) {
            return raw == null ? "（没有这一行）" : raw;
        }
        return display(v);
    }

    private static String display(Object v) {
        if (v == null) {
            return "空";
        }
        if (v instanceof DynamicObjectCollection) {
            List<String> parts = new ArrayList<String>();
            for (Object one : (DynamicObjectCollection) v) {
                parts.add(display(one));
            }
            return parts.isEmpty() ? "空" : String.join("、", parts);
        }
        if (v instanceof DynamicObject) {
            DynamicObject o = (DynamicObject) v;
            if (o.getDataEntityType().getProperties().containsKey("fbasedataid")) {
                return display(o.get("fbasedataid"));
            }
            String number = o.getDataEntityType().getProperties().containsKey("number") ? o.getString("number") : null;
            String name = o.getDataEntityType().getProperties().containsKey("name") ? o.getString("name") : null;
            String text = ((number == null ? "" : number) + " " + (name == null ? "" : name)).trim();
            return text.isEmpty() ? "pk " + o.getPkValue() : text;
        }
        if (v instanceof Date) {
            return new SimpleDateFormat("yyyy-MM-dd HH:mm:ss").format((Date) v).replace(" 00:00:00", "");
        }
        if (v instanceof BigDecimal) {
            BigDecimal d = ((BigDecimal) v).stripTrailingZeros();
            return d.scale() < 0 ? d.setScale(0).toPlainString() : d.toPlainString();
        }
        if (v instanceof Boolean) {
            return ((Boolean) v) ? "是" : "否";
        }
        String s = String.valueOf(v).replace('\r', ' ').replace('\n', ' ');
        if (s.isEmpty()) {
            return "空";
        }
        return s.length() > 60 ? s.substring(0, 60) + "…" : s;
    }

    /** 比对和指纹用的值：基础资料比 pk，数值去掉末尾的 0，日期比毫秒。 */
    static String stable(Object v) {
        if (v == NO_ROW) {
            return "<no-row>";
        }
        //「空」有几种写法：内存里设成空是 null，库里读回来的空下拉、空文本是 "" 或空格。
        //按同一个空比，否则改成空永远「回读不是新值」、整批回滚
        if (v == null || v instanceof String && ((String) v).trim().isEmpty()) {
            return "<空>";
        }
        if (v instanceof DynamicObjectCollection) {
            List<String> parts = new ArrayList<String>();
            for (Object one : (DynamicObjectCollection) v) {
                parts.add(stable(one));
            }
            return parts.toString();
        }
        if (v instanceof DynamicObject) {
            DynamicObject o = (DynamicObject) v;
            if (o.getDataEntityType().getProperties().containsKey("fbasedataid")) {
                return stable(o.get("fbasedataid_id"));
            }
            return String.valueOf(o.getPkValue());
        }
        if (v instanceof Date) {
            return String.valueOf(((Date) v).getTime());
        }
        if (v instanceof BigDecimal) {
            return ((BigDecimal) v).stripTrailingZeros().toPlainString();
        }
        return String.valueOf(v);
    }

    private static String req(String k) {
        String v = System.getenv(k);
        if (v == null || v.trim().isEmpty()) {
            System.out.println("[PROBE] 缺 " + k);
            throw new IllegalStateException("缺 " + k);
        }
        return v.trim();
    }

    private static String env(String k, String dft) {
        String v = System.getenv(k);
        return v == null || v.trim().isEmpty() ? dft : v.trim();
    }
}
