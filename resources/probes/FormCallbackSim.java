import java.util.EventObject;
import java.util.List;
import java.util.UUID;

import cosmic.headless.HeadlessViews;

import kd.bos.context.RequestContext;
import kd.bos.dataentity.entity.DynamicObject;
import kd.bos.dataentity.entity.DynamicObjectCollection;
import kd.bos.entity.datamodel.IDataModel;
import kd.bos.form.CloseCallBack;
import kd.bos.form.FormConfig;
import kd.bos.form.FormMetadataCache;
import kd.bos.form.FormShowParameter;
import kd.bos.form.ShowType;
import kd.bos.form.plugin.FormViewPluginProxy;
import kd.bos.metadata.dao.MetaCategory;
import kd.bos.metadata.dao.MetadataDao;
import kd.bos.metadata.entity.EntityMetadata;
import kd.bos.metadata.form.ControlAp;
import kd.bos.metadata.form.FormMetadata;
import kd.bos.mvc.SessionManager;
import kd.bos.mvc.cache.PageCache;
import kd.bos.mvc.form.FormController;
import kd.bos.mvc.form.FormView;
import kd.bos.mvc.form.IFormController;

/**
 * 真实缓存父子页面回调仿真，由 cosmic_run callback 驱动（完整命令看 run callback 的卡片）。
 *
 * 上面这句会作为探针清单里的一行给模型：原来只写「回调仿真」，清单旁边又列着 CALLBACK_CLASS
 * 这些 env 名，真机 S20 批 5 模型就去翻这份源码弄清 CLASS 该填什么。
 *
 * 父、子都是真 FormView/FormDataModel，页面和模型都落真实 Redis；子操作里的
 * returnDataToParent + close 会走 FormService.closeCallBack，再由 SessionManager 从缓存重建父 View。
 * 子页打开参数通过平台序列化还原，不直接沿用父插件的 Java 对象。
 */
public class FormCallbackSim {
    public static void run() throws Exception {
        String parentForm = req("CALLBACK_PARENT");
        String childForm = req("CALLBACK_CHILD");
        String callbackClass = req("CALLBACK_CLASS");
        String callbackAction = env("CALLBACK_ACTION", "");
        String skip = env("CALLBACK_SKIP", "");
        assertOwn(parentForm);
        assertOwn(childForm);

        FormView parent = null;
        FormView child = null;
        FormSim.resetState();
        FormSim.REAL_CACHE = true;
        FormSim.resolveTarget(parentForm);
        RequestContext.get().setGlobalSessionId("formsim-flow-"
                + UUID.randomUUID().toString().replace("-", ""));
        System.out.println("[PROBE] === FormCallbackSim 父=" + parentForm + " 子=" + childForm + " ===");
        System.out.println("[PROBE] 缓存模式=真实 Redis；子页必须通过 close() 自动派发，不做 callback 直调兜底");
        try {
            parent = FormSim.openView(parentForm, "", false, skip);
            start(parent);
            ensureEntry(parent.getModel(), env("CALLBACK_PARENT_ENTRY", ""));
            apply(parent.getModel(), env("CALLBACK_PARENT_SET", ""));
            FormSim.persistReal(parent, "父页创建后");

            if (callbackAction.isEmpty()) {
                callbackAction = parent.getModel().getDataEntityType().getName();
            }
            FormShowParameter childParameter = childParameter(
                    parent, childForm, callbackClass, callbackAction);
            //真 showForm 补齐并验证父/根页面关系；前端展示动作由无头 recorder 接住。
            parent.showForm(childParameter);
            child = openChild(childParameter);
            start(child);
            apply(child.getModel(), env("CALLBACK_CHILD_SET", ""));
            FormSim.persistReal(child, "子页操作前");

            String action = driveChild(child, childForm,
                    env("CALLBACK_CHILD_OP", ""), env("CALLBACK_CHILD_CLICK", ""));

            FormView rebuiltParent = (FormView) SessionManager.getCurrent().getView(parent.getPageId());
            verify(rebuiltParent.getModel(), env("CALLBACK_EXPECT", ""));
            ProbeJson.emit("scenario", "adapter", "run callback", "parent", parentForm,
                    "child", childForm, "callback", callbackClass, "childAction", action);
            conclude("child.close() → FormService.closeCallBack → "
                    + callbackClass + ".closedCallBack");
        } finally {
            release(child);
            release(parent);
        }
    }

