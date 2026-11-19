/**
 * probe -- run one probe against the real Cosmic runtime (S3.1).
 *
 * Cold and hot are two paths to the same semantics. A cold probe pays ~30-40s
 * of initialisation of which 97% is re-paid every time (javac 5.8s, Cosmic 7.9s,
 * metadata subsystem 16-23s), so hot is the default. But **writes always go
 * cold**: nobody can guarantee that every cache level in a resident JVM is
 * flushed after a write, and losing that bet means treating stale state as
 * verified. That rule is hard-coded here rather than left to judgement.
 *
 * Three things changed from the frozen driver, all required by D9/D1:
 *   - probe arguments become an env overlay value instead of a process.env
 *     mutation. The frozen bindProbeArgs wrote into process.env, where the
 *     assignment outlived the command and leaked into the next one.
 *   - the JVM receives only the composed overlay, not the agent's whole
 *     environment (see probe/protocol.ts).
 *   - APPLY=1 is refused unless the shared-write admission check passes. The S6
 *     agent path uses an interactive, RuntimeKey-bound authorization, and since
 *     S14.3.1 that is the only admission source -- the frozen CLI's DRAFT.md
 *     fallback went with the ledger. See policy/shared-write.ts.
 *     S27 (user decision 2026-09-19, the environment is a disposable test one):
 *     this applies to metadata writers only; DataSeedProbe / DataUpdateProbe
 *     APPLY without a grant and run on the resident JVM.
 */

import { basename, isAbsolute, relative, resolve } from "node:path";
import type { ProbeApiPreflight } from "../../knowledge/probe-api-preflight.ts";
import { sha256 } from "../../runtime/fingerprint.ts";
import { baseChildEnv, childEnv, jvmProps, KEEP_EXCEPTION_STACKS, type KernelContext, poolProps } from "../context.ts";
import { err, KernelError, type KernelResult, ok } from "../errors.ts";
import { markMetaPending } from "../impact/meta-state.ts";
import { entryAsEntityBlockers, loadFieldRows } from "../meta/entity-role.ts";
import { probeImports } from "../policy/api-precheck.ts";
import { adHocLane, type FreshnessLane, releasedLane } from "../policy/probe-freshness.ts";
import { blankJavaNoise, scanAdHocProbe } from "../policy/probe-scan.ts";
import { withProjectWriteLock } from "../policy/project-write-lock.ts";
import { admitSharedWrite, targetProps } from "../policy/shared-write.ts";
import { dataWriteOverlay, isBlockedWrite, isDataWriter } from "../policy/write-plan.ts";
import { targetsSummary } from "../policy/write-targets.ts";
import {
	emptyPrepare,
	FREE,
	type PrepareBlocker,
	type PrepareDeferred,
	type PrepareResult,
	prepareKernelError,
} from "../prepare/model.ts";
import { probeEnvNames } from "../probe/env-names.ts";
import { recordNoise } from "../probe/noise.ts";
import { filterProbeOutput, type ProbeJsonRecord, summarizeRuntimeExceptions } from "../probe/output.ts";
import { type OwnClassLocator, ownClassNote } from "../probe/own-classes.ts";
import type { ProbeResponse } from "../probe/protocol.ts";
import { forgetRepeats, type RepeatEntry, type RepeatKey, recordRepeat, repeatBlocked } from "../probe/repeat.ts";
import {
	describeSync,
	isNotRunning,
	isOwnLiveServer,
	markServerStale,
	ownsAnswering,
	type ProbeServerProgress,
	ping,
	readManifest,
	recoverTimedOutServer,
	residentPort,
	sendProbe,
	staleServerIdentity,
	startServer,
	stopServer,
	syncClasses,
	takeServerStale,
} from "../probe/server.ts";
import { stashProbeOutput } from "../probe/stash.ts";
import { classpathOf, ensureBuilt, refreshLaunchClasses, runJava, runJavac } from "../toolchain.ts";
import { type FastHooks, fast } from "./fast.ts";
import { moduleOf, stalePackages, staleSources, staleSourcesAsync } from "./sources.ts";

export type StaleMode = "block" | "fast" | "warn";

/**
 * What the stale-class gate decided, and on what basis.
 *
 * `lane` is carried out with the verdict rather than left inside the gate: a run
 * that went ahead with stale classes in the project has to be able to say why it
 * was allowed to, and "this probe does not load business classes" is a different
 * answer from "the caller lowered COSMIC_STALE" -- the second belongs in a case
 * draft's warning, the first does not.
 */
export interface StaleVerdict {
	files: number;
	lane: FreshnessLane;
	mode: StaleMode;
	action: "none" | "compiled" | "warned";
}
/**
 * 一次 probe 正在做的事。只喂界面，从不参与策略。
 *
 * 冷进程那两档（`compiling-probe` / `cold-start`）是后加的，而它们恰恰是最该报的：
 * 冷路径要先 javac 再从零起一遍苍穹 JVM，30-60 秒起步，以前这段时间界面上一个字都不变。
 */
export type ProbeProgressStage =
	| "checking-resident"
	| ProbeServerProgress
	| "running-probe"
	| "compiling-probe"
	| "cold-start";

export interface ResolvedProbe {
	src: string;
	cls: string;
	/** True for a scanned, read-only probe from the project; false for a released one. */
	adHoc: boolean;
}

export interface ProbeOptions {
	/** Positional arguments bound to the probe's required inputs, in order. */
	positional?: readonly string[];
	/** Explicit env overlay. Wins over positional binding -- explicit always wins. */
	env?: Readonly<Record<string, string>>;
	/** Force the cold path. */
	cold?: boolean;
	/**
	 * 常驻 JVM 用不上时，是否允许**隐式**降级到冷进程。默认允许，这是 CLI 与模型工具的行为。
	 *
	 * 关掉它的唯一调用方是 TUI 启动时的那次 EnvDiag，理由是代价的形状不一样：冷进程走的是
	 * `ports.proc.run`（spawnSync），整条 Node 事件循环在那 30-60 秒里一动不动——footer 的
	 * 转圈停在某一帧，按键不回显，跟死了没有区别。而它接在「常驻 90 秒没起来」后面，
	 * 于是最坏情况是先转圈 90 秒、再彻底僵住一两分钟。一次开机自检不值这个价：
	 * 关掉降级，把「常驻起不来」如实报到 footer 上，人可以照常干活，回头 /cosmic-env 重试。
	 *
	 * 显式的 `cold` / APPLY / ROLLBACK 不受这个开关影响：那是调用方自己点名要冷进程。
	 */
	coldFallback?: boolean;
	/**
	 * 常驻 JVM 没在跑时，是否把它拉起来。默认拉起。只有元数据快照的变化检查关掉它（S17 4.4）：
	 * 检查只搭已经在跑的常驻 JVM，为一次一秒的检查付半分钟启动不值；和 `coldFallback: false` 一起用。
	 */
	startResident?: boolean;
	/** Reviewed kernel callers may extend the resident request deadline; model tools cannot set it. */
	timeoutMs?: number;
	/** 内核已判定这次运行可能落库；答复不完整时不得换进程重放。 */
	mayCommit?: boolean;
	/** Interactive-only progress reporting; never changes probe policy or output. */
	onProgress?: (stage: ProbeProgressStage) => void;
	/**
	 * S6 interactive grant: the ONLY way a metadata APPLY run is admitted (S14.3.1;
	 * data writers need none since S27). The
	 * frozen CLI's DRAFT.md fallback went with the ledger, so a caller without one
	 * of these is refused before the JVM starts. Never reachable from a tool
	 * schema -- see docs/S4-security.md row 1.
	 */
	writeAuthorization?: {
		targets: readonly string[];
		rollback: string;
		confirmationId: string;
		/** 改数据（S23）时用户确认过的改前快照，作为 -Dcosmic.baseline 交给探针核对。 */
		baseline?: string;
	};
	/**
	 * Judge this run in the strict lane whatever the probe's declared one is (S8.1).
	 *
	 * `verify` is the only caller that sets it, and it sets it on every case.
	 * Freshness lanes exist so that EXPLORATION is not held up by code the probe
	 * will never load; a regression suite is the opposite situation. Its claim is
	 * "everything in this project passes as it stands", and an uncompiled source
	 * file makes that claim false whether or not this particular case would have
	 * noticed. It also keeps the promise a case draft prints when it was recorded
	 * under a lowered gate -- "转正重跑要走默认档" is only worth anything if the
	 * default at adoption time is the strict one.
	 *
	 * Deliberately not reachable from a tool schema: it can only tighten, but a
	 * per-call freshness knob in the model's hands is a knob that gets turned.
	 */
	strictFreshness?: boolean;
	/**
	 * Return the complete output instead of the human channel (S5.2).
	 *
	 * The default drops the platform's own logging (S37 2-A.1). Everything dropped
	 * is still on disk -- see `outputFile` -- so this flag is about what the caller
	 * receives, never about what is kept.
	 */
	raw?: boolean;
	/**
	 * env 是内核按写死的名字拼的（`run`、`meta`、代码关系表重建、用户查询），不是调用方手写的。
	 * 带它时内置探针不查「传了它不读的名字」：这些名字对不对由 `test/kernel/probe-env-names.test.ts`
	 * 对着真探针源码静态核，改代码时就红，不必等到运行；模型工具的 schema 够不着它。
	 */
	kernelEnv?: boolean;
	/**
	 * 这次调用算不算进「同一个问题问过几遍」的账（默认算）。
	 *
	 * 关掉它的只有回归验证：跑回归的职责就是**每次都再问一遍**「这条还成立吗」，
	 * 答案一次次相同正是它要的结果，不是浪费。不关的话，同一条命令连跑三遍第三遍会被拒，
	 * 而那恰恰是最正当的一次重跑。
	 *
	 * 和 `strictFreshness` 一样不进模型的工具参数表：它只能由内核调用方按用途定，
	 * 放到模型手里就成了一个「被拒了就关掉」的开关。
	 */
	countRepeats?: boolean;
	/** One line naming what produced this run, recorded in the stash header. */
	invocation?: string;
	/**
	 * This project's own package prefixes (`zlgd.`), for the noise ledger and the
	 * output filter.
	 *
	 * The ledger uses them to decide what may NOT be folded into 「这个环境的老面孔」:
	 * a stack running through our own code is worth reading every time, however
	 * familiar. The filter uses them only where an abbreviated logger name is
	 * ambiguous (`c.x.Plugin` under a project rooted at `cq.`). Callers that do not
	 * know stay silent rather than guess, and then repetition alone decides.
	 */
	ownPackages?: readonly string[];
	/** Agent-only prepare result. Never exposed in the model-facing tool schema. */
	preparation?: ProbePreparation;
	hooks?: FastHooks;
	/**
	 * 先在常驻 JVM 里起调度服务再跑（S37 2-E.4）：提交发起工作流、派发异步后台任务要它。
	 * 默认不起；起了开到常驻进程退出。只走常驻：冷进程跑完就退，派出去的任务没人接。
	 */
	schedule?: boolean;
	/**
	 * 输出里提到的本工程类名对到源码上，说在不在工程里（S38）。默认对；run 跑的就是
	 * 本工程编出来、刚加载过的类，再标一遍只是噪声，它传 false。
	 */
	classSources?: boolean;
}

