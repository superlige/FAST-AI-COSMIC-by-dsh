import java.lang.reflect.Array;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import kd.bos.form.control.Control;
import kd.bos.metadata.entity.rule.BizRuleAction;
import kd.bos.metadata.form.ControlAp;
import kd.bos.metadata.form.FormMetadata;
import kd.bos.metadata.form.rule.FormRule;
import kd.bos.mvc.form.FormView;

/**
 * 不是探针，是 FormSim 的共用类：**界面状态表**——跑完之后，每个控件（分录的话到行）显示没有、能不能改、是不是必录，是谁定的。
 *
 * 界面状态只在浏览器里：插件调 setVisible / setEnable / setMustInput，平台只是往「这次要发给浏览器的指令」里加一条，
 * 浏览器把元数据里的设置、界面规则推来的动作、插件发来的指令叠在一起，才是用户看到的样子，后台不存结论。
 * 所以这里把记账代理收到的指令按发出的先后重放一遍：
 * <ol>
 * <li>底子：元数据里的可见性、锁定性按页面状态换算（和平台自己的 isHide / checkEditFieldStatus 同一套位），
 *     设计器里勾了「隐藏」的直接算隐藏；页面状态取平台最后一次发的 setFormStatus。</li>
 * <li>指令：插件和平台发的 setVisible / setEnable / updateControlMetadata、分录的 setVisibleState / setLockState /
 *     setMustInputState、rowlock、setColEditorProp，界面规则的动作，按先后叠，后发的为准。</li>
 * <li>连带：面板、分录、整行隐藏或锁定时，里面的控件跟着算。</li>
 * </ol>
 * 同一个控件被规则和插件都改过时，浏览器里谁先生效平台没有明说，这里按后台发出的先后算，每条结论带上是谁定的。
 *
 * 路径写法和 run rule form 一样：{@code 控件.visible} / {@code 字段.enabled} / {@code 字段.mustInput}，
 * 分录某一格 {@code 分录[行].字段.enabled}，整列 {@code 分录.字段.visible}，整行锁定 {@code 分录[行].enabled}。
 */
public final class UiState {

    private UiState() {
    }

    /** 能断言的三个属性。 */
    static final List<String> PROPS = Arrays.asList("visible", "enabled", "mustInput");

    /**
     * 一条改显示、锁定、必录的指令。row = -1 表示不分行（表头控件、整列）。
     * wholeRow：分录整行锁定（rowlock），key 是分录标识——和「给分录本身的指令」分开，否则锁一行会算成锁整个分录。
     */
    static final class Directive {
        final String key;
        final int row;
        final String prop;
        final boolean value;
        final String by;
        final boolean wholeRow;

        Directive(String key, int row, String prop, boolean value, String by, boolean wholeRow) {
            this.key = key;
            this.row = row;
            this.prop = prop;
            this.value = value;
            this.by = by;
            this.wholeRow = wholeRow;
        }
    }

    /** 一条结论：值和定它的来源。 */
    static final class Verdict {
        final Boolean value;
        final String by;

        Verdict(Boolean value, String by) {
            this.value = value;
            this.by = by;
        }
    }

    static final List<Directive> DIRECTIVES = new ArrayList<Directive>();
    /**
     * 用单头写法 setEnable 给了分录字段的：{分录.字段, 谁发的}。
     *
     * 官方表单插件指南：单头写法用在分录字段上不报错也不生效。平台源码和这个说法对得上——
     * AbstractFormView.setVisible 遇到分录字段会转成整列指令（setVisibleState），setEnable 不转，原样按单头发出去。
     * 浏览器那一端这里验不了，按不生效算，单独列出来。
     */
    static final List<String[]> IGNORED = new ArrayList<String[]>();
    /** 平台最后一次发给浏览器的页面状态（setFormStatus），没发过是 null。 */
    static Integer formStatus;
    static String formStatusBy;
    static FormView view;
    /** 规则动作 id → {属性, 值, 规则说明, 目标控件…}；第一次用到时按当前布局建。 */
    static Map<String, String[]> ruleIndex;
    static Map<String, ControlAp<?>> apByKey;
    static Map<String, ControlAp<?>> apById;