    private static FormShowParameter childParameter(FormView parent, String childForm,
                                                     String callbackClass, String callbackAction) {
        FormConfig config = FormMetadataCache.getFormConfig(childForm);
        FormShowParameter parameter = FormSim.newParameter(config);
        parameter.setFormId(childForm);
        parameter.setPageId("formsim_child_" + System.nanoTime());
        parameter.setParentPageId(parent.getPageId());
        parameter.setParentFormId(parent.getFormId());
        String root = parent.getFormShowParameter().getRootPageId();
        parameter.setRootPageId(root == null || root.isEmpty() ? parent.getPageId() : root);
        parameter.setFormConfig(config);
        parameter.setSendToClient(false);
        parameter.getOpenStyle().setShowType(ShowType.Modal);
        parameter.setCloseCallBack(new CloseCallBack(callbackClass, callbackAction));
        return parameter;
    }

    static FormView openChild(FormShowParameter parameter) {
        // 与平台 TempShowParamCache 的写入/读取使用同一序列化边界，不能直接传父插件的对象。
        parameter = FormShowParameter.fromJsonString(parameter.toString());
        FormConfig config = parameter.getFormConfig();
        if (config == null) {
            config = FormMetadataCache.getFormConfig(parameter.getFormId());
            parameter.setFormConfig(config);
        }
        FormView view = FormSim.newView(parameter);
        HeadlessUiSupport.PluginSelection selection = HeadlessUiSupport.selectPlugins(config, "");
        try {
            selection.install();
            view.initialize(parameter);
            ((HeadlessViews.Page) view).ensurePluginProxy();
        } finally {
            selection.restore();
        }
        return view;
    }

    static void start(FormView view) {
        start(view, false);
    }

    static void start(FormView view, boolean edit) {
        view.activate();
        view.getRootControl();
        FormController controller = (FormController) view.getService(IFormController.class);
        controller.registerListener();
        if (edit) {
            controller.loadData();
        } else {
            view.getModel().createNewData();
        }
        FormViewPluginProxy proxy = (FormViewPluginProxy) view.getService(FormViewPluginProxy.class);
        proxy.fireBeforeBindData(new EventObject(view));
        proxy.fireAfterBindData(new EventObject(view));
    }

    static void ensureEntry(IDataModel model, String entryKey) {
        if (entryKey.isEmpty()) {
            return;
        }
        if (model.getEntryRowCount(entryKey) == 0) {
            model.createNewEntryRow(entryKey);
        }
        model.setEntryCurrentRowIndex(entryKey, 0);
        System.out.println("[PROBE] 父页当前分录 " + entryKey + "[0]");
    }

    /** 支持 标量字段=值、分录.字段=值、分录[2].字段=值、分录[2].子分录[1].字段=值。 */
    static void apply(IDataModel model, String spec) {
        if (spec.isEmpty()) {
            return;
        }
        //--set 和 --expect 用同一套路径解析，两边写法不一致的话，用例照抄一行就错
        for (String[] kv : ExpectSpec.pairs(spec)) {
            ExpectSpec.Pos pos = ExpectSpec.Pos.parse(kv[0]);
            //值按**属性类型**转，不按字面猜：这里原来只认 true/false/null，
            //于是父页 --set 基础资料字段给编码会把编码字符串原样写进去，
            //而同一条写法在 run form / run op 下都成立 —— 用例照抄一行就错
            Object value = ExpectSpec.convert(model.getDataEntityType(), pos, kv[1]);
            if (pos.entry == null) {
                model.setValue(pos.field, value);
            } else {
                while (model.getEntryRowCount(pos.entry) <= pos.row) {
                    model.createNewEntryRow(pos.entry);
                }
                model.setEntryCurrentRowIndex(pos.entry, pos.row);
                if (pos.sub == null) {
                    model.setValue(pos.field, value, pos.row);
                } else {
                    //子分录靠父分录的当前行定位（上一行刚挪过去）；
                    //四参重载是 (key, value, rowIndex, parentRowIndex)，子分录行在前
                    DynamicObjectCollection rows = model.getEntryEntity(pos.entry);
                    DynamicObject parent = rows == null || rows.size() <= pos.row
                            ? null : (DynamicObject) rows.get(pos.row);
                    if (parent == null || parent.getDynamicObjectCollection(pos.sub) == null) {
                        throw new IllegalArgumentException("父分录行上没有子分录 " + pos.sub);
                    }
                    while (parent.getDynamicObjectCollection(pos.sub).size() <= pos.subRow) {
                        model.createNewEntryRow(pos.sub);
                    }
                    model.setValue(pos.field, value, pos.subRow, pos.row);
                }
            }
            System.out.println("[PROBE] set " + pos + " = " + value);
        }
    }

