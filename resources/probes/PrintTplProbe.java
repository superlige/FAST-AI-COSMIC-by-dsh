import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import kd.bos.dataentity.entity.DynamicObject;
import kd.bos.dataentity.entity.DynamicObjectCollection;
import kd.bos.orm.query.QFilter;
import kd.bos.print.service.BosPrintServiceHelper;
import kd.bos.servicehelper.QueryServiceHelper;

/**
 * 只读：打印模板清单 + 批量校验编码在当前账套到底存不存在。
 *
 * ⚠️ 查模板要用 **bos_manageprinttpl**（表 t_bas_printtplinfo）。
 * `bos_printtemplate` 名字更像但它是**表单布局表**（t_meta_formdesign），
 * 按 number 模糊查会返回几张单据布局，很容易被当成"模板只有几个"—— 实测在这上面绕过一轮。
 *
 * 编码来自 Excel / 业务文档时**必须先过一遍这个探针再往参数表里写** ——
 * 失效编码写进去，用户选中就是白屏，而这个问题只有到界面上才看得见。
 *
 *   TPL_FORM=单据标识      列出该单据下的全部模板，如 demo_sys_test_bill
 *   TPL_NUMBERS=编码,编码   批量校验存在性（走批量 API，65 个也只是一次调用）
 * 两个至少给一个；都给就先列清单再校验。
 */
public class PrintTplProbe {

    public static void run() {
        String form = env("TPL_FORM");
        List<String> numbers = split(env("TPL_NUMBERS"));
        if (form == null && numbers.isEmpty()) {
            throw new IllegalArgumentException("至少要给 TPL_FORM 或 TPL_NUMBERS");
        }
        if (form != null) {
            list(form);
        }
        if (!numbers.isEmpty()) {
            verify(numbers);
        }
    }

    private static void list(String form) {
        //billformid 存的是单据标识；有些历史模板没挂上，所以查不到时退回按编码前缀找
        DynamicObjectCollection rows = QueryServiceHelper.query("bos_manageprinttpl",
                "number,name,enable,billformid", new QFilter[]{new QFilter("billformid", "=", form)},
                "number");
        String by = "billformid=" + form;
        if (rows.isEmpty()) {
            rows = QueryServiceHelper.query("bos_manageprinttpl", "number,name,enable,billformid",
                    new QFilter[]{new QFilter("number", "like", form + "%")}, "number");
            by = "number like " + form + "%（billformid 查不到，退回按编码前缀）";
        }
        System.out.println("[PROBE] --- 模板清单：" + by + "  共 " + rows.size() + " 个 ---");
        for (DynamicObject r : rows) {
            System.out.println("[PROBE]   " + pad(r.getString("number"), 40)
                    + pad(r.getString("name"), 30)
                    + ("1".equals(r.getString("enable")) ? "启用" : "禁用"));
        }
    }

    private static void verify(List<String> numbers) {
        System.out.println("[PROBE] --- 校验 " + numbers.size() + " 个编码 ---");
        //getTplIdByNum 有 List 重载，别逐个调 String 版本
        Map<String, String> ids = BosPrintServiceHelper.getTplIdByNum(numbers);
        List<String> missing = new ArrayList<>();
        Map<String, String> found = new LinkedHashMap<>();
        for (String n : numbers) {
            String id = ids == null ? null : ids.get(n);
            if (id == null || id.trim().isEmpty()) {
                missing.add(n);
            } else {
                found.put(n, id);
            }
        }
        for (Map.Entry<String, String> e : found.entrySet()) {
            System.out.println("[PROBE]   OK " + pad(e.getKey(), 40) + "id=" + e.getValue());
        }
        for (String n : missing) {
            System.out.println("[PROBE]   !! " + pad(n, 40) + "模板不存在");
        }
        System.out.println("[PROBE] 有效 " + found.size() + " / 失效 " + missing.size());
        if (!missing.isEmpty()) {
            System.out.println("[PROBE] 失效清单（原样贴给业务确认，别自己猜替代）：");
            System.out.println("[PROBE]   " + String.join(",", missing));
        }
    }

    private static String pad(String s, int w) {
        StringBuilder sb = new StringBuilder(s == null ? "" : s);
        while (sb.length() < w) {
            sb.append(' ');
        }
        return sb.append(' ').toString();
    }

    private static List<String> split(String v) {
        List<String> list = new ArrayList<>();
        if (v != null) {
            for (String s : v.split("[,\\s]+")) {
                if (!s.trim().isEmpty()) {
                    list.add(s.trim());
                }
            }
        }
        return list;
    }

    private static String env(String k) {
        String v = System.getenv(k);
        return v == null || v.trim().isEmpty() ? null : v.trim();
    }
}
