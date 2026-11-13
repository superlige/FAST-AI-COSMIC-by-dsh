/**
 * The API document parser and the D8 join (S7.2).
 *
 * Two kinds of assertion here. The unit cases pin the parsing rules that are easy to
 * get subtly wrong -- type erasure, generic parameter lists, overloads sharing one
 * heading. The corpus case runs the parser over all 1,528 embedded API documents and
 * asserts the totals, because this parser's failure mode is not a crash: it is
 * quietly returning fewer methods than the corpus has, which looks exactly like
 * success. That is how the first version of it lost 1,087 methods.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	eraseType,
	isUninformativeDoc,
	methodKey,
	parseApiDoc,
	parseSignature,
	splitParams,
} from "../../src/knowledge/api-doc.ts";
import {
	anchorSweep,
	buildAnchorQueries,
	joinApi,
	parseCandidateLine,
	parseSigOutput,
	renderAnchorQueries,
	renderJoinedMethod,
	renderReflectedMethod,
} from "../../src/knowledge/api-join.ts";
import { openKnowledgePack } from "../../src/knowledge/pack.ts";

const DOC = `---
framework_version: "8.0.1"
api_class: "Algo"
api_package: "kd.bos.algo"
when_to_use: "当你需要创建 algo 上下文时"
---

# Algo API 说明

## 概述
此类可以用来创建 algo 上下文信息。

## 方法列表

### closeAllDataSet

关闭当前线程的所有DataSet

注意：谨慎使用，这会关闭其他地方的 DataSet

**方法签名：**
\`\`\`java
public static void closeAllDataSet()
\`\`\`

---

### create

**重载 1**

创建 Algo 对象

**方法签名：**
\`\`\`java
public static Algo create(String algoKey)
\`\`\`

**参数说明：**
- \`algoKey\`: \`String\` — 用来标记不同 Algo 对象的标识

**返回值：**
- \`Algo\`: Algo 对象

---

**重载 2**

按缓存提示创建

**方法签名：**
\`\`\`java
public Algo create(Map<String, Object> hint, RowMeta rowMeta)
\`\`\`

**参数说明：**
- \`hint\`: \`Map<String, Object>\` — 缓存提示
- \`rowMeta\`: \`RowMeta\` — 元数据

**返回值：**
- \`Algo\`: Algo 对象

---
`;

const SIG_OUTPUT = `class kd.bos.algo.Algo
  来自 jar : cosmic-bos-algo.jar
  父类     : kd.bos.algo.AbstractAlgo
  实现     : java.io.Serializable, java.lang.Cloneable

--- 字段/常量 (1) ---
  static String KEY = "algo"

--- 构造 (1) ---
  <init>()

--- 方法 (3) ---
  static create(String) -> Algo
  create(Map, RowMeta) -> Algo
  flush() -> void

(只列本类声明的成员。继承来的在父类上，需要就 sig kd.bos.algo.AbstractAlgo)
`;

describe("S7.2 API 文档解析", () => {
	it("erases a type to what reflection reports for it", () => {
		expect(eraseType("Collection<Object[]>")).toBe("Collection");
		expect(eraseType("kd.bos.algo.CachedDataSet.Builder")).toBe("Builder");
		expect(eraseType("Map<String, Object>")).toBe("Map");
		// The array suffix survives erasure: String and String[] are different methods.
		expect(eraseType("java.lang.String[]")).toBe("String[]");
		expect(eraseType("List<Map<String,Object>>[]")).toBe("List[]");
		expect(eraseType("int")).toBe("int");
	});

	it("splits a parameter list on top-level commas only", () => {
		expect(splitParams("Map<String,Object> a, int b")).toEqual(["Map<String,Object> a", "int b"]);
		expect(splitParams("")).toEqual([]);
	});

	it("parses signatures including generic return types with spaces", () => {
		const parsed = parseSignature("public static Map<String, Object> load(String id, boolean cached)");
		expect(parsed?.name).toBe("load");
		expect(parsed?.isStatic).toBe(true);
		// Kept as written, not normalised: erasure happens at join time, not at parse time.
		expect(parsed?.returnType).toBe("Map<String, Object>");
		expect(parsed?.paramNames).toEqual(["id", "cached"]);
		expect(parsed?.paramTypes).toEqual(["String", "boolean"]);
		expect(parseSignature("public abstract void close()")?.paramTypes).toEqual([]);
		// Not a signature: reported as unreadable rather than half-parsed.
		expect(parseSignature("总之这不是签名")).toBeNull();
	});

	it("keeps overloads apart, because that is what the join is asked about", () => {
		// name + arity is not enough: the corpus has 513 same-name same-arity pairs.
		expect(methodKey("f", ["String"])).not.toBe(methodKey("f", ["int"]));
		expect(methodKey("f", ["kd.bos.Foo<Bar>"])).toBe(methodKey("f", ["Foo"]));
	});

	it("reads a document's methods, prose, real parameter names and returns", () => {
		const result = parseApiDoc("platform/api/algo/Algo.md", DOC);
		expect(result.why).toBeNull();
		expect(result.unparsed).toEqual([]);
		expect(result.doc?.fqcn).toBe("kd.bos.algo.Algo");
		expect(result.doc?.overview).toBe("此类可以用来创建 algo 上下文信息。");
		// Three methods, not two: `create` carries two overloads under one heading.
		expect(result.doc?.methods.map((method) => method.name)).toEqual(["closeAllDataSet", "create", "create"]);
		const first = result.doc?.methods[0];
		expect(first?.isStatic).toBe(true);
		expect(first?.doc).toContain("谨慎使用");
		const second = result.doc?.methods[1];
		expect(second?.doc).toBe("创建 Algo 对象");
		expect(second?.params).toEqual([{ name: "algoKey", type: "String", doc: "用来标记不同 Algo 对象的标识" }]);
		expect(second?.returns).toContain("Algo 对象");
		// The second overload's prose must be its own, not the first one's tail.
		const third = result.doc?.methods[2];
		expect(third?.doc).toBe("按缓存提示创建");
		expect(third?.params.map((param) => param.name)).toEqual(["hint", "rowMeta"]);
	});

	it("distinguishes 'not an API page' from 'an API page it failed to read'", () => {
		expect(parseApiDoc("x.md", "# 索引\n没有 frontmatter").why).toBe("没有 frontmatter");
		expect(parseApiDoc("x.md", '---\ntitle: "索引"\n---\n\n# 索引\n').why).toContain("不是 API 页");
	});

	it("calls out prose that says nothing beyond the method's own name", () => {
		// 43 methods in the corpus have a literal (non-Javadoc) marker, and a tail have
		// the method name as their whole description. Shipping those as documentation
		// tells the reader the question was answered when it was not.
		expect(isUninformativeDoc({ name: "combine", doc: "combine" })).toBe(true);
		expect(isUninformativeDoc({ name: "reduce", doc: "(non-Javadoc)\n@see something" })).toBe(true);
		expect(isUninformativeDoc({ name: "create", doc: "创建 Algo 对象" })).toBe(false);
	});
});

describe("S7.2 反射输出解析与 join", () => {
	it("parses ApiTool sig output without changing ApiTool", () => {
		const reflected = parseSigOutput(SIG_OUTPUT);
		expect(reflected?.fqcn).toBe("kd.bos.algo.Algo");
		expect(reflected?.jar).toBe("cosmic-bos-algo.jar");
		expect(reflected?.superclass).toBe("kd.bos.algo.AbstractAlgo");
		expect(reflected?.initialized).toBe(true);
		// Only the 方法 section: fields and constructors must not leak in as methods.
		expect(reflected?.methods.map((method) => method.name)).toEqual(["create", "create", "flush"]);
		expect(reflected?.methods[0]?.isStatic).toBe(true);
		expect(reflected?.methods[1]?.paramTypes).toEqual(["Map", "RowMeta"]);
		expect(parseSigOutput("找不到类: kd.bos.Nope")).toBeNull();
	});

	it("reads the 泛型 line under a method without touching the join key (真机 2026-10-09)", () => {
		// 只给擦除的那行时，List<List<Object>> 看着就是 List，模型照它写 List<List<String>>，编不过。
		const text = SIG_OUTPUT.replace(
			"  flush() -> void\n",
			[
				"  buildJSON(String, List) -> String",
				"    泛型 buildJSON(String, List<List<Object>>) -> String",
				"  static of(Map, Object[]) -> List",
				"    泛型 static of(Map<String,? extends T>, T[]) -> List<T>",
				"  flush() -> void",
				"",
			].join("\n"),
		);
		const reflected = parseSigOutput(text) as NonNullable<ReturnType<typeof parseSigOutput>>;
		const build = reflected.methods.find((method) => method.name === "buildJSON");
		expect(build?.paramTypes).toEqual(["String", "List"]);
		expect(build?.genericParamTypes).toEqual(["String", "List<List<Object>>"]);
		expect(renderReflectedMethod(build as NonNullable<typeof build>)).toBe(
			"String buildJSON(String, List<List<Object>>)",
		);
		const of = reflected.methods.find((method) => method.name === "of");
		expect(of?.genericParamTypes).toEqual(["Map<String,? extends T>", "T[]"]);
		expect(renderReflectedMethod(of as NonNullable<typeof of>)).toBe(
			"static List<T> of(Map<String,? extends T>, T[])",
		);
		// 没有泛型行的照旧
		const flush = reflected.methods.find((method) => method.name === "flush");
		expect(flush?.genericParamTypes).toBeUndefined();
		expect(renderReflectedMethod(flush as NonNullable<typeof flush>)).toBe("void flush()");
		// 文档对照的键还是擦除后的：create 两个重载照样对上
		const doc = parseApiDoc("platform/api/algo/Algo.md", DOC).doc as NonNullable<
			ReturnType<typeof parseApiDoc>["doc"]
		>;
		expect(joinApi(doc, reflected).joined.map((entry) => entry.key)).toEqual([
			"create(String)",
			"create(Map,RowMeta)",
		]);
	});

	it("puts the JAR's type arguments on a parameter the document wrote bare, and leaves spelled ones alone", () => {
		const doc = parseApiDoc("platform/api/algo/Algo.md", DOC).doc as NonNullable<
			ReturnType<typeof parseApiDoc>["doc"]
		>;
		const text = SIG_OUTPUT.replace(
			"  create(Map, RowMeta) -> Algo\n",
			"  create(Map, RowMeta) -> Algo\n    泛型 create(Map<String,Object>, RowMeta) -> Algo\n",
		);
		const join = joinApi(doc, parseSigOutput(text) as NonNullable<ReturnType<typeof parseSigOutput>>);
		const rendered = renderJoinedMethod(join.joined[1] as (typeof join.joined)[number])[0];
		// 文档里本来就写了 Map<String, Object>，原样留着
		expect(rendered).toContain("create(Map<String, Object> hint, RowMeta rowMeta)");
		const bare = {
			...(join.joined[1] as (typeof join.joined)[number]),
			documented: {
				...(join.joined[1] as (typeof join.joined)[number]).documented,
				params: [
					{ type: "Map", name: "hint", doc: "" },
					{ type: "RowMeta", name: "rowMeta", doc: "" },
				],
			},
		};
		expect(renderJoinedMethod(bare)[0]).toContain("create(Map<String,Object> hint, RowMeta rowMeta)");
	});

	it("reports both sides: 悬空 and 无注释", () => {
		const doc = parseApiDoc("platform/api/algo/Algo.md", DOC).doc as NonNullable<
			ReturnType<typeof parseApiDoc>["doc"]
		>;
		const join = joinApi(doc, parseSigOutput(SIG_OUTPUT) as NonNullable<ReturnType<typeof parseSigOutput>>);
		// Both `create` overloads join, including the generic one after erasure.
		expect(join.joined.map((entry) => entry.key)).toEqual(["create(String)", "create(Map,RowMeta)"]);
		// Documented but absent from this JAR: the snapshot is ahead of the user.
		expect(join.dangling.map((method) => method.name)).toEqual(["closeAllDataSet"]);
		// Present in the JAR, described nowhere: `sig` can only print its bare shape.
		expect(join.undocumented.map((method) => method.name)).toEqual(["flush"]);
		expect(join.coverage).toBeCloseTo(2 / 3);
		expect(join.informative).toBe(2);
	});

	it("does not call an inherited method a dangling anchor", () => {
		// The document lists a method the class itself does not declare. Without the
		// superclass's method set that is indistinguishable from a vanished API, and
		// every subclass page would report false 悬空.
		const doc = parseApiDoc("platform/api/algo/Algo.md", DOC).doc as NonNullable<
			ReturnType<typeof parseApiDoc>["doc"]
		>;
		const reflected = parseSigOutput(SIG_OUTPUT) as NonNullable<ReturnType<typeof parseSigOutput>>;
		const join = joinApi(doc, reflected, [
			{ name: "closeAllDataSet", paramTypes: [], returnType: "void", isStatic: true },
		]);
		expect(join.dangling).toEqual([]);
		expect(join.inherited.map((method) => method.name)).toEqual(["closeAllDataSet"]);
	});

	it("prints what sig never could: real names, prose, @param and @return", () => {
		const doc = parseApiDoc("platform/api/algo/Algo.md", DOC).doc as NonNullable<
			ReturnType<typeof parseApiDoc>["doc"]
		>;
		const join = joinApi(doc, parseSigOutput(SIG_OUTPUT) as NonNullable<ReturnType<typeof parseSigOutput>>);
		const rendered = renderJoinedMethod(join.joined[0] as (typeof join.joined)[number]).join("\n");
		// `arg0` is what reflection alone would have given for this parameter.
		expect(rendered).toContain("create(String algoKey)");
		expect(rendered).toContain("创建 Algo 对象");
		expect(rendered).toContain("@param algoKey 用来标记不同 Algo 对象的标识");
		expect(rendered).toContain("@return");
		expect(rendered).not.toContain("arg0");
	});
});

describe("S7.2 全量语料实测", () => {
	const snapshot = openKnowledgePack(
		readFileSync(fileURLToPath(new URL("../../knowledge/cosmic-kb.pack", import.meta.url))),
	);
	const apiPaths = snapshot.paths.filter((path) => path.startsWith("platform/api/"));

	it("parses every method the corpus has, and reports the ones it cannot", () => {
		let pages = 0;
		let notApi = 0;
		let methods = 0;
		const unparsed: string[] = [];
		let rawBlocks = 0;
		for (const path of apiPaths) {
			const text = snapshot.read(path) as string;
			rawBlocks += (text.match(/\*\*方法签名：\*\*/g) ?? []).length;
			const result = parseApiDoc(path, text);
			if (result.doc === null) {
				notApi += 1;
				continue;
			}
			pages += 1;
			methods += result.doc.methods.length;
			unparsed.push(...result.unparsed);
		}
		expect(apiPaths).toHaveLength(1528);
		expect(pages).toBe(1520);
		// 8 files are indexes and extraction reports, not API pages.
		expect(notApi).toBe(8);
		// Not "roughly all": every signature block in the corpus becomes a method, or
		// lands in `unparsed`. Anything else is the silent-loss failure mode.
		expect(methods).toBe(rawBlocks);
		expect(methods).toBe(15757);
		expect(unparsed).toEqual([]);
	});

	it("recovers the real parameter names reflection cannot give", () => {
		let params = 0;
		let named = 0;
		let chinese = 0;
		let methods = 0;
		for (const path of apiPaths) {
			const result = parseApiDoc(path, snapshot.read(path) as string);
			for (const method of result.doc?.methods ?? []) {
				methods += 1;
				if (/[一-鿿]/.test(method.doc)) chinese += 1;
				for (const param of method.params) {
					params += 1;
					if (param.name !== "" && param.name !== `arg${params}`) named += 1;
				}
			}
		}
		expect(params).toBe(13402);
		// This is the number D13 said had never been used by anything.
		expect(named / params).toBeGreaterThan(0.999);
		// 96.2% measured; the official extraction report claims 83.4% over its own
		// count of 14,720 methods, which does not match the 15,757 blocks on disk.
		expect(chinese / methods).toBeGreaterThan(0.96);
	});
});

