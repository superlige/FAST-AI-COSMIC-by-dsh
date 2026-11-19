/**
 * 尺子：一份会话里每一步各花多久——模型想了多久、工具跑了多久，几份会话并排比。
 *
 *   node scripts/measure-session-steps.mjs <会话.jsonl…> [--json]
 *
 * 用在「同一份提示词前后各跑一遍」的对照上：固定步骤的复测提示词（每步只调一次工具）跑出来的两份会话，
 * 第 N 次调用就是同一件事，直接并排看工具用时。逐次列出：工具名、参数里认得出的那几个字（探针名、run 的前三个词）、
 * 工具用时（pi 记的那次调用的时长）、这次调用之前模型用了多久（上一个结果回来到这次调用发出）。
 * 末尾给合计：整场多久、模型多久、工具多久、几轮几次调用。
 *
 * 只读会话文件。两份会话的步骤对不上（模型换了做法、某步失败后改了参数）时，并排的数不能直接比，要看参数那一列。
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const argv = process.argv.slice(2);
const files = argv.filter((arg) => !arg.startsWith("--"));
if (files.length === 0) {
	console.error("用法：measure-session-steps.mjs <会话.jsonl…> [--json]");
	process.exit(2);
}

function brief(name, input) {
	if (input === null || typeof input !== "object") return "";
	const probe = typeof input.probe === "string" ? input.probe : typeof input.name === "string" ? input.name : null;
	if (probe !== null) {
		const env = input.env && typeof input.env === "object" ? Object.keys(input.env).join(",") : "";
		return `${probe}${env === "" ? "" : `（${env}）`}`;
	}
	if (Array.isArray(input.argv)) return input.argv.slice(0, 3).join(" ");
	if (typeof input.action === "string") return input.action;
	if (typeof input.path === "string") return basename(input.path);
	if (typeof input.command === "string") return input.command.slice(0, 40);
	return name === "" ? "" : Object.keys(input).slice(0, 3).join(",");
}

function read(file) {
	const entries = readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			try {
				return JSON.parse(line);
			} catch {
				return null;
			}
		})
		.filter((entry) => entry !== null && entry.message !== undefined);
	const calls = new Map();
	const steps = [];
	let rounds = 0;
	let first = null;
	let last = null;
	let previousEnd = null;
	for (const entry of entries) {
		const message = entry.message;
		const at = message.timestamp ?? Date.parse(entry.timestamp);
		if (Number.isFinite(at)) {
			first ??= at;
			last = at;
		}
		if (message.role === "user") previousEnd = at;
		if (message.role === "assistant") {
			const parts = Array.isArray(message.content) ? message.content : [];
			const toolCalls = parts.filter((part) => part.type === "toolCall");
			if (toolCalls.length > 0) rounds += 1;
			for (const part of toolCalls) {
				calls.set(part.id, {
					name: part.name,
					input: part.arguments ?? part.input,
					issuedAt: at,
				});
			}
		}
		if (message.role === "toolResult") {
			const call = calls.get(message.toolCallId);
			const durationMs = message.durationMs ?? (call ? at - call.issuedAt : 0);
			steps.push({
				tool: message.toolName ?? call?.name ?? "?",
				what: brief(message.toolName ?? "", call?.input),
				toolMs: durationMs,
				// 这次调用开始的时刻 = 结果回来的时刻 − 工具用时；从上一个结果回来到这时，是模型在想、在写
				modelMs: previousEnd === null ? null : Math.max(0, at - durationMs - previousEnd),
				failed: message.isError === true,
			});
			previousEnd = at;
		}
	}
	const toolMs = steps.reduce((sum, step) => sum + step.toolMs, 0);
	const totalMs = first === null || last === null ? 0 : last - first;
	return { file: basename(file).slice(0, 19), steps, rounds, totalMs, toolMs, modelMs: Math.max(0, totalMs - toolMs) };
}

const sessions = files.map(read);
if (argv.includes("--json")) {
	console.log(JSON.stringify(sessions, null, 2));
	process.exit(0);
}
const sec = (ms) => (ms === null || ms === undefined ? "    —" : (ms / 1000).toFixed(1).padStart(5));
for (const session of sessions) {
	console.log(
		`${session.file}　整场 ${sec(session.totalMs).trim()} 秒 ＝ 模型 ${sec(session.modelMs).trim()} ＋ 工具 ${sec(session.toolMs).trim()}　${String(session.rounds)} 轮 ${String(session.steps.length)} 次调用`,
	);
	session.steps.forEach((step, index) => {
		console.log(
			`  ${String(index + 1).padStart(2)}. 模型 ${sec(step.modelMs)} 秒　工具 ${sec(step.toolMs)} 秒　${step.tool}　${step.what}${step.failed ? "　（失败）" : ""}`,
		);
	});
}
