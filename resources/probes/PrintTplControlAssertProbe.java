import java.util.ArrayList;
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
 * 只读：断言打印模板中一个控件的标量属性，供 verify 的 probe 适配器回归纯模板修改。
 *
 * TPL_NUMBER=模板编码
 * TPL_CONTROL=控件稳定 id 或唯一 key
 * TPL_EXPECT=属性=期望值;属性=期望值（支持点分隔的嵌套 Map 属性）
 */
public class PrintTplControlAssertProbe {
    public static void run() throws Exception {
        String number = required("TPL_NUMBER");
        String controlKey = required("TPL_CONTROL");
        String expectSpec = required("TPL_EXPECT");

        String tplId = BosPrintServiceHelper.getTplIdByNum(number);
        if (blank(tplId)) {
            throw new IllegalArgumentException("模板不存在: " + number);
        }
        PrintTplService service = new PrintTplService();
        DesignMetadata design = (DesignMetadata) service.getDesignMeta(tplId);
        if (design == null) {
            throw new IllegalStateException("读不到模板本体: id=" + tplId);
        }
        IsvGuard.assertOwnPrintTplSelf(number, design.getNumber(), design.getIsv());

        PrintMetadata merged = service.getPrintMetadata(design);
        String lang = first(merged.getFixedLang(), merged.getOriLang(), "zh_CN");
        DesignerMetadata designer = PrintMetadataUtil.toDesignerMetadata(merged, lang);
        Map<?, ?> metadata = (Map<?, ?>) SerializeUtils.fromJsonString(
                SerializeUtils.toJsonString(designer.getMetadata()), Map.class);

        List<Map<?, ?>> matches = new ArrayList<Map<?, ?>>();
        findControls(metadata, controlKey, matches);
        if (matches.size() != 1) {
            ProbeAssert.unresolved("print-control", number + "." + controlKey, "唯一控件",
                    "实际命中 " + matches.size() + " 个，请改用稳定 id");
            ProbeAssert.summary();
            return;
        }

        Map<?, ?> control = matches.get(0);
        System.out.println("[PROBE] template=" + number + " id=" + tplId
                + " control=" + control.get("key") + "(" + control.get("id") + ")");
        for (String item : expectSpec.split(";")) {
            String spec = item.trim();
            if (spec.isEmpty()) continue;
            int split = spec.indexOf('=');
            if (split <= 0) {
                throw new IllegalArgumentException("TPL_EXPECT 项缺少 '=': " + spec);
            }
            String path = spec.substring(0, split).trim();
            String expect = spec.substring(split + 1).trim();
            Object actual = readPath(control, path);
            if (actual == Missing.VALUE) {
                ProbeAssert.unresolved("print-control-property",
                        number + "." + controlKey + "." + path, expect, "属性不存在");
            } else {
                ProbeAssert.isEqual("print-control-property",
                        number + "." + controlKey + "." + path, expect, actual);
            }
        }
        ProbeAssert.summary();
    }

    private static Object readPath(Map<?, ?> root, String path) {
        Object current = root;
        for (String part : path.split("\\.")) {
            if (!(current instanceof Map) || !((Map<?, ?>) current).containsKey(part)) {
                return Missing.VALUE;
            }
            current = ((Map<?, ?>) current).get(part);
        }
        return current;
    }

    private static void findControls(Object node, String wanted, List<Map<?, ?>> matches) {
        if (node instanceof Map) {
            Map<?, ?> map = (Map<?, ?>) node;
            if (wanted.equals(String.valueOf(map.get("id")))
                    || wanted.equals(String.valueOf(map.get("key")))) {
                matches.add(map);
            }
            for (Object value : map.values()) findControls(value, wanted, matches);
        } else if (node instanceof List) {
            for (Object value : (List<?>) node) findControls(value, wanted, matches);
        }
    }

    private static String required(String key) {
        String value = System.getenv(key);
        if (blank(value)) throw new IllegalArgumentException("必须给 " + key);
        return value.trim();
    }

    private static String first(String... values) {
        for (String value : values) if (!blank(value)) return value;
        return null;
    }

    private static boolean blank(String value) {
        return value == null || value.trim().isEmpty();
    }

    private enum Missing { VALUE }
}
