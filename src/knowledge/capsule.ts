import { createHash } from "node:crypto";
import { isAdHocProbeFile } from "../kernel/layout.ts";
import { probeImports } from "../kernel/policy/api-precheck.ts";
import { apiItems, describeAttach, type PluginRoute, referenceSkillName } from "./catalog.ts";
import type { KnowledgeBase } from "./docs.ts";
import { type JavaSourcePort, type PluginFamily, pluginFamiliesIn } from "./plugin-base.ts";
import { pluginHints } from "./plugin-gate.ts";
import type { LocalReferenceDoc } from "./reference.ts";
import { isRunKind, RUN_ADAPTER_CONTRACTS, RUN_KINDS, runHelpCall } from "./run-adapter.ts";

export const KNOWLEDGE_CAPSULE_SCHEMA = "cosmic.knowledge-capsule/1";
export const CAPSULE_SINGLE_BUDGET_BYTES = 3 * 1024;
export const CAPSULE_TURN_BUDGET_BYTES = 8 * 1024;
export const CAPSULES_PER_TURN = 3;

export type KnowledgeCapsuleKind = "plugin" | "probe-api" | "run-adapter";

export interface KnowledgeCapsule {
	schema: typeof KNOWLEDGE_CAPSULE_SCHEMA;
	subject: string;
	kind: KnowledgeCapsuleKind;
	runtimeKeyId: string | null;
	must: string[];
	avoid: string[];
	signatures: string[];
	verificationRoute: string[];
	sourceRefs: string[];
	confidence: "exact" | "partial";
	digest: string;
}

export type KnowledgeCapsuleInput = Omit<KnowledgeCapsule, "schema" | "digest">;

export class CapsuleBudgetError extends Error {
	readonly bytes: number;
	readonly limit: number;

	constructor(bytes: number, limit: number) {
		super(`Knowledge Capsule ${String(bytes)} bytes exceeds ${String(limit)} byte limit`);
		this.name = "CapsuleBudgetError";
		this.bytes = bytes;
		this.limit = limit;
	}
}

const encoder = new TextEncoder();
const bytesOf = (text: string): number => encoder.encode(text).length;

function unique(lines: readonly string[]): string[] {
	return [...new Set(lines.map((line) => line.trim()).filter((line) => line !== ""))];
}

function bodyOf(input: KnowledgeCapsuleInput): Omit<KnowledgeCapsule, "digest"> {
	return {
		schema: KNOWLEDGE_CAPSULE_SCHEMA,
		subject: input.subject.trim(),
		kind: input.kind,
		runtimeKeyId: input.runtimeKeyId,
		must: unique(input.must),
		avoid: unique(input.avoid),
		signatures: unique(input.signatures),
		verificationRoute: unique(input.verificationRoute),
		sourceRefs: unique(input.sourceRefs).sort(),
		confidence: input.confidence,
	};
}

