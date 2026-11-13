/**
 * The name catalog (S5.4): turning **the words a person actually says** into
 * candidate design-time objects.
 *
 * The gap it closes. When someone opens with 「金相双语报告的备注要按试样号合并」
 * they know the business name and nothing else -- not the entity identifier, not
 * the template code, certainly not the plugin. Without names there is nothing to
 * look up until a read-only probe has turned the words into identifiers.
 *
 * **The names are the real design-time names, and nothing else.**
 * `PluginIndexProbe` reads them out of each family's name column, having first
 * verified that column exists (`t=name`), and the index carries them on the
 * objects. A family whose name column could not be verified simply has no names,
 * and this file reports that rather than inventing a substitute.
 *
 * That last sentence is the whole correction. The first version had no probe
 * support, so it learned names from the prose of earlier requirements: every 2-6
 * character Chinese window became an "alias". That produced 7215 "names" for 14
 * objects, and 「这次改的是发货单的数量单位」 resolved to an internal-processing
 * bill's sampling-position field because both strings contain 「单的」.
 * A window a sentence happens to contain is not an object's name -- the two only
 * look alike from inside a scoring function, and the person reading the list can
 * tell the difference immediately, which is what makes them stop trusting it.
 *
 * Which names (S17 7.4, 7.5): every ISV bill design's name -- an extension design
 * answers for the platform bill it extends, the number plugins and code use --
 * and every name the registration scan read for templates, tasks, APIs, BOTP
 * rules and workflows, including objects only other modules' classes are on and
 * every name an object has had. Field names are not collected.
 *
 * **Everything this file produces is a candidate.** A name resolves to as many
 * objects as the evidence supports and the ambiguity is carried, never resolved
 * by picking the most popular one -- a wrong pick here becomes a wrong "this is
 * rework" in front of the user.
 */

import type { AnchorKind } from "./anchors.ts";
import type { ImpactIndex } from "./model.ts";
import { ARTIFACT_KIND_OF_SITE } from "./model.ts";

/**
 * Format version of the name catalog. Computed from the impact index at query
 * time and no longer written to disk (S19).
 *
 * 4: bill names and every scanned name, not only those on this project's own
 * objects. 3: names and objects come only from the metadata index.
 */
export const CATALOG_VERSION = 4;

export interface CatalogEntry {
	kind: AnchorKind;
	id: string;
	owner?: string;
	/** Design-time names this object answers to. Real names only; usually exactly one. */
	names: string[];
}

export interface MetadataCatalog {
	version: number;
	at: string;
	/**
	 * Objects the index knew about, named or not.
	 *
	 * `entries.length` against this is the coverage figure: 162 objects of which
	 * 40 have names means the name channel answers for a quarter of them, and a
	 * caller must say so rather than reporting "no match" for the other three
	 * quarters.
	 */
	objects: number;
	entries: CatalogEntry[];
}

const CJK = /[㐀-鿿豈-﫿]/;

/** Shortest string allowed to be treated as a name. One character matches everywhere. */
const MIN_NAME = 2;

/**
 * Shortest name that counts when it sits inside a longer phrase. A two-character
 * name inside a sentence is usually half of another word: 「打开工程」 holds the
 * bill 「开工」, 「数据库」 the bill 「数据」 (S17 7.5, measured on 154 real
 * prompts). Such a name counts only when the term is exactly that name.
 */
const CONTAINED_NAME = 3;

const objectKey = (anchor: { kind: string; id: string; owner?: string }): string =>
	`${anchor.kind} ${anchor.owner ?? ""} ${anchor.id}`;

/**
 * Every named object the index knows, as catalog entries.
 *
 * One object is reached several ways -- a print template through `templates`,
 * `artifacts` and `names` -- so entries are folded on (kind, id), and an object
 * keeps every name it was seen under.
 */
function namedObjects(index: ImpactIndex): Map<string, CatalogEntry> {
	const out = new Map<string, CatalogEntry>();
	const put = (kind: AnchorKind, id: string, name: string | undefined, owner?: string) => {
		// A name with no Chinese in it (`test`, `02`) collides with identifiers and numbers, not with what a person says.
		if (!id || !name || name.length < MIN_NAME || !CJK.test(name)) return;
		const key = objectKey({ kind, id });
		const entry = out.get(key) ?? { kind, id, ...(owner ? { owner } : {}), names: [] };
		if (!entry.names.includes(name)) entry.names.push(name);
		out.set(key, entry);
	};
	for (const bill of index.billNames ?? []) put("entity", bill.base ?? bill.bill, bill.name);
	for (const template of index.templates ?? []) {
		put("print_template", template.number, template.name, template.entity);
	}
	for (const artifact of index.artifacts ?? []) {
		put(artifact.kind as AnchorKind, artifact.id, artifact.name, artifact.entity);
	}
	for (const row of index.names ?? []) {
		const kind = ARTIFACT_KIND_OF_SITE[row.site];
		if (kind) put(kind as AnchorKind, row.id, row.name);
	}
	return out;
}

