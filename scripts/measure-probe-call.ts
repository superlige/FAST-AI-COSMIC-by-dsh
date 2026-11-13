/**
 * S57 的尺子：一次探针调用（常驻 JVM 已经在跑）从发出到拿回结果，时间花在哪几段。
 *
 * 用法：
 *   node --experimental-strip-types scripts/measure-probe-call.ts <工程目录> [--probe DataQueryProbe] [--env 键=值 …]
 *     [--run "<run 参数>"] [--repeat 5] [--cache <目录>] [--stop] [--json]
 *
 * - 走的是工具用的同一个入口（`probe()` / `run()`），同一份内嵌资源；默认用工具平时用的缓存目录，
 *   所以搭的是工程现成的常驻 JVM（没有就先拉起，拉起那一次单列、不算进去）。跑完默认不停 JVM：
 *   停掉它下一个会话又要等一次冷启动；要停加 `--stop`。
 * - 每次调用分四段计时，用工具自己报进度的那两个点切开：
 *     发之前（预检、读探针源码、查工程新不新鲜、查重复）→ 查常驻（类旧不旧、要不要换类）→
 *     在 JVM 里（发请求到拿回答复，含 JVM 里编译探针和探针本身）→ 收尾（验归属、过滤日志、落盘）
 *   「在 JVM 里」那一段再按常驻进程自己日志里记的拆开：准备（查业务类变没变、建上下文）、编译探针、运行；
 *   编译那一项同时报几次是沿用上次编好的。
 * - 另外按「谁干的」分账：文件读写、起进程、网络各用了多久、调了几次，最慢的几种调用单列。
 *   同步的文件调用整段占着主线程，界面那段时间不动。
 * - 只跑只读探针和预演：带 APPLY 的直接拒绝。`--run` 的参数按空格切，不认引号；会落库的 run 不要用它量。
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
		'用法：measure-probe-call.ts <工程目录> [--probe 探针] [--env 键=值 …] [--run "<run 参数>"] [--repeat 5] [--json]',
	);
	process.exit(2);
}
const name = one("--probe") ?? "DataQueryProbe";
const runArgs = one("--run")?.split(/\s+/).filter(Boolean);
const repeat = Number(one("--repeat") ?? "5");
const env = Object.fromEntries(
	many("--env").map((pair) => {
		const eq = pair.indexOf("=");
		return [pair.slice(0, eq), pair.slice(eq + 1)];
	}),
);
if ("APPLY" in env || runArgs?.includes("--apply")) {
	console.error("这把尺子只跑只读探针和预演。");
	process.exit(2);
}

const opened = await openProject({
	projectRoot: resolve(project),
	agentConfigDir: join(homedir(), ".fast-ai-cosmic"),
	cacheRoot: resolve(one("--cache") ?? join(homedir(), ".fast-ai-cosmic", "cache")),
	agentVersion: "0.0.0-dev",
	resources: EMBEDDED_RESOURCES,
});

interface Tally {
	ms: number;
	calls: number;
}
const tallies = new Map<string, Tally>();
let depth = 0;
const charge = (key: string, ms: number): void => {
	const tally = tallies.get(key) ?? { ms: 0, calls: 0 };
	tally.ms += ms;
	tally.calls += 1;
	tallies.set(key, tally);
};
/** 给一组端口函数套上计时。嵌套调用只记最外层那次，免得同一段时间算两遍。 */
function timed<T extends object>(port: T, label: string): T {
	return new Proxy(port, {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, receiver);
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => {
				const outer = depth === 0;
				depth++;
				const started = performance.now();
				const done = (): void => {
					if (outer) charge(`${label}.${String(prop)}`, performance.now() - started);
				};
				let result: unknown;
				try {
					result = value.apply(target, args);
				} catch (error) {
					depth--;
					done();
					throw error;
				}
				depth--;
				if (result instanceof Promise) return result.finally(done);
				done();
				return result;
			};
		},
	});
}
const ports = opened.ctx.ports as unknown as Record<string, object>;
for (const key of ["fs", "proc", "net"]) {
	const port = ports[key];
	if (port !== undefined) ports[key] = timed(port, key);
}

interface Sample {
	totalMs: number;
	beforeMs: number;
	residentMs: number;
	jvmMs: number;
	afterMs: number;
	path: string;
	ok: boolean;
	ports: Record<string, Tally>;
}

async function once(): Promise<Sample> {
	// 同一个只读问题连问几次会被「已经问过」拦下；尺子就是要连问，每次先把那本账清掉
	forgetRepeats(opened.ctx);
	tallies.clear();
	const marks: Record<string, number> = {};
	const started = performance.now();
	const onProgress = (stage: string): void => {
		if (marks[stage] === undefined) marks[stage] = performance.now();
	};
	const netBefore = (): number =>
		[...tallies].filter(([key]) => key.startsWith("net.")).reduce((sum, [, tally]) => sum + tally.ms, 0);
	const result = runArgs
		? await run(opened.ctx, runArgs, { onProgress } as never)
		: await probe(opened.ctx, name, { env, countRepeats: false, onProgress } as never);
	const ended = performance.now();
	const checking = marks["checking-resident"] ?? ended;
	const running = marks["running-probe"] ?? ended;
	// 在 JVM 里 = 这次调用里花在网络端口上的时间（发请求到收完答复）；收尾 = 发出之后的其余部分
	const jvmMs = netBefore();
	return {
		totalMs: ended - started,
		beforeMs: checking - started,
		residentMs: running - checking,
		jvmMs,
		afterMs: Math.max(0, ended - running - jvmMs),
		path: result.ok ? String((result.value as { path?: string }).path ?? "") : `失败 ${result.error.code}`,
		ok: result.ok,
		ports: Object.fromEntries(tallies),
	};
}

