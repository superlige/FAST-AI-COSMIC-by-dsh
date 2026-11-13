import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;

import kd.bos.dataentity.entity.DynamicObject;
import kd.bos.db.DB;
import kd.bos.db.DBRoute;
import kd.bos.db.ResultSetHandler;
import kd.bos.servicehelper.QueryServiceHelper;

/**
 * 只读：把红线本身当回归用例跑一遍 —— 四个家族各要「本 ISV 放行 + 原厂拦截」两条断言。
 *
 * 红线是这套工具里代价最高的一条规则（改错了砸的是共享环境上所有人的元数据），而它现在
 * 只靠 IsvGuard 的代码正确。这个探针把它变成**每次 verify 都重跑的断言**：有人把某个
 * assert 改松了，这里立刻红。
 *
 * 样本从环境里现查、不硬编码单据号 —— 换账套换 ISV 照样能跑；某一类样本不存在时记
 * unresolved，不假装通过。
 *
 * 实体和字段那两道不在这里：它们要 EntityMetadata，已经被别的写探针天天用着。
 */
public class IsvGuardProbe {

    public static void run() {
        String isv = IsvGuard.ISV;
        String prefix = IsvGuard.PREFIX;
        System.out.println("[PROBE] 本 ISV = " + isv + "，前缀 = " + prefix);

        printTpl(isv, prefix);
        workflow(prefix);
        botp(isv, prefix);

        System.out.println("[PROBE] ");
        ProbeAssert.summary();
    }

    // ── 打印模板 ──────────────────────────────────────────────────────────
    /**
     * 判据取**本体** `bos_print_meta` 的 isv：目录 `bos_manageprinttpl` 上根本没有 isv 列。
     * 三类样本：全自有 / 本 ISV 但挂原厂单 / 原厂。中间那类是这条判据的分界点。
     */
    private static void printTpl(String isv, String prefix) {
        DynamicObject own = null, ownOnForeign = null, foreign = null;
        for (DynamicObject r : QueryServiceHelper.query("bos_print_meta",
                "id,number,isv,formid", null)) {
            String num = nz(r.getString("number")).toLowerCase();
            String host = nz(r.getString("formid")).toLowerCase();
            boolean mine = isv.equalsIgnoreCase(nz(r.getString("isv")));
            if (mine && num.startsWith(prefix) && host.startsWith(prefix) && own == null) own = r;
            if (mine && num.startsWith(prefix) && !host.startsWith(prefix) && ownOnForeign == null) ownOnForeign = r;
            if (!mine && foreign == null) foreign = r;
        }
        tpl("打印模板·全自有·只读", own, true, false);
        tpl("打印模板·全自有·写", own, true, true);
        tpl("打印模板·本ISV但挂原厂单·只读", ownOnForeign, true, false);
        tpl("打印模板·本ISV但挂原厂单·写", ownOnForeign, false, true);
        tpl("打印模板·原厂·只读", foreign, false, false);
        tpl("打印模板·原厂·写", foreign, false, true);
    }

    private static void tpl(String label, DynamicObject r, boolean expectPass, boolean write) {
        if (r == null) {
            ProbeAssert.unresolved("isvguard", label, verdict(expectPass), "环境里没有这一类样本");
            return;
        }
        String num = r.getString("number");
        String got = run(new Call() {
            public void go() {
                if (write) {
                    IsvGuard.assertOwnPrintTpl(num, num, r.getString("isv"), r.getString("formid"));
                } else {
                    IsvGuard.assertOwnPrintTplSelf(num, num, r.getString("isv"));
                }
            }
        });
        System.out.println("[PROBE]   样本 " + num + "  isv=" + q(r.getString("isv"))
                + "  挂靠=" + q(r.getString("formid")));
        ProbeAssert.isEqual("isvguard", label, verdict(expectPass), got);
    }

