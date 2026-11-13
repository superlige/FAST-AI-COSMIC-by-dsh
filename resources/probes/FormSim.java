import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.lang.reflect.Proxy;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.EventObject;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import cosmic.headless.HeadlessViews;

import kd.bos.base.BaseShowParameter;
import kd.bos.bill.BillOperationStatus;
import kd.bos.bill.BillShowParameter;
import kd.bos.bill.MobileBillShowParameter;
import kd.bos.bill.OperationStatus;
import kd.bos.context.RequestContext;
import kd.bos.dataentity.entity.DynamicObject;
import kd.bos.dataentity.entity.DynamicObjectCollection;
import kd.bos.dataentity.metadata.IDataEntityType;
import kd.bos.entity.BillEntityType;
import kd.bos.entity.EntityMetadataCache;
import kd.bos.entity.MainEntityType;
import kd.bos.entity.datamodel.IDataModel;
import kd.bos.entity.datamodel.events.PropertyChangedArgs;
import kd.bos.entity.operate.result.IOperateInfo;
import kd.bos.entity.operate.result.OperationResult;
import kd.bos.form.FormConfig;
import kd.bos.form.CloseCallBack;
import kd.bos.form.FormMetadataCache;
import kd.bos.form.FormShowParameter;
import kd.bos.form.MobileFormShowParameter;
import kd.bos.form.IClientViewProxy;
import kd.bos.form.IPageCache;
import kd.bos.form.control.AbstractGrid;
import kd.bos.form.control.Toolbar;
import kd.bos.form.control.AbstractGrid.GridState;
import kd.bos.form.control.events.ItemClickEvent;
import kd.bos.list.ListShowParameter;
import kd.bos.form.events.AfterDoOperationEventArgs;
import kd.bos.form.events.BeforeDoOperationEventArgs;
import kd.bos.form.plugin.AbstractFormPlugin;
import kd.bos.form.plugin.IFormPlugin;
import kd.bos.metadata.dao.MetaCategory;
import kd.bos.metadata.dao.MetadataDao;
import kd.bos.metadata.entity.EntityMetadata;
import kd.bos.mvc.cache.PageCache;
import kd.bos.mvc.form.FormController;
import kd.bos.mvc.form.FormView;
import kd.bos.mvc.form.IFormController;
import kd.bos.orm.ORM;
import kd.bos.orm.query.QFilter;
import kd.bos.servicehelper.BusinessDataServiceHelper;

/**
 * 表单插件免界面验证：起一个真 {@link FormView}，让元数据里配的插件真的跑起来，
 * 把「插件收到什么事件」和「插件让界面做了什么」记下来，用断言代替肉眼看界面。
 *
 * 不起 Jetty、不开浏览器、不部署。整条链是真的：真 FormView、真 FormDataModel、
 * 真插件实例（`getView()` / `getModel()` 都是真对象），只有**发往前端的那一层**被换成了记账代理。
 *
 * 三处顺序错一个就整条链断，都已经在代码里定死，改的时候先读 docs/技术设计/免界面验证.md：
 *   1. `IPageCache` 必须在 `super.initiService()` **之前**注册（否则原厂十几个服务全丢且不报错）；
 *   2. 插件过滤只能在 `FormConfig` 层做，且用完必须还原（那对象全 JVM 共享）；
 *   3. 记账代理的返回值不能一律给 null，平台会接着用。
 *
 * 参数（driver.mjs run form 会替你填）：
 *   FORM_ENTITY  表单/单据标识，必填
 *   FORM_PK      给了就打开这条已有单据（EDIT），不给就新增（ADDNEW）。新增和打开都走平台的 loadData；
 *                平台按布局方案转去别的布局时跟过去开那张，头几行写明「实际打开的是布局 X」
 *   FORM_STATUS  view 按查看打开（要有 FORM_PK）；不给按有没有 FORM_PK 定。打开已有单据和从列表点修改一样，
 *                已提交、已审核的单按已提交、已审核开。页面状态按平台最后发给浏览器的算（谁发的都算）
 *   FORM_SET     `字段=值` 用 `;` 隔开，走 `model.setValue` —— 会触发 propertyChanged。
 *                分录写 `分录[2].字段`、子分录写 `分录[2].子分录[1].字段`（行不够会自动补）；
 *                值的写法见 {@link ExpectSpec#convert}（基础资料给 id 或 number、日期、多选逗号分隔）
 *   FORM_OP      跑一个操作（等价于点了绑这个操作的按钮），真提交（S27）
 *   FORM_CLICK   点工具栏按钮的 key，走 `Toolbar.itemClick`，同样真提交
 *   FORM_HYPERLINK  点分录某一格的超链接：`分录[行].字段`（子分录 `分录[行].子分录[行].字段`），走真表格控件的
 *                `hyperLinkClick`，派发给插件在 registerListener 里 addHyperClickListener 挂上的监听；不提交
 *   FORM_SKIP    摘掉的插件（类简名，逗号分隔）—— 强依赖真实会话的插件用它绕开
 *   FORM_REAL_CACHE=1  使用真实 Redis PageCache/ModelCache；默认仍是快速内存缓存
 *   FORM_SELECT  模拟前端回传的分录选中行：`分录标识=0,2` 用 `;` 隔开，`分录标识=` 表示这个分录一行没选。
 *                不给这个参数时，按 FORM_SET 写过的分录行自动选中 —— 真实前端里改一行的值必然先点中那一行，
 *                而 `control.getSelectRows()` 只认选中行，不认当前行（见 {@link #TOUCHED_ROWS}）。
 *   FORM_SHOW    跑完之后要打终值的字段，`,` 或 `;` 隔开；分录写 `分录标识.字段`。
 *                写界面路径（`控件.visible`）或面板、按钮这类控件的标识，在「界面状态」一段点名打它显示、可编辑、必录
 *   FORM_EXPECT  业务断言，`字段=值` 用 `;` 隔开，写法同 FORM_SET（含 `分录[2].字段`）。
 *                界面状态写 `控件.visible|enabled|mustInput=true|false`：分录某一格 `分录[行].字段.enabled`、
 *                整列 `分录.字段.visible`、整行锁定 `分录[行].enabled`，按 {@link UiState} 的界面状态表判。
 *                路径写错的（字段、控件不存在，值不是 true/false）在改值、点按钮之前一次报全，记「输入不成立」。
 *                三个保留字断言动作的效果（{@link #assertEffects}）：`opened=子页,…` 这次打开了哪些页面（不看顺序，
 *                留空是一个没开）、`opened.参数=值` 唯一打开的那个页面带的参数（`~=` 是包含）、
 *                `message=片段` 弹给用户的话里有这段（留空是一句没弹）。
 *                `--show` 打值给人看，`--expect` 判对错给机器看；**不给就只能算「跑过了」**，
 *                verify 判 EXECUTED 而不是 PASS。
 *   FORM_EVENTS=1  打印插件事件明细（默认只打条数和摘要）
 *   FORM_CALLS=N   额外打印最后 N 条原始客户端调用（默认 0，调试分类器用）
 */
public class FormSim {

    static final List<String> EVENTS = new ArrayList<String>();
    static final List<String> CALLS = new ArrayList<String>();
    static final List<String> NOTICES = new ArrayList<String>();
    static final Map<String, Object> PAGE_CACHE = new HashMap<String, Object>();
    /** 这次装进来的插件全限定名，用来把异常归到具体插件头上 */
    static final Set<String> PLUGIN_NAMES = new HashSet<String>();
    /**
     * 同一批插件的 Class，用来回答「这次没走到哪些回调」。
     *
     * 存 Class 而不是拿名字 Class.forName：插件是被平台的类加载器装进来的，
     * 探针自己的加载器未必看得见那个名字，反查会静默地一个都找不到。
     */
    static final List<Class<?>> PLUGIN_TYPES = new ArrayList<Class<?>>();
    /** 界面规则推给前端的动作条数（每次 addRuleAction 记一条）；结论在 {@link UiState} 里。 */
    static int RULE_ACTIONS;
    /** 真父操作调用 showForm 后捕获的原始参数；FormFlowSim 用它继续驱动子页。 */
    static final List<FormShowParameter> OPENED_FORMS = new ArrayList<FormShowParameter>();
    /** 模拟浏览器回传的表格选中行。key 是 grid 控件 key，* 表示任意 grid。 */
    static final Map<String, int[]> GRID_SELECTIONS = new LinkedHashMap<String, int[]>();
    static final Set<String> PRINTED_SELECTIONS = new HashSet<String>();
    /**
     * `--set` 写过的分录行：grid 控件 key → 行号，插入序。
     *
     * 「当前行」和「选中行」是两回事，而这个区别曾经吃掉一整轮验证：`applySets` 只做
     * `setValue` + `setEntryCurrentRowIndex`，所以 `getValue(key)` 读得到那一行，
     * 而 `control.getSelectRows()` 恒空 —— 凡是第一行就 `getSelectRows()` 判空的操作
     * （`type=donothing` 的计算按钮是典型），在探针里必然走进「请先选择要计算的分录行」
     * 那条分支，断言拿到的是初值，看着像插件算错了。
     *
     * 真实前端里改一行的值必然先点中那一行，所以默认按这里记下的行模拟选中；
     * 要验「一行都没选」那条分支，用 `--select 分录标识=`（等号后留空）显式覆盖。
     */
    static final Map<String, Set<Integer>> TOUCHED_ROWS = new LinkedHashMap<String, Set<Integer>>();
    static String FORM = "";
    static String ENTITY = "";
    /** 当前实际打开的布局设计态 id；派生布局不能折叠成实体/根表单 id。 */
    static String FORM_DESIGN_ID;
    static MainEntityType MET;
    static kd.bos.metadata.form.FormMetadata FM;
    /** 开的是单据带的移动端页面（<单据>_mob）时是那张单据的布局标识：它没有自己的设计态，塞在单据布局里。 */
    static String MOBILE_OF;
    static boolean REAL_CACHE;
    /** 最近一次 {@link #open} 的 loadData 跑没跑通。复制造数靠它判断复制出来的数据能不能用。 */
    static boolean LOADED;
    /** 别的探针借这里开表单时（造数复制）不列插件、不报界面那几步，只报布局转没转和 loadData 的错。 */
    static boolean QUIET;
    static final int REAL_CACHE_TTL_SECONDS = 300;

    /**
     * 要开的表单是扩展时，答出运行时真正存在的那张（被扩展的原单）；能直接开的返回 null。
     * 给 run form / run list 这类开界面的探针用：开原单，扩展上挂的插件、控件都在。
     */
    static String extensionBase(String form) {
        try {
            FormMetadataCache.getFormConfig(form);
            return null;
        } catch (Throwable missing) {
            //运行时没有这张表单，看是不是扩展
        }
        String id = null;
        try {
            id = MetadataDao.getIdByNumber(form, MetaCategory.Form);
        } catch (Throwable ignore) {
            //查不到就当没有
        }
        return id == null || id.isEmpty() ? null : MetaResolve.masterNumber(id, MetaCategory.Form);
    }

    static void resolveTarget(String form) {
        String base = extensionBase(form);
        if (base != null) {
            if (!QUIET) {
                System.out.println("[PROBE] " + form + " 是 " + base + " 的扩展，运行时并进 " + base
                        + "（扩展上挂的插件、加的控件都合在它上面），开 " + base);
            }
            form = base;
        }
        FORM = form;
        //换布局时缓存的布局元数据要一起换，否则按钮、规则、控件树都还是上一张的
        FM = null;
        MOBILE_OF = mobileOf(form);
        if (MOBILE_OF != null) {
            if (!QUIET) {
                System.out.println("[PROBE] " + form + " 是 " + MOBILE_OF + " 带的移动端布局（塞在单据布局里一起存），按移动端页面开；"
                        + "按钮、控件按这份移动端布局查");
            }
            MET = MetaResolve.type(MOBILE_OF, !QUIET);
            ENTITY = MET.getName();
            FORM_DESIGN_ID = MetadataDao.getIdByNumber(MOBILE_OF, MetaCategory.Form);
            return;
        }
        MET = MetaResolve.type(form, !QUIET);
        ENTITY = MET.getName();
        FORM_DESIGN_ID = MetadataDao.getIdByNumber(form, MetaCategory.Form);
        if (FORM_DESIGN_ID == null || FORM_DESIGN_ID.isEmpty()) {
            //这里要的是**布局标识**。实体标识之所以大多也能用，只是因为单据通常有一张同名布局；
            //没有同名布局的实体（插件只登记在派生布局上时很常见）走到的就是这句。
            throw new IllegalArgumentException("没有名为 " + form + " 的表单布局"
                    + (form.equals(ENTITY) ? "（" + form + " 是实体，不是布局）" : "")
                    + "。run form / run list 开的是布局，目标要给布局标识；"
                    + "这个实体下有哪些布局，看影响面索引里它的插件登记，或开发平台的表单列表");
        }
    }

