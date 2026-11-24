/**
 * 界面插件（client/brand.js）挂到 dsh 上的那一步：主题变量每个都是「浅色、深色各一个值」——
 * dsh 收到单个值会当场抛错，整个界面插件就挂不上；该挂的插槽都挂了。
 * 不渲染组件（本仓库不装 React），只在 Node 里跑一遍工厂和 apply。
 */
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { CARD_FENCE, checkReport, confirmationDetail } from "../../src/agent/state/write-report.ts";
import { mentionBlock } from "../../src/kernel/impact/mention.ts";
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
	// 只够组件在 Node 里调一次：createElement 记下标签、属性和子节点，useState 直接给初值，副作用不跑
	const fakeReact = {
		createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }),
		useState: (initial: unknown) => [
			typeof initial === "function" ? (initial as () => unknown)() : initial,
			() => {},
		],
		useEffect: () => {},
		useRef: (initial: unknown) => ({ current: initial }),
		useCallback: (fn: unknown) => fn,
		useMemo: (fn: () => unknown) => fn(),
	};
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

type Listener = (...args: unknown[]) => unknown;

function applyClient() {
	const overrides: Record<string, unknown>[] = [];
	const slots: string[] = [];
	const entries: Entry[] = [];
	const components = new Map<string, (props: Record<string, unknown>) => unknown>();
	const listeners = new Map<string, Listener>();
	const sources: Record<string, unknown>[] = [];
	const rules: Record<string, unknown>[] = [];
	const ctx: Record<string, unknown> = {
		effect: (run: () => unknown) => run(),
		on: (event: string, listener: Listener) => {
			listeners.set(event, listener);
			return () => {};
		},
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
			register: (entry: Entry, component?: (props: Record<string, unknown>) => unknown) => {
				slots.push(entry.name);
				entries.push(entry);
				if (component !== undefined) components.set(entry.name, component);
				return () => {};
			},
		},
	};
	// 可选服务：真 dsh 里有才挂，这里都给上
	ctx.inject = (_names: string[], run: (sub: unknown) => void) =>
		run({
			...ctx,
			inputTriggers: { registerSource: (source: Record<string, unknown>) => (sources.push(source), () => {}) },
			uiConversation: { userText: { register: (rule: Record<string, unknown>) => (rules.push(rule), () => {}) } },
		});
	(loadClient() as { apply(ctx: unknown): void }).apply(ctx);
	return { overrides, slots, entries, components, listeners, sources, rules };
}

