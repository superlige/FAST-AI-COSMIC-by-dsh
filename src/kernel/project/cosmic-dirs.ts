/**
 * `<工程>/.cosmic-ai/` 里每样东西归谁、留多久，只在这一张表里定。
 *
 * 清理、`cosmic_doctor` 的清点、文件工具能往哪写、`.gitignore` 都照这张表，不各记一份。
 *
 * 分三种寿命：
 *   - **跟会话走**（`sessions/<会话>/`）：截断输出的全文、查生产的结果和元数据比对、验证记录、
 *     导出和候选、完成情况底账。只有当次会话会回头看它们，换个会话模型不会再去翻，
 *     所以会话停了一段时间就整个目录删掉。留几天而不是关掉就删，是因为同一个会话隔天、
 *     过个周末还会接着用（完成情况的比对起点就在底账里）。
 *   - **用完即弃的草稿**（`scratch/`、`probes/`）：模型自己写的临时脚本、临时探针，几天没改就删。
 *   - **一直留**：写元数据前的改前原文（改坏了唯一的退路）、诊断报告、查生产流水账、工程配置；
 *     缓存（代码关系表、按运行时记的账）重建要连共享环境，也留，只把很久没更新的按运行时记的账清掉。
 *
 * 表外的东西不删（可能是人放的），清点时逐项报出来。
 */

import { join } from "node:path";
import type { KernelLayout } from "../layout.ts";
import type { FsPort } from "../ports.ts";

const DAY = 24 * 60 * 60 * 1000;
/** 会话多久没动静就整个删掉。 */
export const SESSION_IDLE_MS = 3 * DAY;
/** 草稿（临时脚本、临时探针）多久没改就删。 */
export const DRAFT_MAX_AGE_MS = 3 * DAY;
/** 按运行时记的账多久没更新就删。 */
export const LEDGER_MAX_AGE_MS = 30 * DAY;
/** 两次清理之间至少隔多久：每次工具调用都会打开工程，清理不能每次都扫。 */
export const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/** 会话还活着的记号多久刷新一次。 */
const ALIVE_REFRESH_MS = 10 * 60 * 1000;

export const SESSIONS_DIR = "sessions";
export const SCRATCH_DIR = "scratch";
export const AD_HOC_PROBES_DIR = "probes";
export const BACKUPS_DIR = join("evidence", "backups");
/** 没有会话编号的调用（命令行脚本）共用的会话目录名。 */
export const NO_SESSION = "_local";
const ALIVE_FILE = ".alive";
export const SWEEP_FILE = "sweep.json";

/** 会话编号进目录名：只留字母数字和 `-_`。 */
export function sessionDirName(id: string | undefined): string {
	const safe = (id ?? "").replace(/[^A-Za-z0-9_-]/g, "_");
	return safe === "" ? NO_SESSION : safe;
}

export function sessionDirOf(root: string, id: string | undefined): string {
	return join(root, ".cosmic-ai", SESSIONS_DIR, sessionDirName(id));
}

/** 表里的一项。`path` 相对 `.cosmic-ai/`，目录以 `/` 结尾。 */
export interface CosmicEntry {
	path: string;
	what: string;
	keep: string;
}

export const COSMIC_ENTRIES: readonly CosmicEntry[] = [
	{ path: "config.json", what: "工程配置（账套、用户、启动类）", keep: "一直留" },
	{ path: "project.yaml", what: "工程概况", keep: "一直留" },
	{ path: ".gitignore", what: "不让 cosmic 的文件进 Git", keep: "一直留" },
	{
		path: `${SESSIONS_DIR}/`,
		what: "每个会话一个目录：截断输出的全文、查生产的结果和元数据比对、验证记录、导出和候选、完成情况底账",
		keep: "会话 3 天没动静，整个目录删掉",
	},
	{ path: `${SCRATCH_DIR}/`, what: "临时脚本、草稿", keep: "文件 3 天没改就删" },
	{ path: `${AD_HOC_PROBES_DIR}/`, what: "临时探针", keep: "文件 3 天没改就删" },
	{ path: "work/impact.json", what: "代码关系表", keep: "一直留（可重建）" },
	{ path: "work/impact/", what: "代码关系表的中间文件", keep: "一直留（可重建）" },
	{ path: "work/capsules/", what: "知识卡片发过哪些（按运行时）", keep: "30 天没更新就删" },
	{ path: "work/noise/", what: "反复出现的平台异常（按运行时）", keep: "30 天没更新就删" },
	{ path: "work/repeat/", what: "同一个问题问过几遍（按运行时）", keep: "30 天没更新就删" },
	{ path: "work/must-input/", what: "必录字段（按运行时）", keep: "30 天没更新就删" },
	{ path: "work/write.lock", what: "工程写锁", keep: "不动" },
	{ path: `work/${SWEEP_FILE}`, what: "上一次清理的结果", keep: "每次清理重写" },
	{ path: "evidence/backups/", what: "写元数据前的改前原文、导出的备份", keep: "一直留" },
	{ path: "evidence/diagnosis/", what: "生产诊断报告", keep: "一直留" },
	{ path: "evidence/prod-audit.jsonl", what: "查生产流水账", keep: "一直留" },
];

