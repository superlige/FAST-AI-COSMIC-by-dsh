/**
 * 尺子用的：从用户的一句话里认报错原文、看一份运行输出里有没有它、把一条条运行折成结论。
 *
 * 只给 `scripts/measure-reported-errors.ts` 用，不进产品。它是按写好的规则认的，认不全：
 * 用户贴的话没有异常类名、原文后面没句号就接着说别的、中间带省略号、错一个字，都会认不出或对不上。
 * 所以它数出来的只是线索，每一句都要人翻会话复核。产品里曾经拿它做过交付关卡，因为这个原因撤掉了，
 * 经过见 docs/S68-reported-error-evidence.md。
 *
 * 结论四种：改之前跑出来过、改之后同一条命令不再出现（fixed）；改之后同一条命令还在出现（still）；
 * 跑出来过、改之后没再跑（unverified）；从没跑出来过（never）。
 */

export interface ReportedError {
	/** 异常类名，照用户贴的写法（可能带包名）。 */
	cls: string;
	/** 类名冒号后面那句话；只贴了类名和调用栈的是空串。 */
	message: string;
	/** 调用栈最上面几帧的「类.方法」；没贴调用栈的是空。 */
	frames: string[];
}

/** 一次提问里最多记几条：一条报错带几层 Caused by 是常事，再多就是整份日志了。 */
export const REPORTED_ERRORS_MAX = 4;
/** 原文太短（`null`、`0`）单独拿来比会到处撞上，要连类名一起出现才算。 */
const MESSAGE_ALONE_MIN = 6;
const FRAMES_KEPT = 3;

