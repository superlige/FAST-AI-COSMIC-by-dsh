---
class: D
when: QFilter、DynamicObject、DataSet、缓存、锁、事务、日志
---

# 苍穹 SDK：官方路由与当前运行时差异

> 定位：本页不再复制通用 SDK 百科，只保留当前运行时验证规则和已经产生真实差异的结论。
> 官方入口：使用 `knowledge search --kind sdk|api`；完整命令见
> [official-knowledge.md](official-knowledge.md)。
> 真值裁决：单个类/方法用 `api` / `findclass`，整份 Java 用 `lint`，行为用 `probe` / `run`。

## 按主题查官方 SDK

**不要在这里维护一张官方路径表。** 按关键词直接检索：

```bash
node .claude/skills/long-cosmic-dev/driver.mjs knowledge search <关键词> --kind sdk --limit 1
```

SDK 专题多数在 4 KB 以内，检索直接回整篇正文；大一点的回开头和目录，要哪节照 `show` 字段原样取。
「事务 / 线程池 / 锁 / 附件 / 缓存」第一条都是对应专题。手抄的路径表只会漂移：
官方 `platform/sdk/` 现有 16 篇，任何本地副本都不会跟着长。
不要拼本机绝对路径读取；官方正文的签名和版本都不能覆盖当前工程 JAR。

## API 核验顺序

**本地工具约定**：

```
# 类名不确定
cosmic_knowledge action=findclass query=BusinessDataServiceHelper

# 类的真实签名，连同官方文档里每个方法的说明和参数名；#方法名 只看这一个名字
cosmic_knowledge action=api query="kd.bos.servicehelper.BusinessDataServiceHelper#load"

# 一次体检整份代码
cosmic_lint <Java文件>
```

不要再用“import 后让 javac 失败”探测单个 API。`api` / `findclass` 对本工程真实 classpath 反射，
还把官方说明对齐到每个方法上；`lint` 才负责整文件的类、方法和字段一致性。官方文档只回答用途和候选写法。

## 当前运行时实测差异

### 基础资料直接保存不会自动补 masterid

**当前环境实测**：`SaveServiceHelper.save` 直接持久化基础资料时，不会像 save 操作那样自动填
`masterid`。绕开 `executeOperate` 会得到 `masterid=0`，后续 F7 和引用可能异常。若确需直存：

```java
long pk = ORM.create().genLongId(entityId);
object.set("id", pk);
object.set("masterid", pk); // masteridType=MYSELF 时
SaveServiceHelper.save(new DynamicObject[]{object});
```

保存后独立回查 `masterid`，不能只看 save 返回条数。若业务允许，优先走实体 save 操作，让平台
插件和业务规则正常参与。

### SaveServiceHelper.update 不插新加的分录行

**当前环境实测**：`SaveServiceHelper.update` 只发 `UPDATE`。对象上 `addNew` 出来、还没有内码的分录行，
它按 `WHERE FEntryId=0` 去更新，库里一行都不插，也不报错；表头字段照常更新。结果是表头的数量变了、分录没写进去。
分录有增删时用 `SaveServiceHelper.save`：同一段代码换成 `save` 后，新行正常插入、带上内码，`removeIf` 删掉的行也从库里删了。

### 分录查询结果使用全路径属性名

**当前环境实测**：查询选择字段写成 `entryentity.field` 时，返回 `PlainObject` 的属性名也是完整路径。
按短名 `row.get("field")` 会报“实体类型 PlainObject 中不存在该属性”；应按查询选择字段的完整路径读取。

### 基础资料对象与内码不是同一种值

**当前运行时覆盖**：`xxx` 通常是 `DynamicObject`，`xxx_id` 是内码。只需内码时读 `_id`；向对象
属性写值时先加载对应基础资料对象，不把 `Long` 直接塞进对象属性。字段真实类型先跑
`MetaProbe`，不能凭 `_id` 命名规律替代元数据探查。

### 各类字段没填时读出来是什么

**当前环境实测**（四类单据的新建数据包、`loadSingle` 加载、`QueryServiceHelper.query` 各数一遍；
界面新建、还没保存的单和新建数据包一样）：「没填」长什么样按字段类型分，不能一律判 `null`。

| 字段类型 | 新建、还没保存过 | 从库里加载、查询 |
|---|---|---|
| 文本、多行文本、大文本 | 空串 | 空串（库里存的是一个空格，读出来已去掉；写查询条件见 [data-query.md](data-query.md)） |
| 下拉、多选下拉 | `null` | 空串 |
| 小数、金额、数量、单价 | `BigDecimal` 0 | `BigDecimal` 0，带列上的小数位（`0E-10`、`0.00`） |
| 同上，设计器里勾了「允许为空」 | `null` | `null` |
| 整数、长整数 | 0 | 0 |
| 基础资料、用户、组织等单选引用 | `null`，`字段_id` 是 0 | 加载：`null`，`字段_id` 是 0；查询：0 |
| 多选基础资料 | 空集合 | 空集合 |
| 日期、日期时间 | `null` | `null` |
| 复选框 | `false` | `false` |

由此来的写法：

- 小数类判「必须有值」：`null` 和 `signum() == 0` 都算没填。`MetaProbe` 看不出哪个字段勾了「允许为空」，
  两样一起判就不用分；0 本身是合法业务值的字段，只有勾了「允许为空」才分得出「没填」和「填了 0」。
- 小数类不拿 `getString` 判空：0 读成 `"0E-10"`、`"0.00"`，永远不是空串。
- 下拉同一个字段，没保存过的单是 `null`、存过的单是空串：用 `kd.bos.dataentity.utils.StringUtils.isBlank`
  这类同时认两样的判法，只判 `null` 会漏掉存过的单。
- 查询分录字段时，没有分录行的单也会出一行，那一行文本是 `null`、数值是 0：这是「没有这一行」，
  不是「这一行没填」，判没填要按 `loadSingle` 加载的分录行看。

## 使用边界

- SDK 专题、API 文档和场景示例只能提供候选，不是兼容性证明。
- `framework_version` 缺失或高于当前小版本时降低可信度；落码仍必须过 `api` / `lint`。
- DataSet 关闭、线程上下文、事务阶段等通用语义从官方专题读取；本页只记录本 skill 实际发现的差异。
- 第三方或单项目 `*Utils` 不属于苍穹通用 SDK。是否可用先查当前工程源码，不在本页建立全局约定。
- 语义陷阱见 [anti-patterns.md](anti-patterns.md)，工具细节见 [probes.md](probes.md) 和
  [lint.md](lint.md)。
