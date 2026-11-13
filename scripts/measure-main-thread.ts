/**
 * 主线程尺子：工具调用路上那几件重活，各自把主线程占住多久。
 *
 * 界面和工具跑在同一条主线程上。一件活哪怕是异步的，只要两次让出之间隔得久，界面那几十毫秒里
 * 就画不了帧、收不到按键——看起来就是「一卡一卡的」。所以这里不只量总用时，还一边干活一边
 * 每 5 毫秒打一次心跳，记心跳被耽误的最长一次（最长一卡）和超过一帧（16 毫秒）的累计（一共卡了多久）。
 *
 * 量的几件：
 * - 扫苍穹运行时：每次打开工程都要把运行时目录下的 JAR 列一遍、取大小，算运行时指纹；
 * - 源码和编译结果对不对得上（编译、验证、工具前检查都要做）：同步版和分段让出版各量一遍，指纹必须逐字相同；
 * - 哪些源码比编译结果新（每次跑探针前都要查）：同样两版各量一遍，名单必须相同。
 *
 * 用法：
 *   node --experimental-strip-types scripts/measure-main-thread.ts <工程目录> [--repeat 3] [--json]
 *
 * 只读：列目录、读文件、算指纹，不编译、不连环境、不写任何东西。
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { PRODUCT_ID } from "../src/brand.ts";
import { staleSources, staleSourcesAsync } from "../src/kernel/commands/sources.ts";
import { loadConfig } from "../src/kernel/config/load-config.ts";
import type { KernelContext } from "../src/kernel/context.ts";
import { captureFreshness, captureFreshnessAsync } from "../src/kernel/freshness.ts";
import { kernelLayout } from "../src/kernel/layout.ts";
import { nodePorts } from "../src/kernel/ports.ts";
import { fingerprintCosmicRuntime, nodeJarScanner } from "../src/runtime/fingerprint.ts";

const BEAT_MS = 5;
const FRAME_MS = 16;

interface Occupancy {
	step: string;
	/** 从开始到做完的总用时。 */
	wallMs: number;
	/** 心跳被耽误最久的一次：界面最长卡这么久。 */
	longestStallMs: number;
	/** 心跳间隔超过一帧的部分加起来：界面一共卡了这么久。 */
	stalledMs: number;
	/** 做出来的东西的摘要，用来核对改前改后结果一样。 */
	result: string;
}

async function occupancy(step: string, work: () => unknown): Promise<Occupancy> {
	let last = performance.now();
	let longest = 0;
	let stalled = 0;
	const beat = setInterval(() => {
		const now = performance.now();
		const gap = now - last;
		longest = Math.max(longest, gap);
		if (gap > FRAME_MS) stalled += gap - BEAT_MS;
		last = now;
	}, BEAT_MS);
	const started = performance.now();
	const result = await work();
	const wallMs = performance.now() - started;
	// 收尾那一段也算：做完以后第一次心跳才知道最后一段卡了多久。
	await new Promise((resolve) => setTimeout(resolve, BEAT_MS * 2));
	clearInterval(beat);
	return {
		step,
		wallMs: Math.round(wallMs),
		longestStallMs: Math.round(longest),
		stalledMs: Math.round(stalled),
		result: String(result),
	};
}

function projectContext(root: string): KernelContext {
	const agentConfigDir = process.env.COSMIC_AGENT_DIR ?? join(homedir(), `.${PRODUCT_ID}`);
	const config = loadConfig({ root, agentConfigDir, env: process.env }, nodePorts.fs);
	const layout = kernelLayout({
		root,
		cacheRoot: join(root, ".cosmic-ai", "__measure__"),
		runtimeKeyId: "measure",
		resourcesDir: join(root, ".cosmic-ai", "__measure__"),
		codeModules: config.codeModules,
	});
	return { projectRoot: root, layout, config, ports: nodePorts, runtimeKeyId: "measure" } as unknown as KernelContext;
}

async function main(argv: string[]): Promise<void> {
	let repeat = 3;
	let json = false;
	let root: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--repeat") repeat = Number(argv[++i]);
		else if (argv[i] === "--json") json = true;
		else root = argv[i];
	}
	if (root === undefined) {
		console.error("用法：measure-main-thread.ts <工程目录> [--repeat 3] [--json]");
		process.exitCode = 2;
		return;
	}
	const ctx = projectContext(root);
	const home = ctx.config.cosmicHome;
	const rows: Occupancy[] = [];
	for (let round = 0; round < repeat; round++) {
		if (home !== null)
			rows.push(
				await occupancy("扫苍穹运行时", async () => {
					const fingerprint = fingerprintCosmicRuntime(home, await nodeJarScanner.scan(home));
					return `${String(fingerprint.jarCount)} 个 JAR，指纹 ${fingerprint.hash.slice(0, 12)}`;
				}),
			);
		rows.push(
			await occupancy("源码与编译结果（同步）", () => {
				const snapshot = captureFreshness(ctx);
				return `${String(snapshot.sourceCount)} 个源文件，指纹 ${snapshot.sourceFingerprint.slice(0, 12)}/${snapshot.classFingerprint.slice(0, 12)}`;
			}),
		);
		rows.push(
			await occupancy("源码与编译结果（分段让出）", async () => {
				const snapshot = await captureFreshnessAsync(ctx);
				return `${String(snapshot.sourceCount)} 个源文件，指纹 ${snapshot.sourceFingerprint.slice(0, 12)}/${snapshot.classFingerprint.slice(0, 12)}`;
			}),
		);
		rows.push(await occupancy("源码比编译结果新（同步）", () => `${String(staleSources(ctx).length)} 个`));
		rows.push(
			await occupancy(
				"源码比编译结果新（分段让出）",
				async () => `${String((await staleSourcesAsync(ctx)).length)} 个`,
			),
		);
	}
	if (json) {
		console.log(JSON.stringify(rows, null, 2));
		return;
	}
	for (const row of rows)
		console.log(
			`${row.step}  总用时 ${String(row.wallMs)} 毫秒  最长一卡 ${String(row.longestStallMs)} 毫秒  一共卡 ${String(row.stalledMs)} 毫秒  （${row.result}）`,
		);
}

await main(process.argv.slice(2));
