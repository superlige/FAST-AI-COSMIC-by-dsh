/**
 * The confirmed defects from the zlgd_ygpt2.0 harness review (2026-09-10).
 *
 * All of them cost a real delivery turns, and most cost them by being
 * confidently wrong rather than by refusing: a correct call refused as
 * mis-shaped, a plugin reported on the wrong form, and a parameter block that
 * every probe carried and no probe could show. They are kept together because
 * that is how they were found -- one session, one report -- and because a
 * regression in any of them looks like working software.
 *
 * 二.2（boundForms 报实体而非布局，以及 run form 的假 PASS 预警）住在
 * impact.test.ts 和 run.test.ts，和它们各自测的东西在一起。
 */

import { describe, expect, it } from "vitest";
import type { ReflectionPort } from "../../src/kernel/api-tool.ts";
import { probeUsage, probeUsageText } from "../../src/kernel/commands/probe.ts";
import { blankJavaNoise, LITERAL_FILL } from "../../src/kernel/policy/probe-scan.ts";
import { admitSharedWrite } from "../../src/kernel/policy/shared-write.ts";
import type { KnowledgeBase } from "../../src/knowledge/docs.ts";
import { prepareProbeApis } from "../../src/knowledge/probe-api-preflight.ts";
import { EMBEDDED_RESOURCES } from "../../src/resources/embedded.generated.ts";

const EMPTY_BASE: KnowledgeBase = {
	root: "D:/knowledge",
	docs: () => [],
	pathOf: (relativePath) => `D:/knowledge/${relativePath}`,
	read: () => null,
	exists: () => false,
};

/** Only `batch` is reached on this path; the other two are never called. */
function reflecting(batch: (queries: string) => string): ReflectionPort {
	return { batch: async (queries) => batch(queries), sig: async () => null, find: async () => null };
}

function probeSource(body: string): string {
	return ["import kd.bos.dataentity.entity.DynamicObject;", "", "public class Check {", body, "}"].join("\n");
}

const CLASS_FOUND = ["@@ c0", "kd.bos.dataentity.entity.DynamicObject (kd-bos.jar)"];

describe("复盘二.1 临时探针 API 预检对字面量实参的误判", () => {
	it('把 getString("billno") 算成 1 个参数，不是 0 个', async () => {
		const source = probeSource('  public static void run() { DynamicObject row = null; row.getString("billno"); }');
		let asked = "";
		const preflight = await prepareProbeApis(
			EMPTY_BASE,
			"Check.java",
			source,
			"runtime-1",
			reflecting((queries) => {
				asked = queries;
				return [...CLASS_FOUND, "@@ u0", "DynamicObject.getString(String) -> String"].join("\n");
			}),
		);
		// 预检问反射的参数个数就写在查询行末尾，误判从这里开始。
		expect(asked).toContain("\tmethod\tkd.bos.dataentity.entity.DynamicObject\tgetString\t1");
		expect(preflight.blockers).toEqual([]);
	});

	it("空白抹除会让全字面量实参看起来是空括号，填充字符不会", async () => {
		const call = 'row.getString("billno")';
		expect(blankJavaNoise(call)).toContain("getString(        )");
		expect(blankJavaNoise(call, LITERAL_FILL)).toContain(`getString(${LITERAL_FILL.repeat(8)})`);
	});

	it("真的少给参数时照样拦", async () => {
		const source = probeSource("  public static void run() { DynamicObject row = null; row.getString(); }");
		const preflight = await prepareProbeApis(
			EMPTY_BASE,
			"Check.java",
			source,
			"runtime-1",
			reflecting(() => [...CLASS_FOUND, "@@ u0", "DynamicObject.getString(String) -> String"].join("\n")),
		);
		expect(preflight.blockers.map((blocker) => blocker.code)).toEqual(["PROBE_API_ARGUMENT_MISMATCH"]);
	});

	it("反射把可变参数擦成数组，多给几个实参不算参数个数错", async () => {
		const source = probeSource('  public static void run() { DynamicObject row = null; row.set("a", "b", "c"); }');
		const preflight = await prepareProbeApis(
			EMPTY_BASE,
			"Check.java",
			source,
			"runtime-1",
			reflecting(() => [...CLASS_FOUND, "@@ u0", "DynamicObject.set(Object[]) -> void"].join("\n")),
		);
		expect(preflight.blockers).toEqual([]);
	});
});

