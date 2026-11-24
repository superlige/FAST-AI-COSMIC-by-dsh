---
class: A
when: BOTP、打印模板、工作流、公式函数目录的命令
---

# 非实体元数据的命令入口（meta）

来源：真实苍穹 8.0 二开工程实测。

`meta` 把 BOTP 转换规则、打印模板、工作流模型这三个**不是 `EntityMetadata`** 的家族收进
一个命令。三家的动作是同一套：`list` 找、`dump` 导、`backup` 存档、`diff` 比，
再各加各的写或量测。另有一个只读的 `formula`，查三类公式能用的函数。

```
meta botp list|dump|backup|restore|diff
meta ptpl list|dump|backup|apply|measure|diff
meta wf   list|dump|backup|diff          ← 只读，没有 apply/restore
meta formula print|form|biz              ← 只读：打印公式 / 界面规则 / 业务规则的函数与动作目录
```

完整参数表打 `node …/driver.mjs meta`（不带参数就是帮助）。实体和布局不走这里，
走 [metadata-read.md](metadata-read.md)。

- [三条标准流程](#三条标准流程)
- [事实](#事实)
- [坑](#坑)

## 三条标准流程

### 打印模板：改一个属性

```bash
meta ptpl list --form demo_yfrygstj_yd            # 这张单据有哪些模板
meta ptpl dump demo_yfrygstj_yd_prtpl --overview            # 先一屏看全：绑了哪些字段、每格的 key 和内容
meta ptpl dump demo_yfrygstj_yd_prtpl --out before   # 设计 JSON + 多语言映射，返回里给出存在哪
# 控件的 id / key 从 --overview 里抄；要改的属性不在概览里再 grep 返回路径下的 *.meta.json
meta ptpl apply demo_yfrygstj_yd_prtpl --set DataColumn20.columnWidth=40.5   # dry-run
APPLY=1 meta ptpl apply demo_yfrygstj_yd_prtpl --set DataColumn20.columnWidth=40.5   # 落库前自动存改前备份
meta ptpl dump demo_yfrygstj_yd_prtpl --out after
meta ptpl diff before after                       # 复核：只该有那一处
```

目录参数只给名字，位置由工具定，返回里有完整路径：dump、候选、测量的图进本会话目录，跟会话一起清；
备份（`backup` 动作、写通道落库前自动存的改前原文）进 `.cosmic-ai/evidence/backups/<时间>-<名字>/`，一直留。
`diff`、`--open` 给名字或返回里的路径都认。

`--set` 可以给多个。控件写 id 或 key 都行，重名时探针会把候选列出来让你用 id 重来。
排版效果自查用 `meta ptpl measure`（出 PDF 量坐标，见 [print-template.md](print-template.md)）。

### 打印模板：加控件、插一行、改公式

`--set` 表达不了这些。改法是**在本地候选上改，再整份交回**：读一次模板、提交一次，中间全在本地。

```bash
meta ptpl dump <编码> --out tpl_dump                     # 进一次 Java 进程
meta ptpl edit tpl_cand --open tpl_dump                  # 开候选，顺带报结构概览和候选的完整路径
# 下面每条都在本地改候选，各回一句话说改了什么
meta ptpl edit <候选> --formula LayoutCell31 --line "<demo_ypph>" --line "<demo_lch>" --blank /
meta ptpl edit <候选> --grid LayoutGrid3 --insert-row 2
meta ptpl edit <候选> --bind LayoutCell43=demo_bgbh
meta ptpl edit <候选> --clone LayoutCell5 --row 2 --col 3
meta ptpl edit <候选> --plugin demo.print.DemoPrintPlugin --desc 隐藏未选列  # 登记打印插件，已有的原样保留
meta ptpl edit <候选> --status                                            # 总账：这次改了哪几处
meta ptpl apply <编码> --file <候选路径>/<编码>.meta.json --locale <候选路径>/<编码>.locale.json
                                                         # dry-run；apply=true 才落库。候选路径照 edit 返回的抄
```

公式里字段写成 `<字段标识>`，**多给一行 `--line` 就是上下换行**，`--blank` 是所有字段都空时第一行显示的兜底文字。
控件 id、父子引用、行列格矩阵、合并区坐标、换行记号的位置、多语言旁路里的键，全由 `edit` 生成 ——
候选 JSON 手改得动，但这些规则得自己守，出错要打出来才看得见。

`--overview` 在本地看结构（登记了哪些打印插件、哪张表格几行几列、每格显示什么），`--reset` 把候选退回开工那一刻。
打印插件用 `--plugin <类全名>` 登记、`--remove-plugin <类全名>` 撤掉；整份交回时新登记的类在苍穹进程里找一遍，
找不到或不是打印插件就不落库。
设字段时先拿代码关系表核存在性和作用域；表里没有的（继承来的 billno、creator，代码没点过名的）问一次平台元数据，两处都没有才当场报。
字段类型（日期、数值、文本）照模板里已经绑着的那一格，模板里没用过的照平台元数据填，和打印设计器拖字段时一样。

**改过的公式在提交那一次里自动试算**，不用另起探针：平台的公式校验按字段类型判对错（`YEAR` 这类时间函数只收日期字段），再按字段类型换样例值试三档，dry-run 就能看见

```text
[PROBE]     字段都空 时显示：「/ ⏎ 」
[PROBE]     只有第一个字段有值 时显示：「批号 ⏎ 」
[PROBE]     字段都有值 时显示：「批号 ⏎ 炉、熔次号」
```

公式写坏了（函数名打错、参数个数不对）停在落库之前，报的是平台自己的话和相近的函数名。
打印算一行出了错不报错，那一行直接打成空的；试算里哪一档这样，那一档的显示写成「（算不出来：平台原话 打印时这一行是空的）」，
结论说「有一档算不出来」、不拦。有的是公式的毛病，有的是样例值不像真数据（`SUBSTRING(<编号>,10,2)` 碰上短的样例名就越界），
用 `--pk` 在真单上看那一格。
**别的关拦不住这个**：实测函数名写错一个字母，平台解析、拓扑审计、`beforeSave` 一路放行。
函数的参数格式用 `meta formula print --name <函数名>` 查。
要看某张真单上这一格显示什么，dry-run 加 `--pk <单据ID>`：候选模板在那张单上出一次预览，模板和单据都不改；
不加时 dry-run 最后一行会给出库里最近一张单的 id。
落库之后还会回读一遍、和交上去的逐处比。要退回改前那份用 `meta ptpl restore`（下一条）。

### 打印模板：退回改前那一份

```bash
meta ptpl restore <编码> <改前的备份目录>   # dry-run
APPLY=1 meta ptpl restore <编码> <改前的备份目录>
```

备份目录就是 `ptpl apply` 落库时返回里报的那个（`ptpl dump` 的产物也行），
里面按模板编码找 `<编码>.meta.json` 和 `<编码>.locale.json`。

**恢复也是一次写，一道关都不少**：核是不是同一张模板、由程序比差异、试算公式、过平台解析和拓扑审计、
核改前快照（中间有人在设计器里保存过就不写）、落库前照样先存一份改前备份（恢复本身也会盖掉现在那份）。
和库里那份一模一样时不落库。

### BOTP 规则：批量改之前先存档

```bash
meta botp list demo_accident_deal                          # 这张单据下推到哪些单
meta botp dump 2213888868707518464 --fields                # 规则内容：插件/条件/字段映射
meta botp backup botp-before --source demo_accident_deal   # 每条一个 <id>.xml，只读
# …改（BotpRuleSyncProbe，见 metadata-botp-write.md）
meta botp backup botp-after --source demo_accident_deal
meta botp diff botp-before botp-after                      # 按名字认最新那份备份
APPLY=1 meta botp restore <botp-before 返回的备份路径>     # 要回滚时
```

### 工作流：导出与比对（全程零写入）

```bash
meta wf list --bill demo_apply_detail
meta wf dump Proc_demo_apply_detail_audit_1 --out wf-before
meta wf backup wf-all --bill demo_ --max 200        # 批量存档
meta wf diff wf-before wf-after
```

## 事实

**`diff` 完全离线。** 它只读两个目录里的文件，不连苍穹、不需要常驻 JVM，所以拿去比
不同环境、不同日期导出来的东西都行。

**`meta ptpl diff` 是结构化的，`botp` / `wf` 的是行级的。** 打印模板导出的是 JSON，
按控件 id 对齐后逐属性比，输出形如
`DataColumn20(DataColumn) .pages[0][id=gwhE9nl2kf].columnWidth  35.1 → 40.5`；
BOTP 和工作流导出的是 XML，走掐头去尾 + LCS 的行级 diff。两边都只报同名文件的内容差异，
各自独有的文件单独列一行。

`botp restore` 预演先校验目录内全部规则的归属并报告写入目标；目标清单为空时不能进入授权。执行前会先检查全部目标是否在授权范围内。

**只有 `botp restore`、`ptpl apply` 和 `ptpl restore` 写库**，它们默认 dry-run、`APPLY=1` 才落库，
默认在常驻进程里写，写后用同一进程回读；显式 cold 才强制冷进程。`backup` / `dump` / `list` / `measure` 一行库都不写 ——
**`meta botp backup` 不需要 `APPLY=1`**（它和同步探针里那个「save 之前存原文」的备份
不是一条路，见 `SYNC_BACKUP_ONLY`）。

**`ptpl apply --set` 只改已经存在的属性，且新值的类型跟旧值走。** 两条都是硬拒绝，不是提示。
加控件、加表格、改公式走另一条：`ptpl edit` 在本地候选上改，`ptpl apply --file` 整份交回（上面第二条流程）。

**多语言旁路映射（`<控件id>.<属性>`）跟着改，但只在它当前语言下确实有值时。**
空串表示「没有本地化覆盖、用主 metadata 的值」，往空串里写值等于凭空造一个覆盖。
实测 `columnWidth` / `height` / `fontName` 这类纯数值属性也在旁路里各占一个键。

**`ptpl apply` 落库前后各核一次 `modifyVersion` + `data` 哈希。** 读到基线之后有人在
设计器里保存过就中止 —— 共享环境上这不是假想情况。

**`meta wf dump` 的文件名用模型 `key`，不用 id。** id 是雪花号，两个环境导出来的对不上，
`diff` 会把每个文件都判成「只在 A」。

## 坑

### 工作流导出来的是「已发布」的那一版

**现象**：在设计器里改完流程，`meta wf dump` 导出来还是老的，看不到改动。

**为什么**：导出走 `RepositoryService.getExportedProcessFileContent(模型id)`，
拿的是流程定义（`wf_processdefinition`），不是模型草稿。模型改了没发布，流程定义就还是上一版。

**判据**：`meta wf list` 的 `未发布` / `已发布` 列。未发布的模型导出内容为空，
`backup` 会跳过并数出来。

### 「改了没反应」= 属性名或类型写错

**现象**：`ptpl apply` 说成功、`beforeSave` 通过、`modifyVersion` 也推进了，
进设计器一看没变。

**为什么**：设计 JSON 是自由结构，属性名拼错会新建一个键、把 `18.3` 写成字符串
`"18.3"` 也照样保存 —— 平台两种情况都不报错，那个值只是永远不被读到。

**判据**：本探针把这两条都做成了硬拒绝（属性不存在直接抛、类型按旧值强转）。
真遇到「改了没反应」，先 `meta ptpl diff before after` 看那一处到底进没进去。

### 工作流没有写通道，是判据不够，不是没写完

`wf_model` 上**没有任何归属字段**，判据只剩挂靠单据 `entrabill` 的前缀 ——
它证明的是「这个模型管的是本 ISV 的单据」，证明不了「是本 ISV 建的」。
加上工作流写入会影响在途实例、事务回滚不了，所以一期只读。判据的实测数字和
`IsvGuard.assertOwnWfModel` 见 [metadata-write.md](metadata-write.md)。
