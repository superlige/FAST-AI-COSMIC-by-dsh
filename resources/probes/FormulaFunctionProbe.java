import java.lang.reflect.Method;
import java.net.URL;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import kd.bos.entity.function.BillFuncTypesLoader;
import kd.bos.entity.function.FunctionGroup;
import kd.bos.entity.function.FunctionType;
import kd.bos.entity.function.FunctionTypes;
import kd.bos.metadata.form.rule.FormRuleActionType;
import kd.bos.metadata.form.rule.FormRuleActionTypeCache;
import kd.bos.print.service.formula.PrintFormulaValidate;

/** Print and rule formula catalogs, read from the platform currently on the probe classpath. */
public final class FormulaFunctionProbe {
    private static final class Row {
        String id;
        String group;
        Map<String, Object> facts = new LinkedHashMap<String, Object>();
    }

    public static void run() throws Exception {
        String domain = env("FORMULA_DOMAIN", "").toLowerCase(Locale.ROOT);
        String mode = env("FORMULA_MODE", "function").toLowerCase(Locale.ROOT);
        String name = env("FORMULA_NAME", "");
        String query = env("FORMULA_QUERY", "");
        String group = env("FORMULA_GROUP", "");
        int page = number("FORMULA_PAGE", 1, 100);
        int limit = number("FORMULA_LIMIT", 3, 3);
        if (!"print".equals(domain) && !"form".equals(domain) && !"biz".equals(domain))
            throw new IllegalArgumentException("FORMULA_DOMAIN 只能是 print|form|biz");
        if (!"function".equals(mode) && !"action".equals(mode))
            throw new IllegalArgumentException("FORMULA_MODE 只能是 function|action");
        if ("print".equals(domain) && "action".equals(mode))
            throw new IllegalArgumentException("打印函数没有规则动作目录");
        if (!name.isEmpty() && !query.isEmpty())
            throw new IllegalArgumentException("FORMULA_NAME 与 FORMULA_QUERY 只能选一个");

        List<Row> rows = new ArrayList<Row>();
        List<String> gaps = new ArrayList<String>();
        String[] loaded = load(domain, mode, rows, gaps);
        String source = loaded[0];
        String coverage = loaded[1];

        Collections.sort(rows, new Comparator<Row>() {
            public int compare(Row a, Row b) {
                int n = a.group.compareToIgnoreCase(b.group);
                return n != 0 ? n : a.id.compareToIgnoreCase(b.id);
            }
        });
        List<Row> matched = new ArrayList<Row>();
        Map<String, Integer> groups = new LinkedHashMap<String, Integer>();
        for (Row row : rows) {
            Integer n = groups.get(row.group);
            groups.put(row.group, n == null ? 1 : n + 1);
            if (!name.isEmpty() && !row.id.equalsIgnoreCase(name)
                    && !safe(row.facts.get("name")).equalsIgnoreCase(name)) continue;
            if (!group.isEmpty() && !row.group.toLowerCase(Locale.ROOT).contains(group.toLowerCase(Locale.ROOT))) continue;
            if (!query.isEmpty() && !searchText(row).toLowerCase(Locale.ROOT).contains(query.toLowerCase(Locale.ROOT))) continue;
            matched.add(row);
        }
        boolean selected = !name.isEmpty() || !query.isEmpty() || !group.isEmpty();
        int start = selected ? Math.min(matched.size(), (page - 1) * limit) : 0;
        int end = selected ? Math.min(matched.size(), start + limit) : 0;
        String status = gaps.isEmpty() ? "loaded" : "partial";
        System.out.println("[PROBE] 公式目录 domain=" + domain + " mode=" + mode
                + " source=" + source + " status=" + status);
        System.out.println("[PROBE] 总数=" + rows.size() + " 命中=" + matched.size()
                + " 分类=" + groups + " 当前页=" + page + " 每页=" + limit
                + " 已给=" + (end - start) + "；" + coverage);
        if (!gaps.isEmpty()) System.out.println("[PROBE] 未读全：" + gaps);
        ProbeJson.emit("formula-summary", "domain", domain, "mode", mode, "status", status,
                "source", source, "coverage", coverage, "gaps", gaps, "total", rows.size(),
                "matched", matched.size(), "groups", groups, "page", page, "limit", limit,
                "shown", end - start, "hasMore", end < matched.size() && selected);
        if (!selected) {
            System.out.println("[PROBE] 按 --name 精确查，或用 --q/--group 筛选后按 --page 翻页；不自动展开全目录");
            return;
        }
        if (matched.isEmpty()) {
            miss(domain, mode, name, query, group, rows, gaps);
            return;
        }
        if ("print".equals(domain) && "CONCAT".equalsIgnoreCase(name)
                && "1".equals(env("FORMULA_SELF_CHECK", ""))) {
            new PrintFormulaValidate().executeExp(Collections.<Object>singletonList("CONCAT('a','b','c')"));
            boolean invalidRejected = false;
            try {
                new PrintFormulaValidate().executeExp(Collections.<Object>singletonList("CONCATX('a','b','c')"));
            } catch (Throwable expected) { invalidRejected = true; }
            if (!invalidRejected) throw new IllegalStateException("打印校验器未拒绝不存在的 CONCATX");
            ProbeJson.emit("formula-check", "name", "CONCAT", "validAccepted", true,
                    "invalidRejected", true, "source", "PrintFormulaValidate");
            System.out.println("[PROBE] 打印校验器接受 CONCAT('a','b','c')，拒绝不存在的 CONCATX");
        }
        for (int i = start; i < end; i++) {
            Row row = matched.get(i);
            System.out.println("[PROBE] " + row.group + "/" + row.id + " | " + row.facts.get("name")
                    + " | " + oneLine(String.valueOf(row.facts.get("usage")))
                    + " | " + oneLine(String.valueOf(row.facts.get("description"))));
            Map<String, Object> out = new LinkedHashMap<String, Object>();
            out.put("t", "formula-item");
            out.put("domain", domain);
            out.put("mode", mode);
            out.putAll(row.facts);
            ProbeJson.emit(out);
        }
    }

