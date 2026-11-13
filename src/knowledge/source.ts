/**
 * Which knowledge base is in force (S7.0, D13 criterion 3).
 *
 * The inversion this module implements: the embedded snapshot is the DEFAULT
 * truth source, and `knowledgeRoot` drops from "must be configured" to "optional
 * override". In the frozen implementation an unconfigured knowledgeRoot meant
 * `fast` refused to compile plugin code at all; that gate loses its premise once
 * the knowledge ships with the product.
 *
 * Two rules follow from D13 and are the whole reason this is a module rather
 * than an if-statement:
 *
 *   1. Embedding does not excuse hiding the source. `doctor` and `knowledge
 *      status` must report whether the embedded snapshot or an override is in
 *      force AND the app-build version of each, so "which documents is the model
 *      actually reading" is never a guess.
 *   2. A configured-but-unusable override is reported, never silent. It also does
 *      not brick the agent: a typo in config.json degrades to the embedded
 *      snapshot with the reason stated. Failing hard would trade a wrong-version
 *      answer for no answer at all, which is the worse of the two.
 *
 * The override contract is deliberately unchanged from the frozen
 * resolveKnowledgeRoot: knowledgeRoot points directly at `knowledge/cosmic`,
 * proven by three entry files, with the bundle version found by climbing toward
 * a CHANGELOG. Users' existing config.json keeps working.
 */
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Entry files that prove a directory really is a Cosmic knowledge root. Ported verbatim from the frozen ref. */
export const KNOWLEDGE_REQUIRED_ENTRIES = [
	"platform/standards.md",
	"platform/scenes/_index.md",
	"platform/api/api-index.md",
] as const;

/** How far to climb looking for the bundle CHANGELOG. Matches the frozen findAppBuildVersion. */
const VERSION_SEARCH_DEPTH = 6;

export interface KnowledgeFilePort {
	read(absolutePath: string): string;
	isDirectory(absolutePath: string): boolean;
	isFile(absolutePath: string): boolean;
}

export const nodeKnowledgeFileSystem: KnowledgeFilePort = {
	read(absolutePath) {
		try {
			return readFileSync(absolutePath, "utf8");
		} catch {
			return "";
		}
	},
	isDirectory(absolutePath) {
		try {
			return statSync(absolutePath).isDirectory();
		} catch {
			return false;
		}
	},
	isFile(absolutePath) {
		try {
			return statSync(absolutePath).isFile();
		} catch {
			return false;
		}
	},
};

export type OverrideProblemKind = "missing-path" | "not-directory" | "incomplete";

export interface OverrideProblem {
	kind: OverrideProblemKind;
	root: string;
	message: string;
	/** Which required entry files were absent. Empty unless kind is "incomplete". */
	missing: readonly string[];
}

export interface KnowledgeSourceFacts {
	/** app-build bundle version, or null when it could not be determined. */
	bundleVersion: string | null;
	/** Snapshot digest. Only the embedded snapshot has one; an override is a live directory. */
	snapshotId: string | null;
	docCount: number | null;
}

export interface KnowledgeSourceStatus {
	kind: "embedded" | "override";
	/** Directory documents are read from. For the embedded snapshot this is the released cache dir. */
	root: string;
	/** Facts about the source actually in force. */
	inForce: KnowledgeSourceFacts;
	/** Facts about the embedded snapshot, reported even when an override wins (D13 criterion 3). */
	embedded: KnowledgeSourceFacts;
	/**
	 * Why a configured override was not used. Null when no override was configured
	 * or when it was accepted. Never omitted from reports.
	 */
	overrideProblem: OverrideProblem | null;
}

/**
 * The bundle version of an override directory. Climbs because knowledgeRoot
 * points at knowledge/cosmic while the CHANGELOG sits at the bundle root.
 */
