/**
 * 绕过矩阵：每一行是一种可能把写入（或过期的验证）带过闸的走法，断言拒在调用方真会走的那条路上。
 *
 * 只写在这里、不测的两条边界（测了反而是假装）：
 *   - 模型的终端和读写文件工具本来就不在 cosmic 的闸里：自己敲 javac 的不经 cosmic 的 Java 入口、也不被扫。守的是 cosmic 这条链本身
 *     （唯一的例外是本机生产凭据目录，执行前拒，在 `test/dsh/gates.test.ts`）；
 *   - 临时探针的写 API 是实测出来的黑名单，没列到的写 API 会过扫描（`IMPLEMENTATION.md` 第六节登记着）。
 *
 * 写元数据要确认、确认的范围就是落库范围，在 `test/dsh/write.test.ts`；生产只读三道闸在 `prod-readonly.test.ts`。
 */

import { describe, expect, it } from "vitest";
import { type CallContext, CosmicHost, FRESHNESS_CHANGED_CODE, RUNTIME_CHANGED_CODE } from "../../src/dsh/host.ts";
import type { CosmicKernel, ProjectHandle } from "../../src/dsh/kernel.ts";
import { CosmicToolFailure } from "../../src/dsh/result.ts";
import { CosmicSession } from "../../src/dsh/session.ts";
import { runTool } from "../../src/dsh/tools/run.ts";
import { fast } from "../../src/kernel/commands/fast.ts";
import { resolveProbe } from "../../src/kernel/commands/probe.ts";
import { ok } from "../../src/kernel/errors.ts";
import { captureFreshness, type FreshnessSnapshot, sameFreshness } from "../../src/kernel/freshness.ts";
import { scanAdHocProbe } from "../../src/kernel/policy/probe-scan.ts";
import { withProjectWriteLock } from "../../src/kernel/policy/project-write-lock.ts";
import { AD_HOC_FORBIDDEN, READ_ONLY_TYPES } from "../../src/kernel/policy/write-apis.ts";
import { inspectProjectWriteLock, recoverProjectWriteLock } from "../../src/kernel/policy/write-lock-recovery.ts";
import { isOwnLiveServer, readManifest, residentPort } from "../../src/kernel/probe/server.ts";
import { addSource, type FakeContext, makeContext } from "../kernel/fake-context.ts";

function crashedLock(fake: FakeContext, operation = "fast", token = "crashed-token"): string {
	fake.fs.write(
		fake.ctx.layout.projectWriteLock,
		JSON.stringify({
			version: 1,
			token,
			pid: 9999,
			runtimeKeyId: fake.ctx.runtimeKeyId,
			operation,
			acquiredAt: "2026-09-02T00:00:00.000Z",
		}),
	);
	return token;
}

const ROOT = "D:/demo/project";

function callFor(session: CosmicSession<ProjectHandle>): CallContext {
	return {
		tool: "cosmic_run",
		session,
		agent: undefined,
		signal: new AbortController().signal,
		startedAt: new Date().toISOString(),
		cwd: async () => ROOT,
	};
}

async function failureOf(work: Promise<unknown>): Promise<CosmicToolFailure> {
	try {
		await work;
	} catch (error) {
		if (error instanceof CosmicToolFailure) return error;
		throw error;
	}
	throw new Error("应当被拒，却成功了");
}

function snapshot(sourceFingerprint: string): FreshnessSnapshot {
	return {
		runtimeKeyId: "rk-1",
		sourceFingerprint,
		classFingerprint: "cls-1",
		sourceCount: 1,
		fresh: true,
		staleFiles: [],
		capturedAt: "2026-11-16T00:00:00.000Z",
	};
}

