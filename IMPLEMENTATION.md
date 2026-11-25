# fast-ai-cosmic 架构与功能

## 一段话看懂

fast-ai-cosmic 是帮人开发金蝶苍穹插件的 AI 助手。它拿 deepseek-harness（下称 dsh，一个通用 AI 编程助手，有网页和桌面界面）当底座，
本仓库做成 dsh 的一个仓库外组合包（不改 dsh 本体的插件包）：给模型加一组 `cosmic_*` 工具，让它能在用户自己的苍穹环境里编译代码、跑"探针"
（一小段 Java，进苍穹进程里查元数据、跑业务、断言结果）、改元数据。
同一个会话里还能只读查生产：查生产库、生产元数据、monitor 日志，把报错堆栈对到本地源码，出一份每条结论都标了证据编号的诊断报告，接着在测试环境修好、验证。

本仓库两层：**内核**（真正干活的命令、探针、知识库、运行时）和**接 dsh 的那层**（`src/dsh/`：注册 12 个产品工具、执行前门槛、
返回整理、系统提示段、技能、命令、写元数据前的确认单）。不分模式：每个会话都挂全部 12 个产品工具，开发和查生产接着做。
生产只读靠 `cosmic_prod` 自己的闸，其余工具和终端连的都是测试环境。
桌面和网页里是组合包声明的一个预设「苍穹」；无界面没有预设，配置 `cosmic` 把产品工具插在顶层。开发调试的网页用配置 `cosmic-web`。
两个配置都由 `node scripts/setup-dsh-profiles.mjs` 建；给用户的是一个 Windows 安装包（`npm run build`）。

这份文件只写**现在是什么样**。写法规矩见 `AGENTS.md` 第二节。

---

## 一、架构

### 1.1 一次调用走过哪几层

```
dsh 的工具流水线
  ├─ src/dsh/hooks.ts                执行前门槛（重复失败）；写文件、读文件之后附知识卡片和写法问题
  └─ src/dsh/index.ts → tools/*.ts   每个工具：参数先按完整 schema 校验，再调内核，返回整理成几块文字
      └─ src/kernel/commands/*.ts    真正干活的命令（编译、跑探针、run、impact、meta、prod……）
      ├─ src/kernel/policy/          安全闸：写 API 黑名单、工程写锁、共享写入准入、外部动作识别
      ├─ src/kernel/probe/server.ts  常驻苍穹 JVM：起、认归属、发请求、收结果
      │    └─ resources/runtime/CosmicProbeServer.java 等   JVM 里的宿主
      │         └─ resources/probes/*.java               各个探针（查元数据、仿真表单、跑操作……）
      ├─ src/kernel/prod/            生产只读排障
      └─ src/knowledge/              官方知识库、技能文档、插件族识别、知识门禁
```

内核不认识 dsh，也不认识模型：它只收参数、回结构化结果。接 dsh 的那层所有会变的状态都在每个会话一份的 `CosmicSession`
（`src/dsh/session.ts`）里，键是 dsh 的会话编号；模块顶层只有进程级的内核单例和 JVM 状态板（都在 `src/dsh/kernel.ts`）。调用方先用 `openProject`（`src/kernel/open-project.ts`）认工程、
算出 RuntimeKey、释放内嵌资源，拿到上下文（`KernelContext`）再调各命令。

### 1.2 目录表

