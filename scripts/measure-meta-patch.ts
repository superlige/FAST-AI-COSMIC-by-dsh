/**
 * S17 batch 4 ruler: does a partial rescan reproduce a full rebuild?
 *
 * Takes the project's freshly built metadata snapshot, ages a copy of it the way
 * time would -- registrations of a few layouts, templates and workflows dropped,
 * field rows of a few bills dropped and their owners forgotten, bills the code
 * names taken off the whitelist, a deleted layout and a deleted bill made up --
 * marks those rows changed in the baseline, runs the real change check against
 * the live environment, and compares the patched snapshot with the full build
 * row by row: registrations, templates, names, bill names, field rows, owner lists, counts.
 *
 * Needs the resident JVM already running (the check never starts one). The full
 * snapshot is written back afterwards, whatever the outcome.
 *
 *   node --experimental-strip-types scripts/measure-meta-patch.ts <project> [--layouts N] [--bills N] [--named N] [--json]
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { PATCH_LIMIT, refreshMeta } from "../src/kernel/commands/impact.ts";
import { fieldWhitelist } from "../src/kernel/impact/meta-refresh.ts";
import type { MetaIndex, SrcIndex } from "../src/kernel/impact/model.ts";
import { openProject } from "../src/kernel/open-project.ts";
import { residentReady } from "../src/kernel/probe/server.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";

const VERSION = "s17-meta-patch-v3";
const args = process.argv.slice(2);
const root = args.find((arg) => !arg.startsWith("--")) ?? "D:/kingdee/zlgd_ygpt2.0";
const option = (name: string, fallback: number): number => {
	const at = args.indexOf(`--${name}`);
	return at >= 0 ? Number(args[at + 1]) : fallback;
};
const LAYOUTS = option("layouts", 6);
const BILLS = option("bills", 4);
const NAMED = option("named", 2);
const LIMIT = option("patch-limit", PATCH_LIMIT);

const opened = await openProject({
	projectRoot: root,
	// The tool's own cache: that is where the resident JVM's pid record lives.
	agentConfigDir: join(homedir(), ".fast-ai-cosmic"),
	cacheRoot: join(homedir(), ".fast-ai-cosmic", "cache"),
	agentVersion: "0.1.0",
	resources: EMBEDDED_RESOURCES,
});
const ctx = opened.ctx;
const fs = ctx.ports.fs;
const work = ctx.layout.impactWork;
const metaPath = `${work}/meta-index.json`;
const fullText = fs.read(metaPath);
const indexText = fs.read(ctx.layout.impactIndex);
const full = JSON.parse(fullText) as MetaIndex;
if (!full.baseline || !full.owners || !full.fieldsAll || !full.asked) {
	console.log("快照没有变化基线 / 归属清单：先完整重建一次（cosmic_doctor action=reindex）");
	process.exit(1);
}
if (!(await residentReady(ctx))) {
	console.log("常驻 JVM 没在跑：变化检查只搭已经在跑的常驻 JVM，先跑任意一个探针把它拉起来");
	process.exit(1);
}

/** Deterministic picks: sorted, every k-th, so the same snapshot ages the same way. */
const pick = <T>(list: readonly T[], n: number): T[] => {
	if (list.length <= n) return [...list];
	const step = Math.floor(list.length / n);
	return Array.from({ length: n }, (_, i) => list[i * step] as T);
};

const aged = JSON.parse(fullText) as MetaIndex & Required<Pick<MetaIndex, "baseline" | "owners" | "asked">>;
const touch = (site: string, number: string) => {
	for (const row of aged.baseline.rows[site] ?? []) if (row[1] === number) row[2] = "aged";
};
const sorted = (values: Iterable<string>) => [...new Set(values)].sort();
const layoutsWithPlugins = sorted(aged.bindings.filter((b) => b.kind === "form").map((b) => b.layout ?? ""));
const layouts = pick(layoutsWithPlugins.filter(Boolean), LAYOUTS);
const prints = pick(sorted(aged.templates.map((t) => t.number)), 2);
const flows = pick(sorted(aged.bindings.filter((b) => b.kind === "workflow").map((b) => b.layout ?? "")), 1);
for (const layout of layouts) touch("form", layout);
for (const number of prints) touch("print", number);
for (const key of flows) touch("workflow", key);
const dropped = (kind: string, numbers: string[]) => (b: { kind?: string; layout?: string }) =>
	b.kind === kind && numbers.includes(b.layout ?? "");
