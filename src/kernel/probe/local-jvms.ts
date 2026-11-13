/**
 * 本机 cosmic 起的苍穹 JVM：清单、身份核对、停止（S53）。
 *
 * 每个运行时版本（RuntimeKey）在缓存根下有自己的目录，常驻探针服务和调试节点各在里面留一份登记
 * （进程号、版本号、端口）。版本一换就换目录，所以「本机开着几个」没有任何一处记着；
 * 这里把所有版本目录的登记和本机的 java 进程清单对一遍，得出一份清单。
 *
 * 登记只记了进程号，而进程号会被系统分给别的程序（真机上一份登记里的 8684 后来是 msedge）。
 * 所以凡是要按登记停进程、或者把登记当「还活着」的地方，都先核对身份：
 *
 * - 常驻探针服务：问它的心跳，心跳报回的进程号和版本号都对得上才算它；
 * - 心跳没回应（启动中、卡住、旧版没有心跳）：看这个进程号的命令行，常驻探针服务带
 *   `CosmicProbeServer` 和 `-Dprobe.runtimeKey=<版本>`，调试节点带 `-Dcosmic.runtimeKey=<版本>`；
 * - 进程清单查不了：答「不知道」，停的一方不停。
 *
 * 不依赖 KernelContext：面板要在没打开工程时也能列、也能停。
 */

import { dirname, join } from "node:path";
import type { KernelContext } from "../context.ts";
import type { FsPort, JavaProcess, NetPort, ProcessPort } from "../ports.ts";
import { decodeResponse, SHUTDOWN_REQUEST } from "./protocol.ts";

/** 常驻探针服务的主类名，出现在它的命令行里。 */
export const PROBE_SERVER_MAIN = "CosmicProbeServer";
/** 常驻探针服务命令行里的版本号参数（宿主自己也读它）。 */
export const PROBE_KEY_PROP = "-Dprobe.runtimeKey=";
/** 调试节点命令行里的版本号参数：只为认得出它，苍穹不读。 */
export const NODE_KEY_PROP = "-Dcosmic.runtimeKey=";
/** 和 `CosmicProbeServer.IDLE_EXIT_MS` 同一个数（测试对着 Java 源码核对）：空闲这么久它自己退出。 */
export const PROBE_IDLE_EXIT_MS = 30 * 60_000;
/**
 * 新版本起来后停同一工程的旧版本：空闲超过这么久，并且这么久里没有会话打开过它那个版本，才停。
 * 打包版和源码版同时开着、两边都在用时，正在用的那个不会被停。
 */
export const RETIRE_IDLE_MS = 2 * 60_000;

const PROBE_RECORD = "probe-server.pid";
const NODE_RECORD = "cosmic-debug.pid";
const RUNTIME_KEY_FILE = "runtime-key.json";
const HEALTH_TIMEOUT_MS = 1_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const EXIT_WAIT_MS = 5_000;
const EXIT_POLL_MS = 250;
const PORT_PROBE_MS = 1_000;

export type JvmKind = "probe" | "node";

/** 心跳报的状态；`unresponsive` 是进程在、心跳没答。调试节点只分得出 ready / starting。 */
export type JvmState = "ready" | "executing" | "starting" | "warming" | "syncing" | "unhealthy" | "unresponsive";

export interface LocalJvm {
	kind: JvmKind;
	pid: number;
	/** 运行时版本号；登记丢了、命令行里也没有时是 null（「认不出来」）。 */
	keyId: string | null;
	/** 登记所在的版本目录；没有登记是 null。 */
	cacheDir: string | null;
	/** 登记文件；停掉后删它。没有登记是 null。 */
	recordFile: string | null;
	projectRoot: string | null;
	port: number | null;
	account: string | null;
	user: string | null;
	hotSwap: string | null;
	startedAtMs: number | null;
	memoryBytes: number | null;
	state: JvmState;
	/** 最近一次收到请求的时刻（心跳报的）。 */
	lastActiveMs: number | null;
	/** 它那个版本最近一次被会话打开的时刻（版本目录 runtime-key.json 的 writtenAt，每次打开都重写）。 */
	lastOpenedMs: number | null;
	logFile: string | null;
}

