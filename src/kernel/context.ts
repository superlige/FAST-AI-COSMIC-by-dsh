/**
 * The explicit kernel context (D9, S3.2).
 *
 * The frozen driver.mjs resolved ROOT and CFG at module load and kept task state
 * (RUN_ARGV, RUN_BATCH) in module-level `let`s. One process per command made that
 * safe. A resident agent serves many calls in one process, so every one of those
 * has to become a value that is created per call and passed down.
 *
 * Two rules this file exists to enforce:
 *   1. `env` is a frozen snapshot. Nothing in the kernel writes to process.env,
 *      so one call can never observe another call's environment.
 *   2. Child processes get an environment this module composes explicitly. The
 *      frozen probe path forwarded the driver's entire process.env to the JVM;
 *      in an agent that would hand the user's Cosmic runtime every credential
 *      the agent process happens to hold. Only the declared keys travel.
 */

import type { KernelConfig } from "./config/load-config.ts";
import type { KernelLayout } from "./layout.ts";
import type { Ports } from "./ports.ts";

/**
 * Environment variables that are part of the kernel's contract with the JVM and
 * with javac. Anything not on this list stays in the agent process.
 *
 * PATH / SystemRoot / TEMP and friends are added by baseChildEnv because a
 * child cannot find java or write temp files without them; they are not secrets
 * and omitting them makes every spawn fail on Windows.
 */
export const FORWARDED_ENV_KEYS = [
	"JAVA_HOME",
	"JAVA_TOOL_OPTIONS",
	"COSMIC_ACCOUNT",
	"COSMIC_USER",
	"COSMIC_ISV",
	"COSMIC_TENANT",
] as const;

const PLATFORM_ENV_KEYS = [
	"PATH",
	"Path",
	"PATHEXT",
	"SystemRoot",
	"SystemDrive",
	"windir",
	"TEMP",
	"TMP",
	"TMPDIR",
	"HOME",
	"USERPROFILE",
	"COMSPEC",
	"ComSpec",
	"LANG",
	"LC_ALL",
	"HOMEDRIVE",
	"HOMEPATH",
	"NUMBER_OF_PROCESSORS",
	"PROCESSOR_ARCHITECTURE",
	"OS",
] as const;

export interface KernelContext {
	projectRoot: string;
	config: KernelConfig;
	layout: KernelLayout;
	/** Immutable snapshot taken once, at the edge. Never process.env directly. */
	env: Readonly<Record<string, string | undefined>>;
	ports: Ports;
	/** Identity of the runtime this context is bound to (S2 RuntimeKey id). */
	runtimeKeyId: string;
	/**
	 * Class names of the probes this agent may run. A closed set, taken from the
	 * embedded resources rather than from the filesystem: every path into a JVM
	 * that holds a Cosmic connection must be reviewed code that calls IsvGuard.
	 */
	probes: readonly string[];
	/**
	 * SHA-256 of each reviewed released probe as embedded in this agent build.
	 * The cache copy is executable input, so it must still match this digest at
	 * every invocation; a class-name allow-list alone does not make edited Java
	 * reviewed code.
	 */
	releasedProbeDigests: Readonly<Record<string, string>>;
	platform: NodeJS.Platform;
	signal?: AbortSignal;
}

export interface CreateContextInput {
	projectRoot: string;
	config: KernelConfig;
	layout: KernelLayout;
	env: Readonly<Record<string, string | undefined>>;
	ports: Ports;
	runtimeKeyId: string;
	probes: readonly string[];
	releasedProbeDigests?: Readonly<Record<string, string>>;
	platform?: NodeJS.Platform;
	signal?: AbortSignal;
}

export function createContext(input: CreateContextInput): KernelContext {
	return {
		projectRoot: input.projectRoot,
		config: input.config,
		layout: input.layout,
		env: Object.freeze({ ...input.env }),
		ports: input.ports,
		runtimeKeyId: input.runtimeKeyId,
		probes: Object.freeze([...input.probes]),
		releasedProbeDigests: Object.freeze({ ...(input.releasedProbeDigests ?? {}) }),
		platform: input.platform ?? process.platform,
		signal: input.signal,
	};
}

/**
 * The environment every child process starts from: platform essentials plus the
 * declared forwarded keys, and nothing else.
 */
