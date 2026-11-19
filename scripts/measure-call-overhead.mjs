/**
 * 尺子：一次 cosmic 工具调用，整次多久、其中在常驻苍穹进程里多久，剩下的就是我们自己这一侧花的。
 *
 *   node scripts/measure-call-overhead.mjs <会话.jsonl…> [--cache <缓存根>] [--show] [--json]
 *   node scripts/measure-call-overhead.mjs --dir <会话目录> [--from 日期] [--to 日期] [--cache <缓存根>]
 *
 * - 「整次」是会话里 pi 记的工具运行时长（从工具开跑到返回，含重开工程、发请求前的检查、收尾）。
 * - 「进程里」是常驻进程自己在日志里记的那一行（准备 + 编译探针 + 运行），日志在缓存目录各版本的 probe-server.log。
 * - 「进程外」= 整次 − 进程里：重开工程（扫苍穹运行时）、查源码新不新鲜、请求来回、整理输出、归档证据……
 *   全是工具自己花的，和苍穹、数据库无关。
 * - 不进常驻进程的工具（查关系表、看验证记录、打开工程……）整次都是进程外，单列。
 *
 * 怎么对上：日志行带「收到」时刻的按时刻对（落在这次调用的起止之间）；老版本的日志行不带时刻，
 * 按探针名的先后顺序对，对上的条数单独报，顺序对不保证每条都准，只看中位和合计。
 * 走冷进程的、被拒没进进程的、日志已经不在的，算「没对上」，不进统计；顺带现起了常驻进程的那次调用单列，也不进统计。
 *
 * 只读：只读会话文件和缓存目录里的日志。口径和基线见 `docs/S59-call-overhead-idle-connections.md` §2.2。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const argv = process.argv.slice(2);
const one = (name) => {
	const at = argv.indexOf(name);
	return at >= 0 ? argv[at + 1] : undefined;
};
const flag = (name) => argv.includes(name);
const valued = new Set(["--cache", "--dir", "--from", "--to"]);
const files = [];
for (let i = 0; i < argv.length; i++) {
	const arg = argv[i];
	if (valued.has(arg)) i += 1;
	else if (!arg.startsWith("--")) files.push(arg);
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
	console.error("用法：node scripts/measure-call-overhead.mjs <会话.jsonl…> [--cache <缓存根>] [--show] [--json]");
	process.exit(2);
}
const cacheRoots = one("--cache")
	? [one("--cache")]
	: [join(homedir(), ".fast-ai-cosmic", "cache"), join(homedir(), ".cosmic", "cache")];

const REQUEST_LINE =
	/#(\d+) (\S+) 准备 (\d+) ms（查业务类 \d+），编译 (\d+) ms(?:（沿用[^）]*）)?，运行 (\d+) ms(?:，(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}) 收到)?/;

/** 一个版本的常驻进程日志里记的每次请求。 */
function requestsOf(keyId) {
	const out = [];
	for (const root of cacheRoots) {
		const keyDir = join(root, keyId);
		if (!existsSync(keyDir)) continue;
		for (const name of readdirSync(keyDir).sort()) {
			if (!/^probe-server.*\.log$/.test(name)) continue;
			for (const line of readFileSync(join(keyDir, name), "utf8").split(/\r?\n/)) {
				const hit = REQUEST_LINE.exec(line);
				if (hit === null) continue;
				out.push({
					cls: hit[2],
					insideMs: Number(hit[3]) + Number(hit[4]) + Number(hit[5]),
					compileMs: Number(hit[4]),
					at: hit[6] === undefined ? null : new Date(hit[6].replace(" ", "T")).getTime(),
					used: false,
				});
			}
		}
	}
	return out;
}

/** 探针入参里的名字：已发布的是类名，临时的是 .java 路径。 */
function probeClass(name) {
	return basename(String(name ?? "")).replace(/\.java$/, "");
}

