/**
 * What the official knowledge base contains, and how a query is scored (S5.1).
 *
 * Ported from the frozen tools/knowledge.mjs (c7b8815). The three hand-written
 * tables -- official guides, SDK pages, plugin-family routes -- are the part of
 * that file that is knowledge rather than code, and they are reproduced here
 * unchanged in content. Their invariants are re-asserted by tests, exactly as the
 * frozen knowledge.test.mjs did, because the tables' failure mode is silent:
 * a route pointing at a guide path that no longer exists still prints a row.
 *
 * Two deliberate departures from the frozen implementation:
 *
 *   1. Nothing here prints. The frozen functions wrote to stdout and returned an
 *      exit code; every function below returns values, and the tool layer decides
 *      how they are shown (D9). "Did this find anything" must be answerable
 *      without parsing console prose.
 *   2. The plugin-route table's "behaviour verification" column held literal CLI
 *      command lines (`driver.mjs run form <布局>`). Those are now structured
 *      references resolved through command-map.ts, so a column that names a
 *      capability cannot go on printing a command form that no longer exists
 *      once that capability migrates.
 */
import { basename } from "node:path";
import { rewriteInvocation } from "./command-map.ts";
import type { KnowledgeBase } from "./docs.ts";

export const KNOWLEDGE_GUIDES: readonly (readonly [path: string, title: string, keywords: readonly string[]])[] = [
	["platform/form-plugin.md", "表单/单据插件", ["表单", "单据", "字段", "联动", "f7", "billform", "form"]],
	["platform/list-plugin.md", "标准列表插件", ["列表", "过滤", "list", "listform"]],
	["platform/standardtreelist-plugin.md", "左树右表插件", ["左树右表", "树列表", "tree", "treelist"]],
	["platform/operation-plugin.md", "操作插件", ["操作", "事务", "校验", "operation"]],
	["platform/report-plugin.md", "报表界面插件", ["报表", "report", "界面"]],
	["platform/reportlistdata-plugin.md", "报表列表取数插件", ["报表", "取数", "dataset", "reportlistdata"]],
	["platform/reporttreedata-plugin.md", "报表树取数插件", ["报表树", "树报表", "reporttreedata"]],
	["platform/workflow-plugin.md", "工作流插件", ["工作流", "流程", "workflow"]],
	["platform/task-plugin.md", "后台任务插件", ["任务", "调度", "定时", "task"]],
	["platform/openapi-customapi-java-plugin.md", "自定义 API 插件", ["自定义api", "开放接口", "openapi", "api"]],
	["platform/openapi-ext-plugin.md", "API 扩展插件", ["api扩展", "接口扩展", "openapi"]],
	["platform/botp-plugin.md", "BOTP 转换插件", ["botp", "转换", "转换规则"]],
	["platform/writeback-plugin.md", "反写插件", ["反写", "writeback"]],
	["platform/print-plugin-guide.md", "打印插件", ["打印", "模板", "print"]],
	["platform/import-plugin.md", "批量引入插件", ["引入", "导入", "excel", "import", "batchimport"]],
	["platform/mobile-plugin.md", "移动端插件", ["移动", "手机", "mob", "mobile"]],
];

export const KNOWLEDGE_SDK: readonly (readonly [path: string, keywords: readonly string[]])[] = [
	["platform/sdk/sdk-orm-access.md", ["qfilter", "查询", "orm", "ksql"]],
	["platform/sdk/sdk-algo.md", ["dataset", "algo", "分组", "聚合"]],
	["platform/sdk/sdk-dynamic-object.md", ["dynamicobject", "动态对象"]],
	["platform/sdk/sdk-entity-model.md", ["元数据", "entitymodel", "实体模型"]],
	["platform/sdk/sdk-cache.md", ["缓存", "cache"]],
	["platform/sdk/sdk-tx.md", ["事务", "kdtx", "tx"]],
	["platform/sdk/sdk-lock.md", ["锁", "并发", "lock"]],
	["platform/sdk/sdk-threadpool.md", ["线程池", "异步", "threadpool"]],
	["platform/sdk/sdk-file.md", ["文件", "附件", "file"]],
	["platform/sdk/sdk-log.md", ["日志", "log"]],
	["platform/sdk/sdk-exception.md", ["异常", "exception"]],
	["platform/sdk/sdk-request-context.md", ["requestcontext", "用户", "租户", "上下文"]],
];

/**
 * How a behaviour-verification entry is expressed.
 *
 * `cli` is a frozen driver invocation whose rendering depends on whether that
 * command has migrated; `note` is prose that was never a command; `null` means
 * the frozen table said there is no headless adapter for this family. The three
 * are kept apart because they mean different things to a reader, and the frozen
 * table's rule -- never invent a verification entry -- only holds if "nobody
 * wrote one" stays distinguishable from "there is a way to do it".
 */
export type VerifyEntry =
	| { kind: "cli"; command: string; rest: string; why?: string }
	| { kind: "note"; text: string }
	| null;

const cli = (command: string, rest = "", why?: string): VerifyEntry =>
	why === undefined ? { kind: "cli", command, rest } : { kind: "cli", command, rest, why };

