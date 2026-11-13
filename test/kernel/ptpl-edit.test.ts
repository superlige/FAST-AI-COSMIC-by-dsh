/**
 * S32 批 2：打印模板的本地结构编辑。
 *
 * 这一批的整个意义是「改动全在本地，零 Java 往返」，所以用例也全在本地：
 * 一份小模板当样板，改完之后按**数据**断言——行列矩阵对不对、合并区搬没搬、
 * 多语言键补没补、公式片段摆得对不对。这些正是 2026-09-20 那次会话里
 * 模型自己摸了两分钟也没摸对的平台规则（S32 §2.1）。
 */

import { describe, expect, it } from "vitest";
import { meta } from "../../src/kernel/commands/meta.ts";
import { parseMeta } from "../../src/kernel/meta/parse.ts";
import type { TplControl, TplDesign, TplLocale } from "../../src/kernel/meta/ptpl-design.ts";
import {
	allControls,
	gridView,
	isAmbiguous,
	makeId,
	parseDesignText,
	readMerges,
	stringifyDesign,
} from "../../src/kernel/meta/ptpl-design.ts";
import {
	applyEdit,
	type EditContext,
	type FieldOwnershipRow,
	overview,
	summarizeChanges,
} from "../../src/kernel/meta/ptpl-edit.ts";
import { formulaText, isOperand } from "../../src/kernel/meta/ptpl-formula.ts";
import { type FakeContext, makeContext } from "./fake-context.ts";

const FORM = "zlgd_sys_test_bill";

/**
 * 一张小模板：一张 3 行 × 2 列的表格，第 2～3 行第 1 列是一块合并区。
 *
 * 字段形状照真模板抄（S32 §10.5）：格子靠 rowId/columnId 定位，行列的先后就是
 * 它们在页数组里的先后，合并区的键是 `<行下标>_<列下标>`。
 */
function fixture(): { design: TplDesign; locale: TplLocale } {
	const cell = (id: string, key: string, rowId: string, columnId: string, extra: Partial<TplControl> = {}) =>
		({
			id,
			key,
			type: "LayoutCell",
			parentId: "grid1",
			rowId,
			columnId,
			bindField: "",
			dataSource: "",
			dsType: "",
			bindText: "",
			viewText: "",
			fontSize: 12,
			...extra,
		}) as TplControl;
	const design: TplDesign = {
		key: "zlgd_tpl_1",
		formId: FORM,
		name: "样板模板",
		id: "root1",
		pages: [
			[
				{ id: "paper1", key: "Paper", type: "Paper", parentId: null },
				{
					id: "grid1",
					key: "LayoutGrid1",
					type: "LayoutGrid",
					parentId: "paper1",
					mergeConfig: { "1_0": { rowStart: 1, columnStart: 0, rowLength: 2, columnLength: 1 } },
				},
				{ id: "row1", key: "DataRow1", type: "DataRow", parentId: "grid1", rowHeight: 10 },
				{ id: "row2", key: "DataRow2", type: "DataRow", parentId: "grid1", rowHeight: 10 },
				{ id: "row3", key: "DataRow3", type: "DataRow", parentId: "grid1", rowHeight: 10 },
				{ id: "col1", key: "DataColumn1", type: "DataColumn", parentId: "grid1", columnWidth: 40 },
				{ id: "col2", key: "DataColumn2", type: "DataColumn", parentId: "grid1", columnWidth: 60 },
				cell("c11", "LayoutCell1", "row1", "col1", {
					bindField: "zlgd_bgbh",
					dataSource: FORM,
					dsType: "Main",
					viewText: "=$报告编号",
					bindText: "=$实验室检测单.报告编号",
				}),
				cell("c12", "LayoutCell2", "row1", "col2"),
				cell("c21", "LayoutCell3", "row2", "col1"),
				cell("c22", "LayoutCell4", "row2", "col2"),
				cell("c31", "LayoutCell5", "row3", "col1"),
				cell("c32", "LayoutCell6", "row3", "col2"),
			],
		],
	};
	const locale: TplLocale = {
		"c11.fontSize": { zh_CN: 12 },
		"c11.bindText": { zh_CN: "=$实验室检测单.报告编号" },
		"c21.fontSize": { zh_CN: 12 },
		"c21.bindText": { zh_CN: "" },
		"row2.rowHeight": { zh_CN: 10 },
	};
	return { design, locale };
}

const FIELDS: FieldOwnershipRow[] = [
	{ entity: FORM, key: "zlgd_bgbh", level: "header", entry: "", kind: "field" },
	{ entity: FORM, key: "zlgd_ypph", level: "header", entry: "", kind: "field" },
	{ entity: FORM, key: "zlgd_lch", level: "header", entry: "", kind: "field" },
	{ entity: FORM, key: "zlgd_ypbh", level: "entry", entry: "entryentity", kind: "field" },
];

/** 确定性随机源，让生成的 id 可预期。 */
function seeded(): () => number {
	let n = 0;
	return () => {
		n += 1;
		return ((n * 2654435761) % 4294967296) / 4294967296;
	};
}

