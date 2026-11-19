/**
 * 工作流插件走 `run wf` 的真机实测（S41）：挑真机工程里几个挂在已发布流程上的工作流插件，照验证路线表给的命令跑一遍。
 *
 * 用法：
 *   node --experimental-strip-types scripts/verify-wf-plugin.ts <工程目录> [样本名…，默认全部]
 *
 * 样本写死的是 zlgd 真机工程（`zlgd_ygpt2.0`）的插件、单据编号和节点名，换工程要换样本。
 * 插件保存单据是真提交：跑过一次，单上就留着插件写的值，再跑会多出「跑之前单上就是这个值」的提醒，结论不变。
 * 判定只看工具留下的验证记录：该留的全过才算过；故意写错输入的样本要「没留记录」才算对。
 * 工程里有比 .class 新的源文件时先编译（`COSMIC_STALE=fast`），不然运行会被拦下。
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { createKernelAdapter } from "../src/agent/tools/kernel-adapter.ts";
import { PRODUCT_ID } from "../src/brand.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";

const [projectRoot, ...picked] = process.argv.slice(2);
if (projectRoot === undefined) {
	console.error("用法：verify-wf-plugin.ts <工程目录> [样本名…]");
	process.exit(2);
}

interface Sample {
	name: string;
	what: string;
	argv: string[];
	/** 这条样本该有的结局：留下全过的记录，还是输入不成立、不留记录。 */
	want: "全过" | "没留记录";
}

/** 会审投票用的用户：真机工程 .cosmic-ai/config.json 里的调试用户。 */
const VOTER = "2280438021310427136";

const SAMPLES: Sample[] = [
	{
		name: "reject-message",
		what: "驳回至提交节点时把审批意见写回单据（任务完成监听，决策项 RejectToEdit）",
		argv: [
			"wf",
			"ReplyRejectionMessageWorkFlow",
			"--billno",
			"GDDDEPTPLAN202609030190",
			"--ctx",
			"message=考核数据不全",
			"--expect",
			"zlgd_reply_message=考核数据不全",
		],
		want: "全过",
	},
	{
		name: "reject-row",
		what: "驳回时在驳回记录分录加一行：节点名、原因（插件把多语言 JSON 意见解析成中文）",
		argv: [
			"wf",
			"GeneralWorkFlowPlugin",
			"--billno",
			"XSDD-0602-202609-0006",
			"--node",
			"技术中心评审",
			"--ctx",
			"message=资料不全",
			"--expect",
			"zlgd_is_bh=true",
			"--expect",
			"zlgd_entryentity[0].zlgd_reject_name=技术中心评审",
			"--expect",
			"zlgd_entryentity[0].zlgd_reject_reason=资料不全",
			"--show",
			"zlgd_entryentity.zlgd_reject_reason",
		],
		want: "全过",
	},
	{
		name: "node-entry",
		what: "进入节点时写节点名（挂了 5 个节点，--node 挑一个）",
		argv: [
			"wf",
			"FeedBackWorkFlowPlugin",
			"--billno",
			"YGWC-20251231-00000042",
			"--node",
			"部门主要负责人审批",
			"--expect",
			"zlgd_auditor_name=部门主要负责人审批",
		],
		want: "全过",
	},
	{
		name: "consent-flag",
		what: "选「不发送MES」这个同意项时勾上接口不发送（决策项 Consent2）",
		argv: ["wf", "XssalorderWorkFlowPlugin", "--pk", "2553958827431087104", "--expect", "zlgd_jkbfs=true"],
		want: "全过",
	},
	{
		name: "expire",
		what: "超时插件：单上没有流程日期时返回 9999999 分钟",
		argv: [
			"wf",
			"QualityObjectionFeedbackWorkFLowPlugin",
			"--billno",
			"ZLYYFKD-0602-202608-0059",
			"--expect",
			"result=9999999",
		],
		want: "全过",
	},
	{
		name: "joint-reject",
		what: "会审插件（流程里没挂）：有人驳回就立即结束、透传驳回的决策项",
		argv: [
			"wf",
			"JointAuditRolePlugin",
			"zlgd_ms_ces",
			"--billno",
			"ZLYYFKD-0602-202608-0059",
			"--ctx",
			`vote=${VOTER}:reject:RejectToEdit`,
			"--expect",
			"result.pass=false",
			"--expect",
			"result.over=true",
			"--expect",
			"result.resultNumber=RejectToEdit",
		],
		want: "全过",
	},
	{
		name: "joint-wait",
		what: "会审插件：一人同意、还有一票没投，角色没凑齐就继续等",
		argv: [
			"wf",
			"JointAuditRolePlugin#getJointAuditResult",
			"zlgd_ms_ces",
			"--billno",
			"ZLYYFKD-0602-202608-0059",
			"--ctx",
			`vote=${VOTER}:approve:Consent`,
			"--ctx",
			"pending=1",
			"--expect",
			"result.pass=false",
			"--expect",
			"result.over=false",
		],
		want: "全过",
	},
	{
		name: "bad-decision",
		what: "决策项写成节点上没配的编码：输入不成立",
		argv: [
			"wf",
			"ReplyRejectionMessageWorkFlow",
			"--billno",
			"GDDDEPTPLAN202609030190",
			"--ctx",
			"decision=Nope",
			"--expect",
			"zlgd_reply_message=x",
		],
		want: "没留记录",
	},
	{
		name: "bad-bill",
		what: "单据在挂它的流程单据里都查不到：输入不成立",
		argv: ["wf", "ReplyRejectionMessageWorkFlow", "--pk", "1", "--expect", "zlgd_reply_message=x"],
		want: "没留记录",
	},
	{
		name: "bad-node",
		what: "--node 写成它没挂的节点：输入不成立，并列出挂的节点",
		argv: [
			"wf",
			"FeedBackWorkFlowPlugin",
			"--billno",
			"YGWC-20251231-00000042",
			"--node",
			"不存在的节点",
			"--expect",
			"zlgd_auditor_name=x",
		],
		want: "没留记录",
	},
];

