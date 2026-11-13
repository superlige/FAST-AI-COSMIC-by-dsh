/**
 * 尺子：常驻进程新起一次要多久，起来后第一次用各样东西又多付多少。
 *
 *   node --experimental-strip-types scripts/measure-resident-start.ts <工程目录> [--rounds 2] [--off] [--gap 0]
 *     [--form "<run 参数>"] [--probe 探针 --env 键=值 …] [--keep] [--json]
 *
 * 每一轮：停掉本版本自己的常驻进程 → 发一个只读探针（这一次包含起进程）→ 等 --gap 秒 →
 * 用 `run` 打开一张单两次（第一次是这个进程头一回开单，第二次是平时的样子）。然后从常驻进程自己的日志里读：
 * 元数据预热、编译器热身、许可信息预读各多久，那几次请求的编译和运行各多久、编译是不是沿用的。
 *
 * `--off` 带上 -Dcosmic.prewarm=off 起进程：本机名反查、编译器热身、许可信息预读都不做，探针产物不跨进程沿用，
 * 也就是没有这些做法时的样子。同一时段先 `--off` 再不带各跑一遍就是前后对照；网络快慢随时在变，隔久了的两次不能比。
 * `--gap` 是第一个探针和开单之间等的秒数：真实会话里两者一般隔着模型的好几轮，后台预读有时间做完；0 是最挤的情况。
 *
 * 只跑只读探针和预演。会停掉并重起本版本自己的常驻进程；跑完默认停掉，`--keep` 留着。
 * 口径和基线见 `docs/S60-resident-startup-and-first-touch.md` §2。
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { probe } from "../src/kernel/commands/probe.ts";
import { run } from "../src/kernel/commands/run.ts";
import { openProject } from "../src/kernel/open-project.ts";
import { forgetRepeats } from "../src/kernel/probe/repeat.ts";
import { stopServer } from "../src/kernel/probe/server.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";

const argv = process.argv.slice(2);
const one = (name: string): string | undefined => {
	const at = argv.indexOf(name);
	return at < 0 ? undefined : argv[at + 1];
};
const many = (name: string): string[] =>
	argv.flatMap((arg, i) => (arg === name && argv[i + 1] ? [argv[i + 1] as string] : []));
const project = argv[0];
if (project === undefined || project.startsWith("--")) {
	console.error(
		'用法：measure-resident-start.ts <工程目录> [--rounds 2] [--off] [--gap 0] [--form "<run 参数>"] [--probe 探针 --env 键=值 …] [--keep] [--json]',
	);
	process.exit(2);
}
const rounds = Number(one("--rounds") ?? "2");
const gap = Number(one("--gap") ?? "0");
const off = argv.includes("--off");
const probeName = one("--probe") ?? "DataQueryProbe";
const envPairs = many("--env");
const env = Object.fromEntries(
	(envPairs.length > 0 ? envPairs : ["QUERY_ENTITY=bos_user", "QUERY_FIELDS=id,number,name", "QUERY_LIMIT=1"]).map(
		(pair) => {
			const eq = pair.indexOf("=");
			return [pair.slice(0, eq), pair.slice(eq + 1)];
		},
	),
);
const formArgs = one("--form")?.split(/\s+/).filter(Boolean);
if ("APPLY" in env || formArgs?.includes("--apply")) {
	console.error("这把尺子只跑只读探针和预演。");
	process.exit(2);
}
if (off) process.env.JAVA_TOOL_OPTIONS = `${process.env.JAVA_TOOL_OPTIONS ?? ""} -Dcosmic.prewarm=off`.trim();

const opened = await openProject({
	projectRoot: resolve(project),
	agentConfigDir: join(homedir(), ".fast-ai-cosmic"),
	cacheRoot: join(homedir(), ".fast-ai-cosmic", "cache"),
	agentVersion: "0.0.0-dev",
	resources: EMBEDDED_RESOURCES,
});
const ctx = opened.ctx;

interface Request {
	probe: string;
	compileMs: number;
	reused: string;
	runMs: number;
}
interface Round {
	startAndFirstProbeMs: number;
	formFirstMs: number | null;
	formSecondMs: number | null;
	failed: string[];
	log: {
		metaWarmMs: number | null;
		compilerWarmMs: number | null;
		licenseWarm: string | null;
		requests: Request[];
	};
}

async function timed(label: string, failed: string[], call: () => Promise<{ ok: boolean }>): Promise<number> {
	forgetRepeats(ctx);
	const started = performance.now();
	const result = await call();
	if (!result.ok) failed.push(label);
	return performance.now() - started;
}

/** 常驻进程自己写的那几行（日志每次起进程重写）。 */
function readLog(): Round["log"] {
	const text = existsSync(ctx.layout.serverLog) ? readFileSync(ctx.layout.serverLog, "utf8") : "";
	const first = (pattern: RegExp): RegExpExecArray | null => pattern.exec(text);
	const requests: Request[] = [];
	for (const hit of text.matchAll(
		/#\d+ (\S+) 准备 \d+ ms（查业务类 \d+），编译 (\d+) ms(（沿用[^）]*）)?，运行 (\d+) ms/g,
	)) {
		requests.push({
			probe: hit[1] as string,
			compileMs: Number(hit[2]),
			reused: hit[3] === undefined ? "" : hit[3].includes("上个进程") ? "沿用上个进程的" : "沿用",
			runMs: Number(hit[4]),
		});
	}
	const license = first(/许可信息预读 (\d+\/\d+ 项，\d+ ms[^\r\n]*)/);
	return {
		metaWarmMs: Number(first(/元数据预热完成 (\d+) ms/)?.[1] ?? Number.NaN) || null,
		compilerWarmMs: Number(first(/编译器热身 (\d+) ms/)?.[1] ?? Number.NaN) || null,
		licenseWarm: license === null ? null : (license[1] as string),
		requests,
	};
}

