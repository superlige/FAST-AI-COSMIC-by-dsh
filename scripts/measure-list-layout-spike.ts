/**
 * S42 §16.8 第 1 条的探路尺子：单据的列表布局长什么样、平台属性清单认不认它的元素、单据布局序列化带不带它。
 *
 * 用法：
 *   node --experimental-strip-types scripts/measure-list-layout-spike.ts <工程目录> [单据标识] [元素,元素]
 *
 * 把 `scripts/s42/ListLayoutSpike.java` 拷进工程的 `.cosmic-ai/probes/`，当临时探针跑，只读。
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createKernelAdapter } from "../src/agent/tools/kernel-adapter.ts";
import { PRODUCT_ID } from "../src/brand.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";

const [projectRoot, form = "zlgd_sys_bgjl", elems = "tblnew,tbldel"] = process.argv.slice(2);
if (projectRoot === undefined) {
	console.error("用法：measure-list-layout-spike.ts <工程目录> [单据标识] [元素,元素]");
	process.exit(2);
}
const probesDir = join(projectRoot, ".cosmic-ai", "probes");
mkdirSync(probesDir, { recursive: true });
copyFileSync(new URL("./s42/ListLayoutSpike.java", import.meta.url), join(probesDir, "ListLayoutSpike.java"));

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
const started = Date.now();
const r = await kernel.probe(opened.value.handle, ".cosmic-ai/probes/ListLayoutSpike.java", {
	env: { SPIKE_FORM: form, SPIKE_ELEM: elems },
});
console.log(`${((Date.now() - started) / 1000).toFixed(1)} 秒`);
if (!r.ok) {
	console.log(JSON.stringify(r.error.toJSON()).slice(0, 3000));
	process.exit(1);
}
console.log(String((r.value as { output?: string }).output ?? ""));
process.exit(0);
