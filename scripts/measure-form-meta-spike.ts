/**
 * S42 批 0 的尺子：平台自带的 AI 设计器服务（bos-designer-ai）在探针进程里能不能跑、返回多大、要多久。
 *
 * 用法：
 *   node --experimental-strip-types scripts/measure-form-meta-spike.ts <工程目录> [单据标识…，默认 zlgd_nbjgjl zlgd_sys_test_bill]
 *
 * 把 `scripts/s42/FormMetaSpike.java` 拷进工程的 `.cosmic-ai/probes/`，当临时探针跑：只读，
 * 过的是和模型同一道临时探针扫描。每张单据跑两遍：一遍取元素属性、预览一次移动，
 * 一遍故意交三个错的改动，看平台预览拦不拦得住。
 * 样本写死的是 zlgd 真机工程的单据和控件标识（`zlgd_ygpt2.0`），换工程要换样本。
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createKernelAdapter } from "../src/agent/tools/kernel-adapter.ts";
import { PRODUCT_ID } from "../src/brand.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";

const [projectRoot, ...picked] = process.argv.slice(2);
if (projectRoot === undefined) {
	console.error("用法：measure-form-meta-spike.ts <工程目录> [单据标识…]");
	process.exit(2);
}

/** 每张单据看哪几个元素的属性、预览哪一次移动。 */
const SAMPLES: Record<string, Record<string, string>> = {
	zlgd_nbjgjl: { SPIKE_ELEM: "zlgd_wtdh,fs_baseinfo", SPIKE_MOVE: "zlgd_wtdh>fs_hideninfo" },
	zlgd_sys_test_bill: { SPIKE_ELEM: "zlgd_wtdh" },
};

const forms = picked.length > 0 ? picked : Object.keys(SAMPLES);
const probesDir = join(projectRoot, ".cosmic-ai", "probes");
mkdirSync(probesDir, { recursive: true });
copyFileSync(new URL("./s42/FormMetaSpike.java", import.meta.url), join(probesDir, "FormMetaSpike.java"));

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

let failed = 0;
for (const form of forms) {
	for (const bad of ["", "1"]) {
		const env: Record<string, string> = { SPIKE_FORM: form, ...(SAMPLES[form] ?? {}) };
		if (bad === "1") Object.assign(env, { SPIKE_BAD: "1", SPIKE_ELEM: "none", SPIKE_MOVE: "" });
		const started = Date.now();
		const r = await kernel.probe(opened.value.handle, ".cosmic-ai/probes/FormMetaSpike.java", { env });
		const seconds = ((Date.now() - started) / 1000).toFixed(1);
		console.log(`\n=== ${form}${bad === "1" ? "（坏操作）" : ""}  ${seconds} 秒`);
		if (!r.ok) {
			failed++;
			console.log(JSON.stringify(r.error.toJSON()).slice(0, 2000));
			continue;
		}
		const output = String((r.value as { output?: string }).output ?? "");
		for (const line of output.split("\n")) {
			if (/耗时|坏操作|预览组|formId=|check\w+=|按复杂度/.test(line)) console.log(line.slice(0, 400));
		}
	}
}
process.exit(failed === 0 ? 0 : 1);
