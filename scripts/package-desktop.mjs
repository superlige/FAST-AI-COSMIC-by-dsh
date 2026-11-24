#!/usr/bin/env node
/**
 * 出 Windows 桌面安装包：dsh 桌面版 + 预装的 fast-ai-cosmic 组合包，一个不签名的 exe。
 *
 * 用法：node scripts/package-desktop.mjs [--work <构建目录>] [--skip-install]
 *   --work         dsh 副本放哪，默认 dsh 检出目录旁边的 .cosmic-build（不能在 dsh 检出目录里面）
 *   --skip-install 副本和依赖已经在了，只重新套补丁、出包（调补丁时省十分钟）
 *   --prepare-only 只备好副本（编组合包、套补丁、装依赖），不出包；scripts/dev-desktop.mjs 用它
 *
 * 步骤：
 *   1. 编组合包（scripts/build-bundle.mjs，版本号用 dsh 的：dsh 只打和自己同版本号的模块）；
 *   2. 把 dsh 检出目录 git clone --local 到构建目录，核对版本是不是 DSH_VERSION；
 *   3. 在副本上套补丁（下面的 PATCHES，每条核对原文出现次数，dsh 改了原文就失败，不悄悄漏改）；
 *   4. pnpm install，再调 dsh 自己的不签名打包，打包配置用 packaging/presets/production.env；
 *   5. 安装包拷到本仓库 dist/，文件名带我们的版本号和所用的 dsh 版本号。
 *
 * 不改 dsh 检出目录本身：补丁只套在副本上。升 dsh：改 DSH_VERSION → 重跑本脚本，补丁对不上的逐条改。
 * 出包前提（本机已装）：Node 24、pnpm、Git、VS 2022 C++ 生成工具、Windows 11 SDK。
 * 解包用系统自带的 tar.exe：Git Bash 的 GNU tar 把 D:\… 当成远程主机，解包会失败。
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DESKTOP_ISOLATION, dshSourceFiles, findSharedDshPaths } from "./desktop-isolation.ts";
import { stageDesktopBundle } from "./stage-desktop-bundle.ts";

/** 这套补丁对过的 dsh 版本。 */
const DSH_VERSION = "0.2.2-rc.2";
const NAME = "Fast-AI-COSMIC";
const PKG = "fast-ai-cosmic";
const PUBLISHER = "Fast-AI";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checkout = resolve(repo, "..");
const args = process.argv.slice(2);
const flag = (name) => {
	const at = args.indexOf(`--${name}`);
	return at >= 0 ? args[at + 1] : undefined;
};
const work = resolve(flag("work") ?? join(checkout, "..", ".cosmic-build"));
const skipInstall = args.includes("--skip-install");
const prepareOnly = args.includes("--prepare-only");
const copy = join(work, "dsh");
if (
	copy.toLowerCase().startsWith(`${checkout.toLowerCase()}\\`) ||
	copy.toLowerCase().startsWith(`${checkout.toLowerCase()}/`)
)
	throw new Error(`构建目录不能在 dsh 检出目录里面：${copy}`);

const manifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
const started = Date.now();
const step = (text) => console.log(`[${String(Math.round((Date.now() - started) / 1000))}s] ${text}`);

// 子进程的 PATH：系统目录放最前（用 Windows 的 tar.exe），Node 24 紧跟其后
const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
const env = {
	...process.env,
	PATH: [join(systemRoot, "System32"), dirname(process.execPath), process.env.PATH ?? ""].join(";"),
};
function run(command, argv, cwd, extra = {}) {
	execFileSync(command, argv, {
		cwd,
		stdio: "inherit",
		env: { ...env, ...extra },
		shell: process.platform === "win32",
	});
}

// ── 1. 编组合包 ──
const dshVersion = JSON.parse(readFileSync(join(checkout, "apps/cli/package.json"), "utf8")).version;
if (dshVersion !== DSH_VERSION)
	throw new Error(`dsh 检出目录是 ${dshVersion}，补丁对的是 ${DSH_VERSION}：先按升 dsh 的流程把补丁重对一遍`);
step(`编组合包（版本号 ${dshVersion}）`);
run(process.execPath, [join(repo, "scripts/build-bundle.mjs"), "--version", dshVersion], repo);
const bundle = join(repo, "dist", PKG);

