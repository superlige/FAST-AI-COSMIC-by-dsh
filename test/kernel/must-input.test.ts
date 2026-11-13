import { describe, expect, it } from "vitest";
import {
	type MustInputFacts,
	missingMustInput,
	mustInputText,
	parseMustInput,
	readMustInput,
	writeMustInput,
} from "../../src/kernel/meta/must-input.ts";
import { makeContext } from "./fake-context.ts";

const field = (over: Partial<MustInputFacts["fields"][number]> = {}): MustInputFacts["fields"][number] => ({
	kind: "field",
	key: "number",
	name: "编码",
	entry: "",
	def: "",
	type: "TextField",
	condition: "",
	conditionDesc: "",
	rows: 0,
	...over,
});

const entry = (over: Partial<MustInputFacts["fields"][number]> = {}) =>
	field({ kind: "entry", key: "zlgd_entry", name: "明细", type: "EntryEntity", ...over });

const facts = (fields: MustInputFacts["fields"]): MustInputFacts => ({
	entity: "zlgd_bzwz_wl",
	at: "2026-09-14T11:00:00.000Z",
	items: 120,
	fields,
});

describe("必填字段预检：读探针报上来的设计态", () => {
	it("没有汇总行就当作没查成，而不是「这张单没有必录字段」", () => {
		// 两者在 JSON 旁路上长得一样，但一个该放行、一个该闭嘴。
		expect(parseMustInput([{ t: "mustinput", key: "number" }], "2026-09-14T11:00:00.000Z")).toBeNull();
	});

	it("有汇总行、一条必录都没有，是一个真答案", () => {
		const parsed = parseMustInput(
			[{ t: "mustinput-summary", entity: "zlgd_x", items: 30 }],
			"2026-09-14T11:00:00.000Z",
		);
		expect(parsed).not.toBeNull();
		expect(parsed?.fields).toEqual([]);
		expect(parsed?.items).toBe(30);
	});

	it("读得出必录条件和分录必录；老探针没报这些字段时按「没有条件、是字段」读", () => {
		const parsed = parseMustInput(
			[
				{ t: "mustinput-summary", entity: "zlgd_x", items: 30 },
				{
					t: "mustinput",
					kind: "field",
					key: "zlgd_supplier",
					name: "供应商",
					cond: 'zlgd_src = "1"',
					condDesc: "外购",
				},
				{ t: "mustinput", kind: "entry", key: "zlgd_entry", name: "明细", rows: 1 },
				{ t: "mustinput", key: "number", name: "编码" },
			],
			"2026-09-17T00:00:00.000Z",
		);
		expect(parsed?.fields).toEqual([
			expect.objectContaining({
				kind: "field",
				key: "zlgd_supplier",
				condition: 'zlgd_src = "1"',
				conditionDesc: "外购",
			}),
			expect.objectContaining({ kind: "entry", key: "zlgd_entry", rows: 1, condition: "" }),
			expect.objectContaining({ kind: "field", key: "number", condition: "", conditionDesc: "", rows: 0 }),
		]);
	});

	it("旧版缓存（没有必录条件和分录必录）不认，要重新问一遍", () => {
		// 旧缓存对条件的沉默和「这个字段没条件」长得一样，留着就会把漏掉的继续漏下去。
		const { ctx, fs } = makeContext({ runtimeKeyId: "v0.0.0-aaaa" });
		writeMustInput(ctx, "zlgd_bzwz_wl", facts([field()]));
		const path = [...fs.files.keys()].find((key) => key.includes("/must-input/"));
		const cache = JSON.parse(fs.files.get(path as string)?.content ?? "{}");
		delete cache.version;
		fs.put(path as string, JSON.stringify(cache));
		expect(readMustInput(ctx, "zlgd_bzwz_wl")).toBeNull();
	});

	it("按 RuntimeKey 存取；换一个 RuntimeKey 读不到", () => {
		const one = makeContext({ runtimeKeyId: "v0.0.0-aaaa" });
		writeMustInput(one.ctx, "zlgd_bzwz_wl", facts([field()]));
		expect(readMustInput(one.ctx, "zlgd_bzwz_wl")?.fields).toHaveLength(1);

		const other = makeContext({ runtimeKeyId: "v0.0.0-bbbb" });
		for (const [path, file] of one.fs.files) other.fs.put(path, file.content);
		// 同一个标识在另一个账套可能是另一份设计，拿这边的答案去说那边，比不说更糟。
		expect(readMustInput(other.ctx, "zlgd_bzwz_wl")).toBeNull();
	});
});

