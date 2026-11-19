#!/usr/bin/env node
/**
 * 验证时花在「找现成单、造测试单」上的调用和时间：真机会话离线测量。
 *
 * 跑法：node scripts/measure-test-data.mjs [--dir <会话目录> …] [--from 2026-09-14] [--to 2026-10-07] [--min-bytes 150000] [-v] [--json]
 *       不给 --dir 就量三个真机工程目录（zlgd_ygpt2.0、zlgd_s37_r1、zlgd_s37_r3）。
 *
 * 口径：
 * - 只算「验证段」：会话里第一次写、改业务 Java（不含 .cosmic-ai 下的临时探针）之后的调用。没写过业务代码的会话不算。
 * - 每次调用的耗时 = 上一个事件（上一次工具返回或上一条模型消息）到这次工具返回，含模型想的时间。
 * - 分类（只看工具和参数，不读模型的话）：
 *   找现成单  DataQueryProbe / DataProbe，查询字段或条件里有 billno、billstatus、@上游、@下游、@流程（在挑单）；
 *            临时探针名里带 Find / Bill / Sample / Candidate / Submittable 的也算；
 *   查取值    其余 DataQueryProbe（查基础资料编码、下拉值、别的单上填了什么），MustInputProbe、FieldLimitProbe；
 *   造单      DataSeedProbe；cosmic_run op 不带 --pk / --billno（从空单开始）；
 *   改单      DataUpdateProbe（补字段、改状态）。
 * - 造单按起点再分：照现成复制（SEED_COPY，或 SEED_ROWS 里有 copy=）、从上游下推（SEED_FROM）、从空单起（其余）。
 * - 造单失败：返回里 isSuccess=false 或 ok=false，且参数里没写 success=false（不是在验「会被拦」）。
 *   失败后补查：造单失败之后、下一次造单之前的「查取值」调用。
 * - 只读历史会话，不重跑；分类是按工具和参数认的，挑单和查取值的边界会有误差，例子要人工看。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const SESSIONS = "C:/Users/Lige/.pi/agent/sessions";
const DEFAULT_DIRS = ["--D--kingdee-zlgd_ygpt2.0--", "--D--kingdee-zlgd_s37_r1--", "--D--kingdee-zlgd_s37_r3--"].map(
	(d) => join(SESSIONS, d),
);

const args = process.argv.slice(2);
const values = (name) => args.flatMap((arg, i) => (arg === name && args[i + 1] !== undefined ? [args[i + 1]] : []));
const dirs = values("--dir").length > 0 ? values("--dir") : DEFAULT_DIRS;
const from = values("--from")[0] ?? "0000";
const to = values("--to")[0] ?? "9999";
const minBytes = Number(values("--min-bytes")[0] ?? 150000);
const verbose = args.includes("-v");

const PICK_FIELDS = /billno|billstatus|@上游|@下游|@流程/i;
const FIND_PROBE = /Find|Bill|Sample|Candidate|Submittable/i;

function kindOf(name, a) {
	if (name === "cosmic_probe") {
		const probe = String(a?.name ?? "");
		const env = a?.env ?? {};
		if (/DataQueryProbe|DataProbe$/.test(probe))
			return PICK_FIELDS.test(`${env.QUERY_FIELDS ?? ""} ${env.QUERY_WHERE ?? ""}`) ? "找现成单" : "查取值";
		if (/MustInputProbe|FieldLimitProbe/.test(probe)) return "查取值";
		if (/DataSeedProbe/.test(probe)) return "造单";
		if (/DataUpdateProbe/.test(probe)) return "改单";
		if (/[\\/.]/.test(probe) && FIND_PROBE.test(probe.replace(/.*[\\/]/, ""))) return "找现成单";
		return null;
	}
	if (name === "cosmic_run") {
		const argv = a?.argv ?? [];
		if (argv[0] === "op" && !argv.includes("--pk") && !argv.includes("--billno")) return "造单";
	}
	return null;
}

/** 造单的起点：照现成复制、从上游下推、从空单起。cosmic_run op 不带 pk 的都是从空单起。 */
function seedStart(a) {
	const env = a?.env ?? {};
	if (String(env.SEED_COPY ?? "").trim() !== "" || /^\s*copy=/m.test(String(env.SEED_ROWS ?? ""))) return "复制";
	if (String(env.SEED_FROM ?? "").trim() !== "") return "下推";
	return "空单";
}

