import java.io.InputStream;
import java.io.StringReader;
import java.lang.reflect.Method;
import java.net.URL;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import javax.xml.XMLConstants;
import javax.xml.parsers.DocumentBuilderFactory;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.Node;
import org.w3c.dom.NodeList;

import kd.bos.cup.Symbol;
import kd.bos.entity.EntityMetadataCache;
import kd.bos.entity.MainEntityType;
import kd.bos.metadata.dao.MetaCategory;
import kd.bos.metadata.dao.MetadataDao;
import kd.bos.metadata.entity.EntityMetadata;
import kd.bos.entity.formula.BOSExpression;
import kd.bos.entity.function.FunctionManage;
import kd.bos.formula.excel.FunDef;
import kd.bos.formula.excel.Lexer;
import kd.bos.formula.excel.parser;

/**
 * 公式写进元数据之前，拿平台自己的判据核一遍；三类公式查询查不到时，也用这里的目录找相近名字（S36 批 3）。
 *
 * 为什么规则表达式要有这一关：界面规则、业务规则写入只做形状校验——`BizRule.buildEntityRule` 把条件原样存下，
 * `convertToDesignMeta` 不看表达式——写错函数名、少个括号照样落库。到运行时解析失败，规则整条跳过，
 * 界面上看不出任何报错（RuleSim 里是「条件求值失败」）。
 *
 * 规则表达式核三件事，判据都取自平台运行时本身（2026-09-28 对苍穹 8.0 JAR 反编译核对 + 离线实测）：
 *   1. **语法**：`kd.bos.formula.excel` 的词法、语法分析，和 `BOSExpression` 同一套。平台自己的报错只有
 *      `parse error:<原文>`，这里另外记下卡在哪个记号、第几个字符，好让人直接看到错处。
 *   2. **函数**：运行时 `ExprFuncCreator` 按原名查 `FunctionManage` 登记表（HashMap，区分大小写），
 *      公式引擎再放进默认的 sum/max/min/avg/count（同样按原名），都没有才查内置函数 `FunDef`
 *      （按大写查，不分大小写），还没有就抛「函数不存在」。这里照同一顺序判。
 *   3. **字段**：变量的第一段要能在这张单据上找到（和运行时一样用 `findProperty`，含分录和不算字段的属性）。
 *      找不到就是取不到值；运行时具体表现（取空还是报错）没有实测，输出里不下结论。
 *
 * 只说判据查到的事实，不猜修法：相近名字按编辑距离从当前目录里取，最多 3 个。
 */
public final class FormulaCheck {

    private FormulaCheck() {
    }

    /** 一条表达式的核对结果。 */
    public static final class Result {
        /** 交给平台的原文。 */
        public final String input;
        /** 语法不过时平台的原话；null 表示语法过了。 */
        public String parseError;
        /** 语法卡住的地方（从 1 数的字符位置）；-1 表示定位不到。 */
        public int at = -1;
        /** 语法卡住的记号；到结尾还没写完时是 null。 */
        public String token;
        /** 语法卡住前后的原文，错处用【】括出来。 */
        public String excerpt;
        public final List<String> funcs = new ArrayList<String>();
        public final List<String> vars = new ArrayList<String>();
        /** 两边都查不到的函数。 */
        public final List<String> badFuncs = new ArrayList<String>();
        /** 只差大小写的登记函数：写法 -> 登记名。 */
        public final Map<String, String> caseOnly = new LinkedHashMap<String, String>();
        /** 查不到的字段（变量第一段）。 */
        public final List<String> badFields = new ArrayList<String>();
        /** 查不到的名字 -> 当前目录里相近的名字。 */
        public final Map<String, List<String>> near = new LinkedHashMap<String, List<String>>();
        /** 函数登记表或实体没读成：这部分没核，不能当作「核过了」。 */
        public final List<String> unchecked = new ArrayList<String>();

        Result(String input) {
            this.input = input;
        }

        public boolean ok() {
            return parseError == null && badFuncs.isEmpty() && caseOnly.isEmpty() && badFields.isEmpty();
        }
    }

