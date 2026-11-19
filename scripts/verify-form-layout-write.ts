/**
 * S42 批 2、批 3 的真机尺子：用已发布写探针 FormLayoutWriteProbe 改一张单据的布局、操作和插件，量每一步多久、看出来的差异对不对。
 *
 * 用法：
 *   node --experimental-strip-types scripts/verify-form-layout-write.ts <工程目录> <布局标识> <改动清单文件>
 *   node --experimental-strip-types scripts/verify-form-layout-write.ts <工程目录> <布局标识> --restore <备份目录>
 *   上面两种再加 --apply：先 dry-run 一次，拿它报的改前快照和写入目标当作「用户已确认」，再真落库
 *   再加 --run "<run 参数>"：改之前、落库之后在同一个常驻进程里各跑一遍这条 cosmic_run，
 *     看改完同一进程马上读不读得到新的（和会话里改完就验是同一个进程）
 *
 * 不带 --apply 只在内存里改、打差异，不写库。--apply 会改共享元数据：先问用户，由用户自己跑。
 * 备份目录固定在工程的 `.cosmic-ai/s42-layout-backup/<布局>-<时间>`，恢复时把这个目录交给 --restore。
 * 改动清单文件一行一条，写法见探针文件头（set、move、add、remove 四种开头）。样本在 scripts/s42/。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createKernelAdapter } from "../src/agent/tools/kernel-adapter.ts";
import { PRODUCT_ID } from "../src/brand.ts";
import type { ProbeOptions } from "../src/kernel/commands/probe.ts";
import { dataBaseline, declaredTargets } from "../src/kernel/policy/write-plan.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";

const args = process.argv.slice(2);
const [projectRoot, form, third] = args;
const apply = args.includes("--apply");
const restoreAt = args.indexOf("--restore");
const restoreDir = restoreAt >= 0 ? args[restoreAt + 1] : undefined;
const runAt = args.indexOf("--run");
const runArgs = runAt >= 0 ? (args[runAt + 1] ?? "").split(/\s+/).filter(Boolean) : undefined;
const editFile = restoreDir === undefined && third !== undefined && !third.startsWith("--") ? third : undefined;
if (projectRoot === undefined || form === undefined || (editFile === undefined && restoreDir === undefined)) {
	console.error(
		"用法：verify-form-layout-write.ts <工程目录> <布局标识> (<改动清单文件> | --restore <备份目录>) [--apply]",
	);
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

const project = opened.value.handle;
const env: Record<string, string> = {
	LAYOUT_FORM: form,
	...(editFile !== undefined ? { LAYOUT_EDIT: readFileSync(editFile, "utf8") } : {}),
	...(restoreDir !== undefined ? { LAYOUT_RESTORE: restoreDir } : {}),
};

async function run(
	label: string,
	extra: Record<string, string>,
	authorization?: ProbeOptions["writeAuthorization"],
): Promise<string> {
	const started = Date.now();
	const r = await kernel.probe(project, "FormLayoutWriteProbe", {
		env: { ...env, ...extra },
		...(authorization === undefined ? {} : { writeAuthorization: authorization }),
	});
	console.log(`=== ${label}  ${((Date.now() - started) / 1000).toFixed(1)} 秒`);
	if (!r.ok) {
		console.log(JSON.stringify(r.error.toJSON()).slice(0, 6000));
		process.exit(1);
	}
	const output = String((r.value as { output?: string }).output ?? JSON.stringify(r.value).slice(0, 20000));
	console.log(output);
	return output;
}

async function runCommand(label: string): Promise<void> {
	if (runArgs === undefined) return;
	const started = Date.now();
	const r = await kernel.run(project, runArgs, {});
	console.log(`=== run ${label}  ${((Date.now() - started) / 1000).toFixed(1)} 秒`);
	console.log(r.ok ? r.value.output : JSON.stringify(r.error.toJSON()).slice(0, 6000));
}

await runCommand("改之前");
const dry = await run("dry-run", {});
if (!apply) process.exit(0);

const baseline = dataBaseline(dry);
const targets = declaredTargets(dry);
if (baseline === undefined || targets.length === 0) {
	console.log("dry-run 没报改前快照或写入目标，不落库");
	process.exit(1);
}
const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
const backup = join(projectRoot, ".cosmic-ai", "s42-layout-backup", `${form}-${stamp}`);
await run(
	"APPLY",
	{ APPLY: "1", LAYOUT_BACKUP: backup },
	{
		targets,
		rollback: `LAYOUT_RESTORE=${backup}`,
		confirmationId: `s42-${form}-${stamp}`,
		baseline,
	},
);
await runCommand("落库之后");
