---
class: A
when: 查业务数据、判断分录有没有数据、空表怎么验算法、测试环境里挑哪张单验证、单据本身不对时算谁的
---

# 查业务数据

来源：真实苍穹 8.0 二开工程实测。这一页的存在理由只有一条 —— **「查出来有行」不等于「有数据」**。

## 第一步永远是 DataProbe，不是写查询

拿到一个需求，动手验逻辑之前先问清楚「这张单、这个分录到底有没有数据」。
查下来确实没有、而验证又必须先有真数据（列表、报表、后台任务、给用户看界面），不要写临时探针去存——
临时探针只准读；造数据用 `DataSeedProbe`（能照现成的一张复制、能从上游单下推）、把现有数据改成要的状态用 `DataUpdateProbe`（只在跑一次操作时要上游是某个样子，用 `run op --set @上游.单据.字段=值`，跑完自动改回），默认直接落库、不用确认（`PREVIEW=1` 只预演），规矩见 [metadata-write.md](metadata-write.md#造测试数据dataseedprobe)。
不问就往下走，后面每一个异常现象都会被误判成代码问题。

```bash
DATA_ENTITY=<实体标识> node .claude/skills/long-cosmic-dev/driver.mjs probe DataProbe
```

```
[PROBE] 实体 demo_sys_test_bill  实验室检测单  主表=tk_demo_sys_test_bill  路由=secd
[PROBE] 主表行数 = 175
[PROBE] 分录 demo_entryentity  化学分析  表=tk_demo_hxfx  行数=298
[PROBE] 分录 demo_entryentity3.demo_ddlsub  电导率试验结果值  表=tk_demo_ddlsub  行数=0   ⚠ 空表
[PROBE] --- 样本单据 pk=2535769117659510784 ---
[PROBE]   分录 demo_entryentity1 实际加载 3 行
[PROBE] ⚠ 结论：分录 …… 全库无数据。
```

主表行数走 ORM，分录行数是**直接问数据库 `select count(*)`**（绕开 ORM，元数据说有的表
DB 上可能是空的），再拿一条真实单据看分录实际能加载几行。

| 变量 | 作用 |
|---|---|
| `DATA_ENTITY` | 必填，实体标识或**布局标识**（布局会自动换算，见 [metadata-read.md](metadata-read.md)） |
| `DATA_PK` | 可选，指定样本单据主键；不给就取 id 最大的一条 |
| `DATA_FIELDS` | 可选，逗号分隔，样本单据额外打印这几个字段的值 |

## 按条件查现有数据

使用 DataQueryProbe 的 QUERY_WHERE，条件值不加引号，in 清单用逗号隔开且不加括号。
例如 QUERY_WHERE=billno in 0001,0002,0003。这样可以一次查多个编号，避免因套用 SQL 写法被拒绝。

## 测试环境里的单据：是验证用的材料，还是要查的对象

连的是多人共用的测试环境。库里的单据是很多人、很多轮测试攒下来的，下面这些都是常态，单看一张单判断不出代码对不对：

| 看到的 | 常见来历 |
|---|---|
| 某个字段在一部分单上是空的 | 字段是后加的，老单不回填；或者写它的逻辑只在某个操作（比如审核）里跑，这张单在那段逻辑上线前就走完了，或者还没走到 |
| 单据停在暂存、提交到一半 | 别人测到一半留下的 |
| 上游单缺了下游要用的值，下推、反写走不通 | 上游是手工造的或很早以前建的，当时没有这个字段、这条规则 |
| 对这张单跑操作、打印，报的错和要验的改动不相干 | 它自己缺数据，或者挂在它上面的别的插件、别的模板有毛病 |

怎么对待一张这样的单，看这次在做什么。

**验证一处改动：单据只是材料。** 要的是一张走得到这次改动的单，不是一张处处正常的单。

- 先按改动要的条件查现成的（`DataQueryProbe`）；没有合适的就造一张，或者把现成的一张改成要的状态，
  写法见 [metadata-write.md](metadata-write.md#造测试数据dataseedprobe)。
- 跑出来报错，先看错出在哪：提示或调用栈落在这次改的类、这次改的字段上，是这次的事；
  落在别的插件、别的模板、别的单据上，是这张单自己的事，换一张。
- 换一张比弄清它为什么坏便宜。替它查上游、读别的插件、把它修好，都不在这次的交付里。
- 别人建的单可以拿来跑、可以改；跑过之后它就停在新状态。
- 交付时告诉用户两样：碰到的和这次改动无关的报错（哪张单、报什么），和这次动过哪些单。

**排查「这条数据为什么不对」：单据就是要查的对象。** 这时上表每一行都是一个候选答案，逐个排除：

- 先找全工程里谁在写这个字段（`cosmic_impact` 查 `实体.字段`），看清它在哪个操作、什么条件下才写。
- 再拿不对的和对的各看几张，比创建时间、审核时间、单据状态，和那段逻辑进代码的时间（`git log`）。
  不对的都早于那个时间、或者都没走过那个操作，是数据旧，代码没错；晚于那个时间、也走过那个操作还不对，才是代码的事。
- 结论里分开说：代码现在对不对；库里的老数据要不要补——补不补由用户定。

## 三条实测事实（不知道就一定会绕路）

**① `QueryServiceHelper.query` 返回扁平行，拿不到分录集合。**
`query("单据","分录.字段", ...)` 出来的是 `DynamicObject`，用 `get("分录.字段")` 取单值，
没有 `getDynamicObjectCollection`。要整个分录集合只能 `BusinessDataServiceHelper.loadSingle`。

**② 分录表为空时，query 照样返回行。**
分录是 LEFT JOIN 上去的，主表有 175 行、分录 0 行，查出来仍是 175 行，分录字段全是
`null` / `0`。**用 query 的 `size()` 判断「分录有没有数据」是错的。**

**③ `loadSingle` 出来分录 0 行，先怀疑数据，别先怀疑字段标识。**
判定顺序：先 DataProbe 看 DB count → count=0 就是没数据，标识没问题；
count>0 才轮到查标识（[metadata-entity.md](metadata-entity.md) 的 `MetaProbe`）。

## 表是空的，怎么端到端验算法

**在探针里造内存分录行，跑插件里那段真实公式。** 不落库、不需要有人先去录数据。
下面这段实测跑通：

```java
MainEntityType t = MetaResolve.type("demo_sys_test_bill");

//① 拿分录的行类型
ICollectionProperty entry = (ICollectionProperty) t.getProperty("demo_entryentity1");
DynamicObjectType rowType = (DynamicObjectType) entry.getItemType();

//② 造行，纯内存，不落库
DynamicObjectCollection rows = new DynamicObjectCollection(rowType, null);
for (int i = 1; i <= 2; i++) {
    DynamicObject row = new DynamicObject(rowType);
    row.set("demo_djxcd1", new BigDecimal("0.30" + i));   //字段不存在会当场抛 ORMDesignException
    rows.add(row);
}

//③ 拿这些行跑插件里的真实公式
BigDecimal hv = HardnessUtil.calcHv(f, rows.get(0).getBigDecimal("demo_djxcd1"));
```

`DynamicObjectType` 在 `kd.bos.dataentity.metadata.dynamicobject`，**不在 `...entity` 下**
（这个包名猜错过，用 `driver.mjs findclass DynamicObjectType` 一秒就能反查到）。

**这套打法有个前提：计算逻辑得是能单独调的 static 纯函数。** 写插件时就按这个来 ——
把公式从 `propertyChanged` 里抽成 `static` 方法，插件和探针共用同一份，
探针验过的就是插件真跑的那段。见 [plugin-dev.md](plugin-dev.md)。

## QFilter 速查

条件常量在 `kd.bos.orm.query.QCP`，**全表在 [anti-patterns.md](anti-patterns.md)**，
别凭感觉写（`isnotnull` 不存在，真名是 `is_notnull`）。

```java
new QFilter("billstatus", QCP.equals, "C")
new QFilter("demo_bc", QCP.in, idList)
new QFilter("demo_jgz", QCP.is_notnull, null)      //数值、日期判非空用它，不是 not_equals
new QFilter("demo_wtdh", QCP.is_notnull, null).and("demo_wtdh", QCP.not_equals, " ")  //文本判非空
```

文本字段没填时库里存的是一个空格，不是 NULL：只写 `is_notnull` 会把没填的全查出来，`is_null` 一条也查不到
（真机 261 张检测单里委托单号没填的 18 张，`is_notnull` 查出 261 张）。判空写 `is_null` 或 `equals " "`。

`QueryServiceHelper.query(实体, 字段, QFilter[], 排序, 条数)` —— 排序和条数都可省。
`filters` 传 `null` 表示不过滤。
