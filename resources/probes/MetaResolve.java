import java.sql.ResultSet;
import java.util.ArrayList;
import java.util.List;

import kd.bos.dataentity.entity.DynamicObjectCollection;
import kd.bos.dataentity.metadata.ICollectionProperty;
import kd.bos.dataentity.metadata.IComplexProperty;
import kd.bos.dataentity.metadata.IDataEntityProperty;
import kd.bos.dataentity.metadata.IDataEntityType;
import kd.bos.db.DB;
import kd.bos.db.DBRoute;
import kd.bos.db.ResultSetHandler;
import kd.bos.entity.BillEntityType;
import kd.bos.entity.EntityMetadataCache;
import kd.bos.entity.MainEntityType;
import kd.bos.metadata.AbstractMetadata;
import kd.bos.metadata.dao.MetaCategory;
import kd.bos.metadata.dao.MetadataDao;
import kd.bos.metadata.entity.EntityMetadata;
import kd.bos.metadata.form.FormMetadata;
import kd.bos.orm.query.QCP;
import kd.bos.orm.query.QFilter;
import kd.bos.servicehelper.QueryServiceHelper;

/**
 * 不是探针，是共用类：把「界面上看到的那个标识」解析成真正的实体标识。
 *
 * 为什么需要它：苍穹里**布局 ≠ 实体**。开发平台单据列表上、菜单上看到的标识，很多是
 * 表单布局（尤其是继承布局），拿它去 EntityMetadataCache.getDataEntityType() 只会得到
 * 一句「元数据不存在」，看不出来是标识写错了还是给了个布局 —— 这一步不自动化，
 * 每次都要额外烧掉几轮探针才能对上号。
 *
 * 用法：查元数据的探针一律用 MetaResolve.type(key) / entityNumber(key)，
 * 别直接调 EntityMetadataCache.getDataEntityType(key)。
 */
public class MetaResolve {

    /**
     * 给实体标识就原样返回；给布局标识就答出它绑定的实体标识，并打印这层对应关系。
     *
     * **这里只回答「实体元数据去哪查」，不代表调用方把目标换掉了。** 以前这两行打的是
     * 「已自动改用该实体继续」，在 `run form` / `run list` 上是假的：那两条路径仍然开你给的
     * 那张布局 —— 插件清单、界面规则、按钮全按布局取，只有字段类型和分录结构挂在实体上、
     * 必须从实体查。而这句提示排在输出最前面，等于先给人一个「被路由回实体了」的错印象。
     * 真把目标换成实体的调用方（只吃实体的探针），自己头一行就会写清楚跑的是哪个实体。
     *
     * **先用 `getIdByNumber` 问「是哪一类」，别拿 `getDataEntityType` 抛不抛异常当判据。**
     * 后者在布局标识上要失败一次才知道答案，实测大单据上那一次失败 2.5 秒
     * （命中时 0 毫秒，`getIdByNumber` 命中同样 0 毫秒、落空约 90 毫秒）——
     * 每个吃布局标识的探针都在白付。判据本身没变：仍是「有同名实体就当实体」，
     * 只有两者都问不出来时才落到 `getDataEntityType` 兜底。
     */
    public static String entityNumber(String key) {
        return entityNumber(key, true);
    }

    /**
     * @param say 给的是布局时打不打印对应关系；别的探针顺带开表单（造数复制）时不打，免得像换了目标
     *
     * 认出来的实体顺带排进后台预读（{@link Warmup#layouts}）：探针碰到的单据多半接着就要提交，
     * 提交时平台要的布局方案先读好，第一次提交不用干等。
     */
    static String entityNumber(String key, boolean say) {
        String number = resolve(key, say);
        Warmup.layouts(number);
        return number;
    }

