import { mkdirSync, writeFileSync } from "node:fs";
import { open as openFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { nodeReflectionPort, UNAVAILABLE_REFLECTION } from "../../kernel/api-tool.ts";
import { type BuildOptions, type BuildReport, build } from "../../kernel/commands/build.ts";
import { type DeployOptions, type DeployReport, deploy } from "../../kernel/commands/deploy.ts";
import { type DoctorReport, doctor } from "../../kernel/commands/doctor.ts";
import { type FastProgress, type FastReport, fast } from "../../kernel/commands/fast.ts";
import {
	boundForms,
	type ImpactReport,
	type ImpactRequest,
	type IndexRefresh,
	impact,
	refreshIndexIfStale,
	refreshMeta,
} from "../../kernel/commands/impact.ts";
import {
	type KnowledgeReport,
	type KnowledgeRequest,
	knowledgeProbes,
	runKnowledge,
} from "../../kernel/commands/knowledge.ts";
import { type LintReport, lint } from "../../kernel/commands/lint.ts";
import { type MetaOptions, type MetaReport, meta } from "../../kernel/commands/meta.ts";
import { type NodeAction, type NodeOptions, type NodeReport, node } from "../../kernel/commands/node.ts";
import {
	type ProbeCatalogEntry,
	type ProbeOptions,
	type ProbeOutcome,
	type ProbePreparation,
	prepareProbeInvocation,
	probe,
	releasedProbeInputs,
} from "../../kernel/commands/probe.ts";
import { type ProbeServerAction, type ProbeServerReport, probeServer } from "../../kernel/commands/probe-server.ts";
import {
	checkProdConnection,
	loadProdConfig,
	type ProdOutcome,
	type ProdRequest,
	prod,
} from "../../kernel/commands/prod.ts";
import {
	prepareRunInvocation,
	type RunOptions,
	type RunPreparation,
	type RunReport,
	run,
} from "../../kernel/commands/run.ts";
import { resolveSources } from "../../kernel/commands/sources.ts";
import { lookupUsers as runUserLookup, type UserLookupReport } from "../../kernel/commands/user-lookup.ts";
import {
	initializeProjectConfig,
	type ProjectConfigAnswers,
	type ProjectConfigInitialization,
} from "../../kernel/config/initialize.ts";
import { loadConfig } from "../../kernel/config/load-config.ts";
import { resolveProjectRoot } from "../../kernel/config/project-root.ts";
import { KernelError, type KernelResult } from "../../kernel/errors.ts";
import { captureFreshnessAsync, type FreshnessSnapshot } from "../../kernel/freshness.ts";
import { metaCheckDue, metaPending } from "../../kernel/impact/meta-state.ts";
import { knowledgeCapsulesFile } from "../../kernel/layout.ts";
import { type OpenProjectInput, openProject } from "../../kernel/open-project.ts";
import { dataWriteEffectNotes } from "../../kernel/policy/external-effects.ts";
import {
	inspectProjectWriteLock,
	recoverProjectWriteLock,
	type WriteLockInspection,
	type WriteLockRecovery,
} from "../../kernel/policy/write-lock-recovery.ts";
import { isDataWriter } from "../../kernel/policy/write-plan.ts";
import { nodePorts } from "../../kernel/ports.ts";
import { BOOT_LOG_READ_BYTES, parseServerBoot, type ServerBootFacts } from "../../kernel/probe/boot-facts.ts";
import { type LocalServiceStatus, localServiceHealth } from "../../kernel/probe/health.ts";
import {
	type JvmScan,
	type LocalJvm,
	type StopResult,
	scanLocalJvms,
	stopLocalJvm,
} from "../../kernel/probe/local-jvms.ts";
import { readManifest, residentReady } from "../../kernel/probe/server.ts";
import { watchService } from "../../kernel/probe/service-events.ts";
import { prodMonitorSessionFile } from "../../kernel/prod/config.ts";
import {
	loadMonitorSession,
	type MonitorCaptcha,
	monitorCaptcha,
	monitorLogin,
	monitorPing,
	nodeHttp,
	saveMonitorSession,
} from "../../kernel/prod/monitor.ts";
import {
	type DiagnosisInput,
	type DiagnosisReport,
	type ProdEvidence,
	writeDiagnosis,
} from "../../kernel/prod/report.ts";
import {
	mergeProdConfig,
	type ProdConfigDraft,
	type ProdSetupAnswers,
	prodConfigFromMerged,
	readProdConfigDraft,
	writeProdConfig,
} from "../../kernel/prod/setup.ts";
import { writeProjectProfile } from "../../kernel/project/profile.ts";
import { profileEnvironmentFrom } from "../../kernel/project/profile-environment.ts";
import { artifactState } from "../../kernel/toolchain.ts";
import { type KnowledgeCapsule, pluginKnowledgeCapsules, sourceKnowledgeCapsules } from "../../knowledge/capsule.ts";
import { type CapsuleDeliveryEntry, capsuleDeliveryStore } from "../../knowledge/capsule-store.ts";
import { type KnowledgeBase, nodeKnowledgeDocs, openKnowledgeBase } from "../../knowledge/docs.ts";
import { loadKnowledgeSnapshot } from "../../knowledge/embedded.ts";
import type { KnowledgeSnapshot } from "../../knowledge/pack.ts";
import { type KnowledgeAdvisor, knowledgeAdvisor } from "../../knowledge/plugin-gate.ts";
import { prepareProbeApis } from "../../knowledge/probe-api-preflight.ts";
import {
	checkSkillEntries,
	estimateInjectionBudget,
	type LocalReferenceDoc,
	parseSkillFrontmatter,
	REFERENCE_PACK_FILENAME,
	readReleasedSkills,
	referenceSkillPaths,
	releaseReference,
	writeFamilyIndexes,
} from "../../knowledge/reference.ts";
import { releaseKnowledge } from "../../knowledge/release.ts";
import { type KnowledgeSourceStatus, nodeKnowledgeFileSystem, resolveKnowledgeSource } from "../../knowledge/source.ts";
import { type JarScanMemory, nodeJarScanner, rememberingJarScanner } from "../../runtime/fingerprint.ts";
import { type EmbeddedResource, releasedProbeCatalog } from "../../runtime/resources.ts";

export interface AgentProjectSummary {
	root: string;
	runtimeKeyId: string;
	releasedProbes: string[];
	/** Required input names for the released probes that declare any. */
	probeInputs: Record<string, string[]>;
	cache: { state: "fresh" | "absent" | "stale"; reason: string };
	release: { released: number; reused: number; repaired: number };
	notes: string[];
	profile?: { file: string; at: string; changed: boolean };
	identity: { user: string | null; account: string | null };
	/**
	 * 工程的 Gradle 产物（pathing jar + javac argfile）在不在、是不是列着全部代码模块。
	 *
	 * 摆出来是因为它决定「下一步会不会静默跑一次 gradle」：`ensureBuilt` 缺这两个文件
	 * 就自己去 build，而那是 `ports.proc.run`（spawnSync）里的几分钟——TUI 启动时自动
	 * 触发的话，界面从第一秒起就一动不动。notes 里其实有一句「尚未有 build/cosmic-javac.args」，
	 * 但那是给人读的散文；按文字去判断要不要跳过一步，下次改文案就静默失效了。
	 */
	built: boolean;
}

/** Wizard answers that have an environment override, so a lookup can use them unwritten. */
export interface PendingRuntimeAnswers {
	isv?: string;
	account?: string;
}

export interface OpenedAgentProject<ProjectHandle> {
	handle: ProjectHandle;
	summary: AgentProjectSummary;
}

export interface CosmicAgentKernel<ProjectHandle> {
	/** TUI startup only: explicit COSMIC_PROJECT_ROOT wins and fails closed when invalid. */
	discover?(cwd: string): Promise<KernelResult<{ root: string; source: "explicit" | "cwd" }>>;
	/**
	 * TUI startup only: turn a phone number into the user id the config needs.
	 *
	 * Takes the wizard's not-yet-written answers because it must reach the runtime
	 * BEFORE the config is confirmed -- the whole point is that the user cannot
	 * answer `user` without asking the environment first. Only the fields that
	 * have an env override travel this way; anything else is already on disk or
	 * auto-detected.
	 *
	 * Optional for the same reason the two above are: a kernel without it makes the
	 * wizard fall back to asking for the id, not fail.
	 */
	lookupUsers?(
		projectRoot: string,
		keyword: string,
		pending: PendingRuntimeAnswers,
	): Promise<KernelResult<UserLookupReport>>;
	/** TUI startup only: merge confirmed missing values into the project-local config. */
	initializeConfig?(
		projectRoot: string,
		answers: ProjectConfigAnswers,
		declaredModules: readonly string[],
	): Promise<KernelResult<ProjectConfigInitialization>>;
	/**
	 * `rescanRuntime`：打开工程时把苍穹运行时整扫一遍，不用记住的那份；每次工具调用的重开不给，
	 * 目录没变就沿用（见 `rememberingJarScanner`）。
	 */
	open(
		projectRoot: string,
		options?: { rescanRuntime?: boolean },
	): Promise<KernelResult<OpenedAgentProject<ProjectHandle>>>;
	lint(project: ProjectHandle, sources: readonly string[]): Promise<KernelResult<LintReport>>;
	fast(
		project: ProjectHandle,
		sources: readonly string[],
		/**
		 * `onProgress`：交互界面用的进度回调；命令行不传，行为与不传时完全一致。
		 * `writtenFiles`：本次会话用编辑工具写过的源码，「本次会话改的」只认它（见 `FastHooks.writtenFiles`）；
		 * 不传就按修改时间判。
		 */
		report?: {
			onProgress?: (progress: FastProgress) => void;
			writtenFiles?: readonly string[];
			/** 写法兜底（见 `FastHooks.styleGate`）；不传不查。 */
			styleGate?: (files: readonly string[]) => { file: string; lines: string[] }[];
		},
	): Promise<KernelResult<FastReport>>;
	freshness(project: ProjectHandle): Promise<KernelResult<FreshnessSnapshot>>;
	probe(project: ProjectHandle, name: string, options: ProbeOptions): Promise<KernelResult<ProbeOutcome>>;
	/**
	 * S5.2. `run` takes the frozen argv because that is what a `run` case stores
	 * and what the reference skills document; the kernel parses it into named
	 * values and no part of it ever becomes a command line.
	 */
	run(project: ProjectHandle, argv: readonly string[], options: RunOptions): Promise<KernelResult<RunReport>>;
	build(project: ProjectHandle, options: BuildOptions, signal?: AbortSignal): Promise<KernelResult<BuildReport>>;
	probeServer(project: ProjectHandle, action: ProbeServerAction): Promise<KernelResult<ProbeServerReport>>;
	/** TUI 的轻量只读心跳；不运行环境体检或启动服务。 */
	localServiceHealth?(project: ProjectHandle): Promise<LocalServiceStatus>;
	watchLocalService?(project: ProjectHandle, listener: Parameters<typeof watchService>[1]): () => void;
	/**
	 * 本机 cosmic 起的所有 JVM（各个版本、各个工程），给本地进程面板和底栏用；不需要打开工程。
	 * `listProcesses` 查一次本机进程清单（约 1 秒），`clean` 顺手删失效登记。
	 */
	localJvms?(options: { listProcesses: boolean; clean: boolean }): Promise<JvmScan>;
	/** 停清单里的一个：先请它自己退，等不到再核对身份后强制结束；身份对不上不动。 */
	stopLocalJvm?(jvm: LocalJvm): Promise<StopResult>;
	/** 日志最后几行；文件不在给空。只读尾巴，不整份读。 */
	logTail?(file: string, lines: number): Promise<string[]>;
	/**
	 * 当前工程常驻 JVM 的开机经过（首页进程树用）：只读它自己写的那几行日志和登记；
	 * 没有日志给 null。不问心跳、不启动，在不在跑由心跳那边说。
	 */
	residentBoot?(project: ProjectHandle): Promise<{ facts: ServerBootFacts; startedAt: string | null } | null>;
	/**
	 * S5.3. The impact index: source + metadata folded into class -> entity/field
	 * touches, queried back against the ledger and the case set. `build` is the
	 * only action that writes; the rest are read-only reflections of the index
	 * already on disk.
	 */
	impact(project: ProjectHandle, request: ImpactRequest): Promise<KernelResult<ImpactReport>>;
	/**
	 * 生产只读排障（cosmic_prod）：查生产库、拉生产元数据、查 monitor 日志。没有就是这个宿主不支持，
	 * 工具照实说「不支持」。下面几个 prod* 同理。
	 */
	prod?(project: ProjectHandle, request: ProdRequest): Promise<KernelResult<ProdOutcome>>;
	/** 诊断报告：核对引用的证据编号后落盘 */
	prodReport?(
		project: ProjectHandle,
		input: DiagnosisInput,
		evidence: readonly ProdEvidence[],
	): KernelResult<DiagnosisReport>;
	/** monitor 登录第一步：要不要验证码；要就把图存成文件，交给界面给人看 */
	prodMonitorCaptcha?(): Promise<KernelResult<MonitorCaptcha & { imageFile: string | null; username: string }>>;
	/** monitor 登录第二步：用人输的验证码登录，会话存到本机 */
	prodMonitorLogin?(captcha: MonitorCaptcha, code: string): Promise<KernelResult<{ loggedInAt: number }>>;
	/** monitor 保活：alive 还登着，expired 已过期，none 没有会话或没配 monitor */
	prodMonitorPing?(): Promise<"alive" | "expired" | "none">;
	/** 生产排障配置向导：读现在的配置，哪些项缺了、monitor 配没配 */
	prodSetupDraft?(): ProdConfigDraft;
	/** 用还没落盘的答案试连生产库一次；连上了给一句话 */
	prodSetupCheck?(
		project: ProjectHandle,
		draft: ProdConfigDraft,
		answers: ProdSetupAnswers,
	): Promise<KernelResult<string>>;
	/** 答案并进配置文件；问人期间文件被别处改过就不写 */
	prodSetupWrite?(draft: ProdConfigDraft, answers: ProdSetupAnswers): KernelResult<{ file: string; created: boolean }>;
	/**
	 * S17 2.6. Rebuilds the code half of the impact index when it no longer matches
	 * the sources; called when a project is opened, never on every tool call
	 * (`open` runs on every one through `reopen`). Never fails: the answer is a
	 * sentence. Optional so a test kernel without it simply skips the step.
	 */
	refreshIndex?(project: ProjectHandle): Promise<IndexRefresh>;
	/**
	 * S5.4. Non-entity metadata: BOTP rules, print templates, workflow models.
	 *
	 * Takes the frozen argv for the same reason `run` does -- three shipped
	 * reference skills document these exact invocations -- and every action except
	 * the offline `diff` reaches its probe through `probe()`, so the stale gate,
	 * the write lock, the cold-process rule and the confirmed-target admission are
	 * the same ones, not copies.
	 */
	meta(project: ProjectHandle, argv: readonly string[], options: MetaOptions): Promise<KernelResult<MetaReport>>;
	/** Pure arguments/capability checks plus one batched doc/JAR API join for ad-hoc probes. */
	prepareProbe(
		project: ProjectHandle,
		name: string,
		options: Omit<ProbeOptions, "preparation">,
	): Promise<KernelResult<ProbePreparation>>;
	/** Run plan, adapter Capsule and non-rollback risk scan; never starts a process. */
	prepareRun(project: ProjectHandle, argv: readonly string[]): Promise<KernelResult<RunPreparation>>;
	/** S5.4. `:module:deployJar` into the runtime's lib/cus, then refresh the resident JVM. */
	deploy(project: ProjectHandle, options: DeployOptions): Promise<KernelResult<DeployReport>>;
	/** S5.4. The local debug node's lifecycle: start / status / logs / stop. */
	node(project: ProjectHandle, action: NodeAction, options: NodeOptions): Promise<KernelResult<NodeReport>>;
	/**
	 * Writes one tool's full output next to the project so the context budget can
	 * cut the copy the model sees (D14.2).
	 *
	 * Optional because it is a convenience, not a boundary: a kernel that cannot
	 * spill still gets its output cut, and the caller says so instead of pretending
	 * a file exists. Never let a failed spill fail the tool that produced the text.
	 */
	spillOutput?(project: ProjectHandle, label: string, text: string): Promise<KernelResult<{ file: string }>>;
	/** Read-only view of the project write lock, including crash residue. */
	inspectWriteLock(project: ProjectHandle): Promise<KernelResult<WriteLockInspection>>;
	/** Clears one named stale lock; refuses a live owner or a token that moved. */
	recoverWriteLock(project: ProjectHandle, token: string): Promise<KernelResult<WriteLockRecovery>>;
	/**
	 * Project diagnosis. Takes a root rather than an opened project on purpose:
	 * doctor is the command for the case where the project cannot be opened.
	 */
	doctor(projectRoot: string): Promise<KernelResult<DoctorReport>>;
	/**
	 * Read-only knowledge queries. The project root is optional because the
	 * knowledge base ships with the product (D13); it only decides whether a
	 * project-level knowledgeRoot override is considered.
	 *
	 * `project` is optional for a different reason: cosmic_knowledge answers in every
	 * phase, `closed` included. Only the `api` action needs a handle, and only to
	 * reach the user's JAR -- without one the join reports 反射不可用 rather than
	 * quietly answering from the snapshot as though it had been checked.
	 */
	knowledge(
		request: KnowledgeRequest,
		projectRoot: string | null,
		project?: ProjectHandle,
	): Promise<KernelResult<KnowledgeReport>>;
	/** Deterministic target knowledge for source edits and before-agent refreshes. */
	sourceCapsules(
		projectRoot: string,
		runtimeKeyId: string,
		files: readonly string[],
	): Promise<KernelResult<KnowledgeCapsule[]>>;
	/** Records only Capsules actually inserted into model-visible context. */
	recordCapsuleDelivery(
		projectRoot: string,
		runtimeKeyId: string,
		capsules: readonly KnowledgeCapsule[],
	): Promise<KernelResult<CapsuleDeliveryEntry[]>>;
	/**
	 * The `reference/` skills, released and ready for pi to discover (S7.3).
	 *
	 * Separate from `knowledge` because it is not a query: it is the carrier for
	 * the 28 self-authored documents, handed to pi once per session as a skill
	 * directory, and the official 1,763 documents deliberately do NOT travel this
	 * way -- one skill per API page would put roughly 600 KB into the system
	 * prompt, so they stay behind the tool.
	 */
	referenceSkills(): Promise<KernelResult<AgentReferenceSkills>>;
}

/** What resources_discover hands pi, plus the facts that say whether it is intact. */
export interface AgentReferenceSkills {
	/** Directories for pi's `skillPaths`. Absolute: a skill's location is what the model reads. */
	skillPaths: string[];
	/**
	 * Where the 28 member documents were released, absolute.
	 *
	 * Not handed to pi (that is `skillPaths`, the family indexes). This is here so
	 * code can NAME one member page -- `<docsDir>/cosmic-run/SKILL.md` -- in a
	 * refusal, and so the read of that path can be recognised when it happens. A
	 * "go read the docs" that cannot say which file is the advice that got
	 * ignored in the first place.
	 */
	docsDir: string;
	snapshotId: string;
	bundleVersion: string;
	/** Skills pi will accept —— 现在是族索引的篇数，不是文档数。 */
	loaded: number;
	/** Documents in the snapshot. */
	documents: number;
	/**
	 * 被族索引收进去的文档数。
	 *
	 * 少于 documents 就有文档谁也不知道它存在了——原文不再各自是一个 skill，
	 * 「模型知道有这篇」的唯一依据就是它出现在某一族的索引里。
	 */
	indexed: number;
	/** Why pi would reject a skill. Empty is the healthy case; pi itself rejects silently. */
	problems: { path: string; why: string }[];
	/** Resident system-prompt cost of the skill list, paths included. */
	residentBytes: number;
}

export interface KernelAdapterOptions {
	agentConfigDir: string;
	cacheRoot: string;
	agentVersion: string;
	resources: readonly EmbeddedResource[];
	env?: Readonly<Record<string, string | undefined>>;
	/**
	 * Absolute path of the embedded knowledge sidecar. Passed in from the edge,
	 * never derived here (D9). Absent means the knowledge commands report the
	 * sidecar as missing instead of quietly answering from an empty base.
	 */
	knowledgePackFile?: string;
	/**
	 * Absolute path of the reference-skill sidecar. Passed in from the edge for the
	 * same reason as knowledgePackFile, and NOT derived from it: "beside the other
	 * pack" is a release-layout fact, and deriving it here would make the adapter
	 * guess at a layout it does not own (D9).
	 */
	referencePackFile?: string;
}

type RealProject = Awaited<ReturnType<typeof openProject>>;

/** administrator。只在查用户这条只读路上顶一次 RequestContext，见 lookupUsers。 */
const LOOKUP_USER_ID = "1";

function kernelFailure<T>(error: unknown): KernelResult<T> {
	if (error instanceof KernelError) return { ok: false, error };
	throw error;
}

/**
 * The knowledge base, resolved once per adapter and reused.
 *
 * Released to disk on first use rather than at construction: an agent session
 * that never asks a knowledge question should not pay a 6 MB unpack, and a
 * missing sidecar must surface as a failure of the command that needed it, not
 * as a failed startup.
 */
function knowledgeResolver(options: KernelAdapterOptions): (projectRoot: string | null) => Promise<{
	base: KnowledgeBase;
	status: KnowledgeSourceStatus;
}> {
	let embedded: Promise<{ snapshot: KnowledgeSnapshot; docsDir: string }> | null = null;
	let embeddedBase: { root: string; base: KnowledgeBase } | null = null;
	const env = options.env ?? process.env;

	const load = async (): Promise<{ snapshot: KnowledgeSnapshot; docsDir: string }> => {
		if (options.knowledgePackFile === undefined) {
			throw new KernelError("KNOWLEDGE_UNAVAILABLE", "没有配置内嵌知识快照路径", {
				remedy:
					"组合包根目录（最近一个有 package.json 的目录）的 knowledge/ 下找不到 cosmic-kb.pack，" +
					"或用环境变量 COSMIC_KB_PACK 指定它的路径。这是安装问题，请用户检查安装包。",
			});
		}
		const snapshot = await loadKnowledgeSnapshot(options.knowledgePackFile);
		const released = await releaseKnowledge(options.cacheRoot, snapshot);
		return { snapshot, docsDir: released.layout.docsDir };
	};

	return async (projectRoot) => {
		embedded ??= load();
		const { snapshot, docsDir } = await embedded;
		// An override may be configured per project (config.json) or per call
		// (COSMIC_KNOWLEDGE_ROOT). Without a project only the environment applies.
		let configuredRoot: string | null = env.COSMIC_KNOWLEDGE_ROOT ?? null;
		if (projectRoot !== null) {
			const config = loadConfig({ root: projectRoot, agentConfigDir: options.agentConfigDir, env }, nodePorts.fs);
			configuredRoot = config.knowledgeRoot;
		}
		const status = resolveKnowledgeSource(
			{
				configuredRoot,
				embedded: {
					root: docsDir,
					bundleVersion: snapshot.header.bundleVersion,
					snapshotId: snapshot.header.snapshotId,
					docCount: snapshot.header.files.length,
				},
			},
			nodeKnowledgeFileSystem,
		);
		// 内嵌快照释放到按快照编号分的目录里，这个进程活着的时候内容不变：知识库对象只开一个，
		// 文档清单和平台类文档的表跟着它只做一遍（原来每次调用都把 platform/api 整个从盘上读两遍，
		// 临时探针每跑一次多等约 0.8 秒）。用户自己维护的目录随时会改，照旧每次重开。
		if (status.kind !== "embedded") return { base: openKnowledgeBase(status.root, nodeKnowledgeDocs), status };
		if (embeddedBase?.root !== status.root) {
			embeddedBase = { root: status.root, base: openKnowledgeBase(status.root, nodeKnowledgeDocs) };
		}
		return { base: embeddedBase.base, status };
	};
}

/**
 * The reference skills, released once per adapter.
 *
 * Memoised like the official snapshot and for the same reason -- a session that
 * never reloads should unpack once -- but with one difference that matters: a
 * failure here is returned, never thrown past the caller. pi's resources_discover
 * swallows a handler exception into an extension-error log the user does not
 * read, and the visible result would be an agent that has quietly forgotten its
 * own probe system, write rules and anti-patterns. That is defect D-2 coming
 * back through the carrier instead of through the content.
 */
function referenceResolver(options: KernelAdapterOptions): {
	skills: () => Promise<KernelResult<AgentReferenceSkills>>;
	localDocs: () => Promise<LocalReferenceDoc[]>;
} {
	let cached: Promise<AgentReferenceSkills> | null = null;
	// 成员文档正文，给 knowledge 的 search / api 在里面找查询词；和释放同一次读盘
	let searchable: LocalReferenceDoc[] = [];

	const load = async (): Promise<AgentReferenceSkills> => {
		if (options.referencePackFile === undefined) {
			throw new KernelError("KNOWLEDGE_UNAVAILABLE", "没有配置 reference skill 快照路径", {
				remedy:
					`组合包根目录（最近一个有 package.json 的目录）的 knowledge/ 下找不到 ${REFERENCE_PACK_FILENAME}，` +
					"或用环境变量 COSMIC_REFERENCE_PACK 指定它的路径。这是安装问题，请用户检查安装包。",
			});
		}
		const snapshot = await loadKnowledgeSnapshot(options.referencePackFile);
		const released = await releaseReference(options.cacheRoot, snapshot);
		// Read back off disk, not out of the pack: what pi scans is the released
		// tree, and a skill it rejects is a document that stopped existing without
		// anyone being told.
		const onDisk = await readReleasedSkills(released.layout, snapshot);
		// 成员文档仍按 pi 的 skill 契约校验：它们不再直接交给 pi，但 frontmatter 正是
		// 族索引里那行「什么时候读」的来源，缺了就等于这篇进不了任何一条注入。
		const problems = checkSkillEntries(onDisk);
		const rejected = new Set(problems.map((problem) => problem.path));
		const documents: { dir: string; description: string }[] = [];
		for (const entry of onDisk) {
			if (rejected.has(entry.path)) continue;
			const front = parseSkillFrontmatter(entry.text);
			if (front === null) continue;
			documents.push({ dir: entry.path.slice(0, entry.path.lastIndexOf("/")), description: front.description });
			searchable.push({
				name: front.name,
				description: front.description,
				file: join(released.layout.docsDir, ...entry.path.split("/")),
				text: entry.text.toLowerCase(),
				source: entry.text,
			});
		}
		const indexes = await writeFamilyIndexes(released.layout, documents);
		for (const dir of indexes.unfiled) {
			problems.push({ path: `${dir}/SKILL.md`, why: "没有归入任何族索引，模型不会知道它存在" });
		}
		problems.push(...checkSkillEntries(indexes.entries));
		const fronts = indexes.entries
			.map((entry) => parseSkillFrontmatter(entry.text))
			.filter((front): front is { name: string; description: string } => front !== null);
		const [skillsDir] = referenceSkillPaths(released.layout);
		return {
			skillPaths: referenceSkillPaths(released.layout),
			docsDir: released.layout.docsDir,
			snapshotId: released.snapshotId,
			bundleVersion: released.bundleVersion,
			loaded: fronts.length,
			documents: snapshot.header.files.length,
			indexed: indexes.indexed,
			problems,
			residentBytes: estimateInjectionBudget(fronts, skillsDir ?? "").bytes,
		};
	};

	const skills = async (): Promise<KernelResult<AgentReferenceSkills>> => {
		try {
			cached ??= load();
			return { ok: true, value: await cached };
		} catch (error) {
			// Not cached: a missing sidecar that gets installed should work on reload.
			cached = null;
			searchable = [];
			return kernelFailure(error);
		}
	};
	// 释放失败时没有本地文档可搜，查询照常只答官方库；失败本身由 referenceSkills 报
	const localDocs = async (): Promise<LocalReferenceDoc[]> => ((await skills()).ok ? searchable : []);
	return { skills, localDocs };
}

/** Production adapter: every tool call opens one explicit project context. */
export function createKernelAdapter(options: KernelAdapterOptions): CosmicAgentKernel<RealProject> {
	const runtimeScans: JarScanMemory = new Map();
	const openInput: Omit<OpenProjectInput, "projectRoot"> = {
		agentConfigDir: options.agentConfigDir,
		cacheRoot: options.cacheRoot,
		agentVersion: options.agentVersion,
		resources: options.resources,
		...(options.env ? { env: options.env } : {}),
		// 每次工具调用都重开工程；同一个 java 问过一次就记住，不再每次起一个 JVM 去问版本
		jdkMemory: new Map(),
		// 苍穹运行时同理：整扫过一次，放 JAR 的那几个目录没动就不重扫
		jarScanner: rememberingJarScanner(nodeJarScanner, runtimeScans),
	};

	/**
	 * When this session started. One adapter is built per extension, so this is
	 * the session boundary, and it is the line `fast` draws between "stale because
	 * I edited it" and "stale before I got here" (see `FastHooks.authoredSince`).
	 */
	const sessionStartedAt = Date.now();
	/** 本机 JVM 清单看的缓存根：这一份，加上改名前的旧目录（那里可能还有没退出的旧版本）。 */
	const jvmCacheRoots = [...new Set([options.cacheRoot, join(homedir(), ".cosmic", "cache")])];
	const localJvmDeps = { fs: nodePorts.fs, proc: nodePorts.proc, net: nodePorts.net };

	const resolveKnowledge = knowledgeResolver(options);
	const reference = referenceResolver(options);
	const resolveReferenceSkills = reference.skills;
	const doctorConfigSnapshots = new Map<string, { text: string; exists: boolean }>();
	/** The automatic index rebuild in flight, per project root (S17 2.6). */
	const indexWork = new Map<string, Promise<IndexRefresh>>();
	/** The metadata snapshot check in flight, per project root (S17 4.4). */
	const metaWork = new Map<string, Promise<void>>();
	/** When this session last started a snapshot check, per project root. */
	const metaChecked = new Map<string, string>();
	/** Calls that read the index or use the resident JVM wait for both, rather than race them. */
	const settled = async (project: RealProject): Promise<void> => {
		const root = project.ctx.projectRoot;
		await indexWork.get(root);
		await metaWork.get(root);
	};
	/**
	 * Checks the metadata snapshot for changes and rescans them (S17 4.4) -- once a
	 * session, again after this machine writes metadata, and only on a resident JVM
	 * that is already running: never a cold start for a one-second check. Callers
	 * that need the result await it; the rest carry on, and the next call that uses
	 * the JVM waits for it through `settled`.
	 */
	const checkMeta = (project: RealProject): Promise<void> => {
		const root = project.ctx.projectRoot;
		const running = metaWork.get(root);
		if (running !== undefined) return running;
		const work = (async () => {
			await indexWork.get(root);
			if (!metaCheckDue(metaChecked.get(root), metaPending(project.ctx))) return;
			if (!(await residentReady(project.ctx))) return;
			metaChecked.set(root, new Date().toISOString());
			await refreshMeta(project.ctx);
		})()
			.catch(() => {
				// The check records its own failures beside the snapshot; one that throws leaves it unchecked, which every reader says.
			})
			.finally(() => metaWork.delete(root));
		metaWork.set(root, work);
		return work;
	};
	/** The embedded sources are fixed for the adapter's life; read them once, on first ask. */
	let catalog: ProbeCatalogEntry[] | null = null;
	const probeCatalog = (): ProbeCatalogEntry[] => {
		catalog ??= releasedProbeCatalog(options.resources);
		return catalog;
	};

	/**
	 * The single judge, built once per call and handed to BOTH halves (S7.4).
	 *
	 * The sharing is the point: `lint` previews the verdict and `fast` enforces
	 * it, and passing the same closure to both is what makes "lint said it would
	 * block and fast did not" impossible to express rather than merely unlikely.
	 *
	 * Null when no knowledge source could be resolved at all. The commands then
	 * report the gate as not wired instead of passing silently -- a missing
	 * sidecar must not read as a clean bill of health.
	 */
	const advisorFor = async (project: RealProject): Promise<KnowledgeAdvisor | null> => {
		const resolved = await resolveKnowledge(project.ctx.projectRoot).catch(() => null);
		if (resolved === null) return null;
		// 和读写源码时推的卡片同一份输入，摘要才对得上「这张卡发过没有」
		const local = await reference.localDocs();
		return knowledgeAdvisor({
			base: resolved.base,
			source: project.ctx.ports.fs,
			capsules: (families) => {
				try {
					const delivered = capsuleStoreFor(project).read();
					return pluginKnowledgeCapsules(resolved.base, families, project.ctx.runtimeKeyId, local).map(
						(capsule, index) => ({
							base: families[index]?.route.base ?? capsule.subject,
							digest: capsule.digest,
							subject: capsule.subject,
							confidence: capsule.confidence,
							sourceRefs: [...capsule.sourceRefs],
							delivered: delivered[capsule.digest] !== undefined,
						}),
					);
				} catch {
					return [];
				}
			},
		});
	};

	const capsuleStoreFor = (project: RealProject): ReturnType<typeof capsuleDeliveryStore> =>
		capsuleDeliveryStore({
			fs: project.ctx.ports.fs,
			file: project.ctx.layout.knowledgeCapsules,
			runtimeKeyId: project.ctx.runtimeKeyId,
			now: () => new Date(project.ctx.ports.clock.now()).toISOString(),
		});

	return {
		async discover(cwd) {
			try {
				const explicit = (options.env ?? process.env).COSMIC_PROJECT_ROOT;
				const resolution = resolveProjectRoot(
					{ explicit: explicit === "" ? null : explicit, cwd, entryFile: null, legacyRoot: null },
					(path) => nodePorts.fs.exists(path),
				);
				return { ok: true, value: { root: resolution.root, source: resolution.source as "explicit" | "cwd" } };
			} catch (error) {
				return kernelFailure(error);
			}
		},
		async lookupUsers(projectRoot, keyword, pending) {
			try {
				const base = options.env ?? process.env;
				const env: Record<string, string | undefined> = {
					...base,
					...(pending.isv === undefined ? {} : { COSMIC_ISV: pending.isv }),
					...(pending.account === undefined ? {} : { COSMIC_ACCOUNT: pending.account }),
					// RequestContext 建不起来就查不了库，而它要的正是这次要查的东西。
					// 只读查询里 userId 只当「修改人」用，这条路一个字都不写，所以用
					// administrator 顶上一次；它不会被写进任何配置，也不会被当成答案。
					COSMIC_USER: (base.COSMIC_USER ?? "").trim() === "" ? LOOKUP_USER_ID : base.COSMIC_USER,
					// 陈旧类闸门不再在这里放宽：UserProbe 登记在 platform 档
					// （kernel/policy/probe-freshness.ts），默认就放行，理由一模一样——
					// 业务类新不新跟「这个账套里有哪些用户」无关。
					//
					// 之前这里无条件写 COSMIC_STALE:"warn"，而且写在 ...base 之后，
					// 于是连用户显式设的 block 也一起盖掉了。同一个判断散在两处、其中一处
					// 还悄悄改写用户的设置，正是收进声明表的理由。
				};
				const opened = await openProject({ ...openInput, projectRoot, env });
				return await runUserLookup(opened.ctx, keyword);
			} catch (error) {
				return kernelFailure(error);
			}
		},
		async initializeConfig(projectRoot, answers, declaredModules) {
			try {
				const file = loadConfig(
					{ root: projectRoot, agentConfigDir: options.agentConfigDir, env: options.env ?? process.env },
					nodePorts.fs,
				).projectConfigFile;
				const expected = doctorConfigSnapshots.get(projectRoot);
				if (expected === undefined) {
					return {
						ok: false,
						error: new KernelError("CONFIG_INIT_CONFLICT", "配置初始化前没有当前 doctor 快照", {
							detail: { configFile: file },
							remedy: "先重新运行 doctor，再确认配置向导。",
						}),
					};
				}
				const result = initializeProjectConfig(
					{
						root: projectRoot,
						answers,
						expectedText: expected.text,
						expectedExists: expected.exists,
						declaredModules,
					},
					nodePorts.fs,
				);
				if (result.ok)
					doctorConfigSnapshots.set(projectRoot, {
						text: nodePorts.fs.read(file),
						exists: nodePorts.fs.exists(file),
					});
				return result;
			} catch (error) {
				return kernelFailure(error);
			}
		},
		referenceSkills() {
			return resolveReferenceSkills();
		},
		async open(projectRoot, openOptions) {
			try {
				if (openOptions?.rescanRuntime === true) runtimeScans.clear();
				const opened = await openProject({ ...openInput, projectRoot });
				const profile = writeProjectProfile(opened.ctx, opened.key);
				return {
					ok: true,
					value: {
						handle: opened,
						summary: {
							root: opened.ctx.projectRoot,
							runtimeKeyId: opened.key.id,
							built: artifactState(opened.ctx).state === "ok",
							releasedProbes: [...opened.ctx.probes],
							probeInputs: releasedProbeInputs(opened.ctx),
							cache: opened.cache,
							release: opened.release,
							notes: [...opened.notes],
							profile,
							identity: { user: opened.ctx.config.user, account: opened.ctx.config.account },
						},
					},
				};
			} catch (error) {
				return kernelFailure(error);
			}
		},
		async lint(project, sources) {
			const resolved = resolveSources(project.ctx, sources);
			if (!resolved.ok) return resolved;
			const advisor = await advisorFor(project);
			return lint(project.ctx, resolved.value, advisor === null ? {} : { knowledge: advisor });
		},
		async fast(project, sources, report) {
			const advisor = await advisorFor(project);
			return fast(project.ctx, sources, {
				...(advisor === null ? {} : { knowledgeGate: advisor }),
				...(report?.onProgress === undefined ? {} : { onProgress: report.onProgress }),
				...(report?.writtenFiles === undefined ? {} : { writtenFiles: report.writtenFiles }),
				...(report?.styleGate === undefined ? {} : { styleGate: report.styleGate }),
				// Session start, not project-open time: `reopen` runs on every tool call,
				// so open time is always "now" and would exempt nothing.
				authoredSince: sessionStartedAt,
				boundForms: (ctx, files) => boundForms(ctx, files),
			});
		},
		async sourceCapsules(projectRoot, runtimeKeyId, files) {
			try {
				const resolved = await resolveKnowledge(projectRoot);
				return {
					ok: true,
					value: sourceKnowledgeCapsules({
						base: resolved.base,
						source: nodePorts.fs,
						files,
						runtimeKeyId,
						local: await reference.localDocs(),
					}),
				};
			} catch (error) {
				return kernelFailure(error);
			}
		},
		async recordCapsuleDelivery(projectRoot, runtimeKeyId, capsules) {
			try {
				return {
					ok: true,
					value: capsuleDeliveryStore({
						fs: nodePorts.fs,
						file: knowledgeCapsulesFile(projectRoot, runtimeKeyId),
						runtimeKeyId,
						now: () => new Date().toISOString(),
					}).record(capsules),
				};
			} catch (error) {
				return kernelFailure(error);
			}
		},
		async freshness(project) {
			return { ok: true, value: await captureFreshnessAsync(project.ctx) };
		},
		async prepareRun(project, argv) {
			// The precheck's warnings rest on the snapshot (which layouts carry our plugins,
			// which plugins on the chain call out): check it first when that is due (S17 5.1/5.2).
			await checkMeta(project);
			return { ok: true, value: prepareRunInvocation(project.ctx, argv) };
		},
		async prepareProbe(project, name, probeOptions) {
			const basic = prepareProbeInvocation(project.ctx, name, probeOptions);
			// S21 / S23: seeding or updating data runs the bill's operation chain, so a
			// plugin on it that sends a message or calls out really does it. Until S27
			// that refused the run; the environment is a disposable test one now (user,
			// 2026-09-19), so it is a note. Asked here rather than inside the kernel's
			// prepare: the answer needs the impact index, and commands/impact.ts already
			// imports probe.ts. UPD_OP=direct bypasses the operation, so no plugin runs.
			if (basic.ok && basic.value.plan?.target.adHoc === false && isDataWriter(basic.value.plan.target.cls)) {
				const overlay = basic.value.plan.overlay;
				const updating = basic.value.plan.target.cls === "DataUpdateProbe";
				const direct = updating && (overlay.UPD_OP ?? "").trim().toLowerCase() === "direct";
				// The notes rest on the snapshot's registrations: check it first when that is due (S17 5.1).
				if (!direct) await checkMeta(project);
				const effects = direct
					? []
					: dataWriteEffectNotes(
							project.ctx,
							(updating ? overlay.UPD_ENTITY : overlay.SEED_ENTITY) ?? "",
							updating ? "update" : "seed",
						);
				if (effects.length === 0) return basic;
				return { ok: true, value: { ...basic.value, warnings: [...basic.value.warnings, ...effects] } };
			}
			if (!basic.ok || basic.value.plan?.target.adHoc !== true) return basic;
			const plan = basic.value.plan;
			try {
				const resolved = await resolveKnowledge(project.ctx.projectRoot);
				const api = await prepareProbeApis(
					resolved.base,
					plan.target.src,
					plan.sourceText,
					project.ctx.runtimeKeyId,
					nodeReflectionPort(project.ctx),
				);
				return prepareProbeInvocation(project.ctx, name, probeOptions, api);
			} catch (error) {
				return {
					ok: true,
					value: {
						...basic.value,
						warnings: [
							...basic.value.warnings,
							`知识包不可用，API Capsule 已降级；javac 仍会在 Cosmic JVM 前校验：${error instanceof Error ? error.message : String(error)}`,
						],
					},
				};
			}
		},
		async probe(project, name, probeOptions) {
			await settled(project);
			const result = await probe(project.ctx, name, probeOptions);
			if (result.ok && name === "EnvDiagProbe") {
				const environment = profileEnvironmentFrom(result.value);
				if (environment !== null) writeProjectProfile(project.ctx, project.key, environment);
			}
			// The first probe that found (or started) a resident JVM is the session's chance to check the snapshot.
			if (result.ok && result.value.path === "hot") void checkMeta(project);
			return result;
		},
		async run(project, argv, runOptions) {
			// The same knowledge gate `fast` gets: a run compiles the probe against the
			// project's classes, and reaching the shared environment before the family's
			// root flow has happened is what the gate exists to stop.
			const advisor = await advisorFor(project);
			await settled(project);
			return run(project.ctx, argv, {
				...runOptions,
				...(advisor === null ? {} : { hooks: { knowledgeGate: advisor } }),
			});
		},
		async build(project, buildOptions, signal) {
			return build(project.ctx, { ...buildOptions, signal });
		},
		async probeServer(project, action) {
			return probeServer(project.ctx, action);
		},
		async localServiceHealth(project) {
			// 顺带数一下本机别的 cosmic JVM：只读登记、问心跳，不查进程清单，底栏三秒问一次也不重。
			const [status, others] = await Promise.all([
				localServiceHealth(project.ctx),
				scanLocalJvms(localJvmDeps, { cacheRoots: jvmCacheRoots, listProcesses: false, clean: false }).then(
					(scan) => scan.jvms.filter((jvm) => jvm.keyId !== project.ctx.runtimeKeyId).length,
					() => 0,
				),
			]);
			return others > 0 ? { ...status, others } : status;
		},
		watchLocalService(project, listener) {
			return watchService(project.ctx, listener);
		},
		async localJvms(scan) {
			return scanLocalJvms(localJvmDeps, { cacheRoots: jvmCacheRoots, ...scan });
		},
		async stopLocalJvm(jvm) {
			return stopLocalJvm(localJvmDeps, jvm);
		},
		async logTail(file, lines) {
			return readTail(file, lines);
		},
		async residentBoot(project) {
			const text = await readEnds(project.ctx.layout.serverLog, BOOT_LOG_READ_BYTES);
			if (text === null) return null;
			const startedAt = readManifest(project.ctx)?.startedAt ?? "";
			return { facts: parseServerBoot(text), startedAt: startedAt === "" ? null : startedAt };
		},
		async prod(project, request) {
			return prod(
				project.ctx,
				{
					agentConfigDir: options.agentConfigDir,
					http: nodeHttp,
					isv: project.ctx.config.isv ?? "",
					runProbe: probe,
				},
				request,
			);
		},
		prodReport(project, input, evidence) {
			return writeDiagnosis(project.ctx, input, evidence);
		},
		async prodMonitorCaptcha() {
			const config = loadProdConfig(nodePorts.fs, options.agentConfigDir);
			if (!config.ok) return config;
			const monitor = config.value.monitor;
			if (monitor === null)
				return {
					ok: false,
					error: new KernelError("PROD_CONFIG_MISSING", "生产排障配置里没有 monitor 账号", {
						remedy: `请用户在会话里输入 /cosmic-prod-setup 补上 monitor 账号（写到本机 ${config.value.file}）。`,
					}),
				};
			const captcha = await monitorCaptcha(nodeHttp, monitor);
			if (!captcha.ok) return captcha;
			let imageFile: string | null = null;
			if (captcha.value.image !== null) {
				imageFile = join(
					options.cacheRoot,
					"prod",
					`monitor-captcha.${captcha.value.imageType === "png" ? "png" : "jpg"}`,
				);
				mkdirSync(dirname(imageFile), { recursive: true });
				writeFileSync(imageFile, captcha.value.image);
			}
			return { ok: true, value: { ...captcha.value, imageFile, username: monitor.username } };
		},
		async prodMonitorLogin(captcha, code) {
			const config = loadProdConfig(nodePorts.fs, options.agentConfigDir);
			if (!config.ok) return config;
			if (config.value.monitor === null)
				return { ok: false, error: new KernelError("PROD_CONFIG_MISSING", "生产排障配置里没有 monitor 账号") };
			const session = await monitorLogin(nodeHttp, config.value.monitor, captcha, code);
			if (!session.ok) return session;
			saveMonitorSession(nodePorts.fs, prodMonitorSessionFile(options.agentConfigDir), session.value);
			return { ok: true, value: { loggedInAt: session.value.loggedInAt } };
		},
		prodSetupDraft() {
			return readProdConfigDraft(nodePorts.fs, options.agentConfigDir);
		},
		async prodSetupCheck(project, draft, answers) {
			const config = prodConfigFromMerged(draft, mergeProdConfig(draft, answers));
			if (!config.ok) return config;
			return checkProdConnection(project.ctx, config.value);
		},
		prodSetupWrite(draft, answers) {
			return writeProdConfig(nodePorts.fs, draft, mergeProdConfig(draft, answers));
		},
		async prodMonitorPing() {
			const config = loadProdConfig(nodePorts.fs, options.agentConfigDir);
			if (!config.ok || config.value.monitor === null) return "none";
			const session = loadMonitorSession(
				nodePorts.fs,
				prodMonitorSessionFile(options.agentConfigDir),
				config.value.monitor.username,
			);
			if (session === null) return "none";
			return (await monitorPing(nodeHttp, config.value.monitor, session)) ? "alive" : "expired";
		},
		async impact(project, request) {
			// A background rebuild started at project open writes the same files a
			// query reads and a reindex writes: wait for it rather than race it.
			await settled(project);
			// A query is what the snapshot is for: check it first when that is due.
			if ((request.action ?? "query") === "query") await checkMeta(project);
			return impact(project.ctx, request);
		},
		async refreshIndex(project) {
			const root = project.ctx.projectRoot;
			const running = indexWork.get(root);
			if (running !== undefined) return running;
			const work = refreshIndexIfStale(project.ctx)
				.catch(
					(error: unknown): IndexRefresh => ({
						state: "failed",
						text: `自动重建代码关系表时出错（${error instanceof Error ? error.message : String(error)}），不影响继续干活`,
					}),
				)
				.finally(() => {
					indexWork.delete(root);
					// Opening the project with a resident JVM already up is the first chance to check the snapshot.
					void checkMeta(project);
				});
			indexWork.set(root, work);
			return work;
		},
		async meta(project, argv, metaOptions) {
			await settled(project);
			return meta(project.ctx, argv, metaOptions);
		},
		async deploy(project, deployOptions) {
			try {
				return await deploy(project.ctx, deployOptions);
			} finally {
				// 部署把 jar 原地换进苍穹运行时目录（同名、大小变了，目录时间不动）：下一次重开要整扫才看得见
				runtimeScans.clear();
			}
		},
		async node(project, action, nodeOptions) {
			return node(project.ctx, action, nodeOptions);
		},
		async spillOutput(project, label, text) {
			try {
				const dir = project.ctx.layout.outputDir;
				nodePorts.fs.mkdirp(dir);
				// 标签里的序号是会话内的，换个会话从头数：同名就往后加号，不盖掉上一个会话留的证据。
				const stem = label.replace(/[^\w.-]/g, "_");
				let file = join(dir, `${stem}.out`);
				for (let n = 2; nodePorts.fs.exists(file); n++) file = join(dir, `${stem}~${String(n)}.out`);
				nodePorts.fs.write(file, text);
				return { ok: true, value: { file } };
			} catch (error) {
				return kernelFailure(error);
			}
		},
		async inspectWriteLock(project) {
			return { ok: true, value: inspectProjectWriteLock(project.ctx) };
		},
		async recoverWriteLock(project, token) {
			return recoverProjectWriteLock(project.ctx, { token });
		},
		async doctor(projectRoot) {
			try {
				const root = resolveProjectRoot(
					{ explicit: projectRoot, cwd: null, entryFile: null, legacyRoot: null },
					(path) => nodePorts.fs.exists(path),
				).root;
				const config = loadConfig(
					{ root, agentConfigDir: options.agentConfigDir, env: options.env ?? process.env },
					nodePorts.fs,
				);
				doctorConfigSnapshots.set(root, {
					text: nodePorts.fs.read(config.projectConfigFile),
					exists: config.projectConfigExists,
				});
				// Knowledge state never makes doctor fail: an unreadable snapshot is
				// one more line in the report, not a reason to withhold the config.
				const knowledge = await resolveKnowledge(root).catch(() => null);
				return { ok: true, value: doctor({ config, knowledge: knowledge?.status ?? null }) };
			} catch (error) {
				return kernelFailure(error);
			}
		},
		async knowledge(request, projectRoot, project) {
			try {
				// The probe list lives in the embedded sources, so a knowledge base
				// that failed to resolve must not take it down with it.
				if (request.action === "probes") {
					return {
						ok: true,
						value: { action: "probes", ...knowledgeProbes(probeCatalog(), request.query ?? "") },
					};
				}
				const { base, status } = await resolveKnowledge(projectRoot);
				const reflect = project === undefined ? UNAVAILABLE_REFLECTION : nodeReflectionPort(project.ctx);
				// The flow context exists only with an open project: `plugin` reads
				// project sources to recognise the family. It no longer writes a brief
				// stamp. Without a project, runKnowledge refuses that action and
				// answers every other one as usual.
				const docs = await reference.localDocs();
				const flow =
					project === undefined
						? undefined
						: {
								source: project.ctx.ports.fs,
								referenceDoc: (name: string) => docs.find((doc) => doc.name === name)?.file ?? null,
							};
				// 本环境实测出来的行为只在本地参考文档里：search 和官方库排在同一个段落索引里，
				// api 给每个类附上本地文档里讲到它的块
				return await runKnowledge(base, status, request, nodeKnowledgeDocs, reflect, flow, probeCatalog(), docs);
			} catch (error) {
				return kernelFailure(error);
			}
		},
	};
}

const TAIL_BYTES = 32 * 1024;

/** 文件最后 `lines` 行：只读末尾 32 KB，异步读，不卡界面。 */
/** 整份读；超过 `limit` 字节只读头和尾各一半。文件不在给 null。 */
async function readEnds(file: string, limit: number): Promise<string | null> {
	let handle: Awaited<ReturnType<typeof openFile>> | undefined;
	try {
		handle = await openFile(file, "r");
		const size = (await handle.stat()).size;
		const half = Math.floor(limit / 2);
		const spans =
			size <= limit
				? [[0, size]]
				: [
						[0, half],
						[size - half, half],
					];
		const parts: string[] = [];
		for (const [start, length] of spans as [number, number][]) {
			const buffer = Buffer.alloc(length);
			await handle.read(buffer, 0, length, start);
			parts.push(buffer.toString("utf8"));
		}
		return parts.join("\n");
	} catch {
		return null;
	} finally {
		await handle?.close();
	}
}

async function readTail(file: string, lines: number): Promise<string[]> {
	let handle: Awaited<ReturnType<typeof openFile>> | undefined;
	try {
		handle = await openFile(file, "r");
		const size = (await handle.stat()).size;
		const start = Math.max(0, size - TAIL_BYTES);
		const buffer = Buffer.alloc(size - start);
		await handle.read(buffer, 0, buffer.length, start);
		const all = buffer.toString("utf8").split(/\r?\n/);
		if (start > 0) all.shift();
		while (all.length > 0 && all.at(-1) === "") all.pop();
		return all.slice(-lines);
	} catch {
		return [];
	} finally {
		await handle?.close();
	}
}
