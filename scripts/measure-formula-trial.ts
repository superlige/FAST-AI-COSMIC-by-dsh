/**
 * S36 批 5 的尺子：三类公式（打印、界面规则、业务规则）**不落库**时能验到哪一步。
 *
 * 每类按五个层次各给固定样本：解析、函数参数、字段引用、真假分支、实际显示/取值。
 * 全部只跑预演：规则写入不给 APPLY，打印只跑 apply 的预演；不落库、不授权。
 * 候选和 dump 放在真机工程的 .cosmic-ai/work/s36-batch5/ 下（cosmic 自己的目录）。
 *
 * 改前改后用同一批入参跑：改前不认识的试算入参（RULE_SET、--pk）原样带上，
 * 照实记下它们有没有起作用，不另编一套改前入参。
 * v2 只把试算字段值的入参名从占位的 TRY_SET 改成实际实现的 RULE_SET：改前两个名字探针都不认识，
 * 都在进 JVM 前被拒（docs/S36-batch5-before.jsonl 是 v1 跑的），其余样本一字未动。
 *
 * 用法：node --experimental-strip-types scripts/measure-formula-trial.ts <真机工程> [--skip-existing] [--raw <目录>] [> docs/S36-batch5-after.jsonl]
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { meta } from "../src/kernel/commands/meta.ts";
import { probe } from "../src/kernel/commands/probe.ts";
import { run } from "../src/kernel/commands/run.ts";
import { openProject } from "../src/kernel/open-project.ts";
import { stopServer } from "../src/kernel/probe/server.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";

const projectRoot = process.argv[2];
if (!projectRoot) throw new Error("用法：node --experimental-strip-types scripts/measure-formula-trial.ts <真机工程>");
const scratch = mkdtempSync(join(tmpdir(), "cosmic-formula-trial-"));
const opened = await openProject({
	projectRoot: resolve(projectRoot),
	agentConfigDir: join(scratch, "agent"),
	cacheRoot: join(scratch, "cache"),
	agentVersion: "s36-batch5-ruler",
	resources: EMBEDDED_RESOURCES,
});
const ctx = opened.ctx;
const bytes = (text: string): number => Buffer.byteLength(text, "utf8");
const emit = (value: object): void => console.log(JSON.stringify(value));
const lines = (text: string, pattern: RegExp): string[] => text.split(/\r?\n/).filter((line) => pattern.test(line));
/** --raw <目录>：每个样本的完整输出另存一份，只供人看，不进 jsonl。 */
const rawAt = process.argv.indexOf("--raw");
const rawDir = rawAt > 0 ? process.argv[rawAt + 1] : undefined;
const keepRaw = (id: string, text: string): void => {
	if (!rawDir) return;
	mkdirSync(rawDir, { recursive: true });
	writeFileSync(join(rawDir, `${id}.txt`), text);
};

/** 这几行回答「拦没拦住、看没看到结果」；其余是既有的过程输出，只计字节。 */
const SAID =
	/!!|✗|平台报错|平台解析不过|不在当前环境|不在单据|未写入：|未落库|dry-run 结束|公式试算|时显示：|候选试算|条件 ->|可见=|求值失败|执行失败| = /;

type Level = "parse" | "args" | "field" | "branch" | "value";

/**
 * 每次运行一个独有的描述前缀：同一调用失败、输出一字不差时，重复闸门会拦下第二次，
 * 尺子重跑不能被它挡住。前缀只进规则描述，不影响要核对的表达式。
 */
const RUN = Date.now().toString(36);

