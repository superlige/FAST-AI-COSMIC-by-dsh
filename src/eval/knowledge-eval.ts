/**
 * Running the eval batch, and the injection account that goes with it (S7.5).
 *
 * Two channels answer the same batch, and both answers are measured the same
 * way, because the only comparison worth anything is one made on the same
 * questions in the same run. The historical figures (search 3/10, table 9/9) were
 * measured on a different snapshot by a different implementation; they are the
 * shape of the result, not evidence about this one.
 *
 * What "recall" means here, precisely: **the answer is in what came back**. For
 * the table channel that is "the target row is in the returned table"; for search
 * it is "the target is in the top k". Neither says the model then picked it --
 * that is a different measurement needing a model, and stating it this plainly is
 * the point. A retrieval step that does not contain the answer guarantees the
 * model cannot pick it, so this is the ceiling, and a ceiling is worth watching.
 *
 * Bytes are counted as the model receives them, which means through the agent
 * boundary rather than off the kernel report: `trimKnowledgeEnvelope` drops the
 * fields the model cannot act on and `extractProse` moves the table into a
 * content block of its own. Counting `JSON.stringify(report)` instead was the
 * older reading of the same sentence, and after S15 it overstated the unfiltered
 * scene table by 40% -- 33,125 bytes against the 23,736 the model is actually
 * handed -- while pricing an escaped `\n` as though it were a line break. The
 * `{ok, state, note}` envelope adds a constant on top and is still excluded, so
 * a change in the state machine does not look like a change in knowledge cost.
 *
 * The direction of the import is deliberate. `prose-blocks` says it in its own
 * header -- the agent boundary is the only place that knows the difference
 * between a terminal and a context window -- so a measurement of what the model
 * receives has to be taken there, or it is a measurement of something else.
 */

import { trimKnowledgeEnvelope } from "../agent/tools/knowledge-envelope.ts";
import { extractProse } from "../agent/tools/prose-blocks.ts";
import type { ReflectionPort } from "../kernel/api-tool.ts";
import {
	type KnowledgeApiReport,
	knowledgeApi,
	knowledgeScenes,
	knowledgeSearch,
} from "../kernel/commands/knowledge.ts";
import { apiItems, classifyQuery, PLUGIN_ROUTES, type QueryChannel } from "../knowledge/catalog.ts";
import type { KnowledgeBase } from "../knowledge/docs.ts";
import type { KnowledgeSourceStatus } from "../knowledge/source.ts";
import { EVAL_CASES, type EvalCase, type EvalKind } from "./corpus.ts";

/** Search depth. 3, because the frozen measurement was recall@3 and comparisons need the same k. */
export const SEARCH_K = 3;

const encoder = new TextEncoder();

const utf8 = (text: string): number => encoder.encode(text).length;

/**
 * What one knowledge report costs the model, envelope plus content blocks.
 *
 * Both halves have to be counted or the number moves for the wrong reason: after
 * the prose move a `scenes` answer is a 282-byte envelope pointing at a 23 KB
 * block, and counting the envelope alone would read as a 99% saving that nobody
 * made.
 */
function modelBytes(action: "scenes" | "search", report: object): number {
	// `runKnowledge` is what tags a report with its action, and both the trim and
	// the prose move dispatch on that tag -- so measuring a bare report would
	// silently measure the untagged path the model never sees.
	const tagged = { action, ...report };
	const prose = extractProse("cosmic_knowledge", trimKnowledgeEnvelope("cosmic_knowledge", tagged));
	// The block heading is real context too: `renderToolResult` emits each block
	// as `# <label>` and a blank line before the body.
	return (
		utf8(JSON.stringify(prose.result) ?? "") +
		prose.blocks.reduce((sum, block) => sum + utf8(`# ${block.label}\n\n${block.text}`), 0)
	);
}

export interface ChannelOutcome {
	/** The target was in what came back. */
	found: boolean;
	/** 1-based position, or null when absent. Search only; the table is not ranked. */
	rank: number | null;
	/** Rows or results returned. */
	returned: number;
	/** UTF-8 bytes the model is handed: trimmed envelope plus content blocks. See `modelBytes`. */
	bytes: number;
	ms: number;
	/** The report named a next step even when it had no answer. */
	hasNextStep: boolean;
	/** Search's top score. Zero when nothing came back. */
	topScore: number;
}