    /**
     * 单据带的移动端页面：运行时的表单叫 <单据>_mob，设计态没有这个标识，内容是单据布局里塞着的那份移动端布局。
     * 是这种情况返回单据的布局标识，否则 null。
     */
    static String mobileOf(String form) {
        if (!form.toLowerCase().endsWith("_mob")) return null;
        String own = MetadataDao.getIdByNumber(form, MetaCategory.Form);
        if (own != null && !own.isEmpty()) return null;
        String bill = form.substring(0, form.length() - 4);
        String billId = MetadataDao.getIdByNumber(bill, MetaCategory.Form);
        if (billId == null || billId.isEmpty()) return null;
        kd.bos.metadata.form.FormMetadata fm = (kd.bos.metadata.form.FormMetadata) MetadataDao.readMeta(billId, MetaCategory.Form);
        return fm.getRootAp() instanceof kd.bos.metadata.form.BillFormAp
                && ((kd.bos.metadata.form.BillFormAp) fm.getRootAp()).getMobMeta() != null ? bill : null;
    }

    public static void run() throws Exception {
        resetState();
        String requested = req("FORM_ENTITY");
        resolveTarget(requested);
        seedCache(env("FORM_CACHE", ""));
        String pk = env("FORM_PK", "");
        String op = env("FORM_OP", "");
        String click = env("FORM_CLICK", "");
        String hyperlink = env("FORM_HYPERLINK", "");
        String skip = env("FORM_SKIP", "");
        REAL_CACHE = "1".equals(env("FORM_REAL_CACHE", ""));
        //run 的 --billno 传进来是 billno:编号
        try {
            pk = MetaResolve.pkOf(ENTITY, pk);
        } catch (IllegalArgumentException e) {
            ProbeAssert.inputInvalid("form-pk", ENTITY + " " + pk, e.getMessage());
            throw new ProbeAssert.InputInvalid(e.getMessage());
        }
        boolean edit = !pk.isEmpty();
        String status = env("FORM_STATUS", "");
        //断言分两种：字段值走数据模型，界面状态（.visible / .enabled / .mustInput）走界面状态表。
        //写错的路径在改值、点按钮之前一次报全退回；控件在不在要等转完布局才知道，所以放到打开之后一起报
        List<String[]> uiExpects = new ArrayList<String[]>();
        List<String[]> effects = new ArrayList<String[]>();
        String valueExpects = splitExpects(env("FORM_EXPECT", ""), uiExpects, effects);
        List<String[]> badPaths = badPaths(valueExpects, uiExpects, false);
        badPaths.addAll(badEffects(effects));
        ExpectSpec.Pos link = hyperlinkPos(hyperlink);
        //把「开的是哪张」和「字段从哪查」摆在同一行：上面那两行布局→实体的提示
        //曾经被读成「探针换成实体跑了」。
        System.out.println("[PROBE] === FormSim 开布局=" + FORM
                + (FORM.equals(ENTITY) ? "" : "（字段按实体 " + ENTITY + " 查）")
                + (edit ? ("view".equals(status) ? " 查看单据 pk=" : " 打开单据 pk=") + pk : " 新增") + " ===");
        System.out.println("[PROBE] 缓存模式=" + (REAL_CACHE
                ? "真实 Redis（PageCache + ModelCache，结束清理，TTL 300 秒兜底）"
                : "内存（加 --real-cache 切到真实 Redis）"));

        //只有真要跑操作时才动写通道，那时才需要红线：授权范围（docs/项目管理/验收记录.md D3）只到本 ISV 单据。
        //纯仿真（只开表单、只改值）全在内存里，读别家单据的插件行为是安全的。
        boolean willWrite = !op.isEmpty() || !click.isEmpty();
        if (willWrite) {
            //归属按给的那张算：扩展单据开的是原单，插件却是挂在扩展上的
            EntityMetadata em = MetaResolve.ownedEntity(MOBILE_OF != null ? MOBILE_OF : requested);
            IsvGuard.assertOwnEntity(em.getKey(), em);
        }
        //苍穹要求会话 id，缺了 activate 里取会话的地方会 NPE
        RequestContext.get().setGlobalSessionId("formsim-" + UUID.randomUUID().toString().replace("-", ""));

        int before = willWrite ? count(ENTITY) : -1;
        if (willWrite) {
            System.out.println("[PROBE] 跑之前行数=" + before);
        }

        List<FormView> views = new ArrayList<FormView>();
        try {
            final FormView view = open(openView(FORM, pk, edit, skip, status), skip, views);
            //控件是不是这张布局上的，要等转完布局才知道
            badPaths.addAll(badPaths(valueExpects, uiExpects, true));
            rejectBadPaths(badPaths);

            showData(view);
            //打开已有单据时记下断言字段的原值：跑完对照，碰巧对上的标出来（ExpectSpec.notePrior）
            Map<String, String> prior = edit
                    ? ExpectSpec.priorValues(view.getModel().getDataEntity(true), valueExpects, env("FORM_SET", ""))
                    : null;
            applySets(view, env("FORM_SET", ""));
            System.out.println("[PROBE] 页面状态：" + UiState.statusName(UiState.status())
                    + "（" + UiState.statusSource() + "；锁定性、可见性按它算）");
            //点的那一行要在定选中行之前记下：浏览器里点一格，那一行先成了当前行、选中行
            if (link != null) {
                hyperlinkRow(view, link);
            }
            //选中行必须在触发动作之前定下来：插件在 afterDoOperation 里读的就是它
            selectRows(env("FORM_SELECT", ""));
            f7(view, env("FORM_F7", ""));

            if (REAL_CACHE) {
                persistReal(view, "动作前");
            }
            if (!click.isEmpty()) {
                clickItem(view, click, before, ENTITY);
            } else if (!op.isEmpty()) {
                runOp(view, op, before, ENTITY);
            } else if (link != null) {
                hyperlink(view, link);
            }
            if (REAL_CACHE) {
                persistReal(view, "请求结束");
            }

            //--show 里的界面路径和不是字段的控件，归到「界面状态」一段点名，不当字段取值
            Set<String> named = new LinkedHashSet<String>();
            String shows = splitShows(env("FORM_SHOW", ""), named);
            for (String[] kv : uiExpects) {
                named.add(uiPath(kv[0])[0]);
            }
            dumpShow(view, shows);
            dumpEvents();
            dumpReach();
            dumpUi(named);

            ProbeJson.emit("scenario", "adapter", "run form", "form", FORM,
                    "entity", ENTITY,
                    "action", !click.isEmpty() ? click : !op.isEmpty() ? op : link != null ? "hyperlink:" + hyperlink : null,
                    "realCache", Boolean.valueOf(REAL_CACHE),
                    "status", UiState.statusName(UiState.status()));
            suggestFlow(pk, op, click, link == null ? "" : hyperlink, env("FORM_TOOLBAR", ""), skip);
            ExpectSpec.model(view.getModel(), valueExpects);
            for (String[] kv : uiExpects) {
                String[] up = uiPath(kv[0]);
                String got = UiState.value(up[0], up[1]);
                if (got == null) {
                    ProbeAssert.unresolved("ui", kv[0], kv[1], "这个控件没有「" + up[1] + "」这一项");
                } else {
                    ProbeAssert.isEqual("ui", kv[0], kv[1].trim(), got);
                }
            }
            assertEffects(effects);
            ExpectSpec.notePrior(prior, view.getModel().getDataEntity(true), valueExpects);
            if (!ProbeAssert.summary()) {
                throw new ProbeAssert.Failed("断言失败：" + FORM);
            }
        } finally {
            for (FormView v : views) {
                if (REAL_CACHE) {
                    releaseReal(v);
                } else {
                    releaseMutex(v);
                }
            }
        }
    }

    // ---------- 断言路径 ----------

    /**
     * 界面状态的路径：最后一段是 visible / enabled / mustInput，前面是控件、分录.字段、分录[行].字段 或 分录[行]。
     * 返回 {路径, 属性}；不是这种写法返回 null。
     */
    static String[] uiPath(String key) {
        int dot = key.lastIndexOf('.');
        if (dot <= 0 || !UiState.PROPS.contains(key.substring(dot + 1))) {
            return null;
        }
        String path = key.substring(0, dot);
        return UiState.target(path) == null ? null : new String[]{path, key.substring(dot + 1)};
    }

    /** 把 --expect 拆成字段值（原样拼回去交给 ExpectSpec.model）和界面状态（放进 ui）。 */
    static String splitExpects(String spec, List<String[]> ui) {
        return splitExpects(spec, ui, new ArrayList<String[]>());
    }

    /** 同上，动作的效果（{@link #OPENED} / {@link #MESSAGE} 开头的保留字）另放进 effects。 */
    static String splitExpects(String spec, List<String[]> ui, List<String[]> effects) {
        List<String[]> pairs;
        try {
            pairs = ExpectSpec.pairs(spec);
        } catch (IllegalArgumentException e) {
            ProbeAssert.inputInvalid("form-expect", spec, e.getMessage());
            throw new ProbeAssert.InputInvalid(e.getMessage());
        }
        StringBuilder values = new StringBuilder();
        for (String[] kv : pairs) {
            if (effectKey(kv[0]) != null) {
                effects.add(kv);
            } else if (uiPath(kv[0]) != null) {
                ui.add(kv);
            } else {
                values.append(values.length() == 0 ? "" : ";").append(kv[0]).append('=').append(kv[1]);
            }
        }
        return values.toString();
    }

    // ---------- 动作的效果：打开了哪些页面、弹给用户什么话 ----------

    /** 这次打开了哪些页面；`opened.参数` 是唯一打开的那个页面带的参数。 */
    static final String OPENED = "opened";
    /** 弹给用户的话（提示、错误、成功通知、消息框），包含比较。 */
    static final String MESSAGE = "message";

    /**
     * 断言的键是不是动作效果的保留字；是就返回去掉 `~` 的键，不是返回 null。
     *
     * 超链接、按钮、操作的效果常常不在字段上：插件 showForm 弹一个页面、或者 showTipNotification 说一句话就结束了。
     * 以前 `--expect` 只认字段值和界面状态，这类改动断不了，交付又要求有断言，就卡死在那里（真机 2026-10-09：
     * 点分录超链接查 MES、弹进度页面的需求，验不了也交不了）。这两样探针本来就记着（「捕获 showForm」「弹给用户的话」），
     * 这里只是让断言读得到。
     */
    static String effectKey(String key) {
        String k = key.endsWith("~") ? key.substring(0, key.length() - 1).trim() : key.trim();
        return OPENED.equals(k) || MESSAGE.equals(k) || k.startsWith(OPENED + ".") ? k : null;
    }

    /** 效果断言里写错的：{键, 哪里不对}。 */
    static List<String[]> badEffects(List<String[]> effects) {
        List<String[]> bad = new ArrayList<String[]>();
        for (String[] kv : effects) {
            String key = effectKey(kv[0]);
            if (key.startsWith(OPENED + ".") && key.length() == OPENED.length() + 1) {
                bad.add(new String[]{kv[0], "opened. 后面写打开的页面带的参数名，例如 opened.billno=…"});
            }
        }
        return bad;
    }

    /**
     * 断言动作的效果。打开的页面只算表单打开之后的（打开时平台按布局方案转布局那次不算），话算这次运行里所有的。
     */
    static void assertEffects(List<String[]> effects) {
        List<String> ids = new ArrayList<String>();
        for (FormShowParameter p : OPENED_FORMS) {
            ids.add(p.getFormId());
        }
        StringBuilder said = new StringBuilder();
        for (String notice : NOTICES) {
            said.append(said.length() == 0 ? "" : "\n").append(notice);
        }
        for (String[] kv : effects) {
            boolean contains = kv[0].trim().endsWith("~");
            String key = effectKey(kv[0]);
            String want = kv[1].trim();
            if (MESSAGE.equals(key)) {
                if (want.isEmpty()) {
                    ProbeAssert.isEqual("form-message", kv[0], "", said.toString());
                } else {
                    ProbeAssert.containsText("form-message", kv[0], want, said.toString());
                }
            } else if (OPENED.equals(key)) {
                if (contains) {
                    ProbeAssert.contains("form-opened", kv[0], want, ids);
                } else {
                    ProbeAssert.setEquals("form-opened", kv[0], want, ids);
                }
            } else {
                String name = key.substring(OPENED.length() + 1);
                if (OPENED_FORMS.size() != 1) {
                    ProbeAssert.unresolved("form-opened", kv[0], want, OPENED_FORMS.isEmpty()
                            ? "这次一个页面都没打开，没有参数可断"
                            : "这次打开了 " + OPENED_FORMS.size() + " 个页面（" + join(ids) + "），参数只断唯一打开的那个");
                    continue;
                }
                FormShowParameter p = OPENED_FORMS.get(0);
                Map<String, Object> params = openedParams(p);
                if (!params.containsKey(name)) {
                    ProbeAssert.unresolved("form-opened", kv[0], want, "打开的页面 " + p.getFormId()
                            + " 没带参数 " + name + "，带了：" + join(params.keySet()));
                    continue;
                }
                String got = paramText(params.get(name));
                if (contains) {
                    ProbeAssert.containsText("form-opened", kv[0], want, got);
                } else {
                    ProbeAssert.isEqual("form-opened", kv[0], want, got);
                }
            }
        }
    }

    /** 打开参数里能断的：插件 setCustomParam 放的，加上打开单据时的 pk。 */
    static Map<String, Object> openedParams(FormShowParameter p) {
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        if (p.getCustomParams() != null) {
            out.putAll(p.getCustomParams());
        }
        if (p instanceof BillShowParameter && ((BillShowParameter) p).getPkId() != null && !out.containsKey("pk")) {
            out.put("pk", ((BillShowParameter) p).getPkId());
        }
        return out;
    }

