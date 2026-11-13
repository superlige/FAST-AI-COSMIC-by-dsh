import { describe, expect, it } from "vitest";
import { captureFreshness, changedSourceSections } from "../../src/kernel/freshness.ts";
import { evidenceFrom, evidenceIntact, unconfirmedPush, writeEvidence } from "../../src/kernel/verify/evidence.ts";
import { addSource, makeContext } from "./fake-context.ts";

const rule = "2424161753291052032";
const plugin = "com.demo.ConvertPlugin";

function scene(saved: boolean, plugins = [plugin], exitCode = 0) {
	const fake = makeContext();
	const path = addSource(fake, "demo-biz", "com/demo/ConvertPlugin.java", { compiled: true });
	fake.fs.put(path, `package com.demo; public class ConvertPlugin extends AbstractConvertPlugIn {}`, 1);
	const input = {
		argv: ["push", rule, "--pk", "1", "--expect", "base=A"],
		records: [
			{ t: "assert", kind: "field", target: "base", expect: "A", actual: "A", pass: true },
			...(saved ? [{ t: "push-readback", rule, entity: "demo_target", ids: ["2"], plugins }] : []),
		],
		exitCode,
		at: new Date(fake.ctx.ports.clock.now()).toISOString(),
		runtimeKeyId: fake.ctx.runtimeKeyId,
		sourceFingerprint: captureFreshness(fake.ctx).sourceFingerprint,
		gates: { class_fresh: "block" },
		path: "hot" as const,
		warnings: [],
		log: "run.log",
	};
	const evidence = evidenceFrom(input).evidence;
	if (evidence === null) throw new Error("expected evidence");
	writeEvidence(fake.ctx, evidence);
	return { fake, input, evidence, files: [path] };
}

describe("转换结果的保存回读记录", () => {
	it("修改数据库回读主键或插件清单会使摘要失效", () => {
		const s = scene(true);
		expect(evidenceIntact(s.evidence)).toBe(true);
		const forged = structuredClone(s.evidence);
		forged.persistence?.ids.push("3");
		expect(evidenceIntact(forged)).toBe(false);
	});

	it("缺少实体或空主键不能当数据库回读", () => {
		const s = scene(true);
		const built = evidenceFrom({
			...s.input,
			records: [...s.input.records.slice(0, 1), { t: "push-readback", rule, entity: "", ids: [] }],
		});
		expect(built.evidence?.persistence).toBeUndefined();
	});
	it("断言全过后保存回读链异常退出，不能留下通过记录", () => {
		const s = scene(true, [plugin], 1);
		expect(s.evidence.result).toBe("ERROR");
		expect(s.evidence.persistence).toBeUndefined();
	});

	it("同规则另一张单保存成功不能替代旧的内存字段断言", () => {
		const old = scene(false).evidence;
		const saved = scene(true).evidence;
		expect(unconfirmedPush([old, saved]).map((entry) => entry.id)).toEqual([old.id]);
	});

	it("只断言保存成功和张数，没有核对业务字段，仍不能交付", () => {
		const s = scene(true);
		const countOnly = evidenceFrom({
			...s.input,
			records: [
				s.input.records[1]!,
				{ t: "assert", kind: "push-bills", target: "bills", expect: "1", actual: "1", pass: true },
			],
		}).evidence;
		if (countOnly === null) throw new Error("expected evidence");
		expect(unconfirmedPush([countOnly])).toEqual([countOnly]);
	});

	it("源码时间戳未变，也能指出改动所在文件和行段", () => {
		const s = scene(true);
		const before = captureFreshness(s.fake.ctx);
		const path = s.files[0] as string;
		s.fake.fs.put(
			path,
			"package com.demo; public class ConvertPlugin extends AbstractConvertPlugIn { void changed() {} }",
			1,
		);
		const after = captureFreshness(s.fake.ctx);
		expect(changedSourceSections(before, after)).toEqual([
			{ file: "demo-biz/src/main/java/com/demo/ConvertPlugin.java", ranges: ["1-40"] },
		]);
	});
});
