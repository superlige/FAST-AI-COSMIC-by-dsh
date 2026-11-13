/**
 * 尺子（真机）：常驻苍穹进程闲置几分钟之后，下一次查询会不会干等。
 *
 * 照「停下来想几分钟再回来」的顺序走一遍：
 *
 *   起常驻进程 → 跑一遍探针（热身，不计）→ 再跑一遍（闲置前，当参照）→ 闲置 N 秒 → 再跑两遍（闲置后）
 *
 * 报：闲置前后每次调用多久；闲置后那段时间里一共几条 SQL、取连接那一步合计多久，
 * 单条 ≥ 3 秒的有几条、共多久、卡在哪一步；连接断开类报错几处。
 *
 * 用法：
 *   node --experimental-strip-types scripts/measure-idle-stall.ts <工程目录> [--idle 330]
 *     [--jvm-opt <-D名=值> …] [--call "<探针> 键=值 键=值" …] [--keep] [--json]
 *
 * - `--jvm-opt` 给常驻进程多加启动参数，比如试连接池借出前探活的窗口；`--idle` 给个几秒就是不闲置的对照。
 * - `--call` 可以给几个，默认是查一张单据的操作清单加按条件查一条数据（都只读）。
 *
 * 会先停掉本版本自己正在跑的常驻进程（启动参数不一样，要重起），跑完默认也停；`--keep` 留着。
 * 只跑只读探针。口径和结果见 `docs/S59-call-overhead-idle-connections.md` §2.3。
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { PRODUCT_ID } from "../src/brand.ts";
import { probe } from "../src/kernel/commands/probe.ts";
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
		'用法：measure-idle-stall.ts <工程目录> [--idle 330] [--jvm-opt <-D名=值> …] [--call "<探针> 键=值 …" …] [--keep] [--json]',
	);
	process.exit(2);
}
const idleSeconds = Number(one("--idle") ?? "330");

interface Call {
	name: string;
	env: Record<string, string>;
}
const DEFAULT_CALLS = [
	"OpMetaProbe OP_ENTITY=bos_user",
	"DataQueryProbe QUERY_ENTITY=bos_user QUERY_FIELDS=id,number,name QUERY_LIMIT=1",
];
const calls: Call[] = (many("--call").length > 0 ? many("--call") : DEFAULT_CALLS).map((text) => {
	const [name, ...pairs] = text.split(/\s+/).filter(Boolean);
	const env: Record<string, string> = {};
	for (const pair of pairs) {
		const eq = pair.indexOf("=");
		if (eq > 0) env[pair.slice(0, eq)] = pair.slice(eq + 1);
	}
	if ("APPLY" in env) {
		console.error("这把尺子只跑只读探针。");
		process.exit(2);
	}
	return { name: name as string, env };
});

// 常驻进程的启动参数走 JAVA_TOOL_OPTIONS（内核只把名单上的环境变量传给苍穹进程，这一项在名单上）
const jvmOpts = [...many("--jvm-opt")];
if (jvmOpts.length > 0) {
	process.env.JAVA_TOOL_OPTIONS = [process.env.JAVA_TOOL_OPTIONS ?? "", ...jvmOpts].join(" ").trim();
}

const opened = await openProject({
	projectRoot: resolve(project),
	agentConfigDir: join(homedir(), `.${PRODUCT_ID}`),
	cacheRoot: join(homedir(), `.${PRODUCT_ID}`, "cache"),
	agentVersion: "0.0.0-dev",
	resources: EMBEDDED_RESOURCES,
});
const ctx = opened.ctx;
const say = (text: string): void => {
	if (!argv.includes("--json")) console.error(`[${new Date().toTimeString().slice(0, 8)}] ${text}`);
};

interface Sample {
	call: string;
	ms: number;
	path: string;
}
async function round(label: string): Promise<Sample[]> {
	const out: Sample[] = [];
	for (const call of calls) {
		forgetRepeats(ctx);
		const started = performance.now();
		const result = await probe(ctx, call.name, { env: call.env, countRepeats: false } as never);
		const ms = performance.now() - started;
		const path = result.ok
			? `${String((result.value as { path?: string }).path ?? "")}${(result.value as { exitCode?: number }).exitCode === 0 ? "" : " 退出码非 0"}`
			: `失败 ${result.error.code}`;
		out.push({ call: call.name, ms, path });
		say(`${label}　${call.name}　${(ms / 1000).toFixed(1)} 秒　${path}`);
	}
	return out;
}

await stopServer(ctx);
say(`常驻进程版本 ${ctx.runtimeKeyId}${jvmOpts.length > 0 ? `　启动参数 ${jvmOpts.join(" ")}` : ""}`);
const warm = await round("热身（含起进程）");
const before = await round("闲置前");
const idleFrom = Date.now();
say(`闲置 ${String(idleSeconds)} 秒……`);
await new Promise((done) => setTimeout(done, idleSeconds * 1000));
const idleTo = Date.now();
const after1 = await round("闲置后第 1 遍");
const after2 = await round("闲置后第 2 遍");
const endedAt = Date.now();

// 从常驻进程的日志里读：闲置之后那一段的 SQL、断开类报错
const COST = /^#cost:(\d+)ms,time is:(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}), include\(([^)]*)/;
const logs = [ctx.layout.serverLog];
const runsDir = join(ctx.layout.agentCache, "probe-runs");
if (existsSync(runsDir))
	for (const name of readdirSync(runsDir)) if (name.endsWith(".out")) logs.push(join(runsDir, name));
const seen = new Set<string>();
const stalls: { when: string; ms: number; step: string }[] = [];
let sqlAfterIdle = 0;
let sqlMsAfterIdle = 0;
/** 闲置后那些 SQL 里「取连接」那一步合计：连接池借出前探活的那一趟来回 */
let getConnectionMsAfterIdle = 0;
let lost = 0;
for (const path of logs) {
	if (!existsSync(path)) continue;
	let stampMs = 0;
	for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
		const stamp = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3})\s/.exec(line);
		if (stamp?.[1] !== undefined) stampMs = new Date(stamp[1].replace(" ", "T")).getTime();
		if (
			stampMs >= idleTo &&
			/Failed to validate connection|Communications link failure|No operations allowed after connection closed/.test(
				line,
			)
		) {
			lost += 1;
		}
		const hit = COST.exec(line);
		if (hit === null || seen.has(line)) continue;
		seen.add(line);
		const at = new Date((hit[2] as string).replace(" ", "T")).getTime();
		const ms = Number(hit[1]);
		// 这条 SQL 是 at 时刻结束的；闲置之后才结束的才算
		if (at < idleTo || at > endedAt + 1000) continue;
		sqlAfterIdle += 1;
		sqlMsAfterIdle += ms;
		getConnectionMsAfterIdle += Number(/getconnection:(\d+)ms/.exec(hit[3] as string)?.[1] ?? 0);
		if (ms >= 3000) {
			const worst = (hit[3] as string)
				.split(",")
				.map((part) => /^\s*([\w.]+):(\d+)ms/.exec(part))
				.filter((pair): pair is RegExpExecArray => pair !== null)
				.sort((a, b) => Number(b[2]) - Number(a[2]))[0];
			stalls.push({ when: hit[2] as string, ms, step: worst?.[1] ?? "?" });
		}
	}
}
if (!argv.includes("--keep")) await stopServer(ctx);

