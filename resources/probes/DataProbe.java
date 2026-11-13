import java.sql.ResultSet;
import java.util.ArrayList;
import java.util.List;

import kd.bos.dataentity.entity.DynamicObject;
import kd.bos.dataentity.entity.DynamicObjectCollection;
import kd.bos.dataentity.metadata.ICollectionProperty;
import kd.bos.dataentity.metadata.IDataEntityProperty;
import kd.bos.dataentity.metadata.IDataEntityType;
import kd.bos.db.DB;
import kd.bos.db.DBRoute;
import kd.bos.db.ResultSetHandler;
import kd.bos.entity.MainEntityType;
import kd.bos.entity.property.EntryProp;
import kd.bos.servicehelper.BusinessDataServiceHelper;
import kd.bos.servicehelper.QueryServiceHelper;

/**
 * 只读：先回答「这张单到底有没有数据」，再动手验逻辑。
 *
 * 为什么要有这个探针（实测踩过的坑）：
 *   QueryServiceHelper.query("单据", "主表字段, 分录.字段", ...) 返回的是**扁平行**，
 *   分录侧是 LEFT JOIN 出来的。**分录表一行数据都没有时，查出来照样有行**，
 *   分录字段是 null / 0 —— 看着像「有数据」。接着用 loadSingle 加载，分录 0 行，
 *   于是开始怀疑字段标识写错了、怀疑加载方式不对，能白烧掉三四轮探针。
 *   真相只有一句：那张分录表是空的。这个探针把它放在第一轮就说清楚。
 *
 *   DATA_ENTITY=实体或布局标识   必填（给布局也行，MetaResolve 会换算）
 *   DATA_PK=主键id               可选，指定要加载的样本单据；不给就取 id 最大的一条
 *   DATA_FIELDS=字段1,字段2      可选，样本单据额外打印这些字段的值
 */
public class DataProbe {

    public static void run() {
        String input = req("DATA_ENTITY");
        MainEntityType t = MetaResolve.type(input);
        String entity = t.getName();
        DBRoute route = DBRoute.of(t.getDBRouteKey());

        System.out.println("[PROBE] 实体 " + entity + "  " + t.getDisplayName()
                + "  主表=" + t.getAlias() + "  路由=" + t.getDBRouteKey());

        long mainRows = count(route, t.getAlias());
        System.out.println("[PROBE] 主表行数 = " + show(mainRows));

        List<Entry> entries = new ArrayList<>();
        collect(t, "", entries);
        List<String> emptyEntries = new ArrayList<>();
        if (entries.isEmpty()) {
            System.out.println("[PROBE] （该实体没有分录）");
        }
        for (Entry e : entries) {
            long n = count(route, e.table);
            String flag = n == 0 ? "   ⚠ 空表" : "";
            System.out.println("[PROBE] 分录 " + e.key + "  " + e.name
                    + "  表=" + e.table + "  行数=" + show(n) + flag);
            if (n == 0) {
                emptyEntries.add(e.key);
            }
        }

        //取一条真实单据，看分录实际能加载出几行 —— DB count 是全库口径，这是单据口径
        String pk = env("DATA_PK", "");
        if (pk.isEmpty() && mainRows > 0) {
            DynamicObjectCollection top = QueryServiceHelper.query(entity, "id", null, "id desc", 1);
            if (!top.isEmpty()) {
                pk = String.valueOf(top.get(0).get("id"));
            }
        }
        if (pk.isEmpty()) {
            System.out.println("[PROBE] 主表没有数据，跳过样本加载");
        } else {
            System.out.println("[PROBE] --- 样本单据 pk=" + pk + " ---");
            DynamicObject bill = BusinessDataServiceHelper.loadSingle(pk, entity);
            if (bill == null) {
                System.out.println("[PROBE] loadSingle 返回 null（pk 不存在？）");
            } else {
                for (String f : env("DATA_FIELDS", "").split(",")) {
                    if (!f.trim().isEmpty()) {
                        System.out.println("[PROBE]   " + f.trim() + " = " + safeGet(bill, f.trim()));
                    }
                }
                for (Entry e : entries) {
                    if (e.key.indexOf('.') >= 0) {
                        continue;   //子分录要先拿到父行，这里只报顶层
                    }
                    try {
                        DynamicObjectCollection rows = bill.getDynamicObjectCollection(e.key);
                        System.out.println("[PROBE]   分录 " + e.key + " 实际加载 "
                                + (rows == null ? 0 : rows.size()) + " 行");
                    } catch (Throwable ex) {
                        System.out.println("[PROBE]   分录 " + e.key + " 加载异常 "
                                + ex.getClass().getSimpleName() + ": " + ex.getMessage());
                    }
                }
            }
        }

        if (!emptyEntries.isEmpty()) {
            System.out.println("[PROBE] ⚠ 结论：" + emptyEntries.size() + " 个分录全库无数据："
                    + String.join("、", emptyEntries) + "。");
            System.out.println("[PROBE] ⚠ 用 QueryServiceHelper.query 查「主表字段,分录.字段」时，"
                    + "分录侧会是 LEFT JOIN 出来的 null/0，");
            System.out.println("[PROBE] ⚠ **有行 ≠ 有数据**。要端到端验算法，就在探针里自己造样例行"
                    + "（见 reference/data-query.md）。");
        }
    }

    private static class Entry {
        String key;
        String name;
        String table;
    }

    /** 递归收集分录（含子分录），只认 EntryProp —— 多选基础资料也是集合属性，但不是分录 */
    private static void collect(IDataEntityType t, String prefix, List<Entry> out) {
        for (IDataEntityProperty p : t.getProperties()) {
            if (!(p instanceof EntryProp) || !(p instanceof ICollectionProperty)) {
                continue;
            }
            IDataEntityType item = ((ICollectionProperty) p).getItemType();
            Entry e = new Entry();
            e.key = prefix.isEmpty() ? p.getName() : prefix + "." + p.getName();
            e.name = String.valueOf(p.getDisplayName());
            e.table = item.getAlias();
            out.add(e);
            collect(item, e.key, out);
        }
    }

    private static long count(DBRoute route, String table) {
        if (table == null || table.trim().isEmpty()) {
            return -1L;
        }
        try {
            Long n = DB.query(route, "/*dialect*/select count(*) from " + table,
                    (ResultSetHandler<Long>) (ResultSet rs) -> rs.next() ? rs.getLong(1) : -1L);
            return n == null ? -1L : n;
        } catch (Throwable e) {
            System.out.println("[PROBE]   (查 " + table + " 行数失败: " + e.getMessage() + ")");
            return -1L;
        }
    }

    private static String show(long n) {
        return n < 0 ? "?" : String.valueOf(n);
    }

    private static Object safeGet(DynamicObject o, String field) {
        try {
            return o.get(field);
        } catch (Throwable e) {
            return "<取不到: " + e.getClass().getSimpleName() + ">";
        }
    }

    private static String req(String k) {
        String v = System.getenv(k);
        if (v == null || v.trim().isEmpty()) {
            throw new IllegalArgumentException("缺少环境变量 " + k);
        }
        return v.trim();
    }

    private static String env(String k, String def) {
        String v = System.getenv(k);
        return v == null || v.isEmpty() ? def : v;
    }
}
