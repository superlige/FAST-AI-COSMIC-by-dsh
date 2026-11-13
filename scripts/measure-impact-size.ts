/**
 * 查类、查单据、查布局时，`cosmic_impact` 的答案有多大、五样齐不齐（S17 批 6 的尺子）。
 *
 *   node --experimental-strip-types scripts/measure-impact-size.ts <工程目录> [--json] [--show <词>]
 *
 * 读工程里已建好的代码关系表，用和 `cosmic_impact` 同一个查询函数出答案。不连环境、不重建、不改任何东西。
 *
 * 样本（2026-10-04 固定）：
 *   原样    真机会话 09-14～10-02 里模型主动查的 31 次，词和 dynamic 原样（去重后 30 组）；
 *   插件    其中出现过的 17 个类，逐个单查；
 *   单据    其中出现过的 7 个单据标识，逐个单查；
 *   布局    其中出现过的 2 个布局标识，外加 1 个已删的布局（应当说认不出），逐个单查；
 *   模板    其中出现过的 3 个打印模板编码，逐个单查。
 *
 * 口径：
 *   字节      答案正文（text）的 UTF-8 字节；超过 4,000 字节的进上下文时会被截中段（工具的输出预算）。
 *   认出      这个词没进"没认出"。
 *   快照      第一行写了快照日期。
 *   挂在哪    插件：每条登记（表单写布局号、其余写单据）都在答案里出现；单据、布局：登记在它上面的本工程插件，答案里点到名字或给了个数。
 *   写了什么  插件自己（含经工具类）写的本 ISV 字段有几个（按标识去重），答案里出现了几个。
 *   同字段    插件写的本 ISV 字段里，另有别的类也写同名字段的有几个（按名字，上限口径），答案里点到了几个。
 *   牵连对象  答案里有"牵连的元数据对象"那一行。
 * 目标（S17 6.4）：单个插件 ≤ 1,500 字节，整张单据 ≤ 3,000 字节，原样 30 组都不被截。
 */
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadIndex, queryImpact } from "../src/kernel/commands/impact.ts";
import type { ImpactIndex, SrcRef } from "../src/kernel/impact/model.ts";
import { openProject } from "../src/kernel/open-project.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";

const VERSION = "s17-impact-size-v1";

