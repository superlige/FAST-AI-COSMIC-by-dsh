/**
 * user-lookup -- 一个手机号换一个用户 id。
 *
 * 存在的理由只有一条：`user` 是必填项，而**没有人记得自己的苍穹用户 id**。
 * 填错了还完全没有症状 —— 环境照连、元数据照读，只是从此每一次写入的「修改人」
 * 都记在别人头上（见 load-config.ts 里 REQUIRED 对 user 的注释）。所以启动向导
 * 不再要一个人背不出、又验不了的数字，改成问手机号，连一次环境把它换成 id。
 *
 * 这里只做「跑 UserProbe + 读它的 JSON 旁路」这一件事：探针怎么跑（陈旧类闸门、
 * 冷热路径、写入准入）全部是 probe() 那一套，不另开一条路。查询本身只读。
 */

import type { KernelContext } from "../context.ts";
import { err, KernelError, type KernelResult, ok } from "../errors.ts";
import { type ProbeOutcome, probe } from "./probe.ts";

export interface UserCandidate {
	id: string;
	/** 工号（bos_user.number），人员编号 */
	number: string;
	/** 用户名（bos_user.username），登录用的账号；和工号不一定相同 */
	username: string;
	name: string;
	/** 已脱敏。探针两条通道都不出手机号原文，这里也拿不到原文。 */
	phoneMask: string;
}

export interface UserLookupReport {
	keyword: string;
	candidates: UserCandidate[];
	/** 命中数达到探针上限：名单是截断的，让人换个更准的关键字，别从截断名单里挑。 */
	truncated: boolean;
	/** 探针完整输出落盘处，查不到人时看它。 */
	outputFile: string;
}

const PROBE_NAME = "UserProbe";

function text(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

/** 只认结构完整的记录：没有 id 的「用户」不是候选项，是探针的 bug。 */
export function userCandidatesFrom(outcome: ProbeOutcome): UserCandidate[] {
	const candidates: UserCandidate[] = [];
	for (const record of outcome.json.records) {
		if (record.t !== "user") continue;
		const id = text(record, "id");
		if (id === "") continue;
		candidates.push({
			id,
			number: text(record, "number"),
			username: text(record, "username"),
			name: text(record, "name"),
			phoneMask: text(record, "phone_mask"),
		});
	}
	return candidates;
}

function truncatedFrom(outcome: ProbeOutcome): boolean {
	const summary = outcome.json.records.find((record) => record.t === "user-lookup");
	return summary?.truncated === true;
}

/**
 * 关键字模糊匹配手机号 / 用户名 / 姓名，全是数字时也按用户 id 找。空关键字是允许的：探针会列前 20 个可用用户，
 * 那是「这个账套里到底有谁」的答案，比让人对着空列表猜要好。
 */
export async function lookupUsers(
	ctx: KernelContext,
	keyword: string,
	options: { invocation?: string; countRepeats?: boolean } = {},
): Promise<KernelResult<UserLookupReport>> {
	const trimmed = keyword.trim();
	const outcome = await probe(ctx, PROBE_NAME, {
		kernelEnv: true,
		env: { USER_KEY: trimmed },
		invocation: options.invocation ?? "启动向导 · 按手机号查用户",
		...(options.countRepeats === false ? { countRepeats: false } : {}),
	});
	if (!outcome.ok) return err(outcome.error);
	if (outcome.value.exitCode !== 0) {
		return err(
			new KernelError("USER_LOOKUP_FAILED", `查用户失败：${PROBE_NAME} 退出码 ${outcome.value.exitCode}`, {
				detail: { probe: PROBE_NAME, exitCode: outcome.value.exitCode, outputFile: outcome.value.outputFile },
				remedy: `看探针原文 ${outcome.value.outputFile}；连不上环境时可以先直接填用户 id，之后再用 UserProbe 核对。`,
			}),
		);
	}
	return ok({
		keyword: trimmed,
		candidates: userCandidatesFrom(outcome.value),
		truncated: truncatedFrom(outcome.value),
		outputFile: outcome.value.outputFile,
	});
}
