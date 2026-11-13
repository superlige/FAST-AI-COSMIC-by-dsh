/**
 * 给"单据.字段"，代码关系表能不能答出：哪些插件类读写它、在哪一行、经过几层调用、每一层是哪一步（S17 基线尺子）。
 *
 *   node --experimental-strip-types scripts/measure-field-trace.ts <工程目录> [--json]
 *
 * 读工程里已建好的代码关系表，用和 `cosmic_impact` 同一个查询函数出答案，再按下面的口径对照。不连环境、不重建。
 *
 * 样本：固定 34 个"单据.字段"，2026-10-03 从真机工程按四类各取 8 个（按标识的 md5 排序取前 8，不挑），另加 2 个反例：
 *   直接  只在一张单上、只在挂了单据的插件里读写；
 *   同名  多张单上都有这个标识；
 *   经调用 读写在工具类里，插件经一层或几层调用才走到；
 *   大单  检测单、委托单上的字段（字段多、插件多）；
 *   反例  单据上没有这个字段（应当说"不在这张单上，在哪"）、代码里写了这个标识但表里没记。
 * 样本固定写在下面，表重建后同一批样本复量。
 *
 * 口径（每个样本）：
 *   读写处    表里记下、标识解出来的每一处读写（类、方法、行号）。
 *   带行号    答案里能看到这一处的行号（同一行里出现类名或方法名，并出现这个行号）。
 *   入口插件  读写处不在挂了单据的类里时，按调用关系往上找最近的、挂了单据的类；答案里点到它的名字算答出。
 *   整条路径  上面那条调用路径上每一个方法都出现在答案里。
 *   表漏记    源码字符串里出现这个标识、表里同一文件却一处读写都没记（例如放进 Map、拼进查询字段串、经包装方法写）。
 *   归到别的单 答案判定为同名的另一张单上的读写处、没逐处列出的个数（S17 批 1 起的答案才有；之前恒为 0）。
 *   按名字猜  对象来源没认出、只按名字猜在这张单上的读写处，答案里只报个数和类名（S17 批 2 起；之前恒为 0）。
 *   读写处从 S17 批 2 起含经包装方法写的（`setValue(row, i, KEY, v)` 展开到调用处），同一批样本数会变多。
 *   v3（S17 批 3）：读写处按点号路径的段比（`zlgd_syentry.zlgd_samplno` 算 zlgd_samplno 的一处，和查询一致；
 *   v2 只认整串相等，带分录前缀的写法漏数、还被算成表漏记）；表从 S17 批 3 起另记查询条件、取数字段串、操作预加载。
 *   字节      答案的 UTF-8 字节。
 * 只读，不改任何东西。
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadIndex, queryImpact } from "../src/kernel/commands/impact.ts";
import type { ImpactIndex } from "../src/kernel/impact/model.ts";
import { openProject } from "../src/kernel/open-project.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";

const SAMPLES: Record<string, string[]> = {
	直接: [
		"zlgd_hxjspjz.zlgd_checkfour",
		"zlgd_watermark_manage.zlgd_before",
		"zlgd_digital_task_board.zlgd_wqd1",
		"zlgd_glmes_sbmc.zlgd_operatetime",
		"zlgd_mes_info_show.zlgd_required_weight",
		"zlgd_leaveap_board.zlgd_njwxts",
		"zlgd_lcxsrb.zlgd_num71",
		"zlgd_ypwbjgysd.zlgd_wtdid",
	],
	同名: [
		"zlgd_zdhhz.zlgd_dypj",
		"zlgd_sys_test_bill.zlgd_wtdh",
		"zlgd_salesinquiry.zlgd_outerdiameter",
		"zlgd_sdzx_rw.zlgd_remarks",
		"zlgd_qty_wtd.zlgd_wallthickness",
		"zlgd_qty_wtd.zlgd_cpbz_hxcf",
		"zlgd_material_contrast.zlgd_alloy",
		"zlgd_mes_filemsg_log.zlgd_error_msg",
	],
	经调用: [
		"zlgd_achment_interface.zlgd_appid",
		"zlgd_lcxsjyrb.zlgd_month_order_complete",
		"zlgd_achment_info.zlgd_relativeurl",
		"zlgd_scoring_method.zlgd_yc_targetvalue",
		"zlgd_lcxsjyrb.zlgd_year_order_complete",
		"zlgd_dept_asse_result.zlgd_fglddf1",
		"zlgd_filing.zlgd_purmethod_n",
		"zlgd_lcxsjyrb.zlgd_month_order_plan",
	],
	大单: [
		"zlgd_sys_test_bill.zlgd_zerl",
		"zlgd_sys_test_bill.zlgd_sysypbh_hx",
		"zlgd_sys_test_bill.zlgd_hfxjg3",
		"zlgd_qty_wtd.zlgd_sys_ypbh",
		"zlgd_sys_test_bill.zlgd_syffmul",
		"zlgd_sys_test_bill.zlgd_mbpz_jx",
		"zlgd_qty_wtd.zlgd_samplno",
		"zlgd_qty_wtd.zlgd_sfjc",
	],
	反例: ["zlgd_sys_test_bill.zlgd_jcjl", "zlgd_sys_test_bill.zlgd_nz_ls"],
};

const args = process.argv.slice(2);
const root = args.find((a) => !a.startsWith("--"));
if (root === undefined) {
	console.error("用法：node --experimental-strip-types scripts/measure-field-trace.ts <工程目录> [--json]");
	process.exit(2);
}
const opened = await openProject({
	projectRoot: root,
	agentConfigDir: join(homedir(), ".fast-ai-cosmic"),
	cacheRoot: mkdtempSync(join(tmpdir(), "field-trace-")),
	agentVersion: "dev",
	resources: EMBEDDED_RESOURCES,
});
const loaded = loadIndex(opened.ctx);
if (!loaded.ok) {
	console.error(`读不到代码关系表：${loaded.error.message}`);
	process.exit(2);
}
interface Ref {
	class: string;
	field: string | null;
	access: string;
	resolution: string;
	line: number;
	inMethod: string | null;
}
interface Edge {
	from: string;
	to: string;
	fromClass: string;
	toClass: string;
}
const index = loaded.value as ImpactIndex & { fieldRefs: Ref[] };
const srcIndex = JSON.parse(readFileSync(join(root, ".cosmic-ai", "work", "impact", "src-index.json"), "utf8")) as {
	edges?: Edge[];
};
const classes = new Map(index.classes.map((c) => [c.class, c]));
const bound = (cls: string) => (classes.get(cls)?.bindings.length ?? 0) > 0;
const callers = new Map<string, Edge[]>();
for (const edge of srcIndex.edges ?? []) {
	const list = callers.get(edge.to);
	if (list) list.push(edge);
	else callers.set(edge.to, [edge]);
}
const simple = (fqn: string) => (fqn.split(".").pop() ?? fqn).split("$")[0] as string;
/** 方法 id `a.b.C#m(X)` → `C#m`，答案里调用链就是这样写的。 */
const shortMethod = (id: string) => {
	const [cls, rest] = id.split("#");
	return `${simple(cls ?? "")}#${(rest ?? "").split("(")[0]}`;
};

