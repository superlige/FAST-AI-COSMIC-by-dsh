/**
 * 打印模板设计数据的本地模型（S32 批 2）。
 *
 * 这个文件回答的是「一张模板在本地长什么样、怎么安全地改」，不碰文件系统，也不进 JVM。
 * 输入就是 `meta ptpl dump` 落下来的那两份 JSON（设计数据 + 多语言旁路），
 * 批 0 已经实测过：这份 JSON 原样交回平台解析，往返零损耗（S32 §10.3）。
 *
 * 为什么平台规则要写成代码而不是写成文档（S32 §4.3）：2026-09-20 那次真机会话里，
 * 模型花了两分钟自己摸 `_enter_` 怎么用——文档写过，还写错了一半。做成代码，这两分钟是零。
 * 下面每一条 `//规则` 注释都是从真模板里量出来的，不是推测：
 *
 *   - 页是扁平表，`pages: Control[][]`，父子靠控件自己的 `parentId` 指；
 *   - 表格 = LayoutGrid/DataGrid + 若干 DataRow + 若干 DataColumn + 行×列个格子，
 *     格子用 `rowId` + `columnId` 定位，行列的先后顺序就是它们在页数组里的出现顺序；
 *   - 合并区记在表格的 `mergeConfig` 上，键是 `<行下标>_<列下标>`；
 *   - 多语言旁路的键是 `<控件id>.<属性>`，值是 `{zh_CN: 值}`；公式操作数的显示名另有一条
 *     `<控件id>.formulaData.<操作数id>`。加控件要把这一套一起补上，删控件要一起删。
 */

export interface TplControl {
	id: string;
	key: string;
	type: string;
	parentId?: string | null;
	[field: string]: unknown;
}

export interface TplDesign {
	pages: TplControl[][];
	[field: string]: unknown;
}

/** 多语言旁路：`<控件id>.<属性>` -> `{ zh_CN: 值 }`。 */
export type TplLocale = Record<string, Record<string, unknown>>;

export interface ControlSite {
	control: TplControl;
	/** 第几页（0 起）。 */
	page: number;
	/** 在该页数组里的下标。 */
	index: number;
}

const ID_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** 设计数据长得像不像一份模板——`ptpl dump` 的产物才有 `pages` 这个二维表。 */
export function isDesign(value: unknown): value is TplDesign {
	if (value === null || typeof value !== "object") return false;
	const pages = (value as { pages?: unknown }).pages;
	return Array.isArray(pages) && pages.every((page) => Array.isArray(page));
}

export function allControls(design: TplDesign): ControlSite[] {
	const out: ControlSite[] = [];
	for (const [page, controls] of design.pages.entries()) {
		for (const [index, control] of controls.entries()) out.push({ control, page, index });
	}
	return out;
}

/**
 * 按 id 或 key 找一个控件。
 *
 * 两种写法都收，因为人看得见的是 key（`LayoutCell31`），程序之间传的是 id。
 * id 先查：key 在一张模板里**不保证唯一**（真模板里 `LayoutGrid` 和 `layoutgrid` 并存），
 * 而 id 是平台自己的主键。key 撞了就报出来，不猜。
 */
export function findControl(design: TplDesign, ref: string): ControlSite | { ambiguous: string[] } | null {
	const sites = allControls(design);
	const byId = sites.find((site) => site.control.id === ref);
	if (byId !== undefined) return byId;
	const byKey = sites.filter((site) => site.control.key === ref);
	if (byKey.length === 1) return byKey[0] as ControlSite;
	if (byKey.length > 1) return { ambiguous: byKey.map((site) => site.control.id) };
	return null;
}

export function isAmbiguous<T extends object>(hit: T | { ambiguous: string[] } | null): hit is { ambiguous: string[] } {
	return hit !== null && "ambiguous" in hit;
}

/** 一个控件的直接子控件，按页内顺序——行列的先后就是这个顺序。 */
export function childrenOf(design: TplDesign, parentId: string): ControlSite[] {
	return allControls(design).filter((site) => site.control.parentId === parentId);
}

