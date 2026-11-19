/**
 * 模型主动查平台知识时，能不能取回：同一批典型查询，过和 agent 一样的检索路径，看回来什么。
 *
 * 跑法：node --experimental-strip-types scripts/measure-knowledge-retrieval.ts [--json]
 *       只看几个查询回来什么：加 `--search <词>`（可重复），不跑固定样本、不判对错
 *       真机查询评测集：加 `--cases scripts/checklists/knowledge-recall.json`（口径见 measureRecall）
 *       改道提示发得对不对：`--cases … --steer`（口径见 measureSteer）
 *
 * 口径：
 * - 走 runKnowledge（和 cosmic_knowledge 同一个入口）：search 把官方库和本地参考文档放在一个段落索引里排；
 *   api 给每个类附上本地参考文档里讲到它的块（按类名整词查，同一个段落索引）。
 * - 没有 JAR：api 只看文档侧，「签名是否对过当前 JAR」不在这把尺子里。
 * - 「取回」= 期望的文档出现在返回里（search 看前 limit 条，默认 5）；不代表模型随后选对了。
 * - 查询分四类：全限定类名、简单类名、方法名、业务说法。期望答案是人工标的，写在 CASES 里。
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { trimKnowledgeEnvelope } from "../src/agent/tools/knowledge-envelope.ts";
import { extractProse } from "../src/agent/tools/prose-blocks.ts";
import { EVAL_CASES } from "../src/eval/corpus.ts";
import type { ReflectionPort } from "../src/kernel/api-tool.ts";
import { type KnowledgeRequest, runKnowledge } from "../src/kernel/commands/knowledge.ts";
import { nodeKnowledgeDocs, openKnowledgeBase } from "../src/knowledge/docs.ts";
import { loadKnowledgeSnapshot } from "../src/knowledge/embedded.ts";
import {
	type LocalReferenceDoc,
	parseSkillFrontmatter,
	readReleasedSkills,
	releaseReference,
} from "../src/knowledge/reference.ts";
import { releaseKnowledge } from "../src/knowledge/release.ts";
import { nodeKnowledgeFileSystem, resolveKnowledgeSource } from "../src/knowledge/source.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";
import { releasedProbeCatalog } from "../src/runtime/resources.ts";

type Kind = "fqcn" | "simple" | "method" | "business";

interface Case {
	id: string;
	kind: Kind;
	request: KnowledgeRequest;
	/** 官方库里应该出现的文档（相对路径片段，任一命中即算）。空 = 官方库本来就没有专篇。 */
	official: string[];
	/** 本地参考文档里应该出现的篇名（任一命中即算）。空 = 本地没有专讲。 */
	local: string[];
}

