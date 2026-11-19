/**
 * The impact index (S5.3): "source + metadata" folded into
 * "class -> bound entities / entities read and written / fields touched", so a
 * change can be looked up from the identifier it starts at. It does not depend on
 * wording -- whoever is about to change QTYWTDOpPlugin certainly knows they are
 * changing QTYWTDOpPlugin.
 *
 * Everything in this file is pure: no Cosmic, no process, no filesystem. The two
 * halves that do touch the world are the static side (tools/SrcIndexTool.java,
 * javac's Tree API over the project sources, offline) and the metadata side
 * (probes/PluginIndexProbe.java, which needs a live connection); both feed values
 * in here. They must stay independent -- neither can be a precondition for the
 * other, or an offline machine gets no index at all.
 */

/**
 * Resolution levels. `none` is the sink table's edge (the signature carries no
 * identifier), not "we failed this time". `origin` is a `none` save / update whose
 * bill was settled from where the saved objects came from (`load("X")` upstream).
 */
export const RESOLUTIONS = ["literal", "constant", "origin", "dynamic", "none"] as const;
export type Resolution = (typeof RESOLUTIONS)[number];
const RESOLVED = new Set<string>(["literal", "constant", "origin"]);

export type Access = "read" | "write" | string;

export interface SrcRef {
	class: string;
	entity?: string | null;
	field?: string | null;
	access: Access;
	resolution: Resolution | string;
	/** Method id (`class#method(sig)`) the reference sits in; chains propagate along these. */
	inMethod?: string | null;
	/** Source line of the call. */
	line?: number;
	/** The sink that was called, `Owner#method(sig)`. */
	via?: string | null;
	/**
	 * Where the object read or written came from, within its method (field refs only):
	 * `own` (the plugin's own bill), `bill:X` (loaded / created by name), `param:N`,
	 * `billparam:N` (loaded by a bill key passed in as parameter N), `ext:X`
	 * (a conversion target's data by key), `prop:f/<origin>` (the value of field f
	 * on another object), `member:x`, `ret:C#m`, or `?:<why not>`.
	 */
	obj?: string | null;
	/** `param:N` when the field key is parameter N of the method: a wrapper writing a field it is handed. */
	keyFrom?: string | null;
	/** Set on refs derived from a wrapper call: the wrapper method that holds the real sink. */
	through?: string | null;
	/** The key argument as written (`fieldName`); what a reader looks for when the key did not resolve. */
	expr?: string | null;
}

export interface SrcEdge {
	from: string;
	to: string;
	fromClass: string;
	toClass: string;
	/** Line of the first call from `from` to `to`; absent on indexes built before calls carried lines. */
	line?: number;
	/** How many calls from `from` to `to`. */
	count?: number;
}

/**
 * A call into this project's own method, with what each argument is: the origin
 * of a data object (same words as `SrcRef.obj`), `key:X` for a constant string,
 * `param:N` for the caller's own parameter, null for anything else.
 */
export interface SrcCall {
	from: string;
	to: string;
	fromClass: string;
	line: number;
	args: (string | null)[];
}

/** A call the transaction cannot take back (attachment, micro-service, message, HTTP, socket), by method. */
export interface SrcEffect {
	class: string;
	inMethod?: string | null;
	line?: number;
	/** The API family, e.g. `HttpURLConnection`, `sendMessage`. */
	effect: string;
}

export interface SrcClass {
	class: string;
	file?: string | null;
	pluginType?: string | null;
}

export interface SrcIndex {
	kind: "SrcIndex";
	at: string;
	ms: number;
	files: number;
	cpEntries?: number;
	/** Fingerprint of the SrcIndexTool source that built this: a new scanner reads more, so the table is rebuilt. */
	tool?: string;
	calls: { total: number; unbound: number };
	diagnostics?: { error?: number; sample?: string[] } | null;
	classes: SrcClass[];
	entityRefs: SrcRef[];
	fieldRefs: SrcRef[];
	edges?: SrcEdge[];
	callArgs?: SrcCall[];
	effects?: SrcEffect[];
	unknownSigs?: string[];
}

export interface MetaBinding {
	class: string;
	entity: string;
	kind?: string;
	enabled?: boolean;
	/**
	 * The registering object's OWN number: the form layout, the print template,
	 * the scheduled task code, the API number, the BOTP rule id, the workflow key.
	 *
	 * The probe has always emitted it and the index used to throw it away, which
	 * is what reduced every non-entity registration site to "class - entity - kind"
	 * and left a requirement about template 21 with nothing but "the test bill" to
	 * be recalled by.
	 */
	layout?: string;
}

export interface MetaTemplate {
	number: string;
	entity: string;
	classes?: string[];
}

/**
 * A design-time object's Chinese name, keyed by the registration site and the
 * number that site reports.
 *
 * The probe verifies the name column exists before reading it and says so per
 * family when it does not, so an absent row means "this family has no name
 * column", never "this object is nameless".
 */
export interface MetaName {
	site: string;
	id: string;
	name: string;
}

/** A bill's design-time name. `base` is the platform bill an extension design extends: the number plugins and code use. */
export interface BillName {
	bill: string;
	name: string;
	base?: string;
}

export interface FieldOwnership {
	entity: string;
	key: string;
	/** header | entry | subentry | unknown */
	level: string;
	/** Absent on a header field. */
	entry?: string;
	/** Present on a sub-entry only. */
	parentEntry?: string;
	/** Absent means `field`; `container` is an entry or sub-entry itself. */
	kind?: string;
}

/**
 * A field row as stored: empty entry and parent entry, and the default kind,
 * left out. Seven in ten rows are header fields, and those three columns were a
 * third of the snapshot's field bytes while saying nothing (S17 7.2).
 */
export function compactField(row: FieldOwnership): FieldOwnership {
	return {
		entity: row.entity,
		key: row.key,
		level: row.level,
		...(row.entry ? { entry: row.entry } : {}),
		...(row.parentEntry ? { parentEntry: row.parentEntry } : {}),
		...(row.kind && row.kind !== "field" ? { kind: row.kind } : {}),
	};
}

/**
 * Where a bill's design inherits from, as the field scan saw it (`t=fieldbase`).
 *
 * The scan reads each design's own XML, so `fields` never holds what a bill
 * inherits -- `billno` lives on the platform template `bos_billtpl`, not on the
 * bill. Without this, "every field of the bill is collected" reads as "a field
 * not collected is not on the bill", which is false for every inherited field.
 */
export interface FieldBase {
	/** The nearest ancestor design outside this ISV (usually a platform template); absent = none. */
	outside?: string;
	/** This ISV's own ancestor designs, nearest first; absent = none. */
	parents?: string[];
}

export interface MetaIndex {
	kind: "MetaIndex";
	at: string;
	ms: number;
	scanned: number;
	bindings: MetaBinding[];
	templates: MetaTemplate[];
	fields: FieldOwnership[];
	/** Field key -> how many entities in the WHOLE library carry it. A count, not a list. */
	fieldOwners: Record<string, number>;
	fieldsMs: number;
	/** Design-time names, by site + number. Absent on indexes built before the name channel. */
	names?: MetaName[];
	/**
	 * Which plugin registration sites this scan actually covered.
	 *
	 * Absent on indexes built before 2026-09-04, which is why every reader treats
	 * a missing field as `SITES_BEFORE_2026_09_04` rather than as "everything".
	 * The field exists because the probe's answer for an unscanned family is
	 * indistinguishable from a real "not registered anywhere" -- and the second
	 * one is what a reader acts on.
	 */
	sites?: string[];
	/**
	 * The bills the field-ownership scan collected every field of. A patch compares
	 * it with the bills the code names now and scans the new ones.
	 *
	 * Written only when that scan ran and reported at least one owner. Snapshots
	 * built before S17 7.2 also carry the asked keys (`fields`), which nothing read.
	 */
	asked?: { entities: string[] };
	/**
	 * True when `fields` holds EVERY field of each bill on `asked.entities`, not only
	 * the asked keys (S17 4.2). Then "is this field on that bill" has an answer for
	 * those bills. Absent on snapshots built before.
	 */
	fieldsAll?: boolean;
	/** Bill -> where its design inherits from, for the scanned bills. Absent on snapshots built before. */
	fieldBases?: Record<string, FieldBase>;
	/** The ISV the field scan ran for: a key with its prefix cannot come from another ISV's template. */
	fieldIsv?: string;
	/**
	 * Field key -> every bill in the library carrying it, for the keys `fieldOwners`
	 * counts. A patch rescans only the bills that changed, and a count can only be
	 * moved up or down by knowing whether that bill carried the key before.
	 */
	owners?: Record<string, string[]>;
	/** Primary key, number and modification time of every design row the scan reads: what a change check compares against. */
	baseline?: MetaBaseline;
	/** When the last partial rescan was merged in; `at` stays the full build's time. */
	patchedAt?: string;
	/** Every ISV bill design's name, from the field scan. Absent on snapshots built before S17 7.4. */
	billNames?: BillName[];
}

