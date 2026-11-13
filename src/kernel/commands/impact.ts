/**
 * impact -- reverse lookup from a code or metadata identifier (S5.3): given a
 * class, bill, layout, field or design-time object, what the project's code and
 * registrations around it are. It asks what the CODE touches, which whoever is
 * about to make a change can always answer, whatever words the requirement used.
 *
 * Two legs, from different sources, so either works when the other cannot:
 *   static    tools/SrcIndexTool.java   offline, javac Tree API + the real classpath
 *   metadata  probes/PluginIndexProbe   needs a live connection, scans design-time XML
 *
 * The index is an EXPORT, not a source of truth: rebuilding is cheaper than
 * dealing with staleness and merge conflicts, which is also why it is JSON rather
 * than a database.
 *
 * One departure from the frozen implementation: the index records the RuntimeKey
 * it was built under. The frozen file carried no identity, so an index built
 * against one Cosmic runtime -- whose JARs decide how the static side resolves
 * sink calls -- and queried while pointing at another answered with a straight
 * face. Recorded and reported, never a refusal: the static half is still mostly
 * right, and refusing would strand the user with no way to look anything up.
 */

import { sha256 } from "../../runtime/fingerprint.ts";
import { baseChildEnv, type KernelContext } from "../context.ts";
import { err, KernelError, type KernelResult, ok } from "../errors.ts";
import { formatBrief } from "../impact/brief.ts";
import { buildCatalog, type CatalogEntry, catalogGap, type NameHit, resolveNames } from "../impact/catalog.ts";
import { type EffectReach, effectReacher } from "../impact/effect-reach.ts";
import { eventExamples } from "../impact/event-examples.ts";
import { type FieldTrace, formatTrace, traceClasses, traceField } from "../impact/field-trace.ts";
import { formatBuild, formatImpact, objectLabel, registrationText } from "../impact/format.ts";
import {
	baselineOf,
	diffBaseline,
	fieldWhitelist,
	patchFields,
	patchRegistrations,
	type RegistrationScan,
	trackedKeys,
} from "../impact/meta-refresh.ts";
import { metaCheckFile, metaPending, readJsonFile, recordMetaCheck, settleMetaPending } from "../impact/meta-state.ts";
import {
	artifactGap,
	type BillName,
	compactField,
	type FieldOwnership,
	type Impact,
	type ImpactIndex,
	type IndexLookup,
	impactOf,
	lookup,
	type MetaBaseline,
	type MetaBinding,
	type MetaCheck,
	type MetaIndex,
	type MetaName,
	type MetaTemplate,
	mergeIndex,
	resolveTarget,
	SITE_LABEL,
	SITES_BEFORE_2026_09_04,
	type SrcIndex,
	snapshotLabel,
	splitQualified,
	suggest,
	type Target,
} from "../impact/model.ts";
import { layoutJson } from "../json-layout.ts";
import type { NearbyExamples } from "../nearby-examples.ts";
import { artifactState, classpathOf, ensureBuilt, findToolsJar, runJava, runJavac } from "../toolchain.ts";
import { FIELD_INDEX_PROBE, META_CHANGE_PROBE } from "./internal-probes.ts";
import { type ProbeOutcome, probe } from "./probe.ts";

/**
 * The probe entry point, injectable so a test can drive the metadata side without
 * a Cosmic runtime. Production always passes the real one.
 */
export type RunProbe = typeof probe;

export const IMPACT_ACTIONS = ["build", "query", "status"] as const;
export type ImpactAction = (typeof IMPACT_ACTIONS)[number];

export interface ImpactRequest {
	action?: ImpactAction;
	/** query: entry terms -- class name, simple name, entity, field, path or template code. */
	terms?: readonly string[];
	/** build: keep the previous metadata side instead of rescanning the shared environment. */
	srcOnly?: boolean;
	/** query: list the unresolved references one by one instead of only counting them. */
	dynamic?: boolean;
	/** query: look up source positions for this event on the same bill. */
	event?: string;
}

export interface ImpactBuildReport {
	action: "build";
	/** False when the metadata side was skipped or could not run. */
	metadata: boolean;
	index: {
		at: string;
		files: number;
		classes: number;
		entityRefs: number;
		fieldRefs: number;
		bindings: number;
		templates: number;
		fields: number;
	};
	file: string;
	text: string;
	notes: string[];
}

/**
 * `query` 算出来的全部东西，**内核内部**用。
 *
 * 与对外的 `ImpactQueryReport` 分开：按事件找样板、需求锚点要读完整的 `targets` / `impact` /
 * `traces`，报文那份是收窄过的投影。合成一个类型，就只能按最富的那个发出去——而报文是进模型
 * 上下文的那一份。
 */
export interface ImpactQueryDetail {
	targets: Target[];
	impact: Impact;
	/** One per field entry point: its read/write sites and the path back to a registered plugin. */
	traces: FieldTrace[];
	/** Terms that resolved to nothing, each with what was not recognised. */
	unknown: UnknownTerm[];
	text: string;
	notes: string[];
	examples?: NearbyExamples;
}

export interface UnknownTerm {
	term: string;
	why: string;
}

/**
 * 影响面的**标识符**，不含渲染。
 *
 * 原来这里直接挂 `Impact`：每个类拖着自己的 `file` / `pluginType` / `bindings` /
 * `entities` / `fields` / `chain` 整条记录，每个实体和字段带一句中文 `how`，
 * 未解析引用逐条带 class/level/access——而这些 `text` 已经渲染过一遍（绑定、调用链、
 * 按单据分组的字段、按 resolution 归并的未解析计数）。实测 60 个类的合成索引上，
 * 一次 query 整份 14,054 B，其中结构化那半 8,241 B 几乎全是这类重复。
 *
 * 标识符一个不少——那是查全的底线，砍它才是真的漏；砍掉的只有「长什么样」。
 */
export interface ImpactSurface {
	/** 全限定类名。文件、插件类型、绑定、调用链在 text 里。 */
	classes: string[];
	/** 实体标识。写还是读、经谁到的，在 text 的「写入实体 / 读取实体」两行里。 */
	entities: string[];
	/** 限定到单据的字段标识。按单据 / 分录的分组在 text 里。 */
	fields: string[];
	templates: string[];
	/**
	 * 牵连的元数据对象（打印模板 / 调度任务 / 开放接口 / 转换规则 / 工作流）：影响面里的类登记在
	 * 它们上面，改这些类就是在改它们。编号是人会直接说出口的那个（「21 号模板」），
	 * 所以和类名一样一个不少；text 里那一段有条数上限。
	 */
	artifacts: { kind: string; id: string; name?: string }[];
	/** 扫描认不出名字的读写处按 resolution 归并的计数；逐处的类、方法、行在 text 里。 */
	unresolved: { resolution: string; count: number }[];
}

export interface ImpactQueryReport {
	action: "query";
	targets: Target[];
	impact: ImpactSurface;
	/** Terms that resolved to nothing; the other terms were still answered. */
	unknown?: UnknownTerm[];
	text: string;
	notes: string[];
	eventLocations?: {
		status: "found" | "none" | "partial";
		note: string;
		items: Array<{
			reference: string;
			class: string;
			signature: string;
			bindings: unknown;
			sourceSha256: string;
			indexAt: string | null;
		}>;
		omitted: number;
	};
}

export interface ImpactStatusReport {
	action: "status";
	at: string;
	/** Null for an index built before the stamp existed. */
	runtimeKeyId: string | null;
	sameRuntime: boolean;
	text: string;
	notes: string[];
}

export type ImpactReport = ImpactBuildReport | ImpactQueryReport | ImpactStatusReport;

const P = "[IMPACT] ";
const LONG_PROBE_TIMEOUT_MS = 10 * 60 * 1000;

function indexMissing(why: string): KernelError {
	return new KernelError("IMPACT_INDEX_MISSING", why, {
		remedy: "先跑一次 cosmic_doctor action=reindex（只要源码事实就加 srcOnly=true，不连环境、约 10 秒）。",
	});
}

/**
 * Reads the index off disk.
 *
 * A file that exists but is not an ImpactIndex, and a file that will not parse,
 * are two different sentences: the first is somebody else's JSON at our path, the
 * second is a truncated write. Both refuse rather than degrade -- an "empty"
 * index answers every query with "nothing touches this", which is the one wrong
 * answer this command must never give.
 */
