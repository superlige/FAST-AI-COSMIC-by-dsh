/**
 * The human channel for the impact index (S5.3).
 *
 * These lines are **for the user, not only for the agent**. When someone asks for
 * a change they do not know which bills it will touch, which other plugins write
 * the same field, or whether this is rework -- and that is the one moment they
 * can correct you. Swallowed, it is gone.
 */

import { attributor } from "./attribution.ts";
import { openLines } from "./field-trace.ts";
import type { ClassBinding, Impact, ImpactIndex, IndexLookup, QualifiedField, Target } from "./model.ts";
import {
	artifactGap,
	lookup,
	qualifyField,
	SITE_LABEL,
	SITE_OF_PLUGIN_TYPE,
	SITES_BEFORE_2026_09_04,
	simpleName,
	snapshotStatus,
} from "./model.ts";

const P = "[IMPACT] ";
const WIDE = /[ᄀ-ᅟ⺀-䳿一-鿿가-힣豈-﫿︰-﹏＀-｠￠-￦]/;
const width = (text: unknown): number => [...String(text)].reduce((w, c) => w + (WIDE.test(c) ? 2 : 1), 0);
const pad = (text: unknown, n: number): string => String(text) + " ".repeat(Math.max(1, n - width(text)));
const pct = (n: number, d: number): string => `${d ? Math.round((n * 100) / d) : 0}%`;
const cap = <T>(list: readonly T[], n: number): T[] => (list.length > n ? list.slice(0, n) : [...list]);

/** 逐类展开的行数上限。见 formatImpact 里那段注释。 */
const CLASS_ROWS = 20;

