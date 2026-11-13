/**
 * S17 batch 2 -- which bill one field read / write is on, from where its object
 * came from; a parameter followed to the call site, along each listed route.
 */

import { describe, expect, it } from "vitest";
import { attributor } from "../../src/kernel/impact/attribution.ts";
import { formatTrace, traceField } from "../../src/kernel/impact/field-trace.ts";
import { formatImpact } from "../../src/kernel/impact/format.ts";
import {
	impactOf,
	lookup,
	type MetaIndex,
	mergeIndex,
	rebaseOrigin,
	resolveTarget,
	type SrcIndex,
	type SrcRef,
} from "../../src/kernel/impact/model.ts";

const D = "com.demo.";
const ref = (
	cls: string,
	method: string,
	field: string | null,
	line: number,
	obj: string,
	extra: Partial<SrcRef> = {},
) =>
	({
		class: D + cls,
		field,
		access: "write",
		resolution: field ? "literal" : "dynamic",
		inMethod: `${D}${cls}#${method}`,
		line,
		via: "DynamicObject#set(String, Object)",
		obj,
		...extra,
	}) as SrcRef;
const edge = (from: string, to: string, line: number) => ({
	from: D + from,
	to: D + to,
	fromClass: D + from.split("#")[0],
	toClass: D + to.split("#")[0],
	line,
	count: 1,
});
const call = (from: string, to: string, line: number, args: (string | null)[]) => ({
	from: D + from,
	to: D + to,
	fromClass: D + from.split("#")[0],
	line,
	args,
});

const src: SrcIndex = {
	kind: "SrcIndex",
	at: "2026-09-01T00:00:00.000Z",
	ms: 1,
	files: 6,
	calls: { total: 1, unbound: 0 },
	classes: ["APlugin", "BPlugin", "Shared", "LoadOp", "Mystery", "Wrap", "Loader"].map((name) => ({
		class: D + name,
		file: `src/${name}.java`,
		pluginType: name.endsWith("Plugin") || name === "Wrap" ? "form" : name.endsWith("Op") ? "op" : null,
	})),
	entityRefs: [
		{ class: `${D}LoadOp`, entity: "zlgd_b_bill", access: "read", resolution: "literal" },
		{ class: `${D}LoadOp`, entity: null, access: "write", resolution: "none", obj: "bill:zlgd_b_bill" },
		{ class: `${D}APlugin`, entity: null, access: "write", resolution: "none", obj: "own" },
		{ class: `${D}Mystery`, entity: null, access: "write", resolution: "none", obj: "?:来自 Foo#bar" },
	],
	fieldRefs: [
		ref("APlugin", "propertyChanged()", "zlgd_x", 10, "own"),
		ref("Shared", "fill(DynamicObject)", "zlgd_x", 20, "param:0"),
		ref("LoadOp", "afterExecute()", "zlgd_x", 40, "bill:zlgd_b_bill"),
		ref("Mystery", "run()", "zlgd_x", 50, "?:来自 Foo#bar"),
		ref("Wrap", "set(DynamicObject, String)", null, 90, "own", { keyFrom: "param:1" }),
		ref("Loader", "byKey(String)", "zlgd_x", 60, "billparam:0"),
		ref("Shared", "orphan(DynamicObject)", "zlgd_x", 70, "param:0"),
	],
	edges: [
		edge("APlugin#propertyChanged()", "Shared#fill(DynamicObject)", 12),
		edge("BPlugin#beforeExecute()", "Shared#fill(DynamicObject)", 30),
		edge("Wrap#calc()", "Wrap#set(DynamicObject, String)", 77),
		edge("BPlugin#beforeExecute()", "Loader#byKey(String)", 31),
	],
	callArgs: [
		call("APlugin#propertyChanged()", "Shared#fill(DynamicObject)", 12, ["own"]),
		call("BPlugin#beforeExecute()", "Shared#fill(DynamicObject)", 30, ["own"]),
		call("Wrap#calc()", "Wrap#set(DynamicObject, String)", 77, ["own", "key:zlgd_x"]),
		call("BPlugin#beforeExecute()", "Loader#byKey(String)", 31, ["key:zlgd_b_bill"]),
	],
	unknownSigs: [],
};

