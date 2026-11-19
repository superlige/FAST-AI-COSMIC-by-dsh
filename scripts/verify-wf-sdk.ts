/**
 * S37 工作流参考文档的真机实测：`WorkflowServiceHelper` 常用查询方法在真实环境上返回什么。
 *
 * 用法：
 *   node --experimental-strip-types scripts/verify-wf-sdk.ts <工程目录> [探针文件名，默认 WfSdkCheck.java]
 *
 * 把 `scripts/wf-sdk/` 下的探针临时拷进工程的 `.cosmic-ai/probes/`，跑一次，打印输出后删掉。
 * 探针只调查询方法（不提交、不审批、不撤回），样本在探针里现找：正在审批的单、审批完的单、没进流程的单。
 * 另外按当前 JAR 反射核一遍参考文档里写到、但没法实跑的写方法签名（临时探针只准读，调不了它们）。
 */
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createKernelAdapter } from "../src/agent/tools/kernel-adapter.ts";
import { PRODUCT_ID } from "../src/brand.ts";
import { reflectClass } from "../src/kernel/api-tool.ts";
import type { KernelContext } from "../src/kernel/context.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";

const [projectRoot, probeFileName = "WfSdkCheck.java"] = process.argv.slice(2);
if (projectRoot === undefined) {
	console.error("用法：verify-wf-sdk.ts <工程目录> [探针文件名]");
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

const source = join(dirname(fileURLToPath(import.meta.url)), "wf-sdk", probeFileName);
const probeDir = join(projectRoot, ".cosmic-ai", "probes");
const target = join(probeDir, probeFileName);
if (existsSync(target)) {
	console.error(`${target} 已经存在，不覆盖`);
	process.exit(1);
}
mkdirSync(probeDir, { recursive: true });
copyFileSync(source, target);
try {
	const started = Date.now();
	const result = await kernel.probe(opened.value.handle, `.cosmic-ai/probes/${probeFileName}`, {});
	console.log(`== ${probeFileName}（${Date.now() - started} ms）`);
	if (!result.ok) {
		// 不在这里 exit：exit 会跳过下面 finally 里的删除
		console.log(JSON.stringify(result.error.toJSON()).slice(0, 4000));
		process.exitCode = 1;
	} else {
		// 手机号打码：审批记录里可能带人员电话
		console.log(result.value.output.replace(/(1\d{2})\d{4}(\d{4})(?!\d)/g, "$1****$2"));
		for (const note of result.value.notes) console.log(`   · ${note.slice(0, 300)}`);
	}
} finally {
	rmSync(target, { force: true });
}

/** 参考文档"写操作"一节写到的方法：当前 JAR 上有没有、签名长什么样。 */
const WRITE_METHODS = [
	"completeTask",
	"batchAgreeTaskWithUserId",
	"batchAuditByBusinesskeys",
	"canWithdraw",
	"batchWithdraw",
	"billUnsubmit",
	"abandonByBusienssKey",
	"abandonRootProcessInstance",
];
const ctx = (opened.value.handle as unknown as { ctx: KernelContext }).ctx;
const sig = await reflectClass(ctx, "kd.bos.servicehelper.workflow.WorkflowServiceHelper");
console.log("\n== 写方法在当前 JAR 上的签名");
if (sig === null) {
	console.log("   反射工具跑不起来，没核");
	process.exitCode = 1;
} else {
	for (const method of WRITE_METHODS) {
		const lines = sig.split("\n").filter((line) => line.includes(` ${method}(`));
		console.log(`   ${method}：${lines.length === 0 ? "当前 JAR 上没有" : ""}`);
		for (const line of lines) console.log(`      ${line.trim()}`);
	}
}