    static String paramText(Object value) {
        return value == null ? "" : ProbeAssert.shown(String.valueOf(value));
    }

    /** --show 里的界面路径、以及不是字段而是界面控件的（面板、按钮、分录），归到 named；其余原样返回。 */
    static String splitShows(String spec, Set<String> named) {
        StringBuilder fields = new StringBuilder();
        for (String one : spec.split("[;,]")) {
            String key = one.trim();
            if (key.isEmpty()) {
                continue;
            }
            String[] up = uiPath(key);
            if (up != null) {
                named.add(up[0]);
            } else if (fieldProblem(ExpectSpec.Pos.parse(key)) != null && UiState.target(key) != null
                    && UiState.problem(key) == null) {
                named.add(key);
            } else {
                fields.append(fields.length() == 0 ? "" : ";").append(key);
            }
        }
        return fields.toString();
    }

    static final String LEGAL_EXPECT = "字段值写 字段=值、分录[行].字段=值、分录[行].子分录[行].字段=值；"
            + "界面状态写 控件.visible|enabled|mustInput=true|false、分录[行].字段.enabled=…（某一格）、"
            + "分录.字段.visible=…（整列）、分录[行].enabled=…（整行锁定）";

    /**
     * --expect 里写错的路径：{路径, 哪一段不对}。
     *
     * 以前写错的路径要等跑完才在取值时失败，记成一条 FAIL 挡住交付——
     * 例如 `分录[0].字段.enabled` 在不认界面状态时被当成「子分录 字段 的 enabled 字段」去取值。
     *
     * @param afterOpen false 查字段值和界面状态的写法（实体在开表单前就定了）；true 查控件在不在（要等转完布局）
     */
    static List<String[]> badPaths(String valueExpects, List<String[]> uiExpects, boolean afterOpen) {
        List<String[]> bad = new ArrayList<String[]>();
        if (!afterOpen) {
            for (String[] kv : ExpectSpec.pairs(valueExpects)) {
                String why = fieldProblem(ExpectSpec.Pos.parse(kv[0]));
                if (why != null) {
                    bad.add(new String[]{kv[0], why});
                }
            }
            for (String[] kv : uiExpects) {
                String want = kv[1].trim();
                if (!"true".equals(want) && !"false".equals(want)) {
                    bad.add(new String[]{kv[0], "界面状态的值只写 true 或 false，收到「" + want + "」"});
                }
                UiState.Target t = UiState.target(uiPath(kv[0])[0]);
                if (t.wholeRow && !"enabled".equals(uiPath(kv[0])[1])) {
                    bad.add(new String[]{kv[0], "整行只有锁定（" + t + ".enabled），没有显示、必录"});
                }
            }
        } else {
            for (String[] kv : uiExpects) {
                String why = UiState.problem(uiPath(kv[0])[0]);
                if (why != null) {
                    bad.add(new String[]{kv[0], why});
                }
            }
        }
        return bad;
    }

    /** 有写错的路径就记「输入不成立」、不跑后面的步骤、不留验证记录。 */
    static void rejectBadPaths(List<String[]> bad) {
        if (bad.isEmpty()) {
            return;
        }
        for (String[] b : bad) {
            ProbeAssert.inputInvalid("form-expect", b[0], b[1]);
        }
        throw new ProbeAssert.InputInvalid("--expect 有 " + bad.size() + " 处路径写错，没有改值、没有点按钮。合法写法：" + LEGAL_EXPECT);
    }

    /** 字段值路径在实体上找不找得到；找得到返回 null，找不到说清是哪一段。 */
    static String fieldProblem(ExpectSpec.Pos pos) {
        if (ExpectSpec.propAt(MET, pos) != null) return null;
        if (pos.entry != null && MET.getProperties().get(pos.entry) instanceof kd.bos.dataentity.metadata.IComplexProperty) {
            return "路径 " + pos.original + " 在当前模型中不存在（关联对象未加载该属性或字段标识不存在）";
        }
        if (pos.entry == null) {
            return MET.getProperties().containsKey(pos.field) ? null
                    : ENTITY + " 上没有字段 " + pos.field
                    + (UiState.has(pos.field) ? "（" + pos.field + " 是界面控件，断言它的界面状态写 " + pos.field + ".visible / .enabled）" : "");
        }
        IDataEntityType rowType = itemType(MET, pos.entry);
        if (rowType == null) {
            return ENTITY + " 上没有分录 " + pos.entry;
        }
        if (pos.sub == null) {
            return rowType.getProperties().containsKey(pos.field) ? null
                    : "分录 " + pos.entry + " 上没有字段 " + pos.field;
        }
        IDataEntityType subType = itemType(rowType, pos.sub);
        if (subType == null) {
            return pos.sub + " 不是分录 " + pos.entry + " 下的子分录"
                    + (rowType.getProperties().containsKey(pos.sub)
                    ? "（" + pos.sub + " 是分录字段；断言它的界面状态，最后一段写 visible / enabled / mustInput）" : "");
        }
        return subType.getProperties().containsKey(pos.field) ? null
                : "子分录 " + pos.sub + " 上没有字段 " + pos.field;
    }

    /** 给尺子用：界面状态表里某个控件某一项的结论，"true" / "false"，算不出来是 null。 */
    static String uiValue(String path, String prop) {
        return UiState.value(path, prop);
    }

    /** 给尺子用：一条界面断言 `路径.属性=值` 判出来对不对；判不了是 null。和 run form --expect 走同一处。 */
    static Boolean expectUi(String assertion) {
        int eq = assertion.indexOf('=');
        String[] up = eq < 0 ? null : uiPath(assertion.substring(0, eq).trim());
        if (up == null) {
            return null;
        }
        String got = UiState.value(up[0], up[1]);
        return got == null ? null : Boolean.valueOf(got.equals(assertion.substring(eq + 1).trim()));
    }

    /**
     * 照平台打开一张表单：activate → registerListener → 控制器的 loadData。
     *
     * 新增和打开已有单据走同一条：loadData 没有 pk 就建新单、有就读库，然后绑定数据，
     * beforeBindData / afterBindData 和界面规则的初始化都在绑定这一步。新增以前直接 createNewData，
     * 绑定那一步整个没走，afterBindData 里的改动验不到。
     *
     * 单据配了布局方案时，平台读完数据会转去另一张布局（BillView.loadPageLayout → showForm），
     * 这张就此返回、不绑定数据。这里照平台给的参数跟过去开那张，后面所有步骤都在那张上跑；
     * 不跟的话插件回调一个都走不到，而 loadData 照样「成功」。
     *
     * @param views 开过的视图都记进来，真实缓存模式结束时逐个清理
     */
    static FormView open(FormView first, String skip, List<FormView> views) {
        FormView view = first;
        for (int hop = 0; ; hop++) {
            views.add(view);
            long t0 = System.currentTimeMillis();
            view.activate();
            //懒建 formRoot：不建的话操作完回写界面时 NPE
            view.getRootControl();
            if (!QUIET) {
                System.out.println("[PROBE] activate OK " + (System.currentTimeMillis() - t0) + "ms");
            }
            //生命周期由 FormController 驱动，不是 activate()：activate 只发一个客户端 addAction，
            //registerListener() / loadData() 才把事件派发给插件。
            final FormController ctl = (FormController) view.getService(IFormController.class);
            step("registerListener", new Step() {
                public void go() {
                    ctl.registerListener();
                }
            });
            OPENED_FORMS.clear();
            boolean ok = step("loadData", new Step() {
                public void go() {
                    ctl.loadData();
                }
            });
            LOADED = ok;
            if (!ok && !QUIET) {
                System.out.println("[PROBE]   打开表单时这一步抛了错（读数据、绑定数据或界面规则初始化），"
                        + "后面的步骤照常跑，没走到的回调见「本次入口走到了哪些回调」");
            }
            FormShowParameter next = layoutSwitch(FORM);
            if (next == null || hop > 0) {
                if (ok && !QUIET && !EVENTS.contains("afterBindData()")) {
                    System.out.println("[PROBE] ⚠ 平台打开流程没走到绑定数据（afterBindData），"
                            + "后面的结论落在一张没绑定过的单据上");
                }
                OPENED_FORMS.clear();
                return view;
            }
            String from = FORM;
            String fromEntity = ENTITY;
            Long scheme = ((BillShowParameter) next).getLayoutSchemeId();
            //换了布局，插件、规则、按钮都换了一套：前一张的事件和界面指令不再算数
            resetViewState();
            resolveTarget(next.getFormId());
            if (QUIET) {
                System.out.println("[PROBE]   平台按布局方案转去布局 " + FORM + "，在那张上打开");
            } else {
                System.out.println("[PROBE] ⚠ 实际打开的是布局 " + FORM + (scheme == null ? "" : "（布局方案 " + scheme + "）")
                        + "：平台读完数据按布局方案转去了这张，"
                        + from + " 没有绑定数据就返回了。下面的插件、事件、界面状态都是 " + FORM + " 的"
                        + (fromEntity.equals(ENTITY) ? "" : "（实体 " + ENTITY + "）"));
                ProbeJson.emit("layout-switch", "adapter", "run form", "from", from, "to", FORM,
                        "scheme", scheme == null ? null : String.valueOf(scheme));
            }
            view = openWith(next, skip);
        }
    }

    /**
     * loadData 里平台转去的另一张布局；没转就是 null。
     *
     * 平台不是另建一份参数，是把这张视图自己的打开参数就地改掉（BillLayoutScheme.convertLayoutShowParameter
     * 改 formId、换 FormConfig、记下原布局 KD_LAYOUT_ORIGINALFORMID），再拿它 showForm。
     * 所以要和这次要开的布局标识比，不能和视图手里的参数比——那份已经被改成新布局了。
     */
    static FormShowParameter layoutSwitch(String opened) {
        for (FormShowParameter p : OPENED_FORMS) {
            if (p instanceof BillShowParameter && !opened.equals(p.getFormId())
                    && p.getCustomParam("KD_LAYOUT_ORIGINALFORMID") != null) {
                return p;
            }
        }
        return null;
    }

    static void resetState() {
        resetViewState();
        PAGE_CACHE.clear();
        GRID_SELECTIONS.clear();
        PRINTED_SELECTIONS.clear();
        TOUCHED_ROWS.clear();
        FORM = "";
        ENTITY = "";
        FORM_DESIGN_ID = null;
        MET = null;
        FM = null;
        MOBILE_OF = null;
        REAL_CACHE = false;
        LOADED = false;
        QUIET = false;
    }

    /** 跟着某一张视图走的记录。转布局时清掉；页面缓存和选中行是这次运行的输入，留着。 */
    static void resetViewState() {
        EVENTS.clear();
        CALLS.clear();
        UiState.reset();
        NOTICES.clear();
        PLUGIN_NAMES.clear();
        PLUGIN_TYPES.clear();
        RULE_ACTIONS = 0;
        OPENED_FORMS.clear();
    }

    /**
     * 预置页面缓存。真实会话里有些键是前序请求写进去的（典型：插件在 `afterBindData` 里
     * `put("jylx_base", "zlgd_xxx")`，`registerListener` 再 `getControl(get("jylx_base"))`），
     * 仿真里那个键是空的，插件当场 NPE 并把整条派发链切断。把这些键补上，插件就能照常跑。
     */
    static void seedCache(String spec) {
        if (spec.trim().isEmpty()) {
            return;
        }
        for (String one : spec.split(";")) {
            int eq = one.indexOf('=');
            if (eq <= 0) {
                continue;
            }
            PAGE_CACHE.put(one.substring(0, eq).trim(), one.substring(eq + 1).trim());
            System.out.println("[PROBE] 预置页面缓存 " + one.trim());
        }
    }

    // ---------- 开表单 ----------

    /**
     * 入参是**布局标识**（{@link #FORM}），不是实体标识：开的就是你给的那张布局，
     * 插件清单、界面规则、按钮都从它身上取，不会折回实体。形参以前叫 {@code entity}，
     * 读代码的人据此以为这里换成了实体，改名就是为了断掉这个误会。
     */
    static FormView openView(String form, String pk, boolean edit, String skip) {
        return openView(form, pk, edit, skip, "");
    }

    /** @param status view 时按「查看」打开（要有 pk）；其余按有没有 pk 定新增还是修改 */
    static FormView openView(String form, String pk, boolean edit, String skip, String status) {
        FormConfig fc = FormMetadataCache.getFormConfig(form);
        FormShowParameter fsp = newParameter(fc);
        if (edit && !(fsp instanceof BillShowParameter)) {
            throw new IllegalStateException("表单 " + form + " 不是单据也不是基础资料（modelType="
                    + fc.getModelType() + "），没有 pk 可打开；去掉 --pk 用新增模式");
        }
        fsp.setFormId(form);
        fsp.setStatus(edit ? ("view".equals(status) ? OperationStatus.VIEW : OperationStatus.EDIT) : OperationStatus.ADDNEW);
        fsp.setPageId("formsim_" + System.nanoTime());
        fsp.setSendToClient(false);
        fsp.setFormConfig(fc);
        if (edit) {
            BillShowParameter bill = (BillShowParameter) fsp;
            bill.setPkId(pk);
            //和从列表打开一样（列表的查看、修改操作）：查看按查看开，修改按数据里的单据状态开，
            //已提交的按已提交、已审核的按已审核。平台读完数据把它发给浏览器，锁定按它算
            bill.setBillStatus("view".equals(status) ? BillOperationStatus.VIEW : listOpenStatus(fc, pk));
            if (bill.getBillStatus() == BillOperationStatus.SUBMIT || bill.getBillStatus() == BillOperationStatus.AUDIT) {
                System.out.println("[PROBE] 单据状态是" + (bill.getBillStatus() == BillOperationStatus.SUBMIT ? "已提交" : "已审核")
                        + "，和从列表点修改一样按" + (bill.getBillStatus() == BillOperationStatus.SUBMIT ? "已提交" : "已审核") + "开");
            }
        }
        return openWith(fsp, skip);
    }

