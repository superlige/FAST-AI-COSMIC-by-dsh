#!/usr/bin/env node

/**
 * 会话账本：把一份会话（pi 或 dsh）按「谁占了多少字节」拆开。
 *
 * 为什么要先有这把尺子：S20 之前所有关于「上下文被谁撑爆」的说法都是估的，
 * 而估出来的结论恰好是错的——直觉说「调用次数太多」，量出来是「两次调用一次性
 * 倒进来 41 万字符」。没有可复现的数字，改完也无法说「降下来了」。
 *
 * 计量口径：**JSON 序列化后的字符数**（`JSON.stringify(x).length`），不是 UTF-8 字节数。
 * 选它是因为进模型上下文的就是这份序列化文本，中文按一个字符算一个位置，
 * 和 UTF-8 字节数（一个汉字 3 字节）差出近一倍。本文件里说的「字节」都指这个口径。
 *
 * 只读，不改任何东西。
 *
 * 用法：
 *   node scripts/analyze-session.mjs <会话.jsonl> [--top N] [--json] [--call N]
 *
 *   --top N    各排行榜列前 N 项（默认 10）
 *   --json     输出机读 JSON，便于两次会话做对照
 *   --call N   单独拆解第 N 次工具返回（序号见「最贵的几次返回」一栏）
 *   --metrics-only  只输出 S34 UTF-8 账与 S36 绕路账；旧 ledger 仍是字符口径
 *   --prompt-current  另量当前源码两个模式的系统提示和工具说明字节（不是历史请求）
 *   --dir DIR --from YYYY-MM-DD --to YYYY-MM-DD --min-bytes N
 *              批量读取指定 UTC 文件日期、大于 N 字节的会话，按文件名排序汇总
 *
 * pi 的会话文件在 `~/.pi/agent/sessions/<工程标识>/<时间戳>_<会话 id>.jsonl`；dsh 的在
 * `~/.dsh/sessions/<工程标识>/<会话 id>/session.v4.jsonl.zstd`（给会话目录也行），两种都认，见 `session-reader.mjs`。
 */

import { execFileSync } from "node:child_process";
import { CATEGORY_LABELS, measureSession, STALL_LABELS, summarizeMetrics } from "./session-metrics.mjs";
import { listSessionFiles, readSessionRecords, readSessionText } from "./session-reader.mjs";

// ----------------------------------------------------------------- 口径

/** 一段内容进上下文时占多少位置。见文件头对口径的说明。 */
const size = (value) => JSON.stringify(value ?? null).length;

/** 这些键的值是「某个字段/控件的标识」，同形折叠时要把它们摘掉。 */
const IDENTIFIER_KEYS = new Set(["field", "key", "path", "id", "name"]);

/**
 * 除掉标识之后这条记录还剩什么形状。
 *
 * 1,354 条「这个控件在布局里本来就是隐藏的」之所以能折成一句话，靠的就是它们
 * 除掉字段名之后一模一样。形状相同 = 这些记录对读的人说的是同一句话。
 */
function shapeOf(record) {
	if (typeof record !== "object" || record === null) return JSON.stringify(record);
	return JSON.stringify(Object.fromEntries(Object.entries(record).filter(([key]) => !IDENTIFIER_KEYS.has(key))));
}

// ----------------------------------------------------------------- 读会话

function readSession(file) {
	// 会话文件是边跑边追加的，最后一行可能只写了一半：readSessionRecords 数出来，不假装没有。
	const { records, broken, format } = readSessionRecords(file);
	return { records, broken, format, fileBytes: Buffer.byteLength(readSessionText(file), "utf8") };
}

/** 这次调用叫什么工具、参数是什么 —— 按 toolCallId 对上它的返回。 */
function indexCalls(records) {
	const calls = new Map();
	let seq = 0;
	for (const entry of records) {
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		for (const part of entry.message.content ?? []) {
			if (part.type !== "toolCall") continue;
			seq++;
			calls.set(part.id, {
				seq,
				tool: part.name ?? "?",
				args: part.arguments ?? {},
				argsKey: `${part.name ?? "?"} ${JSON.stringify(part.arguments ?? {})}`,
				at: entry.timestamp ?? "",
				bytes: size(part),
			});
		}
	}
	return calls;
}

