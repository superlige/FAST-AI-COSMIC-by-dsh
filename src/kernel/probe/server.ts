/**
 * The resident probe JVM: identity, lifecycle, request/reply (S3.3).
 *
 * This is the "isolated worker" of S3.3. Two properties come from D10 and are
 * enforced here, not documented elsewhere:
 *
 *   - The JVM belongs to a RuntimeKey, not to the agent process. Its pid file
 *     lives in the RuntimeKey cache directory and records the key id, so a
 *     process started for one project/runtime is never adopted by another.
 *   - Nothing is ever killed by port. Reclaiming requires a pid manifest whose
 *     key id matches; on this machine that pid may already belong to something
 *     else, and killing by port is how you take down an unrelated service.
 *
 * The frozen driver kept the pid in <root>/build/probe-server.pid with no
 * identity in it and reached the server on a fixed port from config. Both are
 * changed deliberately; see docs/S3-slice.md.
 */

import { join } from "node:path";
import {
	baseChildEnv,
	jvmProps,
	KEEP_EXCEPTION_STACKS,
	type KernelContext,
	poolProps,
	productJvmOptions,
	userJvmArgs,
} from "../context.ts";
import { err, KernelError, type KernelResult, ok } from "../errors.ts";
import { classpathOf, ensureBuilt, findToolsJar, runJavac } from "../toolchain.ts";
import { jvmDeps, localCacheRoots, retireOldProbeServers, verifyRecordedPid, waitExit } from "./local-jvms.ts";
import {
	decodeResponse,
	encodeProbeRequest,
	PING_REQUEST,
	type ProbeRequest,
	type ProbeResponse,
	SHUTDOWN_REQUEST,
	SYNC_REQUEST,
} from "./protocol.ts";
import { serviceChanged, serviceTransition } from "./service-events.ts";

/** Longer than the probe's ordinary 120s timeout, so the socket does not close before the server explains itself. */
export const REQUEST_TIMEOUT_MS = 150_000;
const REQUEST_TIMEOUT_MARGIN_MS = 30_000;
const PING_TIMEOUT_MS = 3_000;
/** 换类要扫一遍业务类目录、再换一批类，平常几百毫秒；给足余量 */
const SYNC_TIMEOUT_MS = 60_000;

/**
 * 等常驻 JVM 就绪的探活节奏。
 *
 * 原来是固定 45 × 2s。冷启动确实要 30-40 秒，但热重启（宿主类已编、JVM 刚被
 * 停掉又拉起）常常不到 1 秒就答 PING，却也要到第 2 秒才被发现——而启动时这段等待就是
 * footer 上唯一在动的东西。改成先密后疏：前 1 秒每 250ms 问一次，再逐步拉到 2s。
 * 冷启动那 40 秒里多出来的探活不足十次。这里故意没有固定截止时间：已经
 * 拉起且仍存活的 JVM 可能因为用户环境的冷启动超过 90 秒，此时把等待链截断会让
 * TUI 永远收不到它稍后的就绪结果。只有进程退出才证明这次启动失败。
 */
const START_POLL_RAMP_MS: readonly number[] = [250, 250, 250, 250, 500, 500, 500, 500, 1_000, 1_000];
const START_POLL_MAX_MS = 2_000;

/**
 * The port this RuntimeKey's resident JVM listens on.
 *
 * The frozen driver used a single configured port (8099 by default) for every
 * project. Verified on the real machine during S3: with a fixed port, a kernel
 * opened on project B connects to the JVM project A already started, and every
 * probe then runs against A's classes and A's Cosmic runtime while reporting B's
 * name. Nothing in the protocol would reveal it -- the reply is a well-formed
 * RESULT line either way. So the default port is derived from the RuntimeKey,
 * which is exactly what D10 requires of a socket.
 *
 * An explicitly configured port still wins: it is how a user reaches a JVM they
 * started themselves, and taking that away would remove an escape hatch without
 * making anything safer.
 */
