/**
 * 写元数据：一次调用走完「预演 → 确认单 → 用户确认 → 落库 → 回读」。
 *
 * 模型发一次写调用（写探针 APPLY=1，或 cosmic_meta 写动作 apply=true），顺手交确认单上的人话（report）。
 * 这里依次：
 *   1. 查前提：要备份目录的给了、不在 build/ 下；本会话改过的 Java 已经编译新鲜。不满足直接拒，什么都没跑。
 *   2. 用同一组参数去掉 APPLY 预演一次。没跑通、没算出要写什么，原样返回预演输出，不弹确认。
 *   3. 由预演的入参和探针记录生成确认单表单，核对 report 的格子。对不上返回照着填的模板，不弹确认。
 *   4. 弹确认单，等用户点。界面弹不了（命令行无人值守）就拒，什么都不写；用户点「不写」就不写。
 *   5. 带着这次确认的写入范围、撤回办法、确认编号（改数据、打印模板还有改前快照）落库。
 *      内核的写入门槛（IsvGuard）只放行确认单上的对象。
 *   6. 写探针自己回读核对，回读结果和这次写入的记录一起交回。
 *
 * 没有「先拿授权、再执行」的两步：确认和落库是同一次调用，确认单上的就是落库的。
 * 门槛不接受任何参数级的旁路：没有用户点确认，这里不会走到落库那一步。
 */

import { randomUUID } from "node:crypto";
import {
	checkReport,
	confirmationCard,
	confirmationDetail,
	type ReportInput,
	renderForm,
	type WritePlan,
	writePlanCall,
} from "../agent/state/write-report.ts";
import { appliedRecordsView, withModelView } from "../agent/tools/model-view.ts";
import { buildWriteForm } from "../kernel/policy/write-form.ts";
import {
	dataBaseline,
	declaredTargets,
	deniedTargets,
	isAppliedWrite,
	isBlockedWrite,
	isPlannedDryRun,
	isStaleBaseline,
	requiredTargets,
	writePlanDigest,
	writerKind,
} from "../kernel/policy/write-plan.ts";
import type { ProbeJsonRecord } from "../kernel/probe/output.ts";
import type { CallContext, CosmicHost } from "./host.ts";
import { now } from "./host.ts";
import type { ProjectHandle } from "./kernel.ts";
import { type AgentFailure, renderSuccess } from "./result.ts";
import type { MetaWriteFact } from "./session.ts";

export const WRITE_REPORT_INVALID_CODE = "COSMIC_WRITE_REPORT_INVALID";
export const WRITE_JAVA_STALE_CODE = "COSMIC_WRITE_JAVA_STALE";
export const WRITE_NOT_PLANNED_CODE = "COSMIC_WRITE_NOT_PLANNED";
export const WRITE_CONFIRM_UNAVAILABLE_CODE = "COSMIC_WRITE_CONFIRM_UNAVAILABLE";
export const WRITE_NOT_APPLIED_CODE = "COSMIC_WRITE_NOT_APPLIED";
export const WRITE_FAILED_CODE = "COSMIC_WRITE_FAILED";

/** 一次运行的结果里写流程要看的那几样。 */
export interface WriteRun {
	exitCode: number;
	output: string;
	records: readonly ProbeJsonRecord[];
	/** 交给模型的整份结果（探针结果或 meta 报告）。 */
	value: Record<string, unknown>;
}

/** 写元数据的两扇门（直接调写探针、cosmic_meta 写动作）各自怎么预演、怎么落库。 */
export interface WriteDoor {
	probe: string;
	/** 去掉 APPLY 的入参：预演和落库用的是同一组。 */
	env: Readonly<Record<string, string>>;
	/** 怎么调的，给人看。 */
	label: string;
	preview(): Promise<WriteRun | AgentFailure>;
	apply(authorization: {
		targets: string[];
		rollback: string;
		confirmationId: string;
		baseline?: string;
	}): Promise<WriteRun | AgentFailure>;
}

/** 用户的回答：确认、不写（可能附了一句话）、或者这个界面弹不了。 */
export type ConfirmAnswer =
	| { kind: "approved" }
	| { kind: "declined"; note?: string }
	| { kind: "unavailable"; reason: string };

export type Confirm = (
	call: CallContext,
	question: { header: string; question: string; detail: string },
) => Promise<ConfirmAnswer>;

