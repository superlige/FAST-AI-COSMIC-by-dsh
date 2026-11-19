/**
 * 尺子：一次 cosmic_knowledge 调用要多久（查平台类的方法签名、按名字找类、查文档这几种）。
 *
 * 用法：
 *   node --experimental-strip-types scripts/measure-knowledge-call.ts <工程目录> [--repeat 3]
 *     [--call "<action> <查询词>" …] [--json]
 *
 * 走工具用的同一个入口。默认量三种：查一个平台类的签名（api）、一次查两个类（api）、按名字找类（findclass），
 * 再加一次只查文档的（search）当对照——前三种要到用户的苍穹 JAR 里去反射，每次另起一个 Java 进程；
 * 最后一种只读内嵌的知识库。每种先跑一遍（头一回要编译小工具、解知识库，单列），再连跑几遍取中位。
 *
 * 只读：不起苍穹进程、不连环境、不写工程目录。口径和基线见 `docs/S59-call-overhead-idle-connections.md` §8。
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createKernelAdapter } from "../src/agent/tools/kernel-adapter.ts";
import { PRODUCT_ID } from "../src/brand.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";

const argv = process.argv.slice(2);
const one = (name: string): string | undefined => {
	const at = argv.indexOf(name);
	return at < 0 ? undefined : argv[at + 1];
};
const many = (name: string): string[] =>
	argv.flatMap((arg, i) => (arg === name && argv[i + 1] ? [argv[i + 1] as string] : []));
const project = argv[0];
if (project === undefined || project.startsWith("--")) {
	console.error('用法：measure-knowledge-call.ts <工程目录> [--repeat 3] [--call "<action> <查询词>" …] [--json]');
	process.exit(2);
}
const repeat = Math.max(1, Number(one("--repeat") ?? "3"));
const DEFAULT_CALLS = [
	"api kd.bos.servicehelper.BusinessDataServiceHelper",
	"api kd.bos.servicehelper.workflow.WorkflowServiceHelper kd.bos.form.plugin.AbstractFormPlugin",
	"findclass WorkflowServiceHelper",
	"search 工作流 是否在流程中",
];
const calls = (many("--call").length > 0 ? many("--call") : DEFAULT_CALLS).map((text) => {
	const [action = "", ...rest] = text.split(/\s+/).filter(Boolean);
	return { action, query: rest.join(" ") };
});

const agentConfigDir = join(homedir(), `.${PRODUCT_ID}`);
const kernel = createKernelAdapter({
	agentConfigDir,
	cacheRoot: join(agentConfigDir, "cache"),
	agentVersion: "0.0.0-dev",
	resources: EMBEDDED_RESOURCES,
	knowledgePackFile: join(import.meta.dirname, "..", "knowledge", "cosmic-kb.pack"),
});
const root = resolve(project);
const opened = await kernel.open(root);
if (!opened.ok) {
	console.error(JSON.stringify(opened.error.toJSON()));
	process.exit(1);
}

const median = (values: readonly number[]): number =>
	[...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

const rows = [];
for (const call of calls) {
	const timings: number[] = [];
	let ok = true;
	let bytes = 0;
	let failure = "";
	for (let i = 0; i <= repeat; i++) {
		const started = performance.now();
		const result = await kernel.knowledge(
			{ action: call.action, query: call.query } as never,
			root,
			opened.value.handle,
		);
		timings.push(performance.now() - started);
		ok = ok && result.ok;
		bytes = Buffer.byteLength(JSON.stringify(result.ok ? result.value : result.error.toJSON()), "utf8");
		if (!result.ok) failure = `${result.error.code} ${result.error.message}`;
	}
	const [first = 0, ...rest] = timings;
	rows.push({
		call: `${call.action} ${call.query}`,
		ok,
		failure,
		firstMs: Math.round(first),
		medianMs: Math.round(median(rest)),
		each: rest.map((ms) => Math.round(ms)),
		bytes,
	});
}

if (argv.includes("--json")) {
	console.log(JSON.stringify({ project: root, repeat, rows }, null, 2));
} else {
	for (const row of rows) {
		console.log(
			`${row.call}　${row.ok ? "" : `（失败：${row.failure}）`}头一回 ${String(row.firstMs)} 毫秒；之后中位 ${String(row.medianMs)} 毫秒（${row.each.join(" ")}）　返回 ${String(row.bytes)} 字节`,
		);
	}
}
