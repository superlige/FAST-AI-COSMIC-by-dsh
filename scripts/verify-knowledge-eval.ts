#!/usr/bin/env node --experimental-strip-types
/**
 * S7.5 acceptance: the retrieval eval and the injection-side budget, both on the
 * real embedded snapshot, both with nothing configured.
 *
 * Needs no credentials and no Cosmic runtime -- deliberately. Retrieval is a pure
 * function of the snapshot, and the whole point of D13 is that the snapshot ships
 * with the product, so this measurement is available on any machine at any time.
 * The one thing it cannot see is reflection: with no JARs, `api` has no signature
 * to join against, which is exactly the state the version-drift group is written
 * to check ("say you did not check, do not print the document as verified").
 *
 * Fixed steps, never a command string (D1).
 *
 * Usage: node --experimental-strip-types scripts/verify-knowledge-eval.ts [pack-file]
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { measureL0Budget } from "../src/agent/prompt/system-prompt.ts";
import { EVAL_CASES } from "../src/eval/corpus.ts";
import { injectionAccount, runKnowledgeEval } from "../src/eval/knowledge-eval.ts";
import type { ReflectionPort } from "../src/kernel/api-tool.ts";
import { SCENE_QUESTION_RECALL } from "../src/kernel/commands/knowledge.ts";
import { nodeKnowledgeDocs, openKnowledgeBase } from "../src/knowledge/docs.ts";
import { loadKnowledgeSnapshot } from "../src/knowledge/embedded.ts";
import {
	estimateInjectionBudget,
	parseSkillFrontmatter,
	readReleasedSkills,
	referenceSkillPaths,
	releaseReference,
	writeFamilyIndexes,
} from "../src/knowledge/reference.ts";
import { releaseKnowledge } from "../src/knowledge/release.ts";
import { nodeKnowledgeFileSystem, resolveKnowledgeSource } from "../src/knowledge/source.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";
import { releasedProbeInputNames, releasedProbeNames } from "../src/runtime/resources.ts";

const packFile = resolve(
	process.argv[2] ?? new URL("../knowledge/cosmic-kb.pack", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
);

const failures: string[] = [];

function check(label: string, ok: boolean, detail = ""): void {
	console.log(`  ${ok ? "OK  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
	if (!ok) failures.push(label);
}

/** No JARs here, and the report has to say so rather than quietly go doc-only. */
const offlineReflection: ReflectionPort = { sig: async () => null, batch: async () => null, find: async () => null };

