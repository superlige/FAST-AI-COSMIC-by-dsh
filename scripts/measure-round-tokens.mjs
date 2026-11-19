#!/usr/bin/env node
/**
 * 每轮发给模型的 token 花在哪：按 pi 会话逐次还原请求里带了什么，按内容分类摊开。
 *
 * 只读历史会话。每次模型回复记着这次请求的真实用量（新算 / 缓存读 / 缓存写 / 输出 / 费用），
 * 这里把请求时上下文里的每一段（用户的话、模型正文、回传的思考、工具调用参数、各工具返回、压缩摘要）
 * 按字数估 token，再把"真实输入减去固定部分"按估值比例摊给各段——总数以账单为准，比例靠估算。
 *
 * 固定部分（系统提示 + 工具定义）不落盘：取各会话第一次请求（上下文里只有用户的话）的真实输入
 * 减去用户的话，按模型取中位。每次请求前补的不显示的状态补充也不落盘，会摊进各段里，量不出来单列。
 *
 * 用法：
 *   node scripts/measure-round-tokens.mjs --dir <会话目录> [--from 日期] [--to 日期] [--model 关键字] [--top N] [--json]
 *   node scripts/measure-round-tokens.mjs <会话.jsonl…> [--model 关键字]
 *
 * 口径：
 *   - 一次请求的输入 = input + cacheRead + cacheWrite（pi 记在 assistant 消息的 usage 上）。
 *   - 估 token：汉字等宽字符按 0.6，其余字符按 0.3；只用来定比例。
 *   - 思考回传：同一模型的思考按原样带上（pi 的 transform-messages），换过模型的转成文字也算这一类。
 *   - "占用"：一段内容从出现到会话结束被带了多少次请求，乘以它的 token 数，就是它一共被计费读了多少。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : fallback;
};
const dir = opt("--dir");
const from = opt("--from", "");
const to = opt("--to", "9999");
const modelKey = opt("--model", "deepseek");
const top = Number(opt("--top", "12"));
const asJson = args.includes("--json");
const valued = new Set(["--dir", "--from", "--to", "--model", "--top"]);
const positional = args.filter((a, i) => !a.startsWith("--") && !valued.has(args[i - 1]));

const files = dir
	? readdirSync(dir)
			.filter((n) => n.endsWith(".jsonl") && n.slice(0, 10) >= from && n.slice(0, 10) <= to)
			.sort()
			.map((n) => join(dir, n))
	: positional;
if (files.length === 0) {
	console.error("没有会话文件。用 --dir <目录> 或直接给文件。");
	process.exit(1);
}

/** 估 token：只用来定比例。 */
function est(text) {
	if (!text) return 0;
	let wide = 0;
	for (const ch of text) if (ch.codePointAt(0) > 0x2e7f) wide++;
	return wide * 0.6 + (text.length - wide) * 0.3;
}
const textOf = (value) => (typeof value === "string" ? value : JSON.stringify(value ?? ""));

function toolBucket(name) {
	if (name.startsWith("cosmic_")) return `工具返回:${name}`;
	if (name === "read") return "工具返回:read";
	if (name === "bash" || name === "powershell") return "工具返回:shell";
	if (name === "edit" || name === "write") return "工具返回:edit/write";
	return `工具返回:${name}`;
}

/** 一条消息拆成若干段：[{cat, tokens, label}] */
function piecesOf(message, requestModel) {
	const out = [];
	const role = message.role;
	if (role === "user") {
		const content = Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content }];
		for (const c of content) out.push({ cat: "用户的话", tokens: est(c.type === "text" ? c.text : textOf(c)) });
	} else if (role === "assistant") {
		for (const c of message.content ?? []) {
			if (c.type === "text") out.push({ cat: "模型正文", tokens: est(c.text) });
			else if (c.type === "thinking") {
				const same = message.model === requestModel;
				if (same || (c.thinking ?? "").trim() !== "") out.push({ cat: "思考回传", tokens: est(c.thinking ?? "") });
			} else if (c.type === "toolCall")
				out.push({ cat: "工具调用参数", tokens: est(c.name) + est(JSON.stringify(c.arguments ?? {})) });
		}
	} else if (role === "toolResult") {
		const text = (message.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("");
		out.push({ cat: toolBucket(message.toolName ?? "?"), tokens: est(text), label: message.toolName });
	} else if (role === "custom" || role === "bashExecution" || role === "branchSummary") {
		out.push({ cat: "其他消息", tokens: est(textOf(message.content ?? message.summary)) });
	}
	return out;
}

