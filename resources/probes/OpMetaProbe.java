import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import kd.bos.metadata.Plugin;
import kd.bos.metadata.dao.MetaCategory;
import kd.bos.metadata.dao.MetadataDao;
import kd.bos.metadata.entity.EntityItem;
import kd.bos.metadata.entity.EntityMetadata;
import kd.bos.metadata.form.ControlAp;
import kd.bos.metadata.form.FormMetadata;

/**
 * 只读：单据的操作、校验、单据状态项，和按工具栏分组、接上操作的按钮。
 *
 * MetaProbe / DesignMetaProbe 只看字段，这些看不到；操作插件绑在操作上、不在布局上，FormPluginProbe 也查不到。
 * 同一个单据模板派生出来的单据，继承来的操作和按钮 id 一致。
 *
 *   OP_ENTITY=实体标识（逗号分隔多个，必填）
 *   OP_FOCUS=tbmain,bar_save,audit  只看这些工具栏、按钮、操作：绑的操作、插件、校验，和界面插件源码里用到它们的行
 */
public class OpMetaProbe {

    static final class Op {
        String key;
        String name;
        String type;
        String id;
        final List<String[]> plugins = new ArrayList<String[]>();
        /** 类名、说明、enabled、id */
        final List<String[]> checks = new ArrayList<String[]>();
    }

    static final class Bar {
        String key;
        String name;
        String op;
        String visible;
        String hidden;
        String id;
        String parentId;
        int index;
        boolean dropdown;
        boolean isSwitch;
        final List<Bar> items = new ArrayList<Bar>();
    }

    static final class Toolbar {
        String key;
        String name;
        String id;
        /** bill / list */
        String side;
        /** 工具栏所在的容器，「在 x 名称 里」；找不到为空串。 */
        String where = "";
        final List<Bar> buttons = new ArrayList<Bar>();
    }

    public static void run() throws Exception {
        List<String> focus = new ArrayList<String>();
        for (String k : env("OP_FOCUS", "").split(",")) {
            if (!k.trim().isEmpty()) focus.add(k.trim());
        }
        for (String entity : req("OP_ENTITY", "要查的实体标识，逗号分隔可给多个").split(",")) {
            entity = entity.trim();
            if (entity.isEmpty()) {
                continue;
            }
            //入参可能是布局标识，MetaResolve 会换算成实体再取设计态 id
            String id = MetaResolve.designId(entity);
            EntityMetadata em = (EntityMetadata) MetadataDao.readMeta(id, MetaCategory.Entity);
            FormMetadata fm = (FormMetadata) MetadataDao.readMeta(id, MetaCategory.Form);
            //打 em.getKey() 而不是入参：入参可能是布局标识，打出来会误导
            ProbeJson.emit("op-entity", "entity", em.getKey(), "input", entity);
            System.out.println("[PROBE] ======== " + em.getKey() + "  id=" + id
                    + "  继承自 " + em.getParentId());

            Map<String, Op> ops = new LinkedHashMap<String, Op>();
            for (EntityItem<?> item : em.getItems()) {
                Object list = call(item, "getOperations");
                if (list instanceof List) {
                    for (Object o : (List<?>) list) {
                        Op op = op(o);
                        ops.put(op.key, op);
                    }
                }
            }
            //列表布局不是独立的元数据，是塞在 BillFormAp 里的一份 FormMetadata
            Object listMeta = call(fm.getRootAp(), "getListMeta");
            FormMetadata lm = listMeta instanceof FormMetadata ? (FormMetadata) listMeta : null;
            List<Toolbar> bars = toolbars("bill", fm.getItems());
            if (lm != null) bars.addAll(toolbars("list", lm.getItems()));

            if (focus.isEmpty()) {
                full(em, ops, bars, lm != null);
            } else {
                focused(focus, ops, bars, fm, lm);
            }
        }
        System.out.println("[PROBE] 本探针只读，不做任何写入");
    }

    // ---------- 全列 ----------

