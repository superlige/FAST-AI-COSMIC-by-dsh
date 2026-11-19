/**
 * 产品工具在界面上的卡片标题：一眼看出这次调用在干什么（「真跑业务：op demo_bill save」），
 * 不是工具名加一坨 JSON。只给界面看，不进发给模型的请求。纯函数，按参数算，不碰会话和工程。
 *
 * 只出通用卡片：标题、类别图标、展开后看的关键输入。结果卡片沿用工具返回的文字。
 */

import type { GenericCallView, ToolCallKind } from "@deepseek-ai/dsh-tools";

const TITLE_MAX = 80;

function clip(text: string): string {
	const one = text.replace(/\s+/g, " ").trim();
	return one.length > TITLE_MAX ? `${one.slice(0, TITLE_MAX - 1)}…` : one;
}

function base(path: string): string {
	const parts = path.replace(/\\/g, "/").replace(/\/+$/, "").split("/");
	return parts.at(-1) ?? path;
}

type Args = Record<string, unknown>;
const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
const list = (value: unknown): string[] =>
	Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const DOCTOR: Record<string, string> = {
	check: "检查环境",
	rebuild: "重建编译参数",
	index: "看代码关系表状态",
	reindex: "重建代码关系表",
	lock: "看写锁",
};

const RUNTIME: Record<string, string> = {
	"probe-status": "看常驻 JVM",
	"probe-start": "起常驻 JVM",
	"probe-stop": "停常驻 JVM",
	"probe-restart": "重启常驻 JVM",
	"node-status": "看本地苍穹节点",
	"node-start": "起本地苍穹节点",
	"node-logs": "看本地苍穹节点日志",
	"node-stop": "停本地苍穹节点",
	deploy: "部署",
};

const PROD: Record<string, string> = {
	status: "生产连接状态",
	sql: "查生产数据",
	meta: "查生产元数据",
	log: "查生产日志",
	report: "出诊断报告",
};

function view(title: string, kind: ToolCallKind, rawInput?: unknown): GenericCallView {
	return { card: "generic", title: clip(title), kind, ...(rawInput === undefined ? {} : { rawInput }) };
}

/** 一次产品工具调用的卡片；不认识的工具或参数不是对象时给 undefined，界面用它自己的默认样子。 */
export function presentCosmicCall(tool: string, input: unknown): GenericCallView | undefined {
	if (typeof input !== "object" || input === null) return undefined;
	const args = input as Args;
	switch (tool) {
		case "cosmic_open_project":
			return view(
				`打开工程 ${str(args.projectRoot) === undefined ? "（会话工作目录）" : base(str(args.projectRoot) as string)}`,
				"read",
			);
		case "cosmic_lint":
			return view(`检查写法：${list(args.sources).join("、")}`, "read", list(args.sources));
		case "cosmic_fast": {
			const sources = list(args.sources);
			return view(sources.length === 0 ? "编译改过的源码" : `编译：${sources.join("、")}`, "execute");
		}
		case "cosmic_probe": {
			const env = (typeof args.env === "object" && args.env !== null ? args.env : {}) as Args;
			const name = str(args.name) ?? "?";
			const shown = name.includes("/") || name.includes("\\") ? base(name) : name;
			const writes = env.APPLY === "1" || env.APPLY === 1 || env.APPLY === true;
			const raw = str(args.raw) ?? (args.raw === true ? "全文" : undefined);
			return view(
				raw !== undefined ? `取探针输出：${shown}` : `${writes ? "探针（写入）" : "探针"}：${shown}`,
				writes ? "edit" : "execute",
				Object.keys(env).length === 0 ? undefined : env,
			);
		}
		case "cosmic_doctor": {
			const action = str(args.action) ?? "check";
			return view(
				DOCTOR[action] ?? `环境：${action}`,
				action === "check" || action === "index" ? "read" : "execute",
			);
		}
		case "cosmic_knowledge": {
			const query = str(args.query);
			return view(`查知识（${str(args.action) ?? "?"}）${query === undefined ? "" : `：${query}`}`, "search");
		}
		case "cosmic_run": {
			const argv = list(args.argv);
			return argv.length === 0 || argv[0] === "help"
				? view("真跑业务：看用法", "read")
				: view(`真跑业务：${argv.join(" ")}`, "execute", argv.join(" "));
		}
		case "cosmic_facts":
			return view("列出本会话做过的事", "read");
		case "cosmic_impact":
			return view(`查影响：${list(args.terms).join("、")}`, "search");
		case "cosmic_meta": {
			const argv = list(args.argv);
			if (argv.length === 0) return view("元数据：看用法", "read");
			return args.apply === true
				? view(`写元数据：${argv.join(" ")}`, "edit", argv.join(" "))
				: view(`元数据：${argv.join(" ")}`, "read", argv.join(" "));
		}
		case "cosmic_runtime": {
			const action = str(args.action) ?? "?";
			return view(
				RUNTIME[action] ?? `运行环境：${action}`,
				action.endsWith("status") || action === "node-logs" ? "read" : "execute",
			);
		}
		case "cosmic_prod": {
			const action = str(args.action) ?? "?";
			const label = PROD[action] ?? `生产：${action}`;
			const detail =
				action === "sql"
					? str(args.sql)
					: action === "meta"
						? str(args.number)
						: action === "log"
							? (str(args.traceId) ?? [str(args.number), str(args.billno)].filter(Boolean).join(" "))
							: action === "report"
								? str(args.title)
								: undefined;
			return view(
				detail === undefined || detail === "" ? label : `${label}：${detail}`,
				action === "report" ? "edit" : "read",
				action === "sql" ? str(args.sql) : undefined,
			);
		}
		default:
			return undefined;
	}
}
