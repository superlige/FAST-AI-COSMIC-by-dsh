import java.util.*;

/** Runs the real Java selector with fixed, intentionally conflicting examples. */
public class NearbyExamplesFixture {
    static void check(boolean ok, String name) { if (!ok) throw new AssertionError(name); }
    static Map<String, Object> cell(String id, String row, String col, String field, String ds) {
        return NearbyExamples.values("id", id, "key", id, "type", "LayoutCell", "parentId", "grid",
                "rowId", row, "columnId", col, "bindField", field, "dataSource", ds, "dsType", "bill");
    }
    @SuppressWarnings("unchecked")
    public static void main(String[] args) {
        List<Map<String, Object>> all = new ArrayList<>();
        for (String row : Arrays.asList("r1", "r2", "r3")) all.add(NearbyExamples.values("id", row, "parentId", "grid", "type", "DataRow"));
        for (String col : Arrays.asList("c1", "c2", "c3")) all.add(NearbyExamples.values("id", col, "parentId", "grid", "type", "DataColumn"));
        Map<String, Object> target = cell("target", "r1", "c1", "code", "entry"); all.add(target);
        all.add(cell("near", "r1", "c2", "name", "entry"));
        all.add(cell("column", "r2", "c1", "number", "entry"));
        all.add(cell("same", "r3", "c3", "code", "entry"));
        all.add(cell("wrong", "r3", "c2", "code", "otherEntry"));
        Map<String, Object> output = NearbyExamples.print("tpl", all, target);
        List<Map<String, Object>> items = (List<Map<String, Object>>) output.get("items");
        check(items.size() == 3, "three examples");
        check("tpl:near".equals(items.get(0).get("reference")), "row first");
        check("tpl:column".equals(items.get(1).get("reference")), "column second");
        check("tpl:same".equals(items.get(2).get("reference")), "same datasource only");
        all.add(cell("crowd1", "r1", "c3", "more", "entry"));
        all.add(cell("crowd2", "r1", "c3", "extra", "entry"));
        check("tpl:column".equals(((List<Map<String, Object>>) NearbyExamples.print("tpl", all, target).get("items")).get(1).get("reference")), "busy row still shows column");
        check("none".equals(NearbyExamples.print("tpl", Arrays.asList(target), target).get("status")), "empty");
        check("partial".equals(NearbyExamples.print("tpl", new ArrayList<Map<String, Object>>(), target).get("status")), "missing scope");
        NearbyExamples limit = new NearbyExamples("self", "tpl");
        for (String id : Arrays.asList("self", "a", "a", "b", "c", "d")) limit.offer(id, "same", 1, NearbyExamples.values("code", "001"));
        check(((List<?>) limit.result("").get("items")).size() == 3 && Integer.valueOf(1).equals(limit.result("").get("omitted")), "cap and dedup");
        ProbeJson.emit(output);
        System.out.println("PASS 8 Java assertions");
    }
}
