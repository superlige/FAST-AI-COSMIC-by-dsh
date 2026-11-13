package zlgd.wfcheck;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Date;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import kd.bos.context.RequestContext;
import kd.bos.data.BusinessDataReader;
import kd.bos.dataentity.OperateOption;
import kd.bos.dataentity.entity.DynamicObject;
import kd.bos.dataentity.entity.DynamicObjectCollection;
import kd.bos.dataentity.entity.LocaleString;
import kd.bos.entity.EntityMetadataCache;
import kd.bos.entity.MainEntityType;
import kd.bos.entity.botp.runtime.ConvertOperationResult;
import kd.bos.entity.botp.runtime.PushArgs;
import kd.bos.entity.datamodel.ListSelectedRow;
import kd.bos.entity.operate.result.IOperateInfo;
import kd.bos.entity.operate.result.OperationResult;
import kd.bos.orm.query.QCP;
import kd.bos.orm.query.QFilter;
import kd.bos.servicehelper.BusinessDataServiceHelper;
import kd.bos.servicehelper.QueryServiceHelper;
import kd.bos.servicehelper.botp.BFTrackerServiceHelper;
import kd.bos.servicehelper.botp.ConvertServiceHelper;
import kd.bos.servicehelper.operation.DeleteServiceHelper;
import kd.bos.servicehelper.operation.OperationServiceHelper;
import kd.bos.servicehelper.operation.SaveServiceHelper;
import kd.bos.servicehelper.workflow.WorkflowServiceHelper;
import kd.bos.workflow.api.BizProcessStatus;

/**
 * 临时测试类，不交付：WorkflowServiceHelper 写方法在真环境上的实际行为（fast-ai-cosmic 工作流参考文档的实测依据）。
 * 由 fast-ai-cosmic 的 scripts/verify-wf-write.ts 拷进工程、用 run call 逐个调，跑完删除。
 * 每个动作方法都返回动作之后的流程状态（state），前后对照看这个动作改了什么。
 */
public class WfWriteCheck {

    private static final String ENTITY = "zlgd_sys_test_bill";
    /** 一次调用里最多等这么久：常驻进程一次请求 120 秒就判超时，超了那台进程就不能再用。 */
    private static final long WAIT_BUDGET_MS = 80000L;

    /** 建一张草稿。直接存库、不走保存操作：这张单据的保存插件会对新单再存一次，操作链上会主键重复。 */
    public static String newBill(String orgNumber) {
        DynamicObject org = QueryServiceHelper.queryOne("bos_org", "id",
                new QFilter[]{new QFilter("number", QCP.equals, orgNumber)});
        if (org == null) {
            throw new IllegalArgumentException("没有编码为 " + orgNumber + " 的组织");
        }
        DynamicObject bill = BusinessDataServiceHelper.newDynamicObject(ENTITY);
        bill.set("billno", "WFW-" + new SimpleDateFormat("yyyyMMddHHmmssSSS").format(new Date()));
        bill.set("billstatus", "A");
        bill.set("zlgd_org", BusinessDataServiceHelper.loadSingle(org.getLong("id"), "bos_org"));
        bill.set("zlgd_zybh", "H");
        //单据类型、专业室项目、检验类型是提交必填：照同组织一张不是本类建的单抄
        DynamicObject sample = sample(orgNumber);
        bill.set("zlgd_djlx_id", sample.getLong("zlgd_djlx"));
        bill.set("zlgd_jylx_id", sample.getLong("zlgd_jylx"));
        bill.set("zlgd_jylx1", sample.getString("zlgd_jylx1"));
        bill.set("creator", BusinessDataServiceHelper.loadSingle(RequestContext.get().getCurrUserId(), "bos_user"));
        bill.set("createtime", new Date());
        SaveServiceHelper.save(new DynamicObject[]{bill});
        String id = String.valueOf(bill.getPkValue());
        out("newBill", bill.getString("billno") + " id=" + id);
        return id;
    }

