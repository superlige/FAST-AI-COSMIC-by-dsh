/**
 * 工程配置向导：只问工程文件里答不出来的两项——账套（数据中心）和用户。
 *
 * 别的必填项（ISV、调试模块、代码模块、启动类、配置方法）都是工程文件里的事实：自动探测认得出就不问，
 * 认不出就交给模型读工程文件、用 `cosmic_doctor action=config` 写，不来问人。
 * 账套和用户不一样：工程里没有答案，填错了也没有任何症状（连的是别的账套、修改人记在别人头上），
 * 所以只让人选，而且是从环境里查出来的名单里选：
 *   - 账套：起一次冷进程列出这个环境的全部账套（约半分钟），选一个；列不出来才让人敲编码；
 *   - 用户：问手机号（也认用户名、姓名），连环境查出候选来选；要直接给 id 写 `id:1234567`。
 * 人选的就是答案，选完直接写，不再弹确认单。只补空字段。
 *
 * 问人的事交给 `Ask`（命令里接 dsh 的提问窗），这里只管流程，测试用假的 `Ask`。
 */

import type { ProjectConfigAnswers } from "../kernel/config/initialize.ts";
import { validateProjectConfigAnswers } from "../kernel/config/initialize.ts";
import { USER_ANSWERED_FIELDS } from "../kernel/config/load-config.ts";
import type { CosmicKernel } from "./kernel.ts";

export interface Ask {
	/** 问一段文字。人点了「不填了」或界面弹不了：undefined。 */
	text(question: string, detail: string): Promise<string | undefined>;
	/** 从几项里选一项，返回选中的那一项；没选：undefined。 */
	choose(question: string, detail: string, options: readonly string[]): Promise<string | undefined>;
	/** 确认单，点了确认才是 true。 */
	approve(question: string, detail: string): Promise<boolean>;
}

export type SetupOutcome = { kind: "ready"; root: string; text: string } | { kind: "stopped"; text: string };

type Kernel = Pick<CosmicKernel, "doctor" | "discover" | "initializeConfig" | "lookupUsers" | "lookupAccounts">;

/** 同一项填错这么多次就停下：问到天荒地老不如让人去改文件。 */
const MAX_TRIES = 3;

const DIRECT_USER_ID = /^id[:：]\s*(\S+)$/i;
const TYPE_ACCOUNT = "手工输入账套编码";
const RETRY_USER = "重新输入关键字";

function errorLine(error: { message: string; remedy?: string }): string {
	return error.remedy ? `${error.message}（${error.remedy}）` : error.message;
}

/** 敲账套编码：列表拿不到，或人要的不在列表里。 */
async function typeAccount(ask: Ask, problem: string): Promise<string | undefined> {
	let hint = problem === "" ? "账套编码或账套 ID" : `${problem}\n账套编码或账套 ID`;
	for (let tries = 0; tries < MAX_TRIES; tries += 1) {
		const raw = await ask.text("工程配置 · 账套（数据中心）", hint);
		if (raw === undefined || raw.trim() === "") return undefined;
		const problems = validateProjectConfigAnswers({ account: raw.trim() }, []);
		if (problems.length === 0) return raw.trim();
		hint = `${problems.join("；")}\n账套编码或账套 ID`;
	}
	return undefined;
}

/** 从环境列出的账套里选一个；写进配置的是账套编码。 */
async function askAccount(
	ask: Ask,
	kernel: Kernel,
	root: string,
): Promise<{ account: string; note: string } | undefined> {
	if (kernel.lookupAccounts === undefined) {
		const typed = await typeAccount(ask, "");
		return typed === undefined ? undefined : { account: typed, note: "" };
	}
	// 连真实环境：一次冷启动，约半分钟
	const found = await kernel.lookupAccounts(root, {});
	const candidates = found.ok ? found.value.candidates : [];
	if (candidates.length === 0) {
		const why = found.ok
			? `当前环境未列出任何账套（探针原文：${found.value.outputFile}）`
			: `列出账套失败：${errorLine(found.error)}`;
		const typed = await typeAccount(ask, why);
		return typed === undefined ? undefined : { account: typed, note: "" };
	}
	const labels = candidates.map((one) => `${one.number} · ${one.name || "(无名称)"} · id=${one.id}`);
	const chosen = await ask.choose(
		"工程配置 · 选择账套（数据中心）",
		"以下是当前环境的全部账套；选中的账套将写入工程配置的 account，之后的探针和真跑业务都连接它",
		[...labels, TYPE_ACCOUNT],
	);
	if (chosen === undefined) return undefined;
	if (chosen === TYPE_ACCOUNT) {
		const typed = await typeAccount(ask, "");
		return typed === undefined ? undefined : { account: typed, note: "" };
	}
	const picked = candidates[labels.indexOf(chosen)];
	if (picked === undefined) return undefined;
	const account = picked.number || picked.id;
	return { account, note: `account = ${picked.name || account}（${account}）` };
}

