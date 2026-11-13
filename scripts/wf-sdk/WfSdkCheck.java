import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Callable;

import com.alibaba.fastjson.JSON;

import kd.bos.dataentity.entity.DynamicObject;
import kd.bos.dataentity.entity.DynamicObjectCollection;
import kd.bos.orm.query.QCP;
import kd.bos.orm.query.QFilter;
import kd.bos.servicehelper.QueryServiceHelper;
import kd.bos.servicehelper.workflow.WorkflowServiceHelper;

/**
 * 只读：WorkflowServiceHelper 常用查询方法在本环境上实际返回什么（S37 工作流参考文档的实测依据）。
 * 三类样本各取一张：正在审批的单、审批完的单、没进流程的单。只调查询方法，不提交、不审批、不撤回。
 */
public class WfSdkCheck {

    public static void run() {
        DynamicObject task = QueryServiceHelper.queryOne("wf_task",
                "id,entitynumber,businesskey,billno,name",
                new QFilter[]{new QFilter("taskstate", QCP.equals, "willApproval")});
        DynamicObjectCollection done = QueryServiceHelper.query("wf_hicomment",
                "businesskey,entitynumber",
                new QFilter[]{new QFilter("decisiontype", QCP.equals, "approve")}, "time desc", 1);
        DynamicObjectCollection draft = QueryServiceHelper.query("zlgd_sys_test_bill", "id,billno",
                new QFilter[]{new QFilter("billstatus", QCP.equals, "A")}, "id desc", 1);

        if (task != null) {
            String key = task.getString("businesskey");
            String entity = task.getString("entitynumber");
            long taskId = task.getLong("id");
            section("正在审批 " + entity + " " + task.getString("billno") + " businessKey=" + key + " taskId=" + taskId);
            common(entity, key);
            //返回整个节点模型，摊开有 MB 级：只报大小和开头
            call("getNextUserTaskNodeByBusinessKey", () -> {
                String all = show(WorkflowServiceHelper.getNextUserTaskNodeByBusinessKey(key), 0);
                return "摊开共 " + all.length() + " 字符，开头：" + all.substring(0, Math.min(300, all.length()));
            });
            call("findTaskById", () -> WorkflowServiceHelper.findTaskById(taskId));
            call("getCommentsByTaskId", () -> WorkflowServiceHelper.getCommentsByTaskId(taskId));
            List<Long> approvers = WorkflowServiceHelper.getApproverByBusinessKey(key);
            if (approvers != null && !approvers.isEmpty()) {
                Long user = approvers.get(0);
                call("getTaskIdByBusinessKeyAndUserId(审批人 " + user + ")",
                        () -> WorkflowServiceHelper.getTaskIdByBusinessKeyAndUserId(key, user));
            }
        }
        if (!done.isEmpty()) {
            String key = done.get(0).getString("businesskey");
            String entity = done.get(0).getString("entitynumber");
            section("审批完 " + entity + " businessKey=" + key);
            common(entity, key);
        }
        //09-22 会话里的已审核检测单：中途终止过两次再重新提交，看"全部记录"和"最新记录"的差别
        section("审批完（终止过又重提） zlgd_sys_test_bill businessKey=2499338528010292224");
        common("zlgd_sys_test_bill", "2499338528010292224");
        if (!draft.isEmpty()) {
            String key = draft.get(0).getString("id");
            section("没进流程（暂存） zlgd_sys_test_bill " + draft.get(0).getString("billno") + " businessKey=" + key);
            common("zlgd_sys_test_bill", key);
        }
        section("实体有没有流程");
        call("existProcDefByEntityNumber(zlgd_sys_test_bill)",
                () -> WorkflowServiceHelper.existProcDefByEntityNumber("zlgd_sys_test_bill"));
        call("getEnabledProcDefByEntityNumber(zlgd_sys_test_bill)",
                () -> WorkflowServiceHelper.getEnabledProcDefByEntityNumber("zlgd_sys_test_bill"));
        call("existProcDefByEntityNumber(bos_user)", () -> WorkflowServiceHelper.existProcDefByEntityNumber("bos_user"));
    }

