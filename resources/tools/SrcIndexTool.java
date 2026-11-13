import com.sun.source.tree.ArrayAccessTree;
import com.sun.source.tree.AssignmentTree;
import com.sun.source.tree.BinaryTree;
import com.sun.source.tree.ClassTree;
import com.sun.source.tree.CompilationUnitTree;
import com.sun.source.tree.ConditionalExpressionTree;
import com.sun.source.tree.EnhancedForLoopTree;
import com.sun.source.tree.ExpressionTree;
import com.sun.source.tree.IdentifierTree;
import com.sun.source.tree.LiteralTree;
import com.sun.source.tree.MemberSelectTree;
import com.sun.source.tree.MethodInvocationTree;
import com.sun.source.tree.NewArrayTree;
import com.sun.source.tree.NewClassTree;
import com.sun.source.tree.ParenthesizedTree;
import com.sun.source.tree.Tree;
import com.sun.source.tree.TypeCastTree;
import com.sun.source.tree.VariableTree;
import com.sun.source.util.JavacTask;
import com.sun.source.util.SourcePositions;
import com.sun.source.util.TreePath;
import com.sun.source.util.TreePathScanner;
import com.sun.source.util.Trees;

import javax.lang.model.element.Element;
import javax.lang.model.element.ElementKind;
import javax.lang.model.element.ExecutableElement;
import javax.lang.model.element.Modifier;
import javax.lang.model.element.TypeElement;
import javax.lang.model.element.VariableElement;
import javax.lang.model.type.DeclaredType;
import javax.lang.model.type.TypeMirror;
import javax.tools.Diagnostic;
import javax.tools.DiagnosticCollector;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.StandardJavaFileManager;
import javax.tools.ToolProvider;
import java.io.File;
import java.io.PrintWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
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
import java.util.TimeZone;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 影响面索引的**静态一侧**：把业务模块的源码解析成「类 → 碰了哪些实体 / 哪些字段」。
 *
 * 与 ApiTool 同层，离线跑（不起苍穹、不连库），走 javac Tree API + driver 已产出的真 classpath，
 * 所以每一处调用都绑到真实 Symbol，没有「名字匹配」这一档。
 *
 *   java -cp tool-classes;pathing.jar;tools.jar SrcIndexTool javac.args out.json 源目录…
 *
 * 输出 JSON 由 tools/impact.mjs 消费；进度和统计打到 stdout，前缀 [SRCIDX]。
 */
public final class SrcIndexTool {

    // ── sink 表 ────────────────────────────────────────────────────────────
    // 键是**全限定方法签名**，不是方法名。坑：loadSingle 有四个重载，实体参数下标不一样，
    // loadSingle(String, String, QFilter[]) 的参数 1 是 selectFields —— 按方法名统一取下标 1，
    // 抽出来的「实体」就会是 "id,billno,billstatus,…" 这种逗号串，且不报任何错。
    // 未登记的重载不猜下标：进 unknownSigs 如实上报，条目标 dynamic。
    private static final Map<String, Sink> SINKS = new LinkedHashMap<String, Sink>();

    private static final class Sink {
        final int arg;          // 标识参数下标；-1 = 这个签名里根本没有标识参数（resolution 记 none）
        final String access;    // read | write | select（取数读）
        final String level;     // entity | field
        int select = -1;        // 取数调用的取数字段串参数下标（"id,billno,entry.zlgd_x"）
        int order = -1;         // 排序串参数下标（"zlgd_x desc"）
        String obj;             // 对象来源固定的（转换插件的源单）：直接记这个，不看调用对象
        Sink(int arg, String access, String level) {
            this.arg = arg;
            this.access = access;
            this.level = level;
        }
    }

    private static void entity(String owner, String sig, int arg, String access) {
        SINKS.put(owner + "#" + sig, new Sink(arg, access, "entity"));
    }

    /** 带取数字段串的读：字段串里的每个字段记一处"取数读"，单据取同一次调用的单据标识 */
    private static void query(String owner, String sig, int arg, int select, int order) {
        Sink s = new Sink(arg, "read", "entity");
        s.select = select;
        s.order = order;
        SINKS.put(owner + "#" + sig, s);
    }

    private static void field(String owner, String sig, int arg, String access) {
        SINKS.put(owner + "#" + sig, new Sink(arg, access, "field"));
    }

    private static void field(String owner, String sig, int arg, String access, String obj) {
        Sink s = new Sink(arg, access, "field");
        s.obj = obj;
        SINKS.put(owner + "#" + sig, s);
    }

    static {
        String bds = "kd.bos.servicehelper.BusinessDataServiceHelper";
        entity(bds, "loadSingle(Object, String)", 1, "read");
        query(bds, "loadSingle(Object, String, String)", 1, 2, -1);
        entity(bds, "loadSingle(String, QFilter[])", 0, "read");
        query(bds, "loadSingle(String, String, QFilter[])", 0, 1, -1);
        entity(bds, "loadSingle(String, String)", 0, "read");
        query(bds, "load(String, String, QFilter[])", 0, 1, -1);
        query(bds, "load(String, String, QFilter[], String)", 0, 1, 3);
        query(bds, "load(String, String, QFilter[], String, int)", 0, 1, 3);
        // 6 参这条的第 5、6 个是 pageIndex/pagesize（不是 top/start），实体与字段串下标同上面几条。
        query(bds, "load(String, String, QFilter[], String, int, int)", 0, 1, 3);
        entity(bds, "load(Object[], DynamicObjectType)", -1, "read");
        entity(bds, "newDynamicObject(String)", 0, "write");
        entity(bds, "loadFromCache(String, QFilter[])", 0, "read");
        query(bds, "loadFromCache(String, String, QFilter[])", 0, 1, -1);
        entity(bds, "loadFromCache(Object[], DynamicObjectType)", -1, "read");

        String qs = "kd.bos.servicehelper.QueryServiceHelper";
        query(qs, "query(String, String, QFilter[])", 0, 1, -1);
        query(qs, "query(String, String, QFilter[], String)", 0, 1, 3);
        query(qs, "query(String, String, QFilter[], String, int)", 0, 1, 3);
        query(qs, "queryOne(String, String, QFilter[])", 0, 1, -1);
        query(qs, "queryOne(String, String, Object)", 0, 1, -1);
        entity(qs, "queryPrimaryKeys(String, QFilter[], String, int)", 0, "read");
        query(qs, "queryDataSet(String, String, String, QFilter[], String)", 1, 2, 4);
        query(qs, "queryDataSet(String, String, String, QFilter[], String, int)", 1, 2, 4);
        entity(qs, "exists(String, Object)", 0, "read");
        entity(qs, "exists(String, QFilter[])", 0, "read");

        String ops = "kd.bos.servicehelper.operation.OperationServiceHelper";
        entity(ops, "executeOperate(String, String, DynamicObject[])", 1, "write");
        entity(ops, "executeOperate(String, String, DynamicObject[], OperateOption)", 1, "write");
        entity(ops, "executeOperate(String, String, Object[])", 1, "write");
        entity(ops, "executeOperate(String, String, Object[], OperateOption)", 1, "write");
        entity(ops, "executeOperate(String, String, List, OperateOption)", 1, "write");

        String del = "kd.bos.servicehelper.operation.DeleteServiceHelper";
        entity(del, "delete(String, QFilter[])", 0, "write");
        entity(del, "delete(String, Object[])", 0, "write");
        entity(del, "delete(IDataEntityType, Object[])", -1, "write");

        // SaveServiceHelper 的常用重载参数里没有实体标识（实体藏在 DynamicObject 的类型里）。
        // 登记成 arg=-1 而不是不登记：命中了但签名里就取不到，要如实记成 none，不能整条看不见。
        String save = "kd.bos.servicehelper.operation.SaveServiceHelper";
        entity(save, "saveOperate(String, DynamicObject[], OperateOption)", 0, "write");
        entity(save, "save(DynamicObject[])", -1, "write");
        entity(save, "save(DynamicObject[], OperateOption)", -1, "write");
        entity(save, "save(IDataEntityType, Object[])", -1, "write");
        entity(save, "save(IDataEntityType, Object[], OperateOption)", -1, "write");
        entity(save, "save(IDataEntityType, Object[], OperateOption, String)", -1, "write");
        entity(save, "update(DynamicObject[])", -1, "write");
        entity(save, "update(DynamicObject)", -1, "write");

        // 字段级：模型读写。调用点上的静态类型多半就是 IDataModel 这个接口；
        // 在实现类上调到的走 owner 的父类型链回溯（resolveSink）。
        // 分录那一组其实声明在父接口 IEntryOperate 上，方法的 owner 是它、不是 IDataModel：
        // 只按 owner 查，这一组一处都记不到（真机 74 处取分录、加行、清空全丢，也不报未登记）。
        // 所以命中还要再按**调用对象的静态类型**查一遍（receiverOf），登记就留在 IDataModel 一处。
        String model = "kd.bos.entity.datamodel.IDataModel";
        field(model, "setValue(String, Object)", 0, "write");
        field(model, "setValue(String, Object, int)", 0, "write");
        field(model, "setValue(String, Object, int, boolean)", 0, "write");
        field(model, "getValue(String)", 0, "read");
        field(model, "getValue(String, int)", 0, "read");
        field(model, "getProperty(String)", 0, "read");
        field(model, "getEntryRowEntity(String, int)", 0, "read");
        field(model, "getEntryRowEntity(String, int, int)", 0, "read");
        field(model, "getEntryEntity(String)", 0, "read");
        field(model, "getEntryEntity(String, int, int)", 0, "read");
        field(model, "getEntryRowCount(String)", 0, "read");
        field(model, "getEntryCurrentRowIndex(String)", 0, "read");
        field(model, "createNewEntryRow(String)", 0, "write");
        field(model, "createNewEntryRow(String, DynamicObject)", 0, "write");
        field(model, "createNewEntryRow(String, int, DynamicObject)", 0, "write");
        field(model, "batchCreateNewEntryRow(String, int)", 0, "write");
        field(model, "batchCreateNewEntryRow(String, DynamicObject, int)", 0, "write");
        field(model, "insertEntryRow(String, int)", 0, "write");
        field(model, "appendEntryRow(String, int, int)", 0, "write");
        field(model, "copyEntryRow(String, int[], boolean)", 0, "write");
        field(model, "moveEntryRowUp(String, int)", 0, "write");
        field(model, "moveEntryRowDown(String, int)", 0, "write");
        field(model, "deleteEntryRow(String, int)", 0, "write");
        field(model, "deleteEntryRows(String, int[])", 0, "write");
        field(model, "deleteEntryData(String)", 0, "write");

        // 字段级第二套习语：直接在数据包上存取。**只登记 IDataModel 的后果实测**：
        // 操作插件（zlgd.ygpt.opplugin 26 个类）、服务（zlgd.ygwc.service 18 个）、
        // 打印插件（zlgd.zljy.printplugin 35 个）字段引用**全是 0** —— 它们不碰模型，
        // 只碰 DynamicObject。全模块带下划线标识的字面量取值调用 1734 处，一处都收不到。
        //
        // 不怕误收 Map.get("k")：sink 按 **owner 的静态类型** 命中（resolveSink 走父类型链），
        // 调用点上是 java.util.Map 就压根不进这张表。
        String dyn = "kd.bos.dataentity.entity.DynamicObject";
        field(dyn, "get(String)", 0, "read");
        field(dyn, "getString(String)", 0, "read");
        field(dyn, "getInt(String)", 0, "read");
        field(dyn, "getLong(String)", 0, "read");
        field(dyn, "getBigDecimal(String)", 0, "read");
        field(dyn, "getBigDecimal(String, boolean)", 0, "read");
        field(dyn, "getBoolean(String)", 0, "read");
        field(dyn, "getDate(String)", 0, "read");
        field(dyn, "getLocaleString(String)", 0, "read");
        field(dyn, "getDynamicObject(String)", 0, "read");
        field(dyn, "getDynamicObjectCollection(String)", 0, "read");
        field(dyn, "getItem(String)", 0, "read");
        field(dyn, "set(String, Object)", 0, "write");
        field(dyn, "setItem(String, Object)", 0, "write");
        // 按下标/按属性对象的重载：签名里根本没有标识字符串，登记成 arg=-1 记 none。
        // 不登记的话它们会掉进「登记过的方法名上冒出没登记的重载」那条路，被记成 dynamic ——
        // 而 dynamic 的意思是「这次没解出来」，会让人以为做常量传播就能救，实测多出 53 处假 dynamic
        field(dyn, "get(IDataEntityProperty)", -1, "read");
        field(dyn, "get(int)", -1, "read");
        field(dyn, "getString(IDataEntityProperty)", -1, "read");
        field(dyn, "getString(int)", -1, "read");
        field(dyn, "getBigDecimal(IDataEntityProperty)", -1, "read");
        field(dyn, "getBigDecimal(int)", -1, "read");
        field(dyn, "set(int, Object)", -1, "write");

        // 打印插件的数据包。afterLoadData 里覆盖字段值走的就是 DataRowSet.put，
        // 不登记它，「这个打印插件改了哪个字段」这问题在索引里没有答案。
        String rowSet = "kd.bos.print.core.data.DataRowSet";
        field(rowSet, "getField(String)", 0, "read");
        field(rowSet, "getCollectionField(String)", 0, "read");
        field(rowSet, "containerKey(String)", 0, "read");
        field(rowSet, "put(String, Field)", 0, "write");
        field(rowSet, "add(String, Field)", 0, "write");
        field(rowSet, "remove(String)", 0, "write");

        // 转换插件给源单查询加字段：读的是源单，对象就是插件挂的单（转换规则的挂载同时记着源单和目标单）
        field("kd.bos.entity.botp.plugin.args.AfterBuildQueryParemeterEventArgs", "addSrcField(String)", 0,
                "select", "own");
    }

