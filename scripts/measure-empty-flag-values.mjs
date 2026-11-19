/**
 * 尺子：`cosmic_run` 的参数给了空值的有几次，工具当时怎么处理的。
 *
 *   node scripts/measure-empty-flag-values.mjs --dir <会话目录> [--from 日期] [--show]
 *   node scripts/measure-empty-flag-values.mjs <会话.jsonl…> [--show]
 *
 * 模型前一步没拿到要用的值（单据内码没查到、字段名没定下来），后一步常把参数照样写上、值留空：`--pk ""`、`--expect ""`。
 * 空值如果被当成「没写这个参数」，跑的就是另一件事（开已有单据变成新建一张空单、带断言变成不带断言），结果还照常返回。
 * 这把尺子数：带值参数后面跟着空值（空串或全是空白，含 `--x=` 写法）的调用有几次、是哪些参数，
 * 其中被拒的几次、照常跑了的几次（照常跑了的就是「跑了另一件事」）。
 *
 * 只读会话文件。`--show` 逐次列出。
 */
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

const argv = process.argv.slice(2);
const one = (name) => {
	const at = argv.indexOf(name);
	return at < 0 ? undefined : argv[at + 1];
};
const dir = one("--dir");
const from = one("--from");
const files =
	dir === undefined
		? argv.filter((arg) => arg.endsWith(".jsonl"))
		: readdirSync(dir)
				.filter((name) => name.endsWith(".jsonl") && (from === undefined || name.slice(0, 10) >= from))
				.sort()
				.map((name) => join(dir, name));
if (files.length === 0) {
	console.error("用法：measure-empty-flag-values.mjs --dir <会话目录> [--from 日期] [--show] | <会话.jsonl…>");
	process.exit(2);
}

/** 自己就是值、后面不跟值的参数。 */
const BOOL = new Set(["--events", "--summary", "--schedule", "--raw", "--apply", "--help"]);

function emptyFlags(words) {
	const hits = [];
	for (let i = 0; i < words.length; i++) {
		const word = words[i];
		if (typeof word !== "string" || !word.startsWith("--")) continue;
		const eq = word.indexOf("=");
		if (eq > 0) {
			if (word.slice(eq + 1).trim() === "") hits.push(word.slice(0, eq));
			continue;
		}
		if (BOOL.has(word)) continue;
		if (word === "--case") continue;
		const value = words[i + 1];
		if (typeof value === "string" && value.trim() === "") hits.push(word);
		i += 1;
	}
	return hits;
}

let calls = 0;
const rows = [];
for (const file of files) {
	const pending = new Map();
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (line === "") continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		const message = entry.message;
		if (message === undefined) continue;
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const part of message.content) {
				if (part.type !== "toolCall" || part.name !== "cosmic_run") continue;
				const input = part.arguments ?? part.input ?? {};
				if (!Array.isArray(input.argv)) continue;
				calls += 1;
				const hits = emptyFlags(input.argv);
				if (hits.length > 0) pending.set(part.id, { file: basename(file).slice(0, 19), words: input.argv, hits });
			}
		}
		if (message.role === "toolResult" && pending.has(message.toolCallId)) {
			const row = pending.get(message.toolCallId);
			pending.delete(message.toolCallId);
			const text = (message.content ?? []).map((part) => part.text ?? "").join("");
			// 被拒：参数没过检查，没有起探针。照常跑了：探针真的跑了（不管断言过没过）。
			row.refused = /INVALID_ARGS|"code":"[A-Z_]*INVALID|PRECHECK_FAILED/.test(text) && !/"probe":"/.test(text);
			rows.push(row);
		}
	}
}

const byFlag = {};
for (const row of rows) for (const flag of row.hits) byFlag[flag] = (byFlag[flag] ?? 0) + 1;
const ran = rows.filter((row) => !row.refused);
console.log(`会话 ${String(files.length)} 份，cosmic_run ${String(calls)} 次`);
console.log(
	`参数给了空值的 ${String(rows.length)} 次：被拒 ${String(rows.length - ran.length)} 次，照常跑了 ${String(ran.length)} 次`,
);
console.log(
	`按参数：${
		Object.entries(byFlag)
			.sort((a, b) => b[1] - a[1])
			.map(([flag, count]) => `${flag} ${String(count)}`)
			.join("、") || "—"
	}`,
);
if (argv.includes("--show")) {
	for (const row of rows) {
		console.log(
			`  ${row.file} ${row.refused ? "被拒" : "照常跑了"}　${row.words
				.map((word) => (word === "" ? '""' : word))
				.join(" ")
				.slice(0, 150)}`,
		);
	}
}
