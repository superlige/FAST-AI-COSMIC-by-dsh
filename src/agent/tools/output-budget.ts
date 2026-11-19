/**
 * The context budget for tool output (D14.2).
 *
 * A probe that dumps 1,674 metadata fields is doing its job; putting all 42 KB
 * of it into the model's context four times over is not. The frozen skill's
 * answer was a sentence telling the model to grep the spill file instead of
 * re-reading the output, which is the shape of rule this project has learned to
 * distrust: it was violated, repeatedly, and the token bill was the receipt.
 *
 * So the text is cut before it is handed over, and the full copy goes to a file.
 * The cut keeps both ends. A truncated-tail-only view loses the exception that
 * ended the run; a head-only view loses the assertion that started it, and the
 * retro's own example -- "参数计算完成 1 个试样" in the first lines, the failing
 * assertion in the last -- needed both halves to be read together.
 *
 * This lives at the agent boundary on purpose. The kernel keeps returning the
 * whole string: the CLI has a terminal and a pager, no context window, and no
 * reason to pay for this.
 */

/** Default cut. Roughly a screenful each end -- enough to see what happened. */
export const DEFAULT_OUTPUT_BUDGET = 4000;

/**
 * 知识库 `show` 的整篇正文从这么大起只给头尾（S37 批 5）。
 *
 * 文档是要读的，不能按探针输出的 4 KB 裁：历史会话 13 次 show，一半在 7.6 KB 以下，
 * 超过 16 KB 的只有 3 次（18、25、70 KB）。70 KB 那次是整份 WorkflowServiceHelper 接口文档，
 * 约 2 万 token，之后每一轮都背着；方法说明本来有 `api` 按类、按方法查。
 */
export const KNOWLEDGE_SHOW_BUDGET = 16000;

export interface BudgetedOutput {
	/** What the model sees. Equal to the input when nothing was cut. */
	shown: string;
	truncated: boolean;
	totalBytes: number;
	totalLines: number;
	omittedLines: number;
	/** 1-based line numbers of the omitted span, for a targeted re-read. */
	omittedFrom: number | null;
	omittedTo: number | null;
}

const encoder = new TextEncoder();

function byteLength(text: string): number {
	return encoder.encode(text).length;
}

function takeBytes(text: string, limit: number, fromEnd = false): string {
	if (limit <= 0) return "";
	const chars = [...text];
	if (fromEnd) chars.reverse();
	const kept: string[] = [];
	let bytes = 0;
	for (const char of chars) {
		const cost = byteLength(char);
		if (bytes + cost > limit) break;
		kept.push(char);
		bytes += cost;
	}
	if (fromEnd) kept.reverse();
	return kept.join("");
}

/**
 * Head and tail of `text` within `limitBytes`, cut on line boundaries.
 *
 * Lines, not bytes, because the omitted span has to be nameable: "第 41–892 行"
 * is something the caller can go read, "中间 38 KB" is not.
 */
