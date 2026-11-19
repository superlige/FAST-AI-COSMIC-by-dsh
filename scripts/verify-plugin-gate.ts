#!/usr/bin/env node --experimental-strip-types
/**
 * S7.4 verification: plugin recognition, the L3 gate and the six-step root flow,
 * on a real ISV project and the real embedded snapshot.
 *
 * Unit tests run against in-memory Java trees, which proves the climb and the
 * verdict and nothing about a project that actually has hundreds of classes and
 * its own base-class hierarchy. This script is the other half. It drives the
 * ADAPTER rather than the kernel functions, because the adapter is where lint
 * and fast are handed the same advisor closure -- verifying the halves agree
 * anywhere else would verify the wrong wiring.
 *
 * Fixed steps, never a command string (D1). The only step that writes anything
 * is the flow's second call, and it writes one stamp under the project's build/.
 *
 * Two modes:
 *
 *   scan <sourceRoot>...   Recognition only. Needs no credentials and no Cosmic
 *                          runtime, because recognition is a pure function of the
 *                          source tree -- which is also why the column that
 *                          matters (classes reachable only through a project base
 *                          class) can be counted on any real project at any time.
 *   <projectRoot>          The whole round trip. Needs a complete config, so the
 *                          runtime-only values (account, user) must be in the
 *                          environment: they never live in cosmic/.
 *
 * Usage:
 *   node --experimental-strip-types scripts/verify-plugin-gate.ts scan <sourceRoot>...
 *   node --experimental-strip-types scripts/verify-plugin-gate.ts <projectRoot> [packFile]
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { createKernelAdapter } from "../src/agent/tools/kernel-adapter.ts";
import { nodePorts } from "../src/kernel/ports.ts";
import { type PluginTier, pluginBaseOf } from "../src/knowledge/plugin-base.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";

const projectRoot = process.argv[2];
if (!projectRoot) {
	console.error("用法: verify-plugin-gate.ts scan <sourceRoot>... | verify-plugin-gate.ts <projectRoot> [packFile]");
	process.exit(2);
}
const packFile = resolve(
	process.argv[3] ?? new URL("../knowledge/cosmic-kb.pack", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
);

const failures: string[] = [];

function check(label: string, ok: boolean, detail = ""): void {
	console.log(`  ${ok ? "OK  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
	if (!ok) failures.push(label);
}

interface SweepResult {
	files: number;
	withExtends: number;
	tally: Record<PluginTier | "none", number>;
	families: Map<string, number>;
	climbedExamples: string[];
}

/**
 * Recognise every source under a set of directories.
 *
 * The "climbed" count is the one to read: those classes reach a platform base
 * only through a base class the project wrote itself, and direct-parent-only
 * recognition says nothing whatsoever about any of them -- which looks exactly
 * like "there was nothing to say".
 */
function sweep(dirs: readonly string[], stripPrefix: string): SweepResult {
	const result: SweepResult = {
		files: 0,
		withExtends: 0,
		tally: { direct: 0, climbed: 0, loose: 0, none: 0 },
		families: new Map(),
		climbedExamples: [],
	};
	for (const dir of dirs) {
		for (const file of nodePorts.fs.listJavaFiles(dir)) {
			result.files += 1;
			let text = "";
			try {
				text = readFileSync(file, "utf8");
			} catch {
				continue;
			}
			if (!/\b(?:extends|implements)\s/.test(text)) continue;
			result.withExtends += 1;
			const hit = pluginBaseOf(text, { file, source: nodePorts.fs });
			if (hit === null) {
				result.tally.none += 1;
				continue;
			}
			result.tally[hit.tier] += 1;
			result.families.set(hit.route.base, (result.families.get(hit.route.base) ?? 0) + 1);
			if (hit.tier === "climbed" && result.climbedExamples.length < 8) {
				const shown = file.startsWith(stripPrefix) ? file.slice(stripPrefix.length + 1) : file;
				result.climbedExamples.push(`${shown} → ${hit.via.join(" → ")} → ${hit.route.base}`);
			}
		}
	}
	return result;
}