export function loadIndex(ctx: KernelContext): KernelResult<ImpactIndex> {
	const { fs } = ctx.ports;
	const file = ctx.layout.impactIndex;
	if (!fs.exists(file)) return err(indexMissing("索引还没建"));
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.read(file));
	} catch (error) {
		return err(indexMissing(`${file} 读不了 —— ${(error as Error).message}`));
	}
	const index = parsed as ImpactIndex;
	if (!index || index.kind !== "ImpactIndex") {
		return err(indexMissing(`${file} 不是 ImpactIndex（kind=${(index as { kind?: string })?.kind}）`));
	}
	// What is known about the snapshot since it was built lives beside it, so a
	// check that found nothing does not rewrite a file of several megabytes.
	if (index.meta) {
		const check = readJsonFile<MetaCheck>(ctx, metaCheckFile(ctx));
		const pending = metaPending(ctx);
		if (check !== null && check.at >= index.meta.at) index.meta.check = check;
		if (pending !== null) index.meta.pending = pending;
	}
	return ok(index);
}

/** A note when the index was built under a different runtime. Reported, never a refusal. */
function runtimeNote(ctx: KernelContext, index: ImpactIndex): string[] {
	if (!index.runtimeKeyId) {
		return [
			`${P}这份索引没有记 RuntimeKey（更早的版本建的）—— 换过苍穹运行时的话，静态侧的符号解析未必还对得上，重建一次最省事。`,
		];
	}
	if (index.runtimeKeyId === ctx.runtimeKeyId) return [];
	return [
		`${P}⚠ 这份索引建于另一个 RuntimeKey（${index.runtimeKeyId.slice(0, 20)}…，当前 ${ctx.runtimeKeyId.slice(0, 20)}…）。`,
		`${P}  静态侧的 sink 解析吃的是那时候的 classpath，结论仍然大体成立，但别拿它当权威 —— 重建一次。`,
	];
}

// ---------------------------------------------------------------- the two legs

/** Which SrcIndexTool built a table; null when the source was not released (a test fake, a broken install). */
function srcToolPrint(ctx: KernelContext): string | null {
	const src = ctx.layout.srcIndexToolSrc;
	return ctx.ports.fs.exists(src) ? sha256(ctx.ports.fs.read(src)).slice(0, 16) : null;
}

/** Compiles SrcIndexTool if its class is missing or older than the source. */
async function ensureSrcIndexTool(ctx: KernelContext): Promise<KernelResult<true>> {
	const { fs } = ctx.ports;
	const src = ctx.layout.srcIndexToolSrc;
	if (!fs.exists(src)) {
		return err(
			new KernelError("IMPACT_BUILD_FAILED", `SrcIndexTool.java 没有释放到 ${src}`, {
				remedy: "重新打开工程会释放自有资源；仍然没有就是发行物缺文件，跑 cosmic_doctor。",
			}),
		);
	}
	const classFile = `${ctx.layout.toolClasses}/SrcIndexTool.class`;
	const classMs = fs.mtimeMs(classFile);
	const srcMs = fs.mtimeMs(src);
	if (classMs !== null && (srcMs === null || srcMs <= classMs)) return ok(true);
	// javac's Tree API lives in tools.jar on JDK 8, so this tool needs it on the
	// compile classpath as well as at run time -- the same reason chain as ApiTool.
	const toolsJar = await findToolsJar(ctx);
	if (toolsJar === null) {
		return err(
			new KernelError("TOOLCHAIN_MISSING", "找不到 tools.jar（把 JAVA_HOME 指向 JDK），impact 的静态侧用不了", {
				remedy: "JAVA_HOME 指到 JDK 8 的根目录（不是 JRE），或让 javac 进 PATH。",
			}),
		);
	}
	fs.mkdirp(ctx.layout.toolClasses);
	const compiled = await runJavac(ctx, ["-encoding", "UTF-8", "-cp", toolsJar, "-d", ctx.layout.toolClasses, src]);
	if (compiled.status !== 0) {
		return err(
			new KernelError("COMPILE_FAILED", "SrcIndexTool 编译失败", {
				detail: { out: compiled.out.slice(0, 4000) },
				remedy: "多半是 JDK 版本不对：这个工具用 JDK 8 的 com.sun.source Tree API。",
			}),
		);
	}
	return ok(true);
}

/** The static side: offline, needs only the sources and the javac argfile. */
async function buildSrcIndex(ctx: KernelContext): Promise<KernelResult<SrcIndex>> {
	const built = await ensureBuilt(ctx);
	if (!built.ok) return err(built.error);
	const ready = await ensureSrcIndexTool(ctx);
	if (!ready.ok) return err(ready.error);
	const toolsJar = (await findToolsJar(ctx)) as string;
	const { fs } = ctx.ports;
	const dirs = ctx.layout.moduleDirs.filter((dir) => fs.exists(dir.src)).map((dir) => dir.src);
	if (dirs.length === 0) {
		return err(
			new KernelError("SOURCE_NOT_FOUND", `代码模块没有源码目录：${ctx.config.codeModules.join(", ")}`, {
				detail: { modules: ctx.config.codeModules },
				remedy: "确认配置里的 codeModules 是这个工程真实的模块名（cosmic_doctor 会逐项报出处）。",
			}),
		);
	}
	fs.mkdirp(ctx.layout.impactWork);
	const out = `${ctx.layout.impactWork}/src-index.json`;
	const run = await runJava(
		ctx,
		[
			"-Xmx2g",
			"-Dfile.encoding=UTF-8",
			"-cp",
			classpathOf(ctx.layout.toolClasses, ctx.layout.pathingJar, toolsJar),
			"SrcIndexTool",
			ctx.layout.javacArgs,
			out,
			...dirs,
		],
		baseChildEnv(ctx),
	);
	if (run.status !== 0 || !fs.exists(out)) {
		return err(
			new KernelError("IMPACT_BUILD_FAILED", "静态侧没跑成，索引没有重建", {
				detail: { status: run.status, out: run.out.slice(-4000) },
				remedy:
					"先确认构建产物在（pathing jar + javac argfile），不在就 cosmic_doctor action=rebuild force=true，再看上面的 javac 诊断。",
			}),
		);
	}
	try {
		return ok({ ...(JSON.parse(fs.read(out)) as SrcIndex), tool: srcToolPrint(ctx) ?? undefined });
	} catch (error) {
		return err(
			new KernelError("IMPACT_BUILD_FAILED", `静态侧写出来的 JSON 读不了 —— ${(error as Error).message}`, {}),
		);
	}
}

/**
 * A probe that exits non-zero has not "emitted no summary line" -- it did not
 * run. Cosmic connects to zookeeper and the database before a probe's first
 * statement, so the common failure here is an unreachable shared environment,
 * and the JVM shuts itself down with a non-zero code and almost nothing on
 * stdout: its own log went to the project's logs/cosmic_out.log through logback.
 *
 * Reporting that as a malformed probe output sends the reader to the probe
 * source, which is the one place the answer is not. Same class of defect as the
 * two diagnostics S3 fixed on real JDK 8.
 */
export function probeDidNotRun(ctx: KernelContext, what: string, outcome: ProbeOutcome): string | null {
	if (outcome.exitCode === 0) return null;
	return (
		`${P}${what}没跑成：探针非零退出（exitCode=${outcome.exitCode}，${outcome.path} 路径）—— ` +
		`多半是连不上共享环境（苍穹先连 zookeeper/数据库，连不上就自己 shutdown）。` +
		`本次进程输出在 ${outcome.outputFile}，苍穹自己的日志在 ${ctx.projectRoot}/logs/cosmic_out.log`
	);
}

/** What the field-ownership records of one `EntityFieldIndexProbe` run say. */
interface FieldRecords {
	rows: FieldOwnership[];
	/** One per bill design the scan read (`t=billname`). */
	billNames: BillName[];
	/** Key -> bills carrying it, as the probe listed them. */
	owners: Record<string, string[]>;
	/** Key -> how many bills carry it. */
	counts: Record<string, number>;
	/** `all` (every field of the asked bills), `asked`, `partial`; "" from a probe that wrote no summary. */
	mode: string;
}

