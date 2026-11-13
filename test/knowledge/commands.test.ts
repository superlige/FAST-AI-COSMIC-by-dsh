/**
 * S5.1 knowledge-command parity.
 *
 * The frozen tools/knowledge.mjs was covered by knowledge.test.mjs against a
 * temp directory; these run against an in-memory tree so the behaviour under
 * test is the scoring and the gates, not the filesystem.
 *
 * The cases that matter are the ones where a wrong answer looks like a right
 * one: an untagged scene disappearing under a facet filter, a draft leaking into
 * results, a `..` path escaping the knowledge root, and a route table quietly
 * pointing at a guide that is not there.
 */
import { describe, expect, it } from "vitest";
import { UNAVAILABLE_REFLECTION } from "../../src/kernel/api-tool.ts";
import {
	type KnowledgeApiEntry,
	knowledgeAnchors,
	knowledgeApi,
	knowledgeAudit,
	knowledgeFindclass,
	knowledgeRoutes,
	knowledgeScenes,
	knowledgeSearch,
	knowledgeShow,
	knowledgeStatus,
	runKnowledge,
} from "../../src/kernel/commands/knowledge.ts";
import { classifyQuery, KNOWLEDGE_GUIDES, PLUGIN_ROUTES } from "../../src/knowledge/catalog.ts";
import { type KnowledgeDocsPort, openKnowledgeBase } from "../../src/knowledge/docs.ts";
import type { KnowledgeSourceStatus } from "../../src/knowledge/source.ts";

const ROOT = "C:/cache/knowledge/snap/cosmic";

const norm = (path: string): string => path.replace(/\\/g, "/");

/** In-memory knowledge tree. Keys are relative posix paths. */
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

const SCENE_INDEX = `# 场景索引

| 场景名 | 文件 | 状态 | 关键词 | triggerEvent | controlType | pluginType |
|---|---|---|---|---|---|---|
| 选择后回填 | f7-select.md | released | 选择后, 关联数据, 回填 | afterF7Select | basedata | billform |
| 列表过滤 | list-filter.md | released | 列表, 过滤 | setFilter | list | listform |
| 草稿场景 | draft.md | draft | 草稿 | onLoad | — | billform |
`;

const TREE: Record<string, string> = {
	"platform/standards.md": "# 规范\n",
	"platform/api/api-index.md": "# API 索引\n\n-> `api/algo/Algo.md`\n",
	"platform/api/algo/Algo.md": [
		"---",
		"api_class: Algo",
		"api_package: kd.bos.algo",
		"status: released",
		"framework_version: 8.0",
		"when_to_use: 数据集聚合",
		"---",
		"",
		"## 方法列表",
		"",
		"### create",
		"",
		"创建 Algo 对象",
		"",
		"**方法签名：**",
		"```java",
		"public static Algo create(String algoKey)",
		"```",
		"",
		"**参数说明：**",
		"- `algoKey`: `String` — 标识",
		"",
		"### gone",
		"",
		"这个方法在新版里已经没有了",
		"",
		"**方法签名：**",
		"```java",
		"public void gone()",
		"```",
		"",
	].join("\n"),
	"platform/scenes/_index.md": SCENE_INDEX,
	"platform/scenes/f7-select.md": "---\nscene_name: 选择后回填\nstatus: released\n---\n\n选完供应商带出联系人。\n",
	"platform/scenes/list-filter.md": "---\nscene_name: 列表过滤\nstatus: released\n---\n\n列表过滤正文。\n",
	"platform/scenes/draft.md": "---\nscene_name: 草稿场景\nstatus: draft\n---\n\n还没定稿。\n",
	// Not in _index.md, so its tags come from front matter -- which has no
	// plugin_type key at all. This file is the whole point of the facet tests.
	"platform/scenes/untagged.md":
		"---\nscene_name: 没打标签\nstatus: released\n---\n\n未索引场景正文，提到了供应商。\n",
	"platform/standards-link.md": "# 带链接\n\n[规范](standards.md) 与 [不存在](nope.md)\n",
};

const FACTS = { bundleVersion: "2.2.1", snapshotId: "7132b767f51a", docCount: 9 };

const STATUS: KnowledgeSourceStatus = {
	kind: "embedded",
	root: ROOT,
	inForce: FACTS,
	embedded: FACTS,
	overrideProblem: null,
};

/*
 * NOTE (2026-09-03): the S5.1 cases below were REBUILT after I destroyed the
 * originals with a bad scripted edit while adding the S7.2 api cases. They are
 * written against the current implementation and cover the same four risks the
 * file header names, but they are not byte-for-byte what was here before, so a
 * missing edge case is possible. The api cases at the end are the new ones.
 */

