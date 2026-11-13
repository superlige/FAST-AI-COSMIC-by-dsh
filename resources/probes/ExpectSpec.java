import java.math.BigDecimal;
import java.text.ParseException;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import kd.bos.dataentity.entity.DynamicObject;
import kd.bos.dataentity.entity.DynamicObjectCollection;
import kd.bos.dataentity.metadata.ICollectionProperty;
import kd.bos.dataentity.metadata.IComplexProperty;
import kd.bos.dataentity.metadata.IDataEntityProperty;
import kd.bos.dataentity.metadata.IDataEntityType;
import kd.bos.entity.datamodel.IDataModel;
import kd.bos.entity.operate.result.IOperateInfo;
import kd.bos.entity.operate.result.OperationResult;
import kd.bos.entity.ValueMapItem;
import kd.bos.entity.property.BasedataProp;
import kd.bos.entity.property.ComboProp;
import kd.bos.entity.property.MulBasedataProp;
import kd.bos.entity.property.MulComboProp;
import kd.bos.orm.query.QFilter;
import kd.bos.servicehelper.QueryServiceHelper;

/**
 * 不是探针，是共用类：`--expect` 的**唯一实现**。各个仿真器都从这里断言。
 *
 * 为什么要收敛：`--expect` 原来只有 `run callback` / `run flow` 有，各写各的解析。
 * 一旦每个适配器自己解析，「分录[2].字段 怎么写」「数字比不比标度」就会各不相同 ——
 * 而用例是照着一个适配器写完再抄到另一个的，形状不一致的代价全落在写用例的人身上。
 *
 * 五个入口对应五种被断言的东西：
 * <pre>
 *   model(model, spec)              表单/回调/流程 —— key 全是字段路径
 *   operation(result, obj, spec)    操作沙箱 —— success/message/error 是保留字，其余是字段路径
 *   facts(facts, spec)              列表 —— key 只能是仿真器报出来的那几个事实名
 *   converted(ok, msg, bills, spec) 下推 —— success/message/bills 是保留字，其余是目标单上的字段路径
 *   workflow(err, results, bill, spec) 工作流插件 —— error/result 是保留字，其余是插件跑完后的单据字段路径
 * </pre>
 *
 * 字段路径的写法与 `--set` 一致：`字段`、`分录标识.字段`、`分录标识[2].字段`、
 * `分录标识[2].子分录标识[1].字段`。断言本身一律走 {@link ProbeAssert}
 * （数字按值比、失败也把剩下的跑完）。字段按完整路径和属性类型取值：对象逐层读取，集合定位行；同名 id 不回退到单头。
 *
 * <b>值的写法也收在这里</b>（{@link #convert}）。收敛前是四份各不相同的实现：
 * <pre>
 *   OpSandbox.coerce        按属性类型转，认日期，但基础资料只认单选
 *   FormSim.value           只特判单选基础资料，日期原样丢给 IDataModel
 *   RuleSim.coerce          只在**表头**属性里找基础资料，分录上的一律当文本
 *   FormCallbackSim.scalar  按字面猜 true/false/null，完全不看属性
 * </pre>
 * 于是同一条 `--set 日期字段=2026-01-01` 在 `run op` 下是 Date、在 `run form` 下是字符串，
 * 而用例正是照着一个适配器写完再抄到另一个的 —— 形状不一致的代价全落在写用例的人身上，
 * 这与当初把路径解析收敛成 {@link Pos} 是同一条理由。
 */
public final class ExpectSpec {

    /** 操作沙箱的保留字，不当字段路径解析。 */
    private static final String OP_SUCCESS = "success";
    private static final String OP_MESSAGE = "message";
    private static final String OP_ERROR = "error";
    /** 下推生成了几张目标单。 */
    private static final String PUSH_BILLS = "bills";
    /** 工作流插件方法的返回值。 */
    private static final String WF_RESULT = "result";
    private static final String WF_NO_THROW = "(没抛异常)";

    private ExpectSpec() {
    }

    /** 拆成 key/value 对，保留书写顺序。`;` 分隔，第一个 `=` 分左右。 */
    public static List<String[]> pairs(String spec) {
        List<String[]> out = new ArrayList<String[]>();
        if (spec == null) {
            return out;
        }
        for (String one : spec.split(";")) {
            String s = one.trim();
            if (s.isEmpty()) {
                continue;
            }
            int eq = s.indexOf('=');
            if (eq <= 0) {
                throw new IllegalArgumentException("--expect 不是 字段=值 的形状：" + s);
            }
            out.add(new String[]{s.substring(0, eq).trim(), s.substring(eq + 1)});
        }
        return out;
    }

