/**
 * S33：编译完那句「下次运行要等多久」按常驻 JVM 实际的换类方式说，数是真机量的。
 */

import { describe, expect, it } from "vitest";
import { hotSwapNote } from "../../src/kernel/commands/fast.ts";

describe("编译后的换类提示", () => {
	it("JDK 自带换法：加字段（包括常量）要重起，说真机量到的时长", () => {
		const note = hotSwapNote(false);
		expect(note).toContain("加字段（包括常量）");
		expect(note).toContain("重起约 60 秒");
		expect(note).toContain("打印第一次出图约 50 秒");
		expect(note).not.toContain("约 30 秒");
	});

	it("挂着 JRebel：加字段也原地换", () => {
		const note = hotSwapNote(true);
		expect(note).toContain("JRebel");
		expect(note).toContain("加字段下次用到时原地换进去");
	});
});
