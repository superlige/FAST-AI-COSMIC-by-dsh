/**
 * 工程配置向导（/cosmic-env 里，以及工具第一次要打开工程时配置不全）：缺什么问什么、填错重问、
 * 按手机号选用户、不确认不写；工具调用里自己弹，人不填就本会话不再弹，补救改成请用户敲 /cosmic-env。
 */
import { describe, expect, it } from "vitest";
import { type CallContext, CosmicHost } from "../../src/dsh/host.ts";
import type { CosmicKernel, ProjectHandle } from "../../src/dsh/kernel.ts";
import { CosmicToolFailure } from "../../src/dsh/result.ts";
import { CosmicSession } from "../../src/dsh/session.ts";
import { type Ask, configureProject } from "../../src/dsh/setup.ts";
import type { DoctorReport } from "../../src/kernel/commands/doctor.ts";
import type { ProjectConfigAnswers } from "../../src/kernel/config/initialize.ts";
import { KernelError } from "../../src/kernel/errors.ts";

const ROOT = "D:/demo/project";

function report(missing: string[]): DoctorReport {
	return {
		projectRoot: ROOT,
		projectConfigFile: `${ROOT}/.cosmic-ai/config.json`,
		parseError: null,
		parseErrorFile: null,
		modules: { declared: ["demo-biz", "demo-debug"], codeModules: [], unresolvedDeps: [] },
		missingRequired: missing.map((field) => ({ field, why: "" })),
		ok: missing.length === 0,
		nextActions: [],
	} as unknown as DoctorReport;
}

function fakeKernel(missing: string[]) {
	const written: ProjectConfigAnswers[] = [];
	const lookups: string[] = [];
	let current = missing;
	const kernel = {
		discover: async () => ({ ok: true as const, value: { root: ROOT, source: "cwd" as const } }),
		doctor: async () => ({ ok: true as const, value: report(current) }),
		initializeConfig: async (_root: string, answers: ProjectConfigAnswers) => {
			written.push(answers);
			current = [];
			return {
				ok: true as const,
				value: {
					file: `${ROOT}/.cosmic-ai/config.json`,
					gitignoreFile: "",
					created: true,
					changed: true,
					writtenFields: Object.keys(answers),
				},
			};
		},
		lookupUsers: async (_root: string, keyword: string) => {
			lookups.push(keyword);
			return {
				ok: true as const,
				value: {
					keyword,
					candidates: [{ id: "1001", number: "E01", username: "zhang", name: "张三", phoneMask: "138****0000" }],
					truncated: false,
					outputFile: "",
				},
			};
		},
	};
	return { kernel: kernel as unknown as Parameters<typeof configureProject>[0], written, lookups };
}

/** 按顺序回答文字题；选择题选第一项；确认单按 approve 回答。 */
function scripted(texts: string[], approve = true) {
	const asked: string[] = [];
	const ask: Ask = {
		async text(question) {
			asked.push(question);
			return texts.shift();
		},
		async choose(question, _detail, options) {
			asked.push(question);
			return options[0];
		},
		async approve(question) {
			asked.push(question);
			return approve;
		},
	};
	return { ask, asked };
}

