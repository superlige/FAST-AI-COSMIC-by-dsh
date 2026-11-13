import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.ArrayDeque;
import java.util.Arrays;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.Set;

import kd.bos.db.DB;
import kd.bos.db.DBRoute;
import kd.bos.db.ResultSetHandler;

/**
 * 尺子用的只读探针（不是发布给模型的探针）：一条 SQL 要过几趟网络，各趟多久。
 *
 * 由 scripts/measure-sql-roundtrips.ts 拷进工程的 .cosmic-ai/probes/ 再跑。做三件事：
 *   1. 从平台借一条连接，打出连接一层层包的是什么、连接串、驱动和库的版本；
 *   2. 打出 MySQL 驱动里和「来回几趟」有关的开关现在的值（预编译在哪一侧做、缓不缓存、游标取数……）；
 *   3. 同一条只读 SQL 各跑 TRIP_REPEAT 遍（默认 20），分「预编译、执行、取结果、关闭」记中位毫秒：
 *      平台包过的连接照常用；裸 MySQL 连接照常用；裸连接强制在本机预编译；裸连接强制在服务器预编译。
 *   4. 给了 TRIP_BIG_ENTITY（单据标识）时，把这张单的整份设计元数据读 5 遍，报多大、读一遍多久——量大字段过网络要多久。
 * 只发 select，不写任何东西。
 */
public class SqlRoundTripProbe {

    private static final String SQL = "select FID from T_META_ENTITYDESIGN where FNUMBER = ?";
    private static final String ARG = "bos_user";
    private static final String MYSQL_CONNECTION = "com.mysql.cj.jdbc.JdbcConnection";
    private static final String[] SWITCHES = {
        "useServerPrepStmts", "cachePrepStmts", "prepStmtCacheSize", "prepStmtCacheSqlLimit", "useCursorFetch",
        "defaultFetchSize", "useLocalSessionState", "useLocalTransactionState", "elideSetAutoCommits",
        "alwaysSendSetIsolation", "cacheServerConfiguration", "cacheResultSetMetadata", "rewriteBatchedStatements",
        "useCompression", "sslMode", "tcpNoDelay", "characterEncoding", "maintainTimeStats", "useConfigs",
    };

    private interface Prepare {
        PreparedStatement of(String sql) throws Exception;
    }

    public static void run() throws Exception {
        String configured = System.getenv("TRIP_REPEAT");
        final int repeat = configured == null || configured.isEmpty() ? 20 : Integer.parseInt(configured);
        DB.query(DBRoute.meta, SQL, new Object[]{ARG}, new ResultSetHandler<Object>() {
            public Object handle(ResultSet rs) throws Exception {
                while (rs.next()) {
                    rs.getString(1);
                }
                report(rs.getStatement().getConnection(), repeat);
                return null;
            }
        });
    }

    private static void report(final Connection pooled, int repeat) throws Exception {
        System.out.println("[PROBE] 借到的连接 " + pooled.getClass().getName());
        DatabaseMetaData md = pooled.getMetaData();
        System.out.println("[PROBE] 连接串 " + mask(md.getURL()));
        System.out.println("[PROBE] 驱动 " + md.getDriverName() + " " + md.getDriverVersion()
                + "；数据库 " + md.getDatabaseProductName() + " " + md.getDatabaseProductVersion());

        final Class<?> mysql = Class.forName(MYSQL_CONNECTION);
        final Object raw = findRaw(pooled, mysql);
        if (raw == null) {
            System.out.println("[PROBE] 没找到裸的 MySQL 连接，只量平台包过的这一层");
        } else {
            System.out.println("[PROBE] 裸连接 " + raw.getClass().getName());
            Object set = mysql.getMethod("getPropertySet").invoke(raw);
            Method getProperty = find(set.getClass(), "getProperty", String.class);
            StringBuilder line = new StringBuilder();
            for (String name : SWITCHES) {
                String value;
                try {
                    Object property = getProperty.invoke(set, name);
                    Method getValue = find(property.getClass(), "getValue");
                    value = String.valueOf(getValue.invoke(property));
                } catch (Throwable missing) {
                    value = "（驱动没有这一项）";
                }
                line.append(line.length() == 0 ? "" : "，").append(name).append('=').append(value);
            }
            System.out.println("[PROBE] 驱动开关 " + line);
        }

        big(pooled, System.getenv("TRIP_BIG_ENTITY"));
        System.out.println("[PROBE] 同一条只读 SQL 各跑 " + repeat + " 遍，中位毫秒：");
        time("平台包过的连接，照常用", repeat, new Prepare() {
            public PreparedStatement of(String sql) throws Exception {
                return pooled.prepareStatement(sql);
            }
        });
        if (raw == null) {
            return;
        }
        final Connection bare = (Connection) raw;
        time("裸连接，照常用", repeat, new Prepare() {
            public PreparedStatement of(String sql) throws Exception {
                return bare.prepareStatement(sql);
            }
        });
        final Method client = mysql.getMethod("clientPrepareStatement", String.class);
        time("裸连接，强制本机预编译", repeat, new Prepare() {
            public PreparedStatement of(String sql) throws Exception {
                return (PreparedStatement) client.invoke(raw, sql);
            }
        });
        final Method server = mysql.getMethod("serverPrepareStatement", String.class);
        time("裸连接，强制服务器预编译", repeat, new Prepare() {
            public PreparedStatement of(String sql) throws Exception {
                return (PreparedStatement) server.invoke(raw, sql);
            }
        });
    }

