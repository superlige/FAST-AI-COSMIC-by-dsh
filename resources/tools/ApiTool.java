import java.io.File;
import java.io.OutputStream;
import java.io.PrintStream;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.GenericArrayType;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.lang.reflect.ParameterizedType;
import java.lang.reflect.Type;
import java.lang.reflect.TypeVariable;
import java.lang.reflect.WildcardType;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/**
 * 查苍穹 API 的离线工具 —— 不启动苍穹，不连数据库，1~2 秒出结果。
 *
 *   ApiTool sig  <全限定类名> [成员关键字]   打类的字段/构造/方法签名（public、protected），含静态常量的值，
 *                                            末尾两段是从父类、接口继承来的
 *   ApiTool find <类名关键字> [argfile]      类名记不准时，扫全部依赖 jar 反查全限定名
 *   ApiTool suggest <查询文件> [argfile]     批量反查「最接近的真名」，driver.mjs lint 的后端
 *
 * 为什么不用 javap：
 *   - javac 的 classpath 展开是 380KB，Windows 命令行上限 32KB，直接传会 Argument list too long；
 *   - javap **不读** jar manifest 里的 Class-Path，所以 `javap -classpath cosmic-pathing.jar` 查不到
 *     任何苍穹类（实测：kd.bos.entity.EntityMetadataCache 报「找不到类」）；
 *   - JDK8 的 javap 也不支持 @argfile（javac 才支持）。
 * 而 JVM 是认 pathing jar 的 Class-Path 的，所以走反射查最省事，顺带还能打出常量的值。
 */
public class ApiTool {

    public static void main(String[] args) throws Exception {
        if (args.length >= 2 && "sig".equals(args[0])) {
            sig(args[1], args.length > 2 ? args[2] : "");
        } else if (args.length >= 2 && "find".equals(args[0])) {
            find(args[1], args.length > 2 ? args[2] : "build/cosmic-javac.args");
        } else if (args.length >= 2 && "suggest".equals(args[0])) {
            suggest(args[1], args.length > 2 ? args[2] : "build/cosmic-javac.args");
        } else {
            System.out.println("用法: ApiTool sig <全限定类名> [成员关键字]");
            System.out.println("      ApiTool find <类名关键字> [argfile]");
            System.out.println("      ApiTool suggest <查询文件> [argfile]");
            System.exit(2);
        }
    }

    // ---------------------------------------------------------------- sig

