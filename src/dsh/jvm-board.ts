/**
 * 苍穹 JVM 状态板：每个苍穹会话对应哪一个常驻 JVM、它起到哪一步了、是什么时候起的。给界面看，不发给模型。
 *
 * 界面那半边（`client/brand.js` 的 JVM 小标签）进到一个会话就请求一次 `ensure`：这时候才认工程、在后台起 JVM，
 * 用的是一次环境诊断探针（EnvDiagProbe）。它会顺带把常驻 JVM 拉起来，一步步报进度，最后核对连得上苍穹、
 * 账套和用户对不对。不在会话建好时就起，是因为恢复旧会话时 dsh 会一次建好几个，那样会给没人看的工程也起 JVM。
 *
 * 状态按「工程 + 运行时版本」记一份：同一个工程开两个会话，用的是同一个 JVM，起一次，两个会话看到的一样。
 * 本插件的预设建的会话都登记进来；别的预设的会话不登记，界面问到它就答「不管」，什么都不画。
 *
 * 起完以后它是不是还在，每次问都现查心跳（空闲 30 分钟会自己退；模型调工具时也可能重启它），
 * 不拿开机那一趟的结果冒充现在的状态。
 */

import { basename } from "node:path";
import type { CosmicAgentKernel } from "../agent/tools/kernel-adapter.ts";
import type { ProbeProgressStage } from "../kernel/commands/probe.ts";
import type { LocalServiceKind } from "../kernel/probe/health.ts";
import type { JvmScan, LocalJvm } from "../kernel/probe/local-jvms.ts";
import { PROBE_IDLE_EXIT_MS } from "../kernel/probe/local-jvms.ts";

/** 状态板用到的那几样内核能力。 */
export type BoardKernel<H> = Pick<CosmicAgentKernel<H>, "open" | "probe" | "probeServer"> &
	Partial<Pick<CosmicAgentKernel<H>, "localServiceHealth" | "residentBoot" | "localJvms" | "stopLocalJvm">>;

/** 开机这一趟的几步，顺序固定；后一步开始了、前一步还没开始，前一步就是跳过（比如 JVM 本来就在跑）。 */
export const BOOT_STEPS = [
	{ key: "open", label: "认工程" },
	{ key: "resident", label: "检查常驻 JVM" },
	{ key: "host", label: "编译探针宿主" },
	{ key: "runtime", label: "启动苍穹 JVM" },
	{ key: "warm", label: "预热元数据" },
	{ key: "check", label: "核对环境" },
] as const;
export type BootStepKey = (typeof BOOT_STEPS)[number]["key"];
export type BootStepState = "wait" | "run" | "ok" | "skip" | "fail";

const STAGE_STEP: Record<ProbeProgressStage, BootStepKey> = {
	"checking-resident": "resident",
	"compiling-host": "host",
	"starting-runtime": "runtime",
	"cold-start": "runtime",
	"warming-runtime": "warm",
	"compiling-probe": "check",
	"running-probe": "check",
};

/**
 * 开机这一趟的结果：
 *   starting  还在走；ready 起来了、环境核对通过；degraded 起来了，但环境有问题（账套不可见之类）；
 *   failed    没起成；not-built 工程还没构建（缺编译参数），没起——构建要几分钟，不替人自动付；
 *   config    工程配置不全，没起；no-project 这个目录不是苍穹工程。
 */
export type BootPhase = "starting" | "ready" | "degraded" | "failed" | "not-built" | "config" | "no-project";

interface Step {
	state: BootStepState;
	start: number | null;
	end: number | null;
}

interface Boot {
	phase: BootPhase;
	detail: string | null;
	steps: Record<BootStepKey, Step>;
	beganAt: number;
	endedAt: number | null;
	/** 环境核对报回来的用户、账套；没核对成功就是配置里写的。 */
	user: string | null;
	account: string | null;
	/** 配置不全时缺的那几项（`account`、`user` 是人要选的，别的是工程文件里该认出来的）；别的时候是空的。 */
	missing: string[];
}

interface Runtime<H> {
	root: string;
	keyId: string;
	/** 工程配置里的 ISV：工程属性，不随某一趟开机变 */
	isv: string | null;
	handle: H;
	boot: Boot | null;
	work: Promise<void> | null;
}

interface SessionEntry {
	cwd: string;
	/** 进来后第一次 ensure 之前是 null。 */
	runtime: string | null;
	/** 还没认出运行时的时候（在认、认不出、配置不全）。 */
	boot: Boot | null;
}

