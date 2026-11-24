/**
 * 输入框 `@` 引用的目录：人敲「销售出库」「zlgd_dept」，从这里找候选；选中后发给模型的，
 * 是这一项**在元数据里的准确位置**（哪张单、表头还是哪条分录、什么类型、挂了哪些插件），
 * 模型不用再跑探针、查代码关系表来对标识。
 *
 * 数据只来自三处真实元数据，不猜：
 *   - 表单目录（`FormCatalogProbe`）：全库表单设计的编号、中文名、模型类型、扩展的原单、绑的实体；
 *   - 元数据快照的字段归属（`EntityFieldIndexProbe`）：本 ISV、代码碰过的单据的字段，带设计里的中文名；
 *   - 运行态字段（`MetaProbe`）：人往某张单里钻时现查的那一张，继承来的字段也在。
 * 扩展设计（`zlgd_im_saloutbill_ext`）一律折到原单编号（`im_saloutbill`）上：插件登记和代码用的都是原单。
 *
 * 纯函数，不碰文件和 JVM；读写在 `commands/mention.ts`。
 */

import type { FieldOwnership, ImpactIndex } from "./model.ts";
import { snapshotAsOf } from "./model.ts";

/** 表单目录的一行，键名和探针报的一样（全库 4 万多行，短键省一半体积）。 */
export interface FormRow {
	/** 表单编号 */
	n: string;
	/** 模型类型 */
	m: string;
	/** ISV */
	i: string;
	/** 绑的实体编号，和 n 相同时不带 */
	e?: string;
	/** 上级设计编号 */
	p?: string;
	/** 扩展的原单编号 */
	b?: string;
	name?: string;
}

export interface FormCatalog {
	kind: "FormCatalog";
	at: string;
	ms: number;
	forms: FormRow[];
}

export interface RuntimeField {
	key: string;
	name: string;
	type: string;
	level: string;
	entry?: string;
	parentEntry?: string;
	/** 基础资料字段指向的基础资料 */
	base?: string;
}

export interface RuntimeEntry {
	key: string;
	name: string;
	level: string;
	parentEntry?: string;
}

/** 一张单在运行态的全部字段（含继承来的），人往这张单里钻时现查、按单缓存。 */
export interface RuntimeFields {
	kind: "RuntimeFields";
	entity: string;
	name: string;
	at: string;
	fields: RuntimeField[];
	entries: RuntimeEntry[];
}

export type MentionKind = "bill" | "form" | "layout" | "entry" | "field";

export interface MentionItem {
	kind: MentionKind;
	/** 引用编号：单据、表单、布局是编号；分录是 `单据.分录`；字段是 `单据.字段` 或 `单据.分录.字段`（工具认的写法）。 */
	id: string;
	/** 自己的标识 */
	key: string;
	name: string;
	/** 所在单据（原单编号）；单据、表单是自己 */
	entity: string;
	model?: string;
	isv?: string;
	type?: string;
	level?: string;
	entry?: string;
	parentEntry?: string;
	base?: string;
	/** 布局、表单的上级设计 */
	parent?: string;
	/** 单据：本 ISV 的扩展设计；字段：它所在的扩展设计 */
	ext?: string[];
	from: "catalog" | "snapshot" | "runtime";
}

export interface MentionCatalog {
	items: MentionItem[];
	byId: Map<string, MentionItem>;
	/** 单据 → 它的分录和字段 */
	members: Map<string, MentionItem[]>;
	/** 单据 → 它的其他布局 */
	layouts: Map<string, MentionItem[]>;
	/** 单据 → 本 ISV 的扩展设计编号 */
	extensions: Map<string, string[]>;
	/** 设计编号 → 原单编号（扩展设计才有） */
	baseOf: Map<string, string>;
	/** 运行态查过的单据 */
	runtime: Map<string, RuntimeFields>;
	index: ImpactIndex | null;
	forms: number;
	isv: string;
	/** 和 `items` 一一对应的小写编号、中文名、引用编号：每敲一个字全扫一遍，先算好 */
	low: Low[];
}

interface Low {
	key: string;
	name: string;
	id: string;
}

