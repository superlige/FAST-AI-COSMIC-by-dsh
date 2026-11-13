/**
 * 插件链上的发消息、调接口、存附件：S27 起只提醒、不拦。
 *
 * 以前运行在回滚事务里，这类动作撤不回，前检按插件登记（必要时现读操作链）拦在起 JVM 之前。
 * 用户 2026-09-19 定：agent 连的必然是纯测试环境，外部接口和消息都放开；运行改成真提交，
 * 前检只把会真的发出去的插件列在 warnings 里。
 */

import { describe, expect, it } from "vitest";
import { prepareRunInvocation } from "../../src/kernel/commands/run.ts";
import { type FakeContext, makeContext } from "./fake-context.ts";

const BILL = "zlgd_sys_test_bill";
const TPL = "zlgd_sys_test_bill_prtpl";

interface IndexedClass {
	name: string;
	kind: string;
	numbers?: string[];
	source: string;
}

/** 一个有代码关系表的工程：每个类既有源码，也有登记。 */
function project(classes: IndexedClass[]): FakeContext {
	const fake = makeContext({ config: { codeModules: ["demo-biz"] } });
	const src = fake.ctx.layout.moduleDirs[0]?.src ?? "";
	for (const cls of classes) fake.fs.put(`${src}/com/demo/${cls.name}.java`, cls.source);
	fake.fs.put(
		fake.ctx.layout.impactIndex,
		JSON.stringify({
			kind: "ImpactIndex",
			at: "2026-09-19T00:00:00.000Z",
			classes: classes.map((cls) => ({
				class: `com.demo.${cls.name}`,
				file: `src/main/java/com/demo/${cls.name}.java`,
				pluginType: cls.kind === "form" ? "form" : cls.kind === "print" ? "print" : "operation",
				bindings: [{ entity: BILL, kind: cls.kind, layouts: 1, enabled: true, numbers: cls.numbers ?? [BILL] }],
				entities: [],
				fields: [],
				chain: [],
			})),
		}),
	);
	return fake;
}

const OP_PLUGIN: IndexedClass = {
	name: "TestBillOpPlugin",
	kind: "entity",
	source: "public class TestBillOpPlugin { void audit(){ AttachmentServiceHelper.upload(); } }",
};

const FORM_PLUGIN: IndexedClass = {
	name: "UploadFormPlugin",
	kind: "form",
	source: "public class UploadFormPlugin { void click(){ AttachmentServiceHelper.upload(); } }",
};

const PRINT_PLUGIN: IndexedClass = {
	name: "NotifyPrintPlugin",
	kind: "print",
	numbers: [TPL],
	source: "public class NotifyPrintPlugin { void after(){ MessagePublisher.send(); } }",
};

describe("事务外动作只提醒、不拦（S27）", () => {
	it("操作插件上的附件动作：run op 照跑，warnings 里说会真的发出去", () => {
		const fake = project([OP_PLUGIN]);
		const prepared = prepareRunInvocation(fake.ctx, ["op", BILL, "audit", "--pk", "100"]);
		expect(prepared.blockers).toEqual([]);
		expect(prepared.plan).not.toBeNull();
		const note = prepared.warnings.join("\n");
		expect(note).toContain("TestBillOpPlugin");
		expect(note).toContain("会真的发出去");
	});

	it("run op 不开表单：只登记成界面插件的类不提", () => {
		const fake = project([FORM_PLUGIN]);
		const prepared = prepareRunInvocation(fake.ctx, ["op", BILL, "save"]);
		expect(prepared.blockers).toEqual([]);
		expect(prepared.warnings.join("\n")).not.toContain("UploadFormPlugin");
	});

	it("run form 点按钮：界面插件照跑、照提，不再要 --skip", () => {
		const fake = project([FORM_PLUGIN]);
		const prepared = prepareRunInvocation(fake.ctx, ["form", BILL, "--click", "bar_save"]);
		expect(prepared.blockers).toEqual([]);
		expect(prepared.warnings.join("\n")).toContain("UploadFormPlugin");
	});

	it("run print 只提登记在这张模板上的打印插件", () => {
		const fake = project([PRINT_PLUGIN, OP_PLUGIN]);
		const prepared = prepareRunInvocation(fake.ctx, ["print", TPL, "--pk", "100", "--show", "datacell1"]);
		expect(prepared.blockers).toEqual([]);
		const note = prepared.warnings.join("\n");
		expect(note).toContain("NotifyPrintPlugin");
		expect(note).not.toContain("TestBillOpPlugin");
	});
});

describe("运行不再强制冷进程（S27）", () => {
	it("带改值、按钮、操作的运行都走常驻进程；只有 --real-cache 仍然冷", () => {
		const fake = project([]);
		const cold = (argv: string[]) => prepareRunInvocation(fake.ctx, argv).plan?.cold;
		expect(cold(["op", BILL, "save", "--set", "billno=T1"])).toBe(false);
		expect(cold(["print", TPL, "--pk", "100", "--set", "zlgd_bz=x", "--show", "datacell1"])).toBe(false);
		expect(cold(["form", BILL, "--op", "save"])).toBe(false);
		expect(cold(["form", BILL, "--real-cache", "1"])).toBe(true);
	});

	it("计划里不再带 ROLLBACK=1", () => {
		const fake = project([]);
		const plan = prepareRunInvocation(fake.ctx, ["op", BILL, "save", "--set", "billno=T1"]).plan;
		expect(plan?.env.ROLLBACK).toBeUndefined();
	});
});
