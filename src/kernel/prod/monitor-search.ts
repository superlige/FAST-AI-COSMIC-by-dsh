/**
 * 按 monitor 后台的真实脾气查日志：把时间段切成它肯查的几段，按从新到旧逐段取，照实报查了哪几段、丢了什么。
 *
 * 真机实测（GaussDB 部署的 monitor，2026-11-11）：
 *   - 日志只留 7 天：今天和前 6 个自然日（东八区），更早的查了也是 0 条；
 *   - 一次查询只覆盖「结束时间那天往前 5 个自然日」（含结束那天），更早的天被**静默**丢掉，不报错——
 *     查 11-05 ~ 11-11 只回来 11-07 以后的；所以长时间段必须在这边切段；
 *   - 结果按时间从新到旧排，条数到了上限时丢的是最早的那些；
 *   - 偶尔一次请求网络抖断（fetch failed），立刻重发一次就好（重发在 monitorQuery 里）。
 */

import { err, type KernelResult, ok } from "../errors.ts";
import type { ProdMonitorConfig } from "./config.ts";
import {
	type HttpPort,
	MONITOR_SIZE_CEILING,
	type MonitorFilter,
	type MonitorRow,
	type MonitorSession,
	monitorQuery,
} from "./monitor.ts";

/** monitor 按东八区自然日分天 */
const TZ_MS = 8 * 3_600_000;
const DAY_MS = 86_400_000;
export const MONITOR_RETENTION_DAYS = 7;
export const MONITOR_SPAN_DAYS = 5;

function dayIndex(ms: number): number {
	return Math.floor((ms + TZ_MS) / DAY_MS);
}

function dayStart(index: number): number {
	return index * DAY_MS - TZ_MS;
}

/** 东八区的 `YYYY-MM-DD HH:MM:SS`：monitor 日志里的 time、生产库里的时间都是这个口径 */
export function localTime(ms: number): string {
	return new Date(ms + TZ_MS).toISOString().slice(0, 19).replace("T", " ");
}

/** 生产库里的本地时间串（`2026-11-11 16:31:34.9`）→ 毫秒 */
export function parseLocalTime(text: string): number {
	const [date, time = "00:00:00"] = text.trim().split(/[ T]/);
	const [hms, frac = "0"] = time.split(".");
	return Date.parse(`${date}T${hms}.${frac.padEnd(3, "0").slice(0, 3)}+08:00`);
}

/** monitor 还留着的最早时刻：今天往前第 6 天的 0 点 */
export function retentionStart(nowMs: number): number {
	return dayStart(dayIndex(nowMs) - (MONITOR_RETENTION_DAYS - 1));
}

export interface MonitorWindow {
	from: number;
	to: number;
}

/** 把 [from, to] 切成 monitor 肯完整查的几段，从新到旧；早于保留期的部分剪掉并报出来 */
export function planWindows(
	fromMs: number,
	toMs: number,
	nowMs: number,
): { windows: MonitorWindow[]; keptFrom: number; clipped: boolean } {
	const keptFrom = Math.max(fromMs, retentionStart(nowMs));
	const windows: MonitorWindow[] = [];
	let end = toMs;
	while (end > keptFrom) {
		const start = Math.max(keptFrom, dayStart(dayIndex(end) - (MONITOR_SPAN_DAYS - 1)));
		windows.push({ from: start, to: end });
		end = start;
	}
	return { windows, keptFrom, clipped: fromMs < keptFrom };
}

export interface MonitorSearch {
	rows: MonitorRow[];
	/** 实际查了的段（从新到旧）和每段取回几条 */
	searched: (MonitorWindow & { rows: number })[];
	/** 到了条数上限没再往前查的段数 */
	skipped: number;
	/** 条数到了上限：最早的没取回来 */
	capped: boolean;
	requestedFrom: number;
	requestedTo: number;
	keptFrom: number;
	clipped: boolean;
	ms: number;
}