    static void reset() {
        DIRECTIVES.clear();
        IGNORED.clear();
        formStatus = null;
        formStatusBy = null;
        ruleIndex = null;
        apByKey = null;
        apById = null;
    }

    static int size() {
        return DIRECTIVES.size();
    }

    /** 这次调用会不会改显示、锁定、必录或页面状态——只为这些去取调用栈找来源。 */
    static boolean relevant(String m, Object[] a) {
        if ("addAction".equals(m)) {
            String act = a == null || a.length == 0 ? "" : String.valueOf(a[0]);
            return "setVisible".equals(act) || "setEnable".equals(act) || "updateControlMetadata".equals(act)
                    || "setFormStatus".equals(act);
        }
        return "setVisibleState".equals(m) || "setLockState".equals(m) || "setMustInputState".equals(m)
                || "invokeControlMethod".equals(m) || "setFieldProperty".equals(m);
    }

    /**
     * 记账代理收到一条发往浏览器的调用。不是改显示、锁定、必录的忽略。
     *
     * @param by 谁发的：插件类名.方法，或「平台」
     */
    @SuppressWarnings("unchecked")
    static void record(String m, Object[] a, String by) {
        if (a == null || a.length == 0) {
            return;
        }
        if ("addAction".equals(m) && a.length >= 2) {
            String act = String.valueOf(a[0]);
            if (("setFormStatus".equals(act) || "setBillStatus".equals(act)) && a[1] instanceof Number) {
                formStatus = Integer.valueOf(((Number) a[1]).intValue());
                formStatusBy = by;
            } else if (("setVisible".equals(act) || "setEnable".equals(act)) && a[1] instanceof Map) {
                Map<String, Object> p = (Map<String, Object>) a[1];
                boolean visible = "setVisible".equals(act);
                Object v = p.get(visible ? "visible" : "enable");
                for (Object k : items(p.get("keys"))) {
                    String key = String.valueOf(k);
                    if (!visible && entryOf(key) != null) {
                        IGNORED.add(new String[]{entryOf(key) + "." + key, by});
                    } else {
                        add(key, -1, visible ? "visible" : "enabled", v, by);
                    }
                }
            } else if ("updateControlMetadata".equals(act)) {
                List<Object> p = items(a[1]);
                if (p.size() >= 2 && p.get(1) instanceof Map) {
                    Map<String, Object> meta = (Map<String, Object>) p.get(1);
                    add(String.valueOf(p.get(0)), -1, "mustInput", meta.get("mi"), by);
                }
            }
            return;
        }
        if (("setVisibleState".equals(m) || "setLockState".equals(m) || "setMustInputState".equals(m))
                && a.length >= 2 && a[1] instanceof Map) {
            Map<String, Object> p = (Map<String, Object>) a[1];
            int row = p.get("r") instanceof Number ? ((Number) p.get("r")).intValue() : -1;
            String prop = "setVisibleState".equals(m) ? "visible" : "setLockState".equals(m) ? "enabled" : "mustInput";
            //setLockState 的 l 存的是「能不能改」：FieldEdit.setEnable 原样把 enable 放进 l
            Object v = p.get("setVisibleState".equals(m) ? "vi" : "setLockState".equals(m) ? "l" : "mi");
            for (Object k : items(p.get("k"))) {
                add(String.valueOf(k), row, prop, v, by);
            }
            return;
        }
        if ("invokeControlMethod".equals(m) && a.length >= 3) {
            String control = String.valueOf(a[0]);
            String method = String.valueOf(a[1]);
            List<Object> params = items(a[2]);
            if ("setColEditorProp".equals(method) && params.size() >= 3 && "mi".equals(String.valueOf(params.get(1)))) {
                add(String.valueOf(params.get(0)), -1, "mustInput", params.get(2), by);
            } else if ("rowlock".equals(method) && !params.isEmpty() && params.get(0) instanceof Map) {
                Map<String, Object> p = (Map<String, Object>) params.get(0);
                Object locked = p.get("l");
                if (locked instanceof Boolean) {
                    for (Object r : items(p.get("r"))) {
                        if (r instanceof Number) {
                            add(control, ((Number) r).intValue(), "enabled", Boolean.valueOf(!((Boolean) locked)), by, true);
                        }
                    }
                }
            }
            return;
        }
        if ("setFieldProperty".equals(m) && a.length >= 3) {
            String p = String.valueOf(a[1]);
            String prop = "vi".equals(p) ? "visible" : "en".equals(p) ? "enabled" : "mi".equals(p) ? "mustInput" : null;
            if (prop != null) {
                add(String.valueOf(a[0]), -1, prop, a[2], by);
            }
        }
    }

