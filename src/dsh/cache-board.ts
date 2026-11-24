/**
 * 「缓存」面板的宿主半边：会话所在工程的索引和磁盘缓存（清单在 `kernel/project/cache-inventory.ts`），
 * 以及面板上的重建、清空、清理操作。给界面用，不发给模型。
 *
 * 动作都不等做完就回：重建要几秒到几分钟，做的时候面板上那一项显示「正在…」和已用时间，
 * 做完留下结果和用时。同一项同时只做一件事，再点就答「正在做」。
 *
 * 清单要读一遍代码关系表、列一遍源文件、量一遍目录，几百毫秒；同一个工程 15 秒内问第二次给上一份，
 * 动作做完马上重算。
 */

import { basename, dirname } from "node:path";
import type { ImpactReport, MetaRefresh } from "../kernel/commands/impact.ts";
import type { KernelContext } from "../kernel/context.ts";
import type { KernelResult } from "../kernel/errors.ts";
import type { FormCatalog } from "../kernel/impact/mention.ts";
import {
	type CacheActionId,
	type CacheGroup,
	cacheInventory,
	clearableDir,
} from "../kernel/project/cache-inventory.ts";
import { sweepCosmicDir, sweepNote } from "../kernel/project/cosmic-dirs.ts";
import { KEEP, reclaimRuntimeCaches } from "../runtime/cache-reclaim.ts";

export const CACHE_BOARD_PATH = "/api/fast-ai-cosmic.cache";

/** 同一个工程多久内问第二次给上一份清单 */
const VIEW_REUSE_MS = 15_000;

export interface CacheBoardDeps<H> {
	project(sessionId: string): { root: string; handle: H } | null;
	ctxOf(handle: H): KernelContext;
	/** 内核的 impact：会先等后台在做的自动重建做完，不和它抢 */
	impact(handle: H, request: { action: "build"; srcOnly?: boolean }): Promise<KernelResult<ImpactReport>>;
	refreshMeta(handle: H): Promise<MetaRefresh>;
	buildForms(handle: H): Promise<KernelResult<FormCatalog>>;
	indexStale(ctx: KernelContext): string | null;
}

export interface CacheJob {
	action: CacheActionId;
	startedAt: number;
	finishedAt: number | null;
	ok: boolean | null;
	text: string;
}

export interface CacheView {
	tracked: boolean;
	project: { root: string; name: string } | null;
	groups: CacheGroup[];
	/** 按清单项 id：正在做的、最近做完的 */
	jobs: Record<string, CacheJob>;
	at: number;
	/** 算这份清单用了多久 */
	ms: number;
}