    /**
     * 照平台的「复制」打开一张单据：新增状态、带上源单 pk 和 iscopy，BillController.loadData 就走 BillModel.copy——
     * 按字段的「是否复制」逐个带值（系统字段、主键、不可复制的不带，改填默认值），下推关联分录不带，
     * 最后发 afterCopyData 给表单插件。和列表上选一张单点「复制」是同一条路（kd.bos.form.operate.Copy）；
     * 基础资料的控制器继承单据的，同一条路。
     */
    static FormView openCopy(String form, String pk, String skip) {
        FormConfig fc = FormMetadataCache.getFormConfig(form);
        FormShowParameter fsp = newParameter(fc);
        if (!(fsp instanceof BillShowParameter)) {
            throw new IllegalArgumentException(form + " 不是单据也不是基础资料（modelType=" + fc.getModelType()
                    + "），平台的复制只开在这两类上");
        }
        BillShowParameter bill = (BillShowParameter) fsp;
        bill.setFormId(form);
        bill.setStatus(OperationStatus.ADDNEW);
        bill.setBillStatus(BillOperationStatus.ADDNEW);
        bill.setPageId("formsim_" + System.nanoTime());
        bill.setSendToClient(false);
        bill.setFormConfig(fc);
        bill.setPkId(pk);
        bill.getCustomParams().put("iscopy", true);
        bill.getCustomParams().put("isCopyRelateEntity", false);
        bill.getCustomParams().put("CopyEmptyRow", false);
        return openWith(bill, skip);
    }

    /** 列表的修改操作怎么定打开状态（kd.bos.form.operate.View.initPkValue）：数据里 B 按已提交、C 按已审核，其余按修改。 */
    static BillOperationStatus listOpenStatus(FormConfig fc, String pk) {
        try {
            MainEntityType type = EntityMetadataCache.getDataEntityType(fc.getEntityTypeId());
            String key = type instanceof BillEntityType ? ((BillEntityType) type).getBillStatus() : null;
            if (key != null && !key.isEmpty()) {
                DynamicObject row = BusinessDataServiceHelper.loadSingle(pk, fc.getEntityTypeId(), key);
                String value = row == null ? null : row.getString(key);
                if ("B".equals(value)) {
                    return BillOperationStatus.SUBMIT;
                }
                if ("C".equals(value)) {
                    return BillOperationStatus.AUDIT;
                }
            }
        } catch (Throwable t) {
            System.out.println("[PROBE] ⚠ 读单据状态失败，按修改开：" + brief(t));
        }
        return BillOperationStatus.EDIT;
    }

    /** 按现成的打开参数建视图、装插件。转布局时用平台给的那份参数，pk、状态、布局方案都在里面。 */
    static FormView openWith(FormShowParameter fsp, String skip) {
        FormConfig fc = fsp.getFormConfig();
        if (fc == null) {
            fc = FormMetadataCache.getFormConfig(fsp.getFormId());
            fsp.setFormConfig(fc);
        }
        fsp.setSendToClient(false);

        //FormConfig 来自元数据缓存，是全 JVM 共享的同一个对象：改完不还原，
        //之后所有跑到这张表单的探针都会跟着少插件，而且不报任何错。
        HeadlessUiSupport.PluginSelection selection = HeadlessUiSupport.selectPlugins(fc, skip);
        List<Object> origin = selection.origin();
        List<Object> kept = selection.kept();
        for (String className : selection.dropped()) {
            System.out.println("[PROBE]   摘掉插件 " + className + "（FORM_SKIP）");
        }
        int dropped = selection.dropped().size();
        if (!QUIET) {
            System.out.println("[PROBE] " + (fsp instanceof BaseShowParameter ? "基础资料"
                    : fsp instanceof BillShowParameter ? "单据" : "表单") + " modelType=" + fc.getModelType()
                    + "，元数据里配了 " + origin.size() + " 个插件，装 " + kept.size() + " 个"
                    + (dropped > 0 ? "，摘掉 " + dropped + " 个" : ""));
        }

        FormView view = newView(fsp);
        try {
            selection.install();
            view.initialize(fsp);
            ((HeadlessViews.Page) view).ensurePluginProxy();
        } finally {
            selection.restore();
        }
        for (Object pp : livePlugins(((HeadlessViews.Page) view).pluginProxy())) {
            PLUGIN_NAMES.add(pp.getClass().getName());
            PLUGIN_TYPES.add(pp.getClass());
            if (!QUIET) {
                System.out.println("[PROBE]   插件 " + pp.getClass().getName());
            }
        }
        view.addPlugin(new RecPlugin());
        UiState.view = view;
        return view;
    }

    /**
     * 平台把「发往浏览器的通道」放进视图的那一刻，就换成记账代理。
     *
     * 不能等 `super.initiService()` 跑完再换：控件建出来时各自存一份通道，
     * 分录上的指令（按行锁定 setLockState、整列隐藏 setVisibleState、分录必录 setColEditorProp）
     * 走的是控件自己存的那份；换晚了，表头那类走视图通道的收得到，分录这几类全漏，而且不报错。
     */
    static Object swapClientProxy(Class<?> clazz, Object service) {
        return clazz == IClientViewProxy.class && service != null && !HeadlessUiSupport.isRecorder(service)
                ? recorder(IClientViewProxy.class) : service;
    }

    /**
     * 打开参数按元数据的 modelType 选：base 是基础资料，带 bill 的是单据，其余是动态表单；带 mobile 的是这几样的移动端版本。
     * 每种参数平台各配一套视图、模型和控制器，选错了读不到数据，基础资料的插件调 setBillStatus 这类方法也找不到，
     * 移动端插件把视图当 IMobileView 用时转不过去。
     */
    static FormShowParameter newParameter(FormConfig fc) {
        String type = String.valueOf(fc.getModelType()).toLowerCase();
        boolean mobile = type.startsWith("mobile");
        return "base".equals(type) ? new BaseShowParameter()
                : type.indexOf("bill") >= 0 ? (mobile ? new MobileBillShowParameter() : new BillShowParameter())
                : mobile ? new MobileFormShowParameter() : new FormShowParameter();
    }

    /**
     * 新建一个无头视图，跟平台一样按打开参数的类选（{@code FormShowParameter.getViewClass}）：
     * 基础资料 BaseView、单据 BillView、其余 FormView。
     * 视图类在宿主里（{@code cosmic.headless.HeadlessViews}）：平台的脚本插件按类名找视图类、
     * 读它的包名，探针自己的类两样都给不了（见那个类的说明）。这里只接上要定制的三处。
     */
    static FormView newView(FormShowParameter fsp) {
        HeadlessViews.hook = FormSim::viewHook;
        return fsp instanceof BaseShowParameter ? new HeadlessViews.Base()
                : fsp instanceof MobileBillShowParameter ? new HeadlessViews.MobileBill()
                : fsp instanceof BillShowParameter ? new HeadlessViews.Bill()
                : fsp instanceof MobileFormShowParameter ? new HeadlessViews.MobileForm() : new HeadlessViews.Form();
    }

    static Object viewHook(String what, Object[] args) {
        FormView view = (FormView) args[0];
        if ("initiService".equals(what)) {
            //平台建服务之前放页面缓存：原厂 initiService 第三步 new ClientViewProxy(getService(IPageCache), this)，
            //页面缓存为 null 时它在构造函数里就 NPE，后面十几个服务（IFormDataBinder 等）一个都不注册，
            //而且不报错 —— 症状要等到操作完回写界面时才以 updateView 的 NPE 出现。
            view.addService(IPageCache.class, pageCache(view.getFormShowParameter().getPageId()));
        } else if ("addService".equals(what)) {
            return swapClientProxy((Class<?>) args[1], args[2]);
        } else if ("showForm".equals(what)) {
            captureOpenedForm((FormShowParameter) args[1]);
        }
        return null;
    }

    /** 真插件子类，不是动态代理：propertyChanged 这类走监听器链的事件，代理收不到 */
    public static class RecPlugin extends AbstractFormPlugin {
        @Override
        public void initialize() {
            EVENTS.add("initialize()");
        }

        @Override
        public void registerListener(EventObject e) {
            EVENTS.add("registerListener()");
        }

        @Override
        public void afterCreateNewData(EventObject e) {
            EVENTS.add("afterCreateNewData()");
        }

        @Override
        public void beforeBindData(EventObject e) {
            EVENTS.add("beforeBindData()");
        }

        @Override
        public void afterBindData(EventObject e) {
            EVENTS.add("afterBindData()");
        }

        @Override
        public void propertyChanged(PropertyChangedArgs e) {
            EVENTS.add("propertyChanged(" + (e.getProperty() == null ? "?" : e.getProperty().getName()) + ")");
        }

        @Override
        public void beforeDoOperation(BeforeDoOperationEventArgs a) {
            EVENTS.add("beforeDoOperation(" + a.getSource().getClass().getSimpleName() + ")");
        }

        @Override
        public void afterDoOperation(AfterDoOperationEventArgs e) {
            EVENTS.add("afterDoOperation(" + e.getOperateKey() + ", success="
                    + (e.getOperationResult() == null ? "?" : String.valueOf(e.getOperationResult().isSuccess())) + ")");
        }

        @Override
        public void itemClick(ItemClickEvent e) {
            EVENTS.add("itemClick(" + e.getItemKey() + "/" + e.getOperationKey() + ")");
        }
    }

    // ---------- 动作 ----------

    /**
     * `--hyperlink 分录[行].字段` 的写法和字段，开表单之前核：写错了不开表单、不改值就退回，记「输入不成立」。
     * 行在不在要等 `--set` 建完行才知道，见 {@link #hyperlinkRow}。
     */
    static ExpectSpec.Pos hyperlinkPos(String spec) {
        if (spec == null || spec.trim().isEmpty()) {
            return null;
        }
        ExpectSpec.Pos pos = null;
        String why;
        try {
            pos = ExpectSpec.Pos.parse(spec.trim());
            why = pos.entry == null
                    ? "写成 分录[行].字段（子分录 分录[行].子分录[行].字段）；表头字段的超链接走控件点击，这个入口点的是分录里的格子"
                    : fieldProblem(pos);
        } catch (IllegalArgumentException e) {
            why = "行号写成从 0 数的整数：" + e.getMessage();
        }
        if (why != null) {
            ProbeAssert.inputInvalid("form-hyperlink", spec, why);
            throw new ProbeAssert.InputInvalid("--hyperlink " + spec + " 不成立：" + why + "。没有开表单、没有改值。");
        }
        return pos;
    }

    /**
     * 点的那一格得在：超链接点的是已有的一格，不替你建行（新单要点，先用 `--set` 把那一行写出来）。
     * 在的话那一行成为当前行、记成选中行——浏览器里点一格就是这样，插件读当前行、读选中行都对得上；
     * 没给 `--select` 时 {@link #selectRows} 按它模拟选中。
     */
    static void hyperlinkRow(FormView view, ExpectSpec.Pos pos) {
        IDataModel model = view.getModel();
        int rows = model.getEntryRowCount(pos.entry);
        String why = null;
        if (pos.row >= rows) {
            why = "分录 " + pos.entry + " 只有 " + rows + " 行，没有第 " + pos.row + " 行（行号从 0 数）";
        } else if (pos.sub != null) {
            model.setEntryCurrentRowIndex(pos.entry, pos.row);
            DynamicObject parent = rowAt(model, pos.entry, pos.row);
            Collection<?> subs = parent == null ? null : parent.getDynamicObjectCollection(pos.sub);
            int n = subs == null ? 0 : subs.size();
            if (pos.subRow >= n) {
                why = pos.entry + "[" + pos.row + "] 下的子分录 " + pos.sub + " 只有 " + n + " 行，没有第 " + pos.subRow + " 行";
            }
        }
        if (why != null) {
            ProbeAssert.inputInvalid("form-hyperlink", pos.toString(), why);
            throw new ProbeAssert.InputInvalid("--hyperlink " + pos + " 不成立：" + why
                    + "。超链接点的是已有的一格；新单要点，先用 --set 写出那一行。");
        }
        model.setEntryCurrentRowIndex(pos.entry, pos.row);
        touchRow(pos.entry, pos.row);
        if (pos.sub != null) {
            model.setEntryCurrentRowIndex(pos.sub, pos.subRow);
            touchRow(pos.sub, pos.subRow);
        }
    }

