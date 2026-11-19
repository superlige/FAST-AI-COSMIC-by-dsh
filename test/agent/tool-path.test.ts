import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { comparablePath, toolFilePath } from "../../src/agent/tools/tool-path.ts";

describe("toolFilePath: the file pi's write/edit actually touched", () => {
	const root = "D:/kingdee/proj";

	it("reads a Git Bash drive path the way pi does on Windows", () => {
		// Raw resolve gives D:\d\kingdee\… -- a file that does not exist.
		expect(toolFilePath("/d/kingdee/proj/src/A.java", root, "win32")).toBe(resolve("D:\\kingdee\\proj\\src\\A.java"));
		expect(toolFilePath("/mnt/d/kingdee/proj/A.java", root, "win32")).toBe(resolve("D:\\kingdee\\proj\\A.java"));
		expect(toolFilePath("/cygdrive/d/kingdee/proj/A.java", root, "win32")).toBe(resolve("D:\\kingdee\\proj\\A.java"));
	});

	it("gives all three spellings of one file the same answer", () => {
		const spellings = ["/d/kingdee/proj/src/A.java", "D:\\kingdee\\proj\\src\\A.java", "src/A.java", "@src/A.java"];
		const answers = new Set(spellings.map((raw) => toolFilePath(raw, root, "win32")));
		expect(answers.size).toBe(1);
	});

	it("leaves a POSIX path alone off Windows", () => {
		expect(toolFilePath("/d/src/A.java", "/home/p", "linux")).toBe(resolve("/d/src/A.java"));
	});
});

describe("comparablePath", () => {
	it("folds case, separators and dot segments", () => {
		expect(comparablePath("./.COSMIC-AI\\Cases//./x.JSON")).toBe(".cosmic-ai/cases/x.json");
		expect(comparablePath("D:\\p\\a\\..\\.cosmic-ai\\cases\\x.json")).toBe("d:/p/.cosmic-ai/cases/x.json");
	});
});
