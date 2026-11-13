---
class: C
when: 表单、单据、F7、列表、左树右表、报表界面插件
---

# UI 插件：表单、单据、列表与报表界面

本页只处理带页面会话、能够访问 `View` / `Model` 的插件。通用开发顺序、证据等级和
交付检查见 [plugin-dev.md](plugin-dev.md)；通用 SDK 用法见 [sdk.md](sdk.md)。

> **官方语义索引**：基类语义、生命周期、事件全集和代码骨架一律读官方，本地不维护第二份。
> 入口和该族的场景表命令跑 `driver.mjs knowledge routes`；怎么读见
> [official-knowledge.md](official-knowledge.md#插件族路由表)。
> **本页只留三样：当前 SDK 差异、工程实测结论、无头验证入口。**

标为“工程实测”的结论来自一个真实二开工程（不是你的工程，标识需替换）；未标实测的签名仍要
运行 `api` / `lint`。
基类事件全集及当前无头模拟覆盖状态见
[界面插件事件的无头模拟覆盖审计](../docs/技术设计/界面事件覆盖审计.md)。

- [共同边界](#共同边界)
- [表单与单据插件](#表单与单据插件)
- [列表插件](#列表插件)
- [左树右表列表](#左树右表列表)
- [报表界面插件](#报表界面插件)
- [验证清单](#验证清单)

## 共同边界

将这类插件理解为“有页面上下文”，**不要理解成 Java 代码运行在浏览器端** —— 它一样在服务端跑。
`View` / `Model` / `PageCache` 的方法表用 `api` 查，本页不抄。

1. UI 插件只编排交互、控制界面和收集输入；复杂事务、批量查询和跨系统调用放服务层或操作插件。
2. 不直接改状态字段代替保存、提交、审核 —— 那些是操作，绕过去等于绕过整条操作插件链。
3. 页面级状态放 `PageCache`；静态字段的坑见 [plugin-dev.md](plugin-dev.md#坑静态字段跨回调共享会串页面)。
4. 字段、控件或布局标识不确定时先读 [metadata-form.md](metadata-form.md) 并跑
   `FormPluginProbe` / `FormTreeProbe`，**不要靠界面标题猜**。

## 表单与单据插件

动态表单 `kd.bos.form.plugin.AbstractFormPlugin`，单据界面 `kd.bos.bill.AbstractBillPlugIn`
（继承前者，加单据加载相关行为）。

### 表单与单据插件必知要点

写这一族插件时最容易错、而且错了不报错的几条；细节在本页后面各节和官方表单插件指南。

- 插件在服务端跑，只编排交互、控制界面和收集输入；复杂事务、批量查询和跨系统调用放服务层或操作插件。
- 保存、提交、审核是操作：直接改状态字段会绕过整条操作插件链。
- 页面级状态放 `PageCache`；非 `final` 静态字段会在并发请求之间串页面，症状是偶发取值不对。
- `afterCreateNewData` 里 `setValue` 不触发 `propertyChanged`（工程实测）：新增时要的联动，在 `afterBindData` 里显式调同一个业务方法。
- `registerListener` 时数据还没绑定，`getValue` 拿到 `null`；实现了监听接口要在这里 `addXxxListener(this)`，不注册就不会被回调（官方指南）。
- 分录字段的锁定、隐藏、必录各管到哪一层：
  - 锁定某一格用 `setEnable(Boolean, int 行号, String...)`，行号给 `-1` 是整列；单头写法 `setEnable(Boolean, String...)` 给分录字段不报错也不生效（官方指南）。
  - 整行锁定用 `EntryGrid.setRowLock(true, int[] 行号)`。
  - 隐藏只有整列：`setVisible(Boolean, String...)` 给分录字段，平台自己转成整列隐藏；没有按行隐藏的写法。
  - `FieldEdit.setMustInput` 给分录字段是整列必录。
  - 改完是什么样用 `run form --expect 分录[行].字段.enabled=false`、`分录.字段.visible=false` 断言。
- 分录超链接：`registerListener` 里取分录控件 `addHyperClickListener(this)`，`hyperLinkClick(HyperLinkClickEvent)` 里用 `getFieldName()` 分字段、`getRowIndex()` 取行；一个插件挂了几个分录时先按字段名分开。点完弹页面、弹提示用 `run form --hyperlink 分录[行].字段 --expect opened=页面 --expect message=片段` 验。
- 官方事件顺序是平台语义；这张单上实际怎么派发取决于绑了哪些插件，用 `run form --events` 看真实派发。

### 坑：`afterCreateNewData` 里 `setValue` 不会触发 `propertyChanged`

**工程实测。** 新增初始化和普通字段交互不是同一条触发链，所以照着「改这个字段会联动那个字段」
的经验写新增默认值，联动一条都不会跑，**而且不报任何错**。

判据：需要级联初始化时，在 `afterBindData` 里**显式调用同一个业务方法**，
不要指望 `setValue` 把联动带出来。

### 事实：关闭与父子页行为要按真实绑定观察

官方给的事件顺序是平台语义，不等于这张单上实际发生的顺序 —— 绑了几个插件、谁先注册都会影响。
用 `run form` / `run flow` 看真实派发，别只凭官方顺序声称已覆盖
（`--events` 打事件流，`--calls N` 打调用链）。

## 列表插件

`kd.bos.list.plugin.AbstractListPlugin`。

**官方语义索引**：过滤链、列定义、自定义取数、行交互和打开单据的事件全集与骨架读
`platform/list-plugin.md`，具体场景检索 `platform/scenes/control/list/`（11 篇）。

### 列表插件必知要点

- 按钮先用 `OpMetaProbe`（`OP_FOCUS=<按钮或操作>`）看它绑的操作、操作插件和已经在处理它的界面插件，再决定写在界面插件还是操作插件。
- `packageData`、超链接这类逐行回调里不查库：一万行就是一万次查询。
- `beforeCreateListDataProvider` 里不改基础资料引用属性，会破坏平台缓存。
- `beforeItemClick` 做校验拦截、`itemClick` 做业务，同一段逻辑只放一处。
- 超链接处理要捕获异常，没捕获时整个列表请求失败，不只是那一行。
- 工具栏操作先取选中行、校验选中状态再执行；状态校验放在点击时按选中行的数据做（官方指南）。

除最后一条，都是官方骨架不讲、**编译能过、跑起来才出事**的。

## 左树右表列表

`kd.bos.list.plugin.AbstractTreeListPlugin` / `StandardTreeListPlugin`。事件全集读
`platform/standardtreelist-plugin.md`，场景检索 `platform/scenes/tree/`（11 篇）。

### 左树右表必知要点

- `getTreeListView()` 是上下文方法，不是事件；旧资料里的 `getTreeModel()` 在 8.0 SDK 的 `AbstractTreeListPlugin` / `ITreeListPlugin` 上不存在（SDK 已核对），所需能力从 `ITreeListView` 的真实类型上查（`cosmic_knowledge action=api` / `action=findclass`）。
- 右表过滤条件在 `buildTreeListFilter` 里构造，`treeNodeClick` 里不做大查询。
- 列表插件那几条（逐行回调不查库、校验和业务各放一处）这里同样成立，见「列表插件必知要点」。

## 报表界面插件

`kd.bos.report.plugin.AbstractReportFormPlugin` 有页面上下文；真正取数的
`AbstractReportListDataPlugin` 在 [plugin-integration.md](plugin-integration.md#报表取数插件)。
查询链路和骨架读 `platform/report-plugin.md`，场景检索 `platform/scenes/report/`（7 篇）。

### 报表界面插件必知要点

- 这一族管页面交互；真正取数在报表取数插件（`AbstractReportListDataPlugin`），取数逻辑写在那边。
- 在 `verifyQuery` 拦掉缺必要条件的全表查询。
- `processRowData` 里不逐行查库，导出时会放大成性能问题。
- 导出定制用 `preProcessExportData` / `setExcelName`，签名先用 `cosmic_knowledge action=api` 确认。
- 这一族没有无头适配器，行为验证要起节点。

## 验证清单

1. 用 `FormPluginProbe` 确认当前类挂在它该在的那一处（单据布局、列表布局、移动端布局、移动端列表布局各列一段）而且启用；单据、表单、报表界面插件没挂上的用 `FormLayoutWriteProbe` 的 `add plugin <类全名>`（列表插件后面加 `to list`）挂上；移动端插件在清单里先写 `layout mobile`、移动端列表插件先写 `layout mobilelist` 再 `add plugin`（独立的移动表单不写 `layout` 行，[metadata-form.md](metadata-form.md)）。
2. 用 `FormTreeProbe` 确认字段所在布局，避免只改一个派生布局。
3. 用 `OpMetaProbe`（`OP_FOCUS=<按钮或操作>`）确认按钮、操作标识、操作插件和处理它的界面插件。
4. 用 `api` 核对所有新增 `@Override` 的参数和返回类型。
5. 行为验证走 `run form` / `run list`（`knowledge routes` 给每一族的入口）；移动端插件 `run form <单据>_mob`（独立的移动表单写它自己的标识），移动端列表插件 `run list <单据> --mobile`；
   改过业务代码时先 `fast`，`deploy` 只在用户明确要求起节点时跑。
6. 只有必须确认交互、可见性或控件状态时才启动节点做界面验收。
