import kd.bos.mservice.spi.rpc.MServiceLookup;
import kd.bos.service.DispatchService;
import kd.bos.service.lookup.ServiceLookup;

import java.util.concurrent.atomic.AtomicInteger;

/**
 * 服务分发桥：让探针进程里的 RPC 分发调用走本地实现，而不是抛
 * {@code java.lang.Error: ServiceLookup not implemented}。
 *
 * <p>为什么只需要这一处：所有 {@code XxxServiceHelper} 的分发最终都收敛到同一个口 ——
 * {@code DispatchService.invoke("kd.bos.service.ServiceFactory", 服务名, 方法名, 参数)}。
 * 把 {@code DispatchService} 这一个接口指向本进程的 {@code DispatchServiceImpl}，
 * 整个分发层就通了（{@code OperationServiceHelper.executeOperate}、{@code FormView.activate} 等）。
 * 其余接口原样交给原厂 {@code AssemblyServiceLookup}。
 *
 * <p><b>桥指向本进程，不联网、不注册到 ZK，不会影响共享环境上的其它节点。</b>
 * 但它同时意味着：装桥之后探针里的写操作是<b>真的会执行</b>的。
 * 以前那个 {@code ServiceLookup not implemented} 从来不是保护措施，只是缺一层桥
 * （{@code SaveServiceHelper.save} 直连 ORM，压根不受它拦）。写操作的规矩：
 * 元数据写入 dry-run 默认、{@code APPLY=1} 才落库且强制冷进程；验证类运行（run op / form / print …）
 * S27 起真提交（用户 2026-09-19：agent 连的必然是纯测试环境）。
 *
 * <p>由宿主在 {@link CosmicProbe#initEnv()} 里统一安装 —— 冷探针和常驻宿主共用那一个入口，
 * 两条路径不会漂移，探针里不用再自己装。装不上不中止宿主：记下原因，让真正用到分发的
 * 探针带着这条原因去报错，而不是让所有探针陪葬。
 */
final class ServiceBridge {

    private static final String DISPATCH_IMPL = "kd.bos.service.DispatchServiceImpl";
    private static final String ASSEMBLY_LOOKUP = "kd.bos.mservice.rpc.assembly.AssemblyServiceLookup";

    private static final AtomicInteger DISPATCH_HITS = new AtomicInteger();
    private static final AtomicInteger ASSEMBLY_HITS = new AtomicInteger();

    private static boolean installed;
    private static String status = "未安装";

    private ServiceBridge() {
    }

    /** 幂等：重复调用只返回上次的结论，不会二次 setImpl */
    static synchronized String install() {
        if (installed) {
            return status;
        }
        installed = true;
        try {
            final MServiceLookup assembly = (MServiceLookup) Class.forName(ASSEMBLY_LOOKUP).newInstance();
            final Object dispatch = Class.forName(DISPATCH_IMPL).newInstance();
            ServiceLookup.setImpl(new MServiceLookup() {
                public Object lookup(Class c, String appId) {
                    if (DispatchService.class.equals(c)) {
                        DISPATCH_HITS.incrementAndGet();
                        return dispatch;
                    }
                    ASSEMBLY_HITS.incrementAndGet();
                    return assembly.lookup(c, appId);
                }

                public Object lookupEndpoint(Class c, String appId, String ep) {
                    ASSEMBLY_HITS.incrementAndGet();
                    return assembly.lookupEndpoint(c, appId, ep);
                }

                public Object lookupHttp(Class c, String appId, String url) {
                    ASSEMBLY_HITS.incrementAndGet();
                    return assembly.lookupHttp(c, appId, url);
                }
            });
            status = "OK";
        } catch (Throwable t) {
            Throwable r = t;
            while (r.getCause() != null && r.getCause() != r) {
                r = r.getCause();
            }
            status = "装不上: " + r.getClass().getName() + ": " + String.valueOf(r.getMessage()).replace('\n', ' ');
        }
        return status;
    }

    /** "OK" 或者装不上的原因。用到 RPC 分发的探针报错时把它带上，省得从 not implemented 倒推 */
    static String status() {
        return status;
    }

    static boolean ok() {
        return "OK".equals(status);
    }

    /** 分发命中计数，只给诊断用：DispatchService 走本地几次 / 其余交回 assembly 几次 */
    static String hits() {
        return "dispatch=" + DISPATCH_HITS.get() + " assembly=" + ASSEMBLY_HITS.get();
    }
}
