/**
 * monitor 日志行 → 给模型看的视图。
 *
 * 原样发回去不行：500 条报错日志 5.8 MB；正文是网页转义过的（&#39; &quot; &#x2f;）；同一个错一小时报几百次；
 * 一大半「ERROR」其实是慢 SQL 记录（SlowLogger 为了带出调用位置故意构造了一个异常，不是报错）。
 * 所以这里：还原转义 → 正文和续行（message2）拼回一段 → 按种类分 → 同一个错合成一组报次数和时间范围 →
 * 每组只给异常标题和本工程的调用行，并把调用行对到本地源码：哪个文件第几行、那一行写的是什么、
 * 方法名对不对得上、这个文件在生产版本之后改过没有。全文另存，要看再读。
 */
import { decodeEntities } from "./meta-xml.ts";
import type { MonitorRow } from "./monitor.ts";

export type LogKind = "异常" | "界面报错" | "慢SQL" | "其他";

export interface Frame {
	className: string;
	method: string;
	file: string;
	line: number | null;
	raw: string;
}

export interface SourceHit {
	/** 工程里的相对路径 */
	path: string;
	lines: readonly string[];
	/** 生产版本（基线提交）之后改过，或还没提交 */
	changedSinceBaseline: boolean;
}

/** 认得本地源码的那一方：按全限定类名和堆栈里的文件名找，找不到给 null */
export type SourceLookup = (className: string, fileName: string) => SourceHit | null;

export interface MappedFrame extends Frame {
	where: "本工程" | "像本ISV但不在本工程" | "平台或三方";
	path?: string;
	code?: string;
	/** 那一行所在的方法名和堆栈里的不一致：源码和生产不是一个版本 */
	methodMismatch?: string;
	changedSinceBaseline?: boolean;
}

export interface LogEntry {
	kind: LogKind;
	time: string;
	level: string;
	at: string;
	tags: Record<string, string>;
	text: string;
	headline: string;
	frames: MappedFrame[];
}

export interface LogGroup {
	key: string;
	kind: LogKind;
	count: number;
	first: string;
	last: string;
	traceIds: string[];
	sample: LogEntry;
}

const FRAME = /^\s*at\s+([\w$.]+)\.([\w$<>]+)\(([^:)]*)(?::(\d+))?\)/;

export function rowText(row: MonitorRow): string {
	return decodeEntities(`${String(row.message ?? "")}${String(row.message2 ?? "")}`).replace(/\r\n/g, "\n");
}

export function parseFrames(text: string): Frame[] {
	const frames: Frame[] = [];
	for (const line of text.split("\n")) {
		const m = FRAME.exec(line);
		if (m === null) continue;
		frames.push({
			className: m[1] as string,
			method: m[2] as string,
			file: m[3] as string,
			line: m[4] === undefined ? null : Number.parseInt(m[4], 10),
			raw: line.trim(),
		});
	}
	return frames;
}

export function kindOf(row: MonitorRow, text: string): LogKind {
	const cls = String(row.className ?? "");
	if (cls === "kd.bos.slowlog.SlowLogger" || text.startsWith("SlowLogger")) return "慢SQL";
	if (cls === "kd.bos.form.log.FormBehaviorErrorReporter") return "界面报错";
	if (/\n\s*at\s+[\w$.]+\(/.test(text) || /Exception|Error:/.test(text.split("\n")[0] ?? "")) return "异常";
	return "其他";
}

/** 异常标题：不是「at …」、不是「... N more」的那些行，取前三行 */
export function headlineOf(text: string, kind: LogKind): string {
	if (kind === "界面报错") {
		const title = /errTitle：'([^']*)'/.exec(text)?.[1] ?? "";
		const content = /errContent：'([^']*)'/.exec(text)?.[1] ?? "";
		const op = /op：'([^']*)'/.exec(text)?.[1] ?? "";
		return [op && `操作 ${op}`, title, content].filter((s) => s !== "").join("｜") || text.slice(0, 200);
	}
	if (kind === "慢SQL") return (text.split("\n")[0] ?? "").slice(0, 160);
	const lines = text
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l !== "" && !l.startsWith("at ") && !/^\.\.\. \d+ more/.test(l));
	return lines
		.slice(0, 3)
		.map((l) => (l.length > 300 ? `${l.slice(0, 300)}…` : l))
		.join(" ⏎ ");
}

