/**
 * S22 批 1：验证记录。
 *
 * 这一批只加不删——旧的候选池仍在写，所以这里的断言全部围绕**新**通道：一次运行留下
 * 什么、什么情况下不留、记录能不能被改。批 2 的 finish 判据、批 3 的删除各自有自己的测试。
 */

import { describe, expect, it } from "vitest";
import { run } from "../../src/kernel/commands/run.ts";
import {
	type AssertionEvidence,
	evidenceFrom,
	evidenceIntact,
	readEvidence,
	scenarioKeyOf,
	writeEvidence,
} from "../../src/kernel/verify/evidence.ts";
import { grade, worst } from "../../src/kernel/verify/grade.ts";
import { type FakeContext, makeContext } from "./fake-context.ts";

function runFake(): FakeContext {
	const fake = makeContext({
		probes: ["OpSandbox", "FormSim", "ListSim", "FormCallbackSim", "FormFlowSim", "RuleSim"],
	});
	for (const name of ["OpSandbox", "FormSim", "ListSim", "FormCallbackSim", "FormFlowSim", "RuleSim"]) {
		fake.fs.put(`${fake.ctx.layout.probesDir.replace(/\\/g, "/")}/${name}.java`, `public class ${name} {}`);
	}
	return fake;
}

const PASS_LINE =
	'[PROBE-JSON] {"t":"assert","pass":true,"kind":"field","target":"amount","expect":"1","actual":"1"}\n';
const FAIL_LINE =
	'[PROBE-JSON] {"t":"assert","pass":false,"kind":"field","target":"amount","expect":"1","actual":"9"}\n';

describe("S22.1.1 断言判定原样搬家", () => {
	it("判过/不过/没断言/出错四种结论和搬家前一致", () => {
		const pass = [{ t: "assert", pass: true }];
		const fail = [
			{ t: "assert", pass: true },
			{ t: "assert", pass: false },
		];
		expect(grade("-", pass, 0, { attributeAll: true }).result).toBe("PASS");
		expect(grade("-", fail, 0, { attributeAll: true }).result).toBe("FAIL");
		// 跑通了但一条断言都没有：这是整个门禁的落点，不能变成 PASS。
		expect(grade("-", [], 0, { attributeAll: true }).result).toBe("EXECUTED");
		expect(grade("-", [], 1, { attributeAll: true }).result).toBe("ERROR");
		// 退出码不能盖掉断言：记录说没过就是没过。
		expect(grade("-", fail, 0, { attributeAll: true }).result).toBe("FAIL");
	});

	it("worst 仍然是「一条红全红」", () => {
		expect(worst(["PASS", "PASS"])).toBe("PASS");
		expect(worst(["PASS", "EXECUTED"])).toBe("EXECUTED");
		expect(worst(["PASS", "FAIL"])).toBe("FAIL");
		expect(worst(["FAIL", "ERROR"])).toBe("ERROR");
	});

	it("按场景号归属时不会把别人的断言算进来", () => {
		const records = [
			{ t: "assert", case: "甲", pass: true },
			{ t: "assert", case: "乙", pass: false },
		];
		expect(grade("甲", records, 0).result).toBe("PASS");
		expect(grade("乙", records, 0).result).toBe("FAIL");
	});
});

describe("S22.1.2 场景键", () => {
	it("去掉 --expect / --show，留下的是「同一件事」", () => {
		expect(scenarioKeyOf(["form", "zlgd_bill", "--set", "a=1", "--expect", "b=2"])).toBe("form zlgd_bill --set a=1");
		expect(scenarioKeyOf(["form", "zlgd_bill", "--show", "x", "--expect", "b=2"])).toBe("form zlgd_bill");
	});

	it("改了期望值再跑一次，仍算同一个场景", () => {
		// D19.1 的前提：先写错期望值、改对再跑是正常纠错。期望值若进了场景身份，
		// 那次纠错就会变成「另一个场景」，原来那条失败永远挂在那里。
		const first = scenarioKeyOf(["form", "zlgd_bill", "--set", "a=1", "--expect", "b=2"]);
		const second = scenarioKeyOf(["form", "zlgd_bill", "--set", "a=1", "--expect", "b=3"]);
		expect(first).toBe(second);
	});

	it("换了 --set 就是另一个场景", () => {
		expect(scenarioKeyOf(["form", "zlgd_bill", "--set", "a=1"])).not.toBe(
			scenarioKeyOf(["form", "zlgd_bill", "--set", "a=2"]),
		);
	});
});

