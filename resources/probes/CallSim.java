import java.lang.reflect.Constructor;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.lang.reflect.Proxy;
import java.lang.reflect.Type;
import java.math.BigDecimal;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import kd.bos.dataentity.entity.DynamicObject;
import kd.bos.print.core.data.DataRowSet;
import kd.bos.print.core.data.field.CollectionField;
import kd.bos.print.core.data.field.Field;
import kd.bos.schedule.api.MessageHandler;
import kd.bos.schedule.api.MessageInfo;
import kd.bos.schedule.api.MessageSender;
import kd.bos.schedule.api.ObjectFactory;
import kd.bos.schedule.api.Task;

/**
 * 直接调本工程一个类的方法（S24 批 B，`run call`）：调一次（S27 起真提交），断言返回值。
 *
 * <pre>
 * CALL_TARGET  写的是什么：类名#方法名，或 类名#方法名(类型,类型)（必填）
 * CALL_CLASS   cosmic 按源码认定的全类名（前检填，简单类名在那边已经认过）
 * CALL_ARGS    JSON 数组，一项对一个参数；RequestContext 参数不占位置（默认 []）
 * CALL_EXPECT  断言，`;` 分隔：
 *              路径=值 / 路径~=片段      路径直接写是返回值：$、[0].字段、字段、size
 *              args[0]…=值              调用之后的第 1 个参数（改入参的 void 方法）
 *              error=  / error~=片段     没抛异常 / 抛的异常里有这个片段
 * CALL_PKGS    本工程的包前缀，逗号分隔；不在里面的类不加载
 * CALL_CLASS_DIRS 各代码模块的 class 目录，按 File.pathSeparator 分隔；加载不到时用来分清「没编译」和「类路径不对」
 * </pre>
 *
 * <p>几条规矩：
 * <ul>
 * <li><b>只调本工程的类</b>，静态方法直接调；实例方法用无参构造器建一个对象再调。私有方法也能调——
 * 插件里抽出来的计算逻辑常常是 private 的，为了验它改成 public 不值得。</li>
 * <li><b>真提交</b>（S27，用户 2026-09-19：agent 连的必然是纯测试环境）：方法写库就真的写了，和 run op 一样。
 * 以前整个调用包在回滚事务里，另开事务、另起线程的写入逃得出去，前检只好按源码拦；现在不用拦了。</li>
 * <li><b>调度任务</b>（实现 {@link Task} 的类）：给一个 taskId，进度消息接到本探针打出来，不发给调度服务。</li>
 * <li><b>输入不成立不留记录</b>：类、方法、参数对不上时走 {@link ProbeAssert#inputInvalid}——它们都在场景里，
 * 改对之后是另一个场景，留一条 FAIL 就永远换不掉。实例方法在插件类上 NPE（多半是 getView/getModel 为空）同样算输入不成立：
 * 那是这个方法要插件环境，不是它算错了。</li>
 * </ul>
 */
public class CallSim {

    private static final String NO_THROW = "(没抛异常)";

