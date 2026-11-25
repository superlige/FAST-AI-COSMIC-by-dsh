/**
 * 输入框 `@` 引用的宿主半边：按会话找工程、读目录文件、往一张单里钻时现查一次运行态、
 * JVM 不在时照样答、请求路径。内核上下文和探针都是假的。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { handleMention, MENTION_PATH, MentionService } from "../../src/dsh/mention.ts";
import { formsFile, runtimeDir } from "../../src/kernel/commands/mention.ts";
import type { ProbeOptions } from "../../src/kernel/commands/probe.ts";
import { err, KernelError, ok } from "../../src/kernel/errors.ts";
import { MENTION_TAG } from "../../src/kernel/impact/mention.ts";
import { makeContext } from "../kernel/fake-context.ts";

const FORMS = [
	{ n: "demo_bill", m: "BillFormModel", i: "demox", name: "演示单" },
	{ n: "demo_pick", m: "DynamicFormModel", i: "demox", name: "选料弹窗" },
];

function setup(options: { jvm?: boolean; formsOnDisk?: boolean } = {}) {
	const fake = makeContext();
	const { ctx, fs } = fake;
	if (options.formsOnDisk !== false) {
		fs.put(
			formsFile(ctx),
			JSON.stringify({ kind: "FormCatalog", at: "2026-01-01T00:00:00.000Z", ms: 1, forms: FORMS }),
		);
	}
	fs.put(
		ctx.layout.impactIndex,
		JSON.stringify({
			kind: "ImpactIndex",
			at: "2026-01-01T00:00:00.000Z",
			meta: { at: "2026-01-01T00:00:00.000Z" },
			fields: [{ entity: "demo_bill", key: "demox_qty", level: "header", name: "数量" }],
			fieldOwners: {},
			templates: [],
			classes: [],
			entityRefs: [],
			fieldRefs: [],
		}),
	);
	const calls: { name: string; options: ProbeOptions }[] = [];
	const handle = { ctx };
	const service = new MentionService<typeof handle>({
		project: (sessionId) => (sessionId === "s1" ? { root: ctx.projectRoot, handle } : null),
		ctxOf: (h) => h.ctx,
		async probe(_h, name, probeOptions) {
			calls.push({ name, options: probeOptions });
			if (options.jvm === false) return err(new KernelError("PROBE_RESIDENT_UNAVAILABLE", "常驻 JVM 没在跑"));
			const records =
				name === "MetaProbe"
					? [
							{ t: "entity", key: "demo_bill", name: "演示单" },
							{ t: "field", key: "billno", name: "单据编号", type: "TextProp", level: "header" },
							{ t: "field", key: "demox_qty", name: "数量", type: "DecimalProp", level: "header" },
						]
					: [{ t: "form-summary", forms: 0 }];
			return ok({ json: { records, broken: [], file: "" }, exitCode: 0 } as never);
		},
	});
	return { ...fake, service, calls };
}

describe("候选", () => {
	it("没认出工程：不报错，说一句为什么是空的", async () => {
		const { service } = setup();
		expect(await service.candidates("other", "演示")).toEqual({ items: [], note: "尚未识别当前会话的苍穹工程" });
	});

	it("分录能往里钻", async () => {
		const { service, fs, ctx } = setup();
		fs.put(
			ctx.layout.impactIndex,
			JSON.stringify({
				kind: "ImpactIndex",
				at: "2026-01-01T00:00:00.000Z",
				meta: { at: "2026-01-01T00:00:00.000Z" },
				fields: [
					{
						entity: "demo_bill",
						key: "demox_entry",
						level: "entry",
						entry: "demox_entry",
						kind: "container",
						name: "明细",
					},
					{ entity: "demo_bill", key: "demox_qty", level: "entry", entry: "demox_entry", name: "数量" },
				],
				fieldOwners: {},
				templates: [],
				classes: [],
				entityRefs: [],
				fieldRefs: [],
			}),
		);
		const entry = (await service.candidates("s1", "明细")).items.find((it) => it.kind === "entry");
		expect([entry?.id, entry?.drill]).toEqual(["demo_bill.demox_entry", true]);
	});

	it("按中文名找到单据和字段；单据能往里钻，字段不能", async () => {
		const { service } = setup();
		expect((await service.candidates("s1", "演示")).items.map((it) => [it.id, it.section, it.drill])).toEqual([
			["demo_bill", "单据", true],
		]);
		const field = (await service.candidates("s1", "数量")).items[0];
		expect([field?.id, field?.label, field?.section, field?.drill]).toEqual([
			"demo_bill.demox_qty",
			"演示单.数量",
			"字段",
			false,
		]);
	});

	it("往一张单里钻：只搭常驻 JVM 现查一次运行态，继承来的字段跟着出来，第二次用缓存", async () => {
		const { service, calls, fs, ctx } = setup();
		const first = await service.candidates("s1", "demo_bill.");
		expect(first.items.map((it) => it.id)).toContain("demo_bill.billno");
		const metaCalls = calls.filter((c) => c.name === "MetaProbe");
		expect(metaCalls).toHaveLength(1);
		expect(metaCalls[0]?.options).toMatchObject({
			env: { META_ENTITY: "demo_bill" },
			coldFallback: false,
			startResident: false,
			countRepeats: false,
		});
		expect(fs.exists(`${runtimeDir(ctx)}/demo_bill.json`)).toBe(true);
		await service.candidates("s1", "demo_bill.单据");
		expect(calls.filter((c) => c.name === "MetaProbe")).toHaveLength(1);
	});

	it("JVM 没在跑：照样按快照答，不起 JVM", async () => {
		const { service, calls } = setup({ jvm: false });
		const answer = await service.candidates("s1", "demo_bill.");
		expect(answer.items.map((it) => it.id)).toEqual(["demo_bill.demox_qty"]);
		expect(calls.every((c) => c.options.startResident === false && c.options.coldFallback === false)).toBe(true);
	});

	it("表单目录没建：后台去建，这一次照答并说缺什么", async () => {
		const { service, calls } = setup({ formsOnDisk: false });
		const answer = await service.candidates("s1", "数量");
		expect(answer.items.map((it) => it.id)).toEqual(["demo_bill.demox_qty"]);
		expect(answer.note).toContain("表单目录尚未建立");
		expect(calls.some((c) => c.name === "FormCatalogProbe")).toBe(true);
	});
});

describe("发送时换成的那段", () => {
	it("包在引用标签里，带准确位置；目录里没有的回错误，不编", async () => {
		const { service } = setup();
		const got = await service.resolve("s1", "demo_bill.demox_qty");
		expect("text" in got && got.text).toContain(`<${MENTION_TAG} id="demo_bill.demox_qty" label="演示单.数量">`);
		expect("text" in got && got.text).toContain("字段 demo_bill.demox_qty「数量」，DecimalProp，在表头");
		expect(await service.resolve("s1", "demo_bill.nope")).toEqual({ error: "目录里没有 demo_bill.nope" });
	});
});

describe("请求路径", () => {
	const url = (query: string) => `http://local${MENTION_PATH}${query}`;

	it("界面用的路径和宿主一致，发出去的标签界面认得", () => {
		const client = readFileSync(new URL("../../client/brand.js", import.meta.url), "utf8");
		expect(client).toContain(`"${MENTION_PATH.slice(1)}"`);
		expect(client).toContain(`<${MENTION_TAG} id="`);
		expect(MENTION_PATH.startsWith("/api/")).toBe(true);
	});

	it("GET 要带 session；POST 要带 session 和 id", async () => {
		const { service } = setup();
		expect((await handleMention(service, new Request(url("?q=x")))).status).toBe(400);
		const ok200 = await handleMention(service, new Request(url("?session=s1&q=演示")));
		expect(((await ok200.json()) as { items: unknown[] }).items.length).toBe(1);
		const post = (body: unknown) =>
			handleMention(service, new Request(url(""), { method: "POST", body: JSON.stringify(body) }));
		expect((await post({ session: "s1" })).status).toBe(400);
		expect((await post({ session: "s1", id: "demo_bill.nope" })).status).toBe(404);
		expect((await post({ session: "s1", id: "demo_bill" })).status).toBe(200);
	});
});
