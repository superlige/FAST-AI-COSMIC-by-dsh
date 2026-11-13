import { describe, expect, it } from "vitest";
import { planRun } from "../../src/kernel/commands/run.ts";
import {
	CAPSULE_SINGLE_BUDGET_BYTES,
	CAPSULE_TURN_BUDGET_BYTES,
	CapsuleBudgetError,
	condenseProbeApiCapsules,
	createKnowledgeCapsule,
	pluginKnowledgeCapsules,
	probeApiClassOf,
	probeApiKnowledgeCapsules,
	probeApiLinesOf,
	renderKnowledgeCapsule,
	runAdapterKnowledgeCapsule,
	selectKnowledgeCapsules,
} from "../../src/knowledge/capsule.ts";
import { PLUGIN_ROUTES } from "../../src/knowledge/catalog.ts";
import type { KnowledgeBase, KnowledgeDoc } from "../../src/knowledge/docs.ts";
import type { PluginFamily } from "../../src/knowledge/plugin-base.ts";
import { RUN_ADAPTER_CONTRACTS, RUN_KINDS } from "../../src/knowledge/run-adapter.ts";

function knowledgeBase(files: Record<string, string>): KnowledgeBase {
	const docs: KnowledgeDoc[] = Object.entries(files).map(([relativePath, text]) => ({
		file: `C:/knowledge/${relativePath}`,
		relativePath,
		bytes: Buffer.byteLength(text, "utf8"),
	}));
	return {
		root: "C:/knowledge",
		docs: () => docs,
		pathOf: (relativePath) => `C:/knowledge/${relativePath}`,
		read: (relativePath) => files[relativePath] ?? null,
		exists: (relativePath) => files[relativePath] !== undefined,
	};
}

const BASE = knowledgeBase({
	"platform/form-plugin.md": [
		"# 表单插件",
		"必须在 afterBindData 中只读取已经加载的模型值。",
		"不要在事件里猜字段类型。",
		"`protected void afterBindData(EventObject e)`",
	].join("\n"),
	"platform/api/qfilter.md": [
		"---",
		"api_class: QFilter",
		"api_package: kd.bos.orm.query",
		"status: released",
		"---",
		"必须显式选择比较符。",
		"`public QFilter(String field, QCP op, Object value)`",
	].join("\n"),
});

function capsule(subject: string) {
	return createKnowledgeCapsule({
		subject,
		kind: "plugin",
		runtimeKeyId: "runtime-1",
		must: ["必须做 A"],
		avoid: ["不要做 B"],
		signatures: ["void call()"],
		verificationRoute: ["verify A"],
		sourceRefs: ["knowledge:a.md"],
		confidence: "exact",
	});
}

describe("S15.1 Knowledge Capsule model and budgets", () => {
	it("same target facts render byte-for-byte and keep the same digest", () => {
		const first = capsule("AbstractFormPlugin ← Order.java");
		const second = capsule("AbstractFormPlugin ← Order.java");

		expect(second.digest).toBe(first.digest);
		expect(renderKnowledgeCapsule(second)).toBe(renderKnowledgeCapsule(first));
		expect(Buffer.byteLength(renderKnowledgeCapsule(first), "utf8")).toBeLessThanOrEqual(CAPSULE_SINGLE_BUDGET_BYTES);
	});

	it("oversized core fails loudly instead of silently losing rules", () => {
		expect(() =>
			createKnowledgeCapsule({
				subject: "too-large",
				kind: "plugin",
				runtimeKeyId: null,
				must: ["必须".repeat(2000)],
				avoid: [],
				signatures: [],
				verificationRoute: [],
				sourceRefs: ["knowledge:large.md"],
				confidence: "partial",
			}),
		).toThrow(CapsuleBudgetError);
	});

	it("one turn injects at most three, stays under 8 KiB, and drops delivered digests", () => {
		const candidates = [capsule("A"), capsule("B"), capsule("C"), capsule("D")];
		const selected = selectKnowledgeCapsules(candidates, new Set([candidates[0]?.digest ?? ""]));

		expect(selected.capsules.map((item) => item.subject)).toEqual(["B", "C", "D"]);
		expect(selected.bytes).toBeLessThanOrEqual(CAPSULE_TURN_BUDGET_BYTES);
		expect(selected.dropped).toContainEqual({ digest: candidates[0]?.digest, reason: "duplicate" });
	});
});

