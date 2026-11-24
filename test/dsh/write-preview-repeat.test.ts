/**
 * 写调用里的预演不记「同一个问题问过几遍」的账。
 *
 * 真机复盘：模型先单独预演 FormLayoutWriteProbe，再发 APPLY=1（report 少了中文名被打回），
 * 补齐 report 再发——三次预演入参一样、输出一字不差，第三次被当成重复提问拒掉（PROBE_ANSWER_SETTLED），
 * 补好的确认单一直弹不出来。两扇写门（直接调写探针、cosmic_meta 写动作）的预演都要关掉记账。
 */
import { describe, expect, it } from "vitest";
import { type CallContext, CosmicHost } from "../../src/dsh/host.ts";
import type { CosmicKernel, ProjectHandle } from "../../src/dsh/kernel.ts";
import { CosmicToolFailure } from "../../src/dsh/result.ts";
import { CosmicSession } from "../../src/dsh/session.ts";
import { metaTool } from "../../src/dsh/tools/meta.ts";
import { probeTool } from "../../src/dsh/tools/probe.ts";
import type { Confirm } from "../../src/dsh/write.ts";

const ROOT = "D:/demo/project";

/** 预演一跑就失败返回：写流程停在预演之后，正好只看预演那一次带了什么选项。 */
const FAILED = { ok: false, error: { toJSON: () => ({ code: "DEMO_STOP", message: "预演到此为止", detail: {} }) } };

function harness(tool: "cosmic_probe" | "cosmic_meta", overlay: Record<string, string> = {}) {
	const seen: Record<string, unknown>[] = [];
	const kernel = {
		open: async () => ({ ok: true, value: { handle: {}, summary: { root: ROOT, runtimeKeyId: "rk1" } } }),
		prepareProbe: async () => ({
			ok: true,
			value: {
				plan: { target: { cls: "FormLayoutWriteProbe", adHoc: false }, overlay, api: null },
				blockers: [],
				capsules: [],
			},
		}),
		probe: async (_handle: unknown, _name: string, options: Record<string, unknown>) => {
			seen.push(options);
			return FAILED;
		},
		meta: async (_handle: unknown, _argv: readonly string[], options: Record<string, unknown>) => {
			seen.push(options);
			return FAILED;
		},
	} as unknown as CosmicKernel;
	const host = new CosmicHost(kernel);
	const call: CallContext = {
		tool,
		session: new CosmicSession<ProjectHandle>(),
		agent: undefined,
		signal: new AbortController().signal,
		startedAt: new Date().toISOString(),
		cwd: async () => ROOT,
	};
	const confirm: Confirm = async () => ({ kind: "approved" });
	return { host, call, confirm, seen };
}

async function failure(run: Promise<unknown>): Promise<CosmicToolFailure> {
	try {
		await run;
	} catch (error) {
		return error as CosmicToolFailure;
	}
	throw new Error("应当失败");
}

describe("写调用里的预演不记重复账", () => {
	it("写探针 APPLY=1：去掉 APPLY 的那次预演带 countRepeats:false", async () => {
		const env = { LAYOUT_FORM: "demo_bill", LAYOUT_BACKUP: ".cosmic-ai/evidence/meta-backup/before", APPLY: "1" };
		const { host, call, confirm, seen } = harness("cosmic_probe", env);
		const error = await failure(probeTool(host, confirm).execute({ name: "FormLayoutWriteProbe", env }, call));
		expect(error).toBeInstanceOf(CosmicToolFailure);
		expect(error.code).toBe("DEMO_STOP");
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({ countRepeats: false });
		expect((seen[0]?.env as Record<string, string>).APPLY).toBeUndefined();
	});

	it("cosmic_meta 写动作 apply=true：预演那次带 countRepeats:false", async () => {
		const { host, call, confirm, seen } = harness("cosmic_meta");
		const error = await failure(
			metaTool(host, confirm).execute({ argv: ["botp", "restore", "D:/demo/backup"], apply: true }, call),
		);
		expect(error.code).toBe("DEMO_STOP");
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({ apply: false, countRepeats: false });
	});
});
