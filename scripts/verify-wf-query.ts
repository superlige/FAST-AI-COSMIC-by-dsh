/**
 * S37 2-E.1 真机核对：不写临时探针，只用现成的 `DataQueryProbe`（和看字段用的 `MetaProbe`），
 * 能不能答出 09-22 会话里 8 个临时探针要找的四件事：单据在不在流程里、当前节点、审批人和电话、最后审批人。
 *
 * 用法：
 *   node --experimental-strip-types scripts/verify-wf-query.ts <工程目录>                  按下面固定的步骤跑一遍
 *   node --experimental-strip-types scripts/verify-wf-query.ts <工程目录> Probe K=V K=V …   只跑这一次（摸索用）
 *
 * 全程只读：两个探针都只查不写。每一步打印探针输出和用时。
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { createKernelAdapter } from "../src/agent/tools/kernel-adapter.ts";
import { PRODUCT_ID } from "../src/brand.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";

const [projectRoot, probeName, ...pairs] = process.argv.slice(2);
if (projectRoot === undefined) {
	console.error("用法：verify-wf-query.ts <工程目录> [Probe K=V …]");
	process.exit(2);
}
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

type Step = { title: string; probe: string; env: Record<string, string> };

/** 跑一步，打印输出（手机号打码），返回第一行命中里各字段的值；没命中或失败返回 null。 */
async function run(step: Step): Promise<Record<string, string> | null> {
	const started = Date.now();
	const result = await kernel.probe(project, step.probe, { env: step.env });
	console.log(`\n== ${step.title}（${step.probe}，${Date.now() - started} ms）`);
	console.log(
		`   ${Object.entries(step.env)
			.map(([key, value]) => `${key}=${value}`)
			.join("  ")}`,
	);
	if (!result.ok) {
		console.log(`   失败：${JSON.stringify(result.error.toJSON()).slice(0, 2000)}`);
		return null;
	}
	const output = result.value.output.replace(/(phone=\d{3})\d{4}(\d{4})/g, "$1****$2");
	console.log(output);
	for (const note of result.value.notes) console.log(`   · ${note.slice(0, 300)}`);
	const first = output.split("\n").find((line) => line.startsWith("[PROBE] #1 "));
	if (first === undefined) return null;
	return Object.fromEntries(
		first
			.replace(/^\[PROBE\] #1\s+/, "")
			.split(" | ")
			.map((cell) => [cell.slice(0, cell.indexOf("=")), cell.slice(cell.indexOf("=") + 1)] as const),
	);
}

if (probeName !== undefined) {
	const env = Object.fromEntries(
		pairs.map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)] as const),
	);
	await run({ title: "单次", probe: probeName, env });
	process.exit(0);
}

const query = (title: string, env: Record<string, string>): Promise<Record<string, string> | null> =>
	run({ title, probe: "DataQueryProbe", env });
const answers: string[] = [];

// 在流程里的一张单：真机上这类单随时在变，每次现找一条待审批的任务
const task = await query("找一张正在审批的单（待审批任务）", {
	QUERY_ENTITY: "wf_task",
	QUERY_WHERE: "taskstate = willApproval",
	QUERY_FIELDS: "id,entitynumber,businesskey,billno,name,participantname",
	QUERY_LIMIT: "1",
});
if (task !== null) {
	const flow = await query("1 在不在流程里、2 当前节点（流程实例）", {
		QUERY_ENTITY: "wf_execution",
		QUERY_WHERE: `businesskey = ${task.businesskey}`,
		QUERY_FIELDS: "id,activityname,currenttaskid,suspensionstate",
	});
	answers.push(`1 在流程里：${flow === null ? "查不到" : "是"}`, `2 当前节点：${flow?.activityname ?? "查不到"}`);
	const who = await query("3a 当前审批人（任务参与者）", {
		QUERY_ENTITY: "wf_participant",
		QUERY_WHERE: `taskid = ${task.id}`,
		QUERY_FIELDS: "userid,username,name",
	});
	const phone =
		who === null
			? null
			: await query("3b 审批人电话（人员）", {
					QUERY_ENTITY: "bos_user",
					QUERY_WHERE: `id = ${who.userid}`,
					QUERY_FIELDS: "id,number,name,phone",
				});
	answers.push(`3 当前审批人和电话：${phone === null ? "查不到" : `${phone.name} ${phone.phone}`}`);
} else {
	answers.push("1～3：真机上此刻没有待审批的任务，没法核");
}

// 审批完的单：最后一条"同意"的审批记录
const last = await query("4a 最后审批人（任务执行结果，实验室检测单）", {
	QUERY_ENTITY: "wf_hicomment",
	QUERY_WHERE: "entitynumber = zlgd_sys_test_bill; decisiontype = approve",
	QUERY_FIELDS: "businesskey,activityname,userid,resultname,time",
	QUERY_ORDER: "time desc",
	QUERY_LIMIT: "1",
});
const lastUser =
	last === null
		? null
		: await query("4b 最后审批人电话（人员）", {
				QUERY_ENTITY: "bos_user",
				QUERY_WHERE: `id = ${last.userid}`,
				QUERY_FIELDS: "id,number,name,phone",
			});
answers.push(
	`4 最后审批人：${lastUser === null ? "查不到" : `${lastUser.name} ${lastUser.phone}（${last?.activityname}，${last?.time}）`}`,
);

console.log("\n== 结论（全部只用 DataQueryProbe）");
for (const answer of answers) console.log(`   ${answer}`);