/** 界面规则：落在 zlgd_wtd_xnl（检验委托单布局），目标字段 zlgd_bz。 */
const FORM_BASE = { RULE_FORM: "zlgd_wtd_xnl", RULE_TAG: `S36试算${RUN}-`, RULE_ALLOW_OVERLAP: "1" };
const group = (condition: string): string => `试算|${condition}|zlgd_bz`;
const FORM = [
	{ id: "form-parse", level: "parse", env: { RULE_GROUPS: group("zlgd_wtlx == '炉前成分'") } },
	{ id: "form-args", level: "args", env: { RULE_GROUPS: group("MulBasedataInclude(zlgd_jcxm_list.number)") } },
	{ id: "form-field", level: "field", env: { RULE_GROUPS: group("zlgd_wtlx1 = '炉前成分'") } },
	{ id: "form-branch-default", level: "branch", env: { RULE_GROUPS: group("zlgd_wtlx = '炉前成分'") } },
	{
		id: "form-branch-true",
		level: "branch",
		env: { RULE_GROUPS: group("zlgd_wtlx = '炉前成分'"), RULE_SET: "zlgd_wtlx=炉前成分" },
	},
	{
		id: "form-value-false",
		level: "value",
		env: { RULE_GROUPS: group("zlgd_wtlx = '炉前成分'"), RULE_SET: "zlgd_wtlx=原辅材料" },
	},
] as const satisfies readonly { id: string; level: Level; env: Record<string, string> }[];

/** 业务规则：落在 zlgd_qty_wtd 表头。 */
const BIZ_BASE = { BIZ_ENTITY: "zlgd_qty_wtd", BIZ_HOST: "zlgd_qty_wtd", BIZ_TAG: `S36试算${RUN}-`, BIZ_NAME: "试算" };
const CONCAT_BZ = "formula:zlgd_bz = CONCAT(zlgd_wtlx, '-A')";
const BIZ = [
	{ id: "biz-parse", level: "parse", env: { BIZ_CONDITION: "zlgd_wtlx = '炉前成分' and", BIZ_TRUE: "clear:zlgd_bz" } },
	{
		id: "biz-args",
		level: "args",
		env: { BIZ_CONDITION: "zlgd_wtlx = '炉前成分'", BIZ_TRUE: "formula:zlgd_bz = IF(zlgd_wtlx = '炉前成分', 'a')" },
	},
	{ id: "biz-field", level: "field", env: { BIZ_CONDITION: "zlgd_wtlx1 = '炉前成分'", BIZ_TRUE: "clear:zlgd_bz" } },
	{
		id: "biz-branch-false",
		level: "branch",
		env: { BIZ_CONDITION: "zlgd_wtlx = '炉前成分'", BIZ_TRUE: CONCAT_BZ, RULE_SET: "zlgd_wtlx=原辅材料" },
	},
	{
		id: "biz-value-true",
		level: "value",
		env: { BIZ_CONDITION: "zlgd_wtlx = '炉前成分'", BIZ_TRUE: CONCAT_BZ, RULE_SET: "zlgd_wtlx=炉前成分" },
	},
] as const satisfies readonly { id: string; level: Level; env: Record<string, string> }[];

/** 打印：模板 zlgd_sys_test_bill_prtpl_20 的 LayoutCell13；真单是 2026-09-28 查到委托单位有值的一张。 */
const PRINT_TPL = "zlgd_sys_test_bill_prtpl_20";
const PRINT_CELL = "LayoutCell13";
const PRINT_BILL = "2575581622195769344";
const PRINT = [
	{ id: "print-parse", level: "parse", line: "CONCAT('a','b'", pk: null },
	{ id: "print-args", level: "args", line: "IF(1=1,'a')", pk: null },
	{ id: "print-field", level: "field", line: "<zlgd_wtdw1>", pk: null },
	{ id: "print-subfield", level: "field", line: "<zlgd_wtdw.nosuchprop>", pk: PRINT_BILL },
	{ id: "print-branch", level: "branch", line: "IF(<zlgd_wtdw>='','无',<zlgd_wtdw>)", pk: null },
	{ id: "print-value", level: "value", line: "IF(<zlgd_wtdw>='','无',<zlgd_wtdw>)", pk: PRINT_BILL },
] as const satisfies readonly { id: string; level: Level; line: string; pk: string | null }[];

/**
 * 误报尺子：既有规则在同一套求值里（新单默认值、不给字段值）有多少条算不出来。
 * 这些规则已经在用，算不出来多半是试算环境缺东西，不是规则写错；数出来才知道「算不出来」能不能当拦截判据。
 * 样本与批 3 误报尺子相同。
 */
