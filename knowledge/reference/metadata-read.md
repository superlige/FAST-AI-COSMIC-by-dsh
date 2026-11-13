---
class: B
when: 元数据对象类型不明：实体、布局、规则、BOTP、打印模板怎么分
---

# 元数据读取总入口

本文用于在读取实体、表单布局、BOTP 转换规则或打印模板前，先确定对象类型、真实标识、
读取通道和副作用。不要先拿一个 API 试到成功为止。

## 快速路由

| 对象 | 关键标识 | 正确读取通道 | 继续阅读 |
|---|---|---|---|
| 实体 / 字段 | 实体 number、Entity design id | 运行态 `EntityMetadataCache`；设计态 `MetadataDao(..., Entity)` | [metadata-entity.md](metadata-entity.md) |
| 业务规则 | 实体/分录宿主 key、rule id/tag | 遍历 `EntityMetadata.getEntitys()` 中各实体的规则 | [metadata-business-rules.md](metadata-business-rules.md) |
| 表单布局 | 布局 number、布局 FID、`FENTITYID` | `MetadataDao.readMeta(layoutId, Form)`；继承树查 `t_meta_formdesign` | [metadata-form.md](metadata-form.md) |
| 界面规则 | 规则宿主 Ap、rule id/tag | 遍历 `FormMetadata.getItems()` 中各宿主的规则 | [metadata-form-rules.md](metadata-form-rules.md) |
| BOTP 转换规则 | rule id、源单、目标单 | `ConvertRuleReader` | [metadata-botp.md](metadata-botp.md) |
| 打印模板 | 模板 number、目录 id、本体 id | 目录实体 + `PrintTplService` | [print-template.md](print-template.md) |

`MetadataDao` 管 Entity 和 Form，不管 BOTP 与打印模板；打印模板设计内容也不在
`bos_manageprinttpl` 普通字段里。

## 副作用等级

| 等级 | 含义 | 典型操作 |
|---|---|---|
| **R0** | 不写共享环境，也不生成本地文件 | 查字段、布局、规则、模板结构 |
| **R1** | 不写共享环境，但会生成本地文件 | 模板 ZIP 备份、PDF/PNG、图片占位文件 |
| **W** | 修改共享元数据或业务数据 | 保存实体、布局规则、BOTP、打印模板 |

R1 产物要明确目录、校验完整性并在不再需要时清理占位文件。W 级操作必须转到
[metadata-write.md](metadata-write.md)，不得从读取流程顺手继续写；**新建**表单/实体由用户在开发平台做，
建好之后的回验和登记见 [metadata-create.md](metadata-create.md)。

## 标识词典

| 名称 | 含义 | 不要混用 |
|---|---|---|
| 实体 number | 如 `demo_sys_test_bill`，描述数据模型 | 不是派生布局 number |
| Entity design id | 实体设计元数据 id | 不保证等于任意布局 FID |
| 页面 / 运行页 | 用户当前打开的运行时页面实例，通常由某个表单布局创建 | pageId 不是布局 FID，也不是独立 `MetaCategory` |
| 布局 number | 菜单或开发平台上看到的具体表单布局标识 | 不能直接传给实体缓存 |
| 布局 FID | `t_meta_formdesign.FID`，每份布局自己的 id | 继承布局通常有独立 FID |
| `FENTITYID` | 布局绑定的实体 id | 不是布局自身 FID |
| 控件 key | 人可读的布局控件标识 | 不是稳定对象 id，也不是实体 fieldId |
| 控件 id / Ap id | 布局对象 id | 界面规则动作通常引用它 |
| fieldId | 表单控件到实体字段的绑定 id | 不应凭 key 猜测 |
| BOTP rule id | 转换规则唯一定位键 | 规则名称可能重复 |
| 打印模板 number | 目录里的业务编码 | 目录记录 id 与本体 `printtplid` 不是一回事 |

## 布局标识与实体标识

开发平台或菜单上的标识可能是布局。对于**实体问题**，使用 `MetaResolve` 把布局解析到实体；
对于**布局问题**，必须保留原布局 number/FID，再读取对应 Form，不能自动折叠到根实体。

```java
MainEntityType t = MetaResolve.type(key);
String designId = MetaResolve.designId(key);
String entityNumber = MetaResolve.entityNumber(key);
```

这些帮助方法只适合实体导向的探针。BOTP 和打印模板必须走各自通道。

根表单样本中 Entity 与 Form 可能共享设计 id；派生/继承布局拥有自己的 FID，并通过
`FENTITYID` 指向实体。每个目标都应重新查询，不把样本 id 当成通用常量。

## 命令行约定

文档中的 `NAME=value node ...` 是 **Git Bash** 写法。在 PowerShell 中先设置环境变量：

```powershell
$env:META_ENTITY = 'demo_sys_test_bill'
node .claude/skills/long-cosmic-dev/driver.mjs probe MetaProbe
Remove-Item Env:META_ENTITY
```

多个参数依次设置；涉及密钥或账号时不要把值写进脚本和日志。

## 最小读取顺序

1. 运行 `EnvDiagProbe` 确认环境、账套和用户上下文。
2. 判断对象属于实体、业务规则、布局、界面规则、BOTP 还是打印模板。
3. 记录输入标识和解析出的 number/id，不覆盖原始布局标识。
4. 使用上表对应的只读探针，先拿清单，再查单个对象详情。
5. 把结论落成字段、id、数量、哈希或坐标等可复核证据，并注明样本账套和日期。
6. 如果需求变成修改，停止读取流程，转到 [metadata-write.md](metadata-write.md)。