// ----------------------------------------------------------------- 分账

function analyze(file) {
	const { records, broken, fileBytes } = readSession(file);
	const calls = indexCalls(records);

	const ledger = {
		thinking: { bytes: 0, count: 0, max: 0 },
		toolResult: { bytes: 0, count: 0, max: 0 },
		toolArgs: { bytes: 0, count: 0, max: 0 },
		assistantText: { bytes: 0, count: 0, max: 0 },
		userText: { bytes: 0, count: 0, max: 0 },
		injected: { bytes: 0, count: 0, max: 0 },
		// 会话状态（`custom` 记录）不进模型上下文，单列一行，别和上面的加在一起。
		sessionState: { bytes: 0, count: 0, max: 0 },
	};
	const put = (row, bytes) => {
		row.bytes += bytes;
		row.count++;
		if (bytes > row.max) row.max = bytes;
	};

	const byTool = new Map();
	const returns = [];
	const thinkingByBucket = new Map();
	let compactions = 0;
	let started = "";
	let ended = "";

	for (const entry of records) {
		if (entry.type === "session") started = entry.timestamp ?? "";
		if (entry.timestamp) ended = entry.timestamp;
		if (entry.type === "compaction") {
			compactions++;
			continue;
		}
		if (entry.type === "custom") {
			put(ledger.sessionState, size(entry));
			continue;
		}
		if (entry.type === "custom_message") {
			// 宿主或扩展插进上下文的文字（dsh 的技能清单、运行时状态、工作区说明），进上下文但不是人说的
			const parts = Array.isArray(entry.content) ? entry.content : [];
			put(
				ledger.injected,
				parts.reduce((sum, part) => sum + size(part), 0),
			);
			continue;
		}
		if (entry.type !== "message") continue;
		const message = entry.message;
		const parts = message?.content;
		if (!Array.isArray(parts)) continue;

		if (message.role === "toolResult") {
			const bytes = parts.reduce((sum, part) => sum + size(part), 0);
			put(ledger.toolResult, bytes);
			const call = calls.get(message.toolCallId);
			const tool = message.toolName ?? call?.tool ?? "?";
			const row = byTool.get(tool) ?? { tool, bytes: 0, count: 0, max: 0 };
			row.bytes += bytes;
			row.count++;
			if (bytes > row.max) row.max = bytes;
			byTool.set(tool, row);
			returns.push({
				tool,
				bytes,
				at: entry.timestamp ?? "",
				callId: message.toolCallId,
				seq: call?.seq ?? null,
				args: call?.args ?? null,
				parts,
			});
			continue;
		}

		for (const part of parts) {
			if (part.type === "thinking") {
				const bytes = size(part);
				put(ledger.thinking, bytes);
				const bucket = String(entry.timestamp ?? "").slice(0, 15);
				thinkingByBucket.set(bucket, (thinkingByBucket.get(bucket) ?? 0) + bytes);
			} else if (part.type === "toolCall") {
				put(ledger.toolArgs, size(part));
			} else if (part.type === "text") {
				put(message.role === "user" ? ledger.userText : ledger.assistantText, size(part));
			}
		}
	}

	return {
		file,
		metrics: measureSession(records),
		fileBytes,
		started,
		ended,
		broken,
		compactions,
		ledger,
		byTool: [...byTool.values()].sort((a, b) => b.bytes - a.bytes),
		returns,
		calls,
		thinkingByBucket,
	};
}

// --------------------------------------------------- 一次返回里装了什么

/** 工具返回的第一个文本块通常是 `{"ok":…,"result":{…}}`；拿不到就当它没有结构。 */
function parseEnvelope(entry) {
	const first = entry.parts.find((part) => part.type === "text");
	if (first === undefined) return null;
	try {
		return JSON.parse(first.text);
	} catch {
		return null;
	}
}