    // ── 工作流模型 ────────────────────────────────────────────────────────
    /** wf_model 上没有任何归属字段，挂靠单据 entrabill 是唯一判据 —— 详见 IsvGuard 里的注释 */
    private static void workflow(String prefix) {
        DynamicObject own = null, foreign = null;
        for (DynamicObject r : QueryServiceHelper.query("wf_model", "id,key,entrabill", null)) {
            String host = nz(r.getString("entrabill")).toLowerCase();
            if (host.startsWith(prefix)) {
                if (own == null) own = r;
            } else if (!host.isEmpty() && foreign == null) {
                foreign = r;
            }
        }
        wf("工作流·挂本ISV单据", own, true);
        wf("工作流·挂原厂单据", foreign, false);
    }

    private static void wf(String label, DynamicObject r, boolean expectPass) {
        if (r == null) {
            ProbeAssert.unresolved("isvguard", label, verdict(expectPass), "环境里没有这一类样本");
            return;
        }
        String got = run(new Call() {
            public void go() {
                IsvGuard.assertOwnWfModel(r.getString("key"), r.getString("entrabill"));
            }
        });
        ProbeAssert.isEqual("isvguard", label, verdict(expectPass), got);
    }

    // ── BOTP 转换规则 ─────────────────────────────────────────────────────
    /** 源单和目标单**两头都要是本 ISV**：有一头是原厂的，改规则就改了原厂单据的下推行为 */
    private static void botp(String isv, String prefix) {
        final List<String[]> rows = new ArrayList<String[]>();
        DB.query(DBRoute.meta, "select FID, FSourceEntityNumber, FTargetEntityNumber, FISV"
                + " from T_BOTP_ConvertRule", new ResultSetHandler<Void>() {
            public Void handle(ResultSet rs) throws SQLException {
                while (rs.next()) {
                    rows.add(new String[]{rs.getString(1), nz(rs.getString(2)),
                            nz(rs.getString(3)), nz(rs.getString(4))});
                }
                return null;
            }
        });
        String[] own = null, halfForeign = null, foreign = null;
        for (String[] r : rows) {
            boolean mine = isv.equalsIgnoreCase(r[3]);
            boolean s = r[1].toLowerCase().startsWith(prefix);
            boolean t = r[2].toLowerCase().startsWith(prefix);
            if (mine && s && t && own == null) own = r;
            if (mine && (s ^ t) && halfForeign == null) halfForeign = r;
            if (!mine && foreign == null) foreign = r;
        }
        System.out.println("[PROBE]   转换规则共 " + rows.size() + " 条");
        botp("BOTP·两头都是本ISV", own, true);
        botp("BOTP·本ISV但有一头是原厂单", halfForeign, false);
        botp("BOTP·原厂规则", foreign, false);
    }

    private static void botp(String label, String[] r, boolean expectPass) {
        if (r == null) {
            ProbeAssert.unresolved("isvguard", label, verdict(expectPass), "环境里没有这一类样本");
            return;
        }
        String got = run(new Call() {
            public void go() {
                IsvGuard.assertOwnBotpRule(r[0], r[3], r[1], r[2]);
            }
        });
        ProbeAssert.isEqual("isvguard", label, verdict(expectPass), got);
    }

    // ── 小工具 ────────────────────────────────────────────────────────────
    private interface Call {
        void go();
    }

    /**
     * 只把 IsvGuard 自己抛的 IllegalStateException 算「拒绝」。别的异常照原样抛出去 ——
     * 把它也吞成「拒绝」会让「样本查错了」看起来跟「红线生效了」一模一样。
     */
    private static String run(Call c) {
        try {
            c.go();
            return "放行";
        } catch (IllegalStateException e) {
            return "拒绝";
        }
    }

    private static String verdict(boolean pass) {
        return pass ? "放行" : "拒绝";
    }

    private static String nz(String s) {
        return s == null ? "" : s;
    }

    private static String q(String s) {
        return s == null || s.isEmpty() ? "(空)" : s;
    }
}
