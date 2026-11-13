---
class: B
when: 界面规则
note: 新增或修改先读写入总则
---

# 表单界面规则（读取与受控写入）

来源：真实苍穹 8.0 环境实测 —— 扫本 ISV 2762 张布局中的前 820 张（冷进程 300 秒），其中
**222 张挂了界面规则，共 3975 条规则、9937 个动作**；动作目录直接读平台
`FormRuleActionTypeCache`。新增和回滚都曾落库验证。

共享写入前先读 [metadata-write.md](metadata-write.md)；布局和控件树本身见
[metadata-form.md](metadata-form.md)；实体业务规则见
[metadata-business-rules.md](metadata-business-rules.md)。

- [先查动作目录和函数目录](#先查动作目录和函数目录)
- [读取界面规则](#读取界面规则)
- [新增和回滚](#新增和回滚)
- [界面规则的动作家族](#界面规则的动作家族)
- [条件表达式](#条件表达式)
- [元数据位置与执行结构](#元数据位置与执行结构)
- [多条规则不要互相打架](#多条规则不要互相打架)
- [继承布局：规则写在 diff 里](#继承布局规则写在-diff-里不会覆盖父层)
- [验证与坑](#验证与坑)

## 先查动作目录和函数目录

**动作类名、条件里的函数都不用背也不用猜 —— 平台自己有目录，`meta formula form` 按需查。**
动作读的是 `FormRuleActionTypeCache`（设计器列出来的就是它），`form` 只给界面规则动作（`formmeta`），
不会混进业务规则动作：

```bash
meta formula form --actions                     # 只报分类和条数，不倒全目录
meta formula form --actions --q 显示            # 按用途/说明查，每页 3 条，接着看加 --page 2
meta formula form --name MulBasedataInclude     # 条件函数按名字精确查，给参数格式和说明
meta formula form --q 为空                       # 不知道函数名时按用途查
```

每条返回写明来源和覆盖范围；查不到时会说是在别的目录里（附能照抄的查询）、名字相近，还是目录没读全。
动作的记录里带下面三个字段：

| 字段 | 取值 | 含义 |
|---|---|---|
| `controlType` | `1` / `2` | 作用于**字段** / 作用于**容器控件**（面板、字段组、分录）。挂错了不生效也不报错 |
| `serviceTypes` | `1` / `2` / `4`、`8` | 服务端动作（存进 `getRules()` 的就是这批）/ 前端 `Client*` 同名动作 / 行列样式 |
| `raiseEventType` | `251`、`1021`… | 动作的事件位。**写规则时照抄这里，别硬编码** |

界面规则和业务规则的条件**共用一份函数目录**（`meta formula biz` 查到的是同一批函数），
动作则分开：界面 26 条、实体 6 条。函数目录只说明函数怎么写，这张表单上字段存的是什么值、规则挂哪个宿主，
仍要看读模式和字段探查。

## 读取界面规则

```bash
# 遍历布局上全部 Ap 列规则，并把每个 FieldId 解析回真实控件（悬空的标 !!悬空）
RULE_FORM=demo_nbjgjl_ls \
  node .claude/skills/long-cosmic-dev/driver.mjs probe FormRuleProbe
```

输出按宿主 Ap 分组，每组带一行 `（写这个宿主用 RULE_HOST=xxx）`，直接抄给写模式。

**必须遍历全部 Ap，只看 `getRootAp().getRules()` 会得出「这张单没有界面规则」的相反结论。**
实测 820 张布局里挂着规则的宿主分布（Ap 类 → 挂了规则的 Ap 数 / 规则条数）：

| 宿主 Ap 类 | 挂了规则的 | 规则条数 | 说明 |
|---|---|---|---|
| `BillFormAp` | 228 | 2596 | 单据表头，`FormAp` 的子类 |
| `EntryAp` | 162 | 870 | **分录字段的显隐规则通常在这里，不在表头** |
| `BasedataFormAp` | 90 | 316 | 基础资料表头 |
| `ParameterFormAp` | 34 | 94 | 参数表单 |
| `ReportFormAp` | 26 | 50 | 报表过滤表单 |
| `FormAp` / `MobileFormAp` / `CardEntryAp` | 12 / 8 / 11 | 18 / 16 / 15 | 动态表单、移动端、卡片分录 |

所以**判据不是「类名叫不叫 FormAp」，而是「这个 Ap 类上有没有 `getRules()` 方法」** ——
`ControlAp` 基类上**没有**（`FieldAp` 那些一概取不到），实测有这个方法的 Ap 类共 14 个：
`FormAp` 和它的一批子类（`BillFormAp` / `BasedataFormAp` / `ParameterFormAp` / `ReportFormAp` /
`MobileFormAp` / `BalanceFormAp` / `LogBillFormAp` / `NoCodeBillFormAp` / `ReportQueryListFormAp`），
外加 `EntryAp` / `CardEntryAp` / `NoCodeEntryAp` / `ReportListAp`。所以只能反射取：

```java
FormMetadata fm = (FormMetadata) MetadataDao.readMeta(formId, MetaCategory.Form);
for (ControlAp<?> ap : fm.getItems()) {          //别忘了 fm.getRootAp() 自己
    Object v = ap.getClass().getMethod("getRules").invoke(ap);   //没这方法就 catch 跳过
    List<FormRule> rules = (List<FormRule>) v;                   //活列表，直接 add / remove
}
```

读一张布局约 0.37 秒（`readMeta` 含继承合并），全 ISV 扫一遍是分钟级，要扫就走冷进程。

## 新增和回滚

一次一组规则，分号分组、竖线分「组名 | 条件 | 字段列表」。默认 dry-run，`APPLY=1` 才落库：

```bash
RULE_FORM=demo_nbjgjl_ls RULE_TAG='试样形状显示控制-' \
RULE_GROUPS='宽度类|demo_syxz1 = "2" or demo_syxz1 = "3"|demo_wzkd1,demo_wzkd2;圆管专用|demo_syxz1 = "4"|demo_wzhd4,demo_wj2' \
  node .claude/skills/long-cosmic-dev/driver.mjs probe FormRuleProbe

# 分录字段的规则挂到它所属的 EntryAp 上
RULE_FORM=demo_sys_test_lssy RULE_HOST=demo_entryentity_lssy RULE_TAG='参数显隐-' \
RULE_GROUPS='断面尺寸|demo_syxz1 = "1"|demo_dmzj1_ls,demo_dmzj2_ls' \
  node .claude/skills/long-cosmic-dev/driver.mjs probe FormRuleProbe

# 回滚：摘掉描述以 RULE_TAG 开头、且被 RULE_REMOVE_IDS 点过名的那几条
RULE_FORM=demo_nbjgjl_ls RULE_TAG='试样形状显示控制-' RULE_REMOVE_IDS=FfRtVAup,vAz5KvC5 \
ROLLBACK=1 APPLY=1 \
  node .claude/skills/long-cosmic-dev/driver.mjs probe FormRuleProbe
```

**TAG 撞上既有规则时探针会停下，要摘就逐条点名。** 描述前缀证明不了规则是谁建的——设计器
建的规则同样可能是这个前缀。探针把撞上的几条连 id 一起列出来，然后中止；想新增就换一个
不撞的 TAG（既有规则一条不动），确实要替换就把它们的 id 抄进 `RULE_REMOVE_IDS`。
**没有「允许删别人的」这种开关**：点名要写出具体 id，这几个 id 会跟着入参进 dry-run 记录、
进给用户确认的那份报告——删什么是被人看过的，不是被一个 1 放行的。

**dry-run 先核条件，再把候选规则算一遍，两步都不落库。**

- **核条件**：条件交给平台自己的解析器，函数名对照当前环境登记的函数目录（区分大小写），字段名对照整张单据。
  写错了就停在写入之前，指出错处：`卡在「=」（第 12 个字符）：demo_wtlx =【=】 '炉前成分'`、
  `字段 demo_wtlx1 不在单据上；名字相近的：demo_wtlx`、函数不存在时给相近的登记名。
  同一处第二次还错，返回会把两次输入并排、指出这一处改没改。
- **算一遍**：把内存里的候选规则按 `run rule` 同一套算法求值，打出这次改动的规则条件是真是假、
  它管的控件最终显示还是隐藏、可编辑与否，以及是哪条规则的哪个分支决定的。
  字段值用 `RULE_SET` 给（写法同 `run rule --set`），不给就是新单默认值；要多看几个控件加 `RULE_SHOW`。
  真假两个分支各给一组值、各预演一次：

```bash
RULE_FORM=demo_wtd RULE_TAG='备注显隐-' RULE_GROUPS='炉前才显示|demo_wtlx = "炉前成分"|demo_bz' \
RULE_SET='demo_wtlx=炉前成分' \
  node .claude/skills/long-cosmic-dev/driver.mjs probe FormRuleProbe
# [PROBE]   seq=18 host=demo_wtd 条件 -> 是  [demo_wtlx = "炉前成分" = true]
# [PROBE]   demo_bz      可见=是(seq=18真)  可编辑=是(默认)   备注
```

试算只算规则这一层，不能写断言，也不算验收：条件能算不等于值写对了（下拉比存储值还是显示名、
函数参数个数，平台有的不报错只算成假），插件、改字段时的触发和界面实际效果，落库后用
`run rule form --expect`、`run form --show` 或在界面上核。

**dry-run 的最后一行是完整的授权目标清单**（布局 + 每个被规则碰到的字段），
工具直接拿它当授权的写入范围，不用抄。确认单里每组规则一行：规则名、条件的人话说法（授权时模型填的格子）、
管的字段、条件原文并排，用户对得上「人话」和「原文」是不是一回事。

| 参数 | 含义 | 默认 |
|---|---|---|
| `RULE_FORM` | 布局或单据标识 | 必填 |
| `RULE_TAG` | 规则描述前缀，**回滚的抓手**：撞上同前缀的既有规则时探针停下并列出它们的 id | 写模式必填 |
| `RULE_REMOVE_IDS` | 准许摘掉的既有规则 id，逗号隔开；新增与回滚都用它，不点名一条都不摘 | 空 |
| `RULE_GROUPS` | `组名\|条件\|字段1,字段2 ; 组名\|条件\|字段…` | —— |
| `RULE_HOST` | 挂哪个 Ap；不给挂 rootAp | rootAp |
| `RULE_ACT` | `show` 真显示假隐藏字段 / `lock` 真解锁假锁定 / `control` 真显示假隐藏**容器** | `show` |
| `RULE_SET` | 预演试算用的字段值，`字段=值;分录.字段=值` | 新单默认值 |
| `RULE_SHOW` | 预演试算时另外要看的控件，逗号隔开 | 只看改动规则管的 |
| `APPLY` / `ROLLBACK` | 落库 / 摘规则 | 都不落 |

**容器（面板、字段组、分录）必须用 `RULE_ACT=control`** —— 目录里 `controlType=2` 的那批才作用于容器，
拿 `ShowFieldAction` 指容器不生效也不报错。

**条件表达式里嵌了引号又要走 shell，引号会打架。** 规则一多就把整条命令写成 scratchpad 里的
`.sh`，用变量拼 `RULE_GROUPS` —— 实测 5 条规则、条件里 20 多个编码时，写脚本比堆命令行省事得多。

## 界面规则的动作家族

`meta formula form --actions` 的 26 条即界面规则动作，去掉前端 `Client*` 同名件后，**服务端实际能
写进 `getRules()` 的是这 13 个**：

| 作用面 | 显示 | 隐藏 | 解锁 | 锁定 | 样式 |
|---|---|---|---|---|---|
| 字段（`controlType=1`） | `ShowFieldAction` | `HideFieldAction` | `UnlockFieldAction` | `LockFieldAction` | `SetFieldFmtAction` / `DelFieldFmtAction` |
| 容器（`controlType=2`） | `ShowControlAction` | `HideControlAction` | `UnlockControlAction` | `LockControlAction` | —— |
| 行（分录） | —— | —— | —— | —— | `SetRowFmtAction` / `DelRowFmtAction` / `SetRowStyleAction` |

- 显隐锁定这 8 个 `RET` 都是 **251**；`SetRowStyleAction` 是 **6**（`serviceTypes=4`，另一条通道）。
- `Client*` 那 12 个是同一批动作的前端形态（`serviceTypes=2`），由 `buildClientActions()` 生成下发，
  **不是给你写进元数据的**。
- 真实环境 9937 个动作里，显隐锁定八件套占 9933 个，样式类只有 4 个 —— **样式类动作
  `FormRuleProbe` 没参数化**，要用得自己写探针（对象结构同下节，`setFields` 换成对应的样式属性）。

一条规则的最短构造（`FormRuleProbe` 已经封好，这里是留给它盖不住的场景）：

```java
FormRule r = new FormRule();
r.setId(Uuid8.generateShortUuid());
r.setRuleType("FormRule");                      //设计器写的就是这个值
r.setEnabled(true);
r.setSeq(n);                                    //接着现有最大 seq 往后排
r.setIsv(IsvGuard.ISV);                         //本工程 ISV，别写死
r.setDescription(new LocaleString("规则名"));    //LocaleString，不是 String
r.setPreDescription("试样形状 = \"圆形\"");       //String，设计器里给人看的条件描述
r.setPreCondition("demo_syxz1 = \"1\"");
r.setTriggerField("");                          //实测既有规则这里全是空串

ShowFieldAction show = new ShowFieldAction();
show.setId(Uuid8.generateShortUuid());
show.setActionType("ShowFieldAction");          //类名不会自动填进去，必须显式设
show.setDescription("显示字段");
show.setRET(251);                               //抄目录的 RaiseEventType
show.setFields(fieldIds);                       //List<FieldId>
r.setTrueActions(actions);
r.setFalseActions(hideActions);                 //setter 在父类 BizRule 上，见「验证与坑」
```

`FieldId` 里装的是**表单侧 `ControlAp` 的 id**，不是字段标识。这两者在很多布局上恰好相同，
但别依赖 —— 按 key 从 `fm.getItems()` 里查 `ap.getId()` 最稳，顺带验证字段在这个布局上真存在。

## 条件表达式

3975 条既有规则的条件里，各语法元素的出现次数（同一条件里多次出现按次计）：

```text
.number 1420    and 932    or 784    null 547    LIKE 503    <> 459    .id 408
true/TRUE 946   false/FALSE 382      IN/in 185   .masterid 114   != 90   NOT 69
GetCurrUserId 12   LEN( 12   JUDGE_STR_NULL 2
```

样本：

```text
demo_jylx='8' or demo_jylx='2'
demo_wtlx = "原辅材料" and org.number = "0101"
( demo_basejylx.number = "JYLX_0101_028" or demo_basejylx.number = "JYLX_0101_030" ) and org.number ="0101"
dept.number IN ('150006','150007','150008')
biztype.number in ('213','230','240','2401','405')
org.number LIKE '08%' or org.number LIKE '06%'
material = NULL or material.masterid.isdisposable = FALSE
lastupdateuser.id = null or lastupdateuser.id = 0
IsDraw() = true
GetCurrUserId() = 1700615150026904576
```

- `and` / `or` / `IN` / `LIKE` / `NOT LIKE` / `NULL` / `TRUE` / `FALSE` 都能用，括号分组可以，
  关键字大小写都收；单双引号都行（单引号 1925 条 vs 双引号 411 条，跟着所在布局的既有写法走）。
- 基础资料走 `.number` 或 `.id`；`.masterid` 可以继续往下取属性。
- ⚠️ **下拉字段比的是 `value` 不是显示名。** `demo_combofield6 = "不合格"` 看着像在比中文，
  其实那个字段的 value 本身就是「不合格」。`demo_syxz1` 的 value 是 `1`~`6`，条件必须写
  `demo_syxz1 = "1"`，写 `"圆形"` 永远不成立。改规则前先把 `ComboField.getItems()` 的
  value/caption 都打出来。
- **判空 / 判非空**（`<>` 是不等号）：

  ```text
  demo_cpdl <> null                                    有值
  demo_cpyinyong.number <> null                        有值（走 .number）
  demo_bcjyrxm.id = null                               没值（基础资料走 .id）
  lastupdateuser.id = null or lastupdateuser.id = 0     没值 —— 基础资料空值可能是 null 也可能是 0
  ```

  所以**基础资料「有值」最稳的写法是 `f.id <> null and f.id <> 0`**，两种空值都盖住。

## 元数据位置与执行结构

界面规则挂在 `ControlAp` 的 `getRules()` 上，**实体侧完全看不到** ——
`MetaProbe` / `OpMetaProbe` 一个都查不到它。它和业务规则序列化后都叫
`<Rules>`，但一个在 `DesignFormMeta`、一个在 `DesignEntityMeta`，对照表见
[metadata-business-rules.md](metadata-business-rules.md#元数据位置与执行结构)。

对象结构：

```text
FormRule extends BizRule extends AbstractRule
├─ Id / RuleType("FormRule") / Seq / Enabled / Isv / Description(LocaleString)
├─ PreCondition / PreDescription / TriggerField / RET
├─ TrueActions:  List<BizRuleAction>   ← ShowFieldAction / LockControlAction / …
└─ FalseActions: 同一套动作
```

服务端执行入口和「编译成客户端指令下发」两条路径**都真实存在**（签名实测）：

```text
AbstractRule.execute(RuleExecuteContext) -> void      服务端执行入口
AbstractRule.getDepFldSet() -> Set                    依赖字段集（哪些字段变了要重算）
FormRule.buildRuntimeRule(String) -> BR               转运行时规则；BR 也有 execute()
FormRule.buildClientActions(FormMetadata, Map)        另一条路：构建客户端动作
```

运行时到底走哪条、什么情况下走哪条**没有确证，别当事实用**。要看「某组字段值下最终显示还是
隐藏」，不必猜执行链 —— 还没落库的规则看写入预演的试算（上面「新增和回滚」），已落库的用
`run rule form <布局> --set 字段=值` 直接给结论（读规则 + 一份内存单据，
条件走 `CalcExprParser`，动作按 `seq` 累积），用法见 [run.md](run.md)、机制见
[免界面验证](../docs/技术设计/免界面验证.md) 的 R3 节。

这里的“直接给结论”按**字段**（`FieldAp` / `EntryFieldAp`）粒度给 `visible/enabled`，
并且把三层都算进去了：布局静态配置（`isInvisible` / `isHidden` / `getVisible` 场景掩码）、
父容器向下传播、界面规则按 `seq` 覆盖 —— **容器被隐藏时，它下面的字段一并判为不可见**，
归因写成 `(容器 xxx seq=3假)`。判据细节和 `--scene` / `--branch` / `--list` 见
[run.md 的 run rule 节](run.md#run-rule规则那一层算出来是什么)。

容器（分录字段组、面板）的 `visible` 能 `--expect`，统计和打印则按字段粒度走。按钮的**外观**
仍不算数：`run form --click` 只能验证点击后的插件/操作链，不能证明按钮最终可见 ——
不要拿它冒充按钮覆盖，按钮外观需浏览器验证。

**另外，规则这一层算出来的"显示"是上界** —— 布局挂的[表单插件](plugin-ui.md)还会在 `afterBindData` 里
`setVisible`，那部分静态判据够不着，见 [run.md](run.md) 的同名坑。

`ControlAp` 上还有一份 `getFrontEndRules()`，是另一套（前端规则）；本 ISV 820 张布局里
**一条都没有**，别和 `getRules()` 搞混。

## 多条规则不要互相打架

规则按 `seq` 顺序执行，**后执行的覆盖先执行的**。所以「一个形状一条规则、真显示假隐藏」
是错的 —— 归属多个形状的字段会被后面那条规则的 FalseActions 隐藏掉。

正确做法是**按「显示条件集合」给字段分组，一组一条规则**，保证每个字段只出现在一条规则里，
规则之间就没有顺序依赖了。所有取值下都显示的字段干脆不配规则。
（实测 3975 条里有 547 条只配了 TrueActions —— 单向规则也是常见写法，条件不成立时保持设计态。）

**「只出现在一条规则里」也包括既有规则，跨宿主 Ap 一样算。** 加新规则前先跑读模式，
确认目标字段没被别的规则管着。已经被管着时有两条路：

- **合并成复合条件**（推荐）—— 把两个维度 `and` 进同一条规则，再把该字段从原规则里摘掉。
  实测：断面直径/厚度/宽度原本由 6 条「试样形状」规则管，要再按检验项目控制时，先从那 6 条里
  摘掉这 4 个字段，另建 `demo_syxz1='1' and MulBasedataInclude(demo_jcxm_dx.number, 'JCXM-XN01-027')`
  两条。摘干净后，原规则负责的隐藏由新规则的 FalseActions 承担，行为等价、不留缺口。
- 或者让新规则完全接管，把旧规则删掉。

`FormRuleProbe` 新增/回滚模式按描述前缀和点名 id 操作，批量模式按规则 id 与原条件精确修改或删除，**不改既有规则的 Fields** —— 从别人建的
规则里摘字段没有已发布写通道，临时探针只准读：由用户在开发平台改，把哪条规则、摘哪几个字段列给用户；
摘完用 `FormRuleProbe` 读一遍，确认整个布局里没有残留引用。

## 继承布局：规则写在 diff 里，不会覆盖父层

继承布局（`<ParentId>` + `<InheritPath>`）的 `DesignFormMeta` 只存 diff，条目形如
`<FieldAp action="edit" oid="7ttiwm2RWY">`。

- `readMeta` 拿到的是**合并后**的完整对象，`getRules()` 里父层的规则也在。
- 往这个列表里 add 新规则再 save，序列化器只把**新增的那几条**写进 diff，父层规则不会被复制
  也不会被删。实测：布局侧 10 条，父层仍是 3 条，各自独立。
- 布局原有的其它 diff（`<Invisible action="reset"/>`、`<Visible>` 那些）原样保留。
- **只写布局就用 `save(fm)`**，别带上 `em` —— 那个 `em` 是父层单据的实体，一起传进去会连父层
  实体元数据也重写一遍（内容不变但修改人/时间会变）。
- `rebuildRuntimeMetaById()` 传**布局自己的 id**。

## 验证与坑

- **读到的规则不一定在生效**：实测 3975 条里 **480 条 `Enabled=false`**（12%）。
  按规则算显隐、或判断字段被谁管着时，先看 `isEnabled()`，否则会把停用规则当成生效的。
- **`RuleType` 不是必填**：3975 条里 708 条为空（多为原厂/老版本写入的），照样在跑。
  但设计器保存时写的是 `"FormRule"`，新增时照写，免得 diff 里显得异类。
- **动作 `RET` 抄目录，别抄邻居**：9937 个动作里 9773 个是 251（与目录的 `RaiseEventType`
  一致），另有 144 个 127、20 个 250 的历史值 —— 说明它不是强校验项，但也别跟着历史值走。
- **`TriggerField` 实测全空**（3975/3975）。依赖字段由平台从条件里推，不用自己填。
- `actionType` 与动作类名实测**完全一致**（9937/9937），所以 `setActionType(类简名)` 是对的；
  但它不会自动填，漏了序列化出来就少一个 `<ActionType>`。
- 落库后重新 `readMeta` 布局和父层各一遍，检查三件事：规则条数对不对、每个 `FieldId` 能不能在
  `fm.getItems()` 里解析回真实控件（解析不到就是悬空引用）、父层的规则数有没有变。
  `FormRuleProbe` 的读模式就是干这个的，`APPLY=1` 写完直接再跑一次读模式即可（写和读都在常驻进程里，写完马上读得到）。
- `MetaProbe` 在这里帮不上忙 —— 它查实体，界面规则在布局上。


## 同一布局批量修改或删除规则

同一布局的多条条件修改和精确删除，使用 `FormRuleProbe` 的 `RULE_BATCH` 一次提交整份清单。每项带原条件，全部核对成功后只保存和重建一次，减少反复保存布局的等待。

```text
RULE_FORM=demo_form
RULE_BATCH=update|rule1|demo_level='1'|demo_shape='1';delete|rule2|demo_level='2'
```

`update` 四列依次是操作、规则 id、原条件、新条件；`delete` 三列是操作、规则 id、原条件。用分号分项、竖线分列，条件不能含这两种分隔符。重复 id、找不到或多处同名、原条件变化、无效新条件都会拒绝整份清单。可给 `RULE_HOST` 限定宿主。不能与新增、单条修改、追加字段、`ROLLBACK`、`RULE_TAG`、`RULE_REMOVE_IDS` 混用。

先不带 `APPLY` 预演；确认单逐条列出修改和删除，确认后原清单加 `APPLY=1`。修改保留原动作，删除会移除整条规则；删除前的规则结构会打印，恢复删除需在设计器中重建完整规则。保存后独立读回，并按所需形状和级别验证最终显隐。规则删除和其他元数据保存一样复用常驻进程。