| 目录 / 文件 | 里面是什么 |
|---|---|
| `src/brand.ts` | 产品名。对外叫 `fast-ai-cosmic`；`cosmic_*` 工具名、`COSMIC_*` 环境变量是内部稳定名字，不随品牌改 |
| `src/dsh/` | 接 dsh 的那层：插件入口 `index.ts`（挂工具、钩子、系统提示段、技能、命令）、`tools/` 每个工具一个文件、`hooks.ts` 门槛、`write.ts` 写元数据一次调用写完、`host.ts` 工具共用的打开工程 / 编译新鲜度 / 输出预算 / 失败计数、`define.ts` 参数换成 dsh 认的 JSON Schema、`session.ts` 每会话状态、`commands.ts` 给人敲的命令、`setup.ts` 工程配置向导、`jvm.ts` 本机进程列表、`jvm-board.ts` JVM 状态板、`present.ts` 界面卡片标题、`brand.ts` 品牌行的宿主半边、`codex-login.ts` 设置页登录 ChatGPT 的宿主半边、`fixed-text.ts` 发给模型的固定文字一处拼出、`probes.ts` 产品内置的已发布探针清单 |
| `src/agent/` | 接 dsh 那层用的纯函数：`prompt/system-prompt.ts` 系统提示和完成情况模板、`state/write-report.ts` 确认单、`state/prod-state.ts` 生产查询的证据编号、`tools/` 输出预算、知识卡片、读写账、写法检查、工具名清单 |
| `cordis.patch.yml` | 组合包：一个预设「苍穹」（挂产品工具）、关掉 dsh 自带的四个预设、官方品牌行和三处往外发数据的行、插品牌行 |
| `client/brand.js` | 界面：iOS 27 风格、首页、登录 ChatGPT、JVM 小标签、写入确认卡片、`@` 引用；不经编译 |
| `packaging/presets/production.env` | 桌面打包配置：应用 ID、关自动更新、强制更新地址填一个连不上的 |
| `src/kernel/commands/` | 每个命令一个文件：`fast` 编译、`lint` 前检、`probe` 跑探针、`run` 免界面跑业务、`impact` 反查、`meta` 改元数据、`knowledge` 查知识、`doctor` 体检、`build` 重建编译参数、`deploy` 部署、`node` 调试节点、`probe-server` 常驻进程启停、`prod` 生产只读排障、`sources` 认源码、`user-lookup` 查用户 |
| `src/kernel/config/` | 认工程根、读 `config.json`、解析 gradle、首次配置向导 |
| `src/kernel/probe/` | 常驻 JVM（`server.ts`、`protocol.ts`）、探针输出解析（`output.ts`）、落盘（`stash.ts`）、本机 JVM 清单（`local-jvms.ts`） |
| `src/kernel/policy/` | 安全闸：`write-apis.ts` 临时探针不许碰的写 API、`shared-write.ts` 写元数据准入、`project-write-lock.ts` 写锁、`external-effects.ts` 发消息调接口识别、`write-plan.ts` 写入预演、`write-form.ts` 确认单表单 |
| `src/kernel/verify/` | `evidence.ts` 运行记录（每次带断言的 `run` 落一份）、`grade.ts` 断言判定 |
| `src/kernel/impact/` | 代码关系表（记录每个插件挂在哪张单上、读写了哪些字段）：建表、刷新、按字段 / 类 / 单据反查 |
| `src/kernel/meta/` | `meta` 命令的参数解析、元数据离线比对、打印模板本地编辑 |
| `src/kernel/prod/` | 生产只读排障：配置（`config.ts`）、语句闸（`sql-guard.ts`）、读取进程客户端（`reader.ts`）、元数据合并与比对（`meta-xml.ts`、`meta.ts`）、monitor 登录查询（`monitor.ts`、`monitor-search.ts`、`bill-trail.ts`）、日志分组和对源码（`log-view.ts`、`baseline.ts`）、诊断报告（`report.ts`） |
| `src/kernel/style/` | 插件写法检查（循环里查库、该用常量写了字符串、方法太长） |
| `src/kernel/project/` | 工程档案（`.cosmic-ai/project.yaml`）、`.cosmic-ai/` 目录整理 |
| `src/kernel/*.ts` | 打开工程（`open-project.ts`，唯一建上下文的地方）、目录约定（`layout.ts`）、调 javac / java / gradlew（`toolchain.ts`）、错误码（`errors.ts`）、对外部世界的读写口（`ports.ts`，测试换成假的） |
| `src/knowledge/` | 官方知识库读取、技能文档包（`reference.ts`）、插件族识别（`plugin-base.ts`）、知识门禁（`plugin-gate.ts`）、`run` 各子命令的参数契约（`run-adapter.ts`）、旧命令到工具的映射（`command-map.ts`） |
| `src/eval/` | 知识库评测语料和评分（`corpus.ts`、`knowledge-eval.ts`）、回合基线（`round-efficiency.ts`：哪道门该在第几轮拦、哪条安全边界由哪个测试守） |
| `src/runtime/` | 运行时身份 RuntimeKey（工程 + JDK + 苍穹 JAR + cosmic 版本合成的一个指纹，缓存和常驻进程都按它分开）、缓存、内嵌资源释放、发行物审计 |
| `src/resources/embedded.generated.ts` | 自动生成：`resources/` 打进程序里的副本。不要手改 |
| `src/manifest/`、`manifests/` | 最早从老仓库迁移时的冻结记录，平时不用动 |
| `resources/probes/` | 已发布探针（Java）。探针文件头写着用法 |
| `resources/runtime/` | 苍穹 JVM 里的宿主：`CosmicProbeServer.java` 常驻服务、`CosmicProbe.java` 冷进程、`HeadlessViews.java` 免界面视图 |
| `resources/tools/` | 反射查平台类签名（`ApiTool.java`）、源码索引（`SrcIndexTool.java`）、生产只读读取进程（`ProdReader.java`，只装 JDBC 驱动，不加载苍穹平台） |
| `knowledge/reference/*.md` | **技能文档**：发给模型按需读的参考（31 篇） |
| `knowledge/reference.pack`、`knowledge/cosmic-kb.pack` | 自动生成：技能文档包、官方知识库包。不要手改 |
| `scripts/` | 编组合包（`build-bundle.mjs`）、出安装包（`package-desktop.mjs`，dsh 上的补丁逐条在里面）、不打包起桌面窗口（`dev-desktop.mjs`）、建 dsh 配置（`setup-dsh-profiles.mjs`）、导出（`export-*.mjs`）、真机验证（`verify-*.ts`）、测量（`measure-*`；读会话的 pi、dsh 都认，读法在 `session-reader.mjs`）、清单（`checklists/`）。每个脚本文件头写着用法 |
| `test/` | 按 `src/` 同名分目录；`test/security/prod-readonly.test.ts` 是生产只读闸绕不绕得过去的回归；`test/manifest/` 管文档体量和不依赖 pi |

