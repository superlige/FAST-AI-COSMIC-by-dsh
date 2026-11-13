/**
 * build -- produce the pathing jar and the javac argfile (S5.2).
 *
 * Until now this existed only as `ensureBuilt`, called from inside lint / fast /
 * probe / sig. That covers "somebody needs it and it is missing", but not the
 * two cases a caller actually reaches for `build` in:
 *
 *   - the artefacts exist and are wrong. Dependencies changed, a module was
 *     added, the runtime moved. `ensureBuilt` regenerates on its own only when
 *     the argfile no longer lists every code module's class directory (a moved
 *     or copied project); a changed dependency it cannot see, and the next
 *     NoClassDefFoundError names a business class rather than anything that
 *     points at a stale classpath. `force` is the answer, and it is the reason
 *     this command is not just `ensureBuilt` with a nicer name.
 *   - narrowing to one module during a long edit loop.
 *
 * The module scope narrows `:module:build` only. **The pathing jar still
 * compiles every code module's classes** -- one module missing from the probe
 * classpath is a NoClassDefFoundError, so that step is never narrowed. The
 * frozen driver printed a line saying so; here it is a note on the result,
 * because a caller that reads results and not stdout would otherwise never
 * learn that its `--module` did less than it looks like.
 */

import type { KernelContext } from "../context.ts";
import { err, KernelError, type KernelResult, ok } from "../errors.ts";
import { withProjectWriteLock } from "../policy/project-write-lock.ts";
import { markServerStale } from "../probe/server.ts";
import { artifactState, type BuildOutcome, buildArtifacts, checkRegenerated } from "../toolchain.ts";

export interface BuildOptions {
	/**
	 * Code modules to narrow `:module:build` to. Empty or omitted means all of
	 * them. Names are validated against the configured set; an unknown one is
	 * refused rather than skipped, because a silent skip is "build succeeded and
	 * that module was never compiled".
	 */
	modules?: readonly string[];
	/** Rebuild even when the artefacts are already present. */
	force?: boolean;
	/** Internal cancellation signal supplied by the interactive tool host. */
	signal?: AbortSignal;
	/**
	 * 交互界面用的进度回调。只在真要跑 Gradle 时叫一次——产物齐全的那条路是两次
	 * exists 检查，报一个瞬间就过去的段名只会让进度行闪一下。
	 */
	onProgress?: () => void;
}

export interface BuildReport extends BuildOutcome {
	/** Modules `:module:build` ran for. */
	modules: string[];
	/** True when the caller narrowed the scope. */
	scoped: boolean;
	notes: string[];
}

/** Validates a requested module scope against the configured code modules. */
export function selectModules(ctx: KernelContext, requested: readonly string[] = []): KernelResult<string[]> {
	const wanted = requested.map((name) => name.trim().replace(/^:+/, "")).filter((name) => name !== "");
	if (wanted.length === 0) return ok([...ctx.config.codeModules]);
	const bad = wanted.filter((name) => !ctx.config.codeModules.includes(name));
	if (bad.length > 0) {
		return err(
			new KernelError("MODULE_SCOPE_INVALID", `不是已配置的代码模块：${bad.join(", ")}`, {
				detail: { requested: wanted, bad, configured: [...ctx.config.codeModules] },
				remedy: `已配置的代码模块：${ctx.config.codeModules.join(" / ")}。名字拼错时不会静默跳过——那等于「build 说成功了但那个模块没编」。`,
			}),
		);
	}
	// Deduplicated, and in the configured order: two callers asking for the same
	// two modules in different orders must produce the same gradle invocation.
	return ok(ctx.config.codeModules.filter((name) => wanted.includes(name)));
}

/**
 * The explicit entry point, and therefore the one that takes the project write
 * lock (S4.3 row 5).
 *
 * gradle `:module:build` and the pathing jar write build/classes, cosmic-pathing.jar
 * and cosmic-javac.args -- the same tree `fast` compiles into and the same argfile
 * every other command reads. Without the lock, "gradle rewrites the argfile while
 * fast is compiling against it" is a real interleaving that produces a green
 * compile against a classpath that no longer exists.
 *
 * The lock is taken HERE and not in `buildArtifacts`, because `ensureBuilt` is
 * called from inside `fast` and the applying/rolling-back `probe`, which already
 * hold it -- the lock is not reentrant, so locking the shared helper would
 * deadlock the common path. The remaining unlocked callers (`lint`, a read-only
 * `probe`) only reach gradle when the artefacts are MISSING, and gradle's own
 * project lock serialises that first build; registered in docs/S5-commands.md
 * rather than papered over.
 */
export async function build(ctx: KernelContext, options: BuildOptions = {}): Promise<KernelResult<BuildReport>> {
	const scope = selectModules(ctx, options.modules);
	if (!scope.ok) return err(scope.error);
	const modules = scope.value;
	const scoped = (options.modules ?? []).length > 0;

	return withProjectWriteLock(ctx, options.force === true ? "build:force" : "build", async () =>
		runBuild(ctx, options, modules, scoped),
	);
}

async function runBuild(
	ctx: KernelContext,
	options: BuildOptions,
	modules: readonly string[],
	scoped: boolean,
): Promise<KernelResult<BuildReport>> {
	const before = artifactState(ctx);
	const running = options.force === true || before.state !== "ok";
	if (running) options.onProgress?.();
	const built = running
		? await buildArtifacts(ctx, modules, options.signal)
		: ok({
				ran: false,
				pathingJar: ctx.layout.pathingJar,
				javacArgs: ctx.layout.javacArgs,
				seconds: "0.0",
				out: "",
				reason: null,
			} satisfies BuildOutcome);
	if (!built.ok) return err(built.error);
	const outcome = before.state === "stale" ? checkRegenerated(ctx, built.value, before.reason) : built;
	if (!outcome.ok) return err(outcome.error);
	// A forced regeneration can change the classpath just as much; the JVM on the port still has the old one.
	if (before.state === "ok" && running) markServerStale(ctx, "类路径清单按要求重新生成过");

	const notes: string[] = [];
	if (outcome.value.reason !== null) notes.push(`重新生成了类路径清单：${outcome.value.reason}。`);
	if (!outcome.value.ran) {
		notes.push("pathing jar 和 argfile 都在、列着全部代码模块，没有重新构建；依赖变过就用 force。");
	}
	if (scoped && modules.length < ctx.config.codeModules.length) {
		notes.push(
			`只 build 了 ${modules.join(" / ")}；pathing jar 仍会编齐所有代码模块的 classes（classpath 少一个就跑不起来）。`,
		);
	}
	if (scoped && options.force !== true) {
		// Otherwise "I narrowed to one module and it still took no time" reads as
		// evidence the narrowing worked, when nothing ran at all.
		notes.push("模块范围只在真正跑构建时才起作用；产物已存在时本次没有构建。");
	}
	return ok({ ...outcome.value, modules: [...modules], scoped, notes });
}
