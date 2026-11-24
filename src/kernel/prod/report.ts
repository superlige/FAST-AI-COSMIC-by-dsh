/**
 * 诊断报告：查生产问题的交付物。
 *
 * 每条结论要么引用本次会话里真查到的证据（工具结果上标的 E 编号），要么就是推断——由这里按引用自动标，
 * 不由模型自己说「已证实」。引用了不存在的编号直接拒：那等于编造证据。
 * 报告落在 `.cosmic-ai/evidence/diagnosis/`，接着修代码时作为依据。
 */
import { join } from "node:path";
import type { KernelContext } from "../context.ts";
import { err, KernelError, type KernelResult, ok } from "../errors.ts";

export interface ProdEvidence {
	id: string;
	kind: string;
	summary: string;
	at: string;
	file?: string;
}

export interface DiagnosisFinding {
	text: string;
	evidence: string[];
}

export interface DiagnosisInput {
	title: string;
	findings: DiagnosisFinding[];
	/** 建议怎么修、下一步查什么（可空） */
	next?: string;
}

export interface DiagnosisReport {
	file: string;
	text: string;
	proven: number;
	inferred: number;
}

function invalid(message: string, remedy: string): KernelError {
	return new KernelError("PROD_REPORT_INVALID", message, { remedy });
}

export function checkDiagnosis(input: DiagnosisInput, evidence: readonly ProdEvidence[]): KernelError | null {
	if (input.title.trim() === "") return invalid("报告没有标题", "title 写一句话：什么现象。");
	if (input.findings.length === 0 || input.findings.every((f) => f.text.trim() === ""))
		return invalid("报告没有结论", "findings 至少一条：查到了什么、原因是什么。");
	const known = new Set(evidence.map((e) => e.id));
	const unknown = [...new Set(input.findings.flatMap((f) => f.evidence))].filter((id) => !known.has(id));
	if (unknown.length > 0)
		return invalid(
			`引用了本次会话里没有的证据：${unknown.join("、")}`,
			known.size === 0
				? "这次会话还没有查到任何证据（cosmic_prod 的 sql / meta / log 结果才有编号）。先查，或把这条结论的 evidence 留空，它会标成推断。"
				: `本次会话的证据编号只有：${[...known].join("、")}。改正引用，或留空标成推断。`,
		);
	return null;
}

export function renderDiagnosis(input: DiagnosisInput, evidence: readonly ProdEvidence[], at: string): string {
	const byId = new Map(evidence.map((e) => [e.id, e]));
	const cited = new Set<string>();
	const lines = [`# ${input.title.trim()}`, "", `生成时间：${at}（生产只读排障）`, "", "## 结论", ""];
	input.findings.forEach((f, i) => {
		const ids = [...new Set(f.evidence)];
		for (const id of ids) cited.add(id);
		lines.push(
			`${String(i + 1)}. ${ids.length > 0 ? `【有证据 ${ids.join("、")}】` : "【推断，未查证】"}${f.text.trim()}`,
		);
	});
	if (input.next !== undefined && input.next.trim() !== "") lines.push("", "## 下一步", "", input.next.trim());
	lines.push("", "## 引用的证据", "");
	if (cited.size === 0) lines.push("（无：以上全部是推断）");
	for (const id of cited) {
		const e = byId.get(id);
		if (e !== undefined)
			lines.push(`- ${e.id} ${e.kind}（${e.at}）：${e.summary}${e.file ? `　全文 ${e.file}` : ""}`);
	}
	return `${lines.join("\n")}\n`;
}

export function writeDiagnosis(
	ctx: KernelContext,
	input: DiagnosisInput,
	evidence: readonly ProdEvidence[],
): KernelResult<DiagnosisReport> {
	const problem = checkDiagnosis(input, evidence);
	if (problem !== null) return err(problem);
	const at = new Date(ctx.ports.clock.now());
	const stamp = at.toISOString().replace(/[:.]/g, "-");
	const file = join(ctx.layout.evidenceDir, "diagnosis", `${stamp}.md`);
	const text = renderDiagnosis(input, evidence, at.toLocaleString("zh-CN", { hour12: false }));
	ctx.ports.fs.write(file, text);
	const proven = input.findings.filter((f) => f.evidence.length > 0).length;
	return ok({ file, text, proven, inferred: input.findings.length - proven });
}
