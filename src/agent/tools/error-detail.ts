/**
 * 失败返回的 `error.detail` 也过预算（S34 批 1.4）。
 *
 * 拒绝和失败的结构化字段一直没有预算：编译失败的 `detail.raw` 是 javac 原文
 * （上限 8,000 字符），新鲜度拒绝的 `staleFiles` 是整个文件清单——其他通道都有
 * 切的法子，只有这一条原样进上下文。它不是这次失败的原因就是照抄下一步要用的
 * 清单，所以**不删，只切**：字符串超预算就留头尾（javac 的头几条往往就是
 * 要改的那处），中间换成一行说明带原始字节数。
 *
 * 只动发给模型的那份。审计和 `details` 里的那份原文不动——复盘要对的正是它。
 */

import { budgetOutput } from "./output-budget.ts";

/** 单个字符串值的预算，和文字通道一个量级。 */
export const ERROR_DETAIL_BUDGET = 4000;

/** 递归清点的最深层。detail 的形状是平的，两层够用也防住意外嵌套。 */
const MAX_DEPTH = 2;

const encoder = new TextEncoder();

/**
 * 模型该看到的那份 detail。原样返回没有任何值被切的 detail；
 * 切过的字符串值在原位换成头尾加一行说明。
 */
export function budgetErrorDetail(detail: Record<string, unknown>): Record<string, unknown> {
	return walk(detail, 0) as Record<string, unknown>;
}

function walk(value: unknown, depth: number): unknown {
	if (typeof value === "string") {
		if (encoder.encode(value).length <= ERROR_DETAIL_BUDGET) return value;
		const budget = budgetOutput(value, ERROR_DETAIL_BUDGET);
		// budgetOutput 的标记说「全文见 outputFile」，对 detail 不成立：这里是结构化
		// 字段，没有落盘文件。换成自己的说法，行数信息保留。
		const marker = `…（中间省略 ${String(budget.omittedLines)} 行，原文共 ${String(budget.totalBytes)} 字节）…`;
		const lines = value.split("\n");
		if (budget.omittedFrom === null || budget.omittedTo === null) return budget.shown.replace(/…[^…]*…/, marker);
		return [...lines.slice(0, budget.omittedFrom - 1), marker, ...lines.slice(budget.omittedTo - 1)].join("\n");
	}
	if (depth >= MAX_DEPTH) return value;
	if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1));
	if (typeof value === "object" && value !== null) {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, walk(item, depth + 1)]),
		);
	}
	return value;
}
