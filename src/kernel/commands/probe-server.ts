/**
 * probe-server -- explicit lifecycle for the resident probe JVM (S5.2).
 *
 * `probe` already starts one on demand and falls back to the cold path when it
 * cannot, so this command is not how the JVM normally comes up. It exists for
 * the three things the automatic path deliberately does not do:
 *
 *   - pay the ~30-40s start once, up front, before a batch of hot probes;
 *   - stop it, which is the only way to release the Cosmic connection and the
 *     ~2 GB it holds without killing a pid by hand;
 *   - answer "is one running, and is it mine", which is the question behind
 *     every "why did that probe go cold" report.
 *
 * Ownership is the whole of the identity story here (D10). A JVM answering on
 * this RuntimeKey's port is not proof of anything: one started for another
 * project replies with an equally well-formed RESULT line while running against
 * different Cosmic JARs. So `status` reports what the pid manifest says, and
 * `stop` refuses to touch a manifest naming another RuntimeKey -- never killing
 * by port, because on this machine that pid may already belong to something
 * else entirely.
 */

import type { KernelContext } from "../context.ts";
import { err, type KernelResult, ok } from "../errors.ts";
import { localServiceHealth } from "../probe/health.ts";
import { isOwnLiveServer, ping, readManifest, residentPort, startServer, stopServer } from "../probe/server.ts";

export const PROBE_SERVER_ACTIONS = ["start", "stop", "status", "restart"] as const;
export type ProbeServerAction = (typeof PROBE_SERVER_ACTIONS)[number];

export interface ProbeServerReport {
	action: ProbeServerAction;
	/** True when something answered PING on this RuntimeKey's port. */
	running: boolean;
	/**
	 * Whether the answering JVM could be proved to be this context's.
	 *
	 *   own      -- a live pid manifest with this RuntimeKey's id
	 *   foreign  -- a manifest naming another RuntimeKey
	 *   unknown  -- something is listening and nothing proves whose it is
	 *   absent   -- nothing is listening
	 */
	ownership: "own" | "foreign" | "unknown" | "absent";
	port: number;
	pid: number | null;
	/**
	 * 端口这一刻不答、心跳口却答得上时，它在干什么：`starting` 还在启动、端口没开；`busy` 正在跑别的请求
	 * （一次只答一个）。端口答得上、或者心跳也问不到，就不写。
	 */
	state?: "starting" | "busy";
	/** How a stop ended, when the action was stop or restart. */
	stopped?: "graceful" | "forced" | "absent" | "foreign" | "unverified";
	/** Seconds waited for a start to answer PING. */
	waitedSeconds?: number;
	/** The server's own PING body -- what it thinks it has loaded. */
	detail: string;
	logFile: string;
	notes: string[];
}

async function observe(ctx: KernelContext): Promise<{
	running: boolean;
	ownership: ProbeServerReport["ownership"];
	pid: number | null;
	state?: ProbeServerReport["state"];
	detail: string;
}> {
	// 先问端口再读登记：答话的进程报的是本版本时，问的那一下会把登记对上。
	const alive = await ping(ctx);
	const manifest = readManifest(ctx);
	if (!alive.ok) {
		// 端口不答不等于没在跑：还在启动时端口没开，正跑着一个请求时顾不上答第二个。心跳口不走请求队列，
		// 这两种时候照样答；它答得上、身份也对，就照实说，不把一个活着的进程报成「没在跑」。
		const health = await localServiceHealth(ctx);
		if (health.kind === "starting" || health.kind === "warming") {
			return { running: false, ownership: "absent", pid: health.pid, state: "starting", detail: alive.why ?? "" };
		}
		if (health.kind === "executing" || health.kind === "syncing") {
			return { running: true, ownership: "own", pid: health.pid, state: "busy", detail: alive.why ?? "" };
		}
		// A manifest with nothing listening is residue, not a running server. Saying
		// "running" here is how a caller ends up waiting on a JVM that died.
		return { running: false, ownership: "absent", pid: manifest?.pid ?? null, detail: alive.why ?? "" };
	}
	if (isOwnLiveServer(ctx, manifest)) {
		return { running: true, ownership: "own", pid: manifest?.pid ?? null, detail: alive.body.trim() };
	}
	if (manifest !== null && manifest.keyId !== ctx.runtimeKeyId) {
		return { running: true, ownership: "foreign", pid: manifest.pid, detail: alive.body.trim() };
	}
	return { running: true, ownership: "unknown", pid: null, detail: alive.body.trim() };
}

function base(ctx: KernelContext, action: ProbeServerAction): Pick<ProbeServerReport, "action" | "port" | "logFile"> {
	return { action, port: residentPort(ctx), logFile: ctx.layout.serverLog };
}

export async function probeServer(
	ctx: KernelContext,
	action: ProbeServerAction = "status",
): Promise<KernelResult<ProbeServerReport>> {
	if (action === "status") {
		const seen = await observe(ctx);
		const notes: string[] = [];
		if (seen.state === "starting") {
			notes.push("常驻 JVM 正在启动，端口还没开（约半分钟）。这时发探针会等它起好，不会另起一个。");
		} else if (seen.state === "busy") {
			notes.push("常驻 JVM 在跑，正在执行别的请求，这一刻没空答话；它一次只跑一个请求，后来的排队。");
		} else if (!seen.running) notes.push("常驻 JVM 没在跑。probe 会按需自动拉起，也可以显式 start。");
		if (seen.ownership === "foreign") {
			notes.push("端口上那个 JVM 属于别的 RuntimeKey：本工程的 probe 会走冷进程，stop 也不会去动它。");
		}
		if (seen.ownership === "unknown") {
			notes.push("端口上有 JVM 应答，但没有本 RuntimeKey 的 pid 记录，认不出归属：probe 会走冷进程。");
		}
		return ok({ ...base(ctx, action), ...seen, notes });
	}

	if (action === "stop") {
		const outcome = await stopServer(ctx);
		const seen = await observe(ctx);
		const notes: string[] = [];
		if (outcome.how === "foreign") {
			notes.push("pid 记录属于别的 RuntimeKey，没有动它——本进程不终止证明不了归属的 JVM。");
		}
		if (outcome.how === "absent") notes.push("本来就没有在跑的常驻 JVM。");
		if (outcome.how === "unverified") {
			notes.push("常驻 JVM 没回应，本机进程清单也查不了，证明不了登记里的进程号还是它，没有动它。");
		}
		return ok({ ...base(ctx, action), ...seen, stopped: outcome.how, notes });
	}

	const notes: string[] = [];
	let stopped: ProbeServerReport["stopped"];
	if (action === "restart") {
		const outcome = await stopServer(ctx);
		stopped = outcome.how;
		if (outcome.how === "foreign") {
			// Starting now would only race the foreign JVM for the port and then be
			// refused by startServer's ownership check, with a less clear message.
			const seen = await observe(ctx);
			notes.push("端口上那个 JVM 属于别的 RuntimeKey，没有停它，也就没有重启。");
			return ok({ ...base(ctx, action), ...seen, stopped, notes });
		}
	}

	const started = await startServer(ctx);
	if (!started.ok) return err(started.error);
	const seen = await observe(ctx);
	if (!started.value.started) notes.push("常驻 JVM 已经在跑，没有重复拉起。");
	return ok({
		...base(ctx, action),
		...seen,
		...(stopped === undefined ? {} : { stopped }),
		waitedSeconds: started.value.waitedSeconds,
		pid: started.value.pid ?? seen.pid,
		notes,
	});
}
