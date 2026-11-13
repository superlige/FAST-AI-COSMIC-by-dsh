import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import kd.bos.print.api.metedata.DesignerMetadata;
import kd.bos.print.api.metedata.PrintMetadata;
import kd.bos.print.api.utils.SerializeUtils;
import kd.bos.print.business.metedata.PrintMetadataUtil;
import kd.bos.print.business.metedata.bean.DesignMetadata;
import kd.bos.print.business.metedata.service.PrintTplService;
import kd.bos.print.service.BosPrintServiceHelper;

/**
 * 只读：审计一个本 ISV 新打印模板的设计内容、表格拓扑、合并区域、绑定和公式。
 *
 * TPL_NUMBER=模板编码（必填）
 * TPL_CONTROL=控件 id 或 key（可选，输出该控件完整 JSON 和表格坐标）
 * TPL_CONTROL_KEY=控件 key（可选，进入只读定位模式，输出机器可读的路径/类型/绑定/公式）
 * DETAIL=1（可选，输出每个布局表格和最多 20 个公式控件）
 * STRICT=1（可选，拓扑或平台校验失败时让探针失败）
 */
public class PrintTplDesignProbe {
    public static void run() {
        String number = env("TPL_NUMBER");
        if (number == null) throw new IllegalArgumentException("必须给 TPL_NUMBER");

        String tplId = BosPrintServiceHelper.getTplIdByNum(number);
        if (blank(tplId)) throw new IllegalArgumentException("模板不存在: " + number);
        PrintTplService service = new PrintTplService();
        DesignMetadata dm = (DesignMetadata) service.getDesignMeta(tplId);
        if (dm == null) throw new IllegalStateException("读不到模板本体: id=" + tplId);
        IsvGuard.assertOwnPrintTplSelf(number, dm.getNumber(), dm.getIsv());

        PrintMetadata pm = service.getPrintMetadata(dm);
        String lang = first(pm.getFixedLang(), pm.getOriLang(), "zh_CN");
        DesignerMetadata designer = PrintMetadataUtil.toDesignerMetadata(pm, lang);
        Map<String, Object> root = map(SerializeUtils.fromJsonString(
                SerializeUtils.toJsonString(designer.getMetadata()), Map.class));

        String locateKey = env("TPL_CONTROL_KEY");
        if (locateKey != null) {
            locateControl(number, root, locateKey);
            return;
        }
        List<Map<String, Object>> controls = controls(root);
        List<String> errors = audit(root, controls);

        Map<String, Integer> types = new LinkedHashMap<>();
        int bindings = 0, formulas = 0, formulaItems = 0;
        for (Map<String, Object> c : controls) {
            inc(types, s(c.get("type")));
            if (!blank(s(c.get("bindField"))) || !blank(s(c.get("dataSource")))) bindings++;
            Object fd = c.get("formulaData");
            if (fd instanceof List && !((List<?>) fd).isEmpty()) {
                formulas++;
                formulaItems += ((List<?>) fd).size();
            }
        }
        System.out.println("[PROBE] template=" + number + " id=" + tplId + " formId=" + dm.getFormId()
                + " isv=" + dm.getIsv() + " status=" + dm.getStatus() + " enable=" + dm.getEnable());
        System.out.println("[PROBE] version=" + dm.getVersion() + " modifyVersion=" + dm.getModifyVersion()
                + " lang=" + lang + " dataChars=" + (dm.getData() == null ? 0 : dm.getData().length())
                + " dataSha256=" + sha256(dm.getData()));
        System.out.println("[PROBE] controls=" + controls.size() + " types=" + types);
        System.out.println("[PROBE] designRoot id=" + s(root.get("id")) + " parentId=" + s(root.get("parentId")));
        System.out.println("[PROBE] bindings=" + bindings + " formulaControls=" + formulas
                + " formulaItems=" + formulaItems + " refDs=" + jsonArraySize(root.get("refDs"))
                + " customDs=" + jsonArraySize(root.get("customDs")) + " plugins=" + jsonArraySize(root.get("plugins")));

        String parse = validateParse(root, lang);
        String before = validateBeforeSave(service, root);
        System.out.println("[PROBE] topology=" + (errors.isEmpty() ? "OK" : "FAIL(" + errors.size() + ")")
                + " parseMetadata=" + parse + " beforeSave=" + before);
        for (String error : errors) System.out.println("[PROBE]   !! " + error);

        if ("1".equals(env("DETAIL"))) printDetail(root, controls);
        String selector = env("TPL_CONTROL");
        if (selector != null) printControl(root, controls, selector);

        boolean platformBad = !"OK".equals(parse) || !before.startsWith("true/");
        if ("1".equals(env("STRICT")) && (!errors.isEmpty() || platformBad)) {
            throw new IllegalStateException("模板设计审计未通过；见上方 [PROBE] 诊断");
        }
    }