function digestOf(body: Omit<KnowledgeCapsule, "digest">): string {
	return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

/**
 * 出处在显示时换成模型能打开的样子。
 *
 * 胶囊里存的是 `reference:cosmic-plugin-ui` 这种名字，摘要也按名字算：参考文档释放在哪个目录
 * 是这台机器的事，不该让同一张胶囊换个缓存目录就算成"没发过"。但名字本身模型读不了——pi 只认
 * 六个族索引的名字，成员页得有绝对路径才能 read。真机 26 次改过业务代码的会话里，25 次胶囊把
 * 插件文档列成了出处，没有一次读到非打印类插件文档。所以换路径放在显示这一步做。
 */
export type CapsuleSourceResolver = (sourceRef: string) => string;

const sourceAsIs: CapsuleSourceResolver = (sourceRef) => sourceRef;

export function renderKnowledgeCapsule(
	capsule: KnowledgeCapsule,
	resolveSource: CapsuleSourceResolver = sourceAsIs,
): string {
	const section = (name: string, values: readonly string[]): string[] =>
		values.length === 0 ? [] : [`${name}:`, ...values.map((value) => `- ${value}`)];
	return [
		`## Knowledge Capsule · ${capsule.kind} · ${capsule.subject}（这一步要用的说明，直接照它做）`,
		`schema=${capsule.schema} confidence=${capsule.confidence} runtimeKey=${capsule.runtimeKeyId ?? "none"} digest=${capsule.digest}`,
		...section("要点", capsule.must),
		...section("容易错", capsule.avoid),
		...section("签名", capsule.signatures),
		...section("怎么验", capsule.verificationRoute),
		...section("出处", capsule.sourceRefs.map(resolveSource)),
	].join("\n");
}

export function createKnowledgeCapsule(input: KnowledgeCapsuleInput): KnowledgeCapsule {
	const body = bodyOf(input);
	if (body.subject === "") throw new Error("Knowledge Capsule subject must not be empty");
	const capsule: KnowledgeCapsule = { ...body, digest: digestOf(body) };
	const bytes = bytesOf(renderKnowledgeCapsule(capsule));
	if (bytes > CAPSULE_SINGLE_BUDGET_BYTES) throw new CapsuleBudgetError(bytes, CAPSULE_SINGLE_BUDGET_BYTES);
	return capsule;
}

export interface CapsuleSelection {
	capsules: KnowledgeCapsule[];
	text: string;
	bytes: number;
	dropped: { digest: string; reason: "duplicate" | "count" | "turn-budget" }[];
}

/** Stable first-fit selection: producer priority is preserved, duplicates never consume budget. */
export function selectKnowledgeCapsules(
	capsules: readonly KnowledgeCapsule[],
	delivered: ReadonlySet<string> = new Set(),
	resolveSource: CapsuleSourceResolver = sourceAsIs,
): CapsuleSelection {
	const selected: KnowledgeCapsule[] = [];
	const dropped: CapsuleSelection["dropped"] = [];
	const seen = new Set(delivered);
	let bytes = 0;
	for (const capsule of capsules) {
		if (seen.has(capsule.digest)) {
			dropped.push({ digest: capsule.digest, reason: "duplicate" });
			continue;
		}
		seen.add(capsule.digest);
		if (selected.length >= CAPSULES_PER_TURN) {
			dropped.push({ digest: capsule.digest, reason: "count" });
			continue;
		}
		const rendered = renderKnowledgeCapsule(capsule, resolveSource);
		const addition = bytesOf(`${selected.length === 0 ? "" : "\n\n"}${rendered}`);
		if (bytes + addition > CAPSULE_TURN_BUDGET_BYTES) {
			dropped.push({ digest: capsule.digest, reason: "turn-budget" });
			continue;
		}
		selected.push(capsule);
		bytes += addition;
	}
	return {
		capsules: selected,
		text: selected.map((capsule) => renderKnowledgeCapsule(capsule, resolveSource)).join("\n\n"),
		bytes,
		dropped,
	};
}

/** The class a probe-api capsule describes: its subject up to ` ← <probe file>`. */
export function probeApiClassOf(capsule: KnowledgeCapsule): string {
	return capsule.subject.split(" ← ")[0]?.trim() ?? capsule.subject;
}

/** What a delivered probe-api capsule told the model about its class, line by line. */
export function probeApiLinesOf(capsule: KnowledgeCapsule): string[] {
	return [...capsule.must, ...capsule.signatures];
}

/**
 * A probe-api capsule for a class the model has already been told about, cut
 * down to the lines it has not seen yet (S24 D2).
 *
 * The digest dedup in `selectKnowledgeCapsules` does not catch these: a
 * probe-api digest covers the probe file and the signatures of the methods that
 * probe happens to call, so every edit to the probe and every new probe file is
 * a "new" capsule for `DataRowSet` again. The 2026-09-17 session sent the same
 * five classes three times each -- 6.8 KB of 17.8 KB of capsule text -- while
 * the model was renaming one method call per round.
 *
 * Only the lines are compared, never the digest: a new signature (the probe now
 * calls a method it did not before) still goes out; the fixed advice ("精确
 * import"、"不要反复猜") and signatures already shown do not. What is left says in
 * its subject that the rest was given earlier. A capsule with nothing left is
 * dropped: a title with no line under it tells the model nothing it can act on
 * (2026-10: 12 of them, 4.4 KB). Other kinds pass through untouched.
 *
 * The caller owns `explained` and must forget it whenever the earlier text may
 * be gone from context (compaction, a branch switch) -- "given earlier" pointing
 * at nothing is worse than sending it twice.
 */
export function condenseProbeApiCapsules(
	capsules: readonly KnowledgeCapsule[],
	explained: ReadonlyMap<string, ReadonlySet<string>>,
): KnowledgeCapsule[] {
	return capsules.flatMap((capsule) => {
		if (capsule.kind !== "probe-api") return [capsule];
		const fqcn = probeApiClassOf(capsule);
		const seen = explained.get(fqcn);
		if (seen === undefined) return [capsule];
		const unseen = (lines: readonly string[]): string[] => lines.filter((line) => !seen.has(line));
		const must = unseen(capsule.must);
		const signatures = unseen(capsule.signatures);
		if (must.length === 0 && signatures.length === 0) return [];
		return [
			createKnowledgeCapsule({
				subject: `${fqcn}（这个类的说明本次会话前面给过，这里只列新出现的）`,
				kind: "probe-api",
				runtimeKeyId: capsule.runtimeKeyId,
				must,
				avoid: [],
				signatures,
				verificationRoute: [],
				sourceRefs: [],
				confidence: capsule.confidence,
			}),
		];
	});
}

/** Markdown 行内写法去掉：`**粗体**` 留字，`[文字](链接)` 留文字；反引号保留，类名方法名靠它认。 */
function plainItem(text: string): string {
	return text
		.replace(/\*\*/g, "")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.trim();
}

/**
 * 一族插件的「必知要点」：`route.local` 那篇里标题为 `route.essentials` 的那一节，一个列表项一条。
 *
 * 这一节是人写的（S45 批 4）：卡片内容原来是正则从官方指南里摘的含"必须、注意、先"的行和带括号的行，
 * 摘出过孤零零的"注意："、表格碎片和半截 `for (...) {`，三个表单族的卡片一模一样。现在卡片好不好是写文档的事，
 * 能审、能量。只取列表项：节里的引导句和段落不进卡片。没写要点、参考包不在、标题找不到，都返回空。
 */
export function pluginEssentials(local: readonly LocalReferenceDoc[], route: PluginRoute): string[] {
	if (route.essentials === null) return [];
	return sectionItems(local, route.local, route.essentials);
}

/** 参考文档 `docFile` 里标题为 `heading` 的那一节的第一个列表，一项一条。 */
function sectionItems(local: readonly LocalReferenceDoc[], docFile: string, heading: string): string[] {
	const name = referenceSkillName(docFile);
	const doc = local.find((entry) => entry.name === name);
	if (doc === undefined) return [];
	const lines = doc.source.split(/\r?\n/);
	const start = lines.findIndex((line) => /^#{1,6} /.test(line) && line.replace(/^#+ /, "").trim() === heading);
	if (start < 0) return [];
	// 要点是标题下的第一个列表：列表之后的段落（以及再往后的列表）是正文，不进卡片
	const items: string[] = [];
	for (const line of lines.slice(start + 1)) {
		if (/^#{1,6} /.test(line)) break;
		if (/^[-*] /.test(line)) items.push(line.slice(2));
		else if (/^\s+\S/.test(line) && items.length > 0) items[items.length - 1] += line.trim();
		else if (line.trim() !== "" && items.length > 0) break;
	}
	return items.map(plainItem).filter((item) => item !== "");
}

/**
 * 各族插件共用的写法规矩（S51）：循环里查库、常量复用、类和方法多长、加不加新插件类。
 *
 * 和插件族要点分开一张卡：内容各族一样，主题不带基类名，一个会话只发一次（按摘要去重）。
 * 只在读写真插件类时随族卡一起发——写工具类、探针时不发。编译前的知识门禁不要求这张卡：
 * 写法由写完就查和编译前兜底管，不由「发没发过卡」管。
 */
export const CODING_RULES_DOC = "plugin-dev.md";
export const CODING_RULES_HEADING = "插件写法必知要点";

export function codingRulesCapsule(
	local: readonly LocalReferenceDoc[],
	runtimeKeyId: string | null,
): KnowledgeCapsule | null {
	const rules = sectionItems(local, CODING_RULES_DOC, CODING_RULES_HEADING);
	if (rules.length === 0) return null;
	return createKnowledgeCapsule({
		subject: "插件写法",
		kind: "plugin",
		runtimeKeyId,
		must: rules,
		avoid: [],
		signatures: [],
		verificationRoute: [],
		sourceRefs: [`reference:${referenceSkillName(CODING_RULES_DOC)}`],
		confidence: "exact",
	});
}

/**
 * 每个认出的插件族一张卡片。门禁（`cosmic_fast` 前）要每一族都能生成卡片，所以没写要点的族也照样生成；
 * 推不推给模型由 `sourceKnowledgeCapsules` 决定：没有要点的不推。
 *
 * 主题只写基类名：同一族的要点和读写的是哪个文件无关，读过一个单据插件、再写另一个，同一张卡不再发第二遍。
 */
export function pluginKnowledgeCapsules(
	base: KnowledgeBase,
	families: readonly PluginFamily[],
	runtimeKeyId: string | null,
	local: readonly LocalReferenceDoc[] = [],
): KnowledgeCapsule[] {
	return pluginHints(base, families).map((hint, index) => {
		const route = families[index]?.route;
		const essentials = route === undefined ? [] : pluginEssentials(local, route);
		return createKnowledgeCapsule({
			subject: hint.base,
			kind: "plugin",
			runtimeKeyId,
			must: [
				`${hint.base} 是${hint.pluginType === null ? "" : ` ${hint.pluginType} `}平台插件族`,
				...essentials,
				"这里没列的事件或参数，按出处定点读取",
			],
			avoid: hint.tier === "loose" ? ["只按标识符命中，还没确认真实继承关系：改事件签名前先确认父类"] : [],
			signatures: [],
			verificationRoute: [
				hint.bind === null ? "先用 cosmic_impact 查这个类挂在哪，确认真实绑定" : `先用 ${hint.bind} 确认真实绑定`,
				...(hint.attach === null ? [] : [describeAttach(hint.attach)]),
				...(hint.verify === "" ? ["没有无头适配器：行为验证需要真节点"] : [hint.verify]),
			],
			sourceRefs: [
				`knowledge:${hint.guide}`,
				...(route === undefined ? [] : [`reference:${referenceSkillName(route.local)}`]),
			],
			confidence: hint.tier === "loose" || essentials.length === 0 ? "partial" : "exact",
		});
	});
}

/**
 * 临时探针 import 的每个平台类一张卡片。只放确定的事：精确 import、用哪篇官方文档。
 * 探针真正调用的方法的签名，由 `prepareProbeApis` 跑之前按 JAR 反射补上（`enrichCapsules`）。
 */
export function probeApiKnowledgeCapsules(
	base: KnowledgeBase,
	file: string,
	sourceText: string,
	runtimeKeyId: string | null,
): KnowledgeCapsule[] {
	const items = new Map(apiItems(base).flatMap((item) => (item.fqcn === undefined ? [] : [[item.fqcn, item]])));
	return probeImports(sourceText).classes.map((fqcn) => {
		const item = items.get(fqcn);
		return createKnowledgeCapsule({
			subject: `${fqcn} ← ${file.replace(/\\/g, "/")}`,
			kind: "probe-api",
			runtimeKeyId,
			must: [`临时探针精确 import ${fqcn}`],
			avoid: ["通配 import（目标不确定，探针会拒绝）"],
			signatures: [],
			verificationRoute: [`cosmic_probe name=${file.replace(/\\/g, "/")}（起 JVM 前先做只读扫描）`],
			sourceRefs: item === undefined ? ["knowledge:api-index-miss"] : [`knowledge:${item.relativePath}`],
			confidence: "partial",
		});
	});
}

/**
 * 读、写业务源码时推给模型的卡片：认出的插件族里写了必知要点的那几族。
 *
 * 临时探针不在这里推：它的卡片在写探针那一刻只有"精确 import"一句，探针工具自己会拒绝通配 import；
 * 真正有用的是探针调用的方法签名，等 `cosmic_probe` 跑之前反射出来再随结果给。
 *
 * 只推真继承了插件基类的文件（直接或经工程自己的父类）。"源码里出现过基类名"那一档不推：
 * 真机里读一个把 `AbstractListPlugin` 当参数类型的工具类，收到了一张"直接照它做"的列表插件卡。
 * 编译前的门禁照旧算这一档（`advisorFor`），宁可多要一张卡也不漏。逐个文件判，
 * 因为 `pluginFamiliesIn` 同一基类只留第一个文件的判定，先来的猜测会盖住后来的真继承。
 */
export function sourceKnowledgeCapsules(input: {
	base: KnowledgeBase;
	source: JavaSourcePort;
	files: readonly string[];
	runtimeKeyId: string | null;
	local: readonly LocalReferenceDoc[];
}): KnowledgeCapsule[] {
	const families = new Map<string, PluginFamily>();
	let plugin = false;
	for (const file of input.files) {
		if (isAdHocProbeFile(file)) continue;
		for (const family of pluginFamiliesIn([file], input.source)) {
			if (family.tier === "loose") continue;
			plugin = true;
			if (families.has(family.route.base)) continue;
			if (pluginEssentials(input.local, family.route).length > 0) families.set(family.route.base, family);
		}
	}
	const capsules = pluginKnowledgeCapsules(input.base, [...families.values()], input.runtimeKeyId, input.local);
	const rules = plugin ? codingRulesCapsule(input.local, input.runtimeKeyId) : null;
	return rules === null ? capsules : [...capsules, rules];
}

export function runAdapterKnowledgeCapsule(argv: readonly string[], runtimeKeyId: string | null): KnowledgeCapsule {
	const [rawKind, target] = argv;
	if (!isRunKind(rawKind)) {
		return createKnowledgeCapsule({
			subject: `run:${rawKind ?? "missing"}`,
			kind: "run-adapter",
			runtimeKeyId,
			must: [`第一个参数必须是 ${RUN_KINDS.join(" / ")}；各子命令的写法：${runHelpCall()}`],
			avoid: [],
			signatures: [],
			verificationRoute: ["先补全 adapter 与目标，再调用 cosmic_run"],
			sourceRefs: ["reference:cosmic-run"],
			confidence: "partial",
		});
	}
	const contract = RUN_ADAPTER_CONTRACTS[rawKind];
	return createKnowledgeCapsule({
		subject: `run ${rawKind} ${target ?? "<目标>"}`,
		kind: "run-adapter",
		runtimeKeyId,
		must: [
			contract.hint,
			...contract.must,
			`可用参数：${contract.accepted.map((flag) => `--${flag}`).join(" ")}（每个参数的写法和含义：${runHelpCall(rawKind)}）`,
		],
		avoid: [...contract.avoid],
		signatures: [...contract.examples],
		verificationRoute: [`${contract.probe}；冷启动策略=${contract.cold}`, "用 --expect 形成可判定断言"],
		sourceRefs: ["reference:cosmic-run", `probe:${contract.probe}`],
		confidence: target === undefined || target === "" ? "partial" : "exact",
	});
}