    /**
     * 核一条规则表达式。`entity` 为 null 时不核字段（记进 unchecked）。
     *
     * 不抛：函数登记表、实体读不成都记下来，由调用方决定拦不拦。
     */
    public static Result rule(String expr, MainEntityType entity) {
        Result r = new Result(expr == null ? "" : expr);
        if (!syntax(r)) return r;
        BOSExpression parsed = new BOSExpression(r.input);
        if (parsed.isError()) {
            r.parseError = parsed.getErrMessage();
            return r;
        }
        r.funcs.addAll(sorted(parsed.getFuncs()));
        r.vars.addAll(sorted(parsed.getVars()));

        Map<String, ?> registered = null;
        try {
            registered = FunctionManage.get().getFuncMap();
        } catch (Throwable e) {
            r.unchecked.add("规则函数登记表读取失败：" + e.getClass().getSimpleName() + "，函数名没核");
        }
        if (registered != null) {
            for (String f : r.funcs) {
                if (registered.containsKey(f) || DEFAULTS.contains(f) || FunDef.getFunDef(f) != null) continue;
                String exact = null;
                for (String key : exactNames(registered.keySet())) {
                    if (key != null && key.equalsIgnoreCase(f)) { exact = key; break; }
                }
                if (exact != null) {
                    r.caseOnly.put(f, exact);
                    continue;
                }
                r.badFuncs.add(f);
                r.near.put(f, near(f, exactNames(registered.keySet()), 3));
            }
        }

        if (entity == null) {
            if (!r.vars.isEmpty()) r.unchecked.add("没拿到单据元数据，字段没核");
            return r;
        }
        Set<String> names = new LinkedHashSet<String>();
        try {
            names.addAll(entity.getAllFields().keySet());
            names.addAll(entity.getAllEntities().keySet());
        } catch (Throwable e) {
            r.unchecked.add("单据字段读取失败：" + e.getClass().getSimpleName() + "，字段没核");
            return r;
        }
        for (String v : r.vars) {
            String head = v.split("\\.", 2)[0];
            if (names.contains(head) || r.badFields.contains(head) || hasProperty(entity, head)) continue;
            r.badFields.add(head);
            r.near.put(head, near(head, names, 3));
        }
        return r;
    }

    /**
     * 打印结果；返回这条表达式能不能写。发 `t=formula-error` 记录，一处错一条。
     *
     * @param domain  form | biz，和 `cosmic_meta formula` 的领域同名
     * @param where   写在哪，例如「RULE_GROUPS 组 宽度类」；跨调用比对同一处错误时拿它当键
     * @param entity  单据标识，只用来说明字段在哪张单上找的
     * @param record  发不发 `t=formula-error`：读既有规则时不发，那不是本次调用方写的输入
     */
    public static boolean report(String domain, String where, String entity, Result r, boolean record) {
        if (r.ok()) {
            //读既有规则时不逐条说「没核」：调用方在开头说一次
            if (record) for (String gap : r.unchecked) System.out.println("[PROBE]   ? " + where + "：" + gap);
            return true;
        }
        System.out.println("[PROBE]   ✗ " + where + "：" + r.input);
        if (r.parseError != null) {
            String place = r.at > 0 ? "第 " + r.at + " 个字符" : "位置未知";
            String what = r.token == null
                    ? "到结尾还没写完（" + parens(r.input) + "）"
                    : "卡在「" + r.token + "」（" + place + "）";
            System.out.println("[PROBE]     平台解析不过，" + what
                    + (r.excerpt == null ? "" : "：" + r.excerpt));
            if (record) emit(domain, where, r, "parse", r.token, r.token == null ? parens(r.input) : place);
        }
        for (String f : r.badFuncs) {
            System.out.println("[PROBE]     函数 " + f + " 不在当前环境的规则函数登记表里，也不是公式引擎内置函数"
                    + nearText(r.near.get(f)));
            if (record) emit(domain, where, r, "function", f, null);
        }
        for (Map.Entry<String, String> e : r.caseOnly.entrySet()) {
            System.out.println("[PROBE]     函数 " + e.getKey() + " 登记名是 " + e.getValue()
                    + "；登记函数按原名查找、区分大小写，这样写运行时找不到");
            if (record) emit(domain, where, r, "function-case", e.getKey(), e.getValue());
        }
        for (String f : r.badFields) {
            System.out.println("[PROBE]     字段 " + f + " 不在单据 " + entity + " 上（含分录）"
                    + nearText(r.near.get(f)));
            if (record) emit(domain, where, r, "field", f, null);
        }
        for (String gap : r.unchecked) System.out.println("[PROBE]     ? " + gap);
        return false;
    }

