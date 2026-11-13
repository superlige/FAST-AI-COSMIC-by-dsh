/**
 * 手机号换用户 id（启动向导那一步的内核侧）。
 *
 * 断言压在 JSON 旁路上，不压在人读行上：向导拿到的是要写进 config.json 的 id，
 * 靠正则解析中文行必然随文案漂移而碎 —— 那正是 ProbeJson 存在的理由。
 */

import { describe, expect, it } from "vitest";
import type { ProbeOutcome } from "../../src/kernel/commands/probe.ts";
import { lookupUsers, userCandidatesFrom } from "../../src/kernel/commands/user-lookup.ts";
import { addSource, type FakeContext, makeContext } from "./fake-context.ts";

function userFake(env: Record<string, string> = {}): FakeContext {
	const fake = makeContext({ probes: ["UserProbe"], env });
	fake.fs.put(
		`${fake.ctx.layout.probesDir.replace(/\\/g, "/")}/UserProbe.java`,
		"public class UserProbe { public static void run() {} }",
	);
	fake.fs.write(
		fake.ctx.layout.serverPid,
		JSON.stringify({
			pid: 321,
			keyId: fake.ctx.runtimeKeyId,
			port: 1,
			startedAt: "",
			account: fake.ctx.config.account,
			user: fake.ctx.config.user,
		}),
	);
	fake.proc.livePids.add(321);
	return fake;
}

const json = (record: Record<string, unknown>): string => `[PROBE-JSON] ${JSON.stringify(record)}`;

function reply(lines: readonly string[], exitCode = 0): { ok: true; text: string } {
	return { ok: true, text: [`RESULT OK ${exitCode}`, ...lines, ""].join("\n") };
}

const TWO_HITS = [
	"[PROBE] 命中用户 2 个  关键字=138****1234",
	json({ t: "user", id: "1234567", number: "lig", name: "李工", phone_mask: "138****1234" }),
	json({ t: "user", id: "7654321", number: "lil", name: "李丽", phone_mask: "138****1234" }),
	json({ t: "user-lookup", key: "138****1234", count: 2, truncated: false }),
];

describe("按手机号查用户", () => {
	it("把 JSON 旁路读成候选人，并把关键字交给探针", async () => {
		const fake = userFake();
		fake.net.handler = () => reply(TWO_HITS);
		const result = await lookupUsers(fake.ctx, " 13800001234 ");
		expect(result.ok && result.value.candidates).toEqual([
			{ id: "1234567", number: "lig", username: "", name: "李工", phoneMask: "138****1234" },
			{ id: "7654321", number: "lil", username: "", name: "李丽", phoneMask: "138****1234" },
		]);
		expect(result.ok && result.value.truncated).toBe(false);
		// 首尾空格是人打字带出来的，不该变成一个查不到的关键字
		expect(fake.net.requests[0]?.lines.join("\n")).toContain(
			`USER_KEY=${Buffer.from("13800001234", "utf8").toString("base64")}`,
		);
	});

	it("命中达上限时报 truncated —— 从截断名单里挑一个看着像的，正是要防的事", async () => {
		const fake = userFake();
		fake.net.handler = () =>
			reply([
				json({ t: "user", id: "1", number: "a", name: "甲", phone_mask: "" }),
				json({ t: "user-lookup", key: "李", count: 20, truncated: true }),
			]);
		const result = await lookupUsers(fake.ctx, "李");
		expect(result.ok && result.value.truncated).toBe(true);
	});

	it("零命中是成功的空名单，不是失败：让人换关键字，不是让人以为环境坏了", async () => {
		const fake = userFake();
		fake.net.handler = () => reply([json({ t: "user-lookup", key: null, count: 0, truncated: false })]);
		const result = await lookupUsers(fake.ctx, "13800000000");
		expect(result.ok && result.value.candidates).toEqual([]);
	});

	it("探针非零退出报 USER_LOOKUP_FAILED，并指向原文和「先直接填 id」这条退路", async () => {
		const fake = userFake();
		fake.net.handler = () => reply(["[PROBE-ERR] 找不到账套：acct"], 3);
		const result = await lookupUsers(fake.ctx, "13800001234");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("USER_LOOKUP_FAILED");
			expect(result.error.remedy).toContain("直接填用户 id");
		}
	});

	it("没有 id 的记录不是候选人", () => {
		const outcome = {
			json: {
				records: [
					{ t: "user", number: "lig", name: "李工" },
					{ t: "user", id: 1234567, number: "lig", name: "李工", phone_mask: "138****1234" },
					{ t: "profile-env", user_name: "李工" },
				],
				broken: [],
				file: "out.json",
			},
		} as unknown as ProbeOutcome;
		// 数字 id 照收（JSON 旁路里它是数字还是字符串取决于探针怎么发），缺 id 的丢掉
		expect(userCandidatesFrom(outcome)).toEqual([
			{ id: "1234567", number: "lig", username: "", name: "李工", phoneMask: "138****1234" },
		]);
	});

	it("陈旧业务类不该把配置向导挡在门外 —— 由 UserProbe 的 platform 档决定，不再靠调用方注入", async () => {
		// 之前这条是 kernel-adapter 在查用户时无条件写 COSMIC_STALE=warn 换来的，
		// 而它写在 ...base 之后，连用户显式设的 block 也一起盖掉。判断本身没变，
		// 换成 UserProbe 登记在 platform 档，于是显式设置重新说了算（下一条）。
		const fake = userFake();
		addSource(fake, "demo-biz", "A.java");
		fake.net.handler = () => reply(TWO_HITS);
		const result = await lookupUsers(fake.ctx, "13800001234");
		expect(result.ok).toBe(true);
	});

	it("显式 COSMIC_STALE=block 仍然拦得住查用户", async () => {
		const fake = userFake({ COSMIC_STALE: "block" });
		addSource(fake, "demo-biz", "A.java");
		fake.net.handler = () => reply(TWO_HITS);
		expect((await lookupUsers(fake.ctx, "13800001234")).ok).toBe(false);
	});
});
