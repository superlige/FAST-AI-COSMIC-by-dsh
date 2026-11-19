/**
 * 读会话记录：pi 的 `.jsonl` 和 dsh 的 `session.v4.jsonl.zstd` 都读，dsh 的换成 pi 的记录形状交出去。
 *
 * 测量脚本（`analyze-session.mjs`、`measure-round-purpose.mjs`、`measure-prompt-cache.mjs`、`measure-delivery.mjs`）
 * 原来只认 pi 的格式；它们的口径都按 pi 记录写，所以这里把 dsh 的事件换成同样的形状，脚本本身的算法不动，
 * pi 版和 dsh 版的会话用同一把尺子量。
 *
 * 换法（dsh 事件 → pi 记录）：
 *   session              → { type: "session", id, timestamp, cwd }
 *   request/header       → { type: "model_change", provider, modelId }（模型变了才出一条）
 *   system/message       → message role=system
 *   user/message         → 人说的（source.kind=user）是 message role=user；宿主插进来的上下文是
 *                          { type: "custom_message", customType: "dsh:<kind>" }，和 pi 里扩展插的消息一个形状
 *   assistant/message    → message role=assistant；`tool-call` 块换成 `toolCall`（arguments 解析成对象），
 *                          `reasoning` 换成 `thinking`；用量 inputTokens/outputTokens/cacheReadTokens/cacheWriteTokens
 *                          换成 input/output/cacheRead/cacheWrite；provider/model/api/stopReason 从 source 里取
 *   tool/result          → message role=toolResult，toolName 按 callId 从前面的 tool/call 找回
 *   内置工具名和参数     → pi 的（pwsh→bash、file_path→path、apply_patch→edit、grep/glob→bash 命令、skill→读 SKILL.md、
 *                          ask_user_question→ask_question），见 `piToolCall`
 *   compaction/summary   → { type: "compaction" }
 * 其余事件（步骤起止、待办、审批、标题……）测量用不上，不交出去。
 *
 * dsh 的会话目录：`~/.dsh/sessions/<工程标识>/<会话 id>/session.v4.jsonl.zstd`；脚本可以直接给这个文件，
 * 也可以给 `<会话 id>` 目录。
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

const DSH_FILES = ["session.v4.jsonl.zstd", "session.jsonl.zstd"];

/** 给的是 dsh 的会话目录就换成里面的会话文件；否则原样返回。 */
export function resolveSessionFile(path) {
	if (existsSync(path) && statSync(path).isDirectory()) {
		for (const name of DSH_FILES) {
			const file = join(path, name);
			if (existsSync(file)) return file;
		}
	}
	return path;
}

/** 文件名像不像一份会话（pi 的 `.jsonl`，dsh 的 `.jsonl.zstd`）。 */
export function isSessionFile(name) {
	return name.endsWith(".jsonl") || name.endsWith(".jsonl.zstd");
}

/**
 * 一个目录下的会话文件，按名字排序：pi 的目录里直接是 `.jsonl`；dsh 的工程目录里是一个会话一个子目录。
 * 返回 `{ name, file }`：`name` 用来按日期筛（pi 是文件名开头的时间戳，dsh 是会话文件的修改时间）。
 */
export function listSessionFiles(dir) {
	const out = [];
	for (const entry of readdirSync(dir).sort()) {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) {
			const file = resolveSessionFile(path);
			if (file !== path) out.push({ name: `${statSync(file).mtime.toISOString()}_${entry}`, file });
		} else if (entry.endsWith(".jsonl")) {
			out.push({ name: entry, file: path });
		}
	}
	return out;
}

/** 会话文件的原文（dsh 的先解压）。 */
export function readSessionText(file) {
	const path = resolveSessionFile(file);
	const bytes = readFileSync(path);
	return path.endsWith(".zstd") ? zstdDecompressSync(bytes).toString("utf8") : bytes.toString("utf8");
}

function iso(ms) {
	return typeof ms === "number" ? new Date(ms).toISOString() : undefined;
}

/** apply_patch 补丁里动到的路径（和 src/dsh/hooks.ts 的 patchPaths 同一个认法）。 */
function patchPaths(patch) {
	const paths = [];
	for (const line of String(patch ?? "").split(/\r?\n/)) {
		const match = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/.exec(line.trim());
		if (match) paths.push(match[1].trim());
	}
	return paths;
}

/**
 * dsh 的内置工具换成 pi 的名字和参数形状，脚本里按 pi 工具名分的类（读文件、终端、改文件、问用户、读技能）照样分得对。
 * 原来的名字留在 `dshName` 上。产品工具（cosmic_*）两边同名同参数，不换。
 */
export function piToolCall(name, args) {
	const input = typeof args === "object" && args !== null ? args : {};
	const withPath = (extra = {}) => ({
		...input,
		...(input.file_path === undefined ? {} : { path: input.file_path }),
		...extra,
	});
	switch (name) {
		case "pwsh":
			return { name: "bash", arguments: input };
		case "read":
		case "write":
		case "edit":
			return { name, arguments: withPath() };
		case "apply_patch": {
			const paths = patchPaths(input.input);
			return { name: "edit", arguments: { ...input, path: paths[0] ?? "", paths } };
		}
		case "grep":
			return {
				name: "bash",
				arguments: { ...input, command: `grep -rn ${input.pattern ?? ""} ${input.path ?? "."}` },
			};
		case "glob":
			return {
				name: "bash",
				arguments: { ...input, command: `find ${input.path ?? "."} -name ${input.pattern ?? ""}` },
			};
		case "skill":
			return {
				name: "read",
				arguments: {
					...input,
					path: `.fast-ai-cosmic/cache/reference/families/${input.name ?? input.skill ?? ""}/SKILL.md`,
				},
			};
		case "ask_user_question":
			return { name: "ask_question", arguments: input };
		default:
			return { name, arguments: input };
	}
}

