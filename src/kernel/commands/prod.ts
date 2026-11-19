/**
 * `cosmic_prod`：生产只读排障的命令本体。
 *
 *   status  连到了哪、各分区能查多少表、会话是不是只读、monitor 登没登录、生产代码是哪一版
 *   sql     一条只读查询（先过语句闸，再在只读事务里跑、跑完回滚）
 *   meta    一张单在生产上的设计元数据：拉回、合并、摘要；compare=true 再和测试环境逐项比
 *   log     monitor 日志：按 traceId / 页面 / 操作 / 类名 / 级别 / 关键字 / 时间段查，分组、对源码；
 *           带 billno 时走单据足迹（bill-trail.ts）：从操作记录反查每次操作在 monitor 里是哪个请求
 *
 * 每次成功的 sql / meta / log 都给调用方一条证据（种类、一句话、全文文件），由代理层编号；
 * 每次调用（成功失败都算）在 `.cosmic-ai/evidence/prod-audit.jsonl` 记一笔：查了什么、几行、多久。
 *
 * 这里没有任何写生产的路：sql 只走 reader 的 query，meta 和 log 只读。
 */
import { join } from "node:path";
import type { KernelContext } from "../context.ts";
import { err, KernelError, type KernelResult, ok } from "../errors.ts";
import type { FsPort } from "../ports.ts";
import { codeBaseline, sourceLookup } from "../prod/baseline.ts";
import {
	groupByTrace,
	isWorkflowFollowUp,
	type OpRecord,
	pickRequests,
	renderMention,
	renderTraceLine,
	VIEW_OP_KEYS,
} from "../prod/bill-trail.ts";
import {
	describeProdConfig,
	type ProdConfig,
	parseProdConfig,
	prodConfigFile,
	prodMonitorSessionFile,
} from "../prod/config.ts";
import { buildLogView, renderLogView } from "../prod/log-view.ts";
import {
	diffSides,
	fieldsTsv,
	metaDir,
	pullProdRows,
	readRows,
	renderDiff,
	renderSide,
	summarizeSide,
	validNumber,
} from "../prod/meta.ts";
import {
	type HttpPort,
	loadMonitorSession,
	MONITOR_SIZE_CEILING,
	type MonitorFilter,
	type MonitorRow,
	type MonitorSession,
} from "../prod/monitor.ts";
import { coverageLines, localTime, parseLocalTime, retentionStart, searchMonitor } from "../prod/monitor-search.ts";
import { prodColumns, prodInfo, prodQuery } from "../prod/reader.ts";
import { checkReadOnlySql, maskLiterals } from "../prod/sql-guard.ts";
import { META_ROWS_PROBE } from "./internal-probes.ts";
import type { probe as probeFn } from "./probe.ts";

export const PROD_ACTIONS = ["status", "sql", "meta", "log"] as const;
export type ProdAction = (typeof PROD_ACTIONS)[number];

export interface ProdRequest {
	action: ProdAction;
	sql?: string;
	number?: string;
	compare?: boolean;
	filter?: MonitorFilter;
	/** action=log：单据编号；和 number 一起给，走单据足迹 */
	billno?: string;
}

export interface ProdDeps {
	agentConfigDir: string;
	http: HttpPort;
	/** 工程 ISV：摘要里挑「本工程字段」、堆栈里认「像本 ISV 的代码」 */
	isv: string;
	runProbe?: typeof probeFn;
}

export interface ProdOutcome {
	text: string;
	/** 成功的 sql / meta / log 才有：代理层给它编号 */
	evidence?: { kind: string; summary: string; file?: string };
}

/** 一格最多给模型看多少字；全文在落盘的 tsv 里 */
const CELL_SHOWN = 200;
const ROWS_SHOWN = 60;

export function loadProdConfig(fs: FsPort, agentConfigDir: string): KernelResult<ProdConfig> {
	const file = prodConfigFile(agentConfigDir);
	if (!fs.exists(file))
		return err(
			new KernelError("PROD_CONFIG_MISSING", `没有生产排障配置：${file}`, {
				detail: { file },
				remedy: `请用户在会话里输入 /cosmic-prod-setup 按提示填（写到本机 ${file}，里面是生产只读账号，不要把内容贴进对话）。`,
			}),
		);
	return parseProdConfig(fs.read(file), file);
}

