/**
 * S37 2-B.2：会保存的写入路，字段写错一条就整次不保存。
 *
 * 四条路（造数 DataSeedProbe、改数 DataUpdateProbe、run op 的 OpSandbox、run print --set 的 PrintSim）都经
 * `OpSandbox.applySets` 给字段赋值，赋值之后就是保存。以前只有改数和打印自己先核字段，造数和 run op 交给
 * applySets 边设边打「⚠ 没有字段」，然后照样保存：真机 2026-09-22 造数写错 zlgd_org、zlgd_wtdw，
 * 108 秒后败在校验器上。现在核对只有一处（`OpSandbox.wrongPaths`，对着平台元数据），每条路都在赋值之前调它。
 *
 * 探针要连苍穹的包才编得过，这里不跑 Java，锁的是源码里的先后：凡是调 applySets 的探针，
 * 在调它之前先调了 wrongPaths（或只包一层 wrongPaths 的 setsResolve）——以后再加一条写入路漏了核对，这里会红。
 * 核对本身在真机上验：`scripts/verify-write-fields.ts`。
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { blankJavaNoise } from "../../src/kernel/policy/probe-scan.ts";

const PROBES = fileURLToPath(new URL("../../resources/probes/", import.meta.url));
const code = (file: string): string => blankJavaNoise(readFileSync(join(PROBES, file), "utf8"));

/** 调用处（不含定义那一行）。 */
const APPLY_CALL = /(?<!List<String> )\bapplySets\(\s*met\b/;
const CHECK_CALL = /\b(?:wrongPaths|setsResolve)\(\s*met\b/;

describe("S37 2-B.2 写数据前核字段名", () => {
	it("每条经 applySets 赋值的写入路，赋值之前都先核字段", () => {
		const writers = readdirSync(PROBES)
			.filter((file) => file.endsWith(".java"))
			.filter((file) => APPLY_CALL.test(code(file)));
		expect(writers.sort()).toEqual([
			"DataSeedProbe.java",
			"DataUpdateProbe.java",
			"OpSandbox.java",
			"PrintSim.java",
			"WfSim.java",
		]);
		const late = writers.filter((file) => {
			const text = code(file);
			const check = text.search(CHECK_CALL);
			return check < 0 || check > text.search(APPLY_CALL);
		});
		expect(late).toEqual([]);
		// 打印那一层只是把 wrongPaths 的结果换成「输入不成立」记录
		expect(code("PrintSim.java")).toMatch(
			/boolean setsResolve\([^)]*\)\s*\{\s*List<String\[\]> wrong = OpSandbox\.wrongPaths\(/,
		);
	});

	it("造数、改数字段写错按入参错退出，改对再跑不算重复失败", () => {
		// IllegalArgumentException 记成 PROBE_INPUT_INVALID：改了输入就重新计数，不会被重复失败闸门拦
		for (const file of ["DataSeedProbe.java", "DataUpdateProbe.java"]) {
			const text = code(file);
			const check = text.search(CHECK_CALL);
			const apply = text.search(APPLY_CALL);
			expect(text.slice(check, apply), file).toMatch(/throw new IllegalArgumentException\(/);
			expect(text.slice(check, apply), file).not.toMatch(/TX\.beginNew|executeOperate|SaveServiceHelper\.save/);
		}
		// run op：写错记成「输入不成立」，这一场景不保存
		const op = code("OpSandbox.java");
		const runOne = op.slice(op.indexOf("private static void runOne("));
		expect(runOne.slice(runOne.search(CHECK_CALL), runOne.search(APPLY_CALL))).toMatch(
			/ProbeAssert\.inputInvalid\([\s\S]*throw new ProbeAssert\.InputInvalid\(/,
		);
	});

	it("下拉写成显示名：保存前的核对拦下，共用值转换也拒绝（S37 3.5）", () => {
		// 四条会保存的路都经 wrongPaths；run form / rule / callback / flow 不走它，但都经 ExpectSpec.convert 转值
		const op = code("OpSandbox.java");
		const check = op.slice(op.indexOf("static List<String[]> wrongPaths("));
		expect(check.slice(0, check.indexOf("return wrong;"))).toMatch(/ExpectSpec\.comboNameProblem\(/);
		const spec = code("ExpectSpec.java");
		const convert = spec.slice(spec.indexOf("public static Object convert(IDataEntityProperty p, String raw)"));
		expect(convert.slice(0, convert.indexOf("return scalar("))).toMatch(
			/comboNameProblem\([^)]*\);\s*if \(combo != null\) \{\s*throw new IllegalArgumentException\(combo\)/,
		);
	});

	it("核对只有一处：改数不再自己另核一份", () => {
		// 原来 DataUpdateProbe.load 自己报「上没有字段「…」」，和 applySets 的说法各是各的、也不给相近的名字
		const raw = (file: string): string => readFileSync(join(PROBES, file), "utf8");
		expect(raw("DataUpdateProbe.java")).not.toContain("上没有字段「");
		expect(raw("PrintSim.java")).not.toContain("上没有这个字段（或分录标识写错）");
		expect(raw("OpSandbox.java")).toContain("上没有字段 ");
	});
});
