/**
 * cosmic_probe：跑已发布探针，或 `.cosmic-ai/probes/` 下只准读的临时 Java 探针。
 * 写元数据的已发布探针带 APPLY=1 走一次调用写完的流程（`write.ts`）；造数、改数直接落库。
 */

import { Type } from "typebox";
import { REPORT_FIELDS, type ReportInput, writePlanCall } from "../../agent/state/write-report.ts";
import { compareFormulaErrors, formulaErrorsOf } from "../../agent/tools/formula-repeat.ts";
import type { ProbeOutcome } from "../../kernel/commands/probe.ts";
import { releasedLane } from "../../kernel/policy/probe-freshness.ts";
import {
	DATA_WRITERS,
	isAppliedWrite,
	isBlockedWrite,
	isDataWriter,
	isMetadataWriter,
	METADATA_WRITERS,
	seededRows,
	seededRowText,
	updatedRows,
} from "../../kernel/policy/write-plan.ts";
import { prepareRefusal } from "../../kernel/prepare/model.ts";
import type { CosmicToolSpec } from "../define.ts";
import { type CallContext, type CosmicHost, now, pickKeyOf } from "../host.ts";
import { renderSuccess } from "../result.ts";
import { type Confirm, type WriteRun, writeMetadata } from "../write.ts";

export const WRITE_AUTHORIZATION_CODE = "COSMIC_WRITE_AUTHORIZATION";

/**
 * 写入用的 report 参数，cosmic_probe 和 cosmic_meta 结构一样、按同一份校验。
 * 每格的说明只写在 cosmic_probe 上（两个工具每轮都一起发），cosmic_meta 那份只留一句指过去，同一段话不发两遍。
 */
export function reportParam(where: "probe" | "meta" = "probe") {
	const full = where === "probe";
	const say = (description: string) => (full ? { description } : {});
	return Type.Optional(
		Type.Object(
			{
				purpose: Type.String(say(REPORT_FIELDS.purpose)),
				names: Type.Optional(
					Type.Array(Type.Object({ id: Type.String(), name: Type.String() }), say(REPORT_FIELDS.names)),
				),
				slots: Type.Optional(
					Type.Array(Type.Object({ key: Type.String(), text: Type.String() }), say(REPORT_FIELDS.slots)),
				),
				note: Type.Optional(Type.String(say(REPORT_FIELDS.note))),
				decisions: Type.Optional(
					Type.Array(
						Type.Object({
							chose: Type.String(say(REPORT_FIELDS.chose)),
							other: Type.String(say(REPORT_FIELDS.other)),
						}),
						say(REPORT_FIELDS.decisions),
					),
				),
			},
			{
				description: full
					? REPORT_FIELDS.report
					: "写动作 apply=true 时必填；每格怎么填和 cosmic_probe 的 report 一样",
			},
		),
	);
}

/** 探针、run、meta 共用的 `raw`：布尔和字符串并列（严格模式的供应商不接受含对象的联合）。 */
export function rawParam() {
	return Type.Optional(
		Type.Unsafe<boolean | string>({
			type: ["boolean", "string"],
			description: "上次同参数运行的日志；跑过不重跑；true 给完整日志；行号或关键字只回这些行",
		}),
	);
}

/** 失败计数用的错误码：探针拒了自己的入参（IllegalArgumentException）是在告诉你该改什么，换了入参再来不算重复。 */
export function probeFailureCode(prefix: string, exitCode: number, output: string | undefined): string {
	return output?.includes("[PROBE-ERR] java.lang.IllegalArgumentException") === true
		? `${prefix}_INPUT_INVALID`
		: `${prefix}_EXIT_${String(exitCode)}`;
}

export interface ProbeArgs {
	name: string;
	positional?: string[];
	env?: Record<string, string>;
	cold?: boolean;
	raw?: boolean | string;
	report?: ReportInput;
}

function runOf(outcome: ProbeOutcome): WriteRun {
	return {
		exitCode: outcome.exitCode,
		output: outcome.output,
		records: outcome.json.records,
		value: outcome as unknown as Record<string, unknown>,
	};
}

