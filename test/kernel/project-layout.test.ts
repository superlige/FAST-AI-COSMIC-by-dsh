import { describe, expect, it } from "vitest";
import { ensureCosmicIgnore, upkeepProjectLayout } from "../../src/kernel/project/layout-upkeep.ts";
import { KEEP, RECLAIM_INTERVAL_MS, RECLAIM_STAMP, reclaimRuntimeCaches } from "../../src/runtime/cache-reclaim.ts";
import { MemoryFs, makeContext } from "./fake-context.ts";

const norm = (path: string): string => path.replace(/\\/g, "/");

describe("S19 where a project's cosmic files live", () => {
	it("leaves only Gradle's two files under build/", () => {
		const { ctx } = makeContext();
		const build = `${norm(ctx.layout.projectBuild)}/`;
		const layout = ctx.layout as unknown as Record<string, unknown>;
		const underBuild = Object.entries(layout)
			.filter(([, value]) => typeof value === "string" && norm(value).startsWith(build))
			.map(([name]) => name)
			.sort();
		// A `gradlew clean` deletes build/. Anything else listed here would go with it.
		expect(underBuild).toEqual(["javacArgs", "pathingJar"]);
	});

	it("puts what only this session reads back into the session directory", () => {
		const { ctx } = makeContext();
		const session = `${norm(ctx.layout.sessionDir)}/`;
		for (const path of [
			ctx.layout.assertionEvidence,
			ctx.layout.outputDir,
			ctx.layout.prodWorkDir,
			ctx.layout.exportsDir,
		]) {
			expect(norm(path).startsWith(session)).toBe(true);
		}
		// backups are kept, outside any session
		expect(norm(ctx.layout.backupsDir).startsWith(`${norm(ctx.layout.evidenceDir)}/`)).toBe(true);
	});

	it("keeps the rebuildable caches under work/", () => {
		const { ctx } = makeContext();
		const work = `${norm(ctx.layout.workDir)}/`;
		for (const path of [
			ctx.layout.impactIndex,
			ctx.layout.impactWork,
			ctx.layout.knowledgeCapsules,
			ctx.layout.projectWriteLock,
		]) {
			expect(norm(path).startsWith(work)).toBe(true);
		}
	});
});