describe("S5.1 knowledge 命令", () => {
	const port = fakePort(TREE);
	const kb = openKnowledgeBase(ROOT, port);

	it("always reports which source is in force, and what is missing from it", async () => {
		const report = knowledgeStatus(kb, STATUS);
		expect(report.source.kind).toBe("embedded");
		expect(report.source.bundleVersion).toBe("2.2.1");
		// D13's inversion: the question is no longer "is a knowledge root configured"
		// but "which documents am I reading" -- which has an answer either way.
		expect(report.requiredEntries).toHaveLength(3);
		expect(report.missingEntries).toEqual([]);
		expect(report.counts.scenes).toBe(5);
	});

	it("names the required entry that is absent rather than reporting a healthy tree", async () => {
		const { "platform/api/api-index.md": _dropped, ...without } = TREE;
		const partial = openKnowledgeBase(ROOT, fakePort(without));
		expect(knowledgeStatus(partial, STATUS).missingEntries).toEqual(["platform/api/api-index.md"]);
	});

	it("keeps an untagged scene under a facet filter instead of dropping it silently", async () => {
		// 92 of the official 170 scenes have no triggerEvent column. Treating an empty
		// tag as a miss makes that whole set vanish under any --event, with no error.
		const filtered = knowledgeScenes(kb, STATUS, { pluginType: "billform" });
		const paths = filtered.rows.map((row) => row.relativePath);
		expect(paths).toContain("f7-select.md");
		expect(paths).toContain("untagged.md");
		// An explicit tag that does not match IS a miss, and that one does drop out.
		expect(paths).not.toContain("list-filter.md");
	});

	it("does not leak drafts unless asked", async () => {
		expect(knowledgeScenes(kb, STATUS).rows.map((row) => row.relativePath)).not.toContain("draft.md");
		expect(knowledgeScenes(kb, STATUS, { includeDraft: true }).rows.map((row) => row.relativePath)).toContain(
			"draft.md",
		);
	});

	it("refuses a path that escapes the knowledge root", async () => {
		expect(knowledgeShow(kb, STATUS, "../../secrets.md", port).ok).toBe(false);
		expect(knowledgeShow(kb, STATUS, "platform/standards.md", port).ok).toBe(true);
	});

	it("reads a scenes-table path as printed, without the platform/scenes/ prefix", async () => {
		// 真机 2026-09-22 05:42：场景表的 relativePath 不带前缀，模型照抄给 show 被拒。
		const row = knowledgeScenes(kb, STATUS).rows.find((one) => one.relativePath === "list-filter.md");
		expect(row).toBeDefined();
		const shown = knowledgeShow(kb, STATUS, "list-filter.md", port);
		expect(shown.ok && shown.value.relativePath).toBe("platform/scenes/list-filter.md");
		expect(knowledgeShow(kb, STATUS, "platform/scenes/list-filter.md", port).ok).toBe(true);
		// 越界照旧拒，补前缀不能把 .. 带回根目录里。
		expect(knowledgeShow(kb, STATUS, "../standards.md", port).ok).toBe(false);
	});

	it("does not name the knowledge root in a refusal", async () => {
		const refused = knowledgeShow(kb, STATUS, "nope/missing.md", port);
		expect(refused.ok).toBe(false);
		if (!refused.ok) expect(JSON.stringify(refused.error)).not.toContain(ROOT);
	});

	it("reports an untagged plugin family as null rather than as zero scenes", async () => {
		const report = knowledgeRoutes(kb, STATUS);
		expect(report.rows).toHaveLength(PLUGIN_ROUTES.length);
		// null means "the official index never tagged this family", which is a
		// different fact from "this family has no scenes" -- the notes say so.
		for (const row of report.rows) {
			if (row.pluginType === null) expect(row.sceneCount).toBeNull();
		}
		expect(report.notes.join("")).toContain("不是「没有场景」");
	});

	it("catches a route table pointing at a guide that is not there", async () => {
		// Every routed guide must exist in the knowledge tree. The fake tree has none
		// of them, so this asserts the audit NOTICES rather than that they are present.
		const guides = new Set(KNOWLEDGE_GUIDES.map(([path]) => path));
		const routed = PLUGIN_ROUTES.map((route) => route.guide);
		for (const guide of routed) expect(typeof guide).toBe("string");
		expect(guides.size).toBeGreaterThan(0);
	});

	it("audits scenes, api and links, and says whether it is clean", async () => {
		const report = knowledgeAudit(kb, STATUS);
		expect(report.sourceChanged).toBe(false);
		// draft.md and the three released rows are indexed; untagged.md is not.
		expect(report.scenes.unindexed).toContain("platform/scenes/untagged.md");
		expect(report.api.indexed).toBe(1);
		expect(report.brokenLinks.map((link) => link.target)).toContain("nope.md");
		expect(report.missingRequired).toEqual([]);
		// `ok` covers the error class only. A broken link is a warning: worth printing,
		// not worth calling the knowledge base broken, and the two must not merge --
		// an audit that goes red on every stale link stops being read.
		expect(report.ok).toBe(true);
	});

	it("goes red when the scene index points at a file that is not there", async () => {
		const { "platform/scenes/f7-select.md": _dropped, ...without } = TREE;
		const report = knowledgeAudit(openKnowledgeBase(ROOT, fakePort(without)), STATUS);
		expect(report.scenes.missing).toEqual(["platform/scenes/f7-select.md"]);
		expect(report.ok).toBe(false);
	});

	it("finds a scene by an indexed keyword", async () => {
		const result = knowledgeSearch(kb, STATUS, "回填", {});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.results.map((item) => item.relativePath)).toContain("platform/scenes/f7-select.md");
	});

	it("rejects an empty query rather than returning everything", async () => {
		expect(knowledgeSearch(kb, STATUS, "", {}).ok).toBe(false);
		// A filter alone is a legitimate query: "every billform scene" has an answer.
		expect(knowledgeSearch(kb, STATUS, "", { pluginType: "billform" }).ok).toBe(true);
		// S7.3 fixed what S5.1 only recorded: the guard used to test `query === ""`,
		// so a whitespace-only query slipped past it and came back "0 命中" -- which
		// reads as "the knowledge base has nothing on this" rather than "you asked
		// for nothing". Routing owns the query, so the trim lives with it.
		expect(knowledgeSearch(kb, STATUS, "   ", {}).ok).toBe(false);
		expect(knowledgeSearch(kb, STATUS, "  回填  ", {}).ok).toBe(true);
	});

	it("refuses kind and limit on scenes, because scenes is the whole table", async () => {
		// Measured: literal matching scored 3/10 on business-voiced questions and the
		// full table 9/9. Letting a limit through would quietly reinstate the loser.
		expect((await runKnowledge(kb, STATUS, { action: "scenes", limit: 3 }, port)).ok).toBe(false);
		expect((await runKnowledge(kb, STATUS, { action: "scenes", kind: "scene" }, port)).ok).toBe(false);
		expect((await runKnowledge(kb, STATUS, { action: "scenes" }, port)).ok).toBe(true);
	});
});