### 1.3 程序跑起来后文件放在哪

`.cosmic-ai/` 下各项的寿命见 `kernel/project/cosmic-dirs.ts` 的目录表；索引和磁盘缓存另列在 `cache-inventory.ts`（「缓存」面板照它画）。下面只列人配的和不自动删的：

| 位置 | 放什么 | 能不能删 |
|---|---|---|
| `<工程>/.cosmic-ai/config.json` | 工程级配置（账套、用户、ISV 等），压过全局那份 | 不能，用户配的 |
| `.cosmic-ai/evidence/` | 备份 `backups/`（落库前自动存）、诊断报告、生产查询流水账 `prod-audit.jsonl` | 不自动删 |
| `<工程>/build/cosmic-pathing.jar`、`cosmic-javac.args`、`cosmic-modules.json` | 工程 gradle 产出的编译参数、模块目录 | 能重建 |
| `~/.fast-ai-cosmic/config.json` | 全局配置 | — |
| `~/.fast-ai-cosmic/prod/prod.json` | 生产只读排障配置：生产库只读账号、monitor 账号、每条查询限时限行 | 不能，用户配的；含凭据，不进工程目录 |
| `~/.fast-ai-cosmic/prod/prod.monitor-session.json` | monitor 登录后的会话（闲置约半小时过期） | 可以，删了重新登录 |

---

## 二、功能表

### 2.1 内核命令

| 命令 | 做什么 | 代码 | 技能文档 |
|---|---|---|---|
| 认工程 | 认工程、JDK、苍穹 JAR，算出 RuntimeKey，释放内嵌资源；工程文件里有的都自动读 | `kernel/open-project.ts`、`kernel/config/` | `runtime.md` |
| `lint` | 用用户的苍穹 JAR 编译检查、不留 class，返回结构化报错 | `kernel/commands/lint.ts`、`kernel/diag/javac.ts` | `lint.md` |
| `fast` | 编译改过的业务类；插件类先过知识门禁；常驻 JVM 下次用前热替换（结构变了才重启） | `kernel/commands/fast.ts`、`knowledge/plugin-gate.ts` | `lint.md`、`plugin-dev.md` |
| `probe` | 跑已发布探针，或跑模型写的只读临时探针（编译前查签名、扫写 API） | `kernel/commands/probe.ts`、`kernel/policy/{probe-scan,write-apis,api-precheck}.ts` | `probes.md`、`sdk.md` |
| `run` | 免界面真跑业务（测试环境真提交）：`op` 操作、`form` 表单、`list` 列表、`callback`/`flow` 父子页面、`rule` 规则、`print` 打印、`call` 直调方法、`push` 转换下推、`wf` 工作流；带 `--expect` 断言，每次落一份运行记录 | `kernel/commands/run.ts`、`knowledge/run-adapter.ts`、`kernel/verify/`、`resources/probes/*Sim.java` | `run.md`、`run-parent-child.md`、`plugin-print-runtime.md`、`workflow.md` |
| `impact` | 代码关系表反查：字段的读写处、类 / 单据 / 布局挂了哪些插件和规则 | `kernel/commands/impact.ts`、`kernel/impact/` | `impact.md` |
| `meta` | 读写非实体元数据：表单布局、字段、规则、BOTP 转换（写走 `BotpRuleSyncProbe`：复制业务规则，改字段映射、建行层级、源单过滤和执行条件；写前过平台校验，写后回读）、打印模板、工作流、公式函数查询；写入先预演 | `kernel/commands/meta.ts`、`kernel/meta/`、`kernel/policy/{write-plan,shared-write}.ts` | `meta-cmd.md`、`metadata-*.md`、`print-template*.md` |
| `probe-server`、`node`、`deploy` | 常驻探针 JVM 和本地调试节点的启停、状态、日志；把代码 jar 部到运行时 | `kernel/commands/{probe-server,node,deploy}.ts`、`kernel/probe/server.ts` | `runtime.md` |
| `doctor`、`build` | 工程体检（每项配置值和出处）；改工程配置（核对后才写，账套、用户不收）；重建编译参数、代码关系表、查和回收写锁 | `kernel/commands/{doctor,build}.ts`、`kernel/config/set-config.ts` | `runtime.md` |
| `knowledge` | 查官方知识库、场景表、平台类签名、已发布探针清单、插件开发流程 | `kernel/commands/knowledge.ts`、`knowledge/`、`kernel/api-tool.ts` | `official-knowledge.md`、`plugin-*.md` |
| `prod` | 生产只读排障：`status`、`sql` 一条只读查询、`meta` 生产元数据摘要和比对、`log` monitor 日志分组并对源码、`report` 诊断报告 | `kernel/commands/prod.ts`、`kernel/prod/`、`resources/tools/ProdReader.java` | `runtime-traces.md` |

