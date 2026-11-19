/**
 * The self-authored `reference/` knowledge, as pi-native skills (S7.1).
 *
 * The 30 documents under knowledge/reference/ are generated into skills by scripts/export-reference.mjs and
 * travel in their own pack. This module is the runtime half: release them, then
 * hand pi the directory to discover them in.
 *
 * Why skills and not a routing table, restated because it is the whole point of
 * the stage: the frozen SKILL.md kept a 31-row "按任务取文档" table that was just
 * every document's description gathered into one hand-maintained place. It is
 * defect D-4 in docs/knowledge-injection.md. A skill carries its own description,
 * so the table stops existing rather than being ported.
 *
 * That is only true because the descriptions come from each page's own frontmatter
 * (`class` / `when` / `note`, see scripts/export-reference.mjs). Deriving them from
 * the table would have moved the defect rather than fixed it: the table would still
 * have been the one hand-maintained place, and 5.1 deletes the document it lives in,
 * after which a newly written page would have had no description source at all.
 *
 * What skills are NOT good enough for, from pi's own documentation:
 *
 *   > When a task matches, the agent uses `read` to load the full SKILL.md
 *   > (models don't always do this; use prompting or `/skill:name` to force it).
 *
 * That makes this a tier-③-leaning-② mechanism in the design doc's terms. Nothing
 * load-bearing may rest on it: the L3 gate stays a hard refusal and the L1 hints
 * stay forced insertions. Skills raise the floor; they do not hold the line.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { KnowledgeSnapshot } from "./pack.ts";
import { type KnowledgeLayout, type KnowledgeReleaseResult, releaseKnowledge } from "./release.ts";

/** File name of the reference snapshot sidecar, beside the official one. */
export const REFERENCE_PACK_FILENAME = "reference.pack";

/**
 * Cache placement. Separate namespace from the official snapshot: the two have
 * different sources and different lifetimes, and one directory holding both would
 * make "which of them is out of date" unanswerable.
 */
export const REFERENCE_LAYOUT = { namespace: "reference", docsDirName: "skills" } as const;

export async function releaseReference(
	cacheRoot: string,
	snapshot: KnowledgeSnapshot,
): Promise<KnowledgeReleaseResult> {
	return releaseKnowledge(cacheRoot, snapshot, REFERENCE_LAYOUT);
}

/**
 * 六个族索引，和参考文档原文的关系。
 *
 * 原本 28 篇每篇都是一个 pi skill，启动时被列成八行灰字——一堵墙，谁也不会去读。
 * 现在交给 pi 的是六篇**索引**：每篇的正文一行一篇地写着「什么时候读这篇 + 它在哪」，
 * 原文一个字不动地留在磁盘上，按绝对路径 read。
 *
 * 代价说清楚：模型「知道有这篇」的依据，从 28 条常驻 description 变成 6 条 +
 * 索引正文（正文是按需读的）。所以族的 description 必须把这一族**覆盖了什么**说全，
 * 而不是只说族名——那是模型决定要不要展开这一族的唯一依据。
 *
 * 名字只能是 [a-z0-9-]：pi 的 skill 名有这条硬校验（见下面的 NAME_PATTERN），
 * 中文只能进 description 和正文。
 */
export interface ReferenceFamily {
	name: string;
	/** 正文标题用的中文族名。 */
	title: string;
	description: string;
	/** 成员文档的目录名，即快照里 `<目录>/SKILL.md` 的那个目录。 */
	members: readonly string[];
}