    /** 表单 / 回调 / 流程：断言页面模型上的字段终值。 */
    public static void model(IDataModel model, String spec) {
        for (String[] kv : pairs(spec)) {
            Pos pos = Pos.parse(kv[0]);
            Object actual;
            try {
                // 分录名称不能丢：id 等同名属性通过模型按字段查会命中单头。
                // 单头保留模型取值，分录和子分录按完整路径定位实际行。
                actual = pos.entry == null ? model.getValue(pos.field)
                        : valueOf(model.getDataEntity(true), pos);
                checkReference(model.getDataEntity(), pos, pos.original, true);
            } catch (Throwable t) {
                ProbeAssert.unresolved("field", pos.original, kv[1], "取不到值：" + brief(t));
                continue;
            }
            assertValue(pos.original, kv[1], actual);
        }
    }

    /**
     * 一条字段断言。**基础资料和多选不能按 toString 比** —— `DynamicObject.toString()`
     * 打的是「类型 + 存储数组」，拿它跟编码比对必红，而红的原因看不出是值不对还是没法比。
     * 多选走 {@link ProbeAssert#setEquals}：多选本身没有顺序，让断言随排列顺序红是错的。
     */
    private static void assertValue(String target, String want, Object actual) {
        if (actual instanceof DynamicObjectCollection) {
            List<String> got = new ArrayList<String>();
            for (Object row : (DynamicObjectCollection) actual) {
                got.add(render(row));
            }
            ProbeAssert.setEquals("field", target, want, got);
            return;
        }
        ProbeAssert.isEqual("field", target, want, comparable(want, actual));
    }

    /** 单值字段按断言的写法渲染：基础资料打编码，日期按期望值写到的精度。 */
    private static String comparable(String want, Object actual) {
        String rendered = render(actual);
        // Date.toString() produces e.g. "Tue Sep 01 00:00:00 CST 2026" while
        // --set and case files use stable ISO literals. Normalize only when the
        // expected value explicitly asks for one of the documented date shapes;
        // other assertions keep the old rendering contract.
        if (actual instanceof Date && want != null) {
            if (want.matches("\\d{4}-\\d{2}-\\d{2}")) {
                rendered = new SimpleDateFormat("yyyy-MM-dd").format((Date) actual);
            } else if (want.matches("\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}")) {
                rendered = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss").format((Date) actual);
            }
        }
        return rendered;
    }

    /**
     * 打开已有单据跑之前，记下 `--expect` 里这次没有 `--set` 的字段现在的值（路径 → 断言写法的值）。
     *
     * 真提交之后改过的值留在单上，下一次拿同一张单再跑、又没给这个字段赋值，断言就可能碰巧对上。
     * 跑完拿 {@link #notePrior} 对照。多选、取不到值的不记；新建的单没有「上次留下的值」，不用调。
     */
    public static Map<String, String> priorValues(DynamicObject obj, String expectSpec, String setSpec) {
        Map<String, String> prior = new LinkedHashMap<String, String>();
        if (obj == null || expectSpec == null || expectSpec.trim().isEmpty()) {
            return prior;
        }
        Set<String> assigned = new HashSet<String>();
        for (String one : (setSpec == null ? "" : setSpec).split(";")) {
            int eq = one.indexOf('=');
            if (eq > 0) {
                try {
                    assigned.add(Pos.parse(one.substring(0, eq).trim()).toString());
                } catch (RuntimeException ignored) {
                    // 写错的 --set 另有核对报出来，这里不重复
                }
            }
        }
        List<String[]> expects;
        try {
            expects = pairs(expectSpec);
        } catch (RuntimeException malformed) {
            return prior;
        }
        for (String[] kv : expects) {
            String key = kv[0];
            if (OP_SUCCESS.equals(key) || OP_MESSAGE.equals(key) || OP_ERROR.equals(key)) {
                continue;
            }
            try {
                Pos pos = Pos.parse(key);
                if (assigned.contains(pos.toString())) {
                    continue;
                }
                Object value = valueOf(obj, pos);
                if (!(value instanceof DynamicObjectCollection)) {
                    prior.put(pos.original, comparable(kv[1], value));
                }
            } catch (Throwable ignored) {
                // 跑之前取不到（分录行还没有）就没有「原来的值」可比
            }
        }
        return prior;
    }

    /**
     * 断言过了、但跑之前单上就已经是期望值、这次也没 `--set` 它：打一行说明。PASS 照记——值确实对，
     * 只是这次运行证明不了它是这次改出来的。
     */
    public static void notePrior(Map<String, String> prior, DynamicObject after, String expectSpec) {
        if (prior == null || prior.isEmpty() || after == null) {
            return;
        }
        for (String[] kv : pairs(expectSpec)) {
            Pos pos;
            try {
                pos = Pos.parse(kv[0]);
            } catch (RuntimeException e) {
                continue;
            }
            String path = pos.original;
            if (!prior.containsKey(path) || !ProbeAssert.same(kv[1], prior.get(path))) {
                continue;
            }
            String now;
            try {
                now = comparable(kv[1], valueOf(after, pos));
            } catch (Throwable t) {
                continue;
            }
            if (ProbeAssert.same(kv[1], now)) {
                System.out.println("[PROBE] ⚠ 断言 " + path + "=" + kv[1] + " 跑之前单上就是这个值，这次也没 --set 它："
                        + "PASS 证明不了是这次改出来的，可能是上次运行留下的");
            }
        }
    }