### 2.2 贯穿各命令的机制

| 机制 | 做什么 | 代码 |
|---|---|---|
| 临时探针只读 | 写 API 黑名单 + 源码扫描；没查过签名的平台调用先拦下 | `kernel/policy/{write-apis,probe-scan,api-precheck}.ts` |
| 写元数据 | 一次调用写完：写调用附 `report` → 预演 → 按预演排确认单 → 弹给用户（界面画成逐处对比的卡片）→ 确认后带确认号落库 → 回读；弹不了确认就不写。落库范围就是预演报出的写入目标清单，JVM 里的 IsvGuard 逐个比对。布局写入的规矩（回读分三层报数、「写了一半」、派生布局逐张重建、`layouts=`、可见性和锁定、拆分表、必录条件和校验）见 `FormLayoutWriteProbe.java` 文件头和技能文档 `metadata-entity-write.md`；业务规则按 id 原位改条件、计算公式、启用（目标 `实体.规则id`） | `dsh/write.ts`、`agent/state/write-report.ts`、`kernel/policy/{write-plan,shared-write,write-form}.ts`、`client/brand.js` |
| 模型配置和登录 | 组合包配好 codex（pi-ai 自带 9 个加手工补的 gpt-6.2-sol）和 Command Code GOAT 网关（密钥由用户在设置页填，引用名 `COMMANDCODE_GOAT_API_KEY`），DeepSeek 用自带卡片填密钥、不用账号登录（左下角是设置）；codex 卡片上有「登录 ChatGPT」「退出登录」，浏览器登完自动回来，没回来可贴地址栏地址 | `cordis.patch.yml`、`dsh/codex-login.ts`、`dsh/brand.ts`、`client/brand.js` |
| JVM 小标签 | 进会话就后台起 JVM，输入框旁和首页显示起到哪步（配置不全时等初始化，填完重起）；点开看进程、每步用时、原因，能启停 JVM。同工程共用；没构建不起；别的预设不画 | `dsh/jvm-board.ts`、`client/brand.js` |
| 输入框 `@` 引用 | 敲 `@` 加编号或中文名找单据、表单、布局、分录、字段（`单据.分录.词` 逐层钻）；发送时换成一段 `<cosmic-ref>`，写明它在元数据里的准确位置，会话标题里换回 `@名字`。数据来源见 `kernel/impact/mention.ts` 文件头 | `kernel/impact/mention.ts`、`kernel/commands/mention.ts`、`dsh/{mention,session-title}.ts`、`client/brand.js` |
| 界面卡片 | 每次产品工具调用在界面上显示一行看得懂的标题（「真跑业务：op demo_bill save」），写入和只读用不同图标；只给界面看，不发给模型 | `dsh/present.ts` |
| 组合包产物 | 产品插件连同 typebox 合成一个 `tools.js`（装进桌面版后在 node_modules 下，Node 不给那里的 .ts 去类型），带知识包、品牌、预设；编完检查没有对 dsh 包的运行时引用、能被 Node 直接加载、过产物审计 | `scripts/build-bundle.mjs` |
| 安装包 | dsh 检出目录复制一份，套补丁（预装组合包、壳和安装程序换名换图、界面字典里插件改不了的几处、跳过 DeepSeek 欢迎页、图标、和另装的 dsh 隔离），调 dsh 自己的不签名打包；补丁逐条核对原文次数，套完扫一遍 | `scripts/package-desktop.mjs` |
| 查生产 | 每个会话都能用 `cosmic_prod` 只读查生产，查明后接着在测试环境改、验。本会话第一次连生产前弹框问一次，允许了不再问，不允许这次不查、下次再问；弹不了框（无界面）、出诊断报告不问 | `dsh/prod-setup.ts`（`ensureProdConsent`）、`dsh/tools/prod.ts` |
| `.cosmic-ai` 整理 | 打开工程时照目录表清，表外的不删只报；探针、`meta` 输出位置由工具定 | `kernel/project/{cosmic-dirs,output-paths}.ts` |
| 缓存面板 | 输入框旁「缓存」小标签：索引和磁盘缓存的占用、状态、下次自动更新时间；可手动重建、清空、清理 | `kernel/project/cache-inventory.ts`、`dsh/cache-board.ts` |
| 重复失败 | 同一调用同样失败两次，第三次在执行前拒；问用法、按行取回不算 | `dsh/streak.ts` |
| 给人敲的命令 | `/cosmic-env` 认工程、刷新代码关系表，缺账套、用户走配置向导（账套从名单里选）；`/cosmic-prod-setup` 生产排障配置向导（写前试连，可重填）；`/cosmic-jvm` 列本机常驻 JVM 和调试节点，`stop <pid>` 停一个；`/cosmic-login` 登 ChatGPT；`/cosmic-monitor-login` 照图输验证码登 monitor；首页敲的结果画在输入框上方 | `dsh/commands.ts`、`client/brand.js` |
| 工具里自动问人 | 在工具调用里弹框，问完接着执行：打开工程时只缺账套、用户才弹配置向导；调 `cosmic_prod` 前生产库没配弹生产排障配置向导，monitor 没登录或过期（第一次调、每次 `log` 前）弹验证码框。并行调用只弹一个；人不填、弹不了，本会话不再问，之后靠对应命令 | `dsh/{setup,prod-setup,monitor-login,host}.ts`、`dsh/tools/prod.ts`、`kernel/prod/setup.ts` |
| 本会话事实 | `cosmic_facts` 列现在和本会话开始时的净差别：业务 Java 逐处改前改后（改回原样的不算）、写进测试环境的元数据按对象归拢带确认单和撤销办法、断言运行逐条标之后改没改代码、跑没跑本会话建的单、现在的代码编译过没有、改过的插件类各被哪次运行跑到、留下的造改数（含 run 新建的单及来历）、写法提醒；每项报数、0 也报。不报编译运行次数。起点和事实落在会话目录的 `journal.json`，桌面版重开接得上。系统提示里的完成情况模板照它写 | `dsh/tools/facts.ts`、`dsh/tools/run.ts`、`dsh/session.ts`、`agent/prompt/system-prompt.ts`、探针侧 `RunFacts.java` |
| 造数改数 | 新建、照现成复制、从上游下推、改值报原值新值；整批一个事务，回读才算写成 | `resources/probes/Data{Seed,Update}Probe.java` |
| 工程写锁 | 编译和写环境跨进程排队；崩溃残留要点名回收 | `kernel/policy/{project-write-lock,write-lock-recovery}.ts` |
| 生产只读通道 | 三道闸：语句闸（只放行单条 select/with，拒写、拒改会话、拒加锁，函数限白名单）、会话只读、每条查询在只读事务里跑完回滚；记流水账；monitor 只发名单内接口；终端、文件工具读不到生产凭据 | `kernel/prod/{sql-guard,reader,monitor}.ts`、`ProdReader.java`、`dsh/prod-secrets.ts` |
| 常驻 JVM | 按 RuntimeKey 一个；认不出是自己的就降级冷进程，从不按端口杀；停进程要等它真退，等不到核对后强制结束 | `kernel/probe/{server,protocol,health,local-jvms}.ts`、`resources/runtime/CosmicProbeServer.java` |
| 探针输出 | 结构化记录走 `[PROBE-JSON]` 行，给人看的走文字；长输出全文落盘可取回 | `kernel/probe/{output,stash}.ts` |
| 运行记录 | 每次带断言的 `run` 落一份：参数、断言结果、当时的源码指纹和 RuntimeKey、写了哪些表；带摘要，改过的记录认得出 | `kernel/verify/{evidence,grade}.ts` |
| 表单按请求仿真 | `run form` 用真实 Redis 页面/模型缓存，打开、每条 `--set`、动作各一次请求：请求之间提交缓存、换 SessionManager、按 pageId 从缓存重建页面再 `registerListener`；改值前照浏览器入口先判这格能不能改；发往浏览器的锁定、选中行按页面跨请求留着；终值从最后一次重建的页面读；任一步插件抛异常都归到插件和行号上、这次标「没跑完整」 | `resources/probes/FormSim.java`（`nextRequest`、`editCheck`） |
| 表单界面状态 | `run form` 按打开后的视图判显示、锁定、必录；设计态有、运行态没有的字段（布局运行态比设计态旧）记判不了并说原因，不按默认答 | `resources/probes/{UiState,FormSim}.java` |
| 字段归属的继承 | 元数据快照只收每张单自己设计里的字段，另记每张单继承自哪（本 ISV 的上级设计、外面的模板）；只有自己的和本 ISV 上级的字段都收全、外面的模板不可能带这个字段时，才说「不在这张单上」，否则说「快照没记到」并写出继承自哪 | `kernel/impact/model.ts`（`knownAbsent`）、`resources/probes/EntityFieldIndexProbe.java` |
| 知识门禁 | 写插件前必须读过对应插件族的知识卡片 | `knowledge/{plugin-base,plugin-gate,capsule}.ts` |
| 技能文档 | `knowledge/reference/*.md` 打包成 `reference.pack`，模型按需读 | `knowledge/reference.ts`、`scripts/export-reference.mjs` |
| 写法检查 | 插件写法规则 | `kernel/style/` |
| 发行物审计 | 产物里不许有苍穹 JAR、客户配置、凭据 | `runtime/release-audit.ts` |