const cacheRoot = mkdtempSync(join(tmpdir(), "cosmic-eval-"));
try {
	const snapshot = await loadKnowledgeSnapshot(packFile);
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
	console.log(
		`快照 ${snapshot.header.snapshotId.slice(0, 12)}，app-build ${snapshot.header.bundleVersion}，${snapshot.header.files.length} 篇`,
	);

	// ---- 1. the batch ----
	console.log(`\n[1/4] 检索评测（${EVAL_CASES.length} 题，整表读 vs 字面检索，同一批；字节同为模型侧口径）`);
	const report = await runKnowledgeEval({ base, status, reflect: offlineReflection });
	for (const tally of report.byKind) {
		const detail =
			tally.answerable === 0
				? `${tally.total} 题，无场景答案`
				: `整表读 ${tally.tableFound}/${tally.answerable}，检索@3 ${tally.searchFound}/${tally.answerable}`;
		console.log(
			`  ${tally.kind.padEnd(15)} ${detail}，中位字节 表 ${tally.medianTableBytes} / 检索 ${tally.medianSearchBytes}` +
				`，中位耗时 表 ${tally.medianTableMs} ms / 检索 ${tally.medianSearchMs} ms`,
		);
	}
	console.log(
		`  合计：整表读 ${report.tableRecall}/${report.answerable}，检索@3 ${report.searchRecall}/${report.answerable}，` +
			`兜底 ${report.fallbacks} 题（只有指南能答），耗时 ${report.totalMs} ms`,
	);
	for (const outcome of report.cases) {
		if (outcome.case.scene === null || outcome.table.found) continue;
		console.log(`  未命中（整表读）：${outcome.case.id} —— ${outcome.case.query} → ${outcome.case.scene}`);
	}

	check(
		"历史 9 题整表读零回退",
		report.historyTable.found === report.historyTable.total,
		`${report.historyTable.found}/${report.historyTable.total}`,
	);
	check(
		"整表读在全批上不低于字面检索",
		report.tableRecall >= report.searchRecall,
		`${report.tableRecall} ≥ ${report.searchRecall}`,
	);
	// 改道提示里写着这两个数，模型照它决定走哪条路：和这次实测对不上就是在说假话
	check(
		"改道提示里的召回数和本次实测一致（SCENE_QUESTION_RECALL）",
		SCENE_QUESTION_RECALL.search === report.searchRecall &&
			SCENE_QUESTION_RECALL.table === report.tableRecall &&
			SCENE_QUESTION_RECALL.total === report.answerable,
		`写的是 ${SCENE_QUESTION_RECALL.search}/${SCENE_QUESTION_RECALL.table}/${SCENE_QUESTION_RECALL.total}，` +
			`实测 ${report.searchRecall}/${report.tableRecall}/${report.answerable}`,
	);
	check("没有静默落空（每题都给了下一步）", report.silentMisses.length === 0, report.silentMisses.join("、"));
	check("路由没有把有答案的题送错通道", report.misrouted.length === 0, report.misrouted.join("、"));

	// Recorded, not gated: a threshold on a confidence proxy would be a threshold
	// on noise. The comparison is what says whether score means anything.
	console.log(
		`  低置信组检索最高分：${report.lowConfidenceScores.map((entry) => `${entry.id}=${entry.topScore}`).join("  ")}` +
			`；有答案组命中分中位 ${report.medianHitScore}`,
	);

	// ---- 2. version drift ----
	console.log("\n[2/4] 版本漂移");
	for (const outcome of report.drift) {
		console.log(
			`  ${outcome.case.id}：有文档 ${outcome.documented ? "是" : "否"}，报版本 ${outcome.statesVersion ? "是" : "否"}，` +
				`自报未对过 JAR ${outcome.statesUncheckedOrJoined ? "是" : "否"}，插件入口 ${outcome.pluginHint ? "有" : "无"}`,
		);
	}
	check(
		"每个类的回答都自报快照版本",
		report.drift.every((outcome) => outcome.statesVersion),
	);
	check(
		"没有 JAR 时一律自报「没对过」，不把文档当已验证",
		report.drift.every((outcome) => outcome.statesUncheckedOrJoined),
	);
	const unknown = report.drift.find((outcome) => outcome.case.id === "drift-unknown-class");
	check("快照里没有的类要报「没有」，不拿相近的一篇顶上", unknown !== undefined && !unknown.documented);
	const pluginBase = report.drift.find((outcome) => outcome.case.id === "drift-plugin-base");
	check("查插件基类时带出该族官方入口（L1 第三个插入点）", pluginBase?.pluginHint === true);
	// Recorded, not gated: this is the official snapshot's coverage, not ours.
	console.log(
		`  插件基类的 API 正文覆盖 ${report.pluginBaseApi.documented}/${report.pluginBaseApi.total}，` +
			`没有正文的：${report.pluginBaseApi.missing.join(" ")}`,
	);

	// ---- 3. L0 budget ----
	console.log("\n[3/4] L0 常驻预算");
	const probes = releasedProbeNames(EMBEDDED_RESOURCES);
	const budget = measureL0Budget(probes, releasedProbeInputNames(EMBEDDED_RESOURCES));
	console.log(
		`  最坏情形 ${budget.bytes} 字节 / 上限 ${budget.limit}（已发布探针 ${budget.worst.probes} 个，${budget.worst.knowledge}）`,
	);
	for (const part of budget.parts) console.log(`    ${part.name}：${part.bytes}`);
	check(`cosmic 追加到系统提示 ≤ ${budget.limit} 字节`, !budget.over, `余量 ${budget.headroom}`);

	// ---- 4. injection account ----
	// 字节口径是「模型侧」：过 trimKnowledgeEnvelope 与 extractProse 之后的 envelope
	// 加上各文本块，也就是这份报告真正占掉的上下文。按内核报告的 JSON 算会把整表高估
	// 四成（33 125 对 23 736），因为那份里还留着解包路径、重复的绝对路径，以及被写成
	// 两个字符的每一个换行。
	console.log("\n[4/4] 注入侧账目（字节 = 模型侧：裁剪后的 envelope + 文本块）");
	const reference = await loadKnowledgeSnapshot(join(dirname(packFile), "reference.pack"));
	const releasedRef = await releaseReference(cacheRoot, reference);
	const onDisk = await readReleasedSkills(releasedRef.layout, reference);
	// 交给 dsh 的是族索引，不是原文：原文按需读，常驻的只有族索引那几行（和 kernel-adapter 的 skills() 同一算法）。
	const documents = onDisk.flatMap((entry) => {
		const front = parseSkillFrontmatter(entry.text);
		return front === null
			? []
			: [{ dir: entry.path.slice(0, entry.path.lastIndexOf("/")), description: front.description }];
	});
	const indexes = await writeFamilyIndexes(releasedRef.layout, documents);
	const skills = indexes.entries.map((entry) => parseSkillFrontmatter(entry.text)).filter((front) => front !== null);
	const skillBudget = estimateInjectionBudget(skills, referenceSkillPaths(releasedRef.layout)[0] as string);

	const account = injectionAccount({
		base,
		status,
		residentL0: budget.bytes,
		residentSkills: skillBudget.bytes,
		families: ["billform", "listform", "printplugin", "reportlist", "customapi"],
	});
	console.log(
		`  常驻：L0 ${account.residentL0} + skill 清单 ${account.residentSkills} = ${account.residentL0 + account.residentSkills} 字节（稳定前缀，被缓存）`,
	);
	for (const table of account.tables) {
		console.log(
			`    场景表 --plugin-type ${String(table.pluginType).padEnd(12)} ${String(table.rows).padStart(3)} 行  ${table.bytes} 字节  覆盖 ${(table.coverage * 100).toFixed(0)}%`,
		);
	}
	console.log(`    场景表 无过滤（缺口族只能拿这张）      ${account.untaggedTable} 字节`);
	console.log(
		`  一次 compaction 之后最多要重读 ${account.compactionReread} 字节；Capsule digest 在 .cosmic-ai/work/ 留审计记录，会话按 digest 去重，不会重走旧六步流程`,
	);
} catch (error) {
	failures.push(`验证过程抛错：${error instanceof Error ? error.message : String(error)}`);
} finally {
	rmSync(cacheRoot, { recursive: true, force: true });
}

if (failures.length > 0) {
	console.error(`\n[FAIL] S7.5 评测与预算未通过：\n  ${failures.join("\n  ")}`);
	process.exit(1);
}
console.log("\n[PASS] 检索评测、版本漂移、L0 预算与注入侧账目全部通过");