/**
 * 把一个插件类挂到元数据上的写法：哪个已发布探针、哪个入参里写哪一行。
 *
 * 写法本身在探针源码的头注释里，这里只引用：`test/kernel/probe-catalog.test.ts` 核对探针真有这个入参、
 * 头注释里真有这一行，探针改了写法这里没跟就红。
 */
export type PluginAttach =
	/**
	 * `layout`：清单里先切到单据带的哪份移动端布局再挂（`layout mobile` / `layout mobilelist`）；
	 * 独立的移动表单本身就是移动端布局，不写这一行。
	 */
	| { probe: string; input: string; line: string; layout?: "mobile" | "mobilelist" }
	/** 靠 cosmic_meta 的命令挂：`meta` 是在本地候选上登记的那条，`handBack` 是交回落库的那条。 */
	| { meta: string; handBack: string }
	/** 工具挂不了：一句话说它登记在哪、要用户去哪配。登记位置按真机元数据核过的写。 */
	| { byUser: string }
	/** 不用登记：一句话说它靠什么生效。 */
	| { inCode: string };

const layoutEdit = (line: string): PluginAttach => ({ probe: "FormLayoutWriteProbe", input: "LAYOUT_EDIT", line });
/** 单据插件、列表插件、操作插件各挂各处；探针按类实现的接口核对，挂错地方会被拒。 */
const ATTACH_FORM = layoutEdit("add plugin <类全名>");
const ATTACH_LIST = layoutEdit("add plugin <类全名> to list");
const ATTACH_OP = layoutEdit("add plugin <类全名> to op <操作>");
/** 打印插件登记在打印模板上：本地候选上登记，整份交回时探针按平台的办法核这个类找不找得到。 */
const ATTACH_PRINT: PluginAttach = {
	meta: "ptpl edit <候选目录> --plugin <类全名>",
	handBack: "ptpl apply <模板编码> --file <候选文件>",
};
/**
 * 移动端插件登记在移动端布局上：单据带的那份塞在单据布局里，写探针清单里先 layout mobile 切过去再挂；
 * 移动端列表插件登记在移动端列表上（layout mobilelist）。真机试算见 docs/S73-mobile-layout.md。
 */
const ATTACH_MOB_BILL: PluginAttach = { ...layoutEdit("add plugin <类全名>"), layout: "mobile" };
const ATTACH_MOB_LIST: PluginAttach = { ...layoutEdit("add plugin <类全名>"), layout: "mobilelist" };
const ATTACH_MOB_FORM: PluginAttach = ATTACH_MOB_BILL;
const ATTACH_REPORT_DATA: PluginAttach = {
	byUser: "登记在报表表单里报表列表控件的「查询插件」属性上，要用户在开发平台里这张报表的报表列表控件上设",
};
const ATTACH_REPORT_TREE: PluginAttach = {
	byUser: "登记在报表表单里报表树控件的插件属性上，要用户在开发平台里这张报表的报表树控件上设",
};
const ATTACH_API: PluginAttach = {
	byUser: "登记在开放平台的接口配置上（接口的实现类或接口插件），要用户在开放平台里这个接口的配置上填",
};
const ATTACH_CONVERT: PluginAttach = {
	byUser: "登记在转换规则的插件清单上（规则上每个插件另有启用开关），要用户在开发平台里这条转换规则上挂",
};
/** 平台按发起反写那张单据实体的关联配置取反写插件（`LinkSetElement.getPlugIns`），不在反写规则上。 */
const ATTACH_WRITEBACK: PluginAttach = {
	byUser: "登记在发起反写那张单据（下游单）实体的关联配置上，要用户在开发平台里这张单据的关联配置上挂",
};
const ATTACH_IMPORT: PluginAttach = {
	byUser: "登记在单据「引入数据」操作的参数里，要用户在开发平台里这个操作的参数设置上填",
};
const ATTACH_TASK: PluginAttach = {
	byUser: "登记在调度的任务定义上（一条任务定义记一个任务类），要用户在平台的调度配置里建任务定义",
};
const ATTACH_WORKFLOW: PluginAttach = {
	byUser: "登记在流程模型的节点上，要用户在流程设计器里配到那个节点",
};
const ATTACH_VALIDATOR: PluginAttach = { inCode: "由操作插件在 onAddValidators 里加上" };

