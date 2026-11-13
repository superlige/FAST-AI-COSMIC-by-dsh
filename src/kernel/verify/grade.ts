/**
 * 断言判定：一次运行的 `[PROBE-JSON]` 记录 → 过 / 不过 / 没断言 / 出错。
 *
 * Moved here verbatim from `cases/model.ts` in S22.1.1. The case set is being
 * retired, but this judgement is not: it is what separates 「跑通了」 from
 * 「验过了」, and after S22 it is the only thing standing between an edit and a
 * delivery receipt. Keeping it inside the module that is about to be deleted
 * would have made the deletion a rewrite of the gate itself.
 *
 * **Grading reads the `[PROBE-JSON]` bypass and nothing else.** Never the human
 * prose: those lines change wording whenever someone improves a message, and a
 * regex over them breaks silently -- the run would go green because the parser
 * stopped finding assertions, which is the worst failure this file could have.
 *
 * Pure logic over values. Nothing here starts a JVM, which is the point: if this
 * 判定 could only be exercised by running a real probe, then on a machine that
 * cannot reach Cosmic not a single line of it would ever be checked.
 */

import type { ProbeJsonRecord } from "../probe/output.ts";

/**
 * How one unit of work ended.
 *
 * `EXECUTED` is the load-bearing one: it is the verdict for a run that finished
 * cleanly without asserting anything, and S22's whole gate rests on it not being
 * confused with `PASS`.
 */
export type AssertResult = "PASS" | "FAIL" | "EXECUTED" | "ERROR";

/** Worst result wins: one red makes the whole thing red. */
const RANK: Record<AssertResult, number> = { PASS: 0, EXECUTED: 1, FAIL: 2, ERROR: 3 };
export const worst = (results: readonly AssertResult[]): AssertResult =>
	results.reduce<AssertResult>((acc, result) => (RANK[result] > RANK[acc] ? result : acc), "PASS");

export interface GradedAssert {
	kind: string | null;
	target: string | null;
	expect: unknown;
	actual: unknown;
	pass: boolean;
	why: string | null;
}

export interface Grade {
	asserts: GradedAssert[];
	result: AssertResult;
	/** The adapter's own one-line scenario summary, when it emitted one. */
	scenario: string | null;
}

/**
 * Grades one unit of work against a run's bypass records.
 *
 * `attributeAll` is for adapters that own a whole process (run / probe): those
 * probes predate the `case` field and do not emit one, so ownership is settled
 * by how they were invoked. Grouped runs must instead match the record's own
 * `case` field.
 *
 * Three rules, in this order:
 *   1. any failing assertion -> FAIL. **The records are the authority**; the
 *      exit code only separates ERROR from EXECUTED.
 *   2. no assertions at all -> exit 0 is EXECUTED, non-zero is ERROR.
 *   3. otherwise PASS.
 *
 * Rule 2 is the whole orchestration gate: a run with no business assertion is
 * not a verification, and gets recorded as "it executed" and nothing more.
 */
export function grade(
	id: string,
	records: readonly ProbeJsonRecord[],
	exitCode: number,
	options: { attributeAll?: boolean } = {},
): Grade {
	const attributeAll = options.attributeAll === true;
	const mine = records.filter((record) => record.t === "assert" && (attributeAll || record.case === id));
	const scenarioRecord = records.find((record) => record.t === "scenario" && (attributeAll || record.case === id));
	const asserts: GradedAssert[] = mine.map((record) => ({
		kind: (record.kind as string | undefined) ?? null,
		target: (record.target as string | undefined) ?? null,
		expect: record.expect ?? null,
		actual: record.actual ?? null,
		pass: record.pass === true,
		why: (record.why as string | undefined) ?? null,
	}));
	let result: AssertResult;
	if (asserts.some((entry) => !entry.pass)) result = "FAIL";
	else if (asserts.length === 0) result = exitCode === 0 ? "EXECUTED" : "ERROR";
	else result = "PASS";
	const scenario =
		scenarioRecord === undefined
			? null
			: ((scenarioRecord.desc as string | undefined) ?? (scenarioRecord.text as string | undefined) ?? null);
	return { asserts, result, scenario };
}
