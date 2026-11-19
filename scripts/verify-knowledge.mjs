#!/usr/bin/env node

/**
 * S7.0 acceptance: on a machine with no app-build, no COSMIC_KNOWLEDGE_ROOT and
 * an empty cache, the official knowledge base is still there and readable.
 *
 * This is the check that proves D13 actually landed. Everything else in S7.0 is
 * machinery; the user-visible promise is "the product ships its own knowledge
 * base", and that promise is only kept if the whole chain -- sidecar found,
 * pack opened, snapshot released, source resolved to embedded, entry documents
 * readable from disk by absolute path -- works with nothing configured.
 *
 * The cache goes to a fresh temp directory each run so a warm cache from a
 * previous run can never make a broken release look fine.
 *
 * Usage: node scripts/verify-knowledge.mjs [pack-file]
 *   default pack: knowledge/cosmic-kb.pack (dev)
 *   release check: node scripts/verify-knowledge.mjs dist/spike/cosmic-kb.pack
 */

import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { loadKnowledgeSnapshot } from "../src/knowledge/embedded.ts";
import {
	checkSkillEntries,
	estimateInjectionBudget,
	parseSkillFrontmatter,
	readReleasedSkills,
	referenceSkillPaths,
	releaseReference,
	writeFamilyIndexes,
} from "../src/knowledge/reference.ts";
import { releaseKnowledge, verifyKnowledgeRelease } from "../src/knowledge/release.ts";
import {
	describeKnowledgeSource,
	KNOWLEDGE_REQUIRED_ENTRIES,
	nodeKnowledgeFileSystem,
	resolveKnowledgeSource,
} from "../src/knowledge/source.ts";