/** 单据类的模型；其余进目录的都算「表单」（动态表单、报表、查询列表……） */
const BILL_MODELS = new Set(["BillFormModel", "BaseFormModel", "MobileBillFormModel"]);

export const MODEL_LABEL: Readonly<Record<string, string>> = {
	BillFormModel: "单据",
	BaseFormModel: "基础资料",
	MobileBillFormModel: "移动单据",
	DynamicFormModel: "动态表单",
	MobileFormModel: "移动表单",
	ReportFormModel: "报表",
	QueryListModel: "查询列表",
};

const KIND_LABEL: Readonly<Record<MentionKind, string>> = {
	bill: "单据",
	form: "表单",
	layout: "布局",
	entry: "分录",
	field: "字段",
};

const lower = (text: string): string => text.toLowerCase();

const lowOf = (item: MentionItem): Low => ({ key: lower(item.key), name: lower(item.name), id: lower(item.id) });

/** 设计编号换成原单编号（扩展设计才换）。 */
const baseNumber = (catalog: Pick<MentionCatalog, "baseOf">, design: string): string =>
	catalog.baseOf.get(design) ?? design;

function fieldId(entity: string, row: { key: string; level?: string; entry?: string; parentEntry?: string }): string {
	if (row.level === "entry" && row.entry) return `${entity}.${row.entry}.${row.key}`;
	if (row.level === "subentry" && row.entry) {
		return row.parentEntry
			? `${entity}.${row.parentEntry}.${row.entry}.${row.key}`
			: `${entity}.${row.entry}.${row.key}`;
	}
	return `${entity}.${row.key}`;
}

function entryId(entity: string, row: { key: string; parentEntry?: string; level?: string }): string {
	return row.level === "subentry" && row.parentEntry
		? `${entity}.${row.parentEntry}.${row.key}`
		: `${entity}.${row.key}`;
}

/**
 * 拼目录。同一个对象从几处来时：运行态压过快照（运行态带继承来的字段和真名），
 * 快照压过表单目录；扩展设计不单列，记在原单上。
 */
export function buildMentionCatalog(input: {
	index: ImpactIndex | null;
	forms: FormCatalog | null;
	runtime: readonly RuntimeFields[];
}): MentionCatalog {
	const { index, forms } = input;
	const isv = index?.fieldIsv ?? "";
	const baseOf = new Map<string, string>();
	for (const bill of index?.billNames ?? []) if (bill.base) baseOf.set(bill.bill, bill.base);
	for (const row of forms?.forms ?? []) if (row.b && BILL_MODELS.has(row.m) && !row.e) baseOf.set(row.n, row.b);
	const catalog: MentionCatalog = {
		items: [],
		byId: new Map(),
		members: new Map(),
		layouts: new Map(),
		extensions: new Map(),
		baseOf,
		runtime: new Map(input.runtime.map((r) => [r.entity, r])),
		index,
		forms: forms?.forms.length ?? 0,
		isv,
		low: [],
	};
	const put = (item: MentionItem) => {
		const known = catalog.byId.get(item.id);
		if (known !== undefined) {
			// 后来的更准（运行态 > 快照 > 目录），但名字缺的时候留着先来的
			Object.assign(known, item, { name: item.name || known.name, ext: item.ext ?? known.ext });
			return;
		}
		catalog.byId.set(item.id, item);
		catalog.items.push(item);
		if (item.kind === "entry" || item.kind === "field") {
			const list = catalog.members.get(item.entity) ?? [];
			list.push(item);
			catalog.members.set(item.entity, list);
		}
		if (item.kind === "layout") {
			const list = catalog.layouts.get(item.entity) ?? [];
			list.push(item);
			catalog.layouts.set(item.entity, list);
		}
	};
	const extensionNames = new Map<string, string>();
	for (const row of forms?.forms ?? []) {
		const base = baseOf.get(row.n);
		if (base !== undefined) {
			const list = catalog.extensions.get(base) ?? [];
			if (!list.includes(row.n)) list.push(row.n);
			catalog.extensions.set(base, list);
			if (row.name) extensionNames.set(base, row.name);
			continue;
		}
		const name = row.name ?? "";
		if (row.e && BILL_MODELS.has(row.m)) {
			put({
				kind: "layout",
				id: row.n,
				key: row.n,
				name,
				entity: baseNumber(catalog, row.e),
				model: row.m,
				isv: row.i,
				...(row.p ? { parent: row.p } : {}),
				from: "catalog",
			});
		} else {
			put({
				kind: BILL_MODELS.has(row.m) ? "bill" : "form",
				id: row.n,
				key: row.n,
				name,
				entity: row.n,
				model: row.m,
				isv: row.i,
				...(row.p ? { parent: row.p } : {}),
				from: "catalog",
			});
		}
	}
	// 快照里有、表单目录没有的单据（目录还没建、或那份设计没有表单）：从单据名补上
	for (const bill of index?.billNames ?? []) {
		const number = bill.base ?? bill.bill;
		if (!catalog.byId.has(number))
			put({
				kind: "bill",
				id: number,
				key: number,
				name: bill.name,
				entity: number,
				isv: bill.base ? "" : isv,
				from: "snapshot",
			});
		if (bill.base) {
			const list = catalog.extensions.get(number) ?? [];
			if (!list.includes(bill.bill)) list.push(bill.bill);
			catalog.extensions.set(number, list);
		}
	}
	for (const [base, list] of catalog.extensions) {
		const item = catalog.byId.get(base);
		if (item !== undefined) {
			item.ext = list;
			if (!item.name) item.name = extensionNames.get(base) ?? "";
		}
	}
	// 现查过运行态的单，整张以运行态为准：快照只收本 ISV 设计里写出来的，扩展设计往原单分录上加的字段
	// 认不出在哪条分录；快照那几行不收，只把「由哪份扩展设计加上」交给运行态那一条
	const extOf = new Map<string, string[]>();
	for (const row of index?.fields ?? []) {
		const entity = baseNumber(catalog, row.entity);
		if (!catalog.runtime.has(entity)) addSnapshotRow(catalog, row, put);
		else if (entity !== row.entity) extOf.set(`${entity}|${row.key}`, [row.entity]);
	}
	for (const runtime of input.runtime) addRuntime(catalog, runtime, put, extOf);
	catalog.low = catalog.items.map(lowOf);
	return catalog;
}

