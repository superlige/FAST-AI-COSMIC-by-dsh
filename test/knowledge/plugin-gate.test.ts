/**
 * S15.2: the plugin Capsule gate plus legacy explicit research flow.
 *
 * Four properties are load-bearing and each has a case here:
 *
 *   1. lint and fast reach the SAME verdict, because they are handed the same
 *      closure. The regression is not "both refuse", it is "both say the same
 *      thing about the same input"; a gate that lint predicts and fast does not
 *      apply (or the reverse) stops being believed in either direction.
 *   2. fast refuses BEFORE Gradle. A gate that costs two minutes before saying
 *      no gets routed around the second time.
 *   3. Capsule status is keyed by platform base class and scoped by RuntimeKey.
 *   4. Step 4 of the flow is machine-verified: an invented document name is
 *      refused and nothing is stamped. A stamp for a document nobody read is
 *      worse than no gate, because from then on it looks like the flow ran.
 */
import { describe, expect, it } from "vitest";
import { fast } from "../../src/kernel/commands/fast.ts";
import { runKnowledge } from "../../src/kernel/commands/knowledge.ts";
import { lint } from "../../src/kernel/commands/lint.ts";
import { pluginKnowledgeCapsules } from "../../src/knowledge/capsule.ts";
import { type KnowledgeDocsPort, openKnowledgeBase } from "../../src/knowledge/docs.ts";
import { type PluginFamily, pluginFamiliesIn } from "../../src/knowledge/plugin-base.ts";
import { knowledgeAdvisor, pluginGate } from "../../src/knowledge/plugin-gate.ts";
import type { KnowledgeSourceStatus } from "../../src/knowledge/source.ts";
import { addSource, type FakeContext, makeContext } from "../kernel/fake-context.ts";

const KB = "C:/cache/knowledge/snap/cosmic";
const norm = (path: string): string => path.replace(/\\/g, "/");

const SCENE_INDEX = `# 场景索引

| 场景名 | 文件 | 状态 | 关键词 | triggerEvent | controlType | pluginType |
|---|---|---|---|---|---|---|
| 选择后回填 | f7-select.md | released | 选择后, 回填 | afterF7Select | basedata | billform |
| 保存前校验 | before-save.md | released | 保存, 校验 | beforeDoOperation | — | billform |
| 列表过滤 | list-filter.md | released | 列表, 过滤 | setFilter | list | listform |
`;

const TREE: Record<string, string> = {
	"platform/scenes/_index.md": SCENE_INDEX,
	"platform/scenes/f7-select.md":
		"# 选择后回填\n\n正文：afterF7Select 里用 kd.bos.orm.query.QFilter 过滤，再写回 kd.bos.dataentity.entity.DynamicObject。\n",
	"platform/scenes/before-save.md": "# 保存前校验\n\n正文：beforeDoOperation。\n",
	"platform/scenes/list-filter.md": "# 列表过滤\n\n正文：setFilter。\n",
	"platform/form-plugin.md": "# 表单插件指南\n\n全文：入口是 kd.bos.form.plugin.AbstractFormPlugin。\n",
	"platform/operation-plugin.md": "# 操作插件指南\n\n全文。\n",
};

function docsPort(files: Record<string, string>): KnowledgeDocsPort {
	const map = new Map(Object.entries(files).map(([rel, text]) => [`${KB}/${rel}`, text]));
	return {
		walkMarkdown: (dir) => [...map.keys()].filter((path) => path.startsWith(`${norm(dir)}/`)),
		read: (file) => map.get(norm(file)) ?? null,
		size: (file) => (map.has(norm(file)) ? Buffer.byteLength(map.get(norm(file)) ?? "", "utf8") : null),
		isFile: (path) => map.has(norm(path)),
		isDirectory: (path) => [...map.keys()].some((key) => key.startsWith(`${norm(path)}/`)),
		realPath: (path) => (map.has(norm(path)) || norm(path) === KB ? norm(path) : null),
	};
}

