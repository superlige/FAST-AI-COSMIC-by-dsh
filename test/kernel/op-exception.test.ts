import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("操作异常不推断未提交，回读字段也不能掩盖异常", () => {
	const op = readFileSync("resources/probes/OpSandbox.java", "utf8");
	const spec = readFileSync("resources/probes/ExpectSpec.java", "utf8");
	expect(op).toContain("? Boolean.TRUE : null");
	expect(op).toContain('ProbeAssert.unresolved("op-exception"');
	expect(op).toContain("readback = BusinessDataServiceHelper.loadSingle(pk, c.entity)");
	expect(op).toContain("c.expect, readback != null");
	expect(spec).toContain("failed && !expectsFailure && !databaseReadback");
	expect(spec).not.toContain("操作没跑起来");
	expect(spec).not.toContain("单据没存进去");
});
