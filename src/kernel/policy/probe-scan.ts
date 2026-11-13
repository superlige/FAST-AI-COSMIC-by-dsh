/**
 * Source scan for ad-hoc probes (the read-only capability).
 *
 * A released probe is reviewed code and is never scanned. Anything else that
 * wants into the Cosmic JVM passes through here first, and the rule is one line:
 * it may read, it may not write, and it may not acquire a capability that would
 * let it reach a writer this scanner cannot see.
 *
 * Comments and string literals are blanked before matching. Both directions
 * matter: a probe that documents "不要用 SaveServiceHelper" must not be refused
 * for saying so, and a name hidden inside a string is only reachable through
 * reflection, which is refused on its own.
 */

import { AD_HOC_FORBIDDEN, type ForbiddenApi, READ_ONLY_TYPES, type ReadOnlyType } from "./write-apis.ts";

export interface ScanHit {
	what: string;
	why: string;
	/** 1-based line the match was found on. */
	line: number;
}

/**
 * A stand-in for a literal's contents that is not itself whitespace.
 *
 * The scans below want a literal to disappear: a name written inside a string is
 * only reachable through reflection, which is refused on its own. An arity count
 * wants the opposite -- `getString("billno")` has one argument, and blanking the
 * literal to spaces makes the parentheses look empty, which is how a correct
 * one-argument call got refused as "没有 0 个参数的重载". Both readings are of
 * the same source, so the difference is one character: whitespace erases, this
 * one fills.
 *
 * Deliberately neither an identifier character nor whitespace, so no
 * `\b<name>\b` pattern can match across it and no "are these parens empty" test
 * can be fooled by it.
 */
export const LITERAL_FILL = "~";

/**
 * Replaces the contents of comments and string/char literals with spaces,
 * preserving every newline so line numbers survive.
 *
 * `fill` replaces the literal's own characters, quotes included. Comments are
 * always spaces regardless: a comment is absent, a literal is merely opaque.
 * See `LITERAL_FILL` for the one caller that needs the difference.
 */
export function blankJavaNoise(source: string, fill = " "): string {
	const out: string[] = [];
	let mode: "code" | "line" | "block" | "string" | "char" = "code";
	for (let i = 0; i < source.length; i++) {
		const ch = source[i] as string;
		const next = source[i + 1];
		const keep = ch === "\n" ? "\n" : mode === "string" || mode === "char" ? fill : " ";
		if (mode === "code") {
			if (ch === "/" && next === "/") {
				mode = "line";
				out.push("  ");
				i++;
			} else if (ch === "/" && next === "*") {
				mode = "block";
				out.push("  ");
				i++;
			} else if (ch === '"') {
				mode = "string";
				out.push(fill);
			} else if (ch === "'") {
				mode = "char";
				out.push(fill);
			} else {
				out.push(ch);
			}
			continue;
		}
		if (mode === "line") {
			if (ch === "\n") mode = "code";
			out.push(keep);
			continue;
		}
		if (mode === "block") {
			if (ch === "*" && next === "/") {
				mode = "code";
				out.push("  ");
				i++;
				continue;
			}
			out.push(keep);
			continue;
		}
		// string / char: a backslash escapes the next character, including a quote.
		if (ch === "\\") {
			out.push(fill, next === "\n" ? "\n" : fill);
			i++;
			continue;
		}
		if ((mode === "string" && ch === '"') || (mode === "char" && ch === "'")) {
			mode = "code";
			out.push(fill);
			continue;
		}
		out.push(keep);
	}
	return out.join("");
}

const IDENT = "[A-Za-z_$][\\w$]*";

/**
 * The names a receiver of `type` can be reached by in this source.
 *
 * Local declarations (`PrintTplService service = …`), parameters
 * (`void f(PrintTplService service)`) and fields all have the same written
 * shape -- the type name followed by an identifier -- so one pattern finds all
 * three. `new PrintTplService()` in a chained call has no name at all and is
 * handled separately by the caller, together with the static form.
 */
