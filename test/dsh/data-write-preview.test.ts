/**
 * 造数、改数带 PREVIEW=1 的回滚预演：探针打了「dry-run 结束」、退出码 0，就是成功，不按落库来验。
 *
 * 真机复盘：DataSeedProbe PREVIEW=1 三步 isSuccess=true、前后行数不变、打了 dry-run 结束和 [PROBE-OK]，
 * 外层却拿「有没有打落库行」去验它，判成 ok:false「探针自己中止了，没有落库」，
 * 模型分不清预演到底过没过，不敢往下走。真落库（不带 PREVIEW）没打落库行的，照旧判没落库。
 */
import { describe, expect, it } from "vitest";
import { type CallContext, CosmicHost } from "../../src/dsh/host.ts";
import type { CosmicKernel, ProjectHandle } from "../../src/dsh/kernel.ts";
import { CosmicToolFailure } from "../../src/dsh/result.ts";
import { CosmicSession } from "../../src/dsh/session.ts";
import { probeTool } from "../../src/dsh/tools/probe.ts";
import type { Confirm } from "../../src/dsh/write.ts";
import { dataWriteOverlay } from "../../src/kernel/policy/write-plan.ts";

const ROOT = "D:/demo/project";

const PREVIEW_OUTPUT = [
	"[PROBE] 跑之前行数=3",
	"[PROBE] demo_bill#1 save -> isSuccess=true",
	"[PROBE] demo_bill#1 submit -> isSuccess=true",
	"[PROBE] demo_bill#1 audit -> isSuccess=true",
	"[PROBE] 跑之后行数=3  （无痕）",
	"[PROBE] dry-run 结束，未写入（1 条都在回滚事务里跑通了操作链）。要落库就去掉 PREVIEW=1 再跑（测试环境，不用确认）",
	"[PROBE-OK]",
].join("\n");

function harness(env: Record<string, string>, output: string) {
	const overlay = dataWriteOverlay(env);
	const kernel = {
		open: async () => ({ ok: true, value: { handle: {}, summary: { root: ROOT, runtimeKeyId: "rk1" } } }),
		prepareProbe: async () => ({
			ok: true,
			value: {
				plan: { target: { cls: "DataSeedProbe", adHoc: false }, overlay, api: null },
				blockers: [],
				capsules: [],
			},
		}),
		probe: async () => ({ ok: true, value: { exitCode: 0, output, json: { records: [] } } }),
	} as unknown as CosmicKernel;
	const host = new CosmicHost(kernel);
	const session = new CosmicSession<ProjectHandle>();
	const call: CallContext = {
		tool: "cosmic_probe",
		session,
		agent: undefined,
		signal: new AbortController().signal,
		startedAt: new Date().toISOString(),
		cwd: async () => ROOT,
	};
	const confirm: Confirm = async () => ({ kind: "approved" });
	return { run: () => probeTool(host, confirm).execute({ name: "DataSeedProbe", env }, call), session };
}

describe("造数预演", () => {
	it("PREVIEW=1 跑通：成功返回，不说「自己中止」，不记成一次写数据", async () => {
		const { run, session } = harness({ SEED_ENTITY: "demo_bill", PREVIEW: "1" }, PREVIEW_OUTPUT);
		const blocks = await run();
		const text = blocks.join("\n");
		expect(text).not.toContain("自己中止");
		expect(text).toContain("dry-run 结束");
		expect(session.dataWrites).toHaveLength(0);
	});

	it("真落库却没打落库行：照旧判没落库", async () => {
		const { run, session } = harness({ SEED_ENTITY: "demo_bill" }, "[PROBE] 跑之前行数=3\n[PROBE-OK]");
		let caught: unknown;
		try {
			await run();
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(CosmicToolFailure);
		expect((caught as CosmicToolFailure).code).toBe("COSMIC_WRITE_NOT_APPLIED");
		expect(session.dataWrites).toHaveLength(0);
	});
});