    private static String resolve(String key, boolean say) {
        String entityId = null;
        try {
            entityId = MetadataDao.getIdByNumber(key, MetaCategory.Entity);
        } catch (Throwable ignore) {
            //查不到就当没有
        }
        if (entityId != null && !entityId.isEmpty()) {
            String base = runtimeMissing(key) ? masterNumber(entityId, MetaCategory.Entity) : null;
            if (base == null) {
                return key;
            }
            if (say) {
                System.out.println("[PROBE] " + key + " 是 " + base + " 的扩展，运行时并进 " + base
                        + "；实体元数据按 " + base + " 查");
            }
            return base;
        }

        String formId = null;
        try {
            formId = MetadataDao.getIdByNumber(key, MetaCategory.Form);
        } catch (Throwable ignore) {
            //查不到就当没有
        }
        if (formId != null && !formId.isEmpty()) {
            String number = null;
            try {
                FormMetadata fm = (FormMetadata) MetadataDao.readMeta(formId, MetaCategory.Form);
                String boundId = fm.getEntityId();
                if (boundId != null && !boundId.isEmpty()) {
                    number = MetadataDao.getNumberById(boundId);
                }
            } catch (Throwable ignore) {
                //读不出实体就走下面的报错分支
            }
            if (number != null && !number.isEmpty() && !number.equals(key) && !say) {
                return number;
            }
            if (number != null && !number.isEmpty() && !number.equals(key)) {
                System.out.println("[PROBE] " + key + " 是表单布局（布局id=" + formId
                        + "），绑定实体 = " + number);
                System.out.println("[PROBE]   实体元数据（字段类型、分录结构）按 " + number
                        + " 查；开哪张界面由各探针自己定");
                return number;
            }
        }

        //兜底：没有设计态元数据、但运行时确实存在的实体（平台虚拟实体走这条）
        try {
            EntityMetadataCache.getDataEntityType(key);
            return key;
        } catch (Throwable notEntity) {
            //两条都问不出来，那就是真不存在
        }

        suggest(key);
        throw new IllegalArgumentException(key + " 既不是实体也不是表单布局。"
                + "标识写错了，或者不在当前账套（账套见 driver.mjs doctor，用 COSMIC_ACCOUNT 换）");
    }

    /**
     * 标识不存在时，把名字接近的几个摆出来。
     *
     * 为什么值得多查一次库：标识猜错的代价是一整轮探针（冷启动几十秒 + 一次模型往返），
     * 而「这个账套里有哪些名字沾边的单据」本来就在元数据表里躺着。2026-09-14 那次真机复盘里
     * `zlgd_jyxm`、`zlgd_syff` 两次「既不是实体也不是表单布局」，两轮都只换回「不存在」——
     * 正确做法本来就是先列一遍再照抄，那就让探针自己列。
     *
     * 只在失败那条路上跑，成功路径一次库都不多查。查不出来就当没有：它是锦上添花，
     * 不能让一句「标识不存在」变成一个堆栈。
     */
    private static void suggest(String key) {
        if (owners(key)) {
            return;
        }
        String token = key.toLowerCase();
        String prefix = IsvGuard.ISV.isEmpty() ? "" : IsvGuard.PREFIX;
        if (!prefix.isEmpty() && token.startsWith(prefix)) {
            token = token.substring(prefix.length());
        }
        if (!token.matches("[a-z0-9_]{2,}")) {
            return;
        }
        List<String> entities = like("t_meta_entitydesign", prefix, token);
        List<String> forms = like("t_meta_formdesign", prefix, token);
        forms.removeAll(entities);
        if (entities.isEmpty() && forms.isEmpty()) {
            return;
        }
        //只按名字像不像挑出来的，带上中文名：2026-09-21 真机上 zlgd_jyxm 沾边出「选材推荐-检验项目」，
        //模型没看名字照抄，查了一张不相干的单。名字摆出来，一眼就看得出不是
        if (!entities.isEmpty()) {
            System.out.println("[PROBE] 名字沾边的实体（只是名字像，先看中文名对不对得上）：" + named(entities));
        }
        if (!forms.isEmpty()) {
            System.out.println("[PROBE] 名字沾边的布局：" + String.join("、", forms));
        }
        System.out.println("[PROBE]   标识从这里抄，别接着猜：猜一次就是一整轮探针");
    }

    /** 候选实体各带上中文名；读不出名字的照样列标识。 */
    private static String named(List<String> numbers) {
        List<String> out = new ArrayList<String>();
        for (String n : numbers) {
            String name = null;
            try {
                name = String.valueOf(EntityMetadataCache.getDataEntityType(n).getDisplayName());
            } catch (Throwable ignore) {
                //名字是锦上添花
            }
            out.add(name == null || name.isEmpty() || "null".equals(name) ? n : n + "（" + name + "）");
        }
        return String.join("、", out);
    }

