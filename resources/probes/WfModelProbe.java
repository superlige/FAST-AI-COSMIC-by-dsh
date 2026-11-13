import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

import kd.bos.dataentity.entity.DynamicObject;
import kd.bos.orm.query.QCP;
import kd.bos.orm.query.QFilter;
import kd.bos.servicehelper.QueryServiceHelper;
import kd.bos.workflow.engine.ProcessEngines;
import kd.bos.workflow.engine.RepositoryService;

/**
 * 只读：工作流模型的清单、导出和批量备份。**没有写通道，这是设计决定不是没写完** ——
 * 工作流写入会影响在途实例，事务回滚不了；且 `wf_model` 上没有任何归属字段
 * （判据只剩挂靠单据 `entrabill` 的前缀，比别的元数据家族弱一档，见
 * `IsvGuard.assertOwnWfModel` 和 reference/metadata-write.md）。
 *
 * 导出走 `RepositoryService.getExportedProcessFileContent(模型id)`，拿到的是平台自己
 * 「导出流程」用的那份 XML（根节点 ExportScheme，含 wf_processdefinition 全文）。
 * 这条链**不写库**，所以 backup 不需要 APPLY=1。
 *
 * 坑：导出的是**已发布的流程定义**。模型改了没发布，导出来的还是上一版 ——
 * 清单里的 publish 列就是判据，比对两版之前先看它。
 *
 *   WF_ACTION=list|dump|backup   默认 list
 *   WF_BILL=挂靠单据关键字        对 entrabill 做 like
 *   WF_KEY=模型 key 或名称关键字   对 key / name 做 like
 *   WF_MAX=最多多少条，默认 50
 *   WF_MODEL=模型 id 或 key       dump 用，精确 id 优先，其次 key 精确，再次 key/name like
 *   WF_OUT=输出目录               dump 可选（默认 outputs/wf-model），backup 必填
 */
public class WfModelProbe {

    private static final String SELECT =
            "id,key,name,entrabill,type,version,publish,discard,modifydate";

    public static void run() throws Exception {
        String action = env("WF_ACTION", "list");
        if ("list".equals(action)) {
            list();
        } else if ("dump".equals(action)) {
            dump();
        } else if ("backup".equals(action)) {
            backup();
        } else {
            throw new IllegalArgumentException("WF_ACTION 只能是 list|dump|backup，收到: " + action);
        }
    }

    // ── list ────────────────────────────────────────────────────────────
    private static void list() {
        List<DynamicObject> rows = select();
        System.out.println("[PROBE] 命中 " + rows.size() + " 个模型"
                + "（条件 bill=" + dash(env("WF_BILL", "")) + " key=" + dash(env("WF_KEY", ""))
                + " 上限 " + env("WF_MAX", "50") + "）");
        for (DynamicObject r : rows) {
            System.out.println("[PROBE] " + line(r));
        }
        if (!rows.isEmpty()) {
            System.out.println("[PROBE] 归属看 bill 列的前缀 —— wf_model 上没有 isv，"
                    + "key 也不是归属判据（平台生成的 key 和建模者无关）");
            System.out.println("[PROBE] 导一个：meta wf dump <key>；批量存档：meta wf backup <目录>");
        }
    }

    private static String line(DynamicObject r) {
        return pad(r.getString("key"), 42)
                + " bill=" + pad(nz(r.getString("entrabill")), 24)
                + " " + pad(nz(r.getString("type")), 10)
                + " v" + pad(nz(r.getString("version")), 5)
                + (r.getBoolean("publish") ? " 已发布" : " 未发布")
                + (r.getBoolean("discard") ? " 已废弃" : "")
                + "  " + nz(r.getString("name"))
                + "  id=" + r.getString("id");
    }

    // ── dump ────────────────────────────────────────────────────────────
    private static void dump() throws Exception {
        String want = env("WF_MODEL", "");
        if (want.isEmpty()) throw new IllegalArgumentException("dump 必须给 WF_MODEL（模型 id 或 key）");
        DynamicObject m = resolve(want);
        File dir = new File(env("WF_OUT", "outputs/wf-model"));
        System.out.println("[PROBE] " + line(m));
        File f = export(m, dir);
        System.out.println("[PROBE] 数据库未修改。改前改后请导到不同目录，再 meta wf diff <A> <B>");
        if (f == null) System.out.println("[PROBE] !! 导出内容为空 —— 多半是这个模型还没发布过");
    }

