import java.lang.reflect.Method;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Proxy;
import java.util.ArrayList;
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

import kd.bos.context.RequestContext;
import kd.bos.dataentity.entity.DynamicObject;
import kd.bos.dataentity.entity.DynamicObjectCollection;
import kd.bos.entity.MainEntityType;
import kd.bos.entity.datamodel.IListModel;
import kd.bos.entity.datamodel.ListSelectedRow;
import kd.bos.entity.datamodel.ListSelectedRowCollection;
import kd.bos.entity.filter.PermissionFilterUtil;
import kd.bos.entity.operate.result.IOperateInfo;
import kd.bos.entity.operate.result.OperationResult;
import kd.bos.form.FormConfig;
import kd.bos.form.FormMetadataCache;
import kd.bos.form.IClientViewProxy;
import kd.bos.form.IFormView;
import kd.bos.form.IPageCache;
import kd.bos.form.MessageBoxResult;
import kd.bos.form.control.AbstractGrid.GridState;
import kd.bos.form.control.Toolbar;
import kd.bos.form.control.TreeView;
import kd.bos.form.control.events.ItemClickEvent;
import kd.bos.form.control.events.RefreshNodeEvent;
import kd.bos.form.control.events.TreeNodeEvent;
import kd.bos.form.events.AfterDoOperationEventArgs;
import kd.bos.form.events.BeforeCreateListColumnsArgs;
import kd.bos.form.events.BeforeCreateListDataProviderArgs;
import kd.bos.form.events.BeforeDoOperationEventArgs;
import kd.bos.form.events.ClosedCallBackEvent;
import kd.bos.form.events.FilterContainerInitArgs;
import kd.bos.form.events.HyperLinkClickArgs;
import kd.bos.form.events.MessageBoxClosedEvent;
import kd.bos.form.events.SetFilterEvent;
import kd.bos.list.BillList;
import kd.bos.list.IListView;
import kd.bos.list.ITreeListView;
import kd.bos.list.ListShowParameter;
import kd.bos.list.MobileListShowParameter;
import kd.bos.list.SummaryFieldIds;
import kd.bos.list.events.BuildTreeListFilterEvent;
import kd.bos.list.events.ListRowClickEvent;
import kd.bos.list.plugin.AbstractListPlugin;
import kd.bos.list.plugin.AbstractTreeListPlugin;
import kd.bos.metadata.entity.EntityMetadata;
import kd.bos.mvc.form.IFormController;
import kd.bos.mvc.list.ListController;
import kd.bos.mvc.list.AbstractListView;
import kd.bos.orm.ORM;
import kd.bos.orm.query.QCP;
import kd.bos.orm.query.QFilter;
import kd.bos.servicehelper.BusinessDataServiceHelper;

/**
 * 列表插件免界面验证：真 ListView、真 IListModel、真 ListViewPluginProxy，只有发往前端的
 * IClientViewProxy 被换成记账代理。参数由 driver.mjs run list 翻译成 LIST_* 环境变量。
 *
 * `LIST_EXPECT`（`run list --expect`）只认列表这一层的事实：rows / selected / filters /
 * action / success 单值比，columns / pks 集合比不看顺序。**不给就只能算「跑过了」** ——
 * verify 判 EXECUTED 而不是 PASS。
 * LIST_FILTER 的单值和逗号分隔值保留整数形式的前导零，例如 billno=04022611040002。
 */
public class ListSim {

    static final List<String> EVENTS = new ArrayList<String>();
    static final List<String> CALLS = new ArrayList<String>();
    static final List<String> NOTICES = new ArrayList<String>();
    static final List<String> FILTERS = new ArrayList<String>();
    static final List<String> COLUMNS = new ArrayList<String>();
    static final Map<String, String> UI_STATE = new LinkedHashMap<String, String>();
    static final Map<String, Object> PAGE_CACHE = new HashMap<String, Object>();
    static final Set<String> PLUGIN_NAMES = new HashSet<String>();
    static final Set<String> TREE_NODES = new LinkedHashSet<String>();
    static DynamicObjectCollection ROWS = new DynamicObjectCollection();
    static String LAYOUT;
    static String ENTITY;
    /** `LIST_MOBILE=1`（`run list --mobile`）：开单据带的移动端列表，移动端列表插件挂在它上面。 */
    static boolean MOBILE;
    static String ORDER_BY = "";
    static int[] SELECTED_GRID_ROWS = new int[0];
    /** 主动交互跑没跑通 / 它的操作结果 —— `--expect` 要断的就是这两个 */
    static Boolean LAST_ACTION_OK;
    static Boolean LAST_OP_SUCCESS;

