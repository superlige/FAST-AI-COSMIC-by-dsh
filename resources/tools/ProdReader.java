import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.lang.management.ManagementFactory;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;

/**
 * 生产只读通道：本机常驻的小进程，只装数据库驱动，不加载苍穹平台。
 *
 * 为什么不用探针那个苍穹进程连生产：那个进程照抄工程启动类，会登记成集群节点、可能消费消息队列，
 * 拿到的是平台自己的读写账号——指到生产就是事故。这里只有 JDBC，进不了集群，也碰不到消息和定时任务。
 *
 * 只读不靠数据库账号（账号给多了权限也不影响这里），靠这一侧的三道闸，任何一道单独都挡得住写：
 *   ① 语句检查在 Node 那一侧（sql-guard.ts：单条查询、拒写和改会话的词、函数只放行内置白名单），这里再认一次开头必须是查询；
 *   ② 会话默认只读：连上就 SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY；
 *   ③ 每条查询都在一个以 SET TRANSACTION READ ONLY 开头的事务里跑，跑完一律 rollback。
 *
 * 用法（由 src/kernel/prod/reader.ts 拉起，不给人直接用）：
 *   java -Dprod.state=<状态文件> -Dprod.idleMinutes=15 -cp <本类目录>;<驱动 jar> ProdReader
 *   连接信息从环境变量读：PROD_DRIVER PROD_URL PROD_USER PROD_PASS——不进命令行，不打印。
 * 起来后监听 127.0.0.1 的随机端口，把 {pid, port, token} 写进状态文件。
 * 请求是若干行、以 END 收尾：第一行 token，第二行动作（ping / info / query / stop），之后 key=value；
 * sql、tables 的值是 base64（UTF-8）。答复是一个 JSON 对象，写完就关连接。
 * 闲置超过 idleMinutes 自己退出。
 */
public class ProdReader {
    private static final long STARTED = System.currentTimeMillis();
    private static volatile long lastActive = System.currentTimeMillis();
    private static Connection conn;
    private static String infoCache;
    private static final List<String> SCHEMAS = new ArrayList<String>();
    /** 单次答复的字符上限：再大就是在搬数据，不是排障；超了截断并照实说 */
    private static final int MAX_REPLY_CHARS = 24 * 1024 * 1024;

    public static void main(String[] args) throws Exception {
        String stateFile = System.getProperty("prod.state");
        int idleMinutes = Integer.parseInt(System.getProperty("prod.idleMinutes", "15"));
        Class.forName(env("PROD_DRIVER"));
        byte[] raw = new byte[16];
        new SecureRandom().nextBytes(raw);
        StringBuilder token = new StringBuilder();
        for (byte b : raw) token.append(String.format("%02x", b));
        ServerSocket server = new ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"));
        String pid = ManagementFactory.getRuntimeMXBean().getName().split("@")[0];
        writeAtomically(stateFile, "{\"pid\":" + pid + ",\"port\":" + server.getLocalPort()
                + ",\"token\":\"" + token + "\",\"startedAt\":" + STARTED + "}");
        log("listening on " + server.getLocalPort());
        final long idleMs = idleMinutes * 60_000L;
        Thread idle = new Thread(new Runnable() {
            public void run() {
                while (true) {
                    try {
                        Thread.sleep(30_000);
                    } catch (InterruptedException e) {
                        return;
                    }
                    if (System.currentTimeMillis() - lastActive > idleMs) {
                        log("idle " + idleMinutes + " min, exit");
                        System.exit(0);
                    }
                }
            }
        });
        idle.setDaemon(true);
        idle.start();
        while (true) {
            Socket socket = server.accept();
            lastActive = System.currentTimeMillis();
            try {
                handle(socket, token.toString());
            } catch (Throwable t) {
                log("request failed: " + t);
            } finally {
                try {
                    socket.close();
                } catch (Exception ignored) {
                }
            }
            lastActive = System.currentTimeMillis();
        }
    }

