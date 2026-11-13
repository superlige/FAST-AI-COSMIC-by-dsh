/**
 * fast -- compile the changed business classes (S3.1).
 *
 * The order of the steps is the design, not an implementation detail:
 *
 *   1. deterministic Capsule/risk gate, BEFORE any Gradle work. It checks that
 *      each recognised plugin family has a generated target Capsule; it never
 *      asks the model to perform a documentation check-in. On a sweep it judges
 *      only the sources this session touched -- see `FastHooks.authoredSince`.
 *   2. ensureBuilt, so the argfile exists.
 *   3. pre-flight lint, unless the files are stamped clean. Same javac chain,
 *      but lint reports in 5 seconds what the real compile takes 40 to report,
 *      and with better diagnostics. The frozen skill only wrote "lint first" in
 *      prose and it was skipped every time, so it moved into the code.
 *   4. per-module javac. -d and -sourcepath are single-valued, so mixing modules
 *      writes classes into the wrong output tree.
 *   5. mark the resident JVM if one is up: it holds the old classes in memory,
 *      and using it after a compile means the next probe runs the old code --
 *      with no error of any kind. The restart itself is the next probe's, not
 *      this command's: a session that compiles four times before running
 *      anything paid four cold starts for three JVMs no probe ever spoke to.
 *      Marking keeps the rule (no probe touches a marked JVM) and charges it
 *      once. See `markServerStale`.
 *
 * Step 1 is an injected hook. Its judge lives in
 * src/knowledge/plugin-gate.ts and the caller hands the SAME closure to `lint`,
 * so the advisory half and the blocking half cannot disagree.
 *
 * The gate refuses with KNOWLEDGE_GATE_UNSATISFIED, not COMPILE_FAILED: nothing
 * was compiled, and the audit groups by code.
 */

import { relative } from "node:path";
import type { KnowledgeAdvice, KnowledgeAdvisor } from "../../knowledge/plugin-gate.ts";
import type { KernelContext } from "../context.ts";
import { type Finding, findingLine } from "../diag/javac.ts";
import { err, KernelError, type KernelErrorCode, type KernelErrorDetail, type KernelResult, ok } from "../errors.ts";
import { captureFreshnessAsync, type FreshnessSnapshot } from "../freshness.ts";
import { withProjectWriteLock } from "../policy/project-write-lock.ts";
import {
	emptyPrepare,
	type PrepareBlocker,
	type PrepareDeferred,
	type PrepareResult,
	prepareKernelError,
} from "../prepare/model.ts";
import { forgetRepeats } from "../probe/repeat.ts";
import { isOwnLiveServer, markServerStale, ping, readManifest, residentPort } from "../probe/server.ts";
import { artifactState, ensureBuilt, runJavac } from "../toolchain.ts";
import { lint } from "./lint.ts";
import {
	groupByModule,
	type ModuleGroup,
	resolveSource,
	staleSources,
	staleSourcesAsync,
	stampClean,
	stampedClean,
} from "./sources.ts";

