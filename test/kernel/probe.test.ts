import { describe, expect, it } from "vitest";
import {
	bindProbeArgs,
	prepareProbeInvocation,
	probe,
	probeRequiredNames,
	probeUsage,
	resolveProbe,
	SCHEDULE_STOPPED_NOTE,
} from "../../src/kernel/commands/probe.ts";
import { metaPending } from "../../src/kernel/impact/meta-state.ts";
import { PLATFORM_PROBES } from "../../src/kernel/policy/probe-freshness.ts";
import { dataWriteOverlay } from "../../src/kernel/policy/write-plan.ts";
import { decodeResponse, encodeProbeRequest } from "../../src/kernel/probe/protocol.ts";
import { sha256 } from "../../src/runtime/fingerprint.ts";
import { addSource, type FakeContext, type FakeContextInput, makeContext } from "./fake-context.ts";

const PROBE_SRC = `
public class MetaProbe {
  public static void main(String[] a) {
    String entity = req("META_ENTITY");
    String form = req("META_FORM");
    String opt = env("META_OPT", "x");
    String again = req("META_ENTITY");
  }
}
`;

/** A writer that takes a backup directory on APPLY, the way the layout writer does. */
const WRITER_SRC = PROBE_SRC.replace('String opt = env("META_OPT", "x");', 'String backup = env("LAYOUT_BACKUP", "");');

/** The shape released probes actually have: a header comment documenting each input. */
const DOCUMENTED_SRC = `
/**
 * 元数据探针。
 *
 *   META_ENTITY=实体标识   要查的实体（必填）
 *   META_FILTER=关键字     只打印含关键字的字段
 */
public class MetaProbe {
  public static void main(String[] a) {
    String entity = req("META_ENTITY");
    String filter = env("META_FILTER", "");
  }
}
`;

/** A context whose released probe set contains exactly one probe, on disk. */
function probeFake(input: FakeContextInput = {}, name = "MetaProbe", body = PROBE_SRC): FakeContext {
	const fake = makeContext({ ...input, probes: [name] });
	fake.fs.put(`${fake.ctx.layout.probesDir.replace(/\\/g, "/")}/${name}.java`, body);
	return fake;
}

const okReply = () => ({ ok: true, text: "RESULT OK 0\n[PROBE] done\n" });

/**
 * Writes a `spec target` confirmation into DRAFT.md (S5.4).
 *
 * APPLY=1 now requires one: the frozen driver read this file and would not even
 * start the JVM without it, and S5.4 wired that reader back in. A caller-supplied
 * grant may only narrow what is here, never add to it.
 */
const writeAuthorization = (targets: readonly string[], rollback = "删字段；已 backup") => ({
	targets,
	rollback,
	confirmationId: "confirm-1",
});

/** Marks the listening JVM as this context's own, which the hot path requires. */
function withOwnServer(fake: FakeContext): FakeContext {
	fake.fs.write(
		fake.ctx.layout.serverPid,
		// 身份两项要跟 config 对得上，否则这就是一个「别的账套/用户起的」常驻，会被停掉重起
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
	return fake;
}

describe("S3.1 probe resolution and argument binding", () => {
	it("refuses a hand-edited released probe before compilation or a Cosmic JVM", async () => {
		const reviewed = "public class FormRuleProbe { public static void run() {} }";
		const fake = makeContext({
			probes: ["FormRuleProbe"],
			releasedProbeDigests: { FormRuleProbe: sha256(reviewed) },
		});
		fake.fs.put(
			`${fake.ctx.layout.probesDir.replace(/\\/g, "/")}/FormRuleProbe.java`,
			`${reviewed}\n// hand-edited cache`,
		);

		const result = await probe(fake.ctx, "FormRuleProbe");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("PROBE_RELEASE_SOURCE_CHANGED");
		expect(result.error.detail.probeSourceMismatch).toBe(true);
		expect(result.error.remedy).toContain("重新 open 工程");
		expect(result.error.remedy).toContain("resources/probes");
		expect(fake.proc.runs).toEqual([]);
		expect(fake.proc.detached).toEqual([]);
	});

	it("resolves a released probe by class name", () => {
		const fake = probeFake();
		const resolved = resolveProbe(fake.ctx, "MetaProbe");
		// CosmicProbe reflects on the class name, so it is always the base name.
		expect(resolved.ok && resolved.value.cls).toBe("MetaProbe");
	});

	it("allows a read-only ad-hoc probe from the project", () => {
		// The reason to want ad-hoc probes at all is diagnosis, and diagnosis reads.
		const fake = probeFake();
		fake.fs.put("D:/proj/scratchpad/OneOff.java", "public class OneOff { void go() { DB.query(sql); } }");
		const resolved = resolveProbe(fake.ctx, "scratchpad/OneOff.java");
		expect(resolved.ok && resolved.value).toMatchObject({ cls: "OneOff", adHoc: true });
	});

	it("loads a packaged ad-hoc probe by its fully-qualified class name", () => {
		const fake = probeFake();
		fake.fs.put(
			"D:/proj/.cosmic-ai/probes/Packaged.java",
			"package demo.probes; public class Packaged { public static void run() {} }",
		);
		const resolved = resolveProbe(fake.ctx, ".cosmic-ai/probes/Packaged.java");
		expect(resolved.ok && resolved.value.cls).toBe("demo.probes.Packaged");
	});

	it("refuses an ad-hoc probe that writes, because IsvGuard is called BY probes", () => {
		// Code that never calls the guard is never checked by it, so an unreviewed
		// writer inside a JVM holding a live Cosmic connection is unguarded.
		const fake = probeFake();
		fake.fs.put("D:/proj/scratchpad/Evil.java", "public class Evil { void go() { SaveServiceHelper.save(rows); } }");
		const result = resolveProbe(fake.ctx, "scratchpad/Evil.java");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("PROBE_WRITES_REFUSED");
			expect(String(result.error.remedy)).toContain("SaveServiceHelper");
		}
	});

	it("refuses an ad-hoc probe that reaches for reflection", () => {
		const fake = probeFake();
		fake.fs.put("D:/proj/scratchpad/Sneak.java", 'class S { void go() { Class.forName("x"); } }');
		const result = resolveProbe(fake.ctx, "scratchpad/Sneak.java");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("PROBE_WRITES_REFUSED");
	});

	it("refuses a path that leaves the project root", () => {
		const fake = probeFake();
		fake.fs.put("D:/evil.java", "class evil {}");
		const result = resolveProbe(fake.ctx, "../evil.java");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("PROBE_NOT_ALLOWED");
	});

	it("refuses a file dropped into probesDir that is not in the released set", () => {
		// The allowed set comes from the embedded resources, never from a listing:
		// otherwise writing into the cache directory re-opens the same hole.
		const fake = probeFake();
		fake.fs.put(`${fake.ctx.layout.probesDir.replace(/\\/g, "/")}/Smuggled.java`, "public class Smuggled {}");
		const result = resolveProbe(fake.ctx, "Smuggled");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("PROBE_NOT_ALLOWED");
	});

	it("reports a released probe whose file is gone as missing, not as forbidden", () => {
		const result = resolveProbe(makeContext({ probes: ["MetaProbe"] }).ctx, "MetaProbe");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("PROBE_NOT_FOUND");
	});

	it("reads required inputs from the source in declaration order, ignoring defaults", () => {
		// Parsed from source rather than a table: the same "entity id" has five
		// different names across probes, and a table needs someone to maintain it.
		expect(probeRequiredNames(PROBE_SRC)).toEqual(["META_ENTITY", "META_FORM"]);
	});

	it("binds positional arguments and lets an explicit value win", () => {
		const bound = bindProbeArgs("MetaProbe", PROBE_SRC, ["ent", "form"], { META_ENTITY: "explicit" });
		expect(bound.ok && bound.value).toEqual({ META_ENTITY: "explicit", META_FORM: "form" });
	});

	it("refuses more positionals than the probe declares", () => {
		const bound = bindProbeArgs("MetaProbe", PROBE_SRC, ["a", "b", "c"], {});
		expect(bound.ok).toBe(false);
		if (!bound.ok) expect(bound.error.code).toBe("PROBE_ARGS_INVALID");
	});

	it("reads the probe's own header comment as its usage block", () => {
		// The remedy used to say "看探针源码开头的参数注释" to a caller who has no way
		// to open that source: released probes ship as embedded resources.
		const usage = probeUsage(DOCUMENTED_SRC);
		expect(usage.required).toEqual(["META_ENTITY"]);
		expect(usage.doc).toEqual([
			"META_ENTITY=实体标识   要查的实体（必填）",
			"META_FILTER=关键字     只打印含关键字的字段",
		]);
	});

	it("stops reading documentation at the first line of code", () => {
		// Otherwise any `X=1` in a string literal downstream becomes usage text.
		expect(probeUsage(PROBE_SRC).doc).toEqual([]);
	});

	it("puts the usage block into the arg errors instead of pointing at unreachable source", () => {
		const bound = bindProbeArgs("MetaProbe", DOCUMENTED_SRC, ["a", "b"], {});
		expect(bound.ok).toBe(false);
		if (!bound.ok) expect(bound.error.remedy).toContain("META_FILTER=关键字");
	});

	it("returns an overlay and never touches process.env", () => {
		// The frozen bindProbeArgs assigned into process.env, where the value outlived
		// the command and leaked into the next one.
		delete process.env.META_ENTITY;
		bindProbeArgs("MetaProbe", PROBE_SRC, ["ent", "form"], {});
		expect(process.env.META_ENTITY).toBeUndefined();
	});
});

