/**
 * S45 批 3：按类名查（`api`）时，附上本地参考文档里讲到这个类的块。
 *
 * 用当前参考快照。守的是：本地写得最多的类（`QFilter`、`DynamicObject`）照样回来，不因为"太常见"被丢掉；
 * 回的是讲到它的那一块和 `show` 写法，不是篇名；按方法查时排第一的那块正文直接带；
 * 类名只拆出来的部分（`Filter`）不算提到。
 *
 * 工作流那几个类来自 2026-09-27 需求 1 复测：模型为"撤销是单据操作还是工作流撤回"在 52 轮思考里打转，
 * 本地 cosmic-workflow 把 canWithdraw 实测写全了，当时查不出来。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractProse } from "../../src/agent/tools/prose-blocks.ts";
import { UNAVAILABLE_REFLECTION } from "../../src/kernel/api-tool.ts";
import { knowledgeApi, knowledgeShow } from "../../src/kernel/commands/knowledge.ts";
import { type KnowledgeDocsPort, openKnowledgeBase } from "../../src/knowledge/docs.ts";
import { openKnowledgePack } from "../../src/knowledge/pack.ts";
import { type LocalReferenceDoc, parseSkillFrontmatter } from "../../src/knowledge/reference.ts";
import type { KnowledgeSourceStatus } from "../../src/knowledge/source.ts";

const snapshot = openKnowledgePack(
	new Uint8Array(readFileSync(fileURLToPath(new URL("../../knowledge/reference.pack", import.meta.url)))),
);
const LOCAL: LocalReferenceDoc[] = snapshot.paths.flatMap((path) => {
	const text = snapshot.read(path);
	const front = text === null ? null : parseSkillFrontmatter(text);
	return text === null || front === null
		? []
		: [{ name: front.name, description: front.description, file: path, text: text.toLowerCase(), source: text }];
});

const ROOT = "C:/cache/kb-api-local/cosmic";
const EMPTY: KnowledgeDocsPort = {
	walkMarkdown: () => [],
	read: () => null,
	size: () => null,
	isFile: () => false,
	isDirectory: () => false,
	realPath: (path) => (path.replace(/\\/g, "/") === ROOT ? ROOT : null),
};
const FACTS = { root: ROOT, bundleVersion: "test", snapshotId: "api-local", docCount: 0 };
const STATUS: KnowledgeSourceStatus = {
	kind: "embedded",
	root: ROOT,
	inForce: FACTS,
	embedded: FACTS,
	overrideProblem: null,
};
const kb = openKnowledgeBase(ROOT, EMPTY);

async function entriesOf(query: string) {
	const result = await knowledgeApi(kb, STATUS, query, UNAVAILABLE_REFLECTION, LOCAL);
	if (!result.ok) throw new Error(result.error.message);
	return result.value.entries;
}

describe("api attaches the local blocks that talk about the class", () => {
	it("brings back the class the local docs write about most, which a 'too common to count' floor used to drop", async () => {
		const [qfilter, dynamicObject] = await entriesOf(
			"kd.bos.orm.query.QFilter kd.bos.dataentity.entity.DynamicObject",
		);
		expect(qfilter?.local?.map((passage) => passage.show.split("#")[0])).toContain("reference:cosmic-data-query");
		expect(dynamicObject?.local?.length).toBeGreaterThan(0);
	});

	it("gives each block's place and a show argument that fetches it, with the lines that mention the class", async () => {
		const [entry] = await entriesOf("kd.bos.orm.query.QFilter");
		const passage = entry?.local?.[0];
		expect(passage?.text).toBeUndefined();
		expect(passage?.matched?.join("\n")).toContain("QFilter");
		const shown = knowledgeShow(kb, STATUS, passage?.show ?? "", EMPTY, LOCAL);
		expect(shown.ok && shown.value.content).toContain("QFilter");
	});

	it("inlines the first block when a method is asked for: that is when it is about to be called", async () => {
		const [entry] = await entriesOf("kd.bos.servicehelper.workflow.WorkflowServiceHelper#canWithdraw");
		const [first] = entry?.local ?? [];
		expect(first?.show.split("#")[0]).toBe("reference:cosmic-workflow");
		expect(first?.text).toContain("canWithdraw");
		// 正文挪成文本块，标签是它的 show 写法
		const prose = extractProse("cosmic_knowledge", { action: "api", entries: [entry] });
		expect(prose.blocks.map((block) => block.label)).toContain(first?.show);
	});

	it("leaves the field off a class no local document names", async () => {
		const [algo] = await entriesOf("kd.bos.algo.Algo");
		expect(algo?.local).toBeUndefined();
	});

	it("answers without local blocks when the reference pack is not there", async () => {
		const result = await knowledgeApi(kb, STATUS, "kd.bos.orm.query.QFilter", UNAVAILABLE_REFLECTION, []);
		expect(result.ok && result.value.entries[0]?.local).toBeUndefined();
	});
});
