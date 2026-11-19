/**
 * 已发账折多宽（S42 §16.12 第 1 条的尺子）。
 *
 * 拿 S34 之前的真机会话（那时还没有已发账，记录里是没折过的原文）按发送规则重放，
 * 比三种折法下 cosmic 返回的原始行重复率（会话尺子 `measureIntake` 的口径）：
 *
 *   - none：不折；
 *   - all：整场会话一本账，任何调用发过的行都折（S34 的做法）；
 *   - same：只折同一调用重问时的重复（同工具、同参数，`raw` / `cold` 不算参数）。
 *
 * 另报 all 下有多少处折叠是「别的调用发过的」——这类折叠标记模型对不上号，
 * 只好再查一次。
 *
 * 用法：
 *   node --experimental-strip-types scripts/measure-sent-fold-scope.ts <会话.jsonl>…
 */

import { readFileSync } from "node:fs";
import { createReminderLedger, foldNotesInValue, foldReminders } from "../src/agent/tools/reminders.ts";
import { createSentLedger, type FoldLimits, foldSentLines, type SentLedger } from "../src/agent/tools/sent-ledger.ts";
import { measureIntake } from "./session-metrics.mjs";

type Result = { tool: string; question: string; parts: string[] };

function questionOf(tool: string, args: Record<string, unknown>): string {
	const rest = Object.entries(args)
		.filter(([key, value]) => key !== "raw" && key !== "cold" && value !== undefined)
		.sort(([a], [b]) => a.localeCompare(b));
	return `${tool} ${JSON.stringify(rest)}`;
}

function load(file: string): Result[] {
	const calls = new Map<string, Record<string, unknown>>();
	const results: Result[] = [];
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (line.trim() === "") continue;
		let entry: { type?: string; message?: Record<string, unknown> };
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		const message = entry.message;
		if (entry.type !== "message" || message === undefined) continue;
		const content = Array.isArray(message.content) ? (message.content as Record<string, unknown>[]) : [];
		for (const part of content)
			if (part.type === "toolCall") calls.set(String(part.id), (part.arguments ?? {}) as Record<string, unknown>);
		if (message.role !== "toolResult") continue;
		const tool = String(message.toolName ?? "");
		if (!tool.startsWith("cosmic_")) continue;
		const parts = content.filter((part) => part.type === "text").map((part) => String(part.text));
		if (parts.length === 0) continue;
		results.push({ tool, question: questionOf(tool, calls.get(String(message.toolCallId)) ?? {}), parts });
	}
	return results;
}

type Mode = "none" | "all" | "same" | FoldLimits;

function apply(results: Result[], mode: Mode): { parts: Result[]; crossFolds: number } {
	const reminders = createReminderLedger();
	const shared = createSentLedger();
	const scoped = new Map<string, SentLedger>();
	// all 模式下，每一行第一次是哪个调用发的：用来数「别的调用发过」的折叠。
	const firstBy = new Map<string, string>();
	let crossFolds = 0;
	const parts = results.map((result) => ({
		...result,
		parts: result.parts.map((text, index) => {
			if (index === 0) {
				try {
					return JSON.stringify(foldNotesInValue(JSON.parse(text), reminders));
				} catch {
					return text;
				}
			}
			const reminded = foldReminders(reminders, text).text;
			if (mode === "none") return reminded;
			let ledger = shared;
			if (mode === "same") {
				ledger = scoped.get(result.question) ?? createSentLedger();
				scoped.set(result.question, ledger);
			}
			const folded = (
				typeof mode === "object" ? foldSentLines(ledger, reminded, mode) : foldSentLines(ledger, reminded)
			).text;
			if (mode === "all") {
				const kept = new Set(folded.split("\n"));
				let crossed = false;
				for (const line of reminded.split("\n")) {
					if (!kept.has(line) && firstBy.has(line) && firstBy.get(line) !== result.question) crossed = true;
					if (!firstBy.has(line)) firstBy.set(line, result.question);
				}
				if (crossed) crossFolds += 1;
			}
			return folded;
		}),
	}));
	return { parts, crossFolds };
}

