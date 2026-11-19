/**
 * cosmic_prod：生产只读排障，只挂在排障会话里。
 * 每个成功的 sql / meta / log 结果开头标一个证据编号；report 只认这些编号。
 */

import { Type } from "typebox";
import { withEvidence } from "../../agent/state/prod-state.ts";
import { PROD_ACTIONS, type ProdRequest } from "../../kernel/commands/prod.ts";
import type { CosmicToolSpec } from "../define.ts";
import { type CallContext, type CosmicHost, now } from "../host.ts";
import { type AskCode, ensureMonitorLogin } from "../monitor-login.ts";
import { ensureProdConfig } from "../prod-setup.ts";
import { renderSuccess } from "../result.ts";

interface ProdArgs {
	action: (typeof PROD_ACTIONS)[number] | "report";
	sql?: string;
	number?: string;
	compare?: boolean;
	billno?: string;
	traceId?: string;
	formId?: string;
	opKey?: string;
	className?: string;
	userName?: string;
	level?: string;
	keyword?: string;
	from?: string;
	to?: string;
	minutes?: number;
	size?: number;
	title?: string;
	findings?: { text: string; evidence?: string[] }[];
	next?: string;
}

const LOG_FILTER_KEYS = [
	"traceId",
	"formId",
	"opKey",
	"className",
	"userName",
	"level",
	"keyword",
	"from",
	"to",
	"minutes",
	"size",
] as const;

/** 工具执行中问人一段文字（monitor 验证码）；没给就是这个宿主弹不了。 */
export type AskInCall = (call: CallContext) => AskCode;

