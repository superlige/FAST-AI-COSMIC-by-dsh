import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.lang.reflect.Proxy;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.Collections;
import java.util.Comparator;
import java.util.Deque;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import kd.bos.form.FormConfig;
import kd.bos.form.IClientViewProxy;
import kd.bos.form.IPageCache;
import kd.bos.form.operate.MutexHelper;
import kd.bos.form.plugin.IFormPlugin;
import kd.bos.mvc.SessionManager;
import kd.bos.mvc.cache.PageCache;
import kd.bos.mvc.form.FormView;

/**
 * 表单/列表无头仿真的共用底座。
 *
 * 这里只放与具体 View 无关的五类能力：内存/真实页面缓存、客户端记账代理、FormConfig 插件过滤、
 * 插件异常归属、真实缓存生命周期。业务事件和输出分类仍留在各自的 FormSim / ListSim，
 * 避免两套输出契约互相污染。
 */
public final class HeadlessUiSupport {

    private HeadlessUiSupport() {
    }

    public interface ClientCallSink {
        void accept(Class<?> iface, Method method, Object[] args);
    }

    /** 给少数“前端输入”方法注入真测试状态；其它方法仍走安全默认返回值。 */
    public interface ClientReturnProvider {
        boolean supports(Class<?> iface, Method method, Object[] args);

        Object value(Class<?> iface, Method method, Object[] args);
    }

    /** 本次运行里 {@link PluginSelection#hold()} 住的插件清单，后摘的在上面，还原时先还它。 */
    private static final Deque<PluginSelection> HELD = new ArrayDeque<PluginSelection>();

    /**
     * 把本次运行 hold 住的插件清单全部还原，返回还原了几份。常驻进程每跑完一个探针都调一次
     * （CosmicProbeServer 的 afterRun），探针怎么结束都一样，探针自己不用管。
     * 按后摘先还的顺序：同一张表单重建视图时又摘过一次，那次记下的「原来」已经是摘过的。
     */
    public static int restoreHeld() {
        int restored = 0;
        while (!HELD.isEmpty()) {
            HELD.pop().restore();
            restored++;
        }
        return restored;
    }

    /**
     * FormConfig 来自全 JVM 共享缓存：install 之后必须还原，要么在 finally 中 restore，要么 hold 到运行结束。
     */
    public static final class PluginSelection {
        private final FormConfig config;
        private final List<Object> origin;
        private final List<Object> kept;
        private final List<String> dropped;

        PluginSelection(FormConfig config, List<Object> origin, List<Object> kept, List<String> dropped) {
            this.config = config;
            this.origin = origin;
            this.kept = kept;
            this.dropped = dropped;
        }

        public List<Object> origin() {
            return origin;
        }

        public List<Object> kept() {
            return kept;
        }

        public List<String> dropped() {
            return dropped;
        }

        public void install() {
            config.setPlugins(rawList(kept));
        }

        public void restore() {
            config.setPlugins(rawList(origin));
        }

        /**
         * 摘掉的插件保持到这次运行结束，由 {@link #restoreHeld()} 还原；没摘掉什么就不动。
         *
         * 平台读插件清单不止建视图那一下：activate 里 createClientConfig 又按同一份 FormConfig 建一遍插件
         * （FormShowParameter.createClientConfig → FormConfig.createPlugin），只在 initialize 前后换清单的话，
         * 那一步拿到的是还原后的全量清单，摘掉的类照样被加载，缺类的插件照样在打开表单时报 not find。
         */
        public void hold() {
            if (dropped.isEmpty()) {
                return;
            }
            install();
            HELD.push(this);
        }
    }

