/**
 * 开始查生产不经过任何命令：monitor 没登录时，cosmic_prod 第一次用、查日志前要自己弹验证码框，
 * 人不登就本会话不再问。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openWithSystemViewer } from "../../src/agent/tools/open-viewer.ts";
import { askText } from "../../src/dsh/commands.ts";
import { type CallContext, CosmicHost } from "../../src/dsh/host.ts";
import type { CosmicKernel, ProjectHandle } from "../../src/dsh/kernel.ts";
import {
	type AskCode,
	ensureMonitorLogin,
	initialMonitorPromptState,
	loginMonitor,
	MONITOR_LOGIN_ATTEMPTS,
} from "../../src/dsh/monitor-login.ts";
import { CosmicSession } from "../../src/dsh/session.ts";
import { prodTool } from "../../src/dsh/tools/prod.ts";
import { KernelError } from "../../src/kernel/errors.ts";

vi.mock("../../src/agent/tools/open-viewer.ts", () => ({
	openWithSystemViewer: vi.fn(() => true),
}));

beforeEach(() => {
	vi.mocked(openWithSystemViewer).mockClear();
});

type Ping = "alive" | "expired" | "none";

function fakeKernel(options: { ping?: Ping; noMonitor?: boolean; required?: boolean; goodCode?: string } = {}) {
	const calls = { ping: 0, captcha: 0, login: [] as string[] };
	let ping: Ping = options.ping ?? "none";
	const kernel = {
		async prodMonitorPing() {
			calls.ping++;
			return ping;
		},
		async prodMonitorCaptcha() {
			calls.captcha++;
			if (options.noMonitor === true)
				return {
					ok: false as const,
					error: new KernelError("PROD_CONFIG_MISSING", "生产排障配置里没有 monitor 账号"),
				};
			return {
				ok: true as const,
				value: {
					required: options.required ?? true,
					loginId: `id-${String(calls.captcha)}`,
					image: null,
					imageType: "png",
					imageFile: `C:/cache/prod/monitor-captcha-${String(calls.captcha)}.png`,
					username: "viewer",
				},
			};
		},
		async prodMonitorLogin(_captcha: unknown, code: string) {
			calls.login.push(code);
			if (options.goodCode !== undefined && code !== options.goodCode)
				return {
					ok: false as const,
					error: new KernelError("PROD_MONITOR_FAILED", "monitor 登录没成功：验证码错误"),
				};
			ping = "alive";
			return { ok: true as const, value: { loggedInAt: 1 } };
		},
	};
	return { kernel, calls };
}

function scriptedAsk(answers: (string | undefined)[]) {
	const asked: { question: string; detail: string }[] = [];
	const ask: AskCode = async (question, detail) => {
		asked.push({ question, detail });
		return answers.shift();
	};
	return { ask, asked };
}

const live = new AbortController().signal;
const noOpen = () => {};

describe("cosmic_prod 前自动登录 monitor", () => {
	it("会话里第一次用就弹验证码，人输了就登上；查库也弹（调 cosmic_prod 就是在查生产，日志多半也要看）", async () => {
		const { kernel, calls } = fakeKernel();
		const { ask, asked } = scriptedAsk([" ab12 "]);
		const state = initialMonitorPromptState();
		const outcome = await ensureMonitorLogin(kernel, state, false, ask, live, noOpen);
		expect(outcome).toEqual({ kind: "logged-in" });
		expect(asked).toHaveLength(1);
		expect(asked[0]?.question).toContain("viewer");
		expect(asked[0]?.detail).toContain("monitor-captcha-1.png");
		expect(calls.login).toEqual(["ab12"]);
	});

	it("登着的不弹；第一次之后查库不再看，查日志每次都看", async () => {
		const { kernel, calls } = fakeKernel({ ping: "alive" });
		const { ask, asked } = scriptedAsk([]);
		const state = initialMonitorPromptState();
		expect(await ensureMonitorLogin(kernel, state, false, ask, live, noOpen)).toBeNull();
		expect(await ensureMonitorLogin(kernel, state, false, ask, live, noOpen)).toBeNull();
		expect(calls.ping).toBe(1);
		expect(await ensureMonitorLogin(kernel, state, true, ask, live, noOpen)).toBeNull();
		expect(calls.ping).toBe(2);
		expect(asked).toHaveLength(0);
	});

	it("过期了查日志再弹一次", async () => {
		const { kernel } = fakeKernel({ ping: "expired" });
		const { ask, asked } = scriptedAsk(["x1", "x2"]);
		const state = { checked: true, stopAsking: false };
		expect(await ensureMonitorLogin(kernel, state, true, ask, live, noOpen)).toEqual({ kind: "logged-in" });
		expect(asked).toHaveLength(1);
	});

	it("人点了「不填了」：本会话不再问，查日志也不问", async () => {
		const { kernel } = fakeKernel();
		const { ask, asked } = scriptedAsk([""]);
		const state = initialMonitorPromptState();
		expect(await ensureMonitorLogin(kernel, state, false, ask, live, noOpen)).toEqual({ kind: "declined" });
		expect(await ensureMonitorLogin(kernel, state, true, ask, live, noOpen)).toBeNull();
		expect(asked).toHaveLength(1);
	});

	it("界面弹不了（无头运行）：不再问", async () => {
		const { kernel } = fakeKernel();
		const state = initialMonitorPromptState();
		const ask: AskCode = (question, detail) => askText(undefined, undefined, live, question, detail);
		expect(await ensureMonitorLogin(kernel, state, true, ask, live, noOpen)).toEqual({ kind: "unavailable" });
		expect(state.stopAsking).toBe(true);
	});

	it("没配 monitor 账号：不弹、不报错，本会话不再看", async () => {
		const { kernel, calls } = fakeKernel({ noMonitor: true });
		const { ask, asked } = scriptedAsk([]);
		const state = initialMonitorPromptState();
		expect((await ensureMonitorLogin(kernel, state, true, ask, live, noOpen))?.kind).toBe("not-configured");
		expect(await ensureMonitorLogin(kernel, state, true, ask, live, noOpen)).toBeNull();
		expect(calls.captcha).toBe(1);
		expect(asked).toHaveLength(0);
	});

	it("这一轮被人停了：不算不登，下次照样问", async () => {
		const { kernel } = fakeKernel();
		const stopped = new AbortController();
		stopped.abort();
		const state = initialMonitorPromptState();
		const { ask } = scriptedAsk([undefined]);
		await ensureMonitorLogin(kernel, state, true, ask, stopped.signal, noOpen);
		expect(state.stopAsking).toBe(false);
	});
});

describe("monitor 登录", () => {
	it("验证码输错：换一张图再问，说明里带上为什么", async () => {
		const { kernel, calls } = fakeKernel({ goodCode: "right" });
		const { ask, asked } = scriptedAsk(["wrong", "right"]);
		expect(await loginMonitor(kernel, ask, noOpen)).toEqual({ kind: "logged-in" });
		expect(calls.captcha).toBe(2);
		expect(asked[1]?.detail).toContain("验证码错误");
		expect(asked[1]?.detail).toContain("monitor-captcha-2.png");
	});

	it(`连错 ${String(MONITOR_LOGIN_ATTEMPTS)} 次就停，照实说`, async () => {
		const { kernel, calls } = fakeKernel({ goodCode: "right" });
		const { ask } = scriptedAsk(["a", "b", "c", "d"]);
		const outcome = await loginMonitor(kernel, ask, noOpen);
		expect(outcome.kind).toBe("failed");
		expect(calls.login).toHaveLength(MONITOR_LOGIN_ATTEMPTS);
	});

	it("不要验证码就直接登，不问人", async () => {
		const { kernel } = fakeKernel({ required: false });
		const { ask, asked } = scriptedAsk([]);
		expect(await loginMonitor(kernel, ask, noOpen)).toEqual({ kind: "logged-in" });
		expect(asked).toHaveLength(0);
	});

	it("验证码图交给看图程序打开", async () => {
		const { kernel } = fakeKernel();
		const opened: string[] = [];
		await loginMonitor(kernel, scriptedAsk(["ok"]).ask, (file) => opened.push(file));
		expect(opened).toEqual(["C:/cache/prod/monitor-captcha-1.png"]);
	});
});

describe("cosmic_prod 工具接上了自动登录", () => {
	it("会话里第一次查库：先弹验证码、登上，再照常查", async () => {
		const { kernel, calls } = fakeKernel();
		const order: string[] = [];
		const full = {
			...kernel,
			open: async () => ({ ok: true, value: { handle: {}, summary: { root: "D:/demo", runtimeKeyId: "rk1" } } }),
			prod: async () => {
				order.push("prod");
				return { ok: true, value: { text: "1 行" } };
			},
			prodReport: () => ({ ok: false }),
		} as unknown as CosmicKernel;
		const call: CallContext = {
			tool: "cosmic_prod",
			session: new CosmicSession<ProjectHandle>(),
			agent: undefined,
			signal: live,
			startedAt: new Date().toISOString(),
			cwd: async () => "D:/demo",
		};
		const asked: string[] = [];
		const tool = prodTool(new CosmicHost(full), () => async (question) => {
			asked.push(question);
			order.push("ask");
			return "ab12";
		});
		await tool.execute({ action: "sql", sql: "select 1" }, call);
		expect(order).toEqual(["ask", "prod"]);
		expect(calls.login).toEqual(["ab12"]);
		await tool.execute({ action: "sql", sql: "select 1" }, call);
		expect(asked).toHaveLength(1);
		expect(openWithSystemViewer).toHaveBeenCalledExactlyOnceWith("C:/cache/prod/monitor-captcha-1.png");
	});
});