describe("S19 moving what older releases left under build/", () => {
	it("moves receipts and the index, and deletes files nobody reads", () => {
		const fake = makeContext();
		const { fs, ctx } = fake;
		const build = norm(ctx.layout.projectBuild);
		fs.put(`${build}/verify/receipt-abc.json`, "receipt");
		fs.put(`${build}/impact.json`, "index");
		fs.put(`${build}/cosmic-impact/meta-index.json`, "meta");
		fs.put(`${build}/cosmic-knowledge-capsules/${ctx.runtimeKeyId}.json`, "capsules");
		fs.put(`${build}/cosmic-out/cosmic_probe-1.out`, "out");
		fs.put(`${build}/metadata-catalog.json`, "catalog");
		fs.put(`${build}/cosmic-plugin-brief/${ctx.runtimeKeyId}.json`, "brief");

		const upkeep = upkeepProjectLayout(ctx.layout, fs);

		expect(fs.read(`${norm(ctx.layout.verifyDir)}/receipt-abc.json`)).toBe("receipt");
		expect(fs.read(ctx.layout.impactIndex)).toBe("index");
		expect(fs.read(`${norm(ctx.layout.impactWork)}/meta-index.json`)).toBe("meta");
		expect(fs.read(ctx.layout.knowledgeCapsules)).toBe("capsules");
		expect(fs.read(`${norm(ctx.layout.outputDir)}/cosmic_probe-1.out`)).toBe("out");
		expect(upkeep.moved).toHaveLength(5);
		expect(upkeep.removed.sort()).toEqual(["build/cosmic-plugin-brief", "build/metadata-catalog.json"]);
		// Gradle's own files stay exactly where they were.
		expect([...fs.files.keys()].filter((key) => key.startsWith(`${build}/`)).sort()).toEqual([
			norm(ctx.layout.javacArgs),
			norm(ctx.layout.pathingJar),
		]);
		expect(upkeep.notes.join("\n")).toContain("搬了 5 个");
	});

	it("lets the new place win when both have the same file", () => {
		const { fs, ctx } = makeContext();
		fs.put(`${norm(ctx.layout.projectBuild)}/impact.json`, "old");
		fs.put(ctx.layout.impactIndex, "new");
		const upkeep = upkeepProjectLayout(ctx.layout, fs);
		expect(fs.read(ctx.layout.impactIndex)).toBe("new");
		expect(fs.exists(`${norm(ctx.layout.projectBuild)}/impact.json`)).toBe(false);
		expect(upkeep.removed).toEqual(["build/impact.json"]);
	});

	it("never touches an old write lock, and says so", () => {
		const { fs, ctx } = makeContext();
		const lock = `${norm(ctx.layout.projectBuild)}/cosmic-agent-write.lock`;
		fs.put(lock, '{"token":"t"}');
		const upkeep = upkeepProjectLayout(ctx.layout, fs);
		expect(fs.read(lock)).toBe('{"token":"t"}');
		expect(upkeep.notes.join("\n")).toContain("旧版的写锁");
	});

	it("is silent and writes nothing on the second open", () => {
		const { fs, ctx } = makeContext();
		fs.put(`${norm(ctx.layout.projectBuild)}/impact.json`, "index");
		upkeepProjectLayout(ctx.layout, fs);
		const before = new Map([...fs.files].map(([key, file]) => [key, file.content]));
		const again = upkeepProjectLayout(ctx.layout, fs);
		expect(again).toEqual({ moved: [], removed: [], gitignoreChanged: false, notes: [] });
		expect(new Map([...fs.files].map(([key, file]) => [key, file.content]))).toEqual(before);
	});
});

describe("S19 .cosmic-ai/.gitignore", () => {
	it("ignores everything except the cases, keeping lines a person added", () => {
		const fs = new MemoryFs();
		fs.put("D:/p/.cosmic-ai/.gitignore", "# mine\n/config.json");
		expect(ensureCosmicIgnore("D:/p/.cosmic-ai", fs).changed).toBe(true);
		expect(fs.read("D:/p/.cosmic-ai/.gitignore")).toBe(
			"# mine\n/config.json\n/evidence/\n/work/\n/probes/\n/sessions/\n/scratch/\n",
		);
		expect(ensureCosmicIgnore("D:/p/.cosmic-ai", fs).changed).toBe(false);
		expect(fs.read("D:/p/.cosmic-ai/.gitignore")).not.toContain("cases");
	});
});

