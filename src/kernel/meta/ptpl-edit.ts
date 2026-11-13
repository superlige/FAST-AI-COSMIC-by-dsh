/**
 * 在本地候选模板上改结构（S32 批 2.2～2.5）。
 *
 * 这一层是「效率的大头」：**改动全在本地，零 Java 往返，模型也不用读整份 JSON**。
 * 一张模板的设计数据 200～410 KB，2026-09-20 那次真机会话里模型 76 次工具调用有一半
 * 在 grep 这个文件；这里的每个操作都只回一句话说改了什么（S32 §4.2）。
 *
 * 分工（S32 §4.3）：模型说业务意思，平台规则由这里的代码负责——
 * 控件 id、父子引用、行列格矩阵配套、合并区平移、多语言键、公式片段的拼装，模型一样都不碰。
 */

import { err, KernelError, type KernelResult, ok } from "../errors.ts";
import {
	allControls,
	type ControlSite,
	childrenOf,
	cloneLocale,
	dropLocale,
	findControl,
	type GridView,
	gridView,
	isAmbiguous,
	isGrid,
	localeLangs,
	makeId,
	makeKey,
	numberOf,
	parseDesignText,
	readMerges,
	seedLocale,
	shiftMerges,
	stringifyDesign,
	syncLocale,
	type TplControl,
	type TplDesign,
	type TplLocale,
	takenIds,
	takenKeys,
	writeMerges,
} from "./ptpl-design.ts";
import { buildFormula, ENTER, type FieldRef, formulaText, isOperand, operandsOf } from "./ptpl-formula.ts";

function fail(message: string, remedy = ""): KernelError {
	return new KernelError("META_ARGS_INVALID", message, remedy === "" ? {} : { remedy });
}

/** 代码关系表里那部分字段归属，`meta ptpl edit` 拿它在本地核绑定，不进 Java 进程。 */
export interface FieldOwnershipRow {
	entity: string;
	key: string;
	/** header | entry | subentry | unknown */
	level: string;
	entry?: string;
	/** 子分录的上一层分录；表头和一级分录是空串 */
	parentEntry?: string;
	kind?: string;
	/** 打印认的字段类型（Text / Number / Amount / Date / Time），平台元数据报的；代码关系表不带。 */
	textFormat?: string;
}

export interface EditContext {
	design: TplDesign;
	locale: TplLocale;
	/** 代码关系表里的字段归属：只收代码里点过名的，查到了就用，查不到不算「没有」。 */
	fields?: readonly FieldOwnershipRow[];
	/**
	 * 平台运行态元数据里这张单的全部字段（含继承来的原厂字段），表里查不到时才去取。
	 * `error` 是没取成的原因。
	 */
	platform?: { rows: readonly FieldOwnershipRow[] } | { error: string };
	/** 表里查不到、又还没有平台结果的字段标识收在这里，调用方取完平台元数据再做一遍。 */
	unresolved?: Set<string>;
	/** 注入随机源，测试里给确定性实现。 */
	rand?: () => number;
}

/** 一次编辑的结果：改了什么，用一句人话说。 */
export interface EditSaid {
	said: string[];
	notes: string[];
}

function said(line: string, notes: string[] = []): EditSaid {
	return { said: [line], notes };
}

function label(control: TplControl): string {
	return `${control.key}(${control.type})`;
}

// ------------------------------------------------------- 2.5 绑定在本地核对

export type FieldLookup = (bindField: string) => FieldRef | string;

/**
 * 把一个字段标识解析成「哪个数据源、什么作用域、显示什么名字」。
 *
 * 三处来源，从可靠到不可靠：
 *
 *   1. **这张模板自己已经在用的**——同一个字段已经绑在别的格子上或出现在别的公式里，
 *      那就照抄它的数据源、作用域、显示名和字段类型。这是最硬的证据：平台已经认过一次了。
 *   2. **代码关系表**（`impact.json` 里的字段归属）：表头字段是 `Main` + 单据标识，
 *      分录字段是 `Entry` + `<单据>.<分录>`，子分录是 `Subentry`。
 *   3. **平台运行态元数据**（MetaProbe）：表只收代码里点过名的、设计里自己声明的字段，
 *      继承来的 billno、creator、auditor 一个都没有——真机检测单 392 个已绑字段表里只认得 97 个。
 *      所以表里查不到不算「没有」，去平台核一次；平台也没有才当场报错，不留到落库（S32 批 2.5）。
 *      字段类型（日期、数值…）只有这里报，模板里还没用过的字段都要核它一次。
 */
