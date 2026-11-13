/**
 * Opening a project: the one place a KernelContext is created (S3.2).
 *
 * This is the composition root of the fast -> probe slice. It is the only code
 * that reads the ambient world -- process.env, process.cwd, the disk -- and
 * everything below it receives values. That boundary is what makes the crosstalk
 * tests possible: two projects can be opened in the same process and neither can
 * observe the other, because there is nothing shared to observe.
 *
 * Order matters and is not arbitrary:
 *   root -> config -> Cosmic runtime -> JDK -> classpath -> resources
 *   -> RuntimeKey -> cache -> layout -> layout upkeep -> context
 * The key cannot be computed before its inputs, and the cache directory cannot
 * be chosen before the key, because the directory IS the key (D10).
 */

import { join } from "node:path";
import { RuntimeBinding } from "../runtime/binding.ts";
import { inspectCache, writeCacheManifest } from "../runtime/cache.ts";
import { reclaimRuntimeCaches } from "../runtime/cache-reclaim.ts";
import { resolveCosmicRuntime } from "../runtime/cosmic-jars.ts";
import {
	fingerprintClasspath,
	fingerprintJdk,
	fingerprintProject,
	fingerprintResources,
	type JarScanner,
	type JdkProbe,
	nodeJarScanner,
} from "../runtime/fingerprint.ts";
import {
	classpathFromArgfile,
	type JdkMemory,
	javaExecutableStamp,
	nodeJdkProbe,
	rememberingJdkProbe,
} from "../runtime/jdk-probe.ts";
import type { EmbeddedResource } from "../runtime/resources.ts";
import { releasedProbeDigests, releasedProbeNames, releaseResources } from "../runtime/resources.ts";
import { computeRuntimeKey, describeDiff, type RuntimeKey } from "../runtime/runtime-key.ts";
import { loadConfig, requireRuntime } from "./config/load-config.ts";
import { resolveProjectRoot } from "./config/project-root.ts";
import { createContext, type KernelContext } from "./context.ts";
import { KernelError } from "./errors.ts";
import { kernelLayout } from "./layout.ts";
import { nodePorts, type Ports } from "./ports.ts";
import { upkeepProjectLayout } from "./project/layout-upkeep.ts";

export interface OpenProjectInput {
	/** Explicit project root; when absent the four-rule precedence from S2 applies. */
	projectRoot?: string;
	cwd?: string;
	entryFile?: string;
	/** Directory holding the agent's config.json. Never a hardcoded skill path. */
	agentConfigDir: string;
	/** Root under which per-RuntimeKey cache directories are created. */
	cacheRoot: string;
	/** cosmic's own version; part of the RuntimeKey. */
	agentVersion: string;
	/** The agent's embedded probe/runtime sources. */
	resources: readonly EmbeddedResource[];
	env?: Readonly<Record<string, string | undefined>>;
	ports?: Ports;
	jdkProbe?: JdkProbe;
	/** 问过的 JDK 记在这里，同一个 java 不再每次起 JVM 去问（见 rememberingJdkProbe）；不给就每次问。 */
	jdkMemory?: JdkMemory;
	/** 测试用：java 可执行文件的戳，默认读磁盘。 */
	javaStamp?: (javaHome: string) => string | null;
	jarScanner?: JarScanner;
	binding?: RuntimeBinding;
	platform?: NodeJS.Platform;
}

export interface OpenedProject {
	ctx: KernelContext;
	key: RuntimeKey;
	/** Cache state before this call: fresh / stale (with a reason) / absent. */
	cache: { state: "fresh" | "absent" | "stale"; reason: string };
	release: { released: number; reused: number; repaired: number };
	notes: string[];
}

