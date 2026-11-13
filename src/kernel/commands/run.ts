/**
 * run -- the headless adapters (S5.2; print since S24).
 *
 * Every one of them is the same shape: turn a request into the environment one
 * released probe reads, then run that probe. What differs is which probe, and
 * whether the run may go through the resident JVM.
 *
 *   op       造单/取单，跑一次操作（真提交）      OpSandbox
 *   form     起一个真 FormView，让插件真的跑      FormSim
 *   list     起一个真 ListView，验过滤/列/交互    ListSim
 *   callback 父子 View 落真实 Redis，子页回调父   FormCallbackSim
 *   flow     父插件真操作产生子页参数，再跑下去   FormFlowSim
 *   rule     不建 View、不装插件，只算规则那层    RuleSim
 *   print    真单据出一次打印，按格子断言最终文字  PrintSim
 *   call     直调本工程类的一个方法，断言返回值    CallSim
 *   push     按一条转换规则下推，目标单保存后回读      PushSim
 *   wf       按流程定义拼上下文，直调工作流插件    WfSim
 *
 * **The frozen implementation wrote its parameters into `process.env` and then
 * called probe.** In a one-process-per-command CLI that is merely ugly; in a
 * resident agent it is a correctness bug -- the assignment outlives the call and
 * the next run inherits `FORM_PK` from the previous one, silently verifying the
 * wrong bill. Here the same values are an overlay value that dies with the call
 * (D9), which is also why two contexts can run side by side in one process.
 *
 * The argv form is kept deliberately. It is what the 28 reference skills
 * document, what a verification record stores verbatim, and what a delivery
 * receipt prints for the reader to re-run; inventing a second parameter shape
 * here would mean none of those three can be read back as what was actually run.
 * Nothing in this argv ever becomes a command line -- it is parsed into named
 * values and the only process that starts is `java` with a fixed argument list.
 */

import { runAdapterKnowledgeCapsule } from "../../knowledge/capsule.ts";
import {
	isRunKind,
	RUN_ADAPTER_CONTRACTS,
	RUN_KINDS,
	RUN_PROBES,
	type RunKind,
	runCommits,
	runFlagLines,
	runHelpCall,
} from "../../knowledge/run-adapter.ts";
import type { KernelContext } from "../context.ts";
import { err, KernelError, type KernelResult, ok } from "../errors.ts";
import { captureFreshnessAsync } from "../freshness.ts";
import {
	type MustInputFacts,
	missingMustInput,
	mustInputText,
	parseMustInput,
	readMustInput,
	writeMustInput,
} from "../meta/must-input.ts";
import { callReach, locateCallClass, nearNames, parseCallTarget, viaText } from "../policy/call-reach.ts";
import { effectSiteWhere, externalEffectSites, UI_ONLY_SITES } from "../policy/external-effects.ts";
import { emptyPrepare, FREE, type PrepareBlocker, type PrepareResult, prepareKernelError } from "../prepare/model.ts";
import { forgetRepeats } from "../probe/repeat.ts";
import {
	type AssertionEvidence,
	evidenceFrom,
	PUSH_READBACK_REQUIRED,
	readEvidence,
	unconfirmedPush,
	writeEvidence,
	writtenTablesOf,
} from "../verify/evidence.ts";
import type { FastHooks } from "./fast.ts";
import { formPluginSites, projectPackagePrefixes } from "./impact.ts";
import { MUST_INPUT_PROBE } from "./internal-probes.ts";
import { type ProbeOutcome, type ProbeProgressStage, probe } from "./probe.ts";
import { lookupUsers, type UserCandidate } from "./user-lookup.ts";

export type { RunKind } from "../../knowledge/run-adapter.ts";
export { RUN_KINDS, RUN_PROBES } from "../../knowledge/run-adapter.ts";

const RULE_SCENES = ["all", "init", "new", "edit", "view", "submit", "audit"];
const RULE_BRANCHES = ["hide-wins", "both", "true-only"];
const RULE_LISTS = ["visible", "hidden", "all"];
const FORM_STATUSES = ["new", "edit", "view"];

/** Flags that take a value. Everything else with `--` is refused, never ignored. */
const VALUE_FLAGS = [
	"--host",
	"--row",
	"--scene",
	"--list",
	"--branch",
	"--pk",
	"--billno",
	"--op",
	"--click",
	"--skip",
	"--calls",
	"--f7",
	"--main-org",
	"--limit",
	"--select",
	"--row-click",
	"--row-double-click",
	"--hyperlink",
	"--callback",
	"--tree-node",
	"--tree-toolbar",
	"--parent-entry",
	"--child-op",
	"--child-click",
	"--toolbar",
	"--child",
	"--args",
	"--node",
	"--status",
	"--user",
];

/** Buckets that collect a repeatable parameter, in the name `--x` uses. */
const LIST_FLAGS = ["--set", "--child-set", "--expect", "--cache", "--show", "--filter", "--ctx"];
/** Flags that are their own value. */
const BOOL_FLAGS = ["--events", "--summary", "--mobile", "--real-cache", "--schedule", "--raw"];
/** Everything `run` accepts anywhere, for the "you misspelled it" message. */
export const KNOWN_FLAGS = [...LIST_FLAGS, ...BOOL_FLAGS, ...VALUE_FLAGS, "--case"].sort();

/**
 * Which parameters each kind actually reads.
 *
 * Everything else was **parsed and then dropped**: `run op … --show amount`
 * produced no `OP_SHOW`, printed nothing and exited 0, which reads exactly like
 * "the field was printed and looked fine". Same for `--cache` outside form/list
 * and `--child-set` outside callback/flow. The kinds do not share a parameter
 * set, so "the flag exists" is not the question worth answering -- "this kind
 * reads it" is.
 */
const ACCEPTED: Record<RunKind, readonly string[]> = Object.fromEntries(
	RUN_KINDS.map((kind) => [kind, RUN_ADAPTER_CONTRACTS[kind].accepted]),
) as Record<RunKind, readonly string[]>;

/** One line per kind: what it is for, so the refusal can say what to write instead. */
const KIND_HINT: Record<RunKind, string> = Object.fromEntries(
	RUN_KINDS.map((kind) => [kind, RUN_ADAPTER_CONTRACTS[kind].hint]),
) as Record<RunKind, string>;

/** The parameter names one segment actually carries, in `--x` form minus the dashes. */
function parameterNames(parsed: ParsedRunArgs): string[] {
	const names: string[] = [];
	if (parsed.sets.length > 0) names.push("set");
	if (parsed.childSets.length > 0) names.push("child-set");
	if (parsed.expects.length > 0) names.push("expect");
	if (parsed.caches.length > 0) names.push("cache");
	if (parsed.shows.length > 0) names.push("show");
	if (parsed.filters.length > 0) names.push("filter");
	if (parsed.ctxs.length > 0) names.push("ctx");
	names.push(...Object.keys(parsed.flags));
	return names;
}

/**
 * Refuses a parameter this kind does not read. Same rule as the unknown flag
 * above -- a dropped parameter is "I verified with that setting" when nothing of
 * the sort happened -- and it names the kinds that DO read it, because the
 * parameter is usually right and the subcommand wrong.
 */
function checkAcceptedAll(kind: RunKind, parsed: ParsedRunArgs): KernelError[] {
	const accepted = ACCEPTED[kind];
	const errors: KernelError[] = [];
	for (const name of parameterNames(parsed)) {
		if (accepted.includes(name)) continue;
		const others = RUN_KINDS.filter((other) => ACCEPTED[other].includes(name));
		errors.push(
			invalid(
				`run ${kind} 不读 --${name}`,
				`${others.length > 0 ? `--${name} 只有 ${others.map((other) => `run ${other}`).join(" / ")} 会读。` : ""}` +
					`${KIND_HINT[kind]} 这里能用的参数：\n${runFlagLines(kind).join("\n")}`,
				{ kind, flag: `--${name}`, readBy: others },
			),
		);
	}
	return errors;
}

function checkAccepted(kind: RunKind, parsed: ParsedRunArgs): KernelError | null {
	return checkAcceptedAll(kind, parsed)[0] ?? null;
}

/**
 * `run form --select` 的形状：`分录标识=行号,行号`，多个分录用 `;` 隔开。
 *
 * 空的等号右边是合法且有意义的（`分录标识=` 就是「这个分录一行没选」，验的正是
 * 「请先选择…」那条分支），所以这里只拦形状不对的：没有等号的裸值，和不是行号的值。
 */
/** flow 的父动作给了哪几个。必须正好一个：给两个就说不清这次驱动的是哪条链路。 */
function parentActions(flags: Readonly<Record<string, string | undefined>>): string[] {
	return ["click", "op", "hyperlink"].filter((key) => flags[key] !== undefined);
}

/**
 * form 的点超链接和按钮、操作不一起给：探针一次只触发一个动作，一起给时有一个不会跑，
 * 输出里也只剩跑了的那一个。按钮和操作可以一起给（`--op` 是按钮绑的操作没登记时的兜底）。
 */
function formActionError(flags: Readonly<Record<string, string | undefined>>): KernelError | null {
	if (flags.hyperlink === undefined || (flags.click === undefined && flags.op === undefined)) return null;
	return invalid(
		"run form 的 --hyperlink 和 --click / --op 只给一个",
		"一次只跑一个动作；要验点超链接就去掉 --click / --op，要验按钮就去掉 --hyperlink。",
		{ hyperlink: flags.hyperlink, click: flags.click ?? null, op: flags.op ?? null },
	);
}

function checkFormSelect(spec: string): KernelError | null {
	for (const one of spec.split(";")) {
		const piece = one.trim();
		if (piece === "") continue;
		const eq = piece.indexOf("=");
		const rows = eq < 0 ? piece : piece.slice(eq + 1).trim();
		const bad =
			eq < 0 ||
			(rows !== "" && rows.split(",").some((row) => !/^\d+$/.test(row.trim()) || Number(row.trim()) > 9999));
		if (!bad) continue;
		return invalid(
			`run form --select 写法不对：${piece}`,
			"form 的 --select 是**分录选中行**，写 `分录标识=0,2`（行号从 0 数），多个分录用 `;` 隔开；" +
				"`分录标识=` 表示这个分录一行没选。list 的 --select 才是主键 pk。" +
				"不给 --select 时，探针按 --set 写过的、--hyperlink 点的分录行模拟选中。",
			{ kind: "form", flag: "--select", value: piece },
		);
	}
	return null;
}

/**
 * `run print` 的两个必给项和格子断言的形状（S24 批 A）。
 *
 * 模板、单据、格子名对不对要读模板设计才知道，那在探针里、出打印之前核；这里只拦不用起 JVM
 * 就知道错的：没给 --pk 打不出东西，没给 --expect 跑完也留不下验证记录，白付一次打印引擎预热
 * （真机上常驻进程里第一次出打印约 58 秒）。
 */
const PRINT_EXPECT_SHAPE = /^\s*[A-Za-z_$][\w$.]*\s*(\[\s*\d+\s*\]\s*){0,2}~?\s*=/;

function checkPrint(parsed: ParsedRunArgs): KernelError[] {
	const errors: KernelError[] = [];
	if (billOf(parsed.flags) === "")
		errors.push(
			invalid(
				"run print 要给 --pk <单据ID> 或 --billno <单据编号>：打印总是打一张具体的单据",
				"写成 run print <模板编码> --pk <单据ID> --expect <格子>=<值>（手里是单据编号就写 --billno <编号>）。数据库里没有合适的单据时，拿任意一张现成的，用 --set 把字段改成要测的样子（真提交，改完这张单就是这样）。",
				{ kind: "print", flag: "--pk" },
			),
		);
	const expects = parsed.expects.filter((value) => value.trim() !== "");
	const shows = parsed.shows.filter((value) => value.trim() !== "");
	if (expects.length === 0 && shows.length === 0)
		errors.push(
			invalid(
				"run print 要给 --expect <格子>=<值>（断言），或 --show <格子|表格key>（只看）",
				"格子写模板控件名（datacell9）或它绑的字段（zlgd_bz_jx）；datacell9[1]=值 指第 2 行明细，datacell9~=片段 表示包含。" +
					"只想看现在打出来什么就写 --show 表格key，整张表逐行打出（含插件新插的行）；只有 --show 的运行不算验证、不留记录。",
				{ kind: "print", flag: "--expect" },
			),
		);
	for (const value of expects) {
		if (PRINT_EXPECT_SHAPE.test(value)) continue;
		errors.push(
			invalid(
				`run print 的 --expect 写法不对：${value}`,
				"写成 格子=值、格子[行号]=值 或 格子~=片段；格子是模板控件名或绑定字段，行号从 0 数。" +
					"插件插的行写 表格key[行]=a | b | c（整行，格子用 | 隔开）或 表格key[行][列]=值。",
				{ kind: "print", flag: "--expect", value },
			),
		);
	}
	return errors;
}

