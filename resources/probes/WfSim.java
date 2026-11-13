import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.sql.ResultSet;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import kd.bos.context.RequestContext;
import kd.bos.dataentity.entity.DynamicObject;
import kd.bos.dataentity.entity.DynamicObjectCollection;
import kd.bos.dataentity.entity.ILocaleString;
import kd.bos.dataentity.entity.LocaleString;
import kd.bos.db.DB;
import kd.bos.db.DBRoute;
import kd.bos.entity.MainEntityType;
import kd.bos.metadata.dao.MetaCategory;
import kd.bos.metadata.dao.MetadataDao;
import kd.bos.metadata.entity.EntityMetadata;
import kd.bos.orm.query.QCP;
import kd.bos.orm.query.QFilter;
import kd.bos.servicehelper.BusinessDataServiceHelper;
import kd.bos.servicehelper.QueryServiceHelper;
import kd.bos.servicehelper.operation.SaveServiceHelper;
import kd.bos.workflow.api.AgentExecution;
import kd.bos.workflow.api.AgentTask;
import kd.bos.workflow.api.WorkflowElement;
import kd.bos.workflow.api.constants.WFTaskResultEnum;
import kd.bos.workflow.bpmn.model.ActivitiListener;
import kd.bos.workflow.bpmn.model.BpmnModel;
import kd.bos.workflow.bpmn.model.DecisionOption;
import kd.bos.workflow.bpmn.model.FieldExtension;
import kd.bos.workflow.bpmn.model.FlowElement;
import kd.bos.workflow.bpmn.model.UserTask;
import kd.bos.workflow.engine.ProcessEngines;
import kd.bos.workflow.engine.RepositoryService;
import kd.bos.workflow.engine.dynprocess.CustomizedAuditResult;
import kd.bos.workflow.engine.dynprocess.JointAuditInfo;
import kd.bos.workflow.engine.dynprocess.JointResultInfo;
import kd.bos.workflow.engine.extitf.IWorkflowPlugin;

/**
 * 直接调一个工作流插件的方法（S41，`run wf`），不真跑流程：按已发布的流程定义拼出插件拿到的流程上下文，
 * 调一次，断言方法返回值和插件跑完之后库里的单据。
 *
 * <pre>
 * WF_CLASS    插件全类名（run wf 按源码认好填进来，必填）
 * WF_METHOD   要调的方法（可选）：notify、notifyByWithdraw、calcUserIds、filterParticipant、hasTrueCondition、
 *             getExpireTime、getJointAuditResult；不给就按它在流程里挂的位置定
 * WF_PK       单据内码；写成 billno:编号 就按单据编号查（必填）
 * WF_ENTITY   单据标识（可选）；不给就用挂它的流程的单据
 * WF_NODE     节点编码或名称（可选）；挂了好几个节点时指定哪一个
 * WF_CTX      上下文，`;` 分隔：decision=决策项编码、message=审批意见、approvers=用户（id 或工号，逗号分隔）、
 *             starter=发起人、param.键=值（插件参数）、var.键=值（流程变量）、
 *             vote=用户:approve|reject[:决策项编码[:意见]]（会审投票，可重复）、pending=还没投的票数
 * WF_SET      先把单据改成这样并保存（真提交，只走保存），`;` 分隔（可选）
 * WF_EXPECT   断言，`;` 分隔：error= / error~=片段、result=值 / result.字段=值，其余是单据字段路径；键后加 ~ 是包含
 * WF_SHOW     单据字段路径，`;` 分隔：插件跑完后只打值、不断言
 * </pre>
 *
 * <p>几条规矩：
 * <ul>
 * <li><b>上下文是照引擎的样子拼的</b>（真机 2026-09-29 核过）：节点对象用平台自己的 {@code WorkflowElementImpl} 包已发布流程里的真节点，
 * 插件取到的节点名、编码和真跑时一样；审批意见（{@code auditMessage}）是多语言 JSON 文本
 * （{@code {"zh_TW":…,"GLang":…,"zh_CN":…}}，历史单据上旧版插件原样存下来的就是这个样子），审批记录表里存的是纯文字；
 * 决策项编码、名称、同意还是驳回从节点配置里取，写错了按输入不成立报（引擎会拒）。</li>
 * <li><b>真提交</b>：插件自己保存单据就真的保存了。断言读的是跑完之后从库里重新取的单据。</li>
 * <li>这次证明的是<b>插件在这个上下文里的行为</b>；引擎会不会在这个节点调它，看的是已发布的流程定义（输出第一段），流程没有真跑。
 * 插件读到的当前用户是 cosmic 调试进程的用户，不是审批人；审批人用 approvers 给，插件从上下文里取。</li>
 * <li>插件类、单据、节点、决策项对不上是<b>输入不成立</b>，不留记录（{@link ProbeAssert#inputInvalid}）。</li>
 * </ul>
 */
public class WfSim {

    private static final List<String> METHODS = Arrays.asList("notify", "notifyByWithdraw", "calcUserIds",
            "filterParticipant", "hasTrueCondition", "getExpireTime", "getJointAuditResult");
    private static final List<String> CTX_KEYS = Arrays.asList("decision", "message", "approvers", "starter", "vote",
            "pending");

