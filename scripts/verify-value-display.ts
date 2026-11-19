/**
 * S37 2-A.4 真机对照：格子里有换行时，`--show` 显示的和 `--expect` 要写的对不对得上。
 *
 * 用法：
 *   node --experimental-strip-types scripts/verify-value-display.ts <工程目录> [模板编码 单据ID 格子]
 *
 * 默认用 S37 第三份样本那张单（`prtpl_jjfswl`，第 93、99、185 次调用）：`LayoutCell19` 打出来是两行。
 * 跑两次 `run print`：
 *   1. --show 格子，外加一条必挂的断言，从机读记录里拿到这格的原值（带真换行）；
 *   2. 三条断言：照 --show 抄的写法（显示和断言对得上就该过）、原值（中间真换行，
 *      样本第 185 次模型就这么写、要一直能过）、把换行换成空格（值确实不一样，该挂）。
 * 只出打印预览，不写数据库；会在 cosmic 自己的 `.cosmic-ai/` 下留一条验证记录。
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { createKernelAdapter } from "../src/agent/tools/kernel-adapter.ts";
import { PRODUCT_ID } from "../src/brand.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";

const [projectRoot, tpl = "zlgd_sys_test_bill_prtpl_jjfswl", pk = "2560941241403458560", cell = "LayoutCell19"] =
	process.argv.slice(2);
if (projectRoot === undefined) {
	console.error("用法：verify-value-display.ts <工程目录> [模板编码 单据ID 格子]");
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

/** 打一次，列出和这个格子有关的行（断言没过时「实际=」后面被换行截断的续行也列出来）。 */
async function print(extra: string[]): Promise<{ text: string; actual: string | null }> {
	const started = Date.now();
	const report = await kernel.run(project, ["print", tpl, "--pk", pk, ...extra], {});
	console.log(`== run print ${JSON.stringify(extra)}（${Date.now() - started} ms）`);
	if (!report.ok) {
		console.log(JSON.stringify(report.error.toJSON()).slice(0, 2000));
		return { text: "", actual: null };
	}
	const text = report.value.output ?? "";
	const lines = text.split(/\r?\n/);
	lines.forEach((line, i) => {
		const tail = i > 0 && /FAIL|PASS/.test(lines[i - 1] ?? "") && !line.startsWith("[");
		if (line.includes(cell) || tail || /^\[PROBE\] {3}\[\d+\]|断言 /.test(line))
			console.log(`   ${JSON.stringify(line)}`);
	});
	const record = report.value.json.records.find((r) => r.t === "assert" && r.target === cell);
	const actual = record === undefined ? null : ((record as { actual?: unknown }).actual as string | null);
	return { text, actual };
}

//第一次：看一眼，顺带用一条必挂的断言从机读记录里拿到这格的原值
const first = await print(["--show", cell, "--expect", `${cell}=?`]);
const row = first.text.split(/\r?\n/).find((line) => /^\[PROBE\] {3}\[0\] /.test(line));
const copied = row === undefined ? "" : row.replace(/^\[PROBE\] {3}\[0\] /, "");
console.log(`照 --show 抄下来的值：${JSON.stringify(copied)}；原值：${JSON.stringify(first.actual)}`);
const raw = first.actual ?? "";
await print([
	"--expect",
	`${cell}=${copied}`,
	"--expect",
	`${cell}=${raw}`,
	"--expect",
	`${cell}=${raw.replace(/\r?\n/g, " ")}`,
]);
process.exit(0);