export interface FastHooks {
	/**
	 * Runs before any Gradle work (S7.4/S15.2). Returns target Capsule audit facts
	 * and the verdict; the caller hands the SAME closure to `lint`, which makes
	 * "lint said it would block and fast did not" unrepresentable.
	 *
	 * Absent means no knowledge source could be resolved at all. Embedded
	 * knowledge makes that an install-health degradation, reported in notes;
	 * it is not converted into a model documentation task.
	 */
	knowledgeGate?: KnowledgeAdvisor;
	/**
	 * When this session began, in epoch ms. Narrows what the knowledge gate above
	 * judges on a SWEEP -- a `fast` with no file names, which compiles whatever is
	 * stale in the whole project.
	 *
	 * The gate's question is "was this plugin family's root flow walked before its
	 * code was written". On a sweep the file list answers a different one: it is
	 * every stale source in the project, including code somebody left half-compiled
	 * days ago in a module nobody has opened. A real session changed one print
	 * plugin and, to get a fresh classpath, was made to walk the six-step flow for
	 * a tree-list plugin and a BOTP convert plugin it had never read a line of --
	 * roughly thirty minutes of paying down another session's debt to verify three
	 * lines of its own.
	 *
	 * Authorship is judged by mtime rather than by remembering which files this
	 * agent wrote, and that is deliberate: mtime is filesystem truth, so it also
	 * covers a source written with a shell heredoc or edited in the IDE, while a
	 * list of "files I wrote" only covers the tools that thought to report. A file
	 * touched since the session started is this session's to answer for; one that
	 * has been sitting stale since before it started is inherited, gets compiled,
	 * and is reported as inherited rather than silently ignored.
	 *
	 * Named files are never narrowed. `fast sources=X` is a statement about X.
	 */
	authoredSince?: number;
	/**
	 * 本次会话用编辑工具写过的源码（绝对路径）。给了它，「本次会话改的」就只认它，
	 * 再加上这次点了名、修改时间在会话开始之后的（用 bash 写、点名编译的那种）。
	 *
	 * 只按修改时间判会说假话（S37 2-D.1）：用户同时在 IDE 里改的文件也在会话开始之后，
	 * 被算成本次改的，进了交付清单、要模型给它们跑验证，知识门禁也按本次改动去审。
	 * 历史会话里这样判错 55 个文件次（`scripts/measure-fast-scope.ts`）。
	 * 不给（内核自己的调用、测试）时照旧按修改时间判。
	 */
	writtenFiles?: readonly string[];
	/**
	 * Runs after a successful compile; says which form each compiled plugin is
	 * REGISTERED on (S5 impact index). The answer exists in a local index, and the moment it is
	 * worth knowing is the moment you would not think to ask -- see `boundForms`.
	 */
	boundForms?: (ctx: KernelContext, files: readonly string[]) => string[];
	/**
	 * 交互界面用的进度回调；从不影响编译结果，也从不进报告。
	 *
	 * 存在的理由是「等待」和「卡死」在屏幕上长得一模一样。fast 的三段——Gradle 备料、
	 * 前置体检、逐模块编译——加起来可以是几分钟，而在此之前工具只在开头和结尾各说一句话，
	 * 中间那几分钟界面上什么都不变。人分不出这是在编译还是 agent 挂了，于是去杀进程。
	 * 报出段名和模块序号，等待就有了刻度。
	 */
	onProgress?: (progress: FastProgress) => void;
	/**
	 * 写法兜底（S51）：本次会话改过的文件里新加的、该拦没豁免的写法问题，一个文件一组。
	 * 只查本次会话写的（不是继承来的陈旧文件）；空数组放行。
	 */
	styleGate?: (files: readonly string[]) => { file: string; lines: string[] }[];
}

/** 一段 fast 正在做的事。交互界面用，不参与任何策略判断。 */
export type FastProgress =
	| { stage: "building-artifacts" }
	| { stage: "preflight"; files: number }
	| { stage: "compiling"; module: string; index: number; total: number; files: number };

export interface CompiledModule {
	module: string;
	fileCount: number;
	outDir: string;
	seconds: string;
}

export interface FastReport {
	/** Files that were compiled, relative to the project root. */
	files: string[];
	/**
	 * Compiled files whose source mtime belongs to this agent session.
	 *
	 * This is deliberately separate from `files`: a sweep may compile inherited
	 * stale sources to restore whole-project freshness, but those files are not
	 * work this session changed and must not inflate the TUI's work count or the
	 * delivery trace.
	 */
	authoredFiles: string[];
	/**
	 * Stale sources this sweep compiled that predate the session, so the knowledge
	 * gate did not judge them (see `FastHooks.authoredSince`). Reported rather than
	 * dropped: "compiled but not gated" is a fact about how much this run checked,
	 * and a report that hid it would be claiming more coverage than it had.
	 */
	inheritedStale: string[];
	/** True when nothing was stale and nothing was named. */
	nothingToDo: boolean;
	preflight: { ran: boolean; skippedBecauseStamped: boolean; seconds: string };
	compiled: CompiledModule[];
	/**
	 * What happened to the resident JVM.
	 *
	 * `restart-deferred` is the ordinary outcome after a successful compile: the
	 * JVM on the port is serving the classes as they were, so it is marked and the
	 * next probe brings it up to date before it uses it -- since S27 3.1 by swapping
	 * the changed classes in place, and by a restart only when they cannot be swapped
	 * (a structural change). Nothing runs against the old classes either way. The
	 * name is kept because the report field is read by the agent layer.
	 * `restarted` remains for the paths that must not defer (see `markServerStale`).
	 */
	residentJvm: "restart-deferred" | "restarted" | "restart-failed" | "not-running";
	/** Empty unless a hook was left at its default. */
	notes: string[];
	/**
	 * The L1 hints and the L3 verdict for the compiled files (S7.4). Null when no
	 * knowledge source was available -- distinguishable from "nothing recognised",
	 * which is an advice object with an empty hint list.
	 */
	knowledge: KnowledgeAdvice | null;
	/** Which forms the compiled plugins are registered on. Empty when the index has nothing to say. */
	boundForms: string[];
	/** Captured before the project write lock is released. */
	freshness: FreshnessSnapshot;
}