function addSnapshotRow(catalog: MentionCatalog, row: FieldOwnership, put: (item: MentionItem) => void): void {
	const entity = baseNumber(catalog, row.entity);
	const ext = entity === row.entity ? undefined : [row.entity];
	if (row.kind === "container") {
		put({
			kind: "entry",
			id: entryId(entity, row),
			key: row.key,
			name: row.name ?? "",
			entity,
			level: row.level,
			...(row.parentEntry ? { parentEntry: row.parentEntry } : {}),
			...(ext ? { ext } : {}),
			from: "snapshot",
		});
		return;
	}
	put({
		kind: "field",
		id: fieldId(entity, row),
		key: row.key,
		name: row.name ?? "",
		entity,
		level: row.level,
		...(row.entry ? { entry: row.entry } : {}),
		...(row.parentEntry ? { parentEntry: row.parentEntry } : {}),
		...(row.type ? { type: row.type } : {}),
		...(ext ? { ext } : {}),
		from: "snapshot",
	});
}

function addRuntime(
	catalog: MentionCatalog,
	runtime: RuntimeFields,
	put: (item: MentionItem) => void,
	extOf: ReadonlyMap<string, string[]>,
): void {
	const entity = runtime.entity;
	const bill = catalog.byId.get(entity);
	if (bill === undefined) put({ kind: "bill", id: entity, key: entity, name: runtime.name, entity, from: "runtime" });
	else if (!bill.name) bill.name = runtime.name;
	for (const row of runtime.entries) {
		put({
			kind: "entry",
			id: entryId(entity, row),
			key: row.key,
			name: row.name,
			entity,
			level: row.level,
			...(row.parentEntry ? { parentEntry: row.parentEntry } : {}),
			from: "runtime",
		});
	}
	for (const row of runtime.fields) {
		const ext = extOf.get(`${entity}|${row.key}`);
		put({
			kind: "field",
			id: fieldId(entity, row),
			key: row.key,
			name: row.name,
			entity,
			level: row.level,
			...(row.entry ? { entry: row.entry } : {}),
			...(row.parentEntry ? { parentEntry: row.parentEntry } : {}),
			type: row.type,
			...(row.base ? { base: row.base } : {}),
			...(ext ? { ext } : {}),
			from: "runtime",
		});
	}
}