const PORT = docsPort(TREE);
const BASE = openKnowledgeBase(KB, PORT);
const FACTS = { bundleVersion: "2.2.1", snapshotId: "snap", docCount: Object.keys(TREE).length };
const STATUS: KnowledgeSourceStatus = {
	kind: "embedded",
	root: KB,
	inForce: FACTS,
	embedded: FACTS,
	overrideProblem: null,
};

/** A project whose named source is a bill-form plugin, plus everything the gate needs. */
function pluginProject(): { fake: FakeContext; file: string } {
	const fake = makeContext();
	const file = addSource(fake, "demo-biz", "OrderPlugin.java");
	fake.fs.write(
		file,
		["package com.zlgd.sale;", "", "public class OrderPlugin extends AbstractBillPlugIn {", "}"].join("\n"),
	);
	return { fake, file };
}

function advisorFor(fake: FakeContext) {
	return knowledgeAdvisor({
		base: BASE,
		source: fake.ctx.ports.fs,
		capsules: (families) => capsuleAudit(families),
	});
}

function capsuleAudit(families: readonly PluginFamily[], delivered = true) {
	return pluginKnowledgeCapsules(BASE, families, "runtime-1").map((capsule, index) => ({
		base: families[index]?.route.base ?? capsule.subject,
		digest: capsule.digest,
		subject: capsule.subject,
		confidence: capsule.confidence,
		sourceRefs: [...capsule.sourceRefs],
		delivered,
	}));
}

describe("S7.4 the verdict", () => {
	it("has nothing to say about a batch with no plugin in it", async () => {
		const verdict = pluginGate([], []);
		expect(verdict.allowed).toBe(true);
		expect(verdict.reason).toBe("no-families");
		expect(verdict.lines).toEqual([]);
	});

	it("names the family and file when its deterministic Capsule is unavailable", async () => {
		const { fake, file } = pluginProject();
		const verdict = pluginGate(pluginFamiliesIn([file], fake.ctx.ports.fs), []);
		expect(verdict.allowed).toBe(false);
		expect(verdict.reason).toBe("capsule-unavailable");
		expect(verdict.blocked.map((entry) => entry.base)).toEqual(["AbstractBillPlugIn"]);
		expect(verdict.blocked[0]?.file).toBe(norm(file));
		expect(verdict.lines.join("\n")).toContain("无法生成目标 Capsule");
	});

	it("allows a family once its target Capsule can be generated, even before explicit research", async () => {
		const { fake, file } = pluginProject();
		const families = pluginFamiliesIn([file], fake.ctx.ports.fs);
		const verdict = pluginGate(families, capsuleAudit(families, false));
		expect(verdict.allowed).toBe(true);
		expect(verdict.reason).toBe("capsule-ready");
		expect(verdict.capsules.map((entry) => entry.base)).toEqual(["AbstractBillPlugIn"]);
		expect(verdict.capsules[0]?.delivered).toBe(false);
	});

	it("does not let one base's Capsule clear another base under the same pluginType", async () => {
		// printplugin covers two bases with different event sets. Keying the stamp by
		// type would clear both, with no error and code that compiles.
		const fake = makeContext();
		const senior = addSource(fake, "demo-biz", "SeniorPrint.java");
		const plain = addSource(fake, "demo-biz", "PlainPrint.java");
		fake.fs.write(senior, "public class SeniorPrint extends AbstractPrintSeniorPlugin {}");
		fake.fs.write(plain, "public class PlainPrint extends AbstractPrintPlugin {}");
		const families = pluginFamiliesIn([senior, plain], fake.ctx.ports.fs);
		const verdict = pluginGate(families, capsuleAudit(families.slice(0, 1)));
		expect(verdict.allowed).toBe(false);
		expect(verdict.blocked.map((entry) => entry.base)).toEqual(["AbstractPrintPlugin"]);
	});
});

