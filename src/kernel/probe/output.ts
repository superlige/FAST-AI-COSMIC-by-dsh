/**
 * What a probe run actually said: the machine-readable bypass and the human
 * channel (S5.2).
 *
 * Two channels, deliberately not one:
 *
 *   - `[PROBE-JSON] {…}` lines are the bypass. `verify` grades on these and
 *     never on the Chinese prose, because prose drifts with every wording change
 *     and a regex over it breaks silently. The prefix must stay identical to
 *     `probes/ProbeJson.java`'s PREFIX; changing one side only is a half change.
 *   - the human channel drops what it can name as platform noise and keeps the
 *     rest. A Cosmic cold start prints thousands of lines of SQL, ZooKeeper and
 *     cache logging, and it also catches and prints recoverable exceptions.
 *
 * It used to be the other way round: keep the `[PROBE…]` lines, drop everything
 * else. Every line nobody had thought to allow then vanished without a word --
 * an ad-hoc probe's bare `println`, a plugin's own `log.info`, the second line of
 * a multi-line cell value -- and the reader went round the tool to grep the raw
 * file (S37 2-A.1: 607 lines of one ad-hoc probe, three greps for plugin logs).
 * A noise list errs the other way: something unrecognised costs a few lines of
 * budget, not the answer.
 *
 * Everything here is pure text processing, which is the reason it is a module of
 * its own: the parts that talk to Cosmic can only be checked by running a real
 * probe, and this part must be checkable without one.
 *
 * A stack that was NOT introduced by `[PROBE-ERR]` is folded but never dropped
 * without a word: "unattributed" is not the same claim as "proven unrelated",
 * and the summary says so.
 */

export const JSON_PREFIX = "[PROBE-JSON] ";

/** One `[PROBE-JSON]` record. Always an object; see collectJsonRecords. */
export type ProbeJsonRecord = Record<string, unknown>;

export interface ProbeJsonHarvest {
	records: ProbeJsonRecord[];
	/**
	 * Lines that carried the prefix but could not be used. Never swallowed: a
	 * probe emitting malformed JSON is a bug in that probe, and dropping the line
	 * turns it into "I emitted it but nothing arrived", which sends the reader
	 * looking in the wrong place entirely.
	 */
	broken: string[];
}

/** Extracts the JSON bypass records from a probe's merged stdout/stderr. */
export function collectJsonRecords(out: string): ProbeJsonHarvest {
	const records: ProbeJsonRecord[] = [];
	const broken: string[] = [];
	for (const line of String(out).split(/\r?\n/)) {
		const at = line.indexOf(JSON_PREFIX);
		if (at < 0) continue;
		const body = line.slice(at + JSON_PREFIX.length).trim();
		if (body === "") {
			broken.push("");
			continue;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(body);
		} catch {
			broken.push(body.slice(0, 200));
			continue;
		}
		// One JSON OBJECT per line. An array or a bare scalar parses fine but every
		// consumer downstream reads fields off it, so letting one through only
		// explodes at grading time -- a long way from where it was produced.
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			broken.push(body.slice(0, 200));
			continue;
		}
		records.push(parsed as ProbeJsonRecord);
	}
	return { records, broken };
}

export const isJsonLine = (line: string): boolean => line.includes(JSON_PREFIX);

export interface RuntimeExceptionGroup {
	/** The ERROR log line that preceded the stack, when there was one. */
	header: string;
	exception: string;
	causes: string[];
	frames: number;
	/**
	 * The first few `at` frames under the INNERMOST link of this group.
	 *
	 * Kept because a folded group used to arrive as a class name and a message and
	 * nothing else. On the real ledger that produced 「java.lang.NullPointerException」
	 * with no call site at all, and there is no way to tell a platform defect from a
	 * defect in the plugin under test without one -- the run stopped there with no
	 * next step to copy. Three frames name the throw site and its caller; the rest
	 * stays in the raw channel.
	 */
	innerFrames: string[];
}

export interface FilteredProbeOutput {
	all: string[];
	/**
	 * The human channel: every line that is not recognised platform noise. Log
	 * records the platform did not write are kept in a compact `LEVEL logger: message`
	 * form; stacks a `[PROBE-ERR]` introduced are kept whole.
	 */
	lines: string[];
	/** Stack frames folded away. Counts frames, not filtered lines. */
	dropped: number;
	exceptions: RuntimeExceptionGroup[];
}

