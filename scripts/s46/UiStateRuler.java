import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;

import kd.bos.bill.OperationStatus;
import kd.bos.context.RequestContext;
import kd.bos.dataentity.metadata.IDataEntityType;
import kd.bos.form.control.EntryGrid;
import kd.bos.form.field.FieldEdit;
import kd.bos.metadata.form.ControlAp;
import kd.bos.mvc.form.FormController;
import kd.bos.mvc.form.FormView;
import kd.bos.mvc.form.IFormController;

/**
 * S46 的尺子（只读、只在内存开表单，不落库）：插件常用的改界面写法，验证工具收没收到、报没报出来、断言能不能判。
 *
 * 跑法见 scripts/measure-ui-state.ts。和 FormSim 一起编译，开表单走 FormSim.openView，
 * 所以量到的是仓库里这一版 FormSim 的本事。
 *
 *   RULER_FORM   布局标识
 *   RULER_ENTRY  分录标识（不给就取布局里第一个分录）
 *   RULER_FIELD  分录字段（不给就取那个分录的第一个字段）
 *   RULER_PK     给了就先量一段「平台按状态判字段能不能改」（FieldEdit.checkEditFieldStatus），
 *                和 FormSim 自己算的对一遍
 *
 * 每种写法打一行 `[RULER] case|编号|写法|控件|收到=n|报出=值|应为=值|断言=…`：
 *   收到   这一次调用之后，记账代理多记了几条发往浏览器的调用（0 就是漏了）
 *   报出   FormSim.uiValue(路径, 属性) 给的结论；FormSim 还没有这个入口时，看旧的「插件改的界面属性」有没有多出条目，
 *          多了记「?」（报了，但对不对判不了），没多记「-」
 *   断言   FormSim.expectUi("路径.属性=应为") 的结果 PASS / FAIL；没有这个入口或判不了记「-」
 * 两个入口都按名字反射取：改之前没有就记 0，改之后同一把尺子直接复量。
 */
public class UiStateRuler {

    static String target;

    public static void run() throws Exception {
        String form = env("RULER_FORM", "zlgd_qty_wtd");
        String pk = env("RULER_PK", "");
        if (!pk.isEmpty()) {
            statusTruth(form, pk);
        }
        matrix(form);
    }

    // ---------- 一、各层控件 × 改界面的写法 ----------

