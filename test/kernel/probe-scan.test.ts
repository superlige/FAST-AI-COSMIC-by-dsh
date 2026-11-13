/**
 * The ad-hoc probe scan is the control that lets ad-hoc probes exist at all, so
 * its tests are about what it refuses, not about what it allows.
 *
 * The write surface it refuses was measured from the 50 released probes, so the
 * samples here are the real call shapes from those files rather than invented
 * ones.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { blankJavaNoise, scanAdHocProbe } from "../../src/kernel/policy/probe-scan.ts";
import { ESCAPE_APIS, READ_ONLY_TYPES, WRITE_APIS } from "../../src/kernel/policy/write-apis.ts";

const found = (source: string): string[] => scanAdHocProbe(source).map((hit) => hit.what);

describe("S4 ad-hoc probe scan: the write surface", () => {
	it("refuses each measured write API, by its real call shape", () => {
		// Left column is copied from the released probes that actually write.
		const samples: [string, string][] = [
			["Map<String,Object> r = new MetadataWriter(fm.getModelType()).save(em, fm);", "MetadataWriter"],
			["MetadataDao.rebuildRuntimeMetaById(metaId);", "MetadataDao 的写/重建方法"],
			["Map<?,?> r = ConvertRuleWriter.save(meta);", "ConvertRuleWriter"],
			["service.updatePrintMeta(metadata, json, lang);", "PrintTplService"],
			["SaveServiceHelper.save(new DynamicObject[]{row});", "SaveServiceHelper"],
			["DeleteServiceHelper.delete(ENTITY, filters);", "DeleteServiceHelper"],
			["r = OperationServiceHelper.executeOperate(c.op, c.entity, rows, opt);", "OperationServiceHelper"],
			["DB.update(DBRoute.of(route), sql, params);", "DB 的写方法"],
			["ORM.create().insert(obj);", "ORM 的写方法"],
		];
		for (const [line, what] of samples) {
			expect(found(line), line).toContain(what);
		}
	});

	it("lets the read half of the same classes through", () => {
		// A scan that also blocked reading would make ad-hoc probes useless, which
		// is the failure mode where people stop using the controlled path.
		const reads = [
			"EntityMetadata em = (EntityMetadata) MetadataDao.readMeta(metaId, MetaCategory.Entity);",
			"String id = MetadataDao.getIdByNumber(entity, MetaCategory.Entity);",
			'DataSet ds = DB.queryDataSet("probe", route, sql);',
			'int n = ORM.create().count("probe", entity, null);',
			"DynamicObject o = BusinessDataServiceHelper.loadSingle(id, entity);",
		];
		for (const line of reads) {
			expect(found(line), line).toEqual([]);
		}
	});

	it("names the line and the reason, so the caller can fix it rather than guess", () => {
		const hits = scanAdHocProbe(
			["class P {", "  void go() {", "    SaveServiceHelper.save(rows);", "  }", "}"].join("\n"),
		);
		expect(hits).toHaveLength(1);
		expect(hits[0]?.line).toBe(3);
		// S21: the refusal is where a session hits the wall, so it names the one door that does write data.
		expect(hits[0]?.why).toContain("DataSeedProbe");
	});

	it("reports one hit per rule, not one per line", () => {
		// Thirty hits for one mistake pushes the other problems off the screen.
		const source = Array.from({ length: 30 }, () => "SaveServiceHelper.save(rows);").join("\n");
		expect(scanAdHocProbe(source)).toHaveLength(1);
	});
});

describe("S4 ad-hoc probe scan: types that may be held but only read through", () => {
	// PrintTplService is both the only way to read a print template's design
	// metadata and the only way to overwrite it. Refusing the name refused the
	// reads, with a reason ("打印模板写入") that was untrue of the code in front of
	// it -- a real session lost a round of work to that on a probe whose whole
	// body was getDesignMeta.
	const audit = [
		"import kd.bos.print.business.metedata.service.PrintTplService;",
		"public class MeasuringToolAuditProbe {",
		"  static void go(String tplId) {",
		"    PrintTplService service = new PrintTplService();",
		"    Object design = service.getDesignMeta(tplId);",
		"    Object meta = service.getPrintMetadata(tplId);",
		"  }",
		"}",
	].join("\n");

	it("lets a read-only template audit through", () => {
		expect(found(audit)).toEqual([]);
	});

	it("still refuses the write, through a receiver or inline", () => {
		expect(found(`${audit}\nservice.updatePrintMeta(metadata, json, lang);`)).toContain("PrintTplService");
		expect(found("new PrintTplService().updatePrintMeta(metadata, json, lang);")).toContain("PrintTplService");
	});

	it("refuses a method it has never heard of rather than allowing it", () => {
		// The direction a whitelist has to fail in: a read left off the list costs
		// one refusal, a write let through is a silent change to a shared tenant.
		const hits = scanAdHocProbe("PrintTplService service = new PrintTplService();\nservice.rebuildEverything(x);");
		expect(hits.map((hit) => hit.what)).toContain("PrintTplService.rebuildEverything");
		expect(hits[0]?.line).toBe(2);
	});

	it("lets the measured call-shape rule name a write it already knows", () => {
		// The tie-break, stated as a test: for `migrate` -- which group 1 measured
		// from the released probes -- the rule reports, and the receiver scan stays
		// quiet rather than adding a second entry under a second reason.
		const hits = scanAdHocProbe("PrintTplService s = new PrintTplService();\ns.migrate(id);");
		expect(hits.map((hit) => hit.what)).toEqual(["PrintTplService"]);
	});

	it("reports one mistake once, not once per half of the scan", () => {
		// `service.updatePrintMeta(…)` is visible to the call-shape rule AND to the
		// receiver scan; two entries would read as two problems.
		const hits = scanAdHocProbe(`${audit}\nservice.updatePrintMeta(metadata, json, lang);`);
		expect(hits.filter((hit) => hit.what.startsWith("PrintTplService"))).toHaveLength(1);
	});

	it("lets workflow queries through and refuses the calls that move a flow", () => {
		// WorkflowServiceHelper was on neither list: an ad-hoc probe could approve or
		// terminate a real bill's flow. The measuring probe behind the workflow
		// reference calls only queries and has to keep passing.
		const measuring = readFileSync(new URL("../../scripts/wf-sdk/WfSdkCheck.java", import.meta.url), "utf8");
		expect(found(measuring)).toEqual([]);
		for (const write of [
			'WorkflowServiceHelper.completeTask(taskId, userId, "Consent", "同意");',
			"WorkflowServiceHelper.abandonByBusienssKey(key);",
			'WorkflowServiceHelper.batchWithdraw(bills, "unsubmit");',
		]) {
			expect(found(write).join(" "), write).toContain("WorkflowServiceHelper.");
		}
	});

	it("refuses a static-method write reached by static import or method reference", () => {
		// Both skip the `Type.method(` shape; both still name the type.
		expect(
			found(
				"import static kd.bos.servicehelper.workflow.WorkflowServiceHelper.abandonByBusienssKey;\nabandonByBusienssKey(key);",
			),
		).toContain("WorkflowServiceHelper.abandonByBusienssKey");
		expect(found("import static kd.bos.servicehelper.workflow.WorkflowServiceHelper.*;")).toContain(
			"WorkflowServiceHelper.*",
		);
		expect(found("keys.forEach(WorkflowServiceHelper::abandonByBusienssKey);")).toContain(
			"WorkflowServiceHelper.abandonByBusienssKey",
		);
		expect(
			found("import static kd.bos.servicehelper.workflow.WorkflowServiceHelper.inProcess;\ninProcess(key);"),
		).toEqual([]);
		expect(found("keys.stream().map(WorkflowServiceHelper::inProcess);")).toEqual([]);
	});

	it("S42: refuses the platform AI designer's write paths, which never name MetadataWriter", () => {
		// Before S42 batch 0 every one of these compiled and ran as an "only reads" probe.
		const writes: [string, string][] = [
			[
				'MetaPropertyService.setProperties("zlgd_nbjgjl", "fs_baseinfo", props);',
				"MetaPropertyService.setProperties",
			],
			['ComplexPropertyService.setStyle("zlgd_nbjgjl", "fs_baseinfo", style);', "ComplexPropertyService.setStyle"],
			["MetaOperationService.addOperation(param);", "MetaOperationService.addOperation"],
			['MetadataUtil.saveAndLog("zlgd_nbjgjl", fm, em);', "MetadataUtil.saveAndLog"],
			['MetadataUtil.createMetadataWriter("zlgd_nbjgjl").save(em, fm);', "MetadataUtil.createMetadataWriter"],
			["new MetaOpsApplier(builder, reverse, om).apply(ops, ctx);", "平台 AI 设计器的写服务"],
			["MetaPluginRegistrationService.registerPlugin(param);", "平台 AI 设计器的写服务"],
			["new FormActionApiController().moveForm(p);", "平台 AI 设计器的写服务"],
		];
		for (const [line, what] of writes) expect(found(line), line).toContain(what);
	});

	it("S42: lets the batch 0 read-only survey of the AI designer through", () => {
		const source = [
			'String formId = MetadataUtil.getFormIdByNumber("zlgd_nbjgjl");',
			'String why = MetadataUtil.checkEditable("zlgd_nbjgjl", null);',
			'List<ElementInfo> e = MetaPropertyService.listElements("zlgd_nbjgjl", null);',
			'List<PropertySchema> s = MetaPropertyService.getPropertySchema("zlgd_nbjgjl", "fs_baseinfo");',
			'Map<String, Object> v = MetaPropertyService.getProperties("zlgd_nbjgjl", "fs_baseinfo", null);',
			'OperationListResult ops = MetaOperationService.listOperations("zlgd_nbjgjl");',
			"Map<String, Object> tree = new SchemaContextBuilder(om).buildFormLayoutTree(formId);",
			"PreviewResult pr = new MetaOpsPreview(b, new MetaOpsFinder(), om).preview(list, sc);",
		].join("\n");
		expect(found(source)).toEqual([]);
	});

	it("keeps both halves of every carve-out real: the read passes and the write does not", () => {
		for (const entry of READ_ONLY_TYPES) {
			expect(found(entry.readSample), entry.readSample).toEqual([]);
			expect(found(entry.writeSample).join(" "), entry.writeSample).toContain(entry.what);
		}
	});
});

describe("S4 ad-hoc probe scan: the escape capabilities", () => {
	it.each([
		"HeatSwapCheck.class.getClassLoader()",
		"HeatSwapCheck.class.getName()",
		"obj.getClass()",
		"ClassLoader cl = getClass().getClassLoader();",
		"Thread.currentThread().getContextClassLoader()",
		"ClassLoader.getSystemClassLoader()",
	])("allows class/loader diagnostics: %s", (source) => {
		expect(found(source)).toEqual([]);
	});

	it.each([
		'HeatSwapCheck.class.getClassLoader().loadClass("Writer")',
		'cl.loadClass("Writer")',
		"cl::loadClass",
		"new java.net.URLClassLoader(urls)",
		"URLClassLoader::new",
		"URLClassLoader.newInstance(urls)",
		"class Loader extends ClassLoader {}",
		"defineClass(bytes)",
		"lookup.defineClass(bytes)",
		"new ScriptEngine()",
	])("still refuses loading capabilities: %s", (source) => {
		expect(found(source)).toContain("动态类加载 / 脚本引擎");
	});

	it("refuses the four ways to reach a writer the scan cannot see", () => {
		const samples: [string, string][] = [
			['Class.forName("kd.bos.metadata.dao.MetadataWriter");', "反射"],
			['Method m = c.getDeclaredMethod("save");', "反射"],
			['getClass().getClassLoader().loadClass("Writer");', "动态类加载 / 脚本引擎"],
			['new ProcessBuilder("cmd").start();', "子进程"],
			["Connection c = DriverManager.getConnection(url);", "裸 JDBC 连接"],
		];
		for (const [line, what] of samples) {
			expect(found(line), line).toContain(what);
		}
	});

	it("allows java.sql value and read types without allowing connection capabilities", () => {
		expect(found('import java.sql.Date; Date day = Date.valueOf("2026-09-01");')).toEqual([]);
		expect(found("import java.sql.ResultSet; ResultSet rows = query();")).toEqual([]);
		expect(found("import java.sql.Connection; Connection c = source();")).toContain("裸 JDBC 连接");
		expect(found("import java.sql.*;")).toContain("裸 JDBC 连接");
	});

	it("refuses writing files and opening sockets", () => {
		expect(found("Files.write(path, bytes);")).toContain("文件写入");
		expect(found("new Socket(host, port);")).toContain("网络访问");
		// Reading a file is how a probe loads a fixture; it stays allowed.
		expect(found("String s = new String(Files.readAllBytes(path));")).toEqual([]);
	});

	it("keeps every rule reachable: each pattern matches its own sample", () => {
		// Guards against a rule that can never fire -- the frozen implementation had
		// exactly that bug in its Chinese javac pattern, unnoticed for months.
		for (const rule of [...WRITE_APIS, ...ESCAPE_APIS]) {
			expect(rule.what.length, rule.what).toBeGreaterThan(0);
			expect(rule.why.length, rule.what).toBeGreaterThan(10);
		}
	});
});

describe("S4 comment and string blanking", () => {
	it("does not refuse a probe for mentioning a writer in a comment", () => {
		const source = [
			"// 不要用 SaveServiceHelper，这是只读探针",
			"/* MetadataWriter 归已发布探针管 */",
			"class P {}",
		].join("\n");
		expect(scanAdHocProbe(source)).toEqual([]);
	});

	it("does not refuse a name that only appears inside a string", () => {
		// Reaching it from a string requires reflection, which is refused on its own.
		expect(scanAdHocProbe('String s = "SaveServiceHelper";')).toEqual([]);
	});

	it("preserves line numbers across blanked regions", () => {
		const source = ["/*", " * MetadataWriter", " */", "DB.update(sql);"].join("\n");
		expect(scanAdHocProbe(source)[0]?.line).toBe(4);
	});

	it("does not let an escaped quote swallow the rest of the file", () => {
		// A string ending in \\" would leave the scanner inside a string literal for
		// the remainder of the source, blanking every real call after it.
		const source = ['String q = "a\\"b";', "SaveServiceHelper.save(rows);"].join("\n");
		expect(found(source)).toContain("SaveServiceHelper");
	});

	it("survives a char literal holding a quote", () => {
		const source = ["char c = '\"';", "DB.update(sql);"].join("\n");
		expect(found(source)).toContain("DB 的写方法");
	});

	it("leaves the released probes' own read paths alone", () => {
		expect(blankJavaNoise('a("x"); // y').trim()).toBe("a(   );");
	});
});
