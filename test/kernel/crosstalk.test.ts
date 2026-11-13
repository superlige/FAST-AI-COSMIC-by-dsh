/**
 * S3.5 crosstalk: switching parameters, sessions, projects and runtime
 * fingerprints must not share state, environment, cache or JVM.
 *
 * These tests are only possible because the kernel takes an explicit context.
 * Under the frozen driver the equivalent test cannot even be written: ROOT and
 * CFG are resolved at module load, so a second project in the same process would
 * be the first project.
 */

import { describe, expect, it } from "vitest";
import { fast } from "../../src/kernel/commands/fast.ts";
import { probe } from "../../src/kernel/commands/probe.ts";
import { staleSources } from "../../src/kernel/commands/sources.ts";
import { baseChildEnv, childEnv, FORWARDED_ENV_KEYS } from "../../src/kernel/context.ts";
import { isOwnLiveServer, readManifest, residentPort, stopServer } from "../../src/kernel/probe/server.ts";
import { addSource, makeContext } from "./fake-context.ts";

const probeSource = 'public class P { void x(){ req("E"); } }';

describe("S3.5 no state shared between two contexts", () => {
	it("keeps two projects' file sets apart in one process", () => {
		const a = makeContext({ root: "D:/projA", cacheRoot: "D:/cache/a", runtimeKeyId: "key-a" });
		const b = makeContext({ root: "D:/projB", cacheRoot: "D:/cache/b", runtimeKeyId: "key-b" });
		addSource(a, "demo-biz", "OnlyInA.java");
		expect(staleSources(a.ctx)).toHaveLength(1);
		expect(staleSources(b.ctx)).toHaveLength(0);
	});

	it("gives each RuntimeKey its own cache, class output and stamps", () => {
		const a = makeContext({ cacheRoot: "D:/cache/a", runtimeKeyId: "key-a" });
		const b = makeContext({ cacheRoot: "D:/cache/b", runtimeKeyId: "key-b" });
		for (const field of ["probeClasses", "lintClasses", "lintStamp", "serverPid", "probeHotOut"] as const) {
			expect(a.ctx.layout[field]).not.toBe(b.ctx.layout[field]);
		}
	});

	it("keeps the project's Gradle artifacts shared and the agent's cache separate", () => {
		// Two runtimes on ONE project: the pathing jar is Gradle's and stays put; the
		// probe classes are the agent's and must not be reused across runtimes.
		const a = makeContext({ cacheRoot: "D:/cache/a", runtimeKeyId: "key-a" });
		const b = makeContext({ cacheRoot: "D:/cache/b", runtimeKeyId: "key-b" });
		expect(a.ctx.layout.pathingJar).toBe(b.ctx.layout.pathingJar);
		expect(a.ctx.layout.probeClasses).not.toBe(b.ctx.layout.probeClasses);
	});

	it("derives a different resident port per RuntimeKey", () => {
		// Measured on the real machine during S3: with the frozen fixed port, a kernel
		// opened on project B answers from the JVM project A started, and every reply
		// is a well-formed RESULT line either way -- nothing reveals the swap.
		const a = makeContext({ runtimeKeyId: "v1-aaaaaaaaaaaa" });
		const b = makeContext({ runtimeKeyId: "v1-bbbbbbbbbbbb" });
		expect(residentPort(a.ctx)).not.toBe(residentPort(b.ctx));
		expect(residentPort(a.ctx)).toBe(residentPort(makeContext({ runtimeKeyId: "v1-aaaaaaaaaaaa" }).ctx));
	});

	it("still honours an explicitly configured port", () => {
		const fake = makeContext({
			config: {
				probeServerPort: 8099,
				sources: { probeServerPort: { source: "环境变量", via: "PROBE_SERVER_PORT" } },
			},
		});
		expect(residentPort(fake.ctx)).toBe(8099);
	});
});

