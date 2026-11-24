/**
 * javac / java / gradlew invocation (S3.1, S3.2).
 *
 * Everything here goes through ctx.ports.proc, so no command string is ever
 * assembled and no argument can turn into one (D1). The frozen driver called
 * process.exit on a failed javac; these functions return the result and let the
 * command layer decide, which is what makes "compile failure" one of the five
 * golden groups instead of a dead process.
 */

import { delimiter, join, relative } from "node:path";
import { classpathFromArgfile } from "../runtime/jdk-probe.ts";
import { staleSourcesIn } from "./commands/sources.ts";
import { type GradleModuleDirs, readGradleModuleDirs } from "./config/detect.ts";
import { baseChildEnv, type KernelContext, withUtf8ToolOptions } from "./context.ts";
import { err, KernelError, type KernelResult, ok } from "./errors.ts";
import type { ProcessResult } from "./ports.ts";
// server.ts imports this module too; these are only called, never read at load time.
import { isOwnLiveServer, markServerStale, ping, readManifest, stopServer } from "./probe/server.ts";

export interface ToolRun {
	status: number;
	/** stdout and stderr merged, CRLF normalised. javac writes diagnostics to stderr. */
	out: string;
	/** Wall time in seconds, one decimal. */
	seconds: string;
}

function toRun(result: ProcessResult, elapsedMs: number): ToolRun {
	return {
		status: result.status ?? 1,
		out: `${result.stdout}${result.stderr}`.replace(/\r\n/g, "\n"),
		seconds: (elapsedMs / 1000).toFixed(1),
	};
}

/**
 * javac diagnostics are written in the JVM's default charset -- GBK on a Chinese
 * Windows -- and land as mojibake in a UTF-8 terminal, which buries the real
 * compile error. -J-Dfile.encoding=UTF-8 controls that output and is a different
 * thing from the source's -encoding UTF-8; both are required.
 */
export async function runJavac(ctx: KernelContext, args: readonly string[], signal?: AbortSignal): Promise<ToolRun> {
	const started = ctx.ports.clock.now();
	const argFile = javacArgFile(ctx, args);
	try {
		const result = await ctx.ports.proc.runAsync(
			{
				command: "javac",
				args: ["-J-Dfile.encoding=UTF-8", ...(argFile === null ? args : argFile.args)],
				cwd: ctx.projectRoot,
				env: baseChildEnv(ctx),
				maxBufferBytes: 64 * 1024 * 1024,
			},
			signal,
		);
		if (result.spawnError !== null) {
			return { status: 127, out: `javac 启动失败：${result.spawnError}`, seconds: "0.0" };
		}
		return toRun(result, ctx.ports.clock.now() - started);
	} finally {
		if (argFile !== null) ctx.ports.fs.remove(argFile.path);
	}
}

/**
 * Windows 一条命令行最多 32,767 个字符。第一次编整个工程（刚克隆、刚拉下一大批代码）时，
 * 几百个源码路径拼起来远超这条线，spawn 直接抛 ENAMETOOLONG，整条命令崩掉（2026-09-27 真机：567 个源码）。
 * 参数总长超过 JAVAC_COMMAND_LINE_BUDGET 时，除 `-J…`（给启动器的，只能留在命令行）和 `@…`
 * （javac 不展开参数文件里的参数文件）以外，其余参数按原顺序写进一个参数文件，用 `@文件` 传。
 * 每项加双引号，反斜杠和双引号转义：JDK 8 和 9+ 的 javac 读参数文件都认这种写法；
 * 命令行上的 -J-Dfile.encoding=UTF-8 让 javac 按 UTF-8 读这个文件。
 */
export const JAVAC_COMMAND_LINE_BUDGET = 8000;
let javacArgFileSeq = 0;