const LAYOUTS = [
	"zlgd_wtd_xnl",
	"zlgd_qty_wtd",
	"zlgd_sys_test_bill",
	"zlgd_sys_test_bill_ddl",
	"zlgd_sys_test_bill_fbsy",
	"zlgd_sys_test_bill_hxbsfxysjl",
	"zlgd_sys_test_bill_hxysjl",
	"zlgd_sys_test_bill_jxzyw",
	"zlgd_sys_test_bill_lssyzyw",
	"zlgd_sys_test_bill_lsyd",
	"zlgd_sys_test_bill_wqsy",
	"zlgd_sys_test_bill_wsyd",
	"zlgd_sys_test_bill_ypfc",
	"zlgd_sys_test_btsy",
	"zlgd_sys_test_cbsy",
	"zlgd_sys_test_ccd",
	"zlgd_sys_test_cjsy",
	"zlgd_sys_test_cqfx",
	"zlgd_sys_test_dhcm",
	"zlgd_sys_test_gpfx",
	"zlgd_sys_test_hxfx",
	"zlgd_sys_test_lssy",
	"zlgd_sys_test_plsy",
	"zlgd_sys_test_pmsy",
	"zlgd_sys_test_rbsy",
	"zlgd_sys_test_xwzz",
	"zlgd_sys_test_zdgpfx",
	"zlgd_sys_xbl",
	"zlgd_sysjc_yssy",
	"zlgd_sysjcdjqsy",
	"zlgd_bsyd",
	"zlgd_sys_jsclgpfx",
] as const;
const ENTITIES = [
	"zlgd_sys_test_bill",
	"zlgd_qty_wtd",
	"zlgd_ar_finarbill_mid",
	"zlgd_nbjgjl",
	"zlgd_ar_finarbill_ext",
	"zlgd_sm_delivernotice_ext",
	"zlgd_ap_finapbill_mid",
	"zlgd_sm_salorder_ext",
	"zlgd_gcy_leaveapplication",
	"zlgd_ypwbjgysd",
] as const;
const skipExisting = process.argv.includes("--skip-existing");

