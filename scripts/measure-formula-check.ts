/**
 * S36 批 3 的尺子：公式查不到时说没说清是哪一种、规则表达式写入前有没有被平台判据拦下、
 * 打印试算报错给没给实际输入和相近名字、同一处第二次错时有没有并排两次的输入。
 *
 * 只读和预演：规则写入只跑 dry-run（不给 APPLY），打印只跑 apply 的预演；不落库。
 * 候选和 dump 放在真机工程的 .cosmic-ai/work/s36-batch3/ 下（cosmic 自己的目录）。
 *
 * 用法：node --experimental-strip-types scripts/measure-formula-check.ts <真机工程> [> docs/S36-batch3-check.jsonl]
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compareFormulaErrors, createFormulaErrorLedger, formulaErrorsOf } from "../src/agent/tools/formula-repeat.ts";
import { meta } from "../src/kernel/commands/meta.ts";
import { probe } from "../src/kernel/commands/probe.ts";
import { openProject } from "../src/kernel/open-project.ts";
import { stopServer } from "../src/kernel/probe/server.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";

const projectRoot = process.argv[2];
if (!projectRoot) throw new Error("用法：node --experimental-strip-types scripts/measure-formula-check.ts <真机工程>");
const scratch = mkdtempSync(join(tmpdir(), "cosmic-formula-check-"));
const opened = await openProject({
	projectRoot: resolve(projectRoot),
	agentConfigDir: join(scratch, "agent"),
	cacheRoot: join(scratch, "cache"),
	agentVersion: "s36-batch3-ruler",
	resources: EMBEDDED_RESOURCES,
});
const ctx = opened.ctx;
const bytes = (text: string): number => Buffer.byteLength(text, "utf8");
const emit = (value: object): void => console.log(JSON.stringify(value));
const lines = (text: string, pattern: RegExp): string[] => text.split(/\r?\n/).filter((line) => pattern.test(line));

/** 改前查不到时的整段回答：源码里那一句固定的话（改前版本未入库，按源码确定，没在旧版上重跑）。 */
const OLD_MISS_LINE = "[PROBE] 目录未列出该项；不能据此断言公式引擎不支持，尤其自定义函数可能尚未登记";

/** 3.1：查不到时的分类。expected 为 null 的只记录，不断言。 */
const MISSES = [
	{ id: "print-mul", argv: ["formula", "print", "--name", "MulBasedataInclude"], expected: "other-domain" },
	{ id: "print-concatx", argv: ["formula", "print", "--name", "CONCATX"], expected: "near-name" },
	{ id: "form-concat", argv: ["formula", "form", "--name", "CONCAT"], expected: null },
	{ id: "print-ifnull", argv: ["formula", "print", "--name", "ISNULLX"], expected: null },
	{ id: "form-q-show", argv: ["formula", "form", "--q", "显示"], expected: "other-domain" },
	{ id: "biz-actions-q-show", argv: ["formula", "biz", "--actions", "--q", "显示"], expected: "other-domain" },
	{ id: "form-mulx", argv: ["formula", "form", "--name", "MulBasedataIncludeX"], expected: "near-name" },
	{ id: "form-none", argv: ["formula", "form", "--name", "NoSuchFuncS36"], expected: "not-listed" },
	{ id: "print-none", argv: ["formula", "print", "--name", "NoSuchFuncS36"], expected: "builtin-only" },
] as const;

/** 误报尺子：既有规则全过一遍，数没过核对的。两张检测单的表单布局 + 字段最多的 10 张单据。 */
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

