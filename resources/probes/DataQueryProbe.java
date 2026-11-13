import java.math.BigDecimal;
import java.text.ParseException;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Date;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import kd.bos.dataentity.entity.DynamicObject;
import kd.bos.dataentity.entity.DynamicObjectCollection;
import kd.bos.dataentity.metadata.ICollectionProperty;
import kd.bos.dataentity.metadata.IComplexProperty;
import kd.bos.dataentity.metadata.IDataEntityProperty;
import kd.bos.dataentity.metadata.IDataEntityType;
import kd.bos.entity.EntityMetadataCache;
import kd.bos.entity.MainEntityType;
import kd.bos.entity.ValueMapItem;
import kd.bos.entity.property.ComboProp;
import kd.bos.orm.ORM;
import kd.bos.orm.query.QFilter;
import kd.bos.servicehelper.QueryServiceHelper;
import kd.bos.servicehelper.botp.BFTrackerServiceHelper;

/**
 * 只读：按条件查一张单据/基础资料里的现有数据，列出命中行的指定字段。
 *
 * 补 DataProbe 做不到的那一半：DataProbe 只回答「这张单有没有数据」（行数 + 一条样本），
 * 不能按条件查。以前按名称/编码/状态找记录只能写临时探针，而那一轮 JVM 常常烧在 KSQL
 * 细节上（select * 被拒、参数数组写法被预检误拦）。这里走 ORM（QueryServiceHelper）：
 * 字段写实体上的标识，不写表名列名，不拼 SQL。
 *
 *   QUERY_ENTITY=实体或布局标识     必填（给布局也行，MetaResolve 会换算）
 *   QUERY_WHERE=字段 运算符 值      可选，不给就不加条件；多条 ; 隔开（并且），一条里 | 隔开（或者）；运算符 = != > >= < <= like in is null 等；基础资料按编码查写 字段.number（下面有全部写法）；@上游 / @下游 / @流程 也能当条件（is null = 没有 / 不在流程，like %节点名%），先按其余条件取单再逐张判，最多判 500 张
 *       @上游 / @下游 后面接单据标识只看连着的这一类单：@下游.单据标识 is null（没有这类下游）；@下游.单据标识.字段 运算符 值（这类下游里有一张满足就算，字段写法同普通条件，如 @下游.demo_test_bill.billstatus = A）；@下游.单据标识.@流程 like %节点名%
 *   QUERY_FIELDS=字段1,字段2        可选，要打印的字段；不给 = id、编码/单据编号、名称、状态 + 条件里用到的字段；另可写 @上游、@下游（单据转换关系连着的单据）、@流程（在不在审批流，照平台审核前的判断、发起任务还没处理完的算「发起中」；当前节点、待办人和电话、能否撤回、上次谁处理）
 *       @上游 / @下游 后面同样能接单据标识：@下游.单据标识（这类下游是哪几张）、@下游.单据标识.字段（每张一项「编号=值」）、@下游.单据标识.@流程（每张的流程状态）
 *   QUERY_ORDER=字段 desc,字段      可选，默认 id desc
 *   QUERY_LIMIT=20                 可选，最多列几行，1~200，默认 20
 *
 * 条件写法：
 *   一条条件 = 字段 运算符 值。多条用 ; 隔开，是「并且」；一条里用 | 隔开几种写法，是「或者」。
 *   运算符：= != <> > >= < <= like、not like、in、not in、is null、is not null。
 *   值不加引号、in 的值不加括号（带了就报错中止，不会照着查出 0 条）；like 的 % 自己写。
 *   例：QUERY_WHERE=billno in 0001,0002,0003（每个编号不加引号，清单不加括号）。
 *   字段可以带路径：分录.字段、基础资料字段.number / .name。
 *   基础资料字段本身按 id 比，按编码/名称查要写 字段.number / 字段.name。
 *   例：QUERY_WHERE=billstatus = C; zlgd_basejylx.number like JYLX_0101% | zlgd_basejylx.name like %拉伸%
 *
 * 值按字段类型转（整数、小数、布尔、日期 yyyy-MM-dd 或 yyyy-MM-dd HH:mm:ss），转不动就报错，
 * 不拿文本去硬比。入参问题一次列全后以失败退出，一条都不查。
 * 字段或条件里有分录字段时是扁平行：每条分录一行，表头字段会重复。
 * 口令类字段（password / pwd / secret / token / salt）不查也不打印：输出会进模型上下文和 build/ 日志。
 * 命中 0 条时逐条报每个条件单独命中几条、去掉它命中几条，单独命中 0 条的再列这个字段现有的几个值。
 * 下拉字段（单据状态也是）照库里存的代码打，第一行数据前另给一行全部选项「代码=显示名」。
 * 全程只读：查询、计数、单据转换关系和工作流的查询方法，不写任何东西。
 *
 * 为什么有 @上游 / @下游 / @流程（S37 批 7）：找测试样本时要问的常常是「没有下游的已审核委托单」
 * 「停在某个审批节点、还能撤回的检测单」，字段条件表达不了。46 份真机会话里为此写了 31 个临时探针
 *（WfStateProbe、BillFlowStateProbe、WtdLinkProbe 改了 5 版……），这类问题现在一次查询答完。
 *
 * @下游.单据标识.字段（S48）：要的样本常是「下游检测单还是暂存的委托单」「下游检测单在审批中的委托单」，
 * 原来 @下游 只给一串文本，状态只能 like 文本里的 [A]，还分不清是哪类下游的；模型改成先查下游单、再逐张回查上游
 *（09-27 复测连查 13 次）。现在条件和列都能落到连着的某一类单的字段、流程上，一批连着的单合起来查一次。
 */
public class DataQueryProbe {

    private static final int DEFAULT_LIMIT = 20;
    private static final int MAX_LIMIT = 200;
    private static final int MAX_VALUE_CHARS = 200;
    /** 带 @ 条件时最多逐张判几张：每张要查一次转换关系，再多就慢了。 */
    private static final int SCAN_CAP = 500;
    private static final List<String> PSEUDO = Arrays.asList("@上游", "@下游", "@流程");

    /** 本次调用已经整张列过字段的层，别在每个认不出的字段后面重复一遍。常驻进程里可能并发，按线程各记各的。 */
    private static final ThreadLocal<Set<String>> LISTED = new ThreadLocal<Set<String>>();

    private static final Pattern PATH = Pattern.compile("[A-Za-z_][A-Za-z0-9_]*(\\.[A-Za-z_][A-Za-z0-9_]*)*");
    private static final Pattern SECRET = Pattern.compile("(?i).*(password|passwd|pwd|secret|token|salt).*");
    /** 词运算符前后必须有空白：`fieldin x` 是写错了，不能拆成 field in x。 */
    private static final Pattern CLAUSE = Pattern.compile(
            "^\\s*(@[^\\s=<>!]+|[A-Za-z_][A-Za-z0-9_.]*)"
                    + "(?:\\s+(is\\s+not\\s+null|is\\s+null|not\\s+like|like|not\\s+in|in)(?=\\s|$)"
                    + "|\\s*(!=|<>|>=|<=|=|>|<))"
                    + "\\s*(.*?)\\s*$",
            Pattern.CASE_INSENSITIVE);
    private static final Pattern ORDER = Pattern.compile(
            "\\s*[A-Za-z_][A-Za-z0-9_.]*(\\s+(?i:asc|desc))?\\s*(,\\s*[A-Za-z_][A-Za-z0-9_.]*(\\s+(?i:asc|desc))?\\s*)*");