export function residentPort(ctx: KernelContext): number {
	const origin = ctx.config.sources.probeServerPort?.source;
	// Either config.json layer counts as "the user named a port"; only the built-in
	// default gets replaced by the RuntimeKey-derived one.
	if (origin === "环境变量" || origin === "工程 .cosmic-ai/config.json" || origin === "全局 config.json") {
		return ctx.config.probeServerPort;
	}
	// FNV-1a over the key id, mapped into a fixed private range. Deterministic, so
	// the same runtime always finds its own JVM across agent restarts.
	let hash = 0x811c9dc5;
	for (let i = 0; i < ctx.runtimeKeyId.length; i++) {
		hash ^= ctx.runtimeKeyId.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return 41000 + (hash % 4000);
}

export interface ServerManifest {
	pid: number;
	/** RuntimeKey id this JVM was started for. A mismatch means "not mine". */
	keyId: string;
	port: number;
	startedAt: string;
	/**
	 * 这个 JVM 启动时用的账套与用户。
	 *
	 * 不在 RuntimeKey 里（那是「同一套类」的身份），但必须记下来：常驻宿主在启动时
	 * 建好 RequestContext 就再也不改了，之后改 config.json 的 account / user 一个字都
	 * 到不了它。而这两项恰恰是「错了不报错」的那两项——账套错了读到别人的元数据，
	 * 用户错了每一次写入的修改人都记在别人头上。旧的 manifest 里没有这两项，读成 null，
	 * 按「认不出身份」处理。
	 */
	account: string | null;
	user: string | null;
	/**
	 * 这个 JVM 是用哪种方式换类起的（S27 3.1）。开关一变就得重起：JRebel 只能在启动时挂上。
	 * 旧 manifest 没有这一项，按 "instrument" 算——那种 JVM 没挂换类入口，SYNC 会答「换不了」，
	 * 照样退回重起，不用为它再多重起一次。
	 */
	hotSwap: HotSwapMode;
}

export function readManifest(ctx: KernelContext): ServerManifest | null {
	const raw = ctx.ports.fs.read(ctx.layout.serverPid);
	if (raw === "") return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed === null || typeof parsed !== "object") return null;
		const manifest = parsed as Partial<ServerManifest>;
		if (typeof manifest.pid !== "number" || typeof manifest.keyId !== "string") return null;
		return {
			pid: manifest.pid,
			keyId: manifest.keyId,
			port: typeof manifest.port === "number" ? manifest.port : 0,
			startedAt: typeof manifest.startedAt === "string" ? manifest.startedAt : "",
			account: typeof manifest.account === "string" ? manifest.account : null,
			user: typeof manifest.user === "string" ? manifest.user : null,
			hotSwap: manifest.hotSwap === "jrebel" ? "jrebel" : "instrument",
		};
	} catch {
		// A corrupt manifest is treated as "no JVM of mine is running", never as
		// "the JVM is fine": the opposite choice reclaims a pid it cannot identify.
		return null;
	}
}

/**
 * True when this manifest describes a live JVM that belongs to this context.
 * Both halves are required -- a live pid with somebody else's key id is somebody
 * else's process.
 */
export function isOwnLiveServer(ctx: KernelContext, manifest: ServerManifest | null): boolean {
	if (manifest === null) return false;
	if (manifest.keyId !== ctx.runtimeKeyId) return false;
	if (staleServerIdentity(ctx, manifest) !== null) return false;
	return ctx.ports.proc.isAlive(manifest.pid);
}

/**
 * 这个常驻 JVM 是用别的账套 / 用户起的吗？是就返回一句人话，否则 null。
 *
 * 只在 keyId 对得上时才有意义：keyId 不同是「别人的 JVM」，那是另一回事。
 * 分开成一个函数，是因为两个调用方要的东西不同：`isOwnLiveServer` 只要一个布尔，
 * 而 probe 那边要把「为什么重启了常驻」原样报给人看——一次静默重启和一次
 * 静默复用旧身份，事后都同样解释不了当时到底连的是哪个账套。
 */
export function staleServerIdentity(ctx: KernelContext, manifest: ServerManifest | null): string | null {
	if (manifest === null || manifest.keyId !== ctx.runtimeKeyId) return null;
	const differences: string[] = [];
	if (manifest.account !== ctx.config.account)
		differences.push(`账套 ${manifest.account ?? "(未记录)"} → ${ctx.config.account ?? "(缺失)"}`);
	if (manifest.user !== ctx.config.user)
		differences.push(`用户 ${manifest.user ?? "(未记录)"} → ${ctx.config.user ?? "(缺失)"}`);
	const wanted = resolveHotSwap(ctx).mode;
	if (manifest.hotSwap !== wanted) differences.push(`换类方式 ${manifest.hotSwap} → ${wanted}`);
	return differences.length === 0 ? null : differences.join("；");
}

export async function ping(ctx: KernelContext): Promise<{ ok: boolean; why: string | null; body: string }> {
	const reply = await ctx.ports.net.request(residentPort(ctx), PING_REQUEST, PING_TIMEOUT_MS);
	if (!reply.ok) return { ok: false, why: reply.why, body: "" };
	const decoded = decodeResponse(reply.text);
	if (!decoded.ok) return { ok: false, why: decoded.why, body: "" };
	adoptAnswering(ctx, decoded.value.body);
	return { ok: true, why: null, body: decoded.value.body };
}

/**
 * 端口上答话的那个进程自己报的身份，和登记对一遍；对不上就照它报的改登记（S58）。
 *
 * 登记是「起它的那一方」写的，写完就没人再核对。两方几乎同时各起一个时，后写的盖掉先写的，
 * 而占到端口的是先起的那个：登记指着一个收不到请求的进程，它一退出，端口上还在跑的那个就成了
 * 「认不出归属」，之后每次运行都另起冷进程（真机一次会话 7 次、每次多等四十多秒）。
 *
 * 版本号是进程从自己的启动参数里读的（`-Dprobe.runtimeKey`），它报的版本号和本上下文一样，
 * 就是为这套类起的，和登记能证明的是同一件事；别的工程、别的版本起的进程报的是它自己的版本号，照旧不认。
 * 老宿主的答复里没有版本号，这里什么都不做。
 */
