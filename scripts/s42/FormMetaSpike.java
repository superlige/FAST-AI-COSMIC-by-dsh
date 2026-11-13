import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.fasterxml.jackson.databind.ObjectMapper;

import kd.bos.designer.ai.copilot.engine.MetaOpsFinder;
import kd.bos.designer.ai.copilot.engine.MetaOpsPreview;
import kd.bos.designer.ai.copilot.model.MetaOp;
import kd.bos.designer.ai.copilot.model.MetaOpsResult;
import kd.bos.designer.ai.copilot.model.MetaTarget;
import kd.bos.designer.ai.copilot.model.PreviewGroup;
import kd.bos.designer.ai.copilot.model.SessionContext;
import kd.bos.designer.ai.copilot.service.SchemaContextBuilder;
import kd.bos.designer.property.operation.MetaOperationService;
import kd.bos.designer.property.operation.OperationListResult;
import kd.bos.designer.property.setting.ElementInfo;
import kd.bos.designer.property.setting.MetaPropertyService;
import kd.bos.designer.property.setting.PropertySchema;
import kd.bos.designer.property.util.MetadataUtil;

/**
 * S42 批 0 只读探路：平台自带的 AI 设计器服务在探针进程里能不能跑、返回什么、要多久。
 *   SPIKE_FORM=单据标识（默认 zlgd_nbjgjl）
 *   SPIKE_ELEM=要看属性的元素标识，逗号隔开（不给就取元素清单里第一个字段和第一个容器）
 *   SPIKE_MOVE=字段标识>目标容器标识   可选，只预览一次移动（预览只读）
 */
public class FormMetaSpike {

