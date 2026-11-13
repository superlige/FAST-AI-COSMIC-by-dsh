/**
 * run wf：按已发布流程定义拼出上下文，直调一个工作流插件的方法，断言返回值和插件跑完后的单据（S41）。
 *
 * 工作流插件原来没有自动验证方法，交付只能交用户验收。这里测起 JVM 之前内核能判的那一半
 * （目标是插件类、给了单据、有断言、--ctx 形状对）、按源码认好全类名交给探针、结果进验证记录；
 * 真机上的调用见 `scripts/verify-wf-plugin.ts`。
 */

import { describe, expect, it } from "vitest";
import { planRun, prepareRun, prepareRunInvocation, run } from "../../src/kernel/commands/run.ts";
import { runCommits } from "../../src/knowledge/run-adapter.ts";
import { type FakeContext, makeContext } from "./fake-context.ts";

function project(): FakeContext {
	const fake = makeContext({ config: { codeModules: ["demo-biz"] }, probes: ["WfSim"] });
	const dirs = fake.ctx.layout.moduleDirs[0];
	fake.fs.put(
		`${dirs?.src}/zlgd/wf/ReplyWf.java`,
		"package zlgd.wf;\npublic class ReplyWf implements IWorkflowPlugin {\n  public void notify(AgentExecution e) {}\n}\n",
		1,
	);
	fake.fs.put(`${dirs?.out}/zlgd/wf/ReplyWf.class`, "class", 2);
	fake.fs.put(`${fake.ctx.layout.probesDir.replace(/\\/g, "/")}/WfSim.java`, "public class WfSim {}");
	return fake;
}

describe("run wf 的参数形状：起 JVM 之前就判", () => {
	it("方法、单据、单据标识、节点、上下文、断言、只看的字段原样交给探针；--billno 写成 billno:编号；走常驻进程", () => {
		const planned = planRun([
			"wf",
			"ReplyWf#notify",
			"zlgd_plan",
			"--billno",
			"PLAN-0001",
			"--node",
			"分管领导审批",
			"--ctx",
			"message=数据不全",
			"--ctx",
			"approvers=10001,10002",
			"--expect",
			"zlgd_reply=数据不全",
			"--show",
			"zlgd_entry.zlgd_reason,billno",
		]);
		expect(planned.ok).toBe(true);
		if (!planned.ok) return;
		expect(planned.value.probe).toBe("WfSim");
		expect(planned.value.cold).toBe(false);
		expect(planned.value.env).toEqual({
			WF_METHOD: "notify",
			WF_PK: "billno:PLAN-0001",
			WF_ENTITY: "zlgd_plan",
			WF_NODE: "分管领导审批",
			WF_CTX: "message=数据不全;approvers=10001,10002",
			WF_SET: "",
			WF_EXPECT: "zlgd_reply=数据不全",
			WF_SHOW: "zlgd_entry.zlgd_reason;billno",
		});
	});

	it("方法不是工作流插件方法、位置参数多了、没给单据、没有断言也没有 --show、--ctx 写错：一次说全", () => {
		const prepared = prepareRun(
			["wf", "ReplyWf#doIt", "zlgd_plan", "extra", "--ctx", "who=me", "--ctx", "vote=1001:maybe"],
			"runtime-1",
		);
		expect(prepared.plan).toBeNull();
		const text = prepared.blockers.map((blocker) => blocker.message).join("\n");
		expect(prepared.blockers).toHaveLength(6);
		expect(text).toContain("要指定方法时写 类名#方法，收到 ReplyWf#doIt");
		expect(text).toContain("多出了：extra");
		expect(text).toContain("--pk <单据内码> 或 --billno <单据编号>");
		expect(text).toContain("--expect <字段>=<值>");
		expect(text).toContain("--ctx 写法不对：who=me");
		expect(text).toContain("--ctx 写法不对：vote=1001:maybe");
	});

	it("插件参数、流程变量、会审投票这几种 --ctx 写法都认", () => {
		const prepared = prepareRun(
			[
				"wf",
				"ReplyWf",
				"--pk",
				"1",
				"--ctx",
				"param.roleNumbers=A,B",
				"--ctx",
				"var.processType=AuditFlow",
				"--ctx",
				"vote=1001:reject:RejectToEdit",
				"--ctx",
				"pending=2",
				"--expect",
				"result.pass=false",
			],
			"runtime-1",
		);
		expect(prepared.blockers).toEqual([]);
	});

	it("插件保存单据是真提交，回执要说落了库", () => {
		expect(runCommits(["wf", "ReplyWf", "--pk", "1", "--expect", "a=1"])).toBe(true);
	});
});

describe("run wf 读源码的前检", () => {
	it("简单类名按源码认成全类名交给探针", () => {
		const fake = project();
		const prepared = prepareRunInvocation(fake.ctx, ["wf", "ReplyWf", "--pk", "1", "--expect", "a=1"]);
		expect(prepared.blockers).toEqual([]);
		expect(prepared.plan?.env.WF_CLASS).toBe("zlgd.wf.ReplyWf");
	});

	it("本工程里没有这个类：不起 JVM，给相近的名字", () => {
		const fake = project();
		const prepared = prepareRunInvocation(fake.ctx, ["wf", "ReplyWff", "--pk", "1", "--expect", "a=1"]);
		expect(prepared.plan).toBeNull();
		expect(prepared.blockers[0]?.message).toContain("本工程源码里没有类 ReplyWff");
	});
});

describe("run wf 的结果进验证记录", () => {
	it("断言全过留一条 PASS，命令原样记下", async () => {
		const fake = project();
		fake.proc.handler = () => ({
			status: 0,
			stdout:
				'[PROBE-JSON] {"t":"assert","kind":"field","target":"zlgd_reply","expect":"x","actual":"x","pass":true}\n[PROBE-OK]\n',
		});
		const argv = ["wf", "ReplyWf", "--pk", "100001", "--ctx", "message=x", "--expect", "zlgd_reply=x"];
		const result = await run(fake.ctx, argv);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const java = fake.proc.runsOf("java")[0];
		expect(java?.env.WF_CLASS).toBe("zlgd.wf.ReplyWf");
		expect(java?.env.WF_CTX).toBe("message=x");
		expect(result.value.evidence.filed[0]).toMatchObject({ result: "PASS", argv });
	});

	it("探针说节点对不上：不留记录，改对再跑", async () => {
		const fake = project();
		fake.proc.handler = (spec) => ({
			status: spec.command === "java" ? 1 : 0,
			stdout:
				'[PROBE-JSON] {"t":"input-invalid","kind":"wf-node","target":"不存在","why":"它挂在 [分管领导审批（AuditTask5）]"}\n',
		});
		const result = await run(fake.ctx, ["wf", "ReplyWf", "--pk", "1", "--node", "不存在", "--expect", "a=1"]);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.evidence.filed).toEqual([]);
		expect(result.value.evidence.notes.join()).toContain("输入不成立");
	});
});
