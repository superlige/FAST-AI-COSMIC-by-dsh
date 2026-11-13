import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Date;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import kd.bos.algo.DataSet;
import kd.bos.algo.Row;
import kd.bos.dataentity.entity.DynamicObject;
import kd.bos.db.DB;
import kd.bos.db.DBRoute;
import kd.bos.entity.EntityMetadataCache;
import kd.bos.entity.ExtendedDataEntity;
import kd.bos.entity.MainEntityType;
import kd.bos.orm.query.QFilter;
import kd.bos.schedule.server.ScheduleService;
import kd.bos.servicehelper.BusinessDataServiceHelper;
import kd.bos.servicehelper.QueryServiceHelper;
import kd.bos.servicehelper.workflow.WorkflowServiceHelper;
import kd.bos.workflow.component.approvalrecord.IApprovalRecord;

/**
 * 单据的审批流状态（不是探针）：DataQueryProbe 的 @流程 和各个落库的运行（MetaResolve.reportCommitted）共用。
 *
 * 「在不在流程里」照平台自己的判断：审核、撤销前的「单据在流程中校验器」调的就是 getInProcessDataEntity，
 * 它除了看流程执行表（wf_execution），还看发起、流转流程的后台任务有没有处理完（wf_job 里没做完的、wf_timerjob 里等重试的、
 * 缓存里记着正在执行的）。只看 wf_execution 会漏掉「发起任务还没处理完」这一段：平台已经拦审核了，这边还说不在流程。
 *
 * 发起中的单列出那条任务：类型、状态、建的时间。任务派不出去（本机没起调度）时，要等环境的调度来接手。
 */
final class WfState {
    private WfState() {
    }

    /** 一张单的流程状态：inFlow 为 false 表示平台判它不在流程里。 */
    static final class Flow {
        final boolean inFlow;
        /** 发起审批流的任务还没处理完：平台已按在流程中处理，流程执行表里还没有它。 */
        final boolean starting;
        final String text;

        Flow(boolean inFlow, boolean starting, String text) {
            this.inFlow = inFlow;
            this.starting = starting;
            this.text = text;
        }
    }

    /** 落库后等发起任务处理完最多等多久：本机起了调度时，发起一般 1～2 秒。 */
    private static final long SETTLE_MS = 30000L;

