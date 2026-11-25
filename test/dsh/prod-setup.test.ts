/**
 * 生产排障配置向导：缺什么问什么、写之前试连、连不上能重填或照样写、不确认不写；
 * cosmic_prod 第一次用时没配就自己弹，人不填就本会话不再弹；并行的调用只弹一个。
 */
import { describe, expect, it } from "vitest";
import type { CallContext } from "../../src/dsh/host.ts";
import { CosmicHost } from "../../src/dsh/host.ts";
import type { CosmicKernel, ProjectHandle } from "../../src/dsh/kernel.ts";
import {
	configureProd,
	ensureProdConfig,
	initialProdSetupPromptState,
	type ProdCheck,
} from "../../src/dsh/prod-setup.ts";
import { CosmicSession } from "../../src/dsh/session.ts";
import type { Ask } from "../../src/dsh/setup.ts";
import { prodTool } from "../../src/dsh/tools/prod.ts";
import { KernelError } from "../../src/kernel/errors.ts";
import { prodConfigFile } from "../../src/kernel/prod/config.ts";
import {
	mergeProdConfig,
	type ProdConfigDraft,
	type ProdSetupAnswers,
	readProdConfigDraft,
	writeProdConfig,
} from "../../src/kernel/prod/setup.ts";
import { MemoryFs } from "../kernel/fake-context.ts";

const DIR = "C:/home/.fast-ai-cosmic";
const FILE = prodConfigFile(DIR);

function fakeKernel(fs = new MemoryFs()) {
	const kernel = {
		prodSetupDraft: () => readProdConfigDraft(fs, DIR),
		prodSetupWrite: (draft: ProdConfigDraft, answers: ProdSetupAnswers) =>
			writeProdConfig(fs, draft, mergeProdConfig(draft, answers)),
	};
	return { kernel: kernel as unknown as Pick<CosmicKernel, "prodSetupDraft" | "prodSetupWrite">, fs };
}

/** 文字题按顺序答；选择题按 choices 顺序答（没给就选第一项）；确认单按 approve 答。 */
function scripted(texts: (string | undefined)[], choices: string[] = [], approve = true) {
	const asked: string[] = [];
	const shown: string[] = [];
	const ask: Ask = {
		async text(question) {
			asked.push(question);
			return texts.shift();
		},
		async choose(question, _detail, options) {
			asked.push(question);
			const wanted = choices.shift();
			return wanted === undefined ? options[0] : options.find((one) => one === wanted);
		},
		async approve(question, detail) {
			asked.push(question);
			shown.push(detail);
			return approve;
		},
	};
	return { ask, asked, shown };
}

const DB_ANSWERS = ["10.0.0.1", "8000", "demo", "reader", "secret"];
const okCheck: ProdCheck = async () => ({ ok: true, value: "连上了：openGauss，库 demo，账号 reader，会话只读 是" });