    private static void sig(String fqn, String filter) {
        ClassLoader cl = ApiTool.class.getClassLoader();
        Class<?> c = null;
        boolean initialized = true;
        //苍穹类的静态初始化会把 logback 拉起来往 stdout 刷几十行状态，加载期间先把输出堵上
        PrintStream realOut = System.out;
        PrintStream realErr = System.err;
        PrintStream sink = new PrintStream(new OutputStream() {
            @Override
            public void write(int b) {
                //丢弃
            }
        });
        try {
            System.setOut(sink);
            System.setErr(sink);
            try {
                //先带初始化加载：静态常量的值只有初始化后才读得到（QCP 那种常量表就靠这个）
                c = Class.forName(fqn, true, cl);
            } catch (Throwable first) {
                initialized = false;
                try {
                    c = Class.forName(fqn, false, cl);
                } catch (Throwable second) {
                    c = null;
                }
            }
        } finally {
            System.setOut(realOut);
            System.setErr(realErr);
        }
        if (c == null) {
            System.out.println("找不到类: " + fqn);
            System.out.println("  → 类名可能记错了。用 `driver.mjs findclass " + simpleOf(fqn) + "` 反查真名。");
            System.exit(3);
        }

        String kind = c.isInterface() ? "interface" : c.isEnum() ? "enum"
                : Modifier.isAbstract(c.getModifiers()) ? "abstract class" : "class";
        System.out.println(kind + " " + c.getName());
        System.out.println("  来自 jar : " + codePath(c));
        if (c.getSuperclass() != null && c.getSuperclass() != Object.class) {
            System.out.println("  父类     : " + c.getSuperclass().getName());
        }
        if (c.getInterfaces().length > 0) {
            List<String> is = new ArrayList<>();
            for (Class<?> i : c.getInterfaces()) {
                is.add(i.getName());
            }
            System.out.println("  实现     : " + String.join(", ", is));
        }
        if (!initialized) {
            System.out.println("  (静态初始化失败，常量的值读不到，只有签名)");
        }
        if (!filter.isEmpty()) {
            System.out.println("  过滤关键字: " + filter);
        }

        //public 和 protected 都列，protected 的行首标 protected：基类留给子类的钩子
        //（校验器的 addErrorMessage、后台任务的 feedbackProgress）多是 protected，只列 public 就等于说它们不存在
        List<String> fields = new ArrayList<>();
        for (Field f : c.getDeclaredFields()) {
            if (!visible(f.getModifiers()) || f.isSynthetic() || !match(f.getName(), filter)) {
                continue;
            }
            StringBuilder sb = new StringBuilder("  ").append(access(f.getModifiers()));
            if (Modifier.isStatic(f.getModifiers())) {
                sb.append("static ");
            }
            sb.append(simple(f.getType())).append(' ').append(f.getName());
            if (initialized && Modifier.isStatic(f.getModifiers()) && Modifier.isFinal(f.getModifiers())) {
                try {
                    f.setAccessible(true);
                    sb.append(" = ").append(fmt(f.get(null)));
                } catch (Throwable ignore) {
                    //取不到就只给签名，不是错误
                }
            }
            fields.add(sb.toString());
        }

        List<String> ctors = new ArrayList<>();
        for (Constructor<?> k : c.getDeclaredConstructors()) {
            if (!visible(k.getModifiers()) || k.isSynthetic()) {
                continue;
            }
            ctors.add("  " + access(k.getModifiers()) + "<init>(" + params(k.getParameterTypes()) + ")");
        }

        List<String> methods = new ArrayList<>();
        for (Method m : c.getDeclaredMethods()) {
            if (!visible(m.getModifiers()) || m.isSynthetic() || !match(m.getName(), filter)) {
                continue;
            }
            String flag = access(m.getModifiers()) + (Modifier.isStatic(m.getModifiers()) ? "static " : "");
            String erased = m.getName() + "(" + params(m.getParameterTypes()) + ") -> " + simple(m.getReturnType());
            //擦除后的那行是对照文档的键，不能动；带泛型的另起一行跟在下面，只在和擦除的不一样时给。
            //只给擦除的那行，List<List<Object>> 看着就是 List，照它写 List<List<String>> 编不过（真机 2026-10-09）
            String generic = genericSignature(m);
            methods.add("  " + flag + erased
                    + (generic == null || generic.equals(erased) ? "" : "\n    泛型 " + flag + generic));
        }
        Collections.sort(fields);
        Collections.sort(ctors);
        Collections.sort(methods);

        section("字段/常量", fields);
        section("构造", ctors);
        section("方法", methods);
        inherited(c, filter);
    }