const results: Round[] = [];
for (let i = 0; i < rounds; i++) {
	await stopServer(ctx);
	const failed: string[] = [];
	const startAndFirstProbeMs = await timed("第一个探针", failed, () =>
		probe(ctx, probeName, { env, countRepeats: false } as never),
	);
	let formFirstMs: number | null = null;
	let formSecondMs: number | null = null;
	if (formArgs !== undefined) {
		if (gap > 0) await new Promise((go) => setTimeout(go, gap * 1000));
		formFirstMs = await timed("第一次开单", failed, () => run(ctx, formArgs, {} as never));
		formSecondMs = await timed("第二次开单", failed, () => run(ctx, formArgs, {} as never));
	}
	results.push({ startAndFirstProbeMs, formFirstMs, formSecondMs, failed, log: readLog() });
}
if (!argv.includes("--keep")) await stopServer(ctx);

if (argv.includes("--json")) {
	console.log(JSON.stringify({ runtimeKey: ctx.runtimeKeyId, off, gap, rounds: results }, null, 2));
} else {
	const sec = (ms: number | null): string => (ms === null ? "—" : `${(ms / 1000).toFixed(1)} 秒`);
	console.log(
		`常驻进程版本 ${ctx.runtimeKeyId}　${off ? "关掉提前付账（-Dcosmic.prewarm=off）" : "照常"}　开单前等 ${String(gap)} 秒`,
	);
	results.forEach((round, i) => {
		console.log(
			`第 ${String(i + 1)} 轮：起进程＋第一个探针 ${sec(round.startAndFirstProbeMs)}｜第一次开单 ${sec(round.formFirstMs)}｜第二次开单 ${sec(round.formSecondMs)}${round.failed.length > 0 ? `　没跑成：${round.failed.join("、")}` : ""}`,
		);
		console.log(
			`  进程自己记的：元数据预热 ${sec(round.log.metaWarmMs)}｜编译器热身 ${sec(round.log.compilerWarmMs)}｜许可信息预读 ${round.log.licenseWarm ?? "—"}`,
		);
		for (const request of round.log.requests) {
			console.log(
				`    ${request.probe}　编译 ${String(request.compileMs)} ms${request.reused === "" ? "" : `（${request.reused}）`}　运行 ${String(request.runMs)} ms`,
			);
		}
	});
}
process.exit(results.some((round) => round.failed.length > 0) ? 1 : 0);