export const REFERENCE_FAMILIES: readonly ReferenceFamily[] = [
	{
		name: "cosmic-metadata",
		title: "元数据",
		description:
			"苍穹元数据的读与写：实体与字段、表单布局、界面规则、业务规则、BOTP 转换规则、新建表单后的登记与回验，非实体元数据的 meta 命令入口，以及配置和代码的分工（哪些用属性、规则、字段映射配，哪些才写插件）。" +
			"什么时候读：定一个功能的实现方式，要看懂或改动共享环境里的任何元数据——写入总则（确认目标、红线、备份、回验）也在这一族。",
		members: [
			"cosmic-metadata-or-code",
			"cosmic-metadata-read",
			"cosmic-metadata-write",
			"cosmic-metadata-entity",
			"cosmic-metadata-entity-write",
			"cosmic-metadata-form",
			"cosmic-metadata-form-rules",
			"cosmic-metadata-business-rules",
			"cosmic-metadata-botp",
			"cosmic-metadata-botp-write",
			"cosmic-metadata-create",
			"cosmic-meta-cmd",
		],
	},
	{
		name: "cosmic-plugin",
		title: "插件开发",
		description:
			"苍穹插件：怎么选型，以及 UI（表单/单据/F7/列表/左树右表/报表）、操作与事务、BOTP 与反写、集成（报表取数、批量引入、后台任务、工作流、自定义 API）、打印运行态五族各自怎么写。" +
			"什么时候读：要写或改一个插件。",
		members: [
			"cosmic-plugin-dev",
			"cosmic-plugin-ui",
			"cosmic-plugin-operation",
			"cosmic-plugin-integration",
			"cosmic-workflow",
			"cosmic-plugin-print-runtime",
		],
	},
	{
		name: "cosmic-print",
		title: "打印模板",
		description:
			"打印模板：查询、审计、预览、本地备份，以及设计内容的修改与回滚。什么时候读：要动打印模板本身（模板里的取数插件在 cosmic-plugin）。",
		members: ["cosmic-print-template", "cosmic-print-template-write"],
	},
	{
		name: "cosmic-probe-verify",
		title: "真环境验证",
		description:
			"在真实苍穹环境里把一件事验成立：探针（已发布探针或只读临时 Java）、run（免界面跑操作/表单/列表/规则）、父子页 close 回调整条链、本会话净差别（cosmic_facts 列出代码改前改后、元数据、断言，照着写完成情况）、查业务数据与空表算法。" +
			"什么时候读：要拿真环境的证据，而不是拿「看起来对」交付。",
		members: ["cosmic-probes", "cosmic-run", "cosmic-run-parent-child", "cosmic-verify", "cosmic-data-query"],
	},
	{
		name: "cosmic-runtime",
		title: "运行与工程",
		description:
			"构建 / fast / 本地调试节点 / 截图 / 部署 / 排错，苍穹 SDK 的官方路由与当前运行时差异（QFilter、DynamicObject、DataSet、缓存、锁、事务、日志），影响面索引（按改动的类、实体、字段计算代码与元数据影响范围），" +
			"以及运行痕迹（monitor 日志怎么读，上下游、流程、后台任务、操作记录在哪些表）。" +
			"什么时候读：跑不起来、要部署、拿不准某个 SDK 该怎么用、想知道这次改动动过谁，或在排查生产问题。",
		members: ["cosmic-runtime", "cosmic-sdk", "cosmic-impact", "cosmic-runtime-traces"],
	},
	{
		name: "cosmic-standards",
		title: "规范与反模式",
		description:
			"动手之前先确认：某个类/方法/字段/常量是不是真的存在（api、findclass、lint），以及苍穹插件的语义陷阱（方法名幻觉、上下文或事务场景错配）。" +
			"什么时候读：写代码之前，或方法名、上下文看着可疑时。",
		members: ["cosmic-anti-patterns", "cosmic-lint"],
	},
];

/** 族索引住在快照根下自己的目录里，与原文分开——混在一起 pi 会把原文也当 skill 收走。 */
export const REFERENCE_FAMILY_DIRNAME = "families";

export function referenceFamilyDir(layout: KnowledgeLayout): string {
	return join(layout.root, REFERENCE_FAMILY_DIRNAME);
}