    // ── 查询条件、操作预加载 ──────────────────────────────────────────────
    // 这两类的字段名不在某个固定方法的参数里，单独认：
    //   查询条件  new QFilter("f", …)、f.and("f", …)、QFilter.isNull("f") 等；QFilter.of("f = ? and …") 从表达式里拆字段名。
    //             读的是哪张单，看这个条件对象最后交给了哪次取数（filterBill）。
    //   操作预加载 e.getFieldKeys().add("f")（操作插件声明要加载的字段），对象是插件挂的单。
    private static final String FILTER = "kd.bos.orm.query.QFilter";
    private static final Set<String> FILTER_KEY_METHODS = new HashSet<String>(Arrays.asList(
            "and", "or", "like", "likeUnEscape", "notLike", "notLikeUnEscape", "emptyOrNotExists",
            "notEqualsContainsEmpty", "notLikeContainsEmpty", "notInContainsEmpty", "isNull", "isNotNull"));
    private static final Set<String> FILTER_EXPR_METHODS = new HashSet<String>(Arrays.asList("of", "parse"));
    private static final String PRELOAD_ARGS = "kd.bos.entity.plugin.PreparePropertysEventArgs";

    /**
     * 插件基类/接口 → 插件类型。走完整父类型链（含 interfaces），所以工程自己的抽象基类
     * 照样认得出，implements 一个平台接口的也认得出。
     *
     * 这张表决定的是「源码侧知不知道这是个插件」。它认不出的类，`impact query` 只能说
     * 「不知道这是什么」——而用户 2026-09-04 的要求正好是反过来：注册位置固定、出现频率低的
     * 那几族，**源码扫到了就直接报给用户**，别等元数据侧给绑定。
     *
     * 2026-09-04 修的一处：第一行原本写的是 `AbstractOperationServicePlugin`（小写 in），
     * 苍穹的类叫 `AbstractOperationServicePlugIn`（大写 In）—— 一个字母，导致**操作插件
     * 一整族从来没被认出来过**，本工程 344 个「类型不明」里一大批 `*OpPlugin` 就是它。
     * 拼错的名字不留：它匹配不到任何真实类型，留着只会让人以为这一族已经覆盖。
     */
    private static final Map<String, String> PLUGIN_BASES = new LinkedHashMap<String, String>();

    static {
        PLUGIN_BASES.put("kd.bos.entity.plugin.AbstractOperationServicePlugIn", "op");
        PLUGIN_BASES.put("kd.bos.print.core.plugin.AbstractPrintPlugin", "print");
        //工作流和开放平台这两族是 implements 接口，不是 extends 基类
        PLUGIN_BASES.put("kd.bos.workflow.engine.extitf.IWorkflowPlugin", "workflow");
        PLUGIN_BASES.put("kd.bos.openapi.api.plugin.ApiSavePlugin", "api");
        PLUGIN_BASES.put("kd.bos.openapi.api.plugin.ApiSerializerPlugin", "api");
        PLUGIN_BASES.put("kd.bos.openapi.api.plugin.ApiDeserializerPlugin", "api");
        PLUGIN_BASES.put("kd.bos.entity.validate.AbstractValidator", "validator");
        PLUGIN_BASES.put("kd.bos.list.plugin.AbstractTreeListPlugin", "list");
        PLUGIN_BASES.put("kd.bos.list.plugin.AbstractListPlugin", "list");
        PLUGIN_BASES.put("kd.bos.entity.report.AbstractReportListDataPlugin", "report");
        PLUGIN_BASES.put("kd.bos.entity.report.AbstractReportFormPlugin", "report");
        PLUGIN_BASES.put("kd.bos.entity.botp.plugin.AbstractConvertPlugIn", "convert");
        PLUGIN_BASES.put("kd.bos.schedule.executor.AbstractTask", "task");
        PLUGIN_BASES.put("kd.bos.bill.AbstractBillPlugIn", "form");
        PLUGIN_BASES.put("kd.bos.form.plugin.AbstractFormPlugin", "form");
    }

    /**
     * 事务回滚撤不回的调用：附件、微服务、消息、HTTP、socket。按方法记下来，跑操作前的提醒顺着调用边
     * 就能看到「插件经工具类调了外部接口」—— 只扫插件自己的源文件时，这种一律漏掉
     * （真机：两个调度任务经 DateUtils 调节假日接口）。
     *
     * 键是平台类型简单名里含的那一段，值是报出去的说法；和 policy/external-effects.ts 的关键字同一套。
     */
    private static final String[][] EFFECT_TYPES = {
        {"AttachmentServiceHelper", "AttachmentServiceHelper"},
        {"DispatchService", "DispatchService"},
        {"MessagePublisher", "MessagePublisher"},
        {"MQFactory", "MQFactory"},
        {"HttpClient", "HttpClient"},
        {"HttpURLConnection", "HttpURLConnection"},
    };
    private static final String[][] EFFECT_METHODS = {
        {"openConnection", "openConnection"},
        {"sendMessage", "sendMessage"},
    };

    // ── 采集结果 ───────────────────────────────────────────────────────────
    private static final List<String[]> classRows = new ArrayList<String[]>();
    /** 外部调用：所在类、所在方法、行号、说法 */
    private static final List<Object[]> effectRows = new ArrayList<Object[]>();
    private static final List<Object[]> entityRows = new ArrayList<Object[]>();
    private static final List<Object[]> fieldRows = new ArrayList<Object[]>();
    private static final Set<String> unknownSigs = new TreeSet<String>();
    /**
     * 模块内的调用边：`调用方方法 → 被调方方法`，去重后进 JSON。跨类调用链回溯
     * （插件 A 调 FormUtil.setXxx()、工具类里才 setValue）靠它。
     *
     * 坑：**边按方法建，不能按类建。** 工具类一个类里几十个方法各碰各的单据，按类传播
     * 等于宣称调用者碰了这个工具类碰过的全部实体。
     */
    private static final Map<String, String[]> edgeRows = new LinkedHashMap<String, String[]>();
    /**
     * 调本工程方法时传了什么：调用方方法、被调方法、调用方最外层类、行号、各实参的来源（originOf 的写法，
     * 字符串实参是常量时记 `key:值`）。只在至少一个实参记得出来源时才留一行。
     *
     * 工具方法里的数据包、界面模型、字段名是参数传进来的，单看工具方法认不出是哪张单、哪个字段；
     * 查询时沿调用边到调用处，拿这里记的实参接着追。
     */
    private static final List<Object[]> callRows = new ArrayList<Object[]>();
    /** 最外层方法 → 方法体里各局部变量的赋值来源；一个方法只扫一遍 */
    private static final Map<Tree, Defs> defsCache = new HashMap<Tree, Defs>();
    /** 本模块声明的全部类型（含嵌套）。边只在被调方也有源码时才记 —— kd.* 那侧追不下去 */
    private static final Set<String> declaredTypes = new HashSet<String>();
    private static final Map<String, Set<String>> supersCache = new HashMap<String, Set<String>>();
    /**
     * `所有者#方法名`（不含参数）。命中它但签名没登记 = 真的漏了一个重载，要上报。
     *
     * 坑：不能拿「所有者类」当这一层的判据。IDataModel 有上百个方法，按类判会把
     * getDataEntity() / setDataChanged() 这些压根不是 sink 的调用全部当成「未登记重载」，
     * 一次全量报出 117 条假 dynamic，把真正漏掉的那一个（saveOperate）埋掉。
     */
    private static final Set<String> WATCHED_NAMES = new HashSet<String>();
    private static int calls = 0;
    private static int bound = 0;
    private static int unbound = 0;

    static {
        for (String k : SINKS.keySet()) {
            WATCHED_NAMES.add(k.substring(0, k.indexOf('(')));
        }
    }

