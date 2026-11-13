import java.math.BigDecimal;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.Deque;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TimeZone;

import kd.bos.formula.FormulaEngine;
import kd.bos.formula.excel.UDFunction;
import kd.bos.print.business.formula.PrintFormulaManager;
import kd.bos.print.core.data.field.DateField;
import kd.bos.print.core.data.field.FlexField;
import kd.bos.print.core.data.field.MultiLangField;
import kd.bos.print.core.data.field.NullField;
import kd.bos.print.core.data.field.TextField;
import kd.bos.print.service.formula.AbstractPrintFormulaParser;
import kd.bos.print.service.formula.PrintFormulaExecute;
import kd.bos.print.service.formula.PrintFormulaValidate;

/**
 * 公式试算：这条公式写对了没有、算出来显示成什么（S32 3.1）。
 *
 * 为什么要有这一步：候选过了平台解析和拓扑审计，只说明**形状**对——公式本身写坏了
 * （函数名打错、少个括号、参数个数不对）照样存得进去，要等打印的时候才发现那一格是空的。
 * 2026-09-20 那次会话为了验一条公式另起了四个探针、花掉两分钟；现在它跟着整份提交一起跑，
 * 不多一次往返。
 *
 * 两个平台类各管一件事，都是打印自己的，不是通用公式引擎（`FormulaEngine` 验的是单个表达式，
 * 喂给它一条分段公式必然解析失败，2026-09-20 就是在这里绕的路）：
 *
 *   - `PrintFormulaValidate.executeExp` **写坏了会抛**，而且抛的是平台自己的人话
 *     （「函数CONCATX不存在」「IF函数需要3个参数。格式：IF(条件，真值，假值)。」）；
 *   - `PrintFormulaExecute.executeExp` 算出显示文本，**但公式写坏时它只返回空串、不抛**
 *     （2026-09-21 真机实测）。所以判对错看前者，看显示成什么用后者，两个都要。
 *
 * 判对错时字段操作数**原样**交给校验器：它按操作数的 `textFormat`（字段类型）自己换样例值——
 * 日期给一个日期、数值给一个数，和打印设计器里点「校验」是同一条路。先换成文字再交，
 * `YEAR(<日期字段>)` 就成了 `YEAR('审核日期')`，平台只能报「时间函数参数只接受日期字段」。
 *
 * 算显示成什么时操作数也原样交出去，只在每个操作数上放一个 `value`：执行器读字段值就读它，真打印时那里放的是
 * 打印取数做好的字段对象（日期是 `DateField`、文本是 `TextField`、空的是 `NullField`）。这里放同一种对象，
 * 再由执行器自己按字段类型和外层函数换值——`TO_CHAR` 拿到日期、`YEAR` 拿到日期文字、数值拿到数，和真打印同一条路。
 * 不放 `value` 直接交，执行器拿 null 去换值会 NPE（2026-09-21 实测）；先把字段换成文字常量再交，
 * 日期就成了一段文字，`YEAR` 收、`TO_CHAR` 不收（2026-10-19 真机：五条 `TO_CHAR(<日期>,'yyyy-MM-dd')` 都有值那一档全是空）。
 *
 * 换三档看三件事——**都空时兜底文字露没露出来、只有一个字段有值时另一行会不会留下孤零零的标点、
 * 都有值时是不是想要的样子**。换行记号 `_enter_` 原样留着，算出来就是真的换行。
 *
 * 执行器算某一行出了错**不抛**，只记一条 WARN「引擎进行计算有特殊情况」、那一行当空串（反编译 bos-print-service-8.0 核过），
 * 光看显示分不出「这一行本来就该空」和「这一行算崩了」。所以这里用 {@link Execute} 算：和执行器同一套算法，
 * 多记下哪一档哪一行报了错，写进那一档的显示里（确认单上「显示成」那一栏照样看得到），结论不再说「都过了」。
 * 不当成写坏了拦下：执行时的错有的取决于样例值像不像真数据（`SUBSTRING(<批号>,3,5)` 碰上两个字的样例名就越界），
 * 拦下只能整关跳过；校验器那一关的错才是公式本身的毛病。
 */
public final class PrintTplFormulaTry {

    private PrintTplFormulaTry() {
    }