/** 假 React 记下的一棵树里所有文字，拼成一串。 */
function textOf(node: unknown): string {
	if (node === null || node === undefined || typeof node === "boolean") return "";
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(textOf).join("");
	return textOf((node as { children?: unknown[] }).children ?? []);
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

	it("品牌色和状态色是 iOS 27 系统色，深浅两套都在；底色灰阶不带颜色", () => {
		const tokens = applyClient().overrides[0] as Record<string, { light: string; dark: string }>;
		expect(tokens["--cosmic-glow"]).toEqual({ light: "rgb(0, 136, 255)", dark: "rgb(0, 145, 255)" });
		expect(tokens["--cosmic-accent"]).toEqual({ light: "rgb(97, 85, 245)", dark: "rgb(109, 124, 255)" });
		expect(tokens["--cosmic-ready"]).toEqual({ light: "rgb(0, 137, 50)", dark: "rgb(48, 209, 88)" });
		expect(tokens["--dsw-alias-state-success-primary"]).toEqual(tokens["--cosmic-ready"]);
		expect(tokens["--dsw-alias-brand-primary"]).toEqual(tokens["--cosmic-glow"]);
		// 背景、文字、侧栏都引用这两条灰阶：染上颜色，整屏的底和字就成了一个色，读起来发糊
		const grays = Object.entries(tokens).filter(([name]) => /^--dsw-static-neutral(-bluish)?-/.test(name));
		expect(grays.length).toBeGreaterThan(30);
		for (const [name, value] of grays) {
			const saturation = Number(/^hsl\(\d+ (\d+)%/.exec(value.dark)?.[1]);
			expect(saturation, name).toBeLessThanOrEqual(8);
		}
	});

	it("插槽：侧栏标志和名字、首页主屏和壁纸、模型页登录卡片、输入框左边的 JVM 和缓存小标签、输入框上方的命令结果、历史消息里的 @ 引用", () => {
		expect(applyClient().slots.sort()).toEqual(
			[
				"conversation.composer",
				"conversation.hero.brand.mark",
				"conversation.hero.frame",
				"conversation.input.dock",
				"conversation.input.left",
				"conversation.input.left",
				"conversation.user.text.node",
				"settings.models.provider-card",
				"sidebar.brand.mark",
				"sidebar.brand.name",
			].sort(),
		);
	});

	it("@ 引用：输入框候选挂成 @ 来源，选中的引用带上会话；发出去的那段在历史消息里画回成一枚引用", async () => {
		const { sources, rules } = applyClient();
		const source = sources[0] as {
			trigger: string;
			name: string;
			onPick(pick: unknown): { insert?: { ref: string; clipboardText: string }; text?: string };
			codec: { clipboardText(ref: string): string };
		};
		expect([source.trigger, source.name]).toEqual(["@", "cosmic"]);
		const candidate = (drill: boolean) => ({
			value: JSON.stringify({ id: "demo_bill.demo_qty", label: "演示单.数量", drill }),
		});
		const picked = source.onPick({ candidate: candidate(false), action: "pick", session: { sessionId: "s1" } });
		expect(picked.insert?.ref).toBe("s1#demo_bill.demo_qty");
		expect(source.codec.clipboardText(picked.insert?.ref ?? "")).toBe("demo_bill.demo_qty");
		expect(source.onPick({ candidate: candidate(true), action: "drill", session: { sessionId: "s1" } }).text).toBe(
			"@demo_bill.demo_qty.",
		);
		const rule = rules[0] as {
			id: string;
			match(text: string, from: number): { start: number; data: { label: string; id: string } } | undefined;
		};
		const block = mentionBlock("演示单.数量", "demo_bill.demo_qty", "字段 demo_bill.demo_qty「数量」，在表头");
		const hit = rule.match(`把 ${block} 改成必录`, 0);
		expect([rule.id, hit?.start, hit?.data.label, hit?.data.id]).toEqual([
			"cosmic-ref",
			2,
			"演示单.数量",
			"demo_bill.demo_qty",
		]);
		expect(rule.match("没有引用", 0)).toBeUndefined();
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

	it("新会话首页上敲命令：跑完把结果画在输入框上方；别的会话、发过话的会话不画", () => {
		// dsh 只在发过第一句话以后才画对话流，首页上敲 /cosmic-jvm 之前是跑完了却什么都看不见
		const { components, listeners } = applyClient();
		const dock = components.get("conversation.input.dock");
		const executed = listeners.get("command/executed");
		if (dock === undefined || executed === undefined) throw new Error("命令结果卡片没挂上");
		const home = { sessionId: "s1", blank: true, running: false, promptAttempted: false };
		expect(dock({ session: home })).toBeNull();

		executed("s1", "cosmic-jvm", { kind: "success", text: "本机 cosmic 进程：常驻 JVM 0 个" });
		const card = dock({ session: home });
		expect(textOf(card)).toContain("/cosmic-jvm");
		expect(textOf(card)).toContain("本机 cosmic 进程：常驻 JVM 0 个");
		expect(dock({ session: { ...home, sessionId: "s2" } })).toBeNull();
		expect(dock({ session: { ...home, blank: false } })).toBeNull();
		expect(dock({ session: { ...home, promptAttempted: true } })).toBeNull();

		executed("s1", "cosmic-env", { kind: "error", text: "环境识别没做成：找不到工程" });
		const failed = dock({ session: home });
		expect(textOf(failed)).toContain("没做成");
		expect(textOf(failed)).toContain("找不到工程");
	});
});
