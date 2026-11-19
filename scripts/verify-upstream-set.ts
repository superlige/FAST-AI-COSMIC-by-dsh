/**
 * 真机验证：`run op --set @上游.<单据>.<字段>=值` 跑之前改连着的单、这个场景跑完改回。
 *
 * 用法：
 *   node --experimental-strip-types scripts/verify-upstream-set.ts <工程目录> [检测单编号] [上游单据标识]
 *
 * 默认 zlgd_sys_test_bill / SYSJC-20260703-0264，上游 zlgd_qty_wtd：这张检测单已经提交过，再提交平台一定拦
 * （「只有暂存的数据才允许提交」），所以不会用掉单据，能反复跑。一次 `--case` 跑四个场景：
 *
 *   1. 改上游表头两个字段、提交被拦：应当过、留 1 条验证记录，跑完上游改回原值；
 *   2. 改上游分录第 1 行一个字段、提交被拦：同上，分录行也改回；
 *   3. @上游 后面写了一类不连着的单（bd_material）：输入不成立，说出它连着的上游是哪类单，不留记录；
 *   4. @上游 的字段写错：输入不成立，不留记录。
 *
 * 跑之前、跑之后各用 DataQueryProbe 独立查一次上游那几个字段，两次逐字相同才算改回了。
 * 另核两条不起 JVM 就拦的：不给 --pk / --billno、写在 run form 上。
 *
 * 对照：真机 2026-10-07 19:06 那次会话验同样的「上游是某个样子时提交被拦 / 放行」，改上游、跑、改回分成 9 轮。
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { createKernelAdapter } from "../src/agent/tools/kernel-adapter.ts";
import { PRODUCT_ID } from "../src/brand.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";

const [projectRoot, billnoArg, upstreamArg] = process.argv.slice(2);
if (projectRoot === undefined) {
	console.error("用法：verify-upstream-set.ts <工程目录> [检测单编号] [上游单据标识]");
	process.exit(2);
}
const entity = "zlgd_sys_test_bill";
const billno = billnoArg ?? "SYSJC-20260703-0264";
const upstream = upstreamArg ?? "zlgd_qty_wtd";
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
let failures = 0;
const check = (ok: boolean, what: string): void => {
	console.log(`   ${ok ? "✔" : "✘"} ${what}`);
	if (!ok) failures++;
};

/** 上游那几个字段的现值：DataQueryProbe 的数据行，原样比。 */
async function upstreamNow(): Promise<string[]> {
	const out = await kernel.probe(project, "DataQueryProbe", {
		env: {
			QUERY_ENTITY: entity,
			QUERY_WHERE: `billno = ${billno}`,
			QUERY_FIELDS: `billno,@上游.${upstream}.zlgd_bglx,@上游.${upstream}.zlgd_ysbz,@上游.${upstream}.zlgd_syentry.zlgd_samplno`,
		},
	});
	if (!out.ok) {
		console.log(`   查上游失败：${JSON.stringify(out.error.toJSON()).slice(0, 600)}`);
		failures++;
		return [];
	}
	return (out.value.output ?? "").split(/\r?\n/).filter((line) => line.includes(billno) && !line.includes("条件"));
}

console.log(`== 跑之前查上游（${entity} ${billno} 连着的 ${upstream}）`);
const before = await upstreamNow();
for (const line of before) console.log(`   ${line.slice(0, 400)}`);
check(before.length > 0, "查到了这张单和它的上游");

const blocked = "只有暂存的数据才允许提交";
const argv = [
	"op",
	entity,
	"submit",
	"--case",
	"改上游表头",
	"--billno",
	billno,
	"--set",
	`@上游.${upstream}.zlgd_bglx=3`,
	"--set",
	`@上游.${upstream}.zlgd_ysbz=S49 跑完改回`,
	"--expect",
	"success=false",
	"--expect",
	`error=${blocked}`,
	"--case",
	"改上游分录",
	"--billno",
	billno,
	"--set",
	`@上游.${upstream}.zlgd_syentry[0].zlgd_samplno=S49-ROW`,
	"--expect",
	"success=false",
	"--expect",
	`error=${blocked}`,
	"--case",
	"不连着的单",
	"--billno",
	billno,
	"--set",
	"@上游.bd_material.name=S49",
	"--expect",
	"success=false",
	"--case",
	"上游字段写错",
	"--billno",
	billno,
	"--set",
	`@上游.${upstream}.zlgd_no_such_field=1`,
	"--expect",
	"success=false",
];
const started = Date.now();
const report = await kernel.run(project, argv, {});
console.log(`== 一次 --case 跑四个场景（${Date.now() - started} ms）`);
if (!report.ok) {
	console.log(`   ${JSON.stringify(report.error.toJSON()).slice(0, 2000)}`);
	process.exit(1);
}
const output = report.value.output ?? "";
const RELEVANT = /✔|✘|⚠|!!|场景 \d|改上游|改回|跑之前改|输入不成立|汇总|PROBE-ERR|set /;
for (const line of output.split(/\r?\n/)) if (RELEVANT.test(line)) console.log(`   ${line.slice(0, 400)}`);
const filed = report.value.evidence.filed.map((entry) => entry.scenarioId);
console.log(`   验证记录：${filed.join("、") || "（无）"}；运行方式 ${String(report.value.path)}`);
check(filed.includes("改上游表头") && filed.includes("改上游分录"), "两个改上游的场景各留一条验证记录");
check(!filed.includes("不连着的单") && !filed.includes("上游字段写错"), "两个写错的场景不留记录");
check((output.match(/已改回/g) ?? []).length >= 2, "两个改上游的场景都打了「已改回」");
check(/没有 bd_material 的上游单；它连着的上游单：.*zlgd_qty_wtd/.test(output), "不连着的单：说出它连着的上游是哪类单");
check(/zlgd_no_such_field/.test(output) && /输入不成立 上游字段写错/.test(output), "字段写错：输入不成立");

console.log("== 跑之后查上游");
const after = await upstreamNow();
for (const line of after) console.log(`   ${line.slice(0, 400)}`);
check(before.length > 0 && JSON.stringify(before) === JSON.stringify(after), "跑之前、跑之后上游那几个字段逐字相同");

console.log("== 不起 JVM 就拦的两种");
for (const [title, bad, expected] of [
	["不给 --pk / --billno", ["op", entity, "save", "--set", `@上游.${upstream}.zlgd_bglx=3`], "要配 --pk 或 --billno"],
	[
		"写在 run form 上",
		["form", entity, "--billno", billno, "--set", `@上游.${upstream}.zlgd_bglx=3`, "--show", "billno"],
		"只有 run op 读",
	],
] as const) {
	const refused = await kernel.run(project, [...bad], {});
	// 阻碍逐条放在 detail.blockers 里（代码、原因、改法用制表符隔开），标题只是「发现 N 个阻碍」
	const blockers = refused.ok
		? []
		: (((refused.error.toJSON().detail as { blockers?: unknown } | undefined)?.blockers ?? []) as string[]);
	const said = blockers.map((line) => String(line).split("\t")[1] ?? "").find((line) => line.includes(expected)) ?? "";
	check(!refused.ok && said !== "", `${title}：${said || "没拦"}`);
}

console.log(failures === 0 ? "全部符合预期" : `${failures} 处不符合预期`);
process.exit(failures === 0 ? 0 : 1);