export function budgetOutput(text: string, limitBytes: number = DEFAULT_OUTPUT_BUDGET): BudgetedOutput {
	const totalBytes = byteLength(text);
	const lines = text.split("\n");
	if (totalBytes <= limitBytes) {
		return {
			shown: text,
			truncated: false,
			totalBytes,
			totalLines: lines.length,
			omittedLines: 0,
			omittedFrom: null,
			omittedTo: null,
		};
	}

	const widestMarker = `… 中间省略 ${String(lines.length)} 行（第 ${String(lines.length)}–${String(lines.length)} 行）…`;
	const contentBudget = Math.max(0, limitBytes - byteLength(widestMarker) - 2);
	const headBudget = Math.floor(contentBudget * 0.6);
	const tailBudget = contentBudget - headBudget;

	let head = 0;
	let headBytes = 0;
	while (head < lines.length) {
		const cost = byteLength(lines[head] as string) + 1;
		if (headBytes + cost > headBudget) break;
		headBytes += cost;
		head++;
	}

	let tail = lines.length;
	let tailBytes = 0;
	while (tail > head) {
		const cost = byteLength(lines[tail - 1] as string) + 1;
		if (tailBytes + cost > tailBudget) break;
		tailBytes += cost;
		tail--;
	}

	const omittedLines = tail - head;
	if (omittedLines <= 0) {
		// A generated identifier/list can be one enormous line. Keeping it whole
		// breaks the budget completely, so cut on Unicode code-point boundaries.
		const marker = "… 中段按字节省略，全文见 outputFile …";
		const room = Math.max(0, limitBytes - byteLength(marker) - 2);
		const headRoom = Math.floor(room * 0.6);
		return {
			shown: `${takeBytes(text, headRoom)}\n${marker}\n${takeBytes(text, room - headRoom, true)}`,
			truncated: true,
			totalBytes,
			totalLines: lines.length,
			omittedLines: 0,
			omittedFrom: null,
			omittedTo: null,
		};
	}

	// 标记只说省了哪几行；怎么取回由 outputBudget.remedy 说，它知道这个工具有没有 raw 取回。
	const marker = `… 中间省略 ${String(omittedLines)} 行（第 ${String(head + 1)}–${String(tail)} 行）…`;
	return {
		shown: [...lines.slice(0, head), marker, ...lines.slice(tail)].join("\n"),
		truncated: true,
		totalBytes,
		totalLines: lines.length,
		omittedLines,
		omittedFrom: head + 1,
		omittedTo: tail,
	};
}

// --------------------------------------------------------------- api answers

/**
 * The `api` answer's context budget.
 *
 * Measured on a real session: twelve single-class `api` calls returned 262 KB
 * between them -- 21% of the entire context -- because every class ships every
 * method's full javadoc, and the caller was only trying to satisfy the probe
 * import gate ("have you looked this class up"), not to read prose. One class
 * alone (`QueryServiceHelper`) was 43 KB.
 *
 * Two cuts, and neither one loses a fact the caller cannot get back:
 *
 *   1. `join` and `methods` are the same data twice -- `methods` is the rendered
 *      form of `join.joined`. The structured copy becomes counts.
 *   2. A method's signature line stays; its indented documentation body does
 *      not. The signature is what the gate and the compiler need; the prose is
 *      what `<fqcn>#<method>` fetches when a method is actually being used.
 *
 * This is an agent-boundary cut, like `budgetOutput`: the kernel keeps returning
 * the whole join, because the CLI has a pager and no context window.
 */
export const DEFAULT_API_METHOD_LIMIT = 60;

/** A rendered method's continuation lines are indented; its signature is not. */
const isSignatureLine = (line: string): boolean => line !== "" && !/^\s/.test(line);

export interface BudgetedApiEntry {
	methods: string[];
	/** Signature lines dropped because the class blew the method limit. */
	omittedMethods: number;
	/** True when documentation bodies were dropped from the methods that remain. */
	bodiesDropped: boolean;
}

/**
 * Signature-only view of one class's rendered methods.
 *
 * `full` asks for the untouched list: a single-method query has already narrowed
 * the answer, so cutting it again would leave the caller with nothing but the
 * signature it just asked about.
 */
export function budgetApiMethods(
	methods: readonly string[],
	options: { full?: boolean; limit?: number } = {},
): BudgetedApiEntry {
	if (options.full === true) return { methods: [...methods], omittedMethods: 0, bodiesDropped: false };
	const signatures = methods.filter(isSignatureLine);
	const bodiesDropped = signatures.length !== methods.length;
	const limit = options.limit ?? DEFAULT_API_METHOD_LIMIT;
	if (signatures.length <= limit) return { methods: signatures, omittedMethods: 0, bodiesDropped };
	return {
		methods: signatures.slice(0, limit),
		omittedMethods: signatures.length - limit,
		bodiesDropped,
	};
}

// ------------------------------------------------------- 落盘文件里有什么

