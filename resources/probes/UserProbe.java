import kd.bos.dataentity.entity.DynamicObject;
import kd.bos.dataentity.entity.DynamicObjectCollection;
import kd.bos.context.RequestContext;
import kd.bos.orm.query.QCP;
import kd.bos.orm.query.QFilter;
import kd.bos.servicehelper.QueryServiceHelper;

/**
 * 只读：查用户 id。写元数据/写业务数据时 COSMIC_USER 决定「修改人」是谁，
 * 默认 1 就是 administrator。
 *
 *   USER_KEY=关键字   按手机号(phone)、用户名(username)、工号(number)或姓名(name)模糊找，全是数字时也按用户 id 找；
 *                     不给就列前 20 个可用用户。用户名是登录用的账号，工号是人员编号，两样不一定相同
 *
 * 手机号也进检索条件，是因为**没人记得住自己的用户 id**，但人人记得自己的手机号：
 * 启动向导按手机号问一次，这里把它换成 id 写进 config.json。
 *
 * 每条命中额外发一条 [PROBE-JSON] t=user，末尾再发一条 t=user-lookup 报条数。
 * **人读行一个字不改**，同一批事实再发一份机器可读的（同 ProbeJson 的约定）。
 * 手机号在两条通道里都只出脱敏值：向导只需要拿它区分同名的人，
 * 而这两条通道的原文都会落进 build/ 的探针输出，没人需要那份原文。
 */
public class UserProbe {

    private static final int LIMIT = 20;

    public static void run() {
        System.out.println("[PROBE] 当前 RequestContext.userId=" + RequestContext.get().getUserId());

        String key = System.getenv("USER_KEY");
        boolean all = key == null || key.isEmpty();
        QFilter enable = new QFilter("enable", QCP.equals, "1");
        QFilter match = all ? null : new QFilter("number", QCP.like, "%" + key + "%")
                .or(new QFilter("username", QCP.like, "%" + key + "%"))
                .or(new QFilter("name", QCP.like, "%" + key + "%"))
                .or(new QFilter("phone", QCP.like, "%" + key + "%"));
        //全是数字的关键字也可能就是用户 id（run --user 给的是 id 时按它认人）
        if (match != null && key.matches("\\d{1,18}")) match = match.or(new QFilter("id", QCP.equals, Long.parseLong(key)));
        QFilter[] filters = all ? new QFilter[]{enable} : new QFilter[]{enable, match};

        DynamicObjectCollection rows = QueryServiceHelper.query("bos_user",
                "id,number,username,name,phone", filters, "number", LIMIT);
        System.out.println("[PROBE] 命中用户 " + rows.size() + " 个"
                + (all ? "（前 20 个，用 USER_KEY 过滤）" : "  关键字=" + maskKey(key)));
        for (DynamicObject u : rows) {
            System.out.println("[PROBE]   id=" + u.getString("id")
                    + "  用户名=" + u.getString("username")
                    + "  工号=" + u.getString("number")
                    + "  姓名=" + u.getString("name")
                    + "  手机号=" + maskPhone(u.getString("phone")));
            ProbeJson.emit("user",
                    "id", u.getString("id"),
                    "number", u.getString("number"),
                    "username", u.getString("username"),
                    "name", u.getString("name"),
                    "phone_mask", maskPhone(u.getString("phone")));
        }
        ProbeJson.emit("user-lookup",
                "key", all ? null : maskKey(key),
                "count", rows.size(),
                //满 LIMIT 就是「还有没列出来的」：向导据此让人换个更准的关键字，
                //而不是从一份被截断的名单里挑一个看着像的
                "truncated", rows.size() >= LIMIT);
    }

    /** 关键字是手机号才脱敏；用户名/姓名原样打回去，那半本来就是给人核对的 */
    static String maskKey(String key) {
        return key.matches("\\d{7,}") ? maskPhone(key) : key;
    }

    /** 只留头 3 尾 4。查不到手机号返回空串 —— 不编一个出来，「空」本身就是要报的事实 */
    static String maskPhone(String phone) {
        if (phone == null) {
            return "";
        }
        String s = phone.trim();
        if (s.isEmpty()) {
            return "";
        }
        if (s.length() < 7) {
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < s.length(); i++) {
                sb.append('*');
            }
            return sb.toString();
        }
        return s.substring(0, 3) + "****" + s.substring(s.length() - 4);
    }
}
