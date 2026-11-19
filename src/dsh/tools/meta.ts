/**
 * cosmic_meta：查 BOTP、打印模板、工作流和公式函数；写动作 apply=true 走一次调用写完的流程（`write.ts`）。
 * argv 给 [] 是用法，不开工程、不起进程、不记失败。
 */

import { Type } from "typebox";
import type { ReportInput } from "../../agent/state/write-report.ts";
import { compareFormulaErrors, formulaErrorsOf } from "../../agent/tools/formula-repeat.ts";
import type { MetaReport } from "../../kernel/commands/meta.ts";
import { META_HELP, metaWritePlan } from "../../kernel/meta/parse.ts";
import type { CosmicToolSpec } from "../define.ts";
import { type CosmicHost, pickKeyOf } from "../host.ts";
import { renderSuccess } from "../result.ts";
import { type Confirm, type WriteRun, writeMetadata } from "../write.ts";
import { probeFailureCode, rawParam, reportParam } from "./probe.ts";

interface MetaArgs {
	argv: string[];
	apply?: boolean;
	cold?: boolean;
	raw?: boolean | string;
	report?: ReportInput;
}

function runOf(report: MetaReport): WriteRun {
	return {
		exitCode: report.probe?.exitCode ?? 0,
		output: report.probe?.output ?? "",
		records: report.probe?.json.records ?? [],
		value: report as unknown as Record<string, unknown>,
	};
}

export function metaTool(host: CosmicHost, confirm: Confirm): CosmicToolSpec<MetaArgs> {
	return {
		name: "cosmic_meta",
		description:
			"查询 BOTP、打印模板、工作流及三类公式函数。公式用 formula print|form|biz，按 --name 精确查或 --q 关键字查；" +
			"不带筛选先看分类，--actions 查规则动作。打印模板编辑走 ptpl dump→edit→apply，提交时校验公式并回读。\n" +
			"写动作 botp restore、ptpl apply/restore 不带 apply 只预演；apply=true 并附 report：工具先预演、按预演排出确认单弹给用户，" +
			"用户确认后落库并回读，一次调用做完。argv 给 [] 看完整用法；参数错误直接给对应动作写法。",
		parameters: Type.Object({
			argv: Type.Array(Type.String(), {
				description: '例如 ["botp","list","--target","demo_po"]；不给参数（[]）就是打印完整用法',
			}),
			apply: Type.Optional(
				Type.Boolean({
					description:
						"只对 botp restore / ptpl apply / ptpl restore 有意义：true 要附 report，用户确认后才落库。不给是预演，演算会改成什么样",
				}),
			),
			cold: Type.Optional(
				Type.Boolean({
					description:
						"强制冷进程。写动作默认在常驻进程里写，写完马上能用只读动作核对；加了它，常驻进程下次要先重起一次",
				}),
			),
			raw: rawParam(),
			report: reportParam("meta"),
		}),
		ungated: (args) => typeof args.raw === "string" || (Array.isArray(args.argv) && args.argv.length === 0),
		async execute(args, call) {
			const session = call.session;
			if (typeof args.raw === "string") return renderSuccess(session, call.tool, host.pick(call, args, args.raw));
			if (args.raw === true) {
				const stored = host.storedFullLog(call, args);
				if (stored !== undefined) return renderSuccess(session, call.tool, stored);
			}
			if (args.argv.length === 0) return renderSuccess(session, call.tool, { action: "help", text: META_HELP });
			const project = await host.project(call, args);
			// 写通道的探针和入参直接从解析器来：和直接调写探针算的是同一份。
			const channel = metaWritePlan(args.argv);
			const cold = args.cold === undefined ? {} : { cold: args.cold };
			if (args.apply === true && channel !== null) {
				return writeMetadata(
					host,
					call,
					project.handle,
					{
						probe: channel.probe,
						env: channel.env,
						label: `cosmic_meta ${args.argv.join(" ")}`,
						backupHint: "argv 里加 --backup <目录>",
						async preview() {
							// 预演是这次写调用的一部分，不算「同一个问题又问一遍」：见 write.ts 第 2 步。
							const result = await host.kernel.meta(project.handle, args.argv, {
								apply: false,
								...cold,
								countRepeats: false,
							});
							return result.ok ? runOf(result.value) : result.error.toJSON();
						},
						async apply(writeAuthorization) {
							const result = await host.kernel.meta(project.handle, args.argv, {
								apply: true,
								...cold,
								writeAuthorization,
							});
							return result.ok ? runOf(result.value) : result.error.toJSON();
						},
					},
					args.report,
					confirm,
					args,
				);
			}
			// 只读动作和写动作的预演：都不落库，平台通道也不加载业务类，不查编译新鲜度。
			const report = host.unwrap(
				call,
				await host.kernel.meta(project.handle, args.argv, {
					apply: false,
					...cold,
					...(args.raw === true ? { raw: true } : {}),
				}),
				args,
			);
			const exitCode = report.probe?.exitCode ?? 0;
			const ok = exitCode === 0;
			const writeLog =
				channel === null ? null : await host.archive(call, project.handle, report.probe?.output ?? "");
			const value = await host.budget(call, project.handle, report, pickKeyOf(call.tool, args));
			const repeat = compareFormulaErrors(session.formulaErrors, formulaErrorsOf(report));
			const shown = {
				...(value as object),
				...(repeat.length === 0 ? {} : { formulaRepeat: repeat }),
				...(channel === null
					? {}
					: {
							delivery:
								"这是预演，没有落库。要落库：同样的 argv 加 apply=true 并附 report（用户确认后才写）。" +
								(writeLog === null ? "" : `预演输出已存 ${writeLog}。`),
						}),
			};
			const blocks = renderSuccess(session, call.tool, shown, { ok });
			if (ok) {
				host.succeeded(call);
				return blocks;
			}
			throw host.ranFailed(call, probeFailureCode("META", exitCode, report.probe?.output), blocks, args);
		},
	};
}
