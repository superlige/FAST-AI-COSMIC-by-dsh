/**
 * 电脑端列表编辑的固定真机样本。只读和内存预演，不写元数据。
 * node --experimental-strip-types scripts/measure-list-layout.ts <工程目录> [--show] [--only R1,W1]
 * 基线和改后使用同一批输入；通过必须看到预期差异或明确拒绝原因。
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { createKernelAdapter } from "../src/agent/tools/kernel-adapter.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";

const args = process.argv.slice(2);
const project = args[0];
if (!project) throw new Error("用法：measure-list-layout.ts <工程目录> [--show] [--only R1,W1]");
const onlyAt = args.indexOf("--only");
const only = onlyAt < 0 ? null : new Set(args[onlyAt + 1]?.split(","));
const config = join(homedir(), ".fast-ai-cosmic");
const kernel = createKernelAdapter({
	agentConfigDir: config,
	cacheRoot: join(config, "cache"),
	agentVersion: "0.1.0",
	resources: EMBEDDED_RESOURCES,
});
const opened = await kernel.open(project);
if (!opened.ok) throw new Error(JSON.stringify(opened.error.toJSON()));
const form = "zlgd_sys_bgjl";
type Case = { id: string; what: string; env: Record<string, string>; expected: RegExp; rejected?: boolean };
const edit = (id: string, what: string, lines: string[], expected: RegExp, rejected = false): Case => ({
	id,
	what,
	env: { LAYOUT_EDIT: lines.join("\n") },
	expected,
	rejected,
});
const cases: Case[] = [
	{
		id: "R1",
		what: "明确读取电脑端列表及工具栏",
		env: { LAYOUT_PART: "list", LAYOUT_NODE: "_toolbar_" },
		expected: /_toolbar_.*ToolbarAp/,
	},
	edit("W1", "在列表加字段列", ["layout list", "show createtime into gridview"], /新增.*createtime|createtime.*新增/),
	edit(
		"W2",
		"加列表按钮并绑定已有操作",
		[
			"layout list",
			"add BarItemAp zlgd_list_check into _toolbar_ 核对 visible=none lock=none",
			"set zlgd_list_check.OperationKey=save",
		],
		/zlgd_list_check.*save|save.*zlgd_list_check/,
	),
	edit(
		"W3",
		"同一清单新建操作、列表按钮",
		[
			"add op zlgd_list_action donothing 核对",
			"layout list",
			"add BarItemAp zlgd_list_check after tblnew 核对 visible=all lock=none",
			"set zlgd_list_check.OperationKey=zlgd_list_action",
		],
		/zlgd_list_check.*zlgd_list_action/,
	),
	edit(
		"W4",
		"新建字段后放到列表",
		[
			"add field TextField zlgd_list_note into contentpanel 列表备注 visible=none lock=none",
			"layout list",
			"show zlgd_list_note into gridview",
		],
		/ListMeta.*zlgd_list_note/,
	),
	edit(
		"W5",
		"列表列调顺序和宽度",
		["layout list", "show createtime into gridview", "set createtime.Width=180", "move createtime before colbillno"],
		/createtime.*180/,
	),
	edit(
		"W6",
		"加列后撤下，字段保留",
		["layout list", "show createtime into gridview", "remove createtime"],
		/改完和现在一模一样/,
	),
	edit(
		"W7",
		"加按钮后撤下",
		[
			"layout list",
			"add BarItemAp zlgd_list_check into _toolbar_ 核对 visible=none lock=none",
			"remove zlgd_list_check",
		],
		/改完和现在一模一样/,
	),
	edit("N1", "重复加列明确拒绝", ["layout list", "show billno into gridview"], /已经在.*列/, true),
	edit("N2", "列不能放进工具栏", ["layout list", "show createtime into _toolbar_"], /不让|不收|只能/, true),
	edit(
		"N3",
		"按钮不能放进列表列容器",
		["layout list", "add BarItemAp zlgd_list_check into gridview 核对 visible=none lock=none"],
		/只能放进.*工具栏/,
		true,
	),
	edit(
		"N4",
		"不存在的字段拒绝",
		["layout list", "show zlgd_no_such_field into gridview"],
		/没有字段|不在.*字段清单/,
		true,
	),
	edit(
		"N5",
		"列表下不允许创建实体字段",
		["layout list", "add field TextField zlgd_list_note into gridview 备注 visible=none lock=none"],
		/写在 layout bill 下/,
		true,
	),
	edit(
		"N6",
		"按钮绑定不存在操作拒绝",
		[
			"layout list",
			"add BarItemAp zlgd_list_check into _toolbar_ 核对 visible=none lock=none",
			"set zlgd_list_check.OperationKey=zlgd_missing_op",
		],
		/没有操作 zlgd_missing_op/,
		true,
	),
];
let passed = 0;
for (const c of cases.filter((c) => only === null || only.has(c.id))) {
	const start = Date.now();
	const r = await kernel.probe(
		opened.value.handle,
		c.id.startsWith("R") ? "FormLayoutProbe" : "FormLayoutWriteProbe",
		{ env: { LAYOUT_FORM: form, ...c.env } },
	);
	const output = r.ok ? r.value.output : `${r.error.code}: ${r.error.message}\n${JSON.stringify(r.error.detail)}`;
	const refused = /一处都没写/.test(output);
	const success = r.ok && r.value.exitCode === 0 && !refused;
	const pass = c.expected.test(output) && (c.rejected ? refused : success);
	if (pass) passed++;
	console.log(`${pass ? "PASS" : "FAIL"} ${c.id} ${c.what} ${((Date.now() - start) / 1000).toFixed(1)} 秒`);
	if (args.includes("--show") || !pass) console.log(output);
}
console.log(`通过 ${passed}/${cases.filter((c) => only === null || only.has(c.id)).length}`);
process.exitCode = passed === cases.filter((c) => only === null || only.has(c.id)).length ? 0 : 1;
