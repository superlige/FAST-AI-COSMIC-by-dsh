/**
 * S15.5 -- one prepare shape, and what it is allowed to claim.
 *
 * The tests here are about the two halves that used to be missing rather than
 * about any single command: everything computable is reported in ONE refusal,
 * and everything that could not be computed is named rather than passed over in
 * silence.
 */

import { describe, expect, it } from "vitest";
import { fast, prepareFast } from "../../src/kernel/commands/fast.ts";
import { prepareProbeInvocation } from "../../src/kernel/commands/probe.ts";
import { prepareRun, prepareRunInvocation } from "../../src/kernel/commands/run.ts";
import { prepareErrorDetail, prepareRemedy } from "../../src/kernel/prepare/model.ts";
import type { KnowledgeAdvice } from "../../src/knowledge/plugin-gate.ts";
import { addSource, makeContext } from "./fake-context.ts";

function refusing(base: string): KnowledgeAdvice {
	return {
		hints: [],
		capsules: [],
		gate: {
			allowed: false,
			reason: "capsule-unavailable",
			blocked: [{ base, pluginType: null, file: "A.java", tier: "direct", via: [], remedy: "修复知识包" }],
			capsules: [],
			lines: ["目标 Capsule 无法生成"],
		},
	};
}

function allowed(): KnowledgeAdvice {
	return {
		hints: [],
		capsules: [],
		gate: { allowed: true, reason: "no-families", blocked: [], capsules: [], lines: [] },
	};
}

/** The fake filesystem is keyed on forward slashes; layout paths are native. */
function posix(path: string): string {
	return path.split(String.fromCharCode(92)).join("/");
}

