import java.sql.ResultSet;

import kd.bos.db.DB;
import kd.bos.db.DBRoute;
import kd.bos.db.ResultSetHandler;

/**
 * 表单目录：全库每份表单设计（单据、基础资料、动态表单、移动表单、报表、查询列表）的编号、中文名、
 * 模型类型、所属 ISV、绑的实体、上级设计、扩展的原单。给输入框里的 `@` 引用用：人敲「销售出库」或
 * 「saloutbill」，在这份目录里找候选。结论走 JSON 旁路（`[PROBE-JSON] t=form`）。
 *
 * 只读。只查设计表的几列和名称表，不读 FDATA（4 万多份设计的 XML 拉回来要几个 GB，这里一份都不读）。
 *
 * 每份一行：
 *   n  表单编号                         t_meta_formdesign.FNUMBER
 *   m  模型类型（BillFormModel 等）      FMODELTYPE
 *   i  ISV                              FISV
 *   e  绑的实体编号                      FENTITYID → t_meta_entitydesign.FNUMBER；和 n 不同就说明它是那张实体的另一份布局
 *   p  上级设计编号                      FPARENTID → t_meta_formdesign.FNUMBER（继承来的布局、模板）
 *   b  扩展的原单编号                    FMASTERID 指向别的设计时（本 ISV 扩展平台单据，插件和代码用原单编号）
 *   name 中文名                          t_meta_formdesign_l.FNAME（zh_CN）；没有就不带
 *   off  停用（FENABLED=0）时为 1
 * 多语言表里同一份设计偶尔不止一行 zh_CN，按编号只报第一行。
 */
public class FormCatalogProbe {

    /** 人会点名的那几类；打印模板、参数表单、小部件不进目录（打印模板另有名称通道）。 */
    private static final String MODELS = "'BillFormModel','BaseFormModel','DynamicFormModel','MobileFormModel',"
            + "'MobileBillFormModel','ReportFormModel','QueryListModel'";

    public static void run() {
        final long t0 = System.currentTimeMillis();
        final java.util.Set<String> seen = new java.util.HashSet<String>();
        final int[] stat = new int[3];   // 0=报出 1=有中文名 2=停用
        DB.query(DBRoute.meta, "select f.fnumber, f.fmodeltype, f.fisv, f.fenabled, e.fnumber, p.fnumber, m.fnumber, l.fname"
                + " from t_meta_formdesign f"
                + " left join t_meta_entitydesign e on e.fid = f.fentityid"
                + " left join t_meta_formdesign p on p.fid = f.fparentid"
                + " left join t_meta_formdesign m on m.fid = f.fmasterid and f.fmasterid <> f.fid"
                + " left join t_meta_formdesign_l l on l.fid = f.fid and l.flocaleid = 'zh_CN'"
                + " where f.fmodeltype in (" + MODELS + ")",
                new ResultSetHandler<Void>() {
                    public Void handle(ResultSet rs) throws Exception {
                        while (rs.next()) {
                            String number = rs.getString(1);
                            if (number == null || number.isEmpty() || !seen.add(number)) {
                                continue;
                            }
                            String entity = nz(rs.getString(5));
                            String parent = nz(rs.getString(6));
                            String master = nz(rs.getString(7));
                            String name = nz(rs.getString(8)).trim();
                            boolean off = rs.getInt(4) == 0;
                            ProbeJson.emit("form", "n", number, "m", nz(rs.getString(2)), "i", nz(rs.getString(3)),
                                    "e", entity.equals(number) ? "" : entity,
                                    "p", parent,
                                    "b", master.equals(number) ? "" : master,
                                    "name", name,
                                    "off", off ? 1 : 0);
                            stat[0]++;
                            if (!name.isEmpty()) {
                                stat[1]++;
                            }
                            if (off) {
                                stat[2]++;
                            }
                        }
                        return null;
                    }
                });
        long ms = System.currentTimeMillis() - t0;
        ProbeJson.emit("form-summary", "forms", stat[0], "named", stat[1], "off", stat[2], "ms", ms);
        System.out.println("[PROBE] 表单目录 " + stat[0] + " 份，有中文名 " + stat[1] + " 份，停用 " + stat[2]
                + " 份，" + ms + "ms");
    }

    private static String nz(String s) {
        return s == null ? "" : s;
    }
}
