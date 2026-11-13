import { describe, expect, it } from "vitest";
import { fast } from "../../src/kernel/commands/fast.ts";
import { probe } from "../../src/kernel/commands/probe.ts";
import { probeServer } from "../../src/kernel/commands/probe-server.ts";
import type { FileSystemPort } from "../../src/kernel/config/detect.ts";
import { loadConfig } from "../../src/kernel/config/load-config.ts";
import {
	markServerStale,
	readManifest,
	resolveHotSwap,
	staleServerIdentity,
	takeServerStale,
} from "../../src/kernel/probe/server.ts";
import { addSource, type FakeContext, type FakeContextInput, makeContext } from "./fake-context.ts";

/**
 * S27 3.1：改完代码不再整个重起常驻 JVM，先把变了的类换进去，换不进去再重起。
 *
 * 这里测的是 driver 这一半：什么时候试换类、换成了就不重起、换不成就照旧重起，
 * 以及 JRebel 开关怎么解析。宿主里真正的换类（Instrumentation.redefineClasses）只有真机测得了，见 S27 §10。
 */

const PROBE_SRC = `
public class MetaProbe {
  public static void main(String[] a) {
    String entity = req("META_ENTITY");
    String form = req("META_FORM");
  }
}
`;

function probeFake(input: FakeContextInput = {}): FakeContext {
	const fake = makeContext({ ...input, probes: ["MetaProbe"] });
	fake.fs.put(`${fake.ctx.layout.probesDir.replace(/\\/g, "/")}/MetaProbe.java`, PROBE_SRC);
	return fake;
}

function withOwnServer(fake: FakeContext, extra: Record<string, unknown> = {}): FakeContext {
	fake.fs.write(
		fake.ctx.layout.serverPid,
		JSON.stringify({
			pid: 321,
			keyId: fake.ctx.runtimeKeyId,
			port: 1,
			startedAt: "",
			account: fake.ctx.config.account,
			user: fake.ctx.config.user,
			...extra,
		}),
	);
	fake.proc.livePids.add(321);
	return fake;
}

/** 让「停掉再起」在假环境里走得通：SHUTDOWN 之后端口不应答，直到新 JVM 起来 */
function restartable(
	fake: FakeContext,
	reply: (lines: readonly string[]) => { ok: boolean; text?: string; why?: string },
) {
	let down = false;
	fake.net.handler = (_port, lines) => {
		if (lines[0] === "SHUTDOWN") {
			down = true;
			return { ok: true, text: "RESULT OK 0\n" };
		}
		if (down && fake.proc.detached.length === 0) return { ok: false, why: "ECONNREFUSED" };
		return reply(lines);
	};
	fake.proc.handler = (spec) =>
		spec.args.includes("javac") || spec.command === "where"
			? { status: 0, stdout: "C:/jdk/bin/javac.exe" }
			: { status: 0 };
	fake.fs.put("C:/jdk/lib/tools.jar", "tools");
}

const okReply = { ok: true, text: "RESULT OK 0\n[PROBE] done\n" };
const syncOk = {
	ok: true,
	text: "RESULT OK 0\nmode=instrument\nchanged=3\nredefined=2\nnotLoaded=1\nremoved=0\nms=180\nnames=zlgd.A,zlgd.B,zlgd.C\n",
};
const syncStructural = {
	ok: true,
	text: "RESULT ERR 1\nmode=instrument\nreason=结构变了，JDK 自带的换类换不了（class redefinition failed: attempted to add a method）\nnames=zlgd.A\n",
};

const heads = (fake: FakeContext): string[] => fake.net.requests.map((request) => request.lines[0] ?? "");

describe("S27 3.1 过期标记分两种", () => {
	it("每条原因都留着，全是「重编过」才算能换类", () => {
		const fake = makeContext();
		markServerStale(fake.ctx, "写了元数据（AddFieldProbe）");
		markServerStale(fake.ctx, "fast 编译了 1 个文件", "classes");
		// 先写元数据、再编译：只剩后一条的话，下次就只换类不重起，元数据那半边的旧缓存漏过去
		expect(takeServerStale(fake.ctx)).toEqual({
			reason: "写了元数据（AddFieldProbe）；fast 编译了 1 个文件",
			classesOnly: false,
		});
		expect(takeServerStale(fake.ctx)).toBeNull();

		markServerStale(fake.ctx, "fast 编译了 1 个文件", "classes");
		markServerStale(fake.ctx, "fast 编译了 1 个文件", "classes");
		expect(takeServerStale(fake.ctx)).toEqual({ reason: "fast 编译了 1 个文件", classesOnly: true });
	});

	it("老格式的标记（没有标签）按只能重起算", () => {
		const fake = makeContext();
		fake.fs.write(fake.ctx.layout.serverStale, "2026-09-06T00:00:00.000Z fast 编译了 1 个文件\n");
		expect(takeServerStale(fake.ctx)).toEqual({ reason: "fast 编译了 1 个文件", classesOnly: false });
	});
});

