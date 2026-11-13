/** 真机只读验收：启动、业务忙时心跳、空闲计时、同步和停止。不改业务源码/数据/配置。 */
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { probe } from "../src/kernel/commands/probe.ts";
import { openProject } from "../src/kernel/open-project.ts";
import { localServiceHealth } from "../src/kernel/probe/health.ts";
import { markServerStale, startServer, stopServer } from "../src/kernel/probe/server.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";

const root = process.argv[2];
if (!root) throw new Error("Usage: verify-local-service.ts <projectRoot>");
const { ctx } = await openProject({
	projectRoot: root,
	agentConfigDir: process.env.COSMIC_AGENT_DIR ?? join(tmpdir(), "cosmic-agent"),
	cacheRoot: process.env.COSMIC_CACHE_ROOT ?? join(tmpdir(), "cosmic-cache"),
	agentVersion: "0.0.0-s3",
	resources: EMBEDDED_RESOURCES,
});
console.log(`runtime=${ctx.runtimeKeyId}`);
const started = await startServer(ctx, (stage) => console.log(stage));
assert(started.ok, started.ok ? "" : started.error.message);
const pid = started.value.pid;
console.log(`pid=${pid}`);
try {
	assert.equal((await localServiceHealth(ctx)).kind, "ready");
	let finished = false;
	const work = probe(ctx, "EnvDiagProbe", {
		positional: [],
		env: {},
		countRepeats: false,
		coldFallback: false,
	}).finally(() => {
		finished = true;
	});
	const observed = new Set<string>();
	let maxHealthMs = 0;
	while (!finished) {
		const start = performance.now();
		const status = await localServiceHealth(ctx);
		maxHealthMs = Math.max(maxHealthMs, performance.now() - start);
		observed.add(status.kind);
		await delay(200);
	}
	const result = await work;
	assert(result.ok, result.ok ? "" : result.error.message);
	assert.equal(result.value.exitCode, 0);
	assert(observed.has("executing"), `没观察到忙碌状态：${[...observed]}`);
	assert(!observed.has("unresponsive"));
	console.log(`busy-health PASS states=${[...observed]} max=${maxHealthMs.toFixed(1)}ms`);
	const endpoint = ctx.ports.fs.read(`${ctx.layout.serverPid}.health`);
	const healthPort = Number(/^port=(\d+)$/m.exec(endpoint)?.[1]);
	const raw = async () => {
		const reply = await ctx.ports.net.request(healthPort, ["HEALTH"], 1000);
		assert(reply.ok);
		return /^lastActive=(\d+)$/m.exec(reply.text)?.[1];
	};
	const idle = await raw();
	assert(idle);
	await delay(250);
	assert.equal(await raw(), idle);
	console.log("idle-clock PASS heartbeat does not keep service alive");
	markServerStale(ctx, "状态栏验收：检查同步路径", "classes");
	assert.equal((await localServiceHealth(ctx)).kind, "pending-sync");
	const synced = await probe(ctx, "EnvDiagProbe", {
		positional: [],
		env: {},
		countRepeats: false,
		coldFallback: false,
	});
	assert(synced.ok, synced.ok ? "" : synced.error.message);
	assert.equal(synced.value.exitCode, 0);
	const ready = await localServiceHealth(ctx);
	assert.equal(ready.kind, "ready");
	assert.equal(ready.pid, pid);
	console.log("sync PASS pending-sync -> ready, same process");
} finally {
	if (started.value.started) {
		await stopServer(ctx);
		assert.equal((await localServiceHealth(ctx)).kind, "stopped");
		console.log("stop PASS");
	}
}