function fieldRecords(records: readonly Record<string, unknown>[]): FieldRecords {
	const rows: FieldOwnership[] = [];
	const billNames: BillName[] = [];
	const owners: Record<string, string[]> = {};
	const counts: Record<string, number> = {};
	let mode = "";
	for (const row of records) {
		if (row.t === "field") {
			rows.push(
				compactField({
					entity: String(row.entity ?? ""),
					key: String(row.key ?? ""),
					level: String(row.level ?? ""),
					entry: String(row.entry ?? ""),
					kind: String(row.kind ?? "field"),
					parentEntry: String(row.parentEntry ?? ""),
				}),
			);
		} else if (row.t === "billname") {
			const bill = String(row.entity ?? "");
			const name = String(row.name ?? "");
			const base = String(row.base ?? "");
			if (bill !== "" && name !== "")
				billNames.push({ bill, name, ...(base !== "" && base !== bill ? { base } : {}) });
		} else if (row.t === "fieldowners") {
			counts[String(row.key)] = Number(row.entities ?? 0);
			if (Array.isArray(row.on)) owners[String(row.key)] = (row.on as unknown[]).map(String);
		} else if (row.t === "field-summary") {
			mode = String(row.mode ?? "");
		}
	}
	return { rows, billNames, owners, counts, mode };
}

/**
 * Field ownership. **A field identifier is unique only within one bill**, so a
 * key without an entity is an ambiguous symbol: measured on this project, 28% of
 * the field identifiers appearing in the sources sit on more than one bill
 * (`zlgd_org` on 234 of them).
 *
 * Every field of the bills the code touches or plugins are registered on is
 * collected, not only the keys the code names (S17 4.2): "does this bill have
 * that field" is otherwise unanswerable for any field the code has not used yet.
 * Measured 2026-10-04: 1,145 bills, 34,060 rows, the same ~75 s scan.
 *
 * The whitelist travels by FILE, not by environment variable: once the sink table
 * grew, the sources carry over a thousand identifiers and tens of thousands of
 * characters, and an over-long environment variable fails by silent truncation.
 */
async function buildFieldOwners(
	ctx: KernelContext,
	src: SrcIndex,
	bindings: readonly MetaBinding[],
	runProbe: RunProbe,
): Promise<{
	owned: Pick<MetaIndex, "fields" | "fieldOwners" | "owners" | "asked" | "fieldsAll" | "billNames">;
	ms: number;
	notes: string[];
}> {
	const none = { fields: [], fieldOwners: {} };
	const whitelist = fieldWhitelist(src, bindings);
	if (whitelist.fields.size === 0) return { owned: none, ms: 0, notes: [] };
	const fieldsFile = `${ctx.layout.impactWork}/impact-fields.txt`;
	const entitiesFile = `${ctx.layout.impactWork}/impact-entities.txt`;
	ctx.ports.fs.write(fieldsFile, [...whitelist.fields].join("\n"));
	ctx.ports.fs.write(entitiesFile, [...whitelist.entities].join("\n"));
	const started = ctx.ports.clock.now();
	const run = await runProbe(ctx, FIELD_INDEX_PROBE, {
		...COMMAND_CALL,
		kernelEnv: true,
		env: { IDX_FIELDS_FILE: fieldsFile, IDX_ENTITIES_FILE: entitiesFile, IDX_ALL_ON_ENTITIES: "1" },
		timeoutMs: LONG_PROBE_TIMEOUT_MS,
		invocation: "cosmic_doctor action=reindex（字段归属）",
	});
	const ms = ctx.ports.clock.now() - started;
	const lost = "字段还是没有实体限定，impact <字段> 会把同名的并一起";
	if (!run.ok) return { owned: none, ms, notes: [`${P}字段归属没跑成（${run.error.code}）—— ${lost}`] };
	const notRun = probeDidNotRun(ctx, "字段归属", run.value);
	if (notRun !== null) return { owned: none, ms, notes: [`${notRun} —— ${lost}`] };
	const got = fieldRecords(run.value.json.records as Record<string, unknown>[]);
	// The lists cover every key in the library (a patch moves bills in and out of them); the counts only the keys this project asks about.
	const fieldOwners: Record<string, number> = {};
	for (const key of trackedKeys(whitelist, got.rows))
		if ((got.counts[key] ?? 0) > 0) fieldOwners[key] = got.counts[key] as number;
	const notes = got.rows.length === 0 ? [`${P}字段归属一条都没报出来 —— ${lost}`] : [];
	// The whitelist is recorded only when the scan evidently saw the library. A scan
	// that ran but found no owner for any key (wrong ISV, empty result) would
	// otherwise read as "every asked key is gone", and the staleness check would
	// sink every case that asserts one.
	const billNames = got.billNames.length > 0 ? { billNames: got.billNames } : {};
	if (Object.keys(fieldOwners).length === 0)
		return { owned: { fields: got.rows, fieldOwners, ...billNames }, ms, notes };
	return {
		owned: {
			fields: got.rows,
			fieldOwners,
			...(got.mode === "all" ? { owners: got.owners } : {}),
			asked: { entities: [...whitelist.entities].sort() },
			...(got.mode === "all" ? { fieldsAll: true } : {}),
			...billNames,
		},
		ms,
		notes,
	};
}

/** The registrations, templates and names a `PluginIndexProbe` run reported. */
function registrationRecords(records: readonly Record<string, unknown>[]): RegistrationScan {
	const bindings: MetaBinding[] = records
		.filter((record) => record.t === "binding")
		.map((record) => ({
			class: String(record.class ?? ""),
			entity: String(record.entity ?? ""),
			kind: record.kind === undefined ? undefined : String(record.kind),
			enabled: record.enabled !== false,
			// The probe has emitted `layout` from every one of the seven sites since
			// the day they were added; this line is what stopped throwing it away.
			// It is the print template number, the task code, the API number, the
			// BOTP rule id and the workflow key -- i.e. every non-entity object a
			// person names when they ask for a change.
			...(record.layout === undefined || String(record.layout) === "" ? {} : { layout: String(record.layout) }),
		}));
	const templates: MetaTemplate[] = records
		.filter((record) => record.t === "template")
		.map((record) => ({
			number: String(record.number ?? ""),
			entity: String(record.entity ?? ""),
			classes: Array.isArray(record.classes) ? (record.classes as unknown[]).map(String) : [],
		}));
	// Design-time names. The probe emits a row only for a family whose name column
	// it verified, so an empty list means "no family has one", never "these objects
	// are nameless" -- and the catalog says which it was.
	const names: MetaName[] = records
		.filter((record) => record.t === "name")
		.map((record) => ({
			site: String(record.site ?? ""),
			id: String(record.id ?? ""),
			name: String(record.name ?? ""),
		}))
		.filter((row) => row.site !== "" && row.id !== "" && row.name !== "");
	return { bindings, templates, names };
}

/** The package prefixes come from the source index's class names -- never a hard-coded ISV package. */
function packagesOf(src: SrcIndex): string {
	const packages = [...new Set(src.classes.map((cls) => cls.class.split(".")[0]).filter(Boolean))] as string[];
	return packages.map((pkg) => `${pkg}.`).join(",");
}

/**
 * The design rows the scan is about to read, recorded as the baseline later
 * checks compare with. Taken BEFORE the scan: a row edited while the scan runs
 * then shows up as changed next time instead of being lost.
 */
async function stampRows(
	ctx: KernelContext,
	pkgs: string,
	runProbe: RunProbe,
	options: { residentOnly?: boolean } = {},
): Promise<{ baseline: MetaBaseline | null; why: string }> {
	const run = await runProbe(ctx, META_CHANGE_PROBE, {
		...COMMAND_CALL,
		kernelEnv: true,
		env: { IDX_PKGS: pkgs },
		invocation: "代码关系表（元数据变化清单）",
		...(options.residentOnly ? RESIDENT_ONLY : {}),
	});
	if (!run.ok) return { baseline: null, why: `${run.error.code}：${run.error.message}` };
	const notRun = probeDidNotRun(ctx, "变化清单", run.value);
	if (notRun !== null) return { baseline: null, why: notRun };
	const baseline = baselineOf(
		run.value.json.records as Record<string, unknown>[],
		new Date(ctx.ports.clock.now()).toISOString(),
	);
	return baseline === null ? { baseline, why: "探针没报出汇总行" } : { baseline, why: "" };
}

/**
 * The metadata side. Goes through `probe` rather than starting a JVM directly,
 * so cold/hot selection, the environment overlay and the `[PROBE-JSON]` bypass
 * are the ones every other command uses -- not a second execution path that
 * drifts.
 */