function context(extra: Partial<EditContext> = {}): EditContext {
	const { design, locale } = fixture();
	return { design, locale, fields: FIELDS, rand: seeded(), ...extra };
}

const control = (design: TplDesign, key: string): TplControl => {
	const hit = allControls(design).find((site) => site.control.key === key);
	if (hit === undefined) throw new Error(`没有控件 ${key}`);
	return hit.control;
};

const view = (design: TplDesign, ref: string) => {
	const got = gridView(design, ref);
	if (got === null || isAmbiguous(got)) throw new Error("不是一张表格");
	return got;
};

describe("公式（批 2.2）", () => {
	it("把业务意思拼成平台认的片段数组：_enter_ 在顶层，同一字段复用同一个操作数 id", () => {
		const ctx = context();
		const done = applyEdit(ctx, {
			op: "formula",
			control: "LayoutCell3",
			lines: ["<zlgd_ypph>", "<zlgd_lch>"],
			blankText: "/",
		});
		expect(done.ok).toBe(true);
		const cell = control(ctx.design, "LayoutCell3");
		const parts = cell.formulaData as unknown[];
		expect(parts.filter((part) => part === "_enter_")).toHaveLength(1);
		const ids = new Map<string, Set<string>>();
		for (const part of parts) {
			if (!isOperand(part)) continue;
			const bucket = ids.get(part.bindField) ?? new Set<string>();
			bucket.add(part.id);
			ids.set(part.bindField, bucket);
		}
		expect([...ids.keys()].sort()).toEqual(["zlgd_lch", "zlgd_ypph"]);
		for (const bucket of ids.values()) expect(bucket.size).toBe(1);
		//操作数的形状：key 恒等于 <dataSource>-<bindField>
		const operand = parts.find((part) => isOperand(part) && part.bindField === "zlgd_ypph");
		expect(operand).toMatchObject({
			type: "label",
			dsType: "Main",
			dataSource: FORM,
			key: `${FORM}-zlgd_ypph`,
			children: [{ text: "" }],
		});
	});

	it("兜底文字只出现在第一行，不是每行一个", () => {
		const ctx = context();
		applyEdit(ctx, { op: "formula", control: "LayoutCell3", lines: ["<zlgd_ypph>", "<zlgd_lch>"], blankText: "/" });
		const text = formulaText(control(ctx.design, "LayoutCell3").formulaData, 500);
		expect(text.split("/").length - 1).toBe(1);
		expect(text).toContain("⏎");
	});

	it("带公式的格子自己不绑字段，显示名补进多语言旁路", () => {
		const ctx = context();
		applyEdit(ctx, { op: "formula", control: "LayoutCell3", lines: ["<zlgd_ypph>"] });
		const cell = control(ctx.design, "LayoutCell3");
		expect(cell).toMatchObject({ dsType: "Formula", bindField: "", dataSource: "", bindText: "公式" });
		const named = Object.keys(ctx.locale).filter((key) => key.startsWith("c21.formulaData."));
		expect(named).toHaveLength(1);
	});

	it("字段不存在就当场报，不留到落库", () => {
		const ctx = context();
		const done = applyEdit(ctx, { op: "formula", control: "LayoutCell3", lines: ["<zlgd_meiyou>"] });
		expect(done.ok).toBe(false);
		if (done.ok) return;
		expect(done.error.message).toContain("zlgd_meiyou");
	});

	it("自己写 _enter_ 会被挡下来——换行是多给一行", () => {
		const ctx = context();
		const done = applyEdit(ctx, { op: "formula", control: "LayoutCell3", lines: ['CONCAT("a","_enter_")'] });
		expect(done.ok).toBe(false);
	});
});

