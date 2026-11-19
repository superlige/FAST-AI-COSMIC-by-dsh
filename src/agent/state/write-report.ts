/**
 * 写元数据的确认单：一次写调用、一张确认单、用户点一次确认才落库。
 *
 * 一段话看懂：模型调写元数据（探针 APPLY=1 或 cosmic_meta 写动作 apply=true）时顺手交一份 `report`：
 * 一句目的、每个标识的中文名、少数要翻成人话的格子、可选一句注意事项和替用户定的口径。
 * 工具先在内部预演一次，按预演的入参和探针记录生成这一项的表单（`kernel/policy/write-form.ts`），
 * 这里核对模型交的格子和表单要的一个不多一个不少、没把标识塞进人话里，然后排成确认单弹给用户。
 *
 * 为什么事实不经模型转述：对象、类型、原值、新值、写入范围、怎么撤回工具都有，
 * 模型写出来的是标识和中文名搅在一起的长句，用户读不下去。模型只填工具填不了的人话。
 */

import type { FormCell, FormFill, FormLine, FormTable, WriteForm } from "../../kernel/policy/write-form.ts";

/** 目的、注意事项的长度上限。 */
export const MAX_PURPOSE_TEXT = 40;
/** 中文名的长度上限。 */
export const MAX_NAME_TEXT = 30;
/** 人话格的长度上限。 */
export const MAX_SLOT_TEXT = 60;

/** 预演跑通后得到的一项待写操作：确认单的全部事实都在这里，模型只补人话。 */
export interface WritePlan {
	/** 写探针类名；`cosmic_meta` 的写动作记的是它底下那个探针。 */
	probe: string;
	/** 修改类别，给人看，例如「表单界面规则」。 */
	kind: string;
	/** `writePlanDigest(probe, 入参去掉 APPLY)`：落库那次和预演是不是同一个操作。 */
	digest: string;
	/** 这次是怎么调的，供复看：`探针名 K=V …`。 */
	call: string;
	/** 这一项落库时允许写的全部对象：入参算出的加上探针预演报的清单。 */
	targets: string[];
	form: WriteForm;
	/** 改数据的改前快照，落库时交回探针核对原值没变。 */
	baseline?: string;
}

/** 模型替用户定的一条口径：需求没说、模型自己选了做法的地方，一句做法、一句另一种。 */
export interface DecisionInput {
	chose: string;
	other: string;
}

/** 模型为确认单填的值。 */
export interface ReportInput {
	purpose: string;
	names?: readonly { id: string; name: string }[];
	slots?: readonly { key: string; text: string }[];
	note?: string;
	decisions?: readonly DecisionInput[];
}

/** 用户看到、确认的那一项。 */
export interface ConfirmedChange {
	plan: WritePlan;
	fill: FormFill;
	decisions: DecisionInput[];
	/** 改的是哪个对象，`中文名（标识）`。 */
	object: string;
}

/** 给模型看的解释，工具参数和拒绝语共用一份。 */
export const REPORT_FIELDS = {
	report:
		"写元数据时必填：确认单上要你写的人话。工具先预演，按预演结果排出确认单（对象、类型、原值新值、影响、撤回、写入范围都由工具填），" +
		"你只填下面几格；格子对不上时不弹确认、不写，返回照着填的模板",
	purpose: `这一项为什么要做，一句话，不超过 ${String(MAX_PURPOSE_TEXT)} 字，不写标识。例如「保存修约前的原始记录值」`,
	names: "表单里每个标识的中文名，一个不多一个不少。只写名字，不写句子、不带标识",
	slots: `表单里要翻成人话的格子，按模板给的 key 逐个填，每格不超过 ${String(MAX_SLOT_TEXT)} 字，不写标识`,
	note: `可选：一句注意事项，不超过 ${String(MAX_PURPOSE_TEXT)} 字，不写标识。影响和撤回工具已经写好，不用重复`,
	decisions:
		"需求没说、由你选了做法的地方，列在确认单上让用户一并定。每条一句做法、一句另一种，" +
		"例如 {chose:「下拉用字母存储值」, other:「用数字存储值」}。没有就给空数组",
	chose: `这次怎么做的，不超过 ${String(MAX_SLOT_TEXT)} 字，不写标识`,
	other: `另一种做法，不超过 ${String(MAX_SLOT_TEXT)} 字，不写标识`,
} as const;