function median(values) {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const calls = [];
for (const file of files) {
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
	const args = new Map();
	for (const entry of lines) {
		const message = entry.message;
		if (!message) continue;
		if (message.role === "assistant") {
			for (const part of message.content ?? [])
				if (part.type === "toolCall") args.set(part.id, part.arguments ?? {});
			continue;
		}
		if (message.role !== "toolResult" || !/^cosmic_/.test(message.toolName ?? "")) continue;
		const text = (message.content ?? []).map((part) => part.text ?? "").join("");
		const input = args.get(message.toolCallId) ?? {};
		const durationMs = message.durationMs ?? 0;
		const endedAt = message.timestamp ?? Date.parse(entry.timestamp);
		const path = /"path":"(\w+)"/.exec(text.slice(0, 400))?.[1] ?? null;
		const ranProbe = /"probe":"([^"]+)"/.exec(text.slice(0, 400))?.[1] ?? null;
		// 取日志片段、看用法、查状态：没跑探针，也不重开工程以外的事
		const light = input.raw !== undefined || input.argv?.[0] === "help" || durationMs < 300;
		calls.push({
			file: basename(file),
			tool: message.toolName,
			keyId: message.details?.state?.project?.runtimeKeyId ?? null,
			durationMs,
			endedAt,
			path,
			// 这次调用顺带把常驻进程起起来了（半分钟到一分多钟）：单列，不混进「进程外」
			startedJvm: /常驻 JVM 没在跑，正在拉起/.test(text.slice(0, 1200)),
			cls: message.toolName === "cosmic_probe" ? probeClass(input.name) : ranProbe,
			light,
			label:
				message.toolName === "cosmic_run"
					? (input.argv ?? []).slice(0, 3).join(" ")
					: message.toolName === "cosmic_probe"
						? probeClass(input.name)
						: (input.action ?? ""),
		});
	}
}

// 对上常驻进程日志里的那一行
const byKey = new Map();
for (const call of calls) {
	if (call.path !== "hot" || call.keyId === null || call.cls === null) continue;
	if (!byKey.has(call.keyId)) byKey.set(call.keyId, requestsOf(call.keyId));
	const requests = byKey.get(call.keyId);
	const startedAt = call.endedAt - call.durationMs;
	let hit = requests.find(
		(request) =>
			!request.used &&
			request.at !== null &&
			request.cls === call.cls &&
			request.at >= startedAt - 500 &&
			request.at <= call.endedAt,
	);
	let how = "time";
	if (hit === undefined) {
		// 老日志不带时刻：按先后顺序，取这个探针名下一条还没用过的、而且进程里的时间不超过整次的
		const cursor = requests.cursor ?? 0;
		for (let i = cursor; i < requests.length; i++) {
			const request = requests[i];
			if (request.used || request.at !== null) continue;
			if (request.cls === call.cls && request.insideMs <= call.durationMs + 50) {
				hit = request;
				requests.cursor = i + 1;
				how = "order";
				break;
			}
		}
	}
	if (hit !== undefined) {
		hit.used = true;
		call.insideMs = hit.insideMs;
		call.compileMs = hit.compileMs;
		call.matched = how;
	}
}

const counted = (call) => call.insideMs !== undefined && !call.startedJvm;
const kinds = [
	["查询类探针（cosmic_probe）", (call) => call.tool === "cosmic_probe" && counted(call)],
	["跑操作、表单、调用（cosmic_run）", (call) => call.tool === "cosmic_run" && counted(call)],
	["别的进常驻进程的工具", (call) => !/^cosmic_(probe|run)$/.test(call.tool) && counted(call)],
];
const rows = kinds
	.map(([label, pick]) => {
		const group = calls.filter(pick);
		const outside = group.map((call) => call.durationMs - call.insideMs);
		return {
			label,
			calls: group.length,
			byTime: group.filter((call) => call.matched === "time").length,
			totalMedianMs: Math.round(median(group.map((call) => call.durationMs))),
			insideMedianMs: Math.round(median(group.map((call) => call.insideMs))),
			outsideMedianMs: Math.round(median(outside)),
			outsideSumMs: Math.round(outside.reduce((sum, ms) => sum + ms, 0)),
			totalSumMs: group.reduce((sum, call) => sum + call.durationMs, 0),
		};
	})
	.filter((row) => row.calls > 0);

