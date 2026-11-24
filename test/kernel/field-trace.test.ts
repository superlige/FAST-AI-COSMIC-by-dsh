/**
 * S17 batch 1 -- a field entry point answers with its read/write sites, each
 * line number, and the call path back to the plugin registered on a bill.
 */

import { describe, expect, it } from "vitest";
import { impact } from "../../src/kernel/commands/impact.ts";
import { formatTrace, traceField } from "../../src/kernel/impact/field-trace.ts";
import {
	type ImpactIndex,
	lookup,
	type MetaIndex,
	mergeIndex,
	resolveTarget,
	type SrcIndex,
	type SrcRef,
} from "../../src/kernel/impact/model.ts";
import { makeContext } from "./fake-context.ts";

const site = (cls: string, method: string, field: string, line: number, access = "write"): SrcRef => ({
	class: `com.demo.${cls}`,
	field,
	access,
	resolution: "literal",
	inMethod: `com.demo.${cls}#${method}()`,
	line,
	via: access === "write" ? "IDataModel#setValue(String, Object)" : "IDataModel#getValue(String)",
});

const edge = (from: string, to: string, line: number) => ({
	from: `com.demo.${from}()`,
	to: `com.demo.${to}()`,
	fromClass: `com.demo.${from.split("#")[0]}`,
	toClass: `com.demo.${to.split("#")[0]}`,
	line,
	count: 1,
});

const src: SrcIndex = {
	kind: "SrcIndex",
	at: "2026-09-01T00:00:00.000Z",
	ms: 1,
	files: 5,
	calls: { total: 1, unbound: 0 },
	classes: [
		{ class: "com.demo.QtyPlugin", file: "src/QtyPlugin.java", pluginType: "form" },
		{ class: "com.demo.Util", file: "src/Util.java", pluginType: null },
		{ class: "com.demo.Orphan", file: "src/Orphan.java", pluginType: null },
		{ class: "com.demo.LostOp", file: "src/LostOp.java", pluginType: "op" },
		{ class: "com.demo.Helper", file: "src/Helper.java", pluginType: null },
		{ class: "com.demo.OtherPlugin", file: "src/OtherPlugin.java", pluginType: "op" },
	],
	entityRefs: [{ class: "com.demo.OtherPlugin", entity: "zlgd_qty", access: "read", resolution: "literal" }],
	fieldRefs: [
		site("QtyPlugin", "propertyChanged", "zlgd_a", 40),
		site("QtyPlugin", "propertyChanged", "zlgd_a", 44, "read"),
		site("Util", "write", "zlgd_a", 30),
		site("Orphan", "run", "zlgd_a", 8),
		site("LostOp", "beforeExecute", "zlgd_a", 20),
		site("Helper", "save", "zlgd_a", 5),
		site("QtyPlugin", "propertyChanged", "zlgd_b", 60),
		site("QtyPlugin", "propertyChanged", "zlgd_d", 70),
		site("QtyPlugin", "recalc", "zlgd_a", 90),
		site("OtherPlugin", "beforeExecute", "zlgd_a", 3, "read"),
	],
	edges: [
		edge("QtyPlugin#propertyChanged", "Util#fill", 55),
		edge("Util#fill", "Util#write", 12),
		edge("LostOp#afterExecute", "Helper#save", 33),
		edge("QtyPlugin#propertyChanged", "QtyPlugin#recalc", 50),
	],
	unknownSigs: [],
};

