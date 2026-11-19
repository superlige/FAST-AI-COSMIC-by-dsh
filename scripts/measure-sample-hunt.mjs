#!/usr/bin/env node
/**
 * 找测试数据花了多少：每份会话里查数据、写临时探针查数据、造数改数各几次，占多少时间，查出 0 条后有没有紧跟着换写法重查。
 *
 * 用法：node scripts/measure-sample-hunt.mjs <会话目录或 .jsonl>… [--min-bytes 150000] [--json]
 *
 * S37 批 7 立项时写的（2026-09-28，用户："我要的是解决模型因为找不到测试数据纠结原地踏步的问题"）。口径：
 *   - 查数据：`DataQueryProbe`（带断言的不算）；带 `@上游 / @下游 / @流程` 的另记一栏；
 *   - 临时探针查数据：同一会话里写过的 .java 临时探针，源码里调了查询、单据转换关系或工作流的读方法；
 *     按它碰的是什么分三类：flow（工作流 / wf_ 表）、link（单据转换关系）、other（其余，多是按分录、配置挑单）；
 *   - 造数改数：`DataSeedProbe`、`DataUpdateProbe`；
 *   - 时间：一轮（一条 assistant 消息）的模型时间加工具时间，按这一轮里上面三类调用占的比例记；
 *   - 0 条重查：`DataQueryProbe` 查出 0 条，下一次数据调用又查同一张单、或者去跑临时探针；
 *   - 最长连续：上面三类调用连着出现的最长一串，写业务代码或带断言的运行成功才打断。
 * 只读会话记录，不代表重新跑过需求；分类是按调用参数和源码关键字判的，个别会误判，比较前后用同一版脚本。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const minAt = argv.indexOf("--min-bytes");
const minBytes = minAt >= 0 ? Number(argv[minAt + 1]) : 150000;
const inputs = argv.filter((arg, i) => !arg.startsWith("--") && !(minAt >= 0 && i === minAt + 1));
if (inputs.length === 0) {
	console.error("用法：node scripts/measure-sample-hunt.mjs <会话目录或 .jsonl>… [--min-bytes 150000] [--json]");
	process.exit(2);
}

const DATA_READ =
	/QueryServiceHelper|BusinessDataServiceHelper|BFTrackerServiceHelper|WorkflowServiceHelper|QFilter|DB\.query/;
const base = (path) => String(path).replace(/\\/g, "/").split("/").pop();
const asserted = (args) =>
	(args.argv ?? []).some((v) => /^--expect/.test(String(v))) ||
	Object.keys(args.env ?? {}).some((key) => /EXPECT|ASSERT/.test(key));

const files = [];
for (const input of inputs) {
	if (statSync(input).isDirectory()) {
		for (const name of readdirSync(input)) if (name.endsWith(".jsonl")) files.push(join(input, name));
	} else files.push(input);
}

const sessions = [];
for (const file of files) {
	if (statSync(file).size <= minBytes) continue;
	const entries = readFileSync(file, "utf8")
		.split(/\r?\n/)
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line));
	const results = new Map();
	for (const entry of entries) if (entry.message?.role === "toolResult") results.set(entry.message.toolCallId, entry);
	const at = (entry) => Date.parse(entry.timestamp);
	const sources = new Map();
	const row = {
		file: base(file).slice(0, 19),
		minutes: 0,
		calls: 0,
		huntMinutes: 0,
		queries: 0,
		pseudoQueries: 0,
		zero: 0,
		zeroRetry: 0,
		tempFlow: 0,
		tempLink: 0,
		tempOther: 0,
		writes: 0,
		longestRun: 0,
	};
	const sequence = [];
	let seconds = 0;
	let huntSeconds = 0;
	let run = 0;
	let previousEnd = null;
	for (const entry of entries) {
		const message = entry.message;
		if (message === undefined) continue;
		if (message.role === "user") {
			previousEnd = at(entry);
			continue;
		}
		if (message.role !== "assistant") continue;
		const calls = message.content.filter((part) => part.type === "toolCall");
		let last = at(entry);
		let hunting = 0;
		for (const call of calls) {
			row.calls++;
			const args = call.arguments ?? {};
			const result = results.get(call.id);
			if (result !== undefined) last = Math.max(last, at(result));
			const path = String(args.path ?? "").replace(/\\/g, "/");
			if (call.name === "write" && path) sources.set(base(path), String(args.content ?? ""));
			if (call.name === "edit" && path)
				sources.set(base(path), (sources.get(base(path)) ?? "") + JSON.stringify(args));
			const output = result === undefined ? "" : result.message.content.map((part) => part.text ?? "").join("");
			const name = String(args.name ?? "");
			let kind = null;
			if (call.name === "cosmic_probe" && !asserted(args)) {
				if (name === "DataQueryProbe") {
					kind = "query";
					row.queries++;
					const env = args.env ?? {};
					if (/@(上游|下游|流程)/.test(`${env.QUERY_WHERE ?? ""} ${env.QUERY_FIELDS ?? ""}`)) row.pseudoQueries++;
					const empty = /命中 0 条/.test(output);
					if (empty) row.zero++;
					sequence.push({ kind, entity: env.QUERY_ENTITY, empty });
				} else if (/^Data(Seed|Update)Probe$/.test(name)) {
					kind = "write";
					row.writes++;
					sequence.push({ kind });
				} else if (/\.java$/.test(name) && DATA_READ.test(sources.get(base(name)) ?? "")) {
					kind = "temp";
					const source = sources.get(base(name)) ?? "";
					if (/WorkflowServiceHelper|wf_/.test(source)) row.tempFlow++;
					else if (/BFTracker|findSourceBills|findTargetBills/.test(source)) row.tempLink++;
					else row.tempOther++;
					sequence.push({ kind });
				}
			}
			const code =
				(call.name === "write" || call.name === "edit") &&
				/\.java$/.test(path) &&
				!/\.cosmic-ai\/probes|scratchpad/.test(path);
			const passed =
				["cosmic_run", "cosmic_probe"].includes(call.name) &&
				asserted(args) &&
				result !== undefined &&
				!result.message.isError &&
				!/"ok":\s*false/.test(output.slice(0, 200));
			if (kind !== null) {
				hunting++;
				run++;
				row.longestRun = Math.max(row.longestRun, run);
			} else if (code || passed) run = 0;
		}
		const roundSeconds = (previousEnd === null ? 0 : (at(entry) - previousEnd) / 1000) + (last - at(entry)) / 1000;
		seconds += roundSeconds;
		if (calls.length > 0) huntSeconds += (roundSeconds * hunting) / calls.length;
		previousEnd = last;
	}
	sequence.forEach((item, i) => {
		if (!item.empty) return;
		const next = sequence[i + 1];
		if (next !== undefined && ((next.kind === "query" && next.entity === item.entity) || next.kind === "temp"))
			row.zeroRetry++;
	});
	row.minutes = Number((seconds / 60).toFixed(1));
	row.huntMinutes = Number((huntSeconds / 60).toFixed(1));
	sessions.push(row);
}

const sum = (key) => sessions.reduce((total, row) => total + row[key], 0);
const totals = {
	sessions: sessions.length,
	sessionsHunting: sessions.filter((row) => row.queries + row.tempFlow + row.tempLink + row.tempOther + row.writes > 0)
		.length,
	minutes: Number(sum("minutes").toFixed(1)),
	huntMinutes: Number(sum("huntMinutes").toFixed(1)),
	queries: sum("queries"),
	pseudoQueries: sum("pseudoQueries"),
	zero: sum("zero"),
	zeroRetry: sum("zeroRetry"),
	tempFlow: sum("tempFlow"),
	tempLink: sum("tempLink"),
	tempOther: sum("tempOther"),
	writes: sum("writes"),
	longestRun: Math.max(0, ...sessions.map((row) => row.longestRun)),
};
if (argv.includes("--json")) console.log(JSON.stringify({ totals, sessions }, null, 2));
else {
	console.table(sessions.sort((a, b) => b.huntMinutes - a.huntMinutes));
	console.log(JSON.stringify(totals, null, 2));
}
