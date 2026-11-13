import java.lang.reflect.Method;

import kd.bos.metadata.dao.MetaCategory;
import kd.bos.metadata.dao.MetadataDao;
import kd.bos.metadata.entity.EntityMetadata;

/** 只读：看设计态元数据对象上有没有 ISV 相关的属性，好让 IsvGuard 查真值而不是只匹配前缀 */
public class IsvCheckProbe {

    public static void run() throws Exception {
        //一个本 ISV 的实体 + 一个原厂实体，看 getIsv() 分别返回什么。换工程用 ISV_ENTITY 指定前者。
        for (String number : new String[]{env("ISV_ENTITY", IsvGuard.PREFIX + "lsydbzk_csjl"), "bos_org"}) {
            String id = MetadataDao.getIdByNumber(number, MetaCategory.Entity);
            EntityMetadata em = (EntityMetadata) MetadataDao.readMeta(id, MetaCategory.Entity);
            System.out.println("[PROBE] " + number + " -> " + em.getClass().getName());
            for (Method m : em.getClass().getMethods()) {
                String n = m.getName();
                if (m.getParameterCount() == 0
                        && (n.toLowerCase().contains("isv") || n.toLowerCase().contains("bizapp")
                            || n.equals("getDevType") || n.equals("getInheritPath"))) {
                    Object v;
                    try {
                        v = m.invoke(em);
                    } catch (Throwable t) {
                        v = "<" + t + ">";
                    }
                    System.out.println("[PROBE]   " + n + "() = " + v);
                }
            }
        }
    }

    private static String env(String k, String def) {
        String v = System.getenv(k);
        return v == null || v.trim().isEmpty() ? def : v;
    }
}
