//—— 拷这个文件改成你自己的探针。一次性的拷到 scratchpad，别留在 probes/ 里 ——
//
//   node .claude/skills/long-cosmic-dev/driver.mjs probe <scratchpad>/MyProbe.java
//
//下面这堆 import 是苍穹探针八成会用到的。**宁多勿少 —— javac 不会因为多余的 import 报错**，
//但漏一个（尤其 java.util.Map / List）就是一轮 30 秒的编译失败，而且中文报错在这台机器上
//还容易被淹掉。用不上的删掉就行。

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.sql.ResultSet;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import kd.bos.dataentity.entity.DynamicObject;
import kd.bos.dataentity.entity.DynamicObjectCollection;
import kd.bos.dataentity.metadata.ICollectionProperty;
import kd.bos.dataentity.metadata.IDataEntityProperty;
import kd.bos.dataentity.metadata.IDataEntityType;
import kd.bos.dataentity.metadata.dynamicobject.DynamicObjectType;
import kd.bos.db.DB;
import kd.bos.db.DBRoute;
import kd.bos.db.ResultSetHandler;
import kd.bos.entity.EntityMetadataCache;
import kd.bos.entity.MainEntityType;
import kd.bos.orm.query.QCP;
import kd.bos.orm.query.QFilter;
import kd.bos.servicehelper.BusinessDataServiceHelper;
import kd.bos.servicehelper.QueryServiceHelper;

/**
 * 探针样板（只读）。约定只有一条：`public static void run()`，类名 = 文件名，无包名。
 *
 *   TPL_ENTITY=实体或布局标识   必填
 */
public class TemplateProbe {

    public static void run() throws Exception {
        String input = req("TPL_ENTITY", "要查的实体或布局标识");

        //① 标识一律过 MetaResolve —— 界面上看到的可能是布局，不是实体
        MainEntityType t = MetaResolve.type(input);
        System.out.println("[PROBE] 实体 " + t.getName() + "  " + t.getDisplayName()
                + "  表=" + t.getAlias());

        //② 查数据。注意 query 返回的是扁平行，带 "分录.字段" 时分录侧是 LEFT JOIN，
        //   分录表为空照样返回行 —— 判断有没有数据用 DataProbe，别看这里的 size()
        DynamicObjectCollection rows = QueryServiceHelper.query(t.getName(),
                "id,billno,billstatus",
                new QFilter[]{new QFilter("billstatus", QCP.equals, "C")},
                "id desc", 3);
        System.out.println("[PROBE] 已审核样本 " + rows.size() + " 条");
        for (DynamicObject r : rows) {
            System.out.println("[PROBE]   " + r.getString("billno") + "  id=" + r.get("id"));
        }

        //③ 要拿分录集合必须 load，query 拿不到
        if (!rows.isEmpty()) {
            DynamicObject bill = BusinessDataServiceHelper.loadSingle(rows.get(0).get("id"), t.getName());
            System.out.println("[PROBE] 样本 " + bill.getString("billno") + " 加载完成");
        }

        //④ 业务逻辑：直接 import 工程里的类跑真实代码
        //   （业务模块里的工具类 —— 探针是编译源码跑的，不用部署）
    }

    /**
     * 必填的环境变量。没给就打用法后中止 —— 与其塞一个默认标识让人跑出「元数据不存在」
     * （那跟标识拼错、跟账套选错长得一模一样），不如直接说清楚该填什么。
     * 抛异常而不是 System.exit()：后者会带走常驻探针 JVM。
     */
    private static String req(String k, String what) {
        String v = System.getenv(k);
        if (v != null && !v.trim().isEmpty()) {
            return v.trim();
        }
        System.out.println("[PROBE] 缺必填参数 " + k + " —— " + what);
        System.out.println("[PROBE] 用法: TPL_ENTITY=<实体标识> node .claude/skills/long-cosmic-dev/driver.mjs probe TemplateProbe");
        System.out.println("[PROBE] 不知道填什么：本工程的标识一律 <isv>_ 开头，isv 见 driver.mjs doctor");
        throw new IllegalArgumentException(k + " 未设置");
    }

    private static String env(String k, String def) {
        String v = System.getenv(k);
        return v == null || v.isEmpty() ? def : v;
    }
}