const requests = []; // 每次目标模型请求
const firstRequests = []; // {model, actual, userTokens}
const longLived = []; // 一段工具返回被带了多少次
let sessionsWithModel = 0;

for (const file of files) {
	if (dir && statSync(file).size < 2000) continue;
	const entries = readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => {
			try {
				return JSON.parse(l);
			} catch {
				return null;
			}
		})
		.filter(Boolean);
	const order = new Map(entries.map((e, i) => [e.id, i]));
	/** 当前上下文：[{entryId, idx, cat, tokens, label, born, reads}] */
	let ctx = [];
	let sawModel = false;
	let firstDone = false;
	let prevAssistant = null; // {model, at, actual}
	let lastEntryAt = 0;
	let toolArgs = new Map();
	const sessionRequests = [];
	for (let idx = 0; idx < entries.length; idx++) {
		const e = entries[idx];
		if (e.type === "compaction") {
			const keepFrom = order.get(e.firstKeptEntryId) ?? idx;
			for (const p of ctx) if (p.idx < keepFrom && p.trace) longLived.push(p.trace);
			ctx = ctx.filter((p) => p.idx >= keepFrom);
			ctx.unshift({ entryId: e.id, idx, cat: "压缩摘要", tokens: est(e.summary ?? "") });
			continue;
		}
		if (e.type === "context_edit") {
			for (const p of ctx) if (p.entryId === e.targetId && p.trace) longLived.push(p.trace);
			ctx = ctx.filter((p) => p.entryId !== e.targetId);
			if (e.replacement) ctx.push({ entryId: e.targetId, idx, cat: "其他消息", tokens: est(textOf(e.replacement)) });
			continue;
		}
		if (e.type === "custom_message") {
			ctx.push({ entryId: e.id, idx, cat: "其他消息", tokens: est(textOf(e.content)) });
			continue;
		}
		if (e.type !== "message") continue;
		const m = e.message;
		if (m.role === "assistant" && m.usage && (m.model ?? "").includes(modelKey)) {
			sawModel = true;
			const u = m.usage;
			const actual = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
			const byCat = {};
			for (const p of ctx) {
				byCat[p.cat] = (byCat[p.cat] ?? 0) + p.tokens;
				if (p.trace) p.trace.reads += 1;
			}
			const onlyUser = ctx.length > 0 && ctx.every((p) => p.cat === "用户的话");
			if (!firstDone && onlyUser) firstRequests.push({ model: m.model, actual, userTokens: byCat["用户的话"] ?? 0 });
			firstDone = true;
			// 这次新算的输入是怎么来的
			let why = "正常接上（只算新增的尾巴）";
			if (prevAssistant === null || prevAssistant.model !== m.model) why = "会话开场或刚换模型";
			else if (lastEntryAt - prevAssistant.at > 5 * 60_000) why = "隔了 5 分钟以上（缓存过期）";
			else if ((u.cacheRead ?? 0) < 0.9 * prevAssistant.actual) why = "连着跑却没接上缓存";
			sessionRequests.push({
				why,
				file: basename(file),
				model: m.model,
				actual,
				input: u.input ?? 0,
				cacheRead: u.cacheRead ?? 0,
				cacheWrite: u.cacheWrite ?? 0,
				output: u.output ?? 0,
				reasoning: u.reasoning ?? 0,
				cost: u.cost ?? {},
				byCat,
				round: sessionRequests.length + 1,
			});
		} else if (m.role === "assistant") {
			firstDone = true;
		}
		if (m.role === "assistant" && m.usage) {
			const u = m.usage;
			prevAssistant = {
				model: m.model,
				at: Date.parse(e.timestamp),
				actual: (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0),
			};
		}
		lastEntryAt = Date.parse(e.timestamp);
		if (m.role === "assistant")
			for (const c of m.content ?? []) if (c.type === "toolCall") toolArgs.set(c.id, c.arguments);
		for (const piece of piecesOf(m, modelKeyModel(m))) {
			const p = { entryId: e.id, idx, ...piece };
			if (m.role === "toolResult")
				p.trace = {
					file: basename(file),
					tool: m.toolName,
					args: toolArgs.get(m.toolCallId),
					tokens: piece.tokens,
					reads: 0,
				};
			ctx.push(p);
		}
	}
	for (const p of ctx) if (p.trace) longLived.push(p.trace);
	if (sawModel) sessionsWithModel++;
	requests.push(...sessionRequests);
	toolArgs = new Map();
}

