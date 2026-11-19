/**
 * A refusal's remedy has to be followable from where the caller is standing.
 *
 * The kernel writes remedies with no idea what the agent surface looks like, so it
 * can and did name a tool that no longer exists under that name. This is the
 * annotation that makes such a remedy survivable. (Until S25 it also annotated
 * tools the current phase did not mount; every tool is mounted now.)
 */
import { describe, expect, it } from "vitest";
import { withReachableRemedy } from "../../src/agent/tools/remedy.ts";

const failure = (remedy: string) => ({ code: "X", message: "m", detail: {}, remedy });

describe("remedies that name a retired tool", () => {
	it("says what the retired name is now called", () => {
		const annotated = withReachableRemedy(failure("产物不对时跑 cosmic_build force=true。"));
		expect(annotated.remedy).toContain("产物不对时跑 cosmic_build force=true。");
		expect(annotated.remedy).toContain("cosmic_build 已不是独立工具，现在是 cosmic_doctor action=rebuild");
	});

	it("leaves a remedy alone when every tool it names is live", () => {
		const original = failure("先跑 cosmic_fast（约 40 秒）。");
		expect(withReachableRemedy(original)).toEqual(original);
		expect(withReachableRemedy(failure("先 cosmic_probe 再 cosmic_run。")).remedy).toBe(
			"先 cosmic_probe 再 cosmic_run。",
		);
	});

	it("names every retired tool once, not once per mention", () => {
		const annotated = withReachableRemedy(failure("cosmic_build 或 cosmic_build，再不行 cosmic_deploy"));
		expect(annotated.remedy.match(/cosmic_build 已不是独立工具/g)).toHaveLength(1);
		expect(annotated.remedy).toContain("cosmic_deploy 已不是独立工具");
	});

	it("keeps the rest of the failure untouched", () => {
		const annotated = withReachableRemedy(failure("先跑 cosmic_build。"));
		expect(annotated.code).toBe("X");
		expect(annotated.message).toBe("m");
	});

	it("says nothing when there is no remedy to annotate", () => {
		const empty = failure("");
		expect(withReachableRemedy(empty)).toEqual(empty);
	});
});
