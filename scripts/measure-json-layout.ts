/**
 * S37 2-A.3 的尺子：探针写出的 JSON 分行前后，按行读它要付多少。
 *
 * 用法：
 *   node --experimental-strip-types scripts/measure-json-layout.ts <文件>… [--grep <关键字>]… [--pair <A> <B>]…
 *
 * - 每个文件：改前（原样）和改后（按 layoutJson 排）的字节、行数、最长一行（字符）、超过行宽的行数；
 * - 每个 `--grep`：在每个文件里按行找这个字（不分大小写，普通字符串），报命中几行、grep 拿回多少字节——
 *   改前文件只有一行，一命中就是整份文件；
 * - 每个 `--pair`：同一模板的两份导出，报逐行比的差异块数（改前、改后各一次）和按结构比的改动数，
 *   改后的差异块数应该和结构改动同一量级，而不是整份文件一个块。
 *
 * 只读文件，不连环境。
 */
import { readFileSync } from "node:fs";
import { JSON_LAYOUT_WIDTH, layoutJson } from "../src/kernel/json-layout.ts";
import { diffDesign, diffLines, isBigHunk } from "../src/kernel/meta/diff.ts";

const args = process.argv.slice(2);
const files: string[] = [];
const greps: string[] = [];
const pairs: [string, string][] = [];
for (let i = 0; i < args.length; i++) {
	const arg = args[i] as string;
	if (arg === "--grep") greps.push(args[++i] ?? "");
	else if (arg === "--pair") pairs.push([args[++i] ?? "", args[++i] ?? ""]);
	else files.push(arg);
}
if (files.length === 0 && pairs.length === 0) {
	console.error("用法：measure-json-layout.ts <文件>… [--grep <关键字>]… [--pair <A> <B>]…");
	process.exit(2);
}

const bytes = (text: string): number => Buffer.byteLength(text, "utf8");
const lines = (text: string): string[] => text.replace(/\n$/, "").split("\n");

function shape(text: string) {
	const rows = lines(text);
	return {
		bytes: bytes(text),
		lines: rows.length,
		maxLine: Math.max(...rows.map((row) => row.length)),
		overWidth: rows.filter((row) => row.length > JSON_LAYOUT_WIDTH).length,
	};
}

function grepCost(text: string, word: string) {
	const needle = word.toLowerCase();
	const hits = lines(text).filter((row) => row.toLowerCase().includes(needle));
	return { hits: hits.length, bytes: hits.reduce((sum, row) => sum + bytes(row) + 1, 0) };
}

function hunkCount(a: string, b: string): string {
	const hunks = diffLines(a, b, 8000);
	const big = hunks.find(isBigHunk);
	return big === undefined ? String(hunks.length) : `超出比对上限（-${big.removed} +${big.added} 行）`;
}

console.log(JSON.stringify({ kind: "ruler", version: "s37-layout-v1", width: JSON_LAYOUT_WIDTH }));
for (const file of files) {
	const before = readFileSync(file, "utf8");
	const after = layoutJson(before);
	const row: Record<string, unknown> = { file, before: shape(before), after: shape(after) };
	for (const word of greps) row[`grep ${word}`] = { before: grepCost(before, word), after: grepCost(after, word) };
	console.log(JSON.stringify(row));
}
for (const [a, b] of pairs) {
	const ta = readFileSync(a, "utf8");
	const tb = readFileSync(b, "utf8");
	console.log(
		JSON.stringify({
			pair: [a, b],
			structural: diffDesign(JSON.parse(ta), JSON.parse(tb)).length,
			hunksBefore: hunkCount(ta, tb),
			hunksAfter: hunkCount(layoutJson(ta), layoutJson(tb)),
		}),
	);
}
