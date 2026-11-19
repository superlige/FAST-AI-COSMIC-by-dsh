import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { node } from "../../src/kernel/commands/node.ts";
import {
	commandLineMatches,
	jvmDeps,
	PROBE_IDLE_EXIT_MS,
	PROBE_SERVER_MAIN,
	retireOldProbeServers,
	scanLocalJvms,
	stopLocalJvm,
} from "../../src/kernel/probe/local-jvms.ts";
import { residentServerArgs, stopServer } from "../../src/kernel/probe/server.ts";
import { type FakeContext, makeContext } from "./fake-context.ts";

/**
 * 本机 cosmic JVM 清单（S53）。真机上一份登记里的进程号后来成了 msedge：按号停进程之前必须核对身份，
 * 核对不了就不停；清单要把「登记还在、进程已经不是它」的那些认出来、清掉。
 */

const ROOT = "D:/cache";
const NOW = Date.parse("2026-10-09T04:00:00.000Z");
const MIN = 60_000;

interface Seed {
	key: string;
	pid: number;
	project?: string;
	opened?: number;
	healthPort?: number;
	state?: string;
	lastActive?: number;
	alive?: boolean;
	commandLine?: string | null;
}

/** 在缓存根下摆一个版本目录：身份文件、常驻探针服务的登记和心跳文件，按需让进程活着、心跳答话。 */
function seed(fake: FakeContext, s: Seed): void {
	const dir = `${ROOT}/${s.key}`;
	fake.fs.put(
		`${dir}/runtime-key.json`,
		JSON.stringify({
			schema: "cosmic.runtime-cache/1",
			keyId: s.key,
			parts: { project: { root: s.project ?? "D:/proj" } },
			writtenAt: new Date(s.opened ?? NOW - 60 * MIN).toISOString(),
		}),
	);
	const port = 41000 + s.pid;
	fake.fs.put(
		`${dir}/probe-server.pid`,
		JSON.stringify({ pid: s.pid, keyId: s.key, port, startedAt: "2026-10-09T03:00:00.000Z" }),
	);
	if (s.healthPort !== undefined)
		fake.fs.put(
			`${dir}/probe-server.pid.health`,
			`pid=${String(s.pid)}\nkey=${s.key}\nport=${String(s.healthPort)}\n`,
		);
	if (s.alive !== false) fake.proc.livePids.add(s.pid);
	const commandLine =
		s.commandLine === undefined ? `java -Xmx2g -Dprobe.runtimeKey=${s.key} -cp x CosmicProbeServer` : s.commandLine;
	if (s.alive !== false && commandLine !== null)
		fake.proc.extraJava?.push({ pid: s.pid, commandLine, memoryBytes: 600 * 1024 * 1024, startedAtMs: null });
}

/** 心跳和停止请求按端口答：心跳报登记的身份，停止请求让进程退出。 */
function answer(fake: FakeContext, seeds: Seed[]): void {
	fake.net.handler = (port, lines) => {
		for (const s of seeds) {
			if (s.healthPort === port && lines[0] === "HEALTH" && fake.proc.livePids.has(s.pid))
				return {
					ok: true,
					text: `RESULT OK 0\npid=${String(s.pid)}\nkey=${s.key}\nstate=${s.state ?? "ready"}\nlastActive=${String(s.lastActive ?? NOW - 10 * MIN)}\n`,
				};
			if (41000 + s.pid === port && lines[0] === "SHUTDOWN") {
				fake.proc.livePids.delete(s.pid);
				return { ok: true, text: "RESULT OK 0\n" };
			}
		}
		return { ok: false, why: "ECONNREFUSED" };
	};
}

function context(seeds: Seed[]): FakeContext {
	const fake = makeContext();
	for (const s of seeds) seed(fake, s);
	answer(fake, seeds);
	return fake;
}