function reportSweep(result: SweepResult): void {
	console.log(`  源文件 ${String(result.files)}，其中带 extends/implements 的 ${String(result.withExtends)}`);
	console.log(
		`  直接父类 ${String(result.tally.direct)} / 经工程基类上溯 ${String(result.tally.climbed)}` +
			` / 标识符兜底 ${String(result.tally.loose)} / 认不出 ${String(result.tally.none)}`,
	);
	for (const example of result.climbedExamples) console.log(`    上溯样例 ${example}`);
	const families = [...result.families.entries()]
		.sort((a, b) => b[1] - a[1])
		.map(([base, count]) => `${base}×${String(count)}`)
		.join("、");
	console.log(`  识别出的族：${families || "(无)"}`);
}

if (projectRoot === "scan") {
	const dirs = process.argv.slice(3);
	if (dirs.length === 0) {
		console.error("用法: verify-plugin-gate.ts scan <sourceRoot>...");
		process.exit(2);
	}
	console.log("== 识别扫描（不需要凭据、不连运行时）==");
	const result = sweep(dirs, dirs[0] ?? "");
	reportSweep(result);
	check("扫描认出了至少一个插件族", result.families.size > 0);
	check("经工程基类上溯确实命中（只认直接父类时这些一个字都不会提示）", result.tally.climbed > 0);
	if (failures.length > 0) {
		console.error(`\n${String(failures.length)} 项未通过：${failures.join("；")}`);
		process.exit(1);
	}
	console.log("\n全部通过。");
	process.exit(0);
}

const cacheRoot = mkdtempSync(join(tmpdir(), "cosmic-s7-verify-"));