/**
 * The design rows a snapshot was built from, per site: `[id, number, stamp]`.
 * `number` is the registration's own number (`layout` on a binding); a rescan goes
 * by it, which is also how a deleted row takes its registrations with it.
 */
export interface MetaBaseline {
	at: string;
	sites: string[];
	rows: Record<string, [string, string, string][]>;
}

/** What the last change check found (`meta-check.json` beside the snapshot). */
export interface MetaCheck {
	at: string;
	/**
	 *   same      nothing changed since the snapshot
	 *   patched   changes found and rescanned
	 *   over      more changes than one rescan takes; not patched
	 *   baseline  the snapshot has no baseline to compare with
	 *   failed    the check or the rescan did not run
	 */
	state: "same" | "patched" | "over" | "baseline" | "failed";
	/** Changed design rows plus bills the code newly names. */
	changed: number;
	text: string;
	ms: number;
}

/** Metadata this machine wrote since the last check (`meta-pending.json`). */
export interface MetaPending {
	at: string;
	writes: { at: string; probe: string; targets: string[] }[];
}

/** What `PluginIndexProbe` covered before the four sites were added. */
export const SITES_BEFORE_2026_09_04: readonly string[] = ["form", "entity", "print"];

/**
 * Source-side plugin type -> the registration site that would carry its binding.
 *
 * `SrcIndexTool` derives the left side from the Cosmic base class. The right side
 * is where that family is registered, measured on the real machine (see
 * `PluginIndexProbe`'s file header). `form`/`list`/`report` all live in
 * formdesign, so they share one site.
 */
export const SITE_OF_PLUGIN_TYPE: Readonly<Record<string, string>> = {
	form: "form",
	list: "form",
	report: "form",
	validator: "entity",
	op: "entity",
	print: "print",
	convert: "convert",
	task: "task",
	api: "api",
	workflow: "workflow",
};

/** What to call a site in a sentence aimed at the user. */
export const SITE_LABEL: Readonly<Record<string, string>> = {
	form: "表单设计态 t_meta_formdesign",
	entity: "实体设计态 t_meta_entitydesign",
	print: "打印模板 t_svc_printmeta",
	task: "调度任务定义 t_sch_taskdefine",
	api: "开放平台接口 t_open_apiservice",
	convert: "BOTP 转换规则 t_botp_convertrule",
	workflow: "工作流 t_wf_gebytearray / t_wf_participantmodel",
};

/**
 * Registration site -> what KIND of object the number in that row is.
 *
 * `entity` and the three formdesign sites are absent on purpose: a form layout
 * number is already reachable through the entity, and minting an artifact per
 * layout would add 2,220 rows to this project's index that nobody ever names.
 * The five that are here are the ones with no other way in -- before this, a
 * requirement about a scheduled task could only be recalled as "some class".
 */
export const ARTIFACT_KIND_OF_SITE: Readonly<Record<string, string>> = {
	print: "print_template",
	task: "task",
	api: "open_api",
	convert: "botp_rule",
	workflow: "workflow",
};

/** Per (class, entity, site) number cap. See the note where it is applied. */
export const ARTIFACT_NUMBER_CAP = 12;

/** The registration sites whose numbers become artifacts. */
export const ARTIFACT_SITES: readonly string[] = Object.keys(ARTIFACT_KIND_OF_SITE);

/**
 * Is the artifact channel actually carrying numbers? Empty string means yes;
 * anything else is a sentence saying why not, meant to be printed verbatim.
 *
 * There are four ways it can be down, and **three of them look identical to
 * "this project has no print templates"** if the only test is `artifacts`:
 *
 *   - no metadata side at all (offline build)
 *   - an index built before artifact retention (`artifacts` absent)
 *   - a scan that did not cover the artifact-bearing sites
 *   - a scan that covered them and retained no numbers -- what a `--src-only`
 *     build does when the cached metadata side was written by the receiver that
 *     threw `layout` away. `mergeIndex` still emits `artifacts: []` for it, so a
 *     test on the field's presence passes and the channel silently answers
 *     "nothing matched".
 *
 * The last one is why this is a function and not a `=== undefined`. It is the
 * same rule `PluginIndexProbe`'s header states for the probe itself: a false
 * negative is more dangerous than a gap, because the gap makes nobody act.
 */
export function artifactGap(index: ImpactIndex): string {
	if (!index.meta) {
		return "没有元数据侧，非实体对象（打印模板 / 调度任务 / 开放 API / BOTP 规则 / 工作流）一个都查不到";
	}
	if (index.artifacts === undefined) {
		return "这份索引建于编号保留之前，非实体对象的编号没进来 —— 跑一次不带 srcOnly 的 cosmic_doctor action=reindex";
	}
	const sites = index.meta.sites ?? SITES_BEFORE_2026_09_04;
	const missing = ARTIFACT_SITES.filter((site) => !sites.includes(site));
	if (missing.length === ARTIFACT_SITES.length) {
		return `这次一处产出物注册位置都没扫（${missing.map((s) => SITE_LABEL[s] ?? s).join("、")}）`;
	}
	// `numbers` absent = the index predates the tally, which is exactly the era
	// whose metadata cache has no numbers either -- treat it as zero, not as fine.
	if ((index.meta.numbers ?? 0) === 0 && index.meta.bindings > 0) {
		return "扫过产出物位置，却一个编号都没收到（多半是 srcOnly 沿用了保留编号之前的元数据缓存）—— 跑一次完整 cosmic_doctor action=reindex";
	}
	if (missing.length > 0) {
		return `这次没扫 ${missing.map((s) => SITE_LABEL[s] ?? s).join("、")}，这几族按「没扫」算，不是「没绑」`;
	}
	return "";
}

export interface FoldedRef {
	key: string | null;
	access: Access;
	resolution: Resolution | string;
	count: number;
}

export interface ChainRef {
	level: "entity" | "field";
	key: string;
	access: Access;
	hops: number;
	via: string;
	viaMethod: string;
}

export interface ClassBinding {
	entity: string;
	kind?: string;
	layouts: number;
	enabled: boolean;
	/**
	 * The numbers behind `layouts`, capped. Kept because the number is what a
	 * person says out loud ("21 模板打歪了"), and a count cannot be recalled on.
	 */
	numbers: string[];
}

/**
 * A non-entity design-time object, kept in its own right rather than folded into
 * "some entity this class touches".
 *
 * `kind` is an `AnchorKind` (see anchors.ts) rather than the raw registration
 * site, because the site name is an implementation detail of the probe's SQL
 * while the kind is what a requirement is written about.
 */
export interface MetaArtifact {
	kind: string;
	id: string;
	/** The bill it hangs on, where the site has one. */
	entity: string;
	classes: string[];
	/**
	 * Its design-time Chinese name, when the family has a name column.
	 *
	 * This is the ONLY thing the name catalog is allowed to learn a name from.
	 * The previous design learned 2-6 character windows out of requirement prose
	 * instead, and on the real ledger that turned 14 objects into 7215 "names":
	 * 「这次改的是发货单的数量单位」 resolved to an internal-processing sampling
	 * field because both contained 「单的」. A window a sentence happens to contain
	 * is not an object's name.
	 */
	name?: string;
}

export interface IndexedClass {
	class: string;
	file: string | null;
	pluginType: string | null;
	bindings: ClassBinding[];
	entities: FoldedRef[];
	fields: FoldedRef[];
	chain: ChainRef[];
}