    public static void run() throws Exception {
        String written = req("CALL_TARGET");
        String argsJson = env("CALL_ARGS").isEmpty() ? "[]" : env("CALL_ARGS");
        String spec = env("CALL_EXPECT");

        int hash = written.indexOf('#');
        if (hash <= 0) {
            ProbeAssert.inputInvalid("call-target", written, "要写成 类名#方法名");
            finish();
            return;
        }
        String clsName = env("CALL_CLASS").isEmpty() ? written.substring(0, hash).trim() : env("CALL_CLASS");
        String rest = written.substring(hash + 1).trim();
        String methodName = rest.contains("(") ? rest.substring(0, rest.indexOf('(')).trim() : rest;
        List<String> signature = null;
        if (rest.contains("(") && rest.endsWith(")")) {
            signature = new ArrayList<String>();
            for (String one : rest.substring(rest.indexOf('(') + 1, rest.length() - 1).split(",")) {
                if (!one.trim().isEmpty()) {
                    signature.add(one.trim());
                }
            }
        }

        String pkgs = env("CALL_PKGS");
        if (!pkgs.isEmpty() && !ownClass(clsName, pkgs)) {
            ProbeAssert.inputInvalid("call-class", clsName, "不是本工程的类（本工程的包：" + pkgs + "），run call 不调它");
            finish();
            return;
        }
        Class<?> type = load(clsName, written.substring(0, hash).trim());
        if (type == null) {
            //class 文件在编译目录里却加载不到，是 JVM 的类路径没指向这个目录；再编译、再重起都不会好。
            String onDisk = classFileOnDisk(clsName, env("CALL_CLASS_DIRS"));
            ProbeAssert.inputInvalid("call-class", clsName, onDisk != null
                    ? "class 文件在 " + onDisk + "，但运行的 JVM 类路径里没有它所在的目录：类路径清单和工程对不上，"
                            + "用 cosmic_doctor action=rebuild force=true 重新生成后再跑"
                    : "类加载不到：编译目录里没有这个类的 class 文件，先编译；内部类要写成 外层类$内部类");
            finish();
            return;
        }

        List<Object> json;
        try {
            Object parsed = CallArgs.parse(argsJson);
            if (!(parsed instanceof List)) {
                throw new CallArgs.Bad("--args", "要一个 JSON 数组，一项对一个参数");
            }
            @SuppressWarnings("unchecked")
            List<Object> list = (List<Object>) parsed;
            json = list;
        } catch (CallArgs.Bad b) {
            ProbeAssert.inputInvalid("call-args", b.path, b.getMessage());
            finish();
            return;
        }

        List<String[]> expects;
        try {
            expects = ExpectSpec.pairs(spec);
        } catch (IllegalArgumentException e) {
            ProbeAssert.inputInvalid("call-expect", spec, e.getMessage());
            finish();
            return;
        }

        List<Method> named = methods(type, methodName);
        if (named.isEmpty()) {
            ProbeAssert.inputInvalid("call-method", written, type.getSimpleName() + " 里（含父类）没有方法 " + methodName
                    + "。它自己声明的方法：" + declaredNames(type));
            finish();
            return;
        }
        List<Method> shaped = new ArrayList<Method>();
        for (Method m : named) {
            if (signature != null && !signatureMatches(m, signature)) {
                continue;
            }
            if (open(m) == json.size()) {
                shaped.add(m);
            }
        }
        if (shaped.isEmpty()) {
            ProbeAssert.inputInvalid("call-method", written, "参数个数对不上：--args 给了 " + json.size() + " 个。"
                    + (signature == null ? "" : "按写的类型 " + signature + " 筛过。") + "这个名字的方法有：" + signatures(named)
                    + "（RequestContext 参数工具自己给，不算在 --args 里）");
            finish();
            return;
        }

        Method chosen = null;
        Object[] args = null;
        CallArgs.Bad firstBad = null;
        List<Method> fits = new ArrayList<Method>();
        List<Object[]> built = new ArrayList<Object[]>();
        for (Method m : shaped) {
            try {
                Object[] a = buildArgs(m, json);
                fits.add(m);
                built.add(a);
            } catch (CallArgs.Bad b) {
                if (firstBad == null) {
                    firstBad = b;
                }
                if (shaped.size() > 1) {
                    System.out.println("[PROBE] " + sig(m) + " 对不上：" + b.path + " " + b.getMessage());
                }
            }
        }
        if (fits.isEmpty()) {
            ProbeAssert.inputInvalid("call-args", firstBad.path, (shaped.size() > 1 ? "几个重载都造不出参数（上面逐个列了），第一个："
                    : sig(shaped.get(0)) + "：") + firstBad.getMessage());
            finish();
            return;
        }
        if (fits.size() > 1) {
            ProbeAssert.inputInvalid("call-method", written, "有 " + fits.size() + " 个重载都对得上这组参数，写成 "
                    + methodName + "(类型,类型) 点名一个：" + signatures(fits));
            finish();
            return;
        }
        chosen = fits.get(0);
        args = built.get(0);
        chosen.setAccessible(true);

        Object target = null;
        boolean isStatic = Modifier.isStatic(chosen.getModifiers());
        if (!isStatic) {
            if (Modifier.isAbstract(type.getModifiers()) || type.isInterface()) {
                ProbeAssert.inputInvalid("call-method", written, sig(chosen) + " 是实例方法，而 " + type.getSimpleName()
                        + " 是抽象类或接口，建不出对象");
                finish();
                return;
            }
            try {
                Constructor<?> ctor = type.getDeclaredConstructor();
                ctor.setAccessible(true);
                target = ctor.newInstance();
            } catch (NoSuchMethodException e) {
                ProbeAssert.inputInvalid("call-method", written, sig(chosen) + " 是实例方法，而 " + type.getSimpleName()
                        + " 没有无参构造器，run call 建不出对象；改调一个静态方法");
                finish();
                return;
            } catch (InvocationTargetException e) {
                ProbeAssert.inputInvalid("call-method", written, type.getSimpleName() + " 的无参构造器抛了异常：" + brief(e.getCause()));
                finish();
                return;
            }
            if (target instanceof Task) {
                Task task = (Task) target;
                task.setTaskId("runcall-" + System.currentTimeMillis());
                task.setMessageHandle(taskMessages());
                System.out.println("[PROBE] 调度任务：taskId=runcall-…，进度消息只打在这里，不发给调度服务");
            }
        }

        System.out.println("[PROBE] 调 " + type.getName() + "#" + sig(chosen) + (isStatic ? "（静态）" : "（无参构造出对象再调）"));
        for (int i = 0; i < args.length; i++) {
            boolean inj = CallArgs.injected(chosen.getParameterTypes()[i]);
            System.out.println("[PROBE]   参数" + (i + 1) + (inj ? "（工具给的 RequestContext）" : "") + " = "
                    + (inj ? "当前登录上下文" : clip(describe(args[i]), 600)));
        }

        Object ret = null;
        Throwable thrown = null;
        long t0 = System.currentTimeMillis();
        System.out.println("[PROBE] --- 调用（真提交：方法写库就真的写了）---");
        try {
            ret = chosen.invoke(target, args);
        } catch (InvocationTargetException e) {
            thrown = e.getCause() == null ? e : e.getCause();
        }
        System.out.println("[PROBE] 耗时 " + (System.currentTimeMillis() - t0) + "ms");
        if (thrown != null) {
            System.out.println("[PROBE] 抛异常 " + brief(thrown));
            for (StackTraceElement e : thrown.getStackTrace()) {
                if (ownClass(e.getClassName(), pkgs)) {
                    System.out.println("[PROBE]    at " + e);
                }
            }
            if (!isStatic && thrown instanceof NullPointerException && pluginClass(type)) {
                ProbeAssert.inputInvalid("call-env", written, type.getSimpleName() + " 是插件类，实例方法在 run call 里 NPE，多半是用到了 "
                        + "getView() / getModel() / 插件事件上下文——那些只有真跑插件时才有。改用 run form / op / print 跑它，"
                        + "或者把要验的计算抽成静态方法再 run call");
                finish();
                return;
            }
        } else if (chosen.getReturnType() == void.class) {
            System.out.println("[PROBE] 返回 void");
        } else {
            System.out.println("[PROBE] 返回 " + clip(describe(ret), 2000));
        }

        ProbeJson.emit("scenario", "adapter", "run call", "class", type.getName(), "method", sig(chosen),
                "static", Boolean.valueOf(isStatic), "rollback", Boolean.TRUE);
        List<Object> openArgs = new ArrayList<Object>();
        for (int i = 0; i < args.length; i++) {
            if (!CallArgs.injected(chosen.getParameterTypes()[i])) {
                openArgs.add(args[i]);
            }
        }
        for (String[] kv : expects) {
            check(kv[0], kv[1], ret, thrown, openArgs);
        }
        if (expects.isEmpty() && thrown != null) {
            finish();
            throw new IllegalStateException("方法抛了异常：" + brief(thrown));
        }
        finish();
    }