const meta: MetaIndex = {
	kind: "MetaIndex",
	at: "2026-09-23T00:00:00.000Z",
	ms: 1,
	scanned: 1,
	bindings: [
		{ class: "com.demo.QtyPlugin", entity: "zlgd_qty", kind: "form" },
		{ class: "com.demo.OtherPlugin", entity: "zlgd_other", kind: "entity" },
	],
	templates: [],
	fields: [
		{ entity: "zlgd_qty", key: "zlgd_a", level: "header" },
		{ entity: "zlgd_other", key: "zlgd_b", level: "entry", entry: "zlgd_e1" },
		{ entity: "zlgd_x", key: "zlgd_c", level: "header" },
		{ entity: "zlgd_y", key: "zlgd_c", level: "header" },
		{ entity: "zlgd_qty", key: "zlgd_d", level: "header" },
		{ entity: "zlgd_snap", key: "zlgd_d", level: "header" },
	],
	fieldOwners: { zlgd_a: 1, zlgd_b: 1, zlgd_c: 2, zlgd_d: 2 },
	fieldsMs: 1,
};

const index = (extra: Partial<MetaIndex> = {}): ImpactIndex => mergeIndex(src, { ...meta, ...extra });

/** A snapshot that can say "not on this bill": own fields all collected, zlgd_qty built on a platform template only. */
const complete: Partial<MetaIndex> = {
	fieldsAll: true,
	fieldBases: { zlgd_qty: { outside: "bos_billtpl" } },
	fieldIsv: "zlgd",
};

const answer = (term: string, extra: Partial<MetaIndex> = {}): string => {
	const idx = index(extra);
	const lk = lookup(idx);
	const [target] = resolveTarget(idx, term, lk).filter((t) => t.kind === "field");
	if (!target) throw new Error(`没认出 ${term}`);
	return formatTrace(traceField(idx, lk, target), lk).join("\n");
};

describe("字段入口：读写处清单", () => {
	it("挂载插件里的读写处直接带行号和写法", () => {
		const text = answer("zlgd_qty.zlgd_a");
		expect(text).toContain("字段 zlgd_qty.zlgd_a（表头）：写 6 处、读 2 处");
		expect(text).toContain("─ QtyPlugin [form，挂 zlgd_qty]  src/QtyPlugin.java");
		expect(text).toContain("QtyPlugin#propertyChanged:40 写 setValue；44 读 getValue");
	});

	it("经两层调用才写到的，从插件那一行起每层方法和行号都列出", () => {
		expect(answer("zlgd_qty.zlgd_a")).toContain(
			"QtyPlugin#propertyChanged:55 → Util#fill:12 → Util#write:30 写 setValue",
		);
	});

	it("插件里经自己的方法写到的，往上追到平台调的那个事件方法", () => {
		expect(answer("zlgd_qty.zlgd_a")).toContain("QtyPlugin#propertyChanged:50 → QtyPlugin#recalc:90 写 setValue");
	});

	it("挂在这张单上的插件排在前面", () => {
		const text = answer("zlgd_qty.zlgd_a");
		expect(text.indexOf("─ QtyPlugin")).toBeLessThan(text.indexOf("─ OtherPlugin"));
	});

	it("找不到挂载插件时分三种原因说", () => {
		const text = answer("zlgd_qty.zlgd_a");
		expect(text).toContain("Orphan#run:8 写 setValue —— Orphan#run 没人调用");
		expect(text).toContain(
			"LostOp#beforeExecute:20 写 setValue —— LostOp 是 op 插件，没登记在任何单据上（快照 09-23）",
		);
		expect(text).toContain("Helper#save:5 写 setValue —— 往上到 LostOp 是 op 插件，没登记在任何单据上");
		expect(text).toContain("文件  ");
		expect(text).toContain("Helper src/Helper.java");
	});

	it("不再列这些类碰过的别的字段", () => {
		expect(answer("zlgd_qty.zlgd_a")).not.toContain("zlgd_b");
	});
});