/** 真机会话里的原样查询（scripts/measure-index-usage.mjs 同一批会话，按时间）。 */
const REPLAY: { terms: string[]; dynamic?: boolean }[] = [
	{ terms: ["zlgd.zljy.service.JgfsRuleService", "zlgd_wtd_xnl", "zlgd_jgfs_head", "zlgd_jgfs"] },
	{ terms: ["zlgd_bzwz_wl"], dynamic: true },
	{ terms: ["zlgd_jcjl", "zlgd_ddlac", "tk_zlgd_jyjl"] },
	{ terms: ["zlgd_bzwz_wl"] },
	{ terms: ["zlgd.ygpt.workflow.JointAuditRolePlugin", "zlgd.ygwc.workflow.general.GeneralWorkFlowPlugin"] },
	{
		terms: [
			"zlgd.ygpt.workflow.ApplyWorkFlowPlugin",
			"zlgd.ygpt.workflow.QualityObjectionFeedbackWorkFLowPlugin",
			"zlgd.masm.plugin.workflow.ReplyRejectionMessageWorkFlow",
			"zlgd.ygwc.workflow.feedback.FeedBackWorkFlowPlugin",
			"zlgd.ygwc.workflow.filing.FilingFlowPlugin",
			"zlgd.ygwc.workflow.xssalorder.XssalorderWorkFlowPlugin",
		],
	},
	{ terms: ["TestBillLSSYFormPlugin", "zlgd_sys_test_lssy", "zlgd_nz_ls", "zlgd_rz_ls"] },
	{ terms: ["TestBillLSSYFormPlugin", "zlgd_qzxy", "zlgd_lssy_qzxy"], dynamic: true },
	{ terms: ["TestBillLSSYFormPlugin", "zlgd_nz_ls3"], dynamic: true },
	{ terms: ["zlgd_nz_ls", "zlgd_rz_ls", "TestBillLSSYFormPlugin"], dynamic: true },
	{ terms: ["zlgd_sys_test_lssy", "zlgd_sys_test_bill", "zlgd_entryentity_lssy", "TestBillLSSYFormPlugin"] },
	{ terms: ["TestBillLSSYFormPlugin", "zlgd_klqd_kysjl", "zlgd_sys_test_bill"] },
	{ terms: ["zlgd.zljy.formplugin.TestBillLSSYFormPlugin", "zlgd_lsxypz", "zlgd_lssy_qzxy"] },
	{ terms: ["EntrustStatusChangeOpPlugin", "zlgd_syrdz", "zlgd_sys_test_bill.creator"] },
	{ terms: ["zlgd_sys_test_bill_jxzyw", "TestBillOpPlugin", "GetAuditorPrintPlugin"] },
	{ terms: ["zlgd_sys_test_bill_prtpl_15", "zlgd_bsydinfo", "zlgd_sf1", "BsydbzkcsjlPrintPlugin"] },
	{ terms: ["QTYXNLWTDFormPlugin"] },
	{
		terms: [
			"zlgd_sys_test_bill_jxzyw",
			"jxzyw_source_type_loader",
			"jxzyw_coating_solution_loader",
			"jxzyw_img_loader_subdatagrid_rrJ9GfSb1M",
		],
	},
	{ terms: ["zlgd_lch", "zlgd_ypph", "zlgd_sys_test_bill_prtpl_62", "zlgd_sys_test_bill_prtpl_58"] },
	{ terms: ["zlgd_wsydbzk_csjl"] },
	{ terms: ["SysTestImagePagePrintPlugin"] },
	{ terms: ["IntergranularCorrosionDeepPrintPlugin", "SysJcdJxsyPrintPlugin", "SysJcdJxsyLowMagPrintPlugin"] },
	{ terms: ["zlgd_report_copies", "XnlPrintTplFormPlugin", "PARAM_REPORT_COPIES"], dynamic: true },
	{ terms: ["zlgd.zljy.printplugin.MetallographicBilingualPrintPlugin"] },
	{ terms: ["zlgd.zljy.printplugin.EnglishPrintPlugin"] },
	{
		terms: ["QTWWTDTransPlugin", "zlgd_zyrq_m", "zlgd_zyrq", "zlgd_syentry.zlgd_jgfs", "zlgd_nbjgjl.zlgd_datefield2"],
	},
	{ terms: ["SysTestImagePagePrintPlugin"] },
	{
		terms: [
			"zlgd_sys_test_bill_prtpl_jjfswl",
			"IntergranularCorrosionDeepPrintPlugin",
			"zlgd_qty_wtd",
			"zlgd_nbjgjl",
		],
	},
	{ terms: ["IntergranularCorrosionDeepPrintPlugin"] },
	{ terms: ["zlgd_snapshot", "zlgd_unauditor", "zlgd_finishtime", "zlgd_testbill_id"] },
];

const SINGLES: Record<string, string[]> = {
	插件: [
		"zlgd.zljy.service.JgfsRuleService",
		"JointAuditRolePlugin",
		"GeneralWorkFlowPlugin",
		"ApplyWorkFlowPlugin",
		"TestBillLSSYFormPlugin",
		"EntrustStatusChangeOpPlugin",
		"TestBillOpPlugin",
		"GetAuditorPrintPlugin",
		"BsydbzkcsjlPrintPlugin",
		"QTYXNLWTDFormPlugin",
		"SysTestImagePagePrintPlugin",
		"IntergranularCorrosionDeepPrintPlugin",
		"SysJcdJxsyPrintPlugin",
		"XnlPrintTplFormPlugin",
		"MetallographicBilingualPrintPlugin",
		"EnglishPrintPlugin",
		"QTWWTDTransPlugin",
	],
	单据: [
		"zlgd_bzwz_wl",
		"zlgd_sys_test_bill",
		"zlgd_lsxypz",
		"zlgd_syrdz",
		"zlgd_wsydbzk_csjl",
		"zlgd_qty_wtd",
		"zlgd_nbjgjl",
	],
	布局: ["zlgd_wtd_xnl", "zlgd_sys_test_lssy", "zlgd_lssy_qzxy"],
	模板: ["zlgd_sys_test_bill_jxzyw", "zlgd_sys_test_bill_prtpl_62", "zlgd_sys_test_bill_prtpl_jjfswl"],
};
const LIMIT: Record<string, number> = { 插件: 1500, 单据: 3000, 布局: 3000, 模板: 3000 };
const BUDGET = 4000;

