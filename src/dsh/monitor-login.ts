/**
 * monitor 登录：验证码只能人照图输入，模型碰不到图也碰不到输入框。
 *
 * 两处用它：
 *   - `/cosmic-monitor-login` 命令（人主动登）；
 *   - 排障会话里 `cosmic_prod` 的调用（`ensureMonitorLogin`）：会话里第一次用、以及每次查日志前，
 *     monitor 没登录或过期就弹验证码框，人输完再接着查。桌面版选「生产排障」新建会话这一步不经过任何命令，
 *     不在这里补，人就得自己想起来敲命令；而提问框要挂在一个正在跑的会话上，工具执行中弹是确认能弹出来的时机
 *     （写元数据确认单走的同一条路）。
 * 人点了「不填了」或界面弹不了，本会话就不再问；之后查日志照常返回「没登录」和命令用法。
 */

import { openWithSystemViewer } from "../agent/tools/open-viewer.ts";
import type { CosmicKernel } from "./kernel.ts";

/** 问人一段文字：界面弹不了是 undefined，人点了「不填了」是 ""。 */
export type AskCode = (question: string, detail: string) => Promise<string | undefined>;

type MonitorKernel = Pick<CosmicKernel, "prodMonitorCaptcha" | "prodMonitorLogin" | "prodMonitorPing">;

export type MonitorLoginOutcome =
	| { kind: "logged-in" }
	/** 没配 monitor 账号：不是错，排障照样能查库和元数据 */
	| { kind: "not-configured"; text: string }
	| { kind: "declined" }
	| { kind: "unavailable" }
	| { kind: "failed"; text: string };

/** 验证码输错时换一张图再问，最多问这么多次 */
export const MONITOR_LOGIN_ATTEMPTS = 3;

function failureText(error: { message: string; remedy?: string }): string {
	return `${error.message}${error.remedy ? `（${error.remedy}）` : ""}`;
}

export async function loginMonitor(
	kernel: MonitorKernel,
	ask: AskCode,
	open: (file: string) => unknown = openWithSystemViewer,
): Promise<MonitorLoginOutcome> {
	if (kernel.prodMonitorCaptcha === undefined || kernel.prodMonitorLogin === undefined)
		return { kind: "failed", text: "这个宿主不支持 monitor 登录" };
	let previous = "";
	for (let attempt = 1; attempt <= MONITOR_LOGIN_ATTEMPTS; attempt++) {
		const captcha = await kernel.prodMonitorCaptcha();
		if (!captcha.ok) {
			if (captcha.error.code === "PROD_CONFIG_MISSING")
				return { kind: "not-configured", text: failureText(captcha.error) };
			return { kind: "failed", text: `monitor 登录没做成：${failureText(captcha.error)}` };
		}
		let code = "";
		if (captcha.value.required) {
			const file = captcha.value.imageFile;
			if (file !== null) open(file);
			const where = file === null ? "照图输入验证码" : `验证码图片已用看图程序打开：${file}`;
			const answer = await ask(
				`monitor 验证码（账号 ${captcha.value.username}）`,
				previous === "" ? where : `${previous}；换了一张图。${where}`,
			);
			if (answer === undefined) return { kind: "unavailable" };
			if (answer.trim() === "") return { kind: "declined" };
			code = answer.trim();
		}
		const login = await kernel.prodMonitorLogin(captcha.value, code);
		if (login.ok) return { kind: "logged-in" };
		previous = failureText(login.error);
		// 不要验证码还登不上，是账号或网络的事，再问人也没用
		if (!captcha.value.required) break;
	}
	return { kind: "failed", text: previous };
}

/** 一个排障会话里 monitor 登录问到哪一步了 */
export interface MonitorPromptState {
	/** 会话里第一次用 cosmic_prod 时已经看过一次 */
	checked: boolean;
	/** 人不登或界面弹不了：本会话不再问 */
	stopAsking: boolean;
}

export function initialMonitorPromptState(): MonitorPromptState {
	return { checked: false, stopAsking: false };
}

/**
 * cosmic_prod 执行前调：会话里第一次用、或这次要查日志时，monitor 没登录就请人登。
 * 登没登成都不拦这次调用：查库、查元数据不需要 monitor；查日志没登上，内核会照实返回「没登录」。
 */
export async function ensureMonitorLogin(
	kernel: MonitorKernel,
	state: MonitorPromptState,
	needsMonitor: boolean,
	ask: AskCode,
	signal: AbortSignal,
	open?: (file: string) => unknown,
): Promise<MonitorLoginOutcome | null> {
	if (state.stopAsking || kernel.prodMonitorPing === undefined) return null;
	if (state.checked && !needsMonitor) return null;
	state.checked = true;
	if ((await kernel.prodMonitorPing()) === "alive") return null;
	const outcome = await loginMonitor(kernel, ask, open);
	// 这次调用被中途取消（人停了这一轮）不算人不登，下次照样问
	if (signal.aborted) return outcome;
	if (outcome.kind === "declined" || outcome.kind === "unavailable" || outcome.kind === "not-configured")
		state.stopAsking = true;
	return outcome;
}