/** 按运行时记的账：过期就删。 */
const LEDGER_DIRS = ["work/capsules", "work/noise", "work/repeat", "work/must-input"];

/**
 * 过程文件的老位置。新版写进会话目录；这些目录里的文件按草稿的期限清掉，清空了目录也删。
 * 迁移期间 pi 版还往这里写，所以只删几天没改的，不整个删。
 */
export const LEGACY_PROCESS_DIRS: readonly CosmicEntry[] = [
	{ path: "work/out/", what: "截断输出的全文（老位置）", keep: "文件 3 天没改就删" },
	{ path: "work/prod/", what: "查生产的结果（老位置）", keep: "文件 3 天没改就删" },
	{ path: "evidence/assertions/", what: "验证记录（老位置）", keep: "文件 3 天没改就删" },
	{ path: "evidence/verify/", what: "交付回执（pi 版）", keep: "文件 3 天没改就删" },
];
/** 完成情况底账的老位置：搬进各自的会话目录。 */
const LEGACY_JOURNALS = join("evidence", "sessions");

const ENTRY_PATHS = new Set([...COSMIC_ENTRIES, ...LEGACY_PROCESS_DIRS].map((entry) => entry.path));

/**
 * 文件工具能写的地方：草稿、临时探针、会话目录（打印模板候选这类导出的东西）。
 * 其余都由工具自己写，模型用文件工具写进去就会和表对不上。
 */
export const MODEL_WRITABLE = [`${SCRATCH_DIR}/`, `${AD_HOC_PROBES_DIR}/`, `${SESSIONS_DIR}/`] as const;

/** `.cosmic-ai/` 里的相对路径（正斜杠），不在里面返回 null。 */
export function cosmicRelative(file: string): string | null {
	const norm = file.replace(/\\/g, "/");
	const index = norm.toLowerCase().lastIndexOf("/.cosmic-ai/");
	return index < 0 ? null : norm.slice(index + "/.cosmic-ai/".length);
}

/** 文件工具往 `.cosmic-ai/` 里写这个路径行不行（不在 `.cosmic-ai/` 里的一律不管）。 */
export function modelMayWrite(file: string): boolean {
	const rel = cosmicRelative(file);
	if (rel === null) return true;
	const lower = rel.toLowerCase();
	return MODEL_WRITABLE.some((prefix) => lower.startsWith(prefix));
}

// ---------------------------------------------------------------- 清理

export interface SweepResult {
	/** 离上次清理不到一小时，这次没扫。 */
	skipped: boolean;
	/** 删掉的会话目录。 */
	sessions: string[];
	/** 删掉的草稿文件数（scratch/、probes/）。 */
	drafts: number;
	/** 老位置上删掉的过程文件数。 */
	legacy: number;
	/** 删掉的按运行时记的账。 */
	ledgers: number;
	/** 搬进会话目录的完成情况底账。 */
	journalsMoved: number;
}

const EMPTY: SweepResult = { skipped: true, sessions: [], drafts: 0, legacy: 0, ledgers: 0, journalsMoved: 0 };

/** 目录下所有文件（递归）。 */
function filesUnder(fs: FsPort, dir: string): string[] {
	const out: string[] = [];
	const visit = (path: string): void => {
		for (const entry of fs.readDir(path)) {
			const child = join(path, entry.name);
			if (entry.isDirectory) visit(child);
			else out.push(child);
		}
	};
	if (fs.exists(dir)) visit(dir);
	return out;
}

/** 删掉目录下空了的子目录；`self` 为真时连它自己空了也删。 */
function pruneEmpty(fs: FsPort, dir: string, self: boolean): void {
	if (!fs.exists(dir)) return;
	for (const entry of fs.readDir(dir)) if (entry.isDirectory) pruneEmpty(fs, join(dir, entry.name), true);
	if (self && fs.readDir(dir).length === 0) fs.remove(dir);
}

/** 删掉目录下 `maxAge` 以前改的文件，返回删了几个。 */
function removeOlder(fs: FsPort, dir: string, now: number, maxAge: number, removeEmptySelf: boolean): number {
	let removed = 0;
	for (const file of filesUnder(fs, dir)) {
		const mtime = fs.mtimeMs(file);
		if (mtime !== null && now - mtime > maxAge) {
			fs.remove(file);
			removed++;
		}
	}
	pruneEmpty(fs, dir, removeEmptySelf);
	return removed;
}

