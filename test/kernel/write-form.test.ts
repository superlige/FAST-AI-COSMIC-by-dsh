/**
 * S23 确认单表单：每类写入的表头、表格、要模型填的格子，都由入参和探针记录决定。
 *
 * 钉住两件事：事实（标识、类型、原值、新值、条件原文）一律进 text 格，不交给模型；
 * 模型只填 names（标识的中文名）和 slots（少数要翻成人话的格子），而且清单是确定的。
 */

import { describe, expect, it } from "vitest";
import { buildWriteForm, type FormCell, type WriteForm } from "../../src/kernel/policy/write-form.ts";
import { METADATA_WRITERS } from "../../src/kernel/policy/write-plan.ts";

const form = (
	probe: string,
	env: Record<string, string>,
	records: Record<string, unknown>[] = [],
	targets: string[] = [],
): WriteForm => buildWriteForm({ probe, env, records, targets });

const texts = (row: readonly FormCell[] | undefined): unknown[] =>
	(row ?? []).map((cell) => ("text" in cell ? cell.text : cell));

describe("S23 每个写探针都有自己的表单", () => {
	it("6 个元数据写探针 + 2 个数据写探针都不落到兜底表单", () => {
		const envs: Record<string, Record<string, string>> = {
			BizRuleProbe: {
				BIZ_ENTITY: "zlgd_a",
				BIZ_TAG: "t-",
				BIZ_NAME: "n",
				BIZ_CONDITION: "1=1",
				BIZ_TRUE: "clear:zlgd_f",
			},
			BotpRuleSyncProbe: { SYNC_TARGETS: "r1", SYNC_FIELDMAP: "zlgd_f=zlgd_g" },
			FormLayoutWriteProbe: { LAYOUT_FORM: "zlgd_a", LAYOUT_EDIT: "set zlgd_f.FontSize=14" },
			FormRegisterProbe: { REG_FORM: "zlgd_a", REG_REF: "zlgd_b" },
			FormRuleProbe: { RULE_FORM: "zlgd_a", RULE_TAG: "t-", RULE_GROUPS: "g|1=1|zlgd_f" },
			PrintTplWriteProbe: { TPL_NUMBER: "zlgd_t", TPL_SET: "Text1.text=合计" },
			DataSeedProbe: { SEED_ENTITY: "zlgd_a", SEED_SET: "zlgd_f=1" },
			DataUpdateProbe: { UPD_ENTITY: "zlgd_a", UPD_PKS: "1", UPD_SET: "zlgd_f=1" },
		};
		expect(Object.keys(envs).filter((probe) => probe in METADATA_WRITERS)).toHaveLength(6);
		for (const [probe, env] of Object.entries(envs)) {
			const built = form(probe, env, [], ["botp:r1"]);
			expect(built.kind, probe).not.toBe(probe);
			expect(built.impact, probe).not.toBe("确认后立即写进共享环境");
			expect(built.undo, probe).not.toBe("");
		}
	});
});

describe("S42 单据布局里的字段", () => {
	it("加字段、删字段：业务表加几列、删掉的列和数据留着，都从探针比出来的记录数", () => {
		const change = (element: string, prop: string, before: string, after: string) => ({
			t: "layout-change",
			scope: "字段",
			element,
			prop,
			before,
			after,
		});
		const built = form(
			"FormLayoutWriteProbe",
			{ LAYOUT_FORM: "zlgd_bill", LAYOUT_EDIT: "（模型写的清单，不当事实）" },
			[
				change("zlgd_a", "（新增）", "", "DecimalField「抗拉强度」"),
				change("zlgd_a", "Scale", "", "10"),
				change("zlgd_b", "（新增）", "", "ComboField「结论」"),
				change("zlgd_old", "（删除）", "TextField「旧备注」", ""),
			],
		);
		expect(built.impact).toBe(
			"所有人打开这张单据立即按新的显示；标了（字段）（分录）（操作）的改在实体上，这张单据的每个布局都跟着变；" +
				"业务表加 2 列；删掉的 1 个字段界面上没了，数据库里的列和数据留着",
		);
		expect(built.undo).toContain("新加字段的列写回后还留在表里，没人用");
		expect(built.tables[0]?.rows.map(texts)[0]).toEqual([
			"zlgd_a（字段）",
			"（新增）",
			"—",
			"DecimalField「抗拉强度」",
		]);
	});
});