export interface PluginRoute {
	/** Simple name of the base class this family is recognised by. */
	base: string;
	/** Official scene-index tag, or null when the official index never tagged this family. */
	pluginType: string | null;
	/** Official guide path, always present in KNOWLEDGE_GUIDES. */
	guide: string;
	/**
	 * Probe whose output names the classes registered at this family's place, or null when no probe does.
	 * `PluginIndexProbe` is not one: run on its own it prints counts per place, the class names go to the
	 * side channel that builds the index — `cosmic_impact` is what answers "where is this class registered".
	 */
	bind: string | null;
	/**
	 * 这一族的类还没挂上时怎么办，每一族都要有个说法：工具能挂的写命令，挂不了的写登记在哪、要用户去哪配，
	 * 不用登记的写靠什么生效。空着的话模型只能猜工具能不能挂。
	 * 能挂的只填真机验过的：单据、列表、操作插件（docs/S42-form-meta-edit.md §13.6），打印插件（docs/S66），
	 * 报表界面插件（docs/S67）；挂不了的登记位置出处见 docs/S67-plugin-registration-audit.md §2。
	 */
	attach: PluginAttach;
	verify: VerifyEntry;
	/** Our own runtime-delta page, a reference skill document name. */
	local: string;
	/**
	 * 知识卡片的内容：`local` 那篇里「必知要点」那一节的标题，人写、按平台概念写（S45 批 4）。
	 * null = 这一族还没写要点，不推卡片——推一张只有基类名和出处的空卡，模型白读一遍。
	 */
	essentials: string | null;
	/** Section name in the browser-boundary audit. Null means "never audited", NOT "no browser needed". */
	browser: string | null;
}

/**
 * Plugin-family routes: one family per row, eight facts each.
 *
 * The four rules the frozen table states, kept verbatim in force:
 *   1. `pluginType: null` means the official scene index never tagged this
 *      family. Inventing a tag would silently widen every --plugin-type filter.
 *   2. `bind` / `verify` may be null. A made-up verification entry is worse than
 *      an admitted gap, because it fails at the moment someone trusts it.
 *   3. `browser` is a section name in the audit, never a verdict. Null means
 *      "not audited", which is not "no browser needed".
 *   4. `local` must be a reference document that exists; the test checks it.
 *   5. `essentials`, when set, must be a heading in that document with at least
 *      one list item under it; the test checks that too.
 */