/** 一份够 cosmic_run 走到执行那一步的假内核；`run` 被调到几次记在 `calls.run`。 */
function fakeRunKernel(input: { runtimeKeys?: string[]; fingerprints?: string[] } = {}) {
	const calls = { open: 0, run: 0, freshness: 0 };
	const keys = input.runtimeKeys ?? ["rk-1"];
	const prints = input.fingerprints ?? ["src-1"];
	const kernel = {
		open: async () => {
			const key = keys[Math.min(calls.open, keys.length - 1)] as string;
			calls.open += 1;
			return { ok: true, value: { handle: {}, summary: { root: ROOT, runtimeKeyId: key } } };
		},
		prepareRun: async () => ({
			ok: true,
			value: { plan: {}, blockers: [], capsules: [], warnings: [], deferred: [] },
		}),
		freshness: async () => {
			const print = prints[Math.min(calls.freshness, prints.length - 1)] as string;
			calls.freshness += 1;
			return { ok: true, value: snapshot(print) };
		},
		run: async () => {
			calls.run += 1;
			return {
				ok: false,
				error: { toJSON: () => ({ code: "FAKE_STOP", message: "假内核到此为止", detail: {}, remedy: "" }) },
			};
		},
	} as unknown as CosmicKernel;
	return { kernel, calls };
}

describe("第 1 行：调用所依赖的事实在两次调用之间变了", () => {
	it("运行时身份变了：这次拒、清掉编译记录，内核的 run 一次都没叫", async () => {
		const { kernel, calls } = fakeRunKernel({ runtimeKeys: ["rk-1", "rk-2"] });
		const host = new CosmicHost(kernel);
		const session = new CosmicSession<ProjectHandle>();
		const call = callFor(session);
		await host.project(call, {});
		session.compiledAt = new Date().toISOString();

		const failure = await failureOf(runTool(host).execute({ argv: ["op", "demo_bill", "save"] }, call));
		expect(failure.code).toBe(RUNTIME_CHANGED_CODE);
		expect(session.project).toBeUndefined();
		expect(session.compiledAt).toBeUndefined();
		expect(calls.run).toBe(0);
	});

	it("编译之后源码在别处被改了：run 在进 JVM 之前拒", async () => {
		const { kernel, calls } = fakeRunKernel({ fingerprints: ["src-edited-outside"] });
		const host = new CosmicHost(kernel);
		const session = new CosmicSession<ProjectHandle>();
		const call = callFor(session);
		await host.project(call, {});
		// 上次 cosmic_fast 编完时记下的指纹
		session.freshness = snapshot("src-1");
		session.compiledAt = new Date().toISOString();

		const failure = await failureOf(runTool(host).execute({ argv: ["op", "demo_bill", "save"] }, call));
		expect(failure.code).toBe(FRESHNESS_CHANGED_CODE);
		expect(session.freshness).toBeUndefined();
		expect(calls.run).toBe(0);
	});

	it("本会话没编译过也没改过 Java（纯探查）：不拿别人的过期源码拦它", async () => {
		const { kernel, calls } = fakeRunKernel({ fingerprints: ["whatever"] });
		const host = new CosmicHost(kernel);
		const session = new CosmicSession<ProjectHandle>();
		const failure = await failureOf(runTool(host).execute({ argv: ["op", "demo_bill", "save"] }, callFor(session)));
		expect(failure.code).toBe("FAKE_STOP");
		expect(calls.freshness).toBe(0);
		expect(calls.run).toBe(1);
	});
});

describe("第 2 行：临时探针的路径越界", () => {
	const cases: [string, string][] = [
		["../evil.java", "上级目录"],
		["../../shared/evil.java", "多级上跳"],
		["sub/../../evil.java", "折返后越界"],
		["D:/elsewhere/evil.java", "工程外绝对路径"],
	];

	for (const [name, why] of cases) {
		it(`拒${why}：${name}`, () => {
			const fake = makeContext();
			const result = resolveProbe(fake.ctx, name);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error.code).toBe("PROBE_NOT_ALLOWED");
		});
	}

	it("拒塞进已发布探针目录的文件", () => {
		const fake = makeContext({ probes: ["MetaProbe"] });
		fake.fs.put(`${fake.ctx.layout.probesDir}/Planted.java`, "class Planted {}");
		const byName = resolveProbe(fake.ctx, "Planted");
		expect(byName.ok).toBe(false);
		if (!byName.ok) expect(byName.error.code).toBe("PROBE_NOT_ALLOWED");
	});

	it("工程里正经的临时探针照常能用", () => {
		const fake = makeContext();
		fake.fs.put(
			`${fake.ctx.projectRoot}/scratch/Read.java`,
			"class Read { void run(){ MetadataDao.readMeta(id); } }",
		);
		const result = resolveProbe(fake.ctx, "scratch/Read.java");
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value.adHoc).toBe(true);
	});
});