    /** 界面规则推给浏览器的动作：actionId + 行号。只认改显示、锁定的动作，按规则本体解回控件。 */
    static void ruleAction(String actionId, int row) {
        String[] r = rules().get(actionId);
        if (r == null) {
            return;
        }
        for (int i = 3; i < r.length; i++) {
            add(r[i], row, r[0], Boolean.valueOf(r[1]), r[2]);
        }
    }

    private static void add(String key, int row, String prop, Object value, String by) {
        add(key, row, prop, value, by, false);
    }

    private static void add(String key, int row, String prop, Object value, String by, boolean wholeRow) {
        if (!(value instanceof Boolean) || key == null || key.isEmpty() || "null".equals(key)) {
            return;
        }
        DIRECTIVES.add(new Directive(key, row, prop, ((Boolean) value).booleanValue(), by, wholeRow));
    }

    /** 数组、集合、单个值统一成列表（keys 有时是 String[]、有时是 Object[]、有时是 List）。 */
    static List<Object> items(Object o) {
        List<Object> out = new ArrayList<Object>();
        if (o == null) {
            return out;
        }
        if (o instanceof Collection) {
            out.addAll((Collection<?>) o);
        } else if (o.getClass().isArray()) {
            for (int i = 0; i < Array.getLength(o); i++) {
                out.add(Array.get(o, i));
            }
        } else {
            out.add(o);
        }
        return out;
    }

    // ---------- 布局 ----------

    private static void layout() {
        if (apByKey != null) {
            return;
        }
        apByKey = new HashMap<String, ControlAp<?>>();
        apById = new HashMap<String, ControlAp<?>>();
        try {
            FormMetadata fm = FormSim.formMeta();
            apById.putAll(RuleSim.controls(fm));
            for (ControlAp<?> ap : apById.values()) {
                //同一个 key 在 getItems() 里可能出现两次（根控件再出现一次），留第一次
                if (ap.getKey() != null && !apByKey.containsKey(ap.getKey())) {
                    apByKey.put(ap.getKey(), ap);
                }
            }
        } catch (Throwable t) {
            System.out.println("[PROBE] ⚠ 读布局失败，界面状态只按指令算，不带底子和连带：" + FormSim.brief(t));
        }
    }

    private static Map<String, String[]> rules() {
        if (ruleIndex != null) {
            return ruleIndex;
        }
        ruleIndex = new HashMap<String, String[]>();
        layout();
        for (ControlAp<?> host : apById.values()) {
            List<FormRule> rs = RuleSim.formRules(host);
            if (rs == null) {
                continue;
            }
            for (FormRule r : rs) {
                indexRule(host, r, "条件成立", r.getTrueActions());
                indexRule(host, r, "条件不成立", r.getFalseActions());
            }
        }
        return ruleIndex;
    }