const args = process.argv.slice(2);
const root = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--show");
const showAt = args.indexOf("--show");
const show = showAt >= 0 ? args[showAt + 1] : undefined;
if (root === undefined) {
	console.error(
		"用法：node --experimental-strip-types scripts/measure-impact-size.ts <工程目录> [--json] [--show <词>]",
	);
	process.exit(2);
}
const opened = await openProject({
	projectRoot: root,
	agentConfigDir: join(homedir(), ".fast-ai-cosmic"),
	cacheRoot: mkdtempSync(join(tmpdir(), "impact-size-")),
	agentVersion: "dev",
	resources: EMBEDDED_RESOURCES,
});
const loaded = loadIndex(opened.ctx);
if (!loaded.ok) {
	console.error(`读不到代码关系表：${loaded.error.message}`);
	process.exit(2);
}
const index = loaded.value as ImpactIndex & { fieldRefs: SrcRef[] };
const isv = `${opened.ctx.config.isv}_`;
const bytes = (text: string) => Buffer.byteLength(text, "utf8");
const simple = (fqn: string) => (fqn.split(".").pop() ?? fqn).split("$")[0] as string;
const classes = new Map(index.classes.map((c) => [c.class, c]));
const bySimple = new Map<string, string[]>();
for (const c of index.classes) bySimple.set(simple(c.class), [...(bySimple.get(simple(c.class)) ?? []), c.class]);
const RESOLVED = new Set(["literal", "constant"]);
/** 每个本 ISV 字段标识 → 写它的类（自己写的，或经工具类写的）。 */
const writers = new Map<string, Set<string>>();
const addWriter = (key: string, cls: string) => {
	if (!key.startsWith(isv)) return;
	const set = writers.get(key) ?? new Set<string>();
	set.add(cls);
	writers.set(key, set);
};
for (const c of index.classes) {
	for (const f of c.fields)
		if (f.access === "write" && RESOLVED.has(String(f.resolution))) addWriter(String(f.key), c.class);
	for (const x of c.chain ?? []) if (x.level === "field" && x.access === "write") addWriter(x.key, c.class);
}
const written = (cls: string): string[] => [...writers].filter(([, set]) => set.has(cls)).map(([key]) => key);

interface Row {
	group: string;
	query: string;
	bytes: number;
	lines: number;
	cut: boolean;
	recognised: boolean;
	snapshot: boolean;
	sites: string;
	writes: string;
	others: string;
	artifacts: boolean;
	limit: number | null;
	ms: number;
}

function ask(terms: string[], dynamic?: boolean): { text: string; unknown: string[] } {
	const result = queryImpact(opened.ctx, { terms, ...(dynamic ? { dynamic } : {}) });
	if (!result.ok) return { text: `${result.error.message}\n${result.error.remedy ?? ""}`, unknown: terms };
	return { text: result.value.text, unknown: result.value.unknown.map((x) => x.term) };
}