/** 思考回传按"请求所用模型"判断是不是同一模型：会话里一次请求的模型就是下一条 assistant 的模型，这里取它自己的。 */
function modelKeyModel(message) {
	return message.model;
}

if (requests.length === 0) {
	console.error(`没有找到模型名含"${modelKey}"的请求。`);
	process.exit(1);
}

// 固定部分：各会话第一次请求（上下文只有用户的话）
const median = (xs) => {
	const s = [...xs].sort((a, b) => a - b);
	return s.length === 0 ? 0 : s[Math.floor(s.length / 2)];
};
const fixedSamples = firstRequests.map((f) => f.actual - f.userTokens);
const fixed = Math.max(0, median(fixedSamples));

// 摊开
const totals = {};
let sumActual = 0;
const scales = [];
for (const r of requests) {
	sumActual += r.actual;
	const histEst = Object.values(r.byCat).reduce((a, b) => a + b, 0);
	const fixedHere = Math.min(fixed, r.actual);
	const remain = r.actual - fixedHere;
	totals["系统提示+工具定义"] = (totals["系统提示+工具定义"] ?? 0) + fixedHere;
	if (histEst > 0) {
		scales.push(remain / histEst);
		for (const [cat, t] of Object.entries(r.byCat)) totals[cat] = (totals[cat] ?? 0) + (remain * t) / histEst;
	} else totals["未归类"] = (totals["未归类"] ?? 0) + remain;
}

const sum = (k) => requests.reduce((a, r) => a + (r[k] ?? 0), 0);
const sumCost = (k) => requests.reduce((a, r) => a + (r.cost?.[k] ?? 0), 0);
const cost = {
	input: sumCost("input"),
	cacheRead: sumCost("cacheRead"),
	cacheWrite: sumCost("cacheWrite"),
	output: sumCost("output"),
};
const costTotal = cost.input + cost.cacheRead + cost.cacheWrite + cost.output;

// 轮次分档
const buckets = [
	[1, 10],
	[11, 30],
	[31, 60],
	[61, 100],
	[101, 1e9],
];
const byRound = buckets.map(([lo, hi]) => {
	const rs = requests.filter((r) => r.round >= lo && r.round <= hi);
	return {
		range: hi > 1e8 ? `${lo}+` : `${lo}-${hi}`,
		requests: rs.length,
		avgInput: rs.length ? Math.round(rs.reduce((a, r) => a + r.actual, 0) / rs.length) : 0,
	};
});

// 一段工具返回一共被读了多少（估 token × 被带的请求数，再按全局比例换成真实 token）
const globalScale = median(scales) || 1;
const heavy = longLived
	.filter((t) => t.reads > 0)
	.map((t) => ({
		...t,
		billed: Math.round(t.tokens * globalScale * t.reads),
		size: Math.round(t.tokens * globalScale),
	}))
	.sort((a, b) => b.billed - a.billed)
	.slice(0, top);