// 复盘-harness-FormRuleProbe只读拦截与临时探针预检误报 §8.4-1（2026-09-11 第二轮）：
// 数组字面量里的逗号被当成实参分隔，4 参调用数成 5 参（另一处 7 参）并被拒，
// 而 JAR 里就有那个 4 参重载。模型只好把数组提成局部变量绕开。
describe("复盘 §8.4-1 临时探针 API 预检把花括号、泛型里的逗号数成实参", () => {
	const DB_SOURCE = [
		"import kd.bos.db.DB;",
		"import kd.bos.dataentity.entity.DynamicObject;",
		"public class BaseDataLookup { public static void run() {",
		'  DB.query(route, "select fid from t where fnumber = ? and fstatus = ?", new Object[]{number, "C"}, handler);',
		"  DB.query(route, sql, new Object[]{a, b, c, d}, handler);",
		'  DynamicObject row = null; row.set("k", new java.util.HashMap<String, Object>());',
		"  row.set(a < b, c > d);",
		"  row.set(list.stream().map(x -> { return f(x, 1); }).count(), Collections.<String, Object>emptyMap());",
		"} }",
	].join("\n");

	it("数组字面量、泛型实参、带花括号的 lambda 各算一个实参", async () => {
		let asked = "";
		const preflight = await prepareProbeApis(
			EMPTY_BASE,
			"D:/project/.cosmic-ai/probes/BaseDataLookup.java",
			DB_SOURCE,
			"runtime-1",
			reflecting((queries) => {
				asked = queries;
				return [
					"@@ c0",
					"kd.bos.db.DB (bos-db.jar)",
					"@@ c1",
					"kd.bos.dataentity.entity.DynamicObject (bos-dataentity.jar)",
					"@@ u0",
					"static DB.query(DBRoute, String, Object[], ResultSetHandler) -> Object   <- 参数个数对得上",
					"@@ u1",
					"DynamicObject.set(String, Object) -> void   <- 参数个数对得上",
				].join("\n");
			}),
		);
		const arities = asked
			.split("\n")
			.filter((line) => line.includes("\tmethod\t"))
			.map((line) => line.split("\t").slice(3).join(" "));
		// 两次 DB.query 都是 4 参，并成一条查询；三次 row.set 都是 2 参（比较运算里的 < > 不当泛型）。
		expect(arities).toEqual(["query 4", "set 2"]);
		expect(preflight.blockers).toEqual([]);
	});

	it("真的多给了实参照样拦", async () => {
		const preflight = await prepareProbeApis(
			EMPTY_BASE,
			"D:/project/.cosmic-ai/probes/BaseDataLookup.java",
			[
				"import kd.bos.db.DB;",
				"public class P { public static void run() {",
				"  DB.query(route, sql, new Object[]{a}, handler, extra);",
				"} }",
			].join("\n"),
			"runtime-1",
			reflecting(() =>
				[
					"@@ c0",
					"kd.bos.db.DB (bos-db.jar)",
					"@@ u0",
					"static DB.query(DBRoute, String, Object[], ResultSetHandler) -> Object",
				].join("\n"),
			),
		);
		expect(preflight.blockers.map((blocker) => blocker.code)).toEqual(["PROBE_API_ARGUMENT_MISMATCH"]);
		expect(preflight.blockers[0]?.message).toContain("5 个参数");
	});
});

