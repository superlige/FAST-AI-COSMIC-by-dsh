/**
 * 生产库按语句报错时，报错里带上语句用到的表在库里的真实列和类型、库的版本，
 * 下一条语句照着写，不用再一次次试（真实会话 2026-11-18：varchar 列直接比 bigint、在 openGauss 上用 FILTER）。
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { prod } from "../../src/kernel/commands/prod.ts";
import type { DetachedSpec } from "../../src/kernel/ports.ts";
import type { HttpPort } from "../../src/kernel/prod/monitor.ts";
import { makeContext } from "./fake-context.ts";

const AGENT_DIR = "D:/home/.fast-ai-cosmic";
const noHttp: HttpPort = {
	post: async () => {
		throw new Error("不该访问 monitor");
	},
};
const deps = { agentConfigDir: AGENT_DIR, http: noHttp, isv: "demo" };
const VERSION = "PostgreSQL 9.2.4 (openGauss 5.0.1 build 33b035fd) compiled at 2023-12-15";
const WIDE = Array.from({ length: 120 }, (_, i) => [`fcol${String(i)}`, "integer"]);

function reply(columns: string[], rows: string[][]): { ok: true; text: string } {
	return {
		ok: true,
		text: JSON.stringify({ ok: true, columns, rows, rowCount: rows.length, truncated: false, clipped: false, ms: 1 }),
	};
}

function setup(failure: { error: string; sqlState: string }) {
	const fake = makeContext();
	const { ctx, fs, proc, net } = fake;
	fs.put(ctx.layout.javacArgs, '-cp "D:/cosmic/lib/trd/opengaussjdbc-1.0.jar"\n');
	fs.put(ctx.layout.prodReaderSrc, "public class ProdReader {}");
	fs.put(
		join(AGENT_DIR, "prod", "prod.json"),
		JSON.stringify({ db: { host: "10.0.0.9", port: 8000, database: "demo_all", user: "ro_demo", password: "pw" } }),
	);
	const start = proc.startDetached.bind(proc);
	proc.startDetached = (spec: DetachedSpec) => {
		const started = start(spec);
		const state = spec.args.find((arg) => arg.startsWith("-Dprod.state="))?.slice("-Dprod.state=".length) ?? "";
		fs.put(state, JSON.stringify({ pid: started.pid, port: 5555, token: "tok", startedAt: 1 }));
		return started;
	};
	const sent: string[] = [];
	net.handler = (_port, lines) => {
		if (lines[1] === "ping") return { ok: true, text: '{"ok":true}' };
		if (lines[1] === "info") return { ok: true, text: '{"ok":true,"userFunctions":[]}' };
		const encoded = lines.find((line) => line.startsWith("sql="))?.slice(4) ?? "";
		const sql = Buffer.from(encoded, "base64").toString("utf8");
		sent.push(sql);
		if (sql === "select version()") return reply(["version"], [[VERSION]]);
		if (sql.includes("pg_attribute"))
			return reply(
				["relname", "nspname", "attname", "format_type"],
				[
					["t_log_app_v3", "demo_log", "fid", "bigint"],
					["t_log_app_v3", "demo_log", "fbizobjid", "character varying(100)"],
					["t_log_app_v3", "demo_log", "fopdesc", "character varying(500)"],
					// 同名表在第二个分区：和执行查询时一样只取排在前面的那个
					["t_log_app_v3", "demo_other", "fwrong", "text"],
					...WIDE.map(([name, type]) => ["tk_demo_wide", "demo_de", name as string, type as string]),
					["tk_demo_wide", "demo_de", "fid", "bigint"],
					["tk_demo_wide", "demo_de", "fk_demo_hjzt", "character varying(50)"],
				].filter((row) => sql.includes(`'${row[0] as string}'`)),
			);
		return { ok: true, text: JSON.stringify({ ok: false, ...failure }) };
	};
	return { ctx, fs, sent };
}

describe("生产库按语句报错时附上真实列", () => {
	it("类型不匹配：报错带上语句用到的表的列类型和库版本，改了语句不算重复", async () => {
		const { ctx, fs, sent } = setup({
			error: 'invalid input syntax for type bigint: "im_purinbill"',
			sqlState: "22P02",
		});
		const result = await prod(ctx, deps, {
			action: "sql",
			sql: "select a.fopdesc from t_log_app_v3 a join tk_demo_wide b on a.fbizobjid = b.fid where b.fcol7 = 1 and a.fopdesc like '%fcol9%'",
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("PROD_SQL_FAILED");
		expect(result.error.message).toContain("invalid input syntax for type bigint");
		expect(result.error.detail.database).toBe(VERSION);
		const columns = result.error.detail.columns as string[];
		expect(columns[0]).toBe(
			"t_log_app_v3（分区 demo_log，3 列）：fid bigint, fbizobjid character varying(100), fopdesc character varying(500)",
		);
		// 宽表只列语句里写到的列；字符串常量里的 fcol9 不算写到
		expect(columns[1]).toContain(
			"tk_demo_wide（分区 demo_de，122 列，下面只列语句里写到的 2 列）：fcol7 integer, fid bigint",
		);
		expect(columns[1]).not.toContain("fcol9");
		expect(columns[1]).toContain("其余 120 列见 columnsFile");
		const file = String(result.error.detail.columnsFile);
		expect(fs.read(file).split("\n")).toContain("tk_demo_wide\tdemo_de\tfcol9\tinteger");
		expect(fs.read(file)).not.toContain("fwrong");
		expect(result.error.remedy).toContain("真实列名和类型");
		// 用户语句 1 条 + 版本 1 条 + 列 1 条；列查询里只有语句闸认出的表名
		expect(sent).toHaveLength(3);
		expect(sent[2]).toContain("c.relname in ('t_log_app_v3', 'tk_demo_wide')");
	});

	it("连不上不是语句的错：不查列，码照旧是 PROD_QUERY_FAILED", async () => {
		const { ctx, sent } = setup({ error: "Connection refused", sqlState: "08001" });
		const result = await prod(ctx, deps, { action: "sql", sql: "select fid from t_log_app_v3" });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("PROD_QUERY_FAILED");
		expect(result.error.detail.columns).toBeUndefined();
		expect(sent).toHaveLength(1);
	});

	it("列名写错：宽表里名字相近的真实列也列出来，EXTRACT(… FROM 列) 不被说成「没有这张表」", async () => {
		const { ctx } = setup({ error: 'ERROR: column "demo_hjzt" does not exist\n  位置：130', sqlState: "42703" });
		const result = await prod(ctx, deps, {
			action: "sql",
			sql: "select extract(hour from fcreatetime) as h, count(*) from tk_demo_wide where demo_hjzt is null group by 1",
		});
		if (result.ok) throw new Error("应当失败");
		expect(result.error.detail.columns).toEqual([
			"tk_demo_wide（分区 demo_de，122 列，下面只列语句里写到的和名字像「demo_hjzt」的 1 列）：fk_demo_hjzt character varying(50)；其余 121 列见 columnsFile",
		]);
		expect(result.error.remedy).toContain("列不存在");
		expect(result.error.remedy).not.toContain("action=meta");
	});

	it("表在库里不存在：照实说没有这张表", async () => {
		const { ctx } = setup({ error: 'relation "t_nope" does not exist', sqlState: "42P01" });
		const result = await prod(ctx, deps, { action: "sql", sql: "select fid from t_nope" });
		if (result.ok) throw new Error("应当失败");
		expect(result.error.detail.columns).toEqual([
			"t_nope：本账号能看到的分区里没有这张表（可能是子查询别名或拼错了）",
		]);
	});
});