describe("清单：登记和进程两边对照", () => {
	it("心跳答得上的列出来，进程不在的、号被别的程序占了的判成失效，没登记的 cosmic JVM 也认出来", async () => {
		const seeds: Seed[] = [
			{ key: "v-live", pid: 101, healthPort: 50101 },
			{ key: "v-dead", pid: 102, alive: false },
			{ key: "v-reused", pid: 8684, commandLine: "msedge.exe --type=renderer" },
		];
		const fake = context(seeds);
		fake.proc.extraJava?.push({
			pid: 555,
			commandLine: "java -Dprobe.runtimeKey=v-lost CosmicProbeServer",
			memoryBytes: null,
			startedAtMs: null,
		});
		const scan = await scanLocalJvms(jvmDeps(fake.ctx), { cacheRoots: [ROOT], listProcesses: true, clean: false });
		expect(scan.jvms.map((jvm) => [jvm.pid, jvm.keyId, jvm.state])).toEqual([
			[101, "v-live", "ready"],
			[555, "v-lost", "unresponsive"],
		]);
		expect(scan.staleRecords.map((file) => file.replace(/\\/g, "/")).sort()).toEqual([
			`${ROOT}/v-dead/probe-server.pid`,
			`${ROOT}/v-reused/probe-server.pid`,
		]);
		expect(scan.jvms[0]?.memoryBytes).toBe(600 * 1024 * 1024);
		expect(scan.jvms[0]?.projectRoot).toBe("D:/proj");
	});

	it("clean 删掉失效登记和旁边的心跳文件，正常的不动", async () => {
		const fake = context([
			{ key: "v-live", pid: 101, healthPort: 50101 },
			{ key: "v-reused", pid: 8684, commandLine: "msedge.exe" },
		]);
		// 上一个 JVM 留下的心跳文件：端口上已经没人答了。
		fake.fs.put(`${ROOT}/v-reused/probe-server.pid.health`, "pid=8684\nkey=v-reused\nport=50102\n");
		await scanLocalJvms(jvmDeps(fake.ctx), { cacheRoots: [ROOT], listProcesses: true, clean: true });
		expect(fake.fs.exists(`${ROOT}/v-reused/probe-server.pid`)).toBe(false);
		expect(fake.fs.exists(`${ROOT}/v-reused/probe-server.pid.health`)).toBe(false);
		expect(fake.fs.exists(`${ROOT}/v-live/probe-server.pid`)).toBe(true);
	});

	it("不查进程清单时，心跳不答的既不列、也不判失效（不知道就是不知道）", async () => {
		const fake = context([{ key: "v-mute", pid: 103 }]);
		const scan = await scanLocalJvms(jvmDeps(fake.ctx), { cacheRoots: [ROOT], listProcesses: false, clean: true });
		expect(scan.jvms).toEqual([]);
		expect(scan.staleRecords).toEqual([]);
		expect(fake.fs.exists(`${ROOT}/v-mute/probe-server.pid`)).toBe(true);
	});
});