const CASES: Case[] = [
	{
		id: "fqcn-qfilter",
		kind: "fqcn",
		request: { action: "api", query: "kd.bos.orm.query.QFilter" },
		official: ["QFilter"],
		local: ["cosmic-sdk"],
	},
	{
		id: "fqcn-bdsh",
		kind: "fqcn",
		request: { action: "api", query: "kd.bos.servicehelper.BusinessDataServiceHelper" },
		official: ["BusinessDataServiceHelper"],
		local: [],
	},
	{
		id: "fqcn-formplugin",
		kind: "fqcn",
		request: { action: "api", query: "kd.bos.form.plugin.AbstractFormPlugin" },
		official: ["AbstractFormPlugin"],
		local: ["cosmic-plugin-ui"],
	},
	{
		id: "fqcn-member",
		kind: "fqcn",
		request: { action: "api", query: "kd.bos.entity.datamodel.IDataModel#setValue" },
		official: ["IDataModel"],
		local: [],
	},
	{
		id: "simple-qfilter",
		kind: "simple",
		request: { action: "search", query: "QFilter" },
		official: ["QFilter"],
		local: ["cosmic-sdk"],
	},
	{
		id: "simple-dynobj",
		kind: "simple",
		request: { action: "search", query: "DynamicObject" },
		official: ["dynamic-object", "DynamicObject"],
		local: [],
	},
	{
		id: "simple-bdsh",
		kind: "simple",
		request: { action: "search", query: "BusinessDataServiceHelper" },
		official: ["BusinessDataServiceHelper"],
		local: [],
	},
	{
		id: "simple-idatamodel",
		kind: "simple",
		request: { action: "search", query: "IDataModel" },
		official: ["IDataModel"],
		local: [],
	},
	{
		id: "method-setvalue",
		kind: "method",
		request: { action: "search", query: "setValue" },
		official: ["IDataModel"],
		local: [],
	},
	{
		id: "method-beforedoop",
		kind: "method",
		request: { action: "search", query: "beforeDoOperation" },
		official: ["operation", "FormOperate", "BeforeDoOperation"],
		local: ["cosmic-plugin-operation", "cosmic-run"],
	},
	{
		id: "method-insertrow",
		kind: "method",
		request: { action: "search", query: "insertEntryRow" },
		official: ["IDataModel", "AbstractFormDataModel"],
		local: [],
	},
	{
		id: "method-canwithdraw",
		kind: "method",
		request: { action: "search", query: "canWithdraw" },
		official: [],
		local: ["cosmic-workflow"],
	},
	{
		id: "biz-entry-add",
		kind: "business",
		request: { action: "search", query: "分录新增行时给字段赋默认值" },
		official: ["scenes/"],
		local: ["cosmic-plugin-ui"],
	},
	{
		id: "biz-lock-field",
		kind: "business",
		request: { action: "search", query: "字段锁定" },
		official: ["scenes/"],
		local: ["cosmic-metadata-form-rules"],
	},
	{
		id: "biz-readonly",
		kind: "business",
		request: { action: "search", query: "单据做成只读" },
		official: ["scenes/"],
		local: ["cosmic-metadata-form-rules", "cosmic-metadata-form"],
	},
	{
		id: "biz-writeback",
		kind: "business",
		request: { action: "search", query: "下推后反写上游数量" },
		official: ["writeback", "botp"],
		local: ["cosmic-metadata-botp", "cosmic-plugin-operation"],
	},
	{
		id: "biz-print-data",
		kind: "business",
		request: { action: "search", query: "打印模板 取数插件" },
		official: ["print"],
		local: ["cosmic-plugin-print-runtime"],
	},
	{
		id: "biz-f7-filter",
		kind: "business",
		request: { action: "search", query: "F7 过滤" },
		official: ["scenes/"],
		local: ["cosmic-plugin-ui"],
	},
	{
		id: "biz-schedule",
		kind: "business",
		request: { action: "search", query: "后台任务 定时执行" },
		official: ["task", "schedule"],
		local: ["cosmic-plugin-integration"],
	},
	{
		id: "biz-unsubmit",
		kind: "business",
		request: { action: "search", query: "撤销提交" },
		official: [],
		local: ["cosmic-workflow"],
	},
];

/** 没有 JAR；api 回答会自报「没对过」。 */
const offline: ReflectionPort = { sig: async () => null, batch: async () => null, find: async () => null };

const encoder = new TextEncoder();
const bytes = (value: unknown): number => encoder.encode(JSON.stringify(value) ?? "").length;

function argValue(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

interface RecallCase {
	id: string;
	kind: "identifier" | "mixed" | "business" | "tool" | "project";
	query: string;
	seen: string[];
	answers: { doc: string; heading: string }[];
	note?: string;
}

/**
 * 答案所在那一段的行号范围 [start, end)，0 起：从这个标题到下一个同级或更高级标题（连子标题）；
 * 代码块里的 `#` 不算标题。heading 为空串 = 整篇。找不到标题返回 null（标注写错了，要报出来）。
 */
function sectionRange(text: string, heading: string): { start: number; end: number } | null {
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	if (heading === "") return { start: 0, end: lines.length };
	let fenced = false;
	let start = -1;
	let level = 0;
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] as string;
		if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
		if (fenced) continue;
		const match = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
		if (match === null) continue;
		const depth = (match[1] as string).length;
		if (start < 0) {
			if ((match[2] as string).replace(/`/g, "") === heading.replace(/`/g, "")) {
				start = index;
				level = depth;
			}
		} else if (depth <= level) {
			return { start, end: index };
		}
	}
	return start < 0 ? null : { start, end: lines.length };
}

function sectionOf(text: string, heading: string): string | null {
	const range = sectionRange(text, heading);
	return range === null ? null : text.replace(/\r\n?/g, "\n").split("\n").slice(range.start, range.end).join("\n");
}

