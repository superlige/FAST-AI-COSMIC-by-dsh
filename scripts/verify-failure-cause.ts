/**
 * 真机验证：`run op` 验「会被拦」时，拦它的原因没有全写进 --expect，这次算输入不成立、不留验证记录。
 *
 * 用法：
 *   node --experimental-strip-types scripts/verify-failure-cause.ts <工程目录> [实体] [已提交的单据编号]
 *   环境变量 ONLY=2 只跑第 2 个场景（补跑超时的那个）。
 *
 * 默认 zlgd_sys_test_bill / SYSJC-20260703-0264：一张已经提交过的检测单，再提交平台只报一条
 * 「只有暂存的数据才允许提交」。四个场景都提交不成功，不改任何数据：
 *
 *   1. 已提交的单，error=那句原话：原因写全了，应当全过、留一条验证记录。
 *   2. 已提交的单，message=数据校验发现错误：这句只是顶上的总提示，没有点名哪条拦的，
 *      success=false 应当报「输入不成立」、不留验证记录。
 *   3. 已提交的单，只写 success=false：没说要验哪条，照旧按结果判，应当过。
 *   4. 新建的空单（状态是空的），error=只有暂存的数据才允许提交：还有别的校验一起拦（单据状态、必填），
 *      只写了其中一条，应当报「输入不成立」、列出没写进去的那几条、不留验证记录。
 *
 * 每个场景一次真提交（提交不成功），冷进程下每次一两分钟；第一次运行要先编译探针、装单据，可能超过探针的 120 秒上限，
 * 超了就单独再跑一次。
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { createKernelAdapter } from "../src/agent/tools/kernel-adapter.ts";
import { PRODUCT_ID } from "../src/brand.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";

const [projectRoot, entityArg, billnoArg] = process.argv.slice(2);
if (projectRoot === undefined) {
	console.error("用法：verify-failure-cause.ts <工程目录> [实体] [已提交的单据编号]");
	process.exit(2);
}
const entity = entityArg ?? "zlgd_sys_test_bill";
const billno = billnoArg ?? "SYSJC-20260703-0264";
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

const RELEVANT = /✔|✘|⚠|汇总|\[错误\]|已落库|跑之[前后]行数|PROBE-ERR/;
let failures = 0;
/** counted：success=false 这次算不算数——算数就该过、留记录；不算数就该报输入不成立、不留记录。 */
async function scenario(title: string, argv: string[], counted: boolean): Promise<void> {
	if (process.env.ONLY !== undefined && !title.startsWith(`${process.env.ONLY}.`)) return;
	const started = Date.now();
	const report = await kernel.run(project, argv, {});
	console.log(`== ${title}（${Date.now() - started} ms）`);
	if (!report.ok) {
		console.log(`   ${JSON.stringify(report.error.toJSON()).slice(0, 1500)}`);
		failures++;
		return;
	}
	const output = report.value.output ?? "";
	for (const line of output.split(/\r?\n/)) if (RELEVANT.test(line)) console.log(`   ${line.slice(0, 400)}`);
	const passed = /✔ PASS op-success/.test(output);
	const invalid = /✘ 输入不成立 op-success/.test(output);
	const filed = report.value.evidence.filed.length;
	const ok = counted ? passed && !invalid && filed === 1 : invalid && !passed && filed === 0;
	console.log(
		`   success=false 那条：${passed ? "过" : invalid ? "输入不成立" : "没断"}，验证记录 ${String(filed)} 条` +
			`（应当${counted ? "过、1 条" : "输入不成立、0 条"}；运行方式 ${String(report.value.path)}）`,
	);
	if (!ok) failures++;
}

const blocked = "只有暂存的数据才允许提交";
const old = ["op", entity, "submit", "--billno", billno];
await scenario("1. 已提交的单，原因写全", [...old, "--expect", "success=false", "--expect", `error=${blocked}`], true);
await scenario(
	"2. 已提交的单，只写顶上的总提示",
	[...old, "--expect", "success=false", "--expect", "message=数据校验发现错误"],
	false,
);
await scenario("3. 已提交的单，只写 success=false", [...old, "--expect", "success=false"], true);
await scenario(
	"4. 新建空单，只写了几条原因里的一条",
	["op", entity, "submit", "--expect", "success=false", "--expect", `error=${blocked}`],
	false,
);
console.log(failures === 0 ? "跑了的场景都符合预期" : `${failures} 个场景不符合预期`);
process.exit(failures === 0 ? 0 : 1);
