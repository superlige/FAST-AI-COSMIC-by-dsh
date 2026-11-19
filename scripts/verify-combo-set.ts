/**
 * S37 3.5 真机验证：`--set` 把下拉写成显示名时，执行之前就拒绝，拒绝信息里给出存储值；写存储值的照常放行。
 *
 * 用法：
 *   node --experimental-strip-types scripts/verify-combo-set.ts <工程目录> [实体] [单据编号]
 *
 * 实体默认 zlgd_sys_test_bill，单据默认 SYSJC-20260831-0001（和 verify-write-fields.ts 同一张）。
 *
 * 步骤：
 *   0. FieldLimitProbe 列出这张单表头的下拉字段，挑第一个「显示名和存储值不一样」的项。
 *   1. 改数预演写显示名：应在保存之前按入参错退出，信息里有存储值。
 *   2. 改数预演写存储值：照常预演（回滚事务，不落库）。
 *   3. run op save 写显示名：应在保存之前停下（这条要是放过去就真落库，所以放在预演验过之后）。
 *   4. run form 写显示名：这一条 --set 被拒并给存储值（run form 不保存）。
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { createKernelAdapter } from "../src/agent/tools/kernel-adapter.ts";
import { PRODUCT_ID } from "../src/brand.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";

const [projectRoot, entityArg, billnoArg] = process.argv.slice(2);
if (projectRoot === undefined) {
	console.error("用法：verify-combo-set.ts <工程目录> [实体] [单据编号]");
	process.exit(2);
}
const entity = entityArg ?? "zlgd_sys_test_bill";
const billno = billnoArg ?? "SYSJC-20260831-0001";
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

/** 输出里和这次验证有关的行。 */
const RELEVANT = /下拉|显示名|存储值|✗|✘|PROBE-ERR|没有保存|执行 save|--- 执行|改值、保存|setValue|dry-run|预演/;
function show(output: string): void {
	for (const line of output.split(/\r?\n/)) if (RELEVANT.test(line)) console.log(`   ${line.slice(0, 300)}`);
	console.log(`   走到保存了吗：${/执行 save|--- 执行 |改值、保存/.test(output) ? "是" : "否"}`);
}

// ---- 0. 找一个下拉字段
const limits = await kernel.probe(project, "FieldLimitProbe", { env: { LIMIT_ENTITY: entity } });
if (!limits.ok) {
	console.error(JSON.stringify(limits.error.toJSON()).slice(0, 2000));
	process.exit(1);
}
let field: string | undefined;
let stored: string | undefined;
let name: string | undefined;
let header = false;
for (const line of limits.value.output.split(/\r?\n/)) {
	const scope = /\[PROBE\] --- (\S+) ---/.exec(line);
	if (scope !== null) {
		header = scope[1] === entity;
		continue;
	}
	if (!header || !/ComboProp\s+合法值/.test(line)) continue;
	const key = /\[PROBE\]\s+(\S+)/.exec(line)?.[1];
	const items = line.slice(line.indexOf(": ") + 2).split(", ");
	for (const item of items) {
		const eq = item.indexOf("=");
		if (eq <= 0) continue;
		const value = item.slice(0, eq).trim();
		const text = item.slice(eq + 1).trim();
		if (value !== "" && text !== "" && text !== value && !text.includes(",") && text !== "…") {
			field = key;
			stored = value;
			name = text;
			break;
		}
	}
	if (field !== undefined) break;
}
if (field === undefined || stored === undefined || name === undefined) {
	console.error(`${entity} 表头没有找到显示名和存储值不同的下拉字段`);
	process.exit(1);
}
console.log(`== 0. ${entity}.${field}：存储值 ${stored}，显示名「${name}」`);

async function probe(title: string, env: Record<string, string>): Promise<void> {
	const started = Date.now();
	const result = await kernel.probe(project, "DataUpdateProbe", { env });
	console.log(`== ${title}（${Date.now() - started} ms）`);
	if (!result.ok) {
		console.log(`   ${JSON.stringify(result.error.toJSON()).slice(0, 1500)}`);
		return;
	}
	console.log(`   exit ${result.value.exitCode}`);
	show(result.value.output);
}
async function run(title: string, argv: string[]): Promise<void> {
	const started = Date.now();
	const report = await kernel.run(project, argv, {});
	console.log(`== ${title}（${Date.now() - started} ms）`);
	if (!report.ok) {
		console.log(`   ${JSON.stringify(report.error.toJSON()).slice(0, 1500)}`);
		return;
	}
	show(report.value.output ?? "");
}

await probe("1. 改数预演写显示名", { UPD_ENTITY: entity, UPD_NUMBERS: billno, UPD_SET: `${field}=${name}` });
await probe("2. 改数预演写存储值", { UPD_ENTITY: entity, UPD_NUMBERS: billno, UPD_SET: `${field}=${stored}` });
await run("3. run op save 写显示名", ["op", entity, "save", "--billno", billno, "--set", `${field}=${name}`]);
await run("4. run form 写显示名", ["form", entity, "--billno", billno, "--set", `${field}=${name}`, "--show", field]);
process.exit(0);