function fieldBreakdown(entry) {
	const envelope = parseEnvelope(entry);
	const result = envelope?.result ?? envelope;
	if (typeof result !== "object" || result === null) return null;
	const rows = Object.entries(result).map(([field, value]) => ({
		field,
		bytes: size(value),
		items: Array.isArray(value) ? value.length : null,
	}));
	// 探针的结构化记录藏在 `json.records` 里，只报一个 `json` 看不出问题出在哪。
	const nested = [];
	for (const [field, value] of Object.entries(result)) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
		for (const [sub, subValue] of Object.entries(value)) {
			nested.push({
				field: `${field}.${sub}`,
				bytes: size(subValue),
				items: Array.isArray(subValue) ? subValue.length : null,
			});
		}
	}
	// 非文本块（渲染出来的散文块）也占位置，单列一行。
	const blocks = entry.parts.filter((part) => part !== entry.parts.find((p) => p.type === "text"));
	return {
		rows: rows.sort((a, b) => b.bytes - a.bytes),
		nested: nested.sort((a, b) => b.bytes - a.bytes),
		blockBytes: blocks.reduce((sum, part) => sum + size(part), 0),
		blockCount: blocks.length,
	};
}

/** 一次返回里带的探针结构化记录。 */
function recordsOf(entry) {
	const envelope = parseEnvelope(entry);
	const result = envelope?.result ?? envelope;
	const records = result?.json?.records ?? result?.probe?.json?.records;
	return Array.isArray(records) ? records : [];
}

function recordCensus(returns) {
	const byType = new Map();
	const byShape = new Map();
	let total = 0;
	let bytes = 0;
	for (const entry of returns) {
		for (const record of recordsOf(entry)) {
			total++;
			bytes += size(record);
			const type = String(record?.t ?? "(无 t)");
			const typeRow = byType.get(type) ?? { type, count: 0, bytes: 0, shapes: new Set() };
			typeRow.count++;
			typeRow.bytes += size(record);
			const shape = shapeOf(record);
			typeRow.shapes.add(shape);
			byType.set(type, typeRow);
			const shapeRow = byShape.get(shape) ?? { shape, count: 0, type };
			shapeRow.count++;
			byShape.set(shape, shapeRow);
		}
	}
	return {
		total,
		bytes,
		byType: [...byType.values()].sort((a, b) => b.bytes - a.bytes),
		byShape: [...byShape.values()].sort((a, b) => b.count - a.count),
	};
}

// ----------------------------------------------------------------- 重复账

/** 同一路径读了几次。read 工具的参数名在不同版本里叫过 filePath / path / file。 */
const readPath = (args) => args?.filePath ?? args?.path ?? args?.file ?? null;

function repeats(analysis) {
	const seen = new Map();
	const duplicates = [];
	const resultBytes = new Map();
	for (const entry of analysis.returns) resultBytes.set(entry.callId, entry.bytes);

	const files = new Map();
	for (const [id, call] of analysis.calls) {
		const first = seen.get(call.argsKey);
		if (first === undefined) seen.set(call.argsKey, call.seq);
		else duplicates.push({ tool: call.tool, seq: call.seq, firstSeq: first, bytes: resultBytes.get(id) ?? 0 });
		if (call.tool === "read") {
			const path = readPath(call.args);
			if (path !== null) {
				const row = files.get(path) ?? { path, count: 0, bytes: 0 };
				row.count++;
				row.bytes += resultBytes.get(id) ?? 0;
				files.set(path, row);
			}
		}
	}
	return {
		duplicates,
		duplicateBytes: duplicates.reduce((sum, row) => sum + row.bytes, 0),
		files: [...files.values()].sort((a, b) => b.count - a.count),
		readCalls: [...files.values()].reduce((sum, row) => sum + row.count, 0),
	};
}