export function formatBuild(index: ImpactIndex, now: number = Date.now()): string[] {
	const src = index.src;
	const er = src.entityResolution;
	const fr = src.fieldResolution;
	const lines = [
		`${P}静态侧  ${src.files} 个源文件 / ${src.classes} 个类，${src.calls.total} 处调用全部绑到 Symbol（未绑定 ${src.calls.unbound}），${src.ms}ms`,
		`${P}实体引用 ${src.entityRefs} 处：字面量 ${er.literal} / 常量 ${er.constant} / 按存的对象来源 ${er.origin ?? 0} / 动态 ${er.dynamic} / 签名无标识 ${er.none}  → 解析率 ${pct(er.literal + er.constant + (er.origin ?? 0), src.entityRefs)}`,
		`${P}字段引用 ${src.fieldRefs} 处：字面量 ${fr.literal} / 常量 ${fr.constant} / 动态 ${fr.dynamic} / 签名无标识 ${fr.none}  → 解析率 ${pct(fr.literal + fr.constant, src.fieldRefs)}`,
	];
	if (src.chain) {
		lines.push(
			`${P}调用链  模块内调用边 ${src.edges} 条 → ${src.chain.classes} 个类经工具类多认出 ${src.chain.keys} 个实体/字段（插件调 FormUtil、真正的 setValue 在工具类里的那一类）`,
		);
	}
	if (src.diagnostics?.error) {
		lines.push(
			`${P}⚠ javac 报了 ${src.diagnostics.error} 条 ERROR，索引不完整：${(src.diagnostics.sample ?? []).join(" | ")}`,
		);
	}
	if ((src.unknownSigs ?? []).length > 0) {
		lines.push(`${P}⚠ 未登记的重载 ${src.unknownSigs.length} 个，这些调用只能标 dynamic：`);
		for (const sig of cap(src.unknownSigs, 10)) lines.push(`${P}    ${sig}`);
		lines.push(`${P}  扩 tools/SrcIndexTool.java 的 SINKS 表，**按签名登记，别按方法名**`);
	}
	if (index.meta) {
		// The metadata side's age must be visible every time: --src-only carries over
		// the PREVIOUS run's bindings, and metadata changes on the shared environment,
		// where the local machine has no signal at all -- unprinted, nothing whatever
		// indicates it has gone stale.
		lines.push(
			`${P}元数据侧 扫了 ${index.meta.scanned} 份设计态元数据，收下插件登记 ${index.meta.bindings} 条，${index.meta.ms}ms`,
		);
		// Silent on a snapshot built today and never checked: "not checked since" would be noise right after a build.
		const days = Math.floor((now - Date.parse(index.meta.at)) / 86_400_000);
		if (index.meta.check || index.meta.pending || days >= 1) lines.push(`${P}  ${snapshotStatus(index, now)}`);
		if (index.meta.foreign) {
			lines.push(
				`${P}  另有 ${index.meta.foreign} 个类登记在元数据里但不在本工程源码中（共享环境上别的模块的代码，或元数据里本就不是类名的同形字符串），未进索引`,
			);
		}
		// Every scanned site gets a number, zero included, and the sites this scan
		// did not cover are named separately. Printing only the non-empty ones is
		// how "task / api / convert / workflow have 173 bindings" turned into "those
		// four families are not in the index" for a reader who had nothing else to
		// go on. `sites` already separates 「没扫」 from 「没绑」 in the data; this
		// line is what carries that distinction to the person reading.
		const scanned = index.meta.sites ?? SITES_BEFORE_2026_09_04;
		const bySite = index.meta.bySite;
		lines.push(
			`${P}  注册位置 ${scanned
				.map((site) => `${SITE_LABEL[site]?.split(" ")[0] ?? site} ${bySite ? (bySite[site] ?? 0) : "?"}`)
				.join(" / ")}${bySite ? "" : "（这份索引没记分位置计数）"}`,
		);
		const unscanned = Object.keys(SITE_OF_PLUGIN_TYPE)
			.map((type) => SITE_OF_PLUGIN_TYPE[type] as string)
			.filter((site, i, all) => all.indexOf(site) === i && !scanned.includes(site));
		if (unscanned.length > 0) {
			lines.push(
				`${P}  ⚠ 没扫：${unscanned.map((site) => SITE_LABEL[site] ?? site).join("、")} —— 这几族插件按「没扫」算，**不是「没绑」**`,
			);
		}
		if (index.meta.templates) {
			lines.push(
				`${P}  打印模板 ${index.meta.templates} 份挂了本工程的插件（模板编码本身就能当入口：impact <模板编码>）`,
			);
		}
		const artifacts = index.artifacts ?? [];
		const byKind = new Map<string, number>();
		for (const row of artifacts) byKind.set(row.kind, (byKind.get(row.kind) ?? 0) + 1);
		lines.push(
			`${P}  非实体对象 ${artifacts.length} 个${
				artifacts.length === 0
					? ""
					: `：${[...byKind]
							.sort((a, b) => a[0].localeCompare(b[0]))
							.map(([kind, n]) => `${ANCHOR_KIND_LABEL[kind] ?? kind} ${n}`)
							.join(" / ")}`
			}（各按自己的编号收，编号本身就能当入口）`,
		);
		const gap = artifactGap(index);
		if (gap) lines.push(`${P}  ⚠ ${gap}`);
		const owners = Object.keys(index.fieldOwners ?? {});
		if (owners.length > 0) {
			const multi = owners.filter((key) => (index.fieldOwners[key] ?? 0) > 1).length;
			lines.push(
				`${P}  字段归属 ${(index.fields ?? []).length} 条，覆盖 ${owners.length} 个标识 —— 其中 ${multi} 个**跨单据同名**，裸 key 指不准一张单，写法是 <实体>.<字段>`,
			);
		} else {
			lines.push(`${P}  ⚠ 没有字段归属：字段标识只在一张单据内唯一，缺了它 impact <字段> 是同名并集`);
		}
	} else {
		lines.push(
			`${P}⚠ 没有元数据侧：这次索引只有源码事实，**插件绑在哪张单据上查不到**。连得上环境时跑 cosmic_doctor action=reindex（不带 srcOnly）补齐`,
		);
	}
	return lines;
}

const KIND_LABEL: Record<string, string> = {
	class: "类 ",
	entity: "实体 ",
	field: "字段 ",
	template: "打印模板 ",
	artifact: "元数据对象 ",
};

