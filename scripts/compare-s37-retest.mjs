#!/usr/bin/env node
/**
 * S37 批 4：基线会话和复测会话按 §2 的各项并排出数。
 *
 * 用法：node scripts/compare-s37-retest.mjs <基线.jsonl> <复测.jsonl> [--json]
 *
 * 大部分数来自会话尺子 `measureSession` / `measureIntake`（同一计量版本量两边）；尺子本身不数的几项在这里从会话记录直接数：
 *   - 写在 `.cosmic-ai/probes/` 下的临时探针（按文件去重）；
 *   - 用 `cat -A` 看控制字符的 bash 调用；
 *   - 工具返回里说「此前 N 次运行都带着它」的次数（老面孔说法，是不是说错要人工核）；
 *   - 造数 / 改数探针调用次数与其中失败的次数；
 *   - 等用户回答的秒数（ask_question 从调用到返回）。
 * 只读会话记录，不代表业务结果；业务上做对没有，要看交付回执和人工复核。
 */
import { readFileSync } from "node:fs";
import { measureIntake, measureSession } from "./session-metrics.mjs";

function load(file) {
	return readFileSync(file, "utf8")
		.split(/\r?\n/)
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line));
}

function textOf(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("");
}

function extras(records) {
	const probes = new Set();
	let catA = 0,
		oldFace = 0,
		dataWrites = 0,
		dataWriteFailures = 0,
		askMs = 0;
	const pending = new Map();
	for (const entry of records) {
		const message = entry.message;
		if (entry.type !== "message" || !message) continue;
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const part of message.content) {
				if (part?.type !== "toolCall") continue;
				const args = part.arguments ?? {};
				const text = JSON.stringify(args);
				if (
					(part.name === "write" || part.name === "edit") &&
					/\.cosmic-ai[\\/]+probes[\\/]+/.test(String(args.path ?? ""))
				)
					probes.add(String(args.path).replace(/\\/g, "/"));
				if (part.name === "bash" && /cat\s+-A\b/.test(String(args.command ?? ""))) catA++;
				if (part.name === "cosmic_probe" && /DataSeedProbe|DataUpdateProbe/.test(String(args.name ?? ""))) {
					dataWrites++;
					pending.set(part.id, { kind: "data" });
				}
				if (part.name === "ask_question") pending.set(part.id, { kind: "ask", at: Date.parse(entry.timestamp) });
				void text;
			}
		}
		if (message.role === "toolResult") {
			const text = textOf(message.content);
			if (/此前 \d+ 次运行都带着它/.test(text)) oldFace++;
			const call = pending.get(message.toolCallId);
			if (call?.kind === "data" && (message.isError || /"ok":\s*false/.test(text))) dataWriteFailures++;
			if (call?.kind === "ask") askMs += Date.parse(entry.timestamp) - call.at;
		}
	}
	return {
		tempProbes: probes.size,
		catA,
		oldFace,
		dataWrites,
		dataWriteFailures,
		askSeconds: Math.round(askMs / 1000),
	};
}

/** 实际回答用的模型（按 assistant 消息计次），开头切换过的不算。 */
function modelsOf(records) {
	const counts = new Map();
	for (const r of records)
		if (r.message?.role === "assistant" && r.message.model)
			counts.set(r.message.model, (counts.get(r.message.model) ?? 0) + 1);
	return [...counts].map(([model, n]) => `${model}×${n}`).join(" ");
}

function row(file) {
	const records = load(file);
	const metrics = measureSession(records);
	const intake = measureIntake(records);
	const failures = Object.fromEntries(Object.entries(metrics.failures ?? {}).map(([code, v]) => [code, v.calls]));
	return {
		file,
		model: modelsOf(records),
		calls: metrics.calls,
		modelCalls: metrics.modelUsage?.calls?.length ?? null,
		minutes: Math.round((metrics.elapsedMs / 60000) * 10) / 10,
		firstProgress: metrics.firstProgress?.seq ?? null,
		firstAction: metrics.firstAction?.seq ?? null,
		longestNoProgress: metrics.longestNoProgress?.calls ?? null,
		repeatedFailureRefusals: failures.COSMIC_REPEATED_FAILURE ?? 0,
		failures,
		reads: Object.fromEntries(Object.entries(metrics.reads ?? {}).map(([k, v]) => [k, `${v.calls} / ${v.bytes}`])),
		toolOutputReads: `${metrics.toolOutputReads?.calls ?? 0} / ${metrics.toolOutputReads?.bytes ?? 0}`,
		pythonJsonReads: metrics.pythonJsonReads ?? 0,
		cosmicResultBytes: metrics.cosmic?.result ?? null,
		cosmicRepeat: intake.total ? `${intake.total.repeatedBytes} / ${intake.total.textBytes}` : null,
		compactions: intake.compactions ?? null,
		peakContextTokens: metrics.modelUsage?.peakContextTokens ?? null,
		cacheHitRate:
			metrics.modelUsage?.cacheHitRate === undefined
				? null
				: Math.round(metrics.modelUsage.cacheHitRate * 1000) / 10,
		...extras(records),
	};
}

const args = process.argv.slice(2);
const json = args.includes("--json");
const [base, retest] = args.filter((a) => a !== "--json");
if (base === undefined || retest === undefined) {
	console.error("用法：node scripts/compare-s37-retest.mjs <基线.jsonl> <复测.jsonl> [--json]");
	process.exit(2);
}
const a = row(base);
const b = row(retest);
if (json) {
	console.log(JSON.stringify({ base: a, retest: b }, null, 2));
} else {
	const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => k !== "file");
	console.log(`基线：${a.file}\n复测：${b.file}\n`);
	for (const key of keys) {
		const show = (v) => (typeof v === "object" && v !== null ? JSON.stringify(v) : String(v));
		console.log(`${key.padEnd(24)} ${show(a[key]).padEnd(40)} ${show(b[key])}`);
	}
}
