import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;

import kd.bos.algo.DataSet;
import kd.bos.algo.Row;
import kd.bos.db.DB;
import kd.bos.db.DBRoute;
import kd.bos.entity.botp.CRCondition;
import kd.bos.entity.botp.ConvertRuleElement;
import kd.bos.entity.botp.FieldMapPolicy;
import kd.bos.entity.botp.FilterPolicy;
import kd.bos.entity.botp.LinkEntityPolicy;
import kd.bos.entity.botp.PlugInPolicy;
import kd.bos.entity.filter.FilterCondition;
import kd.bos.entity.filter.SimpleFilterRow;
import kd.bos.metadata.botp.ConvertRuleMetadata;
import kd.bos.metadata.botp.ConvertRuleReader;

/**
 * 只读：BOTP 单据转换规则（下推/选单）——规则清单 + 挂的转换插件 + 分录映射 + 条件 + 字段映射。
 *
 * 转换规则不在 MetaCategory 里（那只有 Entity/Form），MetadataDao 查不到；它自成一张设计态表
 * T_BOTP_ConvertRule（DBRoute.meta），名称在 T_BOTP_ConvertRule_L。所以本探针分两步：
 * 先按源单/目标单从表里捞规则 id，再用 ConvertRuleReader.loadMeta(id,false) 解出
 * ConvertRuleElement（插件、字段映射都在里面）。
 *
 *   BOTP_SOURCE=源单实体标识    支持 % 通配，默认 <isv>%；给空串=不限
 *   BOTP_TARGET=目标单实体标识  支持 % 通配，默认不限
 *   BOTP_RULE=规则 id 或名称关键字   给了就只看它（id 走精确，其余走 like）
 *   BOTP_PLUGIN=插件类名关键字   只列挂了匹配插件的规则（会逐条加载规则，慢）
 *   BOTP_DETAIL=0|1|2           0=只列清单（默认）1=插件/分录映射/条件 2=再加字段映射明细
 *   BOTP_MAX=最多加载明细的规则数，默认 30
 */
public class BotpRuleProbe {

    public static void run() throws Exception {
        String source = env("BOTP_SOURCE", IsvGuard.ISV + "%");
        String target = env("BOTP_TARGET", "");
        String rule = env("BOTP_RULE", "");
        String pluginKey = env("BOTP_PLUGIN", "").toLowerCase();
        int detail = Integer.parseInt(env("BOTP_DETAIL", "0"));
        int max = Integer.parseInt(env("BOTP_MAX", "30"));
        //按插件筛选必须解规则内容，否则看不到插件
        boolean needLoad = detail > 0 || !pluginKey.isEmpty();

        List<Head> heads = queryHeads(source, target, rule);
        System.out.println("[PROBE] 条件 source=" + dash(source) + " target=" + dash(target)
                + " rule=" + dash(rule) + " plugin=" + dash(pluginKey)
                + " -> 命中 " + heads.size() + " 条规则");

        if (!needLoad) {
            for (Head h : heads) {
                System.out.println("[PROBE] " + h);
            }
            System.out.println("[PROBE] 只列了清单。要看插件/映射：BOTP_DETAIL=1，或 BOTP_RULE=<上面的 id>");
            return;
        }

        ConvertRuleReader reader = new ConvertRuleReader();
        int loaded = 0;
        int matched = 0;
        for (Head h : heads) {
            if (loaded >= max) {
                System.out.println("[PROBE] …还有 " + (heads.size() - loaded)
                        + " 条没加载（BOTP_MAX=" + max + "），收窄条件或调大 BOTP_MAX");
                break;
            }
            loaded++;
            ConvertRuleMetadata meta;
            try {
                meta = reader.loadMeta(h.id, false);
            } catch (Exception e) {
                System.out.println("[PROBE] " + h + "  加载失败: " + e);
                continue;
            }
            if (meta == null || meta.getRuleElement() == null) {
                System.out.println("[PROBE] " + h + "  规则内容为空");
                continue;
            }
            ConvertRuleElement el = meta.getRuleElement();
            List<String[]> plugins = plugins(el);
            if (!pluginKey.isEmpty() && !hitPlugin(plugins, pluginKey)) {
                continue;
            }
            matched++;
            dump(h, el, plugins, detail);
        }
        if (!pluginKey.isEmpty()) {
            System.out.println("[PROBE] 挂了 " + pluginKey + " 的规则 " + matched + " 条（已加载 "
                    + loaded + " 条）");
        }
        System.out.println("[PROBE] 本探针只读，不做任何写入");
    }

    // ---------- 明细 ----------