const isFrame = (line: string): boolean =>
	/^\s+(at |\.\.\.\s*\d+ (more|common frames omitted))/.test(line) ||
	/^\s*(Caused by: |Suppressed: )/.test(line) ||
	/^\s*[\w.$]+(Exception|Error|Throwable)(:|$)/.test(line);

const isExceptionHead = (line: string): boolean => /^\s*[\w.$]+(Exception|Error|Throwable)(:|$)/.test(line);
const isCause = (line: string): boolean => /^\s*(Caused by: |Suppressed: )/.test(line);

/**
 * Frames kept per folded exception group. Three names the throw site, its caller
 * and one more -- enough to place the failure -- without re-importing the
 * hundred-frame stacks the folding exists to remove.
 */
const INNER_FRAMES_KEPT = 3;

/**
 * One platform log record's first line, in the layout Cosmic's logback prints:
 * `2026-09-22 17:30:10.328  INFO   --- [thread] DB    : {traceId:…} message`.
 * The logger name is abbreviated to fit 40 columns (`kd.bos.print.core.X` ->
 * `k.b.p.core.X`) and, past that, cut from the left (`.w.e.i.c.t.X`).
 *
 * The pattern comes from the project's own logback.xml, so the pid, the `---`,
 * the thread and the milliseconds are all optional here.
 */
const LOG_HEAD =
	/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:[.,]\d+)?\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s+(?:\d+\s+)?(?:---\s+)?(?:\[.*?\]\s+)?([\w.$-]+)\s*(?::\s?|\s)(.*)$/;

/** logback's own start-up chatter: `17:30:21,320 |-INFO in ch.qos.logback…`. */
const LOGBACK_STATUS = /^\d\d:\d\d:\d\d,\d{3} \|-(INFO|WARN|ERROR) in /;

/**
 * Output the platform prints straight to stdout between two markers of its own,
 * with no log header to hang it on. The one seen so far is the whole logback.xml,
 * dumped on every cold start; it has blank lines inside, so only the closing
 * marker can end it.
 */
const NOISE_BLOCKS: readonly { open: RegExp; close: RegExp }[] = [
	{ open: /^-----log\.config value-----$/, close: /^-----log\.config doConfigure success-----/ },
];

/**
 * Package roots that belong to the platform and the libraries it ships, full and
 * abbreviated. A logger is platform when its first segment is one of these, or
 * when it is one of the bare names Cosmic's SQL tracing logs under.
 */
const PLATFORM_ROOTS = new Set(["kd", "k", "org", "o", "com", "c", "ch", "io", "net", "sun", "java", "javax", "jdk"]);
const PLATFORM_BARE_LOGGER = /^(DB|KSQL[\w-]*)$/;

/**
 * Whether a (possibly abbreviated) logger name falls under one of the project's
 * own package prefixes: `z.zljy.printplugin.X` is under `zlgd.`, because logback
 * shortened `zlgd` to `z`.
 *
 * A prefix that is itself a platform root says nothing -- a project whose classes
 * all sit under `kd.` would otherwise claim every platform logger as its own.
 */
function isOwnLogger(logger: string, ownPackages: readonly string[]): boolean {
	const segments = logger.split(".");
	return ownPackages.some((prefix) => {
		const own = prefix.split(".").filter((segment) => segment !== "");
		if (own.length === 0 || (own.length === 1 && PLATFORM_ROOTS.has(own[0] as string))) return false;
		if (segments.length <= own.length) return false;
		return own.every((segment, i) => {
			const seen = segments[i] as string;
			return seen !== "" && segment.startsWith(seen);
		});
	});
}

/** The logger column's width in the layout above (`%-40.40logger{39}`). */
const LOGGER_COLUMN = 40;

/**
 * A logger name logback had to cut from the left: its root is gone
 * (`b.o.d.DataEntityLocalCacheCleanupManager` was `k.b.o.d.…`). Only deep
 * packages get that long, and those are the platform's -- on the real runs every
 * cut name was, while the project's own abbreviated to well under the column.
 */
