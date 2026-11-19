/**
 * 设置 → 模型页上「登录 ChatGPT」按钮的宿主半边。
 *
 * dsh 的界面只会登 DeepSeek 账号、填 API 密钥，codex 要用 ChatGPT 账号登（OAuth），界面上原本没有入口，
 * 只能在会话里敲 `/cosmic-login`；新装的 exe 用户不知道这条命令，就停在「请选择模型」。
 * 这里在 dsh 连接层的 `/api` 下注册一条请求路径，界面那半边（`client/brand.js`）在 codex 那张卡片上画按钮、
 * 调这条路径；登录本身走 dsh 的授权服务，和 `/cosmic-login` 是同一条 flow、写同一份凭据。
 *
 * 为什么是请求路径而不是 dsh 的 Remote：Remote 的调用描述要在 dsh 根构建时生成，仓库外的组合包进不去；
 * 连接层的请求路径网页和桌面都通（桌面经 IPC 转发同一个处理函数），而且只有通过了浏览器登录校验的
 * 本机所有者能走到这里，Host/Origin 校验也由连接层做。
 *
 * 一次登录：发起 → 浏览器打开 ChatGPT 登录页（宿主用系统浏览器打开，界面也给出地址）→ 登完浏览器回调本机，
 * flow 自己收尾；回调没回来时 flow 会问「粘贴浏览器地址栏的地址」，界面把输入框给人，填了交回这里。
 */

import type { AuthorizationPrompt, AuthorizationService } from "@deepseek-ai/dsh-authorization";

/** 凭据键在运行时就是这串字符（本仓库只 import dsh 的类型，造不出带品牌的值，按类型转一下）。 */
export const CODEX_AUTH_KEY = "llm-pi-ai/openai-codex" as unknown as Parameters<
	AuthorizationService["begin"]
>[0]["key"];

/** 界面调的路径：dsh 连接层要求 `/api` 下的绝对路径；界面用去掉开头斜杠的相对形式。 */
export const CODEX_LOGIN_PATH = "/api/fast-ai-cosmic.codex-login";

/** 用到的那一点凭据服务（dsh-credentials 的 CredentialProvider 的子集）。 */
export interface CodexCredentials {
	describeRecord(key: unknown): Promise<{ configured: boolean }>;
	deleteRecord(key: unknown): Promise<void>;
}

/** 用到的那一点连接层（dsh-client-connection 的 HostConnectionFetch）。 */
export interface ConnectionFetch {
	register(route: {
		path: string;
		methods: readonly ("GET" | "HEAD" | "POST")[];
		requestBody: "buffered" | "streaming";
		fetch: (request: Request) => Promise<Response>;
	}): () => Promise<void>;
}

export type LoginPhase = "idle" | "waiting" | "succeeded" | "failed" | "cancelled";

/** 界面看到的状态；不含任何凭据内容。 */
export interface LoginView {
	signedIn: boolean;
	phase: LoginPhase;
	/** 登录页地址：宿主已经用系统浏览器打开，界面再给一个能点的链接。 */
	url?: string;
	/** 设备码一类要人照着输的短码。 */
	code?: string;
	/** flow 最近说的一句话。 */
	message?: string;
	/** flow 在等人回答的问题（一般是「粘贴浏览器地址栏的地址」）。 */
	question?: { message: string; placeholder?: string; secret: boolean };
	error?: string;
}

interface Pending {
	resolve(answer: string): void;
	reject(error: Error): void;
}

export class CodexLogin {
	private phase: LoginPhase = "idle";
	private url: string | undefined;
	private code: string | undefined;
	private message: string | undefined;
	private error: string | undefined;
	private question: LoginView["question"];
	private pending: Pending | undefined;
	private controller: AbortController | undefined;

	private readonly authorization: () => AuthorizationService | undefined;
	private readonly credentials: () => CodexCredentials | undefined;
	private readonly open: (url: string) => void;

	constructor(
		authorization: () => AuthorizationService | undefined,
		credentials: () => CodexCredentials | undefined,
		open: (url: string) => void,
	) {
		this.authorization = authorization;
		this.credentials = credentials;
		this.open = open;
	}

	async view(): Promise<LoginView> {
		let signedIn = false;
		try {
			signedIn = (await this.credentials()?.describeRecord(CODEX_AUTH_KEY))?.configured === true;
		} catch {
			signedIn = false;
		}
		return {
			signedIn,
			phase: this.phase,
			...(this.url === undefined ? {} : { url: this.url }),
			...(this.code === undefined ? {} : { code: this.code }),
			...(this.message === undefined ? {} : { message: this.message }),
			...(this.question === undefined ? {} : { question: this.question }),
			...(this.error === undefined ? {} : { error: this.error }),
		};
	}