describe("生产排障配置向导", () => {
	it("没配：库类型选、五项逐个问、端口填错重问；试连上了；monitor 先不配；确认单不带密码", async () => {
		const { kernel, fs } = fakeKernel();
		const { ask, asked, shown } = scripted(
			["10.0.0.1", "80a", "8000", "demo", "reader", "secret"],
			["opengauss", "暂不配置"],
		);
		const outcome = await configureProd(kernel, ask, okCheck, { revise: false, askMonitor: true });
		expect(outcome.kind).toBe("ready");
		expect(outcome.text).toContain("连上了");
		expect(asked.filter((q) => q.includes("端口"))).toHaveLength(2);
		expect(shown[0]).not.toContain("secret");
		const saved = JSON.parse(fs.read(FILE));
		expect(saved.db).toMatchObject({ driver: "opengauss", host: "10.0.0.1", port: 8000, password: "secret" });
		expect(saved.monitor).toBeUndefined();
	});

	it("试连没连上：重填一遍连上了才写；照样写入也行；不写了就不写", async () => {
		let tries = 0;
		const flaky: ProdCheck = async (_draft, answers) =>
			++tries === 1
				? { ok: false, error: new KernelError("PROD_QUERY_FAILED", "生产库报错：password authentication failed") }
				: okCheck(_draft, answers);
		const first = fakeKernel();
		const retry = scripted([...DB_ANSWERS, ...DB_ANSWERS], ["opengauss", "重填数据库连接", "opengauss", "暂不配置"]);
		expect((await configureProd(first.kernel, retry.ask, flaky, { revise: false, askMonitor: true })).kind).toBe(
			"ready",
		);
		expect(tries).toBe(2);

		const failing: ProdCheck = async () => ({ ok: false, error: new KernelError("PROD_QUERY_FAILED", "连不上") });
		const anyway = fakeKernel();
		const written = await configureProd(
			anyway.kernel,
			scripted([...DB_ANSWERS], ["opengauss", "仍然写入", "暂不配置"]).ask,
			failing,
			{ revise: false, askMonitor: true },
		);
		expect(written.text).toContain("试连失败");
		expect(anyway.fs.exists(FILE)).toBe(true);

		const giveUp = fakeKernel();
		const stopped = await configureProd(
			giveUp.kernel,
			scripted([...DB_ANSWERS], ["opengauss", "放弃写入"]).ask,
			failing,
			{
				revise: false,
				askMonitor: true,
			},
		);
		expect(stopped.kind).toBe("stopped");
		expect(giveUp.fs.exists(FILE)).toBe(false);
	});

	it("不确认不写；中途不填就停", async () => {
		const declined = fakeKernel();
		const no = await configureProd(
			declined.kernel,
			scripted([...DB_ANSWERS], ["opengauss", "暂不配置"], false).ask,
			okCheck,
			{
				revise: false,
				askMonitor: true,
			},
		);
		expect(no).toEqual({ kind: "stopped", text: "未确认，生产排障配置未写入。" });
		expect(declined.fs.exists(FILE)).toBe(false);
		const quit = fakeKernel();
		expect(
			(
				await configureProd(quit.kernel, scripted(["10.0.0.1", ""]).ask, okCheck, {
					revise: false,
					askMonitor: true,
				})
			).kind,
		).toBe("stopped");
		expect(quit.fs.exists(FILE)).toBe(false);
	});

	it("命令里配齐了的：一句选「改哪部分」；补 monitor 不再问数据库，也不试连", async () => {
		const fs = new MemoryFs();
		fs.put(FILE, JSON.stringify({ db: { host: "h", port: 8000, database: "d", user: "u", password: "p" } }));
		const { kernel } = fakeKernel(fs);
		let checked = 0;
		const { ask, asked } = scripted(["https://m/monitor/eye", "viewer", "x"], ["配置 monitor 账号"]);
		const outcome = await configureProd(
			kernel,
			ask,
			async () => {
				checked++;
				return okCheck({} as ProdConfigDraft, {});
			},
			{ revise: true, askMonitor: true },
		);
		expect(outcome.kind).toBe("ready");
		expect(checked).toBe(0);
		expect(asked.some((q) => q.includes("主机"))).toBe(false);
		expect(JSON.parse(fs.read(FILE)).monitor).toEqual({
			url: "https://m/monitor/eye",
			username: "viewer",
			password: "x",
		});
		// 工具调用前那一路：齐了一句不问
		const silent = scripted([]);
		expect(await configureProd(kernel, silent.ask, okCheck, { revise: false, askMonitor: true })).toEqual({
			kind: "ready",
			text: "",
		});
		expect(silent.asked).toEqual([]);
	});
});

describe("cosmic_prod 第一次用时自己弹生产排障配置向导", () => {
	const live = new AbortController().signal;

	it("人不填：本会话不再弹；齐了的不弹", async () => {
		const { kernel } = fakeKernel();
		const state = initialProdSetupPromptState();
		const quit = scripted([""], ["opengauss"]);
		expect((await ensureProdConfig(kernel, state, quit.ask, okCheck, live))?.kind).toBe("stopped");
		expect(state.stopAsking).toBe(true);
		const again = scripted([]);
		expect(await ensureProdConfig(kernel, state, again.ask, okCheck, live)).toBeNull();
		expect(again.asked).toEqual([]);
	});

	it("并行的两个调用只弹一个向导", async () => {
		const { kernel } = fakeKernel();
		const state = initialProdSetupPromptState();
		const { ask, asked } = scripted([...DB_ANSWERS], ["opengauss", "暂不配置"]);
		const [a, b] = await Promise.all([
			ensureProdConfig(kernel, state, ask, okCheck, live),
			ensureProdConfig(kernel, state, ask, okCheck, live),
		]);
		expect(a?.kind).toBe("ready");
		expect(b?.kind).toBe("ready");
		expect(asked.filter((q) => q.includes("主机"))).toHaveLength(1);
	});

	it("工具里：先弹配置向导、写好再查；试连用的是这次打开的工程", async () => {
		const fs = new MemoryFs();
		const order: string[] = [];
		const checkedWith: unknown[] = [];
		const handle = { id: "project" };
		const kernel = {
			...fakeKernel(fs).kernel,
			open: async () => ({ ok: true, value: { handle, summary: { root: "D:/demo", runtimeKeyId: "rk1" } } }),
			prodSetupCheck: async (project: unknown) => {
				checkedWith.push(project);
				return { ok: true, value: "连上了" };
			},
			prod: async () => {
				order.push(fs.exists(FILE) ? "prod(配好了)" : "prod(没配)");
				return { ok: true, value: { text: "1 行" } };
			},
			prodReport: () => ({ ok: false }),
		} as unknown as CosmicKernel;
		const host = new CosmicHost(kernel);
		const { ask } = scripted([...DB_ANSWERS], ["opengauss", "暂不配置"]);
		host.askInCall = () => ask;
		const call: CallContext = {
			tool: "cosmic_prod",
			session: new CosmicSession<ProjectHandle>(),
			agent: undefined,
			signal: live,
			startedAt: new Date().toISOString(),
			cwd: async () => "D:/demo",
		};
		await prodTool(host).execute({ action: "sql", sql: "select 1" }, call);
		expect(order).toEqual(["prod(配好了)"]);
		expect(checkedWith).toEqual([handle]);
	});
});
