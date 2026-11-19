/**
 * S17 batch 5 ruler: do the hints given before a run, a data seed and a form
 * simulation follow the metadata as it is now, or the snapshot as it was?
 *
 * Takes the project's freshly built snapshot as the truth, ages a copy of it the
 * way time would -- a few bills' registrations dropped (registered since the
 * snapshot), a layout that no longer exists and a plugin that was unregistered
 * since made up -- marks those rows changed in the change baseline, and asks
 * three readers the same questions:
 *
 *   truth    the kernel's own checks on the full snapshot
 *   stale    the kernel's own checks on the aged snapshot (what any reader sees
 *            when nobody checked the snapshot first)
 *   tool     the tool path a session takes (`prepareRun` / `prepareProbe` on a
 *            fresh adapter, i.e. a new session) on the aged snapshot
 *
 * Questions: the form-simulation warning ("no plugin of ours on this identifier,
 * they are on these layouts"), the external-effect notes before `run op save`
 * and before a data seed, and the post-compile "registered on" hint. Labels
 * ("快照 10-04，…") are cut before comparing; `--over` also prints what the hints
 * say when a check finds more than one patch may take.
 *
 * Needs the resident JVM already running (the check never starts one). The full
 * snapshot and its sidecars are written back afterwards, whatever the outcome.
 *
 *   node --experimental-strip-types scripts/measure-live-warnings.ts <project> [--over] [--json]
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { createKernelAdapter } from "../src/agent/tools/kernel-adapter.ts";
import { boundForms, formPluginSites, refreshMeta } from "../src/kernel/commands/impact.ts";
import { prepareRunInvocation } from "../src/kernel/commands/run.ts";
import type { KernelContext } from "../src/kernel/context.ts";
import { type ImpactIndex, type MetaIndex, mergeIndex, type SrcIndex } from "../src/kernel/impact/model.ts";
import { openProject } from "../src/kernel/open-project.ts";
import { dataWriteEffectNotes, externalEffectSites } from "../src/kernel/policy/external-effects.ts";
import { residentReady } from "../src/kernel/probe/server.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";

const VERSION = "s17-live-warnings-v1";
const args = process.argv.slice(2);
const root = args.find((arg) => !arg.startsWith("--")) ?? "D:/kingdee/zlgd_ygpt2.0";
const configDir = join(homedir(), ".fast-ai-cosmic");
const adapterOptions = {
	// The tool's own cache: that is where the resident JVM's pid record lives.
	agentConfigDir: configDir,
	cacheRoot: join(configDir, "cache"),
	agentVersion: "0.1.0",
	resources: EMBEDDED_RESOURCES,
};
const { ctx } = await openProject({ projectRoot: root, ...adapterOptions });
const fs = ctx.ports.fs;
const work = ctx.layout.impactWork;
const files = {
	meta: `${work}/meta-index.json`,
	index: ctx.layout.impactIndex,
	check: `${work}/meta-check.json`,
	pending: `${work}/meta-pending.json`,
};
const saved = Object.fromEntries(
	Object.entries(files).map(([k, f]) => [k, fs.exists(f) ? fs.read(f) : null]),
) as Record<keyof typeof files, string | null>;
if (saved.meta === null || saved.index === null) {
	console.log("还没有代码关系表：先完整重建一次（cosmic_doctor action=reindex）");
	process.exit(1);
}
const full = JSON.parse(saved.meta) as MetaIndex & Required<Pick<MetaIndex, "baseline">>;
const fullIndex = JSON.parse(saved.index) as ImpactIndex;
const src = JSON.parse(fs.read(`${work}/src-index.json`)) as SrcIndex;
if (!full.baseline) {
	console.log("快照没有变化基线：先完整重建一次（cosmic_doctor action=reindex）");
	process.exit(1);
}
if (!(await residentReady(ctx))) {
	console.log("常驻 JVM 没在跑：变化检查只搭已经在跑的常驻 JVM，先跑任意一个探针把它拉起来");
	process.exit(1);
}

const cut = (text: string) => text.replace(/快照 \d\d-\d\d[^）)]*/g, "快照");
const formWarning = (c: KernelContext, e: string) =>
	prepareRunInvocation(c, ["form", e]).warnings.filter((w) => w.includes("上没有本工程的插件登记"));
const opNotes = (c: KernelContext, e: string) =>
	prepareRunInvocation(c, ["op", e, "save"]).warnings.filter((w) => w.includes("会发消息"));
const seedNotes = (c: KernelContext, e: string) => dataWriteEffectNotes(c, e, "seed");

// ---- targets, picked from the truth so every one of them has something to lose or gain.
// Candidates come straight from the snapshot; the kernel's checks only confirm them (each reads every source file).
const sorted = (values: Iterable<string>) => [...new Set(values)].sort();
const projectClasses = new Set(fullIndex.classes.filter((c) => c.pluginType !== null).map((c) => c.class));
const ours = full.bindings.filter((b) => projectClasses.has(b.class));
const layoutsOf = (e: string) =>
	sorted(ours.filter((b) => b.kind === "form" && b.entity === e).map((b) => b.layout ?? ""));