export interface MentionQuery {
	/** 只在这张单（原单编号）的分录和字段里找 */
	scope?: string;
	/** 再往里钻到的分录、子分录（标识），从外往里；空就是整张单 */
	path?: string[];
	/** 去掉范围后要找的词 */
	text: string;
}

/**
 * `销售出库单.物料`、`im_saloutbill.` 这种写法：点前面认得出是一张单，就只在这张单里找。
 * 单据按编号或中文名认，中文名只认唯一的那张——认不准就当整句去全库找，不替人挑。
 */
export function parseMentionQuery(catalog: MentionCatalog, raw: string): MentionQuery {
	const text = raw.trim();
	const dot = text.indexOf(".");
	if (dot <= 0) return { text };
	const head = text.slice(0, dot);
	const rest = text.slice(dot + 1);
	const bill = resolveBill(catalog, head);
	if (bill === undefined) return { text };
	// 「单据.分录.子分录.词」：最后一段是词，前面每段按标识或唯一的中文名认成上一层下的分录
	const segments = rest.split(".");
	const word = segments.pop() ?? "";
	const path: string[] = [];
	for (const segment of segments) {
		const entry = resolveEntry(catalog, bill, path[path.length - 1], segment.trim());
		if (entry === undefined) return { scope: bill, text: rest };
		path.push(entry);
	}
	return path.length === 0 ? { scope: bill, text: word } : { scope: bill, path, text: word };
}

/** 一张单上、某条分录下（不给就是表头下）的分录：按标识，或唯一的中文名。 */
function resolveEntry(
	catalog: MentionCatalog,
	bill: string,
	parent: string | undefined,
	term: string,
): string | undefined {
	const entries = (catalog.members.get(bill) ?? []).filter(
		(it) => it.kind === "entry" && (parent === undefined ? !it.parentEntry : it.parentEntry === parent),
	);
	const byKey = entries.find((it) => it.key === term);
	if (byKey !== undefined) return byKey.key;
	const named = entries.filter((it) => it.name === term);
	return named.length === 1 ? named[0]?.key : undefined;
}

/** 钻进一层还没敲字时最多列几项：实测一张单表头 362 个字段、39 条分录 */
const LAYER_CAP = 600;

/** 一条分录下直接挂着的子分录和字段。 */
function childrenOf(catalog: MentionCatalog, entity: string, entry: string): { subs: MentionItem[]; fields: number } {
	const subs: MentionItem[] = [];
	let fields = 0;
	for (const m of catalog.members.get(entity) ?? []) {
		if (m.kind === "entry" && m.parentEntry === entry) subs.push(m);
		else if (m.kind === "field" && m.entry === entry) fields++;
	}
	return { subs, fields };
}

/** 这一层直接挂着的：整张单是表头字段和第一层分录，一条分录是它的字段和子分录。 */
function inLayer(item: MentionItem, inner: string | undefined): boolean {
	if (inner === undefined) {
		return item.kind === "entry" ? !item.parentEntry : item.level !== "entry" && item.level !== "subentry";
	}
	return item.kind === "entry" ? item.parentEntry === inner : item.entry === inner;
}

/** 编号（含扩展设计编号）或唯一的中文名 → 原单编号。 */
export function resolveBill(catalog: MentionCatalog, term: string): string | undefined {
	const number = baseNumber(catalog, term);
	const item = catalog.byId.get(number);
	if (item !== undefined && (item.kind === "bill" || item.kind === "form")) return number;
	const named = catalog.items.filter((it) => (it.kind === "bill" || it.kind === "form") && it.name === term);
	if (named.length === 1) return named[0]?.id;
	// 单据和同名的移动表单、动态表单：叫这个名字的单据只有一张就是它
	const bills = named.filter((it) => it.kind === "bill");
	return bills.length === 1 ? bills[0]?.id : undefined;
}