async function buildMetaIndex(
	ctx: KernelContext,
	src: SrcIndex,
	runProbe: RunProbe,
): Promise<{ meta: MetaIndex | null; notes: string[] }> {
	const pkgs = packagesOf(src);
	if (pkgs === "") return { meta: null, notes: [`${P}源码索引里一个类都没有，元数据侧无从扫起`] };
	const started = ctx.ports.clock.now();
	const stamped = await stampRows(ctx, pkgs, runProbe);
	const run = await runProbe(ctx, "PluginIndexProbe", {
		...COMMAND_CALL,
		kernelEnv: true,
		// This reviewed whole-library scan is allowed a longer request deadline while
		// retaining the resident JVM's warmed metadata cache. Ordinary probes stay at
		// 120 seconds and callers cannot set this through a model-facing schema.
		timeoutMs: LONG_PROBE_TIMEOUT_MS,
		env: { IDX_PKGS: pkgs },
		invocation: "cosmic_doctor action=reindex（元数据侧）",
	});
	if (!run.ok) {
		return {
			meta: null,
			notes: [
				`${P}元数据侧没跑成（${run.error.code}：${run.error.message}）—— 这次索引只有源码事实，插件绑在哪张单据上查不到`,
			],
		};
	}
	const metaNotRun = probeDidNotRun(ctx, "元数据侧", run.value);
	if (metaNotRun !== null) {
		return { meta: null, notes: [`${metaNotRun} —— 这次索引只有源码事实，插件绑在哪张单据上查不到`] };
	}
	const records = run.value.json.records as Record<string, unknown>[];
	const summary = records.find((record) => record.t === "binding-summary");
	if (!summary) {
		return { meta: null, notes: [`${P}元数据侧没报出汇总行，索引不收它 —— 只收半份绑定关系比没有更难查`] };
	}
	const { bindings, templates, names } = registrationRecords(records);
	const owned = await buildFieldOwners(ctx, src, bindings, runProbe);
	const notes = [...owned.notes];
	if (stamped.baseline === null) {
		notes.push(`${P}没记下变化基线（${stamped.why}）—— 之后查不了元数据变没变，要等下次完整重建`);
	}
	return {
		meta: {
			kind: "MetaIndex",
			at: new Date(ctx.ports.clock.now()).toISOString(),
			ms: ctx.ports.clock.now() - started,
			scanned: Number(summary.scanned ?? 0),
			bindings,
			templates,
			names,
			fields: owned.owned.fields,
			fieldOwners: owned.owned.fieldOwners,
			fieldsMs: owned.ms,
			sites: Array.isArray(summary.sites) ? (summary.sites as unknown[]).map(String) : [...SITES_BEFORE_2026_09_04],
			...(owned.owned.asked === undefined ? {} : { asked: owned.owned.asked }),
			...(owned.owned.owners === undefined ? {} : { owners: owned.owned.owners }),
			...(owned.owned.fieldsAll ? { fieldsAll: true } : {}),
			...(owned.owned.billNames === undefined ? {} : { billNames: owned.owned.billNames }),
			...(stamped.baseline === null ? {} : { baseline: stamped.baseline }),
		},
		notes,
	};
}

// ---------------------------------------------------------------- keeping the snapshot current (S17 4.3–4.6)

/**
 * The probes a refresh runs ride a resident JVM that is already up and never start
 * one: a check costs a second, a cold start costs a minute, and nobody asked for
 * either. Without a resident JVM the refresh waits for the next session that has one.
 */
const RESIDENT_ONLY = { coldFallback: false, startResident: false } as const;

/**
 * The same probe with the same input is what these commands do on purpose -- a
 * change check asks the identical question every time -- so they stay out of the
 * repeat ledger, which exists to stop a model re-asking a settled question.
 */
const COMMAND_CALL = { countRepeats: false } as const;

/**
 * At most this many changed rows plus newly named bills are rescanned at once.
 * Measured 2026-10-04 on the real project: 104 rows took 19 s in all, the longest
 * single probe 10 s; twice that would pass the 30 s a refresh may hold the
 * resident JVM, queueing the person's own probes. Beyond it a full rebuild at a
 * quiet moment is the better trade, and the snapshot says so until then.
 */
export const PATCH_LIMIT = 100;

const metaFile = (ctx: KernelContext) => `${ctx.layout.impactWork}/meta-index.json`;

export interface MetaRefresh {
	/** `skipped`: no snapshot to refresh; nothing was recorded. */
	state: MetaCheck["state"] | "skipped";
	text: string;
	ms: number;
	/** Each probe the refresh ran and how long it held the JVM, for the ruler. */
	steps: { probe: string; ms: number }[];
}

/**
 * Checks the metadata snapshot against the environment and rescans what changed.
 *
 * Callers decide WHEN (only with a resident JVM already running, at most once per
 * session unless this machine wrote metadata -- see the kernel adapter); this
 * decides WHAT: compare the design rows with the baseline, rescan the rows that
 * differ and the bills the code newly names, and merge the result so it equals a
 * full rebuild. Over the limit it rescans nothing and says so. Every outcome is
 * recorded beside the snapshot, and every reader of the snapshot reports it.
 */
export async function refreshMeta(
	ctx: KernelContext,
	probeEntry: RunProbe = probe,
	limits: { patch?: number } = {},
): Promise<MetaRefresh> {
	const started = ctx.ports.clock.now();
	const at = new Date(started).toISOString();
	const patchLimit = limits.patch ?? PATCH_LIMIT;
	const steps: MetaRefresh["steps"] = [];
	const runProbe = (async (c: KernelContext, name: string, options?: Parameters<RunProbe>[2]) => {
		const t0 = ctx.ports.clock.now();
		const result = await probeEntry(c, name, options);
		steps.push({ probe: `${name} ${Object.keys(options?.env ?? {}).join(",")}`, ms: ctx.ports.clock.now() - t0 });
		return result;
	}) as RunProbe;
	const meta = readJsonFile<MetaIndex>(ctx, metaFile(ctx));
	const src = readJsonFile<SrcIndex>(ctx, `${ctx.layout.impactWork}/src-index.json`);
	const done = (state: MetaCheck["state"], changed: number, text: string): MetaRefresh => {
		const ms = ctx.ports.clock.now() - started;
		recordMetaCheck(ctx, { at, state, changed, text, ms });
		return { state, text, ms, steps };
	};
	if (meta === null || meta.kind !== "MetaIndex" || src === null) {
		return { state: "skipped", text: "还没有元数据快照，无从查起", ms: 0, steps };
	}
	if (!meta.baseline || !meta.owners || !meta.fieldsAll || !meta.asked) {
		return done("baseline", 0, "快照建于记变化基线之前，查不了变没变；完整重建一次后自动跟上");
	}
	const stamped = await stampRows(ctx, packagesOf(src), runProbe, { residentOnly: true });
	if (stamped.baseline === null) return done("failed", 0, `变化清单没拿到（${stamped.why}）`);
	const changes = diffBaseline(meta.baseline, stamped.baseline);
	const oldEntities = new Set(meta.asked.entities);
	const named = [...fieldWhitelist(src, meta.bindings).entities].filter((entity) => !oldEntities.has(entity));
	const scope = [...changes.numbers.values()].reduce((n, set) => n + set.size, 0) + named.length;
	if (scope === 0) return done("same", 0, "没变化");
	if (scope > patchLimit) {
		return done("over", scope, `${scope} 处变化，超过一次补扫的上限 ${patchLimit}`);
	}

	// Registrations first: the bills the field scan covers include the ones plugins are registered on.
	let regs: RegistrationScan = { bindings: meta.bindings, templates: meta.templates, names: meta.names ?? [] };
	let skipped: string[] = [];
	if (changes.numbers.size > 0) {
		const onlyFile = `${ctx.layout.impactWork}/meta-patch-rows.txt`;
		ctx.ports.fs.write(
			onlyFile,
			[...changes.numbers].flatMap(([site, set]) => [...set].map((number) => `${site}\t${number}`)).join("\n"),
		);
		const run = await runProbe(ctx, "PluginIndexProbe", {
			kernelEnv: true,
			env: { IDX_PKGS: packagesOf(src), IDX_ONLY_FILE: onlyFile },
			invocation: "代码关系表（补扫插件登记）",
			...RESIDENT_ONLY,
			...COMMAND_CALL,
		});
		if (!run.ok) return done("failed", scope, `补扫插件登记没跑成（${run.error.code}）`);
		const records = run.value.json.records as Record<string, unknown>[];
		const summary = records.find((r) => r.t === "binding-summary");
		if (probeDidNotRun(ctx, "补扫", run.value) !== null || summary === undefined) {
			return done("failed", scope, "补扫插件登记没跑完");
		}
		// Rows the probe could not put into a query keep what the snapshot had; the rest of the batch still lands.
		skipped = Array.isArray(summary.skipped) ? summary.skipped.map(String) : [];
		regs = patchRegistrations(meta, withoutSkipped(changes.numbers, skipped), registrationRecords(records));
	}
	const whitelist = fieldWhitelist(src, regs.bindings);
	const rescanned = new Set([
		...(changes.numbers.get("entity") ?? []),
		...[...whitelist.entities].filter((entity) => !oldEntities.has(entity)),
	]);
	const fieldRun = async (env: Record<string, string>, what: string) => {
		const run = await runProbe(ctx, FIELD_INDEX_PROBE, {
			kernelEnv: true,
			env,
			invocation: `代码关系表（${what}）`,
			...RESIDENT_ONLY,
			...COMMAND_CALL,
		});
		if (!run.ok || probeDidNotRun(ctx, what, run.value) !== null) return null;
		const got = fieldRecords(run.value.json.records as Record<string, unknown>[]);
		return got.mode === "partial" ? got : null;
	};
	let rows: FieldOwnership[] = [];
	let billNames: BillName[] = [];
	if (rescanned.size > 0) {
		const scanFile = `${ctx.layout.impactWork}/meta-patch-entities.txt`;
		ctx.ports.fs.write(scanFile, [...rescanned].join("\n"));
		const got = await fieldRun({ IDX_SCAN_FILE: scanFile }, "补扫字段归属");
		if (got === null) return done("failed", scope, "补扫字段归属没跑成");
		rows = got.rows;
		billNames = got.billNames;
	}
	const patched: MetaIndex = {
		...meta,
		...regs,
		...patchFields(meta, whitelist, { rescanned, rows, billNames }),
		baseline: stamped.baseline,
		patchedAt: at,
	};
	ctx.ports.fs.write(metaFile(ctx), layoutJson(JSON.stringify(patched)));
	// The index keeps the time its static side was built: that is what the
	// staleness check compares source files against.
	const previous = loadIndex(ctx);
	if (previous.ok) {
		// src-index.json is the scanner's own output; which scanner built it lives on the index.
		const tool = previous.value.src.tool;
		const index = mergeIndex(
			tool === undefined ? src : { ...src, tool },
			patched,
			previous.value.at,
			previous.value.runtimeKeyId,
		);
		ctx.ports.fs.write(ctx.layout.impactIndex, layoutJson(JSON.stringify(index)));
	}
	const parts = [...changes.numbers].map(([site, set]) => `${SITE_LABEL[site]?.split(" ")[0] ?? site} ${set.size}`);
	if (named.length > 0) parts.push(`代码新用到的单据 ${named.length}`);
	const skipNote =
		skipped.length > 0 ? `；${skipped.length} 行编号拼不进查询没补（${skipped.join("、")}），完整重建能收进来` : "";
	return done("patched", scope, `补了 ${parts.join("、")}${skipNote}`);
}

