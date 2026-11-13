import type { ReflectionPort } from "../kernel/api-tool.ts";
import { parseSuggest } from "../kernel/diag/javac.ts";
import { probeImports } from "../kernel/policy/api-precheck.ts";
import { blankJavaNoise, LITERAL_FILL } from "../kernel/policy/probe-scan.ts";
import { type ApiDoc, type ApiMethod, parseApiDoc } from "./api-doc.ts";
import { parseCandidateLine } from "./api-join.ts";
import { createKnowledgeCapsule, type KnowledgeCapsule, probeApiKnowledgeCapsules } from "./capsule.ts";
import { apiItems } from "./catalog.ts";
import type { KnowledgeBase } from "./docs.ts";

export type ProbeApiBlockerCode =
	| "PROBE_API_WILDCARD"
	| "PROBE_API_CLASS_MISSING"
	| "PROBE_API_METHOD_MISSING"
	| "PROBE_API_ARGUMENT_MISMATCH";

export interface ProbeApiBlocker {
	code: ProbeApiBlockerCode;
	message: string;
	remedy: string;
}

export interface ProbeApiPreflight {
	classes: string[];
	wildcards: string[];
	reflection: "not-needed" | "verified" | "unavailable";
	queries: number;
	blockers: ProbeApiBlocker[];
	warnings: string[];
	capsules: KnowledgeCapsule[];
}

interface ApiUse {
	id: string;
	fqcn: string;
	kind: "method" | "ctor";
	member: string;
	arity: number;
}

function simpleName(fqcn: string): string {
	return fqcn.slice(fqcn.lastIndexOf(".") + 1);
}

const OPENERS = new Set(["(", "[", "{"]);
const CLOSERS = new Set([")", "]", "}"]);

/**
 * Where the type-argument list opened by the `<` at `lt` closes, or null when
 * that `<` reads as a comparison.
 *
 * It is a type list when it follows a type name (`HashMap<`, capitalised) or a
 * dot (`Collections.<String>emptyList()`) and holds nothing but type
 * characters up to its balancing `>`. A capitalised constant compared across
 * two arguments (`f(MAX < a, b > MIN)`) reads wrong; javac still holds that
 * line, and it is far rarer than `new HashMap<String, Object>()`.
 */
function typeArgumentsEnd(source: string, lt: number): number | null {
	const before = source.slice(Math.max(0, lt - 256), lt).trimEnd();
	if (!before.endsWith(".") && !/(?:^|[^\w$])[A-Z][\w$]*$/.test(before)) return null;
	let depth = 0;
	for (let index = lt; index < source.length; index += 1) {
		const char = source[index] ?? "";
		if (char === "<") depth += 1;
		else if (char === ">") {
			depth -= 1;
			if (depth === 0) return index;
		} else if (!/[\w$\s.,?&[\]]/.test(char)) return null;
	}
	return null;
}

/**
 * How many arguments the call whose `(` sits at `open` passes, or -1 when that
 * cannot be read -- an unknown count skips the arity check rather than guess.
 *
 * Only a comma outside every nested bracket separates arguments, and braces,
 * square brackets and type arguments nest like parentheses. Counting commas
 * inside `(` alone read `DB.query(route, sql, new Object[]{a, b}, handler)` as
 * five arguments and refused it against the four-parameter overload the JAR has
 * (real session, 2026-09-11); the model's way out was hoisting the array into a
 * local, which is the check teaching it to write around the check.
 */
function countArguments(source: string, open: number): number {
	let depth = 0;
	let commas = 0;
	let content = false;
	for (let index = open + 1; index < source.length; index += 1) {
		const char = source[index] ?? "";
		if (char === "<") {
			const end = typeArgumentsEnd(source, index);
			if (end !== null) {
				index = end;
				content = true;
				continue;
			}
		}
		if (OPENERS.has(char)) {
			depth += 1;
			content = true;
			continue;
		}
		if (CLOSERS.has(char)) {
			if (depth === 0) {
				if (char !== ")") return -1;
				return content ? commas + 1 : 0;
			}
			depth -= 1;
			content = true;
			continue;
		}
		if (char === "," && depth === 0) {
			commas += 1;
			continue;
		}
		if (!/\s/.test(char ?? "")) content = true;
	}
	return -1;
}