export function takenIds(design: TplDesign): Set<string> {
	return new Set(allControls(design).map((site) => site.control.id));
}

export function takenKeys(design: TplDesign): Set<string> {
	return new Set(allControls(design).map((site) => site.control.key));
}

/**
 * 生成一个控件 id。
 *
 * 十位 `[0-9A-Za-z]`，和平台自己生成的形状一致。批 0 在真机上验过平台认本地生成的 id
 * （S32 §10.2）：平台的校验里根本没有 id 格式这一项，平台自己那份里纸张的 id 还带等号。
 * **唯一要守的是模板内唯一**，平台不会替我们报错，所以这里拿 `taken` 挡。
 */
export function makeId(taken: Set<string>, rand: () => number = Math.random): string {
	for (let attempt = 0; attempt < 1000; attempt++) {
		let id = "";
		for (let i = 0; i < 10; i++) id += ID_CHARS[Math.floor(rand() * ID_CHARS.length)] as string;
		if (!taken.has(id)) {
			taken.add(id);
			return id;
		}
	}
	throw new Error("生成控件 id 连续 1000 次都撞了，检查随机源");
}

/**
 * 生成一个控件 key：同类型里没被占用的最小序号，例如 `LayoutCell` -> `LayoutCell12`。
 *
 * key 是设计器里显示的名字，模型和人都按它指认控件，所以新控件的 key 要一眼看出是什么类型。
 */
export function makeKey(type: string, taken: Set<string>): string {
	for (let n = 1; n < 10000; n++) {
		const key = `${type}${n}`;
		if (!taken.has(key)) {
			taken.add(key);
			return key;
		}
	}
	throw new Error(`生成控件 key 失败：${type} 的序号用完了`);
}

// --------------------------------------------------------------------- 表格

export interface MergeArea {
	rowStart: number;
	columnStart: number;
	rowLength: number;
	columnLength: number;
}

export interface GridView {
	grid: TplControl;
	page: number;
	rows: TplControl[];
	columns: TplControl[];
	/** 行下标 -> 列下标 -> 格子；缺格的位置是 null（拓扑审计会报，这里如实反映）。 */
	cells: (TplControl | null)[][];
	cellType: string;
	/** 这张表格里所有格子（含缺格之外的多余格）。 */
	allCells: TplControl[];
}

const GRID_TYPES = new Set(["LayoutGrid", "DataGrid"]);
const CELL_TYPE_OF: Record<string, string> = { LayoutGrid: "LayoutCell", DataGrid: "DataCell" };

export function isGrid(control: TplControl): boolean {
	return GRID_TYPES.has(control.type);
}

/** 把一张表格摊平成行×列的矩阵。表格不存在或不是表格时返回 null。 */
export function gridView(design: TplDesign, ref: string): GridView | { ambiguous: string[] } | null {
	const hit = findControl(design, ref);
	if (hit === null || isAmbiguous(hit)) return hit;
	if (!isGrid(hit.control)) return null;
	const kids = childrenOf(design, hit.control.id);
	const rows = kids.filter((site) => site.control.type === "DataRow").map((site) => site.control);
	const columns = kids.filter((site) => site.control.type === "DataColumn").map((site) => site.control);
	const cellType = CELL_TYPE_OF[hit.control.type] ?? "LayoutCell";
	const allCells = kids.filter((site) => site.control.type === cellType).map((site) => site.control);
	const cells: (TplControl | null)[][] = rows.map((row) =>
		columns.map((column) => allCells.find((cell) => cell.rowId === row.id && cell.columnId === column.id) ?? null),
	);
	return { grid: hit.control, page: hit.page, rows, columns, cells, cellType, allCells };
}

/** 读表格上的合并区。键是 `<行下标>_<列下标>`，就是左上角那一格的坐标。 */
export function readMerges(grid: TplControl): Map<string, MergeArea> {
	const raw = grid.mergeConfig;
	const out = new Map<string, MergeArea>();
	if (raw === null || typeof raw !== "object") return out;
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		if (value === null || typeof value !== "object") continue;
		const area = value as Record<string, unknown>;
		out.set(key, {
			rowStart: numberOf(area.rowStart, 0),
			columnStart: numberOf(area.columnStart, 0),
			rowLength: numberOf(area.rowLength, 1),
			columnLength: numberOf(area.columnLength, 1),
		});
	}
	return out;
}