    public static PluginSelection selectPlugins(FormConfig config, String skipSpec) {
        List<Object> origin = new ArrayList<Object>();
        if (config.getPlugins() != null) {
            origin.addAll(config.getPlugins());
        }
        List<Object> kept = new ArrayList<Object>();
        List<String> dropped = new ArrayList<String>();
        Set<String> skips = new HashSet<String>();
        if (skipSpec != null) {
            for (String one : skipSpec.split(",")) {
                if (!one.trim().isEmpty()) {
                    skips.add(one.trim());
                }
            }
        }
        for (Object plugin : origin) {
            String className = String.valueOf(call(plugin, "getClassName"));
            String simple = className.lastIndexOf('.') >= 0
                    ? className.substring(className.lastIndexOf('.') + 1) : className;
            if (skips.contains(simple) || skips.contains(className)) {
                dropped.add(className);
            } else {
                kept.add(plugin);
            }
        }
        return new PluginSelection(config, origin, kept, dropped);
    }

    @SuppressWarnings("unchecked")
    public static <T> T recorder(final Class<T> iface, final ClientCallSink sink) {
        return recorder(iface, sink, null);
    }

    /**
     * 记账代理。发往浏览器的通道（{@code IClientViewProxy}）先试着建成平台真类 {@code ClientViewProxy} 的对象
     * （宿主的 {@code cosmic.headless.ClientChannelHook}）：原厂插件有一批把通道强转成具体类再调，动态代理转不过去，
     * 插件当场抛错、排在它后面的插件这一步全没跑到。建不成（冷进程、挂 JRebel、宿主里没有那个类）退回动态代理，
     * 原因见 {@link #channelWhy()}。两种对象收到的调用走同一个处理器，记账一样。
     */
    @SuppressWarnings("unchecked")
    public static <T> T recorder(final Class<T> iface, final ClientCallSink sink,
                                 final ClientReturnProvider returnProvider) {
        InvocationHandler handler = handler(iface, sink, returnProvider);
        if (iface == IClientViewProxy.class) {
            Object channel = realChannel(handler);
            if (channel != null) {
                return (T) channel;
            }
        }
        return (T) Proxy.newProxyInstance(HeadlessUiSupport.class.getClassLoader(), new Class<?>[]{iface}, handler);
    }

    /** 是不是这里建的记账对象（动态代理或平台真类的通道）：平台再次放进视图时不用再换。 */
    public static boolean isRecorder(Object service) {
        if (service == null) {
            return false;
        }
        if (Proxy.isProxyClass(service.getClass())) {
            return true;
        }
        Object owns = hookCall("owns", new Class<?>[]{Object.class}, service);
        return Boolean.TRUE.equals(owns);
    }

    /** 通道为什么没建成平台真类；建成了是 null。 */
    public static String channelWhy() {
        Object installed = hookCall("install", new Class<?>[0]);
        if (Boolean.TRUE.equals(installed)) {
            return null;
        }
        Object why = hookCall("why", new Class<?>[0]);
        return why == null ? "常驻宿主里没有 cosmic.headless.ClientChannelHook（编译它要苍穹库里的 ASM）" : String.valueOf(why);
    }

    private static Object realChannel(InvocationHandler handler) {
        if (!Boolean.TRUE.equals(hookCall("install", new Class<?>[0]))) {
            return null;
        }
        return hookCall("create", new Class<?>[]{InvocationHandler.class}, handler);
    }

    /** 宿主类按名字找：探针编译时不带它，宿主里没有它（编不过、冷进程）时这里当没有。 */
    private static Object hookCall(String name, Class<?>[] types, Object... args) {
        try {
            Class<?> hook = Class.forName("cosmic.headless.ClientChannelHook", true, ClassLoader.getSystemClassLoader());
            return hook.getMethod(name, types).invoke(null, args);
        } catch (Throwable t) {
            return null;
        }
    }

    private static InvocationHandler handler(final Class<?> iface, final ClientCallSink sink,
                                             final ClientReturnProvider returnProvider) {
        return new InvocationHandler() {
                    public Object invoke(Object proxy, Method method, Object[] args) {
                        if (sink != null) {
                            sink.accept(iface, method, args);
                        }
                        if (returnProvider != null && returnProvider.supports(iface, method, args)) {
                            return returnProvider.value(iface, method, args);
                        }
                        Class<?> returnType = method.getReturnType();
                        if (returnType.isPrimitive() || returnType.isArray() || returnType == String.class) {
                            return defaultValue(returnType);
                        }
                        return fill(fake(returnType, sink));
                    }
                };
    }