export interface ImpactIndex {
	kind: "ImpactIndex";
	at: string;
	/**
	 * Which RuntimeKey produced it. The frozen index carried no identity at all,
	 * so an index built against one Cosmic runtime (its JARs decide how the static
	 * side resolves sinks) and queried while pointing at another answered with a
	 * straight face. Recorded, reported on mismatch, never used to refuse: the
	 * static half is still mostly right and refusing would only strand the user.
	 */
	runtimeKeyId?: string;
	src: {
		at: string;
		ms: number;
		files: number;
		cpEntries?: number;
		tool?: string;
		calls: { total: number; unbound: number };
		diagnostics?: { error?: number; sample?: string[] } | null;
		classes: number;
		entityRefs: number;
		fieldRefs: number;
		entityResolution: Record<Resolution, number>;
		fieldResolution: Record<Resolution, number>;
		edges: number;
		chain: { classes: number; keys: number };
		unknownSigs: string[];
	};
	meta: {
		at: string;
		ms: number;
		scanned: number;
		bindings: number;
		foreign: number;
		templates: number;
		fields: number;
		fieldsMs: number;
		/** Registration sites this scan covered; absent means the pre-2026-09-04 three. */
		sites?: string[];
		/**
		 * Kept bindings per registration site.
		 *
		 * Reported for EVERY scanned site, zero included. The build output used to
		 * print one line about print templates and nothing about task / api /
		 * convert / workflow, so a reader -- a person or a model -- inferred from
		 * the silence that those four families had no bindings at all. They had 173.
		 * A count of 0 next to a site name is a fact; an absent line is a guess.
		 */
		bySite?: Record<string, number>;
		/**
		 * How many kept bindings carried their own number (`layout`).
		 *
		 * Zero on a scan that covered artifact-bearing sites means the numbers were
		 * dropped somewhere -- almost always a `--src-only` build reusing a metadata
		 * cache written before retention. See `artifactGap`.
		 */
		numbers?: number;
		/** Every field of the asked bills is in `fields` (see `MetaIndex.fieldsAll`). */
		fieldsAll?: boolean;
		patchedAt?: string;
		/** Attached when the index is read, from the files beside the snapshot; never written into impact.json. */
		check?: MetaCheck;
		pending?: MetaPending;
	} | null;
	fields: FieldOwnership[];
	fieldOwners: Record<string, number>;
	/** See `MetaIndex.fieldBases`; absent on indexes built before. */
	fieldBases?: Record<string, FieldBase>;
	fieldIsv?: string;
	templates: { number: string; entity: string; classes: string[]; name?: string }[];
	/**
	 * Every non-entity design-time object the metadata side saw, by its own number.
	 *
	 * Absent on indexes built before 2026-09-06. A missing field means "this index
	 * predates artifact retention", not "this project has no print templates" --
	 * readers must degrade to the coarse channel and say so, exactly as they do for
	 * `meta.sites`.
	 */
	artifacts?: MetaArtifact[];
	/**
	 * Every design-time name the registration scan read, one row per (site, number,
	 * name): objects only other modules' classes are on included, and every name an
	 * object has had (a workflow key keeps one per version). What the name catalog
	 * answers from; `artifacts[].name` is only the one shown beside a number.
	 */
	names?: MetaName[];
	/** Every ISV bill design's name (S17 7.4). */
	billNames?: BillName[];
	classes: IndexedClass[];
	entityRefs: SrcRef[];
	fieldRefs: SrcRef[];
	/**
	 * Module-internal call edges, kept so a field site can be walked back to the
	 * plugin that is registered on a bill. Absent on indexes built before calls
	 * carried lines; `indexStaleReason` rebuilds those.
	 */
	edges?: SrcEdge[];
	/** Calls out of the transaction, by method; absent on indexes built before they were recorded. */
	effects?: SrcEffect[];
	/** Calls into project methods with their arguments' origins; absent on indexes built before. */
	callArgs?: SrcCall[];
}

// ---------------------------------------------------------------- merging

function foldRefs(rows: readonly SrcRef[], keyName: "entity" | "field"): FoldedRef[] {
	const map = new Map<string, FoldedRef>();
	for (const row of rows) {
		const key = [row[keyName] ?? "", row.access, row.resolution].join(" ");
		const current = map.get(key);
		if (current) current.count++;
		else map.set(key, { key: row[keyName] ?? null, access: row.access, resolution: row.resolution, count: 1 });
	}
	return [...map.values()].sort(
		(a, b) => String(a.key).localeCompare(String(b.key)) || String(a.access).localeCompare(String(b.access)),
	);
}

function tallyResolution(rows: readonly SrcRef[]): Record<Resolution, number> {
	const tally: Record<Resolution, number> = { literal: 0, constant: 0, origin: 0, dynamic: 0, none: 0 };
	for (const row of rows) {
		const key = row.resolution as Resolution;
		if (key in tally) tally[key] += 1;
	}
	return tally;
}

const EMPTY_SET: ReadonlySet<string> = new Set<string>();

/**
 * Cross-class call-chain propagation: plugin A calls `FormUtil.setXxx()` and the
 * real `setValue` lives in the utility class -- without this layer that class is
 * never recalled. Walk the module-internal call edges out of the entry class's
 * methods and collect the resolved entities/fields found in OTHER classes'
 * methods, recording who it went through and how many hops.
 *
 * The trap: **edges are per method, not per class.** One utility class holds
 * dozens of methods each touching a different bill (`HardnessUtil` alone touches
 * seven), so propagating per class would claim the caller touches every entity
 * that utility class has ever touched.
 *
 * Measured on the real project (521 sources / 2,012 edges): per-method
 * propagation adds only 178 identifiers over 110 classes, at most 6 for any one
 * class -- it does not inflate the impact surface. The gain is concentrated in
 * the first hop (146 of the 178) and converges by the third, so there is no depth
 * limit: it stops on its own.
 */
function buildChains(src: SrcIndex): Map<string, ChainRef[]> {
	const classOf = new Map<string, string>(); // method id -> outermost class
	const out = new Map<string, string[]>(); // method id -> called method ids
	for (const edge of src.edges ?? []) {
		classOf.set(edge.from, edge.fromClass);
		classOf.set(edge.to, edge.toClass);
		const list = out.get(edge.from);
		if (list) list.push(edge.to);
		else out.set(edge.from, [edge.to]);
	}
	const methodsOf = new Map<string, Set<string>>();
	const put = (method: string | null | undefined, cls: string) => {
		if (!method) return;
		if (!classOf.has(method)) classOf.set(method, cls);
		const key = classOf.get(method) as string;
		const set = methodsOf.get(key);
		if (set) set.add(method);
		else methodsOf.set(key, new Set([method]));
	};
	for (const [method, cls] of [...classOf]) put(method, cls);

	const refsByMethod = new Map<string, { level: "entity" | "field"; key: string; access: Access }[]>();
	const own = new Map<string, Set<string>>();
	const feed = (rows: readonly SrcRef[] | undefined, level: "entity" | "field", keyName: "entity" | "field") => {
		for (const row of rows ?? []) {
			put(row.inMethod, row.class);
			const key = row[keyName];
			if (!RESOLVED.has(String(row.resolution)) || !key) continue;
			const stamp = [level, key, row.access].join(" ");
			const set = own.get(row.class);
			if (set) set.add(stamp);
			else own.set(row.class, new Set([stamp]));
			if (!row.inMethod) continue;
			const list = refsByMethod.get(row.inMethod);
			const entry = { level, key, access: row.access };
			if (list) list.push(entry);
			else refsByMethod.set(row.inMethod, [entry]);
		}
	};
	feed(src.entityRefs, "entity", "entity");
	feed(src.fieldRefs, "field", "field");

	const chains = new Map<string, ChainRef[]>();
	for (const [cls, methods] of methodsOf) {
		const seen = new Set(methods);
		let frontier = [...methods];
		const got = new Map<string, ChainRef>();
		for (let hop = 1; frontier.length > 0; hop++) {
			const next: string[] = [];
			for (const method of frontier) {
				for (const target of out.get(method) ?? []) {
					if (seen.has(target)) continue;
					seen.add(target);
					next.push(target);
					if (classOf.get(target) === cls) continue; // a loop inside one class is not cross-class
					for (const ref of refsByMethod.get(target) ?? []) {
						const stamp = [ref.level, ref.key, ref.access].join(" ");
						if ((own.get(cls) ?? EMPTY_SET).has(stamp) || got.has(stamp)) continue;
						got.set(stamp, {
							level: ref.level,
							key: ref.key,
							access: ref.access,
							hops: hop,
							via: classOf.get(target) as string,
							viaMethod: target,
						});
					}
				}
			}
			frontier = next;
		}
		if (got.size > 0) {
			chains.set(
				cls,
				[...got.values()].sort(
					(a, b) =>
						a.hops - b.hops || a.level.localeCompare(b.level) || String(a.key).localeCompare(String(b.key)),
				),
			);
		}
	}
	return chains;
}

