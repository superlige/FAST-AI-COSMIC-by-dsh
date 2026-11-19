#!/usr/bin/env node --experimental-strip-types

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	ROUND_BASELINE_SAMPLES,
	ROUND_GATE_GOLDENS,
	ROUND_SAFETY_BASELINE,
	roundBaselineTotals,
	summarizeRoundTrace,
} from "../src/eval/round-efficiency.ts";

const failures: string[] = [];
const check = (label: string, condition: boolean): void => {
	console.log(`  ${condition ? "OK  " : "FAIL"} ${label}`);
	if (!condition) failures.push(label);
};

/**
 * 轮数回归：回合计数词表和冻结基线（pi 版时期按「目标已知之后」量的样本），加上不能为省轮数放宽的门槛和安全边界的测试。
 * 改了会影响模型回合数的东西（门槛、工具返回、知识卡片）之后跑。不调模型、不连环境。
 *
 * 用法：npm run verify:rounds
 */
console.log("回合效率基线（范围：目标已知之后）");
for (const kind of ["plugin", "probe", "run"] as const) {
	const samples = ROUND_BASELINE_SAMPLES.filter((sample) => sample.kind === kind);
	console.log(`\n[${kind}] ${samples.length} 个样本`);
	for (const sample of samples) {
		const summary = summarizeRoundTrace(sample.events);
		console.log(
			`  ${sample.id.padEnd(22)} rounds=${summary.accessRounds} docs=${summary.documentAccessRounds} ` +
				`proc=${summary.processStarts} cold=${summary.coldStarts} first=${summary.firstTargetExecutionSucceeded ? "PASS" : "FAIL"}`,
		);
		console.log(`    ${summary.toolSequence.join(" → ")}`);
	}
}

const totals = roundBaselineTotals(ROUND_BASELINE_SAMPLES);
console.log(
	`\n合计 samples=${totals.samples} rounds=${totals.accessRounds} docs=${totals.documentAccessRounds} ` +
		`proc=${totals.processStarts} cold=${totals.coldStarts} blockers=${totals.blockerResponses}`,
);
check(
	"plugin / probe / run 各至少 6 个样本",
	["plugin", "probe", "run"].every(
		(kind) => ROUND_BASELINE_SAMPLES.filter((sample) => sample.kind === kind).length >= 6,
	),
);
check("两道知识门都在", ROUND_GATE_GOLDENS.length === 2);
check("安全基线覆盖 8 个不可放宽边界", ROUND_SAFETY_BASELINE.length === 8);
check("冻结基线没有原样重试", totals.unchangedRetries === 0);
check("每个样本的首次目标执行成功", totals.firstTargetSuccesses === totals.samples);

if (failures.length > 0) {
	console.error(`\n[FAIL] 基线结构不完整：${failures.join("；")}`);
	process.exit(1);
}

console.log("\n运行真实门禁与安全边界回归…");
const vitest = resolve(dirname(fileURLToPath(import.meta.resolve("vitest/package.json"))), "dist/cli.js");
// 跑的就是基线里引用的那些测试（加上计数词表自己的测试），不另抄一份清单。
const testFiles = [
	"test/eval/round-efficiency.test.ts",
	...new Set(
		[...ROUND_GATE_GOLDENS, ...ROUND_SAFETY_BASELINE]
			.flatMap((row) => row.testRefs)
			.filter((ref) => ref.startsWith("test/")),
	),
];
const tested = spawnSync(process.execPath, [vitest, "--run", ...testFiles], {
	cwd: process.cwd(),
	stdio: "inherit",
	env: process.env,
});
if (tested.error) {
	console.error(`[FAIL] Vitest 启动失败：${tested.error.message}`);
	process.exit(1);
}
if (tested.status !== 0) process.exit(tested.status ?? 1);
console.log("\n[PASS] 回合基线、知识门与安全边界全部通过");
