/**
 * S54：仿真的发往浏览器的通道建成平台真类 ClientViewProxy 的那个宿主类（ClientChannelHook）。
 *
 * 它要用苍穹库里的 ASM，所以单独编：编不过（别的苍穹版本没有 ASM）常驻宿主照样起，
 * 探针按类名找不到它就退回动态代理。真正的换类只有真机测得了，见 docs/S54-run-form-incomplete.md。
 */

import { describe, expect, it } from "vitest";
import { ensureHostClasses } from "../../src/kernel/probe/server.ts";
import { makeContext } from "./fake-context.ts";

function javacRuns(fake: ReturnType<typeof makeContext>): string[][] {
	return fake.proc.runs.filter((run) => run.command === "javac").map((run) => run.args.map(String));
}

describe("ClientChannelHook 单独编译", () => {
	it("宿主编完再单独编它，它编不过宿主照样算编好了", async () => {
		const fake = makeContext();
		fake.fs.put(fake.ctx.layout.channelHookSrc, "package cosmic.headless; public final class ClientChannelHook {}");
		const hook = fake.ctx.layout.channelHookSrc;
		const original = fake.proc.runAsync.bind(fake.proc);
		fake.proc.runAsync = async (spec, signal) => {
			const result = await original(spec, signal);
			return spec.command === "javac" && spec.args.includes(hook)
				? { ...result, status: 1, stderr: "程序包org.objectweb.asm不存在" }
				: result;
		};

		const built = await ensureHostClasses(fake.ctx);
		expect(built.ok).toBe(true);

		const runs = javacRuns(fake);
		const host = runs.find((args) => args.includes(fake.ctx.layout.serverSrc));
		const own = runs.find((args) => args.includes(hook));
		expect(host).toBeDefined();
		expect(own).toBeDefined();
		// 不和宿主一起编：一起编的话缺 ASM 就整个宿主编不过、常驻 JVM 起不来
		expect(host).not.toContain(hook);
		expect(own).not.toContain(fake.ctx.layout.serverSrc);
	});

	it("它变了宿主要重编（漏算的话改了它什么都不发生，也不报错）", async () => {
		const fake = makeContext();
		const hook = fake.ctx.layout.channelHookSrc;
		fake.fs.put(hook, "package cosmic.headless; public final class ClientChannelHook {}");
		fake.fs.put(`${fake.ctx.layout.probeClasses}/CosmicProbeServer.class`, "class");
		fake.fs.put(hook, "package cosmic.headless; public final class ClientChannelHook { int changed; }");
		const built = await ensureHostClasses(fake.ctx);
		expect(built.ok && built.value).toBe(true);
	});
});
