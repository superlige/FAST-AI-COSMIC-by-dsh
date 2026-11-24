/**
 * 「同一个失败最多两次」：同一工具、同一操作连续两次以同一错误码失败，第三次在执行前被拒。
 *
 * 门槛管的是「同样的调用、同样的失败、什么都没学到」。三种情况不算重复，计数从头来：
 *   - 拒绝本身给了答案的错误码（参数不对、入参缺、断言没过……），换了参数再来是在用这个答案；
 *   - 源码动过（本会话编辑过文件、编译过），同样的参数说的是不同的东西；
 *   - 同一轮并排发出的几次调用一起失败，后一次发出时还不知道前一次的结果。
 * 任何一次成功都清空它：世界动了，下一次就不是同一次尝试。
 */

import { createHash } from "node:crypto";

/** 连续几次相同失败之后，下一次被拒。两次：第一次失败常常正是告诉你该改什么的那一次。 */
export const REPEAT_REFUSE_AT = 2;

export const REPEATED_FAILURE_CODE = "COSMIC_REPEATED_FAILURE";

export interface FailureStreak {
	tool: string;
	code: string;
	/** 失败的是工具里的哪个操作：探针名、run/meta 的子命令和目标。两个不同探针失败不是一个循环。 */
	subject: string;
	/** 最近一次失败的入参摘要。 */
	digest: string;
	/** 连续失败的入参是不是一直一样。 */
	sameInput: boolean;
	/** 计数时的源码版本：之后编辑过、编译过，就不是同一次尝试了。 */
	facts: number;
	count: number;
	firstAt: string;
	lastAt: string;
}

/** 拒绝信息本身就是答案的错误码：换了参数再来不算重复。 */
export function isArgsContractCode(code: string | undefined): boolean {
	return (
		code?.endsWith("_ARGS_INVALID") === true ||
		code === "PROBE_INPUT_MISSING" ||
		code?.endsWith("_INPUT_INVALID") === true ||
		code === "RUN_ASSERT_FAILED" ||
		code === "COSMIC_WRITE_REPORT_INVALID" ||
		code === "KNOWLEDGE_QUERY_INVALID" ||
		// 生产库按语句报的错（类型不匹配、方言不认、列名不对）和语句闸拒掉的原因：报错本身就是改法，
		// 改了语句是照着改。按同一个错误码数，一次 varchar 比 bigint、一次 openGauss 不认 FILTER，
		// 就会把第三条已经改对的语句拒掉。
		code === "PROD_SQL_FAILED" ||
		code === "PROD_SQL_REFUSED"
	);
}

/** 排序键后的 JSON，同样的入参总是同一个摘要。 */
function canonical(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
	return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

export function inputDigest(value: unknown): string {
	return createHash("sha256").update(canonical(value)).digest("hex").slice(0, 16);
}

/**
 * 门槛眼里「失败的是哪个操作」：探针名；run 和 meta 的子命令加目标；带 action 的工具按 action 分；别的工具不分。
 *
 * 带 action 的工具是一个名字下的几个操作：两次 `sql` 失败说明不了 `meta`、`log` 能不能用，
 * 合在一起数会把只读的 `meta` 也一起锁住。
 */
export function failureSubject(tool: string, input: unknown): string {
	if (typeof input !== "object" || input === null) return "";
	const value = input as Record<string, unknown>;
	if (tool === "cosmic_probe") return typeof value.name === "string" ? value.name.trim() : "";
	if ((tool === "cosmic_run" || tool === "cosmic_meta") && Array.isArray(value.argv)) {
		return value.argv
			.slice(0, 2)
			.map((arg) => String(arg).trim())
			.join(" ");
	}
	return typeof value.action === "string" ? value.action.trim() : "";
}

export interface StreakInput {
	tool: string;
	ok: boolean;
	at: string;
	code?: string;
	digest?: string;
	subject?: string;
	/** 这次调用发出的时间：比上一次失败早，就是同一轮并排发出的。 */
	startedAt?: string;
}

/** 一次工具结果之后的计数。 */
export function nextFailureStreak(
	previous: FailureStreak | undefined,
	input: StreakInput,
	facts: number,
): FailureStreak | undefined {
	if (input.ok || input.code === undefined) return undefined;
	const digest = input.digest ?? "";
	const subject = input.subject ?? "";
	const restart: FailureStreak = {
		tool: input.tool,
		code: input.code,
		subject,
		digest,
		sameInput: true,
		facts,
		count: 1,
		firstAt: input.at,
		lastAt: input.at,
	};
	if (
		previous === undefined ||
		previous.tool !== input.tool ||
		previous.code !== input.code ||
		previous.subject !== subject
	)
		return restart;
	if (isArgsContractCode(input.code) && previous.digest !== digest) return restart;
	if (previous.facts !== facts) return restart;
	if (input.startedAt !== undefined && input.startedAt < previous.lastAt) return previous;
	return {
		...previous,
		digest,
		sameInput: previous.sameInput && previous.digest === digest,
		count: previous.count + 1,
		lastAt: input.at,
	};
}

export interface StreakRefusal {
	code: typeof REPEATED_FAILURE_CODE;
	message: string;
	detail: Record<string, unknown>;
	remedy: string;
}

/** 执行前：这次调用要不要因为重复失败被拒。 */
export function streakRefusal(
	streak: FailureStreak | undefined,
	facts: number,
	tool: string,
	input: unknown,
): StreakRefusal | null {
	if (streak === undefined || streak.facts !== facts) return null;
	const digest = inputDigest(input);
	const contract = isArgsContractCode(streak.code);
	if (contract && streak.digest !== digest) return null;
	if (streak.tool !== tool || streak.subject !== failureSubject(tool, input)) return null;
	if (streak.count < REPEAT_REFUSE_AT) return null;
	const same = streak.sameInput && streak.digest === digest;
	// 出口不能是正被拦的这个工具，也不能是「随便查点什么就解锁」的仪式：要说的是什么才算换了一次尝试。
	const exit =
		tool === "cosmic_knowledge"
			? "先按上一次的修复说明纠正输入；原因仍不明，用相关只读探针收集证据后再修正"
			: contract
				? "改了输入或源码再跑不会被拦"
				: tool === "cosmic_prod"
					? "这类失败要用户处理（连 VPN、输入 /cosmic-prod-setup 改配置、输入 /cosmic-monitor-login 登录 monitor），照实告诉用户；用户处理过后计数清零，别的动作不受影响"
					: "改了源码再跑不会被拦；原因还没查清的，先用探针查清（看数据、看元数据）再改";
	return {
		code: REPEATED_FAILURE_CODE,
		message: `同一失败已经重复 ${String(streak.count)} 次（${streak.code}${same ? "，本次输入与上次完全相同" : ""}），这次不再执行`,
		detail: { tool: streak.tool, failureCode: streak.code, count: streak.count, sameInput: same },
		remedy: `先逐行读上一次的失败输出，找出这次到底要改什么，一次只验一个假设；${exit}。`,
	};
}

/**
 * 用户处理过生产那一头（重新配置、登录 monitor）：之前数下的 cosmic_prod 失败不再描述现在的世界。
 * 不清的话，连不上、没登录各失败两次后，用户处理好了，模型也再调不动这个动作。
 */
export function clearedByProdFix(streak: FailureStreak | undefined): FailureStreak | undefined {
	return streak?.tool === "cosmic_prod" ? undefined : streak;
}