const header = (entity: string, key: string) => ({ entity, key, level: "header" });
const meta: MetaIndex = {
	kind: "MetaIndex",
	at: "2026-09-23T00:00:00.000Z",
	ms: 1,
	scanned: 1,
	bindings: [
		{ class: `${D}APlugin`, entity: "zlgd_a_bill", kind: "form" },
		{ class: `${D}BPlugin`, entity: "zlgd_b_bill", kind: "entity" },
		{ class: `${D}LoadOp`, entity: "zlgd_a_bill", kind: "entity" },
		{ class: `${D}Mystery`, entity: "zlgd_a_bill", kind: "entity" },
		{ class: `${D}Wrap`, entity: "zlgd_a_bill", kind: "form" },
	],
	templates: [],
	fields: [
		header("zlgd_a_bill", "zlgd_x"),
		header("zlgd_b_bill", "zlgd_x"),
		{ entity: "zlgd_a_bill", key: "entryentity", level: "entry", entry: "entryentity", kind: "container" },
	],
	fieldOwners: { zlgd_x: 2 },
	fieldsMs: 1,
} as unknown as MetaIndex;

const index = mergeIndex(src, meta, "2026-09-23T00:00:00.000Z");
const lk = lookup(index);
const at = attributor(index, lk, "快照 09-23");
const find = (cls: string, line: number) =>
	index.fieldRefs.find((r) => r.class === D + cls && r.line === line) as SrcRef;
const answer = (term: string, all = false) => {
	const target = resolveTarget(index, term, lk).find((t) => t.kind === "field") ?? { kind: "field", value: term };
	const trace = traceField(index, lk, target as never);
	return { trace, text: formatTrace(trace, lk, { all }).join("\n") };
};

describe("按对象来源归属", () => {
	it("插件自己的单、按名字加载的单直接定下来", () => {
		expect(at.site(find("APlugin", 10))).toMatchObject({ kind: "bill", bills: ["zlgd_a_bill"] });
		expect(at.site(find("LoadOp", 40))).toMatchObject({ kind: "bill", bills: ["zlgd_b_bill"] });
	});

	it("参数传进来的到调用处接着追；两个插件各传各的单，沿各自的路径各认各的", () => {
		const shared = find("Shared", 20);
		expect(at.site(shared)).toMatchObject({ kind: "bill", bills: ["zlgd_a_bill", "zlgd_b_bill"] });
		const viaA = at.along(shared, [{ method: `${D}APlugin#propertyChanged()`, line: 12 }]);
		expect(viaA).toMatchObject({ kind: "bill", bills: ["zlgd_a_bill"] });
		expect(viaA.kind === "bill" && viaA.how).toBe("APlugin 挂的单，在 propertyChanged:12 认出");
		expect(at.along(shared, [{ method: `${D}BPlugin#beforeExecute()`, line: 30 }])).toMatchObject({
			bills: ["zlgd_b_bill"],
		});
	});

	it("单据标识是参数：到调用处看传的是哪个常量", () => {
		expect(at.site(find("Loader", 60))).toMatchObject({ kind: "bill", bills: ["zlgd_b_bill"] });
	});

	it("认不出的照实说断在哪", () => {
		expect(at.site(find("Mystery", 50))).toEqual({ kind: "guess", why: "对象来自 Foo#bar" });
		const orphan = at.site(find("Shared", 70));
		expect(orphan.kind).toBe("guess");
		expect(orphan.kind === "guess" && orphan.why).toContain("表里没有 Shared#orphan 的调用处");
	});

	it("取分录还是那张单；取基础资料字段就不是单据本身了", () => {
		const entry = { ...find("APlugin", 10), obj: "prop:entryentity/own" };
		expect(at.site(entry)).toMatchObject({ kind: "bill", bills: ["zlgd_a_bill"] });
		const base = { ...find("APlugin", 10), obj: "prop:zlgd_org/own" };
		expect(at.site(base)).toMatchObject({ kind: "prop", field: "zlgd_org" });
	});

	it("换到调用处：参数换成实参，别的类自己的单不算数", () => {
		const c = call("APlugin#propertyChanged()", "Shared#fill(DynamicObject)", 12, ["own", "key:zlgd_b_bill"]);
		expect(rebaseOrigin("param:0", c, `${D}Shared`)).toBe("own");
		expect(rebaseOrigin("billparam:1", c, `${D}Shared`)).toBe("bill:zlgd_b_bill");
		expect(rebaseOrigin("own", c, `${D}Shared`)).toBe("?:别的类自己的数据");
		expect(rebaseOrigin("prop:zlgd_org/param:0", c, `${D}Shared`)).toBe("prop:zlgd_org/own");
	});
});

