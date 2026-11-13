/**
 * 必填字段预检：在冷启动之前说一句「这张单还差编码和名称」。
 *
 * The round trip it buys back. A write run costs a cold start, and the most
 * expensive way to spend one is not a wrong value but a missing mandatory field:
 * the platform's own `MustInputValidation` runs BEFORE any plugin on the chain,
 * so the run pays the full 30-90 seconds, never reaches the code under test, and
 * comes back with 「请填写"编码"」. Measured on the real ledger, 2026-09-14:
 * `run form zlgd_bzwz_wl --op save` with no `--set number` / `--set name`
 * burned **90.7 seconds** to learn two field names.
 *
 * Those two names are design-time metadata. `MustInputProbe` reads the merged
 * entity design and asks each item `isMustInput()` (S42 4.3 moved this channel
 * out of the retired `FieldTypeProbe`). This
 * module reads the probe's `t=mustinput` records, caches them per
 * RuntimeKey, and compare them with the `--set` list before the JVM starts.
 *
 * **It shows and never fills in**, for the same reason the retired known-good hint did
 * not: the branch under test may be exactly 「这个字段为空时应该报错」, and a
 * harness that quietly supplies the field turns that case green without testing
 * anything. It also never refuses -- a warning that was wrong costs one line of
 * reading, a refusal that is wrong costs the whole run.
 *
 * What it deliberately does NOT claim. Design-time `mustInput` is what the
 * designer marked, not what the validator will complain about on this particular
 * operation: a field carrying a default value is already filled by the time the
 * check runs, and the platform fills some audit columns itself. Both are filtered
 * out below, and the wording still stops short of 「必须给」. `creator` is the
 * important exception: OpSandbox's blank document leaves it at `0` when there is
 * no comparison document, so it must remain visible instead of being promised as
 * platform-filled.
 *
 * The 必录 box is not the only mandatory setting in the design. Two more were
 * missed by the first version (2026-09-17) and are read now:
 * - **必录条件** on a field: 必录 ticked, but only enforced when an expression
 *   over the bill holds. The first version reported these as unconditionally
 *   mandatory, which nags about fields this run may never need.
 * - **分录必录** on an entry (`isEntryMustInput`): the entry needs at least one
 *   row. The field-level `isMustInput()` never asks entries, so a new bill with
 *   an empty mandatory entry went through the preflight silently and still
 *   burned a cold start on 「分录至少要有一行」.
 */

import type { KernelContext } from "../context.ts";

/** One design-time mandatory item, as `MustInputProbe` reports it. */
export interface MustInputField {
	/**
	 * `field`: the field's own 必录 box. `entry`: the entry's 必录 box, which means
	 * "this entry must have at least one row" -- a different switch
	 * (`isEntryMustInput`) that the field-level question never reaches.
	 */
	kind: "field" | "entry";
	key: string;
	/** The Chinese caption -- the words the validator will use when it complains. */
	name: string;
	/** Entry identifier this item sits on; empty for a header field or a top-level entry. */
	entry: string;
	/** Design-time default. Non-empty means the validator will not see it empty. */
	def: string;
	type: string;
	/**
	 * The design-time 必录条件 expression; empty means "always mandatory".
	 *
	 * Only ever narrows: the platform attaches the required-check only when the
	 * 必录 box is ticked and then evaluates this per row, so a condition on an
	 * unticked item does nothing and is never reported.
	 */
	condition: string;
	/** What the designer wrote to explain the condition, if anything. */
	conditionDesc: string;
	/** `entry` only: rows the designer asked a new form to open with. */
	rows: number;
}

/** What one entity's scan found, and when. */
export interface MustInputFacts {
	entity: string;
	at: string;
	/** Items the probe walked. Zero mandatory fields out of a non-zero scan is a real answer. */
	items: number;
	fields: MustInputField[];
}

/**
 * Bumped whenever the probe starts reporting something the cached answer lacks.
 *
 * Version 2 added 必录条件 and entry-level 必录. A version-1 entry cannot be
 * upgraded in place: its silence about conditions reads exactly like "this field
 * has none", so it is dropped and the entity is asked again.
 */
const CACHE_VERSION = 2;

interface MustInputCache {
	kind: "MustInputCache";
	version: number;
	runtimeKeyId: string;
	entities: Record<string, MustInputFacts>;
}

/**
 * Fields the platform fills on its own, so a complaint about them would be noise.
 *
 * Kept short and named on purpose. Every entry is a column Cosmic writes itself
 * on save -- the audit columns and the bill-number/state machinery -- and none of
 * them is ever typed as a `--set`. `number` and `name` are NOT here and must not
 * be: those are exactly the two the real ledger lost 90.7 seconds to.
 */
