import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import kd.bos.print.api.utils.SerializeUtils;

/**
 * 两份打印模板设计数据的差异，由程序算出来（S32 1.2）。
 *
 * 为什么不让模型转述：用户在确认单上看到的「改了什么」必须是比出来的事实。
 * S23 已经给改数据定过这条规矩（原值新值由探针报），整份提交同样照办——
 * 提交的是一整份 JSON，模型说"我只改了一格"和实际改了什么之间没有任何约束，
 * 只有程序比对能给出真话。
 *
 * 两条不能丢的规矩，和 TS 那边的 `src/kernel/meta/diff.ts` 一致：
 *   1. **数组按元素里的 id/key 对齐，不按下标。** 插一个控件会把后面每个下标都顶掉，
 *      按下标比会报出「几十个控件变了」，真正变的那个反而看不见。
 *   2. **只报叶子值的变化和整枝的增删。** 新增一枝是一行，不是底下每个字段一行。
 *
 * 另外按控件算一份人话摘要（新增/删除/公式/绑定/其它），因为路径清单回答不了
 * 「这次到底动了几个控件、动的是什么性质的东西」。
 */
public final class PrintTplDiff {

    private PrintTplDiff() {
    }

    /** 一处差异：在哪（path）、属于哪个控件（owner）、从什么变成什么。 */
    public static final class Change {
        public final String path;
        public final String owner;
        public final String from;
        public final String to;

        Change(String path, String owner, String from, String to) {
            this.path = path;
            this.owner = owner;
            this.from = from;
            this.to = to;
        }

        public String toString() {
            return (owner == null ? "" : owner + " ") + (path.isEmpty() ? "(根)" : path) + "  " + from + "  ->  " + to;
        }
    }

    /** 按控件算的摘要，给人看的那一句。 */
    public static final class Summary {
        public final List<String> added = new ArrayList<String>();
        public final List<String> removed = new ArrayList<String>();
        public final List<String> formula = new ArrayList<String>();
        public final List<String> binding = new ArrayList<String>();
        public final List<String> other = new ArrayList<String>();
        /** 不属于任何控件的改动（纸张、页数、模板自身属性） */
        public final List<String> root = new ArrayList<String>();

        public int total() {
            return added.size() + removed.size() + formula.size() + binding.size() + other.size() + root.size();
        }

        /** 一行人话：「新增 1 个表格、2 个单元格；3 处公式变化」这种。 */
        public String oneLine() {
            List<String> parts = new ArrayList<String>();
            if (!added.isEmpty()) parts.add("新增 " + added.size() + " 个控件");
            if (!removed.isEmpty()) parts.add("删除 " + removed.size() + " 个控件");
            if (!formula.isEmpty()) parts.add(formula.size() + " 处公式变化");
            if (!binding.isEmpty()) parts.add(binding.size() + " 处绑定变化");
            if (!other.isEmpty()) parts.add(other.size() + " 处属性变化");
            if (!root.isEmpty()) parts.add(root.size() + " 处模板级变化");
            return parts.isEmpty() ? "没有差异" : join(parts, "，");
        }
    }

    // ── 摘要 ────────────────────────────────────────────────────────────

    /**
     * 按控件对齐算摘要。控件取的是 `pages` 底下那张扁平表——苍穹的页就是一张平表，
     * 父子靠控件自己的 `parentId` 指，不是嵌套（S32 批 0 实测）。
     */
    public static Summary summarize(Map<String, Object> before, Map<String, Object> after) {
        Summary out = new Summary();
        Map<String, Map<String, Object>> a = byId(before);
        Map<String, Map<String, Object>> b = byId(after);

        for (Map.Entry<String, Map<String, Object>> entry : a.entrySet()) {
            if (!b.containsKey(entry.getKey())) out.removed.add(label(entry.getValue()));
        }
        for (Map.Entry<String, Map<String, Object>> entry : b.entrySet()) {
            if (!a.containsKey(entry.getKey())) out.added.add(label(entry.getValue()));
        }
        for (Map.Entry<String, Map<String, Object>> entry : a.entrySet()) {
            Map<String, Object> other = b.get(entry.getKey());
            if (other == null) continue;
            Map<String, Object> one = entry.getValue();
            if (json(one).equals(json(other))) continue;
            if (!json(one.get("formulaData")).equals(json(other.get("formulaData")))) {
                out.formula.add(label(one));
            } else if (!json(one.get("bindField")).equals(json(other.get("bindField")))
                    || !json(one.get("dataSource")).equals(json(other.get("dataSource")))
                    || !json(one.get("dsType")).equals(json(other.get("dsType")))) {
                out.binding.add(label(one));
            } else {
                out.other.add(label(one));
            }
        }

        // 模板级：除 pages 以外的顶层键
        Set<String> keys = new LinkedHashSet<String>();
        keys.addAll(before.keySet());
        keys.addAll(after.keySet());
        for (String key : keys) {
            if ("pages".equals(key)) continue;
            if (!json(before.get(key)).equals(json(after.get(key)))) out.root.add(key);
        }
        return out;
    }

