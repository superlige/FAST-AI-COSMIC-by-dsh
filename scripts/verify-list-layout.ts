/**
 * 列表字段和工具栏真机验收。默认仅预演；--apply 必须得到用户同意后使用。
 * 保存候选 → 同进程读取列和按钮 → 打开列表确认列 → finally 用备份恢复 → 确认与备份相同。
 * node --experimental-strip-types scripts/verify-list-layout.ts <工程目录> [--apply]
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createKernelAdapter } from "../src/agent/tools/kernel-adapter.ts";
import { dataBaseline, declaredTargets } from "../src/kernel/policy/write-plan.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";

const project = process.argv[2];
if (!project || project.startsWith("--")) throw new Error("用法：verify-list-layout.ts <工程目录> [--apply]");
const config = join(homedir(), ".fast-ai-cosmic");
const kernel = createKernelAdapter({
	agentConfigDir: config,
	cacheRoot: join(config, "cache"),
	agentVersion: "0.1.0",
	resources: EMBEDDED_RESOURCES,
});
const opened = await kernel.open(project);
if (!opened.ok) throw new Error(JSON.stringify(opened.error.toJSON()));
const handle = opened.value.handle;
const form = "zlgd_sys_bgjl";
const edit = readFileSync(new URL("./s81/list-columns-and-toolbar.txt", import.meta.url), "utf8");
const backup = join(project, ".cosmic-ai", "s42-layout-backup", `s81-${Date.now()}`);

async function invoke(
	label: string,
	env: Record<string, string>,
	authorization?: { targets: readonly string[]; rollback: string; confirmationId: string; baseline: string },
): Promise<string> {
	const start = Date.now();
	const r = await kernel.probe(
		handle,
		label === "读取" || label === "恢复后读取" ? "FormLayoutProbe" : "FormLayoutWriteProbe",
		{ env: { LAYOUT_FORM: form, ...env }, ...(authorization ? { writeAuthorization: authorization } : {}) },
	);
	const output = r.ok ? r.value.output : `${r.error.code}: ${r.error.message}\n${JSON.stringify(r.error.detail)}`;
	console.log(`=== ${label} ${((Date.now() - start) / 1000).toFixed(1)} 秒\n${output}`);
	if (!r.ok || r.value.exitCode !== 0) throw new Error(`${label}失败，详见上方输出`);
	return output;
}
async function write(label: string, env: Record<string, string>, backupDir: string): Promise<string> {
	const dry = await invoke(`${label}预演`, env);
	if (dry.includes("现在和备份一模一样")) return dry;
	const baseline = dataBaseline(dry);
	const targets = declaredTargets(dry);
	if (!baseline || targets.length === 0) throw new Error("预演未给出快照和写入目标，不执行");
	const result = await invoke(
		label,
		{ ...env, APPLY: "1", LAYOUT_BACKUP: backupDir },
		{ baseline, targets, rollback: `LAYOUT_RESTORE=${backupDir}`, confirmationId: `s81-${Date.now()}` },
	);
	if (!result.includes("布局已落库") || !result.includes("库里那份和交上去的一致"))
		throw new Error(`${label}未确认保存且回读一致`);
	return result;
}
const readEnv = {
	LAYOUT_PART: "list",
	LAYOUT_NODE: "gridview,_toolbar_",
	LAYOUT_PROPS: "zlgd_list_verify_btn",
	LAYOUT_ONLY_PROPS: "OperationKey",
};
async function restore(): Promise<void> {
	if (!existsSync(join(backup, `${form}.form.json`))) return;
	await write("恢复", { LAYOUT_RESTORE: backup }, `${backup}-before-restore`);
	const check = await invoke("恢复后核对备份", { LAYOUT_RESTORE: backup });
	if (!check.includes("现在和备份一模一样")) throw new Error(`恢复后仍和备份不同：${backup}`);
	const restored = await invoke("恢复后读取", readEnv);
	if (/createtime\s+DateListColumnAp|zlgd_list_verify_btn\s+BarItemAp/.test(restored))
		throw new Error("恢复后仍读到验收列或按钮");
	console.log(`PASS 恢复后与备份一致；备份保留在 ${backup}`);
}
if (!process.argv.includes("--apply")) {
	await invoke("候选预演", { LAYOUT_EDIT: edit });
} else {
	const before = await kernel.run(handle, ["list", form, "--limit", "1"], {});
	const beforeText = before.ok ? before.value.output : JSON.stringify(before.error.toJSON());
	console.log(`=== 改前打开列表\n${beforeText}`);
	const columnLine = /列定义[^\n]*\n\[PROBE\]\s+([^\r\n]+)/.exec(beforeText)?.[1];
	if (!before.ok || before.value.exitCode !== 0 || !columnLine || /…/.test(columnLine))
		throw new Error("取不到完整的改前列表列，不写入");
	const columns = `${columnLine
		.split(" / ")
		.map((key) => key.trim())
		.join(",")},createtime`;
	try {
		await write("写入", { LAYOUT_EDIT: edit }, backup);
		const saved = await invoke("读取", readEnv);
		if (
			!/createtime\s+DateListColumnAp/.test(saved) ||
			!/zlgd_list_verify_btn.*OperationKey.*当前=zlgd_list_verify/.test(saved)
		)
			throw new Error("未读到新增列或按钮绑定");
		const start = Date.now();
		const runtime = await kernel.run(handle, ["list", form, "--limit", "1", "--expect", `columns=${columns}`], {});
		const text = runtime.ok ? runtime.value.output : JSON.stringify(runtime.error.toJSON());
		console.log(`=== 打开列表 ${((Date.now() - start) / 1000).toFixed(1)} 秒\n${text}`);
		if (!runtime.ok || runtime.value.exitCode !== 0 || !/断言 1\/1 通过/.test(text))
			throw new Error("列表运行断言未通过，详见上方输出");
	} finally {
		await restore();
	}
}