describe("S55 单据布局里的新分录", () => {
	const change = (scope: string, element: string, prop: string, after: string) => ({
		t: "layout-change",
		scope,
		element,
		prop,
		before: "",
		after,
	});
	const records = (existing: boolean) => [
		change("分录", "zlgd_mx", "（新增）", "EntryEntity「变更明细」"),
		change("分录", "zlgd_mx", "TableName", "tk_zlgd_mx"),
		change("字段", "zlgd_old", "（新增）", "TextField「旧值」"),
		{ t: "layout-entry-table", entry: "zlgd_mx", table: "tk_zlgd_mx", existing },
	];
	const env = { LAYOUT_FORM: "zlgd_bill", LAYOUT_EDIT: "（模型写的清单，不当事实）" };

	it("新建表写进影响和撤回；分录不算成「加一列」", () => {
		const built = form("FormLayoutWriteProbe", env, records(false));
		expect(built.impact).toBe(
			"所有人打开这张单据立即按新的显示；标了（字段）（分录）（操作）的改在实体上，这张单据的每个布局都跟着变；" +
				"新建业务表 tk_zlgd_mx；业务表加 1 列",
		);
		expect(built.undo).toContain("新建的分录表写回后还留在库里，没人用");
		expect(built.tables[0]?.rows.map(texts)[0]).toEqual([
			"zlgd_mx（分录）",
			"（新增）",
			"—",
			"EntryEntity「变更明细」",
		]);
	});

	it("表是以前留下的：说接着用、原有的行还在，不说新建", () => {
		const built = form("FormLayoutWriteProbe", env, records(true));
		expect(built.impact).toContain("新分录接着用库里已有的表 tk_zlgd_mx（以前建过同名分录留下的，表里原有的行还在）");
		expect(built.impact).not.toContain("新建业务表");
		expect(built.undo).not.toContain("新建的分录表");
	});
});

describe("S23 表单界面规则", () => {
	it("新增：每组一行，条件原文照入参放，人话条件是 g1、g2 两格", () => {
		const built = form("FormRuleProbe", {
			RULE_FORM: "zlgd_lay",
			RULE_HOST: "zlgd_entry",
			RULE_TAG: "拆分-",
			RULE_ACT: "lock",
			RULE_GROUPS: 'a|zlgd_x = "1"|zlgd_f1,zlgd_f2;b|zlgd_x = "2"|zlgd_f3',
		});
		expect(built.slots.map((slot) => slot.key)).toEqual(["g1", "g2"]);
		expect(built.names).toEqual(["zlgd_lay", "zlgd_entry", "zlgd_f1", "zlgd_f2", "zlgd_f3"]);
		expect(built.tables[0]?.columns).toEqual(["规则", "什么时候", "管的字段", "条件原文"]);
		expect(built.tables[0]?.rows[0]).toEqual([
			{ text: "a" },
			{ slot: "g1" },
			{ names: ["zlgd_f1", "zlgd_f2"] },
			{ text: 'zlgd_x = "1"' },
		]);
		expect(built.impact).toContain("条件成立时字段可编辑，不成立时锁定");
		expect(built.undo).toBe("按描述前缀「拆分-」摘掉这 2 条规则");
	});

	it("修改条件：原来 / 改后两格人话，原文两格照入参", () => {
		const built = form("FormRuleProbe", {
			RULE_FORM: "zlgd_lay",
			RULE_UPDATE_ID: "6G9Q",
			RULE_EXPECT_CONDITION: "old",
			RULE_UPDATE_CONDITION: "new",
		});
		expect(built.slots.map((slot) => slot.key)).toEqual(["before", "after"]);
		expect(built.tables[0]?.rows[1]?.map((cell) => ("text" in cell ? cell.text : ""))).toEqual([
			"条件原文",
			"old",
			"new",
		]);
	});

	it("追加字段：每条规则一行，规则说明是人话格", () => {
		const built = form("FormRuleProbe", {
			RULE_FORM: "zlgd_lay",
			RULE_APPEND: "R1|zlgd_a|zlgd_a_ysjl;R2|zlgd_b|zlgd_b_ysjl",
		});
		expect(built.summary).toBe("往 2 条既有界面规则里追加 2 个字段");
		expect(built.slots.map((slot) => slot.key)).toEqual(["r1", "r2"]);
		expect(built.undo).toContain("没有一键撤回");
	});
});

