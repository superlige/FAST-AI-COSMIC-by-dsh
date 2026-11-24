/**
 * 安全门槛的回归测试：
 *   - 开发和查生产在同一个会话里：执行前不按模式拦；
 *   - 临时探针只准读：带 APPLY=1 在进内核前拒；
 *   - 终端和文件工具碰不到本机生产凭据（生产账号、monitor 登录、读取进程口令）；
 *   - 每个产品工具的参数都换成 dsh 认的 JSON Schema 子集。
 */
import { describe, expect, it } from "vitest";
import { COSMIC_TOOL_NAMES } from "../../src/agent/tools/names.ts";
import { type CosmicToolSpec, toDshSchema } from "../../src/dsh/define.ts";
import { mountedToolSpecs } from "../../src/dsh/fixed-text.ts";
import { type HookDeps, patchPaths, preExecute } from "../../src/dsh/hooks.ts";
import { type CallContext, CosmicHost } from "../../src/dsh/host.ts";
import type { CosmicKernel, ProjectHandle } from "../../src/dsh/kernel.ts";
import { CosmicToolFailure } from "../../src/dsh/result.ts";
import { CosmicSession } from "../../src/dsh/session.ts";
import { factsTool } from "../../src/dsh/tools/facts.ts";
import { knowledgeTool } from "../../src/dsh/tools/knowledge.ts";
import { metaTool } from "../../src/dsh/tools/meta.ts";
import { probeTool } from "../../src/dsh/tools/probe.ts";
import { prodTool } from "../../src/dsh/tools/prod.ts";
import { projectTools } from "../../src/dsh/tools/project.ts";
import { runTool } from "../../src/dsh/tools/run.ts";
import type { Confirm } from "../../src/dsh/write.ts";

const ROOT = "D:/demo/project";
const AGENT_DIR = "C:/Users/demo/.fast-ai-cosmic";

function deps(kernel: Partial<CosmicKernel> = {}): HookDeps {
	return {
		host: new CosmicHost(kernel as CosmicKernel),
		cwdOf: async () => ROOT,
		ungated: () => false,
		agentDir: AGENT_DIR,
	};
}

function exec(name: string, args: unknown) {
	return { name, arguments: args, signal: new AbortController().signal } as Parameters<typeof preExecute>[1];
}

async function decide(name: string, args: unknown) {
	return preExecute(deps(), exec(name, args));
}

describe("一个会话里开发和查生产都放行", () => {
	it("编译、真跑业务、写工程文件、生产查询在同一个会话里都放行", async () => {
		for (const [name, args] of [
			["cosmic_fast", {}],
			["cosmic_run", { argv: ["op", "demo_bill", "save"] }],
			["cosmic_prod", { action: "sql", sql: "select 1" }],
			["write", { file_path: `${ROOT}/src/Demo.java`, content: "x" }],
		] as [string, unknown][])
			expect(await decide(name, args), name).toEqual({ kind: "allow" });
	});

	it(".cosmic-ai 里只准写草稿、临时探针、会话目录：工具自己写的地方在执行前拒，说清该写哪", async () => {
		for (const file of [".cosmic-ai/scratch/check.py", ".cosmic-ai/probes/OneOff.java"])
			expect(await decide("write", { file_path: `${ROOT}/${file}`, content: "x" }), file).toEqual({ kind: "allow" });
		for (const [name, args] of [
			["write", { file_path: `${ROOT}/.cosmic-ai/work/Foo.javap.txt`, content: "x" }],
			["edit", { file_path: `${ROOT}/.cosmic-ai/evidence/backups/x/a.xml`, old_string: "a", new_string: "b" }],
			["apply_patch", { input: "*** Begin Patch\n*** Add File: .cosmic-ai/backup/a.xml\n+x\n*** End Patch" }],
		] as [string, unknown][]) {
			const decision = await decide(name, args);
			expect(decision.kind, name).toBe("deny");
			if (decision.kind === "deny") {
				expect(decision.info.code).toBe("COSMIC_DIR_NOT_WRITABLE");
				expect(decision.reason).toContain(".cosmic-ai/scratch/");
			}
		}
	});

	it("产品工具每个会话都全部挂上，cosmic_prod 也在", () => {
		const names = mountedToolSpecs().map((spec) => spec.name);
		expect(names).toEqual(expect.arrayContaining([...COSMIC_TOOL_NAMES]));
		expect(names).toHaveLength(COSMIC_TOOL_NAMES.length);
	});

	it("apply_patch 里动到的路径都认得出", () => {
		const patch = [
			"*** Begin Patch",
			"*** Add File: .cosmic-ai/notes.md",
			"+x",
			"*** Update File: src/Demo.java",
			"*** End Patch",
		].join("\n");
		expect(patchPaths(patch)).toEqual([".cosmic-ai/notes.md", "src/Demo.java"]);
	});
});

