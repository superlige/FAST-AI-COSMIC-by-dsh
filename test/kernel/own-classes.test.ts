import { describe, expect, it } from "vitest";
import { ownClassNote } from "../../src/kernel/probe/own-classes.ts";

const SOURCES: Record<string, string> = {
	"zlgd.qty.inspection.plugin.inter.systestbill.HandleReturenDataInter":
		"zlgd-hhx/src/main/java/zlgd/qty/inspection/plugin/inter/systestbill/HandleReturenDataInter.java",
	"zlgd.zljy.opplugin.TestBillOpPlugin": "zlgd-hhx/src/main/java/zlgd/zljy/opplugin/TestBillOpPlugin.java",
};
const locator = { roots: ["zlgd"], locate: (fqcn: string) => SOURCES[fqcn] ?? null };

describe("ownClassNote（S38）", () => {
	it("登记指向的类不在工程里要说出来，在的给出路径（S37 批 6 真机：旧登记指向已删的类）", () => {
		const out = [
			"[PROBE] ======== wtdwithdraw/withdraw  批量撤回委托单",
			"[PROBE]   实现类 zlgd.qty.inspection.plugin.inter.systestbill.WtdWithdrawApi",
			"[PROBE] ======== getDataByNo  实验室检测单查询",
			"[PROBE]   实现类 zlgd.qty.inspection.plugin.inter.systestbill.HandleReturenDataInter",
		].join("\n");
		expect(ownClassNote(out, locator)).toBe(
			"输出里的本工程类——本工程源码里没有：zlgd.qty.inspection.plugin.inter.systestbill.WtdWithdrawApi；" +
				"在工程里：zlgd.qty.inspection.plugin.inter.systestbill.HandleReturenDataInter → " +
				"zlgd-hhx/src/main/java/zlgd/qty/inspection/plugin/inter/systestbill/HandleReturenDataInter.java",
		);
	});

	it("平台类、日志和异常栈里的类名都不管", () => {
		const out = [
			"[PROBE]   插件 kd.bos.custom.zlgd.shared.fi.cas.webapi.ApHandleSettleWebApi  enabled=true",
			"2026-09-28 INFO zlgd.zljy.opplugin.GoneOpPlugin : started",
			"\tat zlgd.zljy.opplugin.GoneOpPlugin.beforeExecute(GoneOpPlugin.java:12)",
		].join("\n");
		expect(ownClassNote(out, locator)).toBeNull();
	});

	it("内部类按外层类找，同一个类只报一次", () => {
		const out = [
			"[PROBE]   插件 zlgd.zljy.opplugin.TestBillOpPlugin$Validator",
			"[PROBE]   插件 zlgd.zljy.opplugin.TestBillOpPlugin",
		].join("\n");
		expect(ownClassNote(out, locator)).toBe(
			"输出里的本工程类——在工程里：zlgd.zljy.opplugin.TestBillOpPlugin → zlgd-hhx/src/main/java/zlgd/zljy/opplugin/TestBillOpPlugin.java",
		);
	});

	it("多于 8 个只列前 8 个再报总数；没有本工程源码就不标", () => {
		const out = Array.from({ length: 10 }, (_, i) => `[PROBE]   实现类 zlgd.gone.Api${String(i)}`).join("\n");
		expect(ownClassNote(out, locator)).toMatch(/zlgd\.gone\.Api7 等 10 个$/);
		expect(ownClassNote(out, { roots: [], locate: () => null })).toBeNull();
	});
});
