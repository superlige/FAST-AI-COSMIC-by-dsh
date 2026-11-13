---
class: A
when: 查单个类、方法、字段或常量是否真实存在
---

# 查 API 是不是真的存在：`api` / `findclass` / `lint`

来源：真实苍穹 8.0 二开工程实测（4534 个依赖 jar，JDK 1.8）。三个都**不是探针**：不起苍穹、不连库、
不落 class（`api` / `findclass` 1~2 秒，`lint` 5 秒），可以随便跑。

**一个问题的三种粒度**：查一个或几个类的方法签名用 `cosmic_knowledge action=api`，不知道全限定名用
`action=findclass`，写完一整份代码用 `cosmic_lint`。行为对不对它们都不回答，那要靠探针，见
[标准打法](../SKILL.md#一次需求的标准打法)里「端到端验算法」那步。

## `api` / `findclass`：查单个 API

想知道某个类/方法存不存在、签名是什么，**别写进探针跑一遍**。
探测 API 的时候你恰恰还不知道怎么写才编得过，写探针等于用「能不能跑通」去猜答案。
这两个动作对本工程真实 classpath 做反射，不连数据库、不占常驻 JVM。

```
cosmic_knowledge action=api query="kd.bos.orm.query.QFilter kd.bos.servicehelper.BusinessDataServiceHelper"
cosmic_knowledge action=api query="kd.bos.orm.query.QCP#is_notnull"                    # #名字 只看这一个名字：方法的重载、字段，或类名本身（构造）
cosmic_knowledge action=findclass query=UnLockFieldAction                                 # 反查全限定名 + 所在 jar
```

- `api` 一次可以给多个全限定类名（空格或逗号隔开），临时探针的 import 清单可以整份贴进去。
  每个类回：所在 jar、父类、本类声明的 public 和 protected 方法（擦除后的签名，带泛型时另起一行给泛型签名；
  protected 的行首写 `protected`，子类里调得到）、构造、字段（静态常量带值，例如 `static String is_notnull = "is not null"`）、
  官方文档里这个方法的中文说明和真实参数名，以及本地资料里讲到这个类的段落。文档没写的方法照样列出签名，排在后面。
- 整类查只列本类自己声明的成员。`<全限定类名>#<名字>` 按名字查时，本类没声明就到父类和接口里找，
  行尾写「继承自 某类」（例：`AbstractListPlugin#setFilter` → 继承自 `IListPlugin`）；
  `memberMissing: true` 是这个类连同父类、接口上都没有这个名字。
- `findclass` **大小写不敏感**，所以编错的 `UnLockFieldAction` 照样能反查到真名；类名片段也行。
- ⚠️ **关键字没命中只说明类名不叫那个，不能反推「这个功能不存在」**（[metadata-form.md](metadata-form.md)
  里有过一次这样的错误推论）。

## `lint`：整文件体检

```bash
node .claude/skills/long-cosmic-dev/driver.mjs lint [文件|类名 …] [--raw]
```

- 参数跟 `fast` 一样：给**类名**在代码模块里搜，给**路径**照路径找（探针、scratchpad 里的
  文件也能 lint，共用类 `IsvGuard` / `MetaResolve` 会自动进 sourcepath）。
- 一次给多个文件比分多次跑划算：javac 只启动一次。
- `--raw` 连 javac 原文一起打印（默认只给结论）。
- 退出码：**0 = 干净，1 = 有问题，2 = 参数/文件不对**，可直接用在脚本里。

输出契约（一行一个问题，前缀固定 `[LINT]`）：

```
[LINT] <文件相对路径>:<行>[（另见 N、M 行）] <问题> → <建议>
[LINT]     候选 <次优候选，最多 3 条>
[LINT] <n> 个问题（<k> 个给出了建议），<f> 个文件，<t>s
```

干净时只有两行：`[LINT] OK …` 加一句边界提醒。

### `fast` 会自动先跑它

**「写完先 lint」不用记，`fast` 自己会做。** 它在进正式编译前先跑一遍体检，没过就不编译：

`lint` 是单独的诊断工具，改完代码直接 `fast` 就行。插件知识由读、写插件源码时自动附带的知识卡片（Capsule）给出。

```
$ driver.mjs fast
[driver] 前置体检没过，没有进正式编译（省下约 35 秒）：
[LINT] …Plugin.java:55 方法 BusinessDataServiceHelper.loadSingleObject(String,String) 不存在
       → 最接近：static BusinessDataServiceHelper.loadSingle(Object, String) -> DynamicObject
[driver] 改完再跑一次 fast；只想看体检结果用 driver.mjs lint
```

实测 **5.5 秒**结束，而同样的错让 `fast` 自己撞上要 40 秒、且诊断里没有真名建议。

**刚 lint 干净过的文件会跳过前置体检**（`build/lint-stamp.json` 记文件 mtime，一改就失效），
所以先 `lint` 再 `fast` 不会付两遍钱。

**`fast` 自己编译失败时也走同一套诊断。** 前置体检带 `-implicit:none`、只看点名的文件，
改了方法签名把**别的**文件连带编挂的那类它看不见 —— 那时 `fast` 会说明这一点并照样给出真名建议。

### 不给参数 = 体检所有改动

`lint` 和 `fast` 共用同一个「比 `.class` 新的源文件」判据，所以零参数两边一致：

```
$ driver.mjs lint
[LINT] 体检 3 个比 .class 新的源文件：
  demo-hhx/…/XxxPlugin.java
  …
[LINT] OK  3 个文件，4.8s，没发现问题
```

**这不是顺手加的便利。** 规则要求先跑的命令一旦比它想拦的那个更难用（`fast` 零参数、
`lint` 却要自己列文件），人和 agent 都会走阻力小的那条路。

### lint 的机制

- **它就是 `fast` 的编译能力，只是 class 落 `build/lint-classes` 即弃**。
  所以 lint **不会污染代码模块的 classes 目录，也不会让常驻探针 JVM 过期** —— 跑多少次都行，
  跑完该 `fast` 还得 `fast`。
- 4500 个 jar 的 classpath 只有 `javac @argfile` 这条路走得通（命令行 32KB 上限、JDK8 的
  `java` 不支持 @argfile），所以 lint 复用 `build/cosmic-javac.args`，缺了会自动先 `build`。
- **诊断反查走 `ApiTool suggest`**（JVM 反射 + 一遍扫 jar）：javac 只说「找不到符号」，
  不会告诉你真名，而幻觉 API 恰恰是「名字差一点」。
  - 方法名写错 → 列该类**全部同名/近名重载**，标注哪个「参数个数对得上」；
  - 类名写错 → 全 jar 反查最接近的全限定名 + 所在 jar；
  - 常量/字段写错 → 列该类最接近的公共字段（`QCP.equals_to` → `QCP.equals`）。
- **重载不匹配不用反查**：`-Xdiags:verbose` 会让 javac 自己列出全部候选重载和「哪个参数
  对不上」，lint 只是把「参数个数就不对」的那些排到后面。

体检的文件 `extends` 插件基类时，结果后面多两行 `[KB]` 官方入口（没配知识库则是
`[KB-MISSING]`），契约在 [official-knowledge.md](official-knowledge.md#不用记lint--sig-会把入口摆出来)。

### lint 的坑

- **lint 过 ≠ 语义对。** 它只回答「这个名字在 classpath 上存在吗、参数类型对得上吗」。
  字段标识拼错、操作码写错、事务阶段用错、QCP 常量选错含义 —— javac 全放行，lint 也全放行。
  这类要靠探针跑真实环境，别把 `[LINT] OK` 当成验过了。
- **第一次跑可能要一两分钟**，之后稳定 5 秒左右。差别是操作系统的文件缓存：4500 个 jar
  第一次全部读进来很慢。别把首次的耗时当成 lint 的常态，也别据此判断它「挂了」。
- **`位置: 类 X` 给的是简单类名**（javac 按源码里的写法打），反射要全限定名，lint 靠源文件的
  `import` 表还原。所以**用通配符 import（`import kd.bos.x.*;`）时反查可能落空** ——
  输出会退化成「查无近似的名字」，不是「这个类真不存在」。工程里通配符 import 极少，
  遇到就改成显式 import 再 lint。
- 同一个错名字在 import 行和使用行会各报一次，lint 已按「文件 + 错的是谁」合并成一条，
  多出来的行号跟在后面（`:3（另见 14 行）`）。看到只报一条不等于只错了一处。
