/**
 * BizRuleProbe 原位改一条已有业务规则（BIZ_RULE）：要连平台跑，这里查源码里的顺序和判据。
 *
 * 真机复盘：设计器里配的业务规则描述没有我们的前缀，按 BIZ_TAG 摘不掉；只能新增一条，
 * 两条规则给同一个字段赋值，谁后跑谁赢。原位改之后还是原来那条规则。
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (name: string): string =>
	readFileSync(new URL(`../../resources/probes/${name}.java`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const java = read("BizRuleProbe");
const guard = read("IsvGuard");

/** 从 `start` 所在行起，按花括号配对截出一整段。 */
function block(source: string, start: string): string {
	const at = source.indexOf(start);
	if (at < 0) throw new Error(`源码里没有 ${start}`);
	const open = source.indexOf("{", at);
	let depth = 0;
	for (let i = open; i < source.length; i++) {
		if (source[i] === "{") depth++;
		if (source[i] === "}") depth--;
		if (depth === 0) return source.slice(source.lastIndexOf("\n", at) + 1, i + 1);
	}
	throw new Error(`${start} 的花括号没配上`);
}

describe("BizRuleProbe 原位改已有规则", () => {
	const edit = block(java, "private static void edit(");

	it("BIZ_RULE 不和新增、摘除的入参混用，在读元数据之前就拒", () => {
		const run = block(java, "public static void run()");
		expect(run.indexOf("if (!ruleId.isEmpty() && write)")).toBeLessThan(run.indexOf("MetadataDao.readMeta("));
		expect(run.indexOf("edit(em, id, host, ruleId, apply)")).toBeLessThan(run.indexOf("write(em, id, host, tag"));
	});

	it("先过两道红线（实体是本 ISV 的、规则自己记的 isv 也是），再动规则；规则 isv 不对就拒", () => {
		expect(edit.indexOf("IsvGuard.assertOwnEntity(em.getKey(), em)")).toBeLessThan(
			edit.indexOf("IsvGuard.assertOwnBizRule(ruleId, rule.getIsv())"),
		);
		expect(edit.indexOf("IsvGuard.assertOwnBizRule(")).toBeLessThan(edit.indexOf("rule.setPreCondition("));
		const own = block(guard, "public static void assertOwnBizRule(");
		expect(own).toMatch(/if \(!ISV\.equalsIgnoreCase\(nz\(ruleIsv\)\)\) \{\s*deny\(/);
		// 写入确认精确到 实体.规则id
		expect(own).toContain('assertConfirmedUnder("业务规则", owner, ruleId)');
	});

	it("公式只改正好一个：给同一字段赋值的计算公式有零个或多个都拒，不猜", () => {
		const pick = block(java, "private static FormulaAction formulaFor(");
		expect(pick).toContain("if (hits.size() == 1) return hits.get(0);");
		expect(pick).toContain("throw new IllegalArgumentException(");
	});

	it("核表达式、构建运行态、试算都在 dry-run 结束行之前；APPLY 才保存，保存后回读", () => {
		const check = edit.indexOf("FormulaCheck.stopOnBad(bad)");
		const build = edit.indexOf("rule.buildEntityRule(host.getKey())");
		const trial = edit.indexOf("RuleSim.tryBiz(");
		const end = edit.indexOf("dry-run 结束，未写入");
		const save = edit.indexOf("writer.save(em)");
		const done = edit.indexOf('rebuildRuntimeMetaById(" + metaId + ") 完成');
		const back = edit.indexOf("readBack(metaId, ruleId, changes)");
		expect(check).toBeGreaterThan(0);
		expect(check).toBeLessThan(build);
		expect(build).toBeLessThan(trial);
		expect(trial).toBeLessThan(end);
		expect(end).toBeLessThan(save);
		expect(save).toBeLessThan(done);
		expect(done).toBeLessThan(back);
		// 每一项都已经是这样：不打 dry-run 结束行（那一行会被当成一份待确认的修改）
		expect(edit.indexOf("要改的每一项都已经是这样")).toBeLessThan(end);
	});
});
