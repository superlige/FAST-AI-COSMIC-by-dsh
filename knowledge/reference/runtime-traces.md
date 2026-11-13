---
class: B
when: 生产排障：monitor 日志怎么查、没有 traceId 时从哪拿、报错日志怎么读、单据在生产上经过了什么（上下游、流程、后台任务、操作记录）、生产元数据原文怎么看
---

# 运行痕迹：苍穹在运行时把事情记在哪

来源：苍穹 8.0（GaussDB 部署）生产库和 monitor 实测。表在哪个分区按部署不同，用 `cosmic_prod action=sql` 查时结果会报出表所在的分区；这里只写表和列的含义。

## monitor 日志

### 记了什么、留多久

- 日志只留 **7 天**（今天和前 6 个自然日）。更早发生的事 monitor 里已经没有，只能靠下面「单据在生产上经过了什么」那些表。
- **正常请求也记**：一次点击通常几十到上百条 INFO。所以 monitor 不只用来找报错，也能看「这次请求经过了谁」：走了哪些校验器、转换和反写、网控、本工程插件自己写的日志（正文里常带单据编号）。
- 一条日志 = 一次写日志调用。`logtags` 是这次请求的上下文：
  - `traceId`：同一次请求的所有日志共用一个。
  - `formId`：**页面标识**，不是单据标识。单据页是布局标识（一张单可以有好几个布局），列表是 `bos_list-<单据标识>`，审批页是 `WF_<任务 id>_SKDJ_S`，弹窗是弹窗自己的标识。
  - `opKey`：写作「控件[按钮, 操作]」，如 `tbmain[bar_submit, submit]`、`toolbarap[tblcheck, audit]`；第二项是操作标识。
  - `opMethod`：`itemClick`、`click`、`loadData`、`entryRowClick` 这类。
  - `userName`：操作人姓名，和操作记录里的一样；`userId` 是用户 id。
  - `orgId`：组织 id。
  - `formId`、`opKey` 两项筛选都是**精确匹配**，写成单据标识或光写 `submit` 都查不到。
- 一次点击常不止一个请求：
  - 提交、审核后，工作流会另起几个请求（页面 `WF_…`），各有 traceId；
  - 消息队列的请求页面写作 `mq`；
  - 走审批时，单据的审核是工作流在 `WF_…` 请求里替人执行的；
  - 批量审批时，几张单同时各跑一个。
- 正文太长会断成两段：`message` 和接在后面的 `message2`，要拼起来看。`cosmic_prod action=log` 已经拼好，也还原了网页转义。
- `kd.bos.slowlog.SlowLogger` 记的是**慢查询**，**不是报错**：
  - 正文里有 SQL 和耗时，后面附一段名为 `java.lang.Exception: Slow SQL trace` 的调用栈，只是为了带出是谁发的这条 SQL；
  - 级别虽然是 ERROR，一般占报错日志的一大半。
- `kd.bos.form.log.FormBehaviorErrorReporter` 记的是**弹给用户的那句提示**：
  - 正文里是 `op：'…'`（哪个按钮）、`errTitle`、`errContent`（提示原文）；
  - 它本身不带原因。同一个 traceId 下的其他日志里，才有抛出它的校验器或异常，以及前后经过的类。

### 没有 traceId 时从哪拿

用户报问题时通常只说得出「哪张单、大概什么时候、点了什么」。traceId 能从这些地方找回来：

| 线索 | 在哪 | 怎么用 |
|---|---|---|
| 这张单被谁、在哪一刻做了什么操作 | 操作记录 `t_log_app_v3`（`foptime` 到毫秒、`fusername`、`fopkey`、`fstatus`、`fopdesc` 常带单据编号）；本身没有 traceId | `cosmic_prod action=log number=<单据标识> billno=<单据编号>`：逐次按「操作人 + 那一刻前后几秒」认出 monitor 里的请求，再按单号搜日志正文 |
| 下推 | 操作记录里 `fopkey='push'` 的行：`fopdesc` 是 `traceid=%s`，`fopdescargs` 里就是 traceId | 直接按 traceId 查 |
| 后台任务某次执行 | `t_sch_task.ftraceid` | 直接按 traceId 查 |
| 工作流作业 | `t_wf_taskjob.ftraceid` | 直接按 traceId 查 |
| 反写 | `t_sm_writebackflow`、`t_pm_writebackflow` 等 `t_*_writebackflow`：`ftraceid`、`fopdate`、`fbillnumber`、`fbillsign` | 按单据编号查出 traceId |
| 网控、数据锁 | `t_mutex_datalock.ftraceid` | 直接按 traceId 查 |
| 只知道人和大概时间 | — | `userName` + 几秒到几分钟的时间段；只按时间不按人查，5000 条一个多小时就满了 |