    /** 一条公式试算的结果。 */
    public static final class Trial {
        /** 哪个控件，例如 `LayoutCell31(LayoutCell)`。 */
        public final String control;
        /** 公式读成人话，和确认单上那一栏同一个写法。 */
        public final String text;
        /** 这条公式用到的字段，按出现顺序。 */
        public final List<String> fields = new ArrayList<String>();
        /** 平台校验器的报错；null 表示这条公式写得没毛病。 */
        public String error;
        /** 报错时实际交给校验器的那句（字段写成「名字 标识，类型」）。 */
        public String input;
        /** 场景 -> 那一档算的时候平台报的错（执行器吞掉的那句）；没有就是都算出来了。 */
        public final Map<String, String> failed = new LinkedHashMap<String, String>();
        /** 平台说「函数 X 不存在」时的 X；别的报错为 null。 */
        public String missingFunction;
        /** missingFunction 在打印函数目录（内置 + 本进程登记）里相近的名字。 */
        public List<String> near = new ArrayList<String>();
        /** 场景 -> 这一格显示成什么。 */
        public final Map<String, String> shown = new LinkedHashMap<String, String>();

        Trial(String control, String text) {
            this.control = control;
            this.text = text;
        }
    }

    /** 候选里公式变过的那几个控件（新增的控件也算），按控件 id 对齐找出来。 */
    public static List<Trial> changed(Map<String, Object> before, Map<String, Object> after) {
        Map<String, Map<String, Object>> a = PrintTplDiff.byId(before);
        Map<String, Map<String, Object>> b = PrintTplDiff.byId(after);
        List<Trial> out = new ArrayList<Trial>();
        for (Map.Entry<String, Map<String, Object>> entry : b.entrySet()) {
            Object formula = entry.getValue().get("formulaData");
            if (!(formula instanceof List) || ((List<?>) formula).isEmpty()) continue;
            Map<String, Object> old = a.get(entry.getKey());
            if (old != null && json(old.get("formulaData")).equals(json(formula))) continue;
            out.add(one(PrintTplDiff.label(entry.getValue()), (List<?>) formula));
        }
        return out;
    }

    /** 试算一条公式。不抛：写坏了记在 `error` 上，由调用方决定拦不拦。 */
    public static Trial one(String control, List<?> formula) {
        Trial trial = new Trial(control, PrintTplDiff.formulaText(formula));
        List<Map<String, Object>> operands = operandsOf(formula);
        for (Map<String, Object> operand : operands) trial.fields.add(nameOf(operand));

        //先判对错：Execute 对写坏的公式只返回空串，不抛，光看它分不出「算出来是空」和「公式坏了」
        List<Object> checked = typed(formula);
        try {
            new PrintFormulaValidate().executeExp(checked);
        } catch (Throwable e) {
            trial.error = message(e);
            trial.input = inputText(checked);
            java.util.regex.Matcher m = MISSING.matcher(trial.error);
            if (m.find()) {
                trial.missingFunction = m.group(1);
                trial.near = FormulaCheck.near(trial.missingFunction, FormulaCheck.printNames(), 3);
            }
            return trial;
        }
        if (operands.isEmpty()) {
            run(trial, "固定文字", formula, operands, 0);
            return trial;
        }
        run(trial, "字段都空", formula, operands, 0);
        if (operands.size() > 1) run(trial, "只有第一个字段有值", formula, operands, 1);
        run(trial, "字段都有值", formula, operands, operands.size());
        return trial;
    }

    /** 打印校验器对不存在的函数的原话是「函数CONCATX不存在」（2026-09-21 真机实测）。 */
    private static final java.util.regex.Pattern MISSING =
            java.util.regex.Pattern.compile("函数\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*不存在");

    private static String inputText(List<Object> parts) {
        StringBuilder b = new StringBuilder();
        for (Object part : parts) {
            if (part instanceof Map) {
                Map<?, ?> operand = (Map<?, ?>) part;
                b.append("«").append(nameOf(operand)).append(" ").append(operand.get("bindField"))
                        .append("，").append(formatOf(operand)).append("»");
            } else {
                b.append("_enter_".equals(part) ? " ⏎ " : String.valueOf(part));
            }
        }
        return b.toString();
    }