export interface JvmScan {
	jvms: LocalJvm[];
	/** 判成失效的登记：进程不在了，或者进程号已经是别的程序的。`clean` 时已经删掉。 */
	staleRecords: string[];
	/** 进程清单查到了没有。没查（省事模式）或查不了时，只列心跳答得上的。 */
	processesListed: boolean;
}

export interface JvmDeps {
	fs: FsPort;
	proc: Pick<ProcessPort, "isAlive" | "listJava" | "kill">;
	net: Pick<NetPort, "request" | "canConnect">;
	sleep?: (ms: number) => Promise<void>;
}

export interface ScanOptions {
	cacheRoots: readonly string[];
	/** 查本机进程清单：拿得到内存、认得出没登记的、核对得了心跳不答的。约 1 秒，面板用；底栏不用。 */
	listProcesses: boolean;
	/** 顺手删掉失效登记。 */
	clean: boolean;
}

/** 一个打开的工程手里的那几样端口。 */
export function jvmDeps(ctx: KernelContext): JvmDeps {
	return { fs: ctx.ports.fs, proc: ctx.ports.proc, net: ctx.ports.net, sleep: (ms) => ctx.ports.clock.sleep(ms) };
}

/** 这个工程所在的缓存根：版本目录的上一层，所有版本的登记都在它下面。 */
export function localCacheRoots(ctx: KernelContext): string[] {
	return [dirname(dirname(ctx.layout.serverPid))];
}

// ------------------------------------------------------------------ identity

function tokens(commandLine: string): string[] {
	return commandLine.split(/\s+/).map((part) => part.replace(/^"+|"+$/g, ""));
}

function samePath(a: string, b: string): boolean {
	return (
		a.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() ===
		b.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
	);
}

/** 命令行说明它就是这个版本的那种 JVM。调试节点在带版本号之前起的，认工程下的 pathing jar。 */
export function commandLineMatches(
	kind: JvmKind,
	keyId: string,
	commandLine: string,
	projectRoot: string | null = null,
): boolean {
	const parts = tokens(commandLine);
	if (kind === "probe") return parts.includes(PROBE_SERVER_MAIN) && parts.includes(`${PROBE_KEY_PROP}${keyId}`);
	if (parts.includes(`${NODE_KEY_PROP}${keyId}`)) return true;
	if (projectRoot === null) return false;
	const jar = parts[parts.indexOf("-jar") + 1];
	return (
		parts.includes("-jar") &&
		jar !== undefined &&
		samePath(jar, join(projectRoot, "build", "cosmic-pathing.jar")) &&
		!parts.some((part) => part.startsWith(NODE_KEY_PROP))
	);
}

/** 命令行里写的版本号；不是 cosmic 起的 JVM 给 undefined。 */
export function keyInCommandLine(commandLine: string): { kind: JvmKind; keyId: string | null } | undefined {
	const parts = tokens(commandLine);
	const probeKey = parts.find((part) => part.startsWith(PROBE_KEY_PROP));
	if (parts.includes(PROBE_SERVER_MAIN))
		return { kind: "probe", keyId: probeKey === undefined ? null : probeKey.slice(PROBE_KEY_PROP.length) };
	const nodeKey = parts.find((part) => part.startsWith(NODE_KEY_PROP));
	if (nodeKey !== undefined) return { kind: "node", keyId: nodeKey.slice(NODE_KEY_PROP.length) };
	return undefined;
}

interface Health {
	pid: string;
	key: string;
	state: string;
	account: string | null;
	user: string | null;
	lastActiveMs: number | null;
}

function fields(text: string): Map<string, string> {
	return new Map(
		text
			.trim()
			.split(/\r?\n/)
			.filter((line) => line.includes("="))
			.map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
	);
}

/**
 * 问常驻探针服务的心跳。心跳端口写在登记旁边的 `.health` 文件里（JVM 自己写）；
 * 文件里的进程号、版本号和登记对不上，就是上一个 JVM 留下的过期文件，不去问那个端口。
 */