/** 越小越靠前：编号全等 0，中文名全等 1，编号开头 2，中文名开头 3，编号含 4，中文名含 5。 */
function matchRank(low: Low, q: string): number {
	if (low.key === q || low.id === q) return 0;
	if (low.name === q) return 1;
	if (low.key.startsWith(q)) return 2;
	if (low.name.startsWith(q)) return 3;
	if (low.key.includes(q)) return 4;
	if (low.name.includes(q) || low.id.includes(q)) return 5;
	return -1;
}

const KIND_ORDER: Readonly<Record<MentionKind, number>> = { bill: 0, form: 1, field: 2, entry: 3, layout: 4 };

/** 本工程碰过的单据：代码点过名、插件挂着、快照收过字段。 */
function touchedBills(catalog: MentionCatalog): Set<string> {
	const out = new Set<string>();
	for (const cls of catalog.index?.classes ?? []) {
		for (const b of cls.bindings) out.add(b.entity);
		for (const e of cls.entities) if (e.key) out.add(e.key);
	}
	for (const row of catalog.index?.fields ?? []) out.add(baseNumber(catalog, row.entity));
	return out;
}

const touchedCache = new WeakMap<MentionCatalog, Set<string>>();

/**
 * 找候选。词太短（一个英文字母）不找；中文一个字就找。排序：匹配得越准越前，
 * 同样准的，本工程碰过的单据和它上面的字段在前、本 ISV 的在前，再按种类、编号长短。
 */
export function searchMentions(catalog: MentionCatalog, raw: string, limit?: number): MentionItem[] {
	const query = parseMentionQuery(catalog, raw);
	// 全库找只给最像的十几个；钻进一张单、一条分录后范围小了，多列些，菜单里往下翻着挑
	limit ??= query.scope === undefined ? 12 : 40;
	// 点前面那张单认不准（同名的不止一张）：先把叫这个名字的单列出来，选中再往里钻
	if (query.scope === undefined && raw.includes(".")) {
		const head = raw.slice(0, raw.indexOf(".")).trim();
		if (head === "") return [];
		return searchMentions(catalog, head, limit).filter((it) => it.kind === "bill" || it.kind === "form");
	}
	const q = lower(query.text);
	const cjk = /[㐀-鿿]/.test(q);
	if (query.scope === undefined && q.length < 2 && !cjk) return [];
	const touched = touchedCache.get(catalog) ?? touchedBills(catalog);
	touchedCache.set(catalog, touched);
	const inner = query.path?.[query.path.length - 1];
	// 钻进分录：只在这条分录下找；整张单敲了词：整张单里找，没敲词：只列这一层
	const members = (catalog.members.get(query.scope ?? "") ?? []).filter(
		(item) => (inner === undefined && q !== "") || inLayer(item, inner),
	);
	const pool: { item: MentionItem; low: Low }[] =
		query.scope === undefined
			? catalog.items.map((item, i) => ({ item, low: catalog.low[i] as Low }))
			: members.map((item) => ({ item, low: lowOf(item) }));
	// 钻进去还没敲字：这一层整个列出来（表头几百个字段的单也不截在分录后面），按单据里本来的顺序；
	// 分录在前，平台为关联关系生成的「关联子实体」分录、没有中文名的内部属性（id、外键列）放最后
	if (q === "") {
		const order = (item: MentionItem) =>
			item.kind === "entry" ? (item.key.endsWith("_lk") ? 3 : 0) : item.name === "" ? 2 : 1;
		return pool
			.map((x, i) => ({ item: x.item, i }))
			.sort((a, b) => order(a.item) - order(b.item) || a.i - b.i)
			.slice(0, Math.max(limit, LAYER_CAP))
			.map((x) => x.item);
	}
	const scored: { item: MentionItem; score: number }[] = [];
	for (const { item, low } of pool) {
		const rank = matchRank(low, q);
		if (rank < 0) continue;
		const near = touched.has(item.entity) ? 0 : 1;
		const own = item.isv === undefined || item.isv === "" || item.isv === catalog.isv || item.ext ? 0 : 1;
		scored.push({ item, score: rank * 100 + near * 20 + own * 10 + KIND_ORDER[item.kind] });
	}
	scored.sort(
		(a, b) => a.score - b.score || a.item.id.length - b.item.id.length || a.item.id.localeCompare(b.item.id),
	);
	return scored.slice(0, limit).map((x) => x.item);
}

