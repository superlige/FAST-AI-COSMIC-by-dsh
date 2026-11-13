/**
 * S45 批 2：`search` 按块返回、`show` 取一节、查询词点到工具名和探针名。
 *
 * 守的是模型照着走会走错的地方：结果里给的 show 写法取不回同一块、本地资料读不到、
 * 只问工具名时被切一段随便的正文、本工程标识被当成知识库里的词去凑结果。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COSMIC_TOOL_NAMES } from "../../src/agent/tools/names.ts";
import { extractProse } from "../../src/agent/tools/prose-blocks.ts";
import { knowledgeSearch, knowledgeShow } from "../../src/kernel/commands/knowledge.ts";
import type { ProbeCatalogEntry } from "../../src/kernel/commands/probe.ts";
import { type KnowledgeDocsPort, openKnowledgeBase } from "../../src/knowledge/docs.ts";
import { openKnowledgePack } from "../../src/knowledge/pack.ts";
import { type LocalReferenceDoc, parseSkillFrontmatter, TOOL_REFERENCE_DOCS } from "../../src/knowledge/reference.ts";
import type { KnowledgeSourceStatus } from "../../src/knowledge/source.ts";

const ROOT = "C:/cache/kb-blocks/cosmic";
const norm = (path: string): string => path.replace(/\\/g, "/");

function fakePort(files: Record<string, string>): KnowledgeDocsPort {
	const map = new Map(Object.entries(files).map(([rel, text]) => [`${ROOT}/${rel}`, text]));
	return {
		walkMarkdown: (dir) => [...map.keys()].filter((path) => path.startsWith(`${norm(dir)}/`)),
		read: (file) => map.get(norm(file)) ?? null,
		size: (file) => (map.has(norm(file)) ? Buffer.byteLength(map.get(norm(file)) ?? "", "utf8") : null),
		isFile: (path) => map.has(norm(path)),
		isDirectory: (path) => [...map.keys()].some((key) => key.startsWith(`${norm(path)}/`)),
		realPath: (path) => (map.has(norm(path)) || norm(path) === ROOT ? norm(path) : null),
	};
}

const FACTS = { root: ROOT, bundleVersion: "test", snapshotId: "blocks", docCount: 2 };
const STATUS: KnowledgeSourceStatus = {
	kind: "embedded",
	root: ROOT,
	inForce: FACTS,
	embedded: FACTS,
	overrideProblem: null,
};

const TREE: Record<string, string> = {
	"platform/scenes/_index.md":
		"# 场景索引\n\n| 场景名 | 文件 | 状态 | 关键词 |\n|---|---|---|---|\n| 操作结果 | operation/result.md | released | 成功单据 |\n",
	"platform/scenes/operation/result.md": [
		"---",
		"scene_name: 操作结果处理",
		"status: released",
		"---",
		"",
		"# 场景：操作结果处理",
		"",
		"## 事件/方法说明",
		"调用 getSuccessPkIds 取成功的单据。",
		"",
		"## 注意事项",
		"- 批量操作时部分成功。",
	].join("\n"),
};

const filler = (bytes: number): string => "说明文字。".repeat(Math.ceil(bytes / 15));

const RUN_DOC = [
	"---",
	"name: cosmic-run",
	"description: run 的用法",
	"---",
	"",
	"# run —— 免界面跑真实业务动作",
	"",
	"开头：cosmic_run 能跑表单、列表、操作。",
	"",
	"## run form：表单插件",
	"触发工具栏操作用 --click。",
	filler(2000),
	"",
	"## run op：操作插件",
	filler(3000),
].join("\n");

const localDoc = (text: string): LocalReferenceDoc => {
	const front = parseSkillFrontmatter(text);
	if (front === null) throw new Error("bad fixture");
	return {
		name: front.name,
		description: front.description,
		file: `C:/ref/${front.name}/SKILL.md`,
		text: text.toLowerCase(),
		source: text,
	};
};

const port = fakePort(TREE);
const kb = openKnowledgeBase(ROOT, port);
const LOCAL = [localDoc(RUN_DOC)];
const PROBES: ProbeCatalogEntry[] = [
	{
		name: "FormRuleProbe",
		summary: "读界面规则",
		required: ["FORM"],
		usage: ["FORM=<布局标识> 必填"],
	} as ProbeCatalogEntry,
];

describe("search answers with whole blocks from both sources", () => {
	it("ranks the local reference beside the official base, and hands back a show argument that fetches the same block", () => {
		const result = knowledgeSearch(kb, STATUS, "触发工具栏操作 --click", {}, LOCAL);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const [hit] = result.value.results;
		expect(hit?.relativePath).toBe("reference:cosmic-run");
		expect(hit?.origin).toBe("本环境实测");
		expect(hit?.show).toBe("reference:cosmic-run#run form：表单插件");
		expect(hit?.text).toContain("触发工具栏操作用 --click");
		const shown = knowledgeShow(kb, STATUS, hit?.show ?? "", port, LOCAL);
		expect(shown.ok && shown.value.content.startsWith("## run form：表单插件")).toBe(true);
		expect(shown.ok && shown.value.outline).toEqual([
			expect.stringContaining("「run form：表单插件」"),
			expect.stringContaining("「run op：操作插件」"),
		]);
	});

	it("uses the scene index's keywords for that scene, though the index itself is not a result", () => {
		const result = knowledgeSearch(kb, STATUS, "成功单据", {}, LOCAL);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const paths = result.value.results.map((hit) => hit.relativePath);
		expect(paths).toContain("platform/scenes/operation/result.md");
		expect(paths).not.toContain("platform/scenes/_index.md");
	});

	it("does not echo the request back as options", () => {
		const result = knowledgeSearch(kb, STATUS, "getSuccessPkIds", { action: "search", query: "x" } as never, LOCAL);
		expect(result.ok && result.value.options).toEqual({ kind: "all", limit: 5 });
	});

	it("moves inlined block text out of the JSON envelope, labelled with its show argument", () => {
		const result = knowledgeSearch(kb, STATUS, "getSuccessPkIds", {}, LOCAL);
		if (!result.ok) throw new Error("search failed");
		const prose = extractProse("cosmic_knowledge", { action: "search", ...result.value });
		expect(prose.blocks[0]?.label).toBe("platform/scenes/operation/result.md");
		expect(prose.blocks[0]?.text).toContain("## 注意事项");
		expect(JSON.stringify(prose.result)).toContain("见下方文本块");
	});
});

describe("a query that names a tool, a probe or a project identifier", () => {
	it("answers a bare tool name with that tool's page: its opening and its outline", () => {
		const result = knowledgeSearch(kb, STATUS, "cosmic-run", {}, LOCAL);
		if (!result.ok) throw new Error("search failed");
		expect(result.value.results).toHaveLength(1);
		expect(result.value.results[0]?.outline).toEqual([
			expect.stringContaining("「run form：表单插件」"),
			expect.stringContaining("「run op：操作插件」"),
		]);
	});

	it("attaches the full inputs of a probe the query names", () => {
		const result = knowledgeSearch(kb, STATUS, "FormRuleProbe 规则", {}, LOCAL, PROBES);
		expect(result.ok && result.value.probes).toEqual({ FormRuleProbe: ["FORM=<布局标识> 必填"] });
	});

	it("says a project identifier is not in either source, and where such names are looked up", () => {
		const result = knowledgeSearch(kb, STATUS, "demo_report_copies", {}, LOCAL);
		if (!result.ok) throw new Error("search failed");
		expect(result.value.results).toEqual([]);
		expect(result.value.absent).toEqual(["demo_report_copies"]);
		expect(result.value.warnings.join("\n")).toContain("action=probes");
	});
});

describe("show", () => {
	it("reads a whole local page by reference:<name>", () => {
		const shown = knowledgeShow(kb, STATUS, "reference:cosmic-run", port, LOCAL);
		expect(shown.ok && shown.value.content).toBe(RUN_DOC);
		expect(shown.ok && shown.value.outline).toBeUndefined();
	});

	it("names the headings it has when the asked one is not there", () => {
		const shown = knowledgeShow(kb, STATUS, "reference:cosmic-run#run list", port, LOCAL);
		expect(shown.ok).toBe(false);
		if (shown.ok) return;
		expect(shown.error.message).toContain("这篇没有标题「run list」");
		expect(shown.error.remedy).toContain("run form：表单插件");
	});

	it("refuses an unknown local page and lists the ones there are", () => {
		const shown = knowledgeShow(kb, STATUS, "reference:cosmic-nope", port, LOCAL);
		expect(shown.ok).toBe(false);
		if (shown.ok) return;
		expect(shown.error.remedy).toContain("cosmic-run");
	});
});

describe("TOOL_REFERENCE_DOCS", () => {
	const pack = openKnowledgePack(
		new Uint8Array(readFileSync(fileURLToPath(new URL("../../knowledge/reference.pack", import.meta.url)))),
	);
	const released = new Set(pack.paths.map((path) => path.slice(0, path.indexOf("/"))));

	it("maps real tools to pages that are in the reference pack", () => {
		for (const [tool, page] of Object.entries(TOOL_REFERENCE_DOCS)) {
			expect(COSMIC_TOOL_NAMES as readonly string[]).toContain(tool);
			expect(released.has(page), page).toBe(true);
		}
	});
});
