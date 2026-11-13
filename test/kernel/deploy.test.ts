/**
 * S5.4 deploy.
 *
 * Three things that are not in the frozen implementation and are the reason this
 * file exists: the project write lock (gradle writes the tree `fast` compiles
 * into), the resident JVM restart respecting ownership, and the restart outcome
 * being a field rather than a printed line.
 */

import { describe, expect, it } from "vitest";
import { deploy } from "../../src/kernel/commands/deploy.ts";
import { type FakeContext, makeContext } from "./fake-context.ts";

function twoModules(): FakeContext {
	return makeContext({ config: { codeModules: ["zlgd-hhx", "zlgd-common"] } });
}

/** JDK 8 loads its compiler from tools.jar; without one the resident host cannot restart. */
function withJdk(fake: FakeContext): FakeContext {
	fake.fs.put("C:/jdk/lib/tools.jar", "tools");
	return fake;
}

describe("S5.4 deploy", () => {
	it("runs :module:deployJar offline for every code module by default", async () => {
		const fake = twoModules();
		const result = await deploy(fake.ctx);
		const gradle = fake.proc.runsOf("gradlew.bat").at(-1);
		expect(gradle?.args).toEqual([":zlgd-hhx:deployJar", ":zlgd-common:deployJar", "--offline"]);
		expect(result.ok && result.value.modules).toEqual(["zlgd-hhx", "zlgd-common"]);
		expect(result.ok && result.value.scoped).toBe(false);
		expect(result.ok && result.value.libCus).toBe("D:/cosmic/mservice-cosmic/lib/cus");
	});

	it("narrows to the named modules and says the default was all of them", async () => {
		const fake = twoModules();
		const result = await deploy(fake.ctx, { modules: ["zlgd-hhx"] });
		expect(fake.proc.runsOf("gradlew.bat").at(-1)?.args).toEqual([":zlgd-hhx:deployJar", "--offline"]);
		expect(result.ok && result.value.scoped).toBe(true);
		expect(result.ok && result.value.notes.join("\n")).toContain("缩过范围");
	});

	it("refuses a module name that is not configured rather than silently skipping it", async () => {
		const fake = twoModules();
		const result = await deploy(fake.ctx, { modules: ["zlgd-typo"] });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("MODULE_SCOPE_INVALID");
		expect(fake.proc.runs).toHaveLength(0);
	});

	it("refuses on an incomplete runtime config before touching gradle", async () => {
		const fake = makeContext({ config: { isv: null } });
		const result = await deploy(fake.ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("CONFIG_INCOMPLETE");
		expect(fake.proc.runs).toHaveLength(0);
	});

	// S4.4 row 5, through the second command that writes the project build tree.
	it("refuses while another writer holds the project lock", async () => {
		const fake = twoModules();
		fake.proc.livePids.add(777);
		fake.fs.write(
			fake.ctx.layout.projectWriteLock,
			JSON.stringify({
				version: 1,
				token: "other",
				pid: 777,
				runtimeKeyId: "other-runtime",
				operation: "fast",
				acquiredAt: "2026-09-04T00:00:00.000Z",
			}),
		);
		const result = await deploy(fake.ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("PROJECT_WRITE_LOCKED");
		expect(fake.proc.runs).toHaveLength(0);
	});

	it("releases the lock afterwards", async () => {
		const fake = twoModules();
		await deploy(fake.ctx);
		expect(fake.fs.exists(fake.ctx.layout.projectWriteLock)).toBe(false);
	});

	it("reports a gradle failure with its own code, not as a successful deploy", async () => {
		const fake = twoModules();
		fake.proc.handler = () => ({ status: 1, stdout: "FAILURE: deployJar" });
		const result = await deploy(fake.ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("DEPLOY_FAILED");
	});

	/**
	 * A resident JVM of ours that really stops answering after SHUTDOWN, so the
	 * stop takes the real path: ping -> ours -> stop. If anything spawned a
	 * replacement host it would answer again, which is what the R6 test below
	 * detects.
	 */
	function withOwnResident(fake: FakeContext): FakeContext {
		fake.fs.write(
			fake.ctx.layout.serverPid,
			JSON.stringify({
				pid: 321,
				keyId: fake.ctx.runtimeKeyId,
				port: 1,
				startedAt: "",
				account: fake.ctx.config.account,
				user: fake.ctx.config.user,
			}),
		);
		fake.proc.livePids.add(321);
		let up = true;
		fake.net.handler = (_port, lines) => {
			if (!up && fake.proc.detached.length > 0) up = true;
			if (!up) return { ok: false, why: "ECONNREFUSED" };
			if (lines.join("\n").includes("SHUTDOWN")) {
				up = false;
				return { ok: true, text: "RESULT OK 0\nbye\n" };
			}
			return { ok: true, text: "RESULT OK 0\nready\n" };
		};
		return fake;
	}

	it("stops our own resident JVM, whose business classes are now stale", async () => {
		const fake = withOwnResident(
			withJdk(makeContext({ config: { codeModules: ["zlgd-hhx", "zlgd-common"] }, env: { JAVA_HOME: "C:/jdk" } })),
		);
		const result = await deploy(fake.ctx);
		expect(result.ok && result.value.resident).toBe("stopped");
		expect(fake.fs.exists(fake.ctx.layout.serverPid)).toBe(false);
	});

	/**
	 * R6 (docs/command-parity.md §9.6), found on a real machine and fixed here.
	 *
	 * Deploy replaces a jar inside the Cosmic runtime directory, and that
	 * directory's fingerprint is one of RuntimeKey's four components -- so the
	 * key changes across this command. A JVM started by deploy is therefore born
	 * under the OLD key: the next command computes the new key and neither reads
	 * that manifest nor connects to that port, so nobody ever claims it and
	 * `stop` reports absent while it is still resident. One leaked per deploy.
	 *
	 * The assertion is on the spawn, not on the reported field: `resident:
	 * "stopped"` would still be reported by a version that started a host and
	 * failed to notice, which is exactly the shape the real machine was in.
	 */
	it("does not leave a live old-key JVM behind: it starts no replacement host (R6)", async () => {
		const fake = withOwnResident(
			withJdk(makeContext({ config: { codeModules: ["zlgd-hhx", "zlgd-common"] }, env: { JAVA_HOME: "C:/jdk" } })),
		);
		const result = await deploy(fake.ctx);
		expect(result.ok && result.value.resident).toBe("stopped");
		expect(fake.proc.detached.filter((run) => run.args.includes("CosmicProbeServer"))).toEqual([]);
		// The port is silent afterwards -- nothing of ours is still listening.
		expect((await fake.ctx.ports.net.request(1, ["PING"], 1000)).ok).toBe(false);
	});

	it("says why it did not restart, so a cold first probe is not a surprise", async () => {
		const fake = withOwnResident(
			withJdk(makeContext({ config: { codeModules: ["zlgd-hhx", "zlgd-common"] }, env: { JAVA_HOME: "C:/jdk" } })),
		);
		const result = await deploy(fake.ctx);
		const notes = result.ok ? result.value.notes.join("\n") : "";
		expect(notes).toContain("RuntimeKey");
		expect(notes).toContain("全冷");
	});

	it("leaves a resident JVM it cannot prove is its own alone", async () => {
		const fake = twoModules();
		fake.fs.write(
			fake.ctx.layout.serverPid,
			JSON.stringify({ pid: 321, keyId: "other-runtime", port: 1, startedAt: "" }),
		);
		fake.proc.livePids.add(321);
		fake.net.handler = () => ({ ok: true, text: "RESULT OK 0\nready\n" });
		const result = await deploy(fake.ctx);
		expect(result.ok && result.value.resident).toBe("foreign");
		expect(fake.proc.killed).toEqual([]);
	});

	it("says nothing was running when nothing answers", async () => {
		const fake = twoModules();
		const result = await deploy(fake.ctx);
		expect(result.ok && result.value.resident).toBe("not-running");
	});

	// The frozen driver printed these two in the moment the command ran, because
	// the cheaper alternative is what people usually actually want.
	it("carries the 'use fast instead' advice on the result, not only in a console line", async () => {
		const fake = twoModules();
		const result = await deploy(fake.ctx);
		const notes = result.ok ? result.value.notes.join("\n") : "";
		expect(notes).toContain("cosmic_fast");
		expect(notes).toContain("只在用户明确要求时跑");
	});
});