/** 3.2：写入前核对。界面规则落在 zlgd_wtd_xnl，业务规则落在 zlgd_qty_wtd；全部 dry-run。 */
const FORM_BASE = { RULE_FORM: "zlgd_wtd_xnl", RULE_TAG: "S36核对-", RULE_ALLOW_OVERLAP: "1" };
const group = (condition: string): string => `核对|${condition}|zlgd_bz`;
const FORM_GATES = [
	{ id: "form-parse", env: { RULE_GROUPS: group("zlgd_wtlx == '炉前成分'") }, blocked: true },
	{
		id: "form-func",
		env: { RULE_GROUPS: group("MulBasedataIncludeX(zlgd_jcxm_list.number, 'JCXM-JX01-012')") },
		blocked: true,
	},
	{
		id: "form-func-case",
		env: { RULE_GROUPS: group("mulbasedatainclude(zlgd_jcxm_list.number, 'JCXM-JX01-012')") },
		blocked: true,
	},
	{ id: "form-field", env: { RULE_GROUPS: group("zlgd_wtlx1 = '炉前成分'") }, blocked: true },
	{
		id: "form-ok",
		env: {
			RULE_GROUPS: group("zlgd_wtlx = '炉前成分' and MulBasedataInclude(zlgd_jcxm_list.number, 'JCXM-JX01-012')"),
		},
		blocked: false,
	},
	// 改前的样子：跳过这一关，平台自己的构建和序列化照样放过写错的函数名
	{
		id: "form-func-unchecked",
		env: {
			RULE_GROUPS: group("MulBasedataIncludeX(zlgd_jcxm_list.number, 'JCXM-JX01-012')"),
			EXPR_CHECK: "0",
		},
		blocked: false,
	},
	// 3.3：同一处第二次语法错，错处没改
	{ id: "form-parse-again", env: { RULE_GROUPS: group("zlgd_wtlx == '原辅材料'") }, blocked: true },
] as const;
const BIZ_BASE = { BIZ_ENTITY: "zlgd_qty_wtd", BIZ_HOST: "zlgd_qty_wtd", BIZ_TAG: "S36核对-", BIZ_NAME: "核对" };
const BIZ_GATES = [
	{ id: "biz-parse", env: { BIZ_CONDITION: "zlgd_wtlx = '炉前成分' and", BIZ_TRUE: "clear:zlgd_bz" }, blocked: true },
	{
		id: "biz-formula-func",
		env: { BIZ_CONDITION: "zlgd_wtlx = '炉前成分'", BIZ_TRUE: "formula:zlgd_bz = CONCATX(zlgd_wtlx, '-')" },
		blocked: true,
	},
	{
		id: "biz-ok",
		env: { BIZ_CONDITION: "zlgd_wtlx = '炉前成分'", BIZ_TRUE: "formula:zlgd_bz = zlgd_wtlx" },
		blocked: false,
	},
] as const;

const PRINT_TPL = "zlgd_sys_test_bill_prtpl_20";
const PRINT_CELL = "LayoutCell13";
const PRINT_TRIES = ["CONCATX('a','b')", "CONCAT_X('a','b')"] as const;

