/**
 * Project root discovery. Ported from the frozen ref tools/project-root.mjs
 * (c7b8815). Behaviour is identical; the two changes are D9 requirements:
 * failures throw a KernelError instead of a bare Error, and the filesystem is
 * reached through an injectable probe so tests need no real directories.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { KernelError } from "../errors.ts";

/** A Cosmic Gradle project root has both markers. Injectable for tests. */
export type ExistsProbe = (path: string) => boolean;

const realExists: ExistsProbe = (path) => existsSync(path);

export function hasProjectMarkers(root: string, exists: ExistsProbe = realExists): boolean {
	return exists(join(root, "gradle.properties")) && exists(join(root, "settings.gradle"));
}

/** Walks up from any directory inside a project to the Cosmic Gradle project root. */
export function findProjectRoot(start: string | null | undefined, exists: ExistsProbe = realExists): string | null {
	if (!start) return null;
	let current = resolve(start);
	for (;;) {
		if (hasProjectMarkers(current, exists)) return current;
		const parent = dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

export interface ResolveProjectRootInput {
	/** COSMIC_PROJECT_ROOT or an equivalent explicit setting. */
	explicit?: string | null;
	cwd?: string | null;
	/** Command entry point; its lexical directory is searched third. */
	entryFile?: string | null;
	legacyRoot?: string | null;
}

export interface ProjectRootResolution {
	root: string;
	/** Which of the four rules produced the root; doctor prints this. */
	source: "explicit" | "cwd" | "entry" | "legacy";
}

/**
 * The agent may live outside the project (the project may hold only a junction).
 * Precedence: (1) explicit setting, (2) current directory, (3) the lexical path
 * of the command entry point, (4) the legacy layout. An explicit value that is
 * wrong must fail loudly -- silently falling back to another project would run
 * the command against the wrong environment.
 *
 * Unlike the frozen CLI this takes cwd explicitly rather than reading
 * process.cwd() as a default: in a resident agent the process directory is not
 * the project directory, and an implicit default would silently bind the kernel
 * to whatever directory the agent happened to start in.
 */
export function resolveProjectRoot(
	input: ResolveProjectRootInput,
	exists: ExistsProbe = realExists,
): ProjectRootResolution {
	const { explicit, cwd, entryFile, legacyRoot } = input;

	if (explicit) {
		const root = resolve(explicit);
		if (hasProjectMarkers(root, exists)) return { root, source: "explicit" };
		throw new KernelError("PROJECT_ROOT_INVALID", `COSMIC_PROJECT_ROOT 不是苍穹 Gradle 工程根：${root}`, {
			detail: { root, markers: ["gradle.properties", "settings.gradle"] },
			remedy: "该目录必须同时包含 gradle.properties 和 settings.gradle。",
		});
	}

	const fromCwd = cwd ? findProjectRoot(cwd, exists) : null;
	if (fromCwd) return { root: fromCwd, source: "cwd" };

	const fromEntry = entryFile ? findProjectRoot(dirname(resolve(entryFile)), exists) : null;
	if (fromEntry) return { root: fromEntry, source: "entry" };

	if (legacyRoot && hasProjectMarkers(resolve(legacyRoot), exists)) {
		return { root: resolve(legacyRoot), source: "legacy" };
	}

	throw new KernelError("PROJECT_ROOT_NOT_FOUND", "找不到苍穹工程根。", {
		detail: {
			triedCwd: cwd ?? null,
			triedEntry: entryFile ?? null,
			triedLegacy: legacyRoot ?? null,
		},
		remedy: "从工程根或其子目录启动，或设置 COSMIC_PROJECT_ROOT=<工程绝对路径>。",
	});
}