    private static void readPrint(URL url, List<Row> out) throws Exception {
        for (String[] f : FormulaCheck.printCatalog(url)) {
            Row row = row(f[0], f[1]);
            row.facts.put("name", f[2]);
            row.facts.put("usage", oneLine(f[3]));
            row.facts.put("description", oneLine(f[4]));
            row.facts.put("source", "PrintInitFunction.xml");
            row.facts.put("coverage", "设计器内置函数；当前模板中的实际计算还需打印校验器验证");
            out.add(row);
        }
    }

    private static int readPrintCustom(List<Row> out, List<String> gaps) {
        List<String> registered;
        try {
            registered = FormulaCheck.printRegistered();
        } catch (Throwable error) {
            gaps.add("当前进程自定义函数登记表读取失败：" + error.getClass().getSimpleName());
            return 0;
        }
        for (String id : registered) {
            boolean same = false;
            for (Row row : out) if (row.id.equalsIgnoreCase(id)) { same = true; break; }
            if (same) continue;
            Row row = row(id, "当前进程自定义函数");
            row.facts.put("name", id);
            row.facts.put("usage", "未提供参数格式");
            row.facts.put("description", "当前进程已登记；参数与结果需按注册实现和目标模板核对");
            row.facts.put("source", "PrintFormulaManager");
            row.facts.put("coverage", "仅当前探针进程登记快照，不证明所有运行场景可用");
            out.add(row);
        }
        return registered.size();
    }