/** 往上找第一行方法声明，取方法名。找不到给 null（不硬判） */
export function enclosingMethod(lines: readonly string[], lineNo: number): string | null {
	const declaration =
		/^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|protected|private|static|final|synchronized|abstract|native|default)\s+)*(?:<[^>]+>\s+)?[\w$.<>[\],?\s]+?\s+([\w$]+)\s*\([^;]*$/;
	const control = new Set(["if", "for", "while", "switch", "catch", "synchronized", "return", "new", "else", "try"]);
	for (let i = Math.min(lineNo, lines.length) - 1; i >= 0; i--) {
		const text = lines[i] ?? "";
		const m = declaration.exec(text);
		if (m === null) continue;
		const name = m[1] as string;
		if (control.has(name)) continue;
		if (/=\s*[^=]/.test(text.split("(")[0] ?? "")) continue;
		return name;
	}
	return null;
}

export function mapFrames(frames: readonly Frame[], lookup: SourceLookup, isv: string): MappedFrame[] {
	const ownPrefix = new RegExp(`(^|\\.)${isv.replace(/[^\w]/g, "")}\\.`);
	return frames.map((frame) => {
		const hit = lookup(frame.className, frame.file);
		if (hit === null) {
			return {
				...frame,
				where: isv !== "" && ownPrefix.test(frame.className) ? "像本ISV但不在本工程" : "平台或三方",
			};
		}
		const mapped: MappedFrame = {
			...frame,
			where: "本工程",
			path: hit.path,
			changedSinceBaseline: hit.changedSinceBaseline,
		};
		if (frame.line !== null) {
			const code = hit.lines[frame.line - 1];
			mapped.code = code === undefined ? `(本地文件只有 ${String(hit.lines.length)} 行)` : code.trim();
			const simple = frame.method;
			if (!simple.startsWith("lambda$") && !simple.startsWith("<") && !simple.startsWith("access$")) {
				const found = enclosingMethod(hit.lines, frame.line);
				if (found !== null && found !== simple && code !== undefined) mapped.methodMismatch = found;
			}
		}
		return mapped;
	});
}

export function toEntry(row: MonitorRow, lookup: SourceLookup, isv: string): LogEntry {
	const text = rowText(row);
	const kind = kindOf(row, text);
	return {
		kind,
		time: String(row.time ?? row["@timestamp"] ?? ""),
		level: String(row.level ?? ""),
		at: `${String(row.className ?? "")}.${String(row.methodName ?? "")}:${String(row.line ?? "")}`,
		tags: Object.fromEntries(
			Object.entries(row.logtags ?? {}).filter(([, v]) => typeof v === "string" && v !== "") as [string, string][],
		),
		text,
		headline: headlineOf(text, kind),
		frames: mapFrames(parseFrames(text), lookup, isv),
	};
}

/** 同一个错合成一组：种类 + 记日志的位置 + 标题（去掉数字和编号） + 本工程调用行 */
export function groupEntries(entries: readonly LogEntry[]): LogGroup[] {
	const groups = new Map<string, LogGroup>();
	for (const e of entries) {
		const own = e.frames
			.filter((f) => f.where !== "平台或三方")
			.map((f) => `${f.className}.${f.method}:${String(f.line)}`);
		const key = [e.kind, e.at, e.headline.replace(/\d+/g, "#").slice(0, 160), ...own.slice(0, 3)].join("|");
		const group = groups.get(key);
		const traceId = e.tags.traceId ?? "";
		if (group === undefined) {
			groups.set(key, {
				key,
				kind: e.kind,
				count: 1,
				first: e.time,
				last: e.time,
				traceIds: traceId ? [traceId] : [],
				sample: e,
			});
			continue;
		}
		group.count++;
		if (e.time < group.first) group.first = e.time;
		if (e.time > group.last) group.last = e.time;
		if (traceId && group.traceIds.length < 3 && !group.traceIds.includes(traceId)) group.traceIds.push(traceId);
	}
	const rank = (g: LogGroup): number =>
		(g.sample.frames.some((f) => f.where === "本工程")
			? 0
			: g.sample.frames.some((f) => f.where !== "平台或三方")
				? 1
				: 2) *
			10 +
		["异常", "界面报错", "其他", "慢SQL"].indexOf(g.kind);
	return [...groups.values()].sort((a, b) => rank(a) - rank(b) || b.count - a.count);
}

