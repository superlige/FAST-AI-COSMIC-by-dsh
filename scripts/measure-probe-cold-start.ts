/**
 * 尺子：常驻探针 JVM 冷启动每一段花多久。
 *
 * 用法：
 *   node --experimental-strip-types scripts/measure-probe-cold-start.ts <工程目录> [实体1] [实体2]
 *
 * 先停掉本工程（源码版 RuntimeKey，和 `cli.ts` 同一个）的常驻 JVM，再连跑三次只读 MetaProbe：
 * 实体1（冷启动）→ 实体2（热、第一次碰这个实体）→ 实体1（热、第二次）。
 * 同时盯着常驻日志，给「JVM 开始打日志」「启动中」「元数据预热完成」「就绪」各打一个时间点，
 * 和内核报的阶段（编宿主、起进程、等预热）排在一条时间线上。只读，不写元数据。
 */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createKernelAdapter } from "../src/agent/tools/kernel-adapter.ts";
import { PRODUCT_ID } from "../src/brand.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";

const [projectRoot, first = "zlgd_sys_bgjl", second = "zlgd_sys_test_bill"] = process.argv.slice(2);
if (projectRoot === undefined) {
	console.error("用法：measure-probe-cold-start.ts <工程目录> [实体1] [实体2]");
	process.exit(2);
}

const agentConfigDir = join(homedir(), `.${PRODUCT_ID}`);
const kernel = createKernelAdapter({
	agentConfigDir,
	cacheRoot: join(agentConfigDir, "cache"),
	agentVersion: "0.0.0-dev",
	resources: EMBEDDED_RESOURCES,
});

const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`;
const opened = await kernel.open(projectRoot);
if (!opened.ok) {
	console.error(JSON.stringify(opened.error.toJSON()));
	process.exit(1);
}
const handle = opened.value.handle;
console.log(`${at()} 打开工程  RuntimeKey=${opened.value.summary.runtimeKeyId}`);

const stopped = await kernel.probeServer(handle, "stop");
console.log(`${at()} 停常驻  ${stopped.ok ? (stopped.value.stopped ?? "absent") : stopped.error.message}`);
const logFile = stopped.ok ? stopped.value.logFile : "";

// 盯常驻日志：新出现的关键行打时间点。日志在每次起进程时重写，所以从 0 读起、按长度增量看。
const marks: [RegExp, string][] = [
	[/JRebel:/, "JVM 开始打日志（JRebel 代理已加载）"],
	[/\[PSERVER\] 启动中/, "宿主 main 开始"],
	[/getconnection:\d{3,}ms/, "第一次连上数据库"],
	[/\[PSERVER\] 元数据预热完成/, "元数据预热完成"],
	[/\[PSERVER\] 就绪/, "就绪（开始应答）"],
];
const seen = new Set<string>();
let offset = 0;
let startedSize = -1;
const watcher = setInterval(() => {
	let size: number;
	try {
		size = statSync(logFile).size;
	} catch {
		return;
	}
	if (startedSize < 0) startedSize = size;
	if (size < offset) offset = 0;
	if (size === offset) return;
	const text = readFileSync(logFile, "utf8").slice(offset);
	offset = size;
	for (const line of text.split(/\r?\n/)) {
		for (const [pattern, label] of marks) {
			if (seen.has(label) || !pattern.test(line)) continue;
			seen.add(label);
			const extra = /预热完成|getconnection/.test(label + line) ? `  「${line.trim().slice(0, 90)}」` : "";
			console.log(`${at()}   日志：${label}${extra}`);
		}
	}
}, 100);
// 停掉之后日志文件还留着上一次的内容；起新进程时会被截断重写，上面按「变短就从头读」处理。
await new Promise((r) => setTimeout(r, 300));
try {
	offset = statSync(logFile).size;
} catch {
	offset = 0;
}

async function meta(entity: string, label: string): Promise<void> {
	const from = Date.now();
	console.log(`${at()} ── ${label}：MetaProbe ${entity}`);
	const r = await kernel.probe(handle, "MetaProbe", {
		positional: [],
		env: { META_ENTITY: entity },
		countRepeats: false,
		onProgress: (stage) => console.log(`${at()}   内核阶段：${stage}`),
	});
	const secs = ((Date.now() - from) / 1000).toFixed(1);
	if (!r.ok) {
		console.log(`${at()}   失败（${secs}s）：${r.error.message}`);
		return;
	}
	const v = r.value as { path?: string; notes?: string[]; output?: string };
	const fields = /命中字段 (\d+)/.exec(v.output ?? "")?.[1] ?? "?";
	console.log(`${at()}   完成 ${secs}s  路径=${v.path}  字段 ${fields} 个`);
}

await meta(first, "冷启动");
await meta(second, "热，第一次碰这个实体");
await meta(first, "热，第二次碰这个实体");
clearInterval(watcher);
process.exit(0);
