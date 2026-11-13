---
class: A
when: 父子页 close 回调和整条链
note: 同时读 run
probes: ExpectSpec.java@3a22e27875d0
---

# run callback / run flow —— 父子页那一族

来源：真实苍穹 8.0 工程实测。命令表、选哪条、运行真提交的规矩在 [run.md](run.md)，本篇只讲这两条。

这两条和 `run op` / `run form` / `run list` 的区别只有一个：**子页面参与进来了。**
父子两个 View 和它们的模型落**真实 Redis**，`close()` 经平台自己的
`FormService.closeCallBack` 回到父插件 —— 所以它们是需要真实缓存的两条（每次一个唯一页面号，跑完主动清掉）。
和别的运行一样走常驻进程、真提交。

子页打开参数经过平台 `FormShowParameter` 的序列化和还原后交给子页；复杂参数的运行时类型以还原结果为准，不直接沿用父插件中的 Java 对象。

- `run callback` 由**你**指定子表单和父插件回调，验的是「回调这一段通不通」。
- `run flow` 由**父插件自己** `showForm` 产生子页，验的是「整条链对不对」。
  子页开错了、按钮没绑上、选中行没传进去，都会在这里红 —— 所以**优先用 flow**，
  `callback` 是 flow 捕获不到子页时的下一步拆解手段。

## run callback：真实缓存父子页关闭回调

```bash
run callback demo_sys_test_hxfx demo_hxjspjz \
  --callback demo.zljy.formplugin.ChemistryFormPlugin \
  --parent-entry demo_entryentity \
  --child-set demo_checkone=false --child-set demo_jyjgone=10.00 \
  --child-set demo_checktwo=false --child-set demo_jyjgtwo=20.00 \
  --expect demo_entryentity.demo_bgjg=10.00 \
  --expect demo_entryentity.demo_bgjgpjz=15.00 \
  --skip QTYWTDFormPlugin
```

**`--show` 打值给人看，`--expect` 判对错给机器看** —— 交付只认后者，不带 `--expect`
跑出来的判 `EXECUTED` 不判 `PASS`，**不算验过**。各适配器写法一致，各自能断什么、两个会让断言
假绿的坑，见 [verify.md](verify.md)。

这条命令不会手工调用父插件 callback。它依次创建并持久化父页、用父 View 的真 `showForm`
建立父子关系、创建并持久化子页、运行子操作；子插件执行 `returnDataToParent + close()` 后，
平台进入 `FormService.closeCallBack`，按父 pageId 从 Redis 重建 View，再派发 `closedCallBack`。
基础资料字段的断言同时核对对象内码与外键；两者不一致就失败，避免只看对象值误判。

- `--callback` 写父插件全限定类名；`:actionId` 可省，默认取父模型实体类型名。
- `--parent-entry` 给父分录补第 0 行并设为当前行，适合 callback 回写当前分录的场景。
- `--set` 是父页初值，`--child-set` 是子页操作前的值；两者都走 `run` 那套路径与值契约
  （表头 / `分录[行].字段` / `分录[行].子分录[行].字段`，值按字段类型转），见
  [run.md](run.md#--set----expect-的路径与值各适配器同一份实现)。
- `--expect` 断的是**重建后**的父模型，不是父页原来那个 View 对象。
- 父子实体都过 `IsvGuard`，子操作真提交，缓存主动清理。

## run flow：父操作到父模型断言

```bash
run flow demo_sys_test_hxfx \
  --click demo_calculatehx --toolbar demo_advcontoolbarap \
  --parent-entry demo_entryentity --select 0 --child demo_hxjspjz \
  --set demo_entryentity.demo_bgjg_isjs=false \
  --set demo_entryentity.demo_bgjg=10.00 \
  --child-set demo_jyjgone=12.00 --child-set demo_jyjgtwo=18.00 \
  --expect demo_entryentity.demo_bgjg=12.00 \
  --expect demo_entryentity.demo_bgjgpjz=15.00 \
  --skip QTYWTDFormPlugin
```

固定链路：

```text
父 click / op / 分录超链接
  → 父业务插件真实 showForm
  → 捕获它产生的 FormShowParameter（子页、customParams、pageId、CloseCallBack）
  → 用原参数创建并持久化子 View
  → 子 invokeOperation
  → returnDataToParent + close
  → FormService.closeCallBack
  → Redis 重建父 View
  → 父 closedCallBack → --expect 断言
```

- **平均值这类断言要把源字段给全**：只给 `demo_jyjgone` 时 `demo_bgjgpjz` 就等于那一个值，
  少给一个不报错，只会红在跟改动无关的地方。
- `--click`、`--op`、`--hyperlink` 三选一：`--click` 适合 `itemClick` 里打开弹窗的插件，
  `--hyperlink 分录[行].字段` 适合点分录超链接（`hyperLinkClick`）弹出子页的插件，写法同 `run form --hyperlink`。
- `--pk` 可让父页从真实单据开始；不写则走新增模型。数据库操作真提交，跑完这张单就是新状态。
- `--toolbar` 在页面有多个工具栏时明确父按钮所在控件；不写时会枚举布局里的 Toolbar。
- `--select 0,1` 模拟浏览器回传的选中行；给了 `--parent-entry` 时自动只作用于该 grid，
  也可显式写 `--select demo_entryentity=0`，避免其它表格被误选。
- `--child` 只做预期子表单断言，不参与构造。实际子页必须由父插件 `showForm` 捕获出来。
- 捕获不到子页时直接失败并提示检查按钮、选中行和 `registerListener`；绝不降级成手工 callback。

## 子页的「确定」有两种写法，通道也是两条

对话框的确认动作，有的是**操作**，有的是**按钮控件**，
而平台抛的异常里看不出是哪一种。

- 是操作：`--child-op <操作key>`，走 `invokeOperation`。
- 是按钮控件（`bos_dialogtpl` 派生的对话框几乎都是这种：插件
  `addClickListeners("btnok")` ＋ `click(EventObject)` 里 `returnDataToParent` ＋ `close`）：
  `--child-click <控件key>`，走控件的 `click()`，和前端点一下同一条派发链。
- **两个都不给**（推荐）：探针自己查一次这张子页的元数据，`btnok` 是控件就自动改走控件点击，
  并把改走这件事打出来。省掉一次 45 秒的冷启动。
- 两个只能给一个。显式点名 `--child-op X` 而它其实是控件时，探针**不替你换**——
  你点名要的通道驱动不了，换不换由你定，但它会直说「X 不是操作，是界面控件（ButtonAp）」。

走错通道（按钮控件当操作调）会报：

```text
kd.bos.exception.KDException: btnok 操作未定义实现类！
```

这句话读起来像「元数据漏配了实现类」，实际是「选错了通道」。探针会直接说该换哪条通道；两条通道都不成立时
（既没有这个操作也没有这个控件）会说「本通道驱动不了，这条链路需人工验收」，
**那就是停下来的信号**：把这条链路交用户验收。
