/**
 * monitor 后台的真实脾气（真机实测）：只留 7 天；一次只查结束那天往前 5 个自然日、更早的静默丢；从新到旧排；
 * 偶尔一次请求断掉。这里钉住「在这边切段、剪掉保留期外的、照实报」，以及单据足迹怎么认请求。
 */
import { describe, expect, it } from "vitest";
import { groupByTrace, type OpRecord, opKeyMatches, pickRequests } from "../../src/kernel/prod/bill-trail.ts";
import type { HttpPort, HttpReply, MonitorRow, MonitorSession } from "../../src/kernel/prod/monitor.ts";
import {
	coverageLines,
	localTime,
	parseLocalTime,
	planWindows,
	retentionStart,
	searchMonitor,
} from "../../src/kernel/prod/monitor-search.ts";

const MONITOR = { url: "https://demo.example/monitor/eye", username: "viewer", password: "x" };
const SESSION: MonitorSession = {
	username: "viewer",
	cookies: [["ierp-cluster-Auth_Token", "TOK"]],
	csrf: "CSRF",
	loggedInAt: 0,
	keywordBase64: false,
	datasource: "",
};
const at = (text: string): number => parseLocalTime(text);
const NOW = at("2026-11-11 23:00:00");

function reply(body: unknown): HttpReply {
	return { status: 200, text: JSON.stringify(body), header: () => null, setCookies: [] };
}

describe("monitor 查询切段", () => {
	it("保留期从今天往前第 6 天 0 点（东八区）起", () => {
		expect(localTime(retentionStart(NOW))).toBe("2026-11-05 00:00:00");
		expect(localTime(retentionStart(at("2026-11-11 00:00:01")))).toBe("2026-11-05 00:00:00");
	});

	it("长时间段切成每段不超过 5 个自然日，从新到旧；保留期外的剪掉", () => {
		const plan = planWindows(at("2026-11-01 00:00:00"), NOW, NOW);
		expect(plan.clipped).toBe(true);
		expect(plan.windows.map((w) => `${localTime(w.from)}~${localTime(w.to)}`)).toEqual([
			"2026-11-07 00:00:00~2026-11-11 23:00:00",
			"2026-11-05 00:00:00~2026-11-07 00:00:00",
		]);
		const short = planWindows(at("2026-11-11 16:31:30"), at("2026-11-11 16:31:40"), NOW);
		expect(short.windows).toHaveLength(1);
		expect(short.clipped).toBe(false);
		expect(planWindows(at("2026-10-01 00:00:00"), at("2026-10-02 00:00:00"), NOW).windows).toHaveLength(0);
	});

	it("逐段查、条数到上限就停并照实报；网络断一次重发", async () => {
		const asked: { time: string[]; size: number }[] = [];
		let failures = 1;
		const http: HttpPort = {
			async post(_url, body) {
				if (failures-- > 0) throw new Error("fetch failed");
				const form = body as { time: string[]; size: number };
				asked.push(form);
				const day = localTime(Date.parse(form.time[1] as string)).slice(0, 10);
				const rows = Array.from({ length: Math.min(form.size, 3) }, (_, i) => ({
					time: `${day} 10:00:0${String(i)}.000`,
					logtags: { traceId: `t${day}` },
				}));
				return reply({ code: 0, data: rows });
			},
		};
		const full = await searchMonitor(
			http,
			MONITOR,
			SESSION,
			{ keyword: "X", from: "2026-11-01T00:00:00+08:00", size: 100 },
			NOW,
		);
		if (!full.ok) throw full.error;
		expect(asked).toHaveLength(2);
		expect(full.value.rows).toHaveLength(6);
		const lines = coverageLines(full.value, 100);
		expect(lines[0]).toContain("查了 2 段");
		expect(lines.join("\n")).toContain("早于 monitor 保留期");

		asked.length = 0;
		const capped = await searchMonitor(
			http,
			MONITOR,
			SESSION,
			{ keyword: "X", from: "2026-11-05T00:00:00+08:00", size: 2 },
			NOW,
		);
		if (!capped.ok) throw capped.error;
		expect(asked).toHaveLength(1);
		expect(capped.value.capped).toBe(true);
		expect(capped.value.skipped).toBe(1);
		expect(coverageLines(capped.value, 2).join("\n")).toContain("只取到 2026-11-11 10:00:00.000");
	});

	it("只给 traceId 不给时间：查整个保留期", async () => {
		const asked: string[][] = [];
		const http: HttpPort = {
			async post(_url, body) {
				asked.push((body as { time: string[] }).time);
				return reply({ code: 0, data: [] });
			},
		};
		await searchMonitor(http, MONITOR, SESSION, { traceId: "abc" }, NOW);
		expect(localTime(Date.parse(asked.at(-1)?.[0] as string))).toBe("2026-11-05 00:00:00");
	});
});

