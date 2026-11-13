/**
 * `cosmic_prod action=meta`：生产上一张单的设计态元数据——拉回本地、合并、摘要，可选和测试环境比对。
 *
 * 两边落盘的形状一样（目录里每行一个 XML 文件，外加 rows.tsv 索引）：生产一侧走只读通道，
 * 测试一侧走 MetaRowsProbe。合并、摘要、比对都只读本地文件，同一段代码，所以两边不会是两套口径。
 *
 * XML 原文按行落盘，人和模型都能直接 grep；摘要里的「字段→列」整表写进 fields.tsv。
 */
import { join } from "node:path";
import type { KernelContext } from "../context.ts";
import { err, KernelError, type KernelResult, ok } from "../errors.ts";
import type { ProdConfig } from "./config.ts";
import {
	type EntitySummary,
	type MetaPlugin,
	type MetaRow,
	mergeOrder,
	mergeRows,
	summarizeEntity,
	summarizeForm,
} from "./meta-xml.ts";
import { prodQuery } from "./reader.ts";

export const META_COLUMNS = "fid, fnumber, fisv, fparentid, fmasterid, finheritpath, fmodifydate";

export function metaDir(ctx: KernelContext, number: string, side: "prod" | "test"): string {
	return join(ctx.layout.workDir, "prod", "meta", number, side);
}

export function validNumber(number: string): boolean {
	return /^[A-Za-z0-9_]+$/.test(number);
}

function argsInvalid(message: string, remedy: string): KernelError {
	return new KernelError("PROD_ARGS_INVALID", message, { remedy });
}

/** 生产一侧：两条 SQL 认出链上的 fid，再一条取全文，落成和 MetaRowsProbe 一样的目录 */
export async function pullProdRows(
	ctx: KernelContext,
	config: ProdConfig,
	number: string,
): Promise<KernelResult<{ dir: string; rows: number; ms: number }>> {
	if (!validNumber(number))
		return err(argsInvalid(`标识只能是字母数字下划线：${number}`, "传单据、基础资料或布局的标识。"));
	const started = ctx.ports.clock.now();
	const chain = new Set<string>();
	for (const table of ["t_meta_entitydesign", "t_meta_formdesign"]) {
		const self = await prodQuery(ctx, config, `select fid, finheritpath from ${table} where fnumber = '${number}'`, [
			table,
		]);
		if (!self.ok) return self;
		for (const [fid, path] of self.value.rows) {
			if (fid) chain.add(fid.trim());
			for (const id of (path ?? "").split(",")) if (id.trim() !== "") chain.add(id.trim());
		}
	}
	const dir = metaDir(ctx, number, "prod");
	const { fs } = ctx.ports;
	if (fs.exists(dir)) fs.remove(dir);
	fs.mkdirp(dir);
	const index = ["kind\tfid\tfnumber\tfisv\tfparentid\tfmasterid\tfinheritpath\tfmodifydate\tfile"];
	if (chain.size === 0) {
		fs.write(join(dir, "rows.tsv"), `${index.join("\n")}\n`);
		return ok({ dir, rows: 0, ms: ctx.ports.clock.now() - started });
	}
	const ids = [...chain].filter((id) => !id.includes("'")).map((id) => `'${id}'`);
	let n = 0;
	for (const [kind, table] of [
		["entity", "t_meta_entitydesign"],
		["form", "t_meta_formdesign"],
	] as const) {
		const got = await prodQuery(
			ctx,
			config,
			`select ${META_COLUMNS}, fdata from ${table} where fid in (${ids.join(",")}) or fmasterid in (${ids.join(",")})`,
			[table],
		);
		if (!got.ok) return got;
		for (const row of got.value.rows) {
			n++;
			const cells = row.map((cell) => (cell ?? "").trim());
			const file = `${String(n).padStart(2, "0")}-${cells[1]}.${kind}.xml`;
			fs.write(join(dir, file), row[7] ?? "");
			index.push([kind, ...cells.slice(0, 7), file].join("\t"));
		}
	}
	fs.write(join(dir, "rows.tsv"), `${index.join("\n")}\n`);
	return ok({ dir, rows: n, ms: ctx.ports.clock.now() - started });
}

