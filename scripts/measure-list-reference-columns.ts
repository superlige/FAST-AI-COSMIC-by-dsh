/** 列表基础资料列及错误出口的固定真机样本。只预演，不保存。
 * node --experimental-strip-types scripts/measure-list-reference-columns.ts <工程目录> [--baseline-writer <java>] [--original] [--show]
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createKernelAdapter } from "../src/agent/tools/kernel-adapter.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";

const project = process.argv[2];
if (!project) throw new Error("请给工程目录");
const baselineAt = process.argv.indexOf("--baseline-writer");
const baseline = baselineAt < 0 ? null : readFileSync(process.argv[baselineAt + 1]!, "utf8");
const config = join(homedir(), ".fast-ai-cosmic");
const resources =
	baseline === null
		? EMBEDDED_RESOURCES
		: EMBEDDED_RESOURCES.map((r) =>
				r.relativePath === "probes/FormLayoutWriteProbe.java" ? { ...r, content: baseline } : r,
			);
const kernel = createKernelAdapter({
	agentConfigDir: config,
	cacheRoot: join(config, "cache"),
	agentVersion: "0.1.0",
	resources,
});
const opened = await kernel.open(project);
if (!opened.ok) throw new Error(JSON.stringify(opened.error));
const original = process.argv.includes("--original");
const cases: { what: string; lines: string[]; expected: RegExp; rejected?: boolean }[] = original
	? [
			{
				what: "原失败的会议室、预约人、部门三列",
				lines: ["show pps6_room into gridview", "show pps6_booker into gridview", "show pps6_dept into gridview"],
				expected:
					/pps6_room.*ListFieldId.*pps6_room.name[\s\S]*pps6_booker.*ListFieldId.*pps6_booker.name[\s\S]*pps6_dept.*ListFieldId.*pps6_dept.name/,
			},
		]
	: [
			{
				what: "基础资料字段默认显示名称",
				lines: ["show creator into gridview"],
				expected: /creator.*ListFieldId.*creator.name/,
			},
			{
				what: "明确选择名称路径",
				lines: ["show creator.name into gridview"],
				expected: /creator_name.*ListFieldId.*creator.name/,
			},
			{
				what: "明确选择编码路径",
				lines: ["show creator.number into gridview"],
				expected: /creator_number.*ListFieldId.*creator.number/,
			},
			{
				what: "名称与编码同时添加并自定控件名",
				lines: [
					"show creator.name as zlgd_creator_name into gridview",
					"show creator.number as zlgd_creator_number after zlgd_creator_name",
				],
				expected: /zlgd_creator_number.*ListFieldId.*creator.number/,
			},
			{
				what: "新引用列可设列宽",
				lines: ["show creator.name into gridview", "set creator_name.Width=180"],
				expected: /creator_name.*Width.*180/,
			},
			{
				what: "新引用列撤下不删字段",
				lines: ["show creator.name into gridview", "remove creator_name"],
				expected: /改完和现在一模一样/,
			},
			{
				what: "同一绑定不能重复添加",
				lines: ["show creator into gridview", "show creator.name into gridview"],
				expected: /已经.*列.*creator/,
				rejected: true,
			},
			{
				what: "错误引用路径给可选路径",
				lines: ["show creator.no_such_field into gridview"],
				expected: /creator.name.*creator.number|creator.number.*creator.name/,
				rejected: true,
			},
			{
				what: "字段名不能当列控件定位",
				lines: ["show createtime after billno"],
				expected: /billno.*colbillno/,
				rejected: true,
			},
			{
				what: "根定位错后的依赖行合并",
				lines: [
					"show createtime after billno",
					"show modifytime after createtime",
					"show creator.name after modifytime",
				],
				expected: /第 3、4 行跟着没改/,
				rejected: true,
			},
			{
				what: "输入错误按可修正输入退出",
				lines: ["show createtime after missing_column"],
				expected: /\[PROBE-ERR\] java.lang.IllegalArgumentException/,
				rejected: true,
			},
			{
				what: "非法控件类型仍按输入错退出",
				lines: ["add NoSuchAp zlgd_bad into gridview visible=none lock=none"],
				expected: /\[PROBE-ERR\] java.lang.IllegalArgumentException/,
				rejected: true,
			},
			{
				what: "删自建基础资料字段时撤下它的引用列",
				lines: [
					"layout bill",
					"add field BasedataField zlgd_reference into contentpanel 引用测试 base=bos_user visible=none lock=none",
					"layout list",
					"show zlgd_reference.name into gridview",
					"show zlgd_reference.number into gridview",
					"layout bill",
					"remove field zlgd_reference",
				],
				expected: /差异（改前 → 改后，按元素逐项比出来的）0 处/,
			},
		];
let passed = 0;
for (const [i, c] of cases.entries()) {
	const started = Date.now();
	const r = await kernel.probe(opened.value.handle, "FormLayoutWriteProbe", {
		env: {
			LAYOUT_FORM: original ? "pps6_mr_booking" : "zlgd_sys_bgjl",
			LAYOUT_EDIT: ["layout list", ...c.lines].join("\n"),
		},
	});
	const output = r.ok ? r.value.output : JSON.stringify(r.error);
	const refused = /一处都没写/.test(output);
	const pass = c.expected.test(output) && (c.rejected ? refused : r.ok && r.value.exitCode === 0 && !refused);
	if (pass) passed++;
	console.log(`${pass ? "PASS" : "FAIL"} ${i + 1} ${c.what} ${((Date.now() - started) / 1000).toFixed(1)} 秒`);
	if (process.argv.includes("--show") || !pass) console.log(output);
}
console.log(`通过 ${passed}/${cases.length}`);
process.exitCode = passed === cases.length ? 0 : 1;