describe("S15.5.1 fast collects every cheap answer before any process", () => {
	it("reports all unresolvable names at once instead of the first one", () => {
		const fake = makeContext();
		addSource(fake, "demo-biz", "A.java");
		const prepared = prepareFast(fake.ctx, ["NoSuchOne", "NoSuchTwo"], { knowledgeGate: allowed });
		expect(prepared.blockers.map((blocker) => blocker.code)).toEqual(["SOURCE_NOT_FOUND", "SOURCE_NOT_FOUND"]);
		expect(prepared.plan).toBeNull();
		// Nothing would be spent, so nothing is predicted.
		expect(prepared.estimatedCost).toEqual({ processes: 0, coldStarts: 0 });
		expect(fake.proc.runs).toHaveLength(0);
	});

	it("reports a bad name and a blocked plugin family in the same refusal", async () => {
		const fake = makeContext();
		addSource(fake, "demo-biz", "A.java");
		const prepared = prepareFast(fake.ctx, ["A.java", "NoSuchOne"], {
			knowledgeGate: () => refusing("kd.bos.form.plugin.AbstractFormPlugin"),
		});
		expect(prepared.blockers.map((blocker) => blocker.code).sort()).toEqual([
			"KNOWLEDGE_GATE_UNSATISFIED",
			"SOURCE_NOT_FOUND",
		]);
		// The name is correctable and the gate is not, so no `nextCall` is written:
		// the corrected call would be refused again.
		expect(prepared.retryInput).toBeNull();

		const result = await fast(fake.ctx, ["A.java", "NoSuchOne"], {
			knowledgeGate: () => refusing("kd.bos.form.plugin.AbstractFormPlugin"),
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("FAST_PRECHECK_FAILED");
		expect(result.error.remedy).toContain("修复知识包");
		expect(fake.proc.runs).toHaveLength(0);
	});

	it("keeps a lone blocker's own code, which the audit and the reference pages name", async () => {
		const fake = makeContext();
		addSource(fake, "demo-biz", "A.java");
		const result = await fast(fake.ctx, [], {
			knowledgeGate: () => refusing("kd.bos.form.plugin.AbstractFormPlugin"),
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("KNOWLEDGE_GATE_UNSATISFIED");
	});

	it("names the Capsule check it could not make instead of passing it", () => {
		const fake = makeContext();
		addSource(fake, "demo-biz", "A.java");
		// No knowledgeGate hook at all: no knowledge source could be resolved.
		const prepared = prepareFast(fake.ctx, []);
		expect(prepared.blockers).toEqual([]);
		expect(prepared.deferred).toEqual([
			expect.objectContaining({ check: expect.stringContaining("插件族 Capsule"), dependsOn: ["knowledge-base"] }),
		]);
	});

	it("predicts the javac runs it will actually make", () => {
		const fake = makeContext();
		addSource(fake, "demo-biz", "A.java");
		const prepared = prepareFast(fake.ctx, [], { knowledgeGate: allowed });
		// One pre-flight lint plus one module javac; the fake layout already has
		// the argfile and pathing jar, so no Gradle preparation is predicted.
		expect(prepared.estimatedCost).toEqual({ processes: 2, coldStarts: 0 });
	});
});

describe("S15.5.1 run and probe say what they did not check", () => {
	it("does not claim a clean side-effect scan when argv never parsed", () => {
		const fake = makeContext({ config: { codeModules: ["demo-biz"] } });
		const prepared = prepareRunInvocation(fake.ctx, ["notakind", "zlgd_bill"]);
		expect(prepared.plan).toBeNull();
		expect(prepared.deferred).toEqual([
			expect.objectContaining({ check: expect.stringContaining("事务外副作用"), dependsOn: ["run.plan.target"] }),
		]);
	});

	it("predicts one process for a batched op, not one per scenario", () => {
		const prepared = prepareRun(
			["op", "zlgd_bill", "save", "--case", "b", "--op", "submit", "--pk", "100"],
			"runtime-1",
		);
		expect(prepared.blockers).toEqual([]);
		expect(prepared.estimatedCost.processes).toBe(1);
	});

	it("refuses an env name an ad-hoc probe does not read, without writing the call minus that name (S37 2-B.1)", () => {
		// 多传的名字多半是写错了：删掉它等于悄悄去掉一个条件，所以和内置探针一样不代写
		const fake = makeContext({ probes: ["MetaProbe"] });
		fake.fs.put(
			"D:/proj/scratchpad/Look.java",
			["public class Look {", '  public static void run() { env("KEEP", "x"); }', "}"].join("\n"),
		);
		const prepared = prepareProbeInvocation(fake.ctx, "scratchpad/Look.java", {
			env: { KEEP: "1", TYPO: "2" },
		});
		expect(prepared.ok).toBe(true);
		if (!prepared.ok) return;
		expect(prepared.value.blockers.map((blocker) => blocker.code)).toEqual(["PROBE_ENV_UNKNOWN"]);
		expect(prepared.value.retryInput).toBeNull();
	});

	it("knows the names an ad-hoc probe reads however it reads them (S37 2-B.1)", () => {
		// 09-22 真机基线第 112 次：System.getenv("PROBE_IDS") 被说成「不是它读取的环境变量」，模型只好把 id 写死进源码再跑
		const fake = makeContext({ probes: ["MetaProbe"] });
		fake.fs.put(
			"D:/proj/.cosmic-ai/probes/BillFlowStateProbe.java",
			[
				"public class BillFlowStateProbe {",
				'  public static void run() { String raw = System.getenv("PROBE_IDS"); }',
				"}",
			].join("\n"),
		);
		const prepared = prepareProbeInvocation(fake.ctx, ".cosmic-ai/probes/BillFlowStateProbe.java", {
			env: { PROBE_IDS: "2558985120585359360" },
		});
		expect(prepared.ok).toBe(true);
		if (!prepared.ok) return;
		expect(prepared.value.blockers.map((blocker) => blocker.code)).not.toContain("PROBE_ENV_UNKNOWN");
	});

	it("refuses to invent a value it cannot derive", () => {
		const fake = makeContext({ probes: ["MetaProbe"] });
		fake.fs.put(
			"D:/proj/scratchpad/Look.java",
			["public class Look {", '  public static void run() { req("NEEDED"); }', "}"].join("\n"),
		);
		const prepared = prepareProbeInvocation(fake.ctx, "scratchpad/Look.java", {});
		expect(prepared.ok).toBe(true);
		if (!prepared.ok) return;
		expect(prepared.value.blockers.map((blocker) => blocker.code)).toContain("PROBE_INPUT_MISSING");
		expect(prepared.value.retryInput).toBeNull();
	});

	it("names the signature check it skipped when no doc/JAR join ran", () => {
		const fake = makeContext({ probes: ["MetaProbe"] });
		fake.fs.put(
			"D:/proj/scratchpad/Look.java",
			["import kd.bos.orm.query.QFilter;", "public class Look { public static void run() {} }"].join("\n"),
		);
		const prepared = prepareProbeInvocation(fake.ctx, "scratchpad/Look.java", {});
		expect(prepared.ok).toBe(true);
		if (!prepared.ok) return;
		expect(prepared.value.deferred).toEqual([
			expect.objectContaining({ dependsOn: ["knowledge-base", "reflection:ApiTool"] }),
		]);
	});

	it("leaves a released probe with nothing deferred", () => {
		const fake = makeContext({ probes: ["MetaProbe"] });
		fake.fs.put(`${posix(fake.ctx.layout.probesDir)}/MetaProbe.java`, "public class MetaProbe {}");
		const prepared = prepareProbeInvocation(fake.ctx, "MetaProbe");
		expect(prepared.ok && prepared.value.deferred).toEqual([]);
	});
});

describe("S15.5.3 the refusal carries everything, in one call", () => {
	it("renders blockers, uncomputed checks and the next call into one detail", () => {
		const prepared = {
			plan: null,
			blockers: [{ code: "X_INVALID", message: "参数不对", remedy: "改成 1", dependsOn: ["argv"] }],
			warnings: [],
			capsules: [],
			deferred: [{ check: "签名核对", dependsOn: ["reflection:ApiTool"], reason: "反射不可用" }],
			retryInput: { tool: "cosmic_run", argv: ["rule", "zlgd_bill"] },
			estimatedCost: { processes: 0, coldStarts: 0 },
		};
		const detail = prepareErrorDetail(prepared);
		expect(detail.blockers).toEqual(["X_INVALID\t参数不对\t改成 1"]);
		expect(detail.deferred).toEqual(["签名核对\treflection:ApiTool\t反射不可用"]);
		expect(detail.nextCall).toBe(JSON.stringify(prepared.retryInput));
		const remedy = prepareRemedy(prepared);
		expect(remedy).toContain("[X_INVALID] 改成 1");
		expect(remedy).toContain("本次未计算：签名核对（缺 reflection:ApiTool）");
	});
});