    /**
     * 整批查：还在流程里的从 wf_execution 看节点和挂起，待办人按 getApproversMapByBusinessKeys 再查 bos_user 的姓名电话，
     * 能否撤回用 canWithdraw；执行表里没有、平台却判在流程中的，列没处理完的发起任务；
     * 不在流程里的给最近一条有人处理过的审批记录（已审核的单「最后谁同意的」就是它）。
     */
    static Map<Long, Flow> of(MainEntityType t, List<Long> ids) {
        List<String> keys = new ArrayList<String>();
        for (Long id : ids) {
            keys.add(String.valueOf(id));
        }
        Map<String, Set<String>> nodes = new LinkedHashMap<String, Set<String>>();
        Set<String> suspended = new HashSet<String>();
        for (DynamicObject r : QueryServiceHelper.query("wf_execution", "businesskey,activityname,suspensionstate",
                new QFilter[]{new QFilter("businesskey", "in", keys)})) {
            String key = r.getString("businesskey");
            if (!nodes.containsKey(key)) {
                nodes.put(key, new LinkedHashSet<String>());
            }
            String node = r.getString("activityname");
            if (node != null && !node.trim().isEmpty()) {
                nodes.get(key).add(node.trim());
            }
            if ("2".equals(r.getString("suspensionstate"))) {
                suspended.add(key);
            }
        }
        List<String> rest = new ArrayList<String>();
        for (String k : keys) {
            if (!nodes.containsKey(k)) {
                rest.add(k);
            }
        }
        Set<String> starting = inProcess(t, rest);
        Map<String, List<String>> jobs = starting.isEmpty() ? new HashMap<String, List<String>>() : openJobs(t, starting);

        Map<String, String> approvers = new HashMap<String, String>();
        Set<String> withdrawable = new HashSet<String>();
        String withdrawError = null;
        if (!nodes.isEmpty()) {
            String[] live = nodes.keySet().toArray(new String[0]);
            Map<String, List<Long>> byKey = WorkflowServiceHelper.getApproversMapByBusinessKeys(live);
            Set<Long> users = new HashSet<Long>();
            if (byKey != null) {
                for (List<Long> one : byKey.values()) {
                    if (one != null) {
                        users.addAll(one);
                    }
                }
            }
            Map<Long, String> people = people(users);
            if (byKey != null) {
                for (Map.Entry<String, List<Long>> e : byKey.entrySet()) {
                    List<String> names = new ArrayList<String>();
                    for (Long u : e.getValue() == null ? new ArrayList<Long>() : e.getValue()) {
                        names.add(people.containsKey(u) ? people.get(u) : "用户 " + u);
                    }
                    approvers.put(e.getKey(), String.join("、", names));
                }
            }
            try {
                Object[] pks = new Object[live.length];
                for (int i = 0; i < live.length; i++) {
                    pks[i] = Long.valueOf(live[i]);
                }
                DynamicObject[] bills = BusinessDataServiceHelper.load(pks, t);
                Map<String, List<String>> can = WorkflowServiceHelper.canWithdraw(bills);
                if (can != null && can.get("wfCanWithdraw") != null) {
                    withdrawable.addAll(can.get("wfCanWithdraw"));
                }
            } catch (RuntimeException e) {
                withdrawError = firstLine(e.getMessage());
            }
        }
        Set<String> settled = new HashSet<String>(nodes.keySet());
        settled.addAll(starting);
        Map<String, String> last = lastHandled(keys, settled);
        Map<Long, Flow> out = new HashMap<Long, Flow>();
        for (Long id : ids) {
            String key = String.valueOf(id);
            if (nodes.containsKey(key)) {
                String who = approvers.get(key);
                out.put(id, new Flow(true, false, "审批中：节点 " + String.join("、", nodes.get(key))
                        + (suspended.contains(key) ? "（挂起，多是驳回到提交人）" : "")
                        + "；待办 " + (who == null || who.isEmpty() ? "无" : who)
                        + "；" + (withdrawError != null ? "能否撤回没判出来（" + withdrawError + "）"
                                : withdrawable.contains(key) ? "可撤回" : "不可撤回")));
            } else if (starting.contains(key)) {
                List<String> js = jobs.get(key);
                out.put(id, new Flow(true, true, "发起中："
                        + (js == null || js.isEmpty() ? "平台记着这张单有流程任务正在执行" : String.join("；", js))
                        + "；平台已按在流程中处理，审核、撤销会被拒"));
            } else {
                String l = last.get(key);
                out.put(id, new Flow(false, false, "不在流程" + (l == null ? "，没有审批记录" : "；上次 " + l)));
            }
        }
        return out;
    }

    /**
     * 落库之后看这张单的流程状态，有事才打一行：进了审批流、或者卡在发起中。
     * 本机起了调度、发起任务正在处理的，先等它处理完再报（最多 SETTLE_MS），免得紧接着的审核撞上「在流程中」；
     * 没起调度的，这条任务派不出去，照实说什么时候由环境接手。
     */
    static void afterCommit(String entity, Object pk) {
        Long id;
        try {
            id = Long.valueOf(String.valueOf(pk));
        } catch (NumberFormatException e) {
            return;
        }
        MainEntityType t = EntityMetadataCache.getDataEntityType(entity);
        List<Long> one = new ArrayList<Long>();
        one.add(id);
        Flow f = of(t, one).get(id);
        if (f == null || !f.inFlow) {
            return;
        }
        if (!f.starting) {
            System.out.println("[PROBE] 流程：" + f.text);
            return;
        }
        if (!scheduleStarted()) {
            System.out.println("[PROBE] 流程：" + f.text + "。本机没起调度，这条任务派不出去，要等环境的调度接手、照流程配置发起");
            return;
        }
        long t0 = System.currentTimeMillis();
        while (f != null && f.starting && System.currentTimeMillis() - t0 < SETTLE_MS) {
            try {
                Thread.sleep(500L);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            }
            f = of(t, one).get(id);
        }
        long waited = (System.currentTimeMillis() - t0) / 1000L;
        if (f == null) {
            return;
        }
        if (f.starting) {
            System.out.println("[PROBE] 流程：等了 " + waited + " 秒发起任务还没处理完——" + f.text);
        } else if (f.inFlow) {
            System.out.println("[PROBE] 流程：等发起任务处理完（" + waited + " 秒），进了审批流——" + f.text);
        } else {
            System.out.println("[PROBE] 流程：等发起任务处理完（" + waited + " 秒），没进审批流（没有匹配上的流程）");
        }
    }