    /**
     * 操作沙箱：`success` / `message` / `error` 断操作结果，其余 key 断操作**跑完之后**
     * 单据对象上的字段值 —— 操作插件往单据上写了什么，只有这一条路看得见。
     *
     * `message` 和 `error` 是**包含**，不是相等：苍穹的校验消息带字段显示名和标点，
     * 逐字比对等于把断言绑死在文案上。
     *
     * 验「会被拦」（`success=false` 加 `message` / `error`）时，逐条报出来的错每一条都得对得上写明的某一句，
     * 否则这次按「输入不成立」处理、不留验证记录：拦住它的还有别的原因，「没成功」算不到要验的那条头上。
     * 真机 2026-10-08：拿一张已经提交过的单验新加的提交校验，平台的「只有暂存的数据才允许提交」和新校验一起报，
     * 两条断言照样全过、记成了验证记录——模型自己看出不对才换单重验。只写 `success=false`、没写原因的照旧按结果判。
     *
     * 不记 FAIL：改法多半是换一张单，`--pk` 在场景键里，换了就是另一个场景，留一条 FAIL 它就永远换不掉、
     * 交付一直被挡着（和 pk 查不到、--set 写错同一条理由，见 ProbeAssert.inputInvalid）。
     */
    public static void operation(OperationResult result, DynamicObject obj, String spec) {
        operation(result, obj, spec, false);
    }

    public static void operation(OperationResult result, DynamicObject obj, String spec, boolean databaseReadback) {
        //操作没成功时，字段值读的是插件改过的内存对象，不是落库结果——照读照比会打出
        //「✔ PASS」，而那张单根本没存进去。真机 2026-09-17：提交在写映射表时撞主键失败，
        //creator 断言仍然 PASS。只有明说要验失败（success=false）的，才照读字段。
        boolean failed = result == null || !result.isSuccess();
        boolean expectsFailure = false;
        List<String> causes = new ArrayList<String>();
        for (String[] kv : pairs(spec)) {
            if (OP_SUCCESS.equals(kv[0]) && "false".equalsIgnoreCase(kv[1].trim())) {
                expectsFailure = true;
            }
            if ((OP_MESSAGE.equals(kv[0]) || OP_ERROR.equals(kv[0])) && !kv[1].trim().isEmpty()) {
                causes.add(kv[1]);
            }
        }
        List<String> others = expectsFailure && failed && !causes.isEmpty()
                ? unexplained(result, causes) : new ArrayList<String>();
        for (String[] kv : pairs(spec)) {
            String key = kv[0];
            String want = kv[1];
            if (OP_SUCCESS.equals(key)) {
                if (result == null) {
                    ProbeAssert.unresolved("op-success", key, want, "操作没有返回结果对象，不能据此判断未执行或未提交");
                } else if (!others.isEmpty() && "false".equalsIgnoreCase(want.trim())) {
                    ProbeAssert.inputInvalid("op-success", key,
                            "拦住它的还有 " + others.size() + " 条没写进 --expect：「" + String.join("」「", others)
                                    + "」，这次没成功算不到要验的那条头上。换一张只会被要验的那条拦住的单；"
                                    + "这几条本来就该一起出现的，各加一条 --expect error=原话");
                } else {
                    ProbeAssert.isEqual("op-success", key, want, String.valueOf(result.isSuccess()));
                }
                continue;
            }
            if (OP_MESSAGE.equals(key)) {
                if (result == null) {
                    ProbeAssert.unresolved("op-message", key, want, "操作没有返回结果对象，不能据此判断未执行或未提交");
                } else {
                    ProbeAssert.containsText("op-message", key, want, shownMessage(result));
                }
                continue;
            }
            if (OP_ERROR.equals(key)) {
                ProbeAssert.containsText("op-error", key, want, allErrors(result));
                continue;
            }
            Pos pos = Pos.parse(key);
            if (failed && !expectsFailure && !databaseReadback) {
                ProbeAssert.unresolved("field", pos.original, want,
                        result == null
                                ? "操作没有返回结果对象，内存值不能证明落库结果"
                                : "操作没成功（isSuccess=false），读到的只是内存里的值，不能据此判断是否落库；"
                                        + "先让操作成功，或者本来就要验失败就加 success=false");
                continue;
            }
            try {
                checkReference(obj, pos, pos.original, true);
                assertValue(pos.original, want, valueOf(obj, pos));
            } catch (Throwable t) {
                ProbeAssert.unresolved("field", pos.original, want, "取不到值：" + brief(t));
            }
        }
    }