describe("S27 3.1 probe 用常驻 JVM 之前先换类", () => {
	it("只是重编过：先换类，换成了就不重起，换类发生在探针请求之前", async () => {
		const fake = withOwnServer(probeFake());
		markServerStale(fake.ctx, "fast 编译了 1 个文件", "classes");
		fake.net.handler = (_port, lines) => (lines[0] === "SYNC" ? syncOk : okReply);

		const result = await probe(fake.ctx, "MetaProbe", { positional: ["e", "f"] });

		expect(result.ok && result.value.path).toBe("hot");
		expect(fake.proc.detached).toHaveLength(0);
		expect(heads(fake)).not.toContain("SHUTDOWN");
		expect(heads(fake).indexOf("SYNC")).toBeLessThan(heads(fake).indexOf("PROBE"));
		expect(result.ok && result.value.notes.join("\n")).toContain(
			"已热替换 2 个类（180 毫秒，另 1 个还没加载过、用到时直接读新的），没重起",
		);
		expect(fake.fs.exists(fake.ctx.layout.serverStale)).toBe(false);
	});

	it("结构变了换不进去：照旧重起，并说清为什么", async () => {
		const fake = withOwnServer(probeFake());
		markServerStale(fake.ctx, "fast 编译了 1 个文件", "classes");
		const probesBeforeRestart: string[] = [];
		restartable(fake, (lines) => {
			if (lines[0] === "SYNC") return syncStructural;
			if (lines[0] === "PROBE" && fake.proc.detached.length === 0) probesBeforeRestart.push(lines[0]);
			return okReply;
		});

		const result = await probe(fake.ctx, "MetaProbe", { positional: ["e", "f"] });

		expect(result.ok && result.value.path).toBe("hot");
		expect(fake.proc.detached).toHaveLength(1);
		// 换类整批被拒，一个都没换：旧 JVM 上一个探针请求都不能发
		expect(probesBeforeRestart).toEqual([]);
		const notes = result.ok ? result.value.notes.join("\n") : "";
		expect(notes).toContain("热替换不了：结构变了");
		expect(notes).toContain("已重起");
	});

	it("元数据写过的标记不试换类，直接重起", async () => {
		const fake = withOwnServer(probeFake());
		markServerStale(fake.ctx, "写了元数据（AddFieldProbe）");
		restartable(fake, () => okReply);

		const result = await probe(fake.ctx, "MetaProbe", { positional: ["e", "f"] });

		expect(heads(fake)).not.toContain("SYNC");
		expect(fake.proc.detached).toHaveLength(1);
		expect(result.ok && result.value.notes.join("\n")).toContain("写了元数据（AddFieldProbe）");
	});

	it("宿主答 STALE：换完类重发一遍，不猜测变更来源", async () => {
		const fake = withOwnServer(probeFake());
		let probes = 0;
		fake.net.handler = (_port, lines) => {
			if (lines[0] === "SYNC") return syncOk;
			if (lines[0] === "PROBE") {
				probes++;
				if (probes === 1) return { ok: true, text: "RESULT STALE 1\n检测到 代码模块的 classes 目录 已变更\n" };
			}
			return okReply;
		};

		const result = await probe(fake.ctx, "MetaProbe", { positional: ["e", "f"] });

		expect(result.ok && result.value.path).toBe("hot");
		expect(probes).toBe(2);
		expect(fake.proc.detached).toHaveLength(0);
		const notes = result.ok ? result.value.notes.join("\n") : "";
		expect(notes).toContain("无法判断由谁操作");
		expect(notes).not.toContain("不是本会话编译的");
		expect(notes).toContain("已热替换 2 个类");
	});

	it("来源不明的变更换不进去：退回重起", async () => {
		const fake = withOwnServer(probeFake());
		let stale = true;
		restartable(fake, (lines) => {
			if (lines[0] === "SYNC") return syncStructural;
			if (lines[0] === "PROBE" && stale && fake.proc.detached.length === 0) {
				stale = false;
				return { ok: true, text: "RESULT STALE 1\n已变更\n" };
			}
			return okReply;
		});

		const result = await probe(fake.ctx, "MetaProbe", { positional: ["e", "f"] });

		expect(result.ok && result.value.path).toBe("hot");
		expect(fake.proc.detached).toHaveLength(1);
		expect(result.ok && result.value.notes.join("\n")).toContain("热替换不了（结构变了");
		expect(result.ok && result.value.notes.join("\n")).toContain("无法判断由谁操作");
		expect(result.ok && result.value.notes.join("\n")).not.toContain("另一个会话");
	});

	it("删除源码和 class 后 fast 无需编译，宿主仍可 STALE，不能归因到外部编译", async () => {
		const fake = withOwnServer(probeFake());
		const module = fake.ctx.layout.moduleDirs[0];
		if (!module) throw new Error("missing module");
		addSource(fake, module.name, "A.java", { compiled: true });
		fake.fs.remove(`${module.src}/A.java`);
		fake.fs.remove(`${module.out}/A.class`);
		const compiled = await fast(fake.ctx, []);
		expect(compiled.ok && compiled.value.nothingToDo).toBe(true);
		expect(fake.fs.exists(fake.ctx.layout.serverStale)).toBe(false);
		let probes = 0;
		fake.net.handler = (_port, lines) => {
			if (lines[0] === "SYNC") return { ok: true, text: "RESULT OK 0\nmode=instrument\nremoved=1\n" };
			if (lines[0] === "PROBE" && ++probes === 1) return { ok: true, text: "RESULT STALE 1\nclasses changed\n" };
			return okReply;
		};
		const result = await probe(fake.ctx, "MetaProbe", { positional: ["e", "f"] });
		expect(result.ok && result.value.path).toBe("hot");
		expect(probes).toBe(2);
		const notes = result.ok ? result.value.notes.join("\n") : "";
		expect(notes).toContain("可能新增、修改或删除");
		expect(notes).not.toMatch(/另一个会话|IDE|gradle|不是本会话/);
	});
});

