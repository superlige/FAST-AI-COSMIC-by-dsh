#!/usr/bin/env node
/**
 * 不打安装包，直接起桌面窗口调试：改完代码重跑本脚本，约一分钟看到效果。
 *
 * 用法：node scripts/dev-desktop.mjs [--fresh]（npm run dev）
 *   --fresh 重新套一遍补丁再起（改了 scripts/package-desktop.mjs 里的补丁、或 dsh 检出目录升了版本时用）
 *
 * 做的事：
 *   1. 第一次（或 --fresh）：调 package-desktop.mjs --prepare-only 备好打过补丁的 dsh 副本；
 *   2. 编组合包，换进副本的 packages/cosmic/fast-ai-cosmic（桌面窗口经链接直接读这里）；
 *   3. 调 dsh 自己的桌面开发启动（apps/desktop 的 dev）；副本没重新套补丁就跳过 dsh 的构建，只起窗口。
 *
 * 登录、会话放在构建目录的 dev-home/，和装好的 exe（~/.fast-ai-cosmic/dsh）分开，第一次要在窗口里 /cosmic-login。
 * 副本重建（npm run build 不带 --skip-install）不会清掉它。
 * 再起之前先关掉上一个窗口（托盘里也退出）。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stageDesktopBundle } from "./stage-desktop-bundle.ts";

const PKG = "fast-ai-cosmic";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checkout = resolve(repo, "..");
const work = join(checkout, "..", ".cosmic-build");
const copy = join(work, "dsh");
const target = join(copy, "packages", "cosmic", PKG);
const fresh = process.argv.includes("--fresh");

const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
const env = {
	...process.env,
	PATH: [join(systemRoot, "System32"), dirname(process.execPath), process.env.PATH ?? ""].join(";"),
};
const run = (command, argv, cwd, extra = {}) =>
	execFileSync(command, argv, {
		cwd,
		stdio: "inherit",
		env: { ...env, ...extra },
		shell: process.platform === "win32",
	});

// ── 1. 副本 ──
const prepared = existsSync(join(target, "package.json")) && existsSync(join(copy, "node_modules"));
const prepare = fresh || !prepared;
if (prepare) {
	console.log(fresh ? "重新套补丁" : "第一次：备 dsh 副本（十来分钟）");
	run(
		process.execPath,
		[join(repo, "scripts/package-desktop.mjs"), "--prepare-only", ...(existsSync(copy) ? ["--skip-install"] : [])],
		repo,
	);
} else {
	// ── 2. 只换组合包 ──
	const version = JSON.parse(readFileSync(join(copy, "apps/cli/package.json"), "utf8")).version;
	run(process.execPath, [join(repo, "scripts/build-bundle.mjs"), "--version", version], repo);
	rmSync(target, { recursive: true, force: true });
	stageDesktopBundle(join(repo, "dist", PKG), target);
}

// ── 3. 起窗口 ──
const built =
	existsSync(join(copy, "apps/desktop/lib/main.js")) && existsSync(join(copy, "apps/desktop-host/lib/index.js"));
const skipBuild = built && !prepare;
console.log(skipBuild ? "起桌面窗口" : "构建 dsh 桌面版再起窗口（几分钟）");
run("pnpm", ["--filter", "@deepseek-ai/dsh-desktop", "run", "dev", ...(skipBuild ? ["--skip-build"] : [])], copy, {
	DSH_HOME: join(work, "dev-home"),
	DSH_DESKTOP_USER_DATA_DIR: join(work, "dev-user-data"),
	DSH_DESKTOP_OPEN_DEVTOOLS: "0",
});