    /**
     * 从父类、接口继承来、子类调得到的方法和字段（public、protected），每行尾巴标出声明它的类。
     * 本类或更近的父类已经声明过的同名同参方法（重写）不再列。
     * 「本类没声明」不等于「这个类上没有」：AbstractListPlugin 的 setFilter 声明在接口上。
     */
    private static void inherited(Class<?> c, String filter) {
        java.util.Set<String> seenMethods = new java.util.HashSet<>();
        java.util.Set<String> seenFields = new java.util.HashSet<>();
        for (Method m : c.getDeclaredMethods()) {
            seenMethods.add(m.getName() + "(" + params(m.getParameterTypes()) + ")");
        }
        for (Field f : c.getDeclaredFields()) {
            seenFields.add(f.getName());
        }
        List<String> methods = new ArrayList<>();
        List<String> fields = new ArrayList<>();
        java.util.Set<Class<?>> visited = new java.util.HashSet<>();
        java.util.ArrayDeque<Class<?>> queue = new java.util.ArrayDeque<>();
        enqueueParents(c, queue);
        while (!queue.isEmpty()) {
            Class<?> p = queue.poll();
            if (p == Object.class || !visited.add(p)) {
                continue;
            }
            enqueueParents(p, queue);
            Method[] ms;
            Field[] fs;
            try {
                ms = p.getDeclaredMethods();
                fs = p.getDeclaredFields();
            } catch (Throwable unreadable) {
                //签名里引用的类不在类路径上：这一层读不出，别的层照列
                continue;
            }
            for (Method m : ms) {
                String key = m.getName() + "(" + params(m.getParameterTypes()) + ")";
                //接口上的静态方法不随实现类继承，只能 接口名.方法 调
                boolean interfaceStatic = p.isInterface() && Modifier.isStatic(m.getModifiers());
                if (!visible(m.getModifiers()) || m.isSynthetic() || interfaceStatic || !match(m.getName(), filter)
                        || !seenMethods.add(key)) {
                    continue;
                }
                methods.add("  " + access(m.getModifiers()) + (Modifier.isStatic(m.getModifiers()) ? "static " : "")
                        + key + " -> " + simple(m.getReturnType()) + "  <- " + p.getName());
            }
            for (Field f : fs) {
                if (!visible(f.getModifiers()) || f.isSynthetic() || !match(f.getName(), filter)
                        || !seenFields.add(f.getName())) {
                    continue;
                }
                fields.add("  " + access(f.getModifiers()) + (Modifier.isStatic(f.getModifiers()) ? "static " : "")
                        + simple(f.getType()) + " " + f.getName() + "  <- " + p.getName());
            }
        }
        Collections.sort(methods);
        Collections.sort(fields);
        section("继承的字段", fields);
        section("继承的方法", methods);
    }

    private static void enqueueParents(Class<?> c, java.util.ArrayDeque<Class<?>> queue) {
        if (c.getSuperclass() != null) {
            queue.add(c.getSuperclass());
        }
        queue.addAll(Arrays.asList(c.getInterfaces()));
    }

    /** 子类里调得到的：public 和 protected。包内可见的跨包子类调不到，不列。 */
    private static boolean visible(int modifiers) {
        return Modifier.isPublic(modifiers) || Modifier.isProtected(modifiers);
    }

    private static String access(int modifiers) {
        return Modifier.isProtected(modifiers) ? "protected " : "";
    }

    private static void section(String title, List<String> lines) {
        if (lines.isEmpty()) {
            return;
        }
        System.out.println("\n--- " + title + " (" + lines.size() + ") ---");
        for (String l : lines) {
            System.out.println(l);
        }
    }

    private static boolean match(String name, String filter) {
        return filter.isEmpty() || name.toLowerCase().contains(filter.toLowerCase());
    }

    private static String params(Class<?>[] ps) {
        List<String> out = new ArrayList<>();
        for (Class<?> p : ps) {
            out.add(simple(p));
        }
        return String.join(", ", out);
    }

    /** 带泛型的签名，写法同擦除那行；反射读不出（泛型里的类不在类路径上）就是 null。 */
    private static String genericSignature(Method m) {
        try {
            List<String> out = new ArrayList<>();
            for (Type p : m.getGenericParameterTypes()) {
                out.add(typeName(p));
            }
            return m.getName() + "(" + String.join(", ", out) + ") -> " + typeName(m.getGenericReturnType());
        } catch (Throwable unreadable) {
            return null;
        }
    }

