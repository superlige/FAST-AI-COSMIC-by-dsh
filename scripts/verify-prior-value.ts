/**
 * S37 3.7 真机验证：拿上次跑过的单再跑一次、不给 --set，断言碰巧对上时结果里有「跑之前单上就是这个值」那行；
 * 给了 --set 的不标。
 *
 * 用法：
 *   node --experimental-strip-types scripts/verify-prior-value.ts <工程目录> [实体] [单据编号] [字段=值]
 *
 * 默认 zlgd_sys_test_bill / SYSJC-20260831-0001 / zlgd_yqsyq_m=A（和 verify-combo-set.ts 同一张单、同一个下拉字段）。
 * 第 1 步真提交：把这个字段存成给定的值（测试环境，改数不用确认）。
 *
 *   1. run op save --set 字段=值 --expect 字段=值：这次赋了值，不该标。
 *   2. run op save 不带 --set，--expect 字段=值：跑之前就是这个值，应当标。
 *   3. run form 不带 --set，--expect 字段=值：同上，应当标。
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { createKernelAdapter } from "../src/agent/tools/kernel-adapter.ts";
import { PRODUCT_ID } from "../src/brand.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";

const [projectRoot, entityArg, billnoArg, pairArg] = process.argv.slice(2);
if (projectRoot === undefined) {
	console.error("用法：verify-prior-value.ts <工程目录> [实体] [单据编号] [字段=值]");
	process.exit(2);
}
const entity = entityArg ?? "zlgd_sys_test_bill";
const billno = billnoArg ?? "SYSJC-20260831-0001";
const pair = pairArg ?? "zlgd_yqsyq_m=A";
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

const MARK = /跑之前单上就是这个值/;
const RELEVANT = /✔|✘|⚠|已落库|PROBE-ERR/;
let failures = 0;
async function run(title: string, argv: string[], marked: boolean): Promise<void> {
	const started = Date.now();
	const report = await kernel.run(project, argv, {});
	console.log(`== ${title}（${Date.now() - started} ms）`);
	if (!report.ok) {
		console.log(`   ${JSON.stringify(report.error.toJSON()).slice(0, 1500)}`);
		failures++;
		return;
	}
	const output = report.value.output ?? "";
	for (const line of output.split(/\r?\n/)) if (RELEVANT.test(line)) console.log(`   ${line.slice(0, 300)}`);
	const got = MARK.test(output);
	const passed = /✔ PASS/.test(output) && !/✘ FAIL/.test(output);
	console.log(
		`   断言全过：${passed ? "是" : "否"}；标了碰巧对上：${got ? "是" : "否"}（应当${marked ? "标" : "不标"}）`,
	);
	if (!passed || got !== marked) failures++;
}

await run("1. run op 赋值并断言", ["op", entity, "save", "--billno", billno, "--set", pair, "--expect", pair], false);
await run("2. run op 不赋值只断言", ["op", entity, "save", "--billno", billno, "--expect", pair], true);
await run("3. run form 不赋值只断言", ["form", entity, "--billno", billno, "--expect", pair], true);
console.log(failures === 0 ? "三步都符合预期" : `${failures} 步不符合预期`);
process.exit(failures === 0 ? 0 : 1);