    /**
     * 标识不是实体时，最常见的是把**分录或字段**当成了实体——模型从插件代码里抄来
     * `zlgd_entryentity_jxsy`、`zlgd_jyxm`，代码里它们就是这么写的。2026-09-21 真机上两次都是这样，
     * 按名字像不像去猜只会把人带到别的单上。
     *
     * 所以先按设计数据反查：哪张单的设计里有 {@code <Key>标识</Key>}，再从那张单的运行时元数据里
     * 找出它在哪一层、叫什么。只扫本 ISV 的设计（实测约 1 秒；全表 4 万多张要 10 秒），
     * 不带 ISV 前缀的标识（billno 这类平台字段）不查——每张单都有，答了也没用。
     *
     * @return 找到归属、已经打印了照抄的写法
     */
    private static boolean owners(String key) {
        String prefix = IsvGuard.ISV.isEmpty() ? "" : IsvGuard.PREFIX;
        if (prefix.isEmpty() || !key.toLowerCase().startsWith(prefix) || !key.matches("[A-Za-z0-9_]+")) {
            return false;
        }
        final List<String> numbers = new ArrayList<String>();
        String sql = "select fnumber from t_meta_entitydesign where fnumber like '" + prefix.replace("_", "@_")
                + "%' escape '@' and fdata like '%<Key>" + key.replace("_", "@_") + "</Key>%' escape '@'";
        try {
            DB.query(DBRoute.meta, sql, new ResultSetHandler<Object>() {
                public Object handle(ResultSet rs) throws Exception {
                    while (rs.next() && numbers.size() < 5) {
                        String n = rs.getString(1);
                        if (n != null && !numbers.contains(n)) {
                            numbers.add(n);
                        }
                    }
                    return null;
                }
            });
        } catch (Throwable ignore) {
            return false;
        }
        boolean found = false;
        for (String owner : numbers) {
            IDataEntityType t;
            try {
                t = EntityMetadataCache.getDataEntityType(owner);
            } catch (Throwable notRuntime) {
                //扩展单之类：设计里有，运行时不叫这个名字。只报出处，不编层级
                System.out.println("[PROBE] " + key + " 出现在 " + owner + " 的设计里（这张设计不是能直接查的实体）");
                found = true;
                continue;
            }
            String where = locate(t, key, "", owner);
            if (where == null) {
                continue;
            }
            System.out.println("[PROBE] " + key + " 不是实体，是 " + owner + "（" + t.getDisplayName() + "）" + where);
            found = true;
        }
        if (found) {
            System.out.println("[PROBE]   标识从这里抄，别接着猜：猜一次就是一整轮探针");
        }
        return found;
    }

    /**
     * 在一张单里找标识落在哪：表头字段、分录、分录上的字段、子分录……
     * 返回「上的……」那半句加照抄的写法；这张单里没有就返回 null。
     */
    private static String locate(IDataEntityType host, String key, String path, String owner) {
        for (Object o : host.getProperties()) {
            IDataEntityProperty p = (IDataEntityProperty) o;
            String name = p.getName();
            if (name.equals(key)) {
                String label = String.valueOf(p.getDisplayName());
                if (p instanceof ICollectionProperty) {
                    return (path.isEmpty() ? " 上的分录" : " 分录 " + path + " 下的子分录") + "「" + label + "」"
                            + " → 实体填 " + owner + "；它上面的字段写成 " + path + key + ".字段";
                }
                String kind = path.isEmpty() ? " 上的表头字段" : " 分录 " + path.substring(0, path.length() - 1) + " 上的字段";
                String target = "";
                if (p instanceof IComplexProperty && ((IComplexProperty) p).getComplexType() != null) {
                    target = "；它指向 " + ((IComplexProperty) p).getComplexType().getName()
                            + "，要查那边的数据就把实体填成它";
                }
                return kind + "「" + label + "」 → 实体填 " + owner + "，字段写 " + path + key + target;
            }
            if (p instanceof ICollectionProperty) {
                String deeper = locate(((ICollectionProperty) p).getItemType(), key, path + name + ".", owner);
                if (deeper != null) {
                    return deeper;
                }
            }
        }
        return null;
    }

    /** 元数据表里编码含 token 的前 10 个。表不存在或查不动都当作没有。 */
    private static List<String> like(String table, String prefix, String token) {
        final List<String> out = new ArrayList<String>();
        //token 已被限死在 [a-z0-9_]，下划线是 like 的通配符，转义掉才是按字面找
        String escaped = token.replace("_", "@_");
        String sql = "select fnumber from " + table + " where fnumber like '%" + escaped + "%' escape '@'"
                + (prefix.isEmpty() ? "" : " and fnumber like '" + prefix.replace("_", "@_") + "%' escape '@'");
        try {
            DB.query(DBRoute.meta, sql, new ResultSetHandler<Object>() {
                public Object handle(ResultSet rs) throws Exception {
                    while (rs.next() && out.size() < 10) {
                        String n = rs.getString(1);
                        if (n != null && !out.contains(n)) {
                            out.add(n);
                        }
                    }
                    return null;
                }
            });
        } catch (Throwable ignore) {
            //查不出来就当没有：这一步是锦上添花，不能把「标识不存在」变成一个堆栈
        }
        return out;
    }