function isFailure(value: WriteRun | AgentFailure): value is AgentFailure {
	return typeof (value as AgentFailure).code === "string" && typeof (value as WriteRun).exitCode !== "number";
}

/** 预演或落库的输出交给模型时的样子：和直接跑探针一样裁、一样排。 */
async function shown(
	host: CosmicHost,
	call: CallContext,
	handle: ProjectHandle,
	run: WriteRun,
	extra: Record<string, unknown>,
) {
	const budgeted = await host.budget(call, handle, run.value);
	return renderSuccess(call.session, call.tool, { ...(budgeted as object), ...extra }, { ok: false });
}

export async function writeMetadata(
	host: CosmicHost,
	call: CallContext,
	handle: ProjectHandle,
	door: WriteDoor,
	report: ReportInput | undefined,
	confirm: Confirm,
	input: unknown,
): Promise<string[]> {
	const session = call.session;
	const root = session.project?.root ?? "";

	// 1. 前提：本会话改过的 Java 编译新鲜。改前备份不用调用方给：落库时工具自己存进 evidence/backups/。
	const java = host.sessionJava(session);
	if (java.length > 0) {
		const current = host.unwrap(call, await host.kernel.freshness(handle), input);
		const mine = host.splitStale(session, current.staleFiles).mine;
		if (mine.length > 0) {
			throw host.fail(
				call,
				{
					code: WRITE_JAVA_STALE_CODE,
					message: `本会话改过的 ${String(mine.length)} 个 Java 还没编译新鲜，先编译再写共享环境`,
					detail: { stale: mine },
					remedy: "先 cosmic_fast 把这几个文件编译通过，再发同一个写调用。",
				},
				input,
			);
		}
	}

	// 2. 预演。两扇门的预演都不记「同一个问题问过几遍」的账，也不受它拦：
	// 确认单要按现状算（改前快照要新鲜），而且模型先单独预演过、再发写调用、report 没填对再发一次，
	// 预演输出本来就一字不差——记账的话第三次就被当成重复提问拒掉，补好的确认单永远弹不出来。
	const preview = await door.preview();
	if (isFailure(preview)) throw host.fail(call, preview, input);
	const planned = isPlannedDryRun({
		cls: door.probe,
		adHoc: false,
		env: door.env,
		exitCode: preview.exitCode,
		output: preview.output,
	});
	if (!planned) {
		const blocks = await shown(host, call, handle, preview, {
			delivery: "预演没有算出要写的内容（没跑通、或者没有要改的），没有弹确认、什么都没写。原因看上面的输出。",
		});
		throw host.ranFailed(call, WRITE_NOT_PLANNED_CODE, blocks, input);
	}

	// 3. 确认单。
	const targets = [...new Set([...requiredTargets(door.probe, door.env), ...declaredTargets(preview.output)])];
	const baseline = dataBaseline(preview.output);
	const plan: WritePlan = {
		probe: door.probe,
		kind: writerKind(door.probe) ?? door.probe,
		digest: writePlanDigest(door.probe, door.env),
		call: door.label,
		targets,
		form: buildWriteForm({ probe: door.probe, env: door.env, records: preview.records, targets }),
		...(baseline === undefined ? {} : { baseline }),
	};
	const checked = checkReport(plan, report);
	if (!checked.ok) {
		const blocks = await shown(host, call, handle, preview, {});
		throw host.fail(
			call,
			{
				code: WRITE_REPORT_INVALID_CODE,
				message: checked.message,
				detail: { probe: door.probe },
				remedy: checked.remedy,
			},
			input,
			[`# 预演结果（没有弹确认、什么都没写）\n\n${blocks.join("\n\n")}`],
		);
	}
	const change = checked.change;
	const card = confirmationCard(change);

	// 4. 用户确认。
	const answer = await confirm(call, {
		header: "写元数据",
		question: `确认把这项${plan.kind}写进测试环境吗？`,
		detail: confirmationDetail(change),
	});
	const fact = {
		at: now(),
		probe: door.probe,
		kind: plan.kind,
		object: change.object,
		purpose: change.fill.purpose,
		undo: plan.form.undo,
		backup: null as string | null,
		outputFile: null as string | null,
		// 完成情况按对象列「改前→改后」，取的就是用户确认的这张表。
		form: renderForm(plan.form, change.fill, 100).join("\n"),
	};
	const record = (entry: MetaWriteFact): void => {
		session.metaWrites.push(entry);
		session.save(root === "" ? undefined : root);
	};
	if (answer.kind === "unavailable") {
		record({ ...fact, outcome: "declined" });
		throw host.fail(
			call,
			{
				code: WRITE_CONFIRM_UNAVAILABLE_CODE,
				message: `这里弹不了确认单（${answer.reason}），写元数据必须用户点确认，什么都没写`,
				detail: { probe: door.probe },
				remedy:
					"把下面的确认单原样交给用户，请用户在能弹确认的界面（桌面版或网页版）里做这一步；不依赖这项写入的工作照常做。",
			},
			input,
			[`# 确认单\n\n${card}`],
		);
	}
	if (answer.kind === "declined") {
		record({ ...fact, outcome: "declined" });
		host.succeeded(call);
		return renderSuccess(call.session, call.tool, {
			written: false,
			declined: true,
			object: change.object,
			...(answer.note === undefined || answer.note === "" ? {} : { userSaid: answer.note }),
			delivery: "用户没有确认，什么都没写。按用户的意思改了再发写调用，会重新预演、重新确认。",
		});
	}

	// 5. 落库。
	const applied = await door.apply({
		targets,
		rollback: plan.form.undo,
		confirmationId: `C-${randomUUID().slice(0, 8)}`,
		...(baseline === undefined ? {} : { baseline }),
	});
	if (isFailure(applied)) {
		record({ ...fact, outcome: "failed" });
		throw host.fail(call, applied, input);
	}
	const writeLog = await host.archive(call, handle, applied.output);
	const written = applied.exitCode === 0 && isAppliedWrite({ cls: door.probe, exitCode: 0, output: applied.output });
	const blocked = !written && isBlockedWrite({ cls: door.probe, output: applied.output });
	const stale = blocked && isStaleBaseline(applied.output);
	const outcome = written ? "written" : applied.exitCode === 0 || blocked ? "not-applied" : "failed";
	record({ ...fact, outcome, outputFile: writeLog, backup: backupOf(applied.value) });
	const archived = writeLog === null ? "" : `本次写通道输出已存 ${writeLog}。`;

	// 6. 回读：写探针自己核对过，逐条改动在确认单上给过，这里只给条数和对不上的。
	// cosmic_meta 的探针结果在 `probe` 下面一层。
	const nested = typeof applied.value.probe === "object" && applied.value.probe !== null;
	const carrier = (nested ? applied.value.probe : applied.value) as Record<string, unknown>;
	const appliedView = appliedRecordsView(carrier.json);
	const viewed = appliedView === null ? carrier : withModelView(carrier, { json: appliedView });
	const value = nested ? { ...applied.value, probe: viewed } : viewed;
	const budgeted = await host.budget(call, handle, value);
	if (written) {
		host.succeeded(call);
		return renderSuccess(call.session, call.tool, {
			...(budgeted as object),
			written: true,
			object: change.object,
			delivery: `用户确认后已写入：${change.object}（${plan.kind}）。撤回办法：${plan.form.undo}。${archived}`,
		});
	}
	const delivery = blocked
		? stale
			? `没有落库：预演之后有人改过这个对象，改前快照对不上。重新发写调用会按现状重新预演、重新确认。${archived}`
			: `没有落库：写入门槛拦下了确认单以外的对象 ${deniedTargets(applied.output).join("、")}。共享环境没动过；看输出找出为什么会碰到它们。${archived}`
		: applied.exitCode === 0
			? `探针自己中止了，没有落库（原因看输出）。${archived}`
			: `写入失败，落库状态待核对：失败退出不代表已回滚，先用只读探针看现状，不要直接重写。${archived}`;
	const blocks = renderSuccess(
		call.session,
		call.tool,
		{ ...(budgeted as object), written: false, delivery },
		{ ok: false },
	);
	throw host.ranFailed(call, outcome === "failed" ? WRITE_FAILED_CODE : WRITE_NOT_APPLIED_CODE, blocks, input);
}

/** 落库时工具定的备份目录（探针结果的 `placed` 里 role 是 backup 的那一项；cosmic_meta 的在 `probe` 下面一层）。 */
function backupOf(value: Record<string, unknown>): string | null {
	const carrier = (typeof value.probe === "object" && value.probe !== null ? value.probe : value) as {
		placed?: { role?: string; path?: string }[];
	};
	return carrier.placed?.find((one) => one.role === "backup")?.path ?? null;
}

export { writePlanCall };
