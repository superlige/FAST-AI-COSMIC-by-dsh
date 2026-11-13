---
class: C
when: 流程状态、当前审批人、最后审批人；代码里提交、审批、撤回、终止流程：WorkflowServiceHelper 实测
---

# 审批流：查流程状态与 WorkflowServiceHelper

来源：真实苍穹 8.0 二开工程实测（查询三类样本：正在审批、审批完、没进流程；写操作见最后一节）。
工作流插件的扩展点见 [plugin-integration.md](plugin-integration.md#工作流插件)；流程模型导出见 [meta-cmd.md](meta-cmd.md)；
方法的完整清单读官方 `platform/api/servicehelper/workflow/WorkflowServiceHelper.md`，当前 JAR 上的真签名用 `cosmic_knowledge action=api` 查。

- [先分清要干什么](#先分清要干什么)
- [查流程表](#查流程表dataqueryprobe)
- [WorkflowServiceHelper 查询方法实测](#workflowservicehelper-查询方法实测)
- [最后审批人怎么取](#最后审批人怎么取)
- [写操作](#写操作提交撤销审批终止)

## 先分清要干什么

| 要干什么 | 用什么 |
|---|---|
| 排查、找样本：某张单在不在流程、哪个节点、谁在审（带电话）、能否撤回、上次谁处理的 | `DataQueryProbe` 的 `@流程` 列，也能当条件挑单，不用写临时探针 |
| 交付的代码要按流程状态分支 | 代码里调 `WorkflowServiceHelper`；各方法返回什么见下文，写完用 `cosmic_run call` 带断言跑 |

`businessKey` 就是单据主键 id 的字符串形式。

## 查流程表（DataQueryProbe）

| 表 | 是什么 | 常用字段 |
|---|---|---|
| `wf_execution` | 流程实例（只含还没结束的） | `businesskey`、`activityname` 当前节点、`currenttaskid`、`suspensionstate`（1 正在运行，2 挂起）、`entitynumber` |
| `wf_task` | 待办任务（只含没处理完的） | `businesskey`、`name` 节点名、`taskstate`（`willApproval` 待审批、`dismissed` 被驳回……）、`participantname` 当前参与人（文本）、`billno`、`entitynumber`、`processinstanceid` |
| `wf_participant` | 任务参与人 | `taskid`、`userid`、`username` |
| `wf_hicomment` | 审批记录（处理过的每一步） | `businesskey`、`entitynumber`、`activityname`、`userid`、`decisiontype`（`approve` 同意、`reject` 驳回，提交为空）、`resultnumber` 决策项编码、`resultname`、`handlestate`、`time` |
| `wf_processdefinition` | 流程定义 | `entrabill` 挂靠单据、`key`、`versionstate`（`newest` 最新版）、`enable`、`type`（`AuditFlow` 审批流） |
| `bos_user` | 人员 | `name`、`number`、`phone` |

历史表：`wf_hiprocinst`（历史流程，按 `businesskey` 查，一次提交一行，`name` 里带流程标识和版本）、`wf_hitaskinst`（历史任务）、
`wf_hiparticipant`（历史参与人），字段用 `MetaProbe` 看。

**`userid` 是普通整数列，不是基础资料**，写不了 `userid.phone`，要拿到 id 再查一次 `bos_user`。

在不在流程、当前节点、待办人和电话、能否撤回、不在流程时上次谁处理的，`@流程` 一列给全，也能当条件挑单：

```text
cosmic_probe name=DataQueryProbe env={QUERY_ENTITY: demo_bill, QUERY_WHERE: "billstatus = B; @流程 like %部门审批%", QUERY_FIELDS: "billno,@流程"}
#1  billno=DEMO-001 | @流程=审批中：节点 部门审批；待办 张三(138…)、李四(139…)；可撤回
#2  billno=DEMO-002 | @流程=发起中：发起审批流的任务 … 还没处理完（created，10:15:02 建）；平台已按在流程中处理，审核、撤销会被拒
```

"在不在流程"和审核、撤销前的校验是同一个判断，所以有"发起中"这一种：提交建的发起任务还没处理完，流程表里还没有这张单，
平台已经按在流程中拦审核、撤销（报"单据已在流程中流转"）。任务处理完才知道进没进审批流（见下面"写操作"一节）。

完整的审批记录（每一步谁、什么决策项）再按 `businesskey` 查 `wf_hicomment`；这张单据有没有启用的审批流查
`wf_processdefinition`（`entrabill = <单据标识>; versionstate = newest`）。

审批完的单在 `wf_execution`、`wf_task` 里都查不到了，只剩 `wf_hicomment` 和历史表里的记录。

## WorkflowServiceHelper 查询方法实测

`import kd.bos.servicehelper.workflow.WorkflowServiceHelper;`，都是静态方法。

| 方法 | 正在审批 | 审批完 | 没进流程 | 要注意 |
|---|---|---|---|---|
| `inProcess(String id)` → `boolean` | true | **false** | false | 进程里第一次调约 6 秒，之后约 0.1 秒。**不看写在单据库里、还没处理完的发起任务**：提交后到任务处理完之前它是 false，审核却已被拒。要和审核、撤销前的判断一致，用 `getInProcessDataEntity(ExtendedDataEntity[])`（返回平台判在流程中的那几个） |
| `getBizProcessStatus(String[] ids)` → `Map<String, List<BizProcessStatus>>` | 有这个 id 的项 | **map 里没有这个 id** | 同左 | 取值先判 `get(id) == null`。项里有 `getCurrentNodeName()`、`getParticipantName()`（"姓名(工号),姓名" 拼好的文本）、`getProcessStatus()` "1"、`getProcessStatusName()` "正在运行"；`getProcessInstanceId()` 是 null |
| `getProcessInstanceIdByBusinessKey(String id)` → `Long` | 实例 id | **仍有实例 id** | null | 不能拿"有实例 id"判断在流程里 |
| `getApproverByBusinessKey(String id)` → `List<Long>` | 当前审批人的用户 id | 空列表 | 空列表 | 名字、电话再查 `bos_user` |
| `getApproversMapByBusinessKeys(String[] ids)` → `Map<String, List<Long>>` | 有项 | 空 map | 空 map | 批量版 |
| `getTaskIdByBusinessKeyAndUserId(String id, Long userId)` → `Long` | 当前任务 id | — | — | 审批人 id 从上一行拿 |
| `getApprovalRecords(String entity, String id, boolean allRecord)` → `List<IApprovalRecordGroup>` | 含待审节点 | 含全部实例 | 空列表 | 见下方"三个审批记录方法" |
| `getAllApprovalRecord(String id)` → `List<IApprovalRecordGroup>` | 同上 | **只含最近一次流程** | 空列表 | 同上 |
| `batchGetApprovalRecordByBusinessKey(List<String> ids)` → `Map<String, List<IApprovalRecord>>` | 只有人处理过的 | 全部实例里人处理过的 | **整个返回 null** | 同上 |
| `existProcDefByEntityNumber(String entity)` → `Boolean` | — | — | — | 实体有没有建过流程 |
| `getEnabledProcDefByEntityNumber(String entity)` → `List<Map<String,Object>>` | — | — | — | 每项有 `key`、`entrabill`、`versionstate`、`enable`、`type` 等 |

**三个审批记录方法，返回的内容不一样**（同一张"终止过一次、重新提交后审批完成"的单）：

| 方法 | 返回了什么 | 用时 |
|---|---|---|
| `getApprovalRecords(entity, id, true/false)` | 两次流程的全部记录：提交、同意、"审批终止"、再提交、同意、"审批完成"；在审的单最后一组是待审节点。本环境 `allRecord` 传 true、false 结果一样 | 1～14 秒 |
| `getAllApprovalRecord(id)` | 只有最近那次流程：提交、同意、"审批完成" | 约 2 秒 |
| `batchGetApprovalRecordByBusinessKey(ids)` | 两次流程里人处理过的 4 条（没有"审批终止/完成"，没有待审节点），**不按时间排**（先列提交、再列同意） | 约 0.05 秒 |

分组和条目的取值：

- `IApprovalRecordGroup.getGroupDecisionType()`：`submit`、`approve`、`wait`（待审）、`terminated`、`completed`；`getChildren()` 是条目。
- `IApprovalRecordItem`：`getActivityName()`（**末尾可能带空格**，比较前 `trim()`）、`getUserId()`（系统条目"审批终止/完成"为 null）、
  `getAssignee()`（"姓名|岗位"）、`getDecisionType()`（提交为空串）、`getResult()`（前面带空格）、`getTime()`（`yyyy-MM-dd HH:mm:ss`）、`getHandleState()`。
- `IApprovalRecord`（批量版的条目）：`getActivityName()`（不带空格）、`getUserId()`、`getAssignee()`（只有姓名）、`getDecisionType()`、
  `getResultNumber()`（提交 `submit`、同意 `Consent`）、`getTime()`（带 `.0`）、`getType()` `comment`。

**这几个在本环境用不了或有坑：**

| 方法 | 实际情况 | 改用 |
|---|---|---|
| `getLastNodesComment(id)` | 有人审过的在审单抛 `ORMDesignException`（`wf_hicomment` 中不存在 `modifyDate`）；其他情况返回空列表 | 审批记录方法，或查 `wf_hicomment` |
| `getActInstInfo(id, actIds, onlyCompleted)` | `actIds` 传空列表就抛"actIds is null" | 先想清楚要哪几个节点 id |
| `findTaskById(taskId)` | 传有效的待办任务 id 也抛 `NullPointerException` | 查 `wf_task`，或 `getTaskIdByBusinessKeyAndUserId` |
| `getNextUserTaskNodeByBusinessKey(id)` | 返回整个下一节点的模型对象，整个打印出来超过 1 MB | 只取需要的字段 |
| `getCommentsByTaskId(taskId)` | 还没处理的任务返回 0 行 | — |

## 最后审批人怎么取

单据上的审核人字段不等于流程里最后同意的人：不走流程直接审核的单也有审核人，却没有任何审批记录；
自定义的"审核人"字段也可能和流程记录不一致。按流程记录取：

- 代码里：`getAllApprovalRecord(id)` 从后往前找第一条 `getDecisionType()` 为 `approve` 的条目，取 `getUserId()`；
  要跨多次流程，用 `batchGetApprovalRecordByBusinessKey` 后**自己按 `getTime()` 排序**再找。
- 排查时：查 `wf_hicomment`，`decisiontype = approve`，`time desc` 取第一条。

## 写操作：提交、撤销、审批、终止

实测样本：一个审批节点、两个审批人的审批流。

**发起和流转都是交给调度服务的后台任务。** 提交时平台把一条"发起审批流"的任务写进单据自己那个库（和单据同一个事务），
交给调度派走；任务处理时才按流程的发起条件决定进不进审批流，处理完删掉这条任务。任务没处理完之前，这张单算在流程中：
审核、撤销被"单据已在流程中流转"拒。

- 带 `--schedule`：本机起调度，任务一般 1～3 秒处理完。`cosmic_run` 落库后等它处理完再往下走，输出里"流程："那一行说进没进审批流，
  同一批里提交完紧接着审核不会撞上"在流程中"。
- 不带：任务派不出去（运行日志里有"调度服务已停止"），留在库里等环境的调度来接手，接手前单据一直是"发起中"，等多久由环境定（实测几分钟到十分钟）。
  已经提交的单不用重提，用 `@流程` 看它什么时候变；要在本机当场发起，下一次提交带 `--schedule`。

**方法返回时流程还在后台走。** 提交后 1～2 秒 `inProcess` 就是 true，流程实例和第一个待办却要 40～70 秒才出来；
审批、撤回、终止返回后，流程表也要 10～40 秒才变。要看结果就轮询 `wf_task` / `wf_execution`，等它变了再做下一个动作——
刚同意完就撤回已处理任务，报"撤回失败，流程正在流转，或正在重试"。`cosmic_run` 一次调用 120 秒超时，
在调用里轮询要留余量（例如最多等 80 秒），不够就分几次调。

| 方法 | 返回 | 流程 | 审批记录 `wf_hicomment` | 单据状态 |
|---|---|---|---|---|
| 单据操作 `submit` | 1～16 秒 | 进流程，40～70 秒后出第一个待办 | 多一条"提交" | 已提交 |
| `completeTask(taskId, userId, "Consent", 意见)` | 6～14 秒 | 约 30 秒后流程结束 | 多一条"同意" | 约 7 秒后已审核（审核插件照跑） |
| `completeTask(…, "RejectToEdit", …)`（驳回至提交节点） | 约 10 秒 | 退回提交节点**挂起**（`wf_execution.suspensionstate` = 2），没有待办，`inProcess` 仍是 true | 多一条驳回 | **仍是已提交**，直接再提交被拒（"只有暂存的数据才允许提交"） |
| `batchAgreeTaskWithUserId(List<Long> 任务id, LocaleString 意见, Long 审批人)` | 约 8 秒 | 同 `Consent` | 同 `Consent` | 已审核 |
| `withdraw(DynamicObject)` | 约 17 秒 | 撤掉 | **清空** | **仍是已提交** |
| `batchWithdraw(DynamicObject[], "unsubmit")` | 约 43 秒，返回空串 | 撤掉，`getProcessInstanceIdByBusinessKey` 变 null | **清空** | **仍是已提交** |
| `billUnsubmit(DynamicObject[], "unsubmit", param)`，`abandonPks` 含单据 id | 约 17 秒 | 撤掉 | 保留 | **仍是已提交** |
| 单据操作 `unsubmit`，流程停在审批节点、还没人处理 | 约 24 秒，成功 | 撤掉，`getProcessInstanceIdByBusinessKey` 变 null | **清空** | **暂存**，一步到位 |
| 单据操作 `unsubmit`，已审核 | 约 6 秒，不抛异常 | — | 不变 | 不变；`isSuccess()` 为 false，错误信息"单据状态必须是已提交才能撤销。" |
| `abandonByBusienssKey(id)`（JAR 上的拼写） | 10～13 秒 | 约 25 秒后没了；这期间 `inProcess` 会反复读到 true | 保留 | **仍是已提交** |
| `abandonRootProcessInstance(id)` | 约 12 秒 | 同上 | 保留 | **仍是已提交** |

- **要把在审的单撤回暂存，直接跑单据操作 `unsubmit`**（`OperationServiceHelper.executeOperate("unsubmit", 实体, ids, option)`，挂在撤销上的操作插件照跑）：
  流程撤掉、审批记录清空、单据回到暂存。上表那些工作流方法撤回、终止都不改单据状态，用了它们还得再跑一次 `unsubmit`。
  回到暂存后改好再提交，会起一个新流程实例（`wf_hiprocinst` 多一行）。流程里已经有人同意、还没走完时跑 `unsubmit` 会怎样，本环境的流程只有一个审批节点，没测。
- **决策项编码按节点配置**，不是固定的：同意常见 `Consent`，驳回有 `Reject`、`RejectToEdit`、`RejectToPreAudit`、`RejectToAllAudit` 等。
  传错报"传入的决策项编码与节点决策项配置的编码不一致"。先查这个节点以往的处理记录：
  `wf_hicomment` 按 `entitynumber`、`activityname` 查 `resultnumber, resultname`。
- `canWithdraw(DynamicObject[])` 返回 `{wfCanWithdraw=[可撤的id], wfCanWithdrawByAbandonProc=[], notWithdrawCause=[], notInProcess=[]}`；
  审批完（已审核）的单在 `notInProcess` 里、`wfCanWithdraw` 为空，这时还多一个键 `withdrawDeleteBizJobIds=[]`。
- `withdrawTaskByBusinessKeyAndUserId(id, 处理人id)` 撤回已处理的任务：流程还在流转时报"撤回失败，流程正在流转，或正在重试"；流程走完后没有可撤的已办任务。
- `billUnsubmit` 的 `abandonPks` 是**字符串**，平台看单据 id 在不在里面：在就按终止撤回，不在或不传就普通撤回；传 List 抛类型转换异常。
- `batchAuditByBusinesskeys(List<String> ids, Map param)`：`param` 要有 `auditUserId`（审批人 id）和 `batchOpType`（`approve` / `reject`），
  缺一个只返回 `{errorInfos=[参数错误，请检查。]}`（真机实测）；节点不允许批量处理的报"不能批量同意/驳回"。带齐参数的调用没有实测。
- `completeTask` 另有两个以 `(String, String, Long, String, String, boolean …)` 开头的重载，参数含义读官方文档。
