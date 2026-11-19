/**
 * S37 2-C.1 的尺子：第一次出现的异常被说成"老面孔"，历史上有几次、改前改后回放各几次。
 *
 * 用法：
 *   node --experimental-strip-types scripts/measure-noise-first-seen.ts [会话目录] [--cache <缓存目录>] [--own zlgd.]
 *
 * 两段输出：
 *   1. 扫会话里 cosmic 的返回：带"老面孔（N 种，最早在 X 就出现过）"的有几次，其中"最早在"就是这次返回自己那一分钟的有几次
 *      ——那是边查边写的签名：账是这次运行刚写的，却被当成以前见过。只能看出整块都是新异常的情况，是下限。
 *   2. 回放：把缓存里存下的探针原始输出（每个 RuntimeKey 一个目录、按时间排）从空账本开始逐份过一遍，
 *      改前（git HEAD 的 noise.ts）和改后（工作区的 noise.ts）各算一次：
 *      "这次运行里第一次出现、却被报成见过"的异常组有几组，被报成见过的一共几组。
 * 只读会话文件和缓存，不连环境；账本记在内存里，不碰工程的 `.cosmic-ai/`。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { KernelContext } from "../src/kernel/context.ts";
import { filterProbeOutput, type RuntimeExceptionGroup } from "../src/kernel/probe/output.ts";

const REPO = join(import.meta.dirname, "..");
const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
	const at = args.indexOf(name);
	return at >= 0 ? args[at + 1] : undefined;
};
const dir =
	args.find((arg, i) => !arg.startsWith("--") && !(args[i - 1] ?? "").startsWith("--")) ??
	join(homedir(), ".pi", "agent", "sessions", "--D--kingdee-zlgd_ygpt2.0--");
const cache = flag("--cache") ?? join(homedir(), ".fast-ai-cosmic", "cache");
const own = (flag("--own") ?? "zlgd.").split(",");

// ---- 1. 会话里的"老面孔"
const BLOCK = /老面孔（(\d+) 种，最早在 (\d{4}-\d\d-\d\d \d\d:\d\d) 就出现过）/;
let blocks = 0;
const selfDated: string[] = [];
const files = readdirSync(dir)
	.filter((file) => file.endsWith(".jsonl"))
	.sort();
for (const file of files) {
	const results: number[] = [];
	for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
		if (/"toolName":"cosmic_(?:probe|run)"/.test(line)) {
			const stamp = /"timestamp":"([^"]+)"/.exec(line);
			if (stamp !== null) results.push(Date.parse(stamp[1] as string));
		}
		if (!line.includes("老面孔（")) continue;
		let row: { timestamp?: string; message?: { role?: string; content?: { type?: string; text?: string }[] } };
		try {
			row = JSON.parse(line);
		} catch {
			continue;
		}
		if (row.message?.role !== "toolResult") continue;
		const text = (row.message.content ?? []).map((part) => part.text ?? "").join("\n");
		const match = BLOCK.exec(text);
		if (match === null) continue;
		blocks++;
		// 记账时刻在返回之前几秒到几十秒：和返回同一分钟或早一分钟。
		// 那段时间里前面还有别的探针或运行返回的，账可能是那一次真记的，不算（所以是下限）
		const at = Date.parse(`${(match[2] as string).replace(" ", "T")}:00Z`);
		const back = Date.parse(row.timestamp ?? "");
		const earlierInWindow = results.some((t) => t >= at && t < back);
		if (back - at >= 0 && back - at < 2 * 60_000 && !earlierInWindow) {
			selfDated.push(`${file.slice(0, 19)} ${row.timestamp} 最早在 ${match[2]}（${match[1]} 种）`);
		}
	}
}
console.log(
	`== 1. 会话 ${files.length} 份，带"老面孔"的返回 ${blocks} 次，"最早在"就是这次自己的 ${selfDated.length} 次`,
);
for (const hit of selfDated) console.log(hit);

// ---- 2. 回放
type Record_ = (
	ctx: KernelContext,
	groups: readonly RuntimeExceptionGroup[],
	ownPackages?: readonly string[],
) => (group: RuntimeExceptionGroup) => { seen: number; firstAt: string } | null;

/** noise.ts 的一个版本，相对 import 改成指向工作区的绝对路径，放进临时目录再加载。 */
async function load(
	source: string,
	tmp: string,
	name: string,
): Promise<{ record: Record_; fp: (g: RuntimeExceptionGroup) => string }> {
	const probeDir = join(REPO, "src", "kernel", "probe");
	const text = source.replace(/from "(\.{1,2}\/[^"]+)"/g, (_all, rel: string) => {
		return `from "${pathToFileURL(join(probeDir, rel)).href}"`;
	});
	const file = join(tmp, `${name}.ts`);
	writeFileSync(file, text);
	const mod = (await import(pathToFileURL(file).href)) as {
		recordNoise: Record_;
		noiseFingerprint: (g: RuntimeExceptionGroup) => string;
	};
	return { record: mod.recordNoise, fp: mod.noiseFingerprint };
}

