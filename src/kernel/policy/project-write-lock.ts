/** Cross-process, project-scoped serialization for class and shared-environment writes. */

import { randomUUID } from "node:crypto";
import type { KernelContext } from "../context.ts";
import { err, KernelError, type KernelResult } from "../errors.ts";

export interface ProjectWriteLockManifest {
	version: 1;
	token: string;
	pid: number;
	runtimeKeyId: string;
	operation: string;
	acquiredAt: string;
}

/** Parses a lock manifest; null covers both "absent" and "unreadable". */
export function parseLockManifest(raw: string): ProjectWriteLockManifest | null {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed === null || typeof parsed !== "object") return null;
		const value = parsed as Partial<ProjectWriteLockManifest>;
		if (
			value.version !== 1 ||
			typeof value.token !== "string" ||
			typeof value.pid !== "number" ||
			typeof value.runtimeKeyId !== "string" ||
			typeof value.operation !== "string" ||
			typeof value.acquiredAt !== "string"
		) {
			return null;
		}
		return value as ProjectWriteLockManifest;
	} catch {
		return null;
	}
}

/** The lock this project currently holds, or null when the file is absent/corrupt. */
export function readLockManifest(ctx: KernelContext): ProjectWriteLockManifest | null {
	const raw = ctx.ports.fs.read(ctx.layout.projectWriteLock);
	return raw === "" ? null : parseLockManifest(raw);
}

/**
 * Acquires one atomic file for the whole project, not one per RuntimeKey.
 *
 * Stale or corrupt locks still fail closed here: this path never deletes a lock
 * it did not create, because a read-then-delete can remove a lock another
 * process acquired in between. Clearing crash residue is a separate, explicit
 * action that quarantines the file by atomic rename first
 * (policy/write-lock-recovery.ts).
 */
export async function withProjectWriteLock<T>(
	ctx: KernelContext,
	operation: string,
	work: () => Promise<KernelResult<T>>,
): Promise<KernelResult<T>> {
	const manifest: ProjectWriteLockManifest = {
		version: 1,
		token: randomUUID(),
		pid: ctx.ports.proc.currentPid(),
		runtimeKeyId: ctx.runtimeKeyId,
		operation,
		acquiredAt: new Date(ctx.ports.clock.now()).toISOString(),
	};
	const lockFile = ctx.layout.projectWriteLock;
	if (!ctx.ports.fs.tryCreate(lockFile, JSON.stringify(manifest))) {
		const owner = readLockManifest(ctx);
		const live = owner === null ? null : ctx.ports.proc.isAlive(owner.pid);
		return err(
			new KernelError("PROJECT_WRITE_LOCKED", "工程正在被另一个 cosmic 写操作占用", {
				detail: {
					lockFile,
					ownerToken: owner?.token ?? null,
					ownerPid: owner?.pid ?? null,
					ownerRuntimeKeyId: owner?.runtimeKeyId ?? null,
					ownerOperation: owner?.operation ?? null,
					ownerLive: live,
				},
				remedy:
					live === false
						? "锁的进程已经不在（多半是上一个窗口崩了）。核对 ownerToken/ownerPid 后用 cosmic_doctor action=lock token=<锁上的 token> 显式回收，不要手删锁文件：回收会连带作废本次的 class 新鲜度证据。"
						: "等待占用者完成后重试；不要并行编译或写同一工程。",
			}),
		);
	}

	try {
		return await work();
	} finally {
		const current = readLockManifest(ctx);
		if (current?.token === manifest.token) ctx.ports.fs.remove(lockFile);
	}
}