const ANCHOR_KIND_LABEL: Record<string, string> = {
	plugin: "插件",
	method: "方法",
	form: "表单",
	layout: "布局",
	entity: "实体",
	field: "字段",
	operation: "操作",
	form_rule: "表单规则",
	biz_rule: "业务规则",
	print_template: "打印模板",
	botp_rule: "BOTP 规则",
	workflow: "工作流",
	workflow_node: "流程节点",
	task: "调度任务",
	open_api: "开放接口",
};

/** 「打印模板 21「××报告」」—— the way a person names one design-time object. */
export function objectLabel(kind: string, id: string, name?: string): string {
	return `${ANCHOR_KIND_LABEL[kind] ?? kind} ${id}${name ? `「${name}」` : ""}`;
}

export const SITE_NAMES: Record<string, string> = {
	entity: "单据操作",
	print: "打印模板",
	task: "调度任务",
	api: "开放接口",
	convert: "转换规则",
	workflow: "工作流",
};

/** One plugin's registrations, grouped by site, e.g. `表单 zlgd_x / 单据操作 zlgd_y / 转换规则 12 条（zlgd_a、zlgd_b）`. */
export function registrationText(bindings: readonly ClassBinding[]): string {
	const parts: string[] = [];
	const off = (binding: ClassBinding) => (binding.enabled === false ? "（已停用）" : "");
	for (const binding of bindings.filter((b) => b.kind === undefined || b.kind === "form")) {
		// The layout's own number when it has one; the entity alongside, because that is the name the requirement uses.
		const layouts = binding.numbers.filter((number) => number !== binding.entity);
		parts.push(
			`表单 ${layouts.length === 0 ? binding.entity : `${layouts.join(" / ")}（实体 ${binding.entity}）`}${off(binding)}`,
		);
	}
	for (const kind of Object.keys(SITE_NAMES)) {
		const rows = bindings.filter((b) => b.kind === kind);
		if (rows.length === 0) continue;
		const name = SITE_NAMES[kind] as string;
		if (kind === "entity") {
			parts.push(`${name} ${rows.map((b) => `${b.entity}${off(b)}`).join("、")}`);
			continue;
		}
		const numbers = [...new Set(rows.flatMap((b) => b.numbers))];
		const entities = [...new Set(rows.map((b) => b.entity))];
		// Rule ids are 19-digit numbers nobody reads; their count and bills are what places the plugin.
		parts.push(
			kind === "convert"
				? `${name} ${numbers.length} 条（${entities.join("、")}）`
				: `${name} ${numbers.join("、")}（${entities.join("、")}）${rows.every((b) => b.enabled === false) ? "（已停用）" : ""}`,
		);
	}
	return parts.join(" / ");
}

/**
 * 牵连对象在 text 里默认列几个；dynamic=true 列全。结构化的 impact.artifacts 不进模型看到的那份
 * （见 extension.ts 的 RENDERED_TWIN），所以不能让人去那里找。
 */
export const ARTIFACT_ROWS = 3;

/**
 * 「改这些类，就是在改这些模板 / 任务 / 接口 / 规则 / 流程」（S17 2.3）。
 *
 * `impactOf` 一直算着这份清单，算完就丢了，于是查一个打印插件，最有用的那句
 * 「它挂在 21 号模板上」从来没说出口。通道不全时不说「无」：没扫到和没挂上读起来一样，
 * 只有后者能据以行动。
 */
