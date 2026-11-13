/**
 * 读到工程里的插件类时，附上它的周边：父类链、用到的本工程常量、同一个父类的其他类常写的方法。
 *
 * 真机量出来的事（`docs/S49-verify-once-class-surroundings.md` §2）：模型改一个插件之前，
 * 会一份一份去翻它的父类、常量类和别的插件找写法。同一个工程基类（扩展操作插件）在 12 份会话里被读过、
 * 一次都没改；检测单的常量类在 8 份会话里被读过；「翻工程找写法」在各类需求里都占 8%～24% 的轮次。
 * 这些都是从工程源码就能算出来的事实，不该靠模型一份一份去读。
 *
 * 三段，都从本工程源码现算，不靠代码关系表（关系表只收插件挂载和字段，不收继承和常量）：
 *
 *   - **父类链**：本工程里的祖先类一层层往上，每层给文件、它自己写了哪些方法（带行号和方法上面那行注释），
 *     本类覆盖了的标出来；走到第一个不在本工程里的类（平台基类）停。
 *   - **常量**：本类里 `类名.常量名` 和直接用到的祖先类常量，给值（字符串常量）、行号和上面那行注释。
 *     本类自己声明的不列：已经在正文里了。
 *   - **同类写法**：同一个直接父类的其他类有几个、它们常覆盖而本类没写的方法，每个方法给一个例子的文件和行号，
 *     包名最接近的例子优先。
 *
 * 只给插件类（自己或经过工程基类继承了平台插件基类，见 `plugin-base.ts`）。工程基类（本工程里有类继承它）、
 * 常量类、工具类不给：它们是被读的「周边」，不是要改的那个类。同一个父类的周边在一个会话里只给一次，
 * 第二个同父类的类只给常量。
 *
 * 解析是正则级的，宁缺勿错：认不出包名或类声明的文件不进索引，祖先解析不到就当平台类停下。
 */

import { relative } from "node:path";
import { moduleRoot, parseProjectDirs } from "../kernel/config/gradle.ts";
import { contentMemo } from "../kernel/content-memo.ts";
import { outlineJava } from "../kernel/impact/java-outline.ts";
import { type JavaSourcePort, pluginBaseOf, supertypesOf } from "./plugin-base.ts";

export interface ProjectJavaPort extends JavaSourcePort {
	/** 某个源码目录下全部 `.java`（递归）。 */
	listJavaFiles(dir: string): string[];
}

/** 一个工程类的索引事实：只够判父类和同类写法用，正文的提纲按需另算。 */
export interface JavaClassFacts {
	file: string;
	pkg: string;
	name: string;
	/** `import a.b.C;` 的全名 */
	imports: string[];
	/** `import a.b.*;` 的包名 */
	wildcards: string[];
	/** 直接父类的简单名：`extends` 的那个；只实现接口的，取第一个接口。 */
	parent: string | null;
	/** 带 `@Override` 的方法：名字和方法头所在行。 */
	overrides: { name: string; line: number }[];
}

export interface ProjectJavaIndex {
	root: string;
	byFqcn: Map<string, JavaClassFacts>;
	byFile: Map<string, JavaClassFacts>;
	classes: JavaClassFacts[];
}

const posix = (path: string): string => path.replace(/\\/g, "/");

/** 去掉注释，字符串里的内容留着长度换成空格：行号不变，注释里的 `extends`、`@Override` 不算。 */
function blankComments(text: string): string {
	let out = "";
	let i = 0;
	while (i < text.length) {
		const two = text.slice(i, i + 2);
		if (two === "//") {
			while (i < text.length && text[i] !== "\n") {
				out += " ";
				i += 1;
			}
			continue;
		}
		if (two === "/*") {
			const end = text.indexOf("*/", i + 2);
			const stop = end < 0 ? text.length : end + 2;
			out += text.slice(i, stop).replace(/[^\n]/g, " ");
			i = stop;
			continue;
		}
		const ch = text[i] as string;
		if (ch === '"' || ch === "'") {
			out += ch;
			i += 1;
			while (i < text.length && text[i] !== ch && text[i] !== "\n") {
				if (text[i] === "\\") {
					out += "  ";
					i += 2;
					continue;
				}
				out += " ";
				i += 1;
			}
			if (i < text.length) {
				out += text[i];
				i += 1;
			}
			continue;
		}
		out += ch;
		i += 1;
	}
	return out;
}