    /** 平台派发后台任务前查的就是这个（JobDispatcherProxy.checkServerSatus）。 */
    private static boolean scheduleStarted() {
        try {
            ScheduleService s = ScheduleService.getInstance();
            return s != null && s.isStarted();
        } catch (Throwable e) {
            return false;
        }
    }

    /** 平台判在流程中的那几张：和「单据在流程中校验器」同一个入口。 */
    private static Set<String> inProcess(MainEntityType t, List<String> keys) {
        Set<String> out = new HashSet<String>();
        if (keys.isEmpty()) {
            return out;
        }
        ExtendedDataEntity[] es = new ExtendedDataEntity[keys.size()];
        for (int i = 0; i < keys.size(); i++) {
            DynamicObject o = new DynamicObject(t);
            o.set(t.getPrimaryKey().getName(), Long.valueOf(keys.get(i)));
            es[i] = new ExtendedDataEntity(o, i, 0);
        }
        ExtendedDataEntity[] hit = WorkflowServiceHelper.getInProcessDataEntity(es);
        if (hit != null) {
            for (ExtendedDataEntity e : hit) {
                if (e != null && e.getDataEntity() != null) {
                    out.add(String.valueOf(e.getDataEntity().getPkValue()));
                }
            }
        }
        return out;
    }

    /**
     * 没处理完的流程后台任务和等重试的任务，每张单一条条说清。
     * 提交时平台把发起任务写进单据自己那个库的 t_wf_jobrecord（和单据同一个事务，JobDAO.insert 按实体的 DBRouteKey），
     * 由调度派走、处理完再删；流程库里那张 t_wf_jobrecord（wf_job）是另一份。两处都看。
     */
    private static Map<String, List<String>> openJobs(MainEntityType t, Set<String> keys) {
        Map<String, List<String>> out = new HashMap<String, List<String>>();
        List<String> ks = new ArrayList<String>(keys);
        SimpleDateFormat f = new SimpleDateFormat("HH:mm:ss");
        Set<String> routes = new LinkedHashSet<String>();
        if (t.getDBRouteKey() != null && !t.getDBRouteKey().trim().isEmpty()) {
            routes.add(t.getDBRouteKey());
        }
        routes.add(DBRoute.workflow.getRouteKey());
        StringBuilder in = new StringBuilder();
        for (int i = 0; i < ks.size(); i++) {
            in.append(i == 0 ? "?" : ",?");
        }
        String sql = "select fid,fbusinesskey,fhandlertype,fstate,fcreatedate from t_wf_jobrecord where fbusinesskey in ("
                + in + ") and fstate in ('created','received','executing') order by fid";
        Set<Long> seen = new HashSet<Long>();
        for (String route : routes) {
            try (DataSet ds = DB.queryDataSet("WfState.openJobs", DBRoute.of(route), sql, ks.toArray())) {
                while (ds.hasNext()) {
                    Row r = ds.next();
                    if (!seen.add(r.getLong("fid"))) {
                        continue;
                    }
                    Date created = r.getDate("fcreatedate");
                    add(out, r.getString("fbusinesskey"), kind(r.getString("fhandlertype")) + "的任务 " + r.getLong("fid")
                            + " 还没处理完（" + r.getString("fstate")
                            + (created == null ? "" : "，" + f.format(created) + " 建") + "）");
                }
            } catch (RuntimeException e) {
                //这个库里没有这张表：这类单据从没建过流程任务
            }
        }
        for (DynamicObject r : QueryServiceHelper.query("wf_timerjob", "id,businesskey,jobhandlertype,duedate",
                new QFilter[]{new QFilter("businesskey", "in", ks)}, "id")) {
            Date due = r.getDate("duedate");
            add(out, r.getString("businesskey"), kind(r.getString("jobhandlertype")) + "的任务 " + r.getLong("id")
                    + " 在等重试" + (due == null ? "" : "（" + f.format(due) + " 再试）"));
        }
        return out;
    }

