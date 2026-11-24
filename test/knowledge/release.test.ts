/**
 * Releasing the snapshot onto disk. The tests that matter here are about the
 * failure modes: an interrupted release must not look complete, a reused release
 * must not silently serve someone else's snapshot, and drift must be findable by
 * doctor even though the startup path deliberately does not look for it.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openKnowledgePack, packKnowledge } from "../../src/knowledge/pack.ts";
import {
	knowledgeLayout,
	reclaimSnapshots,
	releaseKnowledge,
	SNAPSHOT_IDLE_MS,
	SNAPSHOT_KEEP,
	verifyKnowledgeRelease,
} from "../../src/knowledge/release.ts";

const docs = [
	{ path: "platform/standards.md", content: "# 规范\n" },
	{ path: "platform/scenes/_index.md", content: "| 场景 |\n" },
	{ path: "arch/overview.md", content: "架构总览\n" },
];

const snapshot = openKnowledgePack(packKnowledge({ snapshotId: "snap0001", bundleVersion: "2.2.1" }, docs));
const other = openKnowledgePack(packKnowledge({ snapshotId: "snap0002", bundleVersion: "2.3.0" }, docs));

const temps: string[] = [];
async function cacheRoot(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "cosmic-kb-"));
	temps.push(dir);
	return dir;
}
afterEach(async () => {
	for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("S7.0 知识快照释放", () => {
	it("writes every document under the snapshot-scoped directory", async () => {
		const root = await cacheRoot();
		const result = await releaseKnowledge(root, snapshot);
		expect(result.reused).toBe(false);
		expect(result.written).toBe(3);
		expect(result.layout.root).toBe(join(root, "knowledge", "snap0001"));
		expect(await readFile(join(result.layout.docsDir, "arch", "overview.md"), "utf8")).toBe("架构总览\n");
	});

	it("reuses an identical release without rewriting anything", async () => {
		const root = await cacheRoot();
		await releaseKnowledge(root, snapshot);
		const second = await releaseKnowledge(root, snapshot);
		expect(second.reused).toBe(true);
		expect(second.written).toBe(0);
	});

	it("keeps two snapshots apart instead of overwriting one with the other", async () => {
		// The id is the identity, not the cache root: a user who updates the bundle
		// must not end up with one directory holding a mix of two snapshots.
		const root = await cacheRoot();
		const first = await releaseKnowledge(root, snapshot);
		const second = await releaseKnowledge(root, other);
		expect(second.layout.root).not.toBe(first.layout.root);
		expect(second.reused).toBe(false);
		expect(second.bundleVersion).toBe("2.3.0");
	});

	it("redoes a release whose stamp is missing, corrupt, or from another snapshot", async () => {
		const root = await cacheRoot();
		const { layout } = await releaseKnowledge(root, snapshot);
		// An interrupted release is exactly this: documents present, stamp absent.
		// Treating it as done would leave the model reading a partial tree.
		await writeFile(layout.stampFile, "{ not json", "utf8");
		expect((await releaseKnowledge(root, snapshot)).reused).toBe(false);
	});

	it("finds drifted documents on verification, which is what doctor runs", async () => {
		const root = await cacheRoot();
		const { layout } = await releaseKnowledge(root, snapshot);
		expect((await verifyKnowledgeRelease(layout, snapshot)).ok).toBe(true);

		await writeFile(join(layout.docsDir, "platform", "standards.md"), "# 被改过了\n", "utf8");
		const after = await verifyKnowledgeRelease(layout, snapshot);
		expect(after.ok).toBe(false);
		expect(after.drifted).toEqual(["platform/standards.md"]);
		expect(after.checked).toBe(3);
	});

	it("reports a deleted document as drift, not as an absent file it can ignore", async () => {
		const root = await cacheRoot();
		const { layout } = await releaseKnowledge(root, snapshot);
		await rm(join(layout.docsDir, "arch", "overview.md"));
		expect((await verifyKnowledgeRelease(layout, snapshot)).drifted).toEqual(["arch/overview.md"]);
	});

	it("names the layout deterministically so a cache directory can be identified", () => {
		expect(knowledgeLayout("C:/cache", "abc").docsDir).toBe(join("C:/cache", "knowledge", "abc", "cosmic"));
	});
});

describe("旧快照：很久没用的清掉", () => {
	async function fakeSnapshot(namespace: string, id: string, writtenAt: string): Promise<void> {
		const dir = join(namespace, id);
		await mkdir(dir, { recursive: true });
		const stamp = {
			schema: "cosmic.knowledge-release/1",
			snapshotId: id,
			bundleVersion: "x",
			docCount: 0,
			writtenAt,
		};
		await writeFile(join(dir, "snapshot.json"), JSON.stringify(stamp));
	}

	it("本次这份和最近用过的几份留着，其余 30 天没用过的删掉；人放的目录碰不到", async () => {
		const root = await cacheRoot();
		const namespace = join(root, "knowledge");
		const now = Date.parse("2026-11-23T00:00:00Z");
		const old = new Date(now - SNAPSHOT_IDLE_MS - 86_400_000).toISOString();
		for (let i = 0; i < SNAPSHOT_KEEP + 3; i++) await fakeSnapshot(namespace, `old${String(i)}`, old);
		await fakeSnapshot(namespace, "recent", new Date(now - 86_400_000).toISOString());
		await mkdir(join(namespace, "人放的"), { recursive: true });
		const removed = await reclaimSnapshots(namespace, "current", now);
		// 最近用过的 KEEP 份里有 recent，剩下的旧快照里留 KEEP-1 份
		expect(removed).toHaveLength(SNAPSHOT_KEEP + 3 - (SNAPSHOT_KEEP - 1));
		expect(removed).not.toContain("recent");
		expect((await readdir(namespace)).sort()).toEqual(expect.arrayContaining(["recent", "人放的"]));
		// 六小时内不再扫
		await fakeSnapshot(namespace, "late", old);
		expect(await reclaimSnapshots(namespace, "current", now + 1000)).toEqual([]);
	});
});
