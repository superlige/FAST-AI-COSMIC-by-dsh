/**
 * S17 batch 6 -- a class, bill or layout entry point answers with five things by
 * default (snapshot, where it is registered, which project fields it writes on
 * which bill, who else writes them, the design-time objects it drags in); the
 * full surface is one `dynamic=true` away.
 */

import { describe, expect, it } from "vitest";
import { queryImpact } from "../../src/kernel/commands/impact.ts";
import { shortNames } from "../../src/kernel/impact/brief.ts";
import {
	type ImpactIndex,
	lookup,
	type MetaBinding,
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
	obj: "own",
});

const src = (extra: Partial<SrcIndex> = {}): SrcIndex => ({
	kind: "SrcIndex",
	at: "2026-09-01T00:00:00.000Z",
	ms: 1,
	files: 4,
	calls: { total: 0, unbound: 0 },
	classes: [
		{ class: "com.demo.QtyPlugin", file: "src/QtyPlugin.java", pluginType: "form" },
		{ class: "com.demo.OpPlugin", file: "src/OpPlugin.java", pluginType: "op" },
		{ class: "com.demo.FarPlugin", file: "src/FarPlugin.java", pluginType: "form" },
		{ class: "com.demo.Reader", file: "src/Reader.java", pluginType: null },
	],
	entityRefs: [{ class: "com.demo.Reader", entity: "zlgd_qty", access: "read", resolution: "literal" }],
	fieldRefs: [
		site("QtyPlugin", "propertyChanged", "zlgd_a", 40),
		site("QtyPlugin", "propertyChanged", "zlgd_d", 70),
		site("QtyPlugin", "propertyChanged", "billstatus", 75),
		site("QtyPlugin", "propertyChanged", "zlgd_b", 80, "read"),
		site("OpPlugin", "beforeExecute", "zlgd_a", 10),
		// zlgd_d is on zlgd_qty and zlgd_snap; FarPlugin's own bill carries neither -- not a co-writer.
		site("FarPlugin", "afterBind", "zlgd_d", 5),
	],
	edges: [],
	unknownSigs: [],
	...extra,
});

const meta = (bindings: MetaBinding[] = []): MetaIndex => ({
	kind: "MetaIndex",
	at: "2026-09-23T00:00:00.000Z",
	ms: 1,
	scanned: 1,
	bindings: [
		{ class: "com.demo.QtyPlugin", entity: "zlgd_qty", kind: "form", layout: "zlgd_qty_lay" },
		{ class: "com.demo.OpPlugin", entity: "zlgd_qty", kind: "entity", layout: "zlgd_qty" },
		{ class: "com.demo.FarPlugin", entity: "zlgd_far", kind: "form", layout: "zlgd_far" },
		...bindings,
	],
	templates: [],
	fields: [
		{ entity: "zlgd_qty", key: "zlgd_a", level: "header" },
		{ entity: "zlgd_qty", key: "zlgd_b", level: "header" },
		{ entity: "zlgd_qty", key: "zlgd_d", level: "header" },
		{ entity: "zlgd_snap", key: "zlgd_d", level: "header" },
		{ entity: "zlgd_far", key: "zlgd_f", level: "header" },
	],
	fieldOwners: { zlgd_a: 1, zlgd_b: 1, zlgd_d: 2, zlgd_f: 1 },
	fieldsMs: 1,
});

function ask(index: ImpactIndex, terms: string[], dynamic = false): string {
	const fake = makeContext();
	fake.fs.put(fake.ctx.layout.impactIndex, JSON.stringify(index));
	const got = queryImpact(fake.ctx, { terms, ...(dynamic ? { dynamic } : {}) });
	if (!got.ok) throw got.error;
	return got.value.text;
}