export async function openProject(input: OpenProjectInput): Promise<OpenedProject> {
	const env = input.env ?? process.env;
	const ports = input.ports ?? nodePorts;
	const notes: string[] = [];

	const root = resolveProjectRoot(
		{
			explicit: input.projectRoot ?? env.COSMIC_PROJECT_ROOT ?? null,
			cwd: input.cwd ?? null,
			entryFile: input.entryFile ?? null,
			legacyRoot: null,
		},
		(path) => ports.fs.exists(path),
	).root;

	const config = loadConfig({ root, agentConfigDir: input.agentConfigDir, env }, ports.fs);
	const missing = requireRuntime(config);
	if (missing !== null) throw missing;

	// The Cosmic runtime belongs to the project. A disagreeing agent config is a
	// hard error here (S2.2), not a note, because both halves of the mismatch
	// compile and only the run fails, naming an unrelated business class.
	const argfile = join(root, "build", "cosmic-javac.args");
	const classpathEntries = classpathFromArgfile(ports.fs.read(argfile));
	const scanner = input.jarScanner ?? nodeJarScanner;
	const runtime = await resolveCosmicRuntime(
		{ cosmicHome: config.cosmicHome, classpathEntries },
		config.cosmicHomeResolution,
		scanner,
	);
	notes.push(...runtime.notes);

	const asked = input.jdkProbe ?? nodeJdkProbe(ports.proc, childProcessEnv(env), root);
	const probe =
		input.jdkMemory === undefined
			? asked
			: rememberingJdkProbe(asked, input.jdkMemory, input.javaStamp ?? javaExecutableStamp);
	const javaHome = env.JAVA_HOME ?? "";
	const jdk = await fingerprintJdk(javaHome, probe);
	if (jdk === null) {
		// java 在却没起来（内存不够最常见），照「去改 JAVA_HOME」查只会白查：把 java 自己的话带回去
		const present =
			javaHome !== "" &&
			["java.exe", "java"].some((name) => ports.fs.exists(`${javaHome.replace(/[\\/]+$/, "")}/bin/${name}`));
		const said = probe.lastFailure?.() ?? null;
		throw new KernelError(
			"TOOLCHAIN_MISSING",
			present ? "JAVA_HOME 下的 java 这次没启动成功，无法建立运行时身份" : "问不出 JDK 版本，无法建立运行时身份",
			{
				detail: { javaHome: javaHome || null, ...(said === null ? {} : { java: said }) },
				remedy: present
					? "java 在，这次没起来；原因看 detail.java（内存不够时 JVM 起不来）。"
					: "把 JAVA_HOME 指向 JDK 8，或确认 java 在 PATH 上。",
			},
		);
	}

	if (classpathEntries.length === 0) {
		// Not fatal: the argfile is produced by the project's build, and a first run
		// legitimately has none yet. It is recorded so the key is not silently based
		// on an empty classpath.
		notes.push("尚未有 build/cosmic-javac.args，classpath 指纹按空算（首次 build 后会变，届时缓存必然失效）");
	}

	const key = computeRuntimeKey({
		agentVersion: input.agentVersion,
		project: fingerprintProject({
			root,
			isv: config.isv,
			debugModule: config.debugModule,
			codeModules: config.codeModules,
		}),
		jdk,
		cosmicRuntime: runtime.fingerprint,
		classpath: fingerprintClasspath(classpathEntries),
		resources: fingerprintResources(input.resources),
	});

	(input.binding ?? new RuntimeBinding()).bind(key);

	const before = await inspectCache(input.cacheRoot, key);
	const cache = before.layout;
	// A stale cache names the dimension that changed: "your Cosmic JARs moved" and
	// "you changed JDK" ask the user for different things.
	const cacheReason = before.state === "stale" ? describeDiff(before.diff) : before.state;
	ports.fs.mkdirp(cache.root);
	const release = await releaseResources(cache, input.resources);
	await writeCacheManifest(cache, key);

	const layout = kernelLayout({
		root,
		cacheRoot: cache.root,
		runtimeKeyId: key.id,
		resourcesDir: cache.resourcesDir,
		codeModules: config.codeModules,
		moduleDirs: config.auto.moduleDirs,
		debugModule: config.debugModule,
	});
	// S19: whatever an older release left under build/ moves into .cosmic-ai/, and
	// old RuntimeKey directories are reclaimed. Both are near-free when there is
	// nothing to do, which is every open after the first.
	notes.push(...upkeepProjectLayout(layout, ports.fs).notes);
	const reclaimed = await reclaimRuntimeCaches({
		cacheRoot: input.cacheRoot,
		currentKeyId: key.id,
		fs: ports.fs,
		proc: ports.proc,
		now: ports.clock.now(),
	});
	if (reclaimed.removed.length > 0) {
		notes.push(
			`清掉了 ${String(reclaimed.removed.length)} 个很久没用的旧缓存目录（换过版本 / JDK / 苍穹运行时留下的，下次用到会自动重建）`,
		);
	}

	return {
		ctx: createContext({
			projectRoot: root,
			config,
			layout,
			env,
			ports,
			runtimeKeyId: key.id,
			probes: releasedProbeNames(input.resources),
			releasedProbeDigests: releasedProbeDigests(input.resources),
			platform: input.platform,
		}),
		key,
		cache: { state: before.state, reason: cacheReason },
		release: { released: release.released.length, reused: release.reused.length, repaired: release.repaired.length },
		notes,
	};
}

/** Minimal env for the version probe; the full composition lives in context.ts. */
function childProcessEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const key of ["PATH", "Path", "SystemRoot", "JAVA_HOME", "COMSPEC", "ComSpec"]) {
		const value = env[key];
		if (value !== undefined) out[key] = value;
	}
	return out;
}
