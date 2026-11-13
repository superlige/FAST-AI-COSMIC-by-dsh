/**
 * 代码关系表能不能把一处字段读写定位到"哪张单的哪个字段"（S43 批 3 立项前的基线尺子）。
 *
 *   node --experimental-strip-types scripts/measure-field-attribution.ts <工程目录> [--isv zlgd] [--json]
 *
 * 读工程里已建好的 `.cosmic-ai/work/impact.json`，不连环境、不重建。
 *
 * 口径：
 *   - 每一处字段引用（代码部分记下的 `fieldRefs`，带文件行号）按现在查询时用的同一套办法归属：
 *     这个类碰到的单据集合（`impactOf` 按类算出来的 entities）和"有这个字段标识的单据"取交集（`qualifyField`）。
 *   - 归属结果分五档：
 *       定到一张单  交集正好一张；
 *       同名多张    交集两张及以上，查询里会列成"→A/B"；
 *       类没碰到    这个标识在别的单据上有，但不在这个类碰到的单据里（跨单据的对象从变量、方法参数传进来时就是这样）；
 *       库里没有    元数据快照里没有哪张单有这个标识（打印数据包的键、计算出来的名字、没扫到的单据）；
 *       字段名没解出 标识是变量拼出来的，或者签名里本来就没有标识。
 *   - "定到一张单"只说明交集唯一，不保证就是那张：类碰了 A、B 两张单，`b.set("x")` 的 x 只在 A 上有时，会被记到 A。
 *     所以另报"类只碰一张单"和"类碰多张单"两组，后一组的"定到一张单"是按名字猜出来的。
 *   - 按写法分：界面模型（IDataModel，读写的是当前界面这张单）、数据包（DynamicObject，可能是任何一张单）、打印数据包（DataRowSet）。
 *   - 另报"本 ISV 字段"一组：标识以 `<isv>_` 开头、不带点号路径的。平台自带字段（id、billno、number）和
 *     `org.number` 这种跨基础资料的路径要求里很少点名，混在一起会把比例拉偏。
 *   - 按对象来源归属（S17 批 2，查字段入口现在用的办法）：同一批读写处，按建表时记下的对象来源（`obj`），
 *     参数传进来的到调用处接着追，分五档：
 *       定到一张单    来源单里有这个字段的正好一张；
 *       挂几张单都有  对象是插件自己的单、插件挂在几张都有这个字段的单上（本来就该列几张）；
 *       来源单上没有  认出了对象是哪张单，快照说那张单上没这个字段（多半是继承字段、控件标识，或快照没收）；
 *       基础资料字段  对象是另一个字段引用的基础资料，不是单据本身；
 *       来源没认出    只能按名字猜。
 *     经包装方法写的字段（`setValue(row, i, KEY, v)`）S17 批 2 起展开成调用处的读写处，另报个数；两种办法比的是同一批。
 * `--moved` 逐处列出两种办法认定的单不一样的读写处，人工核对用。
 * 只读，不改任何东西。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { attributor } from "../src/kernel/impact/attribution.ts";
import { type ImpactIndex, impactOf, lookup, qualifyField } from "../src/kernel/impact/model.ts";

const args = process.argv.slice(2);
const isvAt = args.indexOf("--isv");
const isv = isvAt >= 0 ? String(args[isvAt + 1]) : "zlgd";
const root = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--isv");
if (root === undefined) {
	console.error("用法：node --experimental-strip-types scripts/measure-field-attribution.ts <工程目录> [--json]");
	process.exit(2);
}
const index = JSON.parse(readFileSync(join(root, ".cosmic-ai", "work", "impact.json"), "utf8")) as ImpactIndex;
const lk = lookup(index);

const BUCKETS = ["定到一张单", "同名多张", "类没碰到", "库里没有", "字段名没解出"] as const;
type Bucket = (typeof BUCKETS)[number];
const familyOf = (via: string): string =>
	// 分录操作声明在 IEntryOperate 上（S17 1.7 起才记下），也是界面模型
	via.startsWith("IDataModel#") || via.startsWith("IEntryOperate#")
		? "界面模型"
		: via.startsWith("DynamicObject#")
			? "数据包"
			: via.startsWith("DataRowSet#")
				? "打印数据包"
				: "其他";

const entitiesOf = new Map<string, Set<string>>();
const classEntities = (cls: string): Set<string> => {
	let set = entitiesOf.get(cls);
	if (set === undefined) {
		set = new Set(impactOf(index, [{ kind: "class", value: cls }], lk).entities.map((e) => e.key));
		entitiesOf.set(cls, set);
	}
	return set;
};

type Tally = Record<Bucket, number> & { total: number };
const blank = (): Tally => ({ total: 0, ...Object.fromEntries(BUCKETS.map((b) => [b, 0])) }) as Tally;
const byFamily: Record<string, Tally> = {};
const byScope: Record<string, Tally> = { 类只碰一张单: blank(), 类碰多张单: blank() };
const byAccess: Record<string, Tally> = { read: blank(), write: blank() };
const isvOnly: Record<string, Tally> = { 全部: blank(), 界面模型: blank(), 数据包: blank(), 写: blank() };
const all = blank();
const refs = (index as unknown as { fieldRefs: Array<Record<string, string | number | null>> }).fieldRefs;
/** 界面模型（IDataModel）读写的是插件挂的那张单：按元数据里的挂载关系另算一遍，看同名能消掉多少。 */
const boundOf = new Map<string, Set<string>>();
for (const c of (index as unknown as { classes: Array<{ class: string; bindings?: Array<{ entity: string }> }> })
	.classes)
	boundOf.set(c.class, new Set((c.bindings ?? []).map((b) => b.entity)));
