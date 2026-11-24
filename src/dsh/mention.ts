/**
 * 输入框 `@` 引用的宿主半边：界面每敲一个字问一次候选，选中的引用在发送时换成一段
 * 「它在元数据里的准确位置」交给模型。目录怎么拼、怎么找、写什么在 `kernel/impact/mention.ts`，
 * 文件和探针在 `kernel/commands/mention.ts`；这里只管按会话找工程、缓存目录、按需补数据。
 *
 * 按需补的两样都只搭已经在跑的常驻 JVM（`kernel/commands/mention.ts` 文件头）：
 *   - 表单目录没有或旧了：后台建，这一次先用旧的（或没有）；
 *   - 往一张单里钻（`单据.`），或引用一张单上的东西，而这张单没现查过运行态：现查一次再答，最多等 `FETCH_WAIT_MS`。
 * JVM 没起时照样答，只是少了这两样，候选的说明里不编。
 */

import {
	buildFormCatalog,
	ENTITY_SHAPE,
	fetchRuntimeFields,
	formCatalogStale,
	type MentionProbe,
	mentionStamp,
	readMentionSources,
	runtimeFieldsStale,
} from "../kernel/commands/mention.ts";
import type { ProbeOptions, ProbeOutcome } from "../kernel/commands/probe.ts";
import type { KernelContext } from "../kernel/context.ts";
import type { KernelResult } from "../kernel/errors.ts";
import {
	buildMentionCatalog,
	describeMention,
	type MentionCatalog,
	type MentionItem,
	mentionBlock,
	mentionHint,
	mentionLabel,
	mentionSection,
	parseMentionQuery,
	searchMentions,
} from "../kernel/impact/mention.ts";

export const MENTION_PATH = "/api/fast-ai-cosmic.mention";

/** 现查一张单的运行态字段最多等多久；常驻 JVM 里一张单通常一两秒。 */
export const FETCH_WAIT_MS = 8000;

export interface MentionDeps<H> {
	project(sessionId: string): { root: string; handle: H } | null;
	ctxOf(handle: H): KernelContext;
	probe(handle: H, name: string, options: ProbeOptions): Promise<KernelResult<ProbeOutcome>>;
}

/** 菜单里的一行。 */
export interface MentionCandidate {
	id: string;
	kind: MentionItem["kind"];
	label: string;
	name: string;
	hint: string;
	section: string;
	/** 单据、表单能往里钻（列它的分录和字段） */
	drill: boolean;
}

export interface MentionAnswer {
	items: MentionCandidate[];
	/** 目录缺了什么，给人看的一句；全齐时不带 */
	note?: string;
}

interface Cached {
	stamp: string;
	catalog: MentionCatalog;
}

const wait = <T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> =>
	Promise.race([promise, new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), ms).unref?.())]);

export class MentionService<H> {
	private readonly deps: MentionDeps<H>;
	private readonly cache = new Map<string, Cached>();
	private readonly building = new Set<string>();
	private readonly fetching = new Map<string, Promise<boolean>>();

	constructor(deps: MentionDeps<H>) {
		this.deps = deps;
	}

	private runner(handle: H): MentionProbe {
		return ((_ctx: KernelContext, name: string, options?: ProbeOptions) =>
			this.deps.probe(handle, name, options ?? {})) as MentionProbe;
	}

	private catalogOf(root: string, ctx: KernelContext): MentionCatalog {
		const stamp = mentionStamp(ctx);
		const known = this.cache.get(root);
		if (known?.stamp === stamp) return known.catalog;
		const sources = readMentionSources(ctx);
		const catalog = buildMentionCatalog(sources);
		this.cache.set(root, { stamp: sources.stamp, catalog });
		return catalog;
	}

	/** 表单目录没有或旧了就在后台建；同一工程同时只建一份。 */
	private refreshForms(root: string, handle: H, ctx: KernelContext): void {
		if (this.building.has(root) || !formCatalogStale(ctx)) return;
		this.building.add(root);
		void buildFormCatalog(ctx, this.runner(handle))
			.catch(() => null)
			.finally(() => this.building.delete(root));
	}