/** @deprecated Use `PrepareBlocker`; kept so callers outside this file keep compiling. */
export type ProbePreparationBlocker = PrepareBlocker;

/** What execution needs once nothing blocks: the resolved target and its bound environment. */
export interface ProbePlan {
	target: ResolvedProbe;
	sourceText: string;
	sourceDigest: string;
	overlay: Record<string, string>;
	/** The doc/JAR join audit. Null for released probes and direct CLI calls. */
	api: Omit<ProbeApiPreflight, "capsules" | "blockers" | "warnings"> | null;
}

/**
 * The shared prepare shape (S15.5).
 *
 * `plan` is set as soon as the target resolves, blockers or not: the source
 * digest it carries is what `probe()` re-checks before it starts anything, and
 * that check has to happen even on a call that is about to be refused. Blockers
 * decide execution; a plan is never permission.
 */
export type ProbePreparation = PrepareResult<ProbePlan>;

export interface ProbeOutcome {
	probe: string;
	src: string;
	path: "cold" | "hot";
	/** Why the cold path was taken, when it was. */
	coldReason: string | null;
	exitCode: number;
	/** The human channel, or the complete output when `raw` was asked for. */
	output: string;
	/**
	 * The `[PROBE-JSON]` bypass (S5.2). `verify` grades on `records` and nothing
	 * else; `broken` is the probe's own malformed lines, reported rather than
	 * dropped.
	 */
	json: { records: ProbeJsonRecord[]; broken: string[]; file: string };
	/** The complete raw output of this run, on disk. Re-grep it instead of re-running. */
	outputFile: string;
	/** Lines the run produced vs. lines `output` carries. */
	outputLines: { total: number; shown: number };
	/** Stale-class gate decision and what it did. */
	stale: StaleVerdict;
	/** Automatic import/doc/JAR preparation audit. Null for released probes and direct CLI calls. */
	apiPrecheck?: ProbePlan["api"];
	/**
	 * 这个探针是干什么的、还认哪些入参（S20 批 4.2）。
	 *
	 * 以前这份说明只在**调错的时候**才出现（少给必填、给了位置参数）。真机一次会话里
	 * 模型 23 次拿 bash 去翻缓存里的探针 Java 源码——它没调错，它只是想知道「这个探针
	 * 还能问什么」，而唯一写着答案的地方是源码开头那段注释。跑成功的那次返回里本来
	 * 就该带着它。
	 *
	 * 作者自己写的头注释就是数据源，这里不另维护一张表：没写注释的探针这里就是空的，
	 * 缺了看得见，而不是被某张表悄悄编出一句话。
	 */
	usage?: ProbeUsageCard;
	notes: string[];
}

/** 探针的自我介绍：一句话用途 + 入参表。两样都从源码头注释里读。 */
export interface ProbeUsageCard {
	summary: string;
	/** 头注释里那几行 `NAME=值 说明`。 */
	inputs: string[];
	/** `req("X")` 扫出来的必填名，用来对照哪些是非填不可的。 */
	required: string[];
}

/**
 * Probe source resolution -- two classes of probe, two different controls.
 *
 * A RELEASED probe (one of the agent's own, named by class) is reviewed code:
 * it may write, and each write path calls IsvGuard, which checks ISV, the
 * `<isv>_` prefix and the confirmed target list. The allowed names come from the
 * embedded resources, not from a directory listing -- a file dropped into
 * probesDir must not become runnable.
 *
 * An AD-HOC probe (any .java under the project root) is code nobody reviewed, so
 * review is not the control; capability is. It is scanned before it is allowed
 * anywhere near the JVM, and the rule is that it may read and may not write.
 * That covers the reason ad-hoc probes are wanted -- diagnosis -- while keeping
 * the shared environment out of reach.
 *
 * Why the scan and not just IsvGuard: IsvGuard is called BY each probe, so code
 * that never calls it is never checked. Before this, `probe scratchpad/X.java`
 * was unreviewed, unguarded execution inside a JVM holding a live Cosmic
 * connection, and `resolve(projectRoot, name)` had no containment check either,
 * so `../` left the project entirely.
 */
export function resolveProbeTarget(ctx: KernelContext, name: string): KernelResult<ResolvedProbe> {
	if (ctx.probes.includes(name)) {
		const src = resolve(ctx.layout.probesDir, `${name}.java`);
		if (!ctx.ports.fs.exists(src)) {
			// Registered but absent means the cache was wiped or tampered with.
			return err(
				new KernelError("PROBE_NOT_FOUND", `探针已登记但文件不在：${src}`, {
					detail: { requested: name, resolved: src, probesDir: ctx.layout.probesDir },
					remedy: "缓存里的资源被删或被改了。重新 open 工程会重新释放。",
				}),
			);
		}
		const expectedDigest = ctx.releasedProbeDigests[name];
		if (expectedDigest !== undefined) {
			const actualDigest = sha256(ctx.ports.fs.read(src));
			if (actualDigest !== expectedDigest) {
				return err(
					new KernelError("PROBE_RELEASE_SOURCE_CHANGED", `已发布探针缓存源码与本版本不一致：${name}`, {
						detail: { probe: name, src, expectedDigest, actualDigest, probeSourceMismatch: true },
						remedy:
							"不要直接编辑 released 探针缓存：它不是探针扩展通道。重新 open 工程会从当前 agent 内嵌资源修复它；" +
							"需要新增写能力时修改 fast-ai-cosmic 的 resources/probes 并重新构建发布。",
					}),
				);
			}
		}
		// CosmicProbe reflects on the class name, not the path. Probes have no
		// package, so the class name is always the file's base name.
		return ok({ src, cls: basename(src, ".java"), adHoc: false });
	}

	if (!/[\\/]/.test(name) && !name.endsWith(".java")) {
		return err(
			new KernelError("PROBE_NOT_ALLOWED", `没有这个已发布探针：${name}`, {
				detail: { requested: name, released: ctx.probes.length },
				remedy:
					"已发布探针按类名给。临时探针给工程根相对路径，推荐 .cosmic-ai/probes/OneOff.java；它只准读、不准写。",
			}),
		);
	}

	const src = resolve(ctx.projectRoot, name);
	const inside = relative(ctx.projectRoot, src);
	if (inside.startsWith("..") || isAbsolute(inside)) {
		return err(
			new KernelError("PROBE_NOT_ALLOWED", `临时探针必须在工程里：${src}`, {
				detail: { requested: name, resolved: src, projectRoot: ctx.projectRoot },
				remedy: "把它放到工程根下的 .cosmic-ai/probes/，再用相对工程根的 .java 路径运行。",
			}),
		);
	}
	if (!ctx.ports.fs.exists(src)) {
		return err(
			new KernelError("PROBE_NOT_FOUND", `找不到临时探针：${src}`, {
				detail: { requested: name, resolved: src },
				remedy: `先写 ${resolve(ctx.projectRoot, ".cosmic-ai/probes/OneOff.java")}，再用 name=.cosmic-ai/probes/OneOff.java 运行。`,
			}),
		);
	}

	const sourceText = ctx.ports.fs.read(src);
	// javac writes a packaged class below package/name.class and Class.forName
	// requires that fully-qualified name. Using only basename here turned a valid
	// packaged probe into an opaque ClassNotFoundException after compilation.
	const packageName = /^\s*package\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*;/m.exec(
		blankJavaNoise(sourceText),
	)?.[1];
	const simpleName = basename(src, ".java");
	return ok({ src, cls: packageName ? `${packageName}.${simpleName}` : simpleName, adHoc: true });
}

/** Backward-compatible resolver: callers that only resolve still receive the capability scan. */
export function resolveProbe(ctx: KernelContext, name: string): KernelResult<ResolvedProbe> {
	const target = resolveProbeTarget(ctx, name);
	if (!target.ok || !target.value.adHoc) return target;
	const hits = scanAdHocProbe(ctx.ports.fs.read(target.value.src));
	if (hits.length === 0) return target;
	return err(
		new KernelError("PROBE_WRITES_REFUSED", `临时探针只准读，它用了 ${hits.length} 处不准用的东西`, {
			detail: {
				requested: name,
				resolved: target.value.src,
				hits: hits.map((hit) => `${hit.line}:${hit.what}`),
			},
			remedy:
				hits.map((hit) => `第 ${hit.line} 行 ${hit.what}：${hit.why}`).join("；") +
				"。要写共享环境，用已发布探针；那条路上 IsvGuard 会查 ISV、前缀和已确认目标。",
		}),
	);
}

/**
 * A probe's required input names, in the order `req("X")` appears in its source.
 *
 * Parsed from the source rather than kept in a table: the same "entity id" is
 * called META_ENTITY / META_FORM / LIMIT_ENTITY / DATA_ENTITY / OP_ENTITY across
 * probes. A table needs someone to update it for every new probe, and the cost
 * of missing one is a wasted cold run. The source is the only source of truth.
 */
