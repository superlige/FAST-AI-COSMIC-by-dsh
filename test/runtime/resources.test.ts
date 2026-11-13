import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { KernelError } from "../../src/kernel/errors.ts";
import { cacheLayout } from "../../src/runtime/cache.ts";
import {
	fingerprintClasspath,
	fingerprintCosmicRuntime,
	fingerprintJdk,
	fingerprintProject,
	fingerprintResources,
	sha256,
} from "../../src/runtime/fingerprint.ts";
import {
	assertAgentOwned,
	type EmbeddedResource,
	findResourceViolations,
	releasedProbeDigests,
	releasedProbeNames,
	releaseResources,
} from "../../src/runtime/resources.ts";
import { computeRuntimeKey } from "../../src/runtime/runtime-key.ts";

const roots: string[] = [];
function tempRoot(): string {
	const dir = mkdtempSync(join(tmpdir(), "cosmic-res-"));
	roots.push(dir);
	return dir;
}
afterAll(() => {
	for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

async function key() {
	const jdk = await fingerprintJdk("D:/jdk8", { describe: async () => ({ version: "1.8.0_392", build: null }) });
	if (jdk === null) throw new Error("unreachable");
	return computeRuntimeKey({
		agentVersion: "0.1.0",
		project: fingerprintProject({ root: "D:/proj", isv: "zlgd", debugModule: "d", codeModules: ["a"] }),
		jdk,
		cosmicRuntime: fingerprintCosmicRuntime("D:/cosmic", []),
		classpath: fingerprintClasspath(["a.jar"]),
		resources: fingerprintResources([]),
	});
}

const PROBE: EmbeddedResource = { relativePath: "probes/RuleSim.java", content: "class RuleSim {}\n" };

describe("S2.2 embedding allow-list", () => {
	it("publishes only classes with a runnable probe entry point", async () => {
		expect(
			releasedProbeNames([
				{ relativePath: "probes/MetaProbe.java", content: "class MetaProbe { public static void run() {} }" },
				{ relativePath: "probes/ExpectSpec.java", content: "final class ExpectSpec { static void check() {} }" },
			]),
		).toEqual(["MetaProbe"]);
	});

	it("binds each runnable released probe name to its reviewed source digest", () => {
		const runnable = {
			relativePath: "probes/MetaProbe.java",
			content: "class MetaProbe { public static void run() {} }",
		};
		const helper = { relativePath: "probes/ProbeJson.java", content: "class ProbeJson {}" };
		expect(releasedProbeDigests([runnable, helper])).toEqual({ MetaProbe: sha256(runnable.content) });
	});

	it("accepts the agent's own Java and Gradle sources", async () => {
		expect(
			findResourceViolations([
				PROBE,
				{ relativePath: "runtime/Host.java", content: "class Host {}" },
				{ relativePath: "gradle/probe.gradle", content: "// helper" },
			]),
		).toEqual([]);
	});

	it("refuses to embed a JAR", async () => {
		// The load-bearing rule: Cosmic JARs come from the user's runtime (D10/D12).
		const violations = findResourceViolations([{ relativePath: "lib/bos-core-8.2.1.jar", content: "PK" }]);
		expect(violations).toHaveLength(1);
		expect(violations[0]?.why).toContain("JAR 不得内嵌");
	});

	it("refuses customer config, evidence and key material", async () => {
		const violations = findResourceViolations([
			{ relativePath: "config.json", content: "{}" },
			{ relativePath: ".cosmic-ai/tasks/TASK-001/spec.yaml", content: "x" },
			{ relativePath: "certs/client.p12", content: "x" },
			{ relativePath: ".env.local", content: "SECRET=1" },
		]);
		expect(violations.map((v) => v.relativePath)).toEqual([
			"config.json",
			".cosmic-ai/tasks/TASK-001/spec.yaml",
			"certs/client.p12",
			".env.local",
		]);
	});

	it("refuses path traversal and absolute release targets", async () => {
		const violations = findResourceViolations([
			{ relativePath: "../escape.java", content: "x" },
			{ relativePath: "/abs.java", content: "x" },
		]);
		expect(violations).toHaveLength(2);
		for (const violation of violations) expect(violation.why).toContain("相对路径");
	});

	it("throws a KernelError listing every violation at once", async () => {
		let caught: unknown;
		try {
			assertAgentOwned([
				{ relativePath: "a.jar", content: "" },
				{ relativePath: "config.json", content: "" },
			]);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(KernelError);
		expect((caught as KernelError).detail.violations).toHaveLength(2);
	});
});

describe("S2.2 release into the RuntimeKey cache", () => {
	it("releases on a cold start and reuses on the next run", async () => {
		const layout = cacheLayout(tempRoot(), await key());
		const first = await releaseResources(layout, [PROBE]);
		expect(first.released).toEqual(["probes/RuleSim.java"]);
		const second = await releaseResources(layout, [PROBE]);
		expect(second.reused).toEqual(["probes/RuleSim.java"]);
		expect(second.released).toEqual([]);
	});

	it("repairs and reports an externally edited probe source rather than overwriting silently", async () => {
		const layout = cacheLayout(tempRoot(), await key());
		await releaseResources(layout, [PROBE]);
		const target = join(layout.resourcesDir, "probes/RuleSim.java");
		await writeFile(target, "class RuleSim { /* hand edited */ }\n", "utf8");

		const result = await releaseResources(layout, [PROBE]);
		expect(result.repaired).toEqual(["probes/RuleSim.java"]);
		expect(result.released).toEqual([]);
		expect(await readFile(target, "utf8")).toBe(PROBE.content);
	});

	it("refuses to release a forbidden resource at all", async () => {
		const layout = cacheLayout(tempRoot(), await key());
		await expect(releaseResources(layout, [{ relativePath: "bos.jar", content: "PK" }])).rejects.toBeInstanceOf(
			KernelError,
		);
	});

	it("keeps two runtimes' released sources apart", async () => {
		const cacheRoot = tempRoot();
		const a = cacheLayout(cacheRoot, await key());
		await mkdir(a.resourcesDir, { recursive: true });
		const b = cacheLayout(cacheRoot, computeRuntimeKey({ ...(await key()).parts, agentVersion: "0.2.0" }));
		expect(a.resourcesDir).not.toBe(b.resourcesDir);
	});
});