    /** 公式原样复制一份交给校验器：它会往操作数里回写 textFormat，候选本身不能被改。 */
    private static List<Object> typed(List<?> formula) {
        List<Object> out = new ArrayList<Object>();
        for (Object part : formula) {
            out.add(part instanceof Map ? new LinkedHashMap<Object, Object>((Map<?, ?>) part) : part);
        }
        return out;
    }

    /**
     * 算一档：显示成什么记进 `shown`；执行器哪一行算崩了，平台原话记进 `failed`，也接在显示后面。
     *
     * 只接 Exception：平台类缺方法、换了签名这类 Error 往上抛，由调用方报「试算没跑成」，不冒充公式的错。
     */
    private static void run(Trial trial, String scene, List<?> formula, List<Map<String, Object>> operands,
            int filled) {
        Execute execute = new Execute();
        String out;
        try {
            out = execute.executeExp(valued(formula, operands, filled));
        } catch (Exception e) {
            execute.failures.add(message(e));
            out = null;
        }
        String shown = out == null ? "" : out;
        if (!execute.failures.isEmpty()) {
            String said = execute.failures.get(0);
            trial.failed.put(scene, said);
            shown += "（算不出来：" + said + " 打印时这一行是空的）";
        }
        trial.shown.put(scene, shown);
    }

    /** 公式复制一份，前 `filled` 个字段放样例值、其余放空值（`value`），换行记号和文字片段原样。 */
    private static List<Object> valued(List<?> formula, List<Map<String, Object>> operands, int filled) {
        List<Object> out = new ArrayList<Object>();
        for (Object part : formula) {
            if (!(part instanceof Map)) {
                out.add(part);
                continue;
            }
            Map<Object, Object> copy = new LinkedHashMap<Object, Object>((Map<?, ?>) part);
            int at = indexOf(operands, (Map<?, ?>) part);
            copy.put("value", sample(copy, at >= 0 && at < filled));
            out.add(copy);
        }
        return out;
    }

    /** 打印把页码、打印时间这类系统变量的数据源记成这个；执行器拿它的值原样去算，不换。 */
    private static final String SYSTEM_DS = "$DsKey=[System]";

    /**
     * 一个字段的样例值，做成打印取数交给执行器的同一种对象，由执行器按字段类型和外层函数自己换值。
     *
     * 日期给校验器同一个样例时刻；数值给 1；文本给字段自己的显示名（「批号」），算出来那句人一眼看得懂是哪来的。
     * 空的一律 `NullField`：执行器把它换成空串、数值换成 0、日期换成 null，和单据上这一栏没填时一样。
     * 系统变量不经过换值，给普通的值。
     */
    private static Object sample(Map<?, ?> operand, boolean filled) {
        String format = formatOf(operand);
        String name = nameOf(operand);
        boolean numeric = isNumeric(format);
        if (SYSTEM_DS.equals(String.valueOf(operand.get("dataSource")))) {
            if (numeric) return filled ? BigDecimal.ONE : BigDecimal.ZERO;
            if ("Date".equals(format)) return filled ? SAMPLE_TIME : null;
            if ("Time".equals(format)) return filled ? "01:02:03" : null;
            return filled ? name : "";
        }
        if (!filled) return NullField.get();
        if ("Date".equals(format)) {
            DateField date = new DateField(sampleDate());
            //和解析样例时刻用同一个时区，换成文字时不会差出一天
            date.setTimeZone(TimeZone.getDefault());
            return date;
        }
        if ("Time".equals(format)) return new TextField("01:02:03");
        if (numeric) return BigDecimal.ONE;
        if ("FlexField".equals(format)) return new FlexField(name);
        if ("MultiLangField".equals(format)) return new MultiLangField(name, new HashMap<String, String>());
        return new TextField(name);
    }

    /** 和打印校验器给日期字段的样例同一个时刻。 */
    private static final String SAMPLE_TIME = "2018-08-08 01:02:03";

    private static Date sampleDate() {
        try {
            return new SimpleDateFormat("yyyy-MM-dd HH:mm:ss").parse(SAMPLE_TIME);
        } catch (java.text.ParseException e) {
            throw new IllegalStateException(e);
        }
    }

