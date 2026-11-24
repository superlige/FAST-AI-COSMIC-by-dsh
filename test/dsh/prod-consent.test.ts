/**
 * 开发和查生产在同一个会话里：本会话第一次连生产前问人一次。
 * 允许了本会话不再问；不允许，这次不查（内核一次都不叫），下次调用再问；
 * 框弹不出来（无界面运行时提问服务没有人能答）就不拦、照常查；出诊断报告不碰生产，不问。
 */
import { describe, expect, it } from "vitest";
import { type CallContext, CosmicHost } from "../../src/dsh/host.ts";
import type { CosmicKernel, ProjectHandle } from "../../src/dsh/kernel.ts";
import {
	ALLOW_PROD,
	askProdConsentVia,
	DENY_PROD,
	ensureProdConsent,
	initialProdConsentState,
	type ProdConsentAnswer,
} from "../../src/dsh/prod-setup.ts";
import { CosmicToolFailure } from "../../src/dsh/result.ts";
import { CosmicSession } from "../../src/dsh/session.ts";
import { prodTool } from "../../src/dsh/tools/prod.ts";

const live = new AbortController().signal;

function asking(answers: ProdConsentAnswer[]) {
	let asked = 0;
	const ask = async (): Promise<ProdConsentAnswer> => {
		asked += 1;
		return answers.shift() ?? "declined";
	};
	return { ask, asked: () => asked };
}

function setup(ask: (() => Promise<ProdConsentAnswer>) | undefined) {
	const calls: string[] = [];
	const kernel = {
		open: async () => ({ ok: true, value: { handle: {}, summary: { root: "D:/demo", runtimeKeyId: "rk1" } } }),
		prod: async (_project: unknown, request: { action: string }) => {
			calls.push(request.action);
			return { ok: true, value: { text: "1 行" } };
		},
		prodReport: () => ({ ok: true, value: { file: "D:/demo/r.md", proven: 0, inferred: 0, text: "" } }),
	} as unknown as CosmicKernel;
	const host = new CosmicHost(kernel);
	host.askProdConsent = ask === undefined ? undefined : () => ask;
	const session = new CosmicSession<ProjectHandle>();
	const call = (): CallContext => ({
		tool: "cosmic_prod",
		session,
		agent: undefined,
		signal: live,
		startedAt: new Date().toISOString(),
		cwd: async () => "D:/demo",
	});
	const run = (args: Record<string, unknown>) => prodTool(host).execute(args as never, call());
	return { calls, run };
}

describe("本会话第一次查生产前问人", () => {
	it("允许一次，本会话之后不再问", async () => {
		const { ask, asked } = asking(["allowed"]);
		const { calls, run } = setup(ask);
		await run({ action: "sql", sql: "select 1" });
		await run({ action: "status" });
		expect(asked()).toBe(1);
		expect(calls).toEqual(["sql", "status"]);
	});

	it("不允许：这次不查、照实报，下次调用再问", async () => {
		const { ask, asked } = asking(["declined", "allowed"]);
		const { calls, run } = setup(ask);
		const refused = await run({ action: "sql", sql: "select 1" }).catch((error: unknown) => error);
		expect(refused).toBeInstanceOf(CosmicToolFailure);
		expect((refused as CosmicToolFailure).code).toBe("PROD_NOT_ALLOWED");
		expect(calls).toEqual([]);
		await run({ action: "sql", sql: "select 1" });
		expect(asked()).toBe(2);
		expect(calls).toEqual(["sql"]);
	});

	it("框弹不出来（无界面运行时没有人能答）：不拦，照常查", async () => {
		const { ask } = asking(["unavailable", "unavailable"]);
		const { calls, run } = setup(ask);
		await run({ action: "sql", sql: "select 1" });
		await run({ action: "status" });
		expect(calls).toEqual(["sql", "status"]);
	});

	it("宿主没装这个问法：不问，照常查", async () => {
		const { calls, run } = setup(undefined);
		await run({ action: "sql", sql: "select 1" });
		expect(calls).toEqual(["sql"]);
	});

	it("出诊断报告不碰生产，不问", async () => {
		const { ask, asked } = asking([]);
		const { run } = setup(ask);
		await run({ action: "report", title: "t", findings: [] });
		expect(asked()).toBe(0);
	});

	it("并行的几个调用只弹一个框", async () => {
		const state = initialProdConsentState();
		const { ask, asked } = asking(["allowed"]);
		const results = await Promise.all([ensureProdConsent(state, ask), ensureProdConsent(state, ask)]);
		expect(results).toEqual([true, true]);
		expect(asked()).toBe(1);
	});
});

describe("怎么解读提问服务的回答", () => {
	type Questions = Parameters<typeof askProdConsentVia>[0];
	const service = (ask: () => Promise<unknown>) => ({ ask }) as unknown as Questions;
	const answered = (selected: string[]) =>
		service(async () => ({ answers: [{ id: "cosmic-prod-consent", selected }] }));

	it("无界面运行时提问服务报「没有人能答」：算弹不出来，不能当成不允许", async () => {
		const noProvider = service(async () => {
			throw Object.assign(new Error("no user-questions answerer accepted the request"), { code: "NO_PROVIDER" });
		});
		expect(await askProdConsentVia(noProvider, undefined, live)).toBe("unavailable");
		expect(await askProdConsentVia(undefined, undefined, live)).toBe("unavailable");
	});

	it("点了允许才算允许；点了不允许、跳过都算不同意", async () => {
		expect(await askProdConsentVia(answered([ALLOW_PROD]), undefined, live)).toBe("allowed");
		expect(await askProdConsentVia(answered([DENY_PROD]), undefined, live)).toBe("declined");
		expect(await askProdConsentVia(answered([]), undefined, live)).toBe("declined");
	});

	it("人中途停了这一轮：不算弹不出来，这次不查", async () => {
		const stop = new AbortController();
		stop.abort();
		const aborted = service(async () => {
			throw new Error("aborted");
		});
		expect(await askProdConsentVia(aborted, undefined, stop.signal)).toBe("declined");
	});
});
