/**
 * 工具结果发给模型之前的那道收口：成功的排成「结构化结果 + 正文块」，失败的排成一段带错误码的话。
 *
 * 成功：第一块是一行 JSON（`{"ok":true,"result":…}`），多行的正文（探针输出、知识卡片、影响面正文）
 * 从 JSON 里挪出来，各成一块 `# 标题\n\n正文`——塞在 JSON 里就成了一整行 `\n` 转义，模型读不了也 grep 不了。
 * 挪之前依次过：给人看的单子换摘要、结构化记录按预算裁、字段清单、固定提醒折叠、和前面发过的段落去重。
 *
 * 失败：抛出 `CosmicToolFailure`，模型看到 `Error: [错误码] 说明` 加修复办法和详情。
 * 错误码写在文字里，因为 dsh 交给模型的只有这段文字，结构化的错误码模型看不见。
 */

import { budgetErrorDetail } from "../agent/tools/error-detail.ts";
import { trimKnowledgeEnvelope } from "../agent/tools/knowledge-envelope.ts";
import { applyModelView } from "../agent/tools/model-view.ts";
import type { CosmicToolName } from "../agent/tools/names.ts";
import { pruneMetaReport, pruneProbeOutcome } from "../agent/tools/probe-manifest.ts";
import { extractProse, PROSE_FIELDS } from "../agent/tools/prose-blocks.ts";
import { budgetRecords } from "../agent/tools/record-budget.ts";
import { withReachableRemedy } from "../agent/tools/remedy.ts";
import { foldNotesInValue, foldReminders } from "../agent/tools/reminders.ts";
import { foldSentLines } from "../agent/tools/sent-ledger.ts";
import type { ProbeJsonRecord } from "../kernel/probe/output.ts";
import type { CosmicSession } from "./session.ts";

export interface AgentFailure {
	code: string;
	message: string;
	detail: Record<string, unknown>;
	remedy: string;
}

/**
 * 工具失败。`message` 就是模型读到的整段话，`code` 给失败计数和日志用。
 *
 * 两种来源：门槛或内核拒绝（`refused`，一段带修复办法的话），和跑了但没成（探针退出码非 0、断言没过），
 * 后者的正文和成功时一样排，只是标成失败——输出正是要拿去读的东西。
 */
export class CosmicToolFailure extends Error {
	readonly code: string;

	constructor(code: string, text: string) {
		super(text);
		this.name = "CosmicToolFailure";
		this.code = code;
	}
}

/** 门槛或内核拒绝。 */
export function refused(failure: AgentFailure, blocks: readonly string[] = []): CosmicToolFailure {
	const reachable = withReachableRemedy(failure);
	return new CosmicToolFailure(reachable.code, renderFailure(reachable, blocks));
}

/** 失败的那段话：错误码和说明一行，修复办法一行，详情一行 JSON（过预算），附带的正文各成一块。 */
export function renderFailure(failure: AgentFailure, blocks: readonly string[] = []): string {
	const detail = budgetErrorDetail(failure.detail);
	const lines = [`[${failure.code}] ${failure.message}`];
	if (failure.remedy !== "") lines.push(`修复：${failure.remedy}`);
	if (Object.keys(detail).length > 0) lines.push(`详情：${JSON.stringify(detail)}`);
	return [lines.join("\n"), ...blocks].join("\n\n");
}

/** 一个 `{ json: { records, file } }` 载体按预算裁；没东西可裁返回 null。 */
function cutRecordsOf(carrier: Record<string, unknown>): Record<string, unknown> | null {
	const json = carrier.json;
	if (typeof json !== "object" || json === null || Array.isArray(json)) return null;
	const bag = json as Record<string, unknown>;
	if (!Array.isArray(bag.records)) return null;
	const budget = budgetRecords(bag.records as ProbeJsonRecord[], {
		file: typeof carrier.outputFile === "string" ? carrier.outputFile : null,
	});
	if (budget.summary === null) return null;
	return { ...carrier, json: { ...bag, records: budget.records }, recordBudget: budget.summary };
}

/** 结构化记录按预算裁。完整的一份在 `json.file` 和落盘的输出里，裁的只是发给模型的这一份。 */
function withRecordBudget(result: unknown): unknown {
	if (typeof result !== "object" || result === null || Array.isArray(result)) return result;
	const record = result as Record<string, unknown>;
	const direct = cutRecordsOf(record);
	if (direct !== null) return direct;
	const probe = record.probe;
	if (typeof probe !== "object" || probe === null || Array.isArray(probe)) return result;
	const cut = cutRecordsOf(probe as Record<string, unknown>);
	return cut === null ? result : { ...record, probe: cut };
}

function omit(record: Record<string, unknown>, drop: readonly string[]): Record<string, unknown> {
	return Object.fromEntries(Object.entries(record).filter(([key]) => !drop.includes(key)));
}

/** 去掉和正文重复的结构化那份：meta 的 `text` 就是 `probe.output`；影响面的 `text` 由 `impact` 排出来。 */
function withoutRenderedTwin(tool: CosmicToolName, result: unknown): unknown {
	if (typeof result !== "object" || result === null || Array.isArray(result)) return result;
	const record = result as Record<string, unknown>;
	if (typeof record.text !== "string") return result;
	if (tool === "cosmic_meta") {
		const probe = record.probe;
		if (typeof probe !== "object" || probe === null) return result;
		return { ...record, probe: omit(probe as Record<string, unknown>, ["output", "notes"]) };
	}
	if (tool === "cosmic_impact" && (record.impact !== undefined || record.targets !== undefined))
		return omit(record, ["impact", "targets"]);
	return result;
}

/** 字段清单、固定提醒折叠、和前面发过的段落去重。 */
function intakeCut(tool: CosmicToolName, result: unknown, adHoc: boolean, session: CosmicSession): unknown {
	let value = result;
	if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
	const record = value as Record<string, unknown>;
	if ((tool === "cosmic_probe" || tool === "cosmic_run") && typeof record.exitCode === "number")
		value = pruneProbeOutcome(record, { adHoc });
	else if (tool === "cosmic_meta" && (record.kind === "probe" || record.kind === "diff" || record.kind === "edit"))
		value = pruneMetaReport(record, { adHoc });
	value = foldNotesInValue(value, session.reminders);
	const fields = PROSE_FIELDS[tool];
	if (fields === undefined || typeof value !== "object" || value === null || Array.isArray(value)) return value;
	const out = { ...(value as Record<string, unknown>) };
	for (const field of fields) {
		const text = out[field];
		if (typeof text !== "string" || !text.includes("\n")) continue;
		const reminded = foldReminders(session.reminders, text);
		out[field] = foldSentLines(session.sent, reminded.text).text;
	}
	return out;
}

/** 成功结果发给模型的那几块文字。 */
export function renderSuccess(
	session: CosmicSession,
	tool: CosmicToolName,
	result: unknown,
	options: { adHocProbe?: boolean; ok?: boolean } = {},
): string[] {
	const budgeted = withRecordBudget(applyModelView(result));
	const intake = intakeCut(tool, budgeted, options.adHocProbe === true, session);
	const prose = extractProse(tool, trimKnowledgeEnvelope(tool, withoutRenderedTwin(tool, intake)));
	return [
		JSON.stringify({ ok: options.ok ?? true, result: prose.result }),
		...prose.blocks.map((block) => `# ${block.label}\n\n${block.text}`),
	];
}