/**
 * `run call` 起 JVM 之前就能判的三样（S24 批 B）：目标写成 `类#方法`、`--args` 是 JSON 数组、断言形状对。
 *
 * 类在不在本工程、方法名拼没拼错要读源码，在 {@link checkCallTarget} 里判；参数和签名对不对得按反射看，
 * 在探针里判。这里的错一次冷启动（40～60 秒）都不该花。
 */
const CALL_EXPECT_SHAPE = /^\s*(\$|error|args\s*\[\s*\d+\s*\]|\[\s*\d+\s*\]|[A-Za-z_$][\w$]*)[\w$.[\]\s]*?~?\s*=/;

function checkCall(parsed: ParsedRunArgs): KernelError[] {
	const errors: KernelError[] = [];
	const target = parsed.pos[1] ?? "";
	if (target !== "" && parseCallTarget(target) === null)
		errors.push(
			invalid(
				`run call 的目标要写成 类名#方法名，收到 ${target}`,
				"例如 zlgd.qmc.task.DemoTask#execute；类名写全类名或不重名的简单类名；同名重载分不清时写 #方法名(类型,类型)。",
				{ kind: "call", target },
			),
		);
	if (parsed.pos.length > 2)
		errors.push(
			invalid(
				`run call 只有一个位置参数（类名#方法名），多出了：${parsed.pos.slice(2).join(" ")}`,
				"方法参数写进 --args，整个 JSON 数组作为 argv 里的一项：--args [参数1,参数2]。",
				{ kind: "call", extra: parsed.pos.slice(2) },
			),
		);
	const args = parsed.flags.args;
	if (args !== undefined) {
		let value: unknown;
		let broken: string | null = null;
		try {
			value = JSON.parse(args);
		} catch (error) {
			broken = error instanceof Error ? error.message : String(error);
		}
		if (broken !== null || !Array.isArray(value))
			errors.push(
				invalid(
					broken !== null ? `run call 的 --args 不是合法 JSON：${broken}` : "run call 的 --args 要是 JSON 数组",
					"--args 是一个 JSON 数组，一项对一个方法参数（RequestContext 参数不占位置）：" +
						'无参方法写 []；一个列表参数写 [[...]]；调度任务 execute 写 [{"key":"value"}]。只收内联 JSON，不收文件路径。',
					{ kind: "call", flag: "--args", value: args.slice(0, 200) },
				),
			);
	}
	for (const value of parsed.expects.filter((one) => one.trim() !== "")) {
		if (CALL_EXPECT_SHAPE.test(value)) continue;
		errors.push(
			invalid(
				`run call 的 --expect 写法不对：${value}`,
				"写成 路径=值 或 路径~=片段。路径直接写是返回值：$ 是返回值本身、[0].字段、字段、size；" +
					"args[0]… 是调用之后的第 1 个参数；error~=片段 断言抛了异常，error= 断言没抛。",
				{ kind: "call", flag: "--expect", value },
			),
		);
	}
	return errors;
}

/**
 * `run push` 起 JVM 之前就能判的（S40）：目标是规则 id、给了源单、有断言或要看的字段。
 *
 * 规则在不在、源单查不查得到要连环境，在探针里按输入不成立报。
 */
function checkPush(parsed: ParsedRunArgs): KernelError[] {
	const errors: KernelError[] = [];
	const target = parsed.pos[1] ?? "";
	if (target !== "" && !/^\d{6,}$/.test(target))
		errors.push(
			invalid(
				`run push 的目标写转换规则 id（一串数字），收到 ${target}`,
				"规则 id 用 cosmic_meta botp list --plugin <插件类名> 查；改了转换插件时，预检给的验证路线里已经填好。",
				{ kind: "push", target },
			),
		);
	if (parsed.pos.length > 2)
		errors.push(
			invalid(
				`run push 只有一个位置参数（规则 id），多出了：${parsed.pos.slice(2).join(" ")}`,
				"源单写 --pk <源单内码> 或 --billno <源单编号>；源单、目标单是哪张从规则里读。",
				{ kind: "push", extra: parsed.pos.slice(2) },
			),
		);
	if (billOf(parsed.flags) === "")
		errors.push(
			invalid(
				"run push 要给 --pk <源单内码> 或 --billno <源单编号>：下推总是推一张具体的源单",
				"写成 run push <规则id> --pk <源单内码> --expect <目标单字段>=<值>；手里是单据编号就写 --billno <编号>。",
				{ kind: "push", flag: "--pk" },
			),
		);
	const expects = parsed.expects.filter((value) => value.trim() !== "");
	const shows = parsed.shows.filter((value) => value.trim() !== "");
	if (expects.length === 0 && shows.length === 0)
		errors.push(
			invalid(
				"run push 要给 --expect <目标单字段>=<值>（断言），或 --show <字段>（只看）",
				"字段路径和 run op 一样（分录写 分录[0].字段）；success / message / bills 断言下推成没成、提示、生成了几张目标单。只有 --show 的运行不算验证、不留记录。",
				{ kind: "push", flag: "--expect" },
			),
		);
	return errors;
}

/** `run wf` 能直接调的插件方法，和探针 WfSim 认的同一份。 */
export const WF_METHODS = [
	"notify",
	"notifyByWithdraw",
	"calcUserIds",
	"filterParticipant",
	"hasTrueCondition",
	"getExpireTime",
	"getJointAuditResult",
] as const;
const WF_CTX_KEYS = ["decision", "message", "approvers", "starter", "vote", "pending"];

/**
 * `run wf` 起 JVM 之前就能判的（S41）：目标是插件类（可带 #方法）、给了单据、有断言或要看的字段、--ctx 形状对。
 *
 * 插件挂在哪个流程和节点、单据查不查得到、决策项节点上有没有，要连环境读流程定义，在探针里按输入不成立报。
 */
function checkWf(parsed: ParsedRunArgs): KernelError[] {
	const errors: KernelError[] = [];
	const target = parsed.pos[1] ?? "";
	const hash = target.indexOf("#");
	const method = hash < 0 ? "" : target.slice(hash + 1);
	if (hash === 0 || (hash > 0 && !(WF_METHODS as readonly string[]).includes(method)))
		errors.push(
			invalid(
				`run wf 的目标写插件类名，要指定方法时写 类名#方法，收到 ${target}`,
				`能这样调的方法：${WF_METHODS.join("、")}。不写方法就按插件在已发布流程里挂的位置定。`,
				{ kind: "wf", target },
			),
		);
	if (parsed.pos.length > 3)
		errors.push(
			invalid(
				`run wf 最多两个位置参数（插件类名、单据标识），多出了：${parsed.pos.slice(3).join(" ")}`,
				"单据写 --pk <单据内码> 或 --billno <单据编号>；上下文写 --ctx 键=值。",
				{ kind: "wf", extra: parsed.pos.slice(3) },
			),
		);
	if (billOf(parsed.flags) === "")
		errors.push(
			invalid(
				"run wf 要给 --pk <单据内码> 或 --billno <单据编号>：流程总是挂在一张具体的单据上",
				"写成 run wf <插件类名> --pk <单据内码> --expect <字段>=<值>；手里是单据编号就写 --billno <编号>。",
				{ kind: "wf", flag: "--pk" },
			),
		);
	const expects = parsed.expects.filter((value) => value.trim() !== "");
	const shows = parsed.shows.filter((value) => value.trim() !== "");
	if (expects.length === 0 && shows.length === 0)
		errors.push(
			invalid(
				"run wf 要给 --expect <字段>=<值>（断言），或 --show <字段>（只看）",
				"字段是插件跑完后库里的单据字段，路径和 run op 一样；error= 断言插件没抛异常，result、result.字段 断言方法返回值。只有 --show 的运行不算验证、不留记录。",
				{ kind: "wf", flag: "--expect" },
			),
		);
	for (const value of parsed.ctxs.filter((one) => one.trim() !== "")) {
		const eq = value.indexOf("=");
		const key = eq <= 0 ? "" : value.slice(0, eq).trim();
		const known = WF_CTX_KEYS.includes(key) || /^(param|var)\.\S+$/.test(key);
		const vote = key !== "vote" || /^[^:]+:(approve|reject)(:.*)?$/.test(value.slice(eq + 1).trim());
		if (known && vote) continue;
		errors.push(
			invalid(
				`run wf 的 --ctx 写法不对：${value}`,
				`写成 键=值，键是 ${WF_CTX_KEYS.join("、")}、param.键（插件参数）、var.键（流程变量）；会审投票写 vote=用户:approve|reject[:决策项编码]。`,
				{ kind: "wf", flag: "--ctx", value },
			),
		);
	}
	return errors;
}

/**
 * 这次要打开哪张已有单据：`--pk` 原样给；`--billno` 写成 `billno:编号` 交给探针按单据编号查出 pk
 * （MetaResolve.pkOf）。两个都没给是空串，表示新建。
 *
 * 用户手里通常是单据编号，run 以前只认内码：真机 2026-09-18 模型为了找一张单查了 10 次。
 */
function billOf(flags: Record<string, string>): string {
	const billno = (flags.billno ?? "").trim();
	return billno !== "" ? `billno:${billno}` : (flags.pk ?? "").trim();
}

function checkBillFlags(flags: Record<string, string>, scenario: string | null = null): KernelError | null {
	if (flags.pk === undefined || flags.billno === undefined) return null;
	return invalid(
		`${scenario === null ? "" : `场景 ${scenario}：`}--pk 和 --billno 只能给一个`,
		"--pk 写单据内码，--billno 写单据编号（工具自己查出内码），留一个。",
		{ pk: flags.pk, billno: flags.billno },
	);
}

/**
 * `run form --status`：按哪种页面状态打开。和要不要打开已有单据对不上的当场拦——
 * `view` / `edit` 没有单据可开、`new` 又给了单据，探针挑哪个照做，验的都不是你说的那种状态。
 */
function checkFormStatus(flags: Record<string, string>): KernelError | null {
	const status = flags.status;
	if (status === undefined) return null;
	if (!FORM_STATUSES.includes(status))
		return invalid(`--status 只能是 ${FORM_STATUSES.join(" | ")}，收到 ${status}`, "改成列出的值之一。", { status });
	const hasBill = billOf(flags) !== "";
	if (status === "new" && hasBill)
		return invalid(
			"--status new 是新建一张单，不能再给 --pk / --billno",
			"新建就去掉 --pk / --billno；看已有单据写 --status edit 或 --status view。",
			{ status },
		);
	if (status !== "new" && !hasBill)
		return invalid(
			`--status ${status} 要打开已有单据`,
			"补上 --pk 或 --billno；新建一张单写 --status new 或不写 --status。",
			{
				status,
			},
		);
	return null;
}

function invalid(message: string, remedy: string, detail: Record<string, unknown> = {}): KernelError {
	return new KernelError("RUN_ARGS_INVALID", message, {
		detail: detail as never,
		remedy,
	});
}

/**
 * 提交、审核这类改状态的操作，在一张状态没摆好的新单上一定过不去。
 *
 * `run op` 不给 `--pk` 就是在内存里新建一张空单，单据状态是空的，平台的状态校验
 * （「只有暂存的数据才允许提交」「请填写"单据状态"」）一定拦 —— 补多少别的必填字段都没用。
 * 真机上（2026-09-17，实验室检测单）这样白跑过一次约 96 秒的冷启动，因为必填预检列了
 * 5 个可补的字段，读起来像「补齐就能过」。所以这里在起 JVM 之前就拦。
 *
 * 放行三种：给了 `--pk`；自己 `--set` 了状态字段（`status=A` / `billstatus=A`，run.md 的
 * `--case submit路径` 就是这么在新单上跑提交的）；明说要验失败（`--expect success=false`）。
 * 状态字段只按「标识以 status 结尾」认：标准单据都是 billstatus，自定义状态字段认不出来的，
 * 给 `--pk` 走已有单。
 */
