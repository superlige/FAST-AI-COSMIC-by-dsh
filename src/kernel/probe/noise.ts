/**
 * 「这条警告我上次是不是已经判断过了」—— 同一环境上反复出现的平台异常，记一次账。
 *
 * Why this exists. `output.ts` already folds the unattributed stacks a Cosmic
 * cold start prints, and it is careful to say that folded is not the same claim
 * as proven unrelated. That sentence is honest and it is also the problem: it
 * puts the same judgement in front of the reader on **every single run**. On the
 * real ledger (2026-09-14) every `cosmic_run` of the round carried the same two
 * missing UDF classes, the same `LicenseGrayConfigHelper` NPEs and the same
 * 「24 组 / 1184 行栈帧」line, and each one cost a fresh "do I have to care about
 * this?" before it could be dismissed.
 *
 * What is recorded is a **count, not a verdict**. A group seen twelve times on
 * this RuntimeKey is ambient background of this environment; that makes it
 * unlikely to be about the change under test, and it still does not prove it.
 * So the degraded line says how often it has been seen and where the full text
 * is, and it never says "unrelated".
 *
 * Scoped to the RuntimeKey because that is what "this environment" means here:
 * the same project pointed at another account set is a different set of
 * background exceptions, and carrying counts across would answer
 * 「这个环境一直这样吗」with another environment's history.
 */

import { sha256 } from "../../runtime/fingerprint.ts";
import type { KernelContext } from "../context.ts";
import type { RuntimeExceptionGroup } from "./output.ts";

/** One fingerprint's history on this RuntimeKey. */
export interface NoiseEntry {
	/** How many probe runs have carried it, this one included. */
	seen: number;
	/** ISO timestamp of the first run that carried it. */
	firstAt: string;
	lastAt: string;
	/** A human label for the degraded line, so the ledger is readable on its own. */
	label: string;
}

export interface NoiseLedger {
	kind: "NoiseLedger";
	runtimeKeyId: string;
	entries: Record<string, NoiseEntry>;
}

/** Ledger entries kept. Least recently seen are dropped first; this is a cache, not evidence. */
const LEDGER_LIMIT = 300;

/**
 * Strips the parts of an exception line that change between two runs of the very
 * same defect: ids, timestamps, row counts, temp paths.
 *
 * Without this every `NullPointerException` carrying a different primary key in
 * its message is a brand new fingerprint, the ledger never accumulates a count,
 * and nothing is ever recognised as ambient -- the mechanism quietly does
 * nothing while looking like it works.
 */