describe("S27 3.1 换类方式与 JRebel 开关", () => {
	const JREBEL =
		"C:/Users/me/AppData/Roaming/JetBrains/IntelliJIdea2023.1/plugins/jr-ide-idea/lib/jrebel6/lib/jrebel64.dll";

	it("默认用 JDK 自带的换类：换类入口的 jar 在就挂 -javaagent", () => {
		const fake = makeContext();
		expect(resolveHotSwap(fake.ctx)).toEqual({ mode: "instrument", args: [], warning: null });
		fake.fs.put(fake.ctx.layout.hotSwapAgentJar, "jar");
		expect(resolveHotSwap(fake.ctx).args).toEqual([`-javaagent:${fake.ctx.layout.hotSwapAgentJar}`]);
	});

	it("jrebel=auto：在 IDEA 插件目录里找，找到就挂它、不挂自己的入口", () => {
		const fake = makeContext({ config: { jrebel: "auto" }, env: { APPDATA: "C:/Users/me/AppData/Roaming" } });
		fake.fs.put(fake.ctx.layout.hotSwapAgentJar, "jar");
		fake.fs.put(JREBEL, "dll");
		fake.fs.mkdirp("C:/Users/me/AppData/Roaming/JetBrains/IntelliJIdea2022.1");
		const plan = resolveHotSwap(fake.ctx);
		expect(plan.mode).toBe("jrebel");
		expect(plan.warning).toBeNull();
		// 路径分隔符随宿主系统，只比落点
		expect(plan.args[0]?.replace(/\\/g, "/")).toBe(`-agentpath:${JREBEL}`);
		expect(plan.args.slice(1)).toEqual(["-Dcosmic.jrebel=1"]);
	});

	it("要 JRebel 却找不到：退回 JDK 自带的换类，照实说一句，不让常驻 JVM 起不来", () => {
		const auto = makeContext({ config: { jrebel: "auto" }, env: { APPDATA: "C:/nowhere" } });
		expect(resolveHotSwap(auto.ctx).mode).toBe("instrument");
		expect(resolveHotSwap(auto.ctx).warning).toContain("没找到");
		const path = makeContext({ config: { jrebel: "D:/missing/jrebel64.dll" } });
		expect(resolveHotSwap(path.ctx).warning).toContain("D:/missing/jrebel64.dll");
	});

	it("开关变了算身份变了：JRebel 只能在启动时挂上，得重起", () => {
		const fake = withOwnServer(makeContext({ config: { jrebel: "D:/jr/jrebel64.dll" } }));
		fake.fs.put("D:/jr/jrebel64.dll", "dll");
		// 旧 manifest 没有 hotSwap，按 instrument 读
		expect(readManifest(fake.ctx)?.hotSwap).toBe("instrument");
		expect(staleServerIdentity(fake.ctx, readManifest(fake.ctx))).toBe("换类方式 instrument → jrebel");
		withOwnServer(fake, { hotSwap: "jrebel" });
		expect(staleServerIdentity(fake.ctx, readManifest(fake.ctx))).toBeNull();
	});

	it("起常驻 JVM 时建换类入口、挂上它，并把换类方式记进 manifest", async () => {
		const fake = makeContext({ env: { JAVA_HOME: "D:/jdk8" } });
		fake.fs.put("D:/jdk8/lib/tools.jar", "jar");
		let started = false;
		fake.net.handler = () => (started ? { ok: true, text: "RESULT OK 0\n" } : { ok: false, why: "ECONNREFUSED" });
		fake.proc.handler = (spec) => {
			// jar 工具建换类入口：假环境里替它把文件放上
			if (spec.command === "jar") fake.fs.put(spec.args[1] ?? "", "jar");
			return { status: 0, stdout: "" };
		};
		const original = fake.proc.startDetached.bind(fake.proc);
		fake.proc.startDetached = (spec) => {
			started = true;
			return original(spec);
		};

		const result = await probeServer(fake.ctx, "start");

		expect(result.ok).toBe(true);
		const jar = fake.proc.runsOf("jar")[0];
		expect(jar?.args.slice(0, 2)).toEqual(["cfm", fake.ctx.layout.hotSwapAgentJar]);
		expect(fake.fs.read(`${fake.ctx.layout.hotSwapAgentJar}.mf`)).toContain(
			"Premain-Class: CosmicProbeServer$HotSwapAgent",
		);
		expect(fake.proc.detached[0]?.args).toContain(`-javaagent:${fake.ctx.layout.hotSwapAgentJar}`);
		expect(readManifest(fake.ctx)?.hotSwap).toBe("instrument");
	});
});

