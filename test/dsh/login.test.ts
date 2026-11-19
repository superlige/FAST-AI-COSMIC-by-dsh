/**
 * /cosmic-login 把登录流程的问题弹给人：codex 先问登录方式（select），
 * 只当填空弹出来的话界面上只剩「不填了」，登录必然取消。
 */
import { describe, expect, it } from "vitest";
import { answerAuthorizationPrompt } from "../../src/dsh/commands.ts";
import type { Ask } from "../../src/dsh/setup.ts";

function fakeAsk(answers: { text?: string; choose?: string }) {
	const seen: { kind: string; question: string; detail: string; options?: readonly string[] }[] = [];
	const ask: Ask = {
		async text(question, detail) {
			seen.push({ kind: "text", question, detail });
			return answers.text;
		},
		async choose(question, detail, options) {
			seen.push({ kind: "choose", question, detail, options });
			return answers.choose;
		},
		async approve() {
			return false;
		},
	};
	return { ask, seen };
}

const select = {
	kind: "select" as const,
	message: "Select OpenAI Codex login method:",
	options: [
		{ id: "browser", label: "Browser", description: "opens a page" },
		{ id: "device", label: "Device code" },
	],
};

describe("登录流程的提问", () => {
	it("select 弹成选项，回选中项的 id", async () => {
		const { ask, seen } = fakeAsk({ choose: "Device code" });
		expect(await answerAuthorizationPrompt(select, ask, "")).toBe("device");
		expect(seen[0]?.kind).toBe("choose");
		expect(seen[0]?.options).toEqual(["Browser", "Device code"]);
		expect(seen[0]?.detail).toContain("Browser：opens a page");
	});

	it("select 没选：登录取消", async () => {
		const { ask } = fakeAsk({});
		await expect(answerAuthorizationPrompt(select, ask, "")).rejects.toThrow("没有选");
	});

	it("text 弹成填空，说明里带上前面的提示（地址、代码）", async () => {
		const { ask, seen } = fakeAsk({ text: "  http://localhost:1455/auth/callback?code=x  " });
		const answer = await answerAuthorizationPrompt(
			{ kind: "text", message: "Paste the redirect URL" },
			ask,
			"地址：https://auth.example/x",
		);
		expect(answer).toBe("http://localhost:1455/auth/callback?code=x");
		expect(seen[0]?.detail).toContain("地址：https://auth.example/x");
	});

	it("text 没填：登录取消", async () => {
		const { ask } = fakeAsk({ text: "" });
		await expect(answerAuthorizationPrompt({ kind: "secret", message: "key" }, ask, "")).rejects.toThrow("没有填写");
	});
});