/** 长得像苍穹标识的词：字母开头、带下划线。人话格里出现它，就又回到了「标识 + 中文名搅在一起」。 */
const IDENTIFIER = /(?<![A-Za-z0-9_])[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+/;

/** 一次调用的可读形式：`探针 K=V …`。值过长的截断，只为让人认得出是哪次。 */
export function writePlanCall(probe: string, env: Readonly<Record<string, string>>): string {
	const parts = Object.entries(env)
		.filter(([key, value]) => key !== "APPLY" && value !== "")
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		// SEED_ROWS 这类多行值：换行进了确认框会把一项拆成好几行，读起来像好几项。
		.map(([key, raw]) => [key, raw.replace(/\r?\n/g, " / ")] as const)
		.map(([key, value]) => `${key}=${value.length > 60 ? `${value.slice(0, 57)}…` : value}`);
	return [probe, ...parts].join(" ");
}

/** 这一项的 `report` 照着填的 JSON：直接给形状而不是给说明，模型照着填出来的格子就是这里核对的格子。 */
export function fillTemplate(form: WriteForm): string {
	const template: Record<string, unknown> = { purpose: "<一句话目的>" };
	if (form.names.length > 0) template.names = form.names.map((id) => ({ id, name: "<中文名>" }));
	if (form.slots.length > 0) template.slots = form.slots.map((slot) => ({ key: slot.key, text: `<${slot.hint}>` }));
	template.decisions = [];
	return JSON.stringify(template);
}

export type ReportCheck = { ok: true; change: ConfirmedChange } | { ok: false; message: string; remedy: string };

function refuse(message: string, remedy: string): ReportCheck {
	return { ok: false, message, remedy };
}

/** 一段模型写的话能不能进确认单：不空、不超长、不换行、不夹标识。 */
function badText(value: string | undefined, max: number, allowEmpty = false): string | null {
	const text = (value ?? "").trim();
	if (text === "") return allowEmpty ? null : "是空的";
	if (/[\r\n]/.test(text)) return "里有换行";
	if ([...text].length > max) return `超过 ${String(max)} 字`;
	const id = IDENTIFIER.exec(text);
	if (id !== null) return `里夹了标识「${id[0]}」（标识由工具显示在旁边一列，人话格里只写人话）`;
	return null;
}

/**
 * 模型交来的 `report` 能不能用：目的要写；表单要的中文名和人话格一个不多一个不少，
 * 写的都是短短的人话；口径每条两格都是人话、不重复。条数不设上限——需求里真有那么多没说清的地方，
 * 该让用户都看到。
 */
export function checkReport(plan: WritePlan, input: ReportInput | undefined): ReportCheck {
	const form = plan.form;
	const template = fillTemplate(form);
	if (plan.targets.length === 0) {
		return refuse(
			`${plan.kind} 的预演没有报写入目标清单`,
			"写探针跑通时会打一行「写入目标清单」；缺失说明探针目标收集或运行版本有问题，不能写。",
		);
	}
	if (input === undefined) {
		return refuse(`写${plan.kind}要附上确认单的 report`, `照这个填 report（只替换尖括号里的内容）：${template}`);
	}
	const purpose = badText(input.purpose, MAX_PURPOSE_TEXT);
	if (purpose !== null) return refuse(`report 的目的${purpose}`, `${REPORT_FIELDS.purpose}。照这个填：${template}`);
	const note = badText(input.note, MAX_PURPOSE_TEXT, true);
	if (note !== null) return refuse(`report 的注意事项${note}`, REPORT_FIELDS.note);

	const names: Record<string, string> = {};
	for (const entry of input.names ?? []) {
		const id = entry.id.trim().toLowerCase();
		if (!form.names.includes(id)) {
			return refuse(
				`确认单里没有要填名字的标识「${entry.id}」`,
				form.names.length === 0
					? "这一项不用填 names（名字探针已经报了），去掉它。"
					: `这一项只要这几个标识的中文名：${form.names.join("、")}。照这个填：${template}`,
			);
		}
		const bad = badText(entry.name, MAX_NAME_TEXT);
		if (bad !== null) return refuse(`「${id}」的中文名${bad}`, REPORT_FIELDS.names);
		names[id] = entry.name.trim();
	}
	const missingNames = form.names.filter((id) => names[id] === undefined);
	if (missingNames.length > 0) {
		return refuse(
			`还缺 ${String(missingNames.length)} 个标识的中文名：${missingNames.join("、")}`,
			`确认单里每个标识旁边都要有中文名。照这个填：${template}`,
		);
	}

	const slots: Record<string, string> = {};
	for (const entry of input.slots ?? []) {
		const slot = form.slots.find((candidate) => candidate.key === entry.key.trim());
		if (slot === undefined) {
			return refuse(
				`确认单里没有「${entry.key}」这一格`,
				form.slots.length === 0
					? "这一项没有要翻成人话的格子，去掉 slots。"
					: `这一项只有这几格：${form.slots.map((candidate) => candidate.key).join("、")}。照这个填：${template}`,
			);
		}
		const bad = badText(entry.text, MAX_SLOT_TEXT);
		if (bad !== null) return refuse(`「${slot.key}」格${bad}`, `这一格填：${slot.hint}。`);
		slots[slot.key] = entry.text.trim();
	}
	const missingSlots = form.slots.filter((slot) => slots[slot.key] === undefined);
	if (missingSlots.length > 0) {
		return refuse(
			`还有 ${String(missingSlots.length)} 格没填：${missingSlots.map((slot) => `${slot.key}（${slot.hint}）`).join("；")}`,
			`照这个填：${template}`,
		);
	}

	const decisions: DecisionInput[] = [];
	for (const [index, item] of (input.decisions ?? []).entries()) {
		const at = `第 ${String(index + 1)} 条口径`;
		for (const [key, label] of [
			["chose", "做法"],
			["other", "另一种"],
		] as const) {
			const bad = badText(item[key], MAX_SLOT_TEXT);
			if (bad !== null) return refuse(`${at}的「${label}」${bad}`, REPORT_FIELDS[key]);
		}
		const chose = item.chose.trim();
		if (decisions.some((decision) => decision.chose === chose)) {
			return refuse(`${at}「${chose}」重复了`, "同一个做法写一条就够。");
		}
		decisions.push({ chose, other: item.other.trim() });
	}

	const fill: FormFill = {
		purpose: input.purpose.trim(),
		names,
		slots,
		...((input.note ?? "").trim() === "" ? {} : { note: (input.note ?? "").trim() }),
	};
	return { ok: true, change: { plan, fill, decisions, object: formObject(form, fill) } };
}

// ---------------------------------------------------------------- 排版

/**
 * 等宽字体里的显示宽度：中日韩文字、全角标点、表情占两格，组合用的附加符号占零格。
 * 本会话事实（cosmic_facts）里那份表单是纯文本，列要靠它对齐。
 */
export function displayWidth(text: string): number {
	let width = 0;
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;
		if (code === 0 || /\p{Mn}|\p{Me}|\p{Cf}/u.test(char)) continue;
		width += isWide(code) || /\p{Extended_Pictographic}/u.test(char) ? 2 : 1;
	}
	return width;
}