    /**
     * 运行时取变量值走 `IMemberValueHandler.findPropertys`：第一段用 `EntityType.findProperty` 在整张单据上找，
     * 找得到的不只字段，还有不算字段的属性（标准单据扩展上的 auxrate 这类）。第一版只比字段清单，
     * 把这类属性误判成不存在，真机误报尺子抓到的。
     */
    private static boolean hasProperty(MainEntityType entity, String key) {
        try {
            return entity.findProperty(key) != null;
        } catch (Throwable e) {
            return false;
        }
    }

    /** 运行态实体，给表达式核字段用；读不到返回 null，核对结果里会写「字段没核」。 */
    public static MainEntityType entityType(String entityKey) {
        if (entityKey == null) return null;
        try {
            return EntityMetadataCache.getDataEntityType(entityKey);
        } catch (Throwable direct) {
            //扩展单据（xx_ext）运行时并进被扩展的原单据，按扩展标识取不到；顺着 masterId 找原单据
            try {
                String id = MetadataDao.getIdByNumber(entityKey, MetaCategory.Entity);
                EntityMetadata em = id == null ? null : (EntityMetadata) MetadataDao.readMeta(id, MetaCategory.Entity);
                String master = em == null ? null : em.getMasterId();
                if (master == null || master.isEmpty() || master.equals(id)) return null;
                return EntityMetadataCache.getDataEntityType(MetadataDao.getNumberById(master));
            } catch (Throwable viaMaster) {
                return null;
            }
        }
    }

    /**
     * 公式引擎求值时先放进去的默认函数（`FormulaEngine.execExcelFormula` 加 `UDFunctions.all`），
     * 按原名查、区分大小写：真机登记名全是小写，`SUM(x)` 运行时报函数不存在（2026-09-28 离线实测）。
     * 第一版核对漏了这组，把业务规则里的 `sum(...)` 误判成不存在，真机误报尺子抓到的。
     */
    private static final Set<String> DEFAULTS = defaults();

    private static Set<String> defaults() {
        Set<String> out = new LinkedHashSet<String>();
        try {
            for (kd.bos.formula.excel.UDFunction f : kd.bos.formula.functions.UDFunctions.all) out.add(f.getName());
        } catch (Throwable ignored) { }
        return out;
    }

    /** 区分大小写的函数名全集：登记表 + 默认函数（内置 FunDef 不分大小写，不在这里）。 */
    private static List<String> exactNames(Set<String> registered) {
        List<String> out = new ArrayList<String>(registered);
        out.addAll(DEFAULTS);
        return out;
    }

    /**
     * 有表达式没过核对就停在写入之前，按入参错退出（改了输入再跑不算同一失败）。
     * EXPR_CHECK=0 放行：只在核对自己判错时用，要说明理由。
     */
    public static void stopOnBad(List<String> bad) {
        if (bad.isEmpty()) return;
        if ("0".equals(System.getenv("EXPR_CHECK"))) {
            System.out.println("[PROBE] !! EXPR_CHECK=0：" + bad.size() + " 处表达式没过平台核对，照样往下走");
            return;
        }
        StringBuilder where = new StringBuilder();
        for (String w : bad) where.append(where.length() == 0 ? "" : "；").append(w);
        throw new IllegalArgumentException("未写入：" + bad.size() + " 处表达式没过平台核对（" + where
                + "），错处见上面 ✗ 行。改完重新 dry-run；确认是核对自己判错了，再加 EXPR_CHECK=0 跳过并说明理由");
    }

    private static void emit(String domain, String where, Result r, String kind, String token, String detail) {
        List<String> near = token == null ? null : r.near.get(token);
        ProbeJson.emit("formula-error", "domain", domain, "where", where, "kind", kind, "input", r.input,
                "token", token, "detail", detail, "near", near == null ? Collections.<String>emptyList() : near);
    }

    /** 相近名字的尾巴，没有就是空串。 */
    public static String nearText(List<String> near) {
        if (near == null || near.isEmpty()) return "";
        StringBuilder b = new StringBuilder("；名字相近的：");
        for (int i = 0; i < near.size(); i++) b.append(i == 0 ? "" : "、").append(near.get(i));
        return b.toString();
    }

