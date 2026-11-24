/**
 * 输入框 `@` 引用的读写半边：建表单目录、现查一张单的运行态字段、读这几份文件拼成目录。
 * 目录本身怎么拼、怎么找、发给模型写什么在 `impact/mention.ts`。
 *
 * 给人用，不是模型工具：界面每敲一个字问一次，所以两条规矩——
 *   - 探针只搭已经在跑的常驻 JVM，不起 JVM、不降级冷进程（冷起一次要一分钟，菜单等不起）；
 *   - 不进「同一个问题问过几遍」的账，那本账管的是模型。
 *
 * 文件都在 `.cosmic-ai/work/impact/` 下（代码关系表的中间文件，能重建）：
 *   forms.json              表单目录，一份设计一行
 *   runtime-fields/<单>.json 人往这张单里钻时现查的运行态字段
 */

import type { KernelContext } from "../context.ts";
import { err, KernelError, type KernelResult, ok } from "../errors.ts";
import { type FormCatalog, formCatalogOf, type RuntimeFields, runtimeFieldsOf } from "../impact/mention.ts";
import type { ImpactIndex } from "../impact/model.ts";
import { FORM_CATALOG_PROBE } from "./internal-probes.ts";
import type { probe } from "./probe.ts";

export type MentionProbe = typeof probe;

/** 表单目录多久算旧：本 ISV 的人天天在设计器里建单，一天前的目录里没有今天建的那张。 */
export const FORM_CATALOG_TTL_MS = 6 * 60 * 60 * 1000;

/** 一张单的运行态字段多久算旧。 */
export const RUNTIME_FIELDS_TTL_MS = 24 * 60 * 60 * 1000;

const MENTION_CALL = { kernelEnv: true, coldFallback: false, startResident: false, countRepeats: false } as const;

export const formsFile = (ctx: KernelContext): string => `${ctx.layout.impactWork}/forms.json`;
export const runtimeDir = (ctx: KernelContext): string => `${ctx.layout.impactWork}/runtime-fields`;
const runtimeFile = (ctx: KernelContext, entity: string): string => `${runtimeDir(ctx)}/${entity}.json`;

/** 单据编号的形状；别的东西不拿去拼文件名、不拿去当探针入参。 */
export const ENTITY_SHAPE = /^[A-Za-z0-9_]{1,80}$/;

/** 一行一个对象地写：4 万多行挤成一行，人和 grep 都没法看。 */
function linedJson(head: Record<string, unknown>, listKey: string, rows: readonly unknown[]): string {
	const headText = JSON.stringify(head).slice(0, -1);
	return `${headText},${JSON.stringify(listKey)}:[\n${rows.map((r) => JSON.stringify(r)).join(",\n")}\n]}\n`;
}

function readJson<T>(ctx: KernelContext, file: string): T | null {
	if (!ctx.ports.fs.exists(file)) return null;
	try {
		return JSON.parse(ctx.ports.fs.read(file)) as T;
	} catch {
		return null;
	}
}

/** 建（重建）表单目录。JVM 没在跑就不建，回错误说清楚。 */
export async function buildFormCatalog(ctx: KernelContext, runProbe: MentionProbe): Promise<KernelResult<FormCatalog>> {
	const started = ctx.ports.clock.now();
	const run = await runProbe(ctx, FORM_CATALOG_PROBE, { ...MENTION_CALL, invocation: "输入框 @ 引用（表单目录）" });
	if (!run.ok) return run;
	const catalog = formCatalogOf(
		run.value.json.records as Record<string, unknown>[],
		new Date(ctx.ports.clock.now()).toISOString(),
		ctx.ports.clock.now() - started,
	);
	if (catalog === null) {
		return err(
			new KernelError("PROBE_FAILED", "表单目录探针没报出汇总行，没收这一份", {
				detail: { exitCode: run.value.exitCode },
			}),
		);
	}
	ctx.ports.fs.mkdirp(ctx.layout.impactWork);
	ctx.ports.fs.write(
		formsFile(ctx),
		linedJson({ kind: catalog.kind, at: catalog.at, ms: catalog.ms }, "forms", catalog.forms),
	);
	return ok(catalog);
}