function adoptAnswering(ctx: KernelContext, body: string): void {
	const said = new Map<string, string>();
	for (const line of body.split(/\r?\n/)) {
		const eq = line.indexOf("=");
		if (eq > 0) said.set(line.slice(0, eq), line.slice(eq + 1));
	}
	const pid = Number(said.get("pid"));
	if (said.get("key") !== ctx.runtimeKeyId || !Number.isInteger(pid) || pid <= 0) return;
	const manifest = readManifest(ctx);
	if (manifest === null || manifest.keyId !== ctx.runtimeKeyId || manifest.pid !== pid) {
		const startedMs = Date.parse((said.get("started") ?? "").replace(" ", "T"));
		ctx.ports.fs.write(
			ctx.layout.serverPid,
			JSON.stringify({
				pid,
				keyId: ctx.runtimeKeyId,
				port: residentPort(ctx),
				startedAt: new Date(Number.isNaN(startedMs) ? ctx.ports.clock.now() : startedMs).toISOString(),
				account: said.get("account") ?? null,
				user: said.get("user") ?? null,
				hotSwap: said.get("hotswap") === "jrebel" ? "jrebel" : "instrument",
			} satisfies ServerManifest),
		);
	}
	// 心跳文件是进程自己一启动就写的，后起的那个照样会盖掉它（哪怕登记没被盖）：和答复不一样就补回来，
	// 底栏指示灯、面板和「停旧版本」都是靠它问到这个进程的。写法和宿主写的逐字相同。
	const health = Number(said.get("health"));
	if (Number.isInteger(health) && health > 0) {
		const file = `${ctx.layout.serverPid}.health`;
		const wanted = `pid=${String(pid)}\nkey=${ctx.runtimeKeyId}\nport=${String(health)}\n`;
		if (ctx.ports.fs.read(file) !== wanted) ctx.ports.fs.write(file, wanted);
	}
}

/** 端口上有进程答话，并且证明得了是本上下文的。先问端口：问的那一下顺手把登记对上。 */
export async function ownsAnswering(ctx: KernelContext): Promise<boolean> {
	if (!(await ping(ctx)).ok) return false;
	return isOwnLiveServer(ctx, readManifest(ctx));
}

/**
 * A resident JVM of this context is up, answers, and will take a request as it
 * is -- no restart pending, no identity mismatch. For work that rides along only
 * when the JVM is already there (S17 4.4) and must never be what starts one.
 */
export async function residentReady(ctx: KernelContext): Promise<boolean> {
	if (ctx.ports.fs.exists(ctx.layout.serverStale)) return false;
	return ownsAnswering(ctx);
}

/** Compiles the resident host (server + probe host + bridge) when it is out of date. */
export type ProbeServerProgress = "compiling-host" | "starting-runtime" | "warming-runtime";

export async function ensureHostClasses(
	ctx: KernelContext,
	onProgress?: (stage: ProbeServerProgress) => void,
): Promise<KernelResult<boolean>> {
	const built = await ensureBuilt(ctx);
	if (!built.ok) return built;

	const { fs } = ctx.ports;
	fs.mkdirp(ctx.layout.probeClasses);
	const classFile = `${ctx.layout.probeClasses}/CosmicProbeServer.class`;
	const classMs = fs.mtimeMs(classFile);
	const newest = Math.max(
		fs.mtimeMs(ctx.layout.serverSrc) ?? 0,
		fs.mtimeMs(ctx.layout.hostSrc) ?? 0,
		fs.mtimeMs(ctx.layout.bridgeSrc) ?? 0,
		fs.mtimeMs(ctx.layout.viewsSrc) ?? 0,
		fs.mtimeMs(ctx.layout.bootStubSrc) ?? 0,
		fs.mtimeMs(ctx.layout.channelHookSrc) ?? 0,
	);
	if (classMs !== null && classMs > newest) return ok(false);

	onProgress?.("compiling-host");
	const run = await runJavac(ctx, [
		"-encoding",
		"UTF-8",
		`@${ctx.layout.javacArgs}`,
		"-d",
		ctx.layout.probeClasses,
		ctx.layout.hostSrc,
		ctx.layout.bridgeSrc,
		ctx.layout.viewsSrc,
		ctx.layout.bootStubSrc,
		ctx.layout.serverSrc,
	]);
	if (run.status !== 0) {
		return err(
			new KernelError("COMPILE_FAILED", "常驻宿主编译失败", {
				detail: { stage: "probe-server-host", status: run.status },
				remedy: "看 javac 原文；宿主源码来自 agent 自有资源，多半是资源释放不完整。",
			}),
		);
	}
	await buildChannelHook(ctx);
	await buildHotSwapAgent(ctx);
	return ok(true);
}

/**
 * 让仿真的「发往浏览器的通道」是平台真类的那个宿主类（S54）。单独编、编不过不算失败：
 * 它要用苍穹库里的 ASM，别的版本没有也得让常驻 JVM 照样起；探针按类名找不到它，就退回动态代理，
 * 只是原厂插件强转成平台具体类那一步会抛错，run form 照实报「没跑完整」。
 */
async function buildChannelHook(ctx: KernelContext): Promise<void> {
	if (!ctx.ports.fs.exists(ctx.layout.channelHookSrc)) return;
	await runJavac(ctx, [
		"-encoding",
		"UTF-8",
		`@${ctx.layout.javacArgs}`,
		"-d",
		ctx.layout.probeClasses,
		ctx.layout.channelHookSrc,
	]);
}

/**
 * 换类入口的 jar（S27 3.1）：只有一份清单，指向宿主里的 `CosmicProbeServer$HotSwapAgent`。
 * 类本身不进 jar——它在 probe-classes 里，系统类加载器先从那儿找到它，跟宿主是同一个类。
 *
 * 建不出来不算失败：常驻 JVM 照样起，只是没有换类入口，类一变就退回重起，跟以前一样。
 */
