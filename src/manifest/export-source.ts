import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/** Source scopes of the one-time migration (recorded in kernel/FORK.md and manifests/). Paths are ref-side pathspecs. */
export const CODE_SCOPE = ["driver.mjs", "config.mjs", "tools", "probes", "runtime"] as const;
export const KNOWLEDGE_SCOPE = ["reference"] as const;
/**
 * protocol/ is absent from the 5.1 table but is a real migration input: it holds
 * the authoritative field definitions for TaskSpec/ProjectProfile/VerifyResult/
 * DeliveryBundle that S6 (D4) consumes. Its sibling half of the same protocol pair
 * (reference/delivery-protocol.md) is already frozen by the knowledge manifest, so
 * leaving protocol/ unfrozen would freeze one half and let the other drift.
 * Recorded as an S1.1 decision; see cosmic/kernel/FORK.md.
 */
export const PROTOCOL_SCOPE = ["protocol"] as const;

/** 5.1 explicitly excludes these from migration; recorded as disposition "excluded". */
export const EXCLUDED_TOP_LEVEL = [
	".gitignore",
	"README.md",
	"SKILL.md",
	"CLAUDE.md",
	"config.example.json",
	"docs",
	"scratchpad",
] as const;

export type ManifestKind = "code" | "knowledge" | "protocol";

/** Every kind's scope, so one manifest can attribute a directory to another kind. */
export const SCOPES: Readonly<Record<ManifestKind, readonly string[]>> = {
	code: CODE_SCOPE,
	knowledge: KNOWLEDGE_SCOPE,
	protocol: PROTOCOL_SCOPE,
};

export interface SourceFileEntry {
	path: string;
	bytes: number;
	/** Line count for text files; null for binary content. */
	lines: number | null;
	sha256: string;
	gitSha1: string;
}

export interface TopLevelDisposition {
	name: string;
	disposition: ManifestKind | "excluded" | "unclassified";
	reason: string;
}

export interface SourceManifest {
	schema: "cosmic.source-manifest/1";
	kind: ManifestKind;
	source: { repoPath: string; ref: string; resolvedCommit: string };
	confirmation: { confirmedBy: string; confirmedAt: string; note: string };
	generatedAt: string;
	scope: readonly string[];
	files: SourceFileEntry[];
	topLevelDispositions: TopLevelDisposition[];
	unclassified: string[];
	totals: { files: number; bytes: number; lines: number };
}

export interface ExportOptions {
	/** When false (default), nothing is written and the manifest is returned for review. */
	write: boolean;
	/** Required when write is true. Records who confirmed the migration input. */
	confirmation?: { confirmedBy: string; confirmedAt: string; note: string };
	/** Optional deterministic timestamp (S1.4 reproducible rebuilds pass a fixed value). */
	generatedAt?: string;
	/** Optional directory to materialize the exported file tree. */
	outTree?: string;
}

export class ExportSourceError extends Error {}

async function git(repo: string, args: readonly string[], encoding?: "buffer"): Promise<string | Buffer> {
	try {
		const { stdout } = await execFileP("git", ["-C", repo, ...args], {
			maxBuffer: 64 * 1024 * 1024,
			...(encoding === "buffer" ? { encoding: "buffer" as const } : {}),
			// Read-side hardening: never take index/fscache locks in the source repo.
			env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
		});
		return stdout;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new ExportSourceError(`git ${args.join(" ")} failed in ${repo}: ${detail}`);
	}
}

/** Resolves a ref to a full commit SHA. Refuses ambiguous or missing refs. */
export async function resolveCommit(repo: string, ref: string): Promise<string> {
	const out = await git(repo, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
	const sha = String(out).trim();
	if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(sha)) {
		throw new ExportSourceError(`ref ${ref} did not resolve to a commit: ${sha}`);
	}
	return sha;
}