export interface FastFailure {
	stage: "gate" | "preflight" | "compile";
	findings: Finding[];
	raw: string;
}

/** Attached to the KernelError so callers can render diagnostics without re-parsing text. */
export interface FastErrorDetail {
	stage: string;
	fileCount: number;
}

/** Everything the compile needs once nothing blocks. Computed without Gradle or javac. */
export interface FastPlan {
	/** Absolute paths, in compile order. */
	files: string[];
	/** The subset whose mtime belongs to this session. */
	authoredFiles: string[];
	/** Stale sources a sweep picked up that predate the session. */
	inheritedStale: string[];
	/** True when no names were given and the file list came from staleness. */
	swept: boolean;
	/** Nothing was named and nothing was stale: a legitimate no-op, not a refusal. */
	nothingToDo: boolean;
	groups: ModuleGroup[];
	knowledge: KnowledgeAdvice | null;
	notes: string[];
}

export type FastPreparation = PrepareResult<FastPlan>;

/**
 * The one structured `nextCall` fast can honestly write.
 *
 * `SOURCE_NOT_FOUND` carries the candidates the kernel found by class name, so
 * when every unresolved name has exactly one candidate the corrected call is
 * derived, not guessed. Two candidates is a choice that belongs to the caller
 * (S15 §4.4), and it returns null rather than picking.
 */
function resolvedRetry(
	names: readonly string[],
	fixes: ReadonlyMap<string, string>,
	blockers: readonly PrepareBlocker[],
): { sources: string[] } | null {
	// Only when EVERY blocker is a name this map can correct. A knowledge-gate
	// refusal standing beside a typo means the corrected call would still be
	// refused, and handing it over as `nextCall` invites exactly the round trip
	// this field exists to save.
	if (fixes.size === 0 || blockers.length !== fixes.size) return null;
	return { sources: names.map((name) => fixes.get(name) ?? name) };
}

/**
 * Every cheap check fast can answer, in one pass, before any process starts.
 *
 * The pre-S15 order ran the knowledge gate, then `ensureBuilt` (Gradle), and
 * only THEN grouped the files by module -- so a path outside every code module
 * was reported after a Gradle preparation that existed solely to compile it, and
 * a caller with both an unresolvable name and a blocked plugin family learned
 * about them one round trip apart. Name resolution, the Capsule/risk gate and
 * module grouping share no inputs, so all three run here and all three report.
 */
/** 同一个文件的两种写法（斜杠方向、盘符大小写）比成同一个。 */
const samePath = (file: string): string => file.replace(/\\/g, "/").toLowerCase();

/**
 * 「这个陈旧文件是不是本次会话写的」。见 `FastHooks.writtenFiles`。
 *
 * 修改时间读不到的，算本次会话的：那样门禁会审它，多花一次查询，不会答错。
 */
function sessionAuthorship(ctx: KernelContext, hooks: FastHooks, named: boolean): (file: string) => boolean {
	const since = hooks.authoredSince;
	if (since === undefined) return () => true;
	const recent = (file: string): boolean => {
		const ms = ctx.ports.fs.mtimeMs(file);
		return ms === null || ms >= since;
	};
	if (hooks.writtenFiles === undefined) return recent;
	const written = new Set(hooks.writtenFiles.map(samePath));
	return (file) => written.has(samePath(file)) || (named && recent(file));
}