describe("S22.1.2 一次运行留下的验证记录", () => {
	const base = {
		at: "2026-09-16T00:00:00.000Z",
		runtimeKeyId: "runtime-1",
		sourceFingerprint: "f".repeat(64),
		gates: { class_fresh: "block" },
		path: "cold" as const,
		warnings: [],
		log: "D:/cache/last-probe.out",
	};

	it("记录带齐判定需要的全部事实", () => {
		const built = evidenceFrom({
			...base,
			argv: ["form", "zlgd_bill", "--set", "a=1", "--expect", "amount=1"],
			records: [{ t: "assert", pass: true, kind: "field", target: "amount", expect: "1", actual: "1" }],
			exitCode: 0,
		});
		const evidence = built.evidence;
		expect(evidence).not.toBeNull();
		if (evidence === null) return;
		expect(evidence.id).toMatch(/^AE-[0-9a-f]{12}$/);
		expect(evidence.digest).toMatch(/^[0-9a-f]{64}$/);
		expect(evidence.result).toBe("PASS");
		expect(evidence.runtimeKeyId).toBe("runtime-1");
		expect(evidence.sourceFingerprint).toBe("f".repeat(64));
		expect(evidence.gates.class_fresh).toBe("block");
		expect(evidence.argv).toEqual(["form", "zlgd_bill", "--set", "a=1", "--expect", "amount=1"]);
		expect(evidence.scenarioKey).toBe("form zlgd_bill --set a=1");
		expect(evidence.asserts).toEqual([
			{ kind: "field", target: "amount", expect: "1", actual: "1", pass: true, why: null },
		]);
		expect(evidence.path).toBe("cold");
		expect(evidence.log).toBe("D:/cache/last-probe.out");
		expect(evidence.usesPk).toBe(false);
	});

	it("没过、出错都要记；只有「跑通了但没断言」不记", () => {
		const failed = evidenceFrom({
			...base,
			argv: ["form", "zlgd_bill", "--expect", "amount=1"],
			records: [{ t: "assert", pass: false }],
			exitCode: 0,
		});
		expect(failed.evidence?.result).toBe("FAIL");

		const errored = evidenceFrom({ ...base, argv: ["form", "zlgd_bill"], records: [], exitCode: 1 });
		expect(errored.evidence?.result).toBe("ERROR");

		const executed = evidenceFrom({ ...base, argv: ["form", "zlgd_bill"], records: [], exitCode: 0 });
		expect(executed.evidence).toBeNull();
		expect(executed.why).toContain("不算验证");
		expect(executed.why).toContain("跑通了不等于验过了");
	});

	it("探针说输入不成立（目标、--pk、--set 写错）：不留记录，并说清改输入", () => {
		// 2026-09-17 真机复验：把单据标识当模板编码跑了一次，留下一条 FAIL。模板编码在场景键里，
		// 改对之后是另一个场景，那条 FAIL 在会话里永远换不掉，交付一直被一个错字挡着。
		const invalid = evidenceFrom({
			...base,
			argv: ["print", "zlgd_bill", "--pk", "1", "--expect", "datacell9=/"],
			records: [{ t: "input-invalid", kind: "print-template", target: "zlgd_bill", why: "模板编码查不到" }],
			exitCode: 1,
		});
		expect(invalid.evidence).toBeNull();
		expect(invalid.why).toContain("输入不成立");
		expect(invalid.why).toContain("print-template zlgd_bill");
		expect(invalid.why).not.toContain("模板编码查不到");

		// 批量里只管自己那个场景：别的场景输入写错，不连累这个场景留记录。
		const batch = evidenceFrom({
			...base,
			argv: ["op", "zlgd_bill", "save", "--pk", "1", "--expect", "success=true"],
			records: [
				{ t: "input-invalid", case: "乙", kind: "op-pk", target: "pk=2", why: "查不到" },
				{ t: "assert", case: "甲", pass: true, kind: "op-success", target: "success" },
			],
			exitCode: 1,
			scenarioId: "甲",
			attributeAll: false,
		});
		expect(batch.evidence?.result).toBe("PASS");
	});

	it("探针说这次有一步没跑完：断言全过也不留记录；有断言挂了照样记 FAIL", () => {
		// 2026-10-10 真机：销售订单打开时原厂插件抛 ClassCastException，排在它后面的插件 loadData 全没跑，
		// 探针接着点超链接，8 条断言全过，原来记成 PASS。
		const incomplete = {
			t: "run-incomplete",
			step: "loadData",
			plugin: "kd.scmc.sm.formplugin.tpl.BillTplPlugin",
			why: "ClassCastException。它不是要验的插件就摘掉重跑：--skip BillTplPlugin",
		};
		const argv = [
			"form",
			"sm_salorder",
			"--pk",
			"1",
			"--hyperlink",
			"billentry[0].zlgd_dqnbhth",
			"--expect",
			"opened=x",
		];
		const passed = evidenceFrom({
			...base,
			argv,
			records: [incomplete, { t: "assert", pass: true, kind: "form-opened", target: "opened" }],
			exitCode: 0,
		});
		expect(passed.evidence).toBeNull();
		expect(passed.why).toContain("没跑完整");
		expect(passed.why).toContain("loadData");
		expect(passed.why).toContain("--skip BillTplPlugin");

		const failed = evidenceFrom({
			...base,
			argv,
			records: [incomplete, { t: "assert", pass: false, kind: "form-opened", target: "opened" }],
			exitCode: 1,
		});
		expect(failed.evidence?.result).toBe("FAIL");

		// 批量里只管自己那个场景
		const batch = evidenceFrom({
			...base,
			argv,
			records: [
				{ ...incomplete, case: "乙" },
				{ t: "assert", case: "甲", pass: true, kind: "form-opened", target: "opened" },
			],
			exitCode: 0,
			scenarioId: "甲",
			attributeAll: false,
		});
		expect(batch.evidence?.result).toBe("PASS");
	});

	it("用了 --pk 的记下来，回执要注明它钉在共享数据上", () => {
		const built = evidenceFrom({
			...base,
			argv: ["form", "zlgd_bill", "--pk", "42", "--expect", "amount=1"],
			records: [{ t: "assert", pass: true }],
			exitCode: 0,
		});
		expect(built.evidence?.usesPk).toBe(true);
	});

	it("降档跑出来的记录，自己写着降过档", () => {
		const built = evidenceFrom({
			...base,
			gates: { class_fresh: "warn" },
			argv: ["form", "zlgd_bill", "--expect", "amount=1"],
			records: [{ t: "assert", pass: true }],
			exitCode: 0,
		});
		expect(built.evidence?.gates.class_fresh).toBe("warn");
	});

	it("运行时的预检警告原样带进记录", () => {
		const built = evidenceFrom({
			...base,
			warnings: ["插件不在该表单的插件列表里"],
			argv: ["form", "zlgd_bill", "--expect", "amount=1"],
			records: [{ t: "assert", pass: true }],
			exitCode: 0,
		});
		expect(built.evidence?.warnings).toEqual(["插件不在该表单的插件列表里"]);
	});

	it("同样的事实算出同一个编号，不同的事实算出不同的编号", () => {
		const one = evidenceFrom({
			...base,
			argv: ["form", "x", "--expect", "a=1"],
			records: [{ t: "assert", pass: true }],
			exitCode: 0,
		});
		const same = evidenceFrom({
			...base,
			argv: ["form", "x", "--expect", "a=1"],
			records: [{ t: "assert", pass: true }],
			exitCode: 0,
		});
		const other = evidenceFrom({
			...base,
			sourceFingerprint: "a".repeat(64),
			argv: ["form", "x", "--expect", "a=1"],
			records: [{ t: "assert", pass: true }],
			exitCode: 0,
		});
		expect(one.evidence?.id).toBe(same.evidence?.id);
		expect(one.evidence?.id).not.toBe(other.evidence?.id);
	});
});

