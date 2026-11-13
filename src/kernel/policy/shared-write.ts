/**
 * The single admission check every shared-metadata write passes through (S5.4).
 *
 * S5.4's brief is "the final side-effecting function checks target, authorization,
 * backup/rollback and the cold-process condition in one place". Before this file
 * those four lived in four different places. Four commands now reach the shared
 * environment (`probe`, `run`'s rollback transaction and `meta`'s two write
 * channels), and four copies of a four-part check is how one of them ends up
 * with three.
 *
 * S14.3.1 removed the second admission source: the frozen CLI's `.cosmic-ai/
 * DRAFT.md`, which `spec action=target` used to write. With the ledger gone
 * there is no file to consult and no command that maintains it, so a caller
 * without an S6 authorization is refused outright. This is a deliberate
 * departure from the frozen CLI, registered in `docs/command-parity.md`.
 *
 * What it checks, and why each one is here rather than somewhere else:
 *
 *   1. TARGET -- the exact target list the user approved, nothing wider.
 *   2. AUTHORIZATION -- an S6 agent grant carries its own confirmation id and is
 *      consumed by the caller before this check.
 *   3. BACKUP / ROLLBACK -- the active authorization carries a non-empty rollback
 *      path into the admission verdict.
 *   4. COLD PROCESS -- `requiresCold` is part of the verdict rather than a rule
 *      each caller remembers. Nobody can guarantee every cache level in a
 *      resident JVM is flushed after a write, and losing that bet means treating
 *      stale state as verified.
 *
 * There is no bypass parameter, for the reason D1 gives: a bypass in a tool
 * schema is filled in the first time a model is refused.
 */

import type { KernelContext } from "../context.ts";
import { err, KernelError, type KernelResult, ok } from "../errors.ts";

export interface SharedWriteAdmission {
	/** The effective allow list handed to IsvGuard as -Dcosmic.targets. */
	targets: string[];
	/** Everything the active authorization confirmed. */
	confirmed: string[];
	/** Rollback paths recorded with those confirmations. */
	rollbacks: string[];
	/** Always true. Carried as a value so the caller asserts it rather than remembers it. */
	requiresCold: true;
	notes: string[];
}

export interface SharedWriteRequest {
	/** S6 agent authorization, captured by an interactive confirmation. There is no other door. */
	authorization: {
		targets: readonly string[];
		rollback: string;
		confirmationId: string;
	};
	/** What is about to write, for the refusal's detail block. */
	operation: string;
}

/** `-Dcosmic.targets=…`, the half of the check IsvGuard performs inside the JVM. */
export function targetProps(admission: SharedWriteAdmission): string[] {
	return [`-Dcosmic.targets=${admission.targets.join(",")}`];
}

export function admitSharedWrite(_ctx: KernelContext, request: SharedWriteRequest): KernelResult<SharedWriteAdmission> {
	const targets = [...new Set(request.authorization.targets)];
	if (
		targets.length === 0 ||
		request.authorization.rollback.trim() === "" ||
		request.authorization.confirmationId === ""
	) {
		return err(
			new KernelError("WRITE_TARGETS_UNCONFIRMED", "一次性授权记录不完整", {
				detail: { operation: request.operation, targets, confirmationId: request.authorization.confirmationId },
				remedy: "重新用 cosmic_authorize 取得用户确认；共享写只有这一条授权路径。",
			}),
		);
	}
	return ok({
		targets,
		confirmed: targets,
		rollbacks: [request.authorization.rollback],
		requiresCold: true,
		notes: [
			// "放行 N 个目标" was read as "good for N writes". What bounds the number
			// of writes is the confirmed change list the agent layer holds (S18), one
			// item per entry into a write tool; this line only says which objects.
			`用户确认 ${request.authorization.confirmationId} 放行 ${targets.length} 个目标；本次写入是确认清单里的一项`,
			`回滚路径：${request.authorization.rollback}`,
			"清单外的对象 IsvGuard 会当场拒绝；要改别的必须重新请求用户确认。",
		],
	});
}
