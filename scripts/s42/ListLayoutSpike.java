import java.util.List;
import java.util.Map;

import kd.bos.designer.property.setting.MetaPropertyService;
import kd.bos.designer.property.setting.PropertySchema;
import kd.bos.metadata.dao.MetaCategory;
import kd.bos.metadata.dao.MetadataDao;
import kd.bos.metadata.dao.MetadataSerializer;
import kd.bos.metadata.form.BillFormAp;
import kd.bos.metadata.form.ControlAp;
import kd.bos.metadata.form.FormMetadata;

/**
 * S42 §16.8 第 1 条只读探路：单据的列表布局（塞在 BillFormAp 里的那份 FormMetadata）长什么样、
 * 平台的属性清单认不认它的元素、单据布局序列化时带不带它。
 *   SPIKE_FORM=单据标识（默认 zlgd_sys_bgjl）
 *   SPIKE_ELEM=要看属性的列表元素，逗号隔开（默认 tblnew,tbldel）
 */
public class ListLayoutSpike {

    public static void run() throws Exception {
        String form = env("SPIKE_FORM", "zlgd_sys_bgjl");
        String formId = MetadataDao.getIdByNumber(form, MetaCategory.Form);
        FormMetadata fm = (FormMetadata) MetadataDao.readMeta(formId, MetaCategory.Form);
        System.out.println("[PROBE] 单据布局 " + form + " id=" + formId + " modelType=" + fm.getModelType()
                + " 控件 " + fm.getItems().size() + " root=" + fm.getRootAp().getClass().getSimpleName());
        FormMetadata list = ((BillFormAp) fm.getRootAp()).getListMeta();
        if (list == null) {
            System.out.println("[PROBE] 没有列表布局");
            return;
        }
        System.out.println("[PROBE] 列表布局 id=" + list.getId() + " key=" + list.getKey() + " modelType=" + list.getModelType()
                + " entityId=" + list.getEntityId() + " parentId=" + list.getParentId() + " 控件 " + list.getItems().size()
                + " root=" + (list.getRootAp() == null ? "null" : list.getRootAp().getClass().getSimpleName() + "/" + list.getRootAp().getKey()));
        String byNumber = list.getKey() == null ? null : MetadataDao.getIdByNumber(list.getKey(), MetaCategory.Form);
        System.out.println("[PROBE] 按列表 key 查布局 id=" + byNumber);
        for (ControlAp<?> c : list.getItems()) {
            System.out.println("[PROBE]   " + c.getKey() + "  " + c.getClass().getSimpleName() + "  id=" + c.getId()
                    + "  parent=" + c.getParentId() + "  index=" + c.getIndex());
        }
        for (String key : env("SPIKE_ELEM", "tblnew,tbldel").split(",")) {
            key = key.trim();
            report("单据布局 " + form, form, key);
            if (list.getKey() != null) report("列表 key " + list.getKey(), list.getKey(), key);
            if (list.getId() != null) report("列表 id " + list.getId(), list.getId(), key);
        }
        MetadataSerializer ser = new MetadataSerializer(fm.getModelType());
        Map<String, Object> map = ser.serializeToMap(fm);
        String json = String.valueOf(map);
        System.out.println("[PROBE] 单据布局序列化 " + json.length() + " 字符，含 tblnew=" + json.contains("tblnew")
                + " 含 ListMeta=" + json.toLowerCase().contains("listmeta") + " 顶层键=" + map.keySet());
        Map<String, Object> listMap = new MetadataSerializer(list.getModelType()).serializeToMap(list);
        System.out.println("[PROBE] 列表布局单独序列化 " + String.valueOf(listMap).length() + " 字符，顶层键=" + listMap.keySet());
        System.out.println("[PROBE-OK] ListLayoutSpike");
    }

    static void report(String label, String formKey, String key) {
        try {
            List<PropertySchema> s = MetaPropertyService.getPropertySchema(formKey, key);
            StringBuilder names = new StringBuilder();
            if (s != null) for (PropertySchema x : s) names.append(x.getPropertyName()).append(x.isEditable() ? "" : "(只读)").append(' ');
            System.out.println("[PROBE] 属性清单 " + label + " / " + key + " -> " + (s == null ? "null" : s.size() + " 条: " + names));
        } catch (Throwable e) {
            System.out.println("[PROBE] 属性清单 " + label + " / " + key + " -> " + e.getClass().getSimpleName() + ": " + e.getMessage());
        }
    }

    static String env(String k, String d) {
        String v = System.getenv(k);
        if (v == null) v = System.getProperty(k);
        return v == null || v.isEmpty() ? d : v;
    }
}
