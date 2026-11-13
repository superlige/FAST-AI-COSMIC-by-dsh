package cosmic.headless;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.lang.instrument.ClassDefinition;
import java.lang.instrument.Instrumentation;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationHandler;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.WeakHashMap;

import org.objectweb.asm.ClassReader;
import org.objectweb.asm.ClassVisitor;
import org.objectweb.asm.ClassWriter;
import org.objectweb.asm.Label;
import org.objectweb.asm.MethodVisitor;
import org.objectweb.asm.Opcodes;
import org.objectweb.asm.Type;
import org.objectweb.asm.commons.GeneratorAdapter;
import org.objectweb.asm.commons.Method;

/**
 * 宿主自带，不是探针：让 run form / run list 的「发往浏览器的通道」是平台真类 {@code kd.bos.mvc.form.ClientViewProxy}，
 * 同时每个调用照样进记账。
 *
 * <p>为什么要这样：仿真用的记账代理原来是 JDK 动态代理（只实现 {@code IClientViewProxy} 接口）。
 * 原厂插件里有一批直接强转成具体类再调（{@code (ClientViewProxy) getView().getService(IClientViewProxy.class)}，
 * 本机苍穹 8.0 的 biz、bos 包里 49 个 jar、88 个类这样写），动态代理转不过去，插件当场 ClassCastException，
 * 排在它后面的插件这一步全没跑到（真机 2026-10-10 销售订单打开时 BillTplPlugin.setDiscountRateScale）。
 * 给平台类做个子类也不行：{@code addAction}、{@code invokeControlMethod} 这类记账最要紧的方法是 final，子类拦不住。
 *
 * <p>做法：常驻进程有换类入口（{@code CosmicProbeServer$HotSwapAgent}，启动时 -javaagent 挂上），
 * 用它把 ClientViewProxy 原地换成「每个方法进门先问一句」的版本：这个对象是仿真登记过的，就交给登记的处理器
 * （和原来动态代理的处理器是同一个），不往下走；没登记的（平台自己的通道）原样往下走。
 * 仿真的对象不跑构造函数（{@code Unsafe.allocateInstance}），字段全空——它的每个方法都在进门时被接走，碰不到字段。
 *
 * <p>没有换类入口（挂 JRebel、冷进程）或换不进去时 {@link #install()} 返回 false，调用方退回动态代理，
 * 原因记在 {@link #why()}。这个类单独编译，编不过（类路径里没有 ASM）宿主照样起，探针按类名找不到它就当没有。
 */
public final class ClientChannelHook {

    /** 方法进门时问到「不是我的」，就返回它，原方法接着往下走。 */
    public static final Object PASS = new Object();

    private static final String TARGET = "kd.bos.mvc.form.ClientViewProxy";
    private static final String HOOK = "cosmic/headless/ClientChannelHook";

    private static final Map<Object, InvocationHandler> HANDLERS =
            Collections.synchronizedMap(new WeakHashMap<Object, InvocationHandler>());
    private static volatile java.lang.reflect.Method[] methods;
    private static volatile Boolean installed;
    private static volatile String why = "还没装";
    private static volatile Class<?> target;

    private ClientChannelHook() {
    }

    /** 装上钩子，一个进程只装一次；装不上返回 false，原因见 {@link #why()}。 */
    public static synchronized boolean install() {
        if (installed != null) {
            return installed.booleanValue();
        }
        try {
            Instrumentation inst = instrumentation();
            if (inst == null) {
                return fail("这个进程没有换类入口（挂了 JRebel，或者是冷进程）");
            }
            if (!inst.isRedefineClassesSupported()) {
                return fail("这个 JVM 不支持换类");
            }
            Class<?> cls = Class.forName(TARGET, true, ClassLoader.getSystemClassLoader());
            byte[] original = bytesOf(cls);
            List<String> keys = new ArrayList<String>();
            byte[] patched = patch(original, keys, cls.getClassLoader());
            java.lang.reflect.Method[] table = resolve(cls, keys);
            methods = table;
            inst.redefineClasses(new ClassDefinition(cls, patched));
            target = cls;
            installed = Boolean.TRUE;
            why = null;
            return true;
        } catch (Throwable t) {
            return fail("换类失败：" + t);
        }
    }

    /** 装不上的原因；装上了是 null。 */
    public static String why() {
        return why;
    }

    /** 新建一个平台真类的通道对象，它的每个方法都交给 handler（handler 的 proxy 参数收到的就是这个对象）。 */
    public static Object create(InvocationHandler handler) throws Exception {
        if (!install()) {
            throw new IllegalStateException(why);
        }
        Field field = Class.forName("sun.misc.Unsafe").getDeclaredField("theUnsafe");
        field.setAccessible(true);
        Object unsafe = field.get(null);
        Object channel = unsafe.getClass().getMethod("allocateInstance", Class.class).invoke(unsafe, target);
        HANDLERS.put(channel, handler);
        return channel;
    }

    /** 是不是仿真登记过的通道。 */
    public static boolean owns(Object channel) {
        return channel != null && HANDLERS.containsKey(channel);
    }