describe("绑定核对（批 2.5）", () => {
	it("分录字段的作用域和数据源由代码关系表定", () => {
		const ctx = context();
		const done = applyEdit(ctx, { op: "bind", control: "LayoutCell2", field: "zlgd_ypbh" });
		expect(done.ok).toBe(true);
		expect(control(ctx.design, "LayoutCell2")).toMatchObject({
			bindField: "zlgd_ypbh",
			dsType: "Entry",
			dataSource: `${FORM}.entryentity`,
		});
	});

	it("模板里已经在用的字段照抄它的中文名", () => {
		const ctx = context();
		applyEdit(ctx, { op: "bind", control: "LayoutCell2", field: "zlgd_bgbh" });
		expect(control(ctx.design, "LayoutCell2").viewText).toBe("=$报告编号");
	});

	it("表里查不到不算没有：收下来等平台核，不报「单据上没有」", () => {
		const ctx: EditContext = { ...context(), unresolved: new Set<string>() };
		const done = applyEdit(ctx, { op: "bind", control: "LayoutCell2", field: "billno" });
		expect(done.ok).toBe(false);
		if (done.ok) return;
		expect(done.error.message).toContain("平台元数据还没核");
		expect(done.error.message).not.toContain("上没有字段");
		expect([...(ctx.unresolved ?? [])]).toEqual(["billno"]);
	});

	it("继承来的原厂字段按平台元数据绑：表头 Main，分录 Entry", () => {
		const platform = {
			rows: [
				{ entity: FORM, key: "billno", level: "header", entry: "", parentEntry: "" },
				{ entity: FORM, key: "zlgd_jyjg", level: "entry", entry: "zlgd_entryentity_jx", parentEntry: "" },
			],
		};
		const ctx: EditContext = { ...context(), platform };
		expect(applyEdit(ctx, { op: "bind", control: "LayoutCell2", field: "billno" }).ok).toBe(true);
		expect(control(ctx.design, "LayoutCell2")).toMatchObject({ dsType: "Main", dataSource: FORM });
		expect(applyEdit(ctx, { op: "bind", control: "LayoutCell2", field: "zlgd_jyjg" }).ok).toBe(true);
		expect(control(ctx.design, "LayoutCell2")).toMatchObject({
			dsType: "Entry",
			dataSource: `${FORM}.zlgd_entryentity_jx`,
		});
	});

	it("平台也没有才说单据上没有；平台没核成就照实说没核成", () => {
		const missing = applyEdit(
			{ ...context(), platform: { rows: [{ entity: FORM, key: "billno", level: "header" }] } },
			{ op: "bind", control: "LayoutCell2", field: "zlgd_suibian" },
		);
		expect(missing.ok ? "" : missing.error.message).toContain("上没有字段「zlgd_suibian」（按平台元数据核的）");
		const failed = applyEdit(
			{ ...context(), platform: { error: "连不上环境" } },
			{ op: "bind", control: "LayoutCell2", field: "zlgd_suibian" },
		);
		expect(failed.ok ? "" : failed.error.message).toContain("平台元数据也没核成：连不上环境");
	});

	it("字段类型跟着字段走：模板里绑着的照抄，没用过的按平台元数据，都没有才是 Text", () => {
		const ctx = context();
		control(ctx.design, "LayoutCell2").bindField = "auditdate";
		Object.assign(control(ctx.design, "LayoutCell2"), { dataSource: FORM, dsType: "Main", textFormat: "Date" });
		applyEdit(ctx, { op: "formula", control: "LayoutCell3", lines: ["YEAR(<auditdate>)"] });
		const formats = (key: string) =>
			(control(ctx.design, key).formulaData as unknown[]).filter(isOperand).map((part) => part.textFormat);
		expect(formats("LayoutCell3")).toEqual(["Date"]);
		// 正要重写的那一格旧公式里类型写错了，不照抄它自己
		const stale = control(ctx.design, "LayoutCell3").formulaData as Record<string, unknown>[];
		for (const part of stale) if (isOperand(part)) part.textFormat = "Text";
		applyEdit(ctx, { op: "formula", control: "LayoutCell3", lines: ["MONTH(<auditdate>)"] });
		expect(formats("LayoutCell3")).toEqual(["Date"]);

		const platform = {
			rows: [
				{ entity: FORM, key: "createtime", level: "header", entry: "", textFormat: "Date" },
				{ entity: FORM, key: "zlgd_ypph", level: "header", entry: "", textFormat: "Text" },
				{ entity: FORM, key: "zlgd_lch", level: "header", entry: "", textFormat: "Number" },
			],
		};
		const typed: EditContext = { ...context(), platform };
		applyEdit(typed, { op: "formula", control: "LayoutCell3", lines: ["CONCAT(YEAR(<createtime>),<zlgd_lch>)"] });
		expect(
			(control(typed.design, "LayoutCell3").formulaData as unknown[]).filter(isOperand).map((p) => p.textFormat),
		).toEqual(["Date", "Number"]);
		expect(applyEdit(typed, { op: "bind", control: "LayoutCell4", field: "createtime" }).ok).toBe(true);
		expect(control(typed.design, "LayoutCell4").textFormat).toBe("Date");

		const untyped = context();
		applyEdit(untyped, { op: "formula", control: "LayoutCell3", lines: ["<zlgd_ypph>"] });
		expect(
			(control(untyped.design, "LayoutCell3").formulaData as unknown[]).filter(isOperand).map((p) => p.textFormat),
		).toEqual(["Text"]);
	});

	it("代码关系表查得到归属也收下来等平台核一次字段类型", () => {
		const ctx: EditContext = { ...context(), unresolved: new Set<string>() };
		expect(
			applyEdit(ctx, { op: "formula", control: "LayoutCell3", lines: ["<zlgd_ypph>", "<zlgd_jylx.name>"] }).ok,
		).toBe(false);
		expect([...(ctx.unresolved ?? [])]).toEqual(["zlgd_ypph", "zlgd_jylx"]);
	});

	it("换绑定不会被报成公式变化", () => {
		const ctx = context();
		const before = JSON.parse(JSON.stringify(ctx.design)) as TplDesign;
		applyEdit(ctx, { op: "bind", control: "LayoutCell2", field: "zlgd_ypph" });
		const changes = summarizeChanges(before, ctx.design);
		expect(changes.binding).toHaveLength(1);
		expect(changes.formula).toHaveLength(0);
	});
});

