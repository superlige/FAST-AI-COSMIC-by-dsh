/**
 * S5.1 command-map invariants. The map is what turns an old-CLI command into a
 * tool call, so drift has to fail a run instead of misleading the model:
 *
 *   1. every command word in the frozen CLI dispatch is registered;
 *   2. nothing claims "migrated" without a tool that is actually registered;
 *   3. the plugin-route table points only at probes that were released and at
 *      reference documents that were generated -- the frozen knowledge.test.mjs
 *      checked the same two things against the source tree.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COSMIC_TOOL_NAMES } from "../../src/agent/tools/names.ts";
import { KNOWLEDGE_GUIDES, PLUGIN_ROUTES } from "../../src/knowledge/catalog.ts";
import { COMMAND_MAP, commandMapping, rewriteInvocation } from "../../src/knowledge/command-map.ts";
import { EMBEDDED_RESOURCES } from "../../src/resources/embedded.generated.ts";

/**
 * The frozen `driver.mjs` dispatch, transcribed from
 * long-cosmic-dev@c7b8815 driver.mjs:2485-2527. Transcribed rather than parsed:
 * the frozen repository is a read-only migration input and the test must run
 * without it.
 */
const FROZEN_COMMANDS = [
	"build",
	"fast",
	"lint",
	"probe",
	"run",
	"verify",
	"probe-server",
	"pserver",
	"sig",
	"findclass",
	"start",
	"status",
	"logs",
	"stop",
	"deploy",
	"doctor",
	"knowledge",
	"impact",
	"meta",
	"doc",
	"plugin",
	"spec",
	"bundle",
] as const;

describe("command map", () => {
	it("覆盖冻结命令面的每一个命令，且不多不少", () => {
		expect([...COMMAND_MAP].map((entry) => entry.command).sort()).toEqual([...FROZEN_COMMANDS].sort());
	});

	it("标成已迁移的命令必须有真实注册的工具", () => {
		for (const entry of COMMAND_MAP) {
			if (entry.status !== "migrated") {
				expect(entry.tool).toBeNull();
				continue;
			}
			expect(entry.tool).not.toBeNull();
			expect(COSMIC_TOOL_NAMES).toContain(entry.tool);
		}
	});

	it("改写只在已迁移时给工具名，其余保留旧命令并明说未迁移", () => {
		expect(rewriteInvocation("probe", "EnvDiagProbe")).toContain("cosmic_probe");
		expect(rewriteInvocation("run", "form <布局>")).toContain("cosmic_run");
		expect(rewriteInvocation("impact", "build")).toContain("cosmic_impact");
		expect(rewriteInvocation("meta", "botp list")).toContain("cosmic_meta");
		// S11 merged the node into `cosmic_runtime`, so the rewrite has to carry the
		// action too -- a bare tool name is no longer a callable instruction for the
		// commands whose tool now serves three processes.
		expect(rewriteInvocation("logs", "80")).toContain("cosmic_runtime action=node-logs");
		expect(rewriteInvocation("doc", "list")).toContain("已不适用");
		// S5.4 emptied the "pending" bucket. The unmigrated wording is still the
		// shape the generator produces, and an unregistered command still gets it --
		// so the branch stays covered without pinning a command that has moved on.
		expect(rewriteInvocation("frobnicate", "x")).toContain("未登记的命令");
	});
});

describe("plugin routes", () => {
	const releasedProbes = new Set(
		EMBEDDED_RESOURCES.filter(
			(resource) => resource.relativePath.startsWith("probes/") && resource.relativePath.endsWith(".java"),
		).map((resource) => resource.relativePath.slice("probes/".length).replace(/\.java$/, "")),
	);
	const referenceDocs = new Set(
		(
			JSON.parse(readFileSync(new URL("../../knowledge/reference-manifest.json", import.meta.url), "utf8")) as {
				skills: { doc: string }[];
			}
		).skills.map((skill) => `${skill.doc}.md`),
	);

	it("绑定确认列只指向真实发布的探针", () => {
		for (const route of PLUGIN_ROUTES) {
			if (route.bind === null) continue;
			expect(releasedProbes, `${route.base} 指向不存在的探针 ${route.bind}`).toContain(route.bind);
		}
	});

	it("本地差量页只指向真实生成的 reference skill", () => {
		for (const route of PLUGIN_ROUTES) {
			expect(referenceDocs, `${route.base} 指向不存在的 reference 篇 ${route.local}`).toContain(route.local);
		}
	});

	it("官方指南列都在 GUIDES 表里", () => {
		const declared = new Set(KNOWLEDGE_GUIDES.map(([path]) => path));
		for (const route of PLUGIN_ROUTES) expect(declared).toContain(route.guide);
	});

	it("行为验证里引用的命令都在命令映射表里登记过", () => {
		for (const route of PLUGIN_ROUTES) {
			if (route.verify?.kind !== "cli") continue;
			expect(commandMapping(route.verify.command), `${route.verify.command} 未登记`).not.toBeNull();
		}
	});
});
