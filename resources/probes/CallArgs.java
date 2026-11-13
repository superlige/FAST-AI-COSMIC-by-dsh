import java.lang.reflect.Array;
import java.lang.reflect.Constructor;
import java.lang.reflect.GenericArrayType;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Modifier;
import java.lang.reflect.ParameterizedType;
import java.lang.reflect.Type;
import java.lang.reflect.TypeVariable;
import java.lang.reflect.WildcardType;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.sql.Timestamp;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import kd.bos.context.RequestContext;
import kd.bos.dataentity.entity.DynamicObject;
import kd.bos.dataentity.entity.DynamicObjectCollection;
import kd.bos.dataentity.metadata.ICollectionProperty;
import kd.bos.dataentity.metadata.IDataEntityProperty;
import kd.bos.entity.property.BasedataProp;
import kd.bos.entity.property.MulBasedataProp;
import kd.bos.orm.query.QFilter;
import kd.bos.print.core.data.DataRowSet;
import kd.bos.print.core.data.field.CollectionField;
import kd.bos.print.core.data.field.DateField;
import kd.bos.print.core.data.field.DateTimeField;
import kd.bos.print.core.data.field.DecimalField;
import kd.bos.print.core.data.field.Field;
import kd.bos.print.core.data.field.IntegerField;
import kd.bos.print.core.data.field.LongField;
import kd.bos.print.core.data.field.NullField;
import kd.bos.print.core.data.field.ObjectField;
import kd.bos.print.core.data.field.TextField;
import kd.bos.servicehelper.BusinessDataServiceHelper;
import kd.bos.servicehelper.QueryServiceHelper;

/**
 * 不是探针，是共用类：**按方法签名把 JSON 造成参数**（S24 批 B，`run call` 用）。
 *
 * <p>为什么单独成类：09-17 那次会话手工造打印数据行，猜 {@code DataRowSet} 的方法名猜错 4 次。
 * 平台对象怎么造是工具该知道的事，写命令的只写 JSON。以后 {@code PrintSim} 要造数据行也从这里拿。</p>
 *
 * <p>三条批 0.5 真机实验定下来的规矩：
 * <ul>
 * <li><b>打印数据行的字段按 JSON 类型自己建</b>，不走平台 {@code FieldFactory.create}：它把数字、布尔变成空字段，
 * 插件读到的是空，断言红了也看不出是造数造坏的。</li>
 * <li><b>单据数据对象按实体元数据建</b>，字段逐个核对；基础资料按 id / 编码（或 {"name":"…"} 这种一个键的对象）查出来再放，
 * 查不到当场报「哪个字段、按什么查、查到几条」。</li>
 * <li><b>JSON 写错一律报「哪个参数、哪个字段、要什么、给的是什么」</b>，不猜、不转。</li>
 * </ul>
 */
public final class CallArgs {

    private CallArgs() {
    }

    /** 参数造不出来。path 是 `参数1[0].zlgd_bz_jx` 这种写法。 */
    public static final class Bad extends RuntimeException {
        public final String path;

        public Bad(String path, String message) {
            super(message);
            this.path = path;
        }
    }

    /** 工具自己给、不占 --args 位置的参数类型。 */
    public static boolean injected(Class<?> type) {
        return type == RequestContext.class;
    }

    public static Object inject(Class<?> type) {
        return RequestContext.get();
    }

    // ---------------- JSON ----------------

    /** 数字一律读成 BigDecimal，不丢精度；造参数时再按目标类型收窄。 */
    public static Object parse(String text) {
        Reader r = new Reader(text);
        r.space();
        Object value = r.value();
        r.space();
        if (r.pos < text.length()) {
            throw new Bad("--args", "JSON 在第 " + (r.pos + 1) + " 个字符后面多出了内容");
        }
        return value;
    }

    private static final class Reader {
        final String s;
        int pos;

        Reader(String s) {
            this.s = s;
        }

        void space() {
            while (pos < s.length() && Character.isWhitespace(s.charAt(pos))) {
                pos++;
            }
        }

        Bad bad(String what) {
            return new Bad("--args", "JSON 第 " + (pos + 1) + " 个字符：" + what);
        }