/** 东亚宽字符的主要区段（和终端的取法一致）。 */
function isWide(code: number): boolean {
	return (
		(code >= 0x1100 && code <= 0x115f) ||
		(code >= 0x2e80 && code <= 0x303e) ||
		(code >= 0x3041 && code <= 0x33ff) ||
		(code >= 0x3400 && code <= 0x4dbf) ||
		(code >= 0x4e00 && code <= 0x9fff) ||
		(code >= 0xa000 && code <= 0xa4cf) ||
		(code >= 0xac00 && code <= 0xd7a3) ||
		(code >= 0xf900 && code <= 0xfaff) ||
		(code >= 0xfe30 && code <= 0xfe4f) ||
		(code >= 0xff00 && code <= 0xff60) ||
		(code >= 0xffe0 && code <= 0xffe6) ||
		(code >= 0x20000 && code <= 0x3fffd)
	);
}

function pad(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - displayWidth(text)));
}

function cellText(cell: FormCell, form: WriteForm, fill: FormFill): string {
	if ("text" in cell) return cell.text;
	if ("name" in cell) return nameOf(cell.name, form, fill);
	if ("names" in cell) return cell.names.map((id) => nameOf(id, form, fill)).join("、");
	return fill.slots[cell.slot] ?? "";
}

function nameOf(id: string, form: WriteForm, fill: FormFill): string {
	return form.known[id] ?? fill.names[id] ?? id;
}