    /**
     * 拓扑审计：重复 id、孤儿父子、行列格矩阵不完整、合并区越界。
     *
     * **只吃一个 Map，不碰数据库**，所以 `PrintTplWriteProbe` 的整份提交拿它直接审候选文件
     * （S32 1.3）。这里的 package-private 是为了那个复用，不要改回 private。
     */
    static List<String> audit(Map<String, Object> root, List<Map<String, Object>> all) {
        List<String> errors = new ArrayList<>();
        Map<String, Map<String, Object>> ids = new LinkedHashMap<>();
        Set<String> keys = new HashSet<>();
        String rootId = s(root.get("id"));
        String rootParentId = s(root.get("parentId"));
        for (Map<String, Object> c : all) {
            String id = s(c.get("id")), key = s(c.get("key"));
            if (blank(id)) errors.add("空 id, type=" + s(c.get("type")));
            else if (ids.put(id, c) != null) errors.add("重复 id=" + id);
            if (blank(key)) errors.add("空 key, id=" + id);
            else if (!keys.add(key)) errors.add("重复 key=" + key);
        }
        for (Map<String, Object> c : all) {
            String parent = s(c.get("parentId"));
            if (!blank(parent) && !rootId.equals(parent) && !rootParentId.equals(parent)
                    && !ids.containsKey(parent) && isStructuralChild(s(c.get("type")))) {
                errors.add("孤儿 parentId: " + brief(c) + " -> " + parent);
            }
        }
        for (Map<String, Object> grid : type(all, "LayoutGrid")) auditGrid(all, grid, "LayoutCell", errors);
        for (Map<String, Object> grid : type(all, "DataGrid")) auditGrid(all, grid, "DataCell", errors);
        return errors;
    }

    private static void auditGrid(List<Map<String, Object>> all, Map<String, Object> grid, String cellType,
                                  List<String> errors) {
        String gid = s(grid.get("id"));
        List<Map<String, Object>> rows = children(all, gid, "DataRow");
        List<Map<String, Object>> cols = children(all, gid, "DataColumn");
        List<Map<String, Object>> cells = children(all, gid, cellType);
        Map<String, Integer> rowPos = positions(rows), colPos = positions(cols);
        Map<String, Integer> slots = new LinkedHashMap<>();
        for (Map<String, Object> cell : cells) {
            String rid = s(cell.get("rowId")), cid = s(cell.get("columnId"));
            if (!rowPos.containsKey(rid)) {
                errors.add("表格 " + gid + " 单元格 " + s(cell.get("id")) + " 的 rowId 无效: " + rid);
                continue;
            }
            if (!colPos.containsKey(cid)) {
                errors.add("表格 " + gid + " 单元格 " + s(cell.get("id")) + " 的 columnId 无效: " + cid);
                continue;
            }
            String slot = rowPos.get(rid) + "_" + colPos.get(cid);
            Integer n = slots.get(slot);
            slots.put(slot, n == null ? 1 : n + 1);
        }
        for (int r = 0; r < rows.size(); r++) for (int c = 0; c < cols.size(); c++) {
            String slot = r + "_" + c;
            int count = slots.containsKey(slot) ? slots.get(slot) : 0;
            if (count != 1) errors.add("表格 " + gid + " 槽位 " + slot + " 的单元格数=" + count + "（应为 1）");
        }
        if (cells.size() != rows.size() * cols.size()) {
            errors.add("表格 " + gid + " 不是完整矩阵: cells=" + cells.size()
                    + ", rows*cols=" + rows.size() * cols.size());
        }
        if ("LayoutGrid".equals(s(grid.get("type")))) auditMerge(grid, gid, rows.size(), cols.size(), errors);
    }