describe("S3.5 no environment shared between calls", () => {
	it("passes only declared keys to a child, not the agent's whole environment", () => {
		const fake = makeContext({
			env: { PATH: "C:/w", JAVA_HOME: "C:/jdk", ANTHROPIC_API_KEY: "secret", COSMIC_ACCOUNT: "acct" },
		});
		const env = baseChildEnv(fake.ctx);
		expect(env.JAVA_HOME).toBe("C:/jdk");
		expect(env.COSMIC_ACCOUNT).toBe("acct");
		// The frozen probe path forwarded every variable the driver held so cold and
		// hot would match; in a resident agent that hands the JVM the agent's secrets.
		expect(env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(FORWARDED_ENV_KEYS).not.toContain("ANTHROPIC_API_KEY");
	});

	it("scopes a per-call overlay to that call", () => {
		const fake = makeContext({ env: { PATH: "C:/w" } });
		const first = childEnv(fake.ctx, { META_ENTITY: "a" });
		const second = childEnv(fake.ctx, {});
		expect(first.META_ENTITY).toBe("a");
		expect(second.META_ENTITY).toBeUndefined();
	});

	it("does not let one probe's arguments reach the next probe", async () => {
		const fake = makeContext({ env: { COSMIC_STALE: "warn", PATH: "C:/w" }, probes: ["P"] });
		fake.fs.put(`${fake.ctx.layout.probesDir.replace(/\\/g, "/")}/P.java`, probeSource);
		fake.net.handler = () => ({ ok: false, why: "ETIMEDOUT" });
		await probe(fake.ctx, "P", { positional: ["first"] });
		await probe(fake.ctx, "P", { positional: [] });
		const javaRuns = fake.proc.runsOf("java");
		expect(javaRuns[0]?.env.E).toBe("first");
		expect(javaRuns[1]?.env.E).toBeUndefined();
	});

	it("reads COSMIC_STALE from the context, so two contexts can differ", async () => {
		const strict = makeContext({ probes: ["P"] });
		const lenient = makeContext({ env: { COSMIC_STALE: "warn", PATH: "C:/w" }, probes: ["P"] });
		for (const fake of [strict, lenient]) {
			fake.fs.put(`${fake.ctx.layout.probesDir.replace(/\\/g, "/")}/P.java`, probeSource);
			addSource(fake, "demo-biz", "A.java");
			fake.net.handler = () => ({ ok: false, why: "ETIMEDOUT" });
		}
		expect((await probe(strict.ctx, "P", { positional: ["x"] })).ok).toBe(false);
		expect((await probe(lenient.ctx, "P", { positional: ["x"] })).ok).toBe(true);
	});
});

describe("S3.5 no JVM shared or stolen", () => {
	it("does not adopt a JVM recorded under another RuntimeKey", () => {
		const fake = makeContext({ runtimeKeyId: "mine" });
		fake.fs.write(fake.ctx.layout.serverPid, JSON.stringify({ pid: 7, keyId: "theirs", port: 1, startedAt: "" }));
		fake.proc.livePids.add(7);
		expect(isOwnLiveServer(fake.ctx, readManifest(fake.ctx))).toBe(false);
	});

	it("refuses to stop a JVM it cannot prove is its own", async () => {
		const fake = makeContext({ runtimeKeyId: "mine" });
		fake.fs.write(fake.ctx.layout.serverPid, JSON.stringify({ pid: 7, keyId: "theirs", port: 1, startedAt: "" }));
		fake.proc.livePids.add(7);
		const stopped = await stopServer(fake.ctx);
		// On a developer machine that pid may by now belong to something else, and
		// killing by port is how an unrelated service goes down.
		expect(stopped.how).toBe("foreign");
		expect(fake.proc.killed).toHaveLength(0);
	});

	it("treats a corrupt manifest as 'no JVM of mine', never as a healthy one", () => {
		const fake = makeContext();
		fake.fs.write(fake.ctx.layout.serverPid, "{ not json");
		expect(readManifest(fake.ctx)).toBeNull();
	});

	it("records the key id when it starts one, so the next session can identify it", async () => {
		const fake = makeContext({ probes: ["P"] });
		fake.fs.put(`${fake.ctx.layout.probesDir.replace(/\\/g, "/")}/P.java`, probeSource);
		fake.proc.handler = (spec) =>
			spec.command === "where" ? { status: 0, stdout: "C:/jdk/bin/javac.exe" } : { status: 0 };
		fake.fs.put("C:/jdk/lib/tools.jar", "tools");
		// Nothing is listening until the kernel actually starts a JVM.
		fake.net.handler = () =>
			fake.proc.detached.length === 0
				? { ok: false, why: "ECONNREFUSED" }
				: { ok: true, text: "RESULT OK 0\n[PROBE] ok\n" };
		await probe(fake.ctx, "P", { positional: ["x"] });
		const manifest = readManifest(fake.ctx);
		expect(manifest?.keyId).toBe(fake.ctx.runtimeKeyId);
		expect(manifest?.port).toBe(residentPort(fake.ctx));
	});
});

describe("S3.5 no session state in module scope", () => {
	it("gives repeated calls on one context the same answer regardless of order", async () => {
		const a = makeContext({ cacheRoot: "D:/cache/a", runtimeKeyId: "key-a" });
		const b = makeContext({ cacheRoot: "D:/cache/b", runtimeKeyId: "key-b" });
		addSource(a, "demo-biz", "A.java");
		addSource(b, "demo-biz", "B.java");
		const first = await fast(a.ctx, []);
		const other = await fast(b.ctx, []);
		const again = await fast(a.ctx, []);
		expect(first.ok && first.value.files).toEqual(["demo-biz\\src\\main\\java\\A.java"]);
		expect(other.ok && other.value.files).toEqual(["demo-biz\\src\\main\\java\\B.java"]);
		// The second project's run must not have changed the first project's answer.
		expect(again.ok && again.value.files).toEqual(first.ok ? first.value.files : []);
	});
});
