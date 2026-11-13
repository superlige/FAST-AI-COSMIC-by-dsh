export interface Literal {
	value: string;
	offset: number;
}

export interface Scanned {
	/** 与原文等长：注释换成空格、字符串内容换成空格（引号保留），换行原样保留。 */
	code: string;
	literals: Literal[];
}

/** 去注释、抠字符串。字符串或注释没闭合返回 null。 */
export function scanJava(text: string): Scanned | null {
	const out: string[] = [];
	const literals: Literal[] = [];
	const blank = (from: number, to: number): void => {
		for (let at = from; at < to; at++) out.push(text[at] === "\n" ? "\n" : " ");
	};
	let index = 0;
	while (index < text.length) {
		const char = text[index] as string;
		const next = text[index + 1];
		if (char === "/" && next === "/") {
			const end = text.indexOf("\n", index);
			const stop = end === -1 ? text.length : end;
			blank(index, stop);
			index = stop;
			continue;
		}
		if (char === "/" && next === "*") {
			const end = text.indexOf("*/", index + 2);
			if (end === -1) return null;
			blank(index, end + 2);
			index = end + 2;
			continue;
		}
		if (char === '"' && text.startsWith('"""', index)) {
			const end = text.indexOf('"""', index + 3);
			if (end === -1) return null;
			out.push('"');
			blank(index + 1, end + 2);
			out.push('"');
			index = end + 3;
			continue;
		}
		if (char === '"' || char === "'") {
			let at = index + 1;
			let value = "";
			while (at < text.length && text[at] !== char) {
				if (text[at] === "\n") return null;
				if (text[at] === "\\") {
					value += text.slice(at, at + 2);
					at += 2;
					continue;
				}
				value += text[at];
				at++;
			}
			if (at >= text.length) return null;
			if (char === '"') literals.push({ value, offset: index });
			out.push(char);
			blank(index + 1, at);
			out.push(char);
			index = at + 1;
			continue;
		}
		out.push(char);
		index++;
	}
	return { code: out.join(""), literals };
}

type FrameKind = "type" | "method" | "init" | "expr" | "other";

interface Frame {
	kind: FrameKind;
	/** 类型或方法的显示名；嵌套类型带外层前缀。 */
	label: string;
	/** 类型帧：它的完整名字，给成员加前缀用。 */
	typeName: string;
	startLine: number;
}

export interface OutlineEntry {
	from: number;
	to: number;
	label: string;
}

export interface JavaOutline {
	lines: number;
	types: OutlineEntry[];
	methods: OutlineEntry[];
	/** `value` 只在声明里恰好一个字符串时给；`literals` 是声明里字符串的个数。 */
	constants: { line: number; name: string; value: string | null; literals: number }[];
	/** 编码 → 出现的行（含经常量引用的行），按第一次出现排序。 */
	codes: { code: string; lines: number[]; via: string[] }[];
}

const TYPE_HEADER = /\b(class|interface|enum|record)\s+([A-Za-z_$][\w$]*)(.*)$/;
const METHOD_HEADER = /([A-Za-z_$][\w$]*)\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*(?:throws\s+[\w$.,\s<>]+)?$/;
const NOT_A_METHOD = new Set([
	"if",
	"for",
	"while",
	"switch",
	"catch",
	"synchronized",
	"try",
	"do",
	"else",
	"return",
	"new",
]);
/** 像苍穹编码的字符串：小写开头、只有小写字母数字下划线。单据、字段、分录、操作、模板编码都是这个样子。 */
const CODE_LITERAL = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$/;
export const isCode = (value: string): boolean => value.length >= 2 && value.length <= 64 && CODE_LITERAL.test(value);

const squash = (text: string): string => text.replace(/\s+/g, " ").trim();
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** 摘掉成员声明前面的注解（`@Override`、`@SuppressWarnings("x")`）。 */
function withoutAnnotations(header: string): string {
	return header.replace(/@[\w$.]+(?:\s*\([^()]*\))?/g, " ").trim();
}

/**
 * 代码里每个不跟在 `.` 后面的完整标识符 → 它出现的位置（从前往后）。常量在哪几行被用到，查这张表。
 *
 * 和「每个常量一个 `(?<![\w$.])名字(?![\w$])` 正则扫一遍全文」答案相同，但全文只扫一遍。
 * 那种写法一个文件要扫「常量个数」遍，带往前看的正则在 bun 里又慢：真机工程 574 个文件建常量表，
 * node 0.35 秒、bun 3.2 秒，而那是在读插件类、写文件之后同步做的，界面跟着冻住。
 */
function bareIdentifiers(code: string): Map<string, number[]> {
	const out = new Map<string, number[]>();
	for (const match of code.matchAll(/[\w$]+/g)) {
		if (code[match.index - 1] === ".") continue;
		const list = out.get(match[0]);
		if (list === undefined) out.set(match[0], [match.index]);
		else list.push(match.index);
	}
	return out;
}

