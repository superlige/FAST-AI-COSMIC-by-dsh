/**
 * 「同一个问题，你已经问过两遍了」—— 同一探针、同一入参、答案一字不差时，第三次不再启动 JVM。
 *
 * Why this exists. 真机复盘（2026-09-14 第二轮）里，一次弹窗链路验不通之后，同一个
 * `OpMetaProbe OP_ENTITY=zlgd_lssy_qzxy` 被连着调了三次，三次输出完全相同（`操作 共 2`），
 * 期间没有编译、没有写入。那三次都不是探索，是在碰运气：结论第一次就已经定死了，
 * 只是没有任何东西**告诉**调用方它定死了。同一段时间里 `run flow` 冷进程跑了三次、
 * 每次 45 秒——十分钟机时花在把同一个问题问第五遍上。
 *
 * 判据只用事实，不猜意图：**两次连续的输出逐字节相同**才算「答案不会变」。
 * 输出一动，计数清零——一个结论会变的探针永远不会被挡。
 *
 * 世界变了就重新开始：`fast` 编译过、APPLY 写过元数据、会落库的运行（S27 起运行真提交），都调 {@link forgetRepeats} 清账；
 * 另外整本账带时间窗，超过窗口的旧记录不参与判定（共享环境里隔半小时再读一次是正当的，
 * 别人可能改过东西，而那件事这里看不见）。
 *
 * 按 RuntimeKey 分账，理由和 `noise.ts` 一样：换个账套就是另一套元数据，
 * 把上一套的「问过了」算到这一套头上，等于用另一个环境的历史回答这个环境的问题。
 */

import { sha256 } from "../../runtime/fingerprint.ts";
import type { KernelContext } from "../context.ts";

/** One probe+inputs combination's history on this RuntimeKey. */
export interface RepeatEntry {
	/** How many runs this fingerprint has had, this one included. */
	calls: number;
	/**
	 * 连着几次输出逐字节相同（含最近这次）。1 表示上一次输出跟再上一次不一样。
	 *
	 * 计数而不是布尔值：要拦的是「问第三遍」，而第三遍的判据是前两遍已经互相印证过。
	 */
	identical: number;
	firstAt: string;
	lastAt: string;
	/** 人读的标识，让这本账单独打开也看得懂。 */
	label: string;
	/** 上一次的完整输出落在哪，拒绝时直接把路径给出去。 */
	outFile: string;
	digest: string;
}

export interface RepeatLedger {
	kind: "RepeatLedger";
	runtimeKeyId: string;
	entries: Record<string, RepeatEntry>;
}

/** 超过这个时间的记录不参与判定：共享环境里隔久了重读一次是正当的。 */
const WINDOW_MS = 30 * 60 * 1000;

/** 账本条数上限。这是缓存不是证据，最久没碰的先丢。 */
const LEDGER_LIMIT = 200;

/** 这次调用问的是什么：探针、它的源码、以及全部入参。 */
export interface RepeatKey {
	cls: string;
	/** 探针源码摘要：改过探针就是另一个问题了。 */
	sourceDigest: string;
	env: Readonly<Record<string, string>>;
}

/**
 * 入参里不该进指纹的几个名字。
 *
 * 它们每次都不一样，或者只影响输出怎么给人看、不影响结论：算进去的话
 * 没有两次调用会撞上同一个指纹，这套机制就静默地什么都不做了。
 */
const VOLATILE = new Set(["COSMIC_CONFIRMATION", "COSMIC_TARGETS"]);

export function repeatFingerprint(key: RepeatKey): string {
	const inputs = Object.entries(key.env)
		.filter(([name]) => !VOLATILE.has(name))
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, value]) => `${name}=${value}`);
	return sha256([key.cls, key.sourceDigest, ...inputs].join("\n"));
}

/** 人读的一行：探针名 + 真正点了题的那几个入参。 */
export function repeatLabel(key: RepeatKey): string {
	const inputs = Object.entries(key.env)
		.filter(([name, value]) => !VOLATILE.has(name) && value !== "")
		.sort(([a], [b]) => a.localeCompare(b))
		.slice(0, 4)
		.map(([name, value]) => `${name}=${value.slice(0, 40)}`);
	return inputs.length === 0 ? key.cls : `${key.cls} ${inputs.join(" ")}`;
}

/**
 * 比对两次输出前，先抹掉「每跑一次都不一样、但跟结论无关」的那几样。
 *
 * 不做这一步，这套机制会在最贵的那几个探针上静默失效：`run form` / `run flow` 的输出里
 * 带着 `activate OK 23339ms` 和 `pageId=formsim_31425621226900`，两次跑同一条用例
 * 逐字节永远不同，于是一次 45 秒的冷启动想重复多少遍都没人拦。
 *
 * 抹的只有耗时、页面 id、时间戳和长十六进制 id。**行数、条数一律留着**——
 * 「命中 37 条」变成「命中 36 条」就是结论变了，那正是必须让它重跑的情形。
 */
