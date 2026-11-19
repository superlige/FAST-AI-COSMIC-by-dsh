#!/usr/bin/env node

/**
 * S62 的尺子：历史会话里 `cosmic_run list` 选的、点的行在不在那次列表查出来的首屏里。
 *
 * 用法：
 *   node scripts/measure-list-select.mjs --dir <会话目录> [--from 日期] [--show]
 *   node scripts/measure-list-select.mjs <会话.jsonl…> [--show]
 *
 * 报：`run list` 一共几次；带 --select / --row-click / --row-double-click / --hyperlink 的几次；
 * 其中主键不在首屏的几次，这些里照样往下跑了的几次（带按钮或操作的单列，那是真提交）、被退回的几次；
 * 带 --main-org 的几次，其中最终过滤里看不到所给组织的几次（参数没起作用）。
 * 首屏的行从返回里的「row[i] pk=…」读；返回里的行数比「首屏 rows=N」少（中段被裁、发过的行被折）时
 * 改读验证记录里记的那份完整日志。读不到首屏、日志也不在了的记成「看不出」。只读历史会话，不连环境。
 */

import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

const argv = process.argv.slice(2);
const one = (name) => {
	const at = argv.indexOf(name);
	return at < 0 ? undefined : argv[at + 1];
};
const show = argv.includes("--show");
const dir = one("--dir");
const from = one("--from");
const files = dir
	? readdirSync(dir)
			.filter((name) => name.endsWith(".jsonl") && (!from || name.slice(0, 10) >= from))
			.map((name) => join(dir, name))
	: argv.filter((arg) => arg.endsWith(".jsonl"));
if (files.length === 0) {
	console.error("用法：node scripts/measure-list-select.mjs --dir <会话目录> [--from 日期] [--show] | <会话.jsonl…>");
	process.exit(2);
}

const PICKS = ["--select", "--row-click", "--row-double-click", "--hyperlink"];
const total = {
	sessions: files.length,
	listCalls: 0,
	withPick: 0,
	unknown: 0,
	outside: 0,
	outsideRan: 0,
	outsideRanCommitted: 0,
	outsideRejected: 0,
	withMainOrg: 0,
	mainOrgIgnored: 0,
};
const lines = [];

for (const file of files) {
	const calls = new Map();
	for (const raw of readFileSync(file, "utf8").split("\n")) {
		if (!raw) continue;
		let entry;
		try {
			entry = JSON.parse(raw);
		} catch {
			continue;
		}
		const message = entry.message;
		if (!message || !Array.isArray(message.content)) continue;
		if (message.role === "assistant") {
			for (const part of message.content) {
				const args = part.type === "toolCall" && part.name === "cosmic_run" ? part.arguments?.argv : undefined;
				if (Array.isArray(args) && args[0] === "list") calls.set(part.id, { argv: args.map(String), done: false });
			}
			continue;
		}
		const call = message.role === "toolResult" ? calls.get(message.toolCallId) : undefined;
		if (!call || call.done) continue;
		call.done = true;
		const text = message.content.map((part) => part.text ?? "").join("\n");
		total.listCalls++;
		const value = (flag) => {
			const at = call.argv.indexOf(flag);
			return at < 0 ? undefined : (call.argv[at + 1] ?? "");
		};
		const where = `${basename(file).slice(0, 24)} ${call.argv.join(" ").slice(0, 220)}`;

		const mainOrg = value("--main-org");
		if (mainOrg !== undefined) {
			total.withMainOrg++;
			const filters = text.slice(text.indexOf("最终过滤"));
			const seen = mainOrg.split(",").every((id) => id.trim() && filters.includes(id.trim()));
			if (text.includes("最终过滤") && !seen) {
				total.mainOrgIgnored++;
				lines.push(`主组织没起作用  ${where}`);
			}
		}

		const picked = PICKS.flatMap((flag) => {
			const given = value(flag);
			if (given === undefined) return [];
			const pks = flag === "--hyperlink" ? [given.split(":")[0]] : given.split(",");
			return pks.map((pk) => pk.trim()).filter(Boolean);
		});
		if (picked.length === 0) continue;
		total.withPick++;
		const declared = /首屏 rows=(\d+)/.exec(text);
		if (!declared) {
			total.unknown++;
			continue;
		}
		const rejected = text.includes("输入不成立") || text.includes("不在当前首屏");
		const rowsIn = (source) => new Set([...source.matchAll(/row\[\d+\] pk=(\S+)/g)].map((match) => match[1]));
		let rows = rowsIn(text);
		// 返回里的首屏可能被裁了中段、折了发过的行：行数对不上就读落盘的完整日志；
		// 读不到的记「看不出」，不能把看不见的行算成不在首屏。工具自己退回的那次照它说的算。
		if (rows.size < Number(declared[1]) && !rejected) {
			// 完整日志的路径：会话记录里存的整份结果（details）里有；早先的会话模型收到的文本里也有一份。
			const kept = message.details?.result;
			const inText = /"log":"((?:[^"\\]|\\.)+)"/.exec(text);
			const logFile =
				kept?.evidence?.filed?.find((record) => typeof record?.log === "string")?.log ??
				kept?.outputFile ??
				(inText ? JSON.parse(`"${inText[1]}"`) : null);
			let full = null;
			try {
				full = typeof logFile === "string" ? readFileSync(logFile, "utf8") : null;
			} catch {
				full = null;
			}
			if (full === null) {
				total.unknown++;
				continue;
			}
			rows = rowsIn(full);
		}
		const missing = picked.filter((pk) => !rows.has(pk));
		if (missing.length === 0) continue;
		total.outside++;
		const committed = call.argv.includes("--click") || call.argv.includes("--op");
		if (rejected) total.outsideRejected++;
		else {
			total.outsideRan++;
			if (committed) total.outsideRanCommitted++;
		}
		lines.push(
			`不在首屏 ${String(missing.length)}/${String(picked.length)}  首屏 ${String(rows.size)} 行  ` +
				`${rejected ? "被退回" : committed ? "照样跑了（真提交）" : "照样跑了"}  ${where}`,
		);
	}
}

console.log(JSON.stringify(total, null, 2));
if (show) for (const line of lines) console.log(line);
