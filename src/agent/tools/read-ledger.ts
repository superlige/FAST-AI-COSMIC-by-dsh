/**
 * 文件读取账：同一份内容别在上下文里躺第二遍（S20 批 3）。
 *
 * 真机量出来的事（S20 §2.6）：一个业务文件在一次会话里被 `read` 了 13 次，共 108,875 字符。
 * 前两次把整份文件读完了（第 1–969 行、第 969–1452 行）；**后面 11 次要的行段，
 * 全部落在前两次已经给过的范围里**，逐行比对内容一个字都没变，41,636 字符就这么
 * 又进了一遍上下文。
 *
 * 这本账只回答一个问题：**这几行，这次会话里是不是已经原样给过了？**
 * 是就回一句话，指明是第几次调用给的、哪几行；不是就照常发。
 *
 * 判据只用事实，不猜意图——和 `kernel/probe/repeat.ts` 同一条规矩：
 *
 *   - 比的是**逐行文本**，不是行号区间。文件被改过，同一段行号的内容就不一样，
 *     于是照常发全文并把这一段的记录换成新的。「内容变了还说没变」这种错不会发生。
 *   - 少一行都不算。请求的范围只要有一行没给过，整段照常发——半截文件比没有更危险。
 *
 * 什么时候作废：**只有上下文被压缩的时候**（`session_compact`）。这本账的全部主张是
 * 「那份还在上文里」，压缩之后它不在了，所以整本清空——不清的话，模型会被告知去看
 * 一段已经不存在的内容，那比多发一遍糟得多。
 *
 * 为什么**不**按 write/edit 清账（写这条之前先这么做过，量完才改回来）：一次 edit 改的是
 * 三五行，把整份文件的账清掉等于因为三行丢掉一千四百行仍然正确的知识。逐行比对本来
 * 就更准——改过的那几行比不上，照常发；没改的那些比得上，本来就还在上文里。行号被
 * 插入撑开时同样成立：撑开之后那一段逐行比不上，于是整条重记。
 *
 * 只活在内存里，不进会话状态、不进模型看得见的任何字段。它描述的是**当前这个上下文
 * 窗口里有什么**，而这件事的寿命本来就等于这个进程。
 */

import { createSurroundingsSeen, type SurroundingsSeen } from "../../knowledge/class-surroundings.ts";

/** 一次已经交付过的读取。 */
interface Delivery {
	/** 第几次 `read` 调用。用来在提示里说「第 3 次给过」。 */
	seq: number;
	from: number;
	to: number;
}

interface PathEntry {
	/** 行号 → 那一行的原文。只存交付过的行。 */
	lines: Map<number, string>;
	deliveries: Delivery[];
	chars: number;
	/** 最近一次被读到的顺序号，用于超额时先丢最久没碰的。 */
	touched: number;
}

export interface ReadLedger {
	paths: Map<string, PathEntry>;
	/** 已经发生过多少次 `read`。这是提示里那个「第几次」。 */
	reads: number;
	chars: number;
	/**
	 * 整份读时已经先给过提纲的文件（`java-outline.ts`）。再整份读一次就给全文；
	 * 压缩时和上面的记录一起清空。
	 */
	outlined: Set<string>;
	/**
	 * 读到工程里的插件类时附过周边的文件，和已经给过的父类、常量（`class-surroundings.ts`）。
	 * 压缩时一起清空：周边也不在上文里了。
	 */
	surrounded: Set<string>;
	surroundings: SurroundingsSeen;
}

/**
 * 这本账最多存多少字符的正文。
 *
 * 超了就把最久没碰过的文件整条丢掉——丢掉只会让那个文件的重读照常发全文，
 * 也就是退回改动前的行为，不会出错。
 */
const MAX_CHARS = 600_000;

/** 短到不值得记的读取：省下的还不够那句提示长。 */
const MIN_CHARS = 200;

export function createReadLedger(): ReadLedger {
	return {
		paths: new Map(),
		reads: 0,
		chars: 0,
		outlined: new Set(),
		surrounded: new Set(),
		surroundings: createSurroundingsSeen(),
	};
}

/**
 * pi 的 `read` 在正文末尾追加的那一行方括号提示（「[Showing lines 1-969 of 1452…]」
 * 「[123 more lines in file…]」「[Truncated: …]」）。
 *
 * 必须摘掉再比：同一段内容，第一次读到时后面跟着「还有 483 行」，第二次读时跟着
 * 「还有 429 行」，连着正文一起比就永远比不相等，这本账会静默地一次都不命中。
 */
const FOOTER = /^\[(?:Showing lines |Truncated|Line \d+ is |First line exceeds |\d+ more lines in file).*\]$/;

interface Body {
	lines: string[];
	footer: string | null;
}

function splitFooter(text: string): Body {
	const lines = text.split("\n");
	let end = lines.length;
	while (end > 0 && (lines[end - 1] as string).trim() === "") end--;
	const last = lines[end - 1];
	if (end > 0 && last !== undefined && FOOTER.test(last.trim())) {
		let body = end - 1;
		while (body > 0 && (lines[body - 1] as string).trim() === "") body--;
		return { lines: lines.slice(0, body), footer: last.trim() };
	}
	return { lines, footer: null };
}

export interface RepeatVerdict {
	/** true 表示这一段原样给过，调用方该把正文换成 `note`。 */
	repeat: boolean;
	note: string;
}