export interface BootStepView {
	key: BootStepKey;
	label: string;
	state: BootStepState;
	/** 做完的是用时，正在做的是已等的秒数；没开始、跳过的是 null。 */
	seconds: number | null;
}

/** 界面拿到的样子。时间都是毫秒时间戳。 */
export interface JvmView {
	/** `untracked`：不是本插件的会话（别的预设的、还没登记的），界面什么都不画。 */
	tracked: boolean;
	/** 会话工作目录的文件夹名：还没认出工程（配置不全）时界面拿它当工程名。 */
	folder: string | null;
	project: {
		root: string;
		name: string;
		keyId: string | null;
		user: string | null;
		account: string | null;
		isv: string | null;
	} | null;
	boot: {
		phase: BootPhase;
		detail: string | null;
		/** 配置不全时缺的那几项，界面据此画「等人填」的那几格。 */
		missing: string[];
		steps: BootStepView[];
		beganAt: number;
		/** 整趟用时；还在走时是已等的秒数。 */
		seconds: number;
		done: boolean;
	} | null;
	/** 这一刻现查的：常驻 JVM 在不在、在干什么。没认出运行时就是 null。 */
	live: {
		kind: LocalServiceKind;
		pid: number | null;
		detail: string | null;
		startedAt: number | null;
		port: number | null;
		hotSwap: string | null;
		warmMs: number | null;
	} | null;
	/** 本机另外还有几个会话用着同一个 JVM。 */
	sharedWith: number;
	/** 只在要详情时给：本机 cosmic 起的所有 JVM，`mine` 是本会话这一个。 */
	machine?: {
		jvms: (Pick<LocalJvm, "kind" | "pid" | "keyId" | "projectRoot" | "port" | "memoryBytes" | "state" | "logFile"> & {
			mine: boolean;
			startedAt: number | null;
			lastActiveAt: number | null;
			idleExitAt: number | null;
		})[];
		processesListed: boolean;
	};
}

function emptySteps(): Record<BootStepKey, Step> {
	const steps = {} as Record<BootStepKey, Step>;
	for (const step of BOOT_STEPS) steps[step.key] = { state: "wait", start: null, end: null };
	return steps;
}

function newBoot(now: number, user: string | null = null, account: string | null = null): Boot {
	return {
		phase: "starting",
		detail: null,
		steps: emptySteps(),
		beganAt: now,
		endedAt: null,
		user,
		account,
		missing: [],
	};
}

/**
 * 进入一步：前面正在做的那步算做完，前面没开始的算跳过。
 *
 * 进度会往回跳：JVM 没在跑时内核先发一次探针（报「核对环境」）、连不上才去起 JVM（报「启动」「预热」），
 * 起好再发一次。往回跳到的那步和它后面的，按还没开始重记，不然真花时间的那几步会被记成跳过。
 */
export function enterStep(boot: Boot, key: BootStepKey, now: number): void {
	const at = BOOT_STEPS.findIndex((step) => step.key === key);
	if (
		boot.steps[key].state !== "wait" ||
		BOOT_STEPS.slice(at + 1).some((step) => boot.steps[step.key].state !== "wait")
	)
		for (const step of BOOT_STEPS.slice(at)) boot.steps[step.key] = { state: "wait", start: null, end: null };
	BOOT_STEPS.forEach((step, index) => {
		const current = boot.steps[step.key];
		if (index < at) {
			if (current.state === "run") boot.steps[step.key] = { ...current, state: "ok", end: now };
			else if (current.state === "wait") boot.steps[step.key] = { state: "skip", start: null, end: null };
		}
	});
	const target = boot.steps[key];
	if (target.state === "wait") boot.steps[key] = { state: "run", start: now, end: null };
}

/** 收尾：正在做的那步按结果记 ok / fail；起成了，没轮到的记跳过（用不着做），没起成就留着没开始（没走到）。 */
export function finishBoot(
	boot: Boot,
	phase: Exclude<BootPhase, "starting">,
	detail: string | null,
	now: number,
): void {
	const good = phase === "ready" || phase === "degraded";
	for (const step of BOOT_STEPS) {
		const current = boot.steps[step.key];
		if (current.state === "run") boot.steps[step.key] = { ...current, state: good ? "ok" : "fail", end: now };
		else if (current.state === "wait" && good) boot.steps[step.key] = { state: "skip", start: null, end: null };
	}
	boot.phase = phase;
	boot.detail = detail;
	boot.endedAt = now;
}