    // ---------------- 断言 ----------------

    private static void check(String left, String want, Object ret, Throwable thrown, List<Object> openArgs) {
        boolean contains = left.endsWith("~");
        String path = contains ? left.substring(0, left.length() - 1).trim() : left.trim();
        String kind = contains ? "call-contains" : "call";
        if ("error".equals(path)) {
            String actual = thrown == null ? NO_THROW : brief(thrown);
            if (contains) {
                ProbeAssert.containsText("call-error", left, want, actual);
            } else if (want.trim().isEmpty()) {
                ProbeAssert.isEqual("call-error", "error", NO_THROW, actual);
            } else {
                ProbeAssert.isEqual("call-error", "error", want, thrown == null ? NO_THROW : String.valueOf(thrown.getMessage()));
            }
            return;
        }
        if (thrown != null) {
            ProbeAssert.unresolved(kind, left, want, "方法抛了异常，取不到值：" + brief(thrown));
            return;
        }
        Object value;
        try {
            value = walk(path, ret, openArgs);
        } catch (IllegalArgumentException e) {
            ProbeAssert.unresolved(kind, left, want, e.getMessage());
            return;
        }
        String actual = render(value);
        if (contains) {
            ProbeAssert.containsText(kind, left, want, actual);
        } else if ("@nonempty".equals(want)) {
            ProbeAssert.isEqual(kind, left, want, value);
        } else if ("null".equals(want.trim()) && value == null) {
            ProbeAssert.isEqual(kind, left, null, null);
        } else {
            ProbeAssert.isEqual(kind, left, want, actual == null ? "null" : actual);
        }
    }

