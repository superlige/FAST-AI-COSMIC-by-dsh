import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ok } from "../../src/kernel/errors.ts";
import { withProjectWriteLock } from "../../src/kernel/policy/project-write-lock.ts";
import { nodeFs } from "../../src/kernel/ports.ts";
import { makeContext } from "./fake-context.ts";

describe("S4.3 project write lock", () => {
	it("uses an atomic create in the real filesystem port", () => {
		const root = mkdtempSync(join(tmpdir(), "cosmic-lock-"));
		const lock = join(root, "build", "write.lock");
		try {
			expect(nodeFs.tryCreate(lock, "first")).toBe(true);
			expect(nodeFs.tryCreate(lock, "second")).toBe(false);
			expect(nodeFs.read(lock)).toBe("first");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses a concurrent writer and releases only the owner's lock", async () => {
		const first = makeContext();
		const second = makeContext();
		second.ctx.ports.fs = first.fs;
		second.proc.pid = 5678;
		first.proc.livePids.add(first.proc.pid);

		let release: (() => void) | undefined;
		const waiting = new Promise<void>((resolve) => {
			release = resolve;
		});
		const held = withProjectWriteLock(first.ctx, "fast", async () => {
			await waiting;
			return ok("first");
		});

		const refused = await withProjectWriteLock(second.ctx, "probe:MetaProbe", async () => ok("second"));
		expect(refused.ok).toBe(false);
		if (!refused.ok) {
			expect(refused.error.code).toBe("PROJECT_WRITE_LOCKED");
			expect(refused.error.detail.ownerPid).toBe(first.proc.pid);
			expect(refused.error.detail.ownerOperation).toBe("fast");
		}
		expect(first.fs.exists(first.ctx.layout.projectWriteLock)).toBe(true);

		release?.();
		expect(await held).toEqual(ok("first"));
		expect(first.fs.exists(first.ctx.layout.projectWriteLock)).toBe(false);
	});

	it("fails closed on a stale lock instead of racing to delete it", async () => {
		const fake = makeContext();
		fake.fs.write(
			fake.ctx.layout.projectWriteLock,
			JSON.stringify({
				version: 1,
				token: "old",
				pid: 9999,
				runtimeKeyId: "old-runtime",
				operation: "fast",
				acquiredAt: "2026-09-02T00:00:00.000Z",
			}),
		);
		const result = await withProjectWriteLock(fake.ctx, "fast", async () => ok("never"));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.detail.ownerLive).toBe(false);
		expect(fake.fs.exists(fake.ctx.layout.projectWriteLock)).toBe(true);
	});

	it("releases the lock when the protected operation fails", async () => {
		const fake = makeContext();
		await expect(
			withProjectWriteLock(fake.ctx, "fast", async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(fake.fs.exists(fake.ctx.layout.projectWriteLock)).toBe(false);
	});
});