const WRAP_DEPTH = 4;

/**
 * Rebase an origin computed inside a callee onto one call: a parameter becomes
 * the argument passed there; the callee's own bill or member only stays one when
 * caller and callee are the same class.
 */
export function rebaseOrigin(origin: string | null | undefined, call: SrcCall, calleeClass: string): string {
	const o = origin ?? "?:没记来源";
	const param = /^(bill)?param:(\d+)$/.exec(o);
	if (param) {
		const arg = call.args[Number(param[2])];
		if (!param[1]) return arg ?? "?:调用处传的实参没记来源";
		if (arg?.startsWith("key:")) return `bill:${arg.slice(4)}`;
		if (arg?.startsWith("param:")) return `bill${arg}`;
		return "?:调用处传的单据标识不是常量";
	}
	if (o.startsWith("prop:")) {
		const slash = o.indexOf("/");
		return `${o.slice(0, slash + 1)}${rebaseOrigin(o.slice(slash + 1), call, calleeClass)}`;
	}
	if ((o === "own" || o.startsWith("member:")) && call.fromClass !== calleeClass) return "?:别的类自己的数据";
	return o;
}

/**
 * A wrapper that writes a field it is handed -- `setValue(row, i, KEY, v)` calling
 * `getModel().setValue(key, v, i)` -- leaves its sink with a dynamic key, so every
 * field written through it used to be invisible (23 on one test-bill plugin). Each
 * call passing a constant names the field: the ref is recorded at that call (the
 * line where the field is named), its object rebased onto the caller's arguments.
 * A key passed on as the caller's own parameter goes one level further up.
 */
export function wrapperRefs(src: SrcIndex): SrcRef[] {
	const callsTo = new Map<string, SrcCall[]>();
	for (const call of src.callArgs ?? []) {
		const list = callsTo.get(call.to);
		if (list) list.push(call);
		else callsTo.set(call.to, [call]);
	}
	const out: SrcRef[] = [];
	let pending = src.fieldRefs.filter(
		(r) => r.resolution === "dynamic" && r.keyFrom?.startsWith("param:") && r.inMethod,
	);
	for (let depth = 0; depth < WRAP_DEPTH && pending.length > 0; depth++) {
		const next: SrcRef[] = [];
		for (const ref of pending) {
			const n = Number(String(ref.keyFrom).slice("param:".length));
			for (const call of callsTo.get(ref.inMethod as string) ?? []) {
				const arg = call.args[n];
				if (!arg) continue;
				const base: SrcRef = {
					class: call.fromClass,
					access: ref.access,
					resolution: "constant",
					via: ref.via ?? null,
					line: call.line,
					inMethod: call.from,
					obj: rebaseOrigin(ref.obj, call, ref.class),
					through: ref.through ?? ref.inMethod ?? null,
				};
				if (arg.startsWith("key:")) out.push({ ...base, field: arg.slice(4) });
				else if (arg.startsWith("param:")) next.push({ ...base, field: null, resolution: "dynamic", keyFrom: arg });
			}
		}
		pending = next;
	}
	return out;
}

const openMemo = new WeakMap<object, UnresolvedRef[]>();

/**
 * Every place whose bill or field the scan could not name, with its line: a key in
 * a variable, a read by column index, a save of objects from nowhere known. A
 * wrapper's parameter key is open where a call hands it something that is neither
 * a constant nor the caller's own parameter -- the calls passing a constant were
 * named by `wrapperRefs`, and counting the wrapper itself said "not complete" of
 * an answer that was. A wrapper nothing in the project calls stays open at its sink.
 */
export function openRefs(index: Pick<ImpactIndex, "entityRefs" | "fieldRefs" | "callArgs">): UnresolvedRef[] {
	const memo = openMemo.get(index);
	if (memo) return memo;
	const site = (row: SrcRef, level: UnresolvedRef["level"]): UnresolvedRef => ({
		class: row.class,
		level,
		access: row.access,
		resolution: row.resolution,
		method: row.inMethod ?? null,
		line: row.line ?? null,
		via: row.via ?? null,
		expr: row.resolution === "dynamic" ? (row.expr ?? null) : null,
		through: row.through ?? null,
		obj: row.obj ?? null,
	});
	const out = index.entityRefs
		.filter((row) => !RESOLVED.has(String(row.resolution)))
		.map((row) => site(row, "entity"));
	const callsTo = new Map<string, SrcCall[]>();
	for (const call of index.callArgs ?? []) {
		const list = callsTo.get(call.to);
		if (list) list.push(call);
		else callsTo.set(call.to, [call]);
	}
	let pending: SrcRef[] = [];
	for (const row of index.fieldRefs) {
		if (row.through || RESOLVED.has(String(row.resolution))) continue;
		if (row.resolution === "dynamic" && row.keyFrom?.startsWith("param:") && row.inMethod) pending.push(row);
		else out.push(site(row, "field"));
	}
	for (let depth = 0; depth < WRAP_DEPTH && pending.length > 0; depth++) {
		const next: SrcRef[] = [];
		for (const row of pending) {
			const calls = callsTo.get(row.inMethod as string) ?? [];
			if (calls.length === 0) out.push(site(row, "field"));
			const n = Number(String(row.keyFrom).slice("param:".length));
			for (const call of calls) {
				const arg = call.args[n] ?? null;
				if (arg?.startsWith("key:")) continue;
				const at: SrcRef = {
					...row,
					class: call.fromClass,
					inMethod: call.from,
					line: call.line,
					through: row.through ?? row.inMethod ?? null,
					expr: null,
					obj: rebaseOrigin(row.obj, call, row.class),
				};
				if (arg?.startsWith("param:")) next.push({ ...at, keyFrom: arg });
				else out.push(site(at, "field"));
			}
		}
		pending = next;
	}
	for (const row of pending) out.push(site(row, "field"));
	// A wrapper with four sinks behind one call is still one place to read.
	const seen = new Set<string>();
	const unique = out.filter((row) => {
		const key = [row.class, row.level, row.method, row.line, row.access, row.via, row.expr, row.through].join("|");
		return seen.has(key) ? false : (seen.add(key), true);
	});
	openMemo.set(index, unique);
	return unique;
}

/**
 * `save(数组)` / `update(对象)` carry no bill key in their signature, so every such
 * write used to be "signature has no identifier". The bill is where the saved
 * objects came from: loaded or created by name, or the plugin's own bill when it
 * is registered on exactly one.
 */
function settleSaves(rows: readonly SrcRef[], meta: MetaIndex | null): SrcRef[] {
	const bound = new Map<string, Set<string>>();
	for (const binding of meta?.bindings ?? []) {
		if (!binding.entity) continue;
		const set = bound.get(binding.class) ?? new Set<string>();
		set.add(binding.entity);
		bound.set(binding.class, set);
	}
	return rows.map((row) => {
		if (row.resolution !== "none" || !row.obj) return row;
		const own = bound.get(row.class);
		const bill = row.obj.startsWith("bill:")
			? row.obj.slice("bill:".length)
			: row.obj === "own" && own?.size === 1
				? ([...own][0] as string)
				: null;
		return bill ? { ...row, entity: bill, resolution: "origin" } : row;
	});
}

