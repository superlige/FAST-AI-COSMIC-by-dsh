import { describe, expect, it } from "vitest";
import { localServiceHealth } from "../../src/kernel/probe/health.ts";
import { markServerStale, residentPort } from "../../src/kernel/probe/server.ts";
import { makeContext } from "./fake-context.ts";

function fixture() {
	const fake = makeContext();
	const { ctx, fs, proc, net } = fake;
	proc.livePids.add(321);
	proc.extraJava?.push({
		pid: 321,
		commandLine: `java -Xmx2g -Dprobe.runtimeKey=${ctx.runtimeKeyId} -cp x CosmicProbeServer`,
		memoryBytes: null,
		startedAtMs: null,
	});
	fs.write(
		ctx.layout.serverPid,
		JSON.stringify({
			pid: 321,
			keyId: ctx.runtimeKeyId,
			port: residentPort(ctx),
			startedAt: "now",
			account: ctx.config.account,
			user: ctx.config.user,
		}),
	);
	fs.write(`${ctx.layout.serverPid}.health`, `pid=321\nkey=${ctx.runtimeKeyId}\nport=45678\n`);
	let state = "ready";
	let step = "";
	let pid = 321;
	net.handler = (port, lines) => {
		expect(port).toBe(45678);
		expect(lines).toEqual(["HEALTH"]);
		return {
			ok: true,
			text: `RESULT OK 0\npid=${pid}\nkey=${ctx.runtimeKeyId}\naccount=${ctx.config.account}\nuser=${ctx.config.user}\nstate=${state}\nstep=${step}\n`,
		};
	};
	return {
		...fake,
		state: (value: string) => {
			state = value;
		},
		step: (value: string) => {
			step = value;
		},
		pid: (value: number) => {
			pid = value;
		},
	};
}

describe("local service health", () => {
	it("tracks ready, executing, syncing and poisoned without business PING", async () => {
		const fake = fixture();
		for (const state of ["starting", "warming", "ready", "executing", "syncing", "unhealthy"]) {
			fake.state(state);
			expect((await localServiceHealth(fake.ctx)).kind).toBe(state);
		}
	});
	it("reports which step an executing request is on, and only while executing", async () => {
		const fake = fixture();
		fake.state("executing");
		fake.step("compile");
		expect(await localServiceHealth(fake.ctx)).toMatchObject({ kind: "executing", step: "compile" });
		fake.step("run");
		expect(await localServiceHealth(fake.ctx)).toMatchObject({ kind: "executing", step: "run" });
		// 旧宿主不报 step、或者报了认不得的：不写。
		fake.step("");
		expect((await localServiceHealth(fake.ctx)).step).toBeUndefined();
		fake.step("weird");
		expect((await localServiceHealth(fake.ctx)).step).toBeUndefined();
		fake.state("ready");
		fake.step("run");
		expect((await localServiceHealth(fake.ctx)).step).toBeUndefined();
	});
	it("a dead process clears green; an unresponsive live process is not called dead", async () => {
		const fake = fixture();
		fake.net.handler = () => ({ ok: false, why: "timeout" });
		expect((await localServiceHealth(fake.ctx)).kind).toBe("unresponsive");
		fake.proc.livePids.clear();
		expect((await localServiceHealth(fake.ctx)).kind).toBe("stopped");
	});
	it("rejects foreign replies and stale endpoint files", async () => {
		const fake = fixture();
		fake.pid(999);
		expect((await localServiceHealth(fake.ctx)).kind).toBe("foreign");
		fake.fs.write(`${fake.ctx.layout.serverPid}.health`, "pid=999\nkey=other\nport=45678");
		fake.net.handler = () => {
			throw new Error("must not connect");
		};
		expect((await localServiceHealth(fake.ctx)).kind).toBe("unresponsive");
	});
	it("observes sync/restart markers without consuming them", async () => {
		const fake = fixture();
		markServerStale(fake.ctx, "compiled", "classes");
		expect((await localServiceHealth(fake.ctx)).kind).toBe("pending-sync");
		expect(fake.fs.exists(fake.ctx.layout.serverStale)).toBe(true);
		markServerStale(fake.ctx, "metadata", "restart");
		expect((await localServiceHealth(fake.ctx)).kind).toBe("restart-needed");
		fake.state("executing");
		expect((await localServiceHealth(fake.ctx)).kind).toBe("executing");
	});
	it("never accepts a green reply from a process replaced during the request", async () => {
		const fake = fixture();
		const handler = fake.net.handler;
		fake.net.handler = (port, lines) => {
			const result = handler!(port, lines);
			fake.proc.livePids.clear();
			return result;
		};
		expect((await localServiceHealth(fake.ctx)).kind).toBe("unresponsive");
	});
	it("does not probe an endpoint belonging to a different runtime", async () => {
		const fake = fixture();
		const manifest = JSON.parse(fake.fs.read(fake.ctx.layout.serverPid));
		fake.fs.write(fake.ctx.layout.serverPid, JSON.stringify({ ...manifest, keyId: "other" }));
		fake.net.handler = () => {
			throw new Error("must not connect");
		};
		expect((await localServiceHealth(fake.ctx)).kind).toBe("foreign");
	});
});