    private static final Pattern SEG = Pattern.compile("\\s*(?:\\[\\s*(\\d+)\\s*\\]|\\.?\\s*([A-Za-z_$@][\\w$@]*))");

    /** 按路径走：[i] 取第 i 项，名字取键 / 字段 / getter，size 是个数。 */
    static Object walk(String path, Object ret, List<Object> openArgs) {
        String p = path.trim();
        Object cur = ret;
        String here = "返回值";
        if (p.startsWith("$")) {
            p = p.substring(1);
        } else if (p.startsWith("args")) {
            Matcher m = Pattern.compile("^args\\s*\\[\\s*(\\d+)\\s*\\]").matcher(p);
            if (!m.find()) {
                throw new IllegalArgumentException("args 后面要跟 [参数下标]，例如 args[0]");
            }
            int i = Integer.parseInt(m.group(1));
            if (i >= openArgs.size()) {
                throw new IllegalArgumentException("--args 只有 " + openArgs.size() + " 个参数，没有 args[" + i + "]");
            }
            cur = openArgs.get(i);
            here = "args[" + i + "]";
            p = p.substring(m.end());
        }
        Matcher m = SEG.matcher(p);
        int at = 0;
        while (at < p.length()) {
            if (!m.find(at) || m.start() != at) {
                if (p.substring(at).trim().isEmpty()) {
                    break;
                }
                throw new IllegalArgumentException("路径写法认不出：「" + p.substring(at) + "」");
            }
            at = m.end();
            if (cur instanceof Field && !(cur instanceof CollectionField)) {
                cur = ((Field<?>) cur).getValue();
            }
            if (m.group(1) != null) {
                int i = Integer.parseInt(m.group(1));
                List<?> list = asList(cur);
                if (list == null) {
                    throw new IllegalArgumentException(here + " 是 " + kindOf(cur) + "，不能按 [" + i + "] 取");
                }
                if (i >= list.size()) {
                    throw new IllegalArgumentException(here + " 只有 " + list.size() + " 项（从 0 数），没有 [" + i + "]");
                }
                cur = list.get(i);
                here = here + "[" + i + "]";
                continue;
            }
            String name = m.group(2);
            cur = step(cur, name, here);
            here = here + "." + name;
        }
        return cur;
    }