const packFile = resolve(
	process.argv[2] ?? new URL("../knowledge/cosmic-kb.pack", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
);

const failures = [];
const cacheRoot = mkdtempSync(join(tmpdir(), "cosmic-kb-verify-"));

try {
	const snapshot = await loadKnowledgeSnapshot(packFile);
	console.log(
		`快照 ${snapshot.header.snapshotId.slice(0, 12)}，app-build ${snapshot.header.bundleVersion}，${snapshot.header.files.length} 篇`,
	);

	const released = await releaseKnowledge(cacheRoot, snapshot);
	if (released.reused) failures.push("空缓存下报告 reused，说明戳的判断有误");
	if (released.written !== snapshot.header.files.length) {
		failures.push(`释放篇数不符：写了 ${released.written}，快照有 ${snapshot.header.files.length}`);
	}

	// The environment a target user actually has: nothing configured at all.
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
	if (status.kind !== "embedded") failures.push(`未配 knowledgeRoot 时应解析为内嵌，实际为 ${status.kind}`);
	if (status.overrideProblem !== null) failures.push("未配置任何覆盖，却报出了覆盖问题");
	for (const line of describeKnowledgeSource(status)) console.log(`  ${line}`);

	// Absolute-path readability is the point of releasing to disk at all: a pi
	// skill's location and every path the knowledge tools hand the model are
	// absolute, and a knowledge base the model cannot open with `read` is not one.
	for (const entry of KNOWLEDGE_REQUIRED_ENTRIES) {
		const target = join(released.layout.docsDir, ...entry.split("/"));
		try {
			if (statSync(target).size === 0) failures.push(`必需入口为空文件：${entry}`);
			readFileSync(target, "utf8");
		} catch {
			failures.push(`必需入口无法从磁盘读出：${entry}（${target}）`);
		}
	}

	// D13 criterion 1: the prose, not just the frontmatter.
	const api = readFileSync(join(released.layout.docsDir, "platform", "api", "algo", "Algo.md"), "utf8");
	if (!api.includes("## 方法列表")) failures.push("API 正文缺少方法列表：又退回只有 frontmatter 的老状态");

	const verification = await verifyKnowledgeRelease(released.layout, snapshot);
	if (!verification.ok) failures.push(`释放后自校验有 ${verification.drifted.length} 篇不一致`);
	console.log(`  逐篇校验 ${verification.checked} 篇，一致`);

	const second = await releaseKnowledge(cacheRoot, snapshot);
	if (!second.reused) failures.push("第二次释放没有命中戳，冷启动成本会被重复付");

	// ---- S7.1: the reference skills, in the same empty environment ----
	const referencePack = join(dirname(packFile), "reference.pack");
	const reference = await loadKnowledgeSnapshot(referencePack);
	const releasedRef = await releaseReference(cacheRoot, reference);
	console.log(`
reference skills：${releasedRef.docCount} 个，ref ${releasedRef.bundleVersion}`);

	// The check that matters: pi silently drops a skill whose frontmatter it does
	// not accept, so a rejected skill is a document that stopped existing without
	// anyone being told. Read them back off disk rather than out of the pack --
	// what pi will scan is the released tree, not the archive.
	const onDisk = await readReleasedSkills(releasedRef.layout, reference);
	if (onDisk.length !== reference.header.files.length) {
		failures.push(`释放到磁盘的 skill 少了：${onDisk.length}/${reference.header.files.length}`);
	}
	const problems = checkSkillEntries(onDisk);
	for (const problem of problems) failures.push(`skill 不合 pi 契约：${problem.path} —— ${problem.why}`);

	// pi 拿到的是族索引目录（referenceSkillPaths），原文按需 read：常驻开销按族索引算，
	// 和 kernel-adapter 的 skills()、verify-knowledge-eval 的注入账目同一算法。
	const documents = onDisk.flatMap((entry) => {
		const front = parseSkillFrontmatter(entry.text);
		return front === null
			? []
			: [{ dir: entry.path.slice(0, entry.path.lastIndexOf("/")), description: front.description }];
	});
	const indexes = await writeFamilyIndexes(releasedRef.layout, documents);
	for (const problem of checkSkillEntries(indexes.entries)) {
		failures.push(`族索引不合 pi 契约：${problem.path} —— ${problem.why}`);
	}
	// 没归进任何一族的原文，模型就不知道它存在（不包括有意不做成 skill 的那几篇：它们不在 documents 里）。
	if (indexes.unfiled.length > 0) failures.push(`没归族的参考文档：${indexes.unfiled.join("、")}`);
	console.log(`  族索引 ${indexes.entries.length} 篇，收进 ${indexes.indexed}/${documents.length} 篇原文`);
	const skills = indexes.entries.map((entry) => parseSkillFrontmatter(entry.text)).filter((front) => front !== null);
	const budget = estimateInjectionBudget(skills, referenceSkillPaths(releasedRef.layout)[0]);
	console.log(
		`  系统提示常驻开销 ${budget.bytes} 字节（${(budget.bytes / 1024).toFixed(1)} KB），${budget.skills} 个 skill`,
	);
	console.log(`  其中绝对路径 ${budget.pathBytes} 字节，正文部分 ${budget.bytes - budget.pathBytes} 字节`);
	console.log(`  最大的一条 ${budget.largest[0].name} ${budget.largest[0].bytes} 字节`);
	// 13312 是原文各自成 skill 时的实测上限；族索引远在它下面，留着它只防载体回退成逐篇注入。
	if (budget.bytes > 13312) failures.push(`常驻注入 ${budget.bytes} 字节超出 SKILL.md 实测量级 13312`);

	// Absolute path, because that is what a skill's location must be for `read`.
	const [skillsDir] = referenceSkillPaths(releasedRef.layout);
	if (!isAbsolute(skillsDir)) failures.push(`skillPath 不是绝对路径：${skillsDir}`);
} catch (error) {
	failures.push(`验证过程抛错：${error instanceof Error ? error.message : String(error)}`);
} finally {
	rmSync(cacheRoot, { recursive: true, force: true });
}

if (failures.length > 0) {
	console.error(`\n[FAIL] S7.0 知识可用性验证未通过：\n  ${failures.join("\n  ")}`);
	process.exit(1);
}
console.log("\n[PASS] 空缓存 + 未配 COSMIC_KNOWLEDGE_ROOT 下，内嵌官方知识库可用");
