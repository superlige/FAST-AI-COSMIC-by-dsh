/**
 * S5.3 -- the impact index.
 *
 * The behaviours pinned here are the ones the frozen implementation's own tests
 * pinned, plus the two cosmic added: the RuntimeKey stamp, and the whole-file
 * refusal when the index on disk is not an ImpactIndex.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	boundForms,
	formPluginSites,
	impact,
	indexStaleReason,
	loadIndex,
	probeDidNotRun,
	type RunProbe,
	refreshIndexIfStale,
} from "../../src/kernel/commands/impact.ts";
import type { ProbeOutcome } from "../../src/kernel/commands/probe.ts";
import { buildCatalog, CATALOG_VERSION, catalogGap, resolveNames } from "../../src/kernel/impact/catalog.ts";
import { formatBuild, formatImpact } from "../../src/kernel/impact/format.ts";
import {
	artifactGap,
	type ImpactIndex,
	impactOf,
	lookup,
	type MetaIndex,
	mergeIndex,
	qualifyField,
	resolveTarget,
	SITE_LABEL,
	SITE_OF_PLUGIN_TYPE,
	type SrcIndex,
	suggest,
} from "../../src/kernel/impact/model.ts";
import { sha256 } from "../../src/runtime/fingerprint.ts";
import { makeContext } from "./fake-context.ts";

function srcIndex(overrides: Partial<SrcIndex> = {}): SrcIndex {
	return {
		kind: "SrcIndex",
		at: "2026-09-01T00:00:00.000Z",
		ms: 100,
		files: 2,
		cpEntries: 10,
		calls: { total: 20, unbound: 0 },
		diagnostics: null,
		classes: [{ class: "com.demo.A", file: "src/A.java", pluginType: "form" }],
		entityRefs: [],
		fieldRefs: [],
		edges: [],
		unknownSigs: [],
		...overrides,
	};
}

const metaIndex = (overrides: Partial<MetaIndex> = {}): MetaIndex => ({
	kind: "MetaIndex",
	at: "2026-09-01T00:00:00.000Z",
	ms: 50,
	scanned: 3,
	bindings: [],
	templates: [],
	fields: [],
	fieldOwners: {},
	fieldsMs: 5,
	...overrides,
});

describe("mergeIndex", () => {
	it("folds source references by class + identifier + access + resolution and counts repeats", () => {
		const index = mergeIndex(
			srcIndex({
				entityRefs: [
					{ class: "com.demo.A", entity: "zlgd_bill", access: "write", resolution: "literal" },
					{ class: "com.demo.A", entity: "zlgd_bill", access: "write", resolution: "literal" },
					{ class: "com.demo.A", entity: "zlgd_bill", access: "read", resolution: "literal" },
				],
			}),
			null,
		);
		const cls = index.classes.find((c) => c.class === "com.demo.A");
		expect(cls?.entities).toEqual([
			{ key: "zlgd_bill", access: "read", resolution: "literal", count: 1 },
			{ key: "zlgd_bill", access: "write", resolution: "literal", count: 2 },
		]);
	});

	it("keeps metadata classes that are not in this project's sources OUT of the index, but counts them", () => {
		const index = mergeIndex(
			srcIndex(),
			metaIndex({
				bindings: [
					{ class: "com.demo.A", entity: "zlgd_bill", kind: "form" },
					{ class: "com.other.Foreign", entity: "other_bill", kind: "form" },
				],
			}),
		);
		expect(index.classes.map((c) => c.class)).toEqual(["com.demo.A"]);
		expect(index.meta?.bindings).toBe(1);
		expect(index.meta?.foreign).toBe(1);
	});

	it("folds one entity's several layouts into a single row carrying the layout count", () => {
		const index = mergeIndex(
			srcIndex(),
			metaIndex({
				bindings: [
					{ class: "com.demo.A", entity: "zlgd_bill", kind: "form" },
					{ class: "com.demo.A", entity: "zlgd_bill", kind: "form" },
					{ class: "com.demo.A", entity: "zlgd_bill", kind: "form", enabled: false },
				],
			}),
		);
		expect(index.classes[0]?.bindings).toEqual([
			{ entity: "zlgd_bill", kind: "form", layouts: 3, enabled: true, numbers: [] },
		]);
	});

	it("accepts a null metadata side -- the static half runs offline and neither may require the other", () => {
		const index = mergeIndex(srcIndex(), null);
		expect(index.meta).toBeNull();
		expect(index.classes).toHaveLength(1);
	});

	it("refuses anything that is not a SrcIndex", () => {
		expect(() => mergeIndex({ kind: "Nope" } as unknown as SrcIndex, null)).toThrow(/不是 SrcIndex/);
	});

	it("stamps the RuntimeKey it was built under (cosmic addition: the frozen index carried no identity)", () => {
		const index = mergeIndex(srcIndex(), null, "2026-09-03T00:00:00.000Z", "v1-abc");
		expect(index.runtimeKeyId).toBe("v1-abc");
	});
});

describe("call-chain propagation", () => {
	const chained = () =>
		mergeIndex(
			srcIndex({
				classes: [
					{ class: "com.demo.Plugin", file: "src/Plugin.java", pluginType: "form" },
					{ class: "com.demo.Util", file: "src/Util.java", pluginType: null },
				],
				entityRefs: [
					{
						class: "com.demo.Util",
						entity: "zlgd_feedback",
						access: "write",
						resolution: "literal",
						inMethod: "com.demo.Util#save",
					},
					{
						class: "com.demo.Util",
						entity: "zlgd_untouched",
						access: "write",
						resolution: "literal",
						inMethod: "com.demo.Util#other",
					},
				],
				edges: [
					{
						from: "com.demo.Plugin#run",
						to: "com.demo.Util#save",
						fromClass: "com.demo.Plugin",
						toClass: "com.demo.Util",
					},
				],
			}),
			null,
		);

	it("traces a write inside a utility class back to the plugin that calls it, with via and hops", () => {
		const plugin = chained().classes.find((c) => c.class === "com.demo.Plugin");
		expect(plugin?.chain).toEqual([
			{
				level: "entity",
				key: "zlgd_feedback",
				access: "write",
				hops: 1,
				via: "com.demo.Util",
				viaMethod: "com.demo.Util#save",
			},
		]);
	});

	it("propagates per METHOD, not per class: an uncalled method of the same utility class does not count", () => {
		const plugin = chained().classes.find((c) => c.class === "com.demo.Plugin");
		expect(plugin?.chain.map((x) => x.key)).not.toContain("zlgd_untouched");
	});

	it("makes chain identifiers reverse-findable, or 'who touched this bill' misses half the callers", () => {
		const index = chained();
		expect(lookup(index).byEntity.get("zlgd_feedback")).toContain("com.demo.Plugin");
	});
});

describe("entry points", () => {
	const index = (): ImpactIndex =>
		mergeIndex(
			srcIndex({
				classes: [{ class: "com.demo.QtyPlugin", file: "biz/QtyPlugin.java", pluginType: "op" }],
				entityRefs: [{ class: "com.demo.QtyPlugin", entity: "zlgd_qty", access: "write", resolution: "literal" }],
				fieldRefs: [{ class: "com.demo.QtyPlugin", field: "zlgd_year", access: "read", resolution: "literal" }],
			}),
			metaIndex({
				fields: [
					{ entity: "zlgd_qty", key: "zlgd_year", level: "header", entry: "" },
					{ entity: "zlgd_other", key: "zlgd_year", level: "header", entry: "" },
				],
				fieldOwners: { zlgd_year: 5 },
			}),
		);

	it("does not require the caller to know whether a term is a class, an entity, a field or a path", () => {
		const idx = index();
		expect(resolveTarget(idx, "com.demo.QtyPlugin")).toEqual([{ kind: "class", value: "com.demo.QtyPlugin" }]);
		expect(resolveTarget(idx, "QtyPlugin")).toEqual([{ kind: "class", value: "com.demo.QtyPlugin" }]);
		expect(resolveTarget(idx, "biz/QtyPlugin.java")).toEqual([{ kind: "class", value: "com.demo.QtyPlugin" }]);
		expect(resolveTarget(idx, "zlgd_qty")).toEqual([{ kind: "entity", value: "zlgd_qty" }]);
		expect(resolveTarget(idx, "zlgd_year")).toEqual([{ kind: "field", value: "zlgd_year" }]);
	});

	it("`entity.field` pins a same-named field to one bill", () => {
		expect(resolveTarget(index(), "zlgd_qty.zlgd_year")).toEqual([
			{ kind: "field", value: "zlgd_year", entity: "zlgd_qty" },
		]);
	});

	it("says out loud that a bare same-named field is a UNION, and how to pin it", () => {
		const idx = index();
		const targets = resolveTarget(idx, "zlgd_year");
		const text = formatImpact(idx, impactOf(idx, targets)).join("\n");
		expect(text).toContain("全库 5 张单据上都有叫 zlgd_year 的字段");
		expect(text).toContain("并集");
	});

	it("stops warning once the entry is qualified", () => {
		const idx = index();
		const targets = resolveTarget(idx, "zlgd_qty.zlgd_year");
		expect(formatImpact(idx, impactOf(idx, targets)).join("\n")).not.toContain("并集");
	});
});

describe("impactOf", () => {
	const idx = mergeIndex(
		srcIndex({
			entityRefs: [
				{ class: "com.demo.A", entity: "zlgd_bill", access: "write", resolution: "literal" },
				{ class: "com.demo.A", entity: "zlgd_ref", access: "read", resolution: "literal" },
				{ class: "com.demo.A", entity: null, access: "read", resolution: "dynamic" },
			],
		}),
		metaIndex({ bindings: [{ class: "com.demo.A", entity: "zlgd_bound", kind: "form" }] }),
	);

	it("separates reads from writes and marks bound entities on their own", () => {
		const impacted = impactOf(idx, resolveTarget(idx, "com.demo.A"));
		expect(impacted.entities).toEqual([
			{ key: "zlgd_bill", how: "写" },
			{ key: "zlgd_bound", how: "绑定" },
			{ key: "zlgd_ref", how: "读" },
		]);
	});

	it("keeps unresolved references out of the list but says where they are -- vanishing silently misreports coverage", () => {
		const impacted = impactOf(idx, resolveTarget(idx, "com.demo.A"));
		expect(impacted.unresolved).toHaveLength(1);
		const text = formatImpact(idx, impacted).join("\n");
		expect(text).toContain("名字扫描认不出的读写 1 处");
		expect(text).toContain("A：?:? 读 单据");
	});
});

describe("「这一族没扫」和「扫了没绑」不能长得一样", () => {
	// 2026-09-04 用户指出「插件注册位置没有扫描完」。当时只扫三张设计态表，
	// 于是 convert / task / api / workflow 四族的插件全部回答「元数据里没有登记」——
	// 一句听起来像结论、实际是「我没查过那里」的话。读的人据此判断「改它不影响别处」。
	const cls = (pluginType: string) => ({
		class: "com.demo.A",
		file: "src/A.java",
		pluginType,
	});

	it("对没扫过的注册位置明说没扫，并点名是哪张表", () => {
		const index = mergeIndex(
			srcIndex({ classes: [cls("convert")] }),
			metaIndex({ sites: ["form", "entity", "print"] }),
		);
		const text = formatImpact(index, impactOf(index, [{ kind: "class", value: "com.demo.A" }])).join("\n");
		expect(text).toContain("这一族的注册位置本次没扫");
		expect(text).toContain("t_botp_convertrule");
		expect(text).toContain("不等于「没挂在任何地方」");
	});

	it("扫过了才说「没有登记」", () => {
		const index = mergeIndex(
			srcIndex({ classes: [cls("convert")] }),
			metaIndex({ sites: ["form", "entity", "print", "task", "api", "convert", "workflow"] }),
		);
		const text = formatImpact(index, impactOf(index, [{ kind: "class", value: "com.demo.A" }])).join("\n");
		expect(text).toContain("元数据里没有登记");
		expect(text).not.toContain("本次没扫");
	});

	it("2026-09-04 之前建的索引没有 sites 字段，按当时那三处算，不按「全都扫过」算", () => {
		// 老索引照样在磁盘上，读它的人拿到的还是同一句假阴性。缺字段要当「只有三处」，
		// 不能当「没写就是都扫了」——后者会把警告吞掉。
		const index = mergeIndex(srcIndex({ classes: [cls("task")] }), metaIndex());
		const text = formatImpact(index, impactOf(index, [{ kind: "class", value: "com.demo.A" }])).join("\n");
		expect(text).toContain("这一族的注册位置本次没扫");
		expect(text).toContain("t_sch_taskdefine");
	});

	it("表单族在三处之内，老索引也不该报没扫", () => {
		const index = mergeIndex(srcIndex({ classes: [cls("list")] }), metaIndex());
		const text = formatImpact(index, impactOf(index, [{ kind: "class", value: "com.demo.A" }])).join("\n");
		expect(text).toContain("元数据里没有登记");
	});

	it("--src-only 时没有元数据侧，源码侧判定的插件类型仍旧交给用户", () => {
		// 用户 2026-09-04 的第二条要求：注册位置固定、出现频率低的那几族，源码扫到了就直接报。
		const index = mergeIndex(srcIndex({ classes: [cls("validator")] }), null);
		const text = formatImpact(index, impactOf(index, [{ kind: "class", value: "com.demo.A" }])).join("\n");
		expect(text).toContain("源码侧判定它是 validator 插件");
	});
});

describe("metadata name catalog", () => {
	const indexWith = (templates: { number: string; entity: string; classes: string[]; name?: string }[]) =>
		({ kind: "ImpactIndex", at: "", classes: [], templates, artifacts: [], fields: [] }) as unknown as ImpactIndex;

	it("is derived only from metadata and carries no requirement-ledger provenance", () => {
		const catalog = buildCatalog(
			indexWith([{ number: "tpl_58", entity: "zlgd_bill", classes: [], name: "实验室检测单" }]),
			"2026-09-09T00:00:00Z",
		);
		expect(catalog.version).toBe(CATALOG_VERSION);
		expect(Object.keys(catalog).sort()).toEqual(["at", "entries", "objects", "version"]);
		expect(Object.keys(catalog.entries[0] ?? {}).sort()).toEqual(["id", "kind", "names", "owner"]);
		expect(resolveNames(catalog, "实验室检测单页序错误")[0]?.entry.id).toBe("tpl_58");
	});

	it("reports honestly when no metadata index is available", () => {
		const catalog = buildCatalog(null, "2026-09-09T00:00:00Z");
		expect(catalog.entries).toEqual([]);
		expect(catalogGap(catalog)).toContain("中文名无从查起");
	});
});

describe("qualifyField", () => {
	const lk = lookup(
		mergeIndex(
			srcIndex(),
			metaIndex({
				fields: [
					{ entity: "zlgd_a", key: "zlgd_x", level: "subentry", entry: "zlgd_sub", parentEntry: "zlgd_entry" },
					{ entity: "zlgd_b", key: "zlgd_x", level: "header", entry: "" },
				],
			}),
		),
	);

	it("settles ownership only when the intersection is exactly one bill", () => {
		expect(qualifyField(lk, new Set(["zlgd_a"]), "zlgd_x").entity).toBe("zlgd_a");
		expect(qualifyField(lk, new Set(["zlgd_a", "zlgd_b"]), "zlgd_x").entity).toBe("");
		expect(qualifyField(lk, new Set(["zlgd_c"]), "zlgd_x").entity).toBe("");
	});

	it("carries the level and owning entry, with the parent for a sub-entry", () => {
		const q = qualifyField(lk, new Set(["zlgd_a"]), "zlgd_x");
		expect(q.level).toBe("subentry");
		expect(q.entry).toBe("zlgd_sub");
		expect(q.parentEntry).toBe("zlgd_entry");
	});
});

describe("suggest", () => {
	const idx = mergeIndex(
		srcIndex({
			classes: [{ class: "com.demo.QtyWtdPlugin", file: "src/QtyWtdPlugin.java", pluginType: null }],
			entityRefs: [
				{ class: "com.demo.QtyWtdPlugin", entity: "zlgd_qty_wtd", access: "read", resolution: "literal" },
			],
		}),
		null,
	);

	it("recognises a case-only mistake", () => {
		expect(suggest(idx, "qtywtdplugin").map((x) => x.value)).toContain("QtyWtdPlugin");
	});

	it("recognises an entity a letter or two off", () => {
		expect(suggest(idx, "zlgd_qty_wtdd").map((x) => x.value)).toContain("zlgd_qty_wtd");
	});

	it("offers nothing at all for an unrelated word -- a guessed name costs more than asking", () => {
		expect(suggest(idx, "database-timeout")).toEqual([]);
	});
});

describe("formatBuild", () => {
	it("reports unregistered overloads and points at the SINKS table", () => {
		const idx = mergeIndex(srcIndex({ unknownSigs: ["kd.Foo#bar(String)"] }), null);
		const text = formatBuild(idx).join("\n");
		expect(text).toContain("未登记的重载 1 个");
		expect(text).toContain("SINKS");
	});

	it("says the index is incomplete when javac reported errors", () => {
		const idx = mergeIndex(srcIndex({ diagnostics: { error: 2, sample: ["A.java:1 错"] } }), null);
		expect(formatBuild(idx).join("\n")).toContain("索引不完整");
	});

	it("prints the metadata side's age every time, because nothing else signals it went stale", () => {
		const idx = mergeIndex(srcIndex(), metaIndex({ at: "2026-08-01T00:00:00.000Z" }));
		const text = formatBuild(idx, Date.parse("2026-09-03T00:00:00.000Z")).join("\n");
		expect(text).toContain("元数据快照 08-01 建，还没查过之后有没有变化");
		expect(text).toContain("截至 33 天前");
	});

	it("says out loud when there is no metadata side at all", () => {
		expect(formatBuild(mergeIndex(srcIndex(), null)).join("\n")).toContain("没有元数据侧");
	});

	it("prints a count for every scanned registration site, zero included", () => {
		// 这条压的正是那次误判：BOTP / 工作流 / 调度任务在索引里明明有 173 条登记，而
		// build 的输出只报了一行「打印模板 66 份」，读的人（人或模型）从沉默里推出
		// 「这三族不在索引里」。**0 是事实，缺一行是猜。**
		const index = mergeIndex(
			srcIndex(),
			metaIndex({
				sites: ["form", "entity", "print", "task", "api", "convert", "workflow"],
				bindings: [{ class: "com.demo.A", entity: "zlgd_bill", kind: "task", layout: "TASK_A" }],
			}),
		);
		const text = formatBuild(index).join("\n");
		expect(text).toContain("调度任务定义 1");
		expect(text).toContain("BOTP 0");
		expect(text).toContain("工作流 0");
		expect(text).toContain("非实体对象 1");
	});

	it("names the sites this scan did not cover instead of letting them read as unbound", () => {
		const text = formatBuild(mergeIndex(srcIndex(), metaIndex())).join("\n");
		expect(text).toContain("没扫");
		expect(text).toContain("不是「没绑」");
	});
});

describe("artifactGap", () => {
	const scanned = (bindings: MetaIndex["bindings"]) =>
		mergeIndex(
			srcIndex(),
			metaIndex({ sites: ["form", "entity", "print", "task", "api", "convert", "workflow"], bindings }),
		);

	it("calls a cached metadata side that predates number retention degraded, not empty", () => {
		// 真机上就是这个形状：meta-index.json 是保留编号之前的接收器写的，3575 条登记里
		// layout 全空。mergeIndex 照样产出 `artifacts: []`，所以判据只看字段在不在的话，
		// 对象通道会安静地回答「没有模板命中」—— 探针文件头写死的那条「假阴性比缺失
		// 危险」，在 TS 这层原样再犯一遍。
		const index = scanned([{ class: "com.demo.A", entity: "zlgd_bill", kind: "print" }]);
		expect(index.artifacts).toEqual([]);
		expect(artifactGap(index)).toContain("一个编号都没收到");
	});

	it("is silent once the numbers are actually there", () => {
		expect(artifactGap(scanned([{ class: "com.demo.A", entity: "zlgd_bill", kind: "print", layout: "21" }]))).toBe(
			"",
		);
	});

	it("separates an index built before retention from one that has no metadata side", () => {
		const { artifacts: _dropped, ...predates } = scanned([
			{ class: "com.demo.A", entity: "zlgd_bill", kind: "print", layout: "21" },
		]);
		expect(artifactGap(predates as ImpactIndex)).toContain("编号保留之前");
		expect(artifactGap(mergeIndex(srcIndex(), null))).toContain("没有元数据侧");
	});
});

describe("registration sites: the probe and the TS side must name the same seven", () => {
	// 加一处扫描而忘了这边，后果不是报错，是**这一族从此按「没绑」输出** —— 探针分得清
	// 「没扫」和「没绑」，TS 侧的表跟不上就把两者又糊回去了。这条把漂移变成红灯。
	const SITES = readFileSync(new URL("../../resources/probes/PluginIndexProbe.java", import.meta.url), "utf8")
		.match(/SITES\s*=\s*java\.util\.Arrays\.asList\(([^)]*)\)/)?.[1]
		?.match(/"([^"]+)"/g)
		?.map((quoted) => quoted.slice(1, -1));

	it("finds the probe's SITES list at all", () => {
		expect(SITES).toEqual(["form", "entity", "print", "task", "api", "convert", "workflow"]);
	});

	it("gives every site a label, or the output prints a raw site name at the user", () => {
		expect(Object.keys(SITE_LABEL).sort()).toEqual([...(SITES ?? [])].sort());
	});

	it("routes every plugin type to a site the probe actually scans", () => {
		const routed = [...new Set(Object.values(SITE_OF_PLUGIN_TYPE))].sort();
		expect(routed).toEqual([...(SITES ?? [])].sort());
	});
});

describe("the impact command", () => {
	const write = (fake: ReturnType<typeof makeContext>, index: ImpactIndex) =>
		fake.fs.put(fake.ctx.layout.impactIndex, JSON.stringify(index));

	it("refuses when the index has not been built, and says how to build it", async () => {
		const fake = makeContext();
		const result = await impact(fake.ctx, { terms: ["com.demo.A"] });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("IMPACT_INDEX_MISSING");
		expect(result.error.remedy).toContain("cosmic_doctor action=reindex");
	});

	it("refuses a file at the index path that is not an ImpactIndex, rather than answering 'nothing touches this'", () => {
		const fake = makeContext();
		fake.fs.put(fake.ctx.layout.impactIndex, JSON.stringify({ kind: "SomethingElse" }));
		const loaded = loadIndex(fake.ctx);
		expect(loaded.ok).toBe(false);
	});

	it("refuses a Chinese phrase that names nothing, and says how to get an identifier", async () => {
		const fake = makeContext();
		write(fake, mergeIndex(srcIndex(), null));
		const result = await impact(fake.ctx, { terms: ["包覆层没带出来"] });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("IMPACT_TARGET_UNKNOWN");
		expect(result.error.remedy).toContain("先探查出字段标识");
	});

	it("reports an index built under another RuntimeKey without refusing it", async () => {
		const fake = makeContext();
		write(fake, mergeIndex(srcIndex(), null, "2026-09-03T00:00:00.000Z", "v9-other-runtime-key"));
		const result = await impact(fake.ctx, { action: "status" });
		expect(result.ok).toBe(true);
		if (!result.ok || result.value.action !== "status") return;
		expect(result.value.sameRuntime).toBe(false);
		expect(result.value.notes.join("\n")).toContain("另一个 RuntimeKey");
	});

	it("hands out identifiers, not a second rendering of what the text already says", async () => {
		const fake = makeContext();
		write(
			fake,
			mergeIndex(
				srcIndex({
					entityRefs: [{ class: "com.demo.A", entity: "zlgd_bill", access: "write", resolution: "literal" }],
					fieldRefs: [
						{
							class: "com.demo.A",
							entity: "zlgd_bill",
							field: "zlgd_qty",
							access: "read",
							resolution: "literal",
						},
					],
				}),
				null,
			),
		);
		const result = await impact(fake.ctx, { terms: ["com.demo.A"] });
		if (!result.ok || result.value.action !== "query") throw new Error("query failed");
		// 标识符一个不少 —— 那是召回底线。
		expect(result.value.impact.classes).toEqual(["com.demo.A"]);
		expect(result.value.impact.entities).toEqual(["zlgd_bill"]);
		// 砍掉的只有「长什么样」：类不再拖 file/pluginType/bindings/chain 整条记录，
		// 实体字段不再各带一句中文 how，未解析引用只留按 resolution 的计数。
		// S17 2.3 加回来的 artifacts 也是标识符（模板 / 任务 / 接口编号），不是渲染。
		expect(Object.keys(result.value.impact)).toEqual([
			"classes",
			"entities",
			"fields",
			"templates",
			"artifacts",
			"unresolved",
		]);
	});

	it("keeps one impact query inside a context budget as the index and the ledger grow", async () => {
		// 压的是**字节**：影响面和召回一样，是每个需求动手前都要跑一次的第一步，
		// 整份报文原样进模型上下文。60 个类 / 20 条老需求的合成索引上曾经一次 14 KB，
		// 其中 8.2 KB 是结构化那半把 text 印过的东西又说一遍。收窄后 6.4 KB。
		// 上限留到 9 KB：任何一次「顺手把 Impact 整个塞回去」都会顶穿它。
		const fake = makeContext();
		const classes = Array.from({ length: 60 }, (_, i) => ({
			class: `com.demo.zlgd.hhx.plugin.SamplePlugin${i}`,
			file: `src/main/java/com/demo/zlgd/hhx/plugin/SamplePlugin${i}.java`,
			pluginType: "form",
		}));
		write(
			fake,
			mergeIndex(
				srcIndex({
					classes,
					entityRefs: classes.map((cls, i) => ({
						class: cls.class,
						entity: `zlgd_bill_${i % 12}`,
						access: "write" as const,
						resolution: "literal" as const,
					})),
					fieldRefs: classes.flatMap((cls, i) =>
						Array.from({ length: 4 }, (_, j) => ({
							class: cls.class,
							entity: `zlgd_bill_${i % 12}`,
							field: `zlgd_field_${j}`,
							access: "read" as const,
							resolution: "literal" as const,
						})),
					),
				}),
				null,
			),
		);
		const result = await impact(fake.ctx, { terms: ["zlgd_bill_1"] });
		if (!result.ok || result.value.action !== "query") throw new Error("query failed");
		expect(result.value.impact.classes.length).toBeGreaterThan(0);
		expect(new TextEncoder().encode(JSON.stringify(result.value)).length).toBeLessThan(9_000);
	});

	it("boundForms says which form the compiled plugin is registered on, at compile time", () => {
		// Simulating the bill's main form when the plugin is registered on a different
		// one costs a full Cosmic start and reports "没生效" -- indistinguishable from a
		// broken plugin. The index knows; the compile is where the answer is needed.
		const fake = makeContext();
		expect(boundForms(fake.ctx, ["D:/proj/src/A.java"])).toEqual([]);
		write(
			fake,
			mergeIndex(srcIndex(), metaIndex({ bindings: [{ class: "com.demo.A", entity: "zlgd_sys_test_lssy" }] })),
		);
		const lines = boundForms(fake.ctx, ["D:/proj/src/A.java"]);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("zlgd_sys_test_lssy");
		expect(lines[0]).toContain("FormSim");
	});

	it("boundForms names the layout, not the entity it belongs to", () => {
		// 复盘二.2：`LSYDFormPlugin 登记在：zlgd_sys_test_bill` 指的是底层实体，真绑定
		// 布局是 zlgd_sys_test_bill_lsyd。照实体去 FormSim，官方 resolveTarget 会落到
		// 实体继续跑，装的是另一份插件清单，于是给出一个「字段本来就空」的假 PASS。
		const fake = makeContext();
		write(
			fake,
			mergeIndex(
				srcIndex(),
				metaIndex({
					bindings: [
						{
							class: "com.demo.A",
							entity: "zlgd_sys_test_bill",
							kind: "form",
							layout: "zlgd_sys_test_bill_lsyd",
						},
					],
				}),
			),
		);
		const lines = boundForms(fake.ctx, ["D:/proj/src/A.java"]);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("zlgd_sys_test_bill_lsyd");
		expect(lines[0]).toContain("实体 zlgd_sys_test_bill");
		expect(lines[0]).toContain("假 PASS");
	});

	it("boundForms 不给布局号时照旧只报实体，不编一个出来", () => {
		const fake = makeContext();
		write(
			fake,
			mergeIndex(srcIndex(), metaIndex({ bindings: [{ class: "com.demo.A", entity: "zlgd_bound", kind: "form" }] })),
		);
		const lines = boundForms(fake.ctx, ["D:/proj/src/A.java"]);
		expect(lines[0]).toContain("zlgd_bound");
		expect(lines[0]).not.toContain("假 PASS");
	});

	it("formPluginSites 在模拟实体前指出插件其实挂在兄弟布局上", () => {
		const fake = makeContext();
		expect(formPluginSites(fake.ctx, "zlgd_sys_test_bill")).toBeNull();
		write(
			fake,
			mergeIndex(
				srcIndex(),
				metaIndex({
					bindings: [
						{
							class: "com.demo.A",
							entity: "zlgd_sys_test_bill",
							kind: "form",
							layout: "zlgd_sys_test_bill_lsyd",
						},
					],
				}),
			),
		);
		expect(formPluginSites(fake.ctx, "zlgd_sys_test_bill")).toMatchObject({
			onTarget: [],
			elsewhere: [{ layout: "zlgd_sys_test_bill_lsyd", classes: ["com.demo.A"] }],
		});
		// 直接点名布局时就没有可提醒的了。
		expect(formPluginSites(fake.ctx, "zlgd_sys_test_bill_lsyd")).toMatchObject({
			onTarget: ["com.demo.A"],
			elsewhere: [],
		});
		expect(formPluginSites(fake.ctx, "zlgd_sys_test_bill")?.snapshot).toMatch(/^快照 \d\d-\d\d/);
	});

	it("formPluginSites 只把表单登记的编号当布局：开放接口、工作流、转换规则的编号不是", () => {
		const fake = makeContext();
		write(
			fake,
			mergeIndex(
				srcIndex({
					classes: [
						{ class: "com.demo.Api", file: "src/Api.java", pluginType: "api" },
						{ class: "com.demo.Wf", file: "src/Wf.java", pluginType: "workflow" },
						{ class: "com.demo.Cv", file: "src/Cv.java", pluginType: "convert" },
						{ class: "com.demo.Task", file: "src/Task.java", pluginType: "task" },
					],
				}),
				metaIndex({
					bindings: [
						{ class: "com.demo.Api", entity: "ap_finapbill", kind: "api", layout: "tzxt_ap_finapbill" },
						{ class: "com.demo.Wf", entity: "ap_finapbill", kind: "workflow", layout: "Proc_ap_audit_1" },
						{ class: "com.demo.Cv", entity: "ap_finapbill", kind: "convert", layout: "1279705439314904064" },
						// 编号恰好和单据同名的调度任务也不是「挂在这张单上」。
						{ class: "com.demo.Task", entity: "ap_finapbill", kind: "task", layout: "ap_finapbill" },
					],
				}),
			),
		);
		expect(formPluginSites(fake.ctx, "ap_finapbill")).toMatchObject({ onTarget: [], elsewhere: [] });
	});

	it("boundForms says so when a plugin has no registration at all, instead of staying silent", () => {
		const fake = makeContext();
		write(fake, mergeIndex(srcIndex(), metaIndex()));
		const lines = boundForms(fake.ctx, ["D:/proj/src/A.java"]);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("查不到登记");
		// 快照之后才挂的不在里面：没有日期，「查不到」读起来就是「没挂」。
		expect(lines[0]).toContain("快照 09-01");
		expect(lines[0]).toContain("还没挂，或是快照之后才挂的");
	});

	it("boundForms 只对表单登记说 FormSim；操作、打印、转换插件只说挂在哪", () => {
		const fake = makeContext();
		write(
			fake,
			mergeIndex(
				srcIndex({
					classes: [
						{ class: "com.demo.A", file: "src/A.java", pluginType: "op" },
						{ class: "com.demo.B", file: "src/B.java", pluginType: "print" },
						{ class: "com.demo.C", file: "src/C.java", pluginType: "convert" },
						{ class: "com.demo.D", file: "src/D.java", pluginType: "form" },
					],
				}),
				metaIndex({
					bindings: [
						{ class: "com.demo.A", entity: "zlgd_qty", kind: "entity", layout: "zlgd_qty" },
						{ class: "com.demo.B", entity: "zlgd_qty", kind: "print", layout: "zlgd_qty_prt1" },
						{ class: "com.demo.C", entity: "zlgd_qty", kind: "convert", layout: "2438474758975651840" },
						{ class: "com.demo.C", entity: "zlgd_test", kind: "convert", layout: "2441536327057986560" },
						{ class: "com.demo.D", entity: "zlgd_qty", kind: "form", layout: "zlgd_qty_lay" },
					],
				}),
			),
		);
		const [op, print, convert, form] = boundForms(fake.ctx, ["src/A.java", "src/B.java", "src/C.java", "src/D.java"]);
		expect(op).toMatch(/^A 登记在：单据操作 zlgd_qty（快照 09-01/);
		expect(op).not.toContain("FormSim");
		expect(print).toContain("B 登记在：打印模板 zlgd_qty_prt1（zlgd_qty）");
		expect(print).not.toContain("FormSim");
		expect(convert).toContain("C 登记在：转换规则 2 条（zlgd_qty、zlgd_test）");
		expect(form).toContain("D 登记在：表单 zlgd_qty_lay（实体 zlgd_qty）");
		expect(form).toContain("FormSim 要挂这个表单");
	});
});

describe("S5 完成条件清点：元数据侧跑不起来时报的是原因，不是「没报出汇总行」", () => {
	// Real machine, 2026-09-04: the shared environment was unreachable (zookeeper
	// timed out), Cosmic shut itself down with exit -1 and eight kilobytes of
	// logback banner, and the metadata side reported "没报出汇总行，索引不收它" --
	// which sends the reader to the probe source, the one place the answer is not.
	const outcome = (exitCode: number): ProbeOutcome => ({
		probe: "PluginIndexProbe",
		src: "probes/PluginIndexProbe.java",
		path: "cold",
		coldReason: null,
		exitCode,
		output: "",
		json: { records: [], broken: [], file: "D:/proj/build/last-probe.json" },
		outputFile: "D:/proj/build/last-probe.out",
		outputLines: { total: 120, shown: 120 },
		stale: { files: 0, lane: "business", mode: "block", action: "none" },
		notes: [],
	});

	it("says nothing when the probe exited cleanly", () => {
		const { ctx } = makeContext();
		expect(probeDidNotRun(ctx, "元数据侧", outcome(0))).toBeNull();
	});

	it("names the exit code, this run's output file and Cosmic's own log", () => {
		const { ctx } = makeContext();
		const note = probeDidNotRun(ctx, "元数据侧", outcome(4294967295));
		expect(note).toContain("4294967295");
		expect(note).toContain("连不上共享环境");
		expect(note).toContain("D:/proj/build/last-probe.out");
		// Where the probe's own output actually went: logback redirects it, so the
		// process's stdout holds only the banner.
		expect(note).toContain("logs/cosmic_out.log");
	});
});

describe("S6 长任务通道：元数据侧复用驻留进程但有固定上限", () => {
	// S5 measured that both scans can exceed the ordinary 120-second deadline.
	// S6 gives only these reviewed kernel callers ten minutes; the model cannot
	// set the timeout and ordinary probes retain the shorter fail-closed limit.
	function buildable(): ReturnType<typeof makeContext> {
		const fake = makeContext({ config: { codeModules: ["demo-biz"] } });
		const layout = fake.ctx.layout;
		fake.fs.put(layout.srcIndexToolSrc, "class SrcIndexTool {}");
		fake.fs.put(`${layout.toolClasses}/SrcIndexTool.class`, "compiled");
		for (const dir of layout.moduleDirs) fake.fs.put(`${dir.src}/demo/A.java`, "class A {}");
		fake.proc.handler = (spec) => {
			if (spec.args.includes("SrcIndexTool")) {
				const out = spec.args[spec.args.indexOf("SrcIndexTool") + 2] as string;
				fake.fs.put(
					out,
					JSON.stringify(
						srcIndex({ fieldRefs: [{ class: "com.demo.A", field: "zlgd_org", mode: "read" }] as never }),
					),
				);
			}
			return { status: 0 };
		};
		return fake;
	}

	function outcome(exitCode: number, records: unknown[]): never {
		return {
			probe: "P",
			src: "probes/P.java",
			path: exitCode === 0 ? "cold" : "cold",
			coldReason: "--cold",
			exitCode,
			output: "",
			json: { records: records as never, broken: [], file: "D:/proj/build/last-probe.json" },
			outputFile: "D:/proj/build/last-probe.out",
			outputLines: { total: 1, shown: 1 },
			stale: { files: 0, lane: "business", mode: "block", action: "none" },
			notes: [],
		} as never;
	}

	it("两个元数据探针都走十分钟的内部时限而不强制冷进程", async () => {
		const fake = buildable();
		const calls: { name: string; cold: boolean | undefined; timeoutMs: number | undefined }[] = [];
		const runProbe = (async (_ctx: unknown, name: string, options?: { cold?: boolean; timeoutMs?: number }) => {
			calls.push({ name, cold: options?.cold, timeoutMs: options?.timeoutMs });
			return {
				ok: true,
				value: outcome(0, [
					{ t: "binding-summary", scanned: 1 },
					{ t: "binding", class: "com.demo.A", entity: "zlgd_bill", kind: "form" },
				]),
			};
		}) as unknown as RunProbe;

		const result = await impact(fake.ctx, { action: "build" }, runProbe);
		expect(result.ok).toBe(true);
		// The change list goes first and is a one-second read; only the two scans get the long deadline.
		expect(calls.map((call) => call.name)).toEqual(["MetaChangeProbe", "PluginIndexProbe", "EntityFieldIndexProbe"]);
		expect(calls.map((call) => call.cold)).toEqual([undefined, undefined, undefined]);
		expect(calls.map((call) => call.timeoutMs)).toEqual([undefined, 600_000, 600_000]);
		if (result.ok && result.value.action === "build") expect(result.value.metadata).toBe(true);
	});

	it("探针非零退出时报的是真实原因，不是「没报出汇总行」", async () => {
		const fake = buildable();
		const runProbe = (async () => ({ ok: true, value: outcome(1, []) })) as unknown as RunProbe;
		const result = await impact(fake.ctx, { action: "build" }, runProbe);
		expect(result.ok).toBe(true);
		if (result.ok && result.value.action === "build") {
			expect(result.value.metadata).toBe(false);
			const notes = result.value.notes.join(" ");
			expect(notes).toContain("探针非零退出");
			expect(notes).not.toContain("没报出汇总行");
		}
	});

	describe("S17 批 1：快照记下这次问了哪些字段、哪些单据", () => {
		// 快照只报名单上的字段。不记名单，「快照里没有」就分不清是「查了没有」还是「根本没问」，
		// 用例过期检查只能二选一地猜 —— 以前猜的是前者，于是把该跑的用例沉了底。
		function probeWith(fieldRecords: unknown[]): RunProbe {
			return (async (_ctx: unknown, name: string) => ({
				ok: true,
				value:
					name === "PluginIndexProbe"
						? outcome(0, [
								{ t: "binding-summary", scanned: 1 },
								{ t: "binding", class: "com.demo.A", entity: "zlgd_bill", kind: "form" },
							])
						: outcome(0, fieldRecords),
			})) as unknown as RunProbe;
		}
		const readMeta = (fake: ReturnType<typeof buildable>) =>
			JSON.parse(fake.ctx.ports.fs.read(`${fake.ctx.layout.impactWork}/meta-index.json`)) as {
				asked?: { fields?: string[]; entities: string[] };
			};

		it("字段归属扫成功时，名单跟着快照一起存", async () => {
			const fake = buildable();
			const result = await impact(
				fake.ctx,
				{ action: "build" },
				probeWith([
					{ t: "field", entity: "zlgd_bill", key: "zlgd_org", level: "header" },
					{ t: "fieldowners", key: "zlgd_org", entities: 10 },
				]),
			);
			expect(result.ok).toBe(true);
			// 单据来自插件挂载关系 —— 正是交给扫描程序、字段收全的那份名单；问过哪些字段没人读，不存。
			expect(readMeta(fake).asked).toEqual({ entities: ["zlgd_bill"] });
		});

		it("扫完一个归属都没报出来，不记名单 —— 否则名单上每个字段都会被当成「已删除」", async () => {
			const fake = buildable();
			await impact(fake.ctx, { action: "build" }, probeWith([]));
			expect(readMeta(fake).asked).toBeUndefined();
		});
	});
});

describe("S17 批 2：把已经算出来的信息交出去", () => {
	const ALL_SITES = ["form", "entity", "print", "task", "api", "convert", "workflow"];
	/** 一个打印插件挂在 58 号模板上、一个任务插件、一个转换插件挂在两条同名的转换规则上。 */
	const named = (): ImpactIndex =>
		mergeIndex(
			srcIndex({
				classes: [
					{ class: "com.demo.PrintA", file: "src/PrintA.java", pluginType: "print" },
					{ class: "com.demo.TaskB", file: "src/TaskB.java", pluginType: "task" },
					{ class: "com.demo.ConvC", file: "src/ConvC.java", pluginType: "convert" },
				],
			}),
			metaIndex({
				sites: ALL_SITES,
				bindings: [
					{ class: "com.demo.PrintA", entity: "zlgd_bill", kind: "print", layout: "58" },
					{ class: "com.demo.TaskB", entity: "zlgd_bill", kind: "task", layout: "TASK_SYNC" },
					{ class: "com.demo.ConvC", entity: "zlgd_bill", kind: "convert", layout: "r1" },
					{ class: "com.demo.ConvC", entity: "zlgd_bill", kind: "convert", layout: "r2" },
				],
				names: [
					{ site: "print", id: "58", name: "金相双语报告" },
					{ site: "task", id: "TASK_SYNC", name: "每日同步检测数据" },
					{ site: "convert", id: "r1", name: "转换规则" },
					{ site: "convert", id: "r2", name: "转换规则" },
				],
			}),
		);
	const withIndex = (index: ImpactIndex) => {
		const fake = makeContext();
		fake.fs.put(fake.ctx.layout.impactIndex, JSON.stringify(index));
		return fake;
	};
	const query = async (fake: ReturnType<typeof makeContext>, terms: string[]) => {
		const result = await impact(fake.ctx, { terms });
		if (!result.ok || result.value.action !== "query") throw new Error("query failed");
		return result.value;
	};

	it("2.1 用户只说了中文名：换成对应的打印模板，再查出挂在上面的插件", async () => {
		const report = await query(withIndex(named()), ["金相双语报告打印不对"]);
		expect(report.text).toContain("中文名「金相双语报告打印不对」→ 打印模板 58「金相双语报告」");
		expect(report.impact.classes).toEqual(["com.demo.PrintA"]);
	});

	it("2.1 一个名字对应多个对象：全部列出、标明有歧义，不替人挑", async () => {
		const report = await query(withIndex(named()), ["转换规则没带出数量"]);
		expect(report.text).toContain("对上了 2 个对象（有歧义）");
		expect(report.text).toContain("BOTP 规则 r1「转换规则」");
		expect(report.text).toContain("BOTP 规则 r2「转换规则」");
		expect(report.text).toContain("先跟用户确认是哪一个");
		expect(report.impact.artifacts.map((row) => row.id)).toEqual(["r1", "r2"]);
	});

	it("2.1 中文名只认完整的名字，碰巧有几个字相同不算", async () => {
		// 「金相报告」和「金相双语报告」有四个字相同，但不是它的名字。以前从需求原话切词当名字，
		// 14 个对象长出 7,215 个「名字」—— 这条防的就是那种「看起来像」。
		const result = await impact(withIndex(named()).ctx, { terms: ["金相报告"] });
		expect(result.ok).toBe(false);
	});

	it("2.1 中文名没对上：说清对照表收了哪几类、几个有名字；快照没单据名时说要完整重建", async () => {
		const result = await impact(withIndex(named()).ctx, { terms: ["发货单"] });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("IMPACT_TARGET_UNKNOWN");
		expect(result.error.remedy).toContain(
			"中文名对照表收单据、打印模板、调度任务、开放接口、转换规则、工作流的设计态名字（4 个对象）",
		);
		expect(result.error.remedy).toContain("单据名要完整重建一次快照才有");
		expect(result.error.remedy).toContain("字段没有中文名可查");
	});

	it("2.1 没有元数据侧时中文名查不了，而且说清楚为什么", async () => {
		const result = await impact(withIndex(mergeIndex(srcIndex(), null)).ctx, { terms: ["金相双语报告"] });
		if (result.ok) throw new Error("expected a refusal");
		expect(result.error.remedy).toContain("没有元数据侧");
	});

	it("2.2 中文名对照表在查询时现算，不读旧版留下的那份文件", async () => {
		// S19 起不再写这份文件；旧版留在 build/ 下的那份哪怕还在、而且比代码关系表旧，也不该影响查询。
		const fake = withIndex(named());
		fake.fs.put(
			`${fake.ctx.layout.projectBuild}/metadata-catalog.json`,
			JSON.stringify({
				version: 3,
				at: "",
				objects: 1,
				entries: [{ kind: "print_template", id: "99", names: ["早就删掉的旧模板"] }],
			}),
		);
		expect((await query(fake, ["金相双语报告"])).impact.classes).toEqual(["com.demo.PrintA"]);
		expect((await impact(fake.ctx, { terms: ["早就删掉的旧模板"] })).ok).toBe(false);
	});

	it("2.3 查一个打印插件：结果里写明它挂在哪个模板上，结构化结果里也有", async () => {
		const report = await query(withIndex(named()), ["PrintA"]);
		expect(report.text).toContain("牵连的元数据对象 1 个");
		expect(report.text).toContain("打印模板 58「金相双语报告」");
		expect(report.impact.artifacts).toEqual([{ kind: "print_template", id: "58", name: "金相双语报告" }]);
	});

	it("2.3 查不全时不说「无」：没扫到和没挂上读起来一样", async () => {
		const report = await query(withIndex(mergeIndex(srcIndex(), null)), ["com.demo.A"]);
		expect(report.text).toContain(
			"牵连的元数据对象：不能据此判断没有打印模板、调度任务、开放接口、转换规则、工作流牵连",
		);
		expect(report.text).not.toContain("牵连的元数据对象（打印模板 / 调度任务 / 开放接口 / 转换规则 / 工作流）（无）");
	});

	it("2.4 调度任务编码直接当入口", async () => {
		expect((await query(withIndex(named()), ["TASK_SYNC"])).impact.classes).toEqual(["com.demo.TaskB"]);
	});

	it("2.4 同名字段的提示用的是真实的参数名 terms", () => {
		const index = mergeIndex(
			srcIndex({ fieldRefs: [{ class: "com.demo.A", field: "zlgd_x", access: "read", resolution: "literal" }] }),
			metaIndex({ fieldOwners: { zlgd_x: 2 } }),
		);
		const text = formatImpact(index, impactOf(index, [{ kind: "field", value: "zlgd_x" }])).join("\n");
		expect(text).toContain('cosmic_impact terms=["<实体标识>.zlgd_x"]');
		expect(text).not.toContain("query=");
	});
});