    private static Object step(Object cur, String name, String here) {
        if (cur == null) {
            throw new IllegalArgumentException(here + " 是 null，取不到 " + name);
        }
        if (cur instanceof DataRowSet) {
            DataRowSet row = (DataRowSet) cur;
            if (row.containerKey(name)) {
                return row.getField(name);
            }
            if ("size".equals(name)) {
                return Integer.valueOf(row.getFieldKeys().size());
            }
            throw new IllegalArgumentException(here + " 这行打印数据里没有字段 " + name + "，有的：" + row.getFieldKeys());
        }
        if (cur instanceof DynamicObject) {
            DynamicObject o = (DynamicObject) cur;
            if (o.getDataEntityType().getProperties().containsKey(name)) {
                return o.get(name);
            }
            throw new IllegalArgumentException(here + "（" + o.getDataEntityType().getName() + "）上没有字段 " + name);
        }
        if (cur instanceof Map) {
            Map<?, ?> map = (Map<?, ?>) cur;
            if (map.containsKey(name)) {
                return map.get(name);
            }
            if ("size".equals(name)) {
                return Integer.valueOf(map.size());
            }
            throw new IllegalArgumentException(here + " 里没有键 " + name + "，有的：" + clip(String.valueOf(map.keySet()), 300));
        }
        List<?> list = asList(cur);
        if (list != null) {
            if ("size".equals(name)) {
                return Integer.valueOf(list.size());
            }
            throw new IllegalArgumentException(here + " 是列表（" + list.size() + " 项），要先写 [下标] 再取 " + name
                    + "，或者写 size 取个数");
        }
        String cap = Character.toUpperCase(name.charAt(0)) + name.substring(1);
        for (String getter : new String[]{"get" + cap, "is" + cap, name}) {
            try {
                Method g = cur.getClass().getMethod(getter);
                return g.invoke(cur);
            } catch (NoSuchMethodException ignored) {
                // 换下一种写法
            } catch (Exception e) {
                throw new IllegalArgumentException(here + "." + getter + "() 调用失败：" + brief(e));
            }
        }
        try {
            java.lang.reflect.Field f = cur.getClass().getField(name);
            return f.get(cur);
        } catch (Exception ignored) {
            // 落到下面的报错
        }
        throw new IllegalArgumentException(here + " 是 " + kindOf(cur) + "，上面没有 " + name);
    }

    private static List<?> asList(Object cur) {
        if (cur instanceof CollectionField) {
            return ((CollectionField) cur).getValue();
        }
        if (cur instanceof List) {
            return (List<?>) cur;
        }
        if (cur instanceof Collection) {
            return new ArrayList<Object>((Collection<?>) cur);
        }
        if (cur != null && cur.getClass().isArray()) {
            List<Object> out = new ArrayList<Object>();
            for (int i = 0; i < java.lang.reflect.Array.getLength(cur); i++) {
                out.add(java.lang.reflect.Array.get(cur, i));
            }
            return out;
        }
        return null;
    }

    /** 断言比的字符串：打印字段取值、基础资料取编码、日期按到秒（零点只到天）。 */
    static String render(Object value) {
        if (value instanceof CollectionField) {
            return describe(value);
        }
        if (value instanceof Field) {
            Object inner = ((Field<?>) value).getValue();
            return inner == null ? "" : render(inner);
        }
        if (value instanceof Date) {
            String full = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss").format((Date) value);
            return full.endsWith(" 00:00:00") ? full.substring(0, 10) : full;
        }
        if (value instanceof BigDecimal) {
            return ((BigDecimal) value).toPlainString();
        }
        if (value instanceof DynamicObject) {
            return ExpectSpec.render(value);
        }
        if (value == null) {
            return null;
        }
        if (value instanceof Collection || value instanceof Map || value.getClass().isArray()) {
            return describe(value);
        }
        if (plainBean(value)) {
            return bean(value, 0);
        }
        return String.valueOf(value);
    }

