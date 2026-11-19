/**
 * `meta <family> <action> …` argument parsing (S5.4).
 *
 * Ported from the frozen tools/metacmd.mjs, which was already a pure module for
 * the reason stated in its own header -- it touches neither Cosmic nor the
 * filesystem, so it can be tested without either. That property is kept: this
 * file decides WHICH probe runs and WHAT env it gets, and commands/meta.ts does
 * the running.
 *
 * Why one `meta` command instead of three top-level botp / ptpl / wf commands:
 * the three families share one set of actions (list / dump / backup / diff plus
 * their own writes or measurements). The frozen reason was the skill's byte
 * budget; the agent's reason is the same budget under a different name -- every
 * registered tool name is resident in the system prompt (S7.5), and three names
 * where one will do spends it for nothing. The family is the first argument.
 *
 * Two things deliberately did NOT change:
 *   - the argv shape. `reference/meta-cmd.md`, `metadata-botp.md` and
 *     `print-template.md` document these exact invocations, and they ship as
 *     skills; a renamed flag turns three documents into wrong ones.
 *   - which env var each flag sets. The probes read them by name; a "tidier"
 *     name here is a probe that silently sees no input at all.
 */

import { KernelError } from "../errors.ts";
import { writePlanDigest } from "../policy/write-plan.ts";
import type { EditOp } from "./ptpl-edit.ts";

export interface MetaFamily {
	title: string;
	actions: readonly string[];
}

/** family -> its actions. `diff` is always offline; everything else starts a probe. */
export const META_FAMILIES: Readonly<Record<string, MetaFamily>> = {
	botp: { title: "BOTP 转换规则", actions: ["list", "dump", "backup", "restore", "diff"] },
	formula: { title: "公式函数目录（只读）", actions: ["print", "form", "biz"] },
	ptpl: {
		title: "打印模板",
		actions: ["list", "dump", "locate", "backup", "edit", "apply", "restore", "measure", "diff"],
	},
	wf: { title: "工作流模型（只读，没有写通道）", actions: ["list", "dump", "backup", "diff"] },
};

