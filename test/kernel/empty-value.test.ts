/**
 * 「空」按同一个值比。
 *
 * 空有几种写法：字段没值是 null，空下拉、空文本从库里读回来是 "" 或空格，断言写 `字段=` 是 ""。
 * 原来断言原语只认 null 等于 null，`run op --expect 下拉=`（期望空）对上实际 null 永远判失败，还把 null 显示成「(取不到)」；
 * 改数据的探针把要改成的空记成 `<null>`、回读的空记成 ""，改成空永远「回读不是新值」、整批回滚。
 * 断言原语是纯 JDK 的，本机有 javac 时当场编译跑一遍；改数据的探针要连平台，只查源码走没走同一条规矩。
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const probePath = (name: string): string =>
	fileURLToPath(new URL(`../../resources/probes/${name}.java`, import.meta.url));

const HARNESS = `
import java.io.FileOutputStream;
import java.io.PrintStream;

public class EmptyMain {
    public static void main(String[] a) throws Exception {
        System.setOut(new PrintStream(new FileOutputStream(a[0]), true, "UTF-8"));
        ProbeAssert.isEqual("field", "e-null", "", null);
        ProbeAssert.isEqual("field", "e-empty", "", "");
        ProbeAssert.isEqual("field", "e-blank", "", "  ");
        ProbeAssert.isEqual("field", "v-null", "是", null);
        ProbeAssert.isEqual("field", "e-value", "", "是");
        ProbeAssert.isEqual("field", "zero", "0", null);
        ProbeAssert.unresolved("field", "missing", "", "取不到值：没有这一行");
        ProbeAssert.isEqual("field", "nonempty-value", "@nonempty", "202610-0004");
        ProbeAssert.isEqual("field", "nonempty-null", "@nonempty", null);
        ProbeAssert.isEqual("field", "nonempty-blank", "@nonempty", "  ");
        ProbeAssert.isEqual("field", "slash", "/", "202610-0004");
        ProbeAssert.isEqual("field", "literal", "@literal:@nonempty", "@nonempty");
        ProbeAssert.isEqual("field", "nonempty-zero", "@nonempty", 0);
        ProbeAssert.setEquals("field", "nonempty-list", "@nonempty", java.util.Arrays.asList("A"));
        ProbeAssert.setEquals("field", "nonempty-empty-list", "@nonempty", java.util.Arrays.asList(""));
        ProbeAssert.unresolved("field", "missing-nonempty", "@nonempty", "取不到值");
        ProbeAssert.isEqual("field", "nonempty-false", "@nonempty", false);
        ProbeAssert.isEqual("call-return", "$", "@nonempty", new java.util.ArrayList<String>());
        ProbeAssert.isEqual("call-return", "$", "@nonempty", new String[0]);
        ProbeAssert.isEqual("call-return", "$", "@nonempty", new java.util.HashMap<String, String>());
        ProbeAssert.summary();
    }
}
`;

describe("空按同一个值比", () => {
	const javac = spawnSync("javac", ["-version"], { encoding: "utf8" });
	it.skipIf(javac.status !== 0)(
		"期望空对上 null、空串、空格都过；有值对空、空对有值都挂；空写成「(空)」不写「(取不到)」",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "empty-value-"));
			try {
				writeFileSync(join(dir, "EmptyMain.java"), HARNESS);
				const compiled = spawnSync(
					"javac",
					[
						"-encoding",
						"UTF-8",
						"-d",
						dir,
						join(dir, "EmptyMain.java"),
						probePath("ProbeAssert"),
						probePath("ProbeJson"),
					],
					{ encoding: "utf8" },
				);
				expect(compiled.stderr).toBe("");
				const out = join(dir, "out.txt");
				spawnSync("java", ["-cp", dir, "EmptyMain", out], { encoding: "utf8" });
				const asserts = readFileSync(out, "utf8")
					.replace(/\r\n/g, "\n")
					.split("\n")
					.filter((line) => /^\[PROBE\] [✔✘]/.test(line));
				expect(asserts.map((line) => line.includes("✔ PASS"))).toEqual([
					true,
					true,
					true,
					false,
					false,
					false,
					false,
					true,
					false,
					false,
					false,
					true,
					true,
					true,
					false,
					false,
					true,
					false,
					false,
					false,
				]);
				expect(asserts[0]).toBe("[PROBE] ✔ PASS field e-null  期望=(空)  实际=(空)");
				expect(asserts[3]).toBe("[PROBE] ✘ FAIL field v-null  期望=是  实际=(空)");
				expect(asserts[6]).toContain("实际=(取不到)");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);

	it("改数据的探针回读时，空也按同一个值比", () => {
		const source = readFileSync(probePath("DataUpdateProbe"), "utf8");
		expect(source).toContain("if (v == null || v instanceof String && ((String) v).trim().isEmpty()) {");
		expect(source).not.toContain('return "<null>";');
	});
});