// ── 2. 副本 ──
if (!skipInstall || !existsSync(copy)) {
	step(`复制 dsh 到 ${copy}`);
	rmSync(copy, { recursive: true, force: true });
	mkdirSync(work, { recursive: true });
	run("git", ["clone", "--local", "--quiet", checkout, copy], work);
	// 桌面打包的下载缓存（Electron、NSIS、运行时）和 pnpm 包缓存：检出目录出过包就有，拷过来省得重下
	for (const cache of ["downloads", "pnpm-store"]) {
		const from = join(checkout, "apps/desktop/.desktop-build", cache);
		if (existsSync(from)) cpSync(from, join(copy, "apps/desktop/.desktop-build", cache), { recursive: true });
	}
} else {
	step("复用副本：还原到干净状态再套补丁");
	run("git", ["checkout", "-q", "--", "."], copy);
	rmSync(join(copy, "packages", "cosmic"), { recursive: true, force: true });
}
const copyVersion = JSON.parse(readFileSync(join(copy, "apps/cli/package.json"), "utf8")).version;
if (copyVersion !== DSH_VERSION)
	throw new Error(`副本版本 ${copyVersion} ≠ ${DSH_VERSION}（检出目录有没提交的版本改动？）`);

// ── 3. 补丁 ──
const report = [];
function edit(group, rel, pairs) {
	const file = join(copy, rel);
	let text = readFileSync(file, "utf8");
	let lines = 0;
	for (const [from, to, expected = 1] of pairs) {
		const count = text.split(from).length - 1;
		if (count !== expected)
			throw new Error(`${rel}：应有 ${String(expected)} 处 ${JSON.stringify(from)}，实有 ${String(count)}`);
		text = text.split(from).join(to);
		lines += count;
	}
	writeFileSync(file, text);
	report.push({ group, file: rel, replacements: lines });
}
function editEvery(group, rel, from, to) {
	const count = readFileSync(join(copy, rel), "utf8").split(from).length - 1;
	if (count === 0) throw new Error(`${rel}：没有 ${JSON.stringify(from)}`);
	edit(group, rel, [[from, to, count]]);
}

step("套补丁");
// 预装：组合包作为 dsh 的一个模块打进安装包，桌面版新建配置时默认挂上
const target = join(copy, "packages", "cosmic", PKG);
stageDesktopBundle(bundle, target);
report.push({ group: "预装", file: `packages/cosmic/${PKG}/（新增）`, replacements: 0 });
// dsh 打包只认 @deepseek-ai 名下的模块；放行这一个名字
edit("预装", "scripts/release/families.ts", [
	[
		"if (!name.startsWith('@deepseek-ai/')) throw",
		`if (!name.startsWith('@deepseek-ai/') && name !== '${PKG}') throw`,
	],
]);
edit("预装", "apps/cli/package.json", [['"dependencies": {', `"dependencies": {\n    "${PKG}": "workspace:*",`]]);
edit("预装", "packages/util/official-bundles/src/bundles.ts", [
	[
		"web: {\n    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],",
		`web: {\n    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '${PKG}'],`,
	],
]);
// 首次启动用模板，覆盖安装还要给已有的桌面配置补上内置组合包。
const desktopProfile = "apps/desktop/src/cosmic-desktop-profile.ts";
cpSync(join(repo, "scripts", "desktop-profile.ts"), join(copy, desktopProfile));
report.push({ group: "预装", file: `${desktopProfile}（新增）`, replacements: 0 });
edit("预装", "apps/desktop/src/project-manager.ts", [
	[
		"import { initProfile, removeLinkProjections, sanitizeProfile } from '@deepseek-ai/dsh-app-boot'",
		"import { initProfile, readProfileManifest, removeLinkProjections, sanitizeProfile, writeProfileBundles } from '@deepseek-ai/dsh-app-boot'\n" +
			"import { withCosmicDesktopBundle } from './cosmic-desktop-profile.ts'",
	],
	[
		"  initProfile(projectDir, WEB_PROFILE.bundles)\n}",
		"  initProfile(projectDir, WEB_PROFILE.bundles)\n" +
			"  const manifest = readProfileManifest('dsh', projectDir)\n" +
			"  const bundles = manifest.dsh?.profile?.bundles\n" +
			"  const updated = withCosmicDesktopBundle(bundles)\n" +
			"  if (updated !== undefined && updated !== bundles) writeProfileBundles(projectDir, manifest, updated)\n}",
	],
]);
// 插件页里不显示、删不掉
edit("预装", "packages/util/official-bundles/src/plugin-manager.ts", [
	[
		"export const HIDDEN_BUNDLES: ReadonlySet<string> = new Set([\n",
		`export const HIDDEN_BUNDLES: ReadonlySet<string> = new Set([\n  '${PKG}',\n`,
	],
]);

