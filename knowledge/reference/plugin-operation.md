---
class: C
when: 操作插件、事务阶段、BOTP、反写
---

# 事务与转换插件：操作、BOTP、反写

本页处理没有 UI 上下文、围绕业务操作或上下游转换运行的插件。公共开发流程与证据口径见
[plugin-dev.md](plugin-dev.md)，SDK 查询和数据操作见 [sdk.md](sdk.md)。

> **官方语义索引**：三族的通用生命周期、完整事件表和骨架分别读
> `platform/operation-plugin.md`、`platform/botp-plugin.md`、`platform/writeback-plugin.md`，
> 入口跑 `driver.mjs knowledge routes`。**本页只留当前事务判据、SDK 差异和真实写入入口汇合结论。**

- [共同边界](#共同边界)
- [操作插件](#操作插件)
- [BOTP 转换插件](#botp-转换插件)
- [反写插件](#反写插件)
- [验证清单](#验证清单)

## 共同边界

1. 不调用 `getView()` / `getModel()`；直接处理事件参数中的 `DynamicObject` 数据包。
2. 不把“服务端插件”等同于“所有回调都在事务内”；逐个事件确认事务阶段。
3. 在加载数据包前补齐所需字段，避免后续读取到 `null`。
4. 将外部通知、非事务日志和远程调用放到提交后阶段；事务内只做必须同步成功或失败的工作。
5. 先确认元数据绑定，再修改代码：操作用 `OpMetaProbe`，BOTP 用 `BotpRuleProbe`。
   **不要仅凭按钮标题或 `save` / `submit` / `audit` 这类常见标识判断绑了什么。**

## 操作插件

`kd.bos.entity.plugin.AbstractOperationServicePlugIn`。没有 UI 上下文，但生命周期横跨
事务前、事务内和提交后，**不能笼统写成「整个插件运行在事务内」**。

### 操作插件必知要点

写操作插件、校验器时最容易错、而且错了不报错的几条；细节在本节后面。

- 没有 `getView()` / `getModel()`，只处理事件参数里的 `DynamicObject` 数据包。
- 要读的字段在 `onPreparePropertys` 里加：没加载的字段读出来是 `null`，和业务空值在代码里分不出来。
- 判「没填」按字段类型，不一律判 `null`：小数、金额、数量没填读出来是 0（勾了「允许为空」的才是 `null`），两样都算没填；下拉没保存过是 `null`、存过是空串。各类型见 [sdk.md](sdk.md#各类字段没填时读出来是什么)。
- 事务前、事务内、提交后各放各的逻辑；外部通知、远程调用放提交后，它们不会随数据库回滚。
- 明确的业务规则写成校验器、在 `onAddValidators` 注册，不堆进 `beforeExecuteOperationTransaction`。
- 开放接口、BOTP 下推、批量引入进来的数据不走表单插件：要所有入口都生效的默认值和校验，挂在 `save` / `submit` 的操作插件上（工程实测）。
- 只对接口数据生效时，按单据上的「接口传输」标记字段判断，不按操作 key 判断：界面保存走的是同一个 `save`。
- 先用 `OpMetaProbe` 确认按钮绑的操作和插件，不凭 `save` / `submit` / `audit` 这类常见标识判断。
- `afterExecuteOperationTransaction` 里不改核心单据数据；多个状态转换不重复推动同一状态机。

### 三个裁决点（官方事件表之外）

1. `onPreparePropertys` 决定数据包含不含后续字段。**字段没加载不能当成业务空值** ——
   这两件事在代码里长得一模一样。
2. 事务前、事务内、提交后必须分别放置逻辑；**外部通知不能假设会随数据库事务回滚**
   （`run op` 的回滚沙箱只回滚数据库，见 [run.md](run.md#红线tx-只回滚数据库)）。
3. **事件名不能证明当前操作的真实事务边界**，涉及写入时用 `run op` 或最小探针验证。

**SDK 已核对**：`getOption()` 返回 `OperateOption`，不是 `Map<String,Object>`。
上下文另有 `billEntityType` / `operateMeta` / `operationResult` 三个字段，签名以 `api` 为准。

自定义按钮能否绑操作插件取决于操作元数据配置，
**不要照抄「除预置操作外一律不支持」这类没在当前元数据上验证过的结论**。

### 界面之外的写入路径都从这里过（工程实测）

开放接口、BOTP 下推、批量引入进来的数据**不走表单插件**，界面上做的默认值联动对它们一律
不生效；而这些路径最终都要执行某个单据操作（配置型 API 的 `operation` 字段就写着是哪个）。
所以「接口进来的单据没带上界面那套默认值」这类需求，挂在 `save` / `submit` 的操作插件上，
比挂在某一个 API 的 `ApiDeserializerPlugin` 上覆盖面大 —— 实测同一张单据挂着两个保存接口，
反序列化插件只绑了其中一个，写进那里就漏掉另一条链路（查法见
[plugin-integration.md](plugin-integration.md) 的 `ApiMetaProbe`）。

要只对接口数据生效时：

- **判据用单据上的「接口传输」标记字段，不能用操作 key** —— 界面保存走的是同一个 `save`。
- 那个标记通常靠 API 请求体的 `param_default_value` 兜底写入，**逐个 API 确认都配了它**：
  漏配的那个接口进来的数据和手工新增在数据上无法区分，补值逻辑会静默不生效。
- 判定逻辑抽成不依赖 `getModel()` 的静态纯函数，界面插件和操作插件同调一份，
  探针可以直接喂参数验规则矩阵（见 [plugin-dev.md](plugin-dev.md#抽离可验证的业务逻辑)）。

## BOTP 转换插件

`kd.bos.entity.botp.plugin.AbstractConvertPlugIn`。完整事件链和骨架读 `platform/botp-plugin.md`。

动代码前先读 [metadata-botp.md](metadata-botp.md) 并跑 `BotpRuleProbe`。

### BOTP 转换插件必知要点

编码前确认这几条，任何一条不对，插件写得再对也不生效：

- 规则确实连接目标源单和目标单。
- 转换规则启用和插件启用是两个独立开关，只确认规则启用不算数。
- 分录映射落在正确层级：只看表头映射会漏掉分录和子分录。
- 下推和选单不会触发同一套完整事件链：当前入口是哪个，用 `BotpRuleProbe` 和一条真实规则确认，不靠事件名推断。
- 需要读取的源字段已加入查询字段，没加的读出来是空。

## 反写插件

`kd.bos.entity.botp.plugin.AbstractWriteBackPlugIn`。

### 反写插件必知要点

- 18 个事件的执行顺序、实践建议和常见坑位以官方 `platform/writeback-plugin.md` 为准，比本地写得全，写之前读那篇；新增回调的签名用 `cosmic_knowledge action=api` 核对当前基类。
- `beforeTrack` / `beforeCreateArticulationRow` 误取消会让反写缺失；`beforeExcessCheck` 一律取消检查会让业务失控（官方指南）。
- 官方模板说「所有重写方法必须调用 `super.xxx()`」只针对这一个基类，不是全平台规则：监听器接口方法没有基类实现可调，判据见 [plugin-dev.md](plugin-dev.md#正确处理-super-调用)。
- 反写没有无头适配器，行为验证要起节点。

## 验证清单

1. 用 `OpMetaProbe` / `BotpRuleProbe` 确认真实绑定和启用状态；操作插件没挂上的用 `FormLayoutWriteProbe` 的 `add plugin <类全名> to op <操作>` 挂上（[metadata-form.md](metadata-form.md)）。转换插件登记在转换规则上、反写插件登记在发起反写那张单据实体的关联配置上，都要用户在开发平台里挂；反写插件 `BotpRuleProbe` 列不出来，用 `cosmic_impact` 查类。
2. 用 `DataProbe` 确认存在覆盖目标分支的真实数据。
3. 用 `api` 核对新增事件参数、返回类型和上下文方法。
4. 将纯计算或分配算法抽离后用探针验证。
5. 操作插件走 `run op <实体> <操作>`；BOTP 转换插件走 `run push <规则id> --pk <源单内码> --expect <目标单字段>=<值>`，
   目标单真实保存后从数据库重新读取并断言，见 [run.md](run.md#run-pushbotp-转换插件)。保存路径上的反写照常执行；要验反写结果，再只读查询源单对应字段。
6. 只有确认写入语义时才走受控写测试，并保持可回滚范围最小。