        Object value() {
            if (pos >= s.length()) {
                throw bad("没写完");
            }
            char c = s.charAt(pos);
            if (c == '{') {
                return object();
            }
            if (c == '[') {
                return array();
            }
            if (c == '"') {
                return string();
            }
            if (s.startsWith("true", pos)) {
                pos += 4;
                return Boolean.TRUE;
            }
            if (s.startsWith("false", pos)) {
                pos += 5;
                return Boolean.FALSE;
            }
            if (s.startsWith("null", pos)) {
                pos += 4;
                return null;
            }
            int start = pos;
            while (pos < s.length() && "+-0123456789.eE".indexOf(s.charAt(pos)) >= 0) {
                pos++;
            }
            if (start == pos) {
                throw bad("认不出的值「" + c + "」");
            }
            try {
                return new BigDecimal(s.substring(start, pos));
            } catch (NumberFormatException e) {
                throw bad("数字写法不对「" + s.substring(start, pos) + "」");
            }
        }

        Map<String, Object> object() {
            Map<String, Object> out = new LinkedHashMap<String, Object>();
            pos++;
            space();
            if (pos < s.length() && s.charAt(pos) == '}') {
                pos++;
                return out;
            }
            while (true) {
                space();
                if (pos >= s.length() || s.charAt(pos) != '"') {
                    throw bad("对象的键要用双引号");
                }
                String key = string();
                space();
                if (pos >= s.length() || s.charAt(pos) != ':') {
                    throw bad("键后面要有冒号");
                }
                pos++;
                space();
                out.put(key, value());
                space();
                if (pos < s.length() && s.charAt(pos) == ',') {
                    pos++;
                    continue;
                }
                if (pos < s.length() && s.charAt(pos) == '}') {
                    pos++;
                    return out;
                }
                throw bad("对象里要逗号或 }");
            }
        }

        List<Object> array() {
            List<Object> out = new ArrayList<Object>();
            pos++;
            space();
            if (pos < s.length() && s.charAt(pos) == ']') {
                pos++;
                return out;
            }
            while (true) {
                space();
                out.add(value());
                space();
                if (pos < s.length() && s.charAt(pos) == ',') {
                    pos++;
                    continue;
                }
                if (pos < s.length() && s.charAt(pos) == ']') {
                    pos++;
                    return out;
                }
                throw bad("数组里要逗号或 ]");
            }
        }

        String string() {
            StringBuilder sb = new StringBuilder();
            pos++;
            while (pos < s.length()) {
                char c = s.charAt(pos++);
                if (c == '"') {
                    return sb.toString();
                }
                if (c != '\\') {
                    sb.append(c);
                    continue;
                }
                if (pos >= s.length()) {
                    break;
                }
                char e = s.charAt(pos++);
                switch (e) {
                    case 'n':
                        sb.append('\n');
                        break;
                    case 't':
                        sb.append('\t');
                        break;
                    case 'r':
                        sb.append('\r');
                        break;
                    case 'b':
                        sb.append('\b');
                        break;
                    case 'f':
                        sb.append('\f');
                        break;
                    case 'u':
                        if (pos + 4 > s.length()) {
                            throw bad("\\u 后面要 4 位十六进制");
                        }
                        sb.append((char) Integer.parseInt(s.substring(pos, pos + 4), 16));
                        pos += 4;
                        break;
                    default:
                        sb.append(e);
                }
            }
            throw bad("字符串没有收尾的双引号");
        }
    }

    // ---------------- 造参数 ----------------

    /** 类型的可读名：List&lt;DataRowSet&gt;、Map&lt;String, Object&gt;。 */
    public static String typeName(Type type) {
        if (type instanceof Class) {
            Class<?> c = (Class<?>) type;
            return c.isArray() ? typeName(c.getComponentType()) + "[]" : c.getSimpleName();
        }
        if (type instanceof ParameterizedType) {
            ParameterizedType p = (ParameterizedType) type;
            StringBuilder sb = new StringBuilder(typeName(p.getRawType())).append('<');
            Type[] args = p.getActualTypeArguments();
            for (int i = 0; i < args.length; i++) {
                sb.append(i == 0 ? "" : ", ").append(typeName(args[i]));
            }
            return sb.append('>').toString();
        }
        if (type instanceof GenericArrayType) {
            return typeName(((GenericArrayType) type).getGenericComponentType()) + "[]";
        }
        return type.toString();
    }