// 隔离：和用户另装的 dsh 不共用任何东西（为什么见 scripts/desktop-isolation.ts 文件头）。
// 数据目录：所有程序都经 home-paths 这一处找 ~/.dsh、~/.agents 和两个环境变量，改这里就整体搬走。
const iso = DESKTOP_ISOLATION;
edit("隔离", "packages/util/home-paths/src/index.ts", [
	["export const DSH_HOME_DIR_NAME = '.dsh'", `export const DSH_HOME_DIR_NAME = '${iso.homeDir}'`],
	["export const DSH_HOME_ENV = 'DSH_HOME'", `export const DSH_HOME_ENV = '${iso.homeEnv}'`],
	["export const AGENTS_HOME_DIR_NAME = '.agents'", `export const AGENTS_HOME_DIR_NAME = '${iso.agentsDir}'`],
	["export const AGENTS_HOME_ENV = 'DSH_AGENTS_HOME'", `export const AGENTS_HOME_ENV = '${iso.agentsEnv}'`],
]);
// 插件市场里能装的一个实验插件自己拼了 ~/.dsh
edit("隔离", "packages/experimental/liveshare/src/host/share-host.ts", [
	[
		"nonEmpty(process.env.DSH_HOME) ?? join(homedir(), '.dsh')",
		`nonEmpty(process.env.${iso.homeEnv}) ?? join(homedir(), '${iso.homeDir}')`,
	],
]);
editEvery(
	"隔离",
	"packages/client/ui-settings-models/src/client/locales.ts",
	"$DSH_HOME/.env",
	`~/${iso.homeDir}/.env`,
);
// 卸载程序认数据目录的环境变量，免得删到它
edit("隔离", "apps/desktop/installer/uninstall.nsh", [
	["ReadEnvStr $UnHome DSH_HOME", `ReadEnvStr $UnHome ${iso.homeEnv}`],
]);
// npm run dev：dsh 的开发启动把 DSH_HOME 传给窗口，补传改名后的那个，开发窗口仍用 dev-home
// 出包时 dsh 自己的冒烟把数据目录指到临时目录，也补传一个，不然它在临时目录建的配置找不到
edit("隔离", "apps/desktop/scripts/smoke-runtime.ts", [
	["    DSH_HOME: home, HOME: home,", `    DSH_HOME: home, ${iso.homeEnv}: home, HOME: home,`],
]);
edit("隔离", "apps/desktop/scripts/dev.ts", [
	["    DSH_HOME: home,\n", `    DSH_HOME: home,\n    ${iso.homeEnv}: home,\n`],
]);
// 系统协议名
edit("隔离", "apps/desktop/src/main.ts", [
	["app.setAsDefaultProtocolClient('dsh')", `app.setAsDefaultProtocolClient('${iso.scheme}')`],
	[
		"if (url === 'dsh://open' || url === 'dsh://open/')",
		`if (url === '${iso.scheme}://open' || url === '${iso.scheme}://open/')`,
	],
	// 菜单里「管理 dsh 命令」会往 PATH 装一个叫 dsh 的命令，盖掉用户自己装的 dsh
	[
		"...process.platform === 'darwin' || process.platform === 'win32'\n      ? [{ label: currentDesktopLocale().messages.cliCommandMenu,",
		"...false\n      ? [{ label: currentDesktopLocale().messages.cliCommandMenu,",
	],
]);
// 安装包的包名：卸载程序按它删 %APPDATA%\@deepseek-ai\dsh-desktop 和 %LOCALAPPDATA%\<包名>-updater，
// 不改就和原版 dsh 是同一个名字，卸载我们会删到原版的。界面名、设置目录跟的是 productName，不受影响。
edit("隔离", "apps/desktop/scripts/electron-builder-config.mjs", [
	[
		"    extraMetadata: {\n      dshDesktopAppId: appId,",
		`    extraMetadata: {\n      name: '${PKG}-desktop',\n      dshDesktopAppId: appId,`,
	],
]);
const leftovers = findSharedDshPaths(dshSourceFiles(copy));
if (leftovers.length > 0)
	throw new Error(
		`还有 ${String(leftovers.length)} 处在用 dsh 默认的数据目录、环境变量或协议名，补丁要跟上：\n${leftovers.join("\n")}`,
	);