describe("控件增删（批 2.3）", () => {
	it("克隆给新 id 新 key，多语言键整套跟着走", () => {
		const ctx = context();
		const done = applyEdit(ctx, { op: "clone", control: "LayoutCell1" });
		expect(done.ok).toBe(true);
		const copies = allControls(ctx.design).filter((site) => site.control.bindField === "zlgd_bgbh");
		expect(copies).toHaveLength(2);
		const copy = copies.find((site) => site.control.id !== "c11")?.control as TplControl;
		expect(copy.key).not.toBe("LayoutCell1");
		expect(ctx.locale[`${copy.id}.fontSize`]).toEqual({ zh_CN: 12 });
	});

	it("克隆带公式的格子会换一套操作数 id", () => {
		const ctx = context();
		applyEdit(ctx, { op: "formula", control: "LayoutCell3", lines: ["<zlgd_ypph>"] });
		applyEdit(ctx, { op: "clone", control: "LayoutCell3" });
		const cells = allControls(ctx.design)
			.map((site) => site.control)
			.filter((one) => Array.isArray(one.formulaData) && (one.formulaData as unknown[]).some(isOperand));
		expect(cells).toHaveLength(2);
		const [first, second] = cells as [TplControl, TplControl];
		const idOf = (one: TplControl) =>
			((one.formulaData as unknown[]).find(isOperand) as { id: string } | undefined)?.id;
		expect(idOf(first)).not.toBe(idOf(second));
		expect(Object.keys(ctx.locale).filter((key) => key.includes(".formulaData."))).toHaveLength(2);
	});

	it("删一个还带着子控件的表格会被拒，不留孤儿", () => {
		const ctx = context();
		const done = applyEdit(ctx, { op: "delete", control: "LayoutGrid1" });
		expect(done.ok).toBe(false);
	});

	it("删一个格子连它的多语言键一起删", () => {
		const ctx = context();
		const done = applyEdit(ctx, { op: "delete", control: "LayoutCell1" });
		expect(done.ok).toBe(true);
		expect(Object.keys(ctx.locale).filter((key) => key.startsWith("c11."))).toHaveLength(0);
	});
});

describe("表格行列（批 2.4）", () => {
	it("插一行：行落在指定位置，每一列都配一个格子，新格子不继承内容", () => {
		const ctx = context();
		const done = applyEdit(ctx, { op: "insert-row", grid: "LayoutGrid1", at: 2 });
		expect(done.ok).toBe(true);
		const grid = view(ctx.design, "LayoutGrid1");
		expect(grid.rows).toHaveLength(4);
		expect(grid.rows[1]?.id).not.toBe("row2");
		expect(grid.cells[1]?.every((cell) => cell !== null)).toBe(true);
		for (const cell of grid.cells[1] as TplControl[]) expect(cell.bindField).toBe("");
	});

	it("插完说清新行落在哪：1 起的行号、0 起的下标、夹在哪两行之间（2026-09-21 真机）", () => {
		const middle = applyEdit(context(), { op: "insert-row", grid: "LayoutGrid1", at: 2 });
		if (!middle.ok) throw new Error("insert failed");
		expect(middle.value.said.join()).toContain("新行成了第 2 行（0 起的下标 1）");
		expect(middle.value.said.join()).toContain("夹在原第 1 行和原第 2 行之间");
		const tail = applyEdit(context(), { op: "insert-row", grid: "LayoutGrid1", at: 4 });
		if (!tail.ok) throw new Error("insert failed");
		expect(tail.value.said.join()).toContain("接在原最后一行（第 3 行）后面");
	});

	it("插一行之后合并区跟着往下搬", () => {
		const ctx = context();
		applyEdit(ctx, { op: "insert-row", grid: "LayoutGrid1", at: 1 });
		const merges = readMerges(control(ctx.design, "LayoutGrid1"));
		expect([...merges.values()]).toEqual([{ rowStart: 2, columnStart: 0, rowLength: 2, columnLength: 1 }]);
	});

	it("插在合并区中间是把这块拉长，不是整块搬走", () => {
		const ctx = context();
		applyEdit(ctx, { op: "insert-row", grid: "LayoutGrid1", at: 3 });
		const merges = readMerges(control(ctx.design, "LayoutGrid1"));
		expect([...merges.values()]).toEqual([{ rowStart: 1, columnStart: 0, rowLength: 3, columnLength: 1 }]);
	});

	it("--copy-row 只说照谁的样式，不改插在哪", () => {
		const ctx = context();
		applyEdit(ctx, { op: "insert-row", grid: "LayoutGrid1", at: 3, copyFrom: 1 });
		const grid = view(ctx.design, "LayoutGrid1");
		expect(grid.rows.map((row) => row.id).slice(0, 2)).toEqual(["row1", "row2"]);
		expect(grid.rows[2]?.id).not.toBe("row3");
		expect(grid.rows[3]?.id).toBe("row3");
	});

	it("插一列：每一行都配一个格子，列宽能指定", () => {
		const ctx = context();
		applyEdit(ctx, { op: "insert-col", grid: "LayoutGrid1", at: 2, width: 25 });
		const grid = view(ctx.design, "LayoutGrid1");
		expect(grid.columns).toHaveLength(3);
		expect(grid.columns[1]?.columnWidth).toBe(25);
		expect(grid.cells.every((row) => row[1] !== null)).toBe(true);
	});

	it("删一行连带这一行的格子，合并区跟着缩", () => {
		const ctx = context();
		const done = applyEdit(ctx, { op: "delete-row", grid: "LayoutGrid1", at: 2 });
		expect(done.ok).toBe(true);
		const grid = view(ctx.design, "LayoutGrid1");
		expect(grid.rows).toHaveLength(2);
		expect(grid.allCells).toHaveLength(4);
		//三行合并的那块只剩一行，就不再是合并区
		expect(readMerges(grid.grid).size).toBe(0);
		expect(Object.keys(ctx.locale).filter((key) => key.startsWith("c21."))).toHaveLength(0);
	});

	it("最后一行删不得", () => {
		const ctx = context();
		applyEdit(ctx, { op: "delete-row", grid: "LayoutGrid1", at: 3 });
		applyEdit(ctx, { op: "delete-row", grid: "LayoutGrid1", at: 2 });
		const done = applyEdit(ctx, { op: "delete-row", grid: "LayoutGrid1", at: 1 });
		expect(done.ok).toBe(false);
	});

	it("行号从 1 数起，越界当场说这张表格有几行", () => {
		const ctx = context();
		const done = applyEdit(ctx, { op: "delete-row", grid: "LayoutGrid1", at: 9 });
		expect(done.ok).toBe(false);
		if (done.ok) return;
		expect(done.error.message).toContain("3 行");
	});
});

