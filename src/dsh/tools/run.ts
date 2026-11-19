/**
 * cosmic_run：免界面跑真实业务逻辑，和界面上点一下一样真提交落库（测试环境）。
 * 问用法（argv 以 help 开头）不开工程、不起进程、不记失败。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { prepareRefusal } from "../../kernel/prepare/model.ts";
import { isRunKind, RUN_KINDS, type RunHelpDocs, renderRunHelp, runHelpCall } from "../../knowledge/run-adapter.ts";
import type { CosmicToolSpec } from "../define.ts";
import { type CosmicHost, now, pickKeyOf } from "../host.ts";
import { renderSuccess } from "../result.ts";
import type { CommittedBill } from "../session.ts";
import { probeFailureCode, rawParam } from "./probe.ts";

/**
 * run 失败记哪个错误码。输入不成立、只是断言没过，输出里已经说清该改什么，
 * 改了再跑是在用这个回答，不能和「同一处失败又来一次」算成一件事。
 */
export function runFailureCode(exitCode: number, records: readonly Record<string, unknown>[], output: string): string {
	if (records.some((record) => record.t === "input-invalid")) return "RUN_INPUT_INVALID";
	if (
		records.some((record) => record.t === "assert" && record.pass === false) &&
		/\[PROBE-ERR\] \S+: 断言失败/.test(output)
	)
		return "RUN_ASSERT_FAILED";
	return probeFailureCode("RUN", exitCode, output);
}

/** 一次运行里过了、没过的断言条数。 */
export function assertCounts(records: readonly Record<string, unknown>[]): { passed: number; failed: number } {
	let passed = 0;
	let failed = 0;
	for (const record of records) {
		if (record.t !== "assert") continue;
		if (record.pass === true) passed += 1;
		else failed += 1;
	}
	return { passed, failed };
}

const text = (value: unknown): string | null =>
	value === null || value === undefined || value === "" ? null : String(value);

/**
 * 一次运行碰到了谁：之后库里的单（`committed`），真执行的操作和表单上挂着的本工程类（`own-plugins`），
 * run call 直接调的那个类（`scenario.class`）。给本会话事实记账用，模型不读这两种记录。
 */
export function runTouches(records: readonly Record<string, unknown>[]): {
	bills: CommittedBill[];
	plugins: string[];
} {
	const bills: CommittedBill[] = [];
	const plugins = new Set<string>();
	for (const record of records) {
		if (record.t === "committed" && typeof record.entity === "string" && text(record.pk) !== null)
			bills.push({
				entity: record.entity,
				pk: String(record.pk),
				billno: text(record.billno),
				status: text(record.status),
				created: typeof record.created === "boolean" ? record.created : null,
				what: text(record.what) ?? "",
			});
		if (record.t === "own-plugins" && Array.isArray(record.classes))
			for (const cls of record.classes) if (typeof cls === "string") plugins.add(cls);
		if (record.t === "scenario" && record.adapter === "run call" && typeof record.class === "string")
			plugins.add(record.class);
	}
	return { bills, plugins: [...plugins] };
}

interface RunArgs {
	argv: string[];
	raw?: boolean | string;
}

async function helpDocs(docsDir: string | undefined): Promise<RunHelpDocs> {
	if (docsDir === undefined) return { run: null, parentChild: null };
	const page = (name: string) => readFile(join(docsDir, name, "SKILL.md"), "utf8").catch(() => null);
	return { run: await page("cosmic-run"), parentChild: await page("cosmic-run-parent-child") };
}

export async function runHelpText(kind: string | undefined, docsDir: string | undefined): Promise<string> {
	const docs = await helpDocs(docsDir);
	if (kind !== undefined && !isRunKind(kind))
		return `没有子命令「${kind}」，只有 ${RUN_KINDS.join(" / ")}。\n\n${renderRunHelp(undefined, docs)}`;
	return renderRunHelp(kind, docs);
}

