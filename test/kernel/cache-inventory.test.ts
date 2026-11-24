/**
 * 「缓存」面板的清单：每样缓存新不新、下次自动什么时候，照着各自的规则算；
 * 「清空」只认清单里允许清空的那几样。
 */
import { describe, expect, it } from "vitest";
import { FORM_CATALOG_TTL_MS, formsFile, runtimeDir } from "../../src/kernel/commands/mention.ts";
import { markMetaPending, metaCheckFile } from "../../src/kernel/impact/meta-state.ts";
import { type CacheItem, cacheInventory, clearableDir } from "../../src/kernel/project/cache-inventory.ts";
import { SWEEP_INTERVAL_MS } from "../../src/kernel/project/cosmic-dirs.ts";
import { RECLAIM_INTERVAL_MS } from "../../src/runtime/cache-reclaim.ts";
import { makeContext } from "./fake-context.ts";

const NOW = Date.parse("2026-11-24T08:00:00.000Z");

function itemOf(groups: ReturnType<typeof cacheInventory>, id: string): CacheItem {
	const item = groups.flatMap((g) => g.items).find((it) => it.id === id);
	if (item === undefined) throw new Error(`清单里没有 ${id}`);
	return item;
}

describe("清单", () => {
	it("什么都还没建：代码关系表、表单目录、记账都报「还没」，0 也报", () => {
		const { ctx } = makeContext();
		const groups = cacheInventory({ ctx, indexStale: "还没有代码关系表", now: NOW });
		expect(groups.map((g) => g.name)).toEqual(["索引", "磁盘缓存"]);
		// 运行中记的账、探针环境、知识库快照、内存缓存由程序自己维护，不列
		const ids = groups.flatMap((g) => g.items.map((it) => it.id));
		expect(ids).toEqual([
			"impact-src",
			"impact-meta",
			"mention-forms",
			"mention-runtime",
			"sessions",
			"drafts",
			"runtime-old",
		]);
		expect(itemOf(groups, "impact-src").state).toBe("missing");
		expect(itemOf(groups, "impact-meta").state).toBe("missing");
		expect(itemOf(groups, "mention-forms").state).toBe("missing");
	});

	it("代码关系表落后：说原因，下次自动是「下一次调工具时」，不编时刻", () => {
		const { ctx, fs } = makeContext();
		fs.put(ctx.layout.impactIndex, "{}");
		const src = itemOf(cacheInventory({ ctx, indexStale: "3 个源文件在建表之后改过", now: NOW }), "impact-src");
		expect(src).toMatchObject({ state: "stale", stateText: "已落后：3 个源文件在建表之后改过", nextAt: null });
		expect(src.nextText).toBe("下一次工具调用");
	});

	it("本机写过元数据：元数据部分落后，下一次用到常驻 JVM 时补扫", () => {
		const { ctx, fs } = makeContext();
		fs.put(`${ctx.layout.impactWork}/meta-index.json`, "{}");
		markMetaPending(ctx, "FormLayoutWriteProbe", ["demo_bill"]);
		const meta = itemOf(cacheInventory({ ctx, indexStale: null, now: NOW }), "impact-meta");
		expect(meta.state).toBe("stale");
		expect(meta.stateText).toContain("本机已写入元数据 1 次，尚未增量更新");
		expect(meta.nextText).toBe("下一次使用常驻 JVM 时增量更新");
	});

	it("变更检查结果用书面说法，不照搬检查写给模型的短句", () => {
		const { ctx, fs } = makeContext();
		fs.put(`${ctx.layout.impactWork}/meta-index.json`, "{}");
		const check = (state: string, changed: number) =>
			fs.put(
				metaCheckFile(ctx),
				JSON.stringify({ at: new Date(NOW).toISOString(), state, changed, text: "补了 开放平台接口 1", ms: 1 }),
			);
		const stateText = () => itemOf(cacheInventory({ ctx, indexStale: null, now: NOW }), "impact-meta").stateText;
		check("patched", 1);
		expect(stateText()).toMatch(/：发现 1 处变更，已增量更新$/);
		expect(stateText()).not.toContain("补了");
		check("same", 0);
		expect(stateText()).toMatch(/：无变更$/);
		check("over", 130);
		expect(stateText()).toContain("超过单次增量更新上限，需完整重建");
	});

	it("表单目录：下次自动 = 建好的时刻 + 6 小时，过了就是落后", () => {
		const { ctx, fs } = makeContext();
		const built = NOW - 60 * 60 * 1000;
		fs.put(formsFile(ctx), "{}", built);
		const fresh = itemOf(cacheInventory({ ctx, indexStale: null, now: NOW }), "mention-forms");
		expect(fresh).toMatchObject({ state: "fresh", nextAt: built + FORM_CATALOG_TTL_MS });
		const later = itemOf(
			cacheInventory({ ctx, indexStale: null, now: built + FORM_CATALOG_TTL_MS + 1 }),
			"mention-forms",
		);
		expect(later.state).toBe("stale");
	});

	it("清理和旧运行时目录：下次 = 上次清理 + 间隔；只数带 runtime-key.json 的目录", () => {
		const { ctx, fs } = makeContext();
		const swept = NOW - 10 * 60 * 1000;
		fs.put(`${ctx.layout.workDir}/sweep.json`, JSON.stringify({ at: new Date(swept).toISOString() }));
		fs.put(`${ctx.layout.cosmicDir}/sessions/s1/journal.json`, "{}");
		fs.put("D:/cache/v0-old1/runtime-key.json", "{}");
		fs.put("D:/cache/v0-old2/runtime-key.json", "{}");
		fs.put("D:/cache/somebody/notes.txt", "人放的");
		fs.put("D:/cache/reclaim-stamp.json", JSON.stringify({ at: NOW - 60 * 60 * 1000 }));
		const groups = cacheInventory({ ctx, indexStale: null, now: NOW });
		expect(itemOf(groups, "sessions")).toMatchObject({ nextAt: swept + SWEEP_INTERVAL_MS, stateText: "共 1 个会话" });
		expect(itemOf(groups, "runtime-old")).toMatchObject({
			stateText: "共 2 个",
			nextAt: NOW - 60 * 60 * 1000 + RECLAIM_INTERVAL_MS,
		});
	});

	it("「清空」只认运行态字段，别的一律不认", () => {
		const { ctx } = makeContext();
		expect(clearableDir(ctx, "mention-runtime")).toBe(runtimeDir(ctx));
		expect(clearableDir(ctx, "impact-src")).toBeNull();
		expect(clearableDir(ctx, "../../evidence")).toBeNull();
	});
});
