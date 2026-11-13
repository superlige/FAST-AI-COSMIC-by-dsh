import { describe, expect, it } from "vitest";
import {
	buildLogView,
	enclosingMethod,
	headlineOf,
	kindOf,
	parseFrames,
	renderLogView,
	rowText,
	type SourceLookup,
} from "../../src/kernel/prod/log-view.ts";
import type { MonitorRow } from "../../src/kernel/prod/monitor.ts";

// 行的形状照 2026-11-11 真机 monitor 返回：正文网页转义过、message2 是 message 的续行、logtags 带单据和 traceId
const SOURCE = [
	"package demo.order;",
	"",
	"public class DemoOrderService {",
	"    public void pushOrder(String id) {",
	"        String a = id.trim();",
	"        ConvertServiceHelper.pushAndSave(args);",
	"    }",
	"",
	"    private void other() {",
	"        int x = 1;",
	"    }",
	"}",
];

const lookup: SourceLookup = (className, file) =>
	className === "demo.order.DemoOrderService" && file === "DemoOrderService.java"
		? { path: "demo-mod/src/main/java/demo/order/DemoOrderService.java", lines: SOURCE, changedSinceBaseline: false }
		: className === "demo.order.Changed"
			? { path: "demo-mod/src/main/java/demo/order/Changed.java", lines: SOURCE, changedSinceBaseline: true }
			: null;

function exceptionRow(
	line: number,
	method = "pushOrder",
	traceId = "t1",
	time = "2026-11-11 15:42:21.112",
): MonitorRow {
	return {
		level: "ERROR",
		className: "kd.bos.mservice.Handler",
		methodName: "invoke",
		line: 88,
		time,
		message: `java.lang.NullPointerException: x is null\n\tat kd.bos.form.Base.call(Base.java:10)\n\tat demo.order.DemoOrderService.${method}(DemoOrderService.java:${String(line)})\n\tat kd.zdemo.other.Elsewhere.run(Elsewhere.java:5)`,
		logtags: { traceId, formId: "demo_bill", opKey: "submit" },
	};
}

describe("日志正文", () => {
	it("还原网页转义，续行拼回一段", () => {
		const text = rowText({
			message: "op：&#39;tbmain[bar_submit, submit]&#39;，errCont",
			message2: "ent：&#39;部门不对&#39;",
		});
		expect(text).toBe("op：'tbmain[bar_submit, submit]'，errContent：'部门不对'");
	});

	it("分种类：慢SQL 不是报错，界面报错单独一类", () => {
		expect(kindOf({ className: "kd.bos.slowlog.SlowLogger" }, "SlowLogger-JDBC: sql cost 5869ms")).toBe("慢SQL");
		expect(kindOf({ className: "kd.bos.form.log.FormBehaviorErrorReporter" }, "x")).toBe("界面报错");
		expect(kindOf({ className: "a.B" }, "boom\n\tat a.B.c(B.java:1)")).toBe("异常");
		expect(kindOf({ className: "a.B" }, "普通一句话")).toBe("其他");
	});

	it("界面报错的标题取操作、标题、内容", () => {
		const text = "op：'tbmain[bar_submit, submit]'，errTitle：''，errContent：'销售部门不对'";
		expect(headlineOf(text, "界面报错")).toBe("操作 tbmain[bar_submit, submit]｜销售部门不对");
	});

	it("认堆栈行，带不带行号都认", () => {
		expect(parseFrames("x\n\tat a.b.C.m(C.java:12)\n\tat a.b.D.n(Native Method)")).toEqual([
			{ className: "a.b.C", method: "m", file: "C.java", line: 12, raw: "at a.b.C.m(C.java:12)" },
			{ className: "a.b.D", method: "n", file: "Native Method", line: null, raw: "at a.b.D.n(Native Method)" },
		]);
	});

	it("往上找所在方法：认声明，不把 if/for/赋值当方法", () => {
		expect(enclosingMethod(SOURCE, 6)).toBe("pushOrder");
		expect(enclosingMethod(SOURCE, 10)).toBe("other");
		expect(enclosingMethod(["    if (a) {", "        b();"], 2)).toBeNull();
	});
});

describe("对到本地源码", () => {
	it("本工程的行给文件、行号和那一行代码；像本 ISV 但本地没有的照实说", () => {
		const view = buildLogView([exceptionRow(6)], lookup, "zdemo");
		const frames = view.groups[0]?.sample.frames ?? [];
		const own = frames.find((f) => f.where === "本工程");
		expect(own).toMatchObject({
			path: "demo-mod/src/main/java/demo/order/DemoOrderService.java",
			code: "ConvertServiceHelper.pushAndSave(args);",
		});
		expect(own?.methodMismatch).toBeUndefined();
		expect(frames.find((f) => f.className === "kd.zdemo.other.Elsewhere")?.where).toBe("像本ISV但不在本工程");
		expect(frames.find((f) => f.className === "kd.bos.form.Base")?.where).toBe("平台或三方");
	});

	it("行号落进别的方法：标出源码和生产不是一个版本", () => {
		const view = buildLogView([exceptionRow(10)], lookup, "zdemo");
		const own = view.groups[0]?.sample.frames.find((f) => f.where === "本工程");
		expect(own?.methodMismatch).toBe("other");
		expect(renderLogView(view, false)).toContain("源码和生产不是一个版本");
	});

	it("文件在生产版本之后改过：标出行号可能对不上", () => {
		const row = exceptionRow(6);
		row.message = "boom\n\tat demo.order.Changed.pushOrder(Changed.java:6)";
		const text = renderLogView(buildLogView([row], lookup, "zdemo"), false);
		expect(text).toContain("在生产版本之后改过");
	});
});

describe("分组", () => {
	it("同一个错合成一组，报次数、时间范围和别的 traceId；带本工程代码的排前面，慢SQL 排最后", () => {
		const rows: MonitorRow[] = [
			{ level: "ERROR", className: "kd.bos.slowlog.SlowLogger", message: "SlowLogger-JDBC: sql cost 9000ms" },
			exceptionRow(6, "pushOrder", "t1", "2026-11-11 10:00:00"),
			exceptionRow(6, "pushOrder", "t2", "2026-11-11 11:00:00"),
			{ level: "ERROR", className: "kd.bos.x.Y", message: "plain error 123" },
		];
		const view = buildLogView(rows, lookup, "zdemo");
		expect(view.total).toBe(4);
		expect(view.byKind).toEqual({ 异常: 2, 界面报错: 0, 慢SQL: 1, 其他: 1 });
		expect(view.groups.map((g) => [g.kind, g.count])).toEqual([
			["异常", 2],
			["其他", 1],
			["慢SQL", 1],
		]);
		expect(view.groups[0]?.first).toBe("2026-11-11 10:00:00");
		expect(view.groups[0]?.last).toBe("2026-11-11 11:00:00");
		const text = renderLogView(view, false);
		expect(text).toContain("2 次，2026-11-11 10:00:00 ~ 2026-11-11 11:00:00");
		expect(text).toContain("同组其他 traceId：t2");
		expect(text).toContain("慢SQL 是平台的慢查询记录，不是报错");
	});

	it("给模型的那份只给本工程/本 ISV 调用行和抛出处，全文才有全部调用行和原文", () => {
		const view = buildLogView([exceptionRow(6)], lookup, "zdemo");
		const short = renderLogView(view, false);
		expect(short).toContain("抛出处：at kd.bos.form.Base.call(Base.java:10)");
		expect(short).not.toContain("---- 原文 ----");
		expect(renderLogView(view, true)).toContain("---- 原文 ----");
	});
});
