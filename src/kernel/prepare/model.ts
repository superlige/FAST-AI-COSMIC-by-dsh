/**
 * The one shape every expensive Cosmic tool computes before it spends a process.
 *
 * Before S15.5 each tool had its own near-copy of this: `RunPreparation` carried
 * `plan/blockers/warnings/capsules`, `ProbePreparation` carried the same four
 * plus its own flattened plan fields, `fast` had no prepare at all and simply
 * returned at the first gate it hit, and `preflight` invented a third vocabulary
 * (`what`/`fix` instead of `message`/`remedy`). Four dialects meant four
 * different answers to the same two questions a caller actually has: what is
 * wrong, and what did you NOT get to check.
 *
 * The contract:
 *
 * - `blockers.length > 0` forbids execution, whatever `plan` says. A tool may
 *   still publish a plan alongside blockers when it has one (probe resolves its
 *   target before it can even read the source it then refuses); a caller must
 *   never read that as permission.
 * - `deferred` is the honest half. A check that could not run because a fact was
 *   missing is NOT a pass, and a prepare that listed only `blockers` would be
 *   claiming coverage it does not have (S15 §4.4).
 * - `retryInput` comes from parsed facts only. A value the model must supply and
 *   the harness cannot derive leaves it `null`; inventing one produces a call
 *   that looks structured and is wrong.
 * - `estimatedCost` is what EXECUTION would spend, so it is zero whenever
 *   blockers stand. Work prepare itself already did (a doc/JAR join, a source
 *   read) is not a prediction and does not belong here.
 */

import type { KnowledgeCapsule } from "../../knowledge/capsule.ts";
import { KernelError, type KernelErrorCode, type KernelErrorDetail } from "../errors.ts";

export interface PrepareBlocker {
	code: string;
	message: string;
	remedy: string;
	/**
	 * The facts this check consumed, when it needed more than the arguments.
	 *
	 * It is what makes `deferred` verifiable: the same fact names appear on both
	 * sides, so "checked against the current JAR" and "never got to look at the
	 * JAR" stop being indistinguishable prose.
	 */
	dependsOn?: readonly string[];
	detail?: Readonly<Record<string, unknown>>;
}

/**
 * A check that did NOT run, and the fact it was waiting on.
 *
 * Project unreadable means the JAR cannot be reflected; argv that never parsed
 * means the side-effect scan has no target to look for. Those are not clean
 * results and must not be reported as ones.
 */
export interface PrepareDeferred {
	/** The check that was skipped. */
	check: string;
	/** The facts it needed and did not get. */
	dependsOn: readonly string[];
	reason: string;
}

/** What execution would spend, not what prepare already spent. */
export interface PrepareCost {
	processes: number;
	coldStarts: number;
}

export interface PrepareResult<TPlan> {
	plan: TPlan | null;
	blockers: PrepareBlocker[];
	warnings: string[];
	capsules: KnowledgeCapsule[];
	deferred: PrepareDeferred[];
	/** A complete, structured next call derived from parsed facts, or null. */
	retryInput: unknown | null;
	estimatedCost: PrepareCost;
}

export const FREE: PrepareCost = { processes: 0, coldStarts: 0 };

/** A prepare with nothing computed yet; every field explicit so none is forgotten. */
export function emptyPrepare<TPlan>(overrides: Partial<PrepareResult<TPlan>> = {}): PrepareResult<TPlan> {
	return {
		plan: null,
		blockers: [],
		warnings: [],
		capsules: [],
		deferred: [],
		retryInput: null,
		estimatedCost: FREE,
		...overrides,
	};
}

/** True when execution is allowed: no blocker stands. Deferred checks do not block. */
export function isExecutable(prepared: PrepareResult<unknown>): boolean {
	return prepared.blockers.length === 0;
}

export interface PrepareRefusal<C extends string = string> {
	code: C;
	message: string;
	detail: Record<string, unknown>;
	remedy: string;
}

