import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import kd.bos.entity.function.BillFuncTypesLoader;
import kd.bos.entity.function.FunctionGroup;
import kd.bos.entity.function.FunctionType;
import kd.bos.entity.function.FunctionTypes;
import kd.bos.metadata.form.rule.FormRuleActionType;
import kd.bos.metadata.form.rule.FormRuleActionTypeCache;

/**
 * 表单界面规则 / 实体业务规则的函数元数据目录（只读）。
 *
 *   RULE_FUNC_SCOPE=bill|common|ext|all|action   默认 bill；bill 是单据规则内置函数，
 *                                          common 是公共函数，ext 是扩展函数，
 *                                          action 是规则**动作**目录（不是函数）。
 *   RULE_FUNC_FILTER=关键字                按函数 id、名称、定义、说明、运行类过滤。
 *   RULE_FUNC_DETAIL=1                     打印定义、说明、返回类型、运行类等完整信息。
 *
 * 界面规则 FormRule 继承 BizRule，两者条件表达式走同一套实体规则函数元数据。
 * 不要再靠扫描既有规则猜函数名；本探针直接读平台 FunctionTypes。
 */
public class RuleFunctionProbe {

    private static class Item {
        String source;
        String group;
        FunctionType type;
    }

    public static void run() throws Exception {
        String scope = env("RULE_FUNC_SCOPE", "bill").toLowerCase();
        String filter = env("RULE_FUNC_FILTER", "").toLowerCase();
        boolean detail = "1".equals(env("RULE_FUNC_DETAIL", "0"));

        if ("action".equals(scope)) {
            dumpActions(filter, detail);
            return;
        }
        if (!"bill".equals(scope) && !"common".equals(scope)
                && !"ext".equals(scope) && !"all".equals(scope)) {
            System.out.println("[PROBE] !! RULE_FUNC_SCOPE 只支持 bill|common|ext|all|action，当前=" + scope);
            return;
        }

        Map<String, Item> merged = new LinkedHashMap<String, Item>();
        if ("bill".equals(scope) || "all".equals(scope)) {
            add(merged, "bill", BillFuncTypesLoader.loadBizCloudFuncTypes());
        }
        if ("common".equals(scope) || "all".equals(scope)) {
            add(merged, "common", FunctionTypes.getCommonFuncs());
        }
        if ("ext".equals(scope) || "all".equals(scope)) {
            addSafely(merged, "ext-bill", true);
            addSafely(merged, "ext-common", false);
        }

        List<Item> items = new ArrayList<Item>(merged.values());
        Collections.sort(items, new Comparator<Item>() {
            @Override
            public int compare(Item a, Item b) {
                int x = safe(a.group).compareToIgnoreCase(safe(b.group));
                if (x != 0) return x;
                x = Integer.compare(a.type.getSeq(), b.type.getSeq());
                if (x != 0) return x;
                return safe(a.type.getId()).compareToIgnoreCase(safe(b.type.getId()));
            }
        });

        System.out.println("[PROBE] 规则函数目录 scope=" + scope
                + " 合并去重后=" + items.size() + " filter=" + dash(filter));
        int hit = 0;
        for (Item item : items) {
            FunctionType f = item.type;
            String hay = (safe(f.getId()) + " " + safe(f.getName()) + " "
                    + safe(f.getDef()) + " " + safe(f.getDesc()) + " "
                    + safe(f.getRunClass())).toLowerCase();
            if (!filter.isEmpty() && !hay.contains(filter)) continue;
            hit++;
            System.out.println("[PROBE] [" + item.source + "/" + item.group + "] "
                    + safe(f.getId()) + " | " + safe(f.getName()));
            if (detail) {
                System.out.println("[PROBE]   def=" + safe(f.getDef()));
                System.out.println("[PROBE]   desc=" + oneLine(safe(f.getDesc())));
                System.out.println("[PROBE]   return=" + safe(f.getReturnType())
                        + " runClass=" + safe(f.getRunClass()));
                System.out.println("[PROBE]   settingForm=" + safe(f.getSettingFormId())
                        + " srcApp=" + safe(f.getSrcApp())
                        + " srcType=" + safe(f.getSrcType()));
            }
        }
        System.out.println("[PROBE] 命中 " + hit + " 个函数（只读，不修改元数据）");
        if (hit == 0 && !filter.isEmpty()) {
            System.out.println("[PROBE] 未命中时先去掉 RULE_FUNC_FILTER；函数名以输出 id/def 为准");
        }
    }