async function healthOf(deps: JvmDeps, recordFile: string, pid: number, keyId: string): Promise<Health | null> {
	const file = fields(deps.fs.read(`${recordFile}.health`));
	const port = Number(file.get("port"));
	if (file.get("pid") !== String(pid) || file.get("key") !== keyId) return null;
	if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
	const reply = await deps.net.request(port, ["HEALTH"], HEALTH_TIMEOUT_MS);
	if (!reply.ok) return null;
	const decoded = decodeResponse(reply.text);
	if (!decoded.ok || decoded.value.status !== "OK") return null;
	const body = fields(decoded.value.body);
	const lastActive = Number(body.get("lastActive"));
	return {
		pid: body.get("pid") ?? "",
		key: body.get("key") ?? "",
		state: body.get("state") ?? "",
		account: body.get("account") ?? null,
		user: body.get("user") ?? null,
		lastActiveMs: Number.isFinite(lastActive) && lastActive > 0 ? lastActive : null,
	};
}

export type PidVerdict = "ours" | "gone" | "other" | "unknown";

export interface RecordedJvm {
	kind: JvmKind;
	pid: number;
	keyId: string;
	/** 常驻探针服务的登记文件（找心跳端口用）；调试节点不用。 */
	recordFile: string | null;
	projectRoot: string | null;
}

/**
 * 登记里的这个进程号，现在是不是还是那个 JVM。
 *
 * gone：进程不在了；other：进程号在，但已经是别的程序；unknown：心跳没答、进程清单也查不了。
 * 停进程只在 ours 时停；登记只在 gone / other 时删。
 */
export async function verifyRecordedPid(
	deps: JvmDeps,
	record: RecordedJvm,
	processes?: readonly JavaProcess[] | null,
): Promise<PidVerdict> {
	if (!deps.proc.isAlive(record.pid)) return "gone";
	if (record.kind === "probe" && record.recordFile !== null) {
		const health = await healthOf(deps, record.recordFile, record.pid, record.keyId);
		if (health !== null && health.pid === String(record.pid) && health.key === record.keyId) return "ours";
	}
	const list = processes === undefined ? await deps.proc.listJava() : processes;
	if (list === null) return "unknown";
	const found = list.find((process) => process.pid === record.pid);
	if (found === undefined) return "other";
	return commandLineMatches(record.kind, record.keyId, found.commandLine, record.projectRoot) ? "ours" : "other";
}

// ---------------------------------------------------------------------- scan

interface Recorded {
	kind: JvmKind;
	cacheDir: string;
	recordFile: string;
	pid: number;
	keyId: string;
	port: number | null;
	startedAtMs: number | null;
	account: string | null;
	user: string | null;
	hotSwap: string | null;
	projectRoot: string | null;
	lastOpenedMs: number | null;
	logFile: string;
}

