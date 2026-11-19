/**
 * 尺子：会话里「想看上一次运行的日志」这件事，实际发生了什么。
 *
 *   node scripts/measure-raw-reads.mjs <会话.jsonl…>
 *   node scripts/measure-raw-reads.mjs --dir <会话目录> [--from 2026-09-25] [--show]
 *
 * 只看 cosmic_run、cosmic_probe、cosmic_meta 三个带 raw 的工具，按「同一调用」（工具名加去掉 raw、cold 的参数）配对：
 *
 *  - **看日志变成重跑**：带 raw=true 的调用，前面同一调用已经跑过一次，这一次却又真跑了一遍
 *    （返回里有 exitCode，不是取回）。分开数：其中会落库的（run 的 op、form 等，造数改数探针）几次、
 *    重跑后结果和上一次不一样的几次、把上一次的通过记录顶掉的几次、一共多花多少秒。
 *  - **关键字没搜到完整日志**：raw 写关键字取回、0 行符合，而上一次运行的返回里说过有折叠的运行时日志
 *    （「完整运行时日志在 raw 通道」）。再用同一个关键字去那次运行落盘的完整日志里数一遍，
 *    数得到就是「日志里有、取回说没有」。落盘文件只留最近 40 份，文件不在的记成「没法复核」。
 *  - 头一回就带 raw=true 的调用是正常执行，只报个数，不算问题。
 *
 * 只读：只读会话文件和落盘日志，不连环境。口径和基线见 `docs/S56-raw-reads-log.md` §2。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const TOOLS = new Set(["cosmic_run", "cosmic_probe", "cosmic_meta"]);
const args = process.argv.slice(2);
const files = [];
let dir = null;
let from = null;
let show = false;
for (let i = 0; i < args.length; i++) {
	const arg = args[i];
	if (arg === "--dir") dir = args[++i];
	else if (arg === "--from") from = args[++i];
	else if (arg === "--show") show = true;
	else files.push(arg);
}
if (dir !== null) {
	for (const name of readdirSync(dir).sort()) {
		if (!name.endsWith(".jsonl")) continue;
		if (from !== null && name.slice(0, 10) < from) continue;
		files.push(join(dir, name));
	}
}
if (files.length === 0) {
	console.error("用法：measure-raw-reads.mjs <会话.jsonl…> | --dir <会话目录> [--from 日期] [--show]");
	process.exit(2);
}

/** 和 extension.ts 的 pickKeyOf 同一个意思：去掉 raw、cold、空数组、空对象。 */
function keyOf(tool, params) {
	const rest = Object.entries(params ?? {})
		.filter(
			([key, value]) =>
				key !== "raw" &&
				key !== "cold" &&
				value !== undefined &&
				value !== null &&
				!(Array.isArray(value) && value.length === 0) &&
				!(typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0),
		)
		.sort(([a], [b]) => (a < b ? -1 : 1));
	return `${tool} ${JSON.stringify(rest)}`;
}

const rawFlag = (raw) => raw === true || (typeof raw === "string" && raw.trim().toLowerCase() === "true");

/** 这次调用真跑的话会不会落库。 */
function commits(tool, params) {
	if (tool === "cosmic_run") {
		const kind = Array.isArray(params.argv) ? params.argv[0] : "";
		return ["op", "form", "list", "callback", "flow", "wf"].includes(kind);
	}
	if (tool === "cosmic_probe") {
		const env = params.env ?? {};
		if (env.PREVIEW === "1") return false;
		return env.APPLY === "1" || /^Data(Seed|Update)Probe$/.test(String(params.name ?? ""));
	}
	return false;
}

function parseResult(message) {
	const first = (message.content ?? []).find((c) => c.type === "text")?.text ?? "";
	try {
		return JSON.parse(first);
	} catch {
		return null;
	}
}

/** 结果里探针那一层：run、probe 在顶层，meta 在 probe 下面。 */
const carrierOf = (result) => (result !== null && typeof result?.probe === "object" ? result.probe : result);

function logFileOf(envelope) {
	const filed = envelope?.result?.evidence?.filed;
	if (Array.isArray(filed) && typeof filed[0]?.log === "string") return filed[0].log;
	return null;
}

function countIn(file, spec) {
	if (file === null || !existsSync(file)) return null;
	let pattern;
	try {
		pattern = new RegExp(spec.trim(), "iu");
	} catch {
		pattern = new RegExp(spec.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu");
	}
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => pattern.test(line)).length;
}

