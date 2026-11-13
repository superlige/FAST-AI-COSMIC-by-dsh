/**
 * 金蝶 monitor 的日志查询（只读）：登录、查询、会话保存。
 *
 * 接口是从 monitor 前端代码里认出来的（2026-11-11 真机核对过）：
 *   POST <base>/eye/verifyCode {key}            → {enable, code(验证码图 data URL), loginId}
 *   POST <base>/eye/getPublicKey {userName}     → {publicKey}
 *   POST <base>/eye/login {username, password(RSA-OAEP-SHA1 加密后 base64), verifycode, key, loginId}
 *        验证码文字另放在 cookie verifyCode 里；登录成功后响应头 monitor-csrf-token、cookie ierp-cluster-Auth_Token
 *   POST <base>/eye/queryLogDatasource {}       → {default, datasource[], logKeywordEncryptEnable}
 *   POST <base>/eye/logQuery/query <表单>        → data: 日志行数组；没登录或过期回 code 50009
 * <base> 是配置里 url 去掉末尾 /eye。
 *
 * 验证码开着的环境只能由人输：这里只取图、只收人给的字，从不自己认图。所以登录只在用户敲的
 * 斜杠命令里发生，模型这一侧遇到「没登录」只会拿到一句「请用户登录」。
 */
import { constants, publicEncrypt, randomBytes } from "node:crypto";
import { err, KernelError, type KernelResult, ok } from "../errors.ts";
import type { FsPort } from "../ports.ts";
import type { ProdMonitorConfig } from "./config.ts";

export interface HttpReply {
	status: number;
	text: string;
	header(name: string): string | null;
	setCookies: string[];
}

/** 能换掉的 HTTP：测试里塞假的，真跑用 fetch */
export interface HttpPort {
	post(url: string, body: unknown, headers: Record<string, string>): Promise<HttpReply>;
}

export const nodeHttp: HttpPort = {
	async post(url, body, headers) {
		const res = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json;charset=UTF-8", ...headers },
			body: JSON.stringify(body ?? {}),
			signal: AbortSignal.timeout(60_000),
		});
		const text = await res.text();
		return {
			status: res.status,
			text,
			header: (name) => res.headers.get(name),
			setCookies: res.headers.getSetCookie(),
		};
	},
};

export interface MonitorSession {
	username: string;
	cookies: [string, string][];
	csrf: string;
	loggedInAt: number;
	keywordBase64: boolean | null;
	datasource: string;
}

export interface MonitorCaptcha {
	required: boolean;
	loginId: string;
	/** 验证码图（JPEG/PNG 字节），不需要验证码时为 null */
	image: Uint8Array | null;
	imageType: string;
}

export interface MonitorFilter {
	traceId?: string;
	formId?: string;
	opKey?: string;
	className?: string;
	methodName?: string;
	userName?: string;
	appName?: string;
	ip?: string;
	level?: string;
	keyword?: string;
	/** ISO 时间；不给就按 minutes 往回推 */
	from?: string;
	to?: string;
	minutes?: number;
	size?: number;
}

export type MonitorRow = Record<string, unknown> & {
	level?: string;
	className?: string;
	methodName?: string;
	line?: number;
	time?: string;
	message?: string;
	message2?: string;
	logtags?: Record<string, string>;
	ip?: string;
	appName?: string;
	instanceId?: string;
};

const LOGIN_EXPIRED = 50009;
export const MONITOR_SIZE_CEILING = 5000;

function base(config: ProdMonitorConfig): string {
	return config.url.replace(/\/eye\/?$/, "");
}

function monitorFailure(message: string, remedy = "请用户确认 VPN 已连上、monitor 网页能打开。"): KernelError {
	return new KernelError("PROD_MONITOR_FAILED", message, { remedy });
}

export function loginRequired(why: string): KernelError {
	return new KernelError("PROD_MONITOR_LOGIN_REQUIRED", `monitor ${why}`, {
		remedy:
			"monitor 登录要输验证码，只能由用户来：请用户在输入框敲 /cosmic-prod login 登录，登录后再查日志。不要自己尝试登录。",
	});
}

function cookieHeader(cookies: readonly [string, string][]): string {
	return cookies.map(([k, v]) => `${k}=${v}`).join("; ");
}

