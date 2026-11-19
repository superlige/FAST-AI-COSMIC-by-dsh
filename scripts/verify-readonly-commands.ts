#!/usr/bin/env node --experimental-strip-types
/**
 * S5.1/S5.2 verification: doctor, the knowledge sub-commands and findclass, on a
 * real project and the real embedded snapshot.
 *
 * Unit tests run against in-memory trees, which proves the logic and nothing
 * about the 1,763-document snapshot or a user's actual config.json. This script
 * is the other half: fixed steps, read-only, no Cosmic runtime, no JVM. Like
 * verify-real-env.ts it takes named steps and never a command string (D1).
 *
 * Usage:
 *   node --experimental-strip-types scripts/verify-readonly-commands.ts <projectRoot> [packFile]
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { createKernelAdapter } from "../src/agent/tools/kernel-adapter.ts";
import type { KnowledgeRequest } from "../src/kernel/commands/knowledge.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";

const projectRoot = process.argv[2];
if (!projectRoot) {
	console.error("用法: verify-readonly-commands.ts <projectRoot> [packFile]");
	process.exit(2);
}
const packFile = resolve(
	process.argv[3] ?? new URL("../knowledge/cosmic-kb.pack", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
);

// A fresh cache each run: a warm one would hide a broken release.
const cacheRoot = mkdtempSync(join(tmpdir(), "cosmic-s5-verify-"));
const failures: string[] = [];

try {
	const kernel = createKernelAdapter({
		agentConfigDir: process.env.COSMIC_AGENT_DIR ?? join(tmpdir(), "cosmic-agent"),
		cacheRoot,
		agentVersion: "0.0.0-s5",
		resources: EMBEDDED_RESOURCES,
		knowledgePackFile: packFile,
		// Beside the official pack, which is the release layout. Deriving it is a
		// script's job, not the adapter's (D9).
		referencePackFile: resolve(packFile, "..", "reference.pack"),
	});

	const doctorResult = await kernel.doctor(projectRoot);
	if (!doctorResult.ok) {
		console.error(JSON.stringify(doctorResult.error.toJSON()));
		process.exit(1);
	}
	const report = doctorResult.value;
	console.log("== doctor ==");
	for (const row of report.rows) {
		console.log(
			`  ${row.field.padEnd(18)}${(row.value ?? "(缺失)").padEnd(42)}<- ${row.source}${row.via ? ` ${row.via}` : ""}`,
		);
	}
	console.log(
		`  模块: ${report.modules.codeModules.join(", ") || "(无)"}；认不出的依赖 ${report.modules.unresolvedDeps.length} 处`,
	);
	for (const line of report.knowledge.lines) console.log(`  ${line}`);
	console.log(`  缺配置 ${report.missingRequired.length} 项，ok=${report.ok}`);
	if (report.projectRoot !== resolve(projectRoot)) failures.push("doctor 报的工程根与入参不一致");
	if (report.knowledge.source === null) failures.push("doctor 没有解析出知识源");

	const steps: { label: string; request: KnowledgeRequest }[] = [
		{ label: "status", request: { action: "status" } },
		{ label: "routes", request: { action: "routes" } },
		{ label: "scenes", request: { action: "scenes" } },
		{ label: "scenes --plugin-type billform", request: { action: "scenes", pluginType: "billform" } },
		{ label: "search QFilter", request: { action: "search", query: "QFilter", limit: 5 } },
		{ label: "audit", request: { action: "audit" } },
	];

	console.log("\n== knowledge ==");
	for (const step of steps) {
		const result = await kernel.knowledge(step.request, projectRoot);
		if (!result.ok) {
			failures.push(`${step.label} 失败：${result.error.code} ${result.error.message}`);
			continue;
		}
		const value = result.value;
		switch (value.action) {
			case "status":
				console.log(
					`  status  来源=${value.source.kind} 版本=${value.source.bundleVersion} 文档=${value.fileCount} ` +
						`api=${value.counts.api} scenes=${value.counts.scenes} sdk=${value.counts.sdk} arch=${value.counts.arch}`,
				);
				if (value.missingEntries.length > 0) failures.push(`必需入口缺 ${value.missingEntries.join(", ")}`);
				if (value.fileCount === 0) failures.push("知识库解析出 0 篇文档");
				break;
			case "routes": {
				const tagged = value.rows.filter((row) => row.pluginType !== null);
				const withScenes = tagged.filter((row) => (row.sceneCount ?? 0) > 0);
				console.log(
					`  routes  ${value.rows.length} 行，有标签 ${tagged.length}，其中能查到场景的 ${withScenes.length}`,
				);
				if (withScenes.length === 0) failures.push("没有任何插件族能查到场景，场景表或标签解析有问题");
				break;
			}
			case "scenes":
				console.log(`  ${step.label.padEnd(32)}${value.rows.length}/${value.total} 条`);
				if (value.total === 0) failures.push("场景表解析出 0 条");
				break;
			case "search":
				console.log(`  search  命中 ${value.matched} 条，取前 ${value.results.length}`);
				for (const item of value.results)
					console.log(`      ${item.origin} score=${item.score} ${item.relativePath}`);
				if (value.matched === 0) failures.push("QFilter 一条都没搜到");
				break;
			case "audit":
				console.log(
					`  audit   文档=${value.fileCount} 索引场景=${value.scenes.indexed} 未索引=${value.scenes.unindexed.length} ` +
						`索引缺失=${value.scenes.missing.length} api 缺失=${value.api.missing.length} 失效链接=${value.brokenLinks.length} ok=${value.ok}`,
				);
				if (value.sourceChanged) failures.push("audit 期间知识源发生变化");
				break;
			default:
				break;
		}
	}

	// show is driven by what scenes just returned, so the path is never invented.
	const scenes = await kernel.knowledge({ action: "scenes" }, projectRoot);
	if (scenes.ok && scenes.value.action === "scenes" && scenes.value.rows[0]) {
		const relativePath = `platform/scenes/${scenes.value.rows[0].relativePath}`;
		const shown = await kernel.knowledge({ action: "show", query: relativePath }, projectRoot);
		if (!shown.ok) failures.push(`show ${relativePath} 失败：${shown.error.code}`);
		else if (shown.value.action === "show") {
			console.log(`  show    ${shown.value.relativePath} ${shown.value.content.length} 字符 -> ${shown.value.file}`);
			if (shown.value.content.length === 0) failures.push("show 读出空正文");
		}
	}

	// ---- S7.3: the two L2 channels, on the real 167-row scene table ----
	console.log("\n== S7.3 两条通道 ==");
	const eventFiltered = await kernel.knowledge({ action: "scenes", event: "afterF7Select" }, projectRoot);
	if (!eventFiltered.ok || eventFiltered.value.action !== "scenes") {
		failures.push("scenes --event 失败");
	} else {
		const account = eventFiltered.value.filter.find((entry) => entry.facet === "event");
		console.log(
			`  scenes event=afterF7Select  ${eventFiltered.value.rows.length}/${eventFiltered.value.total} 条` +
				`（命中 ${account?.hit ?? 0}，排除 ${account?.dropped ?? 0}，未标注保留 ${account?.untagged ?? 0}）`,
		);
		for (const warning of eventFiltered.value.warnings) console.log(`      ! ${warning}`);
		// The rule this stage must not lose: an untagged row is unknown, not a miss.
		// On the real index most rows have no triggerEvent column at all, so the
		// opposite reading would delete them from every --event answer, silently.
		if ((account?.untagged ?? 0) === 0)
			failures.push("event 过滤没有报出任何「未标注」行，空标签判据可能已被改成不匹配");
		if (eventFiltered.value.warnings.length === 0) failures.push("event 过滤没有给出任何提示");
	}

	for (const [query, expected] of [
		["kd.bos.orm.query.QFilter", "identifier"],
		["afterF7Select", "identifier"],
		["选完供应商带出联系人", "scene-question"],
	] as const) {
		const result = await kernel.knowledge({ action: "search", query }, projectRoot);
		if (!result.ok || result.value.action !== "search") {
			failures.push(`search ${query} 失败`);
			continue;
		}
		console.log(`  search ${query.padEnd(26)} channel=${result.value.route.channel} 命中 ${result.value.matched}`);
		if (result.value.route.channel !== expected) {
			failures.push(`search ${query} 路由到 ${result.value.route.channel}，应为 ${expected}`);
		}
		// 业务口吻的查询：前 3 条没有场景时才劝去读整表；已经有了就别再劝。标识符不劝
		const answered = result.value.results.slice(0, 3).some((hit) => hit.relativePath.startsWith("platform/scenes/"));
		if (expected === "scene-question" && !answered && result.value.steer === null)
			failures.push(`${query} 前几条没有场景，却没有给出改走整表读的指引`);
		if (expected === "scene-question" && answered && result.value.steer !== null)
			failures.push(`${query} 前几条已经有场景，却还劝去读整表`);
		if (expected === "identifier" && result.value.steer !== null) failures.push(`${query} 是标识符却被劝去读整表`);
	}

	const skills = await kernel.referenceSkills();
	if (!skills.ok) {
		failures.push(`reference skills 未装载：${skills.error.code} ${skills.error.message}`);
	} else {
		console.log(
			`  reference skills  ${skills.value.loaded} 族索引 / ${skills.value.indexed} 篇已收录（共 ${skills.value.documents} 篇），` +
				`常驻 ${skills.value.residentBytes} 字节，ref ${skills.value.bundleVersion}`,
		);
		for (const problem of skills.value.problems)
			failures.push(`skill 不合 pi 契约：${problem.path} —— ${problem.why}`);
		// 原文不再各自是一个 skill，「模型知道有这篇」的唯一依据就是它在某一族索引里。
		if (skills.value.indexed !== skills.value.documents)
			failures.push(`有 ${skills.value.documents - skills.value.indexed} 篇文档没进族索引，模型不会知道它存在`);
		// The official snapshot must never travel this path: 1,763 skills would put
		// roughly 600 KB into the system prompt.
		for (const path of skills.value.skillPaths) {
			if (!path.includes("reference")) failures.push(`skillPath 不在 reference 命名空间下：${path}`);
		}
	}

	// S5.2: findclass with no JAR in reach. The property under test is that it
	// says the scan could not run -- "nothing matched" and "the tool never ran"
	// look identical from outside, and only one of them means the class is absent.
	const findclass = await kernel.knowledge({ action: "findclass", query: "DynamicObject" }, projectRoot);
	if (!findclass.ok) {
		failures.push(`findclass 直接失败：${findclass.error.code}`);
	} else if (findclass.value.action !== "findclass") {
		failures.push("findclass 返回了别的动作");
	} else if (findclass.value.reflectionUnavailable === null) {
		failures.push("没有工程句柄也报扫描可用——那会把「没跑」说成「没命中」");
	} else {
		console.log(`  findclass 无 JAR 时如实报不可用：${findclass.value.reflectionUnavailable}`);
	}
	const emptyKeyword = await kernel.knowledge({ action: "findclass", query: "  " }, projectRoot);
	if (emptyKeyword.ok) failures.push("findclass 接受了空关键字");
	else console.log(`  findclass 空关键字已拒绝：${emptyKeyword.error.code}`);

	// The bound check, on the real tree.
	const escaped = await kernel.knowledge({ action: "show", query: "../../../secrets.md" }, projectRoot);
	if (escaped.ok) failures.push("show 接受了越界路径");
	else console.log(`  show    越界路径已拒绝：${escaped.error.code}`);
} finally {
	rmSync(cacheRoot, { recursive: true, force: true });
}

if (failures.length > 0) {
	console.error(`\n[FAIL] ${failures.length} 项：`);
	for (const failure of failures) console.error(`  - ${failure}`);
	process.exit(1);
}
console.log("\n[OK] doctor 与 knowledge 只读命令在真实工程与真实快照上通过");