/** 模型实际收到的字节：裁掉用不上的路径，正文挪进文本块后，信封加各文本块（和 verify:eval 同一口径）。 */
function modelViewBytes(report: object): number {
	const prose = extractProse("cosmic_knowledge", trimKnowledgeEnvelope("cosmic_knowledge", report));
	return (
		encoder.encode(JSON.stringify(prose.result) ?? "").length +
		prose.blocks.reduce((sum, block) => sum + encoder.encode(`# ${block.label}\n\n${block.text}`).length, 0)
	);
}

/** `--dump <编号>`：把这条查询模型实际收到的信封和文本块原样打到 stderr，看字节花在哪。 */
function dumpModelView(report: object): void {
	const prose = extractProse("cosmic_knowledge", trimKnowledgeEnvelope("cosmic_knowledge", report));
	const envelope = JSON.stringify(prose.result) ?? "";
	console.error(`--- 信封 ${encoder.encode(envelope).length} B ---`);
	console.error(JSON.stringify(prose.result, null, 1));
	for (const block of prose.blocks) {
		const bytes = encoder.encode(`# ${block.label}\n\n${block.text}`).length;
		console.error(`--- 文本块「${block.label}」${bytes} B ---`);
		console.error(block.text);
	}
}

interface ReturnedHit {
	doc: string;
	lines: string;
	scope: string;
	inline: boolean;
	outline: boolean;
	show: string;
}

/**
 * 真机查询评测集：答案有没有回来、回来的那一块包没包住答案段、拿到答案要几次调用、读多少字节。
 *
 * - 「回来」= 标注的答案篇出现在 search 结果里（默认前 5 条，两份资料排在一起）。
 * - 「包住」= 回来的那一块（行号范围）整个盖住标注的答案段（连子标题）。标注是整篇的：块是整篇，或者给了整篇目录，算包住。
 * - 「带正文」= 那一块的正文就在这次回复里；没带的要再 show 一次。
 * - 「回复字节」= 模型侧口径：裁掉用不上的路径、正文挪成文本块之后的信封加文本块。
 * - 「再读字节」= 包住但没带正文：再 show 那一块的字节；回来了但没包住：show 答案段的字节；带了正文：0。
 * - 「几次调用」= 拿到答案段要调几次 cosmic_knowledge：带正文且包住 1 次，否则 2 次。
 */