    /**
     * 点分录某一格的超链接：走真表格控件的 `AbstractGrid.hyperLinkClick(字段, 行)`，浏览器点那一格时平台调的就是它——
     * 先记下点的是哪一行，再逐个派发给插件在 registerListener 里 addHyperClickListener 挂上的监听。
     * 不直接调插件的 hyperLinkClick：那样插件有没有挂监听、挂在哪个分录上都验不到。不提交，插件自己写库的照写。
     */
    static void hyperlink(FormView view, ExpectSpec.Pos pos) {
        String grid = pos.sub == null ? pos.entry : pos.sub;
        int row = pos.sub == null ? pos.row : pos.subRow;
        Object c;
        try {
            c = view.getControl(grid);
        } catch (Throwable t) {
            System.out.println("[PROBE] 【点超链接】" + pos + " ⚠ 取表格控件 " + grid + " 失败：" + brief(t));
            return;
        }
        if (!(c instanceof AbstractGrid)) {
            System.out.println("[PROBE] 【点超链接】" + pos + " ⚠ " + grid + " 不是表格控件（拿到 "
                    + (c == null ? "null" : c.getClass().getName()) + "）");
            return;
        }
        AbstractGrid g = (AbstractGrid) c;
        List<String> listeners = hyperlinkListeners(g);
        System.out.println("[PROBE] 【点超链接】" + pos + "（表格 " + grid + " 上的超链接监听："
                + (listeners == null ? "读不到" : listeners.isEmpty() ? "没有" : join(listeners)) + "）");
        if (listeners != null && listeners.isEmpty()) {
            System.out.println("[PROBE]   ⚠ 没有插件给这个表格挂超链接监听（registerListener 里 addHyperClickListener），"
                    + "点了不会进任何插件");
        }
        int ev = EVENTS.size();
        int opened = OPENED_FORMS.size();
        int said = NOTICES.size();
        if (listeners == null || !listeners.isEmpty()) {
            EVENTS.add("hyperLinkClick(" + pos.field + ", row=" + row + ")");
        }
        long t0 = System.currentTimeMillis();
        try {
            g.hyperLinkClick(pos.field, row);
        } catch (Throwable t) {
            System.out.println("[PROBE]   ⚠ hyperLinkClick 抛异常 " + brief(t));
            System.out.println("[PROBE]   栈顶: " + top(t, 6));
        }
        System.out.println("[PROBE]   耗时 " + (System.currentTimeMillis() - t0) + "ms，插件事件 +" + (EVENTS.size() - ev)
                + "，打开页面 +" + (OPENED_FORMS.size() - opened) + "，弹给用户的话 +" + (NOTICES.size() - said));
    }

    /** 表格上挂的超链接监听（类简名）；平台字段改名读不到时是 null，不当成「没有」。 */
    static List<String> hyperlinkListeners(AbstractGrid grid) {
        try {
            Field f = AbstractGrid.class.getDeclaredField("hyperLinkClickListeners");
            f.setAccessible(true);
            Object value = f.get(grid);
            List<String> out = new ArrayList<String>();
            if (value instanceof Collection) {
                for (Object listener : (Collection<?>) value) {
                    out.add(listener == null ? "null" : listener.getClass().getSimpleName());
                }
            }
            return out;
        } catch (Throwable unreadable) {
            return null;
        }
    }

    /**
     * 模拟「点开一个 F7 字段」，验插件的 `beforeF7Select`。
     *
     * 入口取 `BasedataEdit.createAndSetListShowParameter("click")` 而不是 `click()`：
     * 前者跑完 `triggerBeforeF7` → 派发 `beforeF7Select` → 把插件的 `addCustomQFilter`
     * 合进 `ListShowParameter`，就**停在这里**；后者还要接着 `showForm` 去弹列表页面。
     * 插件 `setCancel(true)` 时它返回 null —— 这就是「F7 被拦住了」的判据。
     *
     * **前提是 `registerListener` 跑完了**：`beforeF7Select` 不是插件代理派发的，
     * 是插件自己在 `registerListener` 里 `addBeforeF7SelectListener(this)` 挂上去的。
     * 注册那步被别的插件的异常截断，这里就一条监听器都没有，而且看不出来。
     */
    static void f7(FormView view, String key) {
        if (key.isEmpty()) {
            return;
        }
        Object c;
        try {
            c = view.getControl(key);
        } catch (Throwable t) {
            System.out.println("[PROBE] 【点 F7】" + key + " ⚠ 取控件失败：" + brief(t));
            return;
        }
        //别按类型判断：BasedataEdit / MulBasedataEdit / RefBillEdit / OrgEdit / UserEdit
        //各自实现同一套 F7 入口，但 RefBillEdit 并不继承 BasedataEdit，instanceof 会漏掉一半。
        //判据只有一条：这个控件身上有没有 createAndSetListShowParameter。
        Method entry = f7Entry(c);
        if (entry == null) {
            System.out.println("[PROBE] 【点 F7】" + key + " ⚠ 这个控件没有 F7 入口（拿到 "
                    + (c == null ? "null" : c.getClass().getName()) + "）");
            return;
        }
        int ev = EVENTS.size();
        int notice = NOTICES.size();
        System.out.println("[PROBE] 【点 F7】" + key + "（只跑到 beforeF7Select，不弹列表）");
        ListShowParameter lsp;
        try {
            lsp = (ListShowParameter) entry.invoke(c, "click");
        } catch (Throwable t) {
            System.out.println("[PROBE]   ⚠ 失败：" + brief(t));
            System.out.println("[PROBE]   栈顶: " + top(t, 5));
            return;
        }
        System.out.println("[PROBE]   插件事件 +" + (EVENTS.size() - ev));
        if (lsp == null) {
            System.out.println("[PROBE]   结果：**F7 被拦住了**（插件 setCancel(true)），列表不会弹出来"
                    + (NOTICES.size() > notice ? "。理由看下面「弹给用户的话」" : "，但插件没给用户任何提示"));
            return;
        }
        System.out.println("[PROBE]   结果：放行。列表页面=" + lsp.getFormId()
                + "  基础资料=" + lsp.getBillFormId()
                + "  多选=" + lsp.isMultiSelect() + "  使用组织=" + lsp.getUseOrgId());
        List<QFilter> qs = lsp.getListFilterParameter() == null
                ? null : lsp.getListFilterParameter().getQFilters();
        if (qs == null || qs.isEmpty()) {
            System.out.println("[PROBE]   过滤条件：无 —— 插件没加任何 addCustomQFilter");
            return;
        }
        System.out.println("[PROBE]   过滤条件 " + qs.size() + " 条（插件的 addCustomQFilter 已合进来）");
        for (QFilter q : qs) {
            System.out.println("[PROBE]     " + oneLine(String.valueOf(q)));
        }
    }

    /** 数据到底进来没有 —— loadData 不报错但没装上数据时，后面所有断言都是在空单上做的 */
    /** 沿类层次找 F7 入口；找不到返回 null */
    static Method f7Entry(Object c) {
        for (Class<?> k = c == null ? null : c.getClass(); k != null; k = k.getSuperclass()) {
            try {
                Method m = k.getDeclaredMethod("createAndSetListShowParameter", String.class);
                m.setAccessible(true);
                return m;
            } catch (NoSuchMethodException ignore) {
                continue;
            }
        }
        return null;
    }

    static void showData(FormView view) {
        try {
            DynamicObject d = view.getModel().getDataEntity();
            if (d == null) {
                System.out.println("[PROBE] ⚠ 数据模型是空的，后面的断言都会落在空单上");
                return;
            }
            Object pk = d.getPkValue();
            Object no = d.getDataEntityType().getProperties().containsKey("billno") ? d.get("billno") : null;
            System.out.println("[PROBE] 数据 pk=" + pk + (no == null ? "" : "  billno=" + no)
                    + "  分录 " + d.getDataEntityType().getProperties().size() + " 个属性");
        } catch (Throwable t) {
            System.out.println("[PROBE] ⚠ 读数据模型失败：" + brief(t));
        }
    }

    /**
     * `--set`：表头 `字段`、分录 `分录.字段` / `分录[2].字段`、子分录 `分录[2].子分录[1].字段`。
     *
     * 路径解析与 `--expect` 共用 {@link ExpectSpec.Pos}：两边写法不一致的话，
     * 「照着断言把 set 抄一行」就会错，而那正是用例最常见的写法。
     *
     * 此前这里只有一句 `model.setValue(key, value)` —— 单参重载认不了带点的路径
     * （抛 `属性:分录.字段不存在`），分录字段只能靠裸标识落在**当前行**，既不能指定行、
     * 也不能建行。而 OpSandbox / RuleSim / FormCallbackSim 三个适配器早就支持分录路径，
     * 于是同一条 `分录[0].字段=值` 在 `run op` 下成立、在 `run form` 下报「属性不存在」。
     */
    static void applySets(FormView view, String spec) {
        if (spec.trim().isEmpty()) {
            return;
        }
        IDataModel model = view.getModel();
        MainEntityType met = MET;
        //逐条容错沿用原样：一条写错只跳过一条并说清楚，不因此让整批 --set 作废
        //（ExpectSpec.pairs 对畸形项是抛异常，那是 --expect 的口径，不搬过来）
        for (String one : spec.split(";")) {
            String s = one.trim();
            if (s.isEmpty()) {
                continue;
            }
            int eq = s.indexOf('=');
            if (eq <= 0) {
                System.out.println("[PROBE]   ⚠ 忽略「" + s + "」—— 不是 字段=值 的形状");
                continue;
            }
            ExpectSpec.Pos pos = ExpectSpec.Pos.parse(s.substring(0, eq).trim());
            String val = s.substring(eq + 1).trim();
            int ev = EVENTS.size();
            int ui = UiState.size();
            int ra = RULE_ACTIONS;
            try {
                Object v = value(met, pos, val);
                if (pos.entry == null) {
                    model.setValue(pos.field, v);
                } else if (pos.sub == null) {
                    ensureRows(model, met, pos.entry, pos.row);
                    //当前行跟着一起挪：插件里大量 getValue(key) 读的是当前行，
                    //只写值不挪行的话，插件看到的还是第 0 行
                    model.setEntryCurrentRowIndex(pos.entry, pos.row);
                    model.setValue(pos.field, v, pos.row);
                    //当前行只喂 getValue；getSelectRows() 要的是选中行，记在这里等 selectRows() 统一模拟
                    touchRow(pos.entry, pos.row);
                } else {
                    ensureRows(model, met, pos.entry, pos.row);
                    model.setEntryCurrentRowIndex(pos.entry, pos.row);
                    touchRow(pos.entry, pos.row);
                    touchRow(pos.sub, pos.subRow);
                    //父行只能从集合上取：getEntryEntity(String,int) 在 AbstractFormDataModel
                    //上有，在 IDataModel 接口上没有，按接口类型调编译不过
                    ensureSubRows(model, rowAt(model, pos.entry, pos.row), pos.sub, pos.subRow);
                    //四参重载：(key, value, rowIndex, parentRowIndex)，子分录行在前
                    model.setValue(pos.field, v, pos.subRow, pos.row);
                }
                //界面指令和界面规则动作分开数：混成一个「界面动作」会让「插件没反应」
                //和「规则没触发」长得一样，那是两种完全不同的排查方向
                System.out.println("[PROBE] setValue " + pos + " = " + val
                        + "  → 插件事件 +" + (EVENTS.size() - ev)
                        + "，界面指令 +" + (UiState.size() - ui)
                        + "，规则动作 +" + (RULE_ACTIONS - ra));
            } catch (Throwable t) {
                System.out.println("[PROBE] setValue " + pos + " = " + val + "  ⚠ 失败：" + brief(t));
            }
        }
    }

    /** 分录的第 row 行；越界或没有这个分录时返回 null。 */
    static DynamicObject rowAt(IDataModel model, String entry, int row) {
        DynamicObjectCollection rows = model.getEntryEntity(entry);
        return rows == null || rows.size() <= row ? null : (DynamicObject) rows.get(row);
    }

    /**
     * 分录行不够就补到够。新增单的分录常常是 0 行，`分录[0].字段` 得先有第 0 行。
     *
     * 先校验标识：分录名写错时 `getEntryRowCount` 抛的是 NullPointerException，
     * 而「NPE(无)」看不出是写错了标识还是环境坏了。
     */
    static void ensureRows(IDataModel model, MainEntityType met, String entry, int row) {
        if (met != null && itemType(met, entry) == null) {
            throw new IllegalArgumentException("没有分录 " + entry + "（它不是这张单上的分录标识）");
        }
        //有界：建行不生效时宁可报错，也不要让探针空转到超时 —— 挂住的运行查不出原因
        for (int guard = 0; model.getEntryRowCount(entry) <= row; guard++) {
            if (guard > row + 1) {
                throw new IllegalStateException("分录 " + entry + " 建行没有生效，仍然只有 "
                        + model.getEntryRowCount(entry) + " 行");
            }
            model.createNewEntryRow(entry);
        }
    }

