/**
 * deploy -- copy the compiled jars into the runtime's lib/cus (S5.4).
 *
 * This is the command the frozen driver warns about in the moment it runs: three
 * to four minutes, and the node has to restart before any of it takes effect.
 * Those warnings are kept, as notes on the result rather than console lines,
 * because the reason they exist is that the alternative is cheaper and better
 * for the job people usually reach for `deploy` to do:
 *
 *   - verifying plugin logic is `fast` (~40s), not deploy;
 *   - moving a requirement to ACCEPTED is the user testing and saying so, not a
 *     jar arriving in a directory.
 *
 * Three things this adds to the frozen behaviour:
 *
 *   1. It takes the project write lock. `:module:deployJar` builds into the same
 *      tree `fast` compiles into, so the reason the explicit build (S11:
 *      `cosmic_doctor action=rebuild`) takes the lock
 *      (docs/command-parity.md §8.3) applies here word for word.
 *   2. Taking down the resident JVM respects ownership. The frozen version
 *      pinged and restarted whatever answered; under D10 a JVM this context
 *      cannot prove is its own is reported and left alone, because on this
 *      machine it belongs to another project.
 *   3. That outcome is a field. "deploy succeeded but the resident JVM still
 *      holds the old business classes" is the failure the stop exists to
 *      prevent, and it is invisible in prose.
 *   4. It stops that JVM without starting a replacement (R6). Deploy changes
 *      the RuntimeKey, so anything started here is born unreachable; see
 *      stopStaleResident().
 *
 * What it deliberately does NOT do is go through the confirmed-target admission
 * in policy/shared-write.ts. That check is about metadata objects in the shared
 * database -- entities, fields, templates, BOTP rules -- and its allow list is a
 * list of such objects; deploy writes none. It copies the user's own compiled
 * jars into the runtime directory named by `cosmicHome`, a different resource
 * domain with a different control: the project write lock, plus the fact that
 * nothing calls deploy implicitly. Registered in docs/command-parity.md §9.2 so
 * that a later reader can see the boundary was drawn on purpose rather than
 * forgotten.
 */

import { requireRuntime } from "../config/load-config.ts";
import type { KernelContext } from "../context.ts";
import { err, KernelError, type KernelResult, ok } from "../errors.ts";
import { withProjectWriteLock } from "../policy/project-write-lock.ts";
import { isOwnLiveServer, ping, readManifest, stopServer } from "../probe/server.ts";
import { runGradlew } from "../toolchain.ts";
import { selectModules } from "./build.ts";

export interface DeployReport {
	/** Modules `:module:deployJar` ran for. */
	modules: string[];
	/** True when the caller narrowed the scope. */
	scoped: boolean;
	seconds: string;
	/** Where the jars landed, as far as the config knows. */
	libCus: string | null;
	/**
	 * What happened to the resident probe JVM.
	 *
	 *   stopped     -- it was ours and now it is down; the next command starts a
	 *                  fresh one under the new RuntimeKey (see R6 below)
	 *   foreign     -- something answered but is not ours; untouched
	 *   not-running -- nothing was up, nothing to do
	 *
	 * There is deliberately no `restarted`: deploy never leaves a resident JVM
	 * running. See stopStaleResident().
	 */
	resident: "stopped" | "foreign" | "not-running";
	out: string;
	notes: string[];
}

export interface DeployOptions {
	/** Code modules to deploy. Empty or omitted means all of them. */
	modules?: readonly string[];
}

