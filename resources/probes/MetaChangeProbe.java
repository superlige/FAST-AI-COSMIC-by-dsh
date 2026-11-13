import java.sql.ResultSet;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import kd.bos.db.DB;
import kd.bos.db.DBRoute;
import kd.bos.db.ResultSetHandler;

/**
 * 代码关系表元数据快照的**变化清单**：插件登记、字段归属会落到的每张设计表，逐行报主键、编号和修改时间。
 * 只查这三列，不取设计内容。结论走 JSON 旁路（`t=stamp` 一行一条，`t=stamp-summary` 收尾）。
 *
 * 只读。命令内部用：建快照时记一份当基线，之后拿新清单跟基线比，出「新增 / 改过 / 删掉」的行，
 * 只把这些行交给 PluginIndexProbe / EntityFieldIndexProbe 重扫。
 *
 * 为什么比主键清单、不只看最大修改时间：被删的行没有修改时间。2026-09-17 真机上一个布局整个删掉，
 * 只看时间查不出来，比主键清单才看得到。
 *
 * 各处和 PluginIndexProbe 扫的是同一批行（2026-10-04 真机：全部合计约 1.4 万行，不到 1 秒）：
 *
 *   form      t_meta_formdesign（sys.meta）   本 ISV，FMODIFYDATE
 *   entity    t_meta_entitydesign（sys.meta） 本 ISV，FMODIFYDATE（也是字段归属的来源）
 *   print     t_svc_printmeta（sys）          本 ISV，FMODIFYTIME
 *   task      t_sch_taskdefine（sys）         类名列按包前缀过滤，FMODIFYTIME
 *   api       t_open_apiservice（sys）        类名列、插件列按包前缀过滤，FMODIFYTIME
 *   convert   t_botp_convertrule（sys.meta）  全表（按 FDATA 过滤要 2.6 秒，全表只取三列 0.1 秒），FMODIFYDATE
 *   workflow  t_wf_procdef + t_wf_participantmodel（wfs），按流程 key 汇总：版本数、最晚修改时间，
 *             参与人模型同样汇总。流程内容表 t_wf_gebytearray 没有时间列，新部署一版会多一行流程定义
 *
 * 编号就是插件登记里的 layout（布局标识、模板编号、任务编码、接口编号、规则 id、流程 key），
 * 补扫按它重查，删掉的行按它把旧登记拿掉。
 *
 *   IDX_PKGS  要找的 Java 包前缀，逗号分隔（必填，和 PluginIndexProbe 同一份）
 *   IDX_ISV   只看这个 ISV 的元数据，默认取本工程 ISV
 */
public class MetaChangeProbe {

    public static void run() {
        List<String> pkgs = new ArrayList<String>();
        for (String p : req("IDX_PKGS").split(",")) {
            p = p.trim();
            if (p.isEmpty()) {
                continue;
            }
            if (!p.matches("[A-Za-z0-9_$.]+")) {
                //前缀要拼进 SQL 的 like 字面量，形状先卡死
                throw new IllegalArgumentException("包前缀形状不合法：" + p);
            }
            pkgs.add(p.endsWith(".") ? p : p + ".");
        }
        if (pkgs.isEmpty()) {
            throw new IllegalArgumentException("IDX_PKGS 里一个包前缀都没有");
        }
        String isv = env("IDX_ISV", IsvGuard.ISV);
        if (!isv.matches("[A-Za-z0-9]+")) {
            throw new IllegalArgumentException("ISV 形状不合法（只允许字母数字）：" + isv);
        }
        long t0 = System.currentTimeMillis();
        int rows = 0;
        rows += rows("form", DBRoute.meta,
                "select fid, fnumber, fmodifydate from t_meta_formdesign where fisv = '" + isv + "'");
        rows += rows("entity", DBRoute.meta,
                "select fid, fnumber, fmodifydate from t_meta_entitydesign where fisv = '" + isv + "'");
        rows += rows("print", DBRoute.of("sys"),
                "select fid, fnumber, fmodifytime from t_svc_printmeta where fisv = '" + isv + "'");
        rows += rows("task", DBRoute.of("sys"),
                "select fid, fnumber, fmodifytime from t_sch_taskdefine where " + like("fclassname", pkgs));
        rows += rows("api", DBRoute.of("sys"),
                "select fid, fnumber, fmodifytime from t_open_apiservice where "
                        + like("fclassname", pkgs) + " or " + like("fplugin", pkgs));
        rows += rows("convert", DBRoute.of("sys.meta"),
                "select fid, fid, fmodifydate from t_botp_convertrule");
        rows += workflow();
        ProbeJson.emit("stamp-summary", "rows", rows, "sites", SITES, "ms", System.currentTimeMillis() - t0);
        System.out.println("[PROBE] 变化清单 " + rows + " 行，" + (System.currentTimeMillis() - t0) + "ms");
    }

