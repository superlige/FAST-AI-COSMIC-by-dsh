/**
 * 打印公式的拼装与朗读（S32 批 2.2）。
 *
 * 一条打印公式**不是一个字符串**，是一串片段：文字片段、字段操作数、换行记号 `_enter_`。
 * 模型说的应该是业务意思——「上面显示批号，下面显示炉熔次号，都空就显示斜杠」——
 * 片段数组怎么摆、操作数长什么样、换行记号能放在哪，由这里拼。
 *
 * 从 24 个真实样本量出来的规矩（S32 §10.5 + 2026-09-21 复量）：
 *
 *   - `_enter_` 是**数组顶层的一个元素**，把公式切成上下几行；两条 `_enter_` 之间的
 *     文字片段和操作数**拼起来**才是一条完整表达式，不是一段一个片段；
 *   - 操作数的形状固定：`{formulaName, children:[{text:""}], bindField, dsType, id, type:"label",
 *     dataSource, key, textFormat}`，其中 `key` 恒等于 `<dataSource>-<bindField>`，`textFormat` 是字段类型
 *     （日期字段是 Date、数值是 Number / Amount），打印的公式校验和取数都按它换值；
 *   - **同一个字段在一条公式里出现多次，复用同一个操作数 id**——id 编号的是「这个字段」，
 *     不是「这一次出现」；
 *   - 操作数的显示名还要在多语言旁路里补一条 `<控件id>.formulaData.<操作数id>`；
 *   - 带公式的格子自己是 `dsType="Formula"`、`bindText="公式"`、`bindField`/`dataSource` 为空。
 */

export interface FormulaOperand {
	formulaName: string;
	children: { text: string }[];
	bindField: string;
	dsType: string;
	id: string;
	type: "label";
	dataSource: string;
	key: string;
	textFormat: string;
	[field: string]: unknown;
}

export type FormulaPart = string | FormulaOperand;

export const ENTER = "_enter_";

export function isOperand(part: unknown): part is FormulaOperand {
	return part !== null && typeof part === "object" && (part as { type?: unknown }).type === "label";
}

/**
 * 一条公式读成人话：文字片段原样接上，字段写成 `«批号 zlgd_ypph»`，换行记号写成 `⏎`。
 *
 * 和探针里那份（`PrintTplDiff.formulaText`）逐字一致——确认单上是它，本地预览也得是它，
 * 两边读起来不一样的话，用户看到的「改成什么」就要自己翻译一遍。
 */
export function formulaText(formula: unknown, cap = 240): string {
	if (!Array.isArray(formula)) return formula === undefined || formula === null ? "" : String(formula);
	let out = "";
	for (const part of formula) {
		if (isOperand(part)) {
			const name = part.formulaName === undefined || part.formulaName === null ? part.bindField : part.formulaName;
			out += `«${String(name)}${part.bindField ? ` ${part.bindField}` : ""}»`;
		} else if (String(part) === ENTER) {
			out += " ⏎ ";
		} else {
			out += String(part);
		}
	}
	return out.length > cap ? `${out.slice(0, cap - 3)}...` : out;
}

/** 按 `_enter_` 把公式切成上下几行，每行自己是一条完整表达式。 */
export function formulaLines(formula: readonly FormulaPart[]): FormulaPart[][] {
	const lines: FormulaPart[][] = [[]];
	for (const part of formula) {
		if (!isOperand(part) && String(part) === ENTER) lines.push([]);
		else (lines[lines.length - 1] as FormulaPart[]).push(part);
	}
	return lines;
}

/** 这条公式里用到的字段操作数，按第一次出现的顺序，同字段只算一个。 */
export function operandsOf(formula: unknown): FormulaOperand[] {
	if (!Array.isArray(formula)) return [];
	const seen = new Set<string>();
	const out: FormulaOperand[] = [];
	for (const part of formula) {
		if (!isOperand(part)) continue;
		if (seen.has(part.id)) continue;
		seen.add(part.id);
		out.push(part);
	}
	return out;
}

export interface FieldRef {
	/** 字段标识，例如 `zlgd_ypph`、`zlgd_jylx.name`。 */
	bindField: string;
	/** 显示名，例如「批号」。查不到就等于 bindField。 */
	formulaName: string;
	/** Main / Entry / Subentry / Custom … */
	dsType: string;
	/** 主单据是 formId，分录是 `<formId>.<分录key>`。 */
	dataSource: string;
	/**
	 * 打印认的字段类型：Text / Number / Amount / Date / Time …。公式校验和取数都按它换值，
	 * 日期字段写成 Text，`YEAR(<日期>)` 就过不了校验。不知道时按 Text。
	 */
	textFormat?: string;
}