/** The changed numbers minus the probe's skipped rows (each "site number", as the probe reports them). */
function withoutSkipped(numbers: Map<string, Set<string>>, skipped: readonly string[]): Map<string, Set<string>> {
	if (skipped.length === 0) return numbers;
	const drop = new Set(skipped);
	return new Map(
		[...numbers].map(([site, set]) => [site, new Set([...set].filter((number) => !drop.has(`${site} ${number}`)))]),
	);
}

// ---------------------------------------------------------------- actions

async function actionBuild(
	ctx: KernelContext,
	request: ImpactRequest,
	runProbe: RunProbe,
): Promise<KernelResult<ImpactBuildReport>> {
	const { fs } = ctx.ports;
	const started = ctx.ports.clock.now();
	const src = await buildSrcIndex(ctx);
	if (!src.ok) return err(src.error);
	const notes: string[] = [];
	let meta: MetaIndex | null = null;
	if (request.srcOnly) {
		// Rebuilding only the static side keeps the previous metadata side as it was:
		// it changes only when somebody edits metadata, and it is the one part here
		// that needs a live connection and tens of seconds.
		try {
			meta = JSON.parse(fs.read(metaFile(ctx))) as MetaIndex;
			notes.push(`${P}srcOnly：沿用上次的元数据侧（${meta.at}，${meta.bindings.length} 条登记）`);
		} catch {
			notes.push(`${P}srcOnly：还没有元数据侧可沿用，这次索引只有源码事实`);
		}
	} else {
		const built = await buildMetaIndex(ctx, src.value, runProbe);
		meta = built.meta;
		notes.push(...built.notes);
		if (meta) {
			fs.write(metaFile(ctx), layoutJson(JSON.stringify(meta)));
			// Metadata written here before this scan started is in it now.
			settleMetaPending(ctx, new Date(started).toISOString());
		}
	}
	const index = mergeIndex(src.value, meta, new Date(ctx.ports.clock.now()).toISOString(), ctx.runtimeKeyId);
	//分行写（S37 2-A.3）：几 MB 一整行时 grep 一命中就是整份，bash 的 50 KB 上限把它截成「没有输出」
	fs.write(ctx.layout.impactIndex, layoutJson(JSON.stringify(index)));
	// No name catalog is written beside it any more (S19): queries compute it from
	// the index in hand (S17 2.2), so a file on disk could only ever be unread or
	// older than the index.
	const text = [
		...formatBuild(index, ctx.ports.clock.now()),
		`${P}非实体元数据对象 ${(index.artifacts ?? []).length} 个（打印模板 / 调度任务 / 开放 API / BOTP 规则 / 工作流，按自己的编号收）`,
		`${P}→ ${ctx.layout.impactIndex}（可随时重建，不进 Git）`,
	].join("\n");
	return ok({
		action: "build",
		metadata: meta !== null,
		index: {
			at: index.at,
			files: index.src.files,
			classes: index.src.classes,
			entityRefs: index.src.entityRefs,
			fieldRefs: index.src.fieldRefs,
			bindings: index.meta?.bindings ?? 0,
			templates: index.templates.length,
			fields: index.fields.length,
		},
		file: ctx.layout.impactIndex,
		text,
		notes,
	});
}

/** What opening a project did about the index (S17 2.6, moved in from S16 3.1). */
export interface IndexRefresh {
	/**
	 *   fresh   -- the index on disk still describes the sources; nothing ran
	 *   rebuilt -- the static side was rebuilt, the metadata side carried over
	 *   skipped -- not attempted (the project has no build artifacts yet)
	 *   failed  -- attempted and failed; the project is open all the same
	 */
	state: "fresh" | "rebuilt" | "skipped" | "failed";
	/** One sentence for the person, in plain words. */
	text: string;
	ms?: number;
}

/**
 * Why the index on disk no longer describes this project's sources, or null when
 * it still does.
 *
 * Only what can be read off the disk for free: a missing or unreadable index, one
 * built under another runtime, a changed number of source files (catches a
 * deletion, which leaves no newer mtime behind) and any source edited after the
 * index was built.
 */
export function indexStaleReason(ctx: KernelContext): string | null {
	const loaded = loadIndex(ctx);
	if (!loaded.ok) return "还没有代码关系表";
	const index = loaded.value;
	if (index.runtimeKeyId !== ctx.runtimeKeyId) return "代码关系表建于另一个运行时";
	if (!Array.isArray(index.edges) || !Array.isArray(index.effects) || !Array.isArray(index.callArgs))
		return "代码关系表是旧版建的，没记调用关系、外部调用或调用时传的参数";
	const tool = srcToolPrint(ctx);
	if (tool !== null && index.src.tool !== tool) return "建表的扫描工具换过了";
	const { fs } = ctx.ports;
	const files = ctx.layout.moduleDirs.filter((dir) => fs.exists(dir.src)).flatMap((dir) => fs.listJavaFiles(dir.src));
	if (files.length !== index.src.files) {
		return `源文件数变了（建表时 ${index.src.files} 个，现在 ${files.length} 个）`;
	}
	const builtAt = Date.parse(index.at);
	if (Number.isNaN(builtAt)) return "代码关系表的建立时间读不出来";
	const changed = files.filter((file) => (fs.mtimeMs(file) ?? 0) > builtAt).length;
	return changed > 0 ? `${changed} 个源文件在建表之后改过` : null;
}

/**
 * Rebuilds the static side of the index when it is stale -- the automatic half of
 * S16 3.1, pulled into S17 2.6 because every S17 improvement degrades to "not
 * judged" without an index.
 *
 * Three rules, each for a way this could go wrong:
 *   - **Never triggers a Gradle build.** `buildSrcIndex` would run `ensureBuilt`,
 *     which is minutes of Gradle on a freshly cloned project; that is not
 *     something opening a project may do behind anyone's back.
 *   - **Never the metadata side.** That needs the shared environment and tens of
 *     seconds; `srcOnly` carries the previous metadata side over unchanged.
 *   - **Never refuses.** A failure is a sentence, and the project is open anyway:
 *     no index is reported as no index by every reader, never treated as a pass.
 */
