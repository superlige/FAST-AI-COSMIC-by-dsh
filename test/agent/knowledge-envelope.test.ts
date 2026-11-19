import { describe, expect, it } from "vitest";
import { trimKnowledgeEnvelope } from "../../src/agent/tools/knowledge-envelope.ts";

/**
 * The model-facing view of a `knowledge` report (S15).
 *
 * Both cuts are Windows absolute paths inside one `JSON.stringify`, where every
 * separator costs two characters. Measured on the real snapshot: `source.root`
 * is 18 escaped separators on every answer including a 652-byte `status`, and
 * `search query=DynamicObject limit=10` spent 1,743 of 6,028 bytes -- 29% -- on
 * `file` paths that no follow-up call accepts.
 */
describe("knowledge envelope", () => {
	const source = {
		kind: "embedded",
		root: "C:\\Users\\x\\AppData\\Local\\Temp\\kb\\7132b767\\cosmic",
		bundleVersion: "2.2.1",
		snapshotId: "7132b767f51acccd71cb5c8e1ea57c41",
		degradedFrom: null,
	};

	it("keeps the version and drops the unpack path", () => {
		const trimmed = trimKnowledgeEnvelope("cosmic_knowledge", { action: "scenes", source, rows: [] }) as {
			source: Record<string, unknown>;
		};
		expect(trimmed.source).toEqual({ kind: "embedded", bundleVersion: "2.2.1" });
	});

	it("never drops a rejected override, because that one changes the answer", () => {
		const trimmed = trimKnowledgeEnvelope("cosmic_knowledge", {
			action: "search",
			source: { ...source, degradedFrom: "配置的 knowledgeRoot 缺少 platform/standards.md" },
		}) as { source: Record<string, unknown> };
		expect(trimmed.source.degradedFrom).toBe("配置的 knowledgeRoot 缺少 platform/standards.md");
	});

	it("leaves `status` alone: which documents am I reading IS that question", () => {
		const report = { action: "status", source, fileCount: 1763 };
		expect(trimKnowledgeEnvelope("cosmic_knowledge", report)).toEqual(report);
	});

	it("drops a `file` that duplicates a `relativePath`, however deep it sits", () => {
		const trimmed = trimKnowledgeEnvelope("cosmic_knowledge", {
			action: "search",
			source,
			results: [
				{
					relativePath: "platform/api/bill/BillShowParameter.md",
					file: "C:\\kb\\cosmic\\platform\\api\\x.md",
					score: 3,
				},
			],
		}) as { results: Record<string, unknown>[] };
		expect(trimmed.results[0]).toEqual({ relativePath: "platform/api/bill/BillShowParameter.md", score: 3 });
	});

	it("search keeps what decides the next step: show, heading, scope, body; drops the path twin, score, lines and echoes", () => {
		const hit = {
			origin: "官方",
			relativePath: "platform/api/x/ControlInfo.md",
			file: "C:\\kb\\cosmic\\platform\\api\\x\\ControlInfo.md",
			heading: "方法列表 › getLock",
			scope: "一节（0.4 KB；整篇 2.3 KB，共 3 节）",
			lines: "40-52",
			show: "platform/api/x/ControlInfo.md#getLock",
			score: 31.2,
			matched: ["41: 取锁定性"],
			also: ["概述"],
		};
		const trimmed = trimKnowledgeEnvelope("cosmic_knowledge", {
			action: "search",
			source,
			query: "锁定 getLock",
			options: { kind: "all", limit: 5 },
			matched: 12,
			results: [hit],
			route: { channel: "scene-question", why: "查询含中文" },
			steer: null,
			filter: [],
			warnings: [],
		}) as Record<string, unknown>;
		expect(Object.keys(trimmed)).toEqual(["action", "source", "matched", "results", "steer", "filter", "warnings"]);
		expect((trimmed.results as unknown[])[0]).toEqual({
			origin: "官方",
			heading: "方法列表 › getLock",
			scope: "一节（0.4 KB；整篇 2.3 KB，共 3 节）",
			show: "platform/api/x/ControlInfo.md#getLock",
			matched: ["41: 取锁定性"],
			also: ["概述"],
		});
	});

	it("keeps relativePath outside search: api and show have no `show` twin", () => {
		const report = { action: "api", source, entries: [{ relativePath: "platform/api/x/ControlInfo.md", score: 1 }] };
		const trimmed = trimKnowledgeEnvelope("cosmic_knowledge", report) as { entries: Record<string, unknown>[] };
		expect(trimmed.entries[0]).toEqual({ relativePath: "platform/api/x/ControlInfo.md", score: 1 });
	});

	it("keeps a `file` that stands alone, since then it is the only name there is", () => {
		const report = { action: "plugin", source, stamped: { file: "C:\\proj\\build\\stamp.json" } };
		const trimmed = trimKnowledgeEnvelope("cosmic_knowledge", report) as { stamped: Record<string, unknown> };
		expect(trimmed.stamped.file).toBe("C:\\proj\\build\\stamp.json");
	});

	it("passes every other tool through untouched", () => {
		const report = { probe: "MetaProbe", file: "C:\\x.java", relativePath: "src/x.java" };
		expect(trimKnowledgeEnvelope("cosmic_probe", report)).toBe(report);
	});
});
