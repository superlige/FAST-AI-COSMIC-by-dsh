import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;

/**
 * 不是探针，是共用类：**断言原语**。探针里凡是「期望 X、实际 Y」的判断都走这里。
 *
 * 为什么要收敛成一个类：`verify` 判 PASS/FAIL 的唯一依据是 {@link ProbeJson} 旁路里
 * `t=assert` 的记录。每个探针各写各的打印，旁路里的字段名就会各不相同，verify 那头只能
 * 一个个特判 —— 那等于没有协议。所以断言只有一个出口，人读行和 JSON 行由它同时产出。
 *
 * 用法：
 * <pre>
 *     ProbeAssert.isEqual("field-scale", "zlgd_wtd.zlgd_lsmj", "4", scale);
 *     ProbeAssert.setEquals("combo-items", "zlgd_wtd.zlgd_jylx", "A,B,C", values);
 *     boolean allPass = ProbeAssert.summary();     //收尾必须调，否则「一条断言都没有」发不出去
 * </pre>
 *
 * 两条语义值得记住：
 * <ul>
 * <li><b>数字按值比，不按标度比。</b>期望 {@code 15.00} 和实际 {@code 15.0} 判 PASS ——
 * 标度是字段元数据的事实（拿 {@code field-scale} 断言它），不是这个值算错了。
 * 但旁路里落的仍是**原样字符串**（见 ProbeJson 里金额那段），比较方式和记录方式是两回事。</li>
 * <li><b>一条断言都没有 ≠ 通过。</b>{@link #summary()} 会发一条 {@code assert-none}，
 * verify 收到它只记 {@code EXECUTED}，不记 PASS。这条是编排门禁，不是提示。</li>
 * <li><b>值的显示和比较都用 {@link #shown} 那一种写法。</b>换行显示成 {@code \n}，
 * 期望里写 {@code \n} 还是真换行都一样比。</li>
 * </ul>
 */
public final class ProbeAssert {

    private static final List<String> FAILED = new ArrayList<String>();
    private static final List<String> INCOMPLETE = new ArrayList<String>();
    private static int total;
    private static int passed;
    private static int invalid;
    private static String caseId;

    private ProbeAssert() {
    }

    /**
     * 输入本身不成立时抛它：调用处已经 {@link #inputInvalid} 记过，外层的兜底 catch 认出它就不再补一条 FAIL。
     */
    public static final class InputInvalid extends IllegalStateException {
        public InputInvalid(String message) {
            super(message);
        }

        /** 不带调用栈，理由同 {@link Failed}：原因在「✘ 输入不成立」那一行，栈里只有探针自己的帧。 */
        @Override
        public synchronized Throwable fillInStackTrace() {
            return this;
        }
    }

    /**
     * 断言没全过时抛它结束运行。
     *
     * <p>不带调用栈：哪条没过、期望和实际各是什么，上面的 FAIL 行已经逐条说了，这里没有要定位的代码。
     * 带着栈时，运行末尾多出十几行探针和线程池自己的帧，输出被裁到头尾两段的时候，
     * 这些行占掉尾段，把「操作成没成、成功几张」挤进被省略的中段（真机 2026-10-11）。
     * 宿主见到没有栈的异常只打一行。</p>
     */
    public static final class Failed extends IllegalStateException {
        public Failed(String message) {
            super(message);
        }

        @Override
        public synchronized Throwable fillInStackTrace() {
            return this;
        }
    }

    /**
     * 这次运行的**输入**不成立：模板编码、pk 查不到，--set 的路径写错、值对不上基础资料；
     * 要验「会被拦」，拦住它的却不只是写明的原因（挑的单本来就过不去，见 ExpectSpec.operation）。
     *
     * <p>和 {@link #unresolved} 的区别在「改对之后是不是同一个场景」。场景 = 命令去掉 --expect；
     * 断言写错了，改对再跑还是同一个场景，那条 FAIL 会被换掉。可目标、--pk、--set 本身就在场景里，
     * 写错的那条改对之后是**另一个**场景，记成 FAIL 的话它在会话里永远换不掉，交付就一直被它挡着
     * （2026-09-17 真机复验 run print 时发现）。所以这里不记断言，只发 {@code t=input-invalid}：
     * 内核见到它就不留验证记录，并告诉调用方改输入。这次什么都没验，不留记录也没有漏掉任何东西。</p>
     */
    public static void inputInvalid(String kind, String target, String why) {
        invalid++;
        System.out.println("[PROBE] ✘ 输入不成立 " + (caseId == null ? "" : caseId + " ") + kind + " " + target
                + "  —— " + why);
        ProbeJson.emit("input-invalid", "case", caseId, "kind", kind, "target", target, "why", why);
    }

