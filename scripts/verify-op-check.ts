/**
 * 真机验证：布局写探针的必录条件（set <字段>.MustInputCondition=）和操作上的合法性校验（add check）。
 *
 *   node --experimental-strip-types scripts/verify-op-check.ts <工程目录> <单据标识> --edit <改动清单文件> [--steps dry,apply,read,restore] [--backup <备份目录>]
 *
 * dry 只预演；apply 先预演再真落库（备份放在工程的 .cosmic-ai/s42-layout-backup/ 下，打印出目录）；
 * read 用 OpMetaProbe、MustInputProbe 读回；restore 用 --backup 给的目录退回。默认只跑 dry。
 * 样例清单 scripts/s83/must-and-check.txt 用的是调试工程委托单的字段，换单据要换清单。
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
const [projectRoot, form] = args;
const option = (name: string): string | undefined => {
	const at = args.indexOf(name);
	return at >= 0 ? args[at + 1] : undefined;
};
const editFile = option("--edit");
if (projectRoot === undefined || form === undefined || form.startsWith("--") || editFile === undefined) {
	console.error(
		"用法：verify-op-check.ts <工程目录> <单据标识> --edit <改动清单文件> [--steps dry,apply,read,restore] [--backup <备份目录>]",
	);
	process.exit(2);
}
const steps = (option("--steps") ?? "dry").split(",");
const edit = readFileSync(editFile, "utf8").trim();

const agentConfigDir = process.env.COSMIC_AGENT_DIR ?? join(homedir(), `.${PRODUCT_ID}`);
const kernel = createKernelAdapter({
	agentConfigDir,
	cacheRoot: process.env.COSMIC_CACHE_ROOT ?? join(agentConfigDir, "cache"),
	agentVersion: "0.1.0",
	resources: EMBEDDED_RESOURCES,
});
const opened = await kernel.open(projectRoot);
if (!opened.ok) {
	console.error(JSON.stringify(opened.error.toJSON()));
	process.exit(1);
}
const project = opened.value.handle;
let failures = 0;
const check = (ok: boolean, what: string): void => {
	console.log(`   ${ok ? "✔" : "✘"} ${what}`);
	if (!ok) failures++;
};
const RELEVANT = /处问题|^\s+- 第|校验|必录|MustInput|已落库|回读核对|写了一半|派生布局|mustinput|PROBE-ERR\] /;

async function probe(
	name: string,
	env: Record<string, string>,
	authorization?: ProbeOptions["writeAuthorization"],
): Promise<string> {
	const started = Date.now();
	const r = await kernel.probe(project, name, {
		env,
		...(authorization === undefined ? {} : { writeAuthorization: authorization }),
	});
	const output = r.ok
		? String((r.value as { output?: string }).output ?? JSON.stringify(r.value))
		: JSON.stringify(r.error.toJSON());
	for (const line of output.split(/\r?\n/)) if (RELEVANT.test(line)) console.log(`   ${line.slice(0, 300)}`);
	console.log(`   （${name} ${Math.round((Date.now() - started) / 1000)} 秒）`);
	return output;
}

async function write(env: Record<string, string>, label: string): Promise<void> {
	const dry = await probe("FormLayoutWriteProbe", env);
	const baseline = dataBaseline(dry);
	const targets = declaredTargets(dry);
	if (baseline === undefined || targets.length === 0) {
		check(false, "预演没报改前快照或写入目标，不落库");
		return;
	}
	const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
	const backup = join(projectRoot as string, ".cosmic-ai", "s42-layout-backup", `${form}-${stamp}`);
	const out = await probe(
		"FormLayoutWriteProbe",
		{ ...env, APPLY: "1", LAYOUT_BACKUP: backup },
		{ targets, rollback: `LAYOUT_RESTORE=${backup}`, confirmationId: `s83-${label}-${form}-${stamp}`, baseline },
	);
	check(
		out.includes("回读核对 设计态（开发平台里看到的布局和实体）：库里那份和交上去的一致"),
		`${label}：落库并回读一致，改前备份在 ${backup}`,
	);
}

for (const step of steps) {
	if (step === "dry") {
		console.log("dry：预演");
		const out = await probe("FormLayoutWriteProbe", { LAYOUT_FORM: form, LAYOUT_EDIT: edit });
		check(out.includes("dry-run 结束，数据库未修改"), "预演通过");
	} else if (step === "apply") {
		console.log("apply：先预演，再真落库");
		await write({ LAYOUT_FORM: form, LAYOUT_EDIT: edit }, "apply");
	} else if (step === "read") {
		console.log("read：读回操作上的校验和必录条件");
		const ops = [...edit.matchAll(/^add check (\S+) /gm)].map((m) => m[1] as string);
		if (ops.length > 0) await probe("OpMetaProbe", { OP_ENTITY: form, OP_FOCUS: [...new Set(ops)].join(",") });
		await probe("MustInputProbe", { META_ENTITY: form });
	} else if (step === "restore") {
		const backup = option("--backup");
		if (backup === undefined) {
			check(false, "restore 要给 --backup <备份目录>");
			continue;
		}
		console.log(`restore：用 ${backup} 退回`);
		await write({ LAYOUT_FORM: form, LAYOUT_RESTORE: backup }, "restore");
	} else {
		check(false, `不认识的步骤 ${step}`);
	}
}

console.log(failures === 0 ? "全部通过" : `${failures} 项没过`);
process.exit(failures === 0 ? 0 : 1);
