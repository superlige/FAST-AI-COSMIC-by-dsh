/**
 * S45 批 2：段落全文索引。
 *
 * 用小段算分、按块返回（docs/S45-knowledge-recall.md §3.5）。这里守的是会悄悄出错的几处：
 * 小篇被切碎、代码块里的 # 被当成标题、只写着类名的一段压过真正讲那个方法的一段、
 * 本地长段被官方短段的平均长度压到底、本工程标识拆开后乱命中。
 */
import { describe, expect, it } from "vitest";
import {
	BLOCK_BYTES,
	blockText,
	buildPassageIndex,
	docBlock,
	outlineOf,
	type PassageSource,
	searchPassages,
	sectionByHeading,
	tokenize,
	WHOLE_DOC_BYTES,
} from "../../src/knowledge/passages.ts";

const official = (ref: string, text: string): PassageSource => ({
	origin: "official",
	ref,
	file: `C:/kb/${ref}`,
	text,
});
const local = (name: string, text: string): PassageSource => ({
	origin: "local",
	ref: `reference:${name}`,
	file: `C:/ref/${name}/SKILL.md`,
	text,
});

/** 一段够长的填充文字：让一篇超过整篇线、一节接近整节线。 */
const filler = (bytes: number, word = "说明"): string => `${word}文字。`.repeat(Math.ceil(bytes / 15));

const SCENE_CARD = [
	"---",
	"scene_name: 操作结果处理",
	"related_apis: [getSuccessPkIds]",
	"---",
	"",
	"# 场景：操作结果处理",
	"",
	"## 事件/方法说明",
	"调用 getSuccessPkIds 取成功的单据。",
	"",
	"## 代码示例",
	"```java",
	"# 这一行在代码块里，不是标题",
	"List<Object> ids = result.getSuccessPkIds();",
	"```",
	"",
	"## 注意事项",
	"- 批量操作时部分成功。",
].join("\n");

const BIG_LOCAL = [
	"---",
	"name: cosmic-demo-write",
	"description: 写入",
	"---",
	"",
	"# 打印模板（写入与回滚）",
	"",
	"开头的引言：这篇讲怎么改模板。",
	"",
	"## 能改什么",
	"能改控件、表格和公式。",
	"",
	"### 给公式追加一个字段操作数",
	"`formulaData` 是字符串片段和字段操作数交替排列的数组。",
	"",
	"## 写入顺序",
	filler(3000),
	"",
	"## 很长的一节",
	"开头一句。",
	"",
	"### 小节甲",
	filler(5500),
	"",
	"### 小节乙",
	"这里讲 rareTermInLocal 的用法。",
	filler(1000),
].join("\n");

describe("tokenize", () => {
	it("keeps whole identifiers and marks camel parts apart", () => {
		const terms = tokenize("getSuccessPkIds");
		expect(terms).toContain("getsuccesspkids");
		expect(terms).toContain("~success");
		// 部分和整词分开记：搜 success 的整词不会撞上它
		expect(terms).not.toContain("success");
	});

	it("splits Chinese into adjacent pairs and keeps hyphenated names whole", () => {
		expect(tokenize("撤销提交")).toEqual(["撤销", "销提", "提交"]);
		expect(tokenize("cosmic-run")).toContain("cosmic_run");
	});
});

