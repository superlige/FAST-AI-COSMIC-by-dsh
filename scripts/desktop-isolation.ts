/**
 * 装好的桌面版和用户另装的 dsh 分开：数据目录、环境变量名、共享 agent 配置目录、系统协议名都换成自己的。
 *
 * 不分开会怎样：两边都读写 `~/.dsh/profiles/desktop`（桌面版的插件目录，连 dsh 核心包都装在这里），
 * 原版 dsh 装进去的旧版插件被我们的内核加载，新建会话就失败（`ctx.agents.roots is not a function`）；
 * 登录、会话、设置互相覆盖；`dsh://` 协议谁后装归谁；用户给自己的 dsh 设了 `DSH_HOME`，我们也会跟过去。
 *
 * `scripts/package-desktop.mjs` 按这里的名字套补丁，套完用 {@link findSharedDshPaths} 扫一遍副本，
 * 还有地方读 dsh 默认的那一套就失败（dsh 升级新加了读法，补丁要跟上）。
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const DESKTOP_ISOLATION = {
	/** dsh 的数据目录（登录、会话、插件目录、设置），相对用户主目录；cosmic 自己的配置在它上一层。 */
	homeDir: ".fast-ai-cosmic/dsh",
	/**
	 * 盖过数据目录的环境变量（原版是 `DSH_HOME`）。必须以 `DSH_` 开头：dsh 给模型的终端先清掉所有 `DSH_*`
	 * 再注入自己那几个，类型上也只收这个前缀，起别的名字编不过（shell-env）。
	 */
	homeEnv: "DSH_COSMIC_HOME",
	/** 全局技能、全局 AGENTS.md 的目录（原版是和别的 agent 工具共用的 `~/.agents`）。 */
	agentsDir: ".fast-ai-cosmic/agents",
	/** 盖过上面那个目录的环境变量（原版是 `DSH_AGENTS_HOME`）。 */
	agentsEnv: "DSH_COSMIC_AGENTS_HOME",
	/** 系统协议名（原版是 `dsh`）。 */
	scheme: "fast-ai-cosmic",
} as const;

const SHARED: readonly RegExp[] = [
	/process\.env\.(?:DSH_HOME|DSH_AGENTS_HOME)\b/,
	/['"](?:DSH_HOME|DSH_AGENTS_HOME)['"]/,
	/['"]\.(?:dsh|agents)['"]/,
	/setAsDefaultProtocolClient\(\s*['"]dsh['"]/,
	/['"]dsh:\/\/open/,
];

/**
 * 找出还在用 dsh 默认数据目录、环境变量、协议名的源码行。
 * @param files - 要扫的文件（路径只用来报出来）。
 * @returns `路径:行号: 原文`，一行一处；空表示都改过来了。
 */
export function findSharedDshPaths(files: Iterable<{ path: string; text: string }>): string[] {
	const found: string[] = [];
	for (const file of files) {
		file.text.split("\n").forEach((line, index) => {
			if (SHARED.some((pattern) => pattern.test(line)))
				found.push(`${file.path}:${String(index + 1)}: ${line.trim()}`);
		});
	}
	return found;
}

const SKIP_DIRS = new Set(["node_modules", "lib", "dist", "tests", "test", "test-support", ".git", ".desktop-build"]);

/**
 * dsh 副本里会进安装包的源码：`apps/` 和 `packages/` 下各包 `src/` 里的 .ts，不含测试和类型声明。
 * @param root - dsh 副本根目录。
 */
export function* dshSourceFiles(root: string): Generator<{ path: string; text: string }> {
	const walk = function* (dir: string): Generator<{ path: string; text: string }> {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (!SKIP_DIRS.has(entry.name)) yield* walk(path);
				continue;
			}
			const rel = relative(root, path).split(sep).join("/");
			if (!rel.includes("/src/") || !rel.endsWith(".ts") || /\.(?:d|spec|test)\.ts$/.test(rel)) continue;
			yield { path: rel, text: readFileSync(path, "utf8") };
		}
	};
	for (const top of ["apps", "packages"]) yield* walk(join(root, top));
}
