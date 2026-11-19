/**
 * 交付效率和质量的尺子（S44 批 0）：模型做决定那一刻，手里缺不缺做对需要的东西。
 *
 * 只读历史会话，按同一口径给每份会话出这几样数：
 *   - 时间：模型用了多久、工具用了多久；每轮耗时和它输出了多少 token。
 *     模型一轮的耗时 = 上一条消息（用户、工具返回）到这条 assistant 消息的间隔；工具耗时 = 上一条到工具返回。
 *     间隔超过 30 分钟的算人离开，不计。实测（2026-10-05，22 份会话）每轮耗时跟输出 token 走，跟上下文长短无关，
 *     所以比"想了多少"看输出 token。
 *   - 长思考轮：一轮输出 ≥ LONG_ROUND_TOKENS 个 token（DeepSeek v4.1 flash 上约前 10%）。
 *     按思考内容用关键字归成平台规矩 / 工具输出 / 设计取舍 / 编排改动 / 其他，归类只是初判，
 *     要人对着 `--rounds` 列出的摘录复核；跨模型比较时 token 门槛要重定。
 *   - 试错：写入探针试算几次、被拒几次（及被拒的处数）、同一目标试算几次；失败调用及之后同操作成功几次、
 *     翻工具落盘文件几次（后两样直接取 `session-metrics.mjs` 的口径）。
 *   - 替用户定的口径：交付说明里"口径 / 拿不准 / 替你定"那一节列了几条；`ask_question` 问了几次。
 *   - 需求要点清单（`--checklist`）：逐条规则判"做到 / 没做到 / 待人工"，再看清单里的"该用户拍板的点"
 *     是在写入前摆给用户（确认单、提问）、只在交付说明里说、还是没说。
 *     规则只看会话记录（真写入的改动清单、写进 .java 的代码、交付说明），不连环境，结论要人复核。
 */
import { measureSession } from "./session-metrics.mjs";

export const DELIVERY_VERSION = "s44-v1";
export const LONG_ROUND_TOKENS = 2500;
const AWAY_MS = 30 * 60_000;

export const THOUGHT_LABELS = {
	platform: "平台规矩",
	toolOutput: "工具输出看不懂",
	design: "设计取舍",
	compose: "编排改动、写交付说明",
	other: "其他",
};

/**
 * 只看思考的开头 OPENING_CHARS 个字：开头说的是这一轮被什么卡住（"输出被截断了""锁定有哪些选项"），
 * 后面常常是草拟整份改动清单，按全文计数会被草拟部分带偏（2026-10-05 对 32 轮人工归类：看全文对上 13 轮，看开头 600 字对上 23 轮）。
 * 按出现次数打分，同分时按这里的先后取。只作初判，结论以人工复核为准。
 */
export const OPENING_CHARS = 600;
const THOUGHT_RULES = {
	platform: [
		/semantics|valid (?:op|operation|propert|value|type)|\bpropert(?:y|ies)\b|\boptions?\b(?! [AB12]\b)|allowed|can'?t set|cannot set|does(?:n'?t| not) have|op(?:eration)? ?type|(?:does|do) (?:it|\w+) (?:support|have|exist)|may not have|might not be|might not have|limit for|max(?:imum)? ?length (?:limit|for)|\bDDL\b|db type|in Cosmic|the platform|platform's|constructor|\bAPI\b|javap/gi,
		/平台|能不能设|是否支持|允许|可选值|语义/g,
	],
	toolOutput: [
		/truncat|omitted|got cut|only (?:printed|showed|shows|listed) \d+|\braw ?=|regex (?:failed|matched nothing|didn'?t match)|my regex|structure of (?:the )?\w+ output|output (?:structure|format)|\bspill|work\/out|\.out\b|the pick (?:shows|matched|gave)|section header/gi,
		/没列|截断|被截|输出结构/g,
	],
	design: [
		/\bdecid|decision|approach|alternatively|option [AB12]\b|which is better|trade-?off|conventions?\b|requirement says|reuse|or should (?:I|we)|user (?:wants|asked|said)/gi,
		/口径|方案|取舍|还是用/g,
	],
	compose: [
		/let me (?:now )?(?:construct|compose|write|design|plan|draft) (?:the |both |two )?(?:edit list|dry-?runs?|LAYOUT_EDIT|delivery|final|code)|edit list|delivery (?:note|summary)|run (?:both |the )?dry-?runs?/gi,
		/交付说明|改动清单/g,
	],
};

