/**
 * 只读查询苍穹知识库、平台类签名和已发布探针清单。
 */

import { Type } from "typebox";
import {
	budgetApiMethods,
	budgetOutput,
	DEFAULT_API_METHOD_LIMIT,
	KNOWLEDGE_SHOW_BUDGET,
} from "../../agent/tools/output-budget.ts";
import { KNOWLEDGE_ACTION_HINTS, KNOWLEDGE_ACTIONS, type KnowledgeRequest } from "../../kernel/commands/knowledge.ts";
import type { ApiJoin } from "../../knowledge/api-join.ts";
import type { CosmicToolSpec } from "../define.ts";
import { type CosmicHost, fileRemedy } from "../host.ts";
import type { ProjectHandle } from "../kernel.ts";
import { renderSuccess } from "../result.ts";

/**
 * `api` 的回答在交给模型前裁成签名：一个类的每个方法都带完整 javadoc，`QueryServiceHelper` 一个类就 43 KB。
 * 方法正文去掉、签名留下；`<fqcn>#<方法>` 单独查一个方法时给全。内核照旧返回全部。
 */
export function budgetApiAnswer<T>(value: T): T {
	if (typeof value !== "object" || value === null) return value;
	const report = value as { action?: unknown; entries?: unknown };
	if (report.action !== "api" || !Array.isArray(report.entries)) return value;
	let dropped = false;
	let fieldsCut = false;
	const entries = report.entries.map((raw) => {
		if (typeof raw !== "object" || raw === null) return raw;
		const entry = raw as Record<string, unknown>;
		const methods = Array.isArray(entry.methods) ? (entry.methods as string[]) : [];
		const full = typeof entry.member === "string";
		const cut = budgetApiMethods(methods, { full });
		if (cut.bodiesDropped || cut.omittedMethods > 0) dropped = true;
		const fields = Array.isArray(entry.fields) ? (entry.fields as string[]) : null;
		const fieldCut = fields === null ? null : budgetApiMethods(fields, { full });
		if ((fieldCut?.omittedMethods ?? 0) > 0) fieldsCut = true;
		const join = entry.join as ApiJoin | null;
		return {
			...entry,
			methods: cut.methods,
			...(cut.omittedMethods > 0 ? { omittedMethods: cut.omittedMethods } : {}),
			...(fieldCut === null ? {} : { fields: fieldCut.methods }),
			...(fieldCut !== null && fieldCut.omittedMethods > 0 ? { omittedFields: fieldCut.omittedMethods } : {}),
			join:
				join === null || join === undefined
					? null
					: {
							fqcn: join.fqcn,
							coverage: join.coverage,
							informative: join.informative,
							counts: {
								joined: join.joined.length,
								dangling: join.dangling.length,
								inherited: join.inherited.length,
								undocumented: join.undocumented.length,
							},
						},
		};
	});
	const notes = [
		...(dropped
			? [
					"方法正文已略去，只留签名。要某个方法的完整说明（参数含义、@return、注意事项），单独查它：cosmic_knowledge action=api query=<全限定类名>#<方法名>",
				]
			: []),
		...(fieldsCut
			? [
					`字段只列了前 ${String(DEFAULT_API_METHOD_LIMIT)} 个（omittedFields 是没列的个数）；查某一个：query=<全限定类名>#<字段名>`,
				]
			: []),
	];
	return { ...report, entries, ...(notes.length > 0 ? { notes } : {}) } as T;
}

/** `show` 的正文超过预算时只给头尾，中间那段列目录、指向文档在磁盘上的位置。 */
export function budgetShowAnswer<T>(value: T): T {
	if (typeof value !== "object" || value === null) return value;
	const report = value as { action?: unknown; content?: unknown; file?: unknown };
	if (report.action !== "show" || typeof report.content !== "string" || typeof report.file !== "string") return value;
	const budget = budgetOutput(report.content, KNOWLEDGE_SHOW_BUDGET);
	if (!budget.truncated) return value;
	return {
		...report,
		content: budget.shown,
		outputBudget: {
			truncated: true,
			totalBytes: budget.totalBytes,
			totalLines: budget.totalLines,
			omittedLines: budget.omittedLines,
			omittedFrom: budget.omittedFrom,
			omittedTo: budget.omittedTo,
			remedy: fileRemedy(report.content, report.file, budget),
		},
	} as T;
}

type KnowledgeArgs = {
	action: (typeof KNOWLEDGE_ACTIONS)[number];
	query?: string;
	scenes?: string[];
	pluginType?: string;
	event?: string;
	control?: string;
	kind?: "guide" | "scene" | "sdk" | "api" | "all";
	limit?: number;
	includeDraft?: boolean;
};