    /** 类型的简单写法，泛型参数用逗号连、不带空格，和 javac 报错里的写法一样：List<List<Object>>、Map<String,Object>。 */
    private static String typeName(Type t) {
        if (t instanceof Class) {
            return simple((Class<?>) t);
        }
        if (t instanceof ParameterizedType) {
            ParameterizedType p = (ParameterizedType) t;
            List<String> args = new ArrayList<>();
            for (Type a : p.getActualTypeArguments()) {
                args.add(typeName(a));
            }
            return typeName(p.getRawType()) + "<" + String.join(",", args) + ">";
        }
        if (t instanceof GenericArrayType) {
            return typeName(((GenericArrayType) t).getGenericComponentType()) + "[]";
        }
        if (t instanceof WildcardType) {
            WildcardType w = (WildcardType) t;
            if (w.getLowerBounds().length > 0) {
                return "? super " + typeName(w.getLowerBounds()[0]);
            }
            Type[] upper = w.getUpperBounds();
            return upper.length == 0 || upper[0] == Object.class ? "?" : "? extends " + typeName(upper[0]);
        }
        if (t instanceof TypeVariable) {
            return ((TypeVariable<?>) t).getName();
        }
        return String.valueOf(t);
    }

    private static String simple(Class<?> c) {
        String n = c.getSimpleName();
        //java.lang / 基本类型之外的，带上包尾巴，免得 List 和 kd 的同名类混淆
        if (!c.isPrimitive() && c.getName().startsWith("kd.")) {
            return n;
        }
        return n;
    }

    private static String fmt(Object v) {
        if (v instanceof String) {
            return '"' + (String) v + '"';
        }
        if (v != null && v.getClass().isArray()) {
            return Arrays.deepToString(new Object[]{v});
        }
        return String.valueOf(v);
    }

    /** 类所在 jar 的完整路径；拿它直接 javap 或解开看，不用再去找这个 jar。 */
    private static String codePath(Class<?> c) {
        try {
            return new File(c.getProtectionDomain().getCodeSource().getLocation().toURI()).getAbsolutePath();
        } catch (Throwable e) {
            return "?";
        }
    }

    private static String codeSource(Class<?> c) {
        try {
            return new File(c.getProtectionDomain().getCodeSource().getLocation().toURI()).getName();
        } catch (Throwable e) {
            return "?";
        }
    }

    private static String simpleOf(String fqn) {
        int i = fqn.lastIndexOf('.');
        return i < 0 ? fqn : fqn.substring(i + 1);
    }

    // --------------------------------------------------------------- find

    private static void find(String pattern, String argfile) throws Exception {
        String cp = readClassPath(argfile);
        String needle = pattern.toLowerCase();
        //关键字里带点就按全限定名匹配，否则只匹配简单类名
        boolean qualified = pattern.indexOf('.') >= 0;

        List<String> hits = new ArrayList<>();
        int jars = 0;
        int total = 0;
        for (String entry : cp.split(Pattern.quote(File.pathSeparator))) {
            if (!entry.endsWith(".jar")) {
                continue;
            }
            File f = new File(entry);
            if (!f.isFile()) {
                continue;
            }
            jars++;
            try (ZipFile z = new ZipFile(f)) {
                Enumeration<? extends ZipEntry> en = z.entries();
                while (en.hasMoreElements()) {
                    String n = en.nextElement().getName();
                    if (!n.endsWith(".class") || n.indexOf('$') >= 0) {
                        continue;
                    }
                    String cls = n.substring(0, n.length() - 6).replace('/', '.');
                    String hay = qualified ? cls : simpleOf(cls);
                    if (!hay.toLowerCase().contains(needle)) {
                        continue;
                    }
                    total++;
                    if (hits.size() < 60) {
                        //给完整路径：只给文件名，要 javap / 解开看的话就只能满盘去找它
                        hits.add(pad(cls, 62) + " <- " + f.getAbsolutePath());
                    }
                }
            } catch (Exception ignore) {
                //坏 jar 跳过，不影响其它
            }
        }
        Collections.sort(hits);
        for (String h : hits) {
            System.out.println(h);
        }
        System.out.println("--- 扫了 " + jars + " 个 jar，命中 " + total + " 个类"
                + (total > hits.size() ? "（只列前 " + hits.size() + " 个，关键字再给准点）" : "") + " ---");
    }

