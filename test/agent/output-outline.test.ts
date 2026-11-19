import { describe, expect, it } from "vitest";
import { budgetOutput, outlineOf, outlineText, pickableRemedy } from "../../src/agent/tools/output-budget.ts";

/** 真机那份 `FormRuleProbe` 输出的形状：`===` 开头的宿主段，段里是编号的规则条目。 */
function ruleDump(hosts: number, rulesPerHost: number): string {
	const lines = ["[PROBE] tenant=ierp account=zl240520", "[PROBE] zlgd_sys_test_lssy formId=5YRXZOK14BNA Ap数=1793"];
	for (let host = 1; host <= hosts; host++) {
		lines.push(
			`[PROBE] === 宿主 Ap EntryAp  key=entry${String(host)}  name=分录${String(host)}  规则 ${String(rulesPerHost)} 条`,
		);
		for (let rule = 1; rule <= rulesPerHost; rule++) {
			lines.push(`[PROBE]  [${String(rule)}] 条件 ${"x".repeat(60)}`);
			lines.push(`[PROBE]        真-HideFieldAction  ${"字段".repeat(40)}`);
		}
	}
	return lines.join("\n");
}

describe("落盘文件的目录", () => {
	it("按标题行分段，说得出每段在第几行", () => {
		const text = ruleDump(6, 8);
		const outline = outlineOf(text, 3, text.split("\n").length);
		expect(outline).toHaveLength(6);
		expect(outline[0]?.label).toContain("宿主 Ap EntryAp");
		expect(outline[0]?.from).toBe(3);
		// 段与段首尾相接，不留空洞。
		for (const [index, entry] of outline.entries()) {
			if (index === 0) continue;
			expect(entry.from).toBe((outline[index - 1] as { to: number }).to + 1);
		}
	});

	it("段太多、截短标签也放不下时，留覆盖最大的几段，仍按行号顺序列出来", () => {
		const lines = ["[PROBE] 开头"];
		for (let host = 1; host <= 200; host++) {
			lines.push(`[PROBE] === 宿主 Ap EntryAp  key=entry${String(host)}  规则 ${String(host % 7)} 条`);
			for (let rule = 0; rule < host % 7; rule++) lines.push(`[PROBE]  [${String(rule)}] 条件 x`);
		}
		const text = lines.join("\n");
		const outline = outlineOf(text, 2, lines.length);
		expect(outline.length).toBeLessThan(200);
		expect(Buffer.byteLength(pickableRemedy(text, 2, lines.length), "utf8")).toBeLessThanOrEqual(3000);
		expect(outline.map((entry) => entry.from)).toEqual([...outline.map((entry) => entry.from)].sort((a, b) => a - b));
		// 留下的是大的：每段都有 6 条规则（host % 7 === 6）的那些先进。
		expect(outline.every((entry) => entry.to - entry.from >= 5)).toBe(true);
	});

	it("顶层放不下时先截短标签，再丢段", () => {
		const lines = ["[PROBE] 实体 bill"];
		for (let entry = 1; entry <= 36; entry++) {
			lines.push(
				`[PROBE]  【分录】zlgd_entryentity_${String(entry)}  第${String(entry)}号试验原始记录  表=tk_zlgd_entry_${String(entry)}`,
			);
			for (let field = 0; field < 20; field++) lines.push(`[PROBE]    zlgd_f${String(field)}  字段  TextProp`);
		}
		const text = lines.join("\n");
		const outline = outlineOf(text, 2, lines.length);
		expect(outline).toHaveLength(36);
		expect(outline[0]?.label.startsWith("zlgd_entryentity_1 第1号")).toBe(true);
		expect(outline.some((entry) => entry.label.endsWith("…"))).toBe(true);
	});

	it("分录下面缩进的字段归分录，分录之间夹的表头字段不归前一个分录", () => {
		const lines = [
			"[PROBE] 实体 bill  名称=检测单",
			...Array.from({ length: 5 }, (_, i) => `[PROBE]  head${String(i)}  表头${String(i)}  TextProp`),
			"[PROBE]  【分录】entry_a  收样信息  表=tk_a",
			...Array.from({ length: 20 }, (_, i) => `[PROBE]    a${String(i)}  A字段  TextProp`),
			"[PROBE]    【分录】entry_a_lk  关联子实体  表=tk_a_lk",
			...Array.from({ length: 4 }, (_, i) => `[PROBE]      lk${String(i)}  源单  BigIntProp`),
			"[PROBE]    a_tail  分录尾字段  TextProp",
			...Array.from({ length: 10 }, (_, i) => `[PROBE]  wt${String(i)}  委托${String(i)}  TextProp`),
			"[PROBE]  【分录】entry_b  化学分析  表=tk_b",
			...Array.from({ length: 20 }, (_, i) => `[PROBE]    b${String(i)}  B字段  TextProp`),
			"[PROBE] 命中字段 60 个",
		];
		const text = lines.join("\n");
		const outline = outlineOf(text, 2, lines.length);
		const at = (key: string) => outline.find((entry) => entry.label.startsWith(key));
		const a = at("entry_a ");
		const lk = at("entry_a_lk");
		// 子分录套在分录里，分录收到它自己的尾字段为止（含子分录后面那行 a_tail）。
		expect(lines[(a?.to as number) - 1]).toContain("a_tail");
		expect(lk?.depth).toBe(1);
		expect(lk?.to).toBe((lk?.from as number) + 4);
		// 夹在两个分录之间的表头字段单独成一截，用它第一行起名。
		const between = outline.find((entry) => entry.from === (a?.to as number) + 1);
		expect(between?.label).toContain("wt0");
		expect(at("entry_b")?.from).toBe((between?.to as number) + 1);
	});

	it("各段标题开头一样时只说一次", () => {
		const lines = ["[PROBE] 实体 bill"];
		for (let entry = 1; entry <= 6; entry++) {
			lines.push(`[PROBE]  【分录】entry${String(entry)}  分录${String(entry)}`);
			for (let field = 0; field < 10; field++) lines.push(`[PROBE]    f${String(field)}  字段  TextProp`);
		}
		const text = lines.join("\n");
		const remedy = pickableRemedy(text, 2, lines.length);
		expect(remedy).toContain("开头的 【分录】 已省");
		expect(remedy.match(/【分录】/g)).toHaveLength(1);
		expect(remedy).toContain("entry3 分录3");
	});

	it("影响面的 `─ 插件` 和布局的 `── 控件` 也认成段落标题", () => {
		const lines = ["[IMPACT] 字段 zlgd_x 被这些插件用到："];
		for (let plugin = 1; plugin <= 8; plugin++) {
			lines.push(`[IMPACT] ─ Plugin${String(plugin)} [form，挂 zlgd_bill]  src/Plugin${String(plugin)}.java`);
			for (let use = 0; use < 6; use++) lines.push(`[IMPACT]     第 ${String(use)} 处 getModel().setValue`);
		}
		const outline = outlineOf(lines.join("\n"), 2, lines.length);
		expect(outline).toHaveLength(8);
		expect(outline[0]?.label).toContain("Plugin1 [form");
	});

	it("一个标题行都没有时按块均分，每块拿第一行当标签", () => {
		const text = Array.from({ length: 300 }, (_, index) => `    普通输出第 ${String(index + 1)} 行`).join("\n");
		const outline = outlineOf(text, 1, 300);
		expect(outline.length).toBeGreaterThan(1);
		expect(outline[0]?.label).toContain("普通输出第 1 行");
		expect(outline.at(-1)?.to).toBe(300);
	});

	it("省略段本来就短就不做目录——翻得完的东西不需要目录", () => {
		const text = ruleDump(6, 8);
		expect(outlineOf(text, 3, 20)).toEqual([]);
	});

	it("`[PROBE-ERR]` 这类行单独成段：找全文的人找的就是它", () => {
		const lines = [
			...Array.from({ length: 60 }, (_, index) => `[PROBE] 普通第 ${String(index + 1)} 行`),
			"[PROBE-ERR] 断言失败：zlgd_nz_ls1 期望 显示，实际 隐藏",
			...Array.from({ length: 60 }, (_, index) => `[PROBE] 后续第 ${String(index + 1)} 行`),
		];
		const outline = outlineOf(lines.join("\n"), 1, lines.length);
		expect(outline.some((entry) => entry.label.includes("[PROBE-ERR]"))).toBe(true);
	});

	it("渲染成 remedy：给行号、给能直接抄的取法", () => {
		const text = ruleDump(6, 8);
		const rendered = outlineText(text, "D:/p/.cosmic-ai/work/out/cosmic_probe-7.out", 3, text.split("\n").length);
		expect(rendered).toContain("省略段（第 3–");
		expect(rendered).toContain("sed -n '<起>,<止>p' D:/p/.cosmic-ai/work/out/cosmic_probe-7.out");
		expect(rendered).toContain("宿主 Ap EntryAp");
	});

	it("目录覆盖的正是 budgetOutput 报出来的那一段", () => {
		const text = ruleDump(20, 6);
		const budget = budgetOutput(text);
		expect(budget.truncated).toBe(true);
		const outline = outlineOf(text, budget.omittedFrom as number, budget.omittedTo as number);
		expect(outline[0]?.from).toBeGreaterThanOrEqual(budget.omittedFrom as number);
		expect(outline.at(-1)?.to).toBeLessThanOrEqual(budget.omittedTo as number);
	});

	it("没有目录时渲染成空串，调用方好退回原来那句话", () => {
		expect(outlineText("a\nb\nc", "D:/x.out", 1, 3)).toBe("");
	});
});