    /** 单据操作：submit / unsubmit / audit …，按 id 调，插件照跑。 */
    public static Map<String, Object> op(String id, String operation) {
        long called = System.currentTimeMillis();
        String before = String.valueOf(collect(id));
        OperationResult r = OperationServiceHelper.executeOperate(operation, ENTITY,
                new Object[]{Long.valueOf(id)}, OperateOption.create());
        Map<String, Object> result = new LinkedHashMap<String, Object>();
        result.put("success", r.isSuccess());
        List<String> errors = new ArrayList<String>();
        for (IOperateInfo info : r.getAllErrorOrValidateInfo()) {
            errors.add(info.getMessage());
        }
        result.put("message", r.getMessage());
        result.put("errors", errors);
        out(operation, String.valueOf(result));
        if ("submit".equals(operation) && r.isSuccess()) {
            //发起流程是后台任务：提交返回时流程实例可能还没建，先等它进流程（不进流程的单等满 30 秒照样往下）
            long started = System.currentTimeMillis();
            while (!WorkflowServiceHelper.inProcess(id) && System.currentTimeMillis() - started < 30000L) {
                try {
                    Thread.sleep(1000L);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }
            out("enterProcess", (WorkflowServiceHelper.inProcess(id) ? "进了流程" : "30 秒没进流程")
                    + "，等了 " + (System.currentTimeMillis() - started) + " ms");
            //第一个审批任务可能一分多钟后才出来，这里不等：调用方先清检验类型，再用 waitTask 等
            result.put("state", state(id));
            return result;
        }
        return withState(result, id, before, WAIT_BUDGET_MS - (System.currentTimeMillis() - called));
    }

    /** 等流程里出现待办任务（或流程结束），最多等一个预算；没等到调用方再调一次。 */
    public static Map<String, Object> waitTask(String id) {
        long started = System.currentTimeMillis();
        Map<String, Object> now = collect(id);
        while (!taskOrDone(now) && System.currentTimeMillis() - started < WAIT_BUDGET_MS) {
            try {
                Thread.sleep(2000L);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            }
            now = collect(id);
        }
        out("waitTask", (taskOrDone(now) ? "有待办或流程已结束" : "还没有待办") + "，等了 "
                + (System.currentTimeMillis() - started) + " ms");
        return state(id);
    }

    private static boolean taskOrDone(Map<String, Object> s) {
        Object tasks = s.get("wf_task");
        return Boolean.FALSE.equals(s.get("inProcess")) || tasks instanceof List && !((List<?>) tasks).isEmpty();
    }

    /**
     * 提交之后清空检验类型（直接存库、不走插件）：审批走完自动审核时，审核插件见它有值就把检测结果推给外部系统，
     * 测试单不该推出去。
     */
    public static Map<String, Object> clearTestType(String id) {
        DynamicObject bill = load(id);
        bill.set("zlgd_jylx1", null);
        SaveServiceHelper.save(new DynamicObject[]{bill});
        Map<String, Object> result = new LinkedHashMap<String, Object>();
        result.put("zlgd_jylx1", QueryServiceHelper.queryOne(ENTITY, "zlgd_jylx1",
                new QFilter[]{new QFilter("id", QCP.equals, Long.valueOf(id))}).getString("zlgd_jylx1"));
        out("clearTestType", String.valueOf(result));
        return result;
    }

    /** 把检验类型按样本填回去（直接存库）：它是提交必填，清掉之后要再提交就得先填回。 */
    public static Map<String, Object> restoreTestType(String id) {
        DynamicObject bill = load(id);
        bill.set("zlgd_jylx1", sample(bill.getDynamicObject("zlgd_org").getString("number")).getString("zlgd_jylx1"));
        SaveServiceHelper.save(new DynamicObject[]{bill});
        Map<String, Object> result = new LinkedHashMap<String, Object>();
        result.put("zlgd_jylx1", bill.getString("zlgd_jylx1"));
        out("restoreTestType", String.valueOf(result));
        return result;
    }

    private static DynamicObject sample(String orgNumber) {
        DynamicObject sample = QueryServiceHelper.queryOne(ENTITY, "zlgd_djlx,zlgd_jylx,zlgd_jylx1", new QFilter[]{
                new QFilter("zlgd_org.number", QCP.equals, orgNumber), new QFilter("zlgd_djlx", QCP.not_equals, 0L),
                new QFilter("zlgd_jylx1", QCP.not_equals, " "), new QFilter("zlgd_jylx1", QCP.is_notnull, null),
                new QFilter("billno", QCP.not_like, "WFW-%")});
        if (sample == null) {
            throw new IllegalArgumentException("组织 " + orgNumber + " 下没有填了单据类型和检验类型的单子可抄");
        }
        return sample;
    }

    /** 按发起操作把单据送进流程：平台按流程的发起条件选流程。 */
    public static Map<String, Object> trigger(String id, String operation) {
        Map<String, Object> result = new LinkedHashMap<String, Object>();
        String before = String.valueOf(collect(id));
        attempt(result, "tryTriggerProcess(" + operation + ")", () -> {
            WorkflowServiceHelper.tryTriggerProcess(id, operation, ENTITY, new HashMap<String, Object>());
            return null;
        });
        return withState(result, id, before);
    }

    /** 当前审批人处理当前任务：decision 是决策项编码（Consent / Reject）。 */
    public static Map<String, Object> complete(String id, String decision) {
        Map<String, Object> result = new LinkedHashMap<String, Object>();
        String before = String.valueOf(collect(id));
        List<Long> approvers = WorkflowServiceHelper.getApproverByBusinessKey(id);
        result.put("approvers", approvers);
        if (approvers == null || approvers.isEmpty()) {
            result.put("error", "没有当前审批人");
            return withState(result, id, before);
        }
        Long user = approvers.get(0);
        Long taskId = WorkflowServiceHelper.getTaskIdByBusinessKeyAndUserId(id, user);
        result.put("user", user);
        result.put("taskId", taskId);
        attempt(result, "completeTask(" + taskId + "," + user + "," + decision + ")",
                () -> {
                    WorkflowServiceHelper.completeTask(taskId, user, decision, "WF 写操作实测");
                    return null;
                });
        return withState(result, id, before);
    }

    /** 批量同意：当前审批人名下这张单的任务。 */
    public static Map<String, Object> batchAgree(String id) {
        Map<String, Object> result = new LinkedHashMap<String, Object>();
        String before = String.valueOf(collect(id));
        List<Long> approvers = WorkflowServiceHelper.getApproverByBusinessKey(id);
        if (approvers == null || approvers.isEmpty()) {
            result.put("error", "没有当前审批人");
            return withState(result, id, before);
        }
        Long user = approvers.get(0);
        Long taskId = WorkflowServiceHelper.getTaskIdByBusinessKeyAndUserId(id, user);
        result.put("user", user);
        result.put("taskId", taskId);
        attempt(result, "batchAgreeTaskWithUserId",
                () -> WorkflowServiceHelper.batchAgreeTaskWithUserId(Collections.singletonList(taskId),
                        new LocaleString("WF 写操作实测：批量同意"), user));
        return withState(result, id, before);
    }

    /**
     * 按单据批量审批：param 要有 auditUserId（审批人）和 batchOpType（approve / reject），缺一个就只回「参数错误」
     * （平台源码 BatchAuditByBusinessKeysCmd；传空 Map 真机回的就是这句）。
     */
    public static Map<String, Object> batchAudit(String id, String opType) {
        Map<String, Object> result = new LinkedHashMap<String, Object>();
        String before = String.valueOf(collect(id));
        List<Long> approvers = WorkflowServiceHelper.getApproverByBusinessKey(id);
        if (approvers == null || approvers.isEmpty()) {
            result.put("error", "没有当前审批人");
            return withState(result, id, before);
        }
        Map<String, Object> param = new HashMap<String, Object>();
        param.put("auditUserId", approvers.get(0));
        param.put("batchOpType", opType);
        result.put("user", approvers.get(0));
        attempt(result, "batchAuditByBusinesskeys(" + opType + ")",
                () -> WorkflowServiceHelper.batchAuditByBusinesskeys(Collections.singletonList(id), param));
        return withState(result, id, before);
    }

    /** 撤回刚处理过的任务：userId 是处理人。 */
    public static Map<String, Object> withdrawTask(String id, String userIdText) {
        Long userId = Long.valueOf(userIdText);
        Map<String, Object> result = new LinkedHashMap<String, Object>();
        String before = String.valueOf(collect(id));
        attempt(result, "withdrawTaskByBusinessKeyAndUserId(" + userId + ")", () -> {
            WorkflowServiceHelper.withdrawTaskByBusinessKeyAndUserId(id, userId);
            return null;
        });
        return withState(result, id, before);
    }

    public static Map<String, Object> canWithdraw(String id) {
        Map<String, Object> result = new LinkedHashMap<String, Object>();
        String before = String.valueOf(collect(id));
        attempt(result, "canWithdraw", () -> WorkflowServiceHelper.canWithdraw(new DynamicObject[]{load(id)}));
        //只读：状态不会变，不等
        return withState(result, id, null);
    }

    public static Map<String, Object> withdraw(String id) {
        Map<String, Object> result = new LinkedHashMap<String, Object>();
        String before = String.valueOf(collect(id));
        attempt(result, "withdraw(obj)", () -> {
            WorkflowServiceHelper.withdraw(load(id));
            return null;
        });
        return withState(result, id, before);
    }

    public static Map<String, Object> batchWithdraw(String id, String operationName) {
        Map<String, Object> result = new LinkedHashMap<String, Object>();
        String before = String.valueOf(collect(id));
        attempt(result, "batchWithdraw(" + operationName + ")",
                () -> WorkflowServiceHelper.batchWithdraw(new DynamicObject[]{load(id)}, operationName));
        return withState(result, id, before);
    }

    public static Map<String, Object> billUnsubmit(String id, String operationName) {
        Map<String, Object> result = new LinkedHashMap<String, Object>();
        String before = String.valueOf(collect(id));
        Map<String, Object> param = new HashMap<String, Object>();
        //平台按字符串取、看单据 id 在不在里面：在就按终止撤回，不在或不传就普通撤回（传 List 会类型转换失败）
        param.put("abandonPks", id);
        attempt(result, "billUnsubmit(" + operationName + ", abandonPks)", () -> {
            WorkflowServiceHelper.billUnsubmit(new DynamicObject[]{load(id)}, operationName, param);
            return null;
        });
        return withState(result, id, before);
    }

    public static Map<String, Object> abandon(String id) {
        Map<String, Object> result = new LinkedHashMap<String, Object>();
        String before = String.valueOf(collect(id));
        attempt(result, "abandonByBusienssKey", () -> {
            WorkflowServiceHelper.abandonByBusienssKey(id);
            return null;
        });
        return withState(result, id, before);
    }

    public static Map<String, Object> abandonRoot(String id) {
        Map<String, Object> result = new LinkedHashMap<String, Object>();
        String before = String.valueOf(collect(id));
        attempt(result, "abandonRootProcessInstance", () -> {
            WorkflowServiceHelper.abandonRootProcessInstance(id);
            return null;
        });
        return withState(result, id, before);
    }

    /** 这张单此刻的流程状态：单据状态、在不在流程里、当前节点和审批人、流程表里的行。 */
    public static Map<String, Object> state(String id) {
        Map<String, Object> s = collect(id);
        for (Map.Entry<String, Object> e : s.entrySet()) {
            out("  state." + e.getKey(), String.valueOf(e.getValue()));
        }
        return s;
    }

    private static Map<String, Object> collect(String id) {
        Map<String, Object> s = new LinkedHashMap<String, Object>();
        QFilter byId = new QFilter("id", QCP.equals, Long.valueOf(id));
        DynamicObject bill = QueryServiceHelper.queryOne(ENTITY, "billno,billstatus", new QFilter[]{byId});
        s.put("billstatus", bill == null ? "（单据不在了）" : bill.getString("billstatus"));
        s.put("inProcess", WorkflowServiceHelper.inProcess(id));
        List<BizProcessStatus> status = WorkflowServiceHelper.getBizProcessStatus(new String[]{id}).get(id);
        if (status != null && !status.isEmpty()) {
            s.put("node", status.get(0).getCurrentNodeName());
            s.put("participant", status.get(0).getParticipantName());
        }
        s.put("approvers", WorkflowServiceHelper.getApproverByBusinessKey(id));
        s.put("processInstanceId", WorkflowServiceHelper.getProcessInstanceIdByBusinessKey(id));
        QFilter byKey = new QFilter("businesskey", QCP.equals, id);
        s.put("wf_execution", rows("wf_execution", "activityname,currenttaskid,suspensionstate", byKey, null));
        s.put("wf_task", rows("wf_task", "id,name,taskstate", byKey, null));
        s.put("wf_hicomment", rows("wf_hicomment", "activityname,userid,decisiontype,resultname", byKey, "time asc"));
        s.put("wf_hiprocinst", QueryServiceHelper.query("wf_hiprocinst", "id", new QFilter[]{byKey}).size());
        return s;
    }

    private interface Body {
        Object call() throws Exception;
    }

    private static void attempt(Map<String, Object> result, String name, Body body) {
        long started = System.currentTimeMillis();
        try {
            Object value = body.call();
            result.put("returned", value);
            result.put("error", "");
            out(name, "（" + (System.currentTimeMillis() - started) + " ms）→ " + value);
        } catch (Throwable t) {
            result.put("error", t.toString());
            out(name, "（" + (System.currentTimeMillis() - started) + " ms）抛异常 " + t);
        }
    }

    /**
     * 动作之后等流程停下来再报：发起流程、流转到下一节点是派给调度服务的后台任务，动作返回时可能还没跑，
     * 一步要好几秒（真机：提交到第一个审批任务出来约 40 秒，慢时超过一分半），中途会停在某个节点上几秒不动，
     * 所以不能按「几秒没变」判；处理任务也是后台跑，刚返回时审批人还是原来那个，也不能只看「停在人手上」。
     * 停下来 = 状态和动作之前不一样了，并且不在流程里了或者停在人手上（有当前审批人）。
     * 动作抛了异常、或者没报成功的不等；每 2 秒看一次，最多等 waitMs；等了多久一起打出来。
     */
    private static Map<String, Object> withState(Map<String, Object> result, String id, String before) {
        return withState(result, id, before, WAIT_BUDGET_MS);
    }

    private static Map<String, Object> withState(Map<String, Object> result, String id, String before, long waitMs) {
        long started = System.currentTimeMillis();
        boolean failed = !"".equals(String.valueOf(result.getOrDefault("error", "")))
                || Boolean.FALSE.equals(result.get("success"));
        boolean settled = failed || before == null || settled(id, before);
        while (!settled && System.currentTimeMillis() - started < waitMs) {
            try {
                Thread.sleep(2000L);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            }
            settled = settled(id, before);
        }
        out("settle", (failed ? "动作没成，不等" : settled ? "停下" : "等满预算还没停（或状态没变）")
                + "，等了 " + (System.currentTimeMillis() - started) + " ms");
        result.put("state", state(id));
        return result;
    }

    /** 单据状态先变、待办任务后清（真机：同意后约 7 秒单据已审核，任务还挂着），所以看的是待办换没换。 */
    private static boolean settled(String id, String before) {
        Map<String, Object> now = collect(id);
        if (before.equals(String.valueOf(now))) {
            return false;
        }
        if (Boolean.FALSE.equals(now.get("inProcess"))) {
            return true;
        }
        Object tasks = now.get("wf_task");
        return tasks instanceof List && !((List<?>) tasks).isEmpty() && !before.contains("wf_task=" + tasks);
    }

    private static DynamicObject load(String id) {
        return BusinessDataServiceHelper.loadSingle(Long.valueOf(id), ENTITY);
    }

    private static List<String> rows(String entity, String fields, QFilter filter, String order) {
        DynamicObjectCollection found = QueryServiceHelper.query(entity, fields, new QFilter[]{filter}, order);
        List<String> out = new ArrayList<String>();
        for (DynamicObject row : found) {
            StringBuilder line = new StringBuilder();
            for (String f : fields.split(",")) {
                line.append(f).append('=').append(row.get(f)).append(' ');
            }
            out.add(line.toString().trim());
        }
        return out;
    }

    // ---------------- 测试现场：清掉本类建的单、给需求复测备样本 ----------------

    private static final String ENTRUST = "zlgd_qty_wtd";
    /** 转换规则「西北铝下推实验室检测单」：它把委托单号映射进检测单的 zlgd_wtdh。 */
    private static final String XBL_PUSH_RULE = "2478552709284810752";

    /** 本类建的测试单（编号 WFW- 开头）的 id。 */
    public static List<String> wfwBills() {
        List<String> ids = new ArrayList<String>();
        for (DynamicObject row : QueryServiceHelper.query(ENTITY, "id,billno",
                new QFilter[]{new QFilter("billno", QCP.like, "WFW-%")}, "id asc")) {
            ids.add(row.getString("id"));
            out("wfwBill", row.getString("billno") + " id=" + row.getString("id"));
        }
        return ids;
    }

    /**
     * 删掉一张本类建的测试单：还在流程里就先终止流程，再直接删库。不走撤销、删除操作——那条插件链在最近一次审批是驳回时
     * 会按委托单号删上游委托单、调外部接口，而复测会话给其中几张填过委托单号。
     */
    public static Map<String, Object> purge(String id) {
        Map<String, Object> result = new LinkedHashMap<String, Object>();
        DynamicObject bill = QueryServiceHelper.queryOne(ENTITY, "billno",
                new QFilter[]{new QFilter("id", QCP.equals, Long.valueOf(id))});
        if (bill == null || !bill.getString("billno").startsWith("WFW-")) {
            throw new IllegalArgumentException(id + " 不是本类建的测试单（编号不是 WFW- 开头），不删");
        }
        result.put("billno", bill.getString("billno"));
        if (WorkflowServiceHelper.inProcess(id)) {
            attempt(result, "abandonByBusienssKey", () -> {
                WorkflowServiceHelper.abandonByBusienssKey(id);
                return null;
            });
        }
        result.put("deleted", DeleteServiceHelper.delete(ENTITY,
                new QFilter[]{new QFilter("id", QCP.equals, Long.valueOf(id))}));
        result.put("left", QueryServiceHelper.query(ENTITY, "id",
                new QFilter[]{new QFilter("id", QCP.equals, Long.valueOf(id))}).size());
        out("purge", String.valueOf(result));
        return result;
    }

    /** 西北铝（04）已审核、没有任何下游的委托单编号：下推关系和检测单上的委托单号都查不到，最多 limit 张，最早的在前。 */
    public static List<String> cleanEntrusts(int limit) {
        List<String> out = new ArrayList<String>();
        for (DynamicObject row : QueryServiceHelper.query(ENTRUST, "id,billno", new QFilter[]{
                new QFilter("org.number", QCP.equals, "04"), new QFilter("billstatus", QCP.equals, "C")}, "id asc")) {
            if (out.size() >= limit) {
                break;
            }
            Map<String, java.util.HashSet<Long>> targets = BFTrackerServiceHelper.findTargetBills(ENTRUST,
                    new Long[]{row.getLong("id")});
            boolean linked = targets != null && targets.values().stream().anyMatch(ids -> !ids.isEmpty());
            if (linked || QueryServiceHelper.exists(ENTITY,
                    new QFilter[]{new QFilter("zlgd_wtdh", QCP.equals, row.getString("billno"))})) {
                continue;
            }
            out.add(row.getString("billno"));
            out("cleanEntrust", row.getString("billno") + " id=" + row.getString("id"));
        }
        return out;
    }

    /**
     * 按「西北铝下推实验室检测单」把一张委托单下推成检测单并走保存操作（暂存），和界面上下推一样留下下推关系、
     * 填上委托单号。返回检测单 id。
     */
    public static String pushTestBill(String entrustNo) {
        DynamicObject entrust = QueryServiceHelper.queryOne(ENTRUST, "id,org.number,billstatus",
                new QFilter[]{new QFilter("billno", QCP.equals, entrustNo)});
        if (entrust == null || !"04".equals(entrust.getString("org.number"))) {
            throw new IllegalArgumentException("没有西北铝（04）的委托单 " + entrustNo);
        }
        PushArgs args = new PushArgs();
        args.setSourceEntityNumber(ENTRUST);
        args.setTargetEntityNumber(ENTITY);
        args.setRuleId(XBL_PUSH_RULE);
        args.setHasRight(true);
        args.setBuildConvReport(true);
        ListSelectedRow row = new ListSelectedRow();
        row.setPrimaryKeyValue(entrust.getLong("id"));
        args.setSelectedRows(Collections.singletonList(row));
        ConvertOperationResult pushed = ConvertServiceHelper.push(args);
        if (!pushed.isSuccess()) {
            throw new IllegalStateException("下推失败：" + pushed.getMessage() + " " + pushed.getBillReports());
        }
        MainEntityType type = EntityMetadataCache.getDataEntityType(ENTITY);
        List<DynamicObject> bills = pushed.loadTargetDataObjects(BusinessDataReader::loadRefence, type);
        OperationResult saved = SaveServiceHelper.saveOperate(ENTITY, bills.toArray(new DynamicObject[0]),
                OperateOption.create());
        if (!saved.isSuccess()) {
            List<String> errors = new ArrayList<String>();
            for (IOperateInfo info : saved.getAllErrorOrValidateInfo()) {
                errors.add(info.getMessage());
            }
            throw new IllegalStateException("保存失败：" + saved.getMessage() + " " + errors);
        }
        String id = String.valueOf(saved.getSuccessPkIds().get(0));
        DynamicObject bill = QueryServiceHelper.queryOne(ENTITY, "billno,billstatus,zlgd_wtdh",
                new QFilter[]{new QFilter("id", QCP.equals, Long.valueOf(id))});
        out("pushTestBill", entrustNo + " → " + bill.getString("billno") + " id=" + id + " billstatus="
                + bill.getString("billstatus") + " zlgd_wtdh=" + bill.getString("zlgd_wtdh") + " 下推关系="
                + BFTrackerServiceHelper.findSourceBills(ENTITY, new Long[]{Long.valueOf(id)}));
        return id;
    }

    private static void out(String name, String text) {
        System.out.println("[PROBE] [WF] " + name + " " + text);
    }
}