function json(fs: FsPort, file: string): Record<string, unknown> | null {
	const raw = fs.read(file);
	if (raw === "") return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const time = (value: unknown): number | null => {
	const ms = typeof value === "string" ? Date.parse(value) : Number.NaN;
	return Number.isNaN(ms) ? null : ms;
};

function recordsIn(fs: FsPort, cacheRoots: readonly string[]): Recorded[] {
	const out: Recorded[] = [];
	for (const root of cacheRoots) {
		for (const entry of fs.readDir(root)) {
			if (!entry.isDirectory) continue;
			const dir = join(root, entry.name);
			const key = json(fs, join(dir, RUNTIME_KEY_FILE));
			const parts = key?.parts as { project?: { root?: unknown } } | undefined;
			const projectRoot = str(parts?.project?.root);
			const lastOpenedMs = time(key?.writtenAt);
			for (const [kind, name, log] of [
				["probe", PROBE_RECORD, "probe-server.log"],
				["node", NODE_RECORD, "cosmic-debug.log"],
			] as const) {
				const recordFile = join(dir, name);
				const record = json(fs, recordFile);
				if (record === null || typeof record.pid !== "number" || typeof record.keyId !== "string") continue;
				out.push({
					kind,
					cacheDir: dir,
					recordFile,
					pid: record.pid,
					keyId: record.keyId,
					port: typeof record.port === "number" ? record.port : null,
					startedAtMs: time(record.startedAt),
					account: str(record.account),
					user: str(record.user),
					hotSwap: kind === "probe" ? (str(record.hotSwap) ?? "instrument") : null,
					projectRoot,
					lastOpenedMs,
					logFile: join(dir, log),
				});
			}
		}
	}
	return out;
}

const HEALTH_STATES: readonly JvmState[] = ["ready", "executing", "starting", "warming", "syncing", "unhealthy"];

function fromRecord(record: Recorded, process: JavaProcess | undefined): LocalJvm {
	return {
		kind: record.kind,
		pid: record.pid,
		keyId: record.keyId,
		cacheDir: record.cacheDir,
		recordFile: record.recordFile,
		projectRoot: record.projectRoot,
		port: record.port,
		account: record.account,
		user: record.user,
		hotSwap: record.hotSwap,
		startedAtMs: record.startedAtMs ?? process?.startedAtMs ?? null,
		memoryBytes: process?.memoryBytes ?? null,
		state: "unresponsive",
		lastActiveMs: null,
		lastOpenedMs: record.lastOpenedMs,
		logFile: record.logFile,
	};
}

async function examine(
	deps: JvmDeps,
	record: Recorded,
	processes: readonly JavaProcess[] | null,
): Promise<LocalJvm | "stale" | "unknown"> {
	if (!deps.proc.isAlive(record.pid)) return "stale";
	const process = processes?.find((candidate) => candidate.pid === record.pid);
	if (record.kind === "probe") {
		const health = await healthOf(deps, record.recordFile, record.pid, record.keyId);
		if (health !== null && health.pid === String(record.pid) && health.key === record.keyId) {
			const state = HEALTH_STATES.find((candidate) => candidate === health.state) ?? "unresponsive";
			return {
				...fromRecord(record, process),
				state,
				lastActiveMs: health.lastActiveMs,
				account: health.account ?? record.account,
				user: health.user ?? record.user,
			};
		}
	}
	if (processes === null) return "unknown";
	if (process === undefined || !commandLineMatches(record.kind, record.keyId, process.commandLine, record.projectRoot))
		return "stale";
	if (record.kind === "node") {
		const listening = record.port !== null && (await deps.net.canConnect(record.port, PORT_PROBE_MS));
		return { ...fromRecord(record, process), state: listening ? "ready" : "starting" };
	}
	return fromRecord(record, process);
}

/** 本机 cosmic 起的 JVM 清单。 */
export async function scanLocalJvms(deps: JvmDeps, options: ScanOptions): Promise<JvmScan> {
	const records = recordsIn(deps.fs, options.cacheRoots);
	const processes = options.listProcesses ? await deps.proc.listJava() : null;
	const examined = await Promise.all(records.map((record) => examine(deps, record, processes)));
	const jvms: LocalJvm[] = [];
	const staleRecords: string[] = [];
	examined.forEach((outcome, index) => {
		const record = records[index] as Recorded;
		if (outcome === "stale") staleRecords.push(record.recordFile);
		else if (outcome !== "unknown") jvms.push(outcome);
	});
	if (processes !== null) {
		const known = new Set(jvms.map((jvm) => jvm.pid));
		for (const process of processes) {
			if (known.has(process.pid)) continue;
			const seen = keyInCommandLine(process.commandLine);
			if (seen === undefined) continue;
			jvms.push({
				kind: seen.kind,
				pid: process.pid,
				keyId: seen.keyId,
				cacheDir: null,
				recordFile: null,
				projectRoot: null,
				port: null,
				account: null,
				user: null,
				hotSwap: null,
				startedAtMs: process.startedAtMs,
				memoryBytes: process.memoryBytes,
				state: "unresponsive",
				lastActiveMs: null,
				lastOpenedMs: null,
				logFile: null,
			});
		}
	}
	if (options.clean) for (const file of staleRecords) removeRecord(deps.fs, file);
	return { jvms, staleRecords, processesListed: processes !== null };
}

function removeRecord(fs: FsPort, recordFile: string): void {
	fs.remove(recordFile);
	fs.remove(`${recordFile}.health`);
}

// ---------------------------------------------------------------------- stop

export interface StopResult {
	stopped: boolean;
	/** 怎么停的，或者为什么没停。 */
	how: "graceful" | "forced" | "gone" | "not-ours" | "unverified";
}

const defaultSleep = (ms: number): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, ms).unref?.();
	});

/** 等进程退出，最多 5 秒。退了返回 true。 */
export async function waitExit(deps: JvmDeps, pid: number): Promise<boolean> {
	const sleep = deps.sleep ?? defaultSleep;
	for (let waited = 0; waited < EXIT_WAIT_MS; waited += EXIT_POLL_MS) {
		if (!deps.proc.isAlive(pid)) return true;
		await sleep(EXIT_POLL_MS);
	}
	return !deps.proc.isAlive(pid);
}

