import java.util.ArrayList;
import java.util.List;

import kd.bos.dataentity.entity.DynamicObject;
import kd.bos.dataentity.entity.DynamicObjectCollection;
import kd.bos.dataentity.utils.Uuid8;
import kd.bos.metadata.dao.MetaCategory;
import kd.bos.metadata.dao.MetadataDao;
import kd.bos.metadata.entity.EntityMetadata;
import kd.bos.orm.query.QCP;
import kd.bos.orm.query.QFilter;
import kd.bos.servicehelper.BusinessDataServiceHelper;
import kd.bos.servicehelper.QueryServiceHelper;
import kd.bos.servicehelper.operation.DeleteServiceHelper;
import kd.bos.servicehelper.operation.SaveServiceHelper;

/**
 * 把一张**已经存在的表单**登记到开发平台的「应用 → 功能单元」下。
 *
 * 为什么需要它：MetadataWriter.save(em, fm) 只写元数据本体
 * （T_META_FORMDESIGN / T_META_ENTITYDESIGN），**不写功能单元登记表
 * bos_devportal_unitrelform（T_META_BIZUNITRELFORM）**。少那一行，表单在运行时
 * 完全可用（showForm 能开、插件照跑、getIdByNumber 查得到），但开发平台的左树和
 * 搜索是按登记表铺的 —— 结果就是「代码里好使、设计器里搜不到」。
 * 详见 reference/metadata-create.md。
 *
 *   REG_FORM=表单标识     要登记的表单（必填，必须是本 ISV 的）
 *   REG_REF=参照表单标识  照抄它的 bizunit / bizapp（推荐：同族兄弟表单）
 *   REG_UNIT=功能单元id   直接指定功能单元（与 REG_REF 二选一）
 *   REG_APP=应用id        直接指定应用；用 REG_UNIT 时必填
 *   ROLLBACK=1            删掉本表单的登记行（元数据本体不动）
 *   APPLY=1               真写；不给就是 dry-run 只打印
 *
 * 幂等：已经登记过就直接回验返回，不重复插行。
 */
public class FormRegisterProbe {

    private static final String ENTITY = "bos_devportal_unitrelform";

    public static void run() throws Exception {
        String form = req("REG_FORM", "要登记的表单标识");
        String ref = env("REG_REF", "");
        boolean apply = "1".equals(env("APPLY", ""));
        boolean rollback = "1".equals(env("ROLLBACK", ""));

        String formId = MetadataDao.getIdByNumber(form, MetaCategory.Form);
        if (formId == null || formId.isEmpty()) {
            throw new IllegalArgumentException("表单不存在: " + form + "（先建元数据再登记）");
        }
        guardOwn(form);
        System.out.println("[PROBE] " + form + " formId=" + formId);

        String bizunit = env("REG_UNIT", "");
        String bizappId = env("REG_APP", "");
        if (!ref.isEmpty()) {
            String refId = MetadataDao.getIdByNumber(ref, MetaCategory.Form);
            if (refId == null || refId.isEmpty()) {
                throw new IllegalArgumentException("参照表单不存在: " + ref);
            }
            DynamicObjectCollection refRows = QueryServiceHelper.query(ENTITY,
                    "id,form,bizunit,bizapp.id,bizapp.number",
                    new QFilter[]{new QFilter("form", QCP.equals, refId)});
            if (refRows.isEmpty()) {
                throw new IllegalStateException("参照表单 " + ref + " 自己都没有登记行，换一张");
            }
            bizunit = refRows.get(0).getString("bizunit");
            bizappId = refRows.get(0).getString("bizapp.id");
            System.out.println("[PROBE] 照抄参照 " + ref + "：bizunit=" + bizunit
                    + "  bizapp=" + refRows.get(0).getString("bizapp.number") + "(" + bizappId + ")");
        }

        DynamicObjectCollection mine = QueryServiceHelper.query(ENTITY,
                "id,form,bizunit,bizapp.id",
                new QFilter[]{new QFilter("form", QCP.equals, formId)});
        System.out.println("[PROBE] " + form + " 现有登记行 " + mine.size() + " 条");

        if (rollback) {
            if (mine.isEmpty()) {
                System.out.println("[PROBE] 没有登记行可删");
                return;
            }
            List<String> pks = new ArrayList<String>();
            for (int i = 0; i < mine.size(); i++) {
                pks.add(mine.get(i).getString("id"));
                System.out.println("[PROBE] 待删 id=" + pks.get(i)
                        + "  bizunit=" + mine.get(i).getString("bizunit"));
                if (bizappId.isEmpty()) {
                    bizappId = mine.get(i).getString("bizapp.id");
                }
            }
            if (!apply) {
                IsvGuard.reportTargets();
                System.out.println("[PROBE] dry-run 结束，未删除。确认后加 APPLY=1");
                return;
            }
            //按 form 列删，别按 id 兜底：id 写错会误伤别人的登记行
            DeleteServiceHelper.delete(ENTITY, new QFilter[]{
                    new QFilter("form", QCP.equals, formId)});
            System.out.println("[PROBE] 已删除 " + pks.size() + " 行");
            refreshAppCache(bizappId);
            verify(form, formId);
            return;
        }

        if (!mine.isEmpty()) {
            System.out.println("[PROBE] 已经登记过了，幂等返回");
            verify(form, formId);
            return;
        }
        if (bizunit.isEmpty() || bizappId.isEmpty()) {
            throw new IllegalArgumentException(
                    "缺功能单元/应用：给 REG_REF=同族兄弟表单，或 REG_UNIT= 加 REG_APP=");
        }

        String newId = Uuid8.generateShortUuid();
        System.out.println("[PROBE] 将新增登记行 id=" + newId + "  form=" + formId
                + "  bizunit=" + bizunit + "  bizapp=" + bizappId);
        if (!apply) {
            IsvGuard.reportTargets();
            System.out.println("[PROBE] dry-run 结束，未写入。确认无误后加 APPLY=1");
            return;
        }

        DynamicObject row = BusinessDataServiceHelper.newDynamicObject(ENTITY);
        row.set("id", newId);
        row.set("form", formId);
        row.set("bizunit", bizunit);
        row.set("bizapp_id", bizappId);
        SaveServiceHelper.save(new DynamicObject[]{row});
        System.out.println("[PROBE] 登记行已写入");

        refreshAppCache(bizappId);
        verify(form, formId);
        System.out.println("[PROBE] 要回滚：REG_FORM=" + form + " ROLLBACK=1 APPLY=1 重跑本探针");
    }

