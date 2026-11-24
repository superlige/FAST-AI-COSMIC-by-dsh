/**
 * 品牌行的宿主半边。画界面的事全在浏览器端的 `client/brand.js`，
 * dsh 按 package.json 的 `dsh.client` 和 `exports["./client"]` 把它送进界面。
 *
 * 这一行挂在顶层（不在两个预设里），整个宿主一份，所以界面要调的请求路径挂在这里：
 * 设置 → 模型页「登录 ChatGPT」按钮（`codex-login.ts`）、输入框左边的苍穹 JVM 小标签（`jvm-board.ts`）、
 * 输入框里 `@` 引用单据和字段（`mention.ts`）。
 * 连接层只在桌面和网页里有；无界面配置没有它，路径就不注册。
 */

import type { Context } from "@deepseek-ai/cordis";
import type { AuthorizationService } from "@deepseek-ai/dsh-authorization";
import { openWithSystemViewer } from "../agent/tools/open-viewer.ts";
import { CACHE_BOARD_PATH, handleCacheBoard } from "./cache-board.ts";
import {
	CODEX_LOGIN_PATH,
	type CodexCredentials,
	CodexLogin,
	type ConnectionFetch,
	handleCodexLogin,
} from "./codex-login.ts";
import { handleJvmBoard, JVM_BOARD_PATH } from "./jvm-board.ts";
import { cosmicCacheBoard, cosmicJvmBoard, cosmicMentions } from "./kernel.ts";
import { handleMention, MENTION_PATH } from "./mention.ts";

export const name = "fast-ai-cosmic-brand";

/** 本插件用到的三个服务；连接层、凭据的类型包本仓库不引（会拖进一大片 dsh 类型），按用到的形状写。 */
interface LoginServices {
	connection: { fetch: ConnectionFetch };
	authorization: AuthorizationService;
	credentials: CodexCredentials;
}

export function apply(ctx: Context): void {
	const services = ctx as unknown as Context & {
		inject(names: string[], apply: (sub: Context & LoginServices) => void): void;
	};
	services.inject(["connection", "authorization", "credentials"], (sub) => {
		const login = new CodexLogin(
			() => sub.authorization,
			() => sub.credentials,
			(url) => openWithSystemViewer(url),
		);
		sub.effect(() =>
			sub.connection.fetch.register({
				path: CODEX_LOGIN_PATH,
				methods: ["GET", "POST"],
				requestBody: "buffered",
				fetch: (request) => handleCodexLogin(login, request),
			}),
		);
		sub.effect(() => () => login.cancel());
	});
	services.inject(["connection"], (sub) => {
		sub.effect(() =>
			sub.connection.fetch.register({
				path: JVM_BOARD_PATH,
				methods: ["GET", "POST"],
				requestBody: "buffered",
				fetch: (request) => handleJvmBoard(cosmicJvmBoard(), request),
			}),
		);
		sub.effect(() =>
			sub.connection.fetch.register({
				path: MENTION_PATH,
				methods: ["GET", "POST"],
				requestBody: "buffered",
				fetch: (request) => handleMention(cosmicMentions(), request),
			}),
		);
		sub.effect(() =>
			sub.connection.fetch.register({
				path: CACHE_BOARD_PATH,
				methods: ["GET", "POST"],
				requestBody: "buffered",
				fetch: (request) => handleCacheBoard(cosmicCacheBoard(), request),
			}),
		);
	});
}