    /**
     * 打印执行器同一套算法，多记一件事：哪一行算的时候平台报了错。
     *
     * `PrintFormulaExecute` 是 final，这里另起一个同一父类的子类。解析表达式、分行、认外层函数，全走父类原样的代码；
     * 字段值读 `value`、换值调执行器公开的 `transferVariableValueProcess`，和它自己一样；
     * 只有「逐行交给公式引擎」这一步照抄一遍，把它吞掉的报错记下来。执行器另外覆写的集合条件求和
     * （`dealConGather`）只在一个字段给了多行值时才多拼东西，这里每个字段只给一个值，父类原样返回就是同一个结果。
     */
    private static final class Execute extends AbstractPrintFormulaParser {
        /** 算崩的那几行，平台原话。 */
        final List<String> failures = new ArrayList<String>();
        private final PrintFormulaExecute platform = new PrintFormulaExecute();

        @Override
        @SuppressWarnings("rawtypes")
        protected Object getVariableValue(Map fieldItem, Deque<AbstractPrintFormulaParser.FunctionInfo> funStack) {
            return fieldItem.get("value");
        }

        @Override
        protected Object transferVariableValue(Object value, String dataSource, String textFormat, String function) {
            return platform.transferVariableValueProcess(value, dataSource, textFormat, function);
        }

        @Override
        protected StringBuilder executeFormulaCalculate(List<String> functions, Map<String, Object> variableMap) {
            UDFunction[] functionsInPrint =
                    PrintFormulaManager.getInstance().getUdFunctions().toArray(new UDFunction[0]);
            StringBuilder result = new StringBuilder();
            for (String function : functions) {
                if ("_enter_".equals(function)) {
                    result.append(System.lineSeparator());
                    continue;
                }
                try {
                    Object out = FormulaEngine.execExcelFormula(function, variableMap, functionsInPrint);
                    if (out == null) continue;
                    result.append(out instanceof BigDecimal ? ((BigDecimal) out).toPlainString() : out);
                } catch (Exception e) {
                    failures.add(message(e));
                }
            }
            return result;
        }
    }

    private static boolean isNumeric(String textFormat) {
        String f = textFormat == null ? "" : textFormat.toLowerCase();
        return f.contains("num") || f.contains("amount") || f.contains("decimal") || f.contains("int")
                || f.contains("qty") || f.contains("price");
    }

    private static String formatOf(Map<?, ?> operand) {
        Object type = operand.get("fieldType");
        if (type != null && !String.valueOf(type).trim().isEmpty()) return String.valueOf(type);
        Object format = operand.get("textFormat");
        return format == null ? "Text" : String.valueOf(format);
    }

    private static String nameOf(Map<?, ?> operand) {
        Object name = operand.get("formulaName");
        if (name != null && !String.valueOf(name).trim().isEmpty()) return String.valueOf(name).trim();
        Object field = operand.get("bindField");
        return field == null ? "字段" : String.valueOf(field);
    }

    /** 这条公式用到的字段操作数，按第一次出现的顺序，同一个 id 只算一个。 */
    private static List<Map<String, Object>> operandsOf(List<?> formula) {
        List<Map<String, Object>> out = new ArrayList<Map<String, Object>>();
        for (Object part : formula) {
            if (!(part instanceof Map)) continue;
            @SuppressWarnings("unchecked")
            Map<String, Object> m = (Map<String, Object>) part;
            if (indexOf(out, m) < 0) out.add(m);
        }
        return out;
    }

    private static int indexOf(List<Map<String, Object>> operands, Map<?, ?> operand) {
        String id = String.valueOf(operand.get("id"));
        for (int i = 0; i < operands.size(); i++) {
            if (id.equals(String.valueOf(operands.get(i).get("id")))) return i;
        }
        return -1;
    }

    private static String message(Throwable e) {
        String m = e.getMessage();
        if (m == null || m.trim().isEmpty()) m = e.getClass().getSimpleName();
        m = m.replace('\n', ' ').replace('\r', ' ').trim();
        return m.length() > 200 ? m.substring(0, 197) + "..." : m;
    }

    private static String json(Object value) {
        return value == null ? "null" : kd.bos.print.api.utils.SerializeUtils.toJsonString(value);
    }
}