    /**
     * 查不到时说清是哪一种（S36 3.1）：只说「目录没列出」，模型分不清是写错了名字、查错了领域，
     * 还是目录本来就不全，于是去翻 JAR、试函数。
     *
     * 按顺序判，先到先得，都附上能照抄的下一步：
     *   1. 别的目录有：同领域的另一半（函数查到了动作目录，或反过来）、别的领域（打印和规则互查，界面和实体动作互查）；
     *   2. 本目录有相近的名字（只对 --name）；
     *   3. 目录没读全（扩展加载失败等）：查不到不能当作不存在；
     *   4. 打印：内置目录和本进程登记里都没有，其他进程注册的自定义函数未知；
     *   5. 规则：当前环境登记的目录（含扩展）读全了也没有。
     * 函数在目录里之外的事——在某张单上能不能用——要带上目标字段和宿主，交给写入前的平台核对（FormulaCheck）。
     */
    private static void miss(String domain, String mode, String name, String query, String group,
            List<Row> rows, List<String> gaps) {
        String asked = !name.isEmpty() ? "--name " + name : !query.isEmpty() ? "--q " + query : "--group " + group;
        String key = !name.isEmpty() ? name : query;
        String here = label(domain, mode);
        List<String> elsewhere = new ArrayList<String>();
        if (!key.isEmpty()) {
            for (String[] other : others(domain, mode)) {
                List<Row> pool = new ArrayList<Row>();
                try {
                    load(other[0], other[1], pool, new ArrayList<String>());
                } catch (Throwable e) {
                    continue;
                }
                int hits = 0;
                String first = null;
                for (Row row : pool) {
                    boolean hit = !name.isEmpty()
                            ? row.id.equalsIgnoreCase(name) || safe(row.facts.get("name")).equalsIgnoreCase(name)
                            : searchText(row).toLowerCase(Locale.ROOT).contains(query.toLowerCase(Locale.ROOT));
                    if (!hit) continue;
                    hits++;
                    if (first == null) first = row.id;
                }
                if (hits == 0) continue;
                String next = "cosmic_meta formula " + other[0] + ("action".equals(other[1]) ? " --actions" : "")
                        + (!name.isEmpty() ? " --name " + first : " --q " + query);
                elsewhere.add(label(other[0], other[1]) + "有 " + hits + " 条（如 " + first + "）：" + next);
            }
        }
        List<String> near = new ArrayList<String>();
        if (!name.isEmpty()) {
            List<String> pool = new ArrayList<String>();
            for (Row row : rows) pool.add(row.id);
            near = FormulaCheck.near(name, pool, 3);
        }
        String reason;
        String says;
        if (!elsewhere.isEmpty()) {
            reason = "other-domain";
            says = here + "里没有，在别的目录里";
        } else if (!near.isEmpty()) {
            reason = "near-name";
            says = here + "里没有这个名字" + FormulaCheck.nearText(near);
        } else if (!gaps.isEmpty()) {
            reason = "partial-catalog";
            says = here + "没读全（" + gaps + "），查不到不能当作不存在";
        } else if ("print".equals(domain)) {
            reason = "builtin-only";
            says = "打印设计器内置目录和本进程登记的函数里都没有；其他进程或稍后才注册的自定义函数未知，写进公式后以打印校验器的结论为准";
        } else {
            reason = "not-listed";
            says = "当前环境登记的" + here + "（含扩展）读全了也没有"
                    + ("action".equals(mode) ? "" : "；写进规则表达式，写入前的平台核对会报函数不存在");
        }
        System.out.println("[PROBE] 查不到（" + asked + "）：" + says);
        for (String line : elsewhere) System.out.println("[PROBE]   " + line);
        ProbeJson.emit("formula-miss", "domain", domain, "mode", mode, "asked", asked, "reason", reason,
                "near", near, "elsewhere", elsewhere, "gaps", gaps);
    }

    /** 查不到时还要看的其他目录：{领域, function|action}。 */
    private static List<String[]> others(String domain, String mode) {
        List<String[]> out = new ArrayList<String[]>();
        if ("print".equals(domain)) {
            out.add(new String[] {"form", "function"});
        } else if ("function".equals(mode)) {
            out.add(new String[] {domain, "action"});
            out.add(new String[] {"form".equals(domain) ? "biz" : "form", "action"});
            out.add(new String[] {"print", "function"});
        } else {
            out.add(new String[] {domain, "function"});
            out.add(new String[] {"form".equals(domain) ? "biz" : "form", "action"});
        }
        return out;
    }

