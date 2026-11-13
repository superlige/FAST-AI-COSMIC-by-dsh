/**
 * 一条查询的答案为什么没排上来：答案篇排第几、哪一段得分最高、分是哪几个词给的，和排第一的那篇并排看。
 *
 * 跑法：node --experimental-strip-types scripts/explain-search-rank.ts --cases scripts/checklists/knowledge-recall.json --id r24
 *       node --experimental-strip-types scripts/explain-search-rank.ts --query "字段锁定 Lock 只读" --want reference:cosmic-metadata-form
 *
 * 口径：和 `search` 同一个段落索引、同一套打分（`explainPassageScore`）；不套 kind 过滤和场景草稿过滤，
 * 也不套"查询里点了工具名"的加权，所以排名可能和真实回复差一两位。看的是分从哪来，不是复量召回。
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { passageIndexFor } from "../src/kernel/commands/knowledge.ts";
import { nodeKnowledgeDocs, openKnowledgeBase } from "../src/knowledge/docs.ts";
import { loadKnowledgeSnapshot } from "../src/knowledge/embedded.ts";
import { explainPassageScore, type PassageScoreExplain, searchPassages } from "../src/knowledge/passages.ts";
import {
	type LocalReferenceDoc,
	parseSkillFrontmatter,
	readReleasedSkills,
	releaseReference,
} from "../src/knowledge/reference.ts";
import { releaseKnowledge } from "../src/knowledge/release.ts";
import { nodeKnowledgeFileSystem, resolveKnowledgeSource } from "../src/knowledge/source.ts";

const argValue = (name: string): string | undefined => {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
};
const argValues = (name: string): string[] =>
	process.argv.flatMap((arg, index) =>
		arg === name && process.argv[index + 1] ? [process.argv[index + 1] as string] : [],
	);

/** 评测集里的写法（`official:` / `reference:` 前缀）→ 索引里的 ref（官方不带前缀）。 */
const indexRef = (doc: string): string => (doc.startsWith("official:") ? doc.slice("official:".length) : doc);

let query = argValue("--query") ?? "";
let wants = argValues("--want").map(indexRef);
const casesFile = argValue("--cases");
const id = argValue("--id");
if (casesFile !== undefined && id !== undefined) {
	const parsed = JSON.parse(readFileSync(casesFile, "utf8")) as {
		cases: { id: string; query: string; answers: { doc: string }[] }[];
	};
	const item = parsed.cases.find((entry) => entry.id === id);
	if (item === undefined) throw new Error(`评测集里没有 ${id}`);
	query = item.query;
	wants = item.answers.map((answer) => indexRef(answer.doc));
}
if (query === "") {
	console.error("要 --query <查询> [--want <篇>…]，或 --cases <评测集> --id <编号>");
	process.exit(2);
}

const root = resolve(import.meta.dirname, "..");
const cacheRoot = mkdtempSync(join(tmpdir(), "cosmic-explain-"));
try {
	const snapshot = await loadKnowledgeSnapshot(join(root, "knowledge", "cosmic-kb.pack"));
	const released = await releaseKnowledge(cacheRoot, snapshot);
	const status = resolveKnowledgeSource(
		{
			configuredRoot: null,
			embedded: {
				root: released.layout.docsDir,
				bundleVersion: released.bundleVersion,
				snapshotId: released.snapshotId,
				docCount: released.docCount,
			},
		},
		nodeKnowledgeFileSystem,
	);
	const base = openKnowledgeBase(status.root, nodeKnowledgeDocs);
	const reference = await loadKnowledgeSnapshot(join(root, "knowledge", "reference.pack"));
	const releasedRef = await releaseReference(cacheRoot, reference);
	const local: LocalReferenceDoc[] = (await readReleasedSkills(releasedRef.layout, reference)).flatMap((entry) => {
		const front = parseSkillFrontmatter(entry.text);
		return front === null
			? []
			: [
					{
						name: front.name,
						description: front.description,
						file: entry.path,
						text: entry.text.toLowerCase(),
						source: entry.text,
					},
				];
	});
	const index = passageIndexFor(base, local);

	const { hits, absent, matchedDocs } = searchPassages(index, query, { limit: 100_000 });
	const refs = hits.map((hit) => hit.source.ref);
	console.log(`查询：${query}`);
	console.log(`命中 ${matchedDocs} 篇${absent.length > 0 ? `；资料里没有的词：${absent.join(" ")}` : ""}`);
	console.log("前 8 名：");
	for (const [rank, hit] of hits.slice(0, 8).entries()) {
		const mark = wants.includes(hit.source.ref) ? "★" : " ";
		console.log(
			`  ${mark}${String(rank + 1).padStart(2)}  ${hit.score.toFixed(2).padStart(6)}  ${hit.source.ref}  › ${hit.heading || "（开头）"}`,
		);
	}

	const show = (explain: PassageScoreExplain, rank: number): void => {
		console.log(
			`\n${explain.ref}：第 ${rank > 0 ? rank : "—（没命中）"} 名，${explain.score.toFixed(2)} 分，最高的段「${explain.heading || "（开头）"}」`,
		);
		for (const term of explain.terms.sort((a, b) => b.section + b.field - (a.section + a.field))) {
			const label = term.term.startsWith("~") ? `${term.term.slice(1)}（拆出来的部分）` : term.term;
			console.log(
				`    ${label.padEnd(22)} 权重 ${term.weight.toFixed(1)}  idf ${term.idf.toFixed(2)}（${term.sectionsWithTerm} 段有）  段里 ${term.section.toFixed(2)}  篇名/文件头 ${term.field.toFixed(2)}`,
			);
		}
	};
	const top = refs[0];
	if (top !== undefined && !wants.includes(top)) {
		const explain = explainPassageScore(index, query, top);
		if (explain !== null) show(explain, 1);
	}
	for (const want of wants) {
		const explain = explainPassageScore(index, query, want);
		if (explain === null) console.log(`\n${want}：索引里没有这一篇`);
		else show(explain, refs.indexOf(want) + 1);
	}
} finally {
	rmSync(cacheRoot, { recursive: true, force: true });
}
