/**
 * 尺子：重开一遍工程要多久，其中扫苍穹运行时多久。
 *
 * 每次工具调用都先重开工程（确认工程、JDK、苍穹运行时、内嵌资源都还是原来那一套），这笔钱每个
 * cosmic 工具每次都付。这把尺子用工具同一个函数、同一套记忆（JDK 只问一次、运行时目录没变不重扫）
 * 连着开几遍：第一遍单列（要整扫），之后几遍取中位，分「扫运行时」和「其余」。
 *
 * 用法：
 *   node --experimental-strip-types scripts/measure-reopen.ts <工程目录> [--repeat 6] [--no-memory] [--json]
 *   bun scripts/measure-reopen.ts <工程目录>            # 打包版用的是 bun，两边都量
 *
 * `--no-memory` 每遍都整扫（改之前的样子）。两种跑法算出的运行时版本号必须相同，脚本会对。
 *
 * 只动本工具自己的缓存目录（开发版那一份）：不起 JVM、不连环境、不写工程目录。
 * 口径和基线见 `docs/S59-call-overhead-idle-connections.md` §2.1。
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { PRODUCT_ID } from "../src/brand.ts";
import { type OpenProjectInput, openProject } from "../src/kernel/open-project.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";
import { type JarScanner, nodeJarScanner, rememberingJarScanner } from "../src/runtime/fingerprint.ts";

const argv = process.argv.slice(2);
const project = argv.find((arg) => !arg.startsWith("--"));
if (project === undefined) {
	console.error(
		"用法：node --experimental-strip-types scripts/measure-reopen.ts <工程目录> [--repeat 6] [--no-memory] [--json]",
	);
	process.exit(2);
}
const flag = (name: string): boolean => argv.includes(name);
const repeatAt = argv.indexOf("--repeat");
const repeat = repeatAt >= 0 ? Math.max(1, Number(argv[repeatAt + 1])) : 6;

function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	return sorted.length % 2 === 1 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

interface Round {
	totalMs: number;
	scanMs: number;
	keyId: string;
}

async function rounds(remember: boolean): Promise<Round[]> {
	let scanMs = 0;
	const base: JarScanner = remember ? rememberingJarScanner(nodeJarScanner, new Map()) : nodeJarScanner;
	const timed: JarScanner = {
		async scan(root) {
			const started = performance.now();
			try {
				return await base.scan(root);
			} finally {
				scanMs += performance.now() - started;
			}
		},
	};
	const input: OpenProjectInput = {
		projectRoot: resolve(project as string),
		agentConfigDir: join(homedir(), `.${PRODUCT_ID}`),
		cacheRoot: join(homedir(), `.${PRODUCT_ID}`, "cache"),
		agentVersion: "0.0.0-dev",
		resources: EMBEDDED_RESOURCES,
		jdkMemory: new Map(),
		jarScanner: timed,
	};
	const out: Round[] = [];
	for (let i = 0; i <= repeat; i++) {
		scanMs = 0;
		const started = performance.now();
		const opened = await openProject(input);
		out.push({ totalMs: performance.now() - started, scanMs, keyId: opened.key.id });
	}
	return out;
}

const remembered = flag("--no-memory") ? null : await rounds(true);
const everyTime = await rounds(false);
const keys = new Set([...(remembered ?? []), ...everyTime].map((round) => round.keyId));

function summary(label: string, all: readonly Round[]) {
	const [first, ...rest] = all;
	return {
		label,
		firstMs: Math.round(first?.totalMs ?? 0),
		firstScanMs: Math.round(first?.scanMs ?? 0),
		medianMs: Math.round(median(rest.map((round) => round.totalMs))),
		medianScanMs: Math.round(median(rest.map((round) => round.scanMs))),
		medianRestMs: Math.round(median(rest.map((round) => round.totalMs - round.scanMs))),
		each: rest.map((round) => Math.round(round.totalMs)),
	};
}

const report = {
	runtime: typeof (globalThis as { Bun?: unknown }).Bun === "undefined" ? `node ${process.version}` : "bun",
	project: resolve(project),
	repeat,
	sameKey: keys.size === 1,
	keyId: [...keys].join(" / "),
	rows: [...(remembered === null ? [] : [summary("目录没变不重扫", remembered)]), summary("每遍都整扫", everyTime)],
};

if (flag("--json")) {
	console.log(JSON.stringify(report, null, 2));
} else {
	console.log(`${report.runtime}　工程 ${report.project}　第一遍之后连开 ${String(repeat)} 遍`);
	for (const row of report.rows) {
		console.log(
			`${row.label}：第一遍 ${String(row.firstMs)} 毫秒（扫运行时 ${String(row.firstScanMs)}）；` +
				`之后每遍中位 ${String(row.medianMs)} 毫秒（扫运行时 ${String(row.medianScanMs)}，其余 ${String(row.medianRestMs)}）　各遍 ${row.each.join(" ")}`,
		);
	}
	console.log(report.sameKey ? `运行时版本号一致：${report.keyId}` : `✘ 运行时版本号不一致：${report.keyId}`);
}
if (!report.sameKey) process.exit(1);
