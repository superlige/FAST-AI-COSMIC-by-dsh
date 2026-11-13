/**
 * S5.4 the local debug node.
 *
 * Two properties the frozen implementation could not have, both from D10:
 *   - the pid record carries the RuntimeKey, so a node started for another
 *     runtime is reported and left alone rather than adopted or killed;
 *   - nothing is ever killed by port. The port being open is reported as its own
 *     fact, never turned into "so that pid must be it".
 */

import { describe, expect, it } from "vitest";
import { node, readNodeManifest } from "../../src/kernel/commands/node.ts";
import { type FakeContext, makeContext } from "./fake-context.ts";

const PORT = 8080;

function withNode(fake: FakeContext, pid: number, keyId = fake.ctx.runtimeKeyId, alive = true): FakeContext {
	fake.fs.write(
		fake.ctx.layout.debugPid,
		JSON.stringify({ pid, keyId, port: PORT, startedAt: "2026-09-04T00:00:00.000Z" }),
	);
	if (alive) {
		fake.proc.livePids.add(pid);
		fake.proc.extraJava?.push({
			pid,
			commandLine: `java -Xmx4g -Dcosmic.runtimeKey=${keyId} -jar ${fake.ctx.layout.pathingJar}`,
			memoryBytes: null,
			startedAtMs: null,
		});
	}
	return fake;
}

describe("S5.4 node status", () => {
	it("reports nothing running on a clean project", async () => {
		const fake = makeContext();
		const result = await node(fake.ctx, "status");
		expect(result.ok && result.value).toMatchObject({
			pid: null,
			alive: false,
			portOpen: false,
			ownership: "absent",
		});
	});

	it("reports our own live node, port and all", async () => {
		const fake = withNode(makeContext(), 999);
		fake.net.openPorts.add(PORT);
		const result = await node(fake.ctx, "status");
		expect(result.ok && result.value).toMatchObject({ pid: 999, alive: true, portOpen: true, ownership: "own" });
	});

	it("calls another RuntimeKey's node foreign instead of reporting it as ours", async () => {
		const fake = withNode(makeContext(), 999, "other-runtime");
		const result = await node(fake.ctx, "status");
		expect(result.ok && result.value.ownership).toBe("foreign");
		expect(result.ok && result.value.notes.join("\n")).toContain("别的 RuntimeKey");
	});

	it("an open port with no record of ours is said to be somebody else's, not ours", async () => {
		const fake = makeContext();
		fake.net.openPorts.add(PORT);
		const result = await node(fake.ctx, "status");
		expect(result.ok && result.value.ownership).toBe("absent");
		expect(result.ok && result.value.portOpen).toBe(true);
		expect(result.ok && result.value.notes.join("\n")).toContain("多半是别处");
	});

	it("a corrupt manifest reads as absent, never as healthy", async () => {
		const fake = makeContext();
		fake.fs.write(fake.ctx.layout.debugPid, "{not json");
		expect(readNodeManifest(fake.ctx)).toBeNull();
		const result = await node(fake.ctx, "status");
		expect(result.ok && result.value.ownership).toBe("absent");
	});
});

