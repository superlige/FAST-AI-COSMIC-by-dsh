import { describe, expect, it } from "vitest";
import { captureFreshness, sameFreshness } from "../../src/kernel/freshness.ts";
import { addSource, makeContext } from "./fake-context.ts";

describe("S4.3 source/class freshness evidence", () => {
	it("captures a fresh source and its expected class", () => {
		const fake = makeContext();
		addSource(fake, "demo-biz", "com/demo/Order.java", { compiled: true });
		const snapshot = captureFreshness(fake.ctx);
		expect(snapshot.fresh).toBe(true);
		expect(snapshot.sourceCount).toBe(1);
		expect(snapshot.staleFiles).toEqual([]);
	});

	it("detects a source edit even when timestamps still look fresh", () => {
		const fake = makeContext();
		const source = addSource(fake, "demo-biz", "Order.java", { compiled: true });
		const before = captureFreshness(fake.ctx);
		const oldSourceMs = fake.fs.files.get(source)?.mtimeMs;
		fake.fs.put(source, "class Order { void changed() {} }");
		const sourceEntry = fake.fs.files.get(source);
		if (sourceEntry && oldSourceMs !== undefined) sourceEntry.mtimeMs = oldSourceMs;
		const after = captureFreshness(fake.ctx);
		expect(after.fresh).toBe(true);
		expect(after.sourceFingerprint).not.toBe(before.sourceFingerprint);
		expect(sameFreshness(before, after)).toBe(false);
	});

	it("detects external class replacement by content, not only mtime", () => {
		const fake = makeContext();
		addSource(fake, "demo-biz", "Order.java", { compiled: true });
		const classFile = `${fake.ctx.layout.moduleDirs[0]?.out.replace(/\\/g, "/")}/Order.class`;
		const before = captureFreshness(fake.ctx);
		const oldClassMs = fake.fs.files.get(classFile)?.mtimeMs;
		fake.fs.put(classFile, "different class bytes");
		const classEntry = fake.fs.files.get(classFile);
		if (classEntry && oldClassMs !== undefined) classEntry.mtimeMs = oldClassMs;
		const after = captureFreshness(fake.ctx);
		expect(after.classFingerprint).not.toBe(before.classFingerprint);
		expect(sameFreshness(before, after)).toBe(false);
	});

	it("marks a source with no class as stale", () => {
		const fake = makeContext();
		addSource(fake, "demo-biz", "New.java");
		const snapshot = captureFreshness(fake.ctx);
		expect(snapshot.fresh).toBe(false);
		expect(snapshot.staleFiles).toEqual(["demo-biz/src/main/java/New.java"]);
	});
});