function measure(group: string, terms: string[], dynamic?: boolean): Row {
	const started = performance.now();
	const { text, unknown } = ask(terms, dynamic);
	const ms = Math.round(performance.now() - started);
	if (show !== undefined && terms.join(" ") === show) console.log(`${text}\n`);
	const row: Row = {
		group,
		query: terms.join(" ") + (dynamic ? " (dynamic)" : ""),
		bytes: bytes(text),
		lines: text.split("\n").length,
		cut: bytes(text) > BUDGET,
		recognised: unknown.length === 0,
		snapshot: /快照 \d\d-\d\d/.test(text.split("\n")[0] ?? "") || /^\[IMPACT\] (快照|元数据快照)/m.test(text),
		sites: "",
		writes: "",
		others: "",
		artifacts: text.includes("牵连的元数据对象"),
		limit: LIMIT[group] ?? null,
		ms,
	};
	if (group === "插件") {
		const fqn = classes.has(terms[0] as string) ? (terms[0] as string) : (bySimple.get(terms[0] as string) ?? [])[0];
		const cls = fqn ? classes.get(fqn) : undefined;
		const marks = (cls?.bindings ?? []).map((b) =>
			b.kind === undefined || b.kind === "form"
				? (b.numbers.find((n) => n !== b.entity) ?? b.entity)
				: b.kind === "convert"
					? b.entity
					: (b.numbers[0] ?? b.entity),
		);
		row.sites = `${marks.filter((m) => text.includes(m)).length}/${marks.length}`;
		const keys = fqn ? written(fqn) : [];
		row.writes = `${keys.filter((k) => text.includes(k)).length}/${keys.length}`;
		const shared = keys.filter((k) => (writers.get(k)?.size ?? 0) > 1);
		const named = shared.filter((k) =>
			[...(writers.get(k) ?? [])].some((other) => other !== fqn && text.includes(simple(other))),
		);
		row.others = `${named.length}/${shared.length}`;
	} else if (group === "单据" || group === "布局") {
		const term = terms[0] as string;
		const on = index.classes.filter((c) =>
			c.bindings.some((b) =>
				group === "单据"
					? b.entity === term
					: (b.kind === undefined || b.kind === "form") && b.numbers.includes(term),
			),
		);
		row.sites = `${on.filter((c) => text.includes(simple(c.class))).length}/${on.length}`;
	}
	return row;
}

const rows: Row[] = [];
const seen = new Set<string>();
for (const q of REPLAY) {
	const key = JSON.stringify(q);
	if (seen.has(key)) continue;
	seen.add(key);
	rows.push(measure("原样", q.terms, q.dynamic));
}
for (const [group, terms] of Object.entries(SINGLES)) for (const term of terms) rows.push(measure(group, [term]));

if (args.includes("--json")) {
	console.log(JSON.stringify({ version: VERSION, index: index.at, meta: index.meta?.at ?? null, rows }, null, 2));
} else {
	console.log(`${VERSION}  代码关系表 ${index.at}  元数据快照 ${index.meta?.at ?? "无"}`);
	for (const group of ["原样", ...Object.keys(SINGLES)]) {
		const list = rows.filter((r) => r.group === group);
		const sizes = list.map((r) => r.bytes);
		const over = list.filter((r) => r.limit !== null && r.bytes > r.limit).length;
		console.log(
			`\n## ${group} ${list.length} 个：平均 ${Math.round(sizes.reduce((a, b) => a + b, 0) / list.length)} / 最大 ${Math.max(...sizes)} 字节，` +
				`被截 ${list.filter((r) => r.cut).length}${list[0]?.limit ? `，超目标 ${list[0].limit} 的 ${over}` : ""}，没认出 ${list.filter((r) => !r.recognised).length}，最慢 ${Math.max(...list.map((r) => r.ms))} 毫秒`,
		);
		for (const r of list) {
			console.log(
				`  ${String(r.bytes).padStart(6)} B ${String(r.lines).padStart(4)} 行${r.cut ? " 截" : "   "}${r.recognised ? "    " : " 没认"}` +
					`${r.snapshot ? " 快照" : "     "}${r.artifacts ? " 牵连" : "     "}` +
					`${r.sites ? ` 挂在哪 ${r.sites}` : ""}${r.writes ? ` 写 ${r.writes}` : ""}${r.others ? ` 同字段 ${r.others}` : ""}  ${r.query}`,
			);
		}
	}
}