    /** 这份清单覆盖的位置，和 PluginIndexProbe 的 SITES 同一组。 */
    private static final List<String> SITES = java.util.Arrays.asList(
            "form", "entity", "print", "task", "api", "convert", "workflow");

    private static int rows(final String site, DBRoute route, String sql) {
        final int[] n = {0};
        DB.query(route, sql, new ResultSetHandler<Void>() {
            public Void handle(ResultSet rs) throws Exception {
                while (rs.next()) {
                    String id = nz(rs.getString(1));
                    if (id.isEmpty()) {
                        continue;
                    }
                    n[0]++;
                    java.sql.Timestamp at = rs.getTimestamp(3);
                    ProbeJson.emit("stamp", "site", site, "id", id, "number", nz(rs.getString(2)),
                            "stamp", at == null ? "" : at.toString());
                }
                return null;
            }
        });
        return n[0];
    }

    /** 流程按 key 汇总：一个流程在库里有很多版本，补扫也是按 key 整个重查。 */
    private static int workflow() {
        final Map<String, String> def = new LinkedHashMap<String, String>();
        final Map<String, String> who = new LinkedHashMap<String, String>();
        sum(def, "select fkey, count(*), max(fmodifydate) from t_wf_procdef group by fkey");
        sum(who, "select p.fkey, count(*), max(m.fmodifydate) from t_wf_participantmodel m"
                + " join t_wf_procdef p on p.fid = m.fprocdefid group by p.fkey");
        for (String key : who.keySet()) {
            if (!def.containsKey(key)) {
                def.put(key, "");
            }
        }
        for (Map.Entry<String, String> e : def.entrySet()) {
            String people = who.get(e.getKey());
            ProbeJson.emit("stamp", "site", "workflow", "id", e.getKey(), "number", e.getKey(),
                    "stamp", e.getValue() + (people == null ? "" : " / " + people));
        }
        return def.size();
    }

    private static void sum(final Map<String, String> out, String sql) {
        DB.query(DBRoute.of("wfs"), sql, new ResultSetHandler<Void>() {
            public Void handle(ResultSet rs) throws Exception {
                while (rs.next()) {
                    String key = nz(rs.getString(1));
                    if (key.isEmpty()) {
                        continue;
                    }
                    java.sql.Timestamp at = rs.getTimestamp(3);
                    out.put(key, rs.getLong(2) + "@" + (at == null ? "" : at.toString()));
                }
                return null;
            }
        });
    }

    /** 拼 "(列 like '%前缀%' or …)"。 */
    private static String like(String col, List<String> pkgs) {
        StringBuilder b = new StringBuilder();
        for (String p : pkgs) {
            b.append(b.length() == 0 ? "(" : " or ").append(col).append(" like '%").append(p).append("%'");
        }
        return b.append(')').toString();
    }

    private static String nz(String v) {
        return v == null ? "" : v.trim();
    }

    private static String req(String key) {
        String v = System.getenv(key);
        if (v == null || v.trim().isEmpty()) {
            throw new IllegalArgumentException("需要环境变量 " + key + "（要找的 Java 包前缀，逗号分隔，如 zlgd.）");
        }
        return v.trim();
    }

    private static String env(String k, String def) {
        String v = System.getenv(k);
        return v == null || v.trim().isEmpty() ? def : v;
    }
}