export function classifyThought(text) {
	const scores = {},
		hits = {},
		opening = String(text).slice(0, OPENING_CHARS);
	for (const [kind, rules] of Object.entries(THOUGHT_RULES)) {
		const found = rules.flatMap((re) => [...opening.matchAll(re)].map((m) => m[0].toLowerCase()));
		scores[kind] = found.length;
		hits[kind] = [...new Set(found)].slice(0, 6);
	}
	const top = Object.entries(scores).reduce((best, row) => (row[1] > best[1] ? row : best), ["other", 0]);
	// 思考里写了草稿：三行以上像改动清单或 Java 方法头的行
	const drafts =
		(String(text).match(/^\s*(?:add|set|remove|move) \S+|^\s*(?:public|private|protected) [\w<>]+ \w+\(/gm) ?? [])
			.length >= 3;
	return { kind: top[0], scores, hits, drafts };
}

const ms = (at) => {
	const n = Date.parse(at);
	return Number.isFinite(n) ? n : null;
};
const textOf = (content, type = "text") =>
	typeof content === "string"
		? type === "text"
			? content
			: ""
		: (content ?? [])
				.filter((p) => p.type === type)
				.map((p) => (type === "thinking" ? p.thinking : p.text) ?? "")
				.join("\n");
const okEnvelope = (text) => /^\s*\{"ok":true/.test(text);

/** 改动清单所在的环境变量（如 LAYOUT_EDIT、TPL_SET）以外，挑一个能代表"改哪个对象"的值。 */
function writeTarget(env) {
	const key = Object.keys(env).find((k) => /_(?:FORM|NUMBER|ID|ENTITY|TPL)$/.test(k));
	return key ? `${key}=${env[key]}` : "";
}

/** 交付说明里"替你定的口径"那一节的条数：标题命中后，数到下一个标题为止的列表项和表格数据行。 */
export function countStatedDecisions(finalText) {
	const lines = String(finalText).split(/\r?\n/);
	let inside = false,
		count = 0;
	const heading = /^(?:#{1,6}\s|\*\*[^*]+\*\*\s*$)/;
	for (const line of lines) {
		if (heading.test(line)) {
			inside = /口径|替你定|我定的|拿不准|自行决定|按常规/.test(line);
			continue;
		}
		if (!inside) continue;
		if (/^\s*(?:[-*]|\d+[.、)])\s+\S/.test(line)) count++;
		// 表格：数据行算一条；分隔行说明上一行是表头，扣回去
		else if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) count--;
		else if (/^\s*\|/.test(line)) count++;
	}
	return Math.max(0, count);
}

function collect(records) {
	const results = new Map();
	for (const e of records)
		if (e.type === "message" && e.message?.role === "toolResult")
			results.set(e.message.toolCallId, { text: textOf(e.message.content), error: !!e.message.isError });
	const rounds = [],
		calls = [];
	let prev = null,
		model = 0,
		tool = 0,
		finalText = "";
	for (const e of records) {
		if (e.type !== "message" || !e.message) continue;
		const m = e.message,
			at = ms(e.timestamp);
		if (m.role === "user") {
			prev = at;
			continue;
		}
		const gap = prev === null || at === null ? null : at - prev;
		if (m.role === "toolResult" && gap !== null && gap < AWAY_MS) tool += gap;
		if (m.role === "assistant") {
			const u = m.usage ?? {};
			if (gap !== null && gap < AWAY_MS) model += gap;
			const thinking = textOf(m.content, "thinking");
			const text = textOf(m.content);
			if (text.trim()) finalText = text;
			rounds.push({
				round: rounds.length + 1,
				latencyMs: gap !== null && gap < AWAY_MS ? gap : null,
				outputTokens: typeof u.output === "number" ? u.output : null,
				contextTokens: [u.input, u.cacheRead].every((v) => typeof v === "number")
					? u.input + u.cacheRead + (u.cacheWrite ?? 0)
					: null,
				thinkingChars: thinking.length,
				thinking,
			});
			for (const p of Array.isArray(m.content) ? m.content : [])
				if (p.type === "toolCall")
					calls.push({ round: rounds.length, name: p.name, args: p.arguments ?? {}, result: results.get(p.id) });
		}
		prev = at;
	}
	return { rounds, calls, model, tool, finalText };
}

/** 确认单参数里键名像"口径、决定、选择"的值，任意层级。 */
function decisionSlots(value, out = []) {
	if (Array.isArray(value)) for (const v of value) decisionSlots(v, out);
	else if (value && typeof value === "object")
		for (const [k, v] of Object.entries(value))
			if (/decision|choice|assum|口径/i.test(k)) out.push(JSON.stringify(v));
			else decisionSlots(v, out);
	return out;
}

/** 清单规则要看的几段文字。 */
function corpora(calls, finalText) {
	const isWrite = (c) => c.name === "cosmic_probe" && /Write/.test(String(c.args.name ?? ""));
	const ok = (c) => !!c.result && !c.result.error && okEnvelope(c.result.text);
	const applies = calls.filter((c) => isWrite(c) && c.args.env?.APPLY && ok(c));
	const envText = (c) =>
		Object.entries(c.args.env ?? {})
			.filter(([k]) => !/^(?:APPLY|.*_BACKUP)$/.test(k))
			.map(([k, v]) => (/_(?:EDIT|SET)$/.test(k) ? String(v) : `${k}=${v}`))
			.join("\n");
	// 业务代码：.java，且不在 .cosmic-ai 下（那里是临时探针）
	const javaPath = (c) => {
		const path = String(c.args.path ?? c.args.file_path ?? "").replaceAll("\\", "/");
		return /\.java$/i.test(path) && !/(?:^|\/)\.cosmic-ai\//.test(path);
	};
	const code = calls
		.filter((c) => ["write", "edit"].includes(c.name) && javaPath(c))
		.map((c) =>
			c.name === "write"
				? String(c.args.content ?? "")
				: (c.args.edits ?? [{ newText: c.args.newText ?? c.args.new_string }])
						.map((x) => x.newText ?? "")
						.join("\n"),
		)
		.join("\n");
	const firstWrite = calls.findIndex(
		(c) => (isWrite(c) && c.args.env?.APPLY) || (["write", "edit"].includes(c.name) && javaPath(c)),
	);
	const lastApply = calls.lastIndexOf(applies.at(-1));
	const line = (c) => `${c.name} ${ok(c) ? "ok" : "fail"} ${JSON.stringify(c.args)}`;
	const compiles = calls.filter((c) => c.name === "cosmic_fast");
	return {
		apply: applies.map(envText).join("\n"),
		code,
		final: finalText,
		results: calls.map(line).join("\n"),
		afterApply:
			lastApply < 0
				? ""
				: calls
						.slice(lastApply + 1)
						.map(line)
						.join("\n"),
		lastCompile: compiles.length ? (ok(compiles.at(-1)) ? "ok" : "fail") : "",
		// 写入前专门摆给用户拍板的：提问，以及确认单里列口径的那一格（键名带 decision / choice / 口径）。
		// 确认单的"这次改什么"顺口提到的不算，中途的 assistant 文字也不算，用户不一定看。
		beforeWrite: calls
			.filter((_, i) => firstWrite < 0 || i <= firstWrite)
			.flatMap((c) =>
				c.name === "ask_question"
					? [JSON.stringify(c.args)]
					: c.name === "cosmic_authorize"
						? decisionSlots(c.args)
						: [],
			)
			.join("\n"),
	};
}

function test(pattern, texts, fallback) {
	const where = pattern.in ?? fallback;
	const re = new RegExp(pattern.re, pattern.flags ?? "m");
	const text = texts[where] ?? "";
	if (pattern.count) {
		const g = new RegExp(pattern.re, `${pattern.flags ?? "m"}g`);
		return new Set([...text.matchAll(g)].map((m) => m[0])).size >= pattern.count;
	}
	return re.test(text);
}

export function evaluateChecklist(texts, checklist) {
	const items = checklist.items.map((item) => {
		if (item.manual) return { id: item.id, text: item.text, status: "manual" };
		const where = item.in ?? "apply";
		const all = (item.all ?? []).filter((p) => !test(p, texts, where));
		const any = item.any ? item.any.some((p) => test(p, texts, where)) : true;
		const none = (item.none ?? []).filter((p) => test(p, texts, where));
		const done = !all.length && any && !none.length;
		const missing = [
			...all.map((p) => p.label ?? p.re),
			...(any ? [] : ["（以下任一都没做到）"]),
			...none.map((p) => `不该有：${p.label ?? p.re}`),
		];
		return { id: item.id, text: item.text, status: done ? "done" : "missed", ...(done ? {} : { missing }) };
	});
	const decisions = (checklist.decisions ?? []).map((d) => {
		const hit = (where) => d.mention.some((re) => new RegExp(re, "im").test(texts[where] ?? ""));
		return {
			id: d.id,
			text: d.text,
			shown: hit("beforeWrite") ? "beforeWrite" : hit("final") ? "finalOnly" : "none",
		};
	});
	const n = (s) => items.filter((i) => i.status === s).length;
	const d = (s) => decisions.filter((x) => x.shown === s).length;
	return {
		name: checklist.name,
		done: n("done"),
		missed: n("missed"),
		manual: n("manual"),
		total: items.length,
		decisions: { beforeWrite: d("beforeWrite"), finalOnly: d("finalOnly"), none: d("none"), total: decisions.length },
		items,
		decisionDetails: decisions,
	};
}

/**
 * `review` 是人工复核过的类别，键为"会话文件名的时间戳前缀#轮次"（如 `2026-10-04T14-32-27#8`），
 * 有就用它，没有用规则初判；两样都留在明细里（kind / auto / reviewed）。
 */
export function measureDelivery(
	records,
	{ checklist = null, longTokens = LONG_ROUND_TOKENS, sessionKey = "", review = {}, fullThinking = false } = {},
) {
	const { rounds, calls, model, tool, finalText } = collect(records);
	const base = measureSession(records);
	const writes = calls.filter((c) => c.name === "cosmic_probe" && /Write/.test(String(c.args.name ?? "")));
	const dry = writes.filter((c) => !c.args.env?.APPLY);
	const long = rounds
		.filter((r) => (r.outputTokens ?? 0) >= longTokens)
		.map(({ thinking, ...r }) => {
			const auto = classifyThought(thinking);
			const reviewed = review[`${sessionKey}#${r.round}`] ?? null;
			return {
				...r,
				...auto,
				auto: auto.kind,
				kind: reviewed ?? auto.kind,
				reviewed: !!reviewed,
				excerpt: thinking.replace(/\s+/g, " ").slice(0, 240),
				dryRunsBefore: dry.filter((c) => c.round < r.round).length,
				...(fullThinking ? { thinking } : {}),
			};
		});
	const byKind = Object.fromEntries(Object.keys(THOUGHT_LABELS).map((k) => [k, 0]));
	for (const r of long) byKind[r.kind]++;
	const outputTokens = rounds.reduce((n, r) => n + (r.outputTokens ?? 0), 0);
	const rejected = dry.filter((c) => !c.result || c.result.error || !okEnvelope(c.result.text));
	const texts = corpora(calls, finalText);
	return {
		version: DELIVERY_VERSION,
		elapsedMs: base.elapsedMs,
		calls: calls.length,
		modelRounds: rounds.length,
		modelMs: model,
		toolMs: tool,
		outputTokens,
		long: {
			threshold: longTokens,
			rounds: long.length,
			outputTokens: long.reduce((n, r) => n + r.outputTokens, 0),
			latencyMs: long.reduce((n, r) => n + (r.latencyMs ?? 0), 0),
			byKind,
			reviewed: long.filter((r) => r.reviewed).length,
			changedByReview: long.filter((r) => r.reviewed && r.kind !== r.auto).length,
			withDrafts: long.filter((r) => r.drafts).length,
			details: long,
		},
		trial: {
			dryRuns: dry.length,
			dryRejected: rejected.length,
			rejectedItems: rejected.reduce((n, c) => n + Number(c.result?.text.match(/有 (\d+) 处问题/)?.[1] ?? 0), 0),
			dryTargets: new Set(dry.map((c) => writeTarget(c.args.env ?? {}))).size,
			failures: base.recovery.length,
			recovered: base.recovery.filter((r) => r.recoveredAt !== null).length,
			toolOutputReads: base.toolOutputReads.calls,
		},
		decisions: {
			stated: countStatedDecisions(finalText),
			asked: calls.filter((c) => c.name === "ask_question").length,
		},
		rounds: rounds.map(({ thinking, ...r }) => r),
		checklist: checklist ? evaluateChecklist(texts, checklist) : null,
	};
}

const CONTEXT_BUCKETS = [
	["<30K", 30_000],
	["30-60K", 60_000],
	["60-100K", 100_000],
	["100-150K", 150_000],
	[">=150K", Infinity],
];

/** 每轮耗时按上下文大小分桶：看耗时跟上下文长短走还是跟输出 token 走。 */
export function latencyByContext(sessions) {
	const rows = Object.fromEntries(CONTEXT_BUCKETS.map(([k]) => [k, { rounds: 0, latencyMs: 0, outputTokens: 0 }]));
	for (const s of sessions)
		for (const r of s.rounds) {
			if (r.latencyMs === null || r.contextTokens === null || r.outputTokens === null) continue;
			const [k] = CONTEXT_BUCKETS.find(([, max]) => r.contextTokens < max);
			rows[k].rounds++;
			rows[k].latencyMs += r.latencyMs;
			rows[k].outputTokens += r.outputTokens;
		}
	return Object.fromEntries(
		Object.entries(rows)
			.filter(([, v]) => v.rounds)
			.map(([k, v]) => [
				k,
				{
					rounds: v.rounds,
					avgLatencyMs: Math.round(v.latencyMs / v.rounds),
					avgOutputTokens: Math.round(v.outputTokens / v.rounds),
					msPerOutputToken: v.outputTokens ? +(v.latencyMs / v.outputTokens).toFixed(1) : null,
				},
			]),
	);
}