describe("S7.4 the two halves", () => {
	it("gives lint and fast the same conclusion on the same input", async () => {
		const { fake, file } = pluginProject();
		const advisor = advisorFor(fake);

		const preview = await lint(fake.ctx, [file], { knowledge: advisor });
		expect(preview.ok).toBe(true);
		if (!preview.ok) return;
		const previewed = preview.value.knowledge?.gate;

		const compiled = await fast(fake.ctx, [file], { knowledgeGate: advisor });
		expect(compiled.ok).toBe(true);
		if (!compiled.ok) return;

		expect(previewed?.allowed).toBe(true);
		expect(compiled.value.knowledge?.gate.reason).toBe(previewed?.reason);
		expect(compiled.value.knowledge?.capsules.map((entry) => entry.digest)).toEqual(
			preview.value.knowledge?.capsules.map((entry) => entry.digest),
		);
	});

	it("lets lint report the same Capsule audit without becoming a required check-in", async () => {
		const { fake, file } = pluginProject();
		const report = await lint(fake.ctx, [file], { knowledge: advisorFor(fake) });
		expect(report.ok).toBe(true);
		if (!report.ok) return;
		expect(report.value.knowledge?.gate.allowed).toBe(true);
		expect(report.value.knowledge?.capsules).toHaveLength(1);
		expect(report.value.knowledge?.hints.map((hint) => hint.base)).toEqual(["AbstractBillPlugIn"]);
		// The hint carries the scene count for this family, from the official index.
		expect(report.value.knowledge?.hints[0]?.sceneCount).toBe(2);
	});

	it("marks the explicit plugin action as optional research, not a fast prerequisite", async () => {
		const { fake, file } = pluginProject();
		const advice = advisorFor(fake)([file]);

		const research = advice.hints[0]?.lines.find((line) => line.includes("action=plugin"));
		expect(research).toContain("复杂语义或低置信边界再用");
		expect(research).toContain(`query=${file}`);
		expect(advice.gate.allowed).toBe(true);
		expect(advice.gate.blocked).toEqual([]);

		// And the lookup-only route is still offered, marked as what it is: a plain
		// query has no reason to walk a flow that stamps.
		const rest = advice.hints[0]?.lines.slice(2).join("\n") ?? "";
		expect(rest).toContain("action=scenes");
		expect(rest).toContain("action=show");
	});

	it("refuses before Gradle only when a recognised family has no deterministic Capsule", async () => {
		const { fake, file } = pluginProject();
		const unavailable = knowledgeAdvisor({ base: BASE, source: fake.ctx.ports.fs, capsules: () => [] });
		const result = await fast(fake.ctx, [file], { knowledgeGate: unavailable });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		// Not COMPILE_FAILED: nothing was compiled, and the audit groups by code.
		expect(result.error.code).toBe("KNOWLEDGE_GATE_UNSATISFIED");
		expect(result.error.remedy).toContain("cosmic_doctor");
		// Position is the design: no gradle, no javac, nothing.
		expect(fake.proc.runs).toHaveLength(0);
	});

	it("compiles from the generated Capsule without requiring the explicit plugin action", async () => {
		const { fake, file } = pluginProject();
		const result = await fast(fake.ctx, [file], { knowledgeGate: advisorFor(fake) });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.knowledge?.gate.allowed).toBe(true);
		expect(result.value.knowledge?.capsules[0]?.digest).toMatch(/^[a-f0-9]{64}$/);
		expect(fake.proc.runsOf("javac").length).toBeGreaterThan(0);
	});

	it("reports unavailable Capsule infrastructure rather than inventing a documentation task", async () => {
		const { fake, file } = pluginProject();
		const result = await fast(fake.ctx, [file]);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.knowledge).toBeNull();
		expect(result.value.notes.some((note) => note.includes("插件知识卡片（Capsule）来源不可用"))).toBe(true);
		expect(result.value.notes.join("\n")).not.toContain("action=plugin");
	});
});