aged.bindings = aged.bindings.filter(
	(b) => !dropped("form", layouts)(b) && !dropped("print", prints)(b) && !dropped("workflow", flows)(b),
);
aged.templates = aged.templates.filter((t) => !prints.includes(t.number));
aged.names = (aged.names ?? []).filter(
	(n) => !(n.site === "print" && prints.includes(n.id)) && !(n.site === "workflow" && flows.includes(n.id)),
);
// A layout deleted since the snapshot: its row is gone from the environment, its registration must go too.
aged.baseline.rows.form = [...(aged.baseline.rows.form ?? []), ["s17-fake-id", "zlgd_s17_deleted_layout", "t"]];
aged.bindings.push({
	class: "zlgd.s17.Deleted",
	entity: "zlgd_s17_deleted",
	kind: "form",
	enabled: true,
	layout: "zlgd_s17_deleted_layout",
});

// Bills edited since: their rows and their place in every owner list forgotten.
const billsWithFields = sorted(aged.fields.map((f) => f.entity));
const bills = pick(billsWithFields, BILLS);
for (const bill of bills) touch("entity", bill);
// Bills the code names that were not on the whitelist when the snapshot was built.
const named = pick(
	billsWithFields.filter((b) => !bills.includes(b) && !aged.bindings.some((x) => x.entity === b)),
	NAMED,
);
const forgotten = new Set([...bills, ...named]);
aged.fields = aged.fields.filter((f) => !forgotten.has(f.entity));
// An edited bill's name is rescanned with it.
aged.billNames = (aged.billNames ?? []).filter((row) => !bills.includes(row.bill));
aged.asked.entities = aged.asked.entities.filter((e) => !named.includes(e));
// Owner lists cover every key in the library, so an edited bill is only taken out of them; its keys stay listed elsewhere.
for (const [key, list] of Object.entries(aged.owners)) {
	const kept = list.filter((e) => !bills.includes(e));
	if (kept.length === 0) delete aged.owners[key];
	else aged.owners[key] = kept;
}
// The keys the snapshot counts, the way the tool computes them (the snapshot no longer stores the asked keys).
const src = JSON.parse(fs.read(`${work}/src-index.json`)) as SrcIndex;
const trackedNow = new Set([...fieldWhitelist(src, aged.bindings).fields, ...aged.fields.map((f) => f.key)]);
// A bill deleted since: still listed as an owner, gone from the environment.
const someKey = Object.keys(aged.owners)[0] as string;
aged.owners[someKey] = [...(aged.owners[someKey] ?? []), "zlgd_s17_deleted_bill"];
aged.baseline.rows.entity = [...(aged.baseline.rows.entity ?? []), ["s17-fake-bill", "zlgd_s17_deleted_bill", "t"]];
aged.fieldOwners = Object.fromEntries(
	Object.entries(aged.owners)
		.filter(([k]) => trackedNow.has(k))
		.map(([k, v]) => [k, v.length]),
);