function audit(ctx: KernelContext, entry: Record<string, unknown>): void {
	const file = join(ctx.layout.evidenceDir, "prod-audit.jsonl");
	const line = `${JSON.stringify({ at: new Date(ctx.ports.clock.now()).toISOString(), ...entry })}\n`;
	try {
		const old = ctx.ports.fs.exists(file) ? ctx.ports.fs.read(file) : "";
		ctx.ports.fs.write(file, old + line);
	} catch {
		// 记账失败不挡查询：查询本身是只读的，记不下来只少一行流水
	}
}

function stamp(ctx: KernelContext): string {
	return new Date(ctx.ports.clock.now()).toISOString().replace(/[:.]/g, "-");
}

function connectedLine(v: { version: string; database: string; user: string; sessionReadOnly: string }): string {
	return `连上了：${v.version.split(" (")[0] ?? v.version}，库 ${v.database}，账号 ${v.user}，会话只读 ${v.sessionReadOnly === "on" ? "是" : `否（${v.sessionReadOnly}）`}`;
}

/** 配置向导写入前试连一次：用还没落盘的那份配置，连上了给一句话 */
export async function checkProdConnection(ctx: KernelContext, config: ProdConfig): Promise<KernelResult<string>> {
	const info = await prodInfo(ctx, config);
	audit(ctx, { action: "setup-check", ok: info.ok });
	return info.ok ? ok(connectedLine(info.value)) : info;
}

async function status(ctx: KernelContext, deps: ProdDeps, config: ProdConfig): Promise<KernelResult<ProdOutcome>> {
	const lines = [describeProdConfig(config)];
	const info = await prodInfo(ctx, config);
	if (!info.ok) return info;
	const v = info.value;
	lines.push(
		"",
		connectedLine(v),
		"各分区（能查/总表数）：",
		...v.schemas.map((s) => `  ${s.name}  ${String(s.readable)}/${String(s.tables)}`),
	);
	if (config.monitor === null) lines.push("", "monitor：没配，日志查询不可用");
	else {
		const session = loadMonitorSession(
			ctx.ports.fs,
			prodMonitorSessionFile(deps.agentConfigDir),
			config.monitor.username,
		);
		lines.push(
			"",
			session === null
				? "monitor：没登录（要查日志请用户敲 /cosmic-monitor-login）"
				: `monitor：${new Date(session.loggedInAt).toLocaleString("zh-CN", { hour12: false })} 登录过（闲置约半小时会过期，过期了查日志会提示重新登录）`,
		);
	}
	lines.push("", (await codeBaseline(ctx)).note);
	audit(ctx, { action: "status", ok: true });
	return ok({ text: lines.join("\n") });
}

function cell(value: string | null): string {
	if (value === null) return "∅";
	const flat = value.replace(/\r?\n/g, "⏎").replace(/\t/g, " ");
	return flat.length > CELL_SHOWN ? `${flat.slice(0, CELL_SHOWN)}…(${String(flat.length)} 字)` : flat;
}

