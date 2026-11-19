/** 界面卡片标题：每个产品工具都有、看得懂、写入和只读分得开。 */
import { describe, expect, it } from "vitest";
import { COSMIC_TOOL_NAMES } from "../../src/agent/tools/names.ts";
import { presentCosmicCall } from "../../src/dsh/present.ts";

describe("产品工具的界面卡片", () => {
	it("12 个工具空参数也都有标题，不出 undefined、不出 JSON", () => {
		for (const tool of COSMIC_TOOL_NAMES) {
			const view = presentCosmicCall(tool, {});
			expect(view, tool).toBeDefined();
			expect(view?.title, tool).not.toMatch(/undefined|\{|^\s*$/);
		}
	});

	it("写入和只读的标题分得开", () => {
		expect(presentCosmicCall("cosmic_meta", { argv: ["ptpl", "apply", "demo_t"], apply: true })?.title).toBe(
			"写元数据：ptpl apply demo_t",
		);
		expect(presentCosmicCall("cosmic_meta", { argv: ["ptpl", "dump", "demo_t"] })?.title).toBe(
			"元数据：ptpl dump demo_t",
		);
		expect(presentCosmicCall("cosmic_probe", { name: "MetaProbe", env: { APPLY: "1" } })).toMatchObject({
			title: "探针（写入）：MetaProbe",
			kind: "edit",
		});
		expect(presentCosmicCall("cosmic_probe", { name: ".cosmic-ai/probes/OneOff.java" })?.title).toBe(
			"探针：OneOff.java",
		);
	});

	it("真跑业务、生产查询带上关键输入，太长截断", () => {
		expect(presentCosmicCall("cosmic_run", { argv: ["op", "demo_bill", "save"] })?.title).toBe(
			"真跑业务：op demo_bill save",
		);
		const sql = `select ${"a, ".repeat(60)}b from t_demo`;
		const view = presentCosmicCall("cosmic_prod", { action: "sql", sql });
		expect(view?.title.length).toBeLessThanOrEqual(80);
		expect(view?.title.startsWith("查生产数据：select")).toBe(true);
		expect(view?.rawInput).toBe(sql);
	});

	it("参数不是对象、工具不认识：交给界面默认样子", () => {
		expect(presentCosmicCall("cosmic_run", "x")).toBeUndefined();
		expect(presentCosmicCall("bash", {})).toBeUndefined();
	});
});
