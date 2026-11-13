/**
 * S37 2-A.4：值的显示只经过一处。
 *
 * 以前各探针各自把换行换成空格：`003\nASTM E112-25` 在 `--show` 里显示成 `003 ASTM E112-25`，
 * 照抄进 `--expect` 就挂；断言行的「实际=」却带着真换行，被拆成两行。现在显示和断言都走
 * `ProbeAssert.shown`：换行写 `\n`，照着显示抄就对得上，期望里写真换行也照样过。
 * 断言原语是纯 JDK 的，本机有 javac 时当场编译跑一遍；打印、表单这些要连平台的探针只查源码走没走它。
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const probe = (name: string): string =>
	readFileSync(fileURLToPath(new URL(`../../resources/probes/${name}.java`, import.meta.url)), "utf8");

/** 样本那一格（`prtpl_jjfswl` 的 `LayoutCell19`，真机 2026-09-26 的值）。 */
const HARNESS = String.raw`
import java.io.FileOutputStream;
import java.io.PrintStream;

public class ShownMain {
    public static void main(String[] a) throws Exception {
        System.setOut(new PrintStream(new FileOutputStream(a[0]), true, "UTF-8"));
        String raw = "003\nASTM E112-25";
        String[] samples = {raw, "a\tb", "a\r\nb", "a\rb", "x\u0001y", "C:\\work\\a", "没有控制字符", ""};
        for (String s : samples) {
            System.out.println("SHOWN|" + ProbeAssert.shown(s) + "|" + ProbeAssert.shown(ProbeAssert.shown(s)));
        }
        System.out.println("NULL|" + (ProbeAssert.shown(null) == null));
        String copied = ProbeAssert.shown(raw);
        ProbeAssert.isEqual("print-cell", "LayoutCell19", copied, raw);
        ProbeAssert.isEqual("print-cell", "LayoutCell19", raw, raw);
        ProbeAssert.isEqual("print-cell", "LayoutCell19", "003 ASTM E112-25", raw);
        ProbeAssert.containsText("print-cell-contains", "layoutcell11~", "FJ11150002\\n涡流", "应力腐蚀试验机/FJ11150002\n涡流电导率仪");
        ProbeAssert.isEqual("print-cell", "crlf", "a\\nb", "a\r\nb");
        ProbeAssert.isEqual("field", "amount", "15.00", "15.0");
        java.util.List<String> items = new java.util.ArrayList<String>();
        items.add("甲\n乙");
        items.add("丙");
        ProbeAssert.setEquals("combo-items", "zlgd_type", "丙,甲\\n乙", items);
        ProbeAssert.summary();
    }
}
`;

describe("S37 2-A.4 值的显示只经过一处", () => {
	const javac = spawnSync("javac", ["-version"], { encoding: "utf8" });
	it.skipIf(javac.status !== 0)(
		"换行显示成 \\n，照 --show 抄进 --expect 就过，写真换行也过，写成空格照样挂",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "value-display-"));
			try {
				writeFileSync(join(dir, "ShownMain.java"), HARNESS);
				const sources = ["ProbeAssert", "ProbeJson"].map((name) =>
					fileURLToPath(new URL(`../../resources/probes/${name}.java`, import.meta.url)),
				);
				const compiled = spawnSync(
					"javac",
					["-encoding", "UTF-8", "-d", dir, join(dir, "ShownMain.java"), ...sources],
					{ encoding: "utf8" },
				);
				expect(compiled.stderr).toBe("");
				const out = join(dir, "out.txt");
				const ran = spawnSync("java", ["-cp", dir, "ShownMain", out], { encoding: "utf8" });
				expect(ran.status).toBe(0);
				const lines = readFileSync(out, "utf8").replace(/\r\n/g, "\n").trimEnd().split("\n");

				//显示：控制字符都成了看得见的记号，反斜杠原样，再过一遍不变
				const shown = lines.filter((line) => line.startsWith("SHOWN|")).map((line) => line.split("|"));
				expect(shown.map(([, once]) => once)).toEqual([
					String.raw`003\nASTM E112-25`,
					String.raw`a\tb`,
					String.raw`a\nb`,
					String.raw`a\rb`,
					String.raw`x\u0001y`,
					String.raw`C:\work\a`,
					"没有控制字符",
					"",
				]);
				for (const [, once, twice] of shown) expect(twice).toBe(once);
				expect(lines).toContain("NULL|true");

				//断言：每条只占一行，照抄的、真换行的都过，空格的挂
				const asserts = lines.filter((line) => /^\[PROBE\] [✔✘]/.test(line));
				expect(asserts.map((line) => line.includes("✔ PASS"))).toEqual([true, true, false, true, true, true, true]);
				expect(asserts[0]).toBe(
					String.raw`[PROBE] ✔ PASS print-cell LayoutCell19  期望=003\nASTM E112-25  实际=003\nASTM E112-25`,
				);
				expect(asserts[2]).toContain(String.raw`期望=003 ASTM E112-25  实际=003\nASTM E112-25`);
				expect(lines.filter((line) => !/^(\[PROBE|SHOWN\||NULL\|)/.test(line))).toEqual([]);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		30_000,
	);

	it("打给模型看值的探针都经 ProbeAssert.shown，不再各自把换行换成空格", () => {
		const assertSource = probe("ProbeAssert");
		expect(assertSource).toContain("public static String shown(String value)");
		expect(assertSource).toContain("if (shown(e).equals(shown(a)))");
		expect(assertSource).toContain("shown(a).contains(shown(expect))");
		expect(assertSource).toContain(
			'"  期望=" + display(expect) + "  实际=" + (actual == null ? "(取不到)" : display(actual))',
		);
		expect(assertSource).toContain('return v != null && v.trim().isEmpty() ? "(空)" : shown(v);');

		const print = probe("PrintSim");
		expect(print).toContain('return text == null ? "" : ProbeAssert.shown(text);');
		expect(print).toContain("line.append(oneLine(bo.getOutputText()));");
		expect(print).toContain('System.out.println("[PROBE]   [" + i + "] " + oneLine(got.get(i)));');
		expect(print).toContain("trimmed.add(oneLine(cell).trim());");
		expect(probe("FormSim")).toContain("return ProbeAssert.shown(String.valueOf(v));");
		expect(probe("CallSim")).toContain("s = ProbeAssert.shown(s);");
		expect(probe("PrintGridDumpProbe").match(/ProbeAssert\.shown\(/g)).toHaveLength(2);

		const flatten = /\.replace\('\\n', ' '\)|\.replace\("\\n", " "\)/;
		for (const name of ["PrintSim", "FormSim", "CallSim", "PrintGridDumpProbe", "ProbeAssert"]) {
			expect(probe(name)).not.toMatch(flatten);
		}
	});
});
