/**
 * S17 1.7～1.12 的尺子：工具在后台自动读代码关系表的几处，会不会把错的话交给模型。
 *
 *   node scripts/measure-auto-index.mjs <工程目录> [--old <旧 impact.json>]
 *
 * 只读。量五样：
 *   1. 分录操作（取分录、增删行）表里记下几处——登记在子接口、方法声明在父接口时一处都记不到；
 *   2. 带点号的路径（`分录.字段`、`基础资料.属性`）各有几处——按字段查询时要能对上；
 *   3. 挂在单据操作链等非界面位置的插件，有几个只经本工程工具类才调到外部接口（表里记了外部调用才量得出）；
 *   4. 打印模板里平台已经认过的绑定字段，表的字段归属认得几个——认不得的，表不能说「单据上没有」；
 *   5. 给了 --old：拿旧快照和现在的比，编译后提示、跑前提醒、模拟表单警告会有几条说法变了。
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const root = args.find((arg) => !arg.startsWith("--")) ?? "D:/kingdee/zlgd_ygpt2.0";
const oldAt = args.indexOf("--old");
const work = join(root, ".cosmic-ai/work");
const ix = JSON.parse(readFileSync(join(work, "impact.json"), "utf8"));
const short = (name) => String(name).split(".").pop();
const method = (id) => String(id).replace(/\(.*$/, "");

console.log(`代码关系表建于 ${ix.at}，元数据快照建于 ${ix.meta?.at ?? "（没有）"}`);

// 1. 分录操作
const ENTRY_OPS = [
	"getEntryEntity",
	"getEntryRowEntity",
	"getEntryRowCount",
	"getEntryCurrentRowIndex",
	"createNewEntryRow",
	"batchCreateNewEntryRow",
	"insertEntryRow",
	"appendEntryRow",
	"copyEntryRow",
	"moveEntryRowUp",
	"moveEntryRowDown",
	"deleteEntryRow",
	"deleteEntryRows",
	"deleteEntryData",
];
const ops = {};
for (const ref of ix.fieldRefs) {
	const name = String(ref.via).split("#")[1]?.split("(")[0];
	if (ENTRY_OPS.includes(name)) ops[name] = (ops[name] ?? 0) + 1;
}
const opTotal = Object.values(ops).reduce((a, b) => a + b, 0);
console.log(`\n[分录操作] 表里记下 ${opTotal} 处：${JSON.stringify(ops)}；未登记重载 ${ix.src.unknownSigs.length} 个`);

// 2. 点号路径
const containers = new Set(ix.fields.filter((row) => row.kind === "container").map((row) => row.key));
const known = new Set(ix.fields.map((row) => row.key));
let entryPath = 0;
let propPath = 0;
let other = 0;
for (const ref of ix.fieldRefs) {
	if (!ref.field?.includes(".") || !(ref.resolution === "literal" || ref.resolution === "constant")) continue;
	const segments = ref.field.split(".");
	if (containers.has(segments[0])) entryPath++;
	else if (known.has(segments[0])) propPath++;
	else other++;
}
console.log(`[点号路径] 分录开头 ${entryPath} 处，字段.属性 ${propPath} 处，快照里认不出首段的 ${other} 处`);

// 3. 经工具类调到的外部调用（只看非界面登记的插件；自己的方法里就有的不算）
if (!Array.isArray(ix.effects)) {
	console.log("[外部调用] 表里没记外部调用（旧版建的），量不了");
} else {
	const effectsAt = new Map();
	for (const row of ix.effects) if (row.inMethod) effectsAt.set(row.inMethod, row.effect);
	const callees = new Map();
	const starts = new Map();
	for (const edge of ix.edges ?? []) {
		if (!callees.has(edge.from)) callees.set(edge.from, []);
		callees.get(edge.from).push(edge);
		if (!starts.has(edge.fromClass)) starts.set(edge.fromClass, new Set());
		starts.get(edge.fromClass).add(edge.from);
	}
	const UI = new Set(["form", "print"]);
	let registered = 0;
	let own = 0;
	const via = [];
	for (const cls of ix.classes) {
		if (!cls.bindings.some((b) => !UI.has(b.kind))) continue;
		registered++;
		if (ix.effects.some((row) => row.class === cls.class)) {
			own++;
			continue;
		}
		const seen = new Set(starts.get(cls.class) ?? []);
		const parent = new Map();
		let frontier = [...seen];
		let hit = null;
		for (let depth = 0; frontier.length > 0 && depth < 12 && hit === null; depth++) {
			const next = [];
			for (const at of frontier) {
				for (const edge of callees.get(at) ?? []) {
					if (seen.has(edge.to)) continue;
					seen.add(edge.to);
					parent.set(edge.to, at);
					next.push(edge.to);
					if (hit === null && edge.toClass !== cls.class && effectsAt.has(edge.to)) hit = edge.to;
				}
			}
			frontier = next;
		}
		if (hit === null) continue;
		const path = [];
		for (let cur = hit; cur !== undefined; cur = parent.get(cur)) path.unshift(short(method(cur)));
		via.push(`${short(cls.class)}（${effectsAt.get(hit)}）${path.join(" → ")}`);
	}
	console.log(
		`[外部调用] 表里 ${ix.effects.length} 处；非界面登记的插件 ${registered} 个，自己调的 ${own} 个，只经工具类调到的 ${via.length} 个`,
	);
	for (const line of via) console.log(`  ${line}`);
}

// 4. 打印模板已绑字段，表认得几个
const designs = [];
const walk = (dir) => {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) walk(path);
		else if (name.endsWith(".meta.json")) designs.push(path);
	}
};
walk(work);
const seenTemplates = new Set();
const pairs = new Map();
for (const file of designs) {
	let design;
	try {
		design = JSON.parse(readFileSync(file, "utf8"));
	} catch {
		continue;
	}
	const formId = String(design.formId ?? "");
	const id = `${formId}|${design.key ?? design.id}`;
	if (!formId || seenTemplates.has(id)) continue;
	seenTemplates.add(id);
	for (const match of JSON.stringify(design).matchAll(/"bindField":"([^"]+)"/g)) {
		if (!pairs.has(formId)) pairs.set(formId, new Set());
		pairs.get(formId).add(match[1].split(".")[0]);
	}
}
let bound = 0;
let inTable = 0;
for (const [formId, keys] of pairs) {
	for (const key of keys) {
		bound++;
		if (ix.fields.some((row) => row.entity === formId && row.key === key)) inTable++;
	}
}
console.log(
	`[打印模板字段] 工作目录里的模板 ${seenTemplates.size} 份：平台已认的绑定字段 ${bound} 个，表的字段归属认得 ${inTable} 个`,
);

// 5. 旧快照 vs 现在
if (oldAt >= 0 && args[oldAt + 1]) {
	const old = JSON.parse(readFileSync(args[oldAt + 1], "utf8"));
	const key = (b) => `${b.kind}:${b.entity}:${[...b.numbers].sort().join("/")}${b.enabled ? "" : "(停用)"}`;
	const before = new Map(old.classes.map((cls) => [cls.class, cls]));
	let same = 0;
	const said = { 旧说没登记: [], 旧说有现在没了: [], 位置变了: [] };
	for (const cls of ix.classes) {
		if (!cls.pluginType) continue;
		const a = (before.get(cls.class)?.bindings ?? []).map(key).sort().join(" | ");
		const b = cls.bindings.map(key).sort().join(" | ");
		if (a === b) same++;
		else if (a === "") said.旧说没登记.push(short(cls.class));
		else if (b === "") said.旧说有现在没了.push(short(cls.class));
		else said.位置变了.push(short(cls.class));
	}
	const targets = (index) => {
		const map = new Map();
		for (const cls of index.classes)
			for (const b of cls.bindings)
				for (const t of b.numbers.length > 0 ? b.numbers : [b.entity]) {
					if (!map.has(t)) map.set(t, new Set());
					map.get(t).add(`${cls.class}@${b.kind}`);
				}
		return map;
	};
	const ta = targets(old);
	const tb = targets(ix);
	let changed = 0;
	for (const t of new Set([...ta.keys(), ...tb.keys()])) {
		const a = [...(ta.get(t) ?? [])].sort().join();
		const b = [...(tb.get(t) ?? [])].sort().join();
		if (a !== b) changed++;
	}
	console.log(
		`\n[快照前后] 旧 ${old.meta?.at}（登记 ${old.meta?.bindings}）→ 现在 ${ix.meta?.at}（登记 ${ix.meta?.bindings}）`,
	);
	console.log(
		`  编译后提示：不变 ${same}；旧快照说没登记、现在有 ${said.旧说没登记.length}（${said.旧说没登记.join("、")}）；` +
			`旧说有、现在没了 ${said.旧说有现在没了.length}；位置变了 ${said.位置变了.length}（${said.位置变了.join("、")}）`,
	);
	console.log(`  跑前提醒 / 模拟表单警告：登记了本工程插件的目标 ${tb.size} 个，插件清单变了 ${changed} 个`);
	console.log(`  字段归属：${old.fields.length} → ${ix.fields.length} 条`);
}
