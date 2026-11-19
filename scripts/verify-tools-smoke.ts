/**
 * 真机冒烟：开发模式的每个产品工具都只读调一遍，不经过 dsh 和模型、不花额度。
 * 走 `direct-tools.ts`：和插件同一份工具规格、同一道执行前门槛。常驻 JVM 是组合包自己的，
 * 不和正在跑的 pi 版会话抢进程；跑完停掉。
 *
 * 会写的只有一处：在工程的 .cosmic-ai/probes/ 下临时放 SmokeOneOff.java（跑完删掉）。
 * 不编译业务代码（不调 cosmic_fast，它要工程写锁）、不写元数据、不提交单据（cosmic_run 只用 --show，不点保存）。
 *
 * 用法：
 *   node --experimental-strip-types scripts/verify-tools-smoke.ts <工程目录>
 * 默认的单据、布局、Java 文件来自真机工程 zlgd_ygpt2.0，换工程用环境变量覆盖：
 *   SMOKE_BILL（单据实体）、SMOKE_LAYOUT（布局）、SMOKE_FIELD（单据上的字段）、SMOKE_JAVA（工程里一个 Java 文件）
 */
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { directTools } from "./direct-tools.ts";

if (!process.argv[2]) {
	console.error("用法: verify-tools-smoke.ts <工程目录>");
	process.exit(2);
}
const project = resolve(process.argv[2]);
const BILL = process.env.SMOKE_BILL ?? "zlgd_sys_test_bill";
const LAYOUT = process.env.SMOKE_LAYOUT ?? "zlgd_sys_test_plsy";
const FIELD = process.env.SMOKE_FIELD ?? "billno";
const JAVA =
	process.env.SMOKE_JAVA ?? "zlgd-hhx/src/main/java/zlgd/bpm/ywsp/plugin/alusalesmpr/list/AluSalesMprListPlugin.java";
const rows: { tool: string; what: string; ok: boolean; secs: string; head: string }[] = [];
const oneOff = join(project, ".cosmic-ai", "probes", "SmokeOneOff.java");

const tools = await directTools(project);
console.log(`挂着的产品工具 ${tools.mounted.length} 个：${tools.mounted.join(" ")}`);
console.log(`技能文档目录：${tools.host.referenceDocsDir ?? "没取到"}`);

async function call(
	name: string,
	what: string,
	params: Record<string, unknown>,
	expect: (text: string, ok: boolean) => boolean,
): Promise<string> {
	const t0 = Date.now();
	const got = await tools.call(name, params);
	const ok = !got.text.startsWith("抛异常") && !got.text.startsWith("没有这个工具") && expect(got.text, got.ok);
	const head = got.text.replace(/\s+/g, " ").slice(0, 160);
	rows.push({ tool: name, what, ok, secs: ((Date.now() - t0) / 1000).toFixed(1), head });
	console.log(`${ok ? "OK  " : "FAIL"} ${name} [${what}] ${rows.at(-1)?.secs}s :: ${head}`);
	if (!ok) console.log(`---- 全文 ----\n${got.text.slice(0, 3000)}\n-------------`);
	return got.text;
}
const okJson = (text: string, ok: boolean): boolean => ok && text.includes('"ok":true');
const long = (text: string, ok: boolean): boolean => ok && text.length > 200;

try {
	await call("cosmic_doctor", "check", { action: "check", projectRoot: project }, (t, ok) => ok && t.length > 0);
	await call("cosmic_open_project", "open", { projectRoot: project }, okJson);
	await call("cosmic_doctor", "index", { action: "index" }, okJson);
	await call("cosmic_doctor", "lock 只读", { action: "lock" }, okJson);
	await call("cosmic_knowledge", "status", { action: "status" }, okJson);
	await call("cosmic_knowledge", "probes 布局", { action: "probes", query: "表单布局" }, okJson);
	await call("cosmic_knowledge", "api QFilter", { action: "api", query: "kd.bos.orm.query.QFilter" }, okJson);
	await call("cosmic_knowledge", "findclass", { action: "findclass", query: "BusinessDataServiceHelper" }, okJson);
	await call("cosmic_knowledge", "scenes billform", { action: "scenes", pluginType: "billform" }, okJson);
	await call("cosmic_impact", "单据", { terms: [BILL] }, okJson);
	await call("cosmic_impact", "字段", { terms: [`${BILL}.${FIELD}`] }, okJson);
	await call("cosmic_lint", "一个 Java 文件", { sources: [JAVA] }, okJson);
	await call("cosmic_run", "help", { argv: ["help"] }, long);
	await call("cosmic_run", "help form", { argv: ["help", "form"] }, long);
	await call("cosmic_meta", "用法", { argv: [] }, (t) => t.length > 200);
	await call("cosmic_runtime", "probe-status", { action: "probe-status" }, okJson);
	await call(
		"cosmic_probe",
		"MetaProbe",
		{ name: "MetaProbe", positional: [BILL], env: { META_FILTER: FIELD } },
		okJson,
	);
	await call("cosmic_probe", "FormLayoutProbe", { name: "FormLayoutProbe", positional: [LAYOUT] }, okJson);
	writeFileSync(
		oneOff,
		[
			"import kd.bos.servicehelper.MetadataServiceHelper;",
			"import kd.bos.entity.MainEntityType;",
			"public class SmokeOneOff {",
			"  public static void run() {",
			`    MainEntityType t = MetadataServiceHelper.getDataEntityType("${BILL}");`,
			'    System.out.println("[PROBE] fields=" + t.getAllFields().size());',
			"  }",
			"}",
			"",
		].join("\n"),
	);
	await call(
		"cosmic_probe",
		"临时只读探针",
		{ name: ".cosmic-ai/probes/SmokeOneOff.java" },
		(t, ok) => okJson(t, ok) && t.includes("fields="),
	);
	writeFileSync(
		oneOff,
		[
			"import kd.bos.servicehelper.operation.SaveServiceHelper;",
			"public class SmokeOneOff {",
			"  public static void run() { SaveServiceHelper.save(new kd.bos.dataentity.entity.DynamicObject[0]); }",
			"}",
			"",
		].join("\n"),
	);
	await call(
		"cosmic_probe",
		"临时探针写 API 应被拒",
		{ name: ".cosmic-ai/probes/SmokeOneOff.java" },
		(t, ok) => !ok && /拒|SaveServiceHelper/.test(t),
	);
	await call("cosmic_run", "form --show 不保存", { argv: ["form", BILL, "--show", FIELD] }, okJson);
	await call("cosmic_run", "rule form --show", { argv: ["rule", "form", BILL, "--show", FIELD] }, okJson);
	await call("cosmic_meta", "formula print", { argv: ["formula", "print", "--q", "日期"] }, okJson);
	await call("cosmic_meta", "botp list", { argv: ["botp", "list", "--target", BILL] }, okJson);
	await call("cosmic_facts", "列事实", {}, (t, ok) => ok && t.includes("业务运行（cosmic_run）"));
} finally {
	if (existsSync(oneOff)) unlinkSync(oneOff);
	await call("cosmic_runtime", "probe-stop", { action: "probe-stop" }, okJson);
}
const bad = rows.filter((row) => !row.ok);
console.log(
	`\n合计 ${rows.length} 次调用，${rows.length - bad.length} 过，${bad.length} 没过${bad.length ? `：${bad.map((row) => `${row.tool}[${row.what}]`).join("、")}` : ""}`,
);
process.exit(bad.length ? 1 : 0);