    /**
     * 这次运行**有一步没跑完**：某个插件在这一步抛错，排在它后面的插件这一步全没收到，
     * 探针接着往下跑。后面的断言照样判，但它们落在一个不完整的现场上，全过也不能当成「这张单据整套跑通了」。
     *
     * <p>只发 {@code t=run-incomplete}，不记断言：内核见到它就不把这次的全过记成验证记录，并把它排在结果最前面
     * （2026-10-10 真机：销售订单打开时一个原厂插件抛错，后面的插件 loadData 全没跑，断言照样 8/8 过）。
     * 断言本来就有挂的，照样记 FAIL —— 挂了就是挂了。</p>
     *
     * @param plugin 抛错的插件类名，平台自己抛的给 null
     * @param why    这一步出了什么错、怎么补（例如摘掉那个插件重跑的写法）
     */
    public static void incomplete(String step, String plugin, String why) {
        INCOMPLETE.add(step + (plugin == null ? " 一步平台抛错"
                : " 一步插件 " + plugin.substring(plugin.lastIndexOf('.') + 1) + " 抛错，排在它后面的插件这一步没跑到"));
        ProbeJson.emit("run-incomplete", "case", caseId, "step", step, "plugin", plugin, "why", why);
    }

    /**
     * 声明接下来的断言属于哪条用例。一次探针跑多条用例时必须调 —— verify 按旁路里的
     * {@code case} 字段分组判每条用例的成败，不带归属的断言它只能算进「散装」那一堆。
     */
    public static void inCase(String id) {
        caseId = id == null || id.trim().isEmpty() ? null : id.trim();
    }

    /** 值断言：@nonempty 为非空，@literal: 后按字面比；数字按值比，其余按 toString 比。 */
    public static boolean isEqual(String kind, String target, Object expect, Object actual) {
        String e = expect == null ? null : String.valueOf(expect);
        //取到了、值是 null：按「空」记。取不到值的走 unresolved，输出里那种才写「(取不到)」
        String a = actual == null ? "" : String.valueOf(actual);
        return record(kind, target, e, a, "@nonempty".equals(e) ? nonempty(actual) : same(e, a), null);
    }

    /** 非空按原始值判断，避免 null、空集合被渲染成文字后误判为有值。 */
    private static boolean nonempty(Object actual) {
        if (actual == null) return false;
        if (actual instanceof Collection) return !((Collection<?>) actual).isEmpty();
        if (actual instanceof java.util.Map) return !((java.util.Map<?, ?>) actual).isEmpty();
        if (actual.getClass().isArray()) return java.lang.reflect.Array.getLength(actual) > 0;
        return !blank(String.valueOf(actual));
    }

    /**
     * 集合相等断言：实际值按 toString 取出、去重、排序后与期望的逗号串比。
     * 顺序不参与比较 —— 下拉项的排列顺序是设计态的事，不该让断言随它红。
     */
    public static boolean setEquals(String kind, String target, String expect, Collection<?> actual) {
        List<String> got = new ArrayList<String>();
        if (actual != null) {
            for (Object o : actual) {
                String s = o == null ? "" : shown(String.valueOf(o).trim());
                if (!s.isEmpty() && !got.contains(s)) {
                    got.add(s);
                }
            }
        }
        java.util.Collections.sort(got);
        List<String> want = new ArrayList<String>();
        String literal = expect != null && expect.startsWith("@literal:")
                ? expect.substring("@literal:".length()) : expect;
        for (String s : String.valueOf(literal == null ? "" : literal).split(",")) {
            String t = shown(s.trim());
            if (!t.isEmpty() && !want.contains(t)) {
                want.add(t);
            }
        }
        java.util.Collections.sort(want);
        if ("@nonempty".equals(expect)) {
            return record(kind, target, expect, join(got), !got.isEmpty(), null);
        }
        return record(kind, target, join(want), join(got), want.equals(got), null);
    }

    /** 包含断言：实际值里必须出现期望的那一项。 */
    public static boolean contains(String kind, String target, String expect, Collection<?> actual) {
        List<String> got = new ArrayList<String>();
        if (actual != null) {
            for (Object o : actual) {
                got.add(o == null ? "" : shown(String.valueOf(o).trim()));
            }
        }
        return record(kind, target, expect, join(got), got.contains(shown(String.valueOf(expect).trim())), null);
    }

    /**
     * 包含断言：实际文本里出现期望的片段就算过。**给错误消息用** ——
     * 苍穹的校验消息带字段显示名、行号和标点，逐字比对等于把断言绑死在文案上。
     */
    public static boolean containsText(String kind, String target, String expect, Object actual) {
        String a = actual == null ? null : String.valueOf(actual);
        return record(kind, target, expect, a,
                a != null && expect != null && shown(a).contains(shown(expect)), null);
    }

    /**
     * 这条断言没法执行（字段不存在、操作查不到）。**记 FAIL 不记跳过** ——
     * 「用例没跑成」和「用例通过了」之间没有中间态，标成跳过就等于悄悄减少了覆盖面。
     */
    public static boolean unresolved(String kind, String target, Object expect, String why) {
        return record(kind, target, expect == null ? null : String.valueOf(expect), null, false, why);
    }

