/**
 * 「缓存」面板的清单：用户关心的索引和磁盘缓存，每一项在哪、多大、是否最新、自动更新规则、
 * 下次自动执行的时间，以及可以手动执行的操作。给界面用，不发给模型。
 *
 * 只列用户需要了解、可能需要手动处理的两类：
 *   - 索引：代码关系表（代码部分、元数据部分）、表单目录、单据运行态字段；
 *   - 磁盘缓存：会话过程文件、草稿和临时探针、旧运行时版本的目录。
 * 运行中记的账（必录字段、平台异常、重复提问、知识卡片发送记录）、当前运行时的探针环境、知识库快照、
 * 内存里的缓存都由程序自己维护，不列。
 *
 * 规则本身不在这里定，只照着读：寿命和清理看 `cosmic-dirs.ts`，代码关系表何时自动重建看
 * `commands/impact.ts`（`refreshIndexIfStale`、`refreshMeta`），`@` 引用看 `commands/mention.ts`，
 * 运行时目录看 `runtime/cache-reclaim.ts`。这里写错只会让面板显示错，不改变任何东西何时被删。
 *
 * 「下次自动」分两种：有确定时刻的（到期重建、定时清理）给时刻；按条件触发的（源码修改、新会话）
 * 只写条件，不推算时刻。
 */

import { join } from "node:path";
import { KEEP, RECLAIM_INTERVAL_MS, RECLAIM_STAMP } from "../../runtime/cache-reclaim.ts";
import { FORM_CATALOG_TTL_MS, formsFile, RUNTIME_FIELDS_TTL_MS, runtimeDir } from "../commands/mention.ts";
import type { KernelContext } from "../context.ts";
import { metaCheckFile, metaPending, readJsonFile } from "../impact/meta-state.ts";
import type { MetaCheck } from "../impact/model.ts";
import type { FsPort } from "../ports.ts";
import {
	AD_HOC_PROBES_DIR,
	DRAFT_MAX_AGE_MS,
	measure,
	SCRATCH_DIR,
	SESSION_IDLE_MS,
	SESSIONS_DIR,
	SWEEP_FILE,
	SWEEP_INTERVAL_MS,
} from "./cosmic-dirs.ts";

/** 面板上可执行的操作；执行在宿主（`src/dsh/cache-board.ts`）。 */
export type CacheActionId =
	| "rebuild-src"
	| "check-meta"
	| "rebuild-all"
	| "rebuild-forms"
	| "clear"
	| "sweep"
	| "reclaim-runtimes";

export interface CacheAction {
	id: CacheActionId;
	label: string;
	/** 需要连接苍穹环境（常驻 JVM 运行中） */
	jvm?: boolean;
	/** 执行前需要确认：耗时较长，或删除后需重新生成 */
	confirm?: string;
}

/**
 *   fresh    最新；stale 已过期或落后，会自动更新（`nextText` 写明何时）；
 *   missing  尚未生成；info 仅展示占用和清理规则，没有新旧之分
 */
export type CacheState = "fresh" | "stale" | "missing" | "info";

export interface CacheItem {
	id: string;
	name: string;
	/** 用途 */
	what: string;
	/** 位置（工程内为相对 `.cosmic-ai/` 的路径，用户目录下为完整路径） */
	where: string[];
	files: number;
	bytes: number | null;
	/** 最近一次更新的时刻（毫秒）；无法确定为 null */
	updatedAt: number | null;
	state: CacheState;
	stateText: string;
	/** 自动更新、自动清理的规则 */
	auto: string;
	/** 下次自动执行的确定时刻；按条件触发的为 null */
	nextAt: number | null;
	nextText: string;
	actions: CacheAction[];
}

export interface CacheGroup {
	id: string;
	name: string;
	items: CacheItem[];
}

