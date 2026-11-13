/**
 * S45 批 4：知识卡片的内容来自参考文档里人写的「必知要点」一节。
 *
 * 用当前参考快照。守的是：路由表里写了要点标题的族，在那篇文档里真找得到、至少两条、每条是完整的一句；
 * 卡片放得进单张上限；没写要点的族读写时不推卡片，但门禁照样拿得到卡片；临时探针不在读写时推卡片；
 * 插件族提示里给的 `show` 写法能取到这一节。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { knowledgeShow } from "../../src/kernel/commands/knowledge.ts";
import {
	CAPSULE_SINGLE_BUDGET_BYTES,
	codingRulesCapsule,
	pluginEssentials,
	pluginKnowledgeCapsules,
	renderKnowledgeCapsule,
	sourceKnowledgeCapsules,
} from "../../src/knowledge/capsule.ts";
import { PLUGIN_ROUTES } from "../../src/knowledge/catalog.ts";
import { type KnowledgeDocsPort, openKnowledgeBase } from "../../src/knowledge/docs.ts";
import { openKnowledgePack } from "../../src/knowledge/pack.ts";
import type { JavaSourcePort } from "../../src/knowledge/plugin-base.ts";
import { pluginHints } from "../../src/knowledge/plugin-gate.ts";
import { type LocalReferenceDoc, parseSkillFrontmatter } from "../../src/knowledge/reference.ts";
import type { KnowledgeSourceStatus } from "../../src/knowledge/source.ts";

const snapshot = openKnowledgePack(
	new Uint8Array(readFileSync(fileURLToPath(new URL("../../knowledge/reference.pack", import.meta.url)))),
);
const LOCAL: LocalReferenceDoc[] = snapshot.paths.flatMap((path) => {
	const text = snapshot.read(path);
	const front = text === null ? null : parseSkillFrontmatter(text);
	return text === null || front === null
		? []
		: [{ name: front.name, description: front.description, file: path, text: text.toLowerCase(), source: text }];
});

const ROOT = "C:/cache/kb-essentials/cosmic";
const EMPTY: KnowledgeDocsPort = {
	walkMarkdown: () => [],
	read: () => null,
	size: () => null,
	isFile: () => false,
	isDirectory: () => false,
	realPath: (path) => (path.replace(/\\/g, "/") === ROOT ? ROOT : null),
};
const FACTS = { root: ROOT, bundleVersion: "test", snapshotId: "essentials", docCount: 0 };
const STATUS: KnowledgeSourceStatus = {
	kind: "embedded",
	root: ROOT,
	inForce: FACTS,
	embedded: FACTS,
	overrideProblem: null,
};
const kb = openKnowledgeBase(ROOT, EMPTY);

/** 一个继承 `base` 的源码文件。 */
function sourceOf(base: string, file = `demo/${base}Demo.java`): { file: string; source: JavaSourcePort } {
	return {
		file,
		source: {
			exists: (path) => path === file,
			read: (path) =>
				path === file ? `import kd.bos.orm.query.QFilter;\npublic class Demo extends ${base} {}` : "",
		},
	};
}

