/**
 * S44 4.1：给人看的单子，模型只拿摘要；details 留整份。
 */
import { describe, expect, it } from "vitest";
import { appliedRecordsView, applyModelView, targetsSummary, withModelView } from "../../src/agent/tools/model-view.ts";

describe("S44 4.1 给模型的摘要", () => {
	it("挂了 modelView 的对象按它换字段，null 不发，嵌套的也换；原对象不动", () => {
		const full = withModelView(
			{ report: "整份确认单", targets: ["a.x", "a.y", "b.z"], text: "已确认" },
			{
				report: null,
				targets: targetsSummary(["a.x", "a.y", "b.z"]),
			},
		);
		const nested = { probe: full, other: [full] };
		expect(applyModelView(nested)).toEqual({
			probe: { targets: "3 个：a 2 个、b", text: "已确认" },
			other: [{ targets: "3 个：a 2 个、b", text: "已确认" }],
		});
		expect(full.report).toBe("整份确认单");
	});

	it("真写入后逐项改动折成条数，回读对不上的原样留着", () => {
		const json = {
			records: [
				{ t: "layout-change", element: "a" },
				{ t: "layout-change", element: "b" },
				{ t: "layout-readback", element: "b", sent: "1", stored: "2" },
				{ t: "layout-heirs", count: 3 },
			],
		};
		const view = appliedRecordsView(json) as { records: Record<string, unknown>[] };
		expect(view.records[0]).toMatchObject({ t: "layout-change-count", count: 2 });
		expect(String(view.records[0]?.readback)).toContain("1 处对不上");
		expect(view.records.slice(1).map((record) => record.t)).toEqual(["layout-readback", "layout-heirs"]);
		expect(appliedRecordsView({ records: [{ t: "layout-heirs" }] })).toBeNull();
	});
});
