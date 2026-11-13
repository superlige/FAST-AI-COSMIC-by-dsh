/**
 * Crash residue for the project write lock (S4.4).
 *
 * A lock file outlives the process that made it. When an agent window is killed
 * mid-`fast` -- or the machine goes down mid-APPLY -- the file stays, and every
 * later write on that project is refused with PROJECT_WRITE_LOCKED forever. So
 * recovery has to exist. What it must not become is an automatic sweep: the
 * cheap version reads the manifest, decides the owner is dead and deletes the
 * path, and that sequence can delete a lock a different window acquired between
 * the read and the delete. The window is small and the failure is silent -- two
 * javac runs writing the same class directory, which is exactly what the lock
 * exists to prevent.
 *
 * Two properties close that:
 *
 *   1. The caller must name the token it saw. A recovery is always "clear THIS
 *      lock", never "clear whatever is there now".
 *   2. The file is taken out of the way by an atomic rename before anything is
 *      deleted. After the rename, the path is free for a new owner, and what is
 *      in hand is the exact bytes that were moved -- which are then verified and
 *      only then deleted. A lock that turns out to belong to someone else is put
 *      back.
 *
 * This is a correctness boundary, not a permission boundary. The agent's general
 * Shell is deliberately not restricted (D1), so nothing here stops a model that
 * decides to delete the file itself; what it does is make the supported path the
 * one that also invalidates the evidence the crashed operation was about to
 * produce.
 */

import { randomUUID } from "node:crypto";
import type { KernelContext } from "../context.ts";
import { err, KernelError, type KernelResult, ok } from "../errors.ts";
import { captureFreshness, type FreshnessSnapshot } from "../freshness.ts";
import { isOwnLiveServer, readManifest } from "../probe/server.ts";
import { type ProjectWriteLockManifest, parseLockManifest } from "./project-write-lock.ts";

/** Token a caller passes to recover a lock whose manifest cannot be parsed. */
export const CORRUPT_LOCK_TOKEN = "<corrupt>";

export interface WriteLockInspection {
	lockFile: string;
	present: boolean;
	/** Null when the lock is absent or its manifest is unreadable. */
	manifest: ProjectWriteLockManifest | null;
	corrupt: boolean;
	/** Null when there is no manifest to name a pid. */
	ownerLive: boolean | null;
	ownerIsThisProcess: boolean;
	/** Null when there is no manifest; false means another runtime locked this project. */
	ownerSameRuntimeKey: boolean | null;
	ageMs: number | null;
	/** Token to pass to recoverProjectWriteLock, or null when nothing is recoverable. */
	recoveryToken: string | null;
	recoverable: boolean;
	reason: string;
}

export interface WriteLockRecovery {
	lockFile: string;
	recovered: ProjectWriteLockManifest | null;
	corrupt: boolean;
	/** State of the project's sources and classes once the crashed writer is gone. */
	freshness: FreshnessSnapshot;
	/** Whether a resident JVM of this RuntimeKey survived the crash. */
	residentJvm: "own-live" | "foreign-or-unknown" | "none";
	/** What the caller still has to do; recovery clears the lock, not the residue. */
	followUp: string[];
}

/**
 * Reads the lock without touching it. Safe to call in any phase, including while
 * another window legitimately holds the lock.
 */
export function inspectProjectWriteLock(ctx: KernelContext): WriteLockInspection {
	const lockFile = ctx.layout.projectWriteLock;
	const raw = ctx.ports.fs.read(lockFile);
	if (raw === "" && !ctx.ports.fs.exists(lockFile)) {
		return {
			lockFile,
			present: false,
			manifest: null,
			corrupt: false,
			ownerLive: null,
			ownerIsThisProcess: false,
			ownerSameRuntimeKey: null,
			ageMs: null,
			recoveryToken: null,
			recoverable: false,
			reason: "工程没有写锁，不需要恢复。",
		};
	}

	const manifest = parseLockManifest(raw);
	if (manifest === null) {
		return {
			lockFile,
			present: true,
			manifest: null,
			corrupt: true,
			ownerLive: null,
			ownerIsThisProcess: false,
			ownerSameRuntimeKey: null,
			ageMs: null,
			recoveryToken: CORRUPT_LOCK_TOKEN,
			recoverable: true,
			// A manifest nobody can parse names no owner, so waiting for that owner is
			// waiting forever. It is still not deleted implicitly: the caller asks.
			reason: `锁文件存在但读不出归属（内容已损坏）。确认没有正在跑的 cosmic 写操作后，用 token ${CORRUPT_LOCK_TOKEN} 回收。`,
		};
	}

	const ownerLive = ctx.ports.proc.isAlive(manifest.pid);
	const acquiredMs = Date.parse(manifest.acquiredAt);
	const ageMs = Number.isNaN(acquiredMs) ? null : Math.max(0, ctx.ports.clock.now() - acquiredMs);
	return {
		lockFile,
		present: true,
		manifest,
		corrupt: false,
		ownerLive,
		ownerIsThisProcess: manifest.pid === ctx.ports.proc.currentPid(),
		ownerSameRuntimeKey: manifest.runtimeKeyId === ctx.runtimeKeyId,
		ageMs,
		recoveryToken: ownerLive ? null : manifest.token,
		recoverable: !ownerLive,
		reason: ownerLive
			? `锁由仍在运行的进程 ${manifest.pid} 持有（操作 ${manifest.operation}）。等它结束，不要回收。`
			: `锁的持有进程 ${manifest.pid} 已经不在（操作 ${manifest.operation}），是崩溃残留，可以按 token 回收。`,
	};
}

