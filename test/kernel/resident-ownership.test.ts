import { describe, expect, it } from "vitest";
import { probe } from "../../src/kernel/commands/probe.ts";
import { probeServer } from "../../src/kernel/commands/probe-server.ts";
import {
	type ProbeServerProgress,
	readManifest,
	residentPort,
	residentReady,
	startServer,
} from "../../src/kernel/probe/server.ts";
import { type FakeContext, makeContext } from "./fake-context.ts";

/**
 * S58：常驻苍穹进程明明在跑，工具却认不出是自己的。
 *
 * 真机上的经过：开机自检和恢复会话隔了几秒各要一次常驻进程，那时第一个还在启动、端口没开，于是起了两个；
 * 登记被后起的盖掉，占到端口的却是先起的。后起的收不到请求，空闲半小时退出，登记从此指着一个不在了的进程，
 * 之后每次运行都另起冷进程。
 */

const PROBE_SRC = "public class MetaProbe {\n  public static void main(String[] a) {}\n}\n";

function fakeWithProbe(): FakeContext {
	const fake = makeContext({ probes: ["MetaProbe"] });
	fake.fs.put(`${fake.ctx.layout.probesDir.replace(/\\/g, "/")}/MetaProbe.java`, PROBE_SRC);
	fake.proc.handler = (spec) =>
		spec.args.includes("javac") || spec.command === "where"
			? { status: 0, stdout: "C:/jdk/bin/javac.exe" }
			: { status: 0 };
	fake.fs.put("C:/jdk/lib/tools.jar", "tools");
	return fake;
}

/** 端口上那个进程对 PING 的答复：它自己的进程号、版本号、身份。 */
function pingReply(fake: FakeContext, pid: number, key = fake.ctx.runtimeKeyId): { ok: true; text: string } {
	return {
		ok: true,
		text: [
			"RESULT OK 0",
			`pid=${String(pid)}`,
			`key=${key}`,
			`account=${String(fake.ctx.config.account)}`,
			`user=${String(fake.ctx.config.user)}`,
			"health=45678",
			"started=2026-10-10 18:19:57",
			"hotswap=instrument",
			"",
		].join("\n"),
	};
}

function writeManifest(fake: FakeContext, pid: number): void {
	fake.fs.write(
		fake.ctx.layout.serverPid,
		JSON.stringify({
			pid,
			keyId: fake.ctx.runtimeKeyId,
			port: 1,
			startedAt: "",
			account: fake.ctx.config.account,
			user: fake.ctx.config.user,
		}),
	);
}

/** 一个按本版本起的常驻进程的命令行，摆进本机进程清单。 */
function listAsOurs(fake: FakeContext, pid: number): void {
	fake.proc.livePids.add(pid);
	fake.proc.extraJava = [
		{
			pid,
			commandLine: `java -cp x CosmicProbeServer -Dprobe.runtimeKey=${fake.ctx.runtimeKeyId}`,
			memoryBytes: null,
			startedAtMs: null,
		},
	];
}