const STATE_OPS = new Set(["submit", "unsubmit", "audit", "unaudit"]);

function stateNotArranged(
	op: string,
	pk: string,
	sets: readonly string[],
	expects: readonly string[],
	scenario: string | null,
): KernelError | null {
	if (pk !== "" || !STATE_OPS.has(op.toLowerCase())) return null;
	// `@上游.单据.billstatus=…` 摆的是连着的单的状态，不是这张单的
	if (
		sets.some((value) => {
			const key = value.slice(0, Math.max(0, value.indexOf("="))).trim();
			return !key.startsWith("@") && /status$/i.test(key);
		})
	)
		return null;
	if (expects.some((value) => value.replace(/\s/g, "").toLowerCase() === "success=false")) return null;
	const where = scenario === null ? "" : `场景 ${scenario}：`;
	return invalid(
		`${where}${op} 没给 --pk、也没设单据状态：新建的空单状态是空的，平台的状态校验一定拦（补齐别的必填字段也过不去）`,
		"二选一：给 --pk <一张状态合适的已有单据>（提交要暂存的单，可以先用 DataQueryProbe 按状态找一张），" +
			"或者在新单上先把状态摆好，例如提交前 --set billstatus=A（字段标识以这张单为准，有的叫 status）。" +
			"本来就是要验「会被拦」的，加 --expect success=false。",
		{ op, scenario },
	);
}

/**
 * `--set @上游.<单据>.<字段>=值`（`@下游.` 同理）：跑之前改这张单连着的那类单，这个场景跑完改回
 * （`probes/LinkedSet.java`）。
 *
 * 不用起 JVM 就知道不成的三种在这里拦：不是 run op；写法不是 `@上游.单据标识.字段`；
 * 没给 --pk / --billno（新建的单还没有连着的单据）。连着的是哪类单、有没有、字段对不对，探针里核。
 */
const LINKED_SET_KEY = /^@(上游|下游)\.[A-Za-z_$][\w$]*\.[^=\s]+$/;

function linkedSetProblem(
	kind: string,
	pk: string,
	sets: readonly string[],
	scenario: string | null,
): KernelError | null {
	const linked = sets.map((value) => value.trim()).filter((value) => value.startsWith("@"));
	if (linked.length === 0) return null;
	const where = scenario === null ? "" : `场景 ${scenario}：`;
	const shape =
		"写成 --set @上游.<单据标识>.<字段>=值（分录字段 @上游.<单据标识>.<分录>[行].<字段>=值；连着的是下游单写 @下游.），" +
		"要配 --pk 或 --billno 给一张已有的单。";
	if (kind !== "op")
		return invalid(
			`${where}--set ${linked[0]} 改的是连着的单，只有 run op 读`,
			`run ${kind} 的 --set 只改这张单自己的字段。要验「连着的单是某个样子时」，用 run op，${shape}`,
			{ kind, set: linked[0] },
		);
	const bad = linked.find((value) => {
		const eq = value.indexOf("=");
		return eq <= 0 || !LINKED_SET_KEY.test(value.slice(0, eq).trim());
	});
	if (bad !== undefined) return invalid(`${where}--set ${bad} 写法不对`, shape, { set: bad });
	if (pk === "")
		return invalid(
			`${where}--set ${linked[0]} 要配 --pk 或 --billno：新建的单还没有连着的单据`,
			`${shape}手里没有现成的，先用 DataSeedProbe 的 SEED_FROM 从上游单下推一张。`,
			{ set: linked[0] },
		);
	return null;
}

export interface ParsedRunArgs {
	pos: string[];
	sets: string[];
	childSets: string[];
	expects: string[];
	caches: string[];
	shows: string[];
	filters: string[];
	/** `run wf --ctx`：流程上下文，键=值。 */
	ctxs: string[];
	flags: Record<string, string>;
}

/**
 * One argv segment -> parameter buckets.
 *
 * A function of its own because `--case` splits a command into segments and
 * **every segment uses the same syntax** -- nobody should have to remember two
 * sets of rules for inside and outside a segment.
 */
function collectParsedRunArgs(argv: readonly string[]): { parsed: ParsedRunArgs; errors: KernelError[] } {
	const out: ParsedRunArgs = {
		pos: [],
		sets: [],
		childSets: [],
		expects: [],
		caches: [],
		shows: [],
		filters: [],
		ctxs: [],
		flags: {},
	};
	const errors: KernelError[] = [];
	/**
	 * 写了参数却给了空值（空串或全是空白）一律拦下，不当成「没写这个参数」。
	 *
	 * 空值多半是前一步没拿到要用的值（单据内码没查到）却照样把参数写上了。当成没写，跑的就是另一件事：
	 * `--pk ""` 从「对这张单做操作」变成「新建一张空单做操作」，`--expect ""` 从带断言变成不带——
	 * 结果照常返回，断言还可能照样通过，验的却不是要验的那张单（真机 2026-10-11，反审核 `--pk ""` 两次判通过）。
	 */
	const blank = (value: string, flag: string): boolean => {
		if (value.trim() !== "") return false;
		errors.push(
			invalid(
				`${flag} 的值是空的`,
				`空值不会被当成没写 ${flag}：那样跑的是另一件事。要用 ${flag} 就给出值，用不上就把 ${flag} 整个去掉。`,
				{ flag },
			),
		);
		return true;
	};
	let i = 0;
	/**
	 * 取 `flag` 后面那个词当它的值；没取到（已经报过错）返回 null。
	 *
	 * 后面紧跟着的是另一个参数名，算没给值，那个词留给下一轮照常解析：
	 * `--pk --expect success=false` 以前把 `--expect` 当成单据内码收下，断言反倒成了多出来的位置参数。
	 */
	const take = (flag: string): string | null => {
		const value = argv[i + 1];
		if (value === undefined || KNOWN_FLAGS.includes(value.split("=")[0] as string)) {
			const next = value === undefined ? "" : `（紧跟着的是另一个参数 ${value}）`;
			errors.push(invalid(`${flag} 后面缺一个值${next}`, `补上 ${flag} 的值，或去掉这个参数。`, { flag }));
			return null;
		}
		i += 1;
		return blank(value, flag) ? null : value;
	};
	const push = (list: string[], value: string | null, flag: string): void => {
		if (value !== null && !blank(value, flag)) list.push(value);
	};
	for (; i < argv.length; i++) {
		const arg = argv[i] as string;
		if (arg === "--raw") continue;
		if (arg === "--set") {
			push(out.sets, take(arg), arg);
			continue;
		}
		if (arg.startsWith("--set=")) {
			push(out.sets, arg.slice(6), "--set");
			continue;
		}
		if (arg === "--child-set") {
			push(out.childSets, take(arg), arg);
			continue;
		}
		if (arg.startsWith("--child-set=")) {
			push(out.childSets, arg.slice(12), "--child-set");
			continue;
		}
		if (arg === "--expect") {
			push(out.expects, take(arg), arg);
			continue;
		}
		if (arg.startsWith("--expect=")) {
			push(out.expects, arg.slice(9), "--expect");
			continue;
		}
		if (arg === "--cache") {
			push(out.caches, take(arg), arg);
			continue;
		}
		if (arg === "--show") {
			push(out.shows, take(arg), arg);
			continue;
		}
		if (arg.startsWith("--show=")) {
			push(out.shows, arg.slice(7), "--show");
			continue;
		}
		if (arg === "--filter") {
			push(out.filters, take(arg), arg);
			continue;
		}
		if (arg.startsWith("--filter=")) {
			push(out.filters, arg.slice(9), "--filter");
			continue;
		}
		if (arg === "--ctx") {
			push(out.ctxs, take(arg), arg);
			continue;
		}
		if (arg.startsWith("--ctx=")) {
			push(out.ctxs, arg.slice(6), "--ctx");
			continue;
		}
		if (arg === "--events") {
			out.flags.events = "1";
			continue;
		}
		if (arg === "--summary") {
			out.flags.summary = "1";
			continue;
		}
		if (arg === "--mobile") {
			out.flags.mobile = "1";
			continue;
		}
		if (arg === "--real-cache") {
			out.flags["real-cache"] = "1";
			continue;
		}
		if (arg === "--schedule") {
			out.flags.schedule = "1";
			continue;
		}
		if (VALUE_FLAGS.includes(arg)) {
			const value = take(arg);
			if (value !== null) out.flags[arg.slice(2)] = value;
			continue;
		}
		if (arg.startsWith("--")) {
			// 子命令认得出，就把它能用的参数连说明一起贴出来：拼错的人要的是「那该写什么」，
			// 一串裸参数名回答不了。认不出子命令时给全部参数名和问用法的那条调用。
			const kind = argv[0];
			const remedy = isRunKind(kind)
				? `拼错的参数不会被忽略。run ${kind} 能用的参数：\n${runFlagLines(kind).join("\n")}`
				: `run 认识的参数只有这些：${KNOWN_FLAGS.join(" ")}。拼错的参数不会被忽略。各子命令的写法：${runHelpCall()}。`;
			errors.push(invalid(`不认识的参数 ${arg}`, remedy, { flag: arg, known: KNOWN_FLAGS }));
			continue;
		}
		out.pos.push(arg);
	}
	return { parsed: out, errors };
}

export function parseRunArgs(argv: readonly string[]): KernelResult<ParsedRunArgs> {
	const collected = collectParsedRunArgs(argv);
	return collected.errors[0] === undefined ? ok(collected.parsed) : err(collected.errors[0]);
}

export interface RunSegment {
	label: string | null;
	argv: string[];
}

/**
 * Splits a run command into `--case` segments. The first carries the positional
 * arguments; later ones carry only their own `--set` / `--expect` / `--pk` /
 * `--op` / `--filter`.
 *
 * A non-flag word directly after `--case` is the scenario label (and becomes the
 * assertion's case id). Beyond that label a later segment may not have
 * positional arguments -- that writing cannot be told apart from the label, and
 * guessing beats being told, so it is refused at the call site.
 */
export function splitRunCases(argv: readonly string[]): RunSegment[] {
	const segments: RunSegment[] = [{ label: null, argv: [] }];
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--case") {
			const next = argv[i + 1];
			const label = next !== undefined && !next.startsWith("--") ? (argv[++i] as string) : null;
			segments.push({ label, argv: [] });
			continue;
		}
		(segments[segments.length - 1] as RunSegment).argv.push(argv[i] as string);
	}
	return segments;
}

/**
 * Whether a segment carries a scenario of its own, rather than only the command
 * header (`op <entity> <op>`).
 *
 * `run op X save --case A --set … --case B --set …` reads as two scenarios to
 * anyone writing it, but split into three segments -- the first holds nothing
 * but the positionals. Counting it produced a ghost scenario with zero `--set`:
 * one extra empty bill per batch, which failed mandatory-field validation, burnt
 * a code-rule serial number, and shifted every scenario's number by one
 * (2026-09-14 review, `zlgd_qty_wtd`). So the header alone is not a scenario.
 */
function carriesCaseContent(parsed: ParsedRunArgs): boolean {
	return (
		parsed.sets.some((value) => value !== "") ||
		parsed.expects.some((value) => value !== "") ||
		parsed.filters.some((value) => value !== "") ||
		parsed.flags.pk !== undefined ||
		parsed.flags.billno !== undefined ||
		parsed.flags.op !== undefined
	);
}

/**
 * The segments that are actually scenarios. Only the first can be dropped, and
 * only when later segments exist to carry the scenarios instead.
 */
function scenarioSegments<T extends { label: string | null; parsed: ParsedRunArgs }>(
	segments: readonly T[],
): readonly T[] {
	const first = segments[0];
	if (segments.length < 2 || first === undefined) return segments;
	return first.label === null && !carriesCaseContent(first.parsed) ? segments.slice(1) : segments;
}

/**
 * 一次 `--case` 批量里的一个场景，以及单独重跑它要用的 argv。
 *
 * `--case` 是开发期「一次冷启动跑多个场景」的批量写法，不是用例资产（S22 §4.1）：
 * 它退役的是沉淀下来的回归用例，不是这个。拆回单场景 argv 仍然必要 —— 每个场景各留
 * 一条验证记录，交付判据才能按场景说「这一个最后一次是不是过的」。
 */
