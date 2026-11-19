/**
 * 给人敲的命令（模型调不到）：
 *   /cosmic-env           识别会话工作目录里的工程（config.json 缺必填项时走配置向导）、刷新代码关系表，报一遍环境
 *                         （工具第一次要打开工程时配置不全也会自动弹同一个向导，见 setup.ts）；
 *   /cosmic-prod-setup    填生产排障配置（生产库只读账号、monitor 账号），试连后确认才写；配齐了的可以重填
 *                         （排障会话第一次用 cosmic_prod 时没配也会自动弹，见 prod-setup.ts）；
 *   /cosmic-jvm           本机 cosmic 开着的常驻 JVM 和调试节点，能停其中一个；
 *   /cosmic-login         登录 ChatGPT（codex OAuth），和设置 → 模型页上 codex 卡片的「登录 ChatGPT」按钮是同一条登录（codex-login.ts）；
 *   /cosmic-monitor-login 排障会话里登录生产 monitor，验证码只由人照图输入（排障工具第一次用、查日志前没登录也会自动弹，
 *                         见 monitor-login.ts；这条命令留给人点了「不填了」之后又想登的时候）。
 */

import type { Agent } from "@deepseek-ai/dsh-agent";
import type { AuthorizationService } from "@deepseek-ai/dsh-authorization";
import type { CommandDefinition, CommandResult } from "@deepseek-ai/dsh-commands";
import type { UserQuestionService } from "@deepseek-ai/dsh-user-questions";
import { openWithSystemViewer } from "../agent/tools/open-viewer.ts";
import { CODEX_AUTH_KEY } from "./codex-login.ts";
import type { CallContext, CosmicHost } from "./host.ts";
import { now } from "./host.ts";
import { jvmListText, parseJvmCommand, stopText } from "./jvm.ts";
import type { ProjectHandle } from "./kernel.ts";
import { loginMonitor } from "./monitor-login.ts";
import { configureProd } from "./prod-setup.ts";
import type { CosmicSession } from "./session.ts";
import { type Ask, configureProject } from "./setup.ts";
import { clearedByProdFix } from "./streak.ts";

export interface CommandDeps {
	host: CosmicHost;
	cwdOf(agent: Agent, signal: AbortSignal): Promise<string>;
	questions(): UserQuestionService | undefined;
	authorization(): AuthorizationService | undefined;
}

const ok = (text: string): CommandResult => ({ kind: "success", text });
const fail = (text: string): CommandResult => ({ kind: "error", text });

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** 问人一句、等人填一段文字；界面弹不了问题时返回 undefined，人点了「不填了」返回 ""。 */
export async function askText(
	questions: UserQuestionService | undefined,
	agent: Agent | undefined,
	signal: AbortSignal,
	question: string,
	detail: string,
): Promise<string | undefined> {
	if (questions === undefined) return undefined;
	try {
		const answer = await questions.ask({
			...(agent === undefined ? {} : { agent }),
			signal,
			questions: [{ id: "cosmic-input", question, detail, options: [{ label: "不填了" }] }],
		});
		const item = answer.answers.find((one) => one.id === "cosmic-input");
		const custom = item?.custom?.trim();
		return custom === undefined || custom === "" ? "" : custom;
	} catch {
		return undefined;
	}
}

/** 配置向导问人的三种方式，接 dsh 的提问窗；弹不了就当人没答。`header` 是确认单的标题。 */
export function questionAsk(
	deps: Pick<CommandDeps, "questions">,
	agent: Agent | undefined,
	signal: AbortSignal,
	header = "工程配置",
): Ask {
	const one = async (question: Parameters<UserQuestionService["ask"]>[0]["questions"][number]) => {
		const questions = deps.questions();
		if (questions === undefined) return undefined;
		try {
			const answer = await questions.ask({
				...(agent === undefined ? {} : { agent }),
				signal,
				questions: [question],
			});
			return answer.answers.find((item) => item.id === question.id);
		} catch {
			return undefined;
		}
	};
	return {
		async text(question, detail) {
			return askText(deps.questions(), agent, signal, question, detail);
		},
		async choose(question, detail, options) {
			const item = await one({
				id: "cosmic-choose",
				question,
				detail,
				options: options.map((label) => ({ label })),
			});
			return item?.selected[0];
		},
		async approve(question, detail) {
			const item = await one({
				id: "cosmic-approve",
				header,
				question,
				detail,
				options: [{ label: "写入" }, { label: "不写" }],
				intent: { kind: "approval", approve: "写入", reject: "不写" },
			});
			return item?.selected.includes("写入") === true;
		},
	};
}

