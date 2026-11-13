/**
 * 同一个 java 只问一次版本；问不出来时把 java 自己的话带回去。
 *
 * 真机 2026-09-26、09-27：每次工具调用重开工程都跑一次 `java -version`，内存紧时这个 JVM 起不来，
 * 会话中途连续五六次报「问不出 JDK 版本，把 JAVA_HOME 指向 JDK 8」——JDK 一点没变，java 的报错被丢掉，
 * 模型照着核对 JAVA_HOME、PATH，都对，只能停工。
 */
import { describe, expect, it } from "vitest";
import type { JdkProbe } from "../../src/runtime/fingerprint.ts";
import { type JdkMemory, nodeJdkProbe, rememberingJdkProbe } from "../../src/runtime/jdk-probe.ts";
import { FakeProcess } from "../kernel/fake-context.ts";

const BANNER = 'java version "1.8.0_191"\nJava(TM) SE Runtime Environment (build 1.8.0_191-b12)';

describe("JDK 版本只问一次", () => {
	it("同一个 java（路径、修改时间、大小都没变）第二次不再起进程", async () => {
		const proc = new FakeProcess();
		proc.handler = () => ({ status: 0, stderr: BANNER });
		const memory: JdkMemory = new Map();
		const probe = rememberingJdkProbe(nodeJdkProbe(proc, {}, "D:/proj"), memory, () => "D:/jdk8/bin/java.exe|1|2");
		expect((await probe.describe("D:/jdk8"))?.version).toBe("1.8.0_191");
		// 第二次：这时候 JVM 起不来也不要紧
		proc.handler = () => ({ status: 1, stderr: "Error occurred during initialization of VM" });
		expect((await probe.describe("D:/jdk8"))?.version).toBe("1.8.0_191");
		expect(proc.runsOf("java")).toHaveLength(1);
	});

	it("java 换了（戳变了）就重新问；找不到可执行文件不记，每次都问", async () => {
		const proc = new FakeProcess();
		proc.handler = () => ({ status: 0, stderr: BANNER });
		let stamp: string | null = "a";
		const probe = rememberingJdkProbe(nodeJdkProbe(proc, {}, "D:/proj"), new Map(), () => stamp);
		await probe.describe("D:/jdk8");
		stamp = "b";
		await probe.describe("D:/jdk8");
		stamp = null;
		await probe.describe("D:/jdk8");
		await probe.describe("D:/jdk8");
		expect(proc.runsOf("java")).toHaveLength(4);
	});

	it("问不出来不记，下次照问", async () => {
		let calls = 0;
		const inner: JdkProbe = {
			describe: async () => {
				calls += 1;
				return calls === 1 ? null : { version: "1.8.0_191", build: null };
			},
		};
		const probe = rememberingJdkProbe(inner, new Map(), () => "s");
		expect(await probe.describe("D:/jdk8")).toBeNull();
		expect((await probe.describe("D:/jdk8"))?.version).toBe("1.8.0_191");
	});
});

describe("问不出版本时带回 java 自己的话", () => {
	it("退出码和前几行输出", async () => {
		const proc = new FakeProcess();
		proc.handler = () => ({
			status: 1,
			stderr:
				"Error occurred during initialization of VM\r\nCould not reserve enough space for object heap\r\n\r\nx\r\ny\r\n",
		});
		const probe = nodeJdkProbe(proc, {}, "D:/proj");
		expect(await probe.describe("D:/jdk8")).toBeNull();
		expect(probe.lastFailure?.()).toBe(
			"退出码 1：Error occurred during initialization of VM | Could not reserve enough space for object heap | x",
		);
	});

	it("成功之后清掉上一次的失败", async () => {
		const proc = new FakeProcess();
		proc.handler = () => ({ status: 1, stderr: "" });
		const probe = nodeJdkProbe(proc, {}, "D:/proj");
		await probe.describe("D:/jdk8");
		expect(probe.lastFailure?.()).toBe("退出码 1，没有输出");
		proc.handler = () => ({ status: 0, stderr: BANNER });
		await probe.describe("D:/jdk8");
		expect(probe.lastFailure?.()).toBeNull();
	});
});
