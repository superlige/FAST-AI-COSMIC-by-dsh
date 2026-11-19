/**
 * 尺子：如果常驻苍穹进程能同时跑几个请求，会话里最多能省多少时间。
 *
 *   node scripts/measure-parallel-potential.mjs <会话.jsonl…> [--show] [--json]
 *   node scripts/measure-parallel-potential.mjs --dir <会话目录> [--from 日期] [--to 日期] [--min-calls 20]
 *
 * 现在 cosmic 的工具一个接一个跑，常驻进程一次也只跑一个请求。能并行的前提是模型在同一轮里一口气发了几个调用，
 * 所以这把尺子数的是：
 *
 * - 模型一共发了几轮带工具调用的，其中一轮里有 2 个以上 cosmic 探针 / 运行调用的有几轮；
 * - 这些轮里的调用一个接一个跑用了多久（各次时长相加），全部同时跑最少要多久（最长的那一次），差就是**上限**；
 * - 上限分两档：只让只读探针同时跑（`cosmic_probe` 且不带 APPLY）；探针和运行都同时跑；
 * - 和整份会话的工具时间、模型加工具干活的时间（人离开的时间不算）放在一起看占多少。
 *
 * 这是上限，不是能拿到的数：同时跑的请求会抢同一个数据库、同一批连接，实际比「最长的那一次」慢；
 * 模型看到工具变快后会不会多发并行调用，这把尺子也量不出。
 *
 * 只读：只读会话文件。口径和基线见 `docs/S59-call-overhead-idle-connections.md` §7。
 */
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

const argv = process.argv.slice(2);
const one = (name) => {
	const at = argv.indexOf(name);
	return at >= 0 ? argv[at + 1] : undefined;
};
const flag = (name) => argv.includes(name);
const valued = new Set(["--dir", "--from", "--to", "--min-calls"]);
const files = [];
for (let i = 0; i < argv.length; i++) {
	if (valued.has(argv[i])) i += 1;
	else if (!argv[i].startsWith("--")) files.push(argv[i]);
}
const dir = one("--dir");
if (dir !== undefined) {
	const from = one("--from") ?? "";
	const to = one("--to") ?? "9999";
	for (const name of readdirSync(dir).sort()) {
		if (!name.endsWith(".jsonl")) continue;
		const day = name.slice(0, 10);
		if (day >= from && day <= to) files.push(join(dir, name));
	}
}
if (files.length === 0) {
	console.error(
		"用法：node scripts/measure-parallel-potential.mjs <会话.jsonl…> | --dir <会话目录> [--from 日期] [--show]",
	);
	process.exit(2);
}
const minCalls = Number(one("--min-calls") ?? "0");

const isJvmCall = (call) => call.tool === "cosmic_probe" || call.tool === "cosmic_run";
const isReadOnlyProbe = (call) => call.tool === "cosmic_probe" && !("APPLY" in (call.args.env ?? {}));
const sum = (values) => values.reduce((total, value) => total + value, 0);
/** 一组调用一个接一个跑和同时跑的差：各次相加 − 最长的一次。少于两个就是 0。 */
const saved = (group) => (group.length < 2 ? 0 : sum(group.map((c) => c.ms)) - Math.max(...group.map((c) => c.ms)));