    private static String label(String domain, String mode) {
        if ("print".equals(domain)) return "打印函数目录";
        if ("action".equals(mode)) return "form".equals(domain) ? "界面规则动作目录" : "业务规则（实体）动作目录";
        return "规则函数目录";
    }

    /** 按领域读一份目录：{来源, 覆盖说明}。run 和 miss 共用，「这里查不到、那里查得到」说的是同一份数据。 */
    private static String[] load(String domain, String mode, List<Row> rows, List<String> gaps) throws Exception {
        String source;
        String coverage;
        if ("print".equals(domain)) {
            URL url = FormulaFunctionProbe.class.getClassLoader().getResource("PrintInitFunction.xml");
            if (url == null) throw new IllegalStateException("当前运行环境找不到 PrintInitFunction.xml");
            source = "PrintInitFunction.xml @ " + jarName(url.toExternalForm());
            readPrint(url, rows);
            int custom = readPrintCustom(rows, gaps);
            coverage = "设计器内置目录 + 当前探针进程已登记的自定义函数 " + custom
                    + " 项；其他进程或稍后才注册的函数未知，不等于全部可用函数";
        } else if ("action".equals(mode)) {
            source = "FormRuleActionTypeCache @ " + jarName(FormRuleActionTypeCache.class);
            readActions(domain, rows, gaps);
            coverage = "当前环境登记的" + ("form".equals(domain) ? "界面" : "实体")
                    + "规则动作；是否适用于目标宿主与触发时机仍需核对";
        } else {
            source = "FunctionTypes @ " + jarName(FunctionTypes.class);
            readRules(rows, gaps);
            coverage = "当前环境已加载的规则函数目录；界面与业务规则共用函数清单，目标宿主仍需核对";
        }
        return new String[] {source, coverage};
    }

    private static void readRules(List<Row> out, List<String> gaps) {
        Map<String, Row> unique = new LinkedHashMap<String, Row>();
        addRules(unique, "bill", BillFuncTypesLoader.loadBizCloudFuncTypes(), gaps);
        addRules(unique, "common", FunctionTypes.getCommonFuncs(), gaps);
        for (String lane : new String[] {"ext-bill", "ext-common"}) {
            try {
                Class<?> loader = Class.forName("kd.bos.entity.function.ExtFuncTypesLoader");
                Method method = loader.getDeclaredMethod("ext-bill".equals(lane)
                        ? "loadExtBillFuncTypes" : "loadExtCommonFuncTypes");
                method.setAccessible(true);
                addRules(unique, lane, (FunctionTypes) method.invoke(null), gaps);
            } catch (Throwable error) {
                gaps.add(lane + " 加载失败：" + error.getClass().getSimpleName());
            }
        }
        out.addAll(unique.values());
    }

    private static void addRules(Map<String, Row> out, String lane, FunctionTypes types, List<String> gaps) {
        if (types == null || types.getFunctionTypes() == null) {
            gaps.add(lane + " 函数目录为空或不可读");
            return;
        }
        Map<String, String> groups = new LinkedHashMap<String, String>();
        if (types.getFunctionGroups() != null)
            for (FunctionGroup group : types.getFunctionGroups())
                groups.put(safe(group.getId()), safe(group.getName()));
        for (FunctionType f : types.getFunctionTypes()) {
            String key = safe(f.getId()) + "\u0000" + safe(f.getDef()) + "\u0000" + safe(f.getRunClass());
            if (out.containsKey(key)) continue;
            String group = groups.containsKey(safe(f.getGroupId()))
                    ? groups.get(safe(f.getGroupId())) : safe(f.getGroupId());
            Row row = row(safe(f.getId()), group);
            row.facts.put("name", safe(f.getName()));
            row.facts.put("usage", safe(f.getDef()));
            row.facts.put("description", oneLine(safe(f.getDesc())));
            row.facts.put("returnType", safe(f.getReturnType()));
            row.facts.put("runClass", safe(f.getRunClass()));
            row.facts.put("settingForm", safe(f.getSettingFormId()));
            row.facts.put("srcApp", safe(f.getSrcApp()));
            row.facts.put("srcType", safe(f.getSrcType()));
            row.facts.put("source", lane);
            row.facts.put("coverage", "规则函数目录；不证明所有规则宿主都适用");
            out.put(key, row);
        }
    }