---

## 三、要改什么，去哪改

| 要做的事 | 改哪里 | 同一轮还要做 |
|---|---|---|
| 改某个命令的行为 | `src/kernel/commands/<命令>.ts` | 对应技能文档、`test/kernel/` 加用例 |
| 改工具说明、参数、返回 | `src/dsh/tools/<工具>.ts` | 技能文档；`node --experimental-strip-types scripts/measure-dsh-prompt.ts` 量前后，照实更新 `test/dsh/fixed-text-record.json` |
| 改执行前门槛 | `src/dsh/hooks.ts` | `test/dsh/gates.test.ts` |
| 改系统提示 | `src/agent/prompt/system-prompt.ts` | `test/dsh/prompt-budget.test.ts` 管上限 10 KB；同样更新 `fixed-text-record.json` |
| 改桌面、网页的预设（挂哪些 dsh 插件） | `cordis.patch.yml` | 和 `scripts/setup-dsh-profiles.mjs` 里无界面那套对齐；预设里的插件不继承 dsh-base 顶层配置，同名行配置要抄全（`test/dsh/presets.test.ts`）；`npm run dev` 起窗口新建会话看 |
| 改命令行配置（模型、无界面挂哪些插件） | `scripts/setup-dsh-profiles.mjs`，改完重跑它 | `dsh --profile cosmic --dump-config` 看结果 |
| 改模型清单、加服务商 | `cordis.patch.yml` 的 `llm-pi-ai` 那一段（桌面、网页、无界面共用；无界面配置脚本不另写这一行，写了会整段替换） | `test/dsh/model-config.test.ts`（pi-ai 自带清单变了会提示回来改）、`dsh --profile cosmic --dump-config` |
| 改设置页登录 ChatGPT | 宿主半边 `src/dsh/codex-login.ts`，按钮 `client/brand.js` 的 `CodexLoginCard` | `test/dsh/codex-login.test.ts`；`npm run dev` 起窗口看 |
| 改 JVM 小标签 | `src/dsh/jvm-board.ts`，`client/brand.js` 的 `JvmChip` | `test/dsh/jvm-board.test.ts`；`npm run dev` 看 |
| 加缓存、改它的规则 | 规则在原处，`cache-inventory.ts` 同步列上 | `test/{kernel/cache-inventory,dsh/cache-board}.test.ts`；真机 `verify-real-env.ts … caches` |
| 改 `@` 引用 | `src/kernel/impact/mention.ts` | `test/{kernel,dsh}/mention.test.ts`；真机 `verify-real-env.ts <工程> mention <词>` |
| 改界面品牌 | 名字和标语 `src/brand.ts`，界面 `client/brand.js`，插件够不着的文字和图标在 `scripts/package-desktop.mjs` 的补丁里 | `test/dsh/{brand,client-theme}.test.ts` |
| 升 dsh 版本 | `scripts/package-desktop.mjs` 的 `DSH_VERSION`，重跑它，对不上的补丁逐条改 | `npm run check`、无头跑一条需求、装上安装包冒烟 |
| 给 `run` 加子命令或参数 | `src/kernel/commands/run.ts`（`planRun` 是纯函数：参数 → 探针名 + 环境变量）、`src/knowledge/run-adapter.ts`、对应 `resources/probes/*Sim.java` | `run.md`；`run help` 的用法文字 |
| 加 / 改已发布探针 | `resources/probes/` 下的 Java，文件头写用法；只读且只碰平台的探针登记到 `src/kernel/policy/probe-freshness.ts` 的 `PLATFORM_PROBES` | `node scripts/export-resources.mjs --write`；`probes.md` |
| 改技能文档 | `knowledge/reference/*.md` | `node scripts/export-reference.mjs --write`、`npm run verify:eval` |
| 临时探针新增一类禁用写 API | `src/kernel/policy/write-apis.ts` | `test/kernel/` 加用例 |
| 写元数据新增一类 | `src/kernel/policy/write-plan.ts` 声明、`write-form.ts` 确认单表单、对应写探针 | `metadata-write.md` |
| 代码关系表扫什么 | `resources/probes/PluginIndexProbe.java`、`src/kernel/impact/model.ts` | `impact.md` 里"扫了哪些表"那段 |
| 配置项 / 环境变量 | `src/kernel/config/load-config.ts`、`src/kernel/context.ts`（`FORWARDED_ENV_KEYS`） | 模型能改的项登记在 `set-config.ts`；`runtime.md` 配置表 |
| 生产排障：放行 / 拒绝哪些语句 | `src/kernel/prod/sql-guard.ts`（读取进程 `ProdReader.looksLikeQuery` 还有一道开头检查） | `test/kernel/prod-sql-guard.test.ts`、`test/security/prod-readonly.test.ts` |
| 生产排障：元数据摘要、比对、日志分组和对源码 | `src/kernel/prod/{meta,meta-xml,log-view,baseline}.ts` | `runtime-traces.md`（平台知识部分） |
| 生产排障：monitor 切时间段、保留期；单据足迹 | `src/kernel/prod/monitor-search.ts`、`src/kernel/prod/bill-trail.ts`、`kernel/commands/prod.ts` 的 `trail` | `test/kernel/prod-monitor-search.test.ts` |