    private static void dump(Head h, ConvertRuleElement el, List<String[]> plugins, int detail) {
        System.out.println("[PROBE] ======== " + el.getName() + "   id=" + h.id);
        //启用状态在表上（FEnabled），不在规则 XML 里：el.isEnabled() 恒为 false，别拿它判断
        System.out.println("[PROBE]   " + el.getSourceEntityNumber() + " -> "
                + el.getTargetEntityNumber()
                + "  enabled=" + h.enabled
                + "  默认规则=" + el.isDefRule()
                + "  下推可见=" + el.isVisibled()
                + "  选单可见=" + el.isDrawVisibled()
                + "  自动保存=" + el.isAutoSave()
                + "  整单下推=" + el.isBillPush()
                + "  isv=" + h.isv);

        System.out.println("[PROBE]   -- 转换插件 " + plugins.size() + " 个");
        for (String[] p : plugins) {
            System.out.println("[PROBE]      " + p[0] + "  enabled=" + p[1]
                    + (p[2].isEmpty() ? "" : "  " + p[2]));
        }

        LinkEntityPolicy lep = el.getLinkEntityPolicy();
        if (lep != null) {
            System.out.println("[PROBE]   -- 分录映射  源分录=" + dash(lep.getSourceEntryKey())
                    + " 源子分录=" + dash(lep.getSourceSubEntryKey())
                    + " -> 目标分录=" + dash(lep.getTargetEntryKey())
                    + " 目标子分录=" + dash(lep.getTargetSubEntryKey())
                    + "  linkType=" + dash(lep.getLinkType())
                    + "  选单布局=" + dash(lep.getSourceLayout()));
        }

        CRCondition cond = el.getRunCondition();
        if (cond != null && !brief(cond, detail).isEmpty()) {
            System.out.println("[PROBE]   -- 执行条件 enabled=" + cond.isEnabled()
                    + "  " + brief(cond, detail));
        }
        FilterPolicy fp = el.getFilterPolicy();
        if (fp != null && fp.getCondition() != null && !brief(fp.getCondition(), detail).isEmpty()) {
            System.out.println("[PROBE]   -- 源单过滤 " + brief(fp.getCondition(), detail));
        }
        Object brp = el.getBizRulePolicy();
        Object actions = brp == null ? null : call(brp, "getActions");
        if (actions instanceof List && !((List<?>) actions).isEmpty()) {
            System.out.println("[PROBE]   -- 业务规则 " + ((List<?>) actions).size() + " 条");
            for (Object a : (List<?>) actions) {
                System.out.println("[PROBE]      " + call(a, "getName")
                        + "  enabled=" + call(a, "isEnabled"));
            }
        }

        FieldMapPolicy fmp = el.getFieldMapPolicy();
        List<?> fms = fmp == null ? null : fmp.getFieldMaps();
        int n = fms == null ? 0 : fms.size();
        System.out.println("[PROBE]   -- 字段映射 " + n + " 条"
                + (detail >= 2 ? "" : "（BOTP_DETAIL=2 看明细）"));
        if (detail >= 2 && fms != null) {
            for (Object fm : fms) {
                Object convertType = call(fm, "getConvertType");
                System.out.println("[PROBE]      " + call(fm, "getTargetFieldKey")
                        + " <= " + describeSource(fm, str(convertType))
                        + "  [" + convertType + "]"
                        + "  汇总=" + call(fm, "getSumType")
                        + "  有效=" + call(fm, "isValid"));
            }
        }
    }