describe("S19 reclaiming old RuntimeKey cache directories", () => {
	const CACHE = "D:/cache";
	const DAY = 24 * 60 * 60 * 1000;
	const NOW = Date.parse("2026-09-13T00:00:00.000Z");

	function seed(fs: MemoryFs, name: string, daysAgo: number): void {
		fs.put(
			`${CACHE}/${name}/runtime-key.json`,
			JSON.stringify({
				schema: "cosmic.runtime-cache/1",
				keyId: name,
				parts: {},
				writtenAt: new Date(NOW - daysAgo * DAY).toISOString(),
			}),
		);
		fs.put(`${CACHE}/${name}/probe-classes/A.class`, "x");
	}

	const fakeProc = (live: number[] = [], java: { pid: number; commandLine: string }[] | null = []) => ({
		isAlive: (pid: number) => live.includes(pid),
		listJava: async () => (java === null ? null : java.map((p) => ({ ...p, memoryBytes: null, startedAtMs: null }))),
	});

	it("keeps the current key and the most recently opened ones, removes the rest", async () => {
		const fs = new MemoryFs();
		for (let i = 0; i < 9; i++) seed(fs, `k${String(i)}`, i + 1);
		seed(fs, "current", 30);
		const result = await reclaimRuntimeCaches({
			cacheRoot: CACHE,
			currentKeyId: "current",
			fs,
			proc: fakeProc(),
			now: NOW,
		});
		expect(KEEP).toBe(5);
		expect(result.removed).toEqual(["k5", "k6", "k7", "k8"]);
		expect(fs.exists(`${CACHE}/current`)).toBe(true);
		expect(fs.exists(`${CACHE}/k4`)).toBe(true);
		expect(fs.exists(`${CACHE}/k8`)).toBe(false);
	});

	it("never touches a directory without a cache manifest, or one whose JVM is still running", async () => {
		const fs = new MemoryFs();
		for (let i = 0; i < 7; i++) seed(fs, `k${String(i)}`, i + 1);
		fs.put(`${CACHE}/k6/probe-server.pid`, JSON.stringify({ pid: 4242, keyId: "k6" }));
		fs.put(`${CACHE}/knowledge/snapshot.json`, "{}");
		fs.put(`${CACHE}/reference/x.md`, "#");
		const result = await reclaimRuntimeCaches({
			cacheRoot: CACHE,
			currentKeyId: "none",
			fs,
			proc: fakeProc([4242], [{ pid: 4242, commandLine: "java -Dprobe.runtimeKey=k6 CosmicProbeServer" }]),
			now: NOW,
		});
		expect(result.removed).toEqual(["k5"]);
		expect(fs.exists(`${CACHE}/k6`)).toBe(true);
		expect(fs.exists(`${CACHE}/knowledge`)).toBe(true);
		expect(fs.exists(`${CACHE}/reference`)).toBe(true);
	});

	it("sweeps at most once per interval, because every tool call opens the project", async () => {
		const fs = new MemoryFs();
		for (let i = 0; i < 6; i++) seed(fs, `k${String(i)}`, i + 1);
		const first = await reclaimRuntimeCaches({
			cacheRoot: CACHE,
			currentKeyId: "none",
			fs,
			proc: fakeProc(),
			now: NOW,
		});
		expect(first).toEqual({ removed: ["k5"], skipped: false });
		expect(fs.exists(`${CACHE}/${RECLAIM_STAMP}`)).toBe(true);
		seed(fs, "k9", 100);
		const soon = await reclaimRuntimeCaches({
			cacheRoot: CACHE,
			currentKeyId: "none",
			fs,
			proc: fakeProc(),
			now: NOW + 1000,
		});
		expect(soon).toEqual({ removed: [], skipped: true });
		const later = await reclaimRuntimeCaches({
			cacheRoot: CACHE,
			currentKeyId: "none",
			fs,
			proc: fakeProc(),
			now: NOW + RECLAIM_INTERVAL_MS,
		});
		expect(later.removed).toEqual(["k9"]);
	});

	it("a recorded pid now owned by another program does not pin the directory", async () => {
		const fs = new MemoryFs();
		for (let i = 0; i < 7; i++) seed(fs, `k${String(i)}`, i + 1);
		fs.put(`${CACHE}/k6/probe-server.pid`, JSON.stringify({ pid: 8684, keyId: "k6" }));
		const result = await reclaimRuntimeCaches({
			cacheRoot: CACHE,
			currentKeyId: "none",
			fs,
			proc: fakeProc([8684], [{ pid: 8684, commandLine: "msedge.exe --type=renderer" }]),
			now: NOW,
		});
		expect(result.removed).toEqual(["k5", "k6"]);
	});

	it("keeps a directory with a live pid when the process list cannot be read", async () => {
		const fs = new MemoryFs();
		for (let i = 0; i < 7; i++) seed(fs, `k${String(i)}`, i + 1);
		fs.put(`${CACHE}/k6/probe-server.pid`, JSON.stringify({ pid: 8684, keyId: "k6" }));
		const result = await reclaimRuntimeCaches({
			cacheRoot: CACHE,
			currentKeyId: "none",
			fs,
			proc: fakeProc([8684], null),
			now: NOW,
		});
		expect(result.removed).toEqual(["k5"]);
	});
});