/** 常驻进程自己记的每次请求那一行：准备（查业务类变没变、建上下文）、编译、运行各多久。 */
interface ServerLine {
	prepareMs: number;
	staleMs: number;
	compileMs: number;
	runMs: number;
	reused: boolean;
}
function serverLines(): ServerLine[] {
	const path = opened.ctx.layout.serverLog;
	if (!existsSync(path)) return [];
	const lines: ServerLine[] = [];
	for (const line of readFileSync(path, "utf8").split("\n")) {
		const hit = /#\d+ \S+ 准备 (\d+) ms（查业务类 (\d+)），编译 (\d+) ms(（沿用[^）]*）)?，运行 (\d+) ms/.exec(line);
		if (hit === null) continue;
		lines.push({
			prepareMs: Number(hit[1]),
			staleMs: Number(hit[2]),
			compileMs: Number(hit[3]),
			runMs: Number(hit[5]),
			reused: hit[4] !== undefined,
		});
	}
	return lines;
}

const warm = await once();
const samples: Sample[] = [];
for (let i = 0; i < repeat; i++) samples.push(await once());
const inServer = serverLines().slice(-repeat);
if (argv.includes("--stop")) await stopServer(opened.ctx);

const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
const stage = (pick: (sample: Sample) => number): number => median(samples.map(pick));
const portKeys = [...new Set(samples.flatMap((sample) => Object.keys(sample.ports)))];
const portRows = portKeys
	.map((key) => ({
		key,
		ms: median(samples.map((sample) => sample.ports[key]?.ms ?? 0)),
		calls: median(samples.map((sample) => sample.ports[key]?.calls ?? 0)),
	}))
	.sort((a, b) => b.ms - a.ms);
const report = {
	project: resolve(project),
	call: runArgs ? `run ${runArgs.join(" ")}` : `${name} ${JSON.stringify(env)}`,
	runtimeKey: opened.ctx.runtimeKeyId,
	firstCall: { totalMs: Math.round(warm.totalMs), path: warm.path },
	repeat,
	paths: [...new Set(samples.map((sample) => sample.path))],
	medianMs: {
		total: Math.round(stage((s) => s.totalMs)),
		before: Math.round(stage((s) => s.beforeMs)),
		resident: Math.round(stage((s) => s.residentMs)),
		jvm: Math.round(stage((s) => s.jvmMs)),
		after: Math.round(stage((s) => s.afterMs)),
	},
	each: samples.map((sample) => Math.round(sample.totalMs)),
	inJvm:
		inServer.length < repeat
			? null
			: {
					prepare: median(inServer.map((line) => line.prepareMs)),
					stale: median(inServer.map((line) => line.staleMs)),
					compile: median(inServer.map((line) => line.compileMs)),
					run: median(inServer.map((line) => line.runMs)),
					reusedCompile: inServer.filter((line) => line.reused).length,
				},
	ports: portRows.slice(0, 12).map((row) => ({ ...row, ms: Math.round(row.ms) })),
};

if (argv.includes("--json")) {
	console.log(JSON.stringify(report, null, 2));
} else {
	const m = report.medianMs;
	console.log(`${report.call}（${report.runtimeKey}）`);
	console.log(`第一次（可能含拉起、加载单据）：${String(report.firstCall.totalMs)} ms，走 ${report.firstCall.path}`);
	console.log(
		`之后 ${String(repeat)} 次，中位 ${String(m.total)} ms（各次 ${report.each.join("、")}；走 ${report.paths.join("/")}）`,
	);
	console.log(
		`  发之前 ${String(m.before)} ms ｜ 查常驻 ${String(m.resident)} ms ｜ 在 JVM 里 ${String(m.jvm)} ms ｜ 收尾 ${String(m.after)} ms`,
	);
	if (report.inJvm !== null) {
		const j = report.inJvm;
		console.log(
			`  JVM 自己记的：准备 ${String(j.prepare)} ms（其中查业务类变没变 ${String(j.stale)} ms）｜ 编译探针 ${String(j.compile)} ms（${String(repeat)} 次里 ${String(j.reusedCompile)} 次沿用上次编好的）｜ 运行 ${String(j.run)} ms`,
		);
	}
	console.log("  按端口分账（中位，最慢的在前）：");
	for (const row of report.ports) {
		console.log(`    ${row.key.padEnd(24)} ${String(row.ms).padStart(6)} ms  ${String(row.calls)} 次`);
	}
}