    /** 插件在一个已发布流程里挂的一处。 */
    private static final class Binding {
        long defId;
        String key;
        String name;
        String entity;
        boolean enabled;
        FlowElement element;
        String where;
        String event;
        String operation;
        String method;
        Map<String, Object> params = new LinkedHashMap<String, Object>();

        String node() {
            return element == null ? "（流程级）" : element.getName() + "（" + element.getNumber() + "）";
        }
    }

    public static void run() throws Exception {
        String cls = env("WF_CLASS");
        String rawPk = env("WF_PK");
        String spec = env("WF_EXPECT");
        String show = env("WF_SHOW");
        String set = env("WF_SET");
        String nodeWant = env("WF_NODE");
        try {
            ExpectSpec.pairs(spec);
        } catch (IllegalArgumentException e) {
            ProbeAssert.inputInvalid("wf-expect", spec, e.getMessage());
            finish();
            return;
        }
        Map<String, String> ctx = new LinkedHashMap<String, String>();
        List<String> votes = new ArrayList<String>();
        String badCtx = parseCtx(env("WF_CTX"), ctx, votes);
        if (badCtx != null) {
            ProbeAssert.inputInvalid("wf-ctx", env("WF_CTX"), badCtx);
            finish();
            return;
        }

        Class<?> type = load(cls);
        if (type == null) {
            ProbeAssert.inputInvalid("wf-class", cls, "加载不到这个类：没编译，或者不在本工程");
            finish();
            return;
        }
        if (!IWorkflowPlugin.class.isAssignableFrom(type)) {
            ProbeAssert.inputInvalid("wf-class", cls, "它没实现 IWorkflowPlugin，不是工作流插件");
            finish();
            return;
        }

        List<Binding> all = bindings(cls);
        if (all.isEmpty()) {
            System.out.println("[PROBE] 已发布的流程里没有挂它");
        } else {
            System.out.println("[PROBE] 挂它的已发布流程（每个流程只看最新版）：");
            for (Binding b : all) {
                System.out.println("[PROBE]   " + b.key + " " + b.name + (b.enabled ? "" : "（已停用）") + "  单据 " + b.entity
                        + "  节点 " + b.node() + "  " + b.where);
            }
        }

        // ---- 单据 ----
        String entity = env("WF_ENTITY").isEmpty() ? "" : MetaResolve.entityNumber(env("WF_ENTITY"));
        Set<String> entities = new LinkedHashSet<String>();
        for (Binding b : all) {
            if (!b.entity.isEmpty()) {
                entities.add(b.entity);
            }
        }
        String pk = null;
        if (!entity.isEmpty()) {
            pk = pkIn(entity, rawPk);
            if (pk == null) {
                ProbeAssert.inputInvalid("wf-pk", entity + " " + rawPk, "单据 " + entity + " 里查不到这张单（pk 或编号写错，或者是别的单据的）");
                finish();
                return;
            }
        } else if (entities.isEmpty()) {
            ProbeAssert.inputInvalid("wf-entity", cls, "已发布的流程里没有挂它，认不出单据是哪种；写成 run wf <类名> <单据标识> --pk <单据内码>");
            finish();
            return;
        } else {
            List<String> hit = new ArrayList<String>();
            String hitPk = null;
            for (String one : entities) {
                String p = pkIn(one, rawPk);
                if (p != null) {
                    hit.add(one);
                    hitPk = p;
                }
            }
            if (hit.size() != 1) {
                ProbeAssert.inputInvalid("wf-pk", rawPk, hit.isEmpty()
                        ? "挂它的流程单据 " + entities + " 里都查不到这张单（pk 或编号写错，或者是别的单据的）"
                        : "这个编号在 " + hit + " 里都有，写成 run wf <类名> <单据标识> 指定是哪种单据");
                finish();
                return;
            }
            entity = hit.get(0);
            pk = hitPk;
        }
        Object pkValue = pk.matches("\\d+") ? (Object) Long.valueOf(pk) : pk;

        // ---- 节点 ----
        List<Binding> here = new ArrayList<Binding>();
        for (Binding b : all) {
            if (b.entity.equals(entity) && b.element != null) {
                here.add(b);
            }
        }
        Binding chosen = null;
        FlowElement element = null;
        if (!nodeWant.isEmpty()) {
            for (Binding b : here) {
                if (nodeWant.equals(b.element.getId()) || nodeWant.equals(b.element.getNumber())
                        || nodeWant.equals(b.element.getName())) {
                    chosen = b;
                    break;
                }
            }
            if (chosen == null && !here.isEmpty()) {
                List<String> names = new ArrayList<String>();
                for (Binding b : here) {
                    names.add(b.node());
                }
                ProbeAssert.inputInvalid("wf-node", nodeWant, "单据 " + entity + " 的流程里它挂在 " + names + "，--node 写其中一个的名称或编码");
                finish();
                return;
            }
        } else if (!here.isEmpty()) {
            chosen = here.get(0);
            if (here.size() > 1) {
                List<String> names = new ArrayList<String>();
                for (Binding b : here) {
                    names.add(b.node());
                }
                System.out.println("[PROBE] 它在单据 " + entity + " 的流程里挂了 " + here.size() + " 处 " + names
                        + "；这次按第一处跑，换节点加 --node <名称或编码>");
            }
        }
        if (chosen != null) {
            element = chosen.element;
        }

        // ---- 方法 ----
        String method = env("WF_METHOD");
        if (!method.isEmpty() && !METHODS.contains(method)) {
            ProbeAssert.inputInvalid("wf-method", method, "工作流插件能这样调的方法：" + METHODS);
            finish();
            return;
        }
        if (method.isEmpty() && chosen != null) {
            method = chosen.method;
        }
        if (method.isEmpty()) {
            List<String> declared = declared(type);
            if (declared.size() != 1) {
                ProbeAssert.inputInvalid("wf-method", cls, (chosen == null ? "单据 " + entity + " 的流程里没挂它" : "认不出挂的位置对应哪个方法")
                        + "，写成 run wf <类名>#<方法>；它自己实现的：" + (declared.isEmpty() ? "（没有）" : declared));
                finish();
                return;
            }
            method = declared.get(0);
        }

        // ---- 上下文 ----
        DynamicObject bill = BusinessDataServiceHelper.loadSingle(pkValue, entity);
        String decision = ctx.containsKey("decision") ? ctx.get("decision")
                : chosen != null && "complete".equals(chosen.event) && !empty(chosen.operation) ? chosen.operation
                : defaultDecision(element);
        DecisionOption option = null;
        if (element != null && element.getDecisionOptions() != null && !element.getDecisionOptions().isEmpty()) {
            List<String> codes = new ArrayList<String>();
            for (Object o : element.getDecisionOptions()) {
                DecisionOption d = (DecisionOption) o;
                codes.add(d.getNumber() + "=" + d.getName());
                if (d.getNumber().equals(decision)) {
                    option = d;
                }
            }
            if (option == null) {
                ProbeAssert.inputInvalid("wf-ctx", "decision=" + decision, "节点 " + chosen.node() + " 没有这个决策项，它配的是 " + codes);
                finish();
                return;
            }
        }
        if (chosen != null && "complete".equals(chosen.event) && !empty(chosen.operation) && !chosen.operation.equals(decision)) {
            System.out.println("[PROBE] ⚠ 流程里这个节点只在决策项 " + chosen.operation + " 时调它，这次给的是 " + decision
                    + "：真跑流程时引擎不会在这个决策项上调它");
        }
        String auditName = option == null ? decision : option.getName();
        String auditType = option == null ? (decision.toLowerCase().startsWith("reject") ? "reject" : "approve")
                : option.getAuditType();
        String message = ctx.containsKey("message") ? ctx.get("message") : auditName;
        List<Long> approvers;
        Long starter;
        try {
            approvers = users(ctx.containsKey("approvers") ? ctx.get("approvers") : "");
            List<Long> s = users(ctx.containsKey("starter") ? ctx.get("starter") : "");
            starter = s.isEmpty() ? creatorOf(bill) : s.get(0);
            for (String v : votes) {
                users(v.split(":", 2)[0]);
            }
        } catch (IllegalArgumentException e) {
            ProbeAssert.inputInvalid("wf-ctx", env("WF_CTX"), e.getMessage());
            finish();
            return;
        }
        if (approvers.isEmpty()) {
            approvers.add(RequestContext.get().getCurrUserId());
        }
        Map<String, Object> variables = new LinkedHashMap<String, Object>();
        variables.put(WFTaskResultEnum.auditNumber.name(), decision);
        variables.put(WFTaskResultEnum.auditName.name(), auditName);
        variables.put(WFTaskResultEnum.auditType.name(), auditType);
        variables.put(WFTaskResultEnum.auditMessage.name(), localeJson(message));
        Map<String, Object> params = new LinkedHashMap<String, Object>();
        if (chosen != null) {
            params.putAll(chosen.params);
        }
        for (Map.Entry<String, String> e : ctx.entrySet()) {
            if (e.getKey().startsWith("param.")) {
                params.put(e.getKey().substring(6), e.getValue());
            } else if (e.getKey().startsWith("var.")) {
                variables.put(e.getKey().substring(4), e.getValue());
            }
        }

        Execution exec = new Execution();
        exec.businessKey = String.valueOf(pk);
        exec.entityNumber = entity;
        exec.processDefinitionId = chosen == null ? null : chosen.defId;
        exec.variables = variables;
        exec.approvers = approvers;
        exec.starter = starter;
        exec.eventName = chosen == null ? "" : str(chosen.event);
        exec.plugin = cls;
        exec.params = params;
        exec.bill = bill;
        exec.element = element == null ? null : wrap(exec, element);
        if (exec.element == null && !nodeWant.isEmpty()) {
            exec.element = named(nodeWant);
        }
        Task task = new Task();
        task.exec = exec;
        task.nodeName = exec.element == null ? "" : str(exec.element.getName());
        task.nodeKey = exec.element == null ? "" : str(exec.element.getId());
        task.billNo = billNoOf(bill);
        exec.task = task;

        System.out.println("[PROBE] 调 " + type.getSimpleName() + "#" + method + "  单据 " + entity + " pk=" + pk
                + (task.billNo.isEmpty() ? "" : " 编号 " + task.billNo));
        System.out.println("[PROBE] 上下文：节点 " + (exec.element == null ? "（没有）" : exec.element.getName() + "（" + exec.element.getNumber() + "）")
                + "；事件 " + (exec.eventName.isEmpty() ? "（没有）" : exec.eventName)
                + "；决策项 " + decision + "（" + auditName + "，" + auditType + "）；审批意见 " + message
                + "；当前审批人 " + approvers + "；发起人 " + starter
                + (params.isEmpty() ? "" : "；插件参数 " + params));
        System.out.println("[PROBE] 流程没有真跑：引擎会不会在这里调它看上面挂的位置；插件里取当前用户拿到的是调试进程的用户 "
                + RequestContext.get().getCurrUserId());

        // ---- 先改单据 ----
        if (!set.isEmpty()) {
            MainEntityType met = MetaResolve.type(entity);
            List<String[]> wrong = OpSandbox.wrongPaths(met, set);
            for (String[] w : wrong) {
                ProbeAssert.inputInvalid("wf-set", w[0], "单据 " + entity + " " + w[1]);
            }
            if (!wrong.isEmpty()) {
                finish();
                return;
            }
            EntityMetadata em = (EntityMetadata) MetadataDao.readMeta(
                    MetadataDao.getIdByNumber(entity, MetaCategory.Entity), MetaCategory.Entity);
            IsvGuard.assertOwnEntity(entity, em);
            List<String> unresolved = OpSandbox.applySets(met, bill, set);
            if (!unresolved.isEmpty()) {
                for (String path : unresolved) {
                    ProbeAssert.inputInvalid("wf-set", path, "基础资料没物化，插件读到的会是空");
                }
                finish();
                return;
            }
            SaveServiceHelper.save(new DynamicObject[]{bill});
            MetaResolve.reportCommitted(entity, pk, "改过", Boolean.TRUE);
            bill = BusinessDataServiceHelper.loadSingle(pkValue, entity);
            exec.bill = bill;
        }
        Map<String, String> prior = ExpectSpec.priorValues(bill, spec, set);

        // ---- 调 ----
        Object plugin;
        try {
            plugin = type.newInstance();
        } catch (Throwable t) {
            ProbeAssert.inputInvalid("wf-class", cls, "建不出实例（要有无参构造器）：" + brief(t));
            finish();
            return;
        }
        Object ret = null;
        Throwable thrown = null;
        Class<?> returns = void.class;
        System.out.println("[PROBE] --- 调插件（真提交：插件保存单据就真的保存）---");
        long started = System.currentTimeMillis();
        try {
            Invocation call = invocation(type, method, exec, approvers, votes, ctx, bill);
            returns = call.method.getReturnType();
            if (call.note != null) {
                System.out.println("[PROBE] " + call.note);
            }
            ret = call.method.invoke(plugin, call.args);
        } catch (InvocationTargetException e) {
            thrown = e.getCause() == null ? e : e.getCause();
        } catch (Throwable t) {
            thrown = t;
        }
        System.out.println("[PROBE] 耗时 " + (System.currentTimeMillis() - started) + "ms  "
                + (thrown != null ? "插件抛了异常：" + brief(thrown) : returns == void.class ? "没抛异常" : "返回 " + describe(ret)));

        Map<String, String> results = results(ret, returns);
        DynamicObject after = BusinessDataServiceHelper.loadSingle(pkValue, entity);
        show(after, show);
        ExpectSpec.workflow(thrown, results, after, spec);
        ExpectSpec.notePrior(prior, after, spec);
        finish();
    }