describe("plugin capsules carry the hand-written essentials", () => {
	const written = PLUGIN_ROUTES.filter((route) => route.essentials !== null);

	it("every essentials heading in the route table is found, with complete sentences under it", () => {
		expect(written.length).toBeGreaterThanOrEqual(20);
		for (const route of written) {
			const items = pluginEssentials(LOCAL, route);
			expect(items.length, `${route.base} → ${route.local}#${route.essentials}`).toBeGreaterThanOrEqual(2);
			for (const item of items) {
				// 原来正则摘出过孤零零的"注意："、表格行和半截代码
				expect(item, route.base).not.toMatch(/[:：]$/);
				expect(item, route.base).not.toMatch(/^\||[{}]$/);
			}
		}
	});

	it("each pushed capsule fits the single-capsule budget", () => {
		for (const route of written) {
			const { file, source } = sourceOf(route.base);
			const [capsule] = sourceKnowledgeCapsules({
				base: kb,
				source,
				files: [file],
				runtimeKeyId: null,
				local: LOCAL,
			});
			expect(capsule?.must.length, route.base).toBeGreaterThan(2);
			expect(Buffer.byteLength(renderKnowledgeCapsule(capsule ?? ({} as never)), "utf8")).toBeLessThanOrEqual(
				CAPSULE_SINGLE_BUDGET_BYTES,
			);
		}
	});

	it("pushes only the shared coding rules for a family without essentials, while the gate still gets its capsule", () => {
		const bare = PLUGIN_ROUTES.filter((route) => route.essentials === null);
		expect(bare.map((route) => route.base)).toContain("AbstractMobBillPlugIn");
		for (const route of bare) {
			const { file, source } = sourceOf(route.base);
			expect(
				sourceKnowledgeCapsules({ base: kb, source, files: [file], runtimeKeyId: null, local: LOCAL }).map(
					(capsule) => capsule.subject,
				),
			).toEqual(["插件写法"]);
			expect(pluginKnowledgeCapsules(kb, [{ route, tier: "direct", via: [], file }], null, LOCAL)).toHaveLength(1);
		}
	});

	it("pushes nothing for an ad-hoc probe: its useful part, the called signatures, comes when it runs", () => {
		const { file, source } = sourceOf("AbstractBillPlugIn", "D:/project/.cosmic-ai/probes/DemoProbe.java");
		expect(sourceKnowledgeCapsules({ base: kb, source, files: [file], runtimeKeyId: null, local: LOCAL })).toEqual(
			[],
		);
	});

	it("pushes nothing for a helper that only names a plugin base, and the helper does not hide a real plugin", () => {
		// 真机：读一个把 AbstractListPlugin 当参数类型的工具类，收到了列表插件卡
		const helper = "demo/util/PageUtils.java";
		const plugin = "demo/list/OrderListPlugin.java";
		const texts: Record<string, string> = {
			[helper]:
				"import kd.bos.list.plugin.AbstractListPlugin;\npublic class PageUtils {\n  public static void refresh(AbstractListPlugin p) {}\n}",
			[plugin]:
				"import kd.bos.list.plugin.AbstractListPlugin;\npublic class OrderListPlugin extends AbstractListPlugin {}",
		};
		const source: JavaSourcePort = { exists: (path) => path in texts, read: (path) => texts[path] ?? "" };
		const push = (files: string[]) =>
			sourceKnowledgeCapsules({ base: kb, source, files, runtimeKeyId: null, local: LOCAL }).map(
				(capsule) => capsule.subject,
			);
		expect(push([helper])).toEqual([]);
		expect(push([helper, plugin])).toEqual(["AbstractListPlugin", "插件写法"]);
	});

	it("the family hint points at the essentials with a show argument that fetches that section", () => {
		const route = PLUGIN_ROUTES.find((item) => item.base === "AbstractBillPlugIn");
		if (route === undefined) throw new Error("missing AbstractBillPlugIn route");
		const [hint] = pluginHints(kb, [{ route, tier: "direct", via: [], file: "demo/OrderPlugin.java" }]);
		expect(hint?.essentials).toBe("reference:cosmic-plugin-ui#表单与单据插件必知要点");
		expect(hint?.lines.join("\n")).toContain(`action=show query=${hint?.essentials}`);
		const shown = knowledgeShow(kb, STATUS, hint?.essentials ?? "", EMPTY, LOCAL);
		expect(shown.ok && shown.value.content).toContain("afterCreateNewData");
	});
});

describe("S51 shared coding rules card", () => {
	it("comes from the skill section, once per session by digest, within budget", () => {
		const rules = codingRulesCapsule(LOCAL, null);
		expect(rules?.subject).toBe("插件写法");
		expect(rules?.must.some((line) => line.includes("cosmic-allow"))).toBe(true);
		expect(rules?.must.some((line) => line.includes("循环外"))).toBe(true);
		expect(codingRulesCapsule(LOCAL, null)?.digest).toBe(rules?.digest);
		expect(Buffer.byteLength(renderKnowledgeCapsule(rules ?? ({} as never)), "utf8")).toBeLessThanOrEqual(1400);
	});

	it("goes out with a real plugin's family card", () => {
		const route = PLUGIN_ROUTES.find((entry) => entry.base === "AbstractOperationServicePlugIn");
		const { file, source } = sourceOf(route?.base ?? "");
		const subjects = sourceKnowledgeCapsules({
			base: kb,
			source,
			files: [file],
			runtimeKeyId: null,
			local: LOCAL,
		}).map((capsule) => capsule.subject);
		expect(subjects).toEqual(["AbstractOperationServicePlugIn", "插件写法"]);
	});
});
