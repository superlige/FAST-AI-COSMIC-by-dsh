/**
 * 插件写法检查（S51）：循环里查库查缓存、已有常量还写字符串、重复声明常量、类和方法太长。
 *
 * 一段话看懂：模型写插件时把「每张单查一次上游」写进循环、已经在用常量类还直接写单据标识，
 * 这些编得过、跑得通、验证全过，交付时没有任何一步会说话（真机 38 份改代码的会话里循环查库新加 20 处，
 * 见 `docs/S51-plugin-coding-standards.md` §2）。这里按源码查出来，只算这次新加的——老代码里本来就有的不报。
 *
 * 源码级（去掉注释和字符串内容后配括号），不编译、不连环境，一个文件几毫秒：
 *   - 循环：for / while / do 的循环体，和 `.forEach(` 的参数；
 *   - 查库：`XxxServiceHelper.方法(`（查缓存的那几个和不碰库的除外）、`DB.`、`ORM.create`、`DispatchServiceHelper.invoke…`；
 *   - 查缓存：`loadFromCache`、`loadSingleFromCache`、`EntityMetadataCache.`、`MetadataServiceHelper.`、`CacheFactory.`；
 *   - 间接：循环里调了本文件的方法、那个方法（一路往下）查库；或调了别的类的静态方法、代码关系表说它查库；
 *   - 常量类：类名以 Con / Const / Constant(s) / Consts 结尾，或者没有方法、至少 3 个字符串常量。
 *
 * 豁免：确实合不了批的（例如按下游单据类型分组、每类调一次操作），在那一行或上一行写
 * `// cosmic-allow: 理由`。豁免的照样记下，交付时列给人看；只是不拦。
 */

import { contentMemo } from "../content-memo.ts";
import { isCode, type JavaOutline, outlineJava, scanJava } from "../impact/java-outline.ts";

/** 类超过这么多行，交付时列出来给人看（工程现有插件类九成在 358 行以内）。 */
export const CLASS_LINE_LIMIT = 500;
/** 方法超过这么多行，同上（工程现有插件类里每类最长方法九成在 120 行以内，这条线管新写的）。 */
export const METHOD_LINE_LIMIT = 80;

export type StyleKind =
	| "db-loop"
	| "db-loop-indirect"
	| "cache-loop"
	| "view-loop"
	| "literal-dup"
	| "literal-dup-used"
	| "own-const-dup";

/** 编译前拦的三类：一定是错、改法明确。其余只报不拦。 */
export const HARD_KINDS: ReadonlySet<StyleKind> = new Set(["db-loop", "literal-dup-used", "own-const-dup"]);

export interface StyleHit {
	kind: StyleKind;
	/** 比较前后用：同一处问题的稳定说法（不带行号）。 */
	key: string;
	line: number;
	/** 一句话：在哪个方法、什么问题、怎么改。 */
	text: string;
	/** 写了豁免注释时是那条理由。 */
	exempt: string | null;
}

export interface ConstHome {
	cls: string;
	name: string;
	file: string;
}

export interface ConstClass {
	cls: string;
	file: string;
	/** 这个常量类管的单据：名为 ENTITY 那类常量的值；认不出为 null。 */
	entity: string | null;
	/** 里面有几个编码常量（单据、字段、分录、操作标识）。 */
	codes: number;
}

export interface ConstIndex {
	/** 本工程编码的前缀（`zlgd`）：编码字符串只看这个前缀开头的。 */
	isv: string;
	byValue: Map<string, ConstHome[]>;
	classes: Map<string, ConstClass>;
}

export interface StyleEnv {
	consts: ConstIndex;
	/** 正在查的这个类的简单名。 */
	selfClass: string;
	/** 别的类的静态方法 `Cls.method` 查不查库（代码关系表答）；不知道就不给。 */
	externalTouchesDb?: (cls: string, method: string) => boolean;
	/** 认得出的单据标识（代码关系表里读写过的单据）；用来看一句代码写的是哪张单。不给就只认常量类管的单据。 */
	entities?: ReadonlySet<string>;
}

export interface StyleReport {
	lines: number;
	methods: { label: string; lines: number }[];
	hits: StyleHit[];
	isConstClass: boolean;
}