export function writeMerges(grid: TplControl, areas: Map<string, MergeArea>): void {
	const out: Record<string, MergeArea> = {};
	for (const area of [...areas.values()].sort((a, b) => a.rowStart - b.rowStart || a.columnStart - b.columnStart)) {
		out[`${area.rowStart}_${area.columnStart}`] = area;
	}
	grid.mergeConfig = out;
}

/**
 * 行或列增删之后，把合并区的坐标跟着搬。
 *
 * 三种情形，少一种都会把模板改坏：插在合并区**前面**——整块往后挪；插在合并区**中间**——
 * 这块变长；插在后面——不动。删是反过来的，删到只剩一格的合并区直接扔掉（那就不叫合并了）。
 */
export function shiftMerges(
	areas: Map<string, MergeArea>,
	axis: "row" | "column",
	at: number,
	delta: number,
): Map<string, MergeArea> {
	const out = new Map<string, MergeArea>();
	for (const area of areas.values()) {
		const start = axis === "row" ? area.rowStart : area.columnStart;
		const length = axis === "row" ? area.rowLength : area.columnLength;
		let nextStart = start;
		let nextLength = length;
		if (delta > 0) {
			if (at <= start) nextStart = start + delta;
			else if (at < start + length) nextLength = length + delta;
		} else {
			const removed = -delta;
			const end = start + length; // 开区间
			const cutFrom = Math.max(at, start);
			const cutTo = Math.min(at + removed, end);
			const inside = Math.max(0, cutTo - cutFrom);
			nextLength = length - inside;
			if (at < start) nextStart = start - Math.min(removed, start - at);
		}
		if (nextLength < 1) continue;
		const moved: MergeArea = {
			rowStart: axis === "row" ? nextStart : area.rowStart,
			columnStart: axis === "column" ? nextStart : area.columnStart,
			rowLength: axis === "row" ? nextLength : area.rowLength,
			columnLength: axis === "column" ? nextLength : area.columnLength,
		};
		if (moved.rowLength <= 1 && moved.columnLength <= 1) continue;
		out.set(`${moved.rowStart}_${moved.columnStart}`, moved);
	}
	return out;
}

// ----------------------------------------------------------------- 多语言旁路

/** 一个控件在多语言旁路里的所有键。 */
export function localeKeysOf(locale: TplLocale, id: string): string[] {
	return Object.keys(locale).filter((key) => key === id || key.startsWith(`${id}.`));
}

/** 克隆控件时把它那一套多语言键整套复制到新 id 名下。 */
export function cloneLocale(locale: TplLocale, fromId: string, toId: string): number {
	let copied = 0;
	for (const key of localeKeysOf(locale, fromId)) {
		const value = locale[key];
		if (value === undefined) continue;
		locale[`${toId}${key.slice(fromId.length)}`] = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
		copied++;
	}
	return copied;
}

/** 删控件时把它的多语言键一起删掉，不留孤儿。 */
export function dropLocale(locale: TplLocale, id: string): number {
	const keys = localeKeysOf(locale, id);
	for (const key of keys) delete locale[key];
	return keys.length;
}

/**
 * 改一个属性时同步多语言旁路。
 *
 * 规则：这条键本来有几种语言就改几种。真模板里 zh_TW 只有两条，绝大多数键只有 zh_CN；
 * 本来没有这条键的，就不无中生有——平台读不到旁路值时用设计数据里的那份。
 */
export function syncLocale(locale: TplLocale, id: string, prop: string, value: unknown): void {
	const key = `${id}.${prop}`;
	const existing = locale[key];
	if (existing === undefined) return;
	for (const lang of Object.keys(existing)) existing[lang] = value;
}

/** 新控件的一套多语言键：按已有同类控件那条键的语言集合建。 */
export function seedLocale(locale: TplLocale, id: string, values: Record<string, unknown>, langs: string[]): void {
	for (const [prop, value] of Object.entries(values)) {
		const entry: Record<string, unknown> = {};
		for (const lang of langs) entry[lang] = value;
		locale[`${id}.${prop}`] = entry;
	}
}

