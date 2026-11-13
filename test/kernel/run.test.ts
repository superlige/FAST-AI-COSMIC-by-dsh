import { describe, expect, it } from "vitest";
import {
	composeOpCases,
	newBillScenarios,
	type ParsedRunArgs,
	parseRunArgs,
	planRun,
	prepareRun,
	prepareRunInvocation,
	run,
	splitRunCases,
} from "../../src/kernel/commands/run.ts";
import { type FakeContext, makeContext } from "./fake-context.ts";

const plan = (argv: string[]) => planRun(argv);

/** Every run kind's probe source has to exist for probe() to resolve it. */
function runFake(): FakeContext {
	const fake = makeContext({
		probes: ["OpSandbox", "FormSim", "ListSim", "FormCallbackSim", "FormFlowSim", "RuleSim", "PrintSim"],
	});
	for (const name of ["OpSandbox", "FormSim", "ListSim", "FormCallbackSim", "FormFlowSim", "RuleSim", "PrintSim"]) {
		fake.fs.put(`${fake.ctx.layout.probesDir.replace(/\\/g, "/")}/${name}.java`, `public class ${name} {}`);
	}
	return fake;
}

describe("S5.2 run argument parsing", () => {
	it("aggregates independent pure parameter defects into one preparation", () => {
		const prepared = prepareRun(["rule", "wrong", "--scene", "bad", "--branch", "bad", "--list", "bad"], "runtime-1");
		expect(prepared.plan).toBeNull();
		expect(prepared.blockers.map((blocker) => blocker.message).join("\n")).toContain("--scene");
		expect(prepared.blockers.map((blocker) => blocker.message).join("\n")).toContain("--branch");
		expect(prepared.blockers.map((blocker) => blocker.message).join("\n")).toContain("--list");
		expect(prepared.capsules[0]?.kind).toBe("run-adapter");
	});

	it("warns before the cold start when the form target carries none of this project's plugins", () => {
		// 复盘二.2 的另一半：FormSim 会把布局标识落到实体继续跑，所以挂实体也能 PASS ——
		// 装的却是另一份插件清单。这个 PASS 可以被转正成回归用例，代价是一次冷启动。
		const fake = makeContext();
		fake.fs.put(
			fake.ctx.layout.impactIndex,
			JSON.stringify({
				kind: "ImpactIndex",
				at: "2026-09-10T00:00:00.000Z",
				classes: [
					{
						class: "com.demo.LSYDFormPlugin",
						file: "src/main/java/com/demo/LSYDFormPlugin.java",
						pluginType: "form",
						bindings: [
							{
								entity: "zlgd_sys_test_bill",
								kind: "form",
								layouts: 1,
								enabled: true,
								numbers: ["zlgd_sys_test_bill_lsyd"],
							},
						],
						entities: [],
						fields: [],
						chain: [],
					},
				],
			}),
		);
		const onEntity = prepareRunInvocation(fake.ctx, ["form", "zlgd_sys_test_bill"]);
		expect(onEntity.blockers).toEqual([]);
		expect(onEntity.warnings.join(" ")).toContain("zlgd_sys_test_bill_lsyd");
		expect(onEntity.warnings.join(" ")).toContain("LSYDFormPlugin");
		// 直接点名布局就没有可提醒的了。
		expect(prepareRunInvocation(fake.ctx, ["form", "zlgd_sys_test_bill_lsyd"]).warnings).toEqual([]);
	});

	it("says the registration check was not made when there is no index to read", () => {
		const fake = makeContext();
		const prepared = prepareRunInvocation(fake.ctx, ["form", "zlgd_sys_test_bill"]);
		expect(prepared.warnings).toEqual([]);
		expect(prepared.deferred.flatMap((entry) => entry.dependsOn)).toContain("impact.meta-index");
	});

	it("notes target-linked attachment or network effects instead of refusing (S27)", () => {
		const fake = makeContext({ config: { codeModules: ["demo-biz"] } });
		const src = `${fake.ctx.layout.moduleDirs[0]?.src ?? ""}/DangerPlugin.java`;
		fake.fs.put(
			src,
			'public class DangerPlugin { String target = "zlgd_bill"; void run(){ AttachmentServiceHelper.upload(); HttpClient.send(); } }',
		);
		const prepared = prepareRunInvocation(fake.ctx, ["form", "zlgd_bill", "--click", "bar_save"]);
		// 测试环境放开了外部接口（用户 2026-09-19）：照跑，只在 warnings 里说会真的发出去。
		expect(prepared.blockers).toEqual([]);
		expect(prepared.warnings.join("\n")).toContain("HttpClient");
		expect(prepared.warnings.join("\n")).toContain("会真的发出去");
	});

	it("names the source-linkage basis when there is no index", () => {
		// The note must not read as a fact about the operation chain when nothing was
		// read but the file's text.
		const fake = makeContext({ config: { codeModules: ["demo-biz"] } });
		fake.fs.put(
			`${fake.ctx.layout.moduleDirs[0]?.src ?? ""}/DangerPlugin.java`,
			'public class DangerPlugin { String target = "zlgd_bill"; void run(){ AttachmentServiceHelper.upload(); } }',
		);
		const prepared = prepareRunInvocation(fake.ctx, ["form", "zlgd_bill", "--click", "bar_save"]);
		expect(prepared.blockers).toEqual([]);
		expect(prepared.warnings.join("\n")).toContain("可能是误判");
	});

	it("判「在不在操作链上」用登记关系，不用源码里提到过（zlgd_ygpt2.0 复盘 §三.1）", () => {
		// 真机上 run op zlgd_qty_wtd save 被拒，理由是 TestBillOpPlugin 有附件副作用；
		// 而 OpMetaProbe 显示 save 链上只有 CodeRuleOp + QTYWTDOpPlugin，两个都不是它。
		// 它只是因为要下推到这张单，才在源码里写了这个标识。S27 起只提醒不拦，
		// 但提醒的判据仍然和平台读的是同一份东西，不能冤枉别的插件。
		const fake = makeContext({ config: { codeModules: ["demo-biz"] } });
		const src = fake.ctx.layout.moduleDirs[0]?.src ?? "";
		fake.fs.put(
			`${src}/com/demo/TestBillOpPlugin.java`,
			'public class TestBillOpPlugin { String pushTo = "zlgd_qty_wtd"; void run(){ AttachmentServiceHelper.upload(); } }',
		);
		fake.fs.put(
			fake.ctx.layout.impactIndex,
			JSON.stringify({
				kind: "ImpactIndex",
				at: "2026-09-14T00:00:00.000Z",
				classes: [
					{
						class: "com.demo.QTYWTDOpPlugin",
						file: "src/main/java/com/demo/QTYWTDOpPlugin.java",
						pluginType: "operation",
						bindings: [{ entity: "zlgd_qty_wtd", kind: "entity", layouts: 0, enabled: true, numbers: [] }],
						entities: [],
						fields: [],
						chain: [],
					},
					{
						class: "com.demo.TestBillOpPlugin",
						file: "src/main/java/com/demo/TestBillOpPlugin.java",
						pluginType: "operation",
						bindings: [{ entity: "zlgd_test_bill", kind: "entity", layouts: 0, enabled: true, numbers: [] }],
						entities: [],
						fields: [],
						chain: [],
					},
				],
			}),
		);
		expect(prepareRunInvocation(fake.ctx, ["op", "zlgd_qty_wtd", "save"]).warnings.join("\n")).not.toContain(
			"TestBillOpPlugin",
		);

		// 真挂在这张单上的那个插件要提，并且说得出登记在哪。
		fake.fs.put(
			`${src}/com/demo/QTYWTDOpPlugin.java`,
			"public class QTYWTDOpPlugin { void run(){ AttachmentServiceHelper.upload(); } }",
		);
		const prepared = prepareRunInvocation(fake.ctx, ["op", "zlgd_qty_wtd", "save"]);
		expect(prepared.blockers).toEqual([]);
		const note = prepared.warnings.join("\n");
		expect(note).toContain("QTYWTDOpPlugin");
		expect(note).toContain("登记位置");
	});

	it("refuses an unknown flag instead of ignoring it", () => {
		// A silently ignored flag means "I verified with that setting" when nothing
		// of the sort happened.
		const parsed = parseRunArgs(["op", "zlgd_bill", "save", "--noSuchFlag"]);
		expect(parsed.ok).toBe(false);
		if (!parsed.ok) expect(parsed.error.code).toBe("RUN_ARGS_INVALID");
	});

	it("refuses a value flag with nothing after it", () => {
		expect(parseRunArgs(["form", "zlgd_bill", "--pk"]).ok).toBe(false);
	});

	it("写了参数却给空值的一律拦下，不当成没写", () => {
		// 真机 2026-10-11：前一步没查到单据内码，后两步写成 `--pk ""`。当成没写就从「对这张单反审核」
		// 变成「新建一张空单反审核」，`success=false` 的断言照样通过，验的不是要验的那张单。
		for (const argv of [
			["op", "zlgd_bill", "unaudit", "--pk", "", "--expect", "success=false"],
			["op", "zlgd_bill", "unaudit", "--pk", "  ", "--expect", "success=false"],
			["op", "zlgd_bill", "save", "--billno", ""],
			["op", "zlgd_bill", "save", "--expect", ""],
			["op", "zlgd_bill", "save", "--expect="],
			["op", "zlgd_bill", "save", "--set", ""],
			["form", "zlgd_bill", "--click", ""],
			["list", "zlgd_bill", "--filter="],
		]) {
			const parsed = parseRunArgs(argv);
			expect(parsed.ok, argv.join(" ")).toBe(false);
			if (!parsed.ok) {
				expect(parsed.error.code).toBe("RUN_ARGS_INVALID");
				expect(parsed.error.message).toContain("的值是空的");
			}
		}
	});

	it("值的位置上是另一个参数名，算没给值，不把参数名当值收下", () => {
		// 以前 `--pk --expect success=false` 把 `--expect` 当单据内码，`success=false` 成了没人看的位置参数。
		const parsed = parseRunArgs(["op", "zlgd_bill", "unaudit", "--pk", "--expect", "success=false"]);
		expect(parsed.ok).toBe(false);
		if (!parsed.ok) expect(parsed.error.message).toContain("--pk 后面缺一个值（紧跟着的是另一个参数 --expect）");
		expect(parseRunArgs(["op", "zlgd_bill", "save", "--set", "--expect=success=true"]).ok).toBe(false);
		// 值里带 `--` 但不是参数名的照常收
		const kept = parseRunArgs(["op", "zlgd_bill", "save", "--expect", "message=--pk"]);
		expect(kept.ok && kept.value.expects).toEqual(["message=--pk"]);
	});

	it("分场景里的空值同样拦下", () => {
		const result = plan(["op", "b", "unaudit", "--case", "甲", "--pk", "", "--expect", "success=false"]);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.message).toContain("--pk 的值是空的");
	});

	it("names the flags it knows, so the remedy points at something", () => {
		// "对照 run 的用法改" pointed at a usage text that is not shown anywhere.
		const parsed = parseRunArgs(["op", "zlgd_bill", "save", "--noSuchFlag"]);
		expect(parsed.ok).toBe(false);
		if (!parsed.ok) expect(parsed.error.remedy).toContain("--set");
	});

	it("keeps --set order, because order is business semantics", () => {
		const parsed = parseRunArgs(["--set", "a=1", "--set=b=2", "--set", "a=3"]);
		expect(parsed.ok && parsed.value.sets).toEqual(["a=1", "b=2", "a=3"]);
	});
});