export function prodTool(host: CosmicHost, askInCall?: AskInCall): CosmicToolSpec<ProdArgs> {
	return {
		name: "cosmic_prod",
		description:
			"生产只读排障。status 连接、各分区能查多少表、monitor 登录、生产代码版本；" +
			"sql 一条只读查询（select/with，限时限行，全文落盘，报每张表在哪个分区）；" +
			"meta 一张单在生产上的设计元数据：继承链和扩展合并后的表、字段→列、操作插件、表单插件，compare=true 再和测试环境逐项比；" +
			"log 查 monitor 日志（只留 7 天），同一个错合成一组，本工程调用行对到本地源码：" +
			"没有 traceId 时给 number+billno，工具从操作记录取这张单每次操作的人和时刻，在 monitor 里认出各是哪个请求（traceId、报错、经过的本工程类），再按单号搜日志正文；" +
			"否则按 traceId/userName/formId/opKey/className/level/keyword/时间段查；" +
			"report 出诊断报告，findings 每条带 evidence（结果开头的 E 编号），不带的标成推断。",
		parameters: Type.Object({
			action: Type.Union([...PROD_ACTIONS, "report"].map((action) => Type.Literal(action))),
			sql: Type.Optional(Type.String({ description: "action=sql：一条 select / with 查询；表名不用带分区前缀" })),
			number: Type.Optional(
				Type.String({ description: "action=meta，或 log 带 billno 时：单据、基础资料或布局的标识" }),
			),
			compare: Type.Optional(Type.Boolean({ description: "action=meta：再取测试环境同一张单逐项比" })),
			billno: Type.Optional(Type.String({ description: "action=log：单据编号，和 number 一起给" })),
			traceId: Type.Optional(Type.String({ description: "不给时间就查整个保留期" })),
			formId: Type.Optional(
				Type.String({ description: "精确匹配的页面标识：布局标识、列表 bos_list-<单据>、审批页 WF_…" }),
			),
			opKey: Type.Optional(
				Type.String({ description: "精确匹配，写全「控件[按钮, 操作]」，如 tbmain[bar_submit, submit]" }),
			),
			className: Type.Optional(Type.String({ description: "记日志的类（全限定名）" })),
			userName: Type.Optional(Type.String({ description: "操作人姓名，和操作记录里的一样" })),
			level: Type.Optional(Type.String({ description: "ERROR / WARN / INFO，不给就全要" })),
			keyword: Type.Optional(Type.String({ description: "正文关键字，如报错里的一句话、单据编号" })),
			from: Type.Optional(Type.String({ description: "开始时间（ISO，如 2026-11-11T08:00:00+08:00）" })),
			to: Type.Optional(Type.String({ description: "结束时间，不给就是现在" })),
			minutes: Type.Optional(Type.Number({ description: "不给 from 时往回查多少分钟，默认 60" })),
			size: Type.Optional(Type.Number({ description: "最多取多少条，默认 200，上限 5000" })),
			title: Type.Optional(Type.String({ description: "action=report：一句话说现象" })),
			findings: Type.Optional(
				Type.Array(
					Type.Object({
						text: Type.String({ description: "一条结论：查到了什么、原因是什么" }),
						evidence: Type.Optional(Type.Array(Type.String(), { description: "引用的证据编号，如 E1" })),
					}),
					{ description: "action=report：结论，每条带证据编号" },
				),
			),
			next: Type.Optional(Type.String({ description: "action=report：建议怎么修、还要查什么" })),
		}),
		async execute(args, call) {
			const kernel = host.kernel;
			const session = call.session;
			if (kernel.prod === undefined || kernel.prodReport === undefined)
				throw host.fail(
					call,
					{ code: "PROD_UNSUPPORTED", message: "这个宿主不支持生产排障", detail: {}, remedy: "" },
					args,
				);
			const project = await host.project(call, args);
			if (args.action === "report") {
				const written = host.unwrap(
					call,
					kernel.prodReport(
						project.handle,
						{
							title: args.title ?? "",
							findings: (args.findings ?? []).map((f) => ({ text: f.text, evidence: f.evidence ?? [] })),
							...(args.next === undefined ? {} : { next: args.next }),
						},
						session.prod.evidence,
					),
					args,
				);
				session.prod = { ...session.prod, lastReport: written.file };
				host.succeeded(call);
				return renderSuccess(session, call.tool, {
					text:
						`诊断报告已存：${written.file}（结论 ${String(written.proven + written.inferred)} 条：有证据 ${String(written.proven)}，推断 ${String(written.inferred)}）。\n\n` +
						written.text,
				});
			}
			const setupAsk = host.askInCall?.(call, "生产排障配置");
			if (setupAsk !== undefined) {
				const prodCheck = kernel.prodSetupCheck;
				await ensureProdConfig(
					kernel,
					session.prodSetupPrompt,
					setupAsk,
					prodCheck === undefined ? undefined : (draft, answers) => prodCheck(project.handle, draft, answers),
					call.signal,
				);
			}
			if (askInCall !== undefined)
				await ensureMonitorLogin(
					kernel,
					session.monitorPrompt,
					args.action === "log",
					askInCall(call),
					call.signal,
				);
			const request: ProdRequest = { action: args.action };
			if (args.sql !== undefined) request.sql = args.sql;
			if (args.number !== undefined) request.number = args.number;
			if (args.compare !== undefined) request.compare = args.compare;
			if (args.billno !== undefined) request.billno = args.billno;
			if (args.action === "log")
				request.filter = Object.fromEntries(
					LOG_FILTER_KEYS.map((key) => [key, args[key]] as const).filter(([, v]) => v !== undefined && v !== ""),
				);
			const result = host.unwrap(call, await kernel.prod(project.handle, request), args);
			let text = result.text;
			const evidence = result.evidence;
			if (evidence !== undefined) {
				const recorded = withEvidence(session.prod, { ...evidence, at: now() });
				session.prod = recorded.state;
				text = `证据 ${recorded.id}（${evidence.kind}）：${evidence.summary}\n\n${text}`;
			}
			const report = await host.budget(call, project.handle, { text });
			host.succeeded(call);
			return renderSuccess(session, call.tool, report);
		},
	};
}