/** 这次查询的时间段：给了 from/to 用它们；只给 traceId 就查整个保留期；否则往回 minutes 分钟 */
export function requestedRange(filter: MonitorFilter, nowMs: number): { from: number; to: number } {
	const to = filter.to ? Date.parse(filter.to) : nowMs;
	if (filter.from) return { from: Date.parse(filter.from), to };
	if (filter.traceId && filter.minutes === undefined) return { from: retentionStart(nowMs), to };
	return { from: to - (filter.minutes ?? 60) * 60_000, to };
}

export async function searchMonitor(
	http: HttpPort,
	config: ProdMonitorConfig,
	session: MonitorSession | null,
	filter: MonitorFilter,
	nowMs: number,
): Promise<KernelResult<MonitorSearch>> {
	const range = requestedRange(filter, nowMs);
	const plan = planWindows(range.from, range.to, nowMs);
	const size = Math.min(Math.max(1, filter.size ?? 200), MONITOR_SIZE_CEILING);
	const rows: MonitorRow[] = [];
	const searched: MonitorSearch["searched"] = [];
	let capped = false;
	let ms = 0;
	for (const window of plan.windows) {
		const left = size - rows.length;
		const got = await monitorQuery(
			http,
			config,
			session,
			{
				...filter,
				from: new Date(window.from).toISOString(),
				to: new Date(window.to).toISOString(),
				size: left,
			},
			nowMs,
		);
		if (!got.ok) return err(got.error);
		ms += got.value.ms;
		rows.push(...got.value.rows);
		searched.push({ ...window, rows: got.value.rows.length });
		if (got.value.rows.length >= left) {
			capped = true;
			break;
		}
	}
	return ok({
		rows,
		searched,
		skipped: plan.windows.length - searched.length,
		capped,
		requestedFrom: range.from,
		requestedTo: range.to,
		keptFrom: plan.keptFrom,
		clipped: plan.clipped,
		ms,
	});
}

/** 「查了哪段、丢了什么」逐项报，0 也报 */
export function coverageLines(search: MonitorSearch, size: number): string[] {
	const lines: string[] = [];
	if (search.searched.length === 0)
		lines.push(
			`要查的时间段 ${localTime(search.requestedFrom)} ~ ${localTime(search.requestedTo)} 整段早于 monitor 保留期（只留 ${String(MONITOR_RETENTION_DAYS)} 天，从 ${localTime(search.keptFrom)} 起），没有日志可查`,
		);
	else if (search.searched.length === 1 && search.skipped === 0) {
		const w = search.searched[0] as MonitorSearch["searched"][number];
		lines.push(`查了 ${localTime(w.from)} ~ ${localTime(w.to)}，${String(w.rows)} 条，${String(search.ms)} ms`);
	} else
		lines.push(
			`查了 ${String(search.searched.length)} 段（monitor 一次只肯查 ${String(MONITOR_SPAN_DAYS)} 个自然日，长时间段在这边切开）：${search.searched
				.map((w) => `${localTime(w.from)} ~ ${localTime(w.to)} ${String(w.rows)} 条`)
				.join("；")}；共 ${String(search.ms)} ms`,
		);
	if (search.clipped && search.searched.length > 0)
		lines.push(
			`${localTime(search.requestedFrom)} ~ ${localTime(search.keptFrom)} 早于 monitor 保留期（只留 ${String(MONITOR_RETENTION_DAYS)} 天），没有日志`,
		);
	if (search.capped) {
		const earliest = search.rows
			.map((r) => String(r.time ?? ""))
			.filter((t) => t !== "")
			.sort()[0];
		lines.push(
			`⚠ 条数到了上限 ${String(size)}：结果从新到旧取，只取到 ${earliest ?? "?"}；更早的${search.skipped > 0 ? `和后面 ${String(search.skipped)} 段` : ""}没取回来——缩小时间段或加条件`,
		);
	}
	return lines;
}