describe("S5.2 run planning", () => {
	it("maps each kind to its adapter probe", () => {
		const op = plan(["op", "zlgd_bill", "save"]);
		expect(op.ok && op.value.probe).toBe("OpSandbox");
		const form = plan(["form", "zlgd_bill"]);
		expect(form.ok && form.value.probe).toBe("FormSim");
		const rule = plan(["rule", "form", "zlgd_layout"]);
		expect(rule.ok && rule.value.probe).toBe("RuleSim");
	});

	it("run form --hyperlink 点分录超链接：交给探针，断言照常带上；和 --click / --op 不一起给", () => {
		// 真机 2026-10-09：改的是分录超链接的处理，run form 只有按钮、操作、F7 能点，验不了也交不了。
		const result = plan([
			"form",
			"zlgd_sm_salorder_ext",
			"--pk",
			"100",
			"--hyperlink",
			"billentry[0].zlgd_dqnbhth",
			"--expect",
			"opened=zlgd_salorder_progress",
			"--expect",
			"message=",
		]);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.env).toMatchObject({
			FORM_HYPERLINK: "billentry[0].zlgd_dqnbhth",
			FORM_CLICK: "",
			FORM_EXPECT: "opened=zlgd_salorder_progress;message=",
		});
		expect(result.value.cold).toBe(false);
		for (const extra of [
			["--click", "bar_save"],
			["--op", "save"],
		]) {
			const both = plan(["form", "zlgd_bill", "--hyperlink", "billentry[0].f", ...extra]);
			expect(both.ok).toBe(false);
			if (!both.ok) expect(both.error.message).toContain("--hyperlink");
			const prepared = prepareRun(["form", "zlgd_bill", "--hyperlink", "billentry[0].f", ...extra], "runtime-1");
			expect(prepared.plan).toBeNull();
		}
	});

	it("run flow 的父动作可以是分录超链接，三个里只给一个", () => {
		const result = plan(["flow", "zlgd_bill", "--hyperlink", "billentry[1].f", "--child", "zlgd_child"]);
		expect(result.ok).toBe(true);
		if (result.ok)
			expect(result.value.env).toMatchObject({
				FLOW_PARENT_HYPERLINK: "billentry[1].f",
				FLOW_PARENT_CLICK: "",
				FLOW_PARENT_OP: "",
			});
		expect(plan(["flow", "zlgd_bill", "--hyperlink", "billentry[1].f", "--op", "x"]).ok).toBe(false);
		expect(plan(["flow", "zlgd_bill"]).ok).toBe(false);
		expect(prepareRun(["flow", "zlgd_bill", "--click", "a", "--hyperlink", "b[0].c"], "runtime-1").plan).toBeNull();
	});

	it("runs run op on the resident JVM and commits (S27)", () => {
		// The operation commits through the platform's own path, so the resident
		// JVM's caches follow it; the rollback that used to force a cold process is gone.
		const result = plan(["op", "zlgd_bill", "save", "--set", "a=1", "--expect", "success=true"]);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.cold).toBe(false);
		expect(result.value.env).toMatchObject({
			OP_ENTITY: "zlgd_bill",
			OP_NAME: "save",
			OP_SET: "a=1",
			OP_EXPECT: "success=true",
		});
		expect(result.value.env.ROLLBACK).toBeUndefined();
	});

	it("提交/审核不给 --pk、也没设单据状态：起 JVM 之前就拦，并说清为什么补字段也没用", () => {
		// 真机 2026-09-17：新建空单上 submit、状态没设，平台报「只有暂存的数据才允许提交」，白跑 96 秒。
		for (const argv of [
			["op", "zlgd_bill", "submit", "--set", "a=1"],
			["op", "zlgd_bill", "save", "--op", "AUDIT"],
		]) {
			const result = plan(argv);
			expect(result.ok).toBe(false);
			if (result.ok) continue;
			expect(result.error.code).toBe("RUN_ARGS_INVALID");
			expect(result.error.message).toContain("没设单据状态");
			expect(result.error.remedy).toContain("--pk");
			expect(result.error.remedy).toContain("billstatus=A");
		}
	});

	it("给了 --pk、在新单上自己摆了状态、或明说要验「会被拦」的，照常放行；save 不受影响", () => {
		expect(plan(["op", "zlgd_bill", "submit", "--pk", "100"]).ok).toBe(true);
		// run.md 的 `--case submit路径` 就是这么在新单上跑提交的。
		expect(plan(["op", "zlgd_bill", "submit", "--set", "status=A", "--set", "number=T2"]).ok).toBe(true);
		expect(plan(["op", "zlgd_bill", "submit", "--set", "billstatus=A"]).ok).toBe(true);
		expect(plan(["op", "zlgd_bill", "submit", "--expect", "success=false"]).ok).toBe(true);
		expect(plan(["op", "zlgd_bill", "save"]).ok).toBe(true);
	});

	it("--set @上游.单据.字段：配了 --pk / --billno 的 run op 照常交给探针，单场景和批量都一样", () => {
		const single = plan([
			"op",
			"zlgd_bill",
			"submit",
			"--billno",
			"B-1",
			"--set",
			"@上游.zlgd_wtd.zlgd_bglx=3",
			"--set",
			"@上游.zlgd_wtd.zlgd_ysbz=",
			"--expect",
			"success=false",
		]);
		expect(single.ok).toBe(true);
		// 等号后面空着：把上游这个字段清空，和这张单自己的 --set 一样
		if (single.ok) expect(single.value.env.OP_SET).toBe("@上游.zlgd_wtd.zlgd_bglx=3;@上游.zlgd_wtd.zlgd_ysbz=");
		const batch = plan([
			"op",
			"zlgd_bill",
			"submit",
			"--case",
			"拦",
			"--pk",
			"100",
			"--set",
			"@上游.zlgd_wtd.zlgd_bglx=3",
			"--expect",
			"success=false",
			"--case",
			"放",
			"--pk",
			"100",
			"--set",
			"@上游.zlgd_wtd.zlgd_bglx=3",
			"--set",
			"@下游.zlgd_rpt.entry[0].zlgd_ysbz=GB/T 1",
			"--expect",
			"success=true",
		]);
		expect(batch.ok).toBe(true);
		if (batch.ok) {
			expect(batch.value.env.OP_CASES).toContain(
				"set=@上游.zlgd_wtd.zlgd_bglx=3;@下游.zlgd_rpt.entry[0].zlgd_ysbz=GB/T 1",
			);
			expect(batch.value.scenarios?.[1]?.argv).toContain("@下游.zlgd_rpt.entry[0].zlgd_ysbz=GB/T 1");
		}
	});

	it("--set @上游：没给单、写法不对、不是 run op，起 JVM 之前就拦", () => {
		const cases: [string[], string][] = [
			[["op", "zlgd_bill", "save", "--set", "@上游.zlgd_wtd.zlgd_bglx=3"], "要配 --pk 或 --billno"],
			[["op", "zlgd_bill", "save", "--pk", "1", "--set", "@上游.zlgd_wtd=3"], "写法不对"],
			[["op", "zlgd_bill", "save", "--pk", "1", "--set", "@源单.zlgd_wtd.a=3"], "写法不对"],
			[["form", "zlgd_bill", "--pk", "1", "--set", "@上游.zlgd_wtd.a=3", "--show", "a"], "只有 run op 读"],
			[
				["op", "zlgd_bill", "save", "--case", "甲", "--pk", "1", "--case", "乙", "--set", "@上游.zlgd_wtd.a=3"],
				"场景 乙",
			],
		];
		for (const [argv, message] of cases) {
			const result = plan(argv);
			expect(result.ok, argv.join(" ")).toBe(false);
			if (result.ok) continue;
			expect(result.error.code).toBe("RUN_ARGS_INVALID");
			expect(result.error.message).toContain(message);
			expect(result.error.remedy).toContain("@上游.<单据标识>.<字段>=值");
			expect(
				prepareRun(argv, "runtime-1")
					.blockers.map((blocker) => blocker.message)
					.join("\n"),
			).toContain(message === "场景 乙" ? "要配 --pk" : message);
		}
	});

	it("提交不给 --pk 时，@上游 上设的状态不算这张单摆好了状态", () => {
		const result = plan(["op", "zlgd_bill", "submit", "--case", "甲", "--set", "@上游.zlgd_wtd.billstatus=C"]);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.message).toContain("没设单据状态");
	});

	it("批量里只有那个没给 --pk 的提交场景被点名", () => {
		const result = plan([
			"op",
			"zlgd_bill",
			"save",
			"--case",
			"甲",
			"--set",
			"a=1",
			"--case",
			"乙",
			"--op",
			"submit",
		]);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.message).toContain("场景 乙");
	});

	it("keeps a read-only form run on the hot path", () => {
		const result = plan(["form", "zlgd_bill", "--show", "amount"]);
		expect(result.ok && result.value.cold).toBe(false);
		expect(result.ok && result.value.env.ROLLBACK).toBeUndefined();
	});

	it("keeps a form run that clicks on the hot path (S27), and forces cold only for --real-cache", () => {
		const clicked = plan(["form", "zlgd_bill", "--click", "btnsave"]);
		expect(clicked.ok && clicked.value.cold).toBe(false);
		expect(clicked.ok && clicked.value.env.ROLLBACK).toBeUndefined();
		const cached = plan(["form", "zlgd_bill", "--real-cache"]);
		// Real cache writes temporary Redis keys: its own JVM, but no business write,
		// so no rollback flag either.
		expect(cached.ok && cached.value.cold).toBe(true);
		expect(cached.ok && cached.value.env.ROLLBACK).toBeUndefined();
	});

	it("--schedule：op / form / call 认，和 --real-cache 不能一起用（冷进程跑完就退）", () => {
		expect(plan(["op", "zlgd_bill", "submit", "--pk", "1", "--schedule"]).ok).toBe(true);
		expect(plan(["form", "zlgd_bill", "--click", "bar_submit", "--schedule"]).ok).toBe(true);
		expect(plan(["list", "zlgd_bill", "--schedule"]).ok).toBe(false);
		const both = plan(["form", "zlgd_bill", "--real-cache", "--schedule"]);
		expect(!both.ok && both.error.message).toContain("--real-cache 和 --schedule");
	});

	it("requires exactly one parent action for flow", () => {
		expect(plan(["flow", "zlgd_parent"]).ok).toBe(false);
		expect(plan(["flow", "zlgd_parent", "--click", "b", "--op", "save"]).ok).toBe(false);
		expect(plan(["flow", "zlgd_parent", "--op", "save"]).ok).toBe(true);
	});

	it("子页确认动作：操作和控件各有一条通道，两个只能给一个", () => {
		// 对话框的「确定」有两种写法，而平台抛的异常里看不出是哪一种：
		// 原来只有 invokeOperation 一条路，遇上按钮控件报「btnok 操作未定义实现类！」，
		// 读起来像配置漏了，真机上为此找了十分钟旁路。
		const clicked = plan(["flow", "zlgd_parent", "--op", "save", "--child-click", "btnok"]);
		expect(clicked.ok && clicked.value.env).toMatchObject({ FLOW_CHILD_CLICK: "btnok", FLOW_CHILD_OP: "" });
		const both = plan(["flow", "zlgd_parent", "--op", "save", "--child-op", "btnok", "--child-click", "btnok"]);
		expect(both.ok).toBe(false);
		if (!both.ok) expect(both.error.message).toContain("只能给一个");
		// 默认两个都不给：由探针当场认它是操作还是控件，省掉一次 45 秒的冷启动
		const neither = plan(["flow", "zlgd_parent", "--op", "save"]);
		expect(neither.ok && neither.value.env).toMatchObject({ FLOW_CHILD_OP: "", FLOW_CHILD_CLICK: "" });
		const onCallback = plan(["callback", "p", "c", "--callback", "com.demo.P", "--child-click", "btnok"]);
		expect(onCallback.ok && onCallback.value.env).toMatchObject({ CALLBACK_CHILD_CLICK: "btnok" });
	});

	it("requires the child form and the callback class for callback", () => {
		expect(plan(["callback", "parent", "child"]).ok).toBe(false);
		const result = plan(["callback", "parent", "child", "--callback", "com.demo.P:doAction"]);
		expect(result.ok && result.value.env).toMatchObject({
			CALLBACK_CLASS: "com.demo.P",
			CALLBACK_ACTION: "doAction",
		});
	});

	it("holds run list to one primary interaction", () => {
		const result = plan(["list", "zlgd_list", "--click", "btnnew", "--row-click", "1"]);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.message).toContain("一个主交互参数");
		// S27: an interaction commits like a user's click, so it stays hot as well.
		const passive = plan(["list", "zlgd_list"]);
		expect(passive.ok && passive.value.cold).toBe(false);
		const active = plan(["list", "zlgd_list", "--click", "btnnew"]);
		expect(active.ok && active.value.cold).toBe(false);
	});

	it("run list --mobile 开移动端列表；和电脑端才有的主组织、左树一起给时执行前拒（S73）", () => {
		const mobile = plan(["list", "zlgd_list", "--mobile"]);
		expect(mobile.ok && mobile.value.env.LIST_MOBILE).toBe("1");
		const desktop = plan(["list", "zlgd_list"]);
		expect(desktop.ok && desktop.value.env.LIST_MOBILE).toBe("");
		for (const extra of [
			["--main-org", "100"],
			["--tree-node", "n1"],
		]) {
			const refused = plan(["list", "zlgd_list", "--mobile", ...extra]);
			expect(refused.ok).toBe(false);
			if (!refused.ok) expect(refused.error.message).toContain(`--mobile 不和 ${extra[0]} 一起用`);
		}
		expect(plan(["form", "zlgd_bill", "--mobile"]).ok).toBe(false);
	});

	it("bounds --limit and refuses --set/--pk/--f7 on a list", () => {
		expect(plan(["list", "zlgd_list", "--limit", "0"]).ok).toBe(false);
		expect(plan(["list", "zlgd_list", "--limit", "500"]).ok).toBe(false);
		expect(plan(["list", "zlgd_list", "--pk", "1"]).ok).toBe(false);
	});

	it("lets --op override the positional operation, as it does inside a --case segment", () => {
		// Before, the single-scenario path read only the positional: `--op audit`
		// parsed fine and `save` ran.
		const result = plan(["op", "zlgd_bill", "--op", "audit", "--pk", "100"]);
		expect(result.ok && result.value.env.OP_NAME).toBe("audit");
		expect(plan(["op", "zlgd_bill", "save", "--op", "audit", "--pk", "100"]).ok).toBe(true);
	});

	it("refuses a parameter the kind does not read, instead of dropping it", () => {
		// The parse layer accepted --show everywhere; only `form` ever put it in the
		// environment. `run op … --show amount` printed nothing and exited 0, which
		// reads exactly like "the field was printed and looked fine".
		const shown = plan(["op", "zlgd_bill", "save", "--show", "amount"]);
		expect(shown.ok).toBe(false);
		if (!shown.ok) {
			expect(shown.error.message).toContain("run op 不读 --show");
			// The parameter is usually right and the subcommand wrong: say who reads it.
			expect(shown.error.remedy).toContain("run form");
		}
		expect(plan(["form", "zlgd_bill", "--child-set", "a=1"]).ok).toBe(false);
		expect(plan(["rule", "form", "layout", "--cache", "k=v"]).ok).toBe(false);
		// And inside a later --case segment, where a dropped parameter is just as invisible.
		expect(plan(["op", "b", "save", "--case", "x", "--show", "amount"]).ok).toBe(false);
	});

	it("gives run form a --select for the entry rows the browser would have selected", () => {
		// 「当前行」（--set 的副作用）和「选中行」（getSelectRows）是两个东西，而一个
		// donothing 计算按钮第一行读的就是后者。不给 --select 时探针按 --set 写过的行模拟，
		// 所以这里只钉参数确实到得了探针，以及显式清空是合法写法。
		const explicit = plan(["form", "zlgd_bill", "--select", "entryentity=0,2"]);
		expect(explicit.ok && explicit.value.env.FORM_SELECT).toBe("entryentity=0,2");
		// `分录标识=` 是「这个分录一行没选」，正是「请先选择…」那条分支要的输入。
		const empty = plan(["form", "zlgd_bill", "--select", "entryentity="]);
		expect(empty.ok && empty.value.env.FORM_SELECT).toBe("entryentity=");
		// 不给就是空串，探针那边按 --set 写过的行自动选中。
		const none = plan(["form", "zlgd_bill", "--set", "entryentity[0].qty=2"]);
		expect(none.ok && none.value.env.FORM_SELECT).toBe("");
	});

	it("refuses a list-style --select on a form, where it would parse as a row number", () => {
		// 同名不同意思：list 的 --select 是主键，form 的是行号。混写不拦的话，探针拿
		// 那串 pk 去 parseInt，抛出来的 NumberFormatException 看不出是这里写错了。
		const pk = plan(["form", "zlgd_bill", "--select", "2454561429991212032"]);
		expect(pk.ok).toBe(false);
		if (!pk.ok) {
			expect(pk.error.code).toBe("RUN_ARGS_INVALID");
			expect(pk.error.remedy).toContain("分录标识=0,2");
		}
		expect(plan(["form", "zlgd_bill", "--select", "entryentity=第一行"]).ok).toBe(false);
	});

	it("gives run form a --status and refuses one that does not match --pk", () => {
		// 界面状态（锁不锁、显不显）按页面状态算：说了「查看」却没给单据、说了「新建」又给了单据，
		// 探针挑哪个照做，验的都不是你说的那种状态。
		const view = plan(["form", "zlgd_bill", "--pk", "100", "--status", "view"]);
		expect(view.ok && view.value.env.FORM_STATUS).toBe("view");
		const byNumber = plan(["form", "zlgd_bill", "--billno", "B-1", "--status", "edit"]);
		expect(byNumber.ok && byNumber.value.env.FORM_STATUS).toBe("edit");
		expect(plan(["form", "zlgd_bill", "--status", "new"]).ok).toBe(true);
		const none = plan(["form", "zlgd_bill"]);
		expect(none.ok && none.value.env.FORM_STATUS).toBe("");
		for (const wrong of [
			["--status", "view"],
			["--status", "edit"],
			["--pk", "100", "--status", "new"],
			["--status", "submit"],
		]) {
			const result = plan(["form", "zlgd_bill", ...wrong]);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error.code).toBe("RUN_ARGS_INVALID");
		}
		// 别的子命令不读它，照「不读的参数」拦
		expect(plan(["op", "zlgd_bill", "save", "--status", "view"]).ok).toBe(false);
	});

	it("checks the rule enums and its two kinds", () => {
		expect(plan(["rule", "other", "x"]).ok).toBe(false);
		expect(plan(["rule", "form"]).ok).toBe(false);
		expect(plan(["rule", "form", "layout", "--scene", "nope"]).ok).toBe(false);
		const result = plan(["rule", "biz", "zlgd_bill", "--host", "h"]);
		// Rule computes a layer, builds no View and opens no transaction: hot is fine.
		expect(result.ok && result.value.cold).toBe(false);
		expect(result.ok && result.value.env).toMatchObject({
			RULE_KIND: "biz",
			RULE_TARGET: "zlgd_bill",
			RULE_HOST: "h",
		});
	});
});