/** 解析失败返回 null，调用方给全文。 */
export function outlineJava(text: string): JavaOutline | null {
	const scanned = scanJava(text);
	if (scanned === null) return null;
	const { code, literals } = scanned;

	const lineStarts = [0];
	for (let at = 0; at < text.length; at++) if (text[at] === "\n") lineStarts.push(at + 1);
	const lineOf = (offset: number): number => {
		let low = 0;
		let high = lineStarts.length - 1;
		while (low < high) {
			const mid = (low + high + 1) >> 1;
			if ((lineStarts[mid] as number) <= offset) low = mid;
			else high = mid - 1;
		}
		return low + 1;
	};

	const types: OutlineEntry[] = [];
	const methods: OutlineEntry[] = [];
	const constants: JavaOutline["constants"] = [];
	const stack: Frame[] = [];
	let headerStart = 0;
	const memberLevel = (): boolean => stack.length === 0 || stack[stack.length - 1]?.kind === "type";
	const outerType = (): string => {
		for (let at = stack.length - 1; at >= 0; at--) {
			const frame = stack[at] as Frame;
			if (frame.kind === "type") return frame.typeName;
		}
		return "";
	};
	const firstNonSpace = (from: number, to: number): number => {
		let at = from;
		while (at < to && /\s/.test(code[at] as string)) at++;
		return at;
	};

	for (let index = 0; index < code.length; index++) {
		const char = code[index];
		if (char === "{") {
			if (!memberLevel()) {
				stack.push({ kind: "other", label: "", typeName: "", startLine: 0 });
				continue;
			}
			const raw = code.slice(headerStart, index);
			const header = squash(withoutAnnotations(raw));
			const startLine = lineOf(firstNonSpace(headerStart, index));
			const typeMatch = TYPE_HEADER.exec(header);
			const outer = outerType();
			if (typeMatch !== null && !header.includes("=") && !header.includes("(")) {
				const name = typeMatch[2] as string;
				const typeName = outer === "" ? name : `${outer}.${name}`;
				const tail = squash(typeMatch[3] ?? "");
				stack.push({
					kind: "type",
					label: clip(`${typeMatch[1] as string} ${typeName}${tail === "" ? "" : ` ${tail}`}`, 160),
					typeName,
					startLine,
				});
				headerStart = index + 1;
				continue;
			}
			if (header.includes("=") || stack.length === 0) {
				// 字段初始化里的数组、匿名类、lambda：属于这条声明，声明到分号才结束。
				stack.push({ kind: "expr", label: "", typeName: "", startLine });
				continue;
			}
			const methodMatch = METHOD_HEADER.exec(header);
			if (methodMatch !== null && !NOT_A_METHOD.has(methodMatch[1] as string)) {
				const name = methodMatch[1] as string;
				const params = clip(squash(methodMatch[2] ?? ""), 100);
				const owner = stack.filter((frame) => frame.kind === "type").length > 1 ? `${outer}.` : "";
				stack.push({ kind: "method", label: `${owner}${name}(${params})`, typeName: "", startLine });
			} else if (header === "static" || header === "") {
				stack.push({
					kind: "init",
					label: header === "static" ? "静态初始化块" : "初始化块",
					typeName: "",
					startLine,
				});
			} else {
				stack.push({ kind: "other", label: "", typeName: "", startLine });
			}
			continue;
		}
		if (char === "}") {
			const frame = stack.pop();
			if (frame === undefined) return null;
			const endLine = lineOf(index);
			if (frame.kind === "type") types.push({ from: frame.startLine, to: endLine, label: frame.label });
			else if (frame.kind === "method" || frame.kind === "init")
				methods.push({ from: frame.startLine, to: endLine, label: frame.label });
			// 表达式帧属于还没结束的那条声明，声明头不重置。
			if (frame.kind !== "expr" && memberLevel()) headerStart = index + 1;
			continue;
		}
		if (char === ";" && memberLevel()) {
			const header = squash(withoutAnnotations(code.slice(headerStart, index)));
			if (/\bstatic\b/.test(header) && /\bfinal\b/.test(header)) {
				const name = /([A-Za-z_$][\w$]*)\s*=/.exec(header)?.[1];
				if (name !== undefined) {
					const own = literals.filter((item) => item.offset >= headerStart && item.offset < index);
					constants.push({
						line: lineOf(firstNonSpace(headerStart, index)),
						name,
						value: own.length === 1 ? (own[0] as Literal).value : null,
						literals: own.length,
					});
				}
			}
			headerStart = index + 1;
		}
	}
	if (stack.length > 0 || types.length === 0) return null;

	// 编码 → 行号：字符串字面量直接出现的行，加上经常量引用的行。
	const codes = new Map<string, { lines: Set<number>; via: Set<string>; first: number }>();
	const noteCode = (value: string, line: number, offset: number, via?: string): void => {
		const row = codes.get(value) ?? { lines: new Set<number>(), via: new Set<string>(), first: offset };
		row.lines.add(line);
		if (via !== undefined) row.via.add(via);
		row.first = Math.min(row.first, offset);
		codes.set(value, row);
	};
	for (const literal of literals) {
		if (isCode(literal.value)) noteCode(literal.value, lineOf(literal.offset), literal.offset);
	}
	const uses = constants.some((constant) => constant.value !== null && isCode(constant.value))
		? bareIdentifiers(code)
		: new Map<string, number[]>();
	for (const constant of constants) {
		if (constant.value === null || !isCode(constant.value)) continue;
		// 声明行本身也带上常量名：常量类里的编码往往只在别的文件里用。
		noteCode(constant.value, constant.line, Number.POSITIVE_INFINITY, constant.name);
		for (const offset of uses.get(constant.name) ?? []) {
			const line = lineOf(offset);
			if (line !== constant.line) noteCode(constant.value, line, offset, constant.name);
		}
	}

	types.sort((left, right) => left.from - right.from);
	methods.sort((left, right) => left.from - right.from);
	return {
		lines: lineStarts.length,
		types,
		methods,
		constants,
		codes: [...codes.entries()]
			.sort((left, right) => left[1].first - right[1].first)
			.map(([value, row]) => ({
				code: value,
				lines: [...row.lines].sort((left, right) => left - right),
				via: [...row.via],
			})),
	};
}
