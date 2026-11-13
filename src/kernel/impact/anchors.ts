/** Object facts observed during the current work session. */

export const ANCHOR_KINDS = [
	"plugin",
	"method",
	"form",
	"layout",
	"entity",
	"field",
	"operation",
	"form_rule",
	"biz_rule",
	"print_template",
	"botp_rule",
	"workflow",
	"workflow_node",
	"task",
	"open_api",
] as const;
export type AnchorKind = (typeof ANCHOR_KINDS)[number];

export const ANCHOR_RELATIONS = [
	"changed",
	"registered_on",
	"handles",
	"trigger",
	"reads",
	"writes",
	"modifies",
	"renders",
	"source",
	"target",
	"belongs_to",
	"biz_object",
	"implemented_by",
	"mentions",
] as const;
export type AnchorRelation = (typeof ANCHOR_RELATIONS)[number];

export const ANCHOR_SOURCES = ["file_edit", "metadata", "static", "text"] as const;
export type AnchorSource = (typeof ANCHOR_SOURCES)[number];

export interface Anchor {
	kind: AnchorKind;
	id: string;
	owner?: string;
	relation: AnchorRelation;
	source: AnchorSource;
}

const KIND_SET: ReadonlySet<string> = new Set<string>(ANCHOR_KINDS);
const SOURCE_RANK: Readonly<Record<AnchorSource, number>> = { file_edit: 0, metadata: 1, static: 2, text: 3 };

/** Deduplicate session facts while retaining the strongest observed source. */
export function normalizeAnchors(anchors: readonly Anchor[]): Anchor[] {
	const best = new Map<string, Anchor>();
	for (const anchor of anchors) {
		if (!anchor?.id || !KIND_SET.has(anchor.kind)) continue;
		const key = `${anchor.kind}\0${anchor.owner ?? ""}\0${anchor.id}\0${anchor.relation}`;
		const current = best.get(key);
		if (!current || SOURCE_RANK[anchor.source] < SOURCE_RANK[current.source]) best.set(key, { ...anchor });
	}
	return [...best.values()].sort(
		(a, b) =>
			ANCHOR_KINDS.indexOf(a.kind) - ANCHOR_KINDS.indexOf(b.kind) ||
			a.id.localeCompare(b.id) ||
			(a.owner ?? "").localeCompare(b.owner ?? "") ||
			a.relation.localeCompare(b.relation),
	);
}
