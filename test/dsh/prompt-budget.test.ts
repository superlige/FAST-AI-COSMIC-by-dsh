/**
 * 常驻系统提示的上限：按产物里真实的已发布探针量最坏情况（两种模式、知识装载出错的两种形状、最长的状态段）。
 */
import { describe, expect, it } from "vitest";
import { measureL0Budget } from "../../src/agent/prompt/system-prompt.ts";
import { releasedProbes } from "../../src/dsh/probes.ts";

describe("常驻系统提示的上限", () => {
	it("最坏情况也在上限以内", () => {
		const probes = releasedProbes();
		expect(probes.names.length).toBeGreaterThan(20);
		const budget = measureL0Budget(probes.names, probes.inputs);
		expect(budget.over, JSON.stringify(budget, null, 2)).toBe(false);
	});
});