/** 从读写处所在的方法往上找最近的挂了单据的类，返回整条路径（读写处方法在前）。找不到返回 null。 */
function pathToPlugin(method: string): string[] | null {
	const parent = new Map<string, string>();
	let frontier = [method];
	const seen = new Set(frontier);
	while (frontier.length > 0) {
		const next: string[] = [];
		for (const m of frontier) {
			for (const edge of callers.get(m) ?? []) {
				if (seen.has(edge.from)) continue;
				seen.add(edge.from);
				parent.set(edge.from, m);
				if (bound(edge.fromClass)) {
					const path = [edge.from];
					let at = edge.from;
					while (parent.has(at)) {
						at = parent.get(at) as string;
						path.push(at);
					}
					return path.reverse();
				}
				next.push(edge.from);
			}
		}
		frontier = next;
	}
	return null;
}

const javaText = new Map<string, string[]>();
const linesOf = (file: string): string[] => {
	let lines = javaText.get(file);
	if (lines === undefined) {
		try {
			lines = readFileSync(join(root, file), "utf8").split(/\r?\n/);
		} catch {
			lines = [];
		}
		javaText.set(file, lines);
	}
	return lines;
};

interface Row {
	group: string;
	term: string;
	ok: boolean;
	bytes: number;
	sites: number;
	withLine: number;
	needPath: number;
	entryNamed: number;
	fullPath: number;
	noPlugin: number;
	otherBill: number;
	guessed: number;
	literalFiles: number;
	missedFiles: number;
	missedSamples: string[];
	head: string;
}
const rows: Row[] = [];
for (const [group, terms] of Object.entries(SAMPLES)) {
	for (const term of terms) {
		const key = term.slice(term.lastIndexOf(".") + 1);
		const result = queryImpact(opened.ctx, { terms: [term] });
		const text = result.ok ? result.value.text : `${result.error.code} ${result.error.message}`;
		const textLines = text.split("\n");
		const sites = index.fieldRefs.filter(
			(r) =>
				typeof r.field === "string" &&
				r.field.split(".").includes(key) &&
				(r.resolution === "literal" || r.resolution === "constant"),
		);
		const row: Row = {
			group,
			term,
			ok: result.ok,
			bytes: Buffer.byteLength(text),
			sites: sites.length,
			withLine: 0,
			needPath: 0,
			entryNamed: 0,
			fullPath: 0,
			noPlugin: 0,
			otherBill: result.ok
				? (result.value.traces ?? []).reduce(
						(n, trace) => n + trace.excluded.reduce((m, group) => m + group.sites.length, 0),
						0,
					)
				: 0,
			guessed: result.ok
				? (result.value.traces ?? []).reduce(
						(n, trace) => n + (trace.guessed ?? []).reduce((m, group) => m + group.sites.length, 0),
						0,
					)
				: 0,
			literalFiles: 0,
			missedFiles: 0,
			missedSamples: [],
			head: textLines[0]?.slice(0, 120) ?? "",
		};
		for (const site of sites) {
			const names = [simple(site.class), site.inMethod ? shortMethod(site.inMethod) : ""].filter(Boolean);
			const lineRe = new RegExp(`(?<![\\d])${site.line}(?![\\d])`);
			if (textLines.some((l) => names.some((n) => l.includes(n)) && lineRe.test(l))) row.withLine++;
			if (bound(site.class) || !site.inMethod) continue;
			const path = pathToPlugin(site.inMethod);
			if (path === null) {
				row.noPlugin++;
				continue;
			}
			row.needPath++;
			const entry = path[path.length - 1] as string;
			if (text.includes(simple(entry.split("#")[0] as string))) row.entryNamed++;
			if (path.every((m) => text.includes(shortMethod(m)))) row.fullPath++;
		}
		// 表漏记：源码字符串里有这个标识的文件，表里在这个文件一处读写都没记。
		const siteFiles = new Set(sites.map((s) => classes.get(s.class)?.file).filter(Boolean));
		const literal = new RegExp(`"[^"\\n]*\\b${key}\\b[^"\\n]*"`);
		// 常量声明行不算：常量在别的文件里被用到时，读写处记在用的那个文件里。
		const constant = /\bstatic\s+final\s+String\s+\w+\s*=/;
		const files = new Set(index.classes.map((c) => c.file).filter((f): f is string => typeof f === "string"));
		for (const file of files) {
			const hits = linesOf(file).filter((l) => literal.test(l) && !constant.test(l));
			if (hits.length === 0) continue;
			row.literalFiles++;
			if (siteFiles.has(file)) continue;
			row.missedFiles++;
			row.missedSamples.push(`${file.split("/").pop()}: ${(hits[0] as string).trim().slice(0, 100)}`);
		}
		rows.push(row);
	}
}