const isBizJava = (path) => typeof path === "string" && /\.java$/i.test(path) && !/\.cosmic-ai/.test(path);

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
	let last = null;
	let seq = 0;
	const calls = [];
	const byId = new Map();
	for (const entry of lines) {
		const m = entry.message;
		const ts = Date.parse(entry.timestamp);
		if (!m || !ts) continue;
		if (m.role === "assistant")
			for (const c of m.content ?? [])
				if (c.type === "toolCall") {
					seq++;
					const call = { seq, name: c.name, args: c.arguments, start: last ?? ts };
					calls.push(call);
					byId.set(c.id, call);
				}
		if (m.role === "toolResult") {
			const call = byId.get(m.toolCallId);
			if (call) {
				call.end = ts;
				call.text = (m.content ?? []).map((x) => x.text ?? "").join("");
			}
		}
		last = ts;
	}
	const first = calls.find(
		(c) => (c.name === "edit" || c.name === "write") && isBizJava(c.args?.path ?? c.args?.file_path),
	);
	if (first === undefined) return null;
	const verify = calls.filter((c) => c.seq > first.seq);
	const out = {
		calls: seq,
		verifyCalls: verify.length,
		verifyMinutes: verify.reduce((s, c) => s + ((c.end ?? c.start) - c.start), 0) / 60000,
		kinds: {},
		createFailed: 0,
		lookupsAfterFailure: 0,
		seedFrom: { 复制: 0, 下推: 0, 空单: 0 },
		rows: [],
	};
	let failedOpen = false;
	for (const c of verify) {
		const kind = kindOf(c.name, c.args);
		if (kind === null) continue;
		const minutes = ((c.end ?? c.start) - c.start) / 60000;
		out.kinds[kind] ??= { calls: 0, minutes: 0 };
		const slot = out.kinds[kind];
		slot.calls++;
		slot.minutes += minutes;
		const text = c.text ?? "";
		const failed =
			kind === "造单" &&
			/isSuccess=false|"ok":false/.test(text) &&
			!JSON.stringify(c.args).includes("success=false");
		if (kind === "造单") {
			failedOpen = failed;
			out.seedFrom[seedStart(c.args)]++;
		}
		if (failed) out.createFailed++;
		if (kind === "查取值" && failedOpen) out.lookupsAfterFailure++;
		const why = failed ? (text.match(/\[校验\][^\n\\]{0,70}/)?.[0] ?? "") : "";
		out.rows.push(`#${String(c.seq)} ${kind}${failed ? "（失败）" : ""} ${minutes.toFixed(1)}m ${why}`);
	}
	return out;
}

const report = [];
for (const dir of dirs) {
	let names = [];
	try {
		names = readdirSync(dir);
	} catch {
		continue;
	}
	for (const name of names.sort()) {
		if (!name.endsWith(".jsonl")) continue;
		const day = name.slice(0, 10);
		if (day < from || day > to) continue;
		const file = join(dir, name);
		if (statSync(file).size <= minBytes) continue;
		const result = measure(file);
		if (result !== null)
			report.push({
				session: `${dir.replace(/.*kingdee-/, "").replace(/-+$/, "")}/${name.slice(0, 19)}`,
				...result,
			});
	}
}

if (args.includes("--json")) {
	console.log(JSON.stringify(report, null, 2));
	process.exit(0);
}
const KINDS = ["找现成单", "查取值", "造单", "改单"];
const sum = (r, k, f) => r.kinds[k]?.[f] ?? 0;
const dataMinutes = (r) => KINDS.reduce((s, k) => s + sum(r, k, "minutes"), 0);
const dataCalls = (r) => KINDS.reduce((s, k) => s + sum(r, k, "calls"), 0);
for (const r of report) {
	const parts = KINDS.map((k) => `${k} ${sum(r, k, "calls")}次/${sum(r, k, "minutes").toFixed(1)}分`).join("  ");
	console.log(
		`${r.session}  验证段 ${r.verifyCalls} 次/${r.verifyMinutes.toFixed(0)} 分 | 数据 ${dataCalls(r)} 次/${dataMinutes(r).toFixed(1)} 分 | ${parts} | 造单失败 ${r.createFailed}、失败后补查 ${r.lookupsAfterFailure}`,
	);
	if (verbose) for (const row of r.rows) console.log(`    ${row}`);
}
const total = (f) => report.reduce((s, r) => s + f(r), 0);
const heavy = report.filter((r) => dataMinutes(r) >= 5);
console.log(
	`\n合计 ${report.length} 份写过业务代码的会话：验证段 ${total((r) => r.verifyCalls)} 次/${total((r) => r.verifyMinutes).toFixed(0)} 分，` +
		`其中数据 ${total(dataCalls)} 次/${total(dataMinutes).toFixed(0)} 分；` +
		KINDS.map(
			(k) => `${k} ${total((r) => sum(r, k, "calls"))} 次/${total((r) => sum(r, k, "minutes")).toFixed(0)} 分`,
		).join("、") +
		`；造单起点 复制 ${total((r) => r.seedFrom.复制)}、下推 ${total((r) => r.seedFrom.下推)}、空单 ${total((r) => r.seedFrom.空单)}` +
		`；造单失败 ${total((r) => r.createFailed)} 次、失败后补查 ${total((r) => r.lookupsAfterFailure)} 次；数据≥5 分钟的会话 ${heavy.length} 份`,
);