describe("blocks: rank by small sections, return a whole block", () => {
	const index = buildPassageIndex([
		official("platform/scenes/operation/result.md", SCENE_CARD),
		local("cosmic-demo-write", BIG_LOCAL),
	]);

	it("returns a small document whole, so the rule, the code and the caveats arrive together", () => {
		const [hit] = searchPassages(index, "getSuccessPkIds").hits;
		expect(hit?.source.ref).toBe("platform/scenes/operation/result.md");
		expect(hit?.block.scope).toBe("doc");
		const text = blockText(
			index,
			hit?.source.ref ?? "",
			hit?.block ?? { start: 0, end: 0, scope: "doc", heading: "", bytes: 0 },
		);
		expect(text).toContain("## 代码示例");
		expect(text).toContain("## 注意事项");
		// 文件头不进正文
		expect(text).not.toContain("scene_name");
	});

	it("does not take a # inside a code fence for a heading", () => {
		expect(sectionByHeading(index, "platform/scenes/operation/result.md", "这一行在代码块里，不是标题").ok).toBe(
			false,
		);
	});

	it("returns the whole unit around a hit in a big document", () => {
		const [hit] = searchPassages(index, "formulaData").hits;
		expect(hit?.source.ref).toBe("reference:cosmic-demo-write");
		expect(hit?.heading).toBe("能改什么 › 给公式追加一个字段操作数");
		// 命中在小节里，回的是它所在的整节「能改什么」
		expect(hit?.block.scope).toBe("unit");
		expect(hit?.block.heading).toBe("能改什么");
	});

	it("falls back to the hit section when its unit is too big to return whole", () => {
		const [hit] = searchPassages(index, "rareTermInLocal").hits;
		expect(hit?.block.scope).toBe("section");
		expect(hit?.block.heading).toBe("很长的一节 › 小节乙");
		expect(hit?.block.bytes).toBeLessThanOrEqual(BLOCK_BYTES);
	});

	it("gives a big document's opening and its outline when the document as a whole is what was asked for", () => {
		const block = docBlock(index, "reference:cosmic-demo-write");
		expect(block?.block.scope).toBe("intro");
		expect(
			blockText(
				index,
				"reference:cosmic-demo-write",
				block?.block ?? { start: 0, end: 0, scope: "doc", heading: "", bytes: 0 },
			),
		).toContain("开头的引言");
		expect(outlineOf(index, "reference:cosmic-demo-write").map((entry) => entry.heading)).toEqual([
			"能改什么",
			"写入顺序",
			"很长的一节",
		]);
	});

	it("keeps the thresholds the analysis chose", () => {
		expect(WHOLE_DOC_BYTES).toBe(4096);
		expect(BLOCK_BYTES).toBe(6144);
	});
});