async function sql(ctx: KernelContext, config: ProdConfig, text: string): Promise<KernelResult<ProdOutcome>> {
	const refuse = (reason: string): KernelResult<ProdOutcome> => {
		audit(ctx, { action: "sql", ok: false, refused: reason, sql: text });
		return err(
			new KernelError("PROD_SQL_REFUSED", `没发出去：${reason}`, {
				remedy: "生产只放行单条只读查询（select / with）。要看表结构用 action=meta，要看数据就写 select。",
			}),
		);
	};
	const checked = checkReadOnlySql(text);
	if (!checked.ok) return refuse(checked.reason);
	if (checked.functions.length > 0) {
		const info = await prodInfo(ctx, config);
		if (!info.ok) return info;
		const shadowed = checked.functions.filter((name) => info.value.userFunctions.includes(name));
		if (shadowed.length > 0)
			return refuse(`业务分区里有同名的自定义函数，可能调到它：${shadowed.map((n) => `${n}()`).join("、")}`);
	}
	const got = await prodQuery(ctx, config, text, checked.tables);
	if (!got.ok) {
		audit(ctx, { action: "sql", ok: false, error: got.error.message, sql: text });
		if (got.error.code !== "PROD_SQL_FAILED") return got;
		return err(await withRealColumns(ctx, config, text, checked.tables, got.error));
	}
	const r = got.value;
	const file = join(ctx.layout.workDir, "prod", "sql", `${stamp(ctx)}.tsv`);
	ctx.ports.fs.write(
		file,
		`-- ${text.replace(/\s+/g, " ")}\n${[r.columns.join("\t"), ...r.rows.map((row) => row.map((c) => (c ?? "").replace(/[\t\r\n]/g, " ")).join("\t"))].join("\n")}\n`,
	);
	const lines: string[] = [];
	const where = Object.entries(r.tableSchemas).map(
		([table, places]) =>
			`${table} 在 ${places.map((p) => `${p.schema}${p.readable ? "" : "（没查询权限）"}`).join("、")}${places.length > 1 ? "（多个分区同名，按分区名排序取第一个；要指定就写 分区.表名）" : ""}`,
	);
	const missing = checked.tables.filter((t) => r.tableSchemas[t] === undefined);
	if (where.length > 0) lines.push(where.join("；"));
	if (missing.length > 0)
		lines.push(`不是本账号能看到的普通表（可能是子查询别名、视图或没有使用权的分区）：${missing.join("、")}`);
	lines.push(
		`${String(r.rowCount)} 行，${String(r.ms)} ms${r.truncated ? `；到了上限 ${String(config.limits.maxRows)} 行，后面还有——加过滤条件或 count(*) 看总数` : ""}${r.clipped ? "；答复体积到上限，行没取完" : ""}`,
	);
	lines.push(r.columns.join("\t"));
	for (const row of r.rows.slice(0, ROWS_SHOWN)) lines.push(row.map(cell).join("\t"));
	if (r.rows.length > ROWS_SHOWN) lines.push(`…另有 ${String(r.rows.length - ROWS_SHOWN)} 行`);
	lines.push(`全部结果（不截断）：${file}`);
	audit(ctx, { action: "sql", ok: true, sql: text, rows: r.rowCount, truncated: r.truncated, ms: r.ms, file });
	const summary = `查询 ${text.replace(/\s+/g, " ").slice(0, 160)} → ${String(r.rowCount)} 行${
		r.rows[0]
			? `，首行 ${r.rows[0]
					.map((c) => cell(c).slice(0, 40))
					.join(" | ")
					.slice(0, 160)}`
			: ""
	}`;
	return ok({ text: lines.join("\n"), evidence: { kind: "生产数据", summary, file } });
}

/** 一张表的列数不超过这个就全列；更宽的只列语句里写到的，其余看文件 */
const COLUMNS_LISTED_IN_FULL = 80;

/**
 * 库按语句报错时，把语句里用到的表在库里的真实列和类型、库的版本附进报错。
 *
 * 改语句要的事实（这一列是 bigint 还是 varchar、有没有这一列、这个库认不认 FILTER）都在库里；
 * 报错只说「哪里不对」，不说「真实是什么」，模型就只能一次次试。这里一次给全，
 * 下一条语句照着写。查不到列也不挡原来的报错，只多一句没查成的原因。
 */
