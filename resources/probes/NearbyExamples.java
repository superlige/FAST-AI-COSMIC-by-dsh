import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Read-only nearby examples; the wire contract is shared with kernel/nearby-examples.ts. */
public final class NearbyExamples {
    private final String target;
    private final String scope;
    private final List<Map<String, Object>> candidates = new ArrayList<>();
    private final Map<String, Double> ranks = new LinkedHashMap<>();

    public NearbyExamples(String target, String scope) { this.target = target; this.scope = scope; }

    public static Map<String, Object> values(Object... kv) {
        Map<String, Object> out = new LinkedHashMap<>();
        for (int i = 0; i < kv.length; i += 2) out.put(String.valueOf(kv[i]), kv[i + 1]);
        return out;
    }

    public void offer(String reference, String reason, double rank, Map<String, Object> configuration) {
        if (reference.equals(target) || ranks.containsKey(reference)) return;
        ranks.put(reference, rank);
        candidates.add(values("reference", reference, "reason", reason, "configuration", configuration));
    }

    public Map<String, Object> result(String unavailable) {
        Collections.sort(candidates, new Comparator<Map<String, Object>>() {
            public int compare(Map<String, Object> a, Map<String, Object> b) {
                int rank = Double.compare(ranks.get(a.get("reference")), ranks.get(b.get("reference")));
                return rank != 0 ? rank : String.valueOf(a.get("reference")).compareTo(String.valueOf(b.get("reference")));
            }
        });
        //不全列：按相近程度排的样板，给最近的几个
        List<Map<String, Object>> items = new ArrayList<>(candidates.subList(0, Math.min(3, candidates.size())));
        String status = !unavailable.isEmpty() ? "partial" : items.isEmpty() ? "none" : "found";
        return values("t", "nearby-examples", "target", target, "scope", scope, "status", status,
                "message", !unavailable.isEmpty() ? unavailable : items.isEmpty() ? "没有现成样板" : "同一对象上的现成样板，需按当前需求核对",
                "items", items, "omitted", Math.max(0, candidates.size() - 3));
    }

    public void emit(String unavailable) {
        Map<String, Object> out = result(unavailable);
        System.out.println("[PROBE] 样板 " + target + "：" + out.get("message"));
        ProbeJson.emit(out);
    }

    private static String text(Object value) { return value == null ? "" : String.valueOf(value); }

    /** Binding identity includes datasource and scope, so equal bare field names do not imply a match. */
    private static void bindings(Object value, List<String> out) {
        if (value instanceof Map) {
            Map<?, ?> map = (Map<?, ?>) value;
            if (!text(map.get("bindField")).isEmpty()) {
                out.add(text(map.get("dsType")) + "|" + text(map.get("dataSource")) + "|" + text(map.get("bindField")));
            }
            for (Object child : map.values()) bindings(child, out);
        } else if (value instanceof List) for (Object child : (List<?>) value) bindings(child, out);
    }

    public static Map<String, Object> print(String template, List<Map<String, Object>> all, Map<String, Object> target) {
        String targetId = text(target.get("id"));
        NearbyExamples examples = new NearbyExamples(template + ":" + targetId, template);
        if (targetId.isEmpty() || !all.contains(target)) return examples.result("目标不在可比较的模板控件表中，未提供样板");
        List<String> fields = new ArrayList<>();
        bindings(target, fields);
        String parent = text(target.get("parentId")), row = text(target.get("rowId")), col = text(target.get("columnId"));
        Map<String, Integer> rows = new LinkedHashMap<>(), cols = new LinkedHashMap<>();
        for (Map<String, Object> control : all) {
            if (!parent.equals(text(control.get("parentId")))) continue;
            if ("DataRow".equals(control.get("type"))) rows.put(text(control.get("id")), rows.size());
            if ("DataColumn".equals(control.get("type"))) cols.put(text(control.get("id")), cols.size());
        }
        for (Map<String, Object> control : all) {
            if (targetId.equals(text(control.get("id"))) || !text(target.get("type")).equals(text(control.get("type")))) continue;
            Object formula = control.get("formulaData");
            if (text(control.get("bindField")).isEmpty() && (!(formula instanceof List) || ((List<?>) formula).isEmpty())) continue;
            boolean sibling = !parent.isEmpty() && parent.equals(text(control.get("parentId")));
            List<String> otherFields = new ArrayList<>(); bindings(control, otherFields);
            boolean sameField = !Collections.disjoint(fields, otherFields);
            double rank; String reason;
            if (sibling && !row.isEmpty() && row.equals(text(control.get("rowId"))) && cols.containsKey(col)
                    && cols.containsKey(text(control.get("columnId")))) {
                rank = Math.abs(cols.get(col) - cols.get(text(control.get("columnId")))); reason = sameField ? "同一行；同数据源字段" : "同一行";
            } else if (sibling && !col.isEmpty() && col.equals(text(control.get("columnId"))) && rows.containsKey(row)
                    && rows.containsKey(text(control.get("rowId")))) {
                rank = 100000 + Math.abs(rows.get(row) - rows.get(text(control.get("rowId")))); reason = sameField ? "同一列；同数据源字段" : "同一列";
            } else if (sameField) { rank = 200000; reason = "同模板、同数据源字段"; }
            else continue;
            examples.offer(template + ":" + text(control.get("id")), reason, rank,
                    values("key", control.get("key"), "type", control.get("type"), "rowId", control.get("rowId"),
                            "columnId", control.get("columnId"), "bindField", control.get("bindField"),
                            "dataSource", control.get("dataSource"), "dsType", control.get("dsType"),
                            "formulaData", formula, "bindText", control.get("bindText")));
        }
        Map<String, Object> result = examples.result("");
        // Three slots: first cover row, column and matching datasource field when present,
        // then fill remaining slots by actual grid distance. A busy row must not hide all columns.
        List<Map<String, Object>> chosen = new ArrayList<>();
        for (String category : new String[] {"同一行", "同一列", "同数据源字段"}) {
            boolean covered = false;
            for (Map<String, Object> item : chosen)
                if (text(item.get("reason")).contains(category)) covered = true;
            if (covered) continue;
            for (Map<String, Object> item : examples.candidates) {
                if (text(item.get("reason")).contains(category) && !chosen.contains(item)) {
                    chosen.add(item); break;
                }
            }
        }
        for (Map<String, Object> item : examples.candidates) {
            if (chosen.size() == 3) break;
            if (!chosen.contains(item)) chosen.add(item);
        }
        result.put("items", chosen);
        result.put("omitted", Math.max(0, examples.candidates.size() - chosen.size()));
        return result;
    }
}