export interface BatchScenario {
	id: string;
	argv: string[];
}

export interface ComposedCases {
	/** OP_CASES body, line-oriented; format is probes/OpSandbox.java's parseCases. */
	blocks: string[];
	/** Per-scenario re-runnable argv: one verification record each. */
	scenarios: BatchScenario[];
}

/**
 * Segments -> `{ blocks, scenarios }`.
 *
 * Two refusals, both entrances to "silently verified the wrong thing":
 *   1. positional arguments in a later segment -- the word after `--case` was
 *      already spent as the label, and anything more cannot be attributed.
 *   2. a duplicate label -- assertions group by label, so two scenarios would
 *      merge into one and "scenario B failed" would be displayed as "A failed".
 */
export function composeOpCases(input: {
	entity: string;
	defaultOp: string | undefined;
	segments: readonly { label: string | null; parsed: ParsedRunArgs }[];
}): KernelResult<ComposedCases> {
	const blocks: string[] = [];
	const scenarios: BatchScenario[] = [];
	const seen = new Set<string>();
	const segments = scenarioSegments(input.segments);

	for (let index = 0; index < segments.length; index++) {
		const segment = segments[index] as { label: string | null; parsed: ParsedRunArgs };
		if (segment.parsed.pos.length > 0 && segment !== input.segments[0]) {
			return err(
				invalid(
					`--case 之后只能写 --set / --expect / --pk / --billno / --op / --filter，多出来的位置参数：${segment.parsed.pos.join(" ")}`,
					"紧跟 --case 的那个词已经当成场景标签用掉了；其余位置参数删掉或写成具名参数。",
					{ extra: segment.parsed.pos },
				),
			);
		}
		const id = segment.label ?? `场景${index + 1}`;
		if (seen.has(id)) {
			return err(invalid(`场景标签重复：${id}`, "换一个标签。断言按标签分组，重名会被合成一条。", { label: id }));
		}
		seen.add(id);

		const opName = segment.parsed.flags.op ?? input.defaultOp ?? "save";
		const conflict = checkBillFlags(segment.parsed.flags, id);
		if (conflict !== null) return err(conflict);
		const pk = billOf(segment.parsed.flags);
		const sets = segment.parsed.sets.filter((value) => value !== "");
		const expects = segment.parsed.expects.filter((value) => value !== "");
		const filter = segment.parsed.filters.filter((value) => value !== "")[0] ?? "";
		const unsaved = stateNotArranged(opName, pk, sets, expects, id);
		if (unsaved !== null) return err(unsaved);
		const linked = linkedSetProblem("op", pk, sets, id);
		if (linked !== null) return err(linked);

		const lines = [`[case] ${id}`, `op=${opName}`];
		if (pk !== "") lines.push(`pk=${pk}`);
		if (sets.length > 0) lines.push(`set=${sets.join(";")}`);
		if (expects.length > 0) lines.push(`expect=${expects.join(";")}`);
		if (filter !== "") lines.push(`count=${filter}`);
		blocks.push(lines.join("\n"));

		const argv = ["op", input.entity, opName];
		if (segment.parsed.flags.billno !== undefined) argv.push("--billno", segment.parsed.flags.billno.trim());
		else if (pk !== "") argv.push("--pk", pk);
		for (const value of sets) argv.push("--set", value);
		for (const value of expects) argv.push("--expect", value);
		if (filter !== "") argv.push("--filter", filter);
		scenarios.push({ id, argv });
	}
	return ok({ blocks, scenarios });
}

export interface RunPlan {
	kind: RunKind;
	target: string;
	probe: string;
	/** Exactly the variables this probe should see. Never written to process.env. */
	env: Record<string, string>;
	/** Forced cold. Writes and real-cache runs always are. */
	cold: boolean;
	/** Batch scenarios, when `--case` was used. Null otherwise. */
	scenarios: BatchScenario[] | null;
	notes: string[];
	/** `--user`: whose identity the whole run takes; resolved to a user id just before the probe. */
	user?: string;
}

export interface RunBlocker extends PrepareBlocker {
	code: "RUN_ARGS_INVALID" | "RUN_EXTERNAL_SIDE_EFFECT";
	detail: Readonly<Record<string, unknown>>;
}

/** The shared prepare shape (S15.5). `plan` is set only when nothing blocks. */
export type RunPreparation = PrepareResult<RunPlan>;

function blockerOf(error: KernelError): RunBlocker {
	return { code: "RUN_ARGS_INVALID", message: error.message, remedy: error.remedy, detail: error.detail };
}

/** Collects independent, pure argv defects before any filesystem check or JVM. */
function collectRunArgumentBlockers(argv: readonly string[]): RunBlocker[] {
	const segments = splitRunCases(argv);
	const parsedSegments: { label: string | null; parsed: ParsedRunArgs }[] = [];
	const blockers: RunBlocker[] = [];
	for (const segment of segments) {
		const parsed = collectParsedRunArgs(segment.argv);
		blockers.push(...parsed.errors.map(blockerOf));
		parsedSegments.push({ label: segment.label, parsed: parsed.parsed });
	}
	const first = parsedSegments[0]?.parsed;
	if (first === undefined) return blockers;
	const [kind, target, third] = first.pos;
	if (!isRunKind(kind)) {
		blockers.push(
			blockerOf(
				invalid(
					`run 的第一个参数要是 ${RUN_KINDS.join(" / ")}，收到 ${kind === undefined ? "(空)" : kind}`,
					"op 验操作、form 验表单插件、list 验列表、callback 验父子回调、flow 验父子流程、rule 只算规则层、print 验打印插件的输出、call 直接调本工程类的方法（调度任务、导入插件、报表取数和插件里抽出来的计算逻辑）、push 验 BOTP 转换插件（下推保存后从数据库回读）、wf 验工作流插件（按流程定义拼上下文直调）。" +
						`每个子命令怎么写：${runHelpCall()}。`,
					{ kind: kind ?? null },
				),
			),
		);
		return blockers;
	}
	if (target === undefined || target === "") {
		blockers.push(blockerOf(invalid(`run ${kind} 后面要给目标标识`, "补上实体标识或布局标识。", { kind })));
	}
	for (const segment of parsedSegments) {
		blockers.push(...checkAcceptedAll(kind, segment.parsed).map(blockerOf));
		const user = laterSegmentUser(segment, parsedSegments[0]);
		if (user !== null) blockers.push(blockerOf(user));
		const conflict = checkBillFlags(segment.parsed.flags, segment.label);
		if (conflict !== null) blockers.push(blockerOf(conflict));
		const linked = linkedSetProblem(
			kind,
			billOf(segment.parsed.flags),
			segment.parsed.sets.filter((value) => value !== ""),
			segment.label,
		);
		if (linked !== null) blockers.push(blockerOf(linked));
	}
	if (segments.length > 1) {
		if (kind !== "op")
			blockers.push(
				blockerOf(
					invalid("--case 只支持 run op（其余 run 子命令一次只跑一个场景）", "把其它子命令拆成多次调用。", {
						kind,
					}),
				),
			);
		const seen = new Set<string>();
		// Same filtering as composeOpCases, so the auto-numbered labels reported here
		// are the ones the probe will actually see.
		const scenarioParsed = scenarioSegments(parsedSegments);
		for (let index = 0; index < scenarioParsed.length; index++) {
			const segment = scenarioParsed[index] as { label: string | null; parsed: ParsedRunArgs };
			if (segment.parsed.pos.length > 0 && segment !== parsedSegments[0])
				blockers.push(
					blockerOf(
						invalid(
							`--case 之后多出了位置参数：${segment.parsed.pos.join(" ")}`,
							"紧跟 --case 的词已是标签；其余值改成具名参数。",
							{ extra: segment.parsed.pos },
						),
					),
				);
			const id = segment.label ?? `场景${index + 1}`;
			if (seen.has(id)) blockers.push(blockerOf(invalid(`场景标签重复：${id}`, "换一个标签。", { label: id })));
			seen.add(id);
		}
	}
	const flags = first.flags;
	if (kind === "rule") {
		if (target !== "form" && target !== "biz")
			blockers.push(
				blockerOf(invalid("run rule 要先说 form 或 biz", "写成 run rule form <布局> 或 run rule biz <实体>。")),
			);
		if (third === undefined || third === "")
			blockers.push(blockerOf(invalid("run rule 缺少布局或实体标识", "补上第三个位置参数。")));
		if (flags.scene !== undefined && !RULE_SCENES.includes(flags.scene))
			blockers.push(
				blockerOf(invalid(`--scene 只能是 ${RULE_SCENES.join(" | ")}，收到 ${flags.scene}`, "改成列出的值之一。")),
			);
		if (flags.branch !== undefined && !RULE_BRANCHES.includes(flags.branch))
			blockers.push(
				blockerOf(
					invalid(`--branch 只能是 ${RULE_BRANCHES.join(" | ")}，收到 ${flags.branch}`, "改成列出的值之一。"),
				),
			);
		if (flags.list !== undefined && !RULE_LISTS.includes(flags.list))
			blockers.push(
				blockerOf(invalid(`--list 只能是 ${RULE_LISTS.join(" | ")}，收到 ${flags.list}`, "改成列出的值之一。")),
			);
	}
	if (kind === "flow" && parentActions(flags).length !== 1)
		blockers.push(blockerOf(invalid("run flow 必须且只能给一个父动作：--click、--op 或 --hyperlink", "三选一。")));
	if (kind === "form") {
		const action = formActionError(flags);
		if (action !== null) blockers.push(blockerOf(action));
	}
	if (kind === "callback" && (third === undefined || third === "" || flags.callback === undefined))
		blockers.push(blockerOf(invalid("run callback 必须给父表单、子表单和 --callback", "补齐三个输入。")));
	if (kind === "list") {
		const limit = Number(flags.limit ?? 20);
		if (!Number.isInteger(limit) || limit < 1 || limit > 200)
			blockers.push(blockerOf(invalid("--limit 必须是 1..200 的整数", "改成 1 到 200 之间的整数。")));
		const primaryKeys = ["click", "op", "row-click", "row-double-click", "hyperlink", "tree-node", "tree-toolbar"];
		const primaries = primaryKeys.filter((key) => flags[key] !== undefined && flags[key] !== "");
		if (primaries.length > 1)
			blockers.push(
				blockerOf(
					invalid("run list 一次只能给一个主交互参数", "保留一个主交互；--callback 可跟随。", {
						given: primaries,
					}),
				),
			);
	}
	if (kind === "form" && flags.select !== undefined) {
		const select = checkFormSelect(flags.select);
		if (select !== null) blockers.push(blockerOf(select));
	}
	if (kind === "form") {
		const status = checkFormStatus(flags);
		if (status !== null) blockers.push(blockerOf(status));
	}
	if (kind === "print") blockers.push(...checkPrint(first).map(blockerOf));
	if (kind === "call") blockers.push(...checkCall(first).map(blockerOf));
	if (kind === "push") blockers.push(...checkPush(first).map(blockerOf));
	if (kind === "wf") blockers.push(...checkWf(first).map(blockerOf));
	return blockers;
}

export function prepareRun(argv: readonly string[], runtimeKeyId: string): RunPreparation {
	const blockers = collectRunArgumentBlockers(argv);
	const planned = blockers.length === 0 ? planRun(argv) : null;
	if (planned !== null && !planned.ok) blockers.push(blockerOf(planned.error));
	const plan = planned?.ok === true ? planned.value : null;
	return emptyPrepare<RunPlan>({
		plan,
		blockers,
		capsules: [runAdapterKnowledgeCapsule(argv, runtimeKeyId)],
		// One adapter probe, and its own rules decide hot or cold. Batched `--case`
		// scenarios stay one process on purpose -- that is the whole point of it.
		estimatedCost: plan === null ? FREE : { processes: 1, coldStarts: plan.cold ? 1 : 0 },
	});
}

/**
 * Warns when a form simulation is aimed at an identifier none of this project's
 * plugins are registered on, while a sibling layout of the same entity carries
 * them.
 *
 * This is the false-PASS case, and it is the expensive kind of wrong: FormSim
 * accepts a bill's entity number as a layout number, loads that layout's own
 * plugin list, and asserts against fields the plugin under test never touched.
 * A green result comes back after a full cold start, and it is promotable to a
 * regression case. Nothing here refuses -- simulating the entity is legitimate
 * when that is what you meant -- but the alternative has to be named before the
 * process starts, not discovered by reading the plugin list afterwards.
 */
