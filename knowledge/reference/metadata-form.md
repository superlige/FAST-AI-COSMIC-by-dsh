---
class: B
when: 表单布局、列表字段和工具栏、控件属性和位置、加删控件和字段、按钮和操作、挂插件、派生布局
---

# 表单布局元数据

来源：真实苍穹 8.0 二开工程实测。本文覆盖布局、控件、插件绑定和继承关系的读取，以及改、挪、加、删控件，加删字段，加分录，加删操作，挂摘插件；界面规则见
[metadata-form-rules.md](metadata-form-rules.md)。

读取前先用 [metadata-read.md](metadata-read.md) 保留布局标识和布局 FID，不要自动折叠成实体。
**新建表单**由用户在开发平台做；请用户建时说清什么、建好后怎么回验、「运行时好使、开发平台却搜不到」怎么补，
见 [metadata-create.md](metadata-create.md)。

- [控件摆在哪、改过什么、能改什么](#控件摆在哪改过什么能改什么--formlayoutprobe)
- [改控件、字段、操作和插件](#改控件字段操作和插件--formlayoutwriteprobe)
- [布局绑定插件](#表单布局实际绑定的插件--formpluginprobe)
- [下游布局与控件可见性](#反查下游布局--控件可见性--formtreeprobe)
- [可见性的三个属性](#可见性是三个独立属性只看一个会判反)
- [继承布局和控件 id](#样本继承谱系里同一字段的-ap-id-保持一致)
- [底层设计表](#底层两张-meta-表)


## 控件摆在哪、改过什么、能改什么 —— FormLayoutProbe

一张千字段的单据有近两千个布局控件，整棵读下来几百 KB。按下面的顺序只取要的那一块：

```bash
LAYOUT_FORM=<单据或布局标识> node .claude/skills/long-cosmic-dev/driver.mjs probe FormLayoutProbe   # 目录：容器和附件面板这类控件，字段、按钮只报个数
LAYOUT_FORM=<单据> LAYOUT_FIND=<标识或名称片段> …    # 找控件、字段的整条位置
LAYOUT_FORM=<单据> LAYOUT_NODE=<容器标识,…> …        # 容器下的全部控件
LAYOUT_FORM=<单据> LAYOUT_PROPS=<元素标识,…> …       # 属性面板上能改的属性
LAYOUT_FORM=<单据> LAYOUT_NODE=<容器,…> LAYOUT_ONLY_PROPS=Lock,Invisible …   # 容器和下面每个控件：这几项能不能设
LAYOUT_FORM=<单据> LAYOUT_PART=list LAYOUT_NODE=<容器,…> …     # 电脑端列表上的控件；移动端布局写 mobile，移动端列表写 mobilelist
```

单据目录里另列单据带的移动端布局和移动端列表；`LAYOUT_FIND` 几份布局一起找，每条标着在哪份上。
几份布局的控件标识会重名（都有 `billno`），`LAYOUT_NODE`、`LAYOUT_PROPS` 要看列表或移动端那份时加 `LAYOUT_PART`。
独立的移动表单、移动单据本身就是一份移动端布局，直接 `LAYOUT_FORM=<它的标识>`，不用 `LAYOUT_PART`。

一批元素要设同一项属性（全部锁定、全部隐藏）时，先用 `LAYOUT_ONLY_PROPS` 一次查：每个元素答「能设」带当前值和可选值，
或「设不了」带原因。它和写探针的 `set` 是同一套判法，这里说能设的，试算不会因为这项属性本身被拒。
和 `LAYOUT_PROPS` 一起给是只看这几个元素的这几项。

```
[PROBE]   contentpanelflex > contentpanel > fs_baseinfo(基本信息) > demo_wtdh  FieldAp(TextField)  委托单号
[PROBE]     modifierfield  EntryFieldAp(ModifierField)  修改人  Invisible=true
[PROBE]     FontSize「字体大小」 integer 当前=12 限制={"min":6,"max":72}
```

平台行为：
- 布局是一张扁平的控件表，每个控件靠 `ParentId` 挂到上级、靠 `Index` 排序。没记 `ParentId` 的控件在最外层，平台保存时会补上。
- 平台存布局只写**改过的属性**。控件行后面列的就是这些，没列的都是默认值。
- 工具栏不止一份：单据上的按钮在单据工具栏（如 `tbmain`）；列表上的按钮在列表布局的工具栏（目录里「列表布局」下的 `_toolbar_`）；
  分录的增行、删行按钮在分录的高级面板工具栏（`AdvConToolbarAp`）。三份各改各的，都在同一份改动清单里用 `set` 改。
- 属性面板的定义里，每项属性带隐藏条件：按控件类型、字段类型、上级容器类型决定显示与否。
  例如图片裁剪只对图片字段显示，扩展比率在分录里不显示。`LAYOUT_PROPS` 已经按这些条件过滤。
- `Key`（标识）、`FieldName`（数据库列名）和分录表名标 `[挡住]`：改了以后代码、规则、打印模板都对不上。
  多选基础资料的表名（`TableName`）有值时同样挡住；**空着时能 `set` 填上**（还没有关系表，没有存下的值会对不上），
  规则和 `add field` 的 `table=` 一样。要存实体的改动清单里有表名空着的多选基础资料，试算会拒并说怎么补。
  元素类型、`ParentId`、`Index` 也标 `[挡住]`：位置用下一节的 `move` 改。
  `[只读]` 是设计器里只读的；`[模板字段不能改]` 是模板或标准产品带来的字段本身的属性；`[改不了]` 是这个入口写不进去的。

## 改控件、字段、操作和插件 —— FormLayoutWriteProbe

```bash
LAYOUT_FORM=<布局> LAYOUT_EDIT='set fs_baseinfo.BackColor=#FFF7E6
set auditor.Lock=new,edit
move auditor before billno
move creator into fs_hideninfo
add FlexPanelAp demo_hist into contentpanel 变更历史
add op demo_ophist donothing 变更历史
add BarItemAp demo_bar_hist into tbmain 变更历史
set demo_bar_hist.OperationKey=demo_ophist
add plugin demo.xx.HistOpPlugin to op demo_ophist' node .claude/skills/long-cosmic-dev/driver.mjs probe FormLayoutWriteProbe
```

改动清单一行一条，`#` 开头是注释：
- `set <元素>.<属性>=<值>`：属性名、可选值、上下限就是 `LAYOUT_PROPS` 列出来的那些。真假值写 `true`/`false`，多选写逗号分隔。
  宽高、字号、字重、颜色、圆角、背景图、自定义样式都是这样一项一个值，电脑端和移动端各改各的那份。
- `set <元素>.Style=<JSON>` 改边框样式（边框、外边距、内边距）：`{"border":"1px_solid_#e5e5e5","margin":{"top":"10px"},"padding":{"left":"8px","right":"8px"}}`。
  边框写 `宽度_线型_颜色`，边距写长度；给一个值是四条边一样，分边写 `top`、`right`、`bottom`、`left`。
  只改写到的边，别的边留着；写空串清掉那条边，`Style=` 留空清掉全部。`LAYOUT_PROPS` 列的当前值就是这种写法。
- `move <控件> into <容器>` 放到容器最后；`move <控件> before|after <控件>` 放到另一个控件前后，同一容器里调顺序也用它。
- `add <控件类型> <新标识> into|before|after <目标> [名称]` 加界面控件，类型写平台类名（`FlexPanelAp`、`TabAp`、`TabPageAp`、`AttachmentPanelAp`、`LabelAp`、工具栏按钮 `BarItemAp`），属性再用 `set` 改；`remove <控件>` 连里面的控件一起删。
- `add field <字段类型> <新标识> into|before|after <目标> <名称>` 加字段，`copy field <源单据>.<字段> into|before|after <目标>` 照搬别的单据上的字段，`remove field <字段>` 删字段；`add entry <新分录标识> into|before|after <目标> <名称>` 加分录，分录面板、增行删行按钮和业务表跟着建；字段类型、参数和平台行为见 [metadata-entity-write.md](metadata-entity-write.md)。
- `add op <新标识> <操作类型> <名称>`、`remove op <操作>`；按钮绑操作用 `set <按钮>.OperationKey=<操作>`。
- `add plugin <类全名>` 挂单据插件（表单插件、报表界面插件同样挂），后面加 `to list` 挂列表插件、`to op <操作>` 挂操作插件；`remove plugin <类全名> [from list | from op <操作>]` 摘掉。
- `layout bill|list|mobile|mobilelist`：后面的行改哪份布局。`list` 是电脑端列表，`mobile` 是单据带的移动端布局，`mobilelist` 是移动端列表，`bill` 切回单据电脑端（不写就是它）。
  切过去之后 `set`、`move`、`add <控件>`、`remove`、`add plugin` 都作用在那一份上：移动端插件写在 `layout mobile` 后面，移动端列表插件写在 `layout mobilelist` 后面。
- `show <字段或路径> [as <新控件标识>] into|before|after <目标>`：把实体上已有的字段加到当前这份电脑端列表、移动端列表，或摆到移动端布局上（分录字段摆进对应的卡片分录）。列表可用完整字段路径选择基础资料的名称、编码等属性，`as` 只用于列表列。字段本身不变；撤下用 `remove <控件>`，字段和数据保留。

### 电脑端列表字段和工具栏按钮

先查 `FormLayoutProbe LAYOUT_PART=list` 的目录，列的容器是 `ListGridViewAp`，按钮的容器是 `ToolbarAp`。
用目录里的真实标识写改动清单。例如表格叫 `gridview`、工具栏叫 `_toolbar_`：

```text
layout list
show createtime into gridview
add BarItemAp demo_bar_check into _toolbar_ 核对
set demo_bar_check.OperationKey=demo_check
```

`demo_check` 必须是已有操作；需要新操作时先在 `layout bill` 下用 `add op demo_check donothing 核对` 加好，再切到列表。
新字段也先在 `layout bill` 下用 `add field` 加，再切到列表用 `show` 加列。列宽等属性用 `LAYOUT_PART=list LAYOUT_PROPS=<列>` 查，
`set` 修改，顺序用 `move` 调整。同一清单只确认、保存一次，列表和单据上的同名控件按各自布局定位，避免改错地方。

列表的字段路径和列控件标识各管一件事：`show` 的第一项选显示内容，`into`、`before`、`after` 的目标定位界面控件。
用 `FormLayoutProbe LAYOUT_LIST_FIELDS=1` 查可显示的完整路径；用 `LAYOUT_PART=list LAYOUT_NODE=<表格>` 查已有列及其绑定。
例如字段路径 `billno` 对应的列控件可能叫 `colbillno`，排在它后面应写 `after colbillno`。

基础资料只给字段标识时，按它指向的资料配置的名称字段显示；要编码或其他属性，明确给完整路径：

```text
layout list
show creator into gridview
show creator.number as demo_creator_number after creator
```

完整路径的点转成下划线作为新列标识，例如 `creator.name` 生成 `creator_name`；
`as` 可另起带开发商前缀的标识，同名控件或重复绑定都会拒绝。路径不唯一时须从字段清单选完整路径。
缺控件时的错误会列出同一字段对应的真实列控件，后续依赖没加成的列合并报告。
清单参数有误属于输入不成立：按报错修正清单可继续预演；同一错误输入反复重试仍会被拦。
平台保存前校验、编译、环境执行故障仍按运行失败处理，不能靠换参数当作已修复。

不带 `APPLY` 是 dry-run：整份清单在内存里改完，列出逐元素比出来的差异；有一处不对就一处都不改，问题一次列全。
`APPLY=1` 要同时给 `LAYOUT_BACKUP=<目录>`：落库前把改前那份存进去，只存一次库，存完重新读一遍逐项核对。
退回：把 `LAYOUT_EDIT` 换成 `LAYOUT_RESTORE=<那个备份目录>`，同样先 dry-run 看差异再执行。

```
[PROBE]   布局 auditor  Lock：new,edit,submit,audit → new,edit
[PROBE]   布局 creator  所在容器：fs_baseinfo → fs_hideninfo
[PROBE]   第 11 行「move billno into demo_bgentry」：billno 是表头字段，不能挪进分录 demo_bgentry
```

平台行为：
- 同一个标识既是字段又有控件时，属性先落在字段（实体）上，字段上没有的才落在这张布局的控件上。
  落在字段上的（差异里标「字段」）对这张单据的每个布局都生效。派生布局继承控件，自己改过的属性除外；dry-run 列出跟着变的派生布局。模板或标准产品带来的字段（没有 `<isv>_` 前缀）只能改控件上的属性。
- 字段控件只能待在自己那一层：表头字段不进分录，分录字段不出自己的分录。
- 平台保存的第一步会规整布局：去掉顶层面板多余的 `ParentId`、重写列表布局和移动端布局。每次保存都这样，差异里已经抵消，看到的只是这次的改动。
- 容器收不收某类控件按平台自己的放置规则判：分录只收字段，工具栏只收工具栏按钮，页签页只进页签。字段用 `add field` / `remove field` 加删，分录用 `add entry` 加。
- 新加的控件、操作标识带 `<isv>_` 前缀。模板或标准产品带来的控件、操作、插件只能改属性，删不了。
- 操作和操作插件存在实体上，对这张单据的每个布局都生效；`save`、`submit` 这类模板带来的操作也能挂插件。插件按类文件核对种类，单据、列表、操作插件各挂各处。
- 删控件、删操作前查引用：界面规则、按钮这些元数据里还指着它的，这张单据挂的插件源码里写着它标识的，都会列出来，先改掉再删。

### 列表常用过滤和快捷搜索字段

这两种配置决定列表让用户按哪些字段筛选。先用 `FormLayoutProbe LAYOUT_PART=list LAYOUT_NODE=<过滤容器>`
读已有筛选项，用 `LAYOUT_FILTER_FIELDS=1` 查平台可用的字段路径和筛选控件类型。
常用过滤的容器是 `FilterGridViewAp`，快捷搜索是 `FastSearchGridViewAp`，标识取真实目录。

```text
layout list
show filter billstatus as demo_status_filter into filtergridview
set demo_status_filter.Multi=false
set demo_status_filter.DefValue=C
show filter modifytime as demo_date_filter into filtergridview
set demo_date_filter.DateConst=13,63
show filter creator.id as demo_creator_search into fastsearchgridview
```

`show filter <字段路径> as <新控件标识> into|before|after <目标>` 按平台字段树创建筛选项，
带上字段绑定、对应控件类型、枚举选项或基础资料指向，避免加了一个没有选项的空筛选项。
基础资料字段使用平台给出的完整路径，例如 `creator.id`；不要把显示名称当字段路径。
同一视图不能重复放同一字段；同一字段可以分别用于常用过滤和快捷搜索，控件标识要不同且带开发商前缀。

属性先用 `LAYOUT_PART=list LAYOUT_PROPS=<筛选控件>` 查，修改仍用 `set`；例如多选 `Multi`、
缺省值 `DefValue`、常用日期 `DateConst` 和自定义日期维度 `SelectDimension`。
枚举缺省值须来自实际选项，多选时用逗号分隔；日期可用值由属性清单列出。
字段绑定 `FieldName`、值类型 `Type`、自定义标记 `Custom` 不能单独改，换字段要撤下再添加。
顺序用 `move`，自己添加的筛选项用 `remove` 撤下，实体字段和数据保留；模板带来的筛选项只能改属性。
筛选项只能留在对应的过滤视图，不能挪进显示列或工具栏。同一清单跟随布局一起预演、确认、备份和回读。

### 移动端布局和移动端列表

- 单据带的移动端布局、移动端列表是塞在单据布局里的另外两份布局，跟着单据布局一起存，控件、属性、插件各记各的：
  移动端插件只在移动端布局上生效，移动端列表插件只在移动端列表上生效，挂在电脑端布局上不会被调到。
- 字段属于实体，几份布局共用。加字段、加分录、加删操作只在电脑端那份做（`add field`、`add entry`、`add op`），
  移动端用 `show` 把已有字段摆出来。移动端上 `remove <字段>` 只撤下这份布局上的显示，字段本身还在；
  `remove field` 删字段时连它在移动端布局上的控件、电脑端列表和移动端列表上的列一起删。
- 移动端布局的最外层直接放容器（流式面板这类）；字段要放进字段布局容器（`LayoutFlexAp`），它只收字段控件。
  分录字段在卡片分录（`CardEntryAp`）里，只能摆进它自己分录的那张卡片。
- 移动端列表是卡片：每一列是卡片面板里的一个列控件，对应一个字段（`show` 建的就是这种列）。
- 运行时单据带的移动端页面标识是 `<单据>_mob`，设计态里没有这个标识，改它就是改单据布局里的那份移动端布局。
- 建在原厂或别家实体上的本 ISV 布局（例如原厂合同上建的移动单据）只能改布局本身，加删字段、操作这些改实体的行会被拒。

### 锁定、隐藏、删操作各管到哪一层

布局元数据管的是界面这一层；接口、导入、代码写值要挡，靠权限或操作上的校验（代码）。

| 做法 | 挡住什么 | 挡不住什么 |
|---|---|---|
| 字段、分录、容器设锁定 `Lock` | 这些状态下界面上不能输入 | 操作和代码写值：模板自带的审核人字段新增、修改、提交、审核全部锁定，审核时平台照样写进去 |
| 按钮设 `Invisible=true`，或 `Visible` 只留要显示的状态 | 界面上点不到这个按钮 | 操作本身还在，列表、接口、代码照样能调 |
| 删操作 | 本单据自己加的操作 | 模板带来的新增、修改、删除、保存这些删不了 |

### 附件面板

- 一张单据可以放多个附件面板，用 `add AttachmentPanelAp <新标识> into <容器> <名称>` 加。
- 附件按面板分开存：平台的附件表 `T_BAS_ATTACHMENT` 每条记着单据类型（`FBILLTYPE`）、单据 id（`FINTERID`）和面板标识（`FATTACHMENTPANEL`），
  上传到哪个面板就记哪个面板的标识。代码往指定面板放附件、或按面板取附件，用的就是面板标识。

## 表单布局实际绑定的插件 —— FormPluginProbe

决定把代码写进哪个现有插件前，必须查目标布局的真实插件清单，不能根据类注释、类名或
“这个类用了该单据字段”来推断。`FormMetadata.isRegisterFormPlugin()` 也只能说明布局注册过插件，
不能证明某个具体类已绑定。

```bash
META_FORM=<布局或实体标识> node .claude/skills/long-cosmic-dev/driver.mjs probe FormPluginProbe
```

一张单据的界面插件不止记在一处：单据布局之外，它带的列表布局、移动端布局、移动端列表布局各是嵌在单据里的另一份布局，
插件各记各的；报表的取数插件记在报表列表控件的「查询插件」属性上。探针每一处各列一段，这张单据没有的布局在末尾点名：

```
[PROBE] 布局 demo_sys_test_wqsy  id=5S1Q7WG05F24  插件数=7
[PROBE]   rowKey=2 enabled=true inherit=true class=demo.zljy.formplugin.SysTestFormPlugin
[PROBE] 列表布局  插件数=1
[PROBE]   rowKey=0 enabled=true inherit=false class=demo.zljy.listplugin.SysTestListPlugin
[PROBE] 移动端布局  插件数=0
[PROBE] 移动端列表布局  插件数=0
```

只查某个插件时加 `META_PLUGIN_FILTER`：

```bash
META_FORM=<布局或实体标识> META_PLUGIN_FILTER=<插件类名片段> node .claude/skills/long-cosmic-dev/driver.mjs probe FormPluginProbe
```

以输出中的完整类名、它所在的那一段和 `enabled=true` 作为“该插件在这一处生效”的证据：列表插件要在列表布局那段、
移动端插件要在移动端那两段才会被调到。`inherit=true` 表示插件来自继承链，不影响它在当前布局执行。

## 反查下游布局 + 控件可见性 —— FormTreeProbe

「表单布局实际绑定的插件」那节的 `FormPluginProbe` 是「给一个布局，说说它的内容」，**没有反向的** —— 「这张单派生出多少张布局」
「某字段在哪几张布局上是可见的」得自己打 meta 表。`FormTreeProbe` 把这件事包好了。

```bash
TREE_ROOT=demo_sys_test_bill TREE_FIELD=demo_mulbasedatafield1 \
  node .claude/skills/long-cosmic-dev/driver.mjs probe FormTreeProbe
```

```
[PROBE] 根 demo_sys_test_bill formId=5MCX8YL89M6R  查控件 demo_mulbasedatafield1
[PROBE] 命中布局 30 张（含根本身）
[PROBE] ✔ demo_sys_test_lssy 实验室检测（拉伸试验）  id=5YRXZOK14BNA isv=demo enabled=1 inherit=1 ext=1
[PROBE]      apId=kh8eoZJdn1AX18rLgU 控件名=量具名称（多选） hidden=false invisible=false visible=init,new,edit,view,submit,audit(63)
[PROBE] === 汇总（demo_mulbasedatafield1）===
[PROBE] 显示（非隐藏非不可见） 6 张: …
[PROBE] 隐藏或不可见 24 张: …
```

`TREE_FIELD` 不给就只列布局清单；`TREE_ONLY=shown|hidden|absent` 只列某一类
（30 张布局逐条打是 60 行，别指望管道截断，用它过滤）。

### 可见性是三个独立属性，只看一个会判反

| 方法 | 含义 |
|---|---|
| `isHidden()` | 设计器里勾的「隐藏」 |
| `isInvisible()` | 「不可见」—— **和 hidden 是两回事** |
| `getVisible()` | 按单据状态的可见性串，如 `init,new,edit,view,submit,audit`（`getVisibleValue()` 是它的位值，全选=63） |

实测：实验室检测单 30 张布局里，被挡住的 24 张**全是 `hidden=false` + `invisible=true`**。
只查 `isHidden()` 会得出「全都显示」这个完全相反的结论。

三个都是**设计态静态属性**。运行时还可能被界面规则（见 [metadata-form-rules.md](metadata-form-rules.md) 的 `FormRuleProbe`）或插件
`setVisible` 改写，要确认最终渲染结果得再查规则。

### 样本继承谱系里，同一字段的 Ap id 保持一致

实测：`demo_mulbasedatafield1` 在全部 30 张布局上的 apId 都是 `kh8eoZJdn1AX18rLgU`，
父容器 Ap 也都是 `Lq2GH3F3kL`。跟「同模板派生单据的操作/按钮 id 一致」
（见 [metadata-entity.md](metadata-entity.md) 的 `OpMetaProbe`）是同一类结论 ——
批量核对时可以拿这个 apId 当抓手；真正修改前仍要逐张布局确认，不能把样本结论当成平台级不变量。

顺带一条旁证：那 6 张显示该字段的布局把控件名改成了「量具名称」，24 张隐藏的还留着父布局的
「量具名称（拉伸、腐蚀）」。**控件名有没有被改过，是「这张布局有没有真正启用过该字段」的
旁证**，比只看可见性多一层佐证。

### 底层：两张 meta 表

探针查的是 `t_meta_formdesign`（`DBRoute.meta`）。下游的三种连法一次捞干净：

```sql
select FID,FNUMBER,FENTITYID,FPARENTID,FINHERITPATH,FISV,FENABLED,FISINHERIT,FISEXTENDED,FMODELTYPE
from t_meta_formdesign
where FINHERITPATH like '%<rootFormId>%'   -- 继承路径里出现过根
   or FPARENTID = '<rootFormId>'            -- 直接挂在根下
   or FENTITYID = '<rootFormId>'            -- 与根共用同一个实体（多布局）
   or FID       = '<rootFormId>'            -- 根自己
```

两张表的完整列（省得再花一轮探针去 `select * where 1=2`）：

| 表 | 列 |
|---|---|
| `t_meta_formdesign` | FID, FNUMBER, FENTITYID, FMODELTYPE, FSUBSYSID, FMASTERID, FPARENTID, FTYPE, FDATA, FINHERITPATH, FISV, FVERSION, FTIMESTAMP, FISTEMPLATE, FCREATEDATE, FMODIFYDATE, FMODIFIERID, FBIZAPPID, FINDUSTRY, FISEXTENDED, FENABLED, FISVSIGN, FISINHERIT |
| `t_meta_entitydesign` | FID, FNUMBER, FMODELTYPE, FSUBSYSID, FMASTERID, FPARENTID, FTYPE, FDATA, FINHERITPATH, FISV, FVERSION, FTIMESTAMP, FISTEMPLATE, FCREATEDATE, FMODIFYDATE, FBIZAPPID, FINDUSTRY, FENABLED |

在样本根单 `demo_sys_test_bill` 中，Entity id 与根 Form id 都是 `5MCX8YL89M6R`；继承布局自身另有 FID，`FENTITYID` 指向其绑定的实体。该样本的 30 张布局共用一个实体和物理表，但其它目标仍须按 `FID/FENTITYID` 实查。

`MetadataDao` 上**没有**现成的「列出下游布局」API（`getSubApps` 是应用不是布局，
`DesignFormMeta` 只有单份的 getter），别再花一轮 `api` 去找了。