const CLASS = /(?:[A-Za-z_$][\w$]*\.)*[A-Z][\w$]*(?:Exception|Error)\b/g;
const FRAME = /\bat\s+((?:[A-Za-z_$][\w$]*\.)+)([\w$<>]+)\(/g;

/** 类名去掉包名。 */
export function simpleClassName(cls: string): string {
	return cls.split(".").pop() ?? cls;
}

/**
 * 比对用的写法：去掉空白，带数字的词（单据号、内码、日期、行号）换成 `#`。
 *
 * 出错的环境和测试环境里，同一句报错的单据号、内码不会一样；实体和字段标识是一样的。
 * 所以只抹带数字的词——抹多了（比如抹掉所有标识）两句不相干的报错会被当成同一句。
 */
export function comparableErrorText(text: string): string {
	return text.replace(/[A-Za-z_-]*\d[\w\-.:]*/g, "#").replace(/\s+/g, "");
}

function messageAfter(text: string, from: number): string {
	const rest = text.slice(from);
	const colon = /^\s*[:：]\s*/.exec(rest);
	if (colon === null) return "";
	const line = rest.slice(colon[0].length).split(/\r?\n/, 1)[0] ?? "";
	// 调用栈粘在同一行、后面接着说别的话（「……的属性。把字段都加载了」）都不是原文
	return (line.split(/\s+at\s+[A-Za-z_$][\w$.]*\(/, 1)[0] ?? "").split("。", 1)[0]?.trim() ?? "";
}

function framesAfter(text: string, from: number, until: number): string[] {
	const frames: string[] = [];
	FRAME.lastIndex = 0;
	const span = text.slice(from, until);
	for (let match = FRAME.exec(span); match !== null && frames.length < FRAMES_KEPT; match = FRAME.exec(span)) {
		const owner = (match[1] ?? "").replace(/\.$/, "");
		frames.push(`${simpleClassName(owner)}.${match[2] ?? ""}`);
	}
	return frames;
}

/**
 * 用户这句话里贴的报错。
 *
 * 只认「贴出来的」：类名后面跟着冒号和原文，或者跟着调用栈。需求里提到一个异常类名
 * （「校验不过就抛 KDException」）两样都没有，不算。
 */
export function reportedErrors(prompt: string): ReportedError[] {
	const found: ReportedError[] = [];
	const matches = [...prompt.matchAll(CLASS)];
	for (const [index, match] of matches.entries()) {
		if (found.length >= REPORTED_ERRORS_MAX) break;
		const cls = match[0];
		const end = (match.index ?? 0) + cls.length;
		const message = messageAfter(prompt, end);
		const next = matches[index + 1]?.index ?? prompt.length;
		const frames = framesAfter(prompt, end, next);
		if (message === "" && frames.length === 0) continue;
		if (found.some((entry) => simpleClassName(entry.cls) === simpleClassName(cls) && entry.message === message)) {
			continue;
		}
		found.push({ cls, message, frames });
	}
	return found;
}

/** 这份输出里有没有这条报错。 */
export function errorShownIn(error: ReportedError, output: string): boolean {
	const hasClass = output.includes(simpleClassName(error.cls));
	if (error.message !== "") {
		const wanted = comparableErrorText(error.message);
		if (wanted.replace(/#/g, "") === "") return false;
		if (!comparableErrorText(output).includes(wanted)) return false;
		return wanted.length >= MESSAGE_ALONE_MIN || hasClass;
	}
	const top = error.frames[0];
	return hasClass && top !== undefined && output.includes(top);
}

/** 给人看的一行：类名和原文，过长截断。 */
export function errorLabel(error: ReportedError, max = 100): string {
	const text =
		error.message !== ""
			? `${simpleClassName(error.cls)}: ${error.message}`
			: `${simpleClassName(error.cls)}（${error.frames[0] ?? "无调用栈"}）`;
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * 一条命令和这条报错的关系：第一次跑出它是什么时候，最后一次跑是什么时候、出没出现。
 *
 * 「同一条命令」由调用方定键：运行是去掉断言的参数，探针是名字加输入，临时探针再加源码摘要——
 * 探针改写过就是另一条命令，不能拿改写后不再抛错的探针当成「错没了」。
 */
export interface ErrorSighting {
	key: string;
	/** 给人看的命令写法。 */
	command: string;
	firstShownAt: string;
	lastAt: string;
	lastShown: boolean;
}

/** 一批记录最多留几条命令；超了丢最早跑出来的。 */
export const SIGHTINGS_MAX = 12;

/**
 * 记下一次运行。
 *
 * 没出现报错、这条命令以前也没跑出过的，不记：它和这条报错没关系。
 */
export function noteSighting(
	sightings: readonly ErrorSighting[],
	run: { key: string; command: string; at: string; shown: boolean },
): ErrorSighting[] {
	const known = sightings.find((entry) => entry.key === run.key);
	if (known === undefined) {
		if (!run.shown) return [...sightings];
		const added = [
			...sightings,
			{ key: run.key, command: run.command, firstShownAt: run.at, lastAt: run.at, lastShown: true },
		];
		return added.slice(Math.max(0, added.length - SIGHTINGS_MAX));
	}
	return sightings.map((entry) => (entry === known ? { ...entry, lastAt: run.at, lastShown: run.shown } : entry));
}

export type ReportedErrorStatus = "fixed" | "still" | "unverified" | "never";

export interface ReportedErrorVerdict {
	status: ReportedErrorStatus;
	/** 结论依据的那条命令；never 时没有。 */
	command: string | null;
}

function after(at: string, than: string): boolean {
	const a = Date.parse(at);
	const b = Date.parse(than);
	return !Number.isNaN(a) && !Number.isNaN(b) && a > b;
}

/**
 * 把记录折成结论。`lastChangeAt` 是本次交付最后一次改动（改业务代码、写共享环境）的时间。
 *
 * 先后次序：有一条命令修好了就是 fixed，哪怕另一条（直接调平台接口、走不到改动的探针）照旧抛错；
 * 没有修好的，改动之后还跑出过就是 still。
 */
export function reportedErrorStatus(sightings: readonly ErrorSighting[], lastChangeAt: string): ReportedErrorVerdict {
	const fixed = sightings.find(
		(entry) => !after(entry.firstShownAt, lastChangeAt) && after(entry.lastAt, lastChangeAt) && !entry.lastShown,
	);
	if (fixed !== undefined) return { status: "fixed", command: fixed.command };
	const still = sightings.find((entry) => after(entry.lastAt, lastChangeAt) && entry.lastShown);
	if (still !== undefined) return { status: "still", command: still.command };
	const shown = sightings[0];
	if (shown !== undefined) return { status: "unverified", command: shown.command };
	return { status: "never", command: null };
}
