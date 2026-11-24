/**
 * 不经 dsh、不经模型调产品工具：和插件入口 `apply` 挂同一份工具规格（`cosmicToolSpecs`），
 * 每次调用先过同一道执行前门槛（`preExecute`），再执行、返回工具交给模型的全文。
 * 真机验证脚本（`replay-run.ts`、`verify-tools-smoke.ts`）用它，不花模型额度。
 *
 * 用的是真内核：组合包自己的 RuntimeKey 和常驻 JVM，不和 pi 版会话抢进程。
 * 写元数据要弹确认单的调用一律当「弹不了」：这里没有人点，不会落库。
 */

import { COSMIC_TOOL_NAMES } from "../src/agent/tools/names.ts";
import { checkArgs } from "../src/dsh/define.ts";
import { cosmicToolSpecs } from "../src/dsh/fixed-text.ts";
import { type HookDeps, preExecute } from "../src/dsh/hooks.ts";
import { type CallContext, CosmicHost, now } from "../src/dsh/host.ts";
import { COSMIC_AGENT_DIR } from "../src/dsh/prod-secrets.ts";
import { CosmicToolFailure } from "../src/dsh/result.ts";

export interface DirectCall {
	/** 工具返回的全文；被门槛拒、工具失败时是拒绝原因，前面带「拒绝:」「失败:」。 */
	text: string;
	ok: boolean;
}

export interface DirectTools {
	call(name: string, args: Record<string, unknown>): Promise<DirectCall>;
	/** 挂给模型的产品工具。 */
	mounted: readonly string[];
	host: CosmicHost;
}

export async function directTools(project: string): Promise<DirectTools> {
	const host = new CosmicHost();
	// 插件入口在登记技能时记下技能文档目录，知识卡片的出处靠它换成能读的路径。
	const skills = await host.kernel.referenceSkills();
	if (skills.ok) host.referenceDocsDir = skills.value.docsDir;
	const specs = cosmicToolSpecs(host, async () => ({ kind: "unavailable", reason: "直接调用工具，没有人点确认单" }));
	const mounted = [...COSMIC_TOOL_NAMES];
	const byName = new Map(specs.map((spec) => [spec.name, spec]));
	const agent = { id: `direct-${Date.now()}` };
	const deps: HookDeps = {
		host,
		cwdOf: async () => project,
		ungated: (toolName, args) => byName.get(toolName as never)?.ungated?.(args as never) === true,
		agentDir: COSMIC_AGENT_DIR,
	};

	async function call(name: string, args: Record<string, unknown>): Promise<DirectCall> {
		const spec = byName.get(name as never);
		if (spec === undefined) return { ok: false, text: `没有这个工具: ${name}` };
		const signal = new AbortController().signal;
		const exec = { name, arguments: args, signal, agent } as unknown as Parameters<typeof preExecute>[1];
		const decision = await preExecute(deps, exec);
		if (decision.kind !== "allow") return { ok: false, text: `拒绝: ${"reason" in decision ? decision.reason : ""}` };
		const context: CallContext = {
			tool: spec.name,
			session: host.sessions.of(agent.id) as CallContext["session"],
			agent,
			signal,
			startedAt: now(),
			cwd: async () => project,
		};
		try {
			const blocks = await spec.execute(checkArgs(spec, args), context);
			return { ok: true, text: blocks.join("\n\n").trim() };
		} catch (error) {
			if (error instanceof CosmicToolFailure) return { ok: false, text: `失败: ${error.message}` };
			return { ok: false, text: `抛异常: ${error instanceof Error ? error.message : String(error)}` };
		}
	}

	return { call, mounted, host };
}