    /**
     * 子分录挂在**某一父行**下，行数只能从那一行的集合上数，不能用 getEntryRowCount。
     *
     * 建行没有「按父行建」的入口：`createNewEntryRow(key, DynamicObject)` 的第二参是
     * **要插入的那一行**，不是父行（传父行会抛「数据行类型与集合类型不匹配」）。定位靠的是
     * 父分录的当前行，所以调用方必须先 setEntryCurrentRowIndex 把父行挪过去。
     */
    static void ensureSubRows(IDataModel model, DynamicObject parent, String sub, int row) {
        if (parent == null) {
            throw new IllegalStateException("取不到父分录行，无法定位子分录 " + sub);
        }
        if (parent.getDynamicObjectCollection(sub) == null) {
            throw new IllegalArgumentException("父分录行上没有子分录 " + sub);
        }
        for (int guard = 0; parent.getDynamicObjectCollection(sub).size() <= row; guard++) {
            if (guard > row + 1) {
                throw new IllegalStateException("子分录 " + sub + " 建行没有生效，仍然只有 "
                        + parent.getDynamicObjectCollection(sub).size() + " 行");
            }
            model.createNewEntryRow(sub);
        }
    }

    /**
     * FORM_SHOW：把指定字段的**终值**打出来。
     * 「插件事件 +N」只证明联动被触发了，证明不了它写对了值 —— 断言联动结果得看这里。
     * 表头写字段标识，分录写 `分录标识.字段`（每行一条，最多打 10 行），
     * 子分录写 `分录[2].子分录.字段` —— 子分录挂在某一父行下，不给父行下标就默认第 0 行。
     */
    static void dumpShow(FormView view, String spec) {
        if (spec.trim().isEmpty()) {
            return;
        }
        IDataModel model = view.getModel();
        System.out.println("[PROBE] --- 字段终值 ---");
        for (String one : spec.split("[;,]")) {
            String key = one.trim();
            if (key.isEmpty()) {
                continue;
            }
            try {
                ExpectSpec.Pos pos = ExpectSpec.Pos.parse(key);
                if (pos.entry == null) {
                    ExpectSpec.checkReference(model.getDataEntity(), pos, key, false);
                    System.out.println("[PROBE]   " + key + " = " + showVal(model.getValue(pos.field)));
                } else if (pos.sub == null) {
                    Collection<?> rows = model.getEntryEntity(pos.entry);
                    int n = rows == null ? 0 : rows.size();
                    System.out.println("[PROBE]   " + key + "  " + n + " 行");
                    for (int i = 0; i < n; i++) {
                        ExpectSpec.checkReference(model.getDataEntity(), ExpectSpec.Pos.parse(pos.entry + "[" + i + "]." + pos.field), key + "[" + i + "]", false);
                        System.out.println("[PROBE]     [" + i + "] = " + showVal(model.getValue(pos.field, i)));
                    }
                } else {
                    DynamicObject parent = rowAt(model, pos.entry, pos.row);
                    Collection<?> rows = parent == null ? null : parent.getDynamicObjectCollection(pos.sub);
                    int n = rows == null ? 0 : rows.size();
                    System.out.println("[PROBE]   " + pos.entry + "[" + pos.row + "]." + pos.sub
                            + "." + pos.field + "  " + n + " 行");
                    for (int i = 0; i < n; i++) {
                        //四参 getValue 同样是 (key, rowIndex, parentRowIndex)
                        ExpectSpec.checkReference(model.getDataEntity(), ExpectSpec.Pos.parse(pos.entry + "[" + pos.row + "]." + pos.sub + "[" + i + "]." + pos.field), key + "[" + i + "]", false);
                        System.out.println("[PROBE]     [" + i + "] = "
                                + showVal(model.getValue(pos.field, i, pos.row)));
                    }
                }
            } catch (Throwable t) {
                System.out.println("[PROBE]   " + key + "  ⚠ 取不到：" + brief(t));
            }
        }
    }

    /** 基础资料打 number(name)，别打 DynamicObject 的 toString */
    static String showVal(Object v) {
        if (v == null) {
            return "(null)";
        }
        //多选是一张子表：逐行按可读值打。断言侧同样按行比（ExpectSpec.assertValue），
        //两边看到的是同一串，照着 --show 抄一条 --expect 才成立
        if (v instanceof DynamicObjectCollection) {
            StringBuilder sb = new StringBuilder();
            for (Object row : (DynamicObjectCollection) v) {
                if (sb.length() > 0) {
                    sb.append(',');
                }
                sb.append(ExpectSpec.render(row));
            }
            return sb.length() == 0 ? "(空)" : sb.toString();
        }
        if (v instanceof DynamicObject) {
            DynamicObject o = (DynamicObject) v;
            String number = o.getDataEntityType().getProperties().containsKey("number")
                    ? o.getString("number") : String.valueOf(o.getPkValue());
            String name = o.getDataEntityType().getProperties().containsKey("name")
                    ? o.getString("name") : "";
            return name.isEmpty() ? number : number + "(" + name + ")";
        }
        //多行文本换行写 \n，和断言比的是同一种写法，照着抄进 --expect 就对得上
        return ProbeAssert.shown(String.valueOf(v));
    }

    /**
     * 值转换走共用契约 {@link ExpectSpec#convert}：基础资料给编码也认、日期转 Date、
     * 多选基础资料转 id 数组（`MulBasedataProp.setFieldValue` 认 Object[]，字节码里确认过）。
     *
     * 属性要从**字段所在那一层**上找：分录/子分录字段不在 MainEntityType 的顶层属性里，
     * 此前按顶层查必然落空，于是分录上的基础资料字段被当成普通字段、把编码原样写了进去。
     */
    static Object value(MainEntityType met, ExpectSpec.Pos pos, String val) {
        return ExpectSpec.convert(met, pos, val);
    }

    /** 分录/子分录属性的行类型；不是集合属性（写错了标识）时返回 null。 */
    static IDataEntityType itemType(IDataEntityType host, String entry) {
        return ExpectSpec.itemType(host, entry);
    }

    static void clickItem(FormView view, String itemKey, int before, String entity) {
        clickItem(view, itemKey, before, entity, env("FORM_TOOLBAR", ""));
    }

    static void clickItem(FormView view, String itemKey, int before, String entity,
                          String toolbarOverride) {
        String bar = null;
        Toolbar tb = null;
        java.util.LinkedHashSet<String> toolbarKeys = new java.util.LinkedHashSet<String>();
        String requested = toolbarOverride == null ? "" : toolbarOverride.trim();
        if (!requested.isEmpty()) {
            toolbarKeys.add(requested);
        }
        toolbarKeys.add("tbmain");
        toolbarKeys.add("toolbarap");
        toolbarKeys.add("advcontoolbarap");
        toolbarKeys.add("advcontoolbarap1");
        try {
            for (kd.bos.metadata.form.ControlAp<?> ap : formMeta().getItems()) {
                toolbarKeys.add(ap.getKey());
            }
        } catch (Throwable ignore) {
            //元数据枚举失败仍保留常见 key
        }
        for (String k : toolbarKeys) {
            try {
                Object c = view.getControl(k);
                if (c instanceof Toolbar) {
                    tb = (Toolbar) c;
                    bar = k;
                    break;
                }
            } catch (Throwable ignore) {
                continue;
            }
        }
        if (tb == null) {
            System.out.println("[PROBE] ⚠ 没找到工具栏控件"
                    + (requested.isEmpty() ? "" : " " + requested)
                    + "，可加 --toolbar <控件key>，或改用 --op 直接跑操作");
            return;
        }
        String opKey = opKeyOf(itemKey, env("FORM_OP", itemKey));
        System.out.println("[PROBE] 【点按钮】" + bar + "." + itemKey + " → 操作 " + opKey + "（真提交）");
        final Toolbar fb = tb;
        final String key = itemKey;
        final String ok = opKey;
        int ev = EVENTS.size();
        long t0 = System.currentTimeMillis();
        try {
            fb.itemClick(key, ok);
        } catch (Throwable t) {
            System.out.println("[PROBE]   ⚠ itemClick 抛异常 " + brief(t));
            System.out.println("[PROBE]   栈顶: " + top(t, 5));
        }
        System.out.println("[PROBE]   耗时 " + (System.currentTimeMillis() - t0)
                + "ms，插件事件 +" + (EVENTS.size() - ev));
        committed(view, entity, before, opKey, doneSince(ev));
    }

    /**
     * 点按钮没有返回值，操作成没成从这之后记下的 afterDoOperation 事件里看：
     * 有一次没成就算没成，都成了才算成；按钮没触发操作（纯界面动作）返回 null。
     */
    static Boolean doneSince(int from) {
        Boolean done = null;
        for (int i = from; i < EVENTS.size(); i++) {
            String e = EVENTS.get(i);
            if (!e.startsWith("afterDoOperation(")) {
                continue;
            }
            if (e.endsWith("success=false)")) {
                return Boolean.FALSE;
            }
            if (e.endsWith("success=true)")) {
                done = Boolean.TRUE;
            }
        }
        return done;
    }

    static void runOp(FormView view, String op, int before, String entity) {
        System.out.println("[PROBE] 【跑操作】invokeOperation(" + op + ")（真提交）");
        int ev = EVENTS.size();
        long t0 = System.currentTimeMillis();
        Object r = null;
        try {
            r = view.invokeOperation(op);
        } catch (Throwable t) {
            System.out.println("[PROBE]   ⚠ 抛异常 " + brief(t));
            System.out.println("[PROBE]   栈顶: " + top(t, 6));
        }
        System.out.println("[PROBE]   耗时 " + (System.currentTimeMillis() - t0)
                + "ms，插件事件 +" + (EVENTS.size() - ev));
        if (r instanceof OperationResult) {
            OperationResult or = (OperationResult) r;
            System.out.println("[PROBE]   结果 isSuccess=" + or.isSuccess()
                    + "  成功=" + or.getSuccessPkIds().size());
            for (IOperateInfo i : or.getAllErrorOrValidateInfo()) {
                System.out.println("[PROBE]   [错误] " + oneLine(i.getMessage()));
            }
            //失败但一条校验信息都没有 = 根本没走到服务端校验器，是界面层把它拦了。
            //派发链在 setCancel 之后就不再往后走，所以本探针的记账插件也收不到 beforeDoOperation。
            if (!or.isSuccess() && or.getAllErrorOrValidateInfo().isEmpty()) {
                System.out.println("[PROBE]   ⚠ 失败但没有校验信息：多半是某个表单插件在 beforeDoOperation 里"
                        + " setCancel 了。看下面「弹给用户的话」，那通常就是它给的理由；"
                        + "要定位是哪个插件，用 --skip 逐个摘掉重跑");
            }
        } else if (r != null) {
            System.out.println("[PROBE]   返回 " + r.getClass().getName());
        }
        committed(view, entity, before, op, r instanceof OperationResult ? Boolean.valueOf(((OperationResult) r).isSuccess()) : null);
    }

    /**
     * 按钮、操作跑完之后库里变成了什么（S27 起真提交，不再回滚）：行数对照，加上界面上这张单的现状。
     * 以前这里核对「无痕」—— 事务兜住了没有；现在要回答的是「落了什么、下一次再跑它是什么样」。
     */
    static void committed(FormView view, String entity, int before, String what, Boolean done) {
        int after = count(entity);
        System.out.println("[PROBE]   跑之后行数=" + after
                + (before >= 0 && after >= 0 && after != before ? "（" + (after > before ? "+" : "") + (after - before) + "）" : ""));
        Object pk = null;
        try {
            pk = view.getModel().getDataEntity().getPkValue();
        } catch (Throwable ignore) {
            //拿不到就不报现状：行数那一行已经说了落没落
        }
        MetaResolve.reportCommitted(entity, pk, what, done);
    }

    // ---------- 输出 ----------

    static void dumpEvents() {
        System.out.println("[PROBE] --- 插件事件 " + EVENTS.size() + " 条 ---");
        if ("1".equals(env("FORM_EVENTS", ""))) {
            for (String s : EVENTS) {
                System.out.println("[PROBE]   " + s);
            }
            return;
        }
        //默认只报「哪种事件各几次」，明细用 FORM_EVENTS=1。
        //propertyChanged 例外：它带的字段名本身就是结论，收成一行列出来
        Map<String, int[]> n = new LinkedHashMap<String, int[]>();
        Set<String> changed = new java.util.LinkedHashSet<String>();
        for (String s : EVENTS) {
            String k = s.substring(0, s.indexOf('(') + 1) + ")";
            if (s.startsWith("propertyChanged(")) {
                changed.add(s.substring(16, s.length() - 1));
            }
            int[] c = n.get(k);
            if (c == null) {
                n.put(k, new int[]{1});
            } else {
                c[0]++;
            }
        }
        for (Map.Entry<String, int[]> e : n.entrySet()) {
            System.out.println("[PROBE]   " + e.getKey() + " ×" + e.getValue()[0]
                    + ("propertyChanged()".equals(e.getKey()) ? "  字段：" + join(changed) : ""));
        }
        System.out.println("[PROBE]   （明细加 FORM_EVENTS=1）");
    }

