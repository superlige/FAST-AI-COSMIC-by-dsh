/**
 * The frozen CLI command surface, and what each command became (S5.1).
 *
 * This is the machine-readable half of docs/command-parity.md. It exists as code
 * rather than only as a table in a document because three different consumers
 * need the same answer and would otherwise each invent one:
 *
 *   1. the reference-skill generator, which rewrites `driver.mjs <cmd>` writings
 *      in 25 migrated documents (S7.1 counted 137 occurrences);
 *   2. the plugin-family routing table, whose "behaviour verification" column is
 *      literally a CLI command line in the frozen source;
 *   3. the parity test, which asserts that nothing claims to be migrated without
 *      a registered tool behind it.
 *
 * The rule this file enforces: a command is `migrated` only when a real agent
 * tool executes it today. Everything else says so out loud and keeps the old
 * command word visible, because the command word is still a correct clue about
 * WHICH capability is wanted -- it is only the invocation form that is stale.
 * Inventing a tool name for an unmigrated command would replace a stale-but-
 * honest instruction with a confident wrong one.
 */

export type CommandStatus =
	/** An agent tool executes it today. `tool` is set. */
	| "migrated"
	/** Being ported right now: code exists, parity against the frozen CLI is not signed off. */
	| "comparing"
	/** Frozen behaviour is kept and still owned by a later S5 sub-task. */
	| "pending"
	/** Deliberately reshaped; the frozen invocation has no one-to-one successor. */
	| "redesigned"
	/** Has no place in an agent, with the reason recorded in the parity doc. */
	| "not-applicable";

export interface CommandMapping {
	/** The word after `driver.mjs` in the frozen CLI. */
	command: string;
	status: CommandStatus;
	/** Agent tool that performs it. Null unless status is "migrated". */
	tool: string | null;
	/**
	 * The action on `tool` that performs it, when the tool needs one to be named.
	 *
	 * Separate from `tool` rather than folded into one string, because the two
	 * fields answer to different authorities: `tool` is checked against
	 * `COSMIC_TOOL_NAMES` (a migrated command must have a REGISTERED tool behind
	 * it, which is what stops this table from claiming a migration that does not
	 * exist), while `action` is prose for the reader. S11 merged six tools into
	 * three, so most of the rows that used to name a tool of their own now name an
	 * action on a surviving one -- writing "cosmic_doctor action=rebuild" into
	 * `tool` would have kept the table readable and quietly disarmed the check.
	 */
	action?: string;
	/** S5 sub-task that owns the migration, or the stage that decided otherwise. */
	owner: string;
	/** One line for humans; also what the reference generator prints for pending commands. */
	note: string;
}