    public static void main(String[] argv) throws Exception {
        if (argv.length < 3) {
            System.out.println("[SRCIDX-ERR] 用法: SrcIndexTool <javac.args> <out.json> <源目录…>");
            System.exit(2);
        }
        File argfile = new File(argv[0]);
        File out = new File(argv[1]);
        List<File> roots = new ArrayList<File>();
        for (int i = 2; i < argv.length; i++) {
            roots.add(new File(argv[i]));
        }

        List<File> srcFiles = new ArrayList<File>();
        for (File r : roots) {
            collect(r, srcFiles);
        }
        if (srcFiles.isEmpty()) {
            System.out.println("[SRCIDX-ERR] 源目录下没有 .java：" + roots);
            System.exit(2);
        }
        System.out.println("[SRCIDX] 待分析 " + srcFiles.size() + " 个 .java");

        // 坑：JDK8 的 ToolProvider 按 java.home/../lib/tools.jar 找编译器，**不看 -cp**。
        // PATH 上的 java 来自独立 JRE 时那个路径不存在，getSystemJavaCompiler() 返回 null
        // 且不抛异常 —— 空指针要到下一行才炸。tools.jar 已挂在 -cp，直接反射拿。
        JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
        if (compiler == null) {
            try {
                Class<?> c = Class.forName("com.sun.tools.javac.api.JavacTool");
                compiler = (JavaCompiler) c.getMethod("create").invoke(null);
            } catch (Throwable t) {
                System.out.println("[SRCIDX-ERR] 拿不到编译器：ToolProvider 返回 null，反射 JavacTool 也失败 —— " + t);
                System.out.println("[SRCIDX-ERR] 把 JAVA_HOME 指向 JDK（不是 JRE）再试");
                System.exit(2);
            }
        }

        String cp = readClasspath(argfile);
        if (cp == null) {
            System.out.println("[SRCIDX-ERR] " + argfile.getPath() + " 里读不到 -cp，先跑 driver.mjs build");
            System.exit(2);
        }
        int cpEntries = cp.split(Pattern.quote(File.pathSeparator)).length;
        System.out.println("[SRCIDX] classpath " + cpEntries + " 条目 / " + cp.length() + " 字符");

        DiagnosticCollector<JavaFileObject> diags = new DiagnosticCollector<JavaFileObject>();
        StandardJavaFileManager fm = compiler.getStandardFileManager(diags, null, StandardCharsets.UTF_8);
        Iterable<? extends JavaFileObject> units = fm.getJavaFileObjectsFromFiles(srcFiles);
        List<String> opts = Arrays.asList("-cp", cp, "-proc:none", "-encoding", "UTF-8",
                "-source", "8", "-target", "8", "-nowarn");

        long t0 = System.currentTimeMillis();
        JavacTask task = (JavacTask) compiler.getTask(null, fm, diags, opts, null, units);
        Iterable<? extends CompilationUnitTree> asts = task.parse();
        task.analyze();   // 事实：符号绑定发生在 analyze()，只 parse() 时 getElement() 还返回 null
        long ms = System.currentTimeMillis() - t0;

        int errs = 0;
        List<String> errSample = new ArrayList<String>();
        for (Diagnostic<? extends JavaFileObject> d : diags.getDiagnostics()) {
            if (d.getKind() != Diagnostic.Kind.ERROR) {
                continue;
            }
            errs++;
            if (errSample.size() < 5) {
                String src = d.getSource() == null ? "?" : new File(d.getSource().getName()).getName();
                errSample.add(src + ":" + d.getLineNumber() + " " + d.getMessage(null));
            }
        }
        System.out.println("[SRCIDX] parse+analyze " + ms + "ms，ERROR 诊断 " + errs + " 条");
        for (String s : errSample) {
            System.out.println("[SRCIDX]   " + s);
        }

        final Trees trees = Trees.instance(task);
        final File base = new File(System.getProperty("user.dir"));

        // 先把模块内声明的类型收全再扫调用：扫描按编译单元逐个走，边扫边收会让排在后面的
        // 类漏掉边（表现是「工具类被调用了却没有边」，不报任何错）
        for (CompilationUnitTree cu : asts) {
            for (Tree decl : cu.getTypeDecls()) {
                if (decl instanceof ClassTree) {
                    Element e = trees.getElement(new TreePath(new TreePath(cu), decl));
                    if (e instanceof TypeElement) {
                        collectTypes((TypeElement) e);
                    }
                }
            }
        }
        for (CompilationUnitTree cu : asts) {
            final CompilationUnitTree unit = cu;
            final String file = relative(base, new File(unit.getSourceFile().getName()));
            final SourcePositions pos = trees.getSourcePositions();
            for (Tree decl : unit.getTypeDecls()) {
                if (!(decl instanceof ClassTree)) {
                    continue;
                }
                Element e = trees.getElement(new TreePath(new TreePath(unit), decl));
                if (e instanceof TypeElement) {
                    TypeElement te = (TypeElement) e;
                    classRows.add(new String[]{te.getQualifiedName().toString(), file, pluginTypeOf(te)});
                }
            }
            new TreePathScanner<Void, Void>() {
                @Override
                public Void visitMethodInvocation(MethodInvocationTree node, Void p) {
                    calls++;
                    TreePath mp = new TreePath(getCurrentPath(), node.getMethodSelect());
                    Element el = trees.getElement(mp);
                    if (el instanceof ExecutableElement) {
                        bound++;
                        ExecutableElement m = (ExecutableElement) el;
                        String owner = ownerOf(m);
                        String sig = signatureOf(m);
                        if (declaredTypes.contains(owner)) {
                            List<TreePath> sites = callSites.get(m);
                            if (sites == null) {
                                sites = new ArrayList<TreePath>();
                                callSites.put(m, sites);
                            }
                            sites.add(getCurrentPath());
                            String from = enclosingMethodId(trees, getCurrentPath());
                            String to = owner + "#" + sig;
                            if (from != null && !from.equals(to)) {
                                // 同一对方法只留一条边：记第一处调用的行号和总次数，查字段时按行号逐层报路径
                                String key = from + " " + to;
                                String[] prev = edgeRows.get(key);
                                if (prev != null) {
                                    prev[5] = String.valueOf(Integer.parseInt(prev[5]) + 1);
                                } else {
                                    int at = (int) unit.getLineMap()
                                            .getLineNumber(pos.getStartPosition(unit, node));
                                    edgeRows.put(key, new String[]{from, to,
                                            topClass(trees, getCurrentPath()), topOf(m), String.valueOf(at), "1"});
                                }
                                String[] args = argOrigins(trees, getCurrentPath(), node, m);
                                if (args != null) {
                                    int at = (int) unit.getLineMap()
                                            .getLineNumber(pos.getStartPosition(unit, node));
                                    callRows.add(new Object[]{from, to, topClass(trees, getCurrentPath()), at, args});
                                }
                            }
                        }
                        String recv = receiverOf(trees, getCurrentPath(), node);
                        Sink sink = resolveSink(owner, sig, recv);
                        boolean missed = sink == null && isUnregisteredOverload(owner, sig, recv);
                        if (!declaredTypes.contains(owner)) {
                            String effect = effectOf(owner, m.getSimpleName().toString());
                            if (effect != null) {
                                addEffect(trees, getCurrentPath(), unit, pos, node, effect);
                            }
                        }
                        if (sink != null || missed) {
                            int line = (int) unit.getLineMap()
                                    .getLineNumber(pos.getStartPosition(unit, node));
                            if (sink != null) {
                                record(trees, getCurrentPath(), node, sink, simple(owner) + "#" + sig, line);
                            } else {
                                // 登记过的方法名上冒出没登记的重载：如实上报，**不猜下标**
                                unknownSigs.add(owner + "#" + sig);
                                entityRows.add(new Object[]{topClass(trees, getCurrentPath()), null,
                                        "unknown", "dynamic", simple(owner) + "#" + sig, line,
                                        "(未登记的重载)", enclosingMethodId(trees, getCurrentPath())});
                            }
                        }
                        if (FILTER.equals(owner)) {
                            recordFilter(trees, getCurrentPath(), node, m, node.getArguments(),
                                    lineOf(unit, pos, node.getMethodSelect(), true));
                        } else if (isListAdd(node, m)) {
                            // 是不是往操作预加载的字段列表里加，扫完全部源码再认：列表可能经参数传给自己的方法
                            pendingPreloads.add(new Object[]{getCurrentPath(), node, m,
                                    lineOf(unit, pos, node.getMethodSelect(), true)});
                        }
                    } else {
                        unbound++;
                    }
                    return super.visitMethodInvocation(node, p);
                }

                @Override
                public Void visitNewClass(NewClassTree node, Void p) {
                    Element el = trees.getElement(getCurrentPath());
                    if (el instanceof ExecutableElement) {
                        String owner = ownerOf((ExecutableElement) el);
                        if (FILTER.equals(owner)) {
                            recordFilter(trees, getCurrentPath(), node, (ExecutableElement) el, node.getArguments(),
                                    lineOf(unit, pos, node, false));
                        }
                        String effect = "Socket".equals(simple(owner)) ? "new Socket" : null;
                        if (effect == null && !declaredTypes.contains(owner)) {
                            effect = effectOf(owner, "");
                        }
                        if (effect != null) {
                            addEffect(trees, getCurrentPath(), unit, pos, node, effect);
                        }
                    }
                    return super.visitNewClass(node, p);
                }
            }.scan(new TreePath(cu), null);
        }

        settleFilters(trees);
        settlePreloads(trees);
        writeJson(out, srcFiles.size(), cpEntries, ms, errs, errSample);
        System.out.println("[SRCIDX] 方法调用 " + calls + " 处，绑到 Symbol " + bound + "，未绑定 " + unbound);
        System.out.println("[SRCIDX] 实体引用 " + entityRows.size() + " 处 / 字段引用 " + fieldRows.size()
                + " 处，未登记重载 " + unknownSigs.size() + " 个");
        System.out.println("[SRCIDX] 模块内调用边 " + edgeRows.size() + " 条（去重后），外部调用 "
                + effectRows.size() + " 处");
        System.out.println("[SRCIDX] 已写 " + out.getPath());
    }

    // ── sink 命中 ──────────────────────────────────────────────────────────
    /**
     * 查登记表时依次看的类型：方法声明在哪（owner）和它的父类型链，再是调用对象的静态类型和它的父类型链。
     * 后一半是给「登记在子接口、方法声明在父接口」的情形：`getModel().getEntryEntity(..)` 的 owner 是
     * IEntryOperate，调用对象是 IDataModel。
     */
    private static List<String> lookupTypes(String owner, String recv) {
        List<String> out = new ArrayList<String>();
        out.add(owner);
        Set<String> supers = supersCache.get(owner);
        if (supers != null) {
            out.addAll(supers);
        }
        if (recv != null && !recv.equals(owner)) {
            out.add(recv);
            Set<String> up = supersCache.get(recv);
            if (up != null) {
                out.addAll(up);
            }
        }
        return out;
    }

    /** 方法名在 sink 表里（按 lookupTypes 的类型），但这个签名没登记 —— 就是漏了一个重载 */
    private static boolean isUnregisteredOverload(String owner, String sig, String recv) {
        String name = sig.substring(0, sig.indexOf('('));
        for (String type : lookupTypes(owner, recv)) {
            if (WATCHED_NAMES.contains(type + "#" + name)) {
                return true;
            }
        }
        return false;
    }

    /** 按 lookupTypes 的顺序找第一个登记了这个签名的类型。 */
    private static Sink resolveSink(String owner, String sig, String recv) {
        for (String type : lookupTypes(owner, recv)) {
            Sink s = SINKS.get(type + "#" + sig);
            if (s != null) {
                return s;
            }
        }
        return null;
    }

    /** `a.b(..)` 里 a 的静态类型（全限定名）；没有显式调用对象、或类型不是类/接口时为 null。 */
    private static String receiverOf(Trees trees, TreePath path, MethodInvocationTree node) {
        if (!(node.getMethodSelect() instanceof MemberSelectTree)) {
            return null;
        }
        MemberSelectTree sel = (MemberSelectTree) node.getMethodSelect();
        TypeMirror t = trees.getTypeMirror(new TreePath(new TreePath(path, sel), sel.getExpression()));
        Element e = t == null ? null : elementOf(t);
        if (!(e instanceof TypeElement)) {
            return null;
        }
        TypeElement te = (TypeElement) e;
        String fqn = te.getQualifiedName().toString();
        if (!supersCache.containsKey(fqn)) {
            supersCache.put(fqn, ancestorsOf(te));
        }
        return fqn;
    }

    /** 平台或 JDK 类型上的一次调用 / 构造算不算外部调用；算的话返回说法。 */
    private static String effectOf(String owner, String method) {
        String type = simple(owner);
        for (String[] e : EFFECT_TYPES) {
            if (type.contains(e[0])) {
                return e[1];
            }
        }
        for (String[] e : EFFECT_METHODS) {
            if (e[0].equals(method)) {
                return e[1];
            }
        }
        return null;
    }

    private static void addEffect(Trees trees, TreePath path, CompilationUnitTree unit, SourcePositions pos,
                                  Tree node, String effect) {
        int line = (int) unit.getLineMap().getLineNumber(pos.getStartPosition(unit, node));
        effectRows.add(new Object[]{topClass(trees, path), enclosingMethodId(trees, path), line, effect});
    }

    private static String ownerOf(ExecutableElement m) {
        Element owner = m.getEnclosingElement();
        if (!(owner instanceof TypeElement)) {
            return "?";
        }
        TypeElement te = (TypeElement) owner;
        String fqn = te.getQualifiedName().toString();
        if (!supersCache.containsKey(fqn)) {
            supersCache.put(fqn, ancestorsOf(te));
        }
        return fqn;
    }

    private static String signatureOf(ExecutableElement m) {
        StringBuilder sb = new StringBuilder(m.getSimpleName()).append('(');
        List<? extends VariableElement> ps = m.getParameters();
        for (int i = 0; i < ps.size(); i++) {
            if (i > 0) {
                sb.append(", ");
            }
            sb.append(simpleType(ps.get(i).asType().toString()));
        }
        return sb.append(')').toString();
    }

    /** kd.bos.orm.query.QFilter[] -> QFilter[]；java.util.List&lt;String&gt; -> List */
    private static String simpleType(String t) {
        int lt = t.indexOf('<');
        String tail = "";
        if (lt >= 0) {
            int close = t.lastIndexOf('>');
            tail = close >= 0 ? t.substring(close + 1) : "";
            t = t.substring(0, lt);
        }
        return t.substring(t.lastIndexOf('.') + 1) + tail;
    }

    private static String simple(String fqn) {
        return fqn.substring(fqn.lastIndexOf('.') + 1);
    }

    private static Set<String> ancestorsOf(TypeElement te) {
        Set<String> out = new LinkedHashSet<String>();
        walkSupers(te, out, 0);
        return out;
    }

