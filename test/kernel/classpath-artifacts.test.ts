import { describe, expect, it } from "vitest";
import { build } from "../../src/kernel/commands/build.ts";
import { refreshIndexIfStale } from "../../src/kernel/commands/impact.ts";
import { artifactState, ensureBuilt } from "../../src/kernel/toolchain.ts";
import { fakeArgfile, makeContext } from "./fake-context.ts";

// 2026-09-22 真机报告：工程连 build 目录一起换了地方，两份类路径清单里写的还是旧路径。
// 文件都在，cosmic 就照用：本工程所有类（新的、老的）都加载不到，fast 却说编译成功，
// 重起常驻 JVM 也不重新生成，agent 白试三轮。
const MOVED = '-cp "D:/old-place/proj/demo-biz/build/classes/java/main;D:/cosmic/lib/bos-core-8.0.jar"\n';
const modules = { codeModules: ["demo-biz"] };

const gradleRuns = (fake: ReturnType<typeof makeContext>) =>
	fake.proc.runs.filter((run) => run.command.includes("gradlew")).length;

/** A Gradle run that, like the real one, rewrites the argfile for the project where it now is. */
const regeneratingGradle = (fake: ReturnType<typeof makeContext>, argfile = fakeArgfile(fake.ctx.layout)) => {
	fake.proc.handler = (spec) => {
		if (spec.args.some((arg) => arg.includes("cosmicJavacArgs"))) fake.fs.put(fake.ctx.layout.javacArgs, argfile);
		return { status: 0 };
	};
};

describe("类路径清单要对得上当前工程", () => {
	it("列着每个代码模块的 class 目录才算能用，斜杠方向和大小写不算差别", () => {
		const fake = makeContext({ config: modules });
		expect(artifactState(fake.ctx)).toEqual({ state: "ok" });
		const out = fake.ctx.layout.moduleDirs[0]?.out ?? "";
		fake.fs.put(fake.ctx.layout.javacArgs, `-cp "${out.replace(/\//g, "\\").toUpperCase()}\\;D:/x.jar"\n`);
		expect(artifactState(fake.ctx)).toEqual({ state: "ok" });
	});

	it("缺文件是 missing，指向别处是 stale 并说出缺哪个模块", () => {
		expect(artifactState(makeContext({ unbuilt: true }).ctx)).toEqual({ state: "missing" });
		const fake = makeContext({ config: modules });
		fake.fs.put(fake.ctx.layout.javacArgs, MOVED);
		const state = artifactState(fake.ctx);
		expect(state.state).toBe("stale");
		if (state.state === "stale") expect(state.reason).toContain("demo-biz 的 class 目录");
	});

	it("清单过期时重新生成，并让常驻 JVM 下次用之前重起", async () => {
		const fake = makeContext({ config: modules });
		fake.fs.put(fake.ctx.layout.javacArgs, MOVED);
		regeneratingGradle(fake);
		const built = await ensureBuilt(fake.ctx);
		expect(built.ok && built.value.ran).toBe(true);
		expect(built.ok && built.value.reason).toContain("demo-biz");
		expect(gradleRuns(fake)).toBe(2);
		expect(artifactState(fake.ctx)).toEqual({ state: "ok" });
		// 已经在跑的 JVM 用的还是旧类路径，不能接着拿它跑探针。
		expect(fake.fs.read(fake.ctx.layout.serverStale)).toContain("类路径清单重新生成过");
	});

	it("重新生成之后还对不上就报错，不在每次调用时再付一遍 Gradle", async () => {
		const fake = makeContext({ config: modules });
		fake.fs.put(fake.ctx.layout.javacArgs, MOVED);
		regeneratingGradle(fake, MOVED);
		const built = await ensureBuilt(fake.ctx);
		expect(built.ok).toBe(false);
		if (!built.ok) {
			expect(built.error.code).toBe("BUILD_FAILED");
			expect(built.error.remedy).toContain("build/classes/java/main");
		}
	});

	it("清单对得上就不跑 Gradle", async () => {
		const fake = makeContext({ config: modules });
		const built = await ensureBuilt(fake.ctx);
		expect(built.ok && built.value.ran).toBe(false);
		expect(gradleRuns(fake)).toBe(0);
	});

	it("build 不带 force 也会重新生成过期的清单，并在结果里说为什么", async () => {
		const fake = makeContext({ config: modules });
		fake.fs.put(fake.ctx.layout.javacArgs, MOVED);
		regeneratingGradle(fake);
		const result = await build(fake.ctx);
		expect(result.ok && result.value.ran).toBe(true);
		expect(result.ok && result.value.notes.join()).toContain("重新生成了类路径清单");
	});

	it("打开工程时自动补代码关系表不替人跑 Gradle，只说清单过期", async () => {
		const fake = makeContext({ config: modules });
		fake.fs.put(fake.ctx.layout.javacArgs, MOVED);
		const refreshed = await refreshIndexIfStale(fake.ctx);
		expect(refreshed.state).toBe("skipped");
		expect(refreshed.text).toContain("下一次编译会重新生成");
		expect(fake.proc.runs).toHaveLength(0);
	});
});