/**
 * Clears one specific stale lock. Refuses a live owner, refuses a token that is
 * not the one currently on disk, and never deletes bytes it did not first move
 * out of the way.
 */
export function recoverProjectWriteLock(ctx: KernelContext, input: { token: string }): KernelResult<WriteLockRecovery> {
	const lockFile = ctx.layout.projectWriteLock;
	const inspection = inspectProjectWriteLock(ctx);

	if (!inspection.present) {
		return err(
			new KernelError("WRITE_LOCK_ABSENT", "工程没有写锁，没什么可恢复的", {
				detail: { lockFile },
				remedy: "直接重试原来的写操作即可。",
			}),
		);
	}
	if (inspection.manifest !== null && inspection.ownerLive === true) {
		return err(
			new KernelError("WRITE_LOCK_OWNER_ALIVE", `锁的持有进程 ${inspection.manifest.pid} 还活着，不回收`, {
				detail: {
					lockFile,
					ownerPid: inspection.manifest.pid,
					ownerOperation: inspection.manifest.operation,
					ownerRuntimeKeyId: inspection.manifest.runtimeKeyId,
					ownerIsThisProcess: inspection.ownerIsThisProcess,
				},
				remedy: "等占用者结束再重试；强行回收会让两个 javac 同时写同一份 class。",
			}),
		);
	}
	if (input.token !== inspection.recoveryToken) {
		return err(
			new KernelError("WRITE_LOCK_TOKEN_MISMATCH", "给的 token 不是锁上的那一个，拒绝回收", {
				detail: { lockFile, expected: inspection.recoveryToken, given: input.token },
				remedy: "先重新查一次锁，用当前 token 回收；token 对不上说明锁在这期间被换过。",
			}),
		);
	}

	// Move first, look second: after the rename the path is free, and whatever is
	// deleted afterwards is the exact file this call took, not whatever a racing
	// window may have created in the meantime.
	const quarantine = `${lockFile}.recovered-${randomUUID()}`;
	if (!ctx.ports.fs.tryRename(lockFile, quarantine)) {
		return err(
			new KernelError("WRITE_LOCK_RECOVERY_FAILED", "锁文件移不走，未做任何删除", {
				detail: { lockFile, quarantine },
				remedy: "多半是锁文件正被占用或权限不足；确认没有 cosmic 进程在写这个工程后重试。",
			}),
		);
	}

	const moved = parseLockManifest(ctx.ports.fs.read(quarantine));
	const movedToken = moved === null ? CORRUPT_LOCK_TOKEN : moved.token;
	if (movedToken !== input.token) {
		// The lock changed between the inspection and the rename: this is somebody
		// else's live lock. Put it back rather than deleting a lock in use.
		const restored = ctx.ports.fs.tryRename(quarantine, lockFile);
		return err(
			new KernelError("WRITE_LOCK_TOKEN_MISMATCH", "锁在回收过程中被换过，已放回，未删除", {
				detail: { lockFile, expected: input.token, found: movedToken, restored, quarantine },
				remedy: restored
					? "重新查锁再决定；刚才那一瞬有别的窗口拿到了锁。"
					: `锁没能放回原位，内容还在 ${quarantine}；确认无人持有后手工核对。`,
			}),
		);
	}

	ctx.ports.fs.remove(quarantine);

	const freshness = captureFreshness(ctx);
	const serverManifest = readManifest(ctx);
	const residentJvm: WriteLockRecovery["residentJvm"] = isOwnLiveServer(ctx, serverManifest)
		? "own-live"
		: serverManifest === null
			? "none"
			: "foreign-or-unknown";

	const followUp: string[] = [];
	// The lock is gone; the half-finished work it was protecting is not. Recovery
	// that only says "unlocked" is how a partial compile gets verified as if it
	// had finished.
	if (!freshness.fresh) {
		followUp.push(
			`崩溃的写操作留下 ${freshness.staleFiles.length} 个源码/class 不一致项，先跑 cosmic_fast 重编，不要直接验证。`,
		);
	}
	if (moved?.operation.startsWith("probe:")) {
		followUp.push(
			`中断的是写探针 ${moved.operation}，共享环境可能只写了一半；用只读探针核对目标对象状态后再决定是否重放或回滚。`,
		);
	}
	if (residentJvm === "own-live") {
		followUp.push(
			"本 RuntimeKey 的常驻 JVM 还在跑，里面可能是崩溃前的旧类；下次用它之前会先把变了的类换进去，换不进去就重启。",
		);
	}
	if (followUp.length === 0) followUp.push("锁已清理，工程源码与 class 一致，可以直接重试原操作。");

	return ok({
		lockFile,
		recovered: moved,
		corrupt: moved === null,
		freshness,
		residentJvm,
		followUp,
	});
}