    @SuppressWarnings("rawtypes")
    private static void indexRule(ControlAp<?> host, FormRule r, String branch, List acts) {
        if (acts == null) {
            return;
        }
        for (Object o : acts) {
            BizRuleAction act = (BizRuleAction) o;
            String[] ax = RuleSim.axis(act);
            if (ax == null) {
                continue;
            }
            List<String> out = new ArrayList<String>();
            out.add(ax[0]);
            out.add(ax[1]);
            out.add("界面规则 seq=" + r.getSeq() + " " + branch + "（挂在 " + host.getKey() + "）");
            for (String id : RuleSim.fieldIds(act)) {
                ControlAp<?> ap = apById.get(id);
                if (ap != null) {
                    out.add(ap.getKey());
                }
            }
            ruleIndex.put(act.getId(), out.toArray(new String[0]));
        }
    }

    /** 这张布局上有没有这个控件。布局读不出来时一律当有，不拿它拦人。 */
    static boolean has(String key) {
        layout();
        return apByKey.isEmpty() || apByKey.containsKey(key);
    }

    /** 界面路径在这张布局上找不找得到：找得到返回 null，找不到说清是哪一段。 */
    static String problem(String path) {
        Target t = target(path);
        if (t == null) {
            return "写法不对";
        }
        layout();
        if (apByKey.isEmpty()) {
            return null;
        }
        String form = "布局 " + FormSim.FORM;
        if (t.wholeRow || t.entry != null) {
            if (!isEntry(t.entry)) {
                return form + " 上没有分录 " + t.entry;
            }
            if (t.wholeRow) {
                return null;
            }
            String e = entryOf(t.key);
            return t.entry.equals(e) ? null
                    : e == null ? "分录 " + t.entry + " 上没有字段 " + t.key
                    : t.key + " 在分录 " + e + " 上，不在 " + t.entry;
        }
        return apByKey.containsKey(t.key) ? null : form + " 上没有控件 " + t.key;
    }

    /** 往上的容器链（不含自己、不含根）。 */
    private static List<ControlAp<?>> ancestors(String key) {
        layout();
        List<ControlAp<?>> out = new ArrayList<ControlAp<?>>();
        ControlAp<?> ap = apByKey.get(key);
        Set<String> seen = new LinkedHashSet<String>();
        for (int guard = 0; ap != null && guard < 50; guard++) {
            Object pid = ap.getParentId();
            ControlAp<?> parent = pid == null ? null : apById.get(String.valueOf(pid));
            if (parent == null || !seen.add(String.valueOf(pid)) || parent.getParentId() == null
                    || String.valueOf(parent.getParentId()).trim().isEmpty()) {
                break;
            }
            out.add(parent);
            ap = parent;
        }
        return out;
    }

    /** 分录字段所在的分录；不是分录字段返回 null。 */
    static String entryOf(String key) {
        layout();
        for (ControlAp<?> a : ancestors(key)) {
            if ("EntryAp".equals(a.getClass().getSimpleName()) || a.getClass().getSimpleName().endsWith("EntryAp")) {
                return a.getKey();
            }
        }
        return null;
    }

    // ---------- 页面状态和底子 ----------

    /**
     * 页面状态：平台最后一次发给浏览器的那个（setFormStatus / setBillStatus），浏览器按它判锁定，
     * 平台自己判字段能不能改（FieldEdit.checkEditFieldStatus）也先查它。0 新增 1 修改 2 查看 4 已提交 5 已审核。
     *
     * 谁发的都算：平台打开单据时（从列表打开已提交的单就按已提交开）、单据模板插件绑定数据后、
     * 操作成功后平台按单据状态重发、插件自己调 setStatus / setBillStatus。
     * 一次都没发过时照平台的退路：有单据状态字段按数据里的单据状态（A 新增、B 已提交、C 已审核），没有按打开参数。
     */
    static int status() {
        if (formStatus != null) {
            return formStatus.intValue();
        }
        if (view == null) {
            return 0;
        }
        String data = billStatus();
        if ("A".equals(data) || "B".equals(data) || "C".equals(data)) {
            return "A".equals(data) ? 0 : "B".equals(data) ? 4 : 5;
        }
        return view.getFormShowParameter().getStatusValue();
    }