/**
 * The directory to hand pi's `resources_discover` hook as a skillPath.
 *
 * It is a directory, not a file list, because that is what pi scans; and it is an
 * absolute path because a skill's `location` is what the model passes to `read`.
 * That requirement is the reason the snapshot is released to disk at all.
 *
 * 交出去的是族索引目录，不是原文所在的 docsDir：pi 会把它扫到的每个
 * `<子目录>/SKILL.md` 都注册成 skill，把原文目录交出去就等于回到逐篇一项。
 */
export function referenceSkillPaths(layout: KnowledgeLayout): string[] {
	return [referenceFamilyDir(layout)];
}

/**
 * 胶囊出处 `reference:<篇名>` → 那一篇释放在磁盘上的绝对路径，给模型直接 read。
 *
 * 文件不在（篇名写错、那篇被删了）就原样留着名字：给一条打不开的路径，比给名字更糟。
 */
export function referenceSourceResolver(docsDir: string): (sourceRef: string) => string {
	const prefix = "reference:";
	return (sourceRef) => {
		if (!sourceRef.startsWith(prefix)) return sourceRef;
		const file = join(docsDir, sourceRef.slice(prefix.length), "SKILL.md");
		return existsSync(file) ? file : sourceRef;
	};
}

/** 一篇族索引的正文：一行一篇成员，带它自己的 description 和绝对路径。 */
export function familyIndexText(
	family: ReferenceFamily,
	members: readonly { name: string; description: string; file: string }[],
): string {
	const body = members
		.map((member) => `- **${member.name}** —— ${member.description}\n  \`${member.file}\``)
		.join("\n");
	return (
		`---\nname: ${family.name}\ndescription: ${JSON.stringify(family.description)}\n---\n\n` +
		`# 苍穹 · ${family.title}（${String(members.length)} 篇）\n\n` +
		"下面每一篇都在磁盘上。按「什么时候读」挑一篇，然后 read 它的路径；" +
		"不确定挑哪篇就读这一族的第一篇。\n\n" +
		// 触发时机写成一条硬规则，因为「知道有这么一篇」和「现在该读它」是两件事。
		// 一次真实会话读过这份索引、记得有 cosmic-run 这一篇，仍然靠读探针源码把参数
		// 拼了出来——参数拼对了，能力边界没读到，于是在一条根本验不出来的断言上反复
		// 重试。工具的 description 说得清参数，说不清「它模拟不了什么」。
		"**动手之前先读**：要用某个 cosmic 工具做这一族里的事，先 read 对应那一篇——" +
		"工具 description 只讲参数，能力边界（模拟得了什么、模拟不了什么、结论到哪为止）只写在这里。\n\n" +
		`${body}\n`
	);
}

export interface FamilyIndexResult {
	/** 写出去的索引，路径形如 `<族名>/SKILL.md`，交给 checkSkillEntries 校验。 */
	entries: { path: string; text: string }[];
	/** 被收进某一族的成员文档数。 */
	indexed: number;
	/** 一个族都没归入的成员文档：它们从此没人知道存在，必须报出来。 */
	unfiled: string[];
}

/**
 * 生成六篇族索引。
 *
 * `unfiled` 是这套做法的安全绳：往快照里加了新文档却忘了归族，它就再也不会出现在
 * 任何一条注入里——「一篇文档悄悄不存在了」正是 D-2 那个缺陷本身。所以宁可报出来。
 */
export async function writeFamilyIndexes(
	layout: KnowledgeLayout,
	documents: readonly { dir: string; description: string }[],
): Promise<FamilyIndexResult> {
	const byDir = new Map(documents.map((document) => [document.dir, document.description]));
	const filed = new Set<string>();
	const entries: { path: string; text: string }[] = [];
	const root = referenceFamilyDir(layout);
	for (const family of REFERENCE_FAMILIES) {
		const members = family.members
			.filter((member) => byDir.has(member))
			.map((member) => {
				filed.add(member);
				return {
					name: member,
					description: byDir.get(member) as string,
					file: join(layout.docsDir, member, "SKILL.md"),
				};
			});
		const text = familyIndexText(family, members);
		await mkdir(join(root, family.name), { recursive: true });
		await writeFile(join(root, family.name, "SKILL.md"), text, "utf8");
		entries.push({ path: `${family.name}/SKILL.md`, text });
	}
	return {
		entries,
		indexed: filed.size,
		unfiled: documents.map((document) => document.dir).filter((dir) => !filed.has(dir)),
	};
}