export function findBundleVersion(root: string, fs: KnowledgeFilePort): string | null {
	let current = resolve(root);
	for (let depth = 0; depth < VERSION_SEARCH_DEPTH; depth += 1) {
		const changelog = join(current, "CHANGELOG.md");
		if (fs.isFile(changelog)) {
			const match = /^##\s+\[?v?(\d+\.\d+\.\d+)\]?/m.exec(fs.read(changelog));
			if (match?.[1]) return match[1];
		}
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return null;
}

export interface OverrideCheck {
	root: string;
	bundleVersion: string | null;
	problem: OverrideProblem | null;
}

/** Validates a configured override without deciding anything. */
export function checkKnowledgeOverride(configuredRoot: string, fs: KnowledgeFilePort): OverrideCheck {
	const root = resolve(configuredRoot);
	if (!fs.isDirectory(root)) {
		const kind: OverrideProblemKind = fs.isFile(root) ? "not-directory" : "missing-path";
		return {
			root,
			bundleVersion: null,
			problem: {
				kind,
				root,
				missing: [],
				message: kind === "not-directory" ? "配置路径不是目录" : "配置目录不存在",
			},
		};
	}
	const missing = KNOWLEDGE_REQUIRED_ENTRIES.filter((entry) => !fs.isFile(join(root, ...entry.split("/"))));
	if (missing.length > 0) {
		// The frozen hint is kept because it fixes the single most common mistake:
		// pointing at the bundle root instead of at knowledge/cosmic inside it.
		const suggested = join(root, "knowledge", "cosmic");
		const looksNested = KNOWLEDGE_REQUIRED_ENTRIES.every((entry) => fs.isFile(join(suggested, ...entry.split("/"))));
		const hint = looksNested ? `；应改为 ${suggested}` : "；knowledgeRoot 必须直接指向 knowledge/cosmic";
		return {
			root,
			bundleVersion: null,
			problem: { kind: "incomplete", root, missing, message: `缺少必需入口 ${missing.join(", ")}${hint}` },
		};
	}
	return { root, bundleVersion: findBundleVersion(root, fs), problem: null };
}

export interface ResolveKnowledgeSourceInput {
	/** KernelConfig.knowledgeRoot. Null when unconfigured, which is now the normal case. */
	configuredRoot: string | null;
	/** Where the embedded snapshot was released to, and what it says about itself. */
	embedded: { root: string; bundleVersion: string; snapshotId: string; docCount: number };
}

/**
 * Picks the knowledge source. Embedded wins unless a usable override is
 * configured; an unusable override loses but is always reported.
 */
export function resolveKnowledgeSource(
	input: ResolveKnowledgeSourceInput,
	fs: KnowledgeFilePort,
): KnowledgeSourceStatus {
	const embedded: KnowledgeSourceFacts = {
		bundleVersion: input.embedded.bundleVersion,
		snapshotId: input.embedded.snapshotId,
		docCount: input.embedded.docCount,
	};
	if (input.configuredRoot === null || input.configuredRoot === "") {
		return { kind: "embedded", root: input.embedded.root, inForce: embedded, embedded, overrideProblem: null };
	}
	const check = checkKnowledgeOverride(input.configuredRoot, fs);
	if (check.problem !== null) {
		return {
			kind: "embedded",
			root: input.embedded.root,
			inForce: embedded,
			embedded,
			overrideProblem: check.problem,
		};
	}
	return {
		kind: "override",
		root: check.root,
		// docCount is left null rather than counted: an override is a live directory
		// the user maintains, and walking it on every resolve would put a filesystem
		// crawl on the startup path for a number nothing branches on.
		inForce: { bundleVersion: check.bundleVersion, snapshotId: null, docCount: null },
		embedded,
		overrideProblem: null,
	};
}

/** One-line summaries for doctor / knowledge status. Both sources always named. */
export function describeKnowledgeSource(status: KnowledgeSourceStatus): string[] {
	const version = (facts: KnowledgeSourceFacts): string => facts.bundleVersion ?? "版本未知";
	const lines: string[] = [];
	if (status.kind === "embedded") {
		lines.push(
			`知识库：内嵌快照 app-build ${version(status.embedded)}` +
				`（${status.embedded.docCount ?? "?"} 篇，快照 ${(status.embedded.snapshotId ?? "").slice(0, 12)}）`,
		);
	} else {
		lines.push(`知识库：外部覆盖 ${status.root}，app-build ${version(status.inForce)}`);
		lines.push(
			`  内嵌快照仍在产物里：app-build ${version(status.embedded)}（${status.embedded.docCount ?? "?"} 篇），本次未使用`,
		);
	}
	if (status.overrideProblem !== null) {
		lines.push(`  已配置 COSMIC_KNOWLEDGE_ROOT 但未生效：${status.overrideProblem.message}`);
		lines.push("  本次已回退到内嵌快照。这是降级，不是正常状态。");
	}
	return lines;
}
