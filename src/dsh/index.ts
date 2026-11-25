/**
 * fast-ai-cosmic 接到 dsh 的那一层：插件入口。
 *
 * 一个插件、一种会话：12 个产品工具全部挂上。开发（改代码、编译、真跑业务、写元数据）和查生产
 * （cosmic_prod 只读查生产库、生产元数据、monitor 日志）在同一个会话里接着做，不用换会话交接。
 * 生产只读靠 cosmic_prod 这条通道自己的闸，其余工具连的都是测试环境。
 *
 * 所有会变的状态都在每个会话一份的 `CosmicSession` 里，键是 dsh 的会话编号；模块顶层只有进程级的内核单例。
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { AuthorizationService } from "@deepseek-ai/dsh-authorization";
import type {} from "@deepseek-ai/dsh-commands";
import type {} from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-skill";
import type {} from "@deepseek-ai/dsh-system-prompt";
import type { ToolDefinition, ToolExecution } from "@deepseek-ai/dsh-tools";
import type { UserQuestionService } from "@deepseek-ai/dsh-user-questions";
import type {} from "@deepseek-ai/dsh-working-directory";
import { cosmicSystemPrompt, type ReferenceSkillState, standingContext } from "../agent/prompt/system-prompt.ts";
import { askText, cosmicCommands, questionAsk } from "./commands.ts";
import { type CosmicToolSpec, checkArgs, toDshSchema } from "./define.ts";
import { cosmicToolSpecs } from "./fixed-text.ts";
import { afterRead, afterWrite, type HookDeps, preExecute } from "./hooks.ts";
import { type CallContext, CosmicHost, now } from "./host.ts";
import { cosmicJvmBoard } from "./kernel.ts";
import { presentCosmicCall } from "./present.ts";
import { releasedProbes } from "./probes.ts";
import { COSMIC_AGENT_DIR } from "./prod-secrets.ts";
import { askProdConsentVia } from "./prod-setup.ts";
import { RefTitleFixer } from "./session-title.ts";
import type { Confirm } from "./write.ts";

export { cosmicPackFiles } from "./kernel.ts";
export { releasedProbes } from "./probes.ts";

export const name = "fast-ai-cosmic";
export const inject = ["tools", "systemPrompt", "workingDirectory"];

/** 没有配置项；旧配置里留着的 `mode` 不再读。 */
export type Config = Record<string, unknown>;

/** 写元数据确认单上的两个选项。 */
export const APPROVE_LABEL = "确认写入";
export const REJECT_LABEL = "不写";

/** SKILL.md 开头的 name / description。 */
function frontmatter(text: string): { name: string; description: string; body: string } | null {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
	if (match === null) return null;
	const field = (key: string): string | undefined => {
		const line = new RegExp(`^${key}:\\s*(.*)$`, "m").exec(match[1] as string)?.[1]?.trim();
		if (line === undefined) return undefined;
		return line.startsWith('"') ? (JSON.parse(line) as string) : line;
	};
	const skillName = field("name");
	const description = field("description");
	if (skillName === undefined || description === undefined) return null;
	return { name: skillName, description, body: (match[2] as string).trim() };
}

/**
 * 异步读完再登记：读的时候插件可能已经被卸了（`--help`、`--dump-config` 这类起来就退的命令），
 * 卸了以后再调 `skills.register` 会抛「inactive context」把整个进程带崩，所以卸掉后读完的一律不登记。
 * 返回卸载时调的清理函数。
 */
export function registerWhenLoaded<T>(load: () => Promise<readonly T[]>, register: (item: T) => void): () => void {
	let active = true;
	void load().then(
		(items) => {
			if (active) for (const item of items) register(item);
		},
		() => {},
	);
	return () => {
		active = false;
	};
}

