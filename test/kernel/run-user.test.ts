/**
 * run --user：整次运行换成某个用户的身份（S78）。
 *
 * 权限、数据范围、「只有管理员能启用」这类需求要以不同的人跑同一个动作才验得了；原来 cosmic_run 只能用配置里的用户，
 * 真机会话只好退回只读探针、不留验证记录。这里测参数怎么认、身份怎么换成 id、认不准时拦下，以及验证记录照原样记下 --user。
 */

import { describe, expect, it } from "vitest";
import { planRun, prepareRun, run } from "../../src/kernel/commands/run.ts";
import { RUN_ADAPTER_CONTRACTS, RUN_KINDS } from "../../src/knowledge/run-adapter.ts";
import { type FakeContext, makeContext } from "./fake-context.ts";

const json = (record: Record<string, unknown>): string => `[PROBE-JSON] ${JSON.stringify(record)}`;

const USERS = [
	// 用户名（登录账号）和工号不一定相同：emp_a 是用户名，工号另有一套
	json({ t: "user", id: "2001", number: "ID-000006", username: "emp_a", name: "员工甲", phone_mask: "" }),
	json({ t: "user", id: "2002", number: "ID-000007", username: "emp_ab", name: "员工乙", phone_mask: "" }),
	json({ t: "user-lookup", key: "emp_a", count: 2, truncated: false }),
].join("\n");

const PASS = `${json({ t: "assert", kind: "field", target: "success", expect: "true", actual: "true", pass: true })}\n[PROBE-OK]\n`;

function project(users = USERS): FakeContext {
	const fake = makeContext({ probes: ["OpSandbox", "FormSim", "UserProbe"] });
	for (const name of ["OpSandbox", "FormSim", "UserProbe"]) {
		fake.fs.put(`${fake.ctx.layout.probesDir.replace(/\\/g, "/")}/${name}.java`, `public class ${name} {}`);
	}
	fake.proc.handler = (spec) =>
		spec.command === "java" && spec.env.USER_KEY !== undefined
			? { status: 0, stdout: `${users}\n` }
			: { status: 0, stdout: PASS };
	return fake;
}

describe("run --user 的参数", () => {
	it("十个子命令都认 --user", () => {
		for (const kind of RUN_KINDS) expect(RUN_ADAPTER_CONTRACTS[kind].accepted).toContain("user");
	});

	it("计划里带上要换的身份；--case 批量里每个场景单独重跑的命令也带上", () => {
		const one = planRun(["op", "demo_room", "save", "--set", "demo_cap=0", "--user", "emp_a"]);
		expect(one.ok && one.value.user).toBe("emp_a");
		const batch = planRun([
			"op",
			"demo_room",
			"--user",
			"emp_a",
			"--case",
			"A",
			"--set",
			"demo_cap=0",
			"--case",
			"B",
			"--set",
			"demo_cap=1",
		]);
		expect(batch.ok && batch.value.scenarios?.map((one) => one.argv.slice(-2))).toEqual([
			["--user", "emp_a"],
			["--user", "emp_a"],
		]);
	});

	it("写在 --case 段里的 --user 拦下：一次运行只进一个身份", () => {
		const prepared = prepareRun(
			[
				"op",
				"demo_room",
				"--case",
				"A",
				"--set",
				"demo_cap=0",
				"--user",
				"emp_a",
				"--case",
				"B",
				"--set",
				"demo_cap=1",
			],
			"runtime-1",
		);
		expect(prepared.plan).toBeNull();
		expect(prepared.blockers.map((blocker) => blocker.message).join("\n")).toContain("一次运行只用一个身份");
	});

	it("空值照别的参数一样拦下", () => {
		const prepared = prepareRun(["op", "demo_room", "save", "--user", " "], "runtime-1");
		expect(prepared.blockers.map((blocker) => blocker.message).join("\n")).toContain("--user 的值是空的");
	});
});

describe("run --user 换身份", () => {
	it("按用户名（不是工号）完全相同认出唯一的人，探针拿到他的 id；回执和验证记录照原样记下 --user", async () => {
		const fake = project();
		const argv = ["op", "demo_room", "save", "--set", "demo_cap=0", "--expect", "success=true", "--user", "emp_a"];
		const result = await run(fake.ctx, argv);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const javas = fake.proc.runsOf("java");
		const lookup = javas.find((one) => one.env.USER_KEY !== undefined);
		const op = javas.find((one) => one.env.OP_ENTITY === "demo_room");
		expect(lookup?.env.USER_KEY).toBe("emp_a");
		// 「emp_ab」也模糊命中了，但只按完全相同认
		expect(op?.env.COSMIC_USER).toBe("2001");
		expect(result.value.notes[0]).toBe("以 员工甲（用户名 emp_a，id 2001）的身份跑");
		expect(result.value.evidence.filed[0]).toMatchObject({ result: "PASS", argv });
	});

	it("对不上的人不跑：列出查到的人，不挑一个看着像的", async () => {
		const fake = project();
		const result = await run(fake.ctx, ["op", "demo_room", "save", "--expect", "success=true", "--user", "emp"]);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.message).toContain("没有对得上的启用用户");
		expect(result.error.remedy).toContain("员工甲（用户名 emp_a，id 2001）");
		expect(fake.proc.runsOf("java").some((one) => one.env.OP_ENTITY === "demo_room")).toBe(false);
	});

	it("同名的两个人认不出是哪一个", async () => {
		const fake = project(
			[
				json({ t: "user", id: "3001", number: "zs1", name: "张三", phone_mask: "" }),
				json({ t: "user", id: "3002", number: "zs2", name: "张三", phone_mask: "" }),
			].join("\n"),
		);
		const result = await run(fake.ctx, ["op", "demo_room", "save", "--expect", "success=true", "--user", "张三"]);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.message).toContain("对得上 2 个用户");
	});

	it("连着用同一个人跑几次，查人这一步不算重复提问", async () => {
		const fake = project();
		// 每次看的字段不同，form 本身不重复；重复的只有「emp_a 是谁」这一问
		for (let i = 0; i < 4; i++) {
			const result = await run(fake.ctx, ["form", "demo_room", "--show", `demo_f${i}`, "--user", "emp_a"]);
			expect(result.ok).toBe(true);
		}
	});
});