	/** 现查一张单的运行态字段；同一张单并发只查一次。查成了回 true。 */
	private async fetchEntity(root: string, handle: H, ctx: KernelContext, entity: string): Promise<boolean> {
		if (!ENTITY_SHAPE.test(entity) || !runtimeFieldsStale(ctx, entity)) return false;
		const key = `${root}|${entity}`;
		let running = this.fetching.get(key);
		if (running === undefined) {
			running = fetchRuntimeFields(ctx, entity, this.runner(handle))
				.then((r) => r.ok)
				.catch(() => false)
				.finally(() => this.fetching.delete(key));
			this.fetching.set(key, running);
		}
		const got = await wait(running, FETCH_WAIT_MS);
		return got === true;
	}

	async candidates(sessionId: string, query: string): Promise<MentionAnswer> {
		const project = this.deps.project(sessionId);
		if (project === null) return { items: [], note: "还没认出这个会话的苍穹工程" };
		const ctx = this.deps.ctxOf(project.handle);
		this.refreshForms(project.root, project.handle, ctx);
		let catalog = this.catalogOf(project.root, ctx);
		const parsed = parseMentionQuery(catalog, query);
		if (parsed.scope !== undefined && (await this.fetchEntity(project.root, project.handle, ctx, parsed.scope))) {
			catalog = this.catalogOf(project.root, ctx);
		}
		const items = searchMentions(catalog, query).map((item) => ({
			id: item.id,
			kind: item.kind,
			label: mentionLabel(item, catalog),
			name: item.name,
			hint: mentionHint(item, catalog),
			section: mentionSection(item),
			drill: item.kind === "bill" || item.kind === "form" || item.kind === "entry",
		}));
		const gaps: string[] = [];
		if (catalog.forms === 0) gaps.push("表单目录还没建（常驻 JVM 起来后自动建）");
		if (catalog.index === null) gaps.push("代码关系表还没建，字段只能往单据里钻着找");
		return gaps.length === 0 ? { items } : { items, note: gaps.join("；") };
	}

	/** 选中的引用换成发给模型的那段。单据上的东西先补一次运行态，拿到类型和继承来的字段。 */
	async resolve(sessionId: string, id: string): Promise<{ text: string } | { error: string }> {
		const project = this.deps.project(sessionId);
		if (project === null) return { error: "还没认出这个会话的苍穹工程" };
		const ctx = this.deps.ctxOf(project.handle);
		let catalog = this.catalogOf(project.root, ctx);
		const entity = catalog.byId.get(id)?.entity ?? id.split(".")[0] ?? "";
		if (await this.fetchEntity(project.root, project.handle, ctx, entity))
			catalog = this.catalogOf(project.root, ctx);
		const item = catalog.byId.get(id);
		const body = describeMention(catalog, id);
		if (item === undefined || body === null) return { error: `目录里没有 ${id}` };
		return { text: mentionBlock(mentionLabel(item, catalog), id, body) };
	}
}

const json = (value: unknown, status = 200): Response =>
	Response.json(value, { status, headers: { "cache-control": "no-store" } });

/**
 *   GET  `?session=<会话>&q=<敲的字>`  候选；
 *   POST `{ session, id }`              选中那一项发给模型的文字。
 */
export async function handleMention<H>(service: MentionService<H>, request: Request): Promise<Response> {
	if (request.method === "GET" || request.method === "HEAD") {
		const query = new URL(request.url).searchParams;
		const session = query.get("session");
		if (session === null || session === "") return json({ error: "要带 session" }, 400);
		return json(await service.candidates(session, query.get("q") ?? ""));
	}
	let body: { session?: unknown; id?: unknown };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return json({ error: "请求体要是 JSON" }, 400);
	}
	if (typeof body.session !== "string" || body.session === "") return json({ error: "要带 session" }, 400);
	if (typeof body.id !== "string" || body.id === "") return json({ error: "要带 id" }, 400);
	const got = await service.resolve(body.session, body.id);
	return json(got, "error" in got ? 404 : 200);
}
