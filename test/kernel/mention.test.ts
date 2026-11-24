/**
 * 输入框 `@` 引用的目录：扩展设计折到原单上、按编号和中文名找、往一张单里钻、
 * 发给模型的那段写准位置（哪张单、表头还是哪条分录、什么类型、挂了哪些插件）。
 */
import { describe, expect, it } from "vitest";
import {
	buildMentionCatalog,
	describeMention,
	type FormCatalog,
	formCatalogOf,
	MENTION_TAG,
	mentionBlock,
	mentionHint,
	mentionLabel,
	parseMentionQuery,
	runtimeFieldsOf,
	searchMentions,
} from "../../src/kernel/impact/mention.ts";
import type { ImpactIndex } from "../../src/kernel/impact/model.ts";

const forms: FormCatalog = {
	kind: "FormCatalog",
	at: "2026-01-01T00:00:00.000Z",
	ms: 1,
	forms: [
		{ n: "demo_saloutbill", m: "BillFormModel", i: "kingdee", p: "demo_outbilltpl", name: "销售出库单" },
		{ n: "demox_demo_saloutbill_ext", m: "BillFormModel", i: "demox", b: "demo_saloutbill", name: "销售出库单" },
		{
			n: "demox_saloutbill_mob",
			m: "BillFormModel",
			i: "demox",
			e: "demo_saloutbill",
			p: "demo_saloutbill",
			name: "销售出库单（移动）",
		},
		{ n: "demo_salorder", m: "BillFormModel", i: "kingdee", name: "销售订单" },
		{ n: "demo_salorder_mobview", m: "MobileFormModel", i: "kingdee", name: "销售订单" },
		{ n: "demox_pick", m: "DynamicFormModel", i: "demox", name: "选料弹窗" },
	],
};

function index(): ImpactIndex {
	return {
		kind: "ImpactIndex",
		at: "2026-01-01T00:00:00.000Z",
		meta: { at: "2026-01-01T00:00:00.000Z" },
		fieldIsv: "demox",
		billNames: [{ bill: "demox_demo_saloutbill_ext", name: "销售出库单", base: "demo_saloutbill" }],
		fields: [
			{
				entity: "demox_demo_saloutbill_ext",
				key: "demox_dept",
				level: "header",
				name: "申请部门",
				type: "OrgField",
			},
			{
				entity: "demox_demo_saloutbill_ext",
				key: "billentry",
				level: "entry",
				entry: "billentry",
				kind: "container",
				name: "物料明细",
			},
			{
				entity: "demox_demo_saloutbill_ext",
				key: "demox_batch",
				level: "entry",
				entry: "billentry",
				name: "批号",
				type: "TextField",
			},
			{ entity: "demox_other", key: "demox_dept", level: "header", name: "部门" },
		],
		fieldOwners: { demox_dept: 2 },
		templates: [],
		classes: [
			{
				class: "demox.plugin.SalOutEdit",
				file: "src/demox/plugin/SalOutEdit.java",
				pluginType: "form",
				bindings: [
					{
						entity: "demo_saloutbill",
						kind: "form",
						layouts: 1,
						enabled: true,
						numbers: ["demo_saloutbill", "demox_saloutbill_mob"],
					},
				],
				entities: [],
				fields: [],
				chain: [],
			},
		],
		entityRefs: [],
		fieldRefs: [],
	} as unknown as ImpactIndex;
}