describe("S5.4 node logs", () => {
	it("says where the log would be when there is none yet", async () => {
		const fake = makeContext();
		const result = await node(fake.ctx, "logs");
		expect(result.ok && result.value.log).toBe("");
		expect(result.ok && result.value.notes.join("\n")).toContain("先 start");
	});

	it("tails the requested number of lines", async () => {
		const fake = makeContext();
		fake.fs.put(fake.ctx.layout.debugLog, Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n"));
		const result = await node(fake.ctx, "logs", { lines: 3 });
		expect(result.ok && result.value.log).toBe("line97\nline98\nline99");
	});

	it("points at Cosmic's own log, so an empty tail is not read as 'nothing ran'", async () => {
		const fake = makeContext();
		fake.fs.put(fake.ctx.layout.debugLog, "banner");
		const result = await node(fake.ctx, "logs");
		expect(result.ok && result.value.notes.join("\n")).toContain("logback");
	});
});

describe("S5.4 node stop", () => {
	it("kills our own node hard, because Cosmic forks a process tree", async () => {
		const fake = withNode(makeContext(), 999);
		const result = await node(fake.ctx, "stop");
		expect(fake.proc.killed).toEqual([{ pid: 999, hard: true }]);
		expect(result.ok && result.value.stopped).toBe("killed");
		expect(fake.fs.exists(fake.ctx.layout.debugPid)).toBe(false);
	});

	it("refuses to touch another RuntimeKey's node", async () => {
		const fake = withNode(makeContext(), 999, "other-runtime");
		const result = await node(fake.ctx, "stop");
		expect(fake.proc.killed).toEqual([]);
		expect(result.ok && result.value.stopped).toBe("foreign");
		// The record stays: deleting it would lose the identity that protects it.
		expect(fake.fs.exists(fake.ctx.layout.debugPid)).toBe(true);
	});

	it("never kills by port when something is listening and nothing is ours", async () => {
		const fake = makeContext();
		fake.net.openPorts.add(PORT);
		const result = await node(fake.ctx, "stop");
		expect(fake.proc.killed).toEqual([]);
		expect(result.ok && result.value.stopped).toBe("absent");
		expect(result.ok && result.value.notes.join("\n")).toContain("不按端口杀");
	});

	it("clears residue left by a crashed node", async () => {
		const fake = withNode(makeContext(), 999, undefined, false);
		const result = await node(fake.ctx, "stop");
		expect(result.ok && result.value.stopped).toBe("absent");
		expect(fake.fs.exists(fake.ctx.layout.debugPid)).toBe(false);
	});
});

describe("S5.4 node start", () => {
	it("refuses when the runtime config is incomplete, before spawning anything", async () => {
		const fake = makeContext({ config: { user: null } });
		const result = await node(fake.ctx, "start");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("CONFIG_INCOMPLETE");
		expect(fake.proc.detached).toHaveLength(0);
	});

	it("starts the node from the pathing jar and records the RuntimeKey before waiting", async () => {
		const fake = makeContext();
		fake.net.openPorts.add(PORT);
		const result = await node(fake.ctx, "start");
		const spawned = fake.proc.detached.at(-1);
		expect(spawned?.command).toBe("java");
		expect(spawned?.args).toEqual([
			"-Xmx4g",
			"-XX:MaxMetaspaceSize=512m",
			"-Dfile.encoding=UTF-8",
			`-Dcosmic.runtimeKey=${fake.ctx.runtimeKeyId}`,
			"-jar",
			fake.ctx.layout.pathingJar,
		]);
		expect(readNodeManifest(fake.ctx)).toMatchObject({ keyId: fake.ctx.runtimeKeyId, port: PORT });
		expect(result.ok && result.value.portOpen).toBe(true);
		expect(result.ok && result.value.waitedSeconds).toBe(5);
	});

	it("does not start a second one when ours is already up", async () => {
		const fake = withNode(makeContext(), 999);
		fake.net.openPorts.add(PORT);
		const result = await node(fake.ctx, "start");
		expect(fake.proc.detached).toHaveLength(0);
		expect(result.ok && result.value.notes.join("\n")).toContain("已在运行");
	});

	it("refuses to start when another RuntimeKey's node holds the port", async () => {
		const fake = withNode(makeContext(), 999, "other-runtime");
		const result = await node(fake.ctx, "start");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("DEBUG_NODE_UNAVAILABLE");
		expect(fake.proc.detached).toHaveLength(0);
	});

	it("reports the log tail when the process dies during startup", async () => {
		const fake = makeContext();
		fake.fs.put(fake.ctx.layout.debugLog, "Caused by: java.lang.OutOfMemoryError");
		// startDetached registers the pid as live; dropping it models the exit.
		const originalStart = fake.proc.startDetached.bind(fake.proc);
		fake.proc.startDetached = (spec) => {
			const started = originalStart(spec);
			if (started.pid !== null) fake.proc.livePids.delete(started.pid);
			return started;
		};
		const result = await node(fake.ctx, "start");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("DEBUG_NODE_UNAVAILABLE");
			expect(String(result.error.detail.tail)).toContain("OutOfMemoryError");
		}
	});
});
