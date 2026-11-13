import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AD_HOC_FORBIDDEN } from "../../src/kernel/policy/write-apis.ts";
import { scanReferenceCapabilities } from "../../src/knowledge/reference-capabilities.ts";

describe("reference capability drift", () => {
	it.each([
		"元数据本体（一次性探针里调）new MetadataWriter().delFormMetadata(id)",
		"照下面这段现写一个到 `scratchpad/metadata/`，\n跑完即弃。",
		"规则里摘字段得另写一次性探针。",
		"仍然写一次性探针，\n默认 dry-run、只在 `APPLY=1` 时写。",
	])("rejects old write guidance: %s", (text) => {
		expect(scanReferenceCapabilities(text).some((issue) => issue.rule === "ad-hoc-write-guidance")).toBe(true);
	});

	it("uses every actual ad-hoc forbidden API rule for fenced examples", () => {
		for (const rule of AD_HOC_FORBIDDEN) {
			const issues = scanReferenceCapabilities(`临时探针示例：\n\n\`\`\`java\n${rule.sample}\n\`\`\``);
			expect(
				issues.some((issue) => issue.rule === "ad-hoc-forbidden-api" && issue.detail.includes(rule.what)),
				rule.what,
			).toBe(true);
		}
	});

	it("checks unknown calls through read-only types too", () => {
		const issues = scanReferenceCapabilities(
			"临时探针示例：\n\n```java\nPrintTplService svc = new PrintTplService();\nsvc.unknownWrite();\n```",
		);
		expect(issues).toContainEqual(expect.objectContaining({ rule: "ad-hoc-forbidden-api", line: 5 }));
	});

	it("does not trust a read-only label on code that writes", () => {
		const issues = scanReferenceCapabilities("只读临时探针示例：\n\n```java\nSaveServiceHelper.save(rows);\n```");
		expect(issues.some((issue) => issue.rule === "ad-hoc-forbidden-api")).toBe(true);
	});

	it("allows read-only diagnostics, prohibitions, and published-probe implementation references", () => {
		for (const text of [
			"临时探针只准读，不能调用 MetadataWriter；缺失能力须新增已发布探针。",
			"已发布写探针的实现参考：\n\n```java\nnew MetadataWriter().save(em, fm);\n```",
			"临时探针示例：\n\n```java\nPrintTplService svc = new PrintTplService();\nsvc.getDesignMeta(id);\n// SaveServiceHelper.save(x);\n```",
			"只读临时探针放在 `.cosmic-ai/probes/P.java`，使用 PrintFormulaExecute 验证分段数组。",
		])
			expect(scanReferenceCapabilities(text), text).toEqual([]);
	});

	it("reports legacy paths with source line numbers including CRLF", () => {
		expect(scanReferenceCapabilities("# title\r\n\r\nscratchpad/printing/P.java")).toEqual([
			expect.objectContaining({ line: 3, rule: "legacy-scratchpad" }),
		]);
	});

	it("fails the real exporter before writing when a source page contradicts capabilities", () => {
		const root = mkdtempSync(join(tmpdir(), "cosmic-reference-drift-"));
		try {
			mkdirSync(join(root, "reference"));
			writeFileSync(
				join(root, "reference", "bad.md"),
				"---\nclass: B\nwhen: test\n---\n\n# Bad\n\n仍然写一次性探针，APPLY=1 时写。\n",
			);
			const result = spawnSync(
				process.execPath,
				["scripts/export-reference.mjs", "--source", join(root, "reference"), "--check"],
				{
					cwd: resolve(import.meta.dirname, "../.."),
					encoding: "utf8",
				},
			);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("reference/bad.md:8 [ad-hoc-write-guidance]");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
