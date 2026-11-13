/**
 * Where the fast -> probe chain reads and writes (S3.1, S19).
 *
 * Three owners, kept apart on purpose:
 *
 *   projectBuild -- <root>/build, owned by the project's own Gradle build. The
 *     pathing jar, the javac argfile and the module class directories are
 *     produced by gradlew and must stay where the build puts them. **Nothing
 *     cosmic owns lives here any more (S19):** `gradlew clean` or an IDE rebuild
 *     deletes the whole tree, and it used to take the impact index, filed verify
 *     results and the project write lock with it.
 *
 *   cosmicDir    -- <root>/.cosmic-ai, everything cosmic keeps per project, in
 *     two kinds a reader can tell apart by directory:
 *       evidence/  loses something when deleted: verification records, the raw
 *                  logs they cite, and delivery receipts
 *       work/      rebuildable: impact index, capsule delivery, spilled output,
 *                  the write lock
 *     plus config.json, project.yaml and the ad-hoc probes/.
 *
 *     `cases/` was the third kind until S22 retired the regression case set. It
 *     was the only part meant for Git, and that is exactly what stopped working:
 *     assets a person maintains are not something a tool should be manufacturing
 *     out of one-off commands.
 *
 *   agentCache   -- the RuntimeKey-scoped cache directory from S2. Everything
 *     cosmic itself compiles or remembers (probe classes, lint classes, lint
 *     stamps, the resident JVM's pid/log) lives here.
 *
 * The frozen driver put both in <root>/build. That was safe for a skill that
 * only ever saw one runtime, but D10 requires class output to be scoped by
 * RuntimeKey: with a single <root>/build/probe-classes, switching the project's
 * cosmic_home to a different runtime would reuse probe classes compiled against
 * the old JARs, and the symptom is a NoSuchMethodError naming a business class
 * rather than anything that points at the cache. The split is registered as a
 * deliberate departure in docs/S3-slice.md.
 */

import { join } from "node:path";
import { type ModuleDirMap, moduleRoot } from "./config/gradle.ts";

export interface ModuleDirs {
	name: string;
	/** <root>/<moduleDir>/src/main/java */
	src: string;
	/** <root>/<moduleDir>/build/classes/java/main */
	out: string;
}

export interface KernelLayout {
	root: string;
	/** Gradle's output directory for this project. */
	projectBuild: string;
	pathingJar: string;
	javacArgs: string;
	/** Project-scoped rather than RuntimeKey-scoped: two runtimes still write the same classes. */
	projectWriteLock: string;
	/** S15.2: compact proof of Capsules actually placed in model-visible context. */
	knowledgeCapsules: string;
	/** Full text of tool output that was truncated before reaching the model (D14.2). */
	outputDir: string;
	/** `.cosmic-ai/evidence`: deleting anything here loses something. */
	evidenceDir: string;
	/** `.cosmic-ai/work`: everything here can be rebuilt. */
	workDir: string;
	/** Delivery receipts sit beside the raw logs they cite, not in another tree. */
	verifyDir: string;
	/**
	 * 验证记录：一次带 `--expect` 的运行留下的事实（S22.1.2）。
	 *
	 * One file per run, named by its digest, never overwritten. Under `evidence/`
	 * because deleting one loses something: after S22 these are the *only* thing
	 * `finish` will accept as proof that the change was verified, and each one
	 * cites a raw log that must stay findable next to it.
	 *
	 * Deliberately not RuntimeKey-scoped as a directory: the RuntimeKey is one of
	 * the facts recorded **inside** each file and checked on read, so scoping the
	 * directory too would only hide a mismatch instead of reporting it -- the same
	 * reasoning as `verifyResults`.
	 */
	assertionEvidence: string;
	/** Project-owned Cosmic data (`project.yaml` and the evidence tree), not a requirement ledger. */
	cosmicDir: string;
	/**
	 * The impact index. NOT RuntimeKey-scoped: it is a project-level derived fact,
	 * so splitting it per runtime would give one project several disagreeing
	 * answers to "who touches this bill". The runtime it was built under is stamped
	 * INSIDE the file instead, and a mismatch is reported.
	 */
	impactIndex: string;
	/** Intermediates of an index build (static side, metadata side, field whitelists). */
	impactWork: string;