describe("ranking", () => {
	it("does not let a section that only names the class beat the section about the method", () => {
		const apiDoc = [
			"---",
			"api_class: PWGridCellBo",
			"api_package: kd.bos.print.core.plugin.event.bo",
			"---",
			"",
			"# PWGridCellBo",
			"",
			"## Import 路径",
			"import kd.bos.print.core.plugin.event.bo.PWGridCellBo;",
			"",
			"## 方法列表",
			"",
			"### setCellValue",
			"设置格子的值。",
			filler(5000, "其他方法"),
		].join("\n");
		const index = buildPassageIndex([official("platform/api/print/PWGridCellBo.md", apiDoc)]);
		const [hit] = searchPassages(index, "PWGridCellBo setCellValue").hits;
		expect(hit?.heading).toBe("方法列表 › setCellValue");
	});

	it("scores a typical local section like a typical official one: each source is normalised by its own length", () => {
		// 官方一段几十个字，本地一段上千字；同样提到一次，按各自的平均长度算，分数应当相近。
		// 两份放一起按同一个平均数压，本地这段只剩零头（真快照上 formulaData 只在本地写过也排不上来）。
		const officialDocs = Array.from({ length: 30 }, (_, i) =>
			official(
				`platform/api/A${String(i)}.md`,
				`# A${String(i)}\n\n## 一\n短短一句${i === 0 ? " sharedWord" : ""}。`,
			),
		);
		const localDocs = Array.from({ length: 5 }, (_, i) =>
			local(`cosmic-l${String(i)}`, `# L${String(i)}\n\n## 一\n${filler(1500)}${i === 0 ? " sharedWord" : ""}`),
		);
		const hits = searchPassages(buildPassageIndex([...officialDocs, ...localDocs]), "sharedWord").hits;
		const score = (ref: string) => hits.find((hit) => hit.source.ref === ref)?.score ?? 0;
		expect(score("reference:cosmic-l0")).toBeGreaterThan(score("platform/api/A0.md") * 0.8);
	});

	it("normalises section length per source, so a long local section with a rare word still ranks", () => {
		const shortOfficial = Array.from({ length: 40 }, (_, i) =>
			official(`platform/api/F${String(i)}.md`, `# F${String(i)}\n\n## 方法\n### getFormula\n取 formula data。`),
		);
		const index = buildPassageIndex([
			...shortOfficial,
			local("cosmic-demo-write", BIG_LOCAL),
			local("cosmic-other", `# 别的\n\n## 一节\n${filler(2000)}`),
		]);
		expect(searchPassages(index, "formulaData").hits[0]?.source.ref).toBe("reference:cosmic-demo-write");
	});

	it("finds a single Chinese character, though the index is built from pairs", () => {
		const index = buildPassageIndex([
			official("platform/sdk/sdk-lock.md", "# 网络锁\n\n## 用法\n先加锁再改，改完解锁。"),
			official("platform/sdk/sdk-tx.md", "# 事务\n\n## 用法\n开启事务。"),
		]);
		const result = searchPassages(index, "锁");
		expect(result.absent).toEqual([]);
		expect(result.hits.map((hit) => hit.source.ref)).toEqual(["platform/sdk/sdk-lock.md"]);
		// 第二次查直接用并好的倒排，结果一样
		expect(searchPassages(index, "锁").hits[0]?.score).toBe(result.hits[0]?.score);
	});

	it("does not count an API document's header twice: its overview already says the same thing", () => {
		const body = "## 概述\n字段锁定性可见性\n\n## 方法列表\n### getLock\n{待补充}";
		const api = (head: string) =>
			buildPassageIndex([
				official("platform/api/x/ControlInfo.md", `---\napi_class: ControlInfo\n${head}---\n\n${body}`),
			]);
		expect(searchPassages(api("when_to_use: 字段锁定性可见性\n"), "字段锁定").hits[0]?.score).toBe(
			searchPassages(api(""), "字段锁定").hits[0]?.score,
		);
		// 场景卡的关联 API 照旧按篇加分：正文讲它的那段因此排上来
		const scene = (head: string) =>
			buildPassageIndex([
				official(
					"platform/scenes/x.md",
					`---\nscene_name: 结果\n${head}---\n\n## 说明\n调用 getSuccessPkIds 取成功的单据。`,
				),
			]);
		expect(
			searchPassages(scene("related_apis: [getSuccessPkIds]\n"), "getSuccessPkIds").hits[0]?.score,
		).toBeGreaterThan(searchPassages(scene(""), "getSuccessPkIds").hits[0]?.score ?? 0);
	});

	it("ranks the document named after the topic above one that mentions it in passing", () => {
		const index = buildPassageIndex([
			official("platform/sdk/sdk-cache.md", `# 缓存\n\n## 用法\n${filler(600, "存取")}`),
			official("platform/sdk/sdk-algo.md", "# 算法\n\n## 动作\n结果缓存到内存。"),
		]);
		expect(searchPassages(index, "缓存").hits[0]?.source.ref).toBe("platform/sdk/sdk-cache.md");
	});

	it("matches whole identifiers only when asked to be exact: a class name's parts are not a mention of it", () => {
		const index = buildPassageIndex([
			local("cosmic-a", "# A\n\n## 探针\n用 FormRuleProbe 读规则。"),
			local("cosmic-b", "# B\n\n## 规则\n这里的 rule 是业务规则。"),
			local("cosmic-c", "# C\n\n## 界面规则\n`FormRule` 的前置条件写在 preCondition 里。"),
		]);
		expect(searchPassages(index, "FormRule").hits.length).toBe(3);
		expect(searchPassages(index, "FormRule", { exact: true }).hits.map((hit) => hit.source.ref)).toEqual([
			"reference:cosmic-c",
		]);
	});

	it("reports a project identifier as absent instead of matching its parts", () => {
		const index = buildPassageIndex([official("platform/a.md", "# A\n\n## 报表\n报表 report copies 份数。")]);
		const result = searchPassages(index, "demo_report_copies");
		expect(result.absent).toEqual(["demo_report_copies"]);
		expect(result.hits).toEqual([]);
	});
});

describe("sectionByHeading", () => {
	const index = buildPassageIndex([local("cosmic-demo-write", BIG_LOCAL)]);

	it("takes a heading path as printed by search, and returns the section with its children", () => {
		const section = sectionByHeading(index, "reference:cosmic-demo-write", "能改什么 › 给公式追加一个字段操作数");
		expect(section.ok && section.text.startsWith("### 给公式追加一个字段操作数")).toBe(true);
		const unit = sectionByHeading(index, "reference:cosmic-demo-write", "能改什么");
		expect(unit.ok && unit.text.includes("### 给公式追加一个字段操作数")).toBe(true);
	});

	it("lists the candidates instead of guessing when a partial heading matches several", () => {
		const result = sectionByHeading(index, "reference:cosmic-demo-write", "小节");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.headings).toEqual(["很长的一节 › 小节甲", "很长的一节 › 小节乙"]);
	});

	it("lists the units when the heading is not there", () => {
		const result = sectionByHeading(index, "reference:cosmic-demo-write", "不存在的标题");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.headings).toEqual(["能改什么", "写入顺序", "很长的一节"]);
	});
});
