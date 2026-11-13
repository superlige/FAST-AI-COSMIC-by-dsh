/**
 * Offline diff for two metadata export directories (S5.4).
 *
 * `meta … diff` is the one action in the family that never starts a JVM: it
 * compares two directories a previous `backup` / `dump` produced. Ported from
 * the frozen tools/metacmd.mjs unchanged in behaviour; the only differences are
 * that it returns values instead of printing, and that the formatters are kept
 * separate from the comparison so the caller can render either.
 *
 * Two invariants worth not losing:
 *   - text diff trims the shared head and tail before running LCS over the
 *     middle, and gives up on a middle longer than `cap` rather than letting an
 *     O(n x m) table stall on a 50k-line export;
 *   - design diff aligns arrays by the id/key INSIDE each element, not by index.
 *     Inserting one control shifts every later index, and an index-aligned
 *     comparison reports "several dozen controls changed" while hiding the one
 *     that did.
 */

export interface TextHunk {
	line: number;
	removed: string[];
	added: string[];
}

export interface BigHunk {
	line: number;
	removed: number;
	added: number;
	big: true;
}

export type Hunk = TextHunk | BigHunk;

export function isBigHunk(hunk: Hunk): hunk is BigHunk {
	return (hunk as BigHunk).big === true;
}

/** Line-level diff. Shared head/tail are trimmed first; the middle gets an LCS. */
export function diffLines(a: string, b: string, cap = 4000): Hunk[] {
	const x = a.split(/\r?\n/);
	const y = b.split(/\r?\n/);
	let head = 0;
	while (head < x.length && head < y.length && x[head] === y[head]) head++;
	let tail = 0;
	while (tail < x.length - head && tail < y.length - head && x[x.length - 1 - tail] === y[y.length - 1 - tail]) {
		tail++;
	}
	const mx = x.slice(head, x.length - tail);
	const my = y.slice(head, y.length - tail);
	if (mx.length === 0 && my.length === 0) return [];
	if (mx.length > cap || my.length > cap) {
		return [{ line: head + 1, removed: mx.length, added: my.length, big: true }];
	}
	const dp: Uint32Array[] = [];
	for (let i = 0; i <= mx.length; i++) dp.push(new Uint32Array(my.length + 1));
	for (let i = mx.length - 1; i >= 0; i--) {
		const row = dp[i] as Uint32Array;
		const nextRow = dp[i + 1] as Uint32Array;
		for (let j = my.length - 1; j >= 0; j--) {
			row[j] =
				mx[i] === my[j] ? (nextRow[j + 1] as number) + 1 : Math.max(nextRow[j] as number, row[j + 1] as number);
		}
	}
	const hunks: Hunk[] = [];
	let i = 0;
	let j = 0;
	let cur: TextHunk | null = null;
	while (i < mx.length || j < my.length) {
		if (i < mx.length && j < my.length && mx[i] === my[j]) {
			cur = null;
			i++;
			j++;
			continue;
		}
		if (cur === null) {
			cur = { line: head + i + 1, removed: [], added: [] };
			hunks.push(cur);
		}
		const nextRow = dp[i + 1] as Uint32Array | undefined;
		const row = dp[i] as Uint32Array;
		if (j >= my.length || (i < mx.length && (nextRow?.[j] ?? 0) >= (row[j + 1] as number))) {
			cur.removed.push(mx[i++] as string);
		} else {
			cur.added.push(my[j++] as string);
		}
	}
	return hunks;
}

// -------------------------------------------------- design JSON, aligned by id

const ID_KEYS = ["id", "Id", "ID", "key", "Key"] as const;

type Json = unknown;

function asRecord(node: Json): Record<string, Json> | null {
	if (node === null || typeof node !== "object" || Array.isArray(node)) return null;
	return node as Record<string, Json>;
}

function idOf(node: Json): string | null {
	const record = asRecord(node);
	if (record === null) return null;
	for (const key of ID_KEYS) {
		const value = record[key];
		if ((typeof value === "string" && value !== "") || typeof value === "number") return `${key}=${String(value)}`;
	}
	return null;
}

/** Control identity: without it a long path says nothing about WHICH control moved. */
function labelOf(node: Json): string | null {
	const record = asRecord(node);
	if (record === null) return null;
	const id = record.id ?? record.Id;
	const key = record.key ?? record.Key;
	const type = record.type ?? record.Type ?? record.ControlType;
	if (id === undefined && key === undefined) return null;
	const name = String(key ?? id);
	return `${name}${type === undefined ? "" : `(${String(type)})`}`;
}

export interface DesignChange {
	path: string;
	owner: string | null;
	from: string;
	to: string;
}

/**
 * Structural diff. Two rules that must not drift:
 *   - arrays align by the id/key inside each element, never by index;
 *   - only leaf value changes and whole-branch add/remove are reported. A new
 *     branch is one line, not one line per field underneath it.
 */
export function diffDesign(a: Json, b: Json): DesignChange[] {
	const out: DesignChange[] = [];
	walk(a, b, "", null, out);
	return out;
}