    /**
     * 下推（`run push`）：`success` / `message` / `bills` 是保留字，断言转换结果和生成了几张目标单；
     * 其余是**目标单**上的字段路径。路径前加 `[n].` 指第 n+1 张目标单（规则按分单策略可能从一张源单生成好几张），
     * 不加是第一张。
     *
     * <p>和 {@link #operation} 同一条理由：转换没成功就没有目标单，字段断言记「不算数」，除非明说要验失败。</p>
     */
    public static void converted(boolean success, String message, List<DynamicObject> bills, String spec) {
        boolean expectsFailure = false;
        for (String[] kv : pairs(spec)) {
            if (OP_SUCCESS.equals(kv[0]) && "false".equalsIgnoreCase(kv[1].trim())) {
                expectsFailure = true;
            }
        }
        int made = bills == null ? 0 : bills.size();
        for (String[] kv : pairs(spec)) {
            String key = kv[0];
            String want = kv[1];
            if (OP_SUCCESS.equals(key)) {
                ProbeAssert.isEqual("push-success", key, want, String.valueOf(success));
                continue;
            }
            if (OP_MESSAGE.equals(key)) {
                ProbeAssert.containsText("push-message", key, want, message);
                continue;
            }
            if (PUSH_BILLS.equals(key)) {
                ProbeAssert.isEqual("push-bills", key, want, String.valueOf(made));
                continue;
            }
            int index = 0;
            String path = key;
            if (key.startsWith("[")) {
                int close = key.indexOf("].");
                String digits = close < 0 ? "" : key.substring(1, close).trim();
                if (!digits.matches("\\d{1,4}")) {
                    ProbeAssert.unresolved("field", key, want, "目标单下标写成 [n].字段，n 从 0 数");
                    continue;
                }
                index = Integer.parseInt(digits);
                path = key.substring(close + 2);
            }
            if (!success && !expectsFailure) {
                ProbeAssert.unresolved("field", key, want,
                        "下推没成功，没有目标单，这条不算数；先让下推成功，或者本来就要验失败就加 success=false");
                continue;
            }
            if (index >= made) {
                ProbeAssert.unresolved("field", key, want, "这次只生成了 " + made + " 张目标单，没有第 " + (index + 1) + " 张");
                continue;
            }
            Pos pos = Pos.parse(path);
            try {
                checkReference(bills.get(index), pos, key, true);
                assertValue(key, want, valueOf(bills.get(index), pos));
            } catch (Throwable t) {
                ProbeAssert.unresolved("field", key, want, "取不到值：" + brief(t));
            }
        }
    }

    /**
     * 工作流插件（`run wf`）：`error=` 断言插件没抛异常、`error~=片段` 断言抛了；`result`、`result.字段` 断言方法返回值
     * （调用方把返回值拆成 名字 → 文字 交进来）；其余是插件跑完之后**从库里重新读出来**的单据上的字段路径。
     * 键后面加 `~` 是包含。插件抛了异常时，字段断言记「不算数」，除非这次就是要验它抛异常。
     */
    public static void workflow(Throwable thrown, Map<String, String> results, DynamicObject bill, String spec) {
        boolean expectsError = false;
        for (String[] kv : pairs(spec)) {
            String key = kv[0].endsWith("~") ? kv[0].substring(0, kv[0].length() - 1).trim() : kv[0];
            expectsError |= OP_ERROR.equals(key) && !kv[1].trim().isEmpty();
        }
        for (String[] kv : pairs(spec)) {
            boolean contains = kv[0].endsWith("~");
            String key = contains ? kv[0].substring(0, kv[0].length() - 1).trim() : kv[0];
            String want = kv[1];
            if (OP_ERROR.equals(key)) {
                String actual = thrown == null ? WF_NO_THROW : brief(thrown);
                if (want.trim().isEmpty()) {
                    ProbeAssert.isEqual("wf-error", kv[0], WF_NO_THROW, actual);
                } else {
                    ProbeAssert.containsText("wf-error", kv[0], want, actual);
                }
                continue;
            }
            if (WF_RESULT.equals(key) || key.startsWith(WF_RESULT + ".")) {
                if (thrown != null) {
                    ProbeAssert.unresolved("wf-result", kv[0], want, "插件抛了异常，没有返回值：" + brief(thrown));
                } else if (!results.containsKey(key)) {
                    ProbeAssert.unresolved("wf-result", kv[0], want, results.isEmpty() ? "这个方法没有返回值"
                            : "返回值里没有 " + key + "，能断的：" + join(new ArrayList<String>(results.keySet())));
                } else if (contains) {
                    ProbeAssert.containsText("wf-result", kv[0], want, results.get(key));
                } else {
                    ProbeAssert.isEqual("wf-result", kv[0], want, results.get(key));
                }
                continue;
            }
            if (thrown != null && !expectsError) {
                ProbeAssert.unresolved("field", kv[0], want,
                        "插件抛了异常，单据上的值不是它跑完的结果，这条不算数：" + brief(thrown));
                continue;
            }
            try {
                Pos pos = Pos.parse(key);
                if (contains) {
                    ProbeAssert.containsText("field", kv[0], want, render(valueOf(bill, pos)));
                } else {
                    checkReference(bill, pos, pos.original, true);
                    assertValue(pos.original, want, valueOf(bill, pos));
                }
            } catch (Throwable t) {
                ProbeAssert.unresolved("field", kv[0], want, "取不到值：" + brief(t));
            }
        }
    }