    private static Object fake(Class<?> type, ClientCallSink sink) {
        if (type.isInterface()) {
            return recorder(type, sink);
        }
        try {
            Constructor<?> constructor = type.getDeclaredConstructor();
            constructor.setAccessible(true);
            return constructor.newInstance();
        } catch (Throwable ignore) {
            //继续尝试其它构造器
        }
        List<Constructor<?>> constructors = new ArrayList<Constructor<?>>(
                Arrays.asList(type.getDeclaredConstructors()));
        Collections.sort(constructors, new Comparator<Constructor<?>>() {
            public int compare(Constructor<?> left, Constructor<?> right) {
                return left.getParameterTypes().length - right.getParameterTypes().length;
            }
        });
        for (Constructor<?> constructor : constructors) {
            try {
                Class<?>[] parameterTypes = constructor.getParameterTypes();
                Object[] args = new Object[parameterTypes.length];
                for (int i = 0; i < parameterTypes.length; i++) {
                    args[i] = defaultValue(parameterTypes[i]);
                }
                constructor.setAccessible(true);
                return constructor.newInstance(args);
            } catch (Throwable ignore) {
                //继续尝试
            }
        }
        try {
            Field field = Class.forName("sun.misc.Unsafe").getDeclaredField("theUnsafe");
            field.setAccessible(true);
            Object unsafe = field.get(null);
            return unsafe.getClass().getMethod("allocateInstance", Class.class).invoke(unsafe, type);
        } catch (Throwable ignore) {
            return null;
        }
    }

    private static Object fill(Object value) {
        if (value == null) {
            return null;
        }
        for (Class<?> type = value.getClass(); type != null && type != Object.class; type = type.getSuperclass()) {
            for (Field field : type.getDeclaredFields()) {
                if (Modifier.isStatic(field.getModifiers())) {
                    continue;
                }
                try {
                    field.setAccessible(true);
                    if (field.get(value) != null) {
                        continue;
                    }
                    Class<?> fieldType = field.getType();
                    if (Map.class.isAssignableFrom(fieldType)) {
                        field.set(value, new HashMap<Object, Object>());
                    } else if (Set.class.isAssignableFrom(fieldType)) {
                        field.set(value, new HashSet<Object>());
                    } else if (Collection.class.isAssignableFrom(fieldType)) {
                        field.set(value, new ArrayList<Object>());
                    } else if (fieldType == String.class) {
                        field.set(value, "");
                    } else if (fieldType.isArray()) {
                        field.set(value, java.lang.reflect.Array.newInstance(fieldType.getComponentType(), 0));
                    }
                } catch (Throwable ignore) {
                    //假返回值只做尽力补空
                }
            }
        }
        return value;
    }

    /** 单进程内的页面缓存；适合快速验证不跨请求的插件事件。 */
    public static IPageCache memPageCache(final Map<String, Object> cache) {
        return (IPageCache) Proxy.newProxyInstance(HeadlessUiSupport.class.getClassLoader(),
                new Class<?>[]{IPageCache.class}, new InvocationHandler() {
                    @SuppressWarnings("unchecked")
                    public Object invoke(Object proxy, Method method, Object[] args) {
                        String name = method.getName();
                        int count = args == null ? 0 : args.length;
                        if (("put".equals(name) || "putBigObject".equals(name)) && count == 2) {
                            cache.put(String.valueOf(args[0]), args[1]);
                            return null;
                        }
                        if ("put".equals(name) && count == 1 && args[0] instanceof Map) {
                            cache.putAll((Map<String, Object>) args[0]);
                            return null;
                        }
                        if (("get".equals(name) || "getBigObject".equals(name)) && count >= 1) {
                            return cache.get(String.valueOf(args[0]));
                        }
                        if (("remove".equals(name) || "removeBigObject".equals(name)) && count >= 1) {
                            cache.remove(String.valueOf(args[0]));
                            return null;
                        }
                        if ("getAll".equals(name)) {
                            return new HashMap<String, Object>(cache);
                        }
                        return defaultValue(method.getReturnType());
                    }
                });
    }