/**
 * 真机复盘 2026-09-11（拉伸试验隐藏面板）：rule 没有只读取值的通道，「改前看一眼面板是不是显示」
 * 只能写成 --expect，断言全过就落候选用例 —— 改后它必然失败，最后靠手工改草稿池文件清掉。
 */
describe("run rule --show：只看值，不断言、不留证据", () => {
	it("rule 读 --show，原样交给探针；form / biz 两类都读", () => {
		const form = plan([
			"rule",
			"form",
			"zlgd_wtd_xnl",
			"--set",
			"zlgd_basejylx=JYLX_0101_008",
			"--show",
			"zlgd_flexpanelap",
		]);
		expect(form.ok && form.value.env.RULE_SHOW).toBe("zlgd_flexpanelap");
		const biz = plan(["rule", "biz", "zlgd_bill", "--show", "a", "--show", "entry.b"]);
		expect(biz.ok && biz.value.env.RULE_SHOW).toBe("a;entry.b");
		// 不给就是空串，探针那边什么都不多打。
		const none = plan(["rule", "form", "layout"]);
		expect(none.ok && none.value.env.RULE_SHOW).toBe("");
	});

	it("只带 --show 的运行留不下任何证据，并说清为什么", async () => {
		const fake = runFake();
		fake.proc.handler = () => ({
			status: 0,
			stdout: '[PROBE-JSON] {"t":"rule-show","field":"zlgd_flexpanelap","found":true,"visible":true}\n[PROBE-OK]\n',
		});
		const result = await run(fake.ctx, ["rule", "form", "zlgd_wtd_xnl", "--show", "zlgd_flexpanelap"]);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(fake.proc.runsOf("java")[0]?.env.RULE_SHOW).toBe("zlgd_flexpanelap");
		// 跑通了 ≠ 验过了：没有断言就没有记录，交付时这次运行等于没发生过。
		expect(result.value.evidence.filed).toHaveLength(0);
		expect(result.value.evidence.notes.join()).toContain("--expect");
	});

	it("验证记录记下它是在哪份源码、哪个运行时上跑的", async () => {
		// finish 据此只认「这次改动之后」的运行：改前拍的基线对不上当前指纹，不算数。
		const fake = runFake();
		fake.proc.handler = () => ({ status: 0, stdout: '[PROBE-JSON] {"t":"assert","pass":true}\n' });
		const result = await run(fake.ctx, [
			"rule",
			"form",
			"zlgd_wtd_xnl",
			"--expect",
			"zlgd_flexpanelap.visible=false",
		]);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const filed = result.value.evidence.filed[0];
		expect(filed?.runtimeKeyId).toBe(fake.ctx.runtimeKeyId);
		expect(filed?.sourceFingerprint).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe("run print：打印插件的运行方式（S24 批 A）", () => {
	const TPL = "zlgd_sys_test_bill_jxzyw";

	it("不带 --set：只出预览、不开事务，走常驻进程", () => {
		const result = plan(["print", TPL, "--pk", "2560941241403458560", "--expect", "datacell9=/"]);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.probe).toBe("PrintSim");
		expect(result.value.cold).toBe(false);
		expect(result.value.env).toEqual({
			PRINT_TPL: TPL,
			PRINT_PK: "2560941241403458560",
			PRINT_SET: "",
			PRINT_EXPECT: "datacell9=/",
			PRINT_SHOW: "",
		});
	});

	it("带 --set：真提交、走常驻进程（S27）；多条断言原样按顺序交给探针", () => {
		const result = plan([
			"print",
			TPL,
			"--pk",
			"1",
			"--set",
			"zlgd_entryentity_jxsy[0].zlgd_bz_jx=",
			"--expect",
			"datacell9[0]=/",
			"--expect",
			"zlgd_bz_jx[1]~=备注",
		]);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.cold).toBe(false);
		expect(result.value.env).toMatchObject({
			PRINT_SET: "zlgd_entryentity_jxsy[0].zlgd_bz_jx=",
			PRINT_EXPECT: "datacell9[0]=/;zlgd_bz_jx[1]~=备注",
		});
		expect(result.value.env.ROLLBACK).toBeUndefined();
	});

	it("没给 --pk、--expect 和 --show 都没给：起 JVM 之前一次说全，并告诉它数据没有时用 --set", () => {
		const prepared = prepareRun(["print", TPL], "runtime-1");
		expect(prepared.plan).toBeNull();
		const text = prepared.blockers.map((blocker) => `${blocker.message} ${blocker.remedy}`).join("\n");
		expect(prepared.blockers).toHaveLength(2);
		expect(text).toContain("--pk");
		expect(text).toContain("--expect");
		expect(text).toContain("--show");
		expect(text).toContain("--set");
	});

	/**
	 * 真机 2026-09-18：run print 不读 --show，「看一眼现在打出来什么」只能写故意不过的断言，
	 * 一次次出打印（第一次 44 秒）；而且插件新插的行没有模板控件名，按格子名永远看不到。
	 * 现在 --show 可以单独给：格子、绑定字段或表格 key，只打出来看，不算验证。
	 */
	it("只给 --show 也能跑：交给探针 PRINT_SHOW，不需要写故意不过的断言", () => {
		const result = plan(["print", TPL, "--pk", "1", "--show", "layoutgrid_cnas_data", "--show", "LayoutCell72"]);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.env).toMatchObject({
			PRINT_EXPECT: "",
			PRINT_SHOW: "layoutgrid_cnas_data;LayoutCell72",
		});
		expect(result.value.cold).toBe(false);
	});

	it("格子断言写成别的形状：当场拒绝并给正确写法", () => {
		for (const bad of ["datacell9", "[0]=x", "datacell9[a]=x"]) {
			const prepared = prepareRun(["print", TPL, "--pk", "1", "--expect", bad], "runtime-1");
			expect(prepared.plan, bad).toBeNull();
			expect(prepared.blockers[0]?.remedy).toContain("格子[行号]=值");
		}
		for (const good of ["datacell9=/", "zlgd_jyxm.name[2]=显微组织", "datacell9 [1] ~= 备注", "a=b=c"]) {
			expect(plan(["print", TPL, "--pk", "1", "--expect", good]).ok, good).toBe(true);
		}
	});

	/**
	 * S26：真机 2026-09-18 断言不了插件插的行（没有模板控件名），模型为了「能断言」两次改了业务写法。
	 * 表格 key 带一个或两个下标就按表格最终输出比，形状在起 JVM 前放行，名字对不对由探针对模板核。
	 */
	it("表格断言 表格key[行] / 表格key[行][列] 放行，三个下标拒绝", () => {
		for (const good of [
			"layoutgrid_cnas_data[1]=112 | 合格 | 不合格",
			"layoutgrid_cnas_data[0][3]=检 测 结 果",
			"grid[2][1] ~= 合",
		]) {
			expect(plan(["print", TPL, "--pk", "1", "--expect", good]).ok, good).toBe(true);
		}
		const prepared = prepareRun(["print", TPL, "--pk", "1", "--expect", "grid[1][2][3]=x"], "runtime-1");
		expect(prepared.plan).toBeNull();
		expect(prepared.blockers[0]?.remedy).toContain("表格key[行][列]");
	});

	/** S26：用户手里是单据编号，run 以前只认内码，真机上为找一张单查了 10 次。 */
	it("--billno 交给探针按编号查内码：PRINT_PK 写成 billno:编号，和 --pk 只能二选一", () => {
		const result = plan(["print", TPL, "--billno", "SYSJC-20260701-0259", "--expect", "datacell9=/"]);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.env.PRINT_PK).toBe("billno:SYSJC-20260701-0259");
		const both = prepareRun(["print", TPL, "--pk", "1", "--billno", "X", "--expect", "a=b"], "runtime-1");
		expect(both.plan).toBeNull();
		expect(both.blockers.map((blocker) => blocker.message).join()).toContain("--pk 和 --billno 只能给一个");
	});

	it("--billno 在 op / form / flow 上同样认，list 不认", () => {
		const op = plan(["op", "zlgd_bill", "calvalue", "--billno", "B-1", "--expect", "success=true"]);
		expect(op.ok && op.value.env.OP_PK).toBe("billno:B-1");
		const form = plan(["form", "zlgd_bill", "--billno", "B-1", "--show", "a"]);
		expect(form.ok && form.value.env.FORM_PK).toBe("billno:B-1");
		const flow = plan(["flow", "zlgd_bill", "--billno", "B-1", "--op", "x", "--expect", "a=1"]);
		expect(flow.ok && flow.value.env.FLOW_PK).toBe("billno:B-1");
		const list = prepareRun(["list", "zlgd_bill", "--billno", "B-1"], "runtime-1");
		expect(list.blockers[0]?.message).toContain("run list 不读 --billno");
		// 提交类操作在新单上必被状态校验拦；给了编号就是已有单，不拦
		expect(plan(["op", "zlgd_bill", "submit", "--billno", "B-1", "--expect", "success=true"]).ok).toBe(true);
	});

	it("--case 里的 --billno 按场景各自带上，单独重跑的命令里也保留 --billno", () => {
		const result = plan(["op", "zlgd_bill", "submit", "--case", "甲", "--billno", "B-1", "--expect", "success=true"]);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.env.OP_CASES).toContain("pk=billno:B-1");
		expect(result.value.scenarios?.[0]?.argv).toEqual([
			"op",
			"zlgd_bill",
			"submit",
			"--billno",
			"B-1",
			"--expect",
			"success=true",
		]);
	});

	it("不读的参数照样拒绝，并说出谁读它；--case 也不支持", () => {
		const cache = prepareRun(["print", TPL, "--pk", "1", "--expect", "a=b", "--cache", "a"], "runtime-1");
		expect(cache.blockers[0]?.message).toContain("run print 不读 --cache");
		const batch = prepareRun(["print", TPL, "--pk", "1", "--expect", "a=b", "--case", "A", "--pk", "2"], "runtime-1");
		expect(batch.blockers.map((blocker) => blocker.message).join()).toContain("--case 只支持 run op");
	});

	it("模板上登记的打印插件有外部调用：照跑，提醒出打印时会真的发出去（S27）", () => {
		const fake = makeContext({ config: { codeModules: ["demo-biz"] } });
		const src = fake.ctx.layout.moduleDirs[0]?.src ?? "";
		fake.fs.put(
			`${src}/com/demo/SendPrintPlugin.java`,
			"public class SendPrintPlugin { void run(){ HttpClient.send(); } }",
		);
		fake.fs.put(
			fake.ctx.layout.impactIndex,
			JSON.stringify({
				kind: "ImpactIndex",
				at: "2026-09-17T00:00:00.000Z",
				classes: [
					{
						class: "com.demo.SendPrintPlugin",
						file: "src/main/java/com/demo/SendPrintPlugin.java",
						pluginType: "printplugin",
						bindings: [{ entity: "zlgd_bill", kind: "print", layouts: 0, enabled: true, numbers: [TPL] }],
						entities: [],
						fields: [],
						chain: [],
					},
				],
			}),
		);
		const prepared = prepareRunInvocation(fake.ctx, ["print", TPL, "--pk", "1", "--expect", "a=b"]);
		expect(prepared.blockers).toEqual([]);
		expect(prepared.warnings.join("\n")).toContain("SendPrintPlugin");
		expect(prepared.warnings.join("\n")).toContain("会真的发出去");
		// 别的模板上的打印插件不连累这张模板。
		expect(
			prepareRunInvocation(fake.ctx, ["print", "zlgd_other_tpl", "--pk", "1", "--expect", "a=b"]).warnings.join(
				"\n",
			),
		).not.toContain("SendPrintPlugin");
	});

	it("把单据标识当模板编码传进来：单据上的操作插件不算这张模板的打印插件，前检不拦", () => {
		// 真机复盘（zlgd_ygpt2.0，2026-09-17）：`run print zlgd_sys_test_bill …` 被 TestBillOpPlugin
		// 拦下，还说它是「这张模板的打印插件」。它是登记在单据上的操作插件，出打印不调操作。
		// 编码对不对交给探针当场报（模板编码查不到），不能先拿一条说错归属的拒绝挡在前面。
		const fake = makeContext({ config: { codeModules: ["demo-biz"] } });
		const src = fake.ctx.layout.moduleDirs[0]?.src ?? "";
		fake.fs.put(
			`${src}/com/demo/TestBillOpPlugin.java`,
			"public class TestBillOpPlugin { void run(){ AttachmentServiceHelper.upload(); } }",
		);
		fake.fs.put(
			fake.ctx.layout.impactIndex,
			JSON.stringify({
				kind: "ImpactIndex",
				at: "2026-09-17T00:00:00.000Z",
				classes: [
					{
						class: "com.demo.TestBillOpPlugin",
						file: "src/main/java/com/demo/TestBillOpPlugin.java",
						pluginType: "opplugin",
						bindings: [{ entity: "zlgd_sys_test_bill", kind: "entity", layouts: 0, enabled: true, numbers: [] }],
						entities: [],
						fields: [],
						chain: [],
					},
				],
			}),
		);
		const prepared = prepareRunInvocation(fake.ctx, ["print", "zlgd_sys_test_bill", "--pk", "1", "--expect", "a=b"]);
		expect(prepared.blockers).toEqual([]);
	});

	it("格子断言过了就留一条验证记录，命令原样记下", async () => {
		const fake = runFake();
		fake.proc.handler = () => ({
			status: 0,
			stdout:
				'[PROBE-JSON] {"t":"assert","kind":"print-cell","target":"datacell9[0]","expect":"/","actual":"/","pass":true}\n[PROBE-OK]\n',
		});
		const argv = ["print", TPL, "--pk", "1", "--expect", "datacell9[0]=/"];
		const result = await run(fake.ctx, argv);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(fake.proc.runsOf("java")[0]?.env.PRINT_EXPECT).toBe("datacell9[0]=/");
		const filed = result.value.evidence.filed[0];
		expect(filed?.result).toBe("PASS");
		expect(filed?.argv).toEqual(argv);
		expect(filed?.asserts[0]).toMatchObject({ kind: "print-cell", target: "datacell9[0]" });
	});
});