/** 这份旁路里出现过哪些语言——新键照着建，不硬编码 zh_CN。 */
export function localeLangs(locale: TplLocale): string[] {
	const langs = new Set<string>();
	for (const entry of Object.values(locale)) {
		if (entry === null || typeof entry !== "object") continue;
		for (const lang of Object.keys(entry)) langs.add(lang);
	}
	if (langs.size === 0) langs.add("zh_CN");
	return [...langs];
}

// ------------------------------------------------- 数字的原样（2026-09-21 真机踩到）

/**
 * 读候选文件要用它，不要用 `JSON.parse`。
 *
 * 真机第一次跑整份提交，探针报了 **143 处属性变化**，全是 `fontSize 16.0 -> 16`：
 * 一处都不是我们改的。JavaScript 的数字没有「整数还是小数」之分，`JSON.parse` 把
 * `16.0` 读成 16，写回去就是 `16`，到了 Java 那边就从 Double 变成 Integer。
 * 后果有两层，第二层更要命：
 *
 *   1. 确认单上刷出一百多条假差异，真正改的那一处被淹掉；
 *   2. 字体大小这类属性平台是按 Double 存的，类型换了可能保存成功而不生效——
 *      正是 S32 §4.3 里记的那种「改了没反应」。
 *
 * 所以这里在 `JSON.parse` 之前先走一遍，把**形态会丢的数字**（`String(Number(原文))`
 * 和原文对不上的那些，例如 `16.0`、`1e3`、超长整数）换成一个带记号的字符串，
 * 写回时 `stringifyDesign` 再原样还原。`0.5`、`13.1`、`3` 这些写法本来就唯一，不动它们——
 * 合并区坐标那些整数仍然是数字，读它们的代码不用改。
 */
//记号先写成 JSON 的转义形式（六个字符 \u0000）再交给 JSON.parse：裸控制字符在 JSON 字符串里是非法的，
//直接塞一个进去整份文件就解析不了（2026-09-21 真机踩到）
const NUMBER_TAG_TEXT = String.raw`\u0000n`;
const NUMBER_TAG = "\u0000n";

/**
 * 读一个数值，不管它有没有被「原样记号」包着。
 *
 * 带 `.0` 写法的数字在候选里是带记号的字符串（见 `parseDesignText`），`Number()` 直接读会得到 NaN。
 * 凡是要拿模板里的数字来算的地方都走这里——合并区坐标就是一例。
 */
export function numberOf(value: unknown, fallback = 0): number {
	if (typeof value === "number") return value;
	if (typeof value === "string") {
		const raw = value.startsWith(NUMBER_TAG) ? value.slice(NUMBER_TAG.length) : value;
		const parsed = Number(raw);
		return Number.isFinite(parsed) ? parsed : fallback;
	}
	return fallback;
}

export function parseDesignText(text: string): unknown {
	let out = "";
	let i = 0;
	let inString = false;
	while (i < text.length) {
		const ch = text[i] as string;
		if (inString) {
			if (ch === "\\") {
				out += ch + (text[i + 1] ?? "");
				i += 2;
				continue;
			}
			if (ch === '"') inString = false;
			out += ch;
			i++;
			continue;
		}
		if (ch === '"') {
			inString = true;
			out += ch;
			i++;
			continue;
		}
		if (ch === "-" || (ch >= "0" && ch <= "9")) {
			let j = i + 1;
			while (j < text.length && /[0-9.eE+-]/.test(text[j] as string)) j++;
			const raw = text.slice(i, j);
			out += String(Number(raw)) === raw ? raw : `"${NUMBER_TAG_TEXT}${raw}"`;
			i = j;
			continue;
		}
		out += ch;
		i++;
	}
	return JSON.parse(out);
}

/** 写候选文件要用它：把记号还原成原来那个数字字面量。 */
export function stringifyDesign(value: unknown): string {
	return JSON.stringify(value).replace(/"\\u0000n([^"]*)"/g, "$1");
}
