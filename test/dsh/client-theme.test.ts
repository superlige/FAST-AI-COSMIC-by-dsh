/**
 * 界面插件（client/brand.js）挂到 dsh 上的那一步：主题变量每个都是「浅色、深色各一个值」——
 * dsh 收到单个值会当场抛错，整个界面插件就挂不上；该挂的插槽都挂了。
 * 不渲染组件（本仓库不装 React），只在 Node 里跑一遍工厂和 apply。
 */
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { CARD_FENCE, checkReport, confirmationDetail } from "../../src/agent/state/write-report.ts";
import { buildWriteForm } from "../../src/kernel/policy/write-form.ts";

interface ClientModule {
	inject: string[];
	apply(ctx: unknown): void;
}

function loadClient(): ClientModule {
	const source = readFileSync(new URL("../../client/brand.js", import.meta.url), "utf8");
	let factory: ((require: (name: string) => unknown) => ClientModule) | undefined;
	runInNewContext(source, {
		window: {
			__ModuleLoader__: {
				load: (entry: { factory: typeof factory }) => {
					factory = entry.factory;
				},
			},
		},
	});
	if (factory === undefined) throw new Error("brand.js 没有登记模块");
	const fakeReact = { createElement: () => null };
	return factory((name) => {
		if (name === "react") return fakeReact;
		throw new Error(`没有 ${name}`);
	});
}

interface Entry {
	name: string;
	priority?: number;
	select?: (props: { pendingInteraction: unknown }) => unknown;
}

function applyClient() {
	const overrides: Record<string, unknown>[] = [];
	const slots: string[] = [];
	const entries: Entry[] = [];
	const ctx = {
		effect: (run: () => unknown) => run(),
		theme: {
			overrideTokens: (_source: string, tokens: Record<string, unknown>) => {
				overrides.push(tokens);
				return () => {};
			},
		},
		slots: {
			inject: (_name: string, run: () => unknown) => {
				const result = run();
				if (result !== null && typeof result === "object" && Symbol.iterator in result)
					for (const _ of result as Iterable<unknown>);
			},
			register: (entry: Entry) => {
				slots.push(entry.name);
				entries.push(entry);
				return () => {};
			},
		},
	};
	loadClient().apply(ctx);
	return { overrides, slots, entries };
}

/** 一张写入确认：正文就是工具弹窗时给的那份（Markdown 确认单 + 卡片数据）。 */
function writeDetail(): string {
	const targets = ["demo_bill.demo_bill_lay"];
	const form = buildWriteForm({
		probe: "FormLayoutWriteProbe",
		env: { LAYOUT_FORM: "demo_bill_lay" },
		records: [{ t: "layout-change", scope: "", element: "demo_f1", prop: "宽度", before: "1", after: "2" }] as never,
		targets,
	});
	const checked = checkReport(
		{ probe: "FormLayoutWriteProbe", kind: "单据布局", digest: "d", call: "c", targets, form },
		{ purpose: "调宽度", names: form.names.map((id) => ({ id, name: "布局" })) },
	);
	if (!checked.ok) throw new Error(checked.message);
	return confirmationDetail(checked.change);
}

describe("界面插件挂到 dsh 上", () => {
	it("主题变量每个都是浅色、深色各一个非空字符串", () => {
		const { overrides } = applyClient();
		expect(overrides).toHaveLength(1);
		const tokens = overrides[0] as Record<string, { light: unknown; dark: unknown }>;
		expect(Object.keys(tokens).length).toBeGreaterThan(50);
		for (const [name, value] of Object.entries(tokens)) {
			expect(name, name).toMatch(/^--[a-z0-9-]+$/);
			expect(typeof value.light === "string" && value.light !== "", name).toBe(true);
			expect(typeof value.dark === "string" && value.dark !== "", name).toBe(true);
		}
	});

	it("和 pi 版首页同一套配色：品牌色、状态色深浅两套都在", () => {
		const tokens = applyClient().overrides[0] as Record<string, { light: string; dark: string }>;
		expect(tokens["--cosmic-glow"]).toEqual({ light: "rgb(32, 128, 118)", dark: "rgb(112, 226, 208)" });
		expect(tokens["--cosmic-ready"]).toEqual({ light: "rgb(46, 128, 56)", dark: "rgb(134, 214, 127)" });
		expect(tokens["--dsw-alias-state-success-primary"]).toEqual(tokens["--cosmic-ready"]);
	});

	it("插槽：侧栏标志和名字、首页品牌位和背景、模型页登录卡片、输入框左边的 JVM 小标签", () => {
		expect(applyClient().slots.sort()).toEqual(
			[
				"conversation.composer",
				"conversation.hero.brand.mark",
				"conversation.hero.frame",
				"conversation.input.left",
				"settings.models.provider-card",
				"sidebar.brand.mark",
				"sidebar.brand.name",
			].sort(),
		);
	});

	it("写入确认卡片：排在 dsh 提问卡前面，只认领带卡片数据的写入确认，别的提问交还给 dsh", () => {
		const source = readFileSync(new URL("../../client/brand.js", import.meta.url), "utf8");
		expect(source).toContain(`const CARD_FENCE = "${CARD_FENCE}";`);
		expect(source).toContain('const WRITE_QUESTION_ID = "cosmic-write";');
		const entry = applyClient().entries.find((one) => one.name === "conversation.composer");
		expect(entry?.priority).toBeLessThan(0);
		const select = (pendingInteraction: unknown) => entry?.select?.({ pendingInteraction }) ?? null;
		const pending = (id: string, detail: string) => ({ questions: [{ id, detail }], answer: async () => {} });
		const mine = pending("cosmic-write", writeDetail());
		expect((select(mine) as { view: { kind: string } }).view.kind).toBe("单据布局");
		expect(select(pending("cosmic-write", "只有 Markdown，没有卡片数据"))).toBeNull();
		expect(select(pending("cosmic-choose", writeDetail()))).toBeNull();
		const broken = writeDetail().split("\n");
		broken[broken.length - 2] = "{坏的";
		expect(select(pending("cosmic-write", broken.join("\n")))).toBeNull();
		expect(select(undefined)).toBeNull();
	});
});