    /**
     * 列表：只认仿真器报出来的事实名。**不认识的 key 记 FAIL 并列出合法名** ——
     * 静默跳过会让人以为断言过了。
     *
     * 单值和多值分两个 map 传，不靠 key 长相猜：猜错的后果是「列清单」被当成一个长字符串
     * 逐字比，顺序一变就红。
     */
    public static void facts(Map<String, String> scalars, Map<String, List<String>> sets,
            String kind, String spec) {
        for (String[] kv : pairs(spec)) {
            String key = kv[0];
            if (scalars.containsKey(key)) {
                ProbeAssert.isEqual(kind, key, kv[1], scalars.get(key));
            } else if (sets.containsKey(key)) {
                ProbeAssert.setEquals(kind, key, kv[1], sets.get(key));
            } else {
                List<String> legal = new ArrayList<String>(scalars.keySet());
                legal.addAll(sets.keySet());
                ProbeAssert.unresolved(kind, key, kv[1], "不是能断的名字，合法的有 " + legal.size()
                        + " 个：" + join(legal));
            }
        }
    }

    /** 单据对象上按路径取值。分录行不存在时抛出，由调用方记 unresolved。 */
    public static Object valueOf(DynamicObject obj, Pos pos) {
        return hostOf(obj, pos).get(pos.leaf());
    }

    /** 只显示也附真实外键；对象为空而外键非空也必须暴露。 */
    public static String showValue(DynamicObject obj, Pos pos) {
        checkReference(obj, pos, pos.original, false);
        return ProbeAssert.shown(render(valueOf(obj, pos)));
    }

    public static void checkReference(DynamicObject obj, Pos pos, String target, boolean assertConsistent) {
        DynamicObject host = hostOf(obj, pos);
        IDataEntityProperty prop = host.getDataEntityType().getProperties().get(pos.leaf());
        if (!(prop instanceof BasedataProp)) return;
        IDataEntityProperty ref = ((BasedataProp) prop).getRefIdProp();
        if (ref == null) throw new IllegalStateException("基础资料 " + target + " 没有可读取的外键属性");
        Object value = prop.getValue(host);
        Object objectId = value instanceof DynamicObject ? ((DynamicObject) value).getPkValue() : null;
        Object fk = ref.getValue(host);
        System.out.println("[PROBE]   " + target + " 对象内码=" + ProbeAssert.shown(emptyId(objectId))
                + "  " + ref.getName() + "=" + ProbeAssert.shown(emptyId(fk)) + "（落库以此外键为准）");
        if (assertConsistent) {
            ProbeAssert.isEqual("reference-id", target + " -> " + ref.getName(), emptyId(objectId), emptyId(fk));
        }
    }

    private static String emptyId(Object id) {
        return id == null || "0".equals(String.valueOf(id)) ? "" : String.valueOf(id);
    }

    private static DynamicObject hostOf(DynamicObject obj, Pos pos) {
        if (obj == null) {
            throw new IllegalStateException("没有单据对象");
        }
        DynamicObject host = obj;
        String[] parts = pos.original.split("\\.");
        for (int i = 0; i < parts.length - 1; i++) {
            int[] index = new int[1];
            String key = Pos.seg(parts[i], index);
            IDataEntityProperty property = host.getDataEntityType().getProperties().get(key);
            if (property == null) throw new IllegalArgumentException("没有属性 " + key);
            Object value = property.getValue(host);
            if (property instanceof ICollectionProperty) {
                DynamicObjectCollection rows = (DynamicObjectCollection) value;
                if (rows == null || index[0] < 0 || index[0] >= rows.size()) {
                    throw new IllegalStateException("分录 " + key + " 取不到第 " + index[0] + " 行");
                }
                host = rows.get(index[0]);
            } else if (property instanceof IComplexProperty) {
                if (parts[i].indexOf('[') >= 0) throw new IllegalArgumentException(key + " 是对象，不能指定行号");
                if (value == null) throw new IllegalStateException("对象 " + key + " 为空，取不到下级字段");
                host = (DynamicObject) value;
            } else {
                throw new IllegalArgumentException(key + " 不是对象或分录，不能读取下级字段");
            }
        }
        return host;
    }

    // ------------------------------------------------------------------ 值

