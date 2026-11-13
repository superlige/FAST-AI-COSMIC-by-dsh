/**
 * 参数太长时 javac 走参数文件。
 *
 * 2026-09-27 真机：刚克隆的工程 567 个源码全没编过，cosmic_fast 把全部路径拼进 javac 命令行，
 * 超过 Windows 32,767 字符的上限，spawn 抛 ENAMETOOLONG，整条命令崩掉。
 */
import { describe, expect, it } from "vitest";
import { JAVAC_COMMAND_LINE_BUDGET, runJavac } from "../../src/kernel/toolchain.ts";
import { makeContext } from "./fake-context.ts";

describe("runJavac 参数文件", () => {
	it("参数不长时照旧全放命令行，不写文件", async () => {
		const fake = makeContext();
		await runJavac(fake.ctx, ["-d", "D:/out", "D:/proj/A.java"]);
		expect(fake.proc.runsOf("javac")[0]?.args).toEqual(["-J-Dfile.encoding=UTF-8", "-d", "D:/out", "D:/proj/A.java"]);
	});

	it("超长时 -J 和 @ 留在命令行，其余按原顺序进参数文件，跑完删掉", async () => {
		const fake = makeContext();
		const files = Array.from(
			{ length: 400 },
			(_, index) => `D:\\proj\\zlgd-hhx\\src\\main\\java\\zlgd\\some\\deep\\pkg\\Name ${String(index)}.java`,
		);
		expect(files.join(" ").length).toBeGreaterThan(JAVAC_COMMAND_LINE_BUDGET);
		let written = "";
		fake.proc.handler = (spec) => {
			const at = spec.args.find((arg) => arg.startsWith("@D:/cache"));
			written = at === undefined ? "" : fake.fs.read(at.slice(1));
			return { status: 0 };
		};
		await runJavac(fake.ctx, [
			"-J-Xmx1g",
			"-encoding",
			"UTF-8",
			"@D:/proj/cosmic-javac.args",
			"-d",
			"D:/out",
			...files,
		]);

		const args = fake.proc.runsOf("javac")[0]?.args ?? [];
		expect(args.slice(0, 3)).toEqual(["-J-Dfile.encoding=UTF-8", "-J-Xmx1g", "@D:/proj/cosmic-javac.args"]);
		expect(args).toHaveLength(4);
		expect(args.join(" ").length).toBeLessThan(JAVAC_COMMAND_LINE_BUDGET);
		const lines = written.trimEnd().split("\n");
		expect(lines.slice(0, 4)).toEqual(['"-encoding"', '"UTF-8"', '"-d"', '"D:/out"']);
		expect(lines).toHaveLength(4 + files.length);
		expect(lines[4]).toBe(
			'"D:\\\\proj\\\\zlgd-hhx\\\\src\\\\main\\\\java\\\\zlgd\\\\some\\\\deep\\\\pkg\\\\Name 0.java"',
		);
		expect(fake.fs.exists((args[3] ?? "").slice(1))).toBe(false);
	});
});
