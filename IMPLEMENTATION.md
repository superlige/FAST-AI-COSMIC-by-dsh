# fast-ai-cosmic 架构与功能

## 一段话看懂

fast-ai-cosmic 是帮人开发金蝶苍穹插件的 AI 助手。它拿 deepseek-harness（下称 dsh，一个通用 AI 编程助手，有网页和桌面界面）当底座，
本仓库做成 dsh 的一个仓库外组合包（不改 dsh 本体的插件包）：给模型加一组 `cosmic_*` 工具，让它能在用户自己的苍穹环境里编译代码、跑"探针"
（一小段 Java，进苍穹进程里查元数据、跑业务、断言结果）、改元数据。
另有生产只读排障：只读地查生产库、生产元数据、monitor 日志，把报错堆栈对到本地源码，出一份每条结论都标了证据编号的诊断报告。

**现在本仓库里只有内核**（真正干活的命令、探针、知识库、运行时）；接 dsh 的那层（工具注册、执行前门槛、系统提示、技能提供方、
写元数据前的确认单）还没写。所以现在不能让模型用，只能用脚本直接调内核（见第四节）。

这份文件只写**现在是什么样**。写法规矩见 `AGENTS.md` 第二节。

---

## 一、架构

### 1.1 一次调用走过哪几层

```
（接 dsh 的那层，还没写）
  └─ src/kernel/commands/*.ts        真正干活的命令（编译、跑探针、run、impact、meta、prod……）
      ├─ src/kernel/policy/          安全闸：写 API 黑名单、工程写锁、共享写入准入、外部动作识别
      ├─ src/kernel/probe/server.ts  常驻苍穹 JVM：起、认归属、发请求、收结果
      │    └─ resources/runtime/CosmicProbeServer.java 等   JVM 里的宿主
      │         └─ resources/probes/*.java               各个探针（查元数据、仿真表单、跑操作……）
      ├─ src/kernel/prod/            生产只读排障
      └─ src/knowledge/              官方知识库、技能文档、插件族识别、知识门禁
```

内核不认识 dsh，也不认识模型：它只收参数、回结构化结果。调用方先用 `openProject`（`src/kernel/open-project.ts`）认工程、
算出 RuntimeKey、释放内嵌资源，拿到上下文（`KernelContext`）再调各命令。

### 1.2 目录表

| 目录 / 文件 | 里面是什么 |
|---|---|
| `src/brand.ts` | 产品名。对外叫 `fast-ai-cosmic`；`cosmic_*` 工具名、`COSMIC_*` 环境变量是内部稳定名字，不随品牌改 |
| `src/agent/tools/` | 现在只有工具名清单（`names.ts`）和技能文档分块（`prose-blocks.ts`），知识库的测试要用；接 dsh 那层写进这里 |
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
| `src/runtime/` | 运行时身份 RuntimeKey（工程 + JDK + 苍穹 JAR + cosmic 版本合成的一个指纹，缓存和常驻进程都按它分开）、缓存、内嵌资源释放、发行物审计 |
| `src/resources/embedded.generated.ts` | 自动生成：`resources/` 打进程序里的副本。不要手改 |
| `src/manifest/`、`manifests/` | 最早从老仓库迁移时的冻结记录，平时不用动 |
| `resources/probes/` | 已发布探针（Java）。探针文件头写着用法 |
| `resources/runtime/` | 苍穹 JVM 里的宿主：`CosmicProbeServer.java` 常驻服务、`CosmicProbe.java` 冷进程、`HeadlessViews.java` 免界面视图 |
| `resources/tools/` | 反射查平台类签名（`ApiTool.java`）、源码索引（`SrcIndexTool.java`）、生产只读读取进程（`ProdReader.java`，只装 JDBC 驱动，不加载苍穹平台） |
| `knowledge/reference/*.md` | **技能文档**：发给模型按需读的参考（30 篇） |
| `knowledge/reference.pack`、`knowledge/cosmic-kb.pack` | 自动生成：技能文档包、官方知识库包。不要手改 |
| `scripts/` | 导出（`export-*.mjs`）、真机验证（`verify-*.ts`）、测量（`measure-*`）、清单（`checklists/`）。每个脚本文件头写着用法 |
| `test/` | 按 `src/` 同名分目录；`test/security/prod-readonly.test.ts` 是生产只读闸绕不绕得过去的回归；`test/manifest/` 管文档体量和不依赖 pi |

