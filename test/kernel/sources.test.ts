import { describe, expect, it } from "vitest";
import {
	groupByModule,
	moduleOf,
	resolveSource,
	staleSources,
	stampClean,
	stampedClean,
} from "../../src/kernel/commands/sources.ts";
import { addSource, makeContext } from "./fake-context.ts";

describe("S3.1 source resolution", () => {
	it("resolves a class name under the code modules", () => {
		const fake = makeContext();
		const src = addSource(fake, "demo-biz", "com/demo/Order.java");
		const result = resolveSource(fake.ctx, "Order");
		expect(result.ok && result.value.replace(/\\/g, "/")).toBe(src);
	});

	it("refuses an ambiguous class name instead of picking one", () => {
		// Picking silently means editing one file and compiling the other, with
		// nothing reporting it.
		const fake = makeContext();
		addSource(fake, "demo-biz", "com/a/Order.java");
		addSource(fake, "demo-biz", "com/b/Order.java");
		const result = resolveSource(fake.ctx, "Order");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("SOURCE_AMBIGUOUS");
		expect(result.error.detail.candidates).toHaveLength(2);
	});

	it("returns an error rather than exiting when nothing matches", () => {
		const result = resolveSource(makeContext().ctx, "Nope");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("SOURCE_NOT_FOUND");
	});

	it("takes anything path-like as a path", () => {
		const fake = makeContext();
		addSource(fake, "demo-biz", "com/demo/Order.java");
		const byPath = resolveSource(fake.ctx, "demo-biz/src/main/java/com/demo/Order.java");
		expect(byPath.ok).toBe(true);
	});

	it("accepts a path spelled from the module source root -- the spelling the package name gives you", () => {
		const fake = makeContext();
		const src = addSource(fake, "demo-biz", "com/demo/Order.java");
		const result = resolveSource(fake.ctx, "com/demo/Order.java");
		expect(result.ok && result.value.split("\\").join("/")).toBe(src);
	});

	it("accepts a full class name -- the spelling FormPluginProbe and the code index print", () => {
		// 真机 2026-10-09：`zlgd.ygpt.form.X` 被当短名去找一个叫 `zlgd.ygpt.form.X.java` 的文件，
		// 类明明就在那儿，答 SOURCE_NOT_FOUND，白搭一轮。
		const fake = makeContext();
		const src = addSource(fake, "demo-biz", "com/demo/Order.java");
		const result = resolveSource(fake.ctx, "com.demo.Order");
		expect(result.ok && result.value.split("\\").join("/")).toBe(src);
	});

	it("names the same-named class when a full class name has the wrong package, and does not compile it", () => {
		const fake = makeContext();
		addSource(fake, "demo-biz", "com/demo/Order.java");
		const result = resolveSource(fake.ctx, "com.other.Order");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("SOURCE_NOT_FOUND");
		expect(String(result.error.remedy).split("\\").join("/")).toContain("com/demo/Order.java");
	});

	it("refuses a module-relative path that exists under two code modules", () => {
		const fake = makeContext({ config: { codeModules: ["demo-biz", "demo-ext"] } });
		addSource(fake, "demo-biz", "com/demo/Order.java");
		addSource(fake, "demo-ext", "com/demo/Order.java");
		const result = resolveSource(fake.ctx, "com/demo/Order.java");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("SOURCE_AMBIGUOUS");
		expect(result.error.detail.candidates).toHaveLength(2);
	});

	it("says where the class actually lives when a wrong path is given", () => {
		// The class name is the part of a wrong path that is usually still right.
		const fake = makeContext();
		addSource(fake, "demo-biz", "com/demo/Order.java");
		const result = resolveSource(fake.ctx, "wrong/place/Order.java");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("SOURCE_NOT_FOUND");
		expect(String(result.error.remedy).split("\\").join("/")).toContain("com/demo/Order.java");
	});
});

describe("S3.1 staleness", () => {
	it("lists sources newer than their class file", () => {
		const fake = makeContext();
		addSource(fake, "demo-biz", "com/demo/Fresh.java", { compiled: true });
		const stale = addSource(fake, "demo-biz", "com/demo/Edited.java");
		expect(staleSources(fake.ctx).map((f) => f.replace(/\\/g, "/"))).toEqual([stale]);
	});

	it("counts a never-compiled source as stale", () => {
		const fake = makeContext();
		addSource(fake, "demo-biz", "com/demo/New.java");
		expect(staleSources(fake.ctx)).toHaveLength(1);
	});
});

describe("S3.1 module grouping", () => {
	it("groups by owning module because javac -d is single-valued", () => {
		const fake = makeContext({ config: { codeModules: ["demo-biz", "demo-shared"] } });
		addSource(fake, "demo-biz", "A.java");
		addSource(fake, "demo-shared", "B.java");
		const files = staleSources(fake.ctx);
		const grouped = groupByModule(fake.ctx, files);
		expect(grouped.ok).toBe(true);
		if (!grouped.ok) return;
		expect(grouped.value.map((g) => g.module.name).sort()).toEqual(["demo-biz", "demo-shared"]);
	});

	it("names every file that belongs to no code module", () => {
		const fake = makeContext();
		const outsider = "D:/proj/demo-debug/src/main/java/DebugApp.java";
		fake.fs.put(outsider, "class DebugApp {}");
		const grouped = groupByModule(fake.ctx, [outsider]);
		expect(grouped.ok).toBe(false);
		if (!grouped.ok) expect(grouped.error.code).toBe("SOURCE_OUTSIDE_MODULES");
	});

	it("attributes a file to its module", () => {
		const fake = makeContext();
		const src = addSource(fake, "demo-biz", "com/demo/Order.java");
		expect(moduleOf(fake.ctx, src)?.name).toBe("demo-biz");
		expect(moduleOf(fake.ctx, "D:/elsewhere/X.java")).toBeNull();
	});
});

describe("S3.1 lint stamps", () => {
	it("expires by itself when the file changes", () => {
		const fake = makeContext();
		const src = addSource(fake, "demo-biz", "com/demo/Order.java");
		stampClean(fake.ctx, [src]);
		expect(stampedClean(fake.ctx, [src])).toBe(true);
		// Editing bumps the mtime, so the stamp can never let an unchecked file through.
		fake.fs.put(src, "class Order { void x() {} }");
		expect(stampedClean(fake.ctx, [src])).toBe(false);
	});

	it("never reports an empty set as clean", () => {
		expect(stampedClean(makeContext().ctx, [])).toBe(false);
	});

	it("keeps stamps in the RuntimeKey cache, not in the project build dir", () => {
		// Two runtimes on the same project must not inherit each other's "clean".
		const a = makeContext({ cacheRoot: "D:/cache/key-a" });
		const b = makeContext({ cacheRoot: "D:/cache/key-b" });
		expect(a.ctx.layout.lintStamp).not.toBe(b.ctx.layout.lintStamp);
		expect(a.ctx.layout.lintStamp.replace(/\\/g, "/")).toContain("D:/cache/key-a");
	});
});