    /** 没有自己的 toString 的对象：String.valueOf 只给出「类名@地址」，改按 getter 列属性。 */
    private static boolean plainBean(Object value) {
        if (value instanceof CharSequence || value instanceof Number || value instanceof Boolean
                || value instanceof Character || value instanceof Enum || value instanceof Class) {
            return false;
        }
        try {
            return value.getClass().getMethod("toString").getDeclaringClass() == Object.class;
        } catch (NoSuchMethodException e) {
            return false;
        }
    }

    /** {属性=值}：属性名和断言路径的写法一样（getErrorCode → errorCode），嵌套超过 3 层只写类名。 */
    private static String bean(Object value, int depth) {
        if (depth >= 3) {
            return value.getClass().getSimpleName() + "{…}";
        }
        Map<String, String> out = new java.util.TreeMap<String, String>();
        for (Method m : value.getClass().getMethods()) {
            String n = m.getName();
            int skip = n.startsWith("get") ? 3 : n.startsWith("is") ? 2 : 0;
            if (skip == 0 || n.length() == skip || m.getParameterTypes().length > 0
                    || Modifier.isStatic(m.getModifiers()) || m.getReturnType() == void.class
                    || m.getDeclaringClass() == Object.class) {
                continue;
            }
            String key = Character.toLowerCase(n.charAt(skip)) + n.substring(skip + 1);
            try {
                Object v = m.invoke(value);
                out.put(key, v != null && plainBean(v) ? bean(v, depth + 1) : render(v));
            } catch (Exception e) {
                out.put(key, "(取值失败：" + brief(e) + ")");
            }
        }
        return value.getClass().getSimpleName() + out;
    }

    /** 打给人看的值：列表逐项、打印数据行按 {字段=值}、普通对象按 {属性=值}。 */
    static String describe(Object value) {
        if (value instanceof DataRowSet) {
            DataRowSet row = (DataRowSet) value;
            Map<String, String> out = new LinkedHashMap<String, String>();
            for (String key : row.getFieldKeys()) {
                out.put(key, render(row.getField(key)));
            }
            return out.toString();
        }
        if (value instanceof Map) {
            Map<String, String> out = new LinkedHashMap<String, String>();
            for (Map.Entry<?, ?> e : ((Map<?, ?>) value).entrySet()) {
                out.put(String.valueOf(e.getKey()), e.getValue() instanceof DataRowSet ? describe(e.getValue())
                        : render(e.getValue()));
            }
            return out.toString();
        }
        List<?> list = asList(value);
        if (list != null) {
            List<String> out = new ArrayList<String>();
            for (Object one : list) {
                out.add(one instanceof DataRowSet || one instanceof Map ? describe(one) : render(one));
            }
            return out.toString();
        }
        if (value instanceof DynamicObject) {
            DynamicObject o = (DynamicObject) value;
            return o.getDataEntityType().getName() + "(pk=" + o.getPkValue() + ")";
        }
        String r = render(value);
        return r == null ? "null" : r;
    }

    // ---------------- 找方法 ----------------

    private static Class<?> load(String cls, String written) {
        ClassLoader[] loaders = {Thread.currentThread().getContextClassLoader(), CallSim.class.getClassLoader()};
        List<String> names = new ArrayList<String>();
        names.add(cls);
        //a.b.Outer.Inner → a.b.Outer$Inner
        String n = written;
        while (n.lastIndexOf('.') > 0) {
            int dot = n.lastIndexOf('.');
            n = n.substring(0, dot) + "$" + n.substring(dot + 1);
            names.add(n);
        }
        for (String name : names) {
            for (ClassLoader loader : loaders) {
                if (loader == null) {
                    continue;
                }
                try {
                    return Class.forName(name, true, loader);
                } catch (ClassNotFoundException ignored) {
                    // 下一个
                } catch (LinkageError e) {
                    System.out.println("[PROBE] ⚠ 加载 " + name + " 出错：" + e);
                }
            }
        }
        return null;
    }

