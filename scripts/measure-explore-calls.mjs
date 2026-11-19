#!/usr/bin/env node
/**
 * 动手之前，模型查了几轮、几次、查的是哪几类信息、同一个对象被拆成几次查（S43 基线尺子）。
 *
 * 用法：
 *   node scripts/measure-explore-calls.mjs <会话.jsonl> [更多会话…] [--json]
 *   node scripts/measure-explore-calls.mjs --dir DIR --from YYYY-MM-DD --to YYYY-MM-DD --min-bytes N [--json]
 *
 * 口径：
 *   - 「动手之前」= 会话尺子 `measureSession` 的第一次推进（firstProgress）之前的调用，和 analyze:session 同一口径；
 *     整份会话没有推进的，全部调用都算。
 *   - 轮 = 一条带工具调用的模型消息（同一轮并行发的几次调用算一轮）。每轮之间模型要想一次，轮数比调用数更接近耗时。
 *   - 信息种类按工具和会话尺子的 readKind 分：
 *       元数据、配置 = cosmic_probe / cosmic_meta / cosmic_impact；
 *       翻代码 = bash/read 的 java-*；
 *       读技能、知识 = reference 和 cosmic_knowledge；
 *       翻工具产物 = artifact / run-output / export / cache / probe-run / temporary-probe（工具给的不够，模型去挖文件）；
 *       其他 = 剩下的。
 *   - 对象 = cosmic_probe 的 env 里键名以 ENTITY 或 FORM 结尾的值（逗号分隔取第一个），
 *     cosmic_meta 的 argv 里第一个形如 `xxx_yyy` 的标识。一个对象被查几次，看的是"一个问题拆成了几次"。
 *   - 字节是工具返回的 UTF-8 字节（会话尺子 payloadBytes）。
 *   - 拼按钮链（S43 批 2）= 动手前为了弄清"工具栏上有哪些按钮 → 各绑什么操作 → 谁处理这个操作"发的调用：
 *       OpMetaProbe、FormPluginProbe 的每一次；
 *       FormLayoutProbe（只读）参数或 raw 里提到工具栏、按钮、操作标识的（tbmain、toolbar、bar_、tbl、BarItem、OperationKey、工具栏、按钮）；
 *       bash/read 里翻 OpMetaProbe 产物、grep 工具栏，或在 Java 里找 beforeDoOperation、afterDoOperation、itemClick、operateKey 的。
 *     轮 = 至少有一次拼链调用的轮。按文字匹配，翻探针源码这类没提到上述字眼的不算，所以是下限。
 * 只读会话记录，不改任何东西。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { measureSession } from "./session-metrics.mjs";

const argv = process.argv.slice(2);
const flag = (name) => {
	const i = argv.indexOf(name);
	return i < 0 ? undefined : argv[i + 1];
};
const asJson = argv.includes("--json");
const valued = new Set(["--dir", "--from", "--to", "--min-bytes"]);
const files = argv.filter((arg, i) => !arg.startsWith("--") && !valued.has(argv[i - 1]));
const dir = flag("--dir");
if (dir !== undefined) {
	const from = flag("--from") ?? "0000-00-00";
	const to = flag("--to") ?? "9999-99-99";
	const minBytes = Number(flag("--min-bytes") ?? 0);
	for (const name of readdirSync(dir).sort()) {
		const day = name.slice(0, 10);
		if (!name.endsWith(".jsonl") || day < from || day > to) continue;
		const path = join(dir, name);
		if (statSync(path).size > minBytes) files.push(path);
	}
}
if (files.length === 0) {
	console.error(
		"用法：node scripts/measure-explore-calls.mjs <会话.jsonl>… | --dir DIR [--from D] [--to D] [--min-bytes N] [--json]",
	);
	process.exit(2);
}

const KINDS = ["元数据、配置", "翻代码", "读技能、知识", "翻工具产物", "其他"];
function kindOf(detail) {
	if (["cosmic_probe", "cosmic_meta", "cosmic_impact"].includes(detail.tool)) return "元数据、配置";
	if (detail.tool === "cosmic_knowledge") return "读技能、知识";
	if (detail.tool !== "bash" && detail.tool !== "read") return "其他";
	const read = detail.readKind ?? "";
	if (read.startsWith("java-")) return "翻代码";
	if (read === "reference") return "读技能、知识";
	if (["artifact", "run-output", "export", "cache", "probe-run", "temporary-probe"].includes(read))
		return "翻工具产物";
	return "其他";
}

function objectOf(tool, args) {
	if (tool === "cosmic_probe") {
		for (const [key, value] of Object.entries(args.env ?? {}))
			if (/(?:ENTITY|FORM)$/.test(key) && typeof value === "string" && value.trim() !== "")
				return value.split(",")[0].trim();
		return null;
	}
	if (tool === "cosmic_meta") return (args.argv ?? []).find((v) => /^[a-z][a-z0-9]*_[a-z0-9_]+$/.test(v)) ?? null;
	return null;
}

const CHAIN_LAYOUT = /tbmain|toolbar|_toolbar_|\bbar_|\btbl|\btb_|baritem|operationkey|工具栏|按钮/i;
const CHAIN_TEXT = /OpMetaProbe|工具栏|BarItem|beforeDoOperation|afterDoOperation|itemClick|operateKey|getItemKey/i;
function isChain(tool, args) {
	if (tool === "cosmic_probe") {
		if (args.name === "OpMetaProbe" || args.name === "FormPluginProbe") return true;
		if (args.name !== "FormLayoutProbe") return false;
		return CHAIN_LAYOUT.test(JSON.stringify([args.env ?? {}, args.raw ?? ""]));
	}
	if (tool === "bash") return CHAIN_TEXT.test(String(args.command ?? ""));
	if (tool === "read") return CHAIN_TEXT.test(String(args.path ?? ""));
	return false;
}

function measure(file) {
	const records = [];
	for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
		if (line.trim() === "") continue;
		try {
			records.push(JSON.parse(line));
		} catch {
			// 会话边跑边追加，最后一行可能只写了一半。
		}
	}
	const metrics = measureSession(records);
	const end = metrics.firstProgress ? metrics.firstProgress.seq : metrics.calls + 1;
	// 和 measureSession 同样的顺序给调用编号，拿回参数和所在的轮。
	const calls = [];
	let round = 0;
	for (const entry of records) {
		const message = entry.message;
		if (entry.type !== "message" || message?.role !== "assistant") continue;
		const parts = (Array.isArray(message.content) ? message.content : []).filter((p) => p.type === "toolCall");
		if (parts.length > 0) round++;
		for (const p of parts) calls.push({ tool: p.name, args: p.arguments ?? {}, round });
	}
	const byKind = Object.fromEntries(KINDS.map((k) => [k, { calls: 0, bytes: 0 }]));
	const objects = {};
	const rounds = new Set();
	const chainRounds = new Set();
	const chain = { calls: 0, rounds: 0, bytes: 0 };
	let bytes = 0;
	for (const detail of metrics.details) {
		if (detail.seq >= end) break;
		const call = calls[detail.seq - 1];
		rounds.add(call.round);
		if (isChain(call.tool, call.args)) {
			chainRounds.add(call.round);
			chain.calls++;
			chain.bytes += detail.payloadBytes ?? 0;
		}
		const row = byKind[kindOf(detail)];
		row.calls++;
		row.bytes += detail.payloadBytes ?? 0;
		bytes += detail.payloadBytes ?? 0;
		const object = objectOf(call.tool, call.args);
		if (object !== null) objects[object] = (objects[object] ?? 0) + 1;
	}
	chain.rounds = chainRounds.size;
	return {
		file: file.replace(/.*[\\/]/, ""),
		calls: metrics.calls,
		explore: {
			calls: end - 1,
			rounds: rounds.size,
			elapsedMs: metrics.firstProgress ? metrics.firstProgress.elapsedMs : metrics.elapsedMs,
			bytes,
			byKind,
			objects,
			chain,
		},
	};
}

const sessions = files.map(measure);
const total = {
	sessions: sessions.length,
	calls: 0,
	rounds: 0,
	bytes: 0,
	byKind: {},
	chain: { calls: 0, rounds: 0, bytes: 0 },
};
for (const k of KINDS) total.byKind[k] = { calls: 0, bytes: 0 };
for (const s of sessions) {
	total.calls += s.explore.calls;
	total.rounds += s.explore.rounds;
	total.bytes += s.explore.bytes;
	for (const k of ["calls", "rounds", "bytes"]) total.chain[k] += s.explore.chain[k];
	for (const k of KINDS) {
		total.byKind[k].calls += s.explore.byKind[k].calls;
		total.byKind[k].bytes += s.explore.byKind[k].bytes;
	}
}

if (asJson) {
	console.log(JSON.stringify({ version: "s43-v1", sessions, total }, null, "\t"));
} else {
	const kb = (n) => `${Math.round(n / 1024)} KB`;
	for (const s of sessions) {
		const e = s.explore;
		const objs = Object.entries(e.objects)
			.sort((a, b) => b[1] - a[1])
			.map(([o, n]) => `${o}×${n}`)
			.join(" ");
		console.log(
			`${s.file.slice(0, 19)}  全程 ${s.calls} 次 | 动手前 ${e.rounds} 轮 ${e.calls} 次 ${Math.round(e.elapsedMs / 1000)} 秒 ${kb(e.bytes)} | 拼按钮链 ${e.chain.rounds} 轮 ${e.chain.calls} 次 ${kb(e.chain.bytes)} | 对象 ${objs || "—"}`,
		);
	}
	console.log(
		`\n合计 ${total.sessions} 份：动手前 ${total.rounds} 轮、${total.calls} 次、${kb(total.bytes)}（平均每份 ${(total.rounds / total.sessions).toFixed(1)} 轮、${(total.calls / total.sessions).toFixed(1)} 次）`,
	);
	console.log(
		`  拼按钮链：${total.chain.rounds} 轮（${((total.chain.rounds / total.rounds) * 100).toFixed(0)}%）、${total.chain.calls} 次、${kb(total.chain.bytes)}`,
	);
	for (const k of KINDS) {
		const row = total.byKind[k];
		console.log(
			`  ${k}：${row.calls} 次（${((row.calls / total.calls) * 100).toFixed(0)}%），${kb(row.bytes)}（${((row.bytes / total.bytes) * 100).toFixed(0)}%）`,
		);
	}
}