describe("「单据.字段」对不上", () => {
	it("字段只在另一张单上：说出来，按那张单列", () => {
		const text = answer("zlgd_qty.zlgd_b", complete);
		expect(text).toContain("字段 zlgd_other.zlgd_b（分录 zlgd_e1）");
		expect(text).toContain("zlgd_b 不在 zlgd_qty 上，在 zlgd_other（快照 09-23）");
	});

	it("快照说不清这张单继承了什么时，不把人引到别的单上", () => {
		// 旧快照没记继承：zlgd_b 可能是 zlgd_qty 从本 ISV 模板继承来的
		expect(answer("zlgd_qty.zlgd_b")).not.toContain("不在 zlgd_qty 上");
		// 继承自本 ISV 的模板、模板的字段没收进来：同样说不清
		const text = answer("zlgd_qty.zlgd_b", {
			...complete,
			fieldBases: { zlgd_qty: { parents: ["zlgd_basetpl"], outside: "bos_billtpl" } },
		});
		expect(text).not.toContain("不在 zlgd_qty 上");
		expect(text).toContain("zlgd_qty 继承自 zlgd_basetpl、bos_billtpl，继承来的字段快照里不收");
	});

	it("继承自原厂模板的字段（不带本 ISV 前缀）不说「不在这张单上」", () => {
		// 真机：zlgd_sys_test_bill.billno 在 bos_billtpl 上，全库只有几张单在自己的设计里重写了它
		const text = answer("zlgd_qty.billno", {
			...complete,
			fields: [...meta.fields, { entity: "zlgd_other", key: "billno", level: "header" }],
			fieldOwners: { ...meta.fieldOwners, billno: 1 },
		});
		expect(text).not.toContain("billno 不在 zlgd_qty 上");
		expect(text).toContain("快照没记到 zlgd_qty 上有 billno；zlgd_qty 继承自 bos_billtpl，继承来的字段快照里不收");
	});

	it("字段在别的几张单上：列出来，不列读写处", () => {
		const idx = index(complete);
		const lk = lookup(idx);
		const text = formatTrace(traceField(idx, lk, { kind: "field", value: "zlgd_c", entity: "zlgd_qty" }), lk).join(
			"\n",
		);
		expect(text).toContain("zlgd_c 不在 zlgd_qty 上（快照 09-23）；有它的单：zlgd_x（表头）、zlgd_y（表头）");
		expect(text).not.toContain("写 ");
	});

	it("扩展设计加的字段按原单编号问：认得，不说「不在这张单上」；位置没认出就不核分录", () => {
		// 真机：sm_salorder 的扩展字段 zlgd_ljjdjsc 快照记在 zlgd_sm_salorder_ext 上，按 sm_salorder 问曾报「不在 sm_salorder 上」
		const extra: Partial<MetaIndex> = {
			...complete,
			billNames: [{ bill: "zlgd_demo_salorder_ext", name: "销售订单", base: "demo_salorder" }],
			fields: [
				...meta.fields,
				{ entity: "zlgd_demo_salorder_ext", key: "zlgd_m", level: "unknown" },
				{ entity: "zlgd_x", key: "zlgd_m", level: "header" },
			],
			fieldOwners: { ...meta.fieldOwners, zlgd_m: 2 },
		};
		for (const term of ["demo_salorder.zlgd_m", "demo_salorder.billentry.zlgd_m"]) {
			const text = answer(term, extra);
			expect(text).not.toContain("不在 demo_salorder");
			expect(text).not.toContain("不在 billentry");
			expect(text).toContain("字段 demo_salorder.zlgd_m（快照认不出在表头还是哪条分录）");
		}
	});

	it("单据只在快照里有、没有类按名字加载它：照样认出来", () => {
		expect(resolveTarget(index(), "zlgd_snap.zlgd_d")).toEqual([
			{ kind: "field", value: "zlgd_d", entity: "zlgd_snap" },
		]);
		expect(answer("zlgd_snap.zlgd_d")).toContain(
			"另有 1 处同名标识，所在的类和它的插件都没碰过 zlgd_snap，没列：QtyPlugin 1 处（挂 zlgd_qty）",
		);
	});
});