    /** 运行时有没有这个实体：命中走缓存不花时间，只有落空（扩展这类）才付一次失败。 */
    private static boolean runtimeMissing(String key) {
        try {
            EntityMetadataCache.getDataEntityType(key);
            return false;
        } catch (Throwable missing) {
            return true;
        }
    }

    /**
     * 设计元数据是别的单据的扩展时，答出被扩展的那张（主元数据）的标识；不是扩展返回 null。
     *
     * 扩展（开发平台上「扩展」出来的单据）在设计库里有自己的实体和布局，标识也不同（zlgd_sm_salorder_ext），
     * 运行时却没有这个标识：平台把扩展并进原单（sm_salorder），插件、字段、控件都合在原单上。
     * 拿扩展标识去开表单、查实体，平台只回一句「元数据不存在」（真机 2026-10-09 两次会话都卡在这里）。
     */
    static String masterNumber(String designId, MetaCategory category) {
        try {
            AbstractMetadata meta = (AbstractMetadata) MetadataDao.readMeta(designId, category);
            String master = meta.getMasterId();
            if (master == null || master.isEmpty() || master.equals(designId)) {
                return null;
            }
            String number = MetadataDao.getNumberById(master);
            return number == null || number.isEmpty() ? null : number;
        } catch (Throwable unreadable) {
            return null;
        }
    }

    /**
     * ISV 检查该认的那张设计实体：给的标识本身的实体（布局就取它绑的实体），**不换成扩展并进去的原单**。
     *
     * 扩展单据 zlgd_sm_salorder_ext 自己的设计实体 ISV 是本工程，被扩展的 sm_salorder 是 kingdee。
     * 仿真为了开得起来要换成原单（{@link #entityNumber}、FormSim.resolveTarget），归属却要按扩展算：
     * 本工程的插件就挂在扩展上。拿原单去查，本工程扩展过的标准单据一张都仿真不了
     * （真机 2026-10-09 `run flow zlgd_sm_salorder_ext` 子页没开就被拒）。
     */
    public static EntityMetadata ownedEntity(String key) {
        String entityId = MetadataDao.getIdByNumber(key, MetaCategory.Entity);
        if (entityId == null || entityId.isEmpty()) {
            String formId = MetadataDao.getIdByNumber(key, MetaCategory.Form);
            if (formId == null || formId.isEmpty()) {
                throw new IllegalArgumentException("没有这个实体或布局的设计元数据: " + key);
            }
            entityId = ((FormMetadata) MetadataDao.readMeta(formId, MetaCategory.Form)).getEntityId();
        }
        return (EntityMetadata) MetadataDao.readMeta(entityId, MetaCategory.Entity);
    }

    /** 运行时元数据，入参可以是实体标识也可以是布局标识。 */
    public static MainEntityType type(String key) {
        return type(key, true);
    }

    static MainEntityType type(String key, boolean say) {
        return EntityMetadataCache.getDataEntityType(entityNumber(key, say));
    }

    /** run 的 --billno 传进来的 pk 写成这个前缀加单据编号 */
    public static final String BILLNO_PREFIX = "billno:";

    /**
     * 单据主键：给的是 pk 就原样返回；给的是 {@code billno:编号}（run 的 --billno）就按单据编号查出 pk。
     *
     * 用户给的往往是单据编号（SYSJC-20260701-0259），而 run 只认内码。真机 2026-09-18 模型为了
     * 找这张单查了 10 次：先猜成委托单号字段，又猜 number，最后才试到 billno。编号字段按实体取
     * （BillEntityType.getBillNo()），基础资料退回 number。
     *
     * @param key 实体或布局标识
     * @throws IllegalArgumentException 编号查不到，或者一个编号对上了好几张单
     */
    public static String pkOf(String key, String raw) {
        if (raw == null || !raw.startsWith(BILLNO_PREFIX)) {
            return raw;
        }
        String no = raw.substring(BILLNO_PREFIX.length()).trim();
        String entity = entityNumber(key);
        String field = billNoField(EntityMetadataCache.getDataEntityType(entity));
        if (field == null) {
            throw new IllegalArgumentException(entity + " 上没有单据编号字段（billno / number 都没有），改用 --pk");
        }
        DynamicObjectCollection rows = QueryServiceHelper.query(entity, "id",
                new QFilter[]{new QFilter(field, QCP.equals, no)});
        if (rows.isEmpty()) {
            throw new IllegalArgumentException(entity + " 里没有 " + field + "=" + no
                    + " 的单据（编号写错，或者这张单不在这个实体上）");
        }
        if (rows.size() > 1) {
            List<String> ids = new ArrayList<String>();
            for (int i = 0; i < rows.size(); i++) {
                ids.add(String.valueOf(rows.get(i).get("id")));
            }
            throw new IllegalArgumentException("编号 " + no + " 在 " + entity + " 里有 " + rows.size() + " 张（id "
                    + String.join("、", ids) + "），改用 --pk 指定其中一张");
        }
        String id = String.valueOf(rows.get(0).get("id"));
        System.out.println("[PROBE] 单据编号 " + no + " → pk=" + id + "（按 " + entity + "." + field
                + " 查的；后面几次直接写 --pk " + id + "，省一次查询）");
        return id;
    }