function apiUses(sourceText: string, classes: readonly string[]): ApiUse[] {
	// LITERAL_FILL, not the default blanking: `getString("billno")` is a
	// one-argument call, and a literal blanked to spaces makes it read as zero.
	const source = blankJavaNoise(sourceText, LITERAL_FILL);
	const imports = new Map(classes.map((fqcn) => [simpleName(fqcn), fqcn]));
	const owners = new Map(imports);
	// 变量名 → 类型只有一张全文件的表，没有作用域。真机上（2026-09-17）探针里
	// 私有方法 `DataRowSet entry(...)` 和另一个方法的参数 `DynamicObject entry` 同名，
	// 旧写法把方法声明也当变量、后出现的覆盖先出现的，于是 `entry.get(...)` 被判成
	// 「DataRowSet 不存在 get」，挡住了一份 javac 能编过的探针，模型照候选改了三轮。
	// 所以：方法声明不算变量；同一个名字在文件里声明成不止一种类型时，不猜，不校验
	// —— 这道门猜错类型的报错比 javac 的报错更像权威，漏掉的交给 javac 兜底。
	const declaredTypes = new Map<string, Set<string>>();
	const anyDeclaration = /\b([A-Z][\w$]*)\s*(?:<[^;(){}]*>)?\s*(?:\[\s*\])*\s+([A-Za-z_$][\w$]*)\b(?!\s*\()/g;
	for (const match of source.matchAll(anyDeclaration)) {
		const type = match[1];
		const variable = match[2];
		if (type === undefined || variable === undefined) continue;
		const types = declaredTypes.get(variable) ?? new Set<string>();
		types.add(match[0].includes("<") || match[0].includes("[") ? `${type}<>` : type);
		declaredTypes.set(variable, types);
	}
	for (const [name, fqcn] of imports) {
		const declaration = new RegExp(`\\b${name}\\s+([A-Za-z_$][\\w$]*)\\b(?!\\s*\\()`, "g");
		for (const match of source.matchAll(declaration)) {
			const variable = match[1];
			if (variable === undefined) continue;
			const types = declaredTypes.get(variable);
			if (types !== undefined && types.size > 1) continue;
			owners.set(variable, fqcn);
		}
	}
	const uses: ApiUse[] = [];
	const seen = new Set<string>();
	const add = (fqcn: string, kind: ApiUse["kind"], member: string, open: number): void => {
		const arity = countArguments(source, open);
		const key = `${kind}:${fqcn}:${member}:${String(arity)}`;
		if (seen.has(key)) return;
		seen.add(key);
		uses.push({ id: `u${String(uses.length)}`, fqcn, kind, member, arity });
	};
	for (const [name, fqcn] of imports) {
		const ctor = new RegExp(`\\bnew\\s+${name}\\s*\\(`, "g");
		for (const match of source.matchAll(ctor))
			add(fqcn, "ctor", name, (match.index ?? 0) + match[0].lastIndexOf("("));
	}
	const staticImport = /^\s*import\s+static\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.([A-Za-z_$][\w$]*)\s*;/gm;
	for (const imported of source.matchAll(staticImport)) {
		const fqcn = imported[1];
		const member = imported[2];
		if (fqcn === undefined || member === undefined || !classes.includes(fqcn)) continue;
		const unqualified = new RegExp(`\\b${member}\\s*\\(`, "g");
		for (const match of source.matchAll(unqualified))
			add(fqcn, "method", member, (match.index ?? 0) + match[0].lastIndexOf("("));
	}
	const call = /\b([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g;
	for (const match of source.matchAll(call)) {
		const owner = match[1];
		const member = match[2];
		const fqcn = owner === undefined ? undefined : owners.get(owner);
		if (fqcn === undefined || member === undefined) continue;
		add(fqcn, "method", member, (match.index ?? 0) + match[0].lastIndexOf("("));
	}
	return uses;
}

/**
 * The owner column of a class query carries the FQCN, so ApiTool answers "is it
 * there" by loading it rather than by ranking simple-name matches. The ranked
 * scan keeps only five, and `LocaleString` alone has more than five same-name
 * classes in the bouncycastle jars that sort ahead of `kd.bos...` -- which is how
 * an import javac compiles was refused as 当前 JAR 不存在.
 */
function renderQueries(classes: readonly string[], uses: readonly ApiUse[]): string {
	const classQueries = classes.map((fqcn, index) => `c${String(index)}\tclass\t${fqcn}\t${simpleName(fqcn)}\t-1`);
	const useQueries = uses.map((use) => `${use.id}\t${use.kind}\t${use.fqcn}\t${use.member}\t${String(use.arity)}`);
	return [...classQueries, ...useQueries].join("\n");
}

/**
 * Whether a member query already proved the class loads.
 *
 * ApiTool loads a method/ctor query's owner by its full name and, only when that
 * fails, marks the answer with a leading `!类 … 本身就查不到`. An answer for this
 * owner without that mark is therefore reflection saying the class is there --
 * the same authority the class query asks, and one that an ApiTool compiled
 * before the class query learned to load by full name still gives.
 */
function ownerLoaded(fqcn: string, uses: readonly ApiUse[], answers: ReadonlyMap<string, readonly string[]>): boolean {
	return uses.some((use) => {
		if (use.fqcn !== fqcn) return false;
		const lines = answers.get(use.id);
		return lines !== undefined && !lines.some((line) => line.trim().startsWith("!"));
	});
}

function candidateArity(line: string): number | null {
	const parsed = parseCandidateLine(line);
	if (parsed !== null) return parsed.paramTypes.length;
	const ctor = /^\s*[A-Za-z_$][\w$]*\((.*?)\)/.exec(line);
	if (ctor === null) return null;
	const inside = (ctor[1] ?? "").trim();
	return inside === "" ? 0 : inside.split(",").length;
}

/**
 * Whether `arity` is a shape this candidate can actually be called with.
 *
 * Reflection erases varargs to an array, so `f(QFilter...)` comes back as
 * `f(QFilter[])` -- arity 1 -- and a correct three-argument call would read as a
 * mismatch. There is no way to tell an erased vararg from a real array
 * parameter, so a trailing array is treated as open-ended in the permissive
 * direction. javac still holds the line before the Cosmic JVM starts; refusing a
 * call that compiles costs a turn and teaches the model to distrust the check,
 * which is the more expensive error of the two.
 */
function callable(line: string, arity: number): boolean {
	const declared = candidateArity(line);
	if (declared === null) return false;
	if (declared === arity) return true;
	const last = parseCandidateLine(line)?.paramTypes.at(-1) ?? "";
	return last.endsWith("[]") && arity >= declared - 1;
}

function candidateMember(line: string): string | null {
	const parsed = parseCandidateLine(line);
	return parsed?.name ?? null;
}

function enrichCapsules(
	capsules: readonly KnowledgeCapsule[],
	classes: readonly string[],
	uses: readonly ApiUse[],
	answers: ReadonlyMap<string, readonly string[]>,
	warnings: readonly string[],
): KnowledgeCapsule[] {
	return capsules.flatMap((capsule, index) => {
		const fqcn = classes[index];
		if (fqcn === undefined) return [];
		const signatures = uses
			.filter((use) => use.fqcn === fqcn)
			.flatMap((use) => answers.get(use.id) ?? [])
			.filter((line) => !line.trim().startsWith("!"))
			.map((line) => line.trim())
			.slice(0, 8);
		const relevantWarnings = warnings.filter((warning) => warning.includes(fqcn));
		// 没有反射出的签名、也没有关于它的警告：卡片只剩"精确 import"一句，不推空卡
		if (signatures.length === 0 && relevantWarnings.length === 0) return [];
		return createKnowledgeCapsule({
			subject: capsule.subject,
			kind: capsule.kind,
			runtimeKeyId: capsule.runtimeKeyId,
			must: [...capsule.must, ...relevantWarnings],
			avoid: capsule.avoid,
			signatures: [...signatures, ...capsule.signatures],
			verificationRoute: capsule.verificationRoute,
			sourceRefs: [...capsule.sourceRefs, `runtime:${capsule.runtimeKeyId ?? "none"}:${fqcn}`],
			confidence: signatures.length > 0 && relevantWarnings.length === 0 ? "exact" : capsule.confidence,
		});
	});
}

/**
 * One deterministic doc/JAR join for every exact kd.* import in an ad-hoc probe.
 * `ReflectionPort.batch` is one ApiTool process regardless of import count.
 */
export async function prepareProbeApis(
	base: KnowledgeBase,
	file: string,
	sourceText: string,
	runtimeKeyId: string | null,
	reflect: ReflectionPort,
): Promise<ProbeApiPreflight> {
	const imports = probeImports(sourceText);
	const blockers: ProbeApiBlocker[] = imports.wildcards.map((wildcard) => ({
		code: "PROBE_API_WILDCARD",
		message: `通配 import 无法确定依赖集合：${wildcard}`,
		remedy: `把 ${wildcard} 换成实际使用的具体类名。`,
	}));
	const initialCapsules = probeApiKnowledgeCapsules(base, file, sourceText, runtimeKeyId);
	if (imports.classes.length === 0) {
		return {
			classes: [],
			wildcards: imports.wildcards,
			reflection: "not-needed",
			queries: 0,
			blockers,
			warnings: [],
			capsules: initialCapsules,
		};
	}
	const uses = apiUses(sourceText, imports.classes);
	const output = await reflect.batch(renderQueries(imports.classes, uses));
	if (output === null) {
		return {
			classes: imports.classes,
			wildcards: imports.wildcards,
			reflection: "unavailable",
			queries: imports.classes.length + uses.length,
			blockers,
			warnings: ["当前 JAR 批量反射不可用；仍会在启动 Cosmic JVM 前由 javac 校验类、方法和参数。"],
			// 反射不可用就没有签名可补，卡片只剩"精确 import"一句，不推
			capsules: [],
		};
	}
	const answers = parseSuggest(output);
	imports.classes.forEach((fqcn, index) => {
		const candidates = answers.get(`c${String(index)}`) ?? [];
		if (!candidates.some((line) => line.trim().startsWith(`${fqcn} `)) && !ownerLoaded(fqcn, uses, answers)) {
			blockers.push({
				code: "PROBE_API_CLASS_MISSING",
				message: `当前 JAR 不存在 ${fqcn}`,
				remedy: candidates.length === 0 ? "用具体类名替换该 import。" : `候选：${candidates.join("；")}`,
			});
		}
	});
	const warnings: string[] = [];
	// 只读探针真用到的那几个类的文档；整库一千多篇逐篇解析一遍，用得上的只有这几篇。
	const docPaths = new Map(apiItems(base).flatMap((item) => (item.fqcn === undefined ? [] : [[item.fqcn, item]])));
	const docs = new Map<string, ApiDoc>();
	for (const fqcn of new Set(uses.map((use) => use.fqcn))) {
		const item = docPaths.get(fqcn);
		if (item === undefined) continue;
		const doc = parseApiDoc(item.relativePath, base.read(item.relativePath) ?? "").doc;
		if (doc !== null) docs.set(fqcn, doc);
	}
	for (const use of uses) {
		const candidates = (answers.get(use.id) ?? []).filter((line) => !line.trim().startsWith("!"));
		const sameName =
			use.kind === "ctor" ? candidates : candidates.filter((line) => candidateMember(line) === use.member);
		if (sameName.length === 0) {
			blockers.push({
				code: "PROBE_API_METHOD_MISSING",
				message: `${use.fqcn} 不存在 ${use.member}(...)`,
				remedy: candidates.length === 0 ? "按当前 JAR 的真实 API 改方法名。" : `候选：${candidates.join("；")}`,
			});
			continue;
		}
		if (use.arity >= 0 && !sameName.some((line) => callable(line, use.arity))) {
			blockers.push({
				code: "PROBE_API_ARGUMENT_MISMATCH",
				message: `${use.fqcn}.${use.member} 没有 ${String(use.arity)} 个参数的重载`,
				remedy: `当前 JAR 候选：${sameName.join("；")}`,
			});
		}
		const documented = docs.get(use.fqcn)?.methods.filter((method) => method.name === use.member) ?? [];
		// Same varargs allowance as `callable`. A document writes `f(QFilter...)`
		// where reflection erases to `f(QFilter[])`, so both spellings count.
		const documentedShape = (method: ApiMethod): boolean => {
			if (method.params.length === use.arity) return true;
			const last = method.paramTypes.at(-1) ?? "";
			return (last.endsWith("...") || last.endsWith("[]")) && use.arity >= method.params.length - 1;
		};
		if (documented.length > 0 && !documented.some(documentedShape)) {
			warnings.push(`${use.fqcn}#${use.member} 的官方文档参数形状与当前 JAR 候选不一致，以 JAR 为准。`);
		}
	}
	return {
		classes: imports.classes,
		wildcards: imports.wildcards,
		reflection: "verified",
		queries: imports.classes.length + uses.length,
		blockers,
		warnings,
		capsules: enrichCapsules(initialCapsules, imports.classes, uses, answers, warnings),
	};
}