const PLATFORM_FILLED: readonly string[] = [
	"id",
	"billno",
	"billstatus",
	"status",
	"createtime",
	"modifier",
	"modifytime",
	"auditor",
	"auditdate",
	"masterid",
	"enable",
];

/** Reads the `t=mustinput` bypass records of one `MustInputProbe` run. */
export function parseMustInput(records: readonly Record<string, unknown>[], at: string): MustInputFacts | null {
	const summary = records.find((record) => record.t === "mustinput-summary");
	// No summary means the probe never got as far as walking the items -- an empty
	// `fields` list from such a run would read as 「这张单没有必录字段」, which is a
	// statement about the bill rather than about the run that failed.
	if (summary === undefined) return null;
	const fields: MustInputField[] = records
		.filter((record) => record.t === "mustinput")
		.map((record) => ({
			kind: record.kind === "entry" ? ("entry" as const) : ("field" as const),
			key: String(record.key ?? ""),
			name: String(record.name ?? ""),
			entry: String(record.entry ?? ""),
			def: String(record.def ?? ""),
			type: String(record.type ?? ""),
			condition: String(record.cond ?? ""),
			conditionDesc: String(record.condDesc ?? ""),
			rows: Number(record.rows ?? 0) || 0,
		}))
		.filter((field) => field.key !== "");
	return { entity: String(summary.entity ?? ""), at, items: Number(summary.items ?? 0), fields };
}

function cacheFile(ctx: KernelContext): string {
	const safe = ctx.runtimeKeyId.replace(/[^\w.-]+/g, "_");
	return `${ctx.layout.workDir}/must-input/${safe}.json`;
}

function current(parsed: MustInputCache | null | undefined, ctx: KernelContext): boolean {
	return (
		parsed?.kind === "MustInputCache" && parsed.version === CACHE_VERSION && parsed.runtimeKeyId === ctx.runtimeKeyId
	);
}

/**
 * The cached answer for one entity on this RuntimeKey, or null.
 *
 * RuntimeKey-scoped because the answer comes out of an account set's metadata:
 * the same identifier in another environment can carry a different design, and
 * reporting one environment's mandatory fields while running in another is worse
 * than reporting none.
 */
export function readMustInput(ctx: KernelContext, entity: string): MustInputFacts | null {
	const file = cacheFile(ctx);
	if (!ctx.ports.fs.exists(file)) return null;
	try {
		const parsed = JSON.parse(ctx.ports.fs.read(file)) as MustInputCache;
		if (!current(parsed, ctx)) return null;
		return parsed.entities?.[entity] ?? null;
	} catch {
		return null;
	}
}

export function writeMustInput(ctx: KernelContext, entity: string, facts: MustInputFacts): void {
	const file = cacheFile(ctx);
	let cache: MustInputCache = {
		kind: "MustInputCache",
		version: CACHE_VERSION,
		runtimeKeyId: ctx.runtimeKeyId,
		entities: {},
	};
	if (ctx.ports.fs.exists(file)) {
		try {
			const parsed = JSON.parse(ctx.ports.fs.read(file)) as MustInputCache;
			if (current(parsed, ctx)) {
				cache = { ...cache, entities: parsed.entities ?? {} };
			}
		} catch {
			// Unreadable cache: replace it. Nothing here is evidence.
		}
	}
	cache.entities[entity] = facts;
	try {
		ctx.ports.fs.mkdirp(file.slice(0, file.lastIndexOf("/")));
		ctx.ports.fs.write(file, `${JSON.stringify(cache, null, "\t")}\n`);
	} catch {
		// A cache that cannot be written must not fail the run it was helping.
	}
}

/**
 * `编码=A01` / `zlgd_org.name=x` / `zlgd_entry[0].qty=1` -> the header-level key
 * the `--set` is aimed at: a field, or the entry whose row it writes.
 */
export function setFieldKey(value: string): string {
	const head = value.split("=")[0] ?? "";
	return (head.split(".")[0] ?? "").replace(/\[[^\]]*\]$/, "").trim();
}

/**
 * The mandatory items this run has not given a value for.
 *
 * Two kinds, both header-level:
 * - header fields with 必录 ticked, not `--set`, no default, not platform-filled;
 * - top-level entries with 必录 ticked (at least one row) that no `--set` writes a row of.
 *
 * Fields on an entry and sub-entries are left out: they are only checked once
 * their parent row exists, and whether this run creates one is not decidable
 * from the argv -- naming them would produce a list nobody can act on.
 *
 * Items carrying a 必录条件 are kept, not dropped: the condition is an
 * expression over the bill's values, which this side cannot evaluate, and
 * leaving them out would recreate exactly the silence this list exists to end.
 * The text keeps them apart from the unconditional ones instead.
 */
