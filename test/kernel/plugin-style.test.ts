/**
 * S51 插件写法检查：只报这次新加的、三类该拦、豁免放行、跨类间接查库、常量类认单据。
 */

import { describe, expect, it } from "vitest";
import { fast, prepareFast } from "../../src/kernel/commands/fast.ts";
import {
	analyseStyle,
	blockingHits,
	buildConstIndex,
	classLengthNote,
	type StyleEnv,
	styleDelta,
} from "../../src/kernel/style/plugin-style.ts";
import { addSource, makeContext } from "./fake-context.ts";

const CONST = `package demo.cons;
public class DemoBillConst {
    public static final String ENTITY = "demo_bill";
    public static final String QTY = "demo_qty";
    public static final String SRC_ID = "demo_srcid";
}
`;

const consts = buildConstIndex([{ file: "demo/cons/DemoBillConst.java", text: CONST }], "demo");
const env = (selfClass = "DemoOp", extra: Partial<StyleEnv> = {}): StyleEnv => ({ consts, selfClass, ...extra });

const plugin = (body: string, extra = ""): string => `package demo.op;
import demo.cons.DemoBillConst;
public class DemoOp extends AbstractOperationServicePlugIn {
${extra}
    @Override
    public void beginOperationTransaction(BeginOperationTransactionArgs e) {
        String entity = DemoBillConst.ENTITY;
${body}
    }
}
`;

const LOOP_QUERY = `        for (DynamicObject bill : e.getDataEntities()) {
            DynamicObject src = BusinessDataServiceHelper.loadSingle(bill.get("id"), entity);
        }`;

describe("循环里查库", () => {
	it("报循环里的直接查库，不报循环外的", () => {
		const report = analyseStyle(plugin(LOOP_QUERY), env());
		expect(report?.hits.map((hit) => hit.kind)).toEqual(["db-loop"]);
		const outside = analyseStyle(
			plugin(`        DynamicObject[] all = BusinessDataServiceHelper.load(ids, entity);
        for (DynamicObject bill : all) { bill.set("x", 1); }`),
			env(),
		);
		expect(outside?.hits).toEqual([]);
	});

	it("newDynamicObject 不算查库，loadFromCache 算查缓存", () => {
		const report = analyseStyle(
			plugin(`        for (int i = 0; i < 3; i++) {
            DynamicObject row = BusinessDataServiceHelper.newDynamicObject(entity);
            Map<Object, DynamicObject> m = BusinessDataServiceHelper.loadFromCache(ids, entity);
        }`),
			env(),
		);
		expect(report?.hits.map((hit) => hit.kind)).toEqual(["cache-loop"]);
	});

	it("经本文件的方法间接查库", () => {
		const report = analyseStyle(
			plugin(
				`        for (DynamicObject bill : e.getDataEntities()) { loadSrc(bill); }`,
				`    private DynamicObject loadSrc(DynamicObject bill) {
        return QueryServiceHelper.queryOne("demo_src", "id", null);
    }`,
			),
			env(),
		);
		expect(report?.hits.map((hit) => hit.kind)).toContain("db-loop-indirect");
	});

	it("经别的类的静态方法查库，按代码关系表答", () => {
		const text = plugin(`        for (DynamicObject bill : e.getDataEntities()) { DemoService.find(bill); }`);
		const withIndex = analyseStyle(
			text,
			env("DemoOp", { externalTouchesDb: (cls, method) => cls === "DemoService" && method === "find" }),
		);
		expect(withIndex?.hits.map((hit) => hit.kind)).toEqual(["db-loop-indirect"]);
		expect(analyseStyle(text, env())?.hits).toEqual([]);
	});

	it("豁免注释在上一行或同一行：照记，不拦", () => {
		const exempt = LOOP_QUERY.replace(
			"            DynamicObject src",
			"            // cosmic-allow: 按下游单据类型分组\n            DynamicObject src",
		);
		const delta = styleDelta(plugin(""), plugin(exempt), env());
		expect(delta?.added[0]?.exempt).toBe("按下游单据类型分组");
		expect(blockingHits(delta as NonNullable<typeof delta>)).toEqual([]);
	});
});