async function buildHotSwapAgent(ctx: KernelContext): Promise<void> {
	const manifest = `${ctx.layout.hotSwapAgentJar}.mf`;
	ctx.ports.fs.write(manifest, "Premain-Class: CosmicProbeServer$HotSwapAgent\nCan-Redefine-Classes: true\n");
	ctx.ports.fs.remove(ctx.layout.hotSwapAgentJar);
	await ctx.ports.proc.runAsync({
		command: "jar",
		args: ["cfm", ctx.layout.hotSwapAgentJar, manifest],
		cwd: ctx.projectRoot,
		env: baseChildEnv(ctx),
	});
}

export type HotSwapMode = "instrument" | "jrebel";

export interface HotSwapPlan {
	mode: HotSwapMode;
	/** 加在常驻 JVM 启动参数里的那几项 */
	args: string[];
	/** 要 JRebel 却没找到之类，照实告诉人；null 表示一切照配置来 */
	warning: string | null;
}

/**
 * 常驻 JVM 用哪种方式换类（S27 3.1）。
 *
 *   默认：JDK 自带的换类（-javaagent 挂宿主自己的入口）。能换方法体和 private static/final 方法，
 *   加字段、加别的方法、改签名这类结构变化换不了，退回重起。
 *   配了 jrebel：启动时挂上用户本机的 JRebel，加方法、加字段也能换。两者不同时挂：
 *   两家同时改类会互相打架。
 *
 * 配了 JRebel 却找不到，就退回默认方式并说一句——不因为一个可选的加速项让常驻 JVM 起不来。
 */
export function resolveHotSwap(ctx: KernelContext): HotSwapPlan {
	const instrument = (warning: string | null): HotSwapPlan => ({
		mode: "instrument",
		args: ctx.ports.fs.exists(ctx.layout.hotSwapAgentJar) ? [`-javaagent:${ctx.layout.hotSwapAgentJar}`] : [],
		warning,
	});
	const wanted = ctx.config.jrebel;
	if (wanted === null) return instrument(null);
	const agent = wanted === "auto" ? findJrebelAgent(ctx) : ctx.ports.fs.exists(wanted) ? wanted : null;
	if (agent === null) {
		return instrument(
			wanted === "auto"
				? "配置要求挂 JRebel，但本机 IDEA 插件目录里没找到它的原生库 → 用 JDK 自带的换类"
				: `配置里的 JRebel 路径不存在（${wanted}）→ 用 JDK 自带的换类`,
		);
	}
	return { mode: "jrebel", args: [`-agentpath:${agent}`, "-Dcosmic.jrebel=1"], warning: null };
}

/**
 * 常驻 JVM 的启动参数（`java` 后面那一串）。
 *
 * 宿主自己的 probe.* 参数写在主类后面（写法同 -D，宿主在 main 一开头设成系统属性），不写成 JVM 的 -D：
 * JRebel 拿 JVM 的全部 -D 参数（还有 PATH）当它启动缓存的对照依据，这几项里有按版本变的缓存路径，
 * 写在 -D 里每换一个版本就要重新生成一次（真机 21.5 秒，能复用 5.7 秒，见 `scripts/measure-jrebel-cache.ts`）。
 * 主类前面只留不随版本变的：内存、编码、换类方式、工程配置；`-cp` 跟着版本变，但不在 JRebel 的对照依据里。
 * 写在主类后面，命令行里照样看得到版本号，认进程身份（local-jvms.ts）不受影响。
 */
export function residentServerArgs(ctx: KernelContext, hotSwap: HotSwapPlan, tools: string): string[] {
	return [
		...productJvmOptions(ctx.config, ["-Xmx2g", "-XX:MaxMetaspaceSize=512m"]),
		KEEP_EXCEPTION_STACKS,
		"-Dfile.encoding=UTF-8",
		...hotSwap.args,
		...jvmProps(ctx.config),
		...poolProps(ctx.config),
		...userJvmArgs(ctx.config),
		"-cp",
		classpathOf(ctx.layout.probeClasses, ctx.layout.pathingJar, tools),
		"CosmicProbeServer",
		`-Dprobe.probesDir=${ctx.layout.probesDir}`,
		`-Dprobe.hotOut=${ctx.layout.probeHotOut}`,
		`-Dprobe.argfile=${ctx.layout.javacArgs}`,
		`-Dprobe.healthFile=${ctx.layout.serverPid}.health`,
		`-Dprobe.runtimeKey=${ctx.runtimeKeyId}`,
	];
}

/** IDEA 的 JRebel 插件把原生库放在 <配置目录>/JetBrains/<IDE 版本>/plugins/jr-ide-idea/lib/jrebel6/lib 下；取版本名最大的那个。 */
function findJrebelAgent(ctx: KernelContext): string | null {
	const { fs } = ctx.ports;
	const home = ctx.env.USERPROFILE ?? ctx.env.HOME ?? "";
	const roots =
		ctx.platform === "win32"
			? [ctx.env.APPDATA ?? join(home, "AppData", "Roaming")]
			: ctx.platform === "darwin"
				? [join(home, "Library", "Application Support")]
				: [join(home, ".local", "share"), join(home, ".config")];
	const lib =
		ctx.platform === "win32" ? "jrebel64.dll" : ctx.platform === "darwin" ? "libjrebel64.dylib" : "libjrebel64.so";
	for (const root of roots) {
		const base = join(root, "JetBrains");
		const ides = fs
			.readDir(base)
			.filter((entry) => entry.isDirectory)
			.map((entry) => entry.name)
			.sort()
			.reverse();
		for (const ide of ides) {
			const candidate = join(base, ide, "plugins", "jr-ide-idea", "lib", "jrebel6", "lib", lib);
			if (fs.exists(candidate)) return candidate;
		}
	}
	return null;
}

