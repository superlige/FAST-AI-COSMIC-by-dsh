import { describe, expect, it } from "vitest";
import { initialProdState, withEvidence } from "../../src/agent/state/prod-state.ts";

describe("生产查询：证据编号", () => {
	it("接着最大的往下编", () => {
		const one = withEvidence(initialProdState(), { kind: "生产数据", summary: "a", at: "t" });
		expect(one.id).toBe("E1");
		const two = withEvidence(one.state, { kind: "生产日志", summary: "b", at: "t" });
		expect(two.id).toBe("E2");
		expect(two.state.evidence.map((e) => e.id)).toEqual(["E1", "E2"]);
	});
});