describe("类入口默认给五样", () => {
	const text = ask(mergeIndex(src(), meta()), ["QtyPlugin"]);

	it("快照、挂在哪（写布局号）、写了哪张单的哪些字段、谁还在写、牵连对象", () => {
		expect(text.split("\n")[0]).toContain("元数据快照 09-23 建");
		expect(text).toContain("挂在：表单 zlgd_qty_lay（实体 zlgd_qty）");
		expect(text).toContain("写 zlgd_qty 2 个：zlgd_a、zlgd_d");
		expect(text).toContain("zlgd_qty 上同字段还有别的类在写 1 个：zlgd_a ← OpPlugin");
		expect(text).toContain("牵连的元数据对象");
		expect(text).toContain("加 dynamic=true");
	});

	it("同名字段在别的单上的写入不算同字段写入者；平台字段不列", () => {
		expect(text).not.toContain("FarPlugin");
		expect(text).not.toContain("billstatus");
	});

	it("读了哪些单据、碰的字段明细不进默认答案，dynamic=true 才列", () => {
		expect(text).not.toContain("读取实体");
		expect(text).not.toContain("碰的字段");
		const full = ask(mergeIndex(src(), meta()), ["QtyPlugin"], true);
		expect(full).toContain("读取实体");
		expect(full).toContain("碰的字段");
	});

	it("没有别的类在写时直说", () => {
		const alone = ask(mergeIndex(src(), meta()), ["FarPlugin"]);
		expect(alone).toContain("另写 1 个字段认不出是哪张单：zlgd_d");
		expect(alone).not.toContain("同字段还有别的类在写");
	});
});

describe("单据入口按挂的位置分组计数，不逐个展开插件", () => {
	it("表单按布局分、其余按登记位置分；按名字读写它的类单独数；多入口写的字段点名", () => {
		const text = ask(mergeIndex(src(), meta()), ["zlgd_qty"]);
		expect(text).toContain("单据 zlgd_qty 上登记的本工程插件 2 个");
		expect(text).toContain("表单 zlgd_qty_lay 1 个：QtyPlugin");
		expect(text).toContain("单据操作 1 个：OpPlugin");
		expect(text).toContain("代码里按名字读写它、没登记在它上面的类 1 个：Reader");
		expect(text).toMatch(
			/本工程代码写它的字段 2 个；不止一个入口在写的 1 个：zlgd_a ← (QtyPlugin、OpPlugin|OpPlugin、QtyPlugin)/,
		);
		expect(text).not.toContain("─ ");
	});

	it("表单布局多时只单列最多的几个，其余一行带个数", () => {
		const many: MetaBinding[] = Array.from({ length: 7 }, (_, i) => ({
			class: "com.demo.Reader",
			entity: "zlgd_qty",
			kind: "form",
			layout: `zlgd_qty_l${i}`,
		}));
		const text = ask(mergeIndex(src(), meta(many)), ["zlgd_qty"]);
		const formRows = text.split("\n").filter((line) => /^\[IMPACT\] {5}表单 /.test(line));
		expect(formRows).toHaveLength(5);
		expect(text).toContain("另 3 个表单布局：3 个各 1 个");
	});
});

describe("布局标识能当入口", () => {
	it("认成布局，给出登记在它上面的插件并展开", () => {
		const index = mergeIndex(src(), meta());
		const lk = lookup(index);
		expect(resolveTarget(index, "zlgd_qty_lay", lk)).toEqual([
			{ kind: "layout", value: "zlgd_qty_lay", entity: "zlgd_qty" },
		]);
		const text = ask(index, ["zlgd_qty_lay"]);
		expect(text).toContain("入口：布局 zlgd_qty_lay（实体 zlgd_qty）");
		expect(text).toContain("布局 zlgd_qty_lay 上登记的本工程插件 1 个：QtyPlugin");
		expect(text).toContain("─ QtyPlugin");
	});

	it("实体自己的表单号不当布局，仍是单据入口", () => {
		const index = mergeIndex(src(), meta());
		expect(resolveTarget(index, "zlgd_far", lookup(index)).map((t) => t.kind)).toEqual(["entity"]);
	});
});

describe("同一列表里简单类名重了，带上包名最后一段", () => {
	it("只给重名的加", () => {
		expect(shortNames(["a.qtywtd.QTYWTDOpPlugin", "a.opp.QTYWTDOpPlugin", "a.x.Other"])).toEqual([
			"qtywtd.QTYWTDOpPlugin",
			"opp.QTYWTDOpPlugin",
			"Other",
		]);
	});
});