function checkFormRegistration(ctx: KernelContext, prepared: RunPreparation, plan: RunPlan): RunPreparation {
	if (plan.kind !== "form" && plan.kind !== "list") return prepared;
	const sites = formPluginSites(ctx, plan.target);
	if (sites === null)
		return {
			...prepared,
			deferred: [
				...prepared.deferred,
				{
					check: "目标上有没有本工程插件登记",
					dependsOn: ["impact.meta-index"],
					reason: "没有影响面索引可读，无法判断这个标识挂的是哪份插件清单。",
				},
			],
		};
	if (sites.onTarget.length > 0 || sites.elsewhere.length === 0) return prepared;
	const where = sites.elsewhere
		.map((site) => `${site.layout}（${site.classes.map((cls) => cls.slice(cls.lastIndexOf(".") + 1)).join(" / ")}）`)
		.join("、");
	return {
		...prepared,
		warnings: [
			...prepared.warnings,
			`${plan.target} 上没有本工程的插件登记，登记在它的布局上：${where}（${sites.snapshot}）。` +
				"挂实体跑出来的 PASS 是另一份插件清单的结果，不能当本插件生效的证据——要验插件就把目标换成布局标识。",
		],
	};
}

/**
 * 插件链上发消息、调外部接口、存附件的插件：S27 起只提醒、不拦。
 *
 * 以前运行在回滚事务里，这类动作撤不回，前检在起 JVM 之前按插件登记（必要时现读一次操作链）拦下。
 * 用户 2026-09-19 定：agent 连的必然是纯测试环境，外部接口和消息都放开。现在运行真提交，这些动作
 * 和用户在界面上点一下一样会真的发出去；前检只把它们列出来，读结果的人知道这次发出去了什么。
 * 按登记粗判就够：一条提醒说宽了代价是一行字，不值得为它多读一次操作链。
 */
function noteExternalEffects(ctx: KernelContext, prepared: RunPreparation, plan: RunPlan): RunPreparation {
	// call、wf 的目标是类，走到的代码在 checkCallTarget / checkWfTarget 里按源码列；push 的目标是规则 id，不是单据。
	if (plan.kind === "rule" || plan.kind === "call" || plan.kind === "push" || plan.kind === "wf") return prepared;
	const sites = externalEffectSites(ctx, plan.target).filter((site) => {
		if (site.basis === "source-linkage") return true;
		// 出打印只跑登记在这张模板上的打印插件；run op 不开表单，界面、打印插件调不到。
		if (plan.kind === "print")
			return site.sites.some((entry) => entry.kind === "print" && entry.layout === plan.target);
		if (plan.kind === "op") return site.sites.some((entry) => !UI_ONLY_SITES.has(entry.kind));
		return true;
	});
	if (sites.length === 0) return prepared;
	const warnings = sites.map(
		(site) =>
			`${plan.target} 的插件链上 ${site.simple} 会发消息 / 调接口 / 存附件（${site.effects.join(", ")}）${effectSiteWhere(site)}：` +
			"运行是真提交，走到它时会真的发出去。",
	);
	return { ...prepared, warnings: [...prepared.warnings, ...warnings] };
}

interface OpRunFacts {
	entity: string;
	op: string;
	/** `--set` values verbatim (`key=value`), in the order they were given. */
	sets: string[];
	usesPk: boolean;
}

/**
 * The entity, operation and `--set` list one `run op` argv carried. Null for
 * every other argv.
 *
 * Goes through `parseRunArgs` instead of scanning for `--set` by hand: the draft
 * pool stores what the caller typed, `--set=k=v` spelling included, and a second
 * reader with its own idea of the syntax would disagree with the planner about
 * what a past run actually set.
 */
function opRunFacts(argv: readonly string[]): OpRunFacts | null {
	const parsed = parseRunArgs(argv);
	if (!parsed.ok) return null;
	const [kind, entity, third] = parsed.value.pos;
	if (kind !== "op" || entity === undefined || entity === "") return null;
	return {
		entity,
		// The precedence planRun and composeOpCases already use: --op wins over the positional.
		op: parsed.value.flags.op ?? third ?? "save",
		sets: parsed.value.sets.filter((value) => value !== ""),
		usesPk: billOf(parsed.value.flags) !== "",
	};
}

/** What this run sets, per scenario. Batch and single are read into one shape. */
function opScenariosOf(plan: RunPlan): { id: string | null; facts: OpRunFacts }[] {
	if (plan.scenarios !== null) {
		return plan.scenarios.flatMap((scenario) => {
			const facts = opRunFacts(scenario.argv);
			return facts === null ? [] : [{ id: scenario.id, facts }];
		});
	}
	return [
		{
			id: null,
			facts: {
				entity: plan.target,
				op: plan.env.OP_NAME ?? "save",
				sets: (plan.env.OP_SET ?? "").split(";").filter((value) => value !== ""),
				usesPk: (plan.env.OP_PK ?? "") !== "",
			},
		},
	];
}

/** One scenario of this run that builds a NEW bill and puts an operation through the platform. */
interface NewBillScenario {
	id: string | null;
	entity: string;
	op: string;
	sets: string[];
}

/**
 * The scenarios a mandatory-field check applies to.
 *
 * Three conditions, all of them narrowing: an operation has to run (no
 * operation, no validation chain), the bill has to be built from the argv
 * (`--pk` means the values are already on the row and were never typed here),
 * and the kind has to be one that saves. `list` and `rule` never create a bill;
 * `callback` triggers a child page rather than an operation on the parent.
 */
export function newBillScenarios(plan: RunPlan): NewBillScenario[] {
	const split = (value: string | undefined): string[] => (value ?? "").split(";").filter((item) => item !== "");
	if (plan.kind === "op") {
		return opScenariosOf(plan)
			.filter((scenario) => !scenario.facts.usesPk)
			.map((scenario) => ({
				id: scenario.id,
				entity: scenario.facts.entity,
				op: scenario.facts.op,
				sets: scenario.facts.sets,
			}));
	}
	if (plan.kind === "form") {
		const op = plan.env.FORM_OP ?? "";
		if (op === "" || (plan.env.FORM_PK ?? "") !== "") return [];
		return [{ id: null, entity: plan.target, op, sets: split(plan.env.FORM_SET) }];
	}
	if (plan.kind === "flow") {
		const op = plan.env.FLOW_PARENT_OP ?? "";
		if (op === "" || (plan.env.FLOW_PK ?? "") !== "") return [];
		return [{ id: null, entity: plan.target, op, sets: split(plan.env.FLOW_PARENT_SET) }];
	}
	return [];
}

/** Scenarios that may each print their own mandatory-field line; the rest are counted. */
const MUST_INPUT_NOTE_LIMIT = 2;

/**
 * Puts the design-time mandatory header fields this run has not given in front
 * of the caller, before the run rather than after it.
 *
 * Since S27 the run itself commits on the resident JVM, so a missing field no
 * longer costs a cold start -- but a new bill that fails validation still costs
 * a round trip, and in a batch it costs every scenario. The lookup is cached per
 * RuntimeKey, so this is a resident-JVM metadata read **once per entity**. It is
 * deliberately resident-only (`coldFallback: false`): a cold process to save a
 * round trip is the opposite of the point.
 *
 * Nothing it finds ever blocks. See `must-input.ts` for why it shows and never
 * fills in.
 */
async function noteMustInput(ctx: KernelContext, plan: RunPlan): Promise<string[]> {
	const scenarios = newBillScenarios(plan);
	if (scenarios.length === 0) return [];

	const facts = new Map<string, MustInputFacts>();
	const unread: string[] = [];
	for (const entity of [...new Set(scenarios.map((scenario) => scenario.entity))]) {
		const cached = readMustInput(ctx, entity);
		if (cached !== null) {
			facts.set(entity, cached);
			continue;
		}
		const run = await probe(ctx, MUST_INPUT_PROBE, {
			kernelEnv: true,
			env: { META_ENTITY: entity },
			coldFallback: false,
			invocation: `run 必填字段预检（${entity}）`,
		});
		const parsed = run.ok
			? parseMustInput(run.value.json.records, new Date(ctx.ports.clock.now()).toISOString())
			: null;
		if (parsed === null) {
			unread.push(entity);
			continue;
		}
		writeMustInput(ctx, entity, parsed);
		facts.set(entity, parsed);
	}

	const notes: string[] = [];
	let hidden = 0;
	for (const scenario of scenarios) {
		const known = facts.get(scenario.entity);
		if (known === undefined) continue;
		const missing = missingMustInput(known, scenario.sets);
		if (missing.length === 0) continue;
		if (notes.length >= MUST_INPUT_NOTE_LIMIT) {
			hidden += 1;
			continue;
		}
		const text = mustInputText({ entity: scenario.entity, op: scenario.op, missing, scenarioId: scenario.id });
		if (text !== null) notes.push(text);
	}
	if (hidden > 0) notes.push(`另有 ${String(hidden)} 个场景也缺必录字段，没有逐条列出。`);
	if (unread.length > 0) {
		// Said out loud rather than swallowed: "no warning" and "never checked" are
		// the same silence, and only one of them means the fields are there.
		notes.push(
			`必填字段预检这次没做成（${unread.join("、")} 的设计态没读到，多半是常驻 JVM 没起来）——` +
				"不影响本次结果，只是缺字段要等跑完才知道。",
		);
	}
	return notes;
}

/**
 * `run call` 读源码的那一半前检（S24 批 B）：类在本工程源码里、方法名在类里写着、方法走到的代码里有哪些发消息、调接口的动作（S27 起只提醒）。
 *
 * 全过时把解析出的全类名写进 `CALL_CLASS` 交给探针：简单类名在这里按源码认定一次，探针不再自己猜。
 */
function checkCallTarget(ctx: KernelContext, prepared: RunPreparation, plan: RunPlan): RunPreparation {
	if (plan.kind !== "call") return prepared;
	const target = parseCallTarget(plan.target);
	if (target === null) return prepared;
	const refuse = (message: string, remedy: string, detail: Record<string, unknown>): RunPreparation => ({
		...prepared,
		plan: null,
		blockers: [...prepared.blockers, blockerOf(invalid(message, remedy, { kind: "call", ...detail }))],
	});
	const located = locateCallClass(ctx, target.cls);
	if (located.state === "ambiguous")
		return refuse(`本工程里叫 ${target.cls} 的类不止一个`, `写全类名：${located.candidates.join("、")}。`, {
			candidates: located.candidates,
		});
	if (located.state === "missing")
		return refuse(
			`本工程源码里没有类 ${target.cls}`,
			"run call 只调本工程源码里的类（平台类、第三方 jar 里的类不在这条路上）。" +
				(located.near.length > 0
					? `名字相近的：${located.near.join("、")}。`
					: "类名写全类名，或者先用 cosmic_query 查类。"),
			{ near: located.near },
		);
	const reach = callReach(ctx, located.cls, target.method);
	if (!reach.methodFound && !target.method.startsWith("get") && !target.method.startsWith("set")) {
		// 源码里认不出这个方法：多半是拼错了。继承来的方法（父类在 jar 里）也会走到这里，
		// 所以只在名字和本类某个方法很近时才拦；不近就放给探针按反射判，那边能看到继承链。
		const near = nearNames(target.method, reach.declared);
		if (near.length > 0 && !near.includes(target.method))
			return refuse(`${located.cls.simple} 里没有方法 ${target.method}`, `名字相近的：${near.join("、")}。`, {
				class: located.cls.fqn,
				method: target.method,
				near,
			});
	}
	// S27 起真提交：方法走得到的发消息、调接口只提醒，不拦。另开事务、另起线程的写入以前是「逃出回滚」，
	// 现在本来就提交，不再单列。
	const scope = reach.methodFound
		? `从 ${located.cls.simple}#${target.method} 的方法体出发`
		: `源码里没认出方法 ${target.method}，${located.cls.simple} 按整个文件算`;
	const warnings = reach.effects.map(
		(hit) =>
			`${plan.target} 走得到的 ${hit.cls.slice(hit.cls.lastIndexOf(".") + 1)} 会发消息 / 调接口 / 存附件（${hit.hits.join(", ")}；` +
			`引用链：${viaText(hit.via)}；${scope}）：调用是真提交，走到它时会真的发出去。`,
	);
	return {
		...prepared,
		plan: { ...plan, env: { ...plan.env, CALL_CLASS: located.cls.fqn } },
		warnings: [...prepared.warnings, ...warnings],
	};
}