/**
 * Static index + metadata index -> one ImpactIndex. `meta` may be null: the
 * static side runs offline and the metadata side needs a live connection, and
 * neither may be a precondition for the other.
 */
export function mergeIndex(
	raw: SrcIndex,
	meta: MetaIndex | null,
	at: string = new Date().toISOString(),
	runtimeKeyId?: string,
): ImpactIndex {
	if (!raw || raw.kind !== "SrcIndex") throw new Error(`不是 SrcIndex（kind=${raw?.kind}）`);
	const src: SrcIndex = {
		...raw,
		entityRefs: settleSaves(raw.entityRefs, meta),
		fieldRefs: [...raw.fieldRefs, ...wrapperRefs(raw)],
	};
	const byClass = new Map<string, IndexedClass>();
	for (const cls of src.classes) {
		byClass.set(cls.class, {
			class: cls.class,
			file: cls.file ?? null,
			pluginType: cls.pluginType ?? null,
			bindings: [],
			entities: [],
			fields: [],
			chain: [],
		});
	}
	const own = (name: string): IndexedClass => {
		let hit = byClass.get(name);
		if (!hit) {
			hit = { class: name, file: null, pluginType: null, bindings: [], entities: [], fields: [], chain: [] };
			byClass.set(name, hit);
		}
		return hit;
	};

	const entityRows = new Map<string, SrcRef[]>();
	const fieldRows = new Map<string, SrcRef[]>();
	for (const row of src.entityRefs) {
		own(row.class);
		const list = entityRows.get(row.class);
		if (list) list.push(row);
		else entityRows.set(row.class, [row]);
	}
	for (const row of src.fieldRefs) {
		own(row.class);
		const list = fieldRows.get(row.class);
		if (list) list.push(row);
		else fieldRows.set(row.class, [row]);
	}
	for (const [cls, rows] of entityRows) own(cls).entities = foldRefs(rows, "entity");
	for (const [cls, rows] of fieldRows) own(cls).fields = foldRefs(rows, "field");

	const chains = buildChains(src);
	let chainKeys = 0;
	for (const [cls, list] of chains) {
		if (!byClass.has(cls)) continue; // both ends of an edge are in-module, so unreachable in theory
		own(cls).chain = list;
		chainKeys += list.length;
	}

	// A class registered in the metadata is not necessarily in this project's
	// sources: the shared environment runs other modules and other people's code
	// under the same package names, and the metadata also holds same-shaped strings
	// that were never class names at all. This project cannot change them, so
	// letting them in would only inflate "impact" -- but they are counted and
	// reported, because dropping them silently is misreporting coverage.
	const declared = new Set(src.classes.map((c) => c.class));
	// site + number -> design-time name. Keyed by site rather than by number alone
	// because one number can repeat across families (a task code and an API code
	// are drawn from different pools and nothing stops them colliding).
	const nameOf = new Map<string, string>();
	for (const row of meta?.names ?? []) nameOf.set(`${row.site} ${row.id}`, row.name);
	let bindings = 0;
	let numbers = 0;
	const bySite: Record<string, number> = {};
	const foreign = new Set<string>();
	const folded = new Map<
		string,
		{ class: string; entity: string; kind?: string; layouts: number; enabled: boolean; numbers: Set<string> }
	>();
	// Artifact identity is (kind, number): one print template is one object no
	// matter how many plugins register on it, and the classes list is what makes
	// "who else is on template 21" answerable without a second scan.
	const artifacts = new Map<string, MetaArtifact>();
	for (const binding of meta?.bindings ?? []) {
		if (!declared.has(binding.class)) {
			foreign.add(binding.class);
			continue;
		}
		bindings++;
		const site = String(binding.kind ?? "");
		bySite[site] = (bySite[site] ?? 0) + 1;
		if (binding.layout) numbers++;
		// One entity usually has several layouts (main plus derived) and the plugin
		// is registered on each. Listing them one by one is `zlgd_sys_test_bill@form`
		// five times over -- fold to one row and keep the layout count.
		const key = [binding.class, binding.entity, binding.kind].join(" ");
		const current = folded.get(key);
		if (current) {
			current.layouts++;
			current.enabled = current.enabled || binding.enabled !== false;
			if (binding.layout) current.numbers.add(binding.layout);
		} else {
			folded.set(key, {
				class: binding.class,
				entity: binding.entity,
				kind: binding.kind,
				layouts: 1,
				enabled: binding.enabled !== false,
				numbers: new Set(binding.layout ? [binding.layout] : []),
			});
		}
		const artifactKind = ARTIFACT_KIND_OF_SITE[String(binding.kind ?? "")];
		if (artifactKind && binding.layout) {
			const id = `${artifactKind} ${binding.layout}`;
			const row = artifacts.get(id);
			if (row) {
				if (!row.classes.includes(binding.class)) row.classes.push(binding.class);
			} else {
				const name = nameOf.get(`${binding.kind} ${binding.layout}`);
				artifacts.set(id, {
					kind: artifactKind,
					id: binding.layout,
					entity: binding.entity,
					classes: [binding.class],
					...(name ? { name } : {}),
				});
			}
		}
	}
	for (const binding of folded.values()) {
		own(binding.class).bindings.push({
			entity: binding.entity,
			kind: binding.kind,
			layouts: binding.layouts,
			enabled: binding.enabled,
			// Capped: a workflow plugin can be registered on dozens of versions of one
			// process, and the index is read into a model's context.
			numbers: [...binding.numbers].sort().slice(0, ARTIFACT_NUMBER_CAP),
		});
	}

	return {
		kind: "ImpactIndex",
		at,
		...(runtimeKeyId === undefined ? {} : { runtimeKeyId }),
		src: {
			at: src.at,
			ms: src.ms,
			files: src.files,
			cpEntries: src.cpEntries,
			...(src.tool === undefined ? {} : { tool: src.tool }),
			calls: src.calls,
			diagnostics: src.diagnostics ?? null,
			classes: src.classes.length,
			entityRefs: src.entityRefs.length,
			fieldRefs: src.fieldRefs.length,
			entityResolution: tallyResolution(src.entityRefs),
			fieldResolution: tallyResolution(src.fieldRefs),
			edges: (src.edges ?? []).length,
			chain: { classes: [...chains.keys()].filter((c) => byClass.has(c)).length, keys: chainKeys },
			unknownSigs: src.unknownSigs ?? [],
		},
		meta: meta
			? {
					at: meta.at,
					ms: meta.ms,
					scanned: meta.scanned,
					bindings,
					foreign: foreign.size,
					templates: (meta.templates ?? []).length,
					fields: (meta.fields ?? []).length,
					fieldsMs: meta.fieldsMs ?? 0,
					sites: [...(meta.sites ?? SITES_BEFORE_2026_09_04)],
					bySite,
					numbers,
					...(meta.fieldsAll ? { fieldsAll: true } : {}),
					...(meta.patchedAt ? { patchedAt: meta.patchedAt } : {}),
				}
			: null,
		// Field ownership: **a field identifier is unique only within one bill**;
		// without this layer `impact <field>` is a union over same-named fields.
		fields: meta?.fields ?? [],
		// How many bills in the whole library carry this key -- answers "does this
		// key point at one bill", and has nothing to do with the whitelist.
		fieldOwners: meta?.fieldOwners ?? {},
		...(meta?.fieldBases === undefined ? {} : { fieldBases: meta.fieldBases }),
		...(meta?.fieldIsv === undefined ? {} : { fieldIsv: meta.fieldIsv }),
		// Print templates: the template code is itself what a person says when
		// asking for something ("the 58 template prints wrong").
		templates: (meta?.templates ?? []).map((t) => {
			const name = nameOf.get(`print ${t.number}`);
			return {
				number: t.number,
				entity: t.entity,
				classes: (t.classes ?? []).filter((c) => byClass.has(c)),
				...(name ? { name } : {}),
			};
		}),
		// Only artifacts this project's own code registers on: an impact surface is
		// this project's classes, and a template none of them is on is not part of it.
		// Its name still reaches the name catalog through `names`.
		artifacts: [...artifacts.values()]
			.map((row) => ({ ...row, classes: row.classes.filter((c) => byClass.has(c)) }))
			.filter((row) => row.classes.length > 0)
			.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id)),
		names: distinctNames(meta?.names ?? []),
		billNames: meta?.billNames ?? [],
		classes: [...byClass.values()].sort((a, b) => a.class.localeCompare(b.class)),
		// Detail is kept in full: dynamic entries must stay enumerable, not collapse to a count.
		entityRefs: src.entityRefs,
		fieldRefs: src.fieldRefs,
		edges: src.edges ?? [],
		effects: src.effects ?? [],
		callArgs: src.callArgs ?? [],
	};
}