report.push({
	group: "隔离",
	file: "（扫 apps、packages 源码：没有剩下读 ~/.dsh、DSH_HOME、dsh:// 的）",
	replacements: 0,
});

// 品牌：桌面壳、安装程序
edit("品牌-壳", "apps/desktop/scripts/electron-builder-config.mjs", [
	[
		"protocols: [{ name: 'DeepSeek Harness', schemes: ['dsh'] }]",
		`protocols: [{ name: '${NAME}', schemes: ['${iso.scheme}'] }]`,
	],
	["productName: 'DeepSeek Harness',", `productName: '${NAME}',`],
	["artifactName: `deepseek-harness-", `artifactName: \`${PKG}-${manifest.version}-dsh-`],
]);
edit("品牌-壳", "apps/desktop/package.json", [
	['"name": "Hangzhou DeepSeek Artificial Intelligence Co., Ltd."', `"name": "${PUBLISHER}"`],
]);
edit("品牌-壳", "apps/desktop/scripts/smoke-packaged-runtime.ts", [
	["join(application, 'DeepSeek Harness.exe')", `join(application, '${NAME}.exe')`],
]);
edit("品牌-壳", "apps/desktop/src/main.ts", [["applicationName: 'DeepSeek Harness',", `applicationName: '${NAME}',`]]);
editEvery("品牌-壳", "apps/desktop/src/locale.ts", "DeepSeek Harness", NAME);
for (const file of readdirSync(join(copy, "apps/desktop/installer/locales")).filter((f) => f.endsWith(".json")))
	editEvery("品牌-安装程序", `apps/desktop/installer/locales/${file}`, "DeepSeek Harness", NAME);
// 安装程序原生窗口里写死的标题（重启提示、解包失败报告）
for (const file of ["extract-report.h", "restart-banner.h", "restart-status.h"])
	editEvery("品牌-安装程序", `apps/desktop/installer/${file}`, 'L"DeepSeek Harness', `L"${NAME}`);