    private static void walkSupers(TypeElement te, Set<String> out, int depth) {
        if (depth > 12) {
            return;
        }
        List<TypeMirror> ups = new ArrayList<TypeMirror>();
        if (te.getSuperclass() != null) {
            ups.add(te.getSuperclass());
        }
        ups.addAll(te.getInterfaces());
        for (TypeMirror tm : ups) {
            String fqn = tm.toString();
            int lt = fqn.indexOf('<');
            if (lt >= 0) {
                fqn = fqn.substring(0, lt);
            }
            if (fqn.isEmpty() || "none".equals(fqn) || !out.add(fqn)) {
                continue;
            }
            Element e = elementOf(tm);
            if (e instanceof TypeElement) {
                walkSupers((TypeElement) e, out, depth + 1);
            }
        }
    }

    private static Element elementOf(TypeMirror tm) {
        return tm instanceof DeclaredType ? ((DeclaredType) tm).asElement() : null;
    }

    private static String pluginTypeOf(TypeElement te) {
        Set<String> supers = ancestorsOf(te);
        for (Map.Entry<String, String> e : PLUGIN_BASES.entrySet()) {
            if (supers.contains(e.getKey())) {
                return e.getValue();
            }
        }
        return null;
    }

    /** 递归收下这个类型和它的嵌套类型 */
    private static void collectTypes(TypeElement te) {
        if (!declaredTypes.add(te.getQualifiedName().toString())) {
            return;
        }
        for (Element e : te.getEnclosedElements()) {
            if (e instanceof TypeElement) {
                collectTypes((TypeElement) e);
            }
        }
    }

    /**
     * 归属到**最外层的那个方法**（跟 topClass 一个口径）：调用写在匿名内部类里时，
     * 外面调这个方法的人得能顺着边走进来
     */
    private static String enclosingMethodId(Trees trees, TreePath path) {
        TreePath outer = null;
        for (TreePath p = path; p != null; p = p.getParentPath()) {
            if (p.getLeaf().getKind() == Tree.Kind.METHOD) {
                outer = p;
            }
        }
        if (outer == null) {
            return null;
        }
        Element e = trees.getElement(outer);
        if (!(e instanceof ExecutableElement)) {
            return null;
        }
        ExecutableElement m = (ExecutableElement) e;
        return ownerOf(m) + "#" + signatureOf(m);
    }

    /** 被调方法所在的最外层类 */
    private static String topOf(ExecutableElement m) {
        Element e = m.getEnclosingElement();
        TypeElement te = null;
        while (e instanceof TypeElement) {
            te = (TypeElement) e;
            e = e.getEnclosingElement();
        }
        return te == null ? "?" : te.getQualifiedName().toString();
    }

    /** 归属到**最外层类**：说「改 QTYWTDOpPlugin」的人指的是那个文件，不是里面的匿名内部类 */
    private static String topClass(Trees trees, TreePath path) {
        TreePath outer = null;
        for (TreePath p = path; p != null; p = p.getParentPath()) {
            Tree.Kind k = p.getLeaf().getKind();
            if (k == Tree.Kind.CLASS || k == Tree.Kind.INTERFACE || k == Tree.Kind.ENUM) {
                outer = p;
            }
        }
        if (outer == null) {
            return "?";
        }
        Element e = trees.getElement(outer);
        return e instanceof TypeElement ? ((TypeElement) e).getQualifiedName().toString() : "?";
    }

    /**
     * 标识参数四态，解不出的必须留下来、不能静默丢：
     *
     *   literal / constant  解出来了
     *   none                **签名里根本没有标识参数**（SaveServiceHelper.save(DynamicObject[])），
     *                       再强的分析也变不出来 —— 这是 sink 表的能力边界，不是这次没解出来
     *   dynamic             有标识参数但不是编译期常量，expr 留原文，属于「还能再追」的那一档
     *
     * none 和 dynamic 必须分开：混一个桶时 158 处 save() 会把真正值得追的几十处表达式淹掉，
     * 而两者的下一步动作完全不同（前者要扩 sink 表或换判据，后者要做常量传播）。
     */
    private static void record(Trees trees, TreePath path, MethodInvocationTree node,
                               Sink sink, String via, int line) {
        String cls = topClass(trees, path);
        String inM = enclosingMethodId(trees, path);
        boolean isField = !"entity".equals(sink.level);
        List<Object[]> rows = isField ? fieldRows : entityRows;
        // 字段读写多记一列：读写的对象从哪来（originOf），查询时据此归到哪张单
        String obj = null;
        if (!isField && (sink.select >= 0 || sink.order >= 0)) {
            recordSelect(trees, path, node, sink, via, line, cls, inM);
        }
        if (isField && sink.obj != null) {
            obj = sink.obj;
        } else if (isField) {
            obj = node.getMethodSelect() instanceof MemberSelectTree
                    ? originOf(trees, receiverPath(path, node), 0)
                    : "?:没有调用对象";
        } else if (sink.arg < 0 && !node.getArguments().isEmpty()) {
            // save(数组)、update(对象)：签名里没有单据标识，写的是哪张单看存的那批对象从哪来；
            // 带类型参数的（load(ids, 类型)、save(类型, …)）看类型
            int at = 0;
            Element el = trees.getElement(new TreePath(path, node.getMethodSelect()));
            if (el instanceof ExecutableElement) {
                List<? extends VariableElement> ps = ((ExecutableElement) el).getParameters();
                for (int i = 0; i < ps.size() && i < node.getArguments().size(); i++) {
                    String t = ps.get(i).asType().toString();
                    if (t.endsWith("DynamicObjectType") || t.endsWith("IDataEntityType")) {
                        at = i;
                        break;
                    }
                }
            }
            obj = originOf(trees, new TreePath(path, node.getArguments().get(at)), 0);
        }
        if (sink.arg < 0 || node.getArguments().size() <= sink.arg) {
            rows.add(new Object[]{cls, null, sink.access, "none", via, line, "(签名里没有标识参数)", inM, obj, null});
            return;
        }
        ExpressionTree arg = node.getArguments().get(sink.arg);
        String key = keyOf(trees, path, arg);
        if (key != null) {
            boolean literal = arg instanceof LiteralTree;
            rows.add(new Object[]{cls, key, sink.access, literal ? "literal" : "constant", via, line,
                    literal ? null : exprName(trees, path, arg), inM, obj, null});
            return;
        }
        List<String> keys = isField ? arrayKeys(trees, path, arg) : null;
        if (keys != null) {
            for (String k : keys) {
                rows.add(new Object[]{cls, k, sink.access, "constant", via, line, snippet(arg), inM, obj, null});
            }
            return;
        }
        // 字段名是外层方法的参数：查询时到调用处看传进来的是哪个常量（包装方法写字段）
        String keyFrom = paramOf(trees, new TreePath(path, arg));
        rows.add(new Object[]{cls, null, sink.access, "dynamic", via, line, snippet(arg), inM, obj, keyFrom});
    }

    /** 常量参数在表里留的写法：单个常量留常量名，拼起来的（`KEY_ORG + ".number"`）留原文 */
    private static String exprName(Trees trees, TreePath path, ExpressionTree arg) {
        Element e = trees.getElement(new TreePath(path, arg));
        return e instanceof VariableElement ? e.getSimpleName().toString() : snippet(arg);
    }

    /**
     * 字面量或编译期常量的值；都不是时为 null。常量拼接（`KEY_ORG + ".number"`、`"zlgd_y" + 1`）
     * 也是编译期常量，按 Java 的规则拼出来。
     */
    private static String keyOf(Trees trees, TreePath path, ExpressionTree arg) {
        if (arg instanceof LiteralTree) {
            Object v = ((LiteralTree) arg).getValue();
            return v == null ? null : String.valueOf(v);
        }
        if (arg instanceof ParenthesizedTree) {
            return keyOf(trees, path, ((ParenthesizedTree) arg).getExpression());
        }
        if (arg.getKind() == Tree.Kind.PLUS) {
            BinaryTree b = (BinaryTree) arg;
            String l = keyOf(trees, path, b.getLeftOperand());
            String r = l == null ? null : keyOf(trees, path, b.getRightOperand());
            return r == null ? null : l + r;
        }
        Element e = trees.getElement(new TreePath(path, arg));
        if (e instanceof VariableElement) {
            Object cv = ((VariableElement) e).getConstantValue();
            return cv == null ? null : String.valueOf(cv);
        }
        return null;
    }

    /**
     * 字段名从常量数组里取：`for (String k : KEYS) getValue(k)`、`for (String[] row : ROWS) setValue(row[2], …)`、
     * `KEYS[1]`。循环把数组里的每一个都走一遍，所以每个名字都算这一行读写过；数组得是 final 字段、
     * 初始值全是字面量或常量。下标不是字面量又不在遍历整个数组的循环里（`KEYS[i]`）不认，照旧记 dynamic。
     */
    private static List<String> arrayKeys(Trees trees, TreePath path, ExpressionTree arg) {
        List<Object> values = arrayValues(trees, path, arg, 0);
        if (values == null || values.isEmpty()) {
            return null;
        }
        Set<String> keys = new LinkedHashSet<String>();
        for (Object v : values) {
            if (!(v instanceof String)) {
                return null;
            }
            keys.add((String) v);
        }
        return new ArrayList<String>(keys);
    }

    /** 表达式会取到的每一个值：字符串，或数组（List）；认不出时为 null */
    private static List<Object> arrayValues(Trees trees, TreePath path, ExpressionTree expr, int depth) {
        if (depth > 4) {
            return null;
        }
        if (expr instanceof ParenthesizedTree) {
            return arrayValues(trees, path, ((ParenthesizedTree) expr).getExpression(), depth + 1);
        }
        if (expr instanceof TypeCastTree) {
            return arrayValues(trees, path, ((TypeCastTree) expr).getExpression(), depth + 1);
        }
        if (expr instanceof ArrayAccessTree) {
            ArrayAccessTree access = (ArrayAccessTree) expr;
            Object index = access.getIndex() instanceof LiteralTree ? ((LiteralTree) access.getIndex()).getValue() : null;
            List<Object> arrays = index instanceof Integer
                    ? arrayValues(trees, path, access.getExpression(), depth + 1) : null;
            if (arrays == null) {
                return null;
            }
            List<Object> out = new ArrayList<Object>();
            for (Object a : arrays) {
                if (!(a instanceof List) || (Integer) index >= ((List<?>) a).size()) {
                    return null;
                }
                out.add(((List<?>) a).get((Integer) index));
            }
            return out;
        }
        String key = keyOf(trees, path, expr);
        if (key != null) {
            return new ArrayList<Object>(Arrays.asList(key));
        }
        Element e = trees.getElement(new TreePath(path, expr));
        if (!(e instanceof VariableElement)) {
            return null;
        }
        if (e.getKind() == ElementKind.FIELD && e.getModifiers().contains(Modifier.FINAL)) {
            TreePath decl = trees.getPath(e);
            if (decl == null || !(decl.getLeaf() instanceof VariableTree)) {
                return null;
            }
            ExpressionTree init = ((VariableTree) decl.getLeaf()).getInitializer();
            List<Object> array = init instanceof NewArrayTree ? arrayOf(trees, decl, (NewArrayTree) init) : null;
            return array == null ? null : new ArrayList<Object>(Arrays.asList((Object) array));
        }
        if (e.getKind() == ElementKind.LOCAL_VARIABLE) {
            // 增强 for 的循环变量：取遍被遍历数组里的每一项
            for (TreePath p = path; p != null; p = p.getParentPath()) {
                if (!(p.getLeaf() instanceof EnhancedForLoopTree)) {
                    continue;
                }
                EnhancedForLoopTree loop = (EnhancedForLoopTree) p.getLeaf();
                if (!e.equals(trees.getElement(new TreePath(p, loop.getVariable())))) {
                    continue;
                }
                List<Object> arrays = arrayValues(trees, p, loop.getExpression(), depth + 1);
                if (arrays == null) {
                    return null;
                }
                List<Object> out = new ArrayList<Object>();
                for (Object a : arrays) {
                    if (!(a instanceof List)) {
                        return null;
                    }
                    out.addAll((List<?>) a);
                }
                return out;
            }
        }
        return null;
    }

    /** `{"a", "b"}`、`new String[][]{{"a", "b"}, …}` 的内容；有一格不是常量就是 null */
    private static List<Object> arrayOf(Trees trees, TreePath path, NewArrayTree init) {
        if (init.getInitializers() == null) {
            return null;
        }
        List<Object> out = new ArrayList<Object>();
        for (ExpressionTree item : init.getInitializers()) {
            Object v = item instanceof NewArrayTree ? arrayOf(trees, path, (NewArrayTree) item) : keyOf(trees, path, item);
            if (v == null) {
                return null;
            }
            out.add(v);
        }
        return out;
    }

