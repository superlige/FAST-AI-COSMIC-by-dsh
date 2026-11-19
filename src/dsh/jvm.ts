/**
 * `/cosmic-jvm`：本机 cosmic 开着的苍穹进程，文字版。
 *
 *   /cosmic-jvm            列出常驻 JVM 和本地调试节点：几个、哪个工程、占多少内存、什么状态、多久没用了；
 *   /cosmic-jvm stop <pid> 停掉其中一个（先请它自己退，退不了再强停）。只停列表里认得的，别的 java 进程不碰。
 *
 * 常驻 JVM 空闲 30 分钟自己退；同一工程开了新版本，旧的空闲两分钟后被停。手动停是给「内存吃紧、
 * 或者某个进程卡死」用的。
 */

import type { JvmScan, LocalJvm } from "../kernel/probe/local-jvms.ts";

const KIND_TEXT = { probe: "常驻 JVM", node: "本地调试节点" } as const;

const STATE_TEXT: Record<LocalJvm["state"], string> = {
	ready: "空闲",
	executing: "正在跑",
	starting: "启动中",
	warming: "预热中",
	syncing: "同步代码中",
	unhealthy: "不健康",
	unresponsive: "进程在、心跳不答",
};

function memory(bytes: number | null): string {
	if (bytes === null) return "内存未知";
	return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

function ago(ms: number | null, nowMs: number): string {
	if (ms === null) return "未知";
	const minutes = Math.max(0, Math.round((nowMs - ms) / 60_000));
	if (minutes < 1) return "刚刚";
	if (minutes < 60) return `${String(minutes)} 分钟前`;
	return `${(minutes / 60).toFixed(1)} 小时前`;
}

function sameRoot(a: string | null, b: string | undefined): boolean {
	if (a === null || b === undefined) return false;
	const norm = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
	return norm(a) === norm(b);
}

/** 列表文字：每个进程一行，本会话工程的标「本会话」，最后一行报数（0 也报）。 */
export function jvmListText(scan: JvmScan, currentRoot: string | undefined, nowMs: number): string {
	const lines: string[] = [];
	const probes = scan.jvms.filter((jvm) => jvm.kind === "probe").length;
	const nodes = scan.jvms.length - probes;
	const total = scan.jvms.reduce((sum, jvm) => sum + (jvm.memoryBytes ?? 0), 0);
	lines.push(
		`本机 cosmic 进程：常驻 JVM ${String(probes)} 个，本地调试节点 ${String(nodes)} 个，共占 ${memory(total)}` +
			(scan.processesListed ? "" : "（没查到进程清单，只列心跳答得上的）"),
	);
	for (const jvm of scan.jvms) {
		const mine = sameRoot(jvm.projectRoot, currentRoot) ? "【本会话】" : "";
		lines.push(
			`- ${mine}${KIND_TEXT[jvm.kind]} pid ${String(jvm.pid)}：${jvm.projectRoot ?? "工程认不出来"}` +
				`${jvm.port === null ? "" : `，端口 ${String(jvm.port)}`}，${memory(jvm.memoryBytes)}，${STATE_TEXT[jvm.state]}` +
				`，上次用 ${ago(jvm.lastActiveMs, nowMs)}${jvm.keyId === null ? "" : `，版本 ${jvm.keyId}`}`,
		);
	}
	if (scan.staleRecords.length > 0) lines.push(`清掉失效登记 ${String(scan.staleRecords.length)} 条`);
	if (scan.jvms.length > 0) lines.push("", "停掉一个：/cosmic-jvm stop <pid>");
	return lines.join("\n");
}

/** 命令后面的文字：空的是列表，`stop 1234` 是停 1234，别的是写法不对。 */
export function parseJvmCommand(
	raw: string,
): { kind: "list" } | { kind: "stop"; pid: number } | { kind: "bad"; text: string } {
	const parts = raw.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) return { kind: "list" };
	if (parts[0] === "stop" && parts.length === 2 && /^\d+$/.test(parts[1] as string))
		return { kind: "stop", pid: Number(parts[1]) };
	return { kind: "bad", text: "用法：/cosmic-jvm 列出进程；/cosmic-jvm stop <pid> 停掉一个" };
}

const HOW_TEXT = {
	graceful: "已停（它自己退的）",
	forced: "已强停",
	gone: "它已经不在了",
	"not-ours": "这个进程号已经不是 cosmic 的进程，没停",
	unverified: "认不准是不是 cosmic 起的，没停",
} as const;

export function stopText(jvm: LocalJvm, how: keyof typeof HOW_TEXT): string {
	return `${KIND_TEXT[jvm.kind]} pid ${String(jvm.pid)}（${jvm.projectRoot ?? "工程认不出来"}）：${HOW_TEXT[how]}`;
}
