/**
 * What is known about the metadata snapshot since it was built, kept in two small
 * files beside it so recording a check never rewrites the multi-megabyte index:
 *
 *   meta-check.json    the last change check and what it did (S17 4.4/4.5)
 *   meta-pending.json  metadata this machine wrote and no check has covered yet (S17 4.6)
 */

import type { KernelContext } from "../context.ts";
import type { MetaCheck, MetaPending } from "./model.ts";

export const metaCheckFile = (ctx: KernelContext): string => `${ctx.layout.impactWork}/meta-check.json`;
const pendingFile = (ctx: KernelContext): string => `${ctx.layout.impactWork}/meta-pending.json`;

export function readJsonFile<T>(ctx: KernelContext, file: string): T | null {
	if (!ctx.ports.fs.exists(file)) return null;
	try {
		return JSON.parse(ctx.ports.fs.read(file)) as T;
	} catch {
		return null;
	}
}

/**
 * This machine wrote metadata: the snapshot is behind by at least those objects.
 * Recorded on the spot so every reader says so, and so the next refresh runs even
 * if this session already checked once.
 */
export function markMetaPending(ctx: KernelContext, probeName: string, targets: readonly string[]): void {
	try {
		const at = new Date(ctx.ports.clock.now()).toISOString();
		const before = metaPending(ctx);
		const writes = [...(before?.writes ?? []), { at, probe: probeName, targets: [...targets] }].slice(-20);
		ctx.ports.fs.mkdirp(ctx.layout.impactWork);
		ctx.ports.fs.write(pendingFile(ctx), JSON.stringify({ at, writes } satisfies MetaPending));
	} catch {
		// A marker that cannot be written leaves the snapshot exactly as stale as it was; the write itself succeeded.
	}
}

/** Metadata written on this machine and not yet covered by a check or a rebuild. */
export function metaPending(ctx: KernelContext): MetaPending | null {
	return readJsonFile<MetaPending>(ctx, pendingFile(ctx));
}

/** Drops the pending marker when everything it records was written before `coveredAt`. */
export function settleMetaPending(ctx: KernelContext, coveredAt: string): void {
	const pending = metaPending(ctx);
	if (pending !== null && pending.at <= coveredAt) ctx.ports.fs.remove(pendingFile(ctx));
}

export function recordMetaCheck(ctx: KernelContext, check: MetaCheck): void {
	ctx.ports.fs.mkdirp(ctx.layout.impactWork);
	ctx.ports.fs.write(metaCheckFile(ctx), JSON.stringify(check));
	if (check.state === "same" || check.state === "patched") settleMetaPending(ctx, check.at);
}

/**
 * Whether a session should check the snapshot now: once per session, and again
 * whenever this machine wrote metadata after the last check started.
 */
export function metaCheckDue(lastCheckAt: string | undefined, pending: MetaPending | null): boolean {
	if (lastCheckAt === undefined) return true;
	return pending !== null && pending.at > lastCheckAt;
}
