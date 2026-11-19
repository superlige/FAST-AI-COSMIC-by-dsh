---
class: A
when: 免界面跑操作、表单、列表、规则、打印、BOTP 下推、工作流插件，以及直接调本工程类的方法
note: 正常路径按 cosmic_run 的工具说明组合参数；被拒、拿不准或首次失败时再读全文
probes: ProbeAssert.java@358eead601de, ExpectSpec.java@3a22e27875d0, PrintSim.java@d0e5fec2cd60, CallSim.java@4ff18e7b315d, CallArgs.java@17c32989d5b4, PushSim.java@bc6c94cf4602, WfSim.java@6937308b25ab
---

# run —— 免界面跑真实业务动作

来源：真实苍穹 8.0 工程实测。

> 正常路径按 `cosmic_run argv=["help","<子命令>"]` 给的参数和例子组合 argv（只写 `["help"]` 是总览和字段路径、值的通用写法）；工具会在编译新鲜度检查和 JVM 之前生成运行计划、附上对应的知识卡片，
> 并一次返回全部能机械判定的参数问题。被拒、拿不准或第一次运行失败时，再读这篇全文。
>
> `run form` / `run list` 在启动前会拿影响面索引对一次：目标标识上没有本工程的插件登记、而同实体的兄弟布局上有时，返回里会先给一条提醒，点名该挂哪个布局。它不拒绝——想验实体本身是正当的——但这条提醒不核对就采信结果，等于把另一份插件清单跑出来的 PASS 当成本插件生效。没有索引可读时，这项检查会如实登记为未做。

预检拒绝是 `RUN_PRECHECK_FAILED`，一次带齐三样东西：`blockers` 是全部阻碍，
> `deferred` 是因前置事实缺失而**没做**的检查（例如 argv 没解析成计划时，目标关联源码的
> 外部动作扫描就没跑，这不等于扫过了），`estimatedCost` 是执行会花的进程数与冷启动数
> —— `--case` 合批仍然是 1。

**目标是消灭「部署 → 起节点 → 登录 → 点界面」这条人工验证链。**
不起 Jetty、不开浏览器、不部署，在探针进程里把真实运行时跑起来，用断言代替肉眼。
机制、三把钥匙、非目标见 [免界面验证](../docs/技术设计/免界面验证.md)，本篇只讲怎么用。
某个基类事件是已覆盖 / 可补齐 / 只能浏览器验收，见 [界面事件覆盖审计](../docs/技术设计/界面事件覆盖审计.md)。

