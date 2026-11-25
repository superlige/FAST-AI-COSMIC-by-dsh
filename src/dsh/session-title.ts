/**
 * 会话标题里不出现 `@` 引用块的标签。
 *
 * dsh 给会话起标题分两步：先拿第一句话的开头（前 5 个词、40 字节以内）当占位标题，再请模型起一个正式的
 * 盖掉它。`@` 引用发出去是一整段 `<cosmic-ref …>…</cosmic-ref>`（模型要读里面的元数据位置），第一句话以引用
 * 开头时，占位标题就成了标签开头 `<cosmic-ref id="…`。模型标题没来（第一句话超过起标题的输入上限、
 * 起标题的模型忙或调用失败）时，它就一直留在会话列表里。
 *
 * 这里在 dsh 写下占位标题后，紧接着补写一条同样是占位的标题：引用块换回 `@名字`，其余按 dsh 同一取法。
 * 模型标题照常盖掉它。只看第一句话（占位标题只从它来），补写前占位标题已被新标题盖过就不写。
 * 标签是本产品自己的格式，所以在这一层改，不改 dsh 的标题服务。
 */

import { mentionPlainText } from "../kernel/impact/mention.ts";

/** 和 dsh 组合包里 session-title 的 `fallbackMaxWords`、`fallbackMaxBytes` 一致 */
const FALLBACK_MAX_WORDS = 5;
const FALLBACK_MAX_BYTES = 40;

/** dsh 占位标题的取法：压成一行，取前几个词，按 UTF-8 字节截断（不截断半个字）。 */
export function fallbackTitle(text: string): string {
	const words = text.replace(/\s+/gu, " ").trim().split(" ").filter(Boolean).slice(0, FALLBACK_MAX_WORDS);
	let used = 0;
	let out = "";
	for (const ch of words.join(" ")) {
		const bytes = Buffer.byteLength(ch, "utf8");
		if (used + bytes > FALLBACK_MAX_BYTES) break;
		out += ch;
		used += bytes;
	}
	return out.trimEnd();
}

interface TitleSession {
	readonly id: unknown;
	append(type: string, data: unknown): unknown;
}

interface TitleEvent {
	readonly type: unknown;
	readonly seq?: unknown;
	readonly data?: unknown;
}

interface UserMessageData {
	source?: { kind?: unknown };
	content?: readonly { type?: unknown; text?: unknown }[];
}

interface TitleData {
	title?: unknown;
	messageSeqs?: readonly unknown[];
	source?: { kind?: unknown };
}

interface Watch {
	/** 第一句话：它的 seq 和换掉引用后的文字；不以引用开头或没有引用就是 null */
	first: { seq: number; plain: string } | null;
	/** 最近一条标题事件的 seq */
	lastTitleSeq: number;
}

export class RefTitleFixer {
	private readonly sessions = new Map<string, Watch>();
	private readonly defer: (run: () => void) => void;

	/** `defer`：事件回调里不能再往会话里追加，要等这一轮事件发完 */
	constructor(defer: (run: () => void) => void = (run) => setTimeout(run, 0)) {
		this.defer = defer;
	}

	onEvent(session: TitleSession, event: TitleEvent): void {
		const id = String(session.id);
		const type = String(event.type);
		const seq = typeof event.seq === "number" ? event.seq : -1;
		if (type === "user/message") {
			const data = (event.data ?? {}) as UserMessageData;
			if (data.source?.kind !== "user" || this.sessions.has(id)) return;
			const text = (data.content ?? [])
				.filter((block) => block.type === "text" && typeof block.text === "string")
				.map((block) => block.text as string)
				.join("\n");
			const plain = mentionPlainText(text);
			this.sessions.set(id, { first: plain === null ? null : { seq, plain }, lastTitleSeq: -1 });
			return;
		}
		if (type !== "session/title") return;
		const watch = this.sessions.get(id);
		if (watch === undefined) return;
		watch.lastTitleSeq = seq;
		const data = (event.data ?? {}) as TitleData;
		const first = watch.first;
		if (first === null || data.source?.kind !== "fallback") return;
		if (typeof data.title !== "string" || !data.title.includes("<cosmic-ref")) return;
		if (data.messageSeqs?.[0] !== first.seq) return;
		const title = fallbackTitle(first.plain);
		if (title === "") return;
		this.defer(() => {
			if (this.sessions.get(id) !== watch || watch.lastTitleSeq !== seq) return;
			try {
				session.append("session/title", { title, messageSeqs: [first.seq], source: { kind: "fallback" } });
			} catch {
				// 会话已关、或此刻不收追加：留着 dsh 的占位标题，不影响会话本身
			}
		});
	}

	forget(sessionId: string): void {
		this.sessions.delete(sessionId);
	}
}