/**
 * 模型拿 bash 在翻什么。
 *
 * 分两类，因为它们是两回事：
 *   - 回读落盘文件（`.cosmic-ai/work/out/`）是**设计里就该发生的**——输出被预算切了，
 *     要看省略段就窄条件 grep 它，一次一两 KB，很便宜；
 *   - 翻 harness 自己的缓存（探针 Java 源码、skill 文档）是**工具没说清自己能干什么**，
 *     模型在反向工程它。这一类的次数应该往下走。
 */
function selfReading(analysis) {
	const spill = [];
	const probeSource = [];
	const skillDoc = [];
	for (const call of analysis.calls.values()) {
		if (call.tool !== "bash") continue;
		const command = String(call.args?.command ?? "");
		if (/[\\/]work[\\/]out[\\/]/.test(command) || /work[\\/]out/.test(command)) spill.push(call.seq);
		if (!/fast-ai-cosmic[\\/]cache/i.test(command)) continue;
		if (/resources[\\/]probes[\\/]|probes[\\/][A-Za-z]+\.java|\.java\b/.test(command)) probeSource.push(call.seq);
		else if (/skills?[\\/]|reference[\\/]|\.md\b/.test(command)) skillDoc.push(call.seq);
	}
	return { spill, probeSource, skillDoc };
}

// ----------------------------------------------------------------- 打印

const pct = (part, whole) => (whole === 0 ? "0%" : `${((part / whole) * 100).toFixed(part / whole < 0.01 ? 2 : 0)}%`);
const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;
const pad = (text, width) => String(text).padEnd(width);
const padLeft = (text, width) => String(text).padStart(width);
const clip = (text, width) => (text.length <= width ? text : `${text.slice(0, width - 1)}…`);

const LEDGER_LABEL = {
	thinking: "模型的思考",
	toolResult: "工具返回",
	toolArgs: "工具调用参数",
	assistantText: "模型说给人听的话",
	userText: "用户说的话",
	injected: "宿主插进来的上下文",
	sessionState: "会话状态记录（不进上下文）",
};

