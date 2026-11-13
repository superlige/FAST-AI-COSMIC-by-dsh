import { describe, expect, it } from "vitest";
import { probe } from "../../src/kernel/commands/probe.ts";
import { run } from "../../src/kernel/commands/run.ts";
import { residentPort } from "../../src/kernel/probe/server.ts";
import { makeContext } from "./fake-context.ts";

function fixture() {
	const fake = makeContext({ probes: ["OpSandbox", "DataQueryProbe"], env: { JAVA_HOME: "D:/jdk8" } });
	for (const name of fake.ctx.probes)
		fake.fs.put(`${fake.ctx.layout.probesDir}/${name}.java`, `public class ${name} {}`);
	fake.fs.put("D:/jdk8/lib/tools.jar", "tools");
	fake.fs.write(
		fake.ctx.layout.serverPid,
		JSON.stringify({
			pid: 321,
			keyId: fake.ctx.runtimeKeyId,
			port: residentPort(fake.ctx),
			startedAt: "",
			account: fake.ctx.config.account,
			user: fake.ctx.config.user,
		}),
	);
	fake.proc.livePids.add(321);
	return fake;
}

const ready = { ok: true, text: "RESULT OK 0\n[PROBE] done\n" };

describe("resident execution timeout", () => {
	it.each([1, 2, 3])("op 的 %i 个场景使用有上限的执行时间，接收答复另留余量", async (count) => {
		const fake = fixture();
		const limits: number[] = [];
		const original = fake.net.request.bind(fake.net);
		fake.net.request = async (port, lines, timeoutMs) => {
			if (lines[0] === "PROBE") limits.push(timeoutMs);
			return original(port, lines, timeoutMs);
		};
		fake.net.handler = () => ready;
		const argv = ["op", "zlgd_bill", "audit", "--pk", "1", "--expect", "success=true"];
		for (let i = 1; i < count; i++) argv.push("--case", `case${i}`, "--pk", "1", "--expect", "success=true");
		const result = await run(fake.ctx, argv);
		expect(result.ok).toBe(true);
		const ms = Math.min(10, count * 5) * 60_000;
		expect(fake.net.requests.find((req) => req.lines[0] === "PROBE")?.lines).toContain(`timeoutMs=${ms}`);
		expect(limits).toEqual([ms + 30_000]);
	});

	it.each(["timeout", "ECONNRESET"])("操作发出后 %s：不重新提交、不另起冷进程", async (why) => {
		const fake = fixture();
		fake.net.handler = (_port, lines) => (lines[0] === "PROBE" ? { ok: false, why } : ready);
		const result = await run(fake.ctx, ["op", "zlgd_bill", "audit", "--pk", "1", "--expect", "success=true"]);
		expect(!result.ok && result.error.code).toBe("PROBE_WRITE_UNCERTAIN");
		expect(fake.net.requests.filter((req) => req.lines[0] === "PROBE")).toHaveLength(1);
		expect(fake.proc.runsOf("java")).toHaveLength(0);
		expect(fake.proc.detached).toHaveLength(0);
	});

	it("收到执行超时：保留本次错误，不立刻更换进程或重放", async () => {
		const fake = fixture();
		fake.net.handler = () => ({ ok: true, text: "RESULT TIMEOUT 1\n[PROBE-ERR] 探针超过 300 秒未结束\n" });
		const result = await probe(fake.ctx, "DataQueryProbe");
		expect(result.ok && result.value.exitCode).toBe(1);
		expect(result.ok && result.value.notes.join()).toContain("没有自动重跑");
		expect(fake.net.requests.filter((req) => req.lines[0] === "PROBE")).toHaveLength(1);
		expect(fake.proc.runsOf("java")).toHaveLength(0);
		expect(fake.proc.detached).toHaveLength(0);
	});

	it.each([1, 2])("失效宿主拒绝 %i 个新请求：共用一次恢复，只执行新请求", async (count) => {
		const fake = fixture();
		let shutdown = false;
		fake.net.handler = (_port, lines) => {
			if (lines[0] === "SHUTDOWN") {
				shutdown = true;
				fake.proc.livePids.delete(321);
				return ready;
			}
			if (shutdown && fake.proc.detached.length === 0) return { ok: false, why: "ECONNREFUSED" };
			if (lines[0] === "PROBE" && fake.proc.detached.length === 0)
				return { ok: true, text: "RESULT BUSY 1\n上一个探针超时未结束\n" };
			return ready;
		};
		const results = await Promise.all(Array.from({ length: count }, () => probe(fake.ctx, "DataQueryProbe")));
		for (const result of results) {
			expect(result.ok && result.value.path).toBe("hot");
			expect(result.ok && result.value.notes.join()).toContain("上一次操作不重跑");
		}
		expect(fake.net.requests.filter((req) => req.lines[0] === "SHUTDOWN")).toHaveLength(1);
		expect(fake.proc.detached).toHaveLength(1);
		expect(fake.proc.runsOf("java")).toHaveLength(0);
	});

	it("只搭现有进程的调用不自动重启失效宿主", async () => {
		const fake = fixture();
		fake.net.handler = () => ({ ok: true, text: "RESULT BUSY 1\n上一个探针超时未结束\n" });
		const result = await probe(fake.ctx, "DataQueryProbe", { startResident: false, coldFallback: false });
		expect(result.ok).toBe(false);
		expect(fake.net.requests.some((req) => req.lines[0] === "SHUTDOWN")).toBe(false);
		expect(fake.proc.detached).toHaveLength(0);
	});
});
