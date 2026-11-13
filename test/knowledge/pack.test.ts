/**
 * The knowledge pack format. Encode and decode live in one module precisely so
 * these can be round-trip tests rather than assertions about a format nobody
 * re-reads; what the rest of the file cares about is that every way the pack can
 * be wrong produces a KernelError instead of a quietly smaller knowledge base.
 */
import { gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { KernelError } from "../../src/kernel/errors.ts";
import { openKnowledgePack, packKnowledge } from "../../src/knowledge/pack.ts";

const header = { snapshotId: "0123456789abcdef", bundleVersion: "2.2.1" };

const docs = [
	{ path: "platform/standards.md", content: "# 编码规范\n\n第一条。\n" },
	{ path: "platform/scenes/_index.md", content: "| 场景 | 基类 |\n|---|---|\n| 表单 | AbstractFormPlugin |\n" },
	{ path: "arch/overview.md", content: "架构总览\n" },
];

describe("S7.0 知识快照打包格式", () => {
	it("round-trips content, including multi-byte text", () => {
		const snapshot = openKnowledgePack(packKnowledge(header, docs));
		for (const doc of docs) expect(snapshot.read(doc.path), doc.path).toBe(doc.content);
		expect(snapshot.header.snapshotId).toBe(header.snapshotId);
		expect(snapshot.header.bundleVersion).toBe("2.2.1");
	});

	it("records UTF-8 byte length, not JavaScript string length", () => {
		// Offsets are byte offsets. Recording string length would misplace every
		// document after the first Chinese character -- and the symptom would be
		// mojibake in the middle of a knowledge document, not an error.
		const snapshot = openKnowledgePack(packKnowledge(header, docs));
		const entry = snapshot.header.files.find((file) => file.path === "arch/overview.md");
		expect(entry?.bytes).toBe(Buffer.from("架构总览\n", "utf8").length);
		expect(entry?.bytes).not.toBe("架构总览\n".length);
	});

	it("orders the file table deterministically regardless of input order", () => {
		const forward = packKnowledge(header, docs);
		const backward = packKnowledge(header, [...docs].reverse());
		expect(Buffer.from(backward)).toEqual(Buffer.from(forward));
	});

	it("returns null for an unknown path rather than throwing", () => {
		const snapshot = openKnowledgePack(packKnowledge(header, docs));
		expect(snapshot.read("platform/does-not-exist.md")).toBeNull();
	});

	it("rejects a pack that is not gzip", () => {
		expect(() => openKnowledgePack(Buffer.from("plain text", "utf8"))).toThrow(KernelError);
	});

	it("rejects an unknown schema instead of guessing the layout", () => {
		const bad = gzipSync(
			Buffer.from(`${JSON.stringify({ schema: "cosmic.knowledge-pack/99", files: [] })}\n`, "utf8"),
		);
		expect(() => openKnowledgePack(bad)).toThrow(/schema/);
	});

	it("rejects a truncated pack instead of serving empty documents", () => {
		// This is the load-bearing one. Without the length check a short read makes
		// the tail documents decode as "" -- a knowledge base that is silently
		// missing its last N articles, which is defect D-3's exact shape.
		const full = packKnowledge(header, docs);
		const raw = Buffer.from(gunzipSync(full));
		const truncated = gzipSync(raw.subarray(0, raw.length - 5));
		expect(() => openKnowledgePack(truncated)).toThrow(/正文长度/);
	});

	it("detects a corrupted document body via its recorded hash", () => {
		const raw = Buffer.from(gunzipSync(packKnowledge(header, docs)));
		// Flip one byte inside the payload, keeping every length identical.
		const separator = raw.indexOf(0x0a);
		raw[separator + 1] = raw[separator + 1] === 0x23 ? 0x24 : 0x23;
		const snapshot = openKnowledgePack(gzipSync(raw));
		expect(() => snapshot.read("arch/overview.md")).toThrow(KernelError);
	});
});