---

## 四、出问题怎么查

### 4.1 按症状找

| 症状 | 先看哪 | 再用什么 |
|---|---|---|
| 命令报错 | 返回里的错误码和 `remedy` | 搜错误码在 `src/` 哪里抛出 |
| 探针跑出的结果不对 | `~/.fast-ai-cosmic/cache/<RuntimeKey>/last-probe.out`、`probe-runs/` 下那次运行的全文日志 | — |
| 常驻 JVM 起不来、卡住、多起了一个 | JVM 小标签；`cache/<RuntimeKey>/probe-server.log` | `scripts/verify-jvm-board.ts`、`measure-resident-start-race.ts`、`measure-resident-start.ts` |
| 某一步特别慢 | — | 时间花在哪：`measure-probe-call.ts`；JVM 里在忙什么：`measure-jvm-stacks.mjs`；数据库连接：`measure-sql-stalls.mjs`、`measure-idle-stall.ts`；新起进程：`measure-resident-start.ts` |
| 改了元数据，进程读到的还是旧的 | 是不是在苍穹设计器手工改的（那种要手动重起常驻） | `probe-server` 重启常驻 |
| 运行记录写库表不对 | `<工程>/.cosmic-ai/sessions/<会话>/assertions/` 下那条记录 | `measure-run-writes.ts` |
| 生产查询报错、读取进程起不来 | `prod status` 的返回；`cache/<RuntimeKey>/prod/prod-reader.log` | 连不上先确认 VPN；配置在 `~/.fast-ai-cosmic/prod/prod.json` |
| 生产排障查了什么、查了几行、多久 | `<工程>/.cosmic-ai/evidence/prod-audit.jsonl`（被拒的语句也在） | — |
| `@` 引用找不到、缺东西 | `work/impact/forms.json`、`runtime-fields/` | `verify-real-env.ts … mention <词>` |
| `.cosmic-ai` 堆起来、找不到备份 | `cosmic_doctor` 的 `cosmicDir`：逐项报数、表外的、上次清了什么 | — |
| 插件没加载、工具没出现 | `dsh --profile cosmic --dump-config` 里有没有 `cosmic-tools` 一行 | `scripts/run-headless.ps1` 无头跑一句看事件流（`-Out` 文件，`.err` 是标准错误） |
| 每次请求带的字太多 | — | `scripts/measure-dsh-prompt.ts`：常驻系统提示最坏情况和每个工具的说明、参数字节；`dump-prompt-text.ts` 导出全文逐句看；`prompt-duplicates.ts` 找同一句写两处 |
| 一次会话慢、轮数多、绕路 | 会话：dsh `~/.fast-ai-cosmic/dsh/sessions/<工程标识>/<会话 id>/`（无界面 `~/.dsh`），pi `~/.pi/agent/sessions/<工程标识>/` | `analyze-session.mjs` 上下文被谁占了、绕路账；`measure-round-purpose.mjs` 每轮在干什么；`measure-prompt-cache.mjs` 缓存接没接上；`measure-delivery.mjs` 交付要点做到几条 |

