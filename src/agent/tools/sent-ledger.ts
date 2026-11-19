/**
 * 已发账：同样的内容一次会话只发一次（S34 批 1.6）。
 *
 * 真机 16 次会话量出来，cosmic 自己的工具返回有 34% 是前面原样发过的（按入库
 * 原始行口径 12.47%）：同一个探针或打印再跑一次，没变的部分——实体信息、编码
 * 规则、模板结构、格子列表——又全发一遍。模型每一轮都要把前面全部内容重看一遍，
 * 重复的内容会把真正的新结果淹掉。
 *
 * 和读取账（read-ledger.ts）同一个思路、同一本账的另一种条目：这本账记的是
 * **这次会话里已经原样发给模型的行**。新返回里和前面一模一样的连续段落，
 * 折成一句「M 行与前面发过的相同：<首行开头> ～ <末行开头>」。
 *
 * 四条边界，都从「折掉的是背景、留下的是结果」推出来：
 *
 *   - **结果行永不折。** 断言（PASS/FAIL/✔✘/断言）、差异（+/−/@@）、失败原因
 *     （[PROBE-ERR] 等告警行）、写入结果（已落库/未落库/已写入/中止）、验证与
 *     交付（验证记录/回执）这些模式命中的行原样保留，并且**隔断**可折的段——
 *     一段背景中间夹着一条断言，就折成两段，断言还在原处。
 *   - **只折前面原样出现过的行。** 这一次新出现的行照发。行内容变过（哪怕只差
 *     一个数字）就对不上，照发——「内容变了还说发过」这种错不会发生。
 *   - **小返回不折。** 整份正文不到 1 KB 的原样发：它多半就是这次要的答案，折了省不下几个字。
 *   - **压缩时整本清空。** 这本账的全部主张是「这一段在上文里」，压缩之后不在了，
 *     再折就是让模型去找一段不存在的内容。
 *
 * 标记只说模型自己核对得了的东西（S42 §16.12）：折掉的首末两行开头几个字。以前写的是
 * 「第 X–Y 行共 M 行与第 N 次调用相同」——N 是这本账自己数的正文段数，行号只数这一段
 * 正文，模型手里没有一样对得上：真机一次读工具栏，11 个按钮折成三段，它认不出折掉的是
 * 哪几个，只好换个探针再查。同理，折完省不下一半字节的段照发：短行短段折成标记，
 * 模型还得解码，换来的字节可以忽略。
 */

/** 一行至少多少字节才参与折叠。和会话尺子同一条线：严格大于 40 个 UTF-8 字节。 */
const MIN_LINE_BYTES = 41;

/**
 * 连续多少行相同才值得折。两行 40+ 字节的背景（80+ 字节）换一句标记就省得出意义；
 * S10 基线会话的回放量过：三行的门槛只把重复率压到 12.6%，两行压到 5.5%（1.8）。
 */
export const FOLD_MIN_RUN = 2;

/**
 * 整份正文不到这么多字节就一行不折（行照样入账）。
 *
 * 小返回本身就是答案：操作之后把那张单再查一遍，回来的就一行数据，值没变所以和前面逐字相同——折掉之后模型
 * 看得到「和前面一样」，看不到值，只好再取一遍（真机 2026-10-11：查单据状态那一行被折，多绕两轮）。
 * 这么小的正文折了也省不出什么：19 份基线会话重放，不折 1 KB 以下的正文每场多发 0.3 KB（已发账一共省 9.9 KB）。
 */
export const FOLD_MIN_TEXT_BYTES = 1024;

/** 尺子重放不同门槛用。 */
export interface FoldLimits {
	minRun?: number;
	minTextBytes?: number;
}

/** 这本账最多记多少行。超了丢最早的（丢掉只会让重读照常发全文，退回改动前）。 */
const MAX_ENTRIES = 60_000;

/** 标记里每一头留几个字。 */
const HEAD_CHARS = 20;