    static void matrix(String form) throws Exception {
        FormView view = open(form, "");
        String header = null;
        String panel = null;
        String tab = null;
        String button = null;
        String entry = env("RULER_ENTRY", "");
        List<String> entryFields = new ArrayList<String>();
        String want = env("RULER_FIELD", "");
        for (ControlAp<?> ap : FormSim.formMeta().getItems()) {
            String cls = ap.getClass().getSimpleName();
            if (entry.isEmpty() && "EntryAp".equals(cls)) {
                entry = ap.getKey();
            }
        }
        IDataEntityType rowType = entry.isEmpty() ? null : ExpectSpec.itemType(FormSim.MET, entry);
        for (ControlAp<?> ap : FormSim.formMeta().getItems()) {
            String k = ap.getKey();
            String cls = ap.getClass().getSimpleName();
            if ("FieldAp".equals(cls) && header == null && FormSim.MET.getProperties().containsKey(k)
                    && !"billno".equals(k)) {
                header = k;
            }
            if (panel == null && "FieldsetPanelAp".equals(cls)) {
                panel = k;
            }
            if (tab == null && "TabPageAp".equals(cls)) {
                tab = k;
            }
            if (button == null && "BarItemAp".equals(cls)) {
                button = k;
            }
            if ("EntryFieldAp".equals(cls) && rowType != null && rowType.getProperties().containsKey(k)) {
                if (k.equals(want)) {
                    entryFields.add(0, k);
                } else {
                    entryFields.add(k);
                }
            }
        }
        if (panel == null) {
            for (ControlAp<?> ap : FormSim.formMeta().getItems()) {
                if ("FlexPanelAp".equals(ap.getClass().getSimpleName()) && ap.getKey().startsWith("fs_")) {
                    panel = ap.getKey();
                    break;
                }
            }
        }
        String f1 = entryFields.size() > 0 ? entryFields.get(0) : null;
        String f2 = entryFields.size() > 1 ? entryFields.get(1) : f1;
        System.out.println("[RULER] sample|form=" + form + "|header=" + header + "|panel=" + panel + "|tab=" + tab
                + "|button=" + button + "|entry=" + entry + "|column=" + f1 + "|cell=" + f2);
        if (entry != null && !entry.isEmpty()) {
            while (view.getModel().getEntryRowCount(entry) < 2) {
                view.getModel().createNewEntryRow(entry);
            }
        }
        final String h = header;
        final String p = panel;
        final String t = tab;
        final String b = button;
        final String e = entry;
        final String c1 = f1;
        final String c2 = f2;
        //顺序有讲究：每种写法做完当场量，管得大的（整个分录、面板）放后面，免得连带改了前面要量的结论
        one(view, 1, "表头字段 隐藏", h, h, "visible", "false", v -> v.setVisible(false, h));
        one(view, 2, "表头字段 锁定", h, h, "enabled", "false", v -> v.setEnable(false, h));
        one(view, 3, "表头字段 必录", h, h, "mustInput", "true", v -> ((FieldEdit) v.getControl(h)).setMustInput(true));
        one(view, 4, "分录某行某格 锁定", c2, e + "[0]." + c2, "enabled", "false", v -> v.setEnable(false, 0, c2));
        one(view, 5, "分录某行某格 解锁", c2, e + "[0]." + c2, "enabled", "true", v -> v.setEnable(true, 0, c2));
        one(view, 6, "分录一整列 锁定", c1, e + "." + c1, "enabled", "false", v -> v.setEnable(false, -1, c1));
        one(view, 7, "分录一整列 隐藏", c1, e + "." + c1, "visible", "false", v -> v.setVisible(false, c1));
        one(view, 8, "分录一整列 必录", c1, e + "." + c1, "mustInput", "true",
                v -> ((FieldEdit) v.getControl(c1)).setMustInput(true));
        //单头写法给分录字段：官方指南说不生效，应为「和调用前一样」（UiState.IGNORED）。编号排在最后、跑在整个分录锁定之前
        one(view, 18, "分录一整列 锁定（单头写法）", c2, e + "." + c2, "enabled", SAME, v -> v.setEnable(false, c2));
        one(view, 9, "分录整行 锁定", e, e + "[1]", "enabled", "false",
                v -> ((EntryGrid) v.getControl(e)).setRowLock(true, new int[]{1}));
        one(view, 10, "整个分录 隐藏", e, e, "visible", "false", v -> v.setVisible(false, e));
        one(view, 11, "整个分录 锁定", e, e, "enabled", "false", v -> v.setEnable(false, e));
        one(view, 12, "字段分组面板 隐藏", p, p, "visible", "false", v -> v.setVisible(false, p));
        one(view, 13, "字段分组面板 锁定", p, p, "enabled", "false", v -> v.setEnable(false, p));
        one(view, 14, "工具栏按钮 隐藏", b, b, "visible", "false", v -> v.setVisible(false, b));
        one(view, 15, "工具栏按钮 锁定", b, b, "enabled", "false", v -> v.setEnable(false, b));
        one(view, 16, "页签 隐藏", t, t, "visible", "false", v -> v.setVisible(false, t));
        one(view, 17, "页签 锁定", t, t, "enabled", "false", v -> v.setEnable(false, t));
    }

    interface Api {
        void go(FormView v);
    }

    /** 应为「和调用前一样」：这种写法不该改变结论。调用前工具报不出来时这一项判不了。 */
    static final String SAME = "(调用前的值)";

    static void one(FormView view, int no, String label, String control, String path, String prop, String want, Api api) {
        if (control == null || control.isEmpty()) {
            System.out.println("[RULER] case|" + no + "|" + label + "|(这张布局没有)|skip");
            return;
        }
        if (SAME.equals(want)) {
            Method before = hook(FormSim.class, "uiValue", String.class, String.class);
            Object v = before == null ? null : invoke(before, path, prop);
            want = v == null ? "?" : String.valueOf(v);
        }
        int calls = FormSim.CALLS.size();
        int ui = oldUiCount();
        try {
            api.go(view);
        } catch (Throwable t) {
            System.out.println("[RULER] case|" + no + "|" + label + "|" + control + "|error=" + FormSim.brief(t));
            return;
        }
        int got = FormSim.CALLS.size() - calls;
        String reported;
        Method uiValue = hook(FormSim.class, "uiValue", String.class, String.class);
        if (uiValue != null) {
            Object v = invoke(uiValue, path, prop);
            reported = v == null ? "-" : String.valueOf(v);
        } else {
            reported = oldUiCount() > ui ? "?" : "-";
        }
        String judged = "-";
        Method expect = hook(FormSim.class, "expectUi", String.class);
        if (expect != null) {
            Object v = invoke(expect, path + "." + prop + "=" + want);
            judged = v == null ? "-" : Boolean.TRUE.equals(v) ? "PASS" : "FAIL";
        }
        System.out.println("[RULER] case|" + no + "|" + label + "|" + path + "|收到=" + got + "|报出=" + reported
                + "|应为=" + prop + "=" + want + "|断言=" + judged);
        for (int i = calls; i < FormSim.CALLS.size(); i++) {
            System.out.println("[RULER]   " + oneLine(FormSim.CALLS.get(i)));
        }
    }

    // ---------- 二、平台按状态判字段能不能改 ----------

