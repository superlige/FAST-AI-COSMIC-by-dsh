#!/usr/bin/env node

/**
 * Measures the API document parser over the whole embedded corpus (S7.2).
 *
 * Not a test: a scratch number nobody can reproduce is how the design doc ended up
 * with an 88-byte skill wrapper that is really 97. This prints what the parser
 * actually gets out of 1,528 documents, so the figures in IMPLEMENTATION.md and the
 * design doc are measured rather than estimated.
 *
 * Usage: node scripts/measure-api-doc.mjs [<knowledge-root>]
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isUninformativeDoc, parseApiDoc } from "../src/knowledge/api-doc.ts";

const DEFAULT_ROOT = "D:/claudecode/app-build/.locales/zh/knowledge/cosmic";

function walk(dir) {
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walk(full));
		else if (entry.isFile() && entry.name.endsWith(".md")) out.push(full);
	}
	return out;
}

const root = process.argv[2] ?? DEFAULT_ROOT;
const apiRoot = join(root, "platform", "api");
const files = walk(apiRoot);

let pages = 0;
let notApi = 0;
const notApiWhy = {};
let methods = 0;
let withDoc = 0;
let withChinese = 0;
let uninformative = 0;
let rawBlocks = 0;
let withParams = 0;
let namedParams = 0;
let totalParams = 0;
let withReturns = 0;
const unparsed = [];
const overloadKeys = new Map();
let duplicateKeys = 0;

for (const file of files) {
	const relative = file
		.slice(root.length + 1)
		.split("\\")
		.join("/");
	const text = readFileSync(file, "utf8");
	// The corpus's own count, so "how many did the parser lose" is answerable rather
	// than inferred. The first version of the parser lost 1,087 of these silently.
	rawBlocks += (text.match(/\*\*方法签名：\*\*/g) ?? []).length;
	const result = parseApiDoc(relative, text);
	if (result.doc === null) {
		notApi += 1;
		notApiWhy[result.why] = (notApiWhy[result.why] ?? 0) + 1;
		continue;
	}
	pages += 1;
	for (const line of result.unparsed) unparsed.push(`${relative}: ${line}`);
	const seen = new Set();
	for (const method of result.doc.methods) {
		methods += 1;
		if (method.doc !== "") withDoc += 1;
		if (/[一-鿿]/.test(method.doc)) withChinese += 1;
		if (isUninformativeDoc(method)) uninformative += 1;
		if (method.returns !== "") withReturns += 1;
		if (method.params.length > 0) withParams += 1;
		for (const param of method.params) {
			totalParams += 1;
			if (param.name !== "" && param.name !== "arg0") namedParams += 1;
		}
		const key = `${method.name}(${method.paramTypes.length})`;
		if (seen.has(key)) duplicateKeys += 1;
		seen.add(key);
		overloadKeys.set(method.name, (overloadKeys.get(method.name) ?? 0) + 1);
	}
}

const pct = (part, whole) => (whole === 0 ? "-" : `${((part / whole) * 100).toFixed(1)}%`);
console.log(`扫描 ${files.length} 个文件：API 页 ${pages}，非 API 页 ${notApi}`);
for (const [why, count] of Object.entries(notApiWhy)) console.log(`  非 API 页原因「${why}」：${count}`);
console.log(`方法 ${methods} 条（语料里的签名块 ${rawBlocks} 个，差额 ${rawBlocks - methods}）`);
// 有说明 vs 有中文说明 is not pedantry: the Commons-derived util classes carry English
// javadoc, and calling that "有中文注释" would inflate the figure the design doc quotes.
console.log(
	`  有说明 ${withDoc}（${pct(withDoc, methods)}），其中含中文 ${withChinese}（${pct(withChinese, methods)}）`,
);
console.log(`  说明等于没有（空 / (non-Javadoc) / 就是方法名本身）${uninformative} 条`);
console.log(`  有返回值说明 ${withReturns}（${pct(withReturns, methods)}）`);
console.log(
	`  有参数的 ${withParams} 条，参数 ${totalParams} 个，其中拿到真实参数名 ${namedParams}（${pct(namedParams, totalParams)}）`,
);
console.log(`  同类内同名同参数个数的重载 ${duplicateKeys} 处（靠参数类型区分，不能只按名字 join）`);
const busiest = [...overloadKeys.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
console.log(`  全库最多重载的方法名：${busiest.map(([name, n]) => `${name} ${n}`).join("，")}`);
if (unparsed.length > 0) {
	console.log(`[WARN] 解析不了的签名 ${unparsed.length} 条：`);
	for (const line of unparsed.slice(0, 20)) console.log(`  ${line}`);
} else {
	console.log("解析不了的签名 0 条");
}
// The official extraction report in the corpus claims 14720 methods / 83.4% 注释覆盖率.
// The documents on disk carry more blocks than that, so the report is not a check on
// this parser -- it is a separate count that no longer matches its own output.
console.log("注：官方提取报告自称 14720 方法 / 83.4% 注释覆盖率，与磁盘上的语料对不上，以本表为准");