export async function deploy(ctx: KernelContext, options: DeployOptions = {}): Promise<KernelResult<DeployReport>> {
	const incomplete = requireRuntime(ctx.config);
	if (incomplete !== null) return err(incomplete);

	const scope = selectModules(ctx, options.modules);
	if (!scope.ok) return err(scope.error);
	const modules = scope.value;
	const scoped = (options.modules ?? []).length > 0;

	return withProjectWriteLock(ctx, "deploy", async () => {
		const started = ctx.ports.clock.now();
		const run = await runGradlew(ctx, [...modules.map((name) => `:${name}:deployJar`), "--offline"]);
		if (run.status !== 0) {
			return err(
				new KernelError("DEPLOY_FAILED", `gradlew :${modules.join(" :")}:deployJar 失败（退出码 ${run.status}）`, {
					detail: { modules, status: run.status, raw: run.out.trim().slice(0, 8000) },
					remedy: "看下面的 Gradle 原文；离线构建缺依赖时先联网跑一次 gradlew build。",
				}),
			);
		}

		const notes: string[] = [
			"deploy 是本机节点的部署动作（3~4 分钟，还要重启节点才生效），只在用户明确要求时跑。",
			"验插件逻辑用 cosmic_fast（约 40 秒）；想把需求推成 ACCEPTED 也不靠它——准入是用户测完主动通知，不是 jar 到没到位。",
		];
		// Deploying all modules is the right default -- one missing shared module is a
		// NoClassDefFoundError on the node -- but "all" has to be visible, or nobody
		// knows how much this command just touched.
		notes.push(
			`本次部署 ${modules.join(" / ")}${scoped ? "（modules 缩过范围）" : "（全部代码模块，只部一个就给 modules）"}`,
		);

		const resident = await stopStaleResident(ctx, notes);
		return ok({
			modules: [...modules],
			scoped,
			seconds: ((ctx.ports.clock.now() - started) / 1000).toFixed(1),
			libCus: ctx.config.cosmicHome === null ? null : `${ctx.config.cosmicHome}/mservice-cosmic/lib/cus`,
			resident,
			out: run.out.trim(),
			notes,
		});
	});
}

/**
 * Stops the resident probe JVM, which has the pre-deploy business classes
 * loaded. It stops it and does NOT start a replacement.
 *
 * Stopping is not optional: the deploy plainly succeeded, so without this the
 * next probe reaches the OLD implementation and reports it as the new one --
 * the same family as the classpath-order trap and more hidden than it.
 *
 * Not restarting is the correction to R6 (docs/command-parity.md §9.6), found
 * on a real machine. The jar deploy just replaced lives inside the Cosmic
 * runtime directory, and one of RuntimeKey's four components is that runtime's
 * fingerprint -- measured across a real deploy, `cosmicRuntime.hash` was the
 * ONLY component that changed. This function runs in the old key's context
 * (`ctx` was built before gradle wrote `lib/cus`), so a JVM started here is
 * born unreachable: the next command computes the new key, and the new context
 * neither reads that manifest (it sits in the old key's cache directory) nor
 * connects to its port (ports are derived from the key). Nobody claims it,
 * `stop` reports absent while it is still resident in memory, and every deploy
 * leaks one more.
 *
 * Starting it was pointless work even when it did get claimed -- the classes it
 * would load are already stale relative to the jar just deployed. So the start
 * belongs to the next command, which does it under the new key as a matter of
 * course. The price is that the first probe after a deploy is always cold, and
 * that price was already being paid: the new key's cache directory is empty
 * regardless of what this function does.
 *
 * D10 is not at fault for the leak and this change does not weaken it: the
 * orphan was never killed by port, and still is not.
 */
async function stopStaleResident(ctx: KernelContext, notes: string[]): Promise<DeployReport["resident"]> {
	const alive = await ping(ctx);
	if (!alive.ok) return "not-running";
	if (!isOwnLiveServer(ctx, readManifest(ctx))) {
		notes.push(
			"端口上有常驻 JVM 应答，但没有本 RuntimeKey 的 pid 记录：没有动它。本工程下一次 probe 会走冷进程，看到的是新 jar。",
		);
		return "foreign";
	}
	const stopped = await stopServer(ctx);
	notes.push(
		`常驻 JVM 里的业务类已过期，已停止（${stopped.how}${stopped.pid === null ? "" : ` pid=${stopped.pid}`}）。` +
			"不在这里重启是故意的：deploy 换掉的 jar 就在苍穹运行时目录里，RuntimeKey 随之改变，" +
			"在旧 key 下起的 JVM 下一条命令就认不出来（R6）。下一条命令会在新 key 下自然起一个，" +
			"代价是 deploy 后第一次探针必然全冷。",
	);
	return "stopped";
}