function stepViews(boot: Boot, now: number): BootStepView[] {
	return BOOT_STEPS.map((step) => {
		const current = boot.steps[step.key];
		const seconds =
			current.start === null ? null : Math.max(0, Math.round(((current.end ?? now) - current.start) / 100) / 10);
		return { key: step.key, label: step.label, state: current.state, seconds };
	});
}

function nonBlank(record: Record<string, unknown>, key: string): string | null {
	const value = record[key];
	return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * 环境诊断探针的结果 → 开机结果。只看探针自己报的那一条 `profile-env` 记录：
 * 账套看不见、数据库没解析出来、本 ISV 一张元数据都没有，JVM 虽然起来了，但这个环境干不了活，报 degraded。
 */
export function envDiagVerdict(outcome: { exitCode: number; json: { records: Record<string, unknown>[] } }): {
	phase: "ready" | "degraded" | "failed";
	detail: string | null;
	user: string | null;
	account: string | null;
} {
	const record = outcome.json.records.find((item) => item.t === "profile-env");
	const user = record === undefined ? null : nonBlank(record, "user_name");
	const account = record === undefined ? null : nonBlank(record, "account_number");
	if (outcome.exitCode !== 0)
		return { phase: "failed", detail: `环境诊断探针退出码 ${String(outcome.exitCode)}`, user, account };
	if (record === undefined) return { phase: "failed", detail: "环境诊断探针未返回环境记录", user, account };
	const count = (key: string): number | null => {
		const value = record[key];
		return typeof value === "number" && Number.isFinite(value) ? value : null;
	};
	const problems: string[] = [];
	const accounts = count("accounts");
	if (accounts === null || accounts <= 0 || nonBlank(record, "account_id") === null || account === null)
		problems.push("账套不可见");
	if (nonBlank(record, "db") === null) problems.push("未能解析数据库");
	const metas = count("meta_count");
	if (metas === null || metas <= 0) problems.push("本 ISV 元数据为零");
	return problems.length > 0
		? { phase: "degraded", detail: problems.join("、"), user, account }
		: { phase: "ready", detail: null, user, account };
}

/**
 * 内核打开工程失败的错误码 → 开机结果。会话目录是当显式工程根交给内核的，目录不是工程时内核报
 * PROJECT_ROOT_INVALID，说的却是「COSMIC_PROJECT_ROOT 不对」，所以这一种换成直白的话（见 boot）。
 */
function openFailure(code: string): Exclude<BootPhase, "starting"> {
	if (code === "PROJECT_ROOT_NOT_FOUND" || code === "PROJECT_ROOT_INVALID") return "no-project";
	if (code === "CONFIG_INCOMPLETE" || code === "CONFIG_PARSE_FAILED") return "config";
	return "failed";
}

/** 配置不全的报错里缺的那几项：人要选的排前面。 */
function missingFields(error: unknown): string[] {
	const detail = (error as { detail?: { askUser?: unknown; fromProject?: unknown } }).detail;
	const list = (value: unknown) =>
		Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
	return [...list(detail?.askUser), ...list(detail?.fromProject)];
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function samePath(a: string | null, b: string): boolean {
	if (a === null) return false;
	const norm = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
	return norm(a) === norm(b);
}

export type BoardAction = "ensure" | "start" | "restart" | "stop";

const STOP_TEXT = {
	graceful: { ok: true, text: "已停止" },
	forced: { ok: true, text: "已停止（未正常退出，已强制结束）" },
	absent: { ok: true, text: "JVM 原本未运行" },
	foreign: { ok: false, text: "端口上的 JVM 属于其他工程或版本，未停止" },
	unverified: { ok: false, text: "JVM 无响应，且无法读取本机进程清单，无法确认身份，未停止" },
} as const;

export class JvmBoard<H> {
	private readonly sessions = new Map<string, SessionEntry>();
	private readonly runtimes = new Map<string, Runtime<H>>();
	private readonly kernel: BoardKernel<H>;
	private readonly now: () => number;

	constructor(kernel: BoardKernel<H>, now: () => number = Date.now) {
		this.kernel = kernel;
		this.now = now;
	}

	/** 会话进来了（或者换了工作目录）。只登记，不起 JVM：界面问到它才起。 */
	track(sessionId: string, cwd: string): void {
		const known = this.sessions.get(sessionId);
		if (known !== undefined && samePath(known.cwd, cwd)) return;
		this.sessions.set(sessionId, { cwd, runtime: null, boot: null });
	}

	forget(sessionId: string): void {
		this.sessions.delete(sessionId);
	}

	/**
	 * 工程配置刚填好（配置向导走完）：停在「配置不全」的会话清掉那一趟，界面下一次来问时看到「还没认过」，
	 * 照进会话那样叫 ensure，从认工程起重新走。不清的话 ensure 不重来，首页会一直停在等初始化。
	 */
	configChanged(): void {
		for (const entry of this.sessions.values())
			if (entry.runtime === null && entry.boot?.phase === "config" && entry.boot.endedAt !== null) entry.boot = null;
	}

	tracks(sessionId: string): boolean {
		return this.sessions.has(sessionId);
	}

	/** 这个会话认出来的工程（进会话后 ensure 认过才有）；输入框 `@` 引用按它找目录。 */
	projectOf(sessionId: string): { root: string; handle: H } | null {
		const entry = this.sessions.get(sessionId);
		const runtime = entry?.runtime == null ? undefined : this.runtimes.get(entry.runtime);
		return runtime === undefined ? null : { root: runtime.root, handle: runtime.handle };
	}

	/**
	 * 界面上的动作。都不等 JVM 起完就返回：
	 *   ensure   进到会话：还没起过就起（已经在起、起完了都不重来；上次没起成也不自动重来，等人点）；
	 *   start    人点「启动」：没在起就从头再来一趟，工程没构建也照样起（这时会先构建，要几分钟）；
	 *   restart  先停掉这个工程的常驻 JVM，再从头起；
	 *   stop     停掉这个工程的常驻 JVM。
	 */
	async act(sessionId: string, action: BoardAction): Promise<{ ok: boolean; text: string }> {
		const entry = this.sessions.get(sessionId);
		if (entry === undefined) return { ok: false, text: "这个会话不是苍穹会话，不管 JVM" };
		if (action === "ensure") {
			if (entry.runtime === null && entry.boot === null) void this.boot(sessionId, entry, { build: false });
			return { ok: true, text: "" };
		}
		const runtime = entry.runtime === null ? undefined : this.runtimes.get(entry.runtime);
		if (runtime?.work != null) return { ok: false, text: "正在启动，等这一趟走完再点" };
		if (action === "start") {
			void this.boot(sessionId, entry, { build: true });
			return { ok: true, text: "开始启动" };
		}
		if (runtime === undefined) return { ok: false, text: "尚未识别当前会话的工程，请先点击「启动」" };
		if (action === "stop") {
			const stopped = await this.kernel.probeServer(runtime.handle, "stop");
			if (!stopped.ok) return { ok: false, text: stopped.error.message };
			return STOP_TEXT[stopped.value.stopped ?? "absent"];
		}
		const stopped = await this.kernel.probeServer(runtime.handle, "stop");
		if (!stopped.ok) return { ok: false, text: stopped.error.message };
		if (stopped.value.stopped === "foreign" || stopped.value.stopped === "unverified")
			return { ok: false, text: "无法确认端口上的 JVM 属于本工程，未停止，也未重启" };
		void this.boot(sessionId, entry, { build: true });
		return { ok: true, text: "已停，正在重新启动" };
	}

	/** 停本机清单里的一个 cosmic JVM（详情面板里「别的进程」那一栏）。 */
	async stopPid(pid: number): Promise<{ ok: boolean; text: string }> {
		if (this.kernel.localJvms === undefined || this.kernel.stopLocalJvm === undefined)
			return { ok: false, text: "当前宿主无法读取本机进程" };
		const scan = await this.kernel.localJvms({ listProcesses: true, clean: false });
		const target = scan.jvms.find((one) => one.pid === pid);
		if (target === undefined) return { ok: false, text: `本机 cosmic 进程中没有 pid ${String(pid)}，未停止` };
		const stopped = await this.kernel.stopLocalJvm(target);
		return { ok: stopped.stopped, text: stopped.stopped ? "已停止" : `未停止：${stopped.how}` };
	}

	private async boot(sessionId: string, entry: SessionEntry, options: { build: boolean }): Promise<void> {
		const pending = newBoot(this.now());
		entry.boot = pending;
		enterStep(pending, "open", this.now());
		const opened = await this.kernel.open(entry.cwd, { rescanRuntime: true }).catch((error: unknown) => ({
			ok: false as const,
			error: { code: "OPEN_FAILED", message: errorText(error) },
		}));
		if (this.sessions.get(sessionId) !== entry) return;
		if (!opened.ok) {
			entry.runtime = null;
			const phase = openFailure(opened.error.code);
			if (phase === "config") pending.missing = missingFields(opened.error);
			const detail =
				phase === "no-project"
					? `该目录不是 Gradle 工程（向上未找到 settings.gradle）：${entry.cwd}`
					: opened.error.message;
			finishBoot(pending, phase, detail, this.now());
			return;
		}
		const { summary, handle } = opened.value;
		const key = `${summary.root}\n${summary.runtimeKeyId}`;
		entry.runtime = key;
		entry.boot = null;
		let runtime = this.runtimes.get(key);
		if (runtime === undefined) {
			runtime = {
				root: summary.root,
				keyId: summary.runtimeKeyId,
				isv: summary.identity.isv,
				handle,
				boot: null,
				work: null,
			};
			this.runtimes.set(key, runtime);
		} else {
			runtime.handle = handle;
			runtime.isv = summary.identity.isv;
		}
		// 同一个工程别的会话已经起过（或正在起）：搭那一趟，不重来；人点了「启动」「重启」才重来。
		if (runtime.work !== null) return;
		if (runtime.boot !== null && !options.build && runtime.boot.phase !== "not-built") return;
		const boot = pending;
		boot.user = summary.identity.user;
		boot.account = summary.identity.account;
		runtime.boot = boot;
		if (!summary.built && !options.build) {
			finishBoot(
				boot,
				"not-built",
				"工程尚未构建（缺少编译参数）。构建需要几分钟，未自动执行；点击「启动」将先构建再启动 JVM",
				this.now(),
			);
			return;
		}
		const work = this.run(runtime, boot);
		runtime.work = work;
		await work;
	}

	private async run(runtime: Runtime<H>, boot: Boot): Promise<void> {
		try {
			const result = await this.kernel.probe(runtime.handle, "EnvDiagProbe", {
				positional: [],
				env: {},
				// 环境诊断是看活着没有，不是业务问题：不进重复失败的账，不然开三次就被当成失败重试。
				countRepeats: false,
				// 常驻起不来不降级冷进程：冷进程那半分钟会把整个宿主的事件循环卡住。照实报没起成，人可以再点。
				coldFallback: false,
				onProgress: (stage) => {
					if (runtime.boot === boot) enterStep(boot, STAGE_STEP[stage], this.now());
				},
			});
			if (runtime.boot !== boot) return;
			if (!result.ok) {
				finishBoot(boot, "failed", result.error.message, this.now());
				return;
			}
			const verdict = envDiagVerdict(result.value as unknown as Parameters<typeof envDiagVerdict>[0]);
			if (verdict.user !== null) boot.user = verdict.user;
			if (verdict.account !== null) boot.account = verdict.account;
			finishBoot(boot, verdict.phase, verdict.detail, this.now());
		} catch (error) {
			if (runtime.boot === boot) finishBoot(boot, "failed", errorText(error), this.now());
		} finally {
			runtime.work = null;
		}
	}

	/** 界面要看的样子。`detail` 时再查一次本机进程清单（约一秒），只在详情面板开着时要。 */
	async view(sessionId: string, options: { detail?: boolean } = {}): Promise<JvmView> {
		const now = this.now();
		const entry = this.sessions.get(sessionId);
		if (entry === undefined)
			return { tracked: false, folder: null, project: null, boot: null, live: null, sharedWith: 0 };
		const runtime = entry.runtime === null ? undefined : this.runtimes.get(entry.runtime);
		// 正在认工程（或认失败了）的那一趟记在会话上，优先于这个运行时上一趟的结果：点「启动」后头几秒不该还显示旧的
		const boot = entry.boot ?? runtime?.boot ?? null;
		const view: JvmView = {
			tracked: true,
			folder: basename(entry.cwd.replace(/[\\/]+$/, "")) || null,
			project:
				runtime === undefined
					? null
					: {
							root: runtime.root,
							name: basename(runtime.root),
							keyId: runtime.keyId,
							user: boot?.user ?? null,
							account: boot?.account ?? null,
							isv: runtime.isv,
						},
			boot:
				boot === null
					? null
					: {
							phase: boot.phase,
							detail: boot.detail,
							missing: [...boot.missing],
							steps: stepViews(boot, now),
							beganAt: boot.beganAt,
							seconds: Math.round(((boot.endedAt ?? now) - boot.beganAt) / 1000),
							done: boot.endedAt !== null,
						},
			live: null,
			sharedWith:
				entry.runtime === null
					? 0
					: [...this.sessions.entries()].filter(
							([id, other]) => id !== sessionId && other.runtime === entry.runtime,
						).length,
		};
		if (runtime !== undefined) view.live = await this.live(runtime);
		if (options.detail === true && this.kernel.localJvms !== undefined) {
			const scan = await this.kernel
				.localJvms({ listProcesses: true, clean: false })
				.catch((): JvmScan => ({ jvms: [], staleRecords: [], processesListed: false }));
			view.machine = {
				processesListed: scan.processesListed,
				jvms: scan.jvms.map((jvm) => ({
					kind: jvm.kind,
					pid: jvm.pid,
					keyId: jvm.keyId,
					projectRoot: jvm.projectRoot,
					port: jvm.port,
					memoryBytes: jvm.memoryBytes,
					state: jvm.state,
					logFile: jvm.logFile,
					mine: runtime !== undefined && jvm.kind === "probe" && jvm.keyId === runtime.keyId,
					startedAt: jvm.startedAtMs,
					lastActiveAt: jvm.lastActiveMs,
					idleExitAt:
						jvm.kind === "probe" && jvm.lastActiveMs !== null && jvm.state === "ready"
							? jvm.lastActiveMs + PROBE_IDLE_EXIT_MS
							: null,
				})),
			};
		}
		return view;
	}

	private async live(runtime: Runtime<H>): Promise<JvmView["live"]> {
		const [health, resident] = await Promise.all([
			this.kernel.localServiceHealth?.(runtime.handle).catch(() => null) ?? Promise.resolve(null),
			this.kernel.residentBoot?.(runtime.handle).catch(() => null) ?? Promise.resolve(null),
		]);
		if (health === null) return null;
		const startedAt = resident?.startedAt === null || resident === null ? null : Date.parse(resident.startedAt);
		const running = health.kind !== "stopped" && health.kind !== "foreign";
		return {
			kind: health.kind,
			pid: health.pid,
			detail: health.detail,
			startedAt: running && startedAt !== null && Number.isFinite(startedAt) ? startedAt : null,
			port: running ? (resident?.facts.ready?.port ?? null) : null,
			hotSwap: running ? (resident?.facts.hotswap ?? null) : null,
			warmMs: running ? (resident?.facts.warmMs ?? null) : null,
		};
	}
}

/** 界面调的路径（dsh 连接层要求 `/api` 下的绝对路径；界面用去掉开头斜杠的相对形式）。 */
export const JVM_BOARD_PATH = "/api/fast-ai-cosmic.jvm";

const json = (value: unknown, status = 200): Response =>
	Response.json(value, { status, headers: { "cache-control": "no-store" } });

const ACTIONS: readonly BoardAction[] = ["ensure", "start", "restart", "stop"];

/**
 * 一条路径两种方法：
 *   GET  `?session=<会话编号>[&detail=1]`  看状态；
 *   POST `{ session, action }`              ensure / start / restart / stop，回动作结果和最新状态；
 *   POST `{ action: "stop-pid", pid }`      停本机清单里的一个 cosmic JVM。
 */
export async function handleJvmBoard<H>(board: JvmBoard<H>, request: Request): Promise<Response> {
	if (request.method === "GET" || request.method === "HEAD") {
		const query = new URL(request.url).searchParams;
		const session = query.get("session");
		if (session === null || session === "") return json({ error: "缺少 session 参数" }, 400);
		return json(await board.view(session, { detail: query.get("detail") === "1" }));
	}
	let body: { session?: unknown; action?: unknown; pid?: unknown };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return json({ error: "请求体要是 JSON" }, 400);
	}
	if (body.action === "stop-pid") {
		if (typeof body.pid !== "number" || !Number.isInteger(body.pid)) return json({ error: "pid 要是整数" }, 400);
		return json({ result: await board.stopPid(body.pid) });
	}
	if (typeof body.session !== "string" || body.session === "") return json({ error: "缺少 session 参数" }, 400);
	if (!ACTIONS.includes(body.action as BoardAction))
		return json({ error: "action 只认 ensure、start、restart、stop、stop-pid" }, 400);
	const result = await board.act(body.session, body.action as BoardAction);
	return json({ result, view: await board.view(body.session) });
}
