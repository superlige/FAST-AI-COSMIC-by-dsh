import { describe, expect, it } from "vitest";
import { initializeProjectConfig, validateProjectConfigAnswers } from "../../src/kernel/config/initialize.ts";
import { MemoryFs } from "./fake-context.ts";

const ROOT = "D:/project";
const FILE = `${ROOT}/.cosmic-ai/config.json`;

describe("project config initialization", () => {
	it("creates only confirmed values and the local ignore rule", () => {
		const fs = new MemoryFs();
		const result = initializeProjectConfig(
			{
				root: ROOT,
				expectedText: "",
				expectedExists: false,
				declaredModules: ["demo-debug", "demo-biz"],
				answers: { account: "acct", user: "42" },
			},
			fs,
		);
		expect(result).toMatchObject({ ok: true, value: { created: true, changed: true } });
		expect(JSON.parse(fs.read(FILE))).toEqual({ account: "acct", user: "42" });
		expect(fs.read(`${ROOT}/.cosmic-ai/.gitignore`)).toBe("/config.json\n/evidence/\n/work/\n/probes/\n");
	});

	it("preserves unknown and existing non-empty fields while filling blanks", () => {
		const fs = new MemoryFs();
		const original = '{"future":{"enabled":true},"account":"keep","user":""}';
		fs.put(FILE, original);
		fs.put(`${ROOT}/.cosmic-ai/.gitignore`, "# local\n/config.json\n");
		const result = initializeProjectConfig(
			{
				root: ROOT,
				expectedText: original,
				expectedExists: true,
				declaredModules: [],
				answers: { account: "replace", user: "42" },
			},
			fs,
		);
		expect(result).toMatchObject({ ok: true, value: { writtenFields: ["user"] } });
		expect(JSON.parse(fs.read(FILE))).toEqual({ future: { enabled: true }, account: "keep", user: "42" });
		expect(fs.read(`${ROOT}/.cosmic-ai/.gitignore`)).toBe("# local\n/config.json\n/evidence/\n/work/\n/probes/\n");
	});

	it("refuses damaged JSON without writing anything", () => {
		const fs = new MemoryFs();
		fs.put(FILE, "{broken");
		const result = initializeProjectConfig(
			{ root: ROOT, expectedText: "{broken", expectedExists: true, declaredModules: [], answers: { user: "42" } },
			fs,
		);
		expect(result).toMatchObject({ ok: false, error: { code: "CONFIG_PARSE_FAILED" } });
		expect(fs.read(FILE)).toBe("{broken");
		expect(fs.read(`${ROOT}/.cosmic-ai/.gitignore`)).toBe("");
	});

	it("refuses an external change after doctor", () => {
		const fs = new MemoryFs();
		fs.put(FILE, '{"user":"external"}');
		const result = initializeProjectConfig(
			{ root: ROOT, expectedText: "", expectedExists: false, declaredModules: [], answers: { account: "acct" } },
			fs,
		);
		expect(result).toMatchObject({ ok: false, error: { code: "CONFIG_INIT_CONFLICT" } });
		expect(fs.read(FILE)).toBe('{"user":"external"}');
	});

	it("validates identifiers, Java names and declared modules", () => {
		expect(
			validateProjectConfigAnswers(
				{
					isv: "Bad-ISV",
					debugModule: "missing",
					codeModules: ["biz", "missing"],
					appClass: "DebugApplication",
					appMethod: "bad-name",
				},
				["debug", "biz"],
			),
		).toHaveLength(5);
		expect(
			validateProjectConfigAnswers(
				{
					isv: "zlgd",
					debugModule: "debug",
					codeModules: ["biz"],
					appClass: "com.demo.App",
					appMethod: "devRemote",
				},
				["debug", "biz"],
			),
		).toEqual([]);
	});
});
