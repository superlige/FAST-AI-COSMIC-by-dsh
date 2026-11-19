#!/usr/bin/env node
/**
 * 代码关系表在真机会话里用上没有（2026-10-03 索引盘点的尺子）。
 *
 * 用法：
 *   node scripts/measure-index-usage.mjs --dir DIR [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--match 文件名片段] [--json]
 *
 * 口径：
 *   - 主动查：模型调 `cosmic_impact`（按 action 分），以及 `cosmic_doctor` 的 index / reindex。
 *     每次查询记返回字节、是否被省略（返回里带 outputBudget.truncated）、是否报错，
 *     以及紧跟着的 3 次调用里有没有"翻代码"（读 .java、对业务源码 grep/sed/cat）或"翻工具产物"
 *     （读 .cosmic-ai/work/out、impact.json）。
 *     另记"查完又搜同一标识"（v2 加）：同一会话里查过的标识（见 `queryTerms`），之后还出现在 grep / rg 命令里的
 *     调用次数，每条命令只算一次；之后有这种 grep 的查询算"查完还去搜"。`--match` 只看文件名含这一段的会话。
 *   - 自动用：工具返回里由代码关系表算出来的那几句，按固定文字认：
 *     编译后报"挂在哪些布局"（boundForms 非空）、探针前挡"分录当实体"、模拟表单前报"目标上没插件登记"、
 *     跑操作前报"插件链上有外发动作"、验证路线里的规则 id。
 *   - 自己翻：bash 里对业务源码做跨文件搜索（grep -r / rg / --include），再按搜的词分：
 *     本 ISV 标识（zlgd_ 开头，`--isv` 可改）、像类名的、其他文字。前两种正是代码关系表能回答的问题。
 * 只读会话记录，不改任何东西。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const flag = (name) => {
	const i = argv.indexOf(name);
	return i < 0 ? undefined : argv[i + 1];
};
const dir = flag("--dir");
if (dir === undefined) {
	console.error("用法：node scripts/measure-index-usage.mjs --dir DIR [--from D] [--to D] [--isv zlgd] [--json]");
	process.exit(2);
}
const from = flag("--from") ?? "0000-00-00";
const to = flag("--to") ?? "9999-99-99";
const isv = flag("--isv") ?? "zlgd";
const match = flag("--match") ?? "";

const AUTO = {
	编译后报挂在哪些布局: /"boundForms":\["/,
	探针前挡分录当实体: /PROBE_ENTITY_IS_ENTRY/,
	模拟表单前报目标上没插件登记: /上没有本工程的插件登记/,
	跑操作前报插件链上有外发动作: /的插件链上 \S+ 会发消息/,
	验证路线带规则或单据: /代码关系表里没有它挂的规则|挂在 \d+ 条规则上/,
};

const BUSINESS_SRC = new RegExp(`${isv}-[a-z]+/src|src/main/java|--include=?["']?\\*\\.java`);
const TOOL_ARTIFACT = /\.cosmic-ai[\\/]work[\\/]out|impact\.json|cosmic-out/;
function follow(call) {
	const a = call.arguments ?? {};
	const text = call.name === "bash" ? String(a.command ?? "") : String(a.path ?? a.file_path ?? "");
	if (call.name !== "bash" && call.name !== "read") return "其他";
	if (TOOL_ARTIFACT.test(text)) return "翻工具产物";
	if (call.name === "read" && /\.java$/.test(text) && !/probes|fast-ai-cosmic/.test(text)) return "翻代码";
	if (
		call.name === "bash" &&
		/\b(grep|rg|sed|cat|head|awk)\b/.test(text) &&
		(BUSINESS_SRC.test(text) || /\.java\b/.test(text))
	)
		return "翻代码";
	return "其他";
}

/**
 * 查询参数里的标识：每个字符串值整串，再按 `.`、`#`、空白拆开，只留带下划线的（单据、字段）
 * 和大写开头的（类、方法）；包名片段（`zlgd`、`service`）不算，否则每条带路径的 grep 都会对上。
 */