const total = {
	sessions: 0,
	withRaw: 0,
	firstRunRaw: 0,
	rerunForLog: 0,
	rerunCommits: 0,
	rerunChanged: 0,
	rerunOverturned: 0,
	rerunSeconds: 0,
	picks: 0,
	pickZero: 0,
	pickZeroFolded: 0,
	pickZeroInLog: 0,
	pickZeroUnknown: 0,
};
const rows = [];

for (const file of files) {
	const calls = new Map();
	/** 同一调用最近一次真跑的结果。 */
	const lastRun = new Map();
	let used = false;
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (line === "") continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		const message = entry.message;
		if (!message) continue;
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const part of message.content) {
				if (part.type !== "toolCall" || !TOOLS.has(part.name)) continue;
				calls.set(part.id, { tool: part.name, params: part.arguments ?? {}, at: Date.parse(entry.timestamp) });
			}
			continue;
		}
		if (message.role !== "toolResult" || !calls.has(message.toolCallId)) continue;
		const call = calls.get(message.toolCallId);
		const envelope = parseResult(message);
		if (envelope === null) continue;
		const key = keyOf(call.tool, call.params);
		const raw = call.params.raw;
		const result = envelope.result ?? null;
		const picked = result?.action === "pick";
		const ran = !picked && typeof carrierOf(result)?.exitCode === "number";
		const seconds = (message.durationMs ?? Date.parse(entry.timestamp) - call.at) / 1000;
		const name = file.split(/[\\/]/).pop().slice(0, 19);
		const what = call.tool === "cosmic_probe" ? call.params.name : (call.params.argv ?? []).slice(0, 3).join(" ");

		if (raw !== undefined) {
			used = true;
			total.withRaw++;
		}
		if (rawFlag(raw) && ran) {
			const before = lastRun.get(key);
			if (before === undefined) {
				total.firstRunRaw++;
			} else {
				total.rerunForLog++;
				total.rerunSeconds += seconds;
				const commit = commits(call.tool, call.params);
				const changed = before.ok !== envelope.ok;
				const overturned = JSON.stringify(result?.notes ?? []).includes("顶掉");
				if (commit) total.rerunCommits++;
				if (changed) total.rerunChanged++;
				if (overturned) total.rerunOverturned++;
				rows.push(
					`${name}  看日志变成重跑  ${call.tool} ${what}  ${seconds.toFixed(1)}s` +
						`${commit ? "  会落库" : ""}${changed ? `  结果变了（${before.ok ? "过" : "没过"}→${envelope.ok ? "过" : "没过"}）` : ""}${overturned ? "  顶掉了通过记录" : ""}`,
				);
			}
		}
		if (typeof raw === "string" && !rawFlag(raw) && picked && result.ran !== true) {
			total.picks++;
			if (result.matched === 0) {
				total.pickZero++;
				const before = lastRun.get(key);
				if (before?.folded === true) {
					total.pickZeroFolded++;
					const inLog = countIn(before.log, raw);
					if (inLog === null) total.pickZeroUnknown++;
					else if (inLog > 0) total.pickZeroInLog++;
					rows.push(
						`${name}  关键字没搜到完整日志  ${call.tool} ${what}  raw=${JSON.stringify(raw)}  ` +
							`${inLog === null ? "落盘日志已不在，没法复核" : `完整日志里符合 ${String(inLog)} 行`}`,
					);
				}
			}
		}
		if (ran) {
			lastRun.set(key, {
				ok: envelope.ok === true,
				folded: JSON.stringify(carrierOf(result)?.notes ?? []).includes("完整运行时日志在 raw 通道"),
				log: logFileOf(envelope),
			});
		}
	}
	if (used) total.sessions++;
}

if (show) for (const row of rows) console.log(row);
console.log(
	[
		`会话 ${String(files.length)} 份，其中用过 raw 的 ${String(total.sessions)} 份，带 raw 的调用 ${String(total.withRaw)} 次`,
		`头一回就带 raw=true（正常执行）：${String(total.firstRunRaw)} 次`,
		`看日志变成重跑：${String(total.rerunForLog)} 次，共 ${total.rerunSeconds.toFixed(1)} 秒；` +
			`其中会落库的 ${String(total.rerunCommits)} 次、结果和上一次不一样的 ${String(total.rerunChanged)} 次、顶掉通过记录的 ${String(total.rerunOverturned)} 次`,
		`按关键字或行号取回：${String(total.picks)} 次，0 行符合的 ${String(total.pickZero)} 次；` +
			`其中上一次运行有折叠日志的 ${String(total.pickZeroFolded)} 次` +
			`（完整日志里其实有的 ${String(total.pickZeroInLog)} 次、没法复核的 ${String(total.pickZeroUnknown)} 次）`,
	].join("\n"),
);