// 品牌：界面里插件够不着的文字（同一界面字典不许注册两次，插件改不了）
for (const file of readdirSync(join(copy, "packages/client/locale/src/locales")).filter((f) =>
	/^[a-z]{2}\.ts$/.test(f),
)) {
	const rel = `packages/client/locale/src/locales/${file}`;
	const found = readFileSync(join(copy, rel), "utf8").match(/'brand\.localBuild': ('[^']*'|"[^"]*"),/);
	if (found === null) throw new Error(`${rel}：没有 brand.localBuild`);
	edit("品牌-界面", rel, [[found[0], `'brand.localBuild': '${NAME}',`]]);
}
edit("品牌-界面", "packages/client/ui-conversation/src/client/locales.ts", [
	["'hero.headline': '探索未至之境',", "'hero.headline': '金蝶云·苍穹开发智能体',"],
	["'hero.headline': 'Into the Unknown',", "'hero.headline': 'Kingdee Cosmic Dev Agent',"],
]);
edit("品牌-界面", "packages/client/ui-chat/src/client/locale.ts", [
	["'chat.deepDiving': '深度求索中',", "'chat.deepDiving': '思考中',"],
	["'chat.deepDivingFor': '深度求索中，用时 {duration} ···',", "'chat.deepDivingFor': '思考中，用时 {duration} ···',"],
]);
edit("品牌-界面", "packages/client/web/src/boot-page.ts", [
	["div(css.wordmark, 'HARNESS')", "div(css.wordmark, 'COSMIC')"],
]);
edit("品牌-界面", "packages/api/workspace-controller/src/default-directory.ts", [
	[
		"paths.join(directory, 'deepseek-harness', DEFAULT_WORKSPACE_DIRECTORY)",
		`paths.join(directory, '${PKG}', DEFAULT_WORKSPACE_DIRECTORY)`,
	],
]);

// 欢迎页：不弹 DeepSeek 账号欢迎页，没配模型就进主界面，在设置里配或用 /cosmic-login 登 codex
edit("欢迎页", "apps/desktop/src/welcome-api.ts", [
	[
		"return !authentication.loggedIn && !authentication.hasApiKey",
		"return false && !authentication.loggedIn && !authentication.hasApiKey",
	],
]);

// 图标：终端 + iOS。深色圆角方块里一个终端提示符「❯▌」：银白的箭头、发青绿光的块状光标（pi 版首页那个光标），
// 和界面侧栏的标志同一个图形（client/brand.js 的 LogoSvg，改一边要改另一边）。
// 底上淡淡几道扫描线；高光只在上下两条边，外沿一圈很淡的暗边。圆角取边长的 22.37%。
// sharp 用 dsh 检出目录装好的那份，副本这时还没装依赖
const sharp = createRequire(join(checkout, "apps/desktop/package.json"))("sharp");
const SCANLINES = Array.from(
	{ length: 14 },
	(_, at) =>
		`<rect x="0" y="${(2.2 + at * 1.5).toFixed(1)}" width="24" height="0.35" fill="#ffffff" fill-opacity="0.025"/>`,
).join("");
const MARK = `<defs>
    <linearGradient id="cx-bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2B2F33"/><stop offset="0.6" stop-color="#121518"/><stop offset="1" stop-color="#090B0C"/></linearGradient>
    <radialGradient id="cx-bloom" cx="63%" cy="50%" r="40%"><stop offset="0" stop-color="#70E2D0" stop-opacity="0.38"/><stop offset="1" stop-color="#70E2D0" stop-opacity="0"/></radialGradient>
    <linearGradient id="cx-chevron" gradientUnits="userSpaceOnUse" x1="0" y1="7" x2="0" y2="17"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#BFC8C6"/></linearGradient>
    <linearGradient id="cx-cursor" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#C8FFF5"/><stop offset="1" stop-color="#46C7B2"/></linearGradient>
    <linearGradient id="cx-edge" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity="0.32"/><stop offset="0.05" stop-color="#ffffff" stop-opacity="0"/><stop offset="0.96" stop-color="#ffffff" stop-opacity="0"/><stop offset="1" stop-color="#ffffff" stop-opacity="0.12"/></linearGradient>
  </defs>
  <rect width="24" height="24" rx="5.37" fill="url(#cx-bg)"/>
  ${SCANLINES}
  <rect width="24" height="24" rx="5.37" fill="url(#cx-bloom)"/>
  <path d="M7.2 8.4 10.8 12l-3.6 3.6" fill="none" stroke="#000000" stroke-opacity="0.45" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" transform="translate(0 0.4)"/>
  <path d="M7.2 8.4 10.8 12l-3.6 3.6" fill="none" stroke="url(#cx-chevron)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="13.2" y="8.3" width="3.8" height="7.4" rx="0.8" fill="url(#cx-cursor)"/>
  <rect x="13.6" y="8.55" width="3" height="0.35" rx="0.17" fill="#ffffff" fill-opacity="0.7"/>
  <rect width="24" height="24" rx="5.37" fill="url(#cx-edge)"/>
  <rect x="0.125" y="0.125" width="23.75" height="23.75" rx="5.27" fill="none" stroke="#000000" stroke-opacity="0.3" stroke-width="0.25"/>`;
const svg = (size) =>
	Buffer.from(
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}">${MARK}</svg>`,
	);
/** 标放在 (x, y)，边长 size。 */
const mark = (x, y, size) => `<g transform="translate(${x} ${y}) scale(${size / 24})">${MARK}</g>`;
const resources = join(copy, "apps/desktop/resources");
await sharp(svg(1024)).png().toFile(join(resources, "icon-windows.png"));
await sharp(svg(1104)).png().toFile(join(resources, "icon.png"));
const pngs = await Promise.all(
	[16, 24, 32, 48, 64, 256].map(async (size) => ({ size, buf: await sharp(svg(size)).png().toBuffer() })),
);
const header = Buffer.alloc(6 + 16 * pngs.length);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(pngs.length, 4);
let offset = header.length;
pngs.forEach(({ size, buf }, index) => {
	const at = 6 + 16 * index;
	header.writeUInt8(size >= 256 ? 0 : size, at);
	header.writeUInt8(size >= 256 ? 0 : size, at + 1);
	header.writeUInt16LE(1, at + 4);
	header.writeUInt16LE(32, at + 6);
	header.writeUInt32LE(buf.length, at + 8);
	header.writeUInt32LE(offset, at + 12);
	offset += buf.length;
});
writeFileSync(join(resources, "tray-windows.ico"), Buffer.concat([header, ...pngs.map((p) => p.buf)]));
report.push({
	group: "品牌-图标",
	file: "apps/desktop/resources/{icon-windows.png,icon.png,tray-windows.ico}（替换）",
	replacements: 3,
});

