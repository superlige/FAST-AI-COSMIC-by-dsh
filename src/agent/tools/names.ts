/** 本产品挂给模型的工具，每个会话都全部挂上。 */
export const COSMIC_TOOL_NAMES = [
	"cosmic_open_project",
	"cosmic_lint",
	"cosmic_fast",
	"cosmic_probe",
	"cosmic_doctor",
	"cosmic_knowledge",
	"cosmic_run",
	"cosmic_facts",
	"cosmic_impact",
	"cosmic_meta",
	"cosmic_runtime",
	"cosmic_prod",
] as const;
export type CosmicToolName = (typeof COSMIC_TOOL_NAMES)[number];

export function isCosmicToolName(name: string): name is CosmicToolName {
	return (COSMIC_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * 不再是工具的名字，和现在怎么做。
 *
 * 名字不会因为工具没了就消失：它还写在用户的记忆里、旧会话里、模型见过的文字里。
 * 「没有这个工具」是一句让调用方无路可走的真话，说出替代的做法才有用。
 */
export const RETIRED_TOOL_ROUTES: Readonly<Record<string, string>> = {
	cosmic_build: "cosmic_doctor action=rebuild（产物在但不对时加 force=true）",
	cosmic_recover_write_lock: "cosmic_doctor action=lock（不给 token 是只读查看，给 token 才回收）",
	cosmic_probe_server: "cosmic_runtime action=probe-status / probe-start / probe-stop / probe-restart",
	cosmic_node: "cosmic_runtime action=node-status / node-start / node-logs / node-stop",
	cosmic_deploy: "cosmic_runtime action=deploy",
	cosmic_verify: "cosmic_facts（列出本会话编译、断言、写入的事实）",
	cosmic_authorize: "写元数据时在写调用里附 report，工具预演后自己弹确认单",
};

/** 一个退役名字的替代做法；从来不是工具的名字给 null。 */
export function retiredToolRoute(name: string): string | null {
	return RETIRED_TOOL_ROUTES[name] ?? null;
}

/** 模型点了退役名字时补给它的那句话。 */
export function retiredToolReason(toolName: string): string | null {
	const route = retiredToolRoute(toolName);
	if (route === null) return null;
	return `${toolName} 已并入别的做法，现在是：${route}。`;
}
