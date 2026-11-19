import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { answerableCases, EVAL_CASES } from "../../src/eval/corpus.ts";
import { injectionAccount, pluginBaseApiCoverage, runKnowledgeEval } from "../../src/eval/knowledge-eval.ts";
import type { ReflectionPort } from "../../src/kernel/api-tool.ts";
import { knowledgeScenes } from "../../src/kernel/commands/knowledge.ts";
import { PLUGIN_ROUTES, SCENE_PREFIX, sceneItems } from "../../src/knowledge/catalog.ts";
import { openKnowledgePack } from "../../src/knowledge/pack.ts";
import type { KnowledgeSourceStatus } from "../../src/knowledge/source.ts";
import { snapshotKnowledgeBase } from "../fixtures/snapshot-base.ts";

const snapshot = openKnowledgePack(
	readFileSync(fileURLToPath(new URL("../../knowledge/cosmic-kb.pack", import.meta.url))),
);
const base = snapshotKnowledgeBase(snapshot);
const status: KnowledgeSourceStatus = {
	kind: "embedded",
	root: base.root,
	inForce: {
		bundleVersion: snapshot.header.bundleVersion,
		snapshotId: snapshot.header.snapshotId,
		docCount: snapshot.header.files.length,
	},
	embedded: {
		bundleVersion: snapshot.header.bundleVersion,
		snapshotId: snapshot.header.snapshotId,
		docCount: snapshot.header.files.length,
	},
	overrideProblem: null,
};

/** No JARs in a unit test, which is the state the version-drift group is about. */
const offline: ReflectionPort = { sig: async () => null, batch: async () => null, find: async () => null };

