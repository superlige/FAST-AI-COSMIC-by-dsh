import { describe, expect, it } from "vitest";
import { createReadLedger, forgetAllReads, noteRead } from "../../src/agent/tools/read-ledger.ts";

const FILE = "D:/project/src/TestBillLSSYFormPlugin.java";

/** 一份 1,452 行的假源码，行内容各不相同（真实文件也是这样）。 */
const source = Array.from({ length: 1452 }, (_, index) => `    // 第 ${String(index + 1)} 行，${"x".repeat(30)}`);

/** pi 的 read 返回：正文 + 末尾那行方括号提示。 */
function readOut(from: number, count: number): string {
	const to = Math.min(source.length, from + count - 1);
	const body = source.slice(from - 1, to).join("\n");
	const rest = source.length - to;
	return rest > 0
		? `${body}\n\n[${String(rest)} more lines in file. Use offset=${String(to + 1)} to continue.]`
		: body;
}

describe("文件读取账", () => {
	it("已经原样给过的行段，第二次只回一句话", () => {
		const ledger = createReadLedger();
		expect(noteRead(ledger, { path: FILE, text: readOut(1, 969) }).repeat).toBe(false);
		expect(noteRead(ledger, { path: FILE, offset: 969, text: readOut(969, 500) }).repeat).toBe(false);

		// 真机那 11 次「重读」，行段全部落在前两次给过的范围里。
		for (const [offset, limit] of [
			[930, 150],
			[660, 160],
			[1080, 130],
			[840, 95],
			[180, 80],
			[1263, 85],
		] as const) {
			const verdict = noteRead(ledger, { path: FILE, offset, text: readOut(offset, limit) });
			expect(verdict.repeat).toBe(true);
			expect(verdict.note).toContain(`第 ${String(offset)}–${String(offset + limit - 1)} 行`);
			expect(verdict.note).toContain("内容一个字没变");
		}
	});

	it("只要有一行没给过，整段照常发", () => {
		const ledger = createReadLedger();
		noteRead(ledger, { path: FILE, offset: 100, text: readOut(100, 50) });
		// 149 行给过，150 行没给过。
		expect(noteRead(ledger, { path: FILE, offset: 140, text: readOut(140, 20) }).repeat).toBe(false);
	});

	it("文件内容变了就照常发，并且把旧记录换掉", () => {
		const ledger = createReadLedger();
		noteRead(ledger, { path: FILE, offset: 1, text: readOut(1, 400) });
		const edited = [...source];
		edited[199] = "    // 这一行被改过了，后面接了一长串新内容 ~~~~~~~~~~~~~~~~~~~~~~~";
		const changed = `${edited.slice(0, 400).join("\n")}\n\n[1052 more lines in file. Use offset=401 to continue.]`;
		expect(noteRead(ledger, { path: FILE, offset: 1, text: changed }).repeat).toBe(false);
		// 换过之后，按新内容再读一次才算「给过」。
		expect(noteRead(ledger, { path: FILE, offset: 1, text: changed }).repeat).toBe(true);
	});

	it("末尾那行「还有 N 行」不参与比对", () => {
		const ledger = createReadLedger();
		// 同一段正文，两次的方括号提示不一样（读的范围不同导致剩余行数不同）。
		const first = `${source.slice(0, 300).join("\n")}\n\n[1152 more lines in file. Use offset=301 to continue.]`;
		const second = `${source.slice(0, 300).join("\n")}\n\n[Showing lines 1-300 of 1452 (50.0KB limit). Use offset=301 to continue.]`;
		expect(noteRead(ledger, { path: FILE, text: first }).repeat).toBe(false);
		expect(noteRead(ledger, { path: FILE, text: second }).repeat).toBe(true);
	});

	it("edit 插了几行把行号撑开：撑开的那一段照常发，没动的那一段仍算给过", () => {
		const ledger = createReadLedger();
		noteRead(ledger, { path: FILE, offset: 1, text: readOut(1, 600) });
		// 第 300 行处插进 5 行，300 行往后全部错位。
		const shifted = [
			...source.slice(0, 299),
			...Array.from({ length: 5 }, (_, i) => `    // 新插入 ${String(i)}`),
			...source.slice(299),
		];
		const after = `${shifted.slice(299, 599).join("\n")}\n\n[658 more lines in file. Use offset=600 to continue.]`;
		expect(noteRead(ledger, { path: FILE, offset: 300, text: after }).repeat).toBe(false);
		// 插入点之上没被动过，仍然是「给过了」。
		expect(noteRead(ledger, { path: FILE, offset: 1, text: readOut(1, 200) }).repeat).toBe(true);
	});

	it("上下文被压缩就整本清空——上文里那份已经不在了", () => {
		const ledger = createReadLedger();
		noteRead(ledger, { path: FILE, offset: 1, text: readOut(1, 400) });
		noteRead(ledger, { path: "D:/project/Other.java", text: readOut(1, 400) });
		forgetAllReads(ledger);
		expect(noteRead(ledger, { path: FILE, offset: 1, text: readOut(1, 400) }).repeat).toBe(false);
	});

	it("短读取不记账——省下的还不够那句提示长", () => {
		const ledger = createReadLedger();
		const tiny = "line one\nline two";
		expect(noteRead(ledger, { path: FILE, text: tiny }).repeat).toBe(false);
		expect(noteRead(ledger, { path: FILE, text: tiny }).repeat).toBe(false);
	});

	it("不同文件各记各的", () => {
		const ledger = createReadLedger();
		noteRead(ledger, { path: FILE, offset: 1, text: readOut(1, 400) });
		expect(noteRead(ledger, { path: "D:/project/Other.java", offset: 1, text: readOut(1, 400) }).repeat).toBe(false);
	});

	it("提示里说得出是第几次调用给的", () => {
		const ledger = createReadLedger();
		noteRead(ledger, { path: FILE, offset: 1, text: readOut(1, 969) });
		const verdict = noteRead(ledger, { path: FILE, offset: 660, text: readOut(660, 160) });
		expect(verdict.note).toContain("第 1 次 read 给过第 1–969 行");
	});
});