describe("打印插件（模板级）", () => {
	//真模板里量的形状：plugins 是一段塞在字符串里的 JSON 数组，没登记过时是 null
	const TWO =
		'[{"FPK":"","Type":0,"Description":"动态行","RowKey":0,"ClassName":"demo.print.RowPlugin","DisplayName":"","Enabled":true,"BizAppId":"","Inherit":false},' +
		'{"FPK":"","Type":0,"Description":"审核人","RowKey":1,"ClassName":"demo.print.AuditorPlugin","DisplayName":"","Enabled":true,"BizAppId":"","Inherit":false}]';

	it("模板原来没有插件：登记成字符串里的 JSON 数组，键和设计器存出来的一样", () => {
		const ctx = context();
		ctx.design.plugins = null;
		const done = applyEdit(ctx, { op: "plugin", className: "demo.print.HidePlugin", description: "隐藏列" });
		expect(done.ok).toBe(true);
		expect(ctx.design.plugins).toBe(
			'[{"FPK":"","Type":0,"Description":"隐藏列","RowKey":0,"ClassName":"demo.print.HidePlugin","DisplayName":"","Enabled":true,"BizAppId":"","Inherit":false}]',
		);
		if (done.ok) expect(done.value.said[0]).toContain("模板原来没有插件");
	});

	it("模板已有插件：接在后面，原有的一个字节都不动", () => {
		const ctx = context();
		ctx.design.plugins = TWO;
		const done = applyEdit(ctx, { op: "plugin", className: "demo.print.HidePlugin" });
		expect(done.ok).toBe(true);
		const after = String(ctx.design.plugins);
		expect(after.startsWith(TWO.slice(0, -1))).toBe(true);
		const list = JSON.parse(after) as Record<string, unknown>[];
		expect(list).toHaveLength(3);
		expect(list[2]).toMatchObject({ ClassName: "demo.print.HidePlugin", RowKey: 2, Enabled: true, Description: "" });
		if (done.ok) expect(done.value.said[0]).toContain("原有 2 个原样保留");
	});

	it("同一个类登记第二次不会多出一项；停用的改回启用", () => {
		const ctx = context();
		ctx.design.plugins = TWO.replace(
			'"ClassName":"demo.print.AuditorPlugin","DisplayName":"","Enabled":true',
			'"ClassName":"demo.print.AuditorPlugin","DisplayName":"","Enabled":false',
		);
		const same = applyEdit(ctx, { op: "plugin", className: "demo.print.RowPlugin" });
		expect(same.ok && same.value.said[0]).toContain("没有改动");
		const enabled = applyEdit(ctx, { op: "plugin", className: "demo.print.AuditorPlugin" });
		expect(enabled.ok && enabled.value.said[0]).toContain("改成启用");
		expect(ctx.design.plugins).toBe(TWO);
	});

	it("类名要带包名：写成文件名或中文名当场拒", () => {
		for (const className of ["HidePlugin", "demo/print/HidePlugin.java", "隐藏列插件"]) {
			const ctx = context();
			const done = applyEdit(ctx, { op: "plugin", className });
			expect(done.ok).toBe(false);
			expect(ctx.design.plugins).toBeUndefined();
		}
	});

	it("撤掉一个：其余顺序不变、序号重排；撤光了回到 null", () => {
		const ctx = context();
		ctx.design.plugins = TWO;
		expect(applyEdit(ctx, { op: "remove-plugin", className: "demo.print.RowPlugin" }).ok).toBe(true);
		const list = JSON.parse(String(ctx.design.plugins)) as Record<string, unknown>[];
		expect(list).toHaveLength(1);
		expect(list[0]).toMatchObject({ ClassName: "demo.print.AuditorPlugin", RowKey: 0 });
		expect(applyEdit(ctx, { op: "remove-plugin", className: "demo.print.AuditorPlugin" }).ok).toBe(true);
		expect(ctx.design.plugins).toBeNull();
	});

	it("撤一个没登记的：报错里列出登记着哪些", () => {
		const ctx = context();
		ctx.design.plugins = TWO;
		const done = applyEdit(ctx, { op: "remove-plugin", className: "demo.print.Nope" });
		expect(done.ok).toBe(false);
		if (done.ok) return;
		expect(done.error.remedy).toContain("demo.print.RowPlugin demo.print.AuditorPlugin");
	});

	it("plugins 被手改坏了：不往上叠，叫人退回去", () => {
		const ctx = context();
		ctx.design.plugins = '[{"ClassName":';
		const done = applyEdit(ctx, { op: "plugin", className: "demo.print.HidePlugin" });
		expect(done.ok).toBe(false);
		expect(ctx.design.plugins).toBe('[{"ClassName":');
	});

	it("概览里说得出登记着哪些插件", () => {
		const { design } = fixture();
		expect(overview(design).join("\n")).toContain("打印插件：没有");
		design.plugins = TWO;
		expect(overview(design).join("\n")).toContain(
			"打印插件 2 个：demo.print.RowPlugin（动态行）、demo.print.AuditorPlugin（审核人）",
		);
	});
});