### 1.3 程序跑起来后文件放在哪

| 位置 | 放什么 | 能不能删 |
|---|---|---|
| `<工程>/.cosmic-ai/config.json` | 工程级配置（账套、用户、ISV 等），压过全局那份 | 不能，用户配的 |
| `<工程>/.cosmic-ai/probes/` | 模型写的临时探针 | 可以 |
| `<工程>/.cosmic-ai/evidence/` | 运行记录 `assertions/`、它们引用的运行日志；生产查询流水账 `prod-audit.jsonl`；诊断报告 `diagnosis/` | 删了就丢证据 |
| `<工程>/.cosmic-ai/work/` | 代码关系表 `impact.json`、落盘的长输出、写锁；生产排障拉回的元数据原文和摘要 `prod/meta/`、查询结果 `prod/sql/`、日志全文 `prod/logs/` | 能重建 |
| `<工程>/build/cosmic-pathing.jar`、`cosmic-javac.args` | 工程自己 gradle 产出的编译参数 | 能重建（`build` 命令） |
| `~/.fast-ai-cosmic/config.json` | 全局配置 | — |
| `~/.fast-ai-cosmic/cache/<RuntimeKey>/` | 编好的探针 class、常驻 JVM 的进程号和日志 `probe-server.log`、上一次探针输出 `last-probe.out`、每次运行的日志 `probe-runs/`；生产读取进程的状态和日志 `prod/` | 能重建 |
| `~/.fast-ai-cosmic/prod/prod.json` | 生产只读排障配置：生产库只读账号、monitor 账号、每条查询限时限行 | 不能，用户配的；含凭据，不进工程目录 |
| `~/.fast-ai-cosmic/prod/prod.monitor-session.json` | monitor 登录后的会话（闲置约半小时过期） | 可以，删了重新登录 |

---

## 二、功能表

### 2.1 内核命令

| 命令 | 做什么 | 代码 | 技能文档 |
|---|---|---|---|
| 认工程 | 认工程、JDK、苍穹 JAR，算出 RuntimeKey，释放内嵌资源 | `kernel/open-project.ts`、`kernel/config/` | `runtime.md` |
| `lint` | 用用户的苍穹 JAR 编译检查、不留 class，返回结构化报错 | `kernel/commands/lint.ts`、`kernel/diag/javac.ts` | `lint.md` |
| `fast` | 编译改过的业务类；插件类先过知识门禁；常驻 JVM 下次用前热替换（结构变了才重启） | `kernel/commands/fast.ts`、`knowledge/plugin-gate.ts` | `lint.md`、`plugin-dev.md` |
| `probe` | 跑已发布探针，或跑模型写的只读临时探针（编译前查签名、扫写 API） | `kernel/commands/probe.ts`、`kernel/policy/{probe-scan,write-apis,api-precheck}.ts` | `probes.md`、`sdk.md` |
| `run` | 免界面真跑业务（测试环境真提交）：`op` 操作、`form` 表单、`list` 列表、`callback`/`flow` 父子页面、`rule` 规则、`print` 打印、`call` 直调方法、`push` 转换下推、`wf` 工作流；带 `--expect` 断言，每次落一份运行记录 | `kernel/commands/run.ts`、`knowledge/run-adapter.ts`、`kernel/verify/`、`resources/probes/*Sim.java` | `run.md`、`run-parent-child.md`、`plugin-print-runtime.md`、`workflow.md` |
| `impact` | 代码关系表反查：字段的读写处、类 / 单据 / 布局挂了哪些插件和规则 | `kernel/commands/impact.ts`、`kernel/impact/` | `impact.md` |
| `meta` | 读写非实体元数据：表单布局、字段、规则、BOTP 转换、打印模板、工作流、公式函数查询；写入先预演 | `kernel/commands/meta.ts`、`kernel/meta/`、`kernel/policy/{write-plan,shared-write}.ts` | `meta-cmd.md`、`metadata-*.md`、`print-template*.md` |
| `probe-server`、`node`、`deploy` | 常驻探针 JVM 和本地调试节点的启停、状态、日志；把代码 jar 部到运行时 | `kernel/commands/{probe-server,node,deploy}.ts`、`kernel/probe/server.ts` | `runtime.md` |
| `doctor`、`build` | 工程体检（每项配置值和出处）；重建编译参数、代码关系表、查和回收写锁 | `kernel/commands/{doctor,build}.ts` | `runtime.md` |
| `knowledge` | 查官方知识库、场景表、平台类签名、已发布探针清单、插件开发流程 | `kernel/commands/knowledge.ts`、`knowledge/`、`kernel/api-tool.ts` | `official-knowledge.md`、`plugin-*.md` |
| `prod` | 生产只读排障：`status`、`sql` 一条只读查询、`meta` 生产元数据摘要和比对、`log` monitor 日志分组并对源码、`report` 诊断报告 | `kernel/commands/prod.ts`、`kernel/prod/`、`resources/tools/ProdReader.java` | `runtime-traces.md` |