    public static void run() throws Exception {
        resetState();
        LAYOUT = req("LIST_FORM");
        MOBILE = "1".equals(env("LIST_MOBILE", ""));
        int limit = limit(env("LIST_LIMIT", "20"));
        String filterSpec = env("LIST_FILTER", "");
        String mainOrgSpec = env("LIST_MAIN_ORG", "");
        String selectSpec = env("LIST_SELECT", "");
        String click = env("LIST_CLICK", "");
        String op = env("LIST_OP", "");
        String rowClick = env("LIST_ROW_CLICK", "");
        String rowDoubleClick = env("LIST_ROW_DOUBLE_CLICK", "");
        String hyperlink = env("LIST_HYPERLINK", "");
        String callback = env("LIST_CALLBACK", "");
        String treeNode = env("LIST_TREE_NODE", "");
        String treeToolbar = env("LIST_TREE_TOOLBAR", "");
        String skip = env("LIST_SKIP", "");
        seedCache(env("LIST_CACHE", ""));

        MainEntityType entityType = MetaResolve.type(LAYOUT);
        ENTITY = entityType.getName();
        boolean active = !click.isEmpty() || !op.isEmpty() || !rowClick.isEmpty()
                || !rowDoubleClick.isEmpty() || !hyperlink.isEmpty() || !callback.isEmpty()
                || !treeNode.isEmpty() || !treeToolbar.isEmpty();
        System.out.println("[PROBE] === ListSim 布局=" + LAYOUT + " 实体=" + ENTITY
                + " limit=" + limit + (active ? " 主动交互" : " 只读") + " ===");

        if (active) {
            //归属按给的那张算：扩展单据开的是原单，插件却是挂在扩展上的
            EntityMetadata metadata = MetaResolve.ownedEntity(LAYOUT);
            IsvGuard.assertOwnEntity(metadata.getKey(), metadata);
        }
        RequestContext.get().setGlobalSessionId("listsim-" + UUID.randomUUID().toString().replace("-", ""));
        int before = active ? count(ENTITY) : -1;
        if (active) {
            System.out.println("[PROBE] 跑之前行数=" + before);
        }

        AbstractListView view = openView(LAYOUT, ENTITY, skip);
        long started = System.currentTimeMillis();
        view.activate();
        view.getRootControl();
        System.out.println("[PROBE] activate OK " + (System.currentTimeMillis() - started) + "ms");

        Object controllerService = view.getService(IFormController.class);
        if (!(controllerService instanceof ListController)) {
            throw new IllegalStateException("布局 " + LAYOUT + " 没有 ListController（实际 "
                    + (controllerService == null ? "null" : controllerService.getClass().getName())
                    + "），它不是可运行的桌面列表布局");
        }
        final ListController controller = (ListController) controllerService;
        Object listControl = view.getControl("billlistap");
        //移动端列表的列表控件叫 _billlist_（移动端列表设计器里的那个）
        if (MOBILE && !(listControl instanceof BillList)) listControl = view.getControl("_billlist_");
        if (!(listControl instanceof BillList)) {
            throw new IllegalStateException("布局 " + LAYOUT + " 没有 billlistap/BillList，"
                    + "CtsyListView 不在本命令范围内" + (MOBILE ? "" : "；移动端列表加 --mobile"));
        }
        final BillList billList = (BillList) listControl;

        step("registerListener", new Step() {
            public void go() {
                controller.registerListener();
            }
        });
        capturePlugins(view);
        step("prepare list conditions", new Step() {
            public void go() {
                applyFilters(billList, filterSpec, limit);
            }
        });
        step("loadData", new Step() {
            public void go() {
                controller.loadData();
            }
        });
        //平台在 loadData 里按筛选栏的默认组织算主组织条件，换组织要排在它后面，否则被盖掉
        if (!MOBILE) chooseMainOrgs((HeadlessViews.ListPage) view, billList, mainOrgSpec);
        query(controller, view, limit);
        final ListSelectedRowCollection selected = selectRows(billList, selectSpec, "--select");
        dumpListState(view, selected);

        if ("1".equals(env("LIST_SUMMARY", ""))) {
            summary(controller, billList);
        }
        if (!click.isEmpty()) {
            click(view, click, before);
        } else if (!op.isEmpty()) {
            operation(view, op, before);
        } else if (!rowClick.isEmpty()) {
            row(billList, rowClick, false, before);
        } else if (!rowDoubleClick.isEmpty()) {
            row(billList, rowDoubleClick, true, before);
        } else if (!hyperlink.isEmpty()) {
            hyperlink(billList, hyperlink, before);
        } else if (!treeNode.isEmpty()) {
            treeNode(view, treeNode, before);
        } else if (!treeToolbar.isEmpty()) {
            treeToolbar(view, treeToolbar, before);
        }
        if (!callback.isEmpty()) {
            callback(controller, callback, before);
        }

        dumpEvents();
        dumpOutput();

        ProbeJson.emit("scenario", "adapter", "run list", "layout", LAYOUT, "entity", ENTITY,
                "rows", Integer.valueOf(ROWS.size()), "selected", Integer.valueOf(selected.size()));
        expect(selected, env("LIST_EXPECT", ""));
        if (!ProbeAssert.summary()) {
            throw new ProbeAssert.Failed("断言失败：" + LAYOUT);
        }
    }

    /**
     * 列表能断的就这几个事实。**不做「字段=值」那种断言** —— 列表首屏是一批行，
     * 「哪一行的哪个字段」需要先说清是哪一行，那是 `run form --expect` 的活。
     */
    private static void expect(ListSelectedRowCollection selected, String spec) {
        Map<String, String> scalars = new LinkedHashMap<String, String>();
        scalars.put("rows", String.valueOf(ROWS.size()));
        scalars.put("selected", String.valueOf(selected.size()));
        scalars.put("filters", String.valueOf(FILTERS.size()));
        scalars.put("action", LAST_ACTION_OK == null ? null : (LAST_ACTION_OK.booleanValue() ? "完成" : "异常"));
        scalars.put("success", LAST_OP_SUCCESS == null ? null : String.valueOf(LAST_OP_SUCCESS));
        Map<String, List<String>> sets = new LinkedHashMap<String, List<String>>();
        sets.put("columns", new ArrayList<String>(COLUMNS));
        List<String> pks = new ArrayList<String>();
        for (DynamicObject row : ROWS) {
            pks.add(String.valueOf(row.getPkValue()));
        }
        sets.put("pks", pks);
        ExpectSpec.facts(scalars, sets, "list", spec);
    }

    static void resetState() {
        EVENTS.clear();
        CALLS.clear();
        NOTICES.clear();
        FILTERS.clear();
        COLUMNS.clear();
        UI_STATE.clear();
        PAGE_CACHE.clear();
        PLUGIN_NAMES.clear();
        TREE_NODES.clear();
        ROWS = new DynamicObjectCollection();
        ORDER_BY = "";
        SELECTED_GRID_ROWS = new int[0];
        LAST_ACTION_OK = null;
        LAST_OP_SUCCESS = null;
        LAYOUT = null;
        ENTITY = null;
    }

