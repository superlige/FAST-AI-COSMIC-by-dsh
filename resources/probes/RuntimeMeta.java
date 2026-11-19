import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import kd.bos.db.DB;
import kd.bos.db.DBRoute;
import kd.bos.db.ResultSetHandler;
import kd.bos.metadata.dao.MetadataDao;

/**
 * 不是探针，是写表单元数据的探针共用的：重建运行态时连同继承这张表单的派生布局一起重建。
 *
 * 平台的运行态（T_META_FORM）是每张布局各存一份、已经把继承链合并好的结果。
 * {@code MetadataDao.rebuildRuntimeMetaById} 只重建点名的那一张，继承它的派生布局还留着旧的那份：
 * 主单据布局上加了字段，派生布局的运行态里没有这个控件，打开派生布局就没有这个字段；表单规则同理。
 * 真机 zlgd：zlgd_sys_test_bill 加了 5 个字段、只重建了它自己，31 张派生布局（含 zlgd_sys_test_plsy）的运行态里都没有新字段，
 * 重启 JVM 也不变——旧的是库里那份，不是缓存。
 *
 * 不能删掉派生布局这一步，也不能只在提示里写「派生布局跟着变」：设计态继承了，运行态不重建就没有。
 */
final class RuntimeMeta {

    private RuntimeMeta() {
    }

    /** 派生布局：继承路径里有这张表单的，{FID, 标识}，父在前子在后（继承路径短的先建）。 */
    static List<String[]> heirs(String formId) {
        final List<String[]> rows = new ArrayList<String[]>();
        DB.query(DBRoute.meta, "/*dialect*/select FID, FNUMBER, FINHERITPATH from t_meta_formdesign"
                        + " where (FINHERITPATH like ? or FPARENTID = ?) and FID <> ?",
                new Object[]{"%" + formId + "%", formId, formId},
                (ResultSetHandler<Object>) rs -> {
                    while (rs.next()) {
                        String path = rs.getString(3);
                        rows.add(new String[]{rs.getString(1), rs.getString(2), path == null ? "" : path});
                    }
                    return null;
                });
        Collections.sort(rows, (a, b) -> {
            int depth = Integer.compare(depth(a[2]), depth(b[2]));
            return depth != 0 ? depth : String.valueOf(a[1]).compareTo(String.valueOf(b[1]));
        });
        List<String[]> out = new ArrayList<String[]>();
        for (String[] r : rows) out.add(new String[]{r[0], r[1]});
        return out;
    }

    private static int depth(String path) {
        int n = 0;
        for (int i = 0; i < path.length(); i++) if (path.charAt(i) == ',') n++;
        return n;
    }

    /**
     * 重建派生布局的运行态（点名的那张由调用方先建好）。逐张建，一张失败不挡后面的。
     *
     * @return {重建成功的张数, 失败的「标识：原因」列表}
     */
    static Object[] rebuildHeirs(List<String[]> heirs) {
        int ok = 0;
        List<String> failed = new ArrayList<String>();
        for (String[] h : heirs) {
            try {
                MetadataDao.rebuildRuntimeMetaById(h[0]);
                ok++;
            } catch (Throwable e) {
                String msg = e.getMessage() == null ? "" : e.getMessage().replaceAll("\\s+", " ");
                failed.add(h[1] + "：" + e.getClass().getSimpleName() + (msg.isEmpty() ? "" : " " + msg));
            }
        }
        return new Object[]{Integer.valueOf(ok), failed};
    }

    /**
     * 点名的那张已经重建之后调：查派生布局、逐张重建、逐项报数（0 张也报）。
     * 查不成或有失败的打 !! 行——这些布局打开时看不到这次的改动。
     */
    @SuppressWarnings("unchecked")
    static void rebuildHeirsAndReport(String formId) {
        List<String[]> heirs;
        try {
            heirs = heirs(formId);
        } catch (Throwable e) {
            System.out.println("[PROBE] !! 派生布局没查成，它们的运行态没重建（" + e.getClass().getSimpleName() + "）");
            return;
        }
        Object[] r = rebuildHeirs(heirs);
        List<String> failed = (List<String>) r[1];
        System.out.println("[PROBE] 派生布局运行态重建 " + r[0] + "/" + heirs.size() + " 张"
                + (heirs.isEmpty() ? "" : "：" + names(heirs)));
        for (String f : failed) System.out.println("[PROBE] !! 派生布局运行态没重建成，打开它看不到这次的改动：" + f);
    }

    /** 标识连成一串，给人看。 */
    static String names(List<String[]> heirs) {
        List<String> names = new ArrayList<String>();
        for (String[] h : heirs) names.add(h[1]);
        return String.join("、", names);
    }
}
