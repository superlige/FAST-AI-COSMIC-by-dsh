#!/usr/bin/env node --experimental-strip-types
/**
 * S15 real-environment verification for automatic probe preparation.
 *
 * The unit tests prove aggregation and the fake agent proves no manual knowledge
 * call is needed. This script proves the remaining real-machine claim: one
 * internal prepare passes exact imports on into
 * javac/JVM, and a wildcard is rejected without starting that expensive path.
 *
 * A developer/verification entry point, not a model-facing surface: the steps
 * are fixed and there is no way to hand it a command to run (D1).
 *
 * Usage:
 *   node --experimental-strip-types scripts/verify-efficiency-gates.ts <projectRoot>
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKernelAdapter } from "../src/agent/tools/kernel-adapter.ts";
import { stopServer } from "../src/kernel/probe/server.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";

const AGENT_VERSION = "0.0.0-s15-batch3";
const QFILTER = "kd.bos.orm.query.QFilter";

/** Reads a real 苍穹 class and prints; no writer, so the S4.2 scan passes it. */
const PROBE_SOURCE = `import ${QFILTER};

public class S9GateProbe {
  public static void run() {
    QFilter filter = new QFilter("id", "=", 1L);
    System.out.println("[PROBE] filter=" + filter.toString());
  }
}
`;

const WILDCARD_SOURCE = `import kd.bos.orm.query.*;

public class S9WildcardProbe {
  public static void run() {
    System.out.println("[PROBE] unreachable");
  }
}
`;

async function main(): Promise<void> {
	const root = process.argv[2];
	if (!root) {
		console.error("用法: verify-efficiency-gates.ts <projectRoot>");
		process.exit(2);
	}

	// Customer config and credentials never land in cosmic/ (hard boundary).
	const agentConfigDir = process.env.COSMIC_AGENT_DIR ?? join(tmpdir(), "cosmic-agent");
	const cacheRoot = process.env.COSMIC_CACHE_ROOT ?? join(tmpdir(), "cosmic-cache");
	mkdirSync(agentConfigDir, { recursive: true });
	mkdirSync(cacheRoot, { recursive: true });

	const kernel = createKernelAdapter({
		agentConfigDir,
		cacheRoot,
		agentVersion: AGENT_VERSION,
		resources: EMBEDDED_RESOURCES,
		knowledgePackFile: join(process.cwd(), "knowledge", "cosmic-kb.pack"),
	});
	const opened = await kernel.open(root);
	if (!opened.ok) throw opened.error;
	const project = opened.value.handle;
	console.log(
		`RuntimeKey ${opened.value.summary.runtimeKeyId}  isv=${project.ctx.config.isv}  ` +
			`${String(project.key.parts.cosmicRuntime.jarCount)} 个 JAR`,
	);

	const scratch = join(project.ctx.projectRoot, "scratchpad");
	const probePath = join(scratch, "S9GateProbe.java");
	const wildcardPath = join(scratch, "S9WildcardProbe.java");
	mkdirSync(scratch, { recursive: true });
	writeFileSync(probePath, PROBE_SOURCE, "utf8");
	writeFileSync(wildcardPath, WILDCARD_SOURCE, "utf8");

	const failures: string[] = [];
	try {
		// 1. Exact imports are checked in one internal batch, without a model call.
		const prepared = await kernel.prepareProbe(project, "scratchpad/S9GateProbe.java", {});
		if (!prepared.ok) throw prepared.error;
		if (prepared.value.blockers.length > 0) {
			failures.push(`精确 import 预检不应有阻碍：${prepared.value.blockers.map((item) => item.code).join(", ")}`);
		}
		console.log(`[OK] 自动 prepare：${String(prepared.value.capsules.length)} 个 Capsule`);

		// 2. Wildcards stop before javac/JVM and need no knowledge check-in.
		const wildcard = await kernel.prepareProbe(project, "scratchpad/S9WildcardProbe.java", {});
		if (!wildcard.ok) throw wildcard.error;
		if (!wildcard.value.blockers.some((item) => item.code === "PROBE_API_WILDCARD")) {
			failures.push("通配 import 应在 prepare 阶段以 PROBE_API_WILDCARD 拒绝");
		} else {
			console.log("[OK] 通配 import 在编译/JVM 前拒绝");
		}

		// 3. Reuse the exact preparation and really compile/run against the JARs.
		const allowed = await kernel.probe(project, "scratchpad/S9GateProbe.java", {
			preparation: prepared.value,
		});
		if (!allowed.ok) {
			failures.push(`自动 prepare 后仍失败：[${allowed.error.code}] ${allowed.error.message}`);
			console.log(`[FAIL] ${allowed.error.code} ${allowed.error.message}`);
			if (allowed.error.remedy) console.log(`       → ${allowed.error.remedy}`);
		} else {
			console.log(`[OK] 放行并真的跑了：exitCode=${allowed.value.exitCode} path=${allowed.value.path}`);
			for (const line of allowed.value.output.split("\n").slice(0, 8)) {
				if (line.trim() !== "") console.log(`     ${line}`);
			}
			if (allowed.value.exitCode !== 0) failures.push(`探针退出码 ${allowed.value.exitCode}`);
		}
	} finally {
		rmSync(probePath, { force: true });
		rmSync(wildcardPath, { force: true });
		// Do not leave a resident JVM behind on the user's machine.
		await stopServer(project.ctx).catch(() => undefined);
	}

	if (failures.length > 0) {
		console.log("\nFAIL");
		for (const line of failures) console.log(`  - ${line}`);
		process.exitCode = 1;
		return;
	}
	console.log("\nPASS 三步全过：自动批量 API prepare → 通配提前拒绝 → 同一探针真实编译并运行");
}

await main();