    private static void big(Connection pooled, String entity) {
        if (entity == null || entity.isEmpty()) {
            return;
        }
        long[] whole = new long[5];
        int chars = 0;
        try {
            for (int i = 0; i < whole.length; i++) {
                long t0 = System.nanoTime();
                PreparedStatement ps = pooled.prepareStatement("select FDATA from T_META_ENTITYDESIGN where FNUMBER = ?");
                ps.setString(1, entity);
                ResultSet rs = ps.executeQuery();
                chars = 0;
                while (rs.next()) {
                    String data = rs.getString(1);
                    chars += data == null ? 0 : data.length();
                }
                rs.close();
                ps.close();
                whole[i] = System.nanoTime() - t0;
            }
        } catch (Throwable failed) {
            System.out.println("[PROBE] 读大字段没跑成，" + failed);
            return;
        }
        System.out.println("[PROBE] 读 " + entity + " 的整份设计元数据（" + chars + " 个字符）5 遍，中位 " + median(whole) + " 毫秒");
    }

    private static void time(String label, int repeat, Prepare prepare) {
        long[] prep = new long[repeat];
        long[] exec = new long[repeat];
        long[] fetch = new long[repeat];
        long[] close = new long[repeat];
        long[] whole = new long[repeat];
        try {
            for (int i = 0; i < repeat; i++) {
                long t0 = System.nanoTime();
                PreparedStatement ps = prepare.of(SQL);
                long t1 = System.nanoTime();
                ps.setString(1, ARG);
                ResultSet rs = ps.executeQuery();
                long t2 = System.nanoTime();
                while (rs.next()) {
                    rs.getString(1);
                }
                long t3 = System.nanoTime();
                rs.close();
                ps.close();
                long t4 = System.nanoTime();
                prep[i] = t1 - t0;
                exec[i] = t2 - t1;
                fetch[i] = t3 - t2;
                close[i] = t4 - t3;
                whole[i] = t4 - t0;
            }
        } catch (Throwable failed) {
            System.out.println("[PROBE]   " + label + "：没跑成，" + failed);
            return;
        }
        System.out.println("[PROBE]   " + label + "：整条 " + median(whole) + " ＝ 预编译 " + median(prep)
                + " ＋ 执行 " + median(exec) + " ＋ 取结果 " + median(fetch) + " ＋ 关闭 " + median(close));
    }

    private static String median(long[] nanos) {
        long[] sorted = nanos.clone();
        Arrays.sort(sorted);
        return String.format("%.1f", sorted[sorted.length / 2] / 1000000.0);
    }

    private static String mask(String url) {
        return url == null ? "（拿不到）" : url.replaceAll("(?i)(password|pwd)=[^&;]*", "$1=***");
    }

    /** 先按 JDBC 的 unwrap 要；包装层不认就顺着字段往里找，最多看 400 个对象。 */
    private static Object findRaw(Connection pooled, Class<?> mysql) {
        try {
            if (pooled.isWrapperFor(mysql)) {
                return pooled.unwrap(mysql);
            }
        } catch (Throwable ignore) {
            //包装层不支持 unwrap，往下找
        }
        Set<Object> seen = Collections.newSetFromMap(new IdentityHashMap<Object, Boolean>());
        ArrayDeque<Object> queue = new ArrayDeque<Object>();
        queue.add(pooled);
        while (!queue.isEmpty() && seen.size() < 400) {
            Object current = queue.poll();
            if (current == null || !seen.add(current)) {
                continue;
            }
            if (mysql.isInstance(current)) {
                return current;
            }
            for (Class<?> type = current.getClass(); type != null && type != Object.class; type = type.getSuperclass()) {
                for (Field field : type.getDeclaredFields()) {
                    if (Modifier.isStatic(field.getModifiers()) || field.getType().isPrimitive()) {
                        continue;
                    }
                    try {
                        field.setAccessible(true);
                        Object value = field.get(current);
                        if (value instanceof Connection || value instanceof javax.sql.DataSource
                                || (value != null && value.getClass().getName().contains("onnection"))) {
                            queue.add(value);
                        }
                    } catch (Throwable ignore) {
                        //读不了的字段跳过
                    }
                }
            }
        }
        return null;
    }

    private static Method find(Class<?> type, String name, Class<?>... parameters) throws NoSuchMethodException {
        for (Class<?> current = type; current != null; current = current.getSuperclass()) {
            for (Class<?> face : current.getInterfaces()) {
                try {
                    return face.getMethod(name, parameters);
                } catch (NoSuchMethodException next) {
                    //换下一个接口
                }
            }
        }
        Method method = type.getMethod(name, parameters);
        method.setAccessible(true);
        return method;
    }
}
