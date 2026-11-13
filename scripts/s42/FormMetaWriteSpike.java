import java.beans.Introspector;
import java.beans.PropertyDescriptor;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.fasterxml.jackson.databind.ObjectMapper;

import kd.bos.designer.ai.copilot.engine.handler.FormControlHandler;
import kd.bos.designer.ai.copilot.model.MetaOp;
import kd.bos.designer.ai.copilot.model.MetaTarget;
import kd.bos.designer.property.setting.MetaPropertyService;
import kd.bos.designer.property.util.MetadataUtil;
import kd.bos.metadata.AbstractMetadata;
import kd.bos.metadata.dao.MetaCategory;
import kd.bos.metadata.dao.MetadataDao;
import kd.bos.metadata.dao.MetadataSerializer;
import kd.bos.metadata.dao.MetadataWriter;
import kd.bos.metadata.entity.EntityMetadata;
import kd.bos.metadata.form.ControlAp;
import kd.bos.metadata.form.FormMetadata;

/**
 * S42 批 0.2 写入探路：在用户新建的空单据上，按「备份 → 内存里改 → 一次保存 → 回读核对 → 从备份文件恢复」走一遍。
 *   SPIKE_FORM=单据标识（必填，要过 IsvGuard：本 ISV、带前缀、APPLY 时在确认清单里）
 *   SPIKE_MOVE=要挪进新面板的布局控件标识（默认 auditor）
 *   OUT=备份文件目录（默认 java.io.tmpdir）
 *   APPLY=1 真写并恢复；不给只在内存里改、打差异
 *   RESTORE_FILE=备份文件  只做恢复：把这份备份写回去（上一次没恢复成功时用）
 * 改动固定三处：contentpanel 下加一个 Flex 面板 zlgd_s42pnl；把 SPIKE_MOVE 挪进去；面板和被挪的控件各改两项样式。
 */
public class FormMetaWriteSpike {

    static final String PANEL = "zlgd_s42pnl";
    static final ObjectMapper OM = new ObjectMapper();

