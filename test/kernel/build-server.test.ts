import { describe, expect, it } from "vitest";
import { build, selectModules } from "../../src/kernel/commands/build.ts";
import { probeServer } from "../../src/kernel/commands/probe-server.ts";
import { residentPort } from "../../src/kernel/probe/server.ts";
import { makeContext } from "./fake-context.ts";

const modules = { codeModules: ["demo-biz", "demo-common"] };

describe("S5.2 build", () => {
	it("refuses an unknown module instead of skipping it", () => {
		// A silent skip is "build reported success and that module was never compiled".
		const { ctx } = makeContext({ config: modules });
		const result = selectModules(ctx, ["demo-biz", "nope"]);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("MODULE_SCOPE_INVALID");
	});

	it("does not rebuild when the artefacts are already there", async () => {
		const { ctx, proc } = makeContext({ config: modules });
		const result = await build(ctx);
		expect(result.ok && result.value.ran).toBe(false);
		expect(proc.runs).toHaveLength(0);
		expect(result.ok && result.value.notes.join()).toContain("依赖变过就用 force");
	});

	it("force rebuilds even with the artefacts present", async () => {
		const { ctx, proc } = makeContext({ config: modules });
		const syncRun = proc.run.bind(proc);
		proc.run = () => {
			throw new Error("the build port must not use the blocking process path");
		};
		proc.runAsync = async (spec) => syncRun(spec);
		const result = await build(ctx, { force: true });
		expect(result.ok && result.value.ran).toBe(true);
		// :module:build for each, then the pathing jar and the argfile.
		expect(proc.runs).toHaveLength(2);
		expect(proc.runs[0]?.args.slice(0, 2)).toEqual([":demo-biz:build", ":demo-common:build"]);
	});

	it("says that a narrowed build still compiles every module's classes", async () => {
		// One module missing from the probe classpath is a NoClassDefFoundError, so
		// the pathing jar step is never narrowed.
		const { ctx, proc } = makeContext({ config: modules });
		const result = await build(ctx, { modules: ["demo-biz"], force: true });
		expect(proc.runs[0]?.args[0]).toBe(":demo-biz:build");
		expect(result.ok && result.value.notes.join()).toContain("pathing jar 仍会编齐所有代码模块");
	});

	it("reports a gradle failure as BUILD_FAILED rather than throwing", async () => {
		const { ctx, proc } = makeContext({ config: modules });
		proc.handler = () => ({ status: 1, stdout: "FAILURE: dependency missing" });
		const result = await build(ctx, { force: true });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("BUILD_FAILED");
			expect(result.error.detail.outputTail).toContain("dependency missing");
		}
	});

	it("on Windows stops its own resident JVM before rewriting the pathing jar it holds open", async () => {
		// 真机：常驻 JVM 活着时 force 重建，Gradle 写不进被锁住的 build/cosmic-pathing.jar，整次构建失败。
		const fake = makeContext({ config: modules });
		fake.fs.write(
			fake.ctx.layout.serverPid,
			JSON.stringify({ pid: 777, keyId: fake.ctx.runtimeKeyId, port: residentPort(fake.ctx), startedAt: "" }),
		);
		fake.proc.livePids.add(777);
		const order: string[] = [];
		fake.net.handler = (_port, lines) => {
			if (lines[0] === "SHUTDOWN") {
				order.push("shutdown");
				fake.proc.livePids.delete(777);
			}
			return { ok: true, text: "RESULT OK 0\n" };
		};
		fake.proc.handler = (spec) => {
			order.push(spec.args.some((arg) => arg.endsWith(":cosmicPathingJar")) ? "pathing-jar" : "module-build");
			return { status: 0 };
		};
		const result = await build(fake.ctx, { force: true });
		expect(result.ok).toBe(true);
		expect(order).toEqual(["module-build", "shutdown", "pathing-jar"]);
	});

	it("classifies Gradle heap exhaustion and gives an actionable remedy", async () => {
		const { ctx, proc } = makeContext({ config: modules });
		proc.handler = (_spec, index) =>
			index === 0
				? { status: 0 }
				: {
						status: 1,
						stderr: "Expiring Daemon because JVM heap space is exhausted\n> GC overhead limit exceeded",
					};
		const result = await build(ctx, { force: true });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("BUILD_FAILED");
			expect(result.error.message).toContain("Gradle JVM 内存耗尽");
			expect(result.error.detail).toMatchObject({ stage: "pathing-jar", cause: "GRADLE_JVM_OOM" });
			expect(result.error.detail.outputTail).toContain("GC overhead limit exceeded");
			expect(result.error.remedy).toContain("-Xmx2048m");
		}
	});
});