function blockerDetail(blocker: PrepareBlocker): Record<string, unknown> {
	return {
		code: blocker.code,
		message: blocker.message,
		remedy: blocker.remedy,
		...(blocker.dependsOn === undefined ? {} : { dependsOn: [...blocker.dependsOn] }),
		...(blocker.detail === undefined ? {} : { detail: blocker.detail }),
	};
}

function headlineOf(headline: string, prepared: PrepareResult<unknown>): string {
	return (
		`${headline}：${String(prepared.blockers.length)} 个阻碍（已全部列出，一次改完）` +
		(prepared.deferred.length === 0
			? ""
			: `，另有 ${String(prepared.deferred.length)} 项因前置事实缺失未计算（不算通过）`)
	);
}

/**
 * The whole remedy in one string: fix every blocker, know what was not checked,
 * and -- when prepare could derive it -- send `nextCall` verbatim.
 */
export function prepareRemedy(prepared: PrepareResult<unknown>): string {
	return [
		...prepared.blockers.map((blocker) => `[${blocker.code}] ${blocker.remedy}`),
		...(prepared.deferred.length === 0
			? []
			: [
					`本次未计算：${prepared.deferred
						.map((item) => `${item.check}（缺 ${item.dependsOn.join("、")}）`)
						.join("；")}`,
				]),
		...(prepared.retryInput === null ? [] : ["修好后按 detail.nextCall 给出的参数照抄重调一次即可。"]),
	].join("；");
}

/**
 * `KernelErrorDetail` form: flat scalars and string arrays only.
 *
 * The kernel's own error channel is deliberately flat (it is serialised into
 * audit logs and CLI output), so blockers and deferred checks are rendered one
 * line each rather than dropped down to their codes -- the remedy text is the
 * half a caller acts on, and the pre-S15 version threw it away.
 */
export function prepareErrorDetail(prepared: PrepareResult<unknown>, extra: KernelErrorDetail = {}): KernelErrorDetail {
	return {
		blockers: prepared.blockers.map((blocker) => `${blocker.code}\t${blocker.message}\t${blocker.remedy}`),
		warnings: prepared.warnings,
		...(prepared.deferred.length === 0
			? {}
			: {
					deferred: prepared.deferred.map((item) => `${item.check}\t${item.dependsOn.join(",")}\t${item.reason}`),
				}),
		processes: prepared.estimatedCost.processes,
		coldStarts: prepared.estimatedCost.coldStarts,
		...(prepared.retryInput === null ? {} : { nextCall: JSON.stringify(prepared.retryInput) }),
		...extra,
	};
}

/** The kernel-side refusal: one `KernelError` carrying everything prepare knows. */
export function prepareKernelError(
	code: KernelErrorCode,
	headline: string,
	prepared: PrepareResult<unknown>,
	extra: KernelErrorDetail = {},
): KernelError {
	return new KernelError(code, headlineOf(headline, prepared), {
		detail: prepareErrorDetail(prepared, extra),
		remedy: prepareRemedy(prepared),
	});
}

/**
 * The agent-side refusal, whose detail may nest.
 *
 * Deliberately not "the first thing that went wrong". The cost S15 is paying
 * down is the caller fixing one blocker, spending a round trip, and only then
 * being told about the second one that was computable all along.
 */
export function prepareRefusal<C extends string>(
	code: C,
	headline: string,
	prepared: PrepareResult<unknown>,
	extra: Record<string, unknown> = {},
): PrepareRefusal<C> {
	return {
		code,
		message: headlineOf(headline, prepared),
		detail: {
			blockers: prepared.blockers.map(blockerDetail),
			warnings: prepared.warnings,
			...(prepared.deferred.length === 0
				? {}
				: { deferred: prepared.deferred.map((item) => ({ ...item, dependsOn: [...item.dependsOn] })) }),
			estimatedCost: prepared.estimatedCost,
			...(prepared.retryInput === null ? {} : { nextCall: prepared.retryInput }),
			...extra,
		},
		remedy: prepareRemedy(prepared),
	};
}