/** 读回一个目录（生产或测试一侧都行） */
export function readRows(ctx: KernelContext, dir: string): MetaRow[] {
	const { fs } = ctx.ports;
	const indexFile = join(dir, "rows.tsv");
	if (!fs.exists(indexFile)) return [];
	const lines = fs.read(indexFile).replace(/\r\n/g, "\n").split("\n").slice(1);
	const rows: MetaRow[] = [];
	for (const line of lines) {
		if (line.trim() === "") continue;
		const [kind, fid, fnumber, fisv, fparentid, fmasterid, finheritpath, fmodifydate, file] = line.split("\t");
		if (kind !== "entity" && kind !== "form") continue;
		const path = join(dir, file ?? "");
		rows.push({
			kind,
			fid: fid ?? "",
			fnumber: fnumber ?? "",
			fisv: fisv ?? "",
			fparentid: fparentid ?? "",
			fmasterid: fmasterid ?? "",
			finheritpath: finheritpath ?? "",
			fmodifydate: fmodifydate ?? "",
			fdata: fs.exists(path) ? fs.read(path) : "",
		});
	}
	return rows;
}

export interface SideSummary {
	/** 合并顺序：编号（ISV，修改时间） */
	entityOrder: MetaRow[];
	formOrder: MetaRow[];
	entity: EntitySummary | null;
	formPlugins: MetaPlugin[];
	/** 合并时坏掉的行（XML 解析失败），照实报 */
	broken: string[];
}

export function summarizeSide(rows: readonly MetaRow[], number: string): SideSummary {
	const broken: string[] = [];
	const pick = (kind: MetaRow["kind"]): MetaRow | undefined =>
		rows.find((r) => r.kind === kind && r.fnumber === number) ??
		// 只给了扩展的编号也认：它的 fmasterid 指向被扩展的那一行，本身就在链里
		rows.find((r) => r.kind === kind);
	const entitySelf = pick("entity");
	const formSelf = pick("form");
	const entityOrder = entitySelf === undefined ? [] : mergeOrder(rows, entitySelf.fid, "entity");
	const formOrder = formSelf === undefined ? [] : mergeOrder(rows, formSelf.fid, "form");
	let entity: EntitySummary | null = null;
	let formPlugins: MetaPlugin[] = [];
	try {
		const merged = mergeRows(entityOrder);
		entity = merged === null ? null : summarizeEntity(merged);
	} catch (error) {
		broken.push(`实体合并失败：${(error as Error).message}`);
	}
	try {
		const merged = mergeRows(formOrder);
		formPlugins = merged === null ? [] : summarizeForm(merged);
	} catch (error) {
		broken.push(`布局合并失败：${(error as Error).message}`);
	}
	return { entityOrder, formOrder, entity, formPlugins, broken };
}

const orderLine = (order: readonly MetaRow[]): string =>
	order.map((r) => `${r.fnumber}${r.fisv === "kingdee" ? "" : `(${r.fisv})`}`).join(" → ");

export function fieldsTsv(summary: SideSummary): string {
	const head = "key\tname\ttype\tentry\ttable\tcolumn\tmustInput\tfrom";
	const lines = (summary.entity?.fields ?? []).map((f) =>
		[f.key, f.name, f.tag, f.entityKey || "(单据头)", f.table, f.column, f.mustInput ? "必录" : "", f.from].join(
			"\t",
		),
	);
	return `${[head, ...lines].join("\n")}\n`;
}

/** 给模型看的摘要：链、分录和表、插件、本工程 ISV 加的字段。全量字段在 fields.tsv */
/** 给模型看的那一份里，本工程字段最多列几个；全量在 fields.tsv */
const OWN_FIELDS_SHOWN = 30;

/**
 * 摘要。`full` 是落盘的全量版（summary.txt）：所有字段、所有插件。
 * 给模型的那份只留排障最常用的：链、表、本工程字段的前几十个、挂了非原厂插件的操作和非原厂表单插件；
 * 原厂插件只报个数（全量在 summary.txt，要看再 grep）。
 */