    public static void run() {
        //常驻进程里类会被重复用，每次调用从空开始
        LISTED.set(new LinkedHashSet<String>());
        MainEntityType t = MetaResolve.type(req("QUERY_ENTITY"));
        String entity = t.getName();
        List<String> problems = new ArrayList<String>();
        List<String> used = new ArrayList<String>();
        boolean[] flat = {false};

        int limit = limit(env("QUERY_LIMIT", ""), problems);
        List<String> texts = new ArrayList<String>();
        List<Pseudo> pseudos = new ArrayList<Pseudo>();
        List<QFilter> filters = where(t, env("QUERY_WHERE", ""), used, flat, problems, texts, pseudos);
        List<String> fields = fields(t, env("QUERY_FIELDS", ""), used, flat, problems);
        String order = env("QUERY_ORDER", "").trim();
        if (order.isEmpty()) {
            order = "id desc";
        } else if (!ORDER.matcher(order).matches()) {
            problems.add("QUERY_ORDER 要写成「字段 desc,字段 asc」，给的是「" + order + "」");
        }

        System.out.println("[PROBE] 实体 " + entity + "  " + t.getDisplayName() + "  主表=" + t.getAlias());
        if (!problems.isEmpty()) {
            for (String p : problems) {
                System.out.println("[PROBE] ✗ " + p);
            }
            throw new IllegalArgumentException("QUERY_* 入参有 " + problems.size() + " 处问题（见上方 ✗ 行），一条都没查");
        }
        List<String> shownConds = new ArrayList<String>();
        if (!filters.isEmpty()) {
            shownConds.add(describe(filters.toArray(new QFilter[0])));
        }
        //条件落在连着的那类单的字段上：先在那类单上查出满足的，再按转换关系一次反查回本单，当普通的 id 条件用，
        //不用逐张判；做不到的（流程条件、那类单满足的太多）留给逐张判
        List<Pseudo> rest = new ArrayList<Pseudo>();
        for (Pseudo p : pseudos) {
            QFilter allowed = reach(t, p);
            if (allowed == null) {
                rest.add(p);
                continue;
            }
            filters.add(allowed);
            texts.add(p.text + "（" + p.reached + "）");
            shownConds.add(p.text + "（" + p.reached + "）");
        }
        if (!rest.isEmpty()) {
            shownConds.add(pseudoText(rest));
        }
        QFilter[] qfs = filters.toArray(new QFilter[0]);
        System.out.println("[PROBE] 条件：" + (shownConds.isEmpty() ? "（无）" : String.join("  并且  ", shownConds)));
        System.out.println("[PROBE] 字段：" + String.join(", ", fields) + "   排序：" + order);
        if (flat[0]) {
            System.out.println("[PROBE] 注意：字段或条件里有分录/多选字段，下面是扁平行——每条分录一行，表头字段会重复");
        }

        //@ 列不是库里的字段：查询只带真字段，id 总要带上，@ 列按单据 id 另算
        List<String> real = new ArrayList<String>();
        Set<String> kinds = new LinkedHashSet<String>();
        for (String f : fields) {
            if (isPseudo(f)) {
                kinds.add(f);
            } else {
                real.add(f);
            }
        }
        for (Pseudo p : pseudos) {
            //条件落在连着的单的字段、流程上的，只要「有没有一张满足」，不用算整列
            if (!p.exists) {
                kinds.add(p.name);
            }
        }
        if (!real.contains("id")) {
            real.add("id");
        }

        QFilter[] query = qfs;
        Scan scan = null;
        if (!rest.isEmpty()) {
            scan = scan(t, qfs, order, rest, limit);
            if (scan.matched.isEmpty()) {
                System.out.println("[PROBE] 命中 0 条。" + scan.report(rest));
                if (scan.candidates == 0) {
                    System.out.println("[PROBE] " + emptiness(entity, qfs, texts));
                }
                System.out.println("[PROBE] 只读结束，未做任何写入");
                return;
            }
            List<QFilter> narrowed = new ArrayList<QFilter>(Arrays.asList(qfs));
            //不全列：查库的条数上限，QUERY_LIMIT 可调，超了返回里说
            narrowed.add(new QFilter("id", "in", scan.matched.subList(0, Math.min(limit, scan.matched.size()))));
            query = narrowed.toArray(new QFilter[0]);
        }

        DynamicObjectCollection rows;
        try {
            //多取一行：只为知道「是不是还有」，不去数全表。带 @ 条件时单据已经挑好，分录行全取
            rows = QueryServiceHelper.query(entity, String.join(",", real), query, order,
                    scan == null ? limit + 1 : MAX_LIMIT * 10);
        } catch (RuntimeException e) {
            System.out.println("[PROBE] ✗ 查询失败：" + firstSentence(String.valueOf(e.getMessage())));
            List<String> unknown = unknownFields(t, used, fields);
            if (!unknown.isEmpty()) {
                //字段名写错是入参问题，不是环境坏了：按入参错退出，换个字段名重试不算「同一失败」
                for (String f : unknown) {
                    System.out.println("[PROBE]   " + f + " 不是这张单上的字段；相近的：" + near(t, f));
                }
                throw new IllegalArgumentException("QUERY_* 里有 " + unknown.size() + " 个字段元数据里没有："
                        + unknown + "（见上方相近字段），一条都没查到");
            }
            //元数据里有、库里没有列的属性 ORM 查不了，同样是入参问题（真机 2026-09-27：openapi_apilist 的
            //fullurlformat、hiddenplugin 各试一次，都按普通失败退出，第三次改对的查询被当成「同一失败」拦下）
            String noColumn = noSuchProperty(e);
            if (noColumn != null) {
                System.out.println("[PROBE]   " + noColumn + " 在元数据里有，但没有数据库字段，查不了");
                throw new IllegalArgumentException("QUERY_* 里的 " + noColumn + " 没有数据库字段，一条都没查到");
            }
            System.out.println("[PROBE]   字段标识不确定时先用 MetaProbe 看这张单的字段");
            throw e;
        }

        int shown = scan == null ? Math.min(limit, rows.size()) : rows.size();
        //@ 列只给列出来的这几行算：逐张判时只算条件要的，不为没列出来的单查转换关系
        Map<Long, Map<String, Val>> values = new HashMap<Long, Map<String, Val>>();
        if (!kinds.isEmpty()) {
            List<Long> ids = new ArrayList<Long>();
            for (int i = 0; i < shown; i++) {
                Long id = rows.get(i).getLong("id");
                if (!ids.contains(id)) {
                    ids.add(id);
                }
            }
            values = pseudoValues(t, ids, kinds, new ArrayList<Pseudo>());
        }
        if (shown > 0) {
            comboLegends(t, fields);
        }
        for (int i = 0; i < shown; i++) {
            DynamicObject row = rows.get(i);
            StringBuilder sb = new StringBuilder("[PROBE] #").append(i + 1).append("  ");
            for (int k = 0; k < fields.size(); k++) {
                if (k > 0) {
                    sb.append(" | ");
                }
                String f = fields.get(k);
                Object v;
                if (isPseudo(f)) {
                    Map<String, Val> of = values.get(row.getLong("id"));
                    v = of == null || of.get(f) == null ? "?" : of.get(f).text;
                } else {
                    v = value(row, f);
                }
                sb.append(f).append('=').append(render(v));
            }
            System.out.println(sb);
        }

        if (scan != null) {
            System.out.println("[PROBE] " + scan.report(rest));
        } else if (rows.isEmpty()) {
            //「命中 0 条」以前只说「不带条件共 N 条，是条件没命中」，再附一句常见原因，模型分不清是哪条没命中、
            //还是真没有这样的数据，只好换写法再查（46 份真机会话 35 次 0 条，18 次紧跟着换写法重查）。
            //现在逐条报单独命中几条、去掉它命中几条：是哪条条件卡住的、数据到底有没有，一次说清
            System.out.println("[PROBE] 命中 0 条。" + emptiness(entity, qfs, texts));
        } else if (rows.size() > limit) {
            System.out.println("[PROBE] 超过 " + limit + " 条，只列了前 " + limit + " 条（加大 QUERY_LIMIT 或收紧条件）"
                    + total(entity, qfs, flat[0]));
        } else {
            System.out.println("[PROBE] 命中 " + rows.size() + (flat[0] ? " 行" : " 条"));
        }
        System.out.println("[PROBE] 只读结束，未做任何写入");
    }

    /** 总数只在单据口径明确时才数：条件或字段碰到分录时，一张单算几条说不清，干脆不报。 */
    private static String total(String entity, QFilter[] qfs, boolean flat) {
        if (flat) {
            return "";
        }
        try {
            return "；按条件共 " + ORM.create().count("DataQueryProbe", entity, qfs) + " 条";
        } catch (RuntimeException e) {
            return "；总数没数出来（" + oneLine(String.valueOf(e.getMessage())) + "）";
        }
    }

    private static long count(String entity, QFilter[] qfs) {
        return ORM.create().count("DataQueryProbe", entity, qfs);
    }