/** 要用户 JAR 或工程源码的几个动作：工程打得开就带上，打不开照样答（api 会说反射不可用）。 */
const NEEDS_PROJECT = new Set(["api", "anchors", "plugin", "findclass"]);

export function knowledgeTool(host: CosmicHost): CosmicToolSpec<KnowledgeArgs> {
	return {
		name: "cosmic_knowledge",
		description:
			"只读查询苍穹知识库和已发布探针清单。场景类问题（业务口吻、说不出类名）用 scenes 读整张场景表（按 pluginType 过滤，一次会话读一次就够）；" +
			"类名、方法名、配置项这类具体的词用 search 全文检索；只知道类名片段用 findclass 反查全限定名；" +
			"复杂插件语义用 plugin，方法语义和真实参数名用 api，正文用 show。每个动作做什么见 action 参数。",
		parameters: Type.Object({
			action: Type.Union(
				KNOWLEDGE_ACTIONS.map((action) => Type.Literal(action)),
				{
					description: KNOWLEDGE_ACTIONS.map((action) => `${action} ${KNOWLEDGE_ACTION_HINTS[action]}`).join("、"),
				},
			),
			query: Type.Optional(
				Type.String({
					description:
						"search 的关键词（类名、方法名、配置项这类具体的词，不是业务口吻的问句）；" +
						"show 的路径（search 结果里的 show 原样给）；" +
						"api 的全限定类名，多个类空格或逗号隔开一次查完（探针 import 清单直接整份贴进来）；" +
						"plugin 的目标（.java 绝对路径、平台基类简单名或场景标签）；" +
						"probes 的探针类名或要做的事（可多个，不给 = 列全部）",
				}),
			),
			scenes: Type.Optional(
				Type.Array(Type.String(), {
					maxItems: 2,
					description:
						"仅 plugin：第二次调用时带上选定的 1~2 篇场景篇名（抄场景表第一列）。" +
						"不给 = 第一次调用，摆出指南全文和整张场景表。官方没打过标签的族传空数组放行。" +
						"篇名必须真在这一族表里，编造的当场打回。",
				}),
			),
			pluginType: Type.Optional(
				Type.String({
					description:
						"按官方场景表的 pluginType 列过滤（族名抄 routes 或场景表本身）。scenes 上最该用的一个：整表按族过滤后约 12 KB。" +
						"只作用于场景行，其余文档不受影响；未标注该列的场景按「未知」保留",
				}),
			),
			event: Type.Optional(Type.String({ description: "按场景表的 triggerEvent 列过滤，用法同 pluginType" })),
			control: Type.Optional(
				Type.String({ description: "按场景表的 controlType 列过滤（F7、分录、附件面板一类），用法同 pluginType" }),
			),
			kind: Type.Optional(
				Type.Union(
					[
						Type.Literal("guide"),
						Type.Literal("scene"),
						Type.Literal("sdk"),
						Type.Literal("api"),
						Type.Literal("all"),
					],
					{
						description:
							"search 只检索这一类：guide 指南 | scene 场景 | sdk 官方 SDK | api 接口文档 | all 全库加本地资料；不给等于 all",
					},
				),
			),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "search 返回条数，1~10，默认 5" })),
			includeDraft: Type.Optional(Type.Boolean({ description: "把 status=draft 的场景也算进来；默认过滤掉" })),
		}),
		async execute(args, call) {
			const request: KnowledgeRequest = { action: args.action };
			if (args.query !== undefined) request.query = args.query;
			if (args.pluginType !== undefined) request.pluginType = args.pluginType;
			if (args.event !== undefined) request.event = args.event;
			if (args.control !== undefined) request.control = args.control;
			if (args.kind !== undefined) request.kind = args.kind;
			if (args.limit !== undefined) request.limit = args.limit;
			if (args.includeDraft !== undefined) request.includeDraft = args.includeDraft;
			if (args.scenes !== undefined) request.scenes = args.scenes;
			let handle: ProjectHandle | undefined;
			let root: string | null = call.session.project?.root ?? null;
			if (NEEDS_PROJECT.has(args.action)) {
				// 打不开工程不算这次查询失败：只有 plugin 离不开工程，内核会自己说。
				try {
					const project = await host.project(call, args);
					handle = project.handle;
					root = project.root;
				} catch {
					handle = undefined;
				}
			}
			const report = host.unwrap(call, await host.kernel.knowledge(request, root, handle), args);
			host.succeeded(call);
			return renderSuccess(call.session, call.tool, budgetShowAnswer(budgetApiAnswer(report)));
		},
	};
}