    /** 数据里的单据状态（A 暂存 / B 已提交 / C 已审核）；不是单据或没有单据状态字段返回 null。 */
    static String billStatus() {
        String key = billStatusKey();
        try {
            return key == null || view == null ? null : String.valueOf(view.getModel().getValue(key));
        } catch (Throwable t) {
            return null;
        }
    }

    static String billStatusKey() {
        if (!(FormSim.MET instanceof kd.bos.entity.BillEntityType)) {
            return null;
        }
        String key = ((kd.bos.entity.BillEntityType) FormSim.MET).getBillStatus();
        return key == null || key.isEmpty() ? null : key;
    }

    /** 页面状态是怎么定的，一句话。 */
    static String statusSource() {
        if (formStatus == null) {
            String data = billStatus();
            if ("A".equals(data) || "B".equals(data) || "C".equals(data)) {
                return "没发过页面状态，按单据状态 " + billStatusKey() + "=" + data + " 算，平台判字段能不能改时就这么退回";
            }
            return "没发过页面状态，按打开参数";
        }
        return "平台".equals(formStatusBy) ? "平台发的" : formStatusBy + " 设的";
    }

    static String statusName(int s) {
        return s == 0 ? "新增" : s == 1 ? "修改" : s == 2 ? "查看" : s == 4 ? "已提交" : s == 5 ? "已审核" : "状态" + s;
    }

    /** 状态在可见性、锁定性位掩码里对应的那一位：和平台 AbstractFormView.isHide 同一套。 */
    private static int bit(int s) {
        return s == 0 ? 1 : s == 1 ? 2 : s == 2 ? 4 : s == 4 ? 16 : s == 5 ? 32 : 0;
    }

    private static Control control(String key) {
        if (view == null) {
            return null;
        }
        try {
            Object c = view.getControl(key);
            return c instanceof Control ? (Control) c : null;
        } catch (Throwable t) {
            return null;
        }
    }

    private static String setting(String key, String getter) {
        layout();
        ControlAp<?> ap = apByKey.get(key);
        Object v = ap == null ? null : HeadlessUiSupport.call(ap, getter);
        return v == null ? "" : String.valueOf(v);
    }

    /**
     * 界面路径指的字段，设计态布局上有、打开后的视图里却没有控件时，说明为什么判不了；别的情况返回 null。
     *
     * 视图按布局的运行态建控件，运行态是每张布局各存一份的合并结果（见 RuntimeMeta）。主单据布局加了字段、
     * 派生布局的运行态没重建，设计态有这个字段、运行态没有，打开派生布局就没有这个控件。
     * 这时底子取不到，不能按「默认」答显示、可编辑——真机 zlgd 两张派生布局上隐藏又锁定的字段，就是这样被判成显示、可编辑。
     * 运行态是新的时，设计器里「隐藏元素」的字段照样有控件（isInvisible=true），不会落到这里。
     */
    static String notInRuntime(String path) {
        Target t = target(path);
        if (t == null || t.wholeRow || view == null) {
            return null;
        }
        layout();
        ControlAp<?> ap = apByKey.get(t.key);
        if (ap == null || !ap.getClass().getSimpleName().endsWith("FieldAp") || control(t.key) != null) {
            return null;
        }
        return "布局 " + FormSim.FORM + " 的设计态有字段 " + t.key + "，运行态里没有这个控件：这张布局的运行态比设计态旧，"
                + "打开它也没有这个字段，显示、锁定判不了；重建这张布局的运行态后再验";
    }