### 2.2 贯穿各命令的机制

| 机制 | 做什么 | 代码 |
|---|---|---|
| 临时探针只读 | 写 API 黑名单 + 源码扫描；没查过签名的平台调用先拦下 | `kernel/policy/{write-apis,probe-scan,api-precheck}.ts` |
| 写元数据 | 先预演（dry-run）→ 落库 → 回读；在常驻进程里写，写完马上读得到 | `kernel/policy/{write-plan,shared-write,write-form}.ts` |
| 造数改数 | 新建、照现成复制、从上游下推、改值报原值新值；整批一个事务，回读才算写成 | `resources/probes/Data{Seed,Update}Probe.java` |
| 工程写锁 | 编译和写环境跨进程排队；崩溃残留要点名回收 | `kernel/policy/{project-write-lock,write-lock-recovery}.ts` |
| 生产只读通道 | 三道闸：语句闸（只放行单条 select/with，拒写、拒改会话、拒加锁，函数只放行白名单）、会话只读、每条查询在只读事务里跑完回滚；读取进程不加载苍穹平台；每次调用记流水账 | `kernel/prod/{sql-guard,reader}.ts`、`resources/tools/ProdReader.java` |
| 常驻 JVM | 按 RuntimeKey 一个；认不出是自己的就降级冷进程，从不按端口杀；停进程要等它真退，等不到核对后强制结束 | `kernel/probe/{server,protocol,health,local-jvms}.ts`、`resources/runtime/CosmicProbeServer.java` |
| 编译参数重写 | Windows 上重写 pathing jar 前先停自己的常驻 JVM（它锁着这个文件） | `kernel/toolchain.ts` |
| 探针输出 | 结构化记录走 `[PROBE-JSON]` 行，给人看的走文字；长输出全文落盘可取回 | `kernel/probe/{output,stash}.ts` |
| 运行记录 | 每次带断言的 `run` 落一份：参数、断言结果、当时的源码指纹和 RuntimeKey、写了哪些表；带摘要，改过的记录认得出 | `kernel/verify/{evidence,grade}.ts` |
| 知识门禁 | 写插件前必须读过对应插件族的知识卡片 | `knowledge/{plugin-base,plugin-gate,capsule}.ts` |
| 技能文档 | `knowledge/reference/*.md` 打包成 `reference.pack`，模型按需读 | `knowledge/reference.ts`、`scripts/export-reference.mjs` |
| 写法检查 | 插件写法规则 | `kernel/style/` |
| 发行物审计 | 产物里不许有苍穹 JAR、客户配置、凭据 | `runtime/release-audit.ts` |

---

## 三、要改什么，去哪改