    /** 和 keyOf 一样，另外认只赋过一次值、值是常量的局部变量（`String fields = "id,billno"; load(X, fields, …)`） */
    private static String constString(Trees trees, TreePath p, int depth) {
        String key = keyOf(trees, p.getParentPath(), (ExpressionTree) p.getLeaf());
        if (key != null || depth > 4) {
            return key;
        }
        Element e = trees.getElement(p);
        TreePath outer = outerMethod(p);
        if (!(e instanceof VariableElement) || e.getKind() != ElementKind.LOCAL_VARIABLE || outer == null) {
            return null;
        }
        List<TreePath> defs = defsOf(trees, outer).defs.get(e);
        return defs == null || defs.size() != 1 ? null : constString(trees, defs.get(0), depth + 1);
    }

    private static int lineOf(CompilationUnitTree unit, SourcePositions pos, Tree t, boolean end) {
        long at = end ? pos.getEndPosition(unit, t) : -1;
        if (at < 0) {
            at = pos.getStartPosition(unit, t);
        }
        return (int) unit.getLineMap().getLineNumber(at);
    }

    // ── 取数字段串、查询条件、操作预加载 ──────────────────────────────────
    private static final Pattern SELECT_ITEM = Pattern.compile(
            "([A-Za-z_][A-Za-z0-9_]*(?:\\.[A-Za-z_][A-Za-z0-9_]*)*)(?:\\s+(?:as\\s+)?[A-Za-z_][A-Za-z0-9_]*)?",
            Pattern.CASE_INSENSITIVE);
    private static final Pattern CONDITION_FIELD = Pattern.compile(
            "([A-Za-z_][A-Za-z0-9_]*(?:\\.[A-Za-z_][A-Za-z0-9_]*)*)\\s*(?:=|<>|!=|>=|<=|<|>|(?i:not|like|in|is)\\b)");
    private static final Set<String> SQL_WORDS = new HashSet<String>(Arrays.asList(
            "and", "or", "not", "null", "is", "in", "like", "distinct", "case", "when", "then", "else", "end"));

    /** 取数字段串、排序串里的字段：逗号分开，每段是字段路径，可带别名或 asc/desc；函数、表达式不算 */
    private static List<String> fieldsInSelect(String text) {
        List<String> out = new ArrayList<String>();
        for (String piece : text.split(",")) {
            Matcher m = SELECT_ITEM.matcher(piece.trim());
            if (m.matches() && !SQL_WORDS.contains(m.group(1).toLowerCase()) && !out.contains(m.group(1))) {
                out.add(m.group(1));
            }
        }
        return out;
    }

    /** QFilter.of("zlgd_x = ? and billstatus = 'C'") 里比较符左边的字段 */
    private static List<String> fieldsInCondition(String text) {
        List<String> out = new ArrayList<String>();
        Matcher m = CONDITION_FIELD.matcher(text.replaceAll("'[^']*'", "''"));
        while (m.find()) {
            String f = m.group(1);
            if (!SQL_WORDS.contains(f.toLowerCase()) && !out.contains(f)) {
                out.add(f);
            }
        }
        return out;
    }

    /** load(X, "a,b", …) 的取数字段串、排序串：每个字段记一处"取数读"，单据取这次调用的 */
    private static void recordSelect(Trees trees, TreePath path, MethodInvocationTree node, Sink sink,
                                     String via, int line, String cls, String inM) {
        String bill = entityOrigin(trees, path, node, sink, ((ExecutableElement) trees.getElement(
                new TreePath(path, node.getMethodSelect()))).getSimpleName().toString());
        for (int at : new int[]{sink.select, sink.order}) {
            if (at < 0 || at >= node.getArguments().size()) {
                continue;
            }
            ExpressionTree arg = node.getArguments().get(at);
            String text = constString(trees, new TreePath(path, arg), 0);
            if (text == null) {
                continue;
            }
            boolean literal = arg instanceof LiteralTree;
            for (String key : fieldsInSelect(text)) {
                fieldRows.add(new Object[]{cls, key, "select", literal ? "literal" : "constant", via, line,
                        literal ? null : snippet(arg), inM, bill, null});
            }
        }
    }

    /** 取数、新建调用读写的是哪张单：单据标识参数是常量就是那张，是外层方法的参数记 billparam:N */
    private static String entityOrigin(Trees trees, TreePath p, MethodInvocationTree node, Sink sink, String name) {
        if (sink.arg < 0 || node.getArguments().size() <= sink.arg) {
            return "?:" + name + " 签名里没有单据标识";
        }
        ExpressionTree arg = node.getArguments().get(sink.arg);
        String key = keyOf(trees, p, arg);
        if (key != null) {
            return "bill:" + key;
        }
        // 单据标识是外层方法的参数：查询时到调用处看传的是哪个常量
        String param = paramOf(trees, new TreePath(p, arg));
        return param != null ? "bill" + param : "?:" + name + " 的单据标识不是常量";
    }

    /**
     * 查询条件里的字段：new QFilter("f", …)、x.and("f", …)、QFilter.isNull("f")、QFilter.of("f = ?")。
     * 字段名是常量的记下；是外层方法参数的记 dynamic + keyFrom，到调用处展开；别的变量不记。
     */
    private static void recordFilter(Trees trees, TreePath path, Tree node, ExecutableElement m,
                                     List<? extends ExpressionTree> args, int line) {
        String name = m.getSimpleName().toString();
        boolean ctor = m.getKind() == ElementKind.CONSTRUCTOR;
        boolean expr = FILTER_EXPR_METHODS.contains(name);
        List<? extends VariableElement> ps = m.getParameters();
        if (args.isEmpty() || ps.isEmpty() || !"java.lang.String".equals(ps.get(0).asType().toString())
                || !(ctor || expr || FILTER_KEY_METHODS.contains(name))) {
            return;
        }
        String cls = topClass(trees, path);
        String inM = enclosingMethodId(trees, path);
        String sig = signatureOf(m);
        String via = "QFilter#" + (ctor ? "new QFilter" + sig.substring(sig.indexOf('(')) : sig);
        ExpressionTree arg = args.get(0);
        TreePath at = new TreePath(path, arg);
        String text = constString(trees, at, 0);
        // 用在哪张单（filterBill）等全部源码扫完再认：条件可能加进调用方传进来的集合，要知道谁调了这个方法
        if (text == null) {
            String keyFrom = expr ? null : paramOf(trees, at);
            if (keyFrom != null) {
                Object[] row = {cls, null, "filter", "dynamic", via, line, snippet(arg), inM, null, keyFrom};
                fieldRows.add(row);
                pendingFilters.add(new Object[]{row, path});
            }
            return;
        }
        boolean literal = arg instanceof LiteralTree;
        List<String> keys = expr ? fieldsInCondition(text) : Arrays.asList(text);
        for (String key : keys) {
            Object[] row = {cls, key, "filter", literal ? "literal" : "constant", via, line,
                    literal ? null : exprName(trees, path, arg), inM, null, null};
            fieldRows.add(row);
            pendingFilters.add(new Object[]{row, path});
        }
    }

    /** 还没认单据的查询条件读写：{行, 条件表达式的路径}，扫完全部源码后由 settleFilters 填上 */
    private static final List<Object[]> pendingFilters = new ArrayList<Object[]>();
    /** 本工程方法 → 调用它的各处（扫描时收）；条件加进参数集合时，到这些调用处看调用方的集合交给了谁 */
    private static final Map<Element, List<TreePath>> callSites = new HashMap<Element, List<TreePath>>();

    private static void settleFilters(Trees trees) {
        for (Object[] p : pendingFilters) {
            ((Object[]) p[0])[8] = filterBill(trees, (TreePath) p[1]);
        }
    }

    /**
     * 查询条件用在哪张单上：顺着条件对象往外找，到吃它的取数调用（load、query、delete……），单据就是那次取数的。
     * 经过的路：and/or/toArray 的结果、放进数组或集合再交出去、存进局部变量后的各处用法、传进本工程方法后在那边的用法。
     * 交给了好几张单、或者交给了认不出的地方（存成员变量、方法返回、交给平台别的方法），照实记原因。
     */
    private static String filterBill(Trees trees, TreePath expr) {
        Set<String> found = new LinkedHashSet<String>();
        List<String> why = new ArrayList<String>();
        Set<Tree> seen = new HashSet<Tree>();
        climbFilter(trees, expr, 0, found, why, seen);
        followReceiver(trees, expr, 0, found, why, seen);
        if (found.size() == 1) {
            return found.iterator().next();
        }
        if (found.size() > 1) {
            return "?:查询条件用在几张单上";
        }
        return why.isEmpty() ? "?:查询条件没交给取数调用" : why.get(0);
    }

    /** `f.and("x", …)` 改的是 f 本身：f 是变量时，它后面交给了谁也算 */
    private static void followReceiver(Trees trees, TreePath expr, int depth, Set<String> found, List<String> why,
                                       Set<Tree> seen) {
        TreePath root = expr;
        while (root.getLeaf() instanceof MethodInvocationTree
                && ((MethodInvocationTree) root.getLeaf()).getMethodSelect() instanceof MemberSelectTree) {
            MethodInvocationTree inv = (MethodInvocationTree) root.getLeaf();
            String n = ((MemberSelectTree) inv.getMethodSelect()).getIdentifier().toString();
            if (!"and".equals(n) && !"or".equals(n)) {
                break;
            }
            root = receiverPath(root, inv);
        }
        if (root != expr) {
            usesOfValue(trees, root, depth, found, why, seen);
        }
    }

    /** 表达式是变量时，看这个变量在方法里的各处用法 */
    private static void usesOfValue(Trees trees, TreePath p, int depth, Set<String> found, List<String> why,
                                    Set<Tree> seen) {
        Element e = trees.getElement(p);
        if (!(e instanceof VariableElement)) {
            return;
        }
        if (e.getKind() == ElementKind.FIELD) {
            why.add("?:查询条件存在成员变量 " + e.getSimpleName() + " 里");
            return;
        }
        TreePath outer = outerMethod(p);
        if (outer != null) {
            usesIn(trees, outer, e, depth, found, why, seen);
        }
        Element owner = e.getEnclosingElement();
        if (e.getKind() != ElementKind.PARAMETER || !(owner instanceof ExecutableElement)
                || !callSites.containsKey(owner)) {
            return;
        }
        // 参数是调用方传进来的集合（`appendFilter(List<QFilter> filters)`）：条件加进去以后，看调用方那个集合交给了谁。
        // 调用方那边认出的单据标识若又是调用方的参数，换不回这个方法，记原因
        int i = ((ExecutableElement) owner).getParameters().indexOf(e);
        Set<String> outerFound = new LinkedHashSet<String>();
        for (TreePath call : callSites.get(owner)) {
            List<? extends ExpressionTree> args = ((MethodInvocationTree) call.getLeaf()).getArguments();
            if (i >= 0 && i < args.size()) {
                usesOfValue(trees, new TreePath(call, args.get(i)), depth + 1, outerFound, why, seen);
            }
        }
        for (String o : outerFound) {
            if (o.startsWith("bill:")) {
                found.add(o);
            } else {
                why.add("?:查询条件加进调用方的集合，那边的单据标识是参数");
            }
        }
    }

    private static void usesIn(final Trees trees, TreePath scope, final Element e, final int depth,
                               final Set<String> found, final List<String> why, final Set<Tree> seen) {
        final List<TreePath> uses = new ArrayList<TreePath>();
        new TreePathScanner<Void, Void>() {
            @Override
            public Void visitIdentifier(IdentifierTree node, Void v) {
                if (e.equals(trees.getElement(getCurrentPath()))) {
                    uses.add(getCurrentPath());
                }
                return null;
            }
        }.scan(scope, null);
        for (TreePath use : uses) {
            climbFilter(trees, use, depth + 1, found, why, seen);
        }
    }