describe("S7.5 评测语料", () => {
	it("每个标注的场景篇名都真在当前快照的场景表里", async () => {
		const known = new Set(
			sceneItems(base, false).map((item) =>
				item.relativePath.startsWith(SCENE_PREFIX)
					? item.relativePath.slice(SCENE_PREFIX.length)
					: item.relativePath,
			),
		);
		// A drifted target scores zero and looks like a retrieval regression, which
		// is the one failure this batch must never produce: the eval would then be
		// reporting on itself.
		const missing = answerableCases().filter((entry) => !known.has(entry.scene as string));
		expect(missing.map((entry) => `${entry.id} -> ${String(entry.scene)}`)).toEqual([]);
	});

	it("兜底题引的指南都在路由表里，且那两族确实一条场景都没有", async () => {
		// gap-family only: a version-drift case may also name a guide, and it is
		// not a fallback -- it is asking about a class, not about a scene.
		const fallbacks = EVAL_CASES.filter(
			(entry) => entry.kind === "gap-family" && entry.scene === null && entry.guide !== null,
		);
		expect(fallbacks.length).toBeGreaterThanOrEqual(2);
		const guides = new Set(PLUGIN_ROUTES.map((route) => route.guide));
		for (const entry of fallbacks) expect(guides, `${entry.id} 的指南不在路由表里`).toContain(entry.guide);
		// The claim under test is structural, not a wording judgement: the families
		// these questions belong to are tagged `pluginType: null`, so no facet exists
		// that could narrow the table towards them.
		const untagged = PLUGIN_ROUTES.filter((route) => route.pluginType === null).map((route) => route.guide);
		for (const entry of fallbacks) expect(untagged).toContain(entry.guide);
	});

	it("id 不重复", async () => {
		const ids = EVAL_CASES.map((entry) => entry.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("低置信题在场景表里确实没有答案", async () => {
		for (const entry of EVAL_CASES.filter((item) => item.kind === "low-confidence")) {
			expect(entry.scene, `${entry.id} 标了答案就不再是低置信题`).toBeNull();
			expect(entry.guide).toBeNull();
		}
	});
});

describe("S7.5 两条通道，同一批提问", async () => {
	const report = await runKnowledgeEval({ base, status, reflect: offline });

	it("历史 9 题整表读零回退", async () => {
		expect(report.historyTable).toEqual({ found: 9, total: 9 });
	});

	it("整表读在同一批上不低于字面检索", async () => {
		expect(report.tableRecall).toBeGreaterThanOrEqual(report.searchRecall);
		// The gap is the premise of the whole L2 split. If it ever closes, the
		// design decision should be revisited rather than the assertion relaxed.
		expect(report.searchRecall).toBeLessThan(report.answerable);
	});

	it("没有一题静默落空", async () => {
		// A miss that arrives with no next step is indistinguishable from "the
		// knowledge base has nothing" -- defect D-3's shape, one layer down.
		expect(report.silentMisses).toEqual([]);
	});

	it("有答案的题没有被路由送错通道", async () => {
		expect(report.misrouted).toEqual([]);
	});

	it("缺口族靠整表读仍然找得到，虽然没有任何过滤条件可用", async () => {
		const gap = report.byKind.find((tally) => tally.kind === "gap-family");
		expect(gap?.tableFound).toBe(gap?.answerable);
		// And it costs: with no facet, the answer is the whole table.
		const withoutFacet = report.cases.filter((outcome) => outcome.case.pluginType === null);
		const withFacet = report.cases.filter((outcome) => outcome.case.pluginType !== null);
		expect(Math.min(...withoutFacet.map((outcome) => outcome.table.bytes))).toBeGreaterThan(
			Math.max(...withFacet.map((outcome) => outcome.table.bytes)),
		);
	});

	it("检索得分不是置信度：没答案的题得分与命中的题同量级", async () => {
		// Recorded as an assertion because the tempting fix -- "return search's top
		// hit when the score is high enough" -- is refuted by this number, and the
		// refutation should fail loudly if it ever stops being true.
		const highest = Math.max(...report.lowConfidenceScores.map((entry) => entry.topScore));
		expect(highest).toBeGreaterThan(0);
		expect(highest).toBeGreaterThanOrEqual(report.medianHitScore / 2);
	});
});

describe("S7.5 版本漂移", async () => {
	const report = await runKnowledgeEval({ base, status, reflect: offline });

	it("没有 JAR 时，文档一律自报「没跟 JAR 对过」", async () => {
		expect(report.drift.length).toBeGreaterThan(0);
		for (const outcome of report.drift) {
			expect(outcome.statesUncheckedOrJoined, `${outcome.case.id} 把文档当成已验证的了`).toBe(true);
			expect(outcome.report.entries[0]?.reflectionUnavailable).not.toBeNull();
			expect(outcome.statesVersion).toBe(true);
		}
	});

	it("快照里没有的类报「没有」，不拿相近的一篇顶上", async () => {
		const unknown = report.drift.find((outcome) => outcome.case.id === "drift-unknown-class");
		expect(unknown?.documented).toBe(false);
		expect(unknown?.report.entries[0]?.relativePath).toBeNull();
		expect(unknown?.report.entries[0]?.methods).toEqual([]);
	});

	it("查插件基类时带出该族入口，即使这个类没有 API 正文", async () => {
		const pluginBase = report.drift.find((outcome) => outcome.case.id === "drift-plugin-base");
		expect(pluginBase?.pluginHint).toBe(true);
		expect(pluginBase?.documented).toBe(false);
	});

	it("插件基类的 API 正文覆盖是被记下来的缺口，不是被当成没有缺口", async () => {
		const coverage = pluginBaseApiCoverage(base);
		expect(coverage.total).toBe(PLUGIN_ROUTES.length);
		expect(coverage.documented).toBeLessThan(coverage.total);
		expect(coverage.missing).toContain("AbstractFormPlugin");
	});
});

describe("S7.5 注入侧账目", () => {
	it("按族过滤的场景表比整表小，缺口族只能拿整表", async () => {
		const account = injectionAccount({
			base,
			status,
			residentL0: 6039,
			residentSkills: 10865,
			families: ["billform", "printplugin"],
		});
		for (const table of account.tables) {
			expect(table.bytes).toBeLessThan(account.untaggedTable);
			expect(table.coverage).toBeLessThan(1);
		}
		// The compaction cost is the largest table anyone could be holding.
		expect(account.compactionReread).toBe(account.untaggedTable);
	});

	it("按模型真正收到的字节计价，不按内核报告的 JSON", async () => {
		// 这一条锁的是口径本身。账目自称「模型收到的字节」，而模型收到的是过了
		// trimKnowledgeEnvelope 和 extractProse 的东西：解包路径没了，整表成了一个
		// 文本块，每个换行是一个字符而不是两个。按内核报告的 JSON 算会把整表高估四成
		// （33 125 对 23 736），而这两个数看起来一样合理——所以差距要有断言守着。
		const account = injectionAccount({ base, status, residentL0: 0, residentSkills: 0, families: [] });
		const report = knowledgeScenes(base, status, {});
		const kernelJsonBytes = new TextEncoder().encode(JSON.stringify({ action: "scenes", ...report })).length;
		expect(account.untaggedTable).toBeLessThan(kernelJsonBytes * 0.8);
		// 但它仍然是整张表的价钱，不是指针的价钱：文本块必须一起算进去。
		expect(account.untaggedTable).toBeGreaterThan(kernelJsonBytes * 0.5);
	});
});