export interface CaseOutcome {
	case: EvalCase;
	/** What `classifyQuery` decided. */
	channel: QueryChannel;
	/**
	 * The router sent the question to the channel that does not hold the answer.
	 * Only meaningful for cases that have one.
	 */
	misrouted: boolean;
	table: ChannelOutcome;
	search: ChannelOutcome;
}

export interface DriftOutcome {
	case: EvalCase;
	/** The snapshot has a document for this class. */
	documented: boolean;
	/** The document says which framework version it describes. */
	statesVersion: boolean;
	/** The answer admits it was not checked against the JAR (or reports the join). */
	statesUncheckedOrJoined: boolean;
	/** L1 insertion point 3: a plugin base class query carries its family's entry point. */
	pluginHint: boolean;
	report: KnowledgeApiReport;
}

export interface KindTally {
	kind: EvalKind;
	total: number;
	/** Cases in this group that have a scene answer at all. */
	answerable: number;
	tableFound: number;
	searchFound: number;
	medianTableBytes: number;
	medianSearchBytes: number;
	/** Per-question latency, milliseconds. The table channel re-reads the index each call. */
	medianTableMs: number;
	medianSearchMs: number;
}

export interface EvalReport {
	cases: CaseOutcome[];
	drift: DriftOutcome[];
	byKind: KindTally[];
	/** Cases with a scene answer, across every group. */
	answerable: number;
	tableRecall: number;
	searchRecall: number;
	/** Historical group only -- the no-regression criterion. */
	historyTable: { found: number; total: number };
	historySearch: { found: number; total: number };
	/** Cases whose only answer is a guide: the scene table structurally cannot serve them. */
	fallbacks: number;
	misrouted: string[];
	/** Cases that came back with neither an answer nor a next step. Must be empty. */
	silentMisses: string[];
	/** Top search score on questions the snapshot cannot answer, largest first. */
	lowConfidenceScores: { id: string; topScore: number }[];
	/** Median search score of a hit, for comparison with the line above. */
	medianHitScore: number;
	/** How much of the plugin-base surface the API corpus actually documents. */
	pluginBaseApi: PluginBaseApiCoverage;
	totalMs: number;
}

export interface PluginBaseApiCoverage {
	documented: number;
	total: number;
	/** Base classes with no API page in this snapshot, simple names. */
	missing: string[];
}

/**
 * Which plugin base classes the API corpus covers.
 *
 * Recorded, not gated: it is a fact about the official snapshot, not about this
 * code, and there is nothing here that could fix it. It is measured because
 * `api <plugin base>` is L1 insertion point 3, and knowing that the answer will
 * be "this snapshot has no page for it" for a third of the families is the
 * difference between a known gap and a surprise -- the base class it is missing
 * for includes `AbstractFormPlugin`, the most common one there is.
 */
export function pluginBaseApiCoverage(base: KnowledgeBase): PluginBaseApiCoverage {
	const documented = new Set(apiItems(base).map((item) => (item.fqcn ?? "").split(".").pop()));
	const missing = PLUGIN_ROUTES.filter((route) => !documented.has(route.base)).map((route) => route.base);
	return { documented: PLUGIN_ROUTES.length - missing.length, total: PLUGIN_ROUTES.length, missing };
}

function median(values: readonly number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	const low = sorted[middle - 1] ?? 0;
	const high = sorted[middle] ?? 0;
	return sorted.length % 2 === 1 ? high : Math.round((low + high) / 2);
}

/**
 * One case through the table channel.
 *
 * The facet is the case's own `pluginType`, which is null for exactly the
 * families the official index never tagged -- so the untagged families really do
 * get the whole 167-row table here, and the byte column shows what that costs.
 */
function runTable(base: KnowledgeBase, status: KnowledgeSourceStatus, entry: EvalCase, clock: () => number) {
	const started = clock();
	const report = knowledgeScenes(base, status, entry.pluginType === null ? {} : { pluginType: entry.pluginType });
	const ms = clock() - started;
	const index = entry.scene === null ? -1 : report.rows.findIndex((row) => row.relativePath === entry.scene);
	return {
		found: index >= 0,
		rank: index >= 0 ? index + 1 : null,
		returned: report.rows.length,
		bytes: modelBytes("scenes", report),
		ms,
		hasNextStep: report.howToRead !== "",
		topScore: 0,
	} satisfies ChannelOutcome;
}

