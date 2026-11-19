/**
 * BOTP 转换插件走 `run push` 的真机实测（S40）：挑真机工程里几条现成的转换规则，照验证路线表给的命令跑一遍。
 *
 * 用法：
 *   node --experimental-strip-types scripts/verify-botp-push.ts <工程目录> [样本名…，默认全部]
 *
 * 目标单保存后从数据库回读；样本写死的是 zlgd 真机工程的规则 id 和单据编号（`zlgd_ygpt2.0`），换工程要换样本。
 * 这几条规则上的转换插件都只改目标单、不写库。
 * 判定只看工具留下的验证记录：该留的全过才算过；故意写错输入的样本要「没留记录」才算对。
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { createKernelAdapter } from "../src/agent/tools/kernel-adapter.ts";
import { PRODUCT_ID } from "../src/brand.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";

const [projectRoot, ...picked] = process.argv.slice(2);
if (projectRoot === undefined) {
	console.error("用法：verify-botp-push.ts <工程目录> [样本名…]");
	process.exit(2);
}

interface Sample {
	name: string;
	what: string;
	argv: string[];
	/** 这条样本该有的结局：留下全过的记录，还是输入不成立、不留记录。 */
	want: "全过" | "没留记录";
}

const SAMPLES: Sample[] = [
	{
		name: "head",
		what: "按表头下推；插件按客户名填供应商",
		argv: [
			"push",
			"2424161753291052032",
			"--billno",
			"SFLF-20260920-00000018",
			"--expect",
			"success=true",
			"--expect",
			"bills=1",
			"--expect",
			"zlgd_supply=安徽利来汽车技术有限公司",
			"--expect",
			"zlgd_customers=10468174",
		],
		want: "全过",
	},
	{
		name: "entry",
		what: "按分录 zlgd_syentry 下推（整单分录行全选）；插件按检验类型带出分析方法（这张单没配制样方法）",
		argv: [
			"push",
			"2437936297155778560",
			"--billno",
			"01062609150006",
			"--expect",
			"bills=1",
			"--expect",
			"zlgd_basedatafield4=GB/T 20975.25",
			"--expect",
			"entryentity[0].zlgd_srcentryid=2569113512706070529",
			"--show",
			"zlgd_jglx,zlgd_basedatafield2",
		],
		want: "全过",
	},
	{
		name: "filtered",
		what: "源单没过规则的源单过滤（未审核）：断言下推失败和平台提示",
		argv: [
			"push",
			"2437936297155778560",
			"--billno",
			"2026-09-04-001",
			"--expect",
			"success=false",
			"--expect",
			"message=筛选条件",
		],
		want: "全过",
	},
	{
		name: "bad-pk",
		what: "源单编号在源单里查不到：输入不成立，不留记录",
		argv: ["push", "2437936297155778560", "--billno", "SFLF-20260920-00000018", "--expect", "success=true"],
		want: "没留记录",
	},
	{
		name: "bad-rule",
		what: "规则 id 不存在：输入不成立，不留记录",
		argv: ["push", "1000000000000000001", "--billno", "SFLF-20260920-00000018", "--expect", "success=true"],
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
	const lines = output.split("\n").filter((line) => line.includes("[PROBE]"));
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