    /** 本类和父类里叫这个名字的方法；子类重写过的父类方法不重复列。 */
    private static List<Method> methods(Class<?> type, String name) {
        List<Method> out = new ArrayList<Method>();
        List<String> seen = new ArrayList<String>();
        for (Class<?> c = type; c != null && c != Object.class; c = c.getSuperclass()) {
            for (Method m : c.getDeclaredMethods()) {
                if (!m.getName().equals(name) || m.isSynthetic() || m.isBridge()) {
                    continue;
                }
                String key = java.util.Arrays.toString(m.getParameterTypes());
                if (!seen.contains(key)) {
                    seen.add(key);
                    out.add(m);
                }
            }
        }
        return out;
    }

    private static int open(Method m) {
        int n = 0;
        for (Class<?> p : m.getParameterTypes()) {
            if (!CallArgs.injected(p)) {
                n++;
            }
        }
        return n;
    }

    private static boolean signatureMatches(Method m, List<String> written) {
        Type[] types = m.getGenericParameterTypes();
        Class<?>[] raws = m.getParameterTypes();
        if (types.length != written.size()) {
            return false;
        }
        for (int i = 0; i < types.length; i++) {
            String w = written.get(i).replace(" ", "");
            String simple = raws[i].getSimpleName();
            String generic = CallArgs.typeName(types[i]).replace(" ", "");
            if (!w.equalsIgnoreCase(simple) && !w.equals(raws[i].getName()) && !w.equalsIgnoreCase(generic)) {
                return false;
            }
        }
        return true;
    }

    private static Object[] buildArgs(Method m, List<Object> json) {
        Type[] types = m.getGenericParameterTypes();
        Class<?>[] raws = m.getParameterTypes();
        Object[] out = new Object[types.length];
        int next = 0;
        for (int i = 0; i < types.length; i++) {
            if (CallArgs.injected(raws[i])) {
                out[i] = CallArgs.inject(raws[i]);
                continue;
            }
            out[i] = CallArgs.build(types[i], json.get(next), "参数" + (i + 1) + "（" + CallArgs.typeName(types[i]) + "）");
            next++;
        }
        return out;
    }

    static String sig(Method m) {
        StringBuilder sb = new StringBuilder(m.getName()).append('(');
        Type[] types = m.getGenericParameterTypes();
        for (int i = 0; i < types.length; i++) {
            sb.append(i == 0 ? "" : ", ").append(CallArgs.typeName(types[i]));
        }
        return sb.append(')').toString();
    }

    private static String signatures(List<Method> methods) {
        List<String> out = new ArrayList<String>();
        for (Method m : methods) {
            out.add(sig(m) + (Modifier.isStatic(m.getModifiers()) ? " static" : ""));
        }
        return out.toString();
    }

    private static String declaredNames(Class<?> type) {
        List<String> out = new ArrayList<String>();
        for (Method m : type.getDeclaredMethods()) {
            if (!m.isSynthetic() && !out.contains(m.getName())) {
                out.add(m.getName());
            }
        }
        java.util.Collections.sort(out);
        return clip(out.toString(), 600);
    }

    /** 这个类的 class 文件在哪个代码模块的编译目录里；都没有就是 null。 */
    private static String classFileOnDisk(String cls, String dirs) {
        if (dirs.isEmpty()) {
            return null;
        }
        String rel = cls.replace('.', '/') + ".class";
        for (String dir : dirs.split(Pattern.quote(java.io.File.pathSeparator))) {
            if (dir.trim().isEmpty()) {
                continue;
            }
            java.io.File file = new java.io.File(dir.trim(), rel);
            if (file.isFile()) {
                return file.getPath();
            }
        }
        return null;
    }

    private static boolean ownClass(String cls, String pkgs) {
        if (pkgs.isEmpty()) {
            return false;
        }
        for (String p : pkgs.split(",")) {
            String prefix = p.trim();
            if (!prefix.isEmpty() && cls.startsWith(prefix)) {
                return true;
            }
        }
        return false;
    }

    /** 平台插件基类的子类：父类链上有 kd.bos 里名字带 Plugin / PlugIn 的类。 */
    private static boolean pluginClass(Class<?> type) {
        for (Class<?> c = type.getSuperclass(); c != null; c = c.getSuperclass()) {
            String n = c.getName();
            if (n.startsWith("kd.bos.") && (n.contains("Plugin") || n.contains("PlugIn"))) {
                return true;
            }
        }
        return false;
    }

