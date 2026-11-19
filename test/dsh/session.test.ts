/**
 * 一个 dsh 进程里多个会话（桌面、网页）：每个会话一份状态，互不串；会话关掉就删；压缩之后「说过」的账清空。
 */
import { describe, expect, it } from "vitest";
import { SessionStore } from "../../src/dsh/session.ts";

describe("每个会话一份状态", () => {
	it("两个会话改的文件、跑的断言互不串", () => {
		const store = new SessionStore<unknown>();
		const a = store.of("session-a");
		const b = store.of("session-b");
		a.noteEdited("D:/demo/A.java");
		a.runs.push({
			at: "t",
			argv: ["op", "demo_bill", "save"],
			kind: "op",
			target: "demo_bill",
			exitCode: 0,
			passed: 1,
			failed: 0,
			outputFile: null,
		});
		expect(store.of("session-a")).toBe(a);
		expect([...b.files]).toEqual([]);
		expect(b.runs).toEqual([]);
		expect(b.factsRevision).toBe(0);
	});

	it("会话关掉就删，再来是一份新的", () => {
		const store = new SessionStore<unknown>();
		store.of("session-a").noteEdited("D:/demo/A.java");
		store.drop("session-a");
		expect(store.peek("session-a")).toBeUndefined();
		expect([...store.of("session-a").files]).toEqual([]);
	});

	it("压缩之后清掉「说过」的账，改过的文件和跑过的断言留着", () => {
		const store = new SessionStore<unknown>();
		const session = store.of("session-a");
		session.noteEdited("D:/demo/A.java");
		session.probesExplained.add("MetaProbe");
		session.capsulesSaid.add("digest");
		session.forgetSaid();
		expect(session.probesExplained.size).toBe(0);
		expect(session.capsulesSaid.size).toBe(0);
		expect([...session.files]).toEqual(["D:/demo/A.java"]);
	});
});
