/**
 * 知识库 search / api 带出本地参考文档的哪几块：拿真实会话里模型发过的查询量（S37 批 5 立，S45 批 3 改到段落索引）。
 *
 * 用法：node --experimental-strip-types scripts/measure-local-reference.ts <会话.jsonl 或目录>… [--json]
 *
 * 从会话记录里取出每一次 cosmic_knowledge 的 search / api 调用，用当前 knowledge/reference.pack 里的
 * 成员文档、过 runKnowledge（和工具同一个入口，官方库换成空的），逐条列出带出的块（`reference:篇名#标题`）。
 * 看两件事：该带出的带出来没有（例如查 canWithdraw 要带出 cosmic-workflow），不相干的篇有没有被一个常见词拉进来。
 * search 这里只有本地参与排序；和官方库排在一起的真实名次看 `measure-knowledge-retrieval.ts --cases`。
 * 另列 show 每次返回多少字节（整篇显示的输出限额按这个定）。
 * 只读会话记录和快照，不代表模型读了之后会怎么做。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { extractProse } from "../src/agent/tools/prose-blocks.ts";
import { UNAVAILABLE_REFLECTION } from "../src/kernel/api-tool.ts";
import { runKnowledge } from "../src/kernel/commands/knowledge.ts";
import { type KnowledgeDocsPort, openKnowledgeBase } from "../src/knowledge/docs.ts";
import { loadKnowledgeSnapshot } from "../src/knowledge/embedded.ts";
import { type LocalReferenceDoc, parseSkillFrontmatter } from "../src/knowledge/reference.ts";
import type { KnowledgeSourceStatus } from "../src/knowledge/source.ts";

const args = process.argv.slice(2);
const inputs = args.filter((arg) => !arg.startsWith("--"));
if (inputs.length === 0) {
	console.error("用法：measure-local-reference.ts <会话.jsonl 或目录>… [--json]");
	process.exit(2);
}

const snapshot = await loadKnowledgeSnapshot(join(import.meta.dirname, "..", "knowledge", "reference.pack"));
const docs: LocalReferenceDoc[] = [];
for (const path of snapshot.paths) {
	const text = snapshot.read(path);
	const front = text === null ? null : parseSkillFrontmatter(text);
	if (text === null || front === null) continue;
	docs.push({ name: front.name, description: front.description, file: path, text: text.toLowerCase(), source: text });
}

// 官方库换成空的：这把尺子只看本地参考文档
const ROOT = "C:/measure/empty-kb";
const EMPTY: KnowledgeDocsPort = {
	walkMarkdown: () => [],
	read: () => null,
	size: () => null,
	isFile: () => false,
	isDirectory: () => false,
	realPath: (path) => (path.replace(/\\/g, "/") === ROOT ? ROOT : null),
};
const FACTS = { root: ROOT, bundleVersion: "measure", snapshotId: "empty", docCount: 0 };
const STATUS: KnowledgeSourceStatus = {
	kind: "embedded",
	root: ROOT,
	inForce: FACTS,
	embedded: FACTS,
	overrideProblem: null,
};
const base = openKnowledgeBase(ROOT, EMPTY);

const encoder = new TextEncoder();

/**
 * api 回答里本地块在模型那边占多少字节：每个类的 local 数组（正文挪成文本块之后）加挪出来的文本块。
 * search 不算：它的结果整条都是本地块，大小看 measure-knowledge-retrieval 的回复字节。
 */
function apiLocalBytes(entries: readonly { local?: unknown[] }[]): number {
	const local = entries.map((entry) => entry.local ?? []);
	const prose = extractProse("cosmic_knowledge", { action: "api", entries: local.map((item) => ({ local: item })) });
	const moved = (prose.result as { entries: { local: unknown[] }[] }).entries.filter(
		(entry) => entry.local.length > 0,
	);
	return (
		(moved.length === 0 ? 0 : encoder.encode(JSON.stringify(moved.map((entry) => entry.local))).length) +
		prose.blocks.reduce((sum, block) => sum + encoder.encode(`# ${block.label}\n\n${block.text}`).length, 0)
	);
}