const row = (
	traceId: string,
	time: string,
	tags: Record<string, string>,
	extra: Partial<MonitorRow> = {},
): MonitorRow => ({
	level: "INFO",
	time: `2026-11-11 ${time}`,
	className: "kd.bos.mvc.FormView",
	message: "",
	logtags: { traceId, userName: "张三", ...tags },
	...extra,
});
const op = (time: string, opKey: string): OpRecord => ({
	time: `2026-11-11 ${time}`,
	ms: at(`2026-11-11 ${time}`),
	user: "张三",
	opKey,
	opName: "",
	status: "1",
	desc: "",
});

describe("单据足迹：认出操作对应的请求", () => {
	it("monitor 的 opKey 是「控件[按钮, 操作]」，第二项对上操作标识", () => {
		expect(opKeyMatches(row("a", "1", { opKey: "tbmain[bar_submit, submit]" }), "submit")).toBe(true);
		expect(opKeyMatches(row("a", "1", { opKey: "toolbarap[tblcheck, audit]" }), "audit")).toBe(true);
		expect(opKeyMatches(row("a", "1", { opKey: "tbmain[bar_submit, submit]" }), "save")).toBe(false);
		expect(opKeyMatches(row("a", "1", { opMethod: "audit" }), "audit")).toBe(true);
	});

	it("对不上 opKey 时取罩住那一刻的页面请求；只有审批流请求罩住时列审批流的", () => {
		const groups = groupByTrace(
			[
				row("page", "10:00:01.000", { formId: "demo_bill", opKey: "btnok" }),
				row("page", "10:00:03.000", { formId: "demo_bill" }),
				row("wf", "10:00:02.000", { formId: "WF_1_SKDJ_S" }),
				row("wf", "10:00:04.000", { formId: "WF_1_SKDJ_S" }),
			],
			"demo",
		);
		expect(pickRequests(groups, op("10:00:02.500", "save")).picked.map((g) => g.traceId)).toEqual(["page"]);
		const flow = pickRequests(groups, op("10:00:04.200", "audit"));
		expect(flow.picked.map((g) => g.traceId)).toEqual(["wf"]);
		expect(flow.how).toContain("审批流程");
		expect(pickRequests(groups, op("11:00:00.000", "audit")).picked).toEqual([]);
	});

	it("分组时数出本工程类和报错首句，慢 SQL 不算报错", () => {
		const [g] = groupByTrace(
			[
				row("t", "10:00:01.000", {}, { className: "demo.plugin.DemoOp" }),
				row("t", "10:00:02.000", {}, { level: "ERROR", message: "重复申请反写网控" }),
				row(
					"t",
					"10:00:03.000",
					{},
					{ level: "ERROR", className: "kd.bos.slowlog.SlowLogger", message: "SlowLogger x" },
				),
			],
			"demo",
		);
		expect(g?.isvClasses).toEqual(["demo.plugin.DemoOp"]);
		expect(g?.problems).toEqual(["重复申请反写网控"]);
	});
});
