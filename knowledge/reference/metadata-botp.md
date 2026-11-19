---
class: B
when: BOTP 转换规则读取与无保存模拟
---

# BOTP 转换规则（读取与无保存模拟）

来源：真实苍穹 8.0 二开工程实测。本文只覆盖规则清单、详情、插件和字段映射读取，以及
按规则无保存下推的验证入口；修改规则见
[metadata-botp-write.md](metadata-botp-write.md)。

**日常查规则、导 XML、比两版走 `meta botp`**（[meta-cmd.md](meta-cmd.md)）；本文讲的是它底下的通道和探针参数。

- [独立读取通道](#独立读取通道)
- [BotpRuleProbe](#botpruleprobe)
- [常见误判](#几件实测出来不查就会踩的事)
- [无保存端到端验证](#端到端验一条规则不落库)


## 独立读取通道

**转换规则不在 `MetaCategory` 里**（那只有 `Entity` / `Form`），所以 `MetadataDao.getIdByNumber`
/ `readMeta` 一律查不到，`EntityMetadataCache` 也没有。它自成一张设计态表
`T_BOTP_ConvertRule`（`DBRoute.meta`，名称在 `T_BOTP_ConvertRule_L` 的 `FName`），
规则内容（插件、字段映射、条件）以 XML 存在 `FDATA` 里。

**这也是为什么「查规则挂了哪个[转换插件](plugin-operation.md#botp-转换插件)」跟查表单插件完全不是一套路子**
（表单插件走 [metadata-form.md](metadata-form.md) 的 `FormPluginProbe`）。

| 干什么 | 用什么 |
|---|---|
| 读 | `new ConvertRuleReader().loadMeta(id, false)` → `ConvertRuleMetadata` |
| 写 | `ConvertRuleWriter.save(meta)` → `Map`，成功是 `{success=true, message=保存成功。}` |
| 清缓存 | `ConvertRuleWriter.clearCache(String[] ids)` |
| 看原文 | `new ConvertRuleReader().buildXml(id, false, false)` |

三条实测出来的关键事实：

- **`loadMeta` 拿到的是完整设计态**（name、50 条 localeItems、createDate、1327 条字段映射
  一个不少），可以直接改了再 `save`，不用自己拼。
- **`save()` 无损往返** —— 一条规则 `loadMeta` 后什么都不改直接 `save`，`buildXml` 前后
  **逐字符一致**（346233 字符）。所以「读出来改一改存回去」这条路是安全的。
  ⚠️ 一个例外：`ByCondition`（按条件取值）类型的字段映射，它的取值配置存在
  `<ValByCondiionsString>` 里是一坨嵌套 JSON，**每次 `save` 都会重新序列化，键顺序会变**，
  连带 `<ConvertType2>` 末尾那串 hashCode 也变。内容语义完全相同，别当成改坏了。
- **`T_BOTP_ConvertRule.FDATA` 与 `buildXml()` 的输出完全相同**（实测 `equals` 为 true）。
  该等价关系可用于备份校验；常规修改和回滚仍走受控写入流程。直接更新 `FDATA` 只允许作为灾备恢复手段，见 [metadata-botp-write.md](metadata-botp-write.md#灾备恢复边界)。

---

## BotpRuleProbe

`ConvertRuleReader` 把 `FDATA` 里的 XML 解出 `ConvertRuleElement`，探针再逐层打印。

```bash
# 1. 先列清单：这张单能下推到哪些单、规则叫什么、id 是多少
BOTP_SOURCE=conm_purcontract BOTP_TARGET=<isv>% \
  node .claude/skills/long-cosmic-dev/driver.mjs probe BotpRuleProbe

# 2. 看某条规则的插件 / 分录映射 / 条件
BOTP_RULE=2424163312120910848 BOTP_DETAIL=1 \
  node .claude/skills/long-cosmic-dev/driver.mjs probe BotpRuleProbe

# 3. 反查：哪些规则挂了我们自己的转换插件（按类名关键字）
BOTP_SOURCE= BOTP_TARGET=<isv>% BOTP_PLUGIN=<isv> BOTP_MAX=400 \
  node .claude/skills/long-cosmic-dev/driver.mjs probe BotpRuleProbe
```

```
[PROBE] ======== 转换规则(瑞闽)   id=2394964217032619008
[PROBE]   demo_yhpcjl -> demo_ybyhzgtzd  enabled=1  默认规则=false  下推可见=true  选单可见=true  自动保存=false  整单下推=false  isv=demo
[PROBE]   -- 转换插件 1 个
[PROBE]      demo.zay01.bpm.ywsp.plugin.convert.YhpcjlToYbyhzgConvertPlugin  enabled=false  隐患排查记录 下推 一般隐患整改通知单 转换插件
[PROBE]   -- 分录映射  源分录=demo_entryentity_rm 源子分录=- -> 目标分录=demo_ybyhzgtzd 目标子分录=-  linkType=Link  选单布局=-
[PROBE]   -- 执行条件 enabled=true  status -(105) C AND demo_zrbm.number -(111) 0501/050101/…
[PROBE]   -- 字段映射 34 条（BOTP_DETAIL=2 看明细）
```

参数：`BOTP_SOURCE`（源单，支持 `%`，默认 `<isv>%`，**给空串=不限**）、`BOTP_TARGET`、
`BOTP_RULE`（纯数字按 id 精确、其余按名称 like）、`BOTP_PLUGIN`（插件类名关键字）、
`BOTP_DETAIL=0|1|2`、`BOTP_MAX`（默认 30）。

## 几件实测出来、不查就会踩的事

- **`ConvertRuleElement.isEnabled()` 恒为 false，别拿它判断规则启没启用。** 启用状态在表上
  （`T_BOTP_ConvertRule.FEnabled`），不在 XML 里。探针打的 `enabled=` 取的是表里的值。
- **规则上的插件 `enabled` 是独立开关**：规则本身启用、插件挂着但 `enabled=false`，
  代码就是不执行 —— 「插件没生效」最常见的原因，光看类名挂没挂看不出来。
- **「分录映射」那一行是规则的建行层级**（`LinkEntityPolicy`）：下推时按源单「源分录」那个实体的每一行，
  在目标单「目标分录」那个实体上建一行；两边写的是单据标识就是表头对表头，一张源单出一张目标单。
  改它走 `SYNC_LINK`，见 [metadata-botp-write.md](metadata-botp-write.md#建行层级)。
- **同一对源单/目标单可以有多条规则**（`conm_purcontract -> demo_is_lf_juge` 之类），
  名字还都叫「转换规则」。定位只能靠 id，别靠名字。
  实测极端情况：`demo_qty_wtd -> demo_sys_test_bill` 一对就有 **32 条**规则（按试验类型分），
  连名字都能重（两条都叫「（油品、辅材）」）。
- **业务规则那一栏 `BOTP_DETAIL=1` 只打条数和名字，而且名字恒为 `-`** ——
  `CRBizRuleElement` 上没有 `getName()`，名字在 `getDescription()`。要看条件和赋值公式，
  得自己取 `getParameters()` 和 `getPreCondition().getExpression()`，
  或直接读 XML（`ConvertRuleReader.buildXml` 里的 `<BizRulePolicy>` 段）。怎么读见下半页。
- **原厂单据下推到二开单据的规则，isv 是本 ISV**（规则是二开方建的），但源单/目标单里
  只要有一方是原厂的，改规则前照样按红线走。
- 规则的条件 `getFilterString()` 是几千字符的 JSON，`BOTP_DETAIL=1` 已压成
  `字段 比较符(code) 值`；要原始 JSON 用 `BOTP_DETAIL=2`。
- `BOTP_PLUGIN` 反查必须逐条把规则 XML 解出来才知道插件，几百条要几十秒，
  能收窄 `BOTP_SOURCE` / `BOTP_TARGET` 就先收窄。

## 端到端验一条规则（不落库）

想知道「这条规则下推出来的目标单，某字段到底是什么值」，或者改完转换插件要验它，不用真下推，也不用自己写探针：

```
run push <规则id> --pk <源单内码> --expect <目标单字段>=<值>
```

目标单必须保存后从数据库重新读取，带 `--expect` 核对回读值；转换插件缺少保存回读记录不能交付。分录下推怎么选行、
保留字、失败提示怎么读见 [run.md](run.md#run-pushbotp-转换插件)。