export const PLUGIN_ROUTES: readonly PluginRoute[] = [
	{
		base: "AbstractMobBillPlugIn",
		pluginType: "mobbill",
		guide: "platform/mobile-plugin.md",
		bind: "FormPluginProbe",
		attach: ATTACH_MOB_BILL,
		verify: cli("run", "form <单据>_mob", "<单据>_mob 是单据带的移动端页面，独立的移动单据写它自己的标识"),
		local: "plugin-ui.md",
		essentials: null,
		browser: null,
	},
	{
		base: "AbstractMobListPlugin",
		pluginType: "moblist",
		guide: "platform/mobile-plugin.md",
		bind: "FormPluginProbe",
		attach: ATTACH_MOB_LIST,
		verify: cli("run", "list <单据> --mobile"),
		local: "plugin-ui.md",
		essentials: null,
		browser: null,
	},
	{
		base: "AbstractMobFormPlugin",
		pluginType: "mobform",
		guide: "platform/mobile-plugin.md",
		bind: "FormPluginProbe",
		attach: ATTACH_MOB_FORM,
		verify: cli("run", "form <移动表单>", "挂在单据带的移动端布局上的写 <单据>_mob"),
		local: "plugin-ui.md",
		essentials: null,
		browser: null,
	},
	{
		base: "AbstractBillPlugIn",
		pluginType: "billform",
		guide: "platform/form-plugin.md",
		bind: "FormPluginProbe",
		attach: ATTACH_FORM,
		verify: cli("run", "form <布局>"),
		local: "plugin-ui.md",
		essentials: "表单与单据插件必知要点",
		browser: "完整事件矩阵",
	},
	{
		base: "AbstractBasePlugIn",
		pluginType: "baseform",
		guide: "platform/form-plugin.md",
		bind: "FormPluginProbe",
		attach: ATTACH_FORM,
		verify: cli("run", "form <布局>"),
		local: "plugin-ui.md",
		essentials: "表单与单据插件必知要点",
		browser: "完整事件矩阵",
	},
	{
		base: "StandardTreeListPlugin",
		pluginType: "treelist",
		guide: "platform/standardtreelist-plugin.md",
		bind: "FormPluginProbe",
		attach: ATTACH_LIST,
		verify: cli("run", "list <布局> --tree-node <id>"),
		local: "plugin-ui.md",
		essentials: "左树右表必知要点",
		browser: "列表与树列表的增量事件",
	},
	{
		base: "AbstractTreeListPlugin",
		pluginType: "treelist",
		guide: "platform/standardtreelist-plugin.md",
		bind: "FormPluginProbe",
		attach: ATTACH_LIST,
		verify: cli("run", "list <布局> --tree-node <id>"),
		local: "plugin-ui.md",
		essentials: "左树右表必知要点",
		browser: "列表与树列表的增量事件",
	},
	{
		base: "AbstractListPlugin",
		pluginType: "listform",
		guide: "platform/list-plugin.md",
		bind: "FormPluginProbe",
		attach: ATTACH_LIST,
		verify: cli("run", "list <列表布局>"),
		local: "plugin-ui.md",
		essentials: "列表插件必知要点",
		browser: "列表与树列表的增量事件",
	},
	{
		base: "AbstractReportListDataPlugin",
		pluginType: "reportlist",
		guide: "platform/reportlistdata-plugin.md",
		bind: "FormPluginProbe",
		attach: ATTACH_REPORT_DATA,
		verify: cli(
			"run",
			"call <类名>#<抽出的静态方法> --args [参数…] --expect <路径>=<值>",
			"query() 要的 ReportQueryParam 造不出，先把取数后的计算抽成静态方法",
		),
		local: "plugin-integration.md",
		essentials: "报表取数插件必知要点",
		browser: null,
	},
	{
		base: "AbstractReportTreeDataPlugin",
		pluginType: "reporttreelist",
		guide: "platform/reporttreedata-plugin.md",
		bind: null,
		attach: ATTACH_REPORT_TREE,
		verify: cli(
			"run",
			"call <类名>#<抽出的静态方法> --args [参数…] --expect <路径>=<值>",
			"query() 要的 ReportQueryParam 造不出，先把取数后的计算抽成静态方法",
		),
		local: "plugin-integration.md",
		essentials: null,
		browser: null,
	},
	{
		base: "AbstractReportFormPlugin",
		pluginType: "reportform",
		guide: "platform/report-plugin.md",
		bind: "FormPluginProbe",
		attach: ATTACH_FORM,
		verify: null,
		local: "plugin-ui.md",
		essentials: "报表界面插件必知要点",
		browser: "报表界面插件",
	},
	{
		base: "AbstractPrintSeniorPlugin",
		pluginType: "printplugin",
		guide: "platform/print-plugin-guide.md",
		bind: "PrintTplProbe",
		attach: ATTACH_PRINT,
		verify: cli("run", "print <模板编码> --pk <单据ID> --expect <格子>=<值>"),
		local: "plugin-print-runtime.md",
		essentials: "打印插件必知要点",
		browser: null,
	},
	{
		base: "AbstractPrintPlugin",
		pluginType: "printplugin",
		guide: "platform/print-plugin-guide.md",
		bind: "PrintTplProbe",
		attach: ATTACH_PRINT,
		verify: cli("run", "print <模板编码> --pk <单据ID> --expect <格子>=<值>"),
		local: "plugin-print-runtime.md",
		essentials: "打印插件必知要点",
		browser: null,
	},
	{
		base: "AbstractFormPlugin",
		pluginType: "form",
		guide: "platform/form-plugin.md",
		bind: "FormPluginProbe",
		attach: ATTACH_FORM,
		verify: cli("run", "form <布局>"),
		local: "plugin-ui.md",
		essentials: "表单与单据插件必知要点",
		browser: "完整事件矩阵",
	},
	{
		base: "ApiQueryPlugin",
		pluginType: "customapi",
		guide: "platform/openapi-customapi-java-plugin.md",
		bind: "ApiMetaProbe",
		attach: ATTACH_API,
		verify: cli("run", 'call <类名>#getFilter --args [["<字段>","=","<值>"],{<请求参数>}] --expect $~=<条件片段>'),
		local: "plugin-integration.md",
		essentials: "开放接口插件必知要点",
		browser: null,
	},
	{
		base: "ApiSavePlugin",
		pluginType: "customapi",
		guide: "platform/openapi-customapi-java-plugin.md",
		bind: "ApiMetaProbe",
		attach: ATTACH_API,
		verify: cli("run", "call <类名>#preHandleRequestData --args [[{<请求数据>}]] --expect [0].<字段>=<值>"),
		local: "plugin-integration.md",
		essentials: "开放接口插件必知要点",
		browser: null,
	},
	{
		base: "ApiSerializerPlugin",
		pluginType: "customapi",
		guide: "platform/openapi-customapi-java-plugin.md",
		bind: "ApiMetaProbe",
		attach: ATTACH_API,
		verify: cli(
			"run",
			"call <类名>#<方法> --args [<参数…>] --expect result~=<片段>",
			"getVersion() 返回 MODEL 的调 serializeByModel，参数写成 {response,accept,contentType,reqData}；其余调 serialize(响应,accept,contentType)",
		),
		local: "plugin-integration.md",
		essentials: "开放接口插件必知要点",
		browser: null,
	},
	{
		base: "ApiDeserializerPlugin",
		pluginType: "customapi",
		guide: "platform/openapi-customapi-java-plugin.md",
		bind: "ApiMetaProbe",
		attach: ATTACH_API,
		verify: cli("run", 'call <类名>#deserializer --args ["<请求报文>","application/json"] --expect <键>=<值>'),
		local: "plugin-integration.md",
		essentials: "开放接口插件必知要点",
		browser: null,
	},
	{
		base: "ICustomApiServlet",
		pluginType: "customapi",
		guide: "platform/openapi-customapi-java-plugin.md",
		bind: "ApiMetaProbe",
		attach: ATTACH_API,
		verify: null,
		local: "plugin-integration.md",
		essentials: "开放接口插件必知要点",
		browser: null,
	},
	{
		base: "AbstractOperationServicePlugIn",
		pluginType: null,
		guide: "platform/operation-plugin.md",
		bind: "OpMetaProbe",
		attach: ATTACH_OP,
		verify: cli("run", "op <实体> <操作>"),
		local: "plugin-operation.md",
		essentials: "操作插件必知要点",
		browser: null,
	},
	{
		base: "AbstractValidator",
		pluginType: null,
		guide: "platform/operation-plugin.md",
		bind: "OpMetaProbe",
		attach: ATTACH_VALIDATOR,
		verify: cli("run", "op <实体> <操作>"),
		local: "plugin-operation.md",
		essentials: "操作插件必知要点",
		browser: null,
	},
	{
		base: "AbstractConvertPlugIn",
		pluginType: null,
		guide: "platform/botp-plugin.md",
		bind: "BotpRuleProbe",
		attach: ATTACH_CONVERT,
		verify: cli("run", "push <规则id> --pk <源单内码> --expect <目标单字段>=<值>"),
		local: "plugin-operation.md",
		essentials: "BOTP 转换插件必知要点",
		browser: null,
	},
	{
		base: "AbstractWriteBackPlugIn",
		pluginType: null,
		guide: "platform/writeback-plugin.md",
		bind: null,
		attach: ATTACH_WRITEBACK,
		verify: null,
		local: "plugin-operation.md",
		essentials: "反写插件必知要点",
		browser: null,
	},
	{
		base: "BatchImportPlugin",
		pluginType: null,
		guide: "platform/import-plugin.md",
		bind: null,
		attach: ATTACH_IMPORT,
		verify: cli("run", "call <类名>#<抽出的静态方法> --args [参数…] --expect <路径>=<值>"),
		local: "plugin-integration.md",
		essentials: "批量引入插件必知要点",
		browser: null,
	},
	{
		base: "AbstractTask",
		pluginType: null,
		guide: "platform/task-plugin.md",
		bind: null,
		attach: ATTACH_TASK,
		verify: cli("run", "call <任务类>#execute --args [{任务参数}] --expect error="),
		local: "plugin-integration.md",
		essentials: "后台任务必知要点",
		browser: null,
	},
	{
		base: "IWorkflowPlugin",
		pluginType: null,
		guide: "platform/workflow-plugin.md",
		bind: "WfModelProbe",
		attach: ATTACH_WORKFLOW,
		verify: cli("run", "wf <类名> --pk <单据内码> --expect <字段>=<值>"),
		local: "plugin-integration.md",
		essentials: "工作流插件必知要点",
		browser: null,
	},
];