function countLines(content: Buffer): number | null {
	if (content.includes(0)) return null;
	const text = content.toString("utf8");
	if (text.length === 0) return 0;
	return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

interface LsTreeEntry {
	gitSha1: string;
	path: string;
}

async function lsTree(repo: string, ref: string, pathspecs: readonly string[]): Promise<LsTreeEntry[]> {
	const out = String(await git(repo, ["ls-tree", "-r", "--long", ref, ...pathspecs]));
	const entries: LsTreeEntry[] = [];
	for (const line of out.split("\n")) {
		if (line.trim().length === 0) continue;
		// Format: <mode> SP <type> SP <sha> SP <size padded> TAB <path>
		const match = /^\d{6}\s+blob\s+([0-9a-f]{40,64})\s+\d+\t(.*)$/.exec(line);
		if (match === null) continue;
		entries.push({ gitSha1: match[1] ?? "", path: match[2] ?? "" });
	}
	return entries;
}

async function topLevelNames(repo: string, ref: string): Promise<string[]> {
	const out = String(await git(repo, ["ls-tree", "--name-only", ref]));
	return out
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

function dispositionFor(name: string, kind: ManifestKind, scope: readonly string[]): TopLevelDisposition {
	if ((scope as readonly string[]).includes(name)) {
		return { name, disposition: kind, reason: `listed in ${kind} scope` };
	}
	// A directory owned by another kind is frozen by that kind's manifest, not an
	// open question: reporting it as unclassified here would bury the entries that
	// genuinely need a human decision.
	for (const other of Object.keys(SCOPES) as ManifestKind[]) {
		if (other !== kind && SCOPES[other].includes(name)) {
			return { name, disposition: other, reason: `covered by the ${other} manifest` };
		}
	}
	if ((EXCLUDED_TOP_LEVEL as readonly string[]).includes(name)) {
		return { name, disposition: "excluded", reason: "excluded by IMPLEMENTATION.md 5.1" };
	}
	return { name, disposition: "unclassified", reason: "not covered by 5.1 scope table; explicit decision required" };
}

/**
 * Builds a source manifest strictly from a committed ref: only git object
 * database reads (rev-parse, ls-tree, cat-file) are executed; the working
 * tree is never consulted, so uncommitted changes cannot leak into the
 * manifest. Nothing is written unless options.write is set with a
 * confirmation record.
 */
export async function buildSourceManifest(
	repo: string,
	ref: string,
	kind: ManifestKind,
	options: ExportOptions = { write: false },
): Promise<SourceManifest> {
	const repoAbs = resolve(repo);
	if (options.write && options.confirmation === undefined) {
		throw new ExportSourceError("writing a manifest requires a confirmation record (confirmedBy/confirmedAt/note)");
	}
	const resolvedCommit = await resolveCommit(repoAbs, ref);
	const scope = SCOPES[kind];

	const entries = await lsTree(repoAbs, resolvedCommit, scope);
	const files: SourceFileEntry[] = [];
	for (const entry of entries) {
		const content = (await git(repoAbs, ["cat-file", "blob", entry.gitSha1], "buffer")) as Buffer;
		files.push({
			path: entry.path,
			bytes: content.length,
			lines: countLines(content),
			sha256: createHash("sha256").update(content).digest("hex"),
			gitSha1: entry.gitSha1,
		});
		if (options.outTree !== undefined) {
			const target = join(resolve(options.outTree), entry.path);
			await mkdir(dirname(target), { recursive: true });
			await writeFile(target, content);
		}
	}
	files.sort((a, b) => a.path.localeCompare(b.path));

	const topNames = await topLevelNames(repoAbs, resolvedCommit);
	const topLevelDispositions = topNames.map((name) => dispositionFor(name, kind, scope));
	const unclassified = topLevelDispositions.filter((d) => d.disposition === "unclassified").map((d) => d.name);

	return {
		schema: "cosmic.source-manifest/1",
		kind,
		source: { repoPath: repoAbs, ref, resolvedCommit },
		confirmation: options.confirmation ?? {
			confirmedBy: "",
			confirmedAt: "",
			note: "dry-run: migration input not confirmed",
		},
		generatedAt: options.generatedAt ?? new Date().toISOString(),
		scope: [...scope],
		files,
		topLevelDispositions,
		unclassified,
		totals: {
			files: files.length,
			bytes: files.reduce((sum, file) => sum + file.bytes, 0),
			lines: files.reduce((sum, file) => sum + (file.lines ?? 0), 0),
		},
	};
}

/** Writes the manifest JSON to outDir/<kind>-source.json. */
export async function writeManifest(manifest: SourceManifest, outDir: string): Promise<string> {
	const dir = resolve(outDir);
	await mkdir(dir, { recursive: true });
	const target = join(dir, `${manifest.kind}-source.json`);
	await writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
	return target;
}

const isCli = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
	const args = process.argv.slice(2);
	const positional = args.filter((arg, index) => {
		if (arg.startsWith("--")) return false;
		if (index === 0) return true;
		const previous = args[index - 1];
		return previous === undefined || !previous.startsWith("--");
	});
	const repo = positional[0];
	const ref = positional[1];
	if (repo === undefined || ref === undefined) {
		console.error(
			"usage: node src/manifest/export-source.ts <repo> <ref> [--kind code|knowledge|protocol|all] [--write --confirmed-by NAME --note TEXT] [--out-dir DIR] [--out-tree DIR]",
		);
		process.exit(2);
	}
	const kindIndex = args.indexOf("--kind");
	const kindFlag = kindIndex >= 0 ? args[kindIndex + 1] : "all";
	const allKinds: ManifestKind[] = ["code", "knowledge", "protocol"];
	const kinds: ManifestKind[] =
		kindFlag !== undefined && (allKinds as string[]).includes(kindFlag) ? [kindFlag as ManifestKind] : allKinds;
	const write = args.includes("--write");
	const outDirIndex = args.indexOf("--out-dir");
	const outDir = outDirIndex >= 0 ? (args[outDirIndex + 1] ?? "manifests") : "manifests";
	const outTreeIndex = args.indexOf("--out-tree");
	const outTree = outTreeIndex >= 0 ? args[outTreeIndex + 1] : undefined;
	const confirmedByIndex = args.indexOf("--confirmed-by");
	const noteIndex = args.indexOf("--note");

	for (const kind of kinds) {
		const confirmation = write
			? {
					confirmedBy: confirmedByIndex >= 0 ? (args[confirmedByIndex + 1] ?? "") : "",
					confirmedAt: new Date().toISOString(),
					note: noteIndex >= 0 ? (args[noteIndex + 1] ?? "") : "",
				}
			: undefined;
		const manifest = await buildSourceManifest(repo, ref, kind, { write, confirmation, outTree });
		if (write) {
			const path = await writeManifest(manifest, outDir);
			console.log(`wrote ${path}: ${manifest.totals.files} files, ${manifest.totals.lines} lines`);
		} else {
			console.log(
				`dry-run ${kind}: ${manifest.totals.files} files, ${manifest.totals.lines} lines, unclassified: ${manifest.unclassified.join(", ") || "none"}`,
			);
		}
	}
}
