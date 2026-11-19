---
class: A
when: 写一段代码去真实环境验证逻辑 / 造新探针
---

# 探针：在真实苍穹环境里跑任意 Java

来源：真实苍穹 8.0 二开工程实测。所有命令和输出都真跑过；文中的实体标识、模块名、账套是
那个工程的样例，换成你自己的（`driver.mjs doctor` 看当前工程的真值）。

探针是这个工作台的核心手段 —— 一段普通 Java 放进能访问苍穹业务库的环境里执行，**约 2 秒**
出结果，**不需要启动节点**。

- [探针存放位置](#探针存放位置)
- [常驻探针与副作用](#常驻探针先按副作用选)
- [编写探针](#写自己的探针)
- [结果验证](#验证结果要落成数字别落成图片)
- [环境与诊断](#环境变量与输出)
- [冷热进程](#冷热进程)
- [自动 API prepare](#自动-api-prepare)
- [服务分发边界](#服务分发边界)
- [常见坑](#常见坑)

```bash
node .claude/skills/long-cosmic-dev/driver.mjs probe <探针类名|.java 路径> [--raw] [--cold]
```

```
[PROBE] tenant=ierp account=<账套编码>(<accountId>)
[PROBE] 实体 demo_sys_test_bill  实验室检测单  表=tk_demo_sys_test_bill
[PROBE-OK] TemplateProbe
```

---

## 探针存放位置

**临时探针只准读，推荐放在当前工程根下 `.cosmic-ai/probes/`，用工程根相对路径调用。**
是否参数化不决定写权限；只有随 Cosmic 审核发布的探针才能承担写入。

| 这个探针…… | 放哪 |
|---|---|
| 本次需求的只读诊断代码 | 当前工程 `.cosmic-ai/probes/` |
| 要加入产品的通用探针或写能力 | Cosmic 仓库 `resources/probes/`，验证后构建发布 |

临时源码必须位于当前工程内。不要修改 released 探针缓存，它会被摘要校验拒绝。

```bash
cosmic_probe name=.cosmic-ai/probes/MyTempProbe.java
```

**探针的价值经常在输出里，不在代码里。** 查出来的元数据事实、字段精度、查询路径，
该写进 `reference/` 对应的文档；把一个 15KB 的一次性 Java 留着当文档使是最糟的选择。

## 常驻探针：先按副作用选

分级定义见 [metadata-read.md](metadata-read.md)：R0 不写共享环境和本地文件，R1 只写本地产物，
W 会修改共享环境。同一个探针兼有读写模式时，只有明确的无 `APPLY` 读取模式才算 R0。

探针的名字不等于它能做的事（`FormLayoutWriteProbe` 除了布局，还管字段、操作和挂插件）。按要做的事找：
`cosmic_knowledge action=probes query=<要做的事>` 回说明和入参对得上的几个探针，连入参注释里对得上的那行写法；
`query=<探针类名>` 给这个探针的全部入参。

### R0：只读

| 探针 | 用途 | 详见 |
|---|---|---|
| `DataProbe` | 先确认主表和分录有没有数据 | [data-query.md](data-query.md) |
| `MetaProbe` / `FieldLimitProbe` / `OpMetaProbe` | 实体运行态字段、写值约束、操作与按钮 | [metadata-entity.md](metadata-entity.md) |
| `DbColumnProbe` | 数据库列核对（删掉的字段也查得到） | [metadata-entity-write.md](metadata-entity-write.md) |
| `FormLayoutProbe` / `FormPluginProbe` / `FormTreeProbe` | 控件和字段的位置、类名、设计器里存的属性和可改属性；列表可显示的完整字段路径（LAYOUT_LIST_FIELDS）、可用过滤字段路径和类型（LAYOUT_FILTER_FIELDS）；单据、列表、移动端各份布局和报表列表控件上登记的插件，继承树和控件可见性 | [metadata-form.md](metadata-form.md) |
| `FormVisibleProbe` | 新建的表单到底能不能被开发平台搜到（八路对齐参照表单） | [metadata-create.md](metadata-create.md) |
| `FormRuleProbe`（不给 `APPLY`） | 遍历界面规则宿主/悬空引用；函数与动作目录用 `meta formula form\|biz` 查 | [metadata-form-rules.md](metadata-form-rules.md) |
| `BizRuleProbe`（不给 `APPLY`） | 遍历实体/分录业务规则、真假动作和运行参数 | [metadata-business-rules.md](metadata-business-rules.md) |
| `BotpRuleProbe`（走 `meta botp list|dump`） | BOTP 清单、插件、条件与字段映射 | [metadata-botp.md](metadata-botp.md) |
| `ApiMetaProbe` | 开放接口清单、触发的单据操作、插件绑定、请求体与返回参数 | [plugin-integration.md](plugin-integration.md) |
| `PrintTplProbe` / `PrintTplDesignProbe` / `PrintGridDumpProbe`（走 `meta ptpl list|dump`） | 模板清单、严格审计和网格展开 | [print-template.md](print-template.md) |
| `PrintTplControlAssertProbe`（用 `cosmic_probe` 只读核对；不自动成为交付断言证据） | 按模板编码、稳定控件 id 和属性路径断言打印控件标量属性 | [verify.md](verify.md) |
| `IsvCheckProbe` / `IsvGuardProbe`（用 `cosmic_probe` 核对） | 实体 ISV 归属；红线三个非实体家族的放行/拦截回归 | [metadata-write.md](metadata-write.md) |
| `PluginIndexProbe`（走 `impact build`） | 扫本 ISV 设计态元数据全文，摘「哪个插件类登记在哪张单据上」 | [impact.md](impact.md) |
| `UserProbe` / `EnvDiagProbe` | 用户 id；环境、账套和连接诊断 | 本页下文；[runtime.md](runtime.md) |

### R1：只生成本地产物

| 探针 | 本地副作用 | 详见 |
|---|---|---|
| `PrintTplJsonProbe`（走 `meta ptpl dump`） | 导出模板设计 JSON 和多语言映射，**定位控件和改前改后 diff 用它** | [print-template.md](print-template.md) |
| `PrintTplBackupProbe`（走 `meta ptpl backup`） | 写 ZIP 备份并校验条目和哈希 | [print-template.md](print-template.md) |
| `WfModelProbe`（走 `meta wf`） | 工作流模型清单、导出已发布的流程定义、批量存档。**只读，没有写通道** | [meta-cmd.md](meta-cmd.md) |
| `PrintMeasureProbe`（走 `meta ptpl measure`） | 可写 PDF/PNG 和图片占位文件 | [print-template.md](print-template.md) |

### W：共享写入

| 探针 | 用途 | 详见 |
|---|---|---|
| `FormRegisterProbe`（`APPLY=1`） | 把新建表单登记进开发平台功能单元 / 回滚登记 | [metadata-create.md](metadata-create.md) |
| `FormRuleProbe`（`APPLY=1`） | 新增 / 回滚界面规则 | [metadata-form-rules.md](metadata-form-rules.md) |
| `BizRuleProbe`（`APPLY=1`） | 新增 / 回滚实体业务规则 | [metadata-business-rules.md](metadata-business-rules.md) |
| `BotpRuleSyncProbe`（`APPLY=1`，走 `meta botp backup|restore`） | 批量复制业务规则、改字段映射和建行层级、备份与恢复 | [metadata-botp-write.md](metadata-botp-write.md) |
| `FormLayoutWriteProbe`（`APPLY=1` 带 `LAYOUT_BACKUP`） | 加删字段、加分录、照搬字段，改控件属性和位置，加删控件和操作；电脑端列表加字段列、加工具栏按钮并绑定操作；配置常用过滤和快捷搜索字段（show filter），改筛选项属性、排序、撤下；挂摘插件，按备份恢复；整份清单在内存里改完再存一次，问题一次列全 | [metadata-form.md](metadata-form.md)、[metadata-entity-write.md](metadata-entity-write.md) |
| `PrintTplWriteProbe`（`APPLY=1`，走 `meta ptpl apply` / `meta ptpl restore`） | 三条写法：`--set` 按「控件 + 属性路径」改已有标量（不新建属性、类型跟旧值走）；`--file` 整份提交改好的设计数据，加控件、加表格、改公式走这条；`restore` 把备份目录里那份原样写回。落库前过差异比对、公式试算、平台解析和拓扑审计，落库后回读核对 | [print-template-write.md](print-template-write.md) |
| `OpSandbox` / `FormSim` / `FormCallbackSim` / `FormFlowSim` / `ListSim`（走 `run op` / `run form` / `run callback` / `run flow` / `run list`） | 回滚操作、开表单、父子页回调/整条流程、限量运行标准/树列表插件；主动写交互强制回滚 | [run.md](run.md) |
| `RuleSim`（走 `run rule form` / `run rule biz`） | form：布局静态显隐 + 容器传播 + 界面规则，按字段粒度出终态；biz：目标字段被算成什么值。不建 View 不装插件 | [run.md](run.md) |
| `PrintSim` / `CallSim` / `PushSim` / `WfSim`（走 `run print` / `run call` / `run push` / `run wf`） | 打印插件出的格子文字、直接调本工程类的方法、按 BOTP 规则下推保存并从数据库回读、按已发布流程拼上下文调工作流插件 | [run.md](run.md) |

### 支持类：不单独运行

| 类 | 用途 | 详见 |
|---|---|---|
| `IsvGuard` | 所有写探针的 ISV 硬拦截 | [metadata-write.md](metadata-write.md) |
| `MetaResolve` | 仅用于实体导向的“布局 → 实体”解析 | [metadata-read.md](metadata-read.md) |
| `HeadlessUiSupport` | 仿真器共用的页面缓存、客户端记账、插件筛选与异常归属 | [run.md](run.md) |
| `ProbeJson` | 机器可读旁路：`ProbeJson.emit(…)` 打 `[PROBE-JSON]` 行，driver 收进 `build/last-probe.json` | 本页「机器可读旁路」 |
| `ProbeAssert` | 断言原语：一次调用同时出人读行和 `t=assert` 的 JSON 记录 | 本页「机器可读旁路」；[verify.md](verify.md) |
| `ExpectSpec` | `--expect` 的唯一实现：字段路径解析 + 表单/操作/列表/下推/工作流五种断言入口 | [verify.md](verify.md) |
| `TemplateProbe` | 带常用 import 的探针拷贝起点 | 本页下文 |

**上表覆盖已发布工具。** 本次需求的只读探针放 `.cosmic-ai/probes/`，别混进已发布清单。

样板代码一律在 `reference/` 里以片段形式给，不以文件形式留：查询与分录看
[data-query.md](data-query.md)，受控写入看 [metadata-entity-write.md](metadata-entity-write.md)
和 [print-template-write.md](print-template-write.md)，骨架拷 `probes/TemplateProbe.java`。

## 写自己的探针

**别从空文件开始，参考 `probes/TemplateProbe.java` 的骨架和实际要用的片段。** import 只保留
这次真的使用的具体类；不要整份照搬，更不要写 `kd.x.*`。`cosmic_probe` 会用精确 import
确定依赖集合，把类与明显的方法/构造调用合成一次当前 JAR 批量校验。

约定只有三条：**无包名、类名 = 文件名、`public static void run() throws Exception`**。

```java
public class MyProbe {
    public static void run() throws Exception {
        //查实体元数据先走 MetaResolve.type(key)；布局、BOTP、打印模板分别走各自通道
        //—— 界面上看到的标识可能是布局不是实体，直接查只会得到「元数据不存在」
        MainEntityType t = MetaResolve.type("demo_sysjcdjqsy");
    }
}
```

- **临时探针只准读；已发布写探针必须调 `IsvGuard`**，见 [metadata-write.md](metadata-write.md) 的红线段。
- **探针里别调 `System.exit()`** —— 常驻模式下会带走整个 server（已装 SecurityManager 拦成一条
  提示，别依赖它）。

宿主类 `runtime/CosmicProbe.java` 替你做了三件苍穹强制要求、少一件就跑不起来的事：照工程启动类设
远程环境系统属性（**不起 Jetty**：配置写在单独方法里的只调那个方法，写在 `main` 里的调 `main`，`start()` 在探针进程里是空的）；建 `RequestContext`；把 `run()` 丢进
`ThreadPools` 的线程 —— **苍穹禁止在 `main` 线程访问数据库**，直接查会抛
`Please use the thread pool utils (kd.bos.threads.ThreadPools) to create thread…`。

## 验证结果要落成数字，别落成图片

**把一页 PDF 转成 PNG 读进上下文是 4~5 万 token，而要判断的往往只是一个坐标。**
凡是「看一眼就知道对不对」的验证，先想怎么把它算成一行数字打印出来。

| 要验的东西 | 别这么干 | 这么干 |
|---|---|---|
| 排版：有没有居中 / 在第几列 / 多大 | 转 PNG 读进来看 | `PrintMeasureProbe`（图片和文字都能量），直接吐 `cx=421.0 Δ=+0.3 [单图·居中]` |
| 颜色、像素、图像内容 | 把整张图读进来 | 探针里扫包围盒 / 采样点 RGB，打印数值 |
| 字节码：某方法内部怎么调的 | `javap -c` 输出整段进上下文 | dump 到 `.cosmic-ai/evidence/` 文件里再 Grep |
| 单位换算、纯函数、常量值 | 改代码 → `deploy` → 渲染 → 看偏了 → 再改 | 探针直接打印 `pixelToLom(335)`、`getCurrentDpi()` |
| 同一份输出换个角度再看一遍 | 改 grep 条件把探针重跑一遍 | 保存到 `.cosmic-ai/evidence/xxx.txt`，之后所有筛选在本地文件上做 |

**能在探针里离线算清的绝不端到端试**（改一轮业务代码 `fast` 40 秒、`deploy` 3~4 分钟），
图片只在最后确认整体观感时看一张。换过滤条件重跑等的是**同一份输出**的第二遍 ——
第一次就保存到 `.cosmic-ai/evidence/`。

## 环境变量与输出

| 变量 | 作用 | 不设时取自 |
|---|---|---|
| `COSMIC_ACCOUNT` | 账套编码或账套 id | skill 的 `config.json` → `account` |
| `COSMIC_USER` | 用户 id。**写元数据/写业务数据时它就是落库的「修改人」** | skill 的 `config.json` → `user` |
| `COSMIC_ISV` / `COSMIC_TENANT` | ISV / 租户 | 自动探测 / 内置默认（见 `driver.mjs doctor`） |

这两个值**在代码里没有默认值**：账套填错报的是「元数据不存在」，跟标识拼错长得一样；
用户 id 填错完全没有症状，只是所有写操作的「修改人」记在别人头上。缺了 driver 会拒绝执行
并指出补在哪，不会拿一个猜的值跑下去。

```bash
COSMIC_ACCOUNT=<另一个账套> node .claude/skills/long-cosmic-dev/driver.mjs probe TemplateProbe
USER_KEY=姓名、用户名或工号 node .claude/skills/long-cosmic-dev/driver.mjs probe UserProbe   # 查自己的 id
```

装机时 `account` / `user` 怎么填、为什么别用 `1`，见 [README.md](../README.md)。
冷热两条路径下 `System.getenv()` 语义一致，探针不用改。

> **查元数据的探针一律要显式给实体标识**（`META_ENTITY` / `TPL_ENTITY` / `OP_ENTITY` /
> `META_FORM`），不给会打出用法然后中止。**这是故意的** —— 塞一个默认标识只会让人跑出
> 「元数据不存在」，而那跟标识拼错、跟账套选错长得一模一样，白白多一轮排查。
>
> **标识写错时不用再猜一轮**：`MetaResolve` 在「既不是实体也不是表单布局」之前，会先把
> 本 ISV 里名字沾边的实体和布局列出来（各最多 10 个）。从那几行里抄，别接着猜——
> 猜一次就是一整轮探针。

### 位置参数：不用记环境变量叫什么

同一个「实体标识」在各探针里叫 `META_ENTITY` / `META_FORM` / `LIMIT_ENTITY` /
`DATA_ENTITY` / `OP_ENTITY`，五个名字。**直接把值写在探针名后面就行**，driver 读探针源码里
`req("…")` 的出现顺序按位绑定：

```bash
node .claude/skills/long-cosmic-dev/driver.mjs probe MetaProbe demo_bzwz_wl
```

绑定关系会打一行 `[driver] 位置参数 → META_ENTITY=…` 出来，看得见就不会绑错。
显式给了环境变量的不被覆盖；位置参数给多了当场报错，并列出该探针的必填入参名。

默认删掉平台日志（SQL 跟踪、框架日志），其余原样给，插件自己的日志也在；`[PROBE-ERR]` 发起的栈
完整保留（断言没过、输入不成立只有 `[PROBE-ERR]` 一行、没有栈，原因在它上面的 `✘ FAIL`、`✘ 输入不成立` 行），
其它运行时栈折叠后按异常组和根因摘要。`FunctionManage` 缺函数类会列出类名——目标规则
引用缺失函数时，结果不能作为验收依据。完整日志加 `--raw`，但原文可能含 SQL、参数和环境配置，只在
本机诊断。

### 机器可读旁路：断言走 `ProbeAssert`

探针的结论有两条通道：`[PROBE] 中文行` 给人读，`[PROBE-JSON] {…}` 给机器读。
**凡是「期望 X、实际 Y」的判断一律调 `ProbeAssert`，别自己拼 JSON**，
否则每个探针的字段名各不相同，`verify` 那头只能一个个特判 —— 那等于没有协议。
非断言的事实（跑的什么场景）走 `ProbeJson.emit("scenario", …)`。

用法、约定和金额标度那个坑在 [verify.md](verify.md) 的「断言怎么送出来」。

环境 / 账套 / 连接的一次性诊断（`EnvDiagProbe`）和判读表在
[runtime.md](runtime.md) 的「环境诊断」—— 换机器、连不上、读不到元数据先去那。

---

## 同一个问题问第三遍会被拒

同一个探针、同一份入参，连着两次输出一字不差时，第三次**不启动 JVM**，直接返回
`PROBE_ANSWER_SETTLED` 并给出上一次的完整原文路径。

判据只看事实：两次连续输出（删掉平台日志后的行，耗时和 pageId 不算）完全相同。
输出一动就重新计数，所以结论会变的探针永远不会被挡；`cosmic_fast` 编译过、
APPLY 写过元数据、跑过会落库的运行（运行都是真提交：`run op`、带 `--set` 的 `run print`、按了按钮的 `run form` 等）之后整本账清零，改完代码或改过数据重跑同一条命令照常跑。
会落库的运行自己也不记这本账：它每跑一次单据就变了，同一条命令连跑几遍都不拦。

被拒时该做的不是换个角度再问一遍，而是：读那个文件，把已经拿到的结论写进交付。
真机上出现过同一个 `OpMetaProbe` 连调三次、三次输出完全相同的情形——那不是探索，是碰运气。

## 冷热进程

**不用管，driver 自己会选。** 冷探针 30~40 秒里 97% 是每次重付的固定初始化
（javac + 照工程启动类设环境 + 元数据子系统首次加载），常驻 JVM 把它只付一次，之后每请求约 2.4 秒；
允许重试的只读调用可按内核判定降级冷进程或重启；禁用 coldFallback 时直接报告不可用。写入已发出但答复不完整时报告 PROBE_WRITE_UNCERTAIN，不自动重跑，先核对现场。
空闲 30 分钟自动退出，RSS 约 1.3G；`fast` 之后先把变了的类热替换进去、换不进去才重启（见下一节），`deploy` 会重启它。

```bash
node .claude/skills/long-cosmic-dev/driver.mjs probe-server [start|stop|status|restart]
```

### 改完代码：先换类，换不进去再重起

`fast` 编完不重起常驻 JVM，只做一个标记；下次用它之前 driver 让它把业务类目录里
**变了的类原地换进去**（热替换，和 IDEA 调试时的 HotSwap 同一个机制）。平台每次建插件拿的是同一个类，
换进去之后下一次打开单据、跑操作就是新代码。别处编的（另一个会话、IDE、gradle）也一样：常驻 JVM 自己发现
目录变了，先换类再跑。

| 改了什么 | 默认（JDK 自带） | 挂 JRebel |
|---|---|---|
| 只改方法里面的代码 | ✅ 换进去，约 1 秒 | ✅ |
| 加、删 private static / private final 方法（不用 `this` 的 lambda 就是这种） | ✅ 换进去 | ✅ |
| 加、删字段；加 public / protected / 包内 / private 实例方法（含用 `this` 的 lambda）；改签名、改继承 | ❌ 整批不换，自动重起（约 30 秒） | ✅ 换进去 |

实测：改方法体约 1.3 秒换进去、同一进程；加 private static 方法 0.5 秒；
加字段、加 public 方法被拒，自动重起后结果正确；挂 JRebel 后加 public 方法和字段不重起，整次运行 8.3 秒。

要知道的几条：

- **整批原子**：一批里有一个换不进去，一个都不换，然后重起——不会出现半新半旧的 JVM。结果里的 note 会写
  「已热替换 N 个类」或「热替换不了：结构变了（…）→ 已重起」，原因是 JVM 自己的原话。
- **换进去不等于生效的两种改动**：静态字段的初始值（`static` 块、`static final Map` 缓存）不会重算；平台缓存着的单例服务对象
  还是旧构造出来的。改了这两类，自己 `probe-restart` 一次。
- **元数据写入、账套用户变了照旧重起**：那是缓存和身份的问题，换类解决不了。
- **JRebel 开关**（默认关）：全局或工程 `config.json` 写 `"jrebel": "auto"`（在本机 IDEA 的 JRebel 插件目录里找）
  或原生库路径；单次用环境变量 `COSMIC_JREBEL=auto|off`。开关一变常驻 JVM 重起一次（JRebel 只能启动时挂上），
  起得慢一些（实测约 50 秒对 30 秒）。JRebel 是用户自己装、自己授权的商业软件，找不到就退回默认方式并说一句。

### 写元数据在常驻进程里写：谁写谁就马上读得到

写元数据的 `APPLY=1` 和 `cosmic_run` 的真提交、造数改数一样，**在常驻进程自己里面写**。
`ROLLBACK=1`、造数改数的预演、显式 `--cold` 仍走冷进程。

原因：本地调试的缓存是**各进程各一份**：调试启动类开了轻量级部署（`setEnableLightWeightDeploy(true)`），
**每个探针 JVM 的「Redis」都是它自己内存里的一份**（日志里是 `Cache 'redis:<地址>' created in EhcacheManager`；
冷进程写的标记，常驻进程和另一个冷进程都读不到）。平台保存元数据时清的是**写入那个进程自己**的各层缓存。所以：

- **常驻进程自己写**：写完同一进程马上读到新的。实测：常驻里加字段，3.8 秒后同一进程读单据元数据、
  读表单布局都已有新字段，版本号是新的；删字段同样。这和在本机 IDEA 起的苍穹里用开发平台（`localhost:8080`）改元数据、
  代码马上读到是一回事——那也是同一个进程又写又读。
- **冷进程写、常驻读**：常驻那份永远是旧的。苍穹每 15 分钟复查一次版本号，问的也是自己那份，**不会自愈**
  （实测加字段 17 分钟后常驻进程仍读不到）。而 save 返回 success、rebuild 也不报错，**没有任何迹象提示你验错了**。
  所以冷进程写了元数据（显式 `--cold`，或常驻用不上降级到冷进程）之后，driver 会把常驻 JVM 标记过期，
  下次用它之前先重起（约 30 秒），结果里有一条 note「常驻 JVM 里的类或元数据已过期（写了元数据（…））→ 已重起」。

写完要核对，**直接在常驻上跑只读探针**，不要加 `--cold`，也不要为了「保险」手动重起。
真机实测覆盖的是**加删字段**（单据元数据、表单布局两层）；业务规则、界面规则、打印模板、转换规则写完即读还没逐族实测过——
它们走的是同一个平台保存，预期一样，但核对结果和预期对不上时，先 `probe-restart` 再核一次，别急着改写法。

几条随之而来的规矩（driver 硬编码，不靠自觉）：

- 本次确认过的写入目标随**这一次请求**带进常驻进程（`-Dcosmic.targets`，跑前设上、跑完清掉），`IsvGuard` 每次检查现读，
  清单外的对象照样当场拒绝。
- 写入发出去之前先核对常驻 JVM 的归属和身份：认不出归属就直接走冷进程，身份（账套/用户）不对就先重起——
  写入发出去就收不回来，不能像只读探针那样「发完再验、不对重问」。
- 常驻进程里写到一半抛了异常，下次用之前重起（缓存清没清全说不准）；写之前就被门禁拦下（打了「未落库」）的不重起。
- 发给常驻后没收到完整答复（超时、半截断开），报 `PROBE_WRITE_UNCERTAIN`，**不会自动冷进程重跑**：可能已经写了一部分，
  再跑一遍就是写两次。先用只读探针查清现状。

**别人改的元数据**，常驻进程照样看不到：有人在设计器里改了单据（包括在本机 IDEA 起的苍穹里改），正在跑的常驻 JVM
不知道。这时 `cosmic_runtime action=probe-restart` 一次（或等它空闲 30 分钟自己退出）。
逐层手动清缓存实测能让单据元数据变新，但表单、打印模板、转换规则各有各的缓存，漏一层就是静默的错答案，别走那条路。

## 自动 API prepare

临时 Java 交给 `cosmic_probe` 后，编译和 Cosmic JVM 启动前会自动完成一次 prepare：

1. 从精确 `kd.*` import 建出完整依赖集合；
2. 把所有类、明显的方法调用和构造调用合成**一个**当前 RuntimeKey 的 JAR 批量查询；
3. 探针被这一步拦下、或者没跑成时，把它调用到的方法按当前 JAR 反射出的真签名放进 API 知识卡片随结果返回（没有签名可给的类不出卡片）；跑成了不附；
4. 将类不存在、方法名错误、参数个数错误、缺少必填入参、误传环境变量和危险能力一次列全。

所以写好探针直接调 `cosmic_probe`，核对结果会一起回来。精确 import 且没有
阻碍时直接进入 javac；通配 `import kd.x.*` 因依赖集合不可判定会被拒。批量反射不可用时会
明确降级，javac 仍在 Cosmic JVM 前兜底。

已发布探针的清单里，括号中就是它自己 `req("…")` 声明的必填入参，按那个顺序绑位置参数；可选入参写在探针源码开头的参数注释里，被调错时的 remedy 会把那一段整块带出来。参数说明都从这两处拿。

预检拒绝是 `PROBE_PRECHECK_FAILED`。它的 `deferred` 记的是这次**没能做**的检查——反射不可用
时「当前 JAR 的类、方法与参数存在性」就在里面，它不算核对通过。只有误传环境变量这一类
工具能从探针自己的 `req` / `env` 声明推出正确写法的问题，才会附一个可直接照抄的 `nextCall`；
缺必填入参不会凭空造值。

确实要研究一个 API 的完整语义或主动查候选时，`api` / `findclass` / `lint` 三个入口见
[lint.md](lint.md)。它们回答「这个名字在 classpath 上真的存在吗」，按需用。
## 服务分发边界

**走 RPC 分发的 API（`executeOperate`、`FormView.activate`、`ConvertServiceHelper.push`、
`execPrint` …）在探针里能原路跑**：宿主已装好服务分发桥 `ServiceBridge`
（`CosmicProbe.initEnv()` 里装，冷热两条路径共用），把 `DispatchService` 指向本进程的
`DispatchServiceImpl`，其余交回原厂 `AssemblyServiceLookup`。
**指向本进程，不联网、不注册 ZK，不影响共享环境上的其它节点。**
装不上时宿主不中止，会打一行 `[PROBE] 服务分发桥 装不上: …`。

**探针里不要自己 `ServiceLookup.setImpl`** —— 常驻 JVM 里会把宿主的桥换掉，
之后所有探针都受影响，且不报任何错。

⚠️ **`ServiceLookup not implemented` 从来不是保护措施** —— 它只是缺一层桥，而
`SaveServiceHelper.save` / `QueryServiceHelper` / `MetadataDao` 直连 ORM、压根不走分发。
桥装上之后写操作**真的会执行**，红线照旧：写元数据的探针默认 dry-run，`APPLY=1` 才落库，而且要用户在确认单上确认；
临时探针只准读。

**备选绕行（桥能用时不必走）**：`XxxServiceHelper` 多是 RPC 薄壳，服务端实现类
`kd.bos.service.**.XxxServiceImpl` 就在 classpath 上，直接 new 出来 JSON 进 JSON 出。
`SaveServiceHelper.save` 直存基础资料有 **masterid 坑**，见 [sdk.md](sdk.md)。

免界面跑整条「打开表单 → 点保存」的链路见 [免界面验证](../docs/技术设计/免界面验证.md)。

## 常见坑

- **业务源文件比 `.class` 新时 `probe` 直接拒绝跑**（退出码 3）：先 `driver.mjs fast`（40 秒），
  逃生开关见 [runtime.md](runtime.md) 的 fast 一节。
- **探针自己别调 `System.exit()`**（会带走常驻 server）；宿主 `CosmicProbe` 已处理，见「写自己的探针」。
- **探针不需要节点在跑**，两者互不依赖，探针自己连 ZK 和业务库。已验证 `stop` 之后 `probe` 照常输出。
- **编译失败会以 `[FAIL] 探针 XxxProbe 编译失败` 开头，后面就是 javac 原文**（已强制 UTF-8，
  中文报错能正常读）。**报错第一行的行号就是真正的出错位置**，别往别处找。
- 看到 `错误: 找不到或无法加载主类 XxxProbe` 而**没有** `[FAIL]` 开头那段，才是别的问题
  （类名 ≠ 文件名、探针带了包名）。
- 写探针改元数据前，先读 [metadata-write.md](metadata-write.md) 的红线段和风险段。
