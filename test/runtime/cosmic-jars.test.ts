import { describe, expect, it } from "vitest";
import { resolveCosmicHome } from "../../src/kernel/config/load-config.ts";
import { KernelError } from "../../src/kernel/errors.ts";
import { resolveCosmicRuntime } from "../../src/runtime/cosmic-jars.ts";
import type { JarEntry, JarScanner } from "../../src/runtime/fingerprint.ts";

const JARS: JarEntry[] = [
	{ path: "lib/bos-core-8.2.1.jar", bytes: 100 },
	{ path: "lib/bos-util-8.2.1.jar", bytes: 200 },
];

const scanner = (entries: readonly JarEntry[]): JarScanner => ({ scan: async () => [...entries] });

describe("S2.2 Cosmic JAR sources", () => {
	it("resolves from the project's own cosmic_home", async () => {
		const result = await resolveCosmicRuntime(
			{ cosmicHome: "D:/cosmic", classpathEntries: [] },
			resolveCosmicHome("D:/cosmic", null),
			scanner(JARS),
		);
		expect(result.fingerprint.version).toBe("8.2.1");
		expect(result.fingerprint.jarCount).toBe(2);
		expect(result.notes).toEqual([]);
	});

	it("refuses a disagreeing agent cosmicHome instead of picking one", async () => {
		// There is no safe default between two runtimes: preferring either silently
		// is exactly the failure S2.2 exists to prevent.
		let caught: unknown;
		try {
			await resolveCosmicRuntime(
				{ cosmicHome: "D:/project-runtime", classpathEntries: [] },
				resolveCosmicHome("D:/project-runtime", "D:/agent-runtime"),
				scanner(JARS),
			);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(KernelError);
		expect((caught as KernelError).code).toBe("COSMIC_HOME_CONFLICT");
		expect((caught as KernelError).detail.agentValue).toBe("D:/agent-runtime");
	});

	it("fails with an actionable error when the project declares no runtime", async () => {
		let caught: unknown;
		try {
			await resolveCosmicRuntime(
				{ cosmicHome: null, classpathEntries: [] },
				resolveCosmicHome(null, null),
				scanner([]),
			);
		} catch (error) {
			caught = error;
		}
		expect((caught as KernelError).code).toBe("RUNTIME_FINGERPRINT_UNAVAILABLE");
		expect((caught as KernelError).remedy).toContain("systemProp.cosmic_home");
	});

	it("notes an empty runtime directory rather than reporting a healthy fingerprint", async () => {
		const result = await resolveCosmicRuntime(
			{ cosmicHome: "D:/empty", classpathEntries: [] },
			resolveCosmicHome("D:/empty", null),
			scanner([]),
		);
		expect(result.fingerprint.jarCount).toBe(0);
		expect(result.notes[0]).toContain("没有扫到任何 JAR");
	});

	it("records an unsampled version instead of guessing one", async () => {
		const result = await resolveCosmicRuntime(
			{ cosmicHome: "D:/odd", classpathEntries: [] },
			resolveCosmicHome("D:/odd", null),
			scanner([{ path: "lib/thirdparty.jar", bytes: 10 }]),
		);
		expect(result.fingerprint.version).toBeNull();
		expect(result.notes[0]).toContain("不猜");
	});

	it("keeps build-produced classpath jars as a separate, attributable source", async () => {
		const result = await resolveCosmicRuntime(
			{ cosmicHome: "D:/cosmic", classpathEntries: ["D:/proj/build/classes", "D:/proj/build/cosmic-pathing.jar"] },
			resolveCosmicHome("D:/cosmic", null),
			scanner(JARS),
		);
		expect(result.classpathJars).toEqual(["D:/proj/build/cosmic-pathing.jar"]);
	});

	it("accepts an agent cosmicHome only as a fallback when the project declares none", async () => {
		const resolution = resolveCosmicHome(null, "D:/fallback");
		const result = await resolveCosmicRuntime(
			{ cosmicHome: resolution.value, classpathEntries: [] },
			resolution,
			scanner(JARS),
		);
		expect(result.fingerprint.cosmicHome).toBe("D:/fallback");
	});
});
