/**
 * The half of an API that reflection can never see (S7.2).
 *
 * D13's investigation found that the frozen implementation read only four
 * frontmatter fields per API document, so `sig` could print one sentence of
 * `when_to_use` and nothing else. Everything that makes an API usable -- the
 * Chinese description of what a method does, the REAL parameter names (reflection
 * gives `arg0`), `@param` / `@return` prose, and the traps -- sits in the document
 * BODY, and had never been read by anything.
 *
 * This module reads it. 1,520 of the 1,528 API documents share one shape:
 *
 *     ## 方法列表
 *     ### closeAllDataSet
 *     关闭当前线程的所有DataSet          <- the prose, traps included
 *     **方法签名：**
 *     ```java
 *     public static void closeAllDataSet()
 *     ```
 *     **参数说明：**
 *     - `algoKey`: `String` — 用来标记不同 Algo 对象的标识
 *     **返回值：**
 *     - `Algo`: Algo
 *
 * Measured over the whole corpus: 15,757 signature blocks, every one starting with
 * `public`, none carrying `throws`, 2,920 carrying generics. That uniformity is why
 * this is a parser and not a heuristic -- and why anything that does NOT parse is
 * reported rather than skipped, because a silently unparsed document is a class
 * whose documentation stops existing.
 */

/** One documented parameter. `name` is the real one, which is the point. */
export interface ApiParam {
	name: string;
	type: string;
	doc: string;
}

export interface ApiMethod {
	name: string;
	/** The `public ...` line exactly as documented, generics and all. */
	signature: string;
	returnType: string;
	/** Parameter types as written in the signature, before erasure. */
	paramTypes: readonly string[];
	isStatic: boolean;
	/** Prose above the signature: what it does, and the traps. */
	doc: string;
	params: readonly ApiParam[];
	/** The 返回值 line's prose, empty when the method returns void. */
	returns: string;
}

export interface ApiDoc {
	relativePath: string;
	fqcn: string;
	apiClass: string;
	apiPackage: string;
	frameworkVersion: string;
	whenToUse: string;
	overview: string;
	methods: readonly ApiMethod[];
}

function frontMatterField(block: string, key: string): string {
	const match = new RegExp(String.raw`^${key}:\s*(.*)$`, "m").exec(block);
	if (match === null) return "";
	return (match[1] ?? "").trim().replace(/^"(.*)"$/, "$1");
}

/**
 * Erases a type to what reflection reports for it.
 *
 * `ApiTool` prints `Class#getSimpleName()`, so the doc's `Collection<Object[]>` and
 * `kd.bos.algo.CachedDataSet.Builder` have to become `Collection` and `Builder`
 * before they can be compared. Getting this wrong does not fail loudly -- it makes
 * every overload look like a mismatch, and the join would then report a whole class
 * as both 悬空 and 无注释 at once.
 */
export function eraseType(type: string): string {
	let depth = 0;
	let stripped = "";
	// Generics first: the package split below must not cut inside <...>.
	for (const char of type.trim()) {
		if (char === "<") depth += 1;
		else if (char === ">") depth = Math.max(0, depth - 1);
		else if (depth === 0) stripped += char;
	}
	let out = stripped.trim();
	const arraySuffix = /(\[\])+$/.exec(out)?.[0] ?? "";
	if (arraySuffix !== "") out = out.slice(0, out.length - arraySuffix.length);
	const lastDot = out.lastIndexOf(".");
	if (lastDot >= 0) out = out.slice(lastDot + 1);
	return out.trim() + arraySuffix;
}

/** Splits a parameter list on top-level commas only, so `Map<String,Object>` stays whole. */
export function splitParams(inside: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let current = "";
	for (const char of inside) {
		if (char === "<") depth += 1;
		else if (char === ">") depth = Math.max(0, depth - 1);
		if (char === "," && depth === 0) {
			out.push(current.trim());
			current = "";
			continue;
		}
		current += char;
	}
	if (current.trim() !== "") out.push(current.trim());
	return out;
}

/**
 * The join key: a method name plus its erased parameter types.
 *
 * Name alone is not enough -- `createDataSet` has more than a dozen overloads in one
 * class, and collapsing them would hide exactly the case a developer needs the join
 * for: this overload exists in your JAR, that one does not.
 */
export function methodKey(name: string, paramTypes: readonly string[]): string {
	return `${name}(${paramTypes.map(eraseType).join(",")})`;
}

const MODIFIERS = new Set([
	"public",
	"protected",
	"private",
	"static",
	"abstract",
	"default",
	"final",
	"synchronized",
	"native",
]);

export interface ParsedSignature {
	name: string;
	returnType: string;
	paramTypes: string[];
	paramNames: string[];
	isStatic: boolean;
}