    private static String readClassPath(String argfile) throws Exception {
        String text = new String(Files.readAllBytes(Paths.get(argfile)), StandardCharsets.UTF_8);
        Matcher m = Pattern.compile("-cp\\s+\"([^\"]*)\"").matcher(text);
        if (m.find()) {
            return m.group(1);
        }
        m = Pattern.compile("-cp\\s+(\\S+)").matcher(text);
        if (m.find()) {
            return m.group(1);
        }
        throw new IllegalStateException("argfile 里没找到 -cp: " + argfile + "（先跑一次 driver.mjs build）");
    }

    private static String pad(String s, int len) {
        StringBuilder sb = new StringBuilder(s);
        while (sb.length() < len) {
            sb.append(' ');
        }
        return sb.toString();
    }

    // ------------------------------------------------------------ suggest

    /**
     * lint 的反查后端：一次 JVM 批量回答「你写的这个符号不存在，最接近的真名是什么」。
     *
     * 查询文件每行一条，制表符分隔：id \t kind \t owner \t name \t arity
     *   kind  = method | ctor | field | class
     *   owner = 全限定类名。class 查询不知道全名就填 "-"；知道全名就填上，此时先直接加载，
     *           加载得到就只回这一行（这是「这个类在不在」的权威答案），加载不到才去扫 jar
     *   name  = 源码里写的那个名字
     *   arity = 实参个数，不知道填 -1（只用来标注「参数个数对得上」）
     * 输出每条一段，首行 "@@ id"，其后每行一个候选（已按接近程度排）。
     * 查不到就只有 @@ 行 —— 调用方据此说「查无此名」，而不是编一个出来。
     *
     * class 查询要扫 4000+ 个 jar，所以**全部 class 查询攒到一起只扫一遍**。
     *
     * 为什么带全名的要先加载：扫 jar 只按简单名打分、只留前 5 个。同名类一多，真类会被
     * 按字母序挤出去 —— 实测 LocaleString 在 bouncycastle 一系的 jar 里有 5 个以上同名类，
     * 全排在 kd.bos.dataentity.entity.LocaleString 前面，于是一个 javac 编得过的 import
     * 被判成「当前 JAR 不存在」。
     */
    private static void suggest(String queryFile, String argfile) throws Exception {
        List<String[]> qs = new ArrayList<>();
        for (String line : Files.readAllLines(Paths.get(queryFile), StandardCharsets.UTF_8)) {
            if (line.trim().isEmpty()) {
                continue;
            }
            String[] p = line.split("\t", -1);
            if (p.length >= 5) {
                qs.add(p);
            }
        }
        //苍穹类加载会往 stdout 刷日志，全程堵住，最后才把结果放出来
        PrintStream realOut = System.out;
        PrintStream realErr = System.err;
        PrintStream sink = new PrintStream(new OutputStream() {
            @Override
            public void write(int b) {
                //丢弃
            }
        });
        StringBuilder result = new StringBuilder();
        List<String[]> classQs = new ArrayList<>();
        //owner 类自己就加载不到的（类名也记错了），结果段要标出来，否则调用方会把类候选
        //当成方法候选念出来
        Map<String, String> ownerLost = new HashMap<>();
        System.setOut(sink);
        System.setErr(sink);
        try {
            for (String[] q : qs) {
                String kind = q[1];
                if ("class".equals(kind)) {
                    Class<?> exact = load(q[2]);
                    if (exact != null) {
                        result.append("@@ ").append(q[0]).append('\n');
                        result.append("  ").append(exact.getName())
                                .append("   <- ").append(codeSource(exact)).append('\n');
                        continue;
                    }
                    classQs.add(new String[]{q[0], q[3], q[2]});
                    continue;
                }
                Class<?> c = load(q[2]);
                if (c == null) {
                    //owner 自己都不存在（类名也记错了），退化成类名反查
                    classQs.add(new String[]{q[0], simpleOf(q[2])});
                    ownerLost.put(q[0], q[2]);
                    continue;
                }
                List<String> lines = "field".equals(kind)
                        ? fieldCandidates(c, q[3])
                        : memberCandidates(c, q[3], parseArity(q[4]), "ctor".equals(kind));
                result.append("@@ ").append(q[0]).append('\n');
                for (String l : lines) {
                    result.append(l).append('\n');
                }
            }
            if (!classQs.isEmpty()) {
                Map<String, List<String>> hits = scanClasses(argfile, classQs);
                for (String[] q : classQs) {
                    result.append("@@ ").append(q[0]).append('\n');
                    if (ownerLost.containsKey(q[0])) {
                        result.append("!类 ").append(ownerLost.get(q[0]))
                                .append(" 本身就查不到，最接近的类名：").append('\n');
                    }
                    List<String> ls = hits.get(q[0]);
                    if (ls != null) {
                        for (String l : ls) {
                            result.append(l).append('\n');
                        }
                    }
                }
            }
        } finally {
            System.setOut(realOut);
            System.setErr(realErr);
        }
        realOut.print(result);
        realOut.flush();
    }