function report(analysis, top) {
	const out = [];
	const { ledger } = analysis;
	const context =
		ledger.thinking.bytes +
		ledger.toolResult.bytes +
		ledger.toolArgs.bytes +
		ledger.assistantText.bytes +
		ledger.userText.bytes +
		ledger.injected.bytes;

	const biggest = [...analysis.returns].sort((a, b) => b.bytes - a.bytes);
	const census = recordCensus(analysis.returns);
	const repeat = repeats(analysis);
	const self = selfReading(analysis);

	out.push(`会话账本：${analysis.file}`);
	out.push(`${analysis.started.slice(0, 19).replace("T", " ")} → ${analysis.ended.slice(0, 19).replace("T", " ")}`);
	out.push("");
	out.push(
		`一句话：进上下文的一共 ${kb(context)}，其中思考 ${pct(ledger.thinking.bytes, context)}、` +
			`工具返回 ${pct(ledger.toolResult.bytes, context)}；最贵的一次工具返回 ${kb(biggest[0]?.bytes ?? 0)}` +
			`（${biggest[0]?.tool ?? "—"}）；自动压缩 ${analysis.compactions} 次。`,
	);
	if (analysis.broken > 0) out.push(`（会话文件里有 ${analysis.broken} 行没解析成功，已跳过。）`);
	out.push(metricsReport(analysis.metrics));

	out.push("");
	out.push("── 钱花在哪 ──────────────────────────────────────────");
	out.push(
		`${pad("谁", 28)}${padLeft("字节", 12)}${padLeft("占上下文", 10)}${padLeft("占全文件", 10)}${padLeft("条数", 8)}${padLeft("单条最大", 12)}`,
	);
	for (const [key, row] of Object.entries(ledger)) {
		// 两个占比：分母不同，结论也不同。「占上下文」是真正该管的那个（会话状态不进上下文，
		// 所以它没有这一栏）；「占全文件」拿会话文件的 UTF-8 字节数做分母，只为了和早期
		// 手工统计对得上——它把中文按 3 字节算，会系统性地把每一项都说小。
		const share = key === "sessionState" ? "—" : pct(row.bytes, context);
		out.push(
			`${pad(LEDGER_LABEL[key], 28)}${padLeft(row.bytes.toLocaleString("en-US"), 12)}${padLeft(share, 10)}` +
				`${padLeft(pct(row.bytes, analysis.fileBytes), 10)}${padLeft(row.count, 8)}${padLeft(row.max.toLocaleString("en-US"), 12)}`,
		);
	}
	out.push(`会话文件本身 ${kb(analysis.fileBytes)}（UTF-8 字节）。「条数」是消息/记录条数，不是工具调用次数。`);

	out.push("");
	out.push("── 工具返回，谁最贵 ──────────────────────────────────");
	out.push(
		`${pad("工具", 22)}${padLeft("字节", 12)}${padLeft("占比", 8)}${padLeft("次数", 7)}${padLeft("单次最大", 11)}${padLeft("单次平均", 11)}`,
	);
	for (const row of analysis.byTool.slice(0, top)) {
		out.push(
			`${pad(row.tool, 22)}${padLeft(row.bytes.toLocaleString("en-US"), 12)}${padLeft(pct(row.bytes, ledger.toolResult.bytes), 8)}` +
				`${padLeft(row.count, 7)}${padLeft(row.max.toLocaleString("en-US"), 11)}${padLeft(Math.round(row.bytes / row.count).toLocaleString("en-US"), 11)}`,
		);
	}
	const rest = analysis.byTool.slice(top);
	if (rest.length > 0) {
		const bytes = rest.reduce((sum, row) => sum + row.bytes, 0);
		const count = rest.reduce((sum, row) => sum + row.count, 0);
		out.push(
			`${pad(`其余 ${rest.length} 个工具合计`, 22)}${padLeft(bytes.toLocaleString("en-US"), 12)}${padLeft(pct(bytes, ledger.toolResult.bytes), 8)}${padLeft(count, 7)}`,
		);
	}

	out.push("");
	out.push("── 最贵的几次返回 ────────────────────────────────────");
	for (const entry of biggest.slice(0, top)) {
		const label = entry.args === null ? "" : clip(JSON.stringify(entry.args), 70);
		out.push(
			`#${padLeft(entry.seq ?? "?", 3)} ${pad(entry.tool, 18)}${padLeft(entry.bytes.toLocaleString("en-US"), 10)}  ${entry.at.slice(11, 19)}  ${label}`,
		);
		const breakdown = fieldBreakdown(entry);
		if (breakdown === null) continue;
		for (const row of [...breakdown.rows, ...breakdown.nested]
			.sort((a, b) => b.bytes - a.bytes)
			.filter((row) => row.bytes > entry.bytes * 0.02)
			.slice(0, 5)) {
			out.push(
				`      ${pad(row.field, 24)}${padLeft(row.bytes.toLocaleString("en-US"), 10)}${row.items === null ? "" : `  ${row.items} 条`}`,
			);
		}
	}

	out.push("");
	out.push("── 探针的结构化记录 ──────────────────────────────────");
	if (census.total === 0) out.push("（这份会话里没有结构化记录）");
	else {
		out.push(`一共 ${census.total.toLocaleString("en-US")} 条，${census.bytes.toLocaleString("en-US")} 字节。`);
		out.push(`${pad("记录种类", 22)}${padLeft("条数", 8)}${padLeft("字节", 12)}${padLeft("去标识后几种说法", 18)}`);
		for (const row of census.byType.slice(0, top)) {
			out.push(
				`${pad(row.type, 22)}${padLeft(row.count.toLocaleString("en-US"), 8)}${padLeft(row.bytes.toLocaleString("en-US"), 12)}${padLeft(row.shapes.size, 18)}`,
			);
		}
		out.push("");
		out.push(
			`同形折叠：${census.total.toLocaleString("en-US")} 条记录去掉字段标识后只有 ${census.byShape.length} 种说法，最集中的几种：`,
		);
		for (const row of census.byShape.slice(0, top)) {
			out.push(`${padLeft(row.count, 6)} 条  ${clip(row.shape, 100)}`);
		}
	}

	out.push("");
	out.push("── 重复账 ────────────────────────────────────────────");
	out.push(
		`完全相同的调用重复了 ${repeat.duplicates.length} 次，多花 ${repeat.duplicateBytes.toLocaleString("en-US")} 字节：`,
	);
	for (const row of repeat.duplicates.slice(0, top)) {
		out.push(
			`  #${row.seq} 与 #${row.firstSeq} 相同（${row.tool}），这次返回 ${row.bytes.toLocaleString("en-US")} 字节`,
		);
	}
	out.push(`文件读取：${repeat.readCalls} 次 read 落在 ${repeat.files.length} 个文件上。`);
	for (const row of repeat.files.slice(0, top).filter((row) => row.count > 1)) {
		out.push(
			`${padLeft(row.count, 4)} 次  ${padLeft(row.bytes.toLocaleString("en-US"), 9)} 字节  ${clip(row.path, 84)}`,
		);
	}

	out.push("");
	out.push("── 模型拿 bash 在翻什么 ──────────────────────────────");
	out.push(`回读落盘文件 ${self.spill.length} 次（这是设计里该发生的，很便宜）`);
	out.push(`翻 harness 自己的探针源码 ${self.probeSource.length} 次、skill/参考文档 ${self.skillDoc.length} 次`);
	out.push("（后两类是工具没把「我能干什么」说清楚，次数应该往下走）");

	if (analysis.thinkingByBucket.size > 0) {
		out.push("");
		out.push("── 思考量按十分钟分布（前几名）────────────────────────");
		const buckets = [...analysis.thinkingByBucket.entries()].sort((a, b) => b[1] - a[1]);
		for (const [bucket, bytes] of buckets.slice(0, 5)) {
			out.push(`  ${bucket.replace("T", " ")}0–${bucket.slice(-1)}9 分    ${kb(bytes)}`);
		}
	}

	return out.join("\n");
}

