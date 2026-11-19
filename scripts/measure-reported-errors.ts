/**
 * 尺子：用户贴了报错的提问里，模型有没有把报错原文跑出来、改完有没有用同一条命令验过。
 *
 *   node --experimental-strip-types scripts/measure-reported-errors.ts --dir <会话目录> [--from 日期] [--to 日期或时刻] [--show]
 *   node --experimental-strip-types scripts/measure-reported-errors.ts <会话.jsonl…> [--show]
 *
 * 一次「报错提问」从用户贴出报错的那句话起，到会话结束或下一句贴了别的报错为止（中间的追问算同一件事）。
 * 认报错、比原文、折结论在 `scripts/reported-error-match.ts`，是按规则认的，认不全（见那个文件开头）：
 * 数出来的只是线索，每一句都要人翻会话复核。结论四种：
 *
 *   fixed       改之前跑出来过，改之后同一条命令不再出现
 *   still       改之后同一条命令还在出现
 *   unverified  跑出来过，改之后没用同一条命令再跑
 *   never       从没跑出来过
 *   （没改）     这次没有改业务代码、没写共享环境
 *
 * 另数两样和「用户等了多久才听到一句话」有关的：贴出报错后，模型说第一句话之前调了几次工具、过了多久。
 *
 * 比的是会话里发给模型的那份输出（中段可能被裁掉）；临时探针改写过没有，按「写过几次」算。
 *
 * 只读会话文件。`--show` 逐次列出每条命令。
 */
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { scenarioKeyOf } from "../src/kernel/verify/evidence.ts";
import {
	type ErrorSighting,
	errorLabel,
	errorShownIn,
	noteSighting,
	type ReportedError,
	reportedErrorStatus,
	reportedErrors,
} from "./reported-error-match.ts";

const argv = process.argv.slice(2);
const one = (name: string): string | undefined => {
	const at = argv.indexOf(name);
	return at < 0 ? undefined : argv[at + 1];
};
const dir = one("--dir");
const from = one("--from");
const to = one("--to");
const show = argv.includes("--show");
const files =
	dir === undefined
		? argv.filter((arg) => arg.endsWith(".jsonl"))
		: readdirSync(dir)
				.filter(
					(name) =>
						name.endsWith(".jsonl") &&
						(from === undefined || name.slice(0, 10) >= from) &&
						(to === undefined || name.slice(0, to.length) <= to),
				)
				.sort()
				.map((name) => join(dir, name));
if (files.length === 0) {
	console.error(
		"用法：measure-reported-errors.ts --dir <会话目录> [--from 日期] [--to 日期或时刻] [--show] | <会话.jsonl…>",
	);
	process.exit(2);
}

interface Case {
	file: string;
	at: string;
	errors: ReportedError[];
	calls: number;
	/** 第一句话之前调了几次工具、过了几秒；一直没说话的是 null。 */
	firstWord: { calls: number; seconds: number } | null;
	sightings: ErrorSighting[];
	/** 第几次调用第一次跑出原文。 */
	firstShownCall: number | null;
	firstChangeAt: string | null;
	lastChangeAt: string | null;
	receipt: boolean;
	lines: string[];
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("");
}

function isAdHoc(path: string): boolean {
	return path.replace(/\\/g, "/").includes("/.cosmic-ai/");
}