    /** 开发平台的应用树走缓存，不刷新的话页面上还是看不到 */
    private static void refreshAppCache(String bizappId) {
        if (bizappId == null || bizappId.isEmpty()) {
            return;
        }
        try {
            MetadataDao.rebuildRuntimeAppMetaById(bizappId);
            System.out.println("[PROBE] rebuildRuntimeAppMetaById(" + bizappId + ") 完成");
        } catch (Throwable t) {
            System.out.println("[PROBE] rebuildRuntimeAppMetaById 失败：" + t);
        }
        try {
            MetadataDao.cleanAllAppMetadataCache();
            System.out.println("[PROBE] cleanAllAppMetadataCache 完成");
        } catch (Throwable t) {
            System.out.println("[PROBE] cleanAllAppMetadataCache 失败：" + t);
        }
    }

    private static void verify(String form, String formId) {
        System.out.println("[PROBE] --- 回验 ---");
        System.out.println("[PROBE] getAppIdByFormId    = " + MetadataDao.getAppIdByFormId(formId));
        System.out.println("[PROBE] getAppIdFromUnitrel = " + MetadataDao.getAppIdFromUnitrel(formId));
        System.out.println("[PROBE] getUnitIdFromUnitrel= " + MetadataDao.getUnitIdFromUnitrel(formId));
        DynamicObjectCollection rows = QueryServiceHelper.query(ENTITY,
                "id,form,bizunit,bizapp.number,bizapp.name",
                new QFilter[]{new QFilter("form", QCP.equals, formId)});
        System.out.println("[PROBE] 登记行 " + rows.size() + " 条");
        for (int i = 0; i < rows.size(); i++) {
            System.out.println("[PROBE]   id=" + rows.get(i).getString("id")
                    + "  bizunit=" + rows.get(i).getString("bizunit")
                    + "  bizapp=" + rows.get(i).getString("bizapp.number")
                    + "/" + rows.get(i).getString("bizapp.name"));
        }
        System.out.println("[PROBE] 全量回验：VIS_FORM=" + form + " probe FormVisibleProbe");
    }

    /** 登记表虽然不是元数据本体，写的仍是开发平台的东西 —— 照样过红线 */
    private static void guardOwn(String form) {
        String entityId = MetadataDao.getIdByNumber(form, MetaCategory.Entity);
        if (entityId != null && !entityId.isEmpty()) {
            EntityMetadata em = (EntityMetadata) MetadataDao.readMeta(entityId, MetaCategory.Entity);
            IsvGuard.assertOwnEntity(form, em);
            return;
        }
        System.out.println("[PROBE] " + form + " 没有实体元数据，只能查前缀");
        IsvGuard.assertOwnField(form);
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
