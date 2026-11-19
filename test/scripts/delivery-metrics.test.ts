import { describe, expect, it } from "vitest";
import {
	classifyThought,
	countStatedDecisions,
	latencyByContext,
	measureDelivery,
} from "../../scripts/delivery-metrics.mjs";

const at = (s: number) => new Date(Date.UTC(2026, 9, 5, 0, 0, s)).toISOString();
const user = (s: number, text = "需求") => ({
	type: "message",
	timestamp: at(s),
	message: { role: "user", content: [{ type: "text", text }] },
});
function assistant(
	s: number,
	{
		thinking = "",
		text = "",
		calls = [] as Array<{ id: string; name: string; args: object }>,
		output = 100,
		context = 10_000,
	} = {},
) {
	return {
		type: "message",
		timestamp: at(s),
		message: {
			role: "assistant",
			usage: { input: 100, cacheRead: context - 100, cacheWrite: 0, output },
			content: [
				...(thinking ? [{ type: "thinking", thinking }] : []),
				...(text ? [{ type: "text", text }] : []),
				...calls.map((c) => ({ type: "toolCall", id: c.id, name: c.name, arguments: c.args })),
			],
		},
	};
}
const result = (s: number, id: string, name: string, text: string) => ({
	type: "message",
	timestamp: at(s),
	message: { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }] },
});