const cases: Case[] = [];
let prompts = 0;
for (const file of files) {
	let current: Case | null = null;
	const pending = new Map<string, { name: string; input: Record<string, unknown> }>();
	const probeWrites = new Map<string, number>();
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (line === "") continue;
		let entry: { timestamp?: string; message?: { role?: string; content?: unknown; toolCallId?: string } };
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		const message = entry.message;
		if (message === undefined) continue;
		const at = entry.timestamp ?? "";
		if (message.role === "user") {
			prompts += 1;
			const errors = reportedErrors(textOf(message.content));
			if (errors.length > 0) {
				current = {
					file: basename(file).slice(0, 19),
					at,
					errors,
					calls: 0,
					firstWord: null,
					sightings: [],
					firstShownCall: null,
					firstChangeAt: null,
					lastChangeAt: null,
					receipt: false,
					lines: [],
				};
				cases.push(current);
			}
			continue;
		}
		if (current === null) continue;
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const part of message.content as {
				type?: string;
				text?: string;
				id?: string;
				name?: string;
				arguments?: unknown;
			}[]) {
				if (part.type === "text" && (part.text ?? "").trim() !== "" && current.firstWord === null) {
					current.firstWord = {
						calls: current.calls,
						seconds: Math.round((Date.parse(at) - Date.parse(current.at)) / 1000),
					};
				}
				if (part.type === "toolCall" && typeof part.id === "string") {
					current.calls += 1;
					pending.set(part.id, {
						name: part.name ?? "",
						input: (part.arguments ?? {}) as Record<string, unknown>,
					});
				}
			}
			continue;
		}
		if (message.role !== "toolResult" || typeof message.toolCallId !== "string") continue;
		const call = pending.get(message.toolCallId);
		if (call === undefined) continue;
		pending.delete(message.toolCallId);
		const output = textOf(message.content);
		if (call.name === "write" || call.name === "edit") {
			const path = String(call.input.file_path ?? call.input.path ?? "");
			if (!path.toLowerCase().endsWith(".java")) continue;
			if (isAdHoc(path)) {
				const name = basename(path);
				probeWrites.set(name, (probeWrites.get(name) ?? 0) + 1);
			} else {
				current.firstChangeAt ??= at;
				current.lastChangeAt = at;
				current.lines.push(`    ${at.slice(11, 19)}  改 ${basename(path)}`);
			}
			continue;
		}
		if (call.name === "cosmic_verify" && /"receiptFile":"[^"]/.test(output)) current.receipt = true;
		if (call.name !== "cosmic_probe" && call.name !== "cosmic_run") continue;
		if (typeof call.input.raw === "string") continue;
		let key: string;
		let command: string;
		if (call.name === "cosmic_run") {
			const words = Array.isArray(call.input.argv) ? call.input.argv.map((word) => String(word)) : [];
			if (words[0] === "help") continue;
			key = `cosmic_run ${scenarioKeyOf(words)}`;
			command = key;
		} else {
			const name = String(call.input.name ?? "");
			const env = (call.input.env ?? {}) as Record<string, unknown>;
			if (env.APPLY !== undefined && /"ok":true/.test(output.slice(0, 40))) {
				current.firstChangeAt ??= at;
				current.lastChangeAt = at;
			}
			const pairs = Object.keys(env)
				.sort()
				.map((name_) => `${name_}=${String(env[name_])}`);
			command = `cosmic_probe ${[basename(name), ...pairs].join(" ")}`;
			key = isAdHoc(name) ? `${command} #${String(probeWrites.get(basename(name)) ?? 0)}` : command;
		}
		const shown = current.errors.some((error) => errorShownIn(error, output));
		const before = current.sightings.length;
		current.sightings = noteSighting(current.sightings, { key, command, at, shown });
		if (shown && current.firstShownCall === null) current.firstShownCall = current.calls;
		if (shown || current.sightings.length !== before || current.sightings.some((entry) => entry.key === key)) {
			current.lines.push(`    ${at.slice(11, 19)}  ${shown ? "出现" : "没出现"}  ${command.slice(0, 110)}`);
		}
	}
}

const STATUS_TEXT = {
	fixed: "改前跑出来过，改后同一条命令不再出现",
	still: "改后同一条命令还在出现",
	unverified: "跑出来过，改后没用同一条命令再跑",
	never: "从没跑出来过",
} as const;

const tally = { fixed: 0, still: 0, unverified: 0, never: 0, unchanged: 0 };
let shownBeforeChange = 0;
let receiptsNotFixed = 0;
console.log(
	`会话 ${String(files.length)} 份，用户提问 ${String(prompts)} 句，其中贴了报错的 ${String(cases.length)} 句。\n`,
);
for (const entry of cases) {
	const reproduced = entry.sightings.some(
		(sighting) => entry.firstChangeAt === null || Date.parse(sighting.firstShownAt) < Date.parse(entry.firstChangeAt),
	);
	if (reproduced) shownBeforeChange += 1;
	let status: string;
	if (entry.lastChangeAt === null) {
		tally.unchanged += 1;
		status = "（没改）";
	} else {
		const verdict = reportedErrorStatus(entry.sightings, entry.lastChangeAt);
		tally[verdict.status] += 1;
		status = STATUS_TEXT[verdict.status];
		if (entry.receipt && verdict.status !== "fixed") receiptsNotFixed += 1;
	}
	console.log(`${entry.file}  ${entry.errors.map((error) => errorLabel(error, 70)).join(" ｜ ")}`);
	console.log(
		`  调用 ${String(entry.calls)} 次；第一句话之前 ${
			entry.firstWord === null
				? "（一直没说话）"
				: `${String(entry.firstWord.calls)} 次调用、${String(entry.firstWord.seconds)} 秒`
		}；改代码之前跑出原文：${reproduced ? `是（第 ${String(entry.firstShownCall)} 次调用）` : "否"}；结论：${status}；出回执：${entry.receipt ? "是" : "否"}`,
	);
	if (show) for (const line of entry.lines) console.log(line);
}
console.log(
	`\n合计 ${String(cases.length)} 句：改代码之前跑出原文的 ${String(shownBeforeChange)} 句。` +
		`结论——fixed ${String(tally.fixed)}，still ${String(tally.still)}，unverified ${String(tally.unverified)}，never ${String(tally.never)}，没改 ${String(tally.unchanged)}。` +
		`出了回执而结论不是 fixed 的 ${String(receiptsNotFixed)} 句。`,
);
