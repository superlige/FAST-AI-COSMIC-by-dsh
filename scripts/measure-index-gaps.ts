/**
 * 源码里写了、代码关系表没记的标识，按写法分类计数（S17 批 3 的尺子）。
 *
 *   node --experimental-strip-types scripts/measure-index-gaps.ts <工程目录> [--isv zlgd] [--json] [--samples N] [--callees]
 *
 * 读工程里已建好的 `.cosmic-ai/work/impact.json` 和源码，不连环境、不重建。只读，不改任何东西。
 *
 * 口径：
 *   - 一"处"是一个源码行里出现的一个 `<isv>_` 标识：写在字符串里的，或者用了值是这个标识的字符串常量
 *     （`SysTestBillCon.KEY_ZLGD_WTDH`、同文件里的 `KEY_X`）。常量声明那一行不算，算用到它的那一行；
 *     没人用的常量另报个数。注释不算。
 *   - 表记下了：表里同一文件这一行有同一个标识的字段读写或单据引用（点号路径按段比）；
 *     或者往上 6 行内有，而且中间没有语句结束（链式调用跨行时，表记在调用起头那一行）；
 *     或者这条语句是给局部变量赋值，往下 40 行内用到这个变量的那一行有（字段串先存变量再交给 load）。
 *   - 标识分三种：快照里是某张单字段的（字段）、快照里是单据的（单据标识）、快照不认识的。
 *     快照的字段归属只收代码点过名的字段，所以"快照不认识"里也有真字段，单独列。
 *   - 没记的按这一行的写法分类，先命中的算：
 *       查询条件      行里有 QFilter，或 `.and("…"` / `.or("…"`
 *       取数字段串    字符串里有逗号，或行里是 load / loadSingle / query / queryOne / queryDataSet 这类取数调用
 *       操作预加载    `getFieldKeys().add(…)`，或接住 getFieldKeys() 的变量 `.add(…)`（操作插件声明要加载的字段）
 *       报表过滤条件  行里有 getFilter / FilterInfo / getFilterItem（报表查询面板上的字段）
 *       转换插件      addSrcField、FindByEntityKey、getSrcFieldKey、getTargetFieldKey 等
 *       DataSet 运算  `.select(` `.groupBy(` `.orderBy(` `.filter(` `.addField(` `.join(` `.on(` 等
 *       父子页面传参  customParam、ShowParameter、setFormId、setBillFormId
 *       界面控件      setVisible、setEnable、setMustInput、getControl、addClickListeners、updateView 等
 *       名字比较      `equals("…")`、`case "…":`、`contains("…")`（属性变更、按钮事件里按名字判断）
 *       点号路径      标识前后连着 `.段`
 *       放进 Map      `.put(` / `.get(` / `containsKey(`，调用对象不是数据包（是数据包的话表会记）
 *       拼在文字里    字符串里还有空格、中文、SQL 关键字等，标识只是其中一段
 *       其他          以上都不是；`--callees` 按外层调用的方法名再分
 */
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ImpactIndex, SrcRef } from "../src/kernel/impact/model.ts";

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
	const at = args.indexOf(name);
	return at >= 0 ? args[at + 1] : undefined;
};
const isv = opt("--isv") ?? "zlgd";
const sampleCap = Number(opt("--samples") ?? 3);
const root = args.find((a, i) => !a.startsWith("--") && !["--isv", "--samples"].includes(args[i - 1] ?? ""));
if (root === undefined) {
	console.error(
		"用法：node --experimental-strip-types scripts/measure-index-gaps.ts <工程目录> [--isv zlgd] [--json]",
	);
	process.exit(2);
}
const index = JSON.parse(readFileSync(join(root, ".cosmic-ai", "work", "impact.json"), "utf8")) as ImpactIndex & {
	entityRefs: SrcRef[];
	fieldRefs: SrcRef[];
};

const fileOf = new Map(index.classes.map((c) => [c.class, c.file]));
const outerFile = (cls: string): string | null | undefined =>
	fileOf.get(cls) ?? fileOf.get(cls.split("$")[0] as string);

// 表记下的：文件 → 行 → 标识（点号路径拆成段）
const recorded = new Map<string, Map<number, Set<string>>>();
const recordedKeys = new Set<string>();
const note = (cls: string, line: number | undefined, key: string | null | undefined) => {
	if (!key) return;
	for (const part of key.split(".")) recordedKeys.add(part);
	const file = outerFile(cls);
	if (!file || line === undefined) return;
	const lines = recorded.get(file) ?? new Map<number, Set<string>>();
	recorded.set(file, lines);
	const keys = lines.get(line) ?? new Set<string>();
	lines.set(line, keys);
	for (const part of key.split(".")) keys.add(part);
};
for (const r of index.fieldRefs) note(r.class, r.line, r.field);
for (const r of index.entityRefs) note(r.class, r.line, r.entity);