    // ── 逐处差异 ────────────────────────────────────────────────────────

    public static List<Change> diff(Object before, Object after) {
        List<Change> out = new ArrayList<Change>();
        walk(before, after, "", null, out);
        return out;
    }

    private static void walk(Object a, Object b, String path, String owner, List<Change> out) {
        if (a == b) return;
        String label = first(label(a), label(b), owner);
        String ka = kind(a);
        String kb = kind(b);
        if (!ka.equals(kb)) {
            out.add(new Change(path, label, brief(a), brief(b)));
            return;
        }
        if ("array".equals(ka)) {
            walkArray(list(a), list(b), path, label, out);
            return;
        }
        if ("object".equals(ka)) {
            Map<String, Object> ma = map(a);
            Map<String, Object> mb = map(b);
            for (String key : ma.keySet()) {
                if (!mb.containsKey(key)) {
                    out.add(new Change(path + "." + key, label, brief(ma.get(key)), "(删除)"));
                    continue;
                }
                //公式整条当一个值比：它是个片段数组，里面的文字片段没有 id，按下标对齐会把
                //「改了一条公式」报成十几条「第 7 格从 X 变成 Y」，人读不出改了什么。
                if ("formulaData".equals(key)) {
                    if (!json(ma.get(key)).equals(json(mb.get(key)))) {
                        out.add(new Change(path + ".formulaData", label,
                                formulaText(ma.get(key)), formulaText(mb.get(key))));
                    }
                    continue;
                }
                //模板上登记的打印插件也整条当一个值比：它是一段塞在字符串里的 JSON 数组，照原文打出来
                //超过长度就截断，偏偏截掉的是类名 —— 确认单上要回答的是「登记了哪几个插件」。
                if ("plugins".equals(key) && path.isEmpty()) {
                    if (!json(ma.get(key)).equals(json(mb.get(key)))) {
                        out.add(new Change(".plugins", label, pluginsText(ma.get(key)), pluginsText(mb.get(key))));
                    }
                    continue;
                }
                walk(ma.get(key), mb.get(key), path + "." + key, label, out);
            }
            for (String key : mb.keySet()) {
                if (!ma.containsKey(key)) out.add(new Change(path + "." + key, label, "(无)", brief(mb.get(key))));
            }
            return;
        }
        if (!String.valueOf(a).equals(String.valueOf(b))) out.add(new Change(path, label, brief(a), brief(b)));
    }

    private static void walkArray(List<?> a, List<?> b, String path, String owner, List<Change> out) {
        List<String> ka = idsOf(a);
        List<String> kb = idsOf(b);
        if (keyed(ka) && keyed(kb)) {
            Map<String, Object> byKey = new LinkedHashMap<String, Object>();
            for (int i = 0; i < b.size(); i++) byKey.put(kb.get(i), b.get(i));
            Set<String> seen = new LinkedHashSet<String>();
            for (int i = 0; i < a.size(); i++) {
                String key = ka.get(i);
                seen.add(key);
                Object other = byKey.get(key);
                if (other != null) walk(a.get(i), other, path + "[" + key + "]", first(label(a.get(i)), owner), out);
                else out.add(new Change(path + "[" + key + "]", first(label(a.get(i)), owner),
                        brief(a.get(i)), "(删除)"));
            }
            for (int i = 0; i < b.size(); i++) {
                if (!seen.contains(kb.get(i))) {
                    out.add(new Change(path + "[" + kb.get(i) + "]", first(label(b.get(i)), owner),
                            "(无)", brief(b.get(i))));
                }
            }
            return;
        }
        int n = Math.max(a.size(), b.size());
        for (int i = 0; i < n; i++) {
            if (i >= a.size()) out.add(new Change(path + "[" + i + "]", owner, "(无)", brief(b.get(i))));
            else if (i >= b.size()) out.add(new Change(path + "[" + i + "]", owner, brief(a.get(i)), "(删除)"));
            else walk(a.get(i), b.get(i), path + "[" + i + "]", owner, out);
        }
    }

    /** 数组能不能按 id 对齐：每个元素都有 id/key，而且互不重复。 */
    private static boolean keyed(List<String> ids) {
        if (ids.isEmpty()) return false;
        Set<String> seen = new LinkedHashSet<String>();
        for (String id : ids) {
            if (id == null || !seen.add(id)) return false;
        }
        return true;
    }

    private static List<String> idsOf(List<?> list) {
        List<String> out = new ArrayList<String>();
        for (Object item : list) out.add(idOf(item));
        return out;
    }