    /**
     * 真实 Redis 页面缓存，每次 put 当场写进 Redis（batchSave=false），和平台请求线程里拿到的一样：
     * FormServiceImpl.batchInvokeAction 先 SessionManager.setRequestThread(true)，这时
     * SessionManager.getPageCache 建的就是不攒批的 PageCache。
     *
     * 不能攒批：FormView.activate 里 FormConfigFactory.createConfig 会另建一份同 pageId 的 PageCache
     * 登记进 SessionManager，视图手里还是这一份。攒批的话，activate 之后经视图写的值（平台记的编辑锁标识
     * MUTEX_*、插件在 loadData / afterBindData 里存的值）只留在这份没登记的对象里，commitCache 提交不到它：
     * 下一次请求从缓存重建页面读不到，跑完放锁也找不到锁，之后提交这张单被拒「正在PC端编辑该记录」
     * （真机 2026-11-18：验收单表单验证完，独立提交两次都被这条拦住）。
     *
     * PageCache 构造器会按当前 RequestContext.globalSessionId 生成隔离的 region key，
     * 并自动登记到当前 SessionManager。
     */
    public static IPageCache realPageCache(String pageId, Map<String, Object> seeds) {
        IPageCache cache = new PageCache(pageId, false);
        if (seeds != null) {
            for (Map.Entry<String, Object> entry : seeds.entrySet()) {
                cache.put(entry.getKey(), entry.getValue() == null ? null : String.valueOf(entry.getValue()));
            }
        }
        return cache;
    }

    /**
     * 把一个已经完成 create/load 的真 View 按平台请求尾声的顺序落到 Redis。
     * FormShowParameter 负责让 SessionManager 能重建 View；updateCache 负责创建/刷新 ModelCache 根键。
     */
    public static void persistRealView(FormView view, int ttlSeconds) {
        if (view == null) {
            return;
        }
        view.cacheFormShowParameter();
        view.getModel().updateCache();
        SessionManager.getCurrent().commitCache();
        IPageCache pageCache = (IPageCache) view.getService(IPageCache.class);
        pageCache.expireAfter(ttlSeconds);
        view.getModel().cacheExpireAfter(ttlSeconds);
    }

    /**
     * 放掉这张表单在库里给单据记的「正在编辑」锁，放了就返回「实体 pk」，没占着返回 null。
     *
     * 单据表单保存过、或按修改打开已有单据时，平台把这张单记成「这个页面正在编辑」（锁的标识存在页面缓存
     * MUTEX_ENTITY_KEY / MUTEX_OPER_KEY / MUTEX_OBJ_ID 里），界面关掉时才放（BillView.onClose →
     * MutexHelper.release）。模拟的表单没人关，锁就一直挂着：之后别的会话提交这张单，被拒「某某正在PC端编辑该记录」，
     * 隔几分钟也不消，只有换掉常驻进程才放（真机 2026-10-07：照现成复制的检测单保存后提交不了）。
     */
    public static String releaseMutex(FormView view) {
        if (view == null) {
            return null;
        }
        IPageCache cache = (IPageCache) view.getService(IPageCache.class);
        String obj = cache == null ? null : cache.get("MUTEX_OBJ_ID");
        if (obj == null || obj.isEmpty()) {
            return null;
        }
        String entity = cache.get("MUTEX_ENTITY_KEY");
        //平台放成了会把三个标识清空；回 false 是锁还挂着，照实报出去，不当放了
        if (!MutexHelper.release(view)) {
            throw new IllegalStateException("平台没放 " + entity + " " + obj + "（MutexHelper.release 回 false）");
        }
        return entity + " " + obj;
    }