describe("S22.1.2 记录改不得", () => {
	const fake = () => makeContext();

	function filed(ctx: FakeContext): AssertionEvidence {
		const built = evidenceFrom({
			argv: ["form", "zlgd_bill", "--expect", "amount=1"],
			records: [{ t: "assert", pass: false, kind: "field", target: "amount" }],
			exitCode: 0,
			at: "2026-09-16T00:00:00.000Z",
			runtimeKeyId: ctx.ctx.runtimeKeyId,
			sourceFingerprint: "f".repeat(64),
			gates: { class_fresh: "block" },
			path: "hot",
			warnings: [],
			log: "D:/cache/last-probe.out",
		});
		if (built.evidence === null) throw new Error("expected a record");
		writeEvidence(ctx.ctx, built.evidence);
		return built.evidence;
	}

	it("落盘之后能按编号读回来", () => {
		const ctx = fake();
		const evidence = filed(ctx);
		const back = readEvidence(ctx.ctx, evidence.id);
		expect(back?.id).toBe(evidence.id);
		expect(back?.result).toBe("FAIL");
	});

	it("把文件里的 FAIL 改成 PASS，读回来就不认了", () => {
		// §3.2 最要紧的一行：模型拿 write 工具改证据。摘要对不上，这条记录直接不存在。
		const ctx = fake();
		const evidence = filed(ctx);
		const file = `${ctx.ctx.layout.assertionEvidence}/${evidence.id}.json`.replace(/\\/g, "/");
		const forged = { ...JSON.parse(ctx.fs.read(file)), result: "PASS" };
		ctx.fs.put(file, JSON.stringify(forged));
		expect(readEvidence(ctx.ctx, evidence.id)).toBeNull();
		expect(evidenceIntact(forged as AssertionEvidence)).toBe(false);
	});

	it("连摘要一起改也没用——摘要是从事实算出来的", () => {
		const ctx = fake();
		const evidence = filed(ctx);
		const file = `${ctx.ctx.layout.assertionEvidence}/${evidence.id}.json`.replace(/\\/g, "/");
		const forged = { ...JSON.parse(ctx.fs.read(file)), result: "PASS", digest: "0".repeat(64) };
		ctx.fs.put(file, JSON.stringify(forged));
		expect(readEvidence(ctx.ctx, evidence.id)).toBeNull();
	});

	it("文件不在、读不出来、不是记录，一律当没有", () => {
		const ctx = fake();
		expect(readEvidence(ctx.ctx, "AE-000000000000")).toBeNull();
		ctx.fs.put(`${ctx.ctx.layout.assertionEvidence}/AE-111111111111.json`.replace(/\\/g, "/"), "{ 不是 JSON");
		expect(readEvidence(ctx.ctx, "AE-111111111111")).toBeNull();
	});
});