| 要做的事 | 改哪里 | 同一轮还要做 |
|---|---|---|
| 改某个命令的行为 | `src/kernel/commands/<命令>.ts` | 对应技能文档、`test/kernel/` 加用例 |
| 给 `run` 加子命令或参数 | `src/kernel/commands/run.ts`（`planRun` 是纯函数：参数 → 探针名 + 环境变量）、`src/knowledge/run-adapter.ts`、对应 `resources/probes/*Sim.java` | `run.md`；`run help` 的用法文字 |
| 加 / 改已发布探针 | `resources/probes/` 下的 Java，文件头写用法；只读且只碰平台的探针登记到 `src/kernel/policy/probe-freshness.ts` 的 `PLATFORM_PROBES` | `node scripts/export-resources.mjs --write`；`probes.md` |
| 改技能文档 | `knowledge/reference/*.md` | `node scripts/export-reference.mjs --write` |
| 临时探针新增一类禁用写 API | `src/kernel/policy/write-apis.ts` | `test/kernel/` 加用例 |
| 写元数据新增一类 | `src/kernel/policy/write-plan.ts` 声明、`write-form.ts` 确认单表单、对应写探针 | `metadata-write.md` |
| 代码关系表扫什么 | `resources/probes/PluginIndexProbe.java`、`src/kernel/impact/model.ts` | `impact.md` 里"扫了哪些表"那段 |
| 配置项 / 环境变量 | `src/kernel/config/load-config.ts`、`src/kernel/context.ts`（`FORWARDED_ENV_KEYS`） | — |
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
| 常驻 JVM 起不来、卡住、多起了一个 | `cache/<RuntimeKey>/probe-server.log` | `scripts/measure-resident-start-race.ts`、`measure-resident-start.ts` |
| 某一步特别慢 | — | 时间花在哪：`measure-probe-call.ts`；JVM 里在忙什么：`measure-jvm-stacks.mjs`；数据库连接：`measure-sql-stalls.mjs`、`measure-idle-stall.ts`；新起进程：`measure-resident-start.ts` |
| 改了元数据，进程读到的还是旧的 | 是不是在苍穹设计器手工改的（那种要手动重起常驻） | `probe-server` 重启常驻 |
| 运行记录写库表不对 | `<工程>/.cosmic-ai/evidence/assertions/` 下那条记录 | `measure-run-writes.ts` |
| 生产查询报错、读取进程起不来 | `prod status` 的返回；`cache/<RuntimeKey>/prod/prod-reader.log` | 连不上先确认 VPN；配置在 `~/.fast-ai-cosmic/prod/prod.json` |
| 生产排障查了什么、查了几行、多久 | `<工程>/.cosmic-ai/evidence/prod-audit.jsonl`（被拒的语句也在） | — |

脚本都在 `scripts/`，用法写在每个脚本的文件头。测量脚本只跑只读探针，不会改真机数据（个别会重起本版本自己的常驻进程，文件头写着）。

### 4.2 真机复现

不经模型、直接调内核：

```bash
export PATH="/d/nodejs24:$PATH"
cd D:/kingdee/zlgd_ygpt2.0
node --experimental-strip-types D:/claudecode/deepseekharness/deepseek-harness/cosmic/scripts/verify-real-env.ts D:/kingdee/zlgd_ygpt2.0 open
#   … fast <文件> | probe MetaProbe META_ENTITY=bos_user | run op <单据> <操作> --pk <内码> --expect success=true | stop
```

能做什么、要先问什么，见 `AGENTS.md` 第三节。单项机制有现成的真机验证脚本 `scripts/verify-*.ts`，按文件名找。

---

## 五、检查

| 命令 | 什么时候跑 |
|---|---|
| `npm run check` | 任何改动后：类型检查 + 代码风格 + 全部测试。技能文档或探针改了没重新生成也会在这里失败 |
| `npm run resources:export -- --write` | 改了 `resources/` 下的探针、宿主、工具 |
| `npm run reference:export -- --write` | 改了 `knowledge/reference/*.md` |

---

## 六、还没做完的

| 事项 | 现状 |
|---|---|
| 接 dsh 的那层 | 工具注册、执行前门槛、返回整理、系统提示段、命令、技能提供方、写元数据确认单都还没有；做法见迁移计划阶段 2 |
| 发给模型的文字里还有旧机制 | 内核和技能文档里还有讲交付回执、`cosmic_verify finish`、`cosmic_authorize`、`preflight` 的句子（`run` 的返回、写入准入的提示、`command-map.ts`、`names.ts`、技能文档 `verify.md`、`metadata-write.md` 等）；随接 dsh 那层一起改 |
| 没搬过来的脚本 | 读会话记录的测量脚本、用到返回整理层的真机验证脚本、`verify:eval`、`verify:rounds` 还在 pi 版仓库；分别随迁移计划阶段 2、3 搬 |
| 临时探针写 API 漏网 | 黑名单没列到的写 API 会静默成功。可行的补法：在数据库写方法上加观察点，先只记不拦 |
| 代码关系表认不出的 | 纯注解式自定义 API 的源码侧、少数 `validator` 没有绑定；不影响反查完整性 |
| 生产排障：按字段查数据 | 还要先 `meta` 看表名列名再写 `sql`；按「单据.字段 = 值」直接查没做 |
| 生产排障：数据库种类 | 读取进程只认 PostgreSQL 一族；MySQL、Oracle、SQL Server、达梦没做 |
| 迁移进度 | 计划和进度在 pi 版仓库 `D:\claudecode\pi\cosmic\MIGRATION-DSH.md` |
