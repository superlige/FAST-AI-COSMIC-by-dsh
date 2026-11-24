/**
 * 写元数据一次调用写完：没有用户确认什么都不落库，落库的范围就是确认单上的范围。
 * 门（预演、落库）是假的，只记下被叫了几次、拿到了什么授权。
 */
import { describe, expect, it } from "vitest";
import type { ReportInput } from "../../src/agent/state/write-report.ts";
import { type CallContext, CosmicHost } from "../../src/dsh/host.ts";
import type { CosmicKernel, ProjectHandle } from "../../src/dsh/kernel.ts";
import { CosmicToolFailure } from "../../src/dsh/result.ts";
import { CosmicSession } from "../../src/dsh/session.ts";
import { type Confirm, type ConfirmAnswer, type WriteDoor, type WriteRun, writeMetadata } from "../../src/dsh/write.ts";

const ENV = {
	RULE_FORM: "demo_bill_lay",
	RULE_HOST: "demo_entry",
	RULE_TAG: "拆分-",
	RULE_GROUPS: '宽度类|demo_shape = "2"|demo_w1,demo_w2',
};

const TARGETS = ["demo_bill.demo_bill_lay", "demo_bill.demo_w1", "demo_bill.demo_w2"];

const PREVIEW: WriteRun = {
	exitCode: 0,
	output: `[PROBE] 写入目标清单：${TARGETS.join(",")}\n[PROBE] dry-run 结束：确认无误后加 APPLY=1\n`,
	records: [],
	value: { output: "预演" },
};

const APPLIED: WriteRun = {
	exitCode: 0,
	output: "[PROBE] rebuildRuntimeMetaById(demo_bill) 完成\n",
	records: [],
	value: { output: "落库" },
};

const REPORT: ReportInput = {
	purpose: "按试样形状显示宽度",
	names: [
		{ id: "demo_bill_lay", name: "拉伸布局" },
		{ id: "demo_entry", name: "试验结果" },
		{ id: "demo_w1", name: "宽度1" },
		{ id: "demo_w2", name: "宽度2" },
	],
	slots: [{ key: "g1", text: "试样形状选矩形" }],
};

type Authorization = Parameters<WriteDoor["apply"]>[0];

function setup(answer: ConfirmAnswer) {
	const host = new CosmicHost({} as CosmicKernel);
	const session = new CosmicSession<ProjectHandle>();
	const call: CallContext = {
		tool: "cosmic_probe",
		session,
		agent: undefined,
		signal: new AbortController().signal,
		startedAt: new Date().toISOString(),
		cwd: async () => "D:/demo",
	};
	const seen = { previews: 0, applies: [] as Authorization[], cards: [] as string[] };
	const door: WriteDoor = {
		probe: "FormRuleProbe",
		env: ENV,
		label: "FormRuleProbe RULE_FORM=demo_bill_lay",
		async preview() {
			seen.previews += 1;
			return PREVIEW;
		},
		async apply(authorization) {
			seen.applies.push(authorization);
			return APPLIED;
		},
	};
	const confirm: Confirm = async (_call, question) => {
		seen.cards.push(question.detail);
		return answer;
	};
	/** null = 不交 report。 */
	const run = (report: ReportInput | null = REPORT) =>
		writeMetadata(host, call, {} as ProjectHandle, door, report ?? undefined, confirm, { name: "FormRuleProbe" });
	return { session, seen, run };
}

async function failure(promise: Promise<unknown>): Promise<CosmicToolFailure> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof CosmicToolFailure) return error;
		throw error;
	}
	throw new Error("应当失败");
}

describe("写元数据：没确认不落库", () => {
	it("用户点了不写：预演一次、弹一次确认、落库零次，记成没写", async () => {
		const { seen, session, run } = setup({ kind: "declined", note: "宽度2 不要" });
		const blocks = await run();
		expect(seen.previews).toBe(1);
		expect(seen.cards).toHaveLength(1);
		expect(seen.applies).toHaveLength(0);
		expect(blocks[0]).toContain('"declined":true');
		expect(blocks[0]).toContain("宽度2 不要");
		expect(session.metaWrites.map((write) => write.outcome)).toEqual(["declined"]);
	});

	it("弹不了确认（无头运行）：拒，确认单原样附上，落库零次", async () => {
		const { seen, run } = setup({ kind: "unavailable", reason: "没有提问服务" });
		const error = await failure(run());
		expect(error.code).toBe("COSMIC_WRITE_CONFIRM_UNAVAILABLE");
		expect(error.message).toContain("# 确认单");
		expect(seen.applies).toHaveLength(0);
	});

	it("report 没交：拒并给模板，不弹确认、不落库", async () => {
		const { seen, run } = setup({ kind: "approved" });
		const error = await failure(run(null));
		expect(error.code).toBe("COSMIC_WRITE_REPORT_INVALID");
		expect(seen.cards).toHaveLength(0);
		expect(seen.applies).toHaveLength(0);
	});
});

describe("写元数据：落库范围就是确认单上的范围", () => {
	it("确认后落库一次，授权的目标就是预演报出、确认单上列出的那几个", async () => {
		const { seen, session, run } = setup({ kind: "approved" });
		const blocks = await run();
		expect(seen.applies).toHaveLength(1);
		const authorization = seen.applies[0] as Authorization;
		expect([...authorization.targets].sort()).toEqual([...TARGETS].sort());
		expect(authorization.confirmationId).toMatch(/^C-[0-9a-f]{8}$/);
		expect(authorization.rollback).not.toBe("");
		const card = seen.cards[0] as string;
		expect(card).toContain(`**写入范围**：${String(TARGETS.length)} 个对象`);
		for (const target of TARGETS) expect(card).toContain(target.split(".")[1] as string);
		expect(blocks[0]).toContain('"written":true');
		expect(session.metaWrites.map((write) => write.outcome)).toEqual(["written"]);
	});
});
