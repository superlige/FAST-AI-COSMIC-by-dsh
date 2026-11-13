import { describe, expect, it } from "vitest";
import type { ReflectionPort } from "../../src/kernel/api-tool.ts";
import type { KnowledgeBase } from "../../src/knowledge/docs.ts";
import { prepareProbeApis } from "../../src/knowledge/probe-api-preflight.ts";

const BASE: KnowledgeBase = {
	root: "C:/knowledge",
	docs: () => [],
	pathOf: (relativePath) => `C:/knowledge/${relativePath}`,
	read: () => null,
	exists: () => false,
};

function reflection(output: string | null, calls: string[]): ReflectionPort {
	return {
		sig: async () => null,
		find: async () => null,
		async batch(query) {
			calls.push(query);
			return output;
		},
	};
}

describe("S15.3 automatic probe API preflight", () => {
	it("joins every class and obvious call in one reflection batch", async () => {
		const calls: string[] = [];
		const source = [
			"import kd.bos.orm.query.QFilter;",
			"public class OneOff { public static void run() {",
			'  QFilter left = new QFilter("id", "=", 1L);',
			'  QFilter right = new QFilter("id", "=", 2L);',
			"  left.and(right);",
			"} }",
		].join("\n");
		const result = await prepareProbeApis(
			BASE,
			"D:/project/.cosmic-ai/probes/OneOff.java",
			source,
			"runtime-1",
			reflection(
				[
					"@@ c0",
					"  kd.bos.orm.query.QFilter   <- bos-orm.jar",
					"@@ u0",
					"  QFilter(String, String, Object)   <- 参数个数对得上",
					"@@ u1",
					"  QFilter.and(QFilter) -> QFilter   <- 参数个数对得上",
				].join("\n"),
				calls,
			),
		);

		expect(calls).toHaveLength(1);
		expect(calls[0]).toContain("\tclass\tkd.bos.orm.query.QFilter\tQFilter\t-1");
		expect(calls[0]).toContain("\tmethod\tkd.bos.orm.query.QFilter\tand\t1");
		expect(result.blockers).toEqual([]);
		expect(result.reflection).toBe("verified");
		expect(result.capsules[0]?.signatures).toContain("QFilter.and(QFilter) -> QFilter   <- 参数个数对得上");
	});

	it("returns missing class, method and argument blockers before execution", async () => {
		const source = [
			"import kd.bos.orm.query.QFilter;",
			"import kd.bos.made.Up;",
			"public class OneOff { public static void run() {",
			"  QFilter filter = null; filter.madeUp(); filter.and(null, null);",
			"} }",
		].join("\n");
		const result = await prepareProbeApis(
			BASE,
			"D:/project/.cosmic-ai/probes/OneOff.java",
			source,
			"runtime-1",
			reflection(
				[
					"@@ c0",
					"@@ c1",
					"  kd.bos.orm.query.QFilter   <- bos-orm.jar",
					"@@ u0",
					"  QFilter.makeUp() -> QFilter",
					"@@ u1",
					"  QFilter.and(QFilter) -> QFilter",
				].join("\n"),
				[],
			),
		);

		expect(result.blockers.map((blocker) => blocker.code)).toEqual([
			"PROBE_API_CLASS_MISSING",
			"PROBE_API_METHOD_MISSING",
			"PROBE_API_ARGUMENT_MISMATCH",
		]);
		expect(result.blockers[1]?.remedy).toContain("makeUp");
		expect(result.blockers[2]?.remedy).toContain("QFilter.and(QFilter)");
	});

	// The refusal from a real session: `LocaleString` has more than five same-name
	// classes in the bouncycastle jars, they sort ahead of `kd.bos...`, and the
	// ranked scan kept only those five. javac compiled the import fine. This is the
	// answer an ApiTool that still ranks by simple name gives; the member query on
	// the same class loaded it, and that is enough to know it is there.
	it("does not call a class missing when a member query on it loaded, however crowded the name is", async () => {
		const result = await prepareProbeApis(
			BASE,
			"D:/project/.cosmic-ai/probes/LayoutRulesDump.java",
			[
				"import kd.bos.dataentity.entity.LocaleString;",
				"public class LayoutRulesDump { public static void run() {",
				"  LocaleString name = null; name.toString();",
				"} }",
			].join("\n"),
			"runtime-1",
			reflection(
				[
					"@@ u0",
					"  LocaleString.toString() -> String   <- 参数个数对得上",
					"@@ c0",
					"  cfca.org.bouncycastle.i18n.LocaleString   <- openbank-api-sdk-4.0.4.jar",
					"  cfca.sadk.org.bouncycastle.i18n.LocaleString   <- SADK-3.7.1.0.jar",
					"  cfca.sadk.org.bouncycastle.i18n.LocaleString   <- SADK3631Patch-3.0.2.0.jar",
					"  cmbc.cfca.org.bouncycastle.i18n.LocaleString   <- openbank-api-sdk-4.0.4.jar",
					"  cn.com.infosec.i18n.LocaleString   <- ISFJ_v2_0_139_16_BAISC_JDK15.jar",
				].join("\n"),
				[],
			),
		);

		expect(result.blockers).toEqual([]);
	});

	it("still calls a class missing when the member query could not load it either", async () => {
		const result = await prepareProbeApis(
			BASE,
			"D:/project/.cosmic-ai/probes/OneOff.java",
			[
				"import kd.bos.made.LocaleStrin;",
				"public class OneOff { public static void run() {",
				"  LocaleStrin name = null; name.toString();",
				"} }",
			].join("\n"),
			"runtime-1",
			reflection(
				[
					"@@ u0",
					"!类 kd.bos.made.LocaleStrin 本身就查不到，最接近的类名：",
					"  kd.bos.dataentity.entity.LocaleString   <- bos-dataentity-8.0.jar",
					"@@ c0",
					"  kd.bos.dataentity.entity.LocaleString   <- bos-dataentity-8.0.jar",
				].join("\n"),
				[],
			),
		);

		expect(result.blockers[0]?.code).toBe("PROBE_API_CLASS_MISSING");
		expect(result.blockers[0]?.remedy).toContain("kd.bos.dataentity.entity.LocaleString");
	});

	it("checks an unqualified call introduced by an exact static import", async () => {
		const calls: string[] = [];
		const result = await prepareProbeApis(
			BASE,
			"D:/project/.cosmic-ai/probes/OneOff.java",
			[
				"import static kd.bos.dataentity.OperateOption.create;",
				"public class OneOff { public static void run() { create(); } }",
			].join("\n"),
			"runtime-1",
			reflection(
				[
					"@@ c0",
					"  kd.bos.dataentity.OperateOption   <- bos-entity.jar",
					"@@ u0",
					"  static OperateOption.create() -> OperateOption   <- 参数个数对得上",
				].join("\n"),
				calls,
			),
		);

		expect(calls[0]).toContain("\tmethod\tkd.bos.dataentity.OperateOption\tcreate\t0");
		expect(result.blockers).toEqual([]);
	});

	it("keeps wildcard imports hard-blocked without asking for a knowledge call", async () => {
		const calls: string[] = [];
		const result = await prepareProbeApis(
			BASE,
			"D:/project/.cosmic-ai/probes/OneOff.java",
			"import kd.bos.orm.query.*; public class OneOff { public static void run() {} }",
			"runtime-1",
			reflection("", calls),
		);

		expect(calls).toEqual([]);
		expect(result.blockers.map((blocker) => blocker.code)).toEqual(["PROBE_API_WILDCARD"]);
		expect(result.blockers[0]?.remedy).not.toContain("cosmic_knowledge");
	});

	// 真机 2026-09-17：私有方法 `DataRowSet entry(...)` 和另一个方法的参数
	// `DynamicObject entry` 同名，旧写法把方法声明当成变量、后出现的覆盖先出现的，
	// 报「DataRowSet 不存在 get / getString」，挡住了一份 javac 能编过的探针。
	it("does not mistake a method declaration for a variable of the same name", async () => {
		const calls: string[] = [];
		const result = await prepareProbeApis(
			BASE,
			"D:/project/.cosmic-ai/probes/JxzywRemarkBlankVerify.java",
			[
				"import kd.bos.dataentity.entity.DynamicObject;",
				"import kd.bos.print.core.data.DataRowSet;",
				"public class JxzywRemarkBlankVerify {",
				'  public static void run() { DataRowSet row = entry("A-1"); row.getField("k"); }',
				"  private static String text(DynamicObject entry, String key) { return entry.getString(key); }",
				'  private static Object item(DynamicObject entry) { return entry.get("zlgd_jyxm"); }',
				"  private static DataRowSet entry(String sampleNo) { return new DataRowSet(); }",
				"}",
			].join("\n"),
			"runtime-1",
			reflection(
				[
					"@@ c0",
					"  kd.bos.dataentity.entity.DynamicObject   <- bos-dataentity.jar",
					"@@ c1",
					"  kd.bos.print.core.data.DataRowSet   <- bos-print.jar",
					"@@ u0",
					"  DataRowSet()   <- 参数个数对得上",
					"@@ u1",
					"  DataRowSet.getField(String) -> Field   <- 参数个数对得上",
					"@@ u2",
					"  DynamicObject.getString(String) -> String   <- 参数个数对得上",
					"@@ u3",
					"  DynamicObject.get(String) -> Object   <- 参数个数对得上",
				].join("\n"),
				calls,
			),
		);

		expect(calls[0]).not.toContain("DataRowSet\tgetString");
		expect(calls[0]).not.toContain("DataRowSet\tget\t");
		// 方法声明不再算变量，`entry` 只剩参数那一种类型，就按它查。
		expect(calls[0]).toContain("\tmethod\tkd.bos.dataentity.entity.DynamicObject\tgetString\t1");
		expect(calls[0]).toContain("\tmethod\tkd.bos.print.core.data.DataRowSet\tgetField\t1");
		expect(result.blockers).toEqual([]);
	});

	it("does not check a call when the same name is declared with two different types", async () => {
		const calls: string[] = [];
		const result = await prepareProbeApis(
			BASE,
			"D:/project/.cosmic-ai/probes/OneOff.java",
			[
				"import kd.bos.dataentity.entity.DynamicObject;",
				"import kd.bos.print.core.data.DataRowSet;",
				"public class OneOff {",
				'  static String a(DynamicObject entry) { return entry.getString("k"); }',
				'  static Object b(DataRowSet entry) { return entry.getField("k"); }',
				'  static Object c(java.util.List<DynamicObject> rows, DynamicObject rows2) { return rows2.get("k"); }',
				"}",
			].join("\n"),
			"runtime-1",
			reflection(
				[
					"@@ c0",
					"  kd.bos.dataentity.entity.DynamicObject   <- bos-dataentity.jar",
					"@@ c1",
					"  kd.bos.print.core.data.DataRowSet   <- bos-print.jar",
					"@@ u0",
					"  DynamicObject.get(String) -> Object   <- 参数个数对得上",
				].join("\n"),
				calls,
			),
		);

		expect(calls[0]).not.toContain("\tgetString\t");
		expect(calls[0]).not.toContain("\tgetField\t");
		expect(calls[0]).toContain("\tmethod\tkd.bos.dataentity.entity.DynamicObject\tget\t1");
		expect(result.blockers).toEqual([]);
	});

	it("still checks a variable whose only declaration is unambiguous, even beside a same-typed method", async () => {
		const result = await prepareProbeApis(
			BASE,
			"D:/project/.cosmic-ai/probes/OneOff.java",
			[
				"import kd.bos.print.core.data.DataRowSet;",
				"public class OneOff {",
				'  public static void run() { DataRowSet row = make(); row.getString("k"); }',
				"  private static DataRowSet make() { return null; }",
				"}",
			].join("\n"),
			"runtime-1",
			reflection(
				[
					"@@ c0",
					"  kd.bos.print.core.data.DataRowSet   <- bos-print.jar",
					"@@ u0",
					"  DataRowSet.getField(String) -> Field   <- 参数个数对得上",
				].join("\n"),
				[],
			),
		);

		expect(result.blockers.map((blocker) => blocker.code)).toEqual(["PROBE_API_METHOD_MISSING"]);
		expect(result.blockers[0]?.message).toContain("getString");
	});

	it("degrades loudly when reflection is unavailable and leaves javac as the pre-JVM authority", async () => {
		const result = await prepareProbeApis(
			BASE,
			"D:/project/.cosmic-ai/probes/OneOff.java",
			"import kd.bos.orm.query.QFilter; public class OneOff { public static void run() {} }",
			"runtime-1",
			reflection(null, []),
		);

		expect(result.blockers).toEqual([]);
		expect(result.reflection).toBe("unavailable");
		expect(result.warnings.join("\n")).toContain("javac");
	});
});