export interface StartOutcome {
	started: boolean;
	pid: number | null;
	waitedSeconds: number;
	/** Tail of the server log when the start failed. */
	logTail: string;
	/** 配了 JRebel 却没挂上之类的一句话；null 表示照配置起的 */
	hotSwapWarning?: string | null;
}

/**
 * Starts the resident JVM and waits for it to answer PING.
 *
 * No Jetty here, so 2g is enough; the metadata cache is the large consumer.
 */
export async function startServer(
	ctx: KernelContext,
	onProgress?: (stage: ProbeServerProgress) => void,
): Promise<KernelResult<StartOutcome>> {
	const id = `${ctx.projectRoot}\n${ctx.runtimeKeyId}`;
	const running = starting.get(id);
	if (running !== undefined) {
		if (onProgress !== undefined) {
			running.listeners.add(onProgress);
			if (running.stage !== null) onProgress(running.stage);
		}
		return running.work;
	}
	const listeners = new Set<(stage: ProbeServerProgress) => void>(onProgress === undefined ? [] : [onProgress]);
	const flight: StartFlight = { listeners, stage: null, work: Promise.resolve(ok(NOT_STARTED)) };
	const report = (stage: ProbeServerProgress): void => {
		flight.stage = stage;
		for (const listener of listeners) listener(stage);
	};
	flight.work = serviceTransition(ctx, "starting", () => startServerInner(ctx, report)).finally(() => {
		starting.delete(id);
	});
	starting.set(id, flight);
	return flight.work;
}

/**
 * 正在进行的启动，按工程和版本记（S58）。
 *
 * 常驻 JVM 起来要半分钟，这半分钟端口是关的。同一个进程里第二个要用它的（开机自检还没完就恢复了会话、
 * 模型紧跟着发了第一个探针）看到端口没人答，以前会再起一个；现在搭同一趟启动，进度照样报给它。
 */
interface StartFlight {
	work: Promise<KernelResult<StartOutcome>>;
	listeners: Set<(stage: ProbeServerProgress) => void>;
	stage: ProbeServerProgress | null;
}
const starting = new Map<string, StartFlight>();
const NOT_STARTED: StartOutcome = { started: false, pid: null, waitedSeconds: 0, logTail: "" };

/**
 * 登记里那个进程是本上下文的、还活着：别的进程（另一个窗口，或者界面开着又跑的一次命令行）刚起的，
 * 端口还没开。返回它的进程号；登记不在、进程不在了、核对不了是不是它，都返回 null。
 */
async function startingElsewhere(ctx: KernelContext): Promise<number | null> {
	const manifest = readManifest(ctx);
	if (manifest === null || manifest.keyId !== ctx.runtimeKeyId) return null;
	const verdict = await verifyRecordedPid(jvmDeps(ctx), {
		kind: "probe",
		pid: manifest.pid,
		keyId: manifest.keyId,
		recordFile: ctx.layout.serverPid,
		projectRoot: ctx.projectRoot,
	});
	return verdict === "ours" ? manifest.pid : null;
}

/**
 * 等一个已经拉起的常驻 JVM 答 PING。返回等了多少毫秒；进程先退出了返回 null。
 * 节奏和「为什么不设截止时间」见 START_POLL_RAMP_MS。
 */
async function awaitAnswer(ctx: KernelContext, pid: number): Promise<number | null> {
	for (let attempt = 0, waited = 0; ; attempt++) {
		const delay = START_POLL_RAMP_MS[attempt] ?? START_POLL_MAX_MS;
		await ctx.ports.clock.sleep(delay);
		waited += delay;
		if ((await ping(ctx)).ok) return waited;
		if (!ctx.ports.proc.isAlive(pid)) return null;
	}
}