    /**
     * 命中 0 条时说清是哪条卡住的：先看这张单本来有没有数据，再逐条报「单独命中几条」「去掉它命中几条」，
     * 单独命中 0 条的那条再列这个字段现有的几个值——值的写法对不上（少了 %、编码写成名称）一眼看得出来。
     */
    private static String emptiness(String entity, QFilter[] qfs, List<String> texts) {
        if (qfs.length == 0) {
            return "没加条件都是 0 条 —— 这张单本来就没有数据";
        }
        long all;
        try {
            all = count(entity, new QFilter[0]);
        } catch (RuntimeException e) {
            return "不带条件的总数也没数出来（" + oneLine(String.valueOf(e.getMessage()))
                    + "），先确认这张单本来有没有数据：DataProbe DATA_ENTITY=" + entity;
        }
        if (all == 0) {
            return "不带条件也是 0 条 —— 这张单一条数据都没有，不是条件的问题";
        }
        StringBuilder sb = new StringBuilder("不带条件共 " + all + " 条，逐条看：");
        boolean each = true;
        for (int i = 0; i < qfs.length; i++) {
            String text = i < texts.size() ? texts.get(i) : oneLine(qfs[i].toString());
            sb.append("\n[PROBE]   ").append(i + 1).append(") ").append(text).append("：");
            try {
                long alone = count(entity, new QFilter[]{qfs[i]});
                sb.append("单独命中 ").append(alone).append(" 条");
                if (qfs.length > 1) {
                    List<QFilter> rest = new ArrayList<QFilter>(Arrays.asList(qfs));
                    rest.remove(i);
                    sb.append("，去掉它命中 ").append(count(entity, rest.toArray(new QFilter[0]))).append(" 条");
                }
                if (alone == 0) {
                    each = false;
                    //连着的单上的条件已换成 id 条件，原文里写了两头各几张，不再列 id 的现有值
                    if (i >= texts.size() || !texts.get(i).startsWith("@")) {
                        sb.append("；").append(existing(entity, qfs[i].getProperty()));
                    }
                }
            } catch (RuntimeException e) {
                sb.append("没数出来（").append(firstSentence(String.valueOf(e.getMessage()))).append("）");
            }
        }
        if (each && qfs.length > 1) {
            sb.append("\n[PROBE]   每条单独都有命中，合在一起没有 —— 同时满足这几条的数据不存在");
        }
        return sb.toString();
    }

    /** 这个字段现有的几个不同的值（取最近 200 行），给「单独命中 0 条」的条件对照写法；下拉字段附上全部选项。 */
    private static String existing(String entity, String field) {
        try {
            Set<String> seen = new LinkedHashSet<String>();
            for (DynamicObject row : QueryServiceHelper.query(entity, field, new QFilter[0], "id desc", 200)) {
                seen.add(render(value(row, field)));
                if (seen.size() >= 6) {
                    break;
                }
            }
            ComboProp combo = comboAt(EntityMetadataCache.getDataEntityType(entity), field);
            String items = combo == null ? "" : "（下拉：" + comboItems(combo) + "）";
            return seen.isEmpty() ? field + " 最近 200 行都没有值" + items
                    : field + " 最近的值有：" + String.join("、", seen) + items;
        } catch (RuntimeException e) {
            return field + " 现有的值没取出来（" + firstSentence(String.valueOf(e.getMessage())) + "）";
        }
    }

    /** 一条 @ 条件：@上游 / @下游 / @流程 的算出来的文本，按 op 比。 */
    private static final class Pseudo {
        String name;
        String op;
        String value;
        String text;
        /** 逐张判时单独满足它的张数。 */
        int hits;
        /** @上游 / @下游 后面接了单据标识的，只看连着的这一类单。 */
        Linked link;
        /** 条件落在连着的那类单的字段上：按那类单的字段条件查。 */
        QFilter where;
        /** 条件落在连着的单的字段或流程上：有一张连着的单满足就算。 */
        boolean exists;
        /** 先查连着的那类单、再反查回本单时，两头各几张。 */
        String reached;

        boolean test(Val v) {
            return exists ? v.present : match(v);
        }

        boolean match(Val v) {
            if (op.equals("is null")) {
                return !v.present;
            }
            if (op.equals("is not null")) {
                return v.present;
            }
            boolean like = op.endsWith("like");
            boolean hit = like ? likeMatch(v.text, value) : v.text.equals(value);
            return op.startsWith("not") || op.equals("!=") ? !hit : hit;
        }
    }

    private static boolean likeMatch(String text, String pattern) {
        StringBuilder re = new StringBuilder("(?is)");
        for (char c : pattern.toCharArray()) {
            re.append(c == '%' ? ".*" : c == '_' ? "." : Pattern.quote(String.valueOf(c)));
        }
        return text.matches(re.toString());
    }

    private static String pseudoText(List<Pseudo> pseudos) {
        List<String> out = new ArrayList<String>();
        for (Pseudo p : pseudos) {
            out.add(p.text + "（逐张判）");
        }
        return String.join("  并且  ", out);
    }

    /** @ 列算出来的值：present 为 false 表示没有连着的单据 / 不在流程里。 */
    private static final class Val {
        final boolean present;
        final String text;

        Val(boolean present, String text) {
            this.present = present;
            this.text = text;
        }
    }

    /** 逐张判 @ 条件的结果。 */
    private static final class Scan {
        long candidates;
        int judged;
        int satisfied;
        boolean capped;
        List<Long> matched = new ArrayList<Long>();

        String report(List<Pseudo> pseudos) {
            StringBuilder sb = new StringBuilder("其余条件命中 " + candidates + " 张，逐张判了 " + judged + " 张，")
                    .append(matched.isEmpty() ? "都不满足"
                            : "满足的 " + satisfied + " 张" + (satisfied > matched.size() ? "，列出前 " + matched.size() + " 张" : "")
                                    + (judged < Math.min(candidates, SCAN_CAP) ? "（够 QUERY_LIMIT 就停，后面没判）" : ""));
            if (pseudos.size() > 1) {
                for (Pseudo p : pseudos) {
                    sb.append("；").append(p.text).append(" 单独满足 ").append(p.hits).append(" 张");
                }
            }
            if (capped) {
                sb.append("；只判了排在前面的 ").append(SCAN_CAP).append(" 张，后面没看，收紧其余条件能判到");
            }
            return sb.toString();
        }
    }

    /** 按其余条件取候选单据（去重、保序），分批算 @ 值逐张判，凑够 limit 张就停。 */
    private static Scan scan(MainEntityType t, QFilter[] qfs, String order, List<Pseudo> pseudos, int limit) {
        Scan s = new Scan();
        Set<String> kinds = new LinkedHashSet<String>();
        for (Pseudo p : pseudos) {
            if (!p.exists) {
                kinds.add(p.name);
            }
        }
        String entity = t.getName();
        List<Long> ids = new ArrayList<Long>();
        for (DynamicObject row : QueryServiceHelper.query(entity, "id", qfs, order, SCAN_CAP * 20)) {
            Long id = row.getLong("id");
            if (!ids.contains(id)) {
                ids.add(id);
            }
            if (ids.size() > SCAN_CAP) {
                break;
            }
        }
        s.candidates = ids.size() > SCAN_CAP ? safeCount(entity, qfs, ids.size()) : ids.size();
        s.capped = ids.size() > SCAN_CAP;
        //不全列：逐张判伪字段要一张张读库，扫描量有上限，超了返回里说
        List<Long> todo = ids.subList(0, Math.min(SCAN_CAP, ids.size()));
        for (int from = 0; from < todo.size() && s.matched.size() < limit; from += 50) {
            List<Long> chunk = new ArrayList<Long>(todo.subList(from, Math.min(from + 50, todo.size())));
            Map<Long, Map<String, Val>> got = pseudoValues(t, chunk, kinds, pseudos);
            for (Long id : chunk) {
                s.judged++;
                boolean all = true;
                for (Pseudo p : pseudos) {
                    if (p.test(got.get(id).get(p.exists ? p.text : p.name))) {
                        p.hits++;
                    } else {
                        all = false;
                    }
                }
                if (all) {
                    s.satisfied++;
                }
                if (all && s.matched.size() < limit) {
                    s.matched.add(id);
                }
            }
        }
        if (s.matched.size() < limit) {
            s.capped &= s.judged >= SCAN_CAP;
        } else {
            s.capped = false;
        }
        return s;
    }

    private static long safeCount(String entity, QFilter[] qfs, long fallback) {
        try {
            return count(entity, qfs);
        } catch (RuntimeException e) {
            return fallback;
        }
    }

