import { describe, expect, it } from "vitest";
import { budgetApiMethods, DEFAULT_API_METHOD_LIMIT } from "../../src/agent/tools/output-budget.ts";

/**
 * The `api` answer's context budget.
 *
 * Measured cause: twelve single-class `api` calls in one real session returned
 * 262 KB between them -- 21% of the whole context -- because every class ships
 * every method's full javadoc, while the caller was only satisfying the probe
 * import gate ("was this class looked up").
 */
describe("api answer budget", () => {
	const rendered = (name: string): string[] => [
		`static Algo ${name}(String algoKey)`,
		"  取一个算法上下文。",
		`  @param algoKey 标识`,
		"  @return 上下文",
	];

	it("keeps signature lines and drops the documentation bodies", () => {
		const cut = budgetApiMethods([...rendered("create"), ...rendered("close")]);
		expect(cut.methods).toEqual(["static Algo create(String algoKey)", "static Algo close(String algoKey)"]);
		expect(cut.bodiesDropped).toBe(true);
		expect(cut.omittedMethods).toBe(0);
	});

	it("hands a narrowed answer over whole", () => {
		// `<fqcn>#<method>` already narrowed it; cutting again would leave the
		// caller with the one signature it just asked about and none of the prose.
		const cut = budgetApiMethods(rendered("create"), { full: true });
		expect(cut.methods).toEqual(rendered("create"));
		expect(cut.bodiesDropped).toBe(false);
	});

	it("caps a class with a very large surface and says how many were dropped", () => {
		const many = Array.from({ length: DEFAULT_API_METHOD_LIMIT + 15 }, (_, i) => `void m${String(i)}()`);
		const cut = budgetApiMethods(many);
		expect(cut.methods).toHaveLength(DEFAULT_API_METHOD_LIMIT);
		expect(cut.omittedMethods).toBe(15);
	});

	it("leaves a small signature-only list untouched", () => {
		const cut = budgetApiMethods(["void flush()", "int size()"]);
		expect(cut.methods).toEqual(["void flush()", "int size()"]);
		expect(cut.bodiesDropped).toBe(false);
		expect(cut.omittedMethods).toBe(0);
	});
});
