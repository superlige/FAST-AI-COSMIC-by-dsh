import { describe, expect, it } from "vitest";
import { probe } from "../../src/kernel/commands/probe.ts";
import { collectJsonRecords, filterProbeOutput, summarizeRuntimeExceptions } from "../../src/kernel/probe/output.ts";
import { KEEP_RUNS, stashProbeOutput } from "../../src/kernel/probe/stash.ts";
import { type FakeContext, makeContext } from "./fake-context.ts";

describe("S5.2 [PROBE-JSON] bypass", () => {
	it("collects one object per prefixed line", () => {
		const harvest = collectJsonRecords(
			["[PROBE] 人读的一行", '[PROBE-JSON] {"t":"assert","pass":true}', '[PROBE-JSON] {"t":"scenario"}'].join("\n"),
		);
		expect(harvest.records).toEqual([{ t: "assert", pass: true }, { t: "scenario" }]);
		expect(harvest.broken).toEqual([]);
	});

	it("reports a malformed bypass line instead of dropping it", () => {
		// A probe emitting broken JSON is that probe's bug. Swallowing the line turns
		// it into "I emitted it and nothing arrived", which sends the reader looking
		// at the consumer rather than the producer.
		const harvest = collectJsonRecords('[PROBE-JSON] {"t":"assert"\n[PROBE-JSON] \n');
		expect(harvest.records).toEqual([]);
		expect(harvest.broken).toEqual(['{"t":"assert"', ""]);
	});

	it("treats an array or a bare scalar as broken, not as a record", () => {
		// Both parse; every consumer downstream reads fields off the record, so
		// letting one through only explodes at grading time.
		const harvest = collectJsonRecords("[PROBE-JSON] [1,2]\n[PROBE-JSON] 42\n[PROBE-JSON] null");
		expect(harvest.records).toEqual([]);
		expect(harvest.broken).toEqual(["[1,2]", "42", "null"]);
	});
});