    /**
     * 一批单据的 @ 值：转换关系每张单查一次（按一组 id 查会并在一起，分不出谁连着谁），流程整批查；
     * 只看某一类连着的单（@下游.单据标识…）时，这一批连着的那类单合起来查一次。
     * 条件落在连着的单上的（exists），按条件原文记一个「有没有一张满足」。
     */
    private static Map<Long, Map<String, Val>> pseudoValues(MainEntityType t, List<Long> ids, Set<String> kinds,
            List<Pseudo> pseudos) {
        Map<Long, Map<String, Val>> out = new LinkedHashMap<Long, Map<String, Val>>();
        for (Long id : ids) {
            out.put(id, new HashMap<String, Val>());
        }
        boolean up = false;
        boolean down = false;
        for (String k : kinds) {
            up |= k.startsWith("@上游");
            down |= k.startsWith("@下游");
        }
        for (Pseudo p : pseudos) {
            if (p.exists) {
                up |= p.link.up;
                down |= !p.link.up;
            }
        }
        Map<Long, Links> ups = up ? links(t.getName(), ids, true) : null;
        Map<Long, Links> downs = down ? links(t.getName(), ids, false) : null;
        for (String k : kinds) {
            Map<Long, Val> per;
            if (k.equals("@流程")) {
                per = flows(t, ids);
            } else if (k.equals("@上游") || k.equals("@下游")) {
                per = new HashMap<Long, Val>();
                for (Long id : ids) {
                    per.put(id, allLinked((k.equals("@上游") ? ups : downs).get(id)));
                }
            } else {
                Linked l = linked(k, new ArrayList<String>());
                per = linkedValues(l, ids, l.up ? ups : downs);
            }
            for (Long id : ids) {
                out.get(id).put(k, per.get(id));
            }
        }
        for (Pseudo p : pseudos) {
            if (!p.exists) {
                continue;
            }
            Set<Long> hit = exists(p, ids, p.link.up ? ups : downs);
            for (Long id : ids) {
                out.get(id).put(p.text, new Val(hit.contains(id), ""));
            }
        }
        return out;
    }

    /** 一张单连着的单据：单据标识 → 内码；转换关系查不出时 error 是原因。 */
    private static final class Links {
        final Map<String, Set<Long>> byEntity = new LinkedHashMap<String, Set<Long>>();
        String error;

        Set<Long> of(String entity) {
            Set<Long> s = byEntity.get(entity);
            return s == null ? new HashSet<Long>() : s;
        }
    }

    private static Map<Long, Links> links(String entity, List<Long> ids, boolean up) {
        Map<Long, Links> out = new HashMap<Long, Links>();
        for (Long id : ids) {
            Links l = new Links();
            try {
                Map<String, HashSet<Long>> m = up ? BFTrackerServiceHelper.findSourceBills(entity, new Long[]{id})
                        : BFTrackerServiceHelper.findTargetBills(entity, new Long[]{id});
                if (m != null) {
                    for (Map.Entry<String, HashSet<Long>> e : m.entrySet()) {
                        if (e.getValue() != null && !e.getValue().isEmpty()) {
                            l.byEntity.put(e.getKey(), e.getValue());
                        }
                    }
                }
            } catch (RuntimeException e) {
                l.error = firstSentence(String.valueOf(e.getMessage()));
            }
            out.put(id, l);
        }
        return out;
    }

    /** 连着的全部单据按单据类型分组：「检验委托单 demo_qty_wtd：WTD-001[C]、WTD-002[B]」。 */
    private static Val allLinked(Links l) {
        if (l.error != null) {
            return new Val(false, "查不出（" + l.error + "）");
        }
        List<String> parts = new ArrayList<String>();
        for (Map.Entry<String, Set<Long>> e : l.byEntity.entrySet()) {
            parts.add(linked(e.getKey(), e.getValue()));
        }
        return parts.isEmpty() ? new Val(false, "无") : new Val(true, String.join("；", parts));
    }

    /** @上游 / @下游 后面接了单据标识：只看连着的这一类单，还可以再接它上面的字段或 @流程。 */
    private static final class Linked {
        boolean up;
        MainEntityType type;
        /** null：有没有、是哪几张；@流程：每张的流程状态；其余：每张单上这个字段的值。 */
        String sub;
    }

    /** 「@下游.单据标识[.字段|.@流程]」；不是这个写法返回 null，是这个写法但认不出的记进 problems 也返回 null。 */
    private static Linked linked(String name, List<String> problems) {
        boolean up = name.startsWith("@上游.");
        if (!up && !name.startsWith("@下游.")) {
            return null;
        }
        String rest = name.substring("@上游.".length());
        int dot = rest.indexOf('.');
        String entity = dot < 0 ? rest : rest.substring(0, dot);
        Linked l = new Linked();
        l.up = up;
        l.sub = dot < 0 ? null : rest.substring(dot + 1);
        try {
            l.type = EntityMetadataCache.getDataEntityType(entity);
        } catch (RuntimeException e) {
            l.type = null;
        }
        if (l.type == null) {
            problems.add(name + "：没有单据 " + entity + "（" + name.substring(0, 3) + " 后面接连着的那类单的标识）");
            return null;
        }
        if (l.sub != null && !l.sub.equals("@流程")
                && (!PATH.matcher(l.sub).matches() || resolve(l.type, l.sub).prop == null)) {
            problems.add(name + "：" + entity + " 上没有字段 " + l.sub + "；相近的：" + near(l.type, l.sub));
            return null;
        }
        return l;
    }

    /** @上游 / @下游 或者它们后面接了单据标识的写法。 */
    private static boolean isPseudo(String f) {
        return PSEUDO.contains(f) || f.startsWith("@上游.") || f.startsWith("@下游.");
    }

    /**
     * @下游.单据标识[.字段|.@流程] 列：这一批单连着的那类单合起来查一次，再分回每张。
     * 字段列每张连着的单一项「编号=值」，最多列 10 张。
     */
    private static Map<Long, Val> linkedValues(Linked l, List<Long> ids, Map<Long, Links> m) {
        String entity = l.type.getName();
        Set<Long> all = new LinkedHashSet<Long>();
        for (Long id : ids) {
            all.addAll(m.get(id).of(entity));
        }
        Map<Long, List<String>> each = new HashMap<Long, List<String>>();
        if (l.sub != null && !all.isEmpty()) {
            String no = numberField(l.type);
            if (l.sub.equals("@流程")) {
                Map<Long, Val> fl = flows(l.type, new ArrayList<Long>(all));
                for (DynamicObject r : QueryServiceHelper.query(entity, "id," + no,
                        new QFilter[]{new QFilter("id", "in", new ArrayList<Long>(all))})) {
                    Val v = fl.get(r.getLong("id"));
                    add(each, r.getLong("id"), r.getString(no) + "=" + (v == null ? "?" : v.text));
                }
            } else {
                String select = "id," + no + (l.sub.equals(no) || l.sub.equals("id") ? "" : "," + l.sub);
                for (DynamicObject r : QueryServiceHelper.query(entity, select,
                        new QFilter[]{new QFilter("id", "in", new ArrayList<Long>(all))})) {
                    //要的就是编号，不再写成「编号=编号」
                    add(each, r.getLong("id"), l.sub.equals(no) ? r.getString(no)
                            : r.getString(no) + "=" + render(value(r, l.sub)));
                }
            }
        }
        Map<Long, Val> out = new HashMap<Long, Val>();
        for (Long id : ids) {
            Links k = m.get(id);
            Set<Long> mine = k.of(entity);
            if (k.error != null) {
                out.put(id, new Val(false, "查不出（" + k.error + "）"));
            } else if (mine.isEmpty()) {
                out.put(id, new Val(false, "无"));
            } else if (l.sub == null) {
                out.put(id, new Val(true, linked(entity, mine)));
            } else {
                List<String> parts = new ArrayList<String>();
                for (Long x : mine) {
                    if (parts.size() >= 10) {
                        break;
                    }
                    List<String> v = each.get(x);
                    parts.add(v == null ? x + "=（关系还在、单据已删）" : String.join("、", v));
                }
                out.put(id, new Val(true, String.join("；", parts) + (mine.size() > 10 ? " …共 " + mine.size() + " 张" : "")));
            }
        }
        return out;
    }

    private static void add(Map<Long, List<String>> each, Long id, String text) {
        List<String> v = each.get(id);
        if (v == null) {
            v = new ArrayList<String>();
            each.put(id, v);
        }
        //分录字段一张单出好几行，同样的值只记一次
        if (!v.contains(text)) {
            v.add(text);
        }
    }

    /** 连着的那类单满足字段条件的超过这么多张，就不反查了，改逐张判。 */
    private static final int REACH_CAP = 5000;