describe("跑成功的那次也要说清「这个探针能干什么」（S20 批 4.2）", () => {
	it("成功返回带上一句话用途和入参表，读的是准备阶段那份源码", async () => {
		// 改之前这份说明只在调错时出现。真机一次会话里 23 次 bash 在翻缓存里的探针
		// Java 源码——模型没调错，它只是想知道这个探针还能问什么。
		const fake = probeFake({}, "MetaProbe", DOCUMENTED_SRC);
		const result = await probe(fake.ctx, "MetaProbe", { positional: ["ent"] });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.usage?.summary).toBe("元数据探针。");
		expect(result.value.usage?.inputs).toEqual([
			"META_ENTITY=实体标识   要查的实体（必填）",
			"META_FILTER=关键字     只打印含关键字的字段",
		]);
		expect(result.value.usage?.required).toEqual(["META_ENTITY"]);
	});

	it("源码里没有头注释就不给这张卡片——缺了看得见，而不是编一句", async () => {
		const fake = probeFake();
		const result = await probe(fake.ctx, "MetaProbe", { positional: ["e", "f"] });
		expect(result.ok && result.value.usage).toBeUndefined();
	});
});

describe("S3.1 missing probe input", () => {
	it("refuses before the JVM starts, so the usage line does not cost a cold start", async () => {
		// The probe's own req() would have reported this too -- 30-40s later, as a
		// stack trace, after paying for an initialisation that answers nothing.
		const fake = probeFake({}, "MetaProbe", DOCUMENTED_SRC);
		const result = await probe(fake.ctx, "MetaProbe");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("PROBE_PRECHECK_FAILED");
			expect(result.error.detail.blockers).toContainEqual(expect.stringContaining("PROBE_INPUT_MISSING"));
			expect(result.error.remedy).toContain("META_ENTITY=实体标识");
		}
		// Nothing was compiled and no JVM was started: the refusal is the whole run.
		expect(fake.proc.runs).toEqual([]);
		expect(fake.proc.detached).toEqual([]);
	});

	it("refuses a name a released probe does not read, and names the one it does (S37 2-B.1)", async () => {
		// 同一个实体在 MetaProbe 叫 META_ENTITY、DataProbe 叫 DATA_ENTITY —— 前缀不同而形状一样。
		// 以前内置探针不查误传的名字，只说「缺必填入参」，「我明明传了实体」和这句拒绝同时成立。
		const fake = probeFake({}, "MetaProbe", DOCUMENTED_SRC);
		const result = await probe(fake.ctx, "MetaProbe", { env: { DATA_ENTITY: "zlgd_x" } });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("PROBE_PRECHECK_FAILED");
			expect(result.error.detail.blockers).toContainEqual(expect.stringContaining("PROBE_ENV_UNKNOWN"));
			// 不猜相近的名字，给的是探针自己的入参表
			const unknown = (result.error.detail.blockers as string[]).find((line) => line.includes("PROBE_ENV_UNKNOWN"));
			expect(unknown).toContain("DATA_ENTITY 不是 MetaProbe 读取的环境变量");
			expect(unknown).toContain("META_ENTITY=");
			expect(unknown).not.toContain("相近");
			// 写错的名字删掉不是对的调用：那等于悄悄丢掉这个入参，所以不代写下一次调用
			expect(result.error.detail.nextCall ?? null).toBeNull();
		}
		expect(fake.proc.runs).toEqual([]);
	});

	it("does not check the names the kernel composes itself", async () => {
		// run / meta 拼的 env 名字写死在代码里，由 probe-env-names.test.ts 对着真探针源码核；
		// 这里的空壳探针不必抄一遍真名字。
		const fake = withOwnServer(probeFake({}, "MetaProbe", DOCUMENTED_SRC));
		fake.net.handler = () => okReply();
		const result = await probe(fake.ctx, "MetaProbe", {
			env: { META_ENTITY: "zlgd_x", OP_PKGS: "zlgd" },
			kernelEnv: true,
		});
		expect(result.ok).toBe(true);
	});

	it("does not call a probe's own optional inputs a mistake", async () => {
		// 仿真探针的可选入参（env("X", …)）比必填多得多：只认 req 的检查会把每一条
		// 普通的 run form 环境都说成写错了。
		const fake = probeFake({}, "MetaProbe", DOCUMENTED_SRC);
		const result = await probe(fake.ctx, "MetaProbe", { env: { META_FILTER: "abc" } });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.detail.blockers).not.toContainEqual(expect.stringContaining("PROBE_ENV_UNKNOWN"));
			expect(result.error.remedy).not.toContain("不是 MetaProbe 读的名字");
		}
	});

	it("is satisfied by a positional argument as much as by an explicit env value", async () => {
		const fake = withOwnServer(probeFake({}, "MetaProbe", DOCUMENTED_SRC));
		fake.net.handler = () => okReply();
		expect((await probe(fake.ctx, "MetaProbe", { positional: ["zlgd_x"] })).ok).toBe(true);
		expect((await probe(fake.ctx, "MetaProbe", { env: { META_ENTITY: "zlgd_x" } })).ok).toBe(true);
	});
});