export function renderSide(
	summary: SideSummary,
	number: string,
	projectIsv: string,
	dir: string,
	full = false,
): string {
	const lines: string[] = [];
	const entity = summary.entity;
	const vendorRows = new Set(
		[...summary.entityOrder, ...summary.formOrder].filter((r) => r.fisv === "kingdee").map((r) => r.fnumber),
	);
	const vendor = (p: MetaPlugin): boolean => vendorRows.has(p.from);
	const plugin = (p: MetaPlugin): string =>
		`${p.className}${p.enabled ? "" : "(停用)"}${vendor(p) ? "" : ` ← ${p.from}`}`;
	lines.push(`实体合并顺序（${String(summary.entityOrder.length)} 行）：${orderLine(summary.entityOrder) || "(无)"}`);
	lines.push(`布局合并顺序（${String(summary.formOrder.length)} 行）：${orderLine(summary.formOrder) || "(无)"}`);
	const latest = [...summary.entityOrder, ...summary.formOrder]
		.filter((r) => r.fmodifydate !== "")
		.sort((a, b) => b.fmodifydate.localeCompare(a.fmodifydate))[0];
	if (latest !== undefined) lines.push(`最近一次改动：${latest.fnumber} ${latest.fmodifydate}`);
	for (const problem of summary.broken) lines.push(`⚠ ${problem}`);
	if (entity !== null) {
		lines.push("", "表：");
		for (const [index, part] of entity.entities.entries())
			lines.push(
				`  ${index === 0 ? `${number}（单据头）` : part.key}  ${part.name}  ${part.table || "(元数据里没写表名)"}`,
			);
		const own = full
			? entity.fields
			: entity.fields.filter((f) => projectIsv !== "" && f.key.startsWith(`${projectIsv}_`));
		const shown = full ? own : own.slice(0, OWN_FIELDS_SHOWN);
		lines.push(
			"",
			full
				? `字段 ${String(entity.fields.length)} 个：`
				: `字段 ${String(entity.fields.length)} 个，其中 ${projectIsv}_ 开头的 ${String(own.length)} 个（全表 key/名称/分录/表/列：${join(dir, "fields.tsv")}）：`,
		);
		for (const f of shown)
			lines.push(
				`  ${f.entityKey ? `${f.entityKey}.` : ""}${f.key}  ${f.name}  ${f.table}.${f.column}${f.mustInput ? "  必录" : ""}`,
			);
		if (own.length > shown.length) lines.push(`  …另有 ${String(own.length - shown.length)} 个，grep fields.tsv`);
		const byWhere = new Map<string, MetaPlugin[]>();
		for (const p of entity.opPlugins) byWhere.set(p.where, [...(byWhere.get(p.where) ?? []), p]);
		const listed = [...byWhere].filter(([, plugins]) => full || plugins.some((p) => !vendor(p)));
		lines.push(
			"",
			full
				? `操作 ${String(entity.operations.length)} 个；操作插件和校验器：`
				: `操作 ${String(entity.operations.length)} 个；挂了非原厂插件的 ${String(listed.length)} 个（原厂插件只计数）：`,
		);
		if (listed.length === 0) lines.push("  (无)");
		for (const [where, plugins] of listed) {
			const mine = full ? plugins : plugins.filter((p) => !vendor(p));
			const rest = plugins.length - mine.length;
			lines.push(`  ${where}：${mine.map(plugin).join("、")}${rest > 0 ? `（另有原厂 ${String(rest)} 个）` : ""}`);
		}
	}
	const formMine = full ? summary.formPlugins : summary.formPlugins.filter((p) => !vendor(p));
	lines.push(
		"",
		full
			? `表单插件 ${String(summary.formPlugins.length)} 个：`
			: `表单插件 ${String(summary.formPlugins.length)} 个，非原厂 ${String(formMine.length)} 个：`,
	);
	for (const p of formMine) lines.push(`  ${plugin(p)}${p.description ? `  ${p.description}` : ""}`);
	if (!full) lines.push("", `全量（所有字段、原厂插件）：${join(dir, "summary.txt")}；每一层的 XML 原文在同一目录。`);
	return lines.join("\n");
}

export interface MetaDiff {
	onlyProdRows: string[];
	onlyTestRows: string[];
	changedRows: string[];
	fieldsOnlyProd: string[];
	fieldsOnlyTest: string[];
	fieldsChanged: string[];
	pluginsOnlyProd: string[];
	pluginsOnlyTest: string[];
	pluginsEnabledDiffer: string[];
}

function rowKey(r: MetaRow): string {
	return `${r.fnumber}.${r.kind}`;
}

