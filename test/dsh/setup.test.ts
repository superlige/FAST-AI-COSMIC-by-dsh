/**
 * 工程配置向导（/cosmic-env 里，以及工具第一次要打开工程时配置不全）：只问账套和用户——
 * 账套从环境列出来的名单里选、用户按手机号查出来选，选完直接写、不再弹确认单；
 * 工程文件里认得出来的项（启动类、模块……）缺了不问人，交给模型；
 * 工具调用里自己弹，人不填就本会话不再弹，补救改成请用户敲 /cosmic-env。
 */
import { describe, expect, it } from "vitest";
import { type CallContext, CosmicHost } from "../../src/dsh/host.ts";
import type { CosmicKernel, ProjectHandle } from "../../src/dsh/kernel.ts";
import { CosmicToolFailure } from "../../src/dsh/result.ts";
import { CosmicSession } from "../../src/dsh/session.ts";
import { type Ask, configureProject, onProjectConfigured } from "../../src/dsh/setup.ts";
import type { DoctorReport } from "../../src/kernel/commands/doctor.ts";
import type { ProjectConfigAnswers } from "../../src/kernel/config/initialize.ts";
import { USER_ANSWERED_FIELDS } from "../../src/kernel/config/load-config.ts";
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

const ACCOUNTS = [
	{ id: "1700000000000000001", number: "demo_dev", name: "开发账套" },
	{ id: "1700000000000000002", number: "demo_uat", name: "测试账套" },
];

