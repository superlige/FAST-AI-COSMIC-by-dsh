/**
 * The answer to a field entry point (S17 batch 1): every place the code reads or
 * writes that field, with its line, and -- when the place is not in a plugin
 * registered on a bill -- the call path back to the nearest one, hop by hop.
 *
 * Why not the class surface: asked about one field, the old answer listed every
 * bill and field the touching classes ever touched (139 fields for one field on
 * the test bill) and not one line number, so the reader went off to grep. The
 * surface of a class is the class entry point's job.
 *
 * The walk goes UP the call edges, one shortest path per registered plugin, and
 * stops at the first registered class on each path. When none is reached it says
 * why -- the method is never called, the plugin on top is registered nowhere in
 * the snapshot, the snapshot is missing -- because "no plugin" and "not found"
 * read alike and only the reason tells the reader what to check.
 *
 * A site counts for the field when its key is the field, or a dotted path that
 * reaches it through entries only: `zlgd_org.number` reads `zlgd_org`, and
 * `entryentity.zlgd_x` reads `zlgd_x` -- but `zlgd_org.number` is no read of a
 * field called `number`.
 */

import { type Attribution, type Attributor, attributor, awaitsCaller } from "./attribution.ts";
import type { FieldOwnership, ImpactIndex, IndexLookup, SrcEdge, SrcRef, Target, UnresolvedRef } from "./model.ts";
import {
	classTouchesEntity,
	inheritedNote,
	knownAbsent,
	openRefs,
	shortMethod,
	simpleName,
	snapshotAsOf,
	snapshotBehind,
} from "./model.ts";

const P = "[IMPACT] ";
const RESOLVED = new Set(["literal", "constant"]);
/** Route lines shown before only counting; dynamic=true lifts every cap. */
const ROUTE_ROWS = 12;
const MISS_ROWS = 6;
/** Line numbers listed per method and access before only counting. */
const LINES_PER_METHOD = 8;
const MAX_DEPTH = 12;
const MAX_SEEN = 4000;
/** Ways up inside one plugin listed before only counting, and the walk's step budget. */
const CLIMB_PATHS = 4;
const CLIMB_STEPS = 200;
/** Classes with unnamed keys listed, and places shown in each, before only counting. */
const OPEN_CLASSES = 4;
const OPEN_PER_CLASS = 1;

export interface Hop {
	method: string;
	/** Line in `method` where it calls the next hop; null on an index built before edges carried lines. */
	line: number | null;
}

export interface Route {
	/** The registered class the path starts from. */
	entry: string;
	/** Entry method first, down to the caller of the site's method. Empty when the site is in the entry class itself. */
	hops: Hop[];
	/** Other methods of the same class that also reach the site. */
	others: number;
	/** Where along this route a parameter's object was recognised, and as what. */
	how?: string;
}

export interface SiteGroup {
	class: string;
	method: string | null;
	sites: SrcRef[];
	routes: Route[];
	/** Why no registered class was reached; null when `routes` is not empty. */
	miss: string | null;
	/** On a guessed group: why the object's bill was not recognised. */
	why?: string;
	/** On an excluded group: the bills its objects are on, when that was settled from their origin. */
	bills?: string[];
}

export interface FieldTrace {
	target: Target;
	/** The bill the sites are listed for; differs from target.entity when the field sits on exactly one other bill. */
	entity: string | null;
	/** Where the snapshot puts the field on `entity`. */
	place: FieldOwnership | null;
	/** Set when the snapshot says the field is not on target.entity: the bills it is on. */
	elsewhere: FieldOwnership[];
	/** Sites settled on `entity`: from the object's origin, or because no other bill has the key. */
	groups: SiteGroup[];
	/** Same-key sites whose object was not recognised, in a class touching `entity`: a guess by name, counted only. */
	guessed: SiteGroup[];
	/** Same-key sites left out: their object is another bill, or neither their class nor its plugin touches `entity`. */
	excluded: SiteGroup[];
	/** `快照 09-23`, for the sentences that rest on the metadata snapshot. */
	snapshot: string;
	/** Set when the entry segments the term gave do not match where the field is. */
	pathNote: string | null;
	/**
	 * Field reads and writes with a key the scan could not name, in the classes
	 * listed above and the ones touching the bill: any of them may be this field,
	 * and only the source says.
	 */
	open: UnresolvedRef[];
}