export function prepareFast(ctx: KernelContext, names: readonly string[], hooks: FastHooks = {}): FastPreparation {
	const blockers: PrepareBlocker[] = [];
	const notes: string[] = [];
	const files: string[] = [];
	const fixes = new Map<string, string>();
	const swept = names.length === 0;
	if (swept) {
		files.push(...staleSources(ctx));
	} else {
		// Every name, not the first failure: `resolveSources` returned on the first
		// one, which turned three typos into three round trips.
		for (const name of names) {
			const resolved = resolveSource(ctx, name);
			if (resolved.ok) {
				files.push(resolved.value);
				continue;
			}
			const candidates = resolved.error.detail.candidates;
			if (Array.isArray(candidates) && candidates.length === 1) fixes.set(name, String(candidates[0]));
			blockers.push({
				code: resolved.error.code,
				message: resolved.error.message,
				remedy: resolved.error.remedy,
				dependsOn: ["project.sources"],
				detail: resolved.error.detail,
			});
		}
	}

	if (swept && files.length === 0) {
		return emptyPrepare<FastPlan>({
			plan: {
				files: [],
				authoredFiles: [],
				inheritedStale: [],
				swept: true,
				nothingToDo: true,
				groups: [],
				knowledge: null,
				notes,
			},
		});
	}

	const mine = sessionAuthorship(ctx, hooks, !swept);
	const inherited = swept && hooks.authoredSince !== undefined ? files.filter((file) => !mine(file)) : [];
	const inheritedSet = new Set(inherited);
	const authoredFiles = hooks.authoredSince === undefined ? files : files.filter(mine);
	if (inherited.length > 0) {
		notes.push(`${String(inherited.length)} 个陈旧源文件不是本次会话写的，照编但不过知识门禁`);
	}

	// (1) The Capsule/risk gate, before any Gradle work.
	const deferred: PrepareDeferred[] = [];
	let knowledge: KnowledgeAdvice | null = null;
	if (hooks.knowledgeGate) {
		knowledge = hooks.knowledgeGate(files.filter((file) => !inheritedSet.has(file)));
		if (!knowledge.gate.allowed) {
			blockers.push({
				code: "KNOWLEDGE_GATE_UNSATISFIED",
				message: "插件 Capsule 无法确定性生成，没有进编译",
				remedy: knowledge.gate.blocked.map((family) => family.remedy).join("；"),
				dependsOn: ["knowledge-base", "project.sources"],
				detail: {
					reason: knowledge.gate.reason,
					blockedBases: knowledge.gate.blocked.map((family) => family.base),
					files: knowledge.gate.blocked.map((family) => family.file),
					lines: knowledge.gate.lines,
				},
			});
		}
	} else {
		notes.push("插件知识卡片（Capsule）来源不可用，本次没有附卡片，编译照常；建议用 cosmic_doctor 检查知识包");
		deferred.push({
			check: "插件族 Capsule 与危险边界判定",
			dependsOn: ["knowledge-base"],
			reason: "没有可解析的知识源，本次编译没有经过插件门禁。",
		});
	}

	// (1b) 写法兜底：和知识门禁一样在任何 Gradle 之前，问题和改法都在源码里。
	const styled = hooks.styleGate?.(authoredFiles.filter((file) => !inheritedSet.has(file))) ?? [];
	if (styled.length > 0) {
		blockers.push({
			code: "STYLE_GATE_UNSATISFIED",
			message: `本次改的代码里有 ${String(styled.reduce((sum, row) => sum + row.lines.length, 0))} 处写法问题要改，没有进编译`,
			remedy: "按每一处后面写的改法改；确实合不了批的，在那一行上面写 `// cosmic-allow: 理由`，理由会列进交付",
			dependsOn: ["project.sources"],
			detail: {
				files: styled.map((row) => relative(ctx.projectRoot, row.file).replace(/\\/g, "/")),
				lines: styled.flatMap((row) =>
					row.lines.map((line) => `${relative(ctx.projectRoot, row.file).replace(/\\/g, "/")} ${line}`),
				),
			},
		});
	}

	// (2) Module grouping, moved ahead of ensureBuilt: an orphan file must fail
	// before the Gradle preparation that only existed to compile it.
	const grouped = groupByModule(ctx, files);
	if (!grouped.ok) {
		blockers.push({
			code: grouped.error.code,
			message: grouped.error.message,
			remedy: grouped.error.remedy,
			dependsOn: ["project.layout"],
			detail: grouped.error.detail,
		});
	}
	const groups = grouped.ok ? grouped.value : [];

	// javac only: `fast` marks the resident JVM rather than starting one, so its
	// cold-start count is zero by construction. Gradle counts when the argfile and
	// pathing jar are missing or no longer list every module, which is exactly what `ensureBuilt` asks.
	const gradle = artifactState(ctx).state === "ok" ? 0 : 1;
	const preflightJavac = stampedClean(ctx, files) ? 0 : 1;
	return emptyPrepare<FastPlan>({
		plan:
			blockers.length > 0
				? null
				: {
						files,
						authoredFiles,
						inheritedStale: inherited,
						swept,
						nothingToDo: false,
						groups,
						knowledge,
						notes,
					},
		blockers,
		deferred,
		retryInput: resolvedRetry(names, fixes, blockers),
		estimatedCost:
			blockers.length > 0
				? { processes: 0, coldStarts: 0 }
				: { processes: gradle + preflightJavac + groups.length, coldStarts: 0 },
	});
}