export async function refreshIndexIfStale(ctx: KernelContext, runProbe: RunProbe = probe): Promise<IndexRefresh> {
	const artifacts = artifactState(ctx);
	if (artifacts.state === "missing") {
		return { state: "skipped", text: "工程还没构建，代码关系表等第一次编译之后再建" };
	}
	if (artifacts.state === "stale") {
		return { state: "skipped", text: `${artifacts.reason}；下一次编译会重新生成，代码关系表到那时再建` };
	}
	const why = indexStaleReason(ctx);
	if (why === null) return { state: "fresh", text: "代码关系表是最新的" };
	const started = ctx.ports.clock.now();
	const built = await actionBuild(ctx, { action: "build", srcOnly: true }, runProbe);
	const ms = ctx.ports.clock.now() - started;
	if (!built.ok) {
		return {
			state: "failed",
			text:
				`${why}，自动重建代码关系表没成功（${built.error.code}：${built.error.message}）。不影响继续干活；` +
				"要查影响范围时手动跑 cosmic_doctor action=reindex srcOnly=true",
			ms,
		};
	}
	const seconds = (ms / 1000).toFixed(1);
	return {
		state: "rebuilt",
		text: built.value.metadata
			? `${why}，已自动重建代码关系表的代码部分（${seconds} 秒）；单据挂载等元数据部分沿用上次的`
			: `${why}，已自动重建代码关系表的代码部分（${seconds} 秒）；还没有元数据部分，插件挂在哪张单据上查不到 —— ` +
				"连得上环境时跑一次 cosmic_doctor action=reindex（不带 srcOnly）补上",
		ms,
	};
}

const CJK_TERM = /[㐀-鿿]/;

/** A Chinese term and the named objects it resolved to through the name catalog. */
export interface NamedTerm {
	term: string;
	hits: NameHit[];
}

/** A catalog entry as an impact entry point: a bill, a print template the index knows as one, otherwise an artifact. */
function targetOfEntry(entry: CatalogEntry, lk: IndexLookup): Target {
	if (entry.kind === "entity") return { kind: "entity", value: entry.id };
	if (entry.kind === "print_template" && lk.byTemplate.has(entry.id)) return { kind: "template", value: entry.id };
	return {
		kind: "artifact",
		value: entry.id,
		artifactKind: entry.kind,
		...(entry.owner ? { entity: entry.owner } : {}),
	};
}

/**
 * What the name catalog can and cannot answer, for the refusal a Chinese term
 * gets when it matched nothing. "No match" alone reads as "no such object"; the
 * truth is usually "that family has no names here".
 */
function nameCoverage(index: ImpactIndex): string {
	const catalog = buildCatalog(index);
	const gap = artifactGap(index);
	const covered =
		catalog.objects === 0
			? catalogGap(catalog)
			: `中文名对照表收单据、打印模板、调度任务、开放接口、转换规则、工作流的设计态名字（${catalog.entries.length} 个对象），说法里要有完整的名字`;
	const bills = (index.billNames ?? []).length === 0 ? "；单据名要完整重建一次快照才有" : "";
	return `${covered}${bills}；字段没有中文名可查${gap === "" ? "" : `（另外：${gap}）`}`;
}

/**
 * Resolves the entry terms, or explains why nothing matched.
 *
 * A term that is not an identifier and carries Chinese goes through the name
 * catalog (S17 2.1), computed from the index in hand rather than read from
 * `metadata-catalog.json`, so it can be neither missing nor older than the index
 * (S17 2.2). A name matches only when the term contains that object's whole
 * design-time name -- never a fragment of it, which is the mistake that once
 * turned 14 objects into 7,215 "names". Every object that matched is kept:
 * picking one would be guessing on the user's behalf.
 */