    /**
     * `--set` 的**唯一值转换**：字符串 → 这个属性要的类型。五个适配器都从这里转。
     *
     * <pre>
     *   null / 空                     → null（清空字段；文本字段想写字面量 "null" 写不了，认了）
     *   单选基础资料                    → id（纯数字先按 id 查，查不到回落 number；两边都查不到就抛）
     *   多选基础资料                    → id 数组（逗号分隔）；MulBasedataProp.setFieldValue 认 Object[]
     *   日期 / 时间                    → Date（now / yyyy-MM-dd / yyyy-MM-dd HH:mm:ss，非法日期报错不顺延）
     *   小数 / 整数 / 布尔              → 对应包装类型
     *   其余（含下拉、多选下拉、文本）     → 原样字符串
     * </pre>
     *
     * <b>下拉原样传存储值</b>：ComboProp 存的是 items 里的**值**，写显示名会被存进去、
     * 界面显示空白且不报错。写成了某一项的显示名时抛出，说明该写哪个存储值（{@link #comboNameProblem}）。
     */
    public static Object convert(IDataEntityProperty p, String raw) {
        String val = raw == null ? null : raw.trim();
        if (val == null || val.isEmpty() || "null".equalsIgnoreCase(val)) {
            return null;
        }
        if (p == null) {
            return val;
        }
        String combo = comboNameProblem(p, val);
        if (combo != null) {
            throw new IllegalArgumentException(combo);
        }
        //MulBasedataProp 不是 BasedataProp 的子类（它是 DynamicCollectionProperty），
        //两条分支互不遮挡，但先判多选仍然更稳：将来若有人改继承链，顺序也不会变成静默错值
        if (p instanceof MulBasedataProp) {
            return basedataIds(((MulBasedataProp) p).getBaseEntityId(), val);
        }
        if (p instanceof BasedataProp) {
            return basedataId(((BasedataProp) p).getBaseEntityId(), val);
        }
        return scalar(p.getPropertyType(), val);
    }

    /**
     * 下拉写成了显示名：返回「写成哪个存储值」；不是下拉、写的是存储值、或两边都对不上时返回 null。
     *
     * 只拦有把握的那一种：不是任何一项的存储值、却正好是某一项的显示名。两边都对不上的放行——
     * 下拉项可以由插件在运行时补，元数据里的 items 不一定是全部。多选下拉按逗号逐项核。
     */
    public static String comboNameProblem(IDataEntityProperty p, String raw) {
        if (!(p instanceof ComboProp) || raw == null) {
            return null;
        }
        String val = raw.trim();
        if (val.isEmpty() || "null".equalsIgnoreCase(val)) {
            return null;
        }
        List<ValueMapItem> items = ((ComboProp) p).getComboItems();
        if (items == null || items.isEmpty()) {
            return null;
        }
        String[] parts = p instanceof MulComboProp ? val.split(",") : new String[]{val};
        List<String> stored = new ArrayList<String>();
        boolean named = false;
        for (String one : parts) {
            String s = one.trim();
            if (s.isEmpty()) {
                continue;
            }
            String byName = null;
            boolean isValue = false;
            for (ValueMapItem it : items) {
                if (s.equals(it.getValue())) {
                    isValue = true;
                    break;
                }
                if (byName == null && it.getName() != null && s.equals(String.valueOf(it.getName()).trim())) {
                    byName = it.getValue();
                }
            }
            if (!isValue && byName != null) {
                named = true;
                stored.add(byName);
            } else {
                stored.add(s);
            }
        }
        if (!named) {
            return null;
        }
        return "下拉 " + p.getName() + " 要写存储值，「" + val + "」是显示名；写成 " + String.join(",", stored);
    }

    /** 按路径找属性再转值；属性找不到时按文本原样返回，由调用方去报「没有这个字段」。 */
    public static Object convert(IDataEntityType root, Pos pos, String raw) {
        return convert(propAt(root, pos), raw);
    }

    /** 字段所在那一层的属性；分录/子分录/字段标识写错时返回 null。 */
    public static IDataEntityProperty propAt(IDataEntityType root, Pos pos) {
        IDataEntityType host = hostType(root, pos);
        Object p = host == null ? null : host.getProperties().get(pos.leaf());
        return p instanceof IDataEntityProperty ? (IDataEntityProperty) p : null;
    }

    /**
     * 字段所在那一层的类型：表头是单据本身，分录/子分录是行类型。
     *
     * 分录字段**不在** MainEntityType 的顶层属性里 —— 按顶层查必然落空，而落空的表现是
     * 「当成普通文本原样写进去」，不是报错。
     */
    public static IDataEntityType hostType(IDataEntityType root, Pos pos) {
        IDataEntityType host = root;
        String[] parts = pos.original.split("\\.");
        for (int i = 0; host != null && i < parts.length - 1; i++) {
            int[] index = new int[1];
            String key = Pos.seg(parts[i], index);
            Object p = host.getProperties().get(key);
            host = p instanceof ICollectionProperty ? ((ICollectionProperty) p).getItemType()
                    : p instanceof IComplexProperty && parts[i].indexOf('[') < 0
                    ? ((IComplexProperty) p).getComplexType() : null;
        }
        return host;
    }