export function fieldLookup(context: EditContext, replacing?: TplControl): FieldLookup {
	const design = context.design;
	const formId = String(design.formId ?? "");
	const known = new Map<string, FieldRef>();
	for (const site of allControls(design)) {
		const control = site.control;
		//正要改的这一格不算证据：它的绑定和公式马上被换掉，旧的写错了就会一直照抄下去
		if (control === replacing) continue;
		const bind = String(control.bindField ?? "");
		if (bind !== "" && String(control.dsType ?? "") !== "" && !known.has(bind)) {
			known.set(bind, {
				bindField: bind,
				formulaName: displayName(control) ?? bind,
				dsType: String(control.dsType),
				dataSource: String(control.dataSource ?? formId),
				...formatOf(control.textFormat),
			});
		}
		for (const operand of operandsOf(control.formulaData)) {
			if (operand.bindField !== "" && !known.has(operand.bindField)) {
				known.set(operand.bindField, {
					bindField: operand.bindField,
					formulaName: operand.formulaName || operand.bindField,
					dsType: operand.dsType,
					dataSource: operand.dataSource,
					...formatOf(operand.textFormat),
				});
			}
		}
	}

	return (bindField: string): FieldRef | string => {
		if (bindField === "") return "字段标识是空的";
		const reused = known.get(bindField);
		if (reused !== undefined) return reused;
		//带点的是引用字段的下级属性（`zlgd_jylx.name`），归属查的是点号前那一段
		const root = bindField.split(".")[0] as string;
		const tableHit = context.fields?.find((row) => row.entity === formId && row.key === root);
		const platform = context.platform;
		//字段类型只有平台元数据报：表里查得到归属也去平台核一次类型（下级属性的类型不是点号前那个字段的，不核）
		if (platform === undefined && tableHit !== undefined && root === bindField) context.unresolved?.add(root);
		const typed =
			platform !== undefined && !("error" in platform) && root === bindField
				? formatOf(platform.rows.find((row) => row.key === root)?.textFormat)
				: {};
		let hit: FieldOwnershipRow | undefined = tableHit;
		if (hit === undefined) {
			if (platform === undefined) {
				context.unresolved?.add(root);
				return `代码关系表没收字段「${bindField}」（表只收代码里用过的），平台元数据还没核`;
			}
			if ("error" in platform) {
				return `代码关系表没收字段「${bindField}」（表只收代码里用过的），平台元数据也没核成：${platform.error}`;
			}
			hit = platform.rows.find((row) => row.key === root);
			if (hit === undefined) {
				const near = platform.rows.filter((row) => row.key.includes(root.slice(0, 8)));
				const hint =
					near.length === 0
						? ""
						: `；同名相近的有 ${near
								.slice(0, 5)
								.map((r) => r.key)
								.join(" ")}`;
				return `单据 ${formId} 上没有字段「${bindField}」（按平台元数据核的）${hint}`;
			}
		}
		if (hit.level === "header") {
			return { bindField, formulaName: bindField, dsType: "Main", dataSource: formId, ...typed };
		}
		const entry = hit.entry ?? "";
		if (entry === "") return `字段「${bindField}」是 ${hit.level} 级，但没记分录标识，手工指定数据源`;
		return {
			bindField,
			formulaName: bindField,
			dsType: hit.level === "subentry" ? "Subentry" : "Entry",
			dataSource: `${formId}.${entry}`,
			...typed,
		};
	};
}

const formatOf = (value: unknown): { textFormat?: string } =>
	typeof value === "string" && value !== "" ? { textFormat: value } : {};

/** 直绑字段的格子上，`viewText` 是 `=$报告编号` 这样的显示名——拿它当字段的中文名。 */
function displayName(control: TplControl): string | null {
	const view = String(control.viewText ?? "");
	if (!view.startsWith("=$")) return null;
	const name = view.slice(2).split(".").pop() ?? "";
	return name === "" ? null : name;
}

function site(design: TplDesign, ref: string, what = "控件"): KernelResult<ControlSite> {
	const hit = findControl(design, ref);
	if (hit === null) {
		return err(
			fail(
				`模板里没有${what}「${ref}」`,
				"控件写 key（LayoutCell31）或 id；先跑 ptpl edit <候选目录> --overview 看有哪些。",
			),
		);
	}
	if (isAmbiguous(hit)) {
		return err(
			fail(`「${ref}」这个 key 在模板里有 ${hit.ambiguous.length} 个控件用，改用 id：${hit.ambiguous.join(" ")}`),
		);
	}
	return ok(hit);
}

// --------------------------------------------------------------- 2.2 公式

export interface SetFormulaInput {
	control: string;
	/** 每行一条表达式，字段写成 `<zlgd_ypph>`；给几行就是上下几行。 */
	lines: readonly string[];
	/** 所有字段都空时第一行显示的兜底文字。 */
	blankText?: string;
}

/**
 * 给一个格子设公式。
 *
 * 模型给的是业务意思：「上面批号、下面炉熔次号，都空显示 /」写成两行加一个兜底文字。
 * 片段数组怎么切、`_enter_` 放哪、操作数长什么样、多语言旁路里那条显示名——全在这里补齐。
 */
