import { describe, expect, it } from "vitest";
import { adHocLane, PLATFORM_PROBES, releasedLane } from "../../src/kernel/policy/probe-freshness.ts";
import { METADATA_WRITERS } from "../../src/kernel/policy/write-plan.ts";
import { EMBEDDED_RESOURCES } from "../../src/resources/embedded.generated.ts";

const PROBE_SOURCES = new Map(
	EMBEDDED_RESOURCES.filter((file) => file.relativePath.startsWith("probes/")).map((file) => [
		file.relativePath.slice("probes/".length).replace(/\.java$/, ""),
		file.content,
	]),
);

describe("probe freshness lanes", () => {
	it("names probes that exist, so a typo cannot silently drop one back to strict", () => {
		// The whitelist fails safe -- an unknown name is business -- which is exactly
		// why a typo here would never show up as a failure: the probe just goes on
		// being refused in explore and nobody connects it to a misspelling.
		expect(PLATFORM_PROBES.filter((name) => !PROBE_SOURCES.has(name))).toEqual([]);
	});

	it("keeps sorted, deduplicated entries so the list stays reviewable as a set", () => {
		expect([...PLATFORM_PROBES]).toEqual([...new Set(PLATFORM_PROBES)].sort());
	});

	it("admits nothing that writes the shared environment", () => {
		// The platform lane's claim is "read-only and platform-only". The write half
		// is checkable from the source: these are the APIs IsvGuard stands in front of.
		const writers =
			/\bMetadataWriter\b|\bSaveServiceHelper\b|\bDeleteServiceHelper\b|\bConvertRuleWriter\b|\bDB\s*\.\s*update\b|\bupdatePrintMeta\b/;
		const offenders = PLATFORM_PROBES.filter((name) => writers.test(PROBE_SOURCES.get(name) ?? ""));
		expect(offenders).toEqual([]);
	});

	it("admits nothing that runs the form, list, operation, or print engines", () => {
		// The other half: an engine entry point means project plugin classes load,
		// which is precisely what a stale .class makes wrong in silence.
		// PrintMeasureProbe is the one this catches -- it reads as an audit probe and
		// renders a real PDF through ExecuteService.
		//
		// Entry points, not packages. `kd.bos.print.core` as a prefix also holds
		// plain data types: PrintTplBackupProbe imports `core.service.PrtAttach`
		// purely as the return type of `getPrtAttach`, fetching an attachment record
		// that already exists. Matching the package flagged it as an engine caller,
		// which it is not.
		const engines =
			/kd\.bos\.form\.|kd\.bos\.print\.core\.ExecuteService|BosPrintServiceImpl|OperationServiceHelper|kd\.bos\.entity\.plugin/;
		const offenders = PLATFORM_PROBES.filter((name) => engines.test(PROBE_SOURCES.get(name) ?? ""));
		expect(offenders).toEqual([]);
	});

	it("puts an unregistered probe -- a project's own included -- in the strict lane", () => {
		expect(releasedLane("MetaProbe")).toBe("platform");
		expect(releasedLane("FormSim")).toBe("business");
		expect(releasedLane("SomeProjectProbe")).toBe("business");
	});

	// S18 (user decision 2026-09-11): the metadata writers are platform whatever
	// the call -- read mode, dry-run and APPLY reach the same platform-only code, so
	// somebody else's half-edited plugin no longer stands in front of a
	// print-template change. `test/kernel/write-plan.test.ts` proves from source
	// that the eight load no business class and enter no engine.
	it("puts every metadata writer in the platform lane, and nothing that loads plugins", () => {
		for (const writer of Object.keys(METADATA_WRITERS)) expect(releasedLane(writer)).toBe("platform");
		expect(releasedLane("OpSandbox")).toBe("business");
		expect(releasedLane("PrintMeasureProbe")).toBe("business");
	});

	// S36 batch 5: a print-template dry-run with a real bill prints through the template's print
	// plugins -- the project's own classes, often -- so it is judged like run print. The rule
	// trial is not: it skips anything not loaded from a platform JAR (write-plan.test).
	it("moves the print writer to the strict lane only when it previews on a real bill", () => {
		expect(releasedLane("PrintTplWriteProbe", { TPL_NUMBER: "t", PRINT_PK: "123" })).toBe("business");
		expect(releasedLane("PrintTplWriteProbe", { TPL_NUMBER: "t", PRINT_PK: " " })).toBe("platform");
		expect(releasedLane("PrintTplWriteProbe", { TPL_NUMBER: "t" })).toBe("platform");
		// APPLY 不预览，照着预演的入参原样带上 PRINT_PK 也不该被旧类拦
		expect(releasedLane("PrintTplWriteProbe", { TPL_NUMBER: "t", PRINT_PK: "123", APPLY: "1" })).toBe("platform");
		expect(releasedLane("FormRuleProbe", { RULE_FORM: "f", RULE_SET: "a=1" })).toBe("platform");
		expect(releasedLane("BizRuleProbe", { BIZ_ENTITY: "e", RULE_SET: "a=1" })).toBe("platform");
	});

	it("keeps the writers off the read-only list, where the no-writes check would reject them", () => {
		expect(Object.keys(METADATA_WRITERS).filter((name) => PLATFORM_PROBES.includes(name))).toEqual([]);
	});

	it("judges an ad-hoc probe on the packages that are stale, not on every business package", () => {
		const stale = ["kd.zlgd.scm", "kd.zlgd.fi"];
		expect(adHocLane("import kd.bos.db.DB;", stale)).toBe("platform");
		expect(adHocLane("import kd.zlgd.scm.OrderPlugin;", stale)).toBe("business");
		expect(adHocLane("kd.zlgd.fi.Voucher.of(id).total();", stale)).toBe("business");
		// A package that is not stale is not this gate's business.
		expect(adHocLane("import kd.zlgd.hr.Person;", stale)).toBe("platform");
		// Nothing stale at all: every ad-hoc probe is platform, and the gate would
		// not have been consulted anyway.
		expect(adHocLane("import kd.zlgd.scm.OrderPlugin;", [])).toBe("platform");
	});

	it("does not let a package name in a comment pull a probe into the strict lane", () => {
		expect(adHocLane("// 抄自 kd.zlgd.scm.OrderPlugin\nimport kd.bos.db.DB;", ["kd.zlgd.scm"])).toBe("platform");
		expect(adHocLane("/* see kd.zlgd.scm.Order */ import kd.bos.db.DB;", ["kd.zlgd.scm"])).toBe("platform");
		// A name in a STRING stays a match: that is how a class gets handed to
		// something else to load, and matching it costs nothing.
		expect(adHocLane('String c = "kd.zlgd.scm.Order";', ["kd.zlgd.scm"])).toBe("business");
	});
});