    /**
     * 删除仿真产生的 ModelCache、PageCache 和本进程 SessionManager 引用。
     * 每一步独立尽力执行，避免某个插件的 release 异常阻止后续 Redis 清理。
     * 编辑锁最先放：它的标识存在页面缓存里，页面缓存清了就找不到了。
     */
    public static List<String> releaseRealView(FormView view) {
        List<String> errors = new ArrayList<String>();
        if (view == null) {
            return errors;
        }
        try {
            releaseMutex(view);
        } catch (Throwable throwable) {
            errors.add("编辑锁: " + brief(throwable));
        }
        String pageId = view.getPageId();
        String rootPageId = view.getFormShowParameter().getRootPageId();
        if (rootPageId == null || rootPageId.isEmpty()) {
            rootPageId = pageId;
        }
        try {
            view.getModel().release();
        } catch (Throwable throwable) {
            errors.add("ModelCache: " + brief(throwable));
        }
        try {
            Object cache = view.getService(IPageCache.class);
            if (cache instanceof PageCache) {
                ((PageCache) cache).release();
            }
        } catch (Throwable throwable) {
            errors.add("PageCache: " + brief(throwable));
        }
        try {
            SessionManager.getCurrent().clearPageSession(rootPageId, pageId);
        } catch (Throwable throwable) {
            errors.add("SessionManager: " + brief(throwable));
        }
        return errors;
    }

    @SuppressWarnings("unchecked")
    public static List<Object> livePlugins(Object proxy) {
        if (proxy != null) {
            Object publicList = call(proxy, "getPlugIns");
            if (publicList instanceof List) {
                return new ArrayList<Object>((List<Object>) publicList);
            }
            for (Class<?> type = proxy.getClass(); type != null && type.getName().startsWith("kd.");
                 type = type.getSuperclass()) {
                for (Field field : type.getDeclaredFields()) {
                    if (!List.class.isAssignableFrom(field.getType())) {
                        continue;
                    }
                    try {
                        field.setAccessible(true);
                        Object value = field.get(proxy);
                        if (value instanceof List && !((List<?>) value).isEmpty()
                                && ((List<?>) value).get(0) instanceof IFormPlugin) {
                            return (List<Object>) value;
                        }
                    } catch (Throwable ignore) {
                        //继续查父类字段
                    }
                }
            }
        }
        return new ArrayList<Object>();
    }

    public static String culprit(Set<String> pluginNames, Throwable throwable) {
        StackTraceElement frame = pluginFrame(pluginNames, throwable);
        return frame == null ? null : outer(frame.getClassName());
    }

    /**
     * 栈里第一帧落在装进来的插件里的位置（类.方法(文件:行)）。插件的内部类、匿名类、lambda
     * （{@code DemoPlugin$1}、{@code DemoPlugin$$Lambda$12}）算它外层那个插件。
     */
    public static StackTraceElement pluginFrame(Set<String> pluginNames, Throwable throwable) {
        for (StackTraceElement element : root(throwable).getStackTrace()) {
            if (pluginNames.contains(outer(element.getClassName()))) {
                return element;
            }
        }
        return null;
    }

    private static String outer(String className) {
        int inner = className.indexOf('$');
        return inner < 0 ? className : className.substring(0, inner);
    }

    /**
     * 异常是不是仿真探针自己抛的：抛点（根因的第一帧）落在探针类上。探针类都在默认包里，类名不带点。
     * 这种情况错在仿真，不在业务代码和平台。
     */
    public static boolean thrownBySimulator(Throwable throwable) {
        StackTraceElement[] stack = root(throwable).getStackTrace();
        return stack.length > 0 && stack[0].getClassName().indexOf('.') < 0;
    }