interface Walk {
	index: ImpactIndex;
	lk: IndexLookup;
	callers: Map<string, SrcEdge[]>;
	classOf: Map<string, string>;
	snapshot: string;
	/** Entry and sub-entry keys the snapshot knows, on any bill. */
	containers: Set<string>;
}

function walker(index: ImpactIndex, lk: IndexLookup): Walk {
	const callers = new Map<string, SrcEdge[]>();
	const classOf = new Map<string, string>();
	for (const edge of index.edges ?? []) {
		classOf.set(edge.from, edge.fromClass);
		classOf.set(edge.to, edge.toClass);
		const list = callers.get(edge.to);
		if (list) list.push(edge);
		else callers.set(edge.to, [edge]);
	}
	const at = snapshotAsOf(index);
	const behind = snapshotBehind(index);
	const containers = new Set((index.fields ?? []).filter((row) => row.kind === "container").map((row) => row.key));
	const snapshot = at ? `快照 ${at.slice(5, 10)}${behind ? `，${behind}` : ""}` : "没有快照";
	return { index, lk, callers, classOf, containers, snapshot };
}

/** Does a recorded key (possibly a dotted path) read or write `field`? Only entries may stand before it. */
export function keyReaches(key: string, field: string, containers: ReadonlySet<string>): boolean {
	if (key === field) return true;
	const segments = key.split(".");
	const at = segments.indexOf(field);
	return at >= 0 && segments.slice(0, at).every((segment) => containers.has(segment));
}

/** The entry segments the term gave, checked against where the field is on the bill. */
function pathNote(
	lk: IndexLookup,
	entity: string,
	place: FieldOwnership | null,
	given: readonly string[],
): string | null {
	if (given.length === 0) return null;
	const written = given.join(".");
	// The snapshot could not tell where it sits (an extension adding it to the original bill's entry): nothing to check against
	if (place?.level === "unknown") return null;
	if (place) {
		const actual =
			place.level === "subentry"
				? [place.parentEntry, place.entry].filter(Boolean)
				: place.level === "entry"
					? [place.entry]
					: [];
		const fits = written === actual.join(".") || (given.length === 1 && given[0] === actual[actual.length - 1]);
		return fits ? null : `${place.key} 在${placeText(place)}，不在 ${written}`;
	}
	const unknown = given.filter((segment) => lk.fieldMeta.get(`${entity}|${segment}`)?.kind !== "container");
	return unknown.length === 0 ? null : `快照没记到 ${entity} 上有分录 ${unknown.join("、")}`;
}

const bound = (walk: Walk, cls: string): boolean => (walk.lk.byClass.get(cls)?.bindings.length ?? 0) > 0;

function rootText(walk: Walk, method: string): string {
	const cls = walk.classOf.get(method) ?? method.split("#")[0] ?? "";
	const type = walk.lk.byClass.get(cls)?.pluginType;
	return type
		? `${simpleName(cls)} 是 ${type} 插件，没登记在任何单据上（${walk.snapshot}）`
		: `${shortMethod(method)} 没人调用（表里没有调用处；经接口、反射、平台回调的看不到）`;
}

/**
 * From a method of a registered class up through the same class's own callers,
 * to the methods nothing in that class calls -- usually the events the platform
 * fires (`propertyChanged`, `afterDoOperation`). Every way up is a route: a read
 * reached from a field change and from a button is two things a change touches,
 * and listing one let the reader conclude the other did not read the field.
 */
function climb(walk: Walk, cls: string, method: string): { paths: Hop[][]; more: number } {
	const paths: Hop[][] = [];
	let more = 0;
	let steps = 0;
	const up = (cur: string, above: Hop[], seen: ReadonlySet<string>): void => {
		const callers = (walk.callers.get(cur) ?? []).filter((edge) => edge.fromClass === cls && !seen.has(edge.from));
		if (callers.length === 0 || above.length >= MAX_DEPTH || ++steps > CLIMB_STEPS) {
			if (paths.length < CLIMB_PATHS) paths.push(above);
			else more++;
			return;
		}
		for (const edge of callers) {
			up(edge.from, [{ method: edge.from, line: edge.line ?? null }, ...above], new Set([...seen, edge.from]));
		}
	};
	up(method, [], new Set([method]));
	return { paths, more };
}

/** Routes from `entry` down to `method`, one per way up inside the entry class. */
function routesFrom(walk: Walk, entry: string, from: string, below: Hop[]): Route[] {
	const { paths, more } = climb(walk, entry, from);
	return paths.map((hops, at) => ({ entry, hops: [...hops, ...below], others: at === 0 ? more : 0 }));
}

