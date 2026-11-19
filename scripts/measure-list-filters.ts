/** 列表常用过滤、快捷搜索固定样本。只读及预演，不写元数据。
 * node --experimental-strip-types scripts/measure-list-filters.ts <工程目录> [--show]
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createKernelAdapter } from "../src/agent/tools/kernel-adapter.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";

const project = process.argv[2];
if (!project) throw new Error("请给工程目录");
const config = join(homedir(), ".fast-ai-cosmic");
const baselineAt = process.argv.indexOf("--baseline-writer");
const baseline = baselineAt < 0 ? null : readFileSync(process.argv[baselineAt + 1]!, "utf8");
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
const common = "show filter billstatus as zlgd_status_filter into filtergridview";
const fast = "show filter modifytime as zlgd_time_search into fastsearchgridview";
const cases: { what: string; lines: string[]; expected: RegExp; rejected?: boolean }[] = [
	{ what: "常用过滤加枚举字段并带选项", lines: [common], expected: /zlgd_status_filter.*ComboItems/ },
	{ what: "快捷搜索加字段", lines: [fast], expected: /zlgd_time_search.*FieldName/ },
	{
		what: "常用过滤加日期字段",
		lines: ["show filter modifytime as zlgd_date_filter into filtergridview"],
		expected: /zlgd_date_filter.*CommonDateFilterColumnAp/,
	},
	{
		what: "常用过滤加基础资料字段",
		lines: ["show filter creator.id as zlgd_creator_filter into filtergridview"],
		expected: /zlgd_creator_filter.*CommonBaseDataFilterColumnAp/,
	},
	{
		what: "修改多选和缺省值",
		lines: [common, "set zlgd_status_filter.Multi=false", "set zlgd_status_filter.DefValue=C"],
		expected: /zlgd_status_filter.*DefValue/,
	},
	{
		what: "调整筛选项顺序",
		lines: [common, "move zlgd_status_filter before commondatefiltercolumnap"],
		expected: /另有 1 个控件序号顺延/,
	},
	{ what: "添加再撤下，字段保留", lines: [common, "remove zlgd_status_filter"], expected: /改完和现在一模一样/ },
	{
		what: "同字段可用于两种视图",
		lines: [common, "show filter billstatus as zlgd_status_search into fastsearchgridview"],
		expected: /zlgd_status_search.*FieldName/,
	},
	{
		what: "错误字段拒绝",
		lines: ["show filter zlgd_missing as zlgd_missing_filter into filtergridview"],
		expected: /不在平台.*过滤字段/,
		rejected: true,
	},
	{
		what: "重复筛选字段拒绝",
		lines: ["show filter createtime as zlgd_duplicate into filtergridview"],
		expected: /已经.*过滤/,
		rejected: true,
	},
	{
		what: "列表列容器不能装筛选项",
		lines: ["show filter billstatus as zlgd_bad_filter into gridview"],
		expected: /只能.*常用过滤.*快捷搜索/,
		rejected: true,
	},
	{
		what: "筛选控件标识冲突拒绝",
		lines: ["show filter billstatus as filtercolumnap into filtergridview"],
		expected: /前缀|已经有/,
		rejected: true,
	},
	{
		what: "不能移到工具栏",
		lines: [common, "move zlgd_status_filter into _toolbar_"],
		expected: /不让|只收|只能/,
		rejected: true,
	},
	{
		what: "选项缺省值不存在时拒绝",
		lines: [common, "set zlgd_status_filter.DefValue=INVALID"],
		expected: /缺省值.*选项/,
		rejected: true,
	},
	{
		what: "设置日期范围和日期缺省值",
		lines: [
			"show filter modifytime as zlgd_date_filter into filtergridview",
			"set zlgd_date_filter.DateConst=13,63",
			"set zlgd_date_filter.DefValue=13",
		],
		expected: /zlgd_date_filter.*DateConst/,
	},
	{
		what: "枚举多选缺省值",
		lines: [common, "set zlgd_status_filter.DefValue=A,C"],
		expected: /zlgd_status_filter.*DefValue.*A,C/,
	},
	{
		what: "字段绑定不允许手写错名",
		lines: [common, "set zlgd_status_filter.FieldName=missing"],
		expected: /不能改/,
		rejected: true,
	},
	{
		what: "不能把枚举筛选改成日期类型",
		lines: [common, "set zlgd_status_filter.Type=date"],
		expected: /过滤字段类型决定/,
		rejected: true,
	},
	{
		what: "已经使用的控件标识拒绝",
		lines: [
			"show filter billstatus as zlgd_status_filter into filtergridview",
			"show filter modifytime as zlgd_status_filter into fastsearchgridview",
		],
		expected: /已经有/,
		rejected: true,
	},
	{
		what: "不能移进另一个过滤视图",
		lines: [common, "move zlgd_status_filter into fastsearchgridview"],
		expected: /只能放进常用过滤/,
		rejected: true,
	},
];
let passed = 0;
for (const [i, c] of cases.entries()) {
	const start = Date.now();
	const r = await kernel.probe(opened.value.handle, "FormLayoutWriteProbe", {
		env: { LAYOUT_FORM: "zlgd_sys_bgjl", LAYOUT_EDIT: ["layout list", ...c.lines].join("\n") },
	});
	const output = r.ok ? r.value.output : JSON.stringify(r.error);
	const rejected = /一处都没写/.test(output);
	const pass = c.expected.test(output) && (c.rejected ? rejected : r.ok && r.value.exitCode === 0 && !rejected);
	if (pass) passed++;
	console.log(`${pass ? "PASS" : "FAIL"} ${i + 1} ${c.what} ${((Date.now() - start) / 1000).toFixed(1)} 秒`);
	if (process.argv.includes("--show") || !pass) console.log(output);
}
console.log(`通过 ${passed}/${cases.length}`);
process.exitCode = passed === cases.length ? 0 : 1;