describe("常量", () => {
	it("已在用常量类还写字符串：该拦；没在用的只报", () => {
		const used = analyseStyle(plugin(`        Object q = e.getDataEntities()[0].get("demo_qty");`), env());
		expect(used?.hits.map((hit) => hit.kind)).toEqual(["literal-dup-used"]);
		expect(used?.hits[0]?.text).toContain("DemoBillConst.QTY");
		const notUsed = analyseStyle(
			plugin(`        Object q = e.getDataEntities()[0].get("demo_qty");`).replace(
				"String entity = DemoBillConst.ENTITY;",
				"",
			),
			env(),
		);
		expect(notUsed?.hits.map((hit) => hit.kind)).toEqual(["literal-dup"]);
	});

	it("一句里写的是别的单：只认管那张单的常量类；没有常量类管它就只报不拦", () => {
		const process = `package demo.cons;
public class DemoProcessConst {
    public static final String PROCESS_ENTITY = "demo_process";
    public static final String PROCESS_SRC = "demo_srcid";
}
`;
		const both = buildConstIndex(
			[
				{ file: "demo/cons/DemoBillConst.java", text: CONST },
				{ file: "demo/cons/DemoProcessConst.java", text: process },
			],
			"demo",
		);
		const known = new Set(["demo_bill", "demo_process", "demo_store"]);
		const withBoth = { consts: both, selfClass: "DemoOp", entities: known };
		const other = analyseStyle(
			plugin(
				`        DynamicObject[] rows = BusinessDataServiceHelper.load("demo_store", "id",\n                new QFilter[]{new QFilter("demo_qty", QCP.equals, 1)});`,
			),
			withBoth,
		);
		expect(other?.hits.map((hit) => hit.kind)).toEqual(["literal-dup"]);
		expect(other?.hits[0]?.text).toContain("demo_store");
		const process2 = analyseStyle(
			plugin(
				`        DynamicObject[] rows = BusinessDataServiceHelper.load(DemoProcessConst.PROCESS_ENTITY, "id",\n                new QFilter[]{new QFilter("demo_srcid", QCP.equals, 1)});`,
			),
			withBoth,
		);
		expect(process2?.hits.map((hit) => hit.kind)).toEqual(["literal-dup-used"]);
		expect(process2?.hits[0]?.text).toContain("DemoProcessConst.PROCESS_SRC");
	});

	it("自己又声明一份常量类里已有的", () => {
		const report = analyseStyle(plugin("", `    private static final String QTY = "demo_qty";`), env());
		expect(report?.hits.map((hit) => hit.kind)).toEqual(["own-const-dup"]);
	});

	it("常量类自己不查；认得出它管哪张单", () => {
		expect(analyseStyle(CONST, env("DemoBillConst"))?.hits).toEqual([]);
		expect(consts.classes.get("DemoBillConst")).toMatchObject({ entity: "demo_bill", codes: 3 });
	});
});

describe("只算这次新加的", () => {
	it("老代码里本来就有的不报，新加一处才报", () => {
		const before = plugin(LOOP_QUERY);
		expect(styleDelta(before, before, env())?.added).toEqual([]);
		const after = plugin(`${LOOP_QUERY}\n${LOOP_QUERY}`);
		expect(styleDelta(before, after, env())?.added.map((hit) => hit.kind)).toEqual(["db-loop"]);
	});

	it("新文件全算；类长度只在长过线、或往超线的类里加时说", () => {
		const delta = styleDelta(null, plugin(LOOP_QUERY), env());
		expect(delta?.created).toBe(true);
		expect(delta?.added).toHaveLength(1);
		const long = (n: number) => plugin("", Array.from({ length: n }, (_, i) => `    int f${String(i)};`).join("\n"));
		expect(
			classLengthNote(styleDelta(long(100), long(600), env()) as NonNullable<ReturnType<typeof styleDelta>>),
		).toContain("长过 500 行");
		expect(
			classLengthNote(styleDelta(long(600), long(600), env()) as NonNullable<ReturnType<typeof styleDelta>>),
		).toBeNull();
		expect(
			classLengthNote(styleDelta(long(600), long(620), env()) as NonNullable<ReturnType<typeof styleDelta>>),
		).toContain("服务类");
	});

	it("加了常量类的 import、新方法用上它，老代码里原样没动的字符串不算新加；新方法里写的才算，报在新行上", () => {
		const old = `        Object q = e.getDataEntities()[0].get("demo_qty");`;
		const before = plugin(old).replace("String entity = DemoBillConst.ENTITY;", "");
		expect(analyseStyle(before, env())?.hits.map((hit) => hit.kind)).toEqual(["literal-dup"]);
		const reuse = plugin(old).replace(
			"String entity = DemoBillConst.ENTITY;",
			"Object src = e.getDataEntities()[0].get(DemoBillConst.SRC_ID);",
		);
		const quiet = styleDelta(before, reuse, env());
		expect(quiet?.added).toEqual([]);
		const fresh = `${old}\n        Object again = e.getDataEntities()[0].get("demo_qty");`;
		const after = plugin(fresh).replace(
			"String entity = DemoBillConst.ENTITY;",
			"Object src = DemoBillConst.SRC_ID;",
		);
		const delta = styleDelta(before, after, env()) as NonNullable<ReturnType<typeof styleDelta>>;
		expect(blockingHits(delta).map((hit) => hit.line)).toEqual([
			after.split("\n").indexOf(fresh.split("\n")[1] as string) + 1,
		]);
	});

	it("新长出来的超 80 行方法", () => {
		const body = Array.from({ length: 90 }, (_, i) => `        int v${String(i)} = ${String(i)};`).join("\n");
		expect(styleDelta(plugin(""), plugin(body), env())?.newLongMethods).toHaveLength(1);
	});
});

describe("编译前兜底", () => {
	it("有该拦的就不进编译，用自己的错误码，每一处列出来", async () => {
		const fake = makeContext();
		addSource(fake, "demo-biz", "A.java");
		const gate = () => [{ file: "A.java", lines: ["第 3 行 循环里调 QueryServiceHelper.queryOne"] }];
		const prepared = prepareFast(fake.ctx, ["A.java"], { styleGate: gate });
		expect(prepared.blockers.map((blocker) => blocker.code)).toEqual(["STYLE_GATE_UNSATISFIED"]);
		expect(prepared.blockers[0]?.remedy).toContain("cosmic-allow");
		const result = await fast(fake.ctx, ["A.java"], { styleGate: gate });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("STYLE_GATE_UNSATISFIED");
		expect(fake.proc.runs).toHaveLength(0);
	});

	it("没有就放行", () => {
		const fake = makeContext();
		addSource(fake, "demo-biz", "A.java");
		expect(prepareFast(fake.ctx, ["A.java"], { styleGate: () => [] }).blockers).toEqual([]);
	});
});
