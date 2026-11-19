/**
 * Keeping the metadata snapshot current without rescanning the library (S17 4.3–4.5).
 *
 * A full metadata scan takes about five minutes and holds the resident JVM the
 * whole time; between two of them the shared environment keeps changing, and on
 * 2026-09-17 a three-day-old snapshot was five registrations and 401 field rows
 * behind. What changed is cheap to find: every design table the scan reads has a
 * modification time, and the primary keys of all of them come back in under a
 * second (`MetaChangeProbe`). Comparing that list with the one recorded at build
 * time gives the rows added, edited and deleted -- a deleted row has no time left
 * to look at, which is why the comparison is by key and not by the latest time.
 *
 * Only those rows are rescanned, and the result is merged so that it equals what
 * a full rebuild would have produced. Everything here is pure: the probes run in
 * `commands/impact.ts`.
 */

import type {
	BillName,
	FieldBase,
	FieldOwnership,
	MetaBaseline,
	MetaBinding,
	MetaIndex,
	MetaName,
	MetaTemplate,
	SrcIndex,
} from "./model.ts";
import { compactField, wrapperRefs } from "./model.ts";

/** Sites whose rows carry a design-time name (`t=name`), keyed the same as the stamps. */
const NAMED_SITES = new Set(["print", "task", "api", "convert", "workflow"]);

/** `t=stamp` records -> a baseline; null when the probe did not finish (no summary row). */
export function baselineOf(records: readonly Record<string, unknown>[], at: string): MetaBaseline | null {
	const summary = records.find((record) => record.t === "stamp-summary");
	if (!summary) return null;
	const rows: Record<string, [string, string, string][]> = {};
	for (const record of records) {
		if (record.t !== "stamp") continue;
		const site = String(record.site ?? "");
		const id = String(record.id ?? "");
		if (site === "" || id === "") continue;
		const list = rows[site] ?? [];
		list.push([id, String(record.number ?? ""), String(record.stamp ?? "")]);
		rows[site] = list;
	}
	for (const list of Object.values(rows)) list.sort((a, b) => a[0].localeCompare(b[0]));
	const sites = Array.isArray(summary.sites) ? (summary.sites as unknown[]).map(String) : Object.keys(rows);
	return { at, sites, rows };
}

export interface MetaChanges {
	/** Site -> the registration numbers to rescan: rows added, edited or deleted. */
	numbers: Map<string, Set<string>>;
	/** Design rows that differ, counted once each. */
	rows: number;
}

/** What differs between the baseline and the rows now, by key. */
export function diffBaseline(before: MetaBaseline, now: MetaBaseline): MetaChanges {
	const numbers = new Map<string, Set<string>>();
	let rows = 0;
	const touch = (site: string, number: string) => {
		if (number === "") return;
		const set = numbers.get(site) ?? new Set<string>();
		set.add(number);
		numbers.set(site, set);
	};
	for (const site of new Set([...before.sites, ...now.sites])) {
		const old = new Map((before.rows[site] ?? []).map(([id, number, stamp]) => [id, { number, stamp }]));
		for (const [id, number, stamp] of now.rows[site] ?? []) {
			const was = old.get(id);
			old.delete(id);
			if (was && was.number === number && was.stamp === stamp) continue;
			rows++;
			touch(site, number);
			if (was && was.number !== number) touch(site, was.number);
		}
		for (const { number } of old.values()) {
			rows++;
			touch(site, number);
		}
	}
	return { numbers, rows };
}

/**
 * The bills and keys the field scan is asked about: every key and bill the code
 * names, plus the bills plugins are registered on. The full build and a patch must
 * compute it the same way or the two would not agree.
 */
export function fieldWhitelist(
	src: SrcIndex,
	bindings: readonly MetaBinding[],
): { fields: Set<string>; entities: Set<string> } {
	const fields = new Set<string>();
	// Fields named only at a wrapper call (`setValue(row, i, KEY, v)`) are fields this code writes too.
	for (const row of [...(src.fieldRefs ?? []), ...wrapperRefs(src)]) if (row.field) fields.add(row.field);
	const entities = new Set<string>();
	for (const row of src.entityRefs ?? []) if (row.entity) entities.add(row.entity);
	for (const cls of src.classes ?? []) {
		for (const ref of (cls as { chain?: { level: string; key: string }[] }).chain ?? []) {
			if (ref.key) (ref.level === "entity" ? entities : fields).add(ref.key);
		}
	}
	// Entities the bindings bring in belong on the whitelist too, or "does the bill
	// this class binds carry this field" has no answer.
	for (const binding of bindings) if (binding.entity) entities.add(binding.entity);
	return { fields, entities };
}

/** The registrations, templates and names a partial `PluginIndexProbe` run reported. */
export interface RegistrationScan {
	bindings: MetaBinding[];
	templates: MetaTemplate[];
	names: MetaName[];
}