/**
 * The pre-flight check and the per-module compile for one file list.
 *
 * Split out so the named files and the inherited stale sources compiled after
 * them (see `inheritedFollowUp`) go through exactly the same two steps: same
 * lint, same stamp, same javac flags. A second, lighter path for "someone else's
 * files" would be the place a difference in what counts as compiled creeps in.
 */
async function compileFiles(
	ctx: KernelContext,
	files: readonly string[],
	groups: readonly ModuleGroup[],
	hooks: FastHooks,
): Promise<KernelResult<{ preflight: FastReport["preflight"]; compiled: CompiledModule[] }>> {
	// (3)
	let preflight = { ran: false, skippedBecauseStamped: false, seconds: "0.0" };
	if (stampedClean(ctx, files)) {
		preflight = { ran: false, skippedBecauseStamped: true, seconds: "0.0" };
	} else {
		hooks.onProgress?.({ stage: "preflight", files: files.length });
		const report = await lint(ctx, files);
		if (!report.ok) return err(report.error);
		preflight = { ran: true, skippedBecauseStamped: false, seconds: report.value.seconds };
		if (report.value.findings.length > 0) {
			return err(
				new KernelError("COMPILE_FAILED", `前置体检没过（${report.value.findings.length} 处），没有进正式编译`, {
					detail: {
						stage: "preflight",
						fileCount: files.length,
						seconds: report.value.seconds,
						findings: report.value.findings.map((f) => findingLine(f, ctx.projectRoot)),
					},
					remedy: "改完再跑 fast；只想看体检结果用 lint。",
				}),
			);
		}
		if (report.value.status !== 0) {
			return err(
				new KernelError("COMPILE_FAILED", "前置体检 javac 失败但没有可解析的诊断", {
					detail: { stage: "preflight", raw: report.value.raw.trim().slice(0, 4000) },
					remedy: "看 javac 原文；多半是 argfile 或编码问题，不是代码问题。",
				}),
			);
		}
		stampClean(ctx, files);
	}

	// (4b)
	const compiled: CompiledModule[] = [];
	for (const [index, group] of groups.entries()) {
		hooks.onProgress?.({
			stage: "compiling",
			module: group.module.name,
			index: index + 1,
			total: groups.length,
			files: group.files.length,
		});
		// -sourcepath lets javac resolve same-project references; without
		// -implicit:none it also recompiles whatever they drag in, which is exactly
		// what is wanted here (a changed signature recompiles its dependents).
		// -Xdiags:verbose costs nothing and turns "incompatible types" into a list
		// of candidate overloads.
		const run = await runJavac(ctx, [
			"-encoding",
			"UTF-8",
			`@${ctx.layout.javacArgs}`,
			"-nowarn",
			"-Xdiags:verbose",
			"-sourcepath",
			group.module.src,
			"-d",
			group.module.out,
			...group.files,
		]);
		if (run.status !== 0) {
			return err(
				new KernelError("COMPILE_FAILED", `${group.module.name} 业务类编译失败`, {
					detail: {
						stage: "compile",
						module: group.module.name,
						fileCount: group.files.length,
						// The pre-flight uses -implicit:none and only sees the named files, so
						// reaching here usually means a changed signature broke OTHER files.
						hint: "前置体检看不见的那类：多半是改了签名，连带别的文件编不过",
						raw: run.out.trim().slice(0, 8000),
					},
					remedy: "按 javac 原文改；连带失败的文件不在你点名的清单里。",
				}),
			);
		}
		compiled.push({
			module: group.module.name,
			fileCount: group.files.length,
			outDir: relative(ctx.projectRoot, group.module.out),
			seconds: run.seconds,
		});
	}
	return ok({ preflight, compiled });
}