    private static Class<?> raw(Type type) {
        if (type instanceof Class) {
            return (Class<?>) type;
        }
        if (type instanceof ParameterizedType) {
            return (Class<?>) ((ParameterizedType) type).getRawType();
        }
        if (type instanceof GenericArrayType) {
            return Array.newInstance(raw(((GenericArrayType) type).getGenericComponentType()), 0).getClass();
        }
        if (type instanceof WildcardType) {
            Type[] upper = ((WildcardType) type).getUpperBounds();
            return upper.length == 0 ? Object.class : raw(upper[0]);
        }
        if (type instanceof TypeVariable) {
            Type[] bounds = ((TypeVariable<?>) type).getBounds();
            return bounds.length == 0 ? Object.class : raw(bounds[0]);
        }
        return Object.class;
    }

    private static Type typeArg(Type type, int index) {
        if (type instanceof ParameterizedType) {
            Type[] args = ((ParameterizedType) type).getActualTypeArguments();
            if (index < args.length) {
                return args[index];
            }
        }
        return Object.class;
    }

    private static String jsonKind(Object json) {
        if (json == null) {
            return "null";
        }
        if (json instanceof String) {
            return "字符串「" + clip((String) json) + "」";
        }
        if (json instanceof BigDecimal) {
            return "数字 " + ((BigDecimal) json).toPlainString();
        }
        if (json instanceof Boolean) {
            return "布尔 " + json;
        }
        if (json instanceof List) {
            return "数组（" + ((List<?>) json).size() + " 项）";
        }
        return "对象 " + ((Map<?, ?>) json).keySet();
    }

    private static String clip(String s) {
        return s.length() > 40 ? s.substring(0, 40) + "…" : s;
    }

    private static Bad want(String path, String what, Object json) {
        return new Bad(path, "要" + what + "，给的是" + jsonKind(json));
    }

