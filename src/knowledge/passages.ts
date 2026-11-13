/**
 * 两份资料合成一个按段切分的全文索引（S45 批 2）。
 *
 * 官方知识库原来只比标题、关键词、"什么时候用"三样，不看正文；本地参考文档按整篇算分、只回篇名。
 * 真机查询 23 条有答案的回来 16 条，回来的要整篇读 262 KB，答案段只有 53 KB（docs/S45-knowledge-recall.md §2.2）。
 *
 * 这里做两件事，而且故意分开：
 *
 * 1. **按小段算分。** 按 Markdown 标题切段（代码块里的 `#` 不算），每段单独记分（BM25）。小段让分数准：
 *    一篇 20 KB 的文档里只有一段讲 `setOutputValue`，整篇算分时它被别的词稀释掉。
 * 2. **按块返回。** 量过：官方一段的中位数只有 149 B，一半是孤零零的代码、步骤号或注意事项；本地有 8.8% 的段
 *    写着"上面那一步"。只回命中的那一小段，模型拿到的是半截知识（§3.5）。所以回给模型的是命中段所在的完整一块：
 *    小篇整篇，大篇命中所在的整节。
 *
 * 索引只在内存里，第一次查询时建、之后复用。资料是固定快照，同一份输入建出同一份索引。
 */

export type PassageOrigin = "official" | "local";

/** 进索引的一篇。 */
export interface PassageSource {
	origin: PassageOrigin;
	/** 官方：知识根目录下的相对路径；本地：`reference:<篇名>`。`show` 收的就是它。 */
	ref: string;
	/** 磁盘上的绝对路径。 */
	file: string;
	/** 原文，换行可以是 `\r\n`。 */
	text: string;
	/**
	 * 写在别处、但说的是这一篇的词：官方场景索引表里这一篇那行的场景名、关键词、事件、控件。
	 * 和文件头里的关联 API、关键词一样按整篇记一次分。
	 */
	about?: string;
}

interface Section {
	doc: number;
	/** 0 = 第一个标题之前的部分（文件头已去掉）。 */
	level: number;
	heading: string;
	/** 0 起的行号：标题行、下一个标题行、下一个同级或更高级标题行（不含）。 */
	start: number;
	ownEnd: number;
	spanEnd: number;
	parent: number;
	/** 参与 BM25 长度归一的词数。 */
	length: number;
}

interface IndexedDoc {
	source: PassageSource;
	lines: string[];
	/** 文件头（`---` 包住的那段）之后的第一行。 */
	bodyStart: number;
	bodyBytes: number;
	/** 本篇的"节"是哪一级标题。 */
	unitLevel: number;
	/** 本篇的节数，给"共 N 节"用。 */
	units: number;
	sections: number[];
	/** 篇名和文件头（场景名、关联 API、类名、"什么时候用"）里的词：整篇共有，按篇记一次分。 */
	fields: Set<string>;
	/**
	 * 其中篇名、场景名、类名的词。这些词在正文里也不再按段计分：API 文档每一段都写着自己的类名，
	 * 按段算，只写着类名的「Import 路径」总排在真正讲那个方法的一段前面。
	 * 关联 API、关键词照常按段计分：场景卡正文里讲 `registerListener` 的那段就该因为它排上来。
	 */
	names: Set<string>;
}

export interface PassageIndex {
	docs: IndexedDoc[];
	sections: Section[];
	/** 词 → [段号, 词频, 段号, 词频, …]。 */
	postings: Map<string, number[]>;
	/** 词 → 篇名和文件头里有它的篇号。 */
	fieldPostings: Map<string, number[]>;
	/**
	 * 两份资料各自的平均段长。官方一段平均几十个词，本地几百个：放在一起按同一个平均数压，
	 * 本地的段全被当成"超长段"压到底，`formulaData` 只在本地写过也排不上来。
	 */
	averageLength: Record<PassageOrigin, number>;
	/** 建索引用了多少毫秒，量出来记进阶段文档。 */
	buildMs: number;
	/** 已经并好倒排的单个汉字（见 charTerm）。 */
	chars: Set<string>;
}

/** 一篇小于这个数（去掉文件头）就整篇是一块。官方 81% 的篇在这条线以内。 */
export const WHOLE_DOC_BYTES = 4096;
/** 一节连子标题超过这个数，就退到命中的那一段。本地 96% 的节在这条线以内。 */
export const BLOCK_BYTES = 6144;

