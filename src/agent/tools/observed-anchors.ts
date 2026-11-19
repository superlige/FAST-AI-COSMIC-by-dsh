import { ANCHOR_KINDS, type Anchor, type AnchorKind, normalizeAnchors } from "../../kernel/impact/anchors.ts";

const MAX_OBSERVED_ANCHORS = 48;
const OBSERVED_VALUE = /^[A-Za-z0-9_.$\-#]{2,120}$/;
const KIND_SET: ReadonlySet<string> = new Set<string>(ANCHOR_KINDS);

const OBSERVED_KIND: Readonly<Record<string, AnchorKind>> = {
	entity: "entity",
	bill: "entity",
	billformid: "entity",
	billform: "entity",
	form: "form",
	formid: "form",
	template: "print_template",
	tpl: "print_template",
	tplnumber: "print_template",
	printtemplate: "print_template",
	operation: "operation",
	opkey: "operation",
	op: "operation",
	convertrule: "botp_rule",
	botprule: "botp_rule",
	ruleid: "botp_rule",
	process: "workflow",
	procnumber: "workflow",
	proceskey: "workflow",
	nodekey: "workflow_node",
	node: "workflow_node",
	task: "task",
	tasknumber: "task",
	api: "open_api",
	apinumber: "open_api",
	class: "plugin",
	classname: "plugin",
	plugin: "plugin",
};

function add(out: Map<string, Anchor>, anchor: Anchor): void {
	if (out.size >= MAX_OBSERVED_ANCHORS) return;
	out.set(`${anchor.kind} ${anchor.owner ?? ""} ${anchor.id}`, anchor);
}

function scan(value: unknown, out: Map<string, Anchor>, owner = "", depth = 0): void {
	if (out.size >= MAX_OBSERVED_ANCHORS || depth > 6 || value === null || typeof value !== "object") return;
	if (Array.isArray(value)) {
		for (const item of value) scan(item, out, owner, depth + 1);
		return;
	}
	const row = value as Record<string, unknown>;
	const here =
		typeof row.entity === "string" && row.entity.trim()
			? row.entity.trim()
			: typeof row.billFormId === "string" && row.billFormId.trim()
				? row.billFormId.trim()
				: owner;
	for (const [key, item] of Object.entries(row)) {
		const kind = OBSERVED_KIND[key.toLowerCase()];
		if (kind && typeof item === "string" && OBSERVED_VALUE.test(item.trim())) {
			add(out, {
				kind,
				id: item.trim(),
				...(here && kind !== "entity" && kind !== "plugin" ? { owner: here } : {}),
				relation: "mentions",
				source: "metadata",
			});
		} else if (item && typeof item === "object") {
			scan(item, out, here, depth + 1);
		}
	}
}

function impactTargets(value: Record<string, unknown>): Anchor[] | null {
	if (value.action !== "query" || !Array.isArray(value.targets)) return null;
	const out: Anchor[] = [];
	for (const item of value.targets) {
		if (item === null || typeof item !== "object") continue;
		const target = item as Record<string, unknown>;
		const kind = target.kind;
		const id = typeof target.value === "string" ? target.value.trim() : "";
		if (!id) continue;
		let anchorKind: AnchorKind | null = null;
		if (kind === "class") anchorKind = "plugin";
		else if (kind === "entity") anchorKind = "entity";
		else if (kind === "field") anchorKind = "field";
		else if (kind === "template") anchorKind = "print_template";
		else if (kind === "layout") anchorKind = "layout";
		else if (kind === "artifact" && typeof target.artifactKind === "string" && KIND_SET.has(target.artifactKind)) {
			anchorKind = target.artifactKind as AnchorKind;
		}
		if (anchorKind === null) continue;
		const owner = typeof target.entity === "string" ? target.entity.trim() : "";
		out.push({
			kind: anchorKind,
			id: anchorKind === "field" && owner && !id.includes(".") ? `${owner}.${id}` : id,
			...(owner && anchorKind !== "field" ? { owner } : {}),
			relation: "mentions",
			source: kind === "class" ? "static" : "metadata",
		});
	}
	return normalizeAnchors(out).slice(0, MAX_OBSERVED_ANCHORS);
}

/**
 * Direct requirement observations from one tool result.
 *
 * An impact query is a graph expansion. Only its requested/resolved targets are
 * observations; classes and fields reached downstream are impact, not identity.
 */
export function observedAnchors(tool: string, value: unknown): Anchor[] {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
	if (tool === "cosmic_impact") return impactTargets(value as Record<string, unknown>) ?? [];
	const out = new Map<string, Anchor>();
	scan(value, out);
	return normalizeAnchors([...out.values()]);
}
