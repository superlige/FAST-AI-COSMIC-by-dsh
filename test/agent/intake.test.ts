import { describe, expect, it } from "vitest";
import { budgetErrorDetail } from "../../src/agent/tools/error-detail.ts";
import {
	type PruneContext,
	pruneMetaReport,
	pruneProbeOutcome,
	unregisteredProbeFields,
} from "../../src/agent/tools/probe-manifest.ts";
import {
	createReminderLedger,
	foldReminder,
	foldReminders,
	forgetAllReminders,
	type ReminderLedger,
	reminderBytes,
} from "../../src/agent/tools/reminders.ts";
import {
	createSentLedger,
	FOLD_MIN_RUN,
	foldSentLines as foldAsSent,
	forgetAllSent,
} from "../../src/agent/tools/sent-ledger.ts";

/** 一份把清单里每个字段都填上的探针结果：新加字段没登记，测试会红。 */
const FULL_OUTCOME: Record<string, unknown> = {
	probe: "MetaProbe",
	src: "D:/cache/v0.1.0-abc/resources/probes/MetaProbe.java",
	path: "cold",
	coldReason: "--cold",
	exitCode: 0,
	output: "[PROBE] ok",
	json: { records: [{ t: "assert", ok: true }], broken: [], file: "D:/cache/last-probe.json" },
	outputFile: "D:/cache/probe-runs/2026-x-MetaProbe.out",
	outputLines: { total: 5, shown: 3 },
	stale: { files: 2, lane: "platform", mode: "warn", action: "warned" },
	apiPrecheck: { classes: ["kd.bos.QFilter"], wildcards: [], reflection: "verified", queries: 1 },
	usage: { summary: "查实体设计态字段。", inputs: ["META_ENTITY=实体标识"], required: ["META_ENTITY"] },
	notes: ["n1"],
	// RunReport 在 ProbeOutcome 之上加的四个字段。
	kind: "form",
	target: "zlgd_bill",
	scenarios: null,
	evidence: { filed: [], notes: [] },
	// agent 边界加的兄弟字段和两个预算块。
	knowledgeContext: "",
	delivery: "已执行。",
	writeLog: "D:/project/.cosmic-ai/work/out/x.out",
	outputBudget: {
		truncated: true,
		totalBytes: 10,
		totalLines: 5,
		omittedLines: 2,
		omittedFrom: 2,
		omittedTo: 3,
		outputFile: "D:/cache/probe-runs/2026-x-MetaProbe.out",
		spillError: null,
		remedy: '省略了第 2–3 行（[PROBE] 2）。\n同一调用加 raw="起-止" 或 raw="关键字"（正则）取回，不重跑。',
	},
	recordBudget: {
		total: 1,
		shown: 1,
		indexOnly: 0,
		folded: 0,
		omitted: 0,
		file: "D:/cache/last-probe.json",
		remedy: "全部 1 条在 D:/cache/probe-runs/2026-x-MetaProbe.out。",
	},
};

const RELEASED: PruneContext = { adHoc: false };

