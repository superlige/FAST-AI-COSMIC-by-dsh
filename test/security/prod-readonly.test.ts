/**
 * 生产只读通道的两条底线：
 *   1. 写语句根本到不了生产：在起读取进程、发请求之前就拒；函数只放行内置的，和自定义函数同名的也不发；
 *   2. 生产账号密码不进命令行（任务管理器看得见）、不进状态文件、不进请求，只进读取进程的环境变量。
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { prod } from "../../src/kernel/commands/prod.ts";
import type { DetachedSpec } from "../../src/kernel/ports.ts";
import { parseProdConfig } from "../../src/kernel/prod/config.ts";
import type { HttpPort } from "../../src/kernel/prod/monitor.ts";
import { prodQuery } from "../../src/kernel/prod/reader.ts";
import { makeContext } from "../kernel/fake-context.ts";

const AGENT_DIR = "D:/home/.fast-ai-cosmic";
const SECRET = "Sup3r$ecret!";
const CONFIG = {
	db: { host: "10.0.0.9", port: 8000, database: "demo_all", user: "ro_demo", password: SECRET },
};
const noHttp: HttpPort = {
	post: async () => {
		throw new Error("不该访问 monitor");
	},
};

function setup() {
	const fake = makeContext();
	const { ctx, fs, proc, net } = fake;
	fs.put(ctx.layout.javacArgs, '-cp "D:/cosmic/lib/bos-core-8.0.jar;D:/cosmic/lib/trd/opengaussjdbc-1.0.jar"\n');
	fs.put(ctx.layout.prodReaderSrc, "public class ProdReader {}");
	fs.put(join(AGENT_DIR, "prod", "prod.json"), JSON.stringify(CONFIG));
	// 读取进程起来后会写状态文件：假进程替它写
	const start = proc.startDetached.bind(proc);
	proc.startDetached = (spec: DetachedSpec) => {
		const started = start(spec);
		const state = spec.args.find((arg) => arg.startsWith("-Dprod.state="))?.slice("-Dprod.state=".length) ?? "";
		fs.put(state, JSON.stringify({ pid: started.pid, port: 5555, token: "tok", startedAt: 1 }));
		return started;
	};
	net.handler = (_port, lines) =>
		lines[1] === "ping"
			? { ok: true, text: '{"ok":true}' }
			: lines[1] === "info"
				? {
						ok: true,
						text: '{"ok":true,"version":"v","user":"ro_demo","database":"demo_all","sessionReadOnly":"on","schemas":[{"name":"demo_de","tables":10,"readable":10}],"userFunctions":["lower","p_dropidx"],"ms":1}',
					}
				: {
						ok: true,
						text: '{"ok":true,"tableSchemas":{"t_demo":[{"schema":"demo_de","readable":true}]},"columns":["fid"],"rows":[["1"]],"rowCount":1,"truncated":false,"clipped":false,"ms":3}',
					};
	return fake;
}

describe("生产只读通道", () => {
	it("写、改会话、加锁的语句在起进程、发请求之前就拒，并记一笔账", async () => {
		const { ctx, proc, net, fs } = setup();
		for (const sql of [
			"delete from t_demo",
			"update t_demo set fstatus = 'C'",
			"set session characteristics as transaction read write",
			"select 1; drop table t_demo",
			"select * from t_demo for update",
			"select p_dropidx('t_demo', 'idx_demo')",
			"select demo_de.p_alterpk('t_demo')",
		]) {
			const result = await prod(
				ctx,
				{ agentConfigDir: AGENT_DIR, http: noHttp, isv: "demo" },
				{ action: "sql", sql },
			);
			expect(result.ok, sql).toBe(false);
			if (!result.ok) expect(result.error.code, sql).toBe("PROD_SQL_REFUSED");
		}
		expect(proc.detached).toHaveLength(0);
		expect(net.requests).toHaveLength(0);
		const audit = fs.read(join(ctx.layout.evidenceDir, "prod-audit.jsonl")).trim().split("\n");
		expect(audit).toHaveLength(7);
		expect(JSON.parse(audit[0] as string)).toMatchObject({ action: "sql", ok: false });
	});

	it("密码只进读取进程的环境变量：不在命令行、状态文件、请求里", async () => {
		const { ctx, proc, net, fs } = setup();
		const parsed = parseProdConfig(JSON.stringify(CONFIG), "/c/prod.json");
		if (!parsed.ok) throw parsed.error;
		const result = await prodQuery(ctx, parsed.value, "select fid from t_demo", ["t_demo"]);
		expect(result.ok).toBe(true);
		const spec = proc.detached[0];
		expect(spec).toBeDefined();
		if (spec === undefined) return;
		const commandLine = [spec.command, ...spec.args].join(" ");
		expect(commandLine).not.toContain(SECRET);
		expect(commandLine).not.toContain("ro_demo");
		expect(spec.env.PROD_PASS).toBe(SECRET);
		expect(spec.env.PROD_USER).toBe("ro_demo");
		// 类路径只有读取程序和驱动，不带整个苍穹类路径
		const cp = spec.args[spec.args.indexOf("-cp") + 1] ?? "";
		expect(cp).toContain("opengaussjdbc-1.0.jar");
		expect(cp).not.toContain("bos-core");
		for (const request of net.requests) expect(request.lines.join("\n")).not.toContain(SECRET);
		// 除了用户自己填的那份配置，读取过程写下的任何文件里都没有密码
		for (const [path, file] of fs.files)
			if (!path.endsWith("/prod/prod.json")) expect(file.content, path).not.toContain(SECRET);
	});

	it("内置函数和业务分区里的自定义函数同名时，查询不发出去", async () => {
		const { ctx, net } = setup();
		const deps = { agentConfigDir: AGENT_DIR, http: noHttp, isv: "demo" };
		const shadowed = await prod(ctx, deps, { action: "sql", sql: "select lower(fname) from t_demo" });
		expect(shadowed.ok).toBe(false);
		if (!shadowed.ok) {
			expect(shadowed.error.code).toBe("PROD_SQL_REFUSED");
			expect(shadowed.error.message).toContain("lower()");
		}
		expect(net.requests.map((r) => r.lines[1])).not.toContain("query");
		const plain = await prod(ctx, deps, { action: "sql", sql: "select upper(fname) from t_demo" });
		if (!plain.ok) throw plain.error;
		expect(plain.value.text).toContain("t_demo 在 demo_de");
		expect(plain.value.evidence?.kind).toBe("生产数据");
	});
});