export function setFormula(context: EditContext, input: SetFormulaInput): KernelResult<EditSaid> {
	const found = site(context.design, input.control);
	if (!found.ok) return err(found.error);
	const control = found.value.control;
	const before = formulaText(control.formulaData);

	const taken = takenIds(context.design);
	//操作数 id 和控件 id 同一个命名空间：重复了平台的拓扑审计会报重复 id
	const built = buildFormula({
		lines: input.lines,
		...(input.blankText === undefined ? {} : { blankText: input.blankText }),
		resolve: fieldLookup(context, control),
		newId: () => makeId(taken, context.rand ?? Math.random),
	});
	if (built.errors.length > 0) {
		return err(fail(`公式写不成：${built.errors.join("；")}`, "字段写成 <字段标识>，换行就多给一行 --line。"));
	}

	//规则：带公式的格子自己不绑字段——dsType=Formula、bindField/dataSource 空、bindText 写「公式」
	control.formulaData = built.formula;
	control.dsType = "Formula";
	control.bindField = "";
	control.dataSource = "";
	control.bindText = "公式";
	control.viewText = "";
	syncLocale(context.locale, control.id, "bindText", "公式");

	//规则：操作数的显示名在多语言旁路里另记一条 `<控件id>.formulaData.<操作数id>`
	for (const key of Object.keys(context.locale)) {
		if (key.startsWith(`${control.id}.formulaData.`)) delete context.locale[key];
	}
	seedLocale(
		context.locale,
		control.id,
		Object.fromEntries(built.fields.map((field) => [`formulaData.${field.id}`, field.formulaName])),
		localeLangs(context.locale),
	);

	const notes = built.fields
		.filter((field) => field.formulaName === field.bindField)
		.map((field) => `字段 ${field.bindField} 没查到中文名，公式里显示的是字段标识本身`);
	return ok(
		said(
			`${label(control)} 的公式：${before === "" ? "（原来没有公式）" : before} -> ${formulaText(built.formula)}`,
			notes,
		),
	);
}

// ------------------------------------------------------------ 2.5 直绑字段

export function setBinding(context: EditContext, ref: string, bindField: string): KernelResult<EditSaid> {
	const found = site(context.design, ref);
	if (!found.ok) return err(found.error);
	const control = found.value.control;
	const field = fieldLookup(context, control)(bindField);
	if (typeof field === "string") {
		return err(
			fail(`绑不上：${field}`, "字段标识写的是元数据里的 key（billno、zlgd_xxx），不是中文名、也不是控件 key。"),
		);
	}
	const before = String(control.bindField ?? "") === "" ? "（原来没有绑定）" : String(control.bindField);
	control.bindField = field.bindField;
	control.dataSource = field.dataSource;
	control.dsType = field.dsType;
	control.textFormat = field.textFormat ?? "Text";
	//本来就没公式的格子不要写一个空数组进去：那会被差异算成「公式变化」，确认单上就多一条假的
	if (Array.isArray(control.formulaData) && control.formulaData.length > 0) control.formulaData = [];
	control.bindText = `=$${field.formulaName}`;
	control.viewText = `=$${field.formulaName}`;
	syncLocale(context.locale, control.id, "bindText", control.bindText);
	return ok(said(`${label(control)} 绑定：${before} -> ${field.bindField}（${field.dsType} / ${field.dataSource}）`));
}

/** 改一个格子的静态文字。 */
export function setText(context: EditContext, ref: string, value: string): KernelResult<EditSaid> {
	const found = site(context.design, ref);
	if (!found.ok) return err(found.error);
	const control = found.value.control;
	const before = String(control.bindText ?? "");
	control.bindText = value;
	control.viewText = value;
	control.bindField = "";
	control.dataSource = "";
	control.dsType = "";
	if (Array.isArray(control.formulaData) && control.formulaData.length > 0) control.formulaData = [];
	syncLocale(context.locale, control.id, "bindText", value);
	syncLocale(context.locale, control.id, "showText", value);
	return ok(said(`${label(control)} 文字：${before === "" ? "（空）" : before} -> ${value}`));
}

// ----------------------------------------------------------- 2.3 控件增删

/**
 * 克隆一个控件。
 *
 * 为什么「加控件」做成「克隆一个已有的」而不是从空白建：一个单元格有 60 多个属性
 * （字体、边框、内边距、对齐、零值显示…），凭空生成一份必然缺东西，而缺了什么
 * 要打出来才看得见。克隆一个同表格的邻居，再改那一两处业务属性，是唯一稳的做法。
 */
export function cloneControl(
	context: EditContext,
	ref: string,
	place?: { row?: number; column?: number },
): KernelResult<EditSaid> {
	const found = site(context.design, ref);
	if (!found.ok) return err(found.error);
	const source = found.value.control;
	const ids = takenIds(context.design);
	const keys = takenKeys(context.design);
	const copy = JSON.parse(JSON.stringify(source)) as TplControl;
	copy.id = makeId(ids, context.rand ?? Math.random);
	copy.key = makeKey(source.type, keys);
	const page = context.design.pages[found.value.page] as TplControl[];
	page.splice(found.value.index + 1, 0, copy);
	cloneLocale(context.locale, source.id, copy.id);

	//公式里的操作数 id 跟着换一套：操作数 id 在模板里也要唯一
	if (Array.isArray(copy.formulaData)) {
		const remap = new Map<string, string>();
		copy.formulaData = (copy.formulaData as unknown[]).map((part) => {
			if (!isOperand(part)) return part;
			const next = remap.get(part.id) ?? makeId(ids, context.rand ?? Math.random);
			remap.set(part.id, next);
			return { ...part, id: next };
		});
		for (const [from, to] of remap) {
			const value = context.locale[`${source.id}.formulaData.${from}`];
			delete context.locale[`${copy.id}.formulaData.${from}`];
			if (value !== undefined) context.locale[`${copy.id}.formulaData.${to}`] = { ...value };
		}
	}

	const notes: string[] = [];
	if (place !== undefined && (place.row !== undefined || place.column !== undefined)) {
		const moved = placeInGrid(context, copy, place);
		if (!moved.ok) return err(moved.error);
		notes.push(...moved.value.said);
	} else if (copy.rowId !== undefined && copy.columnId !== undefined) {
		//克隆出来的格子还占着原格子的行列坐标，一个位置两个格子，拓扑审计会报重复
		notes.push(`${copy.key} 现在和 ${source.key} 在同一个行列位置，用 --move ${copy.key} --row N --col N 挪开`);
	}
	return ok(said(`克隆 ${label(source)} -> ${label(copy)}（id ${copy.id}）`, notes));
}