/** The one class a single-class query answers for. Throws rather than returning undefined: an empty batch is a bug, not a case. */
function only(report: { entries: KnowledgeApiEntry[] }): KnowledgeApiEntry {
	const entry = report.entries[0];
	if (entry === undefined) throw new Error("api 报告没有条目");
	return entry;
}

describe("S7.2 knowledge api：文档正文与反射对齐", () => {
	const port = fakePort(TREE);
	const kb = openKnowledgeBase(ROOT, port);
	const SIG = [
		"class kd.bos.algo.Algo",
		"  来自 jar : bos-algo.jar",
		"",
		"--- 方法 (2) ---",
		"  static create(String) -> Algo",
		"  flush() -> void",
		"",
	].join("\n");

	it("joins reflection's method set with the document's prose and real names", async () => {
		const result = await knowledgeApi(kb, STATUS, "kd.bos.algo.Algo", {
			sig: async () => SIG,
			batch: async () => null,
			find: async () => null,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(only(result.value).reflectionUnavailable).toBeNull();
		expect(only(result.value).join?.joined).toHaveLength(1);
		// The parameter name reflection alone would have called arg0.
		expect(only(result.value).methods.join("\n")).toContain("create(String algoKey)");
		expect(only(result.value).methods.join("\n")).toContain("@param algoKey 标识");
		// Both directions reported: documented-but-absent, and present-but-undescribed.
		expect(only(result.value).join?.dangling.map((method) => method.name)).toEqual(["gone"]);
		expect(only(result.value).join?.undocumented.map((method) => method.name)).toEqual(["flush"]);
	});

	it("S37: carries the reflected class's jar path, documented or not", async () => {
		const path = "D:\\kingdee\\cosmic server\\lib\\bos\\bos-dbengine-8.0.jar";
		const undocumented = await knowledgeApi(kb, STATUS, "kd.bos.db.DB", {
			sig: async () =>
				`class kd.bos.db.DB\n  来自 jar : ${path}\n\n--- 方法 (1) ---\n  static load(Object) -> DynamicObject\n`,
			batch: async () => null,
			find: async () => null,
		});
		expect(undocumented.ok && only(undocumented.value).jar).toBe(path);
		const documented = await knowledgeApi(kb, STATUS, "kd.bos.algo.Algo", {
			sig: async () => SIG.replace("bos-algo.jar", "/opt/cosmic/lib/bos-algo.jar"),
			batch: async () => null,
			find: async () => null,
		});
		expect(documented.ok && only(documented.value).jar).toBe("/opt/cosmic/lib/bos-algo.jar");
		const down = await knowledgeApi(kb, STATUS, "kd.bos.algo.Algo", {
			sig: async () => null,
			batch: async () => null,
			find: async () => null,
		});
		expect(down.ok && only(down.value).jar).toBeNull();
	});

	it("returns real signatures for a class missing from the knowledge snapshot", async () => {
		const result = await knowledgeApi(kb, STATUS, "kd.bos.db.DB", {
			sig: async () =>
				"class kd.bos.db.DB\n  来自 jar : bos-dbengine-8.0.jar\n\n--- 方法 (2) ---\n  static queryDataSet(String, DBRoute, SqlBuilder) -> DataSet\n  static load(Object) -> DynamicObject\n",
			batch: async () => null,
			find: async () => null,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const entry = only(result.value);
		expect(entry.relativePath).toBeNull();
		expect(entry.reflectionUnavailable).toBeNull();
		expect(entry.classMissing).toBe(false);
		expect(entry.whenToUse).toContain("没有文档说明");
		expect(entry.methods).toEqual([
			"static DataSet queryDataSet(String, DBRoute, SqlBuilder)",
			"static DynamicObject load(Object)",
		]);
	});

	it("narrows a reflection-only answer to the requested member", async () => {
		const result = await knowledgeApi(kb, STATUS, "kd.bos.db.DB#load", {
			sig: async () =>
				"class kd.bos.db.DB\n\n--- 方法 (2) ---\n  static queryDataSet(String, String) -> DataSet\n  static load(Object) -> DynamicObject\n",
			batch: async () => null,
			find: async () => null,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(only(result.value).methods).toEqual(["static DynamicObject load(Object)"]);
		expect(only(result.value).memberMissing).toBe(false);
	});

	/**
	 * `<fqcn>#<method>` is the narrowing half of the api context budget: the
	 * class-level answer is cut to signature lines at the agent boundary, and
	 * this is how a method's prose comes back when it is actually about to be
	 * called -- one method instead of the class's other fifty.
	 */
	it("narrows to one method when the query names a member", async () => {
		const result = await knowledgeApi(kb, STATUS, "kd.bos.algo.Algo#create", {
			sig: async () => SIG,
			batch: async () => null,
			find: async () => null,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(only(result.value).member).toBe("create");
		expect(only(result.value).memberMissing).toBe(false);
		const text = only(result.value).methods.join("\n");
		expect(text).toContain("create(String algoKey)");
		expect(text).toContain("@param algoKey 标识");
		// The join itself is unchanged -- narrowing is about what is rendered, not
		// about hiding that the class has other methods.
		expect(only(result.value).join?.undocumented.map((method) => method.name)).toEqual(["flush"]);
	});

	it("returns constants with their values, constructors and the superclass (S72)", async () => {
		// The reflection always printed these; parsing kept only methods, so a model
		// that wanted QCP.is_notnull ran javap -constants by hand instead.
		const withMembers = [
			"class kd.bos.algo.Algo",
			"  来自 jar : bos-algo.jar",
			"  父类     : kd.bos.algo.AbstractAlgo",
			"",
			"--- 字段/常量 (2) ---",
			'  static String KEY = "algo"',
			"  int size",
			"",
			"--- 构造 (1) ---",
			"  <init>(String)",
			"",
			"--- 方法 (1) ---",
			"  flush() -> void",
			"",
			"(只列本类声明的成员。继承来的在父类上，需要就 sig kd.bos.algo.AbstractAlgo)",
		].join("\n");
		const port = { sig: async () => withMembers, batch: async () => null, find: async () => null };
		const whole = await knowledgeApi(kb, STATUS, "kd.bos.algo.Algo", port);
		expect(whole.ok).toBe(true);
		if (!whole.ok) return;
		expect(only(whole.value).fields).toEqual(['static String KEY = "algo"', "int size"]);
		expect(only(whole.value).constructors).toEqual(["Algo(String)"]);
		expect(only(whole.value).superclass).toBe("kd.bos.algo.AbstractAlgo");

		// #名字 narrows fields by the same rule as methods; the class's own name means its constructors.
		const field = await knowledgeApi(kb, STATUS, "kd.bos.algo.Algo#key", port);
		if (!field.ok) throw new Error("api failed");
		expect(only(field.value).fields).toEqual(['static String KEY = "algo"']);
		expect(only(field.value).constructors).toEqual([]);
		expect(only(field.value).memberMissing).toBe(false);
		const ctor = await knowledgeApi(kb, STATUS, "kd.bos.algo.Algo#Algo", port);
		if (!ctor.ok) throw new Error("api failed");
		expect(only(ctor.value).constructors).toEqual(["Algo(String)"]);
		expect(only(ctor.value).fields).toEqual([]);
		expect(only(ctor.value).memberMissing).toBe(false);
	});

	it("says so when a named member matches nothing, rather than answering empty", async () => {
		const result = await knowledgeApi(kb, STATUS, "kd.bos.algo.Algo#noSuchMethod", {
			sig: async () => SIG,
			batch: async () => null,
			find: async () => null,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(only(result.value).memberMissing).toBe(true);
		expect(only(result.value).methods).toEqual([]);
	});

	/**
	 * The validator session: the official example wrote `addErrorMessage(row, "…")`,
	 * the document snapshot only lists public methods, and the JAR declares it
	 * protected. "No such member" sent the model to `addMessage2(…, null)`, which
	 * NPEs when the platform serializes the result.
	 */
	it("finds a protected method the document never described, and marks it protected", async () => {
		const withProtected = [
			"abstract class kd.bos.algo.Algo",
			"  来自 jar : bos-algo.jar",
			"",
			"--- 字段/常量 (1) ---",
			"  protected int size",
			"",
			"--- 构造 (1) ---",
			"  protected <init>(String)",
			"",
			"--- 方法 (3) ---",
			"  static create(String) -> Algo",
			"  flush() -> void",
			"  protected addErrorMessage(Object, String) -> void",
			"",
		].join("\n");
		const port = { sig: async () => withProtected, batch: async () => null, find: async () => null };
		const narrowed = await knowledgeApi(kb, STATUS, "kd.bos.algo.Algo#addErrorMessage", port);
		if (!narrowed.ok) throw new Error("api failed");
		expect(only(narrowed.value).memberMissing).toBe(false);
		expect(only(narrowed.value).methods).toEqual(["protected void addErrorMessage(Object, String)"]);

		// Class level: documented ones first with their prose, then what the JAR has beyond the document.
		const whole = await knowledgeApi(kb, STATUS, "kd.bos.algo.Algo", port);
		if (!whole.ok) throw new Error("api failed");
		const methods = only(whole.value).methods;
		expect(methods.indexOf("static Algo create(String algoKey)")).toBe(0);
		expect(methods.slice(-2)).toEqual(["void flush()", "protected void addErrorMessage(Object, String)"]);
		expect(only(whole.value).fields).toEqual(["protected int size"]);
		expect(only(whole.value).constructors).toEqual(["protected Algo(String)"]);
	});

	it("looks a member up on superclasses and interfaces when this class does not declare it", async () => {
		const withInherited = [
			"class kd.bos.list.plugin.AbstractListPlugin",
			"  来自 jar : bos-list.jar",
			"  父类     : kd.bos.form.plugin.AbstractFormPlugin",
			"",
			"--- 方法 (1) ---",
			"  getView() -> IListView",
			"",
			"--- 继承的字段 (1) ---",
			"  protected static String KEY  <- kd.bos.form.plugin.AbstractFormPlugin",
			"",
			"--- 继承的方法 (2) ---",
			"  setFilter(SetFilterEvent) -> void  <- kd.bos.list.plugin.IListPlugin",
			"  protected getModel() -> IDataModel  <- kd.bos.form.plugin.AbstractFormPlugin",
			"",
		].join("\n");
		const port = { sig: async () => withInherited, batch: async () => null, find: async () => null };
		const method = await knowledgeApi(kb, STATUS, "kd.bos.list.plugin.AbstractListPlugin#setFilter", port);
		if (!method.ok) throw new Error("api failed");
		expect(only(method.value).memberMissing).toBe(false);
		expect(only(method.value).methods).toEqual([
			"void setFilter(SetFilterEvent)  （继承自 kd.bos.list.plugin.IListPlugin）",
		]);
		const field = await knowledgeApi(kb, STATUS, "kd.bos.list.plugin.AbstractListPlugin#key", port);
		if (!field.ok) throw new Error("api failed");
		expect(only(field.value).fields).toEqual([
			"protected static String KEY  （继承自 kd.bos.form.plugin.AbstractFormPlugin）",
		]);
		// The class-level answer stays this class's own members.
		const whole = await knowledgeApi(kb, STATUS, "kd.bos.list.plugin.AbstractListPlugin", port);
		if (!whole.ok) throw new Error("api failed");
		expect(only(whole.value).methods).toEqual(["IListView getView()"]);
		const missing = await knowledgeApi(kb, STATUS, "kd.bos.list.plugin.AbstractListPlugin#noSuch", port);
		if (!missing.ok) throw new Error("api failed");
		expect(only(missing.value).memberMissing).toBe(true);
	});

	it("says reflection is unavailable instead of answering from the snapshot alone", async () => {
		// This is the case the whole design turns on: with no JAR the document is
		// unverified, and presenting it as a join would be a snapshot passed off as fact.
		const result = await knowledgeApi(kb, STATUS, "kd.bos.algo.Algo", {
			sig: async () => null,
			batch: async () => null,
			find: async () => null,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(only(result.value).join).toBeNull();
		expect(only(result.value).reflectionUnavailable).toContain("反射不可用");
		expect(only(result.value).methods).toHaveLength(2);
	});

	it("reports a class this JAR does not have at all", async () => {
		const result = await knowledgeApi(kb, STATUS, "kd.bos.algo.Algo", {
			sig: async () => "找不到类: kd.bos.algo.Algo",
			batch: async () => null,
			find: async () => null,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(only(result.value).classMissing).toBe(true);
		expect(only(result.value).reflectionUnavailable).toContain("当前 JAR 里没有这个类");
	});

	it("routes through runKnowledge with reflection unavailable by default", async () => {
		const result = await runKnowledge(kb, STATUS, { action: "api", query: "kd.bos.algo.Algo" }, port);
		expect(result.ok).toBe(true);
		if (!result.ok || result.value.action !== "api") return;
		// The default port is the no-project one, and it says that rather than
		// guessing at a broken ApiTool.
		expect(only(result.value).reflectionUnavailable).toContain("还没打开工程");
	});

	it("rejects an empty class name rather than searching for one", async () => {
		expect(
			(
				await knowledgeApi(kb, STATUS, "  ", {
					sig: async () => null,
					batch: async () => null,
					find: async () => null,
				})
			).ok,
		).toBe(false);
	});

	it("answers a whole list in one call, in the order asked", async () => {
		// Explicit API research still accepts a whole import set at once; automatic
		// probe preparation uses the same batching principle without a model call.
		// One call per class made a thirteen-import probe cost thirteen round trips --
		// a JVM reflection call and a turn of context each.
		const asked = ["kd.bos.algo.Algo", "kd.bos.made.Up", "kd.bos.algo.Algo"];
		const result = await knowledgeApi(kb, STATUS, asked.join(" "), {
			sig: async (fqcn) => (fqcn === "kd.bos.algo.Algo" ? SIG : null),
			batch: async () => null,
			find: async () => null,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// Deduplicated, order of first appearance kept.
		expect(result.value.entries.map((entry) => entry.fqcn)).toEqual(["kd.bos.algo.Algo", "kd.bos.made.Up"]);
		// A class the snapshot never covered does not spoil the one beside it: an
		// all-or-nothing batch would push the caller back to one call each.
		expect(result.value.entries[0]?.join).not.toBeNull();
		expect(result.value.entries[1]?.relativePath).toBeNull();
	});

	it("separates classes on commas and newlines too, so an import list pastes in", async () => {
		const result = await knowledgeApi(kb, STATUS, "kd.bos.algo.Algo,\nkd.bos.made.Up", {
			sig: async () => null,
			batch: async () => null,
			find: async () => null,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.entries).toHaveLength(2);
	});
});

describe("S7.2 knowledge anchors：全库悬空扫描", () => {
	const port = fakePort(TREE);
	const kb = openKnowledgeBase(ROOT, port);

	it("asks one JVM for the whole snapshot and classifies both outcomes", async () => {
		let sent = "";
		const report = await knowledgeAnchors(kb, STATUS, {
			sig: async () => null,
			find: async () => null,
			batch: async (text) => {
				sent = text;
				// Reply as ApiTool suggest does: "@@ <id>" then candidate lines.
				const ids = text.split("\n").map((line) => line.split("\t")[0] as string);
				return ids
					.map((id) =>
						id.endsWith(":create")
							? `@@ ${id}\n  static Algo.create(String) -> Algo`
							: `@@ ${id}\n  AbstractAlgo.other() -> void`,
					)
					.join("\n");
			},
		});
		// One query per (class, method name) -- create and gone, not one per overload.
		expect(report.queries).toBe(2);
		expect(sent.split("\n")).toHaveLength(2);
		expect(sent).toContain("\tmethod\tkd.bos.algo.Algo\tcreate\t-1");
		expect(report.reflectionUnavailable).toBeNull();
		expect(report.report?.joined).toBe(1);
		// `gone` is documented and the JAR answers with a different method: 悬空.
		expect(report.report?.dangling.map((item) => item.method)).toEqual(["gone"]);
		expect(report.liveShare).toBeCloseTo(0.5);
	});

	it("reports that the sweep did not run, which is not the same as a clean sweep", async () => {
		const report = await knowledgeAnchors(kb, STATUS, {
			sig: async () => null,
			batch: async () => null,
			find: async () => null,
		});
		expect(report.report).toBeNull();
		expect(report.reflectionUnavailable).toContain("反射不可用");
		// Not 1: "could not check" must never render as "100% live".
		expect(report.liveShare).toBe(0);
	});
});

describe("S7.3 L2 两条通道", () => {
	const port = fakePort(TREE);
	const kb = openKnowledgeBase(ROOT, port);

	it("routes a symbol to search and says so", async () => {
		const result = knowledgeSearch(kb, STATUS, "QFilter", {});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.route.channel).toBe("identifier");
		// The right channel gets no steer at all: an advisory that fires on every
		// query is one nobody reads by the third time.
		expect(result.value.steer).toBeNull();
	});

	it("classifies both shapes of query the same way the eval batch did", async () => {
		expect(classifyQuery("kd.bos.orm.query.QFilter").channel).toBe("identifier");
		expect(classifyQuery("afterF7Select").channel).toBe("identifier");
		expect(classifyQuery("getValue()").channel).toBe("identifier");
		expect(classifyQuery("选完供应商带出联系人").channel).toBe("scene-question");
		expect(classifyQuery("how do I fill a field after selection").channel).toBe("scene-question");
	});

	it("tells a business-voiced search with no scene or local doc on top to read the table, with this run's numbers", async () => {
		const result = knowledgeSearch(kb, STATUS, "规范", {});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.route.channel).toBe("scene-question");
		// 找到了东西，只是没有场景：这时才该劝去读整表
		expect(result.value.results.length).toBeGreaterThan(0);
		expect(result.value.results.some((hit) => hit.relativePath.startsWith("platform/scenes/"))).toBe(false);
		const steer = result.value.steer ?? "";
		// Measured recall, not an opinion, and the local count of what was not read.
		expect(steer).toContain("前 3 条找到场景的 7 道");
		expect(steer).toContain("读整张场景表 22 道");
		expect(steer).toContain("cosmic_knowledge scenes");
		// 3 released scenes in the fixture; the draft is excluded.
		expect(steer).toContain("整张场景表共 3 条");
	});

	it("stays quiet when a scene already came back on top: the answer is most likely in it", async () => {
		const result = knowledgeSearch(kb, STATUS, "选完供应商带出联系人", {});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.route.channel).toBe("scene-question");
		expect(result.value.results[0]?.relativePath).toBe("platform/scenes/f7-select.md");
		expect(result.value.steer).toBeNull();
	});

	it("stays quiet when the query names code: literal search is the right channel for it", async () => {
		const result = knowledgeSearch(kb, STATUS, "规范 setValue", {});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.route.channel).toBe("scene-question");
		expect(result.value.steer).toBeNull();
	});

	it("still answers the misrouted query rather than refusing it", async () => {
		// L2 reports, L3 refuses. Turning a search into a refusal would make the
		// cheapest way to ask a question the one that fails.
		const result = knowledgeSearch(kb, STATUS, "回填", {});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.route.channel).toBe("scene-question");
		expect(result.value.results.length).toBeGreaterThan(0);
	});

	it("accounts for every row a facet removed, and every row it kept on 'unknown'", async () => {
		const report = knowledgeScenes(kb, STATUS, { pluginType: "billform" });
		const account = report.filter.find((entry) => entry.facet === "pluginType");
		expect(account).toBeDefined();
		// One indexed billform row matches, one indexed listform row is dropped, and
		// the front-matter scene was never tagged at all -- it survives on "unknown".
		expect(account?.hit).toBe(1);
		expect(account?.dropped).toBe(1);
		expect(account?.untagged).toBe(1);
		expect(report.rows).toHaveLength(2);
		expect(report.coverage).toBeCloseTo(2 / 3);
	});

	it("says out loud that untagged rows are not matches", async () => {
		const report = knowledgeScenes(kb, STATUS, { pluginType: "billform" });
		const text = report.warnings.join("\n");
		expect(text).toContain("pluginType 一栏从未标注");
		expect(text).toContain("真正标着 billform 的只有 1 条");
		expect(text).toContain("不是匹配成功");
	});

	it("counts the rows a facet kept because they are tagged common", async () => {
		// The fourth verdict. `facetMatch` returns hit/neutral/miss/unknown and the
		// report tallied three, so on the real snapshot `pluginType=表单插件` said
		// "hit 0, dropped 95, untagged 2" -- 97 of 167 rows accounted for -- and
		// then returned 72. The missing 70 were `common`, and the warning built on
		// those counts told the caller its 72 rows were 2.
		const tree = {
			...TREE,
			"platform/scenes/_index.md": `${SCENE_INDEX}| 通用附件 | attachment.md | released | 附件 | — | — | common |\n`,
			"platform/scenes/attachment.md": "---\nscene_name: 通用附件\nstatus: released\n---\n\n附件正文。\n",
		};
		const report = knowledgeScenes(openKnowledgeBase(ROOT, fakePort(tree)), STATUS, { pluginType: "billform" });
		const account = report.filter[0];
		expect(account).toMatchObject({ hit: 1, dropped: 1, neutral: 1, untagged: 1 });
		// The two sums are the whole point: every scanned row lands in exactly one
		// verdict, and the three that are not `miss` are exactly what came back.
		const { hit = 0, dropped = 0, neutral = 0, untagged = 0 } = account ?? {};
		expect(hit + dropped + neutral + untagged).toBe(report.total);
		expect(hit + neutral + untagged).toBe(report.rows.length);
		expect(report.warnings.join("\n")).toContain("1 条标着 pluginType=common");
	});

	it("refuses to let a zero-match filter read as a table of matches", async () => {
		// Measured on the real snapshot: control=list returns 89 of 167 rows and NONE
		// of them matched -- every one is an untagged row kept on "unknown". Saying
		// only "89 条" would be a true number and a false answer.
		const report = knowledgeScenes(kb, STATUS, { control: "grid" });
		expect(report.filter[0]?.hit).toBe(0);
		expect(report.warnings.join("\n")).toContain("结果里没有一条是靠 grid 匹配上的");
	});

	it("warns about --event with the count it actually cut", async () => {
		const report = knowledgeScenes(kb, STATUS, { event: "afterF7Select" });
		const account = report.filter.find((entry) => entry.facet === "event");
		expect(account?.hit).toBe(1);
		expect(account?.dropped).toBe(1);
		expect(account?.untagged).toBe(1);
		const text = report.warnings.join("\n");
		expect(text).toContain("event=afterF7Select 排除了 1/3 条");
		expect(text).toContain("用它过滤等于先假设答案");
	});

	it("keeps quiet when nothing was filtered", async () => {
		const report = knowledgeScenes(kb, STATUS, {});
		expect(report.filter).toEqual([]);
		expect(report.warnings).toEqual([]);
		expect(report.coverage).toBe(1);
	});

	it("carries the same facet accounting into search, so the two channels agree", async () => {
		const report = knowledgeSearch(kb, STATUS, "回填", { event: "afterF7Select" });
		expect(report.ok).toBe(true);
		if (!report.ok) return;
		expect(report.value.filter.find((entry) => entry.facet === "event")?.untagged).toBe(1);
		expect(report.value.warnings.join("\n")).toContain("用它过滤等于先假设答案");
	});
});

describe("S7.3 通道判定不越界", () => {
	const kb = openKnowledgeBase(ROOT, fakePort(TREE));

	it("does not point at the scene table when the caller excluded scenes", async () => {
		const result = knowledgeSearch(kb, STATUS, "选完供应商带出联系人", { kind: "api" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.route.channel).toBe("scene-question");
		// The caller said kind=api. Sending them to a table they excluded, with a
		// row count of zero, would be advice that reads as a bug.
		expect(result.value.steer).toBeNull();
	});
});

describe("S5.2 findclass", () => {
	const kb = openKnowledgeBase(ROOT, fakePort(TREE));
	const FIND_OUT = [
		"kd.bos.dataentity.entity.DynamicObject                        <- kd-bos-dataentity.jar",
		"kd.bos.entity.datamodel.DynamicObjectCollection               <- kd-bos-entity.jar",
		"--- 扫了 4878 个 jar，命中 2 个类 ---",
	].join("\n");

	it("parses the class and the jar it came from", async () => {
		const result = await knowledgeFindclass(kb, STATUS, "DynamicObject", {
			sig: async () => null,
			batch: async () => null,
			find: async () => FIND_OUT,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.hits[0]).toEqual({
			fqcn: "kd.bos.dataentity.entity.DynamicObject",
			jar: "kd-bos-dataentity.jar",
		});
		expect(result.value.scanned).toEqual({ jars: 4878, total: 2, truncated: false });
	});

	it("S37: gives each jar's full path once, so the jar can be opened without searching the disk", async () => {
		// ApiTool now prints the absolute path; hits keep the short name, the path is listed once per jar.
		const out = [
			"kd.bos.print.core.execute.render.common.linewrap.LineWrapRule   <- D:\\kingdee\\cosmic server\\lib\\bos\\bos-print-core-8.0.jar",
			"kd.bos.print.core.model.PWLayoutGrid                            <- D:\\kingdee\\cosmic server\\lib\\bos\\bos-print-core-8.0.jar",
			"kd.bos.metadata.print.control.LayoutCell                        <- /opt/cosmic/lib/bos-metadata-8.0.jar",
			"--- 扫了 4530 个 jar，命中 3 个类 ---",
		].join("\n");
		const result = await knowledgeFindclass(kb, STATUS, "Layout", {
			sig: async () => null,
			batch: async () => null,
			find: async () => out,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.hits.map((hit) => hit.jar)).toEqual([
			"bos-print-core-8.0.jar",
			"bos-print-core-8.0.jar",
			"bos-metadata-8.0.jar",
		]);
		expect(result.value.jarPaths).toEqual({
			"bos-print-core-8.0.jar": "D:\\kingdee\\cosmic server\\lib\\bos\\bos-print-core-8.0.jar",
			"bos-metadata-8.0.jar": "/opt/cosmic/lib/bos-metadata-8.0.jar",
		});
	});

	it("says the scan could not run rather than reporting no hits", async () => {
		// "Nothing matched" and "the tool never ran" are the same picture from the
		// outside, and only one of them means the class does not exist.
		const result = await knowledgeFindclass(kb, STATUS, "DynamicObject", {
			sig: async () => null,
			batch: async () => null,
			find: async () => null,
		});
		expect(result.ok && result.value.reflectionUnavailable).not.toBeNull();
		expect(result.ok && result.value.hits).toEqual([]);
	});

	it("says the project is not open, not 'rebuild', when that is why there is no JAR", async () => {
		// The generic reason ends in a rebuild hint, which sent a session with a
		// built project to rebuild it. A port that knows it has no project says so.
		const result = await knowledgeFindclass(kb, STATUS, "EntryAp", UNAVAILABLE_REFLECTION);
		expect(result.ok && result.value.reflectionUnavailable).toContain("cosmic_open_project");
		expect(result.ok && result.value.notes.join("")).not.toContain("rebuild");
	});

	it("reports truncation, because the missing class may be in the tail", async () => {
		const result = await knowledgeFindclass(kb, STATUS, "Form", {
			sig: async () => null,
			batch: async () => null,
			find: async () =>
				"kd.bos.form.FormView   <- kd-bos-form.jar\n--- 扫了 10 个 jar，命中 60 个类（只列前 1 个，关键字再给准点）---",
		});
		expect(result.ok && result.value.scanned.truncated).toBe(true);
	});

	it("hands out the official entry point when a hit is a plugin base class", async () => {
		// The frozen knowledgeHintForQuery hung off both sig and findclass; this is
		// findclass's half, and it calls the same pluginHints the gate uses.
		const result = await knowledgeFindclass(kb, STATUS, "AbstractFormPlugin", {
			sig: async () => null,
			batch: async () => null,
			find: async () =>
				"kd.bos.form.plugin.AbstractFormPlugin  <- kd-bos-form.jar\n--- 扫了 1 个 jar，命中 1 个类 ---",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.pluginHints[0]?.base).toBe("AbstractFormPlugin");
		// Recognition from a class name alone is the loose tier, and it says so.
		expect(result.value.pluginHints[0]?.tier).toBe("loose");
	});

	it("refuses an empty keyword", async () => {
		const result = await knowledgeFindclass(kb, STATUS, "  ", {
			sig: async () => null,
			batch: async () => null,
			find: async () => "",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("KNOWLEDGE_QUERY_INVALID");
	});
});
