/**
 * The shipped snapshot must agree with its manifest, document for document.
 *
 * Same guarantee as test/kernel/embedded-resources.test.ts gives the Java side,
 * for the same reason: the manifest is the audit record a human reads when a
 * snapshot changes, and the pack is what the model actually reads. If they drift,
 * the manifest describes documents nobody opens -- and the whole point of making
 * the knowledge base a frozen input (D13) is lost without anything failing.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { openKnowledgePack } from "../../src/knowledge/pack.ts";
import { KNOWLEDGE_REQUIRED_ENTRIES } from "../../src/knowledge/source.ts";

interface KnowledgeManifest {
	schema: string;
	source: { bundleVersion: string; knowledgeRoot: string };
	snapshotId: string;
	counts: Record<string, number>;
	bytes: number;
	files: { path: string; bytes: number; sha256: string }[];
}

const manifest = JSON.parse(
	readFileSync(fileURLToPath(new URL("../../knowledge/manifest.json", import.meta.url)), "utf8"),
) as KnowledgeManifest;

const snapshot = openKnowledgePack(
	readFileSync(fileURLToPath(new URL("../../knowledge/cosmic-kb.pack", import.meta.url))),
);

describe("S7.0 官方知识快照", () => {
	it("matches the manifest file for file", () => {
		expect(snapshot.header.files).toHaveLength(manifest.files.length);
		expect(snapshot.header.snapshotId).toBe(manifest.snapshotId);
		const byPath = new Map(snapshot.header.files.map((file) => [file.path, file]));
		for (const file of manifest.files) {
			const entry = byPath.get(file.path);
			expect(entry, `快照缺少 ${file.path}`).toBeDefined();
			expect(entry?.sha256, file.path).toBe(file.sha256);
			expect(entry?.bytes, file.path).toBe(file.bytes);
		}
	});

	it("carries the three entry files that define a Cosmic knowledge root", () => {
		// These are what resolveKnowledgeSource uses to accept an override. If the
		// embedded snapshot lacked them, the embedded copy would fail the very test
		// it applies to everyone else's.
		for (const entry of KNOWLEDGE_REQUIRED_ENTRIES) {
			expect(snapshot.read(entry), entry).toBeTypeOf("string");
		}
	});

	it("carries API prose, not only frontmatter (D13 criterion 1)", () => {
		// The frozen apiItems() read four frontmatter fields and nothing else, so
		// 14,720 methods' Chinese comments, real parameter names and @param/@return
		// were embedded nowhere. That gap is the reason this stage exists; asserting
		// the method list survives the pack keeps it from silently reappearing.
		const algo = snapshot.read("platform/api/algo/Algo.md");
		expect(algo).toBeTypeOf("string");
		expect(algo as string).toContain("## 方法列表");
		expect(algo as string).toContain("**方法签名：**");
	});

	it("holds only Markdown under the three knowledge roots", () => {
		for (const file of snapshot.header.files) {
			expect(file.path, file.path).toMatch(/^(arch|platform|requirements)\//);
			expect(file.path, file.path).toMatch(/\.md$/);
		}
	});

	it("records the app-build version it came from", () => {
		// Not pinned to a literal: the snapshot is meant to be refreshed. What must
		// never happen is shipping a snapshot that cannot name its own provenance.
		expect(manifest.source.bundleVersion).toMatch(/^\d+\.\d+\.\d+$/);
		expect(snapshot.header.bundleVersion).toBe(manifest.source.bundleVersion);
	});

	it("still matches the document counts D13 recorded", () => {
		// D13's table is what the embed decision was made on. A silent change in
		// scope -- api docs dropped, scenes halved -- would invalidate that decision
		// without anyone noticing, so the counts are asserted rather than described.
		expect(manifest.counts).toMatchObject({
			"platform/api": 1528,
			"platform/scenes": 170,
			"platform/core": 5,
			"platform/sdk": 16,
			platform: 25,
			arch: 12,
			requirements: 7,
		});
		expect(manifest.files).toHaveLength(1763);
	});
});