describe("复盘二.3 已发布探针的参数契约不在可见面层", () => {
	it("类 javadoc 排在 import 之后时也能读到参数注释", async () => {
		// 仓库里每个探针都是这个排布，于是 23 个有必填入参的探针全部报「源码里没有参数注释」，
		// 逼着人去发布缓存里翻 .java 学用法。
		const source = [
			"import java.util.Map;",
			"import kd.bos.metadata.dao.MetadataDao;",
			"",
			"/**",
			" * 新增字段。",
			" *",
			" * 必填：",
			" *   ADD_ENTITY=单据标识",
			" *   ADD_KEY=字段标识",
			" * 可选：",
			" *   ADD_ITEMS=1:合格,2:不合格  combo 用",
			" */",
			"public class AddFieldProbe {",
			'  public static void run() { req("ADD_ENTITY"); req("ADD_KEY"); }',
			"}",
		].join("\n");
		const usage = probeUsage(source);
		expect(usage.required).toEqual(["ADD_ENTITY", "ADD_KEY"]);
		expect(usage.doc).toEqual(["ADD_ENTITY=单据标识", "ADD_KEY=字段标识", "ADD_ITEMS=1:合格,2:不合格  combo 用"]);
		expect(probeUsageText("AddFieldProbe", usage)).toContain("ADD_ITEMS=1:合格,2:不合格");
	});

	it("改单据的写探针，改动清单的各种写法在面层拿得到", async () => {
		// 一份清单里加字段、改属性、加操作，写法只有一个发现入口：探针自己的参数注释。
		// 注释抽不出来，这些写法就等于不存在。
		const source = EMBEDDED_RESOURCES.find((one) => one.relativePath === "probes/FormLayoutWriteProbe.java");
		expect(source).toBeDefined();
		const usage = probeUsage(source?.content ?? "");
		expect(usage.required).toEqual(["LAYOUT_FORM"]);
		const text = probeUsageText("FormLayoutWriteProbe", usage);
		for (const verb of [
			"add field",
			"copy field",
			"remove field",
			"add op",
			"add plugin",
			"add split",
			"remove split",
		])
			expect(text).toContain(verb);
		expect(text).toContain("set <字段>.Suffix=<后缀>");
	});

	it("改单据的写探针，字段落在哪张拆分表按主表名加后缀算", async () => {
		// 从模板继承来的单据头、分录，设计态对象上表名是空的：问平台的 Field.getTableName 拼不出主表名，
		// 预演把建在拆分表上的新字段报成落在主表（真机 zlgd_nbjgjl：Suffix=A 报成 tk_zlgd_nbjgjl 加列）。
		const source =
			EMBEDDED_RESOURCES.find((one) => one.relativePath === "probes/FormLayoutWriteProbe.java")?.content ?? "";
		expect(source).toContain("String at = landsIn(owner, f.getSuffix());");
		expect(source).not.toContain("f.getTableName((Entity<?, ?>) owner)");
		// 所属拆分表只能填配了的后缀；拆分表清单不能当普通属性整份 set
		expect(source).toContain("上没有后缀是 ");
		expect(source).toContain('"splittables".equalsIgnoreCase(name)');
	});

	it("类体内的字符串不会被当成参数注释", async () => {
		const source = [
			"/**",
			" *   REAL_ONE=真的",
			" */",
			"public class P {",
			'  static String s = "* FAKE=假的";',
			"}",
		].join("\n");
		expect(probeUsage(source).doc).toEqual(["REAL_ONE=真的"]);
	});
});

describe("复盘二.4 授权的消费单位", () => {
	it("放行说明写清这次写入是确认清单里的一项", async () => {
		// 「放行 3 个目标」被读成「够写 3 次」。S18 起写几次由确认清单决定（每项一次），
		// 内核这句只说放行哪些对象、这次是清单里的一项。
		const admitted = admitSharedWrite({} as never, {
			authorization: { targets: ["a_f1", "a_f2", "a_f3"], rollback: "D:/bak.json", confirmationId: "call_1" },
			operation: "FormLayoutWriteProbe APPLY",
		});
		expect(admitted.ok).toBe(true);
		if (!admitted.ok) return;
		expect(admitted.value.notes[0]).toContain("确认清单里的一项");
	});
});