    static AbstractListView openView(String layout, String entity, String skip) {
        FormConfig businessConfig = MOBILE ? FormMetadataCache.getMobListFormConfig(layout) : FormMetadataCache.getListFormConfig(layout);
        if (businessConfig == null) {
            throw new IllegalArgumentException("找不到业务布局 " + layout + " 的 " + (MOBILE ? "移动端列表配置，这张单据没有移动端列表"
                    : "ListFormConfig，它不是可运行的桌面列表布局"));
        }
        //移动端列表的壳照平台打开移动端列表时的取法：业务布局指定了就用它，否则 bos_moblist
        final String containerForm = env("LIST_CONTAINER", MOBILE ? mobileContainer(businessConfig)
                : hasTreePlugin(businessConfig) ? "tree_bos_list" : "bos_list");
        FormConfig config = FormMetadataCache.getFormConfig(containerForm);
        if (config == null) {
            throw new IllegalArgumentException("找不到列表壳 " + containerForm + " 或业务布局 "
                    + layout + " 的 FormConfig");
        }
        ListShowParameter parameter = MOBILE ? new MobileListShowParameter() : new ListShowParameter();
        parameter.setFormId(containerForm);
        parameter.setBillFormId(layout);
        parameter.setPageId("listsim_" + System.nanoTime());
        parameter.setSendToClient(false);
        parameter.setShowFilter(true);
        parameter.setLoadData(false);
        parameter.setFormConfig(config);

        HeadlessUiSupport.PluginSelection containerSelection = HeadlessUiSupport.selectPlugins(config, skip);
        HeadlessUiSupport.PluginSelection businessSelection = HeadlessUiSupport.selectPlugins(businessConfig, skip);
        for (String className : businessSelection.dropped()) {
            System.out.println("[PROBE]   摘掉插件 " + className + "（LIST_SKIP）");
        }
        System.out.println("[PROBE] 列表壳=" + containerForm + "，业务布局 modelType="
                + businessConfig.getModelType() + "，元数据里配了 "
                + businessSelection.origin().size() + " 个插件，装 "
                + businessSelection.kept().size() + " 个"
                + (businessSelection.dropped().isEmpty() ? ""
                : "，摘掉 " + businessSelection.dropped().size() + " 个"));

        AbstractListView view = newView();
        try {
            config.setPlugins(HeadlessUiSupport.rawList(mergePlugins(
                    containerSelection.kept(), businessSelection.kept())));
            businessSelection.install();
            view.initialize(parameter);
            view.setBillFormId(layout);
            ((HeadlessViews.Page) view).ensurePluginProxy();
            Object proxy = ((HeadlessViews.Page) view).pluginProxy();
            System.out.println("[PROBE] 插件代理=" + (proxy == null ? "null" : proxy.getClass().getName()));
        } finally {
            businessSelection.restore();
            containerSelection.restore();
        }
        capturePlugins(view);
        view.addPlugin(new RecListPlugin());
        view.addPlugin(new RecTreePlugin());
        return view;
    }

    static String mobileContainer(FormConfig businessConfig) {
        String own = businessConfig.getListFormId();
        return own == null || own.trim().isEmpty() ? "bos_moblist" : own;
    }

    static List<Object> mergePlugins(List<Object> container, List<Object> business) {
        List<Object> merged = new ArrayList<Object>();
        Set<String> classes = new LinkedHashSet<String>();
        for (Object plugin : container) {
            merged.add(plugin);
            classes.add(String.valueOf(HeadlessUiSupport.call(plugin, "getClassName")));
        }
        for (Object plugin : business) {
            String className = String.valueOf(HeadlessUiSupport.call(plugin, "getClassName"));
            if (classes.add(className)) {
                merged.add(plugin);
            }
        }
        return merged;
    }

    static void capturePlugins(AbstractListView view) {
        for (Object plugin : HeadlessUiSupport.livePlugins(((HeadlessViews.Page) view).pluginProxy())) {
            String className = plugin.getClass().getName();
            if (className.startsWith(ListSim.class.getName() + "$Rec")) {
                continue;
            }
            if (PLUGIN_NAMES.add(className)) {
                System.out.println("[PROBE]   插件 " + className);
            }
        }
    }

