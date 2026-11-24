/**
 * 生产排障配置向导：`~/.fast-ai-cosmic/prod/prod.json` 缺项时一项一项问人，试连一次，确认后才写。
 *
 * 两处用它：
 *   - `/cosmic-prod-setup` 命令：人主动配；配齐了的也能从这里重填数据库连接或 monitor 账号；
 *   - `cosmic_prod` 的调用（`ensureProdConfig`）：数据库那几项不齐就先弹向导，填完接着查。
 *     人点了「不填了」或没确认，本会话不再自动弹，之后照实返回「没配置」和命令用法。
 *
 * 写之前用还没落盘的答案连一次生产库：主机、端口、账号、密码填错了当场就知道，不用等到第一次查询。
 * 连不上时人可以重填、照样写（比如 VPN 还没连）、或者不写。
 *
 * 密码在提问框里是明文，只写到本机这个文件；确认单和返回给模型的话里都不带密码。
 */

import type { Agent } from "@deepseek-ai/dsh-agent";
import type { UserQuestionService } from "@deepseek-ai/dsh-user-questions";
import type { KernelResult } from "../kernel/errors.ts";
import {
	monitorUrlProblem,
	PROD_DB_FIELDS,
	PROD_DRIVERS,
	type ProdConfigDraft,
	type ProdDbField,
	type ProdSetupAnswers,
	prodDbFieldProblem,
} from "../kernel/prod/setup.ts";
import type { CosmicKernel } from "./kernel.ts";
import type { Ask } from "./setup.ts";

export type ProdSetupOutcome = { kind: "ready"; text: string } | { kind: "stopped"; text: string };

type ProdSetupKernel = Pick<CosmicKernel, "prodSetupDraft" | "prodSetupWrite">;
/** 用答案试连；拿不到工程（连接要用工程类路径里的驱动）时不传 */
export type ProdCheck = (draft: ProdConfigDraft, answers: ProdSetupAnswers) => Promise<KernelResult<string>>;

const MAX_TRIES = 3;

const DB_QUESTIONS: Record<Exclude<ProdDbField, "driver">, [string, string]> = {
	host: ["生产库主机", "IP 或域名"],
	port: ["生产库端口", "数字，例如 8000"],
	database: ["生产库库名", "数据库名"],
	user: ["生产库只读账号", "只读账号；写权限的账号不要填"],
	password: ["生产库密码", "提问框里看得见明文；只写到本机这个文件，不进工程目录，也不发给模型"],
};

const RETRY = "重填数据库连接";
const WRITE_ANYWAY = "照样写入";
const GIVE_UP = "不写了";
const MONITOR_NOW = "现在配";
const MONITOR_LATER = "先不配";

/** 问一段文字，按 problem 校验，错了带上原因再问；人不填了是 undefined */
async function askValid(
	ask: Ask,
	question: string,
	hint: string,
	problemOf: (raw: string) => string | null,
	secret = false,
): Promise<string | undefined> {
	let problem = "";
	for (let tries = 0; tries < MAX_TRIES; tries += 1) {
		const raw = await ask.text(`生产排障配置 · ${question}`, problem === "" ? hint : `${problem}\n${hint}`);
		if (raw === undefined || raw === "") return undefined;
		const why = problemOf(raw);
		if (why === null) return raw;
		problem = secret ? `上次填的不行：${why}` : `上次填的「${raw.trim()}」不行：${why}`;
	}
	return undefined;
}

function nowIs(draft: ProdConfigDraft, field: ProdDbField): string {
	const value = draft.current[field];
	return value === undefined ? "" : `（现在是 ${value}）`;
}

