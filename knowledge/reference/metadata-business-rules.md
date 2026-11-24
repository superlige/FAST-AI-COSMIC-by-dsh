---
class: B
when: 业务规则及函数目录
note: 新增或修改先读写入总则
---

# 实体业务规则（读取与受控写入）

来源：苍穹官方知识库 `requirements/base/platform-summary.md` 的界面规则/业务规则定义，结合当前
苍穹 8.0.1 JAR 签名、真实 `DesignEntityMeta` 和参数化探针 dry-run 验证。共享写入前先读
[metadata-write.md](metadata-write.md)。界面规则另见
[metadata-form-rules.md](metadata-form-rules.md)。

- [先查函数目录](#先查函数目录)
- [算一遍（不是读，是求值）](#算一遍不是读是求值)
- [读取业务规则](#读取业务规则)
- [新增和回滚](#新增和回滚)
- [改已有规则](#改已有规则)
- [五类官方动作](#五类官方动作)
- [元数据位置与执行结构](#元数据位置与执行结构)
- [验证与坑](#验证与坑)

## 先查函数目录

官方知识确认规则条件支持 `and` / `or`、`null`、`<>`、四则运算和函数，但没有展开函数清单。
**不要扫全库既有规则猜函数名。** `meta formula biz` 按需查平台给设计器用的函数目录
（公共函数、当前已装应用的单据函数和扩展函数合在一起，界面规则共用同一份）：

```bash
meta formula biz                          # 只报分类和条数，不倒全目录
meta formula biz --name if                # 按名字精确查：参数格式、说明、返回类型、来源
meta formula biz --q 多选基础资料          # 不知道名字时按用途查，每页 3 条，接着看加 --page 2
meta formula biz --group 字符串函数        # 按分类翻
meta formula biz --actions                # 业务规则（实体）动作，只列 entitymeta 的 6 条
```

返回里的参数格式（`usage`）才是可复制的调用写法。单据函数和扩展函数随当前环境装的应用变化，
不能写死到 Skill。查不到时返回会说是在别的目录里（例如这其实是界面动作，附能照抄的查询）、
名字相近，还是目录没读全；「目录读全了也没有」时写进表达式，写入前的核对也会拦下。
业务规则动作 6 条：下面五类，外加 `CallFieldChangeAction` 调用字段值更新服务；动作记录里的
`raiseEventType` 就是该动作应有的事件位，字段语义见
[metadata-form-rules.md](metadata-form-rules.md#先查动作目录和函数目录)。

## 算一遍（不是读，是求值）

「这组输入下，目标字段会被算成什么」不要靠读规则文本推。还没落库的新规则，看写入预演的试算
（下面「新增和回滚」）；已落库的用 `run rule biz`：

```bash
node .claude/skills/long-cosmic-dev/driver.mjs run rule biz demo_bill   --set demo_qcdw=SC08 [--host demo_entry] [--row 0] --expect demo_lb=2
```

动作由**平台自己的动作类**执行（`kd.bos.entity.rule.*Action`），五类低代码服务的语义
一个都不用重算。用法见 [run.md](run.md)，「运行态 Map 的 `class=` 才是执行者」「`_dataEntities`
为空时动作静默不写值」这两条机制见 [免界面验证](../docs/技术设计/免界面验证.md) 的 R3 节。

**它只算规则那一层**，`run form --show` 打的是插件 + 界面规则 + 业务规则的合力终值。
值不对时两个一起跑，就知道该改插件还是改规则。

## 读取业务规则

```bash
# 遍历主实体、分录和子分录上的全部业务规则
BIZ_ENTITY=demo_sys_test_bill \
  node .claude/skills/long-cosmic-dev/driver.mjs probe BizRuleProbe

# 只看一个宿主
BIZ_ENTITY=demo_sys_test_bill BIZ_HOST=demo_entryentity \
  node .claude/skills/long-cosmic-dev/driver.mjs probe BizRuleProbe
```

输出包含规则条件、触发字段、真假分支，以及每个动作的设计态参数和 `buildAction()` 运行态 Map。
新增前必须先读一次，确认 `BIZ_HOST`、既有规则顺序和目标字段没有被其它规则重复赋值。

## 新增和回滚

一轮只新增一条规则；真假分支可各有多个动作，动作间用 `;;` 分隔：

```bash
BIZ_ENTITY=demo_sys_test_bill BIZ_HOST=demo_entryentity \
BIZ_TAG='数量计算-' BIZ_NAME='金额与基本数量' \
BIZ_CONDITION='demo_qty <> null and demo_price <> null' \
BIZ_TRUE='formula:demo_amount = demo_qty * demo_price;;qty:demo_qty->demo_baseqty' \
  node .claude/skills/long-cosmic-dev/driver.mjs probe BizRuleProbe
```

上面默认 dry-run，会完成动作运行态构建、规则编译和 `DesignEntityMeta` 序列化，但不保存。
确认输出后加 `APPLY=1` 才落库。

dry-run 还做两件事，都不落库：

- **核表达式**：`BIZ_CONDITION` 和 `formula:` 里的表达式交给平台自己的解析器，函数名对照当前环境登记的
  函数目录（区分大小写），字段名对照整张单据。写错了停在写入之前，指出错处，例如
  `到结尾还没写完`、`字段 demo_wtlx1 不在单据上；名字相近的：demo_wtlx`、`CONCATX 不在登记表也不是内置函数`。
  同一处第二次还错，返回会把两次输入并排、指出这一处改没改。
- **算一遍**：把内存里的候选规则按 `run rule biz` 同一套执行，打出条件真假、执行了哪些动作、
  写出的字段值。字段值用 `RULE_SET` 给（写法同 `run rule --set`），不给就是新单默认值；
  要多看几个字段加 `RULE_SHOW`。条件为假时公式动作不执行，公式本身写没写对要给一组让条件为真的值再预演：

```bash
BIZ_ENTITY=demo_wtd BIZ_HOST=demo_wtd BIZ_TAG='备注拼接-' BIZ_NAME='类型加后缀' \
BIZ_CONDITION="demo_wtlx = '炉前成分'" BIZ_TRUE="formula:demo_bz = CONCAT(demo_wtlx, '-A')" \
RULE_SET='demo_wtlx=炉前成分' \
  node .claude/skills/long-cosmic-dev/driver.mjs probe BizRuleProbe
# [PROBE]   seq=7 备注拼接-类型加后缀 条件 -> 是  [demo_wtlx = '炉前成分' = true]
# [PROBE]   demo_bz                        = 炉前成分-A
```

条件为真时公式动作执行失败（例如 `IF` 少一个参数，报平台原话「IF函数需要3个参数」）也停在写入之前。
携带、赋值两类动作在试算里执行不了，只记「试算没执行」，不拦。
试算只算规则这一层，不能写断言，也不算验收：插件、保存时的执行时机和别的操作带来的值，
落库后用 `run rule biz --expect`、`run op` 或 `run form --show` 核。

假分支使用 `BIZ_FALSE`：

```bash
BIZ_ENTITY=demo_bill BIZ_HOST=demo_entry BIZ_TAG='客户等级-' BIZ_NAME='等级映射' \
BIZ_CONDITION="demo_level = 'A'" \
BIZ_TRUE="formula:demo_result = '1'" \
BIZ_FALSE="formula:demo_result = '2'" \
  node .claude/skills/long-cosmic-dev/driver.mjs probe BizRuleProbe
```

回滚只删除描述以 `BIZ_TAG` 开头的规则：

```bash
BIZ_ENTITY=demo_bill BIZ_HOST=demo_entry BIZ_TAG='客户等级-' ROLLBACK=1 \
  node .claude/skills/long-cosmic-dev/driver.mjs probe BizRuleProbe
```

同样先 dry-run，再加 `APPLY=1`。`BIZ_TAG` 也是幂等抓手：新增前先摘掉同 TAG 旧规则，重跑不会
越加越多。可选参数：

| 参数 | 含义 | 默认 |
|---|---|---|
| `BIZ_TRIGGER` | 设计器保存的触发字段描述/表达式 | 空，由依赖字段自动推导 |
| `BIZ_CONDITION_DESC` | 设计器里给人看的条件说明 | 等于 `BIZ_CONDITION` |
| `BIZ_ENABLED` | `1` 启用，`0` 禁用 | `1` |
| `BIZ_ONLY_EMPTY` | 携带/映射时仅填空值 | `0` |
| `BIZ_RET` | 规则事件位 | `0` |
| `BIZ_ACTION_RET` | 动作事件位 | `253` |
| `RULE_SET` | 预演试算用的字段值，`字段=值;分录.字段=值` | 新单默认值 |
| `RULE_SHOW` | 预演试算时另外要看的字段，逗号隔开 | 只看改动规则写的 |

`RET` 是平台事件位，不清楚时保留默认；迁移既有规则时先用读模式抄真实值。

## 改已有规则

设计器里配的规则，描述没有 `BIZ_TAG` 前缀，按前缀摘不掉；为了改它再新增一条，就成了两条规则给同一个字段
赋值，谁后执行谁说了算。改已有规则用 `BIZ_RULE=<规则id>` 原位改：规则 id、动作 id、顺序和其余动作都不动，
设计器里看到的还是原来那条。id 取读模式输出的 `RULE seq=… id=…`。

```bash
# 条件里加一个组织
BIZ_ENTITY=demo_bill BIZ_RULE=5DEMO/RULE1= \
BIZ_CONDITION="org.number = '0101' or org.number = '0102' or org.number = '0301'" \
RULE_SET='org=0301' \
  node .claude/skills/long-cosmic-dev/driver.mjs probe BizRuleProbe
# [PROBE]   条件：org.number = '0101' or org.number = '0102'  ->  org.number = '0101' or … or org.number = '0301'
# [PROBE]   seq=3 组织限定 条件 -> 是  [… = true]

# 换掉给某个字段赋值的那个计算公式；多个用 ;; 隔开
BIZ_ENTITY=demo_bill BIZ_RULE=5DEMORULE002 BIZ_FORMULA='demo_jgfs = "4"' \
  node .claude/skills/long-cosmic-dev/driver.mjs probe BizRuleProbe
```

| 参数 | 含义 |
|---|---|
| `BIZ_RULE` | 要改的规则 id；`BIZ_HOST` 可不给，给了只在这个宿主里找 |
| `BIZ_CONDITION` | 新条件，整条替换；`BIZ_CONDITION_DESC` 是设计器里给人看的说明，不给等于新条件 |
| `BIZ_FORMULA` | `目标字段 = 新表达式`：换掉这条规则里给这个字段赋值的计算公式（成立、不成立两支一起找，要正好一个） |
| `BIZ_ENABLED` | `0` 停用、`1` 启用 |

三项至少给一项。预演逐项打「改前 -> 改后」，同样核表达式、跑候选试算；每一项都已经是要的样子时不出确认单。
只改本 ISV 自己的规则：实体是本 ISV 的、规则自己记的 isv 也得是，模板或标准产品带来的规则拒绝。
换动作类型（例如公式改成携带）不在原位改的范围里：不带 `BIZ_RULE`，按 `BIZ_TAG` 新增一条，并把旧规则 `BIZ_ENABLED=0` 停用。
`APPLY=1` 落库后探针从库里重新读这条规则，逐项报和要写的一不一致；撤回就用同一个 `BIZ_RULE` 把确认单上「改前」那一列写回去。

## 五类官方动作

官方知识列出的五类低代码业务服务都已参数化：

| 业务服务 | `BIZ_TRUE` / `BIZ_FALSE` 写法 | 设计态动作 |
|---|---|---|
| 公式计算 | `formula:目标字段 = 表达式` | `FormulaAction`，表达式必须含 `=` |
| 携带基础资料属性 | `carry:基础资料.属性->目标字段[, ...]` | `TakeBasePropertyAction` / `TakeBaseProAction` |
| 字段值映射 | `map:来源字段->目标字段[, ...]` | `SetEqutionAction` |
| 清除字段值 | `clear:字段1,字段2` | `ClearValueAction`，落入元数据后以 `:` 分隔 |
| 单位数量换算 | `qty:数量字段->基本数量字段[, ...]` | `FillQtyAction`，自动生成 `UnitConvertDTO` JSON |

例子：

```text
formula:demo_amount = ROUND(demo_qty * demo_price, 2)
carry:material.group.id->demo_materialgroup,material.model->demo_model
map:demo_source->demo_target
clear:demo_target,demo_amount
qty:demo_qty->demo_baseqty
```

来源字段可以是原厂字段或基础资料属性路径；**目标字段必须是当前 ISV 自己的字段**，探针会用
`IsvGuard` 拦截无前缀目标字段，并核对来源/目标是否存在。复杂函数先用 `meta formula biz --name`
查参数格式和说明，不凭样例猜参数。

## 元数据位置与执行结构

界面规则和业务规则都序列化为 `<Rules>`，但宿主和持久化对象不同：

| 规则 | 宿主 | 读取通道 | 动作目标 |
|---|---|---|---|
| 界面规则 | `FormAp` / `EntryAp.getRules()` | `readMeta(id, Form)` | 表单控件 Ap id |
| 业务规则 | `MainEntity` / `EntryEntity.getRules()` | `readMeta(id, Entity)` | 实体字段 key |

`FormRule` 继承 `BizRule`，两者条件都进入实体规则表达式链；这也是公共 `FunctionTypes` 能直接回答
界面规则和业务规则函数清单的原因。业务规则本体结构为：

```text
BizRule
├─ PreCondition / TriggerField / RET
├─ TrueActions: FormulaAction / TakeBasePropertyAction / ...
└─ FalseActions: 同一套动作
```

主实体和每个分录实体各有独立 `getRules()`。只看根实体会漏掉分录业务规则，写错 `BIZ_HOST`
则规则挂在错误的数据层级上。

## 验证与坑

- `BizRuleProbe` dry-run 同时调用每个动作的 `buildAction()`、规则的 `buildEntityRule(host)` 和
  `MetadataWriter.convertToDesignMeta(em)`；任一层报错都不保存。这三层都不解析表达式，
  表达式写错由上面「核表达式」那一步拦。
- `APPLY=1` 在常驻进程里写（见 probes.md「写元数据在常驻进程里写」）。写完直接在常驻上跑只读探针，核对宿主规则数、条件、真假动作和 runtime Map。
- 官方文档里的 `fx()` 表示可使用函数；真实 `DesignEntityMeta` 存的是
  `LEFT(field, 1)`、`MulBasedataInclude(field.number, '001')` 这样的直接调用，不要把 `fx` 当函数名写入。
- 条件表达式能解析不等于运行语义正确。下拉比较存储值，基础资料通常走 `.id` / `.number`，
  多选基础资料优先用 `meta formula biz --q 多选基础资料` 查到的 `MulBasedata*` 函数。
- 同一目标字段被多条规则写入时，后执行规则会覆盖前面的结果。新增前先读完整宿主规则并按 `seq`
  检查，不要只查同 TAG。
