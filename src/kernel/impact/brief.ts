/**
 * The default answer to a class, bill, layout, template or artifact entry point
 * (S17 batch 6).
 *
 * The full surface -- every bill read, every chain hop, every unattributed key,
 * every unresolved site -- ran to 7 KB for one plugin and 22 KB for the test
 * bill, so it was cut in the middle before the model saw it, and the part that
 * was cut was often the part asked about. What a change to a class needs first
 * is five things: how old the snapshot is, where the class is registered, which
 * of this project's fields it writes on which bill, who else writes those fields,
 * and the design-time objects it drags in. A bill needs where its plugins are
 * registered, counted by site, not each plugin unfolded. The rest is one
 * `dynamic=true` away (`formatImpact`).
 *
 * "Who else writes it" is the field trace's answer (batch 1), not a name match:
 * a key is settled on a bill from where each site's object came from, so a plugin
 * on another bill with a same-named field is not reported as a co-writer.
 */

import { fieldTracer, openLines } from "./field-trace.ts";
import { artifactLines, entryLine, objectLabel, registrationText, SITE_NAMES } from "./format.ts";
import type { Impact, ImpactIndex, IndexedClass, IndexLookup, Target } from "./model.ts";
import { SITE_LABEL, SITE_OF_PLUGIN_TYPE, SITES_BEFORE_2026_09_04, simpleName, snapshotStatus } from "./model.ts";

const P = "[IMPACT] ";
const RESOLVED = new Set(["literal", "constant"]);
/** Classes named in the query, each unfolded; more are listed by name. */
const NAMED_CLASSES = 8;
/** Classes reached through a layout / template / artifact, unfolded; the rest by name. */
const REGISTERED_CLASSES = 3;
const KEYS_PER_BILL = 10;
const BILLS_PER_CLASS = 4;
const SHARED_ROWS = 3;
/** Co-writers named per shared field; more are counted. */
const WRITERS_PER_ROW = 3;
const NAMES_PER_GROUP = 3;
/** Form layouts of one bill on a line of their own; the rest are named with their count on one line. */
const LAYOUT_ROWS = 5;
const BY_NAME_CLASSES = 5;
const BILL_SHARED_ROWS = 3;
const UNSETTLED_KEYS = 4;

const cap = <T>(list: readonly T[], n: number): T[] => (list.length > n ? list.slice(0, n) : [...list]);
const more = (list: readonly unknown[], n: number): string => (list.length > n ? ` … 共 ${list.length}` : "");

export interface BriefOptions {
	/** The project's ISV prefix (`zlgd`): only its fields are listed by name. */
	isv: string;
	now: number;
}

interface Writes {
	/** bill -> keys this class writes there, settled from the sites' objects. */
	byBill: Map<string, string[]>;
	/** Keys whose bill was not settled: same key on several bills and the object not recognised. */
	unsettled: string[];
	/** bill -> [key, other classes (entry plugins) writing it]. */
	shared: Map<string, [string, string[]][]>;
}

/**
 * Simple names, with the package's last segment where two classes in one list share
 * one: `qtywtd.QTYWTDOpPlugin`, `opp.QTYWTDOpPlugin` -- not the same name printed twice.
 */
export function shortNames(classes: readonly string[]): string[] {
	const count = new Map<string, number>();
	for (const fqn of classes) count.set(simpleName(fqn), (count.get(simpleName(fqn)) ?? 0) + 1);
	return classes.map((fqn) =>
		(count.get(simpleName(fqn)) ?? 0) > 1 ? fqn.split(".").slice(-2).join(".") : simpleName(fqn),
	);
}

/** `zlgd_x ← A、B、C 等 5 个`. */
const writersText = ([key, who]: [string, string[]]): string =>
	`${key} ← ${shortNames(cap(who, WRITERS_PER_ROW)).join("、")}${who.length > WRITERS_PER_ROW ? ` 等 ${who.length} 个` : ""}`;