async function askDb(
	ask: Ask,
	draft: ProdConfigDraft,
	fields: readonly ProdDbField[],
): Promise<Partial<Record<ProdDbField, string>> | undefined> {
	const db: Partial<Record<ProdDbField, string>> = {};
	for (const field of fields) {
		if (field === "driver") {
			const chosen = await ask.choose(
				"生产排障配置 · 生产库类型",
				`苍穹自带高斯库选 opengauss；华为 GaussDB 选 gaussdb；PostgreSQL 选 postgresql${nowIs(draft, field)}`,
				PROD_DRIVERS,
			);
			if (chosen === undefined) return undefined;
			db.driver = chosen;
			continue;
		}
		const [question, hint] = DB_QUESTIONS[field];
		const answer = await askValid(
			ask,
			question,
			`${hint}${nowIs(draft, field)}`,
			(raw) => prodDbFieldProblem(field, raw),
			field === "password",
		);
		if (answer === undefined) return undefined;
		db[field] = answer;
	}
	return db;
}

async function askMonitor(ask: Ask, draft: ProdConfigDraft): Promise<ProdSetupAnswers["monitor"] | undefined> {
	const was = (value: string | undefined) => (value === undefined ? "" : `（现在是 ${value}）`);
	const url = await askValid(
		ask,
		"monitor 地址",
		`形如 https://<主机>/monitor/eye${was(draft.current.monitorUrl)}`,
		monitorUrlProblem,
	);
	if (url === undefined) return undefined;
	const username = await askValid(
		ask,
		"monitor 账号",
		`登录 monitor 的账号${was(draft.current.monitorUsername)}`,
		(raw) => (raw.trim() === "" ? "不能为空" : null),
	);
	if (username === undefined) return undefined;
	const password = await askValid(
		ask,
		"monitor 密码",
		"提问框里看得见明文；只写到本机这个文件",
		(raw) => (raw === "" ? "不能为空" : null),
		true,
	);
	if (password === undefined) return undefined;
	return { url, username, password };
}

function stopped(text: string): ProdSetupOutcome {
	return { kind: "stopped", text };
}

/**
 * 读配置 → 缺什么问什么 → 试连 → 确认 → 写。
 * `revise`：配置本来就齐时问人要不要重填（命令用）；不给时齐了就直接 ready、一句不问（工具调用前用）。
 * `askMonitor`：monitor 没配时问要不要现在配。
 */