export const META_HELP = `用法：cosmic_meta argv=["<botp|ptpl|wf|formula>", "<动作>", …]

公式函数（只读；不带筛选只报分类和数量，不把全目录倒进返回）
  formula print [--name 函数名 | --q 关键字 | --group 分类] [--page N] [--limit 1..3]
  formula form  [--name 函数名 | --q 关键字 | --group 分类] [--actions] [--page N] [--limit 1..3]
  formula biz   [--name 函数名 | --q 关键字 | --group 分类] [--actions] [--page N] [--limit 1..3]
                                              form 查界面规则，biz 查业务规则；--actions 查询动作而非表达式函数
                                              --name 精确匹配；--q 按用途/说明查；--group 按分类查，翻页接着给 --page

BOTP 转换规则（cosmic_knowledge action=show path=metadata-botp.md）
  botp list  [源单通配] [--target 目标单] [--rule 关键字|id] [--plugin 类名关键字]
  botp dump  <规则id|名称关键字> [--fields]   规则内容：插件/条件/分录映射，--fields 再加字段映射
  botp backup <目录> (--rule id,… | --source 源单 [--target 目标单] [--name 关键字] [--enabled 0|1|*])
                                              每条规则一个 <id>.xml，只读，不需要 apply
  botp restore <目录>                         把目录里的 xml 写回；apply=true 才落库
  botp diff  <目录A> <目录B>                  离线比两次 backup

打印模板（cosmic_knowledge action=show path=print-template.md）
  ptpl list  (--form 单据标识 | --numbers 编码,编码)
  ptpl dump  <模板编码> [--out 目录]           设计 JSON + 多语言映射落本地，diff 的输入
             [--audit [--control 控件] [--detail] [--strict]]   改成拓扑审计
             [--grid 表格id]                   改成网格摊平（行列下标表）
             [--overview]                      改成整张模板的结构概览：绑了哪些字段、每格绑什么（先看这个）
  ptpl locate <模板编码> <控件key>             只读定位；返回节点路径、类型、绑定字段和 formulaData
  ptpl backup <模板编码> [目录]                官方导出链的 ZIP 备份
  ptpl edit  <候选目录> --open <dump目录>        开一份候选：dump 的产物复制进来，之后全在本地改
             [--status] [--reset] [--overview [--grid 表格]]
             [--formula 控件 --line "表达式" … [--blank 兜底文字]]   字段写成 <字段标识>，多给一行就是上下换行
             [--bind 控件=字段] [--text 控件=文字]
             [--clone 控件 [--row N] [--col N]] [--delete 控件] [--move 控件 --row N --col N]
             [--grid 表格 (--insert-row N [--copy-row N] | --delete-row N | --insert-col N [--width W] | --delete-col N)]
                                              行列号从 1 数；--insert-row N 是新行成为第 N 行（原第 N 行往下挪），
                                              要接在第 N 行后面就给 N+1。dump --grid 表里的下标从 0 数，差 1
             [--plugin 类全名 [--desc 说明]] [--remove-plugin 类全名]
                                              登记 / 撤掉打印插件：接在已有插件后面，已有的原样保留；--overview 列出登记着哪些
                                              **本地改，不落库**：改完用 ptpl apply --file 整份交回
  ptpl apply <模板编码> --set <控件>.<属性>=<值> … --backup 目录
                                              改设计属性（只能改已存在的标量：字号、宽度、是否显示）
  ptpl apply <模板编码> --file <设计数据json> [--locale <多语言json>] [--pk 单据ID] --backup 目录
                                              整份提交：加控件、加表格、改公式走这条。
                                              文件就是 ptpl dump 出来的 *.meta.json，本地改完整份交回。
                                              落库前程序自己比差异、改过的公式当场试算、过平台解析和拓扑审计；
                                              给 --pk 再用候选在那张单上出一次预览（不落库）；apply=true 才落库，落库后回读核对
  ptpl restore <模板编码> <备份目录> --backup 目录
                                              整份恢复：把 --backup 目录里那份原样写回去。
                                              和整份提交同一条路：照样比差异、照样核版本，不覆盖别人后来的改动；
                                              apply=true 才落库
  ptpl measure <模板编码> --bill id,… [--text] [--pages 1,2] [--png 路径] [--pdf 路径]
                                              出一次 PDF 量排版（约 30 秒，可选）。格子文字对 ≠ 分页排版对
  ptpl diff  <目录A> <目录B>                  离线比两次 dump（按控件 id 对齐，不是文本 diff）

工作流模型（只读）
  wf list  [--bill 单据标识] [--key 关键字] [--max N]
  wf dump  <模型key|id> [--out 目录]
  wf backup <目录> [--bill 单据标识] [--key 关键字] [--max N]
  wf diff  <目录A> <目录B>

写通道（botp restore / ptpl apply / ptpl restore）默认 dry-run。apply=true 要附 report：工具先预演、弹确认单，
用户确认后才写，写入范围就是确认单上的范围。写在常驻进程里执行，写完同一进程马上读得到新的。
原厂和别家 ISV 的对象由 IsvGuard 拦在探针里。`;

export type MetaPlan =
	| { kind: "help"; text: string }
	| { kind: "probe"; family: string; action: string; probe: string; env: Record<string, string>; writes: boolean }
	| { kind: "diff"; family: string; action: "diff"; mode: "text" | "design"; a: string; b: string }
	//本地结构编辑：只改候选目录里的文件，不起 JVM，所以和 diff 一样是离线计划（S32 批 2）
	| { kind: "edit"; family: "ptpl"; action: "edit"; dir: string; op: EditOp };

/**
 * `META_HELP` 里记这一个动作的那几行。
 *
 * Read out of the help rather than written a second time, so a refusal can never
 * carry a usage the help has since moved on from -- the same reason the probe
 * boundary prompt is generated from `WRITE_APIS` instead of restating it.
 *
 * Continuation lines (the deeper-indented ones under `ptpl dump`, `ptpl apply`
 * and `botp backup`) come along: they are where the optional shapes live, and a
 * first line alone would answer 「怎么调」 with half the answer.
 */