    static void full(EntityMetadata em, Map<String, Op> ops, List<Toolbar> bars, boolean hasList) {
        System.out.println("[PROBE] --- 操作 共 " + ops.size());
        for (Op op : ops.values()) {
            ProbeJson.emit("op", "entity", em.getKey(), "op", op.key, "type", op.type);
            System.out.println("[PROBE]   " + op.key + "  " + op.name + "  type=" + op.type + "  id=" + op.id);
            for (String[] p : op.plugins) {
                //机器可读的这一份给 cosmic_run 的前检用：它要回答「这个插件在不在这次要跑的那个操作上」，
                //而不是「登记在不在这张单上」。
                ProbeJson.emit("op-plugin", "entity", em.getKey(), "op", op.key, "class", p[0],
                        "enabled", !"false".equals(p[1]));
                System.out.println("[PROBE]      插件 " + p[0] + "  enabled=" + p[1]);
            }
            for (String[] c : op.checks) {
                System.out.println("[PROBE]      校验 " + c[0] + "  " + c[1] + "  enabled=" + c[2] + "  id=" + c[3]);
            }
        }
        for (EntityItem<?> item : em.getItems()) {
            if ("billstatus".equals(item.getKey())) {
                System.out.println("[PROBE] --- 单据状态  默认值=" + call(item, "getDefValue"));
                Object sis = call(item, "getStatusItems");
                if (sis instanceof List) {
                    for (Object si : (List<?>) sis) {
                        System.out.println("[PROBE]   " + call(si, "getStatusKey")
                                + " = " + call(si, "getStatusName")
                                + "   （StatusItem id=" + call(si, "getId") + "）");
                    }
                }
            }
        }
        side(em.getKey(), "bill", "单据工具栏", ops, bars);
        if (hasList) {
            side(em.getKey(), "list", "列表工具栏", ops, bars);
        } else {
            System.out.println("[PROBE] --- 没有 ListMeta（不是单据？）");
        }
    }

    static void side(String entity, String side, String title, Map<String, Op> ops, List<Toolbar> bars) {
        int toolbars = 0;
        int buttons = 0;
        for (Toolbar t : bars) {
            if (!t.side.equals(side)) continue;
            toolbars++;
            buttons += t.buttons.size();
        }
        System.out.println("[PROBE] --- " + title + "  " + toolbars + " 个工具栏、" + buttons + " 个按钮");
        for (Toolbar t : bars) {
            if (!t.side.equals(side)) continue;
            System.out.println("[PROBE]   " + head(t));
            for (Bar b : t.buttons) {
                ProbeJson.emit("bar", "entity", entity, "side", side, "key", b.key, "op", b.op);
                System.out.println("[PROBE]     " + b.key + "  " + b.name + "  op=" + b.op + opNote(b.op, ops)
                        + "  visible=[" + b.visible + "]  隐藏=" + b.hidden + "  id=" + b.id);
                for (Bar d : b.items) {
                    ProbeJson.emit("bar", "entity", entity, "side", side, "key", d.key, "op", d.op);
                    System.out.println("[PROBE]         下拉项 " + d.key + "  " + d.name + "  op=" + d.op + opNote(d.op, ops)
                            + "  visible=[" + d.visible + "]  切换=" + d.isSwitch + "  id=" + d.id);
                }
            }
        }
    }

    static String head(Toolbar t) {
        String where = t.where.isEmpty() ? "" : "  " + t.where;
        return "── " + t.key + "  " + t.name + where + "  " + t.buttons.size() + " 个按钮";
    }

    /** 按钮行上接的操作：名称和类型；操作清单里没有、或者没绑操作，照实说。 */
    static String opNote(String key, Map<String, Op> ops) {
        if (!bound(key)) return "（没绑操作）";
        Op op = ops.get(key);
        return op == null ? "（操作清单里没有）" : "（" + op.name + " type=" + op.type + "）";
    }

    static boolean bound(String key) {
        return key != null && !key.isEmpty() && !"null".equals(key) && !"-".equals(key);
    }

    // ---------- 只看点名的 ----------

