import { describe, expect, it } from "vitest";
import { noiseFingerprint, recordNoise, touchesOwnCode } from "../../src/kernel/probe/noise.ts";
import { filterProbeOutput, summarizeRuntimeExceptions } from "../../src/kernel/probe/output.ts";
import { makeContext } from "./fake-context.ts";

/** The shape a Cosmic cold start prints around a swallowed platform exception. */
function platformNoise(requestId: string): string {
	return [
		`2026-09-14 11:11:02 ERROR --- [http-nio-8080-exec-3] kd.bos.license.LicenseGrayConfigHelper req=${requestId}`,
		"java.lang.NullPointerException",
		"\tat kd.bos.license.LicenseGrayConfigHelper.getGrayConfig(LicenseGrayConfigHelper.java:88)",
		"\tat kd.bos.license.LicenseService.check(LicenseService.java:41)",
		"\t... 42 more",
		"[PROBE-OK]",
	].join("\n");
}

describe("同一环境上的老噪声", () => {
	it("同一条异常换了请求 id 也认得出是同一条", () => {
		// 指纹不稳就等于这个机制根本没启用：每次都是新指纹，账永远记不到 2。
		const a = filterProbeOutput(platformNoise("a1b2c3d4e5")).exceptions[0];
		const b = filterProbeOutput(platformNoise("9f8e7d6c5b")).exceptions[0];
		expect(a).toBeDefined();
		expect(b).toBeDefined();
		expect(noiseFingerprint(a as never)).toBe(noiseFingerprint(b as never));
	});

	it("第一次照常展开，第二次才降级成一句「老面孔」", () => {
		const { ctx } = makeContext();
		const first = filterProbeOutput(platformNoise("a1"));
		const firstNotes = summarizeRuntimeExceptions(
			first.exceptions,
			first.dropped,
			recordNoise(ctx, first.exceptions),
		).join("\n");
		// 第一次见到：全套 [RUNTIME-WARN] 加调用点，那是这次唯一值得读的东西
		expect(firstNotes).toContain("[RUNTIME-WARN]");
		expect(firstNotes).toContain("LicenseGrayConfigHelper.getGrayConfig");
		expect(firstNotes).not.toContain("老面孔");

		const second = filterProbeOutput(platformNoise("b2"));
		const secondNotes = summarizeRuntimeExceptions(
			second.exceptions,
			second.dropped,
			recordNoise(ctx, second.exceptions),
		).join("\n");
		expect(secondNotes).toContain("老面孔");
		expect(secondNotes).toContain("此前 1 次运行都带着它");
		expect(secondNotes).not.toContain("[RUNTIME-WARN]");
		// 降级不是宣布无关：这句话必须还在。
		expect(secondNotes).toContain("不等于已证明与本次无关");
	});

	it("栈里有本工程的类就永远不降级", () => {
		const { ctx } = makeContext();
		const own = [
			"2026-09-14 11:11:02 ERROR --- kd.bos.form.FormView",
			"java.lang.NullPointerException",
			"\tat zlgd.zljy.opplugin.BzwzStandardValueHistoryOp.archiveRows(BzwzStandardValueHistoryOp.java:120)",
			"[PROBE-OK]",
		].join("\n");
		const groups = filterProbeOutput(own).exceptions;
		expect(touchesOwnCode(groups[0] as never, ["zlgd."])).toBe(true);
		recordNoise(ctx, groups, ["zlgd."]);
		const again = filterProbeOutput(own);
		const notes = summarizeRuntimeExceptions(
			again.exceptions,
			again.dropped,
			recordNoise(ctx, again.exceptions, ["zlgd."]),
		).join("\n");
		// 「它一直这样」正是掩盖真缺陷的那句话，所以这一条每次都要摊开。
		expect(notes).toContain("[RUNTIME-WARN]");
		expect(notes).not.toContain("老面孔");
	});

	it("换一个 RuntimeKey 就从头数，不拿别的环境的历史回答这个环境", () => {
		const one = makeContext({ runtimeKeyId: "v0.0.0-aaaa" });
		const first = filterProbeOutput(platformNoise("a1"));
		recordNoise(one.ctx, first.exceptions);
		// 同一个工程目录、另一个账套：account set 换了，背景异常也换了一批。
		const other = makeContext({ runtimeKeyId: "v0.0.0-bbbb" });
		for (const [path, file] of one.fs.files) other.fs.put(path, file.content);
		const second = filterProbeOutput(platformNoise("b2"));
		const notes = summarizeRuntimeExceptions(
			second.exceptions,
			second.dropped,
			recordNoise(other.ctx, second.exceptions),
		).join("\n");
		expect(notes).not.toContain("老面孔");
	});

	it("FunctionManage 那条结论永远保留，只是补一句「这个环境一直如此」", () => {
		const { ctx } = makeContext();
		const udf = [
			"2026-09-14 11:11:02 ERROR --- kd.bos.func.FunctionManage 加载函数类失败",
			"java.lang.ClassNotFoundException: kd.bos.ext.mmc.func.GetWarningParam",
			"\tat java.net.URLClassLoader.findClass(URLClassLoader.java:382)",
			"[PROBE-OK]",
		].join("\n");
		const first = filterProbeOutput(udf);
		recordNoise(ctx, first.exceptions);
		const second = filterProbeOutput(udf);
		const notes = summarizeRuntimeExceptions(
			second.exceptions,
			second.dropped,
			recordNoise(ctx, second.exceptions),
		).join("\n");
		// 它是一条**有条件的结论**，不是原始噪声：第十二次仍然成立，所以不折叠。
		expect(notes).toContain("[PLATFORM-WARN]");
		expect(notes).toContain("本次规则结果不能作为验收依据");
		expect(notes).toContain("这个环境一直如此");
		expect(notes).toContain("kd.bos.ext.mmc.func.GetWarningParam");
	});

	it("同一次运行里打印两遍的异常，第一次出现时不说成老面孔", () => {
		// 09-22 第三份样本第 72 次：造数撞主键，同一条异常一次运行里打了两遍，
		// 第二遍查到第一遍刚记的账，返回写「此前 1 次运行都带着它」，模型当成背景噪声重试
		const { ctx } = makeContext();
		const duplicate = (key: string): string =>
			[
				"2026-09-22 17:29:40 ERROR --- [main] kd.bos.dataentity.OrmDao",
				`kd.bos.exception.KDException: Duplicate entry '${key}' for key 'tk_zlgd_sys_test_bill.PRIMARY'`,
				"\tat kd.bos.dataentity.OrmDao.save(OrmDao.java:212)",
				"\tat kd.bos.servicehelper.SaveServiceHelper.save(SaveServiceHelper.java:61)",
			].join("\n");
		const run = [duplicate("2574206689439955968"), duplicate("2574206689439955968"), "[PROBE-OK]"].join("\n");

		const first = filterProbeOutput(run);
		expect(first.exceptions.length).toBe(2);
		const firstNotes = summarizeRuntimeExceptions(
			first.exceptions,
			first.dropped,
			recordNoise(ctx, first.exceptions),
		).join("\n");
		expect(firstNotes).not.toContain("老面孔");
		expect(firstNotes).toContain("Duplicate entry");

		// 下一次运行才算见过，而且一次运行只记一次
		const second = filterProbeOutput(run.replaceAll("2574206689439955968", "2574206956910721024"));
		const secondNotes = summarizeRuntimeExceptions(
			second.exceptions,
			second.dropped,
			recordNoise(ctx, second.exceptions),
		).join("\n");
		expect(secondNotes).toContain("此前 1 次运行都带着它");
	});

	it("没有账本时的行为跟以前一模一样", () => {
		const filtered = filterProbeOutput(platformNoise("a1"));
		const notes = summarizeRuntimeExceptions(filtered.exceptions, filtered.dropped).join("\n");
		expect(notes).toContain("[RUNTIME-WARN]");
		expect(notes).not.toContain("老面孔");
	});
});