/**
 * `run wf` 读源码的那一半前检（S41）：插件类在本工程源码里；它的方法走得到的发消息、调接口列成提醒。
 * 全过时把全类名写进 `WF_CLASS`：简单类名在这里认定一次，探针不再猜。
 */
function checkWfTarget(ctx: KernelContext, prepared: RunPreparation, plan: RunPlan): RunPreparation {
	if (plan.kind !== "wf") return prepared;
	const hash = plan.target.indexOf("#");
	const cls = hash < 0 ? plan.target : plan.target.slice(0, hash);
	const refuse = (message: string, remedy: string, detail: Record<string, unknown>): RunPreparation => ({
		...prepared,
		plan: null,
		blockers: [...prepared.blockers, blockerOf(invalid(message, remedy, { kind: "wf", ...detail }))],
	});
	const located = locateCallClass(ctx, cls);
	if (located.state === "ambiguous")
		return refuse(`本工程里叫 ${cls} 的类不止一个`, `写全类名：${located.candidates.join("、")}。`, {
			candidates: located.candidates,
		});
	if (located.state === "missing")
		return refuse(
			`本工程源码里没有类 ${cls}`,
			"run wf 调的是本工程源码里的工作流插件。" +
				(located.near.length > 0
					? `名字相近的：${located.near.join("、")}。`
					: "类名写全类名，或者先用 cosmic_query 查类。"),
			{ near: located.near },
		);
	const method = hash < 0 ? "notify" : plan.target.slice(hash + 1);
	const reach = callReach(ctx, located.cls, method);
	const scope = reach.methodFound
		? `从 ${located.cls.simple}#${method} 的方法体出发`
		: `${located.cls.simple} 按整个文件算`;
	const warnings = reach.effects.map(
		(hit) =>
			`${located.cls.simple} 走得到的 ${hit.cls.slice(hit.cls.lastIndexOf(".") + 1)} 会发消息 / 调接口 / 存附件（${hit.hits.join(", ")}；` +
			`引用链：${viaText(hit.via)}；${scope}）：调用是真提交，走到它时会真的发出去。`,
	);
	return {
		...prepared,
		plan: { ...plan, env: { ...plan.env, WF_CLASS: located.cls.fqn } },
		warnings: [...prepared.warnings, ...warnings],
	};
}

/** Parses a run and adds the checks that read the project: form registration, external effects (noted), call targets. */
export function prepareRunInvocation(ctx: KernelContext, argv: readonly string[]): RunPreparation {
	const prepared = prepareRun(argv, ctx.runtimeKeyId);
	const plan = prepared.plan;
	// Argv that never parsed has no target, and a scan with no target is not a
	// clean scan. Say so instead of returning "no external effects found" (S15 §4.4).
	if (plan === null)
		return {
			...prepared,
			deferred: [
				...prepared.deferred,
				{
					check: "目标关联源码的事务外副作用扫描",
					dependsOn: ["run.plan.target"],
					reason: "参数未解析成执行计划，没有可扫描的目标标识。",
				},
			],
		};
	return checkWfTarget(
		ctx,
		checkCallTarget(ctx, noteExternalEffects(ctx, checkFormRegistration(ctx, prepared, plan), plan), plan),
		plan,
	);
}

/**
 * argv -> the probe and the environment it reads. Pure: no filesystem, no
 * process, no clock, so every refusal below is a unit test rather than a real
 * Cosmic round trip.
 */
export function planRun(argv: readonly string[]): KernelResult<RunPlan> {
	const planned = planRunBody(argv);
	if (!planned.ok) return planned;
	const segments = splitRunCases(argv);
	const parsedSegments: { label: string | null; parsed: ParsedRunArgs }[] = [];
	for (const segment of segments) {
		const parsed = parseRunArgs(segment.argv);
		if (!parsed.ok) return err(parsed.error);
		parsedSegments.push({ label: segment.label, parsed: parsed.value });
	}
	for (const segment of parsedSegments) {
		const later = laterSegmentUser(segment, parsedSegments[0]);
		if (later !== null) return err(later);
	}
	const user = parsedSegments[0]?.parsed.flags.user;
	if (user === undefined) return planned;
	const plan = planned.value;
	return ok({
		...plan,
		user,
		// 单独重跑一个场景也得是同一个人：验证记录照这条 argv 记
		scenarios: plan.scenarios?.map((one) => ({ ...one, argv: [...one.argv, "--user", user] })) ?? null,
	});
}

/**
 * `--user` 管整次运行：一次运行只进一个身份，写在 `--case` 段里的拦下，不当成只管这一段。
 * 要比较不同人的结果，拆成几次运行。
 */
function laterSegmentUser(
	segment: { label: string | null; parsed: ParsedRunArgs },
	first: { label: string | null; parsed: ParsedRunArgs } | undefined,
): KernelError | null {
	if (segment === first || segment.parsed.flags.user === undefined) return null;
	return invalid(
		`--user 写在了场景 ${segment.label ?? ""} 里：一次运行只用一个身份`,
		"把 --user 挪到第一个 --case 之前（管整次运行）；几个人的结果要对比，就按人拆成几次 run。",
		{ flag: "--user", label: segment.label },
	);
}