emit({ kind: "ruler", version: "s36-formula-check-v1", runtimeKeyId: ctx.runtimeKeyId });
const ledger = createFormulaErrorLedger();
try {
	for (const q of MISSES) {
		const started = Date.now();
		const result = await meta(ctx, q.argv);
		if (!result.ok || result.value.kind !== "probe" || result.value.probe?.exitCode !== 0)
			throw new Error(`${q.id}: ${result.ok ? "探针未成功" : result.error.message}`);
		const miss = result.value.probe.json.records.find((record) => record.t === "formula-miss");
		// 只记录的样本可能本来就查得到（例如 CONCAT 两边目录都有），照实记「查到」
		if (!miss && q.expected !== null) throw new Error(`${q.id}: 没有查不到的分类`);
		if (miss && q.expected !== null && miss.reason !== q.expected)
			throw new Error(`${q.id}: 期望 ${q.expected}，实际 ${String(miss.reason)}`);
		const said = lines(result.value.text, /查不到|有 \d+ 条/);
		emit({
			kind: "miss",
			id: q.id,
			argv: q.argv,
			ms: Date.now() - started,
			reason: miss?.reason ?? "found",
			near: miss?.near ?? [],
			elsewhere: miss?.elsewhere ?? [],
			gaps: miss?.gaps ?? [],
			said,
			saidBytes: bytes(said.join("\n")),
			oldBytes: bytes(OLD_MISS_LINE),
		});
	}

	for (const layout of LAYOUTS) {
		const started = Date.now();
		const result = await probe(ctx, "FormRuleProbe", { env: { RULE_FORM: layout } });
		const text = result.ok ? result.value.output : result.error.message;
		const total = /界面规则合计 (\d+) 条/.exec(text)?.[1];
		emit({
			kind: "existing-form",
			id: layout,
			ms: Date.now() - started,
			ok: result.ok && result.value.exitCode === 0,
			rules: total === undefined ? null : Number(total),
			conditions: lines(text, /生效条件 /).length,
			failed: lines(text, /✗ /),
			details: lines(text, /平台解析不过|不在当前环境|登记名是|不在单据/),
			unchecked: lines(text, /\] {3}\? |\s\? /),
		});
	}
	for (const entity of ENTITIES) {
		const started = Date.now();
		const result = await probe(ctx, "BizRuleProbe", { env: { BIZ_ENTITY: entity } });
		const text = result.ok ? result.value.output : result.error.message;
		const total = /业务规则=(\d+)/.exec(text)?.[1];
		emit({
			kind: "existing-biz",
			id: entity,
			ms: Date.now() - started,
			ok: result.ok && result.value.exitCode === 0,
			rules: total === undefined ? null : Number(total),
			failed: lines(text, /✗ /),
			details: lines(text, /平台解析不过|不在当前环境|登记名是|不在单据/),
			unchecked: lines(text, /\s\? /),
		});
	}

	const gates = [
		...FORM_GATES.map((gate) => ({ ...gate, probe: "FormRuleProbe", env: { ...FORM_BASE, ...gate.env } })),
		...BIZ_GATES.map((gate) => ({ ...gate, probe: "BizRuleProbe", env: { ...BIZ_BASE, ...gate.env } })),
	];
	for (const gate of gates) {
		const started = Date.now();
		const result = await probe(ctx, gate.probe, { env: gate.env });
		if (!result.ok) throw new Error(`${gate.id}: ${result.error.message}`);
		const text = result.value.output;
		const stopped = text.includes("未写入：");
		const finished = text.includes("dry-run 结束");
		if (stopped !== gate.blocked || (!gate.blocked && !finished))
			throw new Error(
				`${gate.id}: 期望${gate.blocked ? "拦下" : "走到 dry-run 结束"}，实际没有\n${text.slice(-1500)}`,
			);
		const errors = formulaErrorsOf(result.value);
		emit({
			kind: "gate",
			id: gate.id,
			probe: gate.probe,
			env: gate.env,
			ms: Date.now() - started,
			exitCode: result.value.exitCode,
			stopped,
			finished,
			said: lines(text, /✗ |平台解析不过|不在当前环境|登记名是|不在单据|未写入|EXPR_CHECK=0/),
			errors,
			repeat: compareFormulaErrors(ledger, errors),
		});
	}

	// 每次一个新目录：候选目录里已有候选时 --open 会拒绝
	const base = `.cosmic-ai/work/s36-batch3/${String(Date.now())}`;
	const dump = await meta(ctx, ["ptpl", "dump", PRINT_TPL, "--out", `${base}/dump`]);
	if (!dump.ok) throw new Error(`dump: ${dump.error.message}`);
	for (const [index, line] of PRINT_TRIES.entries()) {
		const dir = `${base}/cand${String(index + 1)}`;
		const openedCand = await meta(ctx, ["ptpl", "edit", dir, "--open", `${base}/dump`]);
		if (!openedCand.ok) throw new Error(`open: ${openedCand.error.message}`);
		const edited = await meta(ctx, ["ptpl", "edit", dir, "--formula", PRINT_CELL, "--line", line]);
		if (!edited.ok) throw new Error(`edit: ${edited.error.message}`);
		const status = await meta(ctx, ["ptpl", "edit", dir, "--status"]);
		const handback = status.ok
			? /meta ptpl apply (\S+) --file (\S+) --locale (\S+)/.exec(status.value.text ?? "")
			: null;
		if (!handback) throw new Error("没找到交回命令");
		const started = Date.now();
		const applied = await meta(ctx, [
			"ptpl",
			"apply",
			PRINT_TPL,
			"--file",
			handback[2] as string,
			"--locale",
			handback[3] as string,
			"--backup",
			`${base}/backup${String(index + 1)}`,
		]);
		if (!applied.ok) throw new Error(`apply: ${applied.error.message}`);
		const text = applied.value.kind === "probe" ? (applied.value.probe?.output ?? "") : "";
		const errors = formulaErrorsOf(applied.value);
		emit({
			kind: "print",
			id: `print-try-${String(index + 1)}`,
			line,
			ms: Date.now() - started,
			exitCode: applied.value.kind === "probe" ? applied.value.probe?.exitCode : null,
			said: lines(text, /✗ |平台报错|交给校验器|未落库/),
			errors,
			repeat: compareFormulaErrors(ledger, errors),
		});
	}
} finally {
	await stopServer(ctx);
}