function queryTerms(args) {
	const out = new Set();
	const walk = (v) => {
		if (typeof v === "string") {
			if (v.length >= 4 && v !== "query") out.add(v);
			for (const part of v.split(/[.#\s]+/)) if (part.length >= 4 && /_|^[A-Z]/.test(part)) out.add(part);
		} else if (Array.isArray(v)) v.forEach(walk);
		else if (v && typeof v === "object") Object.values(v).forEach(walk);
	};
	walk(args);
	return [...out];
}

/** 一次调用是 grep / rg 时，命令里出现了哪些词。 */
function grepHits(call, terms) {
	if (call.name !== "bash") return [];
	const c = String(call.arguments?.command ?? "");
	return /\b(grep|rg)\b/.test(c) ? terms.filter((t) => c.includes(t)) : [];
}

const report = {
	version: "index-usage-v2",
	sessions: 0,
	calls: 0,
	initiative: {
		byAction: {},
		sessions: 0,
		queries: 0,
		errors: 0,
		truncated: 0,
		bytes: 0,
		next: {},
		lastDay: null,
		regrep: { queries: 0, greps: 0, terms: [] },
	},
	auto: Object.fromEntries(Object.keys(AUTO).map((k) => [k, { times: 0, sessions: 0 }])),
	grep: { crossFile: 0, sessions: 0, byTerm: { 本ISV标识: 0, 像类名: 0, 其他文字: 0 } },
};
for (const name of readdirSync(dir).sort()) {
	const day = name.slice(0, 10);
	if (!name.endsWith(".jsonl") || day < from || day > to || !name.includes(match)) continue;
	report.sessions++;
	const records = [];
	for (const line of readFileSync(join(dir, name), "utf8").split(/\r?\n/)) {
		if (line.trim() === "") continue;
		try {
			records.push(JSON.parse(line));
		} catch {
			// 会话边跑边追加，最后一行可能只写了一半。
		}
	}
	const results = new Map();
	const calls = [];
	for (const r of records) {
		const m = r.message;
		if (r.type !== "message") continue;
		if (m?.role === "toolResult")
			results.set(m.toolCallId, {
				text: (m.content ?? []).map((c) => c.text ?? "").join(""),
				isError: m.isError === true,
			});
		if (m?.role === "assistant") for (const p of m.content ?? []) if (p.type === "toolCall") calls.push(p);
	}
	report.calls += calls.length;
	let asked = false;
	let grepped = false;
	const autoSeen = new Set();
	const queried = new Set();
	for (const [i, call] of calls.entries()) {
		const a = call.arguments ?? {};
		const again = grepHits(call, [...queried]);
		if (again.length > 0) {
			report.initiative.regrep.greps++;
			for (const t of again) if (!report.initiative.regrep.terms.includes(t)) report.initiative.regrep.terms.push(t);
		}
		const result = results.get(call.id);
		const text = result?.text ?? "";
		for (const [k, re] of Object.entries(AUTO))
			if (re.test(text)) {
				report.auto[k].times++;
				autoSeen.add(k);
			}
		const initiative =
			call.name === "cosmic_impact"
				? `impact ${a.action ?? "query"}`
				: call.name === "cosmic_doctor" && /index/.test(a.action ?? "")
					? `doctor ${a.action}`
					: null;
		if (initiative !== null) {
			asked = true;
			const s = report.initiative;
			s.byAction[initiative] = (s.byAction[initiative] ?? 0) + 1;
			s.lastDay = day;
			if (initiative === "impact query") {
				s.queries++;
				s.bytes += Buffer.byteLength(text);
				if (result?.isError || /"ok":false/.test(text.slice(0, 20))) s.errors++;
				if (/"truncated":true/.test(text)) s.truncated++;
				const kinds = new Set(calls.slice(i + 1, i + 4).map(follow));
				const key = kinds.has("翻工具产物") ? "翻工具产物" : kinds.has("翻代码") ? "翻代码" : "其他";
				s.next[key] = (s.next[key] ?? 0) + 1;
				const terms = queryTerms(a);
				for (const t of terms) queried.add(t);
				const later = calls.slice(i + 1).filter((c) => grepHits(c, terms).length > 0);
				if (later.length > 0) s.regrep.queries++;
			}
		}
		if (call.name === "bash") {
			const c = String(a.command ?? "");
			if (!/\b(grep|rg)\b/.test(c) || !/\bgrep\s+-[a-zA-Z]*r|\brg\b|--include/.test(c)) continue;
			if (!BUSINESS_SRC.test(c) && !new RegExp(`kingdee/${isv}`).test(c)) continue;
			if (TOOL_ARTIFACT.test(c) && !BUSINESS_SRC.test(c)) continue;
			grepped = true;
			report.grep.crossFile++;
			const pattern = c.match(/(?:grep|rg)[^"']*["']([^"']+)["']/)?.[1] ?? "";
			const term = new RegExp(`${isv}_[a-z0-9_]+`).test(pattern)
				? "本ISV标识"
				: /\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b/.test(pattern)
					? "像类名"
					: "其他文字";
			report.grep.byTerm[term]++;
		}
	}
	if (asked) report.initiative.sessions++;
	if (grepped) report.grep.sessions++;
	for (const k of autoSeen) report.auto[k].sessions++;
}

if (argv.includes("--json")) console.log(JSON.stringify(report, null, "\t"));
else {
	const s = report.initiative;
	console.log(`${report.sessions} 份会话，${report.calls} 次调用`);
	console.log(
		`\n主动查：${Object.entries(s.byAction)
			.map(([k, v]) => `${k} ${v}`)
			.join("，")}；用过的会话 ${s.sessions} 份，最后一次在 ${s.lastDay ?? "—"}`,
	);
	console.log(
		`  query ${s.queries} 次：报错 ${s.errors}，被省略 ${s.truncated}，平均 ${s.queries ? Math.round(s.bytes / s.queries) : 0} 字节`,
	);
	console.log(
		`  查完紧接着 3 次调用里：${Object.entries(s.next)
			.map(([k, v]) => `${k} ${v}`)
			.join("，")}`,
	);
	console.log(
		`  查完还去搜同一标识：${s.regrep.queries} 次查询之后有，共 ${s.regrep.greps} 次 grep（${s.regrep.terms.join("、") || "—"}）`,
	);
	console.log("\n自动用（工具返回里由代码关系表算出的话）：");
	for (const [k, v] of Object.entries(report.auto)) console.log(`  ${k}：${v.times} 次，${v.sessions} 份会话`);
	const g = report.grep;
	console.log(
		`\n自己翻：跨文件搜业务源码 ${g.crossFile} 次，${g.sessions} 份会话；搜本 ISV 标识 ${g.byTerm.本ISV标识}，像类名 ${g.byTerm.像类名}，其他文字 ${g.byTerm.其他文字}`,
	);
}