    /**
     * 条件落在连着的那类单上：字段条件先在那类单上查出满足的，只问有没有的取那类单全部，再按转换关系一次反查回本单
     *（多层都算，和 @下游 列一样），换成本单的 id 条件（没有这类单的是 not in）。
     * 流程条件、那类单超过上限、反查失败，返回 null，留给逐张判。
     * 只问有没有原来也逐张判：真机 624 张委托单不带别的条件查「有下游检测单」，超过 120 秒被掐掉。
     */
    private static QFilter reach(MainEntityType t, Pseudo p) {
        //只问有没有这类单（@下游.单据 is null / is not null）：那类单全部反查一次，不用逐张判
        boolean any = p.link != null && p.link.sub == null && (p.op.equals("is null") || p.op.equals("is not null"));
        if (!any && (!p.exists || p.where == null)) {
            return null;
        }
        String entity = p.link.type.getName();
        Set<Long> hit = new LinkedHashSet<Long>();
        try {
            QFilter[] on = any ? new QFilter[0] : new QFilter[]{p.where};
            for (DynamicObject r : QueryServiceHelper.query(entity, "id", on, "id desc", REACH_CAP * 20)) {
                hit.add(r.getLong("id"));
                if (hit.size() > REACH_CAP) {
                    return null;
                }
            }
            List<Long> out = new ArrayList<Long>();
            if (!hit.isEmpty()) {
                Long[] ids = hit.toArray(new Long[0]);
                Map<String, HashSet<Long>> m = p.link.up ? BFTrackerServiceHelper.findTargetBills(entity, ids)
                        : BFTrackerServiceHelper.findSourceBills(entity, ids);
                HashSet<Long> mine = m == null ? null : m.get(t.getName());
                if (mine != null) {
                    out.addAll(mine);
                }
            }
            boolean none = any && p.op.equals("is null");
            p.reached = p.link.type.getDisplayName() + (any ? " 共 " : " 上满足的 ") + hit.size() + " 张，按转换关系连着本单的 "
                    + out.size() + " 张" + (none ? "，取其余的" : "");
            List<Long> ids = out.isEmpty() ? Arrays.asList(0L) : out;
            return new QFilter("id", none ? "not in" : "in", ids);
        } catch (RuntimeException e) {
            System.out.println("[PROBE]   「" + p.text + "」先查连着的单再反查没成（" + firstSentence(String.valueOf(e.getMessage()))
                    + "），改逐张判");
            return null;
        }
    }

    /** 条件落在连着的单上：这一批里哪些单有一张连着的那类单满足它。 */
    private static Set<Long> exists(Pseudo p, List<Long> ids, Map<Long, Links> m) {
        String entity = p.link.type.getName();
        Set<Long> all = new LinkedHashSet<Long>();
        for (Long id : ids) {
            all.addAll(m.get(id).of(entity));
        }
        Set<Long> ok = new HashSet<Long>();
        if (!all.isEmpty()) {
            if ("@流程".equals(p.link.sub)) {
                Map<Long, Val> fl = flows(p.link.type, new ArrayList<Long>(all));
                for (Long x : all) {
                    Val v = fl.get(x);
                    if (v != null && p.match(v)) {
                        ok.add(x);
                    }
                }
            } else {
                for (DynamicObject r : QueryServiceHelper.query(entity, "id",
                        new QFilter[]{new QFilter("id", "in", new ArrayList<Long>(all)), p.where})) {
                    ok.add(r.getLong("id"));
                }
            }
        }
        Set<Long> out = new HashSet<Long>();
        for (Long id : ids) {
            for (Long x : m.get(id).of(entity)) {
                if (ok.contains(x)) {
                    out.add(id);
                    break;
                }
            }
        }
        return out;
    }

    private static final Map<String, String[]> LINKED_FIELDS = new HashMap<String, String[]>();

    /** 单据编号字段：billno，没有就 number，再没有就 id。 */
    private static String numberField(IDataEntityType type) {
        return type.getProperties().containsKey("billno") ? "billno"
                : type.getProperties().containsKey("number") ? "number" : "id";
    }

    private static String linked(String entity, Set<Long> ids) {
        String[] f = LINKED_FIELDS.get(entity);
        String label = entity;
        if (f == null) {
            IDataEntityType type = EntityMetadataCache.getDataEntityType(entity);
            String no = numberField(type);
            String status = type.getProperties().containsKey("billstatus") ? "billstatus" : "";
            f = new String[]{no, status, String.valueOf(type.getDisplayName())};
            LINKED_FIELDS.put(entity, f);
        }
        label = f[2] + " " + entity;
        List<String> shown = new ArrayList<String>();
        int found = 0;
        for (DynamicObject row : QueryServiceHelper.query(entity, "id," + f[0] + (f[1].isEmpty() ? "" : "," + f[1]),
                new QFilter[]{new QFilter("id", "in", new ArrayList<Long>(ids))}, "id", 11)) {
            found++;
            if (shown.size() < 10) {
                shown.add(row.getString(f[0]) + (f[1].isEmpty() ? "" : "[" + row.getString(f[1]) + "]"));
            }
        }
        String more = ids.size() > 10 && found > 10 ? " …共 " + ids.size() + " 张" : "";
        String gone = found < Math.min(ids.size(), 11) ? "（另有 " + (ids.size() - found) + " 张关系还在、单据已删）" : "";
        return label + "：" + (shown.isEmpty() ? "" : String.join("、", shown)) + more + gone;
    }

    /** 流程状态整批查，交给 WfState（落库的运行报流程状态也用它）：平台判在流程中、执行表里还没有的，是发起任务还没处理完。 */
    private static Map<Long, Val> flows(MainEntityType t, List<Long> ids) {
        Map<Long, Val> out = new HashMap<Long, Val>();
        for (Map.Entry<Long, WfState.Flow> e : WfState.of(t, ids).entrySet()) {
            out.put(e.getKey(), new Val(e.getValue().inFlow, e.getValue().text));
        }
        return out;
    }

    private static int limit(String raw, List<String> problems) {
        if (raw.trim().isEmpty()) {
            return DEFAULT_LIMIT;
        }
        try {
            int n = Integer.parseInt(raw.trim());
            if (n >= 1 && n <= MAX_LIMIT) {
                return n;
            }
        } catch (NumberFormatException ignored) {
            // 落到下面统一报
        }
        problems.add("QUERY_LIMIT 要 1~" + MAX_LIMIT + " 的整数，给的是「" + raw + "」");
        return DEFAULT_LIMIT;
    }

    /** QUERY_WHERE → 每条「并且」一个 QFilter，条内的「或者」用 or 连起来。 */
    static List<QFilter> where(IDataEntityType t, String raw, List<String> used, boolean[] flat,
            List<String> problems) {
        return where(t, raw, used, flat, problems, new ArrayList<String>(), null);
    }

    /**
     * texts 按顺序收每个 QFilter 对应的原文（命中 0 条时逐条报要用）；pseudos 收 @ 条件，
     * 传 null 表示调用方不支持 @ 条件（改数据按条件挑单时），写了就报入参错。
     */
    static List<QFilter> where(IDataEntityType t, String raw, List<String> used, boolean[] flat,
            List<String> problems, List<String> texts, List<Pseudo> pseudos) {
        List<QFilter> out = new ArrayList<QFilter>();
        for (String clause : raw.split(";")) {
            if (clause.trim().isEmpty()) {
                continue;
            }
            String[] alts = clause.split("\\|");
            boolean at = false;
            for (String alt : alts) {
                at |= alt.trim().startsWith("@");
            }
            if (at) {
                if (pseudos == null) {
                    problems.add("「" + clause.trim() + "」：@上游 / @下游 / @流程 只能在 DataQueryProbe 里查，这里按字段条件挑单");
                } else if (alts.length > 1) {
                    problems.add("「" + clause.trim() + "」：@ 条件要单独成一条（用 ; 和别的条件隔开），不能和别的写法用 | 连");
                } else {
                    Pseudo p = pseudo(clause, problems);
                    if (p != null) {
                        pseudos.add(p);
                        if (!used.contains(p.name)) {
                            used.add(p.name);
                        }
                    }
                }
                continue;
            }
            QFilter joined = null;
            for (String alt : alts) {
                QFilter one = condition(t, alt, used, flat, problems);
                if (one != null) {
                    joined = joined == null ? one : joined.or(one);
                }
            }
            if (joined != null) {
                out.add(joined);
                texts.add(clause.trim());
            }
        }
        return out;
    }