export function formatBrief(index: ImpactIndex, impact: Impact, lk: IndexLookup, options: BriefOptions): string[] {
	const lines = [`${P}${snapshotStatus(index, options.now)}`, entryLine(impact.targets)];
	const containers = new Set((index.fields ?? []).filter((row) => row.kind === "container").map((row) => row.key));
	const isvKey = (key: string): boolean => (options.isv ? key.startsWith(`${options.isv}_`) : key.includes("_"));
	let tracer: ReturnType<typeof fieldTracer> | null = null;
	const trace = (target: Target) => {
		tracer ??= fieldTracer(index, lk);
		return tracer(target);
	};
	/** Bill -> project ISV keys anyone writes there, with the entry plugins writing each. */
	const writersOn = (bill: string, key: string): { mine: (cls: string) => boolean; entries: string[] } => {
		const found = trace({ kind: "field", value: key, entity: bill });
		const groups = found.entity === bill ? found.groups.filter((g) => g.sites.some((s) => s.access === "write")) : [];
		return {
			mine: (cls) => groups.some((g) => g.class === cls || g.routes.some((r) => r.entry === cls)),
			entries: [...new Set(groups.flatMap((g) => (g.routes.length > 0 ? g.routes.map((r) => r.entry) : [g.class])))],
		};
	};
	const fieldKey = (key: string): string | null => {
		const segments = key.split(".");
		return segments.slice(0, -1).every((segment) => containers.has(segment)) ? (segments.at(-1) ?? null) : null;
	};

	const writesOf = (cls: IndexedClass): Writes => {
		// Platform fields and control properties (`billstatus`, `field1` of a print data row) are not listed.
		const keys = new Set<string>();
		const add = (raw: string) => {
			const key = fieldKey(raw);
			if (key !== null && isvKey(key)) keys.add(key);
		};
		for (const ref of cls.fields)
			if (ref.access === "write" && RESOLVED.has(String(ref.resolution))) add(String(ref.key));
		for (const ref of cls.chain ?? []) if (ref.level === "field" && ref.access === "write") add(ref.key);
		const touched = new Set([
			...cls.bindings.map((b) => b.entity),
			...cls.entities.map((e) => String(e.key)),
			...(cls.chain ?? []).filter((x) => x.level === "entity").map((x) => x.key),
		]);
		const out: Writes = { byBill: new Map(), unsettled: [], shared: new Map() };
		for (const key of [...keys].sort()) {
			const owners = lk.fieldOn.get(key) ?? [];
			let settled = false;
			for (const bill of owners) {
				if (owners.length > 1 && !touched.has(bill)) continue;
				const on = writersOn(bill, key);
				if (!on.mine(cls.class)) continue;
				settled = true;
				out.byBill.set(bill, [...(out.byBill.get(bill) ?? []), key]);
				// A helper this class itself calls is not "someone else"; a plugin reaching the same helper is.
				const others = on.entries.filter((entry) => entry !== cls.class);
				if (others.length > 0) out.shared.set(bill, [...(out.shared.get(bill) ?? []), [key, others]]);
			}
			if (!settled) out.unsettled.push(key);
		}
		return out;
	};

	const classLines = (cls: IndexedClass): string[] => {
		const out = [
			`${P}─ ${simpleName(cls.class)}${cls.pluginType ? `  [${cls.pluginType}]` : ""}${cls.file ? `  ${cls.file}` : ""}`,
		];
		out.push(`${P}    挂在：${whereText(index, cls)}`);
		const writes = writesOf(cls);
		const bills = [...writes.byBill].sort((a, b) => b[1].length - a[1].length);
		for (const [bill, keys] of cap(bills, BILLS_PER_CLASS)) {
			out.push(
				`${P}    写 ${bill} ${keys.length} 个：${cap(keys, KEYS_PER_BILL).join("、")}${more(keys, KEYS_PER_BILL)}`,
			);
		}
		if (bills.length > BILLS_PER_CLASS) {
			out.push(
				`${P}    另写 ${bills.length - BILLS_PER_CLASS} 张单：${bills
					.slice(BILLS_PER_CLASS)
					.map(([bill, keys]) => `${bill}(${keys.length})`)
					.join("、")}`,
			);
		}
		if (writes.unsettled.length > 0) {
			out.push(
				`${P}    另写 ${writes.unsettled.length} 个字段认不出是哪张单：${cap(writes.unsettled, UNSETTLED_KEYS).join("、")}${more(writes.unsettled, UNSETTLED_KEYS)}`,
			);
		}
		if (bills.length > 0 && writes.shared.size === 0) out.push(`${P}    这些字段没有别的类在写`);
		let room = SHARED_ROWS;
		for (const [bill, rows] of writes.shared) {
			if (room <= 0) break;
			out.push(
				`${P}    ${bill} 上同字段还有别的类在写 ${rows.length} 个：${cap(rows, room).map(writersText).join("；")}${more(rows, room)}`,
			);
			room -= rows.length;
		}
		return out;
	};

	const billLines = (bill: string): string[] => {
		const out: string[] = [];
		const groups = new Map<string, { names: string[]; off: number }>();
		const put = (label: string, cls: string, enabled: boolean) => {
			const group = groups.get(label) ?? { names: [], off: 0 };
			if (group.names.includes(cls)) return;
			group.names.push(cls);
			if (!enabled) group.off++;
			groups.set(label, group);
		};
		const registered = new Set<string>();
		for (const cls of index.classes) {
			for (const b of cls.bindings) {
				if (b.entity !== bill) continue;
				registered.add(cls.class);
				if (b.kind === undefined || b.kind === "form") {
					for (const number of b.numbers.length > 0 ? b.numbers : [bill])
						put(`表单 ${number}`, cls.class, b.enabled);
				} else put(SITE_NAMES[b.kind] ?? b.kind, cls.class, b.enabled);
			}
		}
		const byName = (lk.byEntity.get(bill) ?? []).filter((cls) => !registered.has(cls));
		out.push(
			registered.size === 0
				? `${P}单据 ${bill} 上没有本工程的插件${byName.length === 0 ? "，代码里也没按名字读写它" : ""}`
				: `${P}单据 ${bill} 上登记的本工程插件 ${registered.size} 个，按挂的位置分：`,
		);
		const groupText = ([label, group]: [string, { names: string[]; off: number }]): string =>
			`${P}    ${label} ${group.names.length} 个${group.off > 0 ? `（停用 ${group.off}）` : ""}：${shortNames(
				cap(group.names, NAMES_PER_GROUP),
			).join("、")}${group.names.length > NAMES_PER_GROUP ? " …" : ""}`;
		const forms = [...groups]
			.filter(([label]) => label.startsWith("表单 "))
			.sort((a, b) => b[1].names.length - a[1].names.length || a[0].localeCompare(b[0]));
		out.push(...cap(forms, LAYOUT_ROWS).map(groupText));
		if (forms.length > LAYOUT_ROWS) {
			const rest = forms.slice(LAYOUT_ROWS);
			const single = rest.filter(([, group]) => group.names.length === 1).length;
			const named = rest.filter(([, group]) => group.names.length > 1);
			out.push(
				`${P}    另 ${rest.length} 个表单布局：${named.map(([label, group]) => `${label.slice(3)}(${group.names.length})`).join("、")}` +
					`${single > 0 ? `${named.length > 0 ? "，" : ""}${single} 个各 1 个` : ""}`,
			);
		}
		out.push(...[...groups].filter(([label]) => !label.startsWith("表单 ")).map(groupText));
		if (byName.length > 0) {
			out.push(
				`${P}代码里按名字读写它、没登记在它上面的类 ${byName.length} 个：${cap(byName, BY_NAME_CLASSES).map(simpleName).join("、")}${byName.length > BY_NAME_CLASSES ? " …" : ""}`,
			);
		}
		const keys = (index.fields ?? [])
			.filter((row) => row.entity === bill && row.kind !== "container" && isvKey(row.key) && lk.byField.has(row.key))
			.map((row) => row.key);
		const written: string[] = [];
		const shared: [string, string[]][] = [];
		for (const key of [...new Set(keys)].sort()) {
			const on = writersOn(bill, key);
			if (on.entries.length === 0) continue;
			written.push(key);
			if (on.entries.length > 1) shared.push([key, on.entries]);
		}
		if (written.length > 0) {
			out.push(
				`${P}本工程代码写它的字段 ${written.length} 个；` +
					(shared.length === 0
						? "每个只有一个入口在写"
						: `不止一个入口在写的 ${shared.length} 个：${cap(shared, BILL_SHARED_ROWS).map(writersText).join("；")}${more(shared, BILL_SHARED_ROWS)}`),
			);
		}
		return out;
	};

	const briefed = new Set<string>();
	const unfold = (classes: readonly string[], limit: number): string[] => {
		const out: string[] = [];
		const rest: string[] = [];
		for (const fqn of classes) {
			if (briefed.has(fqn)) continue;
			const cls = lk.byClass.get(fqn);
			if (!cls) continue;
			if (briefed.size >= NAMED_CLASSES || out.filter((l) => l.startsWith(`${P}─`)).length >= limit) {
				rest.push(fqn);
				continue;
			}
			briefed.add(fqn);
			out.push(...classLines(cls));
		}
		if (rest.length > 0) {
			out.push(`${P}另有 ${rest.length} 个类没展开，按类名单独查：${rest.map(simpleName).join("、")}`);
		}
		return out;
	};

	for (const target of impact.targets) if (target.kind === "entity") lines.push(...billLines(target.value));
	lines.push(
		...unfold(
			impact.targets.filter((t) => t.kind === "class").map((t) => t.value),
			NAMED_CLASSES,
		),
	);
	for (const target of impact.targets) {
		const classes = registeredOn(lk, target);
		if (classes === null) continue;
		lines.push(
			classes.length === 0
				? `${P}${targetLabel(lk, target)} 上没有本工程的插件`
				: `${P}${targetLabel(lk, target)} 上登记的本工程插件 ${classes.length} 个：${classes.map(simpleName).join("、")}`,
		);
		lines.push(...unfold(classes, REGISTERED_CLASSES));
	}
	lines.push(...artifactLines(index, impact));
	lines.push(...openLines(impact.unresolved, false));
	lines.push(`${P}读了哪些单据、调用链、归属不明的字段逐条列：加 dynamic=true`);
	return lines;
}