export function probeTool(host: CosmicHost, confirm: Confirm): CosmicToolSpec<ProbeArgs> {
	/** raw 写成行号或关键字、这组参数却还没跑过：不落库的已发布探针先跑一次再取。 */
	const canRunBeforePick = (args: ProbeArgs): boolean =>
		!/[\\/.]/.test(args.name) && !isDataWriter(args.name) && args.env?.APPLY === undefined;

	async function execute(args: ProbeArgs, call: CallContext): Promise<string[]> {
		if (typeof args.raw === "string") {
			const { raw, ...rest } = args;
			if (host.hasOutput(call, args) || !canRunBeforePick(args))
				return renderSuccess(call.session, call.tool, host.pick(call, args, raw));
			const ran = await execute(rest, call);
			const along = ranAlong(ran);
			return renderSuccess(call.session, call.tool, host.pick(call, args, raw, along));
		}
		if (args.raw === true) {
			const stored = host.storedFullLog(call, args);
			if (stored !== undefined) return renderSuccess(call.session, call.tool, stored);
		}
		const session = call.session;
		const project = await host.project(call, args);
		const prepared = host.unwrap(
			call,
			await host.kernel.prepareProbe(project.handle, args.name, {
				positional: args.positional ?? [],
				env: args.env ?? {},
				cold: args.cold ?? false,
			}),
			args,
		);
		const target = prepared.plan?.target;
		const overlay = prepared.plan?.overlay ?? args.env ?? {};
		// 临时探针用到的平台类签名说明，只在用得上的时候给：预检拦下了，或者这次没跑成。
		const apiCapsulesLater = target?.adHoc === true && prepared.blockers.length === 0;
		let capsuleText = apiCapsulesLater ? "" : await host.deliverCapsules(call, prepared.capsules);
		if (prepared.blockers.length > 0) {
			throw host.fail(
				call,
				prepareRefusal("PROBE_PRECHECK_FAILED", "探针在启动编译/JVM 前发现阻碍", prepared, {
					api: prepared.plan?.api ?? null,
				}),
				args,
				capsuleText === "" ? [] : [`# Knowledge Capsule\n\n${capsuleText}`],
			);
		}
		const applying = overlay.APPLY === "1";
		const released = target !== undefined && !target.adHoc;
		if (released && releasedLane(target.cls, overlay) === "business")
			await host.requireFresh(call, project.handle, args);
		const metaWriter = released && isMetadataWriter(target.cls);
		const dataWrite = released && isDataWriter(target.cls);
		if (applying && !metaWriter && !dataWrite) {
			throw host.fail(
				call,
				{
					code: WRITE_AUTHORIZATION_CODE,
					message: `${args.name} 不是写探针，APPLY=1 对它没有意义`,
					detail: { probe: args.name },
					remedy:
						`能写元数据的已发布探针只有 ${Object.keys(METADATA_WRITERS).join(" / ")}；` +
						`写数据的只有 ${Object.keys(DATA_WRITERS).join(" / ")}；只读探针去掉 APPLY 再跑。`,
				},
				args,
			);
		}

		if (applying && metaWriter && target !== undefined) {
			const { APPLY: _apply, ...env } = overlay;
			const cold = args.cold ?? false;
			const writeEnv = (extra: Record<string, string>) => ({ positional: [], env: { ...env, ...extra }, cold });
			return writeMetadata(
				host,
				call,
				project.handle,
				{
					probe: target.cls,
					env,
					label: writePlanCall(target.cls, env),
					backupHint: "env 里加 <备份目录入参>=<目录>",
					async preview() {
						// 预演是这次写调用的一部分，不算「同一个问题又问一遍」：见 write.ts 第 2 步。
						const result = await host.kernel.probe(project.handle, target.cls, {
							...writeEnv({}),
							countRepeats: false,
						});
						return result.ok ? runOf(result.value) : result.error.toJSON();
					},
					async apply(writeAuthorization) {
						const result = await host.kernel.probe(project.handle, target.cls, {
							...writeEnv({ APPLY: "1" }),
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

		const result = await host.kernel.probe(project.handle, args.name, {
			positional: args.positional ?? [],
			env: args.env ?? {},
			...(args.name === "EnvDiagProbe" ? { countRepeats: false } : {}),
			...(args.raw === true ? { raw: true } : {}),
			cold: args.cold ?? false,
			preparation: prepared,
		});
		if (!result.ok) {
			if (dataWrite && target !== undefined) {
				session.dataWrites.push({
					at: now(),
					probe: target.cls,
					ok: false,
					created: [],
					changed: [],
					outputFile: null,
				});
				session.save(project.root);
			}
			throw host.fail(call, result.error.toJSON(), args);
		}
		const outcome = result.value;
		// 造数改数：退出码 0 却没打落库行是自己中止了；写之前被门禁拦下退出码非 0，库也没动过。
		const unwritten =
			dataWrite &&
			target !== undefined &&
			((outcome.exitCode === 0 && !isAppliedWrite({ cls: target.cls, exitCode: 0, output: outcome.output })) ||
				isBlockedWrite({ cls: target.cls, output: outcome.output }));
		const ok = outcome.exitCode === 0 && !unwritten;
		if (apiCapsulesLater && !ok) capsuleText = await host.deliverCapsules(call, prepared.capsules);
		const created =
			dataWrite && target?.cls === "DataSeedProbe" ? seededRows(outcome.json.records).map(seededRowText) : [];
		const changed = ok && target?.cls === "DataUpdateProbe" ? updatedRows(outcome.json.records) : [];
		let writeLog: string | null = null;
		if (dataWrite && target !== undefined) {
			writeLog = await host.archive(call, project.handle, outcome.output);
			if (!unwritten) {
				session.dataWrites.push({ at: now(), probe: target.cls, ok, created, changed, outputFile: writeLog });
				session.save(project.root);
			}
		}
		const delivery = dataWrite
			? (ok
					? "已落库（测试环境写数据不用确认）。"
					: unwritten
						? "探针自己中止了，没有落库（原因看上面的输出）。"
						: created.length > 0
							? "操作未全部成功，但回读确认已有数据留在库里。已提交步骤不要重放，失败步骤和未执行步骤见输出。"
							: "操作失败，落库状态待核对；失败退出不代表已回滚，核对前不要重复写入。") +
				(created.length > 0 ? `造出的数据（留在测试环境，不自动清理）：${created.join("、")}。` : "") +
				(changed.length > 0 ? `改掉的数据（原值）：${changed.join("；")}。` : "") +
				(writeLog === null ? "" : `本次写通道输出已存 ${writeLog}。`)
			: undefined;
		const value = host.withProbeUsage(
			session,
			await host.budget(call, project.handle, outcome, pickKeyOf(call.tool, args)),
			true,
		);
		const repeat = compareFormulaErrors(session.formulaErrors, formulaErrorsOf(outcome));
		const shown = {
			...value,
			...(repeat.length === 0 ? {} : { formulaRepeat: repeat }),
			...(capsuleText === "" ? {} : { knowledgeContext: capsuleText }),
			...(delivery === undefined ? {} : { delivery }),
		};
		const blocks = renderSuccess(session, call.tool, shown, { adHocProbe: target?.adHoc === true, ok });
		if (ok) {
			host.succeeded(call);
			return blocks;
		}
		throw host.ranFailed(
			call,
			unwritten ? "COSMIC_WRITE_NOT_APPLIED" : probeFailureCode("PROBE", outcome.exitCode, outcome.output),
			blocks,
			args,
		);
	}

	return {
		name: "cosmic_probe",
		description:
			"运行已发布探针，或运行 .cosmic-ai/probes/ 下的临时 Java 探针（只准读）。" +
			"临时探针编译前，精确 import 和方法、构造调用合成一次对当前 JAR 的批量核对，官方文档说明和真实签名随结果返回；" +
			"类、方法、参数、必填入参、env 和禁止的能力有问题，在编译前一次列全；通配 import 会被拒。\n" +
			'入参是探针源码里 `req("X")` 声明的，给少了在 JVM 起来之前就被拒并附上完整参数说明；' +
			"按要做的事找已发布探针：cosmic_knowledge action=probes query=<要做的事>；看某个探针的全部入参：query=<探针名>。\n" +
			"写元数据的探针带 APPLY=1 并附 report：工具先预演、按预演排出确认单弹给用户，用户确认后落库并回读，一次调用做完。",
		parameters: Type.Object({
			name: Type.String({
				description:
					"已发布探针的类名（不带 .java），或临时探针相对工程根的 .java 路径，如 .cosmic-ai/probes/OneOff.java",
			}),
			positional: Type.Optional(
				Type.Array(Type.String(), {
					description:
						'按探针源码里 req("…") 出现的顺序绑定必填入参，例如 MetaProbe 的第一个位置参数就是 META_ENTITY。顺序拿不准时用 env 按名字给',
				}),
			),
			env: Type.Optional(
				Type.Record(Type.String(), Type.String(), {
					description:
						'按名字给入参，例如 {"META_ENTITY":"demo_bill","META_FILTER":"qty"}；和位置参数重复时以这里为准。可选入参（探针里的 env("X", 默认值)）只能走这里。' +
						"APPLY=1 写元数据（要附 report，用户确认后才落库）；造数据、改数据（DataSeedProbe / DataUpdateProbe）默认直接落库，PREVIEW=1 只预演",
				}),
			),
			cold: Type.Optional(
				Type.Boolean({
					description:
						"强制走冷进程（约 30-40 秒）。默认走常驻 JVM，写元数据也在常驻里写，写完同一进程马上读到新的；" +
						"写元数据时保持默认：冷进程写完，常驻 JVM 要重起一次（约 30 秒）才读得到",
				}),
			),
			raw: rawParam(),
			report: reportParam(),
		}),
		ungated: (args) => typeof args.raw === "string",
		execute,
	};
}

/** 先跑再取时，跑的那一次结果里要跟着取回的几行一起交给模型的部分：交付说明、探针用法、知识卡片。 */
function ranAlong(blocks: readonly string[]): Record<string, unknown> {
	const head = blocks[0];
	if (head === undefined) return {};
	try {
		const parsed = JSON.parse(head) as { result?: Record<string, unknown> };
		const result = parsed.result ?? {};
		const along: Record<string, unknown> = {};
		if (typeof result.delivery === "string") along.delivery = result.delivery;
		if (result.usage !== undefined) along.usage = result.usage;
		const capsule = blocks.find((block) => block.startsWith("# Knowledge Capsule"));
		if (capsule !== undefined) along.knowledgeContext = capsule.replace(/^# Knowledge Capsule\n\n/, "");
		return along;
	} catch {
		return {};
	}
}