function records(results: Result[]): unknown[] {
	return results.map((result) => ({
		type: "message",
		message: {
			role: "toolResult",
			toolName: result.tool,
			content: result.parts.map((text) => ({ type: "text", text })),
		},
	}));
}

/** 整场一本账，现行门槛之外再比这几档：连着几行相同才折；整份正文不到多少字节就不折。 */
const RUNS: { name: string; limits: FoldLimits }[] = [
	{ name: "连着 4 行相同才折", limits: { minRun: 4 } },
	{ name: "连着 10 行相同才折", limits: { minRun: 10 } },
	{ name: "连着 20 行相同才折", limits: { minRun: 20 } },
	{ name: "正文不到 1 KB 不折", limits: { minTextBytes: 1024 } },
	{ name: "正文不到 2 KB 不折", limits: { minTextBytes: 2048 } },
	{ name: "正文不到 4 KB 不折", limits: { minTextBytes: 4096 } },
	{ name: "正文不到 8 KB 不折", limits: { minTextBytes: 8192 } },
];
const total: Record<"none" | "all" | "same", [number, number]> & { cross: number } = {
	none: [0, 0],
	all: [0, 0],
	same: [0, 0],
	cross: 0,
};
const byRun = RUNS.map(() => [0, 0]);
let sessions = 0;
for (const file of process.argv.slice(2)) {
	const results = load(file);
	const row: string[] = [];
	for (const mode of ["none", "all", "same"] as const) {
		const { parts, crossFolds } = apply(results, mode);
		const cosmic = measureIntake(records(parts)).bySource.cosmic ?? { textBytes: 0, repeatedBytes: 0 };
		total[mode][0] += cosmic.repeatedBytes;
		total[mode][1] += cosmic.textBytes;
		if (mode === "all") total.cross += crossFolds;
		row.push(
			`${mode} ${String(cosmic.repeatedBytes)}/${String(cosmic.textBytes)}${mode === "all" ? ` 跨调用折 ${String(crossFolds)} 处` : ""}`,
		);
	}
	RUNS.forEach((run, at) => {
		const cosmic = measureIntake(records(apply(results, run.limits).parts)).bySource.cosmic ?? {
			textBytes: 0,
			repeatedBytes: 0,
		};
		const sum = byRun[at] as number[];
		sum[0] = (sum[0] ?? 0) + cosmic.repeatedBytes;
		sum[1] = (sum[1] ?? 0) + cosmic.textBytes;
	});
	sessions += 1;
	console.log(`${file.split(/[\\/]/).pop()?.slice(0, 24)}  ${row.join("  ")}`);
}
const pct = ([repeated, text]: number[]): string => `${((100 * (repeated ?? 0)) / (text || 1)).toFixed(2)}%`;
console.log(
	`合计  不折 ${pct(total.none)}  整场一本账 ${pct(total.all)}（跨调用折 ${String(total.cross)} 处）  只折同一调用 ${pct(total.same)}`,
);
// 门槛抬高要多发多少字：和现行（整场一本账）比，每份会话平均多发几 KB。
const kb = (bytes: number): string => (bytes / 1024 / Math.max(1, sessions)).toFixed(1);
const sentNow = total.all[1] ?? 0;
console.log(
	`每份会话 cosmic 返回平均：不折 ${kb(total.none[1] ?? 0)} KB，现行门槛 ${kb(sentNow)} KB（省 ${kb((total.none[1] ?? 0) - sentNow)} KB）`,
);
RUNS.forEach((run, at) => {
	const sum = byRun[at] as number[];
	console.log(
		`  ${run.name}：重复率 ${pct(sum)}，每份平均 ${kb(sum[1] ?? 0)} KB（比现行多发 ${kb((sum[1] ?? 0) - sentNow)} KB）`,
	);
});
