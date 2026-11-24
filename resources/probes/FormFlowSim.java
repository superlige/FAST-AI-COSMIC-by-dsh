import java.util.List;
import java.util.UUID;

import kd.bos.context.RequestContext;
import kd.bos.form.CloseCallBack;
import kd.bos.form.FormShowParameter;
import kd.bos.mvc.SessionManager;
import kd.bos.mvc.form.FormView;

/**
 * 高保真父子表单流程（cosmic_run flow 驱动）：父动作（按钮、操作或分录超链接）→ 捕获真 showForm 参数 → 子操作
 * → close 回传 → 父模型断言。
 *
 * 与 FormCallbackSim 的区别：这里不手工拼 child FormShowParameter / CloseCallBack，
 * 子页标识、自定义参数、父子 pageId、回调类和 actionId 全部来自父业务插件的真实 showForm 调用。
 */
public class FormFlowSim {
    public static void run() throws Exception {
        String parentForm = req("FLOW_PARENT");
        String parentClick = env("FLOW_PARENT_CLICK", "");
        String parentOperation = env("FLOW_PARENT_OP", "");
        String parentHyperlink = env("FLOW_PARENT_HYPERLINK", "");
        int actions = (parentClick.isEmpty() ? 0 : 1) + (parentOperation.isEmpty() ? 0 : 1)
                + (parentHyperlink.isEmpty() ? 0 : 1);
        if (actions != 1) {
            throw new IllegalArgumentException("父动作必须且只能给一个：--click、--op 或 --hyperlink");
        }
        String expectedChild = env("FLOW_CHILD", "");
        String skip = env("FLOW_SKIP", "");
        String parentPk = env("FLOW_PK", "");
        boolean edit = !parentPk.isEmpty();
        String parentEntry = env("FLOW_PARENT_ENTRY", "");
        String selection = env("FLOW_SELECT", "");
        if (!selection.isEmpty() && selection.indexOf('=') < 0 && !parentEntry.isEmpty()) {
            selection = parentEntry + "=" + selection;
        }
        String parentEntity = MetaResolve.entityNumber(parentForm);
        //run 的 --billno 传进来是 billno:编号
        try {
            parentPk = MetaResolve.pkOf(parentEntity, parentPk);
        } catch (IllegalArgumentException e) {
            ProbeAssert.inputInvalid("flow-pk", parentEntity + " " + parentPk, e.getMessage());
            throw new ProbeAssert.InputInvalid(e.getMessage());
        }
        FormCallbackSim.assertOwn(parentForm);

        FormView parent = null;
        FormView child = null;
        FormSim.resetState();
        FormSim.REAL_CACHE = true;
        FormSim.resolveTarget(parentForm);
        ExpectSpec.Pos link = FormSim.hyperlinkPos(parentHyperlink);
        FormSim.setGridSelections(selection);
        RequestContext.get().setGlobalSessionId("formsim-flow-"
                + UUID.randomUUID().toString().replace("-", ""));
        System.out.println("[PROBE] === FormFlowSim 父=" + parentForm
                + " 动作=" + (!parentClick.isEmpty() ? "click:" + parentClick
                : !parentOperation.isEmpty() ? "op:" + parentOperation : "hyperlink:" + parentHyperlink) + " ===");
        System.out.println("[PROBE] 子页参数必须由父插件 showForm 产生；不接受手工 callback 兜底");
        try {
            parent = FormSim.openView(parentForm, parentPk, edit, skip);
            FormCallbackSim.start(parent);
            FormCallbackSim.ensureEntry(parent.getModel(), parentEntry);
            FormCallbackSim.apply(parent.getModel(), env("FLOW_PARENT_SET", ""));
            FormSim.persistReal(parent, "父操作前");

            FormSim.clearOpenedForms();
            int before = FormSim.count(parentEntity);
            if (!parentClick.isEmpty()) {
                FormSim.clickItem(parent, parentClick, before, parentEntity,
                        env("FLOW_TOOLBAR", ""));
            } else if (!parentOperation.isEmpty()) {
                FormSim.runOp(parent, parentOperation, before, parentEntity);
            } else {
                FormSim.hyperlinkRow(parent, link);
                //没给 --select 时点的那一行就是选中行，和 run form 一样
                if (selection.isEmpty()) {
                    FormSim.selectRows("");
                }
                FormSim.hyperlink(parent, link);
            }

            FormShowParameter childParameter = capturedChild(expectedChild);
            CloseCallBack callback = childParameter.getCloseCallBack();
            if (callback == null) {
                throw new IllegalStateException("父插件打开了子页，但没有 CloseCallBack："
                        + childParameter.getFormId());
            }
            FormCallbackSim.assertOwn(childParameter.getFormId());
            System.out.println("[PROBE] 父操作捕获成功：子页=" + childParameter.getFormId()
                    + " customParams=" + childParameter.getCustomParams().size()
                    + " callback=" + callback.getClassName() + ":" + callback.getActionId());
            FormSim.persistReal(parent, "父操作后");

            child = FormCallbackSim.openChild(childParameter);
            FormCallbackSim.start(child);
            FormCallbackSim.apply(child.getModel(), env("FLOW_CHILD_SET", ""));
            FormSim.persistReal(child, "子操作前");

            String childAction = FormCallbackSim.driveChild(child, childParameter.getFormId(),
                    env("FLOW_CHILD_OP", ""), env("FLOW_CHILD_CLICK", ""));

            FormView rebuiltParent = (FormView) SessionManager.getCurrent().getView(parent.getPageId());
            FormCallbackSim.verify(rebuiltParent.getModel(), env("FLOW_EXPECT", ""));
            ProbeJson.emit("scenario", "adapter", "run flow", "parent", parentForm,
                    "child", childParameter.getFormId(),
                    "parentAction", !parentClick.isEmpty() ? parentClick
                            : !parentOperation.isEmpty() ? parentOperation : "hyperlink:" + parentHyperlink,
                    "childAction", childAction);
            FormCallbackSim.conclude("父操作 → 捕获子页面 → 子操作 → 回传数据 → "
                    + "父 closedCallBack → 模型断言");
        } finally {
            FormCallbackSim.release(child);
            FormCallbackSim.release(parent);
        }
    }