    private static void climbFilter(Trees trees, TreePath p, int depth, Set<String> found, List<String> why,
                                    Set<Tree> seen) {
        if (depth > 16 || !seen.add(p.getLeaf())) {
            return;
        }
        TreePath up = p.getParentPath();
        if (up == null) {
            return;
        }
        Tree parent = up.getLeaf();
        switch (parent.getKind()) {
            case PARENTHESIZED:
            case TYPE_CAST:
            case CONDITIONAL_EXPRESSION:
            case NEW_ARRAY:
                climbFilter(trees, up, depth + 1, found, why, seen);
                return;
            case MEMBER_SELECT: {
                // f.and(…)、list.toArray(…)：结果还是条件（或条件数组）就接着往外走；f.toString() 之类不是交出条件
                TreePath call = up.getParentPath();
                if (call != null && call.getLeaf() instanceof MethodInvocationTree && isFilterType(trees, call)) {
                    climbFilter(trees, call, depth + 1, found, why, seen);
                }
                return;
            }
            case METHOD_INVOCATION: {
                MethodInvocationTree inv = (MethodInvocationTree) parent;
                int i = inv.getArguments().indexOf(p.getLeaf());
                Element el = trees.getElement(new TreePath(up, inv.getMethodSelect()));
                if (i < 0 || !(el instanceof ExecutableElement)) {
                    return;
                }
                ExecutableElement m = (ExecutableElement) el;
                String owner = ownerOf(m);
                String name = m.getSimpleName().toString();
                Sink sink = resolveSink(owner, signatureOf(m), receiverOf(trees, up, inv));
                if (sink != null && "entity".equals(sink.level)) {
                    String o = entityOrigin(trees, up, inv, sink, name);
                    if (o.startsWith("?:")) {
                        why.add(o);
                    } else {
                        found.add(o);
                    }
                    return;
                }
                if (isFilterType(trees, up)) {
                    // a.and(b)、Arrays.asList(f…)、new ArrayList<>(…)：结果还是条件
                    climbFilter(trees, up, depth + 1, found, why, seen);
                    followReceiver(trees, up, depth + 1, found, why, seen);
                    return;
                }
                if (("add".equals(name) || "addAll".equals(name) || "push".equals(name) || "offer".equals(name))
                        && inv.getMethodSelect() instanceof MemberSelectTree) {
                    // 放进集合：看集合后面交给了谁
                    usesOfValue(trees, receiverPath(up, inv), depth + 1, found, why, seen);
                    return;
                }
                if (declaredTypes.contains(owner)) {
                    intoCallee(trees, up, inv, m, i, depth + 1, found, why, seen);
                    return;
                }
                why.add("?:查询条件交给了 " + simple(owner) + "#" + name);
                return;
            }
            case VARIABLE:
                usesOfValue(trees, up, depth + 1, found, why, seen);
                return;
            case ASSIGNMENT: {
                AssignmentTree a = (AssignmentTree) parent;
                if (a.getExpression() == p.getLeaf()) {
                    // filters[0] = new QFilter(…)：放进数组的一格，看数组交给了谁
                    ExpressionTree target = a.getVariable();
                    TreePath at = new TreePath(up, target);
                    while (target instanceof ArrayAccessTree) {
                        target = ((ArrayAccessTree) target).getExpression();
                        at = new TreePath(at, target);
                    }
                    usesOfValue(trees, at, depth + 1, found, why, seen);
                }
                return;
            }
            case ENHANCED_FOR_LOOP: {
                // for (QFilter f : filters) list.add(f)：遍历出来的每个条件，看循环变量交给了谁
                EnhancedForLoopTree loop = (EnhancedForLoopTree) parent;
                if (loop.getExpression() == p.getLeaf()) {
                    TreePath var = new TreePath(up, loop.getVariable());
                    Element e = trees.getElement(var);
                    TreePath outer = outerMethod(up);
                    if (e != null && outer != null) {
                        usesIn(trees, outer, e, depth + 1, found, why, seen);
                    }
                }
                return;
            }
            case RETURN:
                why.add("?:查询条件由方法返回");
                return;
            case EXPRESSION_STATEMENT:
            case EQUAL_TO:
            case NOT_EQUAL_TO:
            case INSTANCE_OF:
                // 单独一句 f.and(…)（调用对象另算）、判空：都不是把条件交出去
                return;
            default:
                why.add("?:查询条件用在 " + parent.getKind().toString().toLowerCase());
        }
    }

    /** 表达式的类型是条件、条件数组或条件集合 */
    private static boolean isFilterType(Trees trees, TreePath p) {
        TypeMirror t = trees.getTypeMirror(p);
        return t != null && t.toString().contains(FILTER);
    }

    /** 条件传进本工程方法：到那个方法里看这个参数交给了谁，单据标识是那边参数的换回调用处 */
    private static void intoCallee(Trees trees, TreePath call, MethodInvocationTree inv, ExecutableElement m, int i,
                                   int depth, Set<String> found, List<String> why, Set<Tree> seen) {
        TreePath decl = trees.getPath(m);
        if (decl == null || i >= m.getParameters().size()) {
            why.add("?:查询条件传进了 " + simple(ownerOf(m)) + "#" + m.getSimpleName());
            return;
        }
        Set<String> inner = new LinkedHashSet<String>();
        usesIn(trees, decl, m.getParameters().get(i), depth, inner, why, seen);
        boolean sameClass = topOf(m).equals(topClass(trees, call));
        for (String o : inner) {
            String r = rebase(trees, call, inv, o, sameClass, depth);
            if (r.startsWith("?:")) {
                why.add(r);
            } else {
                found.add(r);
            }
        }
    }

    /** list.add(x) / list.addAll(x)：扫完后看 list 是不是 PreparePropertysEventArgs.getFieldKeys() */
    private static boolean isListAdd(MethodInvocationTree node, ExecutableElement m) {
        String name = m.getSimpleName().toString();
        return ("add".equals(name) || "addAll".equals(name)) && node.getArguments().size() == 1
                && node.getMethodSelect() instanceof MemberSelectTree && ownerOf(m).startsWith("java.util.");
    }

    /** {调用路径, 调用, 方法, 行} */
    private static final List<Object[]> pendingPreloads = new ArrayList<Object[]>();

    private static void settlePreloads(Trees trees) {
        for (Object[] p : pendingPreloads) {
            TreePath path = (TreePath) p[0];
            MethodInvocationTree node = (MethodInvocationTree) p[1];
            if (isFieldKeyList(trees, receiverPath(path, node), 0)) {
                recordPreload(trees, path, node, (ExecutableElement) p[2], (Integer) p[3]);
            }
        }
    }

    /**
     * 是 e.getFieldKeys() 拿到的列表：直接调的，存进局部变量的（每处赋值都是），或者是参数、
     * 每个调用处传进来的都是（`addFieldKeys(e.getFieldKeys())`）。
     */
    private static boolean isFieldKeyList(Trees trees, TreePath p, int depth) {
        Tree t = p.getLeaf();
        if (t instanceof ParenthesizedTree) {
            return isFieldKeyList(trees, new TreePath(p, ((ParenthesizedTree) t).getExpression()), depth);
        }
        if (t instanceof MethodInvocationTree) {
            Element el = trees.getElement(new TreePath(p, ((MethodInvocationTree) t).getMethodSelect()));
            return el instanceof ExecutableElement && el.getSimpleName().contentEquals("getFieldKeys")
                    && PRELOAD_ARGS.equals(ownerOf((ExecutableElement) el));
        }
        Element e = trees.getElement(p);
        TreePath outer = outerMethod(p);
        if (!(e instanceof VariableElement) || outer == null || depth > 3) {
            return false;
        }
        if (e.getKind() == ElementKind.PARAMETER) {
            Element owner = e.getEnclosingElement();
            List<TreePath> sites = owner instanceof ExecutableElement ? callSites.get(owner) : null;
            int i = sites == null ? -1 : ((ExecutableElement) owner).getParameters().indexOf(e);
            if (i < 0) {
                return false;
            }
            for (TreePath call : sites) {
                List<? extends ExpressionTree> args = ((MethodInvocationTree) call.getLeaf()).getArguments();
                if (i >= args.size() || !isFieldKeyList(trees, new TreePath(call, args.get(i)), depth + 1)) {
                    return false;
                }
            }
            return true;
        }
        if (e.getKind() != ElementKind.LOCAL_VARIABLE) {
            return false;
        }
        List<TreePath> defs = defsOf(trees, outer).defs.get(e);
        if (defs == null || defs.isEmpty()) {
            return false;
        }
        for (TreePath d : defs) {
            if (!isFieldKeyList(trees, d, depth + 1)) {
                return false;
            }
        }
        return true;
    }

    private static void recordPreload(Trees trees, TreePath path, MethodInvocationTree node, ExecutableElement m,
                                      int line) {
        ExpressionTree arg = node.getArguments().get(0);
        List<ExpressionTree> keys = new ArrayList<ExpressionTree>();
        if ("add".contentEquals(m.getSimpleName())) {
            keys.add(arg);
        } else if (arg instanceof MethodInvocationTree) {
            // addAll(Arrays.asList("a", "b"))
            keys.addAll(((MethodInvocationTree) arg).getArguments());
        }
        String cls = topClass(trees, path);
        String inM = enclosingMethodId(trees, path);
        for (ExpressionTree k : keys) {
            String key = keyOf(trees, path, k);
            if (key == null) {
                continue;
            }
            boolean literal = k instanceof LiteralTree;
            fieldRows.add(new Object[]{cls, key, "preload", literal ? "literal" : "constant",
                    "PreparePropertysEventArgs#getFieldKeys()", line, literal ? null : exprName(trees, path, k), inM,
                    "own", null});
        }
    }

    // ── 对象来源 ───────────────────────────────────────────────────────────
    /**
     * 一个表达式拿到的数据包 / 界面模型从哪来，只在最外层方法内部看：
     *
     *   own        插件自己那张单：getModel()、getView()、getDataEntity()、e.getDataEntities()
     *   bill:X     按名字加载、新建的单据 X（load、loadSingle、newDynamicObject、query……）
     *   param:N    最外层方法的第 N 个参数（从 0 数），查询时到调用处接着追
     *   member:x   成员变量
     *   prop:f/来源 从数据包上取的字段 f（getDynamicObject("f")、get("f")）：f 是基础资料时已经不是这张单的数据，
     *              是分录时还是；斜杠后是取它的那个对象的来源
     *   ret:C#m    本工程方法的返回值
     *   ?:原因     认不出，原因照写
     *
     * 遍历集合、取分录、取分录行、按下标取，来源跟着集合走：分录行仍是那张单的数据。
     * 局部变量看它的全部赋值（声明初值、赋值语句、for-each 的集合）；来源不一致就说不一致，不挑一个。
     */
    private static String originOf(Trees trees, TreePath p, int depth) {
        if (depth > 24) {
            return "?:追得太深";
        }
        Tree t = p.getLeaf();
        switch (t.getKind()) {
            case PARENTHESIZED:
                return originOf(trees, new TreePath(p, ((ParenthesizedTree) t).getExpression()), depth + 1);
            case TYPE_CAST:
                return originOf(trees, new TreePath(p, ((TypeCastTree) t).getExpression()), depth + 1);
            case ARRAY_ACCESS:
                return originOf(trees, new TreePath(p, ((ArrayAccessTree) t).getExpression()), depth + 1);
            case CONDITIONAL_EXPRESSION: {
                ConditionalExpressionTree c = (ConditionalExpressionTree) t;
                String a = originOf(trees, new TreePath(p, c.getTrueExpression()), depth + 1);
                String b = originOf(trees, new TreePath(p, c.getFalseExpression()), depth + 1);
                return a.equals(b) || "?:null".equals(b) ? a : "?:null".equals(a) ? b : "?:条件表达式两边来源不同";
            }
            case NULL_LITERAL:
                return "?:null";
            case NEW_CLASS: {
                NewClassTree n = (NewClassTree) t;
                String type = simpleType(String.valueOf(n.getIdentifier()));
                if ("DynamicObject".equals(type) && n.getArguments().size() == 1) {
                    // new DynamicObject(类型)：和 newDynamicObject 一样，单据在类型里
                    return originOf(trees, new TreePath(p, n.getArguments().get(0)), depth + 1);
                }
                return "?:new " + type;
            }
            case METHOD_INVOCATION:
                return callOrigin(trees, p, (MethodInvocationTree) t, depth);
            case IDENTIFIER:
                if (((IdentifierTree) t).getName().contentEquals("this")) {
                    return "own";
                }
                return variableOrigin(trees, p, depth);
            case MEMBER_SELECT:
                if (((MemberSelectTree) t).getIdentifier().contentEquals("this")) {
                    return "own";
                }
                return variableOrigin(trees, p, depth);
            default:
                return "?:" + t.getKind().toString().toLowerCase();
        }
    }