    private static void handle(Socket socket, String token) throws Exception {
        socket.setSoTimeout(300_000);
        BufferedReader in = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
        List<String> lines = new ArrayList<String>();
        String line;
        while ((line = in.readLine()) != null && !"END".equals(line)) lines.add(line);
        Writer out = new OutputStreamWriter(socket.getOutputStream(), StandardCharsets.UTF_8);
        if (lines.size() < 2 || !token.equals(lines.get(0))) {
            out.write("{\"ok\":false,\"error\":\"token 不对\"}");
            out.flush();
            return;
        }
        String op = lines.get(1);
        Map<String, String> kv = new HashMap<String, String>();
        for (int i = 2; i < lines.size(); i++) {
            String l = lines.get(i);
            int eq = l.indexOf('=');
            if (eq > 0) kv.put(l.substring(0, eq), l.substring(eq + 1));
        }
        String reply;
        if ("ping".equals(op)) {
            reply = "{\"ok\":true,\"uptimeMs\":" + (System.currentTimeMillis() - STARTED) + "}";
        } else if ("stop".equals(op)) {
            out.write("{\"ok\":true}");
            out.flush();
            log("stop requested");
            System.exit(0);
            return;
        } else if ("info".equals(op)) {
            reply = withRetry(new Job() {
                public String run() throws SQLException {
                    return info();
                }
            });
        } else if ("query".equals(op)) {
            final String sql = b64(kv.get("sql"));
            final int timeout = Integer.parseInt(kv.containsKey("timeout") ? kv.get("timeout") : "15");
            final int max = Integer.parseInt(kv.containsKey("max") ? kv.get("max") : "500");
            final String tables = kv.containsKey("tables") ? b64(kv.get("tables")) : "";
            reply = withRetry(new Job() {
                public String run() throws SQLException {
                    return query(sql, timeout, max, tables);
                }
            });
        } else {
            reply = "{\"ok\":false,\"error\":" + q("不认识的动作 " + op) + "}";
        }
        out.write(reply);
        out.flush();
    }

    interface Job {
        String run() throws SQLException;
    }

    /** 连接断了（SQLState 08 开头，或连接已关）重连一次再试；别的错原样报 */
    private static String withRetry(Job job) {
        for (int attempt = 0; attempt < 2; attempt++) {
            try {
                ensureConnected();
                return job.run();
            } catch (SQLException e) {
                String state = e.getSQLState() == null ? "" : e.getSQLState();
                boolean broken = state.startsWith("08") || isClosed();
                if (broken && attempt == 0) {
                    log("connection lost (" + state + "), reconnecting");
                    closeQuietly();
                    continue;
                }
                return "{\"ok\":false,\"error\":" + q(e.getMessage()) + ",\"sqlState\":" + q(state) + "}";
            } catch (Throwable t) {
                return "{\"ok\":false,\"error\":" + q(String.valueOf(t)) + "}";
            }
        }
        return "{\"ok\":false,\"error\":\"重连后仍失败\"}";
    }

    private static boolean isClosed() {
        try {
            return conn == null || conn.isClosed();
        } catch (SQLException e) {
            return true;
        }
    }

    private static void closeQuietly() {
        try {
            if (conn != null) conn.close();
        } catch (Exception ignored) {
        }
        conn = null;
    }

