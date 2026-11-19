import { describe, expect, it } from "vitest";
import {
	CARD_FENCE,
	type CardView,
	cardView,
	checkReport,
	confirmationCard,
	confirmationDetail,
	displayWidth,
	fillTemplate,
	MAX_PURPOSE_TEXT,
	MAX_SLOT_TEXT,
	type ReportInput,
	renderForm,
	type WritePlan,
	writePlanCall,
} from "../../src/agent/state/write-report.ts";
import { buildWriteForm } from "../../src/kernel/policy/write-form.ts";

const RULE_ENV = {
	RULE_FORM: "demo_bill_lay",
	RULE_HOST: "demo_entry",
	RULE_TAG: "拆分-",
	RULE_GROUPS: '宽度类|demo_shape = "2"|demo_w1,demo_w2',
};

function plan(targets = ["demo_bill.demo_bill_lay", "demo_bill.demo_w1", "demo_bill.demo_w2"]): WritePlan {
	return {
		probe: "FormRuleProbe",
		kind: "表单界面规则",
		digest: "d1",
		call: "FormRuleProbe RULE_FORM=demo_bill_lay",
		targets,
		form: buildWriteForm({ probe: "FormRuleProbe", env: RULE_ENV, records: [], targets }),
	};
}

const report: ReportInput = {
	purpose: "按试样形状显示宽度",
	names: [
		{ id: "demo_bill_lay", name: "拉伸布局" },
		{ id: "demo_entry", name: "试验结果" },
		{ id: "demo_w1", name: "宽度1" },
		{ id: "demo_w2", name: "宽度2" },
	],
	slots: [{ key: "g1", text: "试样形状选矩形" }],
};

function refused(input: ReportInput | undefined, target = plan()): string {
	const checked = checkReport(target, input);
	if (checked.ok) throw new Error("应当被拒");
	return `${checked.message} | ${checked.remedy}`;
}

describe("确认单的填表模板", () => {
	it("只列表单要的格子：目的、每个标识的中文名、人话格、口径", () => {
		expect(JSON.parse(fillTemplate(plan().form))).toEqual({
			purpose: "<一句话目的>",
			names: [
				{ id: "demo_bill_lay", name: "<中文名>" },
				{ id: "demo_entry", name: "<中文名>" },
				{ id: "demo_w1", name: "<中文名>" },
				{ id: "demo_w2", name: "<中文名>" },
			],
			slots: [{ key: "g1", text: expect.stringMatching(/^<.+>$/) }],
			decisions: [],
		});
	});

	it("调用写成探针名 + 排好序的入参，APPLY 和空值不写，长值截断，多行压成一行", () => {
		expect(writePlanCall("P", { B: "2", APPLY: "1", A: "1", E: "", M: "x\ny" })).toBe("P A=1 B=2 M=x / y");
		expect(writePlanCall("P", { L: "x".repeat(80) })).toBe(`P L=${"x".repeat(57)}…`);
	});
});

describe("确认单 report 的校验", () => {
	it("填对了：得到这一项和它改的对象", () => {
		const checked = checkReport(plan(), report);
		if (!checked.ok) throw new Error(checked.message);
		expect(checked.change.fill.names.demo_w1).toBe("宽度1");
		expect(checked.change.object).toBe("拉伸布局（demo_bill_lay）");
	});

	it("没交 report、预演没报写入目标：拒，并给出照着填的模板", () => {
		expect(refused(undefined)).toContain('"purpose":"<一句话目的>"');
		expect(refused(report, plan([]))).toContain("没有报写入目标清单");
	});

	it("目的和注意事项：要短、不换行、不夹标识", () => {
		expect(refused({ ...report, purpose: "" })).toContain("目的是空的");
		expect(refused({ ...report, purpose: "字".repeat(MAX_PURPOSE_TEXT + 1) })).toContain("超过");
		expect(refused({ ...report, purpose: "改 demo_w1 的显示" })).toContain("夹了标识「demo_w1」");
		expect(refused({ ...report, note: "一行\n两行" })).toContain("注意事项里有换行");
	});

	it("中文名：表单要的一个不能少，表单外的不能多", () => {
		expect(refused({ ...report, names: report.names?.slice(1) })).toContain("还缺 1 个标识的中文名：demo_bill_lay");
		expect(refused({ ...report, names: [...(report.names ?? []), { id: "demo_x", name: "多余" }] })).toContain(
			"没有要填名字的标识「demo_x」",
		);
		expect(
			refused({ ...report, names: [{ id: "demo_bill_lay", name: "布局 demo_bill_lay" }, ...(report.names ?? [])] }),
		).toContain("夹了标识");
	});

	it("人话格：每格都要填、不能多填、不超长", () => {
		expect(refused({ ...report, slots: [] })).toContain("还有 1 格没填");
		expect(refused({ ...report, slots: [...(report.slots ?? []), { key: "g9", text: "x" }] })).toContain(
			"没有「g9」这一格",
		);
		expect(refused({ ...report, slots: [{ key: "g1", text: "字".repeat(MAX_SLOT_TEXT + 1) }] })).toContain("超过");
	});

	it("口径：两格都是人话，同一个做法不出现两次", () => {
		const one = { chose: "下拉用字母存储值", other: "用数字存储值" };
		expect(refused({ ...report, decisions: [one, one] })).toContain("重复了");
		expect(refused({ ...report, decisions: [{ chose: "用 demo_x 存", other: "不存" }] })).toContain("夹了标识");
	});
});