    private static void common(String entity, String key) {
        call("inProcess", () -> WorkflowServiceHelper.inProcess(key));
        call("getBizProcessStatus", () -> WorkflowServiceHelper.getBizProcessStatus(new String[]{key}));
        call("getProcessInstanceIdByBusinessKey", () -> WorkflowServiceHelper.getProcessInstanceIdByBusinessKey(key));
        call("getApproverByBusinessKey", () -> WorkflowServiceHelper.getApproverByBusinessKey(key));
        call("getApproversMapByBusinessKeys", () -> WorkflowServiceHelper.getApproversMapByBusinessKeys(new String[]{key}));
        call("getApprovalRecords(allRecord=false)", () -> WorkflowServiceHelper.getApprovalRecords(entity, key, false));
        call("getApprovalRecords(allRecord=true)", () -> WorkflowServiceHelper.getApprovalRecords(entity, key, true));
        call("getAllApprovalRecord", () -> WorkflowServiceHelper.getAllApprovalRecord(key));
        call("batchGetApprovalRecordByBusinessKey",
                () -> WorkflowServiceHelper.batchGetApprovalRecordByBusinessKey(Collections.singletonList(key)));
        call("getLastNodesComment", () -> WorkflowServiceHelper.getLastNodesComment(key));
        call("getActInstInfo(空列表)", () -> WorkflowServiceHelper.getActInstInfo(key, new ArrayList<String>(), false));
    }

    private static void section(String title) {
        System.out.println("[PROBE] ===== " + title);
    }

    private static void call(String name, Callable<Object> body) {
        long started = System.currentTimeMillis();
        try {
            Object value = body.call();
            System.out.println("[PROBE] " + name + "（" + (System.currentTimeMillis() - started) + " ms）→ " + show(value, 0));
        } catch (Throwable t) {
            System.out.println("[PROBE] " + name + " 抛异常：" + t);
        }
    }

    /** 把返回值摊开：集合、Map 逐项，普通对象交给 fastjson 摊开。 */
    private static String show(Object value, int depth) {
        if (value == null) {
            return "null";
        }
        if (depth > 3) {
            return String.valueOf(value);
        }
        if (value instanceof DynamicObjectCollection) {
            List<String> rows = new ArrayList<String>();
            for (DynamicObject row : (DynamicObjectCollection) value) {
                rows.add(show(row, depth + 1));
            }
            return "[" + rows.size() + " 行] " + rows;
        }
        if (value instanceof DynamicObject) {
            DynamicObject row = (DynamicObject) value;
            StringBuilder out = new StringBuilder("{");
            for (kd.bos.dataentity.metadata.IDataEntityProperty p : row.getDataEntityType().getProperties()) {
                Object v = row.get(p);
                if (v != null && !"".equals(String.valueOf(v))) {
                    out.append(p.getName()).append('=').append(v instanceof DynamicObject ? "<对象>" : v).append(' ');
                }
            }
            return out.append('}').toString();
        }
        if (value instanceof Map) {
            StringBuilder out = new StringBuilder("{");
            for (Object e : ((Map<?, ?>) value).entrySet()) {
                Map.Entry<?, ?> entry = (Map.Entry<?, ?>) e;
                out.append(entry.getKey()).append('=').append(show(entry.getValue(), depth + 1)).append("; ");
            }
            return out.append('}').toString();
        }
        if (value instanceof Collection) {
            List<String> items = new ArrayList<String>();
            for (Object item : (Collection<?>) value) {
                items.add(show(item, depth + 1));
            }
            return "[" + items.size() + " 项] " + items;
        }
        if (value.getClass().isArray()) {
            return show(Arrays.asList((Object[]) value), depth);
        }
        if (value.getClass().getName().startsWith("java.")) {
            return String.valueOf(value);
        }
        //普通对象交给 fastjson 按 getter 摊开（临时探针不准自己用反射）
        return value.getClass().getSimpleName() + JSON.toJSONString(value);
    }
}