/**
 * Parses one `public static void foo(String a, Map<String,Object> b)` line.
 *
 * Returns null rather than guessing: a signature this cannot read is a document the
 * caller must report as unparsed, not a method quietly missing from the index.
 */
export function parseSignature(line: string): ParsedSignature | null {
	const open = line.indexOf("(");
	const close = line.lastIndexOf(")");
	if (open < 0 || close < open) return null;
	// A generic return type may carry spaces (`Map<String, Object>`), so the head is
	// split on top-level commas-free whitespace only after the generics are joined up.
	const head = line
		.slice(0, open)
		.trim()
		.replace(/\s*<\s*/g, "<")
		.replace(/\s*>\s*/g, "> ")
		.replace(/\s+/g, " ");
	const tokens = head.split(" ").filter((token) => token !== "");
	const name = tokens.pop();
	if (name === undefined || !/^[A-Za-z_$][\w$]*$/.test(name)) return null;
	const modifiers: string[] = [];
	while (tokens.length > 0 && MODIFIERS.has(tokens[0] as string)) modifiers.push(tokens.shift() as string);
	const returnType = tokens.join(" ").trim();
	if (returnType === "") return null;
	const inside = line.slice(open + 1, close).trim();
	const paramTypes: string[] = [];
	const paramNames: string[] = [];
	for (const part of inside === "" ? [] : splitParams(inside)) {
		const lastSpace = part.lastIndexOf(" ");
		if (lastSpace < 0) {
			paramTypes.push(part);
			paramNames.push("");
			continue;
		}
		paramTypes.push(part.slice(0, lastSpace).trim());
		paramNames.push(part.slice(lastSpace + 1).trim());
	}
	return { name, returnType, paramTypes, paramNames, isStatic: modifiers.includes("static") };
}