// 安装程序的图：顶部品牌图（浅色、深色各两种尺寸，透明底，安装程序再垫白底或 (21,21,23) 底）、卸载侧边图。
// 原图是鲸鱼和 deepseek 字样；尺寸照原图，安装程序按尺寸排版
const installerAssets = join(copy, "apps/desktop/installer/assets");
const font = "Segoe UI, Microsoft YaHei, Arial, sans-serif";
const brand = (scale, dark) => {
	const ink = dark ? "rgb(244,244,248)" : "rgb(22,22,28)";
	return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${600 * scale}" height="${196 * scale}" viewBox="0 0 600 196">
  ${mark(252, 14, 96)}
  <text x="296" y="172" text-anchor="end" font-family="${font}" font-size="30" font-weight="700" fill="${ink}">Fast-AI</text>
  <rect x="306" y="146" width="108" height="34" rx="6" fill="${ink}"/>
  <text x="360" y="171" text-anchor="middle" font-family="${font}" font-size="22" font-weight="700" letter-spacing="2" fill="${dark ? "rgb(21,21,23)" : "white"}">COSMIC</text>
</svg>`);
};
for (const [file, scale, dark] of [
	["brand.png", 1, false],
	["brand-2x.png", 2, false],
	["brand-dark.png", 1, true],
	["brand-dark-2x.png", 2, true],
])
	await sharp(brand(scale, dark)).png().toFile(join(installerAssets, file));
await sharp(
	Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="164" height="314" viewBox="0 0 164 314">
  <rect width="164" height="314" fill="rgb(244,244,247)"/>${mark(34, 91, 96)}</svg>`),
)
	.flatten({ background: "#f4f4f7" })
	.png()
	.toFile(join(installerAssets, "uninstaller-sidebar.png"));
report.push({
	group: "品牌-安装程序",
	file: "apps/desktop/installer/assets/{brand,brand-2x,brand-dark,brand-dark-2x,uninstaller-sidebar}.png（替换）",
	replacements: 5,
});
// 安装程序里还有 DeepSeek 字样（dsh 升级加了新文字）就失败，不让它出现在用户的安装界面上
const installerText = [];
const scanInstaller = (dir) => {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) scanInstaller(path);
		else if (/\.(?:json|h|cpp|nsh)$/.test(entry.name))
			readFileSync(path, "utf8")
				.split("\n")
				.forEach((line, index) => {
					if (/deepseek|深度求索/i.test(line) && !/^\s*(?:\/\/|;)/.test(line))
						installerText.push(`${path.slice(copy.length + 1)}:${String(index + 1)}: ${line.trim()}`);
				});
	}
};
scanInstaller(join(copy, "apps/desktop/installer"));
if (installerText.length > 0) throw new Error(`安装程序里还有 DeepSeek 字样：\n${installerText.join("\n")}`);

const groups = {};
for (const row of report) {
	groups[row.group] ??= [];
	groups[row.group].push(row);
}
for (const [group, rows] of Object.entries(groups)) {
	console.log(`  ${group}：${String(rows.length)} 个文件`);
	for (const row of rows) console.log(`    ${row.file}${row.replacements ? `  ${String(row.replacements)} 处` : ""}`);
}
step(`补丁 ${String(report.length)} 个文件`);

// ── 4. 装依赖、出包 ──
step("pnpm install");
run("pnpm", ["install", "--prefer-offline", "--no-frozen-lockfile"], copy);
if (prepareOnly) {
	step(`副本备好了：${copy}`);
	process.exit(0);
}
step("dsh 不签名打包（十几分钟）");
run("pnpm", ["run", "package:desktop:win:x64:unsigned"], copy, {
	DSH_PACKAGING_CONFIG_DIR: join(repo, "packaging"),
	DSH_PACKAGING_PRESET: "production",
});

// ── 5. 拷出安装包 ──
const artifacts = join(copy, "apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts");
const exe = readdirSync(artifacts).find(
	(file) => file.startsWith(`${PKG}-`) && file.endsWith(".exe") && !file.includes("__uninstaller"),
);
if (exe === undefined) throw new Error(`没找到安装包：${artifacts}`);
mkdirSync(join(repo, "dist"), { recursive: true });
cpSync(join(artifacts, exe), join(repo, "dist", exe));
step(`安装包：${join(repo, "dist", exe)}`);