    public static void run() throws Exception {
        String form = env("SPIKE_FORM", "");
        if (form.isEmpty()) throw new IllegalArgumentException("SPIKE_FORM 必填");
        boolean apply = "1".equals(env("APPLY", ""));
        String out = env("OUT", System.getProperty("java.io.tmpdir"));
        String moveKey = env("SPIKE_MOVE", "auditor");

        String formId = MetadataDao.getIdByNumber(form, MetaCategory.Form);
        FormMetadata fm = (FormMetadata) MetadataDao.readMeta(formId, MetaCategory.Form);
        EntityMetadata em = (EntityMetadata) MetadataDao.readMeta(fm.getEntityId(), MetaCategory.Entity);
        IsvGuard.assertOwnEntity(em.getKey(), em);
        IsvGuard.assertOwnLayout(em.getKey(), form);
        p("formId=" + formId + " modelType=" + fm.getModelType() + " 控件数=" + fm.getItems().size()
                + " 继承自=" + fm.getParentId());
        try { p("verifyLock=" + MetadataUtil.verifyLock(formId)); } catch (Exception e) { p("verifyLock 异常 " + e); }

        MetadataSerializer ser = new MetadataSerializer(fm.getModelType());
        String restoreFile = env("RESTORE_FILE", "");
        if (!restoreFile.isEmpty()) {
            restore(ser, formId, fm.getModelType(), new String(Files.readAllBytes(new File(restoreFile).toPath()), StandardCharsets.UTF_8), apply);
            return;
        }

        // 1. 备份：整份布局序列化成 JSON 落盘；恢复只从这份文件走，验的就是「进程崩了也能恢复」那条路
        long t = now();
        Map<String, Object> beforeMap = ser.serializeToMap(fm);
        String backup = OM.writeValueAsString(beforeMap);
        File bf = new File(out, form + "-layout-backup-" + System.currentTimeMillis() + ".json");
        bf.getParentFile().mkdirs();
        try (Writer w = new OutputStreamWriter(new FileOutputStream(bf), StandardCharsets.UTF_8)) { w.write(backup); }
        p("耗时 备份 " + (now() - t) + "ms  " + backup.length() + " 字符 → " + bf.getAbsolutePath());
        FormMetadata pristine = fromJson(ser, backup);
        p("备份反序列化回对象 控件数=" + pristine.getItems().size() + "  与原对象差异 "
                + len(diff(ser, pristine, fm)) + " 字符");

        // 2. 内存里改：加面板、挪控件、改样式。平台的控件处理类只拿来改内存，保存由这里一次做
        t = now();
        FormControlHandler h = new FormControlHandler(OM);
        MetaOp add = new MetaOp();
        add.setOp(MetaOp.OpType.add);
        add.setTarget(new MetaTarget(MetaTarget.TreeType.form, MetaTarget.ElementType.control, MetaTarget.LocateBy.key, PANEL));
        Map<String, Object> v = new LinkedHashMap<>();
        v.put("containerType", "FlexPanelAp");
        v.put("name", "S42测试面板");
        add.setValue(v);
        Map<String, Object> ex = new LinkedHashMap<>();
        ex.put("parentKey", "contentpanel");
        ex.put("index", 0);
        add.setExtra(ex);
        h.applyAddControl(fm, add);
        fm.createIndex();
        ControlAp<?> panel = fm.getItemByKey(PANEL);
        p("加面板 " + (panel == null ? "失败：找不到 " + PANEL : panel.getClass().getSimpleName() + " id=" + panel.getId() + " parent=" + parentKey(fm, panel) + " index=" + panel.getIndex()));
        if (panel == null) return;

        ControlAp<?> moving = fm.getItemByKey(moveKey);
        if (moving == null) { p("找不到要挪的控件 " + moveKey); return; }
        String fromParent = parentKey(fm, moving);
        MetaOp mv = new MetaOp();
        mv.setOp(MetaOp.OpType.move);
        mv.setTarget(new MetaTarget(MetaTarget.TreeType.form, MetaTarget.ElementType.control, MetaTarget.LocateBy.key, moveKey));
        Map<String, Object> mex = new LinkedHashMap<>();
        mex.put("destination", PANEL);
        mex.put("index", 0);
        mv.setExtra(mex);
        h.applyMoveContainer(mv, fm);
        fm.createIndex();
        p("挪控件 " + moveKey + " " + fromParent + " → " + parentKey(fm, fm.getItemByKey(moveKey)));

        Map<String, Object> panelStyle = new LinkedHashMap<>();
        panelStyle.put("BackColor", "#FFF7E6");
        panelStyle.put("Width", "360px");
        Map<String, Object> ctlStyle = new LinkedHashMap<>();
        ctlStyle.put("ForeColor", "#CC0000");
        ctlStyle.put("FontSize", 14);
        setProps(panel, panelStyle);
        setProps(fm.getItemByKey(moveKey), ctlStyle);
        p("耗时 内存改动 " + (now() - t) + "ms");

        String diff = diff(ser, fm, pristine);
        p("差异（平台 buildDiffXml，备份→改后）" + len(diff) + " 字符：" + head(diff, 3000));

        if (!apply) {
            IsvGuard.reportTargets();
            p("dry-run 结束，未写入。备份文件可删：" + bf.getAbsolutePath());
            return;
        }

        // 3. 一次保存 + 刷新运行态
        t = now();
        MetadataWriter writer = new MetadataWriter(fm.getModelType());
        Map<String, Object> r = writer.save(fm);
        p("save → success=" + r.get("success") + "  " + head(String.valueOf(r), 600));
        MetadataDao.rebuildRuntimeMetaById(formId);
        p("耗时 保存+刷新 " + (now() - t) + "ms");
        boolean saved = Boolean.TRUE.equals(r.get("success"));

        try {
            if (saved) {
                // 4. 回读：设计态、运行态各读一遍，逐项核对
                t = now();
                FormMetadata back = (FormMetadata) MetadataDao.readMeta(formId, MetaCategory.Form);
                back.createIndex();
                check(back, "设计态", moveKey, panelStyle, ctlStyle);
                AbstractMetadata rt = MetadataDao.readRuntimeMeta(formId, MetaCategory.Form);
                if (rt instanceof FormMetadata) {
                    FormMetadata rf = (FormMetadata) rt;
                    rf.createIndex();
                    check(rf, "运行态", moveKey, panelStyle, ctlStyle);
                } else {
                    p("运行态读回类型 " + (rt == null ? "null" : rt.getClass().getName()));
                }
                p("回读后与改后差异 " + len(diff(ser, back, fm)) + " 字符" + (len(diff(ser, back, fm)) > 0 ? "：" + head(diff(ser, back, fm), 2000) : ""));
                p("耗时 回读 " + (now() - t) + "ms");
                try { p("写后 verifyLock=" + MetadataUtil.verifyLock(formId)); } catch (Exception e) { p("verifyLock 异常 " + e); }
            }
        } finally {
            // 5. 恢复：不管核对结果如何，都从备份文件写回
            restore(ser, formId, fm.getModelType(), new String(Files.readAllBytes(bf.toPath()), StandardCharsets.UTF_8), true);
        }
    }