describe("同一场景的 FAIL 顶掉本会话的 PASS：当场说，不等 finish", () => {
	const TPL = "zlgd_sys_test_bill_jxzyw";
	const line = (pass: boolean): string =>
		`[PROBE-JSON] {"t":"assert","kind":"print-cell","target":"datacell9[0]","expect":"/","actual":"${pass ? "/" : "x"}","pass":${String(pass)}}\n[PROBE-OK]\n`;

	it("先过后不过、命令只差 --expect：第二次的返回里说清 PASS 被顶掉、怎么换回来", async () => {
		const fake = runFake();
		fake.proc.handler = () => ({ status: 0, stdout: line(true) });
		const first = await run(fake.ctx, ["print", TPL, "--pk", "1", "--expect", "datacell9[0]=/"]);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		const id = first.value.evidence.filed[0]?.id ?? "";
		fake.proc.handler = () => ({ status: 0, stdout: line(false) });
		const second = await run(fake.ctx, ["print", TPL, "--pk", "1", "--expect", "no_such=1"], {
			sessionEvidence: [{ id }],
		});
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		const text = second.value.notes.join("\n");
		expect(text).toContain(id);
		expect(text).toContain("顶掉");
		expect(text).toContain("PARTIAL");
		expect(text).toContain("已落库的操作不要为改断言而重复执行");
	});

	it("换了 --pk 就是另一个场景；上一条本来就没过也不说", async () => {
		const fake = runFake();
		fake.proc.handler = () => ({ status: 0, stdout: line(true) });
		const first = await run(fake.ctx, ["print", TPL, "--pk", "1", "--expect", "datacell9[0]=/"]);
		if (!first.ok) throw new Error("first run failed");
		const id = first.value.evidence.filed[0]?.id ?? "";
		fake.proc.handler = () => ({ status: 0, stdout: line(false) });
		const other = await run(fake.ctx, ["print", TPL, "--pk", "2", "--expect", "datacell9[0]=/"], {
			sessionEvidence: [{ id }],
		});
		if (!other.ok) throw new Error("second run failed");
		expect(other.value.notes.join("\n")).not.toContain("顶掉");
		const failedId = other.value.evidence.filed[0]?.id ?? "";
		const again = await run(fake.ctx, ["print", TPL, "--pk", "2", "--expect", "datacell9[0]=/"], {
			sessionEvidence: [{ id }, { id: failedId }],
		});
		if (!again.ok) throw new Error("third run failed");
		expect(again.value.notes.join("\n")).not.toContain("顶掉");
	});
});

