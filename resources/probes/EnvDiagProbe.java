import java.sql.ResultSet;
import java.util.ArrayList;
import java.util.List;

import kd.bos.context.RequestContext;
import kd.bos.dataentity.entity.DynamicObject;
import kd.bos.db.DB;
import kd.bos.db.DBRoute;
import kd.bos.db.ResultSetHandler;
import kd.bos.dc.api.model.Account;
import kd.bos.dc.api.model.DBInstance;
import kd.bos.dc.utils.AccountUtils;
import kd.bos.metadata.dao.MetaCategory;
import kd.bos.metadata.dao.MetadataDao;
import kd.bos.orm.query.QCP;
import kd.bos.orm.query.QFilter;
import kd.bos.servicehelper.QueryServiceHelper;

/**
 * 环境自检探针：一次跑完，输出「我到底连到了哪里、看得见什么」。
 *
 * 用于排查 skill 分发到别人机器上「连不上 / 读不到元数据」的根因。
 * 全程只读，不写任何东西。
 *
 *   DIAG_ENTITY=标识   用来试探的本 ISV 元数据标识，默认 <isv>_xlyc_mx
 *
 * 末尾额外发一条 [PROBE-JSON] t=profile-env —— `doctor --write` 拿它填 ProjectProfile
 * 的环境指纹块。**人读行一个字不改**，同一批事实再发一份机器可读的（同 ProbeJson 的约定）。
 */
public class EnvDiagProbe {