const ordered = Object.entries(totals).sort((a, b) => b[1] - a[1]);
const freshInput = {};
for (const r of requests) {
	freshInput[r.why] ??= { requests: 0, tokens: 0, cost: 0 };
	const row = freshInput[r.why];
	row.requests += 1;
	row.tokens += r.input;
	row.cost += r.cost?.input ?? 0;
}
const report = {
	sessions: sessionsWithModel,
	requests: requests.length,
	avgInputPerRequest: Math.round(sumActual / requests.length),
	fixedEstimate: Math.round(fixed),
	fixedSamples: fixedSamples.length,
	scaleMedian: Number(globalScale.toFixed(2)),
	tokens: {
		input: sum("input"),
		cacheRead: sum("cacheRead"),
		cacheWrite: sum("cacheWrite"),
		output: sum("output"),
		reasoning: sum("reasoning"),
	},
	cost: { ...cost, total: costTotal },
	shares: ordered.map(([cat, t]) => ({ cat, avgPerRequest: Math.round(t / requests.length), share: t / sumActual })),
	freshInput,
	byRound,
	heavy,
};

if (asJson) {
	console.log(JSON.stringify(report, null, 2));
	process.exit(0);
}

const k = (n) => `${(n / 1000).toFixed(1)}k`;
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const money = (x) => `$${x.toFixed(2)}`;
console.log(
	`会话 ${report.sessions} 份，模型名含"${modelKey}"的请求 ${report.requests} 次，平均每次输入 ${k(report.avgInputPerRequest)} token`,
);
console.log(
	`固定部分（系统提示+工具定义）估 ${k(report.fixedEstimate)}（${report.fixedSamples} 份会话的第一次请求取中位）；估算换真实的比例中位 ${report.scaleMedian}`,
);
console.log("");
console.log("钱花在哪：");
const t = report.tokens;
console.log(
	`  新算的输入   ${k(t.input).padStart(9)}  ${money(cost.input).padStart(8)}  ${pct(cost.input / costTotal)}`,
);
console.log(
	`  缓存读       ${k(t.cacheRead).padStart(9)}  ${money(cost.cacheRead).padStart(8)}  ${pct(cost.cacheRead / costTotal)}`,
);
console.log(
	`  输出         ${k(t.output).padStart(9)}  ${money(cost.output).padStart(8)}  ${pct(cost.output / costTotal)}（其中思考 ${k(t.reasoning)}）`,
);
console.log(`  合计                    ${money(costTotal).padStart(8)}`);
console.log("");
console.log("新算的输入是怎么来的：");
for (const [why, row] of Object.entries(freshInput).sort((a, b) => b[1].tokens - a[1].tokens))
	console.log(
		`  ${why.padEnd(20)} ${String(row.requests).padStart(5)} 次  ${k(row.tokens).padStart(9)}  ${money(row.cost).padStart(7)}  ${pct(row.cost / costTotal)}`,
	);
console.log("");
console.log("每次请求的输入由什么组成（平均每次 / 占比）：");
for (const s of report.shares)
	console.log(`  ${s.cat.padEnd(24)} ${k(s.avgPerRequest).padStart(8)}  ${pct(s.share).padStart(6)}`);
console.log("");
console.log("按会话里第几次请求分档（越往后越长）：");
for (const b of report.byRound)
	console.log(`  第 ${b.range.padEnd(7)} 次  ${String(b.requests).padStart(5)} 次  平均输入 ${k(b.avgInput)}`);
console.log("");
console.log(`一共被读得最多的工具返回（大小 × 之后被带的请求数）：`);
for (const h of heavy) {
	const a = JSON.stringify(h.args ?? {});
	console.log(
		`  ${k(h.billed).padStart(8)} = ${k(h.size)} × ${String(h.reads).padStart(3)} 次  ${h.tool}  ${a.length > 90 ? `${a.slice(0, 90)}…` : a}  [${h.file.slice(0, 19)}]`,
	);
}