/** 一个工具规格挂成 dsh 的工具定义。 */
function toolDefinition(host: CosmicHost, spec: CosmicToolSpec<never>, cwdOf: HookDeps["cwdOf"]): ToolDefinition {
	return {
		name: spec.name,
		description: spec.description,
		parameters: toDshSchema(spec.parameters) as unknown as ToolDefinition["parameters"],
		presentCall: (args) => presentCosmicCall(spec.name, args),
		output: {
			schema: {},
			render: (_args, value) =>
				((value as { blocks?: string[] }).blocks ?? []).map((text) => ({ type: "text" as const, text })),
		},
		async execute(args, exec) {
			const session = host.sessions.of(exec.agent?.id as string | undefined);
			const call: CallContext = {
				tool: spec.name,
				session: session as CallContext["session"],
				agent: exec.agent,
				signal: exec.signal,
				startedAt: now(),
				cwd: () => cwdOf(exec),
			};
			const checked = checkArgs(spec, args);
			return { blocks: await spec.execute(checked, call) };
		},
	};
}

export function apply(ctx: Context, _config: Config = {}): void {
	const host = new CosmicHost();
	let questions: UserQuestionService | undefined;
	let authorization: AuthorizationService | undefined;
	let referenceSkills: ReferenceSkillState = { ok: null };

	const cwdOf: HookDeps["cwdOf"] = (exec) =>
		exec.agent === undefined ? Promise.resolve(process.cwd()) : ctx.workingDirectory.ensure(exec.agent, exec.signal);

	/** 写元数据前弹给用户的确认单：界面弹不了（无头运行、没有提问服务）就照实说，不写。 */
	const confirm: Confirm = async (call, card) => {
		if (questions === undefined) return { kind: "unavailable", reason: "这个宿主没有提问服务" };
		try {
			const answer = await questions.ask({
				...(call.agent === undefined ? {} : { agent: call.agent as Agent }),
				signal: call.signal,
				questions: [
					{
						id: "cosmic-write",
						header: card.header,
						question: card.question,
						detail: card.detail,
						options: [{ label: APPROVE_LABEL }, { label: REJECT_LABEL }],
						intent: { kind: "approval", approve: APPROVE_LABEL, reject: REJECT_LABEL },
					},
				],
			});
			const item = answer.answers.find((one) => one.id === "cosmic-write");
			if (item?.selected.includes(APPROVE_LABEL) === true) return { kind: "approved" };
			const note = item?.custom?.trim();
			return note === undefined || note === "" ? { kind: "declined" } : { kind: "declined", note };
		} catch (error) {
			return { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) };
		}
	};

	// 配置向导在工具执行中弹（工程配置不全、生产排障配置不全）；没有提问服务时不弹，照实报错
	host.askInCall = (call, header) =>
		questions === undefined
			? undefined
			: questionAsk({ questions: () => questions }, call.agent as Agent | undefined, call.signal, header);

	// 本会话第一次查生产前问人（怎么解读回答见 prod-setup.ts 的 askProdConsentVia）
	host.askProdConsent = (call) => () => askProdConsentVia(questions, call.agent as Agent | undefined, call.signal);

	const specs = cosmicToolSpecs(
		host,
		confirm,
		(call) => (question, detail) =>
			askText(questions, call.agent as Agent | undefined, call.signal, question, detail),
	);
	const byName = new Map(specs.map((spec) => [spec.name as string, spec]));
	for (const spec of specs) ctx.tools.register(toolDefinition(host, spec, cwdOf));

	const deps: HookDeps = {
		host,
		cwdOf,
		ungated: (toolName, args) => byName.get(toolName)?.ungated?.(args as never) === true,
		agentDir: COSMIC_AGENT_DIR,
	};

	ctx.on("tools/pre-execute", async (exec: ToolExecution, next) => {
		const decision = await preExecute(deps, exec);
		return decision.kind === "allow" ? next() : decision;
	});

	ctx.on("tools/post-execute", async (exec, result, next) => {
		const write = await afterWrite(deps, exec, result).catch(() => null);
		const read = write === null ? await afterRead(deps, exec, result).catch(() => null) : null;
		if (write === null && read === null) return next();
		const decided = await next();
		if (decided.kind !== "accept" || decided.value !== undefined) return decided;
		const base = decided.content ?? result.content;
		const content = read?.replace === undefined ? [...base] : [{ type: "text" as const, text: read.replace }];
		for (const text of write === null ? (read?.append ?? []) : [write]) content.push({ type: "text" as const, text });
		return { ...decided, content };
	});

	// 会话登记进 JVM 状态板：界面进到这个会话时据此认工程、在后台起 JVM（见 jvm-board.ts）。这里的事件只收本预设自己的会话。
	const board = cosmicJvmBoard();
	ctx.on("agent/created", ({ agent }) => {
		void ctx.workingDirectory.ensure(agent).then(
			(cwd) => board.track(String(agent.id), cwd),
			() => {},
		);
		return undefined;
	});

	// 第一句话以 @ 引用开头时，会话标题不留引用块的标签（见 session-title.ts）
	const titles = new RefTitleFixer();
	ctx.on("session/event", (session, event) => {
		titles.onEvent(session as unknown as Parameters<RefTitleFixer["onEvent"]>[0], event);
		const type = String(event.type);
		if (type === "compaction/summary" || type === "compaction/prune")
			host.sessions.peek(String(session.id))?.forgetSaid();
		if (type === "working-directory/change") {
			const cwd = (event as { data?: { cwd?: unknown } }).data?.cwd;
			if (typeof cwd === "string" && cwd !== "") board.track(String(session.id), cwd);
		}
	});
	ctx.on("session/disposed", (session) => {
		host.sessions.drop(String(session.id));
		board.forget(String(session.id));
		titles.forget(String(session.id));
	});

	const probes = releasedProbes();
	ctx.systemPrompt.section({
		name: "fast-ai-cosmic",
		order: ctx.systemPrompt.getSectionOrder("DEPLOYMENT_PERSONA_PREFIX") + 10,
		text: () => cosmicSystemPrompt({ releasedProbes: probes.names, probeInputs: probes.inputs, referenceSkills }),
	});
	ctx.systemPrompt.context({
		name: "fast-ai-cosmic-state",
		order: ctx.systemPrompt.getContextOrder("WORKING_DIRECTORY") + 5,
		text: (assemble) => {
			const agent = (assemble as { agent?: { id?: unknown } }).agent;
			const session = agent?.id === undefined ? undefined : host.sessions.peek(String(agent.id));
			if (session === undefined) return "";
			const java = [...session.files].filter((file) => file.toLowerCase().endsWith(".java")).length;
			const report = session.prod.lastReport ?? session.lastReport;
			return standingContext({
				projectRoot: session.project?.root ?? null,
				javaEdited: java,
				compiledFresh: session.freshness !== undefined && session.compiledAt !== undefined,
				...(report === undefined ? {} : { lastReport: report }),
			});
		},
	});

	// 提问、授权两个服务可有可无：在的时候记下，卸掉时清掉。
	ctx.inject(["userQuestions"], (sub) => {
		sub.effect(() => {
			questions = sub.userQuestions;
			return () => {
				questions = undefined;
			};
		});
	});
	ctx.inject(["authorization"], (sub) => {
		sub.effect(() => {
			authorization = sub.authorization;
			return () => {
				authorization = undefined;
			};
		});
	});
	ctx.inject(["commands"], (sub) => {
		for (const command of cosmicCommands({
			host,
			cwdOf: (agent, signal) => ctx.workingDirectory.ensure(agent, signal),
			questions: () => questions,
			authorization: () => authorization,
		}))
			sub.commands.register(command);
	});
	ctx.inject(["skills"], (sub) => {
		type Skill = Parameters<typeof sub.skills.register>[0];
		const load = async (): Promise<Skill[]> => {
			const loaded = await host.kernel.referenceSkills();
			if (!loaded.ok) {
				referenceSkills = { ok: false, reason: loaded.error.message };
				return [];
			}
			referenceSkills = { ok: true, value: loaded.value };
			host.referenceDocsDir = loaded.value.docsDir;
			const skills: Skill[] = [];
			for (const root of loaded.value.skillPaths) {
				for (const family of await readdir(root).catch(() => [] as string[])) {
					const path = join(root, family, "SKILL.md");
					const parsed = frontmatter(await readFile(path, "utf8").catch(() => ""));
					if (parsed === null) continue;
					skills.push({
						name: parsed.name,
						description: parsed.description,
						content: parsed.body,
						path,
						source: "custom",
						resourceBase: { kind: "directory", path: join(root, family) },
					});
				}
			}
			return skills;
		};
		sub.effect(() => registerWhenLoaded(load, (skill) => sub.skills.register(skill)));
	});
}