export interface SkillFrontmatter {
	name: string;
	description: string;
}

export interface SkillCheckProblem {
	path: string;
	why: string;
}

/** pi's own limits (packages/coding-agent/src/core/skills.ts). Duplicated here so a violation fails in cosmic's tests, not silently at load. */
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const NAME_PATTERN = /^[a-z0-9-]+$/;

/**
 * Parses the frontmatter of one generated SKILL.md.
 *
 * Deliberately strict and deliberately small: this is not a YAML parser, it is a
 * check that what the generator wrote is what pi will accept. A skill pi rejects
 * is dropped with a diagnostic the user never sees, so the document would simply
 * stop existing -- which is defect D-2 returning by a different door.
 */
export function parseSkillFrontmatter(text: string): SkillFrontmatter | null {
	if (!text.startsWith("---\n")) return null;
	const end = text.indexOf("\n---", 4);
	if (end < 0) return null;
	const block = text.slice(4, end);
	const name = /^name:\s*(.+)$/m.exec(block)?.[1]?.trim();
	const rawDescription = /^description:\s*(.+)$/m.exec(block)?.[1]?.trim();
	if (name === undefined || rawDescription === undefined) return null;
	let description: string;
	try {
		description = rawDescription.startsWith('"') ? (JSON.parse(rawDescription) as string) : rawDescription;
	} catch {
		return null;
	}
	return { name, description };
}

/** Everything wrong with a released skill tree, by pi's rules. Empty means pi will load them all. */
export function checkSkillEntries(entries: readonly { path: string; text: string }[]): SkillCheckProblem[] {
	const problems: SkillCheckProblem[] = [];
	const seen = new Map<string, string>();
	for (const entry of entries) {
		if (!entry.path.endsWith("/SKILL.md")) {
			problems.push({ path: entry.path, why: "pi 只发现 SKILL.md，其它文件名不会被加载" });
			continue;
		}
		const front = parseSkillFrontmatter(entry.text);
		if (front === null) {
			problems.push({ path: entry.path, why: "frontmatter 缺 name 或 description，pi 会静默丢弃这个 skill" });
			continue;
		}
		if (!NAME_PATTERN.test(front.name)) problems.push({ path: entry.path, why: `name 不合法：${front.name}` });
		if (front.name.length > MAX_NAME_LENGTH)
			problems.push({ path: entry.path, why: `name 超过 ${MAX_NAME_LENGTH} 字符` });
		if (front.description === "") problems.push({ path: entry.path, why: "description 为空" });
		if (front.description.length > MAX_DESCRIPTION_LENGTH) {
			problems.push({ path: entry.path, why: `description 超过 ${MAX_DESCRIPTION_LENGTH} 字符` });
		}
		// The directory name is what pi shows and what /skill:<name> addresses. If it
		// disagreed with the frontmatter name, the two would be different handles for
		// one document and the routing table would be back, in disguise.
		const dir = entry.path.slice(0, entry.path.lastIndexOf("/"));
		if (dir !== front.name) problems.push({ path: entry.path, why: `目录名 ${dir} 与 name ${front.name} 不一致` });
		const previous = seen.get(front.name);
		if (previous !== undefined) problems.push({ path: entry.path, why: `name 与 ${previous} 重复` });
		seen.set(front.name, entry.path);
	}
	return problems;
}

/** 一篇本地参考文档，给知识库的 search / api 在正文里找查询词用。 */
export interface LocalReferenceDoc {
	name: string;
	description: string;
	/** 释放到磁盘上的绝对路径，命中后模型直接 read 它。 */
	file: string;
	/** 全文小写。 */
	text: string;
	/** 原文：段落索引按它切段，`show` 按它取一节。 */
	source: string;
}

