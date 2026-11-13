---
class: B
when: 字段改名、新增、复制或删除；已有单据上加分录
note: 先读写入总则
---

# 实体与字段元数据（写入）

来源：真实苍穹 8.0 二开工程实测。加表头和分录字段、加分录、从别的单据照搬表头和分录字段、删字段、按备份退回（字段 id 不变），都在共享环境落库验证过。

**先读 [metadata-write.md](metadata-write.md)**，确认归属、授权、备份、dry-run 和写后回读。
本文只适用于自有 `<isv>_` 元数据；读取实体结构见 [metadata-entity.md](metadata-entity.md)。

- [改字段名或下拉项](#改字段名--下拉项)
- [加字段、照搬字段、删字段、加分录](#加字段照搬字段删字段--formlayoutwriteprobe)


下面全部只适用于 `<isv>_` 自己的元数据，且默认 dry-run，`APPLY=1` 才落库。
红线、四步、风险分级见 [metadata-write.md](metadata-write.md)。

## 改字段名 / 下拉项

**改字段显示名**用 `FormLayoutWriteProbe` 的 `set <字段>.Name=<新名称>`（见 [metadata-form.md](metadata-form.md#改控件字段操作和插件--formlayoutwriteprobe)），字段和同标识控件上的名称一起改。
**修改已有下拉项**没有已发布写通道，临时探针只准读：由用户在开发平台改，把要改成的下拉项列给用户（已有项的存储值不动，见下面的坑）。

下面保留历史实测的保存逻辑，供实现已发布探针参考，不能作为临时探针执行：

```java
String id = MetadataDao.getIdByNumber(ENTITY, MetaCategory.Entity);
EntityMetadata em = (EntityMetadata) MetadataDao.readMeta(id, MetaCategory.Entity);
FormMetadata  fm = (FormMetadata)  MetadataDao.readMeta(id, MetaCategory.Form);

//红线：只准动本 ISV 的元数据，写探针必须先过这两关
IsvGuard.assertOwnEntity(ENTITY, em);
IsvGuard.assertOwnField(FIELD);

//① 实体侧：字段名 + 下拉项 caption（value 一个都不动）
ComboField field = null;
for (EntityItem<?> item : em.getItems()) {
    if (FIELD.equals(item.getKey()) && item instanceof ComboField) {
        field = (ComboField) item;
    }
}
field.setName(new LocaleString(NEW_NAME));
for (ComboItem ci : field.getItems()) {
    ci.setCaption(new LocaleString(...));      //只改 caption，别碰 ci.getValue()
}

//② 表单侧：界面上显示的名称在 ControlAp 上，不改的话界面还是老名字
for (ControlAp<?> ap : fm.getItems()) {
    if (FIELD.equals(ap.getKey())) {
        ap.setName(new LocaleString(NEW_NAME));
    }
}

//③ 落库 + 让运行时生效
if (!"1".equals(System.getenv("APPLY"))) { return; }   //默认 dry-run，这行不能省
new MetadataWriter(fm.getModelType()).save(em, fm);
MetadataDao.rebuildRuntimeMetaById(id);
```

**写成幂等的**，并把老值一起写死在常量里当回滚开关（`ROLLBACK=1 APPLY=1` 改回去）。

改完用 `MetaProbe` 独立读一遍运行时确认：

```bash
META_ENTITY=<实体标识> META_FILTER=<字段标识片段> node .claude/skills/long-cosmic-dev/driver.mjs probe MetaProbe
```

```
[PROBE]    demo_jg  是否合格  ComboProp  下拉项: 1=合格 2=不合格
```

### 坑

- **界面上的字段名在表单侧的 `ControlAp` 上，实体侧改了不算数。** 同一个字段两处都要改，
  否则实体里叫新名字、界面还是老名字。下拉项则只在实体侧的 `ComboField.getItems()` 上。
- **改下拉项时只动 `caption`，别动 `value`** —— value 是落库的值，改了存量数据全部对不上。
- `MetadataWriter` 必须带 modelType、别用 `deployMetadata`、修改人取自 `COSMIC_USER` ——
  这三条是所有写元数据操作共用的，见 [metadata-write.md](metadata-write.md#实体与布局的标准保存链)。

## 加字段、照搬字段、删字段 —— FormLayoutWriteProbe

加删字段写在单据的改动清单里，和挪控件、改属性、加按钮是同一份清单、同一次 dry-run、同一次落库。
清单的通用写法、`APPLY=1` 要带的 `LAYOUT_BACKUP`、用 `LAYOUT_RESTORE` 退回，见
[metadata-form.md](metadata-form.md#改控件字段操作和插件--formlayoutwriteprobe)。

```bash
LAYOUT_FORM=demo_sys_bgjl LAYOUT_EDIT='add field TextField demo_bgsm into fs_baseinfo 变更说明
set demo_bgsm.MaxLength=100
add field DecimalField demo_bgsl after demo_bgsm 变更数量
set demo_bgsl.Scale=3
add field ComboField demo_bglx after demo_bgsl 变更类型 items=A:新增,B:修改,C:删除
add field BasedataField demo_bgr after demo_bglx 变更人 base=bos_user
add field TextField demo_bgx into demo_bgentry 变更项
copy field demo_sys_test_bill.demo_ypbh into demo_bgentry
remove field demo_old' node .claude/skills/long-cosmic-dev/driver.mjs probe FormLayoutWriteProbe
```

```
[PROBE]   布局 demo_bgsm  新增：FieldAp，在 fs_baseinfo「变更说明」
[PROBE]   字段 demo_bgsm  新增：TextField「变更说明」
[PROBE]   字段 demo_bgsm  MaxLength：（默认） → 100
[PROBE]   字段 demo_bgsm  FieldName：（默认） → fk_demo_bgsm
[PROBE]   字段 demo_old  删除：DecimalField「旧数量」
```

### 加字段：add field

`add field <字段类型> <新标识> into|before|after <目标> <名称> [base=…] [items=…] [currency=…] [table=…]`

- 字段类型写平台类名：`TextField` `TextAreaField` `LargeTextField` `MuliLangTextField` `IntegerField` `BigIntField`
  `DecimalField` `AmountField` `PriceField` `DateField` `TimeField` `DateTimeField` `CheckBoxField` `ComboField` `MulComboField`
  `BasedataField` `MulBasedataField` `UserField` `OrgField` `EmailField` `TelephoneField` `PictureField`。
- 放进分录（`into <分录>`）或挨着分录字段（`before|after <分录字段>`）的是分录字段，否则是表头字段。表头字段放进面板这类容器，不能放进工具栏。
- `base=<基础资料标识>`：`BasedataField` / `MulBasedataField` 必给。`items=<值:名称,…>`：`ComboField` 必给。`currency=<币别字段标识>`：`AmountField` 必给。
- `table=<关系表>`：只给 `MulBasedataField`，不给就用 `tk_<新标识>`。要 `tk_<isv>_` 开头、不超过 25 个字符、库里还没有这张表，
  本单别的分录和字段也没在用；默认名超长或被占时试算会拒，用 `table=` 另起。
- 长度、精度、小数位、必录这些属性，加完用 `set <新标识>.<属性>=<值>` 改；新字段写了它没有的属性，试算会列出它能设的。
- 试算结尾有一段「新字段落库后的样子」：哪张表加哪几列、类型和长度（没改的默认长度也报），列表上有没有这一列。
  差异里只列改过的值，实际长度看这一段。

挑类型时要知道的落库差别（表头字段落在单据表，分录字段落在分录表；每个新字段的实际列以试算为准）：
- 文本 `TextField` 不设长度是 `NVARCHAR(255)`，`MaxLength` 最大 2000；多行文本 `TextAreaField` 默认 500。
- 大文本 `LargeTextField` 落两列：`fk_<标识>` 放界面上的摘要，全文在 `fk_<标识>_tag`（NCLOB）。
- 多语言文本按语言存在 `<单据表>_L`，这类业务表不加列。
- 多选基础资料选中的值一行一个存在**它自己的关系表**里（三列：行内码 `FPKID`、单据或分录内码、基础资料内码 `FBasedataId`），业务表不加列。
  表名空着平台不建这张表：字段照样能建、能存，选的值却存不下，读回来是空集合，按它过滤报错，保存单据时序列化报空指针。
  开发平台保存时拦「表名不能为空」，平台的保存服务不拦。平台只在表不存在时建，已有的表不补列、原有的行也留着；
  建表时拼的索引名是 `idx_<表名去掉 tk>_fk`，所以表名不超过 25 个字符（Oracle 标识上限 30）。
- 图片字段 `PictureField` 落一列，存图片的地址。
- 基础资料、人员、组织字段存对方的 id。

加字段不会自动在列表上加列。要显示它，在同一改动清单里切到 `layout list`，用 `show <字段> into <列表表格>` 加列；
表格标识用 `FormLayoutProbe LAYOUT_PART=list` 查。移动端列表切到 `layout mobilelist` 后同样用 `show`。
基础资料字段只给字段标识时显示资料配置的名称字段；也可 `show <字段>.number as <新列标识> into <表格>`
明确选择编码。可显示的完整路径用 `LAYOUT_LIST_FIELDS=1` 查，列标识和字段路径的区别见 [metadata-form.md](metadata-form.md)。

### 照搬别的单据上的字段：copy field

`copy field <源单据>.<字段> into|before|after <目标> [replace=<旧>=<新>,…] [table=<关系表>]`

字段在别的单据上已经有一份、要求「配置一致」时用它，不要照着参数重新 `add field`。照搬会把参数里没有对应项、
人也想不起来要抄的配置一起带过来：F7 过滤（`Filter`）、显示属性、必录方式、运行时引用属性这些。
标识和数据库列名沿用源字段。

- **源和目标必须同层**：源上是表头字段就放到表头，是分录字段就放进分录。
- **多选基础资料不沿用源字段的关系表**，另起一张，规则和 `add field` 的 `table=` 一样：沿用的话两张单据的值存进同一张表。
- **源单据上设计态隐藏的字段，照搬过来改成可见。** 源字段常常是「默认隐藏、由那张单据自己的界面规则打开」，
  规则不跟着字段走，照抄隐藏的结果是字段建出来了，界面上永远不显示。要隐藏就在目标单据上另配规则。
- **基础资料字段的过滤条件可能引用源单据上别的字段**，形如 `GetValue(demo_djlx.number)`。目标单据上那个字段往往叫别的名字甚至没有，
  照抄过去 F7 不报错，只是筛不出数据。复制前先看一眼源字段的 `Filter`，有引用就用 `replace=demo_djlx.number=demo_djlx_jc.number` 换掉；一处都没换到会报出来。

### 删字段：remove field

`remove field <字段>` 删实体上的字段、布局里它的控件和列表上的这一列。

- 删之前查引用：界面规则、按钮这些元数据里还指着它的，这张单据挂的插件源码里还写着它标识的，都会列出来、不删，先改掉引用再删。
- 只删 `<isv>_` 前缀的、这张单据自己的字段；模板或标准产品带来的字段删不了。
- 删错了用 `LAYOUT_RESTORE=<落库时的备份目录>` 退回，字段 id 和原来一样，引用它的规则、插件不用重配。

### 加分录：add entry

`add entry <新分录标识> into|before|after <目标> <名称>`

一行建出一个普通分录（单据体），和单据模板自带的那个分录同一副样子：分录面板里有工具栏、增行和删行两个按钮、分录表格。
同一份清单后面的行就能往里加字段：

```
add entry demo_bgmx after advconap 变更明细
add field TextField demo_bgxm into demo_bgmx 变更项目
```

- 带出来的标识都从分录标识派生：面板 `<标识>_adv`、工具栏 `<标识>_advbar`、按钮 `<标识>_new` / `<标识>_del`，
  增行、删行两个操作 `<标识>_newentry` / `<标识>_deleteentry`。插件里拦增行删行、`run form --op` 点它们，用的是这两个操作标识。
- 目标是表头上的容器或控件，分录面板放在那里；不能放进另一个分录。
- 只加普通分录。子分录、树形分录、卡片分录由用户在开发平台建，把要建什么列给用户。
- 这里不删分录。刚加的分录要退回，用 `LAYOUT_RESTORE=<落库时的备份目录>`。

### 平台行为

- **落库时业务表加一列，列名 `fk_<标识>`。** 全租户生效，长度不超过 30 个字符。同一层里列名跟别的字段撞了（含源单据上改过标识、列名没跟着改的），dry-run 就拒。
- **删字段只删元数据，数据库里的列和数据留着。** 退回或重新加一个同标识的字段，会重新接上这一列和里面的旧数据。真要清掉列得手动执行 DDL。
- **加分录落库时新建一张业务表，表名 `tk_<分录标识>`。** 单据内码、分录内码、行号三列平台自带，每个字段再加一列。表名不超过 28 个字符。
  退回或删掉分录只删元数据，表和里面的行留着；以后再加同标识的分录会接上这张表和旧行，试算写明是新建还是接着用。标识想清楚再落库。
- **两个分录不能共用一张表，行会串。** 表名已经被别的单据的分录用着时试算就拒；别的单据上的分录也不能整个照抄过来，新建一个分录再 `copy field` 逐个搬字段。
- 落库后探针会把库里那份重新读一遍、逐项核对；数据库列用 `DbColumnProbe` 查：

```bash
DB_ENTITY=<单据标识> DB_FILTER=<字段标识片段> node .claude/skills/long-cosmic-dev/driver.mjs probe DbColumnProbe
# 分录字段加 DB_TABLE=<分录表名>
```

```
[PROBE]   fk_demo_bgsm  VARCHAR(100,0)
[PROBE]   fk_demo_bgsl  DECIMAL(23,3)
```
