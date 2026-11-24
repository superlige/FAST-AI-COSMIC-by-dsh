---
class: A
when: 构建、fast、本地节点、截图、部署与排错
---

# 构建 / fast / 起节点 / 截图 / 部署 / 排错

来源：真实苍穹 8.0 二开工程实测。

**只有需要看 Web 界面时才需要启动节点。** 验证逻辑用探针快两个数量级，见 [probes.md](probes.md)。

- [认工程、起 JVM：自动探测认什么，认不出怎么改](#认工程起-jvm自动探测认什么认不出怎么改)
- [构建与部署](#构建与部署)
- [fast：改了业务代码怎么快速验证](#fast改了业务代码怎么快速验证)
- [启动调试节点](#启动调试节点)
- [截图](#截图)
- [环境诊断](#环境诊断)
- [排错](#排错)

## 认工程、起 JVM：自动探测认什么，认不出怎么改

`cosmic_doctor` 列出每一项的值和出处，自动探测的写着是从哪个文件读的。认错了或认不出，
就读工程文件找出对的值，用 `cosmic_doctor action=config set={…}` 写进 `<工程>/.cosmic-ai/config.json`。
写之前逐项对照工程核对，一项不对就一项都不写；值写 `null` 是删掉这一项、回到自动探测。
账套（`account`）和用户（`user`）只有用户知道：打开工程时会弹框，让用户从环境列出来的名单里选，这里不收。

| 项 | 自动探测 | 认不出 / 认错时 |
|---|---|---|
| 工程根 | 往上找第一个有 `settings.gradle` 或 `settings.gradle.kts` 的目录（跳过 `buildSrc`） | `cosmic_open_project projectRoot=<绝对路径>` |
| `isv` | `gradle.properties` 的 `systemProp.developer_flag` | 设 `isv` |
| `cosmicHome` | `gradle.properties` 的 `systemProp.cosmic_home` | 工程没写才设 `cosmicHome`；工程写了以工程为准，不能换 |
| `debugModule` | 构建脚本（`build.gradle` 或 `.kts`）里唯一用 `java-application-conventions` 插件的模块，其次是名字含 `cosmic-debug` 的 | 设 `debugModule` |
| `codeModules` | 顺着调试模块的依赖一路收，见下文「代码模块」 | `extraCodeModules` / `excludeCodeModules` |
| `appClass`、`appMethod` | 调试模块源码里有 `main`、又提到 `Launcher` 的类；`main` 里 `Launcher x = 方法()` 的那个方法；配置和 `start()` 都写在 `main` 里、`start()` 走 `Booter.main` 的，就是 `main` | 设 `appClass` / `appMethod`。方法必须是不带参数的 static 方法：探针宿主不传参数、也没有实例 |
| `tenant` | 上面那个方法里 `setTenantNumber("…")` 的字面量，没有就是 `ierp` | 设 `tenant` |
| `javaHome` | `gradle.properties` 的 `org.gradle.java.home` → 环境变量 `JAVA_HOME` → PATH 上的 `java` | 设 `javaHome`，要 JDK 8（不是 JRE）。选定的 JDK 排在所有子进程 PATH 的最前面，编译、探针、gradlew 用的是同一个 |
| 源码和输出目录 | 生成编译参数时 gradle 顺手写出 `build/cosmic-modules.json`（每个模块 `sourceSets.main` 的源码目录和 class 输出目录），照它编译、查新鲜度；第一次构建之前按 `src/main/java`、`build/classes/java/main` | 不用配。改过 `sourceSets` 的工程跑一次 `cosmic_doctor action=rebuild force=true` |
| `jvmArgs` | 没有 | 追加给常驻探针、冷探针、调试节点的 JVM 参数。写了 `-Xmx` / `-Xms` / `-XX:MaxMetaspaceSize` 就替换默认值（探针 `-Xmx2g`，节点 `-Xmx4g`）；`-cp`、`-jar` 不收 |
| `gradleArgs` | `["--offline"]` | 整体替换：要联网构建写 `[]`，跳过测试写 `["-x", "test"]` |

## 构建与部署

```
cosmic_doctor                                      # 体检：当前配置 + 每一项从哪来的
cosmic_doctor action=rebuild                       # 编译代码模块 + 生成 pathing jar / javac argfile
cosmic_runtime action=deploy                       # 打 jar 拷到 <cosmic_home>/mservice-cosmic/lib/cus
cosmic_runtime action=deploy modules=["demo-hhx"]  # 只部一个模块
```

`rebuild` 顺带产出后面都要用的东西：`build/cosmic-pathing.jar`（只含 MANIFEST，`Class-Path`
指向全部依赖，给 JVM 用）、`build/cosmic-javac.args`（给 javac 用）和 `build/cosmic-modules.json`（各模块的源码和输出目录）。

**`deploy` 只在用户明确要求时跑。** 常规交付路径是 agent 提交代码、用户按自己的流程把它部到
线上环境测；本地节点只在要 debug 时才起。`deploy` 拷的是**本机** `mservice-cosmic/lib/cus`，
跟用户测的那个环境是两回事 —— 拿它当「已发布」的判据，完成情况就成了假话。

### 代码模块（doctor 里的 `codeModules`）

**它是本地 Gradle 子工程 —— 源码在哪、class 编到哪、jar 部到 `lib/cus` 哪几个、探针
classpath 从哪加载业务类。跟苍穹环境里的「业务模块 / 应用 / 业务域」不是一回事，也推不出来。**
一个 Gradle 模块可以横跨几朵云，同一张单据的插件也可以散在几个模块里。「这个类绑在哪张单上」
只有查得到：`impact <类名>`（本地引用 + 真实绑定）和 `PluginIndexProbe`。

探测规则：调试模块依赖的工程，**沿依赖传递闭包一路收**（挂在别的模块下面的公共模块也算，
它的类同样要进 classpath、同样要能 `fast`）。`project(':x')`、`project(path: ':x')`、
`project(':组:模块')`、`projects.xxYy` 四种写法都认；最后一种对不上 `settings.gradle` 的
include 列表时，doctor 会把它列成「认不出是哪个模块」——**不猜**，缺了就用 `cosmic_doctor action=config` 补：

| 配的项 | 作用 |
|---|---|
| `codeModules` | 整体替换探测结果。工程新增模块时**会悄悄过期**，能不用就不用 |
| `extraCodeModules` | 在探测结果上补几个（探不出来的、或没被调试模块依赖到的可部署模块） |
| `excludeCodeModules` | 在探测结果上去掉几个 |

`rebuild` / `deploy` 默认对全部代码模块执行，`modules` 缩到指定的几个（名字拼错当场报错，
不会变成「跑成功了但那个模块没动」）。两条差别要知道：**`deploy` 给了 `modules` 是真的只部那几个**；
**`rebuild` 给了 `modules` 只缩 `:模块:build`，pathing jar 仍然编齐所有模块的 classes** —— 探针
classpath 少一个模块就是 `NoClassDefFoundError`。默认全部是对的，别为了省时间把公共模块漏掉。

`deploy` 的生效范围要分清：

| 谁 | deploy 后生效吗 |
|---|---|
| 探针（含常驻 JVM） | ✅ 立刻，cosmic 会自动重启常驻 JVM |
| 正在跑的调试节点 | ❌ 要 `stop` + `start` 才加载新类 |
| 用户测的那个环境 | ❌ 完全无关，它加载的是提交后由用户部署的那份 |

### 坑

- **别并发跑两次 `build`/`deploy`**（比如都丢后台）。两个 Gradle 实例会抢 `~/.gradle/caches`
  的锁，之后每次 build 都要等满 2~3 分钟锁超时才报 `BUILD FAILED` —— 看着像编译慢，
  其实一行代码都没编。串行跑是 30 秒。
- **`build` 前先 `probe-server stop`、节点也要先 `stop`** —— 它们占着 `build/cosmic-pathing.jar`，
  不放手就报 `Unable to delete file`。
- **别用 `grep "BUILD"` 判断构建成败**，`BUILD FAILED` 也会命中。判成功只认 `BUILD SUCCESSFUL`。
- **Gradle 的中文输出在 Bash 工具里是乱码**（GBK），`ע: ĳЩ...` 是「注: 某些输入文件使用了
  已过时的 API」，不是错误。
- **`gradlew.bat` 不在 PATH 上**，cwd 也不算数，必须给绝对路径。cosmic 自己调时已经这么做。
- **`GC overhead limit exceeded` / `Expiring Daemon because JVM heap space is exhausted`**：
  工程 `gradle.properties` 给 Gradle 的是 `-Xmx1024m -XX:MaxMetaspaceSize=128m`，扫 4400 个 jar
  的 `fileTree` 在可用物理内存偏低时会顶不住，表现是 `BUILD FAILED` 但**没有任何编译错误**。
  先 `gradlew --stop` 清掉 daemon 再重试；仍失败就临时加大
  `-Dorg.gradle.jvmargs="-Xmx3g -XX:MaxMetaspaceSize=512m"`（改工程文件要先跟人确认）。
  只改了一两个类、只想验证逻辑时，直接用下面的 `fast`，别跟 Gradle 纠缠。

## fast：改了业务代码怎么快速验证

**改了代码模块里的业务代码（哪怕只改方法体）就先 `fast` 再跑探针** —— 探针引用的业务类走
classpath，不重新编译就是拿旧类在验，而且只改方法体时不报任何错，最危险。

**已拦截**：`probe` 每次先扫一遍业务源码，有比 `.class` 新的就列出前几个并
**拒绝跑（退出码 3）**。默认拒绝不是提示 —— 提示可以被无视，而这个错的代价是拿旧类当验过了。
两个逃生开关：`COSMIC_STALE=fast` 自动先编再跑（+40 秒），`COSMIC_STALE=warn` 只提示不拦
（确认这次探针跟业务代码无关时用）。

```
cosmic_fast                        # 自动编所有比 .class 新的源文件
cosmic_fast sources=["某插件"]     # 或指定类名 / 路径
```

javac 约 5 秒；常驻 JVM 不再每次重启：下次用它之前先把变了的类热替换进去（改方法体约 1 秒），
加字段、加非 private 方法这类结构变化换不进去才重启（约 30 秒），见 probes.md「改完代码」。只查元数据 / 查数据、
不碰工程类的探针不受影响，不用 `fast`。**别用 `deploy` 做这件事** —— 它要 3~4 分钟，
只在把成果交出去（给别人的节点用、进 CI）时才需要。

### 为什么不能直接用 gradle 编

Gradle 在苍穹工程上**做不到增量编译**：4400 个依赖里总有几十个 jar 它分析不了
（multi-release jar、含非法宽字符条目的资源 jar），撞上任何一个就整体退回全量，
改 1 行也重编 3'32"；逐个 exclude 行不通——出问题的 poi / jackson / commons-\* 正是业务代码在用的。
`javac` 没有这个包袱（不做增量分析，只编你给的文件），单文件 5~6 秒。
`fast` 就是 javac + `build/cosmic-javac.args` 直接编进 `<代码模块>/build/classes/java/main`
（代码模块有多个时按模块分组编，`-d` 不能混）。

### classpath 顺序（已从机制上解决，别改回去）

`runtime/cosmic-run.gradle` 把 `<代码模块>/build/classes/java/main/` 排在 **Class-Path 最前**，
并把代码模块自己的 jar 全部剔除 —— 否则 `lib/cus` 里上次 deploy 的旧 jar 先出现先赢，
「build 成功了探针跑的还是旧逻辑」，只改方法体时看不出任何异常。确认现状：

```bash
unzip -p build/cosmic-pathing.jar META-INF/MANIFEST.MF | tr -d '\r' \
  | sed ':a;N;$!ba;s/\n //g' | grep '^Class-Path' | tr ' ' '\n' | grep -n <代码模块名>
```

应该**只有 classes / resources 两个目录，没有该模块的 jar**。探针里打一行
`X.class.getProtectionDomain().getCodeSource().getLocation()` 也能当场看出链到的是哪一份。

### 别把业务类拷进 `build/probe-classes`

那是探针 class 的输出目录，`ProbeClassLoader` 对里面有 `.class` 的名字**子优先加载**
（`kd.*` 除外）。往里放一份业务包的 class，它会**永久压过其它所有位置**：之后不管怎么
重新编译、更新 jar，跑起来都是那份旧拷贝，**不报任何错**。

> 判据：jar 里的常量池明明有你刚加的日志串，运行时却打印旧格式（或干脆不打印）。
> `ls build/probe-classes/<业务包顶层目录>` 看一眼，有就删。

手工 `jar uf` 更新 `lib/cus` 的 jar 已无意义（那份 jar 不在探针 classpath 上），用 `fast` 即可。
真要动它：jar 被常驻探针 JVM 锁着，不先 `probe-server stop` 会报「写入现有的 jar 文件时出错」。
**常驻 JVM 内存里是旧类**这一条对谁都成立：`fast` 之后下次用它先热替换、换不进去再重启，`deploy` 直接重启；
自己手工调 javac 也会被常驻 JVM 发现（业务类目录变了），同样先换类再跑。改了静态字段初始值这类换进去也不生效的，
用 `cosmic_runtime action=probe-restart`。

## 启动调试节点

```
cosmic_runtime action=node-start          # 约 60 秒，等到端口通了才返回
cosmic_runtime action=node-status
cosmic_runtime action=node-logs lines=60
cosmic_runtime action=node-stop
```

浏览器打开 `http://127.0.0.1:<debugPort>/ierp`（端口见 `cosmic_doctor`），
**账套要手动切到 `doctor` 里那个 `account`** —— 登录页默认选的往往是另一个。
同环境的其它账套里通常也有本 ISV 的元数据，只是少一大半，
所以「界面能打开、菜单也有东西」不代表切对了账套。

### 坑

- **启动日志里的 `EmbedJettyServer.start(...)` 异常栈和 `未找到资源文件：prompt-xxx` 是正常的**，
  节点照样能起来。判断就绪只看两处：`服务启动完成:kdcosmic-...` 和
  `Started ServerConnector@...{0.0.0.0:8080}`。
- **节点要 `taskkill /T` 才停得干净** —— 苍穹会派生 dubbo/mq 子进程，只 kill 父 pid 会留孤儿
  占着 8080。`node-stop` 已经带 `/T /F`。
- 常驻探针 JVM 约 1.3G RSS，节点 `-Xmx4g`，两个同时开的话 16G 机器会紧张。

## 截图

无头 Edge 就够用，不用装 playwright：

```bash
mkdir -p build/shots
"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" \
  --headless=new --disable-gpu --hide-scrollbars --window-size=1440,900 \
  --virtual-time-budget=15000 \
  --screenshot="<工程根目录的 Windows 路径>\build\shots\login.png" \
  "http://127.0.0.1:8080/ierp/login.html"
```

`--screenshot` 的值必须是 **Windows 反斜杠绝对路径**，给 `/d/...` 这种 MSYS 路径会静默写到别处。
**截完用 Read 工具看图确认，别只看 "bytes written"。**

## 环境诊断

```
cosmic_probe name=EnvDiagProbe
```

一次输出六段：① 连的哪个 ZK/MC（来自工程的启动类）② 当前租户/账套/用户 ③ 这个环境里有
哪些账套 ④ 当前账套实际连的库 ⑤ 本账套里本 ISV 的实体元数据有多少个 ⑥ 试读一个具体标识
（`DIAG_ENTITY=` 可换）。全程只读，不打数据库密码。

| 现象 | 结论 |
|---|---|
| ③ 一个账套都没拿到 | MC(8090) 不通或租户不对 —— 网络/前置环境问题 |
| ② 的 accountId 不是 `doctor` 里那个 `account` 对应的 id | **账套选错了**。请用户输入 `/cosmic-env` 重新选（账套只由用户选） |
| ⑤ 数量明显偏少（几百而不是两千多） | 同上，账套选错 |
| ⑤ 数量正常但 ⑥ 读不到 | 标识本身的问题，不是环境问题 |

**坑：同环境的「另一个账套」往往不是空的，它也有本 ISV 的元数据，只是少一大半**
（出处工程实测：正确账套 **2517** 个、同环境另一个 518 个；两个账套连的还可能是同一个
库地址，route 表完全一样）。所以「查得到本 ISV 的元数据」不能证明账套选对了，
判据是 **② 的 accountId**。选错时 `MetaResolve` 报「既不是实体也不是表单布局」——
跟标识拼错、跟连不上，三种完全不同的原因长得一模一样。

## 排错

先确认网络 —— 断网 / 不在公司网段时所有连库命令都会卡住：

```bash
# ZK 地址在工程的启动类里（probe EnvDiagProbe 的 ① 段会打出来）
node -e "require('net').createConnection({host:'<ZK地址>',port:2181}).on('connect',()=>console.log('ZK OK')).on('error',e=>console.log('ZK FAIL',e.code))"
```

| 现象 | 原因 / 处理 |
|---|---|
| `NoAuth for /cosmic`、`zookeeper service checkConnection fail … please check configUrl config` | ZK 开了认证，启动类里的 `setConfigUrl` 没带或带错账号密码，写成 `"<地址>:2181?user=…&password=…"`。探针照工程启动类连环境，改完下一次探针自动重编启动类、重起常驻进程 |
| `Please use the thread pool utils (kd.bos.threads.ThreadPools)` | 在 `main` 线程查库了。用 `CosmicProbe` 宿主，别自己写 main |
| `EntityNotExistsException: ...元数据不存在` | 账套选错（`cosmic_doctor` 看当前是哪个）；或给的是布局标识，见 `MetaResolve` |
| `错误: 找不到或无法加载主类 XxxProbe` | javac 编译失败，先看 javac 的输出；或类名 ≠ 文件名 / 探针带了包名 |
| `实体类型PlainObject中不存在名为xxx的属性` | 分录字段的结果集属性名是「分录.字段」全路径，按短名取不到 |
| `NPE at AbstractMetadataWriter.convertToDesignMeta:550` | `new MetadataWriter()` 用了无参构造，必须传 `fm.getModelType()` |
| `OrmException: Content is not allowed in prolog` | 误用 `MetadataDao.deployMetadata(id)`，改元数据只需 `rebuildRuntimeMetaById` |
| `java.lang.Error: ServiceLookup not implemented` | 宿主的服务分发桥没装上（正常情况下它已经装好），见 [probes.md](probes.md#服务分发边界) |
| `Unable to delete file 'build/cosmic-pathing.jar'` | 常驻探针 JVM 或节点占着，先 `cosmic_runtime action=probe-stop` / `node-stop` |
| `gradlew.bat 不是内部或外部命令` | 用工程根目录的绝对路径 `"<工程根目录>/gradlew.bat"`（cosmic 自己调时已经这么做） |
| `start` 卡满 5 分钟超时 | 多半连不上开发环境，先跑「环境诊断」里的 ZK 连通性检查 |
| 8080 被占 | 上次的节点没停干净：`Get-NetTCPConnection -LocalPort 8080 -State Listen` 找 pid 再 `Stop-Process -Force` |
| javac 报一堆 `程序包 kd.bos.xxx 不存在` | argfile 没生成或过期，`cosmic_doctor action=rebuild force=true` |
| 探针抛 `探针缺配置：cosmic.xxx` | 没经 cosmic 起这个进程（别手工 `java -cp … CosmicProbe`），或工程配置没配全 —— 跑 `cosmic_doctor` |
| 常驻探针起不来 / 常驻进程编译不了探针 | JDK8 的编译器在 `<java.home>/../lib/tools.jar`，选定的 JDK 是独立 JRE 时那条路径不存在。用 `cosmic_doctor action=config` 把 `javaHome` 指向 JDK 而非 JRE。**冷进程（`cold=true`）不受影响，用它能区分是不是这一类** |
| 常驻探针或冷探针刚起就退出，日志里是 `找不到账套` | 下面跟着这个环境可选的账套清单。账套只由用户选：请用户输入 `/cosmic-env` 重选 |
| 常驻进程报上一个探针超时、拒绝新请求 | 这是执行超时后的保护，和空闲退出不同。工具会在下一次调用时更换失效的常驻进程，再执行新请求；超时的那次操作不会自动重跑。先只读核对现状，超时不代表业务线程已停止 |
| `IsvGuard 拒绝写入：没拿到本工程的 ISV` | `-Dcosmic.isv` 没传到 JVM。红线拿不到 ISV 时是**全关**，不是放行。跑 `cosmic_doctor` 看 isv 那一项 |
| `cosmic-run.gradle 缺参数` | 手工调了 `gradle -I runtime/cosmic-run.gradle`。模块名/启动类由 cosmic 按工程配置传，用 `cosmic_doctor action=rebuild` |
| gradle 报 `GC overhead limit exceeded` | 先看挂在哪个 task。挂 `compileTestJava` 时业务代码本身是好的（`:compileJava` 会先 SUCCESSFUL）—— 工程堆只有 1G，扛不住 4400 个 jar 的测试 classpath。用 `cosmic_doctor action=config` 设 `gradleArgs` 为 `["--offline", "-x", "compileTestJava", "-x", "test"]` 绕过，**别去改共享的 `gradle.properties`** |