    /** 元数据底子：不看任何指令时这个控件是什么样。不适用（比如按钮的必录）返回 value=null。 */
    static Verdict base(String key, String prop) {
        int s = status();
        Control c = control(key);
        if ("visible".equals(prop)) {
            if (c != null && c.isInvisible()) {
                return new Verdict(Boolean.FALSE, "设计器里设了隐藏");
            }
            Integer vis = c == null ? null : c.getVisibleIntegerVal();
            int v = vis == null ? 63 : vis.intValue();
            if ((v & 8) == 0) {
                String set = setting(key, "getVisible");
                return new Verdict(Boolean.FALSE, "可见性没勾初始化" + (set.isEmpty() ? "" : "（" + set + "）"));
            }
            if (bit(s) != 0 && (v & bit(s)) == 0) {
                return new Verdict(Boolean.FALSE, "可见性 " + setting(key, "getVisible") + " 不含" + statusName(s));
            }
            return new Verdict(Boolean.TRUE, "默认");
        }
        if ("enabled".equals(prop)) {
            if (s == 2) {
                return new Verdict(Boolean.FALSE, "查看状态整张单不能改");
            }
            Integer lock = c == null ? null : c.getLockIntegerVal();
            if (lock != null && bit(s) != 0 && (lock.intValue() & bit(s)) != 0) {
                return new Verdict(Boolean.FALSE, "锁定性 " + setting(key, "getLock") + " 含" + statusName(s));
            }
            return new Verdict(Boolean.TRUE, "默认");
        }
        Object field = HeadlessUiSupport.call(c, "getProperty");
        Object mi = field == null ? null : HeadlessUiSupport.call(field, "isMustInput");
        if (!(mi instanceof Boolean)) {
            return new Verdict(null, "不是字段");
        }
        return new Verdict((Boolean) mi, ((Boolean) mi).booleanValue() ? "字段设了必录" : "默认");
    }

    // ---------- 求值 ----------

    /** 路径：控件 / 分录.字段 / 分录[行].字段 / 分录[行]。 */
    static final Pattern PATH = Pattern.compile("^([A-Za-z0-9_]+)(?:\\[(\\d+)\\])?(?:\\.([A-Za-z0-9_]+))?$");

    static final class Target {
        final String entry;
        final int row;
        final String key;
        final boolean wholeRow;

        Target(String entry, int row, String key, boolean wholeRow) {
            this.entry = entry;
            this.row = row;
            this.key = key;
            this.wholeRow = wholeRow;
        }

        public String toString() {
            if (wholeRow) {
                return entry + "[" + row + "]";
            }
            if (entry == null) {
                return key;
            }
            return row < 0 ? entry + "." + key : entry + "[" + row + "]." + key;
        }
    }

    /** 解析不了返回 null。 */
    static Target target(String path) {
        Matcher m = PATH.matcher(path.trim());
        if (!m.matches()) {
            return null;
        }
        String head = m.group(1);
        String idx = m.group(2);
        String tail = m.group(3);
        if (tail == null) {
            return idx == null ? new Target(null, -1, head, false) : new Target(head, Integer.parseInt(idx), head, true);
        }
        return new Target(head, idx == null ? -1 : Integer.parseInt(idx), tail, false);
    }

    /** 自己这一层：底子 + 指令（后发的为准），不看容器。 */
    private static Verdict own(Target t, String prop) {
        Verdict v = t.wholeRow ? new Verdict(Boolean.TRUE, "默认") : base(t.key, prop);
        for (Directive d : DIRECTIVES) {
            if (!d.prop.equals(prop)) {
                continue;
            }
            boolean hit;
            if (t.wholeRow) {
                hit = d.wholeRow && d.key.equals(t.entry) && d.row == t.row;
            } else if (t.entry == null) {
                //表头控件不分行：界面规则推给表头的动作也带行号（0 或 -1），照样算
                hit = !d.wholeRow && d.key.equals(t.key);
            } else {
                //整列的指令（不分行）对每一行都算；某一行的只算那一行
                hit = !d.wholeRow && d.key.equals(t.key) && (d.row < 0 || d.row == t.row);
            }
            if (hit) {
                v = new Verdict(Boolean.valueOf(d.value), d.by);
            }
        }
        return v;
    }

