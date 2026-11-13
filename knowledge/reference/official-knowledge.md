---
class: D
when: 按任务查官方插件指南、通用场景、SDK/API 语义
note: 只取 top 1～2
---

# 官方苍穹开发知识库：只读使用规则

> 定位：官方知识只提供平台语义、通用场景和候选 API；本 skill 的命令、安全红线、当前运行时
> 实测差异仍由对应 `reference/` 维护。当前工程最终以 `sig` / `findclass` / `lint` / `run` / `probe`
> 的结果为准。

- [配置与诊断](#配置与诊断)
- [两条通道：场景读表，标识符检索](#两条通道场景读表标识符检索)
- [写插件前的根流程](#写插件前的根流程)
- [不用记：lint / sig 会把入口摆出来](#不用记lint--sig-会把入口摆出来)
- [插件族路由表](#插件族路由表)
- [结果如何使用](#结果如何使用)
- [只读审计](#只读审计)
- [故障与退化](#故障与退化)
- [冲突登记](#冲突登记)

## 配置与诊断

在被 Git 忽略的 `config.json` 中配置：

```json
{
  "knowledgeRoot": "<app-build 安装目录>/.locales/<语言>/knowledge/cosmic"
}
```

也可以为单次命令设置 `COSMIC_KNOWLEDGE_ROOT`。路径必须直接包含
`platform/standards.md`、`platform/scenes/_index.md` 和 `platform/api/api-index.md`；不要指向
`app-build` 根目录或语言包的 `knowledge` 上一级。

```bash
node .claude/skills/long-cosmic-dev/driver.mjs knowledge status
```

fast-ai-cosmic 自带知识快照。知识包异常时 `doctor` 会报告安装健康问题；普通插件编译不会被
改造成一次人工文档打卡。已识别插件族若连确定性的目标 Capsule 都无法生成，`fast` 会在 Gradle
之前以 `KNOWLEDGE_GATE_UNSATISFIED` 拒绝；能生成时直接继续，并报告 digest、来源和投递状态。

## 两条通道：场景读表，标识符检索

**场景问题读表，别用 `search`。** 业务口吻的提问和索引关键词经常一个字都不重合
（「选完供应商带出联系人」对 `afterF7Select, 选择后, 关联数据, 回填`），字面匹配在这类提问上
**实测 recall@3 只有 3/10**；同一批提问读整表是 9/9。169 篇场景压成一张表才 12 KB
（`--plugin-type` 过滤后），一次会话读一次，之后所有场景查询免费。

```bash
D=".claude/skills/long-cosmic-dev/driver.mjs"

# 写单据/表单插件前的默认第一步：整表读，自己按语义挑 1~2 篇
node $D knowledge scenes --plugin-type billform     # 102 条 / 12 KB
node $D knowledge scenes --plugin-type listform     # 列表、左树右表
node $D knowledge scenes                            # 不确定插件族时读全表 / 22 KB

# 挑中之后读正文（路径要补回 platform/scenes/ 前缀，表头也写了）
node $D knowledge show platform/scenes/event/after-f7-select-process.md
```

### 坑：`--event` 只能判定 46% 的场景，剩下的一律保留

官方 `_index.md` 的**分节表头列数不一致** —— 27 个分节里 22 个是 5 列
（关键词 / 场景名 / 文件 / 状态 / pluginType），只有 5 个是 7 列（多 triggerEvent 和
controlType）。实测 **170 篇里 92 篇压根没有 triggerEvent 列**。

所以 `--event X` 的结果是「标了这个事件的」加上「没标过事件的那 92 篇」，不是
「只跟这个事件有关的」。看到 `--event nosuchevent` 仍返回几十行不是 bug。

判据：**标签为空是「未知」，不是「不匹配」**，空标签一律保留（`facetMatch` 返回
`unknown`）。反过来做会让那 92 篇在任何 `--event` 下整批消失且不报错 —— 索引里写
`—` 的才是显式的「无」，那 11 行照旧参与比对、匹配不上就淘汰。未索引场景同理：
它们的标签只能来自 frontmatter，而 frontmatter 没有 `plugin_type` / `control_type` 这两个键。

`search` 留给**标识符**：类名、方法名、FQCN。这类查询字面匹配就是正解。

```bash
node $D knowledge search kd.bos.orm.query.QFilter --kind api   # 精确 FQCN
node $D knowledge search 缓存 --kind sdk                        # SDK 横向专题
```

完整参数：

```text
knowledge scenes [--plugin-type <type>] [--event <event>] [--control <control>] [--include-draft]
knowledge search <关键词...>
  [--plugin-type <type>] [--event <event>] [--control <control>]
  [--kind guide|scene|sdk|api|all] [--limit 1..10] [--include-draft]
```

只有显式探查上游资料时才用 `--include-draft`；草稿不能直接进入编码依据。

### 下钻顺序

1. 当前任务对应的本地 `reference/`：确认工具、红线、实测差异和验证入口。
2. `guide`：确认插件家族、生命周期和上下文。
3. `scene`：**走 `knowledge scenes` 读表**；默认排除 `draft`。
4. `sdk`：查缓存、事务、锁、文件、线程池等横向专题。
5. `api`：按精确 FQCN 查单类语义；真实签名仍以 `sig` 为准。

### 低频标识符直接 Grep

方法名、常量名、`KDTX` 这类词，全库 grep 半秒出结果且精确（实测 `幂等` 命中 7 篇、
`batchSave` 命中 3 篇），比任何检索命令都直接 —— `knowledge search` 的 `api` 一档只索引
frontmatter 的 `api_class` / `when_to_use`，**正文里的方法签名不进索引**，按方法名查会返回空。
`knowledgeRoot` 的值从 `driver.mjs doctor` 拿。

## 写插件前的根流程

普通路径由 Harness 自动识别插件族，在业务 Java 的 write/edit 结果中投递目标 Knowledge Capsule，
随后直接 `fast`。Capsule 是 fast 的确定性知识事实，不是“模型已理解”的声明；它包含本次高成本
边界、真实签名线索、验证路线和按需正文入口。

下面的六步流程保留给复杂语义、低置信识别和失败诊断，不再是 fast 的准入打卡：

```bash
driver.mjs plugin <文件.java|平台基类名|场景标签>          # 第一步：指南全文 + 整张场景表
driver.mjs plugin <同一个目标> --scenes <篇1>[,<篇2>]      # 第二步：正文 + 签名 + 本地差量 + 记戳
driver.mjs plugin <无标签族> --scenes -                    # 官方没打标签的族没有场景可挑
```

六步一条线，中间不许跳：

| # | 做什么 | 谁给 |
|---|---|---|
| 1 | 判插件类型 | 认 `.java` 路径（会顺工程中间基类上溯）、平台基类名或场景标签 |
| 2 | 读官方 guide | 第一步把**全文**打出来，不是给个路径 |
| 3 | `knowledge scenes` 读表 | 第一步整表打出来，按语义自己挑 |
| 4 | 选 1~2 篇正文 | 第二步用 `--scenes` 带回来，正文打出来 |
| 5 | `sig` / `findclass` 核签名 | 给本族基类名，全限定名自己查 |
| 6 | 检查本地 runtime delta | 该族的本地页节目录，官方讲通用写法、本地只剩差量 |

这条查询不写任何戳；旧版的 `plugin-brief/1` 文件已不再读取，打开工程时会自动删掉。fast 只看
Capsule。实际投递事实写入 RuntimeKey 作用域的 `cosmic.knowledge-capsules/2` 文件，只保存 digest、
subject、sourceRefs 和时间，不保存 Capsule 正文。

### 事实：第四步是唯一能被机器验的一步

篇名必须真在这一族的场景表里，编一个不存在的会被当场打回，且**打回不记戳**。
其余五步机器只能把材料摆到面前，验不了有没有读。所以按需流程仍限制：**上限 2 篇**——
把整族 90 篇全塞进来跟一篇不读效果一样，都不是「照着这一篇做」，而挑不出来通常说明
还没想清楚要做的是哪件事。

### 坑：Capsule 按平台基类生成，不按 `pluginType` 合并

`printplugin` 底下 `AbstractPrintPlugin` 和 `AbstractPrintSeniorPlugin` 事件集不一样。
按 `pluginType` 合并的后果是一个基类的事件边界覆盖另一个 —— 两次都不报错，写出来的东西也
编得过。投递记录按 RuntimeKey 放在 `.cosmic-ai/work/capsules/` 下；换运行时不会复用另一套 JAR 的知识事实。

### 坑：lint 与 fast 必须读取同一份 Capsule 判据

`lint` 是可选诊断，`fast` 内部也会运行同一体检；两者的知识审计读取同一个 `pluginGate` 判据。
各写一套的后果是「lint 说 Capsule 可用、fast 说不可用」或反过来。无法生成 Capsule 的拒绝位置
在 `ensureBuilt()` **之前**：
排在后面就得先付一次 gradle 才被拒，而一个要人等两分钟才说「不行」的门禁，第二次就会被绕过。


## 不用记：`lint` / `sig` 会把入口摆出来

真实需求进来时，模型可能一篇官方文档都不读就开始写。普通路径不再靠它主动记住查询命令：

| 命令 | 什么时候响 | 打什么 |
|---|---|---|
| write/edit | 成功写入已识别插件 Java | 同一结果附目标 Capsule；业务源码自动进入 build |
| `lint` / `fast` | 体检的文件 `extends` 插件基类 | Capsule digest、来源、置信度和投递状态；不要求 knowledge 打卡 |
| `sig` / `findclass` | 主动核对类或成员 | 当前 JAR 真签名和按需官方入口 |
| `doctor` | 未配置知识源 | `[KB-MISSING]` + 怎么配；**`doctor` 自己永不失败**（配置没生效时先跑它） |

```text
[KB] AbstractBillPlugIn → 官方 billform 插件族。先看官方怎么做，别照记忆写：
[KB]   driver.mjs knowledge scenes --plugin-type billform   # 102 篇场景，整表读自己挑
[KB]   driver.mjs knowledge show platform/form-plugin.md
```

### 事实：官方只给一部分插件族打了标签

注册表（`tools/knowledge.mjs` 的 `PLUGIN_BASES`）第二列为空的族 —— 操作、BOTP、反写、
后台任务、工作流 —— 官方场景索引**压根没给它们打过标签**，所以这些族只给指南，不给
`--plugin-type`。看到「只有一行 `knowledge show`」是对的，不是漏了。

判据：**不许给它们编一个标签**。编出来的标签会让 `--plugin-type` 退回未标签基线
（全表 167 条里的 72 条），看起来筛过，其实一条都没筛掉。

## 插件族路由表

一族七件事：**sig 目标基类 → 场景表标签 → 官方指南 → 绑定确认探针 → 行为验证入口 →
本地 runtime delta 页 → 浏览器边界**。`plugin` 的六步全部从这一行取值。

```bash
node .claude/skills/long-cosmic-dev/driver.mjs knowledge routes
```

**这里不抄一份表** —— 唯一出处是 `tools/knowledge.mjs` 的 `PLUGIN_BASES`，抄进来的那份
一定会跟它漂，而漂了之后没有任何东西会响。上面那条命令随时能出全表，没配知识源也能出
（只是场景数一栏是 `?`）。

读表时两个符号不要误读：

- **场景标签 `—`**：官方场景索引没给这一族打过标签（操作、BOTP、反写、任务、工作流），
  只读指南，别硬套 `--plugin-type`。
- **行为验证 `（无无头适配器，起节点）`**：这一族现在确实没有 `run` 适配器，不是漏填。
  报表界面、反写、自定义 API 里收 HTTP 请求的 servlet 都在这一档。
- **浏览器边界 `未审计`**：**不等于「不用浏览器」，等于没人核过。** 这一栏存的是
  [界面事件覆盖审计](../docs/技术设计/界面事件覆盖审计.md)里的节名，不是结论 ——
  「要不要浏览器」是一个事件一个值（A/B/C/D/X 五档），不是一族一个值。按族给布尔值
  会得出「表单插件不用浏览器」这种在 `setWaterMarkInfo` 上直接错掉的结论。
  有节名时 `plugin` 把那一节原文摆出来，让人自己读分档。

`lint` / `fast` 的提示里出现 **`（经工程基类 X）`**，意思是这个类继承的是工程自己的公共基类，
路由顺着源码往上爬才找到平台基类。**这不是提示串了** —— 真实工程里这种类占比不小
（实测一个工程 315 个 `extends` 类里 43 个），只认直接父类的话它们跑 `lint` 一个字都不提示，
而「没提示」跟「这不是插件」长得一模一样。数字出处是 `tools/knowledge.mjs` 的
`climbToKnownBase` 注释。

某个**事件**到底能不能无头验，是一个事件一个值（A/B/C/D/X 五档），
权威出处是 [界面事件覆盖审计](../docs/技术设计/界面事件覆盖审计.md)，不在这张按族的表里。

## 结果如何使用

每条结果给出类型、状态、版本、相对路径和命中原因。读取候选正文：

```bash
node .claude/skills/long-cosmic-dev/driver.mjs knowledge show \
  platform/scenes/event/property-changed-set-value.md
```

`show` 只接受知识根目录内的 `.md` 相对路径，会拒绝绝对路径、`..` 和符号链接逃逸。

官方示例进入业务代码前必须依次经过：

1. `findclass` 或精确 FQCN 确认 import；
2. `sig` 确认构造、字段和方法；
3. `lint <Java 文件>` 做整文件 API 体检；
4. 业务代码有变化时先 `fast`；
5. 用静态算法探针、`run op/form/list/flow` 或其它真实入口验证。

`sig <FQCN>` 在配置知识源后会把 `when_to_use`、`framework_version` 和官方相对路径追加在真实
JAR 签名之后。官方文档不会过滤、替换或补造反射结果。

## 只读审计

```bash
node .claude/skills/long-cosmic-dev/driver.mjs knowledge audit
node .claude/skills/long-cosmic-dev/driver.mjs knowledge audit --strict
```

审计入口文件、场景/API 索引、重复/未索引场景、版本分布和 Markdown 相对链接，并在运行前后对
全部 Markdown 做 SHA-256 清单比对。上游已知的重复、未索引和失效链接作为 warning；缺失索引目标
或源目录发生变化会失败。命令不提供写入、修补或同步能力。

## 故障与退化

| 情况 | 行为 |
|---|---|
| 内嵌知识包不可用 | fast 报安装健康降级并指向 `doctor`；已识别族无法生成 Capsule 时在 Gradle 前拒绝，不要求模型用 knowledge 打卡 |
| 路径错误 | 明确列出缺失入口；若误指向 app-build 根目录则给出目标目录提示 |
| 官方单类文档缺失 | `sig` 仍完整输出真实签名，并提示改查 guide/scene |
| 文档版本为 7.5.x | 标记历史候选 |
| 文档版本高于常见 8.0.1 | 标记小版本风险，必须由当前 JAR 复核 |
| 官方内容与当前运行时冲突 | 以当前 JAR、元数据和真实运行结果为准，记录冲突路径 |

## 冲突登记

上表最后一行要求「记录冲突路径」，登记就在这里。**一条一行，先写裁决依据，再写结论落在哪。**
只登记「官方这么说、当前运行时不这样」或「两边看着矛盾其实条件不同」的，用词分歧不登记。

| 官方路径 | 表面矛盾 | 裁决依据 | 实际结论 |
|---|---|---|---|
| `platform/scenes/print/05-hide-widget.md` | 官方说 `setHideMove(true)` 隐藏且下方上移；本地实测隐藏后收不回高度 | `sig BeforeInitWidgetEvent`（全类仅 `getWidgetKey` + `setHideMove`）对比 `sig BeforeOutputWidgetEvent` | **不是冲突，是事件阶段不同**：`beforeInitWidget` 里生效，`beforeOutputWidget` 里不生效。见 [plugin-print-runtime.md](plugin-print-runtime.md#隐藏表格不会收回设计高度) |
| `platform/scenes/print/07-dynamic-column.md`、`08-row-merge.md` | 官方用 `addGridRow` / `insertGridRow`，本地文档用 `addRow` / `insertRow` | `sig BeforeOutputGridEvent`（24 个方法） | **两套并存**，返回类型不同（`List` vs `PWGridRowBo`），都不是幻觉 |
| `platform/task-plugin.md` | 官方通篇用 `feedbackProgress` / `checkIsStop` / `isStop`；本地文档曾断言「当前 `AbstractTask` / `Task` 签名中查不到，不要照抄」 | 探针反射逐层打印 `AbstractTask.getDeclaredMethods()` | **官方对，本地错**：四个方法都在 `AbstractTask` 上，全是 `protected`。已修正 [plugin-integration.md](plugin-integration.md#后台任务)；官方唯一的小错是 `feedbackProgress` 第三参写成 `Object`，实际是 `Map` |
| `platform/writeback-plugin.md` 骨架模板 | 官方写「所有重写方法必须调用 `super.xxx()`」，本地反对这类一刀切规则 | `AbstractWriteBackPlugIn` 是纯基类继承；监听器接口方法没有基类实现可调 | **各自成立，别互相推广**：官方那句只对这一个纯基类插件有效，判据见 [plugin-dev.md](plugin-dev.md#正确处理-super-调用) |

发现新冲突时先跑 `sig` 再登记；**没有 `sig` 或探针证据的不要写进这张表**，
否则它会退化成第二份主观笔记。

完整设计、授权边界和分阶段验收见
[官方知识库复用方案](../docs/技术设计/官方知识库复用方案.md)。
