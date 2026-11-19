/**
 * 真机会话里模型查过哪些平台知识：把每次 `cosmic_knowledge` 调用、读技能文档 / 官方知识缓存、
 * 自己反编译平台类的命令按时间顺序抽出来，给知识召回评测集（S45 批 0）当原料。
 *
 * 跑法：node --experimental-strip-types scripts/knowledge-queries-from-sessions.ts
 *         [--dir <会话目录>] [--from 2026-09-15] [--json]
 *
 * 口径：
 * - 日期按会话文件名的 UTC 日期，首尾都算（和 analyze:session 一致）。
 * - 「查询」= cosmic_knowledge 的 search / api / findclass / scenes / show / plugin / anchors；
 *   probes / status / routes / audit 是工具用法，不算平台知识查询，单独计数。
 * - 「之后读了什么」= 同一会话里这次查询之后、下一次查询之前，模型 read 的技能文档或知识缓存文档；
 *   人工标答案时拿它当线索，不当答案。
 * - 「反编译」= bash 命令里出现 javap / cfr / procyon / jd-cli（资料里没有，只好看 JAR）。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const argValue = (name: string): string | undefined => {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
};

const dir = argValue("--dir") ?? "C:/Users/Lige/.pi/agent/sessions/--D--kingdee-zlgd_ygpt2.0--";
const from = argValue("--from") ?? "0000-00-00";
const to = argValue("--to") ?? "9999-99-99";

const PLATFORM_ACTIONS = new Set(["search", "api", "findclass", "scenes", "show", "plugin", "anchors"]);
const DECOMPILE = /\b(javap|cfr|procyon|jd-cli)\b/i;

interface Event {
	session: string;
	at: string;
	kind: "query" | "tool-usage" | "read" | "decompile";
	action?: string;
	query?: string;
	path?: string;
	command?: string;
}

/** 技能文档、官方知识缓存的路径，统一成 `reference:<篇名>` / `official:<相对路径>`，跨缓存版本可比。 */
function knowledgeTarget(path: string): string | null {
	const normal = path.replace(/\\/g, "/");
	const skill = /\/cache\/reference\/[^/]+\/(?:skills|families)\/([^/]+)\/SKILL\.md$/i.exec(normal);
	if (skill) return `reference:${skill[1]}`;
	const official = /\/cache\/knowledge\/[^/]+\/docs\/(.+)$/i.exec(normal);
	if (official) return `official:${official[1]}`;
	return null;
}

const files = readdirSync(dir)
	.filter((name) => name.endsWith(".jsonl"))
	.filter((name) => {
		const day = name.slice(0, 10);
		return day >= from && day <= to;
	})
	.sort();

const events: Event[] = [];
for (const name of files) {
	const session = name.slice(0, 19);
	for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
		if (!line.includes('"toolCall"')) continue;
		let entry: { timestamp?: string; message?: { role?: string; content?: unknown } };
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry.message?.role !== "assistant" || !Array.isArray(entry.message.content)) continue;
		for (const block of entry.message.content as Array<Record<string, unknown>>) {
			if (block.type !== "toolCall") continue;
			const args = (block.arguments ?? {}) as Record<string, unknown>;
			const at = entry.timestamp ?? "";
			if (block.name === "cosmic_knowledge") {
				const action = String(args.action ?? "");
				const query = [args.query, args.path, args.base].find((value) => typeof value === "string") as
					| string
					| undefined;
				events.push({
					session,
					at,
					kind: PLATFORM_ACTIONS.has(action) ? "query" : "tool-usage",
					action,
					...(query === undefined ? {} : { query }),
				});
			} else if (block.name === "read" && typeof args.path === "string") {
				const target = knowledgeTarget(args.path);
				if (target !== null) events.push({ session, at, kind: "read", path: target });
			} else if (block.name === "bash" && typeof args.command === "string" && DECOMPILE.test(args.command)) {
				events.push({ session, at, kind: "decompile", command: args.command.slice(0, 200) });
			}
		}
	}
}

// 每次查询之后、下一次查询之前读的知识文档
const queries = events
	.map((event, index) => ({ event, index }))
	.filter(({ event }) => event.kind === "query")
	.map(({ event, index }) => {
		const after: string[] = [];
		for (let next = index + 1; next < events.length; next++) {
			const later = events[next] as Event;
			if (later.session !== event.session || later.kind === "query") break;
			if (later.kind === "read" && later.path !== undefined && !after.includes(later.path)) after.push(later.path);
		}
		return { session: event.session, action: event.action, query: event.query ?? "", readAfter: after };
	});

const count = (kind: Event["kind"]) => events.filter((event) => event.kind === kind).length;
const byAction: Record<string, number> = {};
for (const event of events) {
	if (event.kind === "query" || event.kind === "tool-usage") {
		byAction[event.action ?? ""] = (byAction[event.action ?? ""] ?? 0) + 1;
	}
}

if (process.argv.includes("--json")) {
	console.log(
		JSON.stringify(
			{
				sessions: files.length,
				byAction,
				reads: count("read"),
				decompiles: events.filter((event) => event.kind === "decompile"),
				queries,
			},
			null,
			2,
		),
	);
} else {
	console.log(`会话 ${files.length} 份；读技能/知识文档 ${count("read")} 次；反编译 ${count("decompile")} 次`);
	console.log(
		`按动作：${Object.entries(byAction)
			.sort((a, b) => b[1] - a[1])
			.map(([action, n]) => `${action} ${n}`)
			.join("、")}`,
	);
	for (const item of queries) {
		console.log(
			`${item.session}  ${String(item.action).padEnd(9)} ${item.query}${item.readAfter.length > 0 ? `   → 读 ${item.readAfter.join(", ")}` : ""}`,
		);
	}
}