    private static FormShowParameter capturedChild(String expectedForm) {
        List<FormShowParameter> opened = FormSim.openedForms();
        if (opened.isEmpty()) {
            throw new IllegalStateException("父操作没有调用 showForm；检查按钮、选中行和 registerListener 输出");
        }
        if (!expectedForm.isEmpty()) {
            FormShowParameter found = null;
            for (FormShowParameter parameter : opened) {
                if (expectedForm.equals(parameter.getFormId())) {
                    if (found != null) {
                        throw new IllegalStateException("父操作重复打开子页 " + expectedForm);
                    }
                    found = parameter;
                }
            }
            if (found == null) {
                throw new IllegalStateException("父操作打开的不是预期子页 " + expectedForm
                        + "，实际=" + formIds(opened));
            }
            return found;
        }
        if (opened.size() != 1) {
            throw new IllegalStateException("父操作打开了多个子页 " + formIds(opened)
                    + "；用 --child 指定要继续的那个");
        }
        return opened.get(0);
    }

    private static String formIds(List<FormShowParameter> parameters) {
        StringBuilder value = new StringBuilder();
        for (FormShowParameter parameter : parameters) {
            if (value.length() > 0) {
                value.append(',');
            }
            value.append(parameter.getFormId());
        }
        return value.toString();
    }

    private static String req(String key) {
        String value = env(key, "");
        if (value.isEmpty()) {
            throw new IllegalArgumentException("缺 " + key);
        }
        return value;
    }

    private static String env(String key, String fallback) {
        String value = System.getenv(key);
        return value == null || value.trim().isEmpty() ? fallback : value.trim();
    }
}