emit({ kind: "ruler", version: "s36-formula-trial-v2", runtimeKeyId: ctx.runtimeKeyId });
try {
	const existing = skipExisting
		? []
		: [
				...LAYOUTS.map((target) => ({ kind: "form", target })),
				...ENTITIES.map((target) => ({ kind: "biz", target })),
			];
	for (const one of existing) {
		const started = Date.now();
		// 走 run rule，和模型用的是同一条路；不给 --set，就是新单默认值
		const result = await run(ctx, ["rule", one.kind, one.target]);
		const text = result.ok
			? result.value.output
			: `${result.error.message}
${result.error.remedy}`;
		keepRaw(`existing-${one.kind}-${one.target}`, text);
		const rules =
			one.kind === "form"
				? Number(/界面规则 \S+ Ap=\d+ 规则=(\d+)/.exec(text)?.[1] ?? Number.NaN)
				: [...text.matchAll(/业务规则宿主 \S+ 规则=(\d+)/g)].reduce((sum, m) => sum + Number(m[1]), 0);
		// 同一条规则在对照求值里会再算一遍：按整行去重，只数不同的规则
		const failed = [...new Set(lines(text, /条件求值失败|执行失败|编译失败/).map((line) => line.trim()))];
		emit({
			kind: "existing",
			domain: one.kind,
			id: one.target,
			ms: Date.now() - started,
			ok: result.ok && result.value.exitCode === 0,
			rules: Number.isNaN(rules) ? null : rules,
			failed: failed.map((line) => line.slice(0, 300)),
			error: result.ok ? null : text.slice(0, 600),
		});
	}

	const rules = [
		...FORM.map((one) => ({ ...one, domain: "form", probe: "FormRuleProbe", env: { ...FORM_BASE, ...one.env } })),
		...BIZ.map((one) => ({ ...one, domain: "biz", probe: "BizRuleProbe", env: { ...BIZ_BASE, ...one.env } })),
	];
	for (const one of rules) {
		const started = Date.now();
		const result = await probe(ctx, one.probe, { env: one.env });
		if (!result.ok) {
			// 进 JVM 之前就被拒（例如入参名不认识）：照实记下拒的原因，不算拦住公式
			const said = [result.error.message, JSON.stringify(result.error.detail), result.error.remedy];
			emit({
				kind: "sample",
				id: one.id,
				domain: one.domain,
				level: one.level,
				env: one.env,
				ms: Date.now() - started,
				exitCode: null,
				stopped: false,
				stoppedAt: "precheck",
				dryRunDone: false,
				tried: false,
				said: said.map((line) => line.slice(0, 600)),
				outputBytes: bytes(said.join("\n")),
			});
			continue;
		}
		const text = result.value.output;
		keepRaw(one.id, text);
		emit({
			kind: "sample",
			id: one.id,
			domain: one.domain,
			level: one.level,
			env: one.env,
			ms: Date.now() - started,
			exitCode: result.value.exitCode,
			stopped: text.includes("未写入：") || result.value.exitCode !== 0,
			dryRunDone: text.includes("dry-run 结束"),
			tried: text.includes("候选试算"),
			said: lines(text, SAID),
			outputBytes: bytes(text),
		});
	}

	// 每次一个新目录：候选目录里已有候选时 --open 会拒绝
	const base = `.cosmic-ai/work/s36-batch5/${String(Date.now())}`;
	const dump = await meta(ctx, ["ptpl", "dump", PRINT_TPL, "--out", `${base}/dump`]);
	if (!dump.ok) throw new Error(`dump: ${dump.error.message}`);
	for (const one of PRINT) {
		const dir = `${base}/${one.id}`;
		const openedCand = await meta(ctx, ["ptpl", "edit", dir, "--open", `${base}/dump`]);
		if (!openedCand.ok) throw new Error(`open: ${openedCand.error.message}`);
		const started = Date.now();
		const edited = await meta(ctx, ["ptpl", "edit", dir, "--formula", PRINT_CELL, "--line", one.line]);
		if (!edited.ok) {
			// 编辑那一步就拒了：本地候选没改成，不进 JVM
			emit({
				kind: "sample",
				id: one.id,
				domain: "print",
				level: one.level,
				line: one.line,
				pk: one.pk,
				ms: Date.now() - started,
				exitCode: null,
				stopped: true,
				stoppedAt: "edit",
				dryRunDone: false,
				tried: false,
				said: [edited.error.message],
				outputBytes: bytes(edited.error.message),
			});
			continue;
		}
		const status = await meta(ctx, ["ptpl", "edit", dir, "--status"]);
		const handback = status.ok
			? /meta ptpl apply (\S+) --file (\S+) --locale (\S+)/.exec(status.value.text ?? "")
			: null;
		if (!handback) throw new Error("没找到交回命令");
		const argv = [
			"ptpl",
			"apply",
			PRINT_TPL,
			"--file",
			handback[2] as string,
			"--locale",
			handback[3] as string,
			"--backup",
			`${base}/${one.id}-backup`,
			...(one.pk === null ? [] : ["--pk", one.pk]),
		];
		const applied = await meta(ctx, argv);
		const text = applied.ok
			? applied.value.kind === "probe"
				? (applied.value.probe?.output ?? "")
				: (applied.value.text ?? "")
			: applied.error.message;
		keepRaw(one.id, text);
		emit({
			kind: "sample",
			id: one.id,
			domain: "print",
			level: one.level,
			line: one.line,
			pk: one.pk,
			ms: Date.now() - started,
			exitCode: applied.ok && applied.value.kind === "probe" ? (applied.value.probe?.exitCode ?? null) : null,
			// 拦下那行是「未落库：……」；候选预览的抬头里也有「模板未落库」，只认带冒号的
			stopped: /未落库：/.test(text),
			stoppedAt: /未落库：/.test(text) ? "apply-dry-run" : null,
			dryRunDone: /dry-run 结束/.test(text),
			tried: text.includes("候选预览"),
			said: lines(text, SAID),
			outputBytes: bytes(text),
		});
	}
} finally {
	await stopServer(ctx);
}
