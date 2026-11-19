import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	ROUND_BASELINE_SAMPLES,
	ROUND_GATE_GOLDENS,
	ROUND_SAFETY_BASELINE,
	type RoundEvent,
	roundBaselineTotals,
	summarizeRoundTrace,
} from "../../src/eval/round-efficiency.ts";

describe("S15.0 round-efficiency corpus", () => {
	it("freezes at least six sourced tasks for each affected path", () => {
		for (const kind of ["plugin", "probe", "run"] as const) {
			const samples = ROUND_BASELINE_SAMPLES.filter((sample) => sample.kind === kind);
			expect(samples.length, kind).toBeGreaterThanOrEqual(6);
			for (const sample of samples) {
				expect(sample.scope).toBe("target-known");
				expect(sample.sourceRefs.length, sample.id).toBeGreaterThan(0);
				expect(
					sample.events.some((event) => event.type === "target-execution"),
					sample.id,
				).toBe(true);
			}
		}
	});

	it("keeps ids unique and every current path measurable", () => {
		const ids = ROUND_BASELINE_SAMPLES.map((sample) => sample.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const sample of ROUND_BASELINE_SAMPLES) {
			const summary = summarizeRoundTrace(sample.events);
			expect(summary.accessRounds, sample.id).toBeGreaterThan(0);
			expect(summary.documentAccessRounds, sample.id).toBeGreaterThan(0);
			expect(summary.blockerResponses, sample.id).toBe(1);
			expect(summary.firstTargetExecutionSucceeded, sample.id).toBe(true);
		}
	});

	it("records the exact batch-0 aggregate instead of recomputing a moving baseline", () => {
		expect(roundBaselineTotals(ROUND_BASELINE_SAMPLES)).toEqual({
			samples: 18,
			accessRounds: 66,
			documentAccessRounds: 24,
			processStarts: 24,
			coldStarts: 12,
			blockerResponses: 18,
			serialBlockers: 0,
			unchangedRetries: 0,
			firstTargetSuccesses: 18,
		});
	});
});

describe("S15.0 counting vocabulary", () => {
	it("counts a repeated input as unchanged only while external facts stay unchanged", () => {
		const events: RoundEvent[] = [
			{ type: "tool-call", tool: "cosmic_run", inputKey: "same" },
			{ type: "blocker", code: "ONE" },
			{ type: "tool-call", tool: "cosmic_run", inputKey: "same" },
			{ type: "fact-change", key: "source" },
			{ type: "tool-call", tool: "cosmic_run", inputKey: "same" },
		];
		expect(summarizeRoundTrace(events).unchangedRetries).toBe(1);
	});

	it("distinguishes several blockers in one response from serial gate collisions", () => {
		const aggregated: RoundEvent[] = [
			{ type: "tool-call", tool: "cosmic_run", inputKey: "x" },
			{ type: "blocker", code: "ARG" },
			{ type: "blocker", code: "FRESH" },
		];
		const serial: RoundEvent[] = [
			...aggregated,
			{ type: "fact-change", key: "args" },
			{ type: "tool-call", tool: "cosmic_run", inputKey: "y" },
			{ type: "blocker", code: "FRESH" },
		];
		expect(summarizeRoundTrace(aggregated)).toMatchObject({ blockerResponses: 1, serialBlockers: 0 });
		expect(summarizeRoundTrace(serial)).toMatchObject({ blockerResponses: 2, serialBlockers: 1 });
	});
});

describe("知识门和不能为省轮数放宽的边界", () => {
	it("列着的知识门就是内核里还在的那两道", () => {
		expect(ROUND_GATE_GOLDENS.map((gate) => [gate.path, gate.code])).toEqual([
			["plugin", "KNOWLEDGE_GATE_UNSATISFIED"],
			["probe", "PROBE_API_UNCHECKED"],
		]);
		for (const gate of ROUND_GATE_GOLDENS) {
			expect(gate.beforeTargetExecution).toBe(true);
			expect(gate.clearedBy.length).toBeGreaterThan(0);
			expect(gate.testRefs.length).toBeGreaterThan(0);
		}
	});

	it("每条边界都有名字、说明和测试", () => {
		const ids = ROUND_SAFETY_BASELINE.map((row) => row.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids).toEqual([
			"moved-facts",
			"ad-hoc-path",
			"freshness",
			"dangerous-probe",
			"project-write-lock",
			"runtime-isolation",
			"shared-write-authorization",
			"prod-readonly",
		]);
		for (const row of ROUND_SAFETY_BASELINE) {
			expect(row.boundary.length, row.id).toBeGreaterThan(0);
			expect(row.testRefs.length, row.id).toBeGreaterThan(0);
		}
	});

	it("引用的测试和脚本都在：删了或改名，这里先失败", () => {
		const refs = [...ROUND_GATE_GOLDENS, ...ROUND_SAFETY_BASELINE].flatMap((row) => row.testRefs);
		const missing = refs.filter((ref) => !existsSync(fileURLToPath(new URL(`../../${ref}`, import.meta.url))));
		expect(missing).toEqual([]);
	});
});
