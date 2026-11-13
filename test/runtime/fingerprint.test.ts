import { describe, expect, it } from "vitest";
import {
	canonicalJson,
	cosmicVersionOf,
	fingerprintClasspath,
	fingerprintCosmicRuntime,
	fingerprintJdk,
	fingerprintProject,
	fingerprintResources,
	type JarEntry,
	type JdkProbe,
} from "../../src/runtime/fingerprint.ts";

const jdk = (version: string, build: string | null = null): JdkProbe => ({
	describe: async () => ({ version, build }),
});

describe("S2.3 canonical hashing", () => {
	it("is independent of key insertion order", async () => {
		expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
	});

	it("is NOT independent of array order", async () => {
		// Classpath order is semantic: Cosmic resolves a duplicated class first-on-path.
		expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
	});
});

describe("S2.3 JDK fingerprint", () => {
	it("distinguishes two builds of the same version", async () => {
		const a = await fingerprintJdk("D:/jdk8", jdk("1.8.0_392", "Temurin"));
		const b = await fingerprintJdk("D:/jdk8", jdk("1.8.0_392", "Zulu"));
		expect(a?.hash).not.toBe(b?.hash);
	});

	it("distinguishes the same version at two homes", async () => {
		const a = await fingerprintJdk("D:/jdk8a", jdk("1.8.0_392"));
		const b = await fingerprintJdk("D:/jdk8b", jdk("1.8.0_392"));
		expect(a?.hash).not.toBe(b?.hash);
	});

	it("returns null when the JDK cannot be interrogated", async () => {
		expect(await fingerprintJdk("D:/none", { describe: async () => null })).toBeNull();
	});
});

describe("S2.3 Cosmic runtime fingerprint", () => {
	const jars: JarEntry[] = [
		{ path: "lib/bos-core-8.2.1.jar", bytes: 100 },
		{ path: "lib/bos-util-8.2.1.jar", bytes: 200 },
		{ path: "lib/other.jar", bytes: 50 },
	];

	it("samples the version from the majority of bos-*.jar names", async () => {
		expect(fingerprintCosmicRuntime("D:/cosmic", jars).version).toBe("8.2.1");
	});

	it("picks the majority version when an old upgrade left files behind", async () => {
		expect(cosmicVersionOf(["bos-a-8.2.1.jar", "bos-b-8.2.1.jar", "bos-c-8.0.0.jar"])).toBe("8.2.1");
	});

	it("returns null when no bos jar is present rather than guessing", async () => {
		expect(fingerprintCosmicRuntime("D:/cosmic", [{ path: "x.jar", bytes: 1 }]).version).toBeNull();
		expect(cosmicVersionOf([])).toBeNull();
	});

	it("notices an in-place patch that keeps every file name", async () => {
		// Name-only hashing would call a patched runtime unchanged.
		const patched = jars.map((jar) => (jar.path.endsWith("core-8.2.1.jar") ? { ...jar, bytes: 101 } : jar));
		const before = fingerprintCosmicRuntime("D:/cosmic", jars);
		const after = fingerprintCosmicRuntime("D:/cosmic", patched);
		expect(after.hash).not.toBe(before.hash);
		expect(after.version).toBe(before.version);
	});

	it("is stable under scan order", async () => {
		const forward = fingerprintCosmicRuntime("D:/cosmic", jars);
		const reversed = fingerprintCosmicRuntime("D:/cosmic", [...jars].reverse());
		expect(reversed.hash).toBe(forward.hash);
	});

	it("separates two runtimes at different homes with identical contents", async () => {
		expect(fingerprintCosmicRuntime("D:/a", jars).hash).not.toBe(fingerprintCosmicRuntime("D:/b", jars).hash);
	});
});

describe("S2.3 classpath and project fingerprints", () => {
	it("treats reordering as a different classpath", async () => {
		expect(fingerprintClasspath(["a.jar", "b.jar"]).hash).not.toBe(fingerprintClasspath(["b.jar", "a.jar"]).hash);
	});

	it("normalizes path separators so the same classpath hashes alike", async () => {
		expect(fingerprintClasspath(["D:\\x\\a.jar"]).hash).toBe(fingerprintClasspath(["D:/x/a.jar"]).hash);
	});

	it("includes ISV, because the same tree under another ISV flag is a different artifact", async () => {
		const base = { root: "D:/p", isv: "zlgd", debugModule: "d", codeModules: ["a"] };
		expect(fingerprintProject(base).hash).not.toBe(fingerprintProject({ ...base, isv: "other" }).hash);
	});

	it("is insensitive to code module order but sensitive to membership", async () => {
		const base = { root: "D:/p", isv: "z", debugModule: "d", codeModules: ["a", "b"] };
		expect(fingerprintProject(base).hash).toBe(fingerprintProject({ ...base, codeModules: ["b", "a"] }).hash);
		expect(fingerprintProject(base).hash).not.toBe(fingerprintProject({ ...base, codeModules: ["a"] }).hash);
	});
});

describe("S2.3 resource fingerprint", () => {
	it("changes when a probe source is edited", async () => {
		const before = fingerprintResources([{ relativePath: "probes/P.java", content: "class P {}" }]);
		const after = fingerprintResources([{ relativePath: "probes/P.java", content: "class P { int x; }" }]);
		expect(after).not.toBe(before);
	});

	it("is stable under declaration order", async () => {
		const a = [
			{ relativePath: "probes/A.java", content: "a" },
			{ relativePath: "probes/B.java", content: "b" },
		];
		expect(fingerprintResources(a)).toBe(fingerprintResources([...a].reverse()));
	});
});