    /** 分录/子分录属性的行类型；不是集合属性（写错了标识）时返回 null。 */
    public static IDataEntityType itemType(IDataEntityType host, String entry) {
        Object p = host.getProperties().get(entry);
        return p instanceof ICollectionProperty ? ((ICollectionProperty) p).getItemType() : null;
    }

    /**
     * 单选基础资料：纯数字先按 id 查，查不到再拿原字面按 number 查。
     *
     * number 不能用 Long 转换后的值：`001` 这类带前导零的纯数字编码在苍穹项目里很常见，
     * 转成 1 后再查会永远错过它。两条路径都查不到必须抛，不能把不存在的 id 交给
     * IDataModel 静默写成 null。
     */
    public static Object basedataId(String base, String val) {
        if (val.matches("\\d+")) {
            try {
                Long id = Long.valueOf(val);
                DynamicObject byId = QueryServiceHelper.queryOne(base, "id",
                        new QFilter[]{new QFilter("id", "=", id)});
                if (byId != null) {
                    return byId.get("id");
                }
            } catch (NumberFormatException ignored) {
                // 超出 Long 范围的纯数字仍可能是合法编码，继续按原字面查 number。
            }
        }
        DynamicObject one = QueryServiceHelper.queryOne(base, "id",
                new QFilter[]{new QFilter("number", "=", val)});
        if (one == null) {
            throw new IllegalArgumentException(base + " 里找不到 id 或编码「" + val + "」");
        }
        return one.get("id");
    }

    /** 多选基础资料：逗号分隔的 id/编码 → id 数组。一项查不到就整条抛，不写半截。 */
    public static Object[] basedataIds(String base, String val) {
        List<Object> ids = new ArrayList<Object>();
        for (String one : val.split(",")) {
            String s = one.trim();
            if (!s.isEmpty()) {
                ids.add(basedataId(base, s));
            }
        }
        return ids.toArray();
    }

    /** 非基础资料按属性的目标类型转。转不动的照实抛，绝不退回成字符串。 */
    public static Object scalar(Class<?> type, String val) {
        if (type == null || type == String.class) {
            return val;
        }
        if (type == Boolean.class || type == boolean.class) {
            return "1".equals(val) || Boolean.parseBoolean(val);
        }
        try {
            if (type == Integer.class || type == int.class) {
                return Integer.valueOf(val);
            }
            if (type == Long.class || type == long.class) {
                return Long.valueOf(val);
            }
            if (type == BigDecimal.class) {
                return new BigDecimal(val);
            }
        } catch (NumberFormatException e) {
            throw new IllegalArgumentException("要一个 " + type.getSimpleName() + "，给的是「" + val + "」");
        }
        if (Date.class.isAssignableFrom(type)) {
            return date(val);
        }
        return val;
    }

    /**
     * 日期：`now` / `yyyy-MM-dd` / `yyyy-MM-dd HH:mm:ss`。
     *
     * `setLenient(false)`：宽松模式下 `2026-13-45` 会被顺延成 2027-02-14 而**不报错**，
     * 那是一个断言查不出来的错值。
     */
    public static Date date(String val) {
        if ("now".equalsIgnoreCase(val)) {
            return new Date();
        }
        SimpleDateFormat fmt = new SimpleDateFormat(val.length() > 10 ? "yyyy-MM-dd HH:mm:ss" : "yyyy-MM-dd");
        fmt.setLenient(false);
        try {
            return fmt.parse(val);
        } catch (ParseException e) {
            throw new IllegalArgumentException("日期要 yyyy-MM-dd 或 yyyy-MM-dd HH:mm:ss（或 now），给的是「"
                    + val + "」");
        }
    }

    /**
     * 断言/打印用的可读值：基础资料打 number（取不到打 pk），其余按 toString。
     *
     * 只打 number 不打显示名 —— 断言比的就是这个字符串，带上「(名称)」等于要求写用例的人
     * 把名称也抄对，而名称是会改的。
     */
    public static String render(Object value) {
        if (value == null) {
            return null;
        }
        if (!(value instanceof DynamicObject)) {
            return String.valueOf(value);
        }
        DynamicObject o = (DynamicObject) value;
        //多选基础资料的每一行是个壳，真正的基础资料挂在 fbasedataid 上
        if (o.getDataEntityType().getProperties().containsKey(MulBasedataProp.KEY_BASEDATAID)) {
            Object inner = o.get(MulBasedataProp.KEY_BASEDATAID);
            if (inner instanceof DynamicObject) {
                return render(inner);
            }
        }
        return o.getDataEntityType().getProperties().containsKey("number")
                ? o.getString("number") : String.valueOf(o.getPkValue());
    }

