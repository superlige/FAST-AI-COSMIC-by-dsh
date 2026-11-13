import { describe, expect, it } from "vitest";
import { extractProse } from "../../src/agent/tools/prose-blocks.ts";

/**
 * Prose leaving the JSON envelope (D14.4).
 *
 * Measured cause: a `cosmic_knowledge show` answer carried a 25,140-byte markdown
 * guide with 728 newlines, and every one of them reached the model as the two
 * characters `\n` because the whole result is one `JSON.stringify`. The escaping
 * costs 3.4% in bytes; what it actually costs is the document's line structure.
 * 91% of that tool's traffic is document bodies and rendered signature lists.
 */
describe("prose blocks", () => {
	const guide = ["# 打印插件", "", "## 1. 插件体系", "```java", "class A {}", "```"].join("\n");

	it("moves a `show` body out and leaves a pointer behind", () => {
		const moved = extractProse("cosmic_knowledge", {
			action: "show",
			relativePath: "platform/print-plugin-guide.md",
			content: guide,
		});
		expect(moved.blocks).toEqual([{ label: "platform/print-plugin-guide.md", text: guide }]);
		const record = moved.result as Record<string, unknown>;
		// A pointer, not a copy: emitting both would pay for the same bytes twice,
		// which is what the D14.2 cuts exist to stop.
		expect(record.content).toBe("→ 见下方文本块「platform/print-plugin-guide.md」（57 字节）");
		expect(record.action).toBe("show");
	});

	it("moves the guide and every chosen page of a `plugin` answer", () => {
		const scene = "# 动态列\n\n正文";
		const moved = extractProse("cosmic_knowledge", {
			action: "plugin",
			phase: 1,
			guide: { relativePath: "platform/print-plugin-guide.md", file: "C:/x.md", content: guide, bytes: 57 },
			chosen: [{ relativePath: "print/07-dynamic-column.md", file: "C:/y.md", content: scene, bytes: 20 }],
			scenes: { rows: [{ relativePath: "print/07-dynamic-column.md", title: "动态列" }] },
		});
		expect(moved.blocks.map((block) => block.label)).toEqual([
			"platform/print-plugin-guide.md",
			"print/07-dynamic-column.md",
		]);
		const record = moved.result as Record<string, unknown>;
		// The scene table is what the six-step flow validates its stamp against.
		// Turning it into prose would make the one machine-verifiable step depend
		// on parsing text back, so it stays structured.
		expect(record.scenes).toEqual({ rows: [{ relativePath: "print/07-dynamic-column.md", title: "动态列" }] });
		expect((record.guide as Record<string, unknown>).content).toContain("见下方文本块");
		// The document's own metadata survives: the caller still has the path to
		// quote back, and `bytes` still says how big the real thing is.
		expect((record.guide as Record<string, unknown>).relativePath).toBe("platform/print-plugin-guide.md");
	});

	it("renders every class's signatures into one block, not one block each", () => {
		// The call that needs `api` most answers a 13-import probe in one go;
		// thirteen five-line blocks is a worse thing to read than one list.
		const moved = extractProse("cosmic_knowledge", {
			action: "api",
			entries: [
				{ fqcn: "kd.bos.orm.query.QFilter", methods: ["QFilter of(String s)", "QFilter and(QFilter f)"] },
				{ fqcn: "kd.bos.algo.Algo", methods: ["static Algo create(String key)"] },
			],
		});
		expect(moved.blocks).toHaveLength(1);
		const [block] = moved.blocks;
		expect(block?.label).toBe("签名");
		expect(block?.text).toBe(
			[
				"### kd.bos.orm.query.QFilter",
				"QFilter of(String s)",
				"QFilter and(QFilter f)",
				"",
				"### kd.bos.algo.Algo",
				"static Algo create(String key)",
			].join("\n"),
		);
		const entries = (moved.result as { entries: Record<string, unknown>[] }).entries;
		expect(entries[0]?.methods).toBe("→ 见下方文本块「签名」中的 kd.bos.orm.query.QFilter（方法 2 条）");
		expect(entries[0]?.fqcn).toBe("kd.bos.orm.query.QFilter");
	});

	it("puts a class's constructors and fields after its methods in the same block", () => {
		// 常量表一类的类可能一个方法都没有（QCP），照样要进签名块。
		const moved = extractProse("cosmic_knowledge", {
			action: "api",
			entries: [
				{
					fqcn: "kd.bos.orm.query.QFilter",
					methods: ["QFilter and(QFilter f)"],
					constructors: ["QFilter(String, String, Object)"],
					fields: [],
				},
				{ fqcn: "kd.bos.orm.query.QCP", methods: [], fields: ['static String is_notnull = "is not null"'] },
			],
		});
		expect(moved.blocks[0]?.text).toBe(
			[
				"### kd.bos.orm.query.QFilter",
				"QFilter and(QFilter f)",
				"构造：",
				"QFilter(String, String, Object)",
				"",
				"### kd.bos.orm.query.QCP",
				"字段：",
				'static String is_notnull = "is not null"',
			].join("\n"),
		);
		const entries = (moved.result as { entries: Record<string, unknown>[] }).entries;
		expect(entries[0]?.methods).toBe("→ 见下方文本块「签名」中的 kd.bos.orm.query.QFilter（方法 1 条、构造 1 个）");
		expect(entries[1]?.methods).toBe("→ 见下方文本块「签名」中的 kd.bos.orm.query.QCP（字段 1 个）");
		expect(entries[1]).not.toHaveProperty("fields");
	});

	it("moves each tool's own free-text field", () => {
		const output = "[PROBE] 一行\n[PROBE] 又一行";
		const moved = extractProse("cosmic_probe", { probe: "MetaProbe", exitCode: 0, output });
		expect(moved.blocks).toEqual([{ label: "cosmic_probe 输出", text: output }]);
		expect((moved.result as Record<string, unknown>).exitCode).toBe(0);
	});

	it("leaves a one-line output in the envelope", () => {
		// A block for it costs a heading and buys nothing: there are no line breaks
		// to lose.
		const moved = extractProse("cosmic_probe", { output: "[PROBE] 就一行" });
		expect(moved.blocks).toEqual([]);
		expect((moved.result as Record<string, unknown>).output).toBe("[PROBE] 就一行");
	});

	it("leaves a result alone when the tool has no prose field", () => {
		// S11 retired `cosmic_build`; `cosmic_fast` is the surviving compile tool
		// with no prose field, and the report shape is the same kind of structured
		// answer -- which is the whole condition under test.
		const result = { pathingJar: "C:/x.jar", modules: ["a"] };
		const moved = extractProse("cosmic_fast", result);
		expect(moved.blocks).toEqual([]);
		expect(moved.result).toBe(result);
	});

	it("renders a `scenes` table as a table and drops its all-empty columns", () => {
		// Measured on the real snapshot: 27,540 bytes of `rows`, five keys repeated
		// on every one of 167 rows, `event` empty on 88 of them and `control` on 89.
		// The same content as a table is 18,186 bytes.
		const moved = extractProse("cosmic_knowledge", {
			action: "scenes",
			total: 2,
			rows: [
				{
					relativePath: "print/07-dynamic-column.md",
					title: "动态列",
					keywords: "打印, 动态列",
					event: "",
					control: "",
				},
				{
					relativePath: "list/filter.md",
					title: "列表过滤",
					keywords: "列表, 过滤",
					event: "afterF7Select",
					control: "",
				},
			],
			warnings: ["整表未过滤"],
		});
		const [block] = moved.blocks;
		expect(block?.label).toBe("场景表");
		// `control` is gone (empty on every row); `event` stays (one row has it).
		expect(block?.text).toBe(
			[
				"relativePath | title | keywords | event",
				"print/07-dynamic-column.md | 动态列 | 打印, 动态列 | ",
				"list/filter.md | 列表过滤 | 列表, 过滤 | afterF7Select",
			].join("\n"),
		);
		const record = moved.result as Record<string, unknown>;
		expect(record.rows).toContain("见下方文本块「场景表」");
		// The count survives the move: "how many scenes came back" is the one thing
		// about the rows the envelope still has to answer on its own.
		expect(record.rowCount).toBe(2);
		// The accounting that says how to read the rows stays where it was.
		expect(record.warnings).toEqual(["整表未过滤"]);
	});

	it("keeps a null cell as null, because null is an answer in `routes`", () => {
		// `pluginType: null` means the official index never tagged the family --
		// which the report's own notes explain and a blank cell would erase.
		const moved = extractProse("cosmic_knowledge", {
			action: "routes",
			rows: [
				{ base: "AbstractBillPlugIn", pluginType: "billform", sceneCount: 102 },
				{ base: "X", pluginType: null, sceneCount: null },
			],
		});
		expect(moved.blocks[0]?.label).toBe("插件族路由表");
		expect(moved.blocks[0]?.text).toBe(
			["base | pluginType | sceneCount", "AbstractBillPlugIn | billform | 102", "X | null | null"].join("\n"),
		);
	});

	it("moves the delivered Capsules out of a probe result too", () => {
		// The same Capsule markdown reaches the model unescaped from the write hook
		// and from the system prompt; the probe and run paths used to hand it over
		// inside the JSON envelope, so one of the three was always flat.
		const capsule = "## Knowledge Capsule · plugin · AbstractBillPlugIn\n要点:\n- 先 beginInit";
		const moved = extractProse("cosmic_probe", {
			probe: "MetaProbe",
			output: "一行\n又一行",
			knowledgeContext: capsule,
		});
		expect(moved.blocks.map((block) => block.label)).toEqual(["cosmic_probe 输出", "Knowledge Capsule"]);
		const record = moved.result as Record<string, unknown>;
		expect(record.knowledgeContext).toContain("见下方文本块「Knowledge Capsule」");
	});

	it("leaves a knowledge action that carries no rows and no body alone", () => {
		// `search` answers with scored results the caller picks from, and they are
		// read field by field rather than scanned as a table.
		const result = { action: "search", results: [{ relativePath: "print/07-dynamic-column.md", score: 3 }] };
		const moved = extractProse("cosmic_knowledge", result);
		expect(moved.blocks).toEqual([]);
		expect(moved.result).toBe(result);
	});
});
