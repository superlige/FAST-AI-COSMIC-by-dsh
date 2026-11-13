/**
 * `run call` 的前检：被调的方法在不在本工程源码里，它能走到的代码里有没有发消息、调接口（S24 批 B）。
 *
 * 一段话看懂：`run call` 直接调本工程一个类的方法。别的运行方式按「插件登记在哪张单上」判副作用，
 * 直调方法没有登记可查，只能读源码：从那个方法的方法体出发，顺着它调的本类方法、引用到的本工程类
 * 往下找，碰到发消息、调接口、附件（`EXTERNAL_EFFECT_TOKENS`）就记下来。
 * S27 起调用真提交、测试环境放开了外部接口（用户 2026-09-19），这些只在 warnings 里提醒「会真的发出去」，
 * 不再拦；以前还要找的「另开事务、另起线程」（写入逃出回滚）也不再单列——本来就提交了。
 *
 * **只在目标类里按方法细分，别的类按整个文件判。** 目标类里常常一半是界面事件、一半是纯计算，
 * 按整个文件判会把纯计算也提一遍；而被引用的工具类要细分到方法，得先解析 Java 的重载和继承，
 * 代价和误差都不值。提醒里会写出是从哪条引用链走到的，人能看出来是不是说宽了。
 */

import type { KernelContext } from "../context.ts";
import { EXTERNAL_EFFECT_TOKENS } from "./external-effects.ts";
import { blankJavaNoise } from "./probe-scan.ts";

/** 顺着引用最多走多少个类。真机工程 1000 多个类，走满了说明引用链散到全工程，按查不完处理。 */
const REACH_LIMIT = 200;

export interface CallTarget {
	/** 写的是什么：全类名，或者不带包的简单类名。 */
	cls: string;
	method: string;
	/** `#m(A,B)` 里括号中的参数类型，按写的原样；没写括号是 null。 */
	signature: string[] | null;
}

/** `zlgd.x.Foo#bar`、`Foo#bar`、`zlgd.x.Foo#bar(List,List)`。形状不对返回 null。 */
export function parseCallTarget(text: string): CallTarget | null {
	const match = /^\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)#([A-Za-z_$][\w$]*)\s*(?:\(([^()]*)\))?\s*$/.exec(text);
	if (match === null) return null;
	const inner = match[3];
	return {
		cls: match[1] as string,
		method: match[2] as string,
		signature:
			inner === undefined
				? null
				: inner
						.split(",")
						.map((part) => part.trim())
						.filter((part) => part !== ""),
	};
}

interface SourceClass {
	fqn: string;
	simple: string;
	pkg: string;
	file: string;
}