export async function configureProd(
	kernel: ProdSetupKernel,
	ask: Ask,
	check: ProdCheck | undefined,
	options: { revise: boolean; askMonitor: boolean },
): Promise<ProdSetupOutcome> {
	if (kernel.prodSetupDraft === undefined || kernel.prodSetupWrite === undefined)
		return stopped("这个宿主不支持生产排障配置向导");
	const draft = kernel.prodSetupDraft();
	if (draft.parseError !== null)
		return stopped(`生产排障配置不是合法 JSON，没有覆盖：${draft.file}\n${draft.parseError}`);

	let dbFields: readonly ProdDbField[] = draft.badDb;
	let monitorWanted = options.askMonitor && !draft.monitorConfigured && draft.badDb.length > 0;
	if (draft.badDb.length === 0) {
		const choices = options.revise
			? [RETRY, draft.monitorConfigured ? "重填 monitor 账号" : "配 monitor 账号", "不改"]
			: [];
		if (choices.length === 0) {
			if (!options.askMonitor || draft.monitorConfigured) return { kind: "ready", text: "" };
			monitorWanted = true;
		} else {
			const chosen = await ask.choose("生产排障配置已齐，要改哪部分？", `${draft.summary ?? draft.file}`, choices);
			if (chosen === undefined || chosen === "不改")
				return { kind: "ready", text: `没改。\n${draft.summary ?? ""}` };
			if (chosen === RETRY) dbFields = PROD_DB_FIELDS;
			else monitorWanted = true;
		}
	}

	const answers: ProdSetupAnswers = {};
	let checkLine = "";
	if (dbFields.length > 0) {
		for (let round = 0; ; round += 1) {
			const db = await askDb(ask, draft, dbFields);
			if (db === undefined) return stopped("生产排障配置没填完，没写。");
			answers.db = db;
			if (check === undefined) {
				checkLine = "没试连（还没打开工程，连接要用工程类路径里的驱动）";
				break;
			}
			const tried = await check(draft, answers);
			if (tried.ok) {
				checkLine = tried.value;
				break;
			}
			const why = `${tried.error.message}${tried.error.remedy ? `（${tried.error.remedy}）` : ""}`;
			const next = round + 1 < MAX_TRIES ? [RETRY, WRITE_ANYWAY, GIVE_UP] : [WRITE_ANYWAY, GIVE_UP];
			const chosen = await ask.choose("生产排障配置 · 试连没连上", why, next);
			if (chosen === WRITE_ANYWAY) {
				checkLine = `试连没连上：${why}`;
				break;
			}
			if (chosen !== RETRY) return stopped(`试连没连上，没写：${why}`);
			dbFields = PROD_DB_FIELDS;
		}
	}

	if (monitorWanted) {
		const chosen =
			options.revise && draft.badDb.length === 0
				? MONITOR_NOW
				: await ask.choose(
						"生产排障配置 · 要不要配 monitor 账号？",
						"查生产日志要用；不配也能查库和元数据，以后输入 /cosmic-prod-setup 再配",
						[MONITOR_NOW, MONITOR_LATER],
					);
		if (chosen === undefined) return stopped("生产排障配置没填完，没写。");
		if (chosen === MONITOR_NOW) {
			const monitor = await askMonitor(ask, draft);
			if (monitor === undefined) return stopped("monitor 账号没填完，没写。");
			answers.monitor = monitor;
		}
	}
	if (answers.db === undefined && answers.monitor === undefined) return { kind: "ready", text: "没改。" };

	const shown: string[] = [draft.file, ""];
	for (const [field, value] of Object.entries(answers.db ?? {}))
		shown.push(`db.${field} = ${field === "password" ? "（已填，不显示）" : (value ?? "").trim()}`);
	if (answers.monitor !== undefined)
		shown.push(
			`monitor = ${answers.monitor.url.trim()}（账号 ${answers.monitor.username.trim()}，密码已填，不显示）`,
		);
	if (checkLine !== "") shown.push("", checkLine);
	shown.push("", "只改上面这几项，文件里别的内容原样留着。这个文件只在本机，不进工程目录。");
	const confirmed = await ask.approve("写入生产排障配置？", shown.join("\n"));
	if (!confirmed) return stopped("没确认，生产排障配置没写。");
	const written = kernel.prodSetupWrite(draft, answers);
	if (!written.ok)
		return stopped(
			`生产排障配置没写成：${written.error.message}${written.error.remedy ? `（${written.error.remedy}）` : ""}`,
		);
	return {
		kind: "ready",
		text: [`生产排障配置已写入 ${written.value.file}`, checkLine].filter((line) => line !== "").join("\n"),
	};
}

/** 一个会话里生产排障配置向导问到哪一步了 */
export interface ProdSetupPromptState {
	/** 人不填了或没确认：本会话不再自动弹 */
	stopAsking: boolean;
	/** 同一轮并行的几个调用只弹一个向导，其余的等它 */
	flight: Promise<ProdSetupOutcome> | undefined;
}

export function initialProdSetupPromptState(): ProdSetupPromptState {
	return { stopAsking: false, flight: undefined };
}

/**
 * cosmic_prod 执行前调：数据库那几项不齐就弹向导（monitor 没配顺带问要不要配）。
 * 填没填都不拦这次调用：没填上，内核会照实返回「没配置」。
 */