    private static Pseudo pseudo(String text, List<String> problems) {
        Matcher m = CLAUSE.matcher(text);
        if (!m.matches() || !m.group(1).startsWith("@")) {
            problems.add("条件看不懂：「" + text.trim() + "」（写成「@下游 is null」「@流程 like %节点名%」这样）");
            return null;
        }
        Pseudo p = new Pseudo();
        p.name = m.group(1);
        p.op = (m.group(2) != null ? m.group(2) : m.group(3)).toLowerCase().replaceAll("\\s+", " ");
        p.value = m.group(4);
        p.text = text.trim();
        String asNull = nullOp(p.op, p.value);
        if (asNull != null) {
            p.op = asNull;
            p.value = "";
        }
        if (!PSEUDO.contains(p.name)) {
            p.link = linked(p.name, problems);
            if (p.link == null) {
                if (!isPseudo(p.name)) {
                    problems.add("没有 " + p.name + "：能写的只有 " + PSEUDO + "，以及 @上游.单据标识、@下游.单据标识（后面还能接字段或 @流程）");
                }
                return null;
            }
            if (p.link.sub != null && !p.link.sub.equals("@流程")) {
                //字段条件落到连着的那类单上，写法和普通条件一样
                int before = problems.size();
                p.where = condition(p.link.type, p.link.sub + " " + p.op + (p.value.isEmpty() ? "" : " " + p.value),
                        new ArrayList<String>(), new boolean[]{false}, problems);
                if (p.where == null) {
                    if (problems.size() == before) {
                        problems.add("「" + p.text + "」：连着的单上的字段条件没认出来");
                    }
                    return null;
                }
                p.exists = true;
                return p;
            }
            p.exists = p.link.sub != null;
        }
        if (p.op.equals("<>")) {
            p.op = "!=";
        }
        boolean nullOp = p.op.equals("is null") || p.op.equals("is not null");
        if (!nullOp && !Arrays.asList("=", "!=", "like", "not like").contains(p.op)) {
            problems.add("「" + p.text + "」：@ 条件能用 = != like not like is null is not null");
            return null;
        }
        if (nullOp != p.value.isEmpty()) {
            problems.add("「" + p.text + "」：" + (nullOp ? p.op + " 后面不该有值" : p.op + " 缺值"));
            return null;
        }
        return p;
    }

    private static QFilter condition(IDataEntityType t, String text, List<String> used, boolean[] flat,
            List<String> problems) {
        Matcher m = CLAUSE.matcher(text);
        if (!m.matches()) {
            //真机 2026-09-18：id in 111|222 —— | 是隔开两条条件的「或者」，后半截就成了一条没有字段的条件
            String bare = text.trim().matches("[^\\s=<>!]+")
                    ? "；它像是一个值而不是一条条件：in 的多个值用逗号隔开（id in 111,222），| 只用来隔开两条完整的条件"
                    : "";
            problems.add("条件看不懂：「" + text.trim() + "」（写成「字段 运算符 值」，如 billstatus = C）" + bare);
            return null;
        }
        String field = m.group(1);
        String op = (m.group(2) != null ? m.group(2) : m.group(3)).toLowerCase().replaceAll("\\s+", " ");
        String raw = m.group(4);
        String asNull = nullOp(op, raw);
        if (asNull != null) {
            op = asNull;
            raw = "";
        }
        if (SECRET.matcher(field).matches()) {
            problems.add("不按口令类字段查：" + field);
            return null;
        }
        if (!used.contains(field)) {
            used.add(field);
        }
        Resolved r = resolve(t, field);
        flat[0] |= r.flat;
        if (op.equals("is null") || op.equals("is not null")) {
            if (!raw.isEmpty()) {
                problems.add(field + " " + op + " 后面不该有值：「" + raw + "」");
                return null;
            }
            if (text(r)) {
                //文本字段没填时库里存的是一个空格（平台的缺省值），不是 NULL：只按 NULL 比，「委托单号不为空」
                //会把没填的全查出来（S37 批 6，09-27 复测 264 条全是空值）。空格一并算空
                return op.equals("is null") ? new QFilter(field, "is null", null).or(field, "=", " ")
                        : new QFilter(field, "is not null", null).and(field, "!=", " ");
            }
            return new QFilter(field, op, null);
        }
        if (raw.isEmpty()) {
            problems.add(field + " " + op + " 缺值（要查空值写 " + field + " is null）");
            return null;
        }
        if (op.equals("<>")) {
            op = "!=";
        }
        if (quoting(field, op, raw, problems)) {
            return null;
        }
        if (op.endsWith("like")) {
            //like 比的是文本，% 由调用方自己写
            return new QFilter(field, op, raw);
        }
        if (op.endsWith("in")) {
            List<Object> values = new ArrayList<Object>();
            for (String one : raw.split(",")) {
                if (!one.trim().isEmpty()) {
                    Object v = convert(r, field, one.trim(), problems);
                    if (v == null) {
                        return null;
                    }
                    values.add(v);
                }
            }
            return values.isEmpty() ? null : new QFilter(field, op, values);
        }
        Object v = convert(r, field, raw, problems);
        return v == null ? null : new QFilter(field, op, v);
    }

    /**
     * 「= null」「!= null」「<> null」（null 不带引号）按 is null / is not null 算，返回换过的运算符；不是这种写法返回 null。
     *
     * 照字面查，比的是文字 "null"：「检验批号 != null」把没填的也算进来（真机 2026-10-07 S48 验收，
     * 8 条结果里混进 1 张没填的，模型逐张核对才没用错）。和带引号的值一样，看着像查对了、其实查错了；
     * 这里意思不会有歧义，所以直接按空值查，条件行里能看到换成了什么。
     */
    private static String nullOp(String op, String raw) {
        if (!"null".equalsIgnoreCase(raw.trim())) {
            return null;
        }
        return op.equals("=") ? "is null" : op.equals("!=") || op.equals("<>") ? "is not null" : null;
    }

    /**
     * 值里带了引号或括号 —— 报错，不是照着查。
     *
     * 这两种写法解析得过（CLAUSE 匹配的是「字段 运算符 剩下全部」），于是引号和括号原样进了
     * QFilter，比的是带引号的文本，返回「命中 0 条」。而 0 条长得跟「这张单本来没数据」一模
     * 一样：实测两次都因此多跑了一轮，第二次还得出了「条件串被切坏」的错误结论
     *（2026-09-14 真机复盘）。值本身几乎不可能真的以引号开头结尾，猜错的代价远小于沉默。
     */
    private static boolean quoting(String field, String op, String raw, List<String> problems) {
        String v = raw.trim();
        boolean brackets = op.endsWith("in") && v.startsWith("(") && v.endsWith(")");
        if (brackets) {
            v = v.substring(1, v.length() - 1).trim();
        }
        String[] values = op.endsWith("in") ? v.split(",", -1) : new String[]{v};
        boolean quotes = false;
        for (int i = 0; i < values.length; i++) {
            String x = values[i].trim();
            if (x.length() >= 2 && (x.charAt(0) == '\'' || x.charAt(0) == '"')
                    && x.charAt(x.length() - 1) == x.charAt(0)) {
                x = x.substring(1, x.length() - 1);
                quotes = true;
            }
            values[i] = x;
        }
        if (!brackets && !quotes) {
            return false;
        }
        String corrected = String.join(",", values);
        List<String> remaining = new ArrayList<String>();
        String advice = quoting(field, op, corrected, remaining)
                ? "请去掉各值外层的引号和 in 清单外层的括号"
                : "写成「" + field + " " + op + " " + corrected + "」";
        problems.add(field + " " + op + (brackets ? " 的值不要加括号" : " 的值不要加引号")
                + "，值不加引号、in 清单不加括号；" + advice);
        return true;
    }