describe("停之前核对身份", () => {
	it("常驻探针服务登记里的号被别的程序占了：不结束任何进程，删掉登记", async () => {
		const fake = makeContext();
		fake.fs.write(
			fake.ctx.layout.serverPid,
			JSON.stringify({ pid: 8684, keyId: fake.ctx.runtimeKeyId, port: 1, startedAt: "x" }),
		);
		fake.proc.livePids.add(8684);
		fake.proc.extraJava?.push({ pid: 8684, commandLine: "msedge.exe", memoryBytes: null, startedAtMs: null });
		const outcome = await stopServer(fake.ctx);
		expect(fake.proc.killed).toEqual([]);
		expect(outcome.how).toBe("absent");
		expect(fake.fs.exists(fake.ctx.layout.serverPid)).toBe(false);
	});

	it("正在跑别的请求时停：回话超时、核对时它已经自己退了，报「停了」而不是「本来就没在跑」", async () => {
		const fake = makeContext();
		fake.fs.write(
			fake.ctx.layout.serverPid,
			JSON.stringify({ pid: 29092, keyId: fake.ctx.runtimeKeyId, port: 1, startedAt: "x" }),
		);
		fake.proc.livePids.add(29092);
		// 忙着，SHUTDOWN 等不到回话；排到它时它照做退出
		fake.net.handler = () => {
			fake.proc.livePids.delete(29092);
			return { ok: false, why: "timeout" };
		};
		const outcome = await stopServer(fake.ctx);
		expect(outcome).toEqual({ how: "graceful", pid: 29092 });
		expect(fake.proc.killed).toEqual([]);
		expect(fake.fs.exists(fake.ctx.layout.serverPid)).toBe(false);
	});

	it("心跳不答、进程清单也查不了：不停，登记留着", async () => {
		const fake = makeContext();
		fake.fs.write(
			fake.ctx.layout.serverPid,
			JSON.stringify({ pid: 777, keyId: fake.ctx.runtimeKeyId, port: 1, startedAt: "x" }),
		);
		fake.proc.livePids.add(777);
		fake.proc.extraJava = null;
		const outcome = await stopServer(fake.ctx);
		expect(fake.proc.killed).toEqual([]);
		expect(outcome.how).toBe("unverified");
		expect(fake.fs.exists(fake.ctx.layout.serverPid)).toBe(true);
	});

	it("命令行对得上才强制结束", async () => {
		const fake = makeContext();
		fake.fs.write(
			fake.ctx.layout.serverPid,
			JSON.stringify({ pid: 778, keyId: fake.ctx.runtimeKeyId, port: 1, startedAt: "x" }),
		);
		fake.proc.livePids.add(778);
		fake.proc.extraJava?.push({
			pid: 778,
			commandLine: `java -Dprobe.runtimeKey=${fake.ctx.runtimeKeyId} CosmicProbeServer`,
			memoryBytes: null,
			startedAtMs: null,
		});
		const outcome = await stopServer(fake.ctx);
		expect(fake.proc.killed).toEqual([{ pid: 778, hard: true }]);
		expect(outcome.how).toBe("forced");
	});

	it("调试节点登记里的号被别的程序占了：stop 不结束它，start 也不当它在跑", async () => {
		const fake = makeContext();
		fake.fs.write(
			fake.ctx.layout.debugPid,
			JSON.stringify({ pid: 8684, keyId: fake.ctx.runtimeKeyId, port: 8080, startedAt: "x" }),
		);
		fake.proc.livePids.add(8684);
		fake.proc.extraJava?.push({ pid: 8684, commandLine: "msedge.exe", memoryBytes: null, startedAtMs: null });
		const stopped = await node(fake.ctx, "stop");
		expect(fake.proc.killed).toEqual([]);
		expect(stopped.ok && stopped.value.stopped).toBe("absent");
	});

	it("面板停一个旧版本：先请它自己退，退了就不再强制结束", async () => {
		const seeds: Seed[] = [{ key: "v-old", pid: 201, healthPort: 50201 }];
		const fake = context(seeds);
		const deps = jvmDeps(fake.ctx);
		const scan = await scanLocalJvms(deps, { cacheRoots: [ROOT], listProcesses: true, clean: false });
		const target = scan.jvms[0];
		if (target === undefined) throw new Error("没列出来");
		expect(await stopLocalJvm(deps, target)).toEqual({ stopped: true, how: "graceful" });
		expect(fake.proc.killed).toEqual([]);
		expect(fake.fs.exists(`${ROOT}/v-old/probe-server.pid`)).toBe(false);
	});

	it("调试节点改版前起的（命令行没有版本号）认工程下的 pathing jar", () => {
		const line = 'java -Xmx4g -jar "D:\\proj\\build\\cosmic-pathing.jar"';
		expect(commandLineMatches("node", "v1", line, "D:/proj")).toBe(true);
		expect(commandLineMatches("node", "v1", line, "D:/other")).toBe(false);
		expect(
			commandLineMatches(
				"node",
				"v1",
				"java -Dcosmic.runtimeKey=v2 -jar D:/proj/build/cosmic-pathing.jar",
				"D:/proj",
			),
		).toBe(false);
	});
});

describe("新版本起来后停同一工程的旧版本（用户选 A）", () => {
	const input = { cacheRoots: [ROOT], currentKeyId: "v-new", projectRoot: "D:/proj", nowMs: NOW };

	it("只停同一工程、别的版本、空闲超过两分钟、两分钟内没被打开过的", async () => {
		const seeds: Seed[] = [
			{ key: "v-new", pid: 300, healthPort: 50300, lastActive: NOW },
			{ key: "v-idle", pid: 301, healthPort: 50301, lastActive: NOW - 10 * MIN },
			{ key: "v-busy", pid: 302, healthPort: 50302, state: "executing", lastActive: NOW - 10 * MIN },
			{ key: "v-recent", pid: 303, healthPort: 50303, lastActive: NOW - 30_000 },
			{ key: "v-opened", pid: 304, healthPort: 50304, lastActive: NOW - 10 * MIN, opened: NOW - 30_000 },
			{ key: "v-otherproj", pid: 305, healthPort: 50305, lastActive: NOW - 10 * MIN, project: "D:/other" },
		];
		const fake = context(seeds);
		const retired = await retireOldProbeServers(jvmDeps(fake.ctx), input);
		expect(retired.map((jvm) => jvm.keyId)).toEqual(["v-idle"]);
		expect(fake.proc.livePids.has(301)).toBe(false);
		for (const pid of [300, 302, 303, 304, 305]) expect(fake.proc.livePids.has(pid)).toBe(true);
	});
});

