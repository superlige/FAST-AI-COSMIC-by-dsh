/**
 * 尺子：临时探针发给苍穹进程之前，查它用到的平台类和方法签名那一步要多久。
 *
 * 用法：
 *   node --experimental-strip-types scripts/measure-probe-api-precheck.ts <工程目录> --probe <临时探针.java>
 *     [--repeat 3] [--no-memory] [--json]
 *
 * 走工具用的同一个入口（开工程，再做一次探针预检），不编译探针、不起苍穹进程、不连环境。
 * 同一个探针连做几遍：头一遍单列，之后取中位；并报这一步拦没拦下、给了几张签名说明、多少字节。
 * `--no-memory` 每遍之前把记着的答案忘掉，是「每次都另起一个 Java 进程重新问」的样子，拿来和照常的并排比。
 *
 * 探针路径按工程目录相对写，例如 `.cosmic-ai/probes/Look.java`。口径和基线见
 * `docs/S63-returns-after-acceptance-session.md` §2.3。
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createKernelAdapter } from "../src/agent/tools/kernel-adapter.ts";
import { PRODUCT_ID } from "../src/brand.ts";
import { forgetReflectionAnswers } from "../src/kernel/api-tool.ts";
import { renderKnowledgeCapsule } from "../src/knowledge/capsule.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";

const argv = process.argv.slice(2);
const one = (name: string): string | undefined => {
	const at = argv.indexOf(name);
	return at < 0 ? undefined : argv[at + 1];
};
const project = argv[0];
const probe = one("--probe");
if (project === undefined || project.startsWith("--") || probe === undefined) {
	console.error(
		"用法：measure-probe-api-precheck.ts <工程目录> --probe <临时探针.java> [--repeat 3] [--no-memory] [--json]",
	);
	process.exit(2);
}
const repeat = Math.max(1, Number(one("--repeat") ?? "3"));
const noMemory = argv.includes("--no-memory");

const agentConfigDir = join(homedir(), `.${PRODUCT_ID}`);
const kernel = createKernelAdapter({
	agentConfigDir,
	cacheRoot: join(agentConfigDir, "cache"),
	agentVersion: "0.0.0-dev",
	resources: EMBEDDED_RESOURCES,
	knowledgePackFile: join(import.meta.dirname, "..", "knowledge", "cosmic-kb.pack"),
});
const opened = await kernel.open(resolve(project));
if (!opened.ok) {
	console.error(JSON.stringify(opened.error.toJSON()));
	process.exit(1);
}

const median = (values: readonly number[]): number =>
	[...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

const timings: number[] = [];
let blockers = 0;
let cards = 0;
let cardBytes = 0;
let reflection = "";
for (let i = 0; i <= repeat; i++) {
	if (noMemory) forgetReflectionAnswers();
	const started = performance.now();
	const prepared = await kernel.prepareProbe(opened.value.handle, probe, { positional: [], env: {}, cold: false });
	timings.push(performance.now() - started);
	if (!prepared.ok) {
		console.error(JSON.stringify(prepared.error.toJSON()));
		process.exit(1);
	}
	blockers = prepared.value.blockers.length;
	cards = prepared.value.capsules.length;
	cardBytes = prepared.value.capsules.reduce(
		(sum, capsule) => sum + Buffer.byteLength(renderKnowledgeCapsule(capsule), "utf8"),
		0,
	);
	const api = prepared.value.plan?.api as { reflection?: string; queries?: number } | null | undefined;
	reflection = api ? `${String(api.reflection)}，查询 ${String(api.queries)} 条` : "没有可查的";
}

const [first = 0, ...rest] = timings;
const report = {
	probe,
	memory: !noMemory,
	firstMs: Math.round(first),
	laterMedianMs: Math.round(median(rest)),
	laterMs: rest.map((ms) => Math.round(ms)),
	blockers,
	cards,
	cardBytes,
	reflection,
};
if (argv.includes("--json")) {
	console.log(JSON.stringify(report, null, 2));
} else {
	console.log(`${probe}（${noMemory ? "每遍都重新问" : "问过的不再问"}）`);
	console.log(
		`  头一遍 ${String(report.firstMs)} ms；之后 ${String(rest.length)} 遍中位 ${String(report.laterMedianMs)} ms（${report.laterMs.join("、")}）`,
	);
	console.log(
		`  查签名：${reflection}；拦下 ${String(blockers)} 条；签名说明 ${String(cards)} 张、${String(cardBytes)} 字节`,
	);
}
process.exit(0);
