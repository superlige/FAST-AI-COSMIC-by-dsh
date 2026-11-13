/**
 * S37 2-A.3：探针和本地候选写出的 JSON 按行可读。
 *
 * 以前 `ptpl dump` 的两份 JSON 各是一整行（真机 150～400 KB 一行），grep 一命中就是整份文件，
 * 模型只好写 python 解析。这里锁住三件事：每行有上限、只改空白不改值、同一份数据改一处 diff 只出那一处。
 * Java 那份（探针写文件用）拿同一份样例比，本机有 javac 时当场编译跑一遍。
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { JSON_LAYOUT_WIDTH, layoutJson } from "../../src/kernel/json-layout.ts";

const fixturePath = (name: string): string => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
//本仓库 core.autocrlf=true，检出的样例可能是 CRLF；排版规则只认 LF
const INPUT = readFileSync(fixturePath("json-layout.input.txt"), "utf8").trimEnd();
const EXPECTED = readFileSync(fixturePath("json-layout.expected.txt"), "utf8").replace(/\r\n/g, "\n");
const JAVA_SOURCE = fileURLToPath(new URL("../../resources/probes/JsonLayout.java", import.meta.url));

/** 一行只是一个放不下的标量（缩进 + 可选的键 + 一个字符串/数字 + 可选的逗号）。 */
const LONE_SCALAR = /^\t*(?:"(?:[^"\\]|\\.)*":)?(?:"(?:[^"\\]|\\.)*"|[^,{}[\]"]+),?$/;

/** 去掉字符串以外的空白：排版前后这份文字应该一个字符不差。 */
function squeeze(text: string): string {
	let out = "";
	let inString = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i] as string;
		if (inString) {
			out += ch;
			if (ch === "\\") out += text[++i] ?? "";
			else if (ch === '"') inString = false;
		} else if (ch === '"') {
			inString = true;
			out += ch;
		} else if (!" \t\r\n".includes(ch)) out += ch;
	}
	return out;
}

function changedLines(a: string, b: string): string[] {
	const left = a.split("\n");
	const right = b.split("\n");
	if (left.length !== right.length) throw new Error("行数变了");
	return right.filter((line, i) => line !== left[i]);
}

describe("S37 2-A.3 JSON 按行可读", () => {
	it("固定样例排出来和期望的一字不差", () => {
		expect(layoutJson(INPUT)).toBe(EXPECTED);
	});

	it("每行不超过上限，超了的只能是一个拆不开的长字符串", () => {
		const lines = EXPECTED.trimEnd().split("\n");
		expect(lines.length).toBeGreaterThan(20);
		const wide = lines.filter((line) => line.length > JSON_LAYOUT_WIDTH);
		expect(wide).toHaveLength(1);
		expect(wide[0]).toMatch(/^\t"long":"CONCAT\(/);
		for (const line of wide) expect(line).toMatch(LONE_SCALAR);
	});

	it("只改空白：值、转义、数字写法、键的顺序原样保留", () => {
		const laid = layoutJson(INPUT);
		expect(squeeze(laid)).toBe(INPUT);
		expect(JSON.parse(laid)).toEqual(JSON.parse(INPUT));
		expect(laid).toContain('"fontSize":16.0');
		expect(laid).toContain('"big":1234567890123456789');
		expect(laid).toContain(String.raw`"quote":"他说\"好\"，路径 C:\\work\\a.json"`);
		//已经排过的再排一次不变，多语言映射一条一行、grep 值就看得到是哪个控件
		expect(layoutJson(laid)).toBe(laid);
		expect(laid).toContain('"locale":{"iqXrHx9bBf.bindText":{"zh_CN":"合             金  "},');
	});

	it("同一份数据改一个值，逐行比只差那一行", () => {
		const after = INPUT.replace('"text":"设备型号"', '"text":"设备型号（新）"');
		const changed = changedLines(layoutJson(INPUT), layoutJson(after));
		expect(changed).toEqual([
			'\t\t\t{"id":"U5NmXosgp4","key":"Text1","type":"Text","x":0,"y":0,"width":89.3,"text":"设备型号（新）"}',
		]);
	});

	it("不是合法 JSON 就原样返回，不丢一个字节", () => {
		for (const bad of ['{"a":1', '{"a":1}}', "", "  ", '{"a" 1}', '["x",]', '"没收尾']) {
			expect(layoutJson(bad)).toBe(bad);
		}
	});

	it("打印模板的导出和写前快照都经它写，导出不再叫模型去本地 grep / diff", () => {
		const probe = (name: string): string =>
			readFileSync(fileURLToPath(new URL(`../../resources/probes/${name}.java`, import.meta.url)), "utf8");
		const dump = probe("PrintTplJsonProbe");
		expect(dump.match(/JsonLayout\.layout\(SerializeUtils\.toJsonString\(/g)).toHaveLength(2);
		expect(dump).not.toContain("grep / diff");
		expect(probe("PrintTplWriteProbe").match(/JsonLayout\.layout\(SerializeUtils\.toJsonString\(/g)).toHaveLength(2);
	});

	const javac = spawnSync("javac", ["-version"], { encoding: "utf8" });
	it.skipIf(javac.status !== 0)(
		"Java 那份（探针写文件用）排出来和这边一字不差",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "json-layout-"));
			try {
				writeFileSync(
					join(dir, "LayoutMain.java"),
					[
						"import java.nio.charset.StandardCharsets;",
						"import java.nio.file.Files;",
						"import java.nio.file.Paths;",
						"public class LayoutMain {",
						"    public static void main(String[] a) throws Exception {",
						"        String in = new String(Files.readAllBytes(Paths.get(a[0])), StandardCharsets.UTF_8);",
						"        Files.write(Paths.get(a[1]), JsonLayout.layout(in).getBytes(StandardCharsets.UTF_8));",
						"    }",
						"}",
					].join("\n"),
				);
				const compiled = spawnSync(
					"javac",
					["-encoding", "UTF-8", "-d", dir, join(dir, "LayoutMain.java"), JAVA_SOURCE],
					{ encoding: "utf8" },
				);
				expect(compiled.stderr).toBe("");
				const input = join(dir, "input.json");
				const output = join(dir, "output.json");
				writeFileSync(input, INPUT);
				const ran = spawnSync("java", ["-cp", dir, "LayoutMain", input, output], { encoding: "utf8" });
				expect(ran.status).toBe(0);
				expect(readFileSync(output, "utf8")).toBe(EXPECTED);
				//不合法的也原样返回
				writeFileSync(input, '{"a":1');
				spawnSync("java", ["-cp", dir, "LayoutMain", input, output], { encoding: "utf8" });
				expect(readFileSync(output, "utf8")).toBe('{"a":1');
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		30_000,
	);
});
