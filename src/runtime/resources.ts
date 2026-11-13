/**
 * Agent-owned resource release (S2.2). The agent embeds and releases ONLY the
 * probe/runtime sources and build helpers it maintains itself. Cosmic JARs,
 * customer projects, configs, credentials and evidence are never embedded and
 * never released -- they come from the user's own environment at run time.
 *
 * Release targets the RuntimeKey cache directory, so two runtimes never share
 * released sources: the same probe source compiled against a different Cosmic
 * JAR set is a different artifact.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type ProbeCatalogEntry, probeRequiredNames, probeSummary, probeUsage } from "../kernel/commands/probe.ts";
import { KernelError } from "../kernel/errors.ts";
import type { CacheLayout } from "./cache.ts";
import { sha256 } from "./fingerprint.ts";

export interface EmbeddedResource {
	/** Path relative to the resources cache directory, e.g. "probes/RuleSim.java". */
	relativePath: string;
	content: string;
}

/** Extensions the agent is allowed to embed. Anything else must be justified and added here deliberately. */
const ALLOWED_EXTENSIONS = [".java", ".gradle", ".properties", ".txt", ".json"] as const;

/**
 * Shapes that must never appear in the release. `.jar` is the load-bearing one:
 * the whole D10/D12 boundary is that Cosmic JARs stay in the user's runtime, and
 * an embedded jar would both break licensing and pin every user to one Cosmic
 * version. The rest catch customer data leaking in through a careless glob.
 */
const FORBIDDEN_PATTERNS: readonly { pattern: RegExp; why: string }[] = [
	{ pattern: /\.jar$/i, why: "JAR 不得内嵌：苍穹 JAR 只能来自用户当前运行时（D10/D12）" },
	{ pattern: /(^|\/)config\.json$/i, why: "客户配置不得内嵌" },
	{ pattern: /(^|\/)\.env(\.|$)/i, why: "环境/凭据文件不得内嵌" },
	{ pattern: /(^|\/)\.cosmic-ai(\/|$)/i, why: "客户交付证据不得内嵌" },
	{ pattern: /\.(p12|pfx|pem|key|keystore|jks)$/i, why: "密钥材料不得内嵌" },
];

export interface ResourceViolation {
	relativePath: string;
	why: string;
}

/** Pure check: which resources violate the embedding allow-list. */
export function findResourceViolations(resources: readonly EmbeddedResource[]): ResourceViolation[] {
	const violations: ResourceViolation[] = [];
	for (const resource of resources) {
		const path = resource.relativePath.replace(/\\/g, "/");
		if (path.startsWith("/") || path.includes("..")) {
			violations.push({ relativePath: resource.relativePath, why: "释放路径必须是不含 .. 的相对路径" });
			continue;
		}
		const forbidden = FORBIDDEN_PATTERNS.find((entry) => entry.pattern.test(path));
		if (forbidden) {
			violations.push({ relativePath: resource.relativePath, why: forbidden.why });
			continue;
		}
		if (!ALLOWED_EXTENSIONS.some((extension) => path.toLowerCase().endsWith(extension))) {
			violations.push({
				relativePath: resource.relativePath,
				why: `扩展名不在白名单内（允许：${ALLOWED_EXTENSIONS.join(" ")}）`,
			});
		}
	}
	return violations;
}

export function assertAgentOwned(resources: readonly EmbeddedResource[]): void {
	const violations = findResourceViolations(resources);
	if (violations.length === 0) return;
	throw new KernelError("RUNTIME_FINGERPRINT_UNAVAILABLE", `内嵌资源违反工具自有白名单：${violations.length} 项`, {
		detail: { violations: violations.map((v) => `${v.relativePath}: ${v.why}`) },
		remedy: "只内嵌 cosmic 自己维护的探针/运行时源码与构建辅助脚本。",
	});
}

/**
 * The class names of the agent's own released probes -- the ONLY code allowed
 * into the Cosmic JVM.
 *
 * The list comes from the embedded resources (a compile-time constant), not
 * from whatever happens to sit in probesDir: a file dropped into that directory
 * must not become runnable. `probe` used to accept any .java path, which meant
 * writing a source file and naming it was arbitrary code execution inside a JVM
 * holding a live Cosmic connection -- and IsvGuard, being opt-in at the call
 * site, is simply not present in code that does not call it.
 */
