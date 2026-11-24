/**
 * node -- the local Cosmic debug node: start / status / logs / stop (S5.4).
 *
 * Four frozen commands, one tool, for the same reason `probe-server` folded
 * four: they are one object's lifecycle, and four names would cost four entries
 * in the resident system prompt to express one.
 *
 * This is a SECOND JVM, unrelated to the resident probe JVM. It runs the whole
 * node (`java -jar <pathing jar>`, ~4 GB, 60-90 seconds to boot) and serves
 * http://127.0.0.1:<debugPort>/ierp; the resident probe JVM runs probes and
 * answers a line protocol on a RuntimeKey-derived port. Conflating them is easy
 * from the outside and expensive: stopping the wrong one either drops a browser
 * session or throws away a warm metadata cache.
 *
 * Identity follows D10, which is the one substantive change from the frozen
 * implementation. The frozen pid file was a bare number in <root>/build, shared
 * by every runtime the project was ever opened against; here it is a manifest in
 * the RuntimeKey cache carrying the key id, and `stop` refuses a manifest naming
 * another key rather than killing the pid it finds. Nothing is ever killed by
 * port: on this machine that port may belong to something else entirely.
 *
 * The listen port itself stays `config.debugPort`, NOT derived from the
 * RuntimeKey the way the probe server's is. The number is in the URL a person
 * opens in a browser; deriving it would make that URL unpredictable, and the
 * ownership question is already answered by the manifest.
 */

import { requireRuntime } from "../config/load-config.ts";
import { baseChildEnv, type KernelContext, productJvmOptions, userJvmArgs } from "../context.ts";
import { err, KernelError, type KernelResult, ok } from "../errors.ts";
import { jvmDeps, NODE_KEY_PROP, verifyRecordedPid } from "../probe/local-jvms.ts";
import { ensureBuilt } from "../toolchain.ts";

export const NODE_ACTIONS = ["start", "status", "logs", "stop"] as const;
export type NodeAction = (typeof NODE_ACTIONS)[number];

/** Cosmic takes 60-90s and OOMs while warming metadata on a smaller heap. */
const HEAP = "-Xmx4g";
const METASPACE = "-XX:MaxMetaspaceSize=512m";
const START_POLL_MS = 5_000;
const START_POLL_TIMES = 60;
const PORT_PROBE_MS = 1_500;
const DEFAULT_LOG_LINES = 40;

export interface NodeManifest {
	pid: number;
	/** RuntimeKey id this node was started for. A mismatch means "not mine". */
	keyId: string;
	port: number;
	startedAt: string;
}

export interface NodeReport {
	action: NodeAction;
	pid: number | null;
	/** True when the recorded pid names a live process. */
	alive: boolean;
	/** True when 127.0.0.1:<port> accepts a connection. */
	portOpen: boolean;
	port: number;
	/**
	 *   own      -- a live pid manifest carrying this RuntimeKey's id
	 *   foreign  -- a manifest naming another RuntimeKey
	 *   absent   -- no manifest, or a manifest whose pid is gone
	 */
	ownership: "own" | "foreign" | "absent";
	url: string;
	logFile: string;
	/** Seconds waited for the port to open, when the action was start. */
	waitedSeconds?: number;
	/** How a stop ended. "unverified": the recorded pid could not be proved to be the node, so nothing was killed. */
	stopped?: "killed" | "absent" | "foreign" | "unverified";
	/** Log tail, for `logs` and for a failed start. */
	log?: string;
	notes: string[];
}

export interface NodeOptions {
	/** Lines of log tail for `logs`. Frozen default is 40. */
	lines?: number;
}

export function readNodeManifest(ctx: KernelContext): NodeManifest | null {
	const raw = ctx.ports.fs.read(ctx.layout.debugPid);
	if (raw === "") return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed === null || typeof parsed !== "object") return null;
		const manifest = parsed as Partial<NodeManifest>;
		if (typeof manifest.pid !== "number" || typeof manifest.keyId !== "string") return null;
		return {
			pid: manifest.pid,
			keyId: manifest.keyId,
			port: typeof manifest.port === "number" ? manifest.port : 0,
			startedAt: typeof manifest.startedAt === "string" ? manifest.startedAt : "",
		};
	} catch {
		// A corrupt manifest is "no node of mine", never "the node is fine": the
		// opposite choice reclaims a pid it cannot identify.
		return null;
	}
}

function logTail(ctx: KernelContext, lines: number): string {
	return ctx.ports.fs.read(ctx.layout.debugLog).split(/\r?\n/).slice(-lines).join("\n");
}