const isCutLogger = (logger: string): boolean =>
	logger.startsWith(".") || (logger.length === LOGGER_COLUMN && /^\w\./.test(logger));

function isPlatformLogger(logger: string, ownPackages: readonly string[]): boolean {
	if (isOwnLogger(logger, ownPackages)) return false;
	if (PLATFORM_BARE_LOGGER.test(logger) || isCutLogger(logger)) return true;
	return PLATFORM_ROOTS.has(logger.split(".")[0] as string);
}

/**
 * A kept log record's first line, without the timestamp, thread and request id.
 * Those change on every run, and the repeat check compares kept lines: with them
 * in, two runs that said the same thing would never compare equal.
 */
const compactLog = (level: string, logger: string, message: string): string =>
	`${level} ${logger}: ${message.replace(/^\{traceId:[^}]*\}\s*/, "")}`;

/**
 * Splits a probe's output into the human channel and the unattributed runtime
 * exceptions.
 *
 * What counts as noise: a platform log record (its header and every line up to
 * the next blank line -- that is where an SQL trace's statement and parameters
 * sit), logback's start-up status, the platform's marked stdout blocks, and stack
 * traces nobody introduced (folded into `exceptions`, together with the message
 * lines between the exception and its first frame). Everything else is kept.
 *
 * The JSON bypass does not reset `keepProbeStack`: a bypass line can sit between
 * a `[PROBE-ERR]` and the stack trace it introduced, and treating it as a
 * boundary would fold exactly the stack the caller asked to see.
 */