export function releasedProbeNames(resources: readonly EmbeddedResource[]): string[] {
	const names: string[] = [];
	for (const resource of resources) {
		const match = /^probes\/([A-Za-z][A-Za-z0-9_]*)\.java$/.exec(resource.relativePath);
		// probes/ also contains sourcepath helpers such as ExpectSpec and ProbeJson.
		// Publishing every .java file makes those helpers look runnable even though
		// CosmicProbe can only invoke a public static void run() entry point.
		if (match !== null && /\bpublic\s+static\s+void\s+run\s*\(/.test(resource.content)) {
			names.push(match[1] as string);
		}
	}
	return names.sort();
}

/** Immutable execution identity for each reviewed, runnable released probe. */
export function releasedProbeDigests(resources: readonly EmbeddedResource[]): Record<string, string> {
	const runnable = new Set(releasedProbeNames(resources));
	return Object.fromEntries(
		resources.flatMap((resource) => {
			const match = /^probes\/([A-Za-z][A-Za-z0-9_]*)\.java$/.exec(resource.relativePath);
			const name = match?.[1];
			return name !== undefined && runnable.has(name) ? [[name, sha256(resource.content)]] : [];
		}),
	);
}

/**
 * Required input names per released probe, straight off the embedded sources.
 *
 * The same `req("X")` scan `probeRequiredNames` does, but without a project: the
 * L0 budget gate has to measure the prompt the model will actually get, and
 * since the released list carries each probe's required inputs, measuring it
 * without them would under-report the worst case by the exact amount that was
 * added.
 */
export function releasedProbeInputNames(resources: readonly EmbeddedResource[]): Record<string, string[]> {
	const inputs: Record<string, string[]> = {};
	for (const name of releasedProbeNames(resources)) {
		const source = resources.find((resource) => resource.relativePath === `probes/${name}.java`);
		if (source === undefined) continue;
		const required = probeRequiredNames(source.content);
		if (required.length > 0) inputs[name] = required;
	}
	return inputs;
}

/**
 * What each released probe is for, off the embedded sources -- no project needed.
 *
 * The prompt can only afford names (L0 has no room for 44 purpose lines), so
 * this is the on-demand half: `cosmic_knowledge probes` lists it when the model
 * is choosing, instead of the model guessing from a name or opening sources.
 */
export function releasedProbeCatalog(resources: readonly EmbeddedResource[]): ProbeCatalogEntry[] {
	return releasedProbeNames(resources).flatMap((name) => {
		const source = resources.find((resource) => resource.relativePath === `probes/${name}.java`);
		if (source === undefined) return [];
		const usage = probeUsage(source.content);
		return [{ name, required: usage.required, summary: probeSummary(source.content), usage: usage.doc }];
	});
}

export interface ReleaseResult {
	resourcesDir: string;
	/** Files newly written in this run. */
	released: string[];
	/** Files already present with identical content. */
	reused: string[];
	/** Files whose on-disk content had drifted and were rewritten. */
	repaired: string[];
	hashes: Record<string, string>;
}

/**
 * Releases embedded resources into this RuntimeKey's cache. Content that
 * already matches is reused; content that drifted is rewritten and reported as
 * repaired rather than silently overwritten -- an externally edited probe source
 * is exactly the situation the freshness gate exists to notice.
 */
export async function releaseResources(
	layout: CacheLayout,
	resources: readonly EmbeddedResource[],
): Promise<ReleaseResult> {
	assertAgentOwned(resources);

	const released: string[] = [];
	const reused: string[] = [];
	const repaired: string[] = [];
	const hashes: Record<string, string> = {};

	for (const resource of resources) {
		const target = join(layout.resourcesDir, resource.relativePath);
		const existing = await readFile(target, "utf8").catch(() => null);
		if (existing === resource.content) {
			reused.push(resource.relativePath);
		} else {
			await mkdir(dirname(target), { recursive: true });
			await writeFile(target, resource.content, "utf8");
			if (existing === null) released.push(resource.relativePath);
			else repaired.push(resource.relativePath);
		}
		hashes[resource.relativePath] = sha256(resource.content);
	}

	return { resourcesDir: layout.resourcesDir, released, reused, repaired, hashes };
}