function javacArgFile(ctx: KernelContext, args: readonly string[]): { path: string; args: string[] } | null {
	const length = args.reduce((sum, arg) => sum + arg.length + 1, 0);
	if (length <= JAVAC_COMMAND_LINE_BUDGET) return null;
	const stays = (arg: string): boolean => arg.startsWith("-J") || arg.startsWith("@");
	javacArgFileSeq += 1;
	const path = join(
		ctx.layout.agentCache,
		`javac-${String(ctx.ports.proc.currentPid())}-${String(javacArgFileSeq)}.args`,
	).replace(/\\/g, "/");
	const quote = (arg: string): string => `"${arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
	ctx.ports.fs.mkdirp(ctx.layout.agentCache);
	ctx.ports.fs.write(
		path,
		`${args
			.filter((arg) => !stays(arg))
			.map(quote)
			.join("\n")}\n`,
	);
	return { path, args: [...args.filter(stays), `@${path}`] };
}

/**
 * java, always through `runAsync`.
 *
 * 这一条曾经是 spawnSync。它跑的是苍穹 JVM——冷探针一次 30-60 秒，SrcIndexTool 一次几十秒，
 * 而 spawnSync 期间整条 Node 事件循环停在那一帧：转圈不转、按键不回显、Esc 收不到。
 * 对着屏幕的人分不出「在编译」和「死了」，只能杀进程。所以内核里不再留同步版本：
 * 留着它，下一处新调用就会把界面重新钉死一次。
 */
export async function runJava(
	ctx: KernelContext,
	args: readonly string[],
	env: Record<string, string>,
	signal?: AbortSignal,
): Promise<ToolRun> {
	const started = ctx.ports.clock.now();
	const result = await ctx.ports.proc.runAsync(
		{
			command: "java",
			args,
			cwd: ctx.projectRoot,
			env,
			maxBufferBytes: 256 * 1024 * 1024,
		},
		signal,
	);
	if (result.spawnError !== null) {
		return { status: 127, out: `java 启动失败：${result.spawnError}`, seconds: "0.0" };
	}
	return toRun(result, ctx.ports.clock.now() - started);
}

/**
 * gradlew, never gradle: the project pins its Gradle version and buildSrc
 * depends on it. gradlew.bat is not on PATH and cwd does not count, so the
 * absolute path is required.
 */
export async function runGradlew(ctx: KernelContext, args: readonly string[], signal?: AbortSignal): Promise<ToolRun> {
	const windows = ctx.platform === "win32";
	const bin = join(ctx.projectRoot, windows ? "gradlew.bat" : "gradlew");
	const started = ctx.ports.clock.now();
	const result = await ctx.ports.proc.runAsync(
		{
			command: bin,
			args,
			cwd: ctx.projectRoot,
			env: withUtf8ToolOptions(baseChildEnv(ctx)),
			windowsBatch: windows,
			maxBufferBytes: 128 * 1024 * 1024,
		},
		signal,
	);
	if (result.spawnError !== null) {
		return { status: 127, out: `gradlew 启动失败：${result.spawnError}`, seconds: "0.0" };
	}
	return toRun(result, ctx.ports.clock.now() - started);
}

/** cosmic-run.gradle does not detect the project; module names and launch class come from here. */
export function gradleConfigProps(ctx: KernelContext): string[] {
	return [
		`-PcosmicDebugModule=${ctx.config.debugModule}`,
		`-PcosmicCodeModules=${ctx.config.codeModules.join(",")}`,
		`-PcosmicMainClass=${ctx.config.appClass}`,
	];
}

export interface BuildOutcome {
	/** True when gradle actually ran; false when the artifacts were already present. */
	ran: boolean;
	pathingJar: string;
	javacArgs: string;
	seconds: string;
	out: string;
	/** Why an existing pair of artifacts was regenerated; null when they were missing, fine, or regenerated on request. */
	reason: string | null;
}

type BuildStage = "module-build" | "pathing-jar";

function gradleBuildFailure(run: ToolRun, stage: BuildStage, modules?: readonly string[]): KernelError {
	const outputTail = run.out.trim().slice(-8_000);
	const outOfMemory = /GC overhead limit exceeded|Java heap space|JVM heap space is exhausted|OutOfMemoryError/i.test(
		run.out,
	);
	const target = stage === "module-build" ? `gradlew :${modules?.join(" :")}:build` : "生成 pathing jar / argfile";
	return new KernelError(
		"BUILD_FAILED",
		outOfMemory ? `${target} 失败：Gradle JVM 内存耗尽` : `${target} 失败（退出码 ${run.status}）`,
		{
			detail: {
				stage,
				status: run.status,
				modules: modules ?? [],
				cause: outOfMemory ? "GRADLE_JVM_OOM" : null,
				outputTail,
			},
			remedy: outOfMemory
				? "增大 gradle.properties 的 org.gradle.jvmargs（建议至少 -Xmx2048m -XX:MaxMetaspaceSize=512m），释放系统内存后执行 gradlew --stop，再重试。"
				: stage === "module-build"
					? "查看 detail.outputTail 中的 Gradle 原文。离线缺依赖（默认带 --offline）时先联网跑一次 gradlew build，" +
						'或用 cosmic_doctor action=config 设 gradleArgs（整体替换默认的 ["--offline"]，例如 [] 或 ["-x", "test"]）。'
					: "查看 detail.outputTail 中的 Gradle 原文，并确认 cosmic-run.gradle 已释放且 debugModule 名字正确。",
		},
	);
}

/**
 * Produces the pathing jar and the javac argfile.
 *
 * `--module` narrows only `:module:build` (jar / test / sourcesJar). The pathing
 * jar still compiles every code module's classes: one module missing from the
 * probe classpath is a NoClassDefFoundError, so that step is not narrowed.
 */
export async function buildArtifacts(
	ctx: KernelContext,
	modules: readonly string[],
	signal?: AbortSignal,
): Promise<KernelResult<BuildOutcome>> {
	const started = ctx.ports.clock.now();
	const chunks: string[] = [];

	const moduleBuild = await runGradlew(ctx, [...modules.map((m) => `:${m}:build`), ...ctx.config.gradleArgs], signal);
	chunks.push(moduleBuild.out);
	if (moduleBuild.status !== 0) {
		return err(gradleBuildFailure(moduleBuild, "module-build", modules));
	}

	// 常驻 JVM 的类路径就是 build/cosmic-pathing.jar，Windows 上它活着这个文件就被锁住，
	// Gradle 重写不了、整次构建失败。反正重新生成后它拿的是旧类路径、要重起，先停掉，下次用到再起。
	// 不用 isOwnLiveServer：账套 / 用户换过的那个它不认，可文件照样锁着。
	const holder = ctx.platform === "win32" ? readManifest(ctx) : null;
	if (holder !== null && holder.keyId === ctx.runtimeKeyId && ctx.ports.proc.isAlive(holder.pid)) {
		await stopServer(ctx);
	}

	const artifacts = await runGradlew(
		ctx,
		[
			"-I",
			ctx.layout.initGradle,
			...gradleConfigProps(ctx),
			`:${ctx.config.debugModule}:cosmicPathingJar`,
			`:${ctx.config.debugModule}:cosmicJavacArgs`,
			...ctx.config.gradleArgs,
		],
		signal,
	);
	chunks.push(artifacts.out);
	if (artifacts.status !== 0) {
		return err(gradleBuildFailure(artifacts, "pathing-jar"));
	}

	return ok({
		ran: true,
		pathingJar: ctx.layout.pathingJar,
		javacArgs: ctx.layout.javacArgs,
		seconds: ((ctx.ports.clock.now() - started) / 1000).toFixed(1),
		out: chunks.join("\n").trim(),
		reason: null,
	});
}

export type ArtifactState = { state: "ok" } | { state: "missing" } | { state: "stale"; reason: string };

const classpathKey = (path: string, platform: NodeJS.Platform): string => {
	const flat = path.replace(/\\/g, "/").replace(/\/+$/, "");
	return platform === "win32" ? flat.toLowerCase() : flat;
};

/**
 * Whether the pathing jar and argfile on disk describe THIS project as it is now.
 *
 * Both files hold absolute paths, and existence alone used to be the whole
 * check. A project copied or moved together with its build/ directory, or one
 * whose code modules changed since the last generation, kept a classpath that
 * pointed at directories that are not this project's: every business class --
 * new or years old -- failed to load, while fast kept reporting a clean compile
 * into the directory the JVM never looked at. Restarting the resident JVM did
 * not help, because nothing ever regenerated the two files.
 *
 * Only the argfile is read. Both come out of the same Gradle invocation from the
 * same `cp()` closure in cosmic-run.gradle, and the pathing jar is a zip whose
 * manifest is not worth unpacking to learn the same thing.
 */
export function artifactState(
	ctx: KernelContext,
	gradleDirs: Readonly<Record<string, GradleModuleDirs>> | null = null,
): ArtifactState {
	const { fs } = ctx.ports;
	if (!fs.exists(ctx.layout.pathingJar) || !fs.exists(ctx.layout.javacArgs)) return { state: "missing" };
	const listed = new Set(
		classpathFromArgfile(fs.read(ctx.layout.javacArgs)).map((entry) => classpathKey(entry, ctx.platform)),
	);
	// After a regeneration the module directories are the ones Gradle just reported, not the
	// ones this context was opened with: a project that moved its output is consistent again.
	const modules = ctx.layout.moduleDirs.map((module) => {
		const out = gradleDirs?.[module.name]?.out;
		return out === undefined ? module : { ...module, out: join(out) };
	});
	const absent = modules.filter((module) => !listed.has(classpathKey(module.out, ctx.platform)));
	if (absent.length === 0) return { state: "ok" };
	return {
		state: "stale",
		reason:
			`类路径清单 ${ctx.layout.javacArgs} 里没有 ${absent.map((m) => `${m.name} 的 class 目录 ${m.out}`).join("、")}` +
			"（工程换过目录、连 build 目录一起拷过来，或者代码模块变过之后没重新生成）",
	};
}

/**
 * Builds when the artifacts are missing or no longer describe this project.
 *
 * A regeneration forced by a stale classpath is checked once more afterwards: if
 * Gradle's own output directory for a module is not the one fast compiles into,
 * regenerating again would change nothing, and every later call would pay minutes
 * of Gradle for the same answer. That is a project layout cosmic cannot run
 * against, so it is an error with the directory named, not a silent retry.
 */
export async function ensureBuilt(ctx: KernelContext, signal?: AbortSignal): Promise<KernelResult<BuildOutcome>> {
	const before = artifactState(ctx);
	if (before.state === "ok") {
		const launch = await refreshLaunchClasses(ctx);
		if (!launch.ok) return err(launch.error);
		return ok({
			ran: false,
			pathingJar: ctx.layout.pathingJar,
			javacArgs: ctx.layout.javacArgs,
			seconds: "0.0",
			out: "",
			reason: null,
		});
	}
	const built = await buildArtifacts(ctx, ctx.config.codeModules, signal);
	if (!built.ok || before.state === "missing") return built;
	return checkRegenerated(ctx, built.value, before.reason);
}

export interface LaunchRefresh {
	/** Debug-module sources that were newer than their .class and got compiled. */
	files: string[];
	/** One line for the run's notes. */
	note: string;
}

/**
 * Compiles the debug module when its sources are newer than its classes.
 *
 * Every probe JVM configures itself by running the project's launch class
 * (`appClass#appMethod`) from the compiled .class, so an edit to it -- a ZooKeeper
 * password added, `devRemote()` pointed at another environment -- takes effect only
 * once compiled. The debug module is not a code module (nothing deploys it), so the
 * business-class scan and `fast` never look at it; without this the edit was simply
 * ignored and every probe kept connecting with the old settings, with nothing saying so.
 *
 * The resident JVM read those settings once, at startup, so it is marked for restart
 * (hot-swapping the class would not re-run it). Nothing to do when the argfile does not
 * exist yet: the Gradle run that creates it compiles the debug module as well.
 */
export async function refreshLaunchClasses(ctx: KernelContext): Promise<KernelResult<LaunchRefresh | null>> {
	const launch = ctx.layout.launchModule;
	if (launch === null || !ctx.ports.fs.exists(ctx.layout.javacArgs)) return ok(null);
	const files = staleSourcesIn(ctx, launch);
	if (files.length === 0) return ok(null);
	const names = files.map((file) => relative(ctx.projectRoot, file).replace(/\\/g, "/"));
	const run = await runJavac(ctx, [
		"-encoding",
		"UTF-8",
		`@${ctx.layout.javacArgs}`,
		"-nowarn",
		"-sourcepath",
		launch.src,
		"-d",
		launch.out,
		...files,
	]);
	if (run.status !== 0) {
		return err(
			new KernelError("COMPILE_FAILED", `启动类所在的 ${launch.name} 编译失败`, {
				detail: { stage: "launch-classes", module: launch.name, files: names, raw: run.out.trim().slice(0, 8000) },
				remedy: "按 javac 原文改启动类：探针照它连环境，编不过就连不上。",
			}),
		);
	}
	if ((await ping(ctx)).ok && isOwnLiveServer(ctx, readManifest(ctx))) {
		markServerStale(ctx, `启动类改过（${names.join("、")}），环境配置要重起才用上`);
	}
	return ok({ files, note: `启动类所在的 ${launch.name} 改过，已重新编译：${names.join("、")}` });
}

/** After a stale classpath was regenerated: it must now list every module, and the resident JVM must not keep the old one. */
export function checkRegenerated(ctx: KernelContext, built: BuildOutcome, reason: string): KernelResult<BuildOutcome> {
	const after = artifactState(ctx, readGradleModuleDirs(ctx.projectRoot, ctx.ports.fs));
	if (after.state !== "ok") {
		return err(
			new KernelError("BUILD_FAILED", "重新生成类路径清单之后，里面还是没有代码模块的 class 目录", {
				detail: {
					stage: "pathing-jar",
					before: reason,
					after: after.state === "stale" ? after.reason : after.state,
				},
				remedy:
					"类路径清单和模块目录清单（build/cosmic-modules.json）是同一次 Gradle 运行写的，按理一致。" +
					"看 detail.after 里缺的是哪个模块：多半是 codeModules / extraCodeModules 里写了调试模块并不依赖的模块，" +
					"用 cosmic_doctor action=config 改掉它，或者在调试模块的构建脚本里加上对它的依赖。",
			}),
		);
	}
	markServerStale(ctx, `类路径清单重新生成过：${reason}`);
	return ok({ ...built, reason });
}

/**
 * JDK 8's ToolProvider.getSystemJavaCompiler() finds the compiler at
 * java.home/../lib/tools.jar. When the java on PATH comes from a standalone JRE
 * that path does not exist, so the resident host has to be handed tools.jar
 * explicitly. The cold path is unaffected -- it runs the javac executable.
 */
export async function findToolsJar(ctx: KernelContext): Promise<string | null> {
	const candidates: string[] = [];
	const javaHome = ctx.env.JAVA_HOME;
	if (javaHome) {
		const configured = join(javaHome, "lib", "tools.jar");
		if (ctx.ports.fs.exists(configured)) return configured;
		candidates.push(configured);
	}
	const which = await ctx.ports.proc.runAsync({
		command: ctx.platform === "win32" ? "where" : "which",
		args: ["javac"],
		cwd: ctx.projectRoot,
		env: baseChildEnv(ctx),
	});
	const bin = (which.stdout.split(/\r?\n/)[0] ?? "").trim();
	if (bin) candidates.push(join(bin, "..", "..", "lib", "tools.jar"));
	for (const candidate of candidates) {
		if (ctx.ports.fs.exists(candidate)) return candidate;
	}
	return null;
}

export const classpathOf = (...entries: string[]): string => entries.join(delimiter);