describe("同一个问题问第三遍（2026-09-14 第二轮复盘）", () => {
	it("前两次输出一字不差时，第三次连 JVM 都不启动", async () => {
		const fake = withOwnServer(probeFake({}, "MetaProbe", DOCUMENTED_SRC));
		let asked = 0;
		fake.net.handler = () => {
			asked += 1;
			return okReply();
		};
		const call = () => probe(fake.ctx, "MetaProbe", { env: { META_ENTITY: "zlgd_x" } });
		expect((await call()).ok).toBe(true);
		expect((await call()).ok).toBe(true);
		expect(asked).toBe(2);

		const third = await call();
		expect(third.ok).toBe(false);
		if (!third.ok) {
			expect(third.error.code).toBe("PROBE_ANSWER_SETTLED");
			// 拦下来必须说出上次原文在哪，否则只是换一种卡住
			expect(third.error.remedy).toContain("直接读它");
			expect(String(third.error.detail.outFile)).toContain("out");
		}
		// 真正省下的是这一次：请求数没有涨
		expect(asked).toBe(2);
	});

	it("回归验证不受它拦：跑回归的职责就是一遍遍问同一个问题", async () => {
		const fake = withOwnServer(probeFake({}, "MetaProbe", DOCUMENTED_SRC));
		fake.net.handler = () => okReply();
		const call = () => probe(fake.ctx, "MetaProbe", { env: { META_ENTITY: "zlgd_x" }, countRepeats: false });
		expect((await call()).ok).toBe(true);
		expect((await call()).ok).toBe(true);
		expect((await call()).ok).toBe(true);
	});

	it("换个入参照跑：拦的是重复，不是这个探针", async () => {
		const fake = withOwnServer(probeFake({}, "MetaProbe", DOCUMENTED_SRC));
		fake.net.handler = () => okReply();
		expect((await probe(fake.ctx, "MetaProbe", { env: { META_ENTITY: "a" } })).ok).toBe(true);
		expect((await probe(fake.ctx, "MetaProbe", { env: { META_ENTITY: "a" } })).ok).toBe(true);
		expect((await probe(fake.ctx, "MetaProbe", { env: { META_ENTITY: "b" } })).ok).toBe(true);
	});
});

describe("S3.1 stale-class gate", () => {
	it("refuses a business-lane probe by default, because a stale run reports no error at all", async () => {
		// FormSim loads project plugin classes, so a stale .class is exactly the
		// silent-wrong-answer this gate exists for.
		const fake = probeFake({}, "FormSim");
		addSource(fake, "demo-biz", "A.java");
		const result = await probe(fake.ctx, "FormSim", { positional: ["e", "f"] });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("STALE_CLASSES");
			expect(result.error.detail.count).toBe(1);
			expect(result.error.detail.lane).toBe("business");
			// S25: every tool is mounted, so the remedy names the compiler and nothing else.
			expect(result.error.remedy).not.toContain("cosmic_lint");
		}
	});

	it("lets a platform-lane probe read metadata while unrelated business classes are stale", async () => {
		// The complaint this whole lane exists for: MetaProbe reads design-time
		// metadata out of the database and loads no project class, and used to be
		// refused because some form plugin three modules away had been edited.
		const fake = withOwnServer(probeFake({}, "MetaProbe"));
		addSource(fake, "demo-biz", "A.java");
		fake.net.handler = () => okReply();
		const result = await probe(fake.ctx, "MetaProbe", { positional: ["e", "f"] });
		expect(result.ok && result.value.stale).toEqual({
			files: 1,
			lane: "platform",
			mode: "warn",
			action: "warned",
		});
		// 放行了要说出来 —— platform 档的全部主张就是「那些改动跟这个结论无关」，
		// 读的人得有机会自己核一遍。
		expect(result.ok && result.value.notes.some((note) => note.includes("platform 档放行"))).toBe(true);
	});

	it("keeps a released probe that renders through the print engine in the strict lane", async () => {
		// PrintMeasureProbe reads as read-only and is not: it goes through
		// kd.bos.print.core.ExecuteService, so any print plugin on the template runs.
		const fake = probeFake({}, "PrintMeasureProbe");
		addSource(fake, "demo-biz", "A.java");
		const result = await probe(fake.ctx, "PrintMeasureProbe", { positional: ["e", "f"] });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("STALE_CLASSES");
	});

	it("puts an unregistered probe in the strict lane, so the whitelist fails safe", async () => {
		const fake = probeFake({}, "SomeProjectOwnProbe");
		addSource(fake, "demo-biz", "A.java");
		const result = await probe(fake.ctx, "SomeProjectOwnProbe", { positional: ["e", "f"] });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.detail.lane).toBe("business");
	});

	it("judges an ad-hoc probe by whether it names a package that is actually stale", async () => {
		const touching = withOwnServer(probeFake({}, "MetaProbe"));
		addSource(touching, "demo-biz", "kd/zlgd/scm/Order.java");
		touching.fs.put(`${touching.ctx.projectRoot}/Ad.java`, "import kd.zlgd.scm.Order;");
		touching.net.handler = () => okReply();
		const blocked = await probe(touching.ctx, "Ad.java");
		expect(blocked.ok).toBe(false);
		if (!blocked.ok) expect(blocked.error.detail.lane).toBe("business");

		// Same stale file, a probe that only queries the database: the stale package
		// is never named, so it is not this probe's problem.
		const querying = withOwnServer(probeFake({}, "MetaProbe"));
		addSource(querying, "demo-biz", "kd/zlgd/scm/Order.java");
		querying.fs.put(`${querying.ctx.projectRoot}/Ad.java`, "import kd.bos.db.DB; // 抄自 kd.zlgd.scm.Order");
		querying.net.handler = () => okReply();
		const passed = await probe(querying.ctx, "Ad.java");
		expect(passed.ok && passed.value.stale.lane).toBe("platform");
	});

	it("falls back to the strict lane when a stale file has no package to match", async () => {
		const fake = withOwnServer(probeFake({}, "MetaProbe"));
		addSource(fake, "demo-biz", "A.java");
		fake.fs.put(`${fake.ctx.projectRoot}/Ad.java`, "import kd.bos.db.DB;");
		fake.net.handler = () => okReply();
		const result = await probe(fake.ctx, "Ad.java");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.detail.lane).toBe("business");
	});

	it("lets verify tighten a platform-lane probe back to strict", async () => {
		const fake = probeFake({}, "MetaProbe");
		addSource(fake, "demo-biz", "A.java");
		const result = await probe(fake.ctx, "MetaProbe", { positional: ["e", "f"], strictFreshness: true });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("STALE_CLASSES");
			expect(result.error.detail.lane).toBe("business");
		}
	});

	it("compiles first under COSMIC_STALE=fast", async () => {
		const fake = withOwnServer(probeFake({ env: { COSMIC_STALE: "fast" } }));
		addSource(fake, "demo-biz", "A.java");
		fake.net.handler = () => okReply();
		const result = await probe(fake.ctx, "MetaProbe", { positional: ["e", "f"] });
		expect(result.ok && result.value.stale.action).toBe("compiled");
	});

	it("passes a business-lane probe through under COSMIC_STALE=warn, and says the answer may be stale", async () => {
		const fake = withOwnServer(probeFake({ env: { COSMIC_STALE: "warn" } }, "FormSim"));
		addSource(fake, "demo-biz", "A.java");
		fake.net.handler = () => okReply();
		const result = await probe(fake.ctx, "FormSim", { positional: ["e", "f"] });
		expect(result.ok && result.value.stale).toEqual({
			files: 1,
			lane: "business",
			mode: "warn",
			action: "warned",
		});
		expect(result.ok && result.value.notes.some((note) => note.includes("可能来自旧类"))).toBe(true);
	});

	it("lets EnvDiagProbe inspect the environment when unrelated business classes are stale", async () => {
		const fake = withOwnServer(
			probeFake({}, "EnvDiagProbe", "public class EnvDiagProbe { public static void run() {} }"),
		);
		addSource(fake, "demo-biz", "A.java");
		fake.net.handler = () => okReply();
		const result = await probe(fake.ctx, "EnvDiagProbe");
		expect(result.ok && result.value.stale).toEqual({
			files: 1,
			lane: "platform",
			mode: "warn",
			action: "warned",
		});
	});

	it("honours an explicit stale-class block for EnvDiagProbe", async () => {
		const fake = probeFake(
			{ env: { COSMIC_STALE: "block" } },
			"EnvDiagProbe",
			"public class EnvDiagProbe { public static void run() {} }",
		);
		addSource(fake, "demo-biz", "A.java");
		const result = await probe(fake.ctx, "EnvDiagProbe");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("STALE_CLASSES");
	});

	it("treats an unknown COSMIC_STALE value as block, not as permission", async () => {
		const fake = probeFake({ env: { COSMIC_STALE: "yes-please" } });
		addSource(fake, "demo-biz", "A.java");
		const result = await probe(fake.ctx, "MetaProbe", { positional: ["e", "f"] });
		expect(result.ok).toBe(false);
	});
});