脚本都在 `scripts/`，用法写在每个脚本的文件头。测量脚本只跑只读探针，不会改真机数据（个别会重起本版本自己的常驻进程，文件头写着）。

### 4.2 真机复现

经模型：`pwsh scripts/run-headless.ps1 -Profile cosmic -Out <文件> -Task "<需求>"`（默认在真机工程里跑）。不经模型、直接调内核：

```bash
node --experimental-strip-types D:/claudecode/deepseekharness/deepseek-harness/cosmic/scripts/verify-real-env.ts D:/kingdee/zlgd_ygpt2.0 open
#   … fast <文件> | probe MetaProbe META_ENTITY=bos_user | run op <单据> <操作> --pk <内码> --expect success=true | stop
```

能做什么、要先问什么，见 `AGENTS.md` 第三节。单项机制有现成的真机验证脚本 `scripts/verify-*.ts`，按文件名找。
不经模型、走和插件同一道门槛调产品工具（`scripts/direct-tools.ts`）：每个工具在真机上只读调一遍用 `verify-tools-smoke.ts <工程>`；
某次 `cosmic_run` 要复测（改完 cosmic 再跑同一组参数，看输出和留没留运行记录）用 `replay-run.ts <工程> <AE-xxx.json>`。

---

## 五、检查