export function missingMustInput(facts: MustInputFacts, sets: readonly string[]): MustInputField[] {
	const given = new Set(sets.map(setFieldKey).filter((key) => key !== ""));
	return facts.fields.filter((field) => {
		if (field.entry !== "" || given.has(field.key)) return false;
		if (field.kind === "entry") return true;
		return !prefilled(field) && !PLATFORM_FILLED.includes(field.key.toLowerCase());
	});
}

/**
 * Whether the design-time default already satisfies the required-check.
 *
 * A zero default on a numeric field does NOT: the platform's comparator for
 * decimal/integer properties counts 0 as empty (`DecimalProp.getValueComparator`),
 * so 「请填写"年份"」 still comes back. Found on the real ledger 2026-09-17:
 * `zlgd_alu_sales_mpr` has `zlgd_year` / `zlgd_month` mandatory with default "0",
 * and the old `def === ""` test dropped both from the list.
 */
function prefilled(field: MustInputField): boolean {
	if (field.def === "") return false;
	const numeric = /Integer|Decimal|Amount|Qty|Price/.test(field.type);
	return !(numeric && /^[-+]?0*(\.0*)?$/.test(field.def.trim()));
}

/** A condition as a person reads it: the designer's words first, the expression as backup. */
function conditionText(field: MustInputField): string {
	const expr = field.condition.length > 120 ? `${field.condition.slice(0, 117)}...` : field.condition;
	// 设计器没填说明时，平台把表达式原样抄进说明（真机 zlgd_ygjcxx），两个一样就只说一遍。
	const desc = field.conditionDesc === field.condition ? "" : field.conditionDesc;
	if (desc !== "" && expr !== "") return `「${desc}」（${expr}）`;
	return desc !== "" ? `「${desc}」` : expr;
}

/** The warning, or null when there is nothing to say. */
export function mustInputText(input: {
	entity: string;
	op: string;
	missing: readonly MustInputField[];
	scenarioId?: string | null;
}): string | null {
	if (input.missing.length === 0) return null;
	const where = input.scenarioId === undefined || input.scenarioId === null ? "" : `场景 ${input.scenarioId}：`;
	const label = (field: MustInputField) => `${field.key}（${field.name}）`;
	const always = input.missing.filter((field) => field.kind === "field" && field.condition === "");
	const conditional = input.missing.filter((field) => field.kind === "field" && field.condition !== "");
	const entries = input.missing.filter((field) => field.kind === "entry");

	const lines = [
		`${where}${input.entity} ${input.op}：设计态标了必录、这次 --set 没给的有 ${String(input.missing.length)} 项。`,
	];
	if (always.length > 0) {
		lines.push(`  始终必录的表头字段：${always.map(label).join("、")}`);
		lines.push(`    要补就是：${always.map((field) => `--set ${field.key}=…`).join(" ")}`);
	}
	if (conditional.length > 0) {
		lines.push("  带「必录条件」的表头字段（条件成立时才拦；这里没算条件成不成立，要对照这次给的值自己看）：");
		for (const field of conditional) lines.push(`    ${label(field)}：当 ${conditionText(field)} 时必录`);
	}
	if (entries.length > 0) {
		lines.push("  必须至少有一行的分录（分录必录）：");
		for (const field of entries) {
			const when = field.condition === "" ? "" : `，条件：当 ${conditionText(field)} 时`;
			const rows = field.rows > 0 ? `；设计态默认开 ${String(field.rows)} 行，run form 打开的新单可能已经有行` : "";
			lines.push(`    ${label(field)}${when}${rows}。要造一行就是 --set ${field.key}[0].<字段>=…`);
		}
	}
	lines.push(
		"  平台的必填校验排在所有插件前面，缺一个就整轮白跑（真机实测一次 90.7 秒）。",
		"  这是设计态标的「必录」，不是校验器这次一定会拦的清单：带默认值的和平台自己填的（单据编号、状态等）已经排除，剩下的仍可能有例外。",
		"  沙箱新建空单不自动填 creator；没有对照单据时它会是 0，所以创建人若在清单里不能按平台默认值跳过。",
		"  分录里的必录字段没在这里列——那要等分录真有行了才校验。",
		"  只把清单摆出来，不会替你补：要验的分支本来就可能正是「这个字段为空时应该报错」。",
	);
	return lines.join("\n");
}