const encoder = new TextEncoder();
const byteLength = (text: string): number => encoder.encode(text).length;

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const WORD = /[A-Za-z_$][A-Za-z0-9_$]*/g;
/** `cosmic-run` 这类连字符词：整体也记一份，连字符换成下划线，和工具名 `cosmic_run` 是同一个词。 */
const HYPHENATED = /[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+/g;
const CJK_RUN = /[㐀-鿿]+/g;
const CAMEL = /[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g;
/** 拆出来的部分加这个前缀，和整词分开记：搜 `Lock` 要先找写着 Lock 的段，不是一堆 `getLockStyle`。 */
const PART = "~";

function identifierTokens(word: string): { whole: string; parts: string[] } {
	const parts = (word.match(CAMEL) ?? []).filter((part) => part.length >= 2).map((part) => part.toLowerCase());
	return { whole: word.toLowerCase(), parts: parts.length > 1 ? parts : [] };
}

function cjkTokens(run: string): string[] {
	const chars = [...run];
	if (chars.length === 1) return [run];
	const out: string[] = [];
	for (let i = 0; i + 1 < chars.length; i++) out.push(`${chars[i]}${chars[i + 1]}`);
	return out;
}

/**
 * 一段文字切成词（建索引用）。
 *
 * - 英文标识符整词小写一份；驼峰、下划线拆开的各部分加 `~` 前缀再一份（`getSuccessPkIds` 的部分
 *   能被 `SuccessPkIds` 找到，但不和写着 `success` 的段混在一起）。
 * - 中文按相邻两字切（"撤销提交"→撤销、销提、提交），单个汉字的一串就记这一个字。
 */
export function tokenize(text: string): string[] {
	const out: string[] = [];
	for (const match of text.matchAll(WORD)) {
		const { whole, parts } = identifierTokens(match[0]);
		if (whole.length >= 2) out.push(whole);
		for (const part of parts) out.push(PART + part);
	}
	for (const match of text.matchAll(HYPHENATED)) out.push(match[0].toLowerCase().replace(/-/g, "_"));
	for (const match of text.matchAll(CJK_RUN)) out.push(...cjkTokens(match[0]));
	return out;
}

function frontMatterEnd(lines: readonly string[]): number {
	if (lines[0]?.trim() !== "---") return 0;
	for (let i = 1; i < lines.length; i++) if (lines[i]?.trim() === "---") return i + 1;
	return 0;
}

/** 文件头里这几个键的值。 */
function frontMatterValues(lines: readonly string[], end: number, keys: RegExp): string {
	return lines
		.slice(1, Math.max(1, end - 1))
		.filter((line) => keys.test(line))
		.map((line) => line.slice(line.indexOf(":") + 1))
		.join(" ");
}

/** 这一篇叫什么：场景名、类名、包名（API 文档每段都写着全限定名）。 */
const NAME_KEYS = /^(scene_name|api_class|api_package)\s*:/;
/** 官方 API 文档在知识根目录下的位置。 */
const API_PREFIX = "platform/api/";
/** 这一篇和什么有关：关联 API、关键词、什么时候用、主题。 */
const ABOUT_KEYS = /^(related_apis|scene_keywords|when_to_use|topic)\s*:/;

const HEADING_WEIGHT = 2;

interface Head {
	line: number;
	level: number;
	heading: string;
}

export function buildPassageIndex(sources: readonly PassageSource[], clock: () => number = Date.now): PassageIndex {
	const started = clock();
	const docs: IndexedDoc[] = [];
	const sections: Section[] = [];
	const postings = new Map<string, number[]>();
	const fieldPostings = new Map<string, number[]>();
	const totalLength: Record<PassageOrigin, number> = { official: 0, local: 0 };
	const sectionCount: Record<PassageOrigin, number> = { official: 0, local: 0 };

	for (const source of sources) {
		const lines = source.text.replace(/\r\n?/g, "\n").split("\n");
		const bodyStart = frontMatterEnd(lines);
		const docIndex = docs.length;

		// 切段：标题行开新段；代码块里的 # 是注释或 shell，不是标题
		const heads: Head[] = [];
		let fenced = false;
		for (let i = bodyStart; i < lines.length; i++) {
			const line = lines[i] as string;
			if (FENCE.test(line)) fenced = !fenced;
			if (fenced) continue;
			const match = HEADING.exec(line);
			if (match !== null) heads.push({ line: i, level: (match[1] as string).length, heading: match[2] as string });
		}
		const levels = heads.map((head) => head.level);
		const top = levels.length === 0 ? 1 : Math.min(...levels);
		const topCount = levels.filter((level) => level === top).length;
		const deeper = levels.filter((level) => level > top);
		// 只有一个最高级标题时它是篇名，真正分节的是下一级
		const unitLevel = topCount === 1 && deeper.length > 0 ? Math.min(...deeper) : top;
		const title =
			topCount === 1 && deeper.length > 0 ? (heads.find((head) => head.level === top)?.heading ?? "") : "";

		const doc: IndexedDoc = {
			source,
			lines,
			bodyStart,
			bodyBytes: byteLength(lines.slice(bodyStart).join("\n").trim()),
			unitLevel,
			units: levels.filter((level) => level === unitLevel).length,
			sections: [],
			fields: new Set(),
			names: new Set(),
		};
		// 本地文档文件头的 description 是"什么时候读"，词很杂，不当整篇的词
		const official = source.origin === "official";
		// 官方 API 文档的「概述」一节就是文件头"什么时候用"那句的翻版（1,528 篇里 1,394 篇）：文件头的词再按篇加一次，
		// 同一批词就算了两遍分，几乎空白的 API 骨架靠它排到讲透这件事的文档前面（S45 §4.6）。API 文档只留类名、包名按篇加分
		const headerAbout = official && !source.ref.startsWith(API_PREFIX);
		doc.names = new Set(tokenize(`${title} ${official ? frontMatterValues(lines, bodyStart, NAME_KEYS) : ""}`));
		doc.fields = new Set([
			...doc.names,
			...(headerAbout ? tokenize(frontMatterValues(lines, bodyStart, ABOUT_KEYS)) : []),
			...tokenize(source.about ?? ""),
		]);
		docs.push(doc);
		for (const term of doc.fields) {
			const list = fieldPostings.get(term);
			if (list === undefined) fieldPostings.set(term, [docIndex]);
			else list.push(docIndex);
		}

		// 第一个标题之前的文字（文件头之后）自成一段
		const starts: Head[] =
			heads[0] !== undefined && heads[0].line === bodyStart
				? heads
				: [{ line: bodyStart, level: 0, heading: "" }, ...heads];
		const stack: number[] = [];
		for (let k = 0; k < starts.length; k++) {
			const head = starts[k] as Head;
			const ownEnd = starts[k + 1]?.line ?? lines.length;
			let spanEnd = lines.length;
			if (head.level === 0) spanEnd = ownEnd;
			else
				for (let j = k + 1; j < starts.length; j++) {
					if ((starts[j] as Head).level <= head.level) {
						spanEnd = (starts[j] as Head).line;
						break;
					}
				}
			while (stack.length > 0 && (sections[stack.at(-1) as number] as Section).level >= head.level) stack.pop();
			const parent = head.level === 0 ? -1 : (stack.at(-1) ?? -1);
			const body = lines.slice(head.level === 0 ? head.line : head.line + 1, ownEnd).join("\n");
			const bodyTerms = tokenize(body);
			// 篇名那一级的标题已经算进整篇的词，不再给这一小段单独加分
			const titleLevel = head.level < unitLevel;
			const headTerms = titleLevel ? [] : tokenize(head.heading);
			if (bodyTerms.length === 0 && headTerms.length === 0 && head.level === 0) continue;
			const counts = new Map<string, number>();
			const add = (terms: readonly string[], weight: number) => {
				for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + weight);
			};
			add(bodyTerms, 1);
			add(headTerms, HEADING_WEIGHT);
			// 上级节标题也算这一段的词：「新增和回滚」下面的「核表达式」也该被"回滚"找到
			for (let p = parent; p >= 0; p = (sections[p] as Section).parent) {
				const ancestor = sections[p] as Section;
				if (ancestor.level >= unitLevel) add(tokenize(ancestor.heading), 1);
			}
			const id = sections.length;
			const length = bodyTerms.length + headTerms.length;
			sections.push({
				doc: docIndex,
				level: head.level,
				heading: head.heading,
				start: head.line,
				ownEnd,
				spanEnd,
				parent,
				length,
			});
			doc.sections.push(id);
			if (head.level > 0) stack.push(id);
			totalLength[source.origin] += length;
			sectionCount[source.origin] += 1;
			for (const [term, tf] of counts) {
				const list = postings.get(term);
				if (list === undefined) postings.set(term, [id, tf]);
				else list.push(id, tf);
			}
		}
	}
	return {
		docs,
		sections,
		postings,
		fieldPostings,
		averageLength: {
			official: sectionCount.official === 0 ? 1 : totalLength.official / sectionCount.official,
			local: sectionCount.local === 0 ? 1 : totalLength.local / sectionCount.local,
		},
		buildMs: clock() - started,
		chars: new Set(),
	};
}

// ------------------------------------------------------------------ 查询

const K1 = 1.2;
const B = 0.75;
/** 整词在别的标识符里出现（`Lock` 在 `getLockStyle` 里）算多少。 */
const AS_PART = 0.4;
/** 查询词拆出来的部分：整词在资料里有时只是陪衬，整词一处也没有时才顶上去。 */
const PART_WHEN_WHOLE_FOUND = 0.2;
const PART_WHEN_WHOLE_ABSENT = 0.6;

/**
 * 单个汉字当一个词查（"锁""表"）。中文按相邻两字建索引，单字自己切不出词，原样查一处也找不到。
 * 第一次查到某个字时，把含这个字的两字词的倒排并成这个字的倒排（词频相加），记在索引里，以后直接用。
 */
function charTerm(index: PassageIndex, char: string): void {
	if (index.chars.has(char)) return;
	index.chars.add(char);
	const sections = new Map<number, number>();
	const docs = new Set<number>();
	const merge = (term: string) => {
		const list = index.postings.get(term) ?? [];
		for (let i = 0; i < list.length; i += 2) {
			const id = list[i] as number;
			sections.set(id, (sections.get(id) ?? 0) + (list[i + 1] as number));
		}
		for (const doc of index.fieldPostings.get(term) ?? []) docs.add(doc);
	};
	merge(char);
	for (const term of new Set([...index.postings.keys(), ...index.fieldPostings.keys()])) {
		if (term.length === 2 && term.includes(char)) merge(term);
	}
	if (sections.size > 0) {
		index.postings.set(char, [...sections].sort((a, b) => a[0] - b[0]).flat());
	}
	if (docs.size > 0)
		index.fieldPostings.set(
			char,
			[...docs].sort((a, b) => a - b),
		);
}

function known(index: PassageIndex, term: string): boolean {
	return index.postings.has(term) || index.fieldPostings.has(term);
}

function idf(index: PassageIndex, term: string): number {
	const list = index.postings.get(term);
	const df = list === undefined ? 0 : list.length / 2;
	const n = index.sections.length;
	return Math.log(1 + (n - df + 0.5) / (df + 0.5));
}

/** 查询里的原词：空白、逗号、分号、括号隔开。 */
export function queryWords(query: string): string[] {
	return [...new Set(query.split(/[\s,;，；、()（）]+/).filter((word) => word !== ""))];
}

interface QueryPlan {
	weights: Map<string, number>;
	/** 一处也没有的原词。 */
	absent: string[];
}

/**
 * 查询词和权重。
 *
 * 下划线连起来的标识符（`demo_bill_entry`）整词不在资料里时，拆出来的部分（bill、entry）也不用：
 * 那是工程自己的单据、字段名，拿部分去搜只会搜回不相干的段。驼峰名拆开还有意义（`autoAdjustHeight`
 * 不在，`setAutoRowHeight` 是最近的线索），保留。
 */
function planQuery(index: PassageIndex, query: string, exact = false): QueryPlan {
	const weights = new Map<string, number>();
	const absent: string[] = [];
	const put = (term: string, weight: number) => {
		if (!index.postings.has(term) && !index.fieldPostings.has(term)) return;
		weights.set(term, Math.max(weights.get(term) ?? 0, weight));
	};
	for (const word of queryWords(query)) {
		let found = false;
		for (const match of word.matchAll(WORD)) {
			const { whole, parts } = identifierTokens(match[0]);
			if (whole.length < 2) continue;
			const wholeKnown = known(index, whole);
			found ||= wholeKnown;
			put(whole, 1);
			if (exact) continue;
			put(PART + whole, AS_PART);
			if (!wholeKnown && whole.includes("_")) continue;
			const weight = wholeKnown ? PART_WHEN_WHOLE_FOUND : PART_WHEN_WHOLE_ABSENT;
			for (const part of parts) {
				put(PART + part, weight);
				put(part, weight);
			}
		}
		for (const match of word.matchAll(HYPHENATED)) {
			const term = match[0].toLowerCase().replace(/-/g, "_");
			found ||= known(index, term);
			put(term, 1);
		}
		for (const match of word.matchAll(CJK_RUN)) {
			if ([...match[0]].length === 1) charTerm(index, match[0]);
			for (const term of cjkTokens(match[0])) {
				found ||= known(index, term);
				put(term, 1);
			}
		}
		if (!found) absent.push(word);
	}
	return { weights, absent };
}

export interface PassageQueryOptions {
	/** 这篇能不能进结果（kind、场景过滤、草稿）。不给 = 都能。 */
	allow?: (source: PassageSource) => boolean;
	/** 这些篇的分数乘这个数：查询里点了工具名时，那篇用法文档排前面。 */
	boost?: ReadonlyMap<string, number>;
	limit?: number;
	/**
	 * 只按整词查：标识符要原样出现，驼峰拆出来的部分、长在别的标识符里的都不算。
	 * 按类名找讲到它的段用这个：查 `QFilter` 不该把只写着 `QFilterBuilder`、`Filter` 的段算进来。
	 */
	exact?: boolean;
}

/** 一块：回给模型的完整一段文字的范围。 */
export interface PassageBlock {
	/** 0 起的行号，[start, end)。 */
	start: number;
	end: number;
	/** 这一块是什么：整篇、一节、一节里的一段，或者大篇的开头（篇名下的引言）。 */
	scope: "doc" | "unit" | "section" | "intro";
	/** 块的标题路径（不含篇名那一级），整篇和开头时为空串。 */
	heading: string;
	bytes: number;
}

export interface PassageHit {
	source: PassageSource;
	score: number;
	/** 命中最高的那一段的标题路径。 */
	heading: string;
	block: PassageBlock;
	/** 整篇的大小和节数。 */
	docBytes: number;
	units: number;
	/** 命中词最多的两行，`行号: 原文`（1 起）。 */
	matched: string[];
	/** 同一篇里块外面也命中的段，只给标题。 */
	also: string[];
}

export interface PassageSearchResult {
	hits: PassageHit[];
	/** 一处也没有的查询词（原词）。 */
	absent: string[];
	/** 过了 allow 之后命中的篇数（limit 之前）。 */
	matchedDocs: number;
}

export const HEADING_SEPARATOR = " › ";

/** 一段的标题路径；篇名那一级（比本篇节级还高的标题）不算进去。 */
function headingPath(index: PassageIndex, id: number): string {
	const doc = index.docs[(index.sections[id] as Section).doc] as IndexedDoc;
	const parts: string[] = [];
	for (let p = id; p >= 0; p = (index.sections[p] as Section).parent) {
		const section = index.sections[p] as Section;
		if (section.level >= doc.unitLevel) parts.unshift(section.heading);
	}
	return parts.join(HEADING_SEPARATOR);
}

function spanBytes(doc: IndexedDoc, start: number, end: number): number {
	return byteLength(doc.lines.slice(start, end).join("\n").trim());
}

/**
 * 命中段该回哪一块（§3.5 的规则 2、3）。
 *
 * 小篇整篇；大篇取命中段所在的那一节（连子标题），一节放不下退到命中段连子标题，再放不下只给命中段本身。
 * 大篇命中在篇名或开头引言上（说明整篇都相关、没有哪一节特别相关），给开头，调用方再附上整篇目录。
 */
export function blockOf(index: PassageIndex, id: number): PassageBlock {
	const section = index.sections[id] as Section;
	const doc = index.docs[section.doc] as IndexedDoc;
	if (doc.bodyBytes <= WHOLE_DOC_BYTES) {
		return { start: doc.bodyStart, end: doc.lines.length, scope: "doc", heading: "", bytes: doc.bodyBytes };
	}
	if (section.level < doc.unitLevel) {
		return {
			start: section.start,
			end: section.ownEnd,
			scope: "intro",
			heading: "",
			bytes: spanBytes(doc, section.start, section.ownEnd),
		};
	}
	let unit = id;
	while ((index.sections[unit] as Section).level > doc.unitLevel) {
		const parent = (index.sections[unit] as Section).parent;
		if (parent < 0 || (index.sections[parent] as Section).level < doc.unitLevel) break;
		unit = parent;
	}
	const candidates: { id: number; end: number; scope: PassageBlock["scope"] }[] = [
		{ id: unit, end: (index.sections[unit] as Section).spanEnd, scope: "unit" },
		{ id, end: section.spanEnd, scope: "section" },
	];
	for (const candidate of candidates) {
		const start = (index.sections[candidate.id] as Section).start;
		const bytes = spanBytes(doc, start, candidate.end);
		if (bytes <= BLOCK_BYTES) {
			return { start, end: candidate.end, scope: candidate.scope, heading: headingPath(index, candidate.id), bytes };
		}
	}
	return {
		start: section.start,
		end: section.ownEnd,
		scope: "section",
		heading: headingPath(index, id),
		bytes: spanBytes(doc, section.start, section.ownEnd),
	};
}

function docOf(index: PassageIndex, ref: string): IndexedDoc | undefined {
	return index.docs.find((entry) => entry.source.ref === ref);
}

/** 整篇正文（去掉文件头）。 */
export function docText(index: PassageIndex, ref: string): string {
	const doc = docOf(index, ref);
	return doc === undefined ? "" : doc.lines.slice(doc.bodyStart).join("\n");
}

/** 一块的原文。 */
export function blockText(index: PassageIndex, ref: string, block: PassageBlock): string {
	const doc = docOf(index, ref);
	return doc === undefined ? "" : doc.lines.slice(block.start, block.end).join("\n").trim();
}

function matchedLines(doc: IndexedDoc, section: Section, weights: Map<string, number>): string[] {
	const scored: { line: number; score: number }[] = [];
	for (let i = section.start; i < section.ownEnd; i++) {
		const text = doc.lines[i] as string;
		if (FENCE.test(text) || text.trim() === "") continue;
		const terms = new Set(tokenize(text));
		let score = 0;
		for (const [term, weight] of weights) if (terms.has(term)) score += weight;
		if (score > 0) scored.push({ line: i, score });
	}
	return scored
		.sort((a, b) => b.score - a.score || a.line - b.line)
		.slice(0, 2)
		.sort((a, b) => a.line - b.line)
		.map(({ line }) => {
			const text = (doc.lines[line] as string).trim();
			const chars = [...text];
			return `${String(line + 1)}: ${chars.length > 120 ? `${chars.slice(0, 120).join("")}…` : text}`;
		});
}

export function searchPassages(
	index: PassageIndex,
	query: string,
	options: PassageQueryOptions = {},
): PassageSearchResult {
	const limit = options.limit ?? 5;
	const { weights, absent } = planQuery(index, query, options.exact);
	const idfs = new Map([...weights].map(([term, weight]) => [term, weight * idf(index, term)]));

	const sectionScores = new Map<number, number>();
	for (const [term, weight] of idfs) {
		const list = index.postings.get(term);
		if (list === undefined) continue;
		for (let i = 0; i < list.length; i += 2) {
			const id = list[i] as number;
			const tf = list[i + 1] as number;
			const section = index.sections[id] as Section;
			const doc = index.docs[section.doc] as IndexedDoc;
			// 篇名、类名、场景名按篇加一次（下面 fieldScores），不让某一小段靠它出头（见 IndexedDoc.names）
			if (doc.names.has(term)) continue;
			const norm = tf + K1 * (1 - B + (B * section.length) / index.averageLength[doc.source.origin]);
			sectionScores.set(id, (sectionScores.get(id) ?? 0) + (weight * tf * (K1 + 1)) / norm);
		}
	}
	// 篇名和文件头里的词：整篇共有，按篇加一次。篇名（类名、场景名）里有这个词，等于整篇都在讲它，
	// 按一段里出现得足够多算（BM25 单个词的上限）；只写在关键词、关联 API 里的按出现一次算
	const fieldScores = new Map<number, number>();
	for (const [term, weight] of idfs) {
		for (const docIndex of index.fieldPostings.get(term) ?? []) {
			const named = (index.docs[docIndex] as IndexedDoc).names.has(term);
			fieldScores.set(docIndex, (fieldScores.get(docIndex) ?? 0) + weight * (named ? K1 + 1 : 1));
		}
	}

	// 按篇归并：一篇只出一条，取这篇分最高的段
	const byDoc = new Map<number, { id: number; score: number }[]>();
	for (const [id, score] of sectionScores) {
		const docIndex = (index.sections[id] as Section).doc;
		const list = byDoc.get(docIndex);
		if (list === undefined) byDoc.set(docIndex, [{ id, score }]);
		else list.push({ id, score });
	}
	for (const docIndex of fieldScores.keys()) {
		const first = (index.docs[docIndex] as IndexedDoc).sections[0];
		if (!byDoc.has(docIndex) && first !== undefined) byDoc.set(docIndex, [{ id: first, score: 0 }]);
	}
	const ranked = [...byDoc.entries()]
		.filter(([docIndex]) => options.allow === undefined || options.allow((index.docs[docIndex] as IndexedDoc).source))
		.map(([docIndex, list]) => {
			const doc = index.docs[docIndex] as IndexedDoc;
			const bonus = fieldScores.get(docIndex) ?? 0;
			const factor = options.boost?.get(doc.source.ref) ?? 1;
			const sorted = list.sort((a, b) => b.score - a.score || a.id - b.id);
			return { docIndex, list: sorted, score: ((sorted[0]?.score ?? 0) + bonus) * factor };
		})
		.sort(
			(a, b) =>
				b.score - a.score ||
				(index.docs[a.docIndex] as IndexedDoc).source.ref.localeCompare(
					(index.docs[b.docIndex] as IndexedDoc).source.ref,
				),
		);

	const hits: PassageHit[] = ranked.slice(0, limit).map(({ docIndex, list, score }) => {
		const doc = index.docs[docIndex] as IndexedDoc;
		const top = list[0] as { id: number; score: number };
		const block = blockOf(index, top.id);
		const also = list
			.slice(1)
			.filter((entry) => entry.score >= top.score / 2)
			.filter((entry) => {
				const section = index.sections[entry.id] as Section;
				return section.start < block.start || section.start >= block.end;
			})
			.map((entry) => headingPath(index, entry.id))
			.filter((heading, i, all) => heading !== "" && all.indexOf(heading) === i)
			.slice(0, 3);
		return {
			source: doc.source,
			score: Math.round(score * 100) / 100,
			heading: headingPath(index, top.id),
			block,
			docBytes: doc.bodyBytes,
			units: doc.units,
			matched:
				block.scope === "doc" && block.bytes <= 600
					? []
					: matchedLines(doc, index.sections[top.id] as Section, weights),
			also,
		};
	});
	return { hits, absent, matchedDocs: ranked.length };
}

/** 一篇在某条查询下的分是怎么来的（给尺子 `scripts/explain-search-rank.ts` 用，不进检索路径）。 */
export interface PassageScoreExplain {
	ref: string;
	score: number;
	/** 这篇分最高的段的标题路径。 */
	heading: string;
	terms: { term: string; weight: number; idf: number; sectionsWithTerm: number; section: number; field: number }[];
}

/** 和 `searchPassages` 同一套算法，把一篇的分拆到每个查询词上：段里得的、篇名和文件头加的。 */
export function explainPassageScore(index: PassageIndex, query: string, ref: string): PassageScoreExplain | null {
	const docIndex = index.docs.findIndex((doc) => doc.source.ref === ref);
	const doc = index.docs[docIndex];
	if (doc === undefined) return null;
	const { weights } = planQuery(index, query);
	const per = (id: number, term: string): number => {
		const list = index.postings.get(term) ?? [];
		for (let i = 0; i < list.length; i += 2) {
			if (list[i] !== id) continue;
			const tf = list[i + 1] as number;
			const section = index.sections[id] as Section;
			const norm = tf + K1 * (1 - B + (B * section.length) / index.averageLength[doc.source.origin]);
			return ((weights.get(term) ?? 0) * idf(index, term) * tf * (K1 + 1)) / norm;
		}
		return 0;
	};
	const scored = [...weights.keys()].filter((term) => !doc.names.has(term));
	let best = doc.sections[0] ?? 0;
	let bestScore = -1;
	for (const id of doc.sections) {
		const total = scored.reduce((sum, term) => sum + per(id, term), 0);
		if (total > bestScore) [best, bestScore] = [id, total];
	}
	const terms = [...weights].map(([term, weight]) => {
		const field = (index.fieldPostings.get(term) ?? []).includes(docIndex)
			? weight * idf(index, term) * (doc.names.has(term) ? K1 + 1 : 1)
			: 0;
		return {
			term,
			weight,
			idf: idf(index, term),
			sectionsWithTerm: (index.postings.get(term)?.length ?? 0) / 2,
			section: doc.names.has(term) ? 0 : per(best, term),
			field,
		};
	});
	return {
		ref,
		score: terms.reduce((sum, term) => sum + term.section + term.field, 0),
		heading: headingPath(index, best),
		terms,
	};
}

// ------------------------------------------------------------------ 取一块

export interface PassageOutlineEntry {
	heading: string;
	/** 1 起的行号范围。 */
	lines: string;
	bytes: number;
}

/** 一篇的目录：每一节的标题、行号、大小。 */
export function outlineOf(index: PassageIndex, ref: string): PassageOutlineEntry[] {
	const doc = docOf(index, ref);
	if (doc === undefined) return [];
	return doc.sections
		.map((id) => index.sections[id] as Section)
		.filter((section) => section.level === doc.unitLevel)
		.map((section) => ({
			heading: section.heading,
			lines: `${String(section.start + 1)}-${String(section.spanEnd)}`,
			bytes: spanBytes(doc, section.start, section.spanEnd),
		}));
}

/**
 * 不经检索、直接要某一篇时回哪一块：小篇整篇，大篇给开头（第一节之前的引言），调用方再附目录。
 */
export function docBlock(index: PassageIndex, ref: string): Omit<PassageHit, "score"> | null {
	const doc = docOf(index, ref);
	if (doc === undefined) return null;
	const base = { source: doc.source, heading: "", docBytes: doc.bodyBytes, units: doc.units, matched: [], also: [] };
	if (doc.bodyBytes <= WHOLE_DOC_BYTES) {
		return {
			...base,
			block: { start: doc.bodyStart, end: doc.lines.length, scope: "doc", heading: "", bytes: doc.bodyBytes },
		};
	}
	const firstUnit = doc.sections
		.map((id) => index.sections[id] as Section)
		.find((section) => section.level === doc.unitLevel);
	const end = firstUnit?.start ?? doc.lines.length;
	return {
		...base,
		block: { start: doc.bodyStart, end, scope: "intro", heading: "", bytes: spanBytes(doc, doc.bodyStart, end) },
	};
}

export function hasDoc(index: PassageIndex, ref: string): boolean {
	return docOf(index, ref) !== undefined;
}

export type SectionLookup =
	| { ok: true; heading: string; start: number; end: number; text: string }
	| { ok: false; reason: string; headings: string[] };

const plain = (heading: string): string => heading.replace(/`/g, "").trim().toLowerCase();

/**
 * 按标题取一节（连子标题）：`show <路径>#<标题>`。
 *
 * 给的可以是整条标题路径（搜索结果里那样，`a › b`），按最后一级比。先整句比，再按包含比；
 * 包含比出多个就报出来让调用方挑，不猜。
 */
export function sectionByHeading(index: PassageIndex, ref: string, wanted: string): SectionLookup {
	const doc = docOf(index, ref);
	if (doc === undefined) return { ok: false, reason: "索引里没有这篇", headings: [] };
	const target = plain(wanted.split(HEADING_SEPARATOR.trim()).at(-1) ?? wanted);
	const ids = doc.sections.filter((id) => (index.sections[id] as Section).level > 0);
	const exact = ids.filter((id) => plain((index.sections[id] as Section).heading) === target);
	const loose =
		exact.length > 0 || target === ""
			? exact
			: ids.filter((id) => plain((index.sections[id] as Section).heading).includes(target));
	if (loose.length === 1) {
		const section = index.sections[loose[0] as number] as Section;
		return {
			ok: true,
			heading: headingPath(index, loose[0] as number),
			start: section.start,
			end: section.spanEnd,
			text: doc.lines.slice(section.start, section.spanEnd).join("\n").trim(),
		};
	}
	const headings =
		loose.length > 1
			? loose.map((id) => headingPath(index, id))
			: ids
					.filter((id) => (index.sections[id] as Section).level === doc.unitLevel)
					.map((id) => headingPath(index, id));
	return {
		ok: false,
		reason: loose.length > 1 ? `有 ${String(loose.length)} 个标题都含「${wanted}」` : `这篇没有标题「${wanted}」`,
		headings,
	};
}