describe("工程配置向导", () => {
	it("配置本来就齐：直接 ready，一句也不问", async () => {
		const { kernel } = fakeKernel([]);
		const { ask, asked } = scripted([]);
		expect(await configureProject(kernel, ask, ROOT)).toMatchObject({ kind: "ready", root: ROOT, text: "" });
		expect(asked).toEqual([]);
	});

	it("缺的逐项问；填错的重问一次；用户放最后、按手机号查出来选；确认后写", async () => {
		const { kernel, written, lookups } = fakeKernel(["user", "isv", "codeModules"]);
		const { ask, asked } = scripted(["Demo!", "demo", "':demo-biz', demo-biz", "13800000000"]);
		const outcome = await configureProject(kernel, ask, ROOT);
		expect(outcome.kind).toBe("ready");
		expect(asked).toEqual([
			"工程配置 · ISV 标识",
			"工程配置 · ISV 标识",
			"工程配置 · 代码模块",
			"工程配置 · 用户",
			"工程配置 · 选一个用户",
			"写入工程配置？",
		]);
		expect(lookups).toEqual(["13800000000"]);
		expect(written).toEqual([{ isv: "demo", codeModules: ["demo-biz"], user: "1001" }]);
	});

	it("id:1234567 直接当用户 id，不连环境查", async () => {
		const { kernel, written, lookups } = fakeKernel(["user"]);
		const { ask } = scripted(["id:1234567"]);
		await configureProject(kernel, ask, ROOT);
		expect(lookups).toEqual([]);
		expect(written).toEqual([{ user: "1234567" }]);
	});

	it("不确认就不写；中途不填就停，说清停在哪", async () => {
		const declined = fakeKernel(["isv"]);
		expect(await configureProject(declined.kernel, scripted(["demo"], false).ask, ROOT)).toEqual({
			kind: "stopped",
			text: "没确认，工程配置没写。",
		});
		expect(declined.written).toEqual([]);

		const quit = fakeKernel(["isv", "account"]);
		const outcome = await configureProject(quit.kernel, scripted(["demo", ""]).ask, ROOT);
		expect(outcome).toEqual({ kind: "stopped", text: "工程配置没填完（停在「账套」），没写。" });
		expect(quit.written).toEqual([]);
	});

	it("同一项连错三次就停，不无限问", async () => {
		const { kernel, written } = fakeKernel(["isv"]);
		const { ask, asked } = scripted(["A!", "B!", "C!", "demo"]);
		expect((await configureProject(kernel, ask, ROOT)).kind).toBe("stopped");
		expect(asked).toHaveLength(3);
		expect(written).toEqual([]);
	});
});

describe("工具第一次要打开工程、配置不全：在这次调用里弹工程配置向导", () => {
	function hostWith(missing: string[]) {
		const fake = fakeKernel(missing);
		let opens = 0;
		const kernel = {
			...fake.kernel,
			open: async () => {
				opens++;
				const doctor = await fake.kernel.doctor(ROOT);
				if (doctor.ok && !doctor.value.ok)
					return {
						ok: false,
						error: new KernelError("CONFIG_INCOMPLETE", "配置不全，缺 1 项：isv", { remedy: "补在 config.json" }),
					};
				return { ok: true, value: { handle: {}, summary: { root: ROOT, runtimeKeyId: "rk1" } } };
			},
		} as unknown as CosmicKernel;
		const host = new CosmicHost("dev", kernel);
		const call = (): CallContext => ({
			tool: "cosmic_probe",
			session,
			agent: undefined,
			signal: new AbortController().signal,
			startedAt: new Date().toISOString(),
			cwd: async () => ROOT,
		});
		const session = new CosmicSession<ProjectHandle>();
		return { host, call, written: fake.written, opens: () => opens };
	}

	it("填好就接着打开，这次调用照常往下走；并行的调用只弹一个", async () => {
		const { host, call, written } = hostWith(["isv"]);
		const { ask, asked } = scripted(["demo"]);
		host.askInCall = () => ask;
		const [a, b] = await Promise.all([host.project(call(), {}), host.project(call(), {})]);
		expect(a.root).toBe(ROOT);
		expect(b.root).toBe(ROOT);
		expect(written).toEqual([{ isv: "demo" }]);
		expect(asked.filter((q) => q === "工程配置 · ISV 标识")).toHaveLength(1);
	});

	it("人不填：照实报配置不全、请用户敲 /cosmic-env；本会话不再弹", async () => {
		const { host, call, written } = hostWith(["isv"]);
		const { ask, asked } = scripted([""]);
		host.askInCall = () => ask;
		const failure = await host.project(call(), {}).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(CosmicToolFailure);
		expect(String((failure as Error).message)).toContain("/cosmic-env");
		await host.project(call(), {}).catch(() => undefined);
		expect(asked).toHaveLength(1);
		expect(written).toEqual([]);
	});

	it("没有提问服务（无头运行）：不弹，原样报内核的错", async () => {
		const { host, call } = hostWith(["isv"]);
		host.askInCall = () => undefined;
		const failure = await host.project(call(), {}).catch((error: unknown) => error);
		expect(String((failure as Error).message)).toContain("补在 config.json");
		expect(String((failure as Error).message)).not.toContain("/cosmic-env");
	});
});