## 设计态元数据的原文

`cosmic_prod action=meta` 已经把一张单合并好了（表、字段到列、插件），要看合并结果之外的细节（规则条件、校验条件、字段默认值）时才读原文。原文每一层一个 XML 文件，读的时候知道这几点：

- 一张单不是一行，是一条链叠出来的：`FINHERITPATH` 是从根模板到本单的继承链，`FMASTERID` 指向被扩展的那一层（扩展行）。后面的层只写差量：`action="edit" oid="…"` 改前面某个元素，`action="remove"` 删，`action="setnull"` 置空，不带 action 的是新加的。
- 同一张单的实体（`t_meta_entitydesign`）和布局（`t_meta_formdesign`）是同一个 `FID`。
- 字段：`<FieldName>` 是数据库列名，`<ParentId>` 指向所属分录（没写就在单据头），多语言文本字段存在 `<表名>_l`。单据头的表名在单据头元素的 `<TableName>`。
- 操作插件和校验器在实体 XML 单据头的 `<Operations>` 里，按 `<Operation>` 分；校验条件在 `<Validations>` 下的 `<PreCondition><RuleCondition>`。表单插件在布局 XML 的 `<BillFormAp>`（或别的 `…FormAp`）的 `<Plugins>` 里；被停用的插件是 `<Enabled>false</Enabled>`，在扩展层里常写成对原插件的一次 edit。
- 必录条件、可见条件这类按条件生效的设置写在字段的 `<MustInputCondition>` 等元素里，内容是一段 JSON（`RuleCondition` 是条件表达式，`RuleDescription` 是给人看的名字）。

## 单据在生产上经过了什么

| 想知道 | 表 | 关键列 |
|---|---|---|
| 下推、反写的上下游关系 | `t_botp_billtracker` | `fstableid`/`fsbillid` 源单的表和单据 id，`fttableid`/`ftbillid` 目标单，`fcreatetime` |
| 操作记录（谁在什么时候点了什么） | `t_log_app_v3`（还有 `t_log_app_v2`、`t_log_app_other` 等分表） | `foptime`、`fusername`、`fuserid`、`fbizobjid`（单据标识）、`fopkey`/`fopname`（操作）、`fopdesc`（描述，常带单据编号；带 `%s` 的是模板，参数在 `fopdescargs`）、`fstatus`（1 成功、0 失败） |
| 工作流：在途的流程实例 | `t_wf_execution` | `fbusinesskey`（单据 id）、`fentitynumber`、`fbillno`、`factivityname`（当前节点）、`fpresentassignee`（当前处理人） |
| 工作流：结束了的流程实例 | `t_wf_hiprocinst` | `fbusinesskey`、`fbillno`、`fendtype`、`fdeletereason`、`fendtime` |
| 工作流：每个人的审批任务 | `t_wf_hitaskinst` | `fprocinstid`、`fname`（节点）、`fassignee`、`fendtime`、`fhandlestate` |
| 工作流：审批意见 | `t_wf_hicomment` | 按流程实例查 |
| 后台任务每次执行 | `t_sch_task` | `fjobid`、`fstatus`、`fstatusdesc`、`fdispatchtime`、`fendtime`、`fcosttime`、`ftraceid`（拿去查 monitor） |
| 后台任务失败记录 | `t_sch_errorjob` | `fjobid`、`fexecutetime`、`ferrorreason` |

- 这几张表都很大（操作记录、上下游关系是千万行级），查询一定带单据 id、单据编号或时间段，不带条件的会超时被取消。
- 单据 id 是单据主表的 `fid`；先在单据主表里按编号（`fbillno`）查出 `fid`，再拿它查这些表。