    private static void auditMerge(Map<String, Object> grid, String gid, int rowCount, int colCount,
                                   List<String> errors) {
        Object value = grid.get("mergeConfig");
        if (!(value instanceof Map)) return;
        boolean[][] used = new boolean[Math.max(1, rowCount)][Math.max(1, colCount)];
        for (Map.Entry<String, Object> e : map(value).entrySet()) {
            if (!(e.getValue() instanceof Map)) {
                errors.add("表格 " + gid + " 合并区 " + e.getKey() + " 不是对象");
                continue;
            }
            Map<String, Object> rect = map(e.getValue());
            int rs = integer(rect.get("rowStart")), cs = integer(rect.get("columnStart"));
            int rl = integer(rect.get("rowLength")), cl = integer(rect.get("columnLength"));
            if (!e.getKey().equals(rs + "_" + cs)) errors.add("表格 " + gid + " 合并区键与起点不一致: " + e.getKey());
            if (rs < 0 || cs < 0 || rl < 1 || cl < 1 || rs + rl > rowCount || cs + cl > colCount) {
                errors.add("表格 " + gid + " 合并区越界: " + e.getKey());
                continue;
            }
            if (rl == 1 && cl == 1) errors.add("表格 " + gid + " 存在无意义 1x1 合并区: " + e.getKey());
            for (int r = rs; r < rs + rl; r++) for (int c = cs; c < cs + cl; c++) {
                if (used[r][c]) errors.add("表格 " + gid + " 合并区重叠槽位: " + r + "_" + c);
                used[r][c] = true;
            }
        }
    }

    private static void printDetail(Map<String, Object> root, List<Map<String, Object>> all) {
        for (Map<String, Object> grid : type(all, "LayoutGrid")) {
            String gid = s(grid.get("id"));
            System.out.println("[PROBE] GRID " + brief(grid)
                    + " rows=" + children(all, gid, "DataRow").size()
                    + " cols=" + children(all, gid, "DataColumn").size()
                    + " cells=" + children(all, gid, "LayoutCell").size()
                    + " x/y=" + s(grid.get("x")) + "/" + s(grid.get("y"))
                    + " width/height=" + s(grid.get("width")) + "/" + s(grid.get("height"))
                    + " mergeConfig=" + SerializeUtils.toJsonString(grid.get("mergeConfig")));
        }
        for (Map<String, Object> grid : type(all, "DataGrid")) {
            String gid = s(grid.get("id"));
            System.out.println("[PROBE] GRID " + brief(grid)
                    + " rows=" + children(all, gid, "DataRow").size()
                    + " cols=" + children(all, gid, "DataColumn").size()
                    + " cells=" + children(all, gid, "DataCell").size()
                    + " x/y=" + s(grid.get("x")) + "/" + s(grid.get("y"))
                    + " width/height=" + s(grid.get("width")) + "/" + s(grid.get("height")));
        }
        int shown = 0;
        for (Map<String, Object> c : all) {
            Object fd = c.get("formulaData");
            if (fd instanceof List && !((List<?>) fd).isEmpty() && shown++ < 20) {
                System.out.println("[PROBE] FORMULA " + brief(c) + " parentId=" + s(c.get("parentId"))
                        + " items=" + ((List<?>) fd).size() + " data=" + compact(fd, 500));
            }
        }
    }