/** 结果行的模式：命中就永不折叠，并且隔断可折段（见文件头）。 */
const PROTECTED: readonly RegExp[] = [
	/\[PROBE-JSON\]/,
	/\[PROBE-ERR\]|\[PROBE-WARN\]|\[RUNTIME-WARN\]|\[PLATFORM-WARN\]|\[IMPACT-WARN\]/,
	/\bPASS\b|\bFAIL\b|[✔✘]|断言/,
	/未落库|已落库|已写入|已修改|已执行|中止|失败/,
	/验证记录|回执|交付/,
	/^\s*(?:[+\-@]{1,3}\s|\d+[am]?\d*\s)/, // diff 的行前缀
	/^（\d+ 行与前面发过的相同：/, // 折叠标记自己
];

function protectedLine(line: string): boolean {
	return PROTECTED.some((pattern) => pattern.test(line));
}

const encoder = new TextEncoder();

const bytesOf = (lines: readonly string[]): number =>
	lines.reduce((sum, line) => sum + encoder.encode(line).length + 1, 0);

/** 一行去掉缩进和行首 `[PROBE]` 这类标签，留开头几个字。 */
function headOf(line: string): string {
	const chars = [...line.replace(/^\s*(?:\[[A-Z-]+\])?\s*/, "").trimEnd()];
	return chars.length <= HEAD_CHARS ? chars.join("") : `${chars.slice(0, HEAD_CHARS).join("")}…`;
}

export interface SentLedger {
	/** 这次会话里已经原样发过的行。 */
	lines: Set<string>;
}

export function createSentLedger(): SentLedger {
	return { lines: new Set() };
}

/** 上下文被压缩、或切了分支：上文里那些副本没了，整本作废。 */
export function forgetAllSent(ledger: SentLedger): void {
	ledger.lines.clear();
}

export interface FoldVerdict {
	/** 折完的文字。没有可折段时与输入相同。 */
	text: string;
	/** 折掉的行数（不含标记本身）。 */
	foldedLines: number;
	/** 折掉的 UTF-8 字节（扣除标记带来的新增）。 */
	foldedBytes: number;
}

/**
 * 记下这次发送，并返回折掉已发段之后的文字。`limits` 只给尺子重放不同门槛用，正常发送不传。
 *
 * 先判再记：只有账里**已经有**的行才可折；这一次的行在判定之后才入账，
 * 所以同一份返回里自己重复的段落不会被折（那是 record-budget 的同形折叠该管的事）。
 */
export function foldSentLines(ledger: SentLedger, text: string, limits: FoldLimits = {}): FoldVerdict {
	const minRun = limits.minRun ?? FOLD_MIN_RUN;
	const lines = text.split("\n");
	if (lines.length === 1 || encoder.encode(text).length < (limits.minTextBytes ?? FOLD_MIN_TEXT_BYTES)) {
		for (const line of lines) record(ledger, line);
		return { text, foldedLines: 0, foldedBytes: 0 };
	}
	const out: string[] = [];
	let foldedLines = 0;
	let foldedBytes = 0;
	let run: string[] = [];

	const flush = (): void => {
		const first = run[0];
		const last = run[run.length - 1];
		const marker =
			run.length < minRun || first === undefined || last === undefined
				? undefined
				: `（${String(run.length)} 行与前面发过的相同：${headOf(first)} ～ ${headOf(last)}）`;
		const saved = marker === undefined ? 0 : bytesOf(run) - bytesOf([marker]);
		if (marker === undefined || saved * 2 < bytesOf(run)) {
			out.push(...run);
		} else {
			foldedLines += run.length;
			foldedBytes += saved;
			out.push(marker);
		}
		run = [];
	};

	for (const line of lines) {
		const foldable = !protectedLine(line) && encoder.encode(line).length >= MIN_LINE_BYTES && ledger.lines.has(line);
		if (!foldable) {
			flush();
			out.push(line);
			continue;
		}
		run.push(line);
	}
	flush();

	for (const line of lines) record(ledger, line);
	if (ledger.lines.size > MAX_ENTRIES) {
		for (const key of [...ledger.lines].slice(0, ledger.lines.size - MAX_ENTRIES)) ledger.lines.delete(key);
	}
	return { text: out.join("\n"), foldedLines, foldedBytes };
}

function record(ledger: SentLedger, line: string): void {
	if (line !== "") ledger.lines.add(line);
}