describe("确认框里的确认单", () => {
	it("格式固定：表单（表头、表格、影响、撤回、注意）、口径、写入范围、确认后会发生什么", () => {
		const checked = checkReport(plan(), {
			...report,
			note: "生效前字段一直显示",
			decisions: [{ chose: "隐藏而不是锁定", other: "锁定不可编辑" }],
		});
		if (!checked.ok) throw new Error(checked.message);
		expect(confirmationCard(checked.change).split("\n")).toEqual([
			"**表单界面规则**（元数据） · 新增 1 条界面规则",
			"",
			"- **布局**：拉伸布局 `demo_bill_lay`",
			"- **挂在**：试验结果 `demo_entry`",
			"- **动作**：条件成立显示，不成立隐藏",
			"- **描述前缀**：拆分-",
			"- **目的**：按试样形状显示宽度",
			"",
			"| 规则 | 什么时候 | 管的字段 | 条件原文 |",
			"| --- | --- | --- | --- |",
			'| 宽度类 | 试样形状选矩形 | 宽度1、宽度2 | `demo_shape = "2"` |',
			"",
			"- **影响**：所有人打开这张单据立即生效：条件成立时字段显示，不成立时隐藏",
			"- **撤回**：按描述前缀「拆分-」摘掉这 1 条规则",
			"- **注意**：生效前字段一直显示",
			"",
			"**我替你定的口径 1 条**（需求没说，AI 选的；哪条不合意就不确认，说要哪种）",
			"",
			"1. 隐藏而不是锁定",
			"   - 另一种：锁定不可编辑",
			"",
			"**写入范围**：3 个对象，由预演算出，范围外的对象会被拦下",
			"",
			"- `demo_bill`：`demo_bill_lay`、`demo_w1`、`demo_w2`",
			"",
			"确认后立即写进测试环境，写完回读核对；不确认则什么都不写。",
		]);
	});

	it("原值、新值两列：原值划掉、新值加粗；占位和没变的不动；格子里的 | $ 不会拆表、不会变公式", () => {
		const targets = ["demo_bill.demo_f1"];
		const records = [
			{ t: "layout-change", scope: "", element: "demo_f1", prop: "宽度", before: "100", after: "200" },
			{ t: "layout-change", scope: "", element: "demo_f1", prop: "锁定", before: "", after: "true" },
			{ t: "layout-change", scope: "", element: "demo_f1", prop: "标题", before: "a|b", after: "a|b" },
			{ t: "layout-change", scope: "", element: "demo_f2", prop: "（新增）", before: "", after: "$5 文本" },
		];
		const layout: WritePlan = {
			probe: "FormLayoutWriteProbe",
			kind: "单据布局",
			digest: "d2",
			call: "FormLayoutWriteProbe LAYOUT_FORM=demo_bill_lay",
			targets,
			form: buildWriteForm({
				probe: "FormLayoutWriteProbe",
				env: { LAYOUT_FORM: "demo_bill_lay", LAYOUT_BACKUP: "b" },
				records: records as never,
				targets,
			}),
		};
		const checked = checkReport(layout, {
			purpose: "调宽度",
			names: layout.form.names.map((id) => ({ id, name: "拉伸布局" })),
		});
		if (!checked.ok) throw new Error(checked.message);
		const lines = confirmationCard(checked.change).split("\n");
		expect(lines).toContain("| `demo_f1` | 宽度 | ~~100~~ | **200** |");
		expect(lines).toContain("|  | 锁定 | （默认） | **true** |");
		expect(lines).toContain("|  | 标题 | a\\|b | a\\|b |");
		expect(lines).toContain("| `demo_f2` | （新增） | — | **\\$5 文本** |");
	});

	it("本会话事实里的纯文本表单：太窄放不下表格时退成一行一个「列名：值」的卡片，内容一格不少", () => {
		const checked = checkReport(plan(), report);
		if (!checked.ok) throw new Error(checked.message);
		const text = renderForm(checked.change.plan.form, checked.change.fill, 40).join("\n");
		expect(text).toContain("  ▸ 规则：宽度类");
		expect(text).toContain("      什么时候：试样形状选矩形");
		expect(text).toContain('      条件原文：demo_shape = "2"');
	});

	it("中文、全角标点、表情按两格宽对齐", () => {
		expect(displayWidth("检验a")).toBe(5);
		expect(displayWidth("（）「」")).toBe(8);
		expect(displayWidth("✅x")).toBe(3);
	});
});