export async function ensureProdConfig(
	kernel: ProdSetupKernel,
	state: ProdSetupPromptState,
	ask: Ask,
	check: ProdCheck | undefined,
	signal: AbortSignal,
): Promise<ProdSetupOutcome | null> {
	if (state.flight !== undefined) return state.flight;
	if (state.stopAsking || kernel.prodSetupDraft === undefined) return null;
	const draft = kernel.prodSetupDraft();
	if (draft.parseError !== null || draft.badDb.length === 0) return null;
	state.flight = configureProd(kernel, ask, check, { revise: false, askMonitor: true });
	try {
		const outcome = await state.flight;
		// 这次调用被中途取消（人停了这一轮）不算人不填，下次照样问
		if (outcome.kind === "stopped" && !signal.aborted) state.stopAsking = true;
		return outcome;
	} finally {
		state.flight = undefined;
	}
}

export const ALLOW_PROD = "允许";
export const DENY_PROD = "不允许";
export const PROD_CONSENT_QUESTION = "这个会话要查生产，允许吗？";
export const PROD_CONSENT_DETAIL =
	"只读查生产库、生产元数据和 monitor 日志，不写生产；每次查询记在工程的 .cosmic-ai/evidence/prod-audit.jsonl。允许后本会话不再问。";

/**
 * 问人「这个会话能不能查生产」的结果。`unavailable` 是框根本弹不出来（无界面运行时提问服务没有人能答，
 * 直接报错），和人点了「不允许」、跳过不是一回事。
 */
export type ProdConsentAnswer = "allowed" | "declined" | "unavailable";
export type AskProdConsent = () => Promise<ProdConsentAnswer>;

/**
 * 经 dsh 的提问服务问一次。提问服务报错（无界面运行时没有人能答，报 NO_PROVIDER）算弹不出来；
 * 人点了「不允许」或跳过才算不同意；人中途停了这一轮也会报错，那不是弹不出来，算不同意。
 * 不借 `questionAsk`：它把报错和跳过都变成「没答」，无界面运行就永远查不了生产。
 */
export async function askProdConsentVia(
	questions: UserQuestionService | undefined,
	agent: Agent | undefined,
	signal: AbortSignal,
): Promise<ProdConsentAnswer> {
	if (questions === undefined) return "unavailable";
	try {
		const answer = await questions.ask({
			...(agent === undefined ? {} : { agent }),
			signal,
			questions: [
				{
					id: "cosmic-prod-consent",
					header: "查生产",
					question: PROD_CONSENT_QUESTION,
					detail: PROD_CONSENT_DETAIL,
					options: [{ label: ALLOW_PROD }, { label: DENY_PROD }],
					intent: { kind: "approval", approve: ALLOW_PROD, reject: DENY_PROD },
				},
			],
		});
		const item = answer.answers.find((one) => one.id === "cosmic-prod-consent");
		return item?.selected.includes(ALLOW_PROD) === true ? "allowed" : "declined";
	} catch {
		return signal.aborted ? "declined" : "unavailable";
	}
}

/** 本会话查生产问没问过人、人答了什么 */
export interface ProdConsentState {
	/** 人点过「允许」：本会话之后不再问 */
	allowed: boolean;
	/** 同一轮并行的几个调用只弹一个框，其余的等它 */
	flight: Promise<ProdConsentAnswer> | undefined;
}

export function initialProdConsentState(): ProdConsentState {
	return { allowed: false, flight: undefined };
}

/**
 * 本会话第一次连生产前问人一次。开发和查生产在同一个会话里，这个框让人看得见「这个会话碰了生产」，
 * 也拦住普通开发需求里顺手去查生产。允许了本会话不再问；不允许或跳过，这次不查，下次调用再问。
 * 框弹不出来（没有提问服务，或无界面运行时没有人能答）就放行：生产只读靠的是 cosmic_prod 的闸，不是这个框。
 */
export async function ensureProdConsent(state: ProdConsentState, ask: AskProdConsent | undefined): Promise<boolean> {
	if (state.allowed || ask === undefined) return true;
	state.flight ??= ask();
	const flight = state.flight;
	try {
		const answer = await flight;
		if (answer === "allowed") state.allowed = true;
		return answer !== "declined";
	} finally {
		if (state.flight === flight) state.flight = undefined;
	}
}
