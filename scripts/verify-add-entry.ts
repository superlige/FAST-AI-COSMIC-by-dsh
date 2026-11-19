/**
 * 真机验证：改动清单里的 `add entry`——在一张单据上加一个普通分录，建出分录面板、工具栏、增行删行按钮和操作，落库时新建业务表（S55）。
 *
 * 用法：
 *   node --experimental-strip-types scripts/verify-add-entry.ts <工程目录> <单据标识> [--steps 步骤,…] [--backup <备份目录>]
 *
 * 步骤（不给 --steps 只跑前两步，都不写库）：
 *   refuse   该拒的五种写法（scripts/s55/layout-edit-entry-wrong.txt）一处都不写、五处都报
 *   dry      预演加分录和两个字段（scripts/s55/layout-edit-entry.txt），报出新建哪张表、或者接着用库里留下的表
 *   apply    真落库：拿预演报的改前快照和写入目标当作「用户已确认」，备份到工程的 .cosmic-ai/s42-layout-backup/
 *   table    查新分录的业务表：平台自带三列加两个字段列
 *   form     免界面开一张新单、第 0 行填值，跑三次：不点操作只有一行（对照），点增行第 1 行出来，点删行第 0 行没了
 *   restore  按 --backup 给的备份目录整份退回（apply 那一步打出的目录）
 *   taken    表被别的单据占着：在 --other <另一张单据> 上加一个和 <单据标识> 现成分录 zlgd_bgentry 同名的分录，要拒并点名占着的那张
 *
 * apply 和 restore 改共享元数据：先问用户。退回只退元数据，业务表 tk_zlgd_s55mx 留在库里；
 * 所以退回之后再跑 dry，报的是「接着用库里已有的表」，这也是要验的一种情况。
 * 清单里的标识是 zlgd_s55mx，换工程要改两份清单；该拒清单里用到这张单据现成的分录 zlgd_bgentry 和面板 advconap。
 * 每步走常驻进程，十几秒到一分钟；常驻没起来时退回冷进程，约两分钟。
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
if (projectRoot === undefined || form === undefined || form.startsWith("--")) {
	console.error(
		"用法：verify-add-entry.ts <工程目录> <单据标识> [--steps refuse,dry,apply,table,form,restore] [--backup <备份目录>]",
	);
	process.exit(2);
}
const steps = (option("--steps") ?? "refuse,dry").split(",");
const ENTRY = "zlgd_s55mx";
const TABLE = `tk_${ENTRY}`;
const sample = (name: string): string => readFileSync(join(import.meta.dirname, "s55", name), "utf8");

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
const RELEVANT =
	/新分录|新建业务表|接着用|处问题|^\s+- 第|分录 zlgd_|tk_zlgd|FId|FEntryId|FSeq|fk_zlgd|save ->|已落库|回读核对|已恢复|断言 \d|PASS|FAIL|只有 \d 行|PROBE-ERR\] /;

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
	for (const line of output.split(/\r?\n/)) if (RELEVANT.test(line)) console.log(`   ${line.slice(0, 260)}`);
	console.log(`   （${name} ${Math.round((Date.now() - started) / 1000)} 秒）`);
	return output;
}

for (const step of steps) {
	if (step === "refuse") {
		console.log("refuse：该拒的五种写法");
		const out = await probe("FormLayoutWriteProbe", {
			LAYOUT_FORM: form,
			LAYOUT_EDIT: sample("layout-edit-entry-wrong.txt"),
		});
		check(out.includes("改动清单有 5 处问题，一处都没写"), "五处都报、一处都没写");
		check(out.includes("加分录用 add entry"), "add EntryAp 指到 add entry");
		check(out.includes("是子分录，到开发平台建"), "放进已有分录里的拒了");
	} else if (step === "taken") {
		console.log("taken：表被别的单据占着");
		const other = option("--other");
		if (other === undefined) {
			check(false, "taken 要带 --other <另一张单据>");
			continue;
		}
		const out = await probe("FormLayoutWriteProbe", {
			LAYOUT_FORM: other,
			LAYOUT_EDIT: "add entry zlgd_bgentry after advconap 占用验证 visible=all lock=none",
		});
		check(out.includes(`表 tk_zlgd_bgentry 已经是 ${form} 的表`), `拒了，点名 ${form}`);
	} else if (step === "dry" || step === "apply") {
		console.log(step === "dry" ? "dry：预演加分录和两个字段" : "apply：先预演，再真落库");
		const env = { LAYOUT_FORM: form, LAYOUT_EDIT: sample("layout-edit-entry.txt") };
		const dry = await probe("FormLayoutWriteProbe", env);
		const fresh = dry.includes(`落库时新建业务表 ${TABLE}`);
		const reused = dry.includes(`接着用库里已有的表 ${TABLE}`);
		check(fresh || reused, fresh ? "报出新建业务表" : reused ? "报出接着用库里已有的表" : "没报新分录的表");
		check(dry.includes(`分录 ${ENTRY}  新增：EntryEntity`), "差异里分录单独一类");
		check(/表 tk_zlgd_s55mx 加列 fk_zlgd_s55qty DECIMAL\(23,2\)/.test(dry), "新字段的列算在新分录的表上");
		if (step === "apply") {
			const baseline = dataBaseline(dry);
			const targets = declaredTargets(dry);
			if (baseline === undefined || targets.length === 0) {
				check(false, "预演没报改前快照或写入目标，不落库");
				continue;
			}
			const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
			const backup = join(projectRoot, ".cosmic-ai", "s42-layout-backup", `${form}-${stamp}`);
			const out = await probe(
				"FormLayoutWriteProbe",
				{ ...env, APPLY: "1", LAYOUT_BACKUP: backup },
				{ targets, rollback: `LAYOUT_RESTORE=${backup}`, confirmationId: `s55-${form}-${stamp}`, baseline },
			);
			check(
				out.includes("回读核对 设计态（开发平台里看到的布局和实体）：库里那份和交上去的一致"),
				`落库并回读一致，备份在 ${backup}`,
			);
		}
	} else if (step === "table") {
		console.log("table：新分录的业务表");
		const out = await probe("DbColumnProbe", { DB_ENTITY: form, DB_TABLE: TABLE });
		for (const column of ["FId", "FEntryId", "FSeq", "fk_zlgd_s55txt", "fk_zlgd_s55qty"]) {
			check(new RegExp(`\\b${column}\\b`).test(out), `有列 ${column}`);
		}
	} else if (step === "form") {
		console.log("form：新单上填第 0 行，不点、点增行、点删行各跑一次");
		const fill = `${ENTRY}[0].zlgd_s55txt=甲;${ENTRY}[0].zlgd_s55qty=3`;
		const filled = [`${ENTRY}[0].zlgd_s55txt=甲`, `${ENTRY}[0].zlgd_s55qty=3`];
		// 不点操作的那次是对照：新单要是本来就带两行，增行那次的断言就什么都没证明。没有的行，断言报「实际=(空)」
		const runs: Array<[string, string | undefined, string[], RegExp]> = [
			[
				"不点操作：只有填的那一行，第 1 行没有",
				undefined,
				[...filled, `${ENTRY}[1].zlgd_s55qty=0`],
				/FAIL field zlgd_s55mx\[1\]\.zlgd_s55qty .*实际=\(空\)/,
			],
			[
				"点增行：第 1 行出来，数量是默认值 0",
				"newentry",
				[...filled, `${ENTRY}[1].zlgd_s55qty=0`],
				/断言 3\/3 通过/,
			],
			[
				"点删行：选中的第 0 行没了",
				"deleteentry",
				[`${ENTRY}[0].zlgd_s55txt=甲`],
				/FAIL field zlgd_s55mx\[0\]\.zlgd_s55txt .*实际=\(空\)/,
			],
		];
		for (const [title, op, expects, want] of runs) {
			const started = Date.now();
			const report = await kernel.run(
				project,
				[
					"form",
					form,
					"--set",
					fill,
					...(op === undefined ? [] : ["--op", `${ENTRY}_${op}`]),
					...expects.flatMap((e) => ["--expect", e]),
				],
				{},
			);
			if (!report.ok) {
				check(false, `${title}：run 被拒 ${report.error.code} ${report.error.message}`);
				continue;
			}
			const output = report.value.output ?? "";
			for (const line of output.split(/\r?\n/)) if (RELEVANT.test(line)) console.log(`   ${line.slice(0, 260)}`);
			check(want.test(output), `${title}（${Math.round((Date.now() - started) / 1000)} 秒）`);
		}
	} else if (step === "restore") {
		console.log("restore：按备份整份退回");
		const backup = option("--backup");
		if (backup === undefined) {
			check(false, "restore 要带 --backup <备份目录>");
			continue;
		}
		const env = { LAYOUT_FORM: form, LAYOUT_RESTORE: backup };
		const dry = await probe("FormLayoutWriteProbe", env);
		const baseline = dataBaseline(dry);
		const targets = declaredTargets(dry);
		if (baseline === undefined || targets.length === 0) {
			check(false, "预演没报改前快照或写入目标，不退回");
			continue;
		}
		const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
		const again = join(projectRoot, ".cosmic-ai", "s42-layout-backup", `${form}-${stamp}`);
		const out = await probe(
			"FormLayoutWriteProbe",
			{ ...env, APPLY: "1", LAYOUT_BACKUP: again },
			{ targets, rollback: `LAYOUT_RESTORE=${again}`, confirmationId: `s55-restore-${form}-${stamp}`, baseline },
		);
		check(out.includes("回读核对 设计态（开发平台里看到的布局和实体）：库里那份和交上去的一致"), "退回并回读一致");
	} else {
		check(false, `不认识的步骤 ${step}`);
	}
}

console.log(failures === 0 ? "全部通过" : `${failures} 项没过`);
process.exit(failures === 0 ? 0 : 1);
