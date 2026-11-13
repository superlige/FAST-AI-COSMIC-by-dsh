import java.sql.ResultSet;
import java.util.ArrayList;
import java.util.List;

import kd.bos.db.DB;
import kd.bos.db.DBRoute;
import kd.bos.db.ResultSetHandler;
import kd.bos.metadata.dao.MetaCategory;
import kd.bos.metadata.dao.MetadataDao;
import kd.bos.metadata.form.ControlAp;
import kd.bos.metadata.form.FormMetadata;

/**
 * 只读：反查一张单据的**全部下游布局**，可选地判断某个控件在每张布局上到底显不显示。
 *
 * 为什么需要它：MetaProbe / DesignMetaProbe / FormPluginProbe 全是「给一个布局，说说它的内容」，
 * 没有反向的。「这张单派生出多少张布局」「某字段在哪几张布局上是可见的」只能自己打 meta 表。
 *
 *   TREE_ROOT=demo_sys_test_bill        根单据或根布局标识（必填）
 *   TREE_FIELD=demo_mulbasedatafield1   可选。给了就逐张判断该控件的可见性
 *   TREE_ONLY=shown|hidden|absent       可选。只列某一类，配合 TREE_FIELD 用
 *
 * ⚠️ 判断「界面上显不显示」要看三个独立属性，少看一个就会得出相反结论：
 *   isHidden()    设计器里勾的「隐藏」
 *   isInvisible() 「不可见」——和 hidden 是两回事，实测大量布局是 hidden=false / invisible=true
 *   getVisible()  按单据状态的可见性串，如 init,new,edit,view,submit,audit
 * 而且这三个都是**设计态静态属性**；运行时还可能被界面规则（FormRuleProbe）或插件
 * setVisible 覆盖，要确认最终渲染结果得再查规则。
 */
public class FormTreeProbe {

    public static void run() throws Exception {
        String root = req("TREE_ROOT");
        String field = env("TREE_FIELD", null);
        String only = env("TREE_ONLY", null);

        String rootId = MetadataDao.getIdByNumber(root, MetaCategory.Form);
        if (rootId == null || rootId.isEmpty()) {
            //给的可能是实体标识而不是布局标识，换算一次再试
            rootId = MetadataDao.getIdByNumber(MetaResolve.entityNumber(root), MetaCategory.Form);
        }
        if (rootId == null || rootId.isEmpty()) {
            System.out.println("[PROBE] !! " + root + " 查不到表单布局元数据");
            return;
        }
        System.out.println("[PROBE] 根 " + root + " formId=" + rootId
                + (field == null ? "" : "  查控件 " + field));

        //下游的三种连法：继承路径里出现过根 / 直接挂在根下 / 与根共用同一个实体（多布局）
        final List<String[]> forms = new ArrayList<>();
        String sql = "/*dialect*/select FID,FNUMBER,FENTITYID,FPARENTID,FISV,FENABLED,"
                + "FISINHERIT,FISEXTENDED,FMODELTYPE from t_meta_formdesign "
                + "where FINHERITPATH like ? or FENTITYID = ? or FPARENTID = ? or FID = ? "
                + "order by FID";
        final String rid = rootId;
        DB.query(DBRoute.meta, sql, new Object[]{"%" + rid + "%", rid, rid, rid},
                (ResultSetHandler<Object>) rs -> {
                    while (rs.next()) {
                        forms.add(new String[]{
                                rs.getString("FID"), rs.getString("FNUMBER"),
                                rs.getString("FENTITYID"), rs.getString("FPARENTID"),
                                rs.getString("FISV"), String.valueOf(rs.getInt("FENABLED")),
                                String.valueOf(rs.getInt("FISINHERIT")),
                                String.valueOf(rs.getInt("FISEXTENDED")),
                                rs.getString("FMODELTYPE")});
                    }
                    return null;
                });
        System.out.println("[PROBE] 命中布局 " + forms.size() + " 张（含根本身）");

        List<String> shown = new ArrayList<>();
        List<String> hidden = new ArrayList<>();
        List<String> absent = new ArrayList<>();

        for (String[] f : forms) {
            String id = f[0], num = f[1];
            FormMetadata fm;
            try {
                fm = (FormMetadata) MetadataDao.readMeta(id, MetaCategory.Form);
            } catch (Throwable e) {
                System.out.println("[PROBE] !! " + num + " 读不出布局: " + e);
                continue;
            }
            String label = num + " " + fm.getName();
            String base = label + "  id=" + id + " isv=" + f[4] + " enabled=" + f[5]
                    + " inherit=" + f[6] + " ext=" + f[7] + " parent=" + f[3];

            if (field == null) {
                System.out.println("[PROBE]   " + base);
                continue;
            }

            ControlAp<?> ap = null;
            for (ControlAp<?> c : fm.getItems()) {
                if (field.equals(c.getKey())) { ap = c; break; }
            }
            if (ap == null) {
                absent.add(label);
                if (only == null || "absent".equals(only)) {
                    System.out.println("[PROBE] -- " + base + "  布局上没有该控件");
                }
                continue;
            }
            //三个属性一起判，缺一个就会判反
            boolean vis = !ap.isHidden() && !ap.isInvisible();
            (vis ? shown : hidden).add(label);
            if (only == null || (vis ? "shown" : "hidden").equals(only)) {
                System.out.println("[PROBE] " + (vis ? "✔ " : "✘ ") + base
                        + "\n[PROBE]      apId=" + ap.getId() + " 控件名=" + ap.getName()
                        + " hidden=" + ap.isHidden() + " invisible=" + ap.isInvisible()
                        + " visible=" + ap.getVisible() + "(" + ap.getVisibleValue() + ")"
                        + " lock=" + ap.getLock() + " 父Ap=" + ap.getParentId());
            }
        }

        if (field == null) return;
        System.out.println("[PROBE] === 汇总（" + field + "）===");
        dump("显示（非隐藏非不可见）", shown);
        dump("隐藏或不可见", hidden);
        dump("布局上没有该控件", absent);
        System.out.println("[PROBE] ⚠ 以上是设计态静态属性，界面规则/插件仍可能在运行时改写；"
                + "要确认最终效果再跑 RULE_FORM=<布局> FormRuleProbe");
    }

    private static void dump(String title, List<String> xs) {
        System.out.println("[PROBE] " + title + " " + xs.size() + " 张:");
        for (String x : xs) System.out.println("[PROBE]     " + x);
    }

    private static String req(String k) {
        String v = System.getenv(k);
        if (v == null || v.trim().isEmpty()) {
            throw new IllegalArgumentException("缺少环境变量 " + k + "（根单据或根布局标识）");
        }
        return v.trim();
    }

    private static String env(String k, String d) {
        String v = System.getenv(k);
        return v == null || v.isEmpty() ? d : v;
    }
}