interface InheritedFollowUp {
	/** Absolute paths compiled after the named files. Empty when nothing ran or it failed. */
	files: string[];
	compiled: CompiledModule[];
	notes: string[];
	/** The follow-up ran and did not compile: its note already says what is left stale. */
	failed: boolean;
}

/**
 * After a named compile: compile the stale sources left over from before this
 * session, in the same call (S24 D1).
 *
 * The requirement itself stays whole. Evidence binds a fingerprint of EVERY
 * class in the project (`captureFreshness`), and the reason it has to is that a
 * run does not only load the class that was edited: `run op` / `run print --set`
 * fire every operation plugin registered on the bill, and `-sourcepath` pulls in
 * whatever the plugin references. In the 2026-09-17 session the print plugin's
 * bill also carried `EntrustStatusChangeOpPlugin`, one of the five inherited
 * stale sources -- a `--set` there saves the bill and runs it. "Only require the
 * files the run depends on" cannot be decided from the source without guessing,
 * so it is not attempted.
 *
 * What is removed is the round trip. That session named its one plugin, got
 * "the project is still stale, run fast again without sources", and did exactly
 * that 16 seconds later. The second call judged nothing the first could not
 * have: inherited files skip the knowledge gate on a sweep too. So when every
 * remaining stale source predates the session, they are compiled here, through
 * the same pre-flight and javac as the named ones.
 *
 * Not done when any remaining stale source is this session's (see
 * `sessionAuthorship`): that one is this session's work and belongs in front of
 * the knowledge gate, which a follow-up does not run. The note below
 * `forgetRepeats` names it instead. A file the user edited in the IDE while the
 * session ran is not the session's, and is compiled here like any other.
 *
 * A failure here does not fail the named compile. Those classes are written and
 * correct; what is missing is freshness, and the note says whose files are in
 * the way.
 */
async function inheritedFollowUp(ctx: KernelContext, plan: FastPlan, hooks: FastHooks): Promise<InheritedFollowUp> {
	const none: InheritedFollowUp = { files: [], compiled: [], notes: [], failed: false };
	if (plan.swept || hooks.authoredSince === undefined) return none;
	const stale = await staleSourcesAsync(ctx);
	if (stale.length === 0) return none;
	if (stale.some(sessionAuthorship(ctx, hooks, false))) return none;
	const grouped = groupByModule(ctx, stale);
	if (!grouped.ok) return none;

	const shown = stale
		.slice(0, 5)
		.map((file) => relative(ctx.projectRoot, file).replace(/\\/g, "/"))
		.join("、");
	const named = `${shown}${stale.length > 5 ? ` 等 ${String(stale.length)} 个` : ""}`;
	const run = await compileFiles(ctx, stale, grouped.value, hooks);
	if (!run.ok) {
		const findings = run.error.detail.findings;
		const first = Array.isArray(findings) ? findings.slice(0, 3).map(String).join("；") : "";
		return {
			...none,
			failed: true,
			notes: [
				`点名的文件已编好；顺带补编不是本次会话写的陈旧源码（${named}）没过：${run.error.message}` +
					(first === "" ? "" : `（${first}）`) +
					"。这些不是本次会话改的；工程不新鲜，新鲜度证据建立不了。先跟用户说清是谁的文件编不过，再定怎么办。",
			],
		};
	}
	return {
		files: stale,
		compiled: run.value.compiled,
		notes: [
			`顺带补编了 ${String(stale.length)} 个不是本次会话写的陈旧源码（${named}），照编但不过知识门禁；` +
				"工程已整体新鲜，不用再跑一次 cosmic_fast。",
		],
		failed: false,
	};
}