export function deleteControl(context: EditContext, ref: string): KernelResult<EditSaid> {
	const found = site(context.design, ref);
	if (!found.ok) return err(found.error);
	const control = found.value.control;
	const kids = childrenOf(context.design, control.id);
	if (kids.length > 0) {
		return err(
			fail(
				`${label(control)} 底下还有 ${kids.length} 个子控件，删了会留下孤儿`,
				isGrid(control)
					? "删整张表格要连行、列、格子一起删：先 --delete-row / --delete-col 清空，再删表格。"
					: "先删子控件。",
			),
		);
	}
	const page = context.design.pages[found.value.page] as TplControl[];
	page.splice(found.value.index, 1);
	const dropped = dropLocale(context.locale, control.id);
	return ok(said(`删除 ${label(control)}（连带 ${dropped} 条多语言键）`));
}

/** 把一个格子挪到表格里的另一个行列位置。 */
function placeInGrid(
	context: EditContext,
	cell: TplControl,
	place: { row?: number; column?: number },
): KernelResult<EditSaid> {
	const parentId = String(cell.parentId ?? "");
	const view = gridView(context.design, parentId);
	if (view === null || isAmbiguous(view)) {
		return err(fail(`${label(cell)} 不在表格里，说不上第几行第几列`));
	}
	const lines: string[] = [];
	if (place.row !== undefined) {
		const row = view.rows[place.row - 1];
		if (row === undefined) return err(fail(`这张表格只有 ${view.rows.length} 行，没有第 ${place.row} 行`));
		cell.rowId = row.id;
		lines.push(`放到第 ${place.row} 行`);
	}
	if (place.column !== undefined) {
		const column = view.columns[place.column - 1];
		if (column === undefined) return err(fail(`这张表格只有 ${view.columns.length} 列，没有第 ${place.column} 列`));
		cell.columnId = column.id;
		lines.push(`放到第 ${place.column} 列`);
	}
	return ok(said(lines.join("，")));
}

export function moveControl(
	context: EditContext,
	ref: string,
	place: { row?: number; column?: number },
): KernelResult<EditSaid> {
	const found = site(context.design, ref);
	if (!found.ok) return err(found.error);
	const moved = placeInGrid(context, found.value.control, place);
	if (!moved.ok) return err(moved.error);
	return ok(said(`${label(found.value.control)} ${moved.value.said.join("，")}`));
}

// ----------------------------------------------------------- 2.4 表格行列

function gridOf(context: EditContext, ref: string): KernelResult<GridView> {
	const view = gridView(context.design, ref);
	if (view === null) return err(fail(`「${ref}」不是一张表格（只有 LayoutGrid / DataGrid 有行列）`));
	if (isAmbiguous(view)) {
		return err(fail(`「${ref}」这个 key 有 ${view.ambiguous.length} 个控件用，改用 id：${view.ambiguous.join(" ")}`));
	}
	return ok(view);
}

/**
 * 插一行。
 *
 * 「插一行」在数据里是三件事，少做一件模板就坏了：建一个 DataRow、给这一行
 * **每一列都配一个格子**、把合并区里在这一行之后的坐标整体下移。格子是照相邻那一行
 * 克隆的——见 `cloneControl` 里说的，凭空建一个格子必然缺属性。
 */
export function insertRow(context: EditContext, ref: string, at: number, copyFrom?: number): KernelResult<EditSaid> {
	const got = gridOf(context, ref);
	if (!got.ok) return err(got.error);
	const view = got.value;
	if (view.rows.length === 0) return err(fail(`${label(view.grid)} 还没有行，插不了`));
	if (at < 1 || at > view.rows.length + 1) {
		return err(
			fail(`第 ${at} 行插不进去：这张表格有 ${view.rows.length} 行，位置要在 1 到 ${view.rows.length + 1} 之间`),
		);
	}
	//「插到第几行」和「照哪一行的样式」是两件事：给了 --copy-row 就别再拿它当插入位置
	const modelIndex = clamp(
		(copyFrom ?? (at === view.rows.length + 1 ? view.rows.length : at)) - 1,
		0,
		view.rows.length - 1,
	);
	const model = view.rows[modelIndex] as TplControl;
	const ids = takenIds(context.design);
	const keys = takenKeys(context.design);
	const page = context.design.pages[view.page] as TplControl[];
	//行的先后顺序就是它们在页数组里的先后，所以插入点要按「第几行」算，不是按样板那一行算
	const anchor = view.rows[Math.min(at, view.rows.length) - 1] as TplControl;
	const insertAt = at > view.rows.length ? page.indexOf(anchor) + 1 : page.indexOf(anchor);

	const row = JSON.parse(JSON.stringify(model)) as TplControl;
	row.id = makeId(ids, context.rand ?? Math.random);
	row.key = makeKey("DataRow", keys);
	cloneLocale(context.locale, model.id, row.id);
	page.splice(insertAt, 0, row);

	let cells = 0;
	for (const [columnIndex, column] of view.columns.entries()) {
		const source = view.cells[modelIndex]?.[columnIndex];
		if (source === undefined || source === null) continue;
		const cell = JSON.parse(JSON.stringify(source)) as TplControl;
		cell.id = makeId(ids, context.rand ?? Math.random);
		cell.key = makeKey(view.cellType, keys);
		cell.rowId = row.id;
		cell.columnId = column.id;
		//新格子只继承样式，不继承内容——照抄绑定会打出两行一样的数据
		cell.bindField = "";
		cell.dataSource = "";
		cell.dsType = "";
		cell.bindText = "";
		cell.viewText = "";
		cell.formulaData = [];
		cloneLocale(context.locale, source.id, cell.id);
		for (const key of Object.keys(context.locale)) {
			if (key.startsWith(`${cell.id}.formulaData.`)) delete context.locale[key];
		}
		syncLocale(context.locale, cell.id, "bindText", "");
		syncLocale(context.locale, cell.id, "showText", "");
		page.splice(page.indexOf(source) + 1, 0, cell);
		cells++;
	}

	writeMerges(view.grid, shiftMerges(readMerges(view.grid), "row", at - 1, 1));
	//行号从 1 数、新行「成为」第 at 行；dump --grid 和 --expect 用的是 0 起的下标，两套一起报，
	//不然「插在第 5 行」到底是前是后、下标是几，只能插完再 dump 一遍才知道（2026-09-21 真机）
	return ok(
		said(
			`${label(view.grid)} 新行成了第 ${at} 行（0 起的下标 ${at - 1}），${place("行", at, view.rows.length)}；` +
				`照第 ${modelIndex + 1} 行的样式，配了 ${cells} 个格子`,
		),
	);
}

