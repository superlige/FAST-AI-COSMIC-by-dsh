/**
 * 一个会话的全部可变状态。
 *
 * 一个 dsh 进程里可以同时开好几个会话（桌面版、网页版），每个会话一份，按会话对象存在 WeakMap 里；
 * 模块顶层不放任何会变的东西，免得两个会话互相看见对方打开的工程、改过的文件和失败计数。
 *
 * 大部分只在内存里：进程重启后从空的开始，工程会在下一次要它的工具调用时重新打开。
 * 完成情况要用的那几样（会话开始时的原文、真跑业务、编译、写元数据、造改数）另落一份到
 * `<工程>/.cosmic-ai/evidence/sessions/<会话编号>.json`：完成情况的比对起点是「本会话开始时」，
 * 用户隔天在同一个会话里接着改，起点不能因为桌面版重开过就挪到重开那一刻。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { initialProdState, type ProdState } from "../agent/state/prod-state.ts";
import { createFormulaErrorLedger, type FormulaErrorLedger } from "../agent/tools/formula-repeat.ts";
import { createGitNewJava, type GitNewJava } from "../agent/tools/git-new-java.ts";
import type { AgentProjectSummary } from "../agent/tools/kernel-adapter.ts";
import { createReadLedger, forgetAllReads, type ReadLedger } from "../agent/tools/read-ledger.ts";
import { createReminderLedger, forgetAllReminders, type ReminderLedger } from "../agent/tools/reminders.ts";
import { createSentLedger, forgetAllSent, type SentLedger } from "../agent/tools/sent-ledger.ts";
import { createStyleLedger, type StyleLedger } from "../agent/tools/style-check.ts";
import type { FreshnessSnapshot } from "../kernel/freshness.ts";
import { COSMIC_DIR, isAdHocProbeFile } from "../kernel/layout.ts";
import { initialMonitorPromptState, type MonitorPromptState } from "./monitor-login.ts";
import { initialProdSetupPromptState, type ProdSetupPromptState } from "./prod-setup.ts";
import { initialSetupPromptState, type SetupPromptState } from "./setup.ts";
import type { FailureStreak } from "./streak.ts";

/** 同一调用上一次运行留下的输出，`raw` 从这里取。 */
export interface RememberedOutput {
	text: string;
	/** `text` 已经是完整日志：带 raw=true 跑的，或者这次运行一行都没滤掉。 */
	full: boolean;
	/** 完整日志的落盘文件，连当时的大小和修改时间：对不上就是被别的运行盖掉了。 */
	log: { file: string; size: number; mtimeMs: number } | null;
	at: string;
}

/** 一次运行之后库里的一张单（探针的 `committed` 记录）。 */
export interface CommittedBill {
	entity: string;
	pk: string;
	billno: string | null;
	status: string | null;
	/** 这次运行新建的；`null` 是探针拿不准。 */
	created: boolean | null;
	/** 这次对它做了什么：新建、下推、submit…… */
	what: string;
}

/** 一次 cosmic_run。 */
export interface RunFact {
	at: string;
	argv: string[];
	kind: string;
	target: string;
	exitCode: number;
	passed: number;
	failed: number;
	outputFile: string | null;
	/** 这次运行之后库里的单。老会话落盘的那份没有这一项。 */
	bills?: CommittedBill[];
	/** 这次真执行的操作、开的表单上挂着的本工程类（全限定名）；run call 是被调的那个类。 */
	plugins?: string[];
}

/** 一次编译：`at` 用来和最后一次改代码比先后。 */
export interface CompileFact {
	at: string;
	ok: boolean;
	fresh: boolean;
	files: number;
}

/** 一次写元数据：确认过的、拒绝的、写失败的都记。 */
export interface MetaWriteFact {
	at: string;
	probe: string;
	kind: string;
	object: string;
	purpose: string;
	outcome: "written" | "declined" | "failed" | "not-applied";
	undo: string;
	backup: string | null;
	outputFile: string | null;
	/** 确认单上的那张表（改前、改后逐项），不含写入范围和口径。 */
	form: string | null;
}