- [运行真提交](#运行真提交)
- [`--set` / `--expect` 的路径与值](#--set----expect-的路径与值各适配器同一份实现)
- [run op：操作插件](#run-op操作插件)
- [run form：表单插件](#run-form表单插件)
- [run list：列表插件](#run-list列表插件)
- [run rule：规则求值](#run-rule规则那一层算出来是什么)
- [run print：打印插件](#run-print打印插件的最终输出)
- [run call：直接调本工程类的方法](#run-call直接调本工程类的方法)
- [run push：BOTP 转换插件](#run-pushbotp-转换插件)
- [run wf：工作流插件](#run-wf工作流插件)
- [交互回调](#验交互回调beforef7select-这一族)
- [事实](#事实)
- [坑](#坑)

```bash
node .claude/skills/long-cosmic-dev/driver.mjs run op   <实体> <操作> [--set 字段=值 …] [--pk id | --billno 编号] [--filter 字段=值]
node .claude/skills/long-cosmic-dev/driver.mjs run form <表单标识>     [--set 字段=值 …] [--pk id | --billno 编号] [--status new|edit|view] [--f7 F7字段key]
                                                        [--op 操作] [--click 按钮key] [--hyperlink 分录[行].字段] [--show 字段,…]
                                                        [--cache 键=值 …]
                                                        [--expect 字段=值|控件.visible=true|分录[行].字段.enabled=false|opened=页面|message=片段 …]
                                                        [--select 分录标识=行号,…] [--skip 插件简名,…] [--events] [--calls N]
node .claude/skills/long-cosmic-dev/driver.mjs run list <列表布局> [--filter 字段=值 …] [--main-org id,…] [--limit 1..200] [--summary] [--mobile]
                                                        [--select pk,…] [--click 按钮|--op 操作] [--row-click pk]
                                                        [--row-double-click pk] [--hyperlink pk:字段] [--callback id:结果]
                                                        [--tree-node id|--tree-toolbar key] [--cache 键=值 …] [--skip 类,…] [--events] [--calls N]
node .claude/skills/long-cosmic-dev/driver.mjs run rule form <布局>  [--set 字段=值 …] [--row N] [--show 控件,…]
                                                        [--expect 字段.visible=true|字段.enabled=false …]
node .claude/skills/long-cosmic-dev/driver.mjs run rule biz  <实体>  [--set 字段=值 …] [--host 宿主] [--row N] [--show 字段,…]
                                                        [--expect 字段=值 …]
node .claude/skills/long-cosmic-dev/driver.mjs run print <模板编码> (--pk <单据ID> | --billno <单据编号>) [--set 字段=值 …] (--expect 格子=值|表格key[行]=… … | --show 格子|表格key|数据源 …)
node .claude/skills/long-cosmic-dev/driver.mjs run call <类名>#<方法名>[(类型,…)] [--args <JSON 数组>] [--expect 路径=值 …]
node .claude/skills/long-cosmic-dev/driver.mjs run push <转换规则id> (--pk <源单内码> | --billno <源单编号>) (--expect 目标单字段=值 … | --show 字段,…)
node .claude/skills/long-cosmic-dev/driver.mjs run wf <插件类名>[#方法] [单据标识] (--pk <单据内码> | --billno <单据编号>) [--node 节点] [--ctx 键=值 …]
                                                        [--set 字段=值 …] (--expect 路径=值 … | --show 字段,…)
node .claude/skills/long-cosmic-dev/driver.mjs run callback …   # 父子页那一族，见 run-parent-child.md
node .claude/skills/long-cosmic-dev/driver.mjs run flow …
```

| 我要验的 | 用哪条 |
|---|---|
| [操作插件](plugin-operation.md) / 校验器（保存、提交、审核放不放行，报什么错） | `run op` |
| [表单插件](plugin-ui.md)（打开表单、改值之后插件做了什么、弹了什么话） | `run form` |
| 点某个按钮之后会怎样 | `run form --click <按钮key>` |
| 点分录某一格的超链接之后会怎样（打开哪个页面、带什么参数、弹什么话） | `run form --hyperlink <分录[行].字段>` |
| 点开一个 F7 字段，插件给它加了什么过滤 / 会不会拦住 | `run form --f7 <F7字段key>` |
| 列表过滤、动态列、首屏取数、按钮/行/树节点事件 | `run list` |
| 移动端插件（打开移动端页面、改值之后插件做了什么） | `run form <单据>_mob`，独立的移动表单、移动单据写它自己的标识 |
| 移动端列表插件（移动端列表的过滤、列、取数） | `run list <单据> --mobile` |
| 子页面 `close()` 能否经真实缓存自动回调父插件 | `run callback`，见 [run-parent-child.md](run-parent-child.md) |
| 父插件能否自己打开正确子页，随后完成关闭回调全流程 | **`run flow`（优先）**，同上 |
| 某个字段值下界面规则把哪些字段显隐/锁定了 | `run rule form` |
| 某组输入下业务规则把目标字段算成什么值 | `run rule biz` |
| 打印插件改了某个格子的取值（取数、合并、占位符、行转列） | `run print` |
| 调度任务、导入插件、[自定义 API 插件](plugin-integration.md#自定义-api)，或插件里抽出来的计算方法（合并、分组、换算） | `run call` |
| [BOTP 转换插件](plugin-operation.md#botp-转换插件)（下推出来的目标单字段是什么值） | `run push` |
| [工作流插件](plugin-integration.md#工作流插件)（到某个节点、审批人选某个决策项时插件改了单据什么；超时、参与人、会审结果算成什么） | `run wf` |

- **所有运行都走常驻进程**。`run rule` 只读、不建 View、不开事务。
- 带操作的路径在门口过一道 `IsvGuard.assertOwnEntity`：授权范围只到本 ISV 单据。

## 运行真提交

连的是**纯测试环境**，运行和界面上点一下一样，实际执行的写入不自动回滚：

- 走平台自己的保存、操作路径，缓存跟着更新，**在常驻进程里跑**（热的打印约 8 秒）。
- 操作成功不等于表单输入已保存；打开子页、计算等操作可能只改变内存。接着验库中单据写 `--pk`。
- 插件发消息、调接口、存附件的**照跑**，前检只在提醒里列出来：「走到它时会真的发出去」。

写元数据（字段、表单、打印模板、规则、登记）不在此列，照旧要用户确认。

**「数据库现状」只回读编号和单据状态，不证明本次字段输入已保存。** 要确认字段保存结果，需要数据库字段回读。
同一张单提交、审核过之后状态就变了，同一条命令再跑结果可能不同：先看这行再决定换单还是先反审核。

**碰巧对上的断言会被标出来。** 上一次运行改过的值会留在单上；`--set` 每个字段都会打出原值
（`set demo_jssj = 30（原值 12）`）。`run op` / `run form` / `run wf` 打开已有单据时，`--expect` 里这次没 `--set` 的字段
如果跑之前就已经是期望值，结果里多一行
`⚠ 断言 demo_x=A 跑之前单上就是这个值，这次也没 --set 它：PASS 证明不了是这次改出来的……`。
PASS 照记；要证明是这次改出来的，在 `--set` 里先给它一个别的起始值。`run print` 断言的是格子文字，不做这个对照。

提醒的判据是「元数据里真登记了」，不是「源码里提到过」：拿的是代码关系表里的插件登记
（和平台装插件读的是同一份），插件自己的源文件和它经本工程工具类调到的方法都算。没有代码关系表时退回按源码关联判，提醒里会明说「可能是误判」，
补一次 `cosmic_doctor action=reindex`（不带 `srcOnly`，要连环境）就能换成前一种判据。

编码规则流水号照常消耗，不随任何东西退回。

## 以谁的身份跑：`--user`

每个子命令都收 `--user <用户名|姓名|用户id>`：整次运行换成这个人登录。插件、校验器里取到的当前用户，列表按人算的数据范围，
落库的修改人，都是他。不给是配置里的用户。

- 按用户名、姓名、id **完全相同**认，只认启用的用户；对不上、或同名的不止一个，拦下并列出查到的人。
- 输出第一条提醒是「以 某某（用户名 …，id …）的身份跑」；验证记录照原样记下 `--user`，单独重跑也是同一个人。
- 一次运行一个身份：`--case` 批量把 `--user` 写在第一个 `--case` 之前；要对比几个人的结果，按人拆成几次运行。
- 例：`run list demo_room --user demo_emp --expect rows=7`；
  `run op demo_room save --set demo_enable=true --expect success=false --expect message=管理员 --user demo_emp`。

## `--set` / `--expect` 的路径与值（各适配器同一份实现）

字段断言按属性类型逐层读取。`基础资料.number` 读取关联对象的编码，`分录[0].基础资料.name` 读取该行关联对象的名称；只有集合使用行号，省略行号默认第 0 行，普通对象不能写行号。`分录[0].id` 读取该行内码，不回退单头。对象为空、字段缺失或行号越界时，报告“取不到值”并保留原始路径，不把读取失败当成实际值不符合预期。这样可以直接核对关联资料及行身份，避免因路径歧义产生错误断言。

`op` / `form` / `list` / `callback` / `flow` / `rule` / `push` / `wf` 的字段路径和值转换是**同一份代码**
（`ExpectSpec.Pos` + `ExpectSpec.convert`）：一条 `--set` / `--expect` 在一个子命令下写对了，
抄到另一个子命令，写法和值的类型不变。

### 路径：三段

```bash
--set 字段=值                        # 表头
--set 分录标识[2].字段=值             # 分录第 3 行（下标从 0 数）
--set 分录标识[2].子分录标识[1].字段=值  # 子分录：父行 [2] 下的第 2 行
```

- **下标可以省，省掉等于 `[0]`**：`分录标识.字段` 就是 `分录标识[0].字段`。
- `--set` 时**行不够会自动补**（父分录、子分录都补）；`--expect` 不补行，读不到那一行就是这一条断言取不到值。
- 第四段及以后没有对应的数据结构，会连着点留在字段名里，报「没有这个字段」——如实，但写不了。
- `run form` / `callback` / `flow` 写分录时**当前行会跟着挪到那一行**：插件里大量
  `getValue(key)` 读的是当前行，只写值不挪行的话插件看到的还是第 0 行。
- **当前行不是选中行**：`getValue` 读当前行，`control.getSelectRows()` 读的是浏览器
  回传的选中行，两者各走各的。`run form` 不给 `--select` 时按 `--set` 写过的分录行
  模拟选中（真实前端里改一行的值必然先点中那一行），要指定就写
  `--select 分录标识=0,2`，要验「一行都没选」那条分支写 `--select 分录标识=`。
  `run flow` 用 `--select`（配 `--parent-entry` 时可以只写行号），`run callback` 和
  `run op` 没有选中行这个概念。
- `--expect` / `--show` 用的是同一套写法。

**哪个子命令支持到第几段**（不一致是真实的，不是遗漏）：

| 子命令 | 表头 | 分录 | 子分录 |
|---|---|---|---|
| `run op` | ✅ | ✅ | ✅ |
| `run form` / `run callback` / `run flow` | ✅ | ✅ | ✅ |
| `run rule form` / `run rule biz` | ✅ | ✅ | ❌ **明确拒绝**：规则求值的宿主只有表头和分录两层，按两层处理会把叶子字段写到父分录行上（父分录恰好有同名字段时就是一次「成功」的错误赋值）。给了子分录路径会打一行 `⚠ 跳过` 并继续，不会静默写错 |
| `run list` | — | — | — |

`run list` 不造单据，压根没有 `--set`；给了会被**当场拒绝**并告诉你哪个子命令读它，不是静默忽略。
（同一族的其他参数也一样：`--show` 只有 `run form` / `run list` 读。）

### 值：按字段类型转，不是按字面猜

| 字段类型 | 怎么写 | 说明 |
|---|---|---|
| 空 / `null` | `--set 字段=` 或 `--set 字段=null` | 清空。**代价**：文本字段写不了字面量 "null" |
| 单选基础资料 | `--set 字段=1234567890`、`--set 字段=001` 或 `--set 字段=WL001` | 纯数字先按 id 查，id 不存在就保留原字面按 `number` 查（所以 `001` 不会变成编码 `1`）；两边都查不到会**当场报错**，不会静默写成 `null` |
| 多选基础资料 | `--set 字段=WL001,WL002` | 逗号分隔 → id 数组 |
| 日期 / 时间 | `yyyy-MM-dd`、`yyyy-MM-dd HH:mm:ss`、`now` —— 如 `--set 字段=2026-09-04 08:30:00` | 只认这三种；**非法日期直接报错，不顺延**（`2026-02-31` 不会变成 3 月 3 日） |
| 小数 / 整数 / 布尔 | `--set 字段=12.50`、`--set 字段=true` | 转成对应包装类型 |
| 下拉 / 多选下拉 | `--set 字段=A`（**存储值**，多选逗号分隔） | 原样传。写成某一项的显示名会在执行前被拒，见下面 |
| 文本及其余 | 原样 | |

> **下拉存的是存储值。** ComboProp 存的是 items 里的**值**；平台收到显示名会原样存进去，界面显示空白且不报错。
> 所以 `--set` 写的值不是任何一项的存储值、却正好是某一项的显示名时，执行前就拒绝，并给出对应的存储值
> （`下拉 demo_x 要写存储值，「正常」是显示名；写成 A`）。存储值和显示名都对不上的不拦：下拉项可以由插件在运行时补。
> 全部合法值用 [`FieldLimitProbe`](metadata-entity.md#写值之前--fieldlimitprobe) 查。

值断言支持 `--expect 字段=@nonempty`：null、空串、只有空白、空集合不通过；0 和 false 算有值。
`--expect 字段=` 验空；`--expect 字段=/` 只验字面斜杠。
要比保留写法本身，用 `@literal:` 前缀，例如 `--expect 字段=@literal:@nonempty`。
取不到字段仍然失败，不会被非空断言当成有值。包含断言 `~=` 保持按文本片段比较。

断言侧同源：基础资料按 `number` 比（不是 `toString()`，那打的是「类型 + 存储数组」，拿它跟编码比必红），
多选按集合比（多选本身没有顺序，让断言随排列顺序红是错的）。日期断言写 `yyyy-MM-dd` 时只比日期，
写 `yyyy-MM-dd HH:mm:ss` 时比到秒；不会再拿 JVM 的 `Tue Sep 01 00:00:00 CST 2026` 文本与 ISO 字面量硬比。

### `run op --set` 和 `run form --set` 不是一条路

| | `run op` | `run form` |
|---|---|---|
| 写到哪 | `DynamicObject.set` | `model.setValue` |
| 触发 `propertyChanged` | ❌ | ✅ |
| 什么时候用 | 只想把单据摆成某个状态再跑操作 | 要验的正是「改值之后插件做了什么」 |

## run op：操作插件

```bash
run op demo_sys_test_bill save                       # 造空单跑保存
run op demo_sys_test_bill save --set demo_bgbh=X-1 --set entryentity[2].demo_qty=5
run op demo_sys_test_bill save --set entryentity[0].subentryentity[1].demo_qty=5   # 子分录
run op demo_sys_test_bill submit --pk 2550820804057116672
```

- `--set` 走 `DynamicObject.set`（不触发 `propertyChanged`）。路径三段、值怎么写，见
  [`--set` / `--expect` 的路径与值](#--set----expect-的路径与值各适配器同一份实现)：
  分录 `分录标识[2].字段=值`、子分录 `分录标识[2].子分录标识[1].字段=值`，行不够自动补。
  字段名写错会把最接近的真名贴出来（只从**该层**的属性里挑，不拿表头同名字段来凑）。
- `--expect` 的三个保留字断言操作结果：`success=true|false` 成没成；`message=片段` 界面弹出的提示里有这段——
  校验器拦住时提示顶上是一句「数据校验发现错误。」，下面逐条列出每个校验器的原话，两部分都算；
  `error=片段` 只在逐条列出的错里找。其余键是单据字段路径。
- **验「会被拦」写 `success=false` 加 `message` / `error` 时，逐条列出的错每一条都要对得上写明的某一句**，
  有对不上的，报「✘ 输入不成立」并列出那几条、不留验证记录：拦住它的不只是要验的那条，「没成功」算不到它头上。
  例如拿一张已经提交过的单验新加的提交校验，平台的「只有暂存的数据才允许提交」会一起报。
  换一张只会被要验的那条拦住的单（提交要暂存的单）；几条本来就该一起出现的，各写一条 `error=`。
  只写 `success=false`、不写原因的，照旧只看成没成。
- `--pk` 打开已有单据（验 `submit` / `audit` / `unaudit` 这类），`--set` 在它之上覆盖。
  **单据状态覆盖不了**：平台的提交、审核、反审核一开始就按内码把单据状态从库里重读一遍（审核、反审核连 `enable` 一起），
  传进去的值被盖掉，校验器和插件看到的是库里的状态。所以已有单上 `--set` 这几个字段、值又和库里不同的，
  报「✘ 输入不成立」、不跑、不留验证记录。要验哪一步，就挑库里正处在那一步之前的单（审核要已提交的单），
  或者先跑前一步操作（`submit`、`unaudit`）把它推到那一步。新建的单（不给 `--pk`）没有库里的状态可读，`--set` 照常生效。
- **要验「连着的单是某个样子时，这张单怎样」，写 `--set @上游.<单据标识>.<字段>=值`**（连着的是下游单写 `@下游.`，
  分录字段写 `@上游.<单据标识>.<分录>[行].<字段>=值`），要配 `--pk` / `--billno`。这个场景跑之前，
  工具按转换路线记录找到这张单连着的那类单（有几张改几张，最多 10 张），直接存库改上、回读，不走那类单的校验器和插件；
  然后取这张单、跑操作、判断言；跑完照原值改回，输出里打「已改回…回读都是原值」。
  - 跑的过程中那个字段被这次操作改成了别的值（比如提交时插件反写上游），不覆盖，打一行「⚠ … 跑的时候被改过，没改回」并给出原值。
  - 连着的不是这类单、字段写错、分录没有那一行、值转不过去，算输入不成立，这个场景不跑；
    不给 `--pk` / `--billno`、写在别的子命令上，起 JVM 之前就拒。
  - 分录只改已有的行，不补行。

  ```bash
  run op demo_sys_test_bill submit --case 上游没填标准 --billno SYSJC-0001 --set @上游.demo_qty_wtd.demo_bglx=3 --set @上游.demo_qty_wtd.demo_ysbz=null --expect success=false --expect error=验收标准没填 --case 上游填了标准 --billno SYSJC-0001 --set @上游.demo_qty_wtd.demo_bglx=3 --set "@上游.demo_qty_wtd.demo_ysbz=GB/T 228.1" --expect success=true
  ```
- **手里只有单据编号就写 `--billno <编号>`**（op / form / flow / print / push / wf 都认），工具按这张单的编号字段查出内码，
  输出里会打一行「单据编号 X → pk=Y」，后面几次直接写 `--pk Y`。`--pk` 和 `--billno` 只能给一个。
- **`submit` / `unsubmit` / `audit` / `unaudit` 既没给 `--pk`、也没 `--set` 单据状态时，起 JVM 之前就拒**
  （`RUN_ARGS_INVALID`）：新建的空单状态是空的，状态校验一定拦，补齐别的必填字段也过不去。
  二选一：给 `--pk`，或者先把状态摆好（`--set billstatus=A`，有的单叫 `status`，只认标识以 `status` 结尾的）；
  本来就要验「会被拦」的，写 `--expect success=false`。
- **操作没成功时，字段断言一律记「不算数」**（FAIL，原因写明），不管值对不对：
  那时读到的是插件改过的**内存对象**，单据根本没存进去（例如提交撞主键失败，`creator_id` 的值照样对得上）。
  要验的正是失败分支、想顺便看字段的，写上 `--expect success=false`。
- `--filter 字段=值` 缩小行数对照的范围，大表上省一次全表 count。

输出契约，一行一条：

```
[PROBE] 结果 isSuccess=false  成功=0  message=数据校验发现错误。
[PROBE] 校验器 提交 报 1 条
[PROBE]   [校验] 请填写"委托单编号"。   字段标识：demo_fnumber（委托单编号）
[PROBE] 跑之后行数=195  （无痕）
```

**校验失败行尾会补上实体字段标识**，含分录和子分录的字段。校验器只说人话，而同一张单上
常常既有 `billno`（单据编号）又有 `demo_fnumber`（委托单编号），光看文案补不对字段；
这一跳不该留给调用方再跑一轮 `MetaProbe` 反查。
文案引号里的名字和某个字段的中文名**完全一样**时只给那一个：光按包含匹配，
「量具名称」和「量具名称（拉伸、腐蚀）」会一起列出来，挑之前看清楚。
没有完全一样的才把包含命中的全列出来（猜一个比列两个危险）。

**操作抛异常时打的是整条因果链**，每一环各打自己的类名、消息和栈顶 6 帧，最后一行指出
栈里第一帧本工程的类在哪一行：

```
[PROBE] 抛异常 java.lang.NullPointerException: (无)
[PROBE]   异常 kd.bos.KDException: 操作失败
[PROBE]       at kd.bos.service.operation.OperationServiceImpl.localInvokeOperation(OperationServiceImpl.java:187)
[PROBE]   Caused by: java.lang.NullPointerException: (无)
[PROBE]       at demo.zljy.opplugin.QTYWTDOpPlugin.setDefaultJgfs(QTYWTDOpPlugin.java:88)
[PROBE]   出错的是本工程的 demo.zljy.opplugin.QTYWTDOpPlugin.setDefaultJgfs(QTYWTDOpPlugin.java:88)
```

栈里一帧本工程的类都没有时，它只说抛异常那一刻在跑平台代码，并列出这次操作挂着哪些本工程插件。
插件和它加的校验器先跑完、交给平台的东西（报错提示、写到单上的值）后面才出错，栈里同样没有本工程的类，
所以「栈里没有」不能当成「不是本工程的问题」。
被折叠的**无归属**运行时异常（`[RUNTIME-WARN]`）也会带上最里层那 3 帧。

运行走常驻进程：冷启动的一次性初始化只在进程第一次起来时付一次（约 30 秒），之后每次运行几秒到十几秒，插件链越长越慢。

操作执行最多等 5 分钟；`--case` 两个或更多场景整批最多等 10 分钟。打印、附件和操作后的核对也算在内，
不需要额外参数。超时只代表工具停止等待，业务线程可能仍在执行或已经落库，不能当成“已取消”。
超时或写入请求发出后答复不完整，都不会自动重跑这次操作；先只读查单据状态和业务字段。
常驻进程因上次超时拒绝新请求时，工具先更换这个失效进程，再执行新请求，后续查询可继续复用。

### `--case`：一次跑完多个场景

`--case` 把一条命令切成多个场景段，**一次运行按顺序跑完**：

```bash
run op demo_bzwz_wl save   --pk 2552980953672728576 --set demo_byzjl.demo_iabyz=99 --expect success=true   --case 首次录入   --set number=T1 --set demo_byzjl.demo_iabyz=7 --expect success=true   --case submit路径 --op submit --set status=A --set number=T2 --expect success=true   --case 不改值反例 --pk 2552980953672728576 --expect success=true
```

几个场景合成一次跑，比一个一个跑省下每次的进程准备开销。

- 段内语法和不分段时**一字不差**，不用记两套规则。
- 紧跟 `--case` 的非 `--` 词是**场景标签**，会成为断言归属的 case 号；不给就自动编号
  `场景N`。标签之外后续段不许再有位置参数（分不清是标签还是别的），重名当场拒绝。
- `--op` 可以在段内改操作；`--pk` / `--set` / `--expect` / `--filter` **各段独立，不继承**
  —— 悄悄继承上一段的 `--set` 是会写出错误结论的那种便利。
- 实体是整批共用的（`run op` 的位置参数）。要换实体就另起一批。
- 每个场景**独立取单、按顺序真提交**：前一个场景写的留在库里，后一个场景取同一张单时看到的是改过的样子。
  所以每个场景断言要靠的字段都在本段 `--set` 里给值，别指望上一段的值「还在」或「已经没了」。
  `--set @上游.…` 改的连着的单是例外：每个场景跑完就改回，后一个场景看到的是原值。

**验证记录是一个场景一条**，各自带着能单独重跑的那条命令 —— 交付判据按场景说
「这一个最后一次是不是过的」，所以场景必须拆得开。

> **边界（重要）**：场景之间没有隔离，库和缓存都是连着的，这和用户在界面上连着点几下是一样的。
> 要验「一张干净的单」就在那一段里新建（不给 `--pk`），或者把要的字段全在本段 `--set` 里给齐。
> 批量结果和单跑结果不一致时，**以单跑为准**，并且先看两次之间单据被改成了什么样。

## run form：表单插件

```bash
run form demo_wtd_xbl --set demo_jylx=2                       # 开表单 + 改值，2 秒
run form demo_sys_test_bill --pk 2550820804057116672 --skip QTYWTDFormPlugin --click bar_save
run form demo_qty_wtd --pk 2550820804057116672 --events       # 打开已有单据 + 事件明细
run form demo_qty_wtd --set demo_checkboxfield=true --show demo_qbfc,demo_jgfs_head,demo_syentry.demo_jgfs
run form demo_qty_wtd --set demo_syentry[1].demo_zj1=2 --select demo_syentry=1 --click demo_advconbaritemap
run form demo_bill --pk 100001 --hyperlink demo_entry[0].demo_contractno --expect opened=demo_progress --expect opened.contractno=HT-001
```

- `--set` 走 `model.setValue`，**会触发 `propertyChanged`** —— 这正是要验的东西，
  和 `run op` 的 `DynamicObject.set` 不是一条路。路径三段（子分录 `分录[0].子分录[1].字段`）、
  值按字段类型转，见 [`--set` / `--expect` 的路径与值](#--set----expect-的路径与值各适配器同一份实现)。
- `--pk` 对单据和基础资料有效（元数据的 `modelType` 含 `bill` 或是 `base`），动态表单会直接拒绝并说清楚。
- **移动端页面**：`run form <单据>_mob` 开单据带的移动端页面（运行时的标识，内容是单据布局里那份移动端布局），
  独立的移动表单、移动单据写它自己的标识。按平台的移动端视图开，插件拿到的是移动端视图；`--pk`、`--set`、`--expect` 照常用。
  基础资料按基础资料的视图开（和平台一样按打开参数选视图），插件里调 `setBillStatus` 这类单据视图方法照常有。
- **打开走的是平台自己的流程**：新增和 `--pk` 都经 `loadData`，派发 `beforeBindData` / `afterBindData`。
  单据配了布局方案、平台读完数据转去另一张布局时，跟过去开那张，输出头几行写「实际打开的是布局 X」——
  后面的插件、事件、界面状态都是 X 的，`--expect` 里的控件也按 X 查。打开时平台报错（业务规则引用了不存在的字段这类）
  照实打出来（出错的插件和栈顶），后面的步骤照常跑。
- **`--status view` 按查看打开**（要带 `--pk`）；不写按有没有 `--pk` 定新增或修改。打开已有单据和从列表点修改一样：
  已提交、已审核的单按已提交、已审核开。
- **页面状态是平台最后发给浏览器的那个**，锁定性、可见性按它算：插件调 `setStatus` / `setBillStatus`、
  操作成功后平台按单据状态重发，都按最新的算。只改单据状态字段的值不换页面状态（新单 `--set billstatus=B` 还是新增）；
  要看提交后的锁定，打开一张已提交的单（`--pk`），或者跑提交操作（`--op submit`）。
  输出里「页面状态：…」那一行写明是哪个状态、谁发的。
- **插件改的显示、锁定、必录用 `--expect` 断言**，写法和 `run rule form` 一样：

  ```bash
  run form demo_bill --pk 100001 --expect demo_entry[0].demo_qty.enabled=false   # 分录第 0 行这一格锁了
  run form demo_bill --pk 100001 --expect demo_entry.demo_note.visible=false     # 分录这一整列隐藏
  run form demo_bill --pk 100001 --expect demo_entry[1].enabled=false             # 分录第 1 行整行锁定
  run form demo_bill --set demo_type=2 --expect demo_panel.visible=false --expect demo_amount.mustInput=true
  ```

  值只写 `true` / `false`。字段、控件、分录写错的在改值、点按钮之前一次报全，记「输入不成立」、不留验证记录，改对再跑。
- `--click` 点工具栏按钮，按钮绑的操作从元数据自己解析，不用另外给。
- **`--hyperlink 分录[行].字段` 点分录这一格的超链接**（子分录 `分录[行].子分录[行].字段`），走表格控件的
  `hyperLinkClick`，和浏览器里点那一格同一条派发：插件要在 `registerListener` 里给这个分录 `addHyperClickListener`，
  没挂的输出直接说「没有插件给这个表格挂超链接监听」。点的那一行成为当前行和选中行。点的是已有的一行，
  新单先用 `--set` 写出那一行；行号超出、写成表头字段的，开表单之前就退回。不提交，插件自己查库、调外部接口的照做。
  和 `--click` / `--op` 一次只给一个。
- **动作的效果用三个保留字断言**（按钮、操作、超链接都能用）：
  - `opened=页面标识,…`：这次打开了哪些页面，不看顺序；`opened=`（留空）是一个都没开；`opened~=页面` 是包含。
  - `opened.参数=值`：唯一打开的那个页面带的参数（插件 `setCustomParam` 放的；打开单据时还有 `pk`），`~=` 是包含。
    参数名照输出里「捕获 showForm」下面那几行「参数 名 = 值」抄。打开了不止一个页面时报「没法判断」，不算过。
  - `message=片段`：弹给用户的话里有这一段（提示、错误、成功通知、消息框都算；插件抛业务异常 `KDBizException` 拒绝这一下，浏览器弹的那句报错也算）；`message=`（留空）是一句没弹。
  例如「某组织下点合同号打开进度页、别的组织照旧打开原页面、合同号为空时提示」，三种情况各跑一次：
  `--expect opened=demo_progress --expect opened.contractno=HT-001`、`--expect opened=demo_old_page`、
  `--expect opened= --expect message=合同号为空`。
- `--f7` 模拟点开一个基础资料字段，只跑到 `beforeF7Select` 为止（**不弹列表**），
  报出插件加的过滤条件、或者它把 F7 拦住了。放在 `--set` 之后跑，所以能验「先选 A 才能选 B」。
- **`--show 字段,…` 打这些字段的终值**（分录写 `分录标识.字段`，每行一条）。写界面路径（`控件.visible`）或面板、按钮的标识，
  在「界面状态」一段点名打它显示、可编辑、必录的结论和由来。
  「插件事件 +N」只说明联动被触发了，说明不了它写对了值 —— **验联动结论必须看终值**，
  否则「改对了」和「改成了另一个错值」长得一模一样。跑在 `--op` / `--click` 之后。
- **`--select 分录标识=0,2` 定分录选中行**（`control.getSelectRows()` 看到的就是它）。
  不给时按 `--set` 写过的行自动选中；`--select 分录标识=`（等号后留空）是显式的「一行没选」。
  **`type=donothing` 的计算按钮通常第一行就 `getSelectRows()`**，取不到就 `return` 并弹
  「请先选择要计算的分录行」—— 那不是插件算错，是根本没走到算的那一步，判据看「弹给用户的话」。
- `--cache 键=值` 预置页面缓存。真实会话里有些键是**前序请求**写进去的，仿真里是空的，
  插件当场 NPE —— 见下面「坑」。
- **每个动作是一次请求，和浏览器一样**：打开、每一条 `--set`、按钮/操作/超链接/F7 各一次。请求之间提交真实 Redis
  页面缓存和模型缓存，再按 pageId 从缓存重建页面、`registerListener`，数据模型从缓存现取；`--show`、`--expect`
  读的是最后一次请求提交进缓存的数据。输出里「请求 N（…）：按 pageId 从缓存重建页面」一行一次。

## run list：列表插件

```bash
run list demo_ypcfwz --filter enable=1 --limit 20 --events
run list demo_ypcfwz --select 2454561429991212032 --click demo_baritemap
run list demo_sys_test_bill --tree-node <节点id>
```

列表过滤的单值和逗号分隔的多个值中，带前导 0 的整数形式按字符串传递。例如 billno=04022611040002 保留完整编号；普通整数内码仍按整数传递。


真 `ListView / IListModel / ListViewPluginProxy` 驱动初始化、过滤、建列和首屏查询；自动识别
`bos_list` 与 `tree_bos_list`。默认 20、上限 200；合计只在显式 `--summary` 时查。
主动交互经 `IsvGuard` 后真提交（见上文「运行真提交」）。非目标：`CtsyListView`、
导出/打印、浏览器视觉渲染、递归启动子界面和跨请求 Redis 会话。

- **`--mobile` 开单据带的移动端列表**：平台的移动端列表视图，列是移动端列表卡片上的那几列，装的是移动端列表上登记的插件。
  移动端列表没有筛选栏里的主组织，也没有左树，`--main-org`、`--tree-node`、`--tree-toolbar` 不和它一起用。

- **选的、点的行必须在这次查出来的首屏里。** `--select`、`--row-click`、`--row-double-click`、`--hyperlink`
  给的主键不在首屏时，在执行动作之前退回、不留验证记录，输出里列出这次列表的过滤条件——界面上选不到列表
  没查出来的行，被主组织、权限范围或插件加的条件挡在外面的单据也一样。用 `--filter`、`--main-org` 让它
  查得出来再跑；行数多、排不进首屏的加 `--filter id=主键`。
- **`--main-org 组织内码,…` 等于在筛选栏里换主业务组织。** 不给就是当前登录组织。只能换成当前用户在这张
  单上有查看权限的组织；写的是内码、不是编号。单据没有主业务组织字段时列表不按组织过滤，这个参数用不上，
  会被退回。

## run rule：规则那一层算出来是什么

**不建 View、不装插件、不落库**，只拿「元数据里的规则 + 一份内存单据」算结论。
分两条命令是因为**输出契约不同**，一条命令两种输出 agent 消费不了：

| | `run rule form` | `run rule biz` |
|---|---|---|
| 第一个参数 | 布局标识 | 实体标识（布局不等于实体） |
| 宿主 | `FormAp` / `EntryAp.getRules()` | `MainEntity` / `EntryEntity.getRules()` |
| 结论 | 每个字段可见/可编辑，以及是第几条规则定的 | 目标字段被算成什么值 |
| `--expect` | `字段.visible=true` / `字段.enabled=false` | `字段=值`、`分录.字段=值` |
| `--show`（只打值） | 任意控件标识（字段、面板、分组、分录都行）：打可见/可编辑终态和归因 | 任意字段路径：打它此刻的值 |

```bash
run rule form demo_wtd_xbl --set demo_jylx=3   --expect demo_bz.visible=true --expect demo_syzt.visible=false
run rule form demo_sys_xbl --set demo_jylx1=3 --list visible      # 把判定为显示的字段全列出来
run rule form demo_wtd_xnl --set demo_basejylx=JYLX_0101_008 --show demo_flexpanelap   # 改前看一眼面板现在显不显示
run rule biz demo_xnl_gzbz --set demo_qcdw=SC08 --expect demo_xnl_qcdwlb=2
```

**改前看一眼用 `--show`。** 写成 `--expect` 等于在断言「改之前的样子是对的」：
改完代码之后，这条记录的源码指纹对不上、直接作废；照原样重跑一遍它必红，
这个场景就算没过。`--show` 只打值、不断言，也不留验证记录。
一次调用只算一个场景；`--case` 只有 `run op` 有。

### `run rule form` 的显隐判据：三层，缺一层结论就是错的

`visible` 是三件事的合力，只算规则那一层会把一大批看不见的字段判成显示：

| 层 | 取什么 | 实测量级（`demo_sys_xbl`，1782 个控件 / 1342 个字段） |
|---|---|---|
| ① 自身静态 | `isInvisible()`、`isHidden()`、`getVisible()` 场景掩码 | **323 个字段自身 invisible**，4 个 visible 不覆盖场景 |
| ② 父链传播 | 祖先容器任一不可见 → 自己不可见 | **964 个字段是被容器连带的**，占隐藏总数的七成 |
| ③ 界面规则 | `Show*`/`Hide*` 按 `seq` 覆盖，作用于字段**和容器** | 20 个 |

**`getVisible()` 六项全开不等于显示** —— `invisible` 是设计器里独立的「隐藏元素」开关，
业务上大量共用布局靠它藏掉别的场景的字段，而这些字段的 `visible` 往往是全开的。
只看 `visible` 在这张布局上会多判 300 多个字段。

输出按**最小控件粒度**（`FieldAp` / `EntryFieldAp`）给结论；容器出现在归因里，
被规则直接动过的容器另列一段，点名的控件（`--show`）单列一段：

```
字段控件 1342 个：显示 31，隐藏 1311
  隐藏归因  容器连带 964 | 布局invisible 323 | 界面规则 20 | visible不覆盖场景 4
--- 造成连带隐藏的容器 ---
  容器 demo_advconap13(直读光谱（完整）分析计算值) 布局invisible  连带 59 个字段
  容器 demo_entryfieldgroupap18(力学检验) seq=3假                连带 19 个字段
```

归因指向**最上面那个真正被关掉的容器**，不是直接父亲 —— 一层层报中间容器看不出根因。

| 参数 | 作用 | 默认 |
|---|---|---|
| `--scene all\|init\|new\|edit\|view\|submit\|audit` | `all` 要求 `visible` 六项全开才算显示；给具体场景则该场景在掩码里就算 | `all` |
| `--list visible\|hidden\|all` | 打全量字段清单。不给只打统计 + 被规则动过的 + 连带容器 | 不打 |
| `--show 控件,…` | 点名打这些控件的终态和归因（容器也行），不断言、不留验证记录 | 不打 |
| `--branch hide-wins\|both\|true-only` | 分支语义，见下 | `hide-wins` |

`--expect` 能断**布局上任意控件**（facts 收的是全部控件的终态），包括没被规则动过的；
容器也能断（`demo_entryfieldgroupap.visible=true` 这种分录字段组展没展开是常见验收点）。

### 坑：假分支执不执行，平台没有明面契约

界面规则条件为假时走 `falseActions`，而这批动作里通常是「把别的场景的字段 Show 回来」。
**它到底在打开单据时执行不执行，决定了一大片字段的结论**，三种语义各有说得通的地方：

| `--branch` | 语义 | 用它算出来会怎样 |
|---|---|---|
| `hide-wins`（默认） | 真假分支都执行，但规则一旦把某控件隐藏，后面的 `Show` 不再把它显示回来 | 两头都对得上 |
| `both` | 纯按 `seq` 后盖前 | 被前面规则隐藏的字段，会被后面规则的假分支 Show 回来 |
| `true-only` | 只执行条件为真的规则的真分支 | 假分支里的 `HideControl` 不执行，别的场景的容器全放出来 |

**默认取 `hide-wins` 是按线上实际界面反推的，不是平台契约**：`demo_sys_xbl`
金相场景（`demo_jylx1=3`），`both` 算出可见的 8 个字段（单位/上下限/检验结果值/探伤级别/
铸锭块号/剥落腐蚀/晶间腐蚀）用户在线上确认看不到；而 `true-only` 又会把力学、硬度那批
本该隐藏的字段放出来。只有 `hide-wins` 跟界面一致。

探针每次跑**两种语义各算一遍**，把结论不同的字段单独列出来：

```
--- 分支语义分歧 12 个字段（hide-wins vs both）---
  demo_unit    hide-wins=隐藏  both=显示   单位
```

**分歧字段就是这次结论最不该被当成定论的部分** —— 落到它们身上时去界面上看一眼，
或者用 `run form --show` 交叉验。分歧 0 个才说明结论不依赖那个未定的契约。

### 坑：插件还会再改一轮显隐，静态判据够不着

布局挂的表单插件在 `afterBindData` 里 `setVisible` 是常规做法（`demo_sys_xbl` 上
`SysTestFormPlugin` 有 37 处、`WtdXblFormPlugin` 3 处），按运行时数据动态控显隐。
`run rule` 只算规则那一层，**算出来的"显示"必然是上界**。插件改完是什么样，用 `run form` 跑那张单：
「界面状态」一段列出插件、规则改过的控件和是谁改的，`--expect 控件.visible=…` 直接断言。

- 界面规则按 `seq` 累积；输出里的 `(seq=7真)` 就是定下这个状态的那一条，
  `(容器 xxx seq=3假)` 表示是被那个容器连带的。
- 统计和打印按字段粒度走；**被规则直接动过的容器**另列一段「被界面规则改过的容器」，其余容器只作为归因出现。
  任意容器的 `visible` / `enabled` 照样能 `--expect`，只想看就 `--show 容器标识`。
  按钮的**外观**仍不算数：`run form --click` 验证的是点击后的插件/操作链，
  两者都不能替代浏览器可见性验收。
- 业务规则的动作由**平台自己的动作类**执行（公式计算、携带基础资料属性、单位换算都是它算的），
  探针不重算任何语义。条件支持 `LIKE` / `and` / `or` 和函数目录里的全部函数。
- 分录规则要 `--host 分录标识`（不给就跑全部宿主）和 `--row N`。

### 它和 `run form --show` 的分工

`--show` 打的是运行态**终值** —— 插件、界面规则、业务规则三者合力的结果；
`run rule` 只算规则那一层。**值不对的时候两个一起跑，就知道该去改插件还是改规则。**
显示、锁定也一样：`run rule form` 能按场景（`--scene`）算规则层，`run form` 的「界面状态」是这一次打开、改值之后
插件和规则合起来的结果，每条写着是谁定的。

实测两边一致（`demo_xnl_gzbz`，`demo_qcdw=SC08`）：`run rule biz` 算出
`demo_xnl_qcdwlb=2`、`demo_orgfield1=0101`，`run form --show` 打出同样两个值，
且与库里那条真实单据一致。不一致就说明差额是插件写的。

## run print：打印插件的最终输出

```bash
run print demo_sys_test_bill_jxzyw --pk 2560941241403458560 --expect datacell9=@literal:/
run print demo_sys_test_bill_prtpl_58 --pk 2560941241403458560 --show layoutgrid_cnas_data --show LayoutCell72
run print demo_sys_test_bill_prtpl_58 --pk 2560941241403458560 --show 数据源:jxsy
run print demo_sys_test_bill_prtpl_58 --billno SYSJC-20260701-0259 --expect "layoutgrid_cnas_data[1]= | 112 | 12608140008-1 | 合格 | 合格 | 不合格" --expect "layoutgrid_cnas_data[1][3]=低倍组织"
run print demo_sys_test_bill_jxzyw --pk 2560941241403458560 --set demo_entryentity_jxsy[1].demo_ypbh_jxsy=1-1 --set demo_entryentity_jxsy[0].demo_bz_jx=甲 --set demo_entryentity_jxsy[1].demo_bz_jx=乙 --expect datacell9=甲，乙
```

拿一张真单据出一次打印，断言**打印插件改完之后**格子里最终输出的文字。带 `--expect` 且全过的那次才算验过。

- **第一个参数是模板编码**，不是单据标识；`--pk`（或 `--billno 单据编号`）必给；`--expect` 和 `--show` 至少给一个。
  误把单据标识写进来，探针会报「模板编码查不到」并列出这张单上的模板。
- **格子怎么写**：模板里的控件名（`datacell9`，`PrintGridDumpProbe` / `PrintTplDesignProbe` 能查到），
  或者这个格子绑的字段（`demo_bz_jx`，模板里只有一个格子绑它时才能这么写）。
  `datacell9[1]=值` 指第 2 行明细（从 0 数）；不写下标就是**每一行**都要等于；`datacell9~=片段` 是包含。
  写错的格子名在出打印之前就停下，并按拼写相近给候选。
- **想先看现在打出来什么，用 `--show`，不要写故意不过的断言去「看」**：`--show 表格key` 把整张表这次的最终输出逐行打出来
  （格子用 `|` 隔开，**包括插件新插的行、列**），`--show 格子` 打这个格子每一行的文字。只有 `--show` 的运行不算验证、不留记录。
- **插件新插的行、列没有模板控件名**：`--expect 格子名` 只看得到模板里本来就有的那几行。某个格子「只输出了 1 行」
  不等于插件没跑——插件插出来的行在那张表里。断言没过时，返回里会把那个格子所在的整张表一起打出来，不用再跑一次去看。
- **断言插件插的行，用表格 key 带下标**：`表格key[行]=a | b | c` 比整行（格子用 `|` 隔开，每格去掉首尾空白再比，
  `|` 两边空不空格都行，空格子留空），`表格key[行][列]=值` 比一格（原文），行号列号都从 0 数，
  就是 `--show 表格key` 打出来的那个编号；`~=` 照样是包含。**插件写法照需求写**，插件插的行用这种写法照样断言得到。
- **插件取某个字段取到空，用 `--show 数据源` 看数据行里到底有什么**：它列出插件拿到的每个数据源、每个分录（写成 `主单.分录`）
  有几行、有哪些字段（业务插件 `afterLoadData` 之后的样子）；`--show 数据源:jxsy` 只看名字含 `jxsy` 的。
  **打印引擎只查模板用到的字段**，模板里没有格子绑的字段，数据行里就没有，插件 `getField` 取到的是空。
  例如一张模板没有格子绑检验项目，分录数据行里就没有 `demo_jyxm`；另一张模板绑着 `demo_jyxm.name`，
  同一张单同一个分录就带 `demo_jyxm.id`、`demo_jyxm.name`。以 `--show 数据源` 打出来的为准。
- **改插件之前先列一张取数表**，每个要打出来的值写清四件事：取哪个字段（完整路径）、在表头还是分录、
  打原值还是显示文字、带不带单位。然后在目标单上用 `DataQueryProbe` 查一次核对，再写代码。
  - 取值来源只用查询认出的字段；查询说「元数据里没认出字段」的路径，打印数据行里就算有同名字段也不用。
  - 查询说某字段不在分录上，就按查询结果到表头取。
  - 拿不准的（同名字段有两个、要不要单位、单选还是多选、哪些检验项目算同一类），放进唯一那次提问里一起问用户，
    在动手前问清。
- **数据库里没有想要的数据时**：拿任意一张现成单据，用 `--set` 把字段改成要测的样子。
  写法和 `run op` 的 `--set` 一样（含分录行）。它只走保存，不走操作插件；**真提交**，改完这张单就是这个样子，
  每个字段都打出原值。断言要靠的字段都在这次 `--set` 里给值（见上文「防假通过」）。
- **两边的行号不是一回事**：`--set` 的 `[i]` 是**分录第 i 条**，`--expect` 的 `[i]` 是**打印出来的第 i 行**。
  打印插件按试样号之类合并行时两者对不上：4 条分录合成 2 行，只清 `[0]`、`[1]` 两条分录，第 2 行还是剩下两条拼出来的
  `23，23`。写 `--set` 之前先用 `DataQueryProbe` 查清这张单实际有几条分录、各自是什么。
- **同一场景只认最后一次**：场景 = 命令去掉 `--expect`，也就是「模板 + `--pk` + `--set`」。
  拿同一组 `--pk` / `--set` 故意跑一条反例，会把前面那条正例的 PASS 顶成 FAIL，这个场景就算没过——
  运行返回里当场会说。反例要留作通过证据就写成符合预期的断言；仍有失败就照实写没过。已落库的操作复查先读原日志，不为改断言而重复写库。
- **冷热**：带不带 `--set` 都走常驻。常驻里第一次出打印要预热打印引擎（约 35～55 秒），之后每次约 5～8 秒。
- **副作用**：出打印走的是预览，数据库**不写**打印结果表；平台留下一份临时 PDF 和一条缓存，3 小时内自己过期。
  模板上的打印插件里有外部接口、发消息这类调用的照跑，前检在提醒里列出来——出打印时它们会真的发出去。
- **它验不了的**：排版位置、图片尺寸、换行截断、分页——那些用 `PrintMeasureProbe` 量；它不算验过。
- **完成情况里分开说**：格子文字断言过了，只说明「文字对」，版面只核对了格子里的字，请用户预览一张看看；
  「怎么验的」照实写验的是打出来的字，不写成验过了版面。

原理（给改 harness 的人）：打印内核建插件列表时会回调平台的「打印单元测试」登记口
`PrtUnitTestFacadeFactory`，`PrintSim` 借它挂一个只读观察插件，在每输出一行时记下每个格子的文字；
格子在运行时只剩设计器 id，所以先读模板设计把控件名换成 id。插件新插的格子没有设计器 id，
所以同时按表格（`PWGridBo.getKey()`）逐行记下整行，`--show 表格key`、`表格key[行]` 断言和断言失败时的整表输出读的是这一份。
观察插件登记在业务插件后面，它的 `afterLoadData` 记下每个数据源数据行的字段名（`DataRowSet.getFieldKeys()`），`--show 数据源` 读的是这一份。

## run call：直接调本工程类的方法

```bash
run call demo.zljy.printplugin.MetallographicBilingualPrintPlugin#collapse --args [[{"demo_ypbh_jxsy":"A-1","demo_bz_jx":""},{"demo_ypbh_jxsy":"A-1","demo_bz_jx":null}],["显微组织"]] --expect size=1 --expect [0].demo_bz_jx=@literal:/
run call demo.ygwc.task.lfjuge.LfJugeUpdateValidityTasl#execute --args [{}] --expect error=
```

调度任务、导入插件、报表取数里的计算，以及插件里抽出来的纯逻辑，没有表单或单据可以跑。`run call` 直接调那个方法（真提交：方法里写库就真的写进去），带 `--expect` 且全过的那次才算验过。

- **目标写 `类名#方法名`**：全类名，或本工程里不重名的简单类名。同名重载分不清时写 `#方法名(List,List)`。
  只调**本工程源码里**的类；静态方法直接调，实例方法用无参构造器建一个对象再调，私有方法也能调。
- **`--args` 是一个 JSON 数组，一项对一个参数**，作为 argv 里的一项整个放进去；无参方法写 `[]` 或不写。
  按方法签名造，写错会报「第几个参数、哪个字段、要什么、给的是什么」：
  - 字符串、数字、布尔照 JSON 写；日期写 `"2026-01-01"` / `"2026-01-01 08:00:00"` / `"now"`；枚举写名字。
  - 列表、数组、Set 写 JSON 数组，Map 写 JSON 对象，元素按泛型类型造。
  - **打印数据行 `DataRowSet`** 写 `{字段:值}`：字符串 → 文本字段，整数 / 小数 → 数值字段，`null` → 空字段，
    对象数组 → 分录；日期写 `{"@date":"2026-01-01"}`。
  - **单据数据对象 `DynamicObject`** 写 `{"@entity":"实体标识", 字段:值, 分录:[{…}]}`，按实体元数据逐字段核对；
    加 `"@pk":单据ID` 就先取那张现成单据再改（分录给了就整组替换）。基础资料写 id / 编码，或 `{"name":"显微组织"}` 按字段查，必须正好一条。
  - **过滤条件 `QFilter`** 写 `["字段","比较符",值]`，几条并且写 `[[…],[…]]`；比较符照 `QCP` 写（`=`、`in`、`like`、`is null`…），`is null` 可以不写值。
  - **构造器只收一个 Map 的对象**（例如 `ApiSerializerModel`）写 JSON 对象，按那个 Map 造好再 `new`。
  - **`RequestContext` 参数工具自己给当前登录上下文，不占 `--args` 的位置**：调度任务 `execute(RequestContext, Map)` 写 `[{任务参数}]`。
- **`--expect` 的路径**：
  - 直接写是**返回值**：`$` 是返回值本身，`[0].demo_bz_jx` 是第 1 项的字段，`size` 是个数；
    打印数据行按字段名取、单据按属性取、Map 按键取，别的对象按 getter 取。
  - `args[0]…` 是**调用之后**的第 1 个参数（`RequestContext` 不算）——方法是 void、改的是传进去的列表时用它。
  - `error=` 断言没抛异常；`error~=片段` 断言抛了、且异常消息里有这个片段。
  - `~=` 是包含；`=null` 断言是 null。
- **前检（起 JVM 之前，按源码判）**：类不在本工程源码里、方法名拼错（给候选）直接拦。
  再从这个方法的方法体出发，顺着它调到的本类方法、用到的本工程类往下查：
  碰到发消息、调接口、附件，照跑，只在提醒里列出来（会真的发出去），并写明是从哪条引用链走到的。
  别的类只以 `类.方法(…)` 用到的只查那几个方法，其余用法整个文件算。
- **调不起来的**：插件里用到 `getView()` / `getModel()` / 事件上下文的实例方法——那些只有真跑插件时才有，
  在 `run call` 里 NPE，报「输入不成立」。改用 `run form` / `run op` / `run print`，或者把计算抽成静态方法。
  报表取数的 `query(ReportQueryParam, Object)` 造不出参数，同样把取数后的计算抽出来调。
- **输入写错不留记录**：类、方法、参数对不上时报「✘ 输入不成立」，不留验证记录，改对再跑（和 `run print` 一样）。
- **冷热**：走常驻进程。
- **调度任务**：给一个 `runcall-…` 的 taskId；任务里发的进度消息打在输出里，不发给调度服务。
- **`--args` 只收内联 JSON，不收文件**：验证记录要原样记下这次喂进去的是什么，复查的人照抄命令就能重跑。

## run push：BOTP 转换插件

```bash
run push 2424161753291052032 --billno SFLF-20260920-00000018 --expect demo_supply=安徽利来汽车技术有限公司 --expect bills=1
```

按一条转换规则把源单下推并保存，**从数据库重新读取目标单后断言**，保存和反写插件照常执行。转换插件必须用这条路线确认落库结果；没有保存回读记录不能交付。

- **目标写转换规则 id**，源单、目标单从规则里读。改了转换插件时，预检给的验证路线已经按代码关系表填好 id；
  插件挂在几条规则上时列出来，挑要验的那条。自己查用 `cosmic_meta botp list --plugin <插件类名>`。
- **源单**写 `--pk <源单内码>` 或 `--billno <源单编号>`。规则按分录下推（源分录不是主实体）时，整张源单的分录行全部选中。
- **`--expect`** 的路径写在目标单上，和 `run op` 一样（`字段`、`分录[0].字段`，基础资料按编码比）；
  `[1].字段` 指第 2 张目标单（规则按分单策略可能从一张源单生成好几张）。
  保留字：`success=true|false` 下推成没成、`message=片段` 平台提示里有这段、`bills=张数` 生成了几张。
  平台提示是总提示加每张源单没推成的原因（前面带「源单 编号：」），日志里打的 `message=` 就是断言比对的那一份。
  `--show 字段,…` 只打值、不断言。
- **输出先列规则上挂的转换插件和启停**。没有启用的本工程插件时会明说：这时全过只证明规则的字段映射，先去查插件挂没挂、启没启用。
- **真提交**：工具明确执行目标实体的 `save` 操作，按返回的目标单主键逐张从数据库重新读取，不使用转换缓存里的对象做断言。输出列出实体和主键，保存或回读失败就不能确认结果；失败后先读日志及查询目标单，不能直接重推。
- **基础资料对象和外键分开核对**：`--show` 同时显示对象内码与实际外键；`--expect` 自动检查两者一致，落库以外键为准。跳过复制时用 `cosmic_probe name=MetaProbe`，env 给 `META_ENTITY=<目标单>`，列出对象及外键、多选集合行；除跳过字段外，再断言一个必须复制的对照字段，防止整块复制未执行却误判通过。
- **先复现数据库里的值**：用户报的是 SQL 字段值时，先只读查询该列，再准备可区分源值和目标值的测试数据，按保存回读路线验证；不能用内存对象替代数据库观察点。
- **下推没成功时 `message` 是平台的人话**：「不符合转换规则的数据筛选条件」是源单没过规则的源单过滤，换一张源单；
  「目标单主组织赋值失败」多半是规则配置的问题（例如缺转换插件），与这次改动无关。
- 规则 id、源单查不到报「✘ 输入不成立」，不留验证记录，改对再跑。
- **冷热**：走常驻进程，热的时候一次下推一秒上下。

## run wf：工作流插件

```bash
run wf ReplyRejectionMessageWorkFlow --billno GDDDEPTPLAN202609030190 --ctx message=考核数据不全 --expect demo_reply_message=考核数据不全
```

直接调一个工作流插件（`IWorkflowPlugin`）的方法，**流程不真跑**：插件挂在哪个流程、哪个节点、什么时机，从已发布的流程定义里读，
照引擎的样子拼出它拿到的流程上下文，调一次，断言方法返回值和插件跑完之后库里的单据。带 `--expect` 且全过的那次才算验过。

- **目标写插件类名**，调哪个方法按它在流程里挂的位置定：节点监听（进入、离开节点，审批人提交某个决策项）调 `notify`，
  超时设置调 `getExpireTime`，参与人设置调 `calcUserIds`。输出开头列出它挂的每一处。
  流程里没挂的（例如还没配进流程的会审插件），写成 `run wf <类名>#<方法> <单据标识> --pk <单据内码>`。
- **单据**写 `--pk` 或 `--billno`，要是挂它的流程的单据，预检给的验证路线里写着是哪几种。
  挂了好几个节点时默认第一处，`--node <节点名称或编码>` 挑。
- **上下文用 `--ctx 键=值` 给**，可重复：`message` 审批意见（不给就是决策项名称，和界面上不填意见一样）；
  `decision` 决策项编码（审批人提交决策项时触发的监听，默认就是它监听的那个；写了节点上没配的编码报输入不成立，并列出节点配的）；
  `approvers` 当前审批人（用户 id 或工号，逗号分隔，默认调试进程的用户）；`starter` 发起人（默认单据创建人）；
  `param.键` 插件参数；`var.键` 流程变量；会审插件用 `vote=用户:approve|reject[:决策项编码]`（一票一个）和 `pending=还没投的票数`。
- **上下文和引擎给的是同一种东西**：当前节点是用平台的节点对象包的已发布流程里的真节点，节点名、编码和真跑时一样；
  审批意见是多语言 JSON 文本（`{"zh_TW":…,"GLang":…,"zh_CN":…}`），插件要自己取 `zh_CN`；审批记录表 `wf_hicomment` 里存的是纯文字。
- **`--expect`** 读插件跑完之后从库里重新取的单据，字段路径和 `run op` 一样。`result`、`result.字段` 是方法返回值：
  参与人列表 `result=id,id`、`result.size`；会审结果 `result.pass`、`result.over`、`result.resultNumber`；超时分钟数、条件判断写 `result=`。
  `error=` 断言没抛异常、`error~=片段` 断言抛了；键后加 `~` 是包含。`--show 字段,…` 只打值。
- **插件新加的分录行在哪一行，先 `--show 分录.字段` 看**（不写行号时逐行打）：插件 `addNew()` 后直接保存的行序号是 0，
  排在有序号的行前面，同一张单跑过几次就有几行序号 0。
- **真提交**：插件保存单据就真的保存了。同一张单再跑，上次写的值还在，输出里会标「跑之前单上就是这个值」；
  `--set 字段=值` 先把单据改成要的样子再调插件（只走保存，限本 ISV 单据）。
- **验不到的**：引擎会不会在这个节点调它（看输出开头的挂载位置）、流转、参与人最后算成谁。
  插件里取当前用户（`RequestContext`）拿到的是这次运行的用户（`--user` 给的，没给是配置里的），不是审批人；审批人从上下文取。
- 类、单据、节点、决策项对不上报「✘ 输入不成立」，不留验证记录，改对再跑。
- **冷热**：走常驻进程，热的时候一次十秒上下，插件本身多在一秒内。

## 验交互回调（`beforeF7Select` 这一族）

插件的回调分两族，**在仿真里的可达性完全不同**：

| 族 | 谁派发 | 例子 | 前提 |
|---|---|---|---|
| 插件代理 | `FormViewPluginProxy.fire*`，共 23 个 | `initialize` / `afterBindData` / `beforeDoOperation` / `confirmCallBack` / `customEvent` | 装上插件就会收到 |
| **控件监听器** | 控件自己的 listener 列表 | **`beforeF7Select`** / `click` / `itemClick` / `afterF7Select` | **插件必须在 `registerListener` 里 `addXxxListener(this)` 挂上去** |

第二族的全部前提是 **`registerListener` 得跑完**。它被别的插件的异常截断，或者插件自己
因为读不到页面缓存而 NPE，这里就一条监听器都没有 —— **F7 会「放行且无过滤」，看着像插件没写过滤逻辑**。
所以 `--skip` 和 `--cache` 不是可选项，是这一族能不能验的开关。

实测（`demo_sys_test_bill` 上的 `QTYWTDFormPlugin`，同一个 F7 字段 `demo_cpbz_hxcf`）：

| 条件 | 结果 |
|---|---|
| 不给 `--cache` | 插件在 `registerListener` 里 `getControl(getPageCache().get("jylx_base"))` → NPE，整条链断 |
| `--cache jylx_base=demo_jylx --cache org=demo_org` | `registerListener OK`，监听器挂上了 |
| 合金为空 | **F7 被拦住**（`setCancel(true)`），并报出理由「错误: 请先选择合金」 |
| `--set demo_hj=6061`，组织为空 | 仍被拦住，理由变成「错误: 请先选择组织」—— 分支往后走了一格 |
| `--pk` 真单据（组织已填）+ `--set demo_hj=6061` | **放行**，过滤条件 `org.id = 1274703489246692352 AND demo_hj.name = '6061'` |

输出分五块，每块都是断言目标：

| 块 | 说明 |
|---|---|
| 插件清单 | 元数据里配了几个、装了几个、摘了几个 |
| 每一步的耗时和事件增量 | `activate` / `registerListener` / `createNewData` / `setValue` 各自触发了几个插件事件 |
| 插件事件 | 默认按种类计数，`propertyChanged` 额外列出字段名；`--events` 出明细 |
| 界面状态 | 跑完和元数据里本来不一样的显示、可编辑、必录，按「谁定的」归组：插件的哪个方法、界面规则第几条、平台、所在的面板或分录连带；分录写到行。`--show` / `--expect` 点名的控件另列，带上结论的由来 |
| 弹给用户的话 | `showMessage` / `showFieldTips` / 确认框，连参数一起记；`--expect message=` 断的就是它 |

带 `--op` / `--click` 时再加一块操作结果和行数对照。打开了页面的，「捕获 showForm」一行写子页标识，下面逐行列它带的参数，
`--expect opened=` / `opened.参数=` 断的就是这些。`--calls N` 打最后 N 条原始客户端调用，
只在分类器漏了东西时用 —— 一次完整链路 200~2700 条，**原文不是断言目标**。

## 事实

- **界面状态只在浏览器里**：插件调 `setVisible` / `setEnable` / `setMustInput`、界面规则的「设置控件属性」动作，
  服务端都只是往发给浏览器的指令里加一条，后台不存结论。「界面状态」一段是把这些指令按发出的先后重放出来的：
  底子是元数据里的可见性、锁定性按页面状态换算（设计器里勾了隐藏的算隐藏），再叠上指令（后发的为准），
  再叠上面板、分录、整行的连带。同一个控件被规则和插件都改过时，浏览器里谁先生效平台没有明说，这里按后台发出的先后算，
  每条结论后面写着是谁定的，拿不准就去界面上看一眼。
- 新增单据消耗编码规则流水号且不随事务退回；更新已有单据不消耗。
- `--pk` 打开已有单据时 `loadData` 真的把数据装进模型（输出里的 `数据 pk=… billno=…`
  就是这一步的凭据，**空单和装失败长得一样，别跳过这行**）。
- 冷进程首次 `activate` 17~19s（元数据子系统一次性初始化），常驻里第二遍 0.7s。
- **F7 的干净入口是 `createAndSetListShowParameter("click")` 而不是 `click()`**：前者跑完
  `triggerBeforeF7` → 派发 `beforeF7Select` → 把插件的 `addCustomQFilter` 合进
  `ListShowParameter` 就停下；后者还要接着 `showForm` 弹列表。**插件 `setCancel(true)` 时它返回 null**，
  这就是「F7 被拦住」的判据。`BasedataEdit` / `MulBasedataEdit` / `RefBillEdit` / `OrgEdit` / `UserEdit`
  各自实现同一套，但 **`RefBillEdit` 不继承 `BasedataEdit`**，按类型判断会漏掉一半。
- 输出里的过滤条件同时含**平台自己的**（`status='C'`、`enable='1'`、`billstatus='C'`）和插件加的，
  别把前者当成插件写的。
- 平台侧的机制（谁驱动生命周期、插件怎么装配、哪三处顺序错一个就断）在
  [免界面验证](../docs/技术设计/免界面验证.md#实测事实)，本篇不重复。

## 坑

| 现象 | 真因 | 判据 |
|---|---|---|
| 某个插件报错后，后面的插件像是没配 | **一个插件抛异常，整条派发链就断了**，它后面的插件这一步全收不到 | 探针会把异常归到具体插件和行号头上（不是插件抛的，说明是仿真自己还是平台），打出起因链和栈，并给出 `--skip 简名`。打开表单的任一步、`--set` 改值、点按钮、跑操作、点超链接、点 F7 抛了异常，这次结果标「没跑完整」，断言全过也不留验证记录。抛错的不是要验的插件就摘掉重跑，别去改别的插件 |
| 点计算按钮后值没变，输出里有「请先选择要计算的分录行」 | 操作第一行读 `control.getSelectRows()`，而**当前行不是选中行**：只 `--set` 不选行时它是空的 | 探针默认已按 `--set` 写过的行模拟选中；仍为空就用 `--select 分录标识=行号` 明写，并确认写的是**分录标识**不是 grid 别名 |
| `--click` 报「操作未定义实现类」 | `Toolbar.itemClick(itemKey, operationKey)` **两个参数不是一回事**，第二个传按钮 key 会被当成操作去找实现类 | 探针已从元数据解析按钮绑的操作，输出里有 `bar_save → 操作 save` |
| 操作失败但一条校验信息都没有 | 根本没走到服务端校验器，是某个表单插件在 `beforeDoOperation` 里 `setCancel` 了 | 看「弹给用户的话」，通常就是它给的理由；`--skip` 逐个摘定位 |
| 业务插件在 `registerListener` 里 NPE | 它读了页面缓存里某个键，真实会话里那个键由**前序请求**写入（典型：另一个回调里 `put`），仿真里是空的 | `--cache 键=值` 把它补上；补不出来才 `--skip` |
| F7 放行且一条过滤都没有，但源码里明明写了 `addCustomQFilter` | `registerListener` 没跑完，监听器压根没挂上 —— **不是过滤逻辑没生效** | 先看输出里 `registerListener` 那行是不是 OK |
| `showErrorNotification` 的内容没出现在「弹给用户的话」里 | 它走 `IClientViewProxy.addNotificationMsg`，**不是 `addAction`** | 已修；type 0/1/2 = 成功/错误/提示 |
| `--pk` 打开单据时冒出「XXX 正在PC端编辑该记录」 | EDIT 状态会走数据互斥（`IFormMutexService`），平台弹确认框 | 仿真里没人点那个框；只读验证用新增模式，或接受这条通知 |
| 摘掉某个插件后它还在报错 | 摘的是插件代理的实时列表，它已经挂进数据模型监听链 | 探针在 `FormConfig` 层过滤（用完还原），别自己去动实时列表 |
| 改完 `FormConfig` 后别的探针行为变了 | `FormMetadataCache.getFormConfig()` 返回的是**全 JVM 共享的缓存对象** | 探针已在 `finally` 里还原；自己写代码碰它时照做 |

操作异常与字段回读：`run op` 未取得成功结果时，提交状态为未知，不能由异常推断事务已回滚。工具独立回读单据并核对字段；字段符合只证明数据库当前值，未处理异常仍使整体失败。这样能保留已保存的证据，避免把异常误认成未执行而重复操作。