/**
 * The pi skill that carries one route's local runtime-delta page.
 *
 * The `local` column names a `reference/` document; S7.1 released those as
 * pi-native skills under a `cosmic-` prefix. Derived rather than stored so the
 * two cannot drift, and asserted against the released manifest in
 * test/knowledge/command-map.test.ts.
 */
export function referenceSkillName(local: string): string {
	return `cosmic-${local.replace(/\.md$/, "")}`;
}

/** How a verification entry reads today. Empty string when the frozen table had none. */
export function describeVerify(entry: VerifyEntry): string {
	if (entry === null) return "";
	if (entry.kind === "note") return entry.text;
	const call = rewriteInvocation(entry.command, entry.rest);
	return entry.why === undefined ? call : `${entry.why}，再 ${call}`;
}

/**
 * 这一族插件改完之后，交付要靠什么验（S24 批 C）。
 *
 * 只有两种答案：`run` 给一条能照改的 `cosmic_run` 样板命令；`none` 是这一族没有自动验证方法，
 * 交付只能交用户验收。`note`（只说明配置怎么读的文字，S40 起表里已经没有这种行）算 `none`：它能说明配置长什么样，
 * 证明不了插件跑过——和表里写着 `null` 的是同一种处境，差别只是还有一件只读的事可以做。
 */
export type VerifyRoute =
	| { kind: "run"; command: string; why: string | null }
	| { kind: "none"; readOnly: string | null };

export function verifyRouteOf(route: PluginRoute): VerifyRoute {
	const entry = route.verify;
	if (entry !== null && entry.kind === "cli" && entry.command === "run") {
		return { kind: "run", command: `cosmic_run ${entry.rest}`, why: entry.why ?? null };
	}
	const parts: string[] = [];
	if (route.bind !== null) parts.push(`cosmic_probe ${route.bind} 读它挂在哪、配置长什么样`);
	if (entry !== null && entry.kind === "note") parts.push(entry.text);
	return { kind: "none", readOnly: parts.length === 0 ? null : parts.join("；") };
}

/** 这一族的类没挂上时怎么办，一句话：用哪条命令挂、工具挂不了要用户去哪配，或者不用登记。 */
export function describeAttach(attach: PluginAttach | null): string {
	if (attach === null) return "";
	if ("byUser" in attach) return `没挂上的工具挂不了：${attach.byUser}`;
	if ("inCode" in attach) return `不用登记：${attach.inCode}`;
	if ("meta" in attach) return `没挂上就用 cosmic_meta 挂：${attach.meta}，再 ${attach.handBack} 整份交回`;
	if (attach.layout !== undefined) {
		return `没挂上就用 ${attach.probe} 挂：${attach.input} 里先写 layout ${attach.layout}${
			attach.layout === "mobile" ? "（独立的移动表单不写这行）" : ""
		}，再写 ${attach.line}`;
	}
	return `没挂上就用 ${attach.probe} 挂：${attach.input} 里写 ${attach.line}`;
}