    /** 按参数的声明类型把一段 JSON 造成对象。 */
    @SuppressWarnings("unchecked")
    public static Object build(Type type, Object json, String path) {
        Class<?> c = raw(type);
        if (json == null) {
            if (c.isPrimitive()) {
                throw new Bad(path, c.getName() + " 不能是 null");
            }
            return null;
        }
        if (c == String.class || c == CharSequence.class) {
            if (!(json instanceof String)) {
                throw want(path, "字符串", json);
            }
            return json;
        }
        if (c == boolean.class || c == Boolean.class) {
            if (!(json instanceof Boolean)) {
                throw want(path, "布尔 true/false", json);
            }
            return json;
        }
        if (c.isPrimitive() || Number.class.isAssignableFrom(c)) {
            if (!(json instanceof BigDecimal)) {
                throw want(path, "数字（" + c.getSimpleName() + "）", json);
            }
            return number(c, (BigDecimal) json, path);
        }
        if (Date.class.isAssignableFrom(c)) {
            if (!(json instanceof String)) {
                throw want(path, "日期字符串 yyyy-MM-dd / yyyy-MM-dd HH:mm:ss / now", json);
            }
            Date d;
            try {
                d = ExpectSpec.date((String) json);
            } catch (IllegalArgumentException e) {
                throw new Bad(path, e.getMessage());
            }
            if (c == Timestamp.class) {
                return new Timestamp(d.getTime());
            }
            if (c == java.sql.Date.class) {
                return new java.sql.Date(d.getTime());
            }
            return d;
        }
        if (c.isEnum()) {
            if (!(json instanceof String)) {
                throw want(path, "枚举名字符串", json);
            }
            for (Object one : c.getEnumConstants()) {
                if (((Enum<?>) one).name().equals(json)) {
                    return one;
                }
            }
            List<String> names = new ArrayList<String>();
            for (Object one : c.getEnumConstants()) {
                names.add(((Enum<?>) one).name());
            }
            throw new Bad(path, c.getSimpleName() + " 里没有「" + json + "」，能写的：" + names);
        }
        if (c == DataRowSet.class) {
            if (!(json instanceof Map)) {
                throw want(path, "对象 {字段:值}（打印数据行）", json);
            }
            return rowSet((Map<String, Object>) json, path);
        }
        if (c == DynamicObject.class) {
            if (!(json instanceof Map)) {
                throw want(path, "对象 {\"@entity\":\"实体标识\", 字段:值}（单据数据对象）", json);
            }
            return dynamicObject((Map<String, Object>) json, path);
        }
        if (c == QFilter.class) {
            return qfilter(json, path);
        }
        if (c.isArray()) {
            if (!(json instanceof List)) {
                throw want(path, "数组", json);
            }
            List<Object> list = (List<Object>) json;
            Type item = type instanceof GenericArrayType ? ((GenericArrayType) type).getGenericComponentType()
                    : c.getComponentType();
            Object out = Array.newInstance(raw(item), list.size());
            for (int i = 0; i < list.size(); i++) {
                Array.set(out, i, build(item, list.get(i), path + "[" + i + "]"));
            }
            return out;
        }
        if (Collection.class.isAssignableFrom(c) || c == Iterable.class) {
            if (!(json instanceof List)) {
                throw want(path, "数组（" + typeName(type) + "）", json);
            }
            List<Object> list = (List<Object>) json;
            Collection<Object> out = Set.class.isAssignableFrom(c) ? new LinkedHashSet<Object>() : new ArrayList<Object>();
            if (!c.isInterface() && !c.isAssignableFrom(out.getClass())) {
                throw new Bad(path, "造不出集合类型 " + c.getSimpleName() + "，方法参数写成 List / Set / Collection 才行");
            }
            Type item = typeArg(type, 0);
            for (int i = 0; i < list.size(); i++) {
                out.add(build(item, list.get(i), path + "[" + i + "]"));
            }
            return out;
        }
        if (Map.class.isAssignableFrom(c)) {
            if (!(json instanceof Map)) {
                throw want(path, "对象（" + typeName(type) + "）", json);
            }
            if (!c.isInterface() && !c.isAssignableFrom(LinkedHashMap.class)) {
                throw new Bad(path, "造不出 Map 类型 " + c.getSimpleName() + "，方法参数写成 Map 才行");
            }
            Type value = typeArg(type, 1);
            Map<String, Object> out = new LinkedHashMap<String, Object>();
            for (Map.Entry<String, Object> e : ((Map<String, Object>) json).entrySet()) {
                out.put(e.getKey(), build(value, e.getValue(), path + "." + e.getKey()));
            }
            return out;
        }
        if (c == Object.class) {
            return plain(json);
        }
        Constructor<?> fromMap = mapConstructor(c);
        if (fromMap != null) {
            if (!(json instanceof Map)) {
                throw want(path, "对象（" + c.getSimpleName() + " 按构造器收的 Map 建）", json);
            }
            Object map = build(fromMap.getGenericParameterTypes()[0], json, path);
            try {
                fromMap.setAccessible(true);
                return fromMap.newInstance(map);
            } catch (InvocationTargetException e) {
                Throwable cause = e.getCause() == null ? e : e.getCause();
                throw new Bad(path, c.getSimpleName() + " 的构造器抛了 " + cause);
            } catch (ReflectiveOperationException e) {
                throw new Bad(path, "建不出 " + c.getSimpleName() + "：" + e);
            }
        }
        throw new Bad(path, "run call 造不出 " + typeName(type) + "。能造的：字符串、数字、布尔、日期、枚举、数组 / List / Set、Map、"
                + "DataRowSet（打印数据行）、DynamicObject（单据数据对象）、QFilter（[\"字段\",\"比较符\",值]）、"
                + "构造器只收一个 Map 的对象（写成对象）；RequestContext 工具自己给。"
                + "要别的类型，把要验的逻辑抽成收这些类型的方法再调");
    }

    /**
     * 构造器只收一个 Map 的类（例如开放接口的 {@code ApiSerializerModel}）：平台自己也是拿一个 Map 建它，
     * JSON 对象原样按那个 Map 造。有无参构造器、或者收别的参数的，不算——那种对象怎么填字段猜不准。
     */
    private static Constructor<?> mapConstructor(Class<?> c) {
        if (c.isInterface() || Modifier.isAbstract(c.getModifiers()) || c.isPrimitive()) {
            return null;
        }
        Constructor<?> found = null;
        for (Constructor<?> ctor : c.getConstructors()) {
            Class<?>[] params = ctor.getParameterTypes();
            if (params.length == 0) {
                return null;
            }
            if (params.length == 1 && params[0].isAssignableFrom(LinkedHashMap.class)
                    && Map.class.isAssignableFrom(params[0])) {
                found = ctor;
            }
        }
        return found;
    }