export function mentionLabel(item: MentionItem, catalog: MentionCatalog): string {
	if (item.kind === "field" || item.kind === "entry") {
		const bill = catalog.byId.get(item.entity);
		// 子分录带上它挂在哪条分录下：同一张单上几条子分录常常同名（「关联子实体」「结果值」）
		const parent =
			item.kind === "entry" && item.parentEntry
				? `${catalog.byId.get(`${item.entity}.${item.parentEntry}`)?.name || item.parentEntry}.`
				: "";
		return `${bill?.name || item.entity}.${parent}${item.name || item.key}`;
	}
	return item.name || item.key;
}

/** 菜单里一行的说明：编号、在哪、什么类型。 */
export function mentionHint(item: MentionItem, catalog: MentionCatalog): string {
	const bill = catalog.byId.get(item.entity);
	const billName = bill?.name || item.entity;
	if (item.kind === "field") return [item.id, place(item, catalog), typeLabel(item)].filter(Boolean).join(" · ");
	if (item.kind === "entry") {
		const { subs, fields } = childrenOf(catalog, item.entity, item.key);
		const at =
			item.parentEntry !== undefined && item.parentEntry !== ""
				? `分录 ${entryName(catalog, item.entity, item.parentEntry)} 下的子分录`
				: `${billName}的分录`;
		return [item.id, at, subs.length > 0 ? `子分录 ${subs.length} 条` : "", `字段 ${fields} 个`]
			.filter(Boolean)
			.join(" · ");
	}
	if (item.kind === "layout") return `${item.key} · ${billName}的布局`;
	const model = MODEL_LABEL[item.model ?? ""] ?? (item.kind === "bill" ? "单据" : "表单");
	return [item.key, model, item.ext ? "本 ISV 扩展过" : item.isv && item.isv !== catalog.isv ? item.isv : ""]
		.filter(Boolean)
		.join(" · ");
}

export const mentionSection = (item: MentionItem): string => KIND_LABEL[item.kind];

function typeLabel(item: MentionItem): string {
	if (!item.type) return "";
	return item.base ? `${item.type}→${item.base}` : item.type;
}

function entryName(catalog: MentionCatalog, entity: string, entry: string, parent?: string): string {
	const id = parent ? `${entity}.${parent}.${entry}` : `${entity}.${entry}`;
	const name = catalog.byId.get(id)?.name ?? catalog.byId.get(`${entity}.${entry}`)?.name ?? "";
	return name ? `${entry}「${name}」` : entry;
}

function place(item: MentionItem, catalog: MentionCatalog): string {
	if (item.level === "entry" && item.entry) return `分录 ${entryName(catalog, item.entity, item.entry)}`;
	if (item.level === "subentry" && item.entry) {
		const under = item.parentEntry ? `（在分录 ${entryName(catalog, item.entity, item.parentEntry)} 下）` : "";
		return `子分录 ${entryName(catalog, item.entity, item.entry, item.parentEntry)}${under}`;
	}
	if (item.level === "unknown") return item.entry ? `挂在 ${item.entry} 下（不是分录）` : "认不出在表头还是哪条分录";
	return "表头";
}

const named = (key: string, name: string): string => (name ? `${key}「${name}」` : key);

const LIST_CAP = 8;

function capped(items: readonly string[], cap = LIST_CAP): string {
	return items.length > cap ? `${items.slice(0, cap).join("、")} 等 ${items.length} 个` : items.join("、");
}

/** 挂在这张单（或这份布局）上的本工程插件，按登记的位置分。 */
/** 插件登记的位置（`MetaBinding.kind` 就是登记位置）说成人话。 */
const BINDING_LABEL: Readonly<Record<string, string>> = {
	form: "表单插件",
	entity: "操作或校验插件",
	print: "打印插件",
	task: "调度任务",
	api: "开放接口",
	convert: "转换插件",
	workflow: "工作流插件",
};

function pluginsOn(catalog: MentionCatalog, entity: string, layout?: string): string[] {
	const out: string[] = [];
	for (const cls of catalog.index?.classes ?? []) {
		for (const b of cls.bindings) {
			if (b.entity !== entity) continue;
			if (layout !== undefined && !b.numbers.includes(layout)) continue;
			const site = BINDING_LABEL[b.kind ?? "form"] ?? b.kind ?? "表单插件";
			const label = `${cls.class}（${site}${b.enabled ? "" : "，停用"}）`;
			if (!out.includes(label)) out.push(label);
		}
	}
	return out;
}