    /**
     * 起因链上第一个苍穹业务异常（{@code kd.bos.exception.KDBizException} 或它的子类）的消息：
     * 插件拿它拒绝一次操作，浏览器把消息弹给用户。没有就是 null。按类名认，不引用平台类。
     */
    public static String bizMessage(Throwable throwable) {
        Throwable at = throwable;
        for (int depth = 0; at != null && depth < 8; depth++) {
            for (Class<?> type = at.getClass(); type != null; type = type.getSuperclass()) {
                if ("kd.bos.exception.KDBizException".equals(type.getName())) {
                    return oneLine(at.getMessage());
                }
            }
            at = at.getCause() == at ? null : at.getCause();
        }
        return null;
    }

    /** 整条起因链，外层在前：{@code 外层类: 消息 ← 起因 根因类: 消息}，最多四层。 */
    public static String causes(Throwable throwable) {
        StringBuilder value = new StringBuilder();
        Throwable at = throwable;
        for (int depth = 0; at != null && depth < 4; depth++) {
            value.append(depth == 0 ? "" : " ← 起因 ").append(at.getClass().getName()).append(": ").append(oneLine(at.getMessage()));
            if (at.getCause() == at) {
                break;
            }
            at = at.getCause();
        }
        return value.toString();
    }

    /**
     * 根因的前几帧。没带栈时照实说：HotSpot 对编译过的代码里反复抛的空指针、越界、强转失败
     * 会改抛一个预先建好、不带栈的异常，常驻 JVM 启动时带 -XX:-OmitStackTraceInFastThrow 关掉了它，
     * 仍为空说明这个 JVM 不是那样起的。
     */
    public static String stack(Throwable throwable, int count) {
        if (root(throwable).getStackTrace().length == 0) {
            return "（这个异常没带栈：JVM 没带 -XX:-OmitStackTraceInFastThrow 启动，重起常驻 JVM 后再跑就有）";
        }
        return top(throwable, count);
    }

    public static Object call(Object target, String name) {
        if (target == null) {
            return null;
        }
        for (Class<?> type = target.getClass(); type != null; type = type.getSuperclass()) {
            try {
                Method method = type.getDeclaredMethod(name);
                method.setAccessible(true);
                return method.invoke(target);
            } catch (NoSuchMethodException ignore) {
                //继续查父类
            } catch (Throwable throwable) {
                return "?";
            }
        }
        return target.toString();
    }

    @SuppressWarnings({"rawtypes", "unchecked"})
    public static List rawList(List<Object> values) {
        return new ArrayList(values);
    }

    public static String deep(Object[] args) {
        if (args == null) {
            return "()";
        }
        String value = Arrays.deepToString(args);
        value = value.substring(1, value.length() - 1);
        return "(" + (value.length() > 140 ? value.substring(0, 140) + "…" : value) + ")";
    }

    public static Object defaultValue(Class<?> type) {
        if (!type.isPrimitive() || type == void.class) {
            return null;
        }
        if (type == boolean.class) {
            return Boolean.FALSE;
        }
        if (type == int.class) {
            return Integer.valueOf(0);
        }
        if (type == long.class) {
            return Long.valueOf(0L);
        }
        if (type == double.class) {
            return Double.valueOf(0d);
        }
        if (type == float.class) {
            return Float.valueOf(0f);
        }
        if (type == short.class) {
            return Short.valueOf((short) 0);
        }
        if (type == byte.class) {
            return Byte.valueOf((byte) 0);
        }
        return Character.valueOf((char) 0);
    }

    public static String oneLine(String value) {
        return value == null ? "(无)" : value.replace("\r", " ").replace("\n", " ");
    }

    public static Throwable root(Throwable throwable) {
        Throwable value = throwable;
        while (value.getCause() != null && value.getCause() != value) {
            value = value.getCause();
        }
        return value;
    }

    public static String top(Throwable throwable, int count) {
        StackTraceElement[] stack = root(throwable).getStackTrace();
        StringBuilder value = new StringBuilder();
        for (int i = 0; i < stack.length && i < count; i++) {
            value.append(i > 0 ? " | " : "").append(stack[i].toString());
        }
        return value.toString();
    }

    public static String brief(Throwable throwable) {
        Throwable root = root(throwable);
        return root.getClass().getName() + ": " + oneLine(root.getMessage());
    }
}