function traceMethod(walk: Walk, method: string): { routes: Route[]; miss: string | null } {
	const parent = new Map<string, SrcEdge>();
	const seen = new Set([method]);
	const routes = new Map<string, Route[]>();
	let frontier = [method];
	let depth = 0;
	for (; frontier.length > 0 && depth < MAX_DEPTH && seen.size < MAX_SEEN; depth++) {
		const next: string[] = [];
		for (const at of frontier) {
			for (const edge of walk.callers.get(at) ?? []) {
				if (seen.has(edge.from)) continue;
				seen.add(edge.from);
				parent.set(edge.from, edge);
				if (!bound(walk, edge.fromClass)) {
					next.push(edge.from);
					continue;
				}
				const known = routes.get(edge.fromClass);
				if (known) {
					(known[0] as Route).others++;
					continue;
				}
				const below: Hop[] = [];
				for (let cur = edge.from; cur !== method; ) {
					const step = parent.get(cur) as SrcEdge;
					below.push({ method: cur, line: step.line ?? null });
					cur = step.to;
				}
				routes.set(edge.fromClass, routesFrom(walk, edge.fromClass, edge.from, below));
			}
		}
		frontier = next;
	}
	if (routes.size > 0) {
		return { routes: [...routes.values()].flat().sort((a, b) => a.hops.length - b.hops.length), miss: null };
	}
	if (!walk.index.meta) return { routes: [], miss: "没有元数据快照，查不到挂在哪张单" };
	if (!walk.index.edges) return { routes: [], miss: "代码关系表没记调用关系，重建后才能倒查" };
	if (frontier.length > 0) return { routes: [], miss: `往上追了 ${depth} 层还没到挂载插件，停了` };
	if ((walk.callers.get(method) ?? []).length === 0) return { routes: [], miss: rootText(walk, method) };
	const roots = [...seen].filter((m) => m !== method && (walk.callers.get(m) ?? []).length === 0);
	if (roots.length === 0) return { routes: [], miss: "调用只在几个方法之间绕圈，没走到入口" };
	return {
		routes: [],
		miss: `往上到 ${roots
			.slice(0, 2)
			.map((m) => rootText(walk, m))
			.join("；")}${roots.length > 2 ? `；等 ${roots.length} 处` : ""}`,
	};
}

/** Which bill a qualified field entry is really about, from the snapshot. */
function placeFor(
	lk: IndexLookup,
	entity: string,
	field: string,
): { entity: string; place: FieldOwnership | null; elsewhere: FieldOwnership[] } {
	const place = lk.fieldMeta.get(`${entity}|${field}`) ?? null;
	if (place) return { entity, place, elsewhere: [] };
	// Sending the reader to another bill says "not on this one": only when the snapshot can tell.
	if (lk.fieldEntities.has(entity) && !knownAbsent(lk, entity, field)) return { entity, place: null, elsewhere: [] };
	const owners = lk.fieldOn.get(field) ?? [];
	const library = lk.fieldOwners[field] ?? 0;
	// Only a snapshot that lists every bill in the library carrying the key can say
	// "not on this one"; a partial list can only say "not recorded".
	if (owners.length === 0 || library === 0 || owners.length < library) return { entity, place: null, elsewhere: [] };
	const elsewhere = owners.map((owner) => lk.fieldMeta.get(`${owner}|${field}`) as FieldOwnership);
	const only = elsewhere.length === 1 ? (elsewhere[0] as FieldOwnership) : null;
	return only ? { entity: only.entity, place: only, elsewhere } : { entity, place: null, elsewhere };
}

export function traceField(index: ImpactIndex, lk: IndexLookup, target: Target): FieldTrace {
	return fieldTracer(index, lk)(target);
}

/**
 * `traceField` for many fields over one index: the call graph, the origin cache
 * and the sites by key are built once. A class entry point asks "who else writes
 * this" for every field the class writes (S17 6.1).
 */
