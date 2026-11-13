/**
 * S17 batch 7 -- the name catalog answers for bills too (an extension design for
 * the platform bill it extends), keeps every name the scan read, says when an
 * object carries none of this project's plugins, and does not read a short name
 * inside a longer one as a second object. Field rows are stored without their
 * empty columns, and the snapshot no longer keeps the asked keys.
 */

import { describe, expect, it } from "vitest";
import { queryImpact } from "../../src/kernel/commands/impact.ts";
import { buildCatalog, resolveNames } from "../../src/kernel/impact/catalog.ts";
import { patchFields } from "../../src/kernel/impact/meta-refresh.ts";
import {
	compactField,
	type ImpactIndex,
	type MetaIndex,
	mergeIndex,
	type SrcIndex,
} from "../../src/kernel/impact/model.ts";
import { makeContext } from "./fake-context.ts";

const src: SrcIndex = {
	kind: "SrcIndex",
	at: "2026-09-01T00:00:00.000Z",
	ms: 1,
	files: 1,
	calls: { total: 0, unbound: 0 },
	classes: [{ class: "com.demo.WtdPlugin", file: "src/WtdPlugin.java", pluginType: "form" }],
	entityRefs: [],
	fieldRefs: [],
	edges: [],
	unknownSigs: [],
};

const meta: MetaIndex = {
	kind: "MetaIndex",
	at: "2026-10-04T00:00:00.000Z",
	ms: 1,
	scanned: 1,
	bindings: [
		{ class: "com.demo.WtdPlugin", entity: "zlgd_wtd", kind: "form", layout: "zlgd_wtd" },
		{ class: "com.demo.WtdPlugin", entity: "zlgd_wtd", kind: "print", layout: "tpl_wtd" },
		// Another module's class: the object is in the snapshot, nothing of this project is on it.
		{ class: "other.FlowPlugin", entity: "im_saloutbill", kind: "workflow", layout: "Proc_out_3" },
	],
	templates: [{ number: "tpl_wtd", entity: "zlgd_wtd", classes: ["com.demo.WtdPlugin"] }],
	names: [
		{ site: "print", id: "tpl_wtd", name: "委托单" },
		{ site: "workflow", id: "Proc_out_3", name: "销售出库单审批流程" },
		// The same key once per version, under two names.
		{ site: "workflow", id: "Proc_out_3", name: "销售出库单审批流程" },
		{ site: "workflow", id: "Proc_out_3", name: "旧版出库审批流程" },
	],
	billNames: [
		{ bill: "zlgd_wtd", name: "检验委托单" },
		{ bill: "zlgd_im_saloutbill_ext", name: "销售出库单", base: "im_saloutbill" },
		{ bill: "zlgd_idle", name: "闲置台账" },
		{ bill: "zlgd_kg", name: "开工" },
		{ bill: "zlgd_test", name: "test" },
	],
	fields: [],
	fieldOwners: {},
	fieldsMs: 1,
};

function ask(index: ImpactIndex, term: string): string {
	const fake = makeContext();
	fake.fs.put(fake.ctx.layout.impactIndex, JSON.stringify(index));
	const got = queryImpact(fake.ctx, { terms: [term] });
	return got.ok ? got.value.text : `${got.error.message}\n${got.error.remedy ?? ""}`;
}

