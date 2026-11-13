---
class: B
when: BOTP 批量同步、备份与恢复
note: 先读写入总则
---

# BOTP 转换规则（写入、备份与恢复）

来源：真实苍穹 8.0 二开工程实测，批量复制业务规则和统一字段映射曾在共享环境落库验证。

**先读 [metadata-write.md](metadata-write.md)**。BOTP 不使用 `MetadataWriter`，
必须通过 `ConvertRuleWriter` 保存并清缓存。规则读取和无保存模拟见
[metadata-botp.md](metadata-botp.md)。

备份、恢复和两版比对有命令层：`meta botp backup|restore|diff`，见 [meta-cmd.md](meta-cmd.md)。

- [BotpRuleSyncProbe](#botprulesyncprobe)
- [业务规则字段](#造业务规则时要抄全的字段)
- [目标单上下文](#表达式跑在目标单上下文不是源单)
- [灾备恢复边界](#灾备恢复边界)

## BotpRuleSyncProbe


`probes/BotpRuleSyncProbe.java`：把一条规则的**业务规则批量复制到一批规则** + 统一字段映射，
带备份和回滚。

```bash
# 1. 先干跑（不给 APPLY 就只演算，逐条打印「原来是什么 -> 要改成什么」）
SYNC_SRC=2533552636435629056 \
SYNC_SOURCE_ENTITY=demo_qty_wtd SYNC_TARGET_ENTITY=demo_sys_test_bill \
SYNC_NAME_LIKE=西南铝 SYNC_ENABLED=1 \
SYNC_FIELDMAP="demo_hjlb=demo_combofield7;demo_zdkd_ls=demo_mulbasedatafield" \
  node .claude/skills/long-cosmic-dev/driver.mjs probe BotpRuleSyncProbe

# 2. 真写（APPLY=1 时 SYNC_BACKUP 是强制的，没给会在进 JVM 前被拒；它不算改参数，照样对得上确认清单）
APPLY=1 SYNC_BACKUP=<scratchpad>/botp-backup  ...同上...

# 3. 回滚
APPLY=1 SYNC_RESTORE=<scratchpad>/botp-backup \
  node .claude/skills/long-cosmic-dev/driver.mjs probe BotpRuleSyncProbe
```

| 变量 | 含义 |
|---|---|
| `SYNC_SRC` | 业务规则的来源规则 id；不给就只改字段映射。**它自己永远从目标集里排除** |
| `SYNC_TARGETS` | 显式给目标规则 id（逗号分隔）；给了就不走下面的筛选条件 |
| `SYNC_SOURCE_ENTITY` / `SYNC_TARGET_ENTITY` / `SYNC_NAME_LIKE` / `SYNC_ENABLED` | 按源单 / 目标单 / 名称 like / 启用状态筛 |
| `SYNC_FIELDMAP` | `目标字段=公式;目标字段=公式`，把映射统一成 `ConvertType=Formula`。映射不存在会新建 |
| `SYNC_ON_EXIST` | 目标规则已有业务规则时 `skip`（默认）还是 `replace` |
| `SYNC_BACKUP` / `SYNC_RESTORE` | 备份目录 / 回滚目录（一条规则的 XML 约 360KB） |

## 造业务规则时要抄全的字段

业务规则挂在 `ConvertRuleElement.getBizRulePolicy().getActions()` 上，元素类型是
`CRBizRuleElement`。**公式赋值型**（设计器里最常用的那种）长这样：

```
ActionId       = FormulaAction
RunActionClass = kd.bos.service.botp.convert.bizrule.FormulaAction
Parameters     = {"Expression":"demo_khjb = '2'"}      ← 赋值动作
PreCondition   = CRCondition{ Expression / ExprTran }  ← 前置条件
Seq            = 1                                      ← 按序执行，后面的覆盖前面的
```

三个不查就会栽的点：

- **前置条件有两种存法，只抄一边会静默丢条件。** `CRCondition extends CRFormula`：
  公式型条件在 `getExpression()`，条件行型在 `getFilterString()` / `getFilterCondition()`。
  实测这批规则的 `FilterString` 全是 `{"filterRow":[],"forList":false}`（空），条件全在
  `Expression` 里 —— 只看 `getFilterCondition()` 会得出「没有前置条件」的错误结论。
- **`CRBizRuleElement.getName()` 返回 null，名字在 `getDescription()`。**
- **复制到别的规则时 `Id` 要重发**（`Uuid8.generateShortUuid()`），别原样搬。

## 表达式跑在**目标单**上下文，不是源单

实测证据：`LEFT(demo_hjlb, 1) ='A'` 里的 `demo_hjlb`、赋值目标 `demo_khjb`、
`MulBasedataInclude(demo_zdkd_ls.number, …)` 里的 `demo_zdkd_ls`，**三个标识都只存在于目标单**
`demo_sys_test_bill`，源单 `demo_qty_wtd` 上一个都没有；而规则照样工作。

**推论（这是最容易踩的）：业务规则依赖同一条规则的字段映射先把它读的那些目标字段填上。**
把业务规则复制到别的规则时，光复制规则不够 —— 目标规则里如果没有对应的字段映射，
条件读到的是空值，规则会静默走错分支（实测：`demo_hjlb` 没映射 → `LEFT('',1)<>'A'` 成立
→ 全部落成「民品级」，不报任何错）。

顺带一条：`MulBasedata`（多选基础资料）字段在 `MetaProbe` 里显示成**【分录】**（它确实是
独立子表），`META_FILTER` 按字段名过滤会「命中字段 0 个」，别据此判定字段不存在。



## 灾备恢复边界

常规回滚优先使用 `BotpRuleSyncProbe` 的 `SYNC_RESTORE`，并在冷进程中重新读取规则复核。
只有官方对象写入和备份恢复链都不可用、且已取得明确灾备授权时，才考虑把已校验的原始 XML
直接恢复到 `T_BOTP_ConvertRule.FDATA` 后执行 `clearCache`。这不是日常修改路径，执行前必须
核对规则 id、源单、目标单、ISV、备份哈希和目标环境，并由数据库恢复负责人确认。
