/**
 * 换一个 cosmic 版本后，常驻 JVM 起来时 JRebel 能不能复用它的启动缓存。
 *
 *   node --experimental-strip-types scripts/measure-jrebel-cache.ts <工程目录> [--json]
 *
 * JRebel 每次启动要一份启动缓存（`~/.jrebel/bootcache` 下，把 JDK 核心类改写后打的包，每份约 7 MB），
 * 对照依据里有 JVM 的全部 -D 参数和 PATH：参数一变就重新生成，多 15～20 秒、多一份文件。
 *
 * 做法：用和真启动同一个函数（`residentServerArgs`）拼出两个假版本 A、B 的启动参数，
 * 只把主类换成一个不存在的类——JVM 照样先把 JRebel 挂上、备好缓存，然后报找不到主类退出，不连苍穹、不占端口。
 * 按 A、A、B 的顺序各起一次，数缓存目录里每次多没多出新文件、各用几秒。
 * B 也「复用」才算换版本不再重新生成。工程没配 JRebel 时量不了，照实说。
 *
 * 会在 `~/.jrebel/bootcache` 里留下一两份缓存（每份约 7 MB），和平常启动留下的一样。
 */

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PRODUCT_ID } from "../src/brand.ts";
import { loadConfig } from "../src/kernel/config/load-config.ts";
import type { KernelContext } from "../src/kernel/context.ts";
import { kernelLayout } from "../src/kernel/layout.ts";
import { nodePorts } from "../src/kernel/ports.ts";
import { residentServerArgs, resolveHotSwap } from "../src/kernel/probe/server.ts";
import { findToolsJar } from "../src/kernel/toolchain.ts";

const MAIN = "CosmicProbeServer";
const ABSENT_MAIN = "NoSuchMainForJrebelMeasure";
const bootcache = join(homedir(), ".jrebel", "bootcache");

function versionContext(root: string, keyId: string): KernelContext {
	const agentConfigDir = process.env.COSMIC_AGENT_DIR ?? join(homedir(), `.${PRODUCT_ID}`);
	const config = loadConfig({ root, agentConfigDir, env: process.env }, nodePorts.fs);
	// 缓存目录照真的摆法：<配置目录>/cache/<版本号>/，这样按版本变的路径和真启动一样在变。
	const cacheRoot = join(process.env.COSMIC_CACHE_ROOT ?? join(agentConfigDir, "cache"), keyId);
	const layout = kernelLayout({
		root,
		cacheRoot,
		runtimeKeyId: keyId,
		resourcesDir: join(cacheRoot, "resources"),
		codeModules: config.codeModules,
	});
	return {
		projectRoot: root,
		layout,
		config,
		env: process.env,
		ports: nodePorts,
		runtimeKeyId: keyId,
		probes: [],
		releasedProbeDigests: {},
		platform: process.platform,
	};
}

function cachedJars(): Set<string> {
	try {
		return new Set(readdirSync(bootcache).filter((name) => name.endsWith(".jar") && !name.includes(".tmp")));
	} catch {
		return new Set();
	}
}

interface Run {
	label: string;
	regenerated: boolean;
	seconds: number;
}

function launch(label: string, args: string[], cwd: string): Run {
	const before = cachedJars();
	const started = Date.now();
	spawnSync(
		"java",
		args.map((arg) => (arg === MAIN ? ABSENT_MAIN : arg)),
		{ cwd, stdio: "ignore" },
	);
	const regenerated = [...cachedJars()].some((name) => !before.has(name));
	return { label, regenerated, seconds: Math.round((Date.now() - started) / 100) / 10 };
}

/** 主类前面那一段（JVM 自己的参数）里，两个版本不一样的项。 */
function differingJvmOptions(a: string[], b: string[]): string[] {
	const head = (args: string[]): string[] => args.slice(0, args.indexOf(MAIN));
	const left = head(a);
	const right = new Set(head(b));
	return left.filter((arg) => !right.has(arg));
}

async function main(argv: string[]): Promise<void> {
	const json = argv.includes("--json");
	const root = argv.find((arg) => !arg.startsWith("--"));
	if (root === undefined) {
		console.error("用法：measure-jrebel-cache.ts <工程目录> [--json]");
		process.exitCode = 2;
		return;
	}
	const stamp = Date.now().toString(36);
	const a = versionContext(root, `measure-a-${stamp}`);
	const b = versionContext(root, `measure-b-${stamp}`);
	const hotSwap = resolveHotSwap(a);
	if (hotSwap.mode !== "jrebel") {
		console.log(`这个工程没挂 JRebel（${hotSwap.warning ?? "配置里没要"}），量不了。`);
		return;
	}
	const tools = await findToolsJar(a);
	if (tools === null) {
		console.log("找不到 tools.jar，量不了。");
		return;
	}
	const argsA = residentServerArgs(a, hotSwap, tools);
	const argsB = residentServerArgs(b, resolveHotSwap(b), tools);
	const differing = differingJvmOptions(argsA, argsB);
	const runs = [
		launch("版本 A 第一次", argsA, root),
		launch("版本 A 再起一次", argsA, root),
		launch("换成版本 B", argsB, root),
	];
	const switched = runs[2] as Run;
	if (json) {
		console.log(
			JSON.stringify({ differingJvmOptions: differing, runs, versionSwitchReuses: !switched.regenerated }, null, 2),
		);
		return;
	}
	console.log(`主类前面随版本变的 JVM 参数：${differing.length === 0 ? "没有" : ""}`);
	for (const option of differing) console.log(`  ${option}`);
	for (const run of runs)
		console.log(
			`${run.label.padEnd(10)} ${run.regenerated ? "重新生成缓存" : "复用缓存"}  ${String(run.seconds)} 秒`,
		);
	console.log(
		switched.regenerated ? "结论：换版本要重新生成 JRebel 启动缓存。" : "结论：换版本直接复用 JRebel 启动缓存。",
	);
}

await main(process.argv.slice(2));