    static void focused(List<String> focus, Map<String, Op> ops, List<Toolbar> bars,
                        FormMetadata fm, FormMetadata lm) {
        Set<String> keys = new LinkedHashSet<String>();
        List<String> missing = new ArrayList<String>();
        Set<Toolbar> shownBars = new LinkedHashSet<Toolbar>();
        for (String k : focus) {
            boolean hit = false;
            for (Toolbar t : bars) {
                if (t.key.equalsIgnoreCase(k)) {
                    hit = true;
                    System.out.println("[PROBE] " + head(t) + "（" + sideName(t.side) + "）");
                    for (Bar b : t.buttons) button(b, ops, keys, "  ", "");
                    shownBars.add(t);
                }
            }
            if (hit) continue;
            for (Toolbar t : bars) {
                for (Bar b : t.buttons) {
                    Bar match = b.key.equalsIgnoreCase(k) ? b : null;
                    for (Bar d : b.items) {
                        if (d.key.equalsIgnoreCase(k)) match = d;
                    }
                    if (match == null) continue;
                    hit = true;
                    if (shownBars.add(t)) System.out.println("[PROBE] " + head(t) + "（" + sideName(t.side) + "）");
                    button(match, ops, keys, "  ", match.dropdown ? "下拉项 " : "");
                }
            }
            if (hit) continue;
            Op op = ops.get(k);
            if (op == null) {
                for (Op o : ops.values()) {
                    if (o.key.equalsIgnoreCase(k)) op = o;
                }
            }
            if (op == null) {
                missing.add(k);
                continue;
            }
            System.out.println("[PROBE] ── 操作 " + op.key + "  " + op.name + "  type=" + op.type);
            opDetail(op, "   ");
            keys.add(op.key);
            List<String> boundBy = new ArrayList<String>();
            for (Toolbar t : bars) {
                for (Bar b : t.buttons) {
                    String at = sideName(t.side) + " " + t.key + (t.where.isEmpty() ? "" : "，" + t.where);
                    if (op.key.equals(b.op)) boundBy.add(b.key + " " + b.name + "（" + at + "）");
                    for (Bar d : b.items) {
                        if (op.key.equals(d.op)) boundBy.add(d.key + " " + d.name + "（" + at + "，" + b.key + " 的下拉项）");
                    }
                }
            }
            System.out.println("[PROBE]    绑它的按钮："
                    + (boundBy.isEmpty() ? "没有" : String.join("、", boundBy)));
        }
        if (!missing.isEmpty()) {
            System.out.println("[PROBE] OP_FOCUS 里这几个不是这张单的工具栏、按钮或操作：" + String.join("、", missing));
        }
        if (!keys.isEmpty()) uses(keys, fm, lm);
    }

    static String sideName(String side) {
        return "list".equals(side) ? "列表界面" : "单据界面";
    }

    /**
     * 一个按钮和它绑的操作。只看点名的这一份要一次放得下，所以比全列省：操作名和按钮名一样不重复，
     * 所有状态都显示的不列 visible，插件和校验只标停用的，不带 id。
     */
    static void button(Bar b, Map<String, Op> ops, Set<String> keys, String indent, String label) {
        keys.add(b.key);
        String state = (ALL_STATES.equals(b.visible) ? "" : "  visible=[" + b.visible + "]")
                + ("true".equals(b.hidden) ? "  隐藏" : "");
        String head = "[PROBE] " + indent + label + b.key + "  " + b.name + "  → ";
        if (!bound(b.op)) {
            System.out.println(head + "没绑操作" + state);
        } else {
            keys.add(b.op);
            Op op = ops.get(b.op);
            if (op == null) {
                System.out.println(head + b.op + "（操作清单里没有）" + state);
            } else {
                System.out.println(head + op.key + (op.name.equals(b.name) ? "" : "  " + op.name)
                        + "  type=" + op.type + state);
                opDetail(op, indent + "   ");
            }
        }
        for (Bar d : b.items) button(d, ops, keys, indent + "   ", "下拉项 ");
    }

    static final String ALL_STATES = "init,new,edit,view,submit,audit";