export function diffSides(
	prodRows: readonly MetaRow[],
	prod: SideSummary,
	testRows: readonly MetaRow[],
	test: SideSummary,
): MetaDiff {
	const testByKey = new Map(testRows.map((r) => [rowKey(r), r]));
	const prodByKey = new Map(prodRows.map((r) => [rowKey(r), r]));
	const changedRows: string[] = [];
	for (const [key, row] of prodByKey) {
		const other = testByKey.get(key);
		if (other !== undefined && other.fdata.replace(/\s+/g, "") !== row.fdata.replace(/\s+/g, ""))
			changedRows.push(`${key}（生产 ${row.fmodifydate || "?"}，测试 ${other.fmodifydate || "?"}）`);
	}
	const fieldKey = (f: { entityKey: string; key: string }): string =>
		f.entityKey ? `${f.entityKey}.${f.key}` : f.key;
	const prodFields = new Map((prod.entity?.fields ?? []).map((f) => [fieldKey(f), f]));
	const testFields = new Map((test.entity?.fields ?? []).map((f) => [fieldKey(f), f]));
	const fieldsChanged: string[] = [];
	for (const [key, f] of prodFields) {
		const t = testFields.get(key);
		if (t === undefined) continue;
		const diffs: string[] = [];
		if (t.column !== f.column || t.table !== f.table)
			diffs.push(`列 生产 ${f.table}.${f.column} / 测试 ${t.table}.${t.column}`);
		if (t.mustInput !== f.mustInput)
			diffs.push(`必录 生产${f.mustInput ? "是" : "否"} / 测试${t.mustInput ? "是" : "否"}`);
		if (t.name !== f.name) diffs.push(`名称 生产「${f.name}」/ 测试「${t.name}」`);
		if (diffs.length > 0) fieldsChanged.push(`${key}：${diffs.join("；")}`);
	}
	const pluginKey = (p: MetaPlugin): string => `${p.where} ${p.className}`;
	const prodPlugins = new Map([...(prod.entity?.opPlugins ?? []), ...prod.formPlugins].map((p) => [pluginKey(p), p]));
	const testPlugins = new Map([...(test.entity?.opPlugins ?? []), ...test.formPlugins].map((p) => [pluginKey(p), p]));
	const pluginsEnabledDiffer: string[] = [];
	for (const [key, p] of prodPlugins) {
		const t = testPlugins.get(key);
		if (t !== undefined && t.enabled !== p.enabled)
			pluginsEnabledDiffer.push(`${key}：生产${p.enabled ? "启用" : "停用"} / 测试${t.enabled ? "启用" : "停用"}`);
	}
	const only = <T>(a: Map<string, T>, b: Map<string, T>): string[] => [...a.keys()].filter((k) => !b.has(k)).sort();
	return {
		onlyProdRows: only(prodByKey, testByKey),
		onlyTestRows: only(testByKey, prodByKey),
		changedRows,
		fieldsOnlyProd: only(prodFields, testFields),
		fieldsOnlyTest: only(testFields, prodFields),
		fieldsChanged,
		pluginsOnlyProd: only(prodPlugins, testPlugins),
		pluginsOnlyTest: only(testPlugins, prodPlugins),
		pluginsEnabledDiffer,
	};
}

/** 逐项报数，0 也报：漏一行，读的人会猜成「没有差别」 */
export function renderDiff(diff: MetaDiff): string {
	const section = (title: string, items: readonly string[], cap = 40): string[] => [
		`${title}：${String(items.length)}`,
		...items.slice(0, cap).map((item) => `  ${item}`),
		...(items.length > cap ? [`  …另有 ${String(items.length - cap)} 项`] : []),
	];
	return [
		...section("只在生产有的元数据行", diff.onlyProdRows),
		...section("只在测试有的元数据行", diff.onlyTestRows),
		...section("两边都有但内容不同的行", diff.changedRows),
		...section("只在生产有的字段", diff.fieldsOnlyProd),
		...section("只在测试有的字段", diff.fieldsOnlyTest),
		...section("两边都有但属性不同的字段", diff.fieldsChanged),
		...section("只在生产挂着的插件", diff.pluginsOnlyProd),
		...section("只在测试挂着的插件", diff.pluginsOnlyTest),
		...section("启停不同的插件", diff.pluginsEnabledDiffer),
	].join("\n");
}