describe("S23 打印模板、BOTP、业务规则", () => {
	it("打印模板的原值新值来自探针的 t=tpl-set 记录；没有记录时原值写明预演没报", () => {
		const records = [{ t: "tpl-set", control: "Text1", prop: "style.fontSize", before: "9", after: "12" }];
		const built = form("PrintTplWriteProbe", { TPL_NUMBER: "zlgd_t", TPL_SET: "Text1.style.fontSize=12" }, records);
		expect(built.tables[0]?.rows.map(texts)).toEqual([["Text1", "style.fontSize", "9", "12"]]);
		const bare = form("PrintTplWriteProbe", { TPL_NUMBER: "zlgd_t", TPL_SET: "Text1.style.fontSize=12" });
		expect(bare.tables[0]?.rows.map(texts)).toEqual([["Text1", "style.fontSize", "（预演没报）", "12"]]);
	});

	// S32 批 1/3：整份提交交上去的是一整份设计数据，入参里只有一条路径——「改了什么」只能由
	// 探针比出来，公式「显示成什么」也由探针试算出来。
	it("打印模板整份提交：改动表来自 t=tpl-change，公式试算另起一张表", () => {
		const records = [
			{
				t: "tpl-change",
				owner: "LayoutCell31(LayoutCell)",
				path: ".formulaData",
				before: "«批号»",
				after: "«批号» ⏎ «炉次»",
			},
			{
				t: "tpl-formula",
				control: "LayoutCell31(LayoutCell)",
				formula: "«批号» ⏎ «炉次»",
				case: "字段都空",
				shown: "/",
			},
		];
		const built = form(
			"PrintTplWriteProbe",
			{ TPL_NUMBER: "zlgd_t", TPL_FILE: "build/cand/zlgd_t.meta.json" },
			records,
		);
		expect(built.summary).toBe("整份改写打印模板（1 处差异）");
		expect(built.tables[0]?.rows.map(texts)).toEqual([
			["LayoutCell31(LayoutCell)", ".formulaData", "«批号»", "«批号» ⏎ «炉次»"],
		]);
		expect(built.tables[1]?.columns).toEqual(["控件", "公式", "什么时候", "显示成"]);
		expect(built.tables[1]?.rows.map(texts)).toEqual([
			["LayoutCell31(LayoutCell)", "«批号» ⏎ «炉次»", "字段都空", "/"],
		]);
		expect(built.undo).toContain("meta ptpl restore");
	});

	it("打印模板整份恢复：说的是「恢复成备份里那份」，不是「改了几处属性」", () => {
		const built = form("PrintTplWriteProbe", { TPL_NUMBER: "zlgd_t", TPL_RESTORE: "build/before" }, [
			{ t: "tpl-change", owner: "Text1(Text)", path: ".text", before: "新", after: "旧" },
		]);
		expect(built.summary).toBe("把打印模板恢复成备份里那份（1 处退回）");
		expect(built.head.some((line) => line.label === "恢复自备份目录")).toBe(true);
	});

	it("单据布局：改了什么取自探针逐元素比出来的记录，改动清单原文不当事实；顺延的序号合成一行", () => {
		const built = form(
			"FormLayoutWriteProbe",
			{ LAYOUT_FORM: "zlgd_bill", LAYOUT_EDIT: "set auditor.FontSize=14\nmove auditor into fs_baseinfo" },
			[
				{ t: "layout-change", scope: "布局", element: "auditor", prop: "FontSize", before: "", after: "14" },
				{
					t: "layout-change",
					scope: "布局",
					element: "auditor",
					prop: "所在容器",
					before: "flexpanelap1",
					after: "fs_baseinfo",
				},
				{ t: "layout-change", scope: "字段", element: "zlgd_note", prop: "MustInput", before: "", after: "true" },
				{ t: "layout-shift", count: 3 },
			],
		);
		expect(built.tables[0]?.columns).toEqual(["元素", "改哪里", "原来", "改后"]);
		expect(built.tables[0]?.rows.map(texts)).toEqual([
			["auditor", "FontSize", "（默认）", "14"],
			["auditor", "所在容器", "flexpanelap1", "fs_baseinfo"],
			["zlgd_note（字段）", "MustInput", "（默认）", "true"],
		]);
		expect(built.head.find((line) => line.label === "顺延")?.cells).toEqual([{ text: "另有 3 个控件序号顺延" }]);
		expect(built.summary).toBe("改单据布局 3 处");
		expect(built.impact).toContain("每个布局都跟着变");
		expect(built.slots).toEqual([]);

		const restore = form("FormLayoutWriteProbe", { LAYOUT_FORM: "zlgd_bill", LAYOUT_RESTORE: "d" }, [
			{ t: "layout-change", scope: "布局", element: "auditor", prop: "FontSize", before: "14", after: "" },
		]);
		expect(restore.summary).toBe("把单据布局恢复成备份里那份（1 处退回）");
		expect(restore.impact).not.toContain("每个布局");
	});

	it("单据布局：新增、删除、挂插件那一侧写「—」；操作、列表布局各标一句", () => {
		const built = form(
			"FormLayoutWriteProbe",
			{ LAYOUT_FORM: "zlgd_bill", LAYOUT_EDIT: "add op zlgd_hist donothing 变更历史" },
			[
				{
					t: "layout-change",
					scope: "布局",
					element: "zlgd_pnl",
					prop: "（新增）",
					before: "",
					after: "FlexPanelAp",
				},
				{ t: "layout-change", scope: "布局", element: "zlgd_old", prop: "（删除）", before: "LabelAp", after: "" },
				{
					t: "layout-change",
					scope: "操作",
					element: "zlgd_hist",
					prop: "（新增）",
					before: "",
					after: "Operation donothing",
				},
				{ t: "layout-change", scope: "操作", element: "save", prop: "插件", before: "", after: "zlgd.a.SaveOp" },
				{
					t: "layout-change",
					scope: "布局 ListMeta",
					element: "billlistap",
					prop: "Width",
					before: "",
					after: "100px",
				},
			],
		);
		expect(built.tables[0]?.rows.map(texts)).toEqual([
			["zlgd_pnl", "（新增）", "—", "FlexPanelAp"],
			["zlgd_old", "（删除）", "LabelAp", "—"],
			["zlgd_hist（操作）", "（新增）", "—", "Operation donothing"],
			["save（操作）", "插件", "—", "zlgd.a.SaveOp"],
			["billlistap（列表布局）", "Width", "（默认）", "100px"],
		]);
		expect(built.impact).toContain("（操作）");
		expect(built.impact).not.toContain("派生布局");
	});

	it("单据布局：派生布局由探针查出来写进影响，模型不用猜要不要逐张再改", () => {
		const built = form(
			"FormLayoutWriteProbe",
			{ LAYOUT_FORM: "zlgd_bill", LAYOUT_EDIT: "add BarItemAp zlgd_bar into tbmain 历史" },
			[
				{
					t: "layout-change",
					scope: "布局",
					element: "zlgd_bar",
					prop: "（新增）",
					before: "",
					after: "BarItemAp",
				},
				{ t: "layout-heirs", count: 12, forms: "zlgd_bill_a、zlgd_bill_b 等" },
			],
		);
		expect(built.impact).toContain("派生布局 12 张跟着变（它们自己改过的属性不变）：zlgd_bill_a、zlgd_bill_b 等");
	});

	// 一种类型专用的字段（layouts=<布局>）：确认单要让人看见它只在哪几张显示，别的类型看不到
	it("单据布局：只在部分布局显示的新控件逐个写进影响", () => {
		const built = form(
			"FormLayoutWriteProbe",
			{
				LAYOUT_FORM: "zlgd_bill",
				LAYOUT_EDIT: "add field TextField zlgd_x after zlgd_y X visible=all lock=none layouts=zlgd_bill_a",
			},
			[
				{ t: "layout-change", scope: "字段", element: "zlgd_x", prop: "（新增）", before: "", after: "TextField" },
				{ t: "layout-heirs", count: 2, forms: "zlgd_bill_a、zlgd_bill_b" },
				{ t: "layout-scope", count: 1, items: "zlgd_x→zlgd_bill_a", layouts: 3 },
			],
		);
		expect(built.impact).toContain("只在部分布局显示（其余布局上是隐藏元素）：zlgd_x→zlgd_bill_a");
	});

	it("BOTP：要改的规则取自写入目标，字段映射一行一个，四种取值各写成人话", () => {
		const built = form(
			"BotpRuleSyncProbe",
			{
				SYNC_TARGETS: "r1,r2",
				SYNC_FIELDMAP: "zlgd_a=zlgd_b + 1;zlgd_c=src:org;zlgd_d=const:DJ01;zlgd_e=clear",
			},
			[],
			["botp:r1", "botp:r2"],
		);
		expect(built.names).toEqual(["r1", "r2", "zlgd_a", "zlgd_c", "zlgd_d", "zlgd_e"]);
		expect(built.tables.map((table) => table.columns)).toEqual([
			["转换规则", "规则 id"],
			["目标字段", "标识", "改成"],
		]);
		expect(built.tables[1]?.rows.map((row) => row[2])).toEqual([
			{ text: "公式 zlgd_b + 1" },
			{ text: "取源单字段 org" },
			{ text: "常量（基础资料）DJ01" },
			{ text: "清掉映射（下推时不取值）" },
		]);
	});

	it("BOTP 改建行层级：改前改后、上下游关联、逐行取值的映射都取自探针记录，预演没报就明说", () => {
		const env = { SYNC_TARGETS: "r1", SYNC_LINK: "entryentity->entryentity" };
		const built = form(
			"BotpRuleSyncProbe",
			env,
			[
				{
					t: "botp-link",
					rule: "r1",
					sourceBefore: "表头 zlgd_src",
					sourceAfter: "分录 entryentity（单据体）",
					targetBefore: "表头 zlgd_tgt",
					targetAfter: "分录 entryentity（明细）",
					linkBefore: "zlgd_tgt.billhead_lk",
					linkAfter: "entryentity.entryentity_lk",
					rows: ["zlgd_a <= 源字段 zlgd_b（源字段在 分录 entryentity（单据体））"],
					head: 3,
					others: [],
					plugins: ["zlgd.demo.DemoConvertPlugin"],
				},
			],
			["botp:r1"],
		);
		expect(built.head).toContainEqual({ label: "建行层级改成", cells: [{ text: "entryentity->entryentity" }] });
		expect(built.tables.map((table) => table.columns)).toEqual([
			["转换规则", "规则 id"],
			["规则 id", "源单建行", "目标单建行", "上下游关联"],
			["规则 id", "改后逐行取值的映射"],
		]);
		expect(texts(built.tables[1]?.rows[0])).toEqual([
			"r1",
			"表头 zlgd_src → 分录 entryentity（单据体）",
			"表头 zlgd_tgt → 分录 entryentity（明细）",
			"记在 zlgd_tgt.billhead_lk → 记在 entryentity.entryentity_lk",
		]);
		expect(texts(built.tables[2]?.rows[0])).toEqual([
			"r1",
			"zlgd_a <= 源字段 zlgd_b（源字段在 分录 entryentity（单据体））",
		]);
		expect(built.impact).toContain("逐行取值 1 条、表头 3 条、其他位置 0 条");
		expect(built.impact).toContain("启用的转换插件 1 个照旧执行：zlgd.demo.DemoConvertPlugin");

		const unreported = form("BotpRuleSyncProbe", env, [], ["botp:r1"]);
		expect(texts(unreported.tables[1]?.rows[0])).toEqual(["（预演没报）", "—", "—", "—"]);
	});

	it("业务规则：条件、成立时、不成立时三行，各一格人话、一格原文", () => {
		const built = form("BizRuleProbe", {
			BIZ_ENTITY: "zlgd_bill",
			BIZ_TAG: "金额-",
			BIZ_NAME: "算金额",
			BIZ_CONDITION: "zlgd_qty <> null",
			BIZ_TRUE: "formula:zlgd_amount = zlgd_qty * zlgd_price",
			BIZ_FALSE: "clear:zlgd_amount",
		});
		expect(built.slots.map((slot) => slot.key)).toEqual(["condition", "true", "false"]);
		expect(built.tables[0]?.rows.map((row) => row[2])).toEqual([
			{ text: "zlgd_qty <> null" },
			{ text: "formula:zlgd_amount = zlgd_qty * zlgd_price" },
			{ text: "clear:zlgd_amount" },
		]);
	});

	it("原位改已有业务规则：改前改后、规则名、宿主只取探针的 t=biz-rule-change，条件换了要一格人话", () => {
		const env = {
			BIZ_ENTITY: "zlgd_bill",
			BIZ_RULE: "5Y45GDKB/RP=",
			BIZ_CONDITION: "org.number in ('0101','0301')",
			BIZ_FORMULA: "zlgd_amount = zlgd_qty * zlgd_price * 2",
		};
		const change = (item: string, before: string, after: string) => ({
			t: "biz-rule-change",
			rule: "5Y45GDKB/RP=",
			name: "算金额",
			host: "zlgd_entry",
			item,
			before,
			after,
		});
		const built = form("BizRuleProbe", env, [
			change("条件", "org.number = '0101'", "org.number in ('0101','0301')"),
			change(
				"计算公式 zlgd_amount",
				"zlgd_amount = zlgd_qty * zlgd_price",
				"zlgd_amount = zlgd_qty * zlgd_price * 2",
			),
		]);
		expect(built.head).toContainEqual({ label: "规则", cells: [{ text: "算金额（id 5Y45GDKB/RP=）" }] });
		expect(built.names).toEqual(["zlgd_bill", "zlgd_entry"]);
		expect(built.slots.map((slot) => slot.key)).toEqual(["condition"]);
		expect(built.tables.map((table) => table.columns)).toEqual([["改哪一项", "改前", "改后"]]);
		expect(texts(built.tables[0]?.rows[0])).toEqual(["条件", "org.number = '0101'", "org.number in ('0101','0301')"]);
		expect(built.summary).toBe("改业务规则「算金额」的条件、计算公式 zlgd_amount");
		expect(built.undo).toContain("BIZ_RULE=5Y45GDKB/RP=");

		const unreported = form("BizRuleProbe", { BIZ_ENTITY: "zlgd_bill", BIZ_RULE: "r1", BIZ_ENABLED: "0" });
		expect(unreported.slots).toEqual([]);
		expect(texts(unreported.tables[0]?.rows[0])).toEqual(["（预演没报）", "—", "—"]);
	});

	it("BOTP 改源单过滤、执行条件：改前是平台实际生效的那一条，取自探针的 t=botp-condition", () => {
		const env = { SYNC_TARGETS: "r1", SYNC_RUN_CONDITION: "org.number in ('0101','0301')", SYNC_FILTER: "clear" };
		const built = form(
			"BotpRuleSyncProbe",
			env,
			[
				{ t: "botp-condition", rule: "r1", part: "源单过滤", before: "billstatus = 'C'", after: "" },
				{
					t: "botp-condition",
					rule: "r1",
					part: "执行条件",
					before: "org.number in ('0101')",
					after: "org.number in ('0101','0301')",
				},
			],
			["botp:r1"],
		);
		expect(built.head).toContainEqual({ label: "源单过滤改成", cells: [{ text: "清掉，不再限制" }] });
		expect(built.head).toContainEqual({ label: "执行条件改成", cells: [{ text: "org.number in ('0101','0301')" }] });
		expect(built.slots.map((slot) => slot.key)).toEqual(["condition"]);
		expect(built.tables.map((table) => table.columns)).toEqual([
			["转换规则", "规则 id"],
			["规则 id", "哪一处", "改前（下推时实际生效的条件）", "改后"],
		]);
		expect(texts(built.tables[1]?.rows[0])).toEqual(["r1", "源单过滤", "billstatus = 'C'", "（清掉，不再限制）"]);
		expect(built.impact).toContain("原来的条件行清空");

		const onlyClear = form("BotpRuleSyncProbe", { SYNC_TARGETS: "r1", SYNC_FILTER: "CLEAR" }, [], ["botp:r1"]);
		expect(onlyClear.slots).toEqual([]);
		expect(texts(onlyClear.tables[1]?.rows[0])).toEqual(["（预演没报）", "—", "—", "—"]);
	});
});