async function askUser(
	ask: Ask,
	kernel: Kernel,
	root: string,
	answers: ProjectConfigAnswers,
): Promise<{ id: string; note: string } | undefined> {
	const hint = "请输入手机号（也支持用户名或姓名）；已知 id 可直接输入 id:1234567";
	let problem = "";
	for (let tries = 0; tries < MAX_TRIES; tries += 1) {
		const raw = await ask.text("工程配置 · 用户", problem === "" ? hint : `${problem}\n${hint}`);
		if (raw === undefined || raw.trim() === "") return undefined;
		const keyword = raw.trim();
		const direct = DIRECT_USER_ID.exec(keyword)?.[1];
		if (direct !== undefined || kernel.lookupUsers === undefined) {
			const id = direct ?? keyword;
			const problems = validateProjectConfigAnswers({ user: id }, []);
			if (problems.length === 0) return { id, note: "" };
			problem = problems.join("；");
			continue;
		}
		// 这一步连真实环境；账套还没落盘，作为本次查询的覆盖传进去
		const found = await kernel.lookupUsers(root, keyword, {
			...(answers.account === undefined ? {} : { account: answers.account }),
		});
		if (!found.ok) {
			problem = `查询用户失败：${errorLine(found.error)}`;
			continue;
		}
		const candidates = found.value.candidates;
		if (candidates.length === 0) {
			problem = `没有匹配「${keyword}」的可用用户，请更换关键字，或输入 id:1234567 直接指定`;
			continue;
		}
		const labels = candidates.map(
			(one, index) =>
				`${String(index + 1)}) ${one.name || "(无姓名)"} · ${one.username || one.number || "(无用户名)"} · ${one.phoneMask || "无手机号"} · id=${one.id}`,
		);
		const chosen = await ask.choose(
			"工程配置 · 选择用户",
			found.value.truncated
				? "匹配结果已达上限，部分用户未列出，可使用更精确的关键字缩小范围。选中的用户将写入工程配置的 user"
				: "选中的用户将写入工程配置的 user，之后写入数据的修改人记为该用户",
			[...labels, RETRY_USER],
		);
		if (chosen === undefined) return undefined;
		const picked = candidates[labels.indexOf(chosen)];
		if (chosen === RETRY_USER || picked === undefined) {
			problem = "";
			tries -= 1;
			continue;
		}
		return { id: picked.id, note: `user = ${picked.name || picked.number || picked.id}（${picked.id}）` };
	}
	return undefined;
}

const configuredListeners = new Set<(root: string) => void>();

/**
 * 工程配置齐了（向导写完、或者本来就齐）时通知：JVM 状态板据此把停在「配置不全」的会话重新走一趟，
 * 首页的等初始化动画才会接着往下走。返回退订函数。
 */
export function onProjectConfigured(listener: (root: string) => void): () => void {
	configuredListeners.add(listener);
	return () => {
		configuredListeners.delete(listener);
	};
}

/**
 * 认工程 → 诊断 → 工程里认不出来的项交还给模型 → 账套、用户问人 → 写 → 再诊断。
 * 配置本来就齐的直接 ready，不问人。
 */
export async function configureProject(kernel: Kernel, ask: Ask, cwd: string): Promise<SetupOutcome> {
	const outcome = await configureSteps(kernel, ask, cwd);
	if (outcome.kind === "ready") for (const listener of configuredListeners) listener(outcome.root);
	return outcome;
}

