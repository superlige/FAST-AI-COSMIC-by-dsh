/**
 * S17 batch 3 -- uses the table now records besides get / set: query conditions,
 * select strings, operation preloads. They show up in a field's answer with how
 * they touch it, and a condition built by a wrapper is named at the call line.
 */

import { describe, expect, it } from "vitest";
import { formatTrace, traceField } from "../../src/kernel/impact/field-trace.ts";
import { lookup, type MetaIndex, mergeIndex, resolveTarget, type SrcIndex } from "../../src/kernel/impact/model.ts";

const D = "com.demo.";
const src: SrcIndex = {
	kind: "SrcIndex",
	at: "2026-10-04T00:00:00.000Z",
	ms: 1,
	files: 3,
	calls: { total: 1, unbound: 0 },
	classes: [
		{ class: `${D}PrepOp`, file: "src/PrepOp.java", pluginType: "op" },
		{ class: `${D}APlugin`, file: "src/APlugin.java", pluginType: "form" },
		{ class: `${D}Util`, file: "src/Util.java", pluginType: null },
	],
	entityRefs: [],
	fieldRefs: [
		{
			class: `${D}PrepOp`,
			field: "zlgd_x",
			access: "preload",
			resolution: "literal",
			via: "PreparePropertysEventArgs#getFieldKeys()",
			line: 15,
			inMethod: `${D}PrepOp#onPreparePropertys(PreparePropertysEventArgs)`,
			obj: "own",
		},
		{
			class: `${D}APlugin`,
			field: "zlgd_x",
			access: "filter",
			resolution: "literal",
			via: "QFilter#new QFilter(String, String, Object)",
			line: 30,
			inMethod: `${D}APlugin#afterBindData(EventObject)`,
			obj: "bill:zlgd_a_bill",
		},
		{
			class: `${D}APlugin`,
			field: "entryentity.zlgd_y",
			access: "select",
			resolution: "literal",
			via: "BusinessDataServiceHelper#load(String, String, QFilter[])",
			line: 31,
			inMethod: `${D}APlugin#afterBindData(EventObject)`,
			obj: "bill:zlgd_a_bill",
		},
		// 包装方法拼条件：单据和字段名都是参数，到调用处展开
		{
			class: `${D}Util`,
			field: null,
			access: "filter",
			resolution: "dynamic",
			via: "QFilter#new QFilter(String, String, Object)",
			line: 80,
			inMethod: `${D}Util#latest(String, String)`,
			obj: "billparam:0",
			keyFrom: "param:1",
		},
	],
	edges: [
		{
			from: `${D}APlugin#afterBindData(EventObject)`,
			to: `${D}Util#latest(String, String)`,
			fromClass: `${D}APlugin`,
			toClass: `${D}Util`,
			line: 40,
			count: 1,
		},
	],
	callArgs: [
		{
			from: `${D}APlugin#afterBindData(EventObject)`,
			to: `${D}Util#latest(String, String)`,
			fromClass: `${D}APlugin`,
			line: 40,
			args: ["key:zlgd_a_bill", "key:zlgd_x"],
		},
	],
	unknownSigs: [],
};
const meta = {
	kind: "MetaIndex",
	at: "2026-10-04T00:00:00.000Z",
	ms: 1,
	scanned: 1,
	bindings: [
		{ class: `${D}PrepOp`, entity: "zlgd_a_bill", kind: "entity" },
		{ class: `${D}APlugin`, entity: "zlgd_a_bill", kind: "form" },
	],
	templates: [],
	fields: [
		{ entity: "zlgd_a_bill", key: "zlgd_x", level: "header" },
		{ entity: "zlgd_a_bill", key: "zlgd_y", level: "entry", entry: "entryentity" },
		{ entity: "zlgd_a_bill", key: "entryentity", level: "entry", entry: "entryentity", kind: "container" },
	],
	fieldOwners: { zlgd_x: 1, zlgd_y: 1 },
	fieldsMs: 1,
} as unknown as MetaIndex;

const index = mergeIndex(src, meta, "2026-10-04T00:00:00.000Z");
const lk = lookup(index);
const answer = (term: string) => {
	const target = resolveTarget(index, term, lk).find((t) => t.kind === "field");
	return formatTrace(traceField(index, lk, target as never), lk).join("\n");
};

describe("查询条件、取数字段串、操作预加载", () => {
	it("答案里说清是按条件读、取数读还是操作预加载，都算读", () => {
		const text = answer("zlgd_a_bill.zlgd_x");
		expect(text).toContain("写 0 处、读 3 处");
		expect(text).toContain("PrepOp#onPreparePropertys:15 操作预加载");
		expect(text).toContain("APlugin#afterBindData:30 按条件读");
	});

	it("取数字段串带分录前缀的，按分录里的字段认，原样写出路径", () => {
		expect(answer("zlgd_a_bill.zlgd_y")).toContain("APlugin#afterBindData:31 取数读 load entryentity.zlgd_y");
	});

	it("包装方法拼的条件：在调用那一行记下，单据换成调用处传的", () => {
		const derived = index.fieldRefs.find((r) => r.through);
		expect(derived).toMatchObject({
			class: `${D}APlugin`,
			field: "zlgd_x",
			access: "filter",
			line: 40,
			obj: "bill:zlgd_a_bill",
		});
		expect(answer("zlgd_a_bill.zlgd_x")).toContain("40 按条件读 经 Util#latest");
	});
});