const formLayouts = new Set(ours.filter((b) => b.kind === "form").map((b) => b.layout ?? ""));

// ---- every bill that carries our registrations: does the form-simulation warning name real layouts?
const misnamed: string[] = [];
let warned = 0;
for (const e of sorted(ours.map((b) => b.entity))) {
	const sites = formPluginSites(ctx, e);
	if (sites === null || sites.onTarget.length > 0 || sites.elsewhere.length === 0) continue;
	warned++;
	const wrong = sites.elsewhere.filter((s) => !formLayouts.has(s.layout)).map((s) => s.layout);
	if (wrong.length > 0) misnamed.push(`${e}: ${wrong.join(", ")}`);
}

// Registered on layouts only, a handful of them: the false-PASS warning is due, and losing them stays a small patch.
const formTargets = sorted(ours.map((b) => b.entity))
	.filter((e) => {
		const layouts = layoutsOf(e);
		return layouts.length > 0 && layouts.length <= 5 && !ours.some((b) => b.entity === e && b.layout === e);
	})
	.filter((e) => formWarning(ctx, e).length > 0)
	.slice(0, 2);
const opCandidates = sorted(ours.filter((b) => b.kind === "entity").map((b) => b.entity));
const named = ["zlgd_qty_wtd", "zlgd_sys_test_bill"].filter((e) => opCandidates.includes(e));
const effectTargets: string[] = [];
for (const e of [...named, ...opCandidates.filter((x) => !named.includes(x))]) {
	if (effectTargets.length === 2) break;
	if (opNotes(ctx, e).length > 0) effectTargets.push(e);
}
if (effectTargets.length === 0) {
	console.log("真机快照里挑不出带副作用提醒的单据");
	process.exit(1);
}
// A plugin with an outward effect, made up as still registered on a bill it was taken off.
const effectClass = externalEffectSites(ctx, effectTargets[0] as string).find((s) =>
	s.sites.some((x) => x.kind === "entity"),
)?.class as string;
const bound = new Set(full.bindings.map((b) => b.entity));
const entityRows = new Set((full.baseline.rows.entity ?? []).map((r) => r[1]));
const bare = (full.baseline.rows.form ?? [])
	.map((r) => r[1])
	.filter((n) => n.startsWith("zlgd_") && entityRows.has(n) && !bound.has(n))
	.sort();
const unregistered = bare[0] as string;
const goneOn = bare[1] as string;
// A form plugin on a layout of its own: made up as also on a layout that has since been deleted.
const formClass = (
	ours.find((b) => b.kind === "form" && b.entity === formTargets[0]) ??
	ours.find((b) => b.kind === "form" && b.layout !== b.entity && b.entity.startsWith("zlgd_"))
)?.class as string;
const targets = sorted([...formTargets, ...effectTargets, unregistered, goneOn]);

// ---- age a copy
const aged = JSON.parse(saved.meta) as typeof full;
const touch = (site: string, number: string) => {
	for (const row of aged.baseline.rows[site] ?? []) if (row[1] === number) row[2] = "aged";
};
// Registered since the snapshot: form plugins of the form targets, operation plugins of the effect targets.
const registeredSince = (b: MetaIndex["bindings"][number]) =>
	(b.kind === "form" && formTargets.includes(b.entity)) || (b.kind === "entity" && effectTargets.includes(b.entity));
for (const b of aged.bindings) if (registeredSince(b)) touch(b.kind ?? "", b.layout ?? "");
aged.bindings = aged.bindings.filter((b) => !registeredSince(b));
// Unregistered since: still in the snapshot, gone from the environment's registration of that bill.
aged.bindings.push({ class: effectClass, entity: unregistered, kind: "entity", enabled: true, layout: unregistered });
touch("entity", unregistered);
// A layout deleted since: its row gone from the environment, its registration still in the snapshot.
const goneLayout = `${goneOn}_s17gone`;
aged.bindings.push({ class: formClass, entity: goneOn, kind: "form", enabled: true, layout: goneLayout });
aged.baseline.rows.form = [...(aged.baseline.rows.form ?? []), ["s17-gone-id", goneLayout, "t"]];

const fileOf = (cls: string) => {
	const at = fullIndex.classes.find((c) => c.class === cls)?.file;
	return at === undefined || at === null ? null : join(root, at);
};
const boundFile = fileOf(formClass);
const ask = (c: KernelContext) =>
	Object.fromEntries(
		targets.map((e) => [e, { form: formWarning(c, e), op: opNotes(c, e), seed: seedNotes(c, e) }]),
	) as Record<string, { form: string[]; op: string[]; seed: string[] }>;
const hint = (c: KernelContext) => (boundFile === null ? [] : boundForms(c, [boundFile]));