| 命令 | 什么时候跑 |
|---|---|
| `npm run check` | 任何改动后：类型检查 + 代码风格 + 全部测试。技能文档或探针改了没重新生成也会在这里失败 |
| `npm run resources:export -- --write` | 改了 `resources/` 下的探针、宿主、工具 |
| `npm run reference:export -- --write` | 改了 `knowledge/reference/*.md` |
| `npm run verify:eval` | 改了技能文档、知识库、技能族目录：知识库评测语料逐条过 |
| `npm run verify:rounds` | 改了门槛、写入确认、工具返回：回合基线和八条安全边界的测试 |
| `npm run build:bundle` | 只编组合包到 `dist/fast-ai-cosmic/`（几百毫秒）：改了打包相关的代码、想确认编出来能加载 |
| `npm run dev` | 不打包起桌面窗口（约一分钟；第一次或 `-- --fresh` 要先备打过补丁的 dsh 副本）。改了界面能看到的东西用它看 |
| `npm run build` | 出 Windows 安装包到 `dist/`（十几到几十分钟） |

---

## 六、还没做完的

| 事项 | 现状 |
|---|---|
| 安装包的人工验收 | 装上 exe 后的登录、开工程、跑探针、点确认单、覆盖安装、卸载重装，等用户在界面里测 |
| 首次打开的模型配置 | 新装的 exe 没配模型时停在「请选择模型」，要用户自己去设置 → 模型里登 ChatGPT 或填密钥；没有引导 |
| 设置页登录 ChatGPT 的人工验收 | 请求路径经真网页服务调通过（带登录校验读状态、拒未登录、拒乱写动作）；按钮画出来、点了在浏览器登完回到已登录，等人在 exe 里点 |
| 写元数据的真机验收 | 确认单弹出、等两分钟以上再点、落库和确认单一致，只有假门测试（`test/dsh/write.test.ts`）；真机要在桌面或网页里由人点确认 |
| 改 Java 的真机验收 | 无头只跑过不改代码的那一半（认工程、查影响、真跑业务、列事实、写完成情况）；改业务代码要先问用户 |
| 临时探针写 API 漏网 | 黑名单没列到的写 API 会静默成功。可行的补法：在数据库写方法上加观察点，先只记不拦 |
| 代码关系表认不出的 | 纯注解式自定义 API 的源码侧、少数 `validator` 没有绑定；不影响反查完整性 |
| 生产排障：按字段查数据 | 还要先 `meta` 看表名列名再写 `sql`；按「单据.字段 = 值」直接查没做 |
| 生产排障：数据库种类 | 读取进程只认 PostgreSQL 一族；MySQL、Oracle、SQL Server、达梦没做 |
| 生产排障：monitor 保活 | 没有定时保活：闲置约半小时过期后，下次查日志会再弹验证码框 |
| `@` 引用的人工验收 | 只有假的测试和真机脚本；界面里敲 `@`、Tab 钻、发送、历史画回，等人在 `npm run dev` 窗口里点 |
| 迁移进度 | 计划和进度在 pi 版仓库 `D:\claudecode\pi\cosmic\MIGRATION-DSH.md` |