/** Swaps the rescanned rows' registrations in for the old ones. A number the rescan did not find was deleted. */
export function patchRegistrations(meta: MetaIndex, numbers: Map<string, Set<string>>, scan: RegistrationScan) {
	const changed = (site: string | undefined, number: string | undefined) =>
		site !== undefined && number !== undefined && (numbers.get(site)?.has(number) ?? false);
	return {
		bindings: [...meta.bindings.filter((b) => !changed(b.kind, b.layout)), ...scan.bindings],
		templates: [...meta.templates.filter((t) => !changed("print", t.number)), ...scan.templates],
		names: [...(meta.names ?? []).filter((n) => !(NAMED_SITES.has(n.site) && changed(n.site, n.id))), ...scan.names],
	};
}

export interface FieldPatch {
	/** Bills rescanned whole; one that came back with no rows was deleted or has no fields. */
	rescanned: ReadonlySet<string>;
	/** Every field row of the rescanned bills, whitelisted or not. */
	rows: readonly FieldOwnership[];
	/** The rescanned bills' names; a bill with none here was deleted. */
	billNames: readonly BillName[];
	/** Where the rescanned bills inherit from; absent from a probe that predates it. */
	bases?: Readonly<Record<string, FieldBase>>;
	isv?: string;
}

function keptRows(meta: MetaIndex, entities: ReadonlySet<string>, rescanned: ReadonlySet<string>): FieldOwnership[] {
	// Compacted, so a snapshot written before rows were stored compact comes out the way a full build writes it.
	return meta.fields.filter((row) => entities.has(row.entity) && !rescanned.has(row.entity)).map(compactField);
}

/**
 * The keys the snapshot counts: every key the code names, and every key on a
 * bill whose fields it collects. Same rule as the full build's `t=fieldowners`.
 */
export function trackedKeys(
	whitelist: { fields: ReadonlySet<string> },
	rows: readonly Pick<FieldOwnership, "key">[],
): Set<string> {
	const tracked = new Set(whitelist.fields);
	for (const row of rows) tracked.add(row.key);
	return tracked;
}

/** Owner counts of the tracked keys, from the library-wide lists. */
export function ownerCounts(owners: Readonly<Record<string, readonly string[]>>, tracked: ReadonlySet<string>) {
	const counts: Record<string, number> = {};
	for (const key of tracked) {
		const list = owners[key];
		if (list !== undefined && list.length > 0) counts[key] = list.length;
	}
	return counts;
}

/**
 * Field ownership after a patch: rows of the whitelisted bills, and the owner
 * list of every key in the library with the rescanned bills taken out and put
 * back by what they carry now. The lists cover the whole library, so no key ever
 * has to be counted again: a key that appears on a bill since is on a changed
 * bill, and every changed bill is rescanned.
 */
export function patchFields(
	meta: MetaIndex,
	whitelist: { fields: ReadonlySet<string>; entities: ReadonlySet<string> },
	patch: FieldPatch,
): Pick<MetaIndex, "fields" | "fieldOwners" | "owners" | "asked" | "billNames" | "fieldBases" | "fieldIsv"> {
	const fields = [
		...keptRows(meta, whitelist.entities, patch.rescanned),
		...patch.rows.filter((row) => whitelist.entities.has(row.entity)),
	];
	const owners: Record<string, string[]> = {};
	for (const [key, list] of Object.entries(meta.owners ?? {})) {
		const kept = list.filter((entity) => !patch.rescanned.has(entity));
		if (kept.length > 0) owners[key] = kept;
	}
	for (const row of patch.rows) {
		const list = owners[row.key] ?? [];
		if (!list.includes(row.entity)) list.push(row.entity);
		owners[row.key] = list;
	}
	for (const list of Object.values(owners)) list.sort();
	// A rescanned bill keeps no stale base: what it inherits now, or nothing (unknown, so never "not on it").
	const fieldBases: Record<string, FieldBase> = {};
	for (const [entity, base] of Object.entries(meta.fieldBases ?? {})) {
		if (whitelist.entities.has(entity) && !patch.rescanned.has(entity)) fieldBases[entity] = base;
	}
	for (const [entity, base] of Object.entries(patch.bases ?? {})) {
		if (whitelist.entities.has(entity)) fieldBases[entity] = base;
	}
	const fieldIsv = patch.isv || meta.fieldIsv;
	return {
		...(Object.keys(fieldBases).length > 0 ? { fieldBases } : {}),
		...(fieldIsv ? { fieldIsv } : {}),
		fields,
		fieldOwners: ownerCounts(owners, trackedKeys(whitelist, fields)),
		owners,
		asked: { entities: [...whitelist.entities].sort() },
		// Names are kept only on a snapshot that had them: a patch alone would hold just the rescanned bills'.
		...(meta.billNames === undefined
			? {}
			: {
					billNames: [
						...meta.billNames.filter((row) => !patch.rescanned.has(row.bill)),
						...patch.billNames.filter((row) => patch.rescanned.has(row.bill)),
					].sort((a, b) => a.bill.localeCompare(b.bill)),
				}),
	};
}