/**
 * 这串 argv 会不会走到写通道 —— 只问「有没有写通道」，与 `apply` 无关。
 *
 * Answered by running the parser rather than by keeping a second list of action
 * names: a list is a duplicate fact source, and the whole value of this
 * predicate is being exactly as right as the thing that decides. `botp restore`
 * and `ptpl apply` are the two today; a third one added to `META_FAMILIES` is
 * covered here the moment it parses.
 *
 * An argv that does not parse is **not** a write: the kernel refuses it as a
 * parameter error with the usage for that action attached, which is a better
 * answer than a phase gate speaking on its behalf.
 */
export function metaWrites(argv: readonly string[]): boolean {
	const plan = parseMeta(argv);
	return plan.ok && plan.value.kind === "probe" && plan.value.writes;
}

/**
 * 「同一次操作」的指纹：一次 dry-run 和后来那次 apply 是不是同一回事。
 *
 * Hashed over the PLAN, not over the argv, because argv is one of several ways
 * to write the same call -- `--set a.b=1` and `--set=a.b=1` are the same
 * operation and `ptpl apply t --set a.b=1 --backup d` reorders freely. The plan
 * is what the kernel acts on: family, action, probe class and the env the probe
 * reads. Two argvs with the same plan do the same thing; two plans that differ
 * anywhere differ in something a probe can see.
 *
 * That is the point of it. `cosmic_authorize` used to record only the target
 * list, so a user who confirmed `--set head.visible=1` had also, as far as the
 * gate could tell, confirmed `--set head.visible=0` -- same template, same
 * target, opposite change. The env carries the values, so a digest over the env
 * carries them into the authorization.
 *
 * `undefined` for anything that is not a probe plan (help, `diff`, an argv that
 * does not parse): there is no operation to bind, and a caller that needs one
 * must treat the absence as "no evidence", never as "matches".
 *
 * S18: the digest is `writePlanDigest(probe, env)` -- family and action are
 * already implied by the probe and its env -- so `ptpl apply` and a direct
 * `PrintTplWriteProbe` call with the same inputs are the same operation.
 */
export function metaOperationDigest(argv: readonly string[]): string | undefined {
	const plan = parseMeta(argv);
	if (!plan.ok || plan.value.kind !== "probe") return undefined;
	return writePlanDigest(plan.value.probe, plan.value.env);
}

/** The probe and env a write-channel argv runs, or null when the argv has no write channel. */
export function metaWritePlan(argv: readonly string[]): { probe: string; env: Record<string, string> } | null {
	const plan = parseMeta(argv);
	if (!plan.ok || plan.value.kind !== "probe" || !plan.value.writes) return null;
	return { probe: plan.value.probe, env: { ...plan.value.env } };
}

export function usageOf(family: string, action: string): string[] {
	const lines = META_HELP.split("\n");
	const head = lines.findIndex((line) => new RegExp(`^ {2}${family} +${action}\\b`).test(line));
	if (head < 0) return [];
	const out = [(lines[head] as string).trim()];
	for (let i = head + 1; i < lines.length; i++) {
		const line = lines[i] as string;
		if (!/^ {5,}/.test(line)) break;
		out.push(`  ${line.trim()}`);
	}
	return out;
}

/**
 * 报错时把这个动作的用法原样贴出来，而不是让人再去要一次帮助。
 *
 * 「meta ptpl dump 要给模板编码」 names what is missing and not what the line
 * should look like, and 「完整用法见 argv=[]」 is one more round trip to find out.
 * The action is already in the message, so the help for exactly that action can
 * ride along on the refusal that needs it.
 */
function defaultRemedy(message: string): string {
	const tail = "完整用法见 cosmic_meta argv=[]（不给参数就是帮助）。";
	const named = /meta ([a-z]+) ([a-z]+)/.exec(message);
	const usage = named ? usageOf(named[1] as string, named[2] as string) : [];
	return usage.length === 0 ? tail : `用法：\n${usage.join("\n")}`;
}

function fail(message: string, remedy = ""): KernelError {
	return new KernelError("META_ARGS_INVALID", message, { remedy: remedy || defaultRemedy(message) });
}

