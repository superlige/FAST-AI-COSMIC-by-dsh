/**
 * 第一句话以 @ 引用开头时，dsh 的占位标题是引用块标签的开头（`<cosmic-ref id="…`），
 * 模型标题没来就一直留在会话列表里。这里补写一条换回 `@名字` 的占位标题。
 */
import { describe, expect, it } from "vitest";
import { fallbackTitle, RefTitleFixer } from "../../src/dsh/session-title.ts";
import { mentionBlock, mentionPlainText } from "../../src/kernel/impact/mention.ts";

const REF = mentionBlock(
	"检验委托单.专业室加工方式",
	"demo_wtd.demo_jgfs_head",
	"字段 demo_wtd.demo_jgfs_head「专业室加工方式」，ComboField，在表头\n所在单据 demo_wtd「检验委托单」",
);
const FIRST = `${REF}当前加工方式按检验类型判断默认值，改为外部加工`;
/** dsh 用原文取的占位标题：前 5 个词、40 字节 */
const DSH_FALLBACK = '<cosmic-ref id="demo_wtd.demo_jgfs_head"';

function setup() {
	const appended: { type: string; data: { title: string; messageSeqs: number[]; source: { kind: string } } }[] = [];
	const queue: (() => void)[] = [];
	const session = {
		id: "s1",
		append(type: string, data: unknown) {
			appended.push({ type, data: data as (typeof appended)[number]["data"] });
		},
	};
	const fixer = new RefTitleFixer((run) => queue.push(run));
	const flush = () => {
		for (const run of queue.splice(0)) run();
	};
	const user = (seq: number, text: string) =>
		fixer.onEvent(session, {
			type: "user/message",
			seq,
			data: { source: { kind: "user" }, content: [{ type: "text", text }] },
		});
	const title = (seq: number, text: string, kind = "fallback", messageSeqs = [9]) =>
		fixer.onEvent(session, { type: "session/title", seq, data: { title: text, messageSeqs, source: { kind } } });
	return { fixer, appended, flush, user, title };
}

describe("引用块换回 @名字", () => {
	it("块换成 @名字，正文去掉，前后的话原样；没有引用回 null", () => {
		expect(mentionPlainText(`看下 ${REF} 为什么不显示`)).toBe("看下 @检验委托单.专业室加工方式 为什么不显示");
		expect(mentionPlainText("普通的一句话")).toBeNull();
	});

	it("名字里的引号、尖括号还原", () => {
		expect(mentionPlainText(mentionBlock('演示"单<1>', "demo_bill", "单据 demo_bill"))).toBe('@演示"单<1>');
	});

	it("占位标题和 dsh 一个取法：前 5 个词、40 字节、不截断半个字", () => {
		expect(fallbackTitle("@检验委托单.专业室加工方式当前加工方式按检验类型判断")).toBe("@检验委托单.专业室加工方式");
		expect(fallbackTitle("a b c d e f")).toBe("a b c d e");
	});
});

describe("会话标题", () => {
	it("dsh 写下标签开头的占位标题后，补写一条换回 @名字 的占位标题", () => {
		const { appended, flush, user, title } = setup();
		user(9, FIRST);
		title(16, DSH_FALLBACK);
		expect(appended).toEqual([]);
		flush();
		expect(appended).toEqual([
			{
				type: "session/title",
				data: {
					title: "@检验委托单.专业室加工方式",
					messageSeqs: [9],
					source: { kind: "fallback" },
				},
			},
		]);
	});

	it("补写之前模型标题已经到了：不写，免得盖掉它", () => {
		const { appended, flush, user, title } = setup();
		user(9, FIRST);
		title(16, DSH_FALLBACK);
		title(20, "调整专业室加工方式默认值", "provider");
		flush();
		expect(appended).toEqual([]);
	});

	it("第一句话没有引用、标题不是占位、不是第一句话起的：都不动", () => {
		const plain = setup();
		plain.user(9, "销售订单上的这个字段");
		plain.title(16, "销售订单上的这个字段");
		plain.flush();
		expect(plain.appended).toEqual([]);

		const provider = setup();
		provider.user(9, FIRST);
		provider.title(16, DSH_FALLBACK, "provider");
		provider.flush();
		expect(provider.appended).toEqual([]);

		const other = setup();
		other.user(9, FIRST);
		other.title(16, DSH_FALLBACK, "fallback", [30]);
		other.flush();
		expect(other.appended).toEqual([]);
	});

	it("会话关掉后不再写", () => {
		const { fixer, appended, flush, user, title } = setup();
		user(9, FIRST);
		title(16, DSH_FALLBACK);
		fixer.forget("s1");
		flush();
		expect(appended).toEqual([]);
	});
});