async function measureRecall(
	file: string,
	base: ReturnType<typeof openKnowledgeBase>,
	status: Parameters<typeof runKnowledge>[1],
	localDocs: LocalReferenceDoc[],
	docText: (doc: string) => string | null,
): Promise<void> {
	const parsed = JSON.parse(readFileSync(file, "utf8")) as { cases: RecallCase[]; apiClasses?: string[] };
	const probes = releasedProbeCatalog(EMBEDDED_RESOURCES);
	// 一行一题，字段见下面 rows.push；只给这个脚本自己打表用
	const rows: Record<string, any>[] = [];
	for (const item of parsed.cases) {
		const report = await runKnowledge(
			base,
			status,
			{ action: "search", query: item.query },
			nodeKnowledgeDocs,
			offline,
			undefined,
			probes,
			localDocs,
		);
		if (report.ok && argValue("--dump") === item.id) dumpModelView(report.value);
		const results = report.ok && report.value.action === "search" ? report.value.results : [];
		const returned: ReturnedHit[] = results.map((hit) => ({
			doc: hit.relativePath.startsWith("reference:") ? hit.relativePath : `official:${hit.relativePath}`,
			lines: hit.lines,
			scope: hit.scope,
			inline: typeof hit.text === "string",
			outline: Array.isArray(hit.outline) && hit.outline.length > 0,
			show: hit.show,
		}));
		const problems: string[] = [];
		for (const answer of item.answers) {
			const text = docText(answer.doc);
			if (text === null) problems.push(`标注的篇不存在 ${answer.doc}`);
			else if (sectionRange(text, answer.heading) === null)
				problems.push(`标注的标题不存在 ${answer.doc}#${answer.heading}`);
		}
		// 每个回来的答案：包没包住、带没带正文；挑最省的那个记
		let best: { rank: number; covered: boolean; inline: boolean; readBytes: number; wholeDoc: boolean } | null = null;
		for (const answer of item.answers) {
			const rank = returned.findIndex((hit) => hit.doc === answer.doc);
			if (rank < 0) continue;
			const hit = returned[rank] as ReturnedHit;
			const text = docText(answer.doc) ?? "";
			const range = sectionRange(text, answer.heading);
			const [from, to] = hit.lines.split("-").map(Number) as [number, number];
			const wholeDoc = answer.heading === "";
			const covered =
				range !== null &&
				(wholeDoc ? hit.scope.startsWith("整篇") || hit.outline : from - 1 <= range.start && to >= range.end);
			const sectionBytes = encoder.encode(sectionOf(text, answer.heading) ?? "").length;
			const blockBytes = encoder.encode(
				text
					.replace(/\r\n?/g, "\n")
					.split("\n")
					.slice(from - 1, to)
					.join("\n")
					.trim(),
			).length;
			const readBytes = covered ? (hit.inline || (wholeDoc && hit.outline) ? 0 : blockBytes) : sectionBytes;
			const candidate = { rank: rank + 1, covered, inline: covered && hit.inline, readBytes, wholeDoc };
			const cost = (entry: typeof candidate) => (entry.covered ? 0 : 1e9) + entry.readBytes;
			if (best === null || cost(candidate) < cost(best)) best = candidate;
		}
		rows.push({
			id: item.id,
			kind: item.kind,
			query: item.query,
			expected: item.answers.length,
			found: item.answers.length === 0 ? null : best !== null,
			rank: best?.rank ?? null,
			covered: best?.covered ?? null,
			inline: best?.inline ?? null,
			wholeDoc: best?.wholeDoc ?? null,
			calls: best === null ? null : best.covered && (best.inline || best.readBytes === 0) ? 1 : 2,
			returned,
			replyBytes: report.ok ? modelViewBytes(report.value) : 0,
			readBytes: best?.readBytes ?? null,
			absent: report.ok && report.value.action === "search" ? (report.value.absent ?? []) : [],
			warnings: report.ok && report.value.action === "search" ? report.value.warnings : [],
			steer: report.ok && report.value.action === "search" && report.value.steer !== null,
			probes: report.ok && report.value.action === "search" ? Object.keys(report.value.probes ?? {}) : [],
			problems,
		});
	}

	if (process.argv.includes("--json")) {
		console.log(JSON.stringify(rows, null, 2));
		return;
	}
	for (const row of rows) {
		const mark =
			row.found === null
				? "—（两份资料都没有 / 不该查知识库）"
				: !row.found
					? "没回来"
					: `第 ${row.rank} 条，${row.covered ? "包住答案段" : "没包住"}，${row.inline ? "带正文" : "要再 show"}`;
		console.log(`${row.id} [${row.kind}] ${row.query}`);
		console.log(
			`   ${mark}  回复 ${row.replyBytes} B${row.readBytes === null ? "" : `  再读 ${row.readBytes} B  共 ${row.calls} 次调用`}`,
		);
		for (const hit of row.returned)
			console.log(
				`     ${hit.inline ? "■" : "□"} ${hit.doc} ${hit.lines} ${hit.scope}${hit.outline ? " +目录" : ""}`,
			);
		if (row.absent.length > 0) console.log(`   资料里没有：${row.absent.join(" ")}`);
		if (row.probes.length > 0) console.log(`   附探针入参：${row.probes.join(" ")}`);
		for (const warning of row.warnings) console.log(`   提示：${warning.slice(0, 80)}`);
		if (row.steer) console.log("   附改道提示");
		for (const problem of row.problems) console.log(`   !! ${problem}`);
	}
	console.log("");
	for (const kind of ["identifier", "mixed", "business", "tool", "project", "all"] as const) {
		const group = rows.filter((row) => kind === "all" || row.kind === kind);
		if (group.length === 0) continue;
		const asked = group.filter((row) => row.found !== null);
		const found = asked.filter((row) => row.found === true);
		const covered = found.filter((row) => row.covered === true);
		const oneCall = found.filter((row) => row.calls === 1);
		const sum = (key: "replyBytes" | "readBytes", set: typeof rows) =>
			set.reduce((total, row) => total + (row[key] ?? 0), 0);
		console.log(
			`[${kind}] ${group.length} 条，有答案 ${asked.length} 条，回来 ${found.length}/${asked.length}，` +
				`包住答案段 ${covered.length}/${found.length}，一次调用拿到 ${oneCall.length}/${found.length}；` +
				`回复合计 ${sum("replyBytes", group)} B，回来的再读 ${sum("readBytes", found)} B`,
		);
		console.log(
			`${" ".repeat(kind.length + 3)}回来的回复 ${sum("replyBytes", found)} B，还要再读 ${found.filter((row) => (row.readBytes ?? 0) > 0).length} 条，` +
				`附改道提示 ${group.filter((row) => row.steer).length} 条（回来的 ${found.filter((row) => row.steer).length} 条）`,
		);
	}
	const broken = rows.filter((row) => row.problems.length > 0).length;
	if (broken > 0) console.log(`!! ${broken} 条标注找不到对应的篇或标题，先修标注`);
	if (parsed.apiClasses !== undefined) await measureApi(parsed.apiClasses, base, status, localDocs);
}