    // ── backup ──────────────────────────────────────────────────────────
    private static void backup() throws Exception {
        String out = env("WF_OUT", "");
        if (out.isEmpty()) throw new IllegalArgumentException("backup 必须给 WF_OUT（目录）");
        List<DynamicObject> rows = select();
        if (rows.isEmpty()) {
            System.out.println("[PROBE] 没有命中任何模型，什么都没写");
            return;
        }
        File dir = new File(out);
        int ok = 0;
        int empty = 0;
        for (DynamicObject r : rows) {
            File f = export(r, dir);
            if (f == null) {
                empty++;
                System.out.println("[PROBE] 跳过（导出为空，未发布）: " + r.getString("key"));
            } else {
                ok++;
            }
        }
        System.out.println("[PROBE] 备份完成：" + ok + " 个写出，" + empty + " 个为空，目录 "
                + dir.getAbsolutePath());
        System.out.println("[PROBE] 全程零写入 —— 工作流没有写通道");
    }

    /** 导一个模型；导出为空返回 null（未发布的模型没有流程定义可导） */
    private static File export(DynamicObject m, File dir) throws Exception {
        RepositoryService rs = ProcessEngines.getDefaultProcessEngine().getRepositoryService();
        String xml = rs.getExportedProcessFileContent(Long.valueOf(m.getString("id")));
        if (xml == null || xml.trim().isEmpty()) return null;
        if (!dir.exists() && !dir.mkdirs()) throw new IllegalStateException("建目录失败: " + dir);
        //文件名用 key 不用 id：id 是雪花号，两个环境导出来的对不上，diff 时全变成「只在 A」
        File f = new File(dir, safe(m.getString("key")) + ".xml");
        Writer w = new OutputStreamWriter(new FileOutputStream(f), StandardCharsets.UTF_8);
        try {
            w.write(xml);
        } finally {
            w.close();
        }
        System.out.println("[PROBE] 已写出 " + f.getAbsolutePath() + "  " + xml.length() + " chars");
        return f;
    }

    // ── 取数 ────────────────────────────────────────────────────────────
    private static List<DynamicObject> select() {
        List<QFilter> fs = new ArrayList<QFilter>();
        String bill = env("WF_BILL", "");
        if (!bill.isEmpty()) fs.add(new QFilter("entrabill", QCP.like, "%" + bill + "%"));
        String key = env("WF_KEY", "");
        if (!key.isEmpty()) {
            fs.add(new QFilter("key", QCP.like, "%" + key + "%")
                    .or(new QFilter("name", QCP.like, "%" + key + "%")));
        }
        int max = Integer.parseInt(env("WF_MAX", "50"));
        DynamicObject[] rows = QueryServiceHelper.query("wf_model", SELECT,
                fs.toArray(new QFilter[0]), "entrabill asc, key asc", max)
                .toArray(new DynamicObject[0]);
        List<DynamicObject> out = new ArrayList<DynamicObject>();
        for (DynamicObject r : rows) out.add(r);
        return out;
    }

    /** id 精确 → key 精确 → key/name 模糊。多条命中就报出来让人自己收窄，不擅自挑第一条 */
    private static DynamicObject resolve(String want) {
        if (want.matches("\\d+")) {
            DynamicObject r = one(new QFilter("id", QCP.equals, Long.valueOf(want)));
            if (r != null) return r;
        }
        DynamicObject r = one(new QFilter("key", QCP.equals, want));
        if (r != null) return r;
        List<DynamicObject> hits = QueryServiceHelper.query("wf_model", SELECT,
                new QFilter[]{new QFilter("key", QCP.like, "%" + want + "%")
                        .or(new QFilter("name", QCP.like, "%" + want + "%"))}, "key asc", 10);
        if (hits.isEmpty()) throw new IllegalArgumentException("找不到工作流模型: " + want);
        if (hits.size() > 1) {
            for (DynamicObject h : hits) System.out.println("[PROBE] 候选 " + line(h));
            throw new IllegalArgumentException("「" + want + "」命中 " + hits.size()
                    + " 个模型，用上面的 key 或 id 重来");
        }
        return hits.get(0);
    }

    private static DynamicObject one(QFilter f) {
        List<DynamicObject> hits = QueryServiceHelper.query("wf_model", SELECT,
                new QFilter[]{f}, null, 2);
        return hits.isEmpty() ? null : hits.get(0);
    }

    // ── 小工具 ──────────────────────────────────────────────────────────
    private static String safe(String v) { return nz(v).replaceAll("[^A-Za-z0-9._-]", "_"); }
    private static String nz(String v) { return v == null ? "" : v; }
    private static String dash(String v) { return v == null || v.isEmpty() ? "-" : v; }

    private static String pad(String v, int n) {
        StringBuilder b = new StringBuilder(nz(v));
        while (b.length() < n) b.append(' ');
        return b.toString();
    }

    private static String env(String k, String def) {
        String v = System.getenv(k);
        return v == null || v.trim().isEmpty() ? def : v.trim();
    }
}