    private static boolean record(String kind, String target, String expect, String actual,
            boolean ok, String why) {
        total++;
        if (ok) {
            passed++;
        } else {
            FAILED.add(kind + " " + target);
        }
        System.out.println("[PROBE] " + (ok ? "✔ PASS " : "✘ FAIL ")
                + (caseId == null ? "" : caseId + " ") + kind + " " + target
                + "  期望=" + display(expect) + "  实际=" + (actual == null ? "(取不到)" : display(actual))
                + (why == null ? "" : "  —— " + why));
        ProbeJson.emit("assert", "case", caseId, "kind", kind, "target", target,
                "expect", expect, "actual", actual, "pass", Boolean.valueOf(ok),
                "why", why);
        return ok;
    }

    /**
     * 收尾：打总结并回答「这次跑通了没有」。**探针末尾必须调它。**
     * 一条断言都没有时发 {@code assert-none}，verify 据此只记 EXECUTED。
     */
    public static boolean summary() {
        if (invalid > 0) {
            System.out.println("[PROBE] 输入不成立 " + invalid + " 处（上面 ✘ 输入不成立 那几行）—— 这次没验到东西，改对输入再跑"
                    + (total == 0 ? "" : "；另有断言 " + passed + "/" + total + " 通过"));
            return false;
        }
        if (total == 0) {
            System.out.println("[PROBE] 本次没有执行任何断言 —— 只能证明跑通了，证明不了结果对");
            ProbeJson.emit("assert-none", "case", caseId, "result", "EXECUTED",
                    "why", "本次没有执行任何断言，只能证明派发链无异常");
            return true;
        }
        System.out.println("[PROBE] 断言 " + passed + "/" + total + " 通过"
                + (FAILED.isEmpty() ? "" : "，失败：" + join(FAILED))
                + (INCOMPLETE.isEmpty() ? "" : "；但这次没跑完整：" + join(INCOMPLETE) + " —— 不算验证通过"));
        return FAILED.isEmpty();
    }

    public static int failCount() {
        return total - passed;
    }

    /**
     * 一个值显示成一行的写法：换行写 {@code \n}（{@code \r\n} 也算一个换行），制表符写 {@code \t}，
     * 单独的回车写 {@code \r}，其余控制字符写 {@code \\u00XX}，别的字符（包括反斜杠）原样。
     *
     * <p>探针凡是把值打给模型看（{@code --show}、断言的期望/实际、导出的格子文字）都经这里，
     * 断言也拿这个写法比：照着显示抄进 {@code --expect} 就对得上。以前各探针各自把换行换成空格，
     * {@code 1-1\n1-2} 显示成 {@code 1-1 1-2}，照抄的断言挂掉，模型只好去原始输出里 {@code cat -A}
     * （S37 2-A.4）。反斜杠不转义，所以对已经是这种写法的串再调一次不变；代价是值里本来就有
     * 字面的 {@code \n} 两个字符时，和真换行显示一样、比较也算一样。</p>
     */
    public static String shown(String value) {
        if (value == null) {
            return null;
        }
        StringBuilder out = null;
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            int start = i;
            String mark;
            if (c == '\n') {
                mark = "\\n";
            } else if (c == '\r' && i + 1 < value.length() && value.charAt(i + 1) == '\n') {
                mark = "\\n";
                i++;
            } else if (c == '\t') {
                mark = "\\t";
            } else if (c == '\r') {
                mark = "\\r";
            } else if (c < 0x20 || c == 0x7f) {
                mark = String.format("\\u%04x", Integer.valueOf(c));
            } else {
                if (out != null) {
                    out.append(c);
                }
                continue;
            }
            if (out == null) {
                out = new StringBuilder(value.length() + 8).append(value, 0, start);
            }
            out.append(mark);
        }
        return out == null ? value : out.toString();
    }

    /** 数字按值比（15.00 == 15.0），其余按 {@link #shown} 的写法比。包内可见：ExpectSpec.notePrior 用同一口径。 */
    static boolean same(String e, String a) {
        if ("@nonempty".equals(e)) {
            return !blank(a);
        }
        // 显式字面值转义：字段里本身存了 @nonempty 时仍能精确比较。
        if (e != null && e.startsWith("@literal:")) {
            e = e.substring("@literal:".length());
        }
        //「空」有几种写法：没值是 null，空下拉、空文本从库里读回来是 "" 或空格，断言写「字段=」是 ""。都按同一个空比
        if (blank(e) || blank(a)) {
            return blank(e) && blank(a);
        }
        if (shown(e).equals(shown(a))) {
            return true;
        }
        try {
            return new BigDecimal(e.trim()).compareTo(new BigDecimal(a.trim())) == 0;
        } catch (NumberFormatException notNumeric) {
            return false;
        }
    }

    static boolean blank(String s) {
        return s == null || s.trim().isEmpty();
    }

    /** 输出里的一格：空写「(空)」，免得「期望=  实际=」看不出是不是空。 */
    private static String display(String v) {
        return v != null && v.trim().isEmpty() ? "(空)" : shown(v);
    }

    private static String join(List<String> items) {
        StringBuilder sb = new StringBuilder();
        for (String s : items) {
            if (sb.length() > 0) {
                sb.append(',');
            }
            sb.append(s);
        }
        return sb.toString();
    }
}
