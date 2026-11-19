/**
 * S37 2-D.1 真机核对（只读，不编译）：工程里现在没编的源码，改前（按修改时间）和改后（只认编辑工具写的）
 * 各把几个算成"本次会话改的"。
 *
 * 用法：
 *   node --experimental-strip-types scripts/verify-fast-scope.ts <工程目录> [--hours 72]
 *
 * 假设会话在 N 小时前开始（默认 72）、模型一个文件都没写：这段时间里被人改过、还没编的文件，
 * 改前全算"本次会话改的"，改后一个都不算。只调 `prepareFast`（解析文件、分组、判归属），不跑 Gradle 和 javac。
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { createKernelAdapter } from "../src/agent/tools/kernel-adapter.ts";
import { PRODUCT_ID } from "../src/brand.ts";
import { prepareFast } from "../src/kernel/commands/fast.ts";
import type { KernelContext } from "../src/kernel/context.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";

const args = process.argv.slice(2);
const projectRoot = args.find((arg, i) => !arg.startsWith("--") && args[i - 1] !== "--hours");
if (projectRoot === undefined) {
	console.error("用法：verify-fast-scope.ts <工程目录> [--hours 72]");
	process.exit(2);
}
const hoursAt = args.indexOf("--hours");
const hours = hoursAt >= 0 ? Number(args[hoursAt + 1]) : 72;
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
const ctx = (opened.value.handle as unknown as { ctx: KernelContext }).ctx;
const since = Date.now() - hours * 3600_000;
const name = (file: string): string => file.replace(/^.*[\\/]/, "");
for (const [title, hooks] of [
	["改前（按修改时间）", { authoredSince: since }],
	["改后（只认编辑工具写的，这里是空的）", { authoredSince: since, writtenFiles: [] as string[] }],
] as const) {
	const prepared = prepareFast(ctx, [], hooks);
	const plan = prepared.plan;
	if (plan === null) {
		console.log(`== ${title}：没有生成编译计划（${prepared.blockers.map((blocker) => blocker.code).join("、")}）`);
		continue;
	}
	console.log(
		`== ${title}：没编的 ${plan.files.length} 个，算作本次会话改的 ${plan.authoredFiles.length} 个，算作别人的 ${plan.inheritedStale.length} 个`,
	);
	if (plan.authoredFiles.length > 0) console.log(`   本次会话改的：${plan.authoredFiles.map(name).join("、")}`);
}