function frameLine(f: MappedFrame): string {
	if (f.where === "本工程") {
		const flags = [
			f.changedSinceBaseline ? "⚠ 这个文件在生产版本之后改过，行号可能对不上" : "",
			f.methodMismatch
				? `⚠ 本地第 ${String(f.line)} 行在方法 ${f.methodMismatch} 里，不是 ${f.method}：源码和生产不是一个版本`
				: "",
		].filter((s) => s !== "");
		return `    ${f.raw}\n      → ${f.path}:${String(f.line)}  ${f.code ?? ""}${flags.length > 0 ? `\n      ${flags.join("；")}` : ""}`;
	}
	if (f.where === "像本ISV但不在本工程") return `    ${f.raw}  （像本 ISV 的代码，但不在本工程源码里）`;
	return `    ${f.raw}`;
}

const TAG_ORDER = ["traceId", "formId", "opKey", "opMethod", "userName", "orgId"];

export function renderGroup(g: LogGroup, index: number, full: boolean): string {
	const e = g.sample;
	const tags = TAG_ORDER.filter((k) => e.tags[k]).map((k) => `${k}=${e.tags[k]}`);
	const times = g.count === 1 ? e.time : `${String(g.count)} 次，${g.first} ~ ${g.last}`;
	const lines = [`[${String(index + 1)}] ${g.kind} ${times}  ${e.at}`, `    ${tags.join(" ")}`, `    ${e.headline}`];
	const frames = full ? e.frames : e.frames.filter((f) => f.where !== "平台或三方");
	const shown = full ? frames : frames.slice(0, 6);
	for (const f of shown) lines.push(frameLine(f));
	if (!full) {
		if (frames.length > shown.length)
			lines.push(`    …本工程/本 ISV 调用行另有 ${String(frames.length - shown.length)} 行`);
		const top = e.frames[0];
		if (top !== undefined && top.where === "平台或三方" && e.kind === "异常") lines.push(`    抛出处：${top.raw}`);
	}
	if (g.traceIds.length > 1) lines.push(`    同组其他 traceId：${g.traceIds.slice(1).join(" ")}`);
	if (full) lines.push("    ---- 原文 ----", ...e.text.split("\n").map((l) => `    ${l}`));
	return lines.join("\n");
}

export interface LogView {
	total: number;
	byKind: Record<LogKind, number>;
	groups: LogGroup[];
}

export function buildLogView(rows: readonly MonitorRow[], lookup: SourceLookup, isv: string): LogView {
	const entries = rows.map((row) => toEntry(row, lookup, isv));
	const byKind: Record<LogKind, number> = { 异常: 0, 界面报错: 0, 慢SQL: 0, 其他: 0 };
	for (const e of entries) byKind[e.kind]++;
	return { total: entries.length, byKind, groups: groupEntries(entries) };
}

/** 给模型的那份最多列几组；其余进全文 */
export const GROUPS_SHOWN = 15;

export function renderLogView(view: LogView, full: boolean): string {
	const counts = (Object.keys(view.byKind) as LogKind[]).map((k) => `${k} ${String(view.byKind[k])}`).join("，");
	const groups = full ? view.groups : view.groups.slice(0, GROUPS_SHOWN);
	const lines = [
		`共 ${String(view.total)} 条（${counts}），合成 ${String(view.groups.length)} 组；带本工程代码的排在前面，慢SQL 排最后（慢SQL 是平台的慢查询记录，不是报错）。`,
		...groups.map((g, i) => renderGroup(g, i, full)),
	];
	if (!full && view.groups.length > groups.length)
		lines.push(`…另有 ${String(view.groups.length - groups.length)} 组见全文`);
	return lines.join("\n");
}