    private static void ensureConnected() throws SQLException {
        if (!isClosed()) return;
        Properties p = new Properties();
        p.setProperty("user", env("PROD_USER"));
        p.setProperty("password", env("PROD_PASS"));
        p.setProperty("connectTimeout", "10");
        p.setProperty("ApplicationName", "fast-ai-cosmic-readonly");
        long t = System.currentTimeMillis();
        Connection c = DriverManager.getConnection(env("PROD_URL"), p);
        c.setAutoCommit(false);
        c.setReadOnly(true);
        Statement s = c.createStatement();
        try {
            s.execute("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
            c.commit();
            SCHEMAS.clear();
            ResultSet r = s.executeQuery("select nspname from pg_namespace where has_schema_privilege(oid, 'USAGE')"
                    + " and nspname not in ('information_schema') and nspname not like 'pg\\_%'"
                    + " and nspname not like 'dbe\\_%' and nspname not in ('db4ai', 'blockchain', 'snapshot',"
                    + " 'sqladvisor', 'cstore', 'pkg_service', 'pkg_util') order by nspname");
            while (r.next()) SCHEMAS.add(r.getString(1));
            r.close();
            c.rollback();
            if (!SCHEMAS.isEmpty()) {
                StringBuilder path = new StringBuilder();
                for (String schema : SCHEMAS) path.append(path.length() == 0 ? "" : ", ").append(quoteIdent(schema));
                s.execute("SET search_path TO " + path);
                c.commit();
            }
        } finally {
            s.close();
        }
        conn = c;
        log("connected in " + (System.currentTimeMillis() - t) + " ms, schemas=" + SCHEMAS.size());
    }

    /** 连到了哪、账号是谁、会话是不是只读、各分区能查多少表。算一次记住 */
    private static String info() throws SQLException {
        if (infoCache != null) return infoCache;
        long t = System.currentTimeMillis();
        StringBuilder b = new StringBuilder("{\"ok\":true");
        Statement s = conn.createStatement();
        try {
            s.setQueryTimeout(120);
            b.append(",\"version\":").append(q(one(s, "select version()")));
            b.append(",\"user\":").append(q(one(s, "select current_user")));
            b.append(",\"database\":").append(q(one(s, "select current_database()")));
            b.append(",\"sessionReadOnly\":").append(q(one(s, "show transaction_read_only")));
            b.append(",\"schemas\":[");
            ResultSet r = s.executeQuery("select n.nspname, count(*),"
                    + " sum(case when has_table_privilege(c.oid, 'SELECT') then 1 else 0 end)"
                    + " from pg_class c join pg_namespace n on n.oid = c.relnamespace"
                    + " where c.relkind = 'r' and n.nspname = any(current_schemas(false))"
                    + " group by n.nspname order by n.nspname");
            boolean first = true;
            while (r.next()) {
                b.append(first ? "" : ",").append("{\"name\":").append(q(r.getString(1)))
                        .append(",\"tables\":").append(r.getLong(2))
                        .append(",\"readable\":").append(r.getLong(3)).append('}');
                first = false;
            }
            r.close();
            b.append(']');
            // 业务分区里的自定义函数名：语句闸只放行内置函数，和这些同名的也拒（同名时可能解析到自定义的那个）
            b.append(",\"userFunctions\":[");
            r = s.executeQuery("select distinct p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace"
                    + " where n.nspname = any(current_schemas(false)) order by 1");
            first = true;
            while (r.next()) {
                b.append(first ? "" : ",").append(q(r.getString(1)));
                first = false;
            }
            r.close();
            b.append(']');
        } finally {
            s.close();
            conn.rollback();
        }
        b.append(",\"ms\":").append(System.currentTimeMillis() - t).append('}');
        infoCache = b.toString();
        return infoCache;
    }

    private static String one(Statement s, String sql) throws SQLException {
        ResultSet r = s.executeQuery(sql);
        try {
            return r.next() ? r.getString(1) : null;
        } finally {
            r.close();
        }
    }

    private static String query(String sql, int timeout, int max, String tables) throws SQLException {
        if (!looksLikeQuery(sql)) return "{\"ok\":false,\"error\":\"只放行查询语句\"}";
        long t = System.currentTimeMillis();
        StringBuilder b = new StringBuilder("{\"ok\":true");
        Statement s = conn.createStatement();
        try {
            // 闸④：事务第一句声明只读；无论结果如何最后都 rollback
            s.execute("SET TRANSACTION READ ONLY");
            if (!tables.isEmpty()) b.append(",\"tableSchemas\":").append(tableSchemas(s, tables));
            s.setQueryTimeout(timeout);
            s.setMaxRows(max + 1);
            s.setFetchSize(200);
            ResultSet r = s.executeQuery(sql);
            ResultSetMetaData m = r.getMetaData();
            int cols = m.getColumnCount();
            b.append(",\"columns\":[");
            for (int i = 1; i <= cols; i++) b.append(i == 1 ? "" : ",").append(q(m.getColumnLabel(i)));
            b.append("],\"rows\":[");
            int n = 0;
            boolean truncated = false;
            boolean clipped = false;
            while (r.next()) {
                if (n >= max) {
                    truncated = true;
                    break;
                }
                if (b.length() > MAX_REPLY_CHARS) {
                    clipped = true;
                    break;
                }
                b.append(n == 0 ? "" : ",").append('[');
                for (int i = 1; i <= cols; i++) {
                    b.append(i == 1 ? "" : ",");
                    String v = r.getString(i);
                    b.append(v == null ? "null" : q(v));
                }
                b.append(']');
                n++;
            }
            r.close();
            b.append("],\"rowCount\":").append(n).append(",\"truncated\":").append(truncated)
                    .append(",\"clipped\":").append(clipped);
        } finally {
            s.close();
            conn.rollback();
        }
        b.append(",\"ms\":").append(System.currentTimeMillis() - t).append('}');
        return b.toString();
    }

    /** 语句里用到的表各在哪个分区、能不能查。表名由 Node 侧校验成 [a-z0-9_$]，这里再挡一次 */
    private static String tableSchemas(Statement s, String tables) throws SQLException {
        StringBuilder in = new StringBuilder();
        for (String t : tables.split(",")) {
            if (!t.matches("[a-z0-9_$]+")) continue;
            in.append(in.length() == 0 ? "" : ",").append('\'').append(t).append('\'');
        }
        StringBuilder b = new StringBuilder("{");
        if (in.length() == 0) return b.append('}').toString();
        ResultSet r = s.executeQuery("select c.relname, n.nspname, has_table_privilege(c.oid, 'SELECT')"
                + " from pg_class c join pg_namespace n on n.oid = c.relnamespace"
                + " where c.relkind in ('r', 'v', 'm', 'p', 'f') and c.relname in (" + in + ")"
                + " and n.nspname = any(current_schemas(false)) order by 1, 2");
        Map<String, StringBuilder> by = new LinkedHashMap<String, StringBuilder>();
        while (r.next()) {
            StringBuilder list = by.get(r.getString(1));
            if (list == null) {
                list = new StringBuilder();
                by.put(r.getString(1), list);
            }
            list.append(list.length() == 0 ? "" : ",").append("{\"schema\":").append(q(r.getString(2)))
                    .append(",\"readable\":").append(r.getBoolean(3)).append('}');
        }
        r.close();
        boolean first = true;
        for (Map.Entry<String, StringBuilder> e : by.entrySet()) {
            b.append(first ? "" : ",").append(q(e.getKey())).append(":[").append(e.getValue()).append(']');
            first = false;
        }
        return b.append('}').toString();
    }

    /** 跳过开头的空白、括号和注释，第一个词必须是查询 */
    static boolean looksLikeQuery(String sql) {
        int i = 0;
        int n = sql.length();
        while (i < n) {
            char c = sql.charAt(i);
            if (Character.isWhitespace(c) || c == '(') {
                i++;
            } else if (sql.startsWith("--", i)) {
                int end = sql.indexOf('\n', i);
                i = end < 0 ? n : end + 1;
            } else if (sql.startsWith("/*", i)) {
                int end = sql.indexOf("*/", i + 2);
                if (end < 0) return false;
                i = end + 2;
            } else {
                break;
            }
        }
        String rest = sql.substring(i).toLowerCase();
        for (String w : new String[] {"select", "with", "values", "table", "explain"}) {
            if (rest.startsWith(w) && (rest.length() == w.length() || !Character.isLetterOrDigit(rest.charAt(w.length()))))
                return true;
        }
        return false;
    }

    private static String quoteIdent(String name) {
        return "\"" + name.replace("\"", "\"\"") + "\"";
    }

    private static String b64(String value) {
        if (value == null) return "";
        return new String(Base64.getDecoder().decode(value), StandardCharsets.UTF_8);
    }

    private static String env(String key) {
        String v = System.getenv(key);
        if (v == null || v.isEmpty()) throw new IllegalStateException("缺环境变量 " + key);
        return v;
    }

    static String q(String s) {
        if (s == null) return "null";
        StringBuilder b = new StringBuilder(s.length() + 2).append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': b.append("\\\""); break;
                case '\\': b.append("\\\\"); break;
                case '\n': b.append("\\n"); break;
                case '\r': b.append("\\r"); break;
                case '\t': b.append("\\t"); break;
                default:
                    if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
                    else b.append(c);
            }
        }
        return b.append('"').toString();
    }

    private static void writeAtomically(String path, String text) throws Exception {
        File target = new File(path);
        File parent = target.getParentFile();
        if (parent != null) parent.mkdirs();
        File tmp = new File(path + ".tmp");
        OutputStream o = new FileOutputStream(tmp);
        try {
            o.write(text.getBytes(StandardCharsets.UTF_8));
        } finally {
            o.close();
        }
        if (target.exists() && !target.delete()) throw new IllegalStateException("删不掉旧状态文件 " + path);
        if (!tmp.renameTo(target)) throw new IllegalStateException("写不进状态文件 " + path);
    }

    private static void log(String message) {
        System.err.println(new java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss").format(new java.util.Date())
                + " [prod-reader] " + message);
    }
}