describe("S34 1.3 探针结果的字段清单", () => {
	it("清单里的每个字段都登记过：填满字段的样本一个不缺", () => {
		expect(unregisteredProbeFields(FULL_OUTCOME)).toEqual([]);
	});

	it("新加一个没登记的字段，测试变红", () => {
		const added = { ...FULL_OUTCOME, someNewField: 1 };
		expect(unregisteredProbeFields(added)).toEqual(["someNewField"]);
	});

	it("内置探针：源码路径、last-probe.json、outputFile、写通道存档不发；探针名照发", () => {
		const pruned = pruneProbeOutcome({ ...FULL_OUTCOME }, RELEASED) as Record<string, unknown>;
		expect(pruned.probe).toBe("MetaProbe");
		expect(pruned).not.toHaveProperty("src");
		expect((pruned.json as Record<string, unknown>).file).toBeUndefined();
		expect(pruned).not.toHaveProperty("outputFile");
		expect(pruned).not.toHaveProperty("writeLog");
		const prunedText = JSON.stringify(pruned);
		expect(prunedText).not.toContain("last-probe.json");
		expect(prunedText).not.toContain("resources/probes/MetaProbe.java");
	});

	it("验证记录只发编号和结论，分场景的带场景名和命令；整份还在 details 里（S63）", () => {
		// 落盘的记录是给交付核对用的整份。整份照发时，断言在 json.records 有一份、提醒在 notes 有一份、
		// 命令行是模型自己刚写的：2026-10 的 223 次运行里这一块占返回的 28%。
		const record = (id: string, result: string, scenario: string | null) => ({
			kind: "AssertionEvidence",
			id,
			digest: `${id}-digest`,
			at: "2026-10-11T16:01:44.322Z",
			runtimeKeyId: "v1",
			sourceFingerprint: "8b54f169",
			gates: { class_fresh: "block" },
			argv: ["op", "demo_bill", "save", "--pk", "1", "--expect", "success=true"],
			scenarioKey: `op demo_bill save --pk 1 ${scenario ?? ""}`.trim(),
			scenarioId: scenario,
			scenario,
			result,
			asserts: [{ kind: "op-success", target: "success", expect: "true", actual: "true", pass: true, why: null }],
			path: "hot",
			warnings: ["demo_bill 的插件链上 X 会发消息：运行是真提交，走到它时会真的发出去。"],
			log: "D:/cache/probe-runs/2026-x-OpSandbox.out",
			usesPk: true,
		});
		const single = { ...FULL_OUTCOME, evidence: { filed: [record("AE-1", "PASS", null)], notes: ["验证记录：…"] } };
		const pruned = pruneProbeOutcome(single, RELEASED) as Record<string, unknown>;
		expect(pruned.evidence).toEqual({ filed: [{ id: "AE-1", result: "PASS" }] });
		// 同一句已经并在顶层 notes 里，evidence.notes 不再发一遍
		expect(JSON.stringify(pruned)).not.toContain("验证记录：…");
		expect(JSON.stringify(pruned)).not.toContain("OpSandbox.out");
		// 发给模型的是另一份：原对象一个字节不少，界面和交付核对照旧读它
		expect(single.evidence.filed[0]?.warnings).toHaveLength(1);

		const batch = {
			...FULL_OUTCOME,
			evidence: { filed: [record("AE-2", "PASS", "空备注"), record("AE-3", "FAIL", "有备注")], notes: [] },
		};
		expect((pruneProbeOutcome(batch, RELEASED) as Record<string, unknown>).evidence).toEqual({
			filed: [
				{ id: "AE-2", result: "PASS", scenario: "空备注", scenarioKey: "op demo_bill save --pk 1 空备注" },
				// 红的那条要照它原样重跑才换得掉，命令留着
				{ id: "AE-3", result: "FAIL", scenario: "有备注", scenarioKey: "op demo_bill save --pk 1 有备注" },
			],
		});
	});

	it("临时探针：源码路径照发——那是它要改的文件", () => {
		const pruned = pruneProbeOutcome({ ...FULL_OUTCOME }, { adHoc: true }) as Record<string, unknown>;
		expect(pruned.src).toBe(FULL_OUTCOME.src);
	});

	it("正常时的 stale、apiPrecheck、coldReason、outputLines 不发，出问题时才发", () => {
		const normal = pruneProbeOutcome(
			{
				...FULL_OUTCOME,
				path: "hot",
				coldReason: null,
				outputLines: { total: 3, shown: 3 },
				stale: { files: 0, lane: "business", mode: "block", action: "none" },
				apiPrecheck: { classes: [], wildcards: [], reflection: "verified", queries: 0 },
			},
			RELEASED,
		) as Record<string, unknown>;
		expect(normal).not.toHaveProperty("stale");
		expect(normal).not.toHaveProperty("apiPrecheck");
		expect(normal).not.toHaveProperty("coldReason");
		expect(normal).not.toHaveProperty("outputLines");

		const warn = pruneProbeOutcome({ ...FULL_OUTCOME }, RELEASED) as Record<string, unknown>;
		expect(warn.stale).toEqual(FULL_OUTCOME.stale);
		expect(warn.coldReason).toBe("--cold");
		expect(warn.outputLines).toEqual({ total: 5, shown: 3 });

		const unchecked = pruneProbeOutcome(
			{
				...FULL_OUTCOME,
				apiPrecheck: { classes: [], wildcards: ["kd.bos.*"], reflection: "unavailable", queries: 0 },
			},
			RELEASED,
		) as Record<string, unknown>;
		expect(unchecked.apiPrecheck).toBeDefined();
	});

	it("recordBudget 和 outputBudget 的位置信息并入 remedy，字段本身不发", () => {
		const pruned = pruneProbeOutcome({ ...FULL_OUTCOME }, RELEASED) as Record<string, unknown>;
		const recordBudget = pruned.recordBudget as Record<string, unknown>;
		const outputBudget = pruned.outputBudget as Record<string, unknown>;
		expect(recordBudget).not.toHaveProperty("file");
		expect(outputBudget).not.toHaveProperty("outputFile");
		expect(String(recordBudget.remedy)).toContain("probe-runs/2026-x-MetaProbe.out");
	});

	it("meta diff 三份内容留一份：顶层 text 在，diff.text 和每文件 lines 变计数", () => {
		const report = {
			kind: "diff",
			family: "ptpl",
			action: "diff",
			dryRun: false,
			writes: false,
			diff: {
				dirA: "A",
				dirB: "B",
				mode: "design",
				both: ["x.json"],
				onlyA: [],
				onlyB: [],
				files: [{ name: "x.json", changes: 2, fellBackToText: false, lines: ["  - old", "  + new"] }],
				changes: 2,
				text: "[meta] A=x\n[meta] - old\n[meta] + new",
			},
			text: "[meta] A=x\n[meta] - old\n[meta] + new",
			notes: [],
		};
		const pruned = pruneMetaReport(report, RELEASED) as Record<string, unknown>;
		expect(pruned.text).toBe(report.text);
		const diff = pruned.diff as Record<string, unknown>;
		expect(diff).not.toHaveProperty("text");
		expect(diff.changes).toBe(2);
		expect(diff.files).toEqual([{ name: "x.json", changes: 2, fellBackToText: false }]);
	});
});

