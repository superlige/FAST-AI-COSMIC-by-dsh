import { describe, expect, it } from "vitest";
import {
	forgetRepeats,
	normalizeOutput,
	recordRepeat,
	repeatBlocked,
	repeatFingerprint,
	repeatLabel,
} from "../../src/kernel/probe/repeat.ts";
import { makeContext } from "./fake-context.ts";

const KEY = {
	cls: "OpMetaProbe",
	sourceDigest: "src-1",
	env: { OP_ENTITY: "zlgd_lssy_qzxy" },
} as const;

/** 真机那三次一模一样的输出（`操作 共 2`）。 */
const SAME = "[PROBE] --- 操作 共 2\n[PROBE]   close\n[PROBE]   zlgd_newentry\n";

function ask(ctx: Parameters<typeof recordRepeat>[0], output: string, file = "D:/out/1.out"): void {
	recordRepeat(ctx, KEY, { output, outFile: file });
}

describe("同一个问题问第三遍", () => {
	it("头两遍照跑，第三遍拦下来并说出上次答案在哪", () => {
		const { ctx } = makeContext();
		expect(repeatBlocked(ctx, KEY)).toBeNull();
		ask(ctx, SAME);
		// 第二遍还不拦：一次输出证明不了「答案不会变」，要两次互相印证
		expect(repeatBlocked(ctx, KEY)).toBeNull();
		ask(ctx, SAME, "D:/out/2.out");

		const blocked = repeatBlocked(ctx, KEY);
		expect(blocked).not.toBeNull();
		expect(blocked?.calls).toBe(2);
		// 拦下来必须带上原文路径，否则只是换一种卡住
		expect(blocked?.outFile).toBe("D:/out/2.out");
	});

	it("输出变了就重新数：结论正在动的探针永远不会被拦", () => {
		const { ctx } = makeContext();
		ask(ctx, SAME);
		ask(ctx, SAME);
		expect(repeatBlocked(ctx, KEY)).not.toBeNull();
		// 同样的问题这次答出了别的：说明它会变，账从头数
		ask(ctx, `${SAME}[PROBE]   zlgd_confirm\n`);
		expect(repeatBlocked(ctx, KEY)).toBeNull();
	});

	it("换一个入参就是另一个问题", () => {
		const { ctx } = makeContext();
		ask(ctx, SAME);
		ask(ctx, SAME);
		expect(repeatBlocked(ctx, KEY)).not.toBeNull();
		expect(repeatBlocked(ctx, { ...KEY, env: { OP_ENTITY: "zlgd_sys_test_bill" } })).toBeNull();
	});

	it("探针源码改过也算另一个问题", () => {
		const { ctx } = makeContext();
		ask(ctx, SAME);
		ask(ctx, SAME);
		expect(repeatBlocked(ctx, { ...KEY, sourceDigest: "src-2" })).toBeNull();
	});

	it("隔久了不算：共享环境里别人可能改过东西", () => {
		const { ctx, clock } = makeContext();
		ask(ctx, SAME);
		ask(ctx, SAME);
		expect(repeatBlocked(ctx, KEY)).not.toBeNull();
		clock.advance(31 * 60 * 1000);
		expect(repeatBlocked(ctx, KEY)).toBeNull();
	});

	it("编译过、写过库就清账——改完代码重跑同一条用例正是最该跑的一次", () => {
		const { ctx } = makeContext();
		ask(ctx, SAME);
		ask(ctx, SAME);
		expect(repeatBlocked(ctx, KEY)).not.toBeNull();
		forgetRepeats(ctx);
		expect(repeatBlocked(ctx, KEY)).toBeNull();
	});

	it("指纹不看入参的先后顺序，也不看每次都变的那几个名字", () => {
		// 指纹不稳 = 这套机制静默地什么都不做，所以这条比它看起来重要
		const a = repeatFingerprint({ cls: "P", sourceDigest: "d", env: { A: "1", B: "2" } });
		const b = repeatFingerprint({ cls: "P", sourceDigest: "d", env: { B: "2", A: "1" } });
		expect(a).toBe(b);
		const withConfirmation = repeatFingerprint({
			cls: "P",
			sourceDigest: "d",
			env: { A: "1", B: "2", COSMIC_CONFIRMATION: "c-9" },
		});
		expect(withConfirmation).toBe(a);
	});

	it("账本自己打开也看得懂：标签带探针名和点了题的入参", () => {
		expect(repeatLabel(KEY)).toBe("OpMetaProbe OP_ENTITY=zlgd_lssy_qzxy");
	});

	it("耗时和页面 id 不算「答案变了」，行数条数算", () => {
		// 不抹掉这两样，这套机制在最贵的探针上会静默失效：run form 的输出里带着
		// activate OK 23339ms 和 pageId=formsim_31425621226900，两次跑同一条用例永远不同。
		const a = ["[PROBE] activate OK 23339ms", "[PROBE] pageId=formsim_31425621226900", "[PROBE] 命中 37 条"].join(
			"\n",
		);
		const b = ["[PROBE] activate OK 18022ms", "[PROBE] pageId=formsim_98765432100000", "[PROBE] 命中 37 条"].join(
			"\n",
		);
		const fewer = b.replace("37 条", "36 条");
		expect(normalizeOutput(a)).toBe(normalizeOutput(b));
		expect(normalizeOutput(b)).not.toBe(normalizeOutput(fewer));

		const { ctx } = makeContext();
		ask(ctx, a);
		ask(ctx, b);
		expect(repeatBlocked(ctx, KEY)).not.toBeNull();
	});

	it("账本坏了当没有，不把正在跑的那次弄挂", () => {
		const { ctx, fs } = makeContext();
		ask(ctx, SAME);
		ask(ctx, SAME);
		const file = `${ctx.layout.workDir}/repeat/${ctx.runtimeKeyId.replace(/[^\w.-]+/g, "_")}.json`;
		fs.write(file, "{ 这不是 JSON");
		expect(repeatBlocked(ctx, KEY)).toBeNull();
	});
});