    /** 要打印的字段：给了就按给的；没给就挑常用的几个，再补上条件里用到的。 */
    private static List<String> fields(IDataEntityType t, String raw, List<String> used, boolean[] flat,
            List<String> problems) {
        Set<String> out = new LinkedHashSet<String>();
        if (raw.trim().isEmpty()) {
            out.add("id");
            for (String common : new String[]{"billno", "number", "name", "billstatus"}) {
                if (t.getProperties().containsKey(common)) {
                    out.add(common);
                }
            }
            for (String f : used) {
                if (!SECRET.matcher(f).matches()) {
                    out.add(f);
                }
            }
        } else {
            for (String one : raw.split(",")) {
                String f = one.trim();
                if (f.isEmpty()) {
                    continue;
                }
                if (f.startsWith("@")) {
                    if (PSEUDO.contains(f) || linked(f, problems) != null) {
                        out.add(f);
                    } else if (!isPseudo(f)) {
                        problems.add("没有 " + f + "：能写的只有 " + PSEUDO + "，以及 @上游.单据标识、@下游.单据标识（后面还能接字段或 @流程）");
                    }
                } else if (!PATH.matcher(f).matches()) {
                    problems.add("字段标识写法不对：「" + f + "」（字母数字下划线，路径用点隔开）");
                } else if (SECRET.matcher(f).matches()) {
                    problems.add("不打印口令类字段：" + f);
                } else {
                    out.add(f);
                }
            }
        }
        for (String f : out) {
            if (isPseudo(f)) {
                continue;
            }
            Resolved r = resolve(t, f);
            flat[0] |= r.flat;
            if (r.prop == null) {
                System.out.println("[PROBE] ⚠ 元数据里没认出字段 " + f + "，照原样交给 ORM（写错了查询会报错）；相近的："
                        + near(t, f));
            }
        }
        return new ArrayList<String>(out);
    }

    /** ORM 报「属性不存在」时取出那个属性名（异常链上逐层找）；不是这种失败返回 null。 */
    private static String noSuchProperty(Throwable e) {
        Pattern p = Pattern.compile("property (\\S+?) does not exist");
        for (Throwable c = e; c != null; c = c.getCause() == c ? null : c.getCause()) {
            Matcher m = p.matcher(String.valueOf(c.getMessage()));
            if (m.find()) {
                return m.group(1);
            }
        }
        return null;
    }

    /** 条件和输出里元数据认不出的字段（id 这类主键不算）。 */
    private static List<String> unknownFields(IDataEntityType t, List<String> used, List<String> fields) {
        Set<String> all = new LinkedHashSet<String>(used);
        all.addAll(fields);
        List<String> out = new ArrayList<String>();
        for (String f : all) {
            if (!isPseudo(f) && resolve(t, f).prop == null) {
                out.add(f);
            }
        }
        return out;
    }

    /**
     * 认不出的字段给候选：走到认不出的那一段，在那一层的属性里按编辑距离挑，最多 6 个。
     * 真机 2026-09-18：status、zlgd_billstatus、entityname 连猜三次，正确的 billstatus 就在单上。
     */
    private static String near(IDataEntityType root, String path) {
        IDataEntityType host = root;
        String[] parts = path.split("\\.");
        String prefix = "";
        String wanted = parts[parts.length - 1];
        //认不出的那一段后面还跟着什么（zlgd_jyxm.name 的 .name），给全路径时原样接上
        String rest = "";
        for (int i = 0; i < parts.length && host != null; i++) {
            IDataEntityProperty p = property(host, parts[i]);
            if (p == null || i == parts.length - 1) {
                wanted = parts[i];
                for (int k = i + 1; k < parts.length; k++) {
                    rest += "." + parts[k];
                }
                break;
            }
            prefix += parts[i] + ".";
            host = p instanceof ICollectionProperty ? ((ICollectionProperty) p).getItemType()
                    : p instanceof IComplexProperty ? ((IComplexProperty) p).getComplexType() : null;
        }
        if (host == null) {
            return "（" + prefix + " 后面不能再接字段）";
        }
        final String w = wanted.toLowerCase();
        //先找分录里名字**正好一样**的：同名比「名字像」可靠得多。真机 2026-09-21 表头上写 zlgd_jyxm.name，
        //它其实在金相分录上，按名字像不像却先推了表头的 zlgd_jylx（专业室项目）——意思完全不同的字段
        List<String> deeper = new ArrayList<String>();
        deep(host, w, prefix, deeper);
        if (!deeper.isEmpty()) {
            List<String> full = new ArrayList<String>();
            for (String d : deeper) {
                full.add(d + rest);
            }
            return "（这一层没有；分录里有同名字段，写全路径：" + String.join("、", full) + "）";
        }
        final java.util.Map<String, Integer> score = new java.util.LinkedHashMap<String, Integer>();
        for (Object o : host.getProperties()) {
            String name = ((IDataEntityProperty) o).getName();
            String n = name.toLowerCase();
            int d = distance(w, n);
            if (d <= Math.max(2, w.length() / 3) || n.contains(w) || w.contains(n) && n.length() >= 4) {
                score.put(prefix + name, Integer.valueOf(d));
            }
        }
        List<String> hits = new ArrayList<String>(score.keySet());
        java.util.Collections.sort(hits, new java.util.Comparator<String>() {
            public int compare(String a, String b) {
                return score.get(a).compareTo(score.get(b));
            }
        });
        if (!hits.isEmpty()) {
            //不全列：按名字远近排的候选，给最像的几个
            return hits.subList(0, Math.min(6, hits.size())).toString();
        }
        //名字不像、分录里也没有：多半这张单根本不是要找的那张。以前这里只说「先用 MetaProbe 看」，
        //要再起一轮探针，而答案就在手上的元数据里。同一层的清单一次调用只列一遍
        String layer = prefix.isEmpty() ? "这张单" : prefix + " 这一层";
        if (LISTED.get() != null && !LISTED.get().add(layer)) {
            return "（没有相近的；" + layer + "的字段见上方清单）";
        }
        return "（没有相近的；" + layer + "的字段是：" + listing(host, prefix) + "）";
    }

    /** 分录（及子分录）里名字正好对上的字段，写成能直接抄的全路径。 */
    private static void deep(IDataEntityType host, String wanted, String prefix, List<String> out) {
        for (Object o : host.getProperties()) {
            IDataEntityProperty p = (IDataEntityProperty) o;
            if (p instanceof ICollectionProperty) {
                IDataEntityType item = ((ICollectionProperty) p).getItemType();
                String path = prefix + p.getName() + ".";
                for (Object c : item.getProperties()) {
                    if (((IDataEntityProperty) c).getName().equalsIgnoreCase(wanted)) {
                        out.add(path + ((IDataEntityProperty) c).getName());
                    }
                }
                deep(item, wanted, path, out);
            }
        }
    }

    /** 这一层的字段带中文名，分录单独标出来；太多只列前 40 个。 */
    private static String listing(IDataEntityType host, String prefix) {
        List<String> out = new ArrayList<String>();
        int total = 0;
        for (Object o : host.getProperties()) {
            IDataEntityProperty p = (IDataEntityProperty) o;
            String name = p.getName();
            if (name.endsWith("_id") || "multilanguagetext".equals(name)) {
                continue;
            }
            total++;
            if (out.size() < 40) {
                String label = String.valueOf(p.getDisplayName());
                out.add(prefix + name + ("null".equals(label) || label.isEmpty() ? "" : "（" + label + "）")
                        + (p instanceof ICollectionProperty ? "[分录]" : ""));
            }
        }
        return String.join("、", out) + (total > out.size() ? " …共 " + total + " 个" : "");
    }

    private static int distance(String a, String b) {
        int[] prev = new int[b.length() + 1];
        int[] cur = new int[b.length() + 1];
        for (int j = 0; j <= b.length(); j++) {
            prev[j] = j;
        }
        for (int i = 1; i <= a.length(); i++) {
            cur[0] = i;
            for (int j = 1; j <= b.length(); j++) {
                int cost = a.charAt(i - 1) == b.charAt(j - 1) ? 0 : 1;
                cur[j] = Math.min(Math.min(cur[j - 1] + 1, prev[j] + 1), prev[j - 1] + cost);
            }
            int[] tmp = prev;
            prev = cur;
            cur = tmp;
        }
        return prev[b.length()];
    }

    private static final class Resolved {
        IDataEntityProperty prop;
        /** 路径经过分录或多选基础资料 —— 查出来是扁平行。 */
        boolean flat;
    }

    /** 路径落到的属性。中间一段不是分录/基础资料、或者标识写错时 prop 为 null。 */
    private static Resolved resolve(IDataEntityType root, String path) {
        Resolved r = new Resolved();
        IDataEntityType host = root;
        String[] parts = path.split("\\.");
        for (int i = 0; i < parts.length && host != null; i++) {
            IDataEntityProperty p = property(host, parts[i]);
            if (p == null) {
                return r;
            }
            if (i == parts.length - 1) {
                r.prop = p;
                return r;
            }
            if (p instanceof ICollectionProperty) {
                r.flat = true;
                host = ((ICollectionProperty) p).getItemType();
            } else if (p instanceof IComplexProperty) {
                host = ((IComplexProperty) p).getComplexType();
            } else {
                return r;
            }
        }
        return r;
    }

