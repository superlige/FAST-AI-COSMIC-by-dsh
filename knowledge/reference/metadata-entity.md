---
class: B
when: 实体 / 字段读取：标识、类型、精度、分录、基础资料、写值约束
---

# 实体与字段元数据（读取）

来源：真实苍穹 8.0 二开工程实测。本文只覆盖读取和写业务值前的约束检查；修改字段见
[metadata-entity-write.md](metadata-entity-write.md)，实体业务规则见
[metadata-business-rules.md](metadata-business-rules.md)。

读取前先用 [metadata-read.md](metadata-read.md) 判断手里的标识是实体还是布局。本页只讨论
实体侧：字段、分录、精度、操作、校验和工具栏按钮。

- [运行时元数据](#运行时--metaprobe)
- [设计器里存的配置](#设计器里存的配置--formlayoutprobe)
- [操作、校验与按钮](#操作--操作插件--校验规则--工具栏按钮--opmetaprobe)
- [字段类型](#字段类型对照)
- [精度陷阱](#precision--scale-的陷阱)
- [写值前检查](#写值之前--fieldlimitprobe)


## 运行时 —— MetaProbe

`EntityMetadataCache.getDataEntityType()`，打印**当前真正生效的值**。改完元数据后
用它独立确认，别只信 save 的返回值。

```bash
META_ENTITY=<实体标识> META_FILTER=<字段标识片段> node .claude/skills/long-cosmic-dev/driver.mjs probe MetaProbe
```

```
[PROBE] 实体 demo_sys_test_bill  名称=实验室检测单  表=tk_demo_sys_test_bill  类=BillEntityType
[PROBE]    demo_djxcd1  对角线长度1（mm）  DecimalProp  precision=23 scale=10
```

会递归分录并标出表名；基础资料字段打印 `-> 目标实体`。`META_FILTER` 可以写几个关键字、逗号隔开（`bglx,ysbz,报告`），
标识或名称含任一个就打印；不给就把整个实体（实验室检测单 1360 个字段）全刷出来。

## 设计器里存的配置 —— FormLayoutProbe

`MetaProbe` 看的是运行时生效值（小数字段没配小数位也显示默认 10）；设计器里实际存了什么、
每项属性当前值和默认值各是多少，用 `FormLayoutProbe` 按标识或中文名找字段，再列它的属性清单：

```bash
LAYOUT_FORM=<单据标识> LAYOUT_FIND=<标识或名称片段> LAYOUT_PROPS=<字段标识> node .claude/skills/long-cosmic-dev/driver.mjs probe FormLayoutProbe
```

```
[PROBE]   contentpanel > demo_fieldsetpanelap1(试样信息) > demo_jgfs_head  FieldAp(ComboField)  专业室加工方式
[PROBE]     DefValue「缺省值」 refcombo 当前=1
[PROBE]     MustInput「必录」 checkbox 当前=false
```

括号里是字段的设计器类名（见[字段类型对照](#字段类型对照)）。用法和平台行为见 [metadata-form.md](metadata-form.md)。

## 操作 / 操作插件 / 校验规则 / 工具栏按钮 —— OpMetaProbe

字段之外的东西全在这里：**操作、操作上绑的[操作插件](plugin-operation.md)、合法性校验、单据状态项、单据和列表
两侧的工具栏按钮**（按所在工具栏分组，按钮后面接它绑的操作）。`MetaProbe` 只遍历字段，这些一个都看不到；
**操作插件绑在操作上而不是布局上，`FormPluginProbe` 也查不到它们**。

问的是某个工具栏、按钮或操作，加 `OP_FOCUS`（逗号分隔，三种标识混着给都行），只回这一条链：
按钮 → 操作 → 类型、操作插件、校验，再加本工程界面插件源码里用到这些标识的行
（`itemClick` 比的是按钮标识，`beforeDoOperation` / `afterDoOperation` 比的是操作标识，写成常量的也认）：

```bash
OP_ENTITY=<实体标识> OP_FOCUS=tbmain node .claude/skills/long-cosmic-dev/driver.mjs probe OpMetaProbe
```

```
[PROBE] ── tbmain  工具栏  在 titlepanel 标题区 里  11 个按钮（单据界面）
[PROBE]   bar_submit  提交  → submit  type=submit  visible=[init,new,edit,submit]
[PROBE]      插件 demo.zljy.opplugin.TestBillSubOp
[PROBE]      校验 MustInputValidation  字段值合规性校验  停用
[PROBE]      下拉项 bar_unsubmit  撤销  → unsubmit  type=unsubmit
[PROBE]   bar_more  更多  → 没绑操作  visible=[]
[PROBE] ── 界面插件源码里用到这些标识的行（单据界面插件 8 个、列表界面插件 2 个，按本工程源码查）
[PROBE]   demo-mod/src/main/java/demo/zljy/formplugin/DemoBillFormPlugin.java:50  beforeDoOperation  printpreview
```

不给 `OP_FOCUS` 是全列，带 id；工具栏是 `──` 开头的一段，输出被裁时目录里按工具栏列出行号：

```
[PROBE]   audit  启用  type=audit  id=c91d5125000035ac
[PROBE]      插件 demo.zljy.opplugin.StatusChangeOpPlugin  enabled=true
[PROBE]      校验 ConditionValidation  合法性校验  enabled=false  id=194cc693000015ac
[PROBE] --- 单据状态  默认值=C
[PROBE]   A = 不可用   （StatusItem id=1）
[PROBE] --- 单据工具栏  1 个工具栏、11 个按钮
[PROBE]   ── tbmain  工具栏  在 titlepanel 标题区 里  11 个按钮
[PROBE]     bar_audit  启用  op=audit（启用 type=audit）  visible=[init,submit,audit,edit,view,new]  隐藏=false  id=rll2vYoF7P
[PROBE]         下拉项 bar_unaudit  禁用  op=unaudit（禁用 type=unaudit）  visible=[,...,]  切换=true  id=TKVTORJ=POA
```

几件实测出来、不查就会踩的事：

- **列表布局不是独立元数据。** `MetaCategory` 只有 `Form` 和 `Entity` 两个值，列表是塞在
  `fm.getRootAp()`（`BillFormAp`）里的一份 `FormMetadata`，用 `getListMeta()` 取；
  移动端同理（`getMobMeta()` / `getMobListMeta()`）。`save(em, fm)` 会连它一起写。
- **同一个单据模板派生出来的单据，继承来的操作和按钮 id 完全一致。** 三张硬度标准块单
  （布氏/洛氏/维氏）都继承 `00305e8b000006ac`，`audit` 恒为 `c91d5125000035ac`、
  `bar_submit` 恒为 `lgThqDlzuX`。同一继承谱系里这些 id 往往保持一致，可作为批量核对线索；**仍要逐个读取目标单据确认**，不要把一个样本的 id 未经复核直接写到其它模板。
- **`Validation` 上是 `getEnabled()`，没有 `isEnabled()`**。按 `isEnabled` 反射会拿到 null，
  然后把「本来就是 false」误判成「需要改」。
- **`StatusItem` 上是 `getStatusName()` / `getStatusKey()`**（A/B/C），不是 `getName()`。
  序列化出来的标签却是小写的 `<statusname>`。

## 字段类型对照

界面上的字段类型和设计器类名（`FormLayoutProbe` 找字段时括号里那个，`add field` 也写这个名字）。常用类型：

| 界面上的类型 | 设计态类 | 包 | 类型专属属性 |
|---|---|---|---|
| 文本 | `TextField` | `entity.commonfield` | `setMaxLength` |
| 多行文本 | `TextAreaField` | `entity.commonfield` | `setMaxLength` |
| 大文本 | `LargeTextField` | `entity.commonfield` | 全文在 `<标识>_tag`，`<标识>` 只放界面上的摘要；各类型落库的列见 [metadata-entity-write.md](../cosmic-metadata-entity-write/SKILL.md#加字段add-field) |
| 整数 | `IntegerField` | `entity.commonfield` | — |
| 小数 | `DecimalField` | `entity.commonfield` | `setPrecision` / `setScale` |
| 金额 | `AmountField` | `entity.businessfield` | `setCurrencyFieldId`（必须） |
| 基础资料 | `BasedataField` | `entity.businessfield` | `setBaseEntityId`（**要元数据 id**） |
| 下拉选项 | `ComboField` | `entity.commonfield` | `setItems(List<ComboItem>)` |
| 复选框 | `CheckBoxField` | `entity.commonfield` | `setDefValue(boolean)` |
| 日期 | `DateField` | `entity.commonfield` | — |
| 长日期 | `DateTimeField` | `entity.commonfield` | — |

包前缀都是 `kd.bos.metadata.`。其余在这张单上出现过的类：`ModifierField`、`ModifyDateField`、
`MulBasedataField`、`MulComboField`、`BasedataPropField`、`UserField`、`OrgField`、`BillTypeField`、
`RefBillField`、`SubEntryEntity`、`BigIntField`、`RadioField`。

层级关系：`EntityItem extends AbstractElement`（`getId/setId/getKey/getName/getParentId`），
`Field<T> extends EntityItem<T>`（`setFieldName/setMustInput/...`）；
`LargeTextField extends TextField`，`AmountField extends DecimalField`，
`SubEntryEntity extends EntryEntity`。

## precision / scale 的陷阱

**`precision` / `scale` 是基类 `Field` 的属性，所有字段都有，非数值类型上是无意义的默认值
23/10。** 读设计态对象时，`TextField`、`DateTimeField` 上也取得到 `precision=23 scale=10`，
别当真。

只有 `DecimalField` 及其子类的 scale 才有含义：`demo_hjwd` scale=2、`demo_hjsd` scale=4
是设计器里真配过的，而 **scale=10 基本等于「没配」**。

配套结论（已实测）：**小数字段元数据没配 `<Scale>` 时，苍穹默认 10 位小数，不是 2 位。**
探针实测 `demo_f1` 返回 `9.8070000000`。判断字段精度别按 2 位推。

## 写值之前 —— FieldLimitProbe

上面两个查的是**字段长什么样**；这个查的是**值能不能写进去**。三类约束一次问清：

| 约束 | 违反后怎么失败 | 什么时候才暴露 |
|---|---|---|
| 文本 `maxLength` | `Data too long for column 'xxx'` | **落库那一刻** |
| 小数 `precision/scale` | 值悄悄多出小数位，不报错 | 对账时 |
| Combo 合法值 | 界面显示空白，不报错 | 界面上 |

三个都是「写下去才知道」的，所以别撞 —— 撞一次就是一轮 30 秒往返。

```bash
LIMIT_ENTITY=<实体标识> node .claude/skills/long-cosmic-dev/driver.mjs probe FieldLimitProbe
```

```
[PROBE] 实体 demo_canshu  参数存储  表=tk_demo_canshu
[PROBE] --- demo_canshu ---
[PROBE]   number      编码      TextProp          最长 30
[PROBE]   name        名称      MuliLangTextProp  最长 50
[PROBE]   enable      使用状态   BillStatusProp    合法值 2 个: 0=禁用, 1=可用
[PROBE]   demo_bz     备注      TextProp          最长 50
[PROBE]   demo_value  值        TextAreaProp      最长 2000
```

**它按运行时 `Prop` 类型分支**：只有真正的 `DecimalProp` 才输出精度，`scale=10` 会额外标一句
提醒确认是有意配的还是漏配走了默认。主表和全部分录一起遍历，`LIMIT_FIELD` 可按关键字过滤。

带上待写的值就直接判超限，写之前先跑一把：

```bash
LIMIT_ENTITY=demo_canshu LIMIT_VALUES="name=$(printf 'a%.0s' {1..60});enable=9" \
  node .claude/skills/long-cosmic-dev/driver.mjs probe FieldLimitProbe
```

```
[PROBE] --- 值校验 ---
[PROBE]   !! name    长度 60 > 上限 50，超 10
[PROBE]   !! enable  值「9」不在 items 里，写进去界面会是空白
[PROBE] 2 个字段过不了，先改再写
```

值里含分号（JSON 之类）时改用 `LIMIT_VALUE_FILE=文件路径`，每行一条 `字段=值`。

**⚠️ 方法名是 `getMaxLenth()`，苍穹拼错了少一个 g。** 自己写代码取长度时别按 `getMaxLength`
写，`api` 查出来是什么就是什么。探针内部用反射拿，因为 `TextProp` /
`MuliLangTextProp` / `LargeTextProp` 各有各的继承链。
