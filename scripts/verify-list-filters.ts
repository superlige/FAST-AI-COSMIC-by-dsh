/** 列表筛选字段的真机验收。默认只预演；--apply 须经用户确认。
 * 保存候选、同进程回读、运行列表读取筛选项、finally 恢复并核对备份。
 * node --experimental-strip-types scripts/verify-list-filters.ts <工程目录> [--apply]
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createKernelAdapter } from "../src/agent/tools/kernel-adapter.ts";
import { dataBaseline, declaredTargets } from "../src/kernel/policy/write-plan.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";

const project = process.argv[2];
if (!project || project.startsWith("--")) throw new Error("用法：verify-list-filters.ts <工程目录> [--apply]");
const config = join(homedir(), ".fast-ai-cosmic");
const kernel = createKernelAdapter({
	agentConfigDir: config,
	cacheRoot: join(config, "cache"),
	agentVersion: "0.1.0",
	resources: EMBEDDED_RESOURCES,
});
const opened = await kernel.open(project);
if (!opened.ok) throw new Error(JSON.stringify(opened.error));
const handle = opened.value.handle;
const form = "zlgd_sys_bgjl";
const edit = readFileSync(new URL("./s82/list-filter-fields.txt", import.meta.url), "utf8");
const backup = join(project, ".cosmic-ai", "s42-layout-backup", `s82-${Date.now()}`);
type Authorization = { targets: readonly string[]; rollback: string; confirmationId: string; baseline: string };
async function invoke(label: string, env: Record<string, string>, authorization?: Authorization): Promise<string> {
	const start = Date.now();
	const r = await kernel.probe(handle, env.LAYOUT_NODE ? "FormLayoutProbe" : "FormLayoutWriteProbe", {
		env: { LAYOUT_FORM: form, ...env },
		...(authorization ? { writeAuthorization: authorization } : {}),
	});
	const output = r.ok ? r.value.output : JSON.stringify(r.error);
	console.log(`=== ${label} ${((Date.now() - start) / 1000).toFixed(1)} 秒\n${output}`);
	if (!r.ok || r.value.exitCode !== 0 || /一处都没写|未落库/.test(output)) throw new Error(`${label}失败`);
	return output;
}
async function write(label: string, env: Record<string, string>, dir: string): Promise<void> {
	const dry = await invoke(`${label}预演`, env);
	if (dry.includes("现在和备份一模一样")) return;
	const baseline = dataBaseline(dry);
	const targets = declaredTargets(dry);
	if (!baseline || targets.length === 0) throw new Error("预演缺少快照和写入目标，不执行");
	const output = await invoke(
		label,
		{ ...env, APPLY: "1", LAYOUT_BACKUP: dir },
		{ baseline, targets, rollback: `LAYOUT_RESTORE=${dir}`, confirmationId: `s82-${Date.now()}` },
	);
	if (!output.includes("布局已落库") || !output.includes("库里那份和交上去的一致"))
		throw new Error(`${label}没有确认保存并回读一致`);
}
const readEnv = { LAYOUT_PART: "list", LAYOUT_NODE: "filtergridview,fastsearchgridview" };
async function runtime(label: string): Promise<{ common: number; fast: number }> {
	const r = await kernel.run(handle, ["list", form, "--limit", "1", "--events"], {});
	const output = r.ok ? r.value.output : JSON.stringify(r.error);
	console.log(`=== ${label}\n${output}`);
	const counts = /filterContainerInit\(common=(\d+), fast=(\d+)/.exec(output);
	if (!r.ok || r.value.exitCode !== 0 || !counts) throw new Error("运行列表未取到筛选控件数");
	return { common: Number(counts[1]), fast: Number(counts[2]) };
}
async function restore(before: { common: number; fast: number }): Promise<void> {
	if (!existsSync(join(backup, `${form}.form.json`))) return;
	await write("恢复", { LAYOUT_RESTORE: backup }, `${backup}-before-restore`);
	const check = await invoke("恢复后核对备份", { LAYOUT_RESTORE: backup });
	if (!check.includes("现在和备份一模一样")) throw new Error(`恢复后和备份仍有不同：${backup}`);
	const restored = await invoke("恢复后读取", readEnv);
	if (/zlgd_(status_filter|date_filter|creator_filter|time_search)\s/.test(restored))
		throw new Error("恢复后仍有验收筛选项");
	const counts = await runtime("恢复后打开列表");
	if (counts.common !== before.common || counts.fast !== before.fast) throw new Error("恢复后列表筛选项数不一致");
	console.log(`PASS 恢复后与备份一致；备份 ${backup}`);
}
if (process.argv.includes("--runtime-only")) {
	await runtime("只读打开列表，确认验收能读取筛选项数");
} else if (!process.argv.includes("--apply")) {
	await invoke("候选预演", { LAYOUT_EDIT: edit });
} else {
	const before = await runtime("改前打开列表");
	try {
		await write("写入", { LAYOUT_EDIT: edit }, backup);
		const saved = await invoke("保存后读取", readEnv);
		for (const [key, type] of [
			["zlgd_status_filter", "CommonFilterColumnAp"],
			["zlgd_date_filter", "CommonDateFilterColumnAp"],
			["zlgd_creator_filter", "CommonBaseDataFilterColumnAp"],
			["zlgd_time_search", "FilterColumnAp"],
		]) {
			if (!saved.includes(`${key}  ${type}`)) throw new Error(`未读到 ${key} ${type}`);
		}
		if (
			!/zlgd_status_filter.*ComboItems=/.test(saved) ||
			!/zlgd_date_filter.*DateConst=13,63/.test(saved) ||
			!/zlgd_creator_filter.*BaseEntityId=/.test(saved)
		)
			throw new Error("保存后选项、日期或基础资料设置不完整");
		const after = await runtime("保存后同进程打开列表");
		if (after.common !== before.common + 3 || after.fast !== before.fast + 1)
			throw new Error("列表运行没有加载新增筛选项");
		console.log("PASS 保存、回读与列表加载筛选项");
	} finally {
		await restore(before);
	}
}
