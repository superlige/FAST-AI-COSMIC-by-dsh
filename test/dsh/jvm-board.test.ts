/**
 * 苍穹 JVM 状态板：进到开发会话就认工程、在后台起 JVM，一步步记进度；同一个工程的会话共用一份；
 * 起完以后在不在以现查的心跳为准。内核用假的，只看状态板自己的账和请求路径。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type BoardKernel, envDiagVerdict, handleJvmBoard, JVM_BOARD_PATH, JvmBoard } from "../../src/dsh/jvm-board.ts";
import type { ProbeProgressStage } from "../../src/kernel/commands/probe.ts";
import type { LocalServiceKind } from "../../src/kernel/probe/health.ts";

const GOOD_ENV = {
	t: "profile-env",
	tenant_id: "t1",
	account_id: "a1",
	account_number: "demo_acct",
	accounts: 1,
	db: "postgres",
	isv: "demo",
	user_name: "demo_user",
	meta_count: 12,
};

interface FakeOptions {
	built?: boolean;
	openError?: string;
	stages?: ProbeProgressStage[];
	/** 探针在这之前不答：测「正在起」的样子。 */
	gate?: Promise<void>;
	probeError?: string;
	records?: Record<string, unknown>[];
	stopHow?: string;
}

function fakeKernel(options: FakeOptions = {}) {
	let clock = 1_000_000;
	const calls = { open: 0, probe: 0, stop: 0 };
	let health: LocalServiceKind = "stopped";
	const kernel = {
		async open(root: string) {
			calls.open++;
			if (options.openError !== undefined)
				return { ok: false, error: { code: options.openError, message: `打不开：${options.openError}` } };
			return {
				ok: true,
				value: {
					handle: `handle:${root}`,
					summary: {
						root,
						runtimeKeyId: "key-1",
						built: options.built ?? true,
						identity: { user: "cfg_user", account: "cfg_acct", isv: "demox" },
					},
				},
			};
		},
		async probe(_handle: string, name: string, probeOptions: { onProgress?: (stage: ProbeProgressStage) => void }) {
			calls.probe++;
			expect(name).toBe("EnvDiagProbe");
			for (const stage of options.stages ?? ["checking-resident", "starting-runtime", "warming-runtime"]) {
				clock += 2000;
				probeOptions.onProgress?.(stage);
			}
			await options.gate;
			clock += 1000;
			probeOptions.onProgress?.("running-probe");
			clock += 500;
			if (options.probeError !== undefined)
				return { ok: false, error: { code: "PROBE_SERVER_UNAVAILABLE", message: options.probeError } };
			health = "ready";
			return { ok: true, value: { exitCode: 0, json: { records: options.records ?? [GOOD_ENV] } } };
		},
		async probeServer(_handle: string, action: string) {
			if (action === "stop") {
				calls.stop++;
				health = "stopped";
			}
			return { ok: true, value: { stopped: options.stopHow ?? "graceful" } };
		},
		async localServiceHealth() {
			return { kind: health, pid: health === "stopped" ? null : 4242, detail: null };
		},
		async residentBoot() {
			return {
				facts: { ready: { port: 41000, account: "demo_acct", pid: 4242 }, hotswap: "jrebel", warmMs: 8000 },
				startedAt: "2026-11-18T02:00:00.000Z",
			};
		},
	};
	return {
		kernel: kernel as unknown as BoardKernel<string>,
		calls,
		now: () => clock,
		setHealth: (kind: LocalServiceKind) => {
			health = kind;
		},
	};
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("JVM 状态板", () => {
	it("进到开发会话：认工程、起 JVM，每一步记用时，JVM 本来没在跑时编译宿主那步记跳过", async () => {
		const fake = fakeKernel();
		const board = new JvmBoard(fake.kernel, fake.now);
		board.track("s1", "D:/work/demo_proj");
		expect((await board.view("s1")).boot).toBeNull();
		await board.act("s1", "ensure");
		await settle();
		await settle();
		const view = await board.view("s1");
		expect(view.tracked).toBe(true);
		expect(view.project).toMatchObject({
			name: "demo_proj",
			keyId: "key-1",
			user: "demo_user",
			account: "demo_acct",
			// 首页工程卡片要写 ISV：来自工程配置，不等开机核对环境
			isv: "demox",
		});
		expect(view.boot?.phase).toBe("ready");
		expect(view.boot?.done).toBe(true);
		expect(view.boot?.steps.map((step) => [step.key, step.state])).toEqual([
			["open", "ok"],
			["resident", "ok"],
			["host", "skip"],
			["runtime", "ok"],
			["warm", "ok"],
			["check", "ok"],
		]);
		expect(view.boot?.steps.find((step) => step.key === "warm")?.seconds).toBe(1);
		expect(view.live).toMatchObject({ kind: "ready", pid: 4242, port: 41000, hotSwap: "jrebel", warmMs: 8000 });
		expect(view.live?.startedAt).toBe(Date.parse("2026-11-18T02:00:00.000Z"));
		// 再进一次不重来
		await board.act("s1", "ensure");
		await settle();
		expect(fake.calls.probe).toBe(1);
	});

	it("JVM 没在跑：内核先发一次探针连不上、再起 JVM、再发一次；起 JVM 的几步照实记用时，不记成跳过", async () => {
		const fake = fakeKernel({
			stages: ["checking-resident", "running-probe", "compiling-host", "starting-runtime", "warming-runtime"],
		});
		const board = new JvmBoard(fake.kernel, fake.now);
		board.track("s1", "D:/work/demo_proj");
		await board.act("s1", "ensure");
		await settle();
		await settle();
		const steps = (await board.view("s1")).boot?.steps ?? [];
		expect(steps.map((step) => [step.key, step.state, step.seconds])).toEqual([
			["open", "ok", 2],
			["resident", "ok", 2],
			["host", "ok", 2],
			["runtime", "ok", 2],
			["warm", "ok", 1],
			["check", "ok", 0.5],
		]);
	});

	it("正在起的时候能看到走到哪一步、已等多久", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const fake = fakeKernel({ gate });
		const board = new JvmBoard(fake.kernel, fake.now);
		board.track("s1", "D:/work/demo_proj");
		await board.act("s1", "ensure");
		await settle();
		const view = await board.view("s1");
		expect(view.boot?.done).toBe(false);
		expect(view.boot?.steps.find((step) => step.state === "run")?.key).toBe("warm");
		expect(view.boot?.seconds).toBe(6);
		expect((await board.act("s1", "start")).ok).toBe(false);
		release();
		await settle();
		await settle();
		expect((await board.view("s1")).boot?.phase).toBe("ready");
	});

	it("同一个工程两个会话共用一个 JVM：只起一次，两边看到的一样", async () => {
		const fake = fakeKernel();
		const board = new JvmBoard(fake.kernel, fake.now);
		board.track("s1", "D:/work/demo_proj");
		board.track("s2", "D:/work/demo_proj");
		await board.act("s1", "ensure");
		await settle();
		await board.act("s2", "ensure");
		await settle();
		await settle();
		expect(fake.calls.probe).toBe(1);
		const [one, two] = [await board.view("s1"), await board.view("s2")];
		expect(one.sharedWith).toBe(1);
		expect(two.sharedWith).toBe(1);
		expect(two.boot?.phase).toBe("ready");
	});

	it("工程没构建：不自动起（构建要几分钟），人点「启动」才起", async () => {
		const fake = fakeKernel({ built: false });
		const board = new JvmBoard(fake.kernel, fake.now);
		board.track("s1", "D:/work/demo_proj");
		await board.act("s1", "ensure");
		await settle();
		expect((await board.view("s1")).boot?.phase).toBe("not-built");
		expect(fake.calls.probe).toBe(0);
		await board.act("s1", "start");
		await settle();
		await settle();
		expect(fake.calls.probe).toBe(1);
		expect((await board.view("s1")).boot?.phase).toBe("ready");
	});

	it("不是苍穹工程、配置不全，各报各的，不起 JVM", async () => {
		for (const [code, phase] of [
			["PROJECT_ROOT_NOT_FOUND", "no-project"],
			["PROJECT_ROOT_INVALID", "no-project"],
			["CONFIG_INCOMPLETE", "config"],
		] as const) {
			const fake = fakeKernel({ openError: code });
			const board = new JvmBoard(fake.kernel, fake.now);
			board.track("s1", "D:/somewhere");
			await board.act("s1", "ensure");
			await settle();
			const view = await board.view("s1");
			expect(view.boot?.phase).toBe(phase);
			if (phase === "no-project")
				expect(view.boot?.detail).toBe("该目录不是 Gradle 工程（向上未找到 settings.gradle）：D:/somewhere");
			// 没起成：后面几步是没走到，不是用不着做
			expect(view.boot?.steps.slice(1).every((step) => step.state === "wait")).toBe(true);
			expect(view.project).toBeNull();
			expect(view.live).toBeNull();
			expect(fake.calls.probe).toBe(0);
		}
	});

	it("配置不全：报缺哪几项和文件夹名；向导填好后清掉那一趟，再 ensure 从认工程起重新走", async () => {
		const options: FakeOptions = { openError: "CONFIG_INCOMPLETE" };
		const fake = fakeKernel(options);
		const open = fake.kernel.open;
		fake.kernel.open = (async (...args: Parameters<typeof open>) => {
			const result = (await open(...args)) as { ok: boolean; error?: Record<string, unknown> };
			if (!result.ok && result.error) result.error.detail = { askUser: ["account", "user"], fromProject: [] };
			return result;
		}) as typeof open;
		const board = new JvmBoard(fake.kernel, fake.now);
		board.track("s1", "D:/work/demo_proj/");
		await board.act("s1", "ensure");
		await settle();
		let view = await board.view("s1");
		expect(view.folder).toBe("demo_proj");
		expect(view.boot).toMatchObject({ phase: "config", missing: ["account", "user"], done: true });
		// 没填完之前 ensure 不重来
		await board.act("s1", "ensure");
		await settle();
		expect(fake.calls.open).toBe(1);

		options.openError = undefined;
		board.configChanged();
		view = await board.view("s1");
		expect([view.project, view.boot]).toEqual([null, null]);
		await board.act("s1", "ensure");
		await settle();
		await settle();
		view = await board.view("s1");
		expect(fake.calls.open).toBe(2);
		expect(view.boot).toMatchObject({ phase: "ready", missing: [] });
		expect(view.project).toMatchObject({ name: "demo_proj", user: "demo_user", account: "demo_acct" });
	});

	it("没起成：照实报原因；再进会话不自动重来，人点「启动」才重来", async () => {
		const fake = fakeKernel({ probeError: "常驻 JVM 启动后立刻退出" });
		const board = new JvmBoard(fake.kernel, fake.now);
		board.track("s1", "D:/work/demo_proj");
		await board.act("s1", "ensure");
		await settle();
		await settle();
		const view = await board.view("s1");
		expect(view.boot).toMatchObject({ phase: "failed", detail: "常驻 JVM 启动后立刻退出" });
		expect(view.boot?.steps.find((step) => step.key === "check")?.state).toBe("fail");
		await board.act("s1", "ensure");
		await settle();
		expect(fake.calls.probe).toBe(1);
		await board.act("s1", "start");
		await settle();
		expect(fake.calls.probe).toBe(2);
	});

	it("起完以后在不在以现查的心跳为准：空闲退了就报没在跑，不拿开机结果冒充", async () => {
		const fake = fakeKernel();
		const board = new JvmBoard(fake.kernel, fake.now);
		board.track("s1", "D:/work/demo_proj");
		await board.act("s1", "ensure");
		await settle();
		await settle();
		fake.setHealth("stopped");
		const view = await board.view("s1");
		expect(view.boot?.phase).toBe("ready");
		expect(view.live).toMatchObject({ kind: "stopped", pid: null, startedAt: null, port: null });
	});

	it("点「启动」后还在认工程时，显示正在走的这一趟，不显示上一趟的结果", async () => {
		const fake = fakeKernel();
		const board = new JvmBoard(fake.kernel, fake.now);
		board.track("s1", "D:/work/demo_proj");
		await board.act("s1", "ensure");
		await settle();
		await settle();
		await board.act("s1", "stop");
		await board.act("s1", "start");
		const view = await board.view("s1");
		expect(view.boot?.done).toBe(false);
		expect(view.boot?.steps.find((step) => step.state === "run")?.key).toBe("open");
	});

	it("停止、重启走内核的停；重启后从头再走一趟", async () => {
		const fake = fakeKernel();
		const board = new JvmBoard(fake.kernel, fake.now);
		board.track("s1", "D:/work/demo_proj");
		await board.act("s1", "ensure");
		await settle();
		await settle();
		expect(await board.act("s1", "stop")).toEqual({ ok: true, text: "已停止" });
		expect((await board.act("s1", "restart")).ok).toBe(true);
		await settle();
		await settle();
		expect(fake.calls.stop).toBe(2);
		expect(fake.calls.probe).toBe(2);
		expect((await board.view("s1")).live?.kind).toBe("ready");
	});

	it("没登记的会话（别的预设的会话）不管：tracked=false，动作也拒", async () => {
		const fake = fakeKernel();
		const board = new JvmBoard(fake.kernel, fake.now);
		expect(await board.view("prod-1")).toMatchObject({ tracked: false, boot: null, live: null });
		expect((await board.act("prod-1", "ensure")).ok).toBe(false);
		expect(fake.calls.open).toBe(0);
	});

	it("换了工作目录：重新认工程", async () => {
		const fake = fakeKernel();
		const board = new JvmBoard(fake.kernel, fake.now);
		board.track("s1", "D:/work/demo_proj");
		await board.act("s1", "ensure");
		await settle();
		await settle();
		board.track("s1", "D:/work/demo_proj");
		expect((await board.view("s1")).project?.name).toBe("demo_proj");
		board.track("s1", "D:/work/demo_other");
		expect((await board.view("s1")).project).toBeNull();
		await board.act("s1", "ensure");
		await settle();
		expect(fake.calls.open).toBe(2);
		expect((await board.view("s1")).project?.name).toBe("demo_other");
	});
	it("停不了（认不准是不是它）就照实说没停，不写「已停」", async () => {
		const fake = fakeKernel({ stopHow: "unverified" });
		const board = new JvmBoard(fake.kernel, fake.now);
		board.track("s1", "D:/work/demo_proj");
		await board.act("s1", "ensure");
		await settle();
		await settle();
		const stopped = await board.act("s1", "stop");
		expect(stopped.ok).toBe(false);
		expect(stopped.text).toContain("未停止");
		expect((await board.act("s1", "restart")).ok).toBe(false);
		expect(fake.calls.probe).toBe(1);
	});
});