describe("S15.1 deterministic producers", () => {
	it("plugin producer carries the hand-written essentials, source refs and verification, nothing picked from the guide", () => {
		const route = PLUGIN_ROUTES.find((item) => item.base === "AbstractFormPlugin");
		if (route === undefined) throw new Error("missing AbstractFormPlugin route");
		const family: PluginFamily = { route, tier: "direct", via: [], file: "D:/project/Order.java" };
		const local = [
			{
				name: "cosmic-plugin-ui",
				description: "",
				file: "C:/cache/plugin-ui.md",
				text: "",
				source: [
					"## 表单与单据插件",
					"",
					`### ${route.essentials}`,
					"",
					"引导句不进卡片。",
					"",
					"- **要点一**：见 [别处](a.md#b)",
					"- 要点二",
					"",
					"段落之后的列表不算：",
					"",
					"- 不算的一条",
				].join("\n"),
			},
		];
		const [result] = pluginKnowledgeCapsules(BASE, [family], "runtime-1", local);

		expect(result?.kind).toBe("plugin");
		expect(result?.subject).toBe("AbstractFormPlugin");
		expect(result?.must).toContain("要点一：见 别处");
		expect(result?.must).toContain("要点二");
		expect(result?.must.join("\n")).not.toContain("引导句");
		expect(result?.must.join("\n")).not.toContain("不算的一条");
		// 原来正则从指南里摘"必须""不要"的行、带括号的行，现在一行都不摘
		expect(result?.must.join("\n")).not.toContain("afterBindData");
		expect(result?.signatures).toEqual([]);
		expect(result?.sourceRefs).toContain("knowledge:platform/form-plugin.md");
		expect(result?.verificationRoute.join("\n")).toContain("FormPluginProbe");
		// 去哪查绑定之外，还说没挂上去哪挂（真机：模型不知道有探针能挂，让用户去开发平台点）
		expect(result?.verificationRoute).toContain(
			"没挂上就用 FormLayoutWriteProbe 挂：LAYOUT_EDIT 里写 add plugin <类全名>",
		);
		expect(result?.confidence).toBe("exact");
		// 没有本地参考文档时照样生成（门禁要它），只是没有要点、置信度降为 partial
		expect(pluginKnowledgeCapsules(BASE, [family], "runtime-1")[0]?.confidence).toBe("partial");
	});

	it("large on-disk guide stays behind sourceRefs instead of overflowing the Capsule", () => {
		const route = PLUGIN_ROUTES.find((item) => item.base === "AbstractFormPlugin");
		if (route === undefined) throw new Error("missing AbstractFormPlugin route");
		const marker = "FULL-BODY-MARKER";
		const large = knowledgeBase({
			"platform/form-plugin.md": [
				"# 表单插件",
				"必须先确认事件入口。",
				...Array.from({ length: 300 }, (_, index) => `普通正文 ${String(index)} ${"x".repeat(80)}`),
				marker,
			].join("\n"),
		});
		const [result] = pluginKnowledgeCapsules(
			large,
			[{ route, tier: "direct", via: [], file: "D:/project/Order.java" }],
			"runtime-1",
		);
		if (result === undefined) throw new Error("plugin capsule missing");
		const rendered = renderKnowledgeCapsule(result);

		expect(Buffer.byteLength(rendered, "utf8")).toBeLessThanOrEqual(CAPSULE_SINGLE_BUDGET_BYTES);
		expect(rendered).not.toContain(marker);
		expect(result.sourceRefs).toContain("knowledge:platform/form-plugin.md");
	});

	it("shows reference sources as openable paths without changing what the capsule is", () => {
		const route = PLUGIN_ROUTES.find((item) => item.base === "AbstractFormPlugin");
		if (route === undefined) throw new Error("missing AbstractFormPlugin route");
		const [result] = pluginKnowledgeCapsules(
			BASE,
			[{ route, tier: "direct", via: [], file: "D:/project/Order.java" }],
			"runtime-1",
		);
		if (result === undefined) throw new Error("plugin capsule missing");
		const reference = result.sourceRefs.find((ref) => ref.startsWith("reference:"));
		if (reference === undefined) throw new Error("plugin capsule names no reference page");
		const resolve = (ref: string): string =>
			ref.startsWith("reference:") ? `C:/cache/skills/${ref.slice("reference:".length)}/SKILL.md` : ref;

		const selected = selectKnowledgeCapsules([result], new Set(), resolve);

		expect(selected.text).toContain(`- C:/cache/skills/${reference.slice("reference:".length)}/SKILL.md`);
		expect(selected.text).not.toContain(`- ${reference}`);
		expect(selected.text).toContain("- knowledge:platform/form-plugin.md");
		expect(selected.bytes).toBe(Buffer.byteLength(selected.text, "utf8"));
		// 摘要按名字算：缓存目录换了地方，同一张胶囊仍算发过
		expect(selected.capsules[0]?.digest).toBe(result.digest);
		expect(selected.capsules[0]?.sourceRefs).toEqual(result.sourceRefs);
	});

	it("probe API producer batches exact imports, points at the doc, and picks no lines out of it", () => {
		const source = [
			"import kd.bos.orm.query.QFilter;",
			"import kd.bos.orm.query.MissingApi;",
			"public class OneOff { public static void run() {} }",
		].join("\n");
		const results = probeApiKnowledgeCapsules(BASE, "D:/project/.cosmic-ai/probes/OneOff.java", source, "runtime-1");

		expect(results).toHaveLength(2);
		const qfilter = results.find((item) => item.subject.startsWith("kd.bos.orm.query.QFilter"));
		expect(qfilter?.must).toEqual(["临时探针精确 import kd.bos.orm.query.QFilter"]);
		expect(qfilter?.signatures).toEqual([]);
		expect(qfilter?.sourceRefs).toEqual(["knowledge:platform/api/qfilter.md"]);
		expect(results.find((item) => item.subject.startsWith("kd.bos.orm.query.MissingApi"))?.sourceRefs).toEqual([
			"knowledge:api-index-miss",
		]);
	});

	it("同一个类的探针说明第二次只发新出现的行，别的种类原样放行（S24 D2）", () => {
		// 09-17：模型每轮改一个方法名，DataRowSet 等五个类的说明各发了三遍。
		// 指纹去重拦不住——指纹里有探针文件和这次用到的签名，探针一改就是「新的」。
		const apiCapsule = (probe: string, signatures: string[]) =>
			createKnowledgeCapsule({
				subject: `kd.bos.print.core.data.DataRowSet ← ${probe}`,
				kind: "probe-api",
				runtimeKeyId: "runtime-1",
				must: ["临时探针精确 import kd.bos.print.core.data.DataRowSet"],
				avoid: ["用 javac/JVM 反复试类名、方法名或参数形状（这里给的就是真签名）"],
				signatures,
				verificationRoute: [`cosmic_probe name=${probe}`],
				sourceRefs: ["knowledge:platform/api/DataRowSet.md"],
				confidence: "exact",
			});
		const first = apiCapsule("A.java", ["Field get(String key)"]);
		expect(probeApiClassOf(first)).toBe("kd.bos.print.core.data.DataRowSet");
		const explained = new Map([[probeApiClassOf(first), new Set(probeApiLinesOf(first))]]);

		const plugin = capsule("AbstractPrintPlugin");
		const [again, same] = condenseProbeApiCapsules(
			[apiCapsule("B.java", ["Field get(String key)", "void put(String key, Field value)"]), plugin],
			explained,
		);
		expect(again?.subject).toContain("前面给过");
		expect(again?.signatures).toEqual(["void put(String key, Field value)"]);
		expect(again?.must).toEqual([]);
		expect(again?.avoid).toEqual([]);
		expect(same).toBe(plugin);
		// 没见过的类原样发。
		const [fresh] = condenseProbeApiCapsules([apiCapsule("C.java", ["x()"])], new Map());
		expect(fresh?.subject).toBe("kd.bos.print.core.data.DataRowSet ← C.java");
		// 什么都没新增的不发：只剩一行标题的卡片，模型拿它做不了任何事（2026-10 发过 12 张、4.4 KB）。
		expect(condenseProbeApiCapsules([apiCapsule("D.java", ["Field get(String key)"]), plugin], explained)).toEqual([
			plugin,
		]);
	});

	it("every run card comes from the same contract rows the kernel consumes", () => {
		const cards = RUN_KINDS.map((kind) => runAdapterKnowledgeCapsule([kind, "target"], "runtime-1"));

		expect(cards).toHaveLength(10);
		for (const [index, kind] of RUN_KINDS.entries()) {
			const card = cards[index];
			expect(card?.kind).toBe("run-adapter");
			expect(card?.must.join("\n")).toContain(
				RUN_ADAPTER_CONTRACTS[kind].accepted.map((flag) => `--${flag}`).join(" "),
			);
			expect(card?.verificationRoute.join("\n")).toContain(RUN_ADAPTER_CONTRACTS[kind].probe);
		}
	});

	it("卡片里能照抄的命令，内核真的认：抄过去不会在参数上被拒（S20 批 5）", () => {
		const commands = RUN_KINDS.flatMap((kind) =>
			RUN_ADAPTER_CONTRACTS[kind].examples.filter((line) => line.startsWith("run ")),
		);
		expect(commands.length).toBeGreaterThan(0);
		for (const command of commands) {
			const argv = command.split(/\s+/).slice(1);
			const planned = planRun(argv);
			expect(planned.ok, command).toBe(true);
			if (planned.ok) expect(planned.value.kind).toBe(argv[0]);
		}
	});

	it("弹窗回写父页那一族：form 卡片指到 run flow，flow / callback 各带一条完整命令", () => {
		const form = runAdapterKnowledgeCapsule(["form", "demo_bill_layout"], "runtime-1");
		expect(form.must.join("\n")).toContain("run flow");
		expect(form.signatures.some((line) => line.startsWith("run flow "))).toBe(true);
		expect(renderKnowledgeCapsule(form)).toContain("签名:\n- run flow ");
		for (const kind of ["flow", "callback"] as const) {
			const card = runAdapterKnowledgeCapsule([kind, "demo_bill_layout"], "runtime-1");
			expect(card.signatures.some((line) => line.startsWith(`run ${kind} `))).toBe(true);
		}
		// 没人翻过源码的不加，卡片不白长
		for (const kind of ["op", "list", "rule"] as const) {
			expect(runAdapterKnowledgeCapsule([kind, "demo"], "runtime-1").signatures).toEqual([]);
		}
	});
});

describe("run 卡片给真实的目标名留余量", () => {
	it("每种 run 卡片在长目标名、真实 RuntimeKey 下都放得进单张上限", () => {
		// 卡片超上限是在运行时抛的：真机上模板编码一长，run print 就直接报错、一次都跑不起来。
		// 测试里的假目标名和假 RuntimeKey 都短，S27 加规矩时一度只剩 25 字节余量而测试全绿。
		// 这里用 80 个字符的目标名和真实长度的 RuntimeKey 量，逼加字的人当场压短。
		const key = "v0.1.0-095f9c34cdada78f64bc79f1d33bd49e";
		for (const kind of RUN_KINDS) {
			const bytes = Buffer.byteLength(
				renderKnowledgeCapsule(runAdapterKnowledgeCapsule([kind, "x".repeat(80)], key)),
				"utf8",
			);
			expect(bytes, kind).toBeLessThanOrEqual(CAPSULE_SINGLE_BUDGET_BYTES);
		}
	});
});