/** How many objects the index holds at all, named or not. */
function countObjects(index: ImpactIndex): number {
	const seen = new Set<string>();
	for (const bill of index.billNames ?? []) seen.add(`entity ${bill.base ?? bill.bill}`);
	for (const template of index.templates ?? []) seen.add(`print_template ${template.number}`);
	for (const artifact of index.artifacts ?? []) seen.add(`${artifact.kind} ${artifact.id}`);
	for (const row of index.names ?? []) {
		const kind = ARTIFACT_KIND_OF_SITE[row.site];
		if (kind) seen.add(`${kind} ${row.id}`);
	}
	return seen.size;
}

/**
 * Builds the catalog.
 *
 * Names come only from `index`. **No index means no names** -- an empty catalog,
 * reported as such, because being offline may narrow this channel but must never
 * let it start guessing.
 */
export function buildCatalog(index: ImpactIndex | null, at: string = new Date().toISOString()): MetadataCatalog {
	const entries = index ? namedObjects(index) : new Map<string, CatalogEntry>();
	for (const entry of entries.values()) {
		// Longest first: a longer name that also matched is strictly more specific.
		entry.names.sort((a, b) => b.length - a.length || a.localeCompare(b));
	}
	return {
		version: CATALOG_VERSION,
		at,
		objects: index ? countObjects(index) : 0,
		entries: [...entries.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id)),
	};
}

/** Which families the probe could not name, as a sentence for the user. Empty when the catalog is whole. */
export function catalogGap(catalog: MetadataCatalog | null): string {
	if (catalog === null) return "还没有中文名对照表（跑一次 cosmic_doctor action=reindex 生成）";
	if (catalog.objects === 0) return "快照里没有对象，中文名无从查起";
	if (catalog.entries.length === 0) {
		return `${catalog.objects} 个对象一个都没有设计态名称 —— 探针没能确认名称列，只能按编号查`;
	}
	if (catalog.entries.length < catalog.objects) {
		return `${catalog.objects} 个对象里只有 ${catalog.entries.length} 个有设计态名称，其余只能按编号查`;
	}
	return "";
}

export interface NameHit {
	entry: CatalogEntry;
	/** The names in the query that pointed here, longest first. */
	names: string[];
	/** Several objects answer to this same name. Kept, never resolved by popularity. */
	ambiguous: boolean;
}

/**
 * Resolves the names in a sentence to candidate objects.
 *
 * Ambiguity is preserved: when 「委托单」 is the name of three different objects,
 * all three come back marked `ambiguous`, and the caller shows them as candidates
 * rather than picking one -- 名称有歧义时保留多个，不猜一个.
 */
export function resolveNames(catalog: MetadataCatalog, text: string, limit = 12): NameHit[] {
	const query = String(text ?? "");
	if (!CJK.test(query)) return [];
	const found: NameHit[] = [];
	for (const entry of catalog.entries) {
		const names = entry.names.filter((name) =>
			name.length >= CONTAINED_NAME ? query.includes(name) : query.trim() === name,
		);
		if (names.length > 0) found.push({ entry, names, ambiguous: false });
	}
	// A name read inside a longer name that also matched there is that longer name,
	// not a second object: 「检验委托单」 contains the template 「委托单」. A name
	// standing on its own anywhere else in the text still counts.
	const longer = [...new Set(found.flatMap((hit) => hit.names))];
	const hits = found
		.map((hit) => ({ ...hit, names: hit.names.filter((name) => !insideLonger(query, name, longer)) }))
		.filter((hit) => hit.names.length > 0);
	// Two objects reached through the same longest name are ambiguous by that name.
	const byName = new Map<string, number>();
	for (const hit of hits) byName.set(hit.names[0] as string, (byName.get(hit.names[0] as string) ?? 0) + 1);
	for (const hit of hits) hit.ambiguous = (byName.get(hit.names[0] as string) ?? 0) > 1;
	return hits
		.sort(
			(a, b) =>
				(b.names[0]?.length ?? 0) - (a.names[0]?.length ?? 0) ||
				b.names.length - a.names.length ||
				a.entry.id.localeCompare(b.entry.id),
		)
		.slice(0, limit);
}

/** Every place `name` occurs in `text`, as [start, end). */
function spans(text: string, name: string): [number, number][] {
	const out: [number, number][] = [];
	for (let at = text.indexOf(name); at >= 0; at = text.indexOf(name, at + 1)) out.push([at, at + name.length]);
	return out;
}

/** True when every occurrence of `name` lies within an occurrence of a longer matched name. */
function insideLonger(text: string, name: string, matched: readonly string[]): boolean {
	const covers = matched
		.filter((other) => other.length > name.length && other.includes(name))
		.flatMap((other) => spans(text, other));
	return (
		covers.length > 0 &&
		spans(text, name).every(([start, end]) => covers.some(([from, to]) => from <= start && end <= to))
	);
}

/** The registration sites whose objects can carry a name. Exported so the probe and this file cannot drift apart. */
export const NAMEABLE_SITES: readonly string[] = Object.keys(ARTIFACT_KIND_OF_SITE);