export function artifactLines(index: ImpactIndex, impact: Impact, rowsShown: number = ARTIFACT_ROWS): string[] {
	const gap = artifactGap(index);
	const rows = impact.artifacts ?? [];
	if (rows.length === 0) {
		return [
			gap === ""
				? `${P}牵连的元数据对象（打印模板 / 调度任务 / 开放接口 / 转换规则 / 工作流）（无）`
				: `${P}牵连的元数据对象：不能据此判断没有打印模板、调度任务、开放接口、转换规则、工作流牵连 —— ${gap}`,
		];
	}
	// Many objects: how many of each kind first, then a few by name -- 78 full names is not a list anyone reads.
	const kinds = new Map<string, number>();
	for (const row of rows) kinds.set(row.kind, (kinds.get(row.kind) ?? 0) + 1);
	const tally =
		rows.length > rowsShown && kinds.size > 1
			? `${[...kinds].map(([kind, n]) => `${ANCHOR_KIND_LABEL[kind] ?? kind} ${n}`).join("、")}；`
			: "";
	const out = [
		`${P}牵连的元数据对象 ${rows.length} 个（上面的类登记在它们上面，改类就是改它们）：${tally}` +
			`${cap(rows, rowsShown)
				// A 19-digit rule id nobody reads; the name finds it again (cosmic_impact takes names).
				.map((row) =>
					row.kind === "botp_rule" && row.name && Number.isFinite(rowsShown)
						? `${ANCHOR_KIND_LABEL[row.kind]}「${row.name}」`
						: objectLabel(row.kind, row.id, row.name),
				)
				.join("、")}${rows.length > rowsShown ? ` … 共 ${rows.length} 个` : ""}`,
	];
	if (gap !== "") out.push(`${P}  ⚠ 不能据此判断只牵连这些 —— ${gap}`);
	return out;
}

/**
 * "Fields touched", grouped by owning bill / entry.
 *
 * The problem with a flat list is not that it looks bad, it is that **you cannot
 * see the same-naming**: `zlgd_year` exists on five bills and in a flat list it
 * looks exactly like a field that really belongs to this one. Grouped, unsettled
 * ownership and same-name ambiguity each get their own row and are told apart at
 * a glance.
 */
function groupFields(lk: IndexLookup, impact: Impact, settled: Map<string, string[]>) {
	const entities = new Set(impact.entities.map((e) => e.key));
	const rows = new Map<string, { q: QualifiedField; keys: string[] }>();
	const vague: string[] = [];
	const many: string[] = [];
	for (const field of impact.fields) {
		const bills = settled.get(field.key);
		const q =
			bills && bills.length > 1
				? { key: field.key, entity: "", candidates: bills, on: bills.length }
				: qualifyField(lk, bills ? new Set(bills) : entities, field.key);
		const tag = `${field.key}(${field.how})`;
		if (!q.entity) {
			(q.candidates.length > 1 ? many : vague).push(
				tag + (q.candidates.length > 1 ? `→${q.candidates.join("/")}` : ""),
			);
			continue;
		}
		const key = [q.entity, q.level, q.entry].join("|");
		const row = rows.get(key);
		if (row) row.keys.push(tag);
		else rows.set(key, { q, keys: [tag] });
	}
	return { rows: [...rows.values()], vague, many };
}

/**
 * Field keys of the surface's own classes whose every read / write has a
 * recognised object, to the bills those objects are on (and that carry the key).
 * The rest fall back to the name test over the whole surface.
 */
function originBills(index: ImpactIndex, lk: IndexLookup, impact: Impact): Map<string, string[]> {
	const classes = new Set(impact.classes.map((c) => c.class));
	const attribute = attributor(index, lk, "");
	const bills = new Map<string, Set<string>>();
	const unsettled = new Set<string>();
	for (const ref of index.fieldRefs) {
		if (!ref.field || !classes.has(ref.class) || !(ref.resolution === "literal" || ref.resolution === "constant"))
			continue;
		const at = attribute.site(ref);
		const carrying = at.kind === "bill" ? at.bills.filter((bill) => lk.fieldMeta.has(`${bill}|${ref.field}`)) : [];
		if (carrying.length === 0) {
			unsettled.add(ref.field);
			continue;
		}
		const set = bills.get(ref.field) ?? new Set<string>();
		for (const bill of carrying) set.add(bill);
		bills.set(ref.field, set);
	}
	return new Map([...bills].filter(([key]) => !unsettled.has(key)).map(([key, set]) => [key, [...set]]));
}