describe("登记对不上时问端口上那个进程自己", () => {
	it("登记指着的进程不在了、答话的进程报的是本版本：照它补登记，探针照样搭常驻", async () => {
		const fake = fakeWithProbe();
		writeManifest(fake, 21372);
		fake.proc.livePids.add(15952);
		fake.net.handler = (_port, lines) =>
			lines[0] === "PING" ? pingReply(fake, 15952) : { ok: true, text: "RESULT OK 0\n[PROBE] done\n" };

		const result = await probe(fake.ctx, "MetaProbe", {});
		expect(result.ok && result.value.path).toBe("hot");
		expect(result.ok && result.value.notes.join("\n")).not.toContain("认不出归属");
		expect(fake.proc.detached).toHaveLength(0);
		const manifest = readManifest(fake.ctx);
		expect(manifest?.pid).toBe(15952);
		expect(manifest?.account).toBe(fake.ctx.config.account);
		expect(manifest?.user).toBe(fake.ctx.config.user);
		expect(manifest?.startedAt).toBe(new Date(2026, 9, 10, 18, 19, 57).toISOString());
		// 心跳文件也照答复补回来：面板和「停旧版本」是靠它问到这个进程的
		expect(fake.fs.read(`${fake.ctx.layout.serverPid}.health`)).toBe(
			`pid=15952\nkey=${fake.ctx.runtimeKeyId}\nport=45678\n`,
		);
	});

	it("登记整份不在了也一样：查状态答「是自己的」，并报出进程号", async () => {
		const fake = fakeWithProbe();
		fake.proc.livePids.add(15952);
		fake.net.handler = () => pingReply(fake, 15952);
		const status = await probeServer(fake.ctx, "status");
		expect(status.ok && status.value.ownership).toBe("own");
		expect(status.ok && status.value.pid).toBe(15952);
		expect(await residentReady(fake.ctx)).toBe(true);
	});

	it("答话的进程报的是别的版本：不认，登记不动，探针走冷进程", async () => {
		const fake = fakeWithProbe();
		writeManifest(fake, 21372);
		fake.proc.livePids.add(15952);
		fake.net.handler = (_port, lines) =>
			lines[0] === "PING" ? pingReply(fake, 15952, "v9.9.9-other") : { ok: true, text: "RESULT OK 0\n" };
		const result = await probe(fake.ctx, "MetaProbe", {});
		expect(result.ok && result.value.coldReason).toBe("常驻 JVM 归属存疑");
		expect(readManifest(fake.ctx)?.pid).toBe(21372);
	});

	it("答复里没有版本号（老宿主）：不认", async () => {
		const fake = fakeWithProbe();
		fake.net.handler = () => ({ ok: true, text: "RESULT OK 0\npid=15952\naccount=acct\n" });
		const status = await probeServer(fake.ctx, "status");
		expect(status.ok && status.value.ownership).toBe("unknown");
		expect(readManifest(fake.ctx)).toBeNull();
	});

	it("登记和答话的是同一个进程时不重写登记", async () => {
		const fake = fakeWithProbe();
		writeManifest(fake, 15952);
		fake.proc.livePids.add(15952);
		const before = fake.fs.read(fake.ctx.layout.serverPid);
		fake.net.handler = () => pingReply(fake, 15952);
		await probeServer(fake.ctx, "status");
		expect(fake.fs.read(fake.ctx.layout.serverPid)).toBe(before);
	});

	it("登记没被盖、心跳文件被后起的那个盖了：只补心跳文件", async () => {
		const fake = fakeWithProbe();
		writeManifest(fake, 15952);
		fake.proc.livePids.add(15952);
		const before = fake.fs.read(fake.ctx.layout.serverPid);
		fake.fs.write(`${fake.ctx.layout.serverPid}.health`, `pid=21372\nkey=${fake.ctx.runtimeKeyId}\nport=57914\n`);
		fake.net.handler = () => pingReply(fake, 15952);
		await probeServer(fake.ctx, "status");
		expect(fake.fs.read(fake.ctx.layout.serverPid)).toBe(before);
		expect(fake.fs.read(`${fake.ctx.layout.serverPid}.health`)).toBe(
			`pid=15952\nkey=${fake.ctx.runtimeKeyId}\nport=45678\n`,
		);
	});
});

describe("端口这一刻不答，不等于没在跑", () => {
	/** 进程活着、心跳口答得上（报的状态由参数定），请求端口按 `why` 不答。 */
	function alive(state: string, why: string): FakeContext {
		const fake = fakeWithProbe();
		fake.fs.write(
			fake.ctx.layout.serverPid,
			JSON.stringify({
				pid: 15952,
				keyId: fake.ctx.runtimeKeyId,
				port: residentPort(fake.ctx),
				startedAt: "",
				account: fake.ctx.config.account,
				user: fake.ctx.config.user,
			}),
		);
		fake.fs.write(`${fake.ctx.layout.serverPid}.health`, `pid=15952\nkey=${fake.ctx.runtimeKeyId}\nport=45678\n`);
		fake.proc.livePids.add(15952);
		fake.net.handler = (port, lines) =>
			port === 45678 && lines[0] === "HEALTH"
				? {
						ok: true,
						text: `RESULT OK 0\npid=15952\nkey=${fake.ctx.runtimeKeyId}\nstate=${state}\nstep=\naccount=${String(fake.ctx.config.account)}\nuser=${String(fake.ctx.config.user)}\n`,
					}
				: { ok: false, why };
		return fake;
	}

	it("还在启动、端口没开：说正在启动，不说没在跑", async () => {
		const status = await probeServer(alive("warming", "ECONNREFUSED").ctx, "status");
		expect(status.ok && status.value.state).toBe("starting");
		expect(status.ok && status.value.running).toBe(false);
		expect(status.ok && status.value.pid).toBe(15952);
		expect(status.ok && status.value.notes.join("\n")).toContain("正在启动");
		expect(status.ok && status.value.notes.join("\n")).not.toContain("没在跑");
	});

	it("正跑着别的请求、顾不上答：说在跑、是自己的", async () => {
		const status = await probeServer(alive("executing", "ETIMEDOUT").ctx, "status");
		expect(status.ok && status.value.state).toBe("busy");
		expect(status.ok && status.value.running).toBe(true);
		expect(status.ok && status.value.ownership).toBe("own");
		expect(status.ok && status.value.notes.join("\n")).toContain("正在执行别的请求");
	});

	it("心跳口也问不到：照旧说没在跑", async () => {
		const fake = alive("ready", "ECONNREFUSED");
		fake.net.handler = () => ({ ok: false, why: "ECONNREFUSED" });
		fake.proc.livePids.delete(15952);
		const status = await probeServer(fake.ctx, "status");
		expect(status.ok && status.value.state).toBeUndefined();
		expect(status.ok && status.value.notes.join("\n")).toContain("没在跑");
	});
});