export function filterProbeOutput(out: string, ownPackages: readonly string[] = []): FilteredProbeOutput {
	const all = String(out).split(/\r?\n/);
	const lines: string[] = [];
	const exceptions: RuntimeExceptionGroup[] = [];
	let keepProbeStack = false;
	// 当前这条 `[PROBE-ERR]` 的异常消息里，第一行之后的那几行（见下方 errMessage 的用法）。
	let errMessage: Set<string> | null = null;
	let errFramesStarted = false;
	let dropped = 0;
	let pendingErrorHeader = "";
	let current: RuntimeExceptionGroup | null = null;
	// 平台日志的续行（SQL 语句、参数）：到下一个空行为止都算这条日志的。
	let platformRecord = false;
	// 未归属异常的首行和第一条 `at` 之间的消息续行（平台常把 SQL、上下文塞进异常消息）。
	let inExceptionMessage = false;
	let block: RegExp | null = null;

	const endStack = (): void => {
		keepProbeStack = false;
		errMessage = null;
		errFramesStarted = false;
		current = null;
	};

	for (const line of all) {
		if (isJsonLine(line)) continue;
		if (block !== null) {
			if (block.test(line)) block = null;
			continue;
		}
		if (/\[PROBE/.test(line)) {
			lines.push(line);
			keepProbeStack = /\[PROBE-ERR\]/.test(line);
			errMessage = keepProbeStack ? new Set() : null;
			errFramesStarted = false;
			pendingErrorHeader = "";
			current = null;
			platformRecord = false;
			inExceptionMessage = false;
			continue;
		}
		const head = LOG_HEAD.exec(line);
		if (head !== null) {
			const [, level = "", logger = "", message = ""] = head;
			endStack();
			inExceptionMessage = false;
			pendingErrorHeader = level === "ERROR" ? line.trim() : "";
			platformRecord = isPlatformLogger(logger, ownPackages);
			if (!platformRecord) lines.push(compactLog(level, logger, message));
			continue;
		}
		const opens = NOISE_BLOCKS.find((candidate) => candidate.open.test(line));
		if (opens !== undefined) {
			block = opens.close;
			continue;
		}
		if (LOGBACK_STATUS.test(line)) continue;
		if (isFrame(line)) {
			if (keepProbeStack) {
				lines.push(line);
				if (/^\s+at /.test(line)) errFramesStarted = true;
				continue;
			}
			dropped++;
			platformRecord = false;
			if (/^\s+at /.test(line)) inExceptionMessage = false;
			else if (isExceptionHead(line) || isCause(line)) inExceptionMessage = true;
			if (isExceptionHead(line)) {
				current = { header: pendingErrorHeader, exception: line.trim(), causes: [], frames: 1, innerFrames: [] };
				exceptions.push(current);
			} else {
				if (current === null) {
					current = { header: pendingErrorHeader, exception: "", causes: [], frames: 0, innerFrames: [] };
					exceptions.push(current);
				}
				current.frames++;
				// A `Caused by:` starts a deeper link, so the frames collected so far
				// belonged to a shallower one. Restarting the buffer leaves the innermost
				// link's frames standing when the group ends -- those are the ones that
				// say where it was actually thrown.
				if (isCause(line)) {
					current.causes.push(line.trim());
					current.innerFrames = [];
				} else if (current.innerFrames.length < INNER_FRAMES_KEPT && /^\s+at /.test(line)) {
					current.innerFrames.push(line.trim());
				}
			}
			continue;
		}
		// 多行异常消息的后几行。探针拿一个异常一次报全部问题（`这一批有 13 处问题：\n  - 第 1 条…`），
		// 以前这些行既不带 [PROBE 前缀也不是栈帧，于是第一行之后全被悄悄吃掉，连带把后面的栈
		// 当成「未归属的运行时异常」记进噪声账——2026-09-15 真机：13 条逐项原因一条都没留下，
		// 落盘文件里也只有首行，而那正是要拿去核对、要写进复盘的证据。
		//
		// printStackTrace 会把同一段消息再印一遍，所以已经收过的行只跳过、不重复。
		// 栈帧开始之后出现的新文本就不再算消息，照旧当成边界。
		if (errMessage !== null && line.trim() !== "") {
			if (errMessage.has(line)) continue;
			if (!errFramesStarted) {
				errMessage.add(line);
				lines.push(line);
				continue;
			}
		}

		if (line === "") {
			// 空行结束一条平台日志；空行本身不留，留下的行之间本来就没有版面可言。
			endStack();
			platformRecord = false;
			inExceptionMessage = false;
			pendingErrorHeader = "";
			continue;
		}
		if (platformRecord || inExceptionMessage) continue;

		endStack();
		pendingErrorHeader = "";
		if (line.trim() !== "") lines.push(line);
	}
	return { all, lines, dropped, exceptions };
}

const unique = (values: readonly string[]): string[] => [...new Set(values.filter((value) => value !== ""))];
const clip = (value: string): string => value.replace(/\s+/g, " ").trim().slice(0, 240);

/** How many distinct already-seen groups the degraded block names before it counts the rest. */
const KNOWN_NOISE_LISTED = 4;

/** A folded group's history on this RuntimeKey, as `noise.ts` keeps it. */
export interface SeenBefore {
	/** Runs that carried this group BEFORE the current one. */
	seen: number;
	firstAt: string;
}

/** `2026-09-10T09:11:42.000Z` -> `2026-09-10 09:11`. */
const day = (at: string): string => at.slice(0, 16).replace("T", " ");

/**
 * The already-seen groups, in one block instead of one warning each.
 *
 * It reports a **count and never a verdict**: 「见过 12 次」 is a fact about this
 * environment, 「与本次无关」 would be a claim nothing here can support. What it
 * buys is that the judgement is made once and then recognised, rather than
 * re-made from scratch on every run of the round.
 */
function foldKnownNoise(known: { group: RuntimeExceptionGroup; history: SeenBefore }[]): string[] {
	if (known.length === 0) return [];
	const byId = new Map<string, { label: string; copies: number; history: SeenBefore }>();
	for (const item of known) {
		const label = `${item.group.causes[item.group.causes.length - 1] ?? item.group.exception}`;
		const id = clip(label === "" ? item.group.header : label);
		const row = byId.get(id);
		if (row) row.copies += 1;
		else byId.set(id, { label: id, copies: 1, history: item.history });
	}
	const rows = [...byId.values()].sort((a, b) => b.history.seen - a.history.seen);
	const earliest = known
		.map((item) => item.history.firstAt)
		.sort()
		.at(0);
	const out = [
		`其中 ${known.length} 组是这个环境上的老面孔（${rows.length} 种，最早在 ${day(earliest ?? "")} 就出现过），不再逐条展开：`,
	];
	for (const row of rows.slice(0, KNOWN_NOISE_LISTED)) {
		out.push(`  ${row.label}${row.copies > 1 ? ` ×${row.copies}` : ""}（此前 ${row.history.seen} 次运行都带着它）`);
	}
	if (rows.length > KNOWN_NOISE_LISTED) out.push(`  …另 ${rows.length - KNOWN_NOISE_LISTED} 种`);
	out.push("  「见过很多次」只说明它是这个环境的背景噪声，不等于已证明与本次无关；原文在 raw 通道。");
	return out;
}

/**
 * Folds the unattributed stacks into a few actionable lines. The full text is
 * still reachable: it is stashed on every run.
 *
 * `seenBefore` is what makes a repeat offender cheaper to dismiss the second
 * time than the first. Absent (or returning null), every group is treated as new
 * -- which is what a pure unit test and every caller without a ledger get.
 */
export function summarizeRuntimeExceptions(
	groups: readonly RuntimeExceptionGroup[],
	dropped: number,
	seenBefore: (group: RuntimeExceptionGroup) => SeenBefore | null = () => null,
): string[] {
	if (dropped === 0) return [];

	const missingUdfGroups: RuntimeExceptionGroup[] = [];
	const missingUdfs: string[] = [];
	for (const group of groups) {
		const text = [group.header, group.exception, ...group.causes].join("\n");
		const classes = [...text.matchAll(/ClassNotFoundException:\s*([\w.$]+)/g)].map((match) => match[1] as string);
		if (/FunctionManage/.test(group.header) && classes.length > 0) {
			missingUdfGroups.push(group);
			missingUdfs.push(...classes);
		}
	}

	const out = [
		`检测到 ${groups.length} 组未归属给探针的运行时异常，共 ${dropped} 行栈帧，已折叠；这不等于已证明与本次验证无关。`,
	];

	const udfClasses = unique(missingUdfs);
	if (udfClasses.length > 0) {
		// Never degraded by repetition. Unlike the stacks below this is a conditional
		// CONCLUSION -- 「若目标规则引用它们，本次规则结果不能作为验收依据」 -- and that
		// stays true on the twelfth run exactly as it was on the first. Only the
		// "have I seen this before" part is answered, so the reader can tell an
		// environment that has always been missing these from one that just broke.
		const history = missingUdfGroups.map((group) => seenBefore(group)).filter((seen) => seen !== null);
		const ambient =
			history.length === missingUdfGroups.length && history[0] !== undefined
				? `（这个环境一直如此：此前 ${Math.max(...history.map((seen) => seen.seen))} 次运行都带着它，最早 ${day(history.map((seen) => seen.firstAt).sort()[0] ?? "")}）`
				: "";
		out.push(
			`[PLATFORM-WARN] FunctionManage 无法加载 ${udfClasses.length} 个已登记函数类${ambient}；若目标规则引用它们，本次规则结果不能作为验收依据：`,
		);
		for (const cls of udfClasses.slice(0, 8)) out.push(`  ${cls}`);
		if (udfClasses.length > 8) out.push(`  …另 ${udfClasses.length - 8} 个`);
	}

	const rest = groups.filter((group) => !missingUdfGroups.includes(group));
	const known: { group: RuntimeExceptionGroup; history: SeenBefore }[] = [];
	const generic: RuntimeExceptionGroup[] = [];
	for (const group of rest) {
		const history = seenBefore(group);
		if (history === null) generic.push(group);
		else known.push({ group, history });
	}
	out.push(...foldKnownNoise(known));
	for (const group of generic.slice(0, 3)) {
		const root = group.causes[group.causes.length - 1] ?? (group.exception !== "" ? group.exception : group.header);
		if (root === undefined || root === "") continue;
		out.push(`[RUNTIME-WARN] ${clip(root)}`);
		// The call site, not just the class name: without it 「NullPointerException」
		// is a fact with no address, and the reader cannot tell whether it belongs to
		// the platform or to the code under test.
		for (const frame of group.innerFrames) out.push(`  ${clip(frame)}`);
	}
	if (generic.length > 3) out.push(`[RUNTIME-WARN] …另 ${generic.length - 3} 组`);
	out.push("完整运行时日志在 raw 通道；原文可能包含 SQL、参数和环境配置，只在本机诊断。");
	return out;
}