/** 绑定这件事一句话：去哪查，没挂上怎么办。 */
export function describeBinding(bind: string | null, attach: PluginAttach | null): string {
	const read = bind === null ? "先 cosmic_impact 查这个类挂在哪" : `先 ${bind} 确认绑定`;
	return attach === null ? read : `${read}，${describeAttach(attach)}`;
}

/** 一族插件的中文叫法，取官方指南的标题（「打印插件」「工作流插件」）。 */
export function familyTitle(route: PluginRoute): string {
	return KNOWLEDGE_GUIDES.find(([path]) => path === route.guide)?.[1] ?? route.base;
}

// ------------------------------------------------------------------ parsing

export function clean(value: unknown): string {
	return String(value ?? "")
		.trim()
		.replace(/^['"]|['"]$/g, "");
}

function parseScalar(value: string): string | string[] {
	const text = clean(value);
	if (text.startsWith("[") && text.endsWith("]")) {
		return text
			.slice(1, -1)
			.split(",")
			.map(clean)
			.filter((item) => item !== "");
	}
	return text;
}

export type FrontMatter = Record<string, string | string[]>;

/** The frozen front-matter reader: flat scalars and `[a, b]` lists, nothing else. */
export function parseFrontMatter(text: string): FrontMatter {
	const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(text);
	if (match?.[1] === undefined) return {};
	const out: FrontMatter = {};
	for (const line of match[1].split(/\r?\n/)) {
		const item = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
		if (item?.[1] !== undefined) out[item[1]] = parseScalar(item[2] ?? "");
	}
	return out;
}

function field(meta: FrontMatter, key: string): string {
	const value = meta[key];
	if (Array.isArray(value)) return value.join(",");
	return value ?? "";
}

export type ItemKind = "guide" | "scene" | "sdk" | "api";

export interface KnowledgeItem {
	kind: ItemKind;
	relativePath: string;
	title: string;
	keywords: string;
	status: string;
	event?: string;
	control?: string;
	pluginType?: string;
	/** Scenes only: whether the official scene index lists this file. */
	indexed?: boolean;
	fqcn?: string;
	frameworkVersion?: string;
	whenToUse?: string;
}

export interface ScoredItem extends KnowledgeItem {
	score: number;
	matches: string[];
}

export const SCENE_PREFIX = "platform/scenes/";

/** Column headers of the official scene index, as written in the document. */
const SCENE_COLUMN = { file: "文件", name: "场景名", status: "状态", keywords: "关键词" } as const;

function splitTableRow(line: string): string[] {
	return line
		.trim()
		.replace(/^\|/, "")
		.replace(/\|$/, "")
		.split("|")
		.map((cellText) => clean(cellText.replace(/`/g, "")));
}

/** Rows of the official scene index table. Every Markdown table in the file is read. */
export function parseSceneIndex(base: KnowledgeBase): KnowledgeItem[] {
	const text = base.read(`${SCENE_PREFIX}_index.md`);
	if (text === null) return [];
	const lines = text.split(/\r?\n/);
	const rows: KnowledgeItem[] = [];
	for (let i = 0; i < lines.length - 1; i += 1) {
		const header = lines[i] ?? "";
		const divider = lines[i + 1] ?? "";
		if (!/^\s*\|/.test(header) || !/^\s*\|(?:\s*:?-+:?\s*\|)+/.test(divider)) continue;
		const headers = splitTableRow(header);
		i += 2;
		while (i < lines.length && /^\s*\|/.test(lines[i] ?? "")) {
			const values = splitTableRow(lines[i] ?? "");
			const row: Record<string, string> = Object.fromEntries(headers.map((name, n) => [name, values[n] ?? ""]));
			const rel = row[SCENE_COLUMN.file] ?? "";
			if (rel !== "" && rel.toLowerCase().endsWith(".md")) {
				rows.push({
					kind: "scene",
					title: row[SCENE_COLUMN.name] || rel,
					relativePath: `${SCENE_PREFIX}${rel}`,
					status: row[SCENE_COLUMN.status] || "unknown",
					keywords: row[SCENE_COLUMN.keywords] ?? "",
					event: row.triggerEvent ?? "",
					control: row.controlType ?? "",
					pluginType: row.pluginType ?? "",
					indexed: true,
				});
			}
			i += 1;
		}
		i -= 1;
	}
	return rows;
}

function sceneFromFrontMatter(base: KnowledgeBase, relativePath: string): KnowledgeItem {
	const meta = parseFrontMatter(base.read(relativePath) ?? "");
	return {
		kind: "scene",
		relativePath,
		title: field(meta, "scene_name") || basename(relativePath, ".md"),
		status: field(meta, "status") || "unknown",
		keywords: field(meta, "scene_keywords"),
		event: field(meta, "trigger_event"),
		control: field(meta, "control_type"),
		pluginType: field(meta, "plugin_type"),
		indexed: false,
	};
}

export function sceneDocPaths(base: KnowledgeBase): string[] {
	return base
		.docs()
		.map((doc) => doc.relativePath)
		.filter((rel) => rel.startsWith(SCENE_PREFIX) && basename(rel) !== "_index.md");
}

/** Indexed rows plus every scene file the index does not list. Draft filtered unless asked. */
export function sceneItems(base: KnowledgeBase, includeDraft: boolean): KnowledgeItem[] {
	const indexed = parseSceneIndex(base);
	const known = new Set(indexed.map((item) => item.relativePath.toLowerCase()));
	const unindexed = sceneDocPaths(base)
		.filter((rel) => !known.has(rel.toLowerCase()))
		.map((rel) => sceneFromFrontMatter(base, rel));
	return [...indexed, ...unindexed].filter((item) => includeDraft || item.status.toLowerCase() !== "draft");
}

export function guideItems(base: KnowledgeBase): KnowledgeItem[] {
	return KNOWLEDGE_GUIDES.filter(([rel]) => base.exists(rel)).map(([relativePath, title, keywords]) => ({
		kind: "guide" as const,
		relativePath,
		title,
		keywords: keywords.join(","),
		status: "unknown",
	}));
}

export function sdkItems(base: KnowledgeBase): KnowledgeItem[] {
	return KNOWLEDGE_SDK.filter(([rel]) => base.exists(rel)).map(([relativePath, keywords]) => ({
		kind: "sdk" as const,
		relativePath,
		title: basename(relativePath, ".md"),
		keywords: keywords.join(","),
		status: "unknown",
	}));
}

/**
 * 每个知识库对象只列一遍：列一遍要把 platform/api 下每篇文档都从盘上读出来看文档头。
 * 同一个对象的文档清单本来就只扫一次（`docs()`），这张表跟着它，不比它更旧。
 */
const apiItemsOf = new WeakMap<KnowledgeBase, readonly KnowledgeItem[]>();

export function apiItems(base: KnowledgeBase): readonly KnowledgeItem[] {
	const held = apiItemsOf.get(base);
	if (held !== undefined) return held;
	const out: KnowledgeItem[] = [];
	for (const doc of base.docs()) {
		if (!doc.relativePath.startsWith("platform/api/") || basename(doc.relativePath) === "api-index.md") continue;
		const meta = parseFrontMatter(base.read(doc.relativePath) ?? "");
		const apiClass = field(meta, "api_class");
		const apiPackage = field(meta, "api_package");
		if (apiClass === "" || apiPackage === "") continue;
		const fqcn = `${apiPackage}.${apiClass}`;
		out.push({
			kind: "api",
			relativePath: doc.relativePath,
			title: fqcn,
			fqcn,
			keywords: `${apiClass} ${field(meta, "when_to_use")}`,
			status: field(meta, "status") || "unknown",
			frameworkVersion: field(meta, "framework_version") || "unknown",
			whenToUse: field(meta, "when_to_use"),
		});
	}
	apiItemsOf.set(base, out);
	return out;
}

// ------------------------------------------------------------------ scoring

export interface FacetOptions {
	pluginType?: string;
	event?: string;
	control?: string;
}

export interface SearchOptions extends FacetOptions {
	kind?: ItemKind | "all";
	limit?: number;
	includeDraft?: boolean;
}

const commaValues = (value: string): string[] =>
	clean(value)
		.toLowerCase()
		.split(/[,，]/)
		.map((item) => item.trim())
		.filter((item) => item !== "");

const fieldsText = (item: KnowledgeItem): string =>
	[item.title, item.relativePath, item.keywords, item.event, item.control, item.pluginType]
		.filter((part): part is string => Boolean(part))
		.join(" ")
		.toLowerCase();

/**
 * Query terms: the whole string, its words, and 2-grams of any CJK run of four
 * characters or more. Chinese has no spaces, so without the 2-grams a four-word
 * business phrase matches nothing at all.
 */
export function queryTerms(query: string): string[] {
	const text = clean(query).toLowerCase();
	const parts = text.split(/[\s,，、/]+/).filter((part) => part !== "");
	const pairs = parts.flatMap((part) => {
		if (!/^[㐀-鿿]{4,}$/.test(part)) return [];
		const chars = [...part];
		return chars.slice(0, -1).map((_, i) => chars.slice(i, i + 2).join(""));
	});
	return [...new Set([text, ...parts, ...pairs].filter((term) => term !== ""))];
}

export type FacetVerdict = "unknown" | "hit" | "neutral" | "miss";

/** The facets a scene row can be filtered by, with their weight and their accepted synonyms. */
const SCENE_FACETS: readonly {
	key: keyof FacetOptions;
	weight: number;
	extra: readonly string[];
	/** Column name in the official scene index, for messages that have to name it. */
	column: string;
}[] = [
	{ key: "pluginType", weight: 4, extra: ["common"], column: "pluginType" },
	{ key: "event", weight: 3, extra: [], column: "triggerEvent" },
	{ key: "control", weight: 3, extra: [], column: "controlType" },
];

export const SCENE_FACET_KEYS: readonly (keyof FacetOptions)[] = SCENE_FACETS.map((facet) => facet.key);

export function sceneFacetColumn(key: keyof FacetOptions): string {
	return SCENE_FACETS.find((facet) => facet.key === key)?.column ?? key;
}

function facetValue(item: KnowledgeItem, key: keyof FacetOptions): string | undefined {
	if (key === "pluginType") return item.pluginType;
	if (key === "event") return item.event;
	return item.control;
}

/**
 * An empty tag means "never tagged", not "does not match".
 *
 * Unindexed scenes get their tags from front matter, which has no plugin_type or
 * control_type key at all; treating empty as a miss would make that whole set
 * disappear under any --plugin-type, without an error. An explicit `—` in the
 * index IS a value and is compared normally.
 *
 * S7.3 keeps this as the ONE place the rule is written. knowledgeScenes counts
 * how many rows each verdict produced, and it must count the same verdicts the
 * filter acted on; a second copy of the comparison would let the report say
 * "kept because untagged" about rows the filter had actually dropped.
 */
function facetMatch(itemValue: string | undefined, wanted: string, extra: readonly string[] = []): FacetVerdict {
	if (clean(itemValue) === "") return "unknown";
	const values = commaValues(itemValue ?? "");
	if (values.includes(wanted.toLowerCase())) return "hit";
	return extra.some((value) => values.includes(value)) ? "neutral" : "miss";
}

/** One facet's verdict on one item. Non-scene items are never filtered by facets. */
export function facetVerdict(item: KnowledgeItem, key: keyof FacetOptions, wanted: string): FacetVerdict {
	if (item.kind !== "scene") return "unknown";
	const facet = SCENE_FACETS.find((entry) => entry.key === key);
	if (facet === undefined) return "unknown";
	return facetMatch(facetValue(item, key), wanted, facet.extra);
}

export interface FacetGateResult {
	score: number;
	matches: string[];
	/** Facets this row was never tagged with, and so was kept on "unknown". */
	untagged: (keyof FacetOptions)[];
}

export function facetGate(item: KnowledgeItem, options: FacetOptions): FacetGateResult | null {
	if (item.kind !== "scene") return { score: 0, matches: [], untagged: [] };
	let score = 0;
	const matches: string[] = [];
	const untagged: (keyof FacetOptions)[] = [];
	for (const facet of SCENE_FACETS) {
		const wanted = options[facet.key];
		if (wanted === undefined || wanted === "") continue;
		const verdict = facetVerdict(item, facet.key, wanted);
		if (verdict === "miss") return null;
		if (verdict === "unknown") untagged.push(facet.key);
		if (verdict === "hit") {
			score += facet.weight;
			matches.push(`${facet.key}:${wanted}`);
		}
	}
	return { score, matches, untagged };
}

// --------------------------------------------------------------- L2 channels

export type QueryChannel = "identifier" | "scene-question";

export interface QueryRoute {
	channel: QueryChannel;
	/** Why this channel, in one clause. A wrong route should be arguable, not guessable. */
	why: string;
}

/**
 * A Java identifier, a fully-qualified name, or a method name with empty parens.
 * Deliberately ASCII-only: the whole point of the split is that a query written
 * in Chinese is a business question, never a symbol.
 */
const IDENTIFIER_QUERY = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\(\))?$/;

const CJK = /[㐀-鿿]/;

/**
 * Which L2 channel a query belongs to (S7.3).
 *
 * The split is not a stylistic preference, it is the measured difference between
 * two recalls on the same eval batch: literal `search` scored 3/10 on
 * business-voiced questions while reading the whole scene table scored 9/9. The
 * cause is that business wording and index keywords often share not one
 * character -- "选完供应商带出联系人" against `afterF7Select, 选择后, 关联数据, 回填`.
 *
 * So: symbols go to search, questions go to the table. Reported rather than
 * enforced, because search still answers a symbol-shaped question correctly and
 * refusing would be a gate; what must not happen is a 3/10 answer that arrives
 * looking like a complete one.
 */
export function classifyQuery(query: string): QueryRoute {
	const text = clean(query);
	if (text === "") return { channel: "scene-question", why: "没有查询词，只有过滤条件" };
	if (CJK.test(text)) {
		return { channel: "scene-question", why: "查询含中文：业务口吻与索引关键词经常一个字都不重合" };
	}
	const parts = text.split(/\s+/).filter((part) => part !== "");
	if (parts.length === 1 && IDENTIFIER_QUERY.test(parts[0] ?? "")) {
		return { channel: "identifier", why: "整条查询是一个标识符或全限定名，字面匹配就是正解" };
	}
	return { channel: "scene-question", why: `${parts.length} 个词的自然语言查询，不是标识符` };
}

export function scoreItem(item: KnowledgeItem, query: string, options: SearchOptions): ScoredItem | null {
	const gate = facetGate(item, options);
	if (gate === null) return null;
	const text = fieldsText(item);
	const whole = clean(query).toLowerCase();
	let score = gate.score;
	const matches = [...gate.matches];
	for (const term of queryTerms(query)) {
		if (text.includes(term)) {
			score += term === whole ? 3 : 1;
			matches.push(`keyword:${term}`);
		}
	}
	const facetOnly = query === "" && Boolean(options.pluginType || options.event || options.control);
	if (score === 0 && !facetOnly) return null;
	return { ...item, score, matches };
}