export function baseChildEnv(ctx: KernelContext): Record<string, string> {
	const out: Record<string, string> = {};
	for (const key of [...PLATFORM_ENV_KEYS, ...FORWARDED_ENV_KEYS]) {
		const value = ctx.env[key];
		if (value !== undefined) out[key] = value;
	}
	return out;
}

/**
 * Child env with a per-call overlay applied.
 *
 * This is how probe input arrives. The frozen driver mutated process.env inside
 * bindProbeArgs and let the mutation leak to every later command in the process;
 * here the overlay is a value that dies with the call.
 */
export function childEnv(ctx: KernelContext, overlay: Readonly<Record<string, string>> = {}): Record<string, string> {
	return { ...baseChildEnv(ctx), ...overlay };
}

/**
 * Chinese Windows defaults the JVM to file.encoding=GBK, so Gradle and javac
 * write GBK bytes that a UTF-8 terminal renders as mojibake -- the real compile
 * error gets buried. JAVA_TOOL_OPTIONS is read by every JVM at startup,
 * including the Gradle daemon.
 */
export function withUtf8ToolOptions(env: Record<string, string>): Record<string, string> {
	const opts = ["-Dfile.encoding=UTF-8", "-Dsun.stdout.encoding=UTF-8", "-Dsun.stderr.encoding=UTF-8"];
	const existing = env.JAVA_TOOL_OPTIONS;
	return { ...env, JAVA_TOOL_OPTIONS: existing ? `${existing} ${opts.join(" ")}` : opts.join(" ") };
}

/**
 * 苍穹进程里数据库连接池（HikariCP）的启动参数，常驻进程和冷进程都带。
 *
 * 连接池把连接借出去之前先探一下活（发一句 SELECT 1，一趟网络来回），只有半秒内刚用过的不探。
 * 一个操作发几百条 SQL，每条都多这一趟：真机一次 39 秒的反审核 692 条 SQL，探活占 6.2 秒。
 * 这里把「刚用过不探」的窗口放宽到 30 秒：连着干活时不再每条都探，闲了半分钟以上的连接照旧先探再借。
 * 代价：30 秒内用过的连接恰好断了，这次查询会直接卡住报错，而不是探活发现后换一条。
 * 真机量过闲置到 15 分钟的连接都是通的（docs/S59-call-overhead-idle-connections.md §4.3、§4.4）。
 * 值不随版本变：JRebel 拿全部 -D 当启动缓存的对照依据，变了要重新生成。
 *
 * 第二项 cosmic.dbLink 告诉宿主连库用哪一套开关（宿主的 CosmicProbe.tuneDbLink 读它）：
 * fast = 一条 SQL 一趟发完、传输压缩；platform = 照平台默认。真机数据见同一篇 §9。
 */
export const POOL_ALIVE_BYPASS_MS = 30_000;

export function poolProps(config: Pick<KernelConfig, "dbLink">): string[] {
	return [
		`-Dcom.zaxxer.hikari.aliveBypassWindowMs=${String(POOL_ALIVE_BYPASS_MS)}`,
		`-Dcosmic.dbLink=${config.dbLink}`,
	];
}

/**
 * 跑业务代码的 JVM（常驻探针宿主、冷进程）都带：HotSpot 对编译过的代码里反复抛的空指针、越界、强转失败，
 * 默认改抛一个预先建好、不带栈也不带消息的异常。常驻进程一跑几个小时，插件里一个空指针抛几次就只剩
 * 「NullPointerException: (无)」，看不出是哪个插件哪一行。关掉它的代价只在反复抛异常的热路径上。
 * 不是 -D，不进 JRebel 启动缓存的对照依据。
 */
export const KEEP_EXCEPTION_STACKS = "-XX:-OmitStackTraceInFastThrow";

/** `-Dcosmic.*` properties the probe host reads. Ported unchanged from config.mjs. */
export function jvmProps(config: KernelConfig): string[] {
	return [
		`-Dcosmic.isv=${config.isv}`,
		`-Dcosmic.tenant=${config.tenant}`,
		`-Dcosmic.account=${config.account}`,
		`-Dcosmic.user=${config.user}`,
		`-Dcosmic.appClass=${config.appClass}`,
		`-Dcosmic.appMethod=${config.appMethod}`,
		`-Dcosmic.codeModules=${config.codeModules.join(",")}`,
	];
}