function toJson(analysis, top) {
	const census = recordCensus(analysis.returns);
	const repeat = repeats(analysis);
	const self = selfReading(analysis);
	const biggest = [...analysis.returns].sort((a, b) => b.bytes - a.bytes).slice(0, top);
	return {
		file: analysis.file,
		broken: analysis.broken,
		metrics: analysis.metrics,
		started: analysis.started,
		ended: analysis.ended,
		compactions: analysis.compactions,
		ledger: analysis.ledger,
		byTool: analysis.byTool,
		biggestReturns: biggest.map((entry) => ({
			seq: entry.seq,
			tool: entry.tool,
			bytes: entry.bytes,
			at: entry.at,
			fields: fieldBreakdown(entry),
		})),
		records: {
			total: census.total,
			bytes: census.bytes,
			byType: census.byType.map((row) => ({ ...row, shapes: row.shapes.size })),
			shapeCount: census.byShape.length,
			topShapes: census.byShape.slice(0, top),
		},
		repeats: {
			duplicateCalls: repeat.duplicates.length,
			duplicateBytes: repeat.duplicateBytes,
			readCalls: repeat.readCalls,
			topFiles: repeat.files.slice(0, top),
		},
		selfReading: { spill: self.spill.length, probeSource: self.probeSource.length, skillDoc: self.skillDoc.length },
	};
}