/**
 * 被切掉那一段的目录（S20 批 4.1）。
 *
 * 改之前，超预算的返回只给一句「全文在 X；要看省略段就窄条件 grep 它」——路径是给了，
 * 里面有什么没说。真机会话里的后果是模型拿 bash 去猜：41 次 grep 落盘文件，
 * 常常要试两三个条件才命中，而它要找的那一段其实有明确的标题行
 * （`[PROBE] === 宿主 Ap EntryAp key=entryentity 规则 18 条`）。
 *
 * 目录只覆盖**被省略的那一段**：头尾两段已经在返回里，再列一遍是第二份副本。
 */
export interface OutlineEntry {
	/** 1-based，含。 */
	from: number;
	to: number;
	/** 这一段的标题行，或者（没有标题行时）这一段的第一行。 */
	label: string;
	/** 套在几层段里：分录里的子分录是 1。渲染时按它缩进；缺省是 0。 */
	depth?: number;
}

/**
 * 目录的各行加起来最多这么多字节（S43 批 1）。
 *
 * 原来是「最多 8 段」：检测单字段那份 50 个分录，列 8 个等于没列，模型只能凭关键字去捞。
 * 按字节算以后，结构简单的输出照样短，结构多的能列全顶层，放不下才挑最大的几段。
 */
const OUTLINE_BYTES = 2800;

/**
 * 标题行截到多长。够认出是哪一段就行。
 *
 * 顶层段放不下时先一级级截短标签，还放不下才丢段：检测单字段那份 50 个分录，
 * 截到 32 字（分录标识加中文名）就能全列进 2.8 KB；段少的输出照样给 64 字。
 */
const LABEL_WIDTHS = [64, 48, 40, 32] as const;

/** 少于这么多行的省略段不值得做目录：本来就翻得完。 */
const OUTLINE_MIN_LINES = 40;

/** 行首的标签（`[PROBE]`、`[IMPACT]`）。缩进从它后面算。 */
const LINE_TAG = /^\s*\[[A-Z][A-Z0-9-]*\]/;

/**
 * 这一行是不是一段的开头。
 *
 * 去掉行首标签和缩进以后，以分隔记号开头的算：`===`、`---`、`#`、`─`（`[PROBE] === 宿主 Ap …`、
 * `[IMPACT] ─ 某插件`、`── tbmain 下的控件`），或者以 `【…】` 开头的（`【分录】…`、`【点按钮】…`）；
 * 再加上 `[PROBE-ERR]` / `[RUNTIME-WARN]` 这种自带级别的行——它哪怕不是「段」，也正是找全文的人要找的那几行。
 * 认的是写法，不是某个探针：新探针用这几种写法之一打段落标题，目录就认得。
 */
