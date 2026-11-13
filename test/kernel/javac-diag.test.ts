/**
 * The diagnostic parser is tested against REAL javac output.
 *
 * test/fixtures/javac-jdk8-zh.txt was produced by running the project's own
 * argfile through JDK 1.8.0_191 on a Chinese Windows (only the file path was
 * replaced). Hand-written diagnostic text would have hidden the two defects this
 * file now pins: the Chinese "程序包X不存在" carries no spaces, and the location
 * line for a method call on a variable reads "类型为T的变量 v".
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	applySuggestions,
	buildQueries,
	findingLine,
	parseDiags,
	parseSuggest,
	sourceInfo,
} from "../../src/kernel/diag/javac.ts";

const FIXTURE = readFileSync(fileURLToPath(new URL("../fixtures/javac-jdk8-zh.txt", import.meta.url)), "utf8");

const SOURCE = `
import kd.bos.dataentity.entity.DynamicObject;
import kd.bos.orm.query.QFilter;
import kd.bos.servicehelper.BusinessDataServiceHelper;
import kd.bos.nosuchpackage.Whatever;
public class HallucinatedApi {}
`;

const read = (): string => SOURCE;

describe("S3.1 javac diagnostics on real JDK 8 output", () => {
	it("parses every error and keeps its detail block", () => {
		const diags = parseDiags(FIXTURE, "D:/proj");
		expect(diags).toHaveLength(4);
		expect(diags.map((d) => d.line)).toEqual([4, 8, 9, 10]);
		expect(diags[1]?.detail.join("\n")).toContain("位置: 类 BusinessDataServiceHelper");
	});

	it("resolves the owner of a method called on a typed variable", () => {
		// The frozen pattern could not read "位置: 类型为DynamicObject的变量 obj", so the
		// owner stayed "-" and the reflection lookup degenerated into a global fuzzy
		// class search -- on this exact input it answered `okio.internal.-Path`.
		const { queries, findings } = buildQueries(parseDiags(FIXTURE, "D:/proj"), read);
		const getString = findings.find((f) => f.what.includes("getStringNope"));
		expect(getString?.what).toBe("方法 DynamicObject.getStringNope(String) 不存在");
		expect(queries).toContainEqual([
			getString?.qid,
			"method",
			"kd.bos.dataentity.entity.DynamicObject",
			"getStringNope",
			"1",
		]);
	});

	it("builds a lookup for a missing package, which the space-requiring pattern never did", () => {
		const { queries, findings } = buildQueries(parseDiags(FIXTURE, "D:/proj"), read);
		const missing = findings.find((f) => f.line === 4);
		expect(missing?.what).toBe("程序包 kd.bos.nosuchpackage 不存在");
		// The realistic case is a right class name under a wrong package, so the
		// imported simple name is what gets looked up.
		expect(queries.some((q) => q[3] === "Whatever")).toBe(true);
	});

	it("keeps the static-method owner from the plain location form", () => {
		const { findings } = buildQueries(parseDiags(FIXTURE, "D:/proj"), read);
		const loadSingle = findings.find((f) => f.line === 8);
		expect(loadSingle?.what).toBe("方法 BusinessDataServiceHelper.loadSingleeee(String,String) 不存在");
	});

	it("pairs each candidate constructor with the reason it does not apply, arity mismatches last", () => {
		const { findings } = buildQueries(parseDiags(FIXTURE, "D:/proj"), read);
		const ctor = findings.find((f) => f.line === 9);
		expect(ctor?.what).toBe("对于QFilter(String,int), 找不到合适的构造器");
		// "wrong type, right count" is the useful one and must come first.
		expect(ctor?.hint).toBe("构造器 QFilter.QFilter(String,Object[]) (参数不匹配; int无法转换为Object[])");
		expect(ctor?.extra.every((line) => line.includes("长度不同"))).toBe(true);
	});
});

describe("fast 的前置体检拒绝里带上 javac 给的候选签名", () => {
	// 同一台机器 JDK 1.8.0_191 实跑的输出（只换了路径）：真机 2026-10-09 那次的写法，
	// List<List<String>> 传给要 List<List<Object>> 的重载。
	const GENERIC = readFileSync(
		fileURLToPath(new URL("../fixtures/javac-jdk8-zh-generic.txt", import.meta.url)),
		"utf8",
	);

	it("keeps the line under the message that names the real parameter types", () => {
		const { findings } = buildQueries(parseDiags(GENERIC, "D:/proj"), read);
		expect(findings).toHaveLength(1);
		const line = findingLine(findings[0] as (typeof findings)[number], "D:/proj");
		expect(line).toContain("找不到合适的方法");
		// 这一句以前被丢掉，模型为了知道它，又去跑了一次 javap。
		expect(line).toContain("SendMesInfoBuilder.buildJSON(String,List<List<Object>>)");
		expect(line).toContain("SendMesInfoBuilder.buildJSON(String,Map<String,Object>)");
		expect(line.split("\\").join("/")).toMatch(/^zlgd-hhx\/src\/main\/java\/demo\/mes\/Caller\.java:9 /);
	});

	it("adds nothing when a finding has no hint", () => {
		const finding = { file: "D:/proj/A.java", line: 3, lines: [3], what: "需要 ';'", hint: "", extra: [], qid: "" };
		expect(findingLine(finding, "D:/proj")).toBe("A.java:3 需要 ';'");
	});
});

describe("S3.1 diagnostic merging and suggestions", () => {
	it("merges one mistake reported on several lines into one finding", () => {
		// A misspelled class name is reported on the import line and on every use;
		// unmerged, one mistake pushes every other problem off the screen.
		const text = [
			"D:/proj/A.java:3: 错误: 找不到符号",
			"  符号:   类 QFiltr",
			"  位置: 类 A",
			"D:/proj/A.java:9: 错误: 找不到符号",
			"  符号:   类 QFiltr",
			"  位置: 类 A",
		].join("\n");
		const { findings, queries } = buildQueries(parseDiags(text, "D:/proj"), read);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.lines).toEqual([3, 9]);
		expect(queries).toHaveLength(1);
	});

	it("counts a generic argument type as one argument when asking reflection for overloads", () => {
		// javac prints `Map<String,Object>` unerased; splitting on every comma asked for 3 arguments.
		const text = [
			"D:/proj/A.java:5: 错误: 找不到符号",
			"  符号:   方法 sett(String,Map<String,Object>)",
			"  位置: 类 A",
		].join("\n");
		const { queries } = buildQueries(parseDiags(text, "D:/proj"), read);
		expect(JSON.stringify(queries)).toContain('"sett","2"');
	});

	it("skips a field lookup when the location is a package, since the class never resolved", () => {
		const text = ["D:/proj/A.java:3: 错误: 找不到符号", "  符号:   变量 FOO", "  位置: 程序包 kd.bos"].join("\n");
		const { queries } = buildQueries(parseDiags(text, "D:/proj"), read);
		expect(queries).toHaveLength(0);
	});

	it("parses suggest sections and marks a missing owner class", () => {
		const suggestions = parseSuggest(
			["@@ q1", "!类 X 本身就查不到", "候选 Y", "@@ q2", "static A.b() -> C"].join("\n"),
		);
		expect(suggestions.get("q1")).toEqual(["!类 X 本身就查不到", "候选 Y"]);
		const [withOwnerLost, withBest] = applySuggestions(
			[
				{ file: "A", line: 1, lines: [1], what: "w", hint: "", extra: [], qid: "q1" },
				{ file: "A", line: 2, lines: [2], what: "w", hint: "", extra: [], qid: "q2" },
			],
			suggestions,
		);
		expect(withOwnerLost?.hint).toBe("类 X 本身就查不到");
		expect(withBest?.hint).toBe("最接近：static A.b() -> C");
	});

	it("reads package and imports for fully-qualifying a simple name", () => {
		const info = sourceInfo("package com.demo;\nimport a.b.C;\nimport d.e.*;\n");
		expect(info.pkg).toBe("com.demo");
		expect(info.imports.get("C")).toBe("a.b.C");
		// Wildcard imports carry no name to bind, so they are skipped rather than guessed.
		expect(info.imports.size).toBe(1);
	});

	it("understands the English locale too", () => {
		const text = [
			"/p/A.java:3: error: cannot find symbol",
			"  symbol:   method loadSingleeee(String,String)",
			"  location: class BusinessDataServiceHelper",
		].join("\n");
		const { findings } = buildQueries(parseDiags(text, "/p"), read);
		expect(findings[0]?.what).toContain("loadSingleeee");
	});
});
