import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;
import kd.bos.dataentity.entity.DynamicObject;
import kd.bos.dataentity.entity.DynamicObjectCollection;
import kd.bos.orm.query.QCP;
import kd.bos.orm.query.QFilter;
import kd.bos.servicehelper.QueryServiceHelper;

/**
 * 只读：开放平台上配置的 API 服务（实体 openapi_apilist，表 t_open_apiservice）——
 * **一张单据被哪些接口写入、每个接口触发哪个单据操作、绑了什么插件、请求体能传哪些字段**。
 *
 * 为什么要有它（实测踩过的坑）：
 *   「接口传进来的单据没走界面插件的默认值联动」这类需求，光看 ApiDeserializerPlugin
 *   的源码是答不出来的 —— 源码里看不出它挂在哪个 API 上，更看不出**同一张单据还有另一个
 *   API 根本没挂这个插件**。实测一张委托单挂着两个保存接口，反序列化插件只绑了其中一个，
 *   补默认值的逻辑写进那个插件就漏掉另一条链路。
 *   请求体清单同样是硬事实：**bodyentryentity 里没有的字段，上游想传也传不进来**，
 *   而 param_default_value 决定了上游不传时落库的是什么。
 *   「Java插件」类型的接口，实现类记在 classname，不在 plugin：只看 plugin 会把一个绑着实现类的接口
 *   报成「插件：无」，按实现类反查也查不到（真机 2026-09-27，模型为找一个接口绑的类多查了十几次）。
 *   一条接口的四类参数（Query 参数、请求体、返回参数、配置参数）一次给全：原来只给请求体、还要带关键字，
 *   返回参数完全不给，模型只好先摸登记表的字段名再自己拼查询（S37 批 8：3 + 5 次，两次字段名写错）。
 *   命中多条时只报个数、少的照列，免得一张单据几个零代码接口、每个上百个参数刷屏。
 *
 *   API_ENTITY=业务对象标识   查这张单据/实体上挂的所有 API（给布局标识也行）
 *   API_PLUGIN=类名关键字     反查某个类挂在哪些 API 上（实现类、插件都查）
 *   API_NUMBER=API 编码       直接看某个 API（逗号分隔可给多个）
 *   API_FIELDS=参数关键字     可选，逗号分隔；请求体只列名字匹配的参数
 *   —— 前三个至少给一个。
 */
public class ApiMetaProbe {

    private static final String SEL = "number,name,bizobject.number,urlformat,httpmethod,operation,"
            + "apiservicetype,classname,plugin,status,enable";

    /** 命中不超过这么多个接口时逐个列参数，多了只报个数 */
    private static final int DETAIL_APIS = 5;
    /** 没点名要看的接口，某类参数超过这么多只报个数 */
    private static final int LIST_LIMIT = 30;