function absorbCookies(cookies: [string, string][], setCookies: readonly string[]): void {
	for (const raw of setCookies) {
		const pair = raw.split(";")[0] ?? "";
		const eq = pair.indexOf("=");
		if (eq <= 0) continue;
		const name = pair.slice(0, eq).trim();
		const value = pair.slice(eq + 1);
		const at = cookies.findIndex(([k]) => k === name);
		if (at >= 0) cookies[at] = [name, value];
		else cookies.push([name, value]);
	}
}

function parse(reply: HttpReply): Record<string, unknown> | null {
	try {
		return JSON.parse(reply.text) as Record<string, unknown>;
	} catch {
		return null;
	}
}

export function loadMonitorSession(fs: FsPort, file: string, username: string): MonitorSession | null {
	if (!fs.exists(file)) return null;
	try {
		const value = JSON.parse(fs.read(file)) as MonitorSession;
		if (value.username !== username || !Array.isArray(value.cookies) || typeof value.csrf !== "string") return null;
		return value;
	} catch {
		return null;
	}
}

export function saveMonitorSession(fs: FsPort, file: string, session: MonitorSession): void {
	fs.write(file, JSON.stringify(session));
}

/** 第一步：问要不要验证码，要的话把图取回来 */
export async function monitorCaptcha(http: HttpPort, config: ProdMonitorConfig): Promise<KernelResult<MonitorCaptcha>> {
	let reply: HttpReply;
	try {
		reply = await http.post(`${base(config)}/eye/verifyCode`, { key: randomBytes(8).toString("hex") }, {});
	} catch (error) {
		return err(monitorFailure(`monitor 连不上：${(error as Error).message}`));
	}
	const data = (parse(reply)?.data ?? null) as { enable?: boolean; code?: string; loginId?: string } | null;
	if (data === null) return err(monitorFailure(`monitor 取验证码失败：${reply.text.slice(0, 200)}`));
	const required = data.enable === true;
	const match = /^data:image\/(\w+);base64,(.*)$/s.exec(data.code ?? "");
	return ok({
		required,
		loginId: data.loginId ?? "",
		image: required && match ? Buffer.from(match[2] as string, "base64") : null,
		imageType: match?.[1] ?? "jpeg",
	});
}