fs.write(metaPath, JSON.stringify(aged));
const checkFile = `${work}/meta-check.json`;
const checkBefore = fs.exists(checkFile) ? fs.read(checkFile) : null;
let report: Record<string, unknown> = {};
try {
	const started = Date.now();
	const got = await refreshMeta(ctx, undefined, { patch: LIMIT });
	const ms = Date.now() - started;
	const patched = JSON.parse(fs.read(metaPath)) as MetaIndex;
	const keyOf = {
		binding: (b: MetaIndex["bindings"][number]) => [b.class, b.entity, b.kind, b.layout, b.enabled].join("|"),
		template: (t: MetaIndex["templates"][number]) => [t.number, t.entity, [...t.classes].sort().join(",")].join("|"),
		name: (n: NonNullable<MetaIndex["names"]>[number]) => [n.site, n.id, n.name].join("|"),
		field: (f: MetaIndex["fields"][number]) =>
			[f.entity, f.key, f.level, f.entry ?? "", f.parentEntry ?? "", f.kind ?? "field"].join("|"),
		billName: (n: NonNullable<MetaIndex["billNames"]>[number]) => [n.bill, n.name, n.base ?? ""].join("|"),
	};
	const compare = <T>(what: string, a: readonly T[], b: readonly T[], key: (x: T) => string) => {
		const left = new Map<string, number>();
		for (const x of a) left.set(key(x), (left.get(key(x)) ?? 0) + 1);
		const right = new Map<string, number>();
		for (const x of b) right.set(key(x), (right.get(key(x)) ?? 0) + 1);
		const missing = [...left].filter(([k, n]) => (right.get(k) ?? 0) < n).map(([k]) => k);
		const extra = [...right].filter(([k, n]) => (left.get(k) ?? 0) < n).map(([k]) => k);
		return {
			what,
			full: a.length,
			patched: b.length,
			missing: missing.slice(0, 5),
			extra: extra.slice(0, 5),
			equal: missing.length + extra.length === 0,
		};
	};
	const ownersEqual =
		Object.keys(full.owners).length === Object.keys(patched.owners ?? {}).length &&
		Object.entries(full.owners).every(
			([k, v]) => JSON.stringify([...v].sort()) === JSON.stringify([...(patched.owners?.[k] ?? [])].sort()),
		);
	const ownerDiff = Object.keys({ ...full.owners, ...(patched.owners ?? {}) })
		.filter(
			(k) =>
				JSON.stringify([...(full.owners?.[k] ?? [])].sort()) !==
				JSON.stringify([...(patched.owners?.[k] ?? [])].sort()),
		)
		.slice(0, 5)
		.map((k) => ({ key: k, full: full.owners?.[k] ?? null, patched: patched.owners?.[k] ?? null }));
	const results = [
		compare("插件登记", full.bindings, patched.bindings, keyOf.binding),
		compare("打印模板", full.templates, patched.templates, keyOf.template),
		compare("中文名", full.names ?? [], patched.names ?? [], keyOf.name),
		compare("字段归属行", full.fields, patched.fields, keyOf.field),
		compare("单据中文名", full.billNames ?? [], patched.billNames ?? [], keyOf.billName),
	];
	report = {
		version: VERSION,
		aged: { layouts, prints, flows, bills, named, deleted: ["zlgd_s17_deleted_layout", "zlgd_s17_deleted_bill"] },
		check: got,
		ms,
		results,
		owners: {
			equal: ownersEqual,
			full: Object.keys(full.owners).length,
			patched: Object.keys(patched.owners ?? {}).length,
			diff: ownerDiff,
		},
		askedEqual: JSON.stringify(full.asked) === JSON.stringify(patched.asked),
	};
} finally {
	fs.write(metaPath, fullText);
	fs.write(ctx.layout.impactIndex, indexText);
	if (checkBefore === null) fs.remove(checkFile);
	else fs.write(checkFile, checkBefore);
}
if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
else {
	const r = report as {
		aged: Record<string, string[]>;
		check: { state: string; text: string; ms: number };
		ms: number;
		results: { what: string; full: number; patched: number; equal: boolean; missing: string[]; extra: string[] }[];
		owners: { equal: boolean; full: number; patched: number; diff: unknown[] };
		askedEqual: boolean;
	};
	console.log(
		`${VERSION}  做旧：布局 ${r.aged.layouts?.length} / 打印模板 ${r.aged.prints?.length} / 流程 ${r.aged.flows?.length} / 单据字段 ${r.aged.bills?.length} / 代码新用到的单 ${r.aged.named?.length} / 假的已删行 2`,
	);
	console.log(`检查 ${r.check.state}：${r.check.text}，${r.ms}ms`);
	for (const step of (r.check as unknown as { steps: { probe: string; ms: number }[] }).steps) {
		console.log(`  探针 ${step.probe}  ${step.ms}ms`);
	}
	for (const x of r.results)
		console.log(
			`  ${x.equal ? "一致" : "不一致"}  ${x.what}  完整 ${x.full} / 补扫后 ${x.patched}${x.equal ? "" : `  缺 ${JSON.stringify(x.missing)} 多 ${JSON.stringify(x.extra)}`}`,
		);
	console.log(
		`  ${r.owners.equal ? "一致" : "不一致"}  全库归属清单  完整 ${r.owners.full} / 补扫后 ${r.owners.patched}${r.owners.equal ? "" : `  ${JSON.stringify(r.owners.diff)}`}`,
	);
	console.log(`  ${r.askedEqual ? "一致" : "不一致"}  白名单`);
}
process.exit(0);