	/** RuntimeKey-scoped agent cache root (S2 cacheLayout.root). */
	agentCache: string;
	/** Released agent-owned Java sources: probes/ and runtime/. */
	resourcesDir: string;
	probesDir: string;
	hostSrc: string;
	bridgeSrc: string;
	/** Headless form, bill and list views (package cosmic.headless): host code, loaded by the system class loader. */
	viewsSrc: string;
	/**
	 * No-op stand-in for the platform's server entry `kd.bos.service.bootstrap.Booter`.
	 * Host code: CosmicProbe reads its marker, so every host compile must include it, and
	 * probe-classes sits ahead of the platform jars so it shadows the real one. It lets
	 * the host run a launch class's own main() (appMethod=main) without starting a server.
	 */
	bootStubSrc: string;
	/**
	 * Makes the simulated client channel a real `ClientViewProxy` (package cosmic.headless).
	 * Resident host only, compiled on its own: it needs ASM from the Cosmic libs, and a
	 * runtime without ASM must still get a working host.
	 */
	channelHookSrc: string;
	serverSrc: string;
	initGradle: string;
	/** ApiTool.java: reflection lookup behind lint's "closest real name" hints. */
	apiToolSrc: string;
	/** SrcIndexTool.java: the impact index's static side (javac Tree API, offline). */
	srcIndexToolSrc: string;
	/** ProdReader.java: the production read-only channel (plain JDBC, no Cosmic runtime). */
	prodReaderSrc: string;

	probeClasses: string;
	lintClasses: string;
	toolClasses: string;
	probeHotOut: string;
	lintStamp: string;
	probeSrcIndex: string;
	lastProbeJson: string;
	lastProbeOut: string;
	/** One file per probe run, never overwritten by the next run; see `probe/stash.ts`. */
	probeRuns: string;
	serverPid: string;
	serverLog: string;
	/**
	 * The resident JVM's class-swap entry (S27 3.1): a manifest-only jar handed to
	 * `-javaagent`, whose premain gives the host an Instrumentation. Built next to
	 * the host classes; missing means the JVM starts without it and every change
	 * of classes costs a restart, as before.
	 */
	hotSwapAgentJar: string;
	/**
	 * "The classes under this JVM changed after it was started."
	 *
	 * Written by `fast` instead of restarting on the spot, and consumed by the one
	 * place that actually uses the resident JVM. Recompiling five files one after
	 * another used to pay five cold starts for four JVMs nothing ever talked to;
	 * the freshness rule is unchanged, only the moment it is paid at moves --
	 * see `markServerStale`.
	 */
	serverStale: string;
	/**
	 * The local debug node (S5.4: start / status / logs / stop).
	 *
	 * The frozen driver kept both at <root>/build/cosmic-debug.{pid,log} with no
	 * identity in the pid file. They move into the RuntimeKey cache for the same
	 * reason the resident probe JVM's did (D10): the node is a JVM launched from
	 * one runtime's pathing jar, and a pid file two runtimes share is how one
	 * project ends up reporting -- or killing -- the other project's node. The
	 * manifest carries the key id; the absolute paths are reported on every
	 * result so the log stays findable after the move.
	 */
	debugPid: string;
	debugLog: string;

	moduleDirs: ModuleDirs[];
	/**
	 * The debug module, which holds the launch class every probe JVM configures itself
	 * from. Not a code module (nothing deploys it), so `moduleDirs` leaves it out and the
	 * business-class freshness scan never looks at it; `refreshLaunchClasses` does.
	 * Null when the project has no detected debug module.
	 */
	launchModule: ModuleDirs | null;
}

export interface LayoutInput {
	root: string;
	/** RuntimeKey-scoped cache root. */
	cacheRoot: string;
	/** RuntimeKey id, for the project-side artefacts that must not be shared across runtimes. */
	runtimeKeyId: string;
	/** Directory the agent released its own probes/ and runtime/ sources into. */
	resourcesDir: string;
	codeModules: readonly string[];
	/** settings.gradle `projectDir` relocations; a module not listed lives at `<root>/<module>`. */
	moduleDirs?: ModuleDirMap;
	/** The debug module holding the launch class; absent or null means none. */
	debugModule?: string | null;
}

export const COSMIC_DIR = ".cosmic-ai";

/** `<root>/.cosmic-ai/work` -- the rebuildable half of the project's cosmic data. */
export function workDirOf(root: string): string {
	return join(root, COSMIC_DIR, "work");
}

/**
 * Where Capsule delivery is recorded, without opening the project.
 *
 * Split out of `kernelLayout` because the prompt hook records delivery with only
 * a root and a key id in hand, and must not pay for `openProject` (JDK plus
 * several thousand JARs fingerprinted) to get the path. Two copies of the join
 * would be a silent failure: the audit would read a file nobody writes.
 */
export function knowledgeCapsulesFile(root: string, runtimeKeyId: string): string {
	return join(workDirOf(root), "capsules", `${runtimeKeyId}.json`);
}