async function withRealColumns(
	ctx: KernelContext,
	config: ProdConfig,
	text: string,
	tables: readonly string[],
	error: KernelError,
): Promise<KernelError> {
	const looked = await prodColumns(ctx, config, tables);
	if (!looked.ok)
		return new KernelError(error.code, error.message, {
			detail: { ...error.detail, columnsLookup: `没查成：${looked.error.message}` },
			remedy: error.remedy,
		});
	const masked = maskLiterals(text).text.toLowerCase();
	const words = new Set(masked.match(/[a-z_][a-z0-9_$]*/g) ?? []);
	const sqlState = String(error.detail.sqlState ?? "");
	// 列名写错（42703）时，写错的那个名字在宽表里匹配不到任何列，只列「写到的」就恰好漏掉要找的那一列；
	// 按报错里的名字把相近的真实列也列出来（真机：写了 zlgd_hjzt，库里是 fk_zlgd_hjzt）
	const wrong =
		sqlState === "42703" ? (/"([^"]+)"/.exec(error.message)?.[1] ?? "").split(".").pop()?.toLowerCase() : "";
	const near = (name: string): boolean =>
		wrong !== undefined && wrong.length >= 3 && (name.includes(wrong) || (name.length >= 3 && wrong.includes(name)));
	const picked = wrong ? `语句里写到的和名字像「${wrong}」的` : "语句里写到的";
	const file = join(ctx.layout.workDir, "prod", "sql", `${stamp(ctx)}-columns.tsv`);
	const tsv = ["table\tschema\tcolumn\ttype"];
	const lines: string[] = [];
	for (const table of looked.value.tables) {
		for (const c of table.columns) tsv.push([table.table, table.schema, c.name, c.type].join("\t"));
		const full = table.columns.length <= COLUMNS_LISTED_IN_FULL;
		const shown = full
			? table.columns
			: table.columns.filter((c) => words.has(c.name.toLowerCase()) || near(c.name.toLowerCase()));
		const rest = table.columns.length - shown.length;
		lines.push(
			`${table.table}（分区 ${table.schema}，${String(table.columns.length)} 列${full ? "" : `，下面只列${picked} ${String(shown.length)} 列`}）：` +
				`${shown.map((c) => `${c.name} ${c.type}`).join(", ") || "语句里没写到这张表的列"}` +
				`${rest > 0 ? `；其余 ${String(rest)} 列见 columnsFile` : ""}`,
		);
	}
	// 语句闸认表是按 from / join 后面的词认的，EXTRACT(HOUR FROM 列)、WITH 起的名字也会混进来；
	// 只在库报的就是「表不存在」（42P01）时才说哪些名字不是表，不然是噪音
	const found = new Set(looked.value.tables.map((t) => t.table));
	if (sqlState === "42P01")
		for (const table of tables)
			if (!found.has(table)) lines.push(`${table}：本账号能看到的分区里没有这张表（可能是子查询别名或拼错了）`);
	ctx.ports.fs.write(file, `${tsv.join("\n")}\n`);
	return new KernelError(error.code, error.message, {
		detail: { ...error.detail, database: looked.value.version, columns: lines, columnsFile: file },
		remedy: `${error.remedy}语句里用到的表在库里的真实列名和类型在 columns（全部列在 columnsFile），库的版本在 database：列名、类型转换和写法都以它们为准。`,
	});
}

async function meta(
	ctx: KernelContext,
	deps: ProdDeps,
	config: ProdConfig,
	number: string,
	compare: boolean,
): Promise<KernelResult<ProdOutcome>> {
	if (!validNumber(number))
		return err(
			new KernelError("PROD_ARGS_INVALID", `number 只能是字母数字下划线：${number}`, {
				remedy: "传单据、基础资料或布局的标识。",
			}),
		);
	const pulled = await pullProdRows(ctx, config, number);
	if (!pulled.ok) {
		audit(ctx, { action: "meta", ok: false, number, error: pulled.error.message });
		return pulled;
	}
	const dir = pulled.value.dir;
	const prodRows = readRows(ctx, dir);
	if (prodRows.length === 0) {
		audit(ctx, { action: "meta", ok: true, number, rows: 0 });
		return ok({
			text: `生产上没有标识为 ${number} 的实体或布局元数据（t_meta_entitydesign、t_meta_formdesign 都查过，0 行）。`,
			evidence: { kind: "生产元数据", summary: `${number}：生产上没有这张单的元数据` },
		});
	}
	const prod = summarizeSide(prodRows, number);
	ctx.ports.fs.write(join(dir, "fields.tsv"), fieldsTsv(prod));
	ctx.ports.fs.write(join(dir, "summary.txt"), `${renderSide(prod, number, deps.isv, dir, true)}\n`);
	const lines = [
		`生产 ${number}（${String(pulled.value.rows)} 行元数据，${String(pulled.value.ms)} ms，原文在 ${dir}）`,
		renderSide(prod, number, deps.isv, dir),
	];
	let diffSummary = "";
	if (compare) {
		const testDir = metaDir(ctx, number, "test");
		if (ctx.ports.fs.exists(testDir)) ctx.ports.fs.remove(testDir);
		const runProbe = deps.runProbe;
		if (runProbe === undefined) {
			lines.push("", "测试环境比对：这个宿主跑不了探针，没比。");
		} else {
			const run = await runProbe(ctx, META_ROWS_PROBE, {
				countRepeats: false,
				kernelEnv: true,
				env: { META_NUMBER: number, META_OUT: testDir },
				invocation: `生产排障：取测试环境 ${number} 的元数据原文`,
			});
			if (!run.ok || run.value.exitCode !== 0) {
				lines.push(
					"",
					`测试环境比对没做成：${run.ok ? `探针退出码 ${String(run.value.exitCode)}，输出 ${run.value.outputFile}` : `${run.error.code} ${run.error.message}`}`,
				);
			} else {
				const testRows = readRows(ctx, testDir);
				const test = summarizeSide(testRows, number);
				const diff = diffSides(prodRows, prod, testRows, test);
				const rendered = renderDiff(diff);
				ctx.ports.fs.write(join(testDir, "..", "diff.txt"), `${rendered}\n`);
				lines.push("", `和测试环境比（测试 ${String(testRows.length)} 行，原文在 ${testDir}）：`, rendered);
				const total =
					diff.onlyProdRows.length +
					diff.onlyTestRows.length +
					diff.fieldsOnlyProd.length +
					diff.fieldsOnlyTest.length +
					diff.fieldsChanged.length +
					diff.pluginsOnlyProd.length +
					diff.pluginsOnlyTest.length +
					diff.pluginsEnabledDiffer.length;
				diffSummary = `；和测试比：内容不同的行 ${String(diff.changedRows.length)}，字段/插件差异 ${String(total)} 项`;
			}
		}
	}
	audit(ctx, { action: "meta", ok: true, number, rows: pulled.value.rows, compare, ms: pulled.value.ms });
	const fields = prod.entity?.fields.length ?? 0;
	return ok({
		text: lines.join("\n"),
		evidence: {
			kind: "生产元数据",
			summary: `${number}：${String(prod.entityOrder.length)} 层实体、${String(fields)} 个字段、表单插件 ${String(prod.formPlugins.length)} 个、操作插件 ${String(prod.entity?.opPlugins.length ?? 0)} 个${diffSummary}`,
			file: join(dir, "summary.txt"),
		},
	});
}