describe("必填字段预检：哪些该催、哪些不该催", () => {
	it("催没给的表头必录字段", () => {
		const missing = missingMustInput(facts([field(), field({ key: "name", name: "名称" })]), []);
		expect(missing.map((item) => item.key)).toEqual(["number", "name"]);
	});

	it("已经 --set 过的不催", () => {
		const missing = missingMustInput(facts([field(), field({ key: "name", name: "名称" })]), ["number=A01"]);
		expect(missing.map((item) => item.key)).toEqual(["name"]);
	});

	it("带默认值的不催——校验器到那一步时它已经有值了", () => {
		expect(missingMustInput(facts([field({ def: "A" })]), [])).toEqual([]);
	});

	it("数值字段默认值是 0 照样催——平台把数值 0 当成没填", () => {
		// 真机 2026-09-17：zlgd_alu_sales_mpr 的年份、月份默认 "0"，旧判断当成有默认值直接跳过。
		const missing = missingMustInput(
			facts([
				field({ key: "zlgd_year", name: "年份", type: "IntegerField", def: "0" }),
				field({ key: "zlgd_rate", name: "比例", type: "DecimalField", def: "0.00" }),
				field({ key: "zlgd_qty", name: "数量", type: "QtyField", def: "1" }),
				field({ key: "zlgd_code", name: "代码", type: "TextField", def: "0" }),
			]),
			[],
		);
		expect(missing.map((item) => item.key)).toEqual(["zlgd_year", "zlgd_rate"]);
	});

	it("平台自己填的审计列不催，但 creator、编码和名称一定要催", () => {
		// 真机 2026-09-14 丢掉 90.7 秒的就是这两个；把它们混进白名单等于白改。
		const missing = missingMustInput(
			facts([
				field({ key: "billno", name: "单据编号" }),
				field({ key: "creator", name: "创建人" }),
				field({ key: "billstatus", name: "单据状态" }),
				field(),
				field({ key: "name", name: "名称" }),
			]),
			[],
		);
		expect(missing.map((item) => item.key)).toEqual(["creator", "number", "name"]);
	});

	it("带必录条件的表头字段照样列出来——条件这边算不了，不列就又漏了", () => {
		const missing = missingMustInput(facts([field({ key: "zlgd_supplier", condition: 'zlgd_src = "1"' })]), []);
		expect(missing.map((item) => item.key)).toEqual(["zlgd_supplier"]);
	});

	it("分录必录：没有一条 --set 写到这个分录就催，写了任意一行就不催", () => {
		expect(missingMustInput(facts([entry()]), ["number=A01"]).map((item) => item.key)).toEqual(["zlgd_entry"]);
		expect(missingMustInput(facts([entry()]), ["zlgd_entry[0].qty=1"])).toEqual([]);
		expect(missingMustInput(facts([entry()]), ["zlgd_entry.qty=1"])).toEqual([]);
	});

	it("子分录的分录必录不催——父分录有没有行都说不准", () => {
		expect(missingMustInput(facts([entry({ key: "zlgd_sub", entry: "zlgd_entry" })]), [])).toEqual([]);
	});

	it("分录上的必录字段不在这里催——要等分录真有行了才校验", () => {
		expect(missingMustInput(facts([field({ key: "qty", name: "数量", entry: "zlgd_entry" })]), [])).toEqual([]);
	});
});

describe("必填字段预检：说给人听的那几句", () => {
	it("没缺就一个字都不说", () => {
		expect(mustInputText({ entity: "zlgd_bzwz_wl", op: "save", missing: [] })).toBeNull();
	});

	it("给得出可以直接粘的 --set，并且说清楚它不替你补", () => {
		const text = mustInputText({
			entity: "zlgd_bzwz_wl",
			op: "save",
			missing: [field(), field({ key: "name", name: "名称" })],
		});
		expect(text).toContain("zlgd_bzwz_wl save");
		expect(text).toContain("number（编码）、name（名称）");
		expect(text).toContain("--set number=… --set name=…");
		// 自动补齐会把「这个字段为空时应该报错」这条用例变成假绿。
		expect(text).toContain("不会替你补");
		// 也不能把设计态的「必录」说成校验器一定会拦的清单。
		expect(text).toContain("不是校验器这次一定会拦的清单");
		expect(text).toContain("沙箱新建空单不自动填 creator");
		expect(text).toContain("没有对照单据时它会是 0");
	});

	it("三种必录分开说：始终必录给 --set，条件必录带上条件原文，分录必录教怎么造一行", () => {
		const text = mustInputText({
			entity: "zlgd_bzwz_wl",
			op: "save",
			missing: [
				field(),
				field({ key: "zlgd_supplier", name: "供应商", condition: 'zlgd_src = "1"', conditionDesc: "来源为外购" }),
				entry({ rows: 1 }),
			],
		}) as string;
		expect(text).toContain("始终必录的表头字段：number（编码）");
		expect(text).toContain("--set number=…");
		// 条件必录不该混进「要补就是」那行，不然会催人去填一个这次根本不拦的字段。
		expect(text).not.toContain("--set zlgd_supplier=…");
		expect(text).toContain('zlgd_supplier（供应商）：当 「来源为外购」（zlgd_src = "1"） 时必录');
		expect(text).toContain("zlgd_entry（明细）");
		expect(text).toContain("--set zlgd_entry[0].<字段>=…");
		expect(text).toContain("默认开 1 行");
	});

	it("条件说明和表达式一样时只说一遍", () => {
		const text = mustInputText({
			entity: "zlgd_ygjcxx",
			op: "save",
			missing: [
				field({
					key: "zlgd_xjrylx1",
					name: "人员类型",
					condition: "org.number <> '1500'",
					conditionDesc: "org.number <> '1500'",
				}),
			],
		}) as string;
		expect(text).toContain("zlgd_xjrylx1（人员类型）：当 org.number <> '1500' 时必录");
	});

	it("批量里的场景带上场景号", () => {
		const text = mustInputText({ entity: "zlgd_bzwz_wl", op: "submit", missing: [field()], scenarioId: "S2" });
		expect(text).toContain("场景 S2：");
	});
});