    /** 最终结论：自己这一层，再叠上整列、整行和外面的容器（只管显示和锁定，必录不连带）。 */
    static Verdict judge(Target t, String prop) {
        Verdict v = own(t, prop);
        if ("mustInput".equals(prop) || v.value == null || !v.value.booleanValue()) {
            return v;
        }
        String word = "visible".equals(prop) ? "隐藏" : "锁定";
        //整列的指令已经在 own 里按先后叠进这一格了，这里只看整行锁定
        if (t.entry != null && !t.wholeRow && t.row >= 0 && "enabled".equals(prop)) {
            Verdict row = own(new Target(t.entry, t.row, t.entry, true), prop);
            if (!row.value.booleanValue()) {
                return new Verdict(Boolean.FALSE, "整行锁定（" + row.by + "）");
            }
        }
        String start = t.wholeRow ? t.entry : t.key;
        if (t.wholeRow) {
            Verdict grid = own(new Target(null, -1, t.entry, false), prop);
            if (grid.value != null && !grid.value.booleanValue()) {
                return new Verdict(Boolean.FALSE, "分录 " + t.entry + " " + word + "（" + grid.by + "）");
            }
        }
        for (ControlAp<?> a : ancestors(start)) {
            Verdict up = own(new Target(null, -1, a.getKey(), false), prop);
            if (up.value != null && !up.value.booleanValue()) {
                return new Verdict(Boolean.FALSE, "所在的 " + a.getKey() + " " + word + "（" + up.by + "）");
            }
        }
        return v;
    }

    /** 给尺子和断言用：路径 + 属性 → "true" / "false"；解析不了或不适用返回 null。 */
    static String value(String path, String prop) {
        Target t = target(path);
        if (t == null || !PROPS.contains(prop) || notInRuntime(path) != null) {
            return null;
        }
        if (t.entry == null && !t.wholeRow) {
            String e = entryOf(t.key);
            if (e != null) {
                //只给了分录字段标识：按整列算
                t = new Target(e, -1, t.key, false);
            }
        }
        Verdict v = judge(t, prop);
        return v.value == null ? null : String.valueOf(v.value);
    }

    // ---------- 输出 ----------

    /** 这次被指令碰过的「控件 + 属性」，按第一次出现的先后。 */
    private static Map<String, Object[]> touched() {
        Map<String, Object[]> out = new LinkedHashMap<String, Object[]>();
        for (Directive d : DIRECTIVES) {
            Target t;
            if (d.wholeRow) {
                t = new Target(d.key, d.row, d.key, true);
            } else {
                String e = entryOf(d.key);
                t = e == null ? new Target(null, -1, d.key, false) : new Target(e, d.row, d.key, false);
            }
            out.put(t + "|" + d.prop, new Object[]{t, d.prop});
        }
        return out;
    }

    private static boolean isEntry(String key) {
        layout();
        ControlAp<?> ap = apByKey.get(key);
        return ap != null && ap.getClass().getSimpleName().endsWith("EntryAp");
    }

    static String yn(Boolean b) {
        return b == null ? "-" : b.booleanValue() ? "是" : "否";
    }

    static String word(String prop) {
        return "visible".equals(prop) ? "显示" : "enabled".equals(prop) ? "可编辑" : "必录";
    }