    public static void run() {
        String entity = env("API_ENTITY", "");
        String plugin = env("API_PLUGIN", "");
        String number = env("API_NUMBER", "");
        if (entity.isEmpty() && plugin.isEmpty() && number.isEmpty()) {
            usage();
            throw new IllegalArgumentException("API_ENTITY / API_PLUGIN / API_NUMBER 至少给一个");
        }

        List<QFilter> filters = new ArrayList<>();
        if (!entity.isEmpty()) {
            //入参可能是布局标识，API 上绑的是实体，先归一
            String real = entity;
            try {
                real = MetaResolve.type(entity).getName();
            } catch (Exception e) {
                System.out.println("[PROBE] 提示：" + entity + " 解析实体失败（" + e.getClass().getSimpleName()
                        + "），按原样当业务对象查");
            }
            System.out.println("[PROBE] 业务对象 = " + real);
            filters.add(new QFilter("bizobject.number", QCP.equals, real));
        }
        if (!plugin.isEmpty()) {
            System.out.println("[PROBE] 类名含 = " + plugin);
            filters.add(new QFilter("plugin", QCP.like, "%" + plugin + "%")
                    .or(new QFilter("classname", QCP.like, "%" + plugin + "%")));
        }
        if (!number.isEmpty()) {
            System.out.println("[PROBE] API 编码 = " + number);
            filters.add(new QFilter("number", QCP.in, number.split(",")));
        }

        DynamicObjectCollection rows = QueryServiceHelper.query("openapi_apilist", SEL,
                filters.toArray(new QFilter[0]), "number");
        System.out.println("[PROBE] 命中 " + rows.size() + " 个 API");
        List<String> numbers = new ArrayList<>();
        for (DynamicObject r : rows) {
            numbers.add(r.getString("number"));
        }
        String fields = env("API_FIELDS", "");
        //点名要看（给了编码或参数关键字）就全列；否则少的照列、多的只报个数
        boolean asked = !number.isEmpty() || !fields.isEmpty();
        boolean detail = asked || rows.size() <= DETAIL_APIS;
        Map<String, List<String>> query = section(numbers, "urlparamentryentity",
                "urlparamname,urlparamtype,urlparammust");
        Map<String, List<String>> body = section(numbers, "bodyentryentity",
                "paramname,objpropname,paramtype,must,param_default_value");
        Map<String, List<String>> resp = section(numbers, "respentryentity",
                "respparamname,respparamtype,respparammust,resp_level");
        Map<String, List<String>> ext = section(numbers, "extentity", "ext_key,ext_value");
        for (DynamicObject r : rows) {
            String no = r.getString("number");
            System.out.println("[PROBE] ======== " + no + "  " + r.getString("name"));
            System.out.println("[PROBE]   业务对象=" + r.getString("bizobject.number")
                    + "  触发操作=" + emp(r.getString("operation"))
                    + "  类型=" + apiType(r.getString("apiservicetype")));
            System.out.println("[PROBE]   " + method(r.getString("httpmethod")) + " " + r.getString("urlformat"));
            System.out.println("[PROBE]   状态=" + status(r.getString("status"))
                    + "  使用=" + ("1".equals(r.getString("enable")) ? "可用" : "禁用"));
            String impl = r.getString("classname");
            if (impl != null && !impl.trim().isEmpty()) {
                System.out.println("[PROBE]   实现类 " + impl);
            }
            dumpPlugins(r.getString("plugin"));
            List<String> q = get(query, no);
            List<String> b = matching(get(body, no), fields);
            List<String> p = get(resp, no);
            List<String> x = get(ext, no);
            System.out.println("[PROBE]   参数：Query 参数 " + q.size() + " · 请求体 "
                    + (fields.isEmpty() ? "" : "匹配 [" + fields + "] ") + b.size()
                    + " · 返回参数 " + p.size() + " · 配置参数 " + x.size()
                    + (!fields.isEmpty() && b.isEmpty() ? "  ← 没有的字段上游传不进来" : ""));
            if (!detail) {
                continue;
            }
            list("Query 参数", q, asked);
            list("请求体", b, asked);
            list("返回参数", p, asked);
            list("配置参数", x, asked);
        }
        System.out.println("[PROBE] --- 触发操作那一列就是这个 API 最终执行的单据操作：");
        System.out.println("[PROBE]     要让接口进来的数据也走某段逻辑，挂在该操作的操作插件上，");
        System.out.println("[PROBE]     比挂在某个 API 自己的序列化插件上覆盖面大（同一单据常有多个 API）。");
        System.out.println("[PROBE] 本探针只读，不做任何写入");
    }

    /** plugin 字段是 JSON 数组文本：ClassName / Enabled / Description */
    private static void dumpPlugins(String json) {
        if (json == null || json.trim().isEmpty()) {
            System.out.println("[PROBE]   插件：无");
            return;
        }
        try {
            JSONArray arr = JSONArray.parseArray(json);
            if (arr == null || arr.isEmpty()) {
                System.out.println("[PROBE]   插件：无");
                return;
            }
            for (int i = 0; i < arr.size(); i++) {
                JSONObject o = arr.getJSONObject(i);
                System.out.println("[PROBE]   插件 " + o.getString("ClassName")
                        + "  enabled=" + o.get("Enabled")
                        + "  " + emp(o.getString("Description")));
            }
        } catch (Exception e) {
            System.out.println("[PROBE]   插件（原文）=" + json);
        }
    }

    /**
     * 命中的所有接口的某一类参数，一次查回来按接口编码分组，每个参数排成一行。
     * 一个接口一次查询的话，按类名反查动辄上百个接口，要查几百次。
     */
    private static Map<String, List<String>> section(List<String> numbers, String entry, String cols) {
        Map<String, List<String>> out = new HashMap<>();
        if (numbers.isEmpty()) {
            return out;
        }
        String[] names = cols.split(",");
        StringBuilder sel = new StringBuilder("number");
        for (String c : names) {
            sel.append(',').append(entry).append('.').append(c);
        }
        DynamicObjectCollection rows;
        try {
            rows = QueryServiceHelper.query("openapi_apilist", sel.toString(),
                    new QFilter[]{new QFilter("number", QCP.in, numbers.toArray())},
                    "number," + entry + ".seq");
        } catch (Exception e) {
            System.out.println("[PROBE]   " + entry + " 查询失败：" + e.getMessage());
            return out;
        }
        for (DynamicObject r : rows) {
            String first = r.getString(entry + "." + names[0]);
            if (first == null || first.trim().isEmpty()) {
                continue;
            }
            //配置参数每个接口都带 maxsaveentrysize=0、ismulilang=false 这类默认项，只留有值的（真机 2026-09-28）
            if ("extentity".equals(entry)) {
                String v = r.getString(entry + ".ext_value");
                if (v == null || v.trim().isEmpty() || "0".equals(v.trim()) || "false".equals(v.trim())) {
                    continue;
                }
            }
            out.computeIfAbsent(r.getString("number"), k -> new ArrayList<>()).add(line(entry, r));
        }
        return out;
    }