describe("空闲退出时间两边一致", () => {
	it("和 CosmicProbeServer.IDLE_EXIT_MS 是同一个数", () => {
		const java = readFileSync("resources/runtime/CosmicProbeServer.java", "utf8");
		const match = /IDLE_EXIT_MS\s*=\s*(\d+)\s*\*\s*(\d+)\s*\*\s*(\d+)L/.exec(java);
		expect(match).not.toBeNull();
		expect(Number(match?.[1]) * Number(match?.[2]) * Number(match?.[3])).toBe(PROBE_IDLE_EXIT_MS);
	});
});

describe("常驻 JVM 的启动参数换版本也不变（JRebel 启动缓存才复用得上）", () => {
	const jrebel = {
		mode: "jrebel" as const,
		args: ["-agentpath:C:/jr/jrebel64.dll", "-Dcosmic.jrebel=1"],
		warning: null,
	};
	const argsOf = (key: string) =>
		residentServerArgs(
			makeContext({ runtimeKeyId: key, cacheRoot: `D:/cache/${key}` }).ctx,
			jrebel,
			"D:/jdk/lib/tools.jar",
		);

	it("主类前面除了 -cp，两个版本一字不差；版本号和缓存路径都写在主类后面", () => {
		const a = argsOf("v0.1.0-aaaa");
		const b = argsOf("v0.1.0-bbbb");
		const head = (args: string[]) => {
			const main = args.indexOf(PROBE_SERVER_MAIN);
			const cp = args.indexOf("-cp");
			return args.slice(0, main).filter((_, index) => index !== cp + 1);
		};
		expect(head(a)).toEqual(head(b));
		expect(head(a).join(" ")).not.toContain("aaaa");
		const tail = a.slice(a.indexOf(PROBE_SERVER_MAIN) + 1);
		expect(tail).toContain("-Dprobe.runtimeKey=v0.1.0-aaaa");
		expect(tail.every((arg) => arg.startsWith("-Dprobe."))).toBe(true);
	});

	// S59：连接池借出前探活的窗口放宽到 30 秒，写在主类前面（连接池建池时读它）；值是定死的，两个版本一样，不让 JRebel 重新生成缓存
	it("带上连接池探活窗口，写在主类前面，不随版本变", () => {
		const args = argsOf("v0.1.0-aaaa");
		const at = args.indexOf("-Dcom.zaxxer.hikari.aliveBypassWindowMs=30000");
		expect(at).toBeGreaterThan(0);
		expect(at).toBeLessThan(args.indexOf(PROBE_SERVER_MAIN));
		expect(argsOf("v0.1.0-bbbb")).toContain("-Dcom.zaxxer.hikari.aliveBypassWindowMs=30000");
	});

	// 真机：常驻 JVM 跑了几小时后，--set 触发的插件空指针只剩「NullPointerException: (无)」、栈是空的，定位不了哪一行
	it("带上保留异常栈的开关，写在主类前面", () => {
		const args = argsOf("v0.1.0-aaaa");
		const at = args.indexOf("-XX:-OmitStackTraceInFastThrow");
		expect(at).toBeGreaterThan(0);
		expect(at).toBeLessThan(args.indexOf(PROBE_SERVER_MAIN));
	});

	// S59 §9：连库用哪一套开关由宿主在平台读连接串模板之前决定，所以也得写在主类前面
	it("把连库方式告诉宿主，写在主类前面", () => {
		const args = argsOf("v0.1.0-aaaa");
		const at = args.indexOf("-Dcosmic.dbLink=fast");
		expect(at).toBeGreaterThan(0);
		expect(at).toBeLessThan(args.indexOf(PROBE_SERVER_MAIN));
	});

	it("写在主类后面，命令行里照样认得出是哪个版本的探针服务", () => {
		const line = ["java", ...argsOf("v0.1.0-aaaa")].join(" ");
		expect(commandLineMatches("probe", "v0.1.0-aaaa", line)).toBe(true);
		expect(commandLineMatches("probe", "v0.1.0-bbbb", line)).toBe(false);
	});

	it("宿主在 main 一开头把主类后面的 -D 设成系统属性，先于读它们的地方", () => {
		const java = readFileSync("resources/runtime/CosmicProbeServer.java", "utf8");
		const main = java.slice(java.indexOf("public static void main(String[] args)"));
		const first = main.indexOf("hostProperties(args);");
		expect(first).toBeGreaterThan(0);
		for (const reader of ["startHealthServer();", 'System.getProperty("probe.probesDir"'])
			expect(main.indexOf(reader)).toBeGreaterThan(first);
	});
});
