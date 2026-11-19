/**
 * 尺子：模型找"谁在读写这个字段""这个类的签名是什么""平台内部怎么做的"时，走的是工具还是自己翻（S72）。
 *
 * 用法：
 *   node scripts/measure-lookup-detours.mjs <会话.jsonl…> [--show]
 *   node scripts/measure-lookup-detours.mjs --dir <会话目录> [--from 2026-10-01] [--to 2026-10-15] [--show]
 *
 * 只读历史会话。每份会话、以及合计，分三组数：
 *   查读写处  cosmic_impact 几次；bash 里 grep / findstr / rg 工程源码几次（命令里带 src 或 .java）。
 *   查签名    cosmic_knowledge action=api、action=findclass 几次；bash 里 javap / unzip 翻平台 JAR 几次，
 *             拆成"看字节码"（javap -c）、"找类在哪个 jar"（unzip -l、逐个 jar 循环）、"看签名"（其余 javap），
 *             看签名里再数带 -p / -private / -constants 的（要看非 public 成员或常量值，api 给不了）。
 *   翻平台内部 bash 里翻苍穹服务器目录（static-file-service 前端脚本等）几次；读 cosmic 自己发布的探针源码几次
 *             （缓存目录下 resources/probes/ 或 resources/runtime/，read 和 bash 都算）。
 * --show 把每条归进"看字节码""看签名""找类""翻平台内部""读探针源码"的命令原样列出来，给人复核分类。
 *
 * 口径：按命令文字分，一条 bash 命令只归一类（先看 javap/unzip，再看 cosmic 缓存，再看服务器目录，再看 grep）。
 * 分类是按规则猜的：grep 里也有查别的东西的，javap 里也有查自己工程类的，数出来是线索，前后对照要用同一版本的脚本、同一批会话。
 * 基线和口径见 docs/S72-route-and-signature-lookup.md §2。
 */

import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

const argv = process.argv.slice(2);
const opt = (name) => {
	const at = argv.indexOf(name);
	return at < 0 ? undefined : argv[at + 1];
};
const show = argv.includes("--show");
const dir = opt("--dir");
const from = opt("--from");
const to = opt("--to");
const valued = new Set(["--dir", "--from", "--to"]);
let files = argv.filter((arg, i) => !arg.startsWith("--") && !valued.has(argv[i - 1] ?? ""));
if (dir !== undefined) {
	files = readdirSync(dir)
		.filter((name) => name.endsWith(".jsonl"))
		.filter(
			(name) => (from === undefined || name.slice(0, 10) >= from) && (to === undefined || name.slice(0, 10) <= to),
		)
		.sort()
		.map((name) => join(dir, name));
}
if (files.length === 0) {
	console.error(
		"用法：measure-lookup-detours.mjs <会话.jsonl…> | --dir <会话目录> [--from 日期] [--to 日期] [--show]",
	);
	process.exit(2);
}

const KEYS = [
	"impact",
	"grep源码",
	"api",
	"findclass",
	"javap看字节码",
	"javap找类",
	"javap看签名",
	"其中要非public或常量",
	"翻平台内部",
	"读探针源码",
];

/** One bash command into at most one bucket; null when it is none of these. */
function bashBucket(command) {
	if (/\bjavap\b|unzip -[lp]|\bjar tf\b/.test(command)) {
		if (/\bjavap\b[^;&|]*\s-c(?:\s|$)/.test(command)) return "javap看字节码";
		if (/unzip -l|jar tf|for j in/.test(command)) return "javap找类";
		return "javap看签名";
	}
	if (/fast-ai-cosmic/.test(command)) return /resources[\\/](?:probes|runtime)/.test(command) ? "读探针源码" : null;
	if (/static-file-service|cosmic-server[\\/](?!mservice-cosmic[\\/]lib)/.test(command)) return "翻平台内部";
	if (/\b(?:grep|findstr|rg)\b/.test(command) && /src|\.java/.test(command)) return "grep源码";
	return null;
}

function bucketOf(call) {
	const args = call.arguments ?? {};
	if (call.name === "cosmic_impact") return "impact";
	if (call.name === "cosmic_knowledge") {
		if (args.action === "api") return "api";
		if (args.action === "findclass") return "findclass";
		return null;
	}
	if (call.name === "read") {
		const path = String(args.path ?? "");
		return /fast-ai-cosmic/.test(path) && /resources[\\/](?:probes|runtime)/.test(path) ? "读探针源码" : null;
	}
	if (call.name === "bash") return bashBucket(String(args.command ?? ""));
	return null;
}

const total = Object.fromEntries(KEYS.map((key) => [key, 0]));
const shown = [];
console.log(["会话", ...KEYS].join("\t"));
for (const file of files) {
	const counts = Object.fromEntries(KEYS.map((key) => [key, 0]));
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (line === "") continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		for (const part of entry.message.content ?? []) {
			if (part.type !== "toolCall") continue;
			const bucket = bucketOf(part);
			if (bucket === null) continue;
			counts[bucket] += 1;
			total[bucket] += 1;
			// api 只列本类声明的 public 方法：要看 protected/private（-p、-private）或常量值（-constants）的，它给不了。
			const command = String(part.arguments?.command ?? "");
			if (bucket === "javap看签名" && /\s-(?:p|private|constants)(?:\s|$)/.test(command)) {
				counts.其中要非public或常量 += 1;
				total.其中要非public或常量 += 1;
			}
			if (show && !["impact", "api", "findclass", "grep源码"].includes(bucket)) {
				const text = part.name === "read" ? part.arguments?.path : part.arguments?.command;
				shown.push(`${basename(file).slice(0, 19)}  ${bucket}  ${String(text).replace(/\s+/g, " ").slice(0, 200)}`);
			}
		}
	}
	console.log([basename(file).slice(0, 19), ...KEYS.map((key) => counts[key])].join("\t"));
}
console.log(["合计", ...KEYS.map((key) => total[key])].join("\t"));
console.log(`${files.length} 份会话`);
if (show) for (const row of shown) console.log(row);