export function probeRequiredNames(text: string): string[] {
	const names: string[] = [];
	// Only req("X") counts; env("X", default) has a default and is not required.
	for (const match of text.matchAll(/\breq\(\s*"([A-Z][A-Z0-9_]*)"/g)) {
		const name = match[1] as string;
		if (!names.includes(name)) names.push(name);
	}
	return names;
}

/** Inputs the harness itself sets, never declared by a probe's own source. */
const HARNESS_INPUTS = new Set(["APPLY", "ROLLBACK"]);

/**
 * Settings the DRIVER reads from its own environment, which a probe's env
 * overlay can therefore never change.
 *
 * Passed as a probe input they used to vanish without a word: the value went
 * into the JVM's environment, the gate kept reading `ctx.env`, and a session that
 * followed a remedy's "COSMIC_STALE=warn" got the identical refusal back and no
 * reason why. Refused before anything starts, and by name, for every probe --
 * released ones included, which are otherwise never told a name is stray.
 */
const DRIVER_ONLY_INPUTS = ["COSMIC_STALE"] as const;

export interface ProbeUsage {
	/** `req("X")` names, in source order. */
	required: string[];
	/**
	 * The header comment's `NAME=…` lines, verbatim and in order -- required and
	 * optional together, because that block is what the probe author curated.
	 */
	doc: string[];
}

const USAGE_LINE = /^\s*\*\s*([A-Z][A-Z0-9_]*=\S.*?)\s*$/;

/**
 * The class declaration, which is where the header ends.
 *
 * It used to be "the first line of code", written as `public|final|class|import|
 * package`. Every probe in `resources/probes` puts its imports above its class
 * javadoc -- the ordinary Java layout -- so the scan stopped on line 1 and all
 * 23 probes with required inputs reported "源码里没有参数注释" while carrying a
 * full parameter block a few lines below. That is the whole reason a session had
 * to open `AddFieldProbe.java` in the cache to learn what `ADD_ITEMS` wanted.
 *
 * The reason for stopping at all is unchanged: past the declaration an `X=1`
 * inside a string could otherwise become documentation.
 */
const CLASS_DECLARATION = /^\s*(?:(?:public|final|abstract|static)\s+)*(?:class|interface|enum)\s+[A-Za-z_$]/;

/**
 * What a probe takes, without starting a JVM.
 *
 * The old remedy for a mis-called probe was "看探针源码开头的参数注释", which is
 * unreachable advice for a RELEASED probe: its source is an embedded resource
 * released into the cache, not a file anybody had open. The only remaining way
 * to learn a probe's inputs was to run it and read what `req()` printed -- a
 * 30-40s cold start bought to read a usage line. The source sits on disk at
 * `probesDir` the whole time, so this reads it there instead.
 *
 * Neither half is a second table to maintain: `required` is the same `req("X")`
 * scan that binds positional arguments, and `doc` is the author's own header
 * block, so an input documented nowhere shows up as a required name with no
 * line -- visibly incomplete rather than silently absent.
 */
export function probeUsage(text: string): ProbeUsage {
	const doc: string[] = [];
	// 一个入参下面缩进得更深的续行是它的写法（改动清单的各种行、取值的格式），一起带上；空行或缩回去就停。
	// 原来只取 `X=` 那一行，FormLayoutWriteProbe 的 LAYOUT_EDIT 只剩「改动清单」四个字，写法全丢。
	let indent = -1;
	for (const line of text.split(/\r?\n/)) {
		if (CLASS_DECLARATION.test(line)) break;
		const match = USAGE_LINE.exec(line);
		if (match) {
			doc.push(match[1] as string);
			indent = line.indexOf(match[1] as string);
			continue;
		}
		const content = /^\s*\*\s*(\S.*?)\s*$/.exec(line)?.[1];
		if (indent >= 0 && content !== undefined && line.indexOf(content) > indent) doc.push(content);
		else indent = -1;
	}
	return { required: probeRequiredNames(text), doc };
}

/**
 * The first sentence of a probe's own class javadoc -- what it is FOR.
 *
 * The released list reaches the model as names, and a name is not a capability:
 * `DataProbe` reads as "query data" and is in fact "does this form have any rows,
 * plus one sample record", with no filter at all. A real session could only find
 * that out by opening the source (复盘 §8.4-2, 2026-09-11). The author already
 * wrote the answer as the header's first sentence, so this reads it rather than
 * keeping a second description table beside the probes.
 *
 * Empty when the class has no javadoc; the caller says so instead of guessing.
 */
export function probeSummary(text: string): string {
	const lines = text.split(/\r?\n/);
	const declaration = lines.findIndex((line) => CLASS_DECLARATION.test(line));
	if (declaration < 0) return "";
	const head = lines.slice(0, declaration).join("\n");
	const open = head.lastIndexOf("/**");
	const close = open < 0 ? -1 : head.indexOf("*/", open);
	// Only annotations may sit between the javadoc and the class; anything else
	// means that comment belongs to something above.
	if (close < 0 || !/^(?:\s|@[\w.]+(?:\([^)]*\))?)*$/.test(head.slice(close + 2))) return "";
	const body: string[] = [];
	for (const raw of head.slice(open + 3, close).split("\n")) {
		const line = raw.replace(/^\s*\*\s?/, "").trim();
		if (line === "") {
			if (body.length > 0) break;
			continue;
		}
		body.push(line);
	}
	const joined = body.reduce((text, line) => {
		const ascii = /[\x21-\x7e]$/.test(text) && /^[\x21-\x7e]/.test(line);
		return text === "" ? line : `${text}${ascii ? " " : ""}${line}`;
	}, "");
	const plain = joined
		.replace(/\{@\w+\s+([^}]+)\}/g, "$1")
		.replace(/\*\*|`/g, "")
		.trim();
	const stop = plain.search(/[。；]/);
	const sentence = stop < 0 ? plain : plain.slice(0, stop + 1);
	return sentence.length > 90 ? `${sentence.slice(0, 89)}…` : sentence;
}

/** One released probe as the model picks between them: name, required inputs, purpose, full input block. */
export interface ProbeCatalogEntry {
	name: string;
	required: string[];
	summary: string;
	usage: string[];
}

/**
 * Every released probe's required input names, read once when the project opens.
 *
 * The list of released probes used to reach the model as 44 bare class names,
 * and a probe's parameters are declared nowhere else the model can see: not in
 * the tool schema, not in the knowledge base. The only remaining way to learn
 * that `AddFieldProbe` wants `ADD_ENTITY / ADD_KEY / ADD_NAME / ADD_TYPE` was to
 * open its source in the release cache -- for a shared-metadata WRITE probe,
 * which is the one place guessing is most expensive.
 *
 * Required names only, deliberately: the optional ones outnumber them several
 * times over on the sim probes and would cost more prompt budget than they save.
 * A probe with no `req("…")` is absent from the map rather than present and
 * empty, so the caller does not have to distinguish "takes nothing" from
 * "unreadable".
 */
export function releasedProbeInputs(ctx: KernelContext): Record<string, string[]> {
	const inputs: Record<string, string[]> = {};
	for (const name of ctx.probes) {
		const src = resolve(ctx.layout.probesDir, `${name}.java`);
		if (!ctx.ports.fs.exists(src)) continue;
		const required = probeRequiredNames(ctx.ports.fs.read(src));
		if (required.length > 0) inputs[name] = required;
	}
	return inputs;
}

/** The usage block as remedy text: the doc lines when there are any, else the bare names. */
export function probeUsageText(cls: string, usage: ProbeUsage): string {
	if (usage.doc.length > 0) return `${cls} 的入参：${usage.doc.join("；")}`;
	if (usage.required.length > 0) return `${cls} 的必填入参：${usage.required.join(" / ")}（源码里没有参数注释）`;
	return `${cls} 没有声明必填入参，源码里也没有参数注释`;
}

/**
 * Binds positional arguments onto a probe's required inputs, returning an
 * overlay. `probe MetaProbe zlgd_bzwz_wl` means META_ENTITY=zlgd_bzwz_wl.
 * An explicitly supplied value is never overwritten.
 */
export function bindProbeArgs(
	cls: string,
	sourceText: string,
	positional: readonly string[],
	explicit: Readonly<Record<string, string>>,
): KernelResult<Record<string, string>> {
	if (positional.length === 0) return ok({ ...explicit });
	const usage = probeUsage(sourceText);
	const names = usage.required;
	if (names.length === 0) {
		return err(
			new KernelError("PROBE_ARGS_INVALID", `${cls} 没有 req("…") 声明的必填入参，接不了位置参数`, {
				detail: { probe: cls, positional, usage: usage.doc },
				remedy: `改用 env 传值。${probeUsageText(cls, usage)}。`,
			}),
		);
	}
	if (positional.length > names.length) {
		return err(
			new KernelError(
				"PROBE_ARGS_INVALID",
				`${cls} 只有 ${names.length} 个必填入参（${names.join(" / ")}），给了 ${positional.length} 个`,
				{
					detail: { probe: cls, required: names, given: positional.length, usage: usage.doc },
					remedy: `去掉多余的位置参数，其余入参用 env 给。${probeUsageText(cls, usage)}。`,
				},
			),
		);
	}
	const overlay: Record<string, string> = { ...explicit };
	positional.forEach((value, index) => {
		const key = names[index] as string;
		if (overlay[key] !== undefined && overlay[key] !== "") return;
		overlay[key] = value;
	});
	return ok(overlay);
}

/**
 * All checks that can be answered from the target, source, arguments and an
 * optional deterministic doc/JAR join. No build, javac or Cosmic JVM starts here.
 */
export function prepareProbeInvocation(
	ctx: KernelContext,
	name: string,
	options: Omit<ProbeOptions, "preparation"> = {},
	apiPreflight?: ProbeApiPreflight,
): KernelResult<ProbePreparation> {
	const target = resolveProbeTarget(ctx, name);
	if (!target.ok) return err(target.error);
	const sourceText = ctx.ports.fs.read(target.value.src);
	const blockers: ProbePreparationBlocker[] = [];
	let overlay: Record<string, string> = { ...(options.env ?? {}) };
	const bound = bindProbeArgs(target.value.cls, sourceText, options.positional ?? [], options.env ?? {});
	if (bound.ok)
		overlay = !target.value.adHoc && isDataWriter(target.value.cls) ? dataWriteOverlay(bound.value) : bound.value;
	else
		blockers.push({
			code: bound.error.code,
			message: bound.error.message,
			remedy: bound.error.remedy ?? "修正参数。",
		});

	const usage = probeUsage(sourceText);
	const supplied = childEnv(ctx, overlay);
	const missing = usage.required.filter((required) => (supplied[required] ?? "") === "");
	// 探针读的名字连同它用到的共用类一起算，内置和临时同一套（S37 2-B.1）；内核自己拼的 env 不在这里查
	const checkNames = target.value.adHoc || options.kernelEnv !== true;
	const known = !checkNames
		? new Set<string>()
		: probeEnvNames(basename(target.value.src, ".java"), sourceText, (cls) => {
				const file = resolve(ctx.layout.probesDir, `${cls}.java`);
				return ctx.ports.fs.exists(file) ? ctx.ports.fs.read(file) : null;
			});
	const strays = Object.keys(checkNames ? (options.env ?? {}) : {}).filter(
		(key) =>
			!known.has(key) && !HARNESS_INPUTS.has(key) && !key.startsWith("COSMIC_") && (options.env?.[key] ?? "") !== "",
	);
	const driverOnly = DRIVER_ONLY_INPUTS.filter((key) => (options.env?.[key] ?? "") !== "");
	if (driverOnly.length > 0) {
		blockers.push({
			code: "PROBE_ENV_DRIVER_ONLY",
			message: `${driverOnly.join(" / ")} 是驱动进程的设置，放在 cosmic_probe 的 env 里不起作用`,
			remedy:
				`去掉 ${driverOnly.join(" / ")} 再调。陈旧 class 门禁读的是启动 cosmic 时 shell 里的环境变量，工具参数够不着它——` +
				"这是有意的：放宽门禁要用户来设。被 STALE_CLASSES 拦下时照那条拒绝里的办法走（去掉写入参、换只读探针或先 cosmic_fast）。",
		});
	}
	if (!target.value.adHoc) {
		// 分录当实体填：代码关系表里记着的，不进 Java 就挡下、给出照抄的写法（S33）。
		const rows = loadFieldRows(ctx);
		if (rows !== undefined) blockers.push(...entryAsEntityBlockers(rows, overlay));
	}
	if (missing.length > 0) {
		blockers.push({
			code: "PROBE_INPUT_MISSING",
			message: `${target.value.cls} 缺必填入参：${missing.join(" / ")}`,
			remedy: `按 req 声明顺序（${usage.required.join(" / ")}）给位置参数，或用 env 给值。${probeUsageText(target.value.cls, usage)}。`,
		});
	}
	if (strays.length > 0) blockers.push(unknownEnvBlocker(target.value.cls, strays, usage));
	if (target.value.adHoc) {
		const owner = moduleOf(ctx, target.value.src);
		if (owner !== null) {
			// Inside a code module's source root an ad-hoc probe IS business source to
			// every other check: the source fingerprint counts it, `fast` compiles it into
			// the module's classes, and the session trace puts it on the delivery receipt.
			// A real session paid one `cosmic_fast` per edit of a throwaway file and
			// delivered a receipt listing it three times. Refused here, before the verify
			// phase's freshness check, whose remedy ("rerun fast") would be the wrong way out.
			const moved = `.cosmic-ai/probes/${basename(target.value.src)}`;
			blockers.push({
				code: "PROBE_IN_SOURCE_TREE",
				message: `临时探针放在业务源码目录里：${relative(ctx.projectRoot, target.value.src)}`,
				remedy:
					`把它挪到 ${moved}（package 行留着也行），删掉原文件，再用 name=${moved} 运行。` +
					`放在 ${owner.name} 的源码目录里，它就被当成业务代码：算进源码指纹（每改一次都要重跑 cosmic_fast）、` +
					"被 cosmic_fast 一起编进业务 class、算进本会话改过的业务文件。挪走后源码回到原样，不用为它编译。",
			});
		}
		const hits = scanAdHocProbe(sourceText);
		if (hits.length > 0) {
			blockers.push({
				code: "PROBE_WRITES_REFUSED",
				message: `临时探针只准读，它用了 ${String(hits.length)} 处危险能力`,
				remedy: hits.map((hit) => `第 ${String(hit.line)} 行 ${hit.what}：${hit.why}`).join("；"),
			});
		}
		if (overlay.APPLY === "1" || overlay.ROLLBACK === "1") {
			blockers.push({
				code: "PROBE_WRITES_REFUSED",
				message: `临时探针不能带 APPLY/ROLLBACK：${target.value.cls}`,
				remedy: "临时探针只准读；共享写必须使用已发布探针和一次性用户授权。",
			});
		}
		if (apiPreflight === undefined) {
			for (const wildcard of probeImports(sourceText).wildcards) {
				blockers.push({
					code: "PROBE_API_WILDCARD",
					message: `通配 import 无法确定依赖集合：${wildcard}`,
					remedy: `把 ${wildcard} 换成实际使用的具体类名。`,
				});
			}
		} else {
			blockers.push(...apiPreflight.blockers);
		}
	}
	// S27：造数据、改数据落库（APPLY=1）和运行的真提交是一回事——在常驻进程里走平台保存，
	// 缓存跟着对（2026-09-19 真机验过），所以走常驻；它们的预演是回滚事务，仍然冷。写元数据照旧冷。
	const dataWriter = !target.value.adHoc && isDataWriter(target.value.cls);
	const cold =
		(overlay.APPLY === "1" && !dataWriter) ||
		overlay.ROLLBACK === "1" ||
		options.cold === true ||
		(dataWriter && overlay.APPLY !== "1");
	return ok(
		emptyPrepare<ProbePlan>({
			plan: {
				target: target.value,
				sourceText,
				sourceDigest: sha256(sourceText),
				overlay,
				api:
					apiPreflight === undefined
						? null
						: {
								classes: apiPreflight.classes,
								wildcards: apiPreflight.wildcards,
								reflection: apiPreflight.reflection,
								queries: apiPreflight.queries,
							},
			},
			blockers,
			warnings: apiPreflight?.warnings ?? [],
			capsules: apiPreflight?.capsules ?? [],
			deferred: deferredChecks(target.value, apiPreflight),
			// 探针不读的名字多半是把名字写错了（QUERY_FILTER 本想写 QUERY_WHERE），
			// 删掉等于悄悄去掉那个条件，所以不代写；内置和临时一样（S37 2-B.1）。
			retryInput: strays.length === 0 ? retryWithoutStrays(name, options, blockers, driverOnly) : null,
			estimatedCost: blockers.length > 0 ? FREE : { processes: 1, coldStarts: cold ? 1 : 0 },
		}),
	);
}

/**
 * 传了探针不读的名字：临时探针和内置探针一个标准（S37 2-B.1），都在启动前拦下，附上探针自己的入参表。
 * 不猜相近的名字：按拼写挑的候选一给就是五个，`QUERY_FILTER` 该写的 `QUERY_WHERE` 排第四，
 * 给得多又多半不对（用户 2026-09-26 定去掉）；入参表是探针作者写的，照着挑。
 */
function unknownEnvBlocker(cls: string, strays: readonly string[], usage: ProbeUsage): ProbePreparationBlocker {
	return {
		code: "PROBE_ENV_UNKNOWN",
		message: `${strays.join(" / ")} 不是 ${cls} 读取的环境变量`,
		remedy: `改对或删掉 ${strays.join(" / ")}；${probeUsageText(cls, usage)}。`,
	};
}

/**
 * Checks the join could not make, named rather than silently passed.
 *
 * `reflection: "unavailable"` is the one that matters: without the current JAR
 * nothing here knows whether a class or an overload exists, and javac catches it
 * later -- one round trip later, before the Cosmic JVM but after this refusal
 * had a chance to say so.
 */
function deferredChecks(target: ResolvedProbe, apiPreflight?: ProbeApiPreflight): PrepareDeferred[] {
	if (!target.adHoc) return [];
	if (apiPreflight === undefined)
		return [
			{
				check: "精确 import 的类、方法与参数存在性",
				dependsOn: ["knowledge-base", "reflection:ApiTool"],
				reason: "本次调用没有可用的知识库/反射通道，只做了参数与危险能力检查。",
			},
		];
	if (apiPreflight.reflection !== "unavailable") return [];
	return [
		{
			check: "当前 JAR 的类、方法与参数存在性",
			dependsOn: ["reflection:ApiTool"],
			reason: "批量反射不可用；改由 javac 在 Cosmic JVM 前兜底，本次未逐个核对签名。",
		},
	];
}

/**
 * The one probe retry the harness may write for the caller.
 *
 * Dropping an environment variable the probe does not read is derived from
 * facts: `probeEnvNames` says which names it reads, so the corrected call is
 * this call minus those keys. A driver-only setting is the same kind of fact --
 * it does nothing in the overlay, so the call without it is the same call. A
 * MISSING input is the opposite -- the value is the caller's to supply, and a
 * `nextCall` that invented one would be a wrong call in a structured wrapper
 * (S15 §4.4).
 */
const DROPPABLE_BLOCKERS = new Set(["PROBE_ENV_UNKNOWN", "PROBE_ENV_DRIVER_ONLY"]);

function retryWithoutStrays(
	name: string,
	options: Omit<ProbeOptions, "preparation">,
	blockers: readonly PrepareBlocker[],
	strays: readonly string[],
): { name: string; positional: string[]; env: Record<string, string> } | null {
	if (strays.length === 0) return null;
	if (!blockers.every((blocker) => DROPPABLE_BLOCKERS.has(blocker.code))) return null;
	const env = Object.fromEntries(Object.entries(options.env ?? {}).filter(([key]) => !strays.includes(key)));
	return { name, positional: [...(options.positional ?? [])], env };
}

function preparationError(preparation: ProbePreparation): KernelError {
	const plan = preparation.plan;
	return prepareKernelError("PROBE_PRECHECK_FAILED", "探针在启动编译/JVM 前发现阻碍", preparation, {
		probe: plan?.target.cls ?? null,
		src: plan?.target.src ?? null,
		apiClasses: plan?.api?.classes ?? [],
		apiWildcards: plan?.api?.wildcards ?? [],
		apiReflection: plan?.api?.reflection ?? "not-run",
		apiQueries: plan?.api?.queries ?? 0,
	});
}

/**
 * The stale-class gate: "compile before you probe", mechanised.
 *
 * A probe's own source is compiled on the spot, but the business classes it
 * reaches come from the classpath. Probing without compiling verifies the old
 * classes, and when only a method body changed **nothing reports an error at
 * all** -- the run looks completely normal. That is the most expensive kind of
 * mistake here, which is why refusal is the default.
 *
 * It is the default and not the rule, because the scan answers a wider question
 * than the gate protects: it finds every stale business source in the project,
 * including the ones this probe will never load. `lane` is what narrows it --
 * see `policy/probe-freshness.ts` for how a probe earns the `platform` lane and
 * why the list is a whitelist. An explicit `COSMIC_STALE` still wins over both,
 * in either direction.
 */
async function staleGate(
	ctx: KernelContext,
	hooks: FastHooks,
	lane: FreshnessLane,
	subject: StaleSubject,
): Promise<KernelResult<StaleVerdict>> {
	let stale: string[];
	try {
		stale = await staleSourcesAsync(ctx);
	} catch {
		// A scan that cannot run must not block the probe.
		return ok({ files: 0, lane, mode: "block", action: "none" });
	}
	if (stale.length === 0) return ok({ files: 0, lane, mode: "block", action: "none" });

	const raw = (ctx.env.COSMIC_STALE ?? (lane === "platform" ? "warn" : "block")).toLowerCase();
	const mode: StaleMode = raw === "fast" || raw === "warn" ? raw : "block";
	if (mode === "fast") {
		const compiled = await fast(ctx, [], hooks);
		if (!compiled.ok) return err(compiled.error);
		return ok({ files: stale.length, lane, mode, action: "compiled" });
	}
	if (mode === "warn") return ok({ files: stale.length, lane, mode, action: "warned" });

	return err(
		new KernelError("STALE_CLASSES", `${stale.length} 个业务源文件比 .class 新，探针链到的还是旧类`, {
			detail: {
				count: stale.length,
				lane,
				sample: stale.slice(0, 3).map((file) => relative(ctx.projectRoot, file)),
			},
			remedy: staleRemedy(lane, subject),
		}),
	);
}

/** What the refusal needs to know about the run it refused, beyond the lane. */
interface StaleSubject {
	cls: string;
	adHoc: boolean;
	/** `verify` asked for the strict lane (`ProbeOptions.strictFreshness`). */
	strict: boolean;
}

/**
 * Where the COSMIC_STALE knob actually is.
 *
 * The remedy used to end with "COSMIC_STALE=fast 自动编，=warn 只提示不拦" and
 * nothing else. A session read that as a probe input, passed it in `env`, and got
 * the identical refusal back: the gate reads the driver's own environment, which
 * no tool argument reaches -- deliberately, see `strictFreshness`. Naming the
 * variable without its place was a key with no door.
 */
const STALE_KNOB =
	"COSMIC_STALE 是启动 cosmic 之前在 shell 里设的开关（=fast 自动编，=warn 只提示不拦），cosmic_probe 的 env 参数改不了它；只有用户能设，设完要重启 cosmic。";

/**
 * The way out, cheapest first, for the run that was actually refused.
 *
 * Names tools, not verbs: the agent layer annotates a remedy that names a retired
 * tool (`withReachableRemedy`), and it can only do that if the text says the tool
 * name rather than a verb. (Until S25 it also pointed at `cosmic_lint` as the way
 * into the phase that mounted `cosmic_fast`; every tool is mounted now.)
 *
 * Compiling is not always the first answer. A read-mode probe called with a
 * write input is one argument away from the platform lane, and a released probe
 * refused while the caller only wanted to LOOK has read-only probes that are not
 * held by these files at all; sending either one to compile sixteen unrelated
 * half-edited plugins is how a 0.4-second read turned into a stalled session.
 */
function staleRemedy(lane: FreshnessLane, subject: StaleSubject): string {
	// A platform-lane probe only reaches the refusal through an explicit block.
	if (lane === "platform")
		return "本探针只读平台/元数据、不加载业务类，默认档本会放行——是启动 cosmic 前设的 COSMIC_STALE=block 拦下的，请用户去掉那个设置后重启。";
	const compile = "先跑 cosmic_fast（约 40 秒）编到最新再重跑。";
	if (subject.strict) return `回归要证明的是「当前源码」，陈旧 class 上的结果不作数。${compile}`;
	if (subject.adHoc)
		return `这个临时探针引用了正在改、还没编译的包，旧类跑出来的结论不作数。${compile}其实用不到那些类的话，删掉对应的 import / 全限定名引用即可放行（只看引用了陈旧包没有）。${STALE_KNOB}`;
	return `${subject.cls} 会链到业务类或能写共享环境，旧类跑出来的结论不作数。${compile}只是想读元数据或数据的话不必编译：改用 platform 档的只读探针（如 MetaProbe / FormLayoutProbe / DataProbe / DataQueryProbe），或在 .cosmic-ai/probes/ 写一个不引用这些陈旧包的临时只读探针，它们都不被这批文件拦。${STALE_KNOB}`;
}

/**
 * The metadata APPLY=1 admission check -- the first half of "confirmed writes only".
 * Data writers never reach it since S27: the caller passes `applying` only for metadata.
 *
 * The second half lives in IsvGuard: the target list is passed in as
 * -Dcosmic.targets and an object outside it is refused at write time. Split in
 * two because the kernel only knows *whether* targets were confirmed, while
 * IsvGuard stands on the path of every actual write and knows *what* is being
 * written. There is no bypass switch, for the same reason the ISV line has none.
 *
 * S5.4 moved the decision itself into `policy/shared-write.ts`: `meta`'s two
 * write channels reach the same JVM by the same road, and a second entry point
 * with its own copy of this check is a way around it. What stayed here is the
 * one thing that is `probe`'s own -- turning the verdict into JVM properties.
 */
export function writeTargetProps(
	ctx: KernelContext,
	options: ProbeOptions,
	cls: string,
	applying: boolean,
): KernelResult<{ props: string[]; notes: string[] }> {
	if (!applying) return ok({ props: [], notes: [] });
	// No authorization is not "decide from the file": the DRAFT.md fallback went
	// with the ledger (S14.3.1), so this refusal is the whole answer. It is the
	// kernel's own copy of the door the extension already keeps -- the second
	// half of "confirmed writes only" being in one place means one place, not one
	// place per layer.
	if (options.writeAuthorization === undefined) {
		return err(
			new KernelError(
				"WRITE_TARGETS_UNCONFIRMED",
				`APPLY=1 被拒：${cls} 这次要写哪些共享对象没有用户确认过的写入范围`,
				{
					detail: { operation: `probe ${cls} APPLY=1`, confirmed: [] },
					remedy:
						"写元数据带 APPLY=1 并附 report（cosmic_meta 用 apply=true 并附 report）：" +
						"工具先预演、按预演排出确认单弹给用户，用户确认后带着确认号落库。",
				},
			),
		);
	}
	const admission = admitSharedWrite(ctx, {
		operation: `probe ${cls} APPLY=1`,
		authorization: options.writeAuthorization,
	});
	if (!admission.ok) return err(admission.error);
	const baseline = options.writeAuthorization.baseline ?? "";
	return ok({
		// 快照只可能是探针自己打出来的 16 位十六进制；别的形状不往 JVM 参数里放。
		props: [
			...targetProps(admission.value),
			...(/^[0-9a-f]{16}$/.test(baseline) ? [`-Dcosmic.baseline=${baseline}`] : []),
		],
		notes: [`本次放行已确认的写入目标 ${targetsSummary(admission.value.targets)}`, ...admission.value.notes],
	});
}

async function coldProbe(
	ctx: KernelContext,
	src: string,
	cls: string,
	overlay: Record<string, string>,
	extraProps: readonly string[],
	onProgress?: (stage: ProbeProgressStage) => void,
): Promise<KernelResult<{ exitCode: number; output: string }>> {
	const built = await ensureBuilt(ctx);
	if (!built.ok) return err(built.error);

	const { fs } = ctx.ports;
	fs.mkdirp(ctx.layout.probeClasses);
	const classFile = resolve(ctx.layout.probeClasses, `${cls.replace(/\./g, "/")}.class`);

	// Same class name from a different source file (one in scratchpad, one in
	// probes/) makes an mtime comparison wrong, so the source it came from is
	// recorded alongside.
	let index: Record<string, string> = {};
	const rawIndex = fs.read(ctx.layout.probeSrcIndex);
	if (rawIndex !== "") {
		try {
			index = JSON.parse(rawIndex) as Record<string, string>;
		} catch {
			index = {};
		}
	}
	const classMs = fs.mtimeMs(classFile);
	const fresh = classMs !== null && index[cls] === src && classMs > newestProbeSourceMs(ctx, src);
	if (!fresh) {
		onProgress?.("compiling-probe");
		// -sourcepath lets javac find the shared classes a probe references
		// (IsvGuard and friends) without listing each helper on the command line.
		// -implicit:class silences the "annotation processing is not applicable to
		// implicitly compiled files" note that would otherwise print every run.
		const run = await runJavac(ctx, [
			"-encoding",
			"UTF-8",
			`@${ctx.layout.javacArgs}`,
			"-implicit:class",
			"-sourcepath",
			ctx.layout.probesDir,
			"-d",
			ctx.layout.probeClasses,
			ctx.layout.hostSrc,
			ctx.layout.bridgeSrc,
			ctx.layout.viewsSrc,
			ctx.layout.bootStubSrc,
			src,
		]);
		if (run.status !== 0) {
			return err(
				new KernelError("COMPILE_FAILED", `探针 ${cls} 编译失败`, {
					detail: { probe: cls, status: run.status, raw: run.out.trim().slice(0, 8000) },
					remedy: "按 javac 原文改探针源码。",
				}),
			);
		}
		index[cls] = src;
		fs.write(ctx.layout.probeSrcIndex, JSON.stringify(index));
	}

	onProgress?.("cold-start");
	const run = await runJava(
		ctx,
		[
			KEEP_EXCEPTION_STACKS,
			"-Dfile.encoding=UTF-8",
			...jvmProps(ctx.config),
			...poolProps(ctx.config),
			...extraProps,
			"-cp",
			classpathOf(ctx.layout.probeClasses, ctx.layout.pathingJar),
			"CosmicProbe",
			cls,
		],
		{ ...baseChildEnv(ctx), ...overlay },
	);
	return ok({ exitCode: run.status, output: run.out });
}

/**
 * Newest mtime among the probe, the host, the bridge and every shared class in
 * probes/. Shared classes (IsvGuard / MetaResolve) change too, and a probe
 * compiled against an old one fails in ways that point at the wrong file.
 */
function newestProbeSourceMs(ctx: KernelContext, src: string): number {
	const { fs } = ctx.ports;
	let newest = Math.max(
		fs.mtimeMs(src) ?? 0,
		fs.mtimeMs(ctx.layout.hostSrc) ?? 0,
		fs.mtimeMs(ctx.layout.bridgeSrc) ?? 0,
		fs.mtimeMs(ctx.layout.viewsSrc) ?? 0,
		fs.mtimeMs(ctx.layout.bootStubSrc) ?? 0,
	);
	for (const entry of fs.readDir(ctx.layout.probesDir)) {
		if (entry.isDirectory || !entry.name.endsWith(".java")) continue;
		newest = Math.max(newest, fs.mtimeMs(resolve(ctx.layout.probesDir, entry.name)) ?? 0);
	}
	return newest;
}

/**
 * Everything that happens to a probe's output once the run itself is over.
 *
 * One funnel for all four exits (cold, hot, and the two cold fallbacks) so that
 * no path can return a result without its bypass records having been collected
 * and its raw output stashed. A path that skipped the stash would be
 * indistinguishable from one that ran and printed nothing.
 */
/**
 * The "提示" half of "提示但放行".
 *
 * A run that went ahead over stale classes used to say nothing at all: the
 * verdict was recorded on the outcome and nothing rendered it, so `warn` was
 * indistinguishable from a clean tree. That is fine for a gate that only ever
 * fired on an explicit opt-in, and not fine now that the platform lane reaches
 * it by default -- the whole claim of that lane is "these stale files do not
 * affect this answer", and the reader has to be able to check it.
 *
 * Nothing is said when the gate compiled or had nothing to do; a note per probe
 * on a clean tree is noise, and the budget it costs is real.
 */
function staleNotes(stale: StaleVerdict): string[] {
	if (stale.action !== "warned") return [];
	return [
		stale.lane === "platform"
			? `${stale.files} 个业务源文件比 .class 新，本探针只读平台/元数据、不加载业务类，按 platform 档放行——结论与那些改动无关。`
			: `${stale.files} 个业务源文件比 .class 新，是 COSMIC_STALE=warn 放行的——本探针会链到业务类，这次的结论可能来自旧类。`,
	];
}

/**
 * 跑成功的那次也把「这个探针能干什么」带上（S20 批 4.2）。
 *
 * 读的是准备阶段已经在内存里的那份源码，不额外开文件；没有 plan 的调用路径
 * （直接 CLI）就没有这张卡片，而不是硬去读盘。
 */
function usageCard(sourceText: string | undefined): ProbeUsageCard | undefined {
	if (typeof sourceText !== "string" || sourceText === "") return undefined;
	const usage = probeUsage(sourceText);
	const summary = probeSummary(sourceText);
	if (summary === "" && usage.doc.length === 0) return undefined;
	return { summary, inputs: usage.doc, required: usage.required };
}

function complete(
	ctx: KernelContext,
	options: ProbeOptions,
	base: Omit<ProbeOutcome, "json" | "outputFile" | "outputLines">,
	repeat: RepeatKey | null = null,
	sourceText?: string,
	adHoc = false,
): ProbeOutcome {
	const evidence = stashProbeOutput(
		ctx,
		{ cls: base.probe, src: base.src, invocation: options.invocation ?? `probe ${base.probe}` },
		base.output,
	);
	const filtered = filterProbeOutput(base.output, options.ownPackages ?? []);
	// 记在这个漏斗里而不是各个出口：冷、热、两条降级路都要记，
	// 漏掉一条就等于「那条路上问几遍都不算数」，而降级路恰恰是最慢的那条。
	//
	// 比的是**过滤后留下的那几行**，不是整份运行日志：后者里线程名、请求 id、
	// 连接池计数每跑一次都不同，按它比永远比不出「答案没变」，这套机制就成了摆设。
	// 留下的日志行已经去掉了时间和请求 id（见 filterProbeOutput）。
	if (repeat !== null) {
		recordRepeat(ctx, repeat, { output: filtered.lines.join("\n"), outFile: evidence.outFile });
	}
	// Recorded before the `raw` exit, not after: a raw run saw the same background
	// exceptions as a folded one, and a ledger that skips those would under-count
	// exactly the runs a person opened the full log for.
	const seenBefore = recordNoise(ctx, filtered.exceptions, options.ownPackages ?? []);
	const notes = [...staleNotes(base.stale), ...base.notes];
	for (const broken of evidence.broken) {
		notes.push(`[PROBE-JSON] 这行不是合法 JSON，已记进 broken：${broken}`);
	}
	if (adHoc && hasAssertions(evidence.records, filtered.lines)) notes.push(AD_HOC_ASSERT_NOTE);
	if (SCHEDULE_STOPPED.test(base.output)) notes.push(SCHEDULE_STOPPED_NOTE);
	const classNote = options.classSources === false ? null : ownClassNote(base.output, classLocator(ctx));
	if (classNote !== null) notes.push(classNote);
	const card = usageCard(sourceText);
	if (options.raw === true) {
		return {
			...base,
			...(options.preparation?.plan?.api === null || options.preparation?.plan?.api === undefined
				? {}
				: { apiPrecheck: options.preparation.plan.api }),
			...(card === undefined ? {} : { usage: card }),
			notes,
			json: { records: evidence.records, broken: evidence.broken, file: evidence.jsonFile },
			outputFile: evidence.outFile,
			outputLines: { total: filtered.all.length, shown: filtered.all.length },
		};
	}

	// 删掉的只剩认得出的平台日志和折进上面那条说明的异常栈（S37 2-A.1），
	// 不再附「完整输出 N 行 → 文件；换过滤条件读它」：要完整日志就 raw，
	// 被预算裁掉的那段由 agent 边界说明怎么按条件取回（S37 2-A.2）。
	notes.push(...summarizeRuntimeExceptions(filtered.exceptions, filtered.dropped, seenBefore));
	const body =
		filtered.lines.join("\n") ||
		(evidence.records.length > 0 ? "(探针只走了 JSON 旁路，没有人读输出)" : "(探针没有输出，用 raw 看完整日志)");
	return {
		...base,
		...(options.preparation?.plan?.api === null || options.preparation?.plan?.api === undefined
			? {}
			: { apiPrecheck: options.preparation.plan.api }),
		...(card === undefined ? {} : { usage: card }),
		output: body,
		notes,
		json: { records: evidence.records, broken: evidence.broken, file: evidence.jsonFile },
		outputFile: evidence.outFile,
		outputLines: { total: filtered.all.length, shown: filtered.lines.length },
	};
}

/** 本工程源码顶层包名来自各代码模块的 src/main/java 下一层目录；按包名拼路径直接看文件在不在，不扫整个工程。 */
function classLocator(ctx: KernelContext): OwnClassLocator {
	const fs = ctx.ports.fs;
	const srcs = ctx.layout.moduleDirs.map((dir) => dir.src).filter((src) => fs.exists(src));
	const roots = [
		...new Set(
			srcs.flatMap((src) =>
				fs
					.readDir(src)
					.filter((e) => e.isDirectory)
					.map((e) => e.name),
			),
		),
	];
	return {
		roots,
		locate: (fqcn) => {
			for (const src of srcs) {
				const path = resolve(src, `${fqcn.split(".").join("/")}.java`);
				if (fs.exists(path)) return relative(ctx.projectRoot, path).split("\\").join("/");
			}
			return null;
		},
	};
}

/**
 * 临时探针自己断言的结果不算交付证据（S24 批 C4）。
 *
 * 临时探针是 AI 自己写的，想断言什么都行，所以交付检查继续不认它（和 S22 的判据一致）。
 * 但 09-17 真机那次探针打出 11 条 PASS，AI 以为能交付了，到交付检查才被拒——
 * 这句话要在它看到 PASS 的同一屏里说，而不是等到 finish。
 */
export const AD_HOC_ASSERT_NOTE = "这些断言是临时探针自己判的，不算验过；要验过用 cosmic_run 带 --expect 跑。";

/**
 * 平台派发后台任务时调度服务没起（S37 2-E.4）。
 *
 * 提交本身照样成功、单据状态照样变，平台只在日志里打一条异常：任务派不出去。
 * 这条异常每次提交都带，折成「老面孔」后，读结果的人只看到「提交成功」。
 *
 * 任务没丢：它留在库里，锁到期后由环境的调度重派（S76）。原来这句说「没有发起工作流」「加 --schedule 重跑」——
 * 环境接手后流程照样可能发起；已经落库的提交也重跑不了。发起审批流的那条卡着时单据怎样，
 * 由落库那一行后面的「流程：」行照实说（WfState），这里只说派不出去和怎么让它在本机当场执行。
 */
const SCHEDULE_STOPPED = /SCHEDULE_SERVER_STOPED|调度服务已停止/;
export const SCHEDULE_STOPPED_NOTE =
	"平台报「调度服务已停止」：本机没起调度，这次建的后台任务没派出去，留在库里等环境的调度接手。要在本机当场执行，下一次 run op / form / call 带 --schedule。";

/** 输出里有没有断言：JSON 旁路里的 assert 记录，或者人读输出里的 PASS / FAIL / ✔ / ✘。 */
function hasAssertions(records: readonly ProbeJsonRecord[], lines: readonly string[]): boolean {
	if (records.some((record) => record.t === "assert")) return true;
	return lines.some((line) => /\b(?:PASS|FAIL)\b|[✔✘]|断言/.test(line));
}

/**
 * 「这个问题已经问出确定答案了」的拒绝。
 *
 * 拒绝而不是只提醒一句：提醒改变不了什么——真机上同一个探针连着问了三遍，
 * 三遍输出一模一样，中间没有编译、没有写入。第三遍花的是一次冷启动的机时，
 * 买回来的是已经拿到手的那张纸。这里把它挡在 JVM 启动之前。
 *
 * 拒绝里必须带上**上次的答案在哪**，否则拦下来只是换一种卡住：
 * 读那个文件跟重跑一次拿到的是同一份原文，而且不要 45 秒。
 */
function alreadyAsked(cls: string, entry: RepeatEntry): KernelError {
	return new KernelError("PROBE_ANSWER_SETTLED", `同样的调用已经跑过 ${entry.calls} 次，输出一字不差：${cls}`, {
		detail: { probe: cls, calls: entry.calls, firstAt: entry.firstAt, lastAt: entry.lastAt, outFile: entry.outFile },
		remedy:
			`上一次的完整原文在 ${entry.outFile}，直接读它，别重跑。` +
			"答案要变，得先让被问的东西变：改完代码跑一次 cosmic_fast、或者换一个真正不同的问题。" +
			"两样都不是的话，这个结论就已经定了——把它当成结论写进交付（验不了的那部分照实说验不了），然后往下走。",
	});
}

/**
 * `coldFallback: false` 时的拒绝。
 *
 * 带上 notes 而不是只说一句「常驻不可用」：那几行记的正是常驻为什么用不上
 * （没在跑 / 归属认不出 / BUSY / STALE），而这是调用方唯一能据以决定下一步的东西。
 */
function residentOnlyRefusal(ctx: KernelContext, cls: string, notes: readonly string[]): KernelError {
	return new KernelError("PROBE_RESIDENT_UNAVAILABLE", `常驻 JVM 用不上，${cls} 这次不跑冷进程`, {
		detail: { probe: cls, port: residentPort(ctx), notes: [...notes] },
		remedy:
			"冷进程会占住界面几十秒，所以这条路上不自动走。要结果就显式跑一次探针（走冷进程），或先 cosmic_runtime action=probe-start 把常驻拉起来。",
	});
}

function scheduleColdRefusal(ctx: KernelContext, cls: string, why: string, notes: readonly string[] = []): KernelError {
	return new KernelError("PROBE_RESIDENT_UNAVAILABLE", `${cls} 要起调度服务，这次却要走冷进程（${why}），没跑`, {
		detail: { probe: cls, port: residentPort(ctx), notes: [...notes] },
		remedy:
			"调度服务只在常驻 JVM 里起：冷进程跑完就退，派出去的后台任务没人接。先 cosmic_runtime action=probe-start 把常驻拉起来再跑；要冷进程就去掉 --schedule。",
	});
}

/**
 * Which freshness lane this run is judged in.
 *
 * Released probes are judged by declaration (`policy/probe-freshness.ts`): they
 * load their business classes dynamically, by a name that comes out of metadata
 * at run time, so no amount of reading their source would find the dependency.
 *
 * An ad-hoc probe is judged by its source, which for that kind of probe is the
 * complete answer -- `scanAdHocProbe` has already refused reflection, dynamic
 * class loading, subprocesses and `OperationServiceHelper`, leaving no way to
 * reach a project class without naming it. It is matched against the packages
 * that are stale RIGHT NOW rather than every business package: a throwaway
 * `DB.query` to look at data should not be held up by a form plugin someone
 * left half-edited in another module.
 *
 * The failure directions are both closed: a scan that throws, and a stale file
 * whose package cannot be derived, both fall to `business`.
 */
function freshnessLane(
	ctx: KernelContext,
	cls: string,
	adHoc: boolean,
	sourceText: string,
	options: ProbeOptions,
): FreshnessLane {
	if (options.strictFreshness === true) return "business";
	if (!adHoc) return releasedLane(cls, options.env ?? {});
	try {
		const stale = stalePackages(ctx, staleSources(ctx));
		if (stale.unnamed) return "business";
		return adHocLane(sourceText, stale.packages);
	} catch {
		return "business";
	}
}

export async function probe(
	ctx: KernelContext,
	name = "TemplateProbe",
	options: ProbeOptions = {},
): Promise<KernelResult<ProbeOutcome>> {
	const { preparation: suppliedPreparation, ...invocationOptions } = options;
	const prepared =
		suppliedPreparation === undefined
			? prepareProbeInvocation(ctx, name, invocationOptions)
			: ok(suppliedPreparation);
	if (!prepared.ok) return err(prepared.error);
	const planned = prepared.value.plan;
	if (planned === null) return err(preparationError(prepared.value));
	if (ctx.ports.fs.read(planned.target.src) !== planned.sourceText) {
		return err(
			new KernelError("PROBE_PRECHECK_STALE", `探针源码在 prepare 后发生变化：${planned.target.src}`, {
				detail: { probe: planned.target.cls, expectedDigest: planned.sourceDigest },
				remedy: "重新调用 cosmic_probe，会针对新源码重做一次完整预检。",
			}),
		);
	}
	if (prepared.value.blockers.length > 0) return err(preparationError(prepared.value));
	const { src, cls, adHoc } = planned.target;
	const sourceText = planned.sourceText;
	const overlay = planned.overlay;

	const gate = await staleGate(ctx, options.hooks ?? {}, freshnessLane(ctx, cls, adHoc, sourceText, options), {
		cls,
		adHoc,
		strict: options.strictFreshness === true,
	});
	if (!gate.ok) return err(gate.error);
	// 启动类改过就先编它、标常驻重起：每个探针进程照它连环境。连的环境变了，之前问出来的答案也跟着作废。
	const launch = await refreshLaunchClasses(ctx);
	if (!launch.ok) return err(launch.error);
	if (launch.value !== null) forgetRepeats(ctx);

	const applying = overlay.APPLY === "1";
	const mayWrite = applying || options.mayCommit === true;
	const dataWriter = !adHoc && isDataWriter(cls);
	// 写元数据才要用户授权、才固定冷进程。造数据、改数据落库（S27，用户 2026-09-19 定：测试环境）
	// 不用授权，在常驻进程里走平台保存，和运行的真提交一样。
	const applyingMetadata = applying && !dataWriter;
	// 造数据（S21）、改数据（S23）的 dry-run 是回滚事务里把保存 / 操作链跑一遍：
	// 事务回滚了，常驻 JVM 里的各级缓存没回滚，所以仍然冷进程、取工程写锁。
	// FormRuleProbe 的 ROLLBACK 是保存删除后的布局，不是回滚数据库事务。
	const rollingBack = (overlay.ROLLBACK === "1" && cls !== "FormRuleProbe") || (dataWriter && !applying);
	// 写元数据的 APPLY 不再固定冷进程（S27 1.14，2026-09-19 真机）：本地调试是轻量级部署，每个 JVM 的
	// 「Redis」都是自己内存里的一份，平台保存时清的是写入那个进程自己的各层缓存。冷进程写、常驻读，
	// 常驻那份永远是旧的（15 分钟的版本复查问的也是它，不会自愈）；常驻进程自己写，写完同一进程马上读到新的，
	// 和在本机 IDEA 起的苍穹里用开发平台改元数据是一回事。显式 --cold 仍走冷进程，写完标记常驻过期。
	const coldReason = rollingBack
		? overlay.ROLLBACK === "1"
			? "ROLLBACK=1"
			: "写数据预演（回滚事务）"
		: options.cold === true
			? "--cold"
			: null;
	// Only a metadata APPLY goes through the target gate: ROLLBACK=1 is a rollback
	// transaction, --cold is just a different path, and a data write (S27) needs no grant.
	const targets = writeTargetProps(ctx, options, cls, applyingMetadata);
	if (!targets.ok) return err(targets.error);
	const schedule = options.schedule === true;
	if (schedule && coldReason !== null) return err(scheduleColdRefusal(ctx, cls, coldReason));
	const writeProps = schedule ? [...targets.value.props, "-Dcosmic.schedule=1"] : targets.value.props;
	const targetNotes = [...(launch.value === null ? [] : [launch.value.note]), ...targets.value.notes];
	// 冷进程写了元数据，常驻那份就过期了：下次用它之前先重起。退出码非 0 也标：可能已写了一半；
	// 只有写之前就被门禁拦下的（打了「未落库」）不标。
	const afterColdWrite = (run: KernelResult<{ exitCode: number; output: string }>) => {
		if (applyingMetadata && !(run.ok && isBlockedWrite({ cls, output: run.value.output }))) {
			markServerStale(ctx, `写了元数据（${cls}）`);
			markMetaPending(ctx, cls, options.writeAuthorization?.targets ?? []);
		}
	};

	// 写入不记重复账，也不受它拦：APPLY 每跑一次世界就不一样了，
	// 「上次输出跟这次一样」对它根本不是一个有意义的判据。而且一旦写了元数据，
	// 之前问出来的那些答案全部作废——所以这里顺手把整本账清掉。
	if (applying) forgetRepeats(ctx);
	const repeat: RepeatKey | null =
		applying || options.countRepeats === false ? null : { cls, sourceDigest: planned.sourceDigest, env: overlay };
	if (repeat !== null) {
		const asked = repeatBlocked(ctx, repeat);
		if (asked !== null) return err(alreadyAsked(cls, asked));
	}

	if (coldReason !== null) {
		const execute = async (): Promise<KernelResult<ProbeOutcome>> => {
			const run = await coldProbe(ctx, src, cls, overlay, writeProps, options.onProgress);
			afterColdWrite(run);
			if (!run.ok) return err(run.error);
			return ok(
				complete(
					ctx,
					options,
					{
						probe: cls,
						src,
						path: "cold",
						coldReason,
						exitCode: run.value.exitCode,
						output: run.value.output,
						stale: gate.value,
						notes: [...prepared.value.warnings, ...targetNotes],
					},
					repeat,
					sourceText,
					adHoc,
				),
			);
		};
		if (applying || rollingBack) return withProjectWriteLock(ctx, `probe:${cls}`, execute);
		return execute();
	}

	const hot = async (): Promise<KernelResult<ProbeOutcome>> => {
		const notes: string[] = [...prepared.value.warnings, ...targetNotes];
		const send = async () => {
			options.onProgress?.("running-probe");
			return sendProbe(ctx, {
				src,
				cls,
				env: overlay,
				...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
				...(writeProps.length === 0 ? {} : { props: writeProps }),
			});
		};
		const fallBackCold = async (coldReason: string): Promise<KernelResult<ProbeOutcome>> => {
			if (options.coldFallback === false) return err(residentOnlyRefusal(ctx, cls, notes));
			if (schedule) return err(scheduleColdRefusal(ctx, cls, coldReason, notes));
			const run = await coldProbe(ctx, src, cls, overlay, writeProps, options.onProgress);
			afterColdWrite(run);
			if (!run.ok) return err(run.error);
			return ok(
				complete(
					ctx,
					options,
					{
						probe: cls,
						src,
						path: "cold",
						coldReason,
						exitCode: run.value.exitCode,
						output: run.value.output,
						stale: gate.value,
						notes,
					},
					repeat,
					sourceText,
					adHoc,
				),
			);
		};
		options.onProgress?.("checking-resident");
		// 落库的请求发出去就收不回来，所以「认不出归属 / 身份不对」要在发之前查：下面那两道检查
		// 是发完再看，对只读探针无所谓（重问一遍就是了），对写入就是写到别人的 JVM 上、或者用旧账套写一遍、
		// 再换个进程写第二遍。
		if (mayWrite) {
			const identity = staleServerIdentity(ctx, readManifest(ctx));
			if (identity !== null) {
				notes.push(`常驻 JVM 是用另一套身份起的（${identity}）→ 写之前先停掉重起`);
				await stopServer(ctx);
			} else if ((await ping(ctx)).ok && !isOwnLiveServer(ctx, readManifest(ctx))) {
				notes.push(
					`端口 ${residentPort(ctx)} 上有 JVM 应答，但没有本 RuntimeKey 的 pid 记录，认不出归属 → 写入走冷进程`,
				);
				return fallBackCold("常驻 JVM 归属存疑");
			}
		}
		// **The deferred restart is paid here, before the first request goes out.**
		// `fast` marks the JVM instead of restarting it, so this is the point where
		// "the classes under it changed" turns back into a JVM that has them. Any other
		// order -- probing first and restarting after -- is the exact silent-wrong-answer
		// this whole path exists to prevent, so nothing may be sent above this line.
		const staleClasses = takeServerStale(ctx);
		if (staleClasses !== null) {
			// 只是业务类重编过：先试热替换（S27 3.1），几百毫秒；换不进去（结构变了）再重起。
			// 元数据、身份那类旧了换类解决不了，照旧重起。
			const synced = staleClasses.classesOnly ? await syncClasses(ctx) : null;
			if (synced?.ok) {
				notes.push(`常驻 JVM 里的类旧了（${staleClasses.reason}）→ ${describeSync(synced.value)}，没重起`);
			} else {
				await stopServer(ctx);
				const refreshed = await startServer(ctx, options.onProgress);
				const why = synced === null ? "" : `，热替换不了：${synced.why}`;
				notes.push(
					refreshed.ok
						? `常驻 JVM 里的类或元数据已过期（${staleClasses.reason}${why}）→ 已重起`
						: `常驻 JVM 需要重起（${staleClasses.reason}${why}）但没起来：${refreshed.error.message} → 走冷进程`,
				);
				if (refreshed.ok && refreshed.value.hotSwapWarning) notes.push(refreshed.value.hotSwapWarning);
			}
		}
		let reply = await send();
		// Something answering on this RuntimeKey's port is not proof it is ours. A JVM
		// started for a different runtime replies with an equally well-formed RESULT
		// line while running against different Cosmic JARs, and the answer would be
		// wrong with nothing to show for it. Ownership has to be proved by a pid
		// manifest naming this key; when it cannot be, the cold path is used, because
		// cold always compiles and runs against this context's own classpath.
		// 归属对得上、身份对不上：常驻宿主在启动时就把 RequestContext（租户/账套/用户）建死了，
		// 之后改 config.json 一个字都到不了它。继续用它就是拿旧账套读元数据、把写入的修改人
		// 记在旧用户头上——两件都不会报错。所以停掉重起，而不是降级冷进程：降级只是这一次对了，
		// 那个身份不对的 JVM 还在端口上，下一次照样等着被复用。
		const stale = staleServerIdentity(ctx, readManifest(ctx));
		if (reply.ok && stale !== null) {
			notes.push(`常驻 JVM 是用另一套身份起的（${stale}）→ 停掉重起`);
			await stopServer(ctx);
			const restarted = await startServer(ctx, options.onProgress);
			reply = restarted.ok ? await send() : { ok: false, error: restarted.error };
		}
		if (reply.ok && reply.value.status === "BUSY") {
			// 宿主只在上一次执行超时后返回 BUSY：本次尚未执行，换掉失效宿主再发本次请求。
			// 不在 TIMEOUT / ERR 那次重发：它可能已落库，而且超时的线程可能还在跑。
			if (options.startResident === false) return err(residentOnlyRefusal(ctx, cls, [...notes, reply.value.body]));
			notes.push(
				`上一次执行超时，常驻 JVM 已拒绝本次请求（${reply.value.body.trim()}）；先更换常驻进程，再执行本次请求，上一次操作不重跑`,
			);
			const restarted = await recoverTimedOutServer(ctx, options.onProgress);
			if (!restarted.ok) return err(restarted.error);
			reply = await send();
			if (reply.ok && reply.value.status === "BUSY") return err(residentOnlyRefusal(ctx, cls, notes));
		}
		// 登记对不上先问一次端口：答话的进程报的是本版本，登记就照它补回来，不为一份丢了的登记另起冷进程。
		if (reply.ok && !isOwnLiveServer(ctx, readManifest(ctx)) && !(await ownsAnswering(ctx))) {
			notes.push(`端口 ${residentPort(ctx)} 上有 JVM 应答，但没有本 RuntimeKey 的 pid 记录，认不出归属 → 走冷进程`);
			return fallBackCold("常驻 JVM 归属存疑");
		}
		if (!reply.ok && isNotRunning(reply.error) && options.startResident === false) {
			return err(residentOnlyRefusal(ctx, cls, notes));
		}
		if (!reply.ok && isNotRunning(reply.error)) {
			notes.push(
				"常驻 JVM 没在跑，正在拉起：拉起约 30 秒，之后第一次运行还要加载单据和插件，再多半分钟左右；只付这一次，后面搭它的每次几秒到十几秒",
			);
			const started = await startServer(ctx, options.onProgress);
			if (started.ok) reply = await send();
		}
		if (reply.ok && reply.value.status === "STALE") {
			// STALE only proves the class-directory stamp changed. Deletion in this
			// session also reaches here without a fast marker; it identifies no author.
			// STALE 是宿主在跑之前就拦下的，什么都没执行，换完类重发一遍是安全的（写入也一样）。
			const change = "磁盘 class 与常驻快照不一致（可能新增、修改或删除）；未记录变更来源，无法判断由谁操作";
			const synced = await syncClasses(ctx);
			if (synced.ok) {
				notes.push(`常驻 JVM 里的类已过期（${change}）→ ${describeSync(synced.value)}，没重起`);
				reply = await send();
			} else {
				notes.push(`常驻 JVM 里的类已过期，热替换不了（${synced.why}），正在重启（${change}）`);
				await stopServer(ctx);
				const started = await startServer(ctx, options.onProgress);
				if (started.ok) reply = await send();
			}
		}

		// BUSY / STALE 和连不上都是「没执行」；超时、半截断开就不是——写入可能已经跑了一部分，
		// 再冷进程跑一遍就是写两次。
		if (mayWrite && !reply.ok && !isNotRunning(reply.error)) {
			if (applyingMetadata) {
				markServerStale(ctx, `写元数据没回话（${cls}）`);
				markMetaPending(ctx, cls, options.writeAuthorization?.targets ?? []);
			}
			return err(
				new KernelError(
					"PROBE_WRITE_UNCERTAIN",
					`${cls} 写入请求发给常驻 JVM 后没收到完整答复：${reply.error.message}`,
					{
						detail: { probe: cls },
						remedy: "写入可能已执行一部分，没有自动重跑。先用只读探针查清现状，再决定要不要重跑。",
					},
				),
			);
		}
		if (!reply.ok || reply.value.status === "BUSY" || reply.value.status === "STALE") {
			notes.push(
				reply.ok ? `常驻 ${reply.value.status}，降级冷进程` : `常驻不可用（${reply.error.message}），降级冷进程`,
			);
			return fallBackCold("常驻不可用");
		}

		const response: ProbeResponse = reply.value;
		if (response.status === "TIMEOUT") {
			notes.push(
				"本次执行已超时，可能仍在执行或已落库，没有自动重跑；下一次调用会先更换常驻进程。先只读核对现状，再决定是否重新操作。",
			);
		}
		// 元数据写了（或可能写了一半）：代码关系表的元数据快照落后了，当场记下（S17 4.6）。
		if (applyingMetadata && !isBlockedWrite({ cls, output: response.body })) {
			markMetaPending(ctx, cls, options.writeAuthorization?.targets ?? []);
		}
		if (response.status === "COMPILE_FAIL") {
			return err(
				new KernelError("COMPILE_FAILED", `探针 ${cls} 在常驻 JVM 里编译失败`, {
					detail: { probe: cls, raw: response.body.trim().slice(0, 8000) },
					remedy: "按下面的 javac 原文改探针源码。",
				}),
			);
		}
		// 写到一半抛了异常：平台那几层缓存清没清全说不准，下次用之前重起。
		// 写之前就被门禁拦下的（打了「未落库」）一个字节没动，不用白付这 30 秒。
		if (
			applyingMetadata &&
			(response.status !== "OK" || response.exitCode !== 0) &&
			!isBlockedWrite({ cls, output: response.body })
		) {
			markServerStale(ctx, `写元数据没跑完（${cls}）`);
		}

		return ok(
			complete(
				ctx,
				options,
				{
					probe: cls,
					src,
					path: "hot",
					coldReason: null,
					exitCode: response.exitCode,
					output: response.body,
					stale: gate.value,
					notes,
				},
				repeat,
				sourceText,
				adHoc,
			),
		);
	};
	if (applyingMetadata) return withProjectWriteLock(ctx, `probe:${cls}`, hot);
	return hot();
}
