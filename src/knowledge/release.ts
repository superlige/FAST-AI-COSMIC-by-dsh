/**
 * Releasing the embedded knowledge snapshot onto disk (S7.0, D13).
 *
 * Why disk at all, when the pack is already in the binary: pi skills address
 * their body by absolute `location` path and the model opens them with `read`,
 * and the knowledge tools hand the model file paths it can go back to. A
 * knowledge base that only exists inside the process cannot be cited.
 *
 * Why the snapshot id and NOT the RuntimeKey: knowledge does not depend on the
 * user's JARs, JDK, classpath or project. Scoping it by RuntimeKey the way probe
 * classes are scoped would re-release 6 MB every time a JAR changed and keep one
 * copy per project per runtime, for content that is identical in all of them. The
 * snapshot id is the right identity here -- it changes exactly when the documents
 * change, which is the only thing that can invalidate this cache.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sha256 } from "../runtime/fingerprint.ts";
import type { KnowledgeSnapshot } from "./pack.ts";

export const KNOWLEDGE_STAMP_SCHEMA = "cosmic.knowledge-release/1";

export interface KnowledgeLayout {
	/** Root of this snapshot's release. */
	root: string;
	/** The knowledge tree itself: arch/, platform/, requirements/. */
	docsDir: string;
	/** Records which snapshot this directory holds. */
	stampFile: string;
}

/**
 * Two snapshots use this machinery: the official knowledge base and the generated
 * `reference/` skills (S7.1). They are released side by side rather than merged
 * because they have different lifetimes -- the official one changes when app-build
 * ships, ours when the frozen ref moves -- and a shared directory would make
 * "which snapshot is stale" unanswerable.
 */
export interface KnowledgeLayoutOptions {
	/** Cache namespace. "knowledge" for the official snapshot, "reference" for the skills. */
	namespace?: string;
	/** Directory the documents land in, inside the snapshot root. */
	docsDirName?: string;
}

export function knowledgeLayout(
	cacheRoot: string,
	snapshotId: string,
	options: KnowledgeLayoutOptions = {},
): KnowledgeLayout {
	const root = join(cacheRoot, options.namespace ?? "knowledge", snapshotId);
	return { root, docsDir: join(root, options.docsDirName ?? "cosmic"), stampFile: join(root, "snapshot.json") };
}

export interface KnowledgeStamp {
	schema: typeof KNOWLEDGE_STAMP_SCHEMA;
	snapshotId: string;
	bundleVersion: string;
	docCount: number;
	writtenAt: string;
}

export interface KnowledgeReleaseResult {
	layout: KnowledgeLayout;
	snapshotId: string;
	bundleVersion: string;
	docCount: number;
	/** True when the stamp already matched and no document was rewritten. */
	reused: boolean;
	/** Documents written in this run. Zero on a reused release. */
	written: number;
}

async function readStamp(layout: KnowledgeLayout): Promise<KnowledgeStamp | null> {
	const raw = await readFile(layout.stampFile, "utf8").catch(() => null);
	if (raw === null) return null;
	try {
		const parsed = JSON.parse(raw) as Partial<KnowledgeStamp>;
		if (parsed.schema !== KNOWLEDGE_STAMP_SCHEMA || typeof parsed.snapshotId !== "string") return null;
		return parsed as KnowledgeStamp;
	} catch {
		// A corrupt stamp means "not released", never "released and fine": the
		// opposite choice would leave the model reading a half-written tree.
		return null;
	}
}

/**
 * Releases the snapshot if it is not already on disk.
 *
 * The stamp is the fast path and it is deliberately coarse: unlike
 * releaseResources, which re-verifies all 55 probe sources on every open, this
 * does not re-hash 1,763 documents on every start. The cost asymmetry is the
 * whole reason -- a drifted probe source silently changes what gets compiled and
 * must be caught before every build, while a drifted knowledge document changes
 * what a human reads and is caught by verifyKnowledgeRelease, which `doctor`
 * runs. Putting a 6 MB verification on the startup path would buy little and be
 * paid for constantly.
 */
export async function releaseKnowledge(
	cacheRoot: string,
	snapshot: KnowledgeSnapshot,
	options: KnowledgeLayoutOptions = {},
): Promise<KnowledgeReleaseResult> {
	const { snapshotId, bundleVersion, files } = snapshot.header;
	const layout = knowledgeLayout(cacheRoot, snapshotId, options);

	const stamp = await readStamp(layout);
	if (stamp !== null && stamp.snapshotId === snapshotId && stamp.docCount === files.length) {
		return { layout, snapshotId, bundleVersion, docCount: files.length, reused: true, written: 0 };
	}

	let written = 0;
	const madeDirs = new Set<string>();
	for (const file of files) {
		const target = join(layout.docsDir, ...file.path.split("/"));
		const dir = dirname(target);
		if (!madeDirs.has(dir)) {
			await mkdir(dir, { recursive: true });
			madeDirs.add(dir);
		}
		const content = snapshot.read(file.path);
		if (content === null) continue;
		await writeFile(target, content, "utf8");
		written += 1;
	}

	// The stamp goes last, on purpose: an interrupted release leaves no stamp and
	// is redone, instead of being reported as complete with documents missing.
	const next: KnowledgeStamp = {
		schema: KNOWLEDGE_STAMP_SCHEMA,
		snapshotId,
		bundleVersion,
		docCount: files.length,
		writtenAt: new Date().toISOString(),
	};
	await writeFile(layout.stampFile, `${JSON.stringify(next, null, 2)}\n`, "utf8");

	return { layout, snapshotId, bundleVersion, docCount: files.length, reused: false, written };
}

export interface KnowledgeVerification {
	ok: boolean;
	checked: number;
	/** Documents whose on-disk text no longer matches the snapshot, or is gone. */
	drifted: readonly string[];
}

/**
 * Full verification of a released tree against the snapshot. This is what
 * `doctor` calls -- the deliberate counterpart to the cheap stamp check above.
 */
export async function verifyKnowledgeRelease(
	layout: KnowledgeLayout,
	snapshot: KnowledgeSnapshot,
): Promise<KnowledgeVerification> {
	const drifted: string[] = [];
	for (const file of snapshot.header.files) {
		const target = join(layout.docsDir, ...file.path.split("/"));
		const actual = await readFile(target, "utf8").catch(() => null);
		if (actual === null || sha256(actual) !== file.sha256) drifted.push(file.path);
	}
	return { ok: drifted.length === 0, checked: snapshot.header.files.length, drifted };
}