function runSearch(base: KnowledgeBase, status: KnowledgeSourceStatus, entry: EvalCase, clock: () => number) {
	const started = clock();
	const result = knowledgeSearch(base, status, entry.query, {
		limit: SEARCH_K,
		...(entry.pluginType === null ? {} : { pluginType: entry.pluginType }),
	});
	const ms = clock() - started;
	if (!result.ok) {
		// An invalid query is a real outcome, not a crash: it is what an empty or
		// filter-only query gets, and the batch should show it rather than throw.
		return { found: false, rank: null, returned: 0, bytes: 0, ms, hasNextStep: true, topScore: 0 };
	}
	const report = result.value;
	const index =
		entry.scene === null
			? -1
			: report.results.findIndex((item) => item.relativePath === `${SCENE_ROOT}${entry.scene}`);
	return {
		found: index >= 0,
		rank: index >= 0 ? index + 1 : null,
		returned: report.results.length,
		bytes: modelBytes("search", report),
		ms,
		// A miss with a steer or a warning still tells the caller where to go.
		hasNextStep: report.results.length > 0 || report.steer !== null || report.warnings.length > 0,
		topScore: report.results[0]?.score ?? 0,
	} satisfies ChannelOutcome;
}

const SCENE_ROOT = "platform/scenes/";

/**
 * The version-drift group, which asks a different question of a different action.
 *
 * `reflect` is expected to be unavailable offline, and that is the case worth
 * checking: with no JAR to compare against, the answer must say so. A report that
 * printed the document's method list without that sentence would be presenting a
 * 8.0.1 snapshot as a verified fact about the user's runtime.
 */
async function runDrift(
	base: KnowledgeBase,
	status: KnowledgeSourceStatus,
	entry: EvalCase,
	reflect: ReflectionPort,
): Promise<DriftOutcome | null> {
	const fqcn = entry.fqcn;
	if (fqcn === undefined) return null;
	const result = await knowledgeApi(base, status, fqcn, reflect);
	if (!result.ok) return null;
	const report = result.value;
	// One class per drift case, so the batch has exactly one entry.
	const answer = report.entries[0];
	if (answer === undefined) return null;
	return {
		case: entry,
		documented: answer.relativePath !== null,
		// The source line carries the snapshot's own version; the document carries
		// the framework's. Both have to be in the answer for "which version is this"
		// to be answerable without a second call.
		statesVersion: report.source.bundleVersion !== "",
		statesUncheckedOrJoined: answer.reflectionUnavailable !== null || answer.join !== null,
		pluginHint: answer.pluginHint !== null,
		report,
	};
}

export interface EvalInput {
	base: KnowledgeBase;
	status: KnowledgeSourceStatus;
	reflect: ReflectionPort;
	cases?: readonly EvalCase[];
	/** Milliseconds. Injectable so a test can be deterministic. */
	clock?: () => number;
}