function filterText(filter: MonitorFilter): string {
	return Object.entries(filter)
		.filter(([, v]) => v !== undefined && v !== "")
		.map(([k, v]) => `${k}=${String(v)}`)
		.join(" ");
}

function monitorSession(
	ctx: KernelContext,
	deps: ProdDeps,
	config: ProdConfig,
): KernelResult<{ monitor: NonNullable<ProdConfig["monitor"]>; session: MonitorSession | null }> {
	if (config.monitor === null)
		return err(
			new KernelError("PROD_CONFIG_MISSING", "生产排障配置里没有 monitor 账号，查不了日志", {
				remedy: `请用户在会话里输入 /cosmic-prod-setup 补上 monitor 账号（写到本机 ${config.file}）。`,
			}),
		);
	const session = loadMonitorSession(
		ctx.ports.fs,
		prodMonitorSessionFile(deps.agentConfigDir),
		config.monitor.username,
	);
	return ok({ monitor: config.monitor, session });
}

/** formId、opKey 在 monitor 里是精确匹配的页面标识和「控件[按钮, 操作]」：带了它们却 0 条时说清楚 */
function exactFilterNote(filter: MonitorFilter, rows: number): string {
	if (rows > 0 || (filter.formId === undefined && filter.opKey === undefined)) return "";
	return "0 条：monitor 的 formId、opKey 是精确匹配——formId 是页面标识（布局、列表 bos_list-<单据>、审批页 WF_…），不是单据标识；opKey 要写全「控件[按钮, 操作]」，如 tbmain[bar_submit, submit]。不知道这两个就去掉它们，按 userName + 时间段或 billno 查。";
}