describe("控件 id", () => {
	it("生成的 id 是十位，且不会和已有的撞", () => {
		const taken = new Set(["AAAAAAAAAA"]);
		const rand = seeded();
		const ids = new Set<string>();
		for (let i = 0; i < 200; i++) ids.add(makeId(taken, rand));
		expect(ids.size).toBe(200);
		for (const id of ids) expect(id).toMatch(/^[0-9A-Za-z]{10}$/);
	});
});

describe("候选工作区（批 2.1）", () => {
	const DUMP = "D:/proj/dump";
	const WORK = "D:/proj/cand";

	function fake(): FakeContext {
		const one = makeContext({});
		const { design, locale } = fixture();
		one.fs.put(`${DUMP}/zlgd_tpl_1.meta.json`, JSON.stringify(design));
		one.fs.put(`${DUMP}/zlgd_tpl_1.locale.json`, JSON.stringify(locale));
		one.fs.put(one.ctx.layout.impactIndex, JSON.stringify({ fields: FIELDS }));
		return one;
	}

	const run = async (one: FakeContext, argv: string[]) => {
		const result = await meta(one.ctx, argv);
		if (!result.ok) throw new Error(result.error.message);
		return result.value;
	};

	it("开候选：两份 JSON 复制进来，另留一份开工那一刻的副本", async () => {
		const one = fake();
		const report = await run(one, ["ptpl", "edit", WORK, "--open", DUMP]);
		expect(report.kind).toBe("edit");
		expect(report.text).toContain("zlgd_tpl_1");
		expect(one.fs.exists(`${WORK}/zlgd_tpl_1.meta.json`)).toBe(true);
		expect(one.fs.exists(`${WORK}/origin/zlgd_tpl_1.meta.json`)).toBe(true);
		//下一步怎么交回去，直接写在回话里
		expect(report.text).toContain("ptpl apply zlgd_tpl_1 --file");
	});

	it("候选文件分行写：一整行的旧 dump 开进来就分行，改一处之后和开工副本逐行比只差那几行", async () => {
		const one = fake();
		const { design } = fixture();
		one.fs.put(`${DUMP}/zlgd_tpl_1.meta.json`, JSON.stringify(design).replace('"fontSize":12', '"fontSize":12.0'));
		await run(one, ["ptpl", "edit", WORK, "--open", DUMP]);
		const origin = one.fs.read(`${WORK}/origin/zlgd_tpl_1.meta.json`);
		expect(one.fs.read(`${WORK}/zlgd_tpl_1.meta.json`)).toBe(origin);
		expect(origin.split("\n").length).toBeGreaterThan(20);
		expect(origin).toContain('\t\t\t\t"fontSize":12.0');

		await run(one, ["ptpl", "edit", WORK, "--formula", "LayoutCell3", "--line", "<zlgd_ypph>"]);
		const after = one.fs.read(`${WORK}/zlgd_tpl_1.meta.json`);
		expect(after).toContain('"fontSize":12.0');
		const before = new Set(origin.split("\n"));
		const added = after.split("\n").filter((line) => !before.has(line));
		expect(added.length).toBeGreaterThan(0);
		const kept = new Set(after.split("\n"));
		const removed = origin.split("\n").filter((line) => !kept.has(line));
		//改的只有 LayoutCell3（c21）：它原来放得下一行，加了公式放不下，就拆开成一个属性一行；别的控件一行没动
		expect(removed).toHaveLength(1);
		expect(removed[0]).toContain('"id":"c21"');
		expect(added[0]).toBe('\t\t\t\t"id":"c21",');
		expect(added.join("\n")).not.toMatch(/"id":"(?:c1\d|c22|c3\d|row\d|col\d|grid1)"/);
	});

	it("同一个目录不会被第二次开候选盖掉", async () => {
		const one = fake();
		await run(one, ["ptpl", "edit", WORK, "--open", DUMP]);
		const again = await meta(one.ctx, ["ptpl", "edit", WORK, "--open", DUMP]);
		expect(again.ok).toBe(false);
	});

	it("改一处之后 status 能说出改了什么、做过几步", async () => {
		const one = fake();
		await run(one, ["ptpl", "edit", WORK, "--open", DUMP]);
		await run(one, ["ptpl", "edit", WORK, "--formula", "LayoutCell3", "--line", "<zlgd_ypph>", "--blank", "/"]);
		const status = await run(one, ["ptpl", "edit", WORK, "--status"]);
		expect(status.text).toContain("1 处公式变化");
		expect(status.text).toContain("做过 1 步");
		expect(status.edit?.changed).toBe(1);
	});

	it("reset 把候选退回开工那一刻", async () => {
		const one = fake();
		await run(one, ["ptpl", "edit", WORK, "--open", DUMP]);
		await run(one, ["ptpl", "edit", WORK, "--formula", "LayoutCell3", "--line", "<zlgd_ypph>"]);
		await run(one, ["ptpl", "edit", WORK, "--reset"]);
		const status = await run(one, ["ptpl", "edit", WORK, "--status"]);
		expect(status.text).toContain("没有差异");
	});

	it("本地概览不进 Java 进程，也说得出每张表格几行几列", async () => {
		const one = fake();
		await run(one, ["ptpl", "edit", WORK, "--open", DUMP]);
		const report = await run(one, ["ptpl", "edit", WORK, "--overview", "--grid", "LayoutGrid1"]);
		expect(report.text).toContain("3 行 × 2 列");
		expect(report.text).toContain("第 1 行第 1 列");
		expect(one.proc.runs).toHaveLength(0);
	});

	it("登记打印插件：写进候选文件，开工副本不动，status 记成一处模板级变化", async () => {
		const one = fake();
		await run(one, ["ptpl", "edit", WORK, "--open", DUMP]);
		const added = await run(one, ["ptpl", "edit", WORK, "--plugin", "demo.print.HidePlugin", "--desc", "隐藏列"]);
		expect(added.text).toContain("登记打印插件 demo.print.HidePlugin（隐藏列）");
		expect(added.text).toContain("1 处模板级变化");
		//落到文件里是「字符串里的 JSON」：引号多转一层
		expect(one.fs.read(`${WORK}/zlgd_tpl_1.meta.json`)).toContain(
			String.raw`"plugins":"[{\"FPK\":\"\",\"Type\":0,\"Description\":\"隐藏列\",\"RowKey\":0,\"ClassName\":\"demo.print.HidePlugin\"`,
		);
		expect(one.fs.read(`${WORK}/origin/zlgd_tpl_1.meta.json`)).not.toContain("HidePlugin");
		const status = await run(one, ["ptpl", "edit", WORK, "--status"]);
		expect(status.text).toContain("模板级变化 plugins");
		expect(one.proc.runs).toHaveLength(0);

		await run(one, ["ptpl", "edit", WORK, "--remove-plugin", "demo.print.HidePlugin"]);
		const back = await run(one, ["ptpl", "edit", WORK, "--status"]);
		expect(back.text).toContain("这次改动：没有差异");
	});

	it("没开候选就改，先说清楚要先开一份", async () => {
		const one = fake();
		const done = await meta(one.ctx, ["ptpl", "edit", WORK, "--delete", "LayoutCell1"]);
		expect(done.ok).toBe(false);
		if (done.ok) return;
		expect(done.error.remedy).toContain("--open");
	});

	it("表里没收的字段（继承来的 billno）去平台核一次，核到就绑上", async () => {
		const one = makeContext({ probes: ["MetaProbe"] });
		const { design, locale } = fixture();
		one.fs.put(`${DUMP}/zlgd_tpl_1.meta.json`, JSON.stringify(design));
		one.fs.put(`${DUMP}/zlgd_tpl_1.locale.json`, JSON.stringify(locale));
		one.fs.put(one.ctx.layout.impactIndex, JSON.stringify({ fields: FIELDS }));
		one.fs.put(
			`${one.ctx.layout.probesDir.replace(/\\/g, "/")}/MetaProbe.java`,
			'class MetaProbe { void run() { env("META_ENTITY", ""); } }',
		);
		one.fs.write(
			one.ctx.layout.serverPid,
			JSON.stringify({
				pid: 321,
				keyId: one.ctx.runtimeKeyId,
				port: 1,
				startedAt: "",
				account: one.ctx.config.account,
				user: one.ctx.config.user,
			}),
		);
		one.proc.livePids.add(321);
		one.net.handler = () => ({
			ok: true,
			text:
				"RESULT OK 0\n" +
				'[PROBE-JSON] {"t":"field","key":"billno","level":"header","entry":"","parentEntry":""}\n' +
				'[PROBE-JSON] {"t":"field","key":"zlgd_jyjg","level":"entry","entry":"zlgd_entryentity_jx","parentEntry":""}\n',
		});
		await run(one, ["ptpl", "edit", WORK, "--open", DUMP]);
		const bound = await run(one, ["ptpl", "edit", WORK, "--bind", "LayoutCell2=billno"]);
		expect(bound.text).toContain(`billno（Main / ${FORM}）`);
		expect(one.net.requests).toHaveLength(1);
		// 表里有归属的也去平台核一次：字段类型只有平台报。模板里已经绑着的不再问。
		await run(one, ["ptpl", "edit", WORK, "--bind", "LayoutCell2=zlgd_ypbh"]);
		expect(one.net.requests).toHaveLength(2);
		await run(one, ["ptpl", "edit", WORK, "--bind", "LayoutCell4=zlgd_bgbh"]);
		expect(one.net.requests).toHaveLength(2);
		const wrong = await meta(one.ctx, ["ptpl", "edit", WORK, "--bind", "LayoutCell2=zlgd_suibian"]);
		expect(wrong.ok ? "" : wrong.error.message).toContain("上没有字段「zlgd_suibian」（按平台元数据核的）");
	});

	it("编辑不是写通道：apply=true 会被拒，落库只有 ptpl apply 那条路", async () => {
		const one = fake();
		await run(one, ["ptpl", "edit", WORK, "--open", DUMP]);
		const done = await meta(one.ctx, ["ptpl", "edit", WORK, "--status"], { apply: true });
		expect(done.ok).toBe(false);
	});
});