    /** 规则动作目录：界面规则和业务规则共用这一份，metaType 区分归谁。 */
    private static void dumpActions(String filter, boolean detail) {
        List<FormRuleActionType> all = FormRuleActionTypeCache.getAllFormRuleActionTypes();
        System.out.println("[PROBE] 规则动作目录 " + (all == null ? 0 : all.size())
                + " 条 filter=" + dash(filter));
        System.out.println("[PROBE] metaType: formmeta=界面规则动作 entitymeta=业务规则动作"
                + "；ctrl: 1=字段 2=容器控件；svc: 1=服务端 2=前端Client* 4/8=行列样式");
        if (all == null) return;
        int hit = 0;
        for (FormRuleActionType t : all) {
            String hay = (safe(t.getId()) + " " + safe(t.getMetaClass()) + " "
                    + safe(t.getMetaType()) + " " + safe(String.valueOf(t.getTitle())) + " "
                    + safe(t.getDesc())).toLowerCase();
            if (!filter.isEmpty() && !hay.contains(filter)) continue;
            hit++;
            System.out.println("[PROBE] [" + safe(t.getMetaType()) + "] " + safe(t.getId())
                    + " | ctrl=" + t.getControlType() + " svc=" + t.getServiceTypes()
                    + " RET=" + t.getRaiseEventType() + " | " + safe(String.valueOf(t.getTitle())));
            if (detail) {
                System.out.println("[PROBE]   metaClass=" + safe(t.getMetaClass())
                        + " 设计器表单=" + safe(t.getFormid()) + " seq=" + t.getSeq());
                System.out.println("[PROBE]   触发时机 新增=" + t.isSupportAfterAdded()
                        + " 值改变=" + t.isSupportFieldChanged()
                        + " 值改变后=" + t.isSupportAfterFieldChanged());
                System.out.println("[PROBE]   desc=" + oneLine(safe(t.getDesc()))
                        + " tips=" + oneLine(safe(t.getTips())));
                if (!safe(t.getConvertServiceClass()).isEmpty()) {
                    System.out.println("[PROBE]   BOTP实现=" + safe(t.getConvertServiceClass()));
                }
            }
        }
        System.out.println("[PROBE] 命中 " + hit + " 个动作（只读，不修改元数据）");
    }

    private static void addSafely(Map<String, Item> out, String source, boolean bill) {
        try {
            Class<?> loader = Class.forName("kd.bos.entity.function.ExtFuncTypesLoader");
            java.lang.reflect.Method method = loader.getDeclaredMethod(
                    bill ? "loadExtBillFuncTypes" : "loadExtCommonFuncTypes");
            method.setAccessible(true);
            add(out, source, (FunctionTypes) method.invoke(null));
        } catch (Throwable e) {
            System.out.println("[PROBE] " + source + " 扩展函数加载失败，跳过："
                    + e.getClass().getSimpleName() + ": " + safe(e.getMessage()));
        }
    }

    private static void add(Map<String, Item> out, String source, FunctionTypes types) {
        if (types == null) {
            System.out.println("[PROBE] " + source + " 函数元数据为空");
            return;
        }
        Map<String, String> groups = new LinkedHashMap<String, String>();
        List<FunctionGroup> gs = types.getFunctionGroups();
        if (gs != null) {
            for (FunctionGroup g : gs) {
                groups.put(safe(g.getId()), safe(g.getName()));
            }
        }
        List<FunctionType> fs = types.getFunctionTypes();
        if (fs == null) return;
        System.out.println("[PROBE] " + source + " 原始函数=" + fs.size()
                + " 分组=" + (gs == null ? 0 : gs.size()));
        for (FunctionType f : fs) {
            Item item = new Item();
            item.source = source;
            item.group = groups.containsKey(safe(f.getGroupId()))
                    ? groups.get(safe(f.getGroupId())) : safe(f.getGroupId());
            item.type = f;
            String key = safe(f.getId()) + "\u0000" + safe(f.getDef())
                    + "\u0000" + safe(f.getRunClass());
            if (!out.containsKey(key)) out.put(key, item);
        }
    }

    private static String oneLine(String s) {
        return s.replace("\\r", " ").replace("\\n", " ")
                .replace('\r', ' ').replace('\n', ' ').replaceAll("\\s+", " ").trim();
    }

    private static String dash(String s) {
        return s == null || s.isEmpty() ? "-" : s;
    }

    private static String safe(Object v) {
        return v == null ? "" : String.valueOf(v);
    }

    private static String env(String key, String def) {
        String v = System.getenv(key);
        return v == null || v.trim().isEmpty() ? def : v.trim();
    }
}
