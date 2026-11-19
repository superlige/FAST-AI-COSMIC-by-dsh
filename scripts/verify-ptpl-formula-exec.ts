/**
 * 真机尺子：打印公式试算说「过了」时，平台执行器有没有在背后吞掉报错（S32 §16）。
 *
 * 打印的公式执行器 `PrintFormulaExecute` 算每一行时出了错只记一条 WARN「引擎进行计算有特殊情况：…」，
 * 那一行当空串接着算，不抛。所以试算报「都过了」、某一档显示为空，日志里却可能有一条平台报错。
 * 这把尺子照 2026-10-19 那次会话的原样参数，把五份候选各预演一遍，并排给出：
 *   - 公式试算的结论那一行（过了 / 几条写坏了）和每条公式每一档显示什么；
 *   - 完整日志里「引擎进行计算有特殊情况」有几条、原话是什么；
 *   - 真单预览里那几格显示什么（`--pk`）；
 *   - 预演走没走到头。
 *
 * 只跑预演：不带 apply、不给 --backup，不落库、不改单据。候选先复制到 `.cosmic-ai/work/ptpl-formula-exec/`
 * （cosmic 自己的工作目录）再预演，会话留下的候选原件不动。
 *
 * 用法：
 *   node --experimental-strip-types scripts/verify-ptpl-formula-exec.ts <工程目录> [--from <候选总目录>] [--only 5,9,…] [--json]
 *
 * `--from` 默认 `outputs/report-date-only/candidate`（那次会话留下的五份候选，子目录名就是下面的 id）。
 */
import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createKernelAdapter } from "../src/agent/tools/kernel-adapter.ts";
import { PRODUCT_ID } from "../src/brand.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";

/** 那次会话的五次预演：模板编码、候选子目录、真单预览用的单据。 */
const CASES = [
	{ id: "5", number: "zlgd_sys_test_bill_prtpl_5", pk: "2579029266062685184" },
	{ id: "9", number: "zlgd_sys_test_bill_prtpl_9_copy", pk: "2579029266062685184" },
	{ id: "63", number: "zlgd_sys_test_bill_prtpl_63", pk: "2579029266062685184" },
	{ id: "jsclbg", number: "zlgd_sys_test_bill_jsclbg", pk: "2579029266062685184" },
	{ id: "3_ycl", number: "zlgd_sys_test_bill_prtpl_3_ycl", pk: "2578544759719070720" },
];

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
	const at = args.indexOf(`--${name}`);
	if (at < 0) return undefined;
	const value = args[at + 1];
	args.splice(at, 2);
	return value;
};
const from = flag("from") ?? "outputs/report-date-only/candidate";
const only = flag("only")?.split(",");
const asJson = args.includes("--json");
if (asJson) args.splice(args.indexOf("--json"), 1);
const [projectRoot] = args;
if (projectRoot === undefined) {
	console.error("用法：verify-ptpl-formula-exec.ts <工程目录> [--from <候选总目录>] [--only 5,9,…] [--json]");
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
const work = resolve(projectRoot, ".cosmic-ai/work/ptpl-formula-exec");
rmSync(work, { recursive: true, force: true });

/** 打印执行器吞掉报错时记的那句。 */
const SWALLOWED = /引擎进行计算有特殊情况：(.*)$/;

const summary: object[] = [];
for (const one of CASES) {
	if (only && !only.includes(one.id)) continue;
	const source = resolve(projectRoot, from, one.id);
	if (!existsSync(source)) {
		console.log(`== ${one.id}：候选目录不在 ${source}，跳过`);
		continue;
	}
	const dir = join(work, one.id);
	cpSync(source, dir, { recursive: true });
	const argv = [
		"ptpl",
		"apply",
		one.number,
		"--file",
		join(dir, `${one.number}.meta.json`),
		"--locale",
		join(dir, `${one.number}.locale.json`),
		"--pk",
		one.pk,
	];
	const started = Date.now();
	const done = await kernel.meta(project, argv, {});
	const ms = Date.now() - started;
	if (!done.ok) {
		console.log(`== ${one.id} ${one.number}（${ms} ms）没跑成：${JSON.stringify(done.error.toJSON())}`);
		summary.push({ id: one.id, ok: false, ms });
		continue;
	}
	const text = done.value.text;
	const outFile = done.value.probe?.outputFile;
	const log = outFile && existsSync(outFile) ? readFileSync(outFile, "utf8") : "";
	const swallowed = log
		.split(/\r?\n/)
		.map((line) => SWALLOWED.exec(line)?.[1]?.trim())
		.filter((m): m is string => m !== undefined);
	const lines = text.split(/\r?\n/);
	const verdict = lines.find((line) => line.includes("公式试算：")) ?? "（没有公式试算那一行）";
	const trial = lines.filter((line) => / 时显示：|✗ |平台报错：|算的时候平台报错|交给.*的是：/.test(line));
	// 候选预览：「看 <格子>：… 输出 N 行」接着「  [i] 内容」
	const at = lines.findIndex((line) => line.includes("--- 候选预览"));
	const preview = at < 0 ? [] : lines.slice(at + 1).filter((line) => /\[PROBE\] 看 |\[PROBE\] {3}\[\d+\] /.test(line));
	const finished = text.includes("dry-run 结束");
	summary.push({ id: one.id, number: one.number, ms, verdict, swallowed: swallowed.length, finished });
	if (asJson) continue;
	console.log(`== ${one.id} ${one.number}（${ms} ms）`);
	console.log(`  结论：${verdict.replace(/^\[PROBE\]\s*/, "")}`);
	for (const line of trial) console.log(`  ${line.replace(/^\[PROBE\]\s*/, "")}`);
	console.log(`  完整日志里被执行器吞掉的计算报错：${swallowed.length} 条`);
	for (const m of [...new Set(swallowed)]) console.log(`    ${m}`);
	for (const line of preview.slice(0, 12)) console.log(`  预览 ${line.replace(/^\[PROBE\]\s*/, "")}`);
	console.log(`  预演走到头：${finished ? "是" : "否"}`);
}
if (asJson) console.log(JSON.stringify(summary, null, 1));
process.exit(0);