function fakeKernel(missing: string[], accounts = ACCOUNTS) {
	const written: ProjectConfigAnswers[] = [];
	const lookups: string[] = [];
	const userLookupAccounts: (string | undefined)[] = [];
	let accountLookups = 0;
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
		lookupAccounts: async () => {
			accountLookups++;
			return { ok: true as const, value: { candidates: accounts, outputFile: "D:/out.txt" } };
		},
		lookupUsers: async (_root: string, keyword: string, pending: { account?: string }) => {
			lookups.push(keyword);
			userLookupAccounts.push(pending.account);
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
	return {
		kernel: kernel as unknown as Parameters<typeof configureProject>[0],
		written,
		lookups,
		userLookupAccounts,
		accountLookups: () => accountLookups,
	};
}

/** 按顺序回答文字题；选择题按 picks 选（不给就选第一项）；确认单按 approve 回答。 */
function scripted(texts: string[], picks: number[] = []) {
	const asked: string[] = [];
	const ask: Ask = {
		async text(question) {
			asked.push(question);
			return texts.shift();
		},
		async choose(question, _detail, options) {
			asked.push(question);
			return options[picks.shift() ?? 0];
		},
		async approve(question) {
			asked.push(question);
			return true;
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

	it("配置齐了才通知（JVM 状态板据此重新走一趟）；中途不填不通知", async () => {
		const heard: string[] = [];
		const stop = onProjectConfigured((root) => heard.push(root));
		try {
			await configureProject(fakeKernel(["account", "user"]).kernel, scripted([""], [0]).ask, ROOT);
			expect(heard).toEqual([]);
			await configureProject(fakeKernel(["account", "user"]).kernel, scripted(["13800000000"], [1, 0]).ask, ROOT);
			expect(heard).toEqual([ROOT]);
		} finally {
			stop();
		}
	});

	it("只有账套和用户是问人的", () => {
		expect([...USER_ANSWERED_FIELDS].sort()).toEqual(["account", "user"]);
	});

	it("账套从环境列出来的名单里选、写编码；用户按手机号查出来选，查的时候带上刚选的账套；选完直接写，不弹确认单", async () => {
		const { kernel, written, lookups, userLookupAccounts } = fakeKernel(["account", "user"]);
		const { ask, asked } = scripted(["13800000000"], [1, 0]);
		const outcome = await configureProject(kernel, ask, ROOT);
		expect(outcome.kind).toBe("ready");
		expect(asked).toEqual(["工程配置 · 选择账套（数据中心）", "工程配置 · 用户", "工程配置 · 选择用户"]);
		expect(lookups).toEqual(["13800000000"]);
		expect(userLookupAccounts).toEqual(["demo_uat"]);
		expect(written).toEqual([{ account: "demo_uat", user: "1001" }]);
		if (outcome.kind === "ready") expect(outcome.text).toContain("测试账套");
	});

	it("列不出账套：说清为什么，改成让人敲编码", async () => {
		const { kernel, written } = fakeKernel(["account"], []);
		const { ask, asked } = scripted(["demo_dev"]);
		expect((await configureProject(kernel, ask, ROOT)).kind).toBe("ready");
		expect(asked).toEqual(["工程配置 · 账套（数据中心）"]);
		expect(written).toEqual([{ account: "demo_dev" }]);
	});

	it("名单里没有要的：选「手工输入」再敲", async () => {
		const { kernel, written } = fakeKernel(["account"]);
		const { ask } = scripted(["demo_other"], [ACCOUNTS.length]);
		await configureProject(kernel, ask, ROOT);
		expect(written).toEqual([{ account: "demo_other" }]);
	});

	it("id:1234567 直接当用户 id，不连环境查", async () => {
		const { kernel, written, lookups } = fakeKernel(["user"]);
		const { ask } = scripted(["id:1234567"]);
		await configureProject(kernel, ask, ROOT);
		expect(lookups).toEqual([]);
		expect(written).toEqual([{ user: "1234567" }]);
	});

	it("工程文件里认得出的项缺了：不问人、不起 JVM 列账套，说清交给模型补", async () => {
		const { kernel, written, accountLookups } = fakeKernel(["appClass", "account", "user"]);
		const { ask, asked } = scripted([]);
		const outcome = await configureProject(kernel, ask, ROOT);
		expect(outcome.kind).toBe("stopped");
		if (outcome.kind === "stopped") {
			expect(outcome.text).toContain("appClass");
			expect(outcome.text).toContain("cosmic_doctor action=config");
		}
		expect(asked).toEqual([]);
		expect(accountLookups()).toBe(0);
		expect(written).toEqual([]);
	});

	it("中途不填就停，说清停在哪，什么都不写", async () => {
		const quit = fakeKernel(["account", "user"]);
		const outcome = await configureProject(quit.kernel, scripted([""], [0]).ask, ROOT);
		expect(outcome).toEqual({ kind: "stopped", text: "工程配置未完成（停在「用户」），未写入。" });
		expect(quit.written).toEqual([]);
	});

	it("账套留空就停，只问一次、什么都不写", async () => {
		const { kernel, written } = fakeKernel(["account"], []);
		const { ask, asked } = scripted([" ", "demo_dev"]);
		expect((await configureProject(kernel, ask, ROOT)).kind).toBe("stopped");
		expect(asked).toHaveLength(1);
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
				if (doctor.ok && !doctor.value.ok) {
					const fields = doctor.value.missingRequired.map((item) => item.field);
					return {
						ok: false,
						error: new KernelError("CONFIG_INCOMPLETE", `配置不全，缺 ${String(fields.length)} 项`, {
							detail: {
								fromProject: fields.filter((field) => !USER_ANSWERED_FIELDS.includes(field)),
								askUser: fields.filter((field) => USER_ANSWERED_FIELDS.includes(field)),
							},
							remedy: "用 cosmic_doctor action=config 写进工程配置",
						}),
					};
				}
				return { ok: true, value: { handle: {}, summary: { root: ROOT, runtimeKeyId: "rk1" } } };
			},
		} as unknown as CosmicKernel;
		const host = new CosmicHost(kernel);
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

	it("只缺账套：选好就接着打开，这次调用照常往下走；并行的调用只弹一个", async () => {
		const { host, call, written } = hostWith(["account"]);
		const { ask, asked } = scripted([]);
		host.askInCall = () => ask;
		const [a, b] = await Promise.all([host.project(call(), {}), host.project(call(), {})]);
		expect(a.root).toBe(ROOT);
		expect(b.root).toBe(ROOT);
		expect(written).toEqual([{ account: "demo_dev" }]);
		expect(asked.filter((q) => q === "工程配置 · 选择账套（数据中心）")).toHaveLength(1);
	});

	it("缺的是工程里认得出的项：一个框都不弹，内核的报错（叫模型自己补）原样交回", async () => {
		const { host, call } = hostWith(["debugModule", "user"]);
		const { ask, asked } = scripted([]);
		host.askInCall = () => ask;
		const failure = await host.project(call(), {}).catch((error: unknown) => error);
		expect(String((failure as Error).message)).toContain("cosmic_doctor action=config");
		expect(asked).toEqual([]);
	});

	it("人不填：照实报配置不全、请用户敲 /cosmic-env；本会话不再弹", async () => {
		const { host, call, written } = hostWith(["user"]);
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
		const { host, call } = hostWith(["user"]);
		host.askInCall = () => undefined;
		const failure = await host.project(call(), {}).catch((error: unknown) => error);
		expect(String((failure as Error).message)).toContain("cosmic_doctor action=config");
		expect(String((failure as Error).message)).not.toContain("/cosmic-env");
	});
});