function planRunBody(argv: readonly string[]): KernelResult<RunPlan> {
	const segments = splitRunCases(argv);
	const first = parseRunArgs((segments[0] as RunSegment).argv);
	if (!first.ok) return err(first.error);
	const parsed = first.value;
	const [kind, target, third] = parsed.pos;
	if (!isRunKind(kind)) {
		return err(
			invalid(
				`run 的第一个参数要是 ${RUN_KINDS.join(" / ")}，收到 ${kind === undefined ? "(空)" : kind}`,
				"op 验操作、form 验表单插件、list 验列表、callback 验父子回调、flow 验父子流程、rule 只算规则层、print 验打印插件的输出、call 直接调本工程类的方法（调度任务、导入插件、报表取数和插件里抽出来的计算逻辑）、push 验 BOTP 转换插件（下推保存后从数据库回读）、wf 验工作流插件（按流程定义拼上下文直调）。" +
					`每个子命令怎么写：${runHelpCall()}。`,
				{ kind: kind ?? null },
			),
		);
	}
	if (target === undefined || target === "") {
		return err(invalid(`run ${kind} 后面要给目标标识`, "补上实体标识或布局标识。", { kind }));
	}
	const unread = checkAccepted(kind, parsed);
	if (unread !== null) return err(unread);
	const billConflict = checkBillFlags(parsed.flags);
	if (billConflict !== null) return err(billConflict);
	// 批量的每个场景在 composeOpCases 里各核各的
	if (segments.length === 1) {
		const linked = linkedSetProblem(
			kind,
			billOf(parsed.flags),
			parsed.sets.filter((value) => value !== ""),
			null,
		);
		if (linked !== null) return err(linked);
	}
	const set = parsed.sets.filter((value) => value !== "").join(";");
	const notes: string[] = [];

	// ---------------------------------------------------------------- batch
	if (segments.length > 1) {
		if (kind !== "op") {
			return err(
				invalid("--case 只支持 run op（其余 run 子命令一次只跑一个场景）", "把其它子命令拆成多次调用。", { kind }),
			);
		}
		const parsedSegments: { label: string | null; parsed: ParsedRunArgs }[] = [{ label: null, parsed }];
		for (const segment of segments.slice(1)) {
			const more = parseRunArgs(segment.argv);
			if (!more.ok) return err(more.error);
			// Every segment is checked, not just the first: a dropped parameter in
			// scenario 3 is exactly as invisible as one in scenario 1.
			const rejected = checkAccepted(kind, more.value);
			if (rejected !== null) return err(rejected);
			parsedSegments.push({ label: segment.label, parsed: more.value });
		}
		const composed = composeOpCases({ entity: target, defaultOp: third, segments: parsedSegments });
		if (!composed.ok) return err(composed.error);
		notes.push(
			`批量 ${composed.value.scenarios.length} 个场景 → 一次 OpSandbox 运行，按顺序真提交（写同一个 --pk 的场景，后一个拿到的是前一个提交后的单）`,
		);
		return ok({
			kind,
			target,
			probe: RUN_PROBES.op,
			env: { OP_ENTITY: target, OP_CASES: composed.value.blocks.join("\n") },
			cold: false,
			scenarios: composed.value.scenarios,
			notes,
		});
	}

	const flags = parsed.flags;
	const expects = parsed.expects.filter((value) => value !== "").join(";");

	if (kind === "rule") {
		// form and biz have different output contracts (visibility/locking vs field
		// values); one command for both is something the caller cannot consume.
		if (target !== "form" && target !== "biz") {
			return err(
				invalid(
					"run rule 要先说哪一类：form（界面规则）或 biz（业务规则）",
					"写成 run rule form <布局> 或 run rule biz <实体>。",
					{ target },
				),
			);
		}
		if (third === undefined || third === "") {
			return err(
				invalid(`run rule ${target} 后面要给${target === "form" ? "布局" : "实体"}标识`, "补上标识再跑。", {
					target,
				}),
			);
		}
		if (flags.scene !== undefined && !RULE_SCENES.includes(flags.scene)) {
			return err(invalid(`--scene 只能是 ${RULE_SCENES.join(" | ")}，收到 ${flags.scene}`, "改成列出的值之一。"));
		}
		if (flags.branch !== undefined && !RULE_BRANCHES.includes(flags.branch)) {
			return err(
				invalid(`--branch 只能是 ${RULE_BRANCHES.join(" | ")}，收到 ${flags.branch}`, "改成列出的值之一。"),
			);
		}
		if (flags.list !== undefined && !RULE_LISTS.includes(flags.list)) {
			return err(invalid(`--list 只能是 ${RULE_LISTS.join(" | ")}，收到 ${flags.list}`, "改成列出的值之一。"));
		}
		return ok({
			kind,
			target,
			probe: RUN_PROBES.rule,
			env: {
				RULE_KIND: target,
				RULE_TARGET: third,
				RULE_SET: set,
				RULE_HOST: flags.host ?? "",
				RULE_ROW: flags.row ?? "0",
				RULE_SCENE: flags.scene ?? "all",
				RULE_LIST: flags.list ?? "",
				RULE_BRANCH: flags.branch ?? "hide-wins",
				RULE_EXPECT: expects,
				// 只打值不断言。没有它时，「改前看一眼面板是不是显示」只能写成 --expect，
				// 那等于断言「改之前的样子是对的」，白跑两趟：改完代码之后这条记录的源码指纹对不上、
				// 直接作废；而照原样重跑一遍它必红，红的那一次又会按场景挡住交付，得把期望值改对再跑
				// 第三遍（真机复盘 2026-09-11）。
				RULE_SHOW: parsed.shows.filter((value) => value !== "").join(";"),
			},
			// Read-only: no View, no transaction, so the resident JVM is enough.
			cold: false,
			scenarios: null,
			notes,
		});
	}

	if (kind === "print") {
		const problem = checkPrint(parsed)[0];
		if (problem !== undefined) return err(problem);
		return ok({
			kind,
			target,
			probe: RUN_PROBES.print,
			env: {
				PRINT_TPL: target,
				PRINT_PK: billOf(flags),
				PRINT_SET: set,
				PRINT_EXPECT: expects,
				PRINT_SHOW: parsed.shows.filter((value) => value.trim() !== "").join(";"),
				// --set 改值、保存（S27 起真提交）再出打印。提交走平台正常保存，缓存跟着刷新，
				// 所以和只读的出预览一样走常驻进程——打印引擎预热一次约 35 秒，只付一次。
			},
			cold: false,
			scenarios: null,
			notes,
		});
	}

	if (kind === "call") {
		const problem = checkCall(parsed)[0];
		if (problem !== undefined) return err(problem);
		return ok({
			kind,
			target,
			probe: RUN_PROBES.call,
			env: {
				CALL_TARGET: target,
				CALL_ARGS: flags.args ?? "[]",
				CALL_EXPECT: expects,
			},
			// S27 起真提交：方法写库就真的写了，和 run op 一样走常驻进程。
			cold: false,
			scenarios: null,
			notes,
		});
	}

	if (kind === "push") {
		const problem = checkPush(parsed)[0];
		if (problem !== undefined) return err(problem);
		return ok({
			kind,
			target,
			probe: RUN_PROBES.push,
			env: {
				PUSH_RULE: target,
				PUSH_PK: billOf(flags),
				PUSH_EXPECT: expects,
				PUSH_SHOW: parsed.shows
					.flatMap((value) => value.split(","))
					.map((value) => value.trim())
					.filter((value) => value !== "")
					.join(";"),
			},
			// 目标单保存后回读，插件自己写库照常提交；和 run op 一样走常驻进程。
			cold: false,
			scenarios: null,
			notes,
		});
	}

	if (kind === "wf") {
		const problem = checkWf(parsed)[0];
		if (problem !== undefined) return err(problem);
		const hash = target.indexOf("#");
		return ok({
			kind,
			target,
			probe: RUN_PROBES.wf,
			env: {
				// WF_CLASS 在 checkWfTarget 里按源码认好再填
				WF_METHOD: hash < 0 ? "" : target.slice(hash + 1),
				WF_PK: billOf(flags),
				WF_ENTITY: third ?? "",
				WF_NODE: (flags.node ?? "").trim(),
				WF_CTX: parsed.ctxs.filter((value) => value.trim() !== "").join(";"),
				WF_SET: set,
				WF_EXPECT: expects,
				WF_SHOW: parsed.shows
					.flatMap((value) => value.split(","))
					.map((value) => value.trim())
					.filter((value) => value !== "")
					.join(";"),
			},
			// 插件保存单据是真提交；和 run op 一样走常驻进程。
			cold: false,
			scenarios: null,
			notes,
		});
	}

	if (kind === "flow" || kind === "callback") {
		// 两个都给就说不清这次驱动的是哪条链路，而输出里只会剩下走通的那一条
		if (flags["child-op"] !== undefined && flags["child-click"] !== undefined) {
			return err(
				invalid(
					"子页动作 --child-op 与 --child-click 只能给一个",
					"确认动作是操作就用 --child-op，是按钮控件就用 --child-click；不知道是哪种就都别给，默认那条会自己认。",
					{ "child-op": flags["child-op"], "child-click": flags["child-click"] },
				),
			);
		}
	}

	if (kind === "flow") {
		if (parentActions(flags).length !== 1) {
			return err(
				invalid("run flow 必须且只能给一个父动作：--click、--op 或 --hyperlink", "三选一。", {
					click: flags.click ?? null,
					op: flags.op ?? null,
					hyperlink: flags.hyperlink ?? null,
				}),
			);
		}
		return ok({
			kind,
			target,
			probe: RUN_PROBES.flow,
			env: {
				FLOW_PARENT: target,
				FLOW_PK: billOf(flags),
				FLOW_PARENT_CLICK: flags.click ?? "",
				FLOW_PARENT_OP: flags.op ?? "",
				FLOW_PARENT_HYPERLINK: flags.hyperlink ?? "",
				FLOW_TOOLBAR: flags.toolbar ?? "",
				FLOW_SELECT: flags.select ?? "",
				FLOW_CHILD: flags.child ?? "",
				FLOW_PARENT_ENTRY: flags["parent-entry"] ?? "",
				FLOW_PARENT_SET: set,
				FLOW_CHILD_SET: parsed.childSets.filter((value) => value !== "").join(";"),
				FLOW_CHILD_OP: flags["child-op"] ?? "",
				FLOW_CHILD_CLICK: flags["child-click"] ?? "",
				FLOW_EXPECT: expects,
				FLOW_SKIP: flags.skip ?? "",
			},
			// S27 起父子两页上的动作都真提交，走常驻进程。
			cold: false,
			scenarios: null,
			notes,
		});
	}

	if (kind === "callback") {
		if (third === undefined || third === "" || flags.callback === undefined) {
			return err(
				invalid(
					"run callback 必须给父表单、子表单和 --callback 父插件类[:actionId]",
					"写成 run callback <父表单> <子表单> --callback <父插件类>:<actionId>。",
					{ child: third ?? null, callback: flags.callback ?? null },
				),
			);
		}
		const cut = flags.callback.indexOf(":");
		return ok({
			kind,
			target,
			probe: RUN_PROBES.callback,
			env: {
				CALLBACK_PARENT: target,
				CALLBACK_CHILD: third,
				CALLBACK_CLASS: cut < 0 ? flags.callback : flags.callback.slice(0, cut),
				CALLBACK_ACTION: cut < 0 ? "" : flags.callback.slice(cut + 1),
				CALLBACK_PARENT_ENTRY: flags["parent-entry"] ?? "",
				CALLBACK_PARENT_SET: set,
				CALLBACK_CHILD_SET: parsed.childSets.filter((value) => value !== "").join(";"),
				CALLBACK_CHILD_OP: flags["child-op"] ?? "",
				CALLBACK_CHILD_CLICK: flags["child-click"] ?? "",
				CALLBACK_EXPECT: expects,
				CALLBACK_SKIP: flags.skip ?? "",
			},
			// S27 起子页上的动作真提交，走常驻进程。
			cold: false,
			scenarios: null,
			notes,
		});
	}

	if (kind === "op") {
		const unsaved = stateNotArranged(
			flags.op ?? third ?? "save",
			billOf(flags),
			parsed.sets.filter((value) => value !== ""),
			parsed.expects.filter((value) => value !== ""),
			null,
		);
		if (unsaved !== null) return err(unsaved);
		return ok({
			kind,
			target,
			probe: RUN_PROBES.op,
			env: {
				OP_ENTITY: target,
				// `--op` wins over the positional, the same way it does inside a `--case`
				// segment (composeOpCases). Reading only the positional here meant
				// `run op <单据> --op audit` silently ran `save`.
				OP_NAME: flags.op ?? third ?? "save",
				OP_SET: set,
				OP_PK: billOf(flags),
				OP_COUNT_FILTER: parsed.filters[0] ?? "",
				OP_EXPECT: expects,
			},
			// S27: the operation commits through the platform's own path, the way a
			// user's click does, so the resident JVM's caches follow it. It used to
			// roll back, and a rollback leaves caches nobody guarantees were reset --
			// that, not the write, is what forced a cold process each time.
			cold: false,
			scenarios: null,
			notes,
		});
	}

	if (kind === "list") {
		// --set / --pk / --f7 are refused by checkAccepted above, with the same
		// reason in the remedy; one place decides what a kind reads.
		const limit = Number(flags.limit ?? 20);
		if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
			return err(
				invalid("--limit 必须是 1..200 的整数", "改成 1 到 200 之间的整数。", { limit: flags.limit ?? null }),
			);
		}
		const primaryKeys = ["click", "op", "row-click", "row-double-click", "hyperlink", "tree-node", "tree-toolbar"];
		const primaries = primaryKeys.filter((key) => flags[key] !== undefined && flags[key] !== "");
		if (primaries.length > 1) {
			return err(
				invalid(
					`run list 一次只能给一个主交互参数：${primaryKeys.map((key) => `--${key}`).join("/")}`,
					"--callback 可以跟在主交互后面，主交互本身只能有一个。",
					{ given: primaries },
				),
			);
		}
		const desktopOnly = ["main-org", "tree-node", "tree-toolbar"].filter((key) => flags[key] !== undefined);
		if (flags.mobile === "1" && desktopOnly.length > 0) {
			return err(
				invalid(
					`run list --mobile 不和 ${desktopOnly.map((key) => `--${key}`).join("、")} 一起用`,
					"移动端列表没有电脑端筛选栏里的主组织，也没有左树；要验这些去掉 --mobile 跑电脑端列表。",
					{ given: desktopOnly },
				),
			);
		}
		return ok({
			kind,
			target,
			probe: RUN_PROBES.list,
			env: {
				LIST_FORM: target,
				LIST_FILTER: parsed.filters.filter((value) => value !== "").join(";"),
				LIST_MAIN_ORG: flags["main-org"] ?? "",
				LIST_LIMIT: String(limit),
				LIST_SUMMARY: flags.summary ?? "",
				LIST_MOBILE: flags.mobile ?? "",
				LIST_SELECT: flags.select ?? "",
				LIST_CLICK: flags.click ?? "",
				LIST_OP: flags.op ?? "",
				LIST_ROW_CLICK: flags["row-click"] ?? "",
				LIST_ROW_DOUBLE_CLICK: flags["row-double-click"] ?? "",
				LIST_HYPERLINK: flags.hyperlink ?? "",
				LIST_CALLBACK: flags.callback ?? "",
				LIST_TREE_NODE: flags["tree-node"] ?? "",
				LIST_TREE_TOOLBAR: flags["tree-toolbar"] ?? "",
				LIST_CACHE: parsed.caches.filter((value) => value !== "").join(";"),
				LIST_SKIP: flags.skip ?? "",
				LIST_EXPECT: expects,
				LIST_EVENTS: flags.events ?? "",
				LIST_CALLS: flags.calls ?? "0",
			},
			// 按钮、操作 S27 起真提交，和只看列表一样走常驻进程。
			cold: false,
			scenarios: null,
			notes,
		});
	}

	// form
	//
	// `--select` 在 list 上是主键、在 form 上是分录行号，同名不同意思。写混了不能放过去：
	// 一个 pk 字符串会被探针当行号解析，抛出来的是 NumberFormatException，看不出是这里写错了。
	const selectError = flags.select === undefined ? null : checkFormSelect(flags.select);
	if (selectError) return err(selectError);
	const statusError = checkFormStatus(flags);
	if (statusError) return err(statusError);
	const actionError = formActionError(flags);
	if (actionError) return err(actionError);
	if (flags["real-cache"] === "1" && flags.schedule === "1") {
		return err(
			invalid(
				"--real-cache 和 --schedule 不能一起用",
				"--real-cache 单独起冷进程，跑完就退；调度服务只在常驻进程里起，派出去的后台任务要它接着执行。两个只留一个。",
				{ flags: ["--real-cache", "--schedule"] },
			),
		);
	}
	return ok({
		kind,
		target,
		probe: RUN_PROBES.form,
		env: {
			FORM_ENTITY: target,
			FORM_SET: set,
			FORM_PK: billOf(flags),
			FORM_OP: flags.op ?? "",
			FORM_CLICK: flags.click ?? "",
			FORM_HYPERLINK: flags.hyperlink ?? "",
			FORM_SKIP: flags.skip ?? "",
			FORM_F7: flags.f7 ?? "",
			FORM_CACHE: parsed.caches.filter((value) => value !== "").join(";"),
			FORM_SHOW: parsed.shows.filter((value) => value !== "").join(";"),
			FORM_EXPECT: expects,
			FORM_EVENTS: flags.events ?? "",
			FORM_CALLS: flags.calls ?? "0",
			// 分录选中行。`--select 分录标识=0,2`；`分录标识=` 是显式的「一行没选」。
			// 不给时探针按 `--set` 写过的行模拟选中 —— 当前行喂 getValue，选中行喂
			// getSelectRows()，两者不是一回事，而一个 donothing 计算按钮读的正是后者。
			FORM_SELECT: flags.select ?? "",
			FORM_REAL_CACHE: flags["real-cache"] ?? "",
			FORM_TOOLBAR: flags.toolbar ?? "",
			FORM_STATUS: flags.status ?? "",
		},
		// A real-cache run writes temporary Redis keys and needs its own JVM/session,
		// or the resident SessionManager pollutes the conclusion. Buttons and
		// operations commit since S27 and stay on the resident JVM.
		cold: flags["real-cache"] === "1",
		scenarios: null,
		notes,
	});
}

export interface RunOptions {
	raw?: boolean;
	hooks?: FastHooks;
	/** Prepared before freshness; passing it prevents a second parse before the JVM. */
	preparation?: RunPreparation;
	/**
	 * 交互界面用的进度回调，原样转给底下那次 probe。
	 *
	 * run 的时间几乎全在 probe 里：一次冷启动 30-60 秒，带 --case 的批量还要更久。
	 * 不转下去的话，界面只知道「run 开始了」，然后一分钟没有下文。
	 */
	onProgress?: (stage: ProbeProgressStage) => void;
	/**
	 * 本次会话已有的验证记录编号。只用来在这次运行顶掉同场景的一条 PASS 时当场说一句——
	 * finish 按场景只认最后一次，不说的话要到交付时才发现（zlgd_ygpt2.0 复盘，2026-09-17）。
	 */
	sessionEvidence?: readonly { id: string }[];
}

