import { describe, expect, it } from "vitest";
import { contentMemo } from "../../src/kernel/content-memo.ts";

describe("按文件内容记住结果", () => {
	it("内容没变就给上次的结果，内容变了、换了文件就重算", () => {
		let computed = 0;
		const lengthOf = contentMemo((file: string, text: string) => {
			computed += 1;
			return `${file}:${String(text.length)}`;
		});
		expect(lengthOf("A.java", "class A {}")).toBe("A.java:10");
		expect(lengthOf("A.java", "class A {}")).toBe("A.java:10");
		expect(computed).toBe(1);
		// 同一个文件改了内容：重算，不拿旧的
		expect(lengthOf("A.java", "class A { int x; }")).toBe("A.java:18");
		expect(computed).toBe(2);
		// 别的文件内容碰巧一样：各算各的
		expect(lengthOf("B.java", "class A { int x; }")).toBe("B.java:18");
		expect(computed).toBe(3);
		// 改回原样：按内容认，照样重算一次（只记最近一版）
		expect(lengthOf("A.java", "class A {}")).toBe("A.java:10");
		expect(computed).toBe(4);
	});
});