    private static String variableOrigin(Trees trees, TreePath p, int depth) {
        Element e = trees.getElement(p);
        if (!(e instanceof VariableElement)) {
            return "?:认不出变量";
        }
        String name = e.getSimpleName().toString();
        ElementKind kind = e.getKind();
        if (kind == ElementKind.FIELD) {
            return "member:" + name;
        }
        TreePath outer = outerMethod(p);
        if (outer == null) {
            return "?:不在方法里";
        }
        Defs defs = defsOf(trees, outer);
        if (kind == ElementKind.PARAMETER) {
            TreePath lambda = defs.lambdas.get(e);
            if (lambda != null) {
                return lambdaOrigin(trees, lambda, depth);
            }
            String param = paramOf(trees, p);
            return param != null ? param : "?:内部类方法的参数";
        }
        List<TreePath> list = defs.defs.get(e);
        if (list == null || list.isEmpty()) {
            return "?:变量 " + name + " 没有赋值";
        }
        String found = null;
        for (TreePath def : list) {
            String o = originOf(trees, def, depth + 1);
            if ("?:null".equals(o)) {
                continue;
            }
            if (found == null) {
                found = o;
            } else if (!found.equals(o)) {
                return "?:变量 " + name + " 几处赋值来源不同";
            }
        }
        return found == null ? "?:变量 " + name + " 只赋过 null" : found;
    }

    /** `coll.forEach(row -> …)`、`coll.stream().filter(x -> …)`：lambda 参数是集合里的元素，来源跟着集合 */
    private static String lambdaOrigin(Trees trees, TreePath lambda, int depth) {
        TreePath parent = lambda.getParentPath();
        if (parent == null || !(parent.getLeaf() instanceof MethodInvocationTree)) {
            return "?:lambda 参数";
        }
        MethodInvocationTree call = (MethodInvocationTree) parent.getLeaf();
        if (!(call.getMethodSelect() instanceof MemberSelectTree)) {
            return "?:lambda 参数";
        }
        String name = ((MemberSelectTree) call.getMethodSelect()).getIdentifier().toString();
        if (name.startsWith("comparing")) {
            // stream.max(Comparator.comparing(x -> …))、list.sort(Comparator.comparing(…))：比较的是外面那个集合的元素
            TreePath up = parent.getParentPath();
            if (up != null && up.getLeaf() instanceof MethodInvocationTree
                    && ((MethodInvocationTree) up.getLeaf()).getMethodSelect() instanceof MemberSelectTree) {
                return originOf(trees, receiverPath(up, (MethodInvocationTree) up.getLeaf()), depth + 1);
            }
            return "?:lambda 参数";
        }
        if (!ELEMENT_LAMBDAS.contains(name)) {
            return "?:lambda 参数";
        }
        return originOf(trees, receiverPath(parent, call), depth + 1);
    }

    /** 只是把参数换个包装的静态方法：Arrays.stream(arr)、Arrays.asList(arr)、Stream.of(x)、Lists.newArrayList(x) */
    private static final Set<String> STATIC_WRAPS = new HashSet<String>(Arrays.asList(
            "stream", "asList", "of", "singletonList", "unmodifiableList", "newArrayList"));

    private static boolean isStaticCall(ExecutableElement m) {
        return m.getModifiers().contains(Modifier.STATIC);
    }

    private static boolean isModel(String type) {
        Set<String> up = supersCache.get(type);
        return up != null && up.contains("kd.bos.entity.datamodel.IDataModel");
    }

    /** 本工程方法 → 它各处 return 的来源（在被调方法里算）；递归调用时先占位，防止绕圈 */
    private static final Map<Element, List<String>> returnsCache = new HashMap<Element, List<String>>();

    /**
     * 本工程方法的返回值：到被调方法里看它 return 的是什么。返回的是它的参数，就换成这次调用传进去的实参；
     * 各处 return 来源一致才算，不一致记 `ret:类#方法`。
     */
    private static String returnOrigin(final Trees trees, TreePath p, MethodInvocationTree node,
                                       ExecutableElement m, int depth) {
        String fallback = "ret:" + simple(ownerOf(m)) + "#" + m.getSimpleName();
        List<String> raw = returnsCache.get(m);
        if (raw == null) {
            returnsCache.put(m, new ArrayList<String>());
            final TreePath method = trees.getPath(m);
            final List<TreePath> exprs = new ArrayList<TreePath>();
            if (method != null) {
                new TreePathScanner<Void, Void>() {
                    @Override
                    public Void visitReturn(com.sun.source.tree.ReturnTree r, Void v) {
                        if (r.getExpression() != null) {
                            exprs.add(new TreePath(getCurrentPath(), r.getExpression()));
                        }
                        return null;
                    }

                    @Override
                    public Void visitLambdaExpression(com.sun.source.tree.LambdaExpressionTree l, Void v) {
                        return null;
                    }

                    @Override
                    public Void visitClass(ClassTree c, Void v) {
                        return null;
                    }
                }.scan(method, null);
            }
            raw = new ArrayList<String>();
            for (TreePath e : exprs) {
                raw.add(originOf(trees, e, depth + 1));
            }
            returnsCache.put(m, raw);
        }
        if (raw.isEmpty()) {
            return fallback;
        }
        boolean sameClass = topOf(m).equals(topClass(trees, p));
        String found = null;
        for (String o : raw) {
            String r = rebase(trees, p, node, o, sameClass, depth);
            if ("?:null".equals(r)) {
                continue;
            }
            if (r.startsWith("?:") || (found != null && !found.equals(r))) {
                return fallback;
            }
            found = r;
        }
        return found == null ? fallback : found;
    }

    /** 被调方法里算出的来源换到调用处：参数换成实参，本单、成员变量只在同一个类里才还算数 */
    private static String rebase(Trees trees, TreePath p, MethodInvocationTree call, String o,
                                 boolean sameClass, int depth) {
        if (o.startsWith("param:") || o.startsWith("billparam:")) {
            int n = Integer.parseInt(o.substring(o.indexOf(':') + 1));
            if (n >= call.getArguments().size()) {
                return "?:参数个数对不上";
            }
            ExpressionTree arg = call.getArguments().get(n);
            if (o.startsWith("param:")) {
                return originOf(trees, new TreePath(p, arg), depth + 1);
            }
            String key = keyOf(trees, p, arg);
            if (key != null) {
                return "bill:" + key;
            }
            String param = paramOf(trees, new TreePath(p, arg));
            return param != null ? "bill" + param : "?:单据标识不是常量";
        }
        if (o.startsWith("prop:")) {
            int slash = o.indexOf('/');
            return o.substring(0, slash + 1) + rebase(trees, p, call, o.substring(slash + 1), sameClass, depth);
        }
        if (("own".equals(o) || o.startsWith("member:")) && !sameClass) {
            return "?:别的类自己的数据";
        }
        return o;
    }

    private static final Set<String> ELEMENT_LAMBDAS = new HashSet<String>(Arrays.asList(
            "forEach", "filter", "map", "anyMatch", "allMatch", "noneMatch", "removeIf", "peek", "mapToInt",
            "mapToLong", "mapToDouble", "flatMap", "sorted", "min", "max"));

    /** 取了还是同一批数据的集合方法：遍历、按下标取、转流、过滤 */
    private static final Set<String> SAME_DATA = new HashSet<String>(Arrays.asList(
            "get", "iterator", "next", "stream", "parallelStream", "filter", "sorted", "distinct", "limit", "skip",
            "toArray", "findFirst", "findAny", "orElse", "orElseGet", "orElseThrow", "subList", "getFirst", "getLast",
            "peek", "collect", "max", "min", "addNew"));

    private static String callOrigin(Trees trees, TreePath p, MethodInvocationTree node, int depth) {
        Element el = trees.getElement(new TreePath(p, node.getMethodSelect()));
        if (!(el instanceof ExecutableElement)) {
            return "?:调用没绑到符号";
        }
        ExecutableElement m = (ExecutableElement) el;
        String owner = ownerOf(m);
        String name = m.getSimpleName().toString();
        boolean hasRecv = node.getMethodSelect() instanceof MemberSelectTree;
        TreePath recv = hasRecv ? receiverPath(p, node) : null;
        String recvType = hasRecv ? receiverOf(trees, p, node) : null;
        Sink sink = resolveSink(owner, signatureOf(m), recvType);
        if (sink != null && "entity".equals(sink.level)) {
            List<? extends VariableElement> ps = m.getParameters();
            if (ps.size() == 2 && ps.get(1).asType().toString().endsWith("DynamicObjectType")) {
                // load(ids, 类型)：单据在类型里，类型通常是 getDataEntityType("x") 或另一个数据包的类型
                return originOf(trees, new TreePath(p, node.getArguments().get(1)), depth + 1);
            }
            return entityOrigin(trees, p, node, sink, name);
        }
        if (declaredTypes.contains(owner)) {
            return returnOrigin(trees, p, node, m, depth);
        }
        int argc = node.getArguments().size();
        if ("getDataEntityType".equals(name)) {
            if (argc == 1) {
                String key = keyOf(trees, p, node.getArguments().get(0));
                return key != null ? "bill:" + key : "?:getDataEntityType 的单据标识不是常量";
            }
            return recv == null ? "own" : originOf(trees, recv, depth + 1);
        }
        if (("getModel".equals(name) || "getView".equals(name)) && argc == 0) {
            return recv == null ? "own" : originOf(trees, recv, depth + 1);
        }
        if ("getDataEntities".equals(name) || "getDataRowSets".equals(name)
                || ("getMainDataVisitor".equals(name) && argc == 0)) {
            // 操作、校验的数据包；打印插件的数据行、主数据源：都是插件挂的那张单
            return "own";
        }
        if ("getDataEntity".equals(name) || "getEntryEntity".equals(name) || "getEntryRowEntity".equals(name)
                || "getDynamicObjectCollection".equals(name) || "getParent".equals(name)
                || "getCollectionField".equals(name) || ("getDataRowSet".equals(name) && argc == 0)
                || ("getValue".equals(name) && argc == 0 && "CollectionField".equals(simple(owner)))) {
            return recv == null ? "own" : originOf(trees, recv, depth + 1);
        }
        if (("map".equals(name) || "flatMap".equals(name)) && argc == 1
                && node.getArguments().get(0) instanceof com.sun.source.tree.LambdaExpressionTree) {
            // stream.map(x -> x.getDynamicObjectCollection("e"))：结果的来源看 lambda 返回的那个表达式
            com.sun.source.tree.LambdaExpressionTree l =
                    (com.sun.source.tree.LambdaExpressionTree) node.getArguments().get(0);
            if (l.getBody() instanceof ExpressionTree) {
                TreePath lp = new TreePath(p, l);
                String o = originOf(trees, new TreePath(lp, l.getBody()), depth + 1);
                return "flatMap".equals(name) || !o.startsWith("?:") ? o : "?:map 出来的值认不出来源";
            }
            return "?:" + name + " 的 lambda 是语句块";
        }
        if ("FindByEntityKey".equals(name) && argc == 1) {
            // 转换插件按单据或分录标识取目标单的数据包：标识是单据时就是那张单
            String key = keyOf(trees, p, node.getArguments().get(0));
            return key != null ? "ext:" + key : "?:FindByEntityKey 的标识不是常量";
        }
        if (recv != null && STATIC_WRAPS.contains(name) && argc >= 1 && isStaticCall(m)) {
            // Arrays.stream(arr)、Arrays.asList(arr)、Stream.of(x)：还是那一批
            return originOf(trees, new TreePath(p, node.getArguments().get(0)), depth + 1);
        }
        boolean dataObject = isDataObject(owner);
        boolean model = recvType != null && (recvType.endsWith(".IDataModel") || isModel(recvType));
        if (model && "getValue".equals(name) && argc >= 1) {
            // 界面模型上取基础资料字段的值
            String key = keyOf(trees, p, node.getArguments().get(0));
            return "prop:" + (key == null ? "?" : key) + "/" + originOf(trees, recv, depth + 1);
        }
        if (dataObject && ("getDynamicObject".equals(name) || "get".equals(name)) && argc == 1) {
            String key = keyOf(trees, p, node.getArguments().get(0));
            if ("get".equals(name) && key == null) {
                // get(int) 之类：按下标取的仍是这一批
                return recv == null ? "?:没有调用对象" : originOf(trees, recv, depth + 1);
            }
            // 带上取它的那个对象的来源：`get("entryentity")` 取的其实是分录，查询时按快照认出来就还算那张单
            return "prop:" + (key == null ? "?" : key) + "/"
                    + (recv == null ? "?:没有调用对象" : originOf(trees, recv, depth + 1));
        }
        if (SAME_DATA.contains(name) && recv != null && !dataObject) {
            return originOf(trees, recv, depth + 1);
        }
        return "?:来自 " + simple(owner) + "#" + name;
    }