describe("S22.1.2 run 把记录接上", () => {
	it("带 --expect 跑过就落一条记录，并在输出里说一句", async () => {
		const fake = runFake();
		fake.proc.handler = () => ({ status: 0, stdout: PASS_LINE });
		const result = await run(fake.ctx, ["form", "zlgd_bill", "--expect", "amount=1"]);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.evidence.filed).toHaveLength(1);
		const evidence = result.value.evidence.filed[0];
		expect(evidence?.result).toBe("PASS");
		expect(evidence?.sourceFingerprint).toMatch(/^[0-9a-f]{64}$/);
		expect(evidence?.runtimeKeyId).toBe(fake.ctx.runtimeKeyId);
		expect(fake.fs.exists(`${fake.ctx.layout.assertionEvidence}/${evidence?.id}.json`.replace(/\\/g, "/"))).toBe(
			true,
		);
		expect(result.value.notes.join()).toContain("验证记录");
	});

	it("断言没过也落记录——不然「换一条能过的」就绕过去了", async () => {
		const fake = runFake();
		fake.proc.handler = () => ({ status: 0, stdout: FAIL_LINE });
		const result = await run(fake.ctx, ["form", "zlgd_bill", "--expect", "amount=1"]);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.evidence.filed[0]?.result).toBe("FAIL");
	});

	it("没带 --expect 的一条都不落，并说清这次不算验证", async () => {
		const fake = runFake();
		fake.proc.handler = () => ({ status: 0, stdout: "[PROBE] 跑过了\n" });
		const result = await run(fake.ctx, ["form", "zlgd_bill"]);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.evidence.filed).toHaveLength(0);
		expect(result.value.evidence.notes.join()).toContain("不算验证");
	});

	it("同一条命令跑两遍，两次都各留一条记录", async () => {
		// 记录不是资产，是「这份代码刚跑过」这个事实，所以它没有去重一说：
		// 交付判据要的正是「同一场景最后一次是不是过的」，那就必须每次都留下。
		const fake = runFake();
		fake.proc.handler = () => ({ status: 0, stdout: PASS_LINE });
		const first = await run(fake.ctx, ["form", "zlgd_bill", "--expect", "amount=1"]);
		const again = await run(fake.ctx, ["form", "zlgd_bill", "--expect", "amount=1"]);
		expect(first.ok && again.ok).toBe(true);
		if (!first.ok || !again.ok) return;
		expect(first.value.evidence.filed).toHaveLength(1);
		expect(again.value.evidence.filed).toHaveLength(1);
	});

	it("--case 批量运行，每个场景各一条", async () => {
		const fake = runFake();
		fake.proc.handler = () => ({
			status: 0,
			stdout:
				'[PROBE-JSON] {"t":"assert","case":"甲","pass":true,"kind":"field","target":"a"}\n' +
				'[PROBE-JSON] {"t":"assert","case":"乙","pass":false,"kind":"field","target":"b"}\n',
		});
		const result = await run(fake.ctx, [
			"op",
			"zlgd_bill",
			"save",
			"--case",
			"甲",
			"--set",
			"a=1",
			"--expect",
			"a=1",
			"--case",
			"乙",
			"--set",
			"b=2",
			"--expect",
			"b=2",
		]);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const byScenario = new Map(result.value.evidence.filed.map((entry) => [entry.scenarioId, entry.result]));
		expect(byScenario.get("甲")).toBe("PASS");
		expect(byScenario.get("乙")).toBe("FAIL");
	});
});
