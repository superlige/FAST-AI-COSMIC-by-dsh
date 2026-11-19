/**
 * S42 批 0.2 的尺子：在一张空单据上走一遍「备份 → 内存里改 → 一次保存 → 回读核对 → 从备份文件恢复」，量每段耗时。
 *
 * 用法：
 *   node --experimental-strip-types scripts/measure-form-meta-write-spike.ts <工程目录> <单据标识> [--apply] [--restore <备份文件>]
 *
 * 不带 --apply 只在内存里改、打差异，不写库。带 --apply 真写，写完不管核对结果都从备份文件写回。
 * --restore 只把指定备份写回去（上一次恢复没成功时用；不带 --apply 只看差异）。
 *
 * 写元数据要用户先同意：--apply 之前先问用户，确认范围只有这一张单据。
 * `scripts/s42/FormMetaWriteSpike.java` 以已发布探针的身份跑（这份脚本把它加进内嵌资源），
 * 所以和正式写探针走同一道门：IsvGuard 查本 ISV 和前缀，APPLY 时按确认清单放行，冷进程执行。
 * 备份文件落在工程的 `.cosmic-ai/s42-backup/`。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createKernelAdapter } from "../src/agent/tools/kernel-adapter.ts";
import { PRODUCT_ID } from "../src/brand.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";

const args = process.argv.slice(2);
const [projectRoot, form] = args;
const apply = args.includes("--apply");
const restoreAt = args.indexOf("--restore");
const restoreFile = restoreAt >= 0 ? args[restoreAt + 1] : undefined;
if (projectRoot === undefined || form === undefined || form.startsWith("--")) {
	console.error("用法：measure-form-meta-write-spike.ts <工程目录> <单据标识> [--apply] [--restore <备份文件>]");
	process.exit(2);
}

const spike = readFileSync(new URL("./s42/FormMetaWriteSpike.java", import.meta.url), "utf8");
const agentConfigDir = join(homedir(), `.${PRODUCT_ID}`);
const kernel = createKernelAdapter({
	agentConfigDir,
	cacheRoot: join(agentConfigDir, "cache"),
	agentVersion: "0.1.0",
	resources: [...EMBEDDED_RESOURCES, { relativePath: "probes/FormMetaWriteSpike.java", content: spike }],
});
const opened = await kernel.open(projectRoot);
if (!opened.ok) {
	console.error(JSON.stringify(opened.error.toJSON()));
	process.exit(1);
}

const env: Record<string, string> = {
	SPIKE_FORM: form,
	OUT: join(projectRoot, ".cosmic-ai", "s42-backup"),
	...(apply ? { APPLY: "1" } : {}),
	...(restoreFile !== undefined ? { RESTORE_FILE: restoreFile } : {}),
};
const started = Date.now();
const r = await kernel.probe(opened.value.handle, "FormMetaWriteSpike", {
	env,
	...(apply
		? {
				writeAuthorization: {
					targets: [form, `${form}.${form}`],
					rollback: "探针写完即从 .cosmic-ai/s42-backup/ 下的备份文件写回；失败时用 --restore <备份文件> --apply",
					confirmationId: `s42-batch0.2-${form}`,
				},
			}
		: {}),
});
console.log(`=== ${form}${apply ? "（真写）" : "（只在内存里改）"}  ${((Date.now() - started) / 1000).toFixed(1)} 秒`);
if (!r.ok) {
	console.log(JSON.stringify(r.error.toJSON()).slice(0, 4000));
	process.exit(1);
}
console.log(String((r.value as { output?: string }).output ?? JSON.stringify(r.value).slice(0, 20000)));
