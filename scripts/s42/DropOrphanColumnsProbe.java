import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

import kd.bos.dataentity.metadata.IDataEntityProperty;
import kd.bos.db.DB;
import kd.bos.db.DBRoute;
import kd.bos.db.ResultSetHandler;
import kd.bos.entity.EntityMetadataCache;
import kd.bos.entity.MainEntityType;

/**
 * S42 复量前清场（§16.14）：删掉业务表上元数据里已经没有字段对应的 fk_ 列。
 * 平台恢复元数据只撤字段、不删列，留下的空列会让下一次复量的模型去查它们归谁，前后不可比。
 *
 *   DROP_ENTITY=单据标识   DROP_TABLES=表1,表2   DROP_APPLY=1 才真删，否则只列（带表行数）
 *
 * 这是写库表结构的维护工具，不给模型用：cosmic 内核对临时探针只放行读，这个走 long-cosmic-dev 的驱动跑，
 * 在真机工程目录下：
 *   COSMIC_PROJECT_ROOT=D:/kingdee/zlgd_ygpt2.0 DROP_ENTITY=zlgd_sys_bgjl \
 *     DROP_TABLES=tk_zlgd_sys_bgjl,tk_zlgd_bgentry \
 *     node D:/claudecode/long-cosmic-dev/driver.mjs probe <本文件路径> --cold --raw
 * 删列是改库表结构，每次先问用户。
 */
public class DropOrphanColumnsProbe {

    public static void run() {
        String entity = System.getenv("DROP_ENTITY");
        String[] tables = System.getenv("DROP_TABLES").split(",");
        boolean apply = "1".equals(System.getenv("DROP_APPLY"));
        MainEntityType et = EntityMetadataCache.getDataEntityType(entity);
        DBRoute route = DBRoute.of(et.getDBRouteKey());

        Set<String> mapped = new HashSet<>();
        for (IDataEntityProperty p : et.getAllFields().values()) {
            if (p.getAlias() != null) mapped.add(p.getAlias().toLowerCase());
        }
        System.out.println("[PROBE] 元数据里有列名的字段 " + mapped.size() + " 个：" + mapped);

        for (String table : tables) {
            List<String> orphans = new ArrayList<>();
            DB.query(route, "/*dialect*/select * from " + table + " where 1=2", (ResultSetHandler<Object>) rs -> {
                java.sql.ResultSetMetaData md = rs.getMetaData();
                for (int i = 1; i <= md.getColumnCount(); i++) {
                    String col = md.getColumnLabel(i).toLowerCase();
                    if (col.startsWith("fk_") && !mapped.contains(col)) orphans.add(col);
                }
                return null;
            });
            long rows = DB.query(route, "/*dialect*/select count(1) from " + table,
                    (ResultSetHandler<Long>) rs -> rs.next() ? rs.getLong(1) : -1L);
            System.out.println("[PROBE] 表 " + table + "  行数=" + rows + "  残留列 " + orphans.size() + " 个：" + orphans);
            if (!apply || orphans.isEmpty()) continue;
            StringBuilder sql = new StringBuilder("/*dialect*/alter table " + table);
            for (int i = 0; i < orphans.size(); i++) {
                sql.append(i == 0 ? " drop column " : ", drop column ").append(orphans.get(i));
            }
            DB.execute(route, sql.toString());
            System.out.println("[PROBE] 已删 " + table + " 的 " + orphans.size() + " 列");
        }
        System.out.println(apply ? "[PROBE] APPLY 完成" : "[PROBE] 只列出，没删（加 DROP_APPLY=1 才删）");
    }
}
