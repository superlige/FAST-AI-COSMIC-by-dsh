/** Content evidence binding a verified phase to the business sources/classes it observed. */

import { createHash } from "node:crypto";
import { relative, resolve } from "node:path";
import type { KernelContext } from "./context.ts";
import { drain, drainSliced } from "./slices.ts";

export interface FreshnessSnapshot {
	runtimeKeyId: string;
	sourceFingerprint: string;
	classFingerprint: string;
	sourceCount: number;
	fresh: boolean;
	staleFiles: string[];
	capturedAt: string;
	/** 每个文件按 40 行存摘要，定位源码漂移；不把业务源码存进会话。 */
	sourceSections?: Record<string, string[]>;
}

function add(hash: ReturnType<typeof createHash>, path: string, bytes: Uint8Array | null): void {
	hash.update(path);
	hash.update("\0");
	if (bytes === null) hash.update("<missing>");
	else hash.update(bytes);
	hash.update("\0");
}

/**
 * Hashes source and expected top-level class bytes; timestamps only decide stale vs fresh.
 *
 * Synchronous, for callers that are themselves synchronous. On the agent's hot paths use
 * `captureFreshnessAsync`: the same work, the same bytes, yielding to the UI between slices.
 */
export function captureFreshness(ctx: KernelContext): FreshnessSnapshot {
	return drain(freshnessSteps(ctx));
}

/** `captureFreshness` cut into slices (see `slices.ts`); the snapshot is identical. */
export function captureFreshnessAsync(ctx: KernelContext): Promise<FreshnessSnapshot> {
	return drainSliced(freshnessSteps(ctx));
}

/** The capture itself, one source file per step, so the two drivers above share every byte of it. */
function* freshnessSteps(ctx: KernelContext): Generator<void, FreshnessSnapshot, void> {
	const sourceHash = createHash("sha256");
	const classHash = createHash("sha256");
	const staleFiles: string[] = [];
	let sourceCount = 0;
	const sourceSections: Record<string, string[]> = {};

	for (const module of ctx.layout.moduleDirs) {
		const sources = ctx.ports.fs.listJavaFiles(module.src).sort((a, b) => a.localeCompare(b));
		yield;
		for (const source of sources) {
			sourceCount++;
			const projectPath = relative(ctx.projectRoot, source).replace(/\\/g, "/");
			const modulePath = relative(module.src, source);
			const classFile = resolve(module.out, modulePath.replace(/\.java$/, ".class"));
			const bytes = ctx.ports.fs.readBytes(source);
			add(sourceHash, projectPath, bytes);
			const lines = Buffer.from(bytes ?? [])
				.toString("utf8")
				.split(/\r?\n/);
			sourceSections[projectPath] = [];
			for (let i = 0; i < lines.length; i += 40) {
				sourceSections[projectPath].push(
					createHash("sha256")
						.update(lines.slice(i, i + 40).join("\n"))
						.digest("hex")
						.slice(0, 16),
				);
			}
			add(classHash, projectPath.replace(/\.java$/, ".class"), ctx.ports.fs.readBytes(classFile));

			const sourceMs = ctx.ports.fs.mtimeMs(source);
			const classMs = ctx.ports.fs.mtimeMs(classFile);
			if (sourceMs === null || classMs === null || sourceMs > classMs) staleFiles.push(projectPath);
			yield;
		}
	}

	return {
		runtimeKeyId: ctx.runtimeKeyId,
		sourceFingerprint: sourceHash.digest("hex"),
		classFingerprint: classHash.digest("hex"),
		sourceCount,
		fresh: staleFiles.length === 0,
		staleFiles,
		capturedAt: new Date(ctx.ports.clock.now()).toISOString(),
		sourceSections,
	};
}

export function changedSourceSections(
	before: FreshnessSnapshot | undefined,
	after: FreshnessSnapshot,
): { file: string; ranges: string[] }[] {
	if (before?.sourceSections === undefined || after.sourceSections === undefined) return [];
	const oldFiles = before.sourceSections;
	const newFiles = after.sourceSections;
	return [...new Set([...Object.keys(oldFiles), ...Object.keys(newFiles)])].flatMap((file) => {
		const old = oldFiles[file] ?? [];
		const current = newFiles[file] ?? [];
		const ranges: string[] = [];
		for (let i = 0; i < Math.max(old.length, current.length); i++) {
			if (old[i] !== current[i]) ranges.push(`${String(i * 40 + 1)}-${String((i + 1) * 40)}`);
		}
		return ranges.length === 0 ? [] : [{ file, ranges }];
	});
}

export function sameFreshness(left: FreshnessSnapshot, right: FreshnessSnapshot): boolean {
	return (
		left.fresh &&
		right.fresh &&
		left.runtimeKeyId === right.runtimeKeyId &&
		left.sourceFingerprint === right.sourceFingerprint &&
		left.classFingerprint === right.classFingerprint
	);
}