const ACTIONS: ReadonlySet<string> = new Set<CacheActionId>([
	"rebuild-src",
	"check-meta",
	"rebuild-all",
	"rebuild-forms",
	"clear",
	"sweep",
	"reclaim-runtimes",
]);

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} 秒`;

export class CacheBoard<H> {
	private readonly views = new Map<string, CacheView>();
	private readonly jobs = new Map<string, Map<string, CacheJob>>();

	private readonly deps: CacheBoardDeps<H>;

	constructor(deps: CacheBoardDeps<H>) {
		this.deps = deps;
	}

	private jobsOf(root: string): Map<string, CacheJob> {
		let jobs = this.jobs.get(root);
		if (jobs === undefined) {
			jobs = new Map();
			this.jobs.set(root, jobs);
		}
		return jobs;
	}

	view(sessionId: string, fresh = false): CacheView {
		const project = this.deps.project(sessionId);
		const now = Date.now();
		if (project === null) return { tracked: false, project: null, groups: [], jobs: {}, at: now, ms: 0 };
		const jobs = Object.fromEntries(this.jobsOf(project.root));
		const known = this.views.get(project.root);
		if (!fresh && known !== undefined && now - known.at < VIEW_REUSE_MS) return { ...known, jobs };
		const ctx = this.deps.ctxOf(project.handle);
		let indexStale: string | null;
		try {
			indexStale = this.deps.indexStale(ctx);
		} catch (error) {
			indexStale = `读不了：${error instanceof Error ? error.message : String(error)}`;
		}
		const groups = cacheInventory({ ctx, indexStale, now });
		const view: CacheView = {
			tracked: true,
			project: { root: project.root, name: basename(project.root) },
			groups,
			jobs,
			at: now,
			ms: Date.now() - now,
		};
		this.views.set(project.root, view);
		return view;
	}

	/** 人在面板上点了一个动作：开始做就回，做完的结果在下一次 `view` 里。 */
	act(sessionId: string, itemId: string, action: string): { ok: boolean; text: string } {
		const project = this.deps.project(sessionId);
		if (project === null) return { ok: false, text: "未识别到本会话的苍穹工程" };
		if (!ACTIONS.has(action)) return { ok: false, text: `不支持的操作：${action}` };
		const item = this.view(sessionId)
			.groups.flatMap((g) => g.items)
			.find((it) => it.id === itemId);
		if (item === undefined) return { ok: false, text: `清单中没有此项：${itemId}` };
		if (!item.actions.some((a) => a.id === action)) return { ok: false, text: `${item.name}不支持此操作` };
		const jobs = this.jobsOf(project.root);
		const running = jobs.get(itemId);
		if (running !== undefined && running.finishedAt === null)
			return { ok: false, text: `${item.name}正在执行，请等待完成` };
		const job: CacheJob = {
			action: action as CacheActionId,
			startedAt: Date.now(),
			finishedAt: null,
			ok: null,
			text: "",
		};
		jobs.set(itemId, job);
		void this.run(project.handle, itemId, job.action)
			.then(
				(text) => Object.assign(job, { ok: true, text }),
				(error: unknown) =>
					Object.assign(job, { ok: false, text: error instanceof Error ? error.message : String(error) }),
			)
			.finally(() => {
				job.finishedAt = Date.now();
				this.views.delete(project.root);
			});
		return { ok: true, text: `已开始：${item.actions.find((a) => a.id === action)?.label ?? action}` };
	}

	/** 做一个动作，回一句结果；没做成就抛错，错误说明就是那句话。 */
	private async run(handle: H, itemId: string, action: CacheActionId): Promise<string> {
		const ctx = this.deps.ctxOf(handle);
		const started = Date.now();
		const took = () => seconds(Date.now() - started);
		switch (action) {
			case "rebuild-src":
			case "rebuild-all": {
				const built = await this.deps.impact(handle, {
					action: "build",
					...(action === "rebuild-src" ? { srcOnly: true } : {}),
				});
				if (!built.ok) throw new Error(`${built.error.code}：${built.error.message}`);
				return `重建完成，用时 ${took()}`;
			}
			case "check-meta": {
				const refresh = await this.deps.refreshMeta(handle);
				if (refresh.state === "failed" || refresh.state === "skipped") throw new Error(refresh.text);
				return `${refresh.text}（${took()}）`;
			}
			case "rebuild-forms": {
				const built = await this.deps.buildForms(handle);
				if (!built.ok) throw new Error(`${built.error.code}：${built.error.message}`);
				return `重建完成，共 ${built.value.forms.length} 份表单，用时 ${took()}`;
			}
			case "clear": {
				const dir = clearableDir(ctx, itemId);
				if (dir === null) throw new Error(`${itemId} 不支持清空`);
				ctx.ports.fs.remove(dir);
				return "已清空";
			}
			case "sweep": {
				const note = sweepNote(sweepCosmicDir(ctx.layout, ctx.ports.fs, Date.now(), { force: true }));
				return note ?? "清理完成，没有到期的文件";
			}
			case "reclaim-runtimes": {
				const reclaimed = await reclaimRuntimeCaches({
					cacheRoot: dirname(ctx.layout.agentCache),
					currentKeyId: ctx.runtimeKeyId,
					fs: ctx.ports.fs,
					proc: ctx.ports.proc,
					now: Date.now(),
					force: true,
				});
				return reclaimed.removed.length === 0
					? `清理完成，没有需要删除的目录（保留最近使用的 ${KEEP} 个，仍有 JVM 运行的不删除）`
					: `清理完成，删除 ${reclaimed.removed.length} 个旧运行时目录`;
			}
		}
	}
}

const json = (value: unknown, status = 200): Response =>
	new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8" } });

/** GET `?session=…[&fresh=1]` 回清单；POST `{session, item, action}` 开始一个动作，回结果和新清单。 */
export async function handleCacheBoard<H>(board: CacheBoard<H>, request: Request): Promise<Response> {
	if (request.method === "GET" || request.method === "HEAD") {
		const query = new URL(request.url).searchParams;
		const session = query.get("session");
		if (session === null || session === "") return json({ error: "缺少 session" }, 400);
		return json(board.view(session, query.get("fresh") === "1"));
	}
	let body: { session?: unknown; item?: unknown; action?: unknown };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return json({ error: "请求体须为 JSON" }, 400);
	}
	if (typeof body.session !== "string" || body.session === "") return json({ error: "缺少 session" }, 400);
	if (typeof body.item !== "string" || typeof body.action !== "string")
		return json({ error: "缺少 item 或 action" }, 400);
	const result = board.act(body.session, body.item, body.action);
	return json({ result, view: board.view(body.session) }, result.ok ? 200 : 409);
}