    private static IDataEntityProperty property(IDataEntityType host, String name) {
        if (host.getProperties().containsKey(name)) {
            return host.getProperties().get(name);
        }
        IDataEntityProperty pk = host.getPrimaryKey();
        return pk != null && pk.getName().equalsIgnoreCase(name) ? pk : null;
    }

    /** 按字段类型转；转不动记一条问题并返回 null。认不出的字段按文本比。 */
    /** 普通文本字段（不是基础资料、分录）。 */
    private static boolean text(Resolved r) {
        return r.prop != null && !(r.prop instanceof IComplexProperty) && !(r.prop instanceof ICollectionProperty)
                && r.prop.getPropertyType() == String.class;
    }

    private static Object convert(Resolved r, String field, String raw, List<String> problems) {
        IDataEntityProperty p = r.prop;
        if (p == null) {
            return raw;
        }
        if (p instanceof ICollectionProperty) {
            problems.add(field + " 是分录/多选基础资料，不能直接比，写到它下面的字段（如 " + field + ".字段）");
            return null;
        }
        Class<?> type = p.getPropertyType();
        if (p instanceof IComplexProperty) {
            //基础资料字段本身存的是 id
            IDataEntityType ref = ((IComplexProperty) p).getComplexType();
            IDataEntityProperty pk = ref == null ? null : ref.getPrimaryKey();
            type = pk == null ? Long.class : pk.getPropertyType();
            if (Number.class.isAssignableFrom(box(type)) && !raw.matches("-?\\d+")) {
                problems.add(field + " 是基础资料，本身按 id 比，「" + raw + "」不是 id；按编码查写 "
                        + field + ".number，按名称查写 " + field + ".name");
                return null;
            }
        }
        try {
            return scalar(box(type), raw);
        } catch (IllegalArgumentException e) {
            problems.add(field + "：" + e.getMessage());
            return null;
        }
    }

    private static Class<?> box(Class<?> type) {
        if (type == int.class) {
            return Integer.class;
        }
        if (type == long.class) {
            return Long.class;
        }
        if (type == boolean.class) {
            return Boolean.class;
        }
        if (type == short.class) {
            return Short.class;
        }
        if (type == double.class) {
            return Double.class;
        }
        return type == null ? String.class : type;
    }

    private static Object scalar(Class<?> type, String val) {
        try {
            if (type == Integer.class) {
                return Integer.valueOf(val);
            }
            if (type == Long.class) {
                return Long.valueOf(val);
            }
            if (type == Short.class) {
                return Short.valueOf(val);
            }
            if (type == Double.class) {
                return Double.valueOf(val);
            }
            if (type == BigDecimal.class) {
                return new BigDecimal(val);
            }
        } catch (NumberFormatException e) {
            throw new IllegalArgumentException("要一个 " + type.getSimpleName() + "，给的是「" + val + "」");
        }
        if (type == Boolean.class) {
            if ("1".equals(val) || "true".equalsIgnoreCase(val)) {
                return Boolean.TRUE;
            }
            if ("0".equals(val) || "false".equalsIgnoreCase(val)) {
                return Boolean.FALSE;
            }
            throw new IllegalArgumentException("要 1/0 或 true/false，给的是「" + val + "」");
        }
        if (Date.class.isAssignableFrom(type)) {
            return date(val);
        }
        return val;
    }

    /** setLenient(false)：宽松模式会把 2026-13-45 顺延成 2027-02-14 而不报错。 */
    private static Date date(String val) {
        SimpleDateFormat fmt = new SimpleDateFormat(val.length() > 10 ? "yyyy-MM-dd HH:mm:ss" : "yyyy-MM-dd");
        fmt.setLenient(false);
        try {
            return fmt.parse(val);
        } catch (ParseException e) {
            throw new IllegalArgumentException("日期要 yyyy-MM-dd 或 yyyy-MM-dd HH:mm:ss，给的是「" + val + "」");
        }
    }

    static String describe(QFilter[] qfs) {
        StringBuilder sb = new StringBuilder();
        for (QFilter q : qfs) {
            if (sb.length() > 0) {
                sb.append("  并且  ");
            }
            sb.append('(').append(oneLine(q.toString())).append(')');
        }
        return sb.toString();
    }

    private static Object value(DynamicObject row, String field) {
        try {
            return row.get(field);
        } catch (RuntimeException e) {
            return "<取不到: " + e.getClass().getSimpleName() + ">";
        }
    }

    /**
     * 列出来的字段里有下拉（单据状态也是下拉）的，第一行数据前各打一行全部选项「代码=显示名」。
     *
     * 库里存的是 A、1 这样的代码，只看代码要靠猜。真机 2026-10-08：检测单的单据状态只看到 A、B，
     * 模型猜成「A 已提交、B 暂存」（正好反了），挑了已经提交过的单去验提交校验，多绕了 6 次调用。
     * 值本身照原样打、对照另起一行：写成「A(暂存)」的话，照抄进条件、--set、--expect 就对不上——
     * --set 还会把这几个字原样存进下拉字段，界面显示空白也不报错。
     * 连着的单（@上游.单据标识）方括号里是它的单据状态，同样给一行。
     */
    private static void comboLegends(IDataEntityType t, List<String> fields) {
        for (String f : fields) {
            ComboProp combo = null;
            String what = f;
            if (f.startsWith("@上游.") || f.startsWith("@下游.")) {
                Linked l = linked(f, new ArrayList<String>());
                if (l != null && l.sub == null) {
                    combo = comboAt(l.type, "billstatus");
                    what = f + " 方括号里的单据状态";
                } else if (l != null && !l.sub.equals("@流程")) {
                    combo = comboAt(l.type, l.sub);
                }
            } else if (!isPseudo(f)) {
                combo = comboAt(t, f);
            }
            if (combo != null) {
                System.out.println("[PROBE] 下拉 " + what + "：" + comboItems(combo));
            }
        }
    }

    /** 路径落到的下拉属性；不是下拉、认不出、没有选项的都返回 null。 */
    private static ComboProp comboAt(IDataEntityType host, String path) {
        if (host == null || path == null || !PATH.matcher(path).matches()) {
            return null;
        }
        IDataEntityProperty p = resolve(host, path).prop;
        if (!(p instanceof ComboProp)) {
            return null;
        }
        List<ValueMapItem> items = ((ComboProp) p).getComboItems();
        return items == null || items.isEmpty() ? null : (ComboProp) p;
    }

    /** 全部选项「代码=显示名」，空格隔开。 */
    private static String comboItems(ComboProp p) {
        List<String> out = new ArrayList<String>();
        for (ValueMapItem it : p.getComboItems()) {
            String name = it.getName() == null ? "" : String.valueOf(it.getName()).trim();
            out.add(it.getValue() + "=" + name);
        }
        return String.join(" ", out);
    }

    private static String render(Object v) {
        if (v == null) {
            return "null";
        }
        if (v instanceof Date) {
            return new SimpleDateFormat("yyyy-MM-dd HH:mm:ss").format((Date) v);
        }
        if (v instanceof BigDecimal) {
            return ((BigDecimal) v).toPlainString();
        }
        if (v instanceof DynamicObject) {
            return String.valueOf(((DynamicObject) v).getPkValue());
        }
        String s = oneLine(String.valueOf(v));
        return s.length() > MAX_VALUE_CHARS ? s.substring(0, MAX_VALUE_CHARS) + "…(共 " + s.length() + " 字)" : s;
    }

    private static String oneLine(String s) {
        return s.replace('\r', ' ').replace('\n', ' ');
    }

    /**
     * ORM 的异常消息里连着一整段堆栈（「…not configured.\tat kd.bos.orm…」），原样打出来
     * 一行上千字、还夹着制表符，有用的只有第一句。堆栈照样在完整日志里。
     */
    private static String firstSentence(String s) {
        String one = oneLine(s);
        int cut = one.length();
        for (String mark : new String[]{"\tat ", "  at ", " at kd.", " at java."}) {
            int at = one.indexOf(mark);
            if (at > 0 && at < cut) {
                cut = at;
            }
        }
        String head = one.substring(0, cut).replace('\t', ' ').trim();
        return head.length() > 400 ? head.substring(0, 400) + "…" : head;
    }

    private static String req(String k) {
        String v = System.getenv(k);
        if (v == null || v.trim().isEmpty()) {
            throw new IllegalArgumentException("缺少环境变量 " + k);
        }
        return v.trim();
    }

    private static String env(String k, String def) {
        String v = System.getenv(k);
        return v == null || v.isEmpty() ? def : v;
    }
}