/** 插入位置的白话：夹在哪两行（列）之间。`before` 是插之前一共几行（列）。 */
function place(unit: string, at: number, before: number): string {
	if (at === 1) return `插在原第 1 ${unit}前面`;
	if (at > before) return `接在原最后一${unit}（第 ${before} ${unit}）后面`;
	return `夹在原第 ${at - 1} ${unit}和原第 ${at} ${unit}之间，原第 ${at} ${unit}起往后挪一${unit}`;
}

export function deleteRow(context: EditContext, ref: string, at: number): KernelResult<EditSaid> {
	const got = gridOf(context, ref);
	if (!got.ok) return err(got.error);
	const view = got.value;
	const row = view.rows[at - 1];
	if (row === undefined) return err(fail(`这张表格有 ${view.rows.length} 行，没有第 ${at} 行`));
	if (view.rows.length === 1) return err(fail("这是表格里最后一行，删了表格就空了；要删整张表格就删表格控件"));
	const page = context.design.pages[view.page] as TplControl[];
	let cells = 0;
	for (const cell of view.allCells.filter((cell) => cell.rowId === row.id)) {
		page.splice(page.indexOf(cell), 1);
		dropLocale(context.locale, cell.id);
		cells++;
	}
	page.splice(page.indexOf(row), 1);
	dropLocale(context.locale, row.id);
	writeMerges(view.grid, shiftMerges(readMerges(view.grid), "row", at - 1, -1));
	return ok(said(`${label(view.grid)} 删掉第 ${at} 行，连带 ${cells} 个格子`));
}

export function insertColumn(context: EditContext, ref: string, at: number, width?: number): KernelResult<EditSaid> {
	const got = gridOf(context, ref);
	if (!got.ok) return err(got.error);
	const view = got.value;
	if (view.columns.length === 0) return err(fail(`${label(view.grid)} 还没有列，插不了`));
	if (at < 1 || at > view.columns.length + 1) {
		return err(
			fail(
				`第 ${at} 列插不进去：这张表格有 ${view.columns.length} 列，位置要在 1 到 ${view.columns.length + 1} 之间`,
			),
		);
	}
	const modelIndex = clamp(
		(at === view.columns.length + 1 ? view.columns.length : at) - 1,
		0,
		view.columns.length - 1,
	);
	const model = view.columns[modelIndex] as TplControl;
	const ids = takenIds(context.design);
	const keys = takenKeys(context.design);
	const page = context.design.pages[view.page] as TplControl[];
	const anchor = view.columns[Math.min(at, view.columns.length) - 1] as TplControl;
	const insertAt = at > view.columns.length ? page.indexOf(anchor) + 1 : page.indexOf(anchor);

	const column = JSON.parse(JSON.stringify(model)) as TplControl;
	column.id = makeId(ids, context.rand ?? Math.random);
	column.key = makeKey("DataColumn", keys);
	if (width !== undefined) column.columnWidth = width;
	cloneLocale(context.locale, model.id, column.id);
	if (width !== undefined) syncLocale(context.locale, column.id, "columnWidth", width);
	page.splice(insertAt, 0, column);

	let cells = 0;
	for (const [rowIndex, row] of view.rows.entries()) {
		const source = view.cells[rowIndex]?.[modelIndex];
		if (source === undefined || source === null) continue;
		const cell = JSON.parse(JSON.stringify(source)) as TplControl;
		cell.id = makeId(ids, context.rand ?? Math.random);
		cell.key = makeKey(view.cellType, keys);
		cell.rowId = row.id;
		cell.columnId = column.id;
		cell.bindField = "";
		cell.dataSource = "";
		cell.dsType = "";
		cell.bindText = "";
		cell.viewText = "";
		cell.formulaData = [];
		cloneLocale(context.locale, source.id, cell.id);
		for (const key of Object.keys(context.locale)) {
			if (key.startsWith(`${cell.id}.formulaData.`)) delete context.locale[key];
		}
		syncLocale(context.locale, cell.id, "bindText", "");
		syncLocale(context.locale, cell.id, "showText", "");
		page.splice(page.indexOf(source) + 1, 0, cell);
		cells++;
	}

	writeMerges(view.grid, shiftMerges(readMerges(view.grid), "column", at - 1, 1));
	return ok(
		said(
			`${label(view.grid)} 新列成了第 ${at} 列（0 起的下标 ${at - 1}），${place("列", at, view.columns.length)}；` +
				`照第 ${modelIndex + 1} 列的样式，配了 ${cells} 个格子`,
		),
	);
}