/** 只够 recordNoise 用的上下文：账本在内存里，时钟按原始输出的文件名走。 */
function memoryContext(runtimeKeyId: string, clock: { now: number }): KernelContext {
	const files = new Map<string, string>();
	return {
		runtimeKeyId,
		layout: { workDir: "/mem" },
		ports: {
			clock: { now: () => clock.now },
			fs: {
				exists: (path: string) => files.has(path),
				read: (path: string) => files.get(path) ?? "",
				write: (path: string, text: string) => void files.set(path, text),
				mkdirp: () => undefined,
			},
		},
	} as unknown as KernelContext;
}

interface Tally {
	runs: number;
	withRepeat: number;
	reported: number;
	firstSeenReported: number;
	hits: string[];
}

async function replay(impl: { record: Record_; fp: (g: RuntimeExceptionGroup) => string }): Promise<Tally> {
	const tally: Tally = { runs: 0, withRepeat: 0, reported: 0, firstSeenReported: 0, hits: [] };
	if (!existsSync(cache)) return tally;
	for (const key of readdirSync(cache).sort()) {
		const runsDir = join(cache, key, "probe-runs");
		if (!existsSync(runsDir)) continue;
		const clock = { now: 0 };
		const ctx = memoryContext(key, clock);
		for (const name of readdirSync(runsDir)
			.filter((file) => file.endsWith(".out"))
			.sort()) {
			const stamp = /^(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z/.exec(name);
			if (stamp === null) continue;
			clock.now = Date.parse(`${stamp[1]}T${stamp[2]}:${stamp[3]}:${stamp[4]}.${stamp[5]}Z`);
			const groups = filterProbeOutput(readFileSync(join(runsDir, name), "utf8"), own).exceptions;
			tally.runs++;
			const ids = groups.map(impl.fp);
			if (new Set(ids).size < ids.length) tally.withRepeat++;
			const lookup = impl.record(ctx, groups, own);
			const at = new Date(clock.now).toISOString();
			const counted = new Set<string>();
			let wrong = 0;
			groups.forEach((group, i) => {
				const id = ids[i] as string;
				const history = lookup(group);
				if (history === null || counted.has(id)) return;
				counted.add(id);
				tally.reported++;
				if (history.firstAt === at) wrong++;
			});
			tally.firstSeenReported += wrong;
			if (wrong > 0) tally.hits.push(`${key.slice(0, 22)} ${name}：${wrong} 种`);
		}
	}
	return tally;
}

const tmp = mkdtempSync(join(tmpdir(), "cosmic-noise-ruler-"));
try {
	const head = execFileSync("git", ["show", "HEAD:src/kernel/probe/noise.ts"], { cwd: REPO, encoding: "utf8" });
	const now = readFileSync(join(REPO, "src", "kernel", "probe", "noise.ts"), "utf8");
	const before = await replay(await load(head, tmp, "noise-head"));
	const after = await replay(await load(now, tmp, "noise-now"));
	console.log(
		`\n== 2. 回放缓存 ${cache}：原始输出 ${before.runs} 份，其中同一异常一次打印多遍的 ${before.withRepeat} 份`,
	);
	console.log("| | 改前（HEAD） | 改后（工作区） |");
	console.log("|---|---:|---:|");
	console.log(`| 被报成见过的异常（每份输出里按指纹去重） | ${before.reported} | ${after.reported} |`);
	console.log(`| 其中这次才第一次出现的 | ${before.firstSeenReported} | ${after.firstSeenReported} |`);
	for (const hit of before.hits) console.log(`改前：${hit}`);
	for (const hit of after.hits) console.log(`改后：${hit}`);
} finally {
	rmSync(tmp, { recursive: true, force: true });
}
