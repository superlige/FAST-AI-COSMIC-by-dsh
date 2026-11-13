/**
 * run push：按一条 BOTP 转换规则下推一张源单，目标单保存后从数据库回读，断言目标单（S40）。
 *
 * 转换插件原来没有能留验证记录的运行方式，交付只能交用户验收。这里测起 JVM 之前内核能判的那一半
 * （目标是规则 id、给了源单、有断言），以及结果进验证记录、本工程包前缀交给探针；真机上的下推见
 * `scripts/verify-botp-push.ts`。
 */

import { describe, expect, it } from "vitest";
import { planRun, prepareRun, run } from "../../src/kernel/commands/run.ts";
import { runCommits } from "../../src/knowledge/run-adapter.ts";
import { type FakeContext, makeContext } from "./fake-context.ts";

const RULE = "2424161753291052032";

function project(): FakeContext {
	const fake = makeContext({ config: { codeModules: ["demo-biz"] }, probes: ["PushSim"] });
	const dirs = fake.ctx.layout.moduleDirs[0];
	fake.fs.put(`${dirs?.src}/zlgd/botp/ToOrder.java`, "package zlgd.botp;\npublic class ToOrder {}\n", 1);
	fake.fs.put(`${dirs?.out}/zlgd/botp/ToOrder.class`, "class", 2);
	fake.fs.put(`${fake.ctx.layout.probesDir.replace(/\\/g, "/")}/PushSim.java`, "public class PushSim {}");
	// 本工程的包前缀从代码关系表里的类名取
	fake.fs.put(
		fake.ctx.layout.impactIndex,
		JSON.stringify({ kind: "ImpactIndex", classes: [{ class: "zlgd.botp.ToOrder", bindings: [] }] }),
	);
	return fake;
}

describe("run push 的参数形状：起 JVM 之前就判", () => {
	it("规则 id、源单、断言、只看的字段原样交给探针；--billno 写成 billno:编号；走常驻进程", () => {
		const planned = planRun([
			"push",
			RULE,
			"--billno",
			"SFLF-0001",
			"--expect",
			"zlgd_supply=A",
			"--expect",
			"bills=1",
			"--show",
			"zlgd_supply,entryentity[0].qty",
			"--show",
			"billno",
		]);
		expect(planned.ok).toBe(true);
		if (!planned.ok) return;
		expect(planned.value.probe).toBe("PushSim");
		expect(planned.value.cold).toBe(false);
		expect(planned.value.env).toEqual({
			PUSH_RULE: RULE,
			PUSH_PK: "billno:SFLF-0001",
			PUSH_EXPECT: "zlgd_supply=A;bills=1",
			PUSH_SHOW: "zlgd_supply;entryentity[0].qty;billno",
		});
	});

	it("目标不是规则 id、多出位置参数、没给源单、没有断言也没有 --show：一次说全", () => {
		const prepared = prepareRun(["push", "zlgd_bill", "zlgd_target"], "runtime-1");
		expect(prepared.plan).toBeNull();
		const text = prepared.blockers.map((blocker) => blocker.message).join("\n");
		expect(prepared.blockers).toHaveLength(4);
		expect(text).toContain("转换规则 id（一串数字），收到 zlgd_bill");
		expect(text).toContain("多出了：zlgd_target");
		expect(text).toContain("--pk <源单内码> 或 --billno <源单编号>");
		expect(text).toContain("--expect <目标单字段>=<值>");
	});

	it("push 不读 --set：目标单不是拿来改的", () => {
		const prepared = prepareRun(["push", RULE, "--pk", "1", "--set", "a=1", "--expect", "a=1"], "runtime-1");
		expect(prepared.blockers.map((blocker) => blocker.message).join("\n")).toContain("run push 不读 --set");
	});

	it("目标单必须保存，回执按实际日志报写库", () => {
		expect(runCommits(["push", RULE, "--pk", "1", "--expect", "bills=1"])).toBe(true);
	});
});

describe("run push 的结果进验证记录", () => {
	it("断言全过留一条 PASS，命令原样记下；本工程包前缀交给探针，用来标出规则上哪些插件是本工程的", async () => {
		const fake = project();
		fake.proc.handler = () => ({
			status: 0,
			stdout:
				'[PROBE-JSON] {"t":"push-readback","rule":"2424161753291052032","entity":"zlgd_target","ids":["2"],"plugins":["zlgd.botp.ToOrder"]}\n[PROBE-JSON] {"t":"assert","kind":"field","target":"zlgd_supply","expect":"A","actual":"A","pass":true}\n[PROBE-OK]\n',
		});
		const argv = ["push", RULE, "--pk", "100001", "--expect", "zlgd_supply=A"];
		const result = await run(fake.ctx, argv);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const java = fake.proc.runsOf("java")[0];
		expect(java?.env.PUSH_RULE).toBe(RULE);
		expect(java?.env.OP_PKGS).toContain("zlgd");
		expect(result.value.evidence.filed[0]).toMatchObject({ result: "PASS", argv });
	});

	it("探针说规则查不到：不留记录，改对再跑", async () => {
		const fake = project();
		fake.proc.handler = (spec) => ({
			status: spec.command === "java" ? 1 : 0,
			stdout:
				'[PROBE-JSON] {"t":"input-invalid","kind":"push-rule","target":"1000000","why":"查不到这条转换规则"}\n',
		});
		const result = await run(fake.ctx, ["push", "1000000", "--pk", "1", "--expect", "success=true"]);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.evidence.filed).toEqual([]);
		expect(result.value.evidence.notes.join()).toContain("输入不成立");
	});
});