async function log(
	ctx: KernelContext,
	deps: ProdDeps,
	config: ProdConfig,
	filter: MonitorFilter,
): Promise<KernelResult<ProdOutcome>> {
	const opened = monitorSession(ctx, deps, config);
	if (!opened.ok) return opened;
	const now = ctx.ports.clock.now();
	const got = await searchMonitor(deps.http, opened.value.monitor, opened.value.session, filter, now);
	if (!got.ok) {
		audit(ctx, { action: "log", ok: false, filter, error: got.error.code });
		return got;
	}
	const baseline = await codeBaseline(ctx);
	const view = buildLogView(got.value.rows, sourceLookup(ctx, baseline), deps.isv);
	const file = join(ctx.layout.workDir, "prod", "logs", `${stamp(ctx)}.txt`);
	ctx.ports.fs.write(file, `条件 ${filterText(filter)}\n${renderLogView(view, true)}\n`);
	const size = Math.min(Math.max(1, filter.size ?? 200), MONITOR_SIZE_CEILING);
	const lines = [
		`条件：${filterText(filter) || "(无)"}`,
		...coverageLines(got.value, size),
		exactFilterNote(filter, got.value.rows.length),
		renderLogView(view, false),
		`全文（每组原文、全部调用行）：${file}`,
		baseline.note,
	].filter((line) => line !== "");
	audit(ctx, {
		action: "log",
		ok: true,
		filter,
		rows: got.value.rows.length,
		groups: view.groups.length,
		ms: got.value.ms,
		file,
	});
	const top = view.groups[0];
	return ok({
		text: lines.join("\n"),
		evidence: {
			kind: "生产日志",
			summary: `日志 ${filterText(filter)} → ${String(view.total)} 条 ${String(view.groups.length)} 组${top ? `；首组 ${top.kind} ${String(top.count)} 次 ${top.sample.at}：${top.sample.headline.slice(0, 120)}` : ""}`,
			file,
		},
	});
}

/** 工具自己要查的库（单据足迹）也走语句闸和只读通道，照样记账 */
async function guardedQuery(
	ctx: KernelContext,
	config: ProdConfig,
	text: string,
): Promise<KernelResult<{ rows: (string | null)[][]; ms: number }>> {
	const checked = checkReadOnlySql(text);
	if (!checked.ok)
		return err(
			new KernelError("PROD_SQL_REFUSED", `没发出去：${checked.reason}`, { remedy: "检查单据标识和编号。" }),
		);
	const got = await prodQuery(ctx, config, text, checked.tables);
	audit(ctx, {
		action: "log-trail-sql",
		ok: got.ok,
		sql: text,
		...(got.ok ? { rows: got.value.rowCount, ms: got.value.ms } : { error: got.error.message }),
	});
	return got.ok ? ok({ rows: got.value.rows, ms: got.value.ms }) : got;
}

/** 单据足迹里去 monitor 找请求的操作次数上限、每次往前往后看几秒 */
const TRAIL_OPS_LOOKED_UP = 15;
const TRAIL_BEFORE_MS = 5000;
const TRAIL_AFTER_MS = 3000;
const TRAIL_REQUESTS_SHOWN = 3;

