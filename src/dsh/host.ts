/**
 * 所有工具共用的那一层：找到这次调用属于哪个会话、打开工程、记失败、查编译新鲜度、
 * 裁输出并记下来供 `raw` 取回、交付知识卡片。
 *
 * 工具只管自己那件事；凡是「每个工具都要做一遍」的，都在这里做一次。
 */

import { readFileSync, statSync } from "node:fs";
import type { CosmicToolName } from "../agent/tools/names.ts";
import { budgetOutput, outlineText, pickableRemedy, pickFromRun } from "../agent/tools/output-budget.ts";
import { FACTS_RECORD_TYPES, INDEX_RECORD_TYPES } from "../agent/tools/record-budget.ts";
import { comparablePath } from "../agent/tools/tool-path.ts";
import { KernelError, type KernelResult } from "../kernel/errors.ts";
import { changedSourceSections, sameFreshness } from "../kernel/freshness.ts";
import { isAdHocProbeFile } from "../kernel/layout.ts";
import type { ProbeJsonRecord } from "../kernel/probe/output.ts";
import {
	condenseProbeApiCapsules,
	type KnowledgeCapsule,
	probeApiClassOf,
	probeApiLinesOf,
	selectKnowledgeCapsules,
} from "../knowledge/capsule.ts";
import { referenceSourceResolver } from "../knowledge/reference.ts";
import { type CosmicKernel, cosmicKernel, type ProjectHandle } from "./kernel.ts";
import type { AskProdConsent } from "./prod-setup.ts";
import { type AgentFailure, CosmicToolFailure, refused } from "./result.ts";
import { type CosmicSession, type OpenedProject, type RememberedOutput, SessionStore } from "./session.ts";
import { type Ask, configureInCall } from "./setup.ts";
import { failureSubject, inputDigest, nextFailureStreak, streakRefusal } from "./streak.ts";

export const AGENT_GATE_CODE = "COSMIC_AGENT_GATE";
export const RUNTIME_CHANGED_CODE = "COSMIC_RUNTIME_CHANGED";
export const FRESHNESS_CHANGED_CODE = "COSMIC_FRESHNESS_CHANGED";

/** 每个工具的结果里，按上下文预算裁的那个正文字段。结构化字段本来就有界，不裁。 */
export const BUDGETED_FIELD: Partial<Record<CosmicToolName, string>> = {
	cosmic_probe: "output",
	cosmic_run: "output",
	cosmic_lint: "raw",
	cosmic_meta: "text",
	cosmic_runtime: "log",
	cosmic_doctor: "text",
	cosmic_impact: "text",
	cosmic_prod: "text",
};

/** 按条件取回最多记几次调用的输出：够回头取前面十几次的，又不让内存跟着会话一直涨。 */
const PICK_KEEP = 20;
/** 完整日志超过这么大就不读回来。 */
const FULL_LOG_MAX_BYTES = 16 * 1024 * 1024;

/** 一次工具调用：哪个工具、哪个会话、dsh 给的执行上下文、什么时候发出的。 */
export interface CallContext {
	tool: CosmicToolName;
	session: CosmicSession<ProjectHandle>;
	/** dsh 的会话对象；没有会话的调用为 undefined。 */
	agent: object | undefined;
	signal: AbortSignal;
	startedAt: string;
	/** 会话工作目录。 */
	cwd: () => Promise<string>;
}

export function now(): string {
	return new Date().toISOString();
}

/** 「同一调用」的键：工具名加去掉 raw、cold 的参数；空数组、空对象和没给是一回事。 */
export function pickKeyOf(tool: CosmicToolName, params: object): string {
	const rest = Object.fromEntries(
		Object.entries(params).filter(
			([key, value]) =>
				key !== "raw" &&
				key !== "cold" &&
				value !== undefined &&
				!(Array.isArray(value) && value.length === 0) &&
				!(typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 0),
		),
	);
	return `${tool} ${inputDigest(rest)}`;
}

/** `raw` 写成字符串 "true" / "false" 按布尔算：没有谁写字符串 "true" 是想找含 true 的行。 */
export function rawAsFlag<T>(params: T): T {
	if (typeof params !== "object" || params === null) return params;
	const raw = (params as { raw?: unknown }).raw;
	if (typeof raw !== "string") return params;
	const flag = raw.trim().toLowerCase();
	return flag === "true" || flag === "false" ? { ...params, raw: flag === "true" } : params;
}