    /**
     * 过滤条件：{@code ["字段","比较符",值]} 是一条，{@code [[…],[…]]} 是几条并且（and）；
     * 比较符照平台 QCP 写（=、!=、>、<、in、like、is null…），{@code is null} 这类可以不写值。
     */
    @SuppressWarnings("unchecked")
    public static QFilter qfilter(Object json, String path) {
        if (!(json instanceof List) || ((List<?>) json).isEmpty()) {
            throw want(path, "过滤条件 [\"字段\",\"比较符\",值]，几条就写成 [[…],[…]]", json);
        }
        List<Object> list = (List<Object>) json;
        if (!(list.get(0) instanceof List)) {
            return condition(list, path);
        }
        QFilter out = null;
        for (int i = 0; i < list.size(); i++) {
            Object one = list.get(i);
            if (!(one instanceof List)) {
                throw want(path + "[" + i + "]", "过滤条件 [\"字段\",\"比较符\",值]", one);
            }
            QFilter next = condition((List<Object>) one, path + "[" + i + "]");
            out = out == null ? next : out.and(next);
        }
        return out;
    }

    private static QFilter condition(List<Object> parts, String path) {
        if (parts.size() < 2 || parts.size() > 3 || !(parts.get(0) instanceof String) || !(parts.get(1) instanceof String)) {
            throw want(path, "过滤条件 [\"字段\",\"比较符\",值]", parts);
        }
        Object value = parts.size() == 3 ? plain(parts.get(2)) : null;
        return new QFilter((String) parts.get(0), (String) parts.get(1), value);
    }

    private static Object number(Class<?> c, BigDecimal n, String path) {
        try {
            if (c == int.class || c == Integer.class) {
                return Integer.valueOf(n.intValueExact());
            }
            if (c == long.class || c == Long.class) {
                return Long.valueOf(n.longValueExact());
            }
            if (c == short.class || c == Short.class) {
                return Short.valueOf(n.shortValueExact());
            }
            if (c == byte.class || c == Byte.class) {
                return Byte.valueOf(n.byteValueExact());
            }
        } catch (ArithmeticException e) {
            throw new Bad(path, "要整数（" + c.getSimpleName() + "），给的是 " + n.toPlainString());
        }
        if (c == double.class || c == Double.class) {
            return Double.valueOf(n.doubleValue());
        }
        if (c == float.class || c == Float.class) {
            return Float.valueOf(n.floatValue());
        }
        if (c == BigInteger.class) {
            try {
                return n.toBigIntegerExact();
            } catch (ArithmeticException e) {
                throw new Bad(path, "要整数（BigInteger），给的是 " + n.toPlainString());
            }
        }
        if (c == BigDecimal.class || c == Number.class) {
            return n;
        }
        throw new Bad(path, "造不出数字类型 " + c.getSimpleName());
    }

    /** 声明成 Object 的地方：整数给 Integer / Long，带小数给 BigDecimal，其余原样。 */
    @SuppressWarnings("unchecked")
    private static Object plain(Object json) {
        if (json instanceof BigDecimal) {
            BigDecimal n = (BigDecimal) json;
            if (n.scale() <= 0 || n.stripTrailingZeros().scale() <= 0) {
                try {
                    return Integer.valueOf(n.intValueExact());
                } catch (ArithmeticException notInt) {
                    try {
                        return Long.valueOf(n.longValueExact());
                    } catch (ArithmeticException notLong) {
                        return n;
                    }
                }
            }
            return n;
        }
        if (json instanceof List) {
            List<Object> out = new ArrayList<Object>();
            for (Object one : (List<Object>) json) {
                out.add(plain(one));
            }
            return out;
        }
        if (json instanceof Map) {
            Map<String, Object> out = new LinkedHashMap<String, Object>();
            for (Map.Entry<String, Object> e : ((Map<String, Object>) json).entrySet()) {
                out.put(e.getKey(), plain(e.getValue()));
            }
            return out;
        }
        return json;
    }