export function deleteColumn(context: EditContext, ref: string, at: number): KernelResult<EditSaid> {
	const got = gridOf(context, ref);
	if (!got.ok) return err(got.error);
	const view = got.value;
	const column = view.columns[at - 1];
	if (column === undefined) return err(fail(`这张表格有 ${view.columns.length} 列，没有第 ${at} 列`));
	if (view.columns.length === 1) return err(fail("这是表格里最后一列，删了表格就空了；要删整张表格就删表格控件"));
	const page = context.design.pages[view.page] as TplControl[];
	let cells = 0;
	for (const cell of view.allCells.filter((cell) => cell.columnId === column.id)) {
		page.splice(page.indexOf(cell), 1);
		dropLocale(context.locale, cell.id);
		cells++;
	}
	page.splice(page.indexOf(column), 1);
	dropLocale(context.locale, column.id);
	writeMerges(view.grid, shiftMerges(readMerges(view.grid), "column", at - 1, -1));
	return ok(said(`${label(view.grid)} 删掉第 ${at} 列，连带 ${cells} 个格子`));
}

function clamp(value: number, low: number, high: number): number {
	return Math.min(Math.max(value, low), high);
}

// ------------------------------------------------------- 模板级：打印插件

/** 模板上登记的一个打印插件。键名是平台自己的写法（首字母大写）。 */
type TplPlugin = Record<string, unknown>;

/**
 * 读根节点 `plugins`。
 *
 * 规则：它不是数组，是**一段塞在字符串里的 JSON 数组**（真模板里量的），没登记过插件时是 null。
 * 所以这一项不能交给人或模型手改——引号要多转一层，写错了平台解析不报错，只是打印时插件不跑。
 * 里面的数字同样按原样读写（见 `parseDesignText`），老的登记项一个字节都不动。
 */
function readPlugins(design: TplDesign): KernelResult<{ list: TplPlugin[]; asArray: boolean }> {
	const raw = design.plugins;
	if (raw === undefined || raw === null || raw === "") return ok({ list: [], asArray: false });
	const bad = fail(
		"候选里的 plugins 读不懂（它应当是一段 JSON 数组文本）",
		"候选被手改过就 --reset 退回开工那一刻，再用 --plugin 登记。",
	);
	let parsed: unknown = raw;
	if (typeof raw === "string") {
		try {
			parsed = parseDesignText(raw);
		} catch {
			return err(bad);
		}
	}
	if (!Array.isArray(parsed) || parsed.some((one) => one === null || typeof one !== "object")) return err(bad);
	return ok({ list: parsed as TplPlugin[], asArray: typeof raw !== "string" });
}

function writePlugins(design: TplDesign, list: TplPlugin[], asArray: boolean): void {
	//一个都不剩时写回 null：没登记过插件的模板就是这个样子，加了又撤等于没改
	if (list.length === 0) design.plugins = null;
	else design.plugins = asArray ? list : stringifyDesign(list);
}

const pluginClass = (plugin: TplPlugin): string => String(plugin.ClassName ?? "");

function pluginSays(plugin: TplPlugin): string {
	const description = String(plugin.Description ?? "");
	return `${pluginClass(plugin)}${description === "" ? "" : `（${description}）`}${plugin.Enabled === false ? "［停用］" : ""}`;
}

/**
 * 给模板登记一个打印插件：接在已有插件后面，已有的原样保留。
 *
 * 登记项照已有的那一项克隆（和 `cloneControl` 同一个道理：键有哪些以这张模板自己的为准），
 * 模板上一个都没有时用设计器存出来的那九个键。
 */