/** 文件里记的时刻（ISO 或 `{"at": ISO}`）；读不出来退回修改时间。 */
function stampedAt(fs: FsPort, file: string): number | null {
	const raw = fs.read(file).trim();
	if (raw !== "") {
		const at = raw.startsWith("{") ? (JSON.parse(raw) as { at?: unknown }).at : raw;
		const ms = typeof at === "string" ? Date.parse(at) : Number.NaN;
		if (!Number.isNaN(ms)) return ms;
	}
	return fs.mtimeMs(file);
}

function safeStampedAt(fs: FsPort, file: string): number | null {
	try {
		return stampedAt(fs, file);
	} catch {
		return fs.mtimeMs(file);
	}
}

/** 会话最后一次有动静的时刻：记号文件、底账、目录本身，取最新的。 */
function sessionLastSeen(fs: FsPort, dir: string): number {
	const times = [
		safeStampedAt(fs, join(dir, ALIVE_FILE)),
		fs.mtimeMs(join(dir, "journal.json")),
		fs.mtimeMs(dir),
	].filter((t): t is number => t !== null);
	return times.length === 0 ? 0 : Math.max(...times);
}

/** 打开工程时给本会话目录记一下「还活着」；十分钟内记过就不再写。 */
export function touchSession(layout: KernelLayout, fs: FsPort, now: number): void {
	const file = join(layout.sessionDir, ALIVE_FILE);
	const last = safeStampedAt(fs, file);
	if (last !== null && now - last >= 0 && now - last < ALIVE_REFRESH_MS) return;
	fs.mkdirp(layout.sessionDir);
	fs.write(file, `${new Date(now).toISOString()}\n`);
}

/**
 * 照表清一遍。每次打开工程都会调，一小时内清过就跳过。
 * 本会话的目录不删；表外的东西不删。
 */
export function sweepCosmicDir(
	layout: KernelLayout,
	fs: FsPort,
	now: number,
	options: { force?: boolean } = {},
): SweepResult {
	const cosmic = layout.cosmicDir;
	const stampFile = join(layout.workDir, SWEEP_FILE);
	if (options.force !== true) {
		const last = safeStampedAt(fs, stampFile);
		if (last !== null && now - last >= 0 && now - last < SWEEP_INTERVAL_MS) return EMPTY;
	}
	const result: SweepResult = { ...EMPTY, skipped: false, sessions: [] };

	// 完成情况底账的老位置 → 各自的会话目录（搬，不删：会话可能还会接着用）
	const journals = join(cosmic, LEGACY_JOURNALS);
	if (fs.exists(journals)) {
		for (const entry of fs.readDir(journals)) {
			if (entry.isDirectory || !entry.name.endsWith(".json")) continue;
			const id = entry.name.slice(0, -".json".length);
			const target = join(cosmic, SESSIONS_DIR, sessionDirName(id), "journal.json");
			if (fs.exists(target)) continue;
			fs.mkdirp(join(cosmic, SESSIONS_DIR, sessionDirName(id)));
			if (fs.tryRename(join(journals, entry.name), target)) result.journalsMoved++;
		}
		pruneEmpty(fs, journals, true);
	}

	// 会话目录：不是本会话、3 天没动静，整个删
	const sessions = join(cosmic, SESSIONS_DIR);
	if (fs.exists(sessions)) {
		const mine = sessionDirName(layout.sessionId);
		for (const entry of fs.readDir(sessions)) {
			if (!entry.isDirectory || entry.name === mine) continue;
			const dir = join(sessions, entry.name);
			if (now - sessionLastSeen(fs, dir) > SESSION_IDLE_MS) {
				fs.remove(dir);
				result.sessions.push(entry.name);
			}
		}
	}

	for (const dir of [SCRATCH_DIR, AD_HOC_PROBES_DIR])
		result.drafts += removeOlder(fs, join(cosmic, dir), now, DRAFT_MAX_AGE_MS, false);
	for (const entry of LEGACY_PROCESS_DIRS)
		result.legacy += removeOlder(fs, join(cosmic, entry.path), now, DRAFT_MAX_AGE_MS, true);
	for (const dir of LEDGER_DIRS) result.ledgers += removeOlder(fs, join(cosmic, dir), now, LEDGER_MAX_AGE_MS, true);

	fs.mkdirp(layout.workDir);
	fs.write(stampFile, `${JSON.stringify({ at: new Date(now).toISOString(), ...result }, null, "\t")}\n`);
	return result;
}