    /**
     * 插件重写了哪些回调、这一次的入口走到了哪几个 —— 以及**没走到哪几个**。
     *
     * 为什么要有这一段：一次 `run form --click 某按钮` 断言全绿，读起来像「这个需求验完了」，
     * 而它只证明了「这个按钮那条路上的断言成立」。真机上就这么翻过车：改动分两组，
     * 一组挂在按钮的 `afterDoOperation` 上、另一组挂在弹窗关闭的 `closedCallBack` 上，
     * 五条断言全走按钮，`closedCallBack` 一次都没执行，回执照样 PASS，
     * 线上验收当场失败。回执没说谎，说谎的是「PASS＝需求验完了」这个默认理解。
     *
     * 所以这里把口径摆出来：没走到的回调列清楚。它不拦任何东西，也不猜「你的改动在哪个回调里」
     * ——那要靠人对着自己的 diff 看一眼。它只保证**看得见**：改动落在这几个名字里的话，
     * 这次 PASS 证明不了它。
     */
    static void dumpReach() {
        if (PLUGIN_TYPES.isEmpty()) {
            return;
        }
        Set<String> fired = new java.util.LinkedHashSet<String>();
        for (String event : EVENTS) {
            int cut = event.indexOf('(');
            fired.add(cut < 0 ? event : event.substring(0, cut));
        }
        boolean printed = false;
        for (Class<?> type : PLUGIN_TYPES) {
            Set<String> overridden = callbacks(type);
            if (overridden.isEmpty()) {
                continue;
            }
            List<String> missed = new ArrayList<String>();
            for (String name : overridden) {
                if (!fired.contains(name)) {
                    missed.add(name);
                }
            }
            if (!printed) {
                System.out.println("[PROBE] --- 本次入口走到了哪些回调");
                printed = true;
            }
            System.out.println("[PROBE]   " + type.getName() + " 重写 " + overridden.size()
                    + " 个回调，本次走到 " + (overridden.size() - missed.size()) + " 个");
            if (!missed.isEmpty()) {
                System.out.println("[PROBE]   ⚠ 没走到：" + join(missed));
                System.out.println("[PROBE]     改动落在这几个回调里的话，本次断言证明不了它"
                        + "——换一个能走到它的入口再验一次，或者在交付里写明这段没验。");
            }
        }
    }

    /** 插件自己重写的框架回调。只看它自己声明的方法，父类里没被重写的那些不算它的。 */
    private static Set<String> callbacks(Class<?> type) {
        Set<String> names = new java.util.LinkedHashSet<String>();
        for (Class<?> c = type; c != null; c = c.getSuperclass()) {
            //到平台基类就停：AbstractFormPlugin 自己声明了全部回调，再往上数就成了「它重写了 30 个」
            if (c.getName().startsWith("kd.bos.")) {
                break;
            }
            for (java.lang.reflect.Method m : c.getDeclaredMethods()) {
                if (CALLBACKS.contains(m.getName())) {
                    names.add(m.getName());
                }
            }
        }
        return names;
    }

    /**
     * 框架会回调进插件的方法名。
     *
     * 写成白名单而不是「public void 且参数是某个 Event」：后者会把插件自己的工具方法
     * 一并算成回调，「没走到 12 个」里十个是它自己的私活，这段提示就没人看了。
     */
    private static final Set<String> CALLBACKS = new HashSet<String>(java.util.Arrays.asList(
            "initialize", "registerListener", "preOpenForm", "onGetControl",
            "beforeBindData", "afterBindData", "afterCreateNewData", "afterLoadData",
            "propertyChanged", "beforeDoOperation", "afterDoOperation",
            "itemClick", "click", "beforeClick", "beforeItemClick",
            "closedCallBack", "confirmCallBack", "messageBoxClosed", "beforeClosed",
            "beforeF7Select", "afterF7Select", "hyperLinkClick", "contextMenuClick",
            "entryRowClick", "entryRowDoubleClick", "packageData", "setFilter",
            "filterContainerInit", "billListHyperLinkClick", "listRowClick"));

    static void dumpUi(Collection<String> named) {
        UiState.dump(named);
        if (!NOTICES.isEmpty()) {
            System.out.println("[PROBE] --- 弹给用户的话 " + NOTICES.size() + " 条 ---");
            for (String s : NOTICES) {
                System.out.println("[PROBE]   " + s);
            }
        }
        int tail = Integer.parseInt(env("FORM_CALLS", "0"));
        System.out.println("[PROBE] --- 客户端调用共 " + CALLS.size() + " 条"
                + (tail > 0 ? "，打最后 " + tail + " 条" : "（要看原文加 FORM_CALLS=N）") + " ---");
        for (int i = Math.max(0, CALLS.size() - tail); i < CALLS.size(); i++) {
            System.out.println("[PROBE]   " + CALLS.get(i));
        }
    }

    static kd.bos.metadata.form.FormMetadata formMeta() {
        if (FM == null) {
            FM = (kd.bos.metadata.form.FormMetadata) MetadataDao.readMeta(
                    FORM_DESIGN_ID, MetaCategory.Form);
            if (MOBILE_OF != null) FM = ((kd.bos.metadata.form.BillFormAp) FM.getRootAp()).getMobMeta();
        }
        return FM;
    }

    /**
     * 按钮 key → 它绑的操作 key。**`Toolbar.itemClick(itemKey, operationKey)` 两个参数不是一回事**：
     * 第二个传按钮 key 会被当成操作去找实现类，报「操作未定义实现类」。
     */
    static String opKeyOf(String itemKey, String fallback) {
        try {
            for (kd.bos.metadata.form.ControlAp<?> ap : formMeta().getItems()) {
                if (!itemKey.equals(ap.getKey())) {
                    continue;
                }
                Object v = ap.getClass().getMethod("getOperationKey").invoke(ap);
                if (v != null && !String.valueOf(v).isEmpty()) {
                    return String.valueOf(v);
                }
            }
        } catch (Throwable ignore) {
            //取不到就用兜底值
        }
        return fallback;
    }

    /**
     * 发往前端的调用里，改显示、锁定、必录、页面状态的交给 {@link UiState} 记（带上是谁发的），
     * 界面规则的动作按规则本体解回控件，弹给用户的话单独收。
     */
    static void classify(String m, Object[] a) {
        if (a == null || a.length == 0) {
            return;
        }
        if (UiState.relevant(m, a)) {
            UiState.record(m, a, caller());
        } else if ("addRuleAction".equals(m)) {
            //界面规则的「设置控件属性」动作是 ClientAction：服务端只把 actionId 和行号推给前端，
            //显隐在浏览器里做。这里按规则本体把 actionId 解回「哪条规则、哪个分支、管哪些控件」，并进界面状态
            RULE_ACTIONS++;
            UiState.ruleAction(String.valueOf(a[0]), a.length > 1 && a[1] instanceof Number ? ((Number) a[1]).intValue() : -1);
        } else if ("addNotificationMsg".equals(m)) {
            //showErrorNotification / showTipNotification / showSuccessNotification 走的是这个口，
            //**不是 addAction** —— 只认 addAction 会把「插件到底给没给用户提示」漏报成「没给」。
            NOTICES.add(notice(a[0]));
        } else if ("addAction".equals(m) && a.length >= 2 && isNotice(String.valueOf(a[0]))) {
            NOTICES.add(a[0] + ": " + oneLine(String.valueOf(a[1])));
        }
    }

    /** 这条调用是谁发的：调用栈里第一个装进来的插件类（含它的内部类）和方法；没有就是平台自己。 */
    static String caller() {
        for (StackTraceElement e : new Throwable().getStackTrace()) {
            String c = e.getClassName();
            int inner = c.indexOf('$');
            if (PLUGIN_NAMES.contains(inner < 0 ? c : c.substring(0, inner))) {
                return "插件 " + c.substring(c.lastIndexOf('.') + 1) + "." + e.getMethodName();
            }
        }
        return "平台";
    }

    /** AbstractFormView.showNotification 的 type：0 成功 / 1 错误 / 2 提示 */
    static String notice(Object arg) {
        String raw = oneLine(String.valueOf(arg));
        String kind = raw.contains("type=1") ? "错误" : raw.contains("type=2") ? "提示"
                : raw.contains("type=0") ? "成功" : "通知";
        int i = raw.indexOf("content=");
        String body = i < 0 ? raw : raw.substring(i + 8).replaceAll("[,}].*$", "");
        return kind + ": " + body;
    }

    static boolean isNotice(String action) {
        String a = action.toLowerCase();
        return a.contains("message") || a.contains("notification") || a.contains("confirm")
                || a.contains("tip") || a.contains("alert");
    }

    // ---------- 记账代理 ----------

    @SuppressWarnings("unchecked")
    static <T> T recorder(final Class<T> iface) {
        //每个视图一份，和平台一样：发往浏览器的通道是一个视图一个
        final Map<String, Map<String, Object>> metaState = new HashMap<String, Map<String, Object>>();
        final Map<String, GridState> gridStates = new HashMap<String, GridState>();
        final Map<String, String> appliedSelections = new HashMap<String, String>();
        return HeadlessUiSupport.recorder(iface, new HeadlessUiSupport.ClientCallSink() {
            public void accept(Class<?> type, Method method, Object[] args) {
                CALLS.add(type.getSimpleName() + "." + method.getName() + deep(args));
                if (type == IClientViewProxy.class) {
                    classify(method.getName(), args);
                    cacheMetaState(metaState, method.getName(), args);
                }
            }
        }, new HeadlessUiSupport.ClientReturnProvider() {
            public boolean supports(Class<?> type, Method method, Object[] args) {
                if (type != IClientViewProxy.class || args == null || args.length == 0) {
                    return false;
                }
                return "getControlMetaState".equals(method.getName())
                        || "getEntryState".equals(method.getName());
            }

            public Object value(Class<?> type, Method method, Object[] args) {
                if ("getControlMetaState".equals(method.getName())) {
                    return metaState.get(String.valueOf(args[0]));
                }
                String grid = String.valueOf(args[0]);
                int[] rows = GRID_SELECTIONS.get(grid);
                if (rows == null) {
                    rows = GRID_SELECTIONS.get("*");
                }
                // 平台通过这份可变状态读写当前行，不能每次查询都返回新对象。
                GridState state = gridStates.get(grid);
                if (state == null) {
                    state = new GridState(grid, new HashMap<String, Object>());
                    gridStates.put(grid, state);
                }
                String selection = java.util.Arrays.toString(rows);
                if (rows != null && !selection.equals(appliedSelections.get(grid))) {
                    appliedSelections.put(grid, selection);
                    state.selectRow(rows);
                    if (rows.length > 0) {
                        state.setFocusRow(rows[0]);
                    }
                    if (PRINTED_SELECTIONS.add(grid)) {
                        System.out.println("[PROBE] 模拟前端选中 " + grid + " rows="
                                + java.util.Arrays.toString(rows));
                    }
                }
                return state;
            }
        });
    }

    /**
     * 平台发往浏览器的通道会记住发过的页面状态和锁定（{@code ClientViewProxy.cacheLockState}），
     * 平台自己判字段能不能改（{@code FieldEdit.checkEditFieldStatus}）先查这份记录。记账代理照同样的规矩记一份，
     * 平台来查时照样给；不记的话平台那一侧当成从没发过，退回按数据里的单据状态判，查看状态也当能改。
     */
    static void cacheMetaState(Map<String, Map<String, Object>> state, String m, Object[] a) {
        if (a == null) {
            return;
        }
        if ("addAction".equals(m) && a.length == 2) {
            String name = String.valueOf(a[0]);
            Object p = a[1];
            if ("setFormStatus".equals(name) || "setBillStatus".equals(name)) {
                metaState(state, "status", "status", p);
            } else if ("setEnable".equals(name) && p instanceof Map) {
                Object keys = ((Map<?, ?>) p).get("keys");
                if (keys instanceof String[]) {
                    for (String key : (String[]) keys) {
                        metaState(state, key, "lockControl", ((Map<?, ?>) p).get("enable"));
                    }
                }
            } else if ("updateControlMetadata".equals(name) && p instanceof List && ((List<?>) p).size() > 1
                    && ((List<?>) p).get(1) instanceof Map && ((Map<?, ?>) ((List<?>) p).get(1)).containsKey("l")) {
                metaState(state, String.valueOf(((List<?>) p).get(0)), "l", ((Map<?, ?>) ((List<?>) p).get(1)).get("l"));
            }
        } else if ("invokeControlMethod".equals(m) && a.length >= 3 && "setColProp".equals(a[1])
                && a[2] instanceof Object[] && ((Object[]) a[2]).length >= 3) {
            Object[] v = (Object[]) a[2];
            metaState(state, String.valueOf(v[0]), String.valueOf(v[1]), v[2]);
        }
    }

    static void metaState(Map<String, Map<String, Object>> state, String key, String property, Object value) {
        Map<String, Object> props = state.get(key);
        if (props == null) {
            props = new HashMap<String, Object>();
            state.put(key, props);
        }
        props.put(property, value);
    }

    /** 记下一次 `--set` 落在哪个分录的哪一行。子分录的 grid key 就是子分录标识。 */
    static void touchRow(String grid, int row) {
        Set<Integer> rows = TOUCHED_ROWS.get(grid);
        if (rows == null) {
            rows = new LinkedHashSet<Integer>();
            TOUCHED_ROWS.put(grid, rows);
        }
        rows.add(Integer.valueOf(row));
    }