describe("S5.2 human channel", () => {
	const NOISY = [
		"2026-09-03 10:00:00 INFO --- kd.bos.cache 初始化",
		"[PROBE] 实体 zlgd_bill 已加载",
		"java.lang.NullPointerException",
		"\tat kd.bos.form.FormView.load(FormView.java:88)",
		"\t... 12 more",
		"[PROBE-OK]",
	].join("\n");

	it("keeps [PROBE…] conclusions and folds unattributed stacks", () => {
		const filtered = filterProbeOutput(NOISY);
		expect(filtered.lines).toEqual(["[PROBE] 实体 zlgd_bill 已加载", "[PROBE-OK]"]);
		expect(filtered.dropped).toBe(3);
		expect(filtered.exceptions).toHaveLength(1);
	});

	it("keeps a stack that [PROBE-ERR] introduced", () => {
		const filtered = filterProbeOutput(
			["[PROBE-ERR] 保存失败", "kd.bos.KDException: 校验不通过", "\tat kd.bos.Op.save(Op.java:12)"].join("\n"),
		);
		expect(filtered.lines).toHaveLength(3);
		expect(filtered.dropped).toBe(0);
	});

	it("does not let a bypass line end a [PROBE-ERR] stack", () => {
		// The bypass can sit between the error line and the trace it introduced;
		// treating it as a boundary folds exactly the stack that was asked for.
		const filtered = filterProbeOutput(
			[
				"[PROBE-ERR] 崩了",
				'[PROBE-JSON] {"t":"assert"}',
				"kd.bos.KDException: x",
				"\tat kd.bos.Op.save(Op.java:1)",
			].join("\n"),
		);
		expect(filtered.lines).toEqual(["[PROBE-ERR] 崩了", "kd.bos.KDException: x", "\tat kd.bos.Op.save(Op.java:1)"]);
	});

	it("多行异常消息的逐项明细留在人读通道里，栈里重印的那份不重复（2026-09-15 AddFieldProbe 复盘 §3.6）", () => {
		// 真机形状：探针用一个异常一次列全所有问题，宿主先打 [PROBE-ERR] + toString()，
		// 再 printStackTrace 把同一段消息印第二遍。以前第一行之后的明细全被吃掉，
		// 后面的栈还被记成「未归属的运行时异常」。
		const message = [
			"java.lang.IllegalStateException: 这一批有 2 处问题，一个字都没写：",
			"  - ADD_FIELDS 第 1 条：decimal 缺 <Scale>，字段会建成半残的",
			"  - ADD_FIELDS 第 2 条：decimal 缺 <Scale>，字段会建成半残的",
		];
		const filtered = filterProbeOutput(
			[
				"[PROBE] convertToDesignMeta 通过，产出 4 份设计态",
				`[PROBE-ERR] ${message[0]}`,
				message[1],
				message[2],
				...message,
				"\tat AddFieldProbe.run(AddFieldProbe.java:172)",
				"\tat sun.reflect.NativeMethodAccessorImpl.invoke0(Native Method)",
				"2026-09-15 10:30:58 INFO --- kd.bos.cache 关闭",
			].join("\n"),
		);
		expect(filtered.lines).toEqual([
			"[PROBE] convertToDesignMeta 通过，产出 4 份设计态",
			`[PROBE-ERR] ${message[0]}`,
			message[1],
			message[2],
			message[0],
			"\tat AddFieldProbe.run(AddFieldProbe.java:172)",
			"\tat sun.reflect.NativeMethodAccessorImpl.invoke0(Native Method)",
		]);
		// 探针自己抛的异常不是背景噪声，不能进噪声账。
		expect(filtered.exceptions).toEqual([]);
		expect(filtered.dropped).toBe(0);
	});

	it("[PROBE-ERR] 的栈帧开始以后，新出现的文本行照旧是边界", () => {
		const filtered = filterProbeOutput(
			[
				"[PROBE-ERR] 崩了",
				"kd.bos.KDException: x",
				"\tat kd.bos.Op.save(Op.java:1)",
				"随后打的一行",
				"java.lang.NullPointerException",
				"\tat kd.bos.Other.run(Other.java:9)",
			].join("\n"),
		);
		// 那一行本身认不出是平台的，所以留下；它之后的栈不再算 [PROBE-ERR] 带出来的。
		expect(filtered.lines).toEqual([
			"[PROBE-ERR] 崩了",
			"kd.bos.KDException: x",
			"\tat kd.bos.Op.save(Op.java:1)",
			"随后打的一行",
		]);
		expect(filtered.exceptions).toHaveLength(1);
	});

	it("says folding is not a claim that the stacks were irrelevant", () => {
		const filtered = filterProbeOutput(NOISY);
		const summary = summarizeRuntimeExceptions(filtered.exceptions, filtered.dropped);
		expect(summary[0]).toContain("这不等于已证明与本次验证无关");
	});

	it("被折叠的异常仍然交出最里层那几帧（zlgd_ygpt2.0 复盘 §三.2）", () => {
		// 真机上折叠只剩一行「NullPointerException」，没有一个 at 帧、没有 Caused by 归属，
		// 于是分不清是平台、校验器还是本次插件的问题，也没有下一步可照抄 —— 按熔断规则只能停。
		// 类名不带地址不是结论。
		const out = [
			"2026-09-14 10:00:00 ERROR --- kd.bos.Op 执行失败",
			"kd.bos.KDException: 操作失败",
			"\tat kd.bos.service.operation.OperationServiceImpl.localInvokeOperation(OperationServiceImpl.java:187)",
			"Caused by: java.lang.NullPointerException",
			"\tat zlgd.zljy.opplugin.QTYWTDOpPlugin.setDefaultJgfs(QTYWTDOpPlugin.java:88)",
			"\tat zlgd.zljy.opplugin.QTYWTDOpPlugin.beginOperationTransaction(QTYWTDOpPlugin.java:41)",
			"\tat kd.bos.entity.plugin.OperationServicePlugInProxy.fireBeginOperationTransaction(Proxy.java:120)",
			"\tat kd.bos.entity.operate.AbstractOperate.execute(AbstractOperate.java:600)",
			"\t... 114 more",
		].join("\n");
		const filtered = filterProbeOutput(out);
		const summary = summarizeRuntimeExceptions(filtered.exceptions, filtered.dropped).join("\n");
		expect(summary).toContain("NullPointerException");
		// 真正抛的那一行，以及它的调用方 —— 归属靠它判，不靠猜。
		expect(summary).toContain("QTYWTDOpPlugin.setDefaultJgfs(QTYWTDOpPlugin.java:88)");
		expect(summary).toContain("QTYWTDOpPlugin.beginOperationTransaction");
		// 外层包装那一帧不占名额：它只说「操作失败了」，说不出在哪失败的。
		expect(summary).not.toContain("localInvokeOperation");
	});

	it("calls out missing UDF classes as a platform warning", () => {
		const out = [
			"2026-09-03 10:00:00 ERROR --- kd.bos.FunctionManage 加载失败",
			"java.lang.ClassNotFoundException: com.demo.udf.Calc",
			"\tat java.net.URLClassLoader.findClass(URLClassLoader.java:381)",
		].join("\n");
		const filtered = filterProbeOutput(out);
		const summary = summarizeRuntimeExceptions(filtered.exceptions, filtered.dropped);
		expect(summary.join("\n")).toContain("[PLATFORM-WARN]");
		expect(summary.join("\n")).toContain("com.demo.udf.Calc");
	});
});

