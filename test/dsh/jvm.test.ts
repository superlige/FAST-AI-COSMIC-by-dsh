/** `/cosmic-jvm` 文字版：报数（0 也报）、标出本会话的、命令写法。 */
import { describe, expect, it } from "vitest";
import { jvmListText, parseJvmCommand } from "../../src/dsh/jvm.ts";
import type { LocalJvm } from "../../src/kernel/probe/local-jvms.ts";

const NOW = Date.parse("2026-11-15T10:00:00Z");

function jvm(partial: Partial<LocalJvm>): LocalJvm {
	return {
		kind: "probe",
		pid: 100,
		keyId: "rk1",
		cacheDir: null,
		recordFile: null,
		projectRoot: "D:\\demo\\project",
		port: 7001,
		account: null,
		user: null,
		hotSwap: null,
		startedAtMs: null,
		memoryBytes: 512 * 1024 ** 2,
		state: "ready",
		lastActiveMs: NOW - 5 * 60_000,
		lastOpenedMs: null,
		logFile: null,
		...partial,
	};
}

describe("/cosmic-jvm", () => {
	it("一个都没有也报 0", () => {
		expect(jvmListText({ jvms: [], staleRecords: [], processesListed: true }, undefined, NOW)).toBe(
			"本机 cosmic 进程：常驻 JVM 0 个，本地调试节点 0 个，共占 0 MB",
		);
	});

	it("每个进程一行，本会话工程标出来（斜杠方向、大小写不影响），给出停的写法", () => {
		const text = jvmListText(
			{
				jvms: [
					jvm({}),
					jvm({ kind: "node", pid: 200, projectRoot: "D:/other", memoryBytes: 2 * 1024 ** 3, state: "executing" }),
				],
				staleRecords: [],
				processesListed: true,
			},
			"d:/DEMO/project/",
			NOW,
		);
		expect(text).toContain("常驻 JVM 1 个，本地调试节点 1 个，共占 2.5 GB");
		expect(text).toContain(
			"- 【本会话】常驻 JVM pid 100：D:\\demo\\project，端口 7001，512 MB，空闲，上次用 5 分钟前，版本 rk1",
		);
		expect(text).toContain("- 本地调试节点 pid 200：D:/other，端口 7001，2.0 GB，正在跑");
		expect(text).toContain("/cosmic-jvm stop <pid>");
	});

	it("命令写法", () => {
		expect(parseJvmCommand("")).toEqual({ kind: "list" });
		expect(parseJvmCommand(" stop 1234 ")).toEqual({ kind: "stop", pid: 1234 });
		expect(parseJvmCommand("kill 1").kind).toBe("bad");
		expect(parseJvmCommand("stop abc").kind).toBe("bad");
	});
});