    /**
     * 打印数据行：字符串 → 文本字段，整数 → 整数字段，小数 → 数值字段，布尔 → 对象字段，null → 空字段，
     * 对象数组 → 集合字段（分录）；日期写成 {"@date":"2026-01-01"} / {"@datetime":"2026-01-01 08:00:00"}。
     */
    @SuppressWarnings("unchecked")
    public static DataRowSet rowSet(Map<String, Object> json, String path) {
        DataRowSet row = new DataRowSet();
        for (Map.Entry<String, Object> e : json.entrySet()) {
            String here = path + "." + e.getKey();
            Object v = e.getValue();
            Field<?> field;
            if (v == null) {
                field = new NullField();
            } else if (v instanceof String) {
                field = new TextField((String) v);
            } else if (v instanceof Boolean) {
                field = new ObjectField(v);
            } else if (v instanceof BigDecimal) {
                Object n = plain(v);
                field = n instanceof Integer ? new IntegerField((Integer) n)
                        : n instanceof Long ? new LongField((Long) n) : new DecimalField((BigDecimal) v);
            } else if (v instanceof List) {
                List<DataRowSet> children = new ArrayList<DataRowSet>();
                List<Object> list = (List<Object>) v;
                for (int i = 0; i < list.size(); i++) {
                    if (!(list.get(i) instanceof Map)) {
                        throw want(here + "[" + i + "]", "对象 {字段:值}（分录的一行）", list.get(i));
                    }
                    children.add(rowSet((Map<String, Object>) list.get(i), here + "[" + i + "]"));
                }
                field = new CollectionField(children);
            } else {
                Map<String, Object> m = (Map<String, Object>) v;
                Object date = m.get("@date");
                Object dateTime = m.get("@datetime");
                if (m.size() == 1 && date instanceof String) {
                    field = new DateField(dateOf(here, (String) date));
                } else if (m.size() == 1 && dateTime instanceof String) {
                    field = new DateTimeField(new Timestamp(dateOf(here, (String) dateTime).getTime()));
                } else {
                    throw new Bad(here, "打印数据行的字段值只能是字符串、数字、布尔、null、对象数组（分录），"
                            + "或者 {\"@date\":\"yyyy-MM-dd\"} / {\"@datetime\":\"yyyy-MM-dd HH:mm:ss\"}，给的是" + jsonKind(v));
                }
            }
            row.put(e.getKey(), field);
        }
        return row;
    }

    private static Date dateOf(String path, String text) {
        try {
            return ExpectSpec.date(text);
        } catch (IllegalArgumentException e) {
            throw new Bad(path, e.getMessage());
        }
    }

    /** 单据数据对象：{"@entity":"实体标识", "@pk":可选, 字段:值, 分录:[{…}]}。 */
    public static DynamicObject dynamicObject(Map<String, Object> json, String path) {
        Object entity = json.get("@entity");
        if (!(entity instanceof String) || ((String) entity).trim().isEmpty()) {
            throw new Bad(path, "单据数据对象要写 \"@entity\":\"实体标识\"，按它的元数据建");
        }
        String number = ((String) entity).trim();
        Object pk = json.get("@pk");
        DynamicObject obj;
        try {
            if (pk == null) {
                obj = BusinessDataServiceHelper.newDynamicObject(number);
            } else {
                Object id = pk instanceof BigDecimal ? plain(pk) : String.valueOf(pk).trim();
                if (id instanceof String && ((String) id).matches("\\d+")) {
                    id = Long.valueOf((String) id);
                }
                if (!QueryServiceHelper.exists(number, new QFilter[]{new QFilter("id", "=", id)})) {
                    throw new Bad(path + ".@pk", number + " 里查不到 pk=" + pk);
                }
                obj = BusinessDataServiceHelper.loadSingle(id, number);
            }
        } catch (Bad b) {
            throw b;
        } catch (RuntimeException e) {
            throw new Bad(path + ".@entity", "按实体 " + number + " 建对象失败：" + e.getMessage());
        }
        fill(obj, json, path);
        return obj;
    }