const chosen = picked.length === 0 ? SAMPLES : SAMPLES.filter((sample) => picked.includes(sample.name));
const agentConfigDir = process.env.COSMIC_AGENT_DIR ?? join(homedir(), `.${PRODUCT_ID}`);
const kernel = createKernelAdapter({
	agentConfigDir,
	cacheRoot: process.env.COSMIC_CACHE_ROOT ?? join(agentConfigDir, "cache"),
	agentVersion: "0.1.0",
	resources: EMBEDDED_RESOURCES,
});
const opened = await kernel.open(projectRoot);
if (!opened.ok) {
	console.error(JSON.stringify(opened.error.toJSON()));
	process.exit(1);
}
const project = opened.value.handle;

const results: { name: string; ms: number; verdict: string; want: string }[] = [];
for (const sample of chosen) {
	const started = Date.now();
	const report = await kernel.run(project, sample.argv, {});
	const ms = Date.now() - started;
	console.log(`\n==== ${sample.name}（${sample.what}）${ms} ms`);
	console.log(`run ${sample.argv.map((arg) => (/[\s"[{]/.test(arg) ? `'${arg}'` : arg)).join(" ")}`);
	if (!report.ok) {
		console.log(JSON.stringify(report.error.toJSON()).slice(0, 3000));
		results.push({ name: sample.name, ms, verdict: "工具报错", want: sample.want });
		continue;
	}
	const output = report.value.output ?? "";
	const lines = output.split("\n").filter((line) => line.includes("[PROBE]") && !line.includes("[PROBE-JSON]"));
	for (const line of (lines.length > 0 ? lines : output.split("\n")).slice(0, 40))
		console.log(`  ${line.slice(0, 600)}`);
	for (const note of new Set([...report.value.notes, ...report.value.evidence.notes]))
		console.log(`  · ${note.slice(0, 600)}`);
	const filed = report.value.evidence.filed;
	const verdict =
		filed.length === 0 ? "没留记录" : filed.every((record) => record.result === "PASS") ? "全过" : "没过";
	console.log(`  验证记录：${filed.map((record) => `${record.id} ${record.result}`).join("，") || "无"}`);
	results.push({ name: sample.name, ms, verdict, want: sample.want });
}
console.log("\n==== 汇总");
for (const row of results)
	console.log(
		`  ${row.verdict === row.want ? "符合" : "不符"}  ${row.name}：${row.verdict}（该是 ${row.want}）${row.ms} ms`,
	);
process.exit(results.every((row) => row.verdict === row.want) ? 0 : 1);