describe("S5.2 probe-server", () => {
	const own = (fake: ReturnType<typeof makeContext>, pid = 777): void => {
		fake.fs.write(
			fake.ctx.layout.serverPid,
			JSON.stringify({
				pid,
				keyId: fake.ctx.runtimeKeyId,
				port: residentPort(fake.ctx),
				startedAt: "",
				account: fake.ctx.config.account,
				user: fake.ctx.config.user,
			}),
		);
		fake.proc.livePids.add(pid);
	};

	it("reports absent when nothing answers", async () => {
		const fake = makeContext();
		const result = await probeServer(fake.ctx, "status");
		expect(result.ok && result.value.ownership).toBe("absent");
		expect(result.ok && result.value.running).toBe(false);
	});

	it("reports own when a live pid manifest names this RuntimeKey", async () => {
		const fake = makeContext();
		own(fake);
		fake.net.handler = () => ({ ok: true, text: "RESULT OK 0\nloaded 12 classes\n" });
		const result = await probeServer(fake.ctx, "status");
		expect(result.ok && result.value.ownership).toBe("own");
		expect(result.ok && result.value.detail).toContain("loaded 12 classes");
	});

	it("reports a JVM belonging to another RuntimeKey as foreign", async () => {
		// A well-formed RESULT line is not proof of ownership: that JVM runs against
		// different Cosmic JARs and would answer every probe with a wrong result.
		const fake = makeContext();
		fake.fs.write(
			fake.ctx.layout.serverPid,
			JSON.stringify({ pid: 999, keyId: "other-key", port: 1, startedAt: "" }),
		);
		fake.proc.livePids.add(999);
		fake.net.handler = () => ({ ok: true, text: "RESULT OK 0\n" });
		const result = await probeServer(fake.ctx, "status");
		expect(result.ok && result.value.ownership).toBe("foreign");
	});

	it("never stops a foreign JVM", async () => {
		const fake = makeContext();
		fake.fs.write(
			fake.ctx.layout.serverPid,
			JSON.stringify({ pid: 999, keyId: "other-key", port: 1, startedAt: "" }),
		);
		fake.proc.livePids.add(999);
		const result = await probeServer(fake.ctx, "stop");
		expect(result.ok && result.value.stopped).toBe("foreign");
		expect(fake.proc.killed).toHaveLength(0);
	});

	it("does not restart into a port a foreign JVM holds", async () => {
		const fake = makeContext();
		fake.fs.write(
			fake.ctx.layout.serverPid,
			JSON.stringify({ pid: 999, keyId: "other-key", port: 1, startedAt: "" }),
		);
		fake.proc.livePids.add(999);
		fake.net.handler = () => ({ ok: true, text: "RESULT OK 0\n" });
		const result = await probeServer(fake.ctx, "restart");
		expect(result.ok && result.value.notes.join()).toContain("没有停它");
		expect(fake.proc.detached).toHaveLength(0);
	});

	it("stops its own JVM gracefully and clears the manifest", async () => {
		const fake = makeContext();
		own(fake);
		fake.net.handler = (_port, lines) => {
			if (lines[0] === "SHUTDOWN") fake.proc.livePids.delete(777);
			return { ok: true, text: "RESULT OK 0\n" };
		};
		const result = await probeServer(fake.ctx, "stop");
		expect(result.ok && result.value.stopped).toBe("graceful");
		expect(fake.proc.killed).toHaveLength(0);
		expect(fake.fs.read(fake.ctx.layout.serverPid)).toBe("");
	});

	it("answers SHUTDOWN but never exits: waits, then force-stops the verified JVM", async () => {
		// 真机：宿主回了 RESULT OK 0，System.exit 卡住，进程一直在，端口和 pathing jar 都占着。
		const fake = makeContext();
		own(fake);
		fake.proc.extraJava?.push({
			pid: 777,
			commandLine: `java -Dprobe.runtimeKey=${fake.ctx.runtimeKeyId} CosmicProbeServer`,
			memoryBytes: null,
			startedAtMs: null,
		});
		fake.net.handler = () => ({ ok: true, text: "RESULT OK 0\n" });
		const result = await probeServer(fake.ctx, "stop");
		expect(result.ok && result.value.stopped).toBe("forced");
		expect(fake.proc.killed).toEqual([{ pid: 777, hard: true }]);
		expect(fake.clock.sleeps.length).toBeGreaterThan(0);
		expect(fake.fs.read(fake.ctx.layout.serverPid)).toBe("");
	});

	it("starts one and records the RuntimeKey in the manifest", async () => {
		const fake = makeContext({ env: { JAVA_HOME: "D:/jdk8" } });
		// JDK 8 loads its compiler from tools.jar, so the resident host needs one.
		fake.fs.put("D:/jdk8/lib/tools.jar", "jar");
		let started = false;
		fake.net.handler = () => (started ? { ok: true, text: "RESULT OK 0\n" } : { ok: false, why: "ECONNREFUSED" });
		fake.proc.handler = () => ({ status: 0, stdout: "" });
		// The PING right after startDetached is the one that has to succeed.
		const original = fake.proc.startDetached.bind(fake.proc);
		fake.proc.startDetached = (spec) => {
			started = true;
			return original(spec);
		};
		const result = await probeServer(fake.ctx, "start");
		expect(result.ok && result.value.ownership).toBe("own");
		const manifest: unknown = JSON.parse(fake.fs.read(fake.ctx.layout.serverPid));
		expect((manifest as { keyId: string }).keyId).toBe(fake.ctx.runtimeKeyId);
		// 探活先密后疏：热重启常常不到 1 秒就答 PING，固定 2 秒一问会把它算成等了 2 秒——
		// 而启动时这段等待就是 footer 上唯一在动的东西。
		expect(fake.clock.sleeps[0]).toBe(250);
		expect(result.ok && result.value.waitedSeconds).toBe(0.25);
	});

	it("keeps waiting when a live JVM takes more than 90s to become ready", async () => {
		// 90s 只是旧的等待预算，不是 JVM 启动失败的证据。旧实现会在这里返回错误，
		// 但留下一个稍后就绪的后台进程；TUI 的 EnvDiag promise 已经结束，footer 再也不会更新。
		const fake = makeContext({ env: { JAVA_HOME: "D:/jdk8" } });
		fake.fs.put("D:/jdk8/lib/tools.jar", "jar");
		fake.net.handler = () =>
			fake.clock.sleeps.reduce((total, ms) => total + ms, 0) > 90_000
				? { ok: true, text: "RESULT OK 0\n" }
				: { ok: false, why: "ECONNREFUSED" };
		fake.proc.handler = () => ({ status: 0, stdout: "" });
		const result = await probeServer(fake.ctx, "start");
		expect(result.ok).toBe(true);
		expect(result.ok && result.value.waitedSeconds).toBeGreaterThan(90);
		expect(result.ok && result.value.ownership).toBe("own");
	});
});