describe("一次查几个词", () => {
	it("认不出的逐个报出来，认出的照样回答", async () => {
		const fake = makeContext();
		fake.fs.put(fake.ctx.layout.impactIndex, JSON.stringify(index()));
		const result = await impact(fake.ctx, {
			terms: ["zlgd_qty.zlgd_a", "zlgd_nope.zlgd_a", "zlgd_qty.zlgd_nothing_like"],
		});
		if (!result.ok || result.value.action !== "query") throw new Error("query failed");
		expect(result.value.unknown?.map((row) => row.term)).toEqual(["zlgd_nope.zlgd_a", "zlgd_qty.zlgd_nothing_like"]);
		expect(result.value.unknown?.[0]?.why).toContain("字段 zlgd_a 已在索引中");
		expect(result.value.unknown?.[0]?.why).toContain('cosmic_impact terms=["zlgd_a"]');
		expect(result.value.unknown?.[1]?.why).toBe("字段 zlgd_nothing_like 在当前索引中未记到");
		expect(result.value.text).toContain("没认出：zlgd_nope.zlgd_a");
		expect(result.value.text).toContain("Util#write:30");
		expect(result.value.impact.classes).toContain("com.demo.Util");
	});
});

describe("字段限定写错时给可执行的重查入口", () => {
	const refused = async (term: string, idx = index()) => {
		const fake = makeContext();
		fake.fs.put(fake.ctx.layout.impactIndex, JSON.stringify(idx));
		const result = await impact(fake.ctx, { terms: [term] });
		if (result.ok) throw new Error("限定写错时应拒绝，不能偷偷放宽范围");
		expect(result.error.code).toBe("IMPACT_TARGET_UNKNOWN");
		return result.error;
	};

	it("分录写在首段：解释格式，并给能真实查到读写的字段命令", async () => {
		const error = await refused("zlgd_e1.zlgd_b");
		expect(error.message).toContain("查询写法或标识未对上索引");
		expect(error.remedy).toContain("首段「zlgd_e1」未识别为单据实体");
		expect(error.remedy).toContain("字段 zlgd_b 已在索引中");
		expect(error.remedy).toContain("单据实体.zlgd_e1.zlgd_b");
		expect(error.remedy).toContain('cosmic_impact terms=["zlgd_b"]');
		expect(error.remedy).toContain("跨单据的同名读写");
		expect(answer("zlgd_b")).toContain("QtyPlugin#propertyChanged:60");
	});

	it("没有快照：承认归属未知，保留源码里已知的字段线索", async () => {
		const error = await refused("zlgd_e1.zlgd_a", mergeIndex(src, null));
		expect(error.remedy).toContain("当前没有元数据快照，不能据此判断单据或字段不存在");
		expect(error.remedy).toContain('cosmic_impact terms=["zlgd_a"]');
		expect(error.remedy).not.toContain("快照里也没有");
	});

	it("子分录写在中间：补单据示例保留所有已有段", async () => {
		const error = await refused("zlgd_e1.zlgd_sub.zlgd_a");
		expect(error.remedy).toContain("单据实体.zlgd_e1.zlgd_sub.zlgd_a");
	});

	it("字段也未知：不提供查不到的精确重查命令", async () => {
		const error = await refused("zlgd_nope.zlgd_nothing_like");
		expect(error.remedy).toContain("字段 zlgd_nothing_like 在当前索引中未记到");
		expect(error.remedy).not.toContain("cosmic_impact terms=");
	});

	it("单据已知而字段拼错：保留相近字段，不误报首段或给补单据示例", async () => {
		const error = await refused("zlgd_qty.zlgd_aa");
		expect(error.remedy).toContain("相近的字段 zlgd_a");
		expect(error.remedy).not.toContain("首段");
		expect(error.remedy).not.toContain("请补上所属单据");
	});
});