export function fieldTracer(index: ImpactIndex, lk: IndexLookup): (target: Target) => FieldTrace {
	const walk = walker(index, lk);
	const attribute = attributor(index, lk, walk.snapshot);
	// Every segment of a dotted key: `zlgd_syentry.zlgd_samplno` is found under both, keyReaches decides.
	const bySegment = new Map<string, SrcRef[]>();
	for (const site of index.fieldRefs) {
		if (!site.field || !RESOLVED.has(String(site.resolution))) continue;
		for (const segment of new Set(site.field.split("."))) {
			const list = bySegment.get(segment);
			if (list) list.push(site);
			else bySegment.set(segment, [site]);
		}
	}
	return (target) => trace(walk, attribute, bySegment.get(target.value) ?? [], target);
}

function trace(walk: Walk, attribute: Attributor, candidates: readonly SrcRef[], target: Target): FieldTrace {
	const { lk } = walk;
	const field = target.value;
	const resolved = target.entity ? placeFor(lk, target.entity, field) : null;
	const entity = resolved?.entity ?? null;
	const elsewhere = resolved?.elsewhere ?? [];
	const out: FieldTrace = {
		target,
		entity,
		place: resolved?.place ?? null,
		elsewhere,
		groups: [],
		guessed: [],
		excluded: [],
		open: [],
		snapshot: walk.snapshot,
		pathNote:
			target.entity && entity === target.entity
				? pathNote(lk, entity, resolved?.place ?? null, target.path ?? [])
				: null,
	};
	if (elsewhere.length > 1) return out;
	const byMethod = new Map<string, SiteGroup>();
	const owners = lk.fieldOn.get(field) ?? [];
	// A key the snapshot puts on this bill and nowhere else needs no class test.
	const unique = entity !== null && owners.length === 1 && owners[0] === entity && (lk.fieldOwners[field] ?? 1) <= 1;
	for (const site of candidates) {
		if (!keyReaches(site.field as string, field, walk.containers)) continue;
		const key = site.inMethod ?? `${site.class}#`;
		let group = byMethod.get(key);
		if (!group) {
			const traced = bound(walk, site.class)
				? {
						routes: site.inMethod
							? routesFrom(walk, site.class, site.inMethod, [])
							: [{ entry: site.class, hops: [], others: 0 }],
						miss: null,
					}
				: site.inMethod
					? traceMethod(walk, site.inMethod)
					: { routes: [], miss: "不在方法里（字段初始化或静态块）" };
			group = { class: site.class, method: site.inMethod ?? null, sites: [], ...traced };
			byMethod.set(key, group);
		}
		group.sites.push(site);
	}
	for (const group of byMethod.values()) {
		if (entity === null) {
			out.groups.push(group);
			continue;
		}
		// Per site, from where its object came from; a name match only decides when
		// the origin was not recognised, and then it is a guess, kept apart. An object
		// handed in as a parameter is followed along each listed route separately: a
		// route that brings in another bill's object is not a route to this bill.
		const touches =
			classTouchesEntity(lk.byClass.get(group.class), entity) ||
			group.routes.some((route) => classTouchesEntity(lk.byClass.get(route.entry), entity));
		const sure: SrcRef[] = [];
		const guessed: SrcRef[] = [];
		const other: SrcRef[] = [];
		const bills = new Set<string>();
		const kept = new Map<Route, string | undefined>();
		let allRoutes = false;
		let why: string | undefined;
		for (const site of group.sites) {
			const perRoute = group.routes.length > 0 && awaitsCaller(site.obj ?? "");
			const verdicts = perRoute
				? group.routes.map((route) => ({ route, at: attribute.along(site, route.hops) }))
				: [{ route: null, at: attribute.site(site) }];
			const onThis = verdicts.filter(({ at }) => at.kind === "bill" && at.bills.includes(entity));
			// A plugin on three bills: the ones that carry the key are the ones it can be on.
			const carrying = verdicts.flatMap(({ at }) =>
				at.kind === "bill" ? at.bills.filter((bill) => lk.fieldMeta.has(`${bill}|${field}`)) : [],
			);
			if (onThis.length > 0) {
				sure.push(site);
				for (const { route, at } of onThis) {
					if (route === null) allRoutes = true;
					else if (!kept.has(route)) kept.set(route, at.kind === "bill" ? at.how : undefined);
				}
			} else if (carrying.length > 0) {
				other.push(site);
				for (const bill of carrying) bills.add(bill);
			} else if (unique) {
				sure.push(site);
				allRoutes = true;
			} else if (touches) {
				guessed.push(site);
				const at = (verdicts[0] as { at: Attribution }).at;
				// The object's bill is known but the snapshot has no such field on it: an
				// extension bill (code loads `conm_purcontract`, the field sits on its
				// `_ext`), an inherited field, a key the snapshot did not collect. Not
				// "another bill" -- which bill the field really is on is the open question.
				why ??=
					at.kind === "bill"
						? `对象是 ${at.bills.slice(0, 2).join("、")}（${at.how}），快照里那张单上没记 ${field}`
						: at.why;
			} else other.push(site);
		}
		const part = (sites: SrcRef[], extra: Partial<SiteGroup>): SiteGroup => ({ ...group, sites, ...extra });
		if (sure.length > 0) {
			const routes = allRoutes
				? group.routes
				: group.routes.filter((route) => kept.has(route)).map((route) => ({ ...route, how: kept.get(route) }));
			out.groups.push(part(sure, { routes }));
		}
		if (guessed.length > 0) out.guessed.push(part(guessed, why ? { why } : {}));
		if (other.length > 0) out.excluded.push(part(other, bills.size > 0 ? { bills: [...bills] } : {}));
	}
	for (const group of [...out.groups, ...out.guessed]) group.sites.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
	const near = new Set<string>();
	for (const group of [...out.groups, ...out.guessed]) {
		near.add(group.class);
		for (const route of group.routes) {
			near.add(route.entry);
			for (const hop of route.hops) near.add(walk.classOf.get(hop.method) ?? "");
		}
	}
	for (const bill of entity ? [entity] : owners) for (const cls of lk.byEntity.get(bill) ?? []) near.add(cls);
	// An object known to be another bill rules the place out: its key is unknown, its bill is not.
	out.open = openRefs(walk.index).filter((row) => {
		if (row.level !== "field" || !near.has(row.class)) return false;
		if (entity === null) return true;
		const at = attribute.site({ ...row, inMethod: row.method, line: row.line ?? undefined });
		return at.kind !== "bill" || at.bills.includes(entity);
	});
	return out;
}