describe("S5.2 --case batching", () => {
	it("splits segments and labels them", () => {
		const segments = splitRunCases(["op", "b", "save", "--pk", "1", "--case", "反例", "--pk", "2"]);
		expect(segments).toHaveLength(2);
		expect(segments[1]?.label).toBe("反例");
	});

	it("auto-numbers a segment with no label", () => {
		const result = plan(["op", "b", "save", "--expect", "success=true", "--case", "--expect", "success=false"]);
		expect(result.ok && result.value.scenarios?.map((scenario) => scenario.id)).toEqual(["场景1", "场景2"]);
	});

	it("命令头不算一个场景", () => {
		// `run op X save --case A --set … --case B --set …` 在人眼里是两个场景，
		// 切段却是三段：第一段只有位置参数。把它也算成场景，真机上就多跑一张空单
		// ——必填校验必然不过、白烧一个编码规则流水号，场景编号还整体错位一位。
		const result = plan(["op", "b", "save", "--case", "甲", "--set", "x=1", "--case", "乙", "--set", "x=2"]);
		expect(result.ok && result.value.scenarios?.map((scenario) => scenario.id)).toEqual(["甲", "乙"]);
		expect(result.ok && result.value.env.OP_CASES).not.toContain("场景1");
	});

	it("首段自己带了 --set 就仍是一个场景", () => {
		const result = plan(["op", "b", "save", "--set", "x=1", "--case", "乙", "--set", "x=2"]);
		expect(result.ok && result.value.scenarios?.map((scenario) => scenario.id)).toEqual(["场景1", "乙"]);
	});

	it("只写一个 --case 时，场景标签仍然进 OP_CASES", () => {
		// 归属键按标签分组；这里要是退回单场景旁路，草稿侧按「甲」一条也认不回来。
		const result = plan(["op", "b", "save", "--case", "甲", "--set", "x=1"]);
		expect(result.ok && result.value.scenarios?.map((scenario) => scenario.id)).toEqual(["甲"]);
		expect(result.ok && result.value.env.OP_CASES).toContain("[case] 甲");
	});

	it("refuses a duplicate label, which would merge two scenarios into one", () => {
		const result = plan(["op", "b", "save", "--case", "x", "--pk", "1", "--case", "x", "--pk", "2"]);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.message).toContain("场景标签重复");
	});

	it("refuses positional arguments in a later segment", () => {
		const result = plan(["op", "b", "save", "--case", "x", "extra"]);
		expect(result.ok).toBe(false);
	});

	const parsed = (argv: string[]): ParsedRunArgs => {
		const result = parseRunArgs(argv);
		if (!result.ok) throw result.error;
		return result.value;
	};

	it("gives every scenario an argv that reproduces it alone", () => {
		// The batch buys back cold starts during development; the case set only ever
		// takes single-scenario commands, or "reproduces independently" means nothing.
		const composed = composeOpCases({
			entity: "zlgd_bill",
			defaultOp: "save",
			segments: [
				{ label: null, parsed: parsed(["--expect", "success=true"]) },
				{ label: "反例", parsed: parsed(["--pk", "7", "--expect", "success=false"]) },
			],
		});
		expect(composed.ok).toBe(true);
		if (!composed.ok) return;
		expect(composed.value.scenarios[1]?.argv).toEqual([
			"op",
			"zlgd_bill",
			"save",
			"--pk",
			"7",
			"--expect",
			"success=false",
		]);
		expect(composed.value.blocks[1]).toContain("[case] 反例");
	});

	it("allows --case only for run op", () => {
		expect(plan(["form", "zlgd_bill", "--case", "x"]).ok).toBe(false);
	});
});

