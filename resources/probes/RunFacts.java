import java.util.ArrayList;
import java.util.Collection;
import java.util.List;

import kd.bos.metadata.dao.MetaCategory;
import kd.bos.metadata.dao.MetadataDao;
import kd.bos.metadata.entity.EntityMetadata;

/**
 * 不是探针，是共用类：run 的各个适配器告诉 cosmic_facts「这次运行碰到了谁」的两条机器记录。
 *
 * - {@code committed}：运行之后库里这张单的现状，带「是不是这次新建的」。事实账据此列出留在测试环境的单，
 *   后面再跑到这张单的运行也标出它是本会话怎么造出来的。没有它，`run op save` 真存进库的单在事实账里
 *   是「造出 0 条」：真机 2026-11-19 模型拿自己手填字段建的检测单跑反审核，报错归成了「既有插件报错」。
 * - {@code own-plugins}：这次真执行的操作、开的表单上挂着哪些本工程插件（按 OP_PKGS 认）。
 *   事实账据此对「本会话改过的插件有没有被哪次运行跑到」：同一次会话里挂在提交、反审核上的额度插件
 *   一次没跑过，事实账只列了一串界面运行「断言全过」，看不出来。
 *
 * 两条都只给 TypeScript 侧记账，不进模型上下文（record-budget.ts 的 FACTS_RECORD_TYPES）；
 * 人读的那一行（「数据库现状」、插件清单）各自照旧。
 */
final class RunFacts {
    private RunFacts() {
    }

    /** 本工程的包前缀，带结尾的点；run 没传 OP_PKGS 时是空数组。 */
    static String[] ownPkgs() {
        String raw = System.getenv("OP_PKGS");
        List<String> out = new ArrayList<String>();
        if (raw == null) {
            return new String[0];
        }
        for (String one : raw.split(",")) {
            String v = one.trim();
            if (!v.isEmpty()) {
                out.add(v.endsWith(".") ? v : v + ".");
            }
        }
        return out.toArray(new String[0]);
    }

    /** 里面属于本工程的类名，去重、保持顺序。 */
    static List<String> own(Collection<String> classes) {
        String[] pkgs = ownPkgs();
        List<String> out = new ArrayList<String>();
        if (classes == null) {
            return out;
        }
        for (String cls : classes) {
            if (cls == null || out.contains(cls)) {
                continue;
            }
            for (String pkg : pkgs) {
                if (cls.startsWith(pkg)) {
                    out.add(cls);
                    break;
                }
            }
        }
        return out;
    }

    /**
     * 这个操作上挂着、启用着的本工程插件类，按元数据里的顺序。读的是设计元数据的现状，
     * 本会话刚挂上去的插件也在。读不到元数据、没给包前缀时是 null —— 和「确实没挂」分开。
     */
    static List<String> opPlugins(String entity, String op) {
        if (ownPkgs().length == 0 || entity == null || op == null) {
            return null;
        }
        try {
            EntityMetadata em = (EntityMetadata) MetadataDao.readMeta(
                    MetadataDao.getIdByNumber(entity, MetaCategory.Entity), MetaCategory.Entity);
            List<String> all = new ArrayList<String>();
            for (Object item : em.getItems()) {
                Object ops = getter(item, "getOperations");
                if (!(ops instanceof List)) {
                    continue;
                }
                for (Object o : (List<?>) ops) {
                    if (!op.equals(String.valueOf(getter(o, "getKey")))) {
                        continue;
                    }
                    Object pls = getter(o, "getPlugins");
                    if (!(pls instanceof List)) {
                        continue;
                    }
                    for (Object p : (List<?>) pls) {
                        if (!Boolean.FALSE.equals(getter(p, "isEnabled"))) {
                            all.add(String.valueOf(getter(p, "getClassName")));
                        }
                    }
                }
            }
            return own(all);
        } catch (Throwable unreadable) {
            return null;
        }
    }

    /** 发一条 own-plugins：where 是「op submit」「form zlgd_demo」「push 规则id」这种。一个本工程类都没有就不发。 */
    static void plugins(String entity, String where, Collection<String> classes) {
        List<String> mine = own(classes);
        if (mine.isEmpty()) {
            return;
        }
        ProbeJson.emit("own-plugins", "entity", entity, "where", where, "classes", mine);
    }

    /** 发一条 committed：created 是「这张单是这次运行新建的」，拿不准时给 null。 */
    static void committed(String entity, Object pk, Object billno, Object status, String what, Boolean created) {
        ProbeJson.emit("committed", "entity", entity, "pk", String.valueOf(pk),
                "billno", billno == null ? null : String.valueOf(billno),
                "status", status == null ? null : String.valueOf(status),
                "what", what, "created", created);
    }

    private static Object getter(Object target, String name) {
        if (target == null) {
            return null;
        }
        try {
            return target.getClass().getMethod(name).invoke(target);
        } catch (Throwable e) {
            return null;
        }
    }
}