    static void opDetail(Op op, String indent) {
        for (String[] p : op.plugins) {
            System.out.println("[PROBE] " + indent + "插件 " + p[0] + ("false".equals(p[1]) ? "  停用" : ""));
        }
        for (String[] c : op.checks) {
            System.out.println("[PROBE] " + indent + "校验 " + c[0] + "  " + c[1] + ("false".equals(c[2]) ? "  停用" : ""));
        }
    }

    /**
     * 界面插件（单据界面和列表界面上登记的）源码里用到这些按钮、操作标识的行。
     * 按钮点击（itemClick）比的是按钮标识，操作前后（beforeDoOperation、afterDoOperation）比的是操作标识，两样都找。
     */
    static void uses(Set<String> keys, FormMetadata fm, FormMetadata lm) {
        List<String> classes = new ArrayList<String>();
        int bill = plugins(fm, classes);
        int list = lm == null ? 0 : plugins(lm, classes);
        List<String> notHere = new ArrayList<String>();
        for (String cls : classes) {
            if (ProjectSources.of(cls) == null) notHere.add(cls);
        }
        List<String> unreadable = new ArrayList<String>();
        List<ProjectSources.Use> found = ProjectSources.uses(classes, keys, unreadable);
        System.out.println("[PROBE] ── 界面插件源码里用到这些标识的行（单据界面插件 " + bill + " 个、列表界面插件 " + list
                + " 个，按本工程源码查）");
        for (ProjectSources.Use u : found) {
            System.out.println("[PROBE]   " + u.path + ":" + u.line + "  " + (u.method == null ? "" : u.method + "  ") + u.key);
        }
        if (found.isEmpty()) System.out.println("[PROBE]   没有");
        if (!notHere.isEmpty()) {
            System.out.println("[PROBE]   源码不在本工程、没查的 " + notHere.size() + " 个：" + String.join("、", notHere));
        }
        if (!unreadable.isEmpty()) System.out.println("[PROBE]   读不了的源码：" + String.join("、", unreadable));
    }

    static int plugins(FormMetadata meta, List<String> out) {
        List<Plugin> plugins = meta.getRootAp() == null ? null : meta.getRootAp().getPlugins();
        if (plugins == null) return 0;
        int n = 0;
        for (Plugin p : plugins) {
            if (p.getClassName() == null || out.contains(p.getClassName())) continue;
            out.add(p.getClassName());
            n++;
        }
        return n;
    }

    // ---------- 读元数据 ----------

    static Op op(Object o) {
        Op op = new Op();
        op.key = String.valueOf(call(o, "getKey"));
        op.name = String.valueOf(call(o, "getName"));
        op.type = String.valueOf(call(o, "getOperationType"));
        op.id = String.valueOf(call(o, "getId"));
        Object pls = call(o, "getPlugins");
        if (pls instanceof List) {
            for (Object p : (List<?>) pls) {
                op.plugins.add(new String[] {String.valueOf(call(p, "getClassName")), String.valueOf(call(p, "isEnabled"))});
            }
        }
        Object vs = call(o, "getValidations");
        if (vs instanceof List) {
            for (Object v : (List<?>) vs) {
                //Validation 上是 getEnabled()，没有 isEnabled()
                op.checks.add(new String[] {v.getClass().getSimpleName(), String.valueOf(call(v, "getDescription")),
                        String.valueOf(call(v, "getEnabled")), String.valueOf(call(v, "getId"))});
            }
        }
        return op;
    }