/**
 * 改道提示（"改去读整张场景表"）发得对不对。两批查询，都按模型平时的默认参数查（前 5 条、不过滤）：
 * 真机评测集（答案人工标到篇）和 verify:eval 里答案是场景的题。每条记：
 * - 说错了：发了，但答案已经在前 3 条里；
 * - 漏了：没发，答案不在前 3 条里、答案又是场景（读整表本来找得到）；
 * - 发对了：发了，答案不在前 3 条里、答案是场景。
 */
async function measureSteer(
	file: string,
	base: ReturnType<typeof openKnowledgeBase>,
	status: ReturnType<typeof resolveKnowledgeSource>,
	localDocs: LocalReferenceDoc[],
): Promise<void> {
	const parsed = JSON.parse(readFileSync(file, "utf8")) as { cases: RecallCase[] };
	const sets = [
		{
			name: "真机评测集",
			items: parsed.cases
				.filter((item) => item.answers.length > 0)
				.map((item) => ({ id: item.id, query: item.query, answers: item.answers.map((answer) => answer.doc) })),
		},
		{
			name: "verify:eval 答案是场景的题",
			items: EVAL_CASES.filter((item) => item.kind !== "version-drift" && item.scene !== null).map((item) => ({
				id: item.id,
				query: item.query,
				answers: [`official:platform/scenes/${item.scene}`],
			})),
		},
	];
	for (const set of sets) {
		const tally = { fired: 0, wrong: [] as string[], missed: [] as string[], right: 0 };
		for (const item of set.items) {
			const report = await runKnowledge(
				base,
				status,
				{ action: "search", query: item.query },
				nodeKnowledgeDocs,
				offline,
				undefined,
				[],
				localDocs,
			);
			if (!report.ok || report.value.action !== "search") continue;
			const top = report.value.results
				.slice(0, 3)
				.map((hit) =>
					hit.relativePath.startsWith("reference:") ? hit.relativePath : `official:${hit.relativePath}`,
				);
			const inTop = item.answers.some((answer) => top.includes(answer));
			const scene = item.answers.some((answer) => answer.startsWith("official:platform/scenes/"));
			const fired = report.value.steer !== null;
			if (fired) tally.fired++;
			if (fired && inTop) tally.wrong.push(`${item.id} ${item.query}`);
			if (!fired && !inTop && scene) tally.missed.push(`${item.id} ${item.query}`);
			if (fired && !inTop && scene) tally.right++;
		}
		console.log(
			`[${set.name}] ${set.items.length} 条：发了 ${tally.fired}，发对 ${tally.right}，说错 ${tally.wrong.length}，漏了 ${tally.missed.length}`,
		);
		for (const line of tally.wrong) console.log(`   说错：${line}`);
		for (const line of tally.missed) console.log(`   漏了：${line}`);
	}
}

/**
 * 真机会话里 api 问过的类：官方有没有给文档；本地提到这个类的篇有没有一起回来。
 * 本地「应回」不人工标：参考文档正文以整词提到类简名的篇（大小写不敏感，和顺带搜同一份小写正文）。
 */
