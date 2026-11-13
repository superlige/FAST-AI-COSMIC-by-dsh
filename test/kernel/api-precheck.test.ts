import { describe, expect, it } from "vitest";
import { prepareProbeInvocation, probe } from "../../src/kernel/commands/probe.ts";
import { probeImports } from "../../src/kernel/policy/api-precheck.ts";
import { type FakeContext, makeContext } from "./fake-context.ts";

const ADHOC = `
import java.util.List;
import kd.bos.orm.query.QFilter;
import kd.bos.servicehelper.QueryServiceHelper;
import static kd.bos.dataentity.OperateOption.create;

public class Look {
  public static void run() {
    QFilter filter = new QFilter("id", "=", 1L);
    QueryServiceHelper.queryOne("zlgd_x", "id", new QFilter[] { filter });
  }
}
`;

const QFILTER = "kd.bos.orm.query.QFilter";
const QUERY_HELPER = "kd.bos.servicehelper.QueryServiceHelper";
const OPERATE_OPTION = "kd.bos.dataentity.OperateOption";
const ALL = [OPERATE_OPTION, QFILTER, QUERY_HELPER];

/** The fake filesystem is keyed on forward slashes; layout paths are native. */
function posix(path: string): string {
	return path.split(String.fromCharCode(92)).join("/");
}

function withAdHoc(source = ADHOC): FakeContext {
	const fake = makeContext({ probes: ["MetaProbe"] });
	fake.fs.put("D:/proj/scratchpad/Look.java", source);
	return fake;
}

describe("S9.1 which APIs an ad-hoc probe is betting on", () => {
	it("takes 苍穹 classes from imports, and resolves a static import to its class", () => {
		expect(probeImports(ADHOC)).toEqual({ classes: ALL, wildcards: [] });
	});

	it("ignores the JDK: the gate is about 苍穹 APIs, not about java.util.List", () => {
		expect(probeImports("import java.util.List;\nimport javax.crypto.Cipher;")).toEqual({
			classes: [],
			wildcards: [],
		});
	});

	it("does not count a class named in a comment or a string", () => {
		// Same reason the write scan blanks them: a probe that documents an import
		// is talking about one, not performing one.
		const source = `// import kd.bos.fake.Ghost;\nString s = "import kd.bos.fake.Other;";\nimport ${QFILTER};`;
		expect(probeImports(source).classes).toEqual([QFILTER]);
	});

	it("reports a wildcard separately, because it names no class to check", () => {
		expect(probeImports("import kd.bos.orm.query.*;").wildcards).toEqual(["kd.bos.orm.query.*"]);
	});
});

describe("S15.3 the probe-specific prepare gate", () => {
	it("refuses a wildcard import, which would otherwise be a one-line bypass", async () => {
		const source = "import kd.bos.orm.query.*;\npublic class Look { public static void run() {} }";
		const result = await probe(withAdHoc(source).ctx, "scratchpad/Look.java");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("PROBE_PRECHECK_FAILED");
		expect(result.error.detail.blockers).toContainEqual(expect.stringContaining("PROBE_API_WILDCARD"));
	});

	it("returns missing input, stray env and dangerous capability together", () => {
		const source = [
			"public class Look {",
			'  static String req(String name) { return ""; }',
			"  public static void run() {",
			'    String id = req("DATA_ENTITY");',
			"    java.nio.file.Files.write(null, new byte[0]);",
			"  }",
			"}",
		].join("\n");
		const prepared = prepareProbeInvocation(withAdHoc(source).ctx, "scratchpad/Look.java", {
			env: { META_ENTITY: "zlgd_demo" },
		});
		expect(prepared.ok).toBe(true);
		if (!prepared.ok) return;
		expect(prepared.value.blockers.map((blocker) => blocker.code)).toEqual([
			"PROBE_INPUT_MISSING",
			"PROBE_ENV_UNKNOWN",
			"PROBE_WRITES_REFUSED",
		]);
	});

	it("leaves released probes outside the ad-hoc API join", async () => {
		const fake = makeContext({ probes: ["MetaProbe"] });
		fake.fs.put(
			`${posix(fake.ctx.layout.probesDir)}/MetaProbe.java`,
			`import ${QFILTER};\npublic class MetaProbe {}`,
		);
		const prepared = prepareProbeInvocation(fake.ctx, "MetaProbe");
		expect(prepared.ok && prepared.value.plan?.api).toBeNull();
	});
});
