---
class: C
when: 报表取数、批量引入、后台任务、工作流、自定义 API
---

# 集成型插件：报表取数、引入、任务、工作流与自定义 API

本页处理无 UI 或由平台服务入口驱动的集成型插件。公共流程与证据口径见
[plugin-dev.md](plugin-dev.md)，查询、事务、日志等通用 API 见 [sdk.md](sdk.md)。

> **官方语义索引**：五族的通用骨架、生命周期和实践建议一律读官方，入口跑
> `driver.mjs knowledge routes`。**本页只留当前 SDK 负面证据、官方文档写错的签名，
> 和配置型开放接口的真实元数据探查方法。**

- [报表取数插件](#报表取数插件)
- [批量引入插件](#批量引入插件)
- [后台任务](#后台任务)
- [工作流插件](#工作流插件)
- [自定义 API](#自定义-api)
- [配置型开放接口](#配置型开放接口apimetaprobe)
- [验证清单](#验证清单)

## 报表取数插件

生命周期和骨架读 `platform/reportlistdata-plugin.md`。取数运行在服务端，没有 `Model/View`。

**SDK 已核对**（本机 8.0）：

```java
public DataSet query(ReportQueryParam param, Object selectedObj) throws Throwable
public List<AbstractReportColumn> getColumns(List<AbstractReportColumn> columns) throws Throwable
```

上下文另有 `getQueryParam()` / `getSelectedObj()` / `setProgress(int)`。

### 报表取数插件必知要点

- 取数在服务端跑，没有 `Model` / `View`；页面交互在报表界面插件那边。
- `query(ReportQueryParam, Object selectedObj)` 返回 `DataSet`，`getColumns` 改列（签名本机 8.0 已核对）；列逻辑放 `getColumns`，不混进 `query`。
- 左树报表要按 `selectedObj` 限定范围：不处理时点树节点照样返回全量数据，页面看起来正常响应，只是没被节点过滤，不报错。
- `DataSet` 不存进插件成员变量，谁打开谁关闭。

报表页面交互见 [plugin-ui.md](plugin-ui.md#报表界面插件)。

## 批量引入插件

引入流程和骨架读 `platform/import-plugin.md`。

### 批量引入插件必知要点

- `kd.bos.form.plugin.impt.BatchImportPlugin.save` 的返回类型是 `ApiResult`（当前环境实测）：只记参数、漏掉返回类型，覆写签名就对不上；`getBatchImportSize()` / `isForceBatch()` 用之前先用 `cosmic_knowledge action=api` 查签名。
- 失败原因写进 `ImportLogger` 并定位到原始行：`logger.log(row.getStartIndex(), …).fail()`。
- 只移除失败行，其余合法数据继续导入；一次异常中断整批只用于整个文件已不具备处理条件的情况。

## 后台任务

通用任务入口、生命周期、实践建议和坑位读取 `platform/task-plugin.md`（含可停止任务、
批量检查、定时预警三个完整场景），进度与停止的语义那里已经讲全，本页不复制。

**当前 SDK 已核对**：`kd.bos.schedule.api.Task` 接口上是
`execute(RequestContext, Map)` / `stop()` / `setTaskId` 等 8 个 public 方法；
`kd.bos.schedule.executor.AbstractTask` 上另有四个 **`protected`** 钩子，官方场景用的就是它们：

```java
protected void feedbackProgress(int)                 // 还有三参重载
protected void feedbackProgress(int, String, Map)    // 官方文档写的是 Object，实际第三参是 Map
protected void feedbackCustomdata(Map)
protected void checkIsStop()                         // 另有 protected boolean isStop()
```

`kd.bos.schedule.api.StopTask` 是**空标记接口**（无方法）：实现它是告诉调度框架这个任务可停止，
真正读停止标记的 `isStop()` / `checkIsStop()` 在 `AbstractTask` 上。

工程参考：出处工程里的一个定时任务插件（`*TaskPlugin`）。该类只能作为入口签名参考，
不能自动证明其批处理、幂等和停止处理已经完整。

### 后台任务必知要点

- `AbstractTask` 上的 `feedbackProgress`、`feedbackCustomdata`、`checkIsStop`、`isStop` 是 `protected` 钩子，只能在任务类自己（子类）里调。
- `feedbackProgress(int, String, Map)` 第三个参数是 `Map`（官方文档写的 `Object` 不对，SDK 已核对）。
- `StopTask` 是空标记接口，只告诉调度框架这个任务可停止；读停止标记靠 `AbstractTask` 上的 `isStop()` / `checkIsStop()`。

## 工作流插件

扩展点和候选方法读 `platform/workflow-plugin.md`。当前实现接口是
`kd.bos.workflow.engine.extitf.IWorkflowPlugin`。
查单据的流程状态、当前审批人、审批记录，以及 `WorkflowServiceHelper` 各方法实际返回什么，见 [workflow.md](workflow.md)。

### 工作流插件必知要点

- `IWorkflowPlugin` 是接口：没有统一的基类 `super` 可调，具体方法由流程节点配置和接口签名（`cosmic_knowledge action=api`）共同确认。
- 工作流执行上下文里的变量和单据数据是两套状态，要显式同步，并定好撤回、回退时怎么恢复。
- 落码前确认插件挂在哪个流程、节点和扩展点（`WfModelProbe`），`businessKey` 对应哪个实体和主键。
- 重试、撤回、重复通知都可能再调一次插件，处理要幂等。

改完用 [`run wf`](run.md#run-wf工作流插件) 验：按已发布流程定义拼出上下文直调插件方法，流程不真跑。

## 自定义 API

注解、路由和 Controller 骨架读 `platform/openapi-customapi-java-plugin.md`；
当前工程用的注解、返回类型和映射仍要 `api` / `lint`。

### 开放接口插件必知要点

自定义 API 和挂在配置型开放接口上的插件共用这几条；细节在本节和下一节。

- 接口有两种：代码写的 `@ApiController`，和开发者门户上配置的零代码 API。实体被接口写入，不等于有 Controller 源码。
- 一张单据常挂多个 API、插件只绑其中一个：先用 `ApiMetaProbe`（`API_ENTITY=<业务对象标识>`）查清各接口绑了什么插件（工程实测）。
- 配置型 API 的 `operation` 字段是它最终执行的单据操作；要所有接口都生效的逻辑挂在那个操作的操作插件上。
- 请求体 `bodyentryentity` 里没有的参数上游传不进来；`param_default_value` 决定上游不传时落库的值。
- `@ApiController` 的类要在平台接口登记（`openapi_apilist`）里有一条才调得到；登记不随部署生成，要人来写。
- 验证直接调插件方法，不经 HTTP、不经登记；各插件接口调哪个方法见「配置型开放接口：`ApiMetaProbe`」那节的表。

**代码写的接口类（`@ApiController`）要在平台接口登记里有一条，外部才调得到。** 登记和配置型接口是同一张表
`openapi_apilist`，类型为「Java插件」（`apiservicetype=2`），实现类记在 `classname`。工程实测（2026-09-28）：

- **登记不随部署自动生成。** 工程里 15 个带 `@ApiController` 的类，13 个有登记、2 个没有。
  登记是写平台元数据，要人来做；造数、改数探针写不进 `openapi_*` 这类平台表。
- **登记和类上的注解一一对应。** 编码 = 类上 `@ApiMapping` + 方法上 `@ApiPostMapping` 的路径
  （`trd/mes/xnlsalorder` + `/orderToIn` → `trd/mes/xnlsalorder/orderToIn`；类上没有 `@ApiMapping` 就只有方法那段，
  如 `getDataByNo`）；请求体 = `@ApiRequestBody` 那个模型的字段；返回参数 = `CustomApiResult` 的
  `status`、`errorCode`、`message`、`data`，再按层级展开 `data` 模型的字段。
- **URL 里的应用以登记为准**：`/v2/<ISV>/<所属应用>/<编码>`。上面那个类注解写 `@ApiController(value = "MES接口")`，
  登记挂在 `sm` 下，URL 是 `/v2/demo/sm/trd/mes/xnlsalorder/orderToIn`。
- **登记在，源码不一定在这个工程里。** 实测登记的实现类 79 个，65 个的源码不在本工程（别的工程或 jar），也有代码删了、登记还留着的。
  `ApiMetaProbe` 输出末尾说实现类在不在本工程源码里。
- **验证代码不经过登记**：`run call <类名>#<方法>` 直接调方法，登记有没有、对不对都不影响这一步。

## 配置型开放接口：`ApiMetaProbe`

「自定义 API」那节讲的注解式 Controller 是**代码型** API。真正把外部数据写进单据的，多数是开发者门户上
**配置出来的**零代码 API（`apiservicetype=0`）—— 源码里搜不到它，只有一份元数据：
实体 `openapi_apilist`（表 `t_open_apiservice`）。

```bash
API_ENTITY=<业务对象标识>   node …/driver.mjs probe ApiMetaProbe   # 这张单据挂了哪些接口
API_PLUGIN=<插件类名关键字> node …/driver.mjs probe ApiMetaProbe   # 某插件挂在哪些接口上
API_NUMBER=<API编码[,…]>    node …/driver.mjs probe ApiMetaProbe   # 某接口的 Query 参数、请求体、返回参数、配置参数
API_FIELDS=<参数关键字[,…]>  加在上面任一条后                       # 请求体只列名字匹配的参数
```

三件不查就会判断错的事（工程实测）：

- **一张单据常有多个 API。** 实测一张委托单挂着 `saveWTD` 和 `xnlsaveWTD` 两个保存接口，
  `ApiDeserializerPlugin` 只绑在后者上。光读插件源码看不出它挂在哪个 API 上，更看不出
  另一个 API 根本没挂它 —— 把逻辑写进那个插件，另一条链路直接漏掉。
- **`operation` 字段就是这个 API 最终执行的单据操作**（通常是 `save`）。它是接口数据和界面
  数据的汇合点，也是「让接口数据也走某段逻辑」的正确挂载点，见
  [plugin-operation.md](plugin-operation.md) 的“界面之外的写入路径都从这里过”。
- **请求体 `bodyentryentity` 是硬边界**：里面没有的参数，上游想传也传不进来；
  `param_default_value` 决定上游不传时落库的值（实测一个接口给「是否接口传输」标记配了
  默认值 `"1"`，另一个接口连这个参数都没有）。判断“上游传不传得了某字段”先查这里，
  别靠问、也别靠翻历史数据猜。

挂在配置型接口上的插件，改完用 `run call` 直接调接口方法验（不经 HTTP、不经登记）：

| 插件接口 | 调哪个方法 | `--args` 怎么写 |
|---|---|---|
| `ApiDeserializerPlugin` | `deserializer(String, String)`：原始报文 → 请求 Map | `["<报文原文>","application/json"]` |
| `ApiSavePlugin` | `preHandleRequestData(List<Map>)`：保存前改请求数据 | `[[{<一张单的请求数据>}]]` |
| `ApiQueryPlugin` | `getFilter(QFilter, Map)`：追加查询条件 | `[["<字段>","=","<值>"],{<请求参数>}]`，第一个是平台给的原条件 |
| `ApiSerializerPlugin` | `getVersion()` 返回 `MODEL` 的调 `serializeByModel(ApiSerializerModel)`，其余调 `serialize(Object, String, String)` | 前者 `[{"response":{…},"accept":"…","contentType":"…","reqData":{…}}]`，后者 `[{<响应>},"<accept>","<contentType>"]` |

返回的 `SerializerResult` 按 `result`、`contentType` 断言，过滤条件按 `$~=<字段名>` 断言。
插件按 `contentType` 分支时，传的值要和它比较的常量一致（例如 nacos 的 `MediaType.APPLICATION_JSON` 带 `;charset=UTF-8`），
对不上插件可能直接返回 `null`。
`ICustomApiServlet.doAction` 要 HTTP 请求和响应对象，造不出来：把处理逻辑抽成收普通参数的方法再调。

## 验证清单

1. 用 `api` 核对基类、接口、注解和方法签名（基类留给子类的 `protected` 钩子也在里面）。
2. 配置型接口先用 `ApiMetaProbe` 查清触发的操作、插件绑定和请求体字段，再决定逻辑挂哪一层。
   报表取数插件挂没挂上看 `FormPluginProbe` 里报表列表那一段，引入插件、后台任务用 `cosmic_impact` 查类；本页这几类的登记都要用户在平台上配，交付时写明要配在哪。
3. 用 `DataProbe` 确认报表、任务或 API 测试所需数据存在。
4. 为批量入口准备空集、单行、部分失败、大批量和重复执行场景。
5. 将核心计算/映射逻辑抽离，用 `cosmic_run` 的 `run call <类名>#<方法> --args [...] --expect <路径>=<值>` 直接调它验证（见 [run.md](run.md#run-call直接调本工程类的方法)）；
   调度任务可以整个 `run call <任务类>#execute --args [{任务参数}] --expect error=`；配置型接口上的插件直接调接口方法（见「配置型开放接口：`ApiMetaProbe`」那节的表）。手写探针跑出来的断言不算交付证据。
6. 对写接口先验证 dry-run 或无副作用分支，再在明确授权下做最小写入。
7. 只有验证 HTTP 路由或页面报表交互时才启动本地节点。