    /**
     * 平台自己的结论（FieldEdit.checkEditFieldStatus）当标准答案。FormSim 有 uiValue 时，
     * 把视图摆成同一个状态再问它一遍，对不上的标出来。
     */
    static void statusTruth(String form, String pk) throws Exception {
        FormView view = open(form, pk);
        List<String> keys = new ArrayList<String>();
        for (ControlAp<?> ap : FormSim.formMeta().getItems()) {
            String k = ap.getKey();
            if (!"FieldAp".equals(ap.getClass().getSimpleName()) || !FormSim.MET.getProperties().containsKey(k)) {
                continue;
            }
            Object lock = FormSim.call(ap, "getLock");
            if ((lock != null && !String.valueOf(lock).isEmpty() && keys.size() < 6) || "billno".equals(k)) {
                keys.add(k);
            }
        }
        Method uiValue = hook(FormSim.class, "uiValue", String.class, String.class);
        //单据状态字段按实体自己登记的取：单据一般叫 billstatus，基础资料叫 status
        Object entityType = view.getModel().getDataEntityType();
        String statusKey = entityType instanceof kd.bos.entity.BillEntityType
                ? ((kd.bos.entity.BillEntityType) entityType).getBillStatus() : null;
        Object billStatus = null;
        try {
            billStatus = statusKey == null || statusKey.isEmpty() ? null : view.getModel().getValue(statusKey);
        } catch (Throwable ignore) {
            //没有这个字段就不报
        }
        System.out.println("[RULER] status-sample|form=" + form + "|pk=" + pk + "|" + statusKey + "=" + billStatus);
        OperationStatus original = view.getFormShowParameter().getStatus();
        for (String k : keys) {
            Object c = view.getControl(k);
            if (!(c instanceof FieldEdit)) {
                continue;
            }
            StringBuilder sb = new StringBuilder();
            for (ControlAp<?> ap : FormSim.formMeta().getItems()) {
                if (k.equals(ap.getKey())) {
                    sb.append("|lock=").append(FormSim.call(ap, "getLock"));
                }
            }
            for (OperationStatus st : OperationStatus.values()) {
                view.setStatus(st);
                boolean truth = ((FieldEdit) c).checkEditFieldStatus();
                sb.append("|").append(st).append("=").append(truth);
                if (uiValue != null) {
                    Object mine = invoke(uiValue, k, "enabled");
                    sb.append("/工具=").append(mine == null ? "-" : mine)
                            .append(mine != null && String.valueOf(truth).equals(String.valueOf(mine)) ? "" : "≠");
                }
            }
            System.out.println("[RULER] status|" + k + sb);
        }
        view.setStatus(original);
    }

    // ---------- 小工具 ----------

    /** 和 FormSim.run 前半段同样的步骤：开视图、activate、registerListener，新增建空单、有 pk 走 loadData。 */
    static FormView open(String form, String pk) {
        FormSim.resetState();
        FormSim.resolveTarget(form);
        RequestContext.get().setGlobalSessionId("ruler-" + System.nanoTime());
        FormView view = FormSim.openView(form, pk, !pk.isEmpty(), "");
        view.activate();
        view.getRootControl();
        FormController ctl = (FormController) view.getService(IFormController.class);
        try {
            ctl.registerListener();
        } catch (Throwable t) {
            System.out.println("[RULER] note|registerListener 失败 " + FormSim.brief(t));
        }
        try {
            if (pk.isEmpty()) {
                view.getModel().createNewData();
            } else {
                ctl.loadData();
            }
        } catch (Throwable t) {
            System.out.println("[RULER] note|打开时报错 " + FormSim.brief(t));
        }
        return view;
    }

    /** 旧版 FormSim 的「插件改的界面属性」条数；新版没有这个字段，记 0。 */
    static int oldUiCount() {
        try {
            java.lang.reflect.Field f = FormSim.class.getDeclaredField("UI_STATE");
            f.setAccessible(true);
            return ((java.util.Map<?, ?>) f.get(null)).size();
        } catch (Throwable t) {
            return 0;
        }
    }

    static Method hook(Class<?> type, String name, Class<?>... params) {
        try {
            Method m = type.getDeclaredMethod(name, params);
            m.setAccessible(true);
            return m;
        } catch (NoSuchMethodException e) {
            return null;
        }
    }

    static Object invoke(Method m, Object... args) {
        try {
            return m.invoke(null, args);
        } catch (Throwable t) {
            System.out.println("[RULER] note|" + m.getName() + " 抛异常 " + FormSim.brief(t));
            return null;
        }
    }

    static String oneLine(String s) {
        String v = s.replace("\r", " ").replace("\n", " ");
        return v.length() > 300 ? v.substring(0, 300) + "…" : v;
    }

    static String env(String k, String dft) {
        String v = System.getenv(k);
        return v == null || v.trim().isEmpty() ? dft : v.trim();
    }
}