describe("stale-class gate: read modes, the knob's location, and the way out", () => {
	const FORM_RULE_SRC = [
		"public class FormRuleProbe { public static void run() {",
		'  String form = env("RULE_FORM", null); String groupsSpec = env("RULE_GROUPS", null);',
		"} }",
	].join("\n");

	// The call from a real session: reading one layout's interface rules was
	// refused because sixteen unrelated plugins were half-edited, and the only
	// offered way out was to compile all of them.
	it("lets FormRuleProbe read a layout's rules while unrelated business classes are stale", async () => {
		const fake = withOwnServer(probeFake({}, "FormRuleProbe", FORM_RULE_SRC));
		addSource(fake, "demo-biz", "A.java");
		fake.net.handler = () => okReply();
		const result = await probe(fake.ctx, "FormRuleProbe", { env: { RULE_FORM: "zlgd_wtd_xnl" } });
		expect(result.ok && result.value.stale).toEqual({ files: 1, lane: "platform", mode: "warn", action: "warned" });
	});

	// S18 (user decision 2026-09-11): a metadata change no longer pays for somebody
	// else's uncompiled plugins. The writers load no business class, so their
	// write-mode dry-runs are judged like their reads.
	it("lets a FormRuleProbe write-mode dry-run through while unrelated business classes are stale", async () => {
		const fake = withOwnServer(probeFake({}, "FormRuleProbe", FORM_RULE_SRC));
		addSource(fake, "demo-biz", "A.java");
		fake.net.handler = () => okReply();
		const result = await probe(fake.ctx, "FormRuleProbe", { env: { RULE_FORM: "f", RULE_GROUPS: "g|a = 1|k" } });
		expect(result.ok && result.value.stale).toEqual({ files: 1, lane: "platform", mode: "warn", action: "warned" });
	});

	it("still holds a plugin-loading probe to current classes", async () => {
		const fake = probeFake({}, "FormSim");
		addSource(fake, "demo-biz", "A.java");
		const result = await probe(fake.ctx, "FormSim", { positional: ["e", "f"] });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("STALE_CLASSES");
			expect(result.error.detail.lane).toBe("business");
		}
	});

	it("names read-only exits and where COSMIC_STALE lives, instead of a knob the caller cannot reach", async () => {
		const fake = probeFake({}, "FormSim");
		addSource(fake, "demo-biz", "A.java");
		const result = await probe(fake.ctx, "FormSim", { positional: ["e", "f"] });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.remedy).toContain("cosmic_fast");
		expect(result.error.remedy).toContain("env 参数改不了它");
		// Every read-only probe the remedy offers really is one the gate lets through.
		const named = [...(result.error.remedy ?? "").matchAll(/\b([A-Z]\w+Probe)\b/g)].map(
			(match) => match[1] as string,
		);
		expect(named.length).toBeGreaterThan(0);
		expect(named.filter((name) => !PLATFORM_PROBES.includes(name))).toEqual([]);
	});

	it("refuses COSMIC_STALE as a probe input before anything starts, and hands back the call without it", async () => {
		// It used to go into the JVM's environment and do nothing, so the caller
		// got the identical STALE_CLASSES back with no idea why.
		const fake = probeFake({}, "FormSim");
		addSource(fake, "demo-biz", "A.java");
		const result = await probe(fake.ctx, "FormSim", {
			positional: ["e", "f"],
			env: { COSMIC_STALE: "warn", META_OPT: "1" },
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("PROBE_PRECHECK_FAILED");
		expect(result.error.detail.blockers).toContainEqual(expect.stringContaining("PROBE_ENV_DRIVER_ONLY"));
		expect(JSON.parse(String(result.error.detail.nextCall))).toEqual({
			name: "FormSim",
			positional: ["e", "f"],
			env: { META_OPT: "1" },
		});
		expect(fake.proc.runs).toEqual([]);
	});
});

describe("ad-hoc probes live outside the business source tree", () => {
	const LOOK = "package zlgd.zljy.opplugin; public class LookProbe { public static void run() {} }";

	it("refuses one under a code module's source root before javac, and names where it goes", async () => {
		// A real session wrote its probe into zlgd-hhx/src/main/java: every edit of the
		// throwaway file changed the source fingerprint and cost a cosmic_fast, and the
		// delivery receipt listed it three times.
		const fake = probeFake();
		const src = addSource(fake, "demo-biz", "zlgd/zljy/opplugin/LookProbe.java");
		fake.fs.put(src, LOOK);
		const result = await probe(fake.ctx, relativeToRoot(fake, src));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("PROBE_PRECHECK_FAILED");
		expect(result.error.detail.blockers).toContainEqual(expect.stringContaining("PROBE_IN_SOURCE_TREE"));
		expect(result.error.remedy).toContain("name=.cosmic-ai/probes/LookProbe.java");
		expect(fake.proc.runs).toEqual([]);
	});

	it("lets the same probe through from .cosmic-ai/probes/", () => {
		const fake = probeFake();
		fake.fs.put(`${fake.ctx.projectRoot.replace(/\\/g, "/")}/.cosmic-ai/probes/LookProbe.java`, LOOK);
		const prepared = prepareProbeInvocation(fake.ctx, ".cosmic-ai/probes/LookProbe.java");
		expect(prepared.ok && prepared.value.blockers).toEqual([]);
	});
});