/** 现查一张单的运行态字段（含继承来的），落一份缓存。 */
export async function fetchRuntimeFields(
	ctx: KernelContext,
	entity: string,
	runProbe: MentionProbe,
): Promise<KernelResult<RuntimeFields>> {
	if (!ENTITY_SHAPE.test(entity)) {
		return err(new KernelError("PROBE_ARGS_INVALID", `不是单据编号的形状：${entity}`));
	}
	const run = await runProbe(ctx, "MetaProbe", {
		...MENTION_CALL,
		env: { META_ENTITY: entity },
		invocation: `输入框 @ 引用（${entity} 的字段）`,
	});
	if (!run.ok) return run;
	const got = runtimeFieldsOf(
		run.value.json.records as Record<string, unknown>[],
		new Date(ctx.ports.clock.now()).toISOString(),
	);
	if (got === null) {
		return err(
			new KernelError("PROBE_FAILED", `没读到 ${entity} 的运行态元数据`, {
				detail: { exitCode: run.value.exitCode },
			}),
		);
	}
	// 入参是布局编号时探针换算成实体：两个名字都存，下次按哪个钻都命中
	const value = { ...got, entity: got.entity || entity };
	ctx.ports.fs.mkdirp(runtimeDir(ctx));
	const text = linedJson(
		{ kind: value.kind, entity: value.entity, name: value.name, at: value.at, entries: value.entries },
		"fields",
		value.fields,
	);
	ctx.ports.fs.write(runtimeFile(ctx, value.entity), text);
	if (value.entity !== entity) ctx.ports.fs.write(runtimeFile(ctx, entity), text);
	return ok(value);
}

export interface MentionSources {
	index: ImpactIndex | null;
	forms: FormCatalog | null;
	runtime: RuntimeFields[];
	/** 几份文件的修改时间拼成的戳：变了才重拼目录 */
	stamp: string;
}

/** 几份文件的修改时间戳，不读内容。 */
export function mentionStamp(ctx: KernelContext): string {
	const { fs } = ctx.ports;
	const dir = runtimeDir(ctx);
	const runtime = fs.exists(dir)
		? fs
				.readDir(dir)
				.filter((e) => e.name.endsWith(".json"))
				.map((e) => `${e.name}:${fs.mtimeMs(`${dir}/${e.name}`) ?? 0}`)
				.sort()
				.join(",")
		: "";
	return [fs.mtimeMs(ctx.layout.impactIndex) ?? 0, fs.mtimeMs(formsFile(ctx)) ?? 0, runtime].join("|");
}

export function readMentionSources(ctx: KernelContext): MentionSources {
	const index = readJson<ImpactIndex>(ctx, ctx.layout.impactIndex);
	const forms = readJson<FormCatalog>(ctx, formsFile(ctx));
	const dir = runtimeDir(ctx);
	const runtime: RuntimeFields[] = [];
	if (ctx.ports.fs.exists(dir)) {
		for (const entry of ctx.ports.fs.readDir(dir)) {
			if (!entry.name.endsWith(".json")) continue;
			const got = readJson<RuntimeFields>(ctx, `${dir}/${entry.name}`);
			if (got?.kind === "RuntimeFields") runtime.push(got);
		}
	}
	return {
		index: index?.kind === "ImpactIndex" ? index : null,
		forms: forms?.kind === "FormCatalog" ? forms : null,
		runtime,
		stamp: mentionStamp(ctx),
	};
}

/** 表单目录要不要（重）建：没有、或旧了。 */
export function formCatalogStale(ctx: KernelContext): boolean {
	const at = ctx.ports.fs.mtimeMs(formsFile(ctx));
	return at === null || ctx.ports.clock.now() - at > FORM_CATALOG_TTL_MS;
}

/** 这张单的运行态字段要不要（重）查。 */
export function runtimeFieldsStale(ctx: KernelContext, entity: string): boolean {
	const at = ctx.ports.fs.mtimeMs(runtimeFile(ctx, entity));
	return at === null || ctx.ports.clock.now() - at > RUNTIME_FIELDS_TTL_MS;
}
