/**
 * javac diagnostics -> structured findings (S3.1, ported from driver.mjs).
 *
 * javac tells you "cannot find symbol" but never what the real name is, and a
 * hallucinated API is precisely a name that is almost right. So the diagnostics
 * are parsed into findings that carry a reflection query, and the query results
 * are merged back in by the caller. This module is pure: no process, no console.
 *
 * The parser accepts both the Chinese and English javac locales. A Chinese
 * Windows JDK emits 错误/符号/位置; CI and macOS emit error/symbol/location.
 * Matching only one of them means the whole hint pipeline silently degrades to
 * "raw javac output" on the other, which looks like a knowledge-base problem.
 */

import { relative, resolve } from "node:path";

export interface Diagnostic {
	/** Absolute path, resolved against the project root. */
	file: string;
	line: number;
	msg: string;
	/** The indented continuation lines javac prints under the message. */
	detail: string[];
}

/** A reflection query: [id, kind, owner, name, argCount]. Fed to ApiTool suggest. */
export type SuggestQuery = [string, string, string, string, string];

export interface Finding {
	file: string;
	line: number;
	/** Every line the same problem was reported on, merged. */
	lines: number[];
	/** One sentence in human terms. */
	what: string;
	/** Best single hint, filled from javac's own detail when it already knows. */
	hint: string;
	/** Further candidate overloads. */
	extra: string[];
	/** Query id linking this finding to a suggest result, or "" when none was made. */
	qid: string;
}

const DIAG_HEAD = /^(.+\.java):(\d+): (?:错误|error): (.*)$/;

export function parseDiags(output: string, root: string): Diagnostic[] {
	const lines = output.split("\n");
	const diags: Diagnostic[] = [];
	for (let i = 0; i < lines.length; i++) {
		const head = DIAG_HEAD.exec(lines[i] as string);
		if (!head) continue;
		const detail: string[] = [];
		for (let j = i + 1; j < lines.length && !DIAG_HEAD.test(lines[j] as string); j++) {
			detail.push(lines[j] as string);
		}
		diags.push({
			file: resolve(root, head[1] as string),
			line: Number(head[2]),
			msg: head[3] as string,
			detail,
		});
	}
	return diags;
}

interface SourceInfo {
	pkg: string;
	imports: Map<string, string>;
}

/**
 * A file's import table. javac's "location: class X" gives the simple name as
 * written in the source, while reflection needs the fully-qualified one, and the
 * imports are the only place to recover it from.
 */
export function sourceInfo(text: string): SourceInfo {
	const pkg = /^\s*package\s+([\w.]+)\s*;/m.exec(text)?.[1] ?? "";
	const imports = new Map<string, string>();
	for (const match of text.matchAll(/^\s*import\s+(?:static\s+)?([\w.]+)\s*;/gm)) {
		const fqn = match[1] as string;
		if (fqn.endsWith(".*")) continue;
		imports.set(fqn.slice(fqn.lastIndexOf(".") + 1), fqn);
	}
	return { pkg, imports };
}

/** Reader for a source file's text; injected so this module stays pure. */
export type SourceReader = (file: string) => string;

function fqnOf(simple: string, file: string, read: SourceReader, cache: Map<string, SourceInfo>): string {
	if (simple.includes(".")) return simple;
	let info = cache.get(file);
	if (!info) {
		info = sourceInfo(read(file));
		cache.set(file, info);
	}
	return info.imports.get(simple) ?? (info.pkg ? `${info.pkg}.${simple}` : simple);
}

const SYMBOL_RE =
	/(?:符号|symbol)\s*:\s*(方法|类|接口|变量|构造器|method|class|interface|variable|constructor)\s+(.+?)\s*$/m;
const LOCATION_RE = /(?:位置|location)\s*:\s*(?:类|接口|程序包|变量|class|interface|package|variable)\s+(.+?)\s*$/m;
/**
 * "位置: 类型为DynamicObject的变量 obj" -- the owner is the variable's TYPE, and
 * LOCATION_RE cannot reach it (there is no separator after 类). Real JDK 8 output
 * on this form left the owner as "-", which made the reflection lookup a
 * project-wide fuzzy class search: `obj.getStringNope(...)` came back suggesting
 * `okio.internal.-Path`. Measured on the user's JDK 1.8.0_191; see docs/S3-slice.md.
 */
