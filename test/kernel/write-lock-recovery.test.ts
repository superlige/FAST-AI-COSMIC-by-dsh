import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fast } from "../../src/kernel/commands/fast.ts";
import { ok } from "../../src/kernel/errors.ts";
import { withProjectWriteLock } from "../../src/kernel/policy/project-write-lock.ts";
import {
	CORRUPT_LOCK_TOKEN,
	inspectProjectWriteLock,
	recoverProjectWriteLock,
} from "../../src/kernel/policy/write-lock-recovery.ts";
import { nodeFs } from "../../src/kernel/ports.ts";
import { addSource, type FakeContext, makeContext } from "./fake-context.ts";

function seedLock(
	fake: FakeContext,
	overrides: Partial<{ token: string; pid: number; runtimeKeyId: string; operation: string; acquiredAt: string }> = {},
): void {
	fake.fs.write(
		fake.ctx.layout.projectWriteLock,
		JSON.stringify({
			version: 1,
			token: "crashed-token",
			pid: 9999,
			runtimeKeyId: fake.ctx.runtimeKeyId,
			operation: "fast",
			acquiredAt: "2026-09-02T00:00:00.000Z",
			...overrides,
		}),
	);
}

describe("S4.4 stale lock inspection", () => {
	it("reports no lock as nothing to recover, not as a problem", () => {
		const fake = makeContext();
		const inspection = inspectProjectWriteLock(fake.ctx);
		expect(inspection.present).toBe(false);
		expect(inspection.recoverable).toBe(false);
		expect(inspection.recoveryToken).toBeNull();
	});

	it("withholds a recovery token while the owner is still running", () => {
		const fake = makeContext();
		seedLock(fake, { pid: 4321 });
		fake.proc.livePids.add(4321);
		const inspection = inspectProjectWriteLock(fake.ctx);
		expect(inspection.ownerLive).toBe(true);
		expect(inspection.recoverable).toBe(false);
		expect(inspection.recoveryToken).toBeNull();
	});

	it("names the token and the dead owner for crash residue", () => {
		const fake = makeContext();
		seedLock(fake, { operation: "probe:MetaProbe" });
		const inspection = inspectProjectWriteLock(fake.ctx);
		expect(inspection.ownerLive).toBe(false);
		expect(inspection.ownerSameRuntimeKey).toBe(true);
		expect(inspection.recoveryToken).toBe("crashed-token");
		expect(inspection.reason).toContain("probe:MetaProbe");
	});

	it("treats an unreadable manifest as recoverable under a named sentinel", () => {
		const fake = makeContext();
		fake.fs.write(fake.ctx.layout.projectWriteLock, "{ not json");
		const inspection = inspectProjectWriteLock(fake.ctx);
		expect(inspection.corrupt).toBe(true);
		expect(inspection.recoveryToken).toBe(CORRUPT_LOCK_TOKEN);
		expect(inspection.recoverable).toBe(true);
	});

	it("does not touch the lock while inspecting it", () => {
		const fake = makeContext();
		seedLock(fake);
		inspectProjectWriteLock(fake.ctx);
		inspectProjectWriteLock(fake.ctx);
		expect(fake.fs.exists(fake.ctx.layout.projectWriteLock)).toBe(true);
	});
});