const boundTry: Record<string, number> = {};
const keysSeen = new Set<string>();
const sameNamed = new Set<string>();
const ORIGIN = ["定到一张单", "挂几张单都有", "来源单上没有", "基础资料字段", "来源没认出"] as const;
type OriginBucket = (typeof ORIGIN)[number];
type OriginTally = Record<OriginBucket, number> & { total: number };
const blankOrigin = (): OriginTally => ({ total: 0, ...Object.fromEntries(ORIGIN.map((b) => [b, 0])) }) as OriginTally;
const byOrigin: Record<string, OriginTally> = {
	全部: blankOrigin(),
	本ISV字段: blankOrigin(),
	本ISV界面模型: blankOrigin(),
	本ISV数据包: blankOrigin(),
	本ISV写: blankOrigin(),
};
/** 本 ISV 字段：老办法（按类猜）怎么说、新办法（按对象来源）怎么说 */
const crossed: Record<string, number> = {};
const movedSites: string[] = [];
const simpleOf = (fqn: string) => fqn.split(".").pop() as string;
const attribute = attributor(index, lk, "快照");
const through = refs.filter((r) => r.through).length;

for (const ref of refs) {
	const cls = String(ref.class);
	const key = ref.field === null || ref.field === undefined ? null : String(ref.field);
	const resolved = ref.resolution === "literal" || ref.resolution === "constant";
	const entities = classEntities(cls);
	let bucket: Bucket;
	if (!resolved || key === null) bucket = "字段名没解出";
	else {
		keysSeen.add(key);
		const owners = lk.fieldOn.get(key) ?? [];
		if (owners.length > 1) sameNamed.add(key);
		const q = qualifyField(lk, entities, key);
		if (q.entity) bucket = "定到一张单";
		else if (q.candidates.length > 1) bucket = "同名多张";
		else if (owners.length > 0) bucket = "类没碰到";
		else bucket = "库里没有";
	}
	const family = familyOf(String(ref.via ?? ""));
	const scope = entities.size > 1 ? "类碰多张单" : "类只碰一张单";
	const access = ref.access === "write" ? "write" : "read";
	byFamily[family] ??= blank();
	const tallies = [all, byFamily[family], byScope[scope], byAccess[access]] as Tally[];
	if (key?.startsWith(`${isv}_`) && !key.includes(".")) {
		tallies.push(isvOnly.全部 as Tally);
		if (isvOnly[family]) tallies.push(isvOnly[family] as Tally);
		if (access === "write") tallies.push(isvOnly.写 as Tally);
	}
	for (const t of tallies) {
		t.total++;
		t[bucket]++;
	}
	if (resolved && key !== null) {
		const at = attribute.site(ref as never);
		const carrying = at.kind === "bill" ? at.bills.filter((b) => lk.fieldMeta.has(`${b}|${key}`)) : [];
		const origin: OriginBucket =
			at.kind === "prop"
				? "基础资料字段"
				: at.kind === "guess"
					? "来源没认出"
					: carrying.length === 1
						? "定到一张单"
						: carrying.length > 1
							? "挂几张单都有"
							: "来源单上没有";
		const list = [byOrigin.全部] as OriginTally[];
		if (key.startsWith(`${isv}_`) && !key.includes(".")) {
			list.push(byOrigin.本ISV字段 as OriginTally);
			if (family === "界面模型") list.push(byOrigin.本ISV界面模型 as OriginTally);
			if (family === "数据包") list.push(byOrigin.本ISV数据包 as OriginTally);
			if (access === "write") list.push(byOrigin.本ISV写 as OriginTally);
			const old = bucket === "定到一张单" ? qualifyField(lk, entities, key).entity : "";
			const moved = origin === "定到一张单" && old !== "" && old !== carrying[0] ? "（换了一张）" : "";
			const cross = `老办法${bucket} → 新办法${origin}${moved}`;
			if (moved) movedSites.push(`${simpleOf(ref.class)}:${ref.line} ${key} ${ref.access} ${old} → ${carrying[0]}`);
			crossed[cross] = (crossed[cross] ?? 0) + 1;
		}
		for (const t of list) {
			t.total++;
			t[origin]++;
		}
	}
	if (family === "界面模型" && key?.startsWith(`${isv}_`) && !key.includes(".")) {
		const bound = boundOf.get(cls) ?? new Set<string>();
		const q = qualifyField(lk, bound, key);
		const now = bucket === "定到一张单" ? "一张" : bucket === "同名多张" ? "多张" : "其他";
		const then = q.entity ? "一张" : q.candidates.length > 1 ? "多张" : "其他";
		const scope = bound.size === 0 ? "没挂在单据上" : bound.size === 1 ? "挂一张单" : "挂多张单";
		const row = `${scope}：现在${now} → 按挂的单据${then}`;
		boundTry[row] = (boundTry[row] ?? 0) + 1;
	}
}

