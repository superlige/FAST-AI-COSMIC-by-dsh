import { describe, expect, it } from "vitest";
import { budgetOutput, omittedKinds, pickableRemedy, pickLines } from "../../src/agent/tools/output-budget.ts";

const bytes = (text: string): number => new TextEncoder().encode(text).length;

describe("tool prose byte budget", () => {
	it("includes the omission marker inside the byte limit", () => {
		const result = budgetOutput(Array.from({ length: 200 }, (_, index) => `第 ${index} 行内容`).join("\n"), 500);
		expect(result.truncated).toBe(true);
		expect(bytes(result.shown)).toBeLessThanOrEqual(500);
		expect(result.shown).toContain("… 中间省略 ");
	});

	it("does not let one generated line bypass the limit", () => {
		const result = budgetOutput(`对象=${"长标识符".repeat(1000)}`, 500);
		expect(result.truncated).toBe(true);
		expect(bytes(result.shown)).toBeLessThanOrEqual(500);
	});
});

describe("S37 2-A.2 按条件取回", () => {
	const text = [
		"[PROBE] 开头",
		"INFO z.zljy.printplugin.MeasuringToolLookup: 命中 1 个",
		"探针直接打印的一行",
		"[PROBE-ERR] 出错了",
		"\tat zlgd.Foo.bar(Foo.java:1)",
		"[PROBE] 结尾 LayoutCell",
	].join("\n");

	it("省掉的那段按种类计数", () => {
		expect(omittedKinds(text, 1, 6)).toBe("[PROBE] 2、日志 1、其他输出 1、[PROBE-ERR] 1、异常栈 1");
		expect(omittedKinds(text, 2, 3)).toBe("日志 1、其他输出 1");
	});

	it("行号范围和关键字用的是同一套行号", () => {
		expect(pickLines(text, "2-3").text).toBe(
			"2: INFO z.zljy.printplugin.MeasuringToolLookup: 命中 1 个\n3: 探针直接打印的一行",
		);
		expect(pickLines(text, "6").text).toBe("6: [PROBE] 结尾 LayoutCell");
		// 不分大小写的正则；写得不合语法就当普通字符串找。
		expect(pickLines(text, "layoutcell|命中").text).toBe(
			"2: INFO z.zljy.printplugin.MeasuringToolLookup: 命中 1 个\n6: [PROBE] 结尾 LayoutCell",
		);
		expect(pickLines(text, "Foo.bar(").matched).toBe(1);
		expect(pickLines(text, "没有这行")).toEqual({ text: "", matched: 0, shown: 0, lastLine: null });
	});

	it("超了预算只给前面几行，并说清给到第几行", () => {
		const many = Array.from({ length: 100 }, (_, i) => `[PROBE] 第 ${String(i + 1)} 行 ${"x".repeat(80)}`).join("\n");
		const picked = pickLines(many, "PROBE", 1000);
		expect(picked.matched).toBe(100);
		expect(picked.shown).toBeLessThan(100);
		expect(picked.lastLine).toBe(picked.shown);
		expect(bytes(picked.text)).toBeLessThanOrEqual(1000);
	});

	it("说明里有省了哪几行、各是什么、怎么取，没有文件路径", () => {
		const remedy = pickableRemedy(text, 2, 5);
		expect(remedy).toBe(
			'省略了第 2–5 行（日志 1、其他输出 1、[PROBE-ERR] 1、异常栈 1）。\n同一调用加 raw="起-止" 或 raw="关键字"（正则）取回，不重跑。',
		);
	});
});
