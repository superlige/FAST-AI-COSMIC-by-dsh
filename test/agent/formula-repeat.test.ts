import { describe, expect, it } from "vitest";
import {
	compareFormulaErrors,
	createFormulaErrorLedger,
	type FormulaError,
	formulaErrorsOf,
} from "../../src/agent/tools/formula-repeat.ts";

const parse = (input: string, token: string | null, detail: string): FormulaError => ({
	domain: "form",
	where: "RULE_GROUPS 组 宽度类",
	kind: "parse",
	input,
	token,
	detail,
});

const fn = (input: string, token: string, where = "BIZ_CONDITION"): FormulaError => ({
	domain: "biz",
	where,
	kind: "function",
	input,
	token,
	detail: null,
});

describe("formula repeat comparison", () => {
	it("says nothing the first time a spot fails", () => {
		const ledger = createFormulaErrorLedger();
		expect(compareFormulaErrors(ledger, [parse('a == "2"', "=", "第 4 个字符")])).toEqual([]);
	});

	it("names an unchanged error spot when the second input still breaks at the same token", () => {
		const ledger = createFormulaErrorLedger();
		compareFormulaErrors(ledger, [parse('a == "2"', "=", "第 4 个字符")]);
		const notes = compareFormulaErrors(ledger, [parse('a == "3"', "=", "第 4 个字符")]);
		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain("第 2 次平台解析不过");
		expect(notes[0]).toContain("这一处两次都没改");
		expect(notes[0]).toContain('上次：a == "2"；这次：a == "3"');
	});

	it("reports a moved parse error without claiming the earlier one is fixed", () => {
		const ledger = createFormulaErrorLedger();
		compareFormulaErrors(ledger, [parse("a = 1 && b = 2", "&", "第 8 个字符")]);
		const [note] = compareFormulaErrors(ledger, [parse("a = 1 and b = 2)", ")", "第 16 个字符")]);
		expect(note).toContain("错处挪了");
		expect(note).toContain("平台只报第一处");
		expect(note).not.toContain("已不再报");
	});

	it("says identical input plainly", () => {
		const ledger = createFormulaErrorLedger();
		compareFormulaErrors(ledger, [fn("CONCATX(a)", "CONCATX")]);
		const [note] = compareFormulaErrors(ledger, [fn("CONCATX(a)", "CONCATX")]);
		expect(note).toContain("输入和上次一字不差");
	});

	it("compares a renamed function at the same spot and only claims it is gone when it is", () => {
		const ledger = createFormulaErrorLedger();
		compareFormulaErrors(ledger, [fn("CONCATX(a)", "CONCATX")]);
		const [gone] = compareFormulaErrors(ledger, [fn("CONCAT_X(a)", "CONCAT_X")]);
		expect(gone).toContain("上次是「CONCATX」（这次已不再报），这次是「CONCAT_X」");

		const both = createFormulaErrorLedger();
		compareFormulaErrors(both, [fn("X1(a) + X2(b)", "X1")]);
		const notes = compareFormulaErrors(both, [fn("X1(a) + X3(b)", "X1"), fn("X1(a) + X3(b)", "X3")]);
		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain("还是「X1」");
	});

	it("keeps different spots and different kinds apart, and never pairs errors from the same call", () => {
		const ledger = createFormulaErrorLedger();
		expect(
			compareFormulaErrors(ledger, [fn("A(x)", "A", "BIZ_CONDITION"), fn("B(x)", "B", "BIZ_CONDITION")]),
		).toEqual([]);
		expect(compareFormulaErrors(ledger, [fn("A(x)", "A", "BIZ_TRUE formula qty")])).toEqual([]);
		expect(
			compareFormulaErrors(ledger, [{ ...fn("A(x)", "A"), kind: "field", token: "zlgd_x", input: "zlgd_x = 1" }]),
		).toEqual([]);
	});

	it("reads records from a probe result and from a meta report's nested probe", () => {
		const record = {
			t: "formula-error",
			domain: "print",
			where: "LayoutCell3",
			kind: "function",
			input: "CONCATX(1)",
			token: "CONCATX",
		};
		expect(formulaErrorsOf({ json: { records: [record, { t: "formula-item" }] } })).toHaveLength(1);
		expect(formulaErrorsOf({ probe: { json: { records: [record] } } })[0]?.token).toBe("CONCATX");
		expect(formulaErrorsOf({ json: { records: [{ ...record, where: "" }] } })).toEqual([]);
	});
});
