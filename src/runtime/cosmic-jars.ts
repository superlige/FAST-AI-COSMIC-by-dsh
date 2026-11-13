/**
 * Where Cosmic runtime JARs may come from (S2.2).
 *
 * Exactly two sources are legal, and both belong to the user's project:
 *   1. the runtime directory the PROJECT declares (systemProp.cosmic_home)
 *   2. the classpath the project's own build actually produced
 *
 * Nothing else is admissible -- not a jar bundled with the agent, not a
 * directory the agent guesses, and not an agent-side cosmicHome that disagrees
 * with the project (see resolveCosmicHome). Compiling probes against one
 * runtime while the project runs another produces a NoSuchMethodError that
 * names a business class, so the mismatch has to be refused rather than
 * discovered later.
 *
 * The classpath entries are supplied by the caller: producing them requires the
 * project's Gradle build, which is migrated in S3. This module owns the policy
 * and the fingerprint contract; S3 supplies the second input.
 */

import type { CosmicHomeResolution } from "../kernel/config/load-config.ts";
import { KernelError } from "../kernel/errors.ts";
import { type CosmicRuntimeFingerprint, fingerprintCosmicRuntime, type JarScanner } from "./fingerprint.ts";

export interface CosmicJarSources {
	/** Resolved project runtime home; null when the project declares none. */
	cosmicHome: string | null;
	/**
	 * Classpath entries from the project's own build output (argfile / pathing
	 * jar). Empty until S3 provides them; an empty list is not an error here.
	 */
	classpathEntries: readonly string[];
}

export interface CosmicRuntimeResolution {
	fingerprint: CosmicRuntimeFingerprint;
	/** Jar-bearing classpath entries, kept separate so the report can say which source contributed. */
	classpathJars: string[];
	/** Non-fatal notes for doctor: the resolution succeeded but something is worth saying. */
	notes: string[];
}

/**
 * Resolves the user's Cosmic runtime from the two legal sources.
 *
 * A disagreement between the project and agent config is a hard error rather
 * than a note: silently preferring either one is exactly the failure S2.2
 * exists to prevent, and there is no safe default between two runtimes.
 */
export async function resolveCosmicRuntime(
	sources: CosmicJarSources,
	homeResolution: CosmicHomeResolution,
	scanner: JarScanner,
): Promise<CosmicRuntimeResolution> {
	if (homeResolution.conflict !== null) {
		throw new KernelError(
			"COSMIC_HOME_CONFLICT",
			"config.json 的 cosmicHome 与工程 gradle.properties 不一致，拒绝静默取其一。",
			{
				detail: {
					projectValue: homeResolution.conflict.projectValue,
					agentValue: homeResolution.conflict.agentValue,
				},
				remedy:
					"苍穹运行时归工程所有：删掉 config.json 里的 cosmicHome，或把工程的 systemProp.cosmic_home 改成你要用的那个。",
			},
		);
	}

	const notes: string[] = [];
	if (sources.cosmicHome === null) {
		throw new KernelError(
			"RUNTIME_FINGERPRINT_UNAVAILABLE",
			"工程未声明 systemProp.cosmic_home，无法定位苍穹运行时。",
			{
				detail: { classpathEntries: sources.classpathEntries.length },
				remedy: "在工程的 gradle.properties 里设置 systemProp.cosmic_home=<苍穹运行时目录>。",
			},
		);
	}

	const fingerprint = fingerprintCosmicRuntime(sources.cosmicHome, await scanner.scan(sources.cosmicHome));
	if (fingerprint.jarCount === 0) {
		notes.push(`${sources.cosmicHome} 下没有扫到任何 JAR —— 目录可能不是苍穹运行时，或当前不可读`);
	}
	if (fingerprint.version === null && fingerprint.jarCount > 0) {
		// Recorded, never guessed: an unnamed version is reported as unsampled.
		notes.push("扫到 JAR 但没有 bos-*.jar，苍穹版本采不到（记 null，不猜）");
	}

	const classpathJars = sources.classpathEntries.filter((entry) => entry.toLowerCase().endsWith(".jar"));
	return { fingerprint, classpathJars, notes };
}