    static void restore(MetadataSerializer ser, String formId, String modelType, String backup, boolean apply) throws Exception {
        long t = now();
        FormMetadata original = fromJson(ser, backup);
        FormMetadata current = (FormMetadata) MetadataDao.readMeta(formId, MetaCategory.Form);
        p("恢复前与备份差异 " + len(diff(ser, current, original)) + " 字符");
        if (!apply) { p("RESTORE_FILE 只看差异；加 APPLY=1 才写回"); return; }
        Map<String, Object> r = new MetadataWriter(modelType).save(original);
        MetadataDao.rebuildRuntimeMetaById(formId);
        p("恢复 save → success=" + r.get("success") + "  " + head(String.valueOf(r), 400));
        FormMetadata after = (FormMetadata) MetadataDao.readMeta(formId, MetaCategory.Form);
        String d = diff(ser, after, fromJson(ser, backup));
        String again = OM.writeValueAsString(ser.serializeToMap(after));
        p("恢复后与备份差异 " + len(d) + " 字符  序列化逐字相同=" + again.equals(backup)
                + (again.equals(backup) ? "" : "  备份 " + backup.length() + " / 现在 " + again.length() + " 字符"));
        if (len(d) > 0) p("恢复后残留差异：" + head(d, 2000));
        after.createIndex();
        p("恢复后 " + PANEL + (after.getItemByKey(PANEL) == null ? " 已不在" : " 仍在！"));
        p("耗时 恢复 " + (now() - t) + "ms");
    }

    /**
     * 平台的差异：`buildDiffXml(新, 旧)` 给出「从旧到新」要改的每一处。没有差异时它只回一个空的
     * FormMetadata 根节点，这里记成空串，免得把 54 字符的空壳当成有差异。
     */
    static String diff(MetadataSerializer ser, Object newer, Object older) {
        String x = ser.buildDiffXml(newer, older);
        return x == null || x.trim().endsWith("<FormMetadata/>") ? "" : x;
    }

    @SuppressWarnings("unchecked")
    static FormMetadata fromJson(MetadataSerializer ser, String json) throws Exception {
        Map<String, Object> m = OM.readValue(json, Map.class);
        return (FormMetadata) ser.deserializeFromMap(m, null);
    }

    /** 和属性面板同一套：按 bean 属性名写，值用平台自己的类型转换（MetaPropertyService.convertValue）。 */
    static void setProps(ControlAp<?> ap, Map<String, Object> props) throws Exception {
        Method cv = MetaPropertyService.class.getDeclaredMethod("convertValue", Object.class, Class.class);
        cv.setAccessible(true);
        for (Map.Entry<String, Object> e : props.entrySet()) {
            PropertyDescriptor pd = descriptor(ap, e.getKey());
            if (pd == null || pd.getWriteMethod() == null) { p("  属性 " + ap.getKey() + "." + e.getKey() + " 不存在或不可写"); continue; }
            Class<?> type = pd.getWriteMethod().getParameterTypes()[0];
            Object val = cv.invoke(null, e.getValue(), type);
            pd.getWriteMethod().invoke(ap, val);
            p("  属性 " + ap.getKey() + "." + e.getKey() + " (" + type.getSimpleName() + ") = " + read(ap, e.getKey()));
        }
    }

    static void check(FormMetadata f, String where, String moveKey, Map<String, Object> panelStyle, Map<String, Object> ctlStyle) throws Exception {
        ControlAp<?> panel = f.getItemByKey(PANEL);
        ControlAp<?> moved = f.getItemByKey(moveKey);
        StringBuilder sb = new StringBuilder(where + "回读：");
        sb.append("面板").append(panel == null ? "✗" : "✓ parent=" + parentKey(f, panel));
        sb.append("  ").append(moveKey).append(moved == null ? "✗" : " parent=" + parentKey(f, moved));
        if (panel != null) for (String k : panelStyle.keySet()) sb.append("  面板.").append(k).append('=').append(read(panel, k));
        if (moved != null) for (String k : ctlStyle.keySet()) sb.append("  控件.").append(k).append('=').append(read(moved, k));
        p(sb.toString());
    }

    static PropertyDescriptor descriptor(Object o, String name) throws Exception {
        for (PropertyDescriptor pd : Introspector.getBeanInfo(o.getClass(), Object.class).getPropertyDescriptors()) {
            if (pd.getName().equalsIgnoreCase(name)) return pd;
        }
        return null;
    }

    static String read(Object o, String name) {
        try {
            PropertyDescriptor pd = descriptor(o, name);
            return pd == null || pd.getReadMethod() == null ? "?" : String.valueOf(pd.getReadMethod().invoke(o));
        } catch (Exception e) {
            return "读失败 " + e;
        }
    }

    static String parentKey(FormMetadata f, ControlAp<?> ap) {
        if (ap == null) return "?";
        String pid = ap.getParentId();
        for (ControlAp<?> c : (List<ControlAp<?>>) (List<?>) f.getItems()) {
            if (c.getId().equals(pid)) return c.getKey();
        }
        return "id:" + pid;
    }

    static long now() { return System.currentTimeMillis(); }
    static int len(String s) { return s == null ? 0 : s.length(); }
    static String head(String s, int n) { return s == null ? "null" : s.length() <= n ? s : s.substring(0, n) + "…(共" + s.length() + "字符)"; }
    static String env(String k, String d) { String v = System.getenv(k); return v == null || v.trim().isEmpty() ? d : v.trim(); }
    static void p(String s) { System.out.println("[PROBE] " + s); }
}