export const COMMAND_MAP: readonly CommandMapping[] = [
	{ command: "doctor", status: "migrated", tool: "cosmic_doctor", owner: "S5.1", note: "工程体检与配置出处" },
	{
		command: "knowledge",
		status: "migrated",
		tool: "cosmic_knowledge",
		owner: "S5.1",
		note: "官方知识库只读查询（status/routes/scenes/search/show/audit）",
	},
	{ command: "lint", status: "migrated", tool: "cosmic_lint", owner: "S3.1", note: "只编不留的 API 体检" },
	{
		command: "fast",
		status: "migrated",
		tool: "cosmic_fast",
		owner: "S3.3",
		note: "增量编译 + 常驻 JVM 热替换（换不进去再重启）",
	},
	{ command: "probe", status: "migrated", tool: "cosmic_probe", owner: "S3.4", note: "运行已发布探针或临时探针" },
	{
		command: "build",
		status: "migrated",
		tool: "cosmic_doctor",
		action: "action=rebuild",
		owner: "S5.2/S11",
		note: "生成 pathing jar 与 javac argfile；各命令仍会按需自己构建，显式入口是为了重建，S11 起并入 doctor 的修理口",
	},
	{
		command: "run",
		status: "migrated",
		tool: "cosmic_run",
		owner: "S5.2",
		note: "十种无头适配器：op/form/list/callback/flow/rule/print/call/push/wf；参数写法与冻结 CLI 一致",
	},
	{
		command: "verify",
		status: "redesigned",
		tool: null,
		owner: "S5.2",
		note: "没有回归用例集；断言用 cosmic_run --expect，本会话跑过哪些、过没过由 cosmic_facts 列出",
	},
	{
		command: "probe-server",
		status: "migrated",
		tool: "cosmic_runtime",
		action: "action=probe-status / probe-start / probe-stop / probe-restart",
		owner: "S5.2/S11",
		note: "常驻探针 JVM 的显式启停与归属状态；S11 起与调试节点、deploy 合成 cosmic_runtime",
	},
	{
		command: "pserver",
		status: "migrated",
		tool: "cosmic_runtime",
		action: "action=probe-status / probe-start / probe-stop / probe-restart",
		owner: "S5.2/S11",
		note: "probe-server 的别名，冻结 dispatch 里是同一分支",
	},
	{
		command: "sig",
		status: "migrated",
		tool: "cosmic_knowledge",
		action: "action=api",
		owner: "S7.2",
		note: "离线查 API 签名与常量：action=api，把反射结果与文档正文对齐后一起给",
	},
	{
		command: "findclass",
		status: "migrated",
		tool: "cosmic_knowledge",
		action: "action=findclass",
		owner: "S5.2",
		note: "反查全限定名与所在 jar：action=findclass，命中插件基类时顺带给官方入口",
	},
	{
		command: "impact",
		status: "migrated",
		tool: "cosmic_impact",
		owner: "S5.3/S11",
		note: "影响面反查；两条腿（静态离线 + 元数据连环境）互不依赖。工具只留 query：索引的 status/build 是 cosmic_doctor action=index/reindex，touches 已删除",
	},
	{
		command: "spec",
		status: "redesigned",
		tool: null,
		owner: "S14",
		note: "没有需求台账；完成情况按系统提示里的模板写，事实取自 cosmic_facts",
	},
	{
		command: "bundle",
		status: "redesigned",
		tool: null,
		owner: "S14",
		note: "没有批次台账；完成情况按系统提示里的模板写，事实取自 cosmic_facts",
	},
	{
		command: "meta",
		status: "migrated",
		tool: "cosmic_meta",
		owner: "S5.4",
		note: "非实体元数据三族 botp/ptpl/wf：list/dump/backup/diff 加 ptpl locate/edit、botp restore、ptpl apply/restore/measure；ptpl edit 只改本地候选文件，整份提交那一次顺带试算改过的公式、落库后回读核对，写通道默认 dry-run，apply 走同一道已确认目标门",
	},
	{
		command: "deploy",
		status: "migrated",
		tool: "cosmic_runtime",
		action: "action=deploy",
		owner: "S5.4/S11",
		note: "把 jar 部到本机运行时的 lib/cus 并重启常驻 JVM；取工程写锁，认不出归属的常驻 JVM 只报不动",
	},
	{
		command: "start",
		status: "migrated",
		tool: "cosmic_runtime",
		action: "action=node-start",
		owner: "S5.4/S11",
		note: "拉起调试节点；pid 记归 RuntimeKey，别的 key 起的节点当场拒绝而不是复用",
	},
	{
		command: "status",
		status: "migrated",
		tool: "cosmic_runtime",
		action: "action=node-status",
		owner: "S5.4/S11",
		note: "pid、进程存活、端口通不通、归属四项一起报",
	},
	{
		command: "logs",
		status: "migrated",
		tool: "cosmic_runtime",
		action: "action=node-logs",
		owner: "S5.4/S11",
		note: "节点进程 stdout/stderr 的尾巴，默认 40 行",
	},
	{
		command: "stop",
		status: "migrated",
		tool: "cosmic_runtime",
		action: "action=node-stop",
		owner: "S5.4/S11",
		note: "只停本 RuntimeKey 记过的 pid，从不按端口杀",
	},
	{
		command: "plugin",
		status: "redesigned",
		tool: null,
		owner: "S5.1/S7",
		note: "写插件前的根流程；知识门禁默认值由 S7 决定，不照搬「未配知识库就拒编」",
	},
	{
		command: "doc",
		status: "not-applicable",
		tool: null,
		owner: "S7.1",
		note: "自研 reference/ 已作为 pi skill 内嵌，按需注入取代了按页取节的命令",
	},
];

const BY_COMMAND = new Map(COMMAND_MAP.map((entry) => [entry.command, entry]));

export function commandMapping(command: string): CommandMapping | null {
	return BY_COMMAND.get(command) ?? null;
}

/**
 * How to write one frozen invocation today.
 *
 * `driver.mjs run form <布局>` becomes either a tool name (migrated) or the same
 * command with an explicit "not migrated yet" marker (everything else). The
 * marker names the parity document instead of a stage code so a reader who has
 * only the product in front of them can still find out what is going on.
 */
export function rewriteInvocation(command: string, rest: string): string {
	const mapping = commandMapping(command);
	const args = rest.trim();
	if (mapping === null) return `\`${command}${args ? ` ${args}` : ""}\`（未登记的命令，见 docs/command-parity.md）`;
	if (mapping.status === "migrated" && mapping.tool !== null) {
		const call = mapping.action === undefined ? mapping.tool : `${mapping.tool} ${mapping.action}`;
		return args === "" ? `\`${call}\` 工具` : `\`${call}\` 工具（${args}）`;
	}
	const label = mapping.status === "not-applicable" ? "已不适用" : "尚未迁移";
	return `\`${command}${args ? ` ${args}` : ""}\`（${label}，见 docs/command-parity.md）`;
}

/** Commands whose old invocation form is still the only one available. */
export function pendingCommands(): string[] {
	return COMMAND_MAP.filter((entry) => entry.status !== "migrated").map((entry) => entry.command);
}