function projectClasses(ctx: KernelContext): SourceClass[] {
	const out: SourceClass[] = [];
	for (const module of ctx.layout.moduleDirs) {
		const root = module.src.replace(/\\/g, "/").replace(/\/+$/, "");
		for (const file of ctx.ports.fs.listJavaFiles(module.src)) {
			const rel = file.replace(/\\/g, "/");
			if (!rel.startsWith(`${root}/`)) continue;
			const fqn = rel
				.slice(root.length + 1)
				.replace(/\.java$/, "")
				.replace(/\//g, ".");
			const dot = fqn.lastIndexOf(".");
			out.push({ fqn, simple: fqn.slice(dot + 1), pkg: dot < 0 ? "" : fqn.slice(0, dot), file });
		}
	}
	return out;
}

export type ClassLookup =
	| { state: "found"; cls: SourceClass }
	| { state: "missing"; near: string[] }
	| { state: "ambiguous"; candidates: string[] };

/**
 * 找被调的类。内部类（`Outer$Inner` / `Outer.Inner`）落到外层类的文件上。
 *
 * 不在本工程源码里的一律找不到：`run call` 只调本工程的类，平台类、第三方类不在这条路上。
 */
export function locateCallClass(ctx: KernelContext, written: string): ClassLookup {
	const classes = projectClasses(ctx);
	const outer = written.split("$")[0] as string;
	const exact = classes.find((cls) => cls.fqn === outer);
	if (exact !== undefined) return { state: "found", cls: exact };
	// `a.b.Outer.Inner`：从右往左剥，剥到一个文件为止。
	const parts = outer.split(".");
	for (let cut = parts.length - 1; cut > 1; cut--) {
		const hit = classes.find((cls) => cls.fqn === parts.slice(0, cut).join("."));
		if (hit !== undefined && /^[A-Z]/.test(parts[cut] ?? "")) return { state: "found", cls: hit };
	}
	if (!outer.includes(".")) {
		const bySimple = classes.filter((cls) => cls.simple === outer);
		if (bySimple.length === 1) return { state: "found", cls: bySimple[0] as SourceClass };
		if (bySimple.length > 1) return { state: "ambiguous", candidates: bySimple.map((cls) => cls.fqn).sort() };
	}
	const simple = outer.slice(outer.lastIndexOf(".") + 1).toLowerCase();
	const near = classes
		.filter((cls) => cls.simple.toLowerCase() === simple || distance(cls.simple.toLowerCase(), simple) <= 2)
		.map((cls) => cls.fqn)
		.sort()
		.slice(0, 6);
	return { state: "missing", near };
}

interface Declaration {
	name: string;
	/** 方法体在去掉注释、字符串之后的源码里的位置，含两头花括号。 */
	start: number;
	end: number;
}

const JAVA_KEYWORDS = new Set([
	"if",
	"for",
	"while",
	"switch",
	"catch",
	"synchronized",
	"return",
	"new",
	"throw",
	"try",
	"else",
	"do",
	"super",
	"this",
	"assert",
]);

/** 一对花括号的另一头；源码没配平时返回 -1。 */
function closingBrace(code: string, open: number): number {
	let depth = 0;
	for (let i = open; i < code.length; i++) {
		if (code[i] === "{") depth++;
		else if (code[i] === "}") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/**
 * 源码里声明的方法和构造器：`名字(参数) [throws …] {`。
 *
 * 调用处后面跟的是 `;` `)` `.`，不是 `{`；`new Foo(…) {` 是匿名类，前面有 new，也排除。
 */
function declarations(code: string): Declaration[] {
	const out: Declaration[] = [];
	const pattern = /([A-Za-z_$][\w$]*)\s*\(/g;
	for (let match = pattern.exec(code); match !== null; match = pattern.exec(code)) {
		const name = match[1] as string;
		if (JAVA_KEYWORDS.has(name)) continue;
		const before = code.slice(Math.max(0, match.index - 8), match.index);
		if (/(\bnew\s+|\.\s*)$/.test(before)) continue;
		// 配平参数表的括号
		let depth = 0;
		let close = -1;
		for (let i = match.index + match[0].length - 1; i < code.length; i++) {
			if (code[i] === "(") depth++;
			else if (code[i] === ")") {
				depth--;
				if (depth === 0) {
					close = i;
					break;
				}
			}
		}
		if (close < 0) continue;
		const tail = /^\s*(?:throws\s+[\w$.\s,<>]+?)?\s*\{/.exec(code.slice(close + 1, close + 400));
		if (tail === null) continue;
		const open = close + tail[0].length;
		const end = closingBrace(code, open);
		if (end < 0) continue;
		out.push({ name, start: open, end });
	}
	return out;
}

/** 这个文件能直接用简单名引用到的本工程类：import 进来的，和同一个包里的。 */
function visibleClasses(code: string, self: SourceClass, byFqn: Map<string, SourceClass>, all: SourceClass[]) {
	const visible = new Map<string, SourceClass>();
	for (const cls of all) if (cls.pkg === self.pkg && cls.fqn !== self.fqn) visible.set(cls.simple, cls);
	for (const match of code.matchAll(/^\s*import\s+(?:static\s+)?([\w$.]+?)(\.\*)?\s*;/gm)) {
		const name = match[1] as string;
		if (match[2] !== undefined) {
			for (const cls of all) if (cls.pkg === name) visible.set(cls.simple, cls);
			// `import static a.b.Foo.*`
			const owner = byFqn.get(name);
			if (owner !== undefined) visible.set(owner.simple, owner);
			continue;
		}
		const direct = byFqn.get(name) ?? byFqn.get(name.slice(0, name.lastIndexOf(".")));
		if (direct !== undefined) visible.set(direct.simple, direct);
	}
	return visible;
}

/**
 * 这段代码用到了哪些本工程类、各用到了哪些方法。
 *
 * 一个类在这段代码里**只**以 `类.方法(…)` 和 `类.常量` 的形式出现时，只记那几个方法：
 * 真机工程里 8 个调度任务都引用 `DateUtils`，大多只用它的 `isSameDate`，而同一个文件里另有一个方法去网上取节假日
 * （HttpURLConnection）。按整个文件判就把这 8 个任务全拦了。别的用法（new 出来、声明成变量类型、当参数传）
 * 说不清会调到哪些实例方法，整个文件算。
 */
function referencedClasses(
	segment: string,
	visible: Map<string, SourceClass>,
	byFqn: Map<string, SourceClass>,
): { cls: SourceClass; methods: Set<string> | null }[] {
	const code = segment.replace(/^\s*(?:import|package)\s[^;]*;/gm, "");
	const out = new Map<string, { cls: SourceClass; methods: Set<string> | null }>();
	const use = (cls: SourceClass, methods: Set<string> | null): void => {
		const known = out.get(cls.fqn);
		if (known === undefined) out.set(cls.fqn, { cls, methods });
		else if (known.methods !== null) {
			if (methods === null) known.methods = null;
			else for (const name of methods) known.methods.add(name);
		}
	};
	for (const [simple, cls] of visible) {
		const name = simple.replace(/\$/g, "\\$");
		const all = code.match(new RegExp(`(?<![\\w$.])${name}\\b`, "g"))?.length ?? 0;
		if (all === 0) continue;
		const calls = [...code.matchAll(new RegExp(`(?<![\\w$.])${name}\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\s*\\(`, "g"))].map(
			(match) => match[1] as string,
		);
		const constants =
			code.match(new RegExp(`(?<![\\w$.])${name}\\s*\\.\\s*[A-Z][A-Z0-9_]*\\b(?!\\s*\\()`, "g"))?.length ?? 0;
		if (calls.length + constants === all) {
			if (calls.length > 0) use(cls, new Set(calls));
		} else use(cls, null);
	}
	for (const match of code.matchAll(/\b([a-z][\w$]*(?:\.[\w$]+)+)\b/g)) {
		const cls = byFqn.get(match[1] as string);
		if (cls !== undefined) use(cls, null);
	}
	return [...out.values()];
}

export interface ReachHit {
	cls: string;
	file: string;
	hits: string[];
	/** 从被调方法走到这里的引用链，头一个是被调的类。 */
	via: string[];
}

export interface CallReach {
	cls: SourceClass;
	/** 目标类里声明的方法名（去重），给拼错时挑候选。 */
	declared: string[];
	/** 被调的方法在源码里找到了没有。没找到（继承来的、源码写法认不出）就按整个类判。 */
	methodFound: boolean;
	/** 走到了多少个本工程类（含目标类）。 */
	visited: number;
	/** 走满 REACH_LIMIT 还没走完。 */
	truncated: boolean;
	effects: ReachHit[];
}

function tokenHits(code: string, tokens: readonly string[]): string[] {
	return tokens.filter((token) => code.includes(token));
}

/** 一个类里从这几个方法出发走到的方法体，和走不到声明（多半在父类里）的直接调用。 */
function methodClosure(
	code: string,
	decls: Declaration[],
	names: Iterable<string>,
): { text: string; unresolved: Set<string> } {
	const seen = new Set<Declaration>();
	const queue: Declaration[] = [];
	const unresolved = new Set<string>();
	const want = (name: string): void => {
		// 大写开头的是 new Foo(…)：构造器，不是去父类里找的方法
		if (/^[A-Z]/.test(name)) return;
		const local = decls.filter((decl) => decl.name === name);
		if (local.length === 0) unresolved.add(name);
		queue.push(...local);
	};
	for (const name of names) want(name);
	const bodies: string[] = [];
	while (queue.length > 0) {
		const decl = queue.shift() as Declaration;
		if (seen.has(decl)) continue;
		seen.add(decl);
		const body = code.slice(decl.start, decl.end + 1);
		bodies.push(body);
		for (const call of body.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g))
			if (!JAVA_KEYWORDS.has(call[1] as string)) want(call[1] as string);
		for (const call of body.matchAll(/\bthis\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g)) want(call[1] as string);
	}
	return { text: bodies.join("\n"), unresolved };
}

/**
 * 从 `cls#method` 出发能走到的本工程代码里，带着哪些回滚兜不住的写法。
 *
 * 每个类都尽量按方法走：从要的方法出发，加上它（递归地）直接调到的本类方法。认不出方法声明时退回整个文件；
 * 本类里没声明、却被直接调用的方法可能在父类里，父类是本工程的类就去父类按这些名字接着找。
 * 被引用到的类按 {@link referencedClasses} 的规矩：只以 `类.方法(…)` 出现的只查那几个方法，其余整个文件。
 */
export function callReach(ctx: KernelContext, target: SourceClass, method: string): CallReach {
	const all = projectClasses(ctx);
	const byFqn = new Map(all.map((cls) => [cls.fqn, cls]));
	const parsed = new Map<string, { code: string; decls: Declaration[]; visible: Map<string, SourceClass> }>();
	const read = (cls: SourceClass) => {
		let entry = parsed.get(cls.fqn);
		if (entry === undefined) {
			const code = blankJavaNoise(ctx.ports.fs.read(cls.file));
			entry = { code, decls: declarations(code), visible: visibleClasses(code, cls, byFqn, all) };
			parsed.set(cls.fqn, entry);
		}
		return entry;
	};

	const own = read(target);
	const declared = [...new Set(own.decls.map((decl) => decl.name))].filter((name) => name !== target.simple).sort();
	const methodFound = own.decls.some((decl) => decl.name === method);

	const effects: ReachHit[] = [];
	const record = (cls: SourceClass, text: string, via: string[]): void => {
		const push = (bucket: ReachHit[], tokens: readonly string[]) => {
			const fresh = tokenHits(text, tokens);
			if (fresh.length === 0) return;
			const known = bucket.find((hit) => hit.cls === cls.fqn);
			if (known === undefined) bucket.push({ cls: cls.fqn, file: cls.file, hits: fresh, via });
			else for (const token of fresh) if (!known.hits.includes(token)) known.hits.push(token);
		};
		push(effects, EXTERNAL_EFFECT_TOKENS);
	};

	// 每个类已经查过哪些方法；"all" 是整个文件查过了。
	const scanned = new Map<string, Set<string> | "all">();
	const queue: { cls: SourceClass; methods: Set<string> | null; via: string[] }[] = [
		{ cls: target, methods: methodFound ? new Set([method]) : null, via: [target.fqn] },
	];
	let truncated = false;
	while (queue.length > 0) {
		const next = queue.shift() as { cls: SourceClass; methods: Set<string> | null; via: string[] };
		const done = scanned.get(next.cls.fqn);
		if (done === "all") continue;
		if (done === undefined && scanned.size >= REACH_LIMIT) {
			truncated = true;
			break;
		}
		const source = read(next.cls);
		let text: string;
		let unresolved = new Set<string>();
		const fresh =
			next.methods === null ? null : [...next.methods].filter((name) => done === undefined || !done.has(name));
		if (fresh !== null && fresh.length === 0) continue;
		if (fresh === null) {
			text = source.code;
			scanned.set(next.cls.fqn, "all");
		} else {
			// 这个文件里没声明的（继承来的）交给父类接着找
			const closure = methodClosure(source.code, source.decls, fresh);
			text = closure.text;
			unresolved = closure.unresolved;
			const set = done instanceof Set ? done : new Set<string>();
			for (const name of fresh) set.add(name);
			scanned.set(next.cls.fqn, set);
		}
		record(next.cls, text, next.via);
		for (const ref of referencedClasses(text, source.visible, byFqn))
			if (ref.cls.fqn !== next.cls.fqn)
				queue.push({ cls: ref.cls, methods: ref.methods, via: [...next.via, ref.cls.fqn] });
		if (unresolved.size > 0) {
			const parentName = /\bclass\s+[\w$]+(?:\s*<[^{]*?>)?\s+extends\s+([\w$.]+)/.exec(source.code)?.[1];
			const parent =
				parentName === undefined ? undefined : (byFqn.get(parentName) ?? source.visible.get(parentName));
			if (parent !== undefined)
				queue.push({ cls: parent, methods: unresolved, via: [...next.via, `${parent.fqn}（父类）`] });
		}
	}

	return { cls: target, declared, methodFound, visited: scanned.size, truncated, effects };
}

/** 方法名拼错时的候选：按编辑距离，最多 6 个。 */
export function nearNames(wanted: string, names: readonly string[]): string[] {
	const w = wanted.toLowerCase();
	return names
		.map((name) => ({ name, d: distance(w, name.toLowerCase()) }))
		.filter((entry) => entry.d <= Math.max(2, Math.floor(w.length / 3)) || entry.name.toLowerCase().includes(w))
		.sort((a, b) => a.d - b.d)
		.slice(0, 6)
		.map((entry) => entry.name);
}

function distance(a: string, b: string): number {
	let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
	for (let i = 1; i <= a.length; i++) {
		const cur = [i];
		for (let j = 1; j <= b.length; j++)
			cur[j] = Math.min(
				(cur[j - 1] as number) + 1,
				(prev[j] as number) + 1,
				(prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
			);
		prev = cur;
	}
	return prev[b.length] as number;
}

/** 引用链写成一行：`A → B → C`，只留简单类名。 */
export function viaText(via: readonly string[]): string {
	return via.map((name) => name.replace(/^[\w$.]*\.(?=[A-Z])/, "")).join(" → ");
}