/** Every class a trace names: the structured result's identifiers. */
export function traceClasses(trace: FieldTrace): string[] {
	const out = new Set<string>();
	for (const group of trace.groups) {
		out.add(group.class);
		for (const route of group.routes) out.add(route.entry);
	}
	return [...out].sort();
}

// ---------------------------------------------------------------- text

const placeText = (row: FieldOwnership): string =>
	row.level === "header"
		? "表头"
		: row.level === "entry"
			? `分录 ${row.entry}`
			: row.level === "subentry"
				? `子分录 ${row.entry}${row.parentEntry ? `（属 ${row.parentEntry}）` : ""}`
				: row.level === "unknown"
					? row.entry
						? `挂在 ${row.entry} 下，不是分录`
						: "快照认不出在表头还是哪条分录"
					: [row.level, row.entry].filter(Boolean).join(" ");

const sinkName = (via: string | null | undefined): string =>
	String(via ?? "")
		.replace(/^.*#/, "")
		.split("(")[0] ?? "";

/**
 * How a site touches the field. Conditions and operation preloads name no method
 * worth showing (`new QFilter`, `and`, `getFieldKeys`); a select string names the
 * fetch it rides on (`取数读 load`).
 */
const howText = (access: string, via: string | null | undefined): string =>
	access === "filter"
		? "按条件读"
		: access === "preload"
			? "操作预加载"
			: `${access === "write" ? "写" : access === "select" ? "取数读" : "读"} ${sinkName(via)}`;

function sitesText(group: SiteGroup, field: string, all: boolean): string {
	const parts = new Map<string, number[]>();
	for (const site of group.sites) {
		// A dotted path is shown as written: `zlgd_org.number` says which property was read.
		const path = site.field && site.field !== field ? ` ${site.field}` : "";
		// A ref named at a wrapper call says which wrapper does the real write.
		const through = site.through ? ` 经 ${shortMethod(site.through)}` : "";
		const key = `${howText(site.access, site.via)}${path}${through}`.trim();
		const list = parts.get(key);
		if (list) list.push(site.line ?? 0);
		else parts.set(key, [site.line ?? 0]);
	}
	const head = group.method ? shortMethod(group.method) : simpleName(group.class);
	return `${head}:${[...parts]
		.map(([how, lines]) => {
			const shown = all ? lines : lines.slice(0, LINES_PER_METHOD);
			return `${shown.join("、")}${shown.length < lines.length ? ` 等 ${lines.length} 处` : ""} ${how}`;
		})
		.join("；")}`;
}

/**
 * Where a plugin is registered. A form plugin that is not on the bill's own layout
 * names the layouts it is on: looking for it in the bill's plugin list finds
 * nothing, and the reader goes hunting through layouts.
 */
function entryLabel(lk: IndexLookup, cls: string): string {
	const row = lk.byClass.get(cls);
	const binds = (row?.bindings ?? []).map((b) => {
		if (b.kind && b.kind !== "form" && b.kind !== "entity") return `${b.entity}@${b.kind}`;
		const own = b.kind !== "entity" && b.numbers.length > 0 && !b.numbers.includes(b.entity);
		return own ? `${b.entity} 的布局 ${b.numbers.slice(0, 2).join("、")}${b.layouts > 2 ? " 等" : ""}` : b.entity;
	});
	const shown = binds.slice(0, 3).join("、") + (binds.length > 3 ? ` 等 ${binds.length} 处` : "");
	return `${P}─ ${simpleName(cls)} [${row?.pluginType ?? "类"}，挂 ${shown}]${row?.file ? `  ${row.file}` : ""}`;
}

export function formatTrace(trace: FieldTrace, lk: IndexLookup, { all = false }: { all?: boolean } = {}): string[] {
	const field = trace.target.value;
	const asked = trace.target.entity;
	const lines: string[] = [];
	if (trace.elsewhere.length > 1) {
		lines.push(
			`${P}⚠ ${field} 不在 ${asked} 上（${trace.snapshot}）；有它的单：${trace.elsewhere
				.map((row) => `${row.entity}（${placeText(row)}）`)
				.join("、")}。按 <单据>.${field} 再查`,
		);
		return lines;
	}
	const writes = trace.groups.reduce((n, g) => n + g.sites.filter((s) => s.access === "write").length, 0);
	const reads = trace.groups.reduce((n, g) => n + g.sites.length, 0) - writes;
	const reached = trace.groups.filter((g) => g.routes.length > 0);
	const entries = new Set(reached.flatMap((g) => g.routes.map((r) => r.entry)));
	const missed = trace.groups.filter((g) => g.routes.length === 0);
	const missCount = missed.reduce((n, g) => n + g.sites.length, 0);
	const name = `字段 ${trace.entity ? `${trace.entity}.${field}` : field}${trace.place ? `（${placeText(trace.place)}）` : ""}`;
	const guessCount = countSites(trace.guessed);
	lines.push(
		writes + reads === 0
			? `${P}${name}：表里没记到${trace.entity ? (guessCount > 0 ? "确定在这张单上的" : "这张单上的") : ""}读写处`
			: `${P}${name}：写 ${writes} 处、读 ${reads} 处，挂载插件 ${entries.size} 个` +
					(missCount > 0 ? `；没找到挂载插件的 ${missCount} 处` : ""),
	);
	if (trace.pathNote) lines.push(`${P}  ⚠ ${trace.pathNote}（${trace.snapshot}）`);
	if (asked && trace.entity !== asked) {
		lines.push(`${P}  ⚠ ${field} 不在 ${asked} 上，在 ${trace.entity}（${trace.snapshot}），下面按它列`);
	} else if (asked && !trace.place) {
		const library = lk.fieldOwners[field] ?? 0;
		const none = "全库没有叫这个的字段，多半是控件标识或原厂字段";
		// "Not on it" only when the snapshot can tell (own fields all collected, inheritance known); otherwise "not recorded".
		lines.push(
			knownAbsent(lk, asked, field)
				? `${P}  ⚠ ${field} 不在 ${asked} 上（${trace.snapshot}）；${library === 0 ? none : `全库 ${library} 张单有它`}`
				: `${P}  快照没记到 ${asked} 上有 ${field}${library === 0 ? `（${none}）` : ""}${inheritedNote(lk, asked)}`,
		);
	}
	if (!asked) {
		const on = lk.fieldOwners[field] || (lk.fieldOn.get(field) ?? []).length;
		if (on > 1) {
			lines.push(
				`${P}  ⚠ 全库 ${on} 张单据上都有叫 ${field} 的字段 —— 下面是并集；限定到一张单用 <实体标识>.${field}`,
			);
		}
	}
	const settled = trace.excluded.filter((group) => group.bills);
	if (settled.length > 0) {
		// The bill each went to is what lets the reader check: `QTYOp 3 处（zlgd_qty_wtd）`.
		const where = byClassText(settled, (groups) =>
			[...new Set(groups.flatMap((g) => g.bills ?? []))].slice(0, 2).join("、"),
		);
		lines.push(`${P}  另有 ${countSites(settled)} 处同名标识读写的是别的单（按对象来源），没列：${where}`);
	}
	const untouched = trace.excluded.filter((group) => !group.bills);
	if (untouched.length > 0) {
		// Where they went is what lets the reader check the call: the class and the bills it is registered on.
		const where = byClassText(untouched, (groups) => {
			const binds = (lk.byClass.get(groups[0]?.class ?? "")?.bindings ?? []).map((b) => b.entity);
			return binds.length > 0 ? `挂 ${binds.slice(0, 2).join("、")}${binds.length > 2 ? " 等" : ""}` : "没挂载";
		});
		lines.push(
			`${P}  另有 ${countSites(untouched)} 处同名标识，所在的类和它的插件都没碰过 ${trace.entity}，没列：${where}`,
		);
	}
	if (trace.guessed.length > 0 && !all) {
		const where = byClassText(trace.guessed, (groups) => groups[0]?.why ?? "");
		lines.push(
			`${P}  另有 ${guessCount} 处只按名字猜在这张单上（对象来源没认出），没列：${where}；加 dynamic=true 列出`,
		);
	}
	if (trace.groups.length === 0 && trace.excluded.length === 0 && trace.guessed.length === 0) {
		lines.push(`${P}  放进 Map、界面控件、按名字比较的用法表里不记`);
	}
	// One row per (registered plugin, site method); the plugin header once.
	const byEntry = new Map<string, { hops: Hop[]; others: number; group: SiteGroup; how?: string }[]>();
	for (const group of reached) {
		for (const route of group.routes) {
			const list = byEntry.get(route.entry) ?? [];
			list.push({ hops: route.hops, others: route.others, group, how: route.how });
			byEntry.set(route.entry, list);
		}
	}
	const order = [...byEntry].sort(
		([a, x], [b, y]) =>
			Number(trace.entity !== null && !boundTo(lk, a, trace.entity)) -
				Number(trace.entity !== null && !boundTo(lk, b, trace.entity)) ||
			Math.min(...x.map((r) => r.hops.length)) - Math.min(...y.map((r) => r.hops.length)) ||
			a.localeCompare(b),
	);
	let shown = 0;
	let hidden = 0;
	// A plugin whose rows did not fit is still named: which plugins are involved is
	// the first question, the paths the second.
	const unseen: string[] = [];
	const files = new Map<string, string>();
	for (const [entry, rows] of order) {
		if (!all && shown >= ROUTE_ROWS) {
			hidden += rows.length;
			unseen.push(simpleName(entry));
			continue;
		}
		lines.push(entryLabel(lk, entry));
		for (const row of rows.sort((a, b) => a.hops.length - b.hops.length)) {
			if (!all && shown >= ROUTE_ROWS) {
				hidden++;
				continue;
			}
			shown++;
			const path = [
				...row.hops.map((hop) => `${shortMethod(hop.method)}:${hop.line ?? "?"}`),
				sitesText(row.group, field, all),
			];
			const how = row.how ? `（对象：${row.how}）` : "";
			lines.push(
				`${P}    ${path.join(" → ")}${row.others > 0 ? `（这个类另有 ${row.others} 个方法也走到这里）` : ""}${how}`,
			);
			if (row.group.class !== entry) files.set(row.group.class, lk.byClass.get(row.group.class)?.file ?? "");
		}
	}
	if (hidden > 0) {
		lines.push(
			`${P}  … 另有 ${hidden} 条路径没列${unseen.length > 0 ? `，涉及插件 ${unseen.join("、")}` : ""}；加 dynamic=true 看全部`,
		);
	}
	if (missed.length > 0) {
		lines.push(`${P}没找到挂载插件：`);
		for (const group of all ? missed : missed.slice(0, MISS_ROWS)) {
			lines.push(`${P}    ${sitesText(group, field, all)} —— ${group.miss}`);
			files.set(group.class, lk.byClass.get(group.class)?.file ?? "");
		}
		if (!all && missed.length > MISS_ROWS) {
			lines.push(`${P}  … 另有 ${missed.length - MISS_ROWS} 个方法没列，加 dynamic=true 看全部`);
		}
	}
	if (all && trace.guessed.length > 0) {
		lines.push(`${P}只按名字猜在这张单上（对象来源没认出）：`);
		for (const group of trace.guessed) {
			lines.push(`${P}    ${sitesText(group, field, all)} —— ${group.why ?? ""}`);
			files.set(group.class, lk.byClass.get(group.class)?.file ?? "");
		}
	}
	lines.push(
		...openLines(trace.open, all, {
			first: new Set([...byEntry.keys(), ...trace.groups.map((group) => group.class)]),
			listed: (cls) => {
				if (!byEntry.has(cls)) files.set(cls, lk.byClass.get(cls)?.file ?? "");
			},
		}),
	);
	const named = [...files].filter(([, file]) => file);
	if (named.length > 0) {
		lines.push(`${P}文件  ${named.map(([cls, file]) => `${simpleName(cls)} ${file}`).join("；")}`);
	}
	return lines;
}

/**
 * Places whose bill or field key the scan could not name, by class and line: the
 * reader opens these few rather than grepping the whole project for what the
 * table might have missed.
 */
export function openLines(
	rows: readonly UnresolvedRef[],
	all: boolean,
	{ first = new Set<string>(), listed }: { first?: ReadonlySet<string>; listed?: (cls: string) => void } = {},
): string[] {
	if (rows.length === 0) return [];
	const byClass = new Map<string, UnresolvedRef[]>();
	for (const row of rows) byClass.set(row.class, [...(byClass.get(row.class) ?? []), row]);
	// Classes already on the answer first, then the ones with most such places.
	const order = [...byClass].sort(
		([a, x], [b, y]) => Number(first.has(b)) - Number(first.has(a)) || y.length - x.length || a.localeCompare(b),
	);
	const lines = [
		`${P}名字扫描认不出的读写 ${rows.length} 处${byClass.size > 1 ? `，在 ${byClass.size} 个类里` : ""}（标识在变量里或按序号取），碰的是什么得读源码：`,
	];
	const shown = all ? order : order.slice(0, OPEN_CLASSES);
	for (const [cls, list] of shown) {
		listed?.(cls);
		// A key named in a variable says more about what is read than a column index.
		const sample = all
			? list
			: list
					.filter((row) => row.resolution !== "none")
					.concat(list.filter((row) => row.resolution === "none"))
					.slice(0, OPEN_PER_CLASS);
		const more = list.length > sample.length ? `；等 ${list.length} 处` : "";
		lines.push(`${P}    ${simpleName(cls)}：${sample.map(openText).join("；")}${more}`);
	}
	const rest = order.slice(shown.length);
	if (rest.length > 0) {
		const n = rest.reduce((sum, [, list]) => sum + list.length, 0);
		lines.push(`${P}  … 另有 ${rest.length} 个类 ${n} 处，加 dynamic=true 列全`);
	}
	return lines;
}

function openText(row: UnresolvedRef): string {
	const at = `${row.method ? (row.method.split("#")[1] ?? "").split("(")[0] : "?"}:${row.line ?? "?"}`;
	const how = `${howText(row.access, row.via).trim()}${row.through ? ` 经 ${shortMethod(row.through)}` : ""}`;
	const key =
		row.resolution === "none"
			? row.level === "field"
				? "按序号"
				: "没带单据标识"
			: (row.expr ?? (row.through ? "传入的标识" : ""));
	return `${at} ${how}${row.level === "entity" ? " 单据" : ""}${key ? `（${key}）` : ""}`;
}

const countSites = (groups: readonly SiteGroup[]): number => groups.reduce((n, g) => n + g.sites.length, 0);

/** `ClassA 3 处（note）、ClassB 1 处（note） 等`: three classes at most, the note from that class's groups. */
function byClassText(groups: readonly SiteGroup[], note: (groups: SiteGroup[]) => string): string {
	const byClass = new Map<string, SiteGroup[]>();
	for (const group of groups) byClass.set(group.class, [...(byClass.get(group.class) ?? []), group]);
	const shown = [...byClass]
		.slice(0, 3)
		.map(([cls, list]) => {
			const text = note(list);
			return `${simpleName(cls)} ${countSites(list)} 处${text ? `（${text}）` : ""}`;
		})
		.join("、");
	return `${shown}${byClass.size > 3 ? " 等" : ""}`;
}

const boundTo = (lk: IndexLookup, cls: string, entity: string): boolean =>
	(lk.byClass.get(cls)?.bindings ?? []).some((b) => b.entity === entity);