    /**
     * 断言父模型终值。**一条失败也把剩下的跑完**再统一报 —— 只报第一条的话，
     * 「联动写错了几个字段」得改一次跑一次才数得清。
     */
    static void verify(IDataModel model, String spec) {
        ExpectSpec.model(model, spec);
    }

    /**
     * 驱动子页的「确定」，并在驱动不了时说清楚是**哪一种**驱动不了。
     *
     * 对话框的确认动作有两种写法，而平台抛的异常里看不出是哪一种：
     * 一种是**操作**（`invokeOperation` 走得通），一种是**按钮控件**
     * （插件 `addClickListeners("btnok")` ＋ `click(EventObject)`，操作表里根本没有这个 key，
     * 这是 `bos_dialogtpl` 派生对话框的常态写法）。以前这里只走前者，遇到后者抛
     * 「btnok 操作未定义实现类！」——这句话读起来像「配置漏配了实现类」，
     * 于是人会去翻元数据、翻平台源码、换参数重试，而正确动作只是换一条入口。
     *
     * 所以：默认的 `btnok` 发现是控件时**自动改走控件**并把改走这件事打出来
     * （默认值是本工具自己选的，不该让人为它多付一次 45 秒冷启动）；
     * 显式点名 `--child-op X` 的不自动换——你点名要的通道驱动不了，得由你决定换不换。
     * 两种都不成立时直说「本通道驱动不了，这条链路需人工验收」，
     * 不要让一个结构性缺口以「未定义实现类」的样子伪装成配置错误。
     *
     * @return 实际驱动的动作，形如 `op:btnok` 或 `click:btnok`，进 ProbeJson 备查
     */
    static String driveChild(FormView child, String childForm, String operation, String clickKey) {
        if (!clickKey.isEmpty()) {
            return clickChild(child, childForm, clickKey);
        }
        String op = operation.isEmpty() ? "btnok" : operation;
        String ap = controlType(childForm, op);
        if (ap != null && operation.isEmpty()) {
            System.out.println("[PROBE] 子页 " + childForm + " 的 " + op + " 是界面控件（"
                    + ap + "），不是操作；--child-op 的默认值在这张子页上走不通，本次自动改走控件点击。"
                    + "下次可直接写 --child-click " + op);
            return clickChild(child, childForm, op);
        }
        System.out.println("[PROBE] 子页 invokeOperation(" + op
                + ")；等待插件 returnDataToParent + close");
        //S27 起真提交：子页上的操作和用户点一下一样落库
        try {
            child.invokeOperation(op);
        } catch (Throwable t) {
            throw channelGap(childForm, op, ap, t);
        }
        return "op:" + op;
    }

    private static String clickChild(FormView child, String childForm, String key) {
        Object control = null;
        try {
            control = child.getControl(key);
        } catch (Throwable ignore) {
            //控件不存在时 getControl 抛的是平台异常，这里只关心「拿没拿到」
        }
        java.lang.reflect.Method click = null;
        if (control != null) {
            try {
                click = control.getClass().getMethod("click");
            } catch (Throwable ignore) {
                //不是可点控件，下面统一报
            }
        }
        if (click == null) {
            throw new IllegalStateException("子页 " + childForm + " 上的 " + key
                    + (control == null ? " 拿不到控件" : " 是 " + control.getClass().getSimpleName()
                            + "，它没有 click()")
                    + "；这张布局上的按钮类控件有 " + join(clickables(childForm))
                    + "。确认动作是操作的话改用 --child-op " + key);
        }
        System.out.println("[PROBE] 子页点控件 " + key + "（" + control.getClass().getSimpleName()
                + ".click()，与前端点一下同一条派发链）；等待 returnDataToParent + close");
        try {
            click.invoke(control);
        } catch (java.lang.reflect.InvocationTargetException e) {
            //插件自己抛的异常要原样露出来，不能被反射的壳包住：那层壳一出现，
            //栈顶就成了 Method.invoke，看不出是哪个插件的哪一行
            Throwable cause = e.getCause() == null ? e : e.getCause();
            throw cause instanceof RuntimeException ? (RuntimeException) cause
                    : new IllegalStateException(cause);
        } catch (IllegalAccessException e) {
            throw new IllegalStateException("控件 " + key + " 的 click() 不可调用", e);
        }
        return "click:" + key;
    }