function receiversOf(source: string, type: string): string[] {
	const found = new Set<string>();
	const declaration = new RegExp(`\\b${type}\\s+(${IDENT})\\b`, "g");
	for (const match of source.matchAll(declaration)) found.add(match[1] as string);
	return [...found];
}

/**
 * Calls made through a read-only type that are not on its read list.
 *
 * Every shape has to name the type or a receiver of it: through a declared name
 * (`service.updatePrintMeta(…)`), through an inline constructor
 * (`new PrintTplService().updatePrintMeta(…)`), statically
 * (`PrintTplService.updatePrintMeta(…)`), as a method reference, or through a
 * static import. What makes those exhaustive is
 * group 2 of the blacklist: without reflection, a classloader or a script
 * engine there is no fourth way to reach a method.
 *
 * Reported one hit per type, like the rule scan, and the method that caused it
 * goes in `what` -- "PrintTplService" alone would say the class is banned, which
 * is the thing this carve-out exists to stop saying.
 */
export function scanReadOnlyTypes(source: string, types: readonly ReadOnlyType[] = READ_ONLY_TYPES): ScanHit[] {
	const lines = blankJavaNoise(source).split("\n");
	const body = lines.join("\n");
	const hits: ScanHit[] = [];
	for (const entry of types) {
		if (!new RegExp(`\\b${entry.type}\\b`).test(body)) continue;
		const reads = new Set(entry.reads);
		const callers = [...receiversOf(body, entry.type), entry.type];
		// A class of static methods (WorkflowServiceHelper) has two more ways to reach
		// a method without a call shape on the type: a static import, after which the
		// call is bare (`completeTask(…)`), and a method reference. Both still name the
		// type, so both are checked here; a wildcard static import imports every
		// method and is reported as `*`.
		const shapes = [
			...callers.map((name) => new RegExp(`\\b${name}\\s*\\.\\s*(${IDENT})\\s*\\(`, "g")),
			...callers.map((name) => new RegExp(`\\b${name}\\s*::\\s*(${IDENT})`, "g")),
			new RegExp(`\\bnew\\s+${entry.type}\\s*\\([^)]*\\)\\s*\\.\\s*(${IDENT})\\s*\\(`, "g"),
			new RegExp(`\\bimport\\s+static\\s+(?:${IDENT}\\s*\\.\\s*)*${entry.type}\\s*\\.\\s*(${IDENT}|\\*)`, "g"),
		];
		let reported = false;
		for (let i = 0; i < lines.length && !reported; i++) {
			for (const shape of shapes) {
				shape.lastIndex = 0;
				for (const match of (lines[i] as string).matchAll(shape)) {
					const method = match[1] as string;
					if (reads.has(method)) continue;
					hits.push({ what: `${entry.what}.${method}`, why: entry.why, line: i + 1 });
					reported = true;
					break;
				}
				if (reported) break;
			}
		}
	}
	return hits;
}

/** Every forbidden API the source names, with the line each was found on. */
export function scanAdHocProbe(
	source: string,
	rules: readonly ForbiddenApi[] = AD_HOC_FORBIDDEN,
	types: readonly ReadOnlyType[] = READ_ONLY_TYPES,
): ScanHit[] {
	const lines = blankJavaNoise(source).split("\n");
	const hits: ScanHit[] = [];
	for (const rule of rules) {
		for (let i = 0; i < lines.length; i++) {
			if (rule.pattern.test(lines[i] as string)) {
				hits.push({ what: rule.what, why: rule.why, line: i + 1 });
				break; // One hit per rule: a list of 30 lines for one mistake buries the others.
			}
		}
	}
	// Appended rather than merged, minus the overlap. `service.updatePrintMeta(…)`
	// is seen by both halves -- the call-shape rule in group 1 and the receiver
	// scan here -- and reporting one mistake twice under two reasons reads as two
	// mistakes. The rule wins the tie because it is the one whose `sample` the
	// bypass matrix proves reachable.
	for (const hit of scanReadOnlyTypes(source, types)) {
		const type = hit.what.slice(0, hit.what.lastIndexOf("."));
		if (!hits.some((seen) => seen.what === type)) hits.push(hit);
	}
	return hits;
}