async function startServerInner(
	ctx: KernelContext,
	onProgress?: (stage: ProbeServerProgress) => void,
): Promise<KernelResult<StartOutcome>> {
	const alreadyUp = await ping(ctx);
	if (alreadyUp.ok) {
		const manifest = readManifest(ctx);
		if (isOwnLiveServer(ctx, manifest) && manifest !== null) {
			return ok({ started: false, pid: manifest.pid, waitedSeconds: 0, logTail: "" });
		}
		// Something is listening on this RuntimeKey's port but no pid record proves
		// it is ours. Adopting it would run every probe against another runtime's
		// classes and report success. The caller falls back to the cold path.
		return err(
			new KernelError("PROBE_SERVER_UNAVAILABLE", `端口 ${residentPort(ctx)} 被一个认不出归属的 JVM 占着`, {
				detail: { port: residentPort(ctx), recordedKeyId: manifest?.keyId ?? null },
				remedy: "那多半是别的工程/运行时的常驻 JVM。停掉它，或改用冷进程（--cold）。",
			}),
		);
	}

	const tools = await findToolsJar(ctx);
	if (tools === null) {
		return err(
			new KernelError("TOOLCHAIN_MISSING", "找不到 tools.jar，常驻模式用不了", {
				detail: { javaHome: ctx.env.JAVA_HOME ?? null },
				remedy: "把 JAVA_HOME 指向 JDK（不是 JRE）后重试；冷进程路径不受影响。",
			}),
		);
	}

	const hosts = await ensureHostClasses(ctx, onProgress);
	if (!hosts.ok) return err(hosts.error);
	// 老版本留下的 probe-classes 里宿主类是新的、换类入口的 jar 却没有：补建一次。
	if (!ctx.ports.fs.exists(ctx.layout.hotSwapAgentJar)) await buildHotSwapAgent(ctx);
	const hotSwap = resolveHotSwap(ctx);

	onProgress?.("starting-runtime");
	// 别的进程刚起了一个、端口还没开：等它，不再起第二个。它中途退出了，才接着起自己的。
	const elsewhere = await startingElsewhere(ctx);
	if (elsewhere !== null) {
		serviceChanged(ctx, "warming");
		const waited = await awaitAnswer(ctx, elsewhere);
		if (waited !== null) {
			return ok({ ...NOT_STARTED, pid: readManifest(ctx)?.pid ?? elsewhere, waitedSeconds: waited / 1000 });
		}
	}
	const started = ctx.ports.proc.startDetached({
		command: "java",
		args: residentServerArgs(ctx, hotSwap, tools),
		cwd: ctx.projectRoot,
		// The host reads its listen port from PROBE_SERVER_PORT, so the derived port
		// is handed to it the same way a user-configured one would be -- no change to
		// the frozen Java resource is needed to get per-RuntimeKey isolation.
		env: { ...baseChildEnv(ctx), PROBE_SERVER_PORT: String(residentPort(ctx)) },
		logFile: ctx.layout.serverLog,
	});
	if (started.pid === null) {
		return err(
			new KernelError("PROBE_SERVER_UNAVAILABLE", `常驻 JVM 起不来：${started.error ?? "未知原因"}`, {
				detail: { logFile: ctx.layout.serverLog },
				remedy: "确认 java 在 PATH 上；仍不行就用冷进程路径。",
			}),
		);
	}

	// The manifest is written before the wait: a JVM that starts slowly and is
	// then abandoned must still be reclaimable by identity rather than by port.
	ctx.ports.fs.write(
		ctx.layout.serverPid,
		JSON.stringify({
			pid: started.pid,
			keyId: ctx.runtimeKeyId,
			port: residentPort(ctx),
			startedAt: new Date(ctx.ports.clock.now()).toISOString(),
			// 宿主是用这两个值建 RequestContext 的（-Dcosmic.account / -Dcosmic.user），
			// 记在这里，下一次才有得比。
			account: ctx.config.account,
			user: ctx.config.user,
			hotSwap: hotSwap.mode,
		} satisfies ServerManifest),
	);

	onProgress?.("warming-runtime");
	serviceChanged(ctx, "warming");
	const waited = await awaitAnswer(ctx, started.pid);
	if (waited === null) {
		return err(
			new KernelError("PROBE_SERVER_UNAVAILABLE", "常驻 JVM 启动后立刻退出", {
				detail: { logFile: ctx.layout.serverLog, tail: logTail(ctx) },
				remedy: "看日志尾部；探针宿主起不来时冷进程路径仍可用。",
			}),
		);
	}
	// 新版本起来了：同一工程旧版本里空闲着的那些不再有人用，停掉（S53，用户选 A）。
	// 不等它：停旧的最多几秒，不该算进这次探针的用时；出错也不影响这一个。
	void retireOldProbeServers(jvmDeps(ctx), {
		cacheRoots: localCacheRoots(ctx),
		currentKeyId: ctx.runtimeKeyId,
		projectRoot: ctx.projectRoot,
		nowMs: ctx.ports.clock.now(),
	}).catch(() => undefined);
	return ok({
		started: true,
		// 答话的不一定是这次起的那个（两个进程同时起、对方先占到端口）：以登记为准，问端口时已经对过。
		pid: readManifest(ctx)?.pid ?? started.pid,
		waitedSeconds: waited / 1000,
		logTail: "",
		hotSwapWarning: hotSwap.warning,
	});
}

function logTail(ctx: KernelContext, lines = 25): string {
	return ctx.ports.fs.read(ctx.layout.serverLog).split(/\r?\n/).slice(-lines).join("\n");
}

export interface StopOutcome {
	/**
	 * "unverified"：心跳没答、进程清单也查不了，证明不了登记里那个进程号还是它，没有动，登记也留着。
	 */
	how: "graceful" | "forced" | "absent" | "foreign" | "unverified";
	pid: number | null;
}

/**
 * 为什么标记：`classes` 是「业务类重编过了」，先试热替换（S27 3.1），换不进去再重起；
 * `restart` 是元数据、身份这类换类解决不了的，只能重起。
 */
export type StaleKind = "classes" | "restart";

const CLASSES_TAG = "[类] ";

/**
 * Records that the resident JVM's classes are out of date, **without restarting it**.
 *
 * A JVM loads a class once. After a compile, the one on the port is serving the
 * previous version, so it has to go -- but it does not have to go *now*. `fast`
 * used to stop and start it on the spot, which is tens of seconds, and a session
 * that compiles four times in a row before running anything paid that four times
 * for three JVMs no probe ever spoke to. The marker moves the cost to the moment
 * a probe actually needs the JVM, where exactly one restart happens no matter how
 * many compiles preceded it.
 *
 * The safety property is unchanged and is worth stating plainly: **no probe ever
 * runs against a marked JVM.** `takeServerStale` is checked on the one path that
 * uses the resident JVM, before the request goes out.
 *
 * 追加而不是覆盖：先写元数据、再编译，两条都得留着——只剩「编译过」那条，
 * 下次就只换类不重起，元数据那半边的旧缓存就漏过去了。
 */
