/**
 * Release artifact audit (S2.4). Proves that a built cosmic release contains no
 * Cosmic runtime JAR, no customer config and no credential material. This runs
 * in the build so a regression fails the build rather than shipping.
 *
 * The check is over the artifact tree, not over the source tree: an embedded
 * resource that slipped through findResourceViolations, a stray copy in dist/,
 * and a bundler that inlined a file all show up here and nowhere else.
 */
import { type Dirent, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export interface AuditFinding {
	/** Path relative to the audited root, forward slashes. */
	path: string;
	rule: string;
	why: string;
	bytes: number;
}

export interface AuditRule {
	rule: string;
	pattern: RegExp;
	why: string;
}

/**
 * Forbidden shapes. Cosmic JARs are the load-bearing rule (D10/D12: the runtime
 * belongs to the user, and shipping it would pin every user to one version);
 * the rest keep customer data and secrets out of a distributable file.
 */
export const RELEASE_RULES: readonly AuditRule[] = [
	{ rule: "cosmic-jar", pattern: /\.jar$/i, why: "发行物不得包含任何 JAR —— 苍穹 JAR 只能来自用户当前运行时" },
	{ rule: "customer-config", pattern: /(^|\/)config\.json$/i, why: "发行物不得包含客户配置" },
	{ rule: "customer-evidence", pattern: /(^|\/)\.cosmic-ai(\/|$)/i, why: "发行物不得包含客户交付证据" },
	{ rule: "dotenv", pattern: /(^|\/)\.env(\.|$)/i, why: "发行物不得包含环境/凭据文件" },
	{ rule: "key-material", pattern: /\.(p12|pfx|pem|key|keystore|jks)$/i, why: "发行物不得包含密钥材料" },
];

export interface AuditOptions {
	/** Extra rules for a specific release shape. */
	rules?: readonly AuditRule[];
	/** Paths (relative, forward slashes) exempted with a recorded reason. Keep empty by default. */
	allow?: readonly string[];
}

export interface AuditReport {
	root: string;
	fileCount: number;
	findings: AuditFinding[];
	pass: boolean;
}

function listFiles(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string): void => {
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const abs = join(dir, entry.name);
			if (entry.isDirectory()) walk(abs);
			else out.push(abs);
		}
	};
	walk(root);
	return out;
}

export function auditReleaseTree(root: string, options: AuditOptions = {}): AuditReport {
	const rules = [...RELEASE_RULES, ...(options.rules ?? [])];
	const allow = new Set(options.allow ?? []);
	const files = listFiles(root);
	const findings: AuditFinding[] = [];

	for (const abs of files) {
		const rel = relative(root, abs).split(sep).join("/");
		if (allow.has(rel)) continue;
		for (const rule of rules) {
			if (!rule.pattern.test(rel)) continue;
			let bytes = -1;
			try {
				bytes = statSync(abs).size;
			} catch {
				bytes = -1;
			}
			findings.push({ path: rel, rule: rule.rule, why: rule.why, bytes });
			break;
		}
	}

	return { root, fileCount: files.length, findings, pass: findings.length === 0 };
}

export function formatAuditReport(report: AuditReport): string {
	const header = `产物审计 ${report.root}：${report.fileCount} 个文件，${report.findings.length} 项违规`;
	if (report.pass) return `${header}\nPASS`;
	const lines = report.findings.map(
		(finding) => `  [${finding.rule}] ${finding.path} (${finding.bytes} bytes) — ${finding.why}`,
	);
	return `${header}\n${lines.join("\n")}\nFAIL`;
}
