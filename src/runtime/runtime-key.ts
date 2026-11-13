/**
 * RuntimeKey (D10). The single identity that owns every runtime-scoped resource:
 * the class cache, the resident JVM, its socket and its PID file. Nothing may be
 * shared between two different RuntimeKeys.
 *
 * The frozen CLI relied on "one command, one Node process" for this isolation --
 * module-level ROOT/CFG globals were safe because the process died between
 * commands. A resident agent has no such boundary, so the identity has to be
 * explicit and carried in the context.
 */
import type {
	ClasspathFingerprint,
	CosmicRuntimeFingerprint,
	JdkFingerprint,
	ProjectFingerprint,
} from "./fingerprint.ts";
import { hashOf } from "./fingerprint.ts";

export interface RuntimeKeyParts {
	/** cosmic agent version: an agent upgrade may change generated probe code. */
	agentVersion: string;
	project: ProjectFingerprint;
	jdk: JdkFingerprint;
	cosmicRuntime: CosmicRuntimeFingerprint;
	classpath: ClasspathFingerprint;
	/** Hash of the agent's own embedded probe/runtime sources. */
	resources: string;
}

export interface RuntimeKey {
	/** Stable identity string. Safe as a directory name and as a socket name component. */
	readonly id: string;
	/** Short human-facing form for logs and error messages. */
	readonly short: string;
	readonly parts: RuntimeKeyParts;
}

/** The dimensions a mismatch can be attributed to. Used by diffRuntimeKey and by cache invalidation reports. */
export type RuntimeDimension = "agentVersion" | "project" | "jdk" | "cosmicRuntime" | "classpath" | "resources";

export const RUNTIME_DIMENSIONS: readonly RuntimeDimension[] = [
	"agentVersion",
	"project",
	"jdk",
	"cosmicRuntime",
	"classpath",
	"resources",
];

function dimensionHash(parts: RuntimeKeyParts, dimension: RuntimeDimension): string {
	switch (dimension) {
		case "agentVersion":
			return parts.agentVersion;
		case "project":
			return parts.project.hash;
		case "jdk":
			return parts.jdk.hash;
		case "cosmicRuntime":
			return parts.cosmicRuntime.hash;
		case "classpath":
			return parts.classpath.hash;
		case "resources":
			return parts.resources;
	}
}

export function computeRuntimeKey(parts: RuntimeKeyParts): RuntimeKey {
	const digest = hashOf({
		agentVersion: parts.agentVersion,
		project: parts.project.hash,
		jdk: parts.jdk.hash,
		cosmicRuntime: parts.cosmicRuntime.hash,
		classpath: parts.classpath.hash,
		resources: parts.resources,
	});
	// The agent version is kept readable in the id so a cache directory listing
	// shows which agent build produced it without opening the manifest.
	const id = `v${parts.agentVersion}-${digest.slice(0, 32)}`;
	return { id, short: digest.slice(0, 12), parts };
}

export interface RuntimeKeyDiff {
	same: boolean;
	changed: RuntimeDimension[];
}

/**
 * Which dimensions differ. Cache invalidation reports this rather than just
 * "stale": "the Cosmic JARs changed" and "you switched JDK" call for different
 * user actions, and a bare recompile message hides both.
 */
export function diffRuntimeKey(a: RuntimeKeyParts, b: RuntimeKeyParts): RuntimeKeyDiff {
	const changed = RUNTIME_DIMENSIONS.filter((dim) => dimensionHash(a, dim) !== dimensionHash(b, dim));
	return { same: changed.length === 0, changed };
}

/** Human-readable reason for a forced recompile. */
export function describeDiff(diff: RuntimeKeyDiff): string {
	if (diff.same) return "运行时指纹未变";
	const names: Record<RuntimeDimension, string> = {
		agentVersion: "cosmic 版本",
		project: "工程标识（根/ISV/模块）",
		jdk: "JDK",
		cosmicRuntime: "苍穹运行时 JAR",
		classpath: "classpath",
		resources: "内嵌探针资源",
	};
	return `${diff.changed.map((dim) => names[dim]).join("、")}变化，缓存失效需重编`;
}