export interface SplitArgs {
	opts: Record<string, string | true | (string | true)[]>;
	pos: string[];
}

/**
 * Pulls `--k v` / `--k=v` / `--flag` out and returns the rest in order. A
 * repeated `--k` collects into an array -- `ptpl apply` takes several `--set`.
 */
export function splitArgs(argv: readonly string[]): SplitArgs {
	const opts: SplitArgs["opts"] = {};
	const pos: string[] = [];
	const put = (key: string, value: string | true): void => {
		const existing = opts[key];
		if (existing === undefined) {
			opts[key] = value;
			return;
		}
		opts[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] as string;
		if (!arg.startsWith("--")) {
			pos.push(arg);
			continue;
		}
		const eq = arg.indexOf("=");
		if (eq > 0) {
			put(arg.slice(2, eq), arg.slice(eq + 1));
			continue;
		}
		const key = arg.slice(2);
		const next = argv[i + 1];
		if (next === undefined || next.startsWith("--")) {
			put(key, true);
		} else {
			put(key, next);
			i++;
		}
	}
	return { opts, pos };
}

const text = (value: string | true | (string | true)[] | undefined): string =>
	value === undefined || value === true ? "" : Array.isArray(value) ? String(value[value.length - 1] ?? "") : value;

/** Parses one invocation into a plan, or a KernelError describing what is wrong with it. */
export function parseMeta(argv: readonly string[]): { ok: true; value: MetaPlan } | { ok: false; error: KernelError } {
	const { opts, pos } = splitArgs(argv);
	const family = pos[0];
	if (family === undefined || opts.help !== undefined || family === "help") {
		return { ok: true, value: { kind: "help", text: META_HELP } };
	}
	const spec = META_FAMILIES[family];
	if (spec === undefined) {
		return {
			ok: false,
			error: fail(`不认识的家族「${family}」，只有 ${Object.keys(META_FAMILIES).join(" / ")}`),
		};
	}
	const action = pos[1];
	if (action === undefined) {
		return { ok: false, error: fail(`meta ${family} 后面要跟动作：${spec.actions.join(" | ")}`) };
	}
	if (!spec.actions.includes(action)) {
		return {
			ok: false,
			error: fail(`meta ${family} 没有「${action}」这个动作，只有 ${spec.actions.join(" | ")}`),
		};
	}
	const rest = pos.slice(2);
	if (action === "diff") {
		if (rest.length < 2) {
			return { ok: false, error: fail(`meta ${family} diff 要两个目录：<目录A> <目录B>`) };
		}
		return {
			ok: true,
			value: {
				kind: "diff",
				family,
				action,
				mode: family === "ptpl" ? "design" : "text",
				a: rest[0] as string,
				b: rest[1] as string,
			},
		};
	}
	if (family === "botp") return botp(action, rest, opts);
	if (family === "formula") return formula(action, rest, opts);
	if (family === "ptpl") return ptpl(action, rest, opts);
	return wf(action, rest, opts);
}

type Parsed = { ok: true; value: MetaPlan } | { ok: false; error: KernelError };

const probePlan = (
	family: string,
	action: string,
	probe: string,
	env: Record<string, string>,
	writes = false,
): Parsed => ({ ok: true, value: { kind: "probe", family, action, probe, env, writes } });