    // ---------------- 流程里挂在哪 ----------------

    /** 内容里提到这个类的最新版流程定义，逐个读出挂它的节点和时机。 */
    private static List<Binding> bindings(String cls) {
        final Set<Long> ids = new LinkedHashSet<Long>();
        DB.query(DBRoute.of("wfs"), "select p.fid from t_wf_procdef p join t_wf_gebytearray b"
                + " on p.fdeploymentid = b.fdeploymentid where b.fcontent like ?", new Object[]{"%" + cls + "%"},
                (ResultSet rs) -> {
                    while (rs.next()) {
                        ids.add(rs.getLong(1));
                    }
                    return null;
                });
        List<Binding> out = new ArrayList<Binding>();
        if (ids.isEmpty()) {
            return out;
        }
        DynamicObjectCollection defs = QueryServiceHelper.query("wf_processdefinition", "id,key,name,entrabill,enable",
                new QFilter[]{new QFilter("id", QCP.in, new ArrayList<Long>(ids)),
                        new QFilter("versionstate", QCP.equals, "newest")});
        RepositoryService repo = ProcessEngines.getDefaultProcessEngine().getRepositoryService();
        for (DynamicObject def : defs) {
            List<Binding> found = new ArrayList<Binding>();
            BpmnModel model = null;
            try {
                model = repo.getBpmnModel(def.getLong("id"), null);
            } catch (Throwable t) {
                System.out.println("[PROBE] ⚠ 读流程 " + def.getString("key") + " 出错：" + brief(t));
            }
            if (model != null && model.getMainProcess() != null) {
                for (ActivitiListener l : model.getMainProcess().getExecutionListeners()) {
                    if (mentions(l, cls)) {
                        found.add(listener(def, null, l, "流程级"));
                    }
                }
                for (FlowElement e : model.getMainProcess().getFlowElements()) {
                    for (ActivitiListener l : e.getExecutionListeners()) {
                        if (mentions(l, cls)) {
                            found.add(listener(def, e, l, "exec"));
                        }
                    }
                    if (e instanceof UserTask) {
                        UserTask u = (UserTask) e;
                        if (u.getTaskListeners() != null) {
                            for (ActivitiListener l : u.getTaskListeners()) {
                                if (mentions(l, cls)) {
                                    found.add(listener(def, e, l, "task"));
                                }
                            }
                        }
                        if (u.getExpireModel() != null && str(u.getExpireModel().getExpireTime()).contains(cls)) {
                            Binding b = binding(def, e);
                            b.where = "算超时（getExpireTime）";
                            b.method = "getExpireTime";
                            found.add(b);
                        }
                        if (u.getParticipant() != null && str(u.getParticipant()).contains(cls)) {
                            Binding b = binding(def, e);
                            b.where = "算参与人（calcUserIds）";
                            b.method = "calcUserIds";
                            found.add(b);
                        }
                    }
                }
            }
            if (found.isEmpty()) {
                Binding b = binding(def, null);
                b.where = "流程定义里提到它，没认出挂在哪个节点、什么时机";
                b.method = "";
                found.add(b);
            }
            out.addAll(found);
        }
        return out;
    }

