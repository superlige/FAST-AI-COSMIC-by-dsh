/**
 * Reclaims RuntimeKey cache directories nobody has opened recently (S19).
 *
 * Every RuntimeKey gets its own directory (D10), and the key changes with every
 * agent build, JDK, Cosmic runtime and classpath change. Nothing ever removed the
 * old ones: the real machine had 15 after one week of development builds.
 *
 * What makes deleting one safe is what the directory is: compiled probe classes
 * and released sources, all rebuilt on the next open of that key. What makes it
 * unsafe is a JVM still running out of it. So the rules are:
 *
 *   - only directories carrying a valid `runtime-key.json` are candidates, which
 *     keeps `knowledge/`, `reference/` and anything a person put there out of reach;
 *   - never the key being opened;
 *   - never a directory whose resident probe JVM or debug node is still alive --
 *     checked by command line, not by pid alone: a pid recorded days ago may by
 *     now belong to a browser, and that must not pin the directory forever (S53);
 *   - keep the `KEEP` most recently opened ones -- `writtenAt` is rewritten on
 *     every open, and every tool call opens, so an active session in another
 *     window is always among the newest.
 *
 * Opening happens on every tool call, so the sweep itself is throttled by a stamp
 * in the cache root; a skipped sweep costs one small read.
 */

import { join } from "node:path";
import type { FsPort, JavaProcess, ProcessPort } from "../kernel/ports.ts";
import { commandLineMatches, type JvmKind } from "../kernel/probe/local-jvms.ts";

/** Directories kept besides the current one. Enough for several projects in rotation. */
export const KEEP = 5;
/** Minimum time between sweeps. */
export const RECLAIM_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const RECLAIM_STAMP = "reclaim-stamp.json";

export interface CacheReclaim {
	/** Directory names removed. Empty when skipped or when nothing qualified. */
	removed: string[];
	/** True when the throttle stamp said a sweep ran recently. */
	skipped: boolean;
}

interface Candidate {
	name: string;
	writtenAt: number;
}

function jsonOf(fs: FsPort, file: string): Record<string, unknown> | null {
	const raw = fs.read(file);
	if (raw === "") return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/**
 * 这个目录记的 JVM 还活着吗。进程号在还不够，命令行得是那个版本的那种 JVM；
 * 进程清单查不了时，进程号在就当活着（宁可留目录，不删正在用的）。清单整趟只查一次。
 */
async function liveJvm(
	fs: FsPort,
	proc: Pick<ProcessPort, "isAlive" | "listJava">,
	dir: string,
	processes: () => Promise<JavaProcess[] | null>,
): Promise<boolean> {
	for (const [file, kind] of [
		["probe-server.pid", "probe"],
		["cosmic-debug.pid", "node"],
	] as const satisfies ReadonlyArray<readonly [string, JvmKind]>) {
		const record = jsonOf(fs, join(dir, file));
		const pid = record?.pid;
		if (typeof pid !== "number" || !proc.isAlive(pid)) continue;
		const list = await processes();
		if (list === null) return true;
		const found = list.find((candidate) => candidate.pid === pid);
		const keyId = typeof record?.keyId === "string" ? record.keyId : "";
		if (found !== undefined && commandLineMatches(kind, keyId, found.commandLine)) return true;
	}
	return false;
}

export async function reclaimRuntimeCaches(input: {
	cacheRoot: string;
	currentKeyId: string;
	fs: FsPort;
	proc: Pick<ProcessPort, "isAlive" | "listJava">;
	now: number;
	/** 不看六小时一次的间隔（界面上人点「按规则清理」）；留几个、跑着的不删照旧 */
	force?: boolean;
}): Promise<CacheReclaim> {
	const { cacheRoot, fs, proc, now } = input;
	const stamp = join(cacheRoot, RECLAIM_STAMP);
	const last = jsonOf(fs, stamp)?.at;
	if (input.force !== true && typeof last === "number" && now - last >= 0 && now - last < RECLAIM_INTERVAL_MS) {
		return { removed: [], skipped: true };
	}

	const candidates: Candidate[] = [];
	for (const entry of fs.readDir(cacheRoot)) {
		if (!entry.isDirectory || entry.name === input.currentKeyId) continue;
		const manifest = jsonOf(fs, join(cacheRoot, entry.name, "runtime-key.json"));
		if (manifest?.schema !== "cosmic.runtime-cache/1" || manifest.keyId !== entry.name) continue;
		const writtenAt = typeof manifest.writtenAt === "string" ? Date.parse(manifest.writtenAt) : Number.NaN;
		candidates.push({ name: entry.name, writtenAt: Number.isNaN(writtenAt) ? 0 : writtenAt });
	}
	candidates.sort((a, b) => b.writtenAt - a.writtenAt);

	const removed: string[] = [];
	let listed: Promise<JavaProcess[] | null> | undefined;
	const processes = (): Promise<JavaProcess[] | null> => {
		listed ??= proc.listJava();
		return listed;
	};
	for (const candidate of candidates.slice(KEEP)) {
		const dir = join(cacheRoot, candidate.name);
		if (await liveJvm(fs, proc, dir, processes)) continue;
		fs.remove(dir);
		removed.push(candidate.name);
	}
	fs.write(stamp, `${JSON.stringify({ at: now })}\n`);
	return { removed, skipped: false };
}