const report = {
	version: "s17-field-v2",
	project: root,
	indexAt: (index as unknown as { at?: string }).at ?? null,
	fieldRefs: refs.length,
	resolvedKeys: keysSeen.size,
	sameNamedKeys: sameNamed.size,
	all,
	byAccess,
	byFamily,
	byScope,
	isv,
	isvOnly,
	boundTry,
	through,
	byOrigin,
	crossed,
};

if (args.includes("--moved")) for (const site of movedSites) console.log(`换了一张：${site}`);
if (args.includes("--json")) console.log(JSON.stringify(report, null, "\t"));
else {
	const pct = (n: number, d: number) => (d === 0 ? "—" : `${((n / d) * 100).toFixed(0)}%`);
	const line = (name: string, t: Tally) =>
		`${name.padEnd(8, "　")} ${String(t.total).padStart(5)} 处 | ${BUCKETS.map((b) => `${b} ${t[b]}（${pct(t[b], t.total)}）`).join("  ")}`;
	console.log(`代码关系表建于 ${report.indexAt}，字段引用 ${report.fieldRefs} 处`);
	console.log(
		`解出的字段标识 ${report.resolvedKeys} 个，其中在两张及以上单据上都有的 ${report.sameNamedKeys} 个（${pct(report.sameNamedKeys, report.resolvedKeys)}）\n`,
	);
	console.log(line("全部", all));
	console.log("\n按读写：");
	console.log(line("读", byAccess.read as Tally));
	console.log(line("写", byAccess.write as Tally));
	console.log("\n按写法：");
	for (const [name, t] of Object.entries(byFamily)) console.log(line(name, t));
	console.log("\n按类碰到几张单：");
	for (const [name, t] of Object.entries(byScope)) console.log(line(name, t));
	console.log(`\n只看本 ISV 字段（${isv}_ 开头、不带点号）：`);
	for (const [name, t] of Object.entries(isvOnly)) console.log(line(name, t));
	console.log("\n本 ISV 的界面模型引用，改按插件挂的单据归属（模拟，不改索引）：");
	for (const [name, n] of Object.entries(boundTry).sort()) console.log(`  ${name} ${n}`);
	const oline = (name: string, t: OriginTally) =>
		`${name.padEnd(8, "　")} ${String(t.total).padStart(5)} 处 | ${ORIGIN.map((b) => `${b} ${t[b]}（${pct(t[b], t.total)}）`).join("  ")}`;
	console.log(`\n按对象来源归属（标识解出的读写处；其中经包装方法展开的 ${through} 处）：`);
	for (const [name, t] of Object.entries(byOrigin)) console.log(oline(name, t));
	console.log("\n本 ISV 字段，老办法 → 新办法：");
	for (const [name, n] of Object.entries(crossed).sort((a, b) => b[1] - a[1])) console.log(`  ${name} ${n}`);
}
