/**
 * 安全门槛的回归测试：
 *   - 生产排障会话：改东西的产品调用、写工程文件（write / edit / apply_patch）在执行前拒；`.cosmic-ai/` 下放行；
 *   - 临时探针只准读：带 APPLY=1 在进内核前拒；
 *   - 每个产品工具的参数都换成 dsh 认的 JSON Schema 子集。
 */
import { describe, expect, it } from "vitest";
import { toolsForMode } from "../../src/agent/state/prod-state.ts";
import { COSMIC_TOOL_NAMES } from "../../src/agent/tools/names.ts";
import { type CosmicToolSpec, toDshSchema } from "../../src/dsh/define.ts";
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

function deps(mode: "dev" | "prod", kernel: Partial<CosmicKernel> = {}): HookDeps {
	return {
		host: new CosmicHost(mode, kernel as CosmicKernel),
		cwdOf: async () => ROOT,
		ungated: () => false,
	};
}

function exec(name: string, args: unknown) {
	return { name, arguments: args, signal: new AbortController().signal } as Parameters<typeof preExecute>[1];
}

async function decide(mode: "dev" | "prod", name: string, args: unknown) {
	return preExecute(deps(mode), exec(name, args));
}

describe("生产排障会话的执行前门槛", () => {
	it("编译、真跑业务、部署、写元数据、造改数据、APPLY 一律拒，理由里带错误码", async () => {
		const refused: [string, unknown][] = [
			["cosmic_fast", {}],
			["cosmic_run", { argv: ["op", "demo_bill", "save"] }],
			["cosmic_runtime", { action: "deploy" }],
			["cosmic_meta", { argv: ["botp", "restore", "D:/x"], apply: true }],
			["cosmic_probe", { name: "DataSeedProbe", env: { SEED_ENTITY: "demo_bill" } }],
			["cosmic_probe", { name: "MetaProbe", env: { APPLY: "1" } }],
			["cosmic_probe", { name: ".cosmic-ai/probes/OneOff.java", env: { APPLY: "1" } }],
		];
		for (const [name, args] of refused) {
			const decision = await decide("prod", name, args);
			expect(decision, `${name} ${JSON.stringify(args)}`).toMatchObject({ kind: "deny" });
			if (decision.kind === "deny") expect(decision.reason).toMatch(/^\[PROD_MODE_READ_ONLY\]/);
		}
	});

	it("只读的照常放行：查元数据、造数预演、生产查询", async () => {
		for (const [name, args] of [
			["cosmic_probe", { name: "MetaProbe", env: { META_ENTITY: "demo_bill" } }],
			["cosmic_probe", { name: "DataSeedProbe", env: { SEED_ENTITY: "demo_bill", PREVIEW: "1" } }],
			["cosmic_meta", { argv: ["botp", "list"] }],
			["cosmic_prod", { action: "sql", sql: "select 1" }],
		] as [string, unknown][])
			expect(await decide("prod", name, args), name).toEqual({ kind: "allow" });
	});

	it("写工程文件拒，写 .cosmic-ai/ 下放行；apply_patch 里只要有一个路径在工程里就拒", async () => {
		expect(await decide("prod", "write", { file_path: `${ROOT}/src/Demo.java`, content: "x" })).toMatchObject({
			kind: "deny",
		});
		expect(await decide("prod", "edit", { file_path: "src/Demo.java" })).toMatchObject({ kind: "deny" });
		expect(await decide("prod", "write", { file_path: `${ROOT}/cosmic-gate-test.txt`, content: "x" })).toMatchObject({
			kind: "deny",
		});
		expect(await decide("prod", "write", { file_path: `${ROOT}/.cosmic-ai/probes/One.java`, content: "x" })).toEqual({
			kind: "allow",
		});
		const patch = [
			"*** Begin Patch",
			"*** Add File: .cosmic-ai/notes.md",
			"+x",
			"*** Update File: src/Demo.java",
			"*** End Patch",
		].join("\n");
		expect(patchPaths(patch)).toEqual([".cosmic-ai/notes.md", "src/Demo.java"]);
		expect(await decide("prod", "apply_patch", { input: patch })).toMatchObject({ kind: "deny" });
	});

	it("开发会话不拦这些", async () => {
		expect(await decide("dev", "cosmic_run", { argv: ["op", "demo_bill", "save"] })).toEqual({ kind: "allow" });
		expect(await decide("dev", "write", { file_path: `${ROOT}/README.txt`, content: "x" })).toEqual({
			kind: "allow",
		});
	});

	it("排障会话不挂编译和真跑业务的工具，开发会话不挂 cosmic_prod", () => {
		expect(toolsForMode("prod", COSMIC_TOOL_NAMES)).not.toContain("cosmic_fast");
		expect(toolsForMode("prod", COSMIC_TOOL_NAMES)).not.toContain("cosmic_run");
		expect(toolsForMode("prod", COSMIC_TOOL_NAMES)).toContain("cosmic_prod");
		expect(toolsForMode("dev", COSMIC_TOOL_NAMES)).not.toContain("cosmic_prod");
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
		const host = new CosmicHost("dev", kernel);
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
		const host = new CosmicHost("dev", {} as CosmicKernel);
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
