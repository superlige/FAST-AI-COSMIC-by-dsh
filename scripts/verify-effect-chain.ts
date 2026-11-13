#!/usr/bin/env node --experimental-strip-types
/**
 * 真机核对：事务外副作用前检按操作链判（zlgd_ygpt2.0 复盘，2026-09-17）。
 *
 * 只读。读一次目标单据的操作链（OpMetaProbe），再把几条 run 命令**只跑前检**——
 * 不起 OpSandbox / FormSim、不开事务、不写库。命令是写死的形状，不接受任意命令行。
 *
 * Usage:
 *   node --experimental-strip-types scripts/verify-effect-chain.ts <projectRoot> <单据标识> <操作 | click:按钮>...
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { PRODUCT_ID } from "../src/brand.ts";
import { prepareRunInvocation, prepareRunInvocationChecked, readOperationChain } from "../src/kernel/commands/run.ts";
import { openProject } from "../src/kernel/open-project.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";

async function main(): Promise<void> {
	const [root, bill, ...runs] = process.argv.slice(2);
	if (!root || !bill || runs.length === 0) {
		console.error("用法: verify-effect-chain.ts <projectRoot> <单据标识> <操作 | click:按钮>...");
		process.exit(2);
	}
	const agentConfigDir = process.env.COSMIC_AGENT_DIR ?? join(homedir(), `.${PRODUCT_ID}`);
	const { ctx } = await openProject({
		projectRoot: root,
		agentConfigDir,
		cacheRoot: process.env.COSMIC_CACHE_ROOT ?? join(agentConfigDir, "cache"),
		agentVersion: "0.0.0-verify",
		resources: EMBEDDED_RESOURCES,
	});

	const t0 = Date.now();
	const chain = await readOperationChain(ctx, bill);
	console.log(`操作链读取 ${String(Date.now() - t0)}ms：${chain.ok ? "成功" : `失败 ${chain.reason}`}`);
	if (chain.ok) {
		for (const [op, classes] of chain.chain.plugins)
			if (classes.length > 0) console.log(`  ${op}: ${classes.join(", ")}`);
		console.log(
			`  单据侧按钮 ${String(chain.chain.bars.bill.size)} 个，列表侧 ${String(chain.chain.bars.list.size)} 个`,
		);
	}

	for (const spec of runs) {
		const argv = spec.startsWith("click:")
			? ["form", bill, "--click", spec.slice("click:".length)]
			: ["op", bill, spec];
		const before = prepareRunInvocation(ctx, argv);
		const after = await prepareRunInvocationChecked(ctx, argv, async () => chain);
		console.log(`\n== ${argv.join(" ")}`);
		console.log(`  改前口径（不读操作链）：阻碍 ${String(before.blockers.length)} 条`);
		console.log(`  现在：阻碍 ${String(after.blockers.length)} 条`);
		for (const blocker of after.blockers) {
			console.log(`    ${blocker.code} ${blocker.message}`);
			console.log(`      scope=${String(blocker.detail?.scope)} reason=${String(blocker.detail?.reason)}`);
			console.log(`      remedy: ${blocker.remedy}`);
		}
		for (const warning of after.warnings) console.log(`    警告: ${warning}`);
	}
}

main().catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