async function trail(
	ctx: KernelContext,
	deps: ProdDeps,
	config: ProdConfig,
	number: string,
	billno: string,
): Promise<KernelResult<ProdOutcome>> {
	if (!validNumber(number))
		return err(
			new KernelError("PROD_ARGS_INVALID", `number 不像单据标识：${number}`, {
				remedy: "billno 要和 number（单据标识，如 demo_bill）一起给。",
			}),
		);
	if (!/^[\w\-./]+$/.test(billno))
		return err(
			new KernelError("PROD_ARGS_INVALID", `billno 不像单据编号：${billno}`, {
				remedy: "billno 写单据编号原文（字母、数字、- _ . /）。",
			}),
		);
	const opened = monitorSession(ctx, deps, config);
	if (!opened.ok) return opened;
	const { monitor, session } = opened.value;
	const now = ctx.ports.clock.now();
	const since = retentionStart(now);
	// 给的可能是布局标识：操作记录记的是单据标识，两样都认
	const entities = await guardedQuery(
		ctx,
		config,
		`select distinct e.fnumber from t_meta_formdesign f join t_meta_entitydesign e on e.fid = f.fentityid where f.fnumber = '${number}'`,
	);
	if (!entities.ok) return entities;
	const objects = [...new Set([number, ...entities.value.rows.map((r) => r[0] ?? "").filter((v) => v !== "")])];
	const opsGot = await guardedQuery(
		ctx,
		config,
		`select foptime, fusername, fopkey, fopname, fstatus, fopdesc from t_log_app_v3 where foptime >= '${localTime(since)}'` +
			` and fbizobjid in (${objects.map((o) => `'${o}'`).join(", ")}) and fopdesc like '%${billno}%'` +
			` and fopkey not in (${VIEW_OP_KEYS.map((k) => `'${k}'`).join(", ")}) order by foptime desc limit 60`,
	);
	if (!opsGot.ok) return opsGot;
	const seen = new Set<string>();
	const ops: OpRecord[] = [];
	for (const [time, user, opKey, opName, status, desc] of opsGot.value.rows) {
		const key = `${time}|${user}|${opKey}`;
		if (time === null || time === undefined || seen.has(key)) continue;
		seen.add(key);
		ops.push({
			time,
			ms: parseLocalTime(time),
			user: user ?? "",
			opKey: opKey ?? "",
			opName: opName ?? "",
			status: status ?? "",
			desc: desc ?? "",
		});
	}

	const lines = [
		`单据 ${number} ${billno} 的足迹：操作记录 + monitor（monitor 只留 7 天，从 ${localTime(since)} 起；页面标识 ${objects.join("、")}）`,
		`操作记录 ${String(ops.length)} 次（打开、查看、刷新不算；从新到旧，前 ${String(Math.min(ops.length, TRAIL_OPS_LOOKED_UP))} 次去 monitor 按「操作人 + 那一刻前 ${String(TRAIL_BEFORE_MS / 1000)} 秒到后 ${String(TRAIL_AFTER_MS / 1000)} 秒」找了请求）：`,
	];
	const full: string[] = [...lines];
	const pickedIds = new Set<string>();
	const shownBy = new Map<string, string>();
	const pickedRows: MonitorRow[] = [];
	let located = 0;
	let withProblems = 0;
	let monitorError: KernelError | null = null;
	for (const [index, op] of ops.entries()) {
		const head = `  ${op.time}  ${op.user}  ${op.opKey} ${op.opName}  ${op.status === "1" ? "成功" : op.status === "0" ? "失败" : op.status}  ${op.desc.slice(0, 160)}`;
		lines.push(head);
		full.push(head);
		if (index >= TRAIL_OPS_LOOKED_UP || monitorError !== null) continue;
		const got = await searchMonitor(
			deps.http,
			monitor,
			session,
			{
				userName: op.user,
				from: new Date(op.ms - TRAIL_BEFORE_MS).toISOString(),
				to: new Date(op.ms + TRAIL_AFTER_MS).toISOString(),
				size: 3000,
			},
			now,
		);
		if (!got.ok) {
			monitorError = got.error;
			continue;
		}
		const groups = groupByTrace(got.value.rows, deps.isv);
		const { picked, how } = pickRequests(groups, op);
		if (picked.length === 0) {
			lines.push(`    monitor 里没找到：${how}`);
			continue;
		}
		located++;
		if (picked.some((g) => g.problems.length > 0)) withProblems++;
		// 保存、提交、发起流程常是同一次点击里连着做的：同一个请求只展开一次
		const shownAt = picked.map((g) => shownBy.get(g.traceId)).find((v) => v !== undefined);
		if (shownAt !== undefined && picked.every((g) => shownBy.has(g.traceId))) {
			lines.push(`    和上面 ${shownAt} 那次是同一个请求（traceId ${picked.map((g) => g.traceId).join("、")}）`);
			continue;
		}
		for (const g of picked) if (!shownBy.has(g.traceId)) shownBy.set(g.traceId, op.time);
		const start = picked[0]?.first ?? "";
		const followUps = groups.filter((g) => isWorkflowFollowUp(g) && g.first >= start).length;
		lines.push(`    认法：${how}`);
		// 同一个按钮常跟着一串只有一两条的小请求（进度刷新之类）：按条数取前几个，其余合成一句
		const ranked = [...picked].sort((a, b) => b.rows.length - a.rows.length);
		for (const [at, g] of ranked.entries()) {
			if (at < TRAIL_REQUESTS_SHOWN || g.problems.length > 0) lines.push(renderTraceLine(g));
			full.push(renderTraceLine(g));
			pickedIds.add(g.traceId);
			pickedRows.push(...g.rows);
		}
		const quiet = ranked.slice(TRAIL_REQUESTS_SHOWN).filter((g) => g.problems.length === 0);
		if (quiet.length > 0)
			lines.push(
				`    另有 ${String(quiet.length)} 个同一按钮的小请求（共 ${String(quiet.reduce((n, g) => n + g.rows.length, 0))} 条，没有报错和警告），见全文`,
			);
		if (followUps > 0) lines.push(`    之后工作流另起 ${String(followUps)} 个请求（页面 WF_…，各有 traceId）`);
	}
	if (monitorError !== null) lines.push(`monitor 没查成：${monitorError.message}。${monitorError.remedy ?? ""}`);

	// 插件自己写的日志常带单号：按正文搜一遍，找操作记录里没有的请求
	let mentionCount = 0;
	if (monitorError === null) {
		const mentions = await searchMonitor(
			deps.http,
			monitor,
			session,
			{ keyword: billno, from: new Date(since).toISOString(), size: 500 },
			now,
		);
		if (mentions.ok) {
			const others = mentions.value.rows.filter((r) => !pickedIds.has(String(r.logtags?.traceId ?? "")));
			mentionCount = new Set(others.map((r) => String(r.logtags?.traceId ?? ""))).size;
			lines.push(
				"",
				`日志正文里提到 ${billno} 的请求（上面没列的）${String(mentionCount)} 个、${String(others.length)} 条：`,
				...others.slice(0, 20).map(renderMention),
				...(others.length > 20 ? [`  …另有 ${String(others.length - 20)} 条，见全文`] : []),
				...coverageLines(mentions.value, 500).map((l) => `  ${l}`),
			);
			full.push("", `日志正文里提到 ${billno} 的：`, ...others.map(renderMention));
			pickedRows.push(...others);
		} else lines.push(`按正文搜 ${billno} 没查成：${mentions.error.message}`);
	}

	const baseline = await codeBaseline(ctx);
	const view = buildLogView(pickedRows, sourceLookup(ctx, baseline), deps.isv);
	const file = join(ctx.layout.workDir, "prod", "logs", `${stamp(ctx)}-${billno.replace(/[^\w-]/g, "_")}.txt`);
	ctx.ports.fs.write(file, `${full.join("\n")}\n\n${renderLogView(view, true)}\n`);
	lines.push(
		"",
		"要看某个请求的全部日志：action=log traceId=<id>（不给时间就查整个保留期）。",
		`全文（每个请求的原文、全部调用行）：${file}`,
	);
	audit(ctx, { action: "log", ok: true, number, billno, ops: ops.length, located, withProblems, file });
	return ok({
		text: lines.join("\n"),
		evidence: {
			kind: "生产日志",
			summary: `单据足迹 ${number} ${billno} → 操作 ${String(ops.length)} 次，在 monitor 对上请求 ${String(located)} 次（带报错或警告的 ${String(withProblems)} 次）；正文提到单号的其他请求 ${String(mentionCount)} 个`,
			file,
		},
	});
}