const noExpectNote = "这次没有业务断言（没带 --expect），不算验证 —— 跑通了不等于验过了，交付要的是断言过了的运行";
const evidenceNote = "验证记录：这次留下 2 条（4 条断言全过、共 6 条断言）。";
const adHocNote = "这些断言是临时探针自己判的，不算验过；要验过用 cosmic_run 带 --expect 跑。";

describe("S34 1.7 固定提醒登记成条目", () => {
	it("第一次完整说，第二次只留这次的事实加编号", () => {
		const ledger: ReminderLedger = createReminderLedger();
		expect(foldReminder(ledger, noExpectNote)).toBe(noExpectNote);
		const second = foldReminder(ledger, noExpectNote);
		expect(second).toContain("这次没有业务断言（没带 --expect），不算验证");
		expect(second).not.toContain("跑通了不等于验过了");
		expect(second).toMatch(/（提醒 \d+，同上）/);
	});

	it("带运行事实的提醒：条数留下", () => {
		const ledger = createReminderLedger();
		expect(foldReminder(ledger, evidenceNote)).toBe(evidenceNote);
		const second = foldReminder(ledger, evidenceNote);
		expect(second).toContain("这次留下 2 条（4 条断言全过、共 6 条断言）");
	});

	it("解释性尾巴折掉，但「不算验过」这个结论本身留下", () => {
		const ledger = createReminderLedger();
		expect(foldReminder(ledger, adHocNote)).toBe(adHocNote);
		const second = foldReminder(ledger, adHocNote);
		expect(second).toContain("不算验过（提醒");
		expect(second).not.toContain("cosmic_run 带 --expect 跑");
	});

	it("账认的是模型看没看过，不认是哪个工具说的；清账后重新完整说", () => {
		const ledger = createReminderLedger();
		foldReminder(ledger, noExpectNote); // cosmic_run 说的那一次
		const second = foldReminder(ledger, noExpectNote); // 另一个出口再说的那一次
		expect(second).toMatch(/（提醒 \d+，同上）/);
		forgetAllReminders(ledger);
		expect(foldReminder(ledger, noExpectNote)).toBe(noExpectNote);
	});

	it("多行正文按行折，没登记的行原样不动", () => {
		const ledger = createReminderLedger();
		const text = ["[PROBE] 第一步", noExpectNote, "[PROBE] 第二步"].join("\n");
		expect(foldReminders(ledger, text).text).toBe(text);
		const again = foldReminders(ledger, text);
		expect(again.folded).toBe(1);
		expect(again.text.split("\n")[1]).toMatch(/（提醒 \d+，同上）$/);
	});

	it("提醒账的字节数只数登记过的提醒", () => {
		expect(reminderBytes([noExpectNote, "[PROBE] 业务结论一行"])).toBeGreaterThan(0);
		expect(reminderBytes(["[PROBE] 业务结论一行"])).toBe(0);
	});
});

const BACKGROUND = [
	`[PROBE] === 实体 zlgd_bill ${"甲".repeat(20)}`,
	`[PROBE] 字段 zlgd_qty ${"乙".repeat(20)}`,
	`[PROBE] 字段 zlgd_price ${"丙".repeat(20)}`,
].join("\n");