export interface CacheInventoryInput {
	ctx: KernelContext;
	/** `indexStaleReason` 的结果：需要读取代码关系表并列出源文件，由调用方计算后传入 */
	indexStale: string | null;
	now: number;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const spanText = (ms: number): string =>
	ms >= DAY
		? `${Math.round(ms / DAY)} 天`
		: ms >= HOUR
			? `${Math.round(ms / HOUR)} 小时`
			: `${Math.round(ms / 60000)} 分钟`;

/** 文件中记录的时刻：`{"at": ISO 或毫秒}`；读不出为 null。 */
function stampAt(fs: FsPort, file: string): number | null {
	const raw = fs.exists(file) ? fs.read(file).trim() : "";
	if (raw === "") return null;
	try {
		const at = (JSON.parse(raw) as { at?: unknown }).at;
		const ms = typeof at === "number" ? at : typeof at === "string" ? Date.parse(at) : Number.NaN;
		return Number.isNaN(ms) ? null : ms;
	} catch {
		return null;
	}
}

/** 目录下全部文件的最新、最早修改时间。 */
function mtimes(fs: FsPort, dir: string): { newest: number | null; oldest: number | null; files: string[] } {
	const files: string[] = [];
	const visit = (path: string): void => {
		for (const entry of fs.readDir(path)) {
			const child = join(path, entry.name);
			if (entry.isDirectory) visit(child);
			else files.push(child);
		}
	};
	if (fs.exists(dir)) visit(dir);
	let newest: number | null = null;
	let oldest: number | null = null;
	for (const file of files) {
		const t = fs.mtimeMs(file);
		if (t === null) continue;
		newest = newest === null ? t : Math.max(newest, t);
		oldest = oldest === null ? t : Math.min(oldest, t);
	}
	return { newest, oldest, files };
}

/** 若干文件、若干目录（递归）合计的文件数和字节数；无法统计大小时字节为 null。 */
function sized(
	fs: FsPort,
	files: readonly string[],
	dirs: readonly string[] = [],
): { files: number; bytes: number | null } {
	let count = 0;
	let bytes: number | null = 0;
	const add = (m: { files: number; bytes: number | null }) => {
		count += m.files;
		bytes = bytes === null || m.bytes === null ? null : bytes + m.bytes;
	};
	for (const file of files) if (fs.exists(file)) add(measure(fs, file, false));
	for (const dir of dirs) if (fs.exists(dir)) add(measure(fs, dir, true));
	return { files: count, bytes };
}

const localTime = (ms: number): string => new Date(ms).toLocaleString("zh-CN", { hour12: false });

/** 下一次例行清理（打开工程时执行，两次至少间隔一小时）最早的时刻。 */
function nextSweep(fs: FsPort, workDir: string, now: number): number {
	const last = stampAt(fs, join(workDir, SWEEP_FILE));
	return last === null ? now : Math.max(now, last + SWEEP_INTERVAL_MS);
}

const SWEEP_ACTION: CacheAction = { id: "sweep", label: "立即清理" };
const SWEEP_RULE = `打开工程时执行例行清理，两次至少间隔 ${spanText(SWEEP_INTERVAL_MS)}`;

/** 变更检查结果的书面说法；检查本身写的 `text` 是给模型看的短句，不直接上面板。 */
function checkResult(check: MetaCheck): string {
	switch (check.state) {
		case "same":
			return "无变更";
		case "patched":
			return `发现 ${check.changed} 处变更，已增量更新`;
		case "over":
			return `发现 ${check.changed} 处变更，超过单次增量更新上限，需完整重建`;
		case "baseline":
			return "缺少比对基准，需完整重建";
		case "failed":
			return `检查未完成：${check.text}`;
	}
}

function impactItems(input: CacheInventoryInput): CacheItem[] {
	const { ctx, indexStale } = input;
	const { fs } = ctx.ports;
	const work = ctx.layout.impactWork;
	const srcFile = join(work, "src-index.json");
	const metaFile = join(work, "meta-index.json");
	const hasIndex = fs.exists(ctx.layout.impactIndex);
	const src: CacheItem = {
		id: "impact-src",
		name: "代码关系表（代码部分）",
		what: "本工程源码中各类对单据、字段的读写关系及调用关系，用于影响范围分析和读写位置定位",
		where: ["work/impact.json", "work/impact/src-index.json"],
		...sized(fs, [ctx.layout.impactIndex, srcFile]),
		updatedAt: fs.mtimeMs(srcFile),
		state: !hasIndex ? "missing" : indexStale === null ? "fresh" : "stale",
		stateText: !hasIndex ? "尚未生成" : indexStale === null ? "与源码一致" : `已落后：${indexStale}`,
		auto: "源码修改或运行时版本变化后，在下一次工具调用时自动重建，无需连接环境，约 20 秒；不会触发工程编译",
		nextAt: null,
		nextText: indexStale === null ? "源码修改后的下一次工具调用" : "下一次工具调用",
		actions: [{ id: "rebuild-src", label: "重建" }],
	};
	const check = readJsonFile<MetaCheck>(ctx, metaCheckFile(ctx));
	const pending = metaPending(ctx);
	const hasMeta = fs.exists(metaFile);
	const checkText =
		check === null
			? "尚未执行变更检查"
			: `最近一次变更检查（${localTime(Date.parse(check.at))}）：${checkResult(check)}`;
	const metaStale =
		pending !== null || check?.state === "over" || check?.state === "failed" || check?.state === "baseline";
	const meta: CacheItem = {
		id: "impact-meta",
		name: "代码关系表（元数据部分）",
		what: "插件在各单据上的注册情况、打印模板与调度任务登记，以及本 ISV 设计中的字段归属（所在层级、名称、类型）",
		where: ["work/impact/meta-index.json", "work/impact/meta-check.json"],
		...sized(fs, [metaFile, metaCheckFile(ctx)]),
		updatedAt: fs.mtimeMs(metaFile),
		state: !hasMeta ? "missing" : metaStale ? "stale" : "fresh",
		stateText: !hasMeta
			? "尚未生成，需连接环境完整构建一次"
			: pending !== null
				? `本机已写入元数据 ${pending.writes.length} 次，尚未增量更新；${checkText}`
				: checkText,
		auto: "每个会话首次使用常驻 JVM 时检查环境中的元数据变更（约 1 秒），对变更部分增量更新（单次上限 100 处）；本机写入元数据后再检查一次。不会为此启动 JVM",
		nextAt: null,
		nextText: pending !== null ? "下一次使用常驻 JVM 时增量更新" : "下一个会话首次使用常驻 JVM 时检查",
		actions: [
			{ id: "check-meta", label: "检查变更", jvm: true },
			{
				id: "rebuild-all",
				label: "完整重建",
				jvm: true,
				confirm: "完整重建将从环境读取本 ISV 的全部设计，耗时约 2 分钟。确认执行？",
			},
		],
	};
	return [src, meta];
}

function mentionItems(input: CacheInventoryInput): CacheItem[] {
	const { ctx, now } = input;
	const { fs } = ctx.ports;
	const forms = formsFile(ctx);
	const formsAt = fs.mtimeMs(forms);
	const formsDue = formsAt === null ? now : formsAt + FORM_CATALOG_TTL_MS;
	const runtime = mtimes(fs, runtimeDir(ctx));
	const bills = runtime.files.filter((f) => f.endsWith(".json")).length;
	const oldestDue = runtime.oldest === null ? null : runtime.oldest + RUNTIME_FIELDS_TTL_MS;
	const runtimeExpired = oldestDue !== null && oldestDue <= now;
	return [
		{
			id: "mention-forms",
			name: "表单目录",
			what: "全库单据、表单、布局的编号与名称，供输入框 @ 引用检索单据",
			where: ["work/impact/forms.json"],
			...sized(fs, [forms]),
			updatedAt: formsAt,
			state: formsAt === null ? "missing" : formsDue <= now ? "stale" : "fresh",
			stateText:
				formsAt === null
					? "尚未生成"
					: formsDue <= now
						? `已超过 ${spanText(FORM_CATALOG_TTL_MS)} 有效期`
						: "在有效期内",
			auto: `有效期 ${spanText(FORM_CATALOG_TTL_MS)}；到期后下一次输入 @ 时在后台重建，约 5 秒，需常驻 JVM 运行中`,
			nextAt: formsDue,
			nextText: "到期后的下一次 @ 输入",
			actions: [{ id: "rebuild-forms", label: "重建", jvm: true }],
		},
		{
			id: "mention-runtime",
			name: "单据运行态字段",
			what: "@ 引用进入单据时读取的完整字段（含模板继承字段），每张单据一个文件",
			where: ["work/impact/runtime-fields/"],
			files: runtime.files.length,
			bytes: sized(fs, [], [runtimeDir(ctx)]).bytes,
			updatedAt: runtime.newest,
			state: bills === 0 ? "missing" : runtimeExpired ? "stale" : "fresh",
			stateText:
				bills === 0 ? "尚未读取任何单据" : `已缓存 ${bills} 张单据${runtimeExpired ? "，部分已过有效期" : ""}`,
			auto: `每张单据有效期 ${spanText(RUNTIME_FIELDS_TTL_MS)}；到期后再次进入该单据时重新读取，需常驻 JVM 运行中`,
			nextAt: oldestDue,
			nextText: bills === 0 ? "首次进入单据时" : "最早缓存的单据到期后，再次进入时",
			actions: [{ id: "clear", label: "清空", confirm: "清空后，各单据将在下次进入时重新读取。确认清空？" }],
		},
	];
}

/** 用户目录 `cache/` 下带 `runtime-key.json` 的目录：每个运行时版本一个。 */
function runtimeDirs(fs: FsPort, cacheRoot: string): string[] {
	if (!fs.exists(cacheRoot)) return [];
	return fs
		.readDir(cacheRoot)
		.filter((entry) => entry.isDirectory && fs.exists(join(cacheRoot, entry.name, "runtime-key.json")))
		.map((entry) => entry.name);
}

function diskItems(input: CacheInventoryInput): CacheItem[] {
	const { ctx, now } = input;
	const { fs } = ctx.ports;
	const cosmic = ctx.layout.cosmicDir;
	const sweepAt = nextSweep(fs, ctx.layout.workDir, now);
	const sessions = join(cosmic, SESSIONS_DIR);
	const sessionDirs = fs.exists(sessions) ? fs.readDir(sessions).filter((e) => e.isDirectory).length : 0;
	const drafts = [join(cosmic, SCRATCH_DIR), join(cosmic, AD_HOC_PROBES_DIR)];
	const cacheRoot = join(ctx.layout.agentCache, "..");
	const others = runtimeDirs(fs, cacheRoot)
		.filter((name) => name !== ctx.runtimeKeyId)
		.map((name) => join(cacheRoot, name));
	const reclaimAt = stampAt(fs, join(cacheRoot, RECLAIM_STAMP));
	return [
		{
			id: "sessions",
			name: "会话过程文件",
			what: "各会话的截断输出全文、生产查询结果、验证记录及导出文件，每个会话一个目录",
			where: [`${SESSIONS_DIR}/`],
			...sized(fs, [], [sessions]),
			updatedAt: mtimes(fs, sessions).newest,
			state: "info",
			stateText: `共 ${sessionDirs} 个会话`,
			auto: `会话连续 ${spanText(SESSION_IDLE_MS)} 无活动后整体删除；${SWEEP_RULE}`,
			nextAt: sweepAt,
			nextText: "下一次例行清理",
			actions: [SWEEP_ACTION],
		},
		{
			id: "drafts",
			name: "草稿与临时探针",
			what: "模型编写的临时脚本和临时探针",
			where: [`${SCRATCH_DIR}/`, `${AD_HOC_PROBES_DIR}/`],
			...sized(fs, [], drafts),
			updatedAt: Math.max(...drafts.map((d) => mtimes(fs, d).newest ?? 0)) || null,
			state: "info",
			stateText: "",
			auto: `文件 ${spanText(DRAFT_MAX_AGE_MS)} 未修改即删除；${SWEEP_RULE}`,
			nextAt: sweepAt,
			nextText: "下一次例行清理",
			actions: [SWEEP_ACTION],
		},
		{
			id: "runtime-old",
			name: "旧运行时版本目录",
			what: "更换 cosmic 版本、JDK 或苍穹运行时后遗留的探针编译环境，再次使用时会自动重建",
			where: others,
			...sized(fs, [], others),
			updatedAt: null,
			state: "info",
			stateText: `共 ${others.length} 个`,
			auto: `每 ${spanText(RECLAIM_INTERVAL_MS)} 清理一次（打开工程时执行），保留最近使用的 ${KEEP} 个，仍有 JVM 运行的不删除`,
			nextAt: reclaimAt === null ? now : Math.max(now, reclaimAt + RECLAIM_INTERVAL_MS),
			nextText: "到期后的下一次打开工程",
			actions: [{ id: "reclaim-runtimes", label: `立即清理（保留 ${KEEP} 个）` }],
		},
	];
}

export function cacheInventory(input: CacheInventoryInput): CacheGroup[] {
	return [
		{ id: "index", name: "索引", items: [...impactItems(input), ...mentionItems(input)] },
		{ id: "disk", name: "磁盘缓存", items: diskItems(input) },
	];
}

/** 「清空」允许清除的目录；其余 id 一律不认，避免界面传入任意路径。 */
export function clearableDir(ctx: KernelContext, itemId: string): string | null {
	return itemId === "mention-runtime" ? runtimeDir(ctx) : null;
}