export function markServerStale(ctx: KernelContext, reason: string, kind: StaleKind = "restart"): void {
	const before = ctx.ports.fs.exists(ctx.layout.serverStale) ? ctx.ports.fs.read(ctx.layout.serverStale) : "";
	const line = `${new Date(ctx.ports.clock.now()).toISOString()} ${kind === "classes" ? CLASSES_TAG : ""}${reason}\n`;
	ctx.ports.fs.write(ctx.layout.serverStale, before + line);
	serviceChanged(ctx);
}

export interface StaleMark {
	/** 人看的原因，多条用「；」连起来 */
	reason: string;
	/** 全是「业务类重编过了」：可以先试热替换 */
	classesOnly: boolean;
}

/** Reads the marker and clears it. Returns null when the JVM was not marked. */
export function takeServerStale(ctx: KernelContext): StaleMark | null {
	if (!ctx.ports.fs.exists(ctx.layout.serverStale)) return null;
	const lines = ctx.ports.fs
		.read(ctx.layout.serverStale)
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line !== "");
	ctx.ports.fs.remove(ctx.layout.serverStale);
	// 每行是「时间 原因」；带 [类] 的是可以热替换的那种。老格式没有标签，按只能重起算。
	const reasons = lines.map((line) => line.replace(/^\S+\s+/, ""));
	const classesOnly = reasons.length > 0 && reasons.every((reason) => reason.startsWith(CLASSES_TAG));
	const unique = [...new Set(reasons.map((reason) => reason.replace(CLASSES_TAG, "")))];
	return { reason: unique.join("；") || "（无原因）", classesOnly };
}

export interface SyncOutcome {
	mode: string;
	/** 业务类目录里变了的类 */
	changed: number;
	/** 其中已加载、真换进去的 */
	redefined: number;
	/** 变了但还没加载过的：下次用到时直接读新的 */
	notLoaded: number;
	ms: number;
}

/** 一句人话：换了几个、多快。没加载过的类不用换——下次用到时 JVM 直接从磁盘读新的。 */
export function describeSync(outcome: SyncOutcome): string {
	if (outcome.mode === "jrebel") return `交给 JRebel 换类（变了 ${outcome.changed} 个类，用到时换）`;
	const rest = outcome.notLoaded > 0 ? `，另 ${outcome.notLoaded} 个还没加载过、用到时直接读新的` : "";
	return `已热替换 ${outcome.redefined} 个类（${outcome.ms} 毫秒${rest}）`;
}

/**
 * 让常驻 JVM 把业务类目录里变了的类换进去（S27 3.1）。
 *
 * 换不进去（结构变了、没挂换类入口、JRebel 没生效）返回 ok:false 和原因，调用方退回重起。
 * 宿主那边整批是原子的：拒了就一个都没换，所以「换不进去再重起」不会留下半新半旧的 JVM。
 */
export async function syncClasses(
	ctx: KernelContext,
): Promise<{ ok: true; value: SyncOutcome } | { ok: false; why: string }> {
	return serviceTransition(ctx, "syncing", () => syncClassesInner(ctx));
}

async function syncClassesInner(
	ctx: KernelContext,
): Promise<{ ok: true; value: SyncOutcome } | { ok: false; why: string }> {
	const reply = await ctx.ports.net.request(residentPort(ctx), SYNC_REQUEST, SYNC_TIMEOUT_MS);
	if (!reply.ok) return { ok: false, why: `常驻 JVM 没回话（${reply.why ?? "未知"}）` };
	const decoded = decodeResponse(reply.text);
	if (!decoded.ok) return { ok: false, why: decoded.why };
	const fields = new Map<string, string>();
	for (const line of decoded.value.body.split(/\r?\n/)) {
		const eq = line.indexOf("=");
		if (eq > 0) fields.set(line.slice(0, eq), line.slice(eq + 1));
	}
	if (decoded.value.status !== "OK") {
		const names = fields.get("names");
		return {
			ok: false,
			why: `${fields.get("reason") ?? decoded.value.status}${names ? `；涉及 ${names}` : ""}`,
		};
	}
	const num = (key: string): number => Number(fields.get(key) ?? "0") || 0;
	return {
		ok: true,
		value: {
			mode: fields.get("mode") ?? "?",
			changed: num("changed"),
			redefined: num("redefined"),
			notLoaded: num("notLoaded"),
			ms: num("ms"),
		},
	};
}

/**
 * Stops the resident JVM.
 *
 * A manifest naming another RuntimeKey is reported as "foreign" and left alone.
 * That is the D10 rule in code: this process may not terminate a JVM it cannot
 * prove is its own.
 */
export async function stopServer(ctx: KernelContext): Promise<StopOutcome> {
	return serviceTransition(ctx, "stopping", () => stopServerInner(ctx));
}

const recovering = new Map<string, Promise<KernelResult<StartOutcome>>>();