const placeOf = (q: QualifiedField): string =>
	q.level === "header"
		? "表头"
		: q.level === "entry"
			? `分录 ${q.entry}`
			: q.level === "subentry"
				? `子分录 ${q.entry}${q.parentEntry ? `（属 ${q.parentEntry}）` : ""}`
				: q.entry
					? `${q.level} ${q.entry}`
					: String(q.level ?? "");

/** 「入口：类 X，布局 Y（实体 Z）」: what the query resolved to, before anything about it. */
export function entryLine(targets: readonly Target[]): string {
	const labels = targets.map((x) =>
		// An artifact says what kind of object it is -- 「元数据对象 58」 does not tell
		// a template from a task -- and the bill it hangs on is not a qualifier.
		x.kind === "artifact" && x.artifactKind
			? objectLabel(x.artifactKind, x.value) + (x.entity ? `（挂在 ${x.entity} 上）` : "")
			: x.kind === "layout"
				? `布局 ${x.value}（实体 ${x.entity ?? "?"}）`
				: (KIND_LABEL[x.kind] ?? "") + x.value + (x.entity ? `（限定在 ${x.entity}）` : ""),
	);
	return `${P}入口：${labels.join("，")}`;
}

export function formatImpact(
	index: ImpactIndex,
	impact: Impact,
	{ showUnresolved = false, now = Date.now() }: { showUnresolved?: boolean; now?: number } = {},
): string[] {
	// Bindings, templates and artifacts below all come from the snapshot: how old it is goes first.
	const lines: string[] = [`${P}${snapshotStatus(index, now)}`];
	const lk0 = lookup(index);
	lines.push(entryLine(impact.targets));
	// **A field identifier is unique only within one bill.** Unsaid, what follows is
	// a union over several bills that looks exactly like one bill's impact surface --
	// measured, zlgd_year merges in five entirely unrelated bills.
	for (const target of impact.targets) {
		if (target.kind !== "field" || target.entity) continue;
		const on = lk0.fieldOwners[target.value] || (lk0.fieldOn.get(target.value) ?? []).length;
		if (on > 1) {
			lines.push(`${P}  ⚠ 全库 ${on} 张单据上都有叫 ${target.value} 的字段 —— 下面是**并集**，不是一张单的影响面`);
			lines.push(`${P}    本工程代码碰到的：${cap(lk0.fieldOn.get(target.value) ?? [], 8).join(" / ")}`);
			lines.push(`${P}    限定到一张单：cosmic_impact terms=["<实体标识>.${target.value}"]`);
		}
	}
	// 逐类展开有上限，和调用链(12)、字段(14/行)一样。
	// 问到一个共用实体上时这个清单能有六十条，每条还带绑定/路径两三行——而那一问正是
	// 最该问的：想知道的是「牵动了多大一片」和「有没有人做过」，不是六十份逐类档案。
	// 类的**全名**一个不少，在报文的 impact.classes 里；这里省的只是每条的展开。
	for (const cls of cap(impact.classes, CLASS_ROWS)) {
		lines.push(
			`${P}─ ${cls.class}${cls.pluginType ? `  [${cls.pluginType}]` : ""}${cls.file ? `  ${cls.file}` : ""}`,
		);
		if (cls.bindings.length > 0) {
			lines.push(
				`${P}    绑定实体  ${cls.bindings
					.map(
						(b) =>
							b.entity +
							(b.enabled ? "" : "(停用)") +
							(b.kind ? `@${b.kind}` : "") +
							(b.layouts > 1 ? `×${b.layouts}布局` : ""),
					)
					.join(", ")}`,
			);
		} else if (index.meta) {
			// "No binding" and "this family's registration site was never scanned"
			// read identically, and only the first one licenses "changing it affects
			// nobody else". Measured: with only the three design-time tables, every
			// convert / task / api / workflow plugin in the project came back empty.
			const site = SITE_OF_PLUGIN_TYPE[cls.pluginType ?? ""];
			const scanned = index.meta.sites ?? SITES_BEFORE_2026_09_04;
			if (site !== undefined && !scanned.includes(site)) {
				lines.push(`${P}    绑定实体  ⚠ **这一族的注册位置本次没扫**（${SITE_LABEL[site] ?? site}）——`);
				lines.push(`${P}              「查不到绑定」在这里不等于「没挂在任何地方」，别据此判断影响面`);
			} else {
				lines.push(`${P}    绑定实体  （元数据里没有登记；可能没绑，也可能绑在派生布局上）`);
			}
		} else if (cls.pluginType) {
			// No metadata side at all (--src-only). The source-side verdict is still
			// a fact worth handing over: it says what kind of plugin this is even
			// when nothing can say where it is registered.
			lines.push(`${P}    绑定实体  （本次只有源码事实；源码侧判定它是 ${cls.pluginType} 插件）`);
		}
	}
	if (impact.classes.length > CLASS_ROWS) {
		lines.push(
			`${P}… 另有 ${impact.classes.length - CLASS_ROWS} 个类也在影响面里，按类名单独查：` +
				impact.classes
					.slice(CLASS_ROWS)
					.map((cls) => simpleName(cls.class))
					.join("、"),
		);
	}
	const written = impact.entities.filter((e) => e.how.includes("写"));
	const read = impact.entities.filter((e) => !e.how.includes("写"));
	lines.push(`${P}写入实体 ${written.length > 0 ? written.map((e) => e.key).join(", ") : "（无）"}`);
	lines.push(`${P}读取实体 ${read.length > 0 ? read.map((e) => `${e.key}(${e.how})`).join(", ") : "（无）"}`);
	lines.push(...artifactLines(index, impact, showUnresolved ? Number.POSITIVE_INFINITY : ARTIFACT_ROWS));
	const chain = impact.classes.flatMap((cls) => (cls.chain ?? []).map((x) => ({ from: cls.class, ...x })));
	if (chain.length > 0) {
		lines.push(`${P}经调用链 ${chain.length} 处（自己这层看不出来，是走进工具类才认出来的）：`);
		for (const ref of cap(chain, 12)) {
			lines.push(
				`${P}    ${ref.key}  ${ref.access === "write" ? "写" : "读"}  经 ${ref.via}#${String(ref.viaMethod).split("#")[1]}  ${ref.hops} 跳`,
			);
		}
		if (chain.length > 12) lines.push(`${P}    … 共 ${chain.length} 处`);
	}
	if (impact.fields.length === 0) {
		lines.push(`${P}碰的字段 0 个`);
	} else {
		const grouped = groupFields(lk0, impact, originBills(index, lk0, impact));
		lines.push(`${P}碰的字段 ${impact.fields.length} 个（按所属单据 / 分录分，归属查的是设计态元数据）`);
		for (const row of grouped.rows.sort(
			(a, b) => a.q.entity.localeCompare(b.q.entity) || String(a.q.level).localeCompare(String(b.q.level)),
		)) {
			lines.push(
				`${P}    ${pad(row.q.entity, 26)}${pad(placeOf(row.q), 26)}${cap(row.keys, 14).join(", ")}${row.keys.length > 14 ? ` …共 ${row.keys.length}` : ""}`,
			);
		}
		// These two must not be folded into the rows above: one is "no such name in
		// the metadata", the other is "several bills have it", and what to do about
		// them is completely different -- merged, neither gets done.
		if (grouped.many.length > 0) {
			lines.push(
				`${P}    ${pad("同名歧义", 26)}${pad("本次影响面里就有多张单有它", 26)}${cap(grouped.many, 8).join(", ")}`,
			);
		}
		if (grouped.vague.length > 0) {
			lines.push(
				`${P}    ${pad("归属不明", 26)}${pad("设计态里没有同名字段", 26)}${cap(grouped.vague, 12).join(", ")}${grouped.vague.length > 12 ? ` …共 ${grouped.vague.length}` : ""}`,
			);
			lines.push(`${P}      （多半是控件 key、原厂继承字段，或元数据侧没扫到）`);
		}
	}

	// What the scan could not name must not quietly disappear: listed by line, so the
	// reader opens those places instead of taking the list above as complete.
	lines.push(...openLines(impact.unresolved, showUnresolved));
	return lines;
}