describe("第 3 行：源码和 class 在外面被换了", () => {
	it("时间戳看着新鲜，外面改过的源码也认得出", () => {
		const fake = makeContext();
		const src = addSource(fake, "demo-biz", "a/A.java", { compiled: true });
		const before = captureFreshness(fake.ctx);
		const entry = fake.fs.files.get(src);
		if (entry) entry.content = "class X { int changed; }";

		const after = captureFreshness(fake.ctx);
		expect(after.fresh).toBe(true);
		expect(sameFreshness(before, after)).toBe(false);
	});

	it("class 被换成不是这边编出来的也认得出", () => {
		const fake = makeContext();
		addSource(fake, "demo-biz", "a/A.java", { compiled: true });
		const before = captureFreshness(fake.ctx);
		const classFile = `${fake.ctx.layout.moduleDirs[0]?.out}/a/A.class`;
		const entry = fake.fs.files.get(classFile.replace(/\\/g, "/"));
		if (entry) entry.content = "swapped";

		expect(sameFreshness(before, captureFreshness(fake.ctx))).toBe(false);
	});
});

describe("第 4 行：临时探针里能绕开扫描的 Java 能力", () => {
	it("每一种够得着写入、扫描又看不见的能力都拒", () => {
		const samples: [string, string][] = [
			['Class<?> c = Class.forName("kd.bos.servicehelper.operation.SaveServiceHelper");', "反射"],
			['Method m = t.getClass().getDeclaredMethod("save");', "反射"],
			["URLClassLoader loader = new URLClassLoader(urls);", "动态类加载 / 脚本引擎"],
			['ScriptEngine engine = new ScriptEngineManager().getEngineByName("js");', "动态类加载 / 脚本引擎"],
			['new ProcessBuilder("cmd", "/c", "del").start();', "子进程"],
			["Connection conn = DriverManager.getConnection(url, u, p);", "裸 JDBC 连接"],
			['Files.write(Paths.get("x"), bytes);', "文件写入"],
			['new Socket("10.0.0.1", 80);', "网络访问"],
		];
		for (const [line, what] of samples) {
			expect(
				scanAdHocProbe(line).map((hit) => hit.what),
				line,
			).toContain(what);
		}
	});

	it("藏在正经读取后面的写入也拒", () => {
		const source = [
			"class Sneaky {",
			"  void run() {",
			"    Object meta = MetadataDao.readMeta(id, MetaCategory.Entity);",
			"    SaveServiceHelper.save(new DynamicObject[]{row});",
			"  }",
			"}",
		].join("\n");
		const hits = scanAdHocProbe(source);
		expect(hits.map((hit) => hit.what)).toContain("SaveServiceHelper");
		expect(hits[0]?.line).toBe(4);
	});

	it("名单里每条规则都触发得了", () => {
		// 永远不会命中的规则就是一块没人查的写入面，看上去又和正常工作的规则一模一样。
		for (const rule of AD_HOC_FORBIDDEN) {
			expect(
				scanAdHocProbe(rule.sample).map((hit) => hit.what),
				rule.what,
			).toContain(rule.what);
		}
	});

	it("每个只读豁免两个方向都守得住", () => {
		// 豁免是在名单上开的口子，所以两半都证：它要放的读放得过，同一个对象上的写照样拒，
		// 没登记的方法也拒——这样豁免才是白名单，而不是「这个类整个放行」。
		for (const entry of READ_ONLY_TYPES) {
			expect(scanAdHocProbe(entry.readSample), entry.readSample).toEqual([]);
			expect(
				scanAdHocProbe(entry.writeSample)
					.map((hit) => hit.what)
					.join(" "),
				entry.writeSample,
			).toContain(entry.what);
			expect(
				scanAdHocProbe(`${entry.type} r = new ${entry.type}();\nr.somethingNobodyMeasured(x);`).map(
					(hit) => hit.what,
				),
				entry.type,
			).toContain(`${entry.what}.somethingNobodyMeasured`);
		}
	});
});