/** 这次查询带出的本地块（`篇名#标题`），以及 api 回答里它们占的字节。 */
async function localBlocks(action: "search" | "api", query: string): Promise<{ hits: string[]; bytes: number }> {
	const report = await runKnowledge(
		base,
		STATUS,
		{ action, query },
		EMPTY,
		UNAVAILABLE_REFLECTION,
		undefined,
		[],
		docs,
	);
	if (!report.ok) return { hits: [], bytes: 0 };
	const name = (show: string) => show.slice("reference:".length);
	if (report.value.action === "search") return { hits: report.value.results.map((hit) => name(hit.show)), bytes: 0 };
	if (report.value.action === "api")
		return {
			hits: report.value.entries.flatMap((entry) => (entry.local ?? []).map((passage) => name(passage.show))),
			bytes: apiLocalBytes(report.value.entries),
		};
	return { hits: [], bytes: 0 };
}

const files = inputs.flatMap((input) =>
	statSync(input).isDirectory()
		? readdirSync(input)
				.filter((name) => name.endsWith(".jsonl"))
				.map((name) => join(input, name))
		: [input],
);

interface Row {
	file: string;
	action: string;
	query: string;
	hits: string[];
	/** api：本地块在模型那边占的字节。 */
	bytes: number;
}
const rows: Row[] = [];
const showBytes: { query: string; bytes: number }[] = [];
for (const file of files) {
	const showCalls = new Map<string, string>();
	for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
		if (!line.includes('"cosmic_knowledge"')) continue;
		const entry = JSON.parse(line) as { message?: { role?: string; content?: unknown[]; toolCallId?: string } };
		if (entry.message?.role === "toolResult") {
			const query = showCalls.get(entry.message.toolCallId ?? "");
			const text = (entry.message.content as { text?: string }[]).map((part) => part.text ?? "").join("");
			if (query !== undefined) showBytes.push({ query, bytes: Buffer.byteLength(text) });
			continue;
		}
		if (entry.message?.role !== "assistant" || !Array.isArray(entry.message.content)) continue;
		for (const part of entry.message.content as {
			type?: string;
			id?: string;
			name?: string;
			arguments?: Record<string, unknown>;
		}[]) {
			if (part.type !== "toolCall" || part.name !== "cosmic_knowledge") continue;
			const action = String(part.arguments?.action ?? "");
			const query = String(part.arguments?.query ?? "");
			if (action === "show") showCalls.set(String(part.id), query);
			if ((action !== "search" && action !== "api") || query === "") continue;
			rows.push({ file, action, query, ...(await localBlocks(action, query)) });
		}
	}
}

const byDoc: Record<string, number> = {};
for (const row of rows)
	for (const name of new Set(row.hits.map((hit) => hit.split("#")[0] ?? hit))) byDoc[name] = (byDoc[name] ?? 0) + 1;
const summary = {
	sessions: files.length,
	docs: docs.length,
	queries: rows.length,
	withHits: rows.filter((row) => row.hits.length > 0).length,
	api: {
		calls: rows.filter((row) => row.action === "api").length,
		withHits: rows.filter((row) => row.action === "api" && row.hits.length > 0).length,
		localBytes: rows.reduce((sum, row) => sum + row.bytes, 0),
		largest: Math.max(0, ...rows.map((row) => row.bytes)),
	},
	byDoc,
	show: {
		calls: showBytes.length,
		bytes: showBytes.map((item) => item.bytes).sort((a, b) => a - b),
		largest: [...showBytes].sort((a, b) => b.bytes - a.bytes).slice(0, 5),
	},
};
if (args.includes("--json")) {
	console.log(JSON.stringify({ summary, rows }, null, 2));
} else {
	for (const row of rows) {
		const hits = row.hits.join("  ") || "—";
		console.log(`${row.action} ${row.query.slice(0, 90)}\n    → ${hits}`);
	}
	console.log(JSON.stringify(summary, null, 2));
}