async function measureApi(
	classes: string[],
	base: ReturnType<typeof openKnowledgeBase>,
	status: Parameters<typeof runKnowledge>[1],
	localDocs: LocalReferenceDoc[],
): Promise<void> {
	let withDoc = 0;
	let localExpected = 0;
	let localFound = 0;
	// 本地块在模型那边占多少：信封里的 local 数组（裁掉路径、正文挪走后）加挪出来的文本块
	let localBytes = 0;
	let localClasses = 0;
	// 同一口径再按原样大小写数一遍：变量 row、cell 不算提到 Row、Cell 类（基线那把尺子不分大小写，这里并排给）
	let strictExpected = 0;
	let strictFound = 0;
	const missingDoc: string[] = [];
	const missingLocal: string[] = [];
	for (const fqcn of classes) {
		const report = await runKnowledge(
			base,
			status,
			{ action: "api", query: fqcn },
			nodeKnowledgeDocs,
			offline,
			undefined,
			[],
			localDocs,
		);
		const hasDoc =
			report.ok &&
			report.value.action === "api" &&
			report.value.entries.some((entry) => entry.relativePath !== null);
		if (hasDoc) withDoc++;
		else missingDoc.push(fqcn);
		const local = report.ok && report.value.action === "api" ? (report.value.entries[0]?.local ?? []) : [];
		if (local.length > 0) {
			localClasses++;
			const prose = extractProse("cosmic_knowledge", { action: "api", entries: [{ local }] });
			const moved = (prose.result as { entries: { local: unknown }[] }).entries[0]?.local;
			localBytes +=
				encoder.encode(JSON.stringify(moved)).length +
				prose.blocks.reduce((sum, block) => sum + encoder.encode(`# ${block.label}\n\n${block.text}`).length, 0);
		}
		const simple = (fqcn.split(".").at(-1) ?? fqcn).toLowerCase();
		const word = new RegExp(`(^|[^a-z0-9_])${simple}([^a-z0-9_]|$)`);
		const expected = localDocs.filter((doc) => word.test(doc.text)).map((doc) => doc.name);
		const returned = local.map((passage) => passage.show.slice("reference:".length).split("#")[0] ?? "");
		const exactName = fqcn.split(".").at(-1) ?? fqcn;
		const strictWord = new RegExp(`(^|[^A-Za-z0-9_])${exactName}([^A-Za-z0-9_]|$)`);
		const strict = localDocs.filter((doc) => strictWord.test(doc.source)).map((doc) => doc.name);
		if (strict.length > 0) {
			strictExpected++;
			if (returned.some((name) => strict.includes(name))) strictFound++;
		}
		if (expected.length === 0) continue;
		localExpected++;
		if (returned.some((name) => expected.includes(name))) localFound++;
		else missingLocal.push(`${simple}（应回 ${expected.join("、")}）`);
	}
	console.log("");
	console.log(`[api] ${classes.length} 个类：官方给出文档 ${withDoc}/${classes.length}`);
	console.log(`      本地文档提到它的 ${localExpected} 个，一起回来 ${localFound}/${localExpected}`);
	console.log(`      按原样大小写算提到它的 ${strictExpected} 个，一起回来 ${strictFound}/${strictExpected}`);
	console.log(`      带本地块的类 ${localClasses} 个，本地块合计 ${localBytes} B（模型侧）`);
	console.log(`      官方没文档：${missingDoc.map((fqcn) => fqcn.split(".").at(-1)).join(" ")}`);
	console.log(`      本地没回来：${missingLocal.join("；")}`);
}