function formula(action: string, rest: readonly string[], opts: SplitArgs["opts"]): Parsed {
	const usage = usageOf("formula", action).join("\n");
	const bad = (why: string): Parsed => ({
		ok: false,
		error: fail(`meta formula ${action} ${why}`, `用法：\n${usage}`),
	});
	if (rest.length > 0) return bad("不接位置参数，请用 --name、--q 或 --group");
	const allowed = new Set(["name", "q", "group", "actions", "page", "limit"]);
	for (const [key, value] of Object.entries(opts)) {
		if (!allowed.has(key)) return bad(`不认识 --${key}`);
		if (Array.isArray(value)) return bad(`--${key} 只能给一次`);
		if (key === "actions" ? value !== true : value === true) return bad(`--${key} 的写法不对`);
	}
	if (action === "print" && opts.actions !== undefined) return bad("打印函数没有规则动作目录");
	if (opts.name !== undefined && opts.q !== undefined) return bad("--name 与 --q 只能选一个");
	for (const key of ["name", "q", "group"] as const)
		if (text(opts[key]).length > 80) return bad(`--${key} 不能超过 80 个字符`);
	const page = text(opts.page) || "1";
	const limit = text(opts.limit) || "3";
	if (!/^[1-9]\d*$/.test(page) || Number(page) > 100) return bad("--page 只接受 1..100");
	if (!/^[1-3]$/.test(limit)) return bad("--limit 只接受 1..3");
	if (opts.page !== undefined && !opts.name && !opts.q && !opts.group)
		return bad("翻页前先用 --name、--q 或 --group 筛选");
	return probePlan("formula", action, "FormulaFunctionProbe", {
		FORMULA_DOMAIN: action,
		FORMULA_MODE: opts.actions === undefined ? "function" : "action",
		FORMULA_NAME: text(opts.name),
		FORMULA_QUERY: text(opts.q),
		FORMULA_GROUP: text(opts.group),
		FORMULA_PAGE: page,
		FORMULA_LIMIT: limit,
	});
}

// ---------------------------------------------------------------------- BOTP

function botp(action: string, rest: readonly string[], opts: SplitArgs["opts"]): Parsed {
	if (action === "list") {
		const env: Record<string, string> = { BOTP_DETAIL: "0" };
		// The positional is the source bill; left unset the probe applies its own
		// default (<isv>%), which is not copied here -- two copies of a default are
		// one copy too many.
		if (rest[0]) env.BOTP_SOURCE = rest[0];
		if (text(opts.source)) env.BOTP_SOURCE = text(opts.source);
		if (text(opts.target)) env.BOTP_TARGET = text(opts.target);
		if (text(opts.rule)) env.BOTP_RULE = text(opts.rule);
		if (text(opts.plugin)) env.BOTP_PLUGIN = text(opts.plugin);
		if (text(opts.max)) env.BOTP_MAX = text(opts.max);
		return probePlan("botp", action, "BotpRuleProbe", env);
	}
	if (action === "dump") {
		if (!rest[0]) return { ok: false, error: fail("meta botp dump 要给规则 id 或名称关键字") };
		// The source default is <isv>%, which filters a by-id lookup down to nothing,
		// so it is explicitly cleared.
		return probePlan("botp", action, "BotpRuleProbe", {
			BOTP_RULE: rest[0],
			BOTP_SOURCE: "",
			BOTP_DETAIL: opts.fields === undefined ? "1" : "2",
			BOTP_MAX: text(opts.max) || "30",
		});
	}
	if (action === "backup") {
		if (!rest[0]) return { ok: false, error: fail("meta botp backup 要给备份目录") };
		const env: Record<string, string> = { SYNC_BACKUP: rest[0], SYNC_BACKUP_ONLY: "1" };
		if (text(opts.rule)) env.SYNC_TARGETS = text(opts.rule);
		if (text(opts.source)) env.SYNC_SOURCE_ENTITY = text(opts.source);
		if (text(opts.target)) env.SYNC_TARGET_ENTITY = text(opts.target);
		if (text(opts.name)) env.SYNC_NAME_LIKE = text(opts.name);
		if (text(opts.enabled)) env.SYNC_ENABLED = text(opts.enabled);
		if (!env.SYNC_TARGETS && !env.SYNC_SOURCE_ENTITY && !env.SYNC_TARGET_ENTITY && !env.SYNC_NAME_LIKE) {
			return {
				ok: false,
				error: fail(
					"meta botp backup 要么 --rule id,… 要么 --source/--target/--name 选一批：不给条件等于备份全部规则",
				),
			};
		}
		return probePlan("botp", action, "BotpRuleSyncProbe", env);
	}
	// restore
	if (!rest[0]) return { ok: false, error: fail("meta botp restore 要给备份目录") };
	return probePlan("botp", action, "BotpRuleSyncProbe", { SYNC_RESTORE: rest[0] }, true);
}

// ------------------------------------------------------------- print templates