    /** 按父容器把按钮归到工具栏下；工具栏按布局里出现的先后，按钮按设计器里的序号。 */
    static List<Toolbar> toolbars(String side, List<? extends ControlAp<?>> items) {
        Map<String, ControlAp<?>> byId = new HashMap<String, ControlAp<?>>();
        for (ControlAp<?> ap : items) byId.put(ap.getId(), ap);
        Map<String, Toolbar> bars = new LinkedHashMap<String, Toolbar>();
        List<Bar> loose = new ArrayList<Bar>();
        for (ControlAp<?> ap : items) {
            String cls = ap.getClass().getSimpleName();
            if (cls.contains("Toolbar")) {
                Toolbar t = bars.get(ap.getId());
                if (t == null) bars.put(ap.getId(), t = new Toolbar());
                t.key = ap.getKey();
                t.name = String.valueOf(ap.getName());
                t.id = ap.getId();
                t.side = side;
                ControlAp<?> parent = byId.get(String.valueOf(call(ap, "getParentId")));
                if (parent != null) t.where = "在 " + parent.getKey() + " " + parent.getName() + " 里";
            }
        }
        for (ControlAp<?> ap : items) {
            if (!ap.getClass().getSimpleName().contains("BarItem")) continue;
            Bar b = bar(ap);
            Toolbar t = bars.get(b.parentId);
            if (t == null) loose.add(b);
            else t.buttons.add(b);
        }
        List<Toolbar> out = new ArrayList<Toolbar>(bars.values());
        for (Toolbar t : out) Collections.sort(t.buttons, BY_INDEX);
        if (!loose.isEmpty()) {
            Toolbar t = new Toolbar();
            t.key = "（不在工具栏里）";
            t.name = "";
            t.id = "";
            t.side = side;
            t.buttons.addAll(loose);
            out.add(t);
        }
        return out;
    }

    static final Comparator<Bar> BY_INDEX = new Comparator<Bar>() {
        public int compare(Bar a, Bar b) {
            return Integer.compare(a.index, b.index);
        }
    };

    static Bar bar(ControlAp<?> ap) {
        Bar b = new Bar();
        b.key = ap.getKey();
        b.name = String.valueOf(ap.getName());
        b.op = String.valueOf(call(ap, "getOperationKey"));
        b.visible = String.valueOf(call(ap, "getVisible"));
        b.hidden = String.valueOf(call(ap, "isInvisible"));
        b.id = ap.getId();
        b.parentId = String.valueOf(call(ap, "getParentId"));
        Object index = call(ap, "getIndex");
        b.index = index instanceof Integer ? (Integer) index : Integer.MAX_VALUE;
        Object dds = call(ap, "getDropdownItems");
        if (dds instanceof List) {
            for (Object dd : (List<?>) dds) {
                Bar d = new Bar();
                d.dropdown = true;
                d.key = String.valueOf(call(dd, "getKey"));
                d.name = String.valueOf(call(dd, "getTitle"));
                d.op = String.valueOf(call(dd, "getOperationKey"));
                d.visible = String.valueOf(call(dd, "getVisible"));
                d.isSwitch = Boolean.TRUE.equals(call(dd, "getIsSwitch"));
                d.id = String.valueOf(call(dd, "getId"));
                b.items.add(d);
            }
        }
        return b;
    }

    private static Object call(Object o, String method) {
        try {
            Method m = o.getClass().getMethod(method);
            return m.invoke(o);
        } catch (NoSuchMethodException e) {
            return "-";
        } catch (Exception e) {
            return "?" + e.getClass().getSimpleName();
        }
    }

    /**
     * 必填的环境变量。没给就打用法后中止 —— 与其塞一个默认标识让人跑出「元数据不存在」
     * （那跟标识拼错、跟账套选错长得一模一样），不如直接说清楚该填什么。
     * 抛异常而不是 System.exit()：后者会带走常驻探针 JVM。
     */
    private static String req(String k, String what) {
        String v = System.getenv(k);
        if (v != null && !v.trim().isEmpty()) {
            return v.trim();
        }
        System.out.println("[PROBE] 缺必填参数 " + k + " —— " + what);
        System.out.println("[PROBE] 用法: OP_ENTITY=<实体标识> node .claude/skills/long-cosmic-dev/driver.mjs probe OpMetaProbe");
        System.out.println("[PROBE] 不知道填什么：本工程的标识一律 <isv>_ 开头，isv 见 driver.mjs doctor");
        throw new IllegalArgumentException(k + " 未设置");
    }

    private static String env(String k, String def) {
        String v = System.getenv(k);
        return v == null || v.isEmpty() ? def : v;
    }
}
