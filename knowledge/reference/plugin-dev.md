---
class: C
when: 开发插件但不确定该选 UI、操作还是集成类型
---

# 苍穹插件开发：选择、探查、实现与验证

本页是插件开发的入口，只保留公共流程、类型决策、跨类型规则和文档路由。选定插件类型后，
只加载对应的详细 reference，不要一次读完所有插件文档。

插件只做配置表达不了的那一段：字段和控件属性、界面规则、业务规则、转换规则字段映射各能做什么，
见 [metadata-or-code.md](metadata-or-code.md)。

> **官方语义索引**：插件基类、生命周期、通用场景和 SDK 说明通过
> [official-knowledge.md](official-knowledge.md) 按需检索；本文只维护本地探查、验证和交付流程。

## 证据等级

本文档使用三种口径：

- **SDK 已核对**：已用苍穹 8.0 jar 的 `api` / `findclass` 确认类或签名。
- **工程实测**：已在一个真实二开工程的代码、数据、模板或输出结果中验证过。
  **那是本 skill 的出处工程，不是你的工程** —— 结论可复用，里面的标识和类名要换成你自己的。
- **官方语义索引**：只记录官方知识相对路径和检索条件；编码前必须用 `api` / `lint` 核对。

不要把“官方语义索引”改写成“只能、必须、一律不支持”等绝对结论。发现资料与当前 SDK 冲突时，
以当前 SDK 签名、真实元数据绑定和最小运行验证为准。