/** 清理结果的一行话；什么都没删时为 null。 */
export function sweepNote(result: SweepResult): string | null {
	const parts: string[] = [];
	if (result.sessions.length > 0) parts.push(`${String(result.sessions.length)} 个停了 3 天以上的会话目录`);
	if (result.drafts > 0) parts.push(`${String(result.drafts)} 个 3 天没改的草稿`);
	if (result.legacy > 0) parts.push(`老位置上 ${String(result.legacy)} 个过程文件`);
	if (result.ledgers > 0) parts.push(`${String(result.ledgers)} 份 30 天没更新的运行时记账`);
	return parts.length === 0 ? null : `清理 .cosmic-ai/：删掉了${parts.join("、")}`;
}

// ---------------------------------------------------------------- 清点

export interface InventoryRow {
	path: string;
	what: string;
	keep: string;
	files: number;
	bytes: number | null;
}

export interface Inventory {
	rows: InventoryRow[];
	/** 表外的东西：顶层、work/、evidence/ 下认不出来的，逐项列。 */
	unknown: InventoryRow[];
}

/** 一个文件或目录（递归）多少文件、多少字节；量不了大小时字节为 null。 */
export function measure(fs: FsPort, path: string, isDir: boolean): { files: number; bytes: number | null } {
	if (!fs.exists(path)) return { files: 0, bytes: 0 };
	const files = isDir ? filesUnder(fs, path) : [path];
	if (fs.sizeBytes === undefined) return { files: files.length, bytes: null };
	let bytes = 0;
	for (const file of files) bytes += fs.sizeBytes(file) ?? 0;
	return { files: files.length, bytes };
}

/** 每一项多少文件、多大，外加表外的东西。`cosmic_doctor` 用，不用打开工程。 */
export function inventoryCosmicDir(cosmic: string, fs: FsPort): Inventory {
	const rows = [...COSMIC_ENTRIES, ...LEGACY_PROCESS_DIRS].map((entry) => ({
		...entry,
		...measure(fs, join(cosmic, entry.path), entry.path.endsWith("/")),
	}));
	const unknown: InventoryRow[] = [];
	const scan = (prefix: string): void => {
		const dir = join(cosmic, prefix);
		if (!fs.exists(dir)) return;
		for (const entry of fs.readDir(dir)) {
			const rel = `${prefix === "" ? "" : `${prefix}/`}${entry.name}${entry.isDirectory ? "/" : ""}`;
			if (ENTRY_PATHS.has(rel)) continue;
			if (prefix === "" && (rel === "work/" || rel === "evidence/")) continue;
			if (rel === "evidence/sessions/") continue;
			unknown.push({
				path: rel,
				what: "表外",
				keep: "不自动删",
				...measure(fs, join(dir, entry.name), entry.isDirectory),
			});
		}
	};
	scan("");
	scan("work");
	scan("evidence");
	return { rows, unknown };
}

function sizeText(bytes: number | null): string {
	if (bytes === null) return "";
	if (bytes < 1024) return ` ${String(bytes)} B`;
	if (bytes < 1024 * 1024) return ` ${(bytes / 1024).toFixed(0)} KB`;
	return ` ${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 清点结果的几行话：表里每一项逐项报，0 也报；表外的逐项列（不自动删，人来定）。
 * 外加上一次清理是什么时候、删了什么。
 */
export function inventoryLines(cosmic: string, fs: FsPort): string[] {
	const { rows, unknown } = inventoryCosmicDir(cosmic, fs);
	const line = (row: InventoryRow) =>
		`${row.path}  ${String(row.files)} 个文件${sizeText(row.bytes)}  ${row.what}；${row.keep}`;
	const lines = rows.map(line);
	lines.push(
		unknown.length === 0
			? "表外的东西：0 项"
			: `表外的东西：${String(unknown.length)} 项（不是 cosmic 按表写的，不自动删，要不要留请用户定）`,
		...unknown.map((row) => `  ${row.path}  ${String(row.files)} 个文件${sizeText(row.bytes)}`),
	);
	const sweep = fs.read(join(cosmic, "work", SWEEP_FILE));
	if (sweep !== "") {
		try {
			const last = JSON.parse(sweep) as Partial<SweepResult> & { at?: string };
			lines.push(
				`上一次清理 ${last.at ?? "?"}：会话目录 ${String(last.sessions?.length ?? 0)} 个、草稿 ${String(last.drafts ?? 0)} 个、` +
					`老位置过程文件 ${String(last.legacy ?? 0)} 个、运行时记账 ${String(last.ledgers ?? 0)} 份`,
			);
		} catch {
			lines.push("上一次清理的记录读不出来（work/sweep.json 不是 JSON）");
		}
	} else lines.push("还没清理过");
	return lines;
}
