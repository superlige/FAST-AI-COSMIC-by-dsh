/**
 * S44 批 1 的尺子：在真机工程上跑一次探针，按工具那一层的规则算出模型看到什么、被省的能不能取回。
 *
 * 用法：
 *   node --experimental-strip-types scripts/measure-probe-view.ts --project <工程> --probe <探针> [--env 键=值 …] [--pick 行号或关键字 …]
 *     [--cache <目录>] [--keep] [--json]
 *   … --run "form <单据> --pk <id> --show 字段"   改走 cosmic_run 的运行方式（参数按空格切，不认引号）
 *
 * - 跑的是 `src/resources/embedded.generated.ts` 里的探针（和发布的一样），走常驻进程。
 *   默认每次新开缓存目录、跑完停掉常驻进程；连跑几个探针时给同一个 `--cache` 加 `--keep`，最后一次去掉 `--keep`。
 * - 报：探针原始输出几行几字节；探针自己截断的痕迹（「没列」「只列前」）有几处；
 *   工具那一层裁没裁、省了哪几行、给模型的取回说明；每个 `--pick` 按 raw 同一套规则取回了几行。
 * - 只跑只读探针或写探针的预演：带 APPLY 的 env 直接拒绝，写元数据要先问用户（AGENTS.md 第三节）。
 */

import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { budgetOutput, pickableRemedy, pickLines } from "../src/agent/tools/output-budget.ts";
import { probe } from "../src/kernel/commands/probe.ts";
import { run } from "../src/kernel/commands/run.ts";
import { openProject } from "../src/kernel/open-project.ts";
import { stopServer } from "../src/kernel/probe/server.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";

const argv = process.argv.slice(2);
const one = (name: string): string | undefined => {
	const at = argv.indexOf(name);
	return at < 0 ? undefined : argv[at + 1];
};
const many = (name: string): string[] =>
	argv.flatMap((arg, i) => (arg === name && argv[i + 1] ? [argv[i + 1] as string] : []));
const project = one("--project");
const name = one("--probe");
const runArgs = one("--run")?.split(/\s+/).filter(Boolean);
if (!project || (!name && !runArgs)) {
	console.error(
		'用法：--project <工程> (--probe <探针> [--env 键=值 …] | --run "<run 参数>") [--pick 行号或关键字 …] [--json]',
	);
	process.exit(2);
}
const env = Object.fromEntries(
	many("--env").map((pair) => {
		const eq = pair.indexOf("=");
		return [pair.slice(0, eq), pair.slice(eq + 1)];
	}),
);
if ("APPLY" in env) {
	console.error("这把尺子只跑预演和只读探针；真落库要先问用户。");
	process.exit(2);
}

const opened = await openProject({
	projectRoot: resolve(project),
	agentConfigDir: join(homedir(), ".fast-ai-cosmic"),
	cacheRoot: one("--cache") ? resolve(one("--cache") as string) : mkdtempSync(join(tmpdir(), "cosmic-probe-view-")),
	agentVersion: "dev",
	resources: EMBEDDED_RESOURCES,
});
try {
	const start = Date.now();
	const result = runArgs ? await run(opened.ctx, runArgs) : await probe(opened.ctx, name as string, { env });
	if (!result.ok) {
		console.log(JSON.stringify({ ok: false, ...result.error }, null, 2));
		process.exitCode = 1;
	} else {
		const text = result.value.output;
		const lines = text.split("\n");
		const selfCut = lines.filter((line) => /没列|只列前|…还有 \d+|…… 另有 \d+/.test(line));
		const budget = budgetOutput(text);
		const span = budget.omittedFrom !== null && budget.omittedTo !== null;
		const report = {
			ok: true,
			ms: Date.now() - start,
			exitCode: result.value.exitCode,
			lines: lines.length,
			bytes: Buffer.byteLength(text, "utf8"),
			records: result.value.json.records.length,
			selfCut,
			budget: {
				truncated: budget.truncated,
				omittedFrom: budget.omittedFrom,
				omittedTo: budget.omittedTo,
				shownBytes: Buffer.byteLength(budget.shown, "utf8"),
			},
			remedy: span ? pickableRemedy(text, budget.omittedFrom as number, budget.omittedTo as number) : null,
			picks: many("--pick").map((spec) => {
				const picked = pickLines(text, spec);
				return { spec, ...picked };
			}),
		};
		if (argv.includes("--json")) console.log(JSON.stringify({ ...report, text }, null, 2));
		else {
			const { picks, remedy, ...head } = report;
			console.log(JSON.stringify(head, null, 2));
			if (remedy) console.log(`\n—— 给模型的取回说明 ——\n${remedy}`);
			console.log(`\n—— 模型看到的文字（${String(report.budget.shownBytes)} 字节）——\n${budget.shown}`);
			for (const pick of picks) console.log(`\n—— raw="${pick.spec}" ——\n${JSON.stringify(pick, null, 2)}`);
		}
	}
} finally {
	if (!argv.includes("--keep")) await stopServer(opened.ctx).catch(() => undefined);
}
