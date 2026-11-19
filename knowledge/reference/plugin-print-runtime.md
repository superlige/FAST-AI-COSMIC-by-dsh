---
class: C
when: 打印插件运行态取数、动态表格、图片和样式
---

# 打印插件：运行态取数、表格与图片

本页只管 `kd.bos.print.core.plugin.AbstractPrintPlugin` 的运行态行为。打印模板的查询、审计、
预览和备份见 [print-template.md](print-template.md)；写入和回滚见 [print-template-write.md](print-template-write.md)。公共开发流程见
[plugin-dev.md](plugin-dev.md)。

> **官方语义索引**：基础生命周期和通用 API 读取 `platform/print-plugin-guide.md`。本页主体是
> 当前环境的多数据源、插行、样式、分页和图片实测，不用官方通用说明覆盖。

- [打印插件必知要点](#打印插件必知要点)
- [生命周期](#生命周期)
- [识别主数据源回调](#识别主数据源回调)
- [先区分 DataGrid 与 LayoutGrid](#先区分-datagrid-与-layoutgrid)
- [改变输出行数](#改变输出行数)
- [运行态尺寸](#运行态尺寸)
- [让引擎加载插件所需字段](#让引擎加载插件所需字段)
- [改写带绑定的格子](#改写带绑定的格子)
- [LayoutGrid 插行实际是追加](#layoutgrid-插行实际是追加)
- [图片宽度与样式](#图片宽度与样式)
- [放不下的行会被劈开压缩](#放不下的行会被劈开压缩)
- [隐藏表格不会收回设计高度](#隐藏表格不会收回设计高度)
- [插入行会复制样式](#插入行会复制样式)
- [DataGrid 统计行绑定](#datagrid-统计行绑定)
- [验证顺序](#验证顺序)

## 打印插件必知要点

写打印插件时最容易错、而且错了不报错的几条，都是工程实测；细节和代码在后面各节。

- `afterLoadData` 按数据源逐个回调：先认出主数据源再改状态，方法开头无条件重置会把主数据源刚算的结果清掉。
- `DataGrid` 的明细行由绑定分录自动展开，改行数在 `afterLoadData` 替换集合；`LayoutGrid` 不自动展开，在 `beforeOutputWidget` 里自己插行。
- 引擎只加载模板里绑定过的字段：插件要读的字段，在模板里放一个 `hidden=true` 的 `DataGrid` 在 `Detail` 行绑上。
- `LayoutGrid.insertRow(index, height)` 实际追加到末尾：按调用顺序排新行，全部追加完再从后往前删占位行。
- 运行态行列尺寸约为设计态的十倍：从现有行列读宽高再分配，不写死系数。
- 模板自带、带绑定的格子写死文本会被字段解析覆盖：新增整行写，写完删模板行。
- 统计行（`rowType=Statistic`）格子用三参 `setCellValue(数据源, 字段, StatType)`，两参会抛 `ClassCastException`。
- 要隐藏控件并收回高度，在 `beforeInitWidget` 里 `setHideMove(true)`；到 `beforeOutputWidget` 再隐藏，设计高度收不回来。
- 新插入的行逐格复制样式来源行的样式（含内边距）；表格行在页底放不下时默认被劈开压缩，要整行翻页得开 `wholeRowPage`。
- 位置和尺寸用 `PrintMeasureProbe` 量坐标，不凭截图目测；格子取值用 `run print` 断言（见「验证顺序」）。

## 生命周期

继承 `kd.bos.print.core.plugin.AbstractPrintPlugin`。完整生命周期读取
`platform/print-plugin-guide.md`；新增事件前用
`cosmic_knowledge action=api query=kd.bos.print.core.plugin.AbstractPrintPlugin#<方法名>` 核对当前签名。本页后续结论只描述已经
通过真实模板/PDF 验证的运行态差异。

**事实：增删行列有两套并存的方法名，官方场景用一套、本页用另一套，都真实存在。**
`api` 查 `kd.bos.print.core.plugin.event.BeforeOutputGridEvent`，24 个方法里同时有：

| 本页用 | 官方场景用 | 差别 |
|---|---|---|
| `addRow(int) -> List` | `addGridRow(int) -> PWGridRowBo` | 返回整行格子 / 返回行对象 |
| `insertRow(int,int) -> List` | `insertGridRow(int,int[,boolean]) -> PWGridRowBo` | 同上；三参多一个 `isReMerge` |
| `insertColumn(int,int)` | `insertColumn(int,int,boolean)` | 三参多一个 `isReMerge` |

在两边资料间切换时不要以为其中一套是幻觉；按你要的返回类型选，别混用。

## 识别主数据源回调

**工程实测：`afterLoadData` 按数据源逐个回调，不是一次打印只回调一次。**

模板含自定义数据源时，主数据源一次、每个自定义数据源各一次。非主数据源回调中的
`DataRowSet` 没有主实体字段。不要在方法开头无条件重置跨回调状态，否则主数据源刚算出的
结果会被后一次回调清空。

```java
boolean mainDataSource = false;
for (DataRowSet rowSet : evt.getDataRowSets()) {
    if (!rowSet.containerKey(ENTRY_JXSY)) {
        continue;
    }
    mainDataSource = true;
    // 收集主分录数据
}
if (!mainDataSource) {
    return;
}
// 只在确认主数据源后更新本次输出状态
```

现象通常是表格数据正确、依赖缓存状态的图片页空白，而且不报错。

参考实现：
出处工程的一个打印插件 `afterLoadData`。

## 先区分 DataGrid 与 LayoutGrid

两种表格的行生成机制不同，不要混用处理方式：

| | `DataGrid` | `LayoutGrid` |
|---|---|---|
| 行从哪来 | `rowType=Detail` 由绑定分录驱动，平台自动展开 | 不自动展开，插件自己插行 |
| 改行数 | 在 `afterLoadData` 替换数据集合 | 在 `beforeOutputWidget` 增删行 |
| 隐藏加载绑定 | 绑在数据行，或使用独立隐藏 `DataGrid` | 可放在随后删除的占位行 |

参考实现：

- `DataGrid` 行转列：出处工程的一个打印插件（`*PrintPlugin`）。
- `LayoutGrid` 行转列：出处工程一个打印公共插件里的两个 `render*Pivot` 方法。

## 改变输出行数

### DataGrid

`DataGrid` 的明细展开晚于 `beforeOutputWidget`；该事件看到的仍接近设计态行。
要改变输出行数，在 `afterLoadData` 替换绑定集合：

```java
List<DataRowSet> entries = bill.getCollectionField(ENTRY).getValue();
// 按业务键聚合成新行
bill.put(ENTRY, new CollectionField(collapsed));
```

出处工程另一个打印插件用同一方式过滤前 3 行。

### LayoutGrid

`LayoutGrid` 由插件在 `beforeOutputWidget` 自己增加行（出处工程放在一个打印服务类里）。

## 运行态尺寸

**工程实测：`insertColumn` / `insertRow` / `addRow` 使用运行态单位，常见值约为设计态的十倍。**

例如模板 `columnWidth=97` 的列，运行态 `getWidth()` 返回 970；设计行高 8 对应运行态 80。
不要写死换算系数，直接从现有行列读取并重新分配：

```java
int freed = grid.getColumn(COL_A).getWidth()
        + grid.getColumn(COL_B).getWidth();
gridEvent.delColumn(COL_B);
gridEvent.delColumn(COL_A);
int width = freed / count;
```

从后往前删列，避免下标前移。把除不尽的余量给最后一列，保持总宽不变。

## 让引擎加载插件所需字段

**工程实测：打印引擎只加载模板中出现过绑定的字段。** 插件想读字段，模板里必须存在对应
`(dataSource, bindField)`。格子最终是否输出不影响字段加载。

可选做法：

1. 在真实表格加辅助列，绑定后由插件删除。
2. 更推荐在模板另放 `hidden=true` 的 `DataGrid`，指向同一分录，并在 `Detail` 行绑定所有
   插件所需字段。真实输出表格无需增加辅助列。

`DataGrid` 的辅助绑定放在 `Normal` 表头行是否同样触发字段加载没有验证，不要依赖；放在
`Detail` 行或独立隐藏加载器中。

出处工程的两个模板用 `demo_rpt_entry_loader` / `demo_rpt_subentry_loader` 同时为图片和行转列插件
加载字段。嵌套字段可直接绑定 `demo_jyxm.name`。

隐藏表格不输出，但设计高度仍可能占版面，见[隐藏表格不会收回设计高度](#隐藏表格不会收回设计高度)。

合成字段可以先 `put` 进 `DataRowSet`，再用 `cell.setCellValue(dataSource, key)` 绑定；键不必存在于
实体元数据（出处工程用它拼 `beginimageurl1..N` 这类图片地址键）。

## 改写带绑定的格子

**工程实测：模板自带且含 `bindField` 的格子，运行态写入死文本可能被字段解析结果覆盖。**

现象是模板自带格子为空，新插入格子使用相同写值代码却正常。需要整行改写时，新增整行，
写完后删除模板绑定行：

```java
for (int i = 0; i < samples.size(); i++) {
    List<PWGridCellBo> row = gridEvent.addRow(110);
    // 写入新行
}
gridEvent.delRow(1);
```

## LayoutGrid 插行实际是追加

**工程实测：当前引擎中 `LayoutGrid.insertRow(index, height)` 不会按 `index` 定位，而是追加到末尾。**

`PWLayoutGrid.createRow(rowType, index)` 将行直接追加；`index` 只影响复制哪一行的样式。
列的 `insertColumn(index, width)` 则会按指定下标插入。

因此：

- 把新行顺序视为 `addRow/insertRow` 的调用顺序。
- 全部追加完再从后往前删除模板占位行。
- 不要按“预期插入下标”立刻删除旧行，否则可能删掉刚追加的新行。

## 图片宽度与样式

### 合并不会扩大图片框

**工程实测：图片框宽度取图片所在单列的列宽，合并整行不会自动扩大图片框。**

文字使用合并后的单元格矩形，图片仍可能贴在最左一列。仅调用 `addMerge` 不能实现整行图片居中。

### 修改真实 Style

工程实测表明，旁路的 `PWGridCellBo.setStyle`/属性写法不一定影响图片绘制；引擎绘制读取的是
控件真实 `Style`。可靠做法是封一个统一入口取得并回写真实样式（出处工程里叫
`alignSingleImageCell`）：

```java
StyleAttributes attributes = style.getNewAttribute();
attributes.setPadding(new Rect(offset, 0, -offset, 0));
cell.setStyle(Styles.getStyle(attributes));
```

这里的 `style` 必须来自该实现已经验证的真实样式访问路径，不要把片段直接当成完整反射代码。

内边距与列宽不是同一单位。当前引擎挪图片框时发生两次不同单位的扣减，工程实测近似为：

```text
图片位移 = StyleUtil.pixelToLom(padding) + padding
```

`pixelToLom` 又依赖 `Toolkit.getScreenResolution()`：无头环境常见 96 DPI，开发机 150% 缩放
可能是 144 DPI。不要写死系数；用 `StyleUtil.pixelToLom(1000000L) / 1e6` 现场取比例，再用
`PrintMeasureProbe` 测量结果。

## 放不下的行会被劈开压缩

**工程实测：表格行在页底放不下时，引擎默认把这一行劈成两半跨页，不是整行挪到下一页。**

文字行劈开还看得过去，图片行劈开就是把整张图压进页底剩下的那点高度。出处工程一个模板（一行两张图、
图片行 42mm）三张图时：第 1 页排完前两张只剩 14mm，第 3 张图那行被压进这 14mm，
用户看到的现象是「第三张图变得很小」。这种事只有量坐标才认得出来
（`PrintMeasureProbe`，见 [print-template.md](print-template.md)）—— 量的是图片下方标签行：

```
改前  第2页 "3a" 标签 y=66.9pt    图片行只剩 ~10pt，图被压扁
改后  第2页 "3a" 标签 y=185.8pt   整行 42mm 完整落到第 2 页
```

设计器里对应表格的「整行分页」（设计 JSON 的 `wholeRowPage`），但插件侧拿到的 `PWGridBo`
没开放这个开关，只能反射取出真身 `AbstractPWGrid`（字段名 `grid`）：

```java
for (Field field : PWGridBo.class.getDeclaredFields()) {
    if (AbstractPWGrid.class.isAssignableFrom(field.getType())) {
        field.setAccessible(true);
        ((AbstractPWGrid) field.get(gridBo)).setWholeRowPage(true);
    }
}
```

在 `beforeOutputWidget` 里插行之前调一次就行，运行态插进去的行照样生效。
代价是页底会空出放不下的那段高度 —— 这正是「放不下就翻页」要的效果。
同一个类上还有 `setWholeGridPage`（整张表格不跨页）和 `setTempWholeRowPage`。

出处工程封成了一个 `keepRowsWhole` 工具方法，在 3 个模板上复现。

## 隐藏表格不会收回设计高度

> **先分清事件阶段，本节结论只对 `beforeOutputWidget` 成立。**
> 官方 `platform/scenes/print/05-hide-widget.md` 讲的是在 **`beforeInitWidget`** 里
> `setHideMove(true)`：那时排版尚未成型，下方控件确实会自动上移。
> `api` 佐证：`BeforeInitWidgetEvent` 全类只有 `getWidgetKey()` 和 `setHideMove(boolean)` 两个方法，
> 隐藏并偏移就是它的用途。
> **所以先试官方那条两行的路子；只有在必须等到输出阶段才能判定是否隐藏时，才用下面这套。**

**工程实测：到了 `beforeOutputWidget` 阶段，`setHidden(true)` + `setHideMove(true)`
不会可靠收回表格的设计态高度。**

引擎按设计态顺序做流式排版；运行时隐藏后，原设计高度仍可能留下空白并把签字栏推到底部。
行高完全由插件决定的表格，设计态只保留极小占位行，真实高度在运行态插入：

```java
int outputIndex = PLACEHOLDER_ROWS - 1;
for (...) {
    imageCells = gridEvent.insertRow(++outputIndex, 900);
    labelCells = gridEvent.insertRow(++outputIndex, 55);
}
for (int i = PLACEHOLDER_ROWS - 1; i >= 0; i--) {
    gridEvent.delRow(i);
}
// 删除后再按新下标添加合并区
```

不要复用模板自带行作为第一批正式内容行；其高度可能锁在设计态，造成首组内容与后续插入行不一致。

出处工程的图片渲染插件按这个顺序插行，在 2 个模板上复现。

### 绝对定位控件留下的空白只能靠改矩形收回

设计态就摆在固定位置的控件（`Text`、页头的 `LayoutGrid`）隐藏之后，那块高度是收不回来的：
**在 `beforeOutputWidget` 里** `setHideMove(true)` 和 `false` 输出一模一样（实测逐 pt 比对），
把表格的行删光也不管用（一行不留还会 `ArrayIndexOutOfBoundsException`）。
先确认这个控件能不能提前到 `beforeInitWidget` 判定隐藏（那里 `setHideMove` 是生效的）；
确实只能等到输出阶段时，才只能反射改控件矩形：

```java
Field widgetField = BeforeOutputWidgetEvent.class.getDeclaredField("widget");
widgetField.setAccessible(true);
AbstractPrintWidget widget = (AbstractPrintWidget) widgetField.get(evt);
Rectangle rect = widget.getRectangle();          //java.awt.Rectangle，单位 = 设计态毫米 ×10
widget.setRectangle(new Rectangle(rect.x, 30, rect.width, rect.height));
```

两条踩过的坑：

- **只挪被隐藏区域下面的第一个控件**，引擎会把它再下面的控件按同样位移跟着挪。
  标题、图片区、签字栏一起挪就是挪两遍，页面直接错乱（实测：签字栏挤到了第一张图的图注下面）。
- **写目标位置，别写位移**。同一个控件在一次打印里会被回调多次，写位移会累加。
  写目标位置天然幂等。

实测数字（出处工程一个续表模板，表头 76mm 改成整份只打一次）：续表标题的矩形从 `y=710` 改成 `y=30` 之后，
图片区（`y=960`）和签名区（`y=2075`）自动跟着上移 680，第 2 页正文从页顶开始。

**顺带一条口径**：这类「`afterLoadData` 里按分录复制主记录、一条分录一页」的模板，
表头和签字栏要按**整份打印件**的首尾页判断，不是每条主记录的首尾页 ——
后者在多分录时会把表头打 N 遍。做法是复制完主记录后再遍历一遍，
往首尾两条上打自己的标记字段，`beforeOutputWidget` 读这个标记。

出处工程把它封成一个 `moveToTop` 方法，配一个「是否整份首页」的标记字段。

## 插入行会复制样式

**工程实测：新行格子会从样式来源行逐格复制样式。** 如果图片行改过内边距，紧接着插入的
标签行或备注行会继承该内边距，导致整行文字平移。

判据：某行文字整体平移，位移与图片调整相关，而且该行刚好插在图片行之后。

处理方式：

- 每插入非图片行都显式恢复默认内边距；或
- 完成所有插行后再统一调整图片格样式。

图片与文字共用单元格 `Style`，但引擎的位移换算路径不同：工程实测文字只吃
`pixelToLom(padding)`，图片还额外吃一份原始 `padding`，所以两者视觉位移不相等。

## DataGrid 统计行绑定

**工程实测：`rowType=Statistic` 的格子要使用三参 `setCellValue` 创建统计值对象。**

```java
cell.setCellValue(DS_BILL, "demo_bz", StatType.TYPE_NOSTAT);
```

两参调用创建 `CellValueField`，统计行执行器会把它当成 `CellValueStat`，可能抛出：

```text
ClassCastException: CellValueField cannot be cast to CellValueStat
```

栈中出现 `executeStatRow` 时，优先检查向统计行格子写值的代码。模板作者常把备注等跨列尾行
做成统计行，动态删列重插时尤其容易触发。

## 验证顺序

1. 用 `PrintTplProbe` 确认模板和挂载插件。
2. 用 `PrintGridDumpProbe` 摊平目标表格的行列、绑定和合并区。
3. 探针直接引用业务代码时先 `fast`；只有用户明确要求在本地节点出 PDF 时才 `deploy` 并重启节点。
4. **格子里的取值（取数、合并、占位符、行转列）用 `cosmic_run` 的 `run print` 断言**，见 [run.md](run.md#run-print打印插件的最终输出)：
   `run print <模板编码> --pk <单据ID> --expect datacell9=/`；数据库里没有合适的单据就 `--set` 改一张现成的（真提交，断言靠的字段都在这次 `--set` 里给值）。
   动手改插件之前先列取数表（字段完整路径、表头还是分录、原值还是显示文字、单位），见 run.md 的 run print 一节。
   这才算验过；不要为此写临时探针、也不要去找「刚好满足条件」的单据。
5. 用 `PrintMeasureProbe` 测文字、图片、列和合并区位置，不凭 PNG 目测下结论（它量位置，不算验过）。
6. 同时覆盖有数据、空数据、多数据源、多页和不同 DPI 环境。
7. 涉及模板持久化时切回 [print-template-write.md](print-template-write.md)，执行备份、dry-run、APPLY 和复核。