export function makeOperand(field: FieldRef, id: string): FormulaOperand {
	//规则：key 恒等于 `<dataSource>-<bindField>`，平台按它认「这是哪个数据源的哪个字段」
	return {
		formulaName: field.formulaName,
		children: [{ text: "" }],
		bindField: field.bindField,
		dsType: field.dsType,
		id,
		type: "label",
		dataSource: field.dataSource,
		key: `${field.dataSource}-${field.bindField}`,
		textFormat: field.textFormat ?? "Text",
	};
}

export interface BuildInput {
	/** 每行一条表达式，字段写成 `<zlgd_ypph>`。行与行之间由这里插 `_enter_`。 */
	lines: readonly string[];
	/** 所有字段都取不到值时，第一行显示这个（其余行显示空）。不给就不加这层判断。 */
	blankText?: string;
	/** 把 `<...>` 里的字段标识解析成操作数材料；返回字符串表示解析失败的原因。 */
	resolve: (bindField: string) => FieldRef | string;
	/** 发一个新的操作数 id。同一字段只会问一次。 */
	newId: () => string;
}

export interface BuildResult {
	formula: FormulaPart[];
	/** 这条公式用到的字段，按第一次出现的顺序。 */
	fields: FormulaOperand[];
	errors: string[];
}

const PLACEHOLDER = /<([^<>]+)>/g;

/**
 * 把「每行一条表达式 + `<字段>` 占位」拼成平台认的片段数组。
 *
 * 给 `blankText` 时多包一层：所有字段拼起来是空 → 第一行显示兜底文字，其余行显示空。
 * 这正是 2026-09-20 那个需求（两值都空显示 `/`），也是最容易写错的一处——
 * 兜底文字放在每一行，打出来就是三个斜杠。
 */
export function buildFormula(input: BuildInput): BuildResult {
	const errors: string[] = [];
	const operands = new Map<string, FormulaOperand>();
	const order: FormulaOperand[] = [];
	const operandFor = (bindField: string): FormulaOperand | null => {
		const existing = operands.get(bindField);
		if (existing !== undefined) return existing;
		const field = input.resolve(bindField);
		if (typeof field === "string") {
			errors.push(field);
			return null;
		}
		//规则：同一字段在一条公式里复用同一个操作数 id
		const made = makeOperand(field, input.newId());
		operands.set(bindField, made);
		order.push(made);
		return made;
	};

	const compile = (line: string): FormulaPart[] => {
		const parts: FormulaPart[] = [];
		let at = 0;
		PLACEHOLDER.lastIndex = 0;
		for (let hit = PLACEHOLDER.exec(line); hit !== null; hit = PLACEHOLDER.exec(line)) {
			const head = line.slice(at, hit.index);
			if (head !== "") parts.push(head);
			const operand = operandFor((hit[1] as string).trim());
			if (operand !== null) parts.push({ ...operand });
			at = hit.index + hit[0].length;
		}
		const tail = line.slice(at);
		if (tail !== "") parts.push(tail);
		return parts;
	};

	//先看原文里有没有人自己写 `_enter_`：它是数组顶层的记号，写进表达式里公式就解析不了
	for (const [i, line] of input.lines.entries()) {
		if (line.includes(ENTER)) {
			errors.push(`第 ${i + 1} 行里出现了 ${ENTER}：换行就多给一行，这个记号由程序摆`);
		}
	}
	const lines = input.lines.map((line) => compile(line));
	if (input.lines.length === 0) errors.push("公式至少要一行");
	for (const [i, line] of lines.entries()) {
		if (line.length === 0) errors.push(`第 ${i + 1} 行是空的，公式的每一行都要有内容`);
	}
	if (errors.length > 0) return { formula: [], fields: order, errors };

	const guarded =
		input.blankText === undefined || order.length === 0
			? lines
			: lines.map((line, i) => wrapBlank(line, order, i === 0 ? (input.blankText as string) : ""));

	const formula: FormulaPart[] = [];
	guarded.forEach((line, i) => {
		if (i > 0) formula.push(ENTER);
		formula.push(...line);
	});
	return { formula, fields: order, errors: [] };
}

/** `IF(CONCAT(<字段…>)='','<兜底>',<原表达式>)`——所有字段都空时这一行显示兜底文字。 */
function wrapBlank(line: FormulaPart[], fields: FormulaOperand[], blankText: string): FormulaPart[] {
	const out: FormulaPart[] = ["IF(CONCAT("];
	fields.forEach((field, i) => {
		if (i > 0) out.push(",");
		out.push({ ...field });
	});
	out.push(`)='',"${blankText.replace(/"/g, '""')}",`);
	out.push(...line);
	out.push(")");
	return out;
}