const CACHE_CALL =
	/\b(?:BusinessDataServiceHelper\.(?:loadFromCache|loadSingleFromCache)|EntityMetadataCache\.\w+|MetadataServiceHelper\.\w+|CacheFactory\.\w+)\s*\(/g;
const DB_CALL =
	/\b(?:(\w+ServiceHelper)\.(\w+)|DB\.\w+|ORM\.create|DispatchServiceHelper\.invoke\w*|QueryServiceHelper\.\w+)\s*\(/g;
const VIEW_CALL = /\.updateView\s*\(/g;
const STATIC_CALL = /(?<![\w$.])([A-Z][\w$]*)\.([a-z][\w$]*)\s*\(/g;
/** 名字像 ServiceHelper、其实不碰库的：在内存里建对象、取当前请求上下文。 */
const NOT_DB = new Set([
	"BusinessDataServiceHelper.newDynamicObject",
	"UserServiceHelper.getCurrentUserId",
	"AttachmentServiceHelper.genBindingParam",
]);
const ALLOW = /\/\/\s*cosmic-allow\s*[:：]\s*(\S.*?)\s*$/;
/** 常量类里表示「这个常量类管哪张单」的常量名。 */
const ENTITY_CONST = /^(ENTITY|ENTITY_?(ID|KEY|NUMBER)|BILL_?(ENTITY|ID|KEY)|FORM_?(ID|KEY))$/;

export function isConstantClass(name: string, outline: JavaOutline): boolean {
	const strings = outline.constants.filter((c) => c.value !== null).length;
	if (/(Con|Const|Consts|Constant|Constants)$/.test(name) && strings > 0) return true;
	return outline.methods.length === 0 && strings >= 3;
}

export const classNameOf = (file: string): string =>
	(file.replace(/\\/g, "/").split("/").pop() ?? "").replace(/\.java$/, "");

/** 常量索引隔一分钟重建一次，内容没变的文件不再重拆。 */
const outlineOf = contentMemo((_file: string, text: string) => outlineJava(text));

/** 从工程全部源码建常量索引。`isv` 不给就取常量值里最常见的前缀。 */
export function buildConstIndex(sources: Iterable<{ file: string; text: string }>, isv?: string): ConstIndex {
	const byValue = new Map<string, ConstHome[]>();
	const classes = new Map<string, ConstClass>();
	const prefixCount = new Map<string, number>();
	for (const { file, text } of sources) {
		const outline = outlineOf(file, text);
		if (outline === null) continue;
		for (const c of outline.constants) {
			const prefix = c.value !== null && isCode(c.value) ? /^([a-z0-9]+)_/.exec(c.value)?.[1] : undefined;
			if (prefix !== undefined) prefixCount.set(prefix, (prefixCount.get(prefix) ?? 0) + 1);
		}
		const cls = classNameOf(file);
		if (!isConstantClass(cls, outline)) continue;
		let entity: string | null = null;
		let codes = 0;
		for (const c of outline.constants) {
			if (c.value === null || !isCode(c.value)) continue;
			codes++;
			if (entity === null && ENTITY_CONST.test(c.name)) entity = c.value;
			const list = byValue.get(c.value) ?? [];
			list.push({ cls, name: c.name, file: file.replace(/\\/g, "/") });
			byValue.set(c.value, list);
		}
		classes.set(cls, { cls, file: file.replace(/\\/g, "/"), entity, codes });
	}
	return {
		isv: isv ?? [...prefixCount].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "",
		byValue,
		classes,
	};
}

function matchClose(code: string, open: number): number {
	const pair: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
	const want = pair[code[open] as string];
	let depth = 0;
	for (let at = open; at < code.length; at++) {
		const ch = code[at];
		if (ch === code[open]) depth++;
		else if (ch === want) {
			depth--;
			if (depth === 0) return at;
		}
	}
	return -1;
}

/** 循环体的区间（在去注释、去字符串内容的代码上）。 */
function loopBodies(code: string): [number, number][] {
	const out: [number, number][] = [];
	for (const match of code.matchAll(/\b(for|while)\s*\(/g)) {
		const paren = (match.index as number) + match[0].length - 1;
		const close = matchClose(code, paren);
		if (close < 0) continue;
		let at = close + 1;
		while (at < code.length && /\s/.test(code[at] as string)) at++;
		if (match[1] === "while") {
			// do { … } while (…); 的尾巴：前面是 }，后面是 ;
			let back = (match.index as number) - 1;
			while (back >= 0 && /\s/.test(code[back] as string)) back--;
			if (code[back] === "}" && code[at] === ";") continue;
		}
		if (code[at] === "{") {
			const end = matchClose(code, at);
			if (end > 0) out.push([at, end]);
		} else {
			const end = code.indexOf(";", at);
			if (end > 0) out.push([at, end]);
		}
	}
	for (const match of code.matchAll(/\bdo\s*\{/g)) {
		const open = (match.index as number) + match[0].length - 1;
		const end = matchClose(code, open);
		if (end > 0) out.push([open, end]);
	}
	for (const match of code.matchAll(/\.forEach\s*\(/g)) {
		const open = (match.index as number) + match[0].length - 1;
		const end = matchClose(code, open);
		if (end > 0) out.push([open, end]);
	}
	return out;
}

function lineAt(text: string): (offset: number) => number {
	const starts = [0];
	for (let at = 0; at < text.length; at++) if (text[at] === "\n") starts.push(at + 1);
	return (offset) => {
		let low = 0;
		let high = starts.length - 1;
		while (low < high) {
			const mid = (low + high + 1) >> 1;
			if ((starts[mid] as number) <= offset) low = mid;
			else high = mid - 1;
		}
		return low + 1;
	};
}

const methodName = (label: string): string => (/([\w$]+)\(/.exec(label)?.[1] ?? label).replace(/^.*\./, "");
const escapeName = (name: string): string => name.replace(/\$/g, "\\$");

function dbCallsIn(code: string): string[] {
	const out: string[] = [];
	for (const match of code.matchAll(DB_CALL)) {
		const helper = match[1];
		const call = match[0].replace(/\s*\($/, "");
		if (helper === "BusinessDataServiceHelper" && /FromCache$/.test(match[2] ?? "")) continue;
		if (helper === "MetadataServiceHelper" || NOT_DB.has(call)) continue;
		out.push(call);
	}
	return out;
}

/**
 * 语句的分界（在去注释、去字符串内容的代码上）：代码块的大括号，和不在小括号、数组初始化里的分号。
 * `new QFilter[]{…}`、`= {…}` 这种初始化的大括号算语句里面。
 */
function statementBreaks(code: string): number[] {
	const out: number[] = [];
	const stack: string[] = [];
	for (let at = 0; at < code.length; at++) {
		const ch = code[at];
		if (ch === "(" || ch === "[") stack.push(ch);
		else if (ch === ")" || ch === "]") stack.pop();
		else if (ch === "{") {
			let back = at - 1;
			while (back >= 0 && /\s/.test(code[back] as string)) back--;
			const init = code[back] === "]" || code[back] === "=";
			stack.push(init ? "[" : "{");
			if (!init) out.push(at);
		} else if (ch === "}") {
			if (stack.pop() === "{") out.push(at);
		} else if (ch === ";" && (stack.length === 0 || stack[stack.length - 1] === "{")) out.push(at);
	}
	return out;
}

/** `offset` 所在那句的区间 `[from, to)`。 */
function statementAt(breaks: readonly number[], offset: number, length: number): [number, number] {
	let low = 0;
	let high = breaks.length;
	while (low < high) {
		const mid = (low + high) >> 1;
		if ((breaks[mid] as number) < offset) low = mid + 1;
		else high = mid;
	}
	return [low === 0 ? 0 : (breaks[low - 1] as number) + 1, breaks[low] ?? length];
}

interface EntityOwners {
	entities: ReadonlySet<string>;
	/** 常量类 `cls` 里有没有这张单的标识（`ENTITY` 那类常量，或别的常量的值恰好是这张单）。 */
	covers: (cls: string, entity: string) => boolean;
	/** `[from, to)` 这段代码写到的单据：单据标识字符串、值是单据标识的 `常量类.常量`、本类自己的常量。 */
	namedIn: (from: number, to: number) => Set<string>;
}

function entityOwners(
	env: StyleEnv,
	outline: JavaOutline,
	code: string,
	literals: readonly { value: string; offset: number }[],
): EntityOwners {
	const entities = new Set(env.entities ?? []);
	for (const cls of env.consts.classes.values()) if (cls.entity !== null) entities.add(cls.entity);
	const refs = new Map<string, string>();
	const covered = new Map<string, Set<string>>();
	for (const entity of entities) {
		for (const home of env.consts.byValue.get(entity) ?? []) {
			refs.set(`${home.cls}.${home.name}`, entity);
			covered.set(home.cls, (covered.get(home.cls) ?? new Set<string>()).add(entity));
		}
	}
	for (const c of outline.constants) if (c.value !== null && entities.has(c.value)) refs.set(c.name, c.value);
	return {
		entities,
		covers: (cls, entity) => covered.get(cls)?.has(entity) ?? false,
		namedIn: (from, to) => {
			const named = new Set<string>();
			for (const literal of literals)
				if (literal.offset >= from && literal.offset < to && entities.has(literal.value)) named.add(literal.value);
			for (const match of code.slice(from, to).matchAll(/(?<![\w$.])[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?/g)) {
				const entity = refs.get(match[0]);
				if (entity !== undefined) named.add(entity);
			}
			return named;
		},
	};
}

/** 字符串常量两种写法（本文件在不在用那个常量类）同算一处问题：只是加了 import，老代码不该变成新问题。 */
const hitFamily = (kind: StyleKind): string => (kind === "literal-dup-used" ? "literal-dup" : kind);

const BATCH_FIX = "先把要查的编号收齐，循环外一次查出来放进 Map，循环里只取用";

/** 查一份源码。解析不了（括号或注释没闭合）返回 null。 */
export function analyseStyle(text: string, env: StyleEnv): StyleReport | null {
	const normalized = text.replace(/\r\n/g, "\n");
	const outline = outlineJava(normalized);
	const scanned = scanJava(normalized);
	if (outline === null || scanned === null) return null;
	const { code, literals } = scanned;
	const lineOf = lineAt(normalized);
	const rawLines = normalized.split("\n");
	const lineStart: number[] = [];
	{
		let offset = 0;
		for (const line of rawLines) {
			lineStart.push(offset);
			offset += line.length + 1;
		}
	}
	const startOf = (line: number): number => lineStart[line - 1] ?? normalized.length;
	const exemptAt = (line: number): string | null =>
		ALLOW.exec(rawLines[line - 1] ?? "")?.[1] ?? ALLOW.exec(rawLines[line - 2] ?? "")?.[1] ?? null;
	const methods = outline.methods.map((m) => ({ label: m.label, from: m.from, to: m.to, lines: m.to - m.from + 1 }));
	const methodAt = (line: number): string => {
		let best: (typeof methods)[number] | undefined;
		for (const m of methods) if (m.from <= line && line <= m.to && (!best || m.from >= best.from)) best = m;
		return best ? methodName(best.label) : "(类体)";
	};

	// 本文件里哪些方法（一路往下）查库
	const bodyOf = new Map<string, string>();
	for (const m of methods) {
		const name = methodName(m.label);
		bodyOf.set(name, (bodyOf.get(name) ?? "") + code.slice(startOf(m.from), startOf(m.to + 1)));
	}
	const touches = new Set<string>();
	for (const [name, body] of bodyOf) if (dbCallsIn(body).length > 0) touches.add(name);
	for (let changed = true; changed; ) {
		changed = false;
		for (const [name, body] of bodyOf) {
			if (touches.has(name)) continue;
			for (const other of touches) {
				if (new RegExp(`(?<![\\w$.])${escapeName(other)}\\s*\\(`).test(body)) {
					touches.add(name);
					changed = true;
					break;
				}
			}
		}
	}

	const hits: StyleHit[] = [];
	const seen = new Set<string>();
	const push = (kind: StyleKind, key: string, line: number, message: string): void => {
		const id = `${kind}|${line}|${key}`;
		if (seen.has(id)) return;
		seen.add(id);
		hits.push({ kind, key: `${hitFamily(kind)}|${key}`, line, text: message, exempt: exemptAt(line) });
	};
	for (const [start, end] of loopBodies(code)) {
		const body = code.slice(start, end);
		const at = (offset: number): number => lineOf(start + offset);
		for (const match of body.matchAll(DB_CALL)) {
			const call = dbCallsIn(match[0])[0];
			if (call === undefined) continue;
			const line = at(match.index as number);
			const where = methodAt(line);
			push("db-loop", `${where}|${call}`, line, `${where}：循环里调 ${call}，每一轮查一次库——${BATCH_FIX}`);
		}
		for (const match of body.matchAll(CACHE_CALL)) {
			const line = at(match.index as number);
			const where = methodAt(line);
			const call = match[0].replace(/\s*\($/, "");
			push(
				"cache-loop",
				`${where}|${call}`,
				line,
				`${where}：循环里调 ${call}——挪到循环外取一次，循环里用取到的结果`,
			);
		}
		for (const match of body.matchAll(VIEW_CALL)) {
			const line = at(match.index as number);
			const where = methodAt(line);
			push("view-loop", where, line, `${where}：循环里刷新界面——循环结束后统一刷新一次`);
		}
		for (const name of touches) {
			const call = new RegExp(`(?<![\\w$.])${escapeName(name)}\\s*\\(`, "g");
			for (const match of body.matchAll(call)) {
				const line = at(match.index as number);
				const where = methodAt(line);
				if (where === name) continue;
				push(
					"db-loop-indirect",
					`${where}|${name}`,
					line,
					`${where}：循环里调 ${name}()，它查库——把查库挪到循环外一次查完，${name}() 改成收查好的数据`,
				);
			}
		}
		if (env.externalTouchesDb !== undefined) {
			for (const match of body.matchAll(STATIC_CALL)) {
				const cls = match[1] as string;
				const method = match[2] as string;
				if (/ServiceHelper$/.test(cls) || cls === "DB" || cls === "ORM") continue;
				if (!env.externalTouchesDb(cls, method)) continue;
				const line = at(match.index as number);
				const where = methodAt(line);
				push(
					"db-loop-indirect",
					`${where}|${cls}.${method}`,
					line,
					`${where}：循环里调 ${cls}.${method}()，代码关系表说它查库——循环外一次查完，或给它加一个按一批编号查的写法`,
				);
			}
		}
	}

	const isConstClass = isConstantClass(env.selfClass, outline);
	const constLines = new Set(outline.constants.map((c) => c.line));
	const prefix = `${env.consts.isv}_`;
	if (!isConstClass && env.consts.isv !== "") {
		const owner = entityOwners(env, outline, code, literals);
		const breaks = statementBreaks(code);
		for (const literal of literals) {
			if (!isCode(literal.value) || !literal.value.startsWith(prefix)) continue;
			const line = lineOf(literal.offset);
			if (constLines.has(line)) continue;
			let homes = (env.consts.byValue.get(literal.value) ?? []).filter((home) => home.cls !== env.selfClass);
			if (homes.length === 0) continue;
			// 字段标识各单可以重名：这一句写到了哪张单，就只认管那张单的常量类；都不管它，就说不准是谁的字段，只报不拦。
			let elsewhere: string[] = [];
			if (!owner.entities.has(literal.value)) {
				const [from, to] = statementAt(breaks, literal.offset, code.length);
				const named = owner.namedIn(from, to);
				if (named.size > 0) {
					const owned = homes.filter((home) => [...named].some((entity) => owner.covers(home.cls, entity)));
					if (owned.length > 0) homes = owned;
					else elsewhere = [...named];
				}
			}
			const used =
				elsewhere.length > 0
					? undefined
					: homes.find((home) => new RegExp(`(?<![\\w$])${escapeName(home.cls)}\\.`).test(code));
			if (used !== undefined) {
				push(
					"literal-dup-used",
					literal.value,
					line,
					`"${literal.value}" 直接写了——本文件已在用 ${used.cls}，改用 ${used.cls}.${used.name}`,
				);
			} else {
				const names = homes.slice(0, 3).map((h) => `${h.cls}.${h.name}`);
				const where =
					elsewhere.length > 0
						? `；这一句写的是 ${elsewhere.join("、")}，先确认它是哪张单的字段，用那张单常量类里的`
						: "，用这张单那个常量类里的";
				push(
					"literal-dup",
					literal.value,
					line,
					`"${literal.value}" 直接写了——常量类里有 ${names.join("、")}${homes.length > 3 ? ` 等 ${homes.length} 处` : ""}${where}`,
				);
			}
		}
		for (const constant of outline.constants) {
			if (constant.value === null || !constant.value.startsWith(prefix)) continue;
			const home = (env.consts.byValue.get(constant.value) ?? []).find((h) => h.cls !== env.selfClass);
			if (home === undefined) continue;
			push(
				"own-const-dup",
				constant.value,
				constant.line,
				`自己声明了 ${constant.name} = "${constant.value}"——常量类里已有 ${home.cls}.${home.name}，删掉这份、改用它`,
			);
		}
	}
	hits.sort((a, b) => a.line - b.line);
	return {
		lines: outline.lines,
		methods: methods.map((m) => ({ label: m.label, lines: m.lines })),
		hits,
		isConstClass,
	};
}

export interface StyleDelta {
	created: boolean;
	linesBefore: number;
	linesAfter: number;
	/** 改之后比改之前多出来的问题。 */
	added: StyleHit[];
	/** 这次新出现、或从线下长过线的方法。 */
	newLongMethods: { label: string; lines: number }[];
}

/** 改之前（`null` 是新文件）和改之后比，只留这次新加的。改之后解析不了返回 null。 */
export function styleDelta(before: string | null, after: string, env: StyleEnv): StyleDelta | null {
	const next = analyseStyle(after, env);
	if (next === null) return null;
	const prior = before === null ? null : analyseStyle(before, env);
	// 先按「同一处问题、那一行原样没动」配对，剩下的再按个数配：新加的那一处报在新写的行上，不报到老行上。
	const beforeLines = (before ?? "").replace(/\r\n/g, "\n").split("\n");
	const afterLines = after.replace(/\r\n/g, "\n").split("\n");
	const left = new Map<string, number>();
	const leftAt = new Map<string, number>();
	for (const hit of prior?.hits ?? []) {
		left.set(hit.key, (left.get(hit.key) ?? 0) + 1);
		const at = `${hit.key}\n${beforeLines[hit.line - 1]?.trim() ?? ""}`;
		leftAt.set(at, (leftAt.get(at) ?? 0) + 1);
	}
	const unmatched: StyleHit[] = [];
	for (const hit of next.hits) {
		const at = `${hit.key}\n${afterLines[hit.line - 1]?.trim() ?? ""}`;
		const count = leftAt.get(at) ?? 0;
		if (count > 0) {
			leftAt.set(at, count - 1);
			left.set(hit.key, (left.get(hit.key) ?? 0) - 1);
		} else unmatched.push(hit);
	}
	const added: StyleHit[] = [];
	for (const hit of unmatched) {
		const count = left.get(hit.key) ?? 0;
		if (count > 0) left.set(hit.key, count - 1);
		else added.push(hit);
	}
	const priorLong = new Map((prior?.methods ?? []).map((m) => [m.label, m.lines]));
	const newLongMethods = next.methods.filter((m) => {
		if (m.lines <= METHOD_LINE_LIMIT) return false;
		const old = priorLong.get(m.label);
		return old === undefined || old <= METHOD_LINE_LIMIT;
	});
	return {
		created: before === null,
		linesBefore: before === null ? 0 : (prior?.lines ?? before.split("\n").length),
		linesAfter: next.lines,
		added,
		newLongMethods,
	};
}

/** 要拦的：编译前三类、没写豁免的。 */
export const blockingHits = (delta: StyleDelta): StyleHit[] =>
	delta.added.filter((hit) => HARD_KINDS.has(hit.kind) && hit.exempt === null);

/** 类长度那一句：新建就超线、这次长过线、往超线的类里继续加。没有就 null。 */
export function classLengthNote(delta: StyleDelta): string | null {
	const { linesBefore: before, linesAfter: after } = delta;
	if (after <= CLASS_LINE_LIMIT) return null;
	if (delta.created) return `新建就 ${String(after)} 行（超过 ${String(CLASS_LINE_LIMIT)} 行）`;
	if (before <= CLASS_LINE_LIMIT)
		return `${String(before)} → ${String(after)} 行，长过 ${String(CLASS_LINE_LIMIT)} 行`;
	if (after > before) return `本来就 ${String(before)} 行，又加到 ${String(after)} 行——新逻辑放进同包的服务类`;
	return null;
}