export async function prod(
	ctx: KernelContext,
	deps: ProdDeps,
	request: ProdRequest,
): Promise<KernelResult<ProdOutcome>> {
	const config = loadProdConfig(ctx.ports.fs, deps.agentConfigDir);
	if (!config.ok) return config;
	switch (request.action) {
		case "status":
			return status(ctx, deps, config.value);
		case "sql":
			if (request.sql === undefined || request.sql.trim() === "")
				return err(
					new KernelError("PROD_ARGS_INVALID", "action=sql 要带 sql", { remedy: "sql 写一条 select 查询。" }),
				);
			return sql(ctx, config.value, request.sql);
		case "meta":
			if (request.number === undefined || request.number.trim() === "")
				return err(
					new KernelError("PROD_ARGS_INVALID", "action=meta 要带 number", {
						remedy: "number 写单据、基础资料或布局的标识。",
					}),
				);
			return meta(ctx, deps, config.value, request.number.trim(), request.compare === true);
		case "log":
			if (request.billno !== undefined && request.billno.trim() !== "") {
				if (request.number === undefined || request.number.trim() === "")
					return err(
						new KernelError("PROD_ARGS_INVALID", "billno 要和 number 一起给", {
							remedy: "number 写这张单的单据标识（或布局标识）。",
						}),
					);
				return trail(ctx, deps, config.value, request.number.trim(), request.billno.trim());
			}
			return log(ctx, deps, config.value, request.filter ?? {});
	}
}