function layoutChange(records: Record<string, unknown>[], targets = ["demo_bill.demo_bill_lay"]) {
	const layout: WritePlan = {
		probe: "FormLayoutWriteProbe",
		kind: "单据布局",
		digest: "d3",
		call: "FormLayoutWriteProbe LAYOUT_FORM=demo_bill_lay",
		targets,
		form: buildWriteForm({
			probe: "FormLayoutWriteProbe",
			env: { LAYOUT_FORM: "demo_bill_lay" },
			records: records as never,
			targets,
		}),
	};
	const checked = checkReport(layout, {
		purpose: "保存即反写收样日期",
		names: layout.form.names.map((id) => ({ id, name: "收样确认" })),
		note: "只动这一张单",
	});
	if (!checked.ok) throw new Error(checked.message);
	return checked.change;
}

describe("界面插件画的确认卡片", () => {
	const records = [
		{ t: "layout-change", scope: "操作", element: "save", prop: "插件", before: "", after: "demo.op.SaveOp" },
		{ t: "layout-change", scope: "操作", element: "audit", prop: "插件", before: "demo.op.SaveOp", after: "" },
		{ t: "layout-change", scope: "", element: "demo_f1", prop: "宽度", before: "100", after: "200" },
		{ t: "layout-change", scope: "字段", element: "demo_f2", prop: "（删除）", before: "TextField", after: "" },
		{ t: "layout-change", scope: "", element: "demo_f1", prop: "标题", before: "a", after: "a" },
	];

	it("每处改动标成新增、删除、修改：挂插件是新增，摘插件和删字段是删除，前后一样的不计数", () => {
		const view = cardView(layoutChange(records));
		expect(view.object).toEqual({ label: "布局", name: "收样确认", id: "demo_bill_lay" });
		expect(view.purpose).toBe("保存即反写收样日期");
		expect(view.note).toBe("只动这一张单");
		const table = view.tables[0];
		if (table?.type !== "diff") throw new Error("应当画成改动清单");
		expect(table.columns).toEqual(["元素", "改哪里"]);
		expect(table.rows.map((row) => [row.op, ...row.keys, row.old, row.new])).toEqual([
			["add", "save（操作）", "插件", "—", "demo.op.SaveOp"],
			["remove", "audit（操作）", "插件", "demo.op.SaveOp", "—"],
			["change", "demo_f1", "宽度", "100", "200"],
			["remove", "demo_f2（字段）", "（删除）", "TextField", "—"],
			["same", "demo_f1", "标题", "a", "a"],
		]);
		expect(view.counts).toEqual({ add: 1, remove: 2, change: 1, set: 0 });
	});

	it("影响按「；」拆成几条，写入范围按对象归组", () => {
		const view = cardView(layoutChange(records, ["demo_bill.demo_bill_lay", "demo_bill.demo_f2", "data:x"]));
		expect(view.impact[0]).toBe("所有人打开这张单据立即按新的显示");
		expect(view.impact.length).toBeGreaterThan(1);
		expect(view.impact.every((part) => !part.includes("；"))).toBe(true);
		expect(view.targets).toEqual([
			{ group: "demo_bill", items: ["demo_bill_lay", "demo_f2"] },
			{ group: "data:", items: ["x"] },
		]);
		expect(view.targetCount).toBe(3);
	});

	it("没有原值、新值两列的表照表格画；只有「改成」一列的画成只给新值", () => {
		const checked = checkReport(plan(), report);
		if (!checked.ok) throw new Error(checked.message);
		const rule = cardView(checked.change).tables[0];
		expect(rule?.type).toBe("grid");
		expect(rule?.code).toEqual([false, false, false, true]);
	});

	it("弹窗正文是 Markdown 确认单，末尾一个四反引号代码块装一行卡片数据；数据里的反引号顶不破代码块", () => {
		const change = layoutChange([
			{ t: "layout-change", scope: "", element: "demo_f1", prop: "标题", before: "a", after: "```b````" },
		]);
		const detail = confirmationDetail(change);
		expect(detail.startsWith(confirmationCard(change))).toBe(true);
		const lines = detail.split("\n");
		expect(lines.slice(-3, -2)).toEqual([`\`\`\`\`${CARD_FENCE}`]);
		expect(lines.at(-1)).toBe("````");
		expect(lines.at(-2)).not.toContain("`");
		const view = JSON.parse(lines.at(-2) ?? "") as CardView;
		expect(view.v).toBe(1);
		const table = view.tables[0];
		expect(table?.type === "diff" ? table.rows[0]?.new : null).toBe("```b````");
	});
});
