import { describe, expect, it } from "vitest";
import { budgetRecords, DEFAULT_RECORD_BUDGET } from "../../src/agent/tools/record-budget.ts";

/** 真机那次 `run rule` 的形状：5 条点名问的，一千多条没人问的布局显隐。 */
const ruleShow = (field: string) => ({ t: "rule-show", field, found: true, visible: true, visibleBy: "seq=24真" });
const ruleState = (field: string, container = "") => ({
	t: "rule-state",
	field,
	visible: false,
	enabled: true,
	visibleBy: container === "" ? "布局invisible" : `容器 ${container} 布局invisible`,
	enabledBy: "默认",
	byRule: false,
});

const size = (value: unknown): number => JSON.stringify(value).length;

describe("探针结构化记录的上下文预算", () => {
	it("同形的记录折成一条带计数的摘要", () => {
		const records = Array.from({ length: 330 }, (_, index) => ruleState(`zlgd_f${String(index)}`));
		const cut = budgetRecords(records);
		expect(cut.records).toHaveLength(1);
		expect(cut.records[0]?.n).toBe(330);
		expect(cut.records[0]?.fields).toEqual(["zlgd_f0", "zlgd_f1", "zlgd_f2", "…另 327 个"]);
		expect(cut.summary?.folded).toBe(330);
		expect(cut.summary?.total).toBe(330);
	});

	it("点名问的一条都不折，哪怕它们同形", () => {
		const records = [
			...Array.from({ length: 5 }, (_, index) => ruleShow(`zlgd_nz_ls${String(index)}`)),
			...Array.from({ length: 200 }, (_, index) => ruleState(`zlgd_other${String(index)}`)),
		];
		const cut = budgetRecords(records);
		const shown = cut.records.filter((record) => record.t === "rule-show");
		expect(shown).toHaveLength(5);
		expect(shown.map((record) => record.field)).toEqual([
			"zlgd_nz_ls0",
			"zlgd_nz_ls1",
			"zlgd_nz_ls2",
			"zlgd_nz_ls3",
			"zlgd_nz_ls4",
		]);
	});

	it("孤零零一条不折——折成摘要反而更长，而且它多半就是有意思的那条", () => {
		const records = [
			ruleState("zlgd_only"),
			...Array.from({ length: 4 }, (_, i) => ruleState(`x${String(i)}`, "面板")),
		];
		const cut = budgetRecords(records);
		expect(cut.records.find((record) => record.field === "zlgd_only")).toBeDefined();
		expect(cut.records.filter((record) => record.n === 4)).toHaveLength(1);
	});

	it("索引类记录不进模型上下文，但要说清摘掉了几条", () => {
		const records = [
			{ t: "binding", class: "zlgd.A", entity: "zlgd_bill", layout: "zlgd_layout", kind: "form" },
			{ t: "binding", class: "zlgd.B", entity: "zlgd_bill2", layout: "zlgd_layout2", kind: "form" },
			{ t: "binding-summary", isv: "zlgd", classes: 2 },
			ruleShow("zlgd_nz_ls1"),
		];
		const cut = budgetRecords(records);
		expect(cut.records).toHaveLength(1);
		expect(cut.records[0]?.t).toBe("rule-show");
		expect(cut.summary?.indexOnly).toBe(3);
	});

	it("带判定含义的记录留着——断言挂在哪条，模型得看得见", () => {
		const records = [
			{ t: "assert", case: "c1", kind: "value", target: "amount", ok: false, want: "1", got: "0" },
			{ t: "scenario", adapter: "run form", parent: "zlgd_bill" },
			{ t: "mustinput", entity: "zlgd_bill", key: "billno", name: "编号", type: "TextProp", entry: "", def: "" },
			...Array.from({ length: 50 }, (_, index) => ruleState(`zlgd_f${String(index)}`)),
		];
		const cut = budgetRecords(records);
		expect(cut.records.map((record) => record.t)).toContain("assert");
		expect(cut.records.map((record) => record.t)).toContain("scenario");
		expect(cut.records.map((record) => record.t)).toContain("mustinput");
		expect(cut.summary?.indexOnly).toBe(0);
	});

	it("结论排在最后也不被切：真机 run rule 的断言和场景记录是最后才发的（S20 批 2）", () => {
		// 2026-09-15 真机回放的形状：60 条规则碰过的字段各有各的归因（seq 不同，折不起来），
		// 断言、场景、汇总在末尾。按「从尾巴切」切，模型看到 29 条字段显隐，看不到断言挂没挂。
		const touched = Array.from({ length: 60 }, (_, index) => ({
			...ruleState(`zlgd_touched${String(index)}`),
			visibleBy: `seq=${String(index)}假`,
			byRule: true,
		}));
		const records = [
			...Array.from({ length: 5 }, (_, index) => ruleShow(`zlgd_nz_ls${String(index)}`)),
			...touched,
			{
				t: "rule-state-rest",
				count: 1291,
				visible: 42,
				hidden: 1249,
				hiddenBy: [{ by: "布局invisible", count: 330 }],
			},
			{ t: "scenario", adapter: "run rule form", layout: "zlgd_sys_test_lssy", fields: 1352 },
			{ t: "assert", case: null, kind: "rule-form", target: "zlgd_nz_ls2.visible", pass: false },
		];
		const cut = budgetRecords(records, { file: "last-probe.json" });
		const types = cut.records.map((record) => record.t);
		expect(types).toContain("assert");
		expect(types).toContain("scenario");
		expect(types).toContain("rule-state-rest");
		expect(types.filter((type) => type === "rule-show")).toHaveLength(5);
		// 结论排在前面，先读到的是「挂没挂」，再是字段明细
		expect(types.indexOf("assert")).toBeLessThan(types.indexOf("rule-state"));
		// 切掉的是字段明细，省略条数照实数，不会把汇总里的计数算进来
		const shownTouched = cut.records.filter((record) => record.t === "rule-state").length;
		expect(cut.summary?.omitted).toBe(60 - shownTouched);
		expect(cut.summary?.total).toBe(records.length);
	});

	it("run form 拼好的 run flow 命令（next-step）排在最后也不被切（S20 批 5）", () => {
		const nextStep = {
			t: "next-step",
			adapter: "run flow",
			child: "demo_round_dialog",
			callback: "demo.formplugin.DemoBillPlugin:demo_round",
			command: "run flow demo_bill_layout --op demo_round --child demo_round_dialog --child-set <子页字段=值>",
		};
		const records = [
			...Array.from({ length: 80 }, (_, index) => ({
				...ruleState(`zlgd_touched${String(index)}`),
				visibleBy: `seq=${String(index)}假`,
			})),
			nextStep,
		];
		const cut = budgetRecords(records);
		expect(cut.summary?.omitted).toBeGreaterThan(0);
		expect(cut.records[0]).toEqual(nextStep);
	});

	it("「这次没跑完整」排在最后也不被切，而且排最前（2026-10-10 真机）", () => {
		// 原来插件抛错只在原始输出里有一行字，模型看到的是一排 PASS
		const incomplete = { t: "run-incomplete", step: "loadData", plugin: "demo.formplugin.DemoBillPlugin", why: "x" };
		const records = [
			...Array.from({ length: 80 }, (_, index) => ({
				...ruleState(`zlgd_touched${String(index)}`),
				visibleBy: `seq=${String(index)}假`,
			})),
			incomplete,
		];
		const cut = budgetRecords(records);
		expect(cut.summary?.omitted).toBeGreaterThan(0);
		expect(cut.records[0]).toEqual(incomplete);
	});

	it("折完仍超预算就从尾巴切，切的是覆盖面最小的摘要，不是点名问的那条", () => {
		// 200 组各不同形、每组 3 条：全部折成 200 条摘要，仍然放不下。
		const records = [
			ruleShow("zlgd_asked"),
			...Array.from({ length: 200 }, (_, group) =>
				Array.from({ length: 3 }, (_, index) =>
					ruleState(`zlgd_g${String(group)}_${String(index)}`, `容器${String(group)}`),
				),
			).flat(),
		];
		const cut = budgetRecords(records);
		expect(size(cut.records)).toBeLessThanOrEqual(DEFAULT_RECORD_BUDGET + 200);
		expect(cut.records[0]?.t).toBe("rule-show");
		expect(cut.summary?.omitted).toBeGreaterThan(0);
		// S42 §16.8：和文字通道同一种取法，不再给落盘路径叫人 grep。
		expect(cut.summary?.remedy).toContain('raw="关键字"');
		expect(cut.summary?.remedy).not.toContain("grep");
	});

	it("那次 239 KB 的返回，记录部分压到 5 KB 以内", () => {
		// §2.4 的真实构成：5 条点名问的 + 1,352 条布局显隐，139 种说法。
		const containers = Array.from(
			{ length: 138 },
			(_, index) => `zlgd_advconap${String(index)}(容器${String(index)})`,
		);
		const records = [
			...Array.from({ length: 5 }, (_, index) => ruleShow(`zlgd_nz_ls${String(index)}`)),
			...Array.from({ length: 1352 }, (_, index) =>
				ruleState(`zlgd_field${String(index)}`, index < 330 ? "" : (containers[index % 138] as string)),
			),
			{ t: "scenario", adapter: "rule form", parent: "zlgd_sys_test_lssy" },
			{ t: "assert-none", case: "", result: "EXECUTED" },
		];
		expect(size(records)).toBeGreaterThan(190_000);
		const cut = budgetRecords(records, { file: "C:/cache/last-probe.json" });
		expect(size(cut.records)).toBeLessThan(5000);
		expect(cut.summary?.total).toBe(1359);
		expect(cut.summary?.file).toBe("C:/cache/last-probe.json");
		expect(cut.summary?.remedy).not.toContain("last-probe.json");
	});

	it("没什么可切的时候不多说一句话", () => {
		const cut = budgetRecords([ruleShow("zlgd_a"), { t: "assert", case: "c", ok: true }]);
		expect(cut.summary).toBeNull();
		expect(cut.records).toHaveLength(2);
	});

	it("点名打印格子的绑定和公式即使排在普通记录后也不会被预算切掉", () => {
		const target = { t: "ptpl-control", template: "tpl", key: "LayoutCell13", bindField: "code", formulaData: [] };
		const cut = budgetRecords([{ t: "verbose", text: "x".repeat(4000) }, target], { limit: 500 });
		expect(cut.records).toContainEqual(target);
		expect(cut.summary?.omitted).toBe(1);
	});

	it("只给事实记账的记录悄悄摘掉，不多出一段「摘了几条」", () => {
		const cut = budgetRecords([
			{ t: "assert", case: "c", ok: true },
			{ t: "committed", entity: "demo_bill", pk: "1", created: true },
			{ t: "own-plugins", entity: "demo_bill", where: "op save", classes: ["demo.A"] },
		]);
		expect(cut.records).toEqual([{ t: "assert", case: "c", ok: true }]);
		expect(cut.summary).toBeNull();
	});

	it("空数组不算被切过", () => {
		expect(budgetRecords([])).toEqual({ records: [], summary: null });
	});
});