	/** 发起一次登录；已经在登就不重发。不等登录完成就返回。 */
	start(): void {
		if (this.phase === "waiting") return;
		const authorization = this.authorization();
		if (authorization === undefined) {
			this.phase = "failed";
			this.error = "这个宿主没有装授权服务，登录不了";
			return;
		}
		const controller = new AbortController();
		this.controller = controller;
		this.phase = "waiting";
		this.url = undefined;
		this.code = undefined;
		this.message = undefined;
		this.error = undefined;
		this.question = undefined;
		const settle = (phase: LoginPhase, error?: string): void => {
			if (this.controller !== controller) return;
			this.phase = phase;
			this.error = error;
			this.question = undefined;
			this.pending = undefined;
			this.controller = undefined;
		};
		void authorization
			.begin({
				key: CODEX_AUTH_KEY,
				method: "oauth",
				signal: controller.signal,
				interaction: {
					notify: (notice) => {
						this.message = notice.message;
						if (notice.code !== undefined) this.code = notice.code;
						if (notice.url !== undefined && notice.url !== this.url) {
							this.url = notice.url;
							this.open(notice.url);
						}
					},
					prompt: (prompt) => this.ask(prompt),
				},
			})
			.then(
				(outcome) => settle(outcome.status === "authorized" ? "succeeded" : "cancelled"),
				(error: unknown) => settle("failed", error instanceof Error ? error.message : String(error)),
			);
	}

	/** flow 问一句：挂起，等界面交回答案；flow 撤回这一问（浏览器回调先到）时清掉。 */
	private ask(prompt: AuthorizationPrompt): Promise<string> {
		if (prompt.kind === "select") {
			// codex 的登录不会问选择题；问了就是 flow 变了，照实报错，不替人选
			return Promise.reject(new Error(`登录要选「${prompt.message}」，设置页答不了，请在会话里用 /cosmic-login`));
		}
		return new Promise<string>((resolve, reject) => {
			const clear = (): void => {
				if (this.pending === entry) {
					this.pending = undefined;
					this.question = undefined;
				}
			};
			const entry: Pending = {
				resolve: (answer) => {
					clear();
					resolve(answer);
				},
				reject: (error) => {
					clear();
					reject(error);
				},
			};
			this.pending = entry;
			this.question = {
				message: prompt.message,
				...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }),
				secret: prompt.kind === "secret",
			};
			prompt.signal?.addEventListener("abort", () => entry.reject(new Error("这一问已撤回")), { once: true });
		});
	}

	/** 交回界面里填的答案；没有在等的问题返回 false。 */
	answer(text: string): boolean {
		const pending = this.pending;
		if (pending === undefined || text.trim() === "") return false;
		pending.resolve(text.trim());
		return true;
	}

	cancel(): void {
		const authorization = this.authorization();
		this.controller?.abort();
		try {
			authorization?.cancel(CODEX_AUTH_KEY);
		} catch {
			// 没有在跑的登录
		}
	}

	/** 删掉存着的 ChatGPT 登录凭据。 */
	async signOut(): Promise<void> {
		this.cancel();
		await this.credentials()?.deleteRecord(CODEX_AUTH_KEY);
		this.phase = "idle";
		this.url = undefined;
		this.code = undefined;
		this.message = undefined;
		this.error = undefined;
	}
}

const json = (value: unknown, status = 200): Response =>
	Response.json(value, { status, headers: { "cache-control": "no-store" } });

/** 一条路径两种方法：GET 看状态，POST `{ action }` 发起、答问、取消、退出登录。 */
export async function handleCodexLogin(login: CodexLogin, request: Request): Promise<Response> {
	if (request.method === "GET" || request.method === "HEAD") return json(await login.view());
	let body: { action?: unknown; text?: unknown };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return json({ error: "请求体要是 JSON" }, 400);
	}
	switch (body.action) {
		case "start":
			login.start();
			break;
		case "answer":
			if (typeof body.text !== "string" || !login.answer(body.text))
				return json({ ...(await login.view()), error: "现在没有在等回答的问题，或者没填内容" }, 409);
			break;
		case "cancel":
			login.cancel();
			break;
		case "sign-out":
			await login.signOut();
			break;
		default:
			return json({ error: "action 只认 start、answer、cancel、sign-out" }, 400);
	}
	return json(await login.view());
}