    /**
     * 打「界面状态」一段：只列和元数据底子不一样的，以及 named 点名的（--show / --expect 里的界面路径）。
     * 面板、分录这类容器变了，里面的控件跟着变，只列容器本身，不逐个展开。
     */
    static void dump(Collection<String> named) {
        int s = status();
        //按「谁定的 + 改成了什么」归组：同一条规则常常一次管十几个控件，分录上每一行又各来一遍，
        //逐条列会把一张单拉到上百行。分录同一列的多行并成 分录[0,1].字段
        Map<String, Map<String, List<Integer>>> groups = new LinkedHashMap<String, Map<String, List<Integer>>>();
        int count = 0;
        for (Object[] one : touched().values()) {
            Target t = (Target) one[0];
            String prop = (String) one[1];
            Verdict now = judge(t, prop);
            Verdict was = t.wholeRow ? new Verdict(Boolean.TRUE, "默认") : base(t.key, prop);
            if (now.value == null || now.value.equals(was.value)) {
                continue;
            }
            count++;
            String head = word(prop) + " " + yn(now.value) + " ← " + now.by;
            Map<String, List<Integer>> g = groups.get(head);
            if (g == null) {
                g = new LinkedHashMap<String, List<Integer>>();
                groups.put(head, g);
            }
            String name = t.row < 0 ? t.toString() : t.wholeRow ? t.entry + "[]" : t.entry + "[]." + t.key;
            List<Integer> rows = g.get(name);
            if (rows == null) {
                rows = new ArrayList<Integer>();
                g.put(name, rows);
            }
            if (t.row >= 0) {
                rows.add(Integer.valueOf(t.row));
            }
        }
        System.out.println("[PROBE] --- 界面状态：页面状态 " + statusName(s) + "（" + statusSource() + "）"
                + "；跑完和元数据里本来不一样的 " + count + " 处，下面写的是跑完的样子 ---");
        for (Map.Entry<String, Map<String, List<Integer>>> g : groups.entrySet()) {
            StringBuilder b = new StringBuilder();
            for (Map.Entry<String, List<Integer>> e : g.getValue().entrySet()) {
                String rows = e.getValue().toString().replace(" ", "");
                b.append(b.length() == 0 ? "" : "、")
                        .append(e.getValue().isEmpty() ? e.getKey() : e.getKey().replace("[]", rows));
            }
            System.out.println("[PROBE]   " + g.getKey() + "：" + b);
        }
        if (!IGNORED.isEmpty()) {
            Map<String, List<String>> byWho = new LinkedHashMap<String, List<String>>();
            for (String[] one : IGNORED) {
                List<String> keys = byWho.get(one[1]);
                if (keys == null) {
                    keys = new ArrayList<String>();
                    byWho.put(one[1], keys);
                }
                if (!keys.contains(one[0])) {
                    keys.add(one[0]);
                }
            }
            for (Map.Entry<String, List<String>> e : byWho.entrySet()) {
                System.out.println("[PROBE]   ⚠ 单头写法 setEnable 给了分录字段，浏览器里不生效，这里按没改算 ← " + e.getKey()
                        + "：" + String.join("、", e.getValue()));
            }
        }
        if (named == null || named.isEmpty()) {
            return;
        }
        System.out.println("[PROBE]   点名的控件：");
        for (String path : named) {
            Target t = target(path);
            if (t == null) {
                continue;
            }
            if (t.entry == null && !t.wholeRow && entryOf(t.key) != null) {
                t = new Target(entryOf(t.key), -1, t.key, false);
            }
            if (notInRuntime(path) != null) {
                System.out.println("[PROBE]     " + t + "  运行态里没有这个控件（设计态有），显示、锁定判不了");
                continue;
            }
            StringBuilder b = new StringBuilder();
            for (String prop : PROPS) {
                if (t.wholeRow && !"enabled".equals(prop)) {
                    continue;
                }
                Verdict v = judge(t, prop);
                if (v.value == null) {
                    continue;
                }
                b.append(b.length() == 0 ? "" : " · ").append(word(prop)).append(" ").append(yn(v.value))
                        .append("默认".equals(v.by) ? "" : "（" + v.by + "）");
            }
            System.out.println("[PROBE]     " + t + "  " + b);
        }
    }
}