describe("分录、子分录和点号路径", () => {
	const entrySrc: SrcIndex = {
		...src,
		fieldRefs: [
			site("QtyPlugin", "afterBindData", "zlgd_e1.zlgd_sub.zlgd_no", 21, "read"),
			site("QtyPlugin", "afterBindData", "zlgd_org.number", 25, "read"),
			site("QtyPlugin", "afterBindData", "zlgd_org", 26),
			site("QtyPlugin", "afterBindData", "zlgd_other.number", 27, "read"),
		],
		edges: [],
	};
	const entryMeta: MetaIndex = {
		...meta,
		fields: [
			{ entity: "zlgd_qty", key: "zlgd_e1", level: "entry", entry: "zlgd_e1", kind: "container" },
			{
				entity: "zlgd_qty",
				key: "zlgd_sub",
				level: "subentry",
				entry: "zlgd_sub",
				parentEntry: "zlgd_e1",
				kind: "container",
			},
			{ entity: "zlgd_qty", key: "zlgd_no", level: "subentry", entry: "zlgd_sub", parentEntry: "zlgd_e1" },
			{ entity: "zlgd_qty", key: "zlgd_org", level: "header" },
		],
		fieldOwners: { zlgd_no: 1, zlgd_org: 1, zlgd_e1: 1, zlgd_sub: 1 },
	};
	const ask = (term: string): string => {
		const idx = mergeIndex(entrySrc, entryMeta);
		const lk = lookup(idx);
		const [target] = resolveTarget(idx, term, lk).filter((t) => t.kind === "field");
		if (!target) throw new Error(`没认出 ${term}`);
		return formatTrace(traceField(idx, lk, target), lk).join("\n");
	};

	it("「分录.子分录.字段」路径记下的读写处算这个字段的", () => {
		expect(ask("zlgd_qty.zlgd_no")).toContain("QtyPlugin#afterBindData:21 读 getValue zlgd_e1.zlgd_sub.zlgd_no");
	});

	it("基础资料取属性算读这个基础资料字段，属性名本身不算字段", () => {
		const text = ask("zlgd_qty.zlgd_org");
		expect(text).toContain("25 读 getValue zlgd_org.number");
		expect(text).toContain("写 1 处、读 1 处");
	});

	it("中间的分录写对了不多说，只写子分录也认", () => {
		expect(ask("zlgd_qty.zlgd_e1.zlgd_sub.zlgd_no")).not.toContain("⚠");
		expect(ask("zlgd_qty.zlgd_sub.zlgd_no")).not.toContain("⚠");
	});

	it("中间的分录写错了照实说字段在哪", () => {
		expect(ask("zlgd_qty.zlgd_wrong.zlgd_no")).toContain(
			"⚠ zlgd_no 在子分录 zlgd_sub（属 zlgd_e1），不在 zlgd_wrong（快照 09-23）",
		);
		expect(ask("zlgd_qty.zlgd_e1.zlgd_org")).toContain("⚠ zlgd_org 在表头，不在 zlgd_e1");
	});
});

describe("同一个插件里几条事件路径、只挂在某个布局上", () => {
	const ws: SrcIndex = {
		...src,
		classes: [{ class: "com.demo.WsPlugin", file: "src/WsPlugin.java", pluginType: "form" }],
		entityRefs: [],
		fieldRefs: [site("WsPlugin", "getLatest", "zlgd_jgz", 189, "read")],
		edges: [
			edge("WsPlugin#propertyChanged", "WsPlugin#fillByScale", 118),
			edge("WsPlugin#fillByScale", "WsPlugin#getLatest", 166),
			edge("WsPlugin#afterDoOperation", "WsPlugin#calHardness", 132),
			edge("WsPlugin#calHardness", "WsPlugin#getLatest", 209),
		],
	};
	const wsMeta: MetaIndex = {
		...meta,
		bindings: [{ class: "com.demo.WsPlugin", entity: "zlgd_tb", kind: "form", layout: "zlgd_tb_ws" }],
		fields: [{ entity: "zlgd_tb", key: "zlgd_jgz", level: "header" }],
		fieldOwners: { zlgd_jgz: 1 },
	};
	const wsAnswer = (): string => {
		const idx = mergeIndex(ws, wsMeta);
		const lk = lookup(idx);
		const [target] = resolveTarget(idx, "zlgd_tb.zlgd_jgz", lk).filter((t) => t.kind === "field");
		if (!target) throw new Error("没认出");
		return formatTrace(traceField(idx, lk, target), lk).join("\n");
	};

	it("改字段和点按钮两条路都走到读取处：两条都列，不只给最短的一条", () => {
		const text = wsAnswer();
		expect(text).toContain(
			"WsPlugin#propertyChanged:118 → WsPlugin#fillByScale:166 → WsPlugin#getLatest:189 读 getValue",
		);
		expect(text).toContain(
			"WsPlugin#afterDoOperation:132 → WsPlugin#calHardness:209 → WsPlugin#getLatest:189 读 getValue",
		);
	});

	it("插件不在单据自己的布局上：说出挂在哪个布局", () => {
		expect(wsAnswer()).toContain("─ WsPlugin [form，挂 zlgd_tb 的布局 zlgd_tb_ws]");
	});
});