type AuthorizationPrompt = Parameters<Parameters<AuthorizationService["begin"]>[0]["interaction"]["prompt"]>[0];

/**
 * 登录流程要人答的一问：`select`（比如 codex 先问用浏览器还是设备码）弹成选项、回选项的 id；
 * `text`、`secret` 弹成填空。没答就抛错，登录取消。
 */
export async function answerAuthorizationPrompt(
	prompt: AuthorizationPrompt,
	ask: Ask,
	notices: string,
): Promise<string> {
	if (prompt.kind === "select") {
		const described = prompt.options
			.filter((option) => option.description !== undefined && option.description !== "")
			.map((option) => `${option.label}：${option.description ?? ""}`);
		const detail = [notices, described.join("\n")].filter((part) => part !== "").join("\n\n");
		const label = await ask.choose(
			prompt.message,
			detail,
			prompt.options.map((option) => option.label),
		);
		const chosen = prompt.options.find((option) => option.label === label);
		if (chosen === undefined) throw new Error("没有选，登录取消");
		return chosen.id;
	}
	const answer = await ask.text(prompt.message, notices);
	if (answer === undefined || answer.trim() === "") throw new Error("没有填写，登录取消");
	return answer.trim();
}

export function cosmicCommands(deps: CommandDeps): CommandDefinition[] {
	const { host } = deps;

	const env: CommandDefinition = {
		name: "cosmic-env",
		description: "重新识别工程、刷新代码关系表，报一遍苍穹环境",
		async handler(invocation) {
			const session = host.sessions.of(invocation.agent.id as string) as CosmicSession<ProjectHandle>;
			const call: CallContext = {
				tool: "cosmic_open_project",
				session,
				agent: invocation.agent,
				signal: invocation.signal,
				startedAt: now(),
				cwd: () => deps.cwdOf(invocation.agent, invocation.signal),
			};
			try {
				const setup = await configureProject(
					host.kernel,
					questionAsk(deps, invocation.agent, invocation.signal),
					await call.cwd(),
				);
				if (setup.kind === "stopped") return fail(setup.text);
				const project = await host.project(call, {});
				const index = await host.kernel.refreshIndex?.(project.handle);
				const summary = project.summary as unknown as Record<string, unknown>;
				const lines = [
					...(setup.text === "" ? [] : [setup.text]),
					`工程：${project.root}`,
					`运行时标识：${project.runtimeKeyId}`,
					...(Array.isArray(summary.notes) ? (summary.notes as string[]).map((note) => `- ${note}`) : []),
					...(index === undefined ? [] : [`代码关系表：${JSON.stringify(index)}`]),
				];
				return ok(lines.join("\n"));
			} catch (error) {
				return fail(`环境识别没做成：${errorText(error)}`);
			}
		},
	};

	const jvm: CommandDefinition = {
		name: "cosmic-jvm",
		description: "看本机 cosmic 开着的苍穹进程（几个、占多少内存、哪个在用）；/cosmic-jvm stop <pid> 停掉一个",
		async handler(invocation) {
			const kernel = host.kernel;
			if (kernel.localJvms === undefined || kernel.stopLocalJvm === undefined) return fail("这个宿主看不了本机进程");
			const parsed = parseJvmCommand(invocation.rawInput);
			if (parsed.kind === "bad") return fail(parsed.text);
			const scan = await kernel.localJvms({ listProcesses: true, clean: parsed.kind === "list" });
			const session = host.sessions.of(invocation.agent.id as string) as CosmicSession<ProjectHandle>;
			if (parsed.kind === "list") return ok(jvmListText(scan, session.project?.root, Date.now()));
			const target = scan.jvms.find((one) => one.pid === parsed.pid);
			if (target === undefined)
				return fail(
					`列表里没有 pid ${String(parsed.pid)}，没停。\n\n${jvmListText(scan, session.project?.root, Date.now())}`,
				);
			const stopped = await kernel.stopLocalJvm(target);
			return stopped.stopped ? ok(stopText(target, stopped.how)) : fail(stopText(target, stopped.how));
		},
	};

	const login: CommandDefinition = {
		name: "cosmic-login",
		description: "登录 ChatGPT 账号（codex），给 openai-codex 模型用",
		async handler(invocation) {
			const authorization = deps.authorization();
			if (authorization === undefined) return fail("这个宿主没有装授权服务，登录不了");
			const notices: string[] = [];
			try {
				const outcome = await authorization.begin({
					key: CODEX_AUTH_KEY,
					method: "oauth",
					interaction: {
						notify(notice) {
							notices.push(
								[
									notice.message,
									notice.url === undefined ? "" : `地址：${notice.url}`,
									notice.code === undefined ? "" : `代码：${notice.code}`,
								]
									.filter((part) => part !== "")
									.join("\n"),
							);
							if (notice.url !== undefined) {
								process.stderr.write(`[cosmic-login] ${notice.url}\n`);
								// 桌面、网页的提问窗里地址点不开，直接用系统浏览器打开；打不开时地址还在提问窗的说明里
								openWithSystemViewer(notice.url);
							}
						},
						async prompt(prompt) {
							// 回调先到时 dsh 只撤这一问（prompt.signal），整个登录还在
							const signal =
								prompt.signal === undefined
									? invocation.signal
									: AbortSignal.any([invocation.signal, prompt.signal]);
							return answerAuthorizationPrompt(
								prompt,
								questionAsk(deps, invocation.agent, signal),
								notices.join("\n\n"),
							);
						},
					},
				});
				return ok(`登录结果：${JSON.stringify(outcome)}`);
			} catch (error) {
				return fail(`登录没做成：${errorText(error)}${notices.length > 0 ? `\n\n${notices.join("\n\n")}` : ""}`);
			}
		},
	};

	const monitor: CommandDefinition = {
		name: "cosmic-monitor-login",
		description: "登录生产 monitor（查生产日志用）；验证码照图输入",
		async handler(invocation) {
			if (host.mode !== "prod") return fail("monitor 只在生产排障会话里用：新开一个生产排障会话再登录");
			const outcome = await loginMonitor(host.kernel, (question, detail) =>
				askText(deps.questions(), invocation.agent, invocation.signal, question, detail),
			);
			if (outcome.kind === "logged-in") {
				// 人自己登上了：之后过期了照样自动问，之前没登录数下的失败清零
				const session = host.sessions.of(invocation.agent.id as string);
				session.monitorPrompt.stopAsking = false;
				session.streak = clearedByProdFix(session.streak);
				return ok("monitor 已登录");
			}
			if (outcome.kind === "unavailable") return fail("这个界面弹不了输入框，monitor 没登录");
			if (outcome.kind === "declined") return fail("没输验证码，monitor 没登录");
			return fail(outcome.text);
		},
	};

	const prodSetup: CommandDefinition = {
		name: "cosmic-prod-setup",
		description: "填生产排障配置（生产库只读账号、monitor 账号）；试连后确认才写，配齐了的可以重填",
		async handler(invocation) {
			const kernel = host.kernel;
			const session = host.sessions.of(invocation.agent.id as string) as CosmicSession<ProjectHandle>;
			const call: CallContext = {
				tool: "cosmic_prod",
				session,
				agent: invocation.agent,
				signal: invocation.signal,
				startedAt: now(),
				cwd: () => deps.cwdOf(invocation.agent, invocation.signal),
			};
			// 试连要用工程类路径里的数据库驱动：先打开工程，打不开就不试连、照样能填
			let check: Parameters<typeof configureProd>[2];
			let openNote = "";
			try {
				const project = await host.project(call, {});
				if (kernel.prodSetupCheck !== undefined) {
					const prodCheck = kernel.prodSetupCheck;
					check = (draft, answers) => prodCheck(project.handle, draft, answers);
				}
			} catch (error) {
				openNote = `（工程没打开，没试连：${errorText(error)}）`;
			}
			const outcome = await configureProd(
				kernel,
				questionAsk(deps, invocation.agent, invocation.signal, "生产排障配置"),
				check,
				{ revise: true, askMonitor: true },
			);
			if (outcome.kind === "stopped") return fail(`${outcome.text}${openNote}`);
			// 人自己配过了：之后缺项、没登录照样自动问
			session.prodSetupPrompt.stopAsking = false;
			session.monitorPrompt.stopAsking = false;
			session.streak = clearedByProdFix(session.streak);
			return ok(`${outcome.text}${openNote}`);
		},
	};

	return host.mode === "prod" ? [env, jvm, login, prodSetup, monitor] : [env, jvm, login, prodSetup];
}