    private static Binding binding(DynamicObject def, FlowElement e) {
        Binding b = new Binding();
        b.defId = def.getLong("id");
        b.key = def.getString("key");
        b.name = def.getString("name");
        b.entity = str(def.getString("entrabill"));
        b.enabled = "enable".equals(def.getString("enable"));
        b.element = e;
        return b;
    }

    private static Binding listener(DynamicObject def, FlowElement e, ActivitiListener l, String kind) {
        Binding b = binding(def, e);
        b.event = str(l.getEvent());
        b.operation = str(l.getOperation());
        b.method = "notify";
        String when = "task".equals(kind)
                ? ("complete".equals(b.event) ? "审批人提交决策项 " + b.operation + " 时" : "任务 " + b.event + " 时")
                : "start".equals(b.event) ? "进入节点时" : "end".equals(b.event) ? "离开节点时" : "执行 " + b.event + " 时";
        b.where = ("流程级".equals(kind) ? "流程级，" : "") + when + "（notify）";
        if (l.getFieldExtensions() != null) {
            for (FieldExtension f : l.getFieldExtensions()) {
                b.params.put(f.getFieldName(), f.getStringValue() != null ? f.getStringValue() : f.getExpression());
            }
        }
        return b;
    }

    private static boolean mentions(ActivitiListener l, String cls) {
        return str(l.getImplementation()).contains(cls);
    }