const sum = (list: Row[], k: keyof Row) => list.reduce((a, r) => a + (r[k] as number), 0);
const groups = Object.keys(SAMPLES).map((group) => {
	const list = rows.filter((r) => r.group === group);
	return {
		group,
		samples: list.length,
		answered: list.filter((r) => r.ok).length,
		bytes: Math.round(sum(list, "bytes") / list.length),
		maxBytes: Math.max(...list.map((r) => r.bytes)),
		sites: sum(list, "sites"),
		withLine: sum(list, "withLine"),
		needPath: sum(list, "needPath"),
		entryNamed: sum(list, "entryNamed"),
		fullPath: sum(list, "fullPath"),
		noPlugin: sum(list, "noPlugin"),
		otherBill: sum(list, "otherBill"),
		guessed: sum(list, "guessed"),
		literalFiles: sum(list, "literalFiles"),
		missedFiles: sum(list, "missedFiles"),
	};
});
const report = {
	version: "s17-field-trace-v3",
	project: root,
	indexAt: index.at,
	metaAt: index.meta?.at ?? null,
	groups,
	rows,
};
if (args.includes("--json")) console.log(JSON.stringify(report, null, "\t"));
else {
	console.log(`代码关系表建于 ${report.indexAt}，元数据快照建于 ${report.metaAt}`);
	console.log(
		"组      样本 答出 平均字节 最大字节 | 读写处 带行号 归到别的单 按名字猜 | 要走调用 点到入口插件 整条路径 找不到插件 | 源码有标识的文件 表漏记",
	);
	for (const g of groups)
		console.log(
			`${g.group.padEnd(4, "　")} ${g.samples} ${g.answered} ${g.bytes} ${g.maxBytes} | ${g.sites} ${g.withLine} ${g.otherBill} ${g.guessed} | ${g.needPath} ${g.entryNamed} ${g.fullPath} ${g.noPlugin} | ${g.literalFiles} ${g.missedFiles}`,
		);
	console.log("\n反例的答案开头：");
	for (const r of rows.filter((x) => x.group === "反例")) console.log(`  ${r.term} → ${r.head}`);
	console.log("\n表漏记的样子：");
	for (const r of rows) for (const m of r.missedSamples) console.log(`  ${r.term}  ${m}`);
}
process.exit(0);
