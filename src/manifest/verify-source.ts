import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildSourceManifest, ExportSourceError, type ManifestKind, type SourceManifest } from "./export-source.ts";

const execFileP = promisify(execFile);

export interface VerifyResult {
	ok: boolean;
	manifestPath: string;
	kind: ManifestKind;
	ref: string;
	resolvedCommit: string;
	repoPath: string;
	/** True when the rebuild is byte-identical to the recorded manifest. */
	byteIdentical: boolean;
	repoReadonly: {
		headBefore: string;
		headAfter: string;
		statusBefore: string;
		statusAfter: string;
	};
	failures: string[];
}

async function git(repo: string, args: readonly string[]): Promise<string> {
	const { stdout } = await execFileP("git", ["-C", repo, ...args], {
		env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
	});
	return stdout;
}

function isSourceManifest(value: unknown): value is SourceManifest {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		record.schema === "cosmic.source-manifest/1" &&
		typeof record.kind === "string" &&
		typeof record.source === "object" &&
		record.source !== null
	);
}

/**
 * S1.4 reproducibility verification: rebuilds a manifest solely from the ref
 * recorded inside it and byte-compares against the recorded manifest, then
 * proves the source repo was not modified by the whole procedure. This tool
 * performs no writes at all.
 */
export async function verifySourceManifest(repo: string, manifestPath: string): Promise<VerifyResult> {
	const failures: string[] = [];
	const headBefore = (await git(repo, ["rev-parse", "HEAD"])).trim();
	const statusBefore = await git(repo, ["status", "--porcelain"]);

	const raw = await readFile(manifestPath, "utf8");
	let recorded: SourceManifest;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!isSourceManifest(parsed)) {
			throw new ExportSourceError("file does not match schema cosmic.source-manifest/1");
		}
		recorded = parsed;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new ExportSourceError(`cannot read manifest ${manifestPath}: ${detail}`);
	}

	let rebuilt: SourceManifest | undefined;
	try {
		rebuilt = await buildSourceManifest(repo, recorded.source.ref, recorded.kind, {
			write: false,
			confirmation: recorded.confirmation,
			generatedAt: recorded.generatedAt,
		});
	} catch (error) {
		failures.push(`rebuild failed: ${error instanceof Error ? error.message : String(error)}`);
	}

	let byteIdentical = false;
	if (rebuilt !== undefined) {
		byteIdentical = JSON.stringify(rebuilt) === JSON.stringify(recorded);
		if (!byteIdentical) {
			failures.push("rebuilt manifest differs from the recorded manifest");
		}
	}

	const headAfter = (await git(repo, ["rev-parse", "HEAD"])).trim();
	const statusAfter = await git(repo, ["status", "--porcelain"]);
	if (headAfter !== headBefore) {
		failures.push("source repo HEAD changed during verification");
	}
	if (statusAfter !== statusBefore) {
		failures.push("source repo working-tree status changed during verification");
	}

	return {
		ok: failures.length === 0,
		manifestPath,
		kind: recorded.kind,
		ref: recorded.source.ref,
		resolvedCommit: recorded.source.resolvedCommit,
		repoPath: recorded.source.repoPath,
		byteIdentical,
		repoReadonly: { headBefore, headAfter, statusBefore, statusAfter },
		failures,
	};
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
	const manifestPath = positional[1];
	if (repo === undefined || manifestPath === undefined) {
		console.error("usage: node src/manifest/verify-source.ts <repo> <manifest.json>");
		process.exit(2);
	}
	const result = await verifySourceManifest(repo, manifestPath);
	console.log(JSON.stringify(result, null, 3));
	process.exit(result.ok ? 0 : 1);
}
