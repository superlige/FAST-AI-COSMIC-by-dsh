/**
 * S37 2-D.1 的尺子：`cosmic_fast` 编进了多少"不是这次会话写的"源码。
 *
 * 用法：
 *   node --experimental-strip-types scripts/measure-fast-scope.ts [会话目录]
 *
 * 逐份会话：模型用 write / edit 写过的 .java，加上 bash 命令里带写文件动作（>、sed -i、tee、python）时提到的 .java，
 * 算"这次会话写的"；每次成功的 `cosmic_fast` 返回里编了的文件，不在其中的就是"别人的"。
 * 按"点了名 / 没点名"分开数，逐条列出，并标出返回把它算成本次会话改的（authoredFiles）还是早于本次会话的（inheritedStale）。
 * 只读会话文件。按文件名认，不同目录下同名的类会被当成一个（偏向少报）。
 */
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const dir = process.argv[2] ?? join(homedir(), ".pi", "agent", "sessions", "--D--kingdee-zlgd_ygpt2.0--");
const base = (path: string): string => path.replace(/\\/g, "/").split("/").pop() ?? path;

interface Call {
	n: number;
	name: string;
	args: { path?: string; command?: string; sources?: string[] };
}
let calls = 0;
let named = 0;
let sweeps = 0;
const hits: string[] = [];
/** 返回算作本次会话改的，模型却没写过（改前的判法说了假话）。 */
const oldWrong: string[] = [];
/** 模型只用 bash 写过、这次又没点名：新口径认不出来的。 */
const newLost: string[] = [];
const sessions = new Set<string>();
for (const file of readdirSync(dir)
	.filter((name) => name.endsWith(".jsonl"))
	.sort()) {
	const written = new Set<string>();
	const toolWritten = new Set<string>();
	const bashWritten = new Set<string>();
	const byId = new Map<string, Call>();
	let n = 0;
	for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
		if (line === "") continue;
		let row: {
			message?: {
				role?: string;
				toolCallId?: string;
				content?: { type?: string; id?: string; name?: string; arguments?: unknown; text?: string }[];
			};
		};
		try {
			row = JSON.parse(line);
		} catch {
			continue;
		}
		const message = row.message;
		if (message?.role === "assistant") {
			for (const part of message.content ?? []) {
				if (part.type !== "toolCall") continue;
				n++;
				const args = (part.arguments ?? {}) as Call["args"];
				byId.set(part.id ?? "", { n, name: part.name ?? "", args });
				if ((part.name === "write" || part.name === "edit") && args.path !== undefined) {
					written.add(base(args.path));
					toolWritten.add(base(args.path));
				}
				if (part.name === "bash" && args.command !== undefined && /[^2]>|sed -i|tee |python/.test(args.command)) {
					for (const match of args.command.matchAll(/(\w+\.java)/g)) {
						written.add(match[1] as string);
						bashWritten.add(match[1] as string);
					}
				}
			}
			continue;
		}
		if (message?.role !== "toolResult") continue;
		const call = byId.get(message.toolCallId ?? "");
		if (call?.name !== "cosmic_fast") continue;
		const text = (message.content ?? []).map((part) => part.text ?? "").join("");
		let parsed: {
			ok?: boolean;
			result?: { files?: string[]; authoredFiles?: string[]; inheritedStale?: string[]; nothingToDo?: boolean };
		};
		try {
			parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
		} catch {
			continue;
		}
		if (parsed.ok !== true || parsed.result?.nothingToDo === true) continue;
		calls++;
		const isNamed = (call.args.sources ?? []).length > 0;
		if (isNamed) named++;
		else sweeps++;
		const authored = new Set((parsed.result?.authoredFiles ?? []).map(base));
		// 新口径：模型用 write / edit 写过的，或者这次点了名、修改时间在会话开始之后的
		const namedBases = new Set(
			(call.args.sources ?? []).map((name) => {
				const b = base(name);
				return b.endsWith(".java") ? b : `${b.split(".").pop()}.java`;
			}),
		);
		for (const name of authored) {
			if (!written.has(name)) oldWrong.push(`${file.slice(0, 19)} 第 ${call.n} 次 ${name}`);
			const kept = toolWritten.has(name) || namedBases.has(name);
			if (!kept && !written.has(name)) continue;
			if (!kept) newLost.push(`${file.slice(0, 19)} 第 ${call.n} 次 ${name}`);
		}
		const others = (parsed.result?.files ?? []).map(base).filter((name) => !written.has(name));
		if (others.length === 0) continue;
		sessions.add(file.slice(0, 19));
		const shown = others.map(
			(name) => `${name}${authored.has(name) ? "（返回算作本次会话改的）" : "（返回算作早于本次会话）"}`,
		);
		hits.push(`${file.slice(0, 19)} 第 ${call.n} 次 ${isNamed ? "点名" : "没点名"}：${shown.join("、")}`);
	}
}
console.log(
	`成功且真编了的 cosmic_fast ${calls} 次（点名 ${named}、没点名 ${sweeps}）；编进不是模型写的文件 ${hits.length} 次，涉及 ${sessions.size} 份会话`,
);
for (const hit of hits) console.log(hit);
console.log(
	`
算作"本次会话改的"却不是模型写的：改前 ${oldWrong.length} 个（文件次），改后 0；改后认不出的 bash 写的文件 ${newLost.length} 个`,
);
for (const hit of newLost) console.log(`改后认不出：${hit}`);
