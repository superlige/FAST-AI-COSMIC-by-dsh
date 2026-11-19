#!/usr/bin/env node

// 量一份会话里，模型每一轮有没有接着上一轮的提示缓存往下用。
//
// 用法：
//   node scripts/measure-prompt-cache.mjs <会话.jsonl…> [--series] [--json]
//   node scripts/measure-prompt-cache.mjs --dir <会话目录> [--from 2026-09-25] [--to 2026-10-10] [--min-rounds 8]
//
// 口径：
// - 一轮 = 一条带用量的模型回复。这一轮的输入 = 没走缓存的输入 + 缓存读 + 缓存写。
// - 「该接上的轮」：同一段里除第一轮以外的轮。下面几件事之后重新算一段，因为提示的开头本来就换了：
//   用户发了新消息（系统提示重拼）、上下文压缩、换模型、上一轮模型接口报错。
// - 「接上了」：这一轮的缓存读 ≥ 上一轮输入的 90%（上一轮发过的内容这一轮基本没重算）。
//   上一轮过去超过 5 分钟才发这一轮的不算（缓存本来就可能过期），单列「隔太久」。
// - 「重算」：没接上的轮里，上一轮已经发过、这一轮又没走缓存的那部分 token。
// 只读会话记录，不连环境、不调模型。

import { basename } from "node:path";
import { listSessionFiles, readSessionRecords } from "./session-reader.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
};
const valued = new Set(["--dir", "--from", "--to", "--min-rounds"]);
const files = [];
for (let i = 0; i < args.length; i++) {
	if (valued.has(args[i])) i++;
	else if (!args[i].startsWith("--")) files.push(args[i]);
}
const dir = value("--dir");
const from = value("--from");
const to = value("--to");
const minRounds = Number(value("--min-rounds") ?? "1");
if (dir !== undefined) {
	for (const { name, file } of listSessionFiles(dir)) {
		const day = name.slice(0, 10);
		if (from !== undefined && day < from) continue;
		if (to !== undefined && day > to) continue;
		files.push(file);
	}
}
if (files.length === 0) {
	console.error(
		"用法：node scripts/measure-prompt-cache.mjs <会话.jsonl…> | --dir <会话目录> [--from 日期] [--series] [--json]",
	);
	process.exit(2);
}

/** 接上的线：缓存读占上一轮输入的比例。 */
const CONTINUED_RATIO = 0.9;
/** 隔这么久才发下一轮的，缓存本来就可能过期，不算没接上。 */
const STALE_MS = 5 * 60_000;

export function measure(file) {
	const rounds = [];
	let boundary = "开头";
	let previous = null;
	let model = null;
	for (const entry of readSessionRecords(file).records) {
		if (entry.type === "compaction") {
			boundary = "压缩";
			continue;
		}
		if (entry.type === "model_change") {
			boundary = "换模型";
			continue;
		}
		const message = entry.message;
		if (message === undefined) continue;
		if (message.role === "user") {
			boundary = "用户";
			continue;
		}
		if (message.role !== "assistant") continue;
		const at = Date.parse(entry.timestamp);
		const usage = message.usage ?? {};
		const input = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
		if (message.stopReason === "error" || input === 0) {
			boundary = "报错";
			continue;
		}
		if (model !== null && message.model !== model) boundary = "换模型";
		model = message.model;
		const round = {
			at,
			model,
			input,
			cacheRead: usage.cacheRead ?? 0,
			// 一段的第一轮没有「上一轮」可接
			boundary,
			kind: "第一轮",
			redone: 0,
		};
		if (boundary === null && previous !== null) {
			if (at - previous.at > STALE_MS) round.kind = "隔太久";
			else if (round.cacheRead >= previous.input * CONTINUED_RATIO) round.kind = "接上";
			else {
				round.kind = "没接上";
				round.redone = Math.max(0, Math.min(previous.input, round.input) - round.cacheRead);
			}
		}
		rounds.push(round);
		previous = round;
		boundary = null;
	}
	return rounds;
}

function summarize(rounds) {
	const of = (kind) => rounds.filter((round) => round.kind === kind);
	const due = of("接上").length + of("没接上").length;
	return {
		rounds: rounds.length,
		due,
		continued: of("接上").length,
		missed: of("没接上").length,
		stale: of("隔太久").length,
		input: rounds.reduce((sum, round) => sum + round.input, 0),
		cacheRead: rounds.reduce((sum, round) => sum + round.cacheRead, 0),
		redone: rounds.reduce((sum, round) => sum + round.redone, 0),
	};
}

const k = (tokens) => `${(tokens / 1000).toFixed(0)}k`;
const percent = (part, whole) => (whole === 0 ? "—" : `${((part / whole) * 100).toFixed(0)}%`);
const line = (label, s) =>
	`${label}  ${String(s.rounds)} 轮；该接上的 ${String(s.due)} 轮里接上 ${String(s.continued)}、没接上 ${String(s.missed)}（${percent(s.missed, s.due)}）；` +
	`输入 ${k(s.input)}，缓存读 ${percent(s.cacheRead, s.input)}；没接上的轮重算了 ${k(s.redone)}`;

const sessions = [];
for (const file of files) {
	const rounds = measure(file);
	if (rounds.length < minRounds) continue;
	const byModel = new Map();
	for (const round of rounds) {
		const list = byModel.get(round.model) ?? [];
		list.push(round);
		byModel.set(round.model, list);
	}
	sessions.push({ file, rounds, byModel });
}

if (flag("--json")) {
	console.log(
		JSON.stringify(
			sessions.map((session) => ({
				file: session.file,
				total: summarize(session.rounds),
				byModel: Object.fromEntries([...session.byModel].map(([model, rounds]) => [model, summarize(rounds)])),
				...(flag("--series")
					? {
							series: session.rounds.map((r) => ({
								at: r.at,
								model: r.model,
								input: r.input,
								cacheRead: r.cacheRead,
								kind: r.kind,
								boundary: r.boundary,
							})),
						}
					: {}),
			})),
			null,
			2,
		),
	);
} else {
	const total = new Map();
	for (const session of sessions) {
		if (files.length <= 6 || flag("--series")) {
			console.log(basename(session.file).slice(0, 19));
			for (const [model, rounds] of session.byModel) console.log(line(`  ${model}`, summarize(rounds)));
		}
		if (flag("--series")) {
			console.log(
				"  每轮「输入/缓存读」（千 token）：" +
					session.rounds
						.map(
							(r) =>
								`${r.boundary === null ? "" : `|${r.boundary}| `}${(r.input / 1000).toFixed(0)}/${(r.cacheRead / 1000).toFixed(0)}${r.kind === "没接上" ? "✗" : ""}`,
						)
						.join(" "),
			);
		}
		for (const [model, rounds] of session.byModel) total.set(model, [...(total.get(model) ?? []), ...rounds]);
	}
	console.log(`会话 ${String(sessions.length)} 份，按模型汇总：`);
	for (const [model, rounds] of [...total].sort((a, b) => b[1].length - a[1].length))
		console.log(line(`  ${model}`, summarize(rounds)));
}