function measure(file) {
	const lines = readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			try {
				return JSON.parse(line);
			} catch {
				return null;
			}
		})
		.filter(Boolean);
	const results = new Map();
	// 干活的时间 = 模型每次出话用的时间 + 工具跑的时间，都取记录里记的时长；人离开的时间不在里面
	let modelMs = 0;
	for (const entry of lines) {
		const message = entry.message;
		if (message?.role === "assistant") modelMs += message.durationMs ?? 0;
		if (message?.role === "toolResult") {
			const text = (message.content ?? []).map((part) => part.text ?? "").join("");
			results.set(message.toolCallId, {
				ms: message.durationMs ?? 0,
				// 被拒在门外没进进程的、取回上一次日志的，不占常驻进程
				hot: /"path":"hot"/.test(text.slice(0, 400)),
			});
		}
	}
	const turns = [];
	for (const entry of lines) {
		const message = entry.message;
		if (message?.role !== "assistant") continue;
		const calls = (message.content ?? [])
			.filter((part) => part.type === "toolCall")
			.map((part) => ({
				tool: part.name,
				args: part.arguments ?? {},
				ms: results.get(part.id)?.ms ?? 0,
				hot: results.get(part.id)?.hot ?? false,
			}));
		if (calls.length > 0) turns.push(calls);
	}
	const allCalls = turns.flat();
	const multi = turns.filter((calls) => calls.length >= 2);
	const jvmTurns = turns.map((calls) => calls.filter((call) => isJvmCall(call) && call.hot));
	const multiJvm = jvmTurns.filter((calls) => calls.length >= 2);
	return {
		file: basename(file),
		modelMs,
		turns: turns.length,
		calls: allCalls.length,
		toolMs: sum(allCalls.map((call) => call.ms)),
		jvmCalls: allCalls.filter((call) => isJvmCall(call) && call.hot).length,
		jvmMs: sum(allCalls.filter((call) => isJvmCall(call) && call.hot).map((call) => call.ms)),
		multiTurns: multi.length,
		multiJvmTurns: multiJvm.length,
		callsInMultiJvmTurns: sum(multiJvm.map((calls) => calls.length)),
		serialMs: sum(multiJvm.map((calls) => sum(calls.map((call) => call.ms)))),
		savedAllMs: sum(multiJvm.map(saved)),
		savedReadOnlyMs: sum(jvmTurns.map((calls) => saved(calls.filter(isReadOnlyProbe)))),
		batches: multiJvm.map((calls) =>
			calls.map((call) => ({
				label:
					call.tool === "cosmic_run"
						? `run ${(call.args.argv ?? []).slice(0, 3).join(" ")}`
						: `${basename(String(call.args.name ?? "")).replace(/\.java$/, "")}${isReadOnlyProbe(call) ? "" : "（写）"}`,
				ms: call.ms,
			})),
		),
	};
}

const measured = files.map(measure).filter((report) => report.calls >= minCalls);
// 老版本的会话不记工具时长，算不了，单独报个数
const reports = measured.filter((report) => report.toolMs > 0);
const untimed = measured.length - reports.length;
const total = (pick) => sum(reports.map(pick));
const summary = {
	sessions: reports.length,
	activeMs: total((r) => r.modelMs + r.toolMs),
	turns: total((r) => r.turns),
	calls: total((r) => r.calls),
	toolMs: total((r) => r.toolMs),
	jvmCalls: total((r) => r.jvmCalls),
	jvmMs: total((r) => r.jvmMs),
	multiTurns: total((r) => r.multiTurns),
	multiJvmTurns: total((r) => r.multiJvmTurns),
	callsInMultiJvmTurns: total((r) => r.callsInMultiJvmTurns),
	serialMs: total((r) => r.serialMs),
	savedAllMs: total((r) => r.savedAllMs),
	savedReadOnlyMs: total((r) => r.savedReadOnlyMs),
};

if (flag("--json")) {
	console.log(JSON.stringify({ summary, sessions: reports }, null, 2));
} else {
	const min = (ms) => (ms / 60000).toFixed(1);
	const sec = (ms) => (ms / 1000).toFixed(1);
	const share = (part, whole) => (whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "0%");
	console.log(
		`${String(summary.sessions)} 份会话${untimed > 0 ? `（另有 ${String(untimed)} 份没记工具时长，不算）` : ""}，模型和工具干活 ${min(summary.activeMs)} 分钟（人离开的时间不算）；带工具调用的 ${String(summary.turns)} 轮、${String(summary.calls)} 次调用，工具一共跑了 ${min(summary.toolMs)} 分钟`,
	);
	console.log(`  搭常驻进程的探针和运行 ${String(summary.jvmCalls)} 次，共 ${min(summary.jvmMs)} 分钟`);
	console.log(
		`  一轮里发 2 个以上调用的 ${String(summary.multiTurns)} 轮；其中有 2 个以上探针 / 运行的 ${String(summary.multiJvmTurns)} 轮（${String(summary.callsInMultiJvmTurns)} 次调用，一个接一个跑了 ${sec(summary.serialMs)} 秒）`,
	);
	console.log(
		`  全部同时跑最多省 ${sec(summary.savedAllMs)} 秒：占工具时间 ${share(summary.savedAllMs, summary.toolMs)}、占干活时间 ${share(summary.savedAllMs, summary.activeMs)}`,
	);
	console.log(
		`  只让只读探针同时跑最多省 ${sec(summary.savedReadOnlyMs)} 秒：占工具时间 ${share(summary.savedReadOnlyMs, summary.toolMs)}、占干活时间 ${share(summary.savedReadOnlyMs, summary.activeMs)}`,
	);
	if (flag("--show")) {
		for (const report of reports) {
			if (report.batches.length === 0) continue;
			console.log(`  ${report.file}`);
			for (const batch of report.batches) {
				console.log(`    ${batch.map((call) => `${call.label} ${sec(call.ms)}`).join(" ＋ ")}`);
			}
		}
	}
}