describe("S7.4 the six-step root flow", () => {
	async function run(fake: FakeContext, query: string, scenes?: readonly string[]) {
		return await runKnowledge(
			BASE,
			STATUS,
			scenes === undefined ? { action: "plugin", query } : { action: "plugin", query, scenes },
			PORT,
			undefined,
			{ source: fake.ctx.ports.fs },
		);
	}

	it("refuses the action outright when no project is open", async () => {
		const result = await runKnowledge(BASE, STATUS, { action: "plugin", query: "AbstractBillPlugIn" }, PORT);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("KNOWLEDGE_QUERY_INVALID");
	});

	it("phase 1 lays out the whole guide and the family's whole scene table", async () => {
		const { fake, file } = pluginProject();
		const result = await run(fake, file);
		expect(result.ok).toBe(true);
		if (!result.ok || result.value.action !== "plugin") return;
		expect(result.value.phase).toBe(1);
		expect(result.value.family.base).toBe("AbstractBillPlugIn");
		expect(result.value.guide?.relativePath).toBe("platform/form-plugin.md");
		expect(result.value.guide?.content).toContain("表单插件指南");
		// The whole table, filtered only by family. Measured recall of literal search
		// on business-voiced questions was 3/10 against 9/9 for reading the table.
		expect(result.value.scenes?.rows.map((row) => row.relativePath).sort()).toEqual([
			"before-save.md",
			"f7-select.md",
		]);
		// Nothing is stamped by laying the text out.
		expect(result.value.stamped).toBeNull();
	});

	it("refuses an invented document name and does NOT stamp", async () => {
		// The one machine-verifiable step in the flow.
		const { fake, file } = pluginProject();
		const result = await run(fake, file, ["totally-made-up.md"]);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("KNOWLEDGE_QUERY_INVALID");
			expect(result.error.message).toContain("totally-made-up.md");
		}
	});

	it("points at the local runtime-delta page by a path the model can read", async () => {
		// S45 批 1.3：只有族索引是注册给模型的技能，成员篇名照着「读 skill」读不到。
		const { fake, file } = pluginProject();
		const answer = async (referenceDoc?: (name: string) => string | null) => {
			// 选了场景的第二步才给出 6/6 那一行
			const request = { action: "plugin" as const, query: file, scenes: ["f7-select.md"] };
			const result = await runKnowledge(BASE, STATUS, request, PORT, undefined, {
				source: fake.ctx.ports.fs,
				...(referenceDoc === undefined ? {} : { referenceDoc }),
			});
			if (!result.ok || result.value.action !== "plugin") throw new Error("plugin flow failed");
			return result.value;
		};
		const resolved = await answer((name) =>
			name === "cosmic-plugin-ui" ? "C:/ref/cosmic-plugin-ui/SKILL.md" : null,
		);
		expect(resolved.family.localDoc).toBe("C:/ref/cosmic-plugin-ui/SKILL.md");
		expect(resolved.nextActions.join("\n")).toContain("read C:/ref/cosmic-plugin-ui/SKILL.md");
		expect(resolved.nextActions.join("\n")).not.toContain("读 skill");
		// 参考包没释放成功：说它在哪个族索引里，族索引才是模型能读的技能
		const unresolved = await answer();
		expect(unresolved.family.localDoc).toBe("技能 cosmic-plugin 里的 cosmic-plugin-ui");
	});

	it("refuses more than two documents", async () => {
		const { fake, file } = pluginProject();
		const result = await run(fake, file, ["f7-select.md", "before-save.md", "list-filter.md"]);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.message).toContain("1~2 篇");
	});

	it("refuses a document from another family's table", async () => {
		// list-filter.md exists, but it is tagged listform. Accepting it would mean
		// the stamp says "read the billform scenes" about a listform document.
		const { fake, file } = pluginProject();
		const result = await run(fake, file, ["list-filter.md"]);
		expect(result.ok).toBe(false);
	});

	it("prints chosen bodies without writing a stamp, and then fast compiles", async () => {
		const { fake, file } = pluginProject();
		const result = await run(fake, file, ["f7-select.md"]);
		expect(result.ok).toBe(true);
		if (!result.ok || result.value.action !== "plugin") return;
		expect(result.value.phase).toBe(2);
		expect(result.value.chosen.map((doc) => doc.relativePath)).toEqual(["platform/scenes/f7-select.md"]);
		expect(result.value.chosen[0]?.content).toContain("afterF7Select 里用");
		expect(result.value.stamped).toBeNull();
		// Step 6 names the local skill rather than reprinting it: those documents are
		// pi-native skills since S7.1.
		expect(result.value.nextActions.join("\n")).toContain("cosmic-plugin-ui");

		const compiled = await fast(fake.ctx, [file], { knowledgeGate: advisorFor(fake) });
		expect(compiled.ok).toBe(true);
	});

	it("names the classes step 5 should check, taken from the text just read", async () => {
		// Step 5 used to say "core the signatures" and name nothing, which left the
		// caller to pick from its own import list -- a list of everything, checked
		// exhaustively at one call per entry. The shortlist is derived from the
		// guide and the chosen body, so it cannot drift out of date the way a
		// hand-kept per-family API table would.
		const { fake, file } = pluginProject();
		const result = await run(fake, file, ["f7-select.md"]);
		expect(result.ok).toBe(true);
		if (!result.ok || result.value.action !== "plugin") return;
		expect(result.value.apiCandidates).toContain("kd.bos.orm.query.QFilter");
		expect(result.value.apiCandidates).toContain("kd.bos.dataentity.entity.DynamicObject");
		// From the guide, not only the scene body.
		expect(result.value.apiCandidates).toContain("kd.bos.form.plugin.AbstractFormPlugin");
		// One command for the lot, not one per class.
		const step5 = result.value.nextActions.find((line) => line.startsWith("5/6"));
		expect(step5).toContain("action=api");
		expect(step5).toContain("kd.bos.orm.query.QFilter kd.bos.dataentity.entity.DynamicObject");
	});

	it("has nothing to shortlist in phase 1, where no body has been chosen yet", async () => {
		const { fake, file } = pluginProject();
		const result = await run(fake, file, undefined);
		expect(result.ok).toBe(true);
		if (!result.ok || result.value.action !== "plugin") return;
		expect(result.value.apiCandidates).toEqual([]);
	});

	it("normalises a hand-typed document name", async () => {
		const { fake, file } = pluginProject();
		const result = await run(fake, file, ["platform/scenes/f7-select.md"]);
		expect(result.ok).toBe(true);
		if (result.ok && result.value.action === "plugin") {
			expect(result.value.chosen.map((doc) => doc.relativePath)).toEqual(["platform/scenes/f7-select.md"]);
			expect(result.value.stamped).toBeNull();
		}
	});

	/**
	 * The table prints `f7-select.md` and the caller is told to copy it, but a
	 * name lifted out of prose loses the suffix often enough that refusing it is
	 * a trap: it still identifies exactly one row. A real session spent four
	 * round trips here, stripping the folder and re-adding it while the only
	 * difference was `.md`.
	 */
	it("accepts a name that lost its .md suffix, and stamps the table's own path", async () => {
		const { fake, file } = pluginProject();
		const result = await run(fake, file, ["f7-select"]);
		expect(result.ok).toBe(true);
		if (result.ok && result.value.action === "plugin") {
			expect(result.value.chosen.map((doc) => doc.relativePath)).toEqual(["platform/scenes/f7-select.md"]);
			expect(result.value.stamped).toBeNull();
		}
	});

	it("answers a near miss with the row it meant instead of calling it invented", async () => {
		// A bare leaf stays a miss -- two families can hold the same file name --
		// but the refusal has to hand back the executable correction rather than
		// send the caller back to re-read a table it copied from correctly.
		const { fake, file } = pluginProject();
		const result = await run(fake, file, ["scenes/f7-select.md"]);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.detail.didYouMean).toEqual(["f7-select.md"]);
			expect(result.error.remedy).toContain('scenes=["f7-select.md"]');
			expect(result.error.remedy).not.toContain("编造");
		}
	});

	it("keeps the plain refusal when the name resembles no row at all", async () => {
		const { fake, file } = pluginProject();
		const result = await run(fake, file, ["totally-made-up.md"]);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.detail.didYouMean).toBeUndefined();
			expect(result.error.remedy).toContain("action=scenes");
		}
	});

	/**
	 * Phase 1 hands over the table once, and step 4 can be many turns later. A
	 * refusal that says only "not in the table" asks the caller to remember a
	 * document it can no longer see -- which is how a real session spent four
	 * attempts re-deriving the table from memory. The refusal re-pins the flow
	 * position and the family's real document names.
	 */
	it("re-pins the flow and the family's pickable names on a step-4 refusal", async () => {
		const { fake, file } = pluginProject();
		const result = await run(fake, file, ["totally-made-up.md"]);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.detail.at).toContain("4/6");
			expect(result.error.detail.steps).toHaveLength(6);
			// The billform family's own rows, not the whole index: list-filter.md is
			// tagged listform and must not be offered here.
			expect(result.error.detail.available).toEqual(["before-save.md", "f7-select.md"]);
		}
	});

	it("re-pins the same anchor when too many documents were named", async () => {
		const { fake, file } = pluginProject();
		const result = await run(fake, file, ["f7-select.md", "before-save.md", "list-filter.md"]);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.detail.at).toContain("4/6");
			expect(result.error.detail.available).toEqual(["before-save.md", "f7-select.md"]);
		}
	});

	it("passes an untagged family on an explicitly empty list, and refuses invented scenes for it", async () => {
		const fake = makeContext();
		const file = addSource(fake, "demo-biz", "OrderOp.java");
		fake.fs.write(file, "public class OrderOp extends AbstractOperationServicePlugIn {}");

		const laidOut = await run(fake, file);
		expect(laidOut.ok).toBe(true);
		if (laidOut.ok && laidOut.value.action === "plugin") {
			expect(laidOut.value.family.pluginType).toBeNull();
			// Not "no scenes" -- never tagged. Inventing a tag would make every
			// pluginType filter fall back to the untagged baseline.
			expect(laidOut.value.scenes).toBeNull();
		}
		expect((await run(fake, file, ["f7-select.md"])).ok).toBe(false);

		const passed = await run(fake, file, []);
		expect(passed.ok).toBe(true);
	});

	it("refuses a pluginType that covers more than one platform base", async () => {
		// The stamp is per base; resolving to the first row would stamp one family
		// and leave the caller believing both were cleared.
		const { fake } = pluginProject();
		const result = await run(fake, "printplugin");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.message).toContain("多个平台基类");
	});

	it("says so when the family was only recognised through a project base class", async () => {
		const fake = makeContext();
		const base = addSource(fake, "demo-biz", "ExtBill.java");
		const leaf = addSource(fake, "demo-biz", "OrderLeaf.java");
		fake.fs.write(
			base,
			["package com.zlgd.sale;", "", "public class ExtBill extends AbstractBillPlugIn {}"].join("\n"),
		);
		fake.fs.write(leaf, ["package com.zlgd.sale;", "", "public class OrderLeaf extends ExtBill {}"].join("\n"));

		const result = await run(fake, leaf);
		expect(result.ok).toBe(true);
		if (result.ok && result.value.action === "plugin") {
			expect(result.value.family.base).toBe("AbstractBillPlugIn");
			expect(result.value.family.via).toEqual(["ExtBill"]);
			expect(result.value.notes.join("\n")).toContain("经工程基类");
		}
	});
});