export function addPlugin(context: EditContext, className: string, description?: string): KernelResult<EditSaid> {
	if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(className)) {
		return err(
			fail(
				`「${className}」不是一个带包名的类全名`,
				"写成 包名.类名（demo.plugin.print.DemoPrintPlugin），不带 .java、不带路径。",
			),
		);
	}
	const read = readPlugins(context.design);
	if (!read.ok) return err(read.error);
	const { list, asArray } = read.value;
	const existing = list.find((one) => pluginClass(one) === className);
	if (existing !== undefined) {
		const changed: string[] = [];
		if (existing.Enabled === false) {
			existing.Enabled = true;
			changed.push("原来是停用的，改成启用");
		}
		if (description !== undefined && String(existing.Description ?? "") !== description) {
			existing.Description = description;
			changed.push(`说明改成「${description}」`);
		}
		writePlugins(context.design, list, asArray);
		return ok(
			said(`插件 ${className} 已经登记在这张模板上：${changed.length === 0 ? "没有改动" : changed.join("，")}`),
		);
	}
	const rowKey = list.reduce((max, one) => Math.max(max, numberOf(one.RowKey, -1)), -1) + 1;
	const model = list[list.length - 1];
	const plugin: TplPlugin =
		model === undefined
			? {
					FPK: "",
					Type: 0,
					Description: "",
					RowKey: 0,
					ClassName: "",
					DisplayName: "",
					Enabled: true,
					BizAppId: "",
					Inherit: false,
				}
			: { ...model };
	plugin.Description = description ?? "";
	plugin.RowKey = rowKey;
	plugin.ClassName = className;
	plugin.Enabled = true;
	if ("FPK" in plugin) plugin.FPK = "";
	if ("DisplayName" in plugin) plugin.DisplayName = "";
	if ("Inherit" in plugin) plugin.Inherit = false;
	list.push(plugin);
	writePlugins(context.design, list, asArray);
	const kept = list.length - 1;
	//类找不找得到不在这里判：那要在苍穹进程里按平台的办法找，整份提交的预演会查（PrintTplWriteProbe.checkPlugins）
	return ok(
		said(
			`登记打印插件 ${pluginSays(plugin)}，排第 ${list.length} 个${kept === 0 ? "（模板原来没有插件）" : `，原有 ${kept} 个原样保留`}`,
		),
	);
}

/** 把一个打印插件从模板上撤掉，其余的顺序不变、序号重排。 */
export function removePlugin(context: EditContext, className: string): KernelResult<EditSaid> {
	const read = readPlugins(context.design);
	if (!read.ok) return err(read.error);
	const { list, asArray } = read.value;
	const at = list.findIndex((one) => pluginClass(one) === className);
	if (at < 0) {
		return err(
			fail(
				`这张模板上没有登记插件「${className}」`,
				list.length === 0 ? "模板上一个插件都没有。" : `登记着的是：${list.map(pluginClass).join(" ")}`,
			),
		);
	}
	list.splice(at, 1);
	for (const [index, one] of list.entries()) if ("RowKey" in one) one.RowKey = index;
	writePlugins(context.design, list, asArray);
	return ok(said(`撤掉打印插件 ${className}，模板上还剩 ${list.length} 个`));
}

/** 概览里那一行：模板上登记了哪些打印插件。 */
function pluginLine(design: TplDesign): string {
	const read = readPlugins(design);
	if (!read.ok) return "打印插件：plugins 读不懂（应当是一段 JSON 数组文本）";
	const list = read.value.list;
	return list.length === 0 ? "打印插件：没有" : `打印插件 ${list.length} 个：${list.map(pluginSays).join("、")}`;
}

// ------------------------------------------------------------------- 概览

/**
 * 本地结构概览：模板里有哪些表格、几行几列、每格显示什么。
 *
 * 和 `ptpl dump --overview` 回答同一个问题，但这一份是**从候选文件本地算的**，不进 JVM——
 * 改完之后想再看一眼现在长什么样，不该为此多跑一次 Java（S32 §4.2 的 ≤ 5 KB 预算）。
 */
export function overview(design: TplDesign, options: { grid?: string } = {}): string[] {
	const out: string[] = [];
	out.push(
		`模板 ${String(design.key ?? "")}（${String(design.name ?? "")}）挂 ${String(design.formId ?? "")}，共 ${design.pages.length} 页`,
	);
	out.push(pluginLine(design));
	for (const [pageIndex, page] of design.pages.entries()) {
		const grids = page.filter((control) => isGrid(control));
		const texts = page.filter((control) => control.type === "Text");
		out.push(`第 ${pageIndex + 1} 页：控件 ${page.length} 个，表格 ${grids.length} 张，文本 ${texts.length} 个`);
		for (const grid of grids) {
			if (options.grid !== undefined && grid.key !== options.grid && grid.id !== options.grid) continue;
			const view = gridView(design, grid.id);
			if (view === null || isAmbiguous(view)) continue;
			const merges = readMerges(grid);
			out.push(
				`  ${grid.key}(${grid.type}) ${view.rows.length} 行 × ${view.columns.length} 列` +
					`${merges.size === 0 ? "" : `，合并区 ${merges.size} 块`}`,
			);
			if (options.grid === undefined) continue;
			for (const [rowIndex, row] of view.cells.entries()) {
				for (const [columnIndex, cell] of row.entries()) {
					if (cell === null) {
						out.push(`    第 ${rowIndex + 1} 行第 ${columnIndex + 1} 列：缺格`);
						continue;
					}
					out.push(`    第 ${rowIndex + 1} 行第 ${columnIndex + 1} 列 ${cell.key}：${cellSays(cell)}`);
				}
			}
		}
	}
	return out;
}

function cellSays(cell: TplControl): string {
	if (Array.isArray(cell.formulaData) && cell.formulaData.length > 0)
		return `公式 ${formulaText(cell.formulaData, 80)}`;
	const bind = String(cell.bindField ?? "");
	if (bind !== "") return `绑定 ${bind}（${String(cell.dsType ?? "")}）`;
	const text = String(cell.bindText ?? "");
	return text === "" ? "（空）" : `文字「${text}」`;
}

// --------------------------------------------------------------- 变更摘要

