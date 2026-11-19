/** delivery-metrics.mjs 的类型声明：它给 node 的 CLI 用，测试里只引这几个纯函数。 */
type Kind = "platform" | "toolOutput" | "design" | "compose" | "other";
export declare const LONG_ROUND_TOKENS: number;
export declare const OPENING_CHARS: number;
export declare const THOUGHT_LABELS: Record<Kind, string>;
export declare function classifyThought(text: string): {
	kind: Kind;
	scores: Record<string, number>;
	hits: Record<string, string[]>;
	drafts: boolean;
};
export declare function countStatedDecisions(finalText: string): number;
export declare function measureDelivery(
	records: readonly unknown[],
	options?: {
		checklist?: unknown;
		longTokens?: number;
		sessionKey?: string;
		review?: Record<string, string>;
		fullThinking?: boolean;
	},
): any; // 结果是 CLI 用的报表，测试按字段断言
export declare function latencyByContext(
	sessions: readonly unknown[],
): Record<string, { rounds: number; avgLatencyMs: number; avgOutputTokens: number; msPerOutputToken: number | null }>;