const sum = (samples: readonly Sample[]): number => samples.reduce((total, sample) => total + sample.ms, 0);
const report = {
	project: resolve(project),
	runtimeKey: ctx.runtimeKeyId,
	jvmOpts,
	idleSeconds: Math.round((idleTo - idleFrom) / 1000),
	calls: calls.map((call) => call.name),
	warmMs: Math.round(sum(warm)),
	beforeMs: before.map((sample) => Math.round(sample.ms)),
	afterFirstMs: after1.map((sample) => Math.round(sample.ms)),
	afterSecondMs: after2.map((sample) => Math.round(sample.ms)),
	paths: [...new Set([...before, ...after1, ...after2].map((sample) => sample.path))],
	afterIdle: {
		sql: sqlAfterIdle,
		sqlMs: sqlMsAfterIdle,
		getConnectionMs: getConnectionMsAfterIdle,
		stalls,
		lostConnectionLines: lost,
	},
};
if (argv.includes("--json")) {
	console.log(JSON.stringify(report, null, 2));
} else {
	const sec = (ms: number): string => (ms / 1000).toFixed(1);
	const list = (all: readonly number[]): string => all.map(sec).join(" + ");
	console.log(`闲置 ${String(report.idleSeconds)} 秒　探针：${report.calls.join("、")}`);
	console.log(`  闲置前　${list(report.beforeMs)} 秒`);
	console.log(
		`  闲置后第 1 遍　${list(report.afterFirstMs)} 秒；第 2 遍　${list(report.afterSecondMs)} 秒　（${report.paths.join(" / ")}）`,
	);
	console.log(
		`  闲置后这两遍一共 ${String(sqlAfterIdle)} 条 SQL、${sec(sqlMsAfterIdle)} 秒（取连接那一步 ${sec(getConnectionMsAfterIdle)} 秒）；其中单条 ≥ 3 秒的 ${String(stalls.length)} 条、共 ${sec(stalls.reduce((total, stall) => total + stall.ms, 0))} 秒；连接断开类报错 ${String(lost)} 处`,
	);
	for (const stall of stalls) console.log(`    ${stall.when}　${sec(stall.ms)} 秒，卡在 ${stall.step}`);
}