/** Where one class is registered, or why that cannot be said. */
function whereText(index: ImpactIndex, cls: IndexedClass): string {
	if (cls.bindings.length > 0) return registrationText(cls.bindings);
	if (!index.meta) {
		return cls.pluginType ? `查不到：没有元数据快照（源码看是 ${cls.pluginType} 插件）` : "查不到：没有元数据快照";
	}
	// "Not registered" and "this family's site was never scanned" read alike; only the first licenses "affects nobody".
	const site = SITE_OF_PLUGIN_TYPE[cls.pluginType ?? ""];
	const scanned = index.meta.sites ?? SITES_BEFORE_2026_09_04;
	if (site !== undefined && !scanned.includes(site)) {
		return `这一族的登记位置快照没扫（${SITE_LABEL[site] ?? site}），查不到不等于没挂`;
	}
	return cls.pluginType ? "元数据里没有登记" : "不是插件，没有登记";
}

/** The project classes registered on a layout / template / artifact target; null for other kinds. */
function registeredOn(lk: IndexLookup, target: Target): string[] | null {
	if (target.kind === "layout") return lk.byLayout.get(target.value)?.classes ?? [];
	if (target.kind === "template") return lk.byTemplate.get(target.value)?.classes ?? [];
	if (target.kind === "artifact") {
		return [
			...new Set(
				(lk.byArtifact.get(target.value) ?? [])
					.filter((row) => !target.artifactKind || row.kind === target.artifactKind)
					.flatMap((row) => row.classes),
			),
		];
	}
	return null;
}

function targetLabel(lk: IndexLookup, target: Target): string {
	if (target.kind === "layout") return `布局 ${target.value}`;
	if (target.kind === "template")
		return objectLabel("print_template", target.value, lk.byTemplate.get(target.value)?.name);
	return objectLabel(target.artifactKind ?? "artifact", target.value);
}