export function normalizeOutput(text: string): string {
	return text
		.replace(/\b\d+ms\b/g, "#ms")
		.replace(/\bformsim[_a-z]*_\d+/g, "#page")
		.replace(/\b\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}[.,]?\d*/g, "#time")
		.replace(/\b[0-9a-f]{16,}\b/gi, "#id");
}

function ledgerFile(ctx: KernelContext): string {
	const safe = ctx.runtimeKeyId.replace(/[^\w.-]+/g, "_");
	return `${ctx.layout.workDir}/repeat/${safe}.json`;
}

function readLedger(ctx: KernelContext): RepeatLedger {
	const empty: RepeatLedger = { kind: "RepeatLedger", runtimeKeyId: ctx.runtimeKeyId, entries: {} };
	const file = ledgerFile(ctx);
	if (!ctx.ports.fs.exists(file)) return empty;
	try {
		const parsed = JSON.parse(ctx.ports.fs.read(file)) as RepeatLedger;
		if (parsed?.kind !== "RepeatLedger" || parsed.runtimeKeyId !== ctx.runtimeKeyId) return empty;
		return { ...empty, entries: parsed.entries ?? {} };
	} catch {
		return empty;
	}
}

function writeLedger(ctx: KernelContext, ledger: RepeatLedger): void {
	const kept = Object.entries(ledger.entries)
		.sort((a, b) => b[1].lastAt.localeCompare(a[1].lastAt))
		.slice(0, LEDGER_LIMIT);
	const file = ledgerFile(ctx);
	try {
		ctx.ports.fs.mkdirp(file.slice(0, file.lastIndexOf("/")));
		ctx.ports.fs.write(file, `${JSON.stringify({ ...ledger, entries: Object.fromEntries(kept) }, null, "\t")}\n`);
	} catch {
		// 写不了就下次从头数。一本记账用的缓存不该弄挂它正在观察的那次运行。
	}
}

/**
 * 这次该不该拦。
 *
 * 返回非 null 表示：同一个问题已经问过至少两遍，而且那两遍的输出逐字节相同。
 * 判定只看账本，不启动任何东西——这正是它的意义，拦下来省的就是那 45 秒。
 */
export function repeatBlocked(ctx: KernelContext, key: RepeatKey): RepeatEntry | null {
	const entry = readLedger(ctx).entries[repeatFingerprint(key)];
	if (entry === undefined) return null;
	if (entry.calls < 2 || entry.identical < 2) return null;
	const age = ctx.ports.clock.now() - Date.parse(entry.lastAt);
	if (!Number.isFinite(age) || age > WINDOW_MS) return null;
	return entry;
}

/**
 * 把这次跑完的结果记进账。
 *
 * 只有输出跟上次**逐字节相同**才累加 `identical`；不同就归 1，
 * 于是「结论正在变化」的探针无论跑多少次都不会被拦。
 */
export function recordRepeat(ctx: KernelContext, key: RepeatKey, result: { output: string; outFile: string }): void {
	const ledger = readLedger(ctx);
	const id = repeatFingerprint(key);
	const at = new Date(ctx.ports.clock.now()).toISOString();
	const digest = sha256(normalizeOutput(result.output));
	const known = ledger.entries[id];
	const fresh = known === undefined || ctx.ports.clock.now() - Date.parse(known.lastAt) > WINDOW_MS;
	ledger.entries[id] = {
		calls: fresh ? 1 : known.calls + 1,
		identical: !fresh && known.digest === digest ? known.identical + 1 : 1,
		firstAt: fresh ? at : known.firstAt,
		lastAt: at,
		label: repeatLabel(key),
		outFile: result.outFile,
		digest,
	};
	writeLedger(ctx, ledger);
}

/**
 * 清账。世界可能变了，之前的「问过了」全部作废。
 *
 * 调用点是「会让答案改变」的那几件事：编译（`fast`）、写元数据（APPLY）、会落库的运行（`run`，S27）。
 * 宁可多清一次——清错了最多是多跑一次探针，不清才会把一个已经变了的结论挡在门外。
 */
export function forgetRepeats(ctx: KernelContext): void {
	const file = ledgerFile(ctx);
	try {
		if (ctx.ports.fs.exists(file)) ctx.ports.fs.remove(file);
	} catch {
		// 同上：清不掉也不该影响正在跑的那件事
	}
}