function billLine(catalog: MentionCatalog, entity: string): string {
	const bill = catalog.byId.get(entity);
	const model = MODEL_LABEL[bill?.model ?? ""] ?? "单据";
	const parts = [`${model} ${named(entity, bill?.name ?? "")}`];
	if (bill?.isv) parts.push(`ISV ${bill.isv}`);
	const ext = catalog.extensions.get(entity);
	if (ext && ext.length > 0) parts.push(`本 ISV 扩展设计 ${ext.join("、")}`);
	return parts.join("，");
}

/** 本机时区的「年-月-日 时:分」；记录里存的是 UTC。 */
export function localTime(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function sourceLine(catalog: MentionCatalog, item: MentionItem): string {
	if (item.from === "runtime") {
		const at = catalog.runtime.get(item.entity)?.at ?? "";
		return `来源：运行态元数据${at ? `（${localTime(at)} 读）` : ""}`;
	}
	if (item.from === "snapshot") {
		const at = catalog.index ? snapshotAsOf(catalog.index) : null;
		return `来源：代码关系表的元数据快照${at ? `（${localTime(at)}）` : ""}`;
	}
	return "来源：表单目录";
}

/**
 * 发给模型的那段：这一项在元数据里的准确位置。只写查到的事实，查不到的那一栏不写，
 * 不写「可能」「建议」——模型拿它当已知条件用。
 */
export function describeMention(catalog: MentionCatalog, id: string): string | null {
	const item = catalog.byId.get(id);
	if (item === undefined) return null;
	const lines: string[] = [];
	if (item.kind === "field") {
		const type = item.type ? `，${typeLabel(item)}` : "";
		const at = item.level === "unknown" ? place(item, catalog) : `在${place(item, catalog)}`;
		lines.push(`字段 ${item.id}${item.name ? `「${item.name}」` : ""}${type}，${at}`);
		lines.push(`所在${billLine(catalog, item.entity)}`);
		if (item.ext && item.ext.length > 0) lines.push(`这个字段由扩展设计 ${item.ext.join("、")} 加上`);
		const owners = catalog.index?.fieldOwners?.[item.key];
		if (owners !== undefined && owners > 1)
			lines.push(`标识 ${item.key} 全库 ${owners} 张单上都有，指这张单要写成 ${item.id}`);
		const plugins = pluginsOn(catalog, item.entity);
		if (plugins.length > 0) lines.push(`这张单上挂的本工程插件 ${plugins.length} 个：${capped(plugins)}`);
	} else if (item.kind === "entry") {
		const under =
			item.level === "subentry" && item.parentEntry
				? `分录 ${entryName(catalog, item.entity, item.parentEntry)} 下的子分录`
				: "表头下的分录";
		lines.push(`分录 ${item.id}${item.name ? `「${item.name}」` : ""}，是${under}`);
		lines.push(`所在${billLine(catalog, item.entity)}`);
		const { subs } = childrenOf(catalog, item.entity, item.key);
		if (subs.length > 0)
			lines.push(`下面的子分录 ${subs.length} 条：${capped(subs.map((e) => named(e.key, e.name)))}`);
		const fields = (catalog.members.get(item.entity) ?? []).filter((m) => m.kind === "field" && m.entry === item.key);
		if (fields.length > 0)
			lines.push(
				`分录上的字段 ${fields.length} 个：${capped(
					fields.map((f) => named(f.key, f.name)),
					20,
				)}`,
			);
	} else if (item.kind === "layout") {
		lines.push(
			`布局 ${named(item.key, item.name)}，是${billLine(catalog, item.entity)} 的另一份布局${item.parent ? `，上级设计 ${item.parent}` : ""}`,
		);
		const plugins = pluginsOn(catalog, item.entity, item.key);
		if (plugins.length > 0) lines.push(`登记在这份布局上的本工程插件 ${plugins.length} 个：${capped(plugins)}`);
	} else {
		lines.push(billLine(catalog, item.id) + (item.parent ? `，上级设计 ${item.parent}` : ""));
		const layouts = catalog.layouts.get(item.id) ?? [];
		if (layouts.length > 0)
			lines.push(
				`另有布局 ${layouts.length} 份：${capped(
					layouts.map((l) => named(l.key, l.name)),
					6,
				)}`,
			);
		const members = catalog.members.get(item.id) ?? [];
		// 第一层分录，各自带着下面的子分录：父子关系写在一处，模型不用再去拼
		const entries = members.filter((m) => m.kind === "entry" && !m.parentEntry);
		const tree = entries.map((e) => {
			const { subs } = childrenOf(catalog, item.id, e.key);
			return subs.length > 0
				? `${named(e.key, e.name)}（子分录 ${subs.map((x) => named(x.key, x.name)).join("、")}）`
				: named(e.key, e.name);
		});
		if (tree.length > 0) lines.push(`分录 ${tree.length} 条：${capped(tree, 20)}`);
		const plugins = pluginsOn(catalog, item.id);
		if (plugins.length > 0) lines.push(`挂的本工程插件 ${plugins.length} 个：${capped(plugins)}`);
	}
	lines.push(sourceLine(catalog, item));
	return lines.join("\n");
}

/** 引用块的标签：界面靠它把历史消息里这一段画回成一枚引用，模型读里面的正文。 */
export const MENTION_TAG = "cosmic-ref";

export function mentionBlock(label: string, id: string, body: string): string {
	const attr = (text: string) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
	return `<${MENTION_TAG} id="${attr(id)}" label="${attr(label)}">\n${body}\n</${MENTION_TAG}>`;
}

/** 这张单的字段是不是都在了：运行态查过就是；否则只有快照里本 ISV 设计里的那些。 */
export function membersComplete(catalog: MentionCatalog, entity: string): boolean {
	return catalog.runtime.has(entity);
}

/** 解析 `MetaProbe` 的 JSON 旁路成一张单的运行态字段。 */
export function runtimeFieldsOf(records: readonly Record<string, unknown>[], at: string): RuntimeFields | null {
	const head = records.find((r) => r.t === "entity");
	if (head === undefined) return null;
	const str = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));
	// 探针改之前，没有中文名的内部属性报成了字面的 "null"；缓存里还可能有
	const nameOf = (v: unknown) => (str(v) === "null" ? "" : str(v));
	const fields: RuntimeField[] = [];
	const entries: RuntimeEntry[] = [];
	for (const r of records) {
		if (r.t === "field") {
			fields.push({
				key: str(r.key),
				name: nameOf(r.name),
				type: str(r.type),
				level: str(r.level) || "header",
				...(str(r.entry) ? { entry: str(r.entry) } : {}),
				...(str(r.parentEntry) ? { parentEntry: str(r.parentEntry) } : {}),
				...(nameOf(r.base) ? { base: nameOf(r.base) } : {}),
			});
		} else if (r.t === "entry") {
			entries.push({
				key: str(r.key),
				name: nameOf(r.name),
				level: str(r.level) || "entry",
				...(str(r.parentEntry) ? { parentEntry: str(r.parentEntry) } : {}),
			});
		}
	}
	return { kind: "RuntimeFields", entity: str(head.key), name: str(head.name), at, fields, entries };
}

/** 解析 `FormCatalogProbe` 的 JSON 旁路。 */
export function formCatalogOf(records: readonly Record<string, unknown>[], at: string, ms: number): FormCatalog | null {
	if (!records.some((r) => r.t === "form-summary")) return null;
	const forms: FormRow[] = [];
	for (const r of records) {
		if (r.t !== "form" || Number(r.off ?? 0) === 1) continue;
		const s = (v: unknown) => (typeof v === "string" ? v : "");
		forms.push({
			n: s(r.n),
			m: s(r.m),
			i: s(r.i),
			...(s(r.e) ? { e: s(r.e) } : {}),
			...(s(r.p) ? { p: s(r.p) } : {}),
			...(s(r.b) ? { b: s(r.b) } : {}),
			...(s(r.name) ? { name: s(r.name) } : {}),
		});
	}
	return { kind: "FormCatalog", at, ms, forms };
}
