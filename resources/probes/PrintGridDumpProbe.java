import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import kd.bos.print.api.metedata.DesignerMetadata;
import kd.bos.print.api.metedata.PrintMetadata;
import kd.bos.print.api.utils.SerializeUtils;
import kd.bos.print.business.metedata.PrintMetadataUtil;
import kd.bos.print.business.metedata.bean.DesignMetadata;
import kd.bos.print.business.metedata.service.PrintTplService;
import kd.bos.print.service.BosPrintServiceHelper;

/**
 * 只读：把打印模板里某个表格（DataGrid / LayoutGrid）的网格摊平打印 ——
 * 行高、列宽、每个格子的绑定字段/文本/公式，外加合并区。
 *
 * PrintTplDesignProbe 只审计拓扑是否完整，看不到「第 2 行第 3 列绑的是哪个字段」；
 * 插件要按列下标删列/插列（行转列、动态列）时，这份下标表就是前提。
 *
 *   TPL_NUMBER=模板编码（必填，只允许 <isv>_）
 *   GRID=表格 id 或 key（如 DataGrid）；不给就打整张模板的结构概览（ptpl dump --overview）：
 *        模板绑了哪些字段、每页每张表格几行几列、每格绑什么字段或写死什么字、表格外的控件
 *
 * 概览是 2026-09-18 真机补的：模型要知道「58 号模板有没有格子绑检验项目」「备注在哪个格子里」，
 * 只能把设计 JSON dump 到本地、自己写 python 一层层解析，一个会话里为此跑了 20 多次命令。
 */
public class PrintGridDumpProbe {

    public static void run() throws Exception {
        String number = req("TPL_NUMBER");
        String gridKey = env("GRID");
        PrintTplService service = new PrintTplService();
        String tplId = BosPrintServiceHelper.getTplIdByNum(number);
        if (tplId == null || tplId.isEmpty()) {
            throw new IllegalArgumentException("模板不存在: " + number);
        }
        DesignMetadata dm = (DesignMetadata) service.getDesignMeta(tplId);
        if (dm == null) throw new IllegalStateException("读不到模板本体: id=" + tplId);
        IsvGuard.assertOwnPrintTplSelf(number, dm.getNumber(), dm.getIsv());
        PrintMetadata pm = service.getPrintMetadata(dm);
        String lang = pm.getFixedLang() == null || pm.getFixedLang().isEmpty() ? "zh_CN" : pm.getFixedLang();
        DesignerMetadata designer = PrintMetadataUtil.toDesignerMetadata(pm, lang);
        Map<String, Object> root = map(SerializeUtils.fromJsonString(
                SerializeUtils.toJsonString(designer.getMetadata()), Map.class));
        // 表格可能在任何一页：金相 CNAS 模板的数据表在第 3 页（真机 2026-09-18，只看第 1 页时报「找不到表格」）
        List<List<Map<String, Object>>> pages = pages(root);
        if (gridKey.isEmpty()) {
            overview(number, pages);
            return;
        }
        Map<String, Object> grid = null;
        List<Map<String, Object>> page = null;
        int pageNo = -1;
        for (int p = 0; p < pages.size() && grid == null; p++) {
            for (Map<String, Object> c : pages.get(p)) {
                if (gridKey.equals(s(c.get("id"))) || gridKey.equals(s(c.get("key")))) {
                    grid = c;
                    page = pages.get(p);
                    pageNo = p + 1;
                    break;
                }
            }
        }
        if (grid == null) {
            System.out.println("[PROBE] ✗ 找不到表格 " + gridKey + "（id 和 key 都比过，区分大小写）。模板里所有表格：");
            for (int p = 0; p < pages.size(); p++) {
                for (Map<String, Object> c : pages.get(p)) {
                    String type = s(c.get("type"));
                    if ("DataGrid".equals(type) || "LayoutGrid".equals(type)) {
                        System.out.println("[PROBE]   第" + (p + 1) + "页 " + type + " key=" + s(c.get("key"))
                                + " id=" + s(c.get("id")));
                    }
                }
            }
            throw new IllegalArgumentException("找不到表格: " + gridKey);
        }
        String gid = s(grid.get("id"));
        System.out.println("[PROBE] " + number + " 第" + pageNo + "页 grid=" + gid + "/" + s(grid.get("key"))
                + " type=" + s(grid.get("type")) + " x/y=" + grid.get("x") + "/" + grid.get("y")
                + " w/h=" + grid.get("width") + "/" + grid.get("height")
                + " hidden=" + grid.get("hidden")
                + " fixedRowCount=" + grid.get("fixedRowCount") + " ds=" + s(grid.get("dataSource")));
        List<Map<String, Object>> rows = children(page, gid, "DataRow");
        List<Map<String, Object>> cols = children(page, gid, "DataColumn");
        System.out.println("[PROBE] rows=" + rows.size() + " cols=" + cols.size());
        for (int i = 0; i < rows.size(); i++) {
            Map<String, Object> row = rows.get(i);
            System.out.println("[PROBE]   row" + i + " id=" + s(row.get("id")) + " key=" + s(row.get("key"))
                    + " rowType=" + s(row.get("rowType")) + " h=" + row.get("rowHeight"));
        }
        for (int i = 0; i < cols.size(); i++) {
            Map<String, Object> col = cols.get(i);
            System.out.println("[PROBE]   col" + i + " id=" + s(col.get("id")) + " key=" + s(col.get("key"))
                    + " w=" + col.get("columnWidth"));
        }
        Map<String, Integer> rowPos = positions(rows);
        Map<String, Integer> colPos = positions(cols);
        String cellType = "DataGrid".equals(s(grid.get("type"))) ? "DataCell" : "LayoutCell";
        Map<String, Map<String, Object>> bySlot = new LinkedHashMap<>();
        for (Map<String, Object> cell : children(page, gid, cellType)) {
            bySlot.put(rowPos.get(s(cell.get("rowId"))) + "_" + colPos.get(s(cell.get("columnId"))), cell);
        }
        for (int r = 0; r < rows.size(); r++) {
            for (int c = 0; c < cols.size(); c++) {
                Map<String, Object> cell = bySlot.get(r + "_" + c);
                if (cell == null) {
                    System.out.println("[PROBE]   [" + r + "," + c + "] <缺>");
                    continue;
                }
                StringBuilder out = new StringBuilder();
                out.append("[PROBE]   [").append(r).append(',').append(c).append("] ")
                        .append(s(cell.get("id"))).append(' ').append(s(cell.get("type")));
                append(out, "ctrl", cell.get("cellType"));
                append(out, "text", cell.get("text"));
                append(out, "bindText", cell.get("bindText"));
                append(out, "viewText", cell.get("viewText"));
                append(out, "ds", cell.get("dataSource"));
                append(out, "bindField", cell.get("bindField"));
                append(out, "statType", cell.get("statType"));
                Object fd = cell.get("formulaData");
                if (fd instanceof List && !((List<?>) fd).isEmpty()) {
                    out.append(" formula=").append(SerializeUtils.toJsonString(fd));
                }
                System.out.println(out);
            }
        }
        System.out.println("[PROBE] mergeConfig=" + SerializeUtils.toJsonString(grid.get("mergeConfig")));
    }