const truth = ask(ctx);
const truthBound = hint(ctx);
let report: Record<string, unknown> = {};
try {
	fs.write(files.meta, JSON.stringify(aged));
	fs.write(files.index, JSON.stringify(mergeIndex(src, aged, fullIndex.at, fullIndex.runtimeKeyId)));
	if (fs.exists(files.check)) fs.remove(files.check);
	if (fs.exists(files.pending)) fs.remove(files.pending);
	const stale = ask(ctx);
	const staleBound = hint(ctx);

	let over: Record<string, unknown> | null = null;
	if (args.includes("--over")) {
		const got = await refreshMeta(ctx, undefined, { patch: 0 });
		over = {
			check: `${got.state}：${got.text}`,
			form: formWarning(ctx, goneOn)[0] ?? null,
			op: opNotes(ctx, unregistered)[0] ?? null,
			bound: hint(ctx)[0] ?? null,
		};
		fs.remove(files.check);
	}

	// A new session on the aged snapshot, through the same calls the tools make.
	const kernel = createKernelAdapter(adapterOptions);
	const opened = await kernel.open(root);
	if (!opened.ok) throw new Error(JSON.stringify(opened.error.toJSON()));
	const handle = opened.value.handle;
	const tool: Record<string, { form: string[]; op: string[]; seed: string[] }> = {};
	const firstCall: { ms: number; check: string } = { ms: 0, check: "" };
	for (const e of targets) {
		const t0 = Date.now();
		const form = await kernel.prepareRun(handle, ["form", e]);
		if (firstCall.ms === 0) {
			firstCall.ms = Date.now() - t0;
			firstCall.check = fs.exists(files.check) ? fs.read(files.check) : "没查";
		}
		const op = await kernel.prepareRun(handle, ["op", e, "save"]);
		const seed = await kernel.prepareProbe(handle, "DataSeedProbe", {
			positional: [],
			env: { SEED_ENTITY: e },
			cold: false,
		});
		tool[e] = {
			form: form.ok ? form.value.warnings.filter((w) => w.includes("上没有本工程的插件登记")) : [],
			op: op.ok ? op.value.warnings.filter((w) => w.includes("会发消息")) : [],
			seed: seed.ok ? seed.value.warnings.filter((w) => w.includes("会发消息")) : [],
		};
	}
	const toolBound = hint(ctx);

	const same = (a: string[], b: string[]) => JSON.stringify(a.map(cut).sort()) === JSON.stringify(b.map(cut).sort());
	const rows = targets.flatMap((e) =>
		(["form", "op", "seed"] as const).map((q) => ({
			target: e,
			question: q,
			truth: truth[e]?.[q].length ?? 0,
			stale: same(truth[e]?.[q] ?? [], stale[e]?.[q] ?? []),
			tool: same(truth[e]?.[q] ?? [], tool[e]?.[q] ?? []),
		})),
	);
	report = {
		version: VERSION,
		formWarnings: { warned, misnamed },
		aged: { formTargets, effectTargets, unregistered: `${effectClass} @ ${unregistered}`, goneLayout },
		rows,
		bound: {
			file: boundFile,
			truth: truthBound.map(cut),
			stale: same(truthBound, staleBound),
			tool: same(truthBound, toolBound),
			toolText: toolBound,
		},
		firstCall,
		over,
		totals: {
			questions: rows.length,
			staleRight: rows.filter((r) => r.stale).length,
			toolRight: rows.filter((r) => r.tool).length,
		},
	};
} finally {
	for (const [k, f] of Object.entries(files)) {
		const text = saved[k as keyof typeof files];
		if (text === null) {
			if (fs.exists(f)) fs.remove(f);
		} else fs.write(f, text);
	}
}

if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
else {
	const r = report as {
		formWarnings: { warned: number; misnamed: string[] };
		aged: Record<string, unknown>;
		rows: { target: string; question: string; truth: number; stale: boolean; tool: boolean }[];
		bound: { stale: boolean; tool: boolean; toolText: string[] };
		firstCall: { ms: number; check: string };
		over: Record<string, unknown> | null;
		totals: { questions: number; staleRight: number; toolRight: number };
	};
	console.log(
		`${VERSION}  全工程模拟表单警告 ${r.formWarnings.warned} 张单，其中点到非布局编号的 ${r.formWarnings.misnamed.length} 张`,
	);
	for (const x of r.formWarnings.misnamed.slice(0, 5)) console.log(`  ${x}`);
	console.log(`做旧：${JSON.stringify(r.aged)}`);
	console.log(`新会话第一次前检 ${r.firstCall.ms}ms，变化检查：${r.firstCall.check}`);
	const mark = (ok: boolean) => (ok ? "对" : "错");
	for (const x of r.rows)
		console.log(
			`  ${x.target.padEnd(28)} ${x.question.padEnd(4)} 应有 ${x.truth} 条  旧快照 ${mark(x.stale)}  工具 ${mark(x.tool)}`,
		);
	console.log(
		`  编译后提示  旧快照 ${mark(r.bound.stale)}  会话查过之后 ${mark(r.bound.tool)}  ${r.bound.toolText[0] ?? ""}`,
	);
	console.log(`合计 ${r.totals.questions} 问：旧快照答对 ${r.totals.staleRight}，工具答对 ${r.totals.toolRight}`);
	if (r.over) console.log(`一次补不完时：${JSON.stringify(r.over, null, 2)}`);
}
process.exit(0);