function stampLog(file: unknown): RememberedOutput["log"] {
	if (typeof file !== "string" || file === "") return null;
	try {
		const stat = statSync(file);
		return { file, size: stat.size, mtimeMs: stat.mtimeMs };
	} catch {
		return null;
	}
}

/** 读回一次运行落盘的完整日志；文件没了、被后来的运行盖掉了、太大，都返回 null。 */
function readFullLog(log: NonNullable<RememberedOutput["log"]>): string | null {
	try {
		const stat = statSync(log.file);
		if (stat.size !== log.size || stat.mtimeMs !== log.mtimeMs || stat.size > FULL_LOG_MAX_BYTES) return null;
		return readFileSync(log.file, "utf8")
			.replace(/\r\n/g, "\n")
			.replace(/^# [^\n]*\n# [^\n]*\n/, "")
			.replace(/\n$/, "");
	} catch {
		return null;
	}
}

/** 没有 raw 取回的工具（影响面、体检、lint、节点日志）：指向落盘文件，附省略段的目录。 */
export function fileRemedy(text: string, outputFile: string, budget: ReturnType<typeof budgetOutput>): string {
	const contents =
		budget.omittedFrom === null || budget.omittedTo === null
			? ""
			: outlineText(text, outputFile, budget.omittedFrom, budget.omittedTo);
	return contents === ""
		? `全文在 ${outputFile}；要看省略段就窄条件 grep 它，不要把整份取回上下文。`
		: `全文在 ${outputFile}（共 ${String(budget.totalLines)} 行）。${contents}
整份取回上下文没有必要。`;
}

function fullLogOf(entry: RememberedOutput): string | null {
	if (entry.full) return entry.text;
	return entry.log === null ? null : readFullLog(entry.log);
}

/** `2026-10-10T07:17:25.827Z` → 本机时间 `15:17:25`：告诉模型取回的是哪一次运行。 */
function ranAt(at: string): string {
	const time = new Date(at);
	return Number.isNaN(time.getTime()) ? at : time.toLocaleTimeString("zh-CN", { hour12: false });
}

/** raw 能取的那份 = 文字 + 结构化记录，记录一条一行排在文字后面，文字的行号不变。 */
function withPickableRecords(text: string, result: Record<string, unknown>): string {
	const carrier = typeof result.probe === "object" && result.probe !== null ? result.probe : result;
	const json = (carrier as { json?: { records?: unknown } }).json;
	const records = Array.isArray(json?.records) ? (json.records as ProbeJsonRecord[]) : [];
	const lines = records
		.filter((r) => {
			const type = typeof r.t === "string" ? r.t : "";
			return !INDEX_RECORD_TYPES.has(type) && !FACTS_RECORD_TYPES.has(type);
		})
		.map((r) => `[PROBE-JSON] ${JSON.stringify(r)}`);
	return lines.length === 0 ? text : `${text.replace(/\n$/, "")}\n${lines.join("\n")}`;
}

export class CosmicHost {
	readonly kernel: CosmicKernel;
	readonly sessions = new SessionStore<ProjectHandle>();
	/** 加载 reference 技能时释放出来的文档目录，知识卡片的出处换成能 read 的路径时用。 */
	referenceDocsDir: string | undefined;

	/**
	 * 工具执行中问人（配置向导用），`header` 是确认单的标题；宿主没有提问服务（无头运行）时给 undefined。
	 * 插件入口装上；不装就不弹向导，配置不全照实报错。
	 */
	askInCall: ((call: CallContext, header: string) => Ask | undefined) | undefined;

	/** 工具执行中问人「这个会话能不能查生产」；插件入口装上，没装就不问（见 prod-setup.ts 的 `ensureProdConsent`）。 */
	askProdConsent: ((call: CallContext) => AskProdConsent) | undefined;

	constructor(kernel?: CosmicKernel) {
		this.kernel = kernel ?? cosmicKernel();
	}

	// ------------------------------------------------------------ 成败记账

	/** 门槛或内核拒绝：记进失败计数，返回要抛的错。 */
	fail(call: CallContext, failure: AgentFailure, input: unknown, blocks: readonly string[] = []): CosmicToolFailure {
		this.countFailure(call, failure.code, input);
		return refused(failure, blocks);
	}

	/** 跑了但没成：正文照成功时排，记进失败计数，返回要抛的错。 */
	ranFailed(call: CallContext, code: string, blocks: readonly string[], input: unknown): CosmicToolFailure {
		this.countFailure(call, code, input);
		return new CosmicToolFailure(code, blocks.join("\n\n"));
	}

	private countFailure(call: CallContext, code: string, input: unknown): void {
		call.session.streak = nextFailureStreak(
			call.session.streak,
			{
				tool: call.tool,
				ok: false,
				at: now(),
				code,
				digest: inputDigest(input),
				subject: failureSubject(call.tool, input),
				startedAt: call.startedAt,
			},
			call.session.factsRevision,
		);
	}

	/** 成功清空失败计数。 */
	succeeded(call: CallContext): void {
		call.session.streak = undefined;
	}

	/** 执行前：重复失败门槛。 */
	checkRepeat(call: CallContext, input: unknown): void {
		const refusal = streakRefusal(call.session.streak, call.session.factsRevision, call.tool, input);
		if (refusal !== null) throw refused(refusal);
	}

	/** 内核结果的失败那一半，统一成 AgentFailure。 */
	kernelError<T>(result: KernelResult<T>): AgentFailure | undefined {
		if (result.ok) return undefined;
		return result.error.toJSON() as AgentFailure;
	}

	/** 内核失败就记账并抛出；成功返回值。 */
	unwrap<T>(call: CallContext, result: KernelResult<T>, input: unknown): T {
		if (result.ok) return result.value;
		throw this.fail(call, result.error.toJSON() as AgentFailure, input);
	}

	// ------------------------------------------------------------ 工程

	/**
	 * 打开会话工作目录里的工程（已经打开就重开一次，拿最新的运行时身份）。
	 *
	 * 不要求模型先调 cosmic_open_project：dsh 的会话自带工作目录，要工程的工具第一次用到时就打开它。
	 * 运行时身份（RuntimeKey）在两次调用之间变了，之前的编译和验证都是对着旧运行时做的，
	 * 这次拒掉并清掉它们，下一次调用按新的运行时重新开始。
	 */
	async project(call: CallContext, input: unknown): Promise<OpenedProject<ProjectHandle>> {
		const session = call.session;
		const known = session.project;
		const root = known?.root ?? (await call.cwd());
		const sessionId = session.id === undefined ? {} : { sessionId: session.id };
		let result = await this.kernel.open(root, { rescanRuntime: known === undefined, ...sessionId });
		if (!result.ok && result.error.code === "CONFIG_INCOMPLETE")
			result = await this.configureThenOpen(call, root, result);
		const opened = this.unwrap(call, result, input);
		const summary = opened.summary;
		if (known !== undefined && summary.runtimeKeyId !== known.runtimeKeyId) {
			session.project = undefined;
			session.freshness = undefined;
			session.compiledAt = undefined;
			throw this.fail(
				call,
				{
					code: RUNTIME_CHANGED_CODE,
					message: "工程运行时身份已变化，之前的编译和验证全部作废",
					detail: { previousRuntimeKeyId: known.runtimeKeyId, currentRuntimeKeyId: summary.runtimeKeyId },
					remedy: "重新执行这次调用即可（会按新的运行时打开工程）；之前跑过的验证要重新跑。",
				},
				input,
			);
		}
		const project: OpenedProject<ProjectHandle> = {
			root: summary.root,
			runtimeKeyId: summary.runtimeKeyId,
			handle: opened.handle,
			summary,
		};
		session.project = project;
		return project;
	}

	/**
	 * 配置不全：缺的是工程文件里认得出来的项（启动类、模块……），原样把内核的报错交给模型——
	 * 补救里写着让它读工程文件、用 cosmic_doctor action=config 补，不来问人。
	 * 只缺账套、用户时，在这次调用里弹工程配置向导让人选，选好了接着打开。人不填了（或本会话早先不填过），
	 * 照实返回配置不全，补救改成请用户敲 /cosmic-env——这两项模型猜不出来。
	 * 没有提问服务（无头运行）时原样返回内核的报错。
	 */
	private async configureThenOpen(
		call: CallContext,
		root: string,
		failed: Extract<Awaited<ReturnType<CosmicKernel["open"]>>, { ok: false }>,
	): Promise<Awaited<ReturnType<CosmicKernel["open"]>>> {
		const fromProject = (failed.error.detail as { fromProject?: unknown } | undefined)?.fromProject;
		if (Array.isArray(fromProject) && fromProject.length > 0) return failed;
		const ask = this.askInCall?.(call, "工程配置");
		if (ask === undefined) return failed;
		const setup = await configureInCall(this.kernel, call.session.setupPrompt, ask, root, call.signal);
		if (setup?.kind === "ready")
			return this.kernel.open(root, {
				rescanRuntime: true,
				...(call.session.id === undefined ? {} : { sessionId: call.session.id }),
			});
		return {
			ok: false,
			error: new KernelError(
				"CONFIG_INCOMPLETE",
				setup === null ? failed.error.message : `${failed.error.message}；${setup.text}`,
				{
					detail: failed.error.detail,
					remedy: "账套、用户只能由用户来选：请用户在会话里输入 /cosmic-env，按弹出的提示选好后再继续。",
				},
			),
		};
	}

	// ------------------------------------------------------------ 编译新鲜度

	/** 本会话改过的业务 Java（`.cosmic-ai/probes/` 下的临时探针不算）。 */
	sessionJava(session: CosmicSession): string[] {
		return [...session.files].filter((file) => file.toLowerCase().endsWith(".java") && !isAdHocProbeFile(file));
	}

	/** 过期源码分成「本会话改的」和「别处改的」：谁改的决定下一步去哪看。 */
	splitStale(session: CosmicSession, staleFiles: readonly string[]): { mine: string[]; others: string[] } {
		const touched = [...session.files].map(comparablePath);
		const mine: string[] = [];
		const others: string[] = [];
		for (const file of staleFiles) {
			const stale = comparablePath(file);
			const owned = touched.some(
				(seen) => seen === stale || seen.endsWith(`/${stale}`) || stale.endsWith(`/${seen}`),
			);
			(owned ? mine : others).push(file);
		}
		return { mine, others };
	}

	/**
	 * 要加载业务类的调用（cosmic_run、走业务档的已发布探针）只在源码和 class 指纹还和上次编译时一样才放行。
	 * 本会话既没编译过也没改过 Java（纯探查、纯元数据）时不查：没有「上次编译」可比，过期的源码是别人的。
	 */
	async requireFresh(call: CallContext, handle: ProjectHandle, input: unknown): Promise<void> {
		const session = call.session;
		if (session.freshness === undefined && session.compiledAt === undefined && this.sessionJava(session).length === 0)
			return;
		const current = this.unwrap(call, await this.kernel.freshness(handle), input);
		if (session.freshness !== undefined && sameFreshness(session.freshness, current)) return;
		const changedSections = changedSourceSections(session.freshness, current);
		const stale = this.splitStale(session, current.staleFiles);
		session.freshness = undefined;
		const foreign = stale.mine.length === 0 && stale.others.length > 0;
		throw this.fail(
			call,
			{
				code: FRESHNESS_CHANGED_CODE,
				message: foreign
					? `源码或 class 已在上次编译之后变化——${String(stale.others.length)} 个过期文件不是本会话改的`
					: "源码或 class 已在上次编译之后变化，要先重新编译",
				detail: {
					sourceCount: current.sourceCount,
					changedSections,
					staleFromThisSession: stale.mine,
					staleFromElsewhere: stale.others,
				},
				remedy: foreign
					? "先读 changedSections 列出的文件及行段并看 git diff，核对取数、赋值是否仍按需求执行；这些文件不是本会话改的，不能当成已理解的代码。确认后 cosmic_fast（不带 sources）再验证；写入结果未知时先查库，不要直接重跑。"
					: "先重读 changedSections 列出的文件及行段，核对代码变化；确认后 cosmic_fast，再验证。写入结果未知时先查库。",
			},
			input,
		);
	}

	// ------------------------------------------------------------ 输出预算与取回

	/** 正文字段按上下文预算裁，整份落盘；能用 raw 取回的工具记下整份供取回。 */
	async budget<T>(call: CallContext, handle: ProjectHandle, value: T, pickKey?: string): Promise<T> {
		const field = BUDGETED_FIELD[call.tool];
		if (field === undefined || typeof value !== "object" || value === null) return value;
		const record = value as Record<string, unknown>;
		const text = record[field];
		if (typeof text !== "string") return value;
		if (pickKey !== undefined) this.remember(call.session, pickKey, text, record);
		const budget = budgetOutput(text);
		if (!budget.truncated) return value;
		let outputFile: string | null = null;
		let spillError: string | null = null;
		if (this.kernel.spillOutput === undefined) {
			spillError = "当前内核适配器不提供落盘";
		} else {
			const written = await this.kernel.spillOutput(
				handle,
				`${call.tool}-${String(call.session.factsRevision)}`,
				text,
			);
			if (written.ok) outputFile = written.value.file;
			else spillError = `${written.error.code}: ${written.error.message}`;
		}
		const span = budget.omittedFrom !== null && budget.omittedTo !== null;
		// 能用 raw 取回的工具只讲省了什么、怎么取，不给文件路径——给了路径，模型就离开工具去 grep。
		const remedy =
			pickKey !== undefined && span
				? pickableRemedy(text, budget.omittedFrom as number, budget.omittedTo as number)
				: outputFile === null
					? `全文没能落盘（${spillError ?? "原因不明"}），省略的是第 ${String(budget.omittedFrom)}–${String(budget.omittedTo)} 行。`
					: fileRemedy(text, outputFile, budget);
		return {
			...record,
			[field]: budget.shown,
			outputBudget: {
				truncated: true,
				totalBytes: budget.totalBytes,
				totalLines: budget.totalLines,
				omittedLines: budget.omittedLines,
				omittedFrom: budget.omittedFrom,
				omittedTo: budget.omittedTo,
				...(pickKey !== undefined ? {} : { outputFile }),
				spillError,
				remedy,
			},
		} as T;
	}

	private remember(session: CosmicSession, key: string, text: string, result: Record<string, unknown>): void {
		const carrier = (typeof result.probe === "object" && result.probe !== null ? result.probe : result) as {
			outputFile?: unknown;
			outputLines?: { total?: unknown; shown?: unknown };
		};
		const { total, shown } = carrier.outputLines ?? {};
		const folded = typeof total === "number" && typeof shown === "number" && total > shown;
		session.outputs.delete(key);
		session.outputs.set(key, {
			text: withPickableRecords(text, result),
			full: !folded,
			log: folded ? stampLog(carrier.outputFile) : null,
			at: now(),
		});
		if (session.outputs.size > PICK_KEEP) session.outputs.delete(session.outputs.keys().next().value as string);
	}

	/** 这组参数在本会话里有没有存下的输出。 */
	hasOutput(call: CallContext, params: object): boolean {
		return call.session.outputs.has(pickKeyOf(call.tool, params));
	}

	/**
	 * `raw=true` 且这组参数已经跑过：给那一次的完整日志，不再执行（真提交的操作重跑就是把操作再做一遍）。
	 * 没跑过返回 undefined，照常执行。
	 */
	storedFullLog(call: CallContext, params: object): Record<string, unknown> | undefined {
		const entry = call.session.outputs.get(pickKeyOf(call.tool, params));
		if (entry === undefined) return undefined;
		const text = fullLogOf(entry);
		if (text === null) throw this.logGone(true);
		entry.text = text;
		entry.full = true;
		const budget = budgetOutput(text);
		const span = budget.omittedFrom !== null && budget.omittedTo !== null;
		return {
			action: "pick",
			raw: true,
			[BUDGETED_FIELD[call.tool] as string]: budget.shown,
			notes: [`这是 ${ranAt(entry.at)} 那次运行的完整日志（共 ${String(budget.totalLines)} 行），这次没有执行。`],
			...(budget.truncated
				? {
						outputBudget: {
							truncated: true,
							totalBytes: budget.totalBytes,
							totalLines: budget.totalLines,
							omittedLines: budget.omittedLines,
							omittedFrom: budget.omittedFrom,
							omittedTo: budget.omittedTo,
							spillError: null,
							remedy: span
								? pickableRemedy(text, budget.omittedFrom as number, budget.omittedTo as number)
								: '同一调用加 raw="关键字"（正则）取回，不重跑。',
						},
					}
				: {}),
		};
	}

	/**
	 * `raw` 写成行号或关键字：不开工程、不起进程，从同一调用上一次的输出里取。
	 * 不记账：取一次不能「解锁」被拦的工具，取不到也不算一次失败。
	 * `ran`：先跑再取时，跑的那一次结果里的交付说明、探针用法、知识卡片照带上。
	 */
	pick(call: CallContext, params: object, spec: string, ran?: Record<string, unknown>): Record<string, unknown> {
		const entry = call.session.outputs.get(pickKeyOf(call.tool, params));
		const field = BUDGETED_FIELD[call.tool] as string;
		if (entry === undefined) {
			throw refused({
				code: "OUTPUT_PICK_NONE",
				message: "这组参数在本次会话里还没有输出可取",
				detail: { raw: spec },
				remedy: "去掉 raw（或 raw=true）跑一次；raw 写行号或关键字时取的是参数完全相同的上一次调用的输出。",
			});
		}
		const picked = pickFromRun(entry.text, entry.full ? null : fullLogOf(entry), spec, entry.full);
		if (picked === null) throw this.logGone(spec);
		return {
			action: "pick",
			raw: spec,
			...(ran === undefined ? {} : { ran: true }),
			matched: picked.matched,
			[field]: picked.text,
			notes: picked.notes,
			...ran,
		};
	}

	private logGone(spec: string | true): CosmicToolFailure {
		return refused({
			code: "OUTPUT_PICK_NONE",
			message: "这组参数上一次运行的完整日志已经不在本机",
			detail: { raw: spec },
			remedy: "要完整日志就不带 raw 再执行一次（操作会真的再做一遍），然后带 raw 取。",
		});
	}

	/** 「这个探针是干什么的、还认哪些入参」一次会话只说一遍。 */
	withProbeUsage<T>(session: CosmicSession, value: T, keep: boolean): T {
		if (typeof value !== "object" || value === null) return value;
		const record = value as Record<string, unknown>;
		if (record.usage === undefined) return value;
		const cls = typeof record.probe === "string" ? record.probe : "";
		if (!keep || cls === "" || session.probesExplained.has(cls)) {
			const { usage: _usage, ...rest } = record;
			return rest as T;
		}
		session.probesExplained.add(cls);
		return value;
	}

	/** 写通道跑过的那一次，输出整份存一份——共享环境的写入最需要能二次核对。存不下来不影响这次调用。 */
	async archive(call: CallContext, handle: ProjectHandle, output: string): Promise<string | null> {
		if (this.kernel.spillOutput === undefined || output === "") return null;
		const written = await this.kernel.spillOutput(
			handle,
			`${call.tool}-${String(call.session.factsRevision)}-write`,
			output,
		);
		return written.ok ? written.value.file : null;
	}

	// ------------------------------------------------------------ 知识卡片

	/** 挑出这次要交的卡片（同一张一次会话只交一次），记下交了哪些，返回给模型的那段文字。 */
	async deliverCapsules(call: CallContext, capsules: readonly KnowledgeCapsule[]): Promise<string> {
		const session = call.session;
		const selected = selectKnowledgeCapsules(
			condenseProbeApiCapsules(capsules, session.apiExplained),
			session.capsulesSaid,
			this.referenceDocsDir === undefined ? undefined : referenceSourceResolver(this.referenceDocsDir),
		);
		for (const capsule of selected.capsules) {
			session.capsulesSaid.add(capsule.digest);
			if (capsule.kind !== "probe-api") continue;
			const fqcn = probeApiClassOf(capsule);
			const lines = session.apiExplained.get(fqcn) ?? new Set<string>();
			for (const line of probeApiLinesOf(capsule)) lines.add(line);
			session.apiExplained.set(fqcn, lines);
		}
		if (session.project !== undefined && selected.capsules.length > 0) {
			await this.kernel.recordCapsuleDelivery(session.project.root, session.project.runtimeKeyId, selected.capsules);
		}
		return selected.text;
	}
}