    /**
     * 用户在界面上看到的提示：顶上那句加下面逐条列出的错。
     *
     * 校验器拦住时 getMessage() 只有一句「数据校验发现错误。」，校验器自己的话在逐条错误里；
     * 界面上两样一起弹出来。只比顶上那句，照用户看到的写 message=校验器原话就对不上
     * （真机 2026-10-07 连着三次复测都先写成 message=，失败后翻文档、读探针源码才改成 error=）。
     */
    private static String shownMessage(OperationResult result) {
        String top = result.getMessage() == null ? "" : result.getMessage();
        String items = allErrors(result);
        return items == null || items.isEmpty() ? top : top.isEmpty() ? items : top + " | " + items;
    }

    /** 逐条报出来的错里，哪句都对不上的那几条（同一句报多次只算一条）。比法和 containsText 一样。 */
    private static List<String> unexplained(OperationResult result, List<String> causes) {
        Set<String> out = new LinkedHashSet<String>();
        if (result == null) {
            return new ArrayList<String>();
        }
        for (IOperateInfo info : result.getAllErrorOrValidateInfo()) {
            if (info.getMessage() == null || info.getMessage().trim().isEmpty()) {
                continue;
            }
            String text = ProbeAssert.shown(HeadlessUiSupport.oneLine(info.getMessage()));
            boolean named = false;
            for (String cause : causes) {
                named |= text.contains(ProbeAssert.shown(cause));
            }
            if (!named) {
                out.add(text);
            }
        }
        return new ArrayList<String>(out);
    }

    private static String allErrors(OperationResult result) {
        if (result == null) {
            return null;
        }
        StringBuilder sb = new StringBuilder();
        for (IOperateInfo info : result.getAllErrorOrValidateInfo()) {
            if (sb.length() > 0) {
                sb.append(" | ");
            }
            sb.append(HeadlessUiSupport.oneLine(info.getMessage()));
        }
        return sb.toString();
    }

    /** 合法名可能上百个（界面规则一张布局能碰两百个字段），全列出来那一行没人读得完 */
    private static final int LIST_CAP = 12;

    private static String join(List<String> items) {
        StringBuilder sb = new StringBuilder();
        //不全列：断言报错里的合法名摘要，全量在同一份输出的终态表里
        for (int i = 0; i < items.size() && i < LIST_CAP; i++) {
            if (sb.length() > 0) {
                sb.append('/');
            }
            sb.append(items.get(i));
        }
        if (items.size() > LIST_CAP) {
            sb.append(" …（余 ").append(items.size() - LIST_CAP).append(" 个，看上面那张终态表）");
        }
        return sb.toString();
    }

    private static String brief(Throwable t) {
        return t.getClass().getSimpleName() + ": " + HeadlessUiSupport.oneLine(t.getMessage());
    }

    /**
     * 字段路径：`字段` / `分录.字段` / `分录[2].字段` / `分录[2].子分录[1].字段`。
     *
     * 三段形态是后加的。此前只切**第一个点**，于是 `分录.子分录.字段` 被拆成
     * entry=分录、field=`子分录.字段` —— 一个不存在的属性名。表现不是「不支持」，
     * 而是一条**普通的失败断言**（`实际=(取不到)`），写断言的人会去查一个根本不存在的
     * 业务缺陷。所以这里宁可多切一层，也不留那种失败方式。
     */
    public static final class Pos {
        public final String entry;
        public final int row;
        /** 子分录标识；只有两段或表头路径时为 null。 */
        public final String sub;
        public final int subRow;
        public final String field;

        public final String original;

        public String leaf() { return original.substring(original.lastIndexOf('.') + 1); }

        private Pos(String entry, int row, String sub, int subRow, String field, String original) {
            this.original = original;
            this.entry = entry;
            this.row = row;
            this.sub = sub;
            this.subRow = subRow;
            this.field = field;
        }

        /** `标识` 或 `标识[3]` → 下标写进 out[0]，返回去掉下标的标识。 */
        private static String seg(String text, int[] out) {
            int left = text.indexOf('[');
            if (left >= 0 && text.endsWith("]")) {
                out[0] = Integer.parseInt(text.substring(left + 1, text.length() - 1).trim());
                return text.substring(0, left);
            }
            out[0] = 0;
            return text;
        }

        public static Pos parse(String text) {
            int dot = text.indexOf('.');
            if (dot < 0) {
                return new Pos(null, 0, null, 0, text, text);
            }
            int[] row = new int[1];
            String entry = seg(text.substring(0, dot), row);
            String rest = text.substring(dot + 1);
            int dot2 = rest.indexOf('.');
            if (dot2 < 0) {
                return new Pos(entry, row[0], null, 0, rest, text);
            }
            int[] subRow = new int[1];
            String sub = seg(rest.substring(0, dot2), subRow);
            //第四段及以后没有对应的数据结构，连同点一起留在字段名里，属性查不到时会照实报
            return new Pos(entry, row[0], sub, subRow[0], rest.substring(dot2 + 1), text);
        }

        public String toString() {
            if (entry == null) {
                return field;
            }
            String head = entry + "[" + row + "]";
            return sub == null ? head + "." + field : head + "." + sub + "[" + subRow + "]." + field;
        }
    }
}
