/**
 * S37 3.7：真提交之后改过的值留在单上，拿同一张单再跑、这次又没给断言字段赋值，断言就可能碰巧对上。
 * 以前靠工具说明里一句「断言要靠的字段都在这次 --set 里给值」提醒；现在 run op / run form 打开已有单据时
 * 自己记下断言字段跑之前的值，跑完对照，跑之前就是期望值、这次又没 --set 的，结果里标一行。
 *
 * 探针要连苍穹的包才编得过，这里不跑 Java，锁的是源码里的先后：原值在 --set 之前记、对照在断言之后做。
 * 真机上验：`scripts/verify-prior-value.ts`。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { blankJavaNoise } from "../../src/kernel/policy/probe-scan.ts";

const PROBES = fileURLToPath(new URL("../../resources/probes/", import.meta.url));
const code = (file: string): string => blankJavaNoise(readFileSync(join(PROBES, file), "utf8"));

function order(text: string, ...patterns: RegExp[]): number[] {
	return patterns.map((pattern) => text.search(pattern));
}

describe("S37 3.7 运行自己查碰巧对上的断言", () => {
	it("run op：--pk 打开的单，--set 之前记原值，断言之后对照", () => {
		const op = code("OpSandbox.java");
		const [prior, apply, assert, note] = order(
			op,
			/ExpectSpec\.priorValues\(obj, c\.expect, own\)/,
			/applySets\(met, obj, own\)/,
			/ExpectSpec\.operation\(r, obj, c\.expect\)/,
			/ExpectSpec\.notePrior\(prior, obj, c\.expect\)/,
		);
		expect(prior).toBeGreaterThan(0);
		expect(prior).toBeLessThan(apply as number);
		expect(assert).toBeLessThan(note as number);
		// 新建的单没有「上次留下的值」
		expect(op).toMatch(/prior = c\.pk\.isEmpty\(\) \? null : ExpectSpec\.priorValues\(/);
	});

	it("run form：打开已有单据时同样在 --set 之前记、断言之后对照", () => {
		const form = code("FormSim.java");
		const [prior, apply, assert, note] = order(
			form,
			/ExpectSpec\.priorValues\(/,
			/applySets\(view, env\(/,
			/ExpectSpec\.model\(view\.getModel\(\), env\(/,
			/ExpectSpec\.notePrior\(prior,/,
		);
		expect(prior).toBeGreaterThan(0);
		expect(prior).toBeLessThan(apply as number);
		expect(assert).toBeLessThan(note as number);
		expect(form).toMatch(/prior = edit\s*\?\s*ExpectSpec\.priorValues\(/);
	});

	it("对照只标不判：PASS 照记，用断言同一口径比，这次 --set 过的字段不记原值", () => {
		const spec = code("ExpectSpec.java");
		const note = spec.slice(spec.indexOf("public static void notePrior("));
		const body = note.slice(0, note.indexOf("\n    }\n"));
		expect(body).toMatch(/ProbeAssert\.same\(/);
		expect(body).not.toMatch(/ProbeAssert\.(isEqual|unresolved|setEquals)\(/);
		const prior = spec.slice(spec.indexOf("public static Map<String, String> priorValues("));
		expect(prior.slice(0, prior.indexOf("return prior;\n    }\n"))).toMatch(
			/assigned\.contains\(pos\.toString\(\)\)/,
		);
	});
});