describe("目录", () => {
	it("扩展设计折到原单编号上，不单列一项；它加的字段挂在原单下", () => {
		const catalog = buildMentionCatalog({ index: index(), forms, runtime: [] });
		expect(catalog.byId.has("demox_demo_saloutbill_ext")).toBe(false);
		expect(catalog.byId.get("demo_saloutbill")?.ext).toEqual(["demox_demo_saloutbill_ext"]);
		const field = catalog.byId.get("demo_saloutbill.billentry.demox_batch");
		expect(field?.ext).toEqual(["demox_demo_saloutbill_ext"]);
		expect(catalog.byId.get("demox_saloutbill_mob")?.kind).toBe("layout");
		expect(catalog.byId.get("demox_pick")?.kind).toBe("form");
	});

	it("按中文名找：一个字也找；本工程碰过的单据排在前面", () => {
		const catalog = buildMentionCatalog({ index: index(), forms, runtime: [] });
		const ids = searchMentions(catalog, "销售出库").map((it) => it.id);
		expect(ids[0]).toBe("demo_saloutbill");
		expect(ids).toContain("demox_saloutbill_mob");
		expect(searchMentions(catalog, "批").map((it) => it.id)).toContain("demo_saloutbill.billentry.demox_batch");
	});

	it("一个英文字母不找；编号全等排第一", () => {
		const catalog = buildMentionCatalog({ index: index(), forms, runtime: [] });
		expect(searchMentions(catalog, "d")).toEqual([]);
		expect(searchMentions(catalog, "demox_dept")[0]?.key).toBe("demox_dept");
	});

	it("「单据.」只在这张单里找；同名的单不止一张就先列单，不替人挑", () => {
		const catalog = buildMentionCatalog({ index: index(), forms, runtime: [] });
		expect(parseMentionQuery(catalog, "销售出库单.批").scope).toBe("demo_saloutbill");
		// 没敲词只列这一层：表头字段和第一层分录；分录里的字段要再钻
		const inBill = searchMentions(catalog, "demo_saloutbill.");
		expect(inBill.map((it) => it.id)).toEqual(["demo_saloutbill.billentry", "demo_saloutbill.demox_dept"]);
		// 敲了词就整张单里找，分录里的字段也找得到
		expect(searchMentions(catalog, "demo_saloutbill.批").map((it) => it.id)).toEqual([
			"demo_saloutbill.billentry.demox_batch",
		]);
		// 单据和同名的移动表单：叫这个名字的单据只有一张，就是它
		expect(parseMentionQuery(catalog, "销售订单.x").scope).toBe("demo_salorder");
		// 两张单据同名：先列出来，不替人挑
		const twin = buildMentionCatalog({
			index: index(),
			forms: {
				...forms,
				forms: [...forms.forms, { n: "demo_salorder2", m: "BillFormModel", i: "kingdee", name: "销售订单" }],
			},
			runtime: [],
		});
		const ambiguous = searchMentions(twin, "销售订单.x");
		expect(ambiguous.map((it) => it.id).sort()).toEqual(["demo_salorder", "demo_salorder2", "demo_salorder_mobview"]);
	});
});

describe("发给模型的那段", () => {
	it("字段：工具认的写法、在哪条分录、类型、所在单据和扩展设计、挂的插件、来源", () => {
		const catalog = buildMentionCatalog({ index: index(), forms, runtime: [] });
		const text = describeMention(catalog, "demo_saloutbill.billentry.demox_batch") ?? "";
		expect(text).toContain(
			"字段 demo_saloutbill.billentry.demox_batch「批号」，TextField，在分录 billentry「物料明细」",
		);
		expect(text).toContain(
			"单据 demo_saloutbill「销售出库单」，ISV kingdee，本 ISV 扩展设计 demox_demo_saloutbill_ext",
		);
		expect(text).toContain("demox.plugin.SalOutEdit（表单插件）");
		expect(text).toContain("来源：代码关系表的元数据快照");
	});

	it("同一个标识在别的单上也有时说出来，并给出指这张单的写法", () => {
		const catalog = buildMentionCatalog({ index: index(), forms, runtime: [] });
		expect(describeMention(catalog, "demo_saloutbill.demox_dept")).toContain(
			"标识 demox_dept 全库 2 张单上都有，指这张单要写成 demo_saloutbill.demox_dept",
		);
	});

	it("运行态查过的单：继承来的字段也在，类型和基础资料指向按运行态", () => {
		const runtime = runtimeFieldsOf(
			[
				{ t: "entity", key: "demo_saloutbill", name: "销售出库单" },
				{ t: "entry", key: "billentry", name: "物料明细", level: "entry", parentEntry: "" },
				{
					t: "field",
					key: "material",
					name: "物料",
					type: "BasedataProp",
					level: "entry",
					entry: "billentry",
					base: "bd_material",
				},
				{ t: "field", key: "demox_dept", name: "申请部门", type: "OrgProp", level: "header", base: "bos_org" },
			],
			"2026-01-02T00:00:00.000Z",
		);
		expect(runtime).not.toBeNull();
		const catalog = buildMentionCatalog({ index: index(), forms, runtime: runtime ? [runtime] : [] });
		const text = describeMention(catalog, "demo_saloutbill.billentry.material") ?? "";
		expect(text).toContain("BasedataProp→bd_material，在分录 billentry「物料明细」");
		expect(text).toContain("来源：运行态元数据");
		// 运行态压过快照，但扩展设计加的那一条记号留着
		expect(describeMention(catalog, "demo_saloutbill.demox_dept")).toContain(
			"这个字段由扩展设计 demox_demo_saloutbill_ext 加上",
		);
	});

	it("现查过运行态的单整张按运行态：快照把扩展字段错标成表头时，不再多出一条表头的", () => {
		const idx = index();
		// 扩展设计往原单分录上加的字段：上级分录只在原单设计里，快照认成了表头
		idx.fields.push({ entity: "demox_demo_saloutbill_ext", key: "demox_mkt", level: "header", name: "定价市场" });
		const runtime = runtimeFieldsOf(
			[
				{ t: "entity", key: "demo_saloutbill", name: "销售出库单" },
				{ t: "entry", key: "billentry", name: "物料明细", level: "entry" },
				{
					t: "field",
					key: "demox_mkt",
					name: "定价市场",
					type: "AssistantProp",
					level: "entry",
					entry: "billentry",
				},
			],
			"t",
		);
		const catalog = buildMentionCatalog({ index: idx, forms, runtime: runtime ? [runtime] : [] });
		expect(catalog.byId.has("demo_saloutbill.demox_mkt")).toBe(false);
		const text = describeMention(catalog, "demo_saloutbill.billentry.demox_mkt") ?? "";
		expect(text).toContain("在分录 billentry「物料明细」");
		expect(text).toContain("这个字段由扩展设计 demox_demo_saloutbill_ext 加上");
	});

	it("快照认不出位置的字段，照实说认不出，不说成表头", () => {
		const idx = index();
		idx.fields.push({ entity: "demox_demo_saloutbill_ext", key: "demox_mkt", level: "unknown", name: "定价市场" });
		const catalog = buildMentionCatalog({ index: idx, forms, runtime: [] });
		expect(describeMention(catalog, "demo_saloutbill.demox_mkt")).toContain("「定价市场」，认不出在表头还是哪条分录");
	});

	it("布局：属于哪张单、上级设计、登记在这份布局上的插件", () => {
		const catalog = buildMentionCatalog({ index: index(), forms, runtime: [] });
		const text = describeMention(catalog, "demox_saloutbill_mob") ?? "";
		expect(text).toContain("布局 demox_saloutbill_mob「销售出库单（移动）」，是单据 demo_saloutbill「销售出库单」");
		expect(text).toContain("上级设计 demo_saloutbill");
		expect(text).toContain("SalOutEdit");
		expect(mentionHint(catalog.byId.get("demox_saloutbill_mob")!, catalog)).toContain("销售出库单的布局");
	});

	it("目录里没有的不编", () => {
		const catalog = buildMentionCatalog({ index: index(), forms, runtime: [] });
		expect(describeMention(catalog, "demo_nothing.x")).toBeNull();
	});

	it("引用块的属性转义，界面认的标签就是这一个", () => {
		const block = mentionBlock('销售"出库"<单>', "demo_a.b", "正文");
		expect(block).toBe(`<${MENTION_TAG} id="demo_a.b" label="销售&quot;出库&quot;&lt;单>">\n正文\n</${MENTION_TAG}>`);
	});
});