    private static boolean isDataObject(String type) {
        String dyn = "kd.bos.dataentity.entity.DynamicObject";
        if (dyn.equals(type)) {
            return true;
        }
        Set<String> up = supersCache.get(type);
        return up != null && up.contains(dyn);
    }

    /** `a.b(..)` 里 a 的路径 */
    private static TreePath receiverPath(TreePath path, MethodInvocationTree node) {
        MemberSelectTree sel = (MemberSelectTree) node.getMethodSelect();
        return new TreePath(new TreePath(path, sel), sel.getExpression());
    }

    /** 表达式是最外层方法的第几个参数：`param:N`；不是时为 null */
    private static String paramOf(Trees trees, TreePath p) {
        Element e = trees.getElement(p);
        if (!(e instanceof VariableElement) || e.getKind() != ElementKind.PARAMETER) {
            return null;
        }
        TreePath outer = outerMethod(p);
        Element m = outer == null ? null : trees.getElement(outer);
        if (!(m instanceof ExecutableElement)) {
            return null;
        }
        int i = ((ExecutableElement) m).getParameters().indexOf(e);
        return i < 0 ? null : "param:" + i;
    }

    private static TreePath outerMethod(TreePath path) {
        TreePath outer = null;
        for (TreePath p = path; p != null; p = p.getParentPath()) {
            if (p.getLeaf().getKind() == Tree.Kind.METHOD) {
                outer = p;
            }
        }
        return outer;
    }

    private static final class Defs {
        final Map<Element, List<TreePath>> defs = new HashMap<Element, List<TreePath>>();
        final Map<Element, TreePath> lambdas = new HashMap<Element, TreePath>();

        void add(Element e, TreePath value) {
            List<TreePath> list = defs.get(e);
            if (list == null) {
                list = new ArrayList<TreePath>();
                defs.put(e, list);
            }
            list.add(value);
        }
    }

    private static Defs defsOf(final Trees trees, TreePath method) {
        Defs cached = defsCache.get(method.getLeaf());
        if (cached != null) {
            return cached;
        }
        final Defs out = new Defs();
        new TreePathScanner<Void, Void>() {
            @Override
            public Void visitVariable(VariableTree node, Void v) {
                Element e = trees.getElement(getCurrentPath());
                TreePath parent = getCurrentPath().getParentPath();
                if (e != null && node.getInitializer() != null) {
                    out.add(e, new TreePath(getCurrentPath(), node.getInitializer()));
                } else if (e != null && parent != null && parent.getLeaf() instanceof EnhancedForLoopTree) {
                    EnhancedForLoopTree loop = (EnhancedForLoopTree) parent.getLeaf();
                    if (loop.getVariable() == node) {
                        out.add(e, new TreePath(parent, loop.getExpression()));
                    }
                } else if (e != null && parent != null
                        && parent.getLeaf().getKind() == Tree.Kind.LAMBDA_EXPRESSION) {
                    out.lambdas.put(e, parent);
                }
                return super.visitVariable(node, v);
            }

            @Override
            public Void visitAssignment(AssignmentTree node, Void v) {
                Element e = trees.getElement(new TreePath(getCurrentPath(), node.getVariable()));
                if (e != null) {
                    out.add(e, new TreePath(getCurrentPath(), node.getExpression()));
                }
                return super.visitAssignment(node, v);
            }
        }.scan(method, null);
        defsCache.put(method.getLeaf(), out);
        return out;
    }

    /**
     * 调本工程方法时各实参的来源：数据包、界面模型、视图类的参数记 originOf；字符串参数是常量记 `key:值`，
     * 是外层方法的参数记 `param:N`。别的类型、认不出的记 null；一个都没有时返回 null，这次调用不留行。
     */
    private static String[] argOrigins(Trees trees, TreePath path, MethodInvocationTree node, ExecutableElement m) {
        List<? extends VariableElement> params = m.getParameters();
        List<? extends ExpressionTree> args = node.getArguments();
        if (params.isEmpty() || args.size() != params.size()) {
            return null;
        }
        String[] out = new String[args.size()];
        boolean any = false;
        for (int i = 0; i < args.size(); i++) {
            String type = params.get(i).asType().toString();
            TreePath at = new TreePath(path, args.get(i));
            if ("java.lang.String".equals(type)) {
                String key = keyOf(trees, path, args.get(i));
                out[i] = key != null ? "key:" + key : paramOf(trees, at);
            } else if (type.contains("DynamicObject") || type.contains("IDataModel") || type.contains("IFormView")
                    || type.contains("IBillView") || type.contains("ExtendedDataEntity")) {
                out[i] = originOf(trees, at, 0);
            } else if (!params.get(i).asType().getKind().isPrimitive()) {
                // 形参写成 Object 等宽类型的工具方法（`text(Object row, String key)`）：认得出来源才记，免得满表噪声
                String o = originOf(trees, at, 0);
                out[i] = o.startsWith("?:") ? null : o;
            }
            any |= out[i] != null;
        }
        return any ? out : null;
    }

    private static String snippet(ExpressionTree arg) {
        String s = String.valueOf(arg).replace('\n', ' ').replace('\r', ' ');
        return s.length() > 120 ? s.substring(0, 120) + "…" : s;
    }

    // ── 收尾 ───────────────────────────────────────────────────────────────
    private static void collect(File f, List<File> out) {
        if (f.isDirectory()) {
            File[] kids = f.listFiles();
            if (kids != null) {
                for (File k : kids) {
                    collect(k, out);
                }
            }
        } else if (f.getName().endsWith(".java")) {
            out.add(f);
        }
    }

    private static String relative(File base, File f) {
        String b = base.getAbsolutePath().replace('\\', '/');
        String p = f.getAbsolutePath().replace('\\', '/');
        return p.startsWith(b + "/") ? p.substring(b.length() + 1) : p;
    }

    /** driver 已经产出的 argfile：首行是 -cp "…" */
    private static String readClasspath(File file) throws Exception {
        if (!file.exists()) {
            return null;
        }
        String text = new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8);
        int i = text.indexOf("-cp");
        if (i < 0) {
            return null;
        }
        int a = text.indexOf('"', i);
        int b = text.indexOf('"', a + 1);
        return (a < 0 || b < 0) ? null : text.substring(a + 1, b);
    }

    private static void writeJson(File out, int files, int cpEntries, long ms,
                                  int errs, List<String> errSample) throws Exception {
        if (out.getParentFile() != null) {
            out.getParentFile().mkdirs();
        }
        SimpleDateFormat iso = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'");
        iso.setTimeZone(TimeZone.getTimeZone("UTC"));
        PrintWriter w = new PrintWriter(out, "UTF-8");
        try {
            w.println("{");
            w.println("  \"kind\": \"SrcIndex\",");
            w.println("  \"at\": " + q(iso.format(new Date())) + ",");
            w.println("  \"ms\": " + ms + ",");
            w.println("  \"files\": " + files + ",");
            w.println("  \"cpEntries\": " + cpEntries + ",");
            w.println("  \"calls\": {\"total\": " + calls + ", \"bound\": " + bound
                    + ", \"unbound\": " + unbound + "},");
            w.print("  \"diagnostics\": {\"error\": " + errs + ", \"sample\": [");
            for (int i = 0; i < errSample.size(); i++) {
                w.print((i > 0 ? ", " : "") + q(errSample.get(i)));
            }
            w.println("]},");
            w.println("  \"classes\": [");
            for (int i = 0; i < classRows.size(); i++) {
                String[] r = classRows.get(i);
                w.println("    {\"class\": " + q(r[0]) + ", \"file\": " + q(r[1])
                        + ", \"pluginType\": " + q(r[2]) + "}" + (i + 1 < classRows.size() ? "," : ""));
            }
            w.println("  ],");
            writeRefs(w, "entityRefs", "entity", entityRows);
            writeRefs(w, "fieldRefs", "field", fieldRows);
            w.println("  \"edges\": [");
            int ei = 0;
            for (String[] e : edgeRows.values()) {
                w.println("    {\"from\": " + q(e[0]) + ", \"to\": " + q(e[1])
                        + ", \"fromClass\": " + q(e[2]) + ", \"toClass\": " + q(e[3])
                        + ", \"line\": " + e[4] + ", \"count\": " + e[5] + "}"
                        + (++ei < edgeRows.size() ? "," : ""));
            }
            w.println("  ],");
            w.println("  \"callArgs\": [");
            for (int k = 0; k < callRows.size(); k++) {
                Object[] r = callRows.get(k);
                String[] args = (String[]) r[4];
                StringBuilder a = new StringBuilder("[");
                for (int j = 0; j < args.length; j++) {
                    a.append(j > 0 ? ", " : "").append(q(args[j]));
                }
                w.println("    {\"from\": " + q(r[0]) + ", \"to\": " + q(r[1]) + ", \"fromClass\": " + q(r[2])
                        + ", \"line\": " + r[3] + ", \"args\": " + a.append(']') + "}"
                        + (k + 1 < callRows.size() ? "," : ""));
            }
            w.println("  ],");
            w.println("  \"effects\": [");
            for (int k = 0; k < effectRows.size(); k++) {
                Object[] r = effectRows.get(k);
                w.println("    {\"class\": " + q(r[0]) + ", \"inMethod\": " + q(r[1]) + ", \"line\": " + r[2]
                        + ", \"effect\": " + q(r[3]) + "}" + (k + 1 < effectRows.size() ? "," : ""));
            }
            w.println("  ],");
            w.print("  \"unknownSigs\": [");
            int i = 0;
            for (String s : unknownSigs) {
                w.print((i++ > 0 ? ", " : "") + q(s));
            }
            w.println("]");
            w.println("}");
        } finally {
            w.close();
        }
    }

    private static void writeRefs(PrintWriter w, String name, String keyName, List<Object[]> rows) {
        w.println("  \"" + name + "\": [");
        for (int i = 0; i < rows.size(); i++) {
            Object[] r = rows.get(i);
            String extra = (r.length > 8 && r[8] != null ? ", \"obj\": " + q(r[8]) : "")
                    + (r.length > 9 && r[9] != null ? ", \"keyFrom\": " + q(r[9]) : "");
            w.println("    {\"class\": " + q(r[0]) + ", \"" + keyName + "\": " + q(r[1])
                    + ", \"access\": " + q(r[2]) + ", \"resolution\": " + q(r[3])
                    + ", \"via\": " + q(r[4]) + ", \"line\": " + r[5]
                    + ", \"expr\": " + q(r[6]) + ", \"inMethod\": " + q(r[7]) + extra + "}"
                    + (i + 1 < rows.size() ? "," : ""));
        }
        w.println("  ],");
    }

    private static String q(Object o) {
        if (o == null) {
            return "null";
        }
        String s = String.valueOf(o);
        StringBuilder b = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': b.append("\\\""); break;
                case '\\': b.append("\\\\"); break;
                case '\n': b.append("\\n"); break;
                case '\r': b.append("\\r"); break;
                case '\t': b.append("\\t"); break;
                default:
                    if (c < 0x20) {
                        b.append(String.format("\\u%04x", (int) c));
                    } else {
                        b.append(c);
                    }
            }
        }
        return b.append('"').toString();
    }

    private SrcIndexTool() {
    }
}