    /**
     * 「这个 key 到底是什么」——操作表和控件表各查一次，把结论摆出来，
     * 而不是把平台那句「未定义实现类」原样丢回去。
     */
    private static RuntimeException channelGap(String childForm, String op, String ap, Throwable t) {
        String message = t.getMessage() == null ? "" : t.getMessage();
        if (message.indexOf("未定义实现类") < 0 && message.indexOf("操作不存在") < 0) {
            return t instanceof RuntimeException ? (RuntimeException) t : new IllegalStateException(t);
        }
        if (ap != null) {
            return new IllegalStateException("子页 " + childForm + " 的 " + op
                    + " 不是操作，是界面控件（" + ap + "）。对话框的「确定」通常是按钮控件 ＋ 插件"
                    + " addClickListeners/click，操作表里没有它，所以 invokeOperation 只会报"
                    + "「未定义实现类」。改用 --child-click " + op + " 重跑。");
        }
        return new IllegalStateException("子页 " + childForm + " 既没有操作 " + op
                + "，也没有同名控件。它的操作只有 " + join(operations(childForm))
                + "；按钮类控件有 " + join(clickables(childForm))
                + "。都对不上的话，这条链路本通道（invokeOperation / 控件 click）驱动不了，"
                + "应当验完其余部分后停下来，在交付里写明这段需人工验收，不要再换参数试。");
    }

    /** 这个 key 在子页布局上是哪种控件；不是控件就返回 null。 */
    private static String controlType(String form, String key) {
        try {
            FormMetadata fm = (FormMetadata) MetadataDao.readMeta(
                    MetaResolve.designId(MetaResolve.entityNumber(form)), MetaCategory.Form);
            for (ControlAp<?> ap : fm.getItems()) {
                if (key.equals(ap.getKey())) {
                    return ap.getClass().getSimpleName();
                }
            }
        } catch (Throwable ignore) {
            //查不到就退回「不知道」，诊断少一句话，不至于把主异常盖掉
        }
        return null;
    }

    private static List<String> operations(String form) {
        List<String> keys = new java.util.ArrayList<String>();
        try {
            EntityMetadata em = (EntityMetadata) MetadataDao.readMeta(
                    MetaResolve.designId(MetaResolve.entityNumber(form)), MetaCategory.Entity);
            for (Object item : em.getItems()) {
                Object ops = read(item, "getOperations");
                if (!(ops instanceof List)) {
                    continue;
                }
                for (Object one : (List<?>) ops) {
                    keys.add(String.valueOf(read(one, "getKey")));
                }
            }
        } catch (Throwable ignore) {
            //同上
        }
        return keys;
    }

    private static List<String> clickables(String form) {
        List<String> keys = new java.util.ArrayList<String>();
        try {
            FormMetadata fm = (FormMetadata) MetadataDao.readMeta(
                    MetaResolve.designId(MetaResolve.entityNumber(form)), MetaCategory.Form);
            for (ControlAp<?> ap : fm.getItems()) {
                String type = ap.getClass().getSimpleName();
                if (type.contains("Button") || type.contains("BarItem")
                        || type.contains("Vector") || type.contains("Image")) {
                    keys.add(ap.getKey() + "(" + type + ")");
                }
            }
        } catch (Throwable ignore) {
            //同上
        }
        return keys;
    }

    private static Object read(Object target, String method) {
        try {
            return target.getClass().getMethod(method).invoke(target);
        } catch (Throwable ignore) {
            return null;
        }
    }

    private static String join(List<String> values) {
        if (values.isEmpty()) {
            return "（一个都没有）";
        }
        StringBuilder out = new StringBuilder();
        for (String one : values) {
            if (out.length() > 0) {
                out.append(", ");
            }
            out.append(one);
        }
        return out.toString();
    }

    /** 收尾：打断言总结，有红的就让退出码非 0（`ProbeAssert.summary()` 管 assert-none）。 */
    static void conclude(String what) {
        if (ProbeAssert.summary()) {
            System.out.println("[PROBE] PASS " + what);
            return;
        }
        throw new ProbeAssert.Failed("断言失败：" + what);
    }

    static void assertOwn(String form) {
        EntityMetadata metadata = MetaResolve.ownedEntity(form);
        IsvGuard.assertOwnEntity(metadata.getKey(), metadata);
    }

    static void release(FormView view) {
        if (view == null) {
            return;
        }
        String pageId = view.getPageId();
        List<String> errors = HeadlessUiSupport.releaseRealView(view);
        System.out.println("[PROBE] 真实缓存清理 pageId=" + pageId
                + "  remains=" + PageCache.existView(pageId));
        for (String error : errors) {
            System.out.println("[PROBE]   ⚠ 清理失败 " + error);
        }
    }

    private static String req(String key) {
        String value = env(key, "");
        if (value.isEmpty()) {
            throw new IllegalArgumentException("缺 " + key);
        }
        return value;
    }

    static String env(String key, String fallback) {
        String value = System.getenv(key);
        return value == null || value.trim().isEmpty() ? fallback : value.trim();
    }
}