const PARAM_BULLET = /^-\s*`([^`]+)`\s*:\s*`([^`]+)`\s*(?:—|--|-)?\s*(.*)$/;

/** Parses the `- name: Type — doc` bullets under 参数说明. */
function parseParamBullets(block: string): ApiParam[] {
	const out: ApiParam[] = [];
	for (const line of block.split("\n")) {
		const match = PARAM_BULLET.exec(line.trim());
		if (match === null) continue;
		out.push({ name: (match[1] ?? "").trim(), type: (match[2] ?? "").trim(), doc: (match[3] ?? "").trim() });
	}
	return out;
}

/** Text of a bold `label：` block, up to the next bold label or the end of the entry. */
function labelBlock(entry: string, label: string): string {
	const marker = `**${label}：**`;
	const start = entry.indexOf(marker);
	if (start < 0) return "";
	const rest = entry.slice(start + marker.length);
	const next = /\n\*\*[^*\n]+：\*\*/.exec(rest);
	return (next === null ? rest : rest.slice(0, next.index)).trim();
}

/** Content of the first fenced block, fences removed. */
function fencedJava(block: string): string {
	const match = /```(?:java)?\n([\s\S]*?)```/.exec(block);
	return (match?.[1] ?? "").trim();
}

const SIGNATURE_MARKER = "**方法签名：**";
const OVERLOAD_MARKER = /\*\*重载\s*\d+\*\*/g;

/**
 * Splits one `### <name>` entry into its overloads.
 *
 * Overloads do NOT get a heading each: they share the method's heading and are
 * separated by `**重载 N**`. Taking one signature per heading loses 1,087 of the
 * corpus's 15,757 methods -- `ArrayUtils.add` alone has 20 -- and it loses them
 * precisely where the join needs them most: "this overload exists in your JAR, that
 * one does not" is the question overloads are asked about.
 *
 * Segmentation is driven by the signature blocks rather than by the 重载 markers,
 * because the markers are a formatting convention and the signature is the thing
 * being indexed. Each segment's prose is what sits between the previous signature's
 * block and this one, after the last 重载 marker (or the last horizontal rule when
 * the document did not use one).
 */
function splitOverloads(entry: string): { prose: string; rest: string }[] {
	const starts: number[] = [];
	for (let at = entry.indexOf(SIGNATURE_MARKER); at >= 0; at = entry.indexOf(SIGNATURE_MARKER, at + 1)) {
		starts.push(at);
	}
	return starts.map((start, index) => {
		const region = entry.slice(index === 0 ? 0 : (starts[index - 1] as number), start);
		let prose = region;
		OVERLOAD_MARKER.lastIndex = 0;
		let cut = -1;
		for (let match = OVERLOAD_MARKER.exec(region); match !== null; match = OVERLOAD_MARKER.exec(region)) {
			cut = match.index + match[0].length;
		}
		if (cut >= 0) prose = region.slice(cut);
		else if (index > 0) {
			// No 重载 marker: everything up to the last rule belongs to the previous
			// overload's 参数说明 / 返回值, and must not be read as this one's description.
			const rule = region.lastIndexOf("\n---\n");
			prose = rule < 0 ? "" : region.slice(rule + 5);
		}
		return {
			prose: prose.replace(/\n---\s*$/, "").trim(),
			rest: entry.slice(start, index + 1 < starts.length ? (starts[index + 1] as number) : entry.length),
		};
	});
}

/**
 * Whether a method's prose says anything a reader did not already know.
 *
 * Measured over the corpus: 601 of 15,757 methods carry no Chinese description, and
 * inside that group are 43 literal `(non-Javadoc)` markers and a tail of entries
 * whose whole "description" is the method's own name ("combine", "reduce"). Those
 * are not documentation, and presenting them as such is worse than reporting the
 * method as uncommented -- it tells the reader the question has been answered.
 */
export function isUninformativeDoc(method: { name: string; doc: string }): boolean {
	const text = method.doc.trim();
	if (text === "") return true;
	if (/^\(non-Javadoc\)/i.test(text)) return true;
	return text.replace(/[\s.。()（）]/g, "").toLowerCase() === method.name.toLowerCase();
}

export interface ParseApiDocResult {
	doc: ApiDoc | null;
	/** Signature lines this could not read. Empty is the expected state. */
	unparsed: readonly string[];
	/** Why `doc` is null. Non-null exactly when `doc` is null. */
	why: string | null;
}

/**
 * Parses one API document.
 *
 * `why` explains a null `doc` rather than leaving the caller to guess: 8 of the
 * 1,528 files are indexes and extraction reports, not API pages, and "not an API
 * page" has to stay distinguishable from "an API page this failed to read".
 */
export function parseApiDoc(relativePath: string, text: string): ParseApiDocResult {
	const normalised = text.replace(/\r\n/g, "\n");
	if (!normalised.startsWith("---\n")) return { doc: null, unparsed: [], why: "没有 frontmatter" };
	const end = normalised.indexOf("\n---\n", 3);
	if (end < 0) return { doc: null, unparsed: [], why: "frontmatter 没有闭合" };
	const meta = normalised.slice(4, end);
	const body = normalised.slice(end + 5);
	const apiClass = frontMatterField(meta, "api_class");
	const apiPackage = frontMatterField(meta, "api_package");
	if (apiClass === "" || apiPackage === "") {
		return { doc: null, unparsed: [], why: "不是 API 页（缺 api_class / api_package）" };
	}

	const listStart = body.indexOf("\n## 方法列表");
	const overview = /\n## 概述\n([\s\S]*?)(?=\n## |\n---\n|$)/.exec(body);
	const methods: ApiMethod[] = [];
	const unparsed: string[] = [];
	if (listStart >= 0) {
		// Entries are "### <name>" up to the next heading. Splitting on the heading
		// rather than on the "---" rule matters: the rule also appears inside prose,
		// and splitting on it would cut methods in half.
		for (const part of body
			.slice(listStart)
			.split(/\n### /)
			.slice(1)) {
			const newline = part.indexOf("\n");
			const entry = newline < 0 ? "" : part.slice(newline + 1);
			for (const segment of splitOverloads(entry)) {
				const signature = fencedJava(labelBlock(segment.rest, "方法签名"));
				if (signature === "") continue;
				const parsed = parseSignature(signature);
				if (parsed === null) {
					unparsed.push(signature);
					continue;
				}
				const bullets = parseParamBullets(labelBlock(segment.rest, "参数说明"));
				methods.push({
					name: parsed.name,
					signature,
					returnType: parsed.returnType,
					paramTypes: parsed.paramTypes,
					isStatic: parsed.isStatic,
					doc: segment.prose,
					// Real names come from the signature, which always has them; the bullets
					// carry each one's prose and are matched by name, falling back to
					// position when a bullet names a parameter the signature does not.
					params: parsed.paramTypes.map((type, index) => {
						const declared = parsed.paramNames[index] ?? "";
						const bullet = bullets.find((item) => item.name === declared) ?? bullets[index];
						return { name: declared, type, doc: bullet?.doc ?? "" };
					}),
					returns: labelBlock(segment.rest, "返回值").replace(/^-\s*/, "").trim(),
				});
			}
		}
	}
	return {
		doc: {
			relativePath,
			fqcn: `${apiPackage}.${apiClass}`,
			apiClass,
			apiPackage,
			frameworkVersion: frontMatterField(meta, "framework_version"),
			whenToUse: frontMatterField(meta, "when_to_use"),
			overview: (overview?.[1] ?? "").trim(),
			methods,
		},
		unparsed,
		why: null,
	};
}