async function configureSteps(kernel: Kernel, ask: Ask, cwd: string): Promise<SetupOutcome> {
	if (kernel.discover === undefined || kernel.initializeConfig === undefined)
		return { kind: "stopped", text: "当前宿主不支持工程配置向导" };
	const discovered = await kernel.discover(cwd);
	if (!discovered.ok) return { kind: "stopped", text: `未识别苍穹工程：${errorLine(discovered.error)}` };
	const root = discovered.value.root;
	const diagnosed = await kernel.doctor(root);
	if (!diagnosed.ok) return { kind: "stopped", text: `环境诊断失败：${errorLine(diagnosed.error)}` };
	const report = diagnosed.value;
	if (report.parseError !== null)
		return {
			kind: "stopped",
			text: `配置 JSON 已损坏，未覆盖：${report.parseErrorFile ?? report.projectConfigFile}\n${report.parseError}`,
		};
	if (report.ok) return { kind: "ready", root, text: "" };

	const missing = report.missingRequired.map((item) => item.field);
	const fromProject = missing.filter((field) => !USER_ANSWERED_FIELDS.includes(field));
	// 账套要起 JVM 去列，起 JVM 要先有启动类这些：工程里的先补齐，才轮到问人
	if (fromProject.length > 0)
		return {
			kind: "stopped",
			text:
				`${fromProject.join("、")} 需要从工程文件中识别，当前工程未能识别。` +
				`请在会话中让模型排查（模型读取工程文件，用 cosmic_doctor action=config 写入），或手工写入 ${report.projectConfigFile}。`,
		};

	const answers: ProjectConfigAnswers = {};
	const notes: string[] = [];
	if (missing.includes("account")) {
		const picked = await askAccount(ask, kernel, root);
		if (picked === undefined) return { kind: "stopped", text: "工程配置未完成（停在「账套」），未写入。" };
		answers.account = picked.account;
		if (picked.note !== "") notes.push(picked.note);
	}
	if (missing.includes("user")) {
		const picked = await askUser(ask, kernel, root, answers);
		if (picked === undefined) return { kind: "stopped", text: "工程配置未完成（停在「用户」），未写入。" };
		answers.user = picked.id;
		if (picked.note !== "") notes.push(picked.note);
	}
	const written = await kernel.initializeConfig(root, answers, report.modules.declared);
	if (!written.ok) return { kind: "stopped", text: `工程配置写入失败：${errorLine(written.error)}` };
	const again = await kernel.doctor(root);
	if (!again.ok)
		return { kind: "stopped", text: `配置已写入 ${written.value.file}，但重新诊断失败：${errorLine(again.error)}` };
	if (!again.value.ok)
		return {
			kind: "stopped",
			text: `配置已写入 ${written.value.file}，环境仍有问题：${again.value.nextActions.join("；")}`,
		};
	return {
		kind: "ready",
		root,
		text: `工程配置已写入 ${written.value.file}（补充了 ${written.value.writtenFields.join("、")}）${notes.length > 0 ? `：${notes.join("，")}` : ""}`,
	};
}

/** 一个会话里工程配置向导自动弹到哪一步了 */
export interface SetupPromptState {
	/** 人不填了或没确认：本会话不再自动弹，要配就自己敲 /cosmic-env */
	stopAsking: boolean;
	/** 同一轮并行的几个调用只弹一个向导，其余的等它 */
	flight: Promise<SetupOutcome> | undefined;
}

export function initialSetupPromptState(): SetupPromptState {
	return { stopAsking: false, flight: undefined };
}

/**
 * 工具调用要打开工程、内核说配置不全时调：直接在这次调用里弹向导。
 * 桌面版新建会话不经过任何命令，不在这里补，人就得先知道要敲 /cosmic-env；
 * 提问框要挂在一个正在跑的会话上，工具执行中弹是确认能弹出来的时机（写元数据确认单走的同一条路）。
 * 返回 null：本会话人已经不填过了，不再问。
 */
export async function configureInCall(
	kernel: Kernel,
	state: SetupPromptState,
	ask: Ask,
	root: string,
	signal: AbortSignal,
): Promise<SetupOutcome | null> {
	if (state.flight !== undefined) return state.flight;
	if (state.stopAsking) return null;
	state.flight = configureProject(kernel, ask, root);
	try {
		const outcome = await state.flight;
		// 这次调用被中途取消（人停了这一轮）不算人不填，下次照样问
		if (outcome.kind === "stopped" && !signal.aborted) state.stopAsking = true;
		return outcome;
	} finally {
		state.flight = undefined;
	}
}
