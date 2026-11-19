/**
 * Two facts every `knowledge` report repeats that the model cannot act on (S15).
 *
 * Both are Windows absolute paths, which is what makes them worth a pass of
 * their own: inside one `JSON.stringify` every separator is written `\\`, so the
 * field nobody reads is also the one paying double for its own punctuation.
 *
 * 1. `source.root` -- where the snapshot was unpacked. Measured at 18 escaped
 *    separators on every single answer, in a `status` report that is 652 bytes
 *    whole. The two facts beside it that DO change a decision (which snapshot
 *    won, and whether a configured override was rejected) are a version string
 *    and a message. `status` keeps the whole line, because "which documents am I
 *    actually reading" is that action's entire question.
 *
 * 2. `file` beside a `relativePath` -- the same document named twice, once in
 *    the form the follow-up call takes and once in the form it does not: `show`
 *    accepts relative paths and refuses anything that leaves the knowledge root.
 *    Measured on `search query=DynamicObject limit=10`: 1,743 of 6,028 bytes,
 *    29% of the answer, spent on paths that cannot be passed to anything.
 *
 * Model-facing only, and the same split `withoutRenderedTwin` keeps for the same
 * reason: `details.result` still carries both, so the audit trail and any
 * non-context reader of a result lose nothing.
 */
import type { CosmicToolName } from "./names.ts";

/** Matches `scan` in observed-anchors: deep enough for every report shape, bounded. */
const MAX_DEPTH = 6;

/**
 * Drops a `file` that sits beside a `relativePath`, wherever it appears.
 *
 * Written as a rule about the pair rather than as a list of positions -- `show`
 * carries it at the top level, `search` once per result, `plugin` on the guide
 * and on every chosen page -- so a new document-bearing action does not have to
 * remember to opt in.
 */
function dropRedundantFiles(value: unknown, depth = 0): unknown {
	if (depth > MAX_DEPTH || value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) {
		let changed = false;
		const items = value.map((item) => {
			const next = dropRedundantFiles(item, depth + 1);
			if (next !== item) changed = true;
			return next;
		});
		return changed ? items : value;
	}
	const record = value as Record<string, unknown>;
	const redundant = typeof record.relativePath === "string" && typeof record.file === "string";
	let changed = redundant;
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(record)) {
		if (redundant && key === "file") continue;
		const next = dropRedundantFiles(item, depth + 1);
		if (next !== item) changed = true;
		out[key] = next;
	}
	return changed ? out : value;
}

/** `search` 每条结果里模型用不上的：`relativePath` 就是 `show` 去掉 `#标题`，分数和行号不改变下一步怎么做。 */
const SEARCH_HIT_UNUSED = new Set(["relativePath", "score", "lines"]);
/** `search` 回复顶层模型用不上的：回显的查询和选项是它自己刚发的；`route` 只是改道提示的理由，改道时提示里已经写了。 */
const SEARCH_TOP_UNUSED = new Set(["query", "options", "route"]);

/**
 * S45 批 6：`search` 的回复只留模型下一步要用的。真实查询 20 条回放里，同一个路径写两遍约 6 KB，
 * 分数、行号、回显约 4 KB，不改变它接下来 show 哪一块、读不读。`details.result` 照留全量。
 */
function trimSearch(record: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(record)) {
		if (SEARCH_TOP_UNUSED.has(key)) continue;
		out[key] =
			key === "results" && Array.isArray(value)
				? value.map((hit) =>
						typeof hit === "object" && hit !== null && typeof (hit as Record<string, unknown>).show === "string"
							? Object.fromEntries(Object.entries(hit).filter(([field]) => !SEARCH_HIT_UNUSED.has(field)))
							: hit,
					)
				: value;
	}
	return out;
}

/** The model-facing view of one `knowledge` report. Every other tool passes straight through. */
export function trimKnowledgeEnvelope(tool: CosmicToolName | undefined, result: unknown): unknown {
	if (tool !== "cosmic_knowledge" || typeof result !== "object" || result === null || Array.isArray(result)) {
		return result;
	}
	const dropped = dropRedundantFiles(result) as Record<string, unknown>;
	const record = dropped.action === "search" ? trimSearch(dropped) : dropped;
	if (record.action === "status") return record;
	const source = record.source;
	if (typeof source !== "object" || source === null || Array.isArray(source)) return record;
	const line = source as Record<string, unknown>;
	return {
		...record,
		source: {
			kind: line.kind,
			bundleVersion: line.bundleVersion,
			// Never omitted when set: a rejected override is the one thing on this
			// line that means the answer may not be the one the user configured.
			...(line.degradedFrom === null || line.degradedFrom === undefined ? {} : { degradedFrom: line.degradedFrom }),
		},
	};
}