describe("save(数组) 写的是哪张单", () => {
	it("看存的那批对象从哪来：按名字加载的、插件只挂一张单时的本单；认不出的仍记签名无标识", () => {
		const saves = index.entityRefs.filter((r) => r.access === "write");
		expect(saves.map((r) => [r.class.replace(D, ""), r.entity, r.resolution])).toEqual([
			["LoadOp", "zlgd_b_bill", "origin"],
			["APlugin", "zlgd_a_bill", "origin"],
			["Mystery", null, "none"],
		]);
		const surface = impactOf(index, [{ kind: "class", value: `${D}LoadOp` }], lk);
		expect(surface.entities).toContainEqual({ key: "zlgd_b_bill", how: "读/写" });
		expect(surface.unresolved).toEqual([]);
	});
});

describe("包装方法写字段", () => {
	it("字段名是调用处传的常量：在调用那一行记下读写处，对象换成调用处的", () => {
		const derived = index.fieldRefs.filter((r) => r.through);
		expect(derived).toEqual([
			expect.objectContaining({
				class: `${D}Wrap`,
				field: "zlgd_x",
				line: 77,
				inMethod: `${D}Wrap#calc()`,
				obj: "own",
				through: `${D}Wrap#set(DynamicObject, String)`,
			}),
		]);
		expect(index.classes.find((c) => c.class === `${D}Wrap`)?.fields.map((f) => f.key)).toContain("zlgd_x");
	});
});

describe("查「单据.字段」：确定的列出来，猜的只报个数", () => {
	it("只列对象就是这张单的读写处；参数传进来的只列走到这张单的那条路径", () => {
		const { trace, text } = answer("zlgd_a_bill.zlgd_x");
		expect(text).toContain("APlugin#propertyChanged:10");
		expect(text).toContain(
			"APlugin#propertyChanged:12 → Shared#fill:20 写 set（对象：APlugin 挂的单，在 propertyChanged:12 认出）",
		);
		expect(text).not.toContain("BPlugin");
		expect(text).toContain("Wrap#calc:77 写 set 经 Wrap#set");
		expect(traceClassesOf(trace)).not.toContain(`${D}LoadOp`);
	});

	it("对象是别的单的，说是哪张单；来源没认出的只报个数和原因", () => {
		const { text } = answer("zlgd_a_bill.zlgd_x");
		expect(text).toContain(
			"另有 2 处同名标识读写的是别的单（按对象来源），没列：LoadOp 1 处（zlgd_b_bill）、Loader 1 处（zlgd_b_bill）",
		);
		expect(text).toContain(
			"另有 1 处只按名字猜在这张单上（对象来源没认出），没列：Mystery 1 处（对象来自 Foo#bar）；加 dynamic=true 列出",
		);
		expect(text).not.toContain("Mystery#run:50");
	});

	it("dynamic=true 时猜的也逐处列出，标明是猜的", () => {
		const { text } = answer("zlgd_a_bill.zlgd_x", true);
		expect(text).toContain("只按名字猜在这张单上（对象来源没认出）：");
		expect(text).toContain("Mystery#run:50 写 set —— 对象来自 Foo#bar");
	});

	it("另一张单上：按名字加载它的操作插件、走到它的那条路径都算", () => {
		const { text } = answer("zlgd_b_bill.zlgd_x");
		expect(text).toContain("LoadOp#afterExecute:40 写 set");
		expect(text).toContain(
			"BPlugin#beforeExecute:30 → Shared#fill:20 写 set（对象：BPlugin 挂的单，在 beforeExecute:30 认出）",
		);
		expect(text).not.toContain("APlugin#propertyChanged:12");
	});
});

describe("类入口的「碰的字段」", () => {
	it("每处读写的对象都认得出时，按对象所在的单分，不再按类碰过的单猜成同名歧义", () => {
		const text = formatImpact(index, impactOf(index, [{ kind: "class", value: `${D}LoadOp` }], lk)).join("\n");
		expect(text).toMatch(/zlgd_b_bill\s+表头\s+zlgd_x/);
		expect(text).not.toContain("同名歧义");
	});
});

function traceClassesOf(trace: ReturnType<typeof traceField>): string[] {
	return trace.groups.flatMap((g) => [g.class, ...g.routes.map((r) => r.entry)]);
}