describe("S23 数据", () => {
	it("改数据：编号、字段名、原值、新值全来自探针的 t=data-change；单据名探针报了就不要模型填", () => {
		const built = form(
			"DataUpdateProbe",
			{ UPD_ENTITY: "zlgd_wtd", UPD_WHERE: "billstatus = A", UPD_SET: "zlgd_jyjl=2", UPD_OP: "direct" },
			[
				{ t: "data-entity", entity: "zlgd_wtd", name: "检验委托单" },
				{ t: "data-change", label: "WTD-1", pk: "1", name: "检验结论", before: "空", after: "不合格" },
				{ t: "data-change", label: "WTD-2", pk: "2", name: "检验结论", before: "合格", after: "不合格" },
			],
		);
		expect(built.names).toEqual([]);
		expect(built.known).toEqual({ zlgd_wtd: "检验委托单" });
		expect(built.summary).toBe("修改 2 条数据");
		expect(built.head).toContainEqual({ label: "保存方式", cells: [{ text: "直接存库（不走校验器和插件）" }] });
		expect(built.impact).toContain("不走校验器和插件");
		expect(built.tables[0]?.group).toBe(true);
		expect(built.tables[0]?.rows.map(texts)).toEqual([
			["WTD-1", "检验结论", "空", "不合格"],
			["WTD-2", "检验结论", "合格", "不合格"],
		]);
	});

	it("造数据没有探针记录时退回按入参排，字段标识的中文名要模型给", () => {
		const built = form("DataSeedProbe", {
			SEED_ENTITY: "zlgd_wtd",
			SEED_ROWS: "[row] A\nset=zlgd_org=100;zlgd_qty=2\n[row] B\nset=zlgd_org=101",
		});
		expect(built.summary).toBe("新建 2 条数据");
		expect(built.names).toEqual(["zlgd_wtd", "zlgd_org", "zlgd_qty"]);
		expect(
			built.tables[0]?.rows.map((row) => ("text" in (row[0] ?? {}) ? (row[0] as { text: string }).text : "")),
		).toEqual(["A", "A", "B"]);
	});
});

it("批量规则确认单完整列出修改与删除", () => {
	const built = form("FormRuleProbe", { RULE_FORM: "demo_form", RULE_BATCH: "update|r1|a=1|a=2;delete|r2|b=1" });
	expect(built.summary).toContain("2 条");
	expect(texts(built.tables[0]?.rows[0])).toEqual(["修改条件", "r1", expect.anything(), "a=1", "a=2"]);
	expect(texts(built.tables[0]?.rows[1])).toEqual(["删除", "r2", expect.anything(), "b=1", "（删除整条规则）"]);
});