describe("命令解析", () => {
	it("一次只做一个操作", () => {
		const parsed = parseMeta(["ptpl", "edit", "D:/x", "--status", "--reset"]);
		expect(parsed.ok).toBe(false);
		if (parsed.ok) return;
		expect(parsed.error.message).toContain("一次只做一个操作");
	});

	it("行列操作要说清楚是哪张表格", () => {
		const parsed = parseMeta(["ptpl", "edit", "D:/x", "--insert-row", "2"]);
		expect(parsed.ok).toBe(false);
	});

	it("没给操作时把能做的都列出来", () => {
		const parsed = parseMeta(["ptpl", "edit", "D:/x"]);
		expect(parsed.ok).toBe(false);
		if (parsed.ok) return;
		expect(parsed.error.message).toContain("--formula");
	});

	it("--plugin 要给类全名；和别的操作一样一次一个", () => {
		const bare = parseMeta(["ptpl", "edit", "D:/x", "--plugin"]);
		expect(bare.ok).toBe(false);
		const parsed = parseMeta(["ptpl", "edit", "D:/x", "--plugin", "demo.print.HidePlugin", "--desc", "隐藏列"]);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok || parsed.value.kind !== "edit") return;
		expect(parsed.value.op).toEqual({ op: "plugin", className: "demo.print.HidePlugin", description: "隐藏列" });
	});

	it("--bind 要写成 控件=字段", () => {
		const parsed = parseMeta(["ptpl", "edit", "D:/x", "--bind", "LayoutCell1"]);
		expect(parsed.ok).toBe(false);
	});
});