    private static String defaultDecision(FlowElement e) {
        if (e != null && e.getDecisionOptions() != null) {
            for (Object o : e.getDecisionOptions()) {
                DecisionOption d = (DecisionOption) o;
                if (d.isDefaultDecision()) {
                    return d.getNumber();
                }
            }
            if (!e.getDecisionOptions().isEmpty()) {
                return ((DecisionOption) e.getDecisionOptions().get(0)).getNumber();
            }
        }
        return "Consent";
    }

    /** 本类自己实现（不是接口默认）的工作流方法。 */
    private static List<String> declared(Class<?> type) {
        Set<String> out = new LinkedHashSet<String>();
        for (Class<?> c = type; c != null && c != Object.class; c = c.getSuperclass()) {
            for (Method m : c.getDeclaredMethods()) {
                if (METHODS.contains(m.getName()) && !m.isSynthetic() && !Modifier.isStatic(m.getModifiers())) {
                    out.add(m.getName());
                }
            }
        }
        return new ArrayList<String>(out);
    }

    // ---------------- 怎么调 ----------------

    private static final class Invocation {
        Method method;
        Object[] args;
        String note;
    }

    private static Invocation invocation(Class<?> type, String name, Execution exec, List<Long> approvers,
            List<String> votes, Map<String, String> ctx, DynamicObject bill) throws Exception {
        Invocation call = new Invocation();
        if ("calcUserIds".equals(name)) {
            if (declares(type, name, AgentExecution.class, DynamicObject.class, DynamicObject.class)) {
                call.method = type.getMethod(name, AgentExecution.class, DynamicObject.class, DynamicObject.class);
                call.args = new Object[]{exec, null, bill};
                call.note = "calcUserIds 的参与人配置行（pme）给的是 null";
            } else {
                call.method = type.getMethod(name, AgentExecution.class);
                call.args = new Object[]{exec};
            }
        } else if ("filterParticipant".equals(name)) {
            call.method = type.getMethod(name, AgentExecution.class, List.class);
            call.args = new Object[]{exec, new ArrayList<Long>(approvers)};
            call.note = "filterParticipant 收到的参与人就是 approvers：" + approvers;
        } else if ("getJointAuditResult".equals(name)) {
            List<JointAuditInfo> infos = new ArrayList<JointAuditInfo>();
            for (String v : votes) {
                String[] p = v.split(":", 4);
                Long user = users(p[0]).get(0);
                infos.add(new JointAuditInfo(user, p.length > 2 ? p[2] : "", p[1], p.length > 3 ? p[3] : ""));
            }
            int pending = ctx.containsKey("pending") ? Integer.parseInt(ctx.get("pending")) : 0;
            call.method = type.getMethod(name, AgentExecution.class, JointResultInfo.class);
            call.args = new Object[]{exec, new JointResultInfo(infos.size() + pending, infos.size(), pending, infos)};
            StringBuilder sb = new StringBuilder();
            for (JointAuditInfo i : infos) {
                sb.append(sb.length() == 0 ? "" : "，").append(i.getUserId()).append(" ").append(i.getDesicisionType())
                        .append(empty(i.getResultNumber()) ? "" : " " + i.getResultNumber());
            }
            call.note = "会审投票 " + infos.size() + " 张（" + (sb.length() == 0 ? "没有" : sb) + "），还没投 " + pending + " 张";
        } else {
            call.method = type.getMethod(name, AgentExecution.class);
            call.args = new Object[]{exec};
        }
        return call;
    }

