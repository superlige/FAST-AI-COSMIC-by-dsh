import type { KernelContext } from "../context.ts";
import { jvmDeps, verifyRecordedPid } from "./local-jvms.ts";
import { decodeResponse } from "./protocol.ts";
import { readManifest, residentPort, type ServerManifest, staleServerIdentity } from "./server.ts";

/** 心跳不答时核对过的结论，一分钟内不重查：查进程清单要起一个系统命令，底栏三秒问一次。 */
const TAKEN_RECHECK_MS = 60_000;
const takenChecks = new Map<string, { taken: boolean; at: number }>();

/**
 * 登记里的进程号还活着、心跳却不答：可能是服务卡住或还在起，也可能这个号早已被系统分给了别的程序
 * （服务被手动结束过）。后者底栏该说「未启动」，而不是让人一直等一个不存在的服务回话。
 */
async function pidTaken(ctx: KernelContext, manifest: ServerManifest): Promise<boolean> {
	const key = `${String(manifest.pid)}|${manifest.keyId}|${manifest.startedAt}`;
	const now = Date.now();
	const known = takenChecks.get(key);
	if (known !== undefined && now - known.at < TAKEN_RECHECK_MS) return known.taken;
	const verdict = await verifyRecordedPid(jvmDeps(ctx), {
		kind: "probe",
		pid: manifest.pid,
		keyId: manifest.keyId,
		recordFile: ctx.layout.serverPid,
		projectRoot: ctx.projectRoot,
	});
	const taken = verdict === "other" || verdict === "gone";
	if (takenChecks.size > 32) takenChecks.clear();
	takenChecks.set(key, { taken, at: now });
	return taken;
}

export type LocalServiceKind =
	| "checking"
	| "stopped"
	| "stopping"
	| "starting"
	| "warming"
	| "ready"
	| "executing"
	| "pending-sync"
	| "syncing"
	| "restart-needed"
	| "restarting"
	| "unresponsive"
	| "unhealthy"
	| "foreign";

export interface LocalServiceStatus {
	kind: LocalServiceKind;
	pid: number | null;
	detail: string | null;
	/** 本机另外还开着几个 cosmic JVM（别的版本、别的工程、调试节点）；0 或不写就是没有。 */
	others?: number;
	/** 执行中走到哪一步：先编译探针、再运行。旧宿主不报，就不写。 */
	step?: "compile" | "run";
}

function fields(text: string): Map<string, string> {
	return new Map(
		text
			.trim()
			.split(/\r?\n/)
			.map((line) => {
				const at = line.indexOf("=");
				return [line.slice(0, at), line.slice(at + 1)];
			}),
	);
}

/** 只观察，不启动、不换类、不清标记；旧宿主没有心跳时也不借用昂贵的 PING。 */
export async function localServiceHealth(ctx: KernelContext): Promise<LocalServiceStatus> {
	const manifest = readManifest(ctx);
	const status = (kind: LocalServiceKind, detail: string | null = null): LocalServiceStatus => ({
		kind,
		pid: manifest?.pid ?? null,
		detail,
	});
	if (manifest === null) return status("stopped");
	if (manifest.keyId !== ctx.runtimeKeyId || manifest.port !== residentPort(ctx))
		return status("foreign", "服务不属于当前工程");
	if (!ctx.ports.proc.isAlive(manifest.pid)) return status("stopped");
	const mismatch = staleServerIdentity(ctx, manifest);
	if (mismatch !== null) return status("restart-needed", mismatch);
	const endpoint = fields(ctx.ports.fs.read(`${ctx.layout.serverPid}.health`));
	const port = Number(endpoint.get("port"));
	if (
		endpoint.get("key") !== ctx.runtimeKeyId ||
		endpoint.get("pid") !== String(manifest.pid) ||
		!Number.isInteger(port) ||
		port < 1 ||
		port > 65535
	)
		return (await pidTaken(ctx, manifest))
			? status("stopped")
			: status("unresponsive", "进程存活，尚未取得心跳；旧版服务需重启");
	const reply = await ctx.ports.net.request(port, ["HEALTH"], 1000);
	// 请求途中服务可能已经退出或被替换，不接纳过时的绿灯。
	const latest = readManifest(ctx);
	if (
		latest?.pid !== manifest.pid ||
		latest?.keyId !== manifest.keyId ||
		latest?.startedAt !== manifest.startedAt ||
		!ctx.ports.proc.isAlive(manifest.pid)
	)
		return status("unresponsive", "服务发生切换，等待新心跳");
	if (!reply.ok)
		return (await pidTaken(ctx, manifest)) ? status("stopped") : status("unresponsive", "进程存活，心跳未响应");
	const decoded = decodeResponse(reply.text);
	if (!decoded.ok || decoded.value.status !== "OK") return status("unresponsive", "心跳答复不完整");
	const body = fields(decoded.value.body);
	if (
		body.get("key") !== ctx.runtimeKeyId ||
		body.get("pid") !== String(manifest.pid) ||
		body.get("account") !== ctx.config.account ||
		body.get("user") !== ctx.config.user
	)
		return status("foreign", "心跳身份与当前工程不符");
	const kind = body.get("state");
	if (
		kind !== "starting" &&
		kind !== "warming" &&
		kind !== "ready" &&
		kind !== "executing" &&
		kind !== "syncing" &&
		kind !== "unhealthy"
	)
		return status("unresponsive", "无法识别服务状态");
	if (kind === "ready" && ctx.ports.fs.exists(ctx.layout.serverStale)) {
		const marks = ctx.ports.fs.read(ctx.layout.serverStale).trim().split(/\r?\n/);
		return status(marks.every((line) => /^\S+\s+\[类\] /.test(line)) ? "pending-sync" : "restart-needed");
	}
	const step = body.get("step");
	if (kind === "executing" && (step === "compile" || step === "run")) return { ...status(kind), step };
	return status(kind);
}