/**
 * 停清单里的一个 JVM。常驻探针服务先请它自己退（释放苍穹连接），等不到再核对身份后强制结束整棵进程树；
 * 调试节点和没有登记的，核对命令行后强制结束。身份对不上的不动，只删登记。
 */
export async function stopLocalJvm(deps: JvmDeps, jvm: LocalJvm): Promise<StopResult> {
	if (!deps.proc.isAlive(jvm.pid)) {
		if (jvm.recordFile !== null) removeRecord(deps.fs, jvm.recordFile);
		return { stopped: true, how: "gone" };
	}
	if (jvm.kind === "probe" && jvm.port !== null && jvm.recordFile !== null && jvm.keyId !== null) {
		// 先确认端口上答话的是它，再请它退：同一个端口后来可能被别的版本占了。
		const verdict = await verifyRecordedPid(deps, {
			kind: "probe",
			pid: jvm.pid,
			keyId: jvm.keyId,
			recordFile: jvm.recordFile,
			projectRoot: jvm.projectRoot,
		});
		if (verdict === "ours") {
			const reply = await deps.net.request(jvm.port, SHUTDOWN_REQUEST, SHUTDOWN_TIMEOUT_MS);
			if (reply.ok && (await waitExit(deps, jvm.pid))) {
				removeRecord(deps.fs, jvm.recordFile);
				return { stopped: true, how: "graceful" };
			}
		}
	}
	return forceStop(deps, jvm);
}

async function forceStop(deps: JvmDeps, jvm: LocalJvm): Promise<StopResult> {
	const processes = await deps.proc.listJava();
	if (processes === null) return { stopped: false, how: "unverified" };
	const process = processes.find((candidate) => candidate.pid === jvm.pid);
	const ours =
		process !== undefined &&
		(jvm.keyId === null
			? keyInCommandLine(process.commandLine)?.kind === jvm.kind
			: commandLineMatches(jvm.kind, jvm.keyId, process.commandLine, jvm.projectRoot));
	if (!ours) {
		if (process === undefined && !deps.proc.isAlive(jvm.pid)) {
			if (jvm.recordFile !== null) removeRecord(deps.fs, jvm.recordFile);
			return { stopped: true, how: "gone" };
		}
		if (jvm.recordFile !== null) removeRecord(deps.fs, jvm.recordFile);
		return { stopped: false, how: "not-ours" };
	}
	await deps.proc.kill(jvm.pid, true);
	if (jvm.recordFile !== null) removeRecord(deps.fs, jvm.recordFile);
	return { stopped: true, how: "forced" };
}

// -------------------------------------------------------------------- retire

export interface RetireInput {
	cacheRoots: readonly string[];
	currentKeyId: string;
	projectRoot: string;
	nowMs: number;
}

/**
 * 新版本的常驻探针服务起来以后，停掉同一工程、别的版本、已经空闲的那些（用户 2026-10-09 选 A）。
 *
 * 只认心跳答得上的：心跳报回的进程号和版本号就是身份证明，不用再查进程清单。
 * 正在执行、启动、同步的不停；最近 RETIRE_IDLE_MS 里有请求、或者有会话打开过它那个版本的不停。
 */
export async function retireOldProbeServers(deps: JvmDeps, input: RetireInput): Promise<LocalJvm[]> {
	const scan = await scanLocalJvms(deps, { cacheRoots: input.cacheRoots, listProcesses: false, clean: false });
	const idle = (ms: number | null): boolean => ms === null || input.nowMs - ms >= RETIRE_IDLE_MS;
	const old = scan.jvms.filter(
		(jvm) =>
			jvm.kind === "probe" &&
			jvm.keyId !== null &&
			jvm.keyId !== input.currentKeyId &&
			jvm.projectRoot !== null &&
			samePath(jvm.projectRoot, input.projectRoot) &&
			(jvm.state === "ready" || jvm.state === "unhealthy") &&
			jvm.lastActiveMs !== null &&
			idle(jvm.lastActiveMs) &&
			idle(jvm.lastOpenedMs),
	);
	const retired: LocalJvm[] = [];
	for (const jvm of old) if ((await stopLocalJvm(deps, jvm)).stopped) retired.push(jvm);
	return retired;
}
