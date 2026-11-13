/**
 * Versioned runtime cache (S2.3/S2.4, D10). Every runtime-scoped artifact lives
 * under a directory named by the RuntimeKey id, so two different runtimes can
 * never share a class directory, a socket, a PID file or a JVM.
 *
 * The stored manifest carries the full RuntimeKey parts, not just the id. That
 * is what makes an invalidation report able to say WHICH dimension changed
 * (see diffRuntimeKey) instead of only that the cache was stale, and it is what
 * lets orphan reclamation identify whose JVM a leftover PID belongs to rather
 * than killing whatever holds a port.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { diffRuntimeKey, type RuntimeKey, type RuntimeKeyDiff, type RuntimeKeyParts } from "./runtime-key.ts";

export interface CacheLayout {
	/** Root of this RuntimeKey's cache. Everything below is inside it. */
	root: string;
	/** Compiled probe classes for this runtime. */
	classesDir: string;
	/** Released agent-owned probe/runtime sources. */
	resourcesDir: string;
	/** Manifest describing which runtime owns this directory. */
	manifestFile: string;
	/** Resident JVM identity file. Never a bare port file: see reclaim rules in D10. */
	jvmManifestFile: string;
}

export function cacheLayout(cacheRoot: string, key: RuntimeKey): CacheLayout {
	const root = join(cacheRoot, key.id);
	return {
		root,
		classesDir: join(root, "classes"),
		resourcesDir: join(root, "resources"),
		manifestFile: join(root, "runtime-key.json"),
		jvmManifestFile: join(root, "jvm.json"),
	};
}

export interface CacheManifest {
	schema: "cosmic.runtime-cache/1";
	keyId: string;
	parts: RuntimeKeyParts;
	writtenAt: string;
}

export interface JvmManifest {
	schema: "cosmic.resident-jvm/1";
	/** The RuntimeKey this JVM belongs to. A PID alone is not an identity. */
	keyId: string;
	pid: number;
	/** Socket path or named pipe. Derived from the key id, never from a fixed port. */
	socket: string;
	startedAt: string;
}

/**
 * Socket identity derived from the RuntimeKey. A fixed port would make two
 * projects collide, and reclamation by port would kill an unrelated instance --
 * explicitly forbidden by D10.
 */
export function socketNameFor(key: RuntimeKey): string {
	return `cosmic-${key.id}`;
}

export async function readCacheManifest(layout: CacheLayout): Promise<CacheManifest | null> {
	const raw = await readFile(layout.manifestFile, "utf8").catch(() => null);
	if (raw === null) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed === null || typeof parsed !== "object") return null;
		const record = parsed as Partial<CacheManifest>;
		if (record.schema !== "cosmic.runtime-cache/1" || typeof record.keyId !== "string" || !record.parts) return null;
		return record as CacheManifest;
	} catch {
		// A corrupt manifest is treated as "no cache", never as "cache is fine":
		// the failure mode of the opposite choice is running against stale classes.
		return null;
	}
}

export async function writeCacheManifest(
	layout: CacheLayout,
	key: RuntimeKey,
	now = new Date(),
): Promise<CacheManifest> {
	const manifest: CacheManifest = {
		schema: "cosmic.runtime-cache/1",
		keyId: key.id,
		parts: key.parts,
		writtenAt: now.toISOString(),
	};
	await mkdir(layout.root, { recursive: true });
	await writeFile(layout.manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
	return manifest;
}

export type CacheStatus =
	| { state: "fresh"; layout: CacheLayout; manifest: CacheManifest }
	| { state: "absent"; layout: CacheLayout; manifest: null; diff: null }
	| { state: "stale"; layout: CacheLayout; manifest: CacheManifest; diff: RuntimeKeyDiff };

/**
 * Decides whether the cache for this RuntimeKey can be reused.
 *
 * "absent" and "stale" are kept distinct because they mean different things to
 * the user: absent is a cold start, stale means something about their machine
 * or project changed and the report names what. A same-id directory whose
 * stored parts disagree is treated as stale rather than trusted -- the id is a
 * truncated digest, and trusting it blindly would be the one place where a
 * collision turns into wrong classes instead of a rebuild.
 */
export async function inspectCache(cacheRoot: string, key: RuntimeKey): Promise<CacheStatus> {
	const layout = cacheLayout(cacheRoot, key);
	const manifest = await readCacheManifest(layout);
	if (manifest === null) return { state: "absent", layout, manifest: null, diff: null };
	const diff = diffRuntimeKey(manifest.parts, key.parts);
	if (!diff.same || manifest.keyId !== key.id) {
		return { state: "stale", layout, manifest, diff: diff.same ? { same: false, changed: ["agentVersion"] } : diff };
	}
	return { state: "fresh", layout, manifest };
}

export async function readJvmManifest(layout: CacheLayout): Promise<JvmManifest | null> {
	const raw = await readFile(layout.jvmManifestFile, "utf8").catch(() => null);
	if (raw === null) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed === null || typeof parsed !== "object") return null;
		const record = parsed as Partial<JvmManifest>;
		if (record.schema !== "cosmic.resident-jvm/1" || typeof record.pid !== "number") return null;
		return record as JvmManifest;
	} catch {
		return null;
	}
}

export async function writeJvmManifest(
	layout: CacheLayout,
	key: RuntimeKey,
	pid: number,
	now = new Date(),
): Promise<JvmManifest> {
	const manifest: JvmManifest = {
		schema: "cosmic.resident-jvm/1",
		keyId: key.id,
		pid,
		socket: socketNameFor(key),
		startedAt: now.toISOString(),
	};
	await mkdir(layout.root, { recursive: true });
	await writeFile(layout.jvmManifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
	return manifest;
}

/**
 * Whether a leftover JVM manifest may be reclaimed by this runtime. Reclamation
 * requires the manifest to name this exact RuntimeKey: a PID recorded by
 * another runtime is never killed, because on a developer machine that PID may
 * by now belong to something else entirely.
 */
export function mayReclaim(manifest: JvmManifest | null, key: RuntimeKey): boolean {
	return manifest !== null && manifest.keyId === key.id;
}