    private static void add(Map<String, List<String>> out, String key, String text) {
        if (!out.containsKey(key)) {
            out.put(key, new ArrayList<String>());
        }
        out.get(key).add(text);
    }

    private static String kind(String handler) {
        if ("address-process-event".equals(handler) || "event-address-process".equals(handler)) {
            return "发起审批流";
        }
        if ("start-process-event".equals(handler) || "start-callactivity-event".equals(handler)) {
            return "启动流程";
        }
        return "流程后台（" + handler + "）";
    }

    /** 不在流程里的单据最近一条有人处理过的审批记录：节点 处理人 结果 时间。 */
    private static Map<String, String> lastHandled(List<String> keys, Set<String> live) {
        Map<String, String> out = new HashMap<String, String>();
        List<String> done = new ArrayList<String>();
        for (String k : keys) {
            if (!live.contains(k)) {
                done.add(k);
            }
        }
        if (done.isEmpty()) {
            return out;
        }
        Map<String, List<IApprovalRecord>> records;
        try {
            records = WorkflowServiceHelper.batchGetApprovalRecordByBusinessKey(done);
        } catch (RuntimeException e) {
            return out;
        }
        if (records == null) {
            return out;
        }
        for (Map.Entry<String, List<IApprovalRecord>> e : records.entrySet()) {
            IApprovalRecord latest = null;
            for (IApprovalRecord r : e.getValue() == null ? new ArrayList<IApprovalRecord>() : e.getValue()) {
                //批量版不按时间排；时间是 yyyy-MM-dd HH:mm:ss.0，按文本比就是按时间比
                if (latest == null || String.valueOf(r.getTime()).compareTo(String.valueOf(latest.getTime())) > 0) {
                    latest = r;
                }
            }
            if (latest != null) {
                String time = String.valueOf(latest.getTime()).replaceAll("\\.0$", "");
                String result = latest.getResultName() == null || latest.getResultName().trim().isEmpty()
                        ? "提交" : latest.getResultName().trim();
                out.put(e.getKey(), latest.getActivityName() + " " + latest.getAssignee() + " " + result + " " + time);
            }
        }
        return out;
    }

    /** 用户 id → 「姓名(电话)」。 */
    private static Map<Long, String> people(Collection<Long> users) {
        Map<Long, String> out = new HashMap<Long, String>();
        if (users.isEmpty()) {
            return out;
        }
        for (DynamicObject u : QueryServiceHelper.query("bos_user", "id,name,phone",
                new QFilter[]{new QFilter("id", "in", new ArrayList<Long>(users))})) {
            String phone = u.getString("phone");
            out.put(u.getLong("id"), u.getString("name") + (phone == null || phone.trim().isEmpty() ? "" : "(" + phone + ")"));
        }
        return out;
    }

    private static String firstLine(String s) {
        String one = String.valueOf(s).replace('\r', ' ').replace('\n', ' ').trim();
        int at = one.indexOf(" at ");
        String head = at > 0 ? one.substring(0, at) : one;
        return head.length() > 200 ? head.substring(0, 200) + "…" : head;
    }
}