export function runTool(host: CosmicHost): CosmicToolSpec<RunArgs> {
	return {
		name: "cosmic_run",
		description:
			"免界面跑真实业务逻辑，和界面上点一下一样真提交落库（连的是测试环境）：改过、新建的单留在库里，插件链上发消息、调接口照常执行。\n" +
			"十种子命令：op 跑一次操作；form 起真 FormView 让插件真的跑；list 起真 ListView；callback 验父子回调；flow 验父子流程；" +
			"rule 只算规则层（不建 View、不装插件）；print 验打印插件；call 直接调本工程类的方法；push 按 BOTP 规则下推（目标单保存后从数据库回读）；" +
			"wf 按已发布流程拼上下文直调工作流插件（流程不真跑）。\n" +
			"--expect 是断言，--show 只打值。带 --expect 且全过的运行才算验过；只有 --show 的运行只算「跑起来了」。改前看现状用 --show。\n" +
			`每个子命令认哪些参数、字段路径和值怎么写、能照抄的例子：${runHelpCall("form")}（form 换成要用的子命令；只写 ["help"] 是总览和通用写法），当场返回，不开工程、不起进程。`,
		parameters: Type.Object({
			argv: Type.Array(Type.String(), {
				minItems: 1,
				description:
					'例如 ["op","demo_bill","save","--set","amount=1","--expect","success=true"]；' +
					'表单上点按钮 ["form","demo_bill","--pk","100001","--op","cal","--expect","demo_entry[0].qty=2"]；' +
					'分录/子分录 ["form","demo_bill","--set","demo_entry[0].demo_sub[1].qty=2","--expect","demo_entry[0].demo_sub[1].qty=2"]；' +
					'界面规则 ["rule","form","demo_bill","--set","demo_type=A","--show","demo_panelap"]；' +
					"run op 可以用 --case <标签> 分段，一次跑多个场景；" +
					'问用法写 ["help"] 或 ["help","form"]',
			}),
			raw: rawParam(),
		}),
		ungated: (args) => typeof args.raw === "string" || args.argv?.[0] === "help",
		async execute(args, call) {
			const session = call.session;
			if (typeof args.raw === "string") return renderSuccess(session, call.tool, host.pick(call, args, args.raw));
			if (args.raw === true) {
				const stored = host.storedFullLog(call, args);
				if (stored !== undefined) return renderSuccess(session, call.tool, stored);
			}
			if (args.argv[0] === "help")
				return renderSuccess(session, call.tool, {
					action: "help",
					text: await runHelpText(args.argv[1], host.referenceDocsDir),
				});
			const project = await host.project(call, args);
			const prepared = host.unwrap(call, await host.kernel.prepareRun(project.handle, args.argv), args);
			const capsuleText = await host.deliverCapsules(call, prepared.capsules);
			if (prepared.blockers.length > 0)
				throw host.fail(
					call,
					prepareRefusal("RUN_PRECHECK_FAILED", "run 在编译新鲜度检查和 JVM 之前发现阻碍", prepared, {
						...(capsuleText === "" ? {} : { knowledgeContext: capsuleText }),
					}),
					args,
				);
			// 每次 run 都加载业务类：编译之后改过、没再编译的 Java 先拦下。
			await host.requireFresh(call, project.handle, args);
			const result = host.unwrap(
				call,
				await host.kernel.run(project.handle, args.argv, {
					...(args.raw === true ? { raw: true } : {}),
					preparation: prepared,
				}),
				args,
			);
			const ok = result.exitCode === 0;
			const counts = assertCounts(result.json.records);
			const touched = runTouches(result.json.records);
			session.runs.push({
				at: now(),
				argv: [...args.argv],
				kind: result.kind,
				target: result.target,
				exitCode: result.exitCode,
				passed: counts.passed,
				failed: counts.failed,
				outputFile: result.outputFile ?? null,
				bills: touched.bills,
				plugins: touched.plugins,
			});
			session.save(project.root);
			// run 不带探针用法卡片：适配器的 env 是内核按 argv 组出来的，告诉调用方等于指一扇它不该自己推的门。
			const value = host.withProbeUsage(
				session,
				await host.budget(call, project.handle, result, pickKeyOf(call.tool, args)),
				false,
			);
			const blocks = renderSuccess(
				session,
				call.tool,
				capsuleText === "" ? value : { ...value, knowledgeContext: capsuleText },
				{ ok },
			);
			if (ok) {
				host.succeeded(call);
				return blocks;
			}
			throw host.ranFailed(call, runFailureCode(result.exitCode, result.json.records, result.output), blocks, args);
		},
	};
}
