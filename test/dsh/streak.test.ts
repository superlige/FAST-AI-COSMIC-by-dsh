/**
 * 重复失败门槛在 cosmic_prod 上的分寸：
 *   1. 库按语句报的错（varchar 比 bigint、openGauss 不认 FILTER），改了语句再发是照着改，不拦；原样重发第三次照旧拦。
 *   2. 失败按动作分开数：sql 失败两次，只读的 meta、log 照常能用。
 *   3. 连不上、没登录这类只有用户能处理的，用户重新配置或登录 monitor 后计数清零。
 */
import { describe, expect, it } from "vitest";
import {
	clearedByProdFix,
	type FailureStreak,
	failureSubject,
	inputDigest,
	nextFailureStreak,
	streakRefusal,
} from "../../src/dsh/streak.ts";

function failAll(tool: string, code: string, inputs: readonly unknown[]): FailureStreak | undefined {
	let streak: FailureStreak | undefined;
	inputs.forEach((input, index) => {
		streak = nextFailureStreak(
			streak,
			{
				tool,
				ok: false,
				at: `2026-01-01T00:00:0${String(index)}Z`,
				code,
				digest: inputDigest(input),
				subject: failureSubject(tool, input),
			},
			0,
		);
	});
	return streak;
}

const sql = (text: string) => ({ action: "sql", sql: text });

describe("cosmic_prod 的重复失败门槛", () => {
	it("库报错后改了语句，第三条照常执行；原样重发第三次照旧拦", () => {
		const streak = failAll("cosmic_prod", "PROD_SQL_FAILED", [sql("select 1 where a = 1"), sql("select 1 filter")]);
		expect(streakRefusal(streak, 0, "cosmic_prod", sql("select 1 where a::text = '1'"))).toBeNull();
		const same = failAll("cosmic_prod", "PROD_SQL_FAILED", [sql("select x"), sql("select x")]);
		expect(streakRefusal(same, 0, "cosmic_prod", sql("select x"))?.code).toBe("COSMIC_REPEATED_FAILURE");
	});

	it("语句闸拒掉的也算报错即改法：换了语句不拦", () => {
		const streak = failAll("cosmic_prod", "PROD_SQL_REFUSED", [sql("delete from t"), sql("update t set a=1")]);
		expect(streakRefusal(streak, 0, "cosmic_prod", sql("select a from t"))).toBeNull();
	});

	it("失败按动作分开数：sql 连不上两次，meta 照常能用，sql 第三次被拦", () => {
		const streak = failAll("cosmic_prod", "PROD_FAILED", [sql("select 1"), sql("select 2")]);
		expect(streakRefusal(streak, 0, "cosmic_prod", { action: "meta", form: "demo_bill" })).toBeNull();
		const refusal = streakRefusal(streak, 0, "cosmic_prod", sql("select 3"));
		expect(refusal?.code).toBe("COSMIC_REPEATED_FAILURE");
		expect(refusal?.remedy).toContain("/cosmic-prod-setup");
	});

	it("用户处理过生产那一头，cosmic_prod 的计数清零；别的工具的计数不动", () => {
		const prod = failAll("cosmic_prod", "PROD_FAILED", [sql("select 1"), sql("select 1")]);
		expect(clearedByProdFix(prod)).toBeUndefined();
		const probe = failAll("cosmic_probe", "PROBE_FAILED", [{ name: "DemoProbe" }, { name: "DemoProbe" }]);
		expect(clearedByProdFix(probe)).toBe(probe);
	});
});