    /** 调度任务的消息出口：打在输出里，不发给调度服务。 */
    private static MessageHandler taskMessages() {
        final MessageSender sender = (MessageSender) Proxy.newProxyInstance(CallSim.class.getClassLoader(),
                new Class<?>[]{MessageSender.class}, new InvocationHandler() {
                    public Object invoke(Object proxy, Method method, Object[] a) {
                        if (method.getDeclaringClass() == Object.class) {
                            return objectMethod(proxy, method, a);
                        }
                        Object first = a == null || a.length == 0 ? null : a[0];
                        if (first instanceof MessageInfo) {
                            System.out.println("[PROBE]   任务消息（没发出去）：" + clip(String.valueOf(((MessageInfo) first).getBody()), 300));
                        } else if (first instanceof List) {
                            System.out.println("[PROBE]   任务消息 " + ((List<?>) first).size() + " 条（没发出去）");
                            return new int[((List<?>) first).size()];
                        }
                        return method.getReturnType() == boolean.class ? Boolean.TRUE : null;
                    }
                });
        final ObjectFactory factory = (ObjectFactory) Proxy.newProxyInstance(CallSim.class.getClassLoader(),
                new Class<?>[]{ObjectFactory.class}, new InvocationHandler() {
                    public Object invoke(Object proxy, Method method, Object[] a) {
                        if (method.getDeclaringClass() == Object.class) {
                            return objectMethod(proxy, method, a);
                        }
                        if ("getMessageSender".equals(method.getName())) {
                            return sender;
                        }
                        if ("init".equals(method.getName())) {
                            return null;
                        }
                        throw new UnsupportedOperationException("run call 不接调度服务的 " + method.getName());
                    }
                });
        return (MessageHandler) Proxy.newProxyInstance(CallSim.class.getClassLoader(),
                new Class<?>[]{MessageHandler.class}, new InvocationHandler() {
                    public Object invoke(Object proxy, Method method, Object[] a) {
                        if (method.getDeclaringClass() == Object.class) {
                            return objectMethod(proxy, method, a);
                        }
                        if ("getObjFactory".equals(method.getName())) {
                            return factory;
                        }
                        if ("handle".equals(method.getName()) && a != null && a[0] instanceof MessageInfo) {
                            System.out.println("[PROBE]   任务消息（没发出去）：" + clip(String.valueOf(((MessageInfo) a[0]).getBody()), 300));
                        }
                        return null;
                    }
                });
    }

    private static Object objectMethod(Object proxy, Method method, Object[] a) {
        if ("equals".equals(method.getName())) {
            return Boolean.valueOf(a != null && proxy == a[0]);
        }
        if ("hashCode".equals(method.getName())) {
            return Integer.valueOf(System.identityHashCode(proxy));
        }
        return "run-call-proxy";
    }

    // ---------------- 杂项 ----------------

    private static String kindOf(Object value) {
        return value == null ? "null" : value.getClass().getSimpleName();
    }

    private static String brief(Throwable t) {
        return t.getClass().getSimpleName() + ": " + HeadlessUiSupport.oneLine(t.getMessage());
    }

    /** 打给人看的值：换行写 \n（和断言同一种写法，{@link ProbeAssert#shown}），太长截断。 */
    private static String clip(String s, int max) {
        if (s == null) {
            return "null";
        }
        s = ProbeAssert.shown(s);
        return s.length() > max ? s.substring(0, max) + "…（共 " + s.length() + " 字）" : s;
    }

    private static void finish() {
        if (!ProbeAssert.summary()) {
            throw new ProbeAssert.Failed("断言失败");
        }
    }

    private static String env(String key) {
        String value = System.getenv(key);
        return value == null ? "" : value.trim();
    }

    private static String req(String key) {
        String value = env(key);
        if (value.isEmpty()) {
            throw new IllegalArgumentException("必须给 " + key);
        }
        return value;
    }
}
