import kd.bos.bill.BillLayoutSchemeService;
import kd.bos.entity.BillEntityType;
import kd.bos.entity.EntityMetadataCache;
import kd.bos.entity.MainEntityType;
import kd.bos.entity.bill.BillLayoutSchemeAssignEntity;
import kd.bos.metadata.billlayout.BillLayoutReader;
import kd.bos.threads.ThreadPools;

/**
 * 后台替单据先读好提交时「布局必录校验」要用的布局方案（共用类，不是探针）。
 *
 * 一个进程里第一次提交某类单据时，平台的 BillLayoutRequiredValidator 把这类单的每个布局方案从库里读出、拼好，
 * 存在本进程（LayoutSchemeLocalCache），之后同一进程再提交就直接用。真机检测单 32 个方案、每个 2 秒多：
 * 第一次提交 98 秒，先读好再提交 19 秒；每次新起常驻进程都要再付一次（2026-10-07 五次会话的第一次提交 76～105 秒）。
 * 探针一碰到哪类单据，就在后台线程替它读一遍，等到真提交时已经读好。只把元数据读进缓存，不碰业务数据；
 * 读失败不管，提交时平台照常自己读。一类单据一个进程只排一次：标记放在系统属性里，
 * 探针每次重编译，类里的静态字段跟着丢。常驻进程才有 probe.hotOut（server.ts 起进程时给）。
 */
public final class Warmup {

    private Warmup() {
    }

    public static void layouts(final String entity) {
        //只在常驻进程里读：冷进程跑完就退出，读了也留不下，还和探针抢库
        if (entity == null || entity.isEmpty() || System.getProperty("probe.hotOut") == null) {
            return;
        }
        if (System.getProperties().putIfAbsent("cosmic.warmup.layouts." + entity, "1") != null) {
            return;
        }
        ThreadPools.executeOnceIncludeRequestContext("cosmic-probe-warmup", new Runnable() {
            public void run() {
                try {
                    MainEntityType type = EntityMetadataCache.getDataEntityType(entity);
                    if (!(type instanceof BillEntityType)) {
                        return;
                    }
                    for (BillLayoutSchemeAssignEntity s : BillLayoutSchemeService.getLayoutSchemeAssignEntityFromCache(entity)) {
                        BillLayoutReader.loadDifferentialControlInfosFromCache(entity, s.getId());
                    }
                } catch (Throwable ignore) {
                    //提交时平台自己再读
                }
            }
        });
    }
}
