import { describe, expect, it } from "vitest";
import { refreshLaunchClasses } from "../../src/kernel/toolchain.ts";
import { type FakeContext, makeContext } from "./fake-context.ts";

const slash = (path: string): string => path.replace(/\\/g, "/");

/** Writes the launch class source into the debug module; `compiled` also writes an up-to-date .class after it. */
function launchClass(fake: FakeContext, compiled: boolean): string {
	const launch = fake.ctx.layout.launchModule;
	if (launch === null) throw new Error("fake context has no debug module");
	const src = `${slash(launch.src)}/demo/debug/DebugApplication.java`;
	fake.fs.put(src, "class DebugApplication {}");
	if (compiled) fake.fs.put(`${slash(launch.out)}/demo/debug/DebugApplication.class`, "class");
	return src;
}

function liveOwnServer(fake: FakeContext): void {
	fake.net.handler = () => ({ ok: true, text: "RESULT OK 0\nup\n" });
	fake.fs.write(
		fake.ctx.layout.serverPid,
		JSON.stringify({
			pid: 999,
			keyId: fake.ctx.runtimeKeyId,
			port: 1,
			startedAt: "",
			account: fake.ctx.config.account,
			user: fake.ctx.config.user,
		}),
	);
	fake.proc.livePids.add(999);
}

// 每个探针进程都照编译好的启动类连环境。启动类改了（补 zookeeper 密码、换环境）却没人编，
// 探针就一直拿旧配置去连，什么都不说。
describe("启动类改过就先编译调试模块", () => {
	it("源文件比 .class 新：编到调试模块的输出目录，常驻没起就不标", async () => {
		const fake = makeContext();
		launchClass(fake, true);
		const src = launchClass(fake, false); // 再写一遍源文件，比 .class 新
		const result = await refreshLaunchClasses(fake.ctx);
		expect(result.ok && result.value?.files.map(slash)).toEqual([src]);
		expect(result.ok && result.value?.note).toContain("demo/debug/DebugApplication.java");
		const javac = fake.proc.runsOf("javac");
		expect(javac).toHaveLength(1);
		const args = javac[0]?.args ?? [];
		expect(args[args.indexOf("-d") + 1]).toBe(fake.ctx.layout.launchModule?.out);
		expect(slash(args.at(-1) ?? "")).toBe(src);
		expect(fake.fs.exists(fake.ctx.layout.serverStale)).toBe(false);
	});

	it("没改过：不编", async () => {
		const fake = makeContext();
		launchClass(fake, true);
		const result = await refreshLaunchClasses(fake.ctx);
		expect(result.ok && result.value).toBeNull();
		expect(fake.proc.runsOf("javac")).toHaveLength(0);
	});

	it("常驻进程按旧配置起着：标重起（换类不会重跑启动类）", async () => {
		const fake = makeContext();
		liveOwnServer(fake);
		launchClass(fake, false);
		const result = await refreshLaunchClasses(fake.ctx);
		expect(result.ok && result.value).not.toBeNull();
		const mark = fake.fs.read(fake.ctx.layout.serverStale);
		expect(mark).toContain("启动类改过");
		expect(mark).not.toContain("[类]");
	});

	it("编不过：报编译失败，带 javac 原文", async () => {
		const fake = makeContext();
		launchClass(fake, false);
		fake.proc.handler = (spec) =>
			spec.command.endsWith("javac")
				? { status: 1, stderr: "DebugApplication.java:5: 错误: 需要';'" }
				: { status: 0 };
		const result = await refreshLaunchClasses(fake.ctx);
		expect(!result.ok && result.error.code).toBe("COMPILE_FAILED");
		expect(!result.ok && JSON.stringify(result.error.detail)).toContain("需要';'");
	});

	it("类路径清单还没生成：不编，交给生成它的那次 Gradle", async () => {
		const fake = makeContext({ unbuilt: true });
		launchClass(fake, false);
		const result = await refreshLaunchClasses(fake.ctx);
		expect(result.ok && result.value).toBeNull();
		expect(fake.proc.runsOf("javac")).toHaveLength(0);
	});
});
