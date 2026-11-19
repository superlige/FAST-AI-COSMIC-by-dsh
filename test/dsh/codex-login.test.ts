/**
 * 设置 → 模型页「登录 ChatGPT」的宿主半边：发起 → 打开登录页 → 浏览器回调或人粘贴地址 → 凭据存好。
 * 授权服务用假的，只看本插件自己的状态机和请求路径。
 */
import { readFileSync } from "node:fs";
import type { AuthorizationService } from "@deepseek-ai/dsh-authorization";
import { describe, expect, it } from "vitest";
import { CODEX_AUTH_KEY, CODEX_LOGIN_PATH, CodexLogin, handleCodexLogin } from "../../src/dsh/codex-login.ts";

type Begin = Parameters<AuthorizationService["begin"]>[0];

function fakeAuthorization(run: (options: Begin) => Promise<{ status: "authorized" | "cancelled" }>) {
	const calls: Begin[] = [];
	const service = {
		begin: (options: Begin) => {
			calls.push(options);
			return run(options);
		},
		cancel: () => {},
	} as unknown as AuthorizationService;
	return { service, calls };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const post = (body: unknown) =>
	new Request(`http://local${CODEX_LOGIN_PATH}`, { method: "POST", body: JSON.stringify(body) });

describe("登录 ChatGPT", () => {
	it("发起后打开登录页；浏览器回调没回来时，粘贴的地址交回 flow，登完显示已登录", async () => {
		let stored = false;
		const opened: string[] = [];
		const { service, calls } = fakeAuthorization(async (options) => {
			options.interaction.notify({ message: "去浏览器登录", url: "https://auth.example/start" });
			const pasted = await options.interaction.prompt({ kind: "text", message: "粘贴浏览器地址栏的地址" });
			expect(pasted).toBe("http://localhost:1455/auth/callback?code=x");
			stored = true;
			return { status: "authorized" };
		});
		const login = new CodexLogin(
			() => service,
			() => ({ describeRecord: async () => ({ configured: stored }), deleteRecord: async () => {} }),
			(url) => opened.push(url),
		);
		const started = await (await handleCodexLogin(login, post({ action: "start" }))).json();
		expect(calls[0]?.key).toBe(CODEX_AUTH_KEY);
		expect(calls[0]?.method).toBe("oauth");
		expect(started.phase).toBe("waiting");
		expect(opened).toEqual(["https://auth.example/start"]);
		expect(started.question.message).toBe("粘贴浏览器地址栏的地址");
		// 再点一次不重发
		await handleCodexLogin(login, post({ action: "start" }));
		expect(calls).toHaveLength(1);
		await handleCodexLogin(login, post({ action: "answer", text: " http://localhost:1455/auth/callback?code=x " }));
		await tick();
		const done = await (await handleCodexLogin(login, new Request(`http://local${CODEX_LOGIN_PATH}`))).json();
		expect(done).toMatchObject({ phase: "succeeded", signedIn: true });
		expect(done.question).toBeUndefined();
	});

	it("浏览器回调先到、flow 撤回那一问，界面上的输入框跟着收掉", async () => {
		const withdraw = new AbortController();
		let finish: () => void = () => {};
		const { service } = fakeAuthorization(async (options) => {
			options.interaction.prompt({ kind: "text", message: "粘贴地址", signal: withdraw.signal }).catch(() => {});
			await new Promise<void>((resolve) => {
				finish = resolve;
			});
			return { status: "authorized" };
		});
		const login = new CodexLogin(
			() => service,
			() => undefined,
			() => {},
		);
		login.start();
		expect((await login.view()).question?.message).toBe("粘贴地址");
		withdraw.abort();
		expect((await login.view()).question).toBeUndefined();
		finish();
		await tick();
		expect((await login.view()).phase).toBe("succeeded");
	});

	it("flow 失败照实报；没有在等的问题时交答案被拒；不认识的 action 被拒", async () => {
		const { service } = fakeAuthorization(async () => {
			throw new Error("回调端口 1455 被占用");
		});
		const login = new CodexLogin(
			() => service,
			() => undefined,
			() => {},
		);
		login.start();
		await tick();
		expect(await login.view()).toMatchObject({ phase: "failed", error: "回调端口 1455 被占用" });
		expect((await handleCodexLogin(login, post({ action: "answer", text: "x" }))).status).toBe(409);
		expect((await handleCodexLogin(login, post({ action: "delete-everything" }))).status).toBe(400);
	});

	it("没装授权服务时说清楚，不假装在登", async () => {
		const login = new CodexLogin(
			() => undefined,
			() => undefined,
			() => {},
		);
		login.start();
		expect(await login.view()).toMatchObject({ phase: "failed", error: "这个宿主没有装授权服务，登录不了" });
	});

	it("界面调的路径和宿主注册的是同一条", () => {
		const client = readFileSync(new URL("../../client/brand.js", import.meta.url), "utf8");
		expect(client).toContain(`const CODEX_LOGIN_ROUTE = "${CODEX_LOGIN_PATH.slice(1)}";`);
		expect(client).toContain('name: "settings.models.provider-card", key: "llm-pi-ai"');
	});
});
