/**
 * 表单仿真里一个动作抛了异常，这次运行就不能记成验证通过。
 *
 * 真机：`run form … --set 分录[0].字段=值` 有两处改值抛空指针，探针只打了一行
 * 「setValue … ⚠ 失败：java.lang.NullPointerException: (无)」就接着跑，没有栈、没有记录；
 * 最终值的 9 条断言全过，内核照常记了一条 PASS 的验证记录、warnings 为空。
 * 改值后面该跑的联动（排在抛错插件后面的插件、抛错方法里剩下的代码）断在了那里，最终值对上证明不了它们跑过。
 *
 * 表单仿真要连平台才编得过，这里查源码：每个用户动作的 catch 都得走统一的出口（记「这次没跑完整」，
 * 或输入写错记「输入不成立」）。断言原语是纯 JDK 的，本机有 javac 时当场编译跑一遍，看汇总里点名是谁抛的。
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const probePath = (name: string): string =>
	fileURLToPath(new URL(`../../resources/probes/${name}.java`, import.meta.url));

const FORM_SIM = readFileSync(probePath("FormSim"), "utf8").replace(/\r\n/g, "\n");

/** 方法体（有重载就把各个重载连起来）：从签名那一行到下一个同缩进的 static 声明。 */
function methodBody(name: string): string {
	const head = new RegExp(`\\n    static [\\w<>]+ ${name}\\(`, "g");
	const bodies: string[] = [];
	for (let match = head.exec(FORM_SIM); match !== null; match = head.exec(FORM_SIM)) {
		const next = FORM_SIM.indexOf("\n    static ", match.index + 1);
		bodies.push(FORM_SIM.slice(match.index, next < 0 ? undefined : next));
	}
	expect(bodies.length, `FormSim 里没有方法 ${name}`).toBeGreaterThan(0);
	return bodies.join("\n");
}

/** 方法里每个 catch (Throwable t) 块的内容（到配对的右括号）。 */
function catches(body: string): string[] {
	const out: string[] = [];
	const head = /catch \(Throwable t\) \{/g;
	for (let match = head.exec(body); match !== null; match = head.exec(body)) {
		let depth = 1;
		let at = match.index + match[0].length;
		for (; at < body.length && depth > 0; at++) {
			if (body[at] === "{") depth++;
			if (body[at] === "}") depth--;
		}
		out.push(body.slice(match.index, at));
	}
	return out;
}

describe("表单仿真的动作抛错不能记成验证通过", () => {
	// 开表单的每一步、--set 改值、点超链接、点 F7、点按钮、跑操作
	const ACTIONS = ["step", "applySets", "hyperlink", "f7", "clickItem", "runOp"];

	it.each(ACTIONS)("%s 里每个 catch 都走统一出口", (name) => {
		const blocks = catches(methodBody(name));
		expect(blocks.length, `${name} 里没找到 catch (Throwable t)`).toBeGreaterThan(0);
		for (const block of blocks) {
			// step 里「别的探针借开表单、registerListener 抛错不报」那一支是有意不记的，它不在这个块里单独成块
			if (name === "step") {
				expect(block).toMatch(/broke\(name, t\)|ProbeAssert\.incomplete\(/);
				continue;
			}
			expect(block, block).toMatch(/\bthrew\(|\bbroke\(|ProbeAssert\.inputInvalid\(/);
		}
	});

	it("统一出口打出起因链、插件位置和栈，并记成没跑完整", () => {
		const broke = methodBody("broke");
		expect(broke).toContain("HeadlessUiSupport.causes(t)");
		expect(broke).toContain("HeadlessUiSupport.pluginFrame(PLUGIN_NAMES, t)");
		expect(broke).toContain("HeadlessUiSupport.stack(t, 8)");
		expect(broke).toContain("ProbeAssert.incomplete(action, blame, simulator,");
	});

	const javac = spawnSync("javac", ["-version"], { encoding: "utf8" });
	it.skipIf(javac.status !== 0)("汇总里分清是插件、仿真自己还是平台抛的，三种都不算验证通过", () => {
		const dir = mkdtempSync(join(tmpdir(), "formsim-threw-"));
		try {
			writeFileSync(
				join(dir, "ThrewMain.java"),
				`
import java.io.FileOutputStream;
import java.io.PrintStream;

public class ThrewMain {
    public static void main(String[] a) throws Exception {
        System.setOut(new PrintStream(new FileOutputStream(a[0]), true, "UTF-8"));
        ProbeAssert.isEqual("field", "e[0].f", "1", "1");
        ProbeAssert.incomplete("setValue e[0].a = 1", "demo.formplugin.DemoPlugin", false, "NPE");
        ProbeAssert.incomplete("setValue e[0].b = 2", null, true, "NPE");
        ProbeAssert.incomplete("setValue e[0].c = 3", null, false, "NPE");
        ProbeAssert.summary();
    }
}
`,
			);
			const compiled = spawnSync(
				"javac",
				[
					"-encoding",
					"UTF-8",
					"-d",
					dir,
					join(dir, "ThrewMain.java"),
					probePath("ProbeAssert"),
					probePath("ProbeJson"),
				],
				{ encoding: "utf8" },
			);
			expect(compiled.stderr).toBe("");
			const out = join(dir, "out.txt");
			spawnSync("java", ["-cp", dir, "ThrewMain", out], { encoding: "utf8" });
			const text = readFileSync(out, "utf8");
			expect(text).toContain("setValue e[0].a = 1 一步插件 DemoPlugin 抛错");
			expect(text).toContain("setValue e[0].b = 2 一步仿真自己抛错");
			expect(text).toContain("setValue e[0].c = 3 一步平台抛错");
			expect(text).toContain("不算验证通过");
			expect(text.match(/"t":"run-incomplete"/g)?.length).toBe(3);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
