/**
 * S42 批 1 的尺子：FormLayoutProbe 按需读布局，每次调用的耗时和输出字节。
 *
 * 用法：
 *   node --experimental-strip-types scripts/measure-form-layout.ts <工程目录> <调用> [<调用> ...]
 *
 * 一个调用写成 `单据标识` 或 `单据标识?NODE=a,b&FIND=词&PROPS=c`（键省掉 LAYOUT_ 前缀）。
 * 量别的只读探针写成 `@探针名?键=值&键=值`（键原样），例如 `@OpMetaProbe?OP_ENTITY=zlgd_sys_bgjl`。
 * 所有调用在同一个内核里依次跑：第一次含起进程，后面的是常驻进程里的耗时。只读。
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { createKernelAdapter } from "../src/agent/tools/kernel-adapter.ts";
import { PRODUCT_ID } from "../src/brand.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";

const [projectRoot, ...calls] = process.argv.slice(2);
if (projectRoot === undefined || calls.length === 0) {
	console.error("用法：measure-form-layout.ts <工程目录> <单据标识[?NODE=a,b&FIND=词&PROPS=c]> ...");
	process.exit(2);
}

const agentConfigDir = join(homedir(), `.${PRODUCT_ID}`);
const kernel = createKernelAdapter({
	agentConfigDir,
	cacheRoot: join(agentConfigDir, "cache"),
	agentVersion: "0.1.0",
	resources: EMBEDDED_RESOURCES,
});
const opened = await kernel.open(projectRoot);
if (!opened.ok) {
	console.error(JSON.stringify(opened.error.toJSON()));
	process.exit(1);
}

const rows: string[] = [];
for (const call of calls) {
	const [head = "", query = ""] = call.split("?");
	const other = head.startsWith("@");
	const env: Record<string, string> = other ? {} : { LAYOUT_FORM: head };
	for (const [k, v] of new URLSearchParams(query)) env[other ? k : `LAYOUT_${k}`] = v;
	const started = Date.now();
	const r = await kernel.probe(opened.value.handle, other ? head.slice(1) : "FormLayoutProbe", { env });
	const seconds = ((Date.now() - started) / 1000).toFixed(1);
	if (!r.ok) {
		console.log(`=== ${call}  ${seconds} 秒  失败`);
		console.log(JSON.stringify(r.error.toJSON()).slice(0, 4000));
		rows.push(`${call}\t${seconds}\t失败`);
		continue;
	}
	const output = String((r.value as { output?: string }).output ?? JSON.stringify(r.value));
	const bytes = Buffer.byteLength(output, "utf8");
	const lines = output.split("\n").filter((l) => l.startsWith("[PROBE] ")).length;
	console.log(`=== ${call}  ${seconds} 秒  ${bytes} 字节  ${lines} 行`);
	console.log(output);
	rows.push(`${call}\t${seconds}\t${bytes}\t${lines}`);
}
console.log("=== 汇总（调用 / 秒 / 字节 / 行）");
for (const row of rows) console.log(row);