    /** 单据编号字段：单据取 BillEntityType.getBillNo()，基础资料退回 billno / number；都没有返回 null。 */
    static String billNoField(MainEntityType met) {
        String field = met instanceof BillEntityType ? ((BillEntityType) met).getBillNo() : null;
        if (field != null && !field.isEmpty()) {
            return field;
        }
        if (met.findProperty("billno") != null) {
            return "billno";
        }
        return met.findProperty("number") != null ? "number" : null;
    }

    /**
     * 验证运行真提交之后（S27），把这张单在库里的现状打成一行：pk、编号、单据状态（有的话）。
     *
     * 运行不再回滚，下一次再跑这张单，拿到的就是这一行说的样子 —— 提交过、审核过的单，
     * 同一条命令第二次跑结果可能不同。读库而不是读内存里的对象：内存里的是操作前后插件看到的，
     * 这一行要回答的是「库里现在是什么」。
     *
     * 此查询只能证明编号和单据状态的当前值，不能证明本次输入保存过，
     * 也不能凭操作失败推断没有副作用。打开子页等操作成功，同样不意味着保存。
     *
     * @param what 这次对它做了什么，打在行首（「新建」「改过」）
     * @param done 操作成没成：TRUE 成了，FALSE 没成，null 是这条路拿不到结果（点按钮只有界面反应）
     */
    static void reportCommitted(String entity, Object pk, String what, Boolean done) {
        reportCommitted(entity, pk, what, done, null);
    }

    /** @param created 这张单是不是这次运行新建的（进事实账，见 {@link RunFacts}）；拿不准给 null */
    static void reportCommitted(String entity, Object pk, String what, Boolean done, Boolean created) {
        if (pk == null || "0".equals(String.valueOf(pk)) || String.valueOf(pk).isEmpty()) {
            return;
        }
        String head = "[PROBE] 数据库现状：";
        try {
            MainEntityType met = EntityMetadataCache.getDataEntityType(entity);
            String no = billNoField(met);
            boolean status = met.findProperty("billstatus") != null;
            String fields = "id" + (no == null ? "" : "," + no) + (status ? ",billstatus" : "");
            DynamicObjectCollection rows = QueryServiceHelper.query(entity, fields,
                    new QFilter[]{new QFilter("id", QCP.equals, pk)});
            if (rows.isEmpty()) {
                System.out.println(head + what + " " + entity + " pk=" + pk
                        + (Boolean.TRUE.equals(done) ? "，但库里查不到这张单（被删了，或者操作没存成）" : "，库里查不到这张单"));
                return;
            }
            StringBuilder line = new StringBuilder(head + what + " " + entity + " pk=" + pk);
            if (no != null) {
                line.append(" 编号=").append(rows.get(0).get(no));
            }
            if (status) {
                line.append(" 单据状态=").append(rows.get(0).get("billstatus"));
            }
            line.append("（仅回读编号和单据状态，未核对本次字段输入是否保存；接着验这张单写 --pk ")
                    .append(pk).append("）");
            System.out.println(line);
            RunFacts.committed(entity, pk, no == null ? null : rows.get(0).get(no),
                    status ? rows.get(0).get("billstatus") : null, what, created);
        } catch (Throwable t) {
            System.out.println(head + what + " " + entity + " pk=" + pk + "（读现状失败：" + t + "）");
        }
        //落了库的再看流程：提交会建发起审批流的后台任务，没处理完之前平台按「在流程中」拦审核、撤销
        if (!Boolean.FALSE.equals(done)) {
            try {
                WfState.afterCommit(entity, pk);
            } catch (Throwable t) {
                System.out.println("[PROBE] 流程：没查出来（" + t + "）");
            }
        }
    }

    /** 设计态元数据 id（MetaCategory.Entity），入参同上。 */
    public static String designId(String key) {
        String number = entityNumber(key);
        String id = MetadataDao.getIdByNumber(number, MetaCategory.Entity);
        if (id == null || id.isEmpty()) {
            throw new IllegalArgumentException(number + " 没有设计态实体元数据");
        }
        return id;
    }
}
