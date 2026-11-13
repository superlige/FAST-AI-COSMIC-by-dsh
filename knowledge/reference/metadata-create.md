---
class: B
when: 需求要新建单据 / 表单 / 基础资料；新表单的功能单元登记、开发平台搜不到
note: 先读写入总则
---

# 新建单据、表单、基础资料：谁建、建好之后怎么接

**对象本身由用户在开发平台建。** 写通道接手的是建好之后的事：回验、功能单元登记、往里加字段、分录和控件。
本篇讲请用户建的时候要说清什么、建好以后怎么确认建对了、开发平台搜不到时怎么补登记。
改已有对象的字段见 [metadata-entity-write.md](metadata-entity-write.md)；登记属 W 级共享写入，先过
[metadata-write.md](metadata-write.md) 的准入清单和原厂红线。

- [请用户建的时候说清什么](#请用户建的时候说清什么)
- [建好以后先回验](#建好以后先回验--formvisibleprobe)
- [本体和功能单元登记是两处](#本体和功能单元登记是两处)
- [补登记](#补登记--formregisterprobe)
- [删除](#删除)
- [坑](#坑)

## 请用户建的时候说清什么

需求里读出要一张新单据、动态表单、基础资料时，把下面几项列给用户；
不依赖新对象的部分（已有单据上的改动、不引用新对象的代码）照常做。

| 说清什么 | 为什么 |
|---|---|
| 类型：单据 / 基础资料 / 动态表单 | 单据、基础资料有物理表，动态表单没有 |
| 建议的标识和名称 | 标识带 `<isv>_` 前缀。有物理表的对象标识要一次想清楚：删元数据不删表，会留一张孤儿表 |
| 照哪张建 | 选同一个功能单元里、继承同一个原厂模板、用途最接近的那张：继承链、所属应用和功能单元都跟它一致，回验和登记也拿它当参照 |
| 只要建出空壳 | 字段、分录、控件、操作、插件由写通道加（[metadata-form.md](metadata-form.md)、[metadata-entity-write.md](metadata-entity-write.md)） |

挑「照哪张建」之前先看清它的现状：继承谁、绑了什么插件、挂在哪个应用。

```bash
META_FORM=<参照表单> node .claude/skills/long-cosmic-dev/driver.mjs probe FormPluginProbe
VIS_FORM=<参照表单> node .claude/skills/long-cosmic-dev/driver.mjs probe FormVisibleProbe
```

对话框类的动态表单一般继承原厂 `bos_dialogtpl`，继承来的 `btnok` / `btncancel` / `contentpanel`
等控件标识原样保留，插件里 `addClickListeners("btnok")` 直接用。

## 建好以后先回验 —— FormVisibleProbe

用户给了标识之后，先回验，再往里加字段：

```bash
D=.claude/skills/long-cosmic-dev/driver.mjs
VIS_FORM=<新表单> VIS_REF=<参照表单> node $D probe FormVisibleProbe
```

八条全部跟参照表单对齐才算建好：

| # | 查法 | 少登记行时 |
|---|---|---|
| ① | `getIdByNumber(Form/Entity)` | ✅ 有值 |
| ② | `getNumberById` | ✅ 有值 |
| ③ | `getAppIdByFormId` / `getUnitIdFromUnitrel` | ❌ **双 null** |
| ④ | `getEntityNumberByFormNumber` | ✅ 有值 |
| ⑤ | `getAppNumberByEntityNumber` | ❌ **null** |
| ⑥ | `getAllFormNumbers` 含不含 | ✅ 含 |
| ⑦ | 功能单元下的表单清单含不含 | ❌ **不含** |
| ⑧ | 参照表单同样八条 | 全绿（就是目标状态） |

## 本体和功能单元登记是两处

一张表单在库里有两处：**元数据本体**（`T_META_FORMDESIGN` / `T_META_ENTITYDESIGN`）和**功能单元登记行**
（`bos_devportal_unitrelform`，表 `T_META_BIZUNITRELFORM`）。运行时只读本体；开发平台的左树和搜索框读登记行。
用 `MetadataWriter.save` 存出来的表单只有本体，登记行要另写。

只有本体、没有登记行时：

| 现象 | 少登记行时 |
|---|---|
| `MetadataDao.getIdByNumber` | ✅ 查得到 |
| `MetadataDao.readMeta` / 运行时 | ✅ 正常 |
| `FormUtil.showForm` 弹出、插件事件 | ✅ 全部照跑 |
| `run form` 免界面驱动 | ✅ 绿 |
| **开发平台搜索 / 左树** | ❌ **找不到这张表单** |

所以「运行时全绿」不等于「建好了」。回验清单里 **③ ⑤ ⑦ 是登记行的专属指纹**：这三条挂、其余全绿，就是缺登记行。

## 补登记 —— FormRegisterProbe

```bash
REG_FORM=<新表单> REG_REF=<参照表单> node $D probe FormRegisterProbe            # dry-run
REG_FORM=<新表单> REG_REF=<参照表单> APPLY=1 node $D probe FormRegisterProbe    # 落库
```

`REG_REF` 照抄参照表单的功能单元和应用；要指到别的单元就换成 `REG_UNIT=<单元id> REG_APP=<应用id>`。
探针是幂等的（已登记就只回验），写完自动重建应用运行时元数据并清应用元数据缓存。
撤掉登记行：`REG_FORM=<新表单> ROLLBACK=1 APPLY=1`。

⚠️ **缓存清了浏览器上也未必立刻见效。** 探针 JVM 不是完整集群节点，缓存失效广播不一定
送到 web 节点。搜不到先刷新页面，再不行让 web 节点重启一次 —— 先看回验，再怀疑登记行。

## 删除

对象本身的删除同样由用户在开发平台做。动态表单没有物理表，删掉就干净；
单据、基础资料删掉元数据后物理表会留下来。

## 坑

1. **新表单的插件类要能被加载。** 元数据里绑的是全限定类名，类还在 `classes` 目录里
   （只跑过 `fast`）时开发平台能搜到、界面也能开，但**真环境点开会报类找不到** ——
   得等代码提交后按用户自己的流程部署到那个环境；要在本地节点上看，才需要 `deploy`
   （用户明确要求时才跑），见 [runtime.md](runtime.md)。

2. **给子页传复杂参数时类型不稳。** `getFormShowParameter().getCustomParam(k)` 在同进程
   直接开页面拿到的是调用方塞进去的 `ArrayList`，经 `showForm` 序列化到子页后变成
   `JSONArray`。直接强转其中一种，另一条路径必 `ClassCastException` —— 归一化一次再用。
   插件侧的完整写法见 [plugin-ui.md](plugin-ui.md)。