    private static boolean declares(Class<?> type, String name, Class<?>... params) {
        for (Class<?> c = type; c != null && c != Object.class; c = c.getSuperclass()) {
            try {
                c.getDeclaredMethod(name, params);
                return true;
            } catch (NoSuchMethodException ignored) {
                // 看父类
            }
        }
        return false;
    }

    /** 返回值拆成能断言的名字 → 文字。 */
    private static Map<String, String> results(Object ret, Class<?> returns) {
        Map<String, String> out = new LinkedHashMap<String, String>();
        if (returns == void.class) {
            return out;
        }
        if (ret instanceof CustomizedAuditResult) {
            CustomizedAuditResult r = (CustomizedAuditResult) ret;
            out.put("result", describe(r));
            out.put("result.pass", String.valueOf(r.isPass()));
            out.put("result.over", String.valueOf(r.isOver()));
            out.put("result.resultNumber", str(r.getResultNumber()));
            return out;
        }
        if (ret instanceof Collection) {
            out.put("result", describe(ret));
            out.put("result.size", String.valueOf(((Collection<?>) ret).size()));
            return out;
        }
        out.put("result", ret == null ? "null" : String.valueOf(ret));
        return out;
    }

    private static String describe(Object ret) {
        if (ret instanceof CustomizedAuditResult) {
            CustomizedAuditResult r = (CustomizedAuditResult) ret;
            return "pass=" + r.isPass() + " over=" + r.isOver() + " resultNumber=" + r.getResultNumber();
        }
        if (ret instanceof Collection) {
            StringBuilder sb = new StringBuilder();
            for (Object o : (Collection<?>) ret) {
                sb.append(sb.length() == 0 ? "" : ",").append(o);
            }
            return sb.toString();
        }
        return String.valueOf(ret);
    }

    // ---------------- 上下文 ----------------

    /** 拼出来的流程执行上下文。字段对照平台的 AgentExecutionImpl。 */
    private static final class Execution implements AgentExecution {
        String businessKey;
        String entityNumber;
        Long processDefinitionId;
        Map<String, Object> variables;
        List<Long> approvers;
        Long starter;
        String eventName;
        String plugin;
        Map<String, Object> params;
        DynamicObject bill;
        WorkflowElement element;
        Task task;

        public String getBusinessKey() {
            return businessKey;
        }

        public String getEntityNumber() {
            return entityNumber;
        }

        public Long getCurrentTaskId() {
            return null;
        }

        public AgentTask getCurrentTask() {
            return task;
        }

        public Long getProcessDefinitionId() {
            return processDefinitionId;
        }

        public Long getProcessInstanceId() {
            return null;
        }

        public WorkflowElement getCurrentFlowElement() {
            return element;
        }

        public Object getVariable(String name) {
            return variables.get(name);
        }

        public void setVariable(String name, Object value) {
            variables.put(name, value);
        }

        public Object getCurrentTaskResult(WFTaskResultEnum key) {
            return variables.get(key.name());
        }

        public List<Long> getCurrentApprover() {
            return new ArrayList<Long>(approvers);
        }

        public List<Long> getAllApprover() {
            return new ArrayList<Long>(approvers);
        }

        public Long getStartUserId() {
            return starter;
        }

        public String getEventName() {
            return eventName;
        }