    @SuppressWarnings("unchecked")
    private static void fill(DynamicObject obj, Map<String, Object> json, String path) {
        for (Map.Entry<String, Object> e : json.entrySet()) {
            String key = e.getKey();
            if (key.startsWith("@")) {
                if (!"@entity".equals(key) && !"@pk".equals(key)) {
                    throw new Bad(path + "." + key, "认识的只有 @entity、@pk");
                }
                continue;
            }
            String here = path + "." + key;
            Object v = e.getValue();
            IDataEntityProperty p = (IDataEntityProperty) obj.getDataEntityType().getProperties().get(key);
            if (p == null) {
                throw new Bad(here, obj.getDataEntityType().getName() + " 上没有字段 " + key);
            }
            if (p instanceof MulBasedataProp) {
                String base = ((MulBasedataProp) p).getBaseEntityId();
                DynamicObjectCollection rows = obj.getDynamicObjectCollection(key);
                rows.clear();
                if (v == null) {
                    continue;
                }
                List<Object> items = v instanceof List ? (List<Object>) v : java.util.Collections.singletonList(v);
                for (int i = 0; i < items.size(); i++) {
                    DynamicObject ref = basedata(base, items.get(i), here + "[" + i + "]");
                    rows.addNew().set(MulBasedataProp.KEY_BASEDATAID, ref);
                }
                continue;
            }
            if (p instanceof BasedataProp) {
                obj.set(key, v == null ? null : basedata(((BasedataProp) p).getBaseEntityId(), v, here));
                continue;
            }
            if (p instanceof ICollectionProperty) {
                if (!(v instanceof List)) {
                    throw want(here, "对象数组（分录，每项一行；给了就整组替换）", v);
                }
                DynamicObjectCollection rows = obj.getDynamicObjectCollection(key);
                rows.clear();
                List<Object> list = (List<Object>) v;
                for (int i = 0; i < list.size(); i++) {
                    if (!(list.get(i) instanceof Map)) {
                        throw want(here + "[" + i + "]", "对象 {字段:值}（分录的一行）", list.get(i));
                    }
                    fill(rows.addNew(), (Map<String, Object>) list.get(i), here + "[" + i + "]");
                }
                continue;
            }
            if (v instanceof List || v instanceof Map) {
                throw want(here, "字段值（字符串、数字、布尔、null）", v);
            }
            String text = v == null ? null : v instanceof BigDecimal ? ((BigDecimal) v).toPlainString() : String.valueOf(v);
            try {
                obj.set(key, ExpectSpec.convert(p, text));
            } catch (IllegalArgumentException ex) {
                throw new Bad(here, ex.getMessage());
            }
        }
    }

    /** 基础资料：id / 编码写成标量，或者 {"name":"…"} 这种一个键的对象按那个字段查，必须正好一条。 */
    @SuppressWarnings("unchecked")
    private static DynamicObject basedata(String base, Object v, String path) {
        Object id;
        if (v instanceof Map) {
            Map<String, Object> m = (Map<String, Object>) v;
            if (m.size() != 1) {
                throw new Bad(path, "基础资料按字段查要写成一个键的对象，例如 {\"name\":\"显微组织\"}");
            }
            Map.Entry<String, Object> only = m.entrySet().iterator().next();
            Object want = only.getValue() instanceof BigDecimal ? plain(only.getValue()) : only.getValue();
            DynamicObjectCollection hits;
            try {
                hits = QueryServiceHelper.query(base, "id", new QFilter[]{new QFilter(only.getKey(), "=", want)});
            } catch (RuntimeException e) {
                throw new Bad(path, "基础资料 " + base + " 按 " + only.getKey() + " 查失败：" + e.getMessage());
            }
            if (hits.size() != 1) {
                throw new Bad(path, "基础资料 " + base + " 按 " + only.getKey() + "=" + want + " 查到 " + hits.size()
                        + " 条（要正好 1 条）");
            }
            id = hits.get(0).get("id");
        } else if (v instanceof List) {
            throw want(path, "基础资料的 id / 编码，或 {\"字段\":\"值\"}", v);
        } else {
            String text = v instanceof BigDecimal ? ((BigDecimal) v).toPlainString() : String.valueOf(v);
            try {
                id = ExpectSpec.basedataId(base, text);
            } catch (IllegalArgumentException e) {
                throw new Bad(path, e.getMessage());
            }
        }
        DynamicObject ref = BusinessDataServiceHelper.loadSingleFromCache(id, base);
        if (ref == null) {
            throw new Bad(path, "基础资料 " + base + " id=" + id + " 取不回来（没有这条数据，或没权限读）");
        }
        return ref;
    }
}