    /**
     * 自己跑一遍平台的词法 + 语法分析，失败时记下错处。
     *
     * 平台 `ExprParser.parse` 就是 `new parser(new Lexer(reader)).parse()`，失败只抛「parse error:原文」；
     * 这里换成同样两个类，多记两件事：读到过哪些记号、在哪个记号上放弃（CUP 的 `unrecovered_syntax_error`）。
     * 记号不带字符位置（平台词法器没填 left/right），位置按记号原文在输入里依次找出来。
     */
    private static boolean syntax(Result r) {
        final List<Symbol> seen = new ArrayList<Symbol>();
        final Lexer lexer = new Lexer(new StringReader(r.input));
        final Symbol[] bad = new Symbol[1];
        kd.bos.cup.Scanner scanner = new kd.bos.cup.Scanner() {
            public Symbol next_token() throws java.io.IOException {
                Symbol s = lexer.next_token();
                seen.add(s);
                return s;
            }
        };
        parser p = new parser(scanner) {
            public void unrecovered_syntax_error(Symbol s) {
                bad[0] = s;
                super.unrecovered_syntax_error(s);
            }
        };
        java.io.PrintStream err = System.err;
        try {
            //平台语法器失败时往 stderr 打一行「instead expected token classes are [...]」，对人没有信息量
            System.setErr(new java.io.PrintStream(new java.io.ByteArrayOutputStream()));
            p.parse();
            return true;
        } catch (Throwable e) {
            r.parseError = "parse error:" + r.input;
        } finally {
            System.setErr(err);
        }
        //定位：每个记号的原文在输入里依次找，找到最后一个读过的
        int cursor = 0;
        int badAt = -1;
        for (Symbol s : seen) {
            String text = tokenText(s);
            if (text == null) continue;
            int i = r.input.indexOf(text, cursor);
            if (i < 0) continue;
            if (s == bad[0]) badAt = i;
            cursor = i + text.length();
        }
        if (bad[0] != null && tokenText(bad[0]) != null) {
            r.token = tokenText(bad[0]);
            r.at = badAt < 0 ? -1 : badAt + 1;
            if (badAt >= 0) r.excerpt = mark(r.input, badAt, badAt + r.token.length());
        } else if (bad[0] == null) {
            //词法器自己读不下去（例如引号没闭合）：错处在最后一个读成的记号之后
            int from = Math.min(cursor, r.input.length());
            while (from < r.input.length() && Character.isWhitespace(r.input.charAt(from))) from++;
            if (from < r.input.length()) {
                r.token = r.input.substring(from, Math.min(r.input.length(), from + 1));
                r.at = from + 1;
                r.excerpt = mark(r.input, from, r.input.length());
            }
        }
        return false;
    }

    private static String tokenText(Symbol s) {
        if (s == null || s.sym == 0 || s.value == null) return null;
        String t = String.valueOf(s.value);
        return t.isEmpty() ? null : t;
    }

    private static String mark(String input, int from, int to) {
        int start = Math.max(0, from - 20);
        int end = Math.min(input.length(), to + 20);
        return (start > 0 ? "…" : "") + input.substring(start, from) + "【" + input.substring(from, to) + "】"
                + input.substring(to, end) + (end < input.length() ? "…" : "");
    }

    /** 括号数：只数引号外面的。 */
    private static String parens(String input) {
        int open = 0, close = 0;
        char quote = 0;
        for (int i = 0; i < input.length(); i++) {
            char c = input.charAt(i);
            if (quote != 0) { if (c == quote) quote = 0; continue; }
            if (c == '\'' || c == '"') quote = c;
            else if (c == '(') open++;
            else if (c == ')') close++;
        }
        return "左括号 " + open + " 个、右括号 " + close + " 个" + (quote != 0 ? "、有引号没闭合" : "");
    }

    /**
     * 目录里和 `name` 相近的名字，最多 `max` 个：不分大小写的编辑距离不超过名字长度的四分之一（至少 1），
     * 或一方包含另一方（都至少 4 个字符）。按距离排，同距离按名字排。
     */
    public static List<String> near(String name, Collection<String> pool, int max) {
        final String n = name.toLowerCase(Locale.ROOT);
        final Map<String, Integer> score = new LinkedHashMap<String, Integer>();
        int limit = Math.max(1, n.length() / 4);
        for (String candidate : pool) {
            if (candidate == null || candidate.isEmpty() || candidate.equals(name)) continue;
            String c = candidate.toLowerCase(Locale.ROOT);
            int d = distance(n, c, limit + 1);
            boolean contains = n.length() >= 4 && c.length() >= 4 && (c.contains(n) || n.contains(c));
            if (d <= limit || contains) {
                Integer old = score.get(candidate);
                int s = contains && d > limit ? limit + Math.abs(c.length() - n.length()) : d;
                if (old == null || s < old) score.put(candidate, s);
            }
        }
        List<String> out = new ArrayList<String>(score.keySet());
        Collections.sort(out, new Comparator<String>() {
            public int compare(String a, String b) {
                int x = score.get(a) - score.get(b);
                return x != 0 ? x : a.compareToIgnoreCase(b);
            }
        });
        return out.size() > max ? new ArrayList<String>(out.subList(0, max)) : out;
    }

