import java.lang.reflect.Method;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import kd.bos.metadata.dao.MetaCategory;
import kd.bos.metadata.dao.MetadataDao;
import kd.bos.metadata.entity.EntityItem;
import kd.bos.metadata.entity.EntityMetadata;

/**
 * 只读：报一张单的必录字段和必录分录，给 cosmic_run 在冷启动之前核对「这次 --set 给的够不够开一张合法单」。
 *
 *   META_ENTITY=实体标识   要查的实体或布局（必填）
 *
 * 走 JSON 旁路：`t=mustinput-summary` 一行 + `t=mustinput` 逐条。
 * 逐条里 `kind=field` 是字段必录、`kind=entry` 是分录必录（至少一行）；
 * 两种都带设计态的「必录条件」（`cond` 表达式 + `condDesc` 说明，没配为空 = 始终必录）。
 */
public class MustInputProbe {

    public static void run() throws Exception {
        String entity = req("META_ENTITY", "要查的实体或布局标识");

        //入参可能是布局标识，MetaResolve 会换算成实体再取设计态 id
        String id = MetaResolve.designId(entity);
        EntityMetadata em = (EntityMetadata) MetadataDao.readMeta(id, MetaCategory.Entity);

        List<EntityItem<?>> items = em.getItems();
        //父子关系先摊平：必录字段落在表头还是某条分录上，决定了它要不要 --set
        Map<String, EntityItem<?>> byId = new LinkedHashMap<>();
        for (EntityItem<?> item : items) {
            Object itemId = call(item, "getId");
            if (itemId != null) {
                byId.put(String.valueOf(itemId), item);
            }
        }
        //汇总行先发：没有它时「一个必录字段都没有」和「这个探针根本没跑到这一步」
        //在 JSON 旁路上长得一模一样，而消费方要按前者放行、按后者闭嘴
        ProbeJson.emit("mustinput-summary", "entity", em.getKey(), "asked", entity, "items", items.size());
        int fields = 0;
        int entries = 0;
        for (EntityItem<?> item : items) {
            String cls = item.getClass().getSimpleName();
            String key = item.getKey();
            String disp = String.valueOf(item.getName());

            //「必录条件」只在勾了「必录」时才生效（设计器原话：条件为空则始终必录）：
            //平台 FieldProp/EntryProp.getValidators 只在必录为真时才挂 RequiredValidator，
            //条件是在那之上再收窄。所以只看勾没勾，条件跟着报，不单独当成一种必录。
            if (Boolean.TRUE.equals(call(item, "isMustInput"))) {
                Object def = call(item, "getDefValue");
                String[] cond = condition(item);
                ProbeJson.emit("mustinput",
                        "entity", em.getKey(),
                        "kind", "field",
                        "key", key,
                        "name", disp,
                        "type", cls,
                        //所属分录标识，表头字段为空 —— 表头才是 --set 直接给得了的那一层
                        "entry", entryOf(item, byId),
                        //设计态自带默认值的，校验器到那一步时字段已经有值了，不该催人填
                        "def", def == null ? "" : String.valueOf(def),
                        "cond", cond[0],
                        "condDesc", cond[1]);
                fields++;
            }
            //分录的「必录」是另一个开关：isEntryMustInput，意思是「这个分录至少要有一行」。
            //它不叫 isMustInput，上面那条永远问不到它；单据新增时分录常常是 0 行，保存就被拦。
            if (Boolean.TRUE.equals(call(item, "isEntryMustInput"))) {
                String[] cond = condition(item);
                Object rows = call(item, "getDefaultRows");
                ProbeJson.emit("mustinput",
                        "entity", em.getKey(),
                        "kind", "entry",
                        "key", key,
                        "name", disp,
                        "type", cls,
                        //子分录报它的父分录；父分录没行时子分录根本不会被校验
                        "entry", entryOf(item, byId),
                        "def", "",
                        "rows", rows == null ? 0 : rows,
                        "cond", cond[0],
                        "condDesc", cond[1]);
                entries++;
            }
        }
        //打 em.getKey() 而不是入参：入参可能是布局标识，打出来会误导
        System.out.println("[PROBE] 实体 " + em.getKey() + "  必录字段 " + fields + " 个、必录分录 " + entries + " 个");
    }

    /**
     * 这个字段挂在哪条分录下；表头字段返回空串。
     *
     * 顺着 ParentId 往上找，直到找不到父块为止 —— 子分录字段要报的是它自己那条子分录，
     * 不是最外层。报错了宁可返回空串（当表头看）：多催一句「这个必录字段没给」比
     * 把一条分录字段说成表头字段害处小，后者会让人把 --set 写在错的层级上。
     */
    private static String entryOf(EntityItem<?> item, Map<String, EntityItem<?>> byId) {
        Object parentId = call(item, "getParentId");
        for (int hop = 0; hop < 8 && parentId != null && !"".equals(String.valueOf(parentId)); hop++) {
            EntityItem<?> parent = byId.get(String.valueOf(parentId));
            if (parent == null) {
                return "";
            }
            String cls = parent.getClass().getSimpleName();
            if (cls.contains("Entry")) {
                return String.valueOf(parent.getKey());
            }
            parentId = call(parent, "getParentId");
        }
        return "";
    }

    /**
     * 设计态「必录条件」：{表达式, 描述}，没配就是两个空串。
     *
     * 设计态存的是一个 Map，平台运行时按 `RuleCondition`（表达式）和 `RuleDescription`
     * （设计器里填的中文说明）两个键取（见 FieldProp.createFieldRules / RequiredValidator），
     * 这里照同样两个键读。
     */
    private static String[] condition(Object item) {
        Object raw = call(item, "getMustInputCondition");
        if (!(raw instanceof Map)) {
            return new String[]{"", ""};
        }
        Map<?, ?> map = (Map<?, ?>) raw;
        Object expr = map.get("RuleCondition");
        Object desc = map.get("RuleDescription");
        return new String[]{
                expr == null ? "" : String.valueOf(expr).trim(),
                desc == null ? "" : String.valueOf(desc).trim()};
    }

    private static Object call(Object o, String getter) {
        try {
            Method m = o.getClass().getMethod(getter);
            return m.invoke(o);
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * 必填的环境变量。没给就说清楚该填什么后中止。
     * 抛异常而不是 System.exit()：后者会带走常驻探针 JVM。
     */
    private static String req(String k, String what) {
        String v = System.getenv(k);
        if (v != null && !v.trim().isEmpty()) {
            return v.trim();
        }
        System.out.println("[PROBE] 缺必填参数 " + k + " —— " + what);
        throw new IllegalArgumentException(k + " 未设置");
    }
}