    public static void run() throws Exception {
        //默认值是本工程的样例实体；换工程用 DIAG_ENTITY 指定一个本 ISV 的实体标识
        String probeKey = env("DIAG_ENTITY", IsvGuard.PREFIX + "xlyc_mx");

        //① 连到哪个 ZK / MC —— 这几个系统属性是 DebugApplication.devRemote() 设进去的。
        //   同事要是本地改过 DebugApplication，或者压根走了别的分支，这里立刻看得出来
        System.out.println("[PROBE] ===== ① 连接目标（来自 DebugApplication）=====");
        for (String k : new String[]{"configUrl", "mcUrl", "mc.server.url", "cluster.name",
                "tenant.number", "cluster.number", "domain.contextUrl"}) {
            System.out.println("[PROBE]   " + k + " = " + System.getProperty(k));
        }

        //② 当前请求上下文 —— 租户/账套/用户是 CosmicProbe 硬编码进来的
        RequestContext rc = RequestContext.get();
        //旁路要用的几项，边打边收；采不到就保持 null，不填默认值
        String curAccountId = rc == null ? null : rc.getAccountId();
        String curTenantId = rc == null ? null : rc.getTenantId();
        String curUserId = rc == null ? null : rc.getUserId();
        String curAccountNumber = null;
        String metaDb = null;
        int metaCount = -1;
        System.out.println("[PROBE] ===== ② 当前上下文 =====");
        System.out.println("[PROBE]   tenantId  = " + (rc == null ? "(无)" : rc.getTenantId()));
        System.out.println("[PROBE]   accountId = " + (rc == null ? "(无)" : rc.getAccountId()));
        System.out.println("[PROBE]   userId    = " + (curUserId == null ? "(无)" : curUserId));
        //把 id 解析成名字：user 填错**一点症状都没有**，只是从此所有写操作的「修改人」
        //记在别人头上。id 谁也认不出对不对，名字能，所以报给人看的一律用名字
        String curUserName = userName(curUserId);
        System.out.println("[PROBE]   userName  = " + (curUserName == null ? "(查不到)" : curUserName));

        //③ 这个环境里到底有哪些账套 —— 「读不到元数据」最常见的原因是账套选错，
        //   而不是连不上。选错时报的是「元数据不存在」，跟连不上长得一模一样
        System.out.println("[PROBE] ===== ③ 可见账套 =====");
        List<Account> accounts = AccountUtils.getAllAccountsOfCurrentEnv();
        if (accounts == null || accounts.isEmpty()) {
            System.out.println("[PROBE]   ⚠ 一个账套都没拿到 —— 多半是 MC(8090) 不通或租户不对");
        } else {
            String cur = rc == null ? "" : rc.getAccountId();
            for (Account a : accounts) {
                if (a.getAccountId().equals(cur)) {
                    curAccountNumber = a.getAccountNumber();
                }
                System.out.println("[PROBE]   " + (a.getAccountId().equals(cur) ? "→ " : "  ")
                        + a.getAccountNumber() + "  id=" + a.getAccountId()
                        + "  name=" + a.getAccountName() + "  tenant=" + a.getTenantId());
            }
        }

        //④ 当前账套实际连的库 —— 两台机器读到的元数据不一样时，先比这里的 ip/schema
        System.out.println("[PROBE] ===== ④ 当前账套的数据库 =====");
        Account me = null;
        if (accounts != null) {
            for (Account a : accounts) {
                if (rc != null && a.getAccountId().equals(rc.getAccountId())) {
                    me = a;
                }
            }
        }
        if (me == null) {
            System.out.println("[PROBE]   ⚠ 当前 accountId 不在可见账套列表里");
        } else {
            List<DBInstance> dbs = me.getDBInstanceList();
            if (dbs == null) {
                dbs = new ArrayList<DBInstance>();
            }
            //几百个 route 全打是刷屏，只挑判断「是不是同一个库」用得上的几条
            List<String> want = java.util.Arrays.asList("sys.meta", "main", "data", "basedata",
                    IsvGuard.PREFIX + "cust");
            for (DBInstance d : dbs) {
                if (want.contains(d.getRouteKey())) {
                    //指纹只取 sys.meta 一条：元数据读的就是它，换库先换它。
                    //**不进用户名和密码** —— profile 会被人传阅（数据分级里它是 P1）
                    if ("sys.meta".equals(d.getRouteKey())) {
                        //MySQL 下 getDbSchema() 是 null（人读行里也是 schema=null）——
                        //拼进指纹会变成字面量 "null"，看着像采到了一个叫 null 的库
                        metaDb = d.getDbip() + ":" + d.getDbport()
                                + (d.getDbSchema() == null ? "" : "/" + d.getDbSchema());
                    }
                    //不打密码
                    System.out.println("[PROBE]   route=" + d.getRouteKey()
                            + "  " + d.getDbip() + ":" + d.getDbport()
                            + "  schema=" + d.getDbSchema()
                            + "  type=" + d.getDbtype() + "  user=" + d.getDbuser());
                }
            }
            System.out.println("[PROBE]   （共 " + dbs.size() + " 个 route，上面只列了关键几条）");
        }

        //⑤ 这个账套里本 ISV 的元数据有多少 —— 0 就是账套选错了，不是权限也不是网络
        //  IsvGuard.PREFIX 的形状已被 requireIsv() 限死在 [a-z0-9]+_，拼进 SQL 是安全的
        System.out.println("[PROBE] ===== ⑤ 本账套的 " + IsvGuard.PREFIX + " 元数据 =====");
        try {
            final int n = DB.query(DBRoute.meta,
                    "select count(*) from t_meta_entitydesign where fnumber like '"
                            + IsvGuard.ISV + "@_%' escape '@'",
                    new ResultSetHandler<Integer>() {
                        public Integer handle(ResultSet rs) throws Exception {
                            return rs.next() ? rs.getInt(1) : -1;
                        }
                    });
            metaCount = n;
            System.out.println("[PROBE]   " + IsvGuard.PREFIX + " 开头的实体元数据 = " + n + " 个");
            if (n == 0) {
                System.out.println("[PROBE]   ⚠⚠ 这个账套里没有任何 " + IsvGuard.PREFIX + " 元数据 —— "
                        + "账套选错了，不是网络问题。用 COSMIC_ACCOUNT 换账套");
            }
        } catch (Throwable t) {
            System.out.println("[PROBE]   ⚠ 查元数据表失败：" + t);
        }

        //⑥ 拿一个具体标识走完整解析链，确认读元数据这条路是通的
        System.out.println("[PROBE] ===== ⑥ 试读 " + probeKey + " =====");
        try {
            String id = MetadataDao.getIdByNumber(probeKey, MetaCategory.Entity);
            System.out.println("[PROBE]   设计态 id = " + (id == null || id.isEmpty() ? "(查不到)" : id));
            System.out.println("[PROBE]   运行态    = " + MetaResolve.type(probeKey).getDisplayName()
                    + "  表=" + MetaResolve.type(probeKey).getAlias());
            System.out.println("[PROBE]   ✅ 元数据读取正常");
        } catch (Throwable t) {
            System.out.println("[PROBE]   ❌ 读不到：" + t);
        }

        //机器可读旁路：doctor --write 拿它填 ProjectProfile 的 env 块。
        //每一项上面都有对应的人读行，没有一项是这里新算出来的
        ProbeJson.emit("profile-env",
                "tenant_id", curTenantId,
                "account_id", curAccountId,
                "account_number", curAccountNumber,
                "accounts", accounts == null ? 0 : accounts.size(),
                "db", metaDb,
                "isv", IsvGuard.ISV,
                "user_name", curUserName,
                "meta_count", metaCount);
    }

    /** 查不到就返回 null —— 不编一个名字出来，「(查不到)」本身就是要报的事实 */
    private static String userName(String userId) {
        if (userId == null || userId.isEmpty()) return null;
        try {
            DynamicObject u = QueryServiceHelper.queryOne("bos_user", "name,number",
                    new QFilter[]{new QFilter("id", QCP.equals, Long.parseLong(userId))});
            return u == null ? null : u.getString("name");
        } catch (Throwable t) {
            System.out.println("[PROBE]   ⚠ 用户名解析失败：" + t);
            return null;
        }
    }

    private static String env(String k, String def) {
        String v = System.getenv(k);
        return v == null || v.isEmpty() ? def : v;
    }
}