const NOT_A_REPEAT: RepeatVerdict = { repeat: false, note: "" };

function forget(ledger: ReadLedger, path: string): void {
	const entry = ledger.paths.get(path);
	if (entry === undefined) return;
	ledger.chars -= entry.chars;
	ledger.paths.delete(path);
}

/** 上下文被压缩，上文里那些副本没了：整本账作废。 */
export function forgetAllReads(ledger: ReadLedger): void {
	ledger.paths.clear();
	ledger.chars = 0;
	ledger.outlined.clear();
	ledger.surrounded.clear();
	ledger.surroundings.parents.clear();
	ledger.surroundings.constants.clear();
}

function trim(ledger: ReadLedger): void {
	while (ledger.chars > MAX_CHARS && ledger.paths.size > 1) {
		let oldest: string | null = null;
		let oldestTouch = Number.POSITIVE_INFINITY;
		for (const [path, entry] of ledger.paths) {
			if (entry.touched < oldestTouch) {
				oldestTouch = entry.touched;
				oldest = path;
			}
		}
		if (oldest === null) return;
		forget(ledger, oldest);
	}
}

/** 「第 1–969 行」/「第 970 行」。 */
const span = (from: number, to: number): string =>
	from === to ? `第 ${String(from)} 行` : `第 ${String(from)}–${String(to)} 行`;

/** 哪几次调用给过这一段。 */
function coveredBy(entry: PathEntry, from: number, to: number): Delivery[] {
	return entry.deliveries.filter((delivery) => delivery.from <= to && delivery.to >= from);
}

/**
 * 记下这次 `read`，并回答「这一段是不是原样给过」。
 *
 * `text` 是 `read` 这次返回的全部正文（含 pi 追加的那行方括号提示）；
 * `offset` 是调用方给的起始行号，没给就是 1。
 */
export function noteRead(
	ledger: ReadLedger,
	input: { path: string; offset?: number | undefined; text: string },
): RepeatVerdict {
	ledger.reads += 1;
	const seq = ledger.reads;
	const { lines, footer } = splitFooter(input.text);
	const start = Math.max(1, Math.trunc(input.offset ?? 1));
	const end = start + lines.length - 1;
	if (lines.length === 0 || input.text.length < MIN_CHARS) return NOT_A_REPEAT;

	const existing = ledger.paths.get(input.path);
	const entry: PathEntry = existing ?? { lines: new Map(), deliveries: [], chars: 0, touched: 0 };
	entry.touched = seq;

	// 先判「全都给过而且一个字没变」，再决定要不要记。
	let allSeen = existing !== undefined;
	let changed = false;
	for (const [index, line] of lines.entries()) {
		const known = entry.lines.get(start + index);
		if (known === undefined) allSeen = false;
		else if (known !== line) changed = true;
	}

	if (changed) {
		// 这一段的内容变了：照常发全文，并把这几行的记录换成新的。
		//
		// **只换这几行，不清整个文件的账。** 一次编辑改的是三五行，把一千四百行的记录
		// 一起丢掉，等于因为三行忘掉全部。剩下那些旧记录也不会变成错的判据：这本账的
		// 每一条主张都是「第 N 行这段文字，在上文里原样出现过」，它对「第 N 行现在是什么」
		// 没有任何断言——下一次读到那一行，文字对不上就照常发，对得上就说明模型确实
		// 见过这一行的这段文字。
		if (existing === undefined) ledger.paths.set(input.path, entry);
		recordLines(ledger, input.path, start, lines, seq);
		return NOT_A_REPEAT;
	}

	if (allSeen) {
		const sources = coveredBy(entry, start, end);
		const who =
			sources.length === 0
				? "上文里已经有了"
				: sources
						.slice(-3)
						.map((delivery) => `第 ${String(delivery.seq)} 次 read 给过${span(delivery.from, delivery.to)}`)
						.join("、");
		entry.deliveries.push({ seq, from: start, to: end });
		return {
			repeat: true,
			note:
				`${input.path} ${span(start, end)}：这 ${String(lines.length)} 行本次会话已经原样给过了` +
				`（${who}），逐行比过，内容一个字没变，所以这次不再重复发一遍。\n` +
				`要用就翻上文里那一份。${footer === null ? "" : `文件现状：${footer}\n`}` +
				`这条提示只在「同一段、逐行内容都没变」时出现：改过的行对不上就照常发全文，` +
				`上下文被压缩之后这本账也会清空。`,
		};
	}

	if (existing === undefined) ledger.paths.set(input.path, entry);
	recordLines(ledger, input.path, start, lines, seq);
	return NOT_A_REPEAT;
}

function recordLines(ledger: ReadLedger, path: string, start: number, lines: readonly string[], seq: number): void {
	const entry = ledger.paths.get(path);
	if (entry === undefined) return;
	for (const [index, line] of lines.entries()) {
		const at = start + index;
		const known = entry.lines.get(at);
		if (known !== undefined) entry.chars -= known.length;
		entry.lines.set(at, line);
		entry.chars += line.length;
	}
	entry.deliveries.push({ seq, from: start, to: start + lines.length - 1 });
	ledger.chars = [...ledger.paths.values()].reduce((sum, row) => sum + row.chars, 0);
	trim(ledger);
}