function ptpl(action: string, rest: readonly string[], opts: SplitArgs["opts"]): Parsed {
	if (action === "list") {
		const env: Record<string, string> = {};
		if (rest[0]) env.TPL_FORM = rest[0];
		if (text(opts.form)) env.TPL_FORM = text(opts.form);
		if (text(opts.numbers)) env.TPL_NUMBERS = text(opts.numbers);
		if (!env.TPL_FORM && !env.TPL_NUMBERS) {
			return { ok: false, error: fail("meta ptpl list 要 --form 单据标识 或 --numbers 编码,编码") };
		}
		return probePlan("ptpl", action, "PrintTplProbe", env);
	}
	if (action === "edit") return ptplEdit(rest, opts);
	const number = rest[0];
	if (!number) return { ok: false, error: fail(`meta ptpl ${action} 要给模板编码`) };
	if (action === "locate") {
		if (!rest[1]) return { ok: false, error: fail("meta ptpl locate 要给控件 key") };
		return probePlan("ptpl", action, "PrintTplDesignProbe", {
			TPL_NUMBER: number,
			TPL_CONTROL_KEY: rest[1],
		});
	}
	if (action === "dump") {
		if (text(opts.grid)) {
			return probePlan("ptpl", action, "PrintGridDumpProbe", { TPL_NUMBER: number, GRID: text(opts.grid) });
		}
		// 不点名表格的 PrintGridDumpProbe 就是整张模板的概览（2026-09-18 真机：模型为了知道
		// 「有没有格子绑检验项目」把设计 JSON dump 到本地自己写 python 解析，跑了 20 多次命令）。
		if (opts.overview !== undefined) {
			return probePlan("ptpl", action, "PrintGridDumpProbe", { TPL_NUMBER: number });
		}
		if (opts.audit !== undefined) {
			const env: Record<string, string> = { TPL_NUMBER: number };
			if (text(opts.control)) env.TPL_CONTROL = text(opts.control);
			if (opts.detail !== undefined) env.DETAIL = "1";
			if (opts.strict !== undefined) env.STRICT = "1";
			return probePlan("ptpl", action, "PrintTplDesignProbe", env);
		}
		const env: Record<string, string> = { TPL_NUMBER: number };
		if (text(opts.out)) env.OUT_DIR = text(opts.out);
		return probePlan("ptpl", action, "PrintTplJsonProbe", env);
	}
	if (action === "backup") {
		const env: Record<string, string> = { TPL_NUMBER: number };
		if (rest[1]) env.BACKUP_DIR = rest[1];
		if (text(opts.out)) env.BACKUP_DIR = text(opts.out);
		return probePlan("ptpl", action, "PrintTplBackupProbe", env);
	}
	if (action === "apply") {
		// 两条写法，给一个：--set 改标量属性，--file 整份提交（加控件、加表格、改公式走这条）。
		const sets = (opts.set === undefined ? [] : Array.isArray(opts.set) ? opts.set : [opts.set]).filter(
			(value): value is string => value !== true,
		);
		const wholeFile = text(opts.file);
		const badSet = sets.length === 0 || (Array.isArray(opts.set) ? opts.set : [opts.set]).some((v) => v === true);
		if (wholeFile !== "" && !badSet) {
			return { ok: false, error: fail("meta ptpl apply 的 --set 和 --file 只能给一个") };
		}
		if (wholeFile === "" && badSet) {
			return {
				ok: false,
				error: fail(
					"meta ptpl apply 要 --set <控件>.<属性>=<值>（控件写 id 或 key，可以给多个 --set），" +
						"或者 --file <设计数据 json> 整份提交（加控件、加表格、改公式走这条）",
				),
			};
		}
		const env: Record<string, string> =
			wholeFile === ""
				? { TPL_NUMBER: number, TPL_SET: sets.join(";") }
				: { TPL_NUMBER: number, TPL_FILE: wholeFile };
		if (wholeFile !== "" && text(opts.locale)) env.TPL_LOCALE = text(opts.locale);
		if (text(opts.backup)) env.TPL_BACKUP = text(opts.backup);
		// 预演时拿候选在这张单上出一次打印（S36 批 5）；只影响预演，不进写入指纹
		if (text(opts.pk)) env.PRINT_PK = text(opts.pk);
		return probePlan("ptpl", action, "PrintTplWriteProbe", env, true);
	}
	if (action === "restore") {
		// 恢复也是一次写：同一个探针、同一组关卡，只是候选那份来自备份目录（S32 3.4）。
		// 模板编码要在入参里给，不从目录里翻——授权确认单上的目标 `tpl:<编码>` 就是从这里来的，
		// 等到 JVM 里才知道写的是哪张模板，那时清单里的那一项已经用掉了。
		const dir = rest[1];
		if (dir === undefined) {
			return { ok: false, error: fail("meta ptpl restore 要给备份目录：<模板编码> <备份目录>") };
		}
		const env: Record<string, string> = { TPL_NUMBER: number, TPL_RESTORE: dir };
		if (text(opts.backup)) env.TPL_BACKUP = text(opts.backup);
		return probePlan("ptpl", action, "PrintTplWriteProbe", env, true);
	}
	// measure
	if (!text(opts.bill)) return { ok: false, error: fail("meta ptpl measure 要 --bill 单据主键（多个逗号分隔）") };
	const env: Record<string, string> = { TPL_NUMBER: number, BILL_ID: text(opts.bill) };
	if (text(opts.form)) env.FORM_ID = text(opts.form);
	if (text(opts.pages)) env.PAGES = text(opts.pages);
	if (opts.text !== undefined) env.TEXT = "1";
	if (text(opts["text-like"])) env.TEXT_LIKE = text(opts["text-like"]);
	if (text(opts.pdf)) env.PDF_OUT = text(opts.pdf);
	if (text(opts.png)) env.PNG_OUT = text(opts.png);
	return probePlan("ptpl", action, "PrintMeasureProbe", env);
}