    static boolean hasTreePlugin(FormConfig config) {
        if (config.getPlugins() == null) {
            return false;
        }
        for (Object plugin : config.getPlugins()) {
            String className = String.valueOf(HeadlessUiSupport.call(plugin, "getClassName"));
            try {
                if (AbstractTreeListPlugin.class.isAssignableFrom(Class.forName(className))) {
                    return true;
                }
            } catch (Throwable ignore) {
                if (className.endsWith("TreeListPlugin")) {
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * 新建一个无头列表。视图类在宿主里（{@code cosmic.headless.HeadlessViews}），理由同 FormSim.newView；
     * 这里接上页面缓存、发往浏览器的通道和兜底的父页。
     */
    static AbstractListView newView() {
        final IFormView parent = headlessParent();
        HeadlessViews.hook = (what, args) -> {
            AbstractListView view = (AbstractListView) args[0];
            if ("initiService".equals(what)) {
                view.addService(IPageCache.class, HeadlessUiSupport.memPageCache(PAGE_CACHE));
            } else if ("addService".equals(what)) {
                //通道在平台放进视图的那一刻就换，理由同 FormSim.swapClientProxy：换晚了控件手里存的是旧通道。
                Object service = args[2];
                return args[1] == IClientViewProxy.class && service != null
                        && !HeadlessUiSupport.isRecorder(service) ? recorder(IClientViewProxy.class) : null;
            } else if ("parentView".equals(what)) {
                return parent;
            }
            return null;
        };
        return MOBILE ? new HeadlessViews.MobileListPage() : new HeadlessViews.ListPage();
    }

    static IFormView headlessParent() {
        final IFormView fallback = recorder(IFormView.class);
        return (IFormView) Proxy.newProxyInstance(IFormView.class.getClassLoader(),
                new Class<?>[]{IFormView.class}, new InvocationHandler() {
                    public Object invoke(Object proxy, Method method, Object[] args) throws Throwable {
                        if ("getEntityId".equals(method.getName())) {
                            return "";
                        }
                        return method.invoke(fallback, args);
                    }
                });
    }

    public static class RecListPlugin extends AbstractListPlugin {
        @Override
        public void initialize() {
            EVENTS.add("initialize()");
        }

        @Override
        public void registerListener(EventObject event) {
            EVENTS.add("registerListener()");
        }

        @Override
        public void filterContainerInit(FilterContainerInitArgs args) {
            EVENTS.add("filterContainerInit(common=" + size(args.getCommonFilterColumns())
                    + ", fast=" + size(args.getFastFilterColumns()) + ", scheme="
                    + size(args.getSchemeFilterColumns()) + ")");
        }

        @Override
        public void setFilter(SetFilterEvent event) {
            List<?> merged = event.getMergeQFilters();
            FILTERS.clear();
            if (merged != null) {
                for (Object filter : merged) {
                    if (filter != null) {
                        FILTERS.add(shortText(String.valueOf(filter), 500));
                    }
                }
            }
            ORDER_BY = event.getOrderBy() == null ? "" : String.valueOf(event.getOrderBy());
            EVENTS.add("setFilter(filters=" + FILTERS.size() + ", orderBy="
                    + String.valueOf(event.getOrderBy()) + ")");
        }

        @Override
        public void beforeCreateListColumns(BeforeCreateListColumnsArgs args) {
            COLUMNS.clear();
            if (args.getListColumns() != null) {
                for (Object column : args.getListColumns()) {
                    COLUMNS.add(columnName(column));
                }
            }
            EVENTS.add("beforeCreateListColumns(columns=" + COLUMNS.size() + ")");
        }

        @Override
        public void beforeCreateListDataProvider(BeforeCreateListDataProviderArgs args) {
            Object provider = args.getListDataProvider();
            EVENTS.add("beforeCreateListDataProvider(" + (provider == null ? "null"
                    : provider.getClass().getName()) + ")");
        }

        @Override
        public void listRowClick(ListRowClickEvent event) {
            EVENTS.add("listRowClick(pk=" + selectedPk(event.getCurrentListSelectedRow()) + ")");
        }

        @Override
        public void listRowDoubleClick(ListRowClickEvent event) {
            EVENTS.add("listRowDoubleClick(pk=" + selectedPk(event.getCurrentListSelectedRow()) + ")");
        }

        @Override
        public void billListHyperLinkClick(HyperLinkClickArgs args) {
            EVENTS.add("billListHyperLinkClick(field=" + args.getFieldName()
                    + ", row=" + args.getRowIndex() + ")");
        }

        @Override
        public void beforeDoOperation(BeforeDoOperationEventArgs args) {
            EVENTS.add("beforeDoOperation(" + args.getSource().getClass().getSimpleName() + ")");
        }

        @Override
        public void afterDoOperation(AfterDoOperationEventArgs args) {
            EVENTS.add("afterDoOperation(" + args.getOperateKey() + ", success="
                    + (args.getOperationResult() == null ? "?"
                    : String.valueOf(args.getOperationResult().isSuccess())) + ")");
        }

        @Override
        public void itemClick(ItemClickEvent event) {
            EVENTS.add("itemClick(" + event.getItemKey() + "/" + event.getOperationKey() + ")");
        }

        @Override
        public void confirmCallBack(MessageBoxClosedEvent event) {
            EVENTS.add("confirmCallBack()");
        }

        @Override
        public void closedCallBack(ClosedCallBackEvent event) {
            EVENTS.add("closedCallBack()");
        }
    }

    /** 只记录树列表独有事件，标准列表事件由 RecListPlugin 统一记录。 */
    public static class RecTreePlugin extends AbstractTreeListPlugin {
        @Override
        public void initializeTree(EventObject event) {
            EVENTS.add("initializeTree()");
        }

        @Override
        public void initTreeToolbar(EventObject event) {
            EVENTS.add("initTreeToolbar()");
        }

        @Override
        public void buildTreeListFilter(BuildTreeListFilterEvent event) {
            rememberTreeNode(event.getNodeId());
            EVENTS.add("buildTreeListFilter(node=" + event.getNodeId() + ", filters="
                    + size(event.getFilters()) + ")");
        }

        @Override
        public void treeNodeClick(TreeNodeEvent event) {
            rememberTreeNode(event.getNodeId());
            EVENTS.add("treeNodeClick(node=" + event.getNodeId() + ")");
        }

        @Override
        public void refreshNode(RefreshNodeEvent event) {
            rememberTreeNode(event.getNodeId());
            if (event.getChildNodes() != null) {
                for (Object child : event.getChildNodes()) {
                    rememberTreeNode(HeadlessUiSupport.call(child, "getId"));
                }
            }
            EVENTS.add("refreshNode(node=" + event.getNodeId() + ", children="
                    + size(event.getChildNodes()) + ")");
        }

        @Override
        public void treeToolbarClick(EventObject event) {
            EVENTS.add("treeToolbarClick(" + event.getSource().getClass().getSimpleName() + ")");
        }
    }

    static void applyFilters(BillList list, String filterSpec, int limit) {
        list.setPageRows(limit);
        list.setMaxPageSize(Integer.valueOf(limit));
        QFilter merged = null;
        if (!filterSpec.trim().isEmpty()) {
            for (String one : filterSpec.split(";")) {
                int eq = one.indexOf('=');
                if (eq <= 0) {
                    throw new IllegalArgumentException("过滤条件必须是 字段=值：" + one);
                }
                String field = one.substring(0, eq).trim();
                String raw = one.substring(eq + 1).trim();
                QFilter filter;
                if (raw.indexOf(',') >= 0) {
                    filter = new QFilter(field, QCP.in, values(raw));
                } else {
                    filter = new QFilter(field, QCP.equals, scalar(raw));
                }
                merged = merged == null ? filter : merged.and(filter);
                System.out.println("[PROBE] 预置列表过滤 " + field + " = " + raw);
            }
        }
        if (merged != null) {
            list.setFilter(merged);
        }
    }

    /**
     * 换主组织，照界面上在筛选栏里选组织的路走：选得到的只有当前用户在这张单上有权限的组织，
     * 选完由平台记下所选组织、重算列表的主组织条件。组织没权限，或者这张列表不按所选组织过滤
     * （单据没有主业务组织、筛选栏里没有组织这一项），界面上换不了，这里按输入不成立退回。
     */
    static void chooseMainOrgs(HeadlessViews.ListPage view, BillList list, String spec) {
        if (spec.trim().isEmpty()) {
            return;
        }
        List<Long> ids = new ArrayList<Long>();
        for (String one : spec.split(",")) {
            try {
                ids.add(Long.valueOf(one.trim()));
            } catch (NumberFormatException e) {
                ProbeAssert.inputInvalid("list-main-org", "--main-org " + spec, "要写组织的内码（整数），多个用逗号隔开：" + one.trim());
                throw new ProbeAssert.InputInvalid("--main-org 写法不对，没有查列表");
            }
        }
        MainEntityType type = (MainEntityType) list.getEntityType();
        String why = null;
        if (PermissionFilterUtil.getMainOrgProp(type) == null) {
            why = ENTITY + " 没有主业务组织字段，列表不按主组织过滤，界面上也没有组织可换";
        } else {
            String appId = view.getFormShowParameter().getAppId();
            List<Long> allowed = PermissionFilterUtil.getMainOrgIds(type, type.getName(), appId == null ? "" : appId);
            List<Long> denied = new ArrayList<Long>(ids);
            denied.removeAll(allowed);
            if (!denied.isEmpty()) {
                why = "当前用户在 " + ENTITY + " 上有查看权限的组织（" + allowed.size() + " 个）里没有这些内码：" + denied
                        + "。--main-org 写组织的内码、不是编号；没权限的组织界面的组织筛选里选不到";
            }
        }
        if (why == null) {
            view.chooseMainOrgs(list, ids);
            QFilter applied = list.getMainOrgQFilter();
            List<Long> chosen = list.getSelectedMainOrgIds();
            if (applied == null || chosen == null || !new HashSet<Long>(chosen).equals(new HashSet<Long>(ids))) {
                why = "这张列表不按所选主组织过滤（平台算出来的主组织条件：" + applied + "），界面上换不了组织";
            } else {
                System.out.println("[PROBE] 主组织换成 " + ids + "，平台的主组织条件：" + applied);
            }
        }
        if (why != null) {
            ProbeAssert.inputInvalid("list-main-org", "--main-org " + spec, why + "。没有查列表、没有执行任何动作");
            throw new ProbeAssert.InputInvalid("--main-org 不成立，没有查列表、没有执行任何动作");
        }
    }

    static void query(final ListController controller, AbstractListView view, final int limit) {
        final DynamicObjectCollection[] value = new DynamicObjectCollection[1];
        step("query first page", new Step() {
            public void go() {
                value[0] = controller.getData(0, limit);
            }
        });
        ROWS = value[0] == null ? new DynamicObjectCollection() : value[0];
        IListModel model = view.getListModel();
        Object provider = model == null ? null : model.getProvider();
        System.out.println("[PROBE] 首屏 rows=" + ROWS.size() + " provider="
                + (provider == null ? "null" : provider.getClass().getName()));
        for (int i = 0; i < ROWS.size(); i++) {
            DynamicObject row = ROWS.get(i);
            System.out.println("[PROBE]   row[" + i + "] pk=" + row.getPkValue()
                    + optional(row, "billno") + optional(row, "number") + optional(row, "name")
                    + optional(row, "zlgd_ccgzt"));
        }
    }

    /**
     * 选中的、点的行必须在这次列表查出来的行里。界面上选不到列表没查出来的行：过滤条件（含插件按组织、
     * 权限范围加的）把一张单挡在外面时，照主键硬选等于替用户绕过了列表，跑出来的结果界面上到不了。
     * 不成立就在动手之前退回：不选中、不执行动作、不留验证记录（见 {@link ProbeAssert#inputInvalid}）。
     */
    static void requireListed(String flag, String spec) {
        List<String> missing = new ArrayList<String>();
        for (String raw : spec.split(",")) {
            String pk = raw.trim();
            if (!pk.isEmpty() && rowIndex(pk) < 0) {
                missing.add(pk);
            }
        }
        if (missing.isEmpty()) {
            return;
        }
        StringBuilder filters = new StringBuilder();
        for (String filter : FILTERS) {
            filters.append(filters.length() > 0 ? "；" : "").append(filter);
        }
        String why = "不在这次列表查出来的 " + ROWS.size() + " 行里。界面上选不到列表没查出来的行，"
                + "所以没有选中、没有执行任何动作。这次列表的过滤条件：" + (filters.length() == 0 ? "(无)" : filters)
                + "。用 --filter、--main-org 调到这几行查得出来再跑；行数多、排不进首屏的加 --filter id=主键";
        String pks = String.join(",", missing);
        ProbeAssert.inputInvalid("list-select", flag + " " + pks, why);
        throw new ProbeAssert.InputInvalid(flag + " 的主键不在这次列表查出来的行里，没有执行任何动作");
    }

    static ListSelectedRowCollection selectRows(BillList list, String spec, String flag) {
        ListSelectedRowCollection selected = new ListSelectedRowCollection();
        if (spec.trim().isEmpty()) {
            SELECTED_GRID_ROWS = new int[0];
        LAST_ACTION_OK = null;
        LAST_OP_SUCCESS = null;
            list.putSelectedRows(selected);
            list.restoreSelection(selected);
            System.out.println("[PROBE] 选中行 0 条");
            return selected;
        }
        requireListed(flag, spec);
        for (String raw : spec.split(",")) {
            Object pk = scalar(raw.trim());
            DynamicObject data = BusinessDataServiceHelper.loadSingle(pk, ENTITY);
            if (data == null) {
                throw new IllegalArgumentException(ENTITY + " 找不到主键 " + raw.trim());
            }
            ListSelectedRow row = new ListSelectedRow(data.getPkValue());
            row.setPrimaryKeyValue(data.getPkValue());
            row.setQueryEntityPrimayKeyValue(data.getPkValue());
            row.setFormID(ENTITY);
            row.setLayoutID(LAYOUT);
            row.setSelected(true);
            row.setPageIndex(0);
            row.setRowKey(rowIndex(raw.trim()));
            row.setPkLongType(data.getPkValue() instanceof Number);
            if (has(data, "billno")) {
                row.setBillNo(data.getString("billno"));
            }
            if (has(data, "number")) {
                row.setNumber(data.getString("number"));
            }
            if (has(data, "name")) {
                row.setName(data.getString("name"));
            }
            if (has(data, "billstatus")) {
                row.setBillStatus(data.getString("billstatus"));
            }
            Object org = first(data, "zlgd_org", "org", "useorg", "mainorg");
            if (org instanceof DynamicObject && ((DynamicObject) org).getPkValue() != null) {
                row.setMainOrgId(Long.parseLong(String.valueOf(((DynamicObject) org).getPkValue())));
            }
            selected.add(row);
        }
        SELECTED_GRID_ROWS = new int[selected.size()];
        for (int i = 0; i < selected.size(); i++) {
            SELECTED_GRID_ROWS[i] = selected.get(i).getRowKey();
        }
        list.putSelectedRows(selected);
        list.restoreSelection(selected);
        ListSelectedRowCollection effective = list.getSelectedRows();
        System.out.println("[PROBE] 选中行 " + selected.size() + " 条 pk="
                + java.util.Arrays.toString(selected.getPrimaryKeyValues()) + "，平台缓存="
                + (effective == null ? 0 : effective.size()) + " 条");
        return effective == null ? selected : effective;
    }

    static void summary(ListController controller, BillList list) {
        try {
            SummaryFieldIds ids = list.getSummaryFieldIds();
            List fieldsList = ids == null ? null : ids.getSummaryFieldIds();
            String[] fields = fieldsList == null ? new String[0]
                    : (String[]) fieldsList.toArray(new String[fieldsList.size()]);
            List<?> result = controller.querySummaryResults(fields);
            System.out.println("[PROBE] 合计 " + (result == null ? 0 : result.size()) + " 条 "
                    + String.valueOf(result));
        } catch (Throwable throwable) {
            System.out.println("[PROBE] ⚠ 合计失败：" + HeadlessUiSupport.brief(throwable));
            throw propagate(throwable);
        }
    }

    static void dumpListState(AbstractListView view, ListSelectedRowCollection selected) {
        List<?> showColumns = view.getShowListColumns();
        System.out.println("[PROBE] 列定义 " + (showColumns == null ? 0 : showColumns.size())
                + " 个，记录器捕获 " + COLUMNS.size() + " 个");
        if (!COLUMNS.isEmpty()) {
            System.out.println("[PROBE]   " + join(COLUMNS));
        }
        System.out.println("[PROBE] 最终过滤 " + FILTERS.size() + " 条");
        for (String filter : FILTERS) {
            System.out.println("[PROBE]   " + filter);
        }
        System.out.println("[PROBE] 最终排序 " + (ORDER_BY.isEmpty() ? "(无)" : ORDER_BY));
        System.out.println("[PROBE] 当前选中行 " + selected.size() + " 条");
        ITreeListView tree = view.getTreeListView();
        System.out.println("[PROBE] 树列表=" + (tree == null ? "否" : "是 " + tree.getClass().getName()));
        if (tree != null) {
            System.out.println("[PROBE]   已观察树节点 " + TREE_NODES.size() + " 个 " + TREE_NODES);
        }
        for (String key : new String[]{"treeviewap", "treeview"}) {
            try {
                Object control = view.getControl(key);
                if (control != null) {
                    System.out.println("[PROBE]   树控件候选 " + key + "=" + control.getClass().getName());
                }
            } catch (Throwable ignore) {
                //候选不存在
            }
        }
    }

    static void click(final AbstractListView view, final String itemKey, int before) {
        final Toolbar toolbar = toolbar(view, "toolbarap", "tbmain", "toolbar");
        if (toolbar == null) {
            throw new IllegalStateException("找不到列表公共工具栏 toolbarap/tbmain/toolbar");
        }
        final String metadataOp = listToolbarOp(itemKey);
        final String opKey = isDonothing(metadataOp) ? "" : metadataOp;
        String route = metadataOp;
        if (!metadataOp.isEmpty() && opKey.isEmpty()) {
            route += "（Donothing，占位操作不执行）";
        }
        active("点按钮 " + itemKey + " → " + route, before, new Action() {
            public Object go() {
                toolbar.itemClick(itemKey, opKey);
                return null;
            }
        });
    }

    static boolean isDonothing(String opKey) {
        if (opKey == null || opKey.isEmpty()) {
            return false;
        }
        try {
            Object operation = FormMetadataCache.getFormOperation(LAYOUT, opKey);
            return operation != null && "kd.bos.entity.operate.Donothing"
                    .equals(operation.getClass().getName());
        } catch (Throwable ignore) {
            return false;
        }
    }

    static void operation(final AbstractListView view, final String op, int before) {
        active("invokeOperation(" + op + ")", before, new Action() {
            public Object go() {
                return view.invokeOperation(op);
            }
        });
    }

    static void row(final BillList list, String pk, final boolean twice, int before) {
        selectRows(list, pk, twice ? "--row-double-click" : "--row-click");
        final int index = rowIndex(pk);
        active((twice ? "双击" : "单击") + "行 pk=" + pk + " index=" + index,
                before, new Action() {
                    public Object go() {
                        if (twice) {
                            list.entryRowDoubleClick(Integer.valueOf(index));
                        } else {
                            list.entryRowClick(Integer.valueOf(index));
                        }
                        return null;
                    }
                });
    }

    static void hyperlink(final BillList list, String spec, int before) {
        int colon = spec.indexOf(':');
        if (colon <= 0 || colon == spec.length() - 1) {
            throw new IllegalArgumentException("--hyperlink 必须是 pk:字段");
        }
        String pk = spec.substring(0, colon);
        selectRows(list, pk, "--hyperlink");
        final String field = spec.substring(colon + 1);
        final int index = rowIndex(pk);
        active("超链接 pk=" + pk + " field=" + field, before, new Action() {
            public Object go() {
                list.hyperLinkClick(field, index);
                return null;
            }
        });
    }

    static void callback(final ListController controller, String spec, int before) {
        int colon = spec.indexOf(':');
        if (colon <= 0 || colon == spec.length() - 1) {
            throw new IllegalArgumentException("--callback 必须是 回调id:Yes|No|OK|Cancel");
        }
        final String callbackId = spec.substring(0, colon);
        final MessageBoxResult result = MessageBoxResult.valueOf(spec.substring(colon + 1));
        active("回调 " + callbackId + "=" + result, before, new Action() {
            public Object go() {
                controller.afterConfirm(callbackId, result.getValue(), "");
                return null;
            }
        });
    }

    static void treeNode(final AbstractListView view, final String nodeId, int before) {
        final ITreeListView tree = requireTree(view);
        final TreeView control = tree.getTreeView();
        active("树节点 " + nodeId, before, new Action() {
            public Object go() {
                control.treeNodeClick("", nodeId);
                control.queryTreeNodeChildren("", nodeId);
                tree.refreshTreeNode(nodeId, true);
                return null;
            }
        });
        System.out.println("[PROBE]   节点后右表过滤 " + FILTERS.size() + " 条");
        for (String filter : FILTERS) {
            System.out.println("[PROBE]     " + filter);
        }
    }

    static void treeToolbar(final AbstractListView view, final String key, int before) {
        requireTree(view);
        final Toolbar toolbar = toolbar(view, "treetoolbarap", "treetoolbar", "tree_toolbar");
        if (toolbar == null) {
            throw new IllegalStateException("找不到树工具栏 treetoolbarap/treetoolbar/tree_toolbar");
        }
        active("树工具栏 " + key, before, new Action() {
            public Object go() {
                String opKey = toolbar.getOpKey(key, new Object[0]);
                if (opKey == null || opKey.endsWith("[]") || isDonothing(opKey)) {
                    opKey = "";
                }
                toolbar.itemClick(key, opKey);
                return null;
            }
        });
    }

    static ITreeListView requireTree(AbstractListView view) {
        ITreeListView tree = view.getTreeListView();
        if (tree == null) {
            throw new IllegalStateException("布局 " + LAYOUT + " 不是左树右表列表");
        }
        return tree;
    }

    static void active(String name, int before, Action action) {
        System.out.println("[PROBE] 【" + name + "】（真提交）");
        Object result = null;
        boolean failed = false;
        long started = System.currentTimeMillis();
        try {
            result = action.go();
        } catch (Throwable throwable) {
            failed = true;
            System.out.println("[PROBE]   ⚠ 抛异常 " + HeadlessUiSupport.brief(throwable));
            System.out.println("[PROBE]   栈顶: " + HeadlessUiSupport.top(throwable, 6));
        }
        System.out.println("[PROBE]   耗时 " + (System.currentTimeMillis() - started) + "ms");
        System.out.println("[PROBE]   交互结果=" + (failed ? "异常" : "完成"));
        LAST_ACTION_OK = failed ? Boolean.FALSE : Boolean.TRUE;
        if (result instanceof OperationResult) {
            OperationResult operation = (OperationResult) result;
            LAST_OP_SUCCESS = Boolean.valueOf(operation.isSuccess());
            System.out.println("[PROBE]   结果 isSuccess=" + operation.isSuccess()
                    + " 成功=" + operation.getSuccessPkIds().size());
            for (IOperateInfo info : operation.getAllErrorOrValidateInfo()) {
                System.out.println("[PROBE]   [错误] " + HeadlessUiSupport.oneLine(info.getMessage()));
            }
        }
        rowsAfter(before);
    }

    /** 列表上的按钮、操作跑完之后的行数（S27 起真提交，不再核对「无痕」）。 */
    static void rowsAfter(int before) {
        int after = count(ENTITY);
        System.out.println("[PROBE]   跑之后行数=" + after
                + (before >= 0 && after >= 0 && after != before ? "（" + (after > before ? "+" : "") + (after - before) + "，真提交）" : ""));
    }

    static void dumpEvents() {
        System.out.println("[PROBE] --- 列表插件事件 " + EVENTS.size() + " 条 ---");
        if ("1".equals(env("LIST_EVENTS", ""))) {
            for (String event : EVENTS) {
                System.out.println("[PROBE]   " + event);
            }
            return;
        }
        Map<String, Integer> counts = new LinkedHashMap<String, Integer>();
        for (String event : EVENTS) {
            String key = event.substring(0, event.indexOf('(') + 1) + ")";
            Integer count = counts.get(key);
            counts.put(key, Integer.valueOf(count == null ? 1 : count.intValue() + 1));
        }
        for (Map.Entry<String, Integer> entry : counts.entrySet()) {
            System.out.println("[PROBE]   " + entry.getKey() + " × " + entry.getValue());
        }
    }

    static void dumpOutput() {
        System.out.println("[PROBE] --- 插件改的界面属性 " + UI_STATE.size() + " 项 ---");
        for (Map.Entry<String, String> entry : UI_STATE.entrySet()) {
            System.out.println("[PROBE]   " + entry.getKey() + " = " + entry.getValue());
        }
        System.out.println("[PROBE] --- 弹给用户的话 " + NOTICES.size() + " 条 ---");
        for (String notice : NOTICES) {
            System.out.println("[PROBE]   " + notice);
        }
        int calls = integer(env("LIST_CALLS", "0"), "LIST_CALLS");
        System.out.println("[PROBE] --- 客户端调用共 " + CALLS.size() + " 条"
                + (calls > 0 ? "，打最后 " + Math.min(calls, CALLS.size()) + " 条"
                : "（--calls N 看明细）") + " ---");
        if (calls > 0) {
            for (int i = Math.max(0, CALLS.size() - calls); i < CALLS.size(); i++) {
                System.out.println("[PROBE]   " + CALLS.get(i));
            }
        }
    }

    @SuppressWarnings("unchecked")
    static <T> T recorder(final Class<T> type) {
        return HeadlessUiSupport.recorder(type, new HeadlessUiSupport.ClientCallSink() {
            public void accept(Class<?> iface, Method method, Object[] args) {
                CALLS.add(iface.getSimpleName() + "." + method.getName()
                        + HeadlessUiSupport.deep(args));
                if (iface == IClientViewProxy.class) {
                    classify(method.getName(), args);
                }
            }
        }, new HeadlessUiSupport.ClientReturnProvider() {
            public boolean supports(Class<?> iface, Method method, Object[] args) {
                return iface == IClientViewProxy.class && "getEntryState".equals(method.getName())
                        && args != null && args.length > 0;
            }

            public Object value(Class<?> iface, Method method, Object[] args) {
                String grid = String.valueOf(args[0]);
                GridState state = new GridState(grid, new HashMap<String, Object>());
                if ("billlistap".equalsIgnoreCase(grid) && SELECTED_GRID_ROWS.length > 0) {
                    state.selectRow(SELECTED_GRID_ROWS);
                    state.setFocusRow(SELECTED_GRID_ROWS[0]);
                }
                return state;
            }
        });
    }

    static void classify(String method, Object[] args) {
        if (args == null || args.length == 0) {
            return;
        }
        if ("setFieldProperty".equals(method) && args.length == 3) {
            UI_STATE.put(args[0] + "." + prop(String.valueOf(args[1])), String.valueOf(args[2]));
        } else if ("setEntryFieldProperty".equals(method) && args.length == 4) {
            UI_STATE.put(args[0] + "." + args[1] + "." + prop(String.valueOf(args[2])),
                    String.valueOf(args[3]));
        } else if ("addNotificationMsg".equals(method)) {
            NOTICES.add(notice(args[0]));
        } else if ("addAction".equals(method) && args.length >= 2
                && isNotice(String.valueOf(args[0]))) {
            NOTICES.add(args[0] + ": " + HeadlessUiSupport.oneLine(String.valueOf(args[1])));
        }
    }

    static void seedCache(String spec) {
        if (spec.trim().isEmpty()) {
            return;
        }
        for (String one : spec.split(";")) {
            int eq = one.indexOf('=');
            if (eq <= 0) {
                throw new IllegalArgumentException("页面缓存必须是 键=值：" + one);
            }
            PAGE_CACHE.put(one.substring(0, eq).trim(), one.substring(eq + 1).trim());
            System.out.println("[PROBE] 预置页面缓存 " + one.trim());
        }
    }

    static Toolbar toolbar(IListView view, String... keys) {
        for (String key : keys) {
            try {
                Object control = view.getControl(key);
                if (control instanceof Toolbar) {
                    return (Toolbar) control;
                }
            } catch (Throwable ignore) {
                //继续尝试候选 key
            }
        }
        return null;
    }

    static String listToolbarOp(String itemKey) {
        Object toolbar = FormMetadataCache.getListToolBar(LAYOUT);
        String op = findToolbarOp(toolbar, itemKey);
        return op == null ? "" : op;
    }

    static String findToolbarOp(Object value, String itemKey) {
        if (value instanceof Map) {
            Map map = (Map) value;
            Object id = map.containsKey("id") ? map.get("id") : map.get("key");
            if (itemKey.equalsIgnoreCase(String.valueOf(id))) {
                Object op = map.containsKey("opk") ? map.get("opk") : map.get("operationKey");
                return op == null ? "" : String.valueOf(op);
            }
            for (Object child : map.values()) {
                String found = findToolbarOp(child, itemKey);
                if (found != null) {
                    return found;
                }
            }
        } else if (value instanceof Collection) {
            for (Object child : (Collection) value) {
                String found = findToolbarOp(child, itemKey);
                if (found != null) {
                    return found;
                }
            }
        }
        return null;
    }

    /** 主键在首屏第几行；不在返回 -1。选行、点行之前由 {@link #requireListed} 统一把关。 */
    static int rowIndex(String pk) {
        for (int i = 0; i < ROWS.size(); i++) {
            if (String.valueOf(ROWS.get(i).getPkValue()).equals(pk)) {
                return i;
            }
        }
        return -1;
    }

    static String columnName(Object column) {
        for (String method : new String[]{"getFieldKey", "getKey", "getName"}) {
            Object value = HeadlessUiSupport.call(column, method);
            if (value != null && !"?".equals(String.valueOf(value))
                    && !String.valueOf(value).isEmpty()) {
                return String.valueOf(value);
            }
        }
        return column == null ? "null" : column.getClass().getSimpleName();
    }

    static String selectedPk(ListSelectedRow row) {
        return row == null ? "null" : String.valueOf(row.getPrimaryKeyValue());
    }

    static String optional(DynamicObject row, String key) {
        return has(row, key) ? " " + key + "=" + String.valueOf(row.get(key)) : "";
    }

    static boolean has(DynamicObject data, String key) {
        return data != null && data.getDataEntityType().getProperties().containsKey(key);
    }

    static Object first(DynamicObject data, String... keys) {
        for (String key : keys) {
            if (has(data, key)) {
                return data.get(key);
            }
        }
        return null;
    }

    static int count(String entity) {
        try {
            return ORM.create().count("listsim", entity, null);
        } catch (Throwable throwable) {
            return -1;
        }
    }

    static int limit(String raw) {
        int value = integer(raw, "LIST_LIMIT");
        if (value <= 0 || value > 200) {
            throw new IllegalArgumentException("limit 必须在 1..200，当前 " + value);
        }
        return value;
    }

    static int integer(String raw, String name) {
        try {
            return Integer.parseInt(raw);
        } catch (NumberFormatException exception) {
            throw new IllegalArgumentException(name + " 必须是整数：" + raw);
        }
    }

    static List<Object> values(String raw) {
        List<Object> values = new ArrayList<Object>();
        for (String one : raw.split(",")) {
            values.add(scalar(one.trim()));
        }
        return values;
    }

    static Object scalar(String raw) {
        // 编号的前导零属于值本身，单值和 IN 集合都必须保留。
        if (raw.matches("-?0\\d+")) {
            return raw;
        }
        if (raw.matches("-?\\d+")) {
            try {
                return Long.valueOf(raw);
            } catch (NumberFormatException ignore) {
                return raw;
            }
        }
        if ("true".equalsIgnoreCase(raw) || "false".equalsIgnoreCase(raw)) {
            return Boolean.valueOf(raw);
        }
        return raw;
    }

    static String prop(String value) {
        if ("vi".equals(value)) {
            return "visible";
        }
        if ("en".equals(value)) {
            return "enable";
        }
        if ("l".equals(value) || "lock".equals(value)) {
            return "lock";
        }
        if ("mi".equals(value)) {
            return "mustInput";
        }
        return value;
    }

    static String notice(Object value) {
        String raw = HeadlessUiSupport.oneLine(String.valueOf(value));
        String type = raw.contains("type=1") ? "错误" : raw.contains("type=2") ? "提示"
                : raw.contains("type=0") ? "成功" : "通知";
        int index = raw.indexOf("content=");
        String body = index < 0 ? raw : raw.substring(index + 8).replaceAll("[,}].*$", "");
        return type + ": " + body;
    }

    static void rememberTreeNode(Object nodeId) {
        if (nodeId != null && !String.valueOf(nodeId).isEmpty()) {
            TREE_NODES.add(String.valueOf(nodeId));
        }
    }

    static boolean isNotice(String action) {
        String value = action.toLowerCase();
        return value.contains("message") || value.contains("notification")
                || value.contains("confirm") || value.contains("tip") || value.contains("alert");
    }

    static int size(Collection<?> values) {
        return values == null ? 0 : values.size();
    }

    static String join(Collection<String> values) {
        StringBuilder value = new StringBuilder();
        int count = 0;
        for (String one : values) {
            if (++count > 12) {
                value.append(" …共 ").append(values.size()).append(" 个");
                break;
            }
            value.append(count > 1 ? " / " : "").append(one);
        }
        return value.toString();
    }

    static String shortText(String value, int max) {
        return value.length() <= max ? value : value.substring(0, max) + "…(" + value.length() + " 字符)";
    }

    static void step(String name, Step step) {
        int events = EVENTS.size();
        long started = System.currentTimeMillis();
        try {
            step.go();
            System.out.println("[PROBE] " + name + " OK " + (System.currentTimeMillis() - started)
                    + "ms  插件事件 +" + (EVENTS.size() - events));
        } catch (Throwable throwable) {
            System.out.println("[PROBE] " + name + " ⚠ 失败：" + HeadlessUiSupport.brief(throwable));
            String blame = HeadlessUiSupport.culprit(PLUGIN_NAMES, throwable);
            if (blame != null) {
                System.out.println("[PROBE]   出错的是插件 " + blame
                        + "，它后面的插件这一步全没跑到。摘掉它重跑：--skip "
                        + blame.substring(blame.lastIndexOf('.') + 1));
            }
            System.out.println("[PROBE]   栈顶: " + HeadlessUiSupport.top(throwable, 5));
            throw propagate(throwable);
        }
    }

    static RuntimeException propagate(Throwable throwable) {
        if (throwable instanceof RuntimeException) {
            return (RuntimeException) throwable;
        }
        return new RuntimeException(throwable);
    }

    static String req(String key) {
        String value = env(key, "");
        if (value.isEmpty()) {
            System.out.println("[PROBE] 缺 " + key + "。用法：driver.mjs run list <列表布局>");
            throw new IllegalStateException("缺 " + key);
        }
        return value;
    }

    static String env(String key, String fallback) {
        String value = System.getenv(key);
        return value == null || value.trim().isEmpty() ? fallback : value.trim();
    }

    interface Step {
        void go();
    }

    interface Action {
        Object go();
    }
}