function resolveTerms(
	index: ImpactIndex,
	terms: readonly string[],
): KernelResult<{ targets: Target[]; lk: IndexLookup; named: NamedTerm[]; unknown: UnknownTerm[] }> {
	const lk = lookup(index);
	const catalog = terms.some((term) => CJK_TERM.test(term)) ? buildCatalog(index) : null;
	const targets: Target[] = [];
	const named: NamedTerm[] = [];
	const unknown: UnknownTerm[] = [];
	for (const term of terms) {
		const direct = resolveTarget(index, term, lk);
		if (direct.length > 0 || catalog === null || !CJK_TERM.test(term)) {
			targets.push(...direct);
			if (direct.length === 0) unknown.push({ term, why: unknownWhy(index, lk, term) });
			continue;
		}
		const hits = resolveNames(catalog, term);
		if (hits.length === 0) {
			unknown.push({ term, why: "中文名没对上任何对象" });
			continue;
		}
		named.push({ term, hits });
		targets.push(...hits.map((hit) => targetOfEntry(hit.entry, lk)));
	}
	const seen = new Set<string>();
	const unique = targets.filter((target) => {
		const key = [target.kind, target.value, target.entity ?? "", target.artifactKind ?? ""].join(" ");
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	if (unique.length > 0) return ok({ targets: unique, lk, named, unknown });
	// The two common failures: a mistyped letter, and a Chinese phrase that names
	// nothing the catalog holds. The first gets the closest real name; the second
	// gets what the catalog covers, so "no match" is not read as "no such object".
	const near = terms.flatMap((term) => suggest(index, term, lk));
	const remedy: string[] = [];
	const qualified = terms.filter((term) => /^[a-z]/.test(term) && splitQualified(term, lk) !== null);
	if (qualified.length > 0) remedy.push(qualified.map((term) => `${term}：${unknownWhy(index, lk, term)}`).join("；"));
	else if (near.length > 0) remedy.push(`最接近的是：${near.map((x) => `${x.value}(${x.kind})`).join(" / ")}`);
	if (terms.some((term) => CJK_TERM.test(term))) {
		remedy.push(
			`中文名没对上任何对象。${nameCoverage(index)}。说的是字段的话，先探查出字段标识，再用 cosmic_impact 查询`,
		);
	} else if (near.length === 0 && qualified.length === 0) {
		remedy.push("类是新加的就先 cosmic_doctor action=reindex srcOnly=true");
	}
	return err(
		new KernelError(
			"IMPACT_TARGET_UNKNOWN",
			qualified.length === terms.length
				? `查询写法或标识未对上索引：「${terms.join(" ")}」`
				: `索引里没有「${terms.join(" ")}」—— 类名、实体标识、字段标识、源文件路径、元数据对象编号或中文名都可以`,
			{ detail: { terms, suggestions: near.map((x) => x.value) }, remedy: remedy.join(" ") },
		),
	);
}

/** What part of a term that resolved to nothing was not recognised. */
function unknownWhy(index: ImpactIndex, lk: IndexLookup, term: string): string {
	const split = /^[a-z]/.test(term) ? splitQualified(term, lk) : null;
	if (split && !(split.entityKnown && split.fieldKnown)) {
		// An unknown qualifier is not an unknown field. Keep the query refused,
		// but offer the known field as an explicit, broader query rather than
		// silently treating an entry key or a mistyped bill as the requested bill.
		const why = [
			split.entityKnown ? "" : `首段「${split.entity}」未识别为单据实体，限定字段查询必须以整张单据的实体标识开头`,
			split.fieldKnown
				? `字段 ${split.field} 已在索引中`
				: lk.fieldsAll
					? `字段 ${split.field} 代码里没读写过，代码碰过、挂了插件的单上也都没有`
					: `字段 ${split.field} 在当前索引中未记到`,
			index.meta ? "" : "当前没有元数据快照，不能据此判断单据或字段不存在",
		].filter(Boolean);
		if (!split.entityKnown) {
			const withBill = ["单据实体", split.entity, ...split.path, split.field].join(".");
			why.push(`若 ${split.entity} 是分录，请补上所属单据，写成 ${withBill}`);
			if (split.fieldKnown) {
				why.push(
					`也可先用 cosmic_impact terms=${JSON.stringify([split.field])} 查跨单据的同名读写，再确认所属单据`,
				);
			}
		}
		const near = split.fieldKnown ? [] : suggest(index, split.field, lk).filter((x) => x.kind === "field");
		return `${why.join("；")}${near.length > 0 ? `；相近的字段 ${near.map((x) => x.value).join(" / ")}` : ""}`;
	}
	const near = suggest(index, term, lk);
	return near.length > 0 ? `最接近的是 ${near.map((x) => x.value).join(" / ")}` : "代码和快照里都没有";
}

export function queryImpact(ctx: KernelContext, request: ImpactRequest): KernelResult<ImpactQueryDetail> {
	const loaded = loadIndex(ctx);
	if (!loaded.ok) return err(loaded.error);
	const index = loaded.value;
	const resolved = resolveTerms(index, request.terms ?? []);
	if (!resolved.ok) return err(resolved.error);
	const { lk } = resolved.value;
	// A field entry point is answered with its read/write sites; everything else
	// with the class surface. The surface of a field's classes is what a class
	// entry point is for.
	const fieldTargets = resolved.value.targets.filter((target) => target.kind === "field");
	const otherTargets = resolved.value.targets.filter((target) => target.kind !== "field");
	const impact = impactOf(index, otherTargets, lk);
	const traces = fieldTargets.map((target) => traceField(index, lk, target));
	// Which object each Chinese name turned into goes first: everything below is
	// about that object, and a reader who meant a different one has to be able to
	// stop here. Whether the artifact channel was complete is said by formatImpact,
	// on the line that lists the artifacts.
	const lines = [
		...namedLines(resolved.value.named),
		...(resolved.value.unknown.length > 0
			? [`${P}没认出：${resolved.value.unknown.map((x) => `${x.term}（${x.why}）`).join("；")}`]
			: []),
		...traces.flatMap((trace) => formatTrace(trace, lk, { all: !!request.dynamic })),
		...(otherTargets.length === 0
			? []
			: request.dynamic
				? formatImpact(index, impact, { showUnresolved: true, now: ctx.ports.clock.now() })
				: formatBrief(index, impact, lk, { isv: ctx.config.isv ?? "", now: ctx.ports.clock.now() })),
	];
	// **This is for the USER, not only for the agent.** When they ask for a change
	// they do not know which bills it will touch, who else writes the same field,
	lines.push(`${P}动手前把上面的影响面、牵动实体和同字段写入者转述给用户；此刻纠正范围最便宜。`);
	const examples =
		request.event === undefined ? undefined : eventExamples(ctx, index, resolved.value.targets, request.event);
	return ok({
		action: "query",
		targets: resolved.value.targets,
		impact,
		traces,
		unknown: resolved.value.unknown,
		text: lines.join("\n"),
		notes: runtimeNote(ctx, index),
		...(examples === undefined ? {} : { examples }),
	});
}

/** How many candidates one ambiguous name lists before it only counts. */
const NAME_CANDIDATES = 8;

/**
 * One line per Chinese term: the object it became, or -- when it matched more
 * than one -- all of them, marked, with the way to ask about one alone.
 */
function namedLines(named: readonly NamedTerm[]): string[] {
	const out: string[] = [];
	for (const { term, hits } of named) {
		const labels = hits.map((hit) => objectLabel(hit.entry.kind, hit.entry.id, hit.names[0]));
		if (hits.length === 1) {
			out.push(`${P}中文名「${term}」→ ${labels[0]}`);
			continue;
		}
		const shown = labels.slice(0, NAME_CANDIDATES).join(" / ");
		out.push(
			`${P}⚠ 中文名「${term}」对上了 ${hits.length} 个对象（有歧义）：${shown}${hits.length > NAME_CANDIDATES ? " …" : ""}`,
		);
		out.push(`${P}  下面是它们的并集，不是一个对象的影响面。先跟用户确认是哪一个，再用编号单独查：`);
		out.push(`${P}  cosmic_impact terms=["${hits[0]?.entry.id ?? ""}"]`);
	}
	return out;
}

/**
 * 内部结果 → 报文。收窄发生在这一层，而不是在 `queryImpact` 里面：
 * 内核里别的调用方还要那份完整的。
 */
export function queryReport(detail: ImpactQueryDetail): ImpactQueryReport {
	const unresolved = new Map<string, number>();
	for (const row of detail.impact.unresolved) {
		const key = String(row.resolution);
		unresolved.set(key, (unresolved.get(key) ?? 0) + 1);
	}
	const traced = detail.traces.filter((trace) => trace.elsewhere.length <= 1);
	const union = (a: readonly string[], b: readonly string[]) => [...new Set([...a, ...b])];
	return {
		action: "query",
		targets: detail.targets,
		...(detail.unknown.length > 0 ? { unknown: detail.unknown } : {}),
		impact: {
			classes: union(
				detail.impact.classes.map((cls) => cls.class),
				traced.flatMap((trace) => traceClasses(trace)),
			),
			entities: union(
				detail.impact.entities.map((entity) => entity.key),
				traced.flatMap((trace) => (trace.entity ? [trace.entity] : [])),
			),
			fields: union(
				detail.impact.fields.map((field) => field.key),
				traced.map((trace) => trace.target.value),
			),
			templates: [...detail.impact.templates],
			artifacts: detail.impact.artifacts.map((row) => ({
				kind: row.kind,
				id: row.id,
				...(row.name ? { name: row.name } : {}),
			})),
			unresolved: [...unresolved].map(([resolution, count]) => ({ resolution, count })),
		},
		text: detail.text,
		notes: detail.notes,
		...(detail.examples === undefined
			? {}
			: {
					eventLocations: {
						status: detail.examples.status,
						note: [
							"同单据、同名事件的源码位置，仅供导航；是否执行同一业务需核对注册布局和代码。",
							detail.examples.status === "partial" ? detail.examples.message : "",
						]
							.filter(Boolean)
							.join("；"),
						items: detail.examples.items.map((item) => ({
							reference: item.reference,
							class: String(item.configuration.class ?? ""),
							signature: String(item.configuration.signature ?? ""),
							bindings: item.configuration.bindings ?? null,
							sourceSha256: String(item.configuration.sourceSha256 ?? ""),
							indexAt: typeof item.configuration.indexAt === "string" ? item.configuration.indexAt : null,
						})),
						omitted: detail.examples.omitted,
					},
				}),
	};
}

function actionStatus(ctx: KernelContext): KernelResult<ImpactStatusReport> {
	const loaded = loadIndex(ctx);
	if (!loaded.ok) return err(loaded.error);
	const index = loaded.value;
	const notes = runtimeNote(ctx, index);
	const text = [`${P}建于 ${index.at}`, ...formatBuild(index, ctx.ports.clock.now()), ...notes].join("\n");
	return ok({
		action: "status",
		at: index.at,
		runtimeKeyId: index.runtimeKeyId ?? null,
		sameRuntime: index.runtimeKeyId === ctx.runtimeKeyId,
		text,
		notes,
	});
}

function relativeToRoot(ctx: KernelContext, file: string): string {
	const root = ctx.projectRoot.replace(/\\/g, "/").replace(/\/$/, "");
	const norm = file.replace(/\\/g, "/");
	return norm.startsWith(`${root}/`) ? norm.slice(root.length + 1) : norm;
}

/**
 * `fast` follow-up: **which form each plugin just compiled is actually registered on.**
 *
 * The mistake this exists to remove costs a full Cosmic start every time and
 * produces no error of any kind: the plugin is written for a bill, the obvious
 * form to simulate is that bill's main form, the registration is on a different
 * one, and FormSim reports a form whose plugin never loaded -- "没生效" that looks
 * exactly like a broken plugin. The index already holds the answer (metadata-side
 * `bindings`), and `impact` will tell you if you ask; nobody asks, because at the
 * moment of compiling you do not yet know there is a question. So the compile
 * says it.
 *
 * Only registration is reported, never entity references: a plugin reads a dozen
 * entities and is registered on one or two, and burying those two is the same as
 * not printing them.
 *
 * The registration is on a LAYOUT, and the layout is what has to be simulated.
 * `t_meta_formdesign` gives both -- the layout's own number and the entity it
 * belongs to -- and printing only the entity produced the worst outcome this
 * whole function exists to prevent: a bill with three layouts, a plugin on one
 * of them, "登记在：<the entity>" as the answer, FormSim run against the entity,
 * and a PASS, because `FormSim.resolveTarget` drops a layout to its entity and
 * kept going with a plugin list that never contained the class. A false PASS is
 * worse than the error it replaced -- it is promotable to a regression case.
 */
export function boundForms(ctx: KernelContext, files: readonly string[]): string[] {
	if (files.length === 0) return [];
	const loaded = loadIndex(ctx);
	if (!loaded.ok) return [];
	const lk = lookup(loaded.value);
	const snapshot = snapshotLabel(loaded.value, ctx.ports.clock.now());
	const out: string[] = [];
	for (const file of files) {
		for (const target of resolveTarget(loaded.value, relativeToRoot(ctx, file), lk)) {
			if (target.kind !== "class") continue;
			const cls = lk.byClass.get(target.value);
			if (!cls?.pluginType) continue;
			const simple = target.value.slice(target.value.lastIndexOf(".") + 1);
			if (cls.bindings.length === 0) {
				out.push(
					`${simple} 在元数据里查不到登记（${cls.pluginType} 类插件，${snapshot}）—— 还没挂，或是快照之后才挂的`,
				);
				continue;
			}
			const forms = cls.bindings.filter((binding) => binding.kind === undefined || binding.kind === "form");
			const layoutBound = forms.some((binding) => binding.numbers.some((number) => number !== binding.entity));
			// Only a form registration is something FormSim loads; an operation, print,
			// convert or task plugin is verified by the run that fires it, and telling
			// those to "mount on FormSim" sent the reader to a route that cannot see them.
			out.push(
				`${simple} 登记在：${registrationText(cls.bindings)}（${snapshot}）` +
					(forms.length === 0
						? ""
						: " —— FormSim 要挂这个表单，挂主表单看不到它生效" +
							(layoutBound
								? "；登记在布局上，FORM_ENTITY 就给布局标识，给实体会落到另一份插件清单上跑出假 PASS"
								: "")),
			);
		}
	}
	return out;
}

export interface FormPluginSites {
	/** Project plugin classes registered on exactly this identifier. */
	onTarget: string[];
	/** Sibling layouts of the same entity that carry registrations this target does not. */
	elsewhere: { layout: string; classes: string[] }[];
	/** `快照 09-23，10 天前`: the registrations are as of then. */
	snapshot: string;
}

/**
 * The top-level package segments this project's own classes live under.
 *
 * Read from the index rather than from a configured ISV name: another customer's
 * package is not called after their ISV, and a guess here is worse than nothing —
 * it makes a probe point at the wrong owner with a straight face.
 */
export function projectPackagePrefixes(ctx: KernelContext): string[] {
	const loaded = loadIndex(ctx);
	if (!loaded.ok) return [];
	const roots = new Set<string>();
	for (const cls of loaded.value.classes) {
		const root = cls.class.split(".")[0];
		if (root !== undefined && root !== "") roots.add(`${root}.`);
	}
	return [...roots].sort();
}

/** One class this project registered on a given target, with the site that registered it. */
export interface TargetRegistration {
	/** Fully-qualified class name, as the index records it. */
	class: string;
	/** Registration site family: form / entity / print / task / api / convert / workflow. */
	kind: string;
	/** The registering object's own number; empty when the registration is on the entity itself. */
	layout: string;
	enabled: boolean;
}

/**
 * Every plugin class this project has registered ON a target, entity or layout.
 *
 * Why this exists separately from a source scan: the external-side-effect gate
 * used to decide "is this plugin on the chain?" by asking whether the file's
 * text mentions the target identifier. On the real ledger that judged a push
 * plugin of a DIFFERENT bill to be on `zlgd_qty_wtd`'s save chain -- it only
 * named the bill because it pushes to it -- and refused a run that `OpMetaProbe`
 * showed had two plugins on it, neither of them the accused. A refusal with no
 * appeal channel has to be right, so it now reads the registration the platform
 * itself reads.
 *
 * Returns null when there is no index: "no index" and "no registration" are
 * different claims and the caller must be able to tell them apart. Alongside the
 * list: the snapshot the registrations come from, and for each class whether it
 * reaches an out-of-transaction call through the project's own utility classes.
 */
export function targetRegistrations(
	ctx: KernelContext,
	target: string,
): { list: TargetRegistration[]; snapshot: string; reach: (cls: string) => EffectReach | null } | null {
	const loaded = loadIndex(ctx);
	if (!loaded.ok) return null;
	const out: TargetRegistration[] = [];
	for (const cls of loaded.value.classes) {
		for (const binding of cls.bindings) {
			// No number means the registration sits on the entity itself; a number
			// means the registering object (layout, template, task, API…) is the
			// thing the run was aimed at.
			const onEntity = binding.numbers.length === 0 && binding.entity === target;
			const onNumber = binding.numbers.includes(target);
			if (!onEntity && !onNumber) continue;
			out.push({
				class: cls.class,
				kind: binding.kind ?? "",
				layout: onNumber ? target : "",
				enabled: binding.enabled,
			});
		}
	}
	return {
		list: out,
		snapshot: snapshotLabel(loaded.value, ctx.ports.clock.now()),
		reach: effectReacher(loaded.value),
	};
}

/**
 * Where this project's plugins are registered, relative to one form identifier.
 *
 * The counterpart to `boundForms`, asked from the other end: `boundForms` runs
 * after a compile and says "the class you just built is registered over there",
 * this runs before a form simulation and says "the identifier you are about to
 * simulate has none of your plugins on it, they are on these layouts".
 *
 * Both exist because the failure is silent in the expensive direction.
 * `FormSim.resolveTarget` accepts an entity number as a layout number -- the
 * bill's own generic layout -- loads whatever plugins that layout carries, and
 * asserts happily against fields nothing populated. The result is a PASS on a
 * plugin that never ran, at the cost of a full cold start, and it is promotable
 * to a regression case, which is how a false PASS outlives the session.
 *
 * Returns null when there is no index to read: a missing index is not evidence
 * that nothing is registered, and the caller has to be able to tell those apart.
 *
 * Only what a form simulation loads counts: form registrations, and operation
 * registrations on the target itself. A binding's number is a layout only for a
 * form; for an open API, a workflow or a conversion rule it is that object's own
 * number, and naming it as "the layout to simulate instead" was every one of the
 * 17 warnings this gave on the real project (S17 5.2).
 */
export function formPluginSites(ctx: KernelContext, target: string): FormPluginSites | null {
	const loaded = loadIndex(ctx);
	if (!loaded.ok) return null;
	const onTarget = new Set<string>();
	const byLayout = new Map<string, Set<string>>();
	for (const cls of loaded.value.classes) {
		if (cls.pluginType === null) continue;
		for (const binding of cls.bindings) {
			const form = binding.kind === undefined || binding.kind === "form";
			if (!form && binding.kind !== "entity") continue;
			// A registration names its layout; a binding with no layout number is
			// registered on the entity itself.
			if (binding.numbers.length === 0 ? binding.entity === target : binding.numbers.includes(target)) {
				onTarget.add(cls.class);
				continue;
			}
			// Siblings only. A layout under a different entity says nothing about
			// this target, and reporting it would turn the warning into noise.
			if (!form || binding.entity !== target) continue;
			for (const layout of binding.numbers) {
				const list = byLayout.get(layout);
				if (list) list.add(cls.class);
				else byLayout.set(layout, new Set([cls.class]));
			}
		}
	}
	return {
		onTarget: [...onTarget].sort(),
		elsewhere: [...byLayout]
			.map(([layout, classes]) => ({ layout, classes: [...classes].sort() }))
			.sort((a, b) => a.layout.localeCompare(b.layout)),
		snapshot: snapshotLabel(loaded.value, ctx.ports.clock.now()),
	};
}

export async function impact(
	ctx: KernelContext,
	request: ImpactRequest = {},
	/** Injection point for tests; production uses the real probe entry point. */
	runProbe: RunProbe = probe,
): Promise<KernelResult<ImpactReport>> {
	const action = request.action ?? "query";
	if (action === "build") return actionBuild(ctx, request, runProbe);
	if (action === "status") return actionStatus(ctx);
	if ((request.terms ?? []).length === 0) {
		return err(
			new KernelError(
				"IMPACT_TARGET_UNKNOWN",
				`action=${action} 要给入口：类名 / 实体标识 / 字段标识（或 实体.字段）/ 源文件路径 / 元数据对象编号 / 中文名`,
				{ remedy: '例如 cosmic_impact terms=["QTYWTDOpPlugin"]；只想看索引本身用 action=status。' },
			),
		);
	}
	// Line numbers are only worth handing out if they match the source on disk:
	// a file edited in this session would otherwise send the reader to a line
	// that has moved. Same check and same rebuild as opening the project.
	const refresh = await refreshIndexIfStale(ctx, runProbe);
	const detail = queryImpact(ctx, request);
	if (!detail.ok) return detail;
	const report = queryReport(detail.value);
	if (refresh.state === "rebuilt") report.notes.unshift(`${P}${refresh.text}`);
	else if (refresh.state !== "fresh" && indexStaleReason(ctx) !== null) {
		report.notes.unshift(`${P}行号可能和源码对不上：${refresh.text}`);
	}
	return ok(report);
}