async function runFast(
	ctx: KernelContext,
	names: readonly string[],
	hooks: FastHooks = {},
): Promise<KernelResult<FastReport>> {
	// Name resolution, the Capsule/risk gate and module grouping all happen here,
	// together, and none of them starts a process (S15.5.2).
	const prepared = prepareFast(ctx, names, hooks);
	if (prepared.blockers.length > 0 || prepared.plan === null) {
		const only = prepared.blockers.length === 1 ? prepared.blockers[0] : undefined;
		// A single blocker keeps its own code: `KNOWLEDGE_GATE_UNSATISFIED` and
		// `SOURCE_NOT_FOUND` are what the audit groups by and what the reference
		// pages name. The aggregate code appears only when there is genuinely more
		// than one thing to say, which is the case that used to cost a round trip.
		return err(
			only === undefined
				? prepareKernelError("FAST_PRECHECK_FAILED", "fast 在 Gradle/javac 前发现阻碍", prepared, {
						stage: "gate",
					})
				: new KernelError(only.code as KernelErrorCode, only.message, {
						detail: { ...(only.detail as KernelErrorDetail), stage: "gate" },
						remedy: only.remedy,
					}),
		);
	}
	const plan = prepared.plan;
	const notes = [...plan.notes];
	const files = plan.files;
	const knowledge = plan.knowledge;
	if (plan.nothingToDo) {
		return ok({
			files: [],
			authoredFiles: [],
			inheritedStale: [],
			nothingToDo: true,
			preflight: { ran: false, skippedBecauseStamped: false, seconds: "0.0" },
			compiled: [],
			residentJvm: "not-running",
			notes,
			knowledge: null,
			boundForms: [],
			freshness: await captureFreshnessAsync(ctx),
		});
	}

	// (2)
	if (artifactState(ctx).state !== "ok") {
		// 只有真要跑 Gradle 时才报这一段：产物齐全时 ensureBuilt 只读一下 argfile，
		// 报一个瞬间就过去的段名，只会让进度行闪一下。
		hooks.onProgress?.({ stage: "building-artifacts" });
	}
	const built = await ensureBuilt(ctx);
	if (!built.ok) return err(built.error);

	// (3) + (4b)
	const main = await compileFiles(ctx, files, plan.groups, hooks);
	if (!main.ok) return err(main.error);
	const { preflight } = main.value;
	const compiled = [...main.value.compiled];

	// (4c)
	const followUp = await inheritedFollowUp(ctx, plan, hooks);
	notes.push(...followUp.notes);
	compiled.push(...followUp.compiled);
	const compiledFiles = [...files, ...followUp.files];
	const inheritedStale = [...plan.inheritedStale, ...followUp.files];

	// (5)
	let residentJvm: FastReport["residentJvm"] = "not-running";
	if ((await ping(ctx)).ok) {
		const manifest = readManifest(ctx);
		if (manifest !== null && !isOwnLiveServer(ctx, manifest)) {
			// Someone else's JVM is on this port. Not ours to restart, and not ours to kill.
			notes.push(`端口 ${residentPort(ctx)} 上的常驻 JVM 属于别的 RuntimeKey（${manifest.keyId}），未动它`);
		} else {
			// Marked, not restarted. The next probe pays one restart no matter how many
			// compiles got us here, and it will not talk to this JVM before paying it.
			markServerStale(ctx, `fast 编译了 ${compiledFiles.length} 个文件`, "classes");
			residentJvm = "restart-deferred";
			notes.push(hotSwapNote(manifest?.hotSwap === "jrebel"));
		}
	}

	const boundForms = hooks.boundForms ? hooks.boundForms(ctx, files) : [];

	// 编译成功但工程仍不新鲜：这次点名的文件编了，别人的陈旧源码还在。
	//
	// 这条 note 存在的原因是一次真实会话在这里空转了一整轮：带 sources 的 fast 成功
	// 返回、退出码 0、诊断为空，而阶段一动不动 —— 推进到 verify 的条件是**整个工程**
	// 新鲜（`freshness.fresh`），不是「我改的那两个类编过了」。当时的结果里没有一个字
	// 说得出这一点，模型的下一步是去撞在 build 还没挂出的 cosmic_run，从 `not found`
	// 里反推自己的处境。
	//
	// 说的是新鲜度这件事本身，不是阶段机器的规则（那是 agent 层的事，内核不该知道）：
	// 「还差谁、跑什么把它们编掉」正好也是新鲜度的话，两边不会漂。
	// 编过了，业务类就跟上一次问出来的答案不是同一批了：把「这个问题问过了」的账清空。
	// 不清的话，改完代码重跑同一条命令会被当成「又问一遍」挡下来——那正好是最该跑的一次。
	forgetRepeats(ctx);

	const freshness = await captureFreshnessAsync(ctx);
	// 顺带补编没过时，那条 note 已经说了卡在哪；再说「不带 sources 再跑一次」只会让人把同一个错再撞一遍。
	if (!freshness.fresh && !followUp.failed) {
		const shown = freshness.staleFiles.slice(0, 5).join("、");
		const rest = freshness.staleFiles.length > 5 ? ` 等 ${String(freshness.staleFiles.length)} 个` : "";
		notes.push(
			`本次编译成功，但工程还不新鲜：${shown}${rest} 的 class 仍旧于源码，` +
				"新鲜度证据建立不了（要验证，整个工程都得新鲜，只编过本次点名的文件不够）。" +
				"不带 sources 再跑一次 cosmic_fast 会把这些陈旧源码全部编掉。",
		);
	}

	return ok({
		files: compiledFiles.map((file) => relative(ctx.projectRoot, file)),
		authoredFiles: plan.authoredFiles.map((file) => relative(ctx.projectRoot, file)),
		inheritedStale: inheritedStale.map((file) => relative(ctx.projectRoot, file)),
		nothingToDo: false,
		preflight,
		compiled,
		residentJvm,
		notes,
		knowledge,
		boundForms,
		freshness,
	});
}

