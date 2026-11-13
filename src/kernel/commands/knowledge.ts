/**
 * `knowledge` -- read-only queries against the official knowledge base (S5.1).
 *
 * Six sub-commands, ported from the frozen tools/knowledge.mjs: status, routes,
 * scenes, search, show, audit. All read-only; none of them starts a JVM, opens a
 * Cosmic connection or needs a complete project config, which is why they are the
 * first commands migrated after the fast -> probe slice.
 *
 * The D13 inversion lands here. In the frozen CLI every one of these threw
 * "未配置知识根目录" unless the user had pointed knowledgeRoot at an app-build
 * install; the knowledge base now ships with the product, so the source is
 * resolved once (resolveKnowledgeSource) and every report carries which source
 * won and at what version. `knowledge status` is no longer "is it configured"
 * but "which documents am I actually reading" -- a question that has an answer
 * even when the user has configured nothing at all.
 *
 * Every function returns a report. The frozen versions printed and returned an
 * exit code, which forced the caller to scrape stdout to find out whether the
 * answer was empty; an agent has to branch on that (D9).
 */
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { type ApiDoc, parseApiDoc } from "../../knowledge/api-doc.ts";
import {
	type AnchorReport,
	type ApiJoin,
	anchorSweep,
	buildAnchorQueries,
	joinApi,
	parseSigOutput,
	type ReflectedClass,
	reflectedFieldName,
	renderAnchorQueries,
	renderJoinedMethod,
	renderReflectedMethod,
} from "../../knowledge/api-join.ts";
import {
	apiItems,
	classifyQuery,
	clean,
	describeAttach,
	describeBinding,
	describeVerify,
	type FacetOptions,
	facetGate,
	facetVerdict,
	type ItemKind,
	KNOWLEDGE_GUIDES,
	type KnowledgeItem,
	PLUGIN_ROUTES,
	type PluginAttach,
	parseFrontMatter,
	parseSceneIndex,
	type QueryRoute,
	referenceSkillName,
	SCENE_FACET_KEYS,
	SCENE_PREFIX,
	type ScoredItem,
	type SearchOptions,
	sceneDocPaths,
	sceneFacetColumn,
	sceneItems,
	scoreItem,
} from "../../knowledge/catalog.ts";
import { type KnowledgeBase, type KnowledgeDocsPort, resolveDocPath, toPosix } from "../../knowledge/docs.ts";
import {
	blockText,
	buildPassageIndex,
	docBlock,
	docText,
	HEADING_SEPARATOR,
	hasDoc,
	outlineOf,
	type PassageHit,
	type PassageIndex,
	type PassageOrigin,
	type PassageSource,
	queryWords,
	searchPassages,
	sectionByHeading,
	tokenize,
} from "../../knowledge/passages.ts";
import { type JavaSourcePort, type PluginFamily, type PluginTier, pluginBaseOf } from "../../knowledge/plugin-base.ts";
import { type PluginHint, pluginHints } from "../../knowledge/plugin-gate.ts";
import { type LocalReferenceDoc, REFERENCE_FAMILIES, TOOL_REFERENCE_DOCS } from "../../knowledge/reference.ts";
import { KNOWLEDGE_REQUIRED_ENTRIES, type KnowledgeSourceStatus } from "../../knowledge/source.ts";
import { sha256 } from "../../runtime/fingerprint.ts";
import { type ReflectionPort, UNAVAILABLE_REFLECTION } from "../api-tool.ts";
import { parseSuggest } from "../diag/javac.ts";
import { err, KernelError, type KernelErrorDetail, type KernelResult, ok } from "../errors.ts";
import type { ProbeCatalogEntry } from "./probe.ts";

function invalidArgument(message: string, remedy: string, detail?: KernelErrorDetail): KernelError {
	return new KernelError("KNOWLEDGE_QUERY_INVALID", message, { remedy, ...(detail ? { detail } : {}) });
}

/** Which source is in force, on every report. Never omitted, even when nothing is wrong. */
export interface KnowledgeSourceLine {
	kind: "embedded" | "override";
	root: string;
	bundleVersion: string | null;
	snapshotId: string | null;
	/** Set when a configured override was rejected and the embedded snapshot took over. */
	degradedFrom: string | null;
}

export function sourceLine(status: KnowledgeSourceStatus): KnowledgeSourceLine {
	return {
		kind: status.kind,
		root: status.root,
		bundleVersion: status.inForce.bundleVersion,
		snapshotId: status.inForce.snapshotId,
		degradedFrom: status.overrideProblem === null ? null : status.overrideProblem.message,
	};
}

// ------------------------------------------------------------------- status

export interface KnowledgeStatusReport {
	source: KnowledgeSourceLine;
	/** Required entry files, and which of them are absent. Empty missing list is the healthy case. */
	requiredEntries: readonly string[];
	missingEntries: string[];
	fileCount: number;
	totalBytes: number;
	counts: { api: number; scenes: number; sdk: number; arch: number };
	/** Front-matter tallies, most frequent first. */
	frameworkVersions: [string, number][];
	statuses: [string, number][];
}