    private static String line(String entry, DynamicObject r) {
        String e = entry + ".";
        switch (entry) {
            case "urlparamentryentity":
                return r.getString(e + "urlparamname") + "  类型=" + r.getString(e + "urlparamtype")
                        + "  必填=" + yes(r.getString(e + "urlparammust"));
            case "bodyentryentity":
                return r.getString(e + "paramname") + "  ->  " + emp(r.getString(e + "objpropname"))
                        + "  类型=" + r.getString(e + "paramtype") + "  必填=" + yes(r.getString(e + "must"))
                        + "  默认值=[" + emp(r.getString(e + "param_default_value")) + "]";
            case "respentryentity":
                String level = r.getString(e + "resp_level");
                return r.getString(e + "respparamname") + "  类型=" + r.getString(e + "respparamtype")
                        + "  必填=" + yes(r.getString(e + "respparammust"))
                        + (level == null || level.trim().isEmpty() ? "" : "  层级=" + level);
            default:
                return r.getString(e + "ext_key") + " = " + emp(r.getString(e + "ext_value"));
        }
    }

    private static List<String> get(Map<String, List<String>> map, String number) {
        List<String> v = map.get(number);
        return v == null ? new ArrayList<>() : v;
    }

    /** API_FIELDS：请求体只留参数名或对象属性里含关键字的 */
    private static List<String> matching(List<String> lines, String fields) {
        if (fields.isEmpty()) {
            return lines;
        }
        List<String> out = new ArrayList<>();
        for (String l : lines) {
            String head = l.contains("  类型=") ? l.substring(0, l.indexOf("  类型=")).toLowerCase() : l.toLowerCase();
            for (String k : fields.split(",")) {
                k = k.trim().toLowerCase();
                if (!k.isEmpty() && head.contains(k)) {
                    out.add(l);
                    break;
                }
            }
        }
        return out;
    }

    private static void list(String title, List<String> lines, boolean asked) {
        if (lines.isEmpty()) {
            return;
        }
        if (!asked && lines.size() > LIST_LIMIT) {
            System.out.println("[PROBE]   " + title + " " + lines.size() + " 个，多于 " + LIST_LIMIT
                    + " 个不列；API_NUMBER=<编码> 或 API_FIELDS=<关键字> 列出");
            return;
        }
        System.out.println("[PROBE]   " + title + "：");
        for (String l : lines) {
            System.out.println("[PROBE]     " + l);
        }
    }

    private static String yes(String v) {
        return "1".equals(v) ? "是" : "否";
    }

    private static String apiType(String v) {
        if ("0".equals(v)) { return "零代码配置"; }
        if ("1".equals(v)) { return "AI"; }
        if ("2".equals(v)) { return "Java插件"; }
        if ("3".equals(v)) { return "脚本开发"; }
        if ("4".equals(v)) { return "Servlet开发"; }
        return emp(v);
    }

    private static String method(String v) {
        if ("0".equals(v)) { return "GET"; }
        if ("1".equals(v)) { return "POST"; }
        if ("9".equals(v)) { return "ALL"; }
        return emp(v);
    }

    private static String status(String v) {
        if ("A".equals(v)) { return "内测"; }
        if ("B".equals(v)) { return "维护"; }
        if ("C".equals(v)) { return "发布"; }
        if ("D".equals(v)) { return "禁用"; }
        return emp(v);
    }

    private static String emp(String s) {
        return s == null || s.isEmpty() ? "(空)" : s;
    }

    private static void usage() {
        System.out.println("[PROBE] 缺参数 —— API_ENTITY / API_PLUGIN / API_NUMBER 至少给一个");
        System.out.println("[PROBE] 用法:");
        System.out.println("[PROBE]   API_ENTITY=<业务对象标识> node .claude/skills/long-cosmic-dev/driver.mjs probe ApiMetaProbe");
        System.out.println("[PROBE]   API_PLUGIN=<类名关键字> …   反查类挂在哪些 API 上");
        System.out.println("[PROBE]   API_NUMBER=<API编码[,…]> …      直接看某个 API");
        System.out.println("[PROBE]   加 API_FIELDS=<参数关键字[,…]> 请求体只列名字匹配的参数");
    }

    private static String env(String k, String def) {
        String v = System.getenv(k);
        return v == null || v.isEmpty() ? def : v;
    }
}
