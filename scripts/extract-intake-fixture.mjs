/**
 * 从一份真实会话里提取 cosmic 工具返回的文字，生成 S34 批 1.8 的回放夹具。
 *
 * 用法：
 *
 *   node scripts/extract-intake-fixture.mjs <会话.jsonl> test/fixtures/intake-replay.json
 *
 * 只读会话记录，只取 `cosmic_` 前缀工具的 toolResult 文字块，按发送顺序存成
 * `[{ tool, parts: [文字, …] }]`。夹具入库后，回放测试不再依赖本机的会话目录；
 * 换基线会话时重跑本脚本并连同新夹具一起提交，前后必须用同一份夹具比较。
 */

import { readFileSync, writeFileSync } from "node:fs";

const [sessionFile, outFile] = process.argv.slice(2);
if (sessionFile === undefined || outFile === undefined) {
	console.error("用法：node scripts/extract-intake-fixture.mjs <会话.jsonl> <输出.json>");
	process.exit(1);
}

const results = [];
for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
	if (line.trim() === "") continue;
	let entry;
	try {
		entry = JSON.parse(line);
	} catch {
		continue;
	}
	const message = entry?.message;
	if (entry?.type !== "message" || message?.role !== "toolResult") continue;
	const tool = message.toolName ?? "";
	if (!tool.startsWith("cosmic_")) continue;
	const parts = (message.content ?? []).filter((part) => part.type === "text").map((part) => part.text);
	if (parts.length === 0) continue;
	results.push({ tool, parts });
}

writeFileSync(outFile, `${JSON.stringify({ source: sessionFile, results }, null, 2)}\n`, "utf8");
const textBytes = results.reduce(
	(sum, result) => sum + result.parts.reduce((n, text) => n + Buffer.byteLength(text, "utf8"), 0),
	0,
);
console.log(`提取 ${results.length} 条 cosmic 返回，共 ${String(textBytes)} 字节 → ${outFile}`);