    private static int parseArity(String s) {
        try {
            return Integer.parseInt(s.trim());
        } catch (Exception e) {
            return -1;
        }
    }

    private static Class<?> load(String fqn) {
        if (fqn == null || fqn.isEmpty() || "-".equals(fqn)) {
            return null;
        }
        try {
            //不初始化：suggest 只要签名不要常量值，省掉一堆静态块的时间和副作用
            return Class.forName(fqn, false, ApiTool.class.getClassLoader());
        } catch (Throwable e) {
            return null;
        }
    }

    /** 方法/构造器候选：同名的（那就是参数不对）优先全列，否则按名字接近程度排 */
    private static List<String> memberCandidates(Class<?> c, String name, int arity, boolean ctor) {
        List<String> same = new ArrayList<>();
        if (ctor) {
            for (Constructor<?> k : c.getConstructors()) {
                same.add("  " + c.getSimpleName() + "(" + params(k.getParameterTypes()) + ")"
                        + arityHint(k.getParameterTypes().length, arity));
            }
            Collections.sort(same);
            return same;
        }
        Method[] ms;
        try {
            ms = c.getMethods();
        } catch (Throwable e) {
            return Collections.emptyList();
        }
        List<Object[]> near = new ArrayList<>();
        for (Method m : ms) {
            if (m.isSynthetic()) {
                continue;
            }
            String sig = "  " + (Modifier.isStatic(m.getModifiers()) ? "static " : "")
                    + m.getDeclaringClass().getSimpleName() + "." + m.getName()
                    + "(" + params(m.getParameterTypes()) + ") -> " + simple(m.getReturnType())
                    + arityHint(m.getParameterTypes().length, arity);
            if (m.getName().equals(name)) {
                same.add(sig);
            } else {
                int d = score(m.getName(), name);
                if (d >= 0) {
                    near.add(new Object[]{d, sig});
                }
            }
        }
        if (!same.isEmpty()) {
            Collections.sort(same);
            return same;
        }
        return byDistance(near);
    }

    private static List<String> fieldCandidates(Class<?> c, String name) {
        Field[] fs;
        try {
            fs = c.getFields();
        } catch (Throwable e) {
            return Collections.emptyList();
        }
        List<Object[]> near = new ArrayList<>();
        for (Field f : fs) {
            int d = f.getName().equals(name) ? 0 : score(f.getName(), name);
            if (d < 0) {
                continue;
            }
            near.add(new Object[]{d, "  " + (Modifier.isStatic(f.getModifiers()) ? "static " : "")
                    + f.getDeclaringClass().getSimpleName() + "." + f.getName()
                    + " : " + simple(f.getType())});
        }
        return byDistance(near);
    }

    private static String arityHint(int actual, int want) {
        return want >= 0 && actual == want ? "   <- 参数个数对得上" : "";
    }