    private static void readActions(String domain, List<Row> out, List<String> gaps) {
        List<FormRuleActionType> actions = FormRuleActionTypeCache.getAllFormRuleActionTypes();
        if (actions == null) {
            gaps.add("规则动作目录为空或不可读");
            return;
        }
        String metaType = "form".equals(domain) ? "formmeta" : "entitymeta";
        for (FormRuleActionType action : actions) {
            if (!metaType.equalsIgnoreCase(safe(action.getMetaType()))) continue;
            Row row = row(safe(action.getId()), metaType);
            row.facts.put("name", safe(action.getTitle()));
            row.facts.put("usage", "规则动作，不是表达式函数");
            row.facts.put("description", oneLine(safe(action.getDesc())));
            row.facts.put("metaClass", safe(action.getMetaClass()));
            row.facts.put("designerForm", safe(action.getFormid()));
            row.facts.put("controlType", action.getControlType());
            row.facts.put("serviceTypes", action.getServiceTypes());
            row.facts.put("raiseEventType", action.getRaiseEventType());
            row.facts.put("supportAfterAdded", action.isSupportAfterAdded());
            row.facts.put("supportFieldChanged", action.isSupportFieldChanged());
            row.facts.put("supportAfterFieldChanged", action.isSupportAfterFieldChanged());
            row.facts.put("source", "FormRuleActionTypeCache");
            row.facts.put("coverage", "当前环境登记动作；具体宿主与字段仍需核对");
            out.add(row);
        }
    }

    private static Row row(String id, String group) {
        Row row = new Row();
        row.id = id;
        row.group = group;
        row.facts.put("id", id);
        row.facts.put("group", group);
        return row;
    }

    private static String searchText(Row row) {
        return row.id + " " + row.group + " " + row.facts.get("name") + " "
                + row.facts.get("usage") + " " + row.facts.get("description");
    }

    private static String jarName(Class<?> type) {
        try { return jarName(type.getProtectionDomain().getCodeSource().getLocation().toExternalForm()); }
        catch (Throwable ignored) { return type.getName(); }
    }

    /**
     * 目录来自哪个 jar，给完整路径：只给文件名的话，想解开看原文就只能满盘去找它
     * （真机 2026-09-26 为找 bos-print-business-8.0.jar 跑 find /，挂了 28 分钟）。
     */
    private static String jarName(String url) {
        String value = url.split("!", 2)[0];
        if (value.startsWith("jar:")) value = value.substring(4);
        try { return new java.io.File(new java.net.URI(value)).getAbsolutePath(); }
        catch (Throwable ignored) {
            int slash = value.lastIndexOf('/');
            return slash < 0 ? value : value.substring(slash + 1);
        }
    }

    private static int number(String key, int def, int max) {
        String value = env(key, String.valueOf(def));
        try {
            int n = Integer.parseInt(value);
            if (n >= 1 && n <= max) return n;
        } catch (NumberFormatException ignored) { }
        throw new IllegalArgumentException(key + " 只接受 1.." + max);
    }

    private static String oneLine(String value) {
        return value.replace('\r', ' ').replace('\n', ' ').replaceAll("\\s+", " ").trim();
    }

    private static String safe(Object value) { return value == null ? "" : String.valueOf(value); }

    private static String env(String key, String def) {
        String value = System.getenv(key);
        return value == null || value.trim().isEmpty() ? def : value.trim();
    }
}