        public String getCurrentWFPlugin() {
            return plugin;
        }

        public DynamicObject getTransientBill() {
            return bill;
        }

        public Map<String, Object> getCurrentWFPluginParams() {
            return params;
        }
    }

    private static final class Task implements AgentTask {
        Execution exec;
        String nodeName;
        String nodeKey;
        String billNo;

        public Long getId() {
            return null;
        }

        public ILocaleString getName() {
            return new LocaleString(nodeName);
        }

        public ILocaleString getDescription() {
            return new LocaleString("");
        }

        public Long getProcessInstanceId() {
            return null;
        }

        public Long getProcessDefinitionId() {
            return exec.processDefinitionId;
        }

        public String getTaskDefinitionKey() {
            return nodeKey;
        }

        public AgentExecution getExecution() {
            return exec;
        }

        public Long getOwnerId() {
            return exec.approvers.isEmpty() ? null : exec.approvers.get(0);
        }

        public Long getAssigneeId() {
            return getOwnerId();
        }

        public Set<Long> getParticipants() {
            return new LinkedHashSet<Long>(exec.approvers);
        }

        public String getEventName() {
            return exec.eventName;
        }

        public String getCurrentWFPlugin() {
            return exec.plugin;
        }

        public ILocaleString getEntityName() {
            return new LocaleString(exec.entityNumber);
        }

        public ILocaleString getSubject() {
            return new LocaleString(billNo);
        }

        public ILocaleString getStartName() {
            return new LocaleString(String.valueOf(exec.starter));
        }

        public String getEntityNumber() {
            return exec.entityNumber;
        }

        public String getBusinessKey() {
            return exec.businessKey;
        }

        public ILocaleString getSenderName() {
            return new LocaleString("");
        }

        public String getHandleState() {
            return "";
        }

        public String getBillNo() {
            return billNo;
        }

        public Long getStarterId() {
            return exec.starter;
        }

        public Object getVariable(String name) {
            return exec.variables.get(name);
        }

        public Map<String, Object> getCurrentWFPluginParams() {
            return exec.params;
        }
    }

    /** 用平台自己的 WorkflowElementImpl 包真节点：插件拿到的对象和引擎给的同一个类型。包不了就给节点本身。 */
    private static WorkflowElement wrap(Execution exec, FlowElement element) {
        exec.element = element;
        try {
            Class<?> impl = Class.forName("kd.bos.workflow.engine.impl.WorkflowElementImpl");
            return (WorkflowElement) impl.getConstructor(AgentExecution.class).newInstance(exec);
        } catch (Throwable t) {
            System.out.println("[PROBE] ⚠ 没能用平台的 WorkflowElementImpl 包节点（" + brief(t) + "），插件拿到的是流程定义里的节点本身");
            return element;
        }
    }

    /** 流程里没挂它、又给了 --node 时，按名字造一个节点。 */
    private static WorkflowElement named(final String name) {
        return (WorkflowElement) java.lang.reflect.Proxy.newProxyInstance(WfSim.class.getClassLoader(),
                new Class<?>[]{WorkflowElement.class}, (proxy, m, args) -> {
                    String n = m.getName();
                    if ("getId".equals(n) || "getNumber".equals(n) || "getName".equals(n)) {
                        return name;
                    }
                    if ("getDecisionOptions".equals(n)) {
                        return new ArrayList<Object>();
                    }
                    if ("toString".equals(n)) {
                        return name;
                    }
                    if ("hashCode".equals(n)) {
                        return name.hashCode();
                    }
                    if ("equals".equals(n)) {
                        return proxy == args[0];
                    }
                    return null;
                });
    }

    /** 审批意见在流程变量里是多语言 JSON 文本；历史单据上旧版插件原样存下来的就是这三个键。 */
    private static String localeJson(String text) {
        String q = "\"" + text.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
        return "{\"zh_TW\":" + q + ",\"GLang\":" + q + ",\"zh_CN\":" + q + "}";
    }

    private static String parseCtx(String spec, Map<String, String> ctx, List<String> votes) {
        for (String one : spec.split(";")) {
            String s = one.trim();
            if (s.isEmpty()) {
                continue;
            }
            int eq = s.indexOf('=');
            if (eq <= 0) {
                return "--ctx 写成 键=值：" + s;
            }
            String key = s.substring(0, eq).trim();
            String value = s.substring(eq + 1).trim();
            if (!CTX_KEYS.contains(key) && !key.startsWith("param.") && !key.startsWith("var.")) {
                return "--ctx 不认识 " + key + "；认的键：" + CTX_KEYS + "、param.键、var.键";
            }
            if ("vote".equals(key)) {
                String[] p = value.split(":", 4);
                if (p.length < 2 || !("approve".equals(p[1]) || "reject".equals(p[1]))) {
                    return "vote 写成 用户:approve|reject[:决策项编码[:意见]]，收到 " + value;
                }
                votes.add(value);
                continue;
            }
            if ("pending".equals(key) && !value.matches("\\d{1,4}")) {
                return "pending 写还没投的票数，收到 " + value;
            }
            ctx.put(key, value);
        }
        return null;
    }

