/**
 * 生产只读查询攒下的证据编号。
 *
 * 证据只由 cosmic_prod 的真实结果写入；诊断报告只认这些编号。
 * 生产只读靠 cosmic_prod 这条通道自己（语句闸、只读会话、只读事务回滚），不靠会话分模式：
 * 其余产品工具连的都是测试环境，到不了生产。
 */
import type { ProdEvidence } from "../../kernel/prod/report.ts";

export interface ProdState {
	evidence: ProdEvidence[];
	/** 最近一份诊断报告的文件 */
	lastReport?: string;
}

export function initialProdState(): ProdState {
	return { evidence: [] };
}

export function nextEvidenceId(state: ProdState): string {
	const max = state.evidence.reduce((n, e) => Math.max(n, Number.parseInt(e.id.slice(1), 10) || 0), 0);
	return `E${String(max + 1)}`;
}

export function withEvidence(state: ProdState, evidence: Omit<ProdEvidence, "id">): { state: ProdState; id: string } {
	const id = nextEvidenceId(state);
	return { state: { ...state, evidence: [...state.evidence, { id, ...evidence }] }, id };
}