describe("S4.4 stale lock recovery", () => {
	it("refuses to clear a lock whose owner is alive", () => {
		const fake = makeContext();
		seedLock(fake, { pid: 4321 });
		fake.proc.livePids.add(4321);
		const result = recoverProjectWriteLock(fake.ctx, { token: "crashed-token" });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("WRITE_LOCK_OWNER_ALIVE");
		expect(fake.fs.exists(fake.ctx.layout.projectWriteLock)).toBe(true);
	});

	it("refuses a token that is not the one on disk", () => {
		const fake = makeContext();
		seedLock(fake);
		const result = recoverProjectWriteLock(fake.ctx, { token: "guessed" });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("WRITE_LOCK_TOKEN_MISMATCH");
			expect(result.error.detail.expected).toBe("crashed-token");
		}
		expect(fake.fs.exists(fake.ctx.layout.projectWriteLock)).toBe(true);
	});

	it("says there is nothing to recover rather than inventing a success", () => {
		const fake = makeContext();
		const result = recoverProjectWriteLock(fake.ctx, { token: "crashed-token" });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("WRITE_LOCK_ABSENT");
	});

	it("clears the named lock and lets the next writer in", async () => {
		const fake = makeContext();
		seedLock(fake);
		const blocked = await fast(fake.ctx, []);
		expect(blocked.ok).toBe(false);
		if (!blocked.ok) {
			expect(blocked.error.code).toBe("PROJECT_WRITE_LOCKED");
			expect(blocked.error.detail.ownerToken).toBe("crashed-token");
			expect(blocked.error.detail.ownerLive).toBe(false);
		}

		const recovered = recoverProjectWriteLock(fake.ctx, { token: "crashed-token" });
		expect(recovered.ok).toBe(true);
		expect(fake.fs.exists(fake.ctx.layout.projectWriteLock)).toBe(false);

		const after = await withProjectWriteLock(fake.ctx, "fast", async () => ok("second"));
		expect(after).toEqual(ok("second"));
	});

	it("leaves no quarantine file behind", () => {
		const fake = makeContext();
		seedLock(fake);
		recoverProjectWriteLock(fake.ctx, { token: "crashed-token" });
		const leftovers = [...fake.fs.files.keys()].filter((path) => path.includes("cosmic-agent-write.lock"));
		expect(leftovers).toEqual([]);
	});

	it("puts the lock back when another window acquires it mid-recovery", () => {
		const fake = makeContext();
		seedLock(fake);
		const realRename = fake.fs.tryRename.bind(fake.fs);
		// The exact race the read-then-delete version loses: the crashed lock is
		// released and a live window takes it in the instant before the cleanup.
		fake.ctx.ports.fs.tryRename = (from: string, to: string): boolean => {
			fake.fs.write(
				fake.ctx.layout.projectWriteLock,
				JSON.stringify({
					version: 1,
					token: "live-token",
					pid: 4321,
					runtimeKeyId: fake.ctx.runtimeKeyId,
					operation: "fast",
					acquiredAt: "2026-09-02T00:01:00.000Z",
				}),
			);
			fake.ctx.ports.fs.tryRename = realRename;
			return realRename(from, to);
		};

		const result = recoverProjectWriteLock(fake.ctx, { token: "crashed-token" });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("WRITE_LOCK_TOKEN_MISMATCH");
			expect(result.error.detail.found).toBe("live-token");
			expect(result.error.detail.restored).toBe(true);
		}
		expect(JSON.parse(fake.fs.read(fake.ctx.layout.projectWriteLock)).token).toBe("live-token");
	});

	it("clears an unreadable lock under the sentinel token", () => {
		const fake = makeContext();
		fake.fs.write(fake.ctx.layout.projectWriteLock, "half-written");
		const guessed = recoverProjectWriteLock(fake.ctx, { token: "crashed-token" });
		expect(guessed.ok).toBe(false);

		const result = recoverProjectWriteLock(fake.ctx, { token: CORRUPT_LOCK_TOKEN });
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value.corrupt).toBe(true);
		expect(fake.fs.exists(fake.ctx.layout.projectWriteLock)).toBe(false);
	});
});

describe("S4.4 crash residue reporting", () => {
	it("says the interrupted compile left unverified classes, not just 'unlocked'", () => {
		const fake = makeContext();
		addSource(fake, "demo-biz", "a/Done.java", { compiled: true });
		addSource(fake, "demo-biz", "a/Interrupted.java");
		seedLock(fake);

		const result = recoverProjectWriteLock(fake.ctx, { token: "crashed-token" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.freshness.fresh).toBe(false);
		expect(result.value.freshness.staleFiles).toContain("demo-biz/src/main/java/a/Interrupted.java");
		expect(result.value.followUp.join("\n")).toContain("cosmic_fast");
	});

	it("warns that an interrupted write probe may have written half of a shared change", () => {
		const fake = makeContext();
		seedLock(fake, { operation: "probe:MetaApplyProbe" });
		const result = recoverProjectWriteLock(fake.ctx, { token: "crashed-token" });
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value.followUp.join("\n")).toContain("probe:MetaApplyProbe");
	});

	it("reports a surviving resident JVM of this RuntimeKey", () => {
		const fake = makeContext();
		seedLock(fake);
		fake.fs.write(
			fake.ctx.layout.serverPid,
			JSON.stringify({
				pid: 777,
				keyId: fake.ctx.runtimeKeyId,
				port: 41001,
				startedAt: "",
				account: fake.ctx.config.account,
				user: fake.ctx.config.user,
			}),
		);
		fake.proc.livePids.add(777);
		const result = recoverProjectWriteLock(fake.ctx, { token: "crashed-token" });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.residentJvm).toBe("own-live");
			expect(result.value.followUp.join("\n")).toContain("常驻 JVM");
		}
	});

	it("says the project is clean when the crash left nothing behind", () => {
		const fake = makeContext();
		addSource(fake, "demo-biz", "a/Done.java", { compiled: true });
		seedLock(fake);
		const result = recoverProjectWriteLock(fake.ctx, { token: "crashed-token" });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.freshness.fresh).toBe(true);
			expect(result.value.followUp).toHaveLength(1);
			expect(result.value.followUp[0]).toContain("可以直接重试");
		}
	});
});

describe("S4.4 rename port", () => {
	it("moves the real file and refuses a missing source", () => {
		const root = mkdtempSync(join(tmpdir(), "cosmic-recover-"));
		try {
			const from = join(root, "a.lock");
			const to = join(root, "quarantine", "a.lock.moved");
			writeFileSync(from, "manifest", "utf8");
			expect(nodeFs.tryRename(from, to)).toBe(true);
			expect(nodeFs.exists(from)).toBe(false);
			expect(nodeFs.read(to)).toBe("manifest");
			expect(nodeFs.tryRename(from, to)).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