/** 仅用于宿主明确拒绝的请求；并行查询共用一次恢复，不互相停掉刚起的 JVM。 */
export async function recoverTimedOutServer(
	ctx: KernelContext,
	onProgress?: (stage: ProbeServerProgress) => void,
): Promise<KernelResult<StartOutcome>> {
	const key = ctx.layout.serverPid;
	const active = recovering.get(key);
	if (active !== undefined) return active;
	const flight = (async (): Promise<KernelResult<StartOutcome>> => {
		if (!(await ownsAnswering(ctx)))
			return err(new KernelError("PROBE_RESIDENT_UNAVAILABLE", "无法确认拒绝请求的常驻进程归属，本次没有自动恢复"));
		const stopped = await stopServer(ctx);
		if (stopped.how === "foreign" || stopped.how === "unverified")
			return err(
				new KernelError("PROBE_RESIDENT_UNAVAILABLE", "无法确认常驻进程归属，本次没有自动恢复", {
					remedy: "先查看本地进程清单，确认目标进程后再处理。",
				}),
			);
		return startServer(ctx, onProgress);
	})();
	recovering.set(key, flight);
	try {
		return await flight;
	} finally {
		recovering.delete(key);
	}
}

async function stopServerInner(ctx: KernelContext): Promise<StopOutcome> {
	const manifest = readManifest(ctx);
	if (manifest !== null && manifest.keyId !== ctx.runtimeKeyId) {
		return { how: "foreign", pid: manifest.pid };
	}

	// The JVM is going away, so "its classes are out of date" stops meaning
	// anything; leaving the marker would only buy the next start an extra restart.
	ctx.ports.fs.remove(ctx.layout.serverStale);
	// 发 SHUTDOWN 之前它活着、之后没了：是它收到请求自己退的。它正在跑别的请求时（一次只答一个）回话会超时，
	// 等到核对进程时已经退了；不记下这一刻，后面会把「刚停掉」报成「本来就没在跑」。
	const aliveBefore = manifest !== null && ctx.ports.proc.isAlive(manifest.pid);
	const reply = await ctx.ports.net.request(residentPort(ctx), SHUTDOWN_REQUEST, 5_000);
	const replied = reply.ok && decodeResponse(reply.text).ok;
	// 宿主先回 RESULT OK 再 System.exit，退出可能卡住：进程还在，端口和 build/cosmic-pathing.jar 都还占着，
	// 紧接着的重启撞端口、Windows 上重建 pathing jar 写不进去。所以回了话也要等它真退，等不到按没回话处理。
	const graceful = replied && (manifest === null || (await waitExit(jvmDeps(ctx), manifest.pid)));
	if (!graceful && manifest !== null) {
		// 登记只记了进程号，号会被系统分给别的程序：核对过是它才强制结束（S53）。
		const verdict = await verifyRecordedPid(jvmDeps(ctx), {
			kind: "probe",
			pid: manifest.pid,
			keyId: manifest.keyId,
			recordFile: ctx.layout.serverPid,
			projectRoot: ctx.projectRoot,
		});
		if (verdict === "unknown") return { how: "unverified", pid: manifest.pid };
		if (verdict === "ours") {
			await ctx.ports.proc.kill(manifest.pid, true);
			ctx.ports.fs.remove(ctx.layout.serverPid);
			return { how: "forced", pid: manifest.pid };
		}
		if (verdict === "gone" && aliveBefore) {
			ctx.ports.fs.remove(ctx.layout.serverPid);
			return { how: "graceful", pid: manifest.pid };
		}
	}
	ctx.ports.fs.remove(ctx.layout.serverPid);
	if (graceful) return { how: "graceful", pid: manifest?.pid ?? null };
	return { how: "absent", pid: null };
}

export async function sendProbe(ctx: KernelContext, request: ProbeRequest): Promise<KernelResult<ProbeResponse>> {
	const kind = isOwnLiveServer(ctx, readManifest(ctx)) ? "executing" : "checking";
	return serviceTransition(ctx, kind, () => sendProbeInner(ctx, request));
}

async function sendProbeInner(ctx: KernelContext, request: ProbeRequest): Promise<KernelResult<ProbeResponse>> {
	const timeoutMs =
		request.timeoutMs === undefined
			? REQUEST_TIMEOUT_MS
			: Math.max(REQUEST_TIMEOUT_MS, request.timeoutMs + REQUEST_TIMEOUT_MARGIN_MS);
	const reply = await ctx.ports.net.request(residentPort(ctx), encodeProbeRequest(request), timeoutMs);
	if (!reply.ok) {
		return err(
			new KernelError("PROBE_SERVER_UNAVAILABLE", `常驻 JVM 不可用：${reply.why ?? "未知"}`, {
				detail: { why: reply.why },
				remedy: "内核会自动降级冷进程；持续失败时看 probe-server 日志。",
			}),
		);
	}
	const decoded = decodeResponse(reply.text);
	if (!decoded.ok) {
		return err(
			new KernelError("PROBE_SERVER_UNAVAILABLE", decoded.why, {
				detail: { bytes: reply.text.length },
				remedy: "多半是常驻 JVM 中途死了；重启常驻或走冷进程。",
			}),
		);
	}
	return ok(decoded.value);
}

/** True when a connection-level failure means "nothing is listening", so a start is worth trying. */
export function isNotRunning(error: KernelError): boolean {
	const why = String(error.detail.why ?? "");
	// RESET 可能是业务已经提交后连接断开，不能当成「还没执行」重新发请求。
	return /ECONNREFUSED|EADDRNOTAVAIL/.test(why);
}