function countBy(values: readonly string[]): [string, number][] {
	const out = new Map<string, number>();
	for (const value of values) {
		const key = value === "" ? "unknown" : value;
		out.set(key, (out.get(key) ?? 0) + 1);
	}
	return [...out.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function metaOf(base: KnowledgeBase, relativePath: string, key: string): string {
	const value = parseFrontMatter(base.read(relativePath) ?? "")[key];
	if (Array.isArray(value)) return value.join(",");
	return value ?? "";
}

export function knowledgeStatus(base: KnowledgeBase, status: KnowledgeSourceStatus): KnowledgeStatusReport {
	const docs = base.docs();
	const under = (prefix: string): number => docs.filter((doc) => doc.relativePath.startsWith(`${prefix}/`)).length;
	return {
		source: sourceLine(status),
		requiredEntries: KNOWLEDGE_REQUIRED_ENTRIES,
		missingEntries: KNOWLEDGE_REQUIRED_ENTRIES.filter((entry) => !base.exists(entry)),
		fileCount: docs.length,
		totalBytes: docs.reduce((sum, doc) => sum + doc.bytes, 0),
		counts: {
			api: under("platform/api"),
			scenes: under("platform/scenes"),
			sdk: under("platform/sdk"),
			arch: under("arch"),
		},
		frameworkVersions: countBy(docs.map((doc) => metaOf(base, doc.relativePath, "framework_version"))),
		statuses: countBy(docs.map((doc) => metaOf(base, doc.relativePath, "status"))),
	};
}

// ------------------------------------------------------------------- routes

export interface RouteRow {
	base: string;
	/** Official scene tag, or null when the official index never tagged this family. */
	pluginType: string | null;
	/** Scene count for the tag; null when untagged, and "unknown" is impossible here because the source always resolves now. */
	sceneCount: number | null;
	guide: string;
	bind: string | null;
	/** 还没挂上时怎么挂，一句话；null = 没有探针能挂。 */
	attach: string | null;
	/** Rendered through the command map, so a migrated capability stops printing a CLI line. */
	verify: string;
	local: string;
	/** Section name in the browser-boundary audit. Null means never audited, NOT "no browser needed". */
	browser: string | null;
}

export interface KnowledgeRoutesReport {
	source: KnowledgeSourceLine;
	rows: RouteRow[];
	notes: string[];
}

export function knowledgeRoutes(base: KnowledgeBase, status: KnowledgeSourceStatus): KnowledgeRoutesReport {
	const scenes = sceneItems(base, false);
	return {
		source: sourceLine(status),
		rows: PLUGIN_ROUTES.map((route) => ({
			base: route.base,
			pluginType: route.pluginType,
			sceneCount:
				route.pluginType === null
					? null
					: scenes.filter((item) => facetGate(item, { pluginType: route.pluginType ?? "" }) !== null).length,
			guide: route.guide,
			bind: route.bind,
			attach: route.attach === null ? null : describeAttach(route.attach),
			verify: describeVerify(route.verify),
			local: route.local,
			browser: route.browser,
		})),
		notes: [
			"场景标签为 null 表示官方场景索引没给这一族打过标签，只读指南；不是「没有场景」。",
			"行为验证为空表示当前没有无头适配器，不是漏写；起节点验。",
			"浏览器边界一栏是审计里的节名，不是结论：null = 没做过事件级审计，不等于不用浏览器。",
		],
	};
}

// ------------------------------------------------------------------- scenes

export interface SceneFacetAccount {
	facet: keyof FacetOptions;
	/** Column name in the official index, so a reader can go and look. */
	column: string;
	wanted: string;
	/** Rows whose tag matched. */
	hit: number;
	/** Rows dropped because their tag disagreed. */
	dropped: number;
	/**
	 * Rows kept because their tag is one this facet never excludes -- `common` on
	 * pluginType, the cross-family scenes.
	 *
	 * Counted because it was the missing fourth verdict. `facetMatch` returns
	 * hit/neutral/miss/unknown and this report only ever tallied three of them, so
	 * on the real snapshot `pluginType=表单插件` reported hit 0 / dropped 95 /
	 * untagged 2 -- three numbers explaining 97 of 167 rows -- and then returned
	 * 72. The 70 `common` rows were invisible here while being the bulk of the
	 * answer, which made `facetWarnings` describe a table it was not looking at.
	 */
	neutral: number;
	/** Rows kept although they were never tagged with this facet at all. */
	untagged: number;
}

export interface KnowledgeScenesReport {
	source: KnowledgeSourceLine;
	facets: FacetOptions;
	includeDraft: boolean;
	total: number;
	rows: { relativePath: string; title: string; keywords: string; event: string; control: string }[];
	/** What each facet did to the table. Empty when no facet was given. */
	filter: SceneFacetAccount[];
	/** How much of the table this answer is. 1 when no facet was given. */
	coverage: number;
	/** Facts about the filtering the caller has to see to read the rows correctly. */
	warnings: string[];
	/** How to read one of them. Rendered through the command map. */
	howToRead: string;
}

/**
 * Per-facet accounting for one filtered table (S7.3).
 *
 * Both filtering rules the stage has to preserve are invisible without it. An
 * untagged row that survives a filter looks exactly like a matching row, and a
 * facet that removed seven rows in ten looks exactly like a knowledge base that
 * only has three. Counting the verdicts the filter itself produced -- not a
 * second comparison -- is what keeps the report honest about which happened.
 */
function accountFacets(all: readonly KnowledgeItem[], options: FacetOptions): SceneFacetAccount[] {
	const out: SceneFacetAccount[] = [];
	for (const facet of SCENE_FACET_KEYS) {
		const wanted = options[facet];
		if (wanted === undefined || wanted === "") continue;
		const account: SceneFacetAccount = {
			facet,
			column: sceneFacetColumn(facet),
			wanted,
			hit: 0,
			dropped: 0,
			neutral: 0,
			untagged: 0,
		};
		for (const item of all) {
			const verdict = facetVerdict(item, facet, wanted);
			if (verdict === "hit") account.hit += 1;
			else if (verdict === "miss") account.dropped += 1;
			else if (verdict === "neutral") account.neutral += 1;
			else account.untagged += 1;
		}
		out.push(account);
	}
	return out;
}

/**
 * What the caller has to know to read a filtered table correctly (S7.3).
 *
 * Measured on the real snapshot, and the numbers are why these are warnings
 * rather than a footnote: `event=afterF7Select` returns 89 of 167 rows, of which
 * exactly ONE matched the event -- the other 88 are rows the official index
 * never tagged, kept because "untagged" is not "does not match". A caller shown
 * only the 89 rows would reasonably read them as 89 scenes about that event.
 *
 * Filtering by trigger event also assumes the answer: the event name is usually
 * the thing being looked for, and it removed seven of nine hits on the eval
 * batch. Both the historical ratio and this run's own counts are reported --
 * the first explains the rule, the second says what it cost here.
 *
 * The `neutral` clauses were added with the count itself. Before them these
 * sentences were written as though the only reason a row could survive without
 * matching was "never tagged", so `pluginType=表单插件` -- 0 hits, 70 `common`
 * rows, 2 untagged -- said "留下的 2 条全部是从未标注的" while handing back 72
 * rows. A warning that exists to stop a table being misread must not be the
 * thing misreading it.
 */
function facetWarnings(accounts: readonly SceneFacetAccount[], total: number): string[] {
	const out: string[] = [];
	for (const account of accounts) {
		const tagged = account.hit + account.dropped;
		if (account.facet === "event" && account.dropped > 0) {
			out.push(
				`event=${account.wanted} 排除了 ${account.dropped}/${total} 条；标过 ${account.column} 的一共 ${tagged} 条，` +
					`其中 ${account.dropped} 条被排除。实测这个过滤砍掉约七成（同一批 eval 9 条里 7 条消失），` +
					"而事件名往往正是要查的东西——用它过滤等于先假设答案。没把握就去掉 event 读整表。",
			);
		}
		if (account.untagged === 0 && account.neutral === 0) continue;
		const column =
			account.facet === "pluginType"
				? `${account.column} 一栏`
				: `${account.column} 一栏（官方索引 27 个分节里只有 5 个带这一列）`;
		// Only `miss` is excluded, so these three are exactly the rows that came
		// back. Spelling the sum out is what makes the warning checkable against
		// the table beside it.
		const kept = account.hit + account.neutral + account.untagged;
		const commonClause = `${account.neutral} 条标着 ${account.column}=common（通用场景，对任何取值都不排除）`;
		const untaggedClause = `${account.untagged} 条 ${column}从未标注、按「未知」保留`;
		if (account.hit === 0) {
			const composition =
				account.neutral === 0
					? `留下的 ${account.untagged} 条全部是 ${column}从未标注、按「未知」保留的。`
					: account.untagged === 0
						? `留下的 ${account.neutral} 条全部标着 ${account.column}=common（通用场景，对任何取值都不排除）。`
						: `留下的 ${kept} 条里，${commonClause}，${untaggedClause}。`;
			out.push(
				`结果里没有一条是靠 ${account.wanted} 匹配上的：${composition}要按这一栏筛选，先确认它确实被标注过。`,
			);
			continue;
		}
		const rest = [account.neutral === 0 ? "" : commonClause, account.untagged === 0 ? "" : untaggedClause].filter(
			(clause) => clause !== "",
		);
		const lead =
			account.untagged === 0 ? "" : `${account.untagged}/${total} 条在 ${column}从未标注，按「未知」保留在结果里。`;
		out.push(
			`${lead}真正标着 ${account.wanted} 的只有 ${account.hit} 条；` +
				`其余 ${kept - account.hit} 条不是匹配成功，只是没被排除：${rest.join("，")}。`,
		);
	}
	return out;
}

/**
 * The whole scene table, filtered only by facets.
 *
 * Deliberately no scoring: measured recall of literal matching on business-voiced
 * questions was 3/10, while the full table is ~169 rows x ~130 bytes and the
 * caller can pick semantically. Identifier lookups still go through search.
 */
export function knowledgeScenes(
	base: KnowledgeBase,
	status: KnowledgeSourceStatus,
	options: SearchOptions = {},
): KnowledgeScenesReport {
	const includeDraft = Boolean(options.includeDraft);
	const all = sceneItems(base, includeDraft);
	const rows = all
		.filter((item) => facetGate(item, options) !== null)
		.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
		.map((item) => ({
			relativePath: item.relativePath.startsWith(SCENE_PREFIX)
				? item.relativePath.slice(SCENE_PREFIX.length)
				: item.relativePath,
			title: item.title,
			keywords: item.keywords,
			event: item.event ?? "",
			control: item.control ?? "",
		}));
	const facets: FacetOptions = {};
	if (options.pluginType) facets.pluginType = options.pluginType;
	if (options.event) facets.event = options.event;
	if (options.control) facets.control = options.control;
	const filter = accountFacets(all, facets);
	return {
		source: sourceLine(status),
		facets,
		includeDraft,
		total: all.length,
		rows,
		filter,
		coverage: all.length === 0 ? 1 : rows.length / all.length,
		warnings: facetWarnings(filter, all.length),
		howToRead: `cosmic_knowledge show ${SCENE_PREFIX}<路径>`,
	};
}

// ------------------------------------------------------------------- search

/**
 * 只列别的篇在哪的目录页，不进段落索引：它们每一段只有"某类 → 某路径"一行，
 * 正文都在被指向的那篇里，进了索引只会和正文抢前五名。
 */
function isDirectoryDoc(relativePath: string): boolean {
	return (
		relativePath === "platform/api/api-index.md" ||
		relativePath.startsWith("platform/api/scene/") ||
		basename(relativePath) === "_index.md"
	);
}

let cachedIndex: { key: string; index: PassageIndex } | null = null;

/**
 * 两份资料的段落索引：第一次查询时建，之后同一份资料复用（官方 1,763 篇加本地 29 篇约 0.5 秒）。
 * 键是知识根目录、篇数、总字节和本地篇名：换了覆盖目录或重新释放快照，键就变了。
 */
export function passageIndexFor(base: KnowledgeBase, local: readonly LocalReferenceDoc[]): PassageIndex {
	const docs = base.docs().filter((doc) => !isDirectoryDoc(doc.relativePath));
	const key = [
		base.root,
		docs.length,
		docs.reduce((sum, doc) => sum + doc.bytes, 0),
		local.map((doc) => `${doc.name}:${doc.source.length}`).join(","),
	].join("|");
	if (cachedIndex?.key === key) return cachedIndex.index;
	// 场景索引表本身不进索引，但它给每个场景写的场景名、关键词、事件、控件是这篇的词
	const indexed = new Map(
		parseSceneIndex(base).map((item) => [
			item.relativePath,
			[item.title, item.keywords, item.event, item.control].filter(Boolean).join(" "),
		]),
	);
	const sources: PassageSource[] = [];
	for (const doc of docs) {
		const text = base.read(doc.relativePath);
		if (text === null) continue;
		const about = indexed.get(doc.relativePath);
		sources.push({
			origin: "official",
			ref: doc.relativePath,
			file: doc.file,
			text,
			...(about === undefined ? {} : { about }),
		});
	}
	for (const doc of local) {
		sources.push({ origin: "local", ref: `${LOCAL_REF_PREFIX}${doc.name}`, file: doc.file, text: doc.source });
	}
	const index = buildPassageIndex(sources);
	cachedIndex = { key, index };
	return index;
}

/** 本地参考文档在知识库命令里的写法：`reference:<篇名>`，`show` 和搜索结果都用它。 */
export const LOCAL_REF_PREFIX = "reference:";

const ORIGIN_LABEL: Record<PassageOrigin, string> = { official: "官方", local: "本环境实测" };

/** 一次搜索里，排在前面的块直接带正文，合计不超过这个数；其余给 `show` 的写法。 */
export const SEARCH_INLINE_BYTES = 6144;
/** 只有前这么多条有资格带正文。 */
const SEARCH_INLINE_RANKS = 3;
/** 除第一名外，分数够第一名的这个比例才带正文。 */
const SEARCH_INLINE_SHARE = 0.7;

export interface KnowledgeSearchHit {
	/** 官方知识库，还是本环境实测写下的本地参考文档。 */
	origin: string;
	/** 官方：知识根目录下的相对路径；本地：`reference:<篇名>`。 */
	relativePath: string;
	/** 磁盘上的绝对路径。 */
	file: string;
	/** 这一篇里分最高的那一段的标题路径（`节 › 小节`）；整篇只有一块时可能为空。 */
	heading: string;
	/** 回来的这一块是整篇的哪一部分。 */
	scope: string;
	/** 这一块在原文里的行号（1 起）。 */
	lines: string;
	/** 用 `show` 取回这一块的 query 写法。 */
	show: string;
	score: number;
	/** 这一块的正文。排在前面、放得下的才带；没带的按 `show` 取。 */
	text?: string;
	/** 没带正文时：命中词最多的两行（`行号: 原文`）。 */
	matched?: string[];
	/** 同一篇里这一块之外也命中的段，只给标题。 */
	also?: string[];
	/** 命中落在大篇的开头（整篇都相关、没有哪一节特别相关）时，给整篇目录：每节一行「标题」行号、大小。 */
	outline?: string[];
}

export interface KnowledgeSearchReport {
	source: KnowledgeSourceLine;
	query: string;
	options: SearchOptions;
	/** Results after the limit. `matched` is the count before it. */
	results: KnowledgeSearchHit[];
	matched: number;
	/** Which L2 channel this query belongs to, and why (S7.3). */
	route: QueryRoute;
	/**
	 * Set when the query was routed to the wrong channel: it names the measured
	 * recall gap and how many scene rows this answer did not consider. Null when
	 * search was the right channel.
	 */
	steer: string | null;
	/** Facet accounting, same rules as scenes. Empty when no facet was given. */
	filter: SceneFacetAccount[];
	warnings: string[];
	/** 两份资料里一处也没有的查询词。没有就不带。 */
	absent?: string[];
	/** 查询词里点到的已发布探针：它的全部入参（探针源码开头的参数注释）。没有就不带。 */
	probes?: Record<string, string[]>;
}

const kb = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KB`;

function outlineLines(index: PassageIndex, ref: string): string[] {
	return outlineOf(index, ref).map((entry) => `「${entry.heading}」第 ${entry.lines} 行，${kb(entry.bytes)}`);
}

function scopeText(hit: PassageHit): string {
	const block = hit.block;
	const whole = `整篇 ${kb(hit.docBytes)}，共 ${String(hit.units)} 节`;
	if (block.scope === "doc") return `整篇（${kb(block.bytes)}）`;
	if (block.scope === "intro") return `开头（${kb(block.bytes)}；${whole}，目录见 outline）`;
	// 块的标题就是 show 里 # 后面那段，这里不再写一遍
	return `${block.scope === "unit" ? "一节" : "一节里的一段"}（${kb(block.bytes)}；${whole}）`;
}

function showArgument(hit: PassageHit): string {
	if (hit.block.scope === "doc" || hit.block.scope === "intro" || hit.block.heading === "") return hit.source.ref;
	const last = hit.block.heading.split(HEADING_SEPARATOR).at(-1) ?? hit.block.heading;
	return `${hit.source.ref}#${last}`;
}

/** 查询词点到的工具名 → 讲它用法的本地文档。整条查询只有工具名时，直接给那篇的目录。 */
function toolDocsIn(words: readonly string[]): string[] {
	return words
		.map((word) => TOOL_REFERENCE_DOCS[word.toLowerCase().replace(/-/g, "_")])
		.filter((name): name is string => name !== undefined);
}

/**
 * 业务说法的题，两条路各找回几道（`npm run verify:eval` 那一批，检索看前 3 条）。
 *
 * 写进下面那句改道提示，所以必须是实测数：verify:eval 每次重量，和这里对不上就失败，
 * 改了检索要回来改这里。全文检索按两字切词，业务说法和资料用语常常一个词都对不上
 * （"删之前先弹个框"对"确认框"），整表读靠模型自己理解，差距就是这么来的。
 */
export const SCENE_QUESTION_RECALL = { search: 7, table: 22, total: 22 } as const;

/** 查询里有英文或数字：在查类名、方法名、工具名、配置项这类具体的词，字面检索就是对的路。 */
const NAMED_WORD = /[A-Za-z0-9]/;

/** 改道提示看前几条：和带正文的名额一样多，模型先读的就是这几条。 */
const STEER_TOP = 3;

/**
 * The sentence a misrouted query gets back with its results (S7.3).
 *
 * Not a refusal: search still returns what it found, and for a symbol it is the
 * right channel. What this prevents is a business question receiving three rows
 * that look like the whole answer. The ratio is the eval's, re-checked on every
 * verify:eval run (SCENE_QUESTION_RECALL); the local count is what tells the
 * caller what it is missing right now.
 *
 * S45 批 6：只在真该改道时出。全文检索之后，带中文或不止一个词的查询多数已经答对了
 * （批 5 之后 20 条回来的查询里 15 条带着这句，14 条答案排第一），还照样劝去多读 12 KB 的场景表，
 * 等于说了假话。现在要两条都成立：查询里没有英文和数字（纯业务说法），而且前几条里没有场景。
 * 不看前几条有没有本地文档：业务说法查回来的前几条常常是不相干的工具文档，答案场景却没回来，正该劝。
 * 用同一批查询比过几种判法，见 S45 批 6（`measure-knowledge-retrieval.ts --cases … --steer`）。
 */
function steerToTable(
	route: QueryRoute,
	query: string,
	results: readonly { relativePath: string }[],
	sceneCount: number | null,
): string | null {
	// No steer when the caller deliberately excluded scenes with `kind`: pointing
	// at a table they just said they did not want is noise, and the row count
	// would be zero anyway.
	if (route.channel !== "scene-question" || query === "" || sceneCount === null) return null;
	if (NAMED_WORD.test(query)) return null;
	if (results.slice(0, STEER_TOP).some((item) => item.relativePath.startsWith(SCENE_PREFIX))) return null;
	const found = results.filter((item) => item.relativePath.startsWith(SCENE_PREFIX)).length;
	return (
		`这是场景类问题（${route.why}）。业务说法和资料用语常对不上：评测集 ${SCENE_QUESTION_RECALL.total} 道业务题，` +
		`全文检索前 3 条找到场景的 ${SCENE_QUESTION_RECALL.search} 道，读整张场景表 ${SCENE_QUESTION_RECALL.table} 道；` +
		`本次命中 ${found} 条场景，整张场景表共 ${sceneCount} 条。` +
		"改用 cosmic_knowledge scenes 读整表（按 pluginType 过滤后约 12 KB，一次会话读一次，之后场景查询免费），再用 show 取正文。"
	);
}

/** 下划线连起来、像单据或字段标识的词。 */
const PROJECT_IDENTIFIER = /^[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+$/;

export function knowledgeSearch(
	base: KnowledgeBase,
	status: KnowledgeSourceStatus,
	query: string,
	options: SearchOptions = {},
	local: readonly LocalReferenceDoc[] = [],
	probes: readonly ProbeCatalogEntry[] = [],
): KernelResult<KnowledgeSearchReport> {
	const kind = options.kind ?? "all";
	const limit = options.limit ?? 5;
	if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
		return err(invalidArgument("limit 必须是 1..10 的整数", "改成 1 到 10 之间的整数再查。"));
	}
	// Trimmed, not compared raw. A query of spaces used to slip past the guard and
	// come back "0 命中", which reads as "the knowledge base has nothing on this"
	// rather than as "you asked for nothing" -- the same shape as defect D-3, one
	// layer down. S7.2 recorded this as an observation; S7.3 owns query routing, so
	// it is fixed here.
	const wanted = clean(query);
	if (wanted === "" && !options.pluginType && !options.event && !options.control) {
		return err(
			invalidArgument("search 至少需要关键词或过滤条件", "给一个关键词，或用 pluginType/event/control 过滤。"),
		);
	}

	const facets: FacetOptions = {};
	if (options.pluginType) facets.pluginType = options.pluginType;
	if (options.event) facets.event = options.event;
	if (options.control) facets.control = options.control;
	const scenes = kind === "all" || kind === "scene" ? sceneItems(base, Boolean(options.includeDraft)) : null;
	const filter = accountFacets(scenes ?? [], facets);
	// 场景照旧受草稿和 pluginType/event/control 过滤；别的篇不受这三项影响
	const allowedScenes = new Set(
		(scenes ?? []).filter((item) => facetGate(item, facets) !== null).map((item) => item.relativePath.toLowerCase()),
	);
	const guides = new Set(KNOWLEDGE_GUIDES.map(([path]) => path));
	const kindOf = (relativePath: string): ItemKind | "other" => {
		if (guides.has(relativePath)) return "guide";
		if (relativePath.startsWith(SCENE_PREFIX)) return "scene";
		if (relativePath.startsWith("platform/sdk/")) return "sdk";
		if (relativePath.startsWith("platform/api/")) return "api";
		return "other";
	};
	const allow = (source: PassageSource): boolean => {
		if (source.origin === "local") return kind === "all";
		const docKind = kindOf(source.ref);
		if (kind !== "all" && docKind !== kind) return false;
		return docKind !== "scene" || allowedScenes.has(source.ref.toLowerCase());
	};

	const index = passageIndexFor(base, local);
	const words = queryWords(wanted);
	const tools = [...new Set(toolDocsIn(words))].filter((name) => hasDoc(index, `${LOCAL_REF_PREFIX}${name}`));
	const probeNames = new Map(probes.map((entry) => [entry.name.toLowerCase(), entry]));
	const named = words.flatMap((word) => probeNames.get(word.toLowerCase()) ?? []);
	const boost = new Map(tools.map((name) => [`${LOCAL_REF_PREFIX}${name}`, 2]));
	// 整条查询是一个全限定类名、而官方正好有这个类的文档：它排第一
	if (wanted.includes(".")) {
		const exact = apiItems(base).find((item) => item.fqcn === wanted);
		if (exact !== undefined) boost.set(exact.relativePath, 10);
	}

	let hits: PassageHit[];
	let matched: number;
	let absent: string[] = [];
	if (wanted === "") {
		// 只有过滤条件：照旧按场景标签列出这一族的场景，整篇是一块
		const rows = (scenes ?? [])
			.map((item) => scoreItem(item, "", options))
			.filter((item): item is ScoredItem => item !== null)
			.filter((item) => allow({ origin: "official", ref: item.relativePath, file: "", text: "" }));
		matched = rows.length;
		hits = rows.slice(0, limit).flatMap((item) => passageForDoc(index, item.relativePath, item.score));
	} else if (tools.length > 0 && tools.length === words.length) {
		// 整条查询只有工具名：答案是那篇用法文档本身，给开头和整篇目录，不从里面随便挑一段
		hits = tools.flatMap((name) => passageForDoc(index, `${LOCAL_REF_PREFIX}${name}`, 0));
		matched = hits.length;
	} else {
		const found = searchPassages(index, wanted, { allow, boost, limit });
		hits = found.hits;
		matched = found.matchedDocs;
		absent = found.absent;
	}

	let inlineBudget = SEARCH_INLINE_BYTES;
	const topScore = hits[0]?.score ?? 0;
	const results = hits.map((hit, rank): KnowledgeSearchHit => {
		const out: KnowledgeSearchHit = {
			origin: ORIGIN_LABEL[hit.source.origin],
			relativePath: hit.source.ref,
			file: hit.source.file,
			heading: hit.heading,
			scope: scopeText(hit),
			lines: `${String(hit.block.start + 1)}-${String(hit.block.end)}`,
			show: showArgument(hit),
			score: hit.score,
		};
		// 带正文的只有排在前面、分数够得上第一名一半的块：排在后面的多半不相干，带了白占上下文
		if (
			rank < SEARCH_INLINE_RANKS &&
			hit.score >= topScore * SEARCH_INLINE_SHARE &&
			hit.block.bytes <= inlineBudget
		) {
			inlineBudget -= hit.block.bytes;
			out.text = blockText(index, hit.source.ref, hit.block);
		} else if (hit.matched.length > 0) {
			out.matched = hit.matched;
		}
		if (hit.also.length > 0) out.also = hit.also;
		if (hit.block.scope === "intro") out.outline = outlineLines(index, hit.source.ref);
		return out;
	});

	const route = classifyQuery(wanted);
	const report: KnowledgeSearchReport = {
		source: sourceLine(status),
		query: wanted,
		options: searchOptionsOf(options, kind, limit),
		matched,
		results,
		route,
		steer: steerToTable(route, wanted, results, scenes === null ? null : scenes.length),
		filter,
		warnings: facetWarnings(filter, scenes?.length ?? 0),
	};
	if (absent.length > 0) {
		report.absent = absent;
		if (absent.some((word) => PROJECT_IDENTIFIER.test(word))) {
			report.warnings.push(
				`${absent.join("、")} 在两份资料里一处也没有。知识库只收平台和 cosmic 工具的资料，工程自己的单据、字段、表名不在里面；` +
					"查它们的元数据用探针（action=probes 列出各探针能查什么）。",
			);
		}
	}
	if (named.length > 0) report.probes = Object.fromEntries(named.map((entry) => [entry.name, entry.usage]));
	return ok(report);
}

/** 回显真正生效的检索选项；请求里的 action、query 不再抄一遍。 */
function searchOptionsOf(options: SearchOptions, kind: ItemKind | "all", limit: number): SearchOptions {
	const out: SearchOptions = { kind, limit };
	if (options.pluginType) out.pluginType = options.pluginType;
	if (options.event) out.event = options.event;
	if (options.control) out.control = options.control;
	if (options.includeDraft) out.includeDraft = true;
	return out;
}

/** 不经检索、直接给某一篇：小篇整篇，大篇给开头（调用方附目录）。 */
function passageForDoc(index: PassageIndex, ref: string, score: number): PassageHit[] {
	const block = docBlock(index, ref);
	if (block === null) return [];
	return [{ ...block, score }];
}

// --------------------------------------------------------------------- show

export interface KnowledgeShowReport {
	source: KnowledgeSourceLine;
	relativePath: string;
	/** Absolute path, so the caller can go back to the document with its own reader. */
	file: string;
	/** 取的是哪一节；读整篇时不带。 */
	heading?: string;
	/** 这一节在整篇里的行号（1 起）；读整篇时不带。 */
	lines?: string;
	content: string;
	/** 取一节时：整篇有哪几节（每节一行「标题」行号、大小），要别的节再按标题取。 */
	outline?: string[];
}

/**
 * `show` accepts a scenes-table row as printed.
 *
 * The scenes table prints paths relative to `platform/scenes/` to keep ~170 rows
 * short, and a real session passed one straight to `show` (2026-09-22 05:42) --
 * the obvious reading of the table. The prefix is added only when the literal
 * path is not a document, so a full relative path still wins.
 */
function resolveShowPath(base: KnowledgeBase, relativePath: string, port: KnowledgeDocsPort) {
	const literal = resolveDocPath(base, relativePath, port);
	const flat = toPosix(relativePath.trim());
	if (literal.ok || flat.startsWith(SCENE_PREFIX) || flat.split("/").includes("..")) return literal;
	const scene = resolveDocPath(base, `${SCENE_PREFIX}${flat}`, port);
	return scene.ok ? scene : literal;
}

/**
 * 读一篇，或按 `<路径>#<标题>` 读其中一节（连子标题）。路径可以是官方相对路径，也可以是
 * 搜索结果里的 `reference:<篇名>`（本地参考文档）。
 */
export function knowledgeShow(
	base: KnowledgeBase,
	status: KnowledgeSourceStatus,
	query: string,
	port: KnowledgeDocsPort,
	local: readonly LocalReferenceDoc[] = [],
): KernelResult<KnowledgeShowReport> {
	const hash = query.indexOf("#");
	const path = (hash < 0 ? query : query.slice(0, hash)).trim();
	const heading = hash < 0 ? "" : query.slice(hash + 1).trim();
	let file: string;
	let relativePath: string;
	let content: string;
	if (path.startsWith(LOCAL_REF_PREFIX)) {
		const name = path.slice(LOCAL_REF_PREFIX.length);
		const doc = local.find((entry) => entry.name === name);
		if (doc === undefined) {
			return err(
				invalidArgument(
					`本地文档里没有 ${name}`,
					local.length === 0
						? "本地文档这次没有加载成功，只能读官方库。"
						: `照搜索结果里的 show 原样给；本地文档有：${local.map((entry) => entry.name).join("、")}。`,
				),
			);
		}
		({ file } = doc);
		relativePath = path;
		content = doc.source;
	} else {
		const resolved = resolveShowPath(base, path, port);
		if (!resolved.ok) {
			// No absolute root here: naming the cache directory is an invitation to read
			// it with bash, which is how a real session spent 14 calls after a wrong path.
			return err(
				invalidArgument(
					resolved.reason,
					"scenes 表里的路径直接给 show 即可；search 结果里的 show、api 结果里的 relativePath 原样给。",
				),
			);
		}
		const text = port.read(resolved.file);
		if (text === null) {
			return err(invalidArgument("文档存在但读不出内容", "检查文件权限，或重新释放内嵌快照。"));
		}
		({ file, relativePath } = resolved);
		content = text;
	}
	if (heading === "") return ok({ source: sourceLine(status), relativePath, file, content });

	const index = passageIndexFor(base, local);
	const section = sectionByHeading(index, relativePath, heading);
	if (!section.ok) {
		return err(
			invalidArgument(
				`${relativePath}：${section.reason}`,
				section.headings.length === 0
					? "去掉 # 和后面的标题，读整篇。"
					: `照下面的标题原样写在 # 后面，或去掉 # 读整篇：${section.headings.join("；")}`,
			),
		);
	}
	return ok({
		source: sourceLine(status),
		relativePath,
		file,
		heading: section.heading,
		lines: `${String(section.start + 1)}-${String(section.end)}`,
		content: section.text,
		outline: outlineLines(index, relativePath),
	});
}

// ---------------------------------------------------------------------- api

/** One class's answer. A batch answers with a list of these, one per class asked about. */
export interface KnowledgeApiEntry {
	fqcn: string;
	/** The document that describes the class, or null when the snapshot has none. */
	relativePath: string | null;
	whenToUse: string;
	/** The join, or null when no document exists or reflection could not run. */
	join: ApiJoin | null;
	/** Why reflection could not run; null when the current JAR was checked. */
	reflectionUnavailable: string | null;
	/** True when the JAR does not have the class at all: the class-level 悬空. */
	classMissing: boolean;
	/** Rendered method entries, joined ones first. */
	methods: string[];
	/**
	 * 本类声明的 public、protected 字段（protected 的行首带 protected），静态常量带值（`static String is_notnull = "is not null"`）；按 `#名字` 查时只留同名的。
	 * 没反射成功时不带（S72：反射一直打出这些，解析时丢了，模型只好自己 javap -constants）。
	 */
	fields?: string[];
	/** 本类声明的 public、protected 构造，写成 `QFilter(String, String, Object)`；按 `#类名` 查时只留它们。没反射成功时不带。 */
	constructors?: string[];
	/**
	 * 父类全名。整类查时方法、字段只列本类声明的；按 `#名字` 查而本类没声明时，从父类和接口里找，
	 * 行尾标「继承自 某类」。没有父类（或是 Object）时为 null。
	 */
	superclass?: string | null;
	/**
	 * 反射时类所在 jar 的完整路径；没反射成功时为 null。给路径是为了要 javap 或解开看时不用满盘去找（S37）。
	 */
	jar: string | null;
	/**
	 * L1 insertion point 3 (S7.4): the queried class IS a plugin base class, so
	 * the official entry point for that family goes out with the answer.
	 *
	 * This is the migrated half of the frozen `knowledgeHintForQuery`, which hung
	 * off `sig` and `findclass`. `sig`'s capability is this action; `findclass`
	 * is still S5.2's, and gets the same hint when it lands. Recognition here is
	 * the `loose` tier by necessity -- the input is a class name, not a source --
	 * and the hint says so.
	 */
	pluginHint: PluginHint | null;
	/**
	 * The method this entry was narrowed to, when the query said `<fqcn>#<method>`.
	 *
	 * Carried so the agent boundary can tell a narrowed answer (already one
	 * method, hand it over whole) from a class-level one (signature lines only).
	 */
	member: string | null;
	/** Set when a `#member` query matched nothing, so an empty list is not read as "no such method verified". */
	memberMissing: boolean;
	/** 本地参考文档里讲到这个类（查的是方法时，讲到这个方法）的块，按相关度排。没有就不带。 */
	local?: ApiLocalPassage[];
}

/**
 * 本地参考文档里讲到某个类的一块：本环境实测下来的用法和坑，官方文档和 JAR 签名里都没有。
 * 只按类查时给位置和命中的两行，`show` 取正文；按方法查时排第一的那块直接带正文（一次回答合计 6 KB 内）。
 */
export interface ApiLocalPassage {
	/** 用 `show` 取回这一块的 query 写法：`reference:<篇名>` 或 `reference:<篇名>#<标题>`。篇名、标题都在里面，不另给。 */
	show: string;
	/** 回来的这一块是整篇的哪一部分。 */
	scope: string;
	/** 讲到它最多的那一段在块里的小节时，那一段的标题路径；就是块本身时不带。 */
	heading?: string;
	/** 没带正文时：提到它的两行（`行号: 原文`）。 */
	matched?: string[];
	/** 这一块的正文：按方法查时排第一的那块带，一次回答合计不超过 SEARCH_INLINE_BYTES。 */
	text?: string;
}

/**
 * The answer for one or more classes.
 *
 * A list rather than one class, because the caller that needs this most is the
 * ad-hoc probe: `PROBE_API_UNCHECKED` names every imported `kd.*` class at once,
 * and answering one per call turned a 13-import probe into 13 round trips, each
 * one a JVM reflection call and a full turn of context. The gate's judgement is
 * unchanged -- it still only asks whether a class was looked up -- but "look
 * them up" is now one action.
 *
 * `entries` preserves the order asked, so a caller reading down its own import
 * list can follow along.
 */
export interface KnowledgeApiReport {
	source: KnowledgeSourceLine;
	/** Every class asked about, in the order given. Never empty: an empty query is refused. */
	entries: KnowledgeApiEntry[];
}

/**
 * Splits an `api` query into class names.
 *
 * Whitespace, commas and semicolons all separate, because all three are how a
 * list of classes is already written: the refusal that sends people here prints
 * them space-separated, an import block pastes one per line, and prose uses
 * commas. Guessing between those would be a parsing rule to remember; accepting
 * all of them is not.
 */
export function parseFqcnList(query: string): string[] {
	const seen = new Set<string>();
	for (const token of query.split(/[\s,;、，；]+/)) {
		const fqcn = token.trim();
		if (fqcn !== "") seen.add(fqcn);
	}
	return [...seen];
}

/**
 * Splits `<fqcn>#<method>` into its two halves.
 *
 * The narrowing half of the api budget. A class-level answer is cut down to
 * signature lines, which is everything the import gate and a compiler need; when
 * a method is actually about to be called, this is how its prose comes back --
 * one method, in full, instead of the class's other fifty.
 *
 * A bare class name is the common case and stays untouched, so nothing that
 * worked before parses differently now.
 */
export function splitMemberQuery(token: string): { fqcn: string; member: string | null } {
	const hash = token.indexOf("#");
	if (hash <= 0) return { fqcn: token, member: null };
	const member = token.slice(hash + 1).trim();
	return { fqcn: token.slice(0, hash).trim(), member: member === "" ? null : member };
}

/**
 * `knowledge api <fqcn>` -- what D13 said `sig` should have been printing all along.
 *
 * The frozen `sig` printed a reflected signature plus one `when_to_use` sentence for
 * the whole class, because `apiItems` only ever read four frontmatter fields. The
 * method's own Chinese description, its real parameter names and its `@return` were
 * in the document body, unread. This joins the two.
 *
 * Reflection unavailable is REPORTED, not absorbed. Falling back to the document
 * alone would print a snapshot as if it had been checked against the user's JAR --
 * which is exactly the drift D8 exists to catch.
 */
/**
 * Why reflection answered null, as the port knows it.
 *
 * The fixed text below is the right guess only when a project IS open and the
 * tool still could not run. A port that knows better -- no project handed to it
 * at all -- says so, and the caller is not sent to rebuild a project that is
 * built.
 */
function reflectionDown(reflect: ReflectionPort, what: "反射" | "扫描"): string {
	return reflect.unavailable ?? `${what}不可用：ApiTool 未释放或编译失败，也可能还没跑过一次构建`;
}

async function apiEntry(
	base: KnowledgeBase,
	fqcn: string,
	reflect: ReflectionPort,
	items: readonly KnowledgeItem[],
	member: string | null = null,
): Promise<KnowledgeApiEntry> {
	const recognised = pluginBaseOf(fqcn);
	const [pluginHint = null] = recognised ? pluginHints(base, [{ ...recognised, file: fqcn }]) : [];
	const item = items.find((entry) => entry.fqcn === fqcn);
	let doc: ApiDoc | null = null;
	if (item !== undefined) {
		doc = parseApiDoc(item.relativePath, base.read(item.relativePath) ?? "").doc;
	}
	const sig = await reflect.sig(fqcn);
	const reflected = sig === null ? null : parseSigOutput(sig);
	const classMissing = sig !== null && reflected === null;
	const members = reflected === null ? null : reflectedMembers(reflected, member);
	if (doc === null) {
		// No document is not an error: the JAR has classes the snapshot never covered.
		// Reflection is still the source of truth for the methods it declares.
		const wanted =
			member === null
				? (reflected?.methods ?? [])
				: (reflected?.methods ?? []).filter((method) => method.name.toLowerCase() === member.toLowerCase());
		const own = wanted.length + (members?.count ?? 0);
		const up = reflected === null || own > 0 ? null : inheritedMatches(reflected, member);
		return {
			fqcn,
			relativePath: null,
			whenToUse: reflected === null ? "" : "没有文档说明；以下是当前 JAR 反射得到的真实签名",
			join: null,
			reflectionUnavailable: sig === null ? reflectionDown(reflect, "反射") : null,
			classMissing,
			methods: [...wanted.map(renderReflectedMethod), ...(up?.methods ?? [])],
			...withInheritedFields(members?.shown ?? {}, up),
			jar: reflected?.jar || null,
			pluginHint,
			member,
			memberMissing: member !== null && reflected !== null && own === 0 && (up?.count ?? 0) === 0,
		};
	}
	if (reflected === null) {
		return {
			fqcn,
			relativePath: doc.relativePath,
			whenToUse: doc.whenToUse,
			join: null,
			reflectionUnavailable: classMissing
				? "当前 JAR 里没有这个类：文档描述的是别的版本"
				: reflectionDown(reflect, "反射"),
			classMissing,
			// The document's own methods, explicitly NOT presented as verified.
			methods: doc.methods.map((method) => method.signature),
			jar: null,
			pluginHint,
			member,
			memberMissing: false,
		};
	}
	const join = joinApi(doc, reflected, reflected.inheritedMethods ?? []);
	// A `#member` query narrows to the methods of that name -- plural, because
	// overloads are different methods and picking one of them for the caller
	// would be a guess about which signature it meant.
	const named = (name: string): boolean => member === null || name.toLowerCase() === member.toLowerCase();
	const wanted = join.joined.filter((entry) => named(entry.documented.name));
	// What the JAR has and the document never described still exists: it goes out
	// as a bare signature after the documented ones. Leaving it out is how a
	// protected hook the snapshot skipped (`AbstractValidator.addErrorMessage`)
	// came back as "no such member".
	const bare = join.undocumented.filter((method) => named(method.name));
	const own = wanted.length + bare.length + (members?.count ?? 0);
	const up = own > 0 ? null : inheritedMatches(reflected, member);
	return {
		fqcn,
		relativePath: doc.relativePath,
		whenToUse: doc.whenToUse,
		join,
		reflectionUnavailable: null,
		classMissing: false,
		methods: [
			...wanted.flatMap((entry) => renderJoinedMethod(entry)),
			...bare.map(renderReflectedMethod),
			...(up?.methods ?? []),
		],
		...withInheritedFields(members?.shown ?? {}, up),
		jar: reflected.jar || null,
		pluginHint,
		member,
		memberMissing: member !== null && own === 0 && (up?.count ?? 0) === 0,
	};
}

/**
 * A `#name` this class does not declare, looked for on its superclasses and
 * interfaces. "Not declared here" is not "not on this class": `setFilter` is on
 * `AbstractListPlugin` because `IListPlugin` declares it. Each line names the
 * class that declares it, which is the one to query for its documentation.
 */
function inheritedMatches(
	reflected: ReflectedClass,
	member: string | null,
): { methods: string[]; fields: string[]; count: number } | null {
	if (member === null) return null;
	const wanted = member.toLowerCase();
	const methods = (reflected.inheritedMethods ?? [])
		.filter((method) => method.name.toLowerCase() === wanted)
		.map((method) => `${renderReflectedMethod(method)}  （继承自 ${method.declaringClass}）`);
	const fields = (reflected.inheritedFields ?? [])
		.filter((field) => reflectedFieldName(field.line).toLowerCase() === wanted)
		.map((field) => `${field.line}  （继承自 ${field.declaringClass}）`);
	return { methods, fields, count: methods.length + fields.length };
}

function withInheritedFields(
	shown: Partial<Pick<KnowledgeApiEntry, "fields" | "constructors" | "superclass">>,
	up: { fields: string[] } | null,
): Partial<Pick<KnowledgeApiEntry, "fields" | "constructors" | "superclass">> {
	if (up === null || up.fields.length === 0) return shown;
	return { ...shown, fields: [...(shown.fields ?? []), ...up.fields] };
}

/**
 * The non-method half of a reflected class: fields with their constant values,
 * constructors, and where the inherited members are (S72).
 *
 * `#<名字>` narrows these by the same rule as methods -- the exact name, any
 * case -- with the class's own simple name (or `<init>`) meaning its
 * constructors, so `QCP#is_notnull` and `QFilter#QFilter` each come back alone.
 */
function reflectedMembers(
	reflected: ReflectedClass,
	member: string | null,
): { shown: Pick<KnowledgeApiEntry, "fields" | "constructors" | "superclass">; count: number } {
	const simple = reflected.fqcn.slice(reflected.fqcn.lastIndexOf(".") + 1).toLowerCase();
	const wanted = member?.toLowerCase() ?? null;
	const fields = (reflected.fields ?? []).filter(
		(line) => wanted === null || reflectedFieldName(line).toLowerCase() === wanted,
	);
	const constructors =
		wanted === null || wanted === simple || wanted === "<init>" ? [...(reflected.constructors ?? [])] : [];
	return {
		shown: { fields, constructors, superclass: reflected.superclass },
		count: fields.length + constructors.length,
	};
}

/**
 * One or more classes, answered in the order asked.
 *
 * The document index (`apiItems`) is read once for the whole batch rather than
 * per class: it is the same corpus every time, and re-deriving it per class is
 * how a batch of thirteen would end up more expensive than thirteen calls.
 *
 * Each class is answered independently. A class the snapshot never covered, or
 * one the current JAR has dropped, does not spoil the classes around it -- an
 * all-or-nothing batch would push the caller straight back to one call each,
 * which is the cost this exists to remove.
 */
export async function knowledgeApi(
	base: KnowledgeBase,
	status: KnowledgeSourceStatus,
	query: string,
	reflect: ReflectionPort,
	local: readonly LocalReferenceDoc[] = [],
): Promise<KernelResult<KnowledgeApiReport>> {
	const wanted = parseFqcnList(query);
	if (wanted.length === 0) {
		return err(
			invalidArgument(
				"api 需要一个全限定类名",
				"例如 cosmic_knowledge api kd.bos.algo.Algo；多个类一次查完，空格或逗号隔开。",
			),
		);
	}
	const items = apiItems(base);
	// 顺序跑，不是 Promise.all：每个 entry 背后是一次 ApiTool JVM，并发起十个
	// 只会把机器压垮，而这条链本来就靠 sig 的批量参数省进程数。
	const entries: KnowledgeApiEntry[] = [];
	const index = local.length === 0 ? null : passageIndexFor(base, local);
	// 一次回答里带正文的本地块合计不超过这么多，和 search 同一条线；超了的给位置
	const inline = { left: SEARCH_INLINE_BYTES };
	for (const token of wanted) {
		const { fqcn, member } = splitMemberQuery(token);
		const entry = await apiEntry(base, fqcn, reflect, items, member);
		const passages = index === null ? [] : localPassagesFor(index, fqcn, member, inline);
		entries.push(passages.length === 0 ? entry : { ...entry, local: passages });
	}
	return ok({
		source: sourceLine(status),
		entries,
	});
}

/** 每个类最多带几篇本地参考文档的块。 */
const API_LOCAL_LIMIT = 3;
/** 一个 Java 简单名（类名、方法名）。 */
const JAVA_NAME = /^[A-Za-z_$][\w$]*$/;

/**
 * 本地参考文档里讲到这个类的块（按方法查时，类名和方法名一起算分）。
 *
 * 按整词查：类名、方法名要原样出现在正文里，不拆驼峰。和关键词检索不同，这里不设"太常见就不算"的门槛：
 * `QFilter`、`DynamicObject` 正是本地写得最多、坑最多的类，它们出现的篇越多，越不该被当成噪音丢掉。
 * 索引不分大小写，回来的块再按原样大小写核一遍：变量 `row`、`cell` 不是在讲 `Row`、`Cell` 类。
 */
function localPassagesFor(
	index: PassageIndex,
	fqcn: string,
	member: string | null,
	inline: { left: number },
): ApiLocalPassage[] {
	const simple = fqcn.slice(fqcn.lastIndexOf(".") + 1);
	const names = [simple, ...(member === null ? [] : [member])].filter((name) => JAVA_NAME.test(name));
	if (names[0] !== simple) return [];
	const [klass, method] = names.map((name) => new RegExp(`(?<![\\w$])${name.replace(/\$/g, "\\$")}(?![\\w$])`));
	const { hits } = searchPassages(index, names.join(" "), {
		allow: (source) => source.origin === "local",
		exact: true,
		limit: API_LOCAL_LIMIT * 4,
	});
	// 这一块点了类名；或者点了方法名、而这篇别处点了类名（`and` 这种方法名单独出现不算讲这个类）
	const kept = hits
		.map((hit) => ({ hit, text: blockText(index, hit.source.ref, hit.block) }))
		.filter(
			({ hit, text }) =>
				klass?.test(text) === true ||
				(method?.test(text) === true && klass?.test(docText(index, hit.source.ref)) === true),
		)
		.slice(0, API_LOCAL_LIMIT);
	return kept.map(({ hit, text }, rank) => {
		const out: ApiLocalPassage = { show: showArgument(hit), scope: scopeText(hit) };
		if (hit.heading !== "" && hit.heading !== hit.block.heading) out.heading = hit.heading;
		// 按方法查是要动手调这个方法了：排第一的那块正文直接给，和方法说明一起读
		if (member !== null && rank === 0 && hit.block.bytes <= inline.left) {
			inline.left -= hit.block.bytes;
			out.text = text;
		} else if (hit.matched.length > 0) {
			out.matched = hit.matched;
		}
		return out;
	});
}

// ---------------------------------------------------------------- findclass

export interface FoundClass {
	fqcn: string;
	/** The jar file the class was found in. */
	jar: string;
}

export interface KnowledgeFindclassReport {
	source: KnowledgeSourceLine;
	keyword: string;
	/** True when the keyword contains a dot, so the whole FQCN was matched. */
	qualified: boolean;
	hits: FoundClass[];
	/**
	 * 命中的 jar 各自的完整路径，每个 jar 只列一次。只给文件名的话，要 javap 或解开看就只能满盘去找：
	 * 真机 54 份会话里 5 次 `find /` 扫全盘，4 次在找苍穹的 jar，其中两次找的正是 findclass、公式目录刚报过名字的那个，
	 * 最长一次挂了 28 分钟（S37）。
	 */
	jarPaths: Record<string, string>;
	/** Jars scanned and classes matched -- `total` can exceed `hits.length`. */
	scanned: { jars: number; total: number; truncated: boolean };
	/** Why there are no hits. Non-null means the scan did not run at all. */
	reflectionUnavailable: string | null;
	/**
	 * L1 insertion point 3, the other half (S7.4 / S5.2).
	 *
	 * The frozen `knowledgeHintForQuery` hung off both `sig` and `findclass` and
	 * fed the query text plus the whole result to one recogniser. `sig`'s half
	 * migrated with `api`; this is `findclass`'s, and it calls the same
	 * `pluginHints` -- a second implementation here could disagree with the gate
	 * about what family a class belongs to, and nothing would report the
	 * disagreement.
	 *
	 * Recognition is the `loose` tier by necessity: the input is a set of class
	 * names, not sources. The hint says so.
	 */
	pluginHints: PluginHint[];
	notes: string[];
}

const FIND_HIT = /^(\S+)\s+<-\s+(.+)$/;
const FIND_SUMMARY = /^---\s*扫了\s*(\d+)\s*个 jar，命中\s*(\d+)\s*个类/;

/** Parses `ApiTool find` stdout. Unparseable lines are ignored, the summary is not. */
export function parseFindOutput(out: string): {
	hits: FoundClass[];
	jarPaths: Record<string, string>;
	jars: number;
	total: number;
} {
	const hits: FoundClass[] = [];
	const jarPaths: Record<string, string> = {};
	let jars = 0;
	let total = 0;
	for (const line of out.split(/\r?\n/)) {
		const summary = FIND_SUMMARY.exec(line.trim());
		if (summary) {
			jars = Number(summary[1]);
			total = Number(summary[2]);
			continue;
		}
		const hit = FIND_HIT.exec(line.trim());
		if (!hit) continue;
		const located = (hit[2] as string).trim();
		const jar = located.split(/[\\/]/).pop() ?? located;
		hits.push({ fqcn: hit[1] as string, jar });
		if (jar !== located) jarPaths[jar] = located;
	}
	// The summary is the authority on how many matched; hits is what was listed.
	return { hits, jarPaths, jars, total: Math.max(total, hits.length) };
}

/**
 * `knowledge findclass <关键字>` -- the reverse lookup, migrated (S5.2).
 *
 * Comes before `api`, not after it: the reason to run this is that the class
 * name is not known well enough to look up, and half the value is in what the
 * jar column says -- two classes with the same simple name in different jars is
 * the normal case in Cosmic, and picking the wrong one is a compile error that
 * names the right class.
 */
export async function knowledgeFindclass(
	base: KnowledgeBase,
	status: KnowledgeSourceStatus,
	keyword: string,
	reflect: ReflectionPort,
): Promise<KernelResult<KnowledgeFindclassReport>> {
	const wanted = keyword.trim();
	if (wanted === "") {
		return err(
			invalidArgument(
				"findclass 需要一个类名关键字",
				"例如 cosmic_knowledge action=findclass query=DynamicObject；带点的关键字按全限定名匹配。",
			),
		);
	}
	const out = await reflect.find(wanted);
	if (out === null) {
		return ok({
			source: sourceLine(status),
			keyword: wanted,
			qualified: wanted.includes("."),
			hits: [],
			jarPaths: {},
			scanned: { jars: 0, total: 0, truncated: false },
			reflectionUnavailable: reflectionDown(reflect, "扫描"),
			pluginHints: [],
			notes:
				reflect.unavailable === undefined
					? [
							"先跑一次 cosmic_doctor action=rebuild（或任意会触发构建的命令）拿到 pathing jar 和 argfile，再 findclass。",
						]
					: [],
		});
	}
	const parsed = parseFindOutput(out);
	// Recognition runs over the query and every hit: the keyword alone is often a
	// simple name that matches nothing in the route table, while the qualified hit
	// it resolved to does.
	const families: PluginFamily[] = [];
	for (const text of [wanted, ...parsed.hits.map((hit) => hit.fqcn)]) {
		const recognised = pluginBaseOf(text);
		if (recognised && !families.some((family) => family.route.base === recognised.route.base)) {
			families.push({ ...recognised, file: text });
		}
	}
	const notes: string[] = [];
	if (parsed.hits.length === 0) {
		notes.push("一个都没命中：关键字可能拼错了，或者那个类不在本工程的依赖里（换个更短的关键字再试）。");
	}
	const truncated = parsed.total > parsed.hits.length;
	if (truncated) notes.push(`命中 ${parsed.total} 个，只列了前 ${parsed.hits.length} 个；关键字再给准点。`);
	return ok({
		source: sourceLine(status),
		keyword: wanted,
		qualified: wanted.includes("."),
		hits: parsed.hits,
		jarPaths: parsed.jarPaths,
		scanned: { jars: parsed.jars, total: parsed.total, truncated },
		reflectionUnavailable: null,
		pluginHints: pluginHints(base, families),
		notes,
	});
}

// ------------------------------------------------------------------ anchors

export interface KnowledgeAnchorsReport {
	source: KnowledgeSourceLine;
	/** null when reflection could not run; the sweep did not happen, it did not pass. */
	report: AnchorReport | null;
	reflectionUnavailable: string | null;
	/** How many queries went into the one JVM run. */
	queries: number;
	/** Of the documented methods, the share this JAR actually declares or inherits. */
	liveShare: number;
}

/**
 * D8's sweep: check the whole embedded snapshot against the user's current JAR.
 *
 * Runs when the RuntimeKey changed, which is when the answer can have changed. The
 * cost is one JVM: `ApiTool suggest` answers a whole query file at once, so the
 * 1,520 classes cost one process rather than 1,520 of them.
 *
 * A null report is NOT a pass. "The sweep could not run" and "the sweep found
 * nothing wrong" are different facts, and collapsing them would turn a tooling
 * failure into a clean bill of health -- the precise shape of defect D-3.
 */
export async function knowledgeAnchors(
	base: KnowledgeBase,
	status: KnowledgeSourceStatus,
	reflect: ReflectionPort,
): Promise<KnowledgeAnchorsReport> {
	const docs: ApiDoc[] = [];
	for (const item of apiItems(base)) {
		const parsed = parseApiDoc(item.relativePath, base.read(item.relativePath) ?? "").doc;
		if (parsed !== null) docs.push(parsed);
	}
	const queries = buildAnchorQueries(docs);
	const out = await reflect.batch(renderAnchorQueries(queries));
	if (out === null) {
		return {
			source: sourceLine(status),
			report: null,
			reflectionUnavailable: reflectionDown(reflect, "反射"),
			queries: queries.length,
			liveShare: 0,
		};
	}
	const report = anchorSweep(docs, parseSuggest(out));
	const accounted = report.joined + report.inherited;
	return {
		source: sourceLine(status),
		report,
		reflectionUnavailable: null,
		queries: queries.length,
		liveShare: report.methods === 0 ? 1 : accounted / report.methods,
	};
}

// -------------------------------------------------------------------- audit

export interface KnowledgeAuditReport {
	source: KnowledgeSourceLine;
	fileCount: number;
	/** True when the tree changed while the audit was reading it. */
	sourceChanged: boolean;
	scenes: { indexed: number; duplicate: number; missing: string[]; unindexed: string[] };
	api: { indexed: number; missing: string[] };
	/** Relative Markdown links that resolve to nothing, or out of the root. */
	brokenLinks: { from: string; target: string }[];
	frameworkVersions: [string, number][];
	missingRequired: string[];
	/** True when nothing in the "errors" class was found. Warnings do not clear it. */
	ok: boolean;
}

function digestOf(base: KnowledgeBase): string {
	return sha256(
		base
			.docs()
			.map((doc) => `${doc.relativePath} ${doc.bytes} ${sha256(base.read(doc.relativePath) ?? "")}`)
			.join("\n"),
	);
}

function brokenLinksIn(base: KnowledgeBase, relativePath: string): { from: string; target: string }[] {
	const text = base.read(relativePath);
	if (text === null) return [];
	const out: { from: string; target: string }[] = [];
	const dir = dirname(base.pathOf(relativePath));
	for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
		let target = (match[1] ?? "").trim().replace(/^<|>$/g, "").split("#")[0] ?? "";
		if (target === "" || /^(?:[a-z]+:|#)/i.test(target)) continue;
		target = target.replace(/%20/g, " ");
		const resolved = resolve(dir, target);
		const rel = relative(base.root, resolved);
		const outside = rel.startsWith("..") || isAbsolute(rel);
		if (outside || !base.exists(toPosix(rel))) out.push({ from: relativePath, target });
	}
	return out;
}

/**
 * Read-only consistency audit of the knowledge tree.
 *
 * The before/after digest is not paranoia carried over from the frozen version:
 * an override root is a live directory the user may be syncing, and an audit
 * that read half of one version and half of another would report invented
 * inconsistencies. It is an error, not a warning, for that reason.
 */
export function knowledgeAudit(base: KnowledgeBase, status: KnowledgeSourceStatus): KnowledgeAuditReport {
	const before = digestOf(base);
	const sceneRows = parseSceneIndex(base);
	const sceneMissing = sceneRows.filter((item) => !base.exists(item.relativePath)).map((item) => item.relativePath);
	const duplicate = sceneRows.length - new Set(sceneRows.map((item) => item.relativePath.toLowerCase())).size;
	const indexedScenes = new Set(sceneRows.map((item) => item.relativePath.toLowerCase()));
	const unindexed = sceneDocPaths(base).filter((rel) => !indexedScenes.has(rel.toLowerCase()));

	const apiIndex = base.read("platform/api/api-index.md") ?? "";
	const apiTargets = [...apiIndex.matchAll(/^->\s+`?([^`\s]+\.md)`?\s*$/gm)].map(
		(match) => `platform/${match[1] ?? ""}`,
	);
	const apiMissing = apiTargets.filter((rel) => !base.exists(rel));

	const brokenLinks = base.docs().flatMap((doc) => brokenLinksIn(base, doc.relativePath));
	const missingRequired = KNOWLEDGE_REQUIRED_ENTRIES.filter((entry) => !base.exists(entry));
	const sourceChanged = before !== digestOf(base);

	return {
		source: sourceLine(status),
		fileCount: base.docs().length,
		sourceChanged,
		scenes: { indexed: sceneRows.length, duplicate, missing: sceneMissing, unindexed },
		api: { indexed: apiTargets.length, missing: apiMissing },
		brokenLinks,
		frameworkVersions: countBy(base.docs().map((doc) => metaOf(base, doc.relativePath, "framework_version"))),
		missingRequired,
		ok: missingRequired.length === 0 && sceneMissing.length === 0 && apiMissing.length === 0 && !sourceChanged,
	};
}

/// -------------------------------------------------------------------- plugin

/**
 * The six-step root flow that must be walked before plugin code can be compiled
 * (S7.4), and the only thing that writes a stamp.
 *
 *   判插件类型 → 读官方指南 → 读场景表 → 选 1~2 篇正文 → 核签名 → 看本地运行态差量 → 写码
 *
 * Two calls, deliberately. The first puts the whole guide and the family's whole
 * scene table in front of the caller; the second must come back naming the 1-2
 * documents it chose. **Step 4 is the only step a machine can verify**: an
 * invented document name is not in the family's table, is refused on the spot,
 * and does NOT get stamped. That is the difference between a flow and a
 * formality -- every other step is only "we put the text in front of you".
 *
 * The cap of 2 is not "a few". The family's whole table of ~90 documents costs
 * the same as reading none of them: neither is "I am following this one", and
 * being unable to choose usually means it is not yet clear which thing is being
 * built.
 *
 * Departures from the frozen `pluginFlow`, registered in docs/S7-l1-l3-gate.md:
 *   - Step 6 NAMES the local runtime-delta skill instead of printing it. Those
 *     documents have been pi-native skills since S7.1 and pi loads them by
 *     description; printing one here would put it in the transcript twice.
 *   - `--scenes -` became `scenes: []`. An explicit empty list says the same
 *     thing without a sentinel string that has to be documented.
 *   - A pluginType covering more than one platform base is refused rather than
 *     resolved to the first row. The stamp is per base, so resolving silently
 *     would stamp one family and leave the caller believing both were cleared.
 */

export interface PluginFlowContext {
	/** Reads project sources, for a `.java` target and the base-class climb. */
	source: JavaSourcePort;
	/**
	 * 本地参考文档的篇名 → 模型能直接 read 的绝对路径；参考包没释放成功时返回 null。
	 *
	 * 交给 pi 的只有族索引，成员篇名不是能读的技能名：回答里写「读 skill cosmic-plugin-ui」，
	 * 模型照着读会找不到（S45 批 1.3）。所以这里给路径，内核自己不知道参考包释放在哪。
	 */
	referenceDoc?: (name: string) => string | null;
}

/** 本地参考文档在哪：能解析成路径就给路径，否则说它在哪个族索引里（族索引是注册给模型的技能）。 */
function localDocOf(name: string, resolve: PluginFlowContext["referenceDoc"]): string {
	const file = resolve?.(name) ?? null;
	if (file !== null) return file;
	const family = REFERENCE_FAMILIES.find((entry) => entry.members.includes(name));
	return family === undefined ? name : `技能 ${family.name} 里的 ${name}`;
}

export interface PluginFlowFamily {
	base: string;
	pluginType: string | null;
	tier: PluginTier;
	via: string[];
	guide: string;
	bind: string | null;
	attach: PluginAttach | null;
	verify: string;
	/** 这一族本地运行态差量那篇：能 read 的绝对路径；参考包不可用时是族索引加篇名。 */
	localDoc: string;
	/** Section name in the browser audit, or null for "never audited". */
	browser: string | null;
}

export interface PluginDocument {
	relativePath: string;
	file: string;
	content: string;
	bytes: number;
}

export interface KnowledgePluginReport {
	source: KnowledgeSourceLine;
	target: string;
	family: PluginFlowFamily;
	/** 1 = the guide and the table were laid out; 2 = the chosen bodies were printed and the stamp written. */
	phase: 1 | 2;
	steps: string[];
	/** Phase 1 only: the official guide, in full. */
	guide: PluginDocument | null;
	/** Phase 1 only: the family's whole scene table. */
	scenes: KnowledgeScenesReport | null;
	/** Phase 2 only: the 1-2 chosen scene bodies. */
	chosen: PluginDocument[];
	/** Always null since S15.2: laying the flow out no longer writes a stamp. Kept for result-shape compatibility. */
	stamped: null;
	/**
	 * Phase 2 only: the classes step 5 should check, taken from the text just read.
	 *
	 * Step 5 used to say "core the signatures" and name no class, which leaves the
	 * caller to decide what to check from its own import list -- and an import
	 * list is a list of everything, so it got checked exhaustively, one call per
	 * entry. These come from the guide and the chosen scene bodies instead: the
	 * APIs the official material actually uses for this job, which is a much
	 * better prior than "everything this file happens to import".
	 *
	 * Derived, never maintained. A hand-kept per-family API list would be one more
	 * table to drift out of date, and this one is regenerated from the documents
	 * on every call.
	 */
	apiCandidates: string[];
	nextActions: string[];
	notes: string[];
}

/**
 * Fully qualified `kd.*` class names mentioned in prose.
 *
 * Package segments start lower-case and the class does not, which is what keeps
 * a sentence like `kd.bos.orm.query.QFilter 的构造` apart from a bare package
 * path. Order of first appearance is kept: the guide is read before the scene
 * bodies, and what it mentions first is usually the entry point.
 */
const FQCN_IN_PROSE = /\bkd(?:\.[a-z][A-Za-z0-9_]*)+\.[A-Z][A-Za-z0-9_$]*\b/g;

/** Cap on the candidate list. Long enough to cover a job, short enough that it is a shortlist and not an import dump. */
const MAX_API_CANDIDATES = 10;

function fqcnsIn(texts: readonly string[]): string[] {
	const seen = new Set<string>();
	for (const text of texts) {
		for (const hit of text.match(FQCN_IN_PROSE) ?? []) {
			seen.add(hit);
			if (seen.size >= MAX_API_CANDIDATES) return [...seen];
		}
	}
	return [...seen];
}

type ResolvedTarget = PluginFamily | { ambiguous: string[] } | null;

/** `.java` path, platform base simple name, or pluginType tag -- all three, as the frozen resolver did. */
function resolvePluginTarget(raw: string, source: JavaSourcePort): ResolvedTarget {
	const target = raw.trim();
	if (target === "") return null;
	if (/\.java$/i.test(target)) {
		const text = source.read(target);
		if (text === "") return null;
		const hit = pluginBaseOf(text, { file: target, source });
		return hit === null ? null : { ...hit, file: target };
	}
	const byBase = PLUGIN_ROUTES.find((route) => route.base.toLowerCase() === target.toLowerCase());
	if (byBase) return { route: byBase, tier: "direct", via: [], file: target };
	const byType = PLUGIN_ROUTES.filter(
		(route) => route.pluginType !== null && route.pluginType.toLowerCase() === target.toLowerCase(),
	);
	const first = byType[0];
	if (first === undefined) return null;
	// A type can cover several bases whose event sets differ. The stamp is per
	// base, so picking one here would clear that one and leave the caller
	// believing the type was cleared.
	if (byType.length > 1) return { ambiguous: byType.map((route) => route.base) };
	return { route: first, tier: "direct", via: [], file: target };
}

const SIX_STEPS = [
	"1/6 判插件类型",
	"2/6 读官方指南（全文在 guide）",
	"3/6 读场景表（整表在 scenes，语义挑选，别用 search 碰运气）",
	"4/6 选 1~2 篇正文，带着篇名再调一次",
	"5/6 核签名",
	"6/6 看本地运行态差量，然后写码",
];

/**
 * Document names are typed by hand: backslashes, leading slashes, the scene
 * prefix and a dropped `.md` all normalise.
 *
 * The suffix is part of this on purpose. The table prints its first column as
 * `print/07-dynamic-column.md` and the caller is told to copy it, but a name
 * copied out of running prose arrives without the extension often enough that
 * refusing it is a trap rather than a check: an input that differs from the
 * table only by the suffix identifies exactly one row, so it is not ambiguous,
 * only untidy. Refusing it cost four round trips in a real session -- the
 * caller stripped the folder, then re-added it, then guessed the suffix.
 *
 * What is NOT normalised is the folder: two families can both hold an
 * `07-dynamic-column.md`, so a bare leaf stays a miss and is answered with a
 * suggestion instead (see suggestSceneName).
 */
function normalizeSceneName(value: string): string {
	const flat = toPosix(value).replace(/^\/+/, "").replace(/^\.\//, "");
	const withoutPrefix = flat.startsWith(SCENE_PREFIX) ? flat.slice(SCENE_PREFIX.length) : flat;
	return withoutPrefix.toLowerCase().endsWith(".md") ? withoutPrefix : `${withoutPrefix}.md`;
}

/**
 * Where in the six-step flow this refusal happened, and what was pickable.
 *
 * Step 4 is the one place the flow can be refused, and it is also the furthest
 * point from where the table was handed over: phase 1 prints the whole table
 * once, and by the time the caller comes back with a choice, many turns of other
 * work can sit in between. A refusal that says only "not in the table" is then
 * asking the caller to remember a document it can no longer see, which is how a
 * real session ended up re-deriving the table from memory across four attempts
 * instead of reading it.
 *
 * So the refusal re-pins what phase 1 established: the steps, which step this
 * is, and the family's actual document names. This is L2 information restated at
 * the point of failure -- the table itself does not move, only the reminder of
 * what is in it.
 */
function flowAnchor(rows: readonly { relativePath: string }[]): KernelErrorDetail {
	return {
		steps: SIX_STEPS,
		at: SIX_STEPS[3] ?? "4/6 选 1~2 篇正文，带着篇名再调一次",
		...(rows.length > 0 ? { available: rows.map((row) => row.relativePath) } : {}),
	};
}

/**
 * The row a near-miss was probably reaching for, as `didYouMean` evidence.
 *
 * Only ever used to build a better refusal -- never to silently accept a name
 * the caller did not type. A leaf that matches exactly one row is worth naming;
 * one that matches several is not, because picking for the caller there would
 * be a guess.
 */
function suggestSceneName(input: string, rows: readonly { relativePath: string }[]): string | null {
	const leaf = basename(normalizeSceneName(input)).toLowerCase();
	const hits = rows.filter((row) => basename(row.relativePath).toLowerCase() === leaf);
	return hits.length === 1 ? (hits[0]?.relativePath ?? null) : null;
}

function documentOf(base: KnowledgeBase, relativePath: string, port: KnowledgeDocsPort): PluginDocument | null {
	const file = base.pathOf(relativePath);
	const content = port.read(file);
	if (content === null) return null;
	return { relativePath, file, content, bytes: Buffer.byteLength(content, "utf8") };
}

export function knowledgePlugin(
	base: KnowledgeBase,
	status: KnowledgeSourceStatus,
	target: string,
	scenes: readonly string[] | undefined,
	port: KnowledgeDocsPort,
	flow: PluginFlowContext,
): KernelResult<KnowledgePluginReport> {
	const resolved = resolvePluginTarget(target, flow.source);
	if (resolved === null) {
		return err(
			invalidArgument(
				`认不出「${target}」是哪一族`,
				"给 .java 的绝对路径、平台基类简单名或场景标签；全部族看 cosmic_knowledge action=routes。",
			),
		);
	}
	if ("ambiguous" in resolved) {
		return err(
			invalidArgument(
				`场景标签「${target}」下有多个平台基类：${resolved.ambiguous.join("、")}`,
				"戳按平台基类记（同一个标签下两个基类的事件集不一样），所以要点名基类或直接给 .java 路径，一族走一遍。",
			),
		);
	}

	const route = resolved.route;
	const family: PluginFlowFamily = {
		base: route.base,
		pluginType: route.pluginType,
		tier: resolved.tier,
		via: [...resolved.via],
		guide: route.guide,
		bind: route.bind,
		attach: route.attach,
		verify: describeVerify(route.verify),
		localDoc: localDocOf(referenceSkillName(route.local), flow.referenceDoc),
		browser: route.browser,
	};
	const notes: string[] = [];
	if (resolved.tier === "climbed") {
		notes.push(`经工程基类 ${resolved.via.join(" → ")} 才认出 ${route.base}——这个类本身不直接继承平台基类。`);
	}
	if (resolved.tier === "loose") {
		notes.push(
			`${route.base} 是按文本里出现的标识符判定的，不是声明的父类。不对就换成 .java 路径重来，别照错的族读。`,
		);
	}
	const table = route.pluginType === null ? null : knowledgeScenes(base, status, { pluginType: route.pluginType });

	// ---- phase 1: lay out the guide and the whole table.
	if (scenes === undefined) {
		const guide = documentOf(base, route.guide, port);
		if (guide === null) {
			return err(
				invalidArgument(
					`路由表指向的官方指南读不出来：${route.guide}`,
					"跑 cosmic_knowledge action=audit 看知识库一致性；这是知识源的问题，不是这一族的问题。",
				),
			);
		}
		const nextActions =
			route.pluginType === null
				? [
						`这一族官方场景索引没打过标签，没有可挑的场景。读完指南直接放行：cosmic_knowledge action=plugin query=${target} scenes=[]`,
						"编一个标签填上去会让 pluginType 过滤退回未标签基线，看起来筛过其实一条没筛。",
					]
				: [
						`从 scenes 里挑 1~2 篇带回来：cosmic_knowledge action=plugin query=${target} scenes=["<路径>"]`,
						// "不用带前缀" on its own reads as an instruction to shorten the
						// name, and a caller acting on it stripped the folder instead of
						// keeping the suffix. Show the shape instead of describing it.
						"路径抄表第一列，原样即可：形如 print/07-dynamic-column.md（含 .md，不含 platform/scenes/）。挑不出来通常是还没想清楚要做哪件事，不是表不够长。",
					];
		return ok({
			source: sourceLine(status),
			target,
			family,
			phase: 1,
			steps: SIX_STEPS,
			guide,
			scenes: table,
			chosen: [],
			stamped: null,
			// Nothing to shortlist yet: the candidates come from the bodies chosen in
			// phase 2, and offering them off the guide alone would name APIs for jobs
			// this caller may not be doing.
			apiCandidates: [],
			nextActions,
			notes,
		});
	}

	// ---- phase 2: verify the choice and print it. S15.2 no longer writes a brief stamp.
	const picked = scenes.map((name) => name.trim()).filter((name) => name !== "");
	if (route.pluginType === null) {
		if (picked.length > 0) {
			return err(
				invalidArgument(
					`${route.base} 这一族官方没打场景标签，给不了场景`,
					`放行写空列表：cosmic_knowledge action=plugin query=${target} scenes=[]`,
				),
			);
		}
	} else if (picked.length === 0 || picked.length > 2) {
		return err(
			invalidArgument(
				`scenes 要 1~2 篇，收到 ${String(picked.length)} 篇`,
				"全塞进来跟一篇不读效果一样：都不是「照着这一篇做」。先不带 scenes 调一次读整表再挑。",
				flowAnchor(table?.rows ?? []),
			),
		);
	}

	const rows = table?.rows ?? [];
	const known = new Map(rows.map((row) => [row.relativePath, row]));
	const missing = picked.filter((name) => !known.has(normalizeSceneName(name)));
	if (missing.length > 0) {
		// The one machine-verifiable step. An invented name is refused here and
		// NOTHING is stamped: a stamp for a document nobody read is worse than no
		// gate at all, because from then on it looks like the flow happened.
		//
		// The refusal states the difference before it draws any conclusion from
		// it. Calling a near-miss "编造" (invented) sent a real session hunting
		// through its own memory of the table for a name it had actually copied
		// correctly, when the only problem was a missing suffix; a wrong
		// diagnosis in a remedy is worse than a bare "no", because it is acted
		// on. The accusation is now reserved for names that resemble no row.
		const didYouMean = missing
			.map((name) => suggestSceneName(name, rows))
			.filter((name): name is string => name !== null);
		const remedy =
			didYouMean.length > 0
				? `照这个再调一次：scenes=[${didYouMean.map((name) => `"${name}"`).join(", ")}]（篇名连 .md 一起抄，目录别去掉）。`
				: `先看这一族有哪些篇：cosmic_knowledge action=scenes pluginType=${route.pluginType ?? ""}，然后照表第一列原样抄一篇回来。`;
		return err(
			invalidArgument(`这几篇不在 ${route.pluginType ?? "该"} 族的场景表里：${missing.join("、")}`, remedy, {
				missing,
				...(didYouMean.length > 0 ? { didYouMean } : {}),
				...flowAnchor(rows),
			}),
		);
	}

	const chosen: PluginDocument[] = [];
	for (const name of picked) {
		const row = known.get(normalizeSceneName(name));
		if (row === undefined) continue;
		// Read back through the table's own path, never the caller's string.
		const doc = documentOf(base, `${SCENE_PREFIX}${row.relativePath}`, port);
		if (doc === null) {
			return err(
				invalidArgument(
					`场景表里有 ${row.relativePath}，但正文读不出来`,
					"跑 cosmic_knowledge action=audit；这是知识源的问题，不记戳。",
				),
			);
		}
		chosen.push(doc);
	}

	// The shortlist for step 5, from the text that was just put in front of the
	// caller: the guide plus the chosen bodies. Reading the guide again here is one
	// file read, and it is the half that names the entry points -- the scene bodies
	// tend to name the specific calls.
	const guideBody = documentOf(base, route.guide, port);
	const apiCandidates = fqcnsIn([guideBody?.content ?? "", ...chosen.map((doc) => doc.content)]);

	return ok({
		source: sourceLine(status),
		target,
		family,
		phase: 2,
		steps: SIX_STEPS,
		guide: null,
		scenes: null,
		chosen,
		stamped: null,
		apiCandidates,
		nextActions: [
			apiCandidates.length === 0
				? `5/6 核签名：cosmic_knowledge action=api query=<全限定名>，多个类空格隔开一次查完；本族基类 ${route.base}`
				: `5/6 核签名，一次查完：cosmic_knowledge action=api query="${apiCandidates.join(" ")}"` +
					`（刚读的指南和场景正文里出现的类；写码还会用到别的就一起加进去，别一个一个查）`,
			`6/6 本地运行态差量：read ${family.localDoc}——官方讲通用写法，本地只剩运行态差量和验证判据`,
			family.browser === null
				? "浏览器边界：这一族没做过事件级审计——**不等于不用浏览器**，等于没人核过；外观、渲染、下载一律浏览器验收"
				: `浏览器边界：分档（A/B/C/D/X）看审计的「${family.browser}」一节`,
			family.verify === ""
				? `行为验证：这一族没有无头适配器，${describeBinding(family.bind, family.attach)}，要起节点`
				: `行为验证：${family.verify}（${describeBinding(family.bind, family.attach)}）`,
			`${route.base} 的完整材料已展开；cosmic_fast 按目标 Capsule 判定，不要求这次查询写戳。`,
		],
		notes,
	});
}

// ------------------------------------------------------------------ dispatch

export type KnowledgeAction =
	| "status"
	| "routes"
	| "scenes"
	| "search"
	| "show"
	| "audit"
	| "api"
	| "findclass"
	| "anchors"
	| "plugin"
	| "probes";

export interface KnowledgeProbesReport {
	/** One line per probe: `Name(required inputs)：first sentence of its own header`. */
	probes: string[];
	/** Only for the probes named in the query: every `NAME=…` line of the header, optional ones included. */
	usage: Record<string, string[]>;
	/** 按要做的事找出来的探针：入参注释里和查询对得上的那几行。只在按用途查时有。 */
	matched?: Record<string, string[]>;
	/** 查询里原样找不到的词：不是探针类名，说明和入参注释里也没有（拆开的部分可能对上了）。 */
	unknown: string[];
	note: string;
}

/**
 * The released probes by what they do, not by name (复盘 §8.4-2).
 *
 * Not official knowledge, and deliberately in this tool anyway: it is the
 * read-only lookup tool the model already reaches for when it does not know
 * something, it works without a project, and it costs the prompt nothing until
 * it is asked -- the list of names in the prompt is all L0 can afford.
 */
export function knowledgeProbes(catalog: readonly ProbeCatalogEntry[], query: string): KnowledgeProbesReport {
	const asked = query
		.split(/[\s,，]+/)
		.map((name) => name.trim())
		.filter((name) => name !== "");
	const byName = new Map(catalog.map((entry) => [entry.name.toLowerCase(), entry]));
	const line = (entry: ProbeCatalogEntry): string => {
		const name = entry.required.length === 0 ? entry.name : `${entry.name}(${entry.required.join(" ")})`;
		return `${name}：${entry.summary === "" ? "（源码没写说明）" : entry.summary}`;
	};
	if (asked.length === 0) {
		return {
			probes: catalog.map(line),
			usage: {},
			unknown: [],
			note: "名字不等于能力，照说明挑。query 里写要做的事，只回对得上的几个；写类名，附上它的全部入参（含可选）。都做不到的只读查询，写临时探针。",
		};
	}
	const named = asked.flatMap((name) => byName.get(name.toLowerCase()) ?? []);
	const words = asked.filter((name) => !byName.has(name.toLowerCase()));
	const usage: Record<string, string[]> = {};
	for (const entry of named) usage[entry.name] = entry.usage;
	if (words.length === 0) {
		return {
			probes: named.map(line),
			usage,
			unknown: [],
			note: "usage 是探针源码开头自己写的参数注释，必填和可选都在里面。",
		};
	}
	// 不是类名的词当成「要做的事」，拿去对每个探针的说明和入参注释。
	const found = probesByPurpose(catalog, words.join(" "));
	const matched: Record<string, string[]> = {};
	const byPurpose = found.hits.filter((hit) => !named.includes(hit.entry));
	for (const hit of byPurpose) if (hit.lines.length > 0) matched[hit.entry.name] = hit.lines;
	return {
		probes: [...named, ...byPurpose.map((hit) => hit.entry)].map(line),
		usage,
		...(Object.keys(matched).length === 0 ? {} : { matched }),
		unknown: found.absent,
		note:
			byPurpose.length === 0
				? "没有探针的说明或入参对得上这些词。换个说法再查，或不给 query 列出全部探针的说明。"
				: "按要做的事对探针的说明和入参注释找出来的，最对得上的在前；matched 是入参注释里对得上的行。要某个探针的全部入参，把类名放进 query 再查。",
	};
}

/** 按用途查最多回几个：再多就不如直接看全表。 */
const PURPOSE_LIMIT = 5;
/** 分数不到头一名这个比例的不回：只沾上一个常见词（"单据""字段"）的探针不该跟着出来。 */
const PURPOSE_FLOOR = 0.35;

const purposeIndexes = new WeakMap<readonly ProbeCatalogEntry[], PassageIndex>();

/**
 * 一句「要做的事」对上哪几个探针。
 *
 * 系统提示里探针只有类名，而名字不等于能力：改单据的写探针名字里是「布局」，实际还管字段、操作、挂插件。
 * 真机上模型按名字认定没有探针能挂操作插件，把这一步交给了用户。说明和入参注释里其实都写着，只是只能按类名取。
 *
 * 分词和打分用知识检索那一套（`passages.ts`），不另写：每个探针当一篇，正文是说明加入参注释，
 * 说明另按整篇再记一次分——一句话说明对上的，比入参注释里顺带提到的更该排前。
 */
function probesByPurpose(
	catalog: readonly ProbeCatalogEntry[],
	query: string,
): { hits: { entry: ProbeCatalogEntry; lines: string[] }[]; absent: string[] } {
	let index = purposeIndexes.get(catalog);
	if (index === undefined) {
		index = buildPassageIndex(
			catalog.map((entry) => ({
				origin: "local" as const,
				ref: entry.name,
				file: "",
				text: [entry.name, entry.summary, ...entry.usage].join("\n"),
				about: `${entry.name} ${entry.summary}`,
			})),
		);
		purposeIndexes.set(catalog, index);
	}
	const result = searchPassages(index, query, { limit: PURPOSE_LIMIT });
	const best = result.hits[0]?.score ?? 0;
	const byRef = new Map(catalog.map((entry) => [entry.name, entry]));
	const wanted = queryWords(query);
	return {
		hits: result.hits
			.filter((hit) => hit.score >= best * PURPOSE_FLOOR)
			.flatMap((hit) => {
				const entry = byRef.get(hit.source.ref);
				return entry === undefined ? [] : [{ entry, lines: purposeLines(entry, wanted) }];
			}),
		absent: result.absent,
	};
}

/** 入参注释里和查询对得上的行：对上的词最多的排前，最多三行。只沾一个两字词的行太多，不算。 */
function purposeLines(entry: ProbeCatalogEntry, words: readonly string[]): string[] {
	const terms = new Set(words.flatMap((word) => tokenize(word)));
	if (terms.size === 0) return [];
	const need = Math.min(2, terms.size);
	return entry.usage
		.map((text, at) => ({ text, at, score: new Set(tokenize(text).filter((term) => terms.has(term))).size }))
		.filter((item) => item.score >= need)
		.sort((a, b) => b.score - a.score || a.at - b.at)
		.slice(0, 3)
		.sort((a, b) => a.at - b.at)
		.map((item) => item.text);
}

/**
 * One line per action, and the ONLY place an action is described.
 *
 * The tool description and the parameter enum both used to spell the list out by
 * hand, and both had drifted: `findclass` shipped in `KNOWLEDGE_ACTIONS` but was
 * missing from both sentences, so the one action whose whole job is "I do not
 * know the class name" was invisible to the model that needed it -- while
 * cosmic-lint's own description told it the capability existed.
 *
 * Typed as a total `Record`, so adding a member to `KnowledgeAction` is a
 * compile error until it has a description. That is the same rule the S4 probe
 * policy prompt follows: the prompt is generated from the enforcing table, never
 * kept beside it.
 */
export const KNOWLEDGE_ACTION_HINTS: Record<KnowledgeAction, string> = {
	status: "看在用哪份知识库",
	routes: "看插件族路由",
	scenes: "读整张场景表（场景类问题走这条）",
	search: "官方库和本地资料一起全文检索，回命中所在的完整一块（小篇整篇、大篇一节），前几块直接带正文",
	show: "取正文；<路径>#<标题> 只取那一节，本地资料写 reference:<篇名>",
	audit: "查一致性",
	api: "按全限定类名把文档正文与当前 JAR 反射对齐（真实参数名、中文说明、@param/@return），另给本类的常量值、构造和父类；附本地资料里讲到这个类的块（local，<类名>#<名字> 时第一块带正文）；多个类放在一次里查",
	findclass: "只知道类名片段时按关键字反查全限定名和它在哪个 jar（同名类分散在多个 jar 是常态，挑错一个是编译错误）",
	anchors: "一次性扫全库锚点，看哪些 API 在当前 JAR 里已经不存在",
	plugin: "复杂插件语义的按需六步展开",
	probes:
		"列出已发布探针各自能干什么（一行说明 + 必填入参），挑探针前看这个；在 query 参数里写要做的事（action 仍是 probes），只回说明和入参对得上的几个；写探针类名，就附上它的全部入参（含可选）",
};

export const KNOWLEDGE_ACTIONS: readonly KnowledgeAction[] = Object.keys(KNOWLEDGE_ACTION_HINTS) as KnowledgeAction[];

export interface KnowledgeRequest extends SearchOptions {
	action: KnowledgeAction;
	/** search: the query text. show: the relative document path. api: the fqcn. findclass: the keyword. plugin: the target. */
	query?: string;
	/**
	 * plugin only. Absent = phase 1 (lay out the guide and the table); present =
	 * phase 2 (the chosen 1-2 documents). An empty array is the explicit "this
	 * family has no scene tags" pass, not the same thing as absent.
	 */
	scenes?: readonly string[];
}

export type KnowledgeReport =
	| ({ action: "status" } & KnowledgeStatusReport)
	| ({ action: "routes" } & KnowledgeRoutesReport)
	| ({ action: "scenes" } & KnowledgeScenesReport)
	| ({ action: "search" } & KnowledgeSearchReport)
	| ({ action: "show" } & KnowledgeShowReport)
	| ({ action: "audit" } & KnowledgeAuditReport)
	| ({ action: "api" } & KnowledgeApiReport)
	| ({ action: "findclass" } & KnowledgeFindclassReport)
	| ({ action: "anchors" } & KnowledgeAnchorsReport)
	| ({ action: "plugin" } & KnowledgePluginReport)
	| ({ action: "probes" } & KnowledgeProbesReport);

/** One entry point, so the tool layer never has to know which reader an action needs. */
export async function runKnowledge(
	base: KnowledgeBase,
	status: KnowledgeSourceStatus,
	request: KnowledgeRequest,
	port: KnowledgeDocsPort,
	// Defaulting to "unavailable" rather than to a live port keeps every existing
	// caller honest: a join needs a JAR, and a caller that has none says so.
	reflect: ReflectionPort = UNAVAILABLE_REFLECTION,
	// Only `plugin` needs it: it reads project sources to identify the family.
	// Absent means the caller has no open project, and the flow says so rather
	// than guessing from a class name.
	flow?: PluginFlowContext,
	// `probes` lists them; `search` attaches the usage of any probe its query names.
	// The embedded probe sources, not the knowledge base.
	probes: readonly ProbeCatalogEntry[] = [],
	// 本地参考文档：search 和官方库放在一个段落索引里排，show 按 `reference:<篇名>` 读。
	// 不给 = 只有官方库（参考包没释放成功，或调用方本来就只要官方库）。
	local: readonly LocalReferenceDoc[] = [],
): Promise<KernelResult<KnowledgeReport>> {
	switch (request.action) {
		case "probes":
			return ok({ action: "probes", ...knowledgeProbes(probes, request.query ?? "") });
		case "status":
			return ok({ action: "status", ...knowledgeStatus(base, status) });
		case "routes":
			return ok({ action: "routes", ...knowledgeRoutes(base, status) });
		case "scenes": {
			if (request.kind !== undefined || request.limit !== undefined) {
				return err(
					invalidArgument(
						"scenes 输出整表，不接受 kind / limit",
						"去掉 kind 和 limit，用 pluginType/event/control 过滤。",
					),
				);
			}
			return ok({ action: "scenes", ...knowledgeScenes(base, status, request) });
		}
		case "search": {
			const result = knowledgeSearch(base, status, request.query ?? "", request, local, probes);
			return result.ok ? ok({ action: "search", ...result.value }) : err(result.error);
		}
		case "show": {
			const result = knowledgeShow(base, status, request.query ?? "", port, local);
			return result.ok ? ok({ action: "show", ...result.value }) : err(result.error);
		}
		case "audit":
			return ok({ action: "audit", ...knowledgeAudit(base, status) });
		case "api": {
			const result = await knowledgeApi(base, status, request.query ?? "", reflect, local);
			return result.ok ? ok({ action: "api", ...result.value }) : err(result.error);
		}
		case "findclass": {
			const result = await knowledgeFindclass(base, status, request.query ?? "", reflect);
			return result.ok ? ok({ action: "findclass", ...result.value }) : err(result.error);
		}
		case "anchors":
			return ok({ action: "anchors", ...(await knowledgeAnchors(base, status, reflect)) });
		case "plugin": {
			if (flow === undefined) {
				return err(
					invalidArgument(
						"plugin 需要一个已打开的工程：它要读工程源码认插件族",
						"先 cosmic_open_project；其余 action 不需要工程。",
					),
				);
			}
			const result = knowledgePlugin(base, status, request.query ?? "", request.scenes, port, flow);
			return result.ok ? ok({ action: "plugin", ...result.value }) : err(result.error);
		}
	}
}
