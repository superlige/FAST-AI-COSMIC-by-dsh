# fast-ai-cosmic 打包与使用

## 一、出安装包（开发者）

在本仓库目录，用 Node 24：

```powershell
$env:Path = "D:\nodejs24;$env:Path"
npm run build
```

产物：`dist/fast-ai-cosmic-<我们的版本>-dsh-<dsh 版本>-win-x64-unsigned.exe`，约 310 MB。
第一次从头约 20 分钟；调补丁时用 `node scripts/package-desktop.mjs --skip-install` 复用上次的 dsh 副本。

前提：
- 本仓库放在 dsh 检出目录下，dsh 检出目录 `pnpm install` 过；dsh 版本等于 `scripts/package-desktop.mjs` 里的 `DSH_VERSION`；
- 本机装了 Git、pnpm、VS 2022 C++ 生成工具、Windows 11 SDK；
- dsh 副本放在检出目录旁边的 `.cosmic-build/`，不动检出目录本身。

只想确认组合包编出来能用：`npm run build:bundle`（几百毫秒，产物在 `dist/fast-ai-cosmic/`）。

### 开发时不打包，直接起桌面窗口

```powershell
$env:Path = "D:\nodejs24;$env:Path"
npm run dev
```

- 起的就是桌面版窗口（和装好的 exe 一样的界面），不用装；改完代码关掉窗口（托盘里也退出），再 `npm run dev`，约一分钟。
- 第一次要先备好打过补丁的 dsh 副本（十来分钟，自动做）；改了 `scripts/package-desktop.mjs` 的补丁就 `npm run dev -- --fresh`。
- 登录和会话放在 `.cosmic-build/dev-home/`，和装好的 exe 分开，第一次在设置 → 模型的 codex 卡片上点「登录 ChatGPT」（或在会话里 `/cosmic-login`）。
- 只有出给别人用、或要验安装、卸载时才 `npm run build` 打 exe。

### 升 dsh

1. 看 dsh 的 `docs/upgrade-guide/`；
2. dsh 检出目录切到新版本、`pnpm install`；
3. 改 `scripts/package-desktop.mjs` 的 `DSH_VERSION`，`npm run build`；补丁对不上会直接报哪个文件哪句话，逐条改；
4. `npm run check`、无头真机跑一条需求（`scripts/run-headless.ps1`）、装上新安装包冒烟，全过才发。

## 二、安装（用户）

双击 exe。没签名，Windows 可能提示「已保护你的电脑」，点「更多信息」→「仍要运行」。
装在 `%LOCALAPPDATA%\Programs\Fast-AI-COSMIC`，不用管理员权限。覆盖安装就是升级；卸载不删登录、会话和工程配置
（都在 `~/.fast-ai-cosmic` 下：登录、会话、插件、设置在它的 `dsh/` 里）。

和自己另装的 DeepSeek Harness（桌面版或 npm 装的 `dsh` 命令）互不相干，可以同时开：数据目录、插件、登录、会话、
设置、系统协议（`fast-ai-cosmic://`）都各用各的，`DSH_HOME`、`~/.agents` 也不读；要换数据目录用环境变量 `DSH_COSMIC_HOME`。
菜单里没有「管理 dsh 命令」，不会往 PATH 装 `dsh`。

从登录、会话还在 `~/.dsh` 的老版本升上来：第一次打开要重新登录模型，老会话不搬过来（在原版 dsh 里还看得到）。

## 三、使用

1. **登录模型**：默认用 ChatGPT 账号（codex）。打开设置 → 模型，在 codex 那张卡片上点「登录 ChatGPT」，在弹出的浏览器里登录，
   登完自动回来，卡片上显示「已登录」。浏览器没自动回来时，把浏览器地址栏的完整地址粘到卡片上的输入框里提交。
   也可以在会话里输入 `/cosmic-login`。用 DeepSeek 或 Command Code 的模型，在同一页对应的卡片上填 API 密钥。
   没有 DeepSeek 账号登录，左下角就是「设置」按钮。
2. **新建会话**：只有一个「苍穹」，改插件、编译、真跑业务、写元数据和只读查生产都在同一个会话里。
   查生产查到原因，可以接着让它在测试环境改好、验证，不用换会话。会话第一次要查生产时会弹框问「允许 / 不允许」，允许一次，这个会话就不再问。
3. **选工作目录**：会话的工作目录选苍穹工程的根目录。第一次用这个工程时会逐项问
   ISV、模块、启动类、账套、用户（用户按手机号查出来让你选），确认后写进工程的 `.cosmic-ai/config.json`。
   不用先敲命令：模型第一次要用工程时会自己弹出来；也可以先输入 `/cosmic-env` 主动配。
   中途点了「不填了」，这个会话就不再弹，要配时输入 `/cosmic-env`。
4. **生产排障配置**（只有查生产要）：第一次查生产时，没配过会弹出来逐项问；也可以随时输入 `/cosmic-prod-setup`。
   要填的是：
   - 生产库类型（苍穹自带高斯库选 `opengauss`，华为 GaussDB 选 `gaussdb`，PostgreSQL 选 `postgresql`）、主机、端口、库名；
   - **只读**账号和密码（不要填有写权限的账号）；
   - 可选：monitor 地址（形如 `https://<主机>/monitor/eye`）、账号、密码，查生产日志要用，不配也能查库和元数据。
   写之前会用填的账号连一次生产库，连不上会说原因（比如 VPN 没连），可以重填、照样写或不写。
   提问框里的密码看得见明文；只写到本机 `~/.fast-ai-cosmic/prod/prod.json`，不进工程目录，也不发给模型。
   配齐之后再输入 `/cosmic-prod-setup`，可以选重填数据库连接或 monitor 账号。
   每条查询的限时、限行默认 15 秒、500 行，要改就手工在这个文件里加 `"limits": { "timeoutSeconds": 30, "maxRows": 1000 }`。
5. **写元数据**：模型要改字段、表单、打印模板、规则时会先弹确认单，列出要写哪些对象；点「确认写入」才落库，点「不写」就不写。
6. **其他命令**：
   - `/cosmic-jvm`：看本机开着的苍穹进程（几个、占多少内存），`/cosmic-jvm stop <pid>` 停一个；
   - `/cosmic-monitor-login`：登录生产 monitor，验证码图会用看图程序打开，照图输入。