/** 单独拆一次返回：`--call N` 用的。 */
function oneCall(analysis, seq) {
	const entry = analysis.returns.find((row) => row.seq === seq);
	if (entry === undefined) return `没有第 ${seq} 次工具返回。`;
	const breakdown = fieldBreakdown(entry);
	const out = [`#${seq} ${entry.tool} ${entry.bytes.toLocaleString("en-US")} 字节  ${entry.at}`];
	out.push(`参数：${clip(JSON.stringify(entry.args), 400)}`);
	if (breakdown === null) {
		out.push("（这次返回不是结构化的，没法按字段拆）");
		return out.join("\n");
	}
	out.push("");
	out.push("顶层字段：");
	for (const row of breakdown.rows) {
		out.push(
			`  ${pad(row.field, 24)}${padLeft(row.bytes.toLocaleString("en-US"), 10)}${row.items === null ? "" : `  ${row.items} 条`}`,
		);
	}
	if (breakdown.nested.length > 0) {
		out.push("嵌一层的字段：");
		for (const row of breakdown.nested.slice(0, 20)) {
			out.push(
				`  ${pad(row.field, 24)}${padLeft(row.bytes.toLocaleString("en-US"), 10)}${row.items === null ? "" : `  ${row.items} 条`}`,
			);
		}
	}
	if (breakdown.blockCount > 0)
		out.push(`另有 ${breakdown.blockCount} 个散文块，共 ${breakdown.blockBytes.toLocaleString("en-US")} 字节。`);
	const records = recordsOf(entry);
	if (records.length > 0) {
		const shapes = new Map();
		for (const record of records) shapes.set(shapeOf(record), (shapes.get(shapeOf(record)) ?? 0) + 1);
		out.push("");
		out.push(`这次带了 ${records.length} 条结构化记录，去掉字段标识后 ${shapes.size} 种说法：`);
		for (const [shape, count] of [...shapes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
			out.push(`${padLeft(count, 6)} 条  ${clip(shape, 110)}`);
		}
	}
	return out.join("\n");
}

// ----------------------------------------------------------------- 入口

const stallText = (kinds) =>
	Object.entries(kinds)
		.filter(([, n]) => n > 0)
		.map(([k, n]) => `${STALL_LABELS[k]} ${n}`)
		.join("、") || "无";

function metricsReport(m) {
	return [
		"",
		`── 绕路账 ${m.version}（成功动手才清零；从首条用户消息计时）──`,
		...Object.entries(m.counts).map(([key, value]) => `${CATEGORY_LABELS[key]}：${value}`),
		`首次动手/提问/带断言验证：${m.firstProgress ? `#${m.firstProgress.seq}，${m.firstProgress.elapsedMs / 60000} 分钟` : "无"}`,
		`首次改动/授权：${m.firstAction ? `#${m.firstAction.seq}，${m.firstAction.elapsedMs / 60000} 分钟` : "无"}`,
		`最长连续未推进：${m.longestNoProgress.calls} 次（#${m.longestNoProgress.from}～#${m.longestNoProgress.to}）`,
		`未推进调用细分 ${m.stall.version}（只说做了什么，不判该不该做）：${stallText(m.stall.kinds)}`,
		...m.stall.runs.map(
			(r) =>
				`  #${r.from}～#${r.to}（${r.calls} 次，${r.elapsedMs === null ? "?" : Math.round(r.elapsedMs / 6000) / 10} 分钟）：${stallText(r.kinds)}`,
		),
		`失败后同操作成功：${m.recovery.filter((r) => r.recoveredAt !== null).length}/${m.recovery.length}；其余未知，不当作已恢复`,
		`翻内部文件：${m.internalReads} 次；其中 Python 解析 JSON ${m.pythonJsonReads} 次；大范围搜索标签 ${m.broadSearches} 次`,
		`绕过工具翻它写出的文件：${m.toolOutputReads.calls} 次、${m.toolOutputReads.bytes} 字节；其中 Python ${m.toolOutputReads.python} 次，显示控制字符 ${m.toolOutputReads.showControl} 次，同一调用顺带写文件 ${m.toolOutputReads.withWrite} 次`,
		`读取 UTF-8 账：${JSON.stringify(m.reads)}`,
		`cosmic 返回 UTF-8 账：${JSON.stringify(m.cosmic)}；按工具：${JSON.stringify(m.cosmicByTool)}`,
		`重复账 ${m.intake.version}：${JSON.stringify(m.intake.bySource)}`,
		`返回提示文字（已识别字段）：${m.intake.prompt.measuredBytes} 字节；未解析散文：${m.intake.prompt.unparsedCosmicBytes} 字节`,
		`提示缓存命中率：${m.modelUsage.cacheHitRate ?? "未知"}；上下文峰值：${m.modelUsage.peakContextTokens ?? "未知"}`,
		`待复核调用 ${m.uncertainCalls.length}，缺返回 ${m.missingResults.length}，分支记录 ${m.branched}（按文件发生顺序统计）`,
	].join("\n");
}

try {
	const argv = process.argv.slice(2),
		options = {},
		files = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (["--json", "--metrics-only", "--prompt-current"].includes(arg)) options[arg] = true;
		else if (["--top", "--call", "--dir", "--from", "--to", "--min-bytes"].includes(arg)) {
			if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error(`${arg} 缺参数`);
			options[arg] = argv[++i];
		} else if (arg.startsWith("--")) throw new Error(`未知参数 ${arg}`);
		else files.push(arg);
	}
	for (const key of ["--top", "--call", "--min-bytes"]) {
		if (
			options[key] !== undefined &&
			(!/^\d+$/.test(options[key]) || Number(options[key]) < (key === "--min-bytes" ? 0 : 1))
		)
			throw new Error(`${key} 必须是有效整数`);
	}
	for (const key of ["--from", "--to"])
		if (options[key] && !/^\d{4}-\d{2}-\d{2}$/.test(options[key])) throw new Error(`${key} 必须是 YYYY-MM-DD`);
	if (options["--dir"]) {
		if (files.length) throw new Error("文件与 --dir 只能选一个");
		for (const { name, file } of listSessionFiles(options["--dir"])) {
			const date = name.slice(0, 10);
			if ((options["--from"] && date < options["--from"]) || (options["--to"] && date > options["--to"])) continue;
			if (Buffer.byteLength(readSessionText(file), "utf8") > Number(options["--min-bytes"] ?? 0)) files.push(file);
		}
	}
	const promptSurface = options["--prompt-current"]
		? JSON.parse(
				execFileSync(
					process.execPath,
					[
						"--experimental-strip-types",
						"--input-type=module",
						"-e",
						`import { fixedTextBytes } from ${JSON.stringify(new URL("../src/dsh/fixed-text.ts", import.meta.url).href)}; console.log(JSON.stringify({ dev: fixedTextBytes("dev"), prod: fixedTextBytes("prod") }));`,
					],
					{ encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
				),
			)
		: null;
	if (!files.length && !promptSurface)
		throw new Error(
			"没有会话。用法：analyze-session.mjs <会话.jsonl> [--top N] [--json] [--call N]；或 --dir <目录> --from YYYY-MM-DD --to YYYY-MM-DD --min-bytes 200000 [--metrics-only --json]",
		);
	if (options["--call"] && files.length !== 1) throw new Error("--call 只适用于单份会话");
	const analyses = files.map(analyze),
		top = Number(options["--top"] ?? 10);
	if (!files.length) console.log(JSON.stringify({ promptSurface }, null, "\t"));
	else if (options["--call"]) console.log(oneCall(analyses[0], Number(options["--call"])));
	else if (options["--json"]) {
		const rows = analyses.map((a) =>
			options["--metrics-only"] ? { file: a.file, broken: a.broken, metrics: a.metrics } : toJson(a, top),
		);
		console.log(
			JSON.stringify(
				{
					...(rows.length === 1
						? rows[0]
						: { summary: summarizeMetrics(rows.map((r) => r.metrics)), sessions: rows }),
					...(promptSurface ? { promptSurface } : {}),
				},
				null,
				"\t",
			),
		);
	} else {
		if (promptSurface) console.log(JSON.stringify({ promptSurface }, null, "\t"));
		for (const a of analyses)
			console.log(options["--metrics-only"] ? `${a.file}\n${metricsReport(a.metrics)}` : report(a, top));
		if (analyses.length > 1)
			console.log(JSON.stringify(summarizeMetrics(analyses.map((a) => a.metrics)), null, "\t"));
	}
} catch (error) {
	console.error(error.message);
	process.exitCode = 2;
}
