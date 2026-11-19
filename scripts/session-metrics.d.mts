/** session-metrics.mjs 的类型声明：它给 node 的 CLI 用，测试里只引这两个纯函数。 */
export declare function measureIntake(records: readonly unknown[]): {
	bySource: Record<string, { textBytes: number; repeatedBytes: number } | undefined>;
	byTool: Record<string, { textBytes: number; repeatedBytes: number } | undefined>;
	total: { textBytes: number; repeatedBytes: number };
	prompt: { measuredBytes: number };
};
