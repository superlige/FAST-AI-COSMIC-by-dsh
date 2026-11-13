import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 不是探针，是共用类：探针输出的**机器可读旁路**。
 *
 * 为什么需要它：探针现有输出全是 `[PROBE] 中文行`，给人读的。VerifyResult 要逐条记录
 * 断言的期望值、实际值和结果，靠正则解析中文行必然随文案漂移而碎 —— 那是 verify 落不了地的
 * 直接原因。所以另开一条前缀通道，**两条并存、不互相取代**：人读那行一个字不改，
 * 同一个事实再发一条 JSON。driver 收走 JSON 行、默认不打给人看（只打一行条数），
 * 落到 build/last-probe.json。
 *
 * 用法：
 *     ProbeJson.emit("assert", "target", "zlgd_amount", "expect", "10", "actual", v, "pass", ok);
 *     ProbeJson.emit(map);
 *
 * 约定（破了 driver 那边就收不到）：
 * - **一行一个 JSON 对象**。值里的换行会被转义成 \n，别自己拼字符串绕过 emit()。
 * - 事实和人读行同源。JSON 里出现的结论，人读行里也要有一条对应的。
 */
public final class ProbeJson {

    public static final String PREFIX = "[PROBE-JSON] ";

    private ProbeJson() {
    }

    /** kv 是成对的 key/value；key 必须是字符串。type 落成 "t" 字段。 */
    public static void emit(String type, Object... kv) {
        if (kv.length % 2 != 0) {
            throw new IllegalArgumentException("ProbeJson.emit 的 kv 必须成对：收到 " + kv.length + " 个");
        }
        Map<String, Object> obj = new LinkedHashMap<String, Object>();
        obj.put("t", type);
        for (int i = 0; i < kv.length; i += 2) {
            obj.put(String.valueOf(kv[i]), kv[i + 1]);
        }
        emit(obj);
    }

    public static void emit(Map<String, ?> obj) {
        StringBuilder sb = new StringBuilder(PREFIX);
        writeValue(sb, obj);
        //println 在多线程下也是整行原子的；分两次 print 会被别的线程插进来切断这一行
        System.out.println(sb.toString());
    }

    private static void writeValue(StringBuilder sb, Object v) {
        if (v == null) {
            sb.append("null");
        } else if (v instanceof Boolean) {
            sb.append(v.toString());
        } else if (v instanceof java.math.BigDecimal || v instanceof java.math.BigInteger) {
            //**金额一律落成字符串。** JSON 数字到了 JS 那头就是 double：BigDecimal("10.50")
            //会变成 10.5（标度丢了），超过 2^53 还会丢有效位。断言比的是精确值，
            //一个丢了标度的 10.5 跟期望的 "10.50" 比出 FAIL，人会去查业务代码 —— 查错方向。
            writeString(sb, v.toString());
        } else if (v instanceof Number) {
            //NaN / Infinity 不是合法 JSON，退回字符串，别产出解析不了的行
            double d = ((Number) v).doubleValue();
            if ((v instanceof Double || v instanceof Float)
                    && (Double.isNaN(d) || Double.isInfinite(d))) {
                writeString(sb, v.toString());
                return;
            }
            sb.append(v.toString());
        } else if (v instanceof Map) {
            sb.append('{');
            boolean first = true;
            for (Map.Entry<?, ?> e : ((Map<?, ?>) v).entrySet()) {
                if (!first) {
                    sb.append(',');
                }
                first = false;
                writeString(sb, String.valueOf(e.getKey()));
                sb.append(':');
                writeValue(sb, e.getValue());
            }
            sb.append('}');
        } else if (v instanceof Iterable) {
            sb.append('[');
            boolean first = true;
            for (Object e : (Iterable<?>) v) {
                if (!first) {
                    sb.append(',');
                }
                first = false;
                writeValue(sb, e);
            }
            sb.append(']');
        } else if (v instanceof Object[]) {
            List<Object> list = new ArrayList<Object>();
            for (Object e : (Object[]) v) {
                list.add(e);
            }
            writeValue(sb, list);
        } else {
            //BigDecimal 之外的一切（含日期、DynamicObject）都按 toString 落成字符串：
            //旁路要的是可比对的事实，不是对象图
            writeString(sb, String.valueOf(v));
        }
    }

    private static void writeString(StringBuilder sb, String s) {
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                case '\b': sb.append("\\b"); break;
                case '\f': sb.append("\\f"); break;
                default:
                    if (c < 0x20) {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
            }
        }
        sb.append('"');
    }
}