    /**
     * 把「前端选中了哪几行」定下来：显式的 FORM_SELECT 优先，否则按 `--set` 写过的行。
     *
     * 为什么默认要自动选中，而不是老老实实留空：留空是**前端不可能出现的状态**。
     * 人在界面上改了 `分录[0].字段`，那一行必然是被点中的；而探针留空的结果是
     * `getSelectRows()` 返回空数组，凡是拿它当第一道判断的操作（`type=donothing`
     * 的计算按钮是典型）一律走进「请先选择要计算的分录行」，`--expect` 拿到的是初值。
     * 那不是「验出插件不对」，是根本没验到 —— 一次真实验证在这里空转掉两轮。
     *
     * 覆盖口子留着：`--select 分录标识=` 就是显式的「这个分录一行没选」，
     * 要验的正是那条提示分支时用它。
     */
    static void selectRows(String spec) {
        if (spec != null && !spec.trim().isEmpty()) {
            setGridSelections(spec);
            return;
        }
        if (TOUCHED_ROWS.isEmpty()) {
            return;
        }
        GRID_SELECTIONS.clear();
        PRINTED_SELECTIONS.clear();
        StringBuilder shown = new StringBuilder();
        for (Map.Entry<String, Set<Integer>> entry : TOUCHED_ROWS.entrySet()) {
            Set<Integer> rows = entry.getValue();
            int[] selected = new int[rows.size()];
            int i = 0;
            for (Integer row : rows) {
                selected[i++] = row.intValue();
            }
            GRID_SELECTIONS.put(entry.getKey(), selected);
            if (shown.length() > 0) {
                shown.append("；");
            }
            shown.append(entry.getKey()).append("=").append(Arrays.toString(selected));
        }
        System.out.println("[PROBE] 未给 --select，按 --set 写过的、--hyperlink 点过的分录行模拟前端选中：" + shown
                + "（要验「一行没选」那条分支，用 --select 分录标识= 显式清空）");
    }

    static void setGridSelections(String spec) {
        GRID_SELECTIONS.clear();
        PRINTED_SELECTIONS.clear();
        if (spec == null || spec.trim().isEmpty()) {
            return;
        }
        for (String one : spec.split(";")) {
            String value = one.trim();
            if (value.isEmpty()) {
                continue;
            }
            int eq = value.indexOf('=');
            String grid = eq < 0 ? "*" : value.substring(0, eq).trim();
            String rows = eq < 0 ? value : value.substring(eq + 1).trim();
            if (rows.isEmpty()) {
                GRID_SELECTIONS.put(grid, new int[0]);
                continue;
            }
            String[] pieces = rows.split(",");
            int[] selected = new int[pieces.length];
            for (int i = 0; i < pieces.length; i++) {
                selected[i] = Integer.parseInt(pieces[i].trim());
            }
            GRID_SELECTIONS.put(grid, selected);
        }
    }

    static void clearOpenedForms() {
        OPENED_FORMS.clear();
    }

    static List<FormShowParameter> openedForms() {
        return new ArrayList<FormShowParameter>(OPENED_FORMS);
    }

    static void captureOpenedForm(FormShowParameter parameter) {
        if (parameter != null) {
            OPENED_FORMS.add(parameter);
            CloseCallBack callback = parameter.getCloseCallBack();
            if (QUIET) {
                return;
            }
            System.out.println("[PROBE] 捕获 showForm 子页=" + parameter.getFormId()
                    + " pageId=" + parameter.getPageId()
                    + " parent=" + parameter.getParentPageId()
                    + (callback == null ? " callback=(无)" : " callback="
                    + callback.getClassName() + ":" + callback.getActionId()));
            //带的参数逐个打出来：断言写 opened.参数=值，照这里抄
            for (Map.Entry<String, Object> param : openedParams(parameter).entrySet()) {
                System.out.println("[PROBE]   参数 " + param.getKey() + " = " + paramText(param.getValue()));
            }
        }
    }

    /**
     * 这次的动作弹了带关闭回调的子页，就把「接着验回写」的 run flow 命令拼好给出来。
     *
     * run form 只走到 showForm 为止：子页确认、closedCallBack 回写父页那一半它不跑，
     * 而断言全绿读起来像整条链验完了。能拼的都是这次真实捕获的——父布局、单据、动作、
     * 子页标识；子页上填什么、点哪个确认按钮、回写后断言什么，只有需求知道，留成尖括号。
     * 真机 S20 批 5：模型为了弄清这条命令怎么写，去缓存里翻了 4 次仿真探针的 Java 源码。
     *
     * 放在断言之前打，并另发一条 t=next-step：文字输出超预算时切的是中间，
     * 结构化记录这一条模型侧永远给全。列表选择页（ListShowParameter）不接 run flow，不提示；
     * 加载阶段就弹的（没有父动作）run flow 也接不了，同样不提示。
     */
    static void suggestFlow(String pk, String op, String click, String hyperlink, String toolbar, String skip) {
        if (op.isEmpty() && click.isEmpty() && hyperlink.isEmpty()) {
            return;
        }
        Set<String> seen = new HashSet<String>();
        for (FormShowParameter parameter : OPENED_FORMS) {
            CloseCallBack callback = parameter.getCloseCallBack();
            if (callback == null || parameter instanceof ListShowParameter
                    || !seen.add(parameter.getFormId())) {
                continue;
            }
            String command = "run flow " + FORM
                    + (pk.isEmpty() ? "" : " --pk " + pk)
                    + (!click.isEmpty() ? " --click " + click : !op.isEmpty() ? " --op " + op : " --hyperlink " + hyperlink)
                    + (click.isEmpty() || toolbar.isEmpty() ? "" : " --toolbar " + toolbar)
                    + " --child " + parameter.getFormId()
                    + (skip.isEmpty() ? "" : " --skip " + skip)
                    + " --child-set <子页字段=值> --child-click <子页确认按钮>"
                    + " --expect <回写后的父页字段=值>";
            String back = callback.getClassName() + ":" + callback.getActionId();
            System.out.println("[PROBE] 下一步：这个动作弹出了子页 " + parameter.getFormId()
                    + "（关闭回调 " + back + "），run form 只验到弹出为止。"
                    + "要验「子页确认 → 回写父页」，补齐尖括号后跑（这次的 --set / --select 照抄过去；"
                    + "子页确认是操作就把 --child-click 换成 --child-op）：" + command);
            ProbeJson.emit("next-step", "adapter", "run flow", "child", parameter.getFormId(),
                    "callback", back, "command", command);
        }
    }

    /** 内存版页面缓存。跨请求的会话缓存是非目标（要 redis 通道），单进程内这个够跑完整生命周期 */
    static IPageCache memPageCache() {
        return HeadlessUiSupport.memPageCache(PAGE_CACHE);
    }

    static IPageCache pageCache(String pageId) {
        return REAL_CACHE ? HeadlessUiSupport.realPageCache(pageId, PAGE_CACHE) : memPageCache();
    }

    static void persistReal(FormView view, String phase) {
        HeadlessUiSupport.persistRealView(view, REAL_CACHE_TTL_SECONDS);
        boolean pageExists = PageCache.existView(view.getPageId());
        boolean showParameterExists = kd.bos.mvc.SessionManager.getCurrent()
                .getFormShowParameter(view.getPageId()) != null;
        System.out.println("[PROBE] 真实缓存提交（" + phase + "） pageId=" + view.getPageId()
                + "  PageCache=" + pageExists + "  FormShowParameter=" + showParameterExists);
        if (!pageExists || !showParameterExists) {
            throw new IllegalStateException("真实缓存提交后仍不能重建页面 " + view.getPageId());
        }
    }

    /** 表单保存过或按修改打开过，平台给单据记的「正在编辑」锁：界面关掉时平台会放，这里没人关，跑完放掉。 */
    static void releaseMutex(FormView view) {
        try {
            String released = HeadlessUiSupport.releaseMutex(view);
            if (released != null && !QUIET) {
                System.out.println("[PROBE] 放掉表单占着的编辑锁 " + released);
            }
        } catch (Throwable t) {
            System.out.println("[PROBE] ⚠ 编辑锁没放掉：" + brief(t) + "；之后提交这张单可能被拒「正在编辑」，重起常驻进程能放");
        }
    }

    static void releaseReal(FormView view) {
        String pageId = view.getPageId();
        List<String> errors = HeadlessUiSupport.releaseRealView(view);
        boolean remains = PageCache.existView(pageId);
        System.out.println("[PROBE] 真实缓存清理 pageId=" + pageId + "  remains=" + remains);
        for (String error : errors) {
            System.out.println("[PROBE]   ⚠ 清理失败 " + error);
        }
    }

    // ---------- 小工具 ----------

    interface Step {
        void go();
    }

    static boolean step(String name, Step s) {
        int ev = EVENTS.size();
        long t0 = System.currentTimeMillis();
        try {
            s.go();
            if (!QUIET) {
                System.out.println("[PROBE] " + name + " OK " + (System.currentTimeMillis() - t0)
                        + "ms  插件事件 +" + (EVENTS.size() - ev));
            }
            return true;
        } catch (Throwable t) {
            if (QUIET && !"loadData".equals(name)) {
                //别的探针借这里开表单只为拿数据：数据都在 loadData 里读出、带值、跑插件回调，
                //前面挂界面监听那步（registerListener）没有界面时插件常抛空指针，不影响数据，不报
                return false;
            }
            if (QUIET) {
                //别的探针借这里开表单：没有 --skip 可用，只说哪一步、哪个插件、什么错
                String blame = culprit(root(t));
                System.out.println("[PROBE]   开表单的 " + name + " 一步抛错" + (blame == null ? "" : "（插件 " + blame + "）")
                        + "：" + brief(t) + ("loadData".equals(name) ? "  栈顶: " + top(t, 5) : ""));
                ProbeAssert.incomplete(name, blame, brief(t) + "  栈顶: " + top(t, 5));
                return false;
            }
            System.out.println("[PROBE] " + name + " ⚠ 失败：" + brief(t));
            //一个插件抛异常，整条派发链就断了 —— 它后面的插件这一轮什么都收不到，
            //而输出里看不出「后面还有几个没跑」。所以要么修它，要么摘掉它重跑。
            String blame = culprit(root(t));
            String skip = blame == null ? null : "--skip " + blame.substring(blame.lastIndexOf('.') + 1);
            if (blame != null) {
                System.out.println("[PROBE]   出错的是插件 " + blame
                        + "，它后面的插件这一步全没跑到。摘掉它重跑：" + skip);
            }
            System.out.println("[PROBE]   栈顶: " + top(t, 5));
            //插件把通道强转成平台具体类、而这次通道只能是动态代理（没有换类入口）时，说清为什么
            String channel = String.valueOf(root(t)).contains("ClientViewProxy") ? HeadlessUiSupport.channelWhy() : null;
            if (channel != null) {
                System.out.println("[PROBE]   仿真的发往浏览器的通道这次没能建成平台真类 ClientViewProxy：" + channel);
            }
            //后面的步骤照常跑，断言也照常判；但这次的现场不完整，全过也不能记成验证通过
            ProbeAssert.incomplete(name, blame, brief(t) + "  栈顶: " + top(t, 5)
                    + (channel == null ? "" : "。仿真的通道这次没能建成平台真类：" + channel)
                    + (skip == null ? "" : "。它不是要验的插件就摘掉重跑：" + skip));
            return false;
        }
    }

    /** 栈里第一个「装进来的插件」类 —— 判据是它在 PLUGIN_NAMES 里，不是包名长得像 */
    static String culprit(Throwable t) {
        return HeadlessUiSupport.culprit(PLUGIN_NAMES, t);
    }

    @SuppressWarnings({"unchecked", "rawtypes"})
    static List rawList(List<Object> l) {
        return HeadlessUiSupport.rawList(l);
    }

    @SuppressWarnings("unchecked")
    static List<Object> livePlugins(Object proxy) {
        return HeadlessUiSupport.livePlugins(proxy);
    }

    static Object call(Object o, String name) {
        return HeadlessUiSupport.call(o, name);
    }

    static int count(String entity) {
        try {
            return ORM.create().count("formsim", entity, null);
        } catch (Throwable t) {
            return -1;
        }
    }

    static String deep(Object[] a) {
        return HeadlessUiSupport.deep(a);
    }

    static Object dft(Class<?> t) {
        return HeadlessUiSupport.defaultValue(t);
    }

    static String join(Collection<String> c) {
        StringBuilder sb = new StringBuilder();
        int n = 0;
        for (String s : c) {
            if (++n > 12) {
                sb.append(" …共 ").append(c.size()).append(" 个");
                break;
            }
            sb.append(n > 1 ? " / " : "").append(s);
        }
        return sb.toString();
    }

    static String oneLine(String s) {
        return HeadlessUiSupport.oneLine(s);
    }

    static String top(Throwable t, int n) {
        return HeadlessUiSupport.top(t, n);
    }

    static Throwable root(Throwable t) {
        return HeadlessUiSupport.root(t);
    }

    static String brief(Throwable t) {
        return HeadlessUiSupport.brief(t);
    }

    static String req(String k) {
        String v = env(k, "");
        if (v.isEmpty()) {
            System.out.println("[PROBE] 缺 " + k + "。用法：driver.mjs run form <表单标识> [--set 字段=值 …]");
            throw new IllegalStateException("缺 " + k);
        }
        return v;
    }

    static String env(String k, String dft) {
        String v = System.getenv(k);
        return v == null || v.trim().isEmpty() ? dft : v.trim();
    }
}