describe("终端和文件工具碰不到生产凭据", () => {
	async function refused(name: string, args: unknown) {
		const decision = await decide(name, args);
		return decision.kind === "deny" && decision.info.code === "PROD_SECRET_OFF_LIMITS";
	}

	it("读、写、搜生产配置、monitor 登录、读取进程状态，都在执行前拒，说清该走哪条路", async () => {
		for (const [name, args] of [
			["read", { file_path: `${AGENT_DIR}/prod/prod.json` }],
			["read", { file_path: "C:\\Users\\demo\\.FAST-AI-COSMIC\\prod\\prod.monitor-session.json" }],
			["read", { file_path: "/c/Users/demo/.fast-ai-cosmic/cache/rk1/prod/state.json" }],
			["edit", { file_path: `${AGENT_DIR}/prod/prod.json`, old_string: "a", new_string: "b" }],
			["write", { file_path: `${AGENT_DIR}/prod/prod.json`, content: "{}" }],
			["apply_patch", { input: `*** Begin Patch\n*** Update File: ${AGENT_DIR}/prod/prod.json\n*** End Patch` }],
			["grep", { pattern: "password", path: `${AGENT_DIR}/prod` }],
			["grep", { pattern: "password", path: AGENT_DIR }],
			["glob", { pattern: `${AGENT_DIR}/**/*.json` }],
			["bash", { command: "cat ~/.fast-ai-cosmic/prod/prod.json", description: "x" }],
			["bash", { command: "cd $HOME/.fast-ai-cosmic && type prod\\prod.json", description: "x" }],
			["bash", { command: "Get-Content prod.monitor-session.json", description: "x" }],
			["bash", { command: "java -cp tools ProdReader", description: "x" }],
			["bash", { command: "ls", workdir: `${AGENT_DIR}/prod`, description: "x" }],
		] as [string, unknown][])
			expect(await refused(name, args), `${name} ${JSON.stringify(args)}`).toBe(true);
		const decision = await decide("read", { file_path: `${AGENT_DIR}/prod/prod.json` });
		if (decision.kind === "deny") expect(decision.reason).toContain("cosmic_prod");
	});

	it("同目录下别的东西照常：探针日志、全局配置、工程里叫 prod 的文件", async () => {
		for (const [name, args] of [
			["read", { file_path: `${AGENT_DIR}/cache/rk1/probe-server.log` }],
			["grep", { pattern: "Exception", path: `${AGENT_DIR}/cache/rk1/probe-runs` }],
			["read", { file_path: `${AGENT_DIR}/config.json` }],
			["read", { file_path: `${ROOT}/src/prod/DemoProdPlugin.java` }],
			["grep", { pattern: "prod", path: ROOT }],
			["bash", { command: "tail -50 ~/.fast-ai-cosmic/cache/rk1/probe-server.log", description: "x" }],
			["bash", { command: "git log --oneline -- src/prod", description: "x" }],
			["cosmic_prod", { action: "sql", sql: "select 1" }],
		] as [string, unknown][])
			expect(await refused(name, args), `${name} ${JSON.stringify(args)}`).toBe(false);
	});
});

describe("临时探针只准读", () => {
	it("开发会话里临时探针带 APPLY=1：在跑之前拒，内核的 probe 一次都没叫", async () => {
		let probeCalls = 0;
		const kernel = {
			open: async () => ({ ok: true, value: { handle: {}, summary: { root: ROOT, runtimeKeyId: "rk1" } } }),
			prepareProbe: async () => ({
				ok: true,
				value: {
					plan: { target: { cls: "OneOff", adHoc: true }, overlay: { APPLY: "1" }, api: null },
					blockers: [],
					capsules: [],
				},
			}),
			probe: async () => {
				probeCalls += 1;
				return { ok: false };
			},
		} as unknown as CosmicKernel;
		const host = new CosmicHost(kernel);
		const call: CallContext = {
			tool: "cosmic_probe",
			session: new CosmicSession<ProjectHandle>(),
			agent: undefined,
			signal: new AbortController().signal,
			startedAt: new Date().toISOString(),
			cwd: async () => ROOT,
		};
		const confirm: Confirm = async () => ({ kind: "approved" });
		const tool = probeTool(host, confirm);
		let caught: unknown;
		try {
			await tool.execute({ name: ".cosmic-ai/probes/OneOff.java", env: { APPLY: "1" } }, call);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(CosmicToolFailure);
		expect((caught as CosmicToolFailure).code).toBe("COSMIC_WRITE_AUTHORIZATION");
		expect(probeCalls).toBe(0);
	});
});

describe("产品工具的参数换成 dsh 认的 JSON Schema 子集", () => {
	const ALLOWED = new Set([
		"type",
		"oneOf",
		"properties",
		"required",
		"additionalProperties",
		"items",
		"enum",
		"const",
		"description",
		"title",
		"default",
		"examples",
	]);

	function violations(node: unknown, path: string): string[] {
		if (typeof node !== "object" || node === null) return [];
		const record = node as Record<string, unknown>;
		const found: string[] = [];
		for (const key of Object.keys(record)) if (!ALLOWED.has(key)) found.push(`${path}.${key}`);
		if (Array.isArray(record.type)) found.push(`${path}.type 是数组`);
		if (record.type !== undefined && record.oneOf !== undefined) found.push(`${path} type 和 oneOf 并存`);
		if (record.additionalProperties !== undefined && typeof record.additionalProperties !== "boolean")
			found.push(`${path}.additionalProperties 不是布尔`);
		for (const [name, child] of Object.entries((record.properties ?? {}) as Record<string, unknown>))
			found.push(...violations(child, `${path}.${name}`));
		if (record.items !== undefined) found.push(...violations(record.items, `${path}[]`));
		for (const [index, member] of ((record.oneOf ?? []) as unknown[]).entries())
			found.push(...violations(member, `${path}|${String(index)}`));
		return found;
	}

	it("12 个工具一个不缺，每个换完都只剩允许的关键字", () => {
		const host = new CosmicHost({} as CosmicKernel);
		const confirm: Confirm = async () => ({ kind: "approved" });
		const specs = [
			...projectTools(host),
			knowledgeTool(host),
			probeTool(host, confirm),
			runTool(host),
			metaTool(host, confirm),
			factsTool(),
			prodTool(host),
		] as unknown as CosmicToolSpec[];
		expect(specs.map((spec) => spec.name).sort()).toEqual([...COSMIC_TOOL_NAMES].sort());
		for (const spec of specs) expect(violations(toDshSchema(spec.parameters), spec.name)).toEqual([]);
	});
});