// 不进常驻进程的工具：整次都是进程外
const noJvm = new Map();
for (const call of calls) {
	if (call.insideMs !== undefined || call.path !== null || call.light) continue;
	if (!noJvm.has(call.tool)) noJvm.set(call.tool, []);
	noJvm.get(call.tool).push(call.durationMs);
}
const noJvmRows = [...noJvm.entries()]
	.map(([tool, all]) => ({
		tool,
		calls: all.length,
		medianMs: Math.round(median(all)),
		sumMs: all.reduce((sum, ms) => sum + ms, 0),
	}))
	.sort((a, b) => b.sumMs - a.sumMs);

const hot = calls.filter((call) => call.path === "hot");
const report = {
	sessions: files.length,
	cosmicCalls: calls.length,
	hotCalls: hot.length,
	matched: hot.filter((call) => call.insideMs !== undefined).length,
	matchedByTime: hot.filter((call) => call.matched === "time").length,
	coldCalls: calls.filter((call) => call.path === "cold").length,
	startedJvm: hot.filter((call) => call.startedJvm).map((call) => call.durationMs),
	rows,
	noJvm: noJvmRows,
	outsideSumMs: rows.reduce((sum, row) => sum + row.outsideSumMs, 0),
};

if (flag("--json")) {
	console.log(JSON.stringify(report, null, 2));
} else {
	const sec = (ms) => (ms / 1000).toFixed(1);
	console.log(
		`${String(report.sessions)} 份会话，cosmic 工具调用 ${String(report.cosmicCalls)} 次；搭常驻进程 ${String(report.hotCalls)} 次，` +
			`和进程日志对上 ${String(report.matched)} 次（按时刻 ${String(report.matchedByTime)}、按顺序 ${String(report.matched - report.matchedByTime)}）；走冷进程 ${String(report.coldCalls)} 次` +
			(report.startedJvm.length > 0
				? `；另有 ${String(report.startedJvm.length)} 次顺带现起了常驻进程（整次 ${report.startedJvm.map(sec).join("、")} 秒），不计入下面`
				: ""),
	);
	for (const row of rows) {
		console.log(
			`  ${row.label}　${String(row.calls)} 次　整次中位 ${sec(row.totalMedianMs)} 秒 ＝ 进程里 ${sec(row.insideMedianMs)} ＋ 进程外 ${sec(row.outsideMedianMs)}　` +
				`｜进程外合计 ${sec(row.outsideSumMs)} 秒（整次合计 ${sec(row.totalSumMs)} 秒）`,
		);
	}
	if (noJvmRows.length > 0) {
		console.log("  不进常驻进程的工具（整次都是工具自己花的，编译这类本来就要花；0.3 秒以内的不计）：");
		for (const row of noJvmRows) {
			console.log(
				`    ${row.tool.padEnd(22)} ${String(row.calls).padStart(3)} 次　中位 ${sec(row.medianMs)} 秒　合计 ${sec(row.sumMs)} 秒`,
			);
		}
	}
	console.log(`  搭常驻进程的调用，进程外一共 ${sec(report.outsideSumMs)} 秒`);
	if (flag("--show")) {
		for (const call of calls) {
			if (!counted(call)) continue;
			console.log(
				`    ${new Date(call.endedAt).toISOString().slice(11, 19)} ${call.tool.padEnd(13)} 整次 ${sec(call.durationMs).padStart(5)} 进程里 ${sec(call.insideMs).padStart(5)} 进程外 ${sec(call.durationMs - call.insideMs).padStart(5)}  ${call.label}`,
			);
		}
	}
}