const TYPED_VARIABLE_RE = /(?:位置|location)\s*:\s*类型为(.+?)的变量\s+\S+\s*$/m;
const TYPED_VARIABLE_EN_RE = /(?:location)\s*:\s*variable\s+\S+\s+of type\s+(.+?)\s*$/m;
/**
 * The Chinese JDK 8 message has NO spaces: "程序包kd.bos.foo不存在". The frozen
 * pattern required them, so the whole missing-package branch never fired on a
 * Chinese Windows and the finding carried no lookup at all -- while the common
 * real case is a right class name under a wrong package.
 */
const PACKAGE_MISSING_RE = /程序包\s*(\S+?)\s*不存在|package\s+(\S+)\s+does not exist/;

/** javac prints argument types unerased, so `Map<String,Object>` is one argument, not two. */
function argCountOf(body: string): number {
	if (!/\(/.test(body)) return -1;
	const inner = body.replace(/^[^(]*\(|\)\s*$/g, "").trim();
	if (inner === "") return 0;
	let depth = 0;
	let count = 1;
	for (const char of inner) {
		if (char === "<") depth += 1;
		else if (char === ">") depth = Math.max(0, depth - 1);
		else if (char === "," && depth === 0) count += 1;
	}
	return count;
}

/**
 * Diagnostics -> findings plus the reflection queries they need.
 *
 * Merging is not cosmetic: one misspelled class name is reported on the import
 * line and on every use, so a single mistake can produce six diagnostics and
 * push the other problems off the screen. Findings are merged by
 * "file + what is wrong", the extra line numbers ride along, and the reflection
 * lookup happens once.
 */
export function buildQueries(
	diags: readonly Diagnostic[],
	read: SourceReader,
): { queries: SuggestQuery[]; findings: Finding[] } {
	const queries: SuggestQuery[] = [];
	const findings: Finding[] = [];
	const byKey = new Map<string, Finding>();
	const infoCache = new Map<string, SourceInfo>();
	let n = 0;

	for (const diag of diags) {
		const detailText = diag.detail.join("\n");
		const symbol = SYMBOL_RE.exec(detailText);
		const typedVariable = TYPED_VARIABLE_RE.exec(detailText) ?? TYPED_VARIABLE_EN_RE.exec(detailText);
		// A typed-variable location names the owner directly; prefer it over the
		// generic form, which cannot parse that shape at all.
		const location = typedVariable ?? LOCATION_RE.exec(detailText);
		const finding: Finding = {
			file: diag.file,
			line: diag.line,
			lines: [diag.line],
			what: diag.msg,
			hint: "",
			extra: [],
			qid: "",
		};
		let key = "";
		let query: [string, string, string, string] | null = null;

		if (/找不到符号|cannot find symbol/.test(diag.msg) && symbol) {
			const kind = symbol[1] as string;
			const body = symbol[2] as string;
			const name = body.replace(/\(.*/, "");
			const argc = argCountOf(body);
			const owner = location ? fqnOf(location[1] as string, diag.file, read, infoCache) : "-";
			if (/方法|method/.test(kind)) {
				finding.what = `方法 ${location ? `${location[1]}.` : ""}${body} 不存在`;
				key = `method:${owner}.${name}/${argc}`;
				query = ["method", owner, name, String(argc)];
			} else if (/变量|variable/.test(kind)) {
				finding.what = `字段/变量 ${location ? `${location[1]}.` : ""}${name} 不存在`;
				key = `field:${owner}.${name}`;
				// A package location means the class itself did not resolve; looking up a
				// field on it would answer a question nobody asked.
				if (location && !/位置\s*:\s*程序包|location\s*:\s*package/.test(detailText)) {
					query = ["field", owner, name, "-1"];
				}
			} else {
				finding.what = `类 ${name} 不存在${location ? `（在 ${location[1]} 下）` : ""}`;
				key = `class:${name}`;
				query = ["class", "-", name, "-1"];
			}
		} else if (PACKAGE_MISSING_RE.test(diag.msg)) {
			const pkg = (PACKAGE_MISSING_RE.exec(diag.msg) ?? []).slice(1).find(Boolean) ?? "";
			const imported = /import\s+(?:static\s+)?([\w.]+)/.exec(diag.detail[0] ?? "");
			const simple = imported ? (imported[1] as string).slice((imported[1] as string).lastIndexOf(".") + 1) : "";
			finding.what = `程序包 ${pkg} 不存在`;
			if (simple) {
				key = `class:${simple}`;
				query = ["class", "-", simple, "-1"];
			}
		} else if (/找不到合适的|no suitable|无法将|cannot be applied/.test(diag.msg)) {
			// With -Xdiags:verbose the candidate signature and the reason it does not
			// apply are adjacent lines. Reporting only the reason says nothing, so the
			// signature above it has to come along. Do not try to recognise the reason
			// text -- there are at least three phrasings; match the "...不适用" line end.
			const why: string[] = [];
			for (let i = 0; i < diag.detail.length; i++) {
				const line = diag.detail[i] as string;
				if (!/(不适用|is not applicable)\s*$/.test(line)) continue;
				const sig = line.trim().replace(/(不适用|is not applicable)\s*$/, "");
				why.push(`${sig} ${(diag.detail[i + 1] ?? "").trim()}`.trim());
			}
			// Overloads with the wrong arity are rarely the one that was meant; the
			// useful candidate is "right count, one type off".
			const lengthOnly = (s: string): number => (/长度不同|differ in length/.test(s) ? 1 : 0);
			why.sort((a, b) => lengthOnly(a) - lengthOnly(b));
			finding.what = diag.msg.replace(/;$/, "");
			finding.hint = why[0] ?? "";
			finding.extra = why.slice(1);
		}

		const mergeKey = `${finding.file}|${key || `${finding.line}:${finding.what}`}`;
		const seen = byKey.get(mergeKey);
		if (seen) {
			seen.lines.push(finding.line);
			continue;
		}
		byKey.set(mergeKey, finding);
		if (query) {
			n += 1;
			finding.qid = `q${n}`;
			queries.push([finding.qid, ...query]);
		}
		findings.push(finding);
	}
	return { queries, findings };
}

/**
 * One finding as one line of text, for reports that carry text only (fast's pre-flight refusal).
 *
 * The hint and the other candidates go with it: they are the half that says what to write
 * instead -- javac's own candidate signature for an overload mismatch, reflection's closest
 * name for a missing one. fast used to keep only `what`, so「对于 buildJSON(String,List<List<String>>),
 * 找不到合适的方法」arrived without the line under it that javac had printed,
 *「方法 SendMesInfoBuilder.buildJSON(String,List<List<Object>>)不适用」, and the next round went
 * to javap to find out what that line had already said (真机 2026-10-09).
 */
export function findingLine(finding: Finding, root: string): string {
	const where = `${relative(root, finding.file)}:${finding.line}`;
	const parts = [`${where} ${finding.what}`];
	if (finding.hint !== "") parts.push(finding.hint);
	if (finding.extra.length > 0) parts.push(`其他候选：${finding.extra.join(" | ")}`);
	return parts.join(" —— ");
}

/** ApiTool suggest output: sections opened by `@@ <id>`, one candidate per line. */
export function parseSuggest(output: string): Map<string, string[]> {
	const map = new Map<string, string[]>();
	let current: string[] | null = null;
	for (const line of output.split("\n")) {
		const head = /^@@ (\S+)\s*$/.exec(line);
		if (head) {
			current = [];
			map.set(head[1] as string, current);
			continue;
		}
		if (current && line.trim()) current.push(line);
	}
	return map;
}

/** Merges suggest candidates into findings, matching the frozen reportDiags rules. */
export function applySuggestions(findings: readonly Finding[], suggestions: Map<string, string[]>): Finding[] {
	return findings.map((finding) => {
		const candidates = (finding.qid && suggestions.get(finding.qid)) || [];
		if (candidates.length === 0) return { ...finding };
		// A leading "!" marks "the owner class itself was not found", which replaces
		// the hint instead of being offered as a near-miss name.
		const ownerLost = (candidates[0] as string).startsWith("!");
		const rest = candidates.slice(ownerLost ? 1 : 0);
		if (ownerLost) return { ...finding, hint: (candidates[0] as string).slice(1).trim(), extra: rest };
		const best = rest.shift() ?? "";
		return { ...finding, hint: `最接近：${best.trim()}`, extra: rest };
	});
}
