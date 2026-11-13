import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { auditReleaseTree, formatAuditReport } from "../../src/runtime/release-audit.ts";

const roots: string[] = [];
function tree(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "cosmic-audit-"));
	roots.push(root);
	for (const [relative, content] of Object.entries(files)) {
		const target = join(root, relative);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, content, "utf8");
	}
	return root;
}
afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const CLEAN_RELEASE = {
	"fast-ai-cosmic.exe": "MZ binary",
	"package.json": '{"name":"cosmic"}',
	LICENSE: "MIT",
	"resources/probes/RuleSim.java": "class RuleSim {}",
	"resources/runtime/Host.java": "class Host {}",
};

describe("S2.4 release artifact audit", () => {
	it("passes a clean release", () => {
		const report = auditReleaseTree(tree(CLEAN_RELEASE));
		expect(report.pass).toBe(true);
		expect(report.fileCount).toBe(5);
		expect(formatAuditReport(report)).toContain("PASS");
	});

	it("fails a release containing a Cosmic JAR", () => {
		// The check that must never be skippable: shipping a Cosmic JAR both breaks
		// the licensing boundary and pins every user to one Cosmic version.
		const report = auditReleaseTree(tree({ ...CLEAN_RELEASE, "lib/bos-core-8.2.1.jar": "PK" }));
		expect(report.pass).toBe(false);
		expect(report.findings).toHaveLength(1);
		expect(report.findings[0]?.rule).toBe("cosmic-jar");
		expect(report.findings[0]?.path).toBe("lib/bos-core-8.2.1.jar");
		expect(formatAuditReport(report)).toContain("FAIL");
	});

	it("fails on customer config, evidence, dotenv and key material", () => {
		const report = auditReleaseTree(
			tree({
				...CLEAN_RELEASE,
				"config.json": "{}",
				".cosmic-ai/tasks/TASK-001/spec.yaml": "id: TASK-001",
				".env": "TOKEN=1",
				"certs/client.pem": "-----BEGIN",
			}),
		);
		expect(report.pass).toBe(false);
		expect(report.findings.map((finding) => finding.rule).sort()).toEqual([
			"customer-config",
			"customer-evidence",
			"dotenv",
			"key-material",
		]);
	});

	it("finds a JAR nested at any depth", () => {
		const report = auditReleaseTree(tree({ ...CLEAN_RELEASE, "a/b/c/d/hidden.jar": "PK" }));
		expect(report.pass).toBe(false);
		expect(report.findings[0]?.path).toBe("a/b/c/d/hidden.jar");
	});

	it("reports the size of an offending file so the report is actionable", () => {
		const report = auditReleaseTree(tree({ ...CLEAN_RELEASE, "x.jar": "0123456789" }));
		expect(report.findings[0]?.bytes).toBe(10);
	});

	it("honours an explicit allow entry only for that exact path", () => {
		const files = { ...CLEAN_RELEASE, "vendor/known.jar": "PK", "other.jar": "PK" };
		const report = auditReleaseTree(tree(files), { allow: ["vendor/known.jar"] });
		expect(report.findings.map((finding) => finding.path)).toEqual(["other.jar"]);
	});

	it("returns a passing report for a missing directory instead of throwing", () => {
		const report = auditReleaseTree(join(tmpdir(), "cosmic-audit-does-not-exist"));
		expect(report.fileCount).toBe(0);
		expect(report.pass).toBe(true);
	});
});