function relativeToRoot(fake: FakeContext, file: string): string {
	return file.replace(/\\/g, "/").slice(fake.ctx.projectRoot.replace(/\\/g, "/").length + 1);
}

describe("S3.1 cold vs hot", () => {
	it("serializes an applying probe with the project write lock", async () => {
		const fake = probeFake();
		fake.proc.livePids.add(777);
		fake.fs.write(
			fake.ctx.layout.projectWriteLock,
			JSON.stringify({
				version: 1,
				token: "other",
				pid: 777,
				runtimeKeyId: "other-runtime",
				operation: "fast",
				acquiredAt: "2026-09-02T00:00:00.000Z",
			}),
		);
		const result = await probe(fake.ctx, "MetaProbe", {
			positional: ["e", "f"],
			env: { APPLY: "1" },
			writeAuthorization: writeAuthorization(["zlgd_x"]),
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("PROJECT_WRITE_LOCKED");
		expect(fake.proc.runsOf("java")).toHaveLength(0);
	});

	// 2026-09-19 真机（S27 1.13 → 1.14）：本地调试是轻量级部署，每个 JVM 的「Redis」是自己内存里的一份，
	// 平台保存清的是写入那个进程自己的缓存。冷进程加完字段，常驻进程 17 分钟后还读不到；
	// 改在常驻进程里写，同一进程马上读到新字段（单据、表单两层）——和本机 IDEA 里用开发平台改是一回事。
	it("写元数据的 APPLY 在常驻进程里写：本次确认的目标随这一次请求带过去，写完不重起", async () => {
		const fake = withOwnServer(probeFake());
		fake.net.handler = () => okReply();
		const result = await probe(fake.ctx, "MetaProbe", {
			positional: ["e", "f"],
			env: { APPLY: "1" },
			writeAuthorization: writeAuthorization(["zlgd_a", "zlgd_b"]),
		});
		expect(result.ok && result.value.path).toBe("hot");
		const sent = fake.net.requests.find((r) => r.lines[0] === "PROBE");
		expect(sent?.lines).toContain(`prop=cosmic.targets=${Buffer.from("zlgd_a,zlgd_b").toString("base64")}`);
		expect(sent?.lines).toContain(`env=APPLY=${Buffer.from("1").toString("base64")}`);
		expect(fake.proc.runsOf("java")).toHaveLength(0);
		expect(fake.fs.exists(fake.ctx.layout.serverStale)).toBe(false);
		// 代码关系表的元数据快照当场记待补（S17 4.6），写了哪些对象一起记下。
		expect(metaPending(fake.ctx)?.writes.map((w) => w.targets)).toEqual([["zlgd_a", "zlgd_b"]]);
		// 只读请求不带目标：这条通道只在确认过的 APPLY 上开。
		await probe(fake.ctx, "MetaProbe", { positional: ["e", "f"], countRepeats: false });
		expect(fake.net.requests.at(-1)?.lines.some((l) => l.startsWith("prop="))).toBe(false);
	});

	// S37 2-E.4：常驻进程默认不起调度服务，点名才起；冷进程跑完就退，派出去的后台任务没人接，所以不走冷进程。
	it("--schedule 只随这一次请求带给常驻进程；要走冷进程时拒绝，不偷偷降级", async () => {
		const fake = withOwnServer(probeFake());
		fake.net.handler = () => okReply();
		const result = await probe(fake.ctx, "MetaProbe", { positional: ["e", "f"], schedule: true });
		expect(result.ok && result.value.path).toBe("hot");
		const sent = fake.net.requests.find((r) => r.lines[0] === "PROBE");
		expect(sent?.lines).toContain(`prop=cosmic.schedule=${Buffer.from("1").toString("base64")}`);
		await probe(fake.ctx, "MetaProbe", { positional: ["e", "g"] });
		expect(fake.net.requests.at(-1)?.lines.some((l) => l.startsWith("prop="))).toBe(false);

		const cold = await probe(fake.ctx, "MetaProbe", { positional: ["e", "h"], schedule: true, cold: true });
		expect(!cold.ok && cold.error.code).toBe("PROBE_RESIDENT_UNAVAILABLE");
		expect(fake.proc.runsOf("java")).toHaveLength(0);
	});

	it("平台报「调度服务已停止」时照实说任务没派出去，不让「提交成功」单独站着", async () => {
		const fake = withOwnServer(probeFake());
		fake.net.handler = () => ({
			ok: true,
			text: "RESULT OK 0\n[PROBE] ✔ submit success=true\nkd.bos.exception.KDException: 调度服务已停止，请联系管理员。\n[PROBE-OK]\n",
		});
		const stopped = await probe(fake.ctx, "MetaProbe", { positional: ["e", "f"] });
		expect(stopped.ok && stopped.value.notes).toContain(SCHEDULE_STOPPED_NOTE);
		fake.net.handler = () => okReply();
		const quiet = await probe(fake.ctx, "MetaProbe", { positional: ["e", "g"] });
		expect(quiet.ok && quiet.value.notes).not.toContain(SCHEDULE_STOPPED_NOTE);
		// 已经落库的提交重跑不了，环境接手后流程也照样可能发起：两句旧说法都不能再出现
		expect(SCHEDULE_STOPPED_NOTE).not.toMatch(/重跑|没有发起工作流/);
	});

	it("常驻进程里写元数据没跑完才标记过期；写之前就被门禁拦下（未落库）的不标", async () => {
		const failed = withOwnServer(probeFake({}, "FormLayoutWriteProbe", WRITER_SRC));
		failed.net.handler = () => ({ ok: true, text: "RESULT ERR 1\n[PROBE] save -> {success=false}\n" });
		await probe(failed.ctx, "FormLayoutWriteProbe", {
			positional: ["e", "f"],
			env: { APPLY: "1", LAYOUT_BACKUP: ".cosmic-ai/layout-backup" },
			writeAuthorization: writeAuthorization(["zlgd_x"]),
		});
		expect(failed.fs.read(failed.ctx.layout.serverStale)).toContain("写元数据没跑完（FormLayoutWriteProbe）");

		const blocked = withOwnServer(probeFake({}, "FormLayoutWriteProbe", WRITER_SRC));
		blocked.net.handler = () => ({
			ok: true,
			text: "RESULT ERR 1\n[PROBE] 未落库：这次在写入之前就被拦下（IsvGuard），共享环境没有任何改动\n",
		});
		await probe(blocked.ctx, "FormLayoutWriteProbe", {
			positional: ["e", "f"],
			env: { APPLY: "1", LAYOUT_BACKUP: ".cosmic-ai/layout-backup" },
			writeAuthorization: writeAuthorization(["zlgd_x"]),
		});
		expect(blocked.fs.exists(blocked.ctx.layout.serverStale)).toBe(false);
		expect(metaPending(blocked.ctx)).toBeNull();
		expect(metaPending(failed.ctx)?.writes[0]?.probe).toBe("FormLayoutWriteProbe");
	});

	// 超时、半截断开时写入可能已经跑了一部分；原来会降级冷进程再跑一遍，就是写两次。
	it("写入发给常驻后没收到完整答复：报「可能写了一部分」，不冷进程重跑", async () => {
		const fake = withOwnServer(probeFake());
		fake.net.handler = (_port, lines) =>
			lines[0] === "PROBE" ? { ok: false, why: "timeout after 120000ms" } : { ok: true, text: "RESULT OK 0\n" };
		const result = await probe(fake.ctx, "MetaProbe", {
			positional: ["e", "f"],
			env: { APPLY: "1" },
			writeAuthorization: writeAuthorization(["zlgd_x"]),
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("PROBE_WRITE_UNCERTAIN");
		expect(fake.proc.runsOf("java")).toHaveLength(0);
		expect(fake.fs.read(fake.ctx.layout.serverStale)).toContain("写元数据没回话（MetaProbe）");
	});

	// 只读探针发完再验归属无所谓（重问一遍），写入发出去就收不回来。
	it("端口上是认不出归属的 JVM：写入一个字都不发给它，直接走冷进程", async () => {
		const fake = probeFake();
		fake.net.handler = () => okReply();
		const result = await probe(fake.ctx, "MetaProbe", {
			positional: ["e", "f"],
			env: { APPLY: "1" },
			writeAuthorization: writeAuthorization(["zlgd_x"]),
		});
		expect(result.ok && result.value.path).toBe("cold");
		expect(fake.net.requests.every((r) => r.lines[0] !== "PROBE")).toBe(true);
		expect(fake.proc.runsOf("java").at(-1)?.args).toContain("-Dcosmic.targets=zlgd_x");
		expect(fake.fs.read(fake.ctx.layout.serverStale)).toContain("写了元数据（MetaProbe）");
	});

	it("显式 --cold 写元数据仍标记常驻过期（失败也标：可能写了一半）；只读和回滚都不标", async () => {
		for (const exit of [0, 1]) {
			const fake = probeFake();
			fake.proc.handler = (spec) => (spec.command.endsWith("java") ? { status: exit } : { status: 0 });
			const result = await probe(fake.ctx, "MetaProbe", {
				positional: ["e", "f"],
				env: { APPLY: "1" },
				cold: true,
				writeAuthorization: writeAuthorization(["zlgd_x"]),
			});
			expect(result.ok && result.value.coldReason).toBe("--cold");
			expect(result.ok && result.value.exitCode).toBe(exit);
			expect(fake.fs.read(fake.ctx.layout.serverStale)).toContain("写了元数据（MetaProbe）");
		}
		for (const env of [{}, { ROLLBACK: "1" }] as Record<string, string>[]) {
			const fake = probeFake();
			await probe(fake.ctx, "MetaProbe", { positional: ["e", "f"], env, cold: true });
			expect(fake.fs.exists(fake.ctx.layout.serverStale)).toBe(false);
		}
	});

	it("refuses APPLY=1 without confirmed write targets", async () => {
		const fake = probeFake();
		const result = await probe(fake.ctx, "MetaProbe", { positional: ["e", "f"], env: { APPLY: "1" } });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("WRITE_TARGETS_UNCONFIRMED");
	});

	it("passes one-shot authorized targets to the JVM so IsvGuard can enforce them", async () => {
		const fake = probeFake();
		await probe(fake.ctx, "MetaProbe", {
			positional: ["e", "f"],
			env: { APPLY: "1" },
			writeAuthorization: writeAuthorization(["zlgd_a", "zlgd_b"]),
		});
		const java = fake.proc.runsOf("java").at(-1);
		expect(java?.args).toContain("-Dcosmic.targets=zlgd_a,zlgd_b");
	});

	it("refuses APPLY=1 when no one-shot authorization is present", async () => {
		const fake = probeFake();
		const result = await probe(fake.ctx, "MetaProbe", {
			positional: ["e", "f"],
			env: { APPLY: "1" },
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("WRITE_TARGETS_UNCONFIRMED");
		expect(fake.proc.runsOf("java")).toHaveLength(0);
	});

	it("uses exactly the targets in the user's confirmation", async () => {
		const fake = probeFake();
		const result = await probe(fake.ctx, "MetaProbe", {
			positional: ["e", "f"],
			env: { APPLY: "1" },
			writeAuthorization: writeAuthorization(["zlgd_b"]),
		});
		expect(fake.proc.runsOf("java").at(-1)?.args).toContain("-Dcosmic.targets=zlgd_b");
		expect(result.ok && result.value.notes.join("\n")).toContain("确认清单里的一项");
	});

	// The fourth item of the metadata-write admission list, arriving where the
	// write happens rather than sitting in a file nobody re-reads.
	it("reports the rollback path recorded with the confirmation", async () => {
		const fake = probeFake();
		const result = await probe(fake.ctx, "MetaProbe", {
			positional: ["e", "f"],
			env: { APPLY: "1" },
			writeAuthorization: writeAuthorization(["zlgd_a"], "删字段；已 backup 到 build/meta-backup/20260904"),
		});
		expect(result.ok && result.value.notes.join("\n")).toContain(
			"回滚路径：删字段；已 backup 到 build/meta-backup/20260904",
		);
	});

	it("refuses an incomplete one-shot authorization", async () => {
		const fake = probeFake();
		const result = await probe(fake.ctx, "MetaProbe", {
			positional: ["e", "f"],
			env: { APPLY: "1" },
			writeAuthorization: { targets: ["zlgd_a"], rollback: "", confirmationId: "confirm-1" },
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("WRITE_TARGETS_UNCONFIRMED");
		}
		expect(fake.proc.runsOf("java")).toHaveLength(0);
	});

	it("goes cold for ROLLBACK=1 and --cold without the target gate", async () => {
		const fake = probeFake();
		const rollback = await probe(fake.ctx, "MetaProbe", { positional: ["e", "f"], env: { ROLLBACK: "1" } });
		expect(rollback.ok && rollback.value.coldReason).toBe("ROLLBACK=1");
		const cold = await probe(fake.ctx, "MetaProbe", { positional: ["e", "f"], cold: true });
		expect(cold.ok && cold.value.coldReason).toBe("--cold");
	});

	it("S21 造测试数据的预演（PREVIEW=1）固定走冷进程：它和 ROLLBACK=1 一样是回滚事务里跑操作链", async () => {
		const fake = probeFake(
			{},
			"DataSeedProbe",
			'public class DataSeedProbe { void run() { req("SEED_ENTITY"); System.getenv("PREVIEW"); } }',
		);
		const result = await probe(fake.ctx, "DataSeedProbe", { env: { SEED_ENTITY: "zlgd_qty_wtd", PREVIEW: "1" } });
		expect(result.ok).toBe(true);
		expect(result.ok && result.value.path).toBe("cold");
		expect(result.ok && result.value.coldReason).toBe("写数据预演（回滚事务）");
	});

	it("S37 批 8：造数改数不带 APPLY 也直接落库、走常驻，内核把入参换算成 APPLY=1", async () => {
		for (const name of ["DataSeedProbe", "DataUpdateProbe"]) {
			const fake = withOwnServer(probeFake({}, name, `public class ${name} { void run() { } }`));
			fake.net.handler = () => okReply();
			const result = await probe(fake.ctx, name, { env: {} });
			expect(result.ok && result.value.path).toBe("hot");
			expect(fake.proc.runsOf("java")).toHaveLength(0);
		}
		expect(dataWriteOverlay({ X: "1" })).toEqual({ X: "1", APPLY: "1" });
		expect(dataWriteOverlay({ PREVIEW: "1", APPLY: "1" })).toEqual({ PREVIEW: "1" });
	});

	it("S27 造数改数落库不要授权、走常驻；写元数据的 APPLY 照旧没授权就拒", async () => {
		for (const name of ["DataSeedProbe", "DataUpdateProbe"]) {
			const fake = withOwnServer(probeFake({}, name, `public class ${name} { void run() { } }`));
			fake.net.handler = () => okReply();
			const result = await probe(fake.ctx, name, { env: { APPLY: "1" } });
			expect(result.ok && result.value.path).toBe("hot");
			// 没有 -Dcosmic.targets 可带：常驻进程的 JVM 参数是启动时定死的，所以落库本来就不能依赖它。
			expect(fake.proc.runsOf("java")).toHaveLength(0);
		}
		const meta = probeFake();
		const refused = await probe(meta.ctx, "MetaProbe", { positional: ["e", "f"], env: { APPLY: "1" } });
		expect(!refused.ok && refused.error.code).toBe("WRITE_TARGETS_UNCONFIRMED");
	});

	it("冷路径也报进度：那 30-60 秒以前界面上一个字都不变", async () => {
		const fake = probeFake();
		const stages: string[] = [];
		const result = await probe(fake.ctx, "MetaProbe", {
			positional: ["e", "f"],
			cold: true,
			onProgress: (stage) => stages.push(stage),
		});
		expect(result.ok).toBe(true);
		expect(stages).toEqual(["compiling-probe", "cold-start"]);
	});

	it("starts the resident JVM when nothing is listening, then retries", async () => {
		const fake = probeFake();
		fake.net.handler = () => (fake.proc.detached.length === 0 ? { ok: false, why: "ECONNREFUSED" } : okReply());
		fake.proc.handler = (spec) =>
			spec.args.includes("javac") || spec.command === "where"
				? { status: 0, stdout: "C:/jdk/bin/javac.exe" }
				: { status: 0 };
		fake.fs.put("C:/jdk/lib/tools.jar", "tools");
		const result = await probe(fake.ctx, "MetaProbe", { positional: ["e", "f"] });
		expect(result.ok && result.value.path).toBe("hot");
		expect(fake.proc.detached).toHaveLength(1);
	});

	it("keeps the event loop responsive while the resident host is compiled", async () => {
		const fake = probeFake({ env: { JAVA_HOME: "C:/jdk" } });
		fake.fs.put("C:/jdk/lib/tools.jar", "tools");
		fake.net.handler = () => (fake.proc.detached.length === 0 ? { ok: false, why: "ECONNREFUSED" } : okReply());
		fake.proc.run = () => {
			throw new Error("TUI startup must not use the blocking process path");
		};
		let releaseCompile: (() => void) | undefined;
		const compileGate = new Promise<void>((resolve) => {
			releaseCompile = resolve;
		});
		fake.proc.runAsync = async (spec) => {
			if (spec.command === "javac") await compileGate;
			return { status: 0, stdout: "", stderr: "", spawnError: null };
		};
		const progress: string[] = [];
		const pending = probe(fake.ctx, "MetaProbe", {
			positional: ["e", "f"],
			onProgress: (stage) => progress.push(stage),
		});
		let eventLoopAdvanced = false;
		await new Promise<void>((resolve) =>
			setTimeout(() => {
				eventLoopAdvanced = true;
				resolve();
			}, 0),
		);
		expect(eventLoopAdvanced).toBe(true);
		expect(progress).toContain("compiling-host");
		releaseCompile?.();
		const result = await pending;
		expect(result.ok && result.value.path).toBe("hot");
		expect(progress).toEqual([
			"checking-resident",
			"running-probe",
			"compiling-host",
			"starting-runtime",
			"warming-runtime",
			"running-probe",
		]);
	});

	it("restarts a JVM `fast` marked as holding pre-compile classes, before it sends anything", async () => {
		// The deferred half of the freshness rule: `fast` marks and does not restart,
		// so if this path ever probed a marked JVM the answer would come from the old
		// classes with no error of any kind.
		const fake = withOwnServer(probeFake());
		const probesBeforeRestart: string[][] = [];
		let probes = 0;
		let down = false;
		fake.net.handler = (_port, lines) => {
			if (lines[0] === "SHUTDOWN") {
				down = true;
				return { ok: true, text: "RESULT OK 0\n" };
			}
			if (down && fake.proc.detached.length === 0) return { ok: false, why: "ECONNREFUSED" };
			if (lines[0] === "PROBE") {
				probes++;
				if (fake.proc.detached.length === 0) probesBeforeRestart.push([...lines]);
			}
			return okReply();
		};
		fake.proc.handler = (spec) =>
			spec.args.includes("javac") || spec.command === "where"
				? { status: 0, stdout: "C:/jdk/bin/javac.exe" }
				: { status: 0 };
		fake.fs.put("C:/jdk/lib/tools.jar", "tools");
		fake.fs.write(fake.ctx.layout.serverStale, "2026-09-06T00:00:00.000Z fast 编译了 1 个文件\n");

		const result = await probe(fake.ctx, "MetaProbe", { positional: ["e", "f"] });
		expect(result.ok && result.value.path).toBe("hot");
		expect(fake.proc.detached).toHaveLength(1);
		expect(probes).toBe(1);
		expect(probesBeforeRestart).toEqual([]);
		// Consumed, so the next probe in the same session does not restart again.
		expect(fake.fs.exists(fake.ctx.layout.serverStale)).toBe(false);
	});

	it("goes cold when a JVM answers but no pid record proves it is ours", async () => {
		// A foreign JVM on this port replies with an equally well-formed RESULT line
		// while running different Cosmic JARs; the answer would be wrong and silent.
		const fake = probeFake();
		fake.net.handler = () => okReply();
		const result = await probe(fake.ctx, "MetaProbe", { positional: ["e", "f"] });
		expect(result.ok && result.value.coldReason).toBe("常驻 JVM 归属存疑");
	});

	it("restarts a resident JVM that was started for another account or user", async () => {
		// 常驻宿主启动时就把 RequestContext（租户/账套/用户）建死了，之后改 config 一个字
		// 都到不了它。复用它 = 拿旧账套读元数据、把修改人记在旧用户头上，两件都不报错。
		const fake = probeFake();
		fake.fs.write(
			fake.ctx.layout.serverPid,
			JSON.stringify({
				pid: 321,
				keyId: fake.ctx.runtimeKeyId,
				port: 1,
				startedAt: "",
				account: "别的账套",
				user: "1",
			}),
		);
		fake.proc.livePids.add(321);
		// 关掉之后端口就不应答了，直到新的 JVM 起来——不这么模拟，重启这条路测不出来
		let shutdown = false;
		fake.net.handler = (_port, lines) => {
			if (lines.join("").includes("SHUTDOWN")) {
				shutdown = true;
				return okReply();
			}
			if (shutdown && fake.proc.detached.length === 0) return { ok: false, why: "ECONNREFUSED" };
			return okReply();
		};
		fake.proc.handler = (spec) =>
			spec.args.includes("javac") || spec.command === "where"
				? { status: 0, stdout: "C:/jdk/bin/javac.exe" }
				: { status: 0 };
		fake.fs.put("C:/jdk/lib/tools.jar", "tools");
		const result = await probe(fake.ctx, "MetaProbe", { positional: ["e", "f"] });
		// 停掉重起，而不是降级冷进程：降级只是这一次对了，那个 JVM 还在端口上等着被复用
		expect(fake.net.requests.map((request) => request.lines.join(""))).toContain("SHUTDOWN");
		expect(fake.proc.detached).toHaveLength(1);
		expect(result.ok && result.value.path).toBe("hot");
		expect(result.ok && result.value.notes.join("\n")).toContain("账套 别的账套 → acct");
		// 新起的那个把身份记进 manifest，下一次才有得比
		expect(fake.fs.read(fake.ctx.layout.serverPid)).toContain('"user":"42"');
	});

	it("falls back to cold when the resident JVM stays unavailable", async () => {
		const fake = probeFake();
		fake.net.handler = () => ({ ok: false, why: "ETIMEDOUT" });
		const result = await probe(fake.ctx, "MetaProbe", { positional: ["e", "f"] });
		expect(result.ok && result.value.path).toBe("cold");
		expect(result.ok && result.value.coldReason).toBe("常驻不可用");
	});

	it("refuses instead of paying for a cold start when the caller turned the fallback off", async () => {
		// 冷进程走 spawnSync：那 30-60 秒里 Node 的事件循环一动不动，TUI 的转圈停帧、
		// 按键不回显。开机自检替人做这个决定是不行的，所以它把降级关掉，改成如实报「没做」。
		const fake = probeFake();
		fake.net.handler = () => ({ ok: false, why: "ETIMEDOUT" });
		const result = await probe(fake.ctx, "MetaProbe", { positional: ["e", "f"], coldFallback: false });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("PROBE_RESIDENT_UNAVAILABLE");
			// 为什么用不上，要跟着拒绝一起走：那是调用方唯一能据以决定下一步的东西
			expect(String(result.error.detail.notes)).toContain("常驻不可用");
		}
		// 关键断言不是错误码，是「一个 java 进程都没起」
		expect(fake.proc.runs.filter((run) => run.command !== "where")).toEqual([]);
	});

	it("still honours an explicit --cold when the implicit fallback is off", async () => {
		// 关掉的是**隐式**降级。调用方自己点名要冷进程，那是他知道自己在买什么。
		const fake = probeFake();
		const result = await probe(fake.ctx, "MetaProbe", { positional: ["e", "f"], cold: true, coldFallback: false });
		expect(result.ok && result.value.coldReason).toBe("--cold");
	});

	it("surfaces a hot compile failure as an error rather than as probe output", async () => {
		const fake = withOwnServer(probeFake());
		fake.net.handler = () => ({ ok: true, text: "RESULT COMPILE_FAIL 1\nMetaProbe.java:3: 错误: 找不到符号\n" });
		const result = await probe(fake.ctx, "MetaProbe", { positional: ["e", "f"] });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("COMPILE_FAILED");
	});
});

describe("S3.3 probe protocol", () => {
	it("carries no command field at all", () => {
		const lines = encodeProbeRequest({ src: "D:/p/X.java", cls: "X", env: { A: "1" } });
		expect(lines[0]).toBe("PROBE");
		expect(lines.at(-1)).toBe("END");
		// The only things a request can name are a source file and a class. There is
		// no field an arbitrary command string could travel in (D1, S3.3).
		expect(lines.every((line) => /^(PROBE|END|src=|class=|account=|user=|env=)/.test(line))).toBe(true);
	});

	it("带写入目标的请求：-Dk=v 编成 prop= 行，值 base64（清单里的逗号、换行都拆不坏协议）", () => {
		const lines = encodeProbeRequest({
			src: "s",
			cls: "c",
			env: {},
			props: ["-Dcosmic.targets=zlgd_a,zlgd_b", "-Dcosmic.baseline=0123456789abcdef"],
		});
		expect(lines).toContain(`prop=cosmic.targets=${Buffer.from("zlgd_a,zlgd_b").toString("base64")}`);
		expect(lines).toContain(`prop=cosmic.baseline=${Buffer.from("0123456789abcdef").toString("base64")}`);
		expect(lines.at(-1)).toBe("END");
	});

	it("base64-encodes values so a newline cannot forge a protocol line", () => {
		const lines = encodeProbeRequest({ src: "s", cls: "c", env: { V: "a\nEND\nPROBE" } });
		const encoded = lines.find((line) => line.startsWith("env=V="));
		expect(encoded).toBe(`env=V=${Buffer.from("a\nEND\nPROBE", "utf8").toString("base64")}`);
		expect(lines.filter((line) => line === "END")).toHaveLength(1);
	});

	it("rejects an unparsable reply instead of treating partial output as a result", () => {
		// A garbled reply usually means the JVM died mid-answer; reading it as output
		// reports a failed run as a successful one.
		expect(decodeResponse("garbage\nmore").ok).toBe(false);
		const good = decodeResponse("RESULT STALE 1\nbody\n");
		expect(good.ok && good.value).toEqual({ status: "STALE", exitCode: 1, body: "body\n" });
	});

	it("maps an unknown status to ERR rather than to success", () => {
		const decoded = decodeResponse("RESULT WEIRD 0\n");
		expect(decoded.ok && decoded.value.status).toBe("ERR");
	});
});

describe("界面规则删除复用常驻", () => {
	it("删除仍须授权，授权后不另起进程", async () => {
		const fake = withOwnServer(probeFake({}, "FormRuleProbe", "public class FormRuleProbe {}"));
		fake.net.handler = () => okReply();
		const env = { APPLY: "1", ROLLBACK: "1" };
		const denied = await probe(fake.ctx, "FormRuleProbe", { env });
		expect(denied.ok).toBe(false);
		const result = await probe(fake.ctx, "FormRuleProbe", {
			env,
			writeAuthorization: writeAuthorization(["zlgd_a"]),
		});
		expect(result.ok && result.value.path).toBe("hot");
		expect(fake.proc.runsOf("java")).toHaveLength(0);
		expect(fake.fs.exists(fake.ctx.layout.serverStale)).toBe(false);
	});
});