export interface ChangeSummary {
	added: string[];
	removed: string[];
	formula: string[];
	binding: string[];
	other: string[];
	root: string[];
	total: number;
	oneLine: string;
}

/**
 * 候选和开工那一刻比，改了什么——和探针里 `PrintTplDiff.summarize` 同一个口径。
 *
 * 两边必须一样：这里是模型改完随时能看的「我改了什么」，那边是用户在确认单上看的
 * 「要写进去什么」。口径不一样的话，对不上就会有人去猜哪个是真的。
 */
export function summarizeChanges(before: TplDesign, after: TplDesign): ChangeSummary {
	const a = new Map(allControls(before).map((site) => [site.control.id, site.control]));
	const b = new Map(allControls(after).map((site) => [site.control.id, site.control]));
	const out: ChangeSummary = {
		added: [],
		removed: [],
		formula: [],
		binding: [],
		other: [],
		root: [],
		total: 0,
		oneLine: "",
	};
	const json = (value: unknown): string => JSON.stringify(value ?? null);

	for (const [id, control] of a) if (!b.has(id)) out.removed.push(label(control));
	for (const [id, control] of b) if (!a.has(id)) out.added.push(label(control));
	for (const [id, one] of a) {
		const other = b.get(id);
		if (other === undefined || json(one) === json(other)) continue;
		if (json(one.formulaData) !== json(other.formulaData)) out.formula.push(label(one));
		else if (
			json(one.bindField) !== json(other.bindField) ||
			json(one.dataSource) !== json(other.dataSource) ||
			json(one.dsType) !== json(other.dsType)
		) {
			out.binding.push(label(one));
		} else out.other.push(label(one));
	}
	for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
		if (key === "pages") continue;
		if (json(before[key]) !== json(after[key])) out.root.push(key);
	}

	out.total =
		out.added.length +
		out.removed.length +
		out.formula.length +
		out.binding.length +
		out.other.length +
		out.root.length;
	const parts: string[] = [];
	if (out.added.length > 0) parts.push(`新增 ${out.added.length} 个控件`);
	if (out.removed.length > 0) parts.push(`删除 ${out.removed.length} 个控件`);
	if (out.formula.length > 0) parts.push(`${out.formula.length} 处公式变化`);
	if (out.binding.length > 0) parts.push(`${out.binding.length} 处绑定变化`);
	if (out.other.length > 0) parts.push(`${out.other.length} 处属性变化`);
	if (out.root.length > 0) parts.push(`${out.root.length} 处模板级变化`);
	out.oneLine = parts.length === 0 ? "没有差异" : parts.join("，");
	return out;
}

// ----------------------------------------------------------------- 操作派发

/**
 * 一次 `meta ptpl edit` 就是一个操作。
 *
 * 一条命令一个操作，不做「一次给一串」：每个操作回一句话说改了什么，模型看着那句话决定下一步，
 * 出错也能当场指到是哪一步。省的那点轮数换不来「第三步失败时前两步已经写进候选」这种局面。
 */
export type EditOp =
	| { op: "open"; from: string }
	| { op: "status" }
	| { op: "reset" }
	| { op: "overview"; grid?: string }
	| { op: "formula"; control: string; lines: string[]; blankText?: string }
	| { op: "bind"; control: string; field: string }
	| { op: "text"; control: string; value: string }
	| { op: "clone"; control: string; row?: number; column?: number }
	| { op: "delete"; control: string }
	| { op: "move"; control: string; row?: number; column?: number }
	| { op: "insert-row"; grid: string; at: number; copyFrom?: number }
	| { op: "delete-row"; grid: string; at: number }
	| { op: "insert-col"; grid: string; at: number; width?: number }
	| { op: "delete-col"; grid: string; at: number }
	| { op: "plugin"; className: string; description?: string }
	| { op: "remove-plugin"; className: string };

/** 会改候选文件的操作——`open` / `status` / `reset` / `overview` 由命令层自己处置。 */
export function applyEdit(context: EditContext, op: EditOp): KernelResult<EditSaid> {
	switch (op.op) {
		case "formula":
			return setFormula(context, {
				control: op.control,
				lines: op.lines,
				...(op.blankText === undefined ? {} : { blankText: op.blankText }),
			});
		case "bind":
			return setBinding(context, op.control, op.field);
		case "text":
			return setText(context, op.control, op.value);
		case "clone":
			return cloneControl(context, op.control, {
				...(op.row === undefined ? {} : { row: op.row }),
				...(op.column === undefined ? {} : { column: op.column }),
			});
		case "delete":
			return deleteControl(context, op.control);
		case "move":
			return moveControl(context, op.control, {
				...(op.row === undefined ? {} : { row: op.row }),
				...(op.column === undefined ? {} : { column: op.column }),
			});
		case "insert-row":
			return insertRow(context, op.grid, op.at, op.copyFrom);
		case "delete-row":
			return deleteRow(context, op.grid, op.at);
		case "insert-col":
			return insertColumn(context, op.grid, op.at, op.width);
		case "delete-col":
			return deleteColumn(context, op.grid, op.at);
		case "plugin":
			return addPlugin(context, op.className, op.description);
		case "remove-plugin":
			return removePlugin(context, op.className);
		default:
			return err(fail(`「${(op as { op: string }).op}」这个操作要在命令层处置，不该走到这里`));
	}
}

export { ENTER, formulaText };