const bills = new Set<string>();
for (const r of index.entityRefs) if (r.entity) bills.add(r.entity);
for (const c of index.classes) for (const b of c.bindings) bills.add(b.entity);
for (const f of index.fields ?? []) bills.add(f.entity);
const fieldKeys = new Set((index.fields ?? []).map((f) => f.key));
const KINDS = ["字段", "单据标识", "快照不认识"] as const;
type Kind = (typeof KINDS)[number];
const kindOf = (key: string): Kind => (fieldKeys.has(key) ? "字段" : bills.has(key) ? "单据标识" : "快照不认识");

const CATEGORIES = [
	"查询条件",
	"取数字段串",
	"操作预加载",
	"报表过滤条件",
	"转换插件",
	"DataSet 运算",
	"父子页面传参",
	"界面控件",
	"名字比较",
	"点号路径",
	"放进 Map",
	"拼在文字里",
	"其他",
] as const;
type Category = (typeof CATEGORIES)[number];
const CONSTANT = /\bstatic\s+final\s+String\s+(\w+)\s*=\s*"((?:[^"\\]|\\.)*)"\s*;/;
const LOADS = /\b(load|loadSingle|loadFromCache|query|queryOne|queryDataSet|queryPrimaryKeys|exists)\s*\(/;
const PRELOAD = /getFieldKeys\(\)\s*\.\s*(add|addAll)\s*\(/;
const BOTP =
	/addSrcField|FindByEntityKey|getSrcFieldKey|getTargetFieldKey|SrcEntity|TargetEntity|getSrcMainType|LinkSetItem/;
const DATASET =
	/\.(select|groupBy|orderBy|filter|addField|addFields|join|leftJoin|on|sum|max|min|count|distinct|where)\s*\(/;
const PARAMS = /[Cc]ustomParam|ShowParameter|setFormId|setBillFormId|setParentPageId/;
const CONTROLS =
	/setVisible|setEnable|setMustInput|getControl|addClickListeners|addItemClickListeners|updateView|setBillNoVisible|setLock|setFocus|F7SelectListener|setComboItems|registerListener|addHyperClickListener|setCellStyle|getItemKey|getOperateKey|invokeOperation|setDisplayFormatString/;
const COMPARE = /equals(IgnoreCase)?\s*\(|case\s+["A-Z]|contains\s*\(|startsWith\s*\(/;
const MAP = /\.(put|get|getOrDefault|containsKey|remove)\s*\(/;

/** 本文件里接住 `getFieldKeys()` 的变量名：`List<String> keys = e.getFieldKeys(); keys.add("x")` 也是操作预加载。 */
let preloadVars: string[] = [];
function categorize(line: string, value: string, key: string): Category {
	if (/QFilter/.test(line) || /\.(and|or)\s*\(\s*["A-Z]/.test(line)) return "查询条件";
	if (value.includes(",") || LOADS.test(line)) return "取数字段串";
	if (PRELOAD.test(line) || preloadVars.some((v) => new RegExp(`\\b${v}\\s*\\.\\s*(add|addAll)\\s*\\(`).test(line)))
		return "操作预加载";
	if (/\b(getFilter|filterInfo|FilterInfo|getFilterItem)\b/.test(line)) return "报表过滤条件";
	if (BOTP.test(line)) return "转换插件";
	if (DATASET.test(line)) return "DataSet 运算";
	if (PARAMS.test(line)) return "父子页面传参";
	if (CONTROLS.test(line)) return "界面控件";
	if (COMPARE.test(line)) return "名字比较";
	if (new RegExp(`(\\w\\.${key}\\b|\\b${key}\\.\\w)`).test(value)) return "点号路径";
	if (MAP.test(line)) return "放进 Map";
	if (!/^[\w.]+$/.test(value)) return "拼在文字里";
	return "其他";
}

/** 出现位置外面最近一层调用的方法名（`--callees` 用）。 */
function calleeAt(line: string, at: number): string {
	let depth = 0;
	for (let i = at - 1; i >= 0; i--) {
		const ch = line[i];
		if (ch === ")") depth++;
		else if (ch === "(") {
			if (depth === 0) return /(\w+)\s*$/.exec(line.slice(0, i))?.[1] ?? "(无)";
			depth--;
		}
	}
	return "(不在调用里)";
}

// ── 第一遍：读源码，收字符串常量 ──
interface Source {
	file: string;
	cls: string;
	lines: string[];
}
const files = [...new Set(index.classes.map((c) => c.file).filter((f): f is string => typeof f === "string"))];
const sources: Source[] = [];
for (const file of files) {
	try {
		const text = readFileSync(join(root, file), "utf8");
		sources.push({ file, cls: basename(file, ".java"), lines: text.split(/\r?\n/) });
	} catch {
		// 文件不在了：表比源码旧，跳过
	}
}
const qualified = new Map<string, string>(); // Cls.NAME → 值
const local = new Map<string, Map<string, string>>(); // 文件 → NAME → 值
const bare = new Map<string, Set<string>>(); // NAME → 全工程出现过的值
const declared: { file: string; name: string; value: string; line: number }[] = [];
for (const s of sources) {
	const mine = new Map<string, string>();
	s.lines.forEach((l, i) => {
		const m = CONSTANT.exec(l);
		if (!m) return;
		const [, name, value] = m as unknown as [string, string, string];
		if (!new RegExp(`\\b${isv}_`).test(value)) return;
		mine.set(name, value);
		qualified.set(`${s.cls}.${name}`, value);
		const set = bare.get(name) ?? new Set<string>();
		bare.set(name, set);
		set.add(value);
		declared.push({ file: s.file, name, value, line: i + 1 });
	});
	local.set(s.file, mine);
}
const constantValue = (file: string, cls: string | undefined, name: string): string | undefined => {
	if (cls) return qualified.get(`${cls}.${name}`);
	const mine = local.get(file)?.get(name);
	if (mine !== undefined) return mine;
	const values = bare.get(name);
	return values?.size === 1 ? [...values][0] : undefined;
};

// ── 第二遍：逐行找出现处 ──
interface Hit {
	file: string;
	line: number;
	key: string;
	text: string;
	callee: string;
	viaConstant: boolean;
}
const totals = Object.fromEntries(KINDS.map((k) => [k, { all: 0, kept: 0, viaConstant: 0 }])) as Record<
	Kind,
	{ all: number; kept: number; viaConstant: number }
>;
const missed = Object.fromEntries(
	KINDS.map((k) => [k, Object.fromEntries(CATEGORIES.map((c) => [c, [] as Hit[]]))]),
) as Record<Kind, Record<Category, Hit[]>>;
const usedConstant = new Set<string>();
const TOKEN = new RegExp(`\\b${isv}_\\w+`, "g");
const ends = (l: string) => /[;{}]\s*(\/\/.*)?$/.test(l.trim());

for (const s of sources) {
	const rec = recorded.get(s.file);
	preloadVars = [...s.lines.join("\n").matchAll(/(\w+)\s*=\s*[\w.()]*getFieldKeys\(\)/g)].map((m) => m[1] as string);
	// 每一行所在的整条语句（从上一个语句结束处到本行之后第一个语句结束处），写法按整条语句判
	const statementOf: string[] = [];
	{
		let start = 0;
		for (let i = 0; i < s.lines.length; i++) {
			if (ends(s.lines[i] as string) || i === s.lines.length - 1) {
				const text = s.lines
					.slice(start, i + 1)
					.map((l) => l.replace(/\/\/.*$/, "").trim())
					.join(" ");
				for (let j = start; j <= i; j++) statementOf[j] = text;
				start = i + 1;
			}
		}
	}
	let inBlock = false;
	s.lines.forEach((raw, i) => {
		const lineNo = i + 1;
		let line = raw;
		if (inBlock) {
			const end = line.indexOf("*/");
			if (end < 0) return;
			line = line.slice(end + 2);
			inBlock = false;
		}
		const trimmed = line.trim();
		if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("@")) return;
		if (trimmed.startsWith("/*")) {
			if (!trimmed.includes("*/")) inBlock = true;
			return;
		}
		if (CONSTANT.test(line)) return;
		const occurrences: { value: string; at: number; viaConstant: boolean }[] = [];
		const literals = /"((?:[^"\\]|\\.)*)"/g;
		for (const m of line.matchAll(literals))
			occurrences.push({ value: m[1] as string, at: m.index, viaConstant: false });
		const code = line.replace(literals, (m) => " ".repeat(m.length)).replace(/\/\/.*$/, "");
		for (const m of code.matchAll(/\b(?:([A-Z]\w*)\s*\.\s*)?([A-Z][A-Z0-9_]*[A-Z0-9])\b/g)) {
			const value = constantValue(s.file, m[1], m[2] as string);
			if (value === undefined) continue;
			usedConstant.add(`${m[1] ? m[1] : s.cls}.${m[2]}=${value}`);
			usedConstant.add(`${m[2]}=${value}`);
			occurrences.push({ value, at: m.index, viaConstant: true });
		}
		const seen = new Set<string>();
		for (const o of occurrences) {
			for (const t of o.value.matchAll(TOKEN)) {
				const key = t[0];
				if (seen.has(key)) continue;
				seen.add(key);
				const kind = kindOf(key);
				totals[kind].all++;
				if (o.viaConstant) totals[kind].viaConstant++;
				let kept = rec?.get(lineNo)?.has(key) ?? false;
				for (let back = 1; back <= 6 && !kept; back++) {
					const prev = s.lines[i - back];
					if (prev === undefined || ends(prev)) break;
					kept = rec?.get(lineNo - back)?.has(key) ?? false;
				}
				// 先赋给局部变量、下几行再交出去（`String fields = "a,b"; load(X, fields, …)`）：表记在用变量的那一行
				const local = /^(?:final\s+)?(?:String\s+)?(\w+)\s*\+?=(?!=)/.exec(statementOf[i] ?? "")?.[1];
				for (let ahead = 1; ahead <= 40 && !kept && local; ahead++) {
					const next = s.lines[i + ahead];
					if (next === undefined) break;
					kept = new RegExp(`\\b${local}\\b`).test(next) && (rec?.get(lineNo + ahead)?.has(key) ?? false);
				}
				if (kept) {
					totals[kind].kept++;
					continue;
				}
				const statement = statementOf[i] ?? line;
				const at = statement.indexOf(trimmed);
				missed[kind][categorize(statement, o.value, key)].push({
					file: s.file,
					line: lineNo,
					key,
					text: trimmed,
					callee: calleeAt(
						statement,
						(at < 0 ? 0 : at) + Math.max(0, o.at - (line.length - line.trimStart().length)),
					),
					viaConstant: o.viaConstant,
				});
			}
		}
	});
}
const unusedConstants = declared.filter((d) => !usedConstant.has(`${d.name}=${d.value}`));

const pct = (n: number, d: number) => (d === 0 ? "—" : `${Math.round((n / d) * 100)}%`);
const stat = (hits: Hit[]) => ({
	sites: hits.length,
	viaConstant: hits.filter((h) => h.viaConstant).length,
	keys: new Set(hits.map((h) => h.key)).size,
	keysNeverRecorded: new Set(hits.filter((h) => !recordedKeys.has(h.key)).map((h) => h.key)).size,
	files: new Set(hits.map((h) => h.file)).size,
});
const report = {
	isv,
	files: sources.length,
	constants: { declared: declared.length, unused: unusedConstants.length },
	totals: Object.fromEntries(
		KINDS.map((k) => [
			k,
			{ ...totals[k], missed: totals[k].all - totals[k].kept, keptRate: pct(totals[k].kept, totals[k].all) },
		]),
	),
	byCategory: Object.fromEntries(
		KINDS.map((k) => [k, Object.fromEntries(CATEGORIES.map((c) => [c, stat(missed[k][c])]))]),
	),
};
if (args.includes("--json")) {
	console.log(JSON.stringify(report, null, 2));
	process.exit(0);
}
console.log(
	`扫 ${sources.length} 个源文件。${isv}_ 字符串常量 ${declared.length} 个，其中没人用 ${unusedConstants.length} 个（不计）。`,
);
console.log("出现处（同一行同一标识算一处；含经常量用到的）：");
for (const k of KINDS) {
	const v = report.totals[k] as { all: number; kept: number; viaConstant: number; missed: number; keptRate: string };
	console.log(`  ${k}：${v.all} 处（经常量 ${v.viaConstant}），表记下 ${v.kept}（${v.keptRate}），没记 ${v.missed}`);
}
for (const k of KINDS) {
	console.log(`\n没记的${k}，按写法（处 / 其中经常量 / 标识 / 其中整张表一处没记的标识 / 文件）：`);
	for (const c of CATEGORIES) {
		const s = stat(missed[k][c]);
		if (s.sites === 0) continue;
		console.log(
			`  ${c.padEnd(8, "　")} ${s.sites} / ${s.viaConstant} / ${s.keys} / ${s.keysNeverRecorded} / ${s.files}`,
		);
		for (const h of missed[k][c].slice(0, sampleCap)) {
			console.log(`      ${h.file.split("/").pop()}:${h.line}  ${h.text.slice(0, 110)}`);
		}
	}
	if (args.includes("--callees")) {
		const by = new Map<string, number>();
		for (const h of missed[k].其他) by.set(h.callee, (by.get(h.callee) ?? 0) + 1);
		const top = [...by].sort((a, b) => b[1] - a[1]).slice(0, 25);
		console.log(`  "其他"按外层调用的方法：${top.map(([n, c]) => `${n} ${c}`).join("、")}`);
	}
}