const OVERRIDE_HEADER =
	/^\s*(?:@\w+(?:\([^)]*\))?\s*)*(?:(?:public|protected|private|static|final|synchronized|abstract)\s+)*(?:<[^>]+>\s*)?[\w.<>[\],?\s]+?\s+(\w+)\s*\(/;

/** 一份源码 → 索引事实。认不出包名或与文件同名的类型声明时返回 null。 */
export function javaClassFacts(file: string, text: string): JavaClassFacts | null {
	const name =
		posix(file)
			.split("/")
			.pop()
			?.replace(/\.java$/, "") ?? "";
	const code = blankComments(text);
	const pkg = /^\s*package\s+([\w.]+)\s*;/m.exec(code)?.[1];
	if (pkg === undefined || name === "") return null;
	const header = new RegExp(`\\b(?:class|interface|enum)\\s+${name}\\b([^{]*)\\{`).exec(code);
	if (header === null) return null;
	const decl = header[1] ?? "";
	const extended = /\bextends\s+([\w.]+)/.exec(decl)?.[1];
	const parent = (extended ?? supertypesOf(decl)[0] ?? null)?.split(".").pop() ?? null;
	const imports: string[] = [];
	const wildcards: string[] = [];
	for (const match of code.matchAll(/^\s*import\s+([\w.]+?)(\.\*)?\s*;/gm)) {
		if (match[2] === undefined) imports.push(match[1] as string);
		else wildcards.push(match[1] as string);
	}
	const lines = code.split("\n");
	const overrides: { name: string; line: number }[] = [];
	for (let index = 0; index < lines.length; index += 1) {
		if (!/@Override\b/.test(lines[index] as string)) continue;
		// 注解和方法头可能同一行，也可能隔着几行别的注解
		for (let next = index; next < Math.min(lines.length, index + 4); next += 1) {
			const line = (lines[next] as string).replace(/@Override\b/, "");
			const method = OVERRIDE_HEADER.exec(line);
			if (method !== null && method[1] !== undefined) {
				overrides.push({ name: method[1], line: next + 1 });
				break;
			}
		}
	}
	return { file: posix(file), pkg, name, imports, wildcards, parent, overrides };
}

/**
 * 工程里各代码模块的源码目录：`<根>/src/main/java`、`<根>/<模块>/src/main/java`，
 * 以及 settings.gradle 用 `projectDir` 挪走的模块（开发助手模板放在 `code/<云>/<模块>` 下）。
 */
export function sourceRootsOf(
	root: string,
	port: {
		exists(path: string): boolean;
		read(path: string): string;
		readDir(path: string): { name: string; isDirectory: boolean }[];
	},
): string[] {
	const base = posix(root).replace(/\/$/, "");
	const roots = [`${base}/src/main/java`];
	for (const entry of port.readDir(base)) {
		if (entry.isDirectory && !entry.name.startsWith(".")) roots.push(`${base}/${entry.name}/src/main/java`);
	}
	const settings = `${base}/settings.gradle`;
	const moved = port.exists(settings) ? parseProjectDirs(port.read(settings)) : {};
	for (const module of Object.keys(moved)) roots.push(`${posix(moduleRoot(base, module, moved))}/src/main/java`);
	return [...new Set(roots)].filter((dir) => port.exists(dir));
}

/** 索引隔一分钟重建一次，内容没变的文件不再重拆。 */
const factsOf = contentMemo(javaClassFacts);

export function buildJavaIndex(root: string, sourceRoots: readonly string[], port: ProjectJavaPort): ProjectJavaIndex {
	const index: ProjectJavaIndex = { root: posix(root), byFqcn: new Map(), byFile: new Map(), classes: [] };
	for (const dir of sourceRoots) {
		for (const file of port.listJavaFiles(dir)) {
			const facts = factsOf(file, port.read(file));
			if (facts === null) continue;
			index.classes.push(facts);
			index.byFile.set(facts.file, facts);
			index.byFqcn.set(`${facts.pkg}.${facts.name}`, facts);
		}
	}
	return index;
}

/** 类 `from` 里写的简单名 → 本工程的类；不在本工程（平台类、JDK 类）返回 null。 */
export function resolveProjectClass(
	index: ProjectJavaIndex,
	from: JavaClassFacts,
	name: string,
): JavaClassFacts | null {
	if (name.includes(".")) return index.byFqcn.get(name) ?? null;
	const imported = from.imports.find((fqcn) => fqcn.endsWith(`.${name}`));
	if (imported !== undefined) return index.byFqcn.get(imported) ?? null;
	const same = index.byFqcn.get(`${from.pkg}.${name}`);
	if (same !== undefined) return same;
	for (const pkg of from.wildcards) {
		const hit = index.byFqcn.get(`${pkg}.${name}`);
		if (hit !== undefined) return hit;
	}
	return null;
}

/** 父类的身份：本工程的类按文件，平台类按简单名。用来认「同一个父类」。 */
function parentKey(index: ProjectJavaIndex, facts: JavaClassFacts): string | null {
	if (facts.parent === null) return null;
	const project = resolveProjectClass(index, facts, facts.parent);
	return project === null ? `platform:${facts.parent}` : `project:${project.file}`;
}

/** 方法、常量上面那行注释（`//…` 或文档注释第一行），没有给空串。 */
function noteAbove(lines: readonly string[], line: number): string {
	let at = line - 2;
	while (at >= 0 && /^\s*(@\w+(\([^)]*\))?\s*)?$/.test(lines[at] as string)) at -= 1;
	const text = (lines[at] ?? "").trim();
	if (text.startsWith("//")) return clip(text.replace(/^\/\/+\s*/, ""), 24);
	if (!text.endsWith("*/")) return "";
	let start = at;
	while (start >= 0 && !(lines[start] as string).includes("/*")) start -= 1;
	const body = lines
		.slice(Math.max(0, start), at + 1)
		.map((one) =>
			one
				.replace(/\/\*+|\*+\//g, "")
				.replace(/^\s*\*+/, "")
				.trim(),
		)
		.filter((one) => one !== "" && !one.startsWith("@"));
	return clip(body[0] ?? "", 24);
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const span = (from: number, to: number): string =>
	from === to ? `第 ${String(from)} 行` : `第 ${String(from)}–${String(to)} 行`;

const MAX_CHAIN = 8;
const MAX_METHODS = 10;
const MAX_CONSTANTS = 12;
const MAX_HABITS = 5;

export interface SurroundingsRequest {
	index: ProjectJavaIndex;
	/** 正在读的文件（绝对路径）。 */
	file: string;
	source: JavaSourcePort;
	/** 这个会话里已经给过的：父类身份（父类链和同类写法跟着它）、常量。给了就记进去。 */
	seen: SurroundingsSeen;
}

export interface SurroundingsSeen {
	parents: Set<string>;
	constants: Set<string>;
}

export function createSurroundingsSeen(): SurroundingsSeen {
	return { parents: new Set(), constants: new Set() };
}

export interface Surroundings {
	text: string;
	/** 周边里点到名的文件：父类、常量类、同类写法的例子。尺子用。 */
	named: { file: string; why: "parent" | "constant" | "sibling" }[];
}

/** 本类的周边；不是插件类、或者没什么可说的，返回 null。 */
export function classSurroundings(request: SurroundingsRequest): Surroundings | null {
	const { index, source } = request;
	const file = posix(request.file);
	const text = source.read(file);
	if (text === "") return null;
	const self = index.byFile.get(file) ?? javaClassFacts(file, text);
	if (self === null) return null;
	const plugin = pluginBaseOf(text, { file, source });
	if (plugin === null || plugin.tier === "loose") return null;
	const selfKey = `project:${file}`;
	// 工程基类：本工程里有类继承它，它是别人的周边
	if (index.classes.some((other) => other.file !== file && parentKey(index, other) === selfKey)) return null;

	const rel = (path: string): string => posix(relative(index.root, path));
	const named: Surroundings["named"] = [];
	const parts: string[] = [];
	const key = parentKey(index, self);
	const firstForParent = key !== null && !request.seen.parents.has(key);
	const ownOverrides = new Set(self.overrides.map((one) => one.name));

	// ---- 父类链
	const chain: { facts: JavaClassFacts; text: string }[] = [];
	let platform: string | null = self.parent;
	let cursor = self;
	while (cursor.parent !== null && chain.length < MAX_CHAIN) {
		const up = resolveProjectClass(index, cursor, cursor.parent);
		if (up === null || chain.some((one) => one.facts.file === up.file) || up.file === file) {
			platform = cursor.parent;
			break;
		}
		chain.push({ facts: up, text: source.read(up.file) });
		named.push({ file: up.file, why: "parent" });
		cursor = up;
		platform = up.parent;
	}
	if (firstForParent && self.parent !== null) {
		const links = chain.map((one) => `${one.facts.name}（${rel(one.facts.file)}）`);
		if (platform !== null) links.push(`${platform}（平台）`);
		parts.push(`父类：${links.join(" → ")}`);
		for (const one of chain) {
			const outline = outlineJava(one.text);
			if (outline === null || outline.methods.length === 0) continue;
			const lines = one.text.split(/\r?\n/);
			const shown = outline.methods.slice(0, MAX_METHODS).map((method) => {
				const label = method.label.replace(/\(.*$/, "");
				const note = noteAbove(lines, method.from);
				const mark = ownOverrides.has(label) ? "，本类覆盖了" : "";
				return `${label} ${span(method.from, method.to)}${note === "" && mark === "" ? "" : `（${[note, mark.slice(1)].filter((x) => x !== "").join("，")}）`}`;
			});
			const more = outline.methods.length > MAX_METHODS ? ` 等 ${String(outline.methods.length)} 个` : "";
			parts.push(`  ${one.facts.name} 写了：${shown.join("、")}${more}`);
		}
	} else if (chain.length > 0 && !firstForParent) {
		parts.push(`父类 ${chain[0]?.facts.name ?? self.parent} 的父类链和同类写法前面已经给过`);
	}

	// ---- 常量
	const code = blankComments(text);
	const declaredHere = new Set((outlineJava(text)?.constants ?? []).map((one) => one.name));
	const wanted: { owner: JavaClassFacts; name: string }[] = [];
	const seenConstant = new Set<string>();
	const want = (owner: JavaClassFacts, name: string): void => {
		const id = `${owner.file}#${name}`;
		if (seenConstant.has(id) || request.seen.constants.has(id)) return;
		seenConstant.add(id);
		wanted.push({ owner, name });
	};
	for (const match of code.matchAll(/\b([A-Z]\w*)\.([A-Z][A-Z0-9_]+)\b/g)) {
		const owner = resolveProjectClass(index, self, match[1] as string);
		if (owner !== null && owner.file !== file) want(owner, match[2] as string);
	}
	const inherited = new Map<string, JavaClassFacts>();
	for (const one of chain) {
		for (const constant of outlineJava(one.text)?.constants ?? []) inherited.set(constant.name, one.facts);
	}
	for (const match of code.matchAll(/(?<![.\w])([A-Z][A-Z0-9_]{2,})\b/g)) {
		const owner = inherited.get(match[1] as string);
		if (owner !== undefined && !declaredHere.has(match[1] as string)) want(owner, match[1] as string);
	}
	const byOwner = new Map<string, string[]>();
	let shownConstants = 0;
	const outlines = new Map<string, ReturnType<typeof outlineJava>>();
	for (const { owner, name } of wanted) {
		if (!outlines.has(owner.file)) outlines.set(owner.file, outlineJava(source.read(owner.file)));
		const outline = outlines.get(owner.file);
		const constant = outline?.constants.find((one) => one.name === name);
		if (constant === undefined) continue;
		shownConstants += 1;
		if (shownConstants > MAX_CONSTANTS) continue;
		request.seen.constants.add(`${owner.file}#${name}`);
		const ownerLines = source.read(owner.file).split(/\r?\n/);
		const note = noteAbove(ownerLines, constant.line);
		const value = constant.value === null ? "" : `="${clip(constant.value, 40)}"`;
		const list = byOwner.get(owner.file) ?? [];
		list.push(`${name}${value}${note === "" ? "" : `（${note}）`}`);
		byOwner.set(owner.file, list);
		if (!named.some((one) => one.file === owner.file)) named.push({ file: owner.file, why: "constant" });
	}
	if (byOwner.size > 0) {
		parts.push("用到的本工程常量：");
		for (const [owner, list] of byOwner) {
			parts.push(`  ${index.byFile.get(owner)?.name ?? owner}（${rel(owner)}）：${list.join("、")}`);
		}
		if (shownConstants > MAX_CONSTANTS) parts.push(`  另有 ${String(shownConstants - MAX_CONSTANTS)} 个没列`);
	}

	// ---- 同类写法
	if (firstForParent && key !== null) {
		const siblings = index.classes.filter((other) => other.file !== file && parentKey(index, other) === key);
		// 例子挑包名最接近的：同一块业务的写法最可能照着用
		const near = (pkg: string): number => {
			const mine = self.pkg.split(".");
			const theirs = pkg.split(".");
			let same = 0;
			while (same < mine.length && mine[same] === theirs[same]) same += 1;
			return same;
		};
		const habits = new Map<string, { count: number; example: { file: string; line: number; near: number } }>();
		for (const sibling of siblings) {
			for (const name of new Set(sibling.overrides.map((one) => one.name))) {
				if (ownOverrides.has(name)) continue;
				const line = sibling.overrides.find((one) => one.name === name)?.line ?? 0;
				const closeness = near(sibling.pkg);
				const habit = habits.get(name);
				if (habit === undefined)
					habits.set(name, { count: 1, example: { file: sibling.file, line, near: closeness } });
				else {
					habit.count += 1;
					if (closeness > habit.example.near) habit.example = { file: sibling.file, line, near: closeness };
				}
			}
		}
		const top = [...habits.entries()]
			.sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
			.slice(0, MAX_HABITS);
		if (siblings.length > 0) {
			parts.push(
				`同一个父类的还有 ${String(siblings.length)} 个类` +
					(top.length === 0 ? "，它们覆盖的方法本类都写了" : "，它们常写、本类没写的方法："),
			);
			for (const [name, habit] of top) {
				parts.push(
					`  ${name}：${String(habit.count)} 个类写了，例 ${rel(habit.example.file)} 第 ${String(habit.example.line)} 行`,
				);
				if (!named.some((one) => one.file === habit.example.file))
					named.push({ file: habit.example.file, why: "sibling" });
			}
		}
		request.seen.parents.add(key);
	}

	// 没有新东西：只剩「前面已经给过」，或者只有一个平台父类（源码里 extends 那行就写着）
	const nothingNew = parts.every((part) => part.endsWith("前面已经给过"));
	const onlyPlatformParent = chain.length === 0 && parts.length === 1 && parts[0]?.startsWith("父类：") === true;
	if (parts.length === 0 || nothingNew || onlyPlatformParent) return null;
	return { text: [`${self.name} 的周边（按本工程源码算，同一个父类只给一次）：`, ...parts].join("\n"), named };
}