- [先走公共开发流程](#先走公共开发流程)
- [选择插件类型](#选择插件类型)
- [正确处理 super 调用](#正确处理-super-调用)
- [抽离可验证的业务逻辑](#抽离可验证的业务逻辑)
- [按类型加载详细文档](#按类型加载详细文档)
- [交付检查](#交付检查)

## 先走公共开发流程

不要从写 `extends XxxPlugin` 开始。先用秒级探查证明插件位置、数据和 SDK，再进入代码：

读到或写入工程里的插件源码时，这一族的知识卡片（Knowledge Capsule）会附在那次 read/write/edit 结果里：
内容是对应插件文档里「必知要点」那一节（这一族最容易做错、错了也不报错的几条），加验证路线和出处；同一族在一次对话里只附一次。
复杂语义、识别不确定或卡片没覆盖的部分，再用 `cosmic_knowledge action=plugin` 展开完整指南和场景正文。

编译完给出的「登记在」是**实际绑定的布局标识**（`demo_sys_test_bill_lsyd`），括号里才是它底层的实体。FormSim 要挂的是布局：官方 `resolveTarget` 会把布局落到实体继续跑，所以拿实体去跑也能出 PASS——装的却是另一份插件清单，那个 PASS 与你这个插件无关，而且它会留下一条验证记录、足以把交付撑过去。挂实体前先核对插件清单。

`fast` 在 Gradle 和 javac 之前一次算完源码名解析、插件知识卡片判定和模块归属：名字写错、
文件不在任何代码模块里、卡片生成不了，这三类会在同一次拒绝里全部列出（多于一条时错误码
是 `FAST_PRECHECK_FAILED`，只有一条时保留它自己的码）。改完源码再编一次不算原样重试——
改动本身就是新事实，重复失败熔断会因此重新计数。
同样不算重复的：「输入不成立」「参数写错」这类失败之后改了输入再跑；同一轮里一起发出的几条调用
（第一条失败时后面几条已经发出去了，只算一次）。只有什么都没变、原样再跑才会被拦。

| # | 要回答的问题 | 首选工具/文档 | 完成判据 |
|---|---|---|---|
| 1 | 界面标识对应哪个实体/布局 | `MetaProbe`、`MetaResolve`、[metadata-read.md](metadata-read.md) | 拿到真实实体和布局 |
| 2 | 当前布局、操作、规则或开放接口实际绑了哪个插件；新写的类挂上没有 | `FormPluginProbe`、`OpMetaProbe`、`BotpRuleProbe`、`ApiMetaProbe`，没有探针列得出来的那几类用 `cosmic_impact` 查类；单据、列表、操作、报表界面插件没挂上的用 `FormLayoutWriteProbe` 的 `add plugin` 挂（[metadata-form.md](metadata-form.md)），打印插件用 `meta ptpl edit --plugin` 登记（[print-template-write.md](print-template-write.md)），其余各类的登记要用户在平台上配 | 类名、启用状态和绑定位置明确 |
| 3 | 有没有覆盖目标分支的真实数据 | `DataProbe`、[data-query.md](data-query.md) | 明确有数据或确定使用内存样例 |
| 4 | 字段标识、类型、精度和分录层级是什么 | `MetaProbe`、`FieldLimitProbe` | 不靠标题/经验猜字段 |
| 5 | 类、事件和方法签名是否真实存在 | `api`、`findclass`、[anti-patterns.md](anti-patterns.md) | 所有新增 API 均已核对 |
| 6 | 哪部分能脱离框架验证 | static 纯函数或服务方法 | 探针可直接调用核心逻辑 |
| 7 | 最小验证路径是什么 | `fast`（内部 lint）→ 探针/`run` → 必要时节点/UI | 先数字证据，后视觉验收 |

共享环境中的任何元数据或业务数据写入仍受主 [SKILL.md](../SKILL.md) 的 ISV 红线和
`APPLY=1` 约束；插件文档不会重复放宽权限。

## 选择插件类型

**基类 → 场景标签 / 官方指南 / 绑定确认探针 / 行为验证入口，跑这条命令，本页不抄第二份：**

```bash
node .claude/skills/long-cosmic-dev/driver.mjs knowledge routes
```

怎么读那张表（`—` 和「无无头适配器」两个符号的含义）见
[official-knowledge.md](official-knowledge.md#插件族路由表)。基类本身的语义、生命周期和
事件全集读官方指南，不在本地维护第二份。

**别按「客户端 / 服务端」二分。** 表单、列表等 Java 插件同样由平台在服务端运行；
真正的差别是三件事：**能不能访问页面上下文、处在哪个事务阶段、由哪个引擎调用**。
这三件事决定了同一段逻辑该写在哪个插件里，也决定了它能不能被无头验证。

### 坑：静态字段跨回调共享会串页面

不要用非 `final` 静态字段保存页面、打印或请求状态。插件实例的生命周期、并发模型和清理时机
都由平台决定，静态字段在并发请求下会串数据，而症状是「偶发的值不对」，不报错。
需要跨回调共享时先确认这三件事；打印插件还要处理同一次打印的多数据源回调。

## 正确处理 super 调用

不要使用“继承型所有 `@Override` 都必须先调 `super`”的一刀切规则。按回调来源处理：

- 覆盖框架基类生命周期方法时，默认保留基类行为，并结合当前 SDK/周围工程代码确认调用顺序。
- `registerListener`、多数 `propertyChanged` 等基类回调通常先调用 `super`。
- 实现监听器接口的方法，如 `BeforeF7SelectListener.beforeF7Select`，没有对应基类实现时不调用。
- `IWorkflowPlugin` 等纯接口实现不存在统一的 `super`。
- 若刻意不调用基类实现，在代码旁说明原因，并用最小场景验证没有丢失平台行为。

样板自身必须遵守这套规则；不要让文字要求调用 `super`，代码片段却省略它。

## 抽离可验证的业务逻辑

不要把公式、分组、映射和判定全部埋进 `propertyChanged`、`afterConvert` 或
`afterLoadData`。把不依赖 `View/Model/EventArgs` 的部分抽成 static 纯函数或无状态服务方法：

```java
static BigDecimal calculate(List<BigDecimal> values) {
    // 只做确定性计算
}

@Override
public void propertyChanged(PropertyChangedArgs e) {
    super.propertyChanged(e);
    if (KEY_INPUT.equals(e.getProperty().getName())) {
        getModel().setValue(KEY_RESULT, calculate(readValues()));
    }
}
```

收益：

- 探针直接调用生产代码中的同一方法，不重写近似逻辑。
- 真实表为空时可以构造内存输入覆盖边界条件。
- UI、事务和打印事件只负责编排，失败位置更清楚。

改过代码模块的代码后（哪怕只改方法体）**必须先 `fast` 再跑探针**（40 秒），否则探针链到的是旧类，
而且只改方法体时不报任何错。`deploy`（3~4 分钟）只在用户明确要求时做 —— 交付走的是提交代码，不是拷本机 jar。详见 [probes.md](probes.md)。

## 插件写法必知要点

- 查库、存库、调操作放在循环外：先把要查的编号收齐，一次查出来放进 Map，循环里只取用。操作插件和校验器一次拿到的是这批提交的全部单据。
- 元数据和缓存在循环外取一次，循环里只用取到的结果。
- 单据和字段标识用这张单的常量类（类周边里点了名）；常量类里没有的，加进常量类，插件里不另写一份。
- 一个方法只做一件事，超过 80 行就拆；类已经超过 500 行时，新逻辑放进同包的服务类，插件里只调用。
- 同一张单同一类插件已经有的，新逻辑加进已有的类；新建插件类时，交付里说明为什么不加在已有的类里。
- 写入、修改工程 Java 后会列出这次新加的写法问题；循环里直接查库、已在用常量类还写字符串、重复声明常量这三类不改编译不过。确实合不了批的，在那一行上面写 `// cosmic-allow: 理由`，理由列进交付。

## 写法规范：怎么改对

写完就查和编译前拒绝列的每一处都带一句改法，这里是对应的写法。例子里的单据、字段用 `demo_` 代替。

**循环里查库 → 先收编号，一次查完。** 操作插件的 `e.getDataEntities()`、校验器的 `getDataEntities()`
是这批提交的全部单据，一张一查就是一张一次库往返：

```java
// 改前：每张单查一次上游
for (DynamicObject bill : e.getDataEntities()) {
    DynamicObject src = BusinessDataServiceHelper.loadSingle(bill.getLong(DemoBillConst.SRC_ID), DemoSrcConst.ENTITY);
    ...
}

// 改后：收齐编号，一次查出来放进 Map
Set<Object> ids = new HashSet<>();
for (DynamicObject bill : e.getDataEntities()) ids.add(bill.getLong(DemoBillConst.SRC_ID));
Map<Object, DynamicObject> srcById = BusinessDataServiceHelper.loadFromCache(ids.toArray(), DemoSrcConst.ENTITY);
for (DynamicObject bill : e.getDataEntities()) {
    DynamicObject src = srcById.get(bill.getLong(DemoBillConst.SRC_ID));
    ...
}
```

按条件查的同理：`QFilter` 用 `in` 带上全部编号，`QueryServiceHelper.query` 查一次，结果按编号分组。
存库同理：改好的对象收进数组，循环外 `SaveServiceHelper.save` 一次。调操作（`OperationServiceHelper.executeOperate`）
也收齐一批调一次；确实要分组的（例如按下游单据类型），按组调，每组一次——这种在调用那一行上面写 `// cosmic-allow: 按下游单据类型分组`。

**循环里调的方法查库 → 把查库提出来。** 循环里调本类或工具类的方法，那个方法里查库，和直接写在循环里一样。
把方法改成收一个查好的 Map（或改成一次收一批编号），查库挪到循环外。

**循环里取缓存、元数据 → 循环外取一次。** `EntityMetadataCache.getDataEntityType(...)`、`loadFromCache` 的结果
在一次调用里不会变，循环外取到变量里，循环里用变量。界面刷新（`updateView`）同理，循环结束后刷一次。

**字符串标识 → 用常量类里的。** 本文件已经用着 `DemoBillConst`，又写了 `"demo_qty"`：改成
`DemoBillConst.QTY`。插件里自己声明 `private static final String QTY = "demo_qty"`、而常量类里已有同值的：删掉自己这份，
改用常量类的。常量类里没有的标识，加进这张单的常量类，插件里不另起一份。

**方法太长、类太长 → 拆。** 超过 80 行的方法按步骤拆成几个私有方法（取数、计算、写回各一个）。
类已经超过 500 行，新逻辑写进同包的服务类（例如 `DemoBillService`），插件里只留事件入口和一行调用；
这样的服务类不依赖 `View`、`Model`，探针也能直接调（见上一节）。

## 按类型加载详细文档

| 当前任务 | 只读这个 |
|---|---|
| 表单、单据、F7、列表、左树右表、报表界面 | [plugin-ui.md](plugin-ui.md) |
| 操作插件、事务阶段、BOTP、反写 | [plugin-operation.md](plugin-operation.md) |
| 报表取数、批量引入、后台任务、工作流、自定义 API | [plugin-integration.md](plugin-integration.md) |
| 打印取数、动态表格、图片、运行态样式 | [plugin-print-runtime.md](plugin-print-runtime.md) |
| QFilter、DynamicObject、DataSet、缓存、锁、事务、日志 | [sdk.md](sdk.md) |
| 类名/方法名幻觉和场景错配 | [anti-patterns.md](anti-patterns.md) |
| 官方插件指南、通用场景、SDK/API 语义 | [official-knowledge.md](official-knowledge.md) |

## 交付检查

上面「先走公共开发流程」那张表管的是**动手前**，这里只列它没覆盖、且**做完才看得出来**的：

1. UI、数据包、事务和并发边界没有混用（同一段逻辑没有同时依赖 `getView()` 和事务回调）。
2. 业务代码变化后先 `fast`，再让探针或 `run` 加载最新 classes；`deploy` 只在用户明确要求时跑。
3. 只有界面或视觉行为必须确认时才启动节点。
4. 元数据修改在写调用里附 report（写探针 `APPLY=1`，`cosmic_meta` 写动作 `apply=true`），工具预演、弹确认单，用户确认后在常驻进程里落库并回读；测试业务数据用 DataSeedProbe / DataUpdateProbe，默认直接落库，不需要确认。