describe("还在启动时又来一个要用它的：不再起第二个", () => {
	it("同一个进程里两处同时要常驻进程：只起一个，后来的也收得到进度", async () => {
		const fake = fakeWithProbe();
		// 起来之前端口没人答；起来以后答话的就是起的那个
		let pings = 0;
		fake.net.handler = () => {
			const pid = fake.proc.detachedPids[0];
			if (pid === undefined || ++pings < 4) return { ok: false, why: "ECONNREFUSED" };
			return pingReply(fake, pid);
		};
		const firstStages: ProbeServerProgress[] = [];
		const secondStages: ProbeServerProgress[] = [];
		const first = startServer(fake.ctx, (stage) => firstStages.push(stage));
		const second = startServer(fake.ctx, (stage) => secondStages.push(stage));
		const [a, b] = await Promise.all([first, second]);
		expect(fake.proc.detached).toHaveLength(1);
		expect(a.ok && a.value.pid).toBe(fake.proc.detachedPids[0]);
		expect(b.ok && b.value.pid).toBe(fake.proc.detachedPids[0]);
		expect(firstStages).toContain("warming-runtime");
		expect(secondStages).toContain("warming-runtime");
		// 这一趟结束后不留着：下一次要起照常起
		const again = await startServer(fake.ctx);
		expect(again.ok && again.value.started).toBe(false);
	});

	it("别的进程刚起了一个、端口还没开：等它答话，不起第二个", async () => {
		const fake = fakeWithProbe();
		writeManifest(fake, 777);
		listAsOurs(fake, 777);
		let pings = 0;
		fake.net.handler = () => (++pings < 5 ? { ok: false, why: "ECONNREFUSED" } : pingReply(fake, 777));
		const result = await startServer(fake.ctx);
		expect(fake.proc.detached).toHaveLength(0);
		expect(result.ok && result.value.started).toBe(false);
		expect(result.ok && result.value.pid).toBe(777);
		expect(readManifest(fake.ctx)?.pid).toBe(777);
	});

	it("等的那个中途退出了：接着起自己的", async () => {
		const fake = fakeWithProbe();
		writeManifest(fake, 777);
		listAsOurs(fake, 777);
		let pings = 0;
		fake.net.handler = () => {
			pings++;
			if (pings === 3) fake.proc.livePids.delete(777);
			const pid = fake.proc.detachedPids[0];
			return pid === undefined ? { ok: false, why: "ECONNREFUSED" } : pingReply(fake, pid);
		};
		const result = await startServer(fake.ctx);
		expect(fake.proc.detached).toHaveLength(1);
		expect(result.ok && result.value.started).toBe(true);
		expect(readManifest(fake.ctx)?.pid).toBe(fake.proc.detachedPids[0]);
	});

	it("登记里的进程号已经是别的程序的：不等它，照常起", async () => {
		const fake = fakeWithProbe();
		writeManifest(fake, 8684);
		fake.proc.livePids.add(8684);
		fake.proc.extraJava = [
			{ pid: 8684, commandLine: "msedge.exe --type=renderer", memoryBytes: null, startedAtMs: null },
		];
		fake.net.handler = () => {
			const pid = fake.proc.detachedPids[0];
			return pid === undefined ? { ok: false, why: "ECONNREFUSED" } : pingReply(fake, pid);
		};
		const result = await startServer(fake.ctx);
		expect(fake.proc.detached).toHaveLength(1);
		expect(result.ok && result.value.started).toBe(true);
	});

	it("两边都起了、对方先占到端口：登记以答话的那个为准", async () => {
		const fake = fakeWithProbe();
		fake.proc.livePids.add(15952);
		// 本进程起的那个没占到端口；端口上答话的是别的进程先起的 15952
		fake.net.handler = () =>
			fake.proc.detached.length === 0 ? { ok: false, why: "ECONNREFUSED" } : pingReply(fake, 15952);
		const result = await startServer(fake.ctx);
		expect(fake.proc.detached).toHaveLength(1);
		expect(result.ok && result.value.pid).toBe(15952);
		expect(readManifest(fake.ctx)?.pid).toBe(15952);
	});
});