describe("S7.2 批量锚点校验", () => {
	const doc = parseApiDoc("platform/api/algo/Algo.md", DOC).doc as NonNullable<ReturnType<typeof parseApiDoc>["doc"]>;

	it("asks one query per class and method name, not per overload", () => {
		// suggest returns every same-name overload in one answer, so a query per
		// overload would triple the file for nothing. And the whole reason the sweep
		// is a query file is that it costs ONE JVM instead of 1,520.
		const queries = buildAnchorQueries([doc]);
		expect(queries.map((query) => query.name)).toEqual(["closeAllDataSet", "create"]);
		expect(renderAnchorQueries(queries).split("\n")[0]).toBe(
			"a0:closeAllDataSet\tmethod\tkd.bos.algo.Algo\tcloseAllDataSet\t-1",
		);
	});

	it("parses a suggest candidate, including the declaring class", () => {
		const parsed = parseCandidateLine("  static Algo.create(String) -> Algo   <- 参数个数对得上");
		expect(parsed).toEqual({
			declaringClass: "Algo",
			name: "create",
			paramTypes: ["String"],
			returnType: "Algo",
			isStatic: true,
		});
		expect(parseCandidateLine("  不是候选行")).toBeNull();
	});

	it("separates 悬空 from merely inherited, and reports a missing class as such", () => {
		const queries = buildAnchorQueries([doc]);
		const ids = new Map(queries.map((query) => [query.name, query.id]));
		const answers = new Map<string, string[]>([
			// Declared on the parent, documented here: not a dangling anchor.
			[ids.get("closeAllDataSet") as string, ["  static AbstractAlgo.closeAllDataSet() -> void"]],
			[
				ids.get("create") as string,
				[
					"  static Algo.create(String) -> Algo   <- 参数个数对得上",
					// The Map overload is absent: this JAR does not have it.
					"  static Algo.create(String, int) -> Algo",
				],
			],
		]);
		const report = anchorSweep([doc], answers);
		expect(report.classes).toBe(1);
		expect(report.methods).toBe(3);
		expect(report.joined).toBe(1);
		expect(report.inherited).toBe(1);
		expect(report.dangling.map((item) => item.method)).toEqual(["create"]);
		expect(report.dangling[0]?.signature).toContain("Map<String, Object> hint");
		expect(report.missingClasses).toEqual([]);
		expect(report.unanswered).toBe(0);
	});

	it("reports a class the JAR does not have at all", () => {
		const queries = buildAnchorQueries([doc]);
		const answers = new Map(
			queries.map((query) => [
				query.id,
				["!类 kd.bos.algo.Algo 本身就查不到，最接近的类名：", "  kd.bos.algo.Algox"],
			]),
		);
		const report = anchorSweep([doc], answers);
		expect(report.missingClasses).toEqual(["kd.bos.algo.Algo"]);
		expect(report.dangling).toEqual([]);
	});

	it("counts a query reflection never answered instead of calling it joined", () => {
		// An empty answer map is "reflection did not run", not "nothing exists". The
		// two must never collapse: one is a tooling problem, the other is a defect
		// report about the user's JAR.
		const report = anchorSweep([doc], new Map());
		expect(report.unanswered).toBe(3);
		expect(report.dangling).toEqual([]);
		expect(report.joined).toBe(0);
	});
});