/** One row per (site, number, name): the probe reports a name once per design row, and a workflow has a row per version. */
function distinctNames(names: readonly MetaName[]): MetaName[] {
	const seen = new Set<string>();
	return names.filter((row) => {
		const key = `${row.site} ${row.id} ${row.name}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

export const simpleName = (fqn: string): string => String(fqn).split(".").pop() as string;

/** `a.b.Util#dealRate(DataSet, Date)` -> `Util#dealRate`. */
export const shortMethod = (id: string): string => {
	const [cls, rest] = id.split("#");
	return `${simpleName(cls ?? "")}#${(rest ?? "").split("(")[0]}`;
};

/**
 * `快照 09-23，10 天前`: the date every hint resting on the metadata snapshot
 * carries. A registration made after the scan is not in it, and without the date
 * "查不到登记" reads as "not registered".
 */
export function snapshotLabel(index: Pick<ImpactIndex, "meta">, now: number): string {
	const at = snapshotAsOf(index);
	if (!at) return "没有元数据快照";
	const days = Math.floor((now - Date.parse(at)) / 86_400_000);
	const behind = snapshotBehind(index);
	return `快照 ${at.slice(5, 10)}${days >= 1 ? `，${days} 天前` : ""}${behind ? `，${behind}` : ""}`;
}

/**
 * The time the snapshot is good as of: a check that found nothing, or patched
 * everything it found, moves it forward from the build. Null without a snapshot.
 */
export function snapshotAsOf(index: Pick<ImpactIndex, "meta">): string | null {
	const meta = index.meta;
	if (!meta?.at) return null;
	const check = meta.check;
	const settled = check && (check.state === "same" || check.state === "patched") ? check.at : "";
	return [meta.at, meta.patchedAt ?? "", settled].sort().at(-1) as string;
}

/** What is known to be missing from the snapshot, or "" when nothing is. */
export function snapshotBehind(index: Pick<ImpactIndex, "meta">): string {
	const meta = index.meta;
	if (!meta) return "";
	const pending = meta.pending;
	if (pending && pending.at > (meta.check?.at ?? meta.at)) return "之后本机写过元数据，还没补进来";
	if (meta.check?.state === "over") return `之后有 ${meta.check.changed} 处变化没补`;
	return "";
}

const monthDay = (iso: string): string => iso.slice(5, 10);
const REINDEX = "cosmic_doctor action=reindex";

/**
 * The first line of a class or bill answer: when the snapshot was built and what
 * is known about it since. Every unknown is said as one: "not checked" is not
 * "unchanged".
 */
export function snapshotStatus(index: Pick<ImpactIndex, "meta">, now: number): string {
	const meta = index.meta;
	if (!meta?.at) return "没有元数据快照：插件挂在哪、字段属于哪张单都查不到";
	const parts = [`元数据快照 ${monthDay(meta.at)} 建`];
	const check = meta.check;
	if (!check) parts.push("还没查过之后有没有变化（常驻 JVM 在跑时自动查）");
	else if (check.state === "same") parts.push(`${monthDay(check.at)} 查过没变化`);
	else if (check.state === "patched") parts.push(`${monthDay(check.at)} 查到 ${check.changed} 处变化已补`);
	else if (check.state === "over") {
		parts.push(`${monthDay(check.at)} 查到 ${check.changed} 处变化，一次补不完没补，空闲时完整重建（${REINDEX}）`);
	} else if (check.state === "baseline")
		parts.push(`没记变化基线、查不了变没变，完整重建一次（${REINDEX}）后自动跟上`);
	else parts.push(`${monthDay(check.at)} 查变化没成：${check.text}`);
	if (meta.pending && meta.pending.at > (check?.at ?? meta.at)) {
		parts.push(`本机 ${monthDay(meta.pending.at)} 写过元数据，还没补进来`);
	}
	const asOf = snapshotAsOf(index) as string;
	const days = Math.floor((now - Date.parse(asOf)) / 86_400_000);
	return parts.join("，") + (days >= 1 ? `（截至 ${days} 天前）` : "");
}

export interface IndexLookup {
	byClass: Map<string, IndexedClass>;
	bySimple: Map<string, string[]>;
	byEntity: Map<string, string[]>;
	byField: Map<string, string[]>;
	/** `entity|field` -> ownership row. */
	fieldMeta: Map<string, FieldOwnership>;
	/** field key -> the bills THIS project's code touches that carry it. */
	fieldOn: Map<string, string[]>;
	/** Bills the metadata snapshot listed fields for, including ones no class names in code. */
	fieldEntities: Set<string>;
	byTemplate: Map<string, { number: string; entity: string; classes: string[]; name?: string }>;
	/** Artifact number -> the object(s) carrying it. A number can repeat across kinds, so the value is a list. */
	byArtifact: Map<string, MetaArtifact[]>;
	/** A form layout's own number (not the entity's) -> its entity and the project classes registered on it. */
	byLayout: Map<string, { entity: string; classes: string[] }>;
	fieldOwners: Record<string, number>;
	/**
	 * Every field each bill in `fieldEntities` declares in its own design is in `fieldMeta`.
	 * Inherited ones are not: whether a missing one is really not on the bill is `knownAbsent`.
	 */
	fieldsAll: boolean;
	fieldBases: Readonly<Record<string, FieldBase>>;
	fieldIsv: string;
}

export function lookup(index: ImpactIndex): IndexLookup {
	const byClass = new Map<string, IndexedClass>();
	const bySimple = new Map<string, string[]>();
	const byEntity = new Map<string, string[]>();
	const byField = new Map<string, string[]>();
	const fieldMeta = new Map<string, FieldOwnership>();
	const fieldOn = new Map<string, string[]>();
	const fieldEntities = new Set<string>();
	const byTemplate = new Map<string, { number: string; entity: string; classes: string[]; name?: string }>();
	const byArtifact = new Map<string, MetaArtifact[]>();
	for (const artifact of index.artifacts ?? []) {
		const list = byArtifact.get(artifact.id);
		if (list) list.push(artifact);
		else byArtifact.set(artifact.id, [artifact]);
	}
	for (const row of index.fields ?? []) {
		fieldMeta.set(`${row.entity}|${row.key}`, row);
		fieldEntities.add(row.entity);
		const on = fieldOn.get(row.key);
		if (!on) fieldOn.set(row.key, [row.entity]);
		else if (!on.includes(row.entity)) on.push(row.entity);
	}
	for (const template of index.templates ?? []) byTemplate.set(template.number, template);
	const byLayout = new Map<string, { entity: string; classes: string[] }>();
	const push = (map: Map<string, string[]>, key: string | null | undefined, value: string) => {
		if (!key) return;
		const list = map.get(key);
		if (!list) map.set(key, [value]);
		else if (!list.includes(value)) list.push(value);
	};
	for (const cls of index.classes) {
		byClass.set(cls.class, cls);
		push(bySimple, simpleName(cls.class), cls.class);
		for (const binding of cls.bindings) {
			push(byEntity, binding.entity, cls.class);
			if (binding.kind !== undefined && binding.kind !== "form") continue;
			for (const number of binding.numbers) {
				if (number === binding.entity) continue;
				const layout = byLayout.get(number) ?? { entity: binding.entity, classes: [] };
				if (!layout.classes.includes(cls.class)) layout.classes.push(cls.class);
				byLayout.set(number, layout);
			}
		}
		for (const entity of cls.entities) push(byEntity, entity.key, cls.class);
		for (const field of cls.fields) push(byField, field.key, cls.class);
		// Chain hits must be reverse-findable too, or "who touched zlgd_feedback"
		// misses every class that does its work through a utility class.
		for (const ref of cls.chain ?? []) push(ref.level === "entity" ? byEntity : byField, ref.key, cls.class);
	}
	return {
		byClass,
		bySimple,
		byEntity,
		byField,
		fieldMeta,
		fieldOn,
		fieldEntities,
		byTemplate,
		byArtifact,
		byLayout,
		fieldOwners: index.fieldOwners ?? {},
		fieldsAll: index.meta?.fieldsAll === true,
		fieldBases: index.fieldBases ?? {},
		fieldIsv: index.fieldIsv ?? "",
	};
}

/**
 * Whether the snapshot can say `field` is NOT on `entity`.
 *
 * Only for a bill whose own fields were all collected and whose inheritance is
 * known: every own-ISV ancestor collected too and none declares it, and any
 * template from elsewhere unable to carry it -- a key with this ISV's prefix
 * cannot sit on another ISV's or the platform's template. `billno` on a bill
 * built on `bos_billtpl` is therefore never "not on it".
 */
export function knownAbsent(lk: IndexLookup, entity: string, field: string): boolean {
	if (!lk.fieldsAll || !lk.fieldEntities.has(entity) || lk.fieldMeta.has(`${entity}|${field}`)) return false;
	const base = lk.fieldBases[entity];
	if (base === undefined) return false;
	for (const parent of base.parents ?? []) {
		if (!lk.fieldEntities.has(parent) || lk.fieldMeta.has(`${parent}|${field}`)) return false;
	}
	return base.outside === undefined || (lk.fieldIsv !== "" && field.startsWith(`${lk.fieldIsv}_`));
}

/** Why a field missing from the snapshot may still be on the bill: what it inherits from. */
export function inheritedNote(lk: IndexLookup, entity: string): string {
	const base = lk.fieldBases[entity];
	const from = [...(base?.parents ?? []), ...(base?.outside ? [base.outside] : [])];
	return from.length > 0 ? `；${entity} 继承自 ${from.join("、")}，继承来的字段快照里不收` : "";
}

/** Does this class touch this bill (bound / read-written directly / through a chain)? */
export const classTouchesEntity = (cls: IndexedClass | undefined, entity: string): boolean =>
	!!cls &&
	((cls.bindings ?? []).some((b) => b.entity === entity) ||
		(cls.entities ?? []).some((e) => e.key === entity) ||
		(cls.chain ?? []).some((x) => x.level === "entity" && x.key === entity));

export interface QualifiedField {
	key: string;
	entity: string;
	level?: string;
	entry?: string;
	parentEntry?: string;
	candidates: string[];
	on: number;
}

/**
 * Which bill a field belongs to, within this impact surface.
 *
 * The test: **which bills the metadata says carry it** intersected with **the
 * bills this impact surface touches**. Exactly one survivor means it is settled;
 * an empty intersection (no such field in the design-time metadata, usually a
 * control key rather than a field) or several, and it says so honestly rather
 * than picking a plausible one -- the wrong pick gets written into `touches` and
 * handed to the next person.
 */
export function qualifyField(lk: IndexLookup, entities: ReadonlySet<string>, key: string): QualifiedField {
	const on = lk.fieldOn.get(key) ?? [];
	const hit = on.filter((entity) => entities.has(entity));
	if (hit.length !== 1) return { key, entity: "", candidates: hit, on: on.length };
	const only = hit[0] as string;
	const meta = lk.fieldMeta.get(`${only}|${key}`);
	return {
		key,
		entity: only,
		level: meta?.level ?? "",
		entry: meta?.entry ?? "",
		parentEntry: meta?.parentEntry ?? "",
		candidates: hit,
		on: on.length,
	};
}

export interface Target {
	kind: "class" | "entity" | "field" | "template" | "artifact" | "layout";
	value: string;
	/** Set when the term qualified a field to one bill (`entity.field`); on a layout, the entity it is a layout of. */
	entity?: string;
	/** The entry / sub-entry segments written between bill and field (`entity.entry.field`), as given. */
	path?: string[];
	/** For `artifact`: which kind of object the number names (print_template / task / open_api / botp_rule / workflow). */
	artifactKind?: string;
}

/**
 * A term may be a fully-qualified class name, a simple class name, a source path
 * or an entity identifier -- the user is not required to sort that out first.
 * When one term hits both a class and an entity, both are returned and the caller
 * prints them together.
 */
export function resolveTarget(index: ImpactIndex, term: string, lk: IndexLookup = lookup(index)): Target[] {
	const text = String(term ?? "").trim();
	if (!text) return [];
	const out: Target[] = [];
	if (lk.byClass.has(text)) out.push({ kind: "class", value: text });
	for (const fqn of lk.bySimple.get(text) ?? []) out.push({ kind: "class", value: fqn });
	if (/[\\/]/.test(text) || text.endsWith(".java")) {
		const norm = text.replace(/\\/g, "/");
		for (const cls of index.classes) {
			if (cls.file && (cls.file === norm || cls.file.endsWith(`/${norm}`) || norm.endsWith(`/${cls.file}`))) {
				out.push({ kind: "class", value: cls.class });
			}
		}
	}
	if (lk.byEntity.has(text)) out.push({ kind: "entity", value: text });
	// A layout is what a requirement and FormSim name ("zlgd_wtd_xnl 上加个按钮"); the
	// registrations already carry it. Only layouts with a project plugin are known.
	const layout = lk.byLayout.get(text);
	if (layout) out.push({ kind: "layout", value: text, entity: layout.entity });
	// A field is a legitimate entry point too: when the user says "zlgd_modi_qywz
	// prints wrong" that word is all they have, and byField is already built.
	if (lk.byField.has(text)) out.push({ kind: "field", value: text });
	if (lk.byTemplate.has(text)) out.push({ kind: "template", value: text });
	// A scheduled task code, an API number, a BOTP rule id, a workflow key: all of
	// them are things people say out loud, and none of them used to resolve to
	// anything at all -- `impact <任务编码>` answered "not in the index".
	for (const artifact of lk.byArtifact.get(text) ?? []) {
		if (artifact.kind === "print_template" && lk.byTemplate.has(text)) continue;
		out.push({
			kind: "artifact",
			value: text,
			artifactKind: artifact.kind,
			...(artifact.entity ? { entity: artifact.entity } : {}),
		});
	}
	// `entity.field` / `entity.entry.field` -- the only writing that pins a
	// same-named field to one bill. A fully-qualified class name has dots too, but
	// its first segment is never an entity identifier, so they cannot collide.
	// Either half may be known from the metadata snapshot alone: a bill no class
	// loads by name is still a bill, and a field that sits on another bill is
	// reported as such by the field trace rather than dropped here.
	const split = splitQualified(text, lk);
	if (split?.entityKnown && split.fieldKnown) {
		out.push({
			kind: "field",
			value: split.field,
			entity: split.entity,
			...(split.path.length > 0 ? { path: split.path } : {}),
		});
	}
	const seen = new Set<string>();
	return out.filter((target) => {
		const key = [
			target.kind,
			target.value,
			target.entity ?? "",
			target.artifactKind ?? "",
			...(target.path ?? []),
		].join(" ");
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

/**
 * `entity.field` / `entity.entry.field` split, with whether each half is known to
 * the code or the snapshot. The segments between are returned as `path`; whether
 * they are right is the field trace's question, against where the snapshot puts the field.
 */
export function splitQualified(
	text: string,
	lk: IndexLookup,
): { entity: string; field: string; path: string[]; entityKnown: boolean; fieldKnown: boolean } | null {
	const segments = text.split(".");
	const entity = segments[0] ?? "";
	const field = segments[segments.length - 1] ?? "";
	if (segments.length < 2 || !entity || !field) return null;
	return {
		entity,
		field,
		path: segments.slice(1, -1),
		entityKnown: lk.byEntity.has(entity) || lk.fieldEntities.has(entity),
		fieldKnown: lk.byField.has(field) || lk.fieldOn.has(field),
	};
}

/**
 * When the index does not have the term, offer the closest real name -- the same
 * rule lint follows. impact used to answer only "not in the index", while the
 * most common cause is a letter or a case difference.
 *
 * The tests run strict to loose, and it would rather return nothing than open a
 * "looks like it but is not" hole: working from a guessed name costs far more
 * than stopping to ask.
 */
function levenshtein(a: string, b: string): number {
	if (Math.abs(a.length - b.length) > 2) return 99;
	let prev = [...Array(b.length + 1).keys()];
	for (let i = 1; i <= a.length; i++) {
		const cur = [i];
		for (let j = 1; j <= b.length; j++) {
			cur[j] = Math.min(
				(prev[j] as number) + 1,
				(cur[j - 1] as number) + 1,
				(prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
			);
		}
		prev = cur;
	}
	return prev[b.length] as number;
}

export interface Suggestion {
	kind: "class" | "entity" | "field";
	value: string;
	rank: number;
}

export function suggest(index: ImpactIndex, term: string, lk: IndexLookup = lookup(index), limit = 5): Suggestion[] {
	const text = String(term ?? "").trim();
	if (text.length < 3) return [];
	const low = text.toLowerCase();
	const pool: { kind: "class" | "entity" | "field"; value: string }[] = [
		...[...lk.byClass.keys()].map((value) => ({ kind: "class" as const, value })),
		...[...lk.bySimple.keys()].map((value) => ({ kind: "class" as const, value })),
		...[...lk.byEntity.keys()].map((value) => ({ kind: "entity" as const, value })),
		...[...lk.byField.keys()].map((value) => ({ kind: "field" as const, value })),
	];
	const out: Suggestion[] = [];
	for (const candidate of pool) {
		const value = String(candidate.value).toLowerCase();
		let rank = 9;
		if (value === low)
			rank = 0; // case only
		else if (value.endsWith(`.${low}`) || low.endsWith(`.${value}`))
			rank = 1; // a package prefix apart
		else if (text.length >= 4 && (value.includes(low) || low.includes(value))) rank = 2;
		else if (text.length >= 4 && levenshtein(value, low) <= 2) rank = 3; // a letter or two apart
		if (rank < 9) out.push({ ...candidate, rank });
	}
	const seen = new Set<string>();
	return out
		.sort((a, b) => a.rank - b.rank || a.value.length - b.value.length || a.value.localeCompare(b.value))
		.filter((x) => {
			if (seen.has(x.value)) return false;
			seen.add(x.value);
			return true;
		})
		.slice(0, limit);
}

export interface ImpactKey {
	key: string;
	/** How it was reached: 绑定 / 写 / 读 / 入口 / 读·经Xxx, joined by "/". */
	how: string;
}

/** One place whose bill or field the scan could not name (`openRefs`). */
export interface UnresolvedRef {
	class: string;
	level: "entity" | "field";
	access: Access;
	resolution: Resolution | string;
	method: string | null;
	line: number | null;
	/** The sink called; at a call into a wrapper, `through` names the wrapper. */
	via: string | null;
	/** The key argument as written, on a key held in a variable. */
	expr: string | null;
	through: string | null;
	/** Where the object came from, as on `SrcRef.obj`: a known other bill rules the place out for a field. */
	obj: string | null;
}

export interface Impact {
	targets: Target[];
	classes: IndexedClass[];
	entities: ImpactKey[];
	fields: ImpactKey[];
	templates: string[];
	/** Non-entity design-time objects this surface reaches, each still carrying its kind. */
	artifacts: MetaArtifact[];
	unresolved: UnresolvedRef[];
}

/** The impact surface: entry points spread out into classes + entities + fields, with what did not resolve kept aside. */
export function impactOf(index: ImpactIndex, targets: readonly Target[], lk: IndexLookup = lookup(index)): Impact {
	const classes: IndexedClass[] = [];
	const seen = new Set<string>();
	const add = (fqn: string) => {
		if (seen.has(fqn)) return;
		const cls = lk.byClass.get(fqn);
		if (!cls) return;
		seen.add(fqn);
		classes.push(cls);
	};
	const viaEntity = new Set<string>();
	const viaField = new Set<string>();
	const viaTemplate = new Set<string>();
	const viaArtifact = new Map<string, MetaArtifact>();
	for (const target of targets) {
		if (target.kind === "class") add(target.value);
		else if (target.kind === "entity") {
			viaEntity.add(target.value);
			for (const fqn of lk.byEntity.get(target.value) ?? []) add(fqn);
		} else if (target.kind === "field") {
			viaField.add(target.value);
			for (const fqn of lk.byField.get(target.value) ?? []) {
				// With an entity qualifier only classes that really touch that bill count,
				// otherwise `zlgd_year` merges five unrelated bills into one surface.
				if (!target.entity || classTouchesEntity(lk.byClass.get(fqn), target.entity)) add(fqn);
			}
			if (target.entity) viaEntity.add(target.entity);
		} else if (target.kind === "layout") {
			for (const fqn of lk.byLayout.get(target.value)?.classes ?? []) add(fqn);
			if (target.entity) viaEntity.add(target.entity);
		} else if (target.kind === "template") {
			viaTemplate.add(target.value);
			const template = lk.byTemplate.get(target.value);
			for (const fqn of template?.classes ?? []) add(fqn);
			if (template?.entity) viaEntity.add(template.entity);
		} else if (target.kind === "artifact") {
			for (const artifact of lk.byArtifact.get(target.value) ?? []) {
				if (target.artifactKind && artifact.kind !== target.artifactKind) continue;
				viaArtifact.set(`${artifact.kind} ${artifact.id}`, artifact);
				for (const fqn of artifact.classes) add(fqn);
				if (artifact.entity) viaEntity.add(artifact.entity);
			}
		}
	}
	const entities = new Map<string, { key: string; how: Set<string> }>();
	const fields = new Map<string, { key: string; how: Set<string> }>();
	const unresolved = openRefs(index).filter((row) => seen.has(row.class));
	const bump = (map: Map<string, { key: string; how: Set<string> }>, key: string, how: string) => {
		const current = map.get(key) ?? { key, how: new Set<string>() };
		current.how.add(how);
		map.set(key, current);
	};
	for (const cls of classes) {
		for (const binding of cls.bindings) bump(entities, binding.entity, "绑定");
		for (const entity of cls.entities) {
			if (!RESOLVED.has(String(entity.resolution))) continue;
			bump(entities, entity.key as string, entity.access === "write" ? "写" : "读");
		}
		for (const ref of cls.chain ?? []) {
			bump(
				ref.level === "entity" ? entities : fields,
				ref.key,
				`${ref.access === "write" ? "写" : "读"}·经${simpleName(ref.via)}`,
			);
		}
		for (const field of cls.fields) {
			if (!RESOLVED.has(String(field.resolution))) continue;
			bump(fields, field.key as string, field.access === "write" ? "写" : "读");
		}
	}
	// A class in the surface drags in the artifacts it is registered on: changing
	// the print plugin IS changing template 21, and a requirement anchored to the
	// template has to come back from a query that only named the class.
	for (const cls of classes) {
		for (const binding of cls.bindings) {
			const kind = ARTIFACT_KIND_OF_SITE[String(binding.kind ?? "")];
			if (!kind) continue;
			for (const number of binding.numbers ?? []) {
				const key = `${kind} ${number}`;
				const known = lk.byArtifact.get(number)?.find((row) => row.kind === kind);
				if (!viaArtifact.has(key)) {
					viaArtifact.set(key, known ?? { kind, id: number, entity: binding.entity, classes: [cls.class] });
				}
			}
		}
	}
	for (const entity of viaEntity)
		if (!entities.has(entity)) entities.set(entity, { key: entity, how: new Set(["入口"]) });
	for (const field of viaField) if (!fields.has(field)) fields.set(field, { key: field, how: new Set(["入口"]) });
	const flat = (map: Map<string, { key: string; how: Set<string> }>): ImpactKey[] =>
		[...map.values()]
			.map((v) => ({ key: v.key, how: [...v.how].join("/") }))
			.sort((a, b) => a.key.localeCompare(b.key));
	return {
		targets: [...targets],
		classes,
		entities: flat(entities),
		fields: flat(fields),
		templates: [...viaTemplate],
		artifacts: [...viaArtifact.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id)),
		unresolved,
	};
}
