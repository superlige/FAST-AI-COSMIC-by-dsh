/**
 * 「缓存」面板的宿主半边：按会话认工程、点了就开始做、做的时候不让再点、做完留下结果，
 * 只做清单上这一项有的动作；请求路径界面和宿主一致。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CACHE_BOARD_PATH, CacheBoard, handleCacheBoard } from "../../src/dsh/cache-board.ts";
import { runtimeDir } from "../../src/kernel/commands/mention.ts";
import { err, KernelError, ok } from "../../src/kernel/errors.ts";
import { makeContext } from "../kernel/fake-context.ts";

function setup(options: { buildFails?: boolean } = {}) {
	const fake = makeContext();
	const handle = { ctx: fake.ctx };
	const builds: { srcOnly?: boolean }[] = [];
	let release: () => void = () => undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const board = new CacheBoard<typeof handle>({
		project: (sessionId) => (sessionId === "s1" ? { root: fake.ctx.projectRoot, handle } : null),
		ctxOf: (h) => h.ctx,
		async impact(_h, request) {
			builds.push(request);
			await gate;
			return options.buildFails
				? err(new KernelError("PROBE_FAILED", "环境连不上"))
				: ok({ action: "build" } as never);
		},
		refreshMeta: async () => ({ state: "same", text: "没变化", ms: 1, steps: [] }),
		buildForms: async () => ok({ kind: "FormCatalog", at: "", ms: 1, forms: [] }),
		indexStale: () => null,
	});
	return { ...fake, board, builds, release };
}

const settle = async (board: CacheBoard<unknown>, item: string) => {
	for (let i = 0; i < 50; i++) {
		const job = board.view("s1", true).jobs[item];
		if (job?.finishedAt != null) return job;
		await new Promise((r) => setTimeout(r, 5));
	}
	throw new Error("没做完");
};

describe("缓存面板", () => {
	it("不是苍穹会话：不画", () => {
		const { board } = setup();
		expect(board.view("other")).toMatchObject({ tracked: false, groups: [] });
	});

	it("重建代码部分：点了就开始，做的时候再点答「正在做」，做完留下结果", async () => {
		const { board, builds, release } = setup();
		expect(board.act("s1", "impact-src", "rebuild-src").ok).toBe(true);
		expect(builds).toEqual([{ action: "build", srcOnly: true }]);
		expect(board.view("s1").jobs["impact-src"]?.finishedAt).toBeNull();
		expect(board.act("s1", "impact-src", "rebuild-src")).toMatchObject({ ok: false });
		release();
		const job = await settle(board as CacheBoard<unknown>, "impact-src");
		expect(job).toMatchObject({ ok: true });
		expect(job.text).toContain("重建完成");
	});

	it("没做成：照实留下原因", async () => {
		const { board, release } = setup({ buildFails: true });
		board.act("s1", "impact-meta", "rebuild-all");
		release();
		const job = await settle(board as CacheBoard<unknown>, "impact-meta");
		expect(job).toMatchObject({ ok: false, text: "PROBE_FAILED：环境连不上" });
	});

	it("清空运行态字段：删掉那个目录；清单上这一项没有的动作、不认识的动作不做", async () => {
		const { board, ctx, fs } = setup();
		fs.put(`${runtimeDir(ctx)}/demo_bill.json`, "{}");
		expect(board.act("s1", "mention-runtime", "clear").ok).toBe(true);
		await settle(board as CacheBoard<unknown>, "mention-runtime");
		expect(fs.exists(`${runtimeDir(ctx)}/demo_bill.json`)).toBe(false);
		expect(board.act("s1", "impact-src", "clear")).toMatchObject({ ok: false });
		expect(board.act("s1", "mention-runtime", "rm -rf")).toMatchObject({ ok: false });
		expect(board.act("s1", "nothing", "clear")).toMatchObject({ ok: false });
	});

	it("请求路径：界面用的和宿主一致；GET 要带 session，POST 要带 item 和 action", async () => {
		const client = readFileSync(new URL("../../client/brand.js", import.meta.url), "utf8");
		expect(client).toContain(`"${CACHE_BOARD_PATH.slice(1)}"`);
		const { board } = setup();
		const url = (q: string) => `http://local${CACHE_BOARD_PATH}${q}`;
		expect((await handleCacheBoard(board, new Request(url("")))).status).toBe(400);
		expect(
			((await (await handleCacheBoard(board, new Request(url("?session=s1")))).json()) as { tracked: boolean })
				.tracked,
		).toBe(true);
		const post = (body: unknown) =>
			handleCacheBoard(board, new Request(url(""), { method: "POST", body: JSON.stringify(body) }));
		expect((await post({ session: "s1" })).status).toBe(400);
		expect((await post({ session: "s1", item: "impact-src", action: "clear" })).status).toBe(409);
	});
});