    /**
     * 条件的 getFilterString() 是一大坨 JSON（一条规则能几千字符，刷屏且没法读），
     * 所以默认压成「字段 比较符 值」；DETAIL=2 才给原始 JSON。
     */
    private static String brief(CRCondition cond, int detail) {
        FilterCondition fc = cond.getFilterCondition();
        List<SimpleFilterRow> rows = fc == null ? null : fc.getFilterRow();
        if (rows == null || rows.isEmpty()) {
            return "";
        }
        if (detail >= 2) {
            return str(cond.getFilterString());
        }
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < rows.size(); i++) {
            SimpleFilterRow row = rows.get(i);
            if (i > 0) {
                // 平台把连接下一行的逻辑符存放在上一行；不能用当前行的 logic。
                sb.append("1".equals(rows.get(i - 1).getLogic()) ? " OR " : " AND ");
            }
            sb.append(row.getLeftBracket()).append(row.getFieldName())
                    .append(' ').append(dash(row.getCompareTypeDesc()))
                    .append('(').append(row.getCompareType()).append(") ");
            List<?> values = row.getValue();
            if (values != null) {
                for (int j = 0; j < values.size(); j++) {
                    if (j > 0) {
                        sb.append('/');
                    }
                    sb.append(call(values.get(j), "getValue"));
                }
            }
            sb.append(row.getRightBracket());
        }
        return sb.toString();
    }

    /** 取值来源随 convertType 变：源字段 / 常量 / 公式，打错了会以为映射是空的。 */
    private static String describeSource(Object fm, String convertType) {
        if ("Constant".equals(convertType)) {
            return "常量 " + str(call(fm, "getConstant"));
        }
        if ("Formula".equals(convertType)) {
            //getFormula() 返回 CRFormula 对象，直接拼字符串只会得到 CRFormula@1a2b3c
            Object formula = call(fm, "getFormula");
            return "公式 " + str(call(formula, "getExpression"))
                    + "  【" + str(call(formula, "getExprTran")) + "】";
        }
        String src = str(call(fm, "getSourceFieldKey"));
        return src.isEmpty() ? "-" : src;
    }

    // ---------- 插件 ----------

    /** 返回 {类名, enabled, 备注}。插件元素类型不固定，一律反射取。 */
    private static List<String[]> plugins(ConvertRuleElement el) {
        List<String[]> result = new ArrayList<String[]>();
        PlugInPolicy pp = el.getPlugInPolicy();
        Object list = pp == null ? null : call(pp, "getPlugins");
        if (!(list instanceof List)) {
            return result;
        }
        for (Object p : (List<?>) list) {
            String className = str(call(p, "getClassName"));
            if (className.isEmpty()) {
                className = str(call(p, "getPluginName"));
            }
            String enabled = str(call(p, "isEnabled"));
            if (enabled.isEmpty() || "-".equals(enabled)) {
                enabled = str(call(p, "getEnabled"));
            }
            String note = str(call(p, "getDescription"));
            if (note.isEmpty() || "-".equals(note)) {
                note = "";
            }
            result.add(new String[] { className.isEmpty() ? p.getClass().getName() : className,
                    enabled, note });
        }
        return result;
    }

    private static boolean hitPlugin(List<String[]> plugins, String key) {
        for (String[] p : plugins) {
            if (p[0].toLowerCase().contains(key)) {
                return true;
            }
        }
        return false;
    }

    // ---------- 规则清单 ----------

    private static List<Head> queryHeads(String source, String target, String rule) {
        StringBuilder sql = new StringBuilder(
                "select r.FID, l.FName, r.FSourceEntityNumber, r.FTargetEntityNumber,"
                        + " r.FEnabled, r.FISV from T_BOTP_ConvertRule r"
                        + " left join T_BOTP_ConvertRule_L l on l.FID = r.FID"
                        + " and l.FLocaleId = 'zh_CN' where 1 = 1");
        List<Object> params = new ArrayList<Object>();
        if (!source.isEmpty()) {
            sql.append(" and r.FSourceEntityNumber like ?");
            params.add(source);
        }
        if (!target.isEmpty()) {
            sql.append(" and r.FTargetEntityNumber like ?");
            params.add(target);
        }
        if (!rule.isEmpty()) {
            if (rule.matches("\\d{6,}")) {
                sql.append(" and r.FID = ?");
                params.add(rule);
            } else {
                sql.append(" and l.FName like ?");
                params.add("%" + rule + "%");
            }
        }
        sql.append(" order by r.FSourceEntityNumber, r.FTargetEntityNumber");

        List<Head> heads = new ArrayList<Head>();
        DataSet ds = DB.queryDataSet("BotpRuleProbe", DBRoute.meta, sql.toString(),
                params.toArray());
        try {
            for (Row r : ds) {
                Head h = new Head();
                h.id = r.getString("FID");
                h.name = r.getString("FName");
                h.source = r.getString("FSourceEntityNumber");
                h.target = r.getString("FTargetEntityNumber");
                h.enabled = String.valueOf(r.get("FEnabled"));
                h.isv = r.getString("FISV");
                heads.add(h);
            }
        } finally {
            ds.close();
        }
        return heads;
    }

    private static class Head {
        String id;
        String name;
        String source;
        String target;
        String enabled;
        String isv;

        @Override
        public String toString() {
            return source + " -> " + target + "  「" + dash(name) + "」"
                    + "  enabled=" + enabled + "  isv=" + isv + "  id=" + id;
        }
    }

    // ---------- 小工具 ----------

    private static Object call(Object o, String method) {
        if (o == null) {
            return "-";
        }
        try {
            Method m = o.getClass().getMethod(method);
            return m.invoke(o);
        } catch (NoSuchMethodException e) {
            return "-";
        } catch (Exception e) {
            return "?" + e.getClass().getSimpleName();
        }
    }

    private static String str(Object o) {
        return o == null ? "" : String.valueOf(o);
    }

    private static String dash(String s) {
        return s == null || s.isEmpty() ? "-" : s;
    }

    private static String env(String k, String def) {
        String v = System.getenv(k);
        return v == null ? def : v;
    }
}