describe("字段名扫描认不出的读写：逐处带行号列出来，让读的人去看源码", () => {
	const dyn = (cls: string, method: string, line: number, extra: Partial<SrcRef> = {}): SrcRef => ({
		class: `com.demo.${cls}`,
		field: null,
		access: "write",
		resolution: "dynamic",
		inMethod: `com.demo.${cls}#${method}()`,
		line,
		via: "IDataModel#setValue(String, Object)",
		expr: "key",
		...extra,
	});
	const call = (from: string, line: number, arg: string | null) => ({
		from: `com.demo.WsPlugin#${from}()`,
		to: "com.demo.Util#put()",
		fromClass: "com.demo.WsPlugin",
		line,
		args: [arg],
	});
	const index = mergeIndex(
		{
			...src,
			classes: [
				{ class: "com.demo.WsPlugin", file: "src/WsPlugin.java", pluginType: "form" },
				{ class: "com.demo.Util", file: "src/Util.java", pluginType: null },
				{ class: "com.demo.Far", file: "src/Far.java", pluginType: "form" },
			],
			entityRefs: [],
			fieldRefs: [
				site("WsPlugin", "getLatest", "zlgd_jgz", 189, "read"),
				dyn("WsPlugin", "fill", 77),
				dyn("WsPlugin", "copy", 90, { obj: "bill:zlgd_other" }),
				dyn("Util", "put", 12, { keyFrom: "param:0" }),
				dyn("Far", "run", 5),
			],
			edges: [],
			callArgs: [call("a", 30, "key:zlgd_x"), call("b", 40, null)],
		},
		{
			...meta,
			bindings: [
				{ class: "com.demo.WsPlugin", entity: "zlgd_tb", kind: "form" },
				{ class: "com.demo.Far", entity: "zlgd_far", kind: "form" },
			],
			fields: [{ entity: "zlgd_tb", key: "zlgd_jgz", level: "header" }],
			fieldOwners: { zlgd_jgz: 1 },
		},
	);
	const answer = (all = false): string => {
		const lk = lookup(index);
		const [target] = resolveTarget(index, "zlgd_tb.zlgd_jgz", lk).filter((t) => t.kind === "field");
		if (!target) throw new Error("没认出");
		return formatTrace(traceField(index, lk, target), lk, { all }).join("\n");
	};

	it("挂这张单的类里键是变量的读写：按类报处数、给一处样例；dynamic=true 逐处列", () => {
		expect(answer()).toContain("名字扫描认不出的读写 2 处");
		expect(answer()).toContain("WsPlugin：fill:77 写 setValue（key）；等 2 处");
		expect(answer(true)).toContain(
			"WsPlugin：fill:77 写 setValue（key）；b:40 写 setValue 经 Util#put（传入的标识）",
		);
	});

	it("包装方法的键在调用处传了常量就算认出了；对象是别的单、类不碰这张单的都不列", () => {
		const text = answer(true);
		expect(text).not.toContain("a:30");
		expect(text).not.toContain("put:12");
		expect(text).not.toContain("copy:90");
		expect(text).not.toContain("Far");
	});
});