async function observe(ctx: KernelContext): Promise<Pick<NodeReport, "pid" | "alive" | "portOpen" | "ownership">> {
	const manifest = readNodeManifest(ctx);
	const portOpen = await ctx.ports.net.canConnect(ctx.config.debugPort, PORT_PROBE_MS);
	if (manifest === null) return { pid: null, alive: false, portOpen, ownership: "absent" };
	const alive = ctx.ports.proc.isAlive(manifest.pid);
	if (manifest.keyId !== ctx.runtimeKeyId) {
		return { pid: manifest.pid, alive, portOpen, ownership: "foreign" };
	}
	return { pid: manifest.pid, alive, portOpen, ownership: alive ? "own" : "absent" };
}

function base(ctx: KernelContext, action: NodeAction): Pick<NodeReport, "action" | "port" | "url" | "logFile"> {
	return {
		action,
		port: ctx.config.debugPort,
		url: `http://127.0.0.1:${ctx.config.debugPort}/${ctx.config.tenant ?? "ierp"}`,
		logFile: ctx.layout.debugLog,
	};
}

export async function node(
	ctx: KernelContext,
	action: NodeAction = "status",
	options: NodeOptions = {},
): Promise<KernelResult<NodeReport>> {
	if (action === "status") {
		const seen = await observe(ctx);
		const notes: string[] = [];
		if (seen.ownership === "foreign") {
			notes.push("pid 记录属于别的 RuntimeKey：本工程既不报它的健康状态，也不会停它。");
		}
		if (!seen.alive && seen.portOpen) {
			notes.push(
				`端口 ${ctx.config.debugPort} 通着，但没有本 RuntimeKey 起的进程记录——多半是别处（IDE / 手工）起的节点。`,
			);
		}
		if (seen.alive && !seen.portOpen) notes.push("进程还活着但端口没通：还在启动中，或者启动失败了，看日志。");
		return ok({ ...base(ctx, action), ...seen, notes });
	}

	if (action === "logs") {
		const lines = Math.max(1, Math.trunc(options.lines ?? DEFAULT_LOG_LINES));
		const seen = await observe(ctx);
		if (!ctx.ports.fs.exists(ctx.layout.debugLog)) {
			return ok({
				...base(ctx, action),
				...seen,
				log: "",
				notes: [`还没有日志（${ctx.layout.debugLog} 不存在），先 start。`],
			});
		}
		return ok({
			...base(ctx, action),
			...seen,
			log: logTail(ctx, lines),
			notes: [
				// The node's own Cosmic logging goes elsewhere; saying so here saves the
				// "the log is empty so nothing ran" conclusion.
				`这是节点进程的 stdout/stderr（${lines} 行）。苍穹自己的日志由 logback 写在 <工程>/logs/ 下。`,
			],
		});
	}

	if (action === "stop") {
		const manifest = readNodeManifest(ctx);
		const before = await observe(ctx);
		if (manifest !== null && manifest.keyId !== ctx.runtimeKeyId) {
			return ok({
				...base(ctx, action),
				...before,
				stopped: "foreign",
				notes: ["pid 记录属于别的 RuntimeKey，没有动它——本进程不终止证明不了归属的节点。"],
			});
		}
		// 登记只记了进程号，号会被系统分给别的程序：核对过命令行是它才停（S53）。
		const verdict =
			manifest === null
				? "gone"
				: await verifyRecordedPid(jvmDeps(ctx), {
						kind: "node",
						pid: manifest.pid,
						keyId: manifest.keyId,
						recordFile: null,
						projectRoot: ctx.projectRoot,
					});
		if (verdict === "unknown" && manifest !== null) {
			return ok({
				...base(ctx, action),
				...before,
				stopped: "unverified",
				notes: [`查不了本机进程清单，证明不了 pid=${manifest.pid} 还是调试节点，没有动它。`],
			});
		}
		if (manifest === null || verdict !== "ours") {
			ctx.ports.fs.remove(ctx.layout.debugPid);
			const after = await observe(ctx);
			const notes = ["本工程没有在跑的调试节点。"];
			if (after.portOpen) {
				notes.push(`端口 ${ctx.config.debugPort} 仍然通着，但那不是本工程起的进程——按 D10 不按端口杀。`);
			}
			return ok({ ...base(ctx, action), ...after, stopped: "absent", notes });
		}
		// Cosmic forks dubbo/mq children; on Windows only taskkill /T collects them,
		// which is what ProcessPort.kill(pid, true) does.
		await ctx.ports.proc.kill(manifest.pid, true);
		ctx.ports.fs.remove(ctx.layout.debugPid);
		const after = await observe(ctx);
		return ok({ ...base(ctx, action), ...after, stopped: "killed", notes: [`已停止 pid=${manifest.pid}。`] });
	}

	return startNode(ctx);
}