    /** 逗号分隔的用户：一串数字当 id，别的按工号、再按姓名查（查到多个算写错）。 */
    private static List<Long> users(String spec) {
        List<Long> out = new ArrayList<Long>();
        for (String one : spec.split(",")) {
            String u = one.trim();
            if (u.isEmpty()) {
                continue;
            }
            if (u.matches("\\d{10,}")) {
                out.add(Long.valueOf(u));
                continue;
            }
            DynamicObjectCollection rows = QueryServiceHelper.query("bos_user", "id",
                    new QFilter[]{new QFilter("number", QCP.equals, u)});
            if (rows.isEmpty()) {
                rows = QueryServiceHelper.query("bos_user", "id", new QFilter[]{new QFilter("name", QCP.equals, u)});
            }
            if (rows.size() != 1) {
                throw new IllegalArgumentException("用户 " + u + (rows.isEmpty() ? " 查不到（写 id、工号或姓名）" : " 对上了 " + rows.size() + " 个人，写 id"));
            }
            out.add(rows.get(0).getLong("id"));
        }
        return out;
    }

    private static Long creatorOf(DynamicObject bill) {
        try {
            Object c = bill.get("creator");
            if (c instanceof DynamicObject) {
                return (Long) ((DynamicObject) c).getPkValue();
            }
        } catch (Throwable ignored) {
            // 没有创建人字段
        }
        return RequestContext.get().getCurrUserId();
    }

    private static String billNoOf(DynamicObject bill) {
        for (String f : new String[]{"billno", "number"}) {
            try {
                if (bill.getDataEntityType().getProperties().containsKey(f)) {
                    return str(bill.getString(f));
                }
            } catch (Throwable ignored) {
                // 下一个
            }
        }
        return "";
    }

    /** 这张单在这种单据里的 pk；查不到返回 null。 */
    private static String pkIn(String entity, String raw) {
        String pk;
        try {
            pk = MetaResolve.pkOf(entity, raw);
        } catch (IllegalArgumentException e) {
            return null;
        }
        if (pk == null || !pk.matches("\\d+")) {
            return null;
        }
        return QueryServiceHelper.exists(entity, new QFilter[]{new QFilter("id", QCP.equals, Long.valueOf(pk))}) ? pk : null;
    }

    /** --show：`分录.字段` 不写行号时逐行打（插件新加的行排在哪一行，看了才知道）。 */
    private static void show(DynamicObject bill, String spec) {
        for (String one : spec.split(";")) {
            String path = one.trim();
            if (path.isEmpty()) {
                continue;
            }
            int dot = path.indexOf('.');
            if (dot > 0 && path.indexOf('[') < 0 && path.indexOf('.', dot + 1) < 0) {
                String entry = path.substring(0, dot);
                DynamicObjectCollection rows = null;
                try {
                    rows = bill.getDynamicObjectCollection(entry);
                } catch (Throwable ignored) {
                    // 不是分录，按普通路径打
                }
                if (rows != null) {
                    System.out.println("[PROBE]   " + entry + " 共 " + rows.size() + " 行");
                    for (int i = 0; i < rows.size(); i++) {
                        String value;
                        try {
                            value = ProbeAssert.shown(ExpectSpec.render(rows.get(i).get(path.substring(dot + 1))));
                        } catch (Throwable t) {
                            value = "(取不到：" + brief(t) + ")";
                        }
                        System.out.println("[PROBE]   " + entry + "[" + i + "]." + path.substring(dot + 1) + " = " + value);
                    }
                    continue;
                }
            }
            String value;
            try {
                value = ExpectSpec.showValue(bill, ExpectSpec.Pos.parse(path));
            } catch (Throwable t) {
                value = "(取不到：" + brief(t) + ")";
            }
            System.out.println("[PROBE]   " + path + " = " + value);
        }
    }

    private static Class<?> load(String cls) {
        ClassLoader[] loaders = {Thread.currentThread().getContextClassLoader(), WfSim.class.getClassLoader()};
        for (ClassLoader loader : loaders) {
            if (loader == null) {
                continue;
            }
            try {
                return Class.forName(cls, true, loader);
            } catch (ClassNotFoundException ignored) {
                // 下一个
            } catch (LinkageError e) {
                System.out.println("[PROBE] ⚠ 加载 " + cls + " 出错：" + e);
            }
        }
        return null;
    }

    private static String brief(Throwable t) {
        Throwable root = t;
        while (root.getCause() != null && root.getCause() != root) {
            root = root.getCause();
        }
        return root.getClass().getSimpleName() + ": " + HeadlessUiSupport.oneLine(root.getMessage());
    }

    private static boolean empty(String s) {
        return s == null || s.trim().isEmpty();
    }

    private static String str(Object o) {
        return o == null ? "" : String.valueOf(o);
    }

    private static void finish() {
        if (!ProbeAssert.summary()) {
            throw new ProbeAssert.Failed("断言失败");
        }
    }

    private static String env(String key) {
        String value = System.getenv(key);
        return value == null ? "" : value.trim();
    }
}
