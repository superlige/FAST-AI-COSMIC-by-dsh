import { describe, expect, it } from "vitest";
import { KernelError } from "../../src/kernel/errors.ts";
import { RuntimeBinding } from "../../src/runtime/binding.ts";
import {
	fingerprintClasspath,
	fingerprintCosmicRuntime,
	fingerprintJdk,
	fingerprintProject,
	fingerprintResources,
	type JarEntry,
} from "../../src/runtime/fingerprint.ts";
import {
	computeRuntimeKey,
	describeDiff,
	diffRuntimeKey,
	type RuntimeKeyParts,
} from "../../src/runtime/runtime-key.ts";

const JARS: JarEntry[] = [
	{ path: "lib/bos-core-8.2.1.jar", bytes: 100 },
	{ path: "lib/bos-util-8.2.1.jar", bytes: 200 },
];

async function parts(
	overrides: Partial<Record<"root" | "isv" | "jdkHome" | "jdkVersion" | "cosmicHome" | "agentVersion", string>> & {
		classpath?: readonly string[];
		jars?: readonly JarEntry[];
		resources?: readonly { relativePath: string; content: string }[];
	} = {},
): Promise<RuntimeKeyParts> {
	const jdk = await fingerprintJdk(overrides.jdkHome ?? "D:/jdk8", {
		describe: async () => ({ version: overrides.jdkVersion ?? "1.8.0_392", build: null }),
	});
	if (jdk === null) throw new Error("unreachable: fake probe always describes");
	return {
		agentVersion: overrides.agentVersion ?? "0.1.0",
		project: fingerprintProject({
			root: overrides.root ?? "D:/proj",
			isv: overrides.isv ?? "zlgd",
			debugModule: "debug",
			codeModules: ["a"],
		}),
		jdk,
		cosmicRuntime: fingerprintCosmicRuntime(overrides.cosmicHome ?? "D:/cosmic", overrides.jars ?? JARS),
		classpath: fingerprintClasspath(overrides.classpath ?? ["a.jar", "b.jar"]),
		resources: fingerprintResources(
			overrides.resources ?? [{ relativePath: "probes/P.java", content: "class P {}" }],
		),
	};
}

describe("S2.3 RuntimeKey identity", () => {
	it("is stable for identical inputs", async () => {
		expect(computeRuntimeKey(await parts()).id).toBe(computeRuntimeKey(await parts()).id);
	});

	it("keeps the agent version readable in the id", async () => {
		expect(computeRuntimeKey(await parts({ agentVersion: "1.2.3" })).id.startsWith("v1.2.3-")).toBe(true);
	});

	it("is usable as a directory and socket name component", async () => {
		expect(computeRuntimeKey(await parts()).id).toMatch(/^[A-Za-z0-9.\-_]+$/);
	});
});

describe("S2.4 isolation: every dimension changes the identity", async () => {
	const base = await parts();
	const baseId = computeRuntimeKey(base).id;

	it("two faked classpath fingerprints produce different cache/JVM identities", async () => {
		const a = computeRuntimeKey(await parts({ classpath: ["a.jar", "b.jar"] }));
		const b = computeRuntimeKey(await parts({ classpath: ["a.jar", "c.jar"] }));
		expect(b.id).not.toBe(a.id);
		expect(diffRuntimeKey(a.parts, b.parts).changed).toEqual(["classpath"]);
	});

	it("changing a Cosmic JAR forces a new identity", async () => {
		const patched = JARS.map((jar, index) => (index === 0 ? { ...jar, bytes: jar.bytes + 1 } : jar));
		const changed = computeRuntimeKey(await parts({ jars: patched }));
		expect(changed.id).not.toBe(baseId);
		expect(diffRuntimeKey(base, changed.parts).changed).toEqual(["cosmicRuntime"]);
	});

	it("changing the JDK forces a new identity", async () => {
		const changed = computeRuntimeKey(await parts({ jdkVersion: "1.8.0_400" }));
		expect(changed.id).not.toBe(baseId);
		expect(diffRuntimeKey(base, changed.parts).changed).toEqual(["jdk"]);
	});

	it("two projects never share an identity", async () => {
		expect(computeRuntimeKey(await parts({ root: "D:/other" })).id).not.toBe(baseId);
	});

	it("editing an embedded probe source forces a recompile", async () => {
		const changed = computeRuntimeKey(
			await parts({ resources: [{ relativePath: "probes/P.java", content: "class P { }" }] }),
		);
		expect(diffRuntimeKey(base, changed.parts).changed).toEqual(["resources"]);
	});

	it("an agent upgrade forces a new identity", async () => {
		expect(diffRuntimeKey(base, await parts({ agentVersion: "0.2.0" })).changed).toEqual(["agentVersion"]);
	});

	it("names every changed dimension at once, not just the first", async () => {
		const diff = diffRuntimeKey(base, await parts({ jdkVersion: "1.8.0_400", root: "D:/other" }));
		expect(diff.changed).toEqual(["project", "jdk"]);
		expect(describeDiff(diff)).toContain("JDK");
		expect(describeDiff({ same: true, changed: [] })).toBe("运行时指纹未变");
	});
});

describe("D10 single-project binding", () => {
	it("binds once and accepts the identical key again", async () => {
		const binding = new RuntimeBinding();
		const key = computeRuntimeKey(await parts());
		expect(binding.bind(key).id).toBe(key.id);
		expect(binding.bind(computeRuntimeKey(await parts())).id).toBe(key.id);
		expect(binding.current?.id).toBe(key.id);
	});

	it("refuses a second project instead of silently switching", async () => {
		const binding = new RuntimeBinding();
		binding.bind(computeRuntimeKey(await parts({ root: "D:/a" })));
		let caught: unknown;
		try {
			binding.bind(computeRuntimeKey(await parts({ root: "D:/b" })));
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(KernelError);
		expect((caught as KernelError).code).toBe("RUNTIME_KEY_MISMATCH");
		expect((caught as KernelError).remedy).toContain("一个 cosmic 进程只服务一个工程");
	});

	it("distinguishes a changed runtime on the same project from a different project", async () => {
		const binding = new RuntimeBinding();
		binding.bind(computeRuntimeKey(await parts({ jdkVersion: "1.8.0_392" })));
		try {
			binding.bind(computeRuntimeKey(await parts({ jdkVersion: "1.8.0_400" })));
			expect.unreachable("second bind must throw");
		} catch (error) {
			expect((error as KernelError).remedy).toContain("重启 cosmic");
			expect((error as KernelError).detail.changed).toEqual(["jdk"]);
		}
	});

	it("can be released and rebound", async () => {
		const binding = new RuntimeBinding();
		binding.bind(computeRuntimeKey(await parts({ root: "D:/a" })));
		binding.release();
		expect(binding.current).toBeNull();
		const other = computeRuntimeKey(await parts({ root: "D:/b" }));
		expect(() => binding.bind(other)).not.toThrow();
	});
});