async function startNode(ctx: KernelContext): Promise<KernelResult<NodeReport>> {
	const incomplete = requireRuntime(ctx.config);
	if (incomplete !== null) return err(incomplete);

	const existing = readNodeManifest(ctx);
	const existingVerdict =
		existing === null
			? "gone"
			: await verifyRecordedPid(jvmDeps(ctx), {
					kind: "node",
					pid: existing.pid,
					keyId: existing.keyId,
					recordFile: null,
					projectRoot: ctx.projectRoot,
				});
	// 号被别的程序占了的登记不算「在跑」；查不了进程清单时照旧按在跑算，宁可不起也不起两个。
	if (existing !== null && (existingVerdict === "ours" || existingVerdict === "unknown")) {
		if (existing.keyId !== ctx.runtimeKeyId) {
			return err(
				new KernelError("DEBUG_NODE_UNAVAILABLE", `调试节点 pid=${existing.pid} 属于别的 RuntimeKey`, {
					detail: { pid: existing.pid, recordedKeyId: existing.keyId, keyId: ctx.runtimeKeyId },
					remedy: "那是另一个工程/运行时起的节点，端口也是同一个。先在那边停掉它，再在这边 start。",
				}),
			);
		}
		const seen = await observe(ctx);
		return ok({ ...base(ctx, "start"), ...seen, notes: [`节点已在运行 pid=${existing.pid}，没有重复拉起。`] });
	}

	const built = await ensureBuilt(ctx);
	if (!built.ok) return err(built.error);

	const started = ctx.ports.proc.startDetached({
		command: "java",
		// 版本号只为认得出它（停之前核对身份、本地进程面板），苍穹不读。
		args: [
			...productJvmOptions(ctx.config, [HEAP, METASPACE]),
			"-Dfile.encoding=UTF-8",
			`${NODE_KEY_PROP}${ctx.runtimeKeyId}`,
			...userJvmArgs(ctx.config),
			"-jar",
			ctx.layout.pathingJar,
		],
		cwd: ctx.projectRoot,
		env: baseChildEnv(ctx),
		logFile: ctx.layout.debugLog,
	});
	if (started.pid === null) {
		return err(
			new KernelError("DEBUG_NODE_UNAVAILABLE", `调试节点起不来：${started.error ?? "未知原因"}`, {
				detail: { logFile: ctx.layout.debugLog },
				remedy: "确认 java 在 PATH 上，且 pathing jar 已经生成（cosmic_doctor action=rebuild force=true）。",
			}),
		);
	}
	// Written before the wait, for the same reason the probe server's is: a node
	// that boots slowly and is then abandoned must stay reclaimable by identity.
	ctx.ports.fs.write(
		ctx.layout.debugPid,
		JSON.stringify({
			pid: started.pid,
			keyId: ctx.runtimeKeyId,
			port: ctx.config.debugPort,
			startedAt: new Date(ctx.ports.clock.now()).toISOString(),
		} satisfies NodeManifest),
	);

	for (let i = 0; i < START_POLL_TIMES; i++) {
		await ctx.ports.clock.sleep(START_POLL_MS);
		if (await ctx.ports.net.canConnect(ctx.config.debugPort, PORT_PROBE_MS)) {
			const seconds = ((i + 1) * START_POLL_MS) / 1000;
			return ok({
				...base(ctx, "start"),
				pid: started.pid,
				alive: true,
				portOpen: true,
				ownership: "own",
				waitedSeconds: seconds,
				notes: [`就绪：http://127.0.0.1:${ctx.config.debugPort}/${ctx.config.tenant ?? "ierp"}（约 ${seconds}s）`],
			});
		}
		if (!ctx.ports.proc.isAlive(started.pid)) {
			return err(
				new KernelError("DEBUG_NODE_UNAVAILABLE", "调试节点进程已退出", {
					detail: { pid: started.pid, logFile: ctx.layout.debugLog, tail: logTail(ctx, DEFAULT_LOG_LINES) },
					remedy: "看日志尾部；节点起不来不影响 probe / fast，那两条路不经过它。",
				}),
			);
		}
	}
	return err(
		new KernelError("DEBUG_NODE_UNAVAILABLE", `等了 5 分钟端口 ${ctx.config.debugPort} 还没通`, {
			detail: { pid: started.pid, logFile: ctx.layout.debugLog, tail: logTail(ctx, DEFAULT_LOG_LINES) },
			remedy: "进程还活着但没监听：看日志尾部。节点没起来时 stop 会收掉它。",
		}),
	);
}