/**
 * S37 2-A.1：按噪声删，不按白名单留。夹具照真机原始输出的形状写
 * （`~/.fast-ai-cosmic/cache/<key>/probe-runs/` 2026-09-22、09-23 的 111 份）。
 */
describe("S37 2-A.1 人读通道只删认得出的平台噪声", () => {
	const head = (level: string, logger: string, message: string, trace = "80db6356742a657e"): string =>
		`2026-09-22 17:34:48.527  ${level.padEnd(5)}  --- [cosmic-probe-hot/traceId:${trace}/time:1790069682958] ${logger.padEnd(40)} : {traceId:${trace}} ${message}`;
	const SQL_TRACE = [
		head("INFO", "DB", "----sql@secd->secd#con985----"),
		"#cost:59ms,time is:2026-09-22 17:30:10.328, include(getconnection:0ms, result_handle:0ms, connection.prepareStatement:27ms)",
		'/*ORM*/ SELECT TOP 6,0 A.fbillno "billno", A.FId "id"',
		"FROM tk_zlgd_sys_test_bill A ",
		"WHERE A.fbillno = ?",
		"ORDER BY A.FId desc",
		"'SYSJC-20260831-0001'",
		"",
	];
	const LOGBACK = [
		"17:30:21,320 |-INFO in ch.qos.logback.classic.LoggerContext[default] - Could NOT find resource [logback-test.xml]",
		"17:30:21,327 |-WARN in ch.qos.logback.classic.LoggerContext[default] - Resource [logback.xml] occurs multiple times on the classpath.",
	];
	const LOG_CONFIG = [
		"-----log.config value-----",
		'<?xml version="1.0" encoding="UTF-8"?>',
		"<configuration>",
		"\t",
		'\t<property name="LOG_DIR" value="logs"/>',
		"",
		'\t<logger name="org.apache.zookeeper" level="WARN"/>',
		"</configuration>",
		"-----log.config doConfigure success-----,fori=0,oldStatusListSize=39,newStatusListSize=73",
	];
	const PLATFORM = [
		...LOGBACK,
		...LOG_CONFIG,
		"2026-09-22 17:30:23.124  WARN   --- [zookeeper-config-checkConnection-SendThread(10.83.1.1:2181)] org.apache.zookeeper.ClientCnxn          : Session 0x0 for server 10.83.1.1/10.83.1.1:2181, unexpected error",
		head("INFO", "k.b.p.core.execute.render.PainerWork", "render page 1"),
		...SQL_TRACE,
	];

	it("临时探针不带前缀打的 20 行、插件用 logger 打的 5 行都留下，平台日志一行不留", () => {
		const bare = Array.from({ length: 20 }, (_, i) => `单据 ${i + 1}：状态=C`);
		const plugin = [
			head("INFO", "z.zljy.printplugin.MeasuringToolLookup", "量具取内部加工记录：委托单号 1 个，命中 1 个"),
			head("INFO", "z.z.printplugin.SysJcdJxsyPrintPlugin", "prtpl_21 行转列：动态列 1 个 [显微组织]"),
			head("WARN", "z.zljy.printplugin.SamplingPlaceLookup", "取样地点为空"),
			head("INFO", "z.zljy.printplugin.CorrosionDeepLookup", "腐蚀深度：2 条"),
			head("ERROR", "z.zljy.printplugin.CorrosionDeepLookup", "没取到委托单号"),
		];
		const out = [
			...PLATFORM,
			...bare.slice(0, 10),
			...SQL_TRACE,
			plugin[0],
			...SQL_TRACE,
			...plugin.slice(1),
			...bare.slice(10),
			...PLATFORM,
			"[PROBE-OK]",
		].join("\n");

		const filtered = filterProbeOutput(out, ["zlgd."]);
		for (const line of bare) expect(filtered.lines).toContain(line);
		expect(filtered.lines).toContain(
			"INFO z.zljy.printplugin.MeasuringToolLookup: 量具取内部加工记录：委托单号 1 个，命中 1 个",
		);
		expect(filtered.lines.filter((line) => /printplugin/.test(line))).toHaveLength(5);
		expect(filtered.lines).toHaveLength(20 + 5 + 1);
		const text = filtered.lines.join("\n");
		for (const noise of [
			"#cost",
			"SELECT",
			"SYSJC-20260831-0001",
			"ClientCnxn",
			"logback",
			"configuration",
			"PainerWork",
		]) {
			expect(text).not.toContain(noise);
		}
	});

	it("不知道本工程包名时，插件日志也留：认不出是平台的就不删", () => {
		const filtered = filterProbeOutput(
			[head("INFO", "z.zljy.printplugin.MeasuringToolLookup", "命中 1 个"), ...SQL_TRACE].join("\n"),
		);
		expect(filtered.lines).toEqual(["INFO z.zljy.printplugin.MeasuringToolLookup: 命中 1 个"]);
	});

	it("留下的日志行去掉时间、线程和请求 id：同样的话两次运行比得出一样", () => {
		const first = filterProbeOutput(head("INFO", "z.zljy.X", "命中 1 个", "aaaa1111"));
		const second = filterProbeOutput(
			head("INFO", "z.zljy.X", "命中 1 个", "bbbb2222").replace("17:34:48.527", "18:01:02.003"),
		);
		expect(first.lines).toEqual(second.lines);
	});

	it("缩写有歧义时按本工程包名认；本工程包名本身是平台根时不作数", () => {
		const own = head("INFO", "c.q.plugin.BillPlugin", "本工程");
		const kd = head("INFO", "k.b.p.core.execute.ExecuteEngine", "平台");
		expect(filterProbeOutput(own).lines).toEqual([]);
		expect(filterProbeOutput(own, ["cqjt."]).lines).toEqual(["INFO c.q.plugin.BillPlugin: 本工程"]);
		expect(filterProbeOutput(kd, ["kd."]).lines).toEqual([]);
	});

	it("被 logback 从左截断的 logger 名算平台的，连同它的续行", () => {
		// 真机：`kd.bos.dataentity…` 缩写后仍超 40 列，被截成 `b.o.d.…`，根包没了。
		const filtered = filterProbeOutput(
			[
				head("INFO", "b.o.d.DataEntityLocalCacheCleanupManager", "Cache cleanup stats [before]: bdType=5,"),
				" subTypeTop10=[zlgd_jylx_wtd[masterid,name,number]-286183130(45)=23], ",
				"",
				head("INFO", ".w.e.i.c.t.ApprovalRecordOptimizationCmd", "审批记录，businessKey：2574191954506045440"),
			].join("\n"),
			["zlgd."],
		);
		expect(filtered.lines).toEqual([]);
	});

	it("未归属异常的消息续行算噪声，栈帧之后探针自己打的行照旧留下", () => {
		// 真机 TplNameScan：平台把 RequestContext、SQL 塞进异常消息，跟在异常首行后面、第一条 at 前面。
		const filtered = filterProbeOutput(
			[
				head("ERROR", "DB", "ksql disable select *"),
				"RequestContext: tenantId=ierp, accountId=1955049620312691712",
				"SQL: select * from t_bas_printtplinfo",
				"kd.bos.exception.KDException: ksql disable select *",
				"RequestContext: tenantId=ierp, accountId=1955049620312691712",
				"SQL: select * from t_bas_printtplinfo",
				"Parameters: []",
				"\tat kd.bos.db.ExceptionWrapper.wrapSQLException(ExceptionWrapper.java:261)",
				"\t... 20 common frames omitted",
				"改用 t_bas_printtplinfo 的列清单：12 列",
			].join("\n"),
		);
		expect(filtered.lines).toEqual(["改用 t_bas_printtplinfo 的列清单：12 列"]);
		expect(filtered.exceptions).toHaveLength(1);
		expect(filtered.exceptions[0]?.header).toContain("ksql disable select *");
		expect(filtered.dropped).toBe(3);
	});

	it("[PROBE] 行里的值带换行，后面几行跟着留下", () => {
		// 真机 PrintSim：格子值两行，第二行以前被当成「没带前缀」滤掉。
		const filtered = filterProbeOutput(
			[
				"[PROBE]   ✘ layoutcell11 期望=应力腐蚀试验机/FJ11150002",
				"涡流电导率仪/NE02211001  实际=粗糙度仪/LF02240004",
				...SQL_TRACE,
			].join("\n"),
		);
		expect(filtered.lines).toEqual([
			"[PROBE]   ✘ layoutcell11 期望=应力腐蚀试验机/FJ11150002",
			"涡流电导率仪/NE02211001  实际=粗糙度仪/LF02240004",
		]);
	});
});