export async function runKnowledgeEval(input: EvalInput): Promise<EvalReport> {
	const cases = input.cases ?? EVAL_CASES;
	const clock = input.clock ?? (() => Date.now());
	const started = clock();

	const outcomes: CaseOutcome[] = [];
	const drift: DriftOutcome[] = [];
	for (const entry of cases) {
		if (entry.kind === "version-drift") {
			const outcome = await runDrift(input.base, input.status, entry, input.reflect);
			if (outcome !== null) drift.push(outcome);
			continue;
		}
		const table = runTable(input.base, input.status, entry, clock);
		const search = runSearch(input.base, input.status, entry, clock);
		const channel = classifyQuery(entry.query).channel;
		outcomes.push({
			case: entry,
			channel,
			// Wrong channel means: the router picked the one that does not have the
			// answer while the other one does. Both missing is a knowledge gap, not
			// a routing error, and counting it as one would hide the gap.
			misrouted: entry.scene !== null && (channel === "identifier" ? !search.found && table.found : false),
			table,
			search,
		});
	}

	const kinds: EvalKind[] = ["history", "gap-family", "business", "low-confidence"];
	const byKind: KindTally[] = kinds.map((kind) => {
		const group = outcomes.filter((outcome) => outcome.case.kind === kind);
		const answerable = group.filter((outcome) => outcome.case.scene !== null);
		return {
			kind,
			total: group.length,
			answerable: answerable.length,
			tableFound: answerable.filter((outcome) => outcome.table.found).length,
			searchFound: answerable.filter((outcome) => outcome.search.found).length,
			medianTableBytes: median(group.map((outcome) => outcome.table.bytes)),
			medianSearchBytes: median(group.map((outcome) => outcome.search.bytes)),
			medianTableMs: median(group.map((outcome) => outcome.table.ms)),
			medianSearchMs: median(group.map((outcome) => outcome.search.ms)),
		};
	});

	const answerable = outcomes.filter((outcome) => outcome.case.scene !== null);
	const history = outcomes.filter((outcome) => outcome.case.kind === "history");
	const lowConfidence = outcomes.filter((outcome) => outcome.case.kind === "low-confidence");

	return {
		cases: outcomes,
		drift,
		byKind,
		answerable: answerable.length,
		tableRecall: answerable.filter((outcome) => outcome.table.found).length,
		searchRecall: answerable.filter((outcome) => outcome.search.found).length,
		historyTable: { found: history.filter((outcome) => outcome.table.found).length, total: history.length },
		historySearch: { found: history.filter((outcome) => outcome.search.found).length, total: history.length },
		fallbacks: outcomes.filter((outcome) => outcome.case.scene === null && outcome.case.guide !== null).length,
		misrouted: outcomes.filter((outcome) => outcome.misrouted).map((outcome) => outcome.case.id),
		silentMisses: outcomes
			.filter((outcome) => !outcome.table.hasNextStep && !outcome.search.hasNextStep)
			.map((outcome) => outcome.case.id),
		lowConfidenceScores: lowConfidence
			.map((outcome) => ({ id: outcome.case.id, topScore: outcome.search.topScore }))
			.sort((a, b) => b.topScore - a.topScore),
		medianHitScore: median(
			answerable.filter((outcome) => outcome.search.found).map((outcome) => outcome.search.topScore),
		),
		pluginBaseApi: pluginBaseApiCoverage(input.base),
		totalMs: clock() - started,
	};
}

// ------------------------------------------------------------ injection account

export interface FamilyTableCost {
	pluginType: string | null;
	rows: number;
	/** Of the whole table. 1 when no facet applies. */
	coverage: number;
	/** What this table costs the model, envelope plus its content block. See `modelBytes`. */
	bytes: number;
}

export interface InjectionAccount {
	/** Bytes cosmic adds to the system prompt, worst case. Paid every turn, cached. */
	residentL0: number;
	/** Bytes pi spends listing the reference skills. Also resident, also cached. */
	residentSkills: number;
	/** The scene table, per family. The one-time cost of the L2 table channel. */
	tables: FamilyTableCost[];
	/** The whole table with no facet -- what an untagged family gets. */
	untaggedTable: number;
	/**
	 * What one compaction costs.
	 *
	 * Compaction drops the scene table the model already read, so the table has to
	 * be read again -- that is the only real amplification point in this design.
	 * Capsule delivery does not amplify: the compact digest/source record lives
	 * under `.cosmic-ai/work/`, and the session also deduplicates the digest. A compaction
	 * does not force the old six-step research flow to be walked again.
	 */
	compactionReread: number;
}

export interface InjectionAccountInput {
	base: KnowledgeBase;
	status: KnowledgeSourceStatus;
	residentL0: number;
	residentSkills: number;
	/** Families to price. Null prices the unfiltered table. */
	families: readonly (string | null)[];
}

export function injectionAccount(input: InjectionAccountInput): InjectionAccount {
	const price = (pluginType: string | null): FamilyTableCost => {
		const report = knowledgeScenes(input.base, input.status, pluginType === null ? {} : { pluginType });
		return { pluginType, rows: report.rows.length, coverage: report.coverage, bytes: modelBytes("scenes", report) };
	};
	const tables = input.families.map(price);
	const untagged = price(null);
	return {
		residentL0: input.residentL0,
		residentSkills: input.residentSkills,
		tables,
		untaggedTable: untagged.bytes,
		// The largest table anyone can be holding is the one a compaction can cost.
		compactionReread: Math.max(untagged.bytes, ...tables.map((table) => table.bytes)),
	};
}