/**
 * 工具名 → 讲它用法的本地参考文档。
 *
 * 搜索词里点到工具名（`cosmic-run`、`cosmic_meta`）时，问的是这个工具怎么用：那篇文档排前面；
 * 整条查询只有工具名时直接给那篇的目录，不从 55 KB 里随便挑一段。
 * 测试核对每个键都是现有工具、每个值都在参考包里。
 */
export const TOOL_REFERENCE_DOCS: Readonly<Record<string, string>> = {
	cosmic_run: "cosmic-run",
	cosmic_meta: "cosmic-meta-cmd",
	cosmic_probe: "cosmic-probes",
	cosmic_facts: "cosmic-verify",
	cosmic_impact: "cosmic-impact",
	cosmic_lint: "cosmic-lint",
	cosmic_runtime: "cosmic-runtime",
	cosmic_fast: "cosmic-runtime",
};

/** Reads a released skill tree back off disk, for verification. */
export async function readReleasedSkills(
	layout: KnowledgeLayout,
	snapshot: KnowledgeSnapshot,
): Promise<{ path: string; text: string }[]> {
	const out: { path: string; text: string }[] = [];
	for (const file of snapshot.header.files) {
		const text = await readFile(join(layout.docsDir, ...file.path.split("/")), "utf8").catch(() => null);
		if (text !== null) out.push({ path: file.path, text });
	}
	return out;
}

export interface InjectionBudget {
	/** Bytes pi's system prompt spends listing these skills, preamble included. */
	bytes: number;
	skills: number;
	/**
	 * How much of `bytes` is absolute `location` paths.
	 *
	 * Broken out because it is the one term nobody controls: the same 28 skills cost
	 * ~2 KB more from a deep temp directory than from a short cache root. Measuring
	 * the total without naming this makes the budget look like a property of the
	 * content, and a later "the budget grew" would send someone to shorten
	 * descriptions when the real cause was where the cache happened to live.
	 */
	pathBytes: number;
	/** Per-skill breakdown, largest first. */
	largest: readonly { name: string; bytes: number }[];
}

/**
 * What the skill list costs in the system prompt.
 *
 * pi puts only name + description + location there, so this is the resident cost;
 * the bodies are read on demand and are not counted. S7.5 holds it to a budget,
 * and the design doc's estimate was ~350 B per skill / ~10.5 KB for 30. Measuring
 * it here rather than trusting that estimate is the difference between a budget
 * and a hope.
 */
export function estimateInjectionBudget(
	skills: readonly { name: string; description: string }[],
	skillsDir: string,
): InjectionBudget {
	// Measured from pi's formatSkillsForPrompt, not estimated: the five wrapper
	// lines are "  <skill>", "    <name></name>", "    <description></description>",
	// "    <location></location>", "  </skill>", each with a newline. The design
	// doc's estimate said 88; the real figure is 97, and the four instruction lines
	// plus <available_skills> cost 368 once. Both corrections are small, and both
	// are the kind that quietly turn a budget into a number nobody can reproduce.
	const WRAPPER_BYTES = 97;
	const PREAMBLE_BYTES = 368;
	const sized = skills
		.map((skill) => {
			const pathBytes = Buffer.byteLength(join(skillsDir, skill.name, "SKILL.md"), "utf8");
			return {
				name: skill.name,
				pathBytes,
				bytes:
					WRAPPER_BYTES +
					Buffer.byteLength(skill.name, "utf8") +
					Buffer.byteLength(skill.description, "utf8") +
					pathBytes,
			};
		})
		.sort((a, b) => b.bytes - a.bytes);
	return {
		bytes: (sized.length > 0 ? PREAMBLE_BYTES : 0) + sized.reduce((sum, entry) => sum + entry.bytes, 0),
		skills: sized.length,
		pathBytes: sized.reduce((sum, entry) => sum + entry.pathBytes, 0),
		largest: sized.map((entry) => ({ name: entry.name, bytes: entry.bytes })).slice(0, 5),
	};
}