/** Class output and resident-JVM restart are serialized across agent windows. */
export function fast(
	ctx: KernelContext,
	names: readonly string[],
	hooks: FastHooks = {},
): Promise<KernelResult<FastReport>> {
	return withProjectWriteLock(ctx, "fast", () => runFast(ctx, names, hooks));
}

/**
 * 编译完「下次运行要等多久」那句话。按常驻 JVM 实际挂的换类方式说，不按配置猜：
 * JRebel 只能在 JVM 启动时挂上，改了配置、常驻还没重起的那一段，照旧是 JDK 自带的换法。
 *
 * 重起的数是真机量的（S33，2026-09-21）：以前写「约 30 秒」，一次加了常量的打印需求实际是
 * 重起约 60 秒、新进程第一次出打印又 55 秒，模型照「30 秒」排计划，先跑一次看、再跑一次断言，
 * 两次都付在了这段上。
 */
export function hotSwapNote(jrebel: boolean): string {
	const restart =
		"那次自动重起常驻 JVM：重起约 60 秒，之后第一次运行还要重新加载单据和插件（打印第一次出图约 50 秒），" +
		"所以这一次直接带 --expect，看结果和断言一次跑完";
	return jrebel
		? "常驻 JVM 里的类旧了，挂着 JRebel：改方法体、加方法、加字段下次用到时原地换进去，约 1 秒；" +
				`改父类、改接口这类 JRebel 也换不了的，${restart}`
		: "常驻 JVM 里的类旧了，下次用它之前先把变了的类热替换进去（改方法体、加 private static 方法约 1 秒）；" +
				`加字段（包括常量）、加非 private 方法、改签名换不进去，${restart}`;
}