/**
 * True for an ad-hoc probe in its recommended home, `<工程>/.cosmic-ai/probes/`.
 *
 * Such a file is a verification draft, not a change: it is outside every code
 * module, so no fingerprint, compile or delivery list should count it. Path-only
 * on purpose -- the edit hook has no project open and must not pay for one.
 */
export function isAdHocProbeFile(file: string): boolean {
	return file.replace(/\\/g, "/").toLowerCase().includes("/.cosmic-ai/probes/");
}

function moduleDirsOf(root: string, name: string, dirs: ModuleDirMap | undefined): ModuleDirs {
	return {
		name,
		src: join(moduleRoot(root, name, dirs), "src", "main", "java"),
		out: join(moduleRoot(root, name, dirs), "build", "classes", "java", "main"),
	};
}

export function kernelLayout(input: LayoutInput): KernelLayout {
	const { root, cacheRoot, resourcesDir } = input;
	const projectBuild = join(root, "build");
	const cosmicDir = join(root, COSMIC_DIR);
	const evidenceDir = join(cosmicDir, "evidence");
	const workDir = workDirOf(root);
	const verifyDir = join(evidenceDir, "verify");
	const probesDir = join(resourcesDir, "probes");
	const runtimeDir = join(resourcesDir, "runtime");
	return {
		root,
		projectBuild,
		pathingJar: join(projectBuild, "cosmic-pathing.jar"),
		javacArgs: join(projectBuild, "cosmic-javac.args"),
		projectWriteLock: join(workDir, "write.lock"),
		knowledgeCapsules: knowledgeCapsulesFile(root, input.runtimeKeyId),
		outputDir: join(workDir, "out"),
		evidenceDir,
		workDir,
		verifyDir,
		assertionEvidence: join(evidenceDir, "assertions"),
		cosmicDir,
		impactIndex: join(workDir, "impact.json"),
		impactWork: join(workDir, "impact"),

		agentCache: cacheRoot,
		resourcesDir,
		probesDir,
		hostSrc: join(runtimeDir, "CosmicProbe.java"),
		// Part of the host, not a probe (CosmicProbe.initEnv calls it), so it is not
		// under probes/. Every compile of the host must include it and every staleness
		// check must count it -- missing it means "I edited the bridge and nothing
		// happened", with no error.
		bridgeSrc: join(runtimeDir, "ServiceBridge.java"),
		// Also host, not a probe: the platform's script plugins look the view class up by
		// name from the system class loader and read its package, so the views FormSim and
		// ListSim open must live here, in a named package -- not in a probe.
		viewsSrc: join(runtimeDir, "HeadlessViews.java"),
		bootStubSrc: join(runtimeDir, "Booter.java"),
		channelHookSrc: join(runtimeDir, "ClientChannelHook.java"),
		serverSrc: join(runtimeDir, "CosmicProbeServer.java"),
		initGradle: join(runtimeDir, "cosmic-run.gradle"),
		apiToolSrc: join(resourcesDir, "tools", "ApiTool.java"),
		srcIndexToolSrc: join(resourcesDir, "tools", "SrcIndexTool.java"),
		prodReaderSrc: join(resourcesDir, "tools", "ProdReader.java"),

		probeClasses: join(cacheRoot, "probe-classes"),
		lintClasses: join(cacheRoot, "lint-classes"),
		toolClasses: join(cacheRoot, "tool-classes"),
		probeHotOut: join(cacheRoot, "probe-hot"),
		lintStamp: join(cacheRoot, "lint-stamp.json"),
		probeSrcIndex: join(cacheRoot, "probe-classes", ".probe-src.json"),
		lastProbeJson: join(cacheRoot, "last-probe.json"),
		lastProbeOut: join(cacheRoot, "last-probe.out"),
		probeRuns: join(cacheRoot, "probe-runs"),
		serverPid: join(cacheRoot, "probe-server.pid"),
		serverLog: join(cacheRoot, "probe-server.log"),
		hotSwapAgentJar: join(cacheRoot, "probe-classes", "hotswap-agent.jar"),
		serverStale: join(cacheRoot, "probe-server.stale"),
		debugPid: join(cacheRoot, "cosmic-debug.pid"),
		debugLog: join(cacheRoot, "cosmic-debug.log"),

		// moduleDir handles nested modules (`apps:order` is apps/order) and `projectDir` relocations.
		moduleDirs: input.codeModules.map((name) => moduleDirsOf(root, name, input.moduleDirs)),
		launchModule: input.debugModule ? moduleDirsOf(root, input.debugModule, input.moduleDirs) : null,
	};
}
