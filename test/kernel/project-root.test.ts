import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { findProjectRoot, hasProjectMarkers, resolveProjectRoot } from "../../src/kernel/config/project-root.ts";
import { KernelError } from "../../src/kernel/errors.ts";

/** In-memory filesystem: the set of paths that exist. */
function fakeFs(paths: readonly string[]) {
	const set = new Set(paths.map((p) => resolve(p)));
	return (path: string): boolean => set.has(resolve(path));
}

const PROJECT = resolve("D:/proj");
const OTHER = resolve("D:/other");
const markers = (root: string): string[] => [`${root}/gradle.properties`, `${root}/settings.gradle`];

describe("S2.1 project root discovery", () => {
	it("a settings script marks the root; gradle.properties alone does not, and either DSL counts", () => {
		expect(hasProjectMarkers(PROJECT, fakeFs([`${PROJECT}/gradle.properties`]))).toBe(false);
		expect(hasProjectMarkers(PROJECT, fakeFs(markers(PROJECT)))).toBe(true);
		expect(hasProjectMarkers(PROJECT, fakeFs([`${PROJECT}/settings.gradle`]))).toBe(true);
		expect(hasProjectMarkers(PROJECT, fakeFs([`${PROJECT}/settings.gradle.kts`]))).toBe(true);
	});

	it("walks past buildSrc, which has a settings script of its own", () => {
		const exists = fakeFs([...markers(PROJECT), `${PROJECT}/buildSrc/settings.gradle`]);
		expect(findProjectRoot(`${PROJECT}/buildSrc/src/main`, exists)).toBe(PROJECT);
	});

	it("walks up from a nested directory", () => {
		const exists = fakeFs(markers(PROJECT));
		expect(findProjectRoot(`${PROJECT}/a/b/c`, exists)).toBe(PROJECT);
	});

	it("returns null instead of walking past the filesystem root", () => {
		expect(findProjectRoot("D:/nowhere/deep", fakeFs([]))).toBeNull();
	});

	it("honours the four-rule precedence", () => {
		const exists = fakeFs([...markers(PROJECT), ...markers(OTHER)]);
		expect(resolveProjectRoot({ explicit: PROJECT, cwd: OTHER }, exists)).toEqual({
			root: PROJECT,
			source: "explicit",
		});
		expect(resolveProjectRoot({ cwd: `${OTHER}/sub` }, exists).source).toBe("cwd");
		expect(resolveProjectRoot({ cwd: "D:/unrelated", entryFile: `${PROJECT}/driver.mjs` }, exists).source).toBe(
			"entry",
		);
		expect(resolveProjectRoot({ cwd: "D:/unrelated", legacyRoot: OTHER }, exists).source).toBe("legacy");
	});

	it("fails loudly on a wrong explicit root instead of falling back", () => {
		// Falling back here would run the command against a different project --
		// the whole reason the frozen CLI made this a hard error.
		const exists = fakeFs(markers(PROJECT));
		let caught: unknown;
		try {
			resolveProjectRoot({ explicit: "D:/not-a-project", cwd: PROJECT }, exists);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(KernelError);
		expect((caught as KernelError).code).toBe("PROJECT_ROOT_INVALID");
	});

	it("reports a structured error, not a process exit, when nothing matches", () => {
		let caught: unknown;
		try {
			resolveProjectRoot({ cwd: "D:/unrelated" }, fakeFs([]));
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(KernelError);
		expect((caught as KernelError).code).toBe("PROJECT_ROOT_NOT_FOUND");
		expect((caught as KernelError).remedy).toContain("projectRoot");
	});

	it("does not silently default cwd to the agent process directory", () => {
		// The frozen CLI defaulted to process.cwd(); a resident agent must not, or it
		// binds the kernel to wherever the agent happened to be started.
		expect(() => resolveProjectRoot({}, fakeFs([]))).toThrow(KernelError);
	});
});