/**
 * `ptpl edit <候选目录> <一个操作>` —— 本地结构编辑（S32 批 2）。
 *
 * 一次一个操作。给两个就报错而不是挑一个执行：这些操作互相影响（插一行之后行号全变了），
 * 默默替调用方定顺序，是把「改坏了也看不出来」做成默认行为。
 */
function ptplEdit(rest: readonly string[], opts: SplitArgs["opts"]): Parsed {
	const dir = rest[0];
	if (dir === undefined) {
		return { ok: false, error: fail("meta ptpl edit 要给候选目录（先 --open <dump目录> 开一份）") };
	}
	const num = (key: string): number | null => {
		const raw = text(opts[key]);
		if (raw === "") return null;
		const value = Number(raw);
		return Number.isFinite(value) ? value : null;
	};
	const lines = (opts.line === undefined ? [] : Array.isArray(opts.line) ? opts.line : [opts.line]).filter(
		(value): value is string => value !== true,
	);
	const row = num("row");
	const column = num("col");
	const place = {
		...(row === null ? {} : { row }),
		...(column === null ? {} : { column }),
	};

	const ops: EditOp[] = [];
	const from = text(opts.open);
	if (from !== "") ops.push({ op: "open", from });
	if (opts.status !== undefined) ops.push({ op: "status" });
	if (opts.reset !== undefined) ops.push({ op: "reset" });
	if (opts.overview !== undefined) {
		const grid = text(opts.grid);
		ops.push({ op: "overview", ...(grid === "" ? {} : { grid }) });
	}
	if (text(opts.formula) !== "") {
		const blank = opts.blank;
		ops.push({
			op: "formula",
			control: text(opts.formula),
			lines,
			...(blank === undefined || blank === true ? {} : { blankText: text(blank) }),
		});
	}
	for (const [key, op] of [
		["bind", "bind"],
		["text", "text"],
	] as const) {
		const raw = text(opts[key]);
		if (raw === "") continue;
		const eq = raw.indexOf("=");
		if (eq <= 0) {
			return {
				ok: false,
				error: fail(`meta ptpl edit --${key} 要写成 <控件>=<${key === "bind" ? "字段" : "文字"}>`),
			};
		}
		ops.push(
			op === "bind"
				? { op: "bind", control: raw.slice(0, eq), field: raw.slice(eq + 1) }
				: { op: "text", control: raw.slice(0, eq), value: raw.slice(eq + 1) },
		);
	}
	if (text(opts.clone) !== "") ops.push({ op: "clone", control: text(opts.clone), ...place });
	if (text(opts.delete) !== "") ops.push({ op: "delete", control: text(opts.delete) });
	if (text(opts.move) !== "") ops.push({ op: "move", control: text(opts.move), ...place });
	for (const flag of ["plugin", "remove-plugin"] as const) {
		if (opts[flag] === undefined) continue;
		const className = text(opts[flag]);
		if (className === "") {
			return { ok: false, error: fail(`meta ptpl edit --${flag} 要给插件的类全名（包名.类名）`) };
		}
		if (flag === "remove-plugin") ops.push({ op: "remove-plugin", className });
		else {
			const desc = opts.desc;
			ops.push({
				op: "plugin",
				className,
				...(desc === undefined || desc === true ? {} : { description: text(desc) }),
			});
		}
	}

	const grid = text(opts.grid);
	const gridOps = [
		["insert-row", "insert-row"],
		["delete-row", "delete-row"],
		["insert-col", "insert-col"],
		["delete-col", "delete-col"],
	] as const;
	for (const [flag] of gridOps) {
		const at = num(flag);
		if (at === null) continue;
		if (grid === "") {
			return { ok: false, error: fail(`meta ptpl edit --${flag} 还要 --grid <表格>，说清楚是哪张表格的第几行/列`) };
		}
		if (!Number.isInteger(at) || at < 1) {
			return {
				ok: false,
				error: fail(`meta ptpl edit --${flag} 的行/列号从 1 数起，给的是「${text(opts[flag])}」`),
			};
		}
		if (flag === "insert-row") {
			const copy = num("copy-row");
			ops.push({ op: "insert-row", grid, at, ...(copy === null ? {} : { copyFrom: copy }) });
		} else if (flag === "delete-row") ops.push({ op: "delete-row", grid, at });
		else if (flag === "insert-col") {
			const width = num("width");
			ops.push({ op: "insert-col", grid, at, ...(width === null ? {} : { width }) });
		} else ops.push({ op: "delete-col", grid, at });
	}

	if (ops.length === 0) {
		return {
			ok: false,
			error: fail(
				"meta ptpl edit 要给一个操作：--open / --status / --reset / --overview / --formula / --bind / --text / --clone / --delete / --move / --grid 加行列操作 / --plugin / --remove-plugin",
			),
		};
	}
	if (ops.length > 1) {
		return {
			ok: false,
			error: fail(
				`meta ptpl edit 一次只做一个操作，这次给了 ${ops.length} 个（${ops.map((one) => one.op).join("、")}）`,
				"分成几条命令依次跑：每条回一句话说改了什么，出错也指得到是哪一步。",
			),
		};
	}
	return { ok: true, value: { kind: "edit", family: "ptpl", action: "edit", dir, op: ops[0] as EditOp } };
}

// ------------------------------------------------------------------- workflow

function wf(action: string, rest: readonly string[], opts: SplitArgs["opts"]): Parsed {
	const env: Record<string, string> = { WF_ACTION: action };
	if (text(opts.bill)) env.WF_BILL = text(opts.bill);
	if (text(opts.key)) env.WF_KEY = text(opts.key);
	if (text(opts.max)) env.WF_MAX = text(opts.max);
	if (action === "list") return probePlan("wf", action, "WfModelProbe", env);
	if (action === "dump") {
		if (!rest[0]) return { ok: false, error: fail("meta wf dump 要给模型 key 或 id") };
		env.WF_MODEL = rest[0];
		if (text(opts.out)) env.WF_OUT = text(opts.out);
		return probePlan("wf", action, "WfModelProbe", env);
	}
	// backup
	if (!rest[0]) return { ok: false, error: fail("meta wf backup 要给备份目录") };
	env.WF_OUT = rest[0];
	return probePlan("wf", action, "WfModelProbe", env);
}