function kindOf(value: Json): "array" | "object" | "scalar" {
	if (Array.isArray(value)) return "array";
	if (value !== null && typeof value === "object") return "object";
	return "scalar";
}

function brief(value: Json): string {
	if (value === undefined) return "(无)";
	if (value === null) return "null";
	if (typeof value !== "object") return String(value);
	const text = JSON.stringify(value) ?? "";
	return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

function walk(a: Json, b: Json, path: string, owner: string | null, out: DesignChange[]): void {
	if (a === b) return;
	const label = labelOf(a) ?? labelOf(b) ?? owner;
	const ta = kindOf(a);
	const tb = kindOf(b);
	if (ta !== tb) {
		out.push({ path, owner: label, from: brief(a), to: brief(b) });
		return;
	}
	if (ta === "array") {
		walkArray(a as Json[], b as Json[], path, label, out);
		return;
	}
	if (ta === "object") {
		const ra = a as Record<string, Json>;
		const rb = b as Record<string, Json>;
		for (const key of Object.keys(ra)) {
			if (key in rb) walk(ra[key], rb[key], `${path}.${key}`, label, out);
			else out.push({ path: `${path}.${key}`, owner: label, from: brief(ra[key]), to: "(删除)" });
		}
		for (const key of Object.keys(rb)) {
			if (!(key in ra)) out.push({ path: `${path}.${key}`, owner: label, from: "(无)", to: brief(rb[key]) });
		}
		return;
	}
	out.push({ path, owner: label, from: brief(a), to: brief(b) });
}

function walkArray(a: Json[], b: Json[], path: string, label: string | null, out: DesignChange[]): void {
	const ka = a.map(idOf);
	const kb = b.map(idOf);
	const keyed =
		ka.length > 0 &&
		kb.length > 0 &&
		ka.every((key): key is string => key !== null) &&
		kb.every((key): key is string => key !== null) &&
		new Set(ka).size === ka.length &&
		new Set(kb).size === kb.length;
	if (keyed) {
		const byKey = new Map(b.map((value, index) => [kb[index] as string, value]));
		a.forEach((value, index) => {
			const key = ka[index] as string;
			const other = byKey.get(key);
			if (other !== undefined) walk(value, other, `${path}[${key}]`, labelOf(value) ?? label, out);
			else out.push({ path: `${path}[${key}]`, owner: labelOf(value) ?? label, from: brief(value), to: "(删除)" });
		});
		const seen = new Set(ka);
		b.forEach((value, index) => {
			const key = kb[index] as string;
			if (!seen.has(key)) {
				out.push({ path: `${path}[${key}]`, owner: labelOf(value) ?? label, from: "(无)", to: brief(value) });
			}
		});
		return;
	}
	const n = Math.max(a.length, b.length);
	for (let i = 0; i < n; i++) {
		if (i >= a.length) out.push({ path: `${path}[${i}]`, owner: label, from: "(无)", to: brief(b[i]) });
		else if (i >= b.length) out.push({ path: `${path}[${i}]`, owner: label, from: brief(a[i]), to: "(删除)" });
		else walk(a[i], b[i], `${path}[${i}]`, label, out);
	}
}

// --------------------------------------------------------------------- output

export function formatTextDiff(name: string, hunks: readonly Hunk[], limit = 40): string[] {
	if (hunks.length === 0) return [`  ${name}  一致`];
	const lines = [`  ${name}  ${hunks.length} 处`];
	for (const hunk of hunks.slice(0, limit)) {
		if (isBigHunk(hunk)) {
			lines.push(`    第 ${hunk.line} 行起：-${hunk.removed} 行 / +${hunk.added} 行（差异太大，没逐行比）`);
			continue;
		}
		lines.push(`    第 ${hunk.line} 行`);
		for (const removed of hunk.removed.slice(0, 6)) lines.push(`      - ${removed.trim()}`);
		for (const added of hunk.added.slice(0, 6)) lines.push(`      + ${added.trim()}`);
	}
	if (hunks.length > limit) lines.push(`    …还有 ${hunks.length - limit} 处`);
	return lines;
}

export function formatDesignDiff(name: string, changes: readonly DesignChange[], limit = 60): string[] {
	if (changes.length === 0) return [`  ${name}  一致`];
	const lines = [`  ${name}  ${changes.length} 处`];
	for (const change of changes.slice(0, limit)) {
		lines.push(`    ${change.owner ? `${change.owner} ` : ""}${change.path || "(根)"}`);
		lines.push(`      ${change.from}  →  ${change.to}`);
	}
	if (changes.length > limit) lines.push(`    …还有 ${changes.length - limit} 处`);
	return lines;
}

/** Pairs two directory listings by file name. */
export function pairNames(
	a: readonly string[],
	b: readonly string[],
): { both: string[]; onlyA: string[]; onlyB: string[] } {
	const sa = new Set(a);
	const sb = new Set(b);
	return {
		both: a.filter((name) => sb.has(name)).sort(),
		onlyA: a.filter((name) => !sb.has(name)).sort(),
		onlyB: b.filter((name) => !sa.has(name)).sort(),
	};
}