    private static String idOf(Object node) {
        Map<String, Object> m = map(node);
        if (m == null) return null;
        Object id = m.get("id");
        if (id instanceof String && !((String) id).isEmpty()) return "id=" + id;
        Object key = m.get("key");
        if (key instanceof String && !((String) key).isEmpty()) return "key=" + key;
        return null;
    }

    // ── 小工具 ──────────────────────────────────────────────────────────

    /** `pages` 底下那张扁平表，按控件 id 建索引。 */
    static Map<String, Map<String, Object>> byId(Map<String, Object> root) {
        Map<String, Map<String, Object>> out = new LinkedHashMap<String, Map<String, Object>>();
        Object pages = root == null ? null : root.get("pages");
        if (!(pages instanceof List)) return out;
        for (Object page : (List<?>) pages) {
            if (!(page instanceof List)) continue;
            for (Object control : (List<?>) page) {
                Map<String, Object> m = map(control);
                if (m == null) continue;
                Object id = m.get("id");
                if (id instanceof String && !((String) id).isEmpty()) out.put((String) id, m);
            }
        }
        return out;
    }

    static String label(Object node) {
        Map<String, Object> m = map(node);
        if (m == null) return null;
        Object id = m.get("id");
        Object key = m.get("key");
        Object type = m.get("type");
        if (id == null && key == null) return null;
        String name = String.valueOf(key == null ? id : key);
        return type == null ? name : name + "(" + type + ")";
    }

    private static String kind(Object value) {
        if (value instanceof List) return "array";
        if (value instanceof Map) return "object";
        return "scalar";
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> map(Object node) {
        return node instanceof Map ? (Map<String, Object>) node : null;
    }

    private static List<?> list(Object node) {
        return node instanceof List ? (List<?>) node : new ArrayList<Object>();
    }

    private static String json(Object value) {
        return value == null ? "null" : SerializeUtils.toJsonString(value);
    }

    /**
     * 一条打印公式读成人话。
     *
     * 公式是个片段数组：文字片段原样接上，字段操作数写成 `«批号»`，换行记号 `_enter_` 写成 `⏎`。
     * 确认单上要回答的是「这一格现在显示什么」，不是「第 7 个片段是什么」。
     */
    static String formulaText(Object formula) {
        if (!(formula instanceof List)) return brief(formula);
        StringBuilder b = new StringBuilder();
        for (Object part : (List<?>) formula) {
            Map<String, Object> m = map(part);
            if (m != null) {
                Object name = m.get("formulaName");
                Object field = m.get("bindField");
                b.append("«").append(name == null ? String.valueOf(field) : name)
                        .append(field == null ? "" : " " + field).append("»");
            } else if ("_enter_".equals(String.valueOf(part))) {
                b.append(" ⏎ ");
            } else {
                b.append(String.valueOf(part));
            }
        }
        String s = b.toString();
        return s.length() > 240 ? s.substring(0, 237) + "..." : s;
    }

    /**
     * 模板上登记的打印插件读成人话：`类全名（说明）`，停用的标出来，一个都没有写「（没有插件）」。
     * 类名不截断；读不懂（不是 JSON 数组）就退回原文。
     */
    static String pluginsText(Object plugins) {
        Object raw = plugins;
        if (raw instanceof String) {
            if (((String) raw).trim().isEmpty()) return "（没有插件）";
            try {
                raw = SerializeUtils.fromJsonString((String) raw, List.class);
            } catch (Throwable e) {
                return brief(plugins);
            }
        }
        if (raw == null) return "（没有插件）";
        if (!(raw instanceof List)) return brief(plugins);
        List<String> parts = new ArrayList<String>();
        for (Object one : (List<?>) raw) {
            Map<String, Object> m = map(one);
            if (m == null) return brief(plugins);
            Object description = m.get("Description");
            parts.add(String.valueOf(m.get("ClassName"))
                    + (description == null || String.valueOf(description).isEmpty() ? "" : "（" + description + "）")
                    + (m.get("Enabled") == Boolean.TRUE ? "" : "［停用］"));
        }
        return parts.isEmpty() ? "（没有插件）" : join(parts, "、");
    }

    private static String brief(Object value) {
        if (value == null) return "null";
        String s = value instanceof Map || value instanceof List ? SerializeUtils.toJsonString(value)
                : String.valueOf(value);
        return s.length() > 120 ? s.substring(0, 117) + "..." : s;
    }

    private static String first(String... values) {
        for (String v : values) {
            if (v != null && !v.isEmpty()) return v;
        }
        return null;
    }

    private static String join(List<String> parts, String sep) {
        StringBuilder b = new StringBuilder();
        for (String p : parts) b.append(b.length() == 0 ? "" : sep).append(p);
        return b.toString();
    }
}