    /** 不点名表格时：整张模板一屏看完 */
    private static void overview(String number, List<List<Map<String, Object>>> pages) {
        System.out.println("[PROBE] 模板 " + number + " 结构概览（共 " + pages.size() + " 页；只读）");
        Map<String, java.util.TreeSet<String>> fields = new LinkedHashMap<>();
        for (List<Map<String, Object>> page : pages) {
            for (Map<String, Object> c : page) {
                String bind = s(c.get("bindField"));
                if (bind.isEmpty()) {
                    continue;
                }
                String ds = s(c.get("dataSource"));
                java.util.TreeSet<String> set = fields.get(ds);
                if (set == null) {
                    set = new java.util.TreeSet<>();
                    fields.put(ds, set);
                }
                set.add(bind);
            }
        }
        System.out.println("[PROBE] 模板绑了这些字段（打印引擎只查模板用到的字段，这里没有的，插件在数据行里取不到）：");
        if (fields.isEmpty()) {
            System.out.println("[PROBE]   （一个都没有）");
        }
        for (Map.Entry<String, java.util.TreeSet<String>> e : fields.entrySet()) {
            System.out.println("[PROBE]   数据源 " + (e.getKey().isEmpty() ? "（没写）" : e.getKey()) + "：" + String.join(", ", e.getValue()));
        }
        for (int p = 0; p < pages.size(); p++) {
            List<Map<String, Object>> page = pages.get(p);
            java.util.Set<String> inGrid = new java.util.HashSet<>();
            for (Map<String, Object> grid : page) {
                String type = s(grid.get("type"));
                if (!"DataGrid".equals(type) && !"LayoutGrid".equals(type)) {
                    continue;
                }
                String gid = s(grid.get("id"));
                inGrid.add(gid);
                List<Map<String, Object>> rows = children(page, gid, "DataRow");
                List<Map<String, Object>> cols = children(page, gid, "DataColumn");
                System.out.println("[PROBE] 第" + (p + 1) + "页 表格 " + (s(grid.get("key")).isEmpty() ? gid : s(grid.get("key")))
                        + "（" + type + "，" + rows.size() + " 行×" + cols.size() + " 列"
                        + (s(grid.get("dataSource")).isEmpty() ? "" : "，数据源 " + s(grid.get("dataSource")))
                        + (Boolean.TRUE.equals(grid.get("hidden")) ? "，隐藏" : "") + "）");
                Map<String, Integer> rowPos = positions(rows);
                Map<String, Integer> colPos = positions(cols);
                String cellType = "DataGrid".equals(type) ? "DataCell" : "LayoutCell";
                Map<String, Map<String, Object>> bySlot = new LinkedHashMap<>();
                for (Map<String, Object> cell : children(page, gid, cellType)) {
                    inGrid.add(s(cell.get("id")));
                    bySlot.put(rowPos.get(s(cell.get("rowId"))) + "_" + colPos.get(s(cell.get("columnId"))), cell);
                }
                for (Map<String, Object> one : rows) {
                    inGrid.add(s(one.get("id")));
                }
                for (Map<String, Object> one : cols) {
                    inGrid.add(s(one.get("id")));
                }
                for (int r = 0; r < rows.size(); r++) {
                    StringBuilder line = new StringBuilder("[PROBE]   行" + r + ": ");
                    for (int c = 0; c < cols.size(); c++) {
                        Map<String, Object> cell = bySlot.get(r + "_" + c);
                        line.append(c == 0 ? "" : " | ").append(cell == null ? "" : brief(cell));
                    }
                    System.out.println(line);
                }
            }
            StringBuilder others = new StringBuilder();
            for (Map<String, Object> c : page) {
                String type = s(c.get("type"));
                if (inGrid.contains(s(c.get("id"))) || "DataRow".equals(type) || "DataColumn".equals(type)
                        || "LayoutCell".equals(type) || "DataCell".equals(type)) {
                    continue;
                }
                String text = brief(c);
                if (s(c.get("key")).isEmpty() && text.isEmpty()) {
                    continue;
                }
                others.append(others.length() == 0 ? "" : "；").append(s(c.get("key"))).append('(').append(type).append(')')
                        .append(text.isEmpty() ? "" : " " + text);
            }
            if (others.length() > 0) {
                System.out.println("[PROBE] 第" + (p + 1) + "页 表格外的控件：" + others);
            }
        }
        System.out.println("[PROBE] 格子写法：[控件key]内容，{字段} 是绑定字段，=… 是公式；某张表的行高列宽、合并区用 --grid 表格key 看");
    }