describe("数字的原样（2026-09-21 真机踩到）", () => {
	it("整数值的小数写法原样写回：16.0 不许变成 16", () => {
		const text = '{"fontSize":16.0,"width":13.1,"index":0,"deep":{"a":[12.0,0.5]}}';
		const back = stringifyDesign(parseDesignText(text));
		expect(back).toBe(text);
	});

	it("字符串里长得像数字的内容不受影响", () => {
		const text = '{"bindText":"字号 16.0","viewText":"a\\"b 2.0"}';
		expect(stringifyDesign(parseDesignText(text))).toBe(text);
	});

	it("真改过的值照常写成数字", () => {
		const parsed = parseDesignText('{"fontSize":16.0,"columnWidth":40.0}') as Record<string, unknown>;
		parsed.columnWidth = 25;
		expect(stringifyDesign(parsed)).toBe('{"fontSize":16.0,"columnWidth":25}');
	});

	it("合并区坐标仍然是数字，读它的代码不用改", () => {
		const design = parseDesignText(
			'{"pages":[[{"id":"g","key":"G","type":"LayoutGrid","parentId":null,' +
				'"mergeConfig":{"1_0":{"rowStart":1,"columnStart":0,"rowLength":2.0,"columnLength":1}}}]]}',
		) as TplDesign;
		const merges = readMerges(design.pages[0]?.[0] as TplControl);
		expect([...merges.values()]).toEqual([{ rowStart: 1, columnStart: 0, rowLength: 2, columnLength: 1 }]);
	});

	it("整份读进来再写出去，一个字节都不变（拿真模板那种形状试）", () => {
		const { design } = fixture();
		const text = JSON.stringify(design).replace('"fontSize":12', '"fontSize":12.0');
		expect(stringifyDesign(parseDesignText(text))).toBe(text);
	});
});

describe("概览", () => {
	it("一张模板的结构概览是几行字，不是那份 250 KB 的 JSON", () => {
		const { design } = fixture();
		const lines = overview(design);
		expect(lines.join("\n").length).toBeLessThan(500);
		expect(lines.join("\n")).toContain("3 行 × 2 列");
	});
});