describe("S34 1.6 已发账", () => {
	// 这一组验的是「哪些行折、怎么折」，样本都很短：把「小返回不折」那条线关掉单独验。
	const foldSentLines = (ledger: ReturnType<typeof createSentLedger>, text: string) =>
		foldAsSent(ledger, text, { minTextBytes: 0 });

	it("整份正文不到 1 KB 的不折：再查一遍回来的那一行数据就是答案", () => {
		const ledger = createSentLedger();
		const row = "[PROBE] #1  id=2579028605501748224 | billno=SYSJC-20260929-0001 | billstatus=A";
		const answer = ["[PROBE] 字段：id, billno, billstatus（下面每行按这个顺序）", row, `${row} `].join("\n");
		foldAsSent(ledger, answer);
		const again = foldAsSent(ledger, answer);
		expect(again.foldedLines).toBe(0);
		expect(again.text).toBe(answer);
	});

	it("小返回照样入账：后面的大返回里同样的段落仍然折", () => {
		const ledger = createSentLedger();
		foldAsSent(ledger, BACKGROUND);
		const big = [
			BACKGROUND,
			...Array.from({ length: 30 }, (_, i) => `[PROBE] 新的一行 ${String(i)} ${"丁".repeat(20)}`),
		];
		const verdict = foldAsSent(ledger, big.join("\n"));
		expect(verdict.foldedLines).toBe(3);
	});

	it("第一次全发；同一背景再发时折成一句，结果行原样", () => {
		const ledger = createSentLedger();
		const first = `${BACKGROUND}\n[PROBE] 断言通过 PASS`;
		expect(foldSentLines(ledger, first).foldedLines).toBe(0);

		const second = `${BACKGROUND}\n[PROBE] 断言没过 FAIL`;
		const verdict = foldSentLines(ledger, second);
		expect(verdict.foldedLines).toBe(3);
		const lines = verdict.text.split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[0]).toBe(`（3 行与前面发过的相同：=== 实体 zlgd_bill 甲甲甲… ～ 字段 zlgd_price 丙丙丙丙丙丙…）`);
		expect(lines[1]).toBe("[PROBE] 断言没过 FAIL");
	});

	it(`连发不足 ${String(FOLD_MIN_RUN)} 行的相同段不折`, () => {
		const ledger = createSentLedger();
		foldSentLines(ledger, BACKGROUND);
		const pair = `${BACKGROUND.split("\n")[0]}\n[PROBE] 新结论`;
		const verdict = foldSentLines(ledger, pair);
		expect(verdict.foldedLines).toBe(0);
		expect(verdict.text).toBe(pair);
	});

	it("结果行永不折，并且隔断它两侧的背景段", () => {
		const ledger = createSentLedger();
		const withResult = [BACKGROUND, "[PROBE] 中间一条未落库", BACKGROUND].join("\n");
		foldSentLines(ledger, withResult);
		const verdict = foldSentLines(ledger, withResult);
		const lines = verdict.text.split("\n");
		expect(lines).toHaveLength(3);
		expect(lines[1]).toBe("[PROBE] 中间一条未落库");
		expect(lines[0]).toMatch(/^（3 行与前面发过的相同：/);
		expect(lines[2]).toMatch(/^（3 行与前面发过的相同：/);
	});

	it("折完省不下一半字节的短段照发：另一张单上同名的按钮不被拆成几段", () => {
		const ledger = createSentLedger();
		const bar = (key: string, name: string) => `[PROBE]     ${key} BarItemAp「${name}」 OperationKey=${key.slice(4)}`;
		foldSentLines(ledger, [bar("bar_new", "新增"), bar("bar_del", "删除"), bar("bar_save", "保存")].join("\n"));
		const other = [
			"[PROBE] ── tbmain 下的控件",
			bar("bar_new", "新增"),
			bar("bar_del", "删除"),
			bar("bar_print", "打印"),
		].join("\n");
		const verdict = foldSentLines(ledger, other);
		expect(verdict.foldedLines).toBe(0);
		expect(verdict.text).toBe(other);
	});

	it("内容变过的行不算发过：照发，并把段隔断", () => {
		const ledger = createSentLedger();
		foldSentLines(ledger, BACKGROUND);
		const changed = BACKGROUND.replace("zlgd_qty", "zlgd_amount");
		const verdict = foldSentLines(ledger, changed);
		expect(verdict.foldedLines).toBe(0);
	});

	it("压缩清账之后，同样的内容重新完整发", () => {
		const ledger = createSentLedger();
		foldSentLines(ledger, BACKGROUND);
		forgetAllSent(ledger);
		expect(foldSentLines(ledger, BACKGROUND).foldedLines).toBe(0);
	});
});

describe("S34 1.4 失败详情也过预算", () => {
	it("超长的字符串值留头尾，中间换成说明；短的原样", () => {
		const raw = Array.from({ length: 3000 }, (_, i) => `error line ${String(i)} ${"x".repeat(10)}`).join("\n");
		const detail = budgetErrorDetail({ raw, code: "COMPILE_FAILED" });
		const cut = detail.raw as string;
		expect(cut.length).toBeLessThan(raw.length / 3);
		expect(cut).toContain("error line 0");
		expect(cut).toContain("error line 2999");
		expect(cut).toContain("中间省略");
		expect(detail.code).toBe("COMPILE_FAILED");
		expect(budgetErrorDetail({ raw: "短" })).toEqual({ raw: "短" });
	});
});