/** 一次造数、改数。 */
export interface DataWriteFact {
	at: string;
	probe: string;
	ok: boolean;
	created: string[];
	changed: string[];
	outputFile: string | null;
}

export interface OpenedProject<Handle> {
	root: string;
	runtimeKeyId: string;
	handle: Handle;
	summary: AgentProjectSummary;
}

/** 落盘的那份：完成情况要用的事实，进程重启后接得上。 */
interface SessionJournal {
	startedAt: string;
	lastEditAt: string | null;
	files: string[];
	/** [比较用的文件名, 磁盘上的文件, 会话开始时的原文（null 是本会话新建的）] */
	originals: [string, string, string | null][];
	runs: RunFact[];
	compiles: CompileFact[];
	metaWrites: MetaWriteFact[];
	dataWrites: DataWriteFact[];
}

/** 会话编号进文件名：只留字母数字和 `-_`。 */
export function journalFile(root: string, id: string): string {
	return join(root, COSMIC_DIR, "evidence", "sessions", `${id.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
}

export class CosmicSession<Handle = unknown> {
	/** dsh 的会话编号；没有会话的调用（测试、无会话的宿主）没有，也不落盘。 */
	readonly id: string | undefined;
	/** 本会话开始的时刻：完成情况的比对起点。重开会话时从落盘的那份接回来。 */
	startedAt = new Date().toISOString();
	/** 最后一次改业务文件（临时探针不算）的时刻：比它早的真跑业务和编译，对的不是现在的代码。 */
	lastEditAt: string | null = null;
	/** 最后一次知道的工程目录：落盘用。 */
	root: string | undefined;
	/** 已经从哪个工程目录接回过落盘的那份；一个会话只接一次。 */
	private restoredFrom: string | undefined;
	project: OpenedProject<Handle> | undefined;
	/** 本会话用文件工具写过的文件（文件工具交回的绝对路径）。 */
	readonly files = new Set<string>();
	/** 源码版本：本会话每改一次文件、每编译一次就加一。失败计数和编译新鲜度都靠它判断「世界动没动」。 */
	factsRevision = 0;
	/** 上一次编译新鲜时的指纹；之后再改就清掉。 */
	freshness: FreshnessSnapshot | undefined;
	compiledAt: string | undefined;
	streak: FailureStreak | undefined;
	readonly outputs = new Map<string, RememberedOutput>();
	readonly reminders: ReminderLedger = createReminderLedger();
	readonly sent: SentLedger = createSentLedger();
	readonly style: StyleLedger = createStyleLedger();
	/** 读过哪些文件的哪几段：原样再读一遍时换成一句话，大 Java 第一次整份读先给提纲。 */
	readonly reads: ReadLedger = createReadLedger();
	/** 本会话新建的源码 Java，登记进 git（intent-to-add），删掉了再撤。 */
	readonly gitNewJava: GitNewJava = createGitNewJava();
	/** 已经说过用法的探针：一次会话只说一遍。 */
	readonly probesExplained = new Set<string>();
	/** 已经交给模型的知识卡片（摘要）。 */
	readonly capsulesSaid = new Set<string>();
	/** 临时探针用到的平台类，已经说过的签名行。 */
	readonly apiExplained = new Map<string, Set<string>>();
	readonly formulaErrors: FormulaErrorLedger = createFormulaErrorLedger();
	readonly runs: RunFact[] = [];
	readonly compiles: CompileFact[] = [];
	readonly metaWrites: MetaWriteFact[] = [];
	readonly dataWrites: DataWriteFact[] = [];
	prod: ProdState = initialProdState();
	/** 排障会话里 monitor 登录问过没有、人还要不要被问。 */
	readonly monitorPrompt: MonitorPromptState = initialMonitorPromptState();
	/** 工具要打开工程时配置不全，自动弹工程配置向导；人不填了，本会话不再弹。 */
	readonly setupPrompt: SetupPromptState = initialSetupPromptState();
	/** 排障会话里生产排障配置不全，自动弹配置向导；人不填了，本会话不再弹。 */
	readonly prodSetupPrompt: ProdSetupPromptState = initialProdSetupPromptState();
	/** 开发会话里用户带过来的诊断报告路径。 */
	lastReport: string | undefined;

	constructor(id?: string) {
		this.id = id;
	}

	/**
	 * 上下文压缩之后：「已经说过」的几本账清空。被压掉的那段对话里说过的提醒、卡片、探针用法，
	 * 模型已经看不见了，再说一遍才对。
	 */
	forgetSaid(): void {
		forgetAllReminders(this.reminders);
		forgetAllSent(this.sent);
		forgetAllReads(this.reads);
		this.probesExplained.clear();
		this.capsulesSaid.clear();
		this.apiExplained.clear();
	}

	/** 本会话改过一个文件：源码版本前进，编译新鲜度作废。 */
	noteEdited(file: string): void {
		this.files.add(file);
		this.factsRevision += 1;
		this.freshness = undefined;
		if (!isAdHocProbeFile(file)) this.lastEditAt = new Date().toISOString();
	}

	/**
	 * 接回落盘的那份（一个会话只接一次）。必须在记下第一份原文、第一次落盘之前做：
	 * 否则重开后第一次改文件，会把上一段已经改过的内容当成「会话开始时」，落盘时还会盖掉旧的那份。
	 * 内存里此时只有重开之后的事实，所以落盘的在前、内存的在后拼起来就是整段会话。
	 */
	restore(root: string | undefined): void {
		const at = root ?? this.project?.root ?? this.root;
		if (at === undefined) return;
		this.root = at;
		if (this.id === undefined || this.restoredFrom === at) return;
		this.restoredFrom = at;
		const file = journalFile(at, this.id);
		if (!existsSync(file)) return;
		let saved: SessionJournal;
		try {
			saved = JSON.parse(readFileSync(file, "utf8")) as SessionJournal;
		} catch {
			return;
		}
		this.startedAt = saved.startedAt < this.startedAt ? saved.startedAt : this.startedAt;
		if (this.lastEditAt === null) this.lastEditAt = saved.lastEditAt;
		for (const path of saved.files ?? []) this.files.add(path);
		for (const [key, path, original] of saved.originals ?? []) {
			this.style.files.set(key, path);
			this.style.originals.set(key, original);
		}
		this.runs.unshift(...(saved.runs ?? []));
		this.compiles.unshift(...(saved.compiles ?? []));
		this.metaWrites.unshift(...(saved.metaWrites ?? []));
		this.dataWrites.unshift(...(saved.dataWrites ?? []));
	}

	/** 完成情况要用的事实落一份盘；不知道工程目录或没有会话编号就不落。落盘失败不影响工具本身。 */
	save(root?: string): void {
		this.restore(root);
		if (this.id === undefined || this.root === undefined) return;
		const journal: SessionJournal = {
			startedAt: this.startedAt,
			lastEditAt: this.lastEditAt,
			files: [...this.files],
			originals: [...this.style.originals].map(([key, original]) => [
				key,
				this.style.files.get(key) ?? key,
				original,
			]),
			runs: this.runs,
			compiles: this.compiles,
			metaWrites: this.metaWrites,
			dataWrites: this.dataWrites,
		};
		try {
			const file = journalFile(this.root, this.id);
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, `${JSON.stringify(journal, null, 1)}\n`);
		} catch {
			// 只是为了重开后接得上；写不进去，本进程里的事实照样在
		}
	}
}

/**
 * 每个会话一份。键是 dsh 的会话编号（Agent.id 和 Session.id 是同一个），
 * 会话关掉时由 `session/disposed` 删掉；没有会话的调用（测试、无会话的宿主）共用一份。
 */
export class SessionStore<Handle> {
	private readonly byId = new Map<string, CosmicSession<Handle>>();
	private readonly detached = new CosmicSession<Handle>();

	of(id: string | undefined): CosmicSession<Handle> {
		if (id === undefined) return this.detached;
		let session = this.byId.get(id);
		if (session === undefined) {
			session = new CosmicSession<Handle>(id);
			this.byId.set(id, session);
		}
		return session;
	}

	peek(id: string): CosmicSession<Handle> | undefined {
		return this.byId.get(id);
	}

	drop(id: string): void {
		this.byId.delete(id);
	}
}