describe("必填字段预检挑得出该检查的场景", () => {
	const planned = (argv: string[]) => {
		const result = planRun(argv);
		if (!result.ok) throw new Error(result.error.message);
		return newBillScenarios(result.value);
	};

	it("form 带 --op 造新单：要检查", () => {
		const scenarios = planned(["form", "zlgd_bzwz_wl", "--op", "save", "--set", "zlgd_byzjl=1"]);
		expect(scenarios).toEqual([{ id: null, entity: "zlgd_bzwz_wl", op: "save", sets: ["zlgd_byzjl=1"] }]);
	});

	it("给了 --pk：不检查——值在那行数据上，本来就不写在 argv 里", () => {
		expect(planned(["form", "zlgd_bzwz_wl", "--op", "save", "--pk", "100"])).toEqual([]);
	});

	it("没有操作就没有校验链：不检查", () => {
		expect(planned(["form", "zlgd_bzwz_wl", "--show", "zlgd_byzjl"])).toEqual([]);
	});

	it("list 和 rule 不造单：不检查", () => {
		expect(planned(["list", "zlgd_bzwz_wl", "--op", "delete"])).toEqual([]);
		expect(planned(["rule", "biz", "zlgd_bzwz_wl"])).toEqual([]);
	});

	it("--case 批量里每个场景各算各的，用 --pk 的那个不算", () => {
		const scenarios = planned([
			"op",
			"zlgd_bzwz_wl",
			"save",
			"--set",
			"number=A01",
			"--case",
			"S2",
			"--op",
			"submit",
			"--pk",
			"100",
		]);
		expect(scenarios).toHaveLength(1);
		expect(scenarios[0]?.sets).toEqual(["number=A01"]);
	});
});

