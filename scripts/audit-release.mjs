// S2.4 release artifact audit. Fails the build when a release tree contains a
// Cosmic JAR, customer config, evidence or key material.
//   node scripts/audit-release.mjs [dir]   (default: dist)
import { existsSync } from "node:fs";
import process from "node:process";
import { auditReleaseTree, formatAuditReport } from "../src/runtime/release-audit.ts";

const root = process.argv[2] ?? "dist";

if (!existsSync(root)) {
	console.error(`产物审计跳过：${root} 不存在。先跑 npm run build。`);
	process.exit(2);
}

const report = auditReleaseTree(root);
console.log(formatAuditReport(report));
process.exit(report.pass ? 0 : 1);