    /** 换进去的每个方法进门先调这里。不是登记过的对象返回 {@link #PASS}。 */
    public static Object call(Object self, int index, Object[] args) throws Throwable {
        InvocationHandler handler = HANDLERS.isEmpty() ? null : HANDLERS.get(self);
        if (handler == null) {
            return PASS;
        }
        return handler.invoke(self, methods[index], args);
    }

    private static boolean fail(String reason) {
        installed = Boolean.FALSE;
        why = reason;
        return false;
    }

    /** 换类入口在默认包的宿主类里，命名包里写不出它的名字，只能按类名找。 */
    private static Instrumentation instrumentation() {
        try {
            Class<?> agent = Class.forName("CosmicProbeServer$HotSwapAgent", true, ClassLoader.getSystemClassLoader());
            Field field = agent.getDeclaredField("inst");
            field.setAccessible(true);
            return (Instrumentation) field.get(null);
        } catch (Throwable t) {
            return null;
        }
    }

    private static byte[] bytesOf(Class<?> cls) throws Exception {
        String resource = cls.getName().replace('.', '/') + ".class";
        ClassLoader loader = cls.getClassLoader() == null ? ClassLoader.getSystemClassLoader() : cls.getClassLoader();
        InputStream in = loader.getResourceAsStream(resource);
        if (in == null) {
            throw new IllegalStateException("读不到 " + resource);
        }
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
            }
            return out.toByteArray();
        } finally {
            in.close();
        }
    }

    /**
     * 每个实例方法（构造函数、private、static 除外）进门加一段：
     * {@code r = ClientChannelHook.call(this, 序号, 参数数组); if (r != PASS) return r;}。
     * private 方法只会从别的方法里调到，那些方法对仿真的对象已经在进门处接走了。
     */
    static byte[] patch(byte[] original, final List<String> keys, final ClassLoader loader) {
        ClassReader reader = new ClassReader(original);
        ClassWriter writer = new ClassWriter(reader, ClassWriter.COMPUTE_MAXS | ClassWriter.COMPUTE_FRAMES) {
            @Override
            protected ClassLoader getClassLoader() {
                return loader == null ? ClassLoader.getSystemClassLoader() : loader;
            }

            @Override
            protected String getCommonSuperClass(String a, String b) {
                try {
                    return super.getCommonSuperClass(a, b);
                } catch (Throwable t) {
                    return "java/lang/Object";
                }
            }
        };
        ClassVisitor visitor = new ClassVisitor(Opcodes.ASM9, writer) {
            @Override
            public MethodVisitor visitMethod(int access, String name, String desc, String signature,
                    String[] exceptions) {
                MethodVisitor mv = super.visitMethod(access, name, desc, signature, exceptions);
                int skip = Opcodes.ACC_PRIVATE | Opcodes.ACC_STATIC | Opcodes.ACC_ABSTRACT | Opcodes.ACC_NATIVE
                        | Opcodes.ACC_BRIDGE | Opcodes.ACC_SYNTHETIC;
                if ((access & skip) != 0 || name.startsWith("<")) {
                    return mv;
                }
                final int index = keys.size();
                keys.add(name + desc);
                return new GeneratorAdapter(Opcodes.ASM9, mv, access, name, desc) {
                    @Override
                    public void visitCode() {
                        super.visitCode();
                        Type object = Type.getType(Object.class);
                        Type hook = Type.getObjectType(HOOK);
                        loadThis();
                        push(index);
                        loadArgArray();
                        invokeStatic(hook, new Method("call", object,
                                new Type[]{object, Type.INT_TYPE, Type.getType(Object[].class)}));
                        dup();
                        getStatic(hook, "PASS", object);
                        Label proceed = newLabel();
                        ifCmp(object, GeneratorAdapter.EQ, proceed);
                        Type ret = Type.getReturnType(desc);
                        if (ret.getSort() == Type.VOID) {
                            pop();
                        } else {
                            unbox(ret);
                        }
                        returnValue();
                        mark(proceed);
                        pop();
                    }
                };
            }
        };
        reader.accept(visitor, ClassReader.SKIP_FRAMES);
        return writer.toByteArray();
    }

    /** 序号 → 反射方法：处理器按方法名和返回类型干活，和接口上的同名方法一样。 */
    static java.lang.reflect.Method[] resolve(Class<?> cls, List<String> keys) {
        Map<String, java.lang.reflect.Method> byKey = new HashMap<String, java.lang.reflect.Method>();
        for (java.lang.reflect.Method m : cls.getDeclaredMethods()) {
            byKey.put(m.getName() + Type.getMethodDescriptor(m), m);
        }
        java.lang.reflect.Method[] table = new java.lang.reflect.Method[keys.size()];
        for (int i = 0; i < table.length; i++) {
            table[i] = byKey.get(keys.get(i));
            if (table[i] == null) {
                throw new IllegalStateException("找不到方法 " + keys.get(i));
            }
        }
        return table;
    }
}