/** 执行结果里那一句「改的是哪个对象」：表头第一行，`中文名（标识）`。 */
function formObject(form: WriteForm, fill: FormFill): string {
	const first = form.head[0];
	if (first === undefined) return form.kind;
	const values = first.cells.map((cell) => cellText(cell, form, fill)).filter((value) => value !== "");
	return values.length >= 2 && values[0] !== values[1] ? `${values[0]}（${values[1]}）` : (values[0] ?? form.kind);
}

/** 对齐的几列；太宽放不下时返回 null，由调用方退成卡片。 */
function grid(rows: readonly string[][], indent: string, width: number, header?: readonly string[]): string[] | null {
	const all = header === undefined ? rows : [header, ...rows];
	const columns = Math.max(0, ...all.map((row) => row.length));
	// 每行最后一格后面没有东西要对齐，不参与算列宽：表头区「目的」那一句很长，算进去会把
	// 上面「单据  中文名  标识」的中文名一列撑出一大截空白。
	const widths = Array.from({ length: columns }, (_, column) =>
		Math.max(0, ...all.map((row) => (column < row.length - 1 ? displayWidth(row[column] ?? "") : 0))),
	);
	const lastWidth = Math.max(
		0,
		...all.map(
			(row) =>
				displayWidth(row.at(-1) ?? "") +
				displayWidth(indent) +
				row.slice(0, -1).reduce((sum, _value, column) => sum + (widths[column] ?? 0) + 2, 0),
		),
	);
	if (lastWidth > width) return null;
	return all.map((row) =>
		(
			indent +
			row.map((value, column) => (column === row.length - 1 ? value : pad(value, widths[column] ?? 0))).join("  ")
		).trimEnd(),
	);
}

function renderTable(table: FormTable, form: WriteForm, fill: FormFill, width: number): string[] {
	let previous = "";
	const rows = table.rows.map((row) => {
		const values = row.map((cell) => cellText(cell, form, fill));
		if (table.group === true) {
			const first = values[0] ?? "";
			if (first === previous) values[0] = "";
			else previous = first;
		}
		return values;
	});
	const aligned = grid(rows, "  ", width, table.columns);
	if (aligned !== null) return aligned;
	// 卡片：一行一个「列名：值」，窄屏也不会对不齐。
	const out: string[] = [];
	let group = "";
	for (const row of table.rows) {
		const values = row.map((cell) => cellText(cell, form, fill));
		const first = values[0] ?? "";
		if (table.group === true) {
			if (first !== group) {
				out.push(`  ▸ ${table.columns[0] === "" ? "" : `${table.columns[0]}：`}${first}`);
				group = first;
			}
			out.push(
				`      ${values
					.slice(1)
					.map((value, column) => labelled(table.columns[column + 1], value))
					.join("；")}`,
			);
			continue;
		}
		out.push(`  ▸ ${labelled(table.columns[0], first)}`);
		values.slice(1).forEach((value, column) => {
			if (value !== "") out.push(`      ${labelled(table.columns[column + 1], value)}`);
		});
	}
	return out;
}

function labelled(column: string | undefined, value: string): string {
	return column === undefined || column === "" ? value : `${column}：${value}`;
}

/**
 * 一项的表单：
 *
 *   新增字段（元数据）
 *     单据  实验室检测单      zlgd_sys_test_bill
 *     位置  拉伸试验结果分录  zlgd_entryentity_lssy
 *     目的  保存修约前的原始记录值
 *
 *     字段名称            标识               类型
 *     抗拉强度原始记录值  zlgd_klqd_ls_ysjl  小数(23,10)
 *
 *     影响  业务表加 13 列，所有人打开单据立即看到新字段
 *     撤回  用「删除字段」逐个删；库里的列删不掉，会留下没人用的空列
 */
export function renderForm(form: WriteForm, fill: FormFill, width: number): string[] {
	const out = [`${form.kind}（${form.category}）`];
	const head = [
		...form.head.map((line) => [line.label, ...line.cells.map((cell) => cellText(cell, form, fill))]),
		["目的", fill.purpose],
	];
	out.push(...(grid(head, "  ", width) ?? head.map((row) => `  ${row[0] ?? ""}：${row.slice(1).join("  ")}`)));
	for (const table of form.tables) {
		out.push("");
		out.push(...renderTable(table, form, fill, width));
	}
	out.push("");
	const tail = [["影响", form.impact], ["撤回", form.undo], ...(fill.note === undefined ? [] : [["注意", fill.note]])];
	out.push(...tail.map((row) => `  ${pad(row[0] ?? "", 4)}  ${row[1] ?? ""}`));
	return out;
}