function normalize(text: string): string {
	return text
		.replace(/\b0x[0-9a-f]+\b/gi, "#")
		.replace(/\b\d[\d,.:_-]{3,}\b/g, "#")
		.replace(/[A-Za-z]:[\\/][^\s"']+/g, "#path")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 300);
}

/** An `at` frame minus its `(File.java:12)` tail: the same defect moves lines between builds. */
function frameKey(frame: string): string {
	return frame.replace(/^\s*at\s+/, "").replace(/\([^)]*\)\s*$/, "");
}

/**
 * A stable id for one folded exception group.
 *
 * Built from the exception classes and the innermost call site, never from the
 * ERROR log header alone: the header carries the thread and the request id, so
 * two prints of one defect would never match.
 */
export function noiseFingerprint(group: RuntimeExceptionGroup): string {
	const parts = [
		normalize(group.exception),
		...group.causes.map(normalize),
		...group.innerFrames.map(frameKey),
	].filter((part) => part !== "");
	// A group with neither an exception line nor a frame is a bare stack fragment;
	// the header is all there is, and normalising it beats one shared fingerprint
	// for everything shapeless.
	if (parts.length === 0) parts.push(normalize(group.header));
	return sha256(parts.join("\n")).slice(0, 16);
}

/** The one-line name shown in the degraded block. */
export function noiseLabel(group: RuntimeExceptionGroup): string {
	const root = group.causes[group.causes.length - 1] ?? group.exception;
	const head = normalize(root === "" ? group.header : root).slice(0, 120);
	const first = group.innerFrames[0];
	return first === undefined ? head : `${head} @ ${frameKey(first)}`;
}

function ledgerFile(ctx: KernelContext): string {
	const safe = ctx.runtimeKeyId.replace(/[^\w.-]+/g, "_");
	return `${ctx.layout.workDir}/noise/${safe}.json`;
}

function readLedger(ctx: KernelContext): NoiseLedger {
	const empty: NoiseLedger = { kind: "NoiseLedger", runtimeKeyId: ctx.runtimeKeyId, entries: {} };
	const file = ledgerFile(ctx);
	if (!ctx.ports.fs.exists(file)) return empty;
	try {
		const parsed = JSON.parse(ctx.ports.fs.read(file)) as NoiseLedger;
		// Somebody else's JSON at our path, or a ledger copied in from another
		// RuntimeKey: neither answers 「这个环境一直这样吗」, so start the count over
		// rather than report another environment's history as this one's.
		if (parsed?.kind !== "NoiseLedger" || parsed.runtimeKeyId !== ctx.runtimeKeyId) return empty;
		return { ...empty, entries: parsed.entries ?? {} };
	} catch {
		return empty;
	}
}

/**
 * True when this project's own code appears anywhere in the group.
 *
 * Such a group is never degraded however often it has been seen. A stack that
 * runs through our plugin and is swallowed by the platform is exactly the kind
 * of repeat offender worth reading every time -- 「它一直这样」 is the sentence
 * that hides a real defect for weeks.
 */
export function touchesOwnCode(group: RuntimeExceptionGroup, ownPackages: readonly string[]): boolean {
	const text = [group.header, group.exception, ...group.causes, ...group.innerFrames].join("\n");
	return ownPackages.some((prefix) => prefix !== "" && text.includes(prefix));
}

/** What the current run's summary needs to know about a group's history. */
export interface NoiseHistory {
	/** Runs that carried it BEFORE this one. Always >= 1 when a history is returned. */
	seen: number;
	firstAt: string;
}

/**
 * Looks every folded group up in this RuntimeKey's ledger, then writes this run
 * back into it.
 *
 * The returned lookup reflects the ledger **as it was before this run**, so the
 * first appearance of a group reports no history and keeps the full treatment.
 * Counting first and reading after would make every group look familiar,
 * including the one that just started happening.
 *
 * 「以前见过没有」只查运行前存下的那份账（S37 2-C.1）。以前边查边写：同一次运行打印两遍的异常，
 * 第二遍查到第一遍刚写进去的记录，第一次出现就被说成「此前 1 次运行都带着它」——09-22 造数撞主键
 * 就这样被当成了背景噪声。
 */
export function recordNoise(
	ctx: KernelContext,
	groups: readonly RuntimeExceptionGroup[],
	ownPackages: readonly string[] = [],
): (group: RuntimeExceptionGroup) => NoiseHistory | null {
	if (groups.length === 0) return () => null;
	const ledger = readLedger(ctx);
	const earlier: Readonly<Record<string, NoiseEntry>> = { ...ledger.entries };
	const before = new Map<string, NoiseHistory>();
	const at = new Date(ctx.ports.clock.now()).toISOString();
	const bumped = new Set<string>();

	for (const group of groups) {
		const id = noiseFingerprint(group);
		const known = earlier[id];
		if (known !== undefined && !before.has(id)) before.set(id, { seen: known.seen, firstAt: known.firstAt });
		// One run bumps a fingerprint by one however many copies of it that run
		// printed: the count answers 「几次运行里出现过」, and three identical NPEs in
		// one cold start are one observation, not three.
		if (bumped.has(id)) continue;
		bumped.add(id);
		ledger.entries[id] = {
			seen: (known?.seen ?? 0) + 1,
			firstAt: known?.firstAt ?? at,
			lastAt: at,
			label: known?.label ?? noiseLabel(group),
		};
	}

	const kept = Object.entries(ledger.entries)
		.sort((a, b) => b[1].lastAt.localeCompare(a[1].lastAt))
		.slice(0, LEDGER_LIMIT);
	const file = ledgerFile(ctx);
	try {
		ctx.ports.fs.mkdirp(file.slice(0, file.lastIndexOf("/")));
		ctx.ports.fs.write(file, `${JSON.stringify({ ...ledger, entries: Object.fromEntries(kept) }, null, "\t")}\n`);
	} catch {
		// A cache that cannot be written must not fail the run it was observing:
		// next time simply starts the count again.
	}

	return (group) => {
		if (touchesOwnCode(group, ownPackages)) return null;
		return before.get(noiseFingerprint(group)) ?? null;
	};
}
