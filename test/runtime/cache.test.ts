import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	cacheLayout,
	inspectCache,
	mayReclaim,
	readJvmManifest,
	socketNameFor,
	writeCacheManifest,
	writeJvmManifest,
} from "../../src/runtime/cache.ts";
import {
	fingerprintClasspath,
	fingerprintCosmicRuntime,
	fingerprintJdk,
	fingerprintProject,
	fingerprintResources,
} from "../../src/runtime/fingerprint.ts";
import { computeRuntimeKey, type RuntimeKeyParts } from "../../src/runtime/runtime-key.ts";

const roots: string[] = [];
function tempRoot(): string {
	const dir = mkdtempSync(join(tmpdir(), "cosmic-cache-"));
	roots.push(dir);
	return dir;
}
afterAll(() => {
	for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

async function parts(
	overrides: { root?: string; classpath?: readonly string[]; jdkVersion?: string } = {},
): Promise<RuntimeKeyParts> {
	const jdk = await fingerprintJdk("D:/jdk8", {
		describe: async () => ({ version: overrides.jdkVersion ?? "1.8.0_392", build: null }),
	});
	if (jdk === null) throw new Error("unreachable");
	return {
		agentVersion: "0.1.0",
		project: fingerprintProject({
			root: overrides.root ?? "D:/proj",
			isv: "zlgd",
			debugModule: "debug",
			codeModules: ["a"],
		}),
		jdk,
		cosmicRuntime: fingerprintCosmicRuntime("D:/cosmic", [{ path: "lib/bos-core-8.2.1.jar", bytes: 100 }]),
		classpath: fingerprintClasspath(overrides.classpath ?? ["a.jar"]),
		resources: fingerprintResources([{ relativePath: "probes/P.java", content: "class P {}" }]),
	};
}

describe("S2.3 cache invalidation", () => {
	it("reports a cold start as absent, not stale", async () => {
		const cacheRoot = tempRoot();
		const key = computeRuntimeKey(await parts());
		return inspectCache(cacheRoot, key).then((status) => {
			expect(status.state).toBe("absent");
			expect(status.manifest).toBeNull();
		});
	});

	it("reuses a cache whose stored parts match", async () => {
		const cacheRoot = tempRoot();
		const key = computeRuntimeKey(await parts());
		await writeCacheManifest(cacheLayout(cacheRoot, key), key);
		const status = await inspectCache(cacheRoot, key);
		expect(status.state).toBe("fresh");
	});

	it("invalidates and names the dimension when the JDK changes", async () => {
		const cacheRoot = tempRoot();
		const before = computeRuntimeKey(await parts({ jdkVersion: "1.8.0_392" }));
		await writeCacheManifest(cacheLayout(cacheRoot, before), before);

		const after = computeRuntimeKey(await parts({ jdkVersion: "1.8.0_400" }));
		// A different key gets its own directory, so the old cache is not even consulted.
		expect(cacheLayout(cacheRoot, after).root).not.toBe(cacheLayout(cacheRoot, before).root);
		expect((await inspectCache(cacheRoot, after)).state).toBe("absent");

		// And when a directory IS reused with drifted parts, the diff names the change.
		const layout = cacheLayout(cacheRoot, before);
		await writeCacheManifest(layout, before);
		const forged = { ...before, parts: after.parts };
		const status = await inspectCache(cacheRoot, { ...before, parts: after.parts });
		expect(status.state).toBe("stale");
		if (status.state === "stale") expect(status.diff.changed).toEqual(["jdk"]);
		expect(forged.id).toBe(before.id);
	});

	it("treats a corrupt manifest as no cache rather than as a usable one", async () => {
		const cacheRoot = tempRoot();
		const key = computeRuntimeKey(await parts());
		const layout = cacheLayout(cacheRoot, key);
		await mkdir(layout.root, { recursive: true });
		writeFileSync(layout.manifestFile, "{ truncated", "utf8");
		expect((await inspectCache(cacheRoot, key)).state).toBe("absent");
	});

	it("gives two runtimes disjoint directories", async () => {
		const cacheRoot = tempRoot();
		const a = cacheLayout(cacheRoot, computeRuntimeKey(await parts({ root: "D:/a" })));
		const b = cacheLayout(cacheRoot, computeRuntimeKey(await parts({ root: "D:/b" })));
		expect(a.root).not.toBe(b.root);
		expect(a.classesDir).not.toBe(b.classesDir);
		expect(a.resourcesDir).not.toBe(b.resourcesDir);
	});

	it("writes a readable manifest carrying the full parts, not just the id", async () => {
		const cacheRoot = tempRoot();
		const key = computeRuntimeKey(await parts());
		const layout = cacheLayout(cacheRoot, key);
		await writeCacheManifest(layout, key);
		const stored = JSON.parse(await readFile(layout.manifestFile, "utf8")) as { parts: RuntimeKeyParts };
		expect(stored.parts.jdk.version).toBe("1.8.0_392");
		expect(stored.parts.cosmicRuntime.version).toBe("8.2.1");
	});
});

describe("D10 resident JVM identity", () => {
	it("derives the socket name from the RuntimeKey, never from a fixed port", async () => {
		const a = socketNameFor(computeRuntimeKey(await parts({ root: "D:/a" })));
		const b = socketNameFor(computeRuntimeKey(await parts({ root: "D:/b" })));
		expect(a).not.toBe(b);
		expect(a.startsWith("cosmic-v0.1.0-")).toBe(true);
	});

	it("round-trips a JVM manifest", async () => {
		const cacheRoot = tempRoot();
		const key = computeRuntimeKey(await parts());
		const layout = cacheLayout(cacheRoot, key);
		await writeJvmManifest(layout, key, 4321);
		const stored = await readJvmManifest(layout);
		expect(stored?.pid).toBe(4321);
		expect(stored?.keyId).toBe(key.id);
	});

	it("only reclaims a JVM whose manifest names this exact runtime", async () => {
		const cacheRoot = tempRoot();
		const mine = computeRuntimeKey(await parts({ root: "D:/a" }));
		const theirs = computeRuntimeKey(await parts({ root: "D:/b" }));
		const layout = cacheLayout(cacheRoot, mine);
		const manifest = await writeJvmManifest(layout, mine, 999);
		expect(mayReclaim(manifest, mine)).toBe(true);
		// On a developer machine that PID may by now belong to something else entirely.
		expect(mayReclaim(manifest, theirs)).toBe(false);
		expect(mayReclaim(null, mine)).toBe(false);
	});
});