describe("S27 3.1 jrebel 配置项", () => {
	const fs = (configJson: string): FileSystemPort => ({
		read: (path) => (path.replace(/\\/g, "/") === "D:/agent/config.json" ? configJson : ""),
		listJavaFiles: () => [],
	});
	const load = (configJson: string, env: Record<string, string> = {}) =>
		loadConfig({ root: "D:/proj", agentConfigDir: "D:/agent", env }, fs(configJson)).jrebel;

	it("默认关；true / on / auto 都是自动找；false / off 是关；别的当路径", () => {
		expect(load("{}")).toBeNull();
		expect(load('{"jrebel": true}')).toBe("auto");
		expect(load('{"jrebel": "on"}')).toBe("auto");
		expect(load('{"jrebel": false}')).toBeNull();
		expect(load('{"jrebel": "off"}')).toBeNull();
		expect(load('{"jrebel": "D:/jr/jrebel64.dll"}')).toBe("D:/jr/jrebel64.dll");
	});

	it("环境变量 COSMIC_JREBEL 单次覆盖配置", () => {
		expect(load('{"jrebel": "auto"}', { COSMIC_JREBEL: "off" })).toBeNull();
		expect(load("{}", { COSMIC_JREBEL: "auto" })).toBe("auto");
	});
});

describe("S59 dbLink 配置项：本机进程怎么连数据库", () => {
	const fs = (configJson: string): FileSystemPort => ({
		read: (path) => (path.replace(/\\/g, "/") === "D:/agent/config.json" ? configJson : ""),
		listJavaFiles: () => [],
	});
	const load = (configJson: string, env: Record<string, string> = {}) =>
		loadConfig({ root: "D:/proj", agentConfigDir: "D:/agent", env }, fs(configJson)).dbLink;

	it("默认省来回；platform / off / false 退回平台默认；认不得的值当默认", () => {
		expect(load("{}")).toBe("fast");
		expect(load('{"dbLink": "platform"}')).toBe("platform");
		expect(load('{"dbLink": "off"}')).toBe("platform");
		expect(load('{"dbLink": false}')).toBe("platform");
		expect(load('{"dbLink": "fast"}')).toBe("fast");
		expect(load('{"dbLink": "whatever"}')).toBe("fast");
	});

	it("环境变量 COSMIC_DB_LINK 单次覆盖配置", () => {
		expect(load("{}", { COSMIC_DB_LINK: "platform" })).toBe("platform");
		expect(load('{"dbLink": "platform"}', { COSMIC_DB_LINK: "fast" })).toBe("fast");
	});
});