/**
 * S27 真机 2026-09-19：运行真提交后，「同一个问题问第三遍就拦」会拦错——
 * 还原一张单的备注被当成「问过三遍」挡下，可中间另一次运行已经把那格改掉了。
 */
describe("--schedule 只走常驻进程（S37 2-E.4）", () => {
	it("常驻进程用不上时不降级冷进程：冷进程跑完就退，发起的流程没人接", async () => {
		const fake = runFake();
		fake.proc.handler = () => ({ status: 0, stdout: "[PROBE-OK]\n" });
		const result = await run(fake.ctx, ["op", "zlgd_bill", "submit", "--pk", "1", "--schedule"]);
		expect(!result.ok && result.error.code).toBe("PROBE_RESIDENT_UNAVAILABLE");
		expect(fake.proc.runsOf("java")).toHaveLength(0);
	});
});

describe("会落库的运行不记「问过了」的账，并把账清掉（S27）", () => {
	const TPL = "zlgd_sys_test_bill_jxzyw";
	const SAME = '[PROBE] 出打印（预览）\n[PROBE-JSON] {"t":"assert","kind":"print-cell","pass":true}\n[PROBE-OK]\n';
	const look = ["print", TPL, "--pk", "1", "--expect", "datacell9=/"];
	const commit = ["print", TPL, "--pk", "1", "--set", "zlgd_bz=56", "--expect", "datacell9=/"];

	it("只读的打印问到第三遍照样拦，带 --set 的同一条命令跑几遍都不拦", async () => {
		const fake = runFake();
		fake.proc.handler = () => ({ status: 0, stdout: SAME });
		expect((await run(fake.ctx, look)).ok).toBe(true);
		expect((await run(fake.ctx, look)).ok).toBe(true);
		const third = await run(fake.ctx, look);
		expect(!third.ok && third.error.code).toBe("PROBE_ANSWER_SETTLED");

		for (let i = 0; i < 4; i++) expect((await run(fake.ctx, commit)).ok).toBe(true);
	});

	it("落库之后，之前只读问出的答案作废，同一条只读命令又能跑", async () => {
		const fake = runFake();
		fake.proc.handler = () => ({ status: 0, stdout: SAME });
		await run(fake.ctx, look);
		await run(fake.ctx, look);
		expect((await run(fake.ctx, commit)).ok).toBe(true);
		expect((await run(fake.ctx, look)).ok).toBe(true);
	});
});