/** 写入范围按对象归组：`demo_bill` 下 `demo_layout`、`demo_f1`，带前缀的 `data:` / `tpl:` 各成一组。 */
function targetGroups(targets: readonly string[]): [string, string[]][] {
	const groups = new Map<string, string[]>();
	for (const target of targets) {
		const tag = /^([a-z]+):(.+)$/.exec(target);
		const dot = target.indexOf(".");
		const [group, item] =
			tag !== null
				? [`${tag[1]}:`, tag[2] ?? ""]
				: dot < 0
					? [target, ""]
					: [target.slice(0, dot), target.slice(dot + 1)];
		const list = groups.get(group) ?? [];
		if (item !== "") list.push(item);
		groups.set(group, list);
	}
	return [...groups.entries()];
}

// ---------------------------------------------------------------- 确认框（Markdown）

/** Markdown 里有含义的字符前加反斜杠，原文照字显示：`$` 会被当成公式，`|` 会把表格格子拆开。 */
function mdText(text: string): string {
	return text.replace(/\r?\n/g, " / ").replace(/[\\`*_~[\]<>|$#]/g, "\\$&");
}

/** 标识、条件原文放进行内代码，和人话分开。代码里的 `|` 在表格中照样会拆格子，也要转义。 */
function mdCode(text: string): string {
	const body = text.replace(/\r?\n/g, " / ").replace(/\|/g, "\\|");
	return body.includes("`") ? `\`\` ${body} \`\`` : `\`${body}\``;
}

/** 一整格就是一个标识（字母开头、带下划线或点）：显示成代码。 */
const WHOLE_IDENTIFIER = /^[A-Za-z][A-Za-z0-9]*[_.][A-Za-z0-9_.]*$/;
/** 这几列放的是标识或原文，整列显示成代码。 */
const CODE_COLUMN = /标识|id|原文|公式/;
/** 原值、新值两列：原值划掉、新值加粗，一眼看出改了哪里。 */
const OLD_COLUMNS = new Set(["原来", "原值", "原条件"]);
const NEW_COLUMNS = new Set(["改后", "新值", "新条件"]);
/** 「—」「（默认）」「（预演没报）」这类占位：不是真值，不划不加粗。 */
const PLACEHOLDER = /^(?:|—|-|（.*）)$/;

function mdCell(
	value: string,
	options: { code?: boolean; old?: boolean; fresh?: boolean; changed?: boolean } = {},
): string {
	if (value === "") return "";
	const body = options.code === true || WHOLE_IDENTIFIER.test(value) ? mdCode(value) : mdText(value);
	if (PLACEHOLDER.test(value) || options.changed === false) return body;
	if (options.old === true) return `~~${body}~~`;
	if (options.fresh === true) return `**${body}**`;
	return body;
}

function mdTable(table: FormTable, form: WriteForm, fill: FormFill): string[] {
	const columns = table.columns;
	const oldAt = columns.findIndex((column) => OLD_COLUMNS.has(column));
	const newAt = columns.findIndex((column) => NEW_COLUMNS.has(column));
	let previous = "";
	const rows = table.rows.map((row) => {
		const values = row.map((cell) => cellText(cell, form, fill));
		const changed = oldAt < 0 || newAt < 0 ? undefined : values[oldAt] !== values[newAt];
		// 第一列没有列名时它是行名（「条件原文」），这一行整行按行名判是不是代码
		const codeRow = columns[0] === "" && CODE_COLUMN.test(values[0] ?? "");
		const shown = values.map((value, column) =>
			mdCell(value, {
				code: column > 0 && (codeRow || CODE_COLUMN.test(columns[column] ?? "")),
				old: column === oldAt,
				fresh: column === newAt,
				...(changed === undefined ? {} : { changed }),
			}),
		);
		if (table.group === true) {
			const first = values[0] ?? "";
			if (first === previous) shown[0] = "";
			else previous = first;
		}
		return shown;
	});
	const line = (cells: readonly string[]) => `| ${cells.join(" | ")} |`;
	return [
		line(columns.map((column) => (column === "" ? " " : mdText(column)))),
		line(columns.map(() => "---")),
		...rows.map((row) => line(columns.map((_column, index) => row[index] ?? ""))),
	];
}

/** 表头区一行：标签加粗；第一格是中文名，后面的格是标识（显示成代码）。中文名找不到时只显示一次标识。 */
function mdHeadLine(line: FormLine, form: WriteForm, fill: FormFill): string {
	const values = line.cells.map((cell) => cellText(cell, form, fill)).filter((value) => value !== "");
	const shown = values
		.filter((value, index) => index === 0 || value !== values[0])
		.map((value, index) => mdCell(value, { code: index > 0 }));
	return `- **${mdText(line.label)}**：${shown.join(" ")}`;
}

/**
 * 确认框里的那份确认单。格式固定，只由这里生成：表单、口径、写入范围、确认后会发生什么。
 * 确认框按 Markdown 显示（命令行里交给模型转给用户时也是 Markdown），所以排成列表和表格：
 * 标识显示成代码、和中文名分开；原值划掉、新值加粗，改了哪里不用逐字对。
 */
export function confirmationCard(change: ConfirmedChange): string {
	const { form, targets, probe } = change.plan;
	const fill = change.fill;
	const summary = form.summary !== "" && form.summary !== probe ? ` · ${mdText(form.summary)}` : "";
	const out = [`**${mdText(form.kind)}**（${form.category}）${summary}`, ""];
	out.push(...form.head.map((line) => mdHeadLine(line, form, fill)), `- **目的**：${mdText(fill.purpose)}`);
	for (const table of form.tables) out.push("", ...mdTable(table, form, fill));
	out.push("", `- **影响**：${mdText(form.impact)}`, `- **撤回**：${mdText(form.undo)}`);
	if (fill.note !== undefined) out.push(`- **注意**：${mdText(fill.note)}`);
	out.push("");
	// 口径放在表单之后、写入范围之前：读到这里用户已经知道改了什么，口径说的就是这些改动里没说清的地方。
	if (change.decisions.length > 0) {
		out.push(
			`**我替你定的口径 ${String(change.decisions.length)} 条**（需求没说，AI 选的；哪条不合意就不确认，说要哪种）`,
			"",
		);
		change.decisions.forEach((decision, index) => {
			out.push(`${String(index + 1)}. ${mdText(decision.chose)}`, `   - 另一种：${mdText(decision.other)}`);
		});
		out.push("");
	}
	out.push(`**写入范围**：${String(targets.length)} 个对象，由预演算出，范围外的对象会被拦下`, "");
	for (const [group, items] of targetGroups(targets)) {
		const head = group.endsWith(":") ? mdText(group) : mdCode(group);
		out.push(items.length === 0 ? `- ${head}` : `- ${head}：${items.map(mdCode).join("、")}`);
	}
	out.push("", "确认后立即写进测试环境，写完回读核对；不确认则什么都不写。");
	return out.join("\n");
}

// ---------------------------------------------------------------- 确认卡片（界面插件画）

/**
 * 弹窗正文末尾那段数据的代码块标记。界面插件（client/brand.js）认得它，就不显示正文，
 * 按数据画成对比卡片：每处改动一行，标新增 / 删除 / 修改，原值划掉、新值高亮。
 * 认不得的界面照常显示上面的 Markdown 确认单。
 */
export const CARD_FENCE = "cosmic-write-card";

/** 一处改动是什么：新增、删除、原值改新值、只给了新值（「改成」）、前后一样。 */
export type CardOp = "add" | "remove" | "change" | "set" | "same";

export interface CardDiffRow {
	op: CardOp;
	/** 原值、新值之前那几列（元素、改哪里）。 */
	keys: string[];
	old: string;
	new: string;
}

/** 有原值、新值两列的表画成改动清单；其余的照表格画。`code` 标哪几列放的是标识或原文。 */
export type CardTable =
	| { type: "diff"; columns: string[]; code: boolean[]; group: boolean; rows: CardDiffRow[] }
	| { type: "grid"; columns: string[]; code: boolean[]; group: boolean; rows: string[][] };

/** 界面插件画卡片要的全部内容：格子都已换成最终显示的字，插件不用再查名字。 */
export interface CardView {
	v: 1;
	kind: string;
	category: string;
	summary: string;
	/** 改的是哪个对象：表头第一行是「中文名 + 标识」时单独拿出来当标题。 */
	object: { label: string; name: string; id: string } | null;
	head: { label: string; values: string[] }[];
	purpose: string;
	note?: string;
	tables: CardTable[];
	counts: Record<"add" | "remove" | "change" | "set", number>;
	/** 影响按「；」拆成几条。 */
	impact: string[];
	undo: string;
	decisions: DecisionInput[];
	targets: { group: string; items: string[] }[];
	targetCount: number;
}

/** 只给新值、没有原值的那一列（BOTP 的「改成」）。 */
const SET_COLUMNS = new Set(["改成"]);
/** 一侧本来没有东西。 */
const BLANK = /^(?:|—|-)$/;

function cardOp(keys: readonly string[], old: string, fresh: string): CardOp {
	if (keys.includes("（新增）")) return "add";
	if (keys.includes("（删除）")) return "remove";
	if (old === fresh) return "same";
	if (BLANK.test(old) && !BLANK.test(fresh)) return "add";
	if (!BLANK.test(old) && BLANK.test(fresh)) return "remove";
	return "change";
}

function cardTable(table: FormTable, form: WriteForm, fill: FormFill): CardTable {
	const columns = table.columns;
	const values = table.rows.map((row) => row.map((cell) => cellText(cell, form, fill)));
	const code = columns.map((column) => CODE_COLUMN.test(column));
	const group = table.group === true;
	const oldAt = columns.findIndex((column) => OLD_COLUMNS.has(column));
	const newAt = columns.findIndex((column) => NEW_COLUMNS.has(column) || SET_COLUMNS.has(column));
	const keyEnd = oldAt >= 0 ? oldAt : newAt;
	// 原值、新值要挨着排在最后，前面全是「改了谁」：不是这个形状的表照表格画
	const diffShaped = newAt >= 0 && newAt === columns.length - 1 && (oldAt < 0 || oldAt === newAt - 1);
	if (!diffShaped) return { type: "grid", columns, code, group, rows: values };
	return {
		type: "diff",
		columns: columns.slice(0, keyEnd),
		code: code.slice(0, keyEnd),
		group,
		rows: values.map((row) => {
			const keys = row.slice(0, keyEnd);
			const old = oldAt < 0 ? "" : (row[oldAt] ?? "");
			const fresh = row[newAt] ?? "";
			return { op: oldAt < 0 ? "set" : cardOp(keys, old, fresh), keys, old, new: fresh };
		}),
	};
}

/** 确认单排成界面插件画卡片用的数据，事实和 Markdown 那份同一来源。 */
export function cardView(change: ConfirmedChange): CardView {
	const { form, targets } = change.plan;
	const fill = change.fill;
	const head = form.head.map((line) => ({
		label: line.label,
		values: line.cells.map((cell) => cellText(cell, form, fill)).filter((value) => value !== ""),
	}));
	const first = head[0];
	const named = first !== undefined && first.values.length === 2 && form.head[0]?.cells[1] !== undefined;
	const object =
		named && first !== undefined
			? { label: first.label, name: first.values[0] ?? "", id: first.values[1] ?? "" }
			: null;
	const tables = form.tables.map((table) => cardTable(table, form, fill));
	const counts = { add: 0, remove: 0, change: 0, set: 0 };
	for (const table of tables)
		if (table.type === "diff") for (const row of table.rows) if (row.op !== "same") counts[row.op] += 1;
	return {
		v: 1,
		kind: form.kind,
		category: form.category,
		summary: form.summary !== change.plan.probe ? form.summary : "",
		object,
		head: object === null ? head : head.slice(1),
		purpose: fill.purpose,
		...(fill.note === undefined ? {} : { note: fill.note }),
		tables,
		counts,
		impact: form.impact
			.split("；")
			.map((part) => part.trim())
			.filter((part) => part !== ""),
		undo: form.undo,
		decisions: change.decisions,
		targets: targetGroups(targets).map(([group, items]) => ({ group, items })),
		targetCount: targets.length,
	};
}

/**
 * 弹窗正文：Markdown 确认单，末尾附一段卡片数据（一行 JSON，放在四个反引号的代码块里）。
 * JSON 里的反引号写成 `，数据里再怎么写都顶不破代码块。
 */
export function confirmationDetail(change: ConfirmedChange): string {
	const data = JSON.stringify(cardView(change)).replace(/`/g, "\\u0060");
	return `${confirmationCard(change)}\n\n\`\`\`\`${CARD_FENCE}\n${data}\n\`\`\`\``;
}
