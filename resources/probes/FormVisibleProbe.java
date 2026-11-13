import java.util.Map;

import kd.bos.dataentity.entity.DynamicObjectCollection;
import kd.bos.metadata.dao.MetaCategory;
import kd.bos.metadata.dao.MetadataDao;
import kd.bos.orm.query.QCP;
import kd.bos.orm.query.QFilter;
import kd.bos.servicehelper.QueryServiceHelper;

/**
 * 新建表单的落地回验：把开发平台会走的几条路各查一遍，确认这张表单**真的能被找到**。
 *
 * 用途是回答一个具体问题：元数据建出来了、运行时也能开，为什么开发平台搜不到？
 * 判据不是「元数据存在」（那只覆盖第 ① 条），而是**每一条都跟一张已知能搜到的
 * 同族表单对齐**。给了 VIS_REF 就逐条并排打印，缺哪一条一眼可见。
 *
 *   VIS_FORM=表单标识   要验的表单（必填）
 *   VIS_REF=参照表单    已知能在开发平台搜到的同族兄弟表单（强烈建议给）
 *
 * 判读：③ ⑤ ⑦ 三条为 null / false，就是**功能单元登记行没写**
 * （bos_devportal_unitrelform）—— 用 FormRegisterProbe 补，见
 * reference/metadata-create.md。
 */
public class FormVisibleProbe {

    private static final String UNITREL = "bos_devportal_unitrelform";

    public static void run() throws Exception {
        String form = req("VIS_FORM", "要验的表单标识");
        String ref = env("VIS_REF", "");

        String id = MetadataDao.getIdByNumber(form, MetaCategory.Form);
        if (id == null || id.isEmpty()) {
            System.out.println("[PROBE] ① getIdByNumber(Form) = null —— 表单元数据根本不存在，"
                    + "后面几条不用看了");
            return;
        }
        System.out.println("[PROBE] " + form + "  formId=" + id);
        System.out.println("[PROBE] ① getIdByNumber(Form)   = " + id);
        System.out.println("[PROBE] ① getIdByNumber(Entity) = "
                + MetadataDao.getIdByNumber(form, MetaCategory.Entity));
        System.out.println("[PROBE] ② getNumberById         = " + MetadataDao.getNumberById(id));
        System.out.println("[PROBE] ③ getAppIdByFormId      = " + MetadataDao.getAppIdByFormId(id));
        System.out.println("[PROBE] ③ getUnitIdFromUnitrel  = " + MetadataDao.getUnitIdFromUnitrel(id));
        System.out.println("[PROBE] ④ getEntityNumberByFormNumber = "
                + MetadataDao.getEntityNumberByFormNumber(form));
        System.out.println("[PROBE] ⑤ getAppNumberByEntityNumber  = "
                + MetadataDao.getAppNumberByEntityNumber(form));

        Map<?, ?> all = MetadataDao.getAllFormNumbers();
        boolean inAll = false;
        if (all != null) {
            //版本之间 key/value 谁是 number 不一定，两头都扫
            for (Map.Entry<?, ?> e : all.entrySet()) {
                if (form.equals(String.valueOf(e.getKey())) || form.equals(String.valueOf(e.getValue()))) {
                    inAll = true;
                    break;
                }
            }
        }
        System.out.println("[PROBE] ⑥ getAllFormNumbers 共 " + (all == null ? -1 : all.size())
                + " 项，含 " + form + " = " + inAll);

        //⑦ 功能单元下挂的表单清单：开发平台左树就是按它铺的
        String unit = MetadataDao.getUnitIdFromUnitrel(id);
        String refId = null;
        if (!ref.isEmpty()) {
            refId = MetadataDao.getIdByNumber(ref, MetaCategory.Form);
            if (unit == null || unit.isEmpty()) {
                //本表单没登记时，拿参照的单元来看「本该在哪张清单里」
                unit = refId == null ? null : MetadataDao.getUnitIdFromUnitrel(refId);
            }
        }
        if (unit == null || unit.isEmpty()) {
            System.out.println("[PROBE] ⑦ 查不到功能单元 —— 登记行没写，见 FormRegisterProbe");
        } else {
            DynamicObjectCollection u = QueryServiceHelper.query(UNITREL, "id,form",
                    new QFilter[]{new QFilter("bizunit", QCP.equals, unit)});
            boolean listed = false;
            for (int i = 0; i < u.size(); i++) {
                if (id.equals(u.get(i).getString("form"))) {
                    listed = true;
                    break;
                }
            }
            System.out.println("[PROBE] ⑦ 功能单元 " + unit + " 下 " + u.size()
                    + " 张表单，含 " + form + " = " + listed);
        }

        //⑧ 参照表单每一条都是什么样 —— 差异就是还没补的东西
        if (refId != null && !refId.isEmpty()) {
            System.out.println("[PROBE] ⑧ 参照 " + ref
                    + "  app=" + MetadataDao.getAppIdByFormId(refId)
                    + "  unit=" + MetadataDao.getUnitIdFromUnitrel(refId)
                    + "  entityNumber=" + MetadataDao.getEntityNumberByFormNumber(ref)
                    + "  appNumber=" + MetadataDao.getAppNumberByEntityNumber(ref));
        } else if (!ref.isEmpty()) {
            System.out.println("[PROBE] ⑧ 参照表单 " + ref + " 不存在");
        }
    }

    private static String env(String key, String def) {
        String v = System.getenv(key);
        return v == null || v.trim().isEmpty() ? def : v.trim();
    }

    private static String req(String key, String what) {
        String v = env(key, "");
        if (v.isEmpty()) {
            throw new IllegalArgumentException("缺参数 " + key + "（" + what + "）");
        }
        return v;
    }
}