try {
	const kernel = createKernelAdapter({
		agentConfigDir: process.env.COSMIC_AGENT_DIR ?? join(tmpdir(), "cosmic-agent"),
		cacheRoot,
		agentVersion: "0.0.0-s7",
		resources: EMBEDDED_RESOURCES,
		knowledgePackFile: packFile,
		referencePackFile: resolve(packFile, "..", "reference.pack"),
	});

	const opened = await kernel.open(projectRoot);
	if (!opened.ok) {
		console.error(JSON.stringify(opened.error.toJSON()));
		process.exit(1);
	}
	const project = opened.value.handle;
	console.log(`工程 ${opened.value.summary.root}  RuntimeKey ${opened.value.summary.runtimeKeyId}`);

	// ---- 1. recognition sweep over every source in the project's code modules.
	//
	// The number that matters is the "climbed" column: those are the classes that
	// reach a platform base only through a project base class, and every one of
	// them is invisible to direct-parent-only recognition.
	console.log("\n== 1. 全工程识别扫描 ==");
	const sources = project.ctx.layout.moduleDirs.flatMap((dir) => nodePorts.fs.listJavaFiles(dir.src));
	const swept = sweep(
		project.ctx.layout.moduleDirs.map((dir) => dir.src),
		projectRoot,
	);
	reportSweep(swept);
	check("识别扫描跑完且认出了至少一个插件族", swept.families.size > 0);

	// ---- 2. pick one recognised plugin source and drive the whole round trip.
	const target = sources.find((file) => {
		try {
			const hit = pluginBaseOf(readFileSync(file, "utf8"), { file, source: nodePorts.fs });
			return hit !== null && hit.route.pluginType !== null;
		} catch {
			return false;
		}
	});
	if (target === undefined) {
		console.log("\n工程里没有带官方场景标签的插件类，后续步骤跳过。");
		process.exit(failures.length === 0 ? 0 : 1);
	}
	console.log(`\n== 2. 门禁往返，目标 ${target.slice(projectRoot.length + 1)} ==`);

	const blocked = await kernel.fast(project, [target]);
	check(
		"fast 在未走流程时拒绝，且用的是 KNOWLEDGE_GATE_UNSATISFIED",
		!blocked.ok && blocked.error.code === "KNOWLEDGE_GATE_UNSATISFIED",
		blocked.ok ? "(没有拒绝)" : blocked.error.code,
	);

	const preview = await kernel.lint(project, [target]);
	const previewed = preview.ok ? preview.value.knowledge?.gate : undefined;
	check("lint 照常给出诊断，没有因为门禁而拒绝执行", preview.ok);
	check(
		"lint 预告与 fast 拒绝结论一致",
		previewed?.allowed === false &&
			!blocked.ok &&
			JSON.stringify(blocked.error.detail.blockedBases) === JSON.stringify(previewed.blocked.map((f) => f.base)),
		`lint blocked=${JSON.stringify(previewed?.blocked.map((f) => f.base) ?? null)}`,
	);
	if (preview.ok && preview.value.knowledge) {
		for (const hint of preview.value.knowledge.hints) {
			console.log(
				`    提示 ${hint.base} (${hint.tier})  场景 ${hint.sceneCount ?? "未打标签"} 篇  指南 ${hint.guide}`,
			);
		}
	}

	// ---- 3. the flow.
	console.log("\n== 3. 六步根流程 ==");
	const laidOut = await kernel.knowledge({ action: "plugin", query: target }, projectRoot, project);
	if (!laidOut.ok || laidOut.value.action !== "plugin") {
		console.error(JSON.stringify(laidOut.ok ? laidOut.value : laidOut.error.toJSON()));
		process.exit(1);
	}
	const family = laidOut.value.family;
	console.log(
		`  1/6 ${family.base}${family.via.length > 0 ? `（经 ${family.via.join(" → ")}）` : ""} → ${family.pluginType ?? "未打标签"}`,
	);
	console.log(`  2/6 指南 ${laidOut.value.guide?.relativePath}  ${String(laidOut.value.guide?.bytes ?? 0)} 字节`);
	console.log(`  3/6 场景表 ${String(laidOut.value.scenes?.rows.length ?? 0)} 行`);
	check("phase 1 摆出了指南全文", (laidOut.value.guide?.bytes ?? 0) > 0);
	check("phase 1 没有记戳", laidOut.value.stamped === null);

	const invented = await kernel.knowledge(
		{ action: "plugin", query: target, scenes: ["definitely-not-a-real-scene.md"] },
		projectRoot,
		project,
	);
	check("编造的篇名当场打回", !invented.ok, invented.ok ? "(通过了)" : invented.error.message);

	const first = laidOut.value.scenes?.rows[0]?.relativePath;
	if (first === undefined) {
		console.log("  这一族的场景表是空的，第二次调用跳过。");
	} else {
		const stamped = await kernel.knowledge(
			{ action: "plugin", query: target, scenes: [first] },
			projectRoot,
			project,
		);
		if (!stamped.ok || stamped.value.action !== "plugin") {
			console.error(JSON.stringify(stamped.ok ? stamped.value : stamped.error.toJSON()));
			process.exit(1);
		}
		console.log(
			`  4/6 选定 ${stamped.value.chosen.map((doc) => `${doc.relativePath}(${String(doc.bytes)}B)`).join("、")}`,
		);
		for (const action of stamped.value.nextActions) console.log(`      ${action}`);

		// ---- 4. the gate now lets the same file through.
		console.log("\n== 4. 记戳之后 ==");
		const after = await kernel.fast(project, [target]);
		check(
			"同一族不再被门禁拦（编译本身成不成功是另一回事）",
			after.ok || after.error.code !== "KNOWLEDGE_GATE_UNSATISFIED",
			after.ok ? "编译通过" : after.error.code,
		);
		if (after.ok) console.log(`    门禁结论 ${after.value.knowledge?.gate.reason ?? "(无)"}`);
	}
} finally {
	rmSync(cacheRoot, { recursive: true, force: true });
}

if (failures.length > 0) {
	console.error(`\n${String(failures.length)} 项未通过：${failures.join("；")}`);
	process.exit(1);
}
console.log("\n全部通过。");