describe("S44 批 0 交付尺子", () => {
	it("长思考按开头归类，后面草拟的改动清单不带偏", () => {
		const draft = Array.from(
			{ length: 30 },
			(_, i) => `add field TextField zlgd_f${i} into fs_baseinfo 字段${i}`,
		).join("\n");
		const r = classifyThought(`The output got truncated and 36 lines were omitted. Let me plan.\n${draft}`);
		expect(r.kind).toBe("toolOutput");
		expect(r.drafts).toBe(true);
		expect(classifyThought("Lock options are new/edit/submit/audit; does EntryAp have Lock?").kind).toBe("platform");
		expect(
			classifyThought("Let me decide: reuse the existing panel or add a new one? Option A is simpler.").kind,
		).toBe("design");
		expect(classifyThought("好的。").kind).toBe("other");
	});

	it("数口径那一节的列表项和表格数据行，不数别处", () => {
		const text = [
			"## 一、字段",
			"| 名称 | 标识 |",
			"|---|---|",
			"| 状态 | zlgd_a |",
			"## 五、我替你定的几个口径",
			"- 下拉用字母",
			"- 旧值用 2000",
			"| 项 | 定的 |",
			"|---|---|",
			"| 附件 | 新加 |",
			"## 六、验收",
			"- 打开看看",
		].join("\n");
		expect(countStatedDecisions(text)).toBe(3);
	});

	it("时间拆分、长思考、试错、复核改判和清单一起量", () => {
		const edit =
			"add field ComboField zlgd_st into fs_baseinfo 状态 items=A:修改中,B:已完成\nset bar_new.Invisible=true";
		const records = [
			user(0),
			assistant(10, {
				thinking: "Lock options are only new/edit.",
				output: 3000,
				context: 40_000,
				calls: [
					{
						id: "c1",
						name: "cosmic_probe",
						args: {
							name: "FormLayoutWriteProbe",
							env: { LAYOUT_FORM: "zlgd_x", LAYOUT_EDIT: "set billno.Lock=new" },
						},
					},
				],
			}),
			result(
				14,
				"c1",
				"cosmic_probe",
				'{"ok":false,"error":{"code":"PROBE_FAILED"}}\n[PROBE-ERR] java.lang.IllegalStateException: 改动清单有 7 处问题，一处都没写：',
			),
			assistant(20, {
				output: 500,
				context: 50_000,
				calls: [
					{
						id: "c2",
						name: "cosmic_probe",
						args: { name: "FormLayoutWriteProbe", env: { LAYOUT_FORM: "zlgd_x", LAYOUT_EDIT: edit } },
					},
				],
			}),
			result(24, "c2", "cosmic_probe", '{"ok":true,"result":{}}'),
			assistant(30, {
				output: 400,
				context: 52_000,
				calls: [
					{
						id: "c3",
						name: "cosmic_authorize",
						args: { changes: [{ plan: "P1", purpose: "加附件面板" }], decisions: ["下拉存储值用字母"] },
					},
				],
			}),
			result(31, "c3", "cosmic_authorize", '{"ok":true}'),
			assistant(40, {
				output: 300,
				context: 53_000,
				calls: [
					{
						id: "c4",
						name: "cosmic_probe",
						args: { name: "FormLayoutWriteProbe", env: { APPLY: "1", LAYOUT_FORM: "zlgd_x", LAYOUT_EDIT: edit } },
					},
				],
			}),
			result(45, "c4", "cosmic_probe", '{"ok":true,"result":{}}'),
			assistant(50, {
				output: 200,
				context: 54_000,
				calls: [
					{ id: "c5", name: "write", args: { path: "D:/p/.cosmic-ai/probes/Tmp.java", content: "class Tmp {}" } },
				],
			}),
			result(51, "c5", "write", "ok"),
			assistant(60, {
				output: 800,
				context: 55_000,
				text: "## 交付说明\n加了状态字段，附件复用原有面板。\n## 我替你定的口径\n- 下拉用字母",
			}),
		];
		const checklist = {
			name: "样例",
			items: [
				{
					id: "a",
					text: "状态下拉",
					any: [{ re: "^add field ComboField \\S+ \\S+ \\S+ 状态 items=.*修改中.*已完成" }],
				},
				{ id: "b", text: "列表新增藏掉", all: [{ re: "^set tblnew\\.Invisible=true$", label: "tblnew" }] },
				{ id: "c", text: "没写 Java", none: [{ in: "code", re: "\\S" }] },
				{ id: "d", text: "人看", manual: true },
			],
			decisions: [
				{ id: "p1", text: "附件", mention: ["附件"] },
				{ id: "p2", text: "存储值", mention: ["字母"] },
				{ id: "p3", text: "位置", mention: ["位置"] },
			],
		};
		const m = measureDelivery(records, { checklist, sessionKey: "S", review: { "S#1": "design" } });
		expect(m.modelRounds).toBe(6);
		expect(m.modelMs).toBe((10 + 6 + 6 + 9 + 5 + 9) * 1000);
		expect(m.toolMs).toBe((4 + 4 + 1 + 5 + 1) * 1000);
		expect(m.long).toMatchObject({ rounds: 1, reviewed: 1, changedByReview: 1, byKind: { design: 1, platform: 0 } });
		expect(m.long.details[0]).toMatchObject({ auto: "platform", kind: "design", dryRunsBefore: 0 });
		expect(m.long.details[0].thinking).toBeUndefined();
		// 同一轮里发出的试算不算"之前"：思考在调用之前；要全文才带全文
		const low = measureDelivery(records, { longTokens: 400, fullThinking: true });
		expect(low.long.details.map((d: { round: number; dryRunsBefore: number }) => [d.round, d.dryRunsBefore])).toEqual(
			[
				[1, 0],
				[2, 1],
				[3, 2],
				[6, 2],
			],
		);
		expect(low.long.details[0].thinking).toBe("Lock options are only new/edit.");
		expect(m.trial).toMatchObject({ dryRuns: 2, dryRejected: 1, rejectedItems: 7, dryTargets: 1 });
		expect(m.decisions).toEqual({ stated: 1, asked: 0 });
		const c = m.checklist;
		expect(c).toMatchObject({ done: 2, missed: 1, manual: 1, total: 4 });
		expect(c.items.find((i: { id: string }) => i.id === "b").missing).toEqual(["tblnew"]);
		// 临时探针不算业务代码；确认单"这次改什么"提到附件不算写前摆出，专门的口径格才算
		expect(c.items.find((i: { id: string }) => i.id === "c").status).toBe("done");
		expect(c.decisionDetails.map((d: { shown: string }) => d.shown)).toEqual(["finalOnly", "beforeWrite", "none"]);
		const buckets = latencyByContext([m]);
		expect(Object.keys(buckets)).toEqual(["30-60K"]);
		expect(buckets["30-60K"]).toMatchObject({ rounds: 6, avgOutputTokens: Math.round(5200 / 6) });
	});
});