    private static void printControl(Map<String, Object> root, List<Map<String, Object>> all, String selector) {
        for (Map<String, Object> c : all) {
            if (!selector.equals(s(c.get("id"))) && !selector.equals(s(c.get("key")))) continue;
            String parent = s(c.get("parentId"));
            String slot = "";
            if ("LayoutCell".equals(s(c.get("type")))) {
                slot = " row=" + position(children(all, parent, "DataRow"), s(c.get("rowId")))
                        + " col=" + position(children(all, parent, "DataColumn"), s(c.get("columnId")));
            }
            System.out.println("[PROBE] CONTROL " + brief(c) + " parentId=" + parent + slot);
            System.out.println("[PROBE]   " + SerializeUtils.toJsonString(c));
            return;
        }
        System.out.println("[PROBE] !! 没找到 TPL_CONTROL=" + selector);
    }

    /**
     * 按 key 遍历完整设计树并返回 JSONPath。不能只扫 pages 的第一层：不同平台版本会把
     * 控件放进嵌套对象；也不能把 id 当 key 接受，否则调用方以为拿到稳定语义标识，实际
     * 却把一次生成的内部 id 固化进后续修改。
     */
    private static void locateControl(String number, Map<String, Object> root, String wanted) {
        List<LocatedControl> matches = new ArrayList<>();
        findByKey(root, "$", wanted, matches);
        if (matches.isEmpty()) {
            throw new IllegalArgumentException("找不到控件 key: " + wanted);
        }
        if (matches.size() > 1) {
            StringBuilder paths = new StringBuilder();
            for (LocatedControl match : matches) {
                if (paths.length() > 0) paths.append(", ");
                paths.append(match.path);
            }
            throw new IllegalArgumentException("控件 key 不唯一: " + wanted + "，命中 "
                    + matches.size() + " 个: " + paths);
        }

        LocatedControl match = matches.get(0);
        Map<String, Object> control = match.control;
        Object bindField = control.get("bindField");
        Object formulaData = control.get("formulaData");
        System.out.println("[PROBE] CONTROL-LOCATE key=" + wanted + " path=" + match.path
                + " type=" + s(control.get("type")) + " bindField=" + compact(bindField, 500)
                + " formulaData=" + compact(formulaData, 2000));
        ProbeJson.emit("ptpl-control", "template", number, "key", wanted,
                "path", match.path, "controlType", control.get("type"),
                "bindField", bindField, "formulaData", formulaData);
    }

    private static void findByKey(Object node, String path, String wanted, List<LocatedControl> out) {
        if (node instanceof Map) {
            Map<String, Object> value = map(node);
            if (wanted.equals(s(value.get("key"))) && value.containsKey("id") && value.containsKey("type")) {
                out.add(new LocatedControl(path, value));
            }
            for (Map.Entry<String, Object> entry : value.entrySet()) {
                findByKey(entry.getValue(), path + "[\"" + escapePath(entry.getKey()) + "\"]", wanted, out);
            }
        } else if (node instanceof List) {
            List<?> value = (List<?>) node;
            for (int i = 0; i < value.size(); i++) findByKey(value.get(i), path + "[" + i + "]", wanted, out);
        }
    }

    private static String escapePath(String value) {
        return value.replace("\\", "\\\\").replace("\"", "\\\"");
    }

    private static final class LocatedControl {
        final String path;
        final Map<String, Object> control;

        LocatedControl(String path, Map<String, Object> control) {
            this.path = path;
            this.control = control;
        }
    }