const PROBE_SRC = "public class OutProbe { }";

function outFake(): FakeContext {
	const fake = makeContext({ probes: ["OutProbe"] });
	fake.fs.put(`${fake.ctx.layout.probesDir.replace(/\\/g, "/")}/OutProbe.java`, PROBE_SRC);
	fake.fs.write(
		fake.ctx.layout.serverPid,
		JSON.stringify({
			pid: 321,
			keyId: fake.ctx.runtimeKeyId,
			port: 1,
			startedAt: "",
			account: fake.ctx.config.account,
			user: fake.ctx.config.user,
		}),
	);
	fake.proc.livePids.add(321);
	return fake;
}

describe("S5.2 probe stashes its evidence", () => {
	const BODY = ["[PROBE] 开始", '[PROBE-JSON] {"t":"assert","pass":true}', "[PROBE-OK]"].join("\n");

	it("returns the bypass records and the human channel", async () => {
		const fake = outFake();
		fake.net.handler = () => ({ ok: true, text: `RESULT OK 0\n${BODY}\n` });
		const result = await probe(fake.ctx, "OutProbe");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.json.records).toEqual([{ t: "assert", pass: true }]);
		// The bypass line is not part of the human channel.
		expect(result.value.output).toBe("[PROBE] 开始\n[PROBE-OK]");
		expect(fake.fs.read(fake.ctx.layout.lastProbeOut)).toContain("[PROBE-JSON]");
	});

	it("探针直接 println 的行出现在返回里，不再另附「没带前缀被过滤」的说明（S37 2-A.1）", async () => {
		const fake = outFake();
		fake.net.handler = () => ({ ok: true, text: "RESULT OK 0\n实体标识是 zlgd_bill\n共 3 张\n[PROBE-OK]\n" });
		const result = await probe(fake.ctx, "OutProbe");
		if (!result.ok) throw new Error("probe failed");
		expect(result.value.output).toBe("实体标识是 zlgd_bill\n共 3 张\n[PROBE-OK]");
		expect(result.value.notes.join("\n")).not.toContain("前缀");
	});

	it("rewrites the bypass file even when the run produced no records", async () => {
		// Leaving the previous file in place is how a later reader treats some other
		// probe's records as this run's result.
		const fake = outFake();
		fake.fs.write(fake.ctx.layout.lastProbeJson, JSON.stringify({ records: [{ t: "assert", pass: true }] }));
		fake.net.handler = () => ({ ok: true, text: "RESULT OK 0\n[PROBE] 没有旁路\n" });
		const result = await probe(fake.ctx, "OutProbe");
		expect(result.ok).toBe(true);
		const stashed: unknown = JSON.parse(fake.fs.read(fake.ctx.layout.lastProbeJson));
		expect((stashed as { records: unknown[] }).records).toEqual([]);
	});

	it("返回里指的全文文件是这一次自己的，下一次运行盖不掉它（2026-09-15 AddFieldProbe 复盘 §3.6）", async () => {
		// 以前指的是 last-probe.out：读起来像「替你存好了」，下一次任何探针一跑就没了。
		// 真机上两次写探针失败的逐项原因，写复盘时已经取不回来。
		const fake = outFake();
		fake.net.handler = () => ({ ok: true, text: "RESULT OK 0\n[PROBE-ERR] 第一次：这一批有 13 处问题\n" });
		const first = await probe(fake.ctx, "OutProbe");
		fake.net.handler = () => ({ ok: true, text: "RESULT OK 0\n[PROBE] 第二次，别的问题\n" });
		const second = await probe(fake.ctx, "OutProbe");
		if (!first.ok || !second.ok) throw new Error("probe failed");

		expect(first.value.outputFile).not.toBe(fake.ctx.layout.lastProbeOut);
		expect(first.value.outputFile).not.toBe(second.value.outputFile);
		expect(fake.fs.read(first.value.outputFile)).toContain("第一次：这一批有 13 处问题");
		expect(fake.fs.read(second.value.outputFile)).toContain("第二次");
		// 「最近一次」的固定入口照旧在。
		expect(fake.fs.read(fake.ctx.layout.lastProbeOut)).toContain("第二次");
	});

	it("每次一份的副本只留最近 KEEP_RUNS 份", () => {
		const fake = outFake();
		const files: string[] = [];
		for (let run = 0; run < KEEP_RUNS + 3; run++) {
			files.push(
				stashProbeOutput(fake.ctx, { cls: "OutProbe", src: null, invocation: "probe OutProbe" }, `run ${run}`)
					.outFile,
			);
		}
		const kept = fake.fs.readDir(fake.ctx.layout.probeRuns).map((entry) => entry.name);
		expect(kept).toHaveLength(KEEP_RUNS);
		expect(fake.fs.exists(files[0] as string)).toBe(false);
		expect(fake.fs.read(files[files.length - 1] as string)).toContain(`run ${KEEP_RUNS + 2}`);
	});

	it("hands back the complete output when raw is asked for", async () => {
		const fake = outFake();
		fake.net.handler = () => ({ ok: true, text: `RESULT OK 0\n${BODY}\n` });
		const result = await probe(fake.ctx, "OutProbe", { raw: true });
		expect(result.ok && result.value.output).toContain("[PROBE-JSON]");
		expect(result.ok && result.value.outputLines.shown).toBe(result.ok ? result.value.outputLines.total : -1);
	});
});
