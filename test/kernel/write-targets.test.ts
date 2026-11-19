import { describe, expect, it } from "vitest";
import { writeTargetProps } from "../../src/kernel/commands/probe.ts";
import { admitSharedWrite } from "../../src/kernel/policy/shared-write.ts";
import { normTarget } from "../../src/kernel/policy/write-targets.ts";
import { encodeProbeRequest } from "../../src/kernel/probe/protocol.ts";
import { makeContext } from "./fake-context.ts";

describe("write targets", () => {
	it("accepts entity, field, entry field, template, rule, and workflow targets", () => {
		expect(normTarget("zlgd_bill")).toBe("zlgd_bill");
		expect(normTarget("zlgd_bill.zlgd_qty")).toBe("zlgd_bill.zlgd_qty");
		expect(normTarget("zlgd_bill.zlgd_detail.zlgd_qty")).toBe("zlgd_bill.zlgd_detail.zlgd_qty");
		expect(normTarget("TPL:ABC_58")).toBe("tpl:abc_58");
		expect(normTarget("botp:12345")).toBe("botp:12345");
		expect(normTarget("wf:zlgd_flow")).toBe("wf:zlgd_flow");
	});

	it("rejects rather than silently dropping an unrecognised target", () => {
		expect(() => normTarget("这是什么")).toThrow(/看不懂的目标.*布局规则写 <实体>\.<布局key>/);
	});

	it("refuses an APPLY without an authorization -- the DRAFT.md fallback is gone (S14.3.1)", () => {
		const fake = makeContext();
		// A hand-maintained .cosmic-ai/DRAFT.md on disk must not resurrect the
		// fallback: the frozen CLI's admission source is deleted code, not a file
		// nobody writes any more.
		fake.fs.put(
			`${fake.ctx.projectRoot}/.cosmic-ai/DRAFT.md`,
			["- 2026-09-03 [target] 确认写入目标 1 个", "  确认项: zlgd_bill", "  回滚: restore backup", ""].join("\n"),
		);
		const result = writeTargetProps(fake.ctx, {}, "MetaProbe", true);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("WRITE_TARGETS_UNCONFIRMED");
			expect(result.error.remedy).toContain("附 report");
		}
	});

	it("accepts an independent one-shot authorization without a ledger draft", () => {
		const fake = makeContext();
		const result = admitSharedWrite(fake.ctx, {
			operation: "probe MetaProbe APPLY=1",
			authorization: {
				targets: ["zlgd_demo"],
				rollback: "restore backup-1 and cold-read",
				confirmationId: "call-1",
			},
		});
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value.targets).toEqual(["zlgd_demo"]);
	});

	it("S23 hands the confirmed before-image snapshot to the probe, and only in the shape the probe printed it", () => {
		const fake = makeContext();
		const grant = { targets: ["data:zlgd_bill"], rollback: "按原值改回", confirmationId: "call-1" };
		const good = writeTargetProps(
			fake.ctx,
			{ writeAuthorization: { ...grant, baseline: "0123456789abcdef" } },
			"DataUpdateProbe",
			true,
		);
		expect(good.ok && good.value.props).toEqual([
			"-Dcosmic.targets=data:zlgd_bill",
			"-Dcosmic.baseline=0123456789abcdef",
		]);
		const odd = writeTargetProps(
			fake.ctx,
			{ writeAuthorization: { ...grant, baseline: "x -Devil=1" } },
			"DataUpdateProbe",
			true,
		);
		expect(odd.ok && odd.value.props).toEqual(["-Dcosmic.targets=data:zlgd_bill"]);
	});

	it("encodes the reviewed long-task timeout as data, never as a command", () => {
		const lines = encodeProbeRequest({ src: "D:/P.java", cls: "P", env: {}, timeoutMs: 600_000 });
		expect(lines).toContain("timeoutMs=600000");
		expect(lines[0]).toBe("PROBE");
	});
});