    private static String validateParse(Map<String, Object> root, String lang) {
        try { PrintMetadataUtil.parseMetadata(copy(root), lang); return "OK"; }
        catch (Throwable e) { return "FAIL " + e.getClass().getSimpleName() + ":" + oneLine(e.getMessage()); }
    }
    private static String validateBeforeSave(PrintTplService service, Map<String, Object> root) {
        try {
            Map<String, Object> result = service.beforeSave(copy(root));
            return s(result.get("success")) + "/" + oneLine(s(result.get("message")));
        } catch (Throwable e) { return "THROW/" + e.getClass().getSimpleName() + ":" + oneLine(e.getMessage()); }
    }
    private static int jsonArraySize(Object value) {
        if (value == null || blank(s(value))) return 0;
        try {
            Object parsed = value instanceof String ? SerializeUtils.fromJsonString(s(value), Object.class) : value;
            return parsed instanceof List ? ((List<?>) parsed).size() : 1;
        } catch (Throwable e) { return -1; }
    }

    /** `pages` 底下那张扁平表。和 `audit` 一样是 package-private，给整份提交复用（S32 1.3）。 */
    static List<Map<String, Object>> controls(Map<String, Object> root) {
        List<Map<String, Object>> out = new ArrayList<>();
        Object pages = root.get("pages");
        if (pages instanceof List) for (Object page : (List<?>) pages) if (page instanceof List)
            for (Object control : (List<?>) page) if (control instanceof Map) out.add(map(control));
        return out;
    }
    private static List<Map<String, Object>> type(List<Map<String, Object>> all, String type) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (Map<String, Object> c : all) if (type.equals(s(c.get("type")))) out.add(c);
        return out;
    }
    private static List<Map<String, Object>> children(List<Map<String, Object>> all, String parent, String type) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (Map<String, Object> c : all)
            if (parent.equals(s(c.get("parentId"))) && type.equals(s(c.get("type")))) out.add(c);
        return out;
    }
    private static Map<String, Integer> positions(List<Map<String, Object>> list) {
        Map<String, Integer> out = new LinkedHashMap<>();
        for (int i = 0; i < list.size(); i++) out.put(s(list.get(i).get("id")), i);
        return out;
    }
    private static int position(List<Map<String, Object>> list, String id) {
        for (int i = 0; i < list.size(); i++) if (id.equals(s(list.get(i).get("id")))) return i;
        return -1;
    }
    private static void inc(Map<String, Integer> counts, String key) {
        Integer n = counts.get(key); counts.put(key, n == null ? 1 : n + 1);
    }
    @SuppressWarnings("unchecked") private static Map<String, Object> map(Object o) { return (Map<String, Object>) o; }
    private static Map<String, Object> copy(Map<String, Object> value) {
        return map(SerializeUtils.fromJsonString(SerializeUtils.toJsonString(value), Map.class));
    }
    private static String sha256(String value) {
        if (value == null) return "";
        try {
            byte[] hash = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
            StringBuilder out = new StringBuilder();
            for (byte b : hash) out.append(String.format("%02x", b & 0xff));
            return out.toString();
        } catch (Exception e) { throw new IllegalStateException(e); }
    }
    private static String compact(Object value, int limit) {
        if (value == null) return "null";
        String json = SerializeUtils.toJsonString(value);
        return json.length() <= limit ? json : json.substring(0, limit - 3) + "...";
    }
    private static String brief(Map<String, Object> c) {
        return s(c.get("type")) + "(" + s(c.get("id")) + "," + s(c.get("key")) + ")";
    }
    private static boolean isStructuralChild(String type) {
        return "DataRow".equals(type) || "DataColumn".equals(type)
                || "LayoutCell".equals(type) || "DataCell".equals(type);
    }
    private static int integer(Object o) { try { return Integer.parseInt(s(o)); } catch (Exception e) { return -1; } }
    private static String oneLine(String value) {
        if (value == null) return "";
        value = value.replace('\r', ' ').replace('\n', ' ');
        return value.length() <= 240 ? value : value.substring(0, 237) + "...";
    }
    private static String first(String... values) { for (String v : values) if (!blank(v)) return v; return null; }
    private static boolean blank(String value) { return value == null || value.trim().isEmpty(); }
    private static String s(Object o) { return o == null ? "" : String.valueOf(o); }
    private static String env(String key) { String v = System.getenv(key); return blank(v) ? null : v.trim(); }
}