describe("探针旁路", () => {
	it("表单目录：没有汇总行不收；停用的不进", () => {
		expect(formCatalogOf([{ t: "form", n: "a", m: "BillFormModel", i: "x" }], "t", 1)).toBeNull();
		const got = formCatalogOf(
			[
				{ t: "form", n: "a", m: "BillFormModel", i: "x", e: "", p: "", b: "", name: "甲", off: 0 },
				{ t: "form", n: "b", m: "BillFormModel", i: "x", off: 1 },
				{ t: "form-summary", forms: 2 },
			],
			"t",
			1,
		);
		expect(got?.forms).toEqual([{ n: "a", m: "BillFormModel", i: "x", name: "甲" }]);
	});

	it("运行态字段：没有实体行就不算读到", () => {
		expect(runtimeFieldsOf([{ t: "field", key: "a" }], "t")).toBeNull();
	});

	it("往分录、子分录里钻：按标识或中文名认，只列这一层下的字段和子分录", () => {
		const runtime = runtimeFieldsOf(
			[
				{ t: "entity", key: "demo_saloutbill", name: "销售出库单" },
				{ t: "field", key: "billno", name: "单据编号", type: "TextProp", level: "header" },
				{ t: "entry", key: "billentry", name: "物料明细", level: "entry", parentEntry: "" },
				{ t: "field", key: "material", name: "物料", type: "BasedataProp", level: "entry", entry: "billentry" },
				{ t: "entry", key: "subentry", name: "序列号", level: "subentry", parentEntry: "billentry" },
				{
					t: "field",
					key: "sn",
					name: "序列号",
					type: "TextProp",
					level: "subentry",
					entry: "subentry",
					parentEntry: "billentry",
				},
				{ t: "entry", key: "costentry", name: "费用明细", level: "entry", parentEntry: "" },
				{ t: "field", key: "fee", name: "费用", type: "AmountProp", level: "entry", entry: "costentry" },
			],
			"t",
		);
		const catalog = buildMentionCatalog({ index: null, forms, runtime: runtime ? [runtime] : [] });
		const ids = (q: string) => searchMentions(catalog, q).map((it) => it.id);
		expect(ids("demo_saloutbill.")).toEqual([
			"demo_saloutbill.billentry",
			"demo_saloutbill.costentry",
			"demo_saloutbill.billno",
		]);
		expect(parseMentionQuery(catalog, "销售出库单.物料明细.物").path).toEqual(["billentry"]);
		expect(ids("demo_saloutbill.billentry.")).toEqual([
			"demo_saloutbill.billentry.subentry",
			"demo_saloutbill.billentry.material",
		]);
		expect(ids("销售出库单.物料明细.物")).toEqual(["demo_saloutbill.billentry.material"]);
		expect(ids("demo_saloutbill.billentry.subentry.")).toEqual(["demo_saloutbill.billentry.subentry.sn"]);
		// 钻进一条分录敲词：别的分录上的不出来
		expect(ids("demo_saloutbill.billentry.费")).toEqual([]);
	});

	it("分录很多的单：表头字段照样全列出来；子分录说清挂在哪条分录下，单据和分录的说明里写出父子关系", () => {
		// 真机 zlgd_sys_test_bill：39 条分录、表头 362 个字段，曾经只列出分录和一个表头字段
		const records: Record<string, unknown>[] = [{ t: "entity", key: "demo_testbill", name: "检测单" }];
		for (let i = 0; i < 45; i++) records.push({ t: "entry", key: `demo_e${i}`, name: `分录${i}`, level: "entry" });
		records.push({ t: "entry", key: "demo_e0_lk", name: "关联子实体", level: "subentry", parentEntry: "demo_e0" });
		records.push({ t: "entry", key: "demo_sub", name: "结果值", level: "subentry", parentEntry: "demo_e1" });
		records.push({ t: "entry", key: "billhead_lk", name: "关联子实体", level: "entry" });
		for (let i = 0; i < 60; i++)
			records.push({ t: "field", key: `demo_h${i}`, name: `表头${i}`, type: "TextProp", level: "header" });
		records.push({
			t: "field",
			key: "demo_v",
			name: "值",
			type: "DecimalProp",
			level: "subentry",
			entry: "demo_sub",
			parentEntry: "demo_e1",
		});
		const runtime = runtimeFieldsOf(records, "t");
		const catalog = buildMentionCatalog({ index: null, forms, runtime: runtime ? [runtime] : [] });
		const top = searchMentions(catalog, "demo_testbill.");
		expect(top.filter((it) => it.kind === "field")).toHaveLength(60);
		expect(top.filter((it) => it.kind === "entry")).toHaveLength(46);
		// 平台生成的关联子实体排在最后
		expect(top.at(-1)?.key).toBe("billhead_lk");
		const sub = catalog.byId.get("demo_testbill.demo_e1.demo_sub");
		expect(sub && mentionLabel(sub, catalog)).toBe("检测单.分录1.结果值");
		expect(sub && mentionHint(sub, catalog)).toBe(
			"demo_testbill.demo_e1.demo_sub · 分录 demo_e1「分录1」 下的子分录 · 字段 1 个",
		);
		const e1 = catalog.byId.get("demo_testbill.demo_e1");
		expect(e1 && mentionHint(e1, catalog)).toBe("demo_testbill.demo_e1 · 检测单的分录 · 子分录 1 条 · 字段 0 个");
		expect(describeMention(catalog, "demo_testbill.demo_e1")).toContain("下面的子分录 1 条：demo_sub「结果值」");
		expect(describeMention(catalog, "demo_testbill")).toContain("demo_e1「分录1」（子分录 demo_sub「结果值」）");
	});

	it("钻进一张单还没敲字：分录在前，字段按单据里的顺序，没有中文名的内部属性放最后（缓存里字面的 null 当没名字）", () => {
		const runtime = runtimeFieldsOf(
			[
				{ t: "entity", key: "demo_saloutbill", name: "销售出库单" },
				{ t: "field", key: "id", name: "null", type: "LongProp", level: "header" },
				{ t: "field", key: "org", name: "库存组织", type: "MainOrgProp", level: "header" },
				{ t: "field", key: "billno", name: "单据编号", type: "TextProp", level: "header" },
				{ t: "entry", key: "billentry", name: "物料明细", level: "entry" },
			],
			"t",
		);
		expect(runtime?.fields[0]?.name).toBe("");
		const catalog = buildMentionCatalog({ index: null, forms, runtime: runtime ? [runtime] : [] });
		expect(searchMentions(catalog, "demo_saloutbill.").map((it) => it.key)).toEqual([
			"billentry",
			"org",
			"billno",
			"id",
		]);
	});
});