    /** 编辑距离，超过 cap 就早停返回 cap。 */
    private static int distance(String a, String b, int cap) {
        if (Math.abs(a.length() - b.length()) >= cap) return cap;
        int[] prev = new int[b.length() + 1];
        int[] cur = new int[b.length() + 1];
        for (int j = 0; j <= b.length(); j++) prev[j] = j;
        for (int i = 1; i <= a.length(); i++) {
            cur[0] = i;
            int best = cur[0];
            for (int j = 1; j <= b.length(); j++) {
                int cost = a.charAt(i - 1) == b.charAt(j - 1) ? 0 : 1;
                cur[j] = Math.min(Math.min(cur[j - 1] + 1, prev[j] + 1), prev[j - 1] + cost);
                best = Math.min(best, cur[j]);
            }
            if (best >= cap) return cap;
            int[] t = prev; prev = cur; cur = t;
        }
        return Math.min(prev[b.length()], cap);
    }

    private static List<String> sorted(Set<String> xs) {
        List<String> out = new ArrayList<String>();
        if (xs != null) for (String x : xs) if (x != null) out.add(x);
        Collections.sort(out);
        return out;
    }

    // ── 打印函数目录（设计器内置 + 当前进程登记） ────────────────────────

    /** 打印设计器内置函数的一项：{id, 分类, 名称, 格式, 说明}。 */
    public static List<String[]> printCatalog(URL url) throws Exception {
        List<String[]> out = new ArrayList<String[]>();
        DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
        factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        factory.setFeature("http://xml.org/sax/features/external-general-entities", false);
        factory.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
        factory.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
        factory.setXIncludeAware(false);
        factory.setExpandEntityReferences(false);
        InputStream input = url.openStream();
        try {
            Document doc = factory.newDocumentBuilder().parse(input);
            NodeList categories = doc.getElementsByTagName("Category");
            for (int i = 0; i < categories.getLength(); i++) {
                Element category = (Element) categories.item(i);
                NodeList children = category.getChildNodes();
                for (int j = 0; j < children.getLength(); j++) {
                    Node child = children.item(j);
                    //平台 XML 里就拼成 Funtion
                    if (!(child instanceof Element) || !"Funtion".equals(child.getNodeName())) continue;
                    Element f = (Element) child;
                    out.add(new String[] {f.getAttribute("Id"), category.getAttribute("Name"),
                        f.getAttribute("Name"), f.getAttribute("Title"), f.getTextContent()});
                }
            }
        } finally { input.close(); }
        return out;
    }

    /** 当前进程打印公式管理器里已登记的自定义函数名；读不成抛出，由调用方记缺口。 */
    public static List<String> printRegistered() throws Exception {
        Class<?> managerClass = Class.forName("kd.bos.print.business.formula.PrintFormulaManager");
        Object manager = managerClass.getMethod("getInstance").invoke(null);
        Object registered = managerClass.getMethod("getUdFunctions").invoke(manager);
        if (!(registered instanceof Set)) throw new IllegalStateException("自定义函数登记表不是 Set");
        List<String> out = new ArrayList<String>();
        for (Object function : (Set<?>) registered) {
            Method getName = function.getClass().getMethod("getName");
            getName.setAccessible(true);
            out.add(String.valueOf(getName.invoke(function)));
        }
        return out;
    }

    /** 打印函数名全集（内置 + 当前进程登记），给「函数不存在」找相近名字用；读不成返回空。 */
    public static List<String> printNames() {
        List<String> out = new ArrayList<String>();
        try {
            URL url = FormulaCheck.class.getClassLoader().getResource("PrintInitFunction.xml");
            if (url != null) for (String[] f : printCatalog(url)) out.add(f[0]);
        } catch (Throwable ignored) { }
        try { out.addAll(printRegistered()); } catch (Throwable ignored) { }
        return out;
    }
}