    public static void run() throws Exception {
        String form = env("SPIKE_FORM", "zlgd_nbjgjl");
        long t0 = System.currentTimeMillis();
        String formId = MetadataUtil.getFormIdByNumber(form);
        p("formId=" + formId + " isv=" + MetadataUtil.getCurrentIsv() + " productEnv=" + MetadataUtil.isProductEnv()
                + " deploying=" + MetadataUtil.isDeploying() + " lightExt=" + MetadataUtil.isLightExt(formId));
        p("checkEnv=" + MetadataUtil.checkEnv());
        try { p("checkFormIsvMatch(number)=" + MetadataUtil.checkFormIsvMatch(form)); } catch (Exception e) { p("checkFormIsvMatch 异常 " + e); }
        try { p("checkReadable(number)=" + MetadataUtil.checkReadable(form)); } catch (Exception e) { p("checkReadable 异常 " + e); }
        try { p("checkEditable(number,null)=" + MetadataUtil.checkEditable(form, null)); } catch (Exception e) { p("checkEditable 异常 " + e); }
        try { p("checkPageModifyPermission=" + MetadataUtil.checkPageModifyPermission()); } catch (Exception e) { p("checkPageModifyPermission 异常 " + e); }

        p("耗时 前置检查 " + (System.currentTimeMillis() - t0) + "ms");

        ObjectMapper om = new ObjectMapper();
        SchemaContextBuilder b = new SchemaContextBuilder(om);
        long t1 = System.currentTimeMillis();
        String modelJson = tree(om, b, "model", formId, form);
        String layoutJson = tree(om, b, "layout", formId, form);
        String text = null;
        try { text = b.buildSchemaContextText(formId); } catch (Exception e) { p("文字概要(id) 异常 " + e); }
        if (text == null || text.isEmpty()) { try { text = b.buildSchemaContextText(form); } catch (Exception e) { p("文字概要(number) 异常 " + e); } }
        p("耗时 三种树 " + (System.currentTimeMillis() - t1) + "ms  字段树 " + bytes(modelJson) + "B  布局树 "
                + bytes(layoutJson) + "B  文字概要 " + bytes(text) + "B");
        p("字段树开头: " + head(modelJson, 1500));
        p("布局树开头: " + head(layoutJson, 2500));
        p("文字概要开头: " + head(text, 1500));

        long t2 = System.currentTimeMillis();
        List<ElementInfo> elems = MetaPropertyService.listElements(form, null);
        Map<String, Integer> byType = new LinkedHashMap<String, Integer>();
        String firstField = null;
        String firstContainer = null;
        for (ElementInfo e : elems) {
            String k = e.getCategory() + "/" + e.getType();
            byType.put(k, byType.containsKey(k) ? byType.get(k) + 1 : 1);
            if (firstField == null && "field".equals(e.getCategory())) firstField = e.getKey();
            if (firstContainer == null && e.getType() != null && e.getType().contains("Panel")) firstContainer = e.getKey();
        }
        p("耗时 元素清单 " + (System.currentTimeMillis() - t2) + "ms  共 " + elems.size() + " 个  按类别/类型 " + byType);
        for (ElementInfo e : elems) {
            String t = e.getType() == null ? "" : e.getType();
            boolean container = "control".equals(e.getCategory()) && !t.endsWith("FieldAp") && !t.contains("BarItem");
            if (!container && !"zlgd_wtdh".equals(e.getKey())) continue;
            p("  元素 " + e.getCategory() + " " + e.getType() + " key=" + e.getKey() + " name=" + e.getName()
                    + " parent=" + e.getParentKey());
        }
        for (int i = 0; i < Math.min(0, elems.size()); i++) {
            ElementInfo e = elems.get(i);
            p("  元素 " + e.getCategory() + " " + e.getType() + " key=" + e.getKey() + " name=" + e.getName()
                    + " parent=" + e.getParentKey());
        }

        List<String> keys = new ArrayList<String>();
        String given = env("SPIKE_ELEM", "");
        if (!given.isEmpty()) keys.addAll(Arrays.asList(given.split(",")));
        else {
            if (firstField != null) keys.add(firstField);
            if (firstContainer != null) keys.add(firstContainer);
        }
        for (String key : keys) {
            long t3 = System.currentTimeMillis();
            List<PropertySchema> schema = MetaPropertyService.getPropertySchema(form, key.trim());
            p("耗时 属性清单 " + key + " " + (System.currentTimeMillis() - t3) + "ms  共 " + (schema == null ? 0 : schema.size()) + " 项");
            if (schema == null) continue;
            Map<String, Integer> byComplexity = new LinkedHashMap<String, Integer>();
            for (PropertySchema s : schema) {
                String c = s.getComplexity() + (s.isEditable() ? "" : "(只读)");
                byComplexity.put(c, byComplexity.containsKey(c) ? byComplexity.get(c) + 1 : 1);
            }
            p("  按复杂度 " + byComplexity);
            for (PropertySchema s : schema) {
                p("  属性 [" + s.getGroupName() + "] " + s.getPropertyName() + " 「" + s.getDisplayName() + "」 编辑器="
                        + s.getEditorType() + " 复杂度=" + s.getComplexity() + " 可改=" + s.isEditable() + " 当前="
                        + head(String.valueOf(s.getCurrentValue()), 80) + " 默认=" + head(String.valueOf(s.getDefaultValue()), 40)
                        + (s.getOptions() == null || s.getOptions().isEmpty() ? "" : " 选项=" + head(String.valueOf(s.getOptions()), 160))
                        + (s.getConstraints() == null || s.getConstraints().isEmpty() ? "" : " 约束=" + s.getConstraints()));
            }
            p("  getProperties(全部)=" + head(String.valueOf(MetaPropertyService.getProperties(form, key.trim(), null)), 1500));
        }

        long t4 = System.currentTimeMillis();
        OperationListResult ops = MetaOperationService.listOperations(form);
        p("耗时 操作清单 " + (System.currentTimeMillis() - t4) + "ms  " + head(om.writeValueAsString(ops), 1500));

        String move = env("SPIKE_MOVE", "");
        if (!move.isEmpty()) {
            String[] mv = move.split(">");
            MetaOp op = new MetaOp();
            op.setOp(MetaOp.OpType.move);
            op.setTarget(new MetaTarget(MetaTarget.TreeType.form, MetaTarget.ElementType.control, MetaTarget.LocateBy.key, mv[0].trim()));
            Map<String, Object> v = new LinkedHashMap<String, Object>();
            v.put("destination", mv[1].trim());
            v.put("index", 0);
            op.setExtra(v);
            SessionContext sc = new SessionContext("spike");
            sc.setFormId(formId);
            long t5 = System.currentTimeMillis();
            MetaOpsResult.PreviewResult pr = new MetaOpsPreview(b, new MetaOpsFinder(), om).preview(Arrays.asList(op), sc);
            p("耗时 预览 " + (System.currentTimeMillis() - t5) + "ms  valid=" + pr.isValid() + " errors=" + pr.getErrors()
                    + " warnings=" + pr.getWarnings());
            if (pr.getGroups() != null) {
                for (PreviewGroup g : pr.getGroups()) {
                    p("  预览组 " + g.getGroupLabel() + " 摘要=" + g.getSummary() + " 风险=" + g.getRisks() + " diff=" + head(g.getDiff(), 800));
                }
            }
        }
        if ("1".equals(env("SPIKE_BAD", ""))) {
            SessionContext sc = new SessionContext("spike-bad");
            sc.setFormId(formId);
            MetaOp bad1 = new MetaOp();
            bad1.setOp(MetaOp.OpType.move);
            bad1.setTarget(new MetaTarget(MetaTarget.TreeType.form, MetaTarget.ElementType.control, MetaTarget.LocateBy.key, "zlgd_wtdh"));
            Map<String, Object> x1 = new LinkedHashMap<String, Object>();
            x1.put("destination", "no_such_panel");
            bad1.setExtra(x1);
            MetaOp bad2 = new MetaOp();
            bad2.setOp(MetaOp.OpType.modify);
            bad2.setTarget(new MetaTarget(MetaTarget.TreeType.form, MetaTarget.ElementType.control, MetaTarget.LocateBy.key, "fs_baseinfo"));
            bad2.setPath("backColor");
            bad2.setValue("#f0f0f0");
            MetaOp bad3 = new MetaOp();
            bad3.setOp(MetaOp.OpType.modify);
            bad3.setTarget(new MetaTarget(MetaTarget.TreeType.form, MetaTarget.ElementType.control, MetaTarget.LocateBy.key, "no_such_ctl"));
            bad3.setPath("name");
            bad3.setValue("x");
            MetaOpsPreview pv = new MetaOpsPreview(b, new MetaOpsFinder(), om);
            for (MetaOp op : Arrays.asList(bad1, bad2, bad3)) {
                MetaOpsResult.PreviewResult pr = pv.preview(Arrays.asList(op), sc);
                p("坏操作预览 " + op.getOp() + " " + op.getTarget().getValue() + " path=" + op.getPath() + " valid=" + pr.isValid()
                        + " errors=" + pr.getErrors() + " warnings=" + pr.getWarnings()
                        + (pr.getGroups() == null || pr.getGroups().isEmpty() ? "" : " 风险=" + pr.getGroups().get(0).getRisks()));
            }
        }
        p("本探针只读，不做任何写入");
        System.out.println("[PROBE-OK] FormMetaSpike");
    }

    private static String tree(ObjectMapper om, SchemaContextBuilder b, String kind, String id, String number) {
        for (String arg : new String[]{id, number}) {
            try {
                Map<String, Object> m = "model".equals(kind) ? b.buildModelTree(arg) : b.buildFormLayoutTree(arg);
                String json = om.writeValueAsString(m);
                p(kind + " 树 用参数 " + arg + " 成功");
                if (json != null && json.length() > 20) return json;
            } catch (Exception e) {
                p(kind + " 树 用参数 " + arg + " 异常 " + e);
            }
        }
        return null;
    }

    private static int bytes(String s) throws Exception {
        return s == null ? 0 : s.getBytes("UTF-8").length;
    }

    private static String head(String s, int n) {
        if (s == null) return "null";
        return s.length() <= n ? s : s.substring(0, n) + "…(共" + s.length() + "字符)";
    }

    private static void p(String s) {
        System.out.println("[PROBE] " + s);
    }

    private static String env(String k, String def) {
        String v = System.getenv(k);
        return v == null || v.isEmpty() ? def : v;
    }
}