describe("环境诊断结果", () => {
	it("账套看不见、元数据为零：JVM 起来了也报环境有问题", () => {
		const verdict = envDiagVerdict({ exitCode: 0, json: { records: [{ ...GOOD_ENV, accounts: 0, meta_count: 0 }] } });
		expect(verdict).toMatchObject({ phase: "degraded", detail: "账套不可见、本 ISV 元数据为零" });
	});
	it("探针退出码不是 0、没有环境记录，都算没起成", () => {
		expect(envDiagVerdict({ exitCode: 2, json: { records: [] } }).phase).toBe("failed");
		expect(envDiagVerdict({ exitCode: 0, json: { records: [] } }).phase).toBe("failed");
	});
});

describe("请求路径", () => {
	const url = (query: string) => `http://local${JVM_BOARD_PATH}${query}`;
	const post = (body: unknown) => new Request(url(""), { method: "POST", body: JSON.stringify(body) });

	it("界面调的路径和宿主注册的一致", () => {
		const client = readFileSync(new URL("../../client/brand.js", import.meta.url), "utf8");
		expect(client).toContain(`"${JVM_BOARD_PATH.slice(1)}"`);
		expect(JVM_BOARD_PATH.startsWith("/api/")).toBe(true);
	});

	it("GET 看状态，POST 发动作；缺参数、动作不认识报 400", async () => {
		const fake = fakeKernel();
		const board = new JvmBoard(fake.kernel, fake.now);
		board.track("s1", "D:/work/demo_proj");
		expect((await handleJvmBoard(board, new Request(url("")))).status).toBe(400);
		expect((await handleJvmBoard(board, post({ session: "s1", action: "explode" }))).status).toBe(400);
		expect((await handleJvmBoard(board, post({ action: "stop-pid", pid: "x" }))).status).toBe(400);
		const ensured = await (await handleJvmBoard(board, post({ session: "s1", action: "ensure" }))).json();
		expect(ensured.result.ok).toBe(true);
		await settle();
		await settle();
		const view = await (await handleJvmBoard(board, new Request(url("?session=s1")))).json();
		expect(view.boot.phase).toBe("ready");
	});

	it("停本机别的进程：宿主看不了进程清单时照实说", async () => {
		const fake = fakeKernel();
		const board = new JvmBoard(fake.kernel, fake.now);
		const answer = await (await handleJvmBoard(board, post({ action: "stop-pid", pid: 1 }))).json();
		expect(answer.result).toEqual({ ok: false, text: "当前宿主无法读取本机进程" });
	});
});
