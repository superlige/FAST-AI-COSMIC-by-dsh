/**
 * S37：cosmic 返回里提到平台 jar 时给完整路径。
 *
 * 真机 54 份会话里 5 次 `find /` 扫全盘，4 次在找苍穹的 jar；其中两次找的正是 findclass、公式目录刚报过
 * 名字的那个——返回里只有文件名，模型想 javap 或解开看就只能满盘去找（最长一次挂了 28 分钟）。
 * 这两个 Java 要连苍穹包才编得过，这里不跑，锁源码：findclass 每行、sig 的「来自 jar」、公式目录的 source 都给完整路径。
 * 临时探针的 API 核对那一行（codeSource）仍给文件名：一次核十几个类，模型拿它不是为了去开 jar。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string): string =>
	readFileSync(new URL(`../../resources/${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

describe("S37 提到 jar 就给路径", () => {
	it("ApiTool：findclass 每行和 sig 的来自 jar 给完整路径", () => {
		const tool = read("tools/ApiTool.java");
		expect(tool).toMatch(/hits\.add\(pad\(cls, 62\) \+ " <- " \+ f\.getAbsolutePath\(\)\)/);
		expect(tool).toMatch(/" {2}来自 jar : " \+ codePath\(c\)/);
		expect(tool).toMatch(/private static String codePath\([^)]*\) \{[\s\S]*?getAbsolutePath\(\)/);
	});

	it("公式目录的 source 给 jar 的完整路径", () => {
		const probe = read("probes/FormulaFunctionProbe.java");
		const body = probe.slice(probe.indexOf("private static String jarName(String url)"));
		expect(body.slice(0, body.indexOf("\n    }\n"))).toMatch(
			/new java\.io\.File\(new java\.net\.URI\(value\)\)\.getAbsolutePath\(\)/,
		);
	});
});