describe("第 5 行：写锁争用和崩溃残留", () => {
	it("第一个写的人拿着工程写锁时，第二个被拒", async () => {
		const first = makeContext();
		const second = makeContext();
		second.ctx.ports.fs = first.fs;
		second.proc.pid = 5678;
		first.proc.livePids.add(first.proc.pid);
		second.proc.livePids.add(first.proc.pid);

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
		if (!refused.ok) expect(refused.error.detail.ownerLive).toBe(true);
		release?.();
		await held;
	});

	it("残留的锁再旧也不自己清", async () => {
		const fake = makeContext();
		crashedLock(fake);
		const blocked = await fast(fake.ctx, []);
		expect(blocked.ok).toBe(false);
		expect(fake.fs.exists(fake.ctx.layout.projectWriteLock)).toBe(true);
	});

	it("只回收点了名的那把锁", () => {
		const fake = makeContext();
		const token = crashedLock(fake);
		expect(recoverProjectWriteLock(fake.ctx, { token: "other" }).ok).toBe(false);
		expect(inspectProjectWriteLock(fake.ctx).recoveryToken).toBe(token);
		expect(recoverProjectWriteLock(fake.ctx, { token }).ok).toBe(true);
		expect(fake.fs.exists(fake.ctx.layout.projectWriteLock)).toBe(false);
	});

	it("拿锁的进程还活着就不让回收", () => {
		const fake = makeContext();
		const token = crashedLock(fake);
		fake.proc.livePids.add(9999);
		const result = recoverProjectWriteLock(fake.ctx, { token });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("WRITE_LOCK_OWNER_ALIVE");
	});
});

describe("第 6 行：跨工程、跨运行时的缓存", () => {
	it("两个运行时的 class 输出、编译戳、常驻端口互不相交", () => {
		const a = makeContext({ cacheRoot: "D:/cache/a", runtimeKeyId: "key-a" });
		const b = makeContext({ cacheRoot: "D:/cache/b", runtimeKeyId: "key-b" });
		expect(a.ctx.layout.probeClasses).not.toBe(b.ctx.layout.probeClasses);
		expect(a.ctx.layout.lintStamp).not.toBe(b.ctx.layout.lintStamp);
		expect(residentPort(a.ctx)).not.toBe(residentPort(b.ctx));
	});

	it("一个工程一把写锁：两个运行时写的还是同一棵 build 树", () => {
		const a = makeContext({ cacheRoot: "D:/cache/a", runtimeKeyId: "key-a" });
		const b = makeContext({ cacheRoot: "D:/cache/b", runtimeKeyId: "key-b" });
		expect(a.ctx.layout.projectWriteLock).toBe(b.ctx.layout.projectWriteLock);
	});

	it("不认领记在别的 RuntimeKey 名下的常驻 JVM", () => {
		const fake = makeContext({ runtimeKeyId: "key-a" });
		fake.fs.write(
			fake.ctx.layout.serverPid,
			JSON.stringify({ pid: 4242, keyId: "key-b", port: 41001, startedAt: "" }),
		);
		fake.proc.livePids.add(4242);
		expect(isOwnLiveServer(fake.ctx, readManifest(fake.ctx))).toBe(false);
	});
});