describe("单据中文名进对照表", () => {
	const index = mergeIndex(src, meta);

	it("单据名对到单据标识；扩展单的名字对到它扩展的原单", () => {
		expect(ask(index, "检验委托单")).toContain("中文名「检验委托单」→ 实体 zlgd_wtd「检验委托单」");
		expect(ask(index, "销售出库单")).toContain("中文名「销售出库单」→ 实体 im_saloutbill「销售出库单」");
	});

	it("长名字里的短名字不算第二个对象：「检验委托单」不再连带打印模板「委托单」", () => {
		const catalog = buildCatalog(index);
		expect(resolveNames(catalog, "检验委托单").map((hit) => hit.entry.id)).toEqual(["zlgd_wtd"]);
		// 短名字在别处单独出现时照样算。
		expect(
			resolveNames(catalog, "委托单和检验委托单")
				.map((hit) => hit.entry.id)
				.sort(),
		).toEqual(["tpl_wtd", "zlgd_wtd"]);
	});

	it("两个字的名字只在查询词就是它时才算：「打开工程」里没有单据「开工」", () => {
		const catalog = buildCatalog(index);
		expect(resolveNames(catalog, "打开工程")).toEqual([]);
		expect(resolveNames(catalog, "开工").map((hit) => hit.entry.id)).toEqual(["zlgd_kg"]);
	});

	it("不含中文的名字不收：标识里的 test 不是单据「test」", () => {
		const catalog = buildCatalog(index);
		expect(catalog.entries.some((entry) => entry.id === "zlgd_test")).toBe(false);
		expect(resolveNames(catalog, "zlgd_sys_test_bill 实验室检测单")).toEqual([]);
	});

	it("单据上没有本工程的插件、代码也没碰：直说", () => {
		expect(ask(index, "闲置台账")).toContain("单据 zlgd_idle 上没有本工程的插件，代码里也没按名字读写它");
	});
});

describe("对照表收下快照里的全部名字", () => {
	const index = mergeIndex(src, meta);

	it("只挂了别的模块类的对象也认得，并说上面没有本工程的插件", () => {
		const text = ask(index, "旧版出库审批流程");
		expect(text).toContain("中文名「旧版出库审批流程」→ 工作流 Proc_out_3");
		expect(text).toContain("工作流 Proc_out_3 上没有本工程的插件");
	});

	it("一个对象的每个名字都认，同名的重复行只留一行", () => {
		expect(ask(index, "销售出库单审批流程")).toContain("→ 工作流 Proc_out_3");
		expect(index.names?.filter((row) => row.id === "Proc_out_3")).toHaveLength(2);
	});

	it("查不到时说清对照表收了哪几类", () => {
		const text = ask(index, "加工方式");
		expect(text).toContain("中文名对照表收单据、打印模板、调度任务、开放接口、转换规则、工作流的设计态名字");
		expect(text).toContain("字段没有中文名可查");
		expect(text).not.toContain("单据名要完整重建");
	});
});

describe("字段行存得省，快照不再存问过的字段", () => {
	it("空的分录、上级分录和默认种类不存", () => {
		expect(
			compactField({ entity: "a", key: "k", level: "header", entry: "", parentEntry: "", kind: "field" }),
		).toEqual({ entity: "a", key: "k", level: "header" });
		expect(
			compactField({ entity: "a", key: "e", level: "entry", entry: "e", parentEntry: "", kind: "container" }),
		).toEqual({ entity: "a", key: "e", level: "entry", entry: "e", kind: "container" });
	});

	it("补扫：重扫的单换上新名字、删掉的单名字跟着走；老格式的行补完也是省的", () => {
		const old = {
			...meta,
			fields: [{ entity: "zlgd_wtd", key: "zlgd_a", level: "header", entry: "", parentEntry: "", kind: "field" }],
			owners: { zlgd_a: ["zlgd_wtd"] },
		} as MetaIndex;
		const patched = patchFields(
			old,
			{ fields: new Set(["zlgd_a"]), entities: new Set(["zlgd_wtd"]) },
			{
				rescanned: new Set(["zlgd_wtd", "zlgd_idle"]),
				rows: [compactField({ entity: "zlgd_wtd", key: "zlgd_a", level: "header" })],
				billNames: [{ bill: "zlgd_wtd", name: "检验委托单（新）" }],
			},
		);
		expect(patched.fields).toEqual([{ entity: "zlgd_wtd", key: "zlgd_a", level: "header" }]);
		expect(patched.asked).toEqual({ entities: ["zlgd_wtd"] });
		expect(patched.billNames).toEqual([
			{ bill: "zlgd_im_saloutbill_ext", name: "销售出库单", base: "im_saloutbill" },
			{ bill: "zlgd_kg", name: "开工" },
			{ bill: "zlgd_test", name: "test" },
			{ bill: "zlgd_wtd", name: "检验委托单（新）" },
		]);
	});
});
