import java.sql.ResultSet;
import java.sql.SQLException;

import kd.bos.db.DB;
import kd.bos.db.DBRoute;
import kd.bos.db.ResultSetHandler;
import kd.bos.entity.MainEntityType;
import kd.bos.entity.EntityMetadataCache;

/**
 * 只读：绕开 ORM，直接问数据库某张业务表上到底有哪些列。
 *
 * 和 ColumnProbe 的区别：ColumnProbe 走 QueryServiceHelper，字段一旦从元数据里删掉，
 * ORM 就不认这个属性了，直接抛异常 —— 那时候它答不了"列还在不在"。删字段之后要验
 * DB 侧残留，只能用这个。
 *
 *   DB_ENTITY=单据标识      如 demo_lsydbzk_csjl
 *   DB_TABLE=表名           可选，不给就取实体主表；分录表要显式给，如 tk_demo_lsydbzk_csjl_en
 *   DB_FILTER=列名关键字    可选，不给就列全部
 */
public class DbColumnProbe {

    public static void run() {
        String entity = req("DB_ENTITY");
        String filter = env("DB_FILTER", "");

        MainEntityType et = EntityMetadataCache.getDataEntityType(entity);
        String table = env("DB_TABLE", et.getAlias());
        DBRoute route = DBRoute.of(et.getDBRouteKey());
        System.out.println("[PROBE] 表 " + table + "  路由=" + et.getDBRouteKey()
                + (filter.isEmpty() ? "" : "  过滤=" + filter));

        //where 1=2：只要元数据不要数据，不扫表
        String sql = "/*dialect*/select * from " + table + " where 1=2";
        int[] hit = new int[]{0, 0};
        DB.query(route, sql, (ResultSetHandler<Object>) rs -> {
            java.sql.ResultSetMetaData md = rs.getMetaData();
            for (int i = 1; i <= md.getColumnCount(); i++) {
                String col = md.getColumnLabel(i);
                hit[1]++;
                if (!filter.isEmpty() && !col.toLowerCase().contains(filter.toLowerCase())) {
                    continue;
                }
                hit[0]++;
                System.out.println("[PROBE]   " + col + "  " + md.getColumnTypeName(i)
                        + "(" + md.getPrecision(i) + "," + md.getScale(i) + ")");
            }
            return null;
        });
        System.out.println("[PROBE] 该表共 " + hit[1] + " 列，命中 " + hit[0] + " 列");
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