/** 第二步：用人输的验证码登录，拿到会话 */
export async function monitorLogin(
	http: HttpPort,
	config: ProdMonitorConfig,
	captcha: MonitorCaptcha,
	code: string,
): Promise<KernelResult<MonitorSession>> {
	const cookies: [string, string][] = [];
	try {
		const pk = await http.post(`${base(config)}/eye/getPublicKey`, { userName: config.username }, {});
		const publicKey = ((parse(pk)?.data ?? {}) as { publicKey?: string }).publicKey;
		if (!publicKey) return err(monitorFailure(`monitor 取公钥失败：${pk.text.slice(0, 200)}`));
		const pem = `-----BEGIN PUBLIC KEY-----\n${publicKey}\n-----END PUBLIC KEY-----`;
		const password = publicEncrypt(
			{ key: pem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha1" },
			Buffer.from(config.password, "utf8"),
		).toString("base64");
		if (captcha.required) cookies.push(["verifyCode", encodeURIComponent(code.trim())]);
		const login = await http.post(
			`${base(config)}/eye/login`,
			{ username: config.username, password, verifycode: code.trim(), key: "", loginId: captcha.loginId },
			cookies.length > 0 ? { Cookie: cookieHeader(cookies) } : {},
		);
		absorbCookies(cookies, login.setCookies);
		const body = parse(login);
		const csrf = login.header("monitor-csrf-token");
		if (body?.code !== 0 || csrf === null)
			return err(
				monitorFailure(
					`monitor 登录没成功：${String(body?.msg ?? login.text.slice(0, 200))}`,
					"验证码输错或过期就重新敲 /cosmic-prod login；账号密码不对就改配置文件里的 monitor 一节。",
				),
			);
		const session: MonitorSession = {
			username: config.username,
			cookies: cookies.filter(([k]) => k !== "verifyCode"),
			csrf,
			loggedInAt: Date.now(),
			keywordBase64: null,
			datasource: "",
		};
		const ds = await http.post(`${base(config)}/eye/queryLogDatasource`, {}, headersOf(session));
		const dsData = (parse(ds)?.data ?? {}) as { default?: string; logKeywordEncryptEnable?: boolean };
		session.keywordBase64 = dsData.logKeywordEncryptEnable === true;
		session.datasource = dsData.default ?? "";
		return ok(session);
	} catch (error) {
		return err(monitorFailure(`monitor 登录时连不上：${(error as Error).message}`));
	}
}

function headersOf(session: MonitorSession): Record<string, string> {
	return {
		Cookie: cookieHeader(session.cookies),
		"monitor-csrf-token": session.csrf,
		"X-Page-Source": "logQuery",
	};
}

/** 按 monitor 页面的表单格式拼查询条件 */
export function queryForm(filter: MonitorFilter, session: MonitorSession, nowMs: number): Record<string, unknown> {
	const to = filter.to ? new Date(filter.to) : new Date(nowMs);
	const from = filter.from ? new Date(filter.from) : new Date(to.getTime() - (filter.minutes ?? 60) * 60_000);
	const keyword = filter.keyword ?? "";
	return {
		appName: filter.appName ?? "",
		appId: "",
		instanceId: "",
		traceId: filter.traceId ?? "",
		className: filter.className ?? "",
		methodName: filter.methodName ?? "",
		opKey: filter.opKey ?? "",
		opMethod: "",
		formId: filter.formId ?? "",
		formName: "",
		userID: "",
		userName: filter.userName ?? "",
		tenantId: "",
		datasource: session.datasource,
		level: (filter.level ?? "").toUpperCase(),
		time: [from.toISOString(), to.toISOString()],
		// 开了「关键字加密」的环境，页面把关键字做一次 UTF-8 base64 再发
		keyword:
			keyword !== "" && session.keywordBase64 === true ? Buffer.from(keyword, "utf8").toString("base64") : keyword,
		slowQuery: false,
		size: Math.min(Math.max(1, filter.size ?? 200), MONITOR_SIZE_CEILING),
		ip: filter.ip ?? "",
	};
}

/**
 * 保活：排障模式开着时隔一段时间问一次「我是谁」。monitor 闲置约半小时登录就过期（真机 2026-11-11：
 * 登录后 34 分钟再查已经过期），而每次过期都要人重输验证码。返回 false 表示已经过期，停止保活。
 */
export async function monitorPing(
	http: HttpPort,
	config: ProdMonitorConfig,
	session: MonitorSession,
): Promise<boolean> {
	try {
		const reply = await http.post(`${base(config)}/eye/user/info`, {}, headersOf(session));
		const body = parse(reply);
		return body !== null && body.code === 0;
	} catch {
		// 网络抖一下不算过期；下一次再问
		return true;
	}
}

export async function monitorQuery(
	http: HttpPort,
	config: ProdMonitorConfig,
	session: MonitorSession | null,
	filter: MonitorFilter,
	nowMs: number,
): Promise<KernelResult<{ rows: MonitorRow[]; form: Record<string, unknown>; ms: number }>> {
	if (session === null) return err(loginRequired("还没登录"));
	const form = queryForm(filter, session, nowMs);
	const started = Date.now();
	let reply: HttpReply;
	try {
		reply = await http.post(`${base(config)}/eye/logQuery/query`, form, headersOf(session));
	} catch {
		// 真机上偶尔一次请求断掉（fetch failed），立刻重发一次基本都能回来；再断才算连不上
		try {
			reply = await http.post(`${base(config)}/eye/logQuery/query`, form, headersOf(session));
		} catch (again) {
			return err(monitorFailure(`monitor 连不上：${(again as Error).message}`));
		}
	}
	const body = parse(reply);
	if (body === null) return err(monitorFailure(`monitor 答复不是 JSON：${reply.text.slice(0, 200)}`));
	if (body.code === LOGIN_EXPIRED) return err(loginRequired("登录已过期"));
	if (body.code !== 0) return err(monitorFailure(`monitor 报错：${String(body.msg ?? body.code)}`));
	const rows = Array.isArray(body.data) ? (body.data as MonitorRow[]) : [];
	return ok({ rows, form, ms: Date.now() - started });
}