    private static List<String> byDistance(List<Object[]> near) {
        Collections.sort(near, new Comparator<Object[]>() {
            @Override
            public int compare(Object[] a, Object[] b) {
                int c = ((Integer) a[0]).compareTo((Integer) b[0]);
                return c != 0 ? c : ((String) a[1]).compareTo((String) b[1]);
            }
        });
        List<String> out = new ArrayList<>();
        for (Object[] o : near) {
            if (out.size() >= 5) {
                break;
            }
            out.add((String) o[1]);
        }
        return out;
    }

    /** 一遍扫完全部 jar，同时回答所有类名查询 */
    private static Map<String, List<String>> scanClasses(String argfile, List<String[]> classQs)
            throws Exception {
        Map<String, List<Object[]>> acc = new HashMap<>();
        for (String[] q : classQs) {
            acc.put(q[0], new ArrayList<Object[]>());
        }
        String cp = readClassPath(argfile);
        for (String entry : cp.split(Pattern.quote(File.pathSeparator))) {
            if (!entry.endsWith(".jar")) {
                continue;
            }
            File f = new File(entry);
            if (!f.isFile()) {
                continue;
            }
            try (ZipFile z = new ZipFile(f)) {
                Enumeration<? extends ZipEntry> en = z.entries();
                while (en.hasMoreElements()) {
                    String n = en.nextElement().getName();
                    if (!n.endsWith(".class") || n.indexOf('$') >= 0) {
                        continue;
                    }
                    String cls = n.substring(0, n.length() - 6).replace('/', '.');
                    String sim = simpleOf(cls);
                    for (String[] q : classQs) {
                        //全名一字不差的排最前（-1），不跟同简单名的一起按字母序抢那 5 个位置
                        boolean same = q.length > 2 && cls.equals(q[2]);
                        int d = same ? -1 : score(sim, q[1]);
                        if (!same && d < 0) {
                            continue;
                        }
                        acc.get(q[0]).add(new Object[]{d, "  " + cls + "   <- " + f.getName()});
                    }
                }
            } catch (Exception ignore) {
                //坏 jar 跳过，不影响其它
            }
        }
        Map<String, List<String>> out = new HashMap<>();
        for (Map.Entry<String, List<Object[]>> e : acc.entrySet()) {
            out.put(e.getKey(), byDistance(e.getValue()));
        }
        return out;
    }

    /**
     * 名字接近程度，越小越接近，-1 表示八竿子打不着。类名和成员名共用一套判据。
     *
     * 光靠编辑距离不够用：幻觉 API 最常见的形态是**在真名上加尾巴**
     * （loadSingle → loadSingleObject，编辑距离 6，任何合理的距离阈值都会把真名筛掉），
     * 所以包含关系必须单独算一档，排在编辑距离之前。
     */
    private static int score(String cand, String want) {
        if (cand.equals(want)) {
            return 0;
        }
        String c = cand.toLowerCase();
        String w = want.toLowerCase();
        if (c.equals(w)) {
            return 1;
        }
        if (c.contains(w) || w.contains(c)) {
            //越短的差别越像是真名（loadSingle 比 loadSingleFromCache 更可能是想写的那个）
            return 2 + Math.abs(cand.length() - want.length());
        }
        int d = distance(c, w);
        return d <= Math.max(2, want.length() / 3) ? 50 + d : -1;
    }

    /** Levenshtein，只用来给候选排序；长度差太大直接判远，省得白算 */
    private static int distance(String a, String b) {
        if (Math.abs(a.length() - b.length()) > 8) {
            return 99;
        }
        int[] prev = new int[b.length() + 1];
        int[] cur = new int[b.length() + 1];
        for (int j = 0; j <= b.length(); j++) {
            prev[j] = j;
        }
        for (int i = 1; i <= a.length(); i++) {
            cur[0] = i;
            for (int j = 1; j <= b.length(); j++) {
                int cost = a.charAt(i - 1) == b.charAt(j - 1) ? 0 : 1;
                cur[j] = Math.min(Math.min(cur[j - 1] + 1, prev[j] + 1), prev[j - 1] + cost);
            }
            int[] t = prev;
            prev = cur;
            cur = t;
        }
        return prev[b.length()];
    }
}