    /** 一个格子/控件的简写：[key]{绑定字段} 或 [key]文字 或 [key]=公式 */
    private static String brief(Map<String, Object> c) {
        String key = s(c.get("key"));
        String bind = s(c.get("bindField"));
        String text = !s(c.get("bindText")).isEmpty() ? s(c.get("bindText")) : s(c.get("text"));
        String body;
        if (!bind.isEmpty()) {
            body = "{" + bind + "}";
        } else if (c.get("formulaData") instanceof List && !((List<?>) c.get("formulaData")).isEmpty()) {
            body = "=公式";
        } else {
            body = ProbeAssert.shown(text.trim());
            if (body.length() > 24) {
                body = body.substring(0, 24) + "…";
            }
        }
        return (key.isEmpty() ? "" : "[" + key + "]") + body;
    }

    private static void append(StringBuilder out, String label, Object value) {
        String text = s(value);
        if (!text.isEmpty()) {
            out.append(' ').append(label).append('=').append(ProbeAssert.shown(text));
        }
    }

    private static Map<String, Integer> positions(List<Map<String, Object>> items) {
        Map<String, Integer> pos = new LinkedHashMap<>();
        for (int i = 0; i < items.size(); i++) {
            pos.put(s(items.get(i).get("id")), i);
        }
        return pos;
    }

    /** 取某个控件下指定类型的子控件，按设计态 index 排序（行列顺序 = 下标顺序） */
    private static List<Map<String, Object>> children(List<Map<String, Object>> all, String parentId,
                                                      String type) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (Map<String, Object> c : all) {
            if (parentId.equals(s(c.get("parentId"))) && type.equals(s(c.get("type")))) {
                out.add(c);
            }
        }
        Collections.sort(out, new Comparator<Map<String, Object>>() {
            @Override
            public int compare(Map<String, Object> a, Map<String, Object> b) {
                return Integer.compare(intOf(a.get("index")), intOf(b.get("index")));
            }
        });
        return out;
    }

    private static int intOf(Object value) {
        if (value instanceof Number) {
            return ((Number) value).intValue();
        }
        try {
            return Integer.parseInt(s(value));
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    @SuppressWarnings("unchecked")
    private static List<List<Map<String, Object>>> pages(Map<String, Object> root) {
        List<Object> pages = (List<Object>) root.get("pages");
        if (pages == null || pages.isEmpty()) {
            throw new IllegalStateException("模板没有页");
        }
        List<List<Map<String, Object>>> out = new ArrayList<>();
        for (Object page : pages) {
            out.add(page instanceof List ? (List<Map<String, Object>>) page : new ArrayList<Map<String, Object>>());
        }
        return out;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> map(Object value) {
        return (Map<String, Object>) value;
    }

    private static String s(Object value) {
        return value == null ? "" : String.valueOf(value);
    }

    private static String env(String key) {
        String value = System.getenv(key);
        return value == null ? "" : value.trim();
    }

    private static String req(String key) {
        String value = System.getenv(key);
        if (value == null || value.trim().isEmpty()) {
            throw new IllegalArgumentException("必须给 " + key);
        }
        return value.trim();
    }
}