describe("S17 批 2.6：打开工程时顺带把代码关系表对齐到当前源码", () => {
	/** 工程已构建、有一个源文件，SrcIndexTool 已编译；跑静态侧时写出一份一个类的源码索引。 */
	function project(): ReturnType<typeof makeContext> {
		const fake = makeContext({ config: { codeModules: ["demo-biz"] } });
		const layout = fake.ctx.layout;
		fake.fs.put(layout.srcIndexToolSrc, "class SrcIndexTool {}");
		fake.fs.put(`${layout.toolClasses}/SrcIndexTool.class`, "compiled");
		for (const dir of layout.moduleDirs) fake.fs.put(`${dir.src}/demo/A.java`, "class A {}");
		fake.proc.handler = (spec) => {
			if (spec.args.includes("SrcIndexTool")) {
				const out = spec.args[spec.args.indexOf("SrcIndexTool") + 2] as string;
				fake.fs.put(out, JSON.stringify(srcIndex({ files: 1 })));
			}
			return { status: 0 };
		};
		return fake;
	}
	const javaRuns = (fake: ReturnType<typeof makeContext>) =>
		fake.proc.runs.filter((run) => run.args.includes("SrcIndexTool")).length;
	/** 建表用的扫描工具：和 project() 释放的那份源码一致。 */
	const TOOL = sha256("class SrcIndexTool {}").slice(0, 16);
	/** 一份按当前源码建好的表：同一运行时、同一个扫描工具、同样的文件数、建于源码之后。 */
	const putCurrentIndex = (fake: ReturnType<typeof makeContext>) =>
		fake.fs.put(
			fake.ctx.layout.impactIndex,
			JSON.stringify(
				mergeIndex(srcIndex({ files: 1, tool: TOOL }), null, "2026-09-11T00:00:00.000Z", fake.ctx.runtimeKeyId),
			),
		);

	it("还没有表：重建代码部分", async () => {
		const fake = project();
		const result = await refreshIndexIfStale(fake.ctx);
		expect(result.state).toBe("rebuilt");
		expect(result.text).toContain("还没有代码关系表");
		expect(javaRuns(fake)).toBe(1);
		expect(loadIndex(fake.ctx).ok).toBe(true);
	});

	it("表是最新的：什么都不跑", async () => {
		const fake = project();
		putCurrentIndex(fake);
		expect((await refreshIndexIfStale(fake.ctx)).state).toBe("fresh");
		expect(javaRuns(fake)).toBe(0);
	});

	it("建表之后改过源码：重建，并说清是哪种变化", async () => {
		const fake = project();
		putCurrentIndex(fake);
		const file = `${fake.ctx.layout.moduleDirs[0]?.src}/demo/A.java`;
		fake.fs.put(file, "class A { int x; }", Date.parse("2026-09-12T00:00:00.000Z"));
		expect(indexStaleReason(fake.ctx)).toBe("1 个源文件在建表之后改过");
		expect((await refreshIndexIfStale(fake.ctx)).state).toBe("rebuilt");
	});

	it("扫描工具换了版本（源码没动）：重建，新版认得出的写法才进表；新建的表记下是哪版工具", async () => {
		const fake = project();
		putCurrentIndex(fake);
		fake.fs.put(fake.ctx.layout.srcIndexToolSrc, "class SrcIndexTool { /* 认常量数组 */ }");
		// 新版已经编译好（编译那一步不在这里测）。
		fake.fs.put(`${fake.ctx.layout.toolClasses}/SrcIndexTool.class`, "compiled");
		expect(indexStaleReason(fake.ctx)).toBe("建表的扫描工具换过了");
		expect((await refreshIndexIfStale(fake.ctx)).state).toBe("rebuilt");
		const rebuilt = loadIndex(fake.ctx);
		expect(rebuilt.ok && rebuilt.value.src.tool).toBe(sha256("class SrcIndexTool { /* 认常量数组 */ }").slice(0, 16));
	});

	it("删了源文件（没有更新的修改时间可看）：按文件数认出来", () => {
		const fake = project();
		// 建表时有两个源文件，现在只剩一个，剩下那个也没改过。
		fake.fs.put(
			fake.ctx.layout.impactIndex,
			JSON.stringify(
				mergeIndex(srcIndex({ files: 2, tool: TOOL }), null, "2026-09-11T00:00:00.000Z", fake.ctx.runtimeKeyId),
			),
		);
		expect(indexStaleReason(fake.ctx)).toBe("源文件数变了（建表时 2 个，现在 1 个）");
	});

	it("旧版建的表没记调用关系、外部调用或调用时传的参数：重建，字段才能倒查到挂载插件、归到对的单", () => {
		const fake = project();
		const built = mergeIndex(
			srcIndex({ files: 1, tool: TOOL }),
			null,
			"2026-09-11T00:00:00.000Z",
			fake.ctx.runtimeKeyId,
		);
		const stale = "代码关系表是旧版建的，没记调用关系、外部调用或调用时传的参数";
		const { edges: _edges, ...noEdges } = built;
		fake.fs.put(fake.ctx.layout.impactIndex, JSON.stringify(noEdges));
		expect(indexStaleReason(fake.ctx)).toBe(stale);
		const { effects: _effects, ...noEffects } = built;
		fake.fs.put(fake.ctx.layout.impactIndex, JSON.stringify(noEffects));
		expect(indexStaleReason(fake.ctx)).toBe(stale);
		const { callArgs: _callArgs, ...noArgs } = built;
		fake.fs.put(fake.ctx.layout.impactIndex, JSON.stringify(noArgs));
		expect(indexStaleReason(fake.ctx)).toBe(stale);
	});

	it("查询前发现源码改过：先重建再答，行号对得上当前源码", async () => {
		const fake = project();
		putCurrentIndex(fake);
		const file = `${fake.ctx.layout.moduleDirs[0]?.src}/demo/A.java`;
		fake.fs.put(file, "class A { int x; }", Date.parse("2026-09-12T00:00:00.000Z"));
		const result = await impact(fake.ctx, { terms: ["com.demo.A"] });
		if (!result.ok || result.value.action !== "query") throw new Error("query failed");
		expect(javaRuns(fake)).toBe(1);
		expect(result.value.notes[0]).toContain("已自动重建代码关系表的代码部分");
	});

	it("换了运行时：重建", () => {
		const fake = project();
		fake.fs.put(
			fake.ctx.layout.impactIndex,
			JSON.stringify(mergeIndex(srcIndex({ files: 1 }), null, "2026-09-11T00:00:00.000Z", "v9-other")),
		);
		expect(indexStaleReason(fake.ctx)).toBe("代码关系表建于另一个运行时");
	});

	it("工程还没构建：不碰，绝不因为打开工程去跑 Gradle", async () => {
		const fake = makeContext({ unbuilt: true });
		const result = await refreshIndexIfStale(fake.ctx);
		expect(result.state).toBe("skipped");
		expect(fake.proc.runs).toHaveLength(0);
	});

	it("重建失败：只说一句，不报错", async () => {
		const fake = project();
		fake.proc.handler = () => ({ status: 1, stdout: "boom" });
		const result = await refreshIndexIfStale(fake.ctx);
		expect(result.state).toBe("failed");
		expect(result.text).toContain("不影响继续干活");
	});

	it("只重建代码部分，元数据部分原样沿用，不连环境", async () => {
		const fake = project();
		fake.fs.put(
			`${fake.ctx.layout.impactWork}/meta-index.json`,
			JSON.stringify(metaIndex({ bindings: [{ class: "com.demo.A", entity: "zlgd_bill", kind: "form" }] })),
		);
		const probes: string[] = [];
		const runProbe = (async (_ctx: unknown, name: string) => {
			probes.push(name);
			throw new Error("不该连环境");
		}) as unknown as RunProbe;
		const result = await refreshIndexIfStale(fake.ctx, runProbe);
		expect(result.state).toBe("rebuilt");
		expect(result.text).toContain("元数据部分沿用上次的");
		expect(probes).toEqual([]);
		const index = loadIndex(fake.ctx);
		expect(index.ok && index.value.meta?.bindings).toBe(1);
	});
});