function piContent(content) {
	if (typeof content === "string") return [{ type: "text", text: content }];
	if (!Array.isArray(content)) return [];
	return content.map((block) => {
		if (block?.type === "tool-call") {
			let args = block.arguments;
			if (typeof args === "string") {
				try {
					args = JSON.parse(args);
				} catch {
					// 解析不了就原样留着字符串，和 pi 记录里坏掉的参数一样处理
				}
			}
			const call = piToolCall(block.name, args ?? {});
			return { type: "toolCall", id: block.id, name: call.name, arguments: call.arguments, dshName: block.name };
		}
		if (block?.type === "reasoning") return { type: "thinking", thinking: block.text ?? "" };
		return block;
	});
}

function piUsage(usage) {
	if (usage === undefined || usage === null) return undefined;
	return {
		input: usage.inputTokens ?? 0,
		output: usage.outputTokens ?? 0,
		cacheRead: usage.cacheReadTokens ?? 0,
		cacheWrite: usage.cacheWriteTokens ?? 0,
		reasoning: usage.reasoningTokens ?? 0,
		totalTokens: usage.totalTokens ?? 0,
	};
}

/** dsh 的一份会话（已解析的事件）换成 pi 的记录。 */
export function dshToPiRecords(events) {
	const records = [];
	const toolNames = new Map();
	let model = null;
	const message = (event, body) =>
		records.push({ type: "message", id: body.id ?? String(event.seq), timestamp: iso(event.time), message: body });
	for (const event of events) {
		const data = event.data ?? {};
		switch (event.type) {
			case "session":
				records.push({ type: "session", id: event.id, timestamp: iso(event.createdAt), cwd: event.cwd });
				break;
			case "request/header": {
				const config = data.header?.config ?? {};
				const next = `${config.provider}/${config.model}`;
				if (config.model !== undefined && next !== model) {
					model = next;
					records.push({
						type: "model_change",
						timestamp: iso(event.time),
						provider: config.provider,
						modelId: config.model,
					});
				}
				break;
			}
			case "system/message":
				message(event, { role: "system", content: piContent(data.message?.content), timestamp: event.time });
				break;
			case "user/message": {
				const kind = data.source?.kind ?? "user";
				if (kind === "user") {
					message(event, { role: "user", content: piContent(data.content), timestamp: event.time });
				} else {
					// 宿主插进来的上下文（工作区说明、运行时状态、技能清单）：进上下文，但不是人说的话，
					// 当成 user 会把一轮当中途「用户又说话了」，计时和轮次边界全错
					records.push({
						type: "custom_message",
						customType: `dsh:${kind}`,
						content: piContent(data.content),
						timestamp: iso(event.time),
					});
				}
				break;
			}
			case "tool/call":
				if (data.callId !== undefined) toolNames.set(data.callId, piToolCall(data.name, {}).name);
				break;
			case "assistant/message": {
				const body = data.message ?? {};
				const source = body.source ?? {};
				const response = source.replayState?.response ?? {};
				for (const block of Array.isArray(body.content) ? body.content : [])
					if (block?.type === "tool-call") toolNames.set(block.id, piToolCall(block.name, {}).name);
				message(event, {
					role: "assistant",
					content: piContent(body.content),
					api: response.api,
					provider: source.provider ?? response.provider,
					model: source.model ?? response.model,
					usage: piUsage(data.usage),
					stopReason: response.stopReason,
					timestamp: event.time,
				});
				break;
			}
			case "tool/result": {
				const body = data.message ?? {};
				const callId = body.toolCallId ?? body.source?.callId;
				message(event, {
					role: "toolResult",
					toolCallId: callId,
					toolName: toolNames.get(callId) ?? "",
					content: piContent(body.content),
					isError: body.isError === true,
					...(body.details === undefined ? {} : { details: body.details }),
					timestamp: event.time,
				});
				break;
			}
			case "compaction/summary":
				records.push({ type: "compaction", timestamp: iso(event.time) });
				break;
			default:
				break;
		}
	}
	return records;
}

/**
 * 读一份会话，交出 pi 形状的记录。`broken` 是解析不了的行数（文件被截断、写到一半）。
 * `format` 说读的是哪一种，脚本报数时一并报出来。
 */
export function readSessionRecords(file) {
	const path = resolveSessionFile(file);
	const lines = readSessionText(path).split(/\r?\n/);
	const parsed = [];
	let broken = 0;
	for (const line of lines) {
		if (line.trim() === "") continue;
		try {
			parsed.push(JSON.parse(line));
		} catch {
			broken += 1;
		}
	}
	const dsh = path.endsWith(".zstd");
	return { records: dsh ? dshToPiRecords(parsed) : parsed, broken, format: dsh ? "dsh" : "pi" };
}