const packFile = resolve(
	new URL("../knowledge/cosmic-kb.pack", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
);
const refFile = resolve(
	new URL("../knowledge/reference.pack", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
);
const cacheRoot = mkdtempSync(join(tmpdir(), "cosmic-retrieval-"));
try {
	const snapshot = await loadKnowledgeSnapshot(packFile);
	const released = await releaseKnowledge(cacheRoot, snapshot);
	const status = resolveKnowledgeSource(
		{
			configuredRoot: null,
			embedded: {
				root: released.layout.docsDir,
				bundleVersion: released.bundleVersion,
				snapshotId: released.snapshotId,
				docCount: released.docCount,
			},
		},
		nodeKnowledgeFileSystem,
	);
	const base = openKnowledgeBase(status.root, nodeKnowledgeDocs);
	const reference = await loadKnowledgeSnapshot(refFile);
	const releasedRef = await releaseReference(cacheRoot, reference);
	const localDocs: LocalReferenceDoc[] = (await readReleasedSkills(releasedRef.layout, reference)).flatMap((entry) => {
		const front = parseSkillFrontmatter(entry.text);
		return front === null
			? []
			: [
					{
						name: front.name,
						description: front.description,
						file: entry.path,
						text: entry.text.toLowerCase(),
						source: entry.text,
					},
				];
	});

	const casesFile = argValue("--cases");
	if (casesFile !== undefined) {
		const rawRef = new Map<string, string>();
		for (const entry of await readReleasedSkills(releasedRef.layout, reference)) {
			const front = parseSkillFrontmatter(entry.text);
			if (front !== null) rawRef.set(front.name, entry.text);
		}
		const docText = (doc: string): string | null => {
			if (doc.startsWith("reference:")) return rawRef.get(doc.slice("reference:".length)) ?? null;
			try {
				return readFileSync(join(status.root, ...doc.slice("official:".length).split("/")), "utf8");
			} catch {
				return null;
			}
		};
		if (process.argv.includes("--steer")) await measureSteer(casesFile, base, status, localDocs);
		else await measureRecall(casesFile, base, status, localDocs, docText);
		rmSync(cacheRoot, { recursive: true, force: true });
		process.exit(0);
	}

	// `--search <词>` 可重复：不跑固定样本，只看这些查询各回来什么（回放真机会话里模型真问过的词）
	const adHoc = process.argv.flatMap((arg, index) =>
		arg === "--search" && process.argv[index + 1] !== undefined ? [process.argv[index + 1] as string] : [],
	);
	const cases: Case[] =
		adHoc.length === 0
			? CASES
			: adHoc.map((query, index) => ({
					id: `q${String(index + 1)}`,
					kind: "business",
					// `--limit N`：看答案排在第几，不止前 5 条
					request: {
						action: "search",
						query,
						...(argValue("--limit") ? { limit: Number(argValue("--limit")) } : {}),
					},
					official: [],
					local: [],
				}));

	const rows = [];
	for (const item of cases) {
		const report = await runKnowledge(
			base,
			status,
			item.request,
			nodeKnowledgeDocs,
			offline,
			undefined,
			[],
			localDocs,
		);
		let officialPaths: string[] = [];
		// search 的本地命中就在结果里（reference:<篇名>）；api 的在每个类的 local 里
		let local: string[] = [];
		let note = "";
		if (!report.ok) note = `错误 ${report.error.code}`;
		else if (report.value.action === "search") {
			const paths = report.value.results.map((result) => result.relativePath);
			officialPaths = paths.filter((path) => !path.startsWith("reference:"));
			local = paths.filter((path) => path.startsWith("reference:")).map((path) => path.slice("reference:".length));
			if (report.value.steer) note = "附改道提示";
		} else if (report.value.action === "api") {
			officialPaths = report.value.entries.flatMap((entry) =>
				entry.relativePath === null ? [] : [entry.relativePath],
			);
			local = report.value.entries.flatMap((entry) =>
				(entry.local ?? []).map((passage) => passage.show.slice("reference:".length).split("#")[0] ?? ""),
			);
			const empty = report.value.entries.filter((entry) => entry.relativePath === null).map((entry) => entry.fqcn);
			if (empty.length > 0) note = `无文档 ${empty.join(" ")}`;
		}
		const officialHit =
			item.official.length === 0
				? null
				: officialPaths.some((path) =>
						item.official.some((want) => path.toLowerCase().includes(want.toLowerCase())),
					);
		const localHit = item.local.length === 0 ? null : local.some((name) => item.local.includes(name));
		rows.push({
			id: item.id,
			kind: item.kind,
			query: `${item.request.action} ${item.request.query ?? ""}`,
			officialHit,
			officialTop: officialPaths.slice(0, 3),
			localHit,
			local,
			bytes: report.ok ? bytes(report.value) : 0,
			note,
		});
	}

	if (process.argv.includes("--json")) {
		console.log(JSON.stringify(rows, null, 2));
	} else {
		const mark = (value: boolean | null): string => (value === null ? "—" : value ? "取回" : "没取回");
		for (const row of rows) {
			console.log(`${row.id.padEnd(20)} ${row.query}`);
			console.log(
				`   官方：${mark(row.officialHit)}  前三 ${row.officialTop.join(" | ") || "（空）"}${row.note ? `  [${row.note}]` : ""}`,
			);
			console.log(`   本地：${mark(row.localHit)}  ${row.local.join(" | ") || "（空）"}`);
		}
		for (const kind of ["fqcn", "simple", "method", "business"] as const) {
			const group = rows.filter((row) => row.kind === kind);
			const count = (key: "officialHit" | "localHit") => {
				const asked = group.filter((row) => row[key] !== null);
				return `${asked.filter((row) => row[key] === true).length}/${asked.length}`;
			};
			console.log(`[${kind}] 官方 ${count("officialHit")}  本地 ${count("localHit")}`);
		}
	}
} finally {
	rmSync(cacheRoot, { recursive: true, force: true });
}
