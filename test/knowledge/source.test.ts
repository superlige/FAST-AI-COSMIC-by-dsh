/**
 * Source resolution (D13 criterion 3). The behaviour under test is not "which
 * directory wins" -- it is that the answer is always reported: which source is in
 * force, both app-build versions, and any override that was configured and did
 * not take effect. Embedding the knowledge base is not permission to stop saying
 * where the model's knowledge came from.
 */
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	checkKnowledgeOverride,
	describeKnowledgeSource,
	findBundleVersion,
	KNOWLEDGE_REQUIRED_ENTRIES,
	type KnowledgeFilePort,
	resolveKnowledgeSource,
} from "../../src/knowledge/source.ts";

/** In-memory filesystem keyed by resolved absolute path, forward-slashed. */
function fakeFs(files: Record<string, string>, dirs: readonly string[] = []): KnowledgeFilePort {
	const norm = (path: string): string => resolve(path).replace(/\\/g, "/");
	const fileMap = new Map(Object.entries(files).map(([path, text]) => [norm(path), text]));
	const dirSet = new Set(dirs.map(norm));
	for (const path of fileMap.keys()) {
		let parent = path.slice(0, path.lastIndexOf("/"));
		while (parent.includes("/")) {
			dirSet.add(parent);
			parent = parent.slice(0, parent.lastIndexOf("/"));
		}
	}
	return {
		read: (path) => fileMap.get(norm(path)) ?? "",
		isFile: (path) => fileMap.has(norm(path)),
		isDirectory: (path) => dirSet.has(norm(path)),
	};
}

const embedded = {
	root: "C:/cache/knowledge/abc/cosmic",
	bundleVersion: "2.2.1",
	snapshotId: "abc123def456",
	docCount: 1763,
};

function completeRoot(root: string, extra: Record<string, string> = {}): Record<string, string> {
	const files: Record<string, string> = { ...extra };
	for (const entry of KNOWLEDGE_REQUIRED_ENTRIES) files[`${root}/${entry}`] = "# doc\n";
	return files;
}

describe("S7.0 知识来源解析", () => {
	it("uses the embedded snapshot when nothing is configured -- the normal case now", () => {
		const status = resolveKnowledgeSource({ configuredRoot: null, embedded }, fakeFs({}));
		expect(status.kind).toBe("embedded");
		expect(status.root).toBe(embedded.root);
		expect(status.overrideProblem).toBeNull();
		expect(status.inForce.bundleVersion).toBe("2.2.1");
	});

	it("lets a complete override win, and still names the embedded snapshot it shadowed", () => {
		const fs = fakeFs(completeRoot("C:/kb/knowledge/cosmic", { "C:/kb/CHANGELOG.md": "## [3.0.0] - 2026-09-01\n" }));
		const status = resolveKnowledgeSource({ configuredRoot: "C:/kb/knowledge/cosmic", embedded }, fs);
		expect(status.kind).toBe("override");
		expect(status.inForce.bundleVersion).toBe("3.0.0");
		// D13 criterion 3: both versions, always.
		expect(status.embedded.bundleVersion).toBe("2.2.1");
		expect(describeKnowledgeSource(status).join("\n")).toContain("内嵌快照仍在产物里");
	});

	it("falls back to embedded and REPORTS when the configured path does not exist", () => {
		const status = resolveKnowledgeSource({ configuredRoot: "C:/nope", embedded }, fakeFs({}));
		expect(status.kind).toBe("embedded");
		expect(status.overrideProblem?.kind).toBe("missing-path");
		// The fallback must never read as normal operation: a user who set the
		// variable and got the old knowledge base silently is the failure here.
		expect(describeKnowledgeSource(status).join("\n")).toContain("这是降级");
	});

	it("names the missing entry files when the override is not a knowledge root", () => {
		const fs = fakeFs({ "C:/kb/README.md": "" }, ["C:/kb"]);
		const status = resolveKnowledgeSource({ configuredRoot: "C:/kb", embedded }, fs);
		expect(status.overrideProblem?.kind).toBe("incomplete");
		expect(status.overrideProblem?.missing).toEqual([...KNOWLEDGE_REQUIRED_ENTRIES]);
	});

	it("suggests knowledge/cosmic when the user pointed at the bundle root", () => {
		// By far the most common misconfiguration, and the frozen implementation's
		// hint is the reason it is a one-line fix instead of a support question.
		const fs = fakeFs(completeRoot("C:/kb/knowledge/cosmic"), ["C:/kb"]);
		const check = checkKnowledgeOverride("C:/kb", fs);
		expect(check.problem?.message).toContain(resolve("C:/kb/knowledge/cosmic"));
	});

	it("climbs from knowledge/cosmic to the bundle CHANGELOG for the version", () => {
		const fs = fakeFs(
			completeRoot("C:/kb/knowledge/cosmic", { "C:/kb/CHANGELOG.md": "# Changelog\n\n## [2.2.1] - x\n" }),
		);
		expect(findBundleVersion("C:/kb/knowledge/cosmic", fs)).toBe("2.2.1");
	});

	it("reports an unknown version rather than inventing one", () => {
		const fs = fakeFs(completeRoot("C:/kb/knowledge/cosmic"));
		const status = resolveKnowledgeSource({ configuredRoot: "C:/kb/knowledge/cosmic", embedded }, fs);
		expect(status.inForce.bundleVersion).toBeNull();
		expect(describeKnowledgeSource(status)[0]).toContain("版本未知");
	});
});
