---
class: B
when: 修改打印模板设计内容与回滚
note: 先读写入总则
---

# 打印模板（写入与回滚）

来源：真实苍穹 8.0 二开工程实测。本文只覆盖模板设计内容持久化；
查询、审计、备份和预览见 [print-template.md](print-template.md)。

这是 **W 级共享写入**。开始前先读 [metadata-write.md](metadata-write.md)，并使用
[print-template.md](print-template.md) 的有效备份和严格拓扑审计建立基线。

- [设计器原生保存链](#设计器原生保存链)
- [多语言映射](#多语言旁路映射)
- [可修改内容](#能改什么)
- [表格拓扑](#表格拓扑的不变式)
- [写入顺序](#写入顺序备份--dry-run--apply--复核)
- [禁止写法与回滚](#禁止的写法与回滚)

## 设计器原生保存链

下面是已发布写探针的实现依据，不是临时探针示例。`cosmic_probe` 的临时探针只准读；
即使加 `APPLY=1` 或 `IsvGuard`，也不能调用这里的保存方法。

`PrintTplService` 位于拼写为 `metedata` 的包：`kd.bos.print.business.metedata.service.PrintTplService`。
已有模板原位修改必须复刻这条链路，一步都不能省：

```java
PrintTplService service = new PrintTplService();
DesignMetadata dm = (DesignMetadata) service.getDesignMeta(tplId);
PrintMetadata pm = service.getPrintMetadata(dm);        //合并主设计和现有多语言

String lang = StringUtils.isNotEmpty(pm.getFixedLang())
        ? pm.getFixedLang() : "zh_CN";
DesignerMetadata designer = PrintMetadataUtil.toDesignerMetadata(pm, lang);

//浏览器提交给服务端的是普通 Map；JSON 往返可去掉控件专用对象类型。
Map<String, Object> metadata = (Map<String, Object>) SerializeUtils.fromJsonString(
        SerializeUtils.toJsonString(designer.getMetadata()), Map.class);
Map<String, LocaleValue<?>> localeValueMap = designer.getLocaleValueMap();

//1. 在 metadata 中用稳定的控件 id + key + type 唯一定位，只改目标属性。
//2. 同步修改 localeValueMap.get("<控件id>.<属性>").put(lang, 新值)。

Map<String, Object> check = service.beforeSave(metadata);
if ("false".equals(String.valueOf(check.get("success")))) {
    throw new IllegalStateException(String.valueOf(check.get("message")));
}

service.updatePrintMeta(metadata, SerializeUtils.toJsonString(localeValueMap), lang);
```

- `SerializeUtils` 是 `kd.bos.print.api.utils.SerializeUtils`。**JSON 往返不能省** ——
  直接把设计器对象图当普通 Map 传入，某些边框等控件类型会解析失败。
- `updatePrintMeta` 是平台设计器实际使用的保存入口，一个事务内更新 `t_svc_printmeta` 的设计数据、
  编码、修改人、`modifyVersion`，同步 `t_svc_printmeta_l` 多语言和 `bos_manageprinttpl` 目录名称，
  并失效两侧 ORM 缓存。
- **不要按中文全文替换。** 用 `id + key + type` 唯一定位，dry-run 时递归比较新旧 JSON，
  断言主 `metadata` 与 `localeValueMap` 各只有预期的那几处语义差异。

### 多语言旁路映射

`designer.getLocaleValueMap()` 是所有控件本地化属性的旁路映射，键是 `<controlId>.<property>`。
**公式里的字段操作数也各占一个键**，形状是 `<controlId>.formulaData.<operandId>`，值是该操作数
在设计器里显示的字段名（如 `{"zh_CN":"审核者.姓名"}`）—— 这一层容易漏，因为它不在控件属性上。

| 情况 | 要不要动 localeValueMap |
|---|---|
| 改了 `bindText` 这类可见文字 | **要**，主 Map 和目标语言项同时改 |
| 新增控件且 `bindText`/`viewText` 留空 | **不用**，省掉一整块多语言同步 |
| 克隆控件 | 要按新 id 建项，**不能把旧控件 id 的语言键原样复用** |
| 删除控件 | 要清掉它名下的项 |
| 公式里增删字段操作数 | **要**，按 `<controlId>.formulaData.<operandId>` 增删；漏了不报错，设计器里那个字段显示成空 |

⚠️ **可见文字不一定在 `name` 上。** `LayoutCell.name` 常是设计器里的通用控件名「单元格」，
打印出来的静态标题通常在 `bindText`。先同时检查目标格和相邻绑定格再决定改哪个字段。

⚠️ **旁路残留旧值：开发平台一保存，修复就被盖回去（实测坑）。** `width`/`fontSize`/`x`/`y`/`height`
这类纯数值属性在多语言旁路里各占一个键（`<控件id>.width.zh_CN` 等）。**平台保存模板时以旁路值为准
写回主 metadata** —— 旁路里残留的旧值会把已修复的属性覆盖回去，症状是「共享环境改好了，用户在
开发平台随便加个符号保存，控件又变回窄/换行/旧位置」。三个要点：

- **判断**：dump 模板后对比主 `metadata` 与 locale 映射里 `<控件id>.<属性>.zh_CN`；不一致就是隐患。
- **处理**：用 `meta ptpl apply` 改属性（它会同步所改键的旁路）；**没改的属性旁路里有旧值也要核对**
  —— 例如只改了 `width/fontSize`，旁路里的 `x` 仍是旧值，用户下次保存时 `x` 会被盖回。
- **同源控件逐模板修**：继承链上每个模板的控件是各自实例（id 不同），A 模板修了不代表 B 模板
  继承后也生效；旁路旧值随实例复制，逐个模板 apply 一遍才能根治。

## 能改什么

写入口是 `PrintTplWriteProbe` / `meta ptpl apply`，两条写法，一次给一条：

- **改一个已有的标量属性**：`--set <控件>.<属性路径>=<值>`。按已有控件 id/key 定位，
  属性路径中间只能是 Map，末端属性必须存在，类型跟旧值走。改文字、位置、尺寸、显隐、字体和边框；
  `bindField` 这类绑定属性在实际为标量时可改。数组下标、整体替换、新建属性这三种写法是硬拒绝。
- **整份提交**：`--file <设计数据json> [--locale <多语言json>]`。文件就是 `meta ptpl dump` 的产物，
  本地改完整个交回去。**加控件、加表格、改 `formulaData`、动表格拓扑走这条。**
  落库前挡五道，任何一道不过一个字都不写：候选是不是同一张模板（编码 + 挂靠单据核两遍）、
  差异由 `PrintTplDiff` 按控件 id 对齐比出来（公式整条当一个值比、读成人话）、
  **改过的公式当场试算**（见下一节）、平台自己的解析器 `parseMetadata`、拓扑审计。
  候选和库里那份一模一样时不落库。落库之后再回读一遍，和交上去的逐处比。
- **整份恢复**：`meta ptpl restore <编码> <备份目录>`。把改前那份原样写回，走的和整份提交同一条路、
  同一组关卡，照样核改前快照，不覆盖别人后来的改动。

**候选用 `meta ptpl edit` 改，别手改 JSON**：加控件、克隆、插删行列、改公式、换绑定、登记和撤掉打印插件都有命令，
控件 id、父子引用、行列格矩阵配套、合并区平移、换行记号的位置、多语言键、插件清单的存法由它生成，全程在本地改。
用法见 [meta-cmd.md](meta-cmd.md) 的第二条标准流程。

下表是平台设计结构和历史内存验证事实。临时探针只准读，这些写入由已发布探针承担。

| 目标 | 主要属性 | 联动要求 |
|---|---|---|
| 控件位置和尺寸 | `x`、`y`、`width`、`height`、分页/隐藏属性 | 值常经 `LocaleValue` 转换；用普通 Map 后改值 |
| 主数据源字段 | `dataSource`、`bindField`、`dsType`、`bindText` | 字段必须存在于 `loadDataSource` 返回树；字段名、类型和展示文本一起核对 |
| 引用数据源 | 根节点 `refDs` | 用 `BaseInfo.setRefDs/getRefList` 对应的 JSON 结构；引用实体必须真实存在 |
| 自定义数据源 | 根节点 `customDs` | 模板只声明名字和字段；**运行时还必须有打印插件 `loadCustomData` 提供同名数据** |
| 公式 | 控件 `formulaData` | 字符串片段和字段操作数按顺序组成；操作数的 `dataSource/bindField/key/formulaName/dsType` 要同步改 |
| 挂打印插件 | 根节点 `plugins` | `meta ptpl edit <候选> --plugin <类全名>` 登记；模板只记类名，平台打印时按类名现场建实例，建不出来（类名不对、类不在运行环境里）不报错、只跳过这个插件；`Enabled` 不是 true 的不加载 |

- `PrintTplService.loadDataSource(formId, refList, customList, result)` 可验证数据源树；
  `PrintMetadataUtil.parseMetadata` 负责设计结构解析。
- **公式不是单个字符串。** 实测的空值兜底是 `["IF(", 字段对象, "='', '/',", 字段对象, ") "]`。
  只改展示公式却保留旧字段对象，会造成设计器显示和实际取数不一致。
- 自定义数据源的运行例子见出处工程的打印插件包（一个打印公共插件的 `imageDs`、
  另一个打印插件的 `otherData`）。**模板里改了 `customDs`
  的名称或字段，插件必须同步**，否则设计器校验能过、打印时取不到数据。

### 给公式追加一个字段操作数

本节供理解设计结构及实现已发布探针使用；当前 `PrintTplWriteProbe` 不支持这项数组修改。

实测最常见的一类改动（例：把 `CONCAT('批准者：', 审核者.姓名)` 改成姓名后面再拼一个全拼字段）。
`formulaData` 是**字符串片段和字段操作数交替排列**的数组，追加一个字段就是在数组中间插两项：

```java
//原形状 ["CONCAT('批准者：',", {name 操作数}, ")"]  →  新形状插入分隔片段和新操作数
List<Object> nf = new ArrayList<Object>();
nf.add(fd.get(0));            //"CONCAT('批准者：',"
nf.add(nameOp);               //原字段操作数，原样保留
nf.add(",' ',");              //新的字符串片段：拼进去的分隔符
nf.add(pinyinOp);             //新字段操作数
nf.add(fd.get(2));            //")"
```

新操作数**克隆原操作数再改四项**：`id`（全模板唯一的新 id）、`bindField`、
`key`（`<dataSource>-<bindField>`）、`formulaName`。另外 `fieldType` 是随字段类型走的，
原字段是多语言字段（`MultiLangField`）而新字段是普通 `TextField` 时要**删掉这个键**，
别克隆过来。最后按上一节把 `<controlId>.formulaData.<新操作数id>` 加进 `localeValueMap`。

查函数、试公式都有现成入口，不用另写探针：

- **函数怎么写，查打印自己的函数目录**：`meta formula print --name CONCAT` 给参数格式、说明和例子；
  不知道名字用 `--group 字符串函数` 按分类翻，或 `--q` 按说明里的关键字查，不带筛选只报分类和条数。目录来自打印设计器内置的
  `PrintInitFunction.xml`（41 个）加本进程已登记的自定义函数；别的进程注册的自定义函数查不到，
  以提交时的试算结论为准。打印函数和规则函数不是同一份目录，同名的也别互相套用。
- **`CONCAT` 支持多参数**，不必写成嵌套的两两拼接。
- **改过的公式由 `meta ptpl apply` 自己试算。** 提交那一次里就做完：先用打印的公式校验按字段类型判对错
  （和设计器里点「校验」一样，`YEAR` / `MONTH` / `DAY` 只收日期字段），再按字段类型换样例值
  试三档（都空 / 只有第一个有值 / 都有值），dry-run 就能看见每一档显示成什么；公式写坏了停在落库之前，
  报平台原话和相近的函数名（「函数CONCATX不存在；名字相近的：CONCAT」），同一处第二次还错会把两次并排。
  打印算一行出了错只记一条警告、那一行打成空的；三档里哪一档这样，显示写成「（算不出来：平台原话 打印时这一行是空的）」，
  结论说「有一档算不出来」、不拦——有的是公式的毛病，有的是样例值不像真数据，用 `--pk` 在真单上看那一格。
  **这一关不能省**：实测函数名写错一个字母，平台解析、拓扑审计、`beforeSave` 一路放行，
  存进去要等打印时才发现那一格是空的。
- **要看真单上显示什么，dry-run 加 `--pk <单据ID>`**（也可以写 `billno:<编号>`）：用内存里的候选模板
  在这张单上出一次打印，打出改过的格子显示什么，模板和单据都不改。不加时 dry-run 最后一行会给出
  这张模板打哪张单据、库里最近一张的 id，照抄即可；库里一张都没有也会直说。
  预览只看这一张单，不能写断言；别的单据、分页和排版没验，落库后用 `run print --expect` 断言。
- **完整打印公式是分段数组**。换行标记的字面量是 `_enter_`，作为数组顶层元素分隔两段，
  例如 `["CONCAT('A')", "_enter_", "CONCAT('B')"]`；不要放进 `CONCAT` 的参数。
  用 `meta ptpl edit --formula` 写时多给一行 `--line` 就是换行，这些由它生成。

## 表格拓扑的不变式

页面里的控件是**扁平数组不是嵌套树**，容器关系靠 `parentId`，每个控件的 `id` 和 `key` 全模板唯一。

⚠️ **SDK 类名是 `LayoutGridRow` / `LayoutGridColumn`，但序列化后的 `type` 实测是
`DataRow` / `DataColumn`。** 不要按 SDK 类名字符串做拓扑判断。

每个表格必须保持完整矩阵：

```text
LayoutCell 数量 = DataRow 数量 × DataColumn 数量
每一个 (rowId, columnId) 交点恰好 1 个 LayoutCell
所有 row/column/cell 的 parentId 都等于该表格的 id
```

`DataGrid` 的 `DataCell` 同理。行列坐标按同一 `parentId` 下 `DataRow`/`DataColumn` 在**页面数组
中的出现顺序**算 —— 实测模板里的 `index` 可能全是 `0`，不能拿它排序。

### 增删控件

| 操作 | 要点 |
|---|---|
| 新增自由控件 | 克隆同类型控件的完整属性，生成新 `id/key`，沿用该页顶层控件实际使用的根 `parentId` |
| 删除自由控件 | 移除节点，并清理所有指向它的锚点、语言映射等旁路引用 |
| 删除表格 | 必须同时删 `LayoutGrid` 和所有以它为 `parentId` 的行/列/格，只删容器会留孤儿节点 |
| 新增行 | 加 1 个 `DataRow` + 为每个现有列各加 1 个格；新增列反过来 |

新增行列还要连带调整行高/列宽、网格总尺寸、后续控件位置，以及**受影响的 `mergeConfig` 坐标**。
「受影响」是有范围的：**新行列加在末尾时 `mergeConfig` 完全不用动**（原有合并区的坐标都在它
前面）；加在中间才要重算所有位于变更点之后的合并区。

历史复制的模板，顶层控件可能仍共同指向旧模板根 ID，平台允许这种外部根，**不要仅因此批量改根
引用**；但 `DataRow/DataColumn/LayoutCell/DataCell` 这些结构子节点必须指向当前页面内的真实容器。

### ⚠️ 新增顶层控件必须挂到「其它顶层控件共用的那个根」，不是模板自己的 id

打印引擎是从页面里那个共用根往下遍历的。把新控件的 `parentId` 写成模板自己的 id，在历史复制出来的
模板上就等于挂在树外：**落库成功、拓扑审计过、`parseMetadata` 过、`beforeSave` 过，打印时
`beforeOutputWidget` 对这个控件一次都不回调，控件静默消失**，一点错都不报。
（实测：模板45 自己的 id 是 `5SLZQZ/J1EW7`，它全部顶层控件的 `parentId` 却都是模板21 的
`5QK8F78XR=SC`。）

判据：`parentId` 不是页面内任何控件 id 的那批控件就是顶层控件，取其中出现次数最多的
`parentId` 当共用根 —— 别读根节点的 `id`。诊断同类问题就看插件里
`beforeOutputWidget` 有没有收到这个 `widgetKey`（`getWidgetKey()` 打一行就够）。

### 跨表移动与合并拆分

`LayoutCell` 跨表移动至少涉及 `parentId`、`rowId`、`columnId`、`width`、`height`，通常还要同步
边框和坐标。**目标表格的每个交点已经有一个格子，所以不能只把源格改成目标引用** —— 那会造成
源表缺格、目标表重格。只是换内容就保留两张表的拓扑、只交换业务属性；真要移动控件对象，
则成对交换两个格子的槽位属性，或同时在源槽补格、处理目标槽原格。

合并区只写在 `LayoutGrid.mergeConfig`，**完整单元格矩阵仍然保留**：

```json
{ "1_1": { "rowStart": 1, "columnStart": 1, "rowLength": 1, "columnLength": 3 } }
```

键必须等于 `rowStart_columnStart`，坐标从 0 开始；矩形不能越过当前行列数量、不能和别的合并区
重叠，`1x1` 没有意义。合并相邻格 = 增加矩形；拆分 = 删除矩形，**不要删除被覆盖的 LayoutCell**。

### ⚠️ `beforeSave(success=true)` 不是拓扑正确性证明

实测以下坏结构的 `parseMetadata` 和 `beforeSave` **全部返回成功**：缺一个单元格、同一交点两个
单元格、只删表格容器留下孤儿、跨表直接覆盖、合并矩形重叠。

`beforeSave` 只是平台保存前的业务校验。**写入前必须先让 `PrintTplDesignProbe STRICT=1` 等价的
本地拓扑审计通过。**

## 写入顺序：备份 → dry-run → APPLY → 复核

**改标量属性走 `meta ptpl apply`**（`PrintTplWriteProbe`），它把下面五步做齐了：

```bash
meta ptpl apply <编码> --set <控件>.<属性路径>=<值>          # dry-run
APPLY=1 meta ptpl apply <编码> --set <同上>                    # 真落库（cosmic_meta 里是 apply=true）
```

落库前工具自动把改前那份存进 `.cosmic-ai/evidence/backups/`，返回里报路径。写入范围 `tpl:<编码>` 由工具按 dry-run 算出，不用抄；
确认单里「控件 | 属性 | 原值 | 新值」那张表是探针每改一处报的记录排出来的。落库成功以探针打出「已落库。」为准：
「基线已变，中止」「平台校验不通过，中止」退出码也是 0，按没写成算，整份授权作废。

它有两条硬拒绝，**别在别处放宽**：属性不存在时不新建、新值的类型跟旧值走。
理由是这两种写法平台都不报错、模板照样保存，那个值只是永远不生效 —— 症状是「改了没反应」。

**加控件、删控件、动表格拓扑、改 `formulaData`，走整份提交**：
本地 `meta ptpl edit` 改候选，`meta ptpl apply --file` 交回，落库前过差异比对、平台解析和拓扑审计。
临时探针只准读，这些写入由已发布探针承担。下面五步是已发布写探针的实现与验收要求：

1. **校验归属**：经目录解析真实模板 ID，确认编码以 `<isv>_` 开头、`DesignMetadata.getIsv()` 是
   本 ISV、目录唯一且启用且 `type=B`、`modifyVersion` 和 `data` 哈希仍等于基线
   （防止覆盖别人刚保存的版本）。
2. **备份**：`meta ptpl backup`（官方导出链的 ZIP）；`meta ptpl apply` 落库前自动另存一份
   改前的 meta/locale JSON，文件名和 `meta ptpl dump` 一致，可以直接当 `meta ptpl diff` 的 A 侧。
3. **dry-run**：内存中修改 + 递归比较结构差异 + 公式试算 + 自己的拓扑审计 + `beforeSave`；
   给了 `--pk` 再用候选在那张单上出一次预览。到此结束。
4. **`APPLY=1`**（在常驻进程里写）：再次核对 `modifyVersion` 和哈希，然后 `updatePrintMeta`。
5. **复核**（常驻进程里跑即可；`meta ptpl dump` 到 after 目录再 `meta ptpl diff before after`）：目标值命中、旧值零命中、`modifyVersion` 已推进、拓扑仍 OK、目录仍唯一
   启用、原有语言行都还在。排版效果可以在探针里出 PDF 自查（`PrintMeasureProbe`，见 [print-template.md](print-template.md) 「验排版」），最终仍由用户进环境实际预览。

平台会规范化设计 JSON，写后字符长度和整段 SHA-256 可能不只体现目标字符串的变化。
**落库复核以目标节点、关键结构和多语言行的语义为准**，不要求整段 JSON 只有字符级单点差异。

## 禁止的写法与回滚

- **不要** `SaveServiceHelper.save("bos_manageprinttpl")` 或直接改 `FDATA`：绕过版本、多语言、
  资源、目录同步和缓存处理。
- **不要** `getDesignMeta → setData → update(dm)`：`getDesignMeta` 可能没有 `lName`，而 `update`
  会重建主记录并更新目录，实测可删掉目录的多语言名称。
- **不要**用 `saveOrUpdate(dm)` 做原位修改：受用户配置 `print_tpl_import_type_key` 影响，
  可能按 ID/编码匹配甚至重建 ID，不够确定。

单属性回滚仍走 `updatePrintMeta`，把官方备份里的旧值按稳定控件定位写回，再重新执行基线校验和
写入进程回读复核（显式冷进程写入后，常驻进程需重启再读）。完整 ZIP 的 `PrintTplImpExp.doImport(InputStream)` **只作灾备兜底** ——
它执行完整导入并重写审计、状态、多语言和资源，不是单属性回滚的首选。