function isSectionHead(line: string): boolean {
	const body = line.replace(LINE_TAG, "").trimStart();
	if (/^(?:={2,}|-{2,}|─|#{1,6}\s|【[^】]+】)/.test(body)) return true;
	return /^\s*\[(?:PROBE-ERR|PROBE-WARN|RUNTIME-WARN|PLATFORM-WARN|IMPACT-WARN)\]/.test(line);
}

/** 去掉行首标签以后的缩进宽度。空行返回 null：它不结束任何一段。 */
function depthOf(line: string): number | null {
	const body = line.replace(LINE_TAG, "");
	const content = body.trimStart();
	return content === "" ? null : body.length - content.length;
}

/** 标签只留带级别的（`[PROBE-ERR]`）：`[PROBE]` 每行都有，列在目录里只占地方。 */
const titleOf = (line: string): string =>
	line
		.replace(/^\s*\[(?![A-Z-]*(?:ERR|WARN)\])[A-Z][A-Z0-9-]*\]/, "")
		.replace(/\s+/g, " ")
		.trim();

const cut = (text: string, width: number): string => (text.length <= width ? text : `${text.slice(0, width - 1)}…`);

const label = (line: string, width: number = LABEL_WIDTHS[0]): string => cut(titleOf(line), width);

/**
 * 全文里每一段的范围（含它前面已经显示出来的部分，好给省略段开头那截「续」起名字）。
 *
 * 一段在哪结束看它下面的行：
 * - 标题下一行缩得更深（`【分录】x` 下面是它的字段），这一段到第一行缩进不深于标题的行为止。
 *   检测单字段那份就是这样：分录之间夹着表头字段，按「下一个标题」切会把表头字段算进前一个分录；
 * - 否则是横幅式标题（`=== 宿主 …`，下面的行和它一样缩进），到下一个缩进不深于它的标题为止。
 * 套在里面的段收到外层段的末尾为止。
 */
function sectionsOf(lines: readonly string[]): Array<{ from: number; to: number; depth: number }> {
	const out: Array<{ from: number; to: number; depth: number }> = [];
	const open: Array<{ to: number }> = [];
	for (let at = 1; at <= lines.length; at++) {
		const line = lines[at - 1] as string;
		if (!isSectionHead(line)) continue;
		const own = depthOf(line) ?? 0;
		let next = at + 1;
		while (next <= lines.length && depthOf(lines[next - 1] as string) === null) next++;
		const block = next <= lines.length && (depthOf(lines[next - 1] as string) as number) > own;
		let to = lines.length;
		for (let probe = at + 1; probe <= lines.length; probe++) {
			const text = lines[probe - 1] as string;
			const depth = depthOf(text);
			if (depth === null || depth > own) continue;
			if (block || isSectionHead(text)) {
				to = probe - 1;
				break;
			}
		}
		while (open.length > 0 && (open.at(-1) as { to: number }).to < at) open.pop();
		const parent = open.at(-1);
		if (parent !== undefined) to = Math.min(to, parent.to);
		while (to > at && (lines[to - 1] as string).trim() === "") to--;
		const section = { from: at, to, depth: open.length };
		out.push(section);
		open.push(section);
	}
	return out;
}

const outlineRow = (entry: OutlineEntry): string =>
	`  ${"  ".repeat(entry.depth ?? 0)}${String(entry.from)}–${String(entry.to)}  ${entry.label}`;

const span = (entry: { from: number; to: number }): string => `${String(entry.from)}–${String(entry.to)}`;

/** 标题开头的记号：`【分录】`、`===`、`──`、`#`。 */
const HEAD_MARKER = /^(【[^】]+】|={2,}|-{2,}|─+|#{1,6}(?=\s))\s*/;

const LOOSE_PREFIX = "  不在上列各段内：";

interface Outline {
	/** 列出来的段，按行号排。 */
	entries: OutlineEntry[];
	/** 各段标题共同的开头记号，列出时省掉了；没有就是空串。 */
	shared: string;
	/** 不归任何标题管、又没放下名字的几截，只报行号范围。 */
	loose: Array<{ from: number; to: number }>;
	/** 连行号范围也没放下的截数。 */
	looseMore: number;
	/** 顶层标题段放不下、没列出来的段数。 */
	dropped: number;
}

const sharedLine = (shared: string): string => `  （各段标题开头的 ${shared} 已省）`;

/**
 * 被省略的第 `from`–`to` 行里有哪几段。
 *
 * 字节不够时按这个次序取舍：顶层标题段 → 套在里面的段 → 顶层段之间不归任何标题管的几截（带名字）
 * → 剩下那几截只报行号范围。字段输出里不归标题管的是夹在分录之间的表头字段，每截占一行会把分录挤出目录。
 * 顶层标题段都放不下时按覆盖行数挑最大的几段，再按行号排回去。
 * 各段标题开头的记号都一样（50 个 `【分录】`）时只说一次：每行 12 字节，乘下来就是十几个分录的位置。
 *
 * 一段标题行都没有时不硬凑：把这一段均分成几块，各拿第一行非空内容当标签。
 * 均分出来的块也是能按行号取回的，而「这一段大概在哪」正是调用方缺的信息。
 */
function outlineDetail(text: string, from: number, to: number, limitBytes: number): Outline {
	const none: Outline = { entries: [], shared: "", loose: [], looseMore: 0, dropped: 0 };
	const lines = text.split("\n");
	const start = Math.max(1, from);
	const end = Math.min(lines.length, to);
	if (end - start + 1 < OUTLINE_MIN_LINES) return none;

	const sections = sectionsOf(lines).filter((section) => section.to >= start && section.from <= end);
	if (sections.some((section) => section.from >= start)) {
		let fitted = none;
		for (const width of LABEL_WIDTHS) {
			fitted = fitOutline(lines, sections, start, end, limitBytes, width);
			if (fitted.dropped === 0) break;
		}
		return fitted;
	}

	const chunks = 4;
	const size = Math.ceil((end - start + 1) / chunks);
	const out: OutlineEntry[] = [];
	for (let at = start; at <= end; at += size) {
		const stop = Math.min(end, at + size - 1);
		let first = at;
		while (first <= stop && (lines[first - 1] as string).trim() === "") first++;
		out.push({ from: at, to: stop, label: first > stop ? "(空行)" : label(lines[first - 1] as string) });
	}
	return { ...none, entries: out };
}

/** 按一种标签宽度把各段塞进 `limitBytes`。取舍次序见 outlineDetail。 */
function fitOutline(
	lines: readonly string[],
	sections: ReadonlyArray<{ from: number; to: number; depth: number }>,
	start: number,
	end: number,
	limitBytes: number,
	width: number,
): Outline {
	const titles = sections.map((section) => titleOf(lines[section.from - 1] as string));
	const markers = new Set(
		sections.flatMap((section, index) =>
			section.from < start ? [] : [HEAD_MARKER.exec(titles[index] as string)?.[1]],
		),
	);
	const shared = markers.size === 1 && sections.length >= 2 ? ([...markers][0] ?? "") : "";
	const all: OutlineEntry[] = sections.map((section, index) => {
		const title = titles[index] as string;
		const bare = cut(
			shared !== "" && HEAD_MARKER.exec(title)?.[1] === shared ? title.replace(HEAD_MARKER, "") : title,
			width,
		);
		return {
			from: Math.max(start, section.from),
			to: Math.min(end, section.to),
			// 省略段开头接着的是头部已经显示的那一段：用它的标题起名，比用半截内容认得出。
			label: section.from < start ? `${bare}（续）` : bare,
			depth: section.depth,
		};
	});
	const heads = all.filter((entry) => entry.depth === 0);
	// 顶层段之间不归任何标题管的几截。只有一条 `[PROBE-ERR]` 的输出里，它前面的六十行才是
	// 「跑到哪一步」；字段输出里，它们是夹在分录之间的表头字段。
	const gaps: OutlineEntry[] = [];
	let cursor = start;
	for (const entry of [...heads, { from: end + 1, to: end + 1 }]) {
		let first = cursor;
		while (first < entry.from && (lines[first - 1] as string).trim() === "") first++;
		if (first < entry.from) {
			gaps.push({ from: first, to: entry.from - 1, label: label(lines[first - 1] as string, width), depth: 0 });
		}
		cursor = Math.max(cursor, entry.to + 1);
	}

	const cost = (entry: OutlineEntry): number => byteLength(outlineRow(entry)) + 1;
	let used = shared === "" ? 0 : byteLength(sharedLine(shared)) + 1;
	const kept = new Set<OutlineEntry>();
	let dropped = 0;
	const headBytes = heads.reduce((sum, entry) => sum + cost(entry), 0);
	if (used + headBytes > limitBytes) {
		for (const entry of [...heads].sort((a, b) => b.to - b.from - (a.to - a.from))) {
			if (used + cost(entry) > limitBytes) continue;
			kept.add(entry);
			used += cost(entry);
		}
		dropped = heads.length - kept.size;
	} else {
		for (const entry of heads) kept.add(entry);
		used += headBytes;
		const maxDepth = Math.max(...all.map((entry) => entry.depth ?? 0));
		for (let depth = 1; depth <= maxDepth; depth++) {
			for (const entry of all) {
				if (entry.depth !== depth || used + cost(entry) > limitBytes) continue;
				kept.add(entry);
				used += cost(entry);
			}
		}
	}
	const unnamed: OutlineEntry[] = [];
	for (const gap of gaps) {
		if (dropped === 0 && used + cost(gap) <= limitBytes) {
			kept.add(gap);
			used += cost(gap);
		} else unnamed.push(gap);
	}
	const loose: OutlineEntry[] = [];
	used += byteLength(LOOSE_PREFIX) + 1;
	for (const gap of unnamed) {
		const extra = byteLength(span(gap)) + 3;
		if (used + extra > limitBytes) break;
		loose.push(gap);
		used += extra;
	}
	const entries = [...all, ...gaps]
		.filter((entry) => kept.has(entry))
		.sort((a, b) => a.from - b.from || (a.depth ?? 0) - (b.depth ?? 0));
	return { entries, shared, loose, looseMore: unnamed.length - loose.length, dropped };
}

export function outlineOf(text: string, from: number, to: number, limitBytes: number = OUTLINE_BYTES): OutlineEntry[] {
	return outlineDetail(text, from, to, limitBytes).entries;
}

/** 目录的各行：共同的标题记号、列出的段、不归标题管的几截、没列出的段数。 */
function outlineRows(outline: Outline): string[] {
	const more = outline.looseMore > 0 ? `等，另有 ${String(outline.looseMore)} 截` : "";
	return [
		...(outline.shared === "" ? [] : [sharedLine(outline.shared)]),
		...outline.entries.map(outlineRow),
		...(outline.loose.length > 0 ? [`${LOOSE_PREFIX}${outline.loose.map(span).join("、")}${more}`] : []),
		...(outline.dropped > 0 ? [`  （另有 ${String(outline.dropped)} 段没列出）`] : []),
	];
}

/** 没有按条件取回的工具，目录渲染成 remedy 里的几行，`file` 用来把取法写成能直接抄的命令。没有目录时是空串。 */
export function outlineText(text: string, file: string, omittedFrom: number, omittedTo: number): string {
	const outline = outlineDetail(text, omittedFrom, omittedTo, OUTLINE_BYTES);
	if (outline.entries.length === 0) return "";
	return [
		`省略段（第 ${String(omittedFrom)}–${String(omittedTo)} 行）里有这几段：`,
		...outlineRows(outline),
		`要哪一段就直接取那几行：sed -n '<起>,<止>p' ${file}`,
	].join("\n");
}

// ------------------------------------------------- 被裁的那段按条件取回（S37 2-A.2）

/**
 * 一行归哪一类：自带标签的（`[PROBE]`、`[PROBE-ERR]`、`[IMPACT]`）按标签，
 * 去掉时间戳后的日志行、异常栈各一类，其余算「其他输出」（临时探针直接打印的就在这里）。
 */
function kindOf(line: string): string | null {
	if (line.trim() === "") return null;
	const tag = /^\s*\[([A-Z][A-Z0-9-]*)\]/.exec(line);
	if (tag !== null) return `[${tag[1] as string}]`;
	if (/^(?:TRACE|DEBUG|INFO|WARN|ERROR) \S+: /.test(line)) return "日志";
	if (/^\s+(?:at |\.\.\.)/.test(line)) return "异常栈";
	return "其他输出";
}

/**
 * 被省略的第 `from`–`to` 行各是什么、各几行，例如 `[PROBE] 40、日志 4`。
 *
 * 目录（outlineOf）说的是「哪几行是哪一段」，这里说的是「省掉的都是哪种东西」：
 * 模型要找插件自己的日志，看到「日志 4」就知道该取什么，不用先把整段取回来看。
 */
export function omittedKinds(text: string, from: number, to: number): string {
	const lines = text.split("\n");
	const counts = new Map<string, number>();
	for (let at = Math.max(1, from); at <= Math.min(lines.length, to); at++) {
		const kind = kindOf(lines[at - 1] as string);
		if (kind !== null) counts.set(kind, (counts.get(kind) ?? 0) + 1);
	}
	return [...counts]
		.sort((a, b) => b[1] - a[1])
		.map(([kind, count]) => `${kind} ${String(count)}`)
		.join("、");
}

/**
 * 能用 `raw` 按条件取回时，被裁那段的说明：省了哪几行、各是什么、目录、怎么取。
 *
 * 改之前说的是「全文在 X；要看省略段就窄条件 grep 它」或者一句 sed 命令，
 * 模型得离开工具去翻文件（09-22 第三份真机样本第 37、38 次就是这样）。
 * 现在取回走同一个工具，说明里不再给文件路径。
 */
export function pickableRemedy(text: string, omittedFrom: number, omittedTo: number): string {
	const outline = outlineDetail(text, omittedFrom, omittedTo, OUTLINE_BYTES);
	const kinds = omittedKinds(text, omittedFrom, omittedTo);
	return [
		`省略了第 ${String(omittedFrom)}–${String(omittedTo)} 行${kinds === "" ? "" : `（${kinds}）`}。`,
		...outlineRows(outline),
		'同一调用加 raw="起-止" 或 raw="关键字"（正则）取回，不重跑。',
	].join("\n");
}

/**
 * 按条件取回的那份返回的预算。
 *
 * 比默认预算宽一倍：默认预算管的是没人要求的整份输出，这里是调用方点名要的那几行。
 * 09-22 那次要找的 6 个格子（24 行、每行带一整段公式 JSON）约 6 KB，按默认 4 KB 会再被裁一次。
 */
export const PICK_BUDGET = 8000;

export interface PickedLines {
	/** 取到的行，每行前面带它在原输出里的行号。 */
	text: string;
	/** 符合条件的行数。 */
	matched: number;
	/** 实际给出的行数；小于 matched 说明超了预算。 */
	shown: number;
	/** 给出的最后一行的行号，接着取用。 */
	lastLine: number | null;
}

const LINE_RANGE = /^(\d+)(?:\s*[-–~]\s*(\d+))?$/;

/** `spec` 是不是行号范围（`23-66`、`23`）；不是就当关键字。 */
const isLineRange = (spec: string): boolean => LINE_RANGE.test(spec.trim());

/**
 * `L120-180`、`L120-L180`、`L120`：完整日志的行号，返回去掉 L 的写法；不是这种写法返回 null。
 *
 * 显示给模型的那份输出滤掉了平台日志，行号和完整日志不是一套。两套行号各有各的写法，
 * 模型照着取回的行前面那个号抄就行，不用记「现在算哪一套」。
 */
function fullLogRange(spec: string): string | null {
	const match = /^L(\d+)(?:\s*[-–~]\s*L?(\d+))?$/i.exec(spec.trim());
	if (match === null) return null;
	return match[2] === undefined ? (match[1] as string) : `${match[1] as string}-${match[2]}`;
}

export interface PickOptions {
	/** 行号前面加的记号：取自完整日志的行写 `L`。 */
	prefix?: string;
	/** 按关键字找时跳过这些行（原样相同才算）：前面那份里已经有的不再给一遍。 */
	except?: ReadonlySet<string>;
}

/**
 * 从一份输出里按行号范围或关键字取行。
 *
 * `spec` 全是数字（`23-66`、`23`）按行号，行号和被裁时的说明是同一套；
 * 否则当正则（不分大小写），写得不合正则语法就当普通字符串找。
 * 不给上下文行：每行都带行号，要前后几行再按行号取一次就是。
 */
export function pickLines(
	text: string,
	spec: string,
	limit: number = PICK_BUDGET,
	options: PickOptions = {},
): PickedLines {
	const lines = text.split("\n");
	const trimmed = spec.trim();
	const range = LINE_RANGE.exec(trimmed);
	const prefix = options.prefix ?? "";
	let hits: number[];
	if (range !== null) {
		const from = Math.max(1, Number(range[1]));
		const to = Math.min(lines.length, Number(range[2] ?? range[1]));
		hits = [];
		for (let at = from; at <= to; at++) hits.push(at);
	} else {
		let pattern: RegExp;
		try {
			pattern = new RegExp(trimmed, "iu");
		} catch {
			pattern = new RegExp(trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu");
		}
		hits = [];
		for (const [index, line] of lines.entries()) {
			if (pattern.test(line) && options.except?.has(line) !== true) hits.push(index + 1);
		}
	}
	const out: string[] = [];
	let bytes = 0;
	let lastLine: number | null = null;
	for (const at of hits) {
		const row = `${prefix}${String(at)}: ${lines[at - 1] as string}`;
		const cost = byteLength(row) + 1;
		if (limit <= 0 || (out.length > 0 && bytes + cost > limit)) break;
		out.push(out.length === 0 && cost > limit ? takeBytes(row, limit) : row);
		bytes += cost;
		lastLine = at;
	}
	return { text: out.join("\n"), matched: hits.length, shown: out.length, lastLine };
}

export interface RunPick {
	/** 取到的行；显示的那份里的在前，完整日志里多出来的（带 L 行号）在后。 */
	text: string;
	matched: number;
	/** 没取到、没给全、行号是哪一套——发生了才有。 */
	notes: string[];
}

/**
 * 从一次运行留下的输出里取行：显示给模型的那份，加上（滤掉过平台日志时）落盘的完整日志。
 *
 * 显示的那份滤掉了平台日志，折起来的异常栈、SQL 只在完整日志里。只在显示的那份里找，
 * 模型照着「完整运行时日志在 raw 通道」去找异常，得到的是「没有符合的行」。所以：
 *
 * - 关键字：两份都找。显示的那份里的行带普通行号；完整日志里多出来的行带 `L` 行号，
 *   显示的那份里原样有的不再给一遍。两份合用一个预算。
 * - 普通行号（`23-66`）：显示的那份，和被裁时的说明是同一套。
 * - `L` 行号（`L1410-1420`）：完整日志。`shownIsFull`（手里这份已经是完整日志）时两套行号是同一套。
 *
 * `log` 是完整日志的全文；显示的那份已经是全部、或者落盘文件读不到时给 null。
 * 要的是完整日志的行号而完整日志读不到，返回 null，由调用方照实说。
 */
export function pickFromRun(shown: string, log: string | null, spec: string, shownIsFull: boolean): RunPick | null {
	const total = shown.split("\n").length;
	const notes: string[] = [];
	const cutNote = (found: PickedLines, where: string, last: string, next: string): void => {
		if (found.shown >= found.matched) return;
		notes.push(
			`${where}符合的 ${String(found.matched)} 行里给了前 ${String(found.shown)} 行（到${last}）；条件收窄，或${next}。`,
		);
	};
	const logRange = fullLogRange(spec);
	if (logRange !== null) {
		const source = shownIsFull ? shown : log;
		if (source === null) return null;
		const found = pickLines(source, logRange, PICK_BUDGET, shownIsFull ? {} : { prefix: "L" });
		cutNote(found, "", `第 ${String(found.lastLine)} 行`, "按行号接着取");
		return { text: found.text, matched: found.matched, notes };
	}
	const first = pickLines(shown, spec);
	cutNote(first, "", `第 ${String(first.lastLine)} 行`, "按行号接着取");
	if (isLineRange(spec) || log === null) {
		if (first.matched === 0) {
			notes.push(
				shownIsFull || isLineRange(spec)
					? `共 ${String(total)} 行，没有符合 ${spec} 的行。`
					: `显示的 ${String(total)} 行里没有符合 ${spec} 的行；完整日志已经不在本机，没法再找。`,
			);
		}
		return { text: first.text, matched: first.matched, notes };
	}
	const logTotal = log.split("\n").length;
	const more = pickLines(log, spec, PICK_BUDGET - byteLength(first.text), {
		prefix: "L",
		except: new Set(shown.split("\n")),
	});
	if (first.matched + more.matched === 0) {
		notes.push(`显示的 ${String(total)} 行和完整日志 ${String(logTotal)} 行里都没有符合 ${spec} 的行。`);
	} else if (more.matched > 0) {
		notes.push(
			`带 L 的 ${String(more.matched)} 行取自完整日志（共 ${String(logTotal)} 行，含没显示的平台日志）；取它前后几行写 raw="L起-止"。`,
		);
		cutNote(more, "完整日志里", ` L${String(more.lastLine)}`, 'raw="L起-止" 接着取');
	}
	return {
		text: [first.text, more.text].filter((part) => part !== "").join("\n"),
		matched: first.matched + more.matched,
		notes,
	};
}
