/**
 * 单据足迹：没有 traceId 时，从单据编号把 monitor 里那几次请求找回来。
 *
 * 路子（真机验证过）：
 *   1. 操作记录 t_log_app_v3 记着这张单每次保存、提交、审核……的时间（到毫秒）、操作人、操作标识、成败和提示。
 *      它不带 traceId，但 monitor 每条日志的 logtags 里有 userName（就是这里的操作人姓名）；
 *   2. 拿「这个人 + 那一刻前后几秒」去 monitor 查，回来的是这几秒里这个人的所有请求，按 traceId 分组；
 *   3. 认出是哪一次：monitor 的 opKey 写作「控件[按钮, 操作]」（`tbmain[bar_submit, submit]`），第二项就是操作记录里的操作标识；
 *      列表上点的、审批页上点的也一样。认不出就取时间上罩住那一刻、条数最多的那个；
 *   4. 同时按单据编号搜日志正文：插件自己写的日志常带单号，能找到操作记录里没有的请求（后台任务、消息、工作流回调）。
 * 提交、审核后工作流会另起几个请求（页面标识 WF_…），各有各的 traceId，单独数出来。
 */

import { headlineOf, kindOf, rowText } from "./log-view.ts";
import type { MonitorRow } from "./monitor.ts";

/** 操作记录里这些是看、查、刷新，不是改单据的动作：不去找它们的请求 */
export const VIEW_OP_KEYS = ["billopen", "listopen", "listfastsearch", "refresh", "view", "close"] as const;

export interface OpRecord {
	/** 本地时间串，`2026-11-11 16:31:34.9` */
	time: string;
	ms: number;
	user: string;
	opKey: string;
	opName: string;
	/** 1 成功、0 失败 */
	status: string;
	desc: string;
}

export interface TraceGroup {
	traceId: string;
	rows: MonitorRow[];
	first: string;
	last: string;
	formIds: string[];
	opKeys: string[];
	levels: Record<string, number>;
	/** 本工程（或像本 ISV）的类，写过日志的 */
	isvClasses: string[];
	/** 报错、警告的首句（慢 SQL 不算） */
	problems: string[];
}

const tag = (row: MonitorRow, key: string): string => String(row.logtags?.[key] ?? "");

/** monitor 的 opKey（`tbmain[bar_submit, submit]`）、opMethod 是不是操作记录里的这个操作 */
export function opKeyMatches(row: MonitorRow, opKey: string): boolean {
	const key = tag(row, "opKey");
	if (key === opKey || tag(row, "opMethod") === opKey) return true;
	const inner = /\[([^\]]*)\]$/.exec(key)?.[1];
	return inner !== undefined && inner.split(",").some((part) => part.trim() === opKey);
}

export function groupByTrace(rows: readonly MonitorRow[], isv: string): TraceGroup[] {
	const by = new Map<string, MonitorRow[]>();
	for (const row of rows) {
		const id = tag(row, "traceId") || "(无 traceId)";
		const list = by.get(id) ?? [];
		list.push(row);
		by.set(id, list);
	}
	const isvPattern = new RegExp(`^(?:kd\\.)?${isv.replace(/[^\w]/g, "")}\\.`);
	const groups: TraceGroup[] = [];
	for (const [traceId, list] of by) {
		const times = list.map((r) => String(r.time ?? "")).sort();
		const levels: Record<string, number> = {};
		const problems: string[] = [];
		for (const row of list) {
			const level = String(row.level ?? "");
			levels[level] = (levels[level] ?? 0) + 1;
			if (level !== "ERROR" && level !== "WARN") continue;
			const text = rowText(row);
			const kind = kindOf(row, text);
			if (kind === "慢SQL") continue;
			const headline = headlineOf(text, kind).slice(0, 240);
			if (!problems.includes(headline)) problems.push(headline);
		}
		groups.push({
			traceId,
			rows: list,
			first: times[0] ?? "",
			last: times.at(-1) ?? "",
			formIds: [...new Set(list.map((r) => tag(r, "formId")).filter((v) => v !== ""))],
			opKeys: [...new Set(list.map((r) => tag(r, "opKey")).filter((v) => v !== ""))],
			levels,
			isvClasses: [...new Set(list.map((r) => String(r.className ?? "")).filter((c) => isvPattern.test(c)))].sort(),
			problems,
		});
	}
	return groups.sort((a, b) => a.first.localeCompare(b.first));
}

/** 工作流在提交、审核后另起的请求：审批页面 WF_… */
export const isWorkflowFollowUp = (group: TraceGroup): boolean => group.formIds.some((f) => f.startsWith("WF_"));

/** 这一次操作对应 monitor 里的哪个（些）请求 */
export function pickRequests(groups: readonly TraceGroup[], op: OpRecord): { picked: TraceGroup[]; how: string } {
	const matched = groups.filter((g) => g.rows.some((row) => opKeyMatches(row, op.opKey)));
	if (matched.length > 0) return { picked: matched, how: `opKey 对上 ${op.opKey}` };
	const at = op.time.replace(/\.\d+$/, "");
	const covering = groups
		.filter((g) => !g.formIds.includes("mq"))
		.filter((g) => g.first.slice(0, 19) <= at && g.last.slice(0, 19) >= at)
		.sort((a, b) => b.rows.length - a.rows.length);
	const page = covering.filter((g) => !isWorkflowFollowUp(g));
	if (page.length > 0) return { picked: [page[0] as TraceGroup], how: "时间上罩住这一刻、条数最多的请求" };
	// 审批（含批量审批）通过后，审核这类动作是工作流在后台请求里替人执行的：页面是 WF_…，
	// 批量时同一刻几张单各跑一个，按时间分不开，都列出来
	const flow = covering.slice(0, 3);
	if (flow.length > 0)
		return {
			picked: flow,
			how: `审批流程替人执行的（页面 WF_…），时间上罩住这一刻的 ${String(covering.length)} 个${covering.length > 1 ? "（批量审批时几张单同时跑，按时间分不开）" : ""}`,
		};
	return { picked: [], how: "这几秒里没有这个人的请求日志" };
}

function levelText(levels: Record<string, number>): string {
	return Object.entries(levels)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([level, n]) => `${level} ${String(n)}`)
		.join("、");
}

export function renderTraceLine(g: TraceGroup): string {
	const parts = [
		`traceId ${g.traceId}`,
		`${g.first.slice(11, 23)}~${g.last.slice(11, 23)}`,
		`${String(g.rows.length)} 条（${levelText(g.levels)}）`,
		`页面 ${g.formIds.join("、") || "-"}`,
	];
	if (g.opKeys.length > 0) parts.push(`opKey ${g.opKeys.slice(0, 3).join("、")}`);
	parts.push(`本工程类 ${g.isvClasses.length > 0 ? g.isvClasses.join("、") : "0 个"}`);
	const lines = [`    ${parts.join("；")}`];
	for (const p of g.problems.slice(0, 3)) lines.push(`      ⚠ ${p}`);
	return lines.join("\n");
}

/** 日志正文提到单号的那几条：时间、人、页面、类、正文开头 */
export function renderMention(row: MonitorRow): string {
	const text = rowText(row).replace(/\s+/g, " ");
	return `  ${String(row.time ?? "")}  ${tag(row, "userName") || "-"}  traceId ${tag(row, "traceId") || "-"}  页面 ${tag(row, "formId") || "-"}  ${String(row.className ?? "")}：${text.slice(0, 200)}`;
}