export interface EvidenceOutcomeReport {
	/** The records this run filed: one per asserting scenario. */
	filed: AssertionEvidence[];
	/** Why nothing was filed, when nothing was -- chiefly「这次没带 --expect」. */
	notes: string[];
}

export interface RunReport extends ProbeOutcome {
	kind: RunKind;
	target: string;
	/** Batch scenarios, when `--case` was used. */
	scenarios: BatchScenario[] | null;
	/**
	 * 验证记录（S22.1.2）：这次运行断言了什么、结果如何。
	 *
	 * After S22 this is what `finish` grades on. Filed for failures and errors
	 * too, never only the greens: the pool has to be able to answer 「这个场景最后
	 * 一次是不是过的」, or a failure could be bypassed by running something easier.
	 */
	evidence: EvidenceOutcomeReport;
}

/**
 * 这次没过的运行顶掉了本次会话里同一场景上一条过了的记录时，当场说清。
 *
 * 场景键不含 `--expect`（D19.1：改对期望再跑是正常纠错），所以拿同一组 --pk / --set 故意跑一条
 * 反例，就把前面那条正例的 PASS 换成了 FAIL。规则本身不改，只是不能让人到 finish 才知道。
 */
function replacedPass(
	ctx: KernelContext,
	session: readonly { id: string }[],
	record: AssertionEvidence,
): string | null {
	if (record.result === "PASS") return null;
	let previous: AssertionEvidence | null = null;
	for (const entry of session) {
		const earlier = readEvidence(ctx, entry.id);
		if (earlier === null || earlier.scenarioKey !== record.scenarioKey) continue;
		if (previous === null || Date.parse(earlier.at) >= Date.parse(previous.at)) previous = earlier;
	}
	if (previous === null || previous.result !== "PASS") return null;
	return (
		`这次和 ${previous.id} 是同一个场景（命令去掉 --expect 之后一样），交付只认同一场景的最后一次：` +
		`那次的 PASS 已经被这次的 ${record.result} 顶掉，现在这个场景算没过，finish 只出 PARTIAL 部分完成回执，不记为已交付。` +
		"只有同一场景真实通过才能替换失败。先读原日志核对现场，已落库的操作不要为改断言而重复执行；反例要留作通过证据，断言应符合预期。"
	);
}

/**
 * Files one verification record per asserting scenario (S22.1.2).
 *
 * A record is not an asset: it is the fact that this code was exercised in this
 * environment just now, and it claims nothing about tomorrow. That is exactly
 * what the candidate-case pool S22 deleted got wrong -- it turned the same run
 * into an asset the next delivery would have to re-run.
 *
 * The source fingerprint comes from immediately before the run. A concurrent
 * source edit must not relabel this result as evidence for the new code.
 */
function stashEvidence(
	ctx: KernelContext,
	plan: RunPlan,
	argv: readonly string[],
	outcome: ProbeOutcome,
	warnings: readonly string[],
	session: readonly { id: string }[],
	sourceFingerprint: string,
): EvidenceOutcomeReport {
	const at = new Date(ctx.ports.clock.now()).toISOString();
	// The same expression as VerifyResult.gates: one place decides what "which gate
	// setting was in force" means.
	const gates = { class_fresh: (ctx.env.COSMIC_STALE ?? "block").toLowerCase() };
	const filed: AssertionEvidence[] = [];
	const notes: string[] = [];
	// 这次真写了哪些表，从完整日志里认（显示给模型的那份滤掉了平台 SQL）。同一进程跑的几个场景共用一份日志。
	let writtenTables: string[] | undefined;
	try {
		writtenTables = outcome.outputFile === "" ? undefined : writtenTablesOf(ctx.ports.fs.read(outcome.outputFile));
	} catch {
		writtenTables = undefined;
	}

	const file = (input: { argv: readonly string[]; scenarioId: string | null; attributeAll: boolean }): void => {
		const built = evidenceFrom({
			argv: input.argv,
			records: outcome.json.records,
			exitCode: outcome.exitCode,
			at,
			runtimeKeyId: ctx.runtimeKeyId,
			sourceFingerprint,
			gates,
			path: outcome.path,
			warnings,
			log: outcome.outputFile,
			scenarioId: input.scenarioId,
			attributeAll: input.attributeAll,
			...(writtenTables === undefined ? {} : { writtenTables }),
		});
		if (built.evidence === null) {
			if (built.why !== null) {
				notes.push(input.scenarioId === null ? built.why : `场景 ${input.scenarioId}：${built.why}`);
			}
			return;
		}
		const replaced = replacedPass(ctx, session, built.evidence);
		if (replaced !== null) notes.push(replaced);
		if (unconfirmedPush([built.evidence]).length > 0) notes.push(PUSH_READBACK_REQUIRED);
		writeEvidence(ctx, built.evidence);
		filed.push(built.evidence);
	};

	if (plan.scenarios !== null) {
		for (const scenario of plan.scenarios) {
			if (scenario.argv.length === 0) continue;
			file({ argv: scenario.argv, scenarioId: scenario.id, attributeAll: false });
		}
	} else {
		file({ argv, scenarioId: null, attributeAll: true });
	}

	if (filed.length > 0) {
		const passed = filed.filter((entry) => entry.result === "PASS").length;
		const asserts = filed.reduce((sum, entry) => sum + entry.asserts.length, 0);
		notes.push(
			`验证记录：这次留下 ${String(filed.length)} 条（${String(passed)} 条断言全过、共 ${String(asserts)} 条断言）。` +
				`交付时 finish 只认本次会话在当前代码上留下的这类记录。`,
		);
	}
	return { filed, notes };
}

function userText(user: UserCandidate): string {
	const account = user.username === "" ? `工号 ${user.number}` : `用户名 ${user.username}`;
	return `${user.name === "" ? user.username || user.number : user.name}（${account}，id ${user.id}）`;
}

/**
 * `--user` 的值换成用户 id：用户名、工号、姓名、id 里唯一对得上的那个启用用户。
 *
 * 只按完全相同认，不按「包含」挑：身份认错了，权限、数据范围的结论全是别人的，
 * 结果照样像模像样。对不上或对上几个，拦下并列出查到的人。
 * 查询本身是只读的，不算进「同一个问题问过几遍」的账：同一个人连着跑几次是正常的。
 */
async function resolveRunUser(ctx: KernelContext, want: string): Promise<KernelResult<UserCandidate>> {
	const key = want.trim();
	const found = await lookupUsers(ctx, key, { countRepeats: false, invocation: `run --user ${key}` });
	if (!found.ok) return err(found.error);
	const lower = key.toLowerCase();
	const exact = found.value.candidates.filter(
		(one) =>
			one.id === key ||
			one.username.toLowerCase() === lower ||
			one.number.toLowerCase() === lower ||
			one.name === key,
	);
	const ids = [...new Set(exact.map((one) => one.id))];
	if (ids.length === 1) return ok(exact[0] as UserCandidate);
	const listed = (ids.length > 1 ? exact : found.value.candidates).slice(0, 8).map(userText);
	return err(
		new KernelError(
			"RUN_ARGS_INVALID",
			ids.length > 1
				? `--user ${key} 对得上 ${ids.length} 个用户，认不出是哪一个`
				: `--user ${key} 没有对得上的启用用户（按用户名、工号、姓名、id 完全相同找）`,
			{
				detail: { flag: "--user", value: key, candidates: listed },
				remedy:
					(listed.length > 0 ? `查到的人：${listed.join("；")}。` : "关键字一个人也没查到。") +
					"--user 写其中一个的用户名或 id；没有合适的人就先造一个启用的用户。",
			},
		),
	);
}

export async function run(
	ctx: KernelContext,
	argv: readonly string[],
	options: RunOptions = {},
): Promise<KernelResult<RunReport>> {
	const prepared = options.preparation ?? prepareRunInvocation(ctx, argv);
	if (prepared.blockers.length > 0 || prepared.plan === null) {
		// Every blocker, not the first one: the CLI path used to report exactly one
		// and hand the next one back a round trip later (S15.5.3).
		return err(prepareKernelError("RUN_PRECHECK_FAILED", "run 在 freshness/JVM 前发现阻碍", prepared));
	}
	const plan = prepared.plan;

	// Which packages are ours is a fact about the project, and planRun is pure, so
	// it is attached here. OpSandbox uses it for one thing only: saying whether the
	// exception it just printed has any of this project's classes on its stack --
	// 「平台的问题还是我的插件的问题」, which a stack alone does not answer.
	const ownPrefixes = projectPackagePrefixes(ctx);
	// call uses the same list the other way round: a class outside it is refused before it is loaded.
	const ownPackages = plan.kind === "op" || plan.kind === "call" || plan.kind === "push" ? ownPrefixes.join(",") : "";
	// Before the run, never after: the whole value of this check is that it
	// happens while the run is still free to be fixed.
	const mustInput = await noteMustInput(ctx, plan);
	// S27：会落库的运行和 APPLY 同理——跑一次世界就变了。它自己不记「问过了」的账，
	// 跑之前把整本账清掉：之前问出的答案（包括同一条命令上次的输出）都可能已经不对。
	// 2026-09-19 真机：还原一张单的备注，因为三次前跑过同一条命令，被当成「问过三遍」拦下，
	// 可中间另一次运行已经把那格改掉了。
	const commits = runCommits(argv);
	if (commits) forgetRepeats(ctx);
	const runAs = plan.user === undefined ? null : await resolveRunUser(ctx, plan.user);
	if (runAs !== null && !runAs.ok) return err(runAs.error);
	const sourceFingerprint = (await captureFreshnessAsync(ctx)).sourceFingerprint;
	const outcome = await probe(ctx, plan.probe, {
		mayCommit: commits,
		// 操作会连带打印、附件和工作流；批量场景共用一次宿主执行，不能一起挤进普通查询的两分钟。
		...(plan.kind === "op" || plan.kind === "push"
			? { timeoutMs: Math.min(10, 5 * (plan.scenarios?.length ?? 1)) * 60_000 }
			: {}),
		...(commits ? { countRepeats: false } : {}),
		...(argv.includes("--schedule") ? { schedule: true } : {}),
		kernelEnv: true,
		env: {
			...(ownPackages === ""
				? plan.env
				: { ...plan.env, [plan.kind === "call" ? "CALL_PKGS" : "OP_PKGS"]: ownPackages }),
			...(runAs === null ? {} : { COSMIC_USER: runAs.value.id }),
			// A class that will not load while its .class file sits in one of these is a classpath fault, not a missing compile.
			...(plan.kind === "call"
				? {
						CALL_CLASS_DIRS: ctx.layout.moduleDirs
							.map((module) => module.out)
							.join(ctx.platform === "win32" ? ";" : ":"),
					}
				: {}),
		},
		cold: plan.cold,
		ownPackages: ownPrefixes,
		classSources: false,
		...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
		hooks: options.hooks,
		raw: options.raw,
		invocation: `run ${argv.join(" ")}`,
	});
	if (!outcome.ok) return err(outcome.error);

	// The warnings a record carries are the ones the reader has to weigh before
	// believing it -- the same list that leads `notes` below, so the receipt can
	// reproduce them months later without the run's own output still being around.
	const evidence = stashEvidence(
		ctx,
		plan,
		argv,
		outcome.value,
		prepared.warnings,
		options.sessionEvidence ?? [],
		sourceFingerprint,
	);
	return ok({
		...outcome.value,
		// Prepare warnings lead. They are what the run could not refuse but the
		// reader has to weigh before believing the result -- a PASS on a form whose
		// plugin list never contained the class under test is the case in point.
		notes: [
			...(runAs === null ? [] : [`以 ${userText(runAs.value)}的身份跑`]),
			...prepared.warnings,
			...mustInput,
			...plan.notes,
			...outcome.value.notes,
			...evidence.notes,
		],
		kind: plan.kind,
		target: plan.target,
		scenarios: plan.scenarios,
		evidence,
	});
}
