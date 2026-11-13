import { describe, expect, it } from "vitest";
import { checkReadOnlySql, maskLiterals } from "../../src/kernel/prod/sql-guard.ts";

const allowed = (sql: string) => {
	const result = checkReadOnlySql(sql);
	if (!result.ok) throw new Error(`应放行却被拒：${sql} → ${result.reason}`);
	return result;
};
const refused = (sql: string): string => {
	const result = checkReadOnlySql(sql);
	if (result.ok) throw new Error(`应拒却放行了：${sql}`);
	return result.reason;
};

describe("生产查询语句闸", () => {
	it("放行普通查询，含 case…end、replace()、子查询、with、explain、末尾分号", () => {
		allowed("select fid, fnumber from t_meta_formdesign where fnumber = 'zlgd_x'");
		allowed("select case when fstatus = 'C' then 1 else 0 end as done from t_sm_salorder;");
		allowed("select replace(fdata, '<a>', '') from t_meta_entitydesign where fid = '1'");
		allowed("with x as (select fid from t_a) select * from x join t_b b on b.fid = x.fid");
		allowed("explain select * from t_a where fid = 1");
		allowed("  (select 1)");
		allowed("select fupdatetime, fcreatedate, fsetting from t_a");
	});

	it("字符串和注释里的危险词不算", () => {
		allowed("select * from t_log where fmessage like '%delete from t_x; drop table y%'");
		allowed("select 1 -- update t_a set x = 1\n from t_a");
		allowed("select 1 /* insert into t_a */ from t_a");
		allowed(`select "update" from t_a`);
		allowed("select E'it\\'s update' from t_a");
		allowed("select $$ set role x $$ from t_a");
	});

	it("拒写、改结构、改会话、事务控制", () => {
		expect(refused("update t_a set fstatus = 'C'")).toContain("select");
		expect(refused("delete from t_a")).toContain("select");
		expect(refused("with d as (delete from t_a returning *) select * from d")).toContain("delete");
		expect(refused("with u as (update t_a set x = 1 returning *) select * from u")).toContain("update");
		expect(refused("select * into t_copy from t_a")).toContain("建表");
		expect(refused("set session characteristics as transaction read write")).toContain("select");
		expect(refused("select 1; set transaction read write")).toContain("一条");
		expect(refused("select 1; select 2")).toContain("一条");
		expect(refused("begin; select 1")).toContain("一条");
		expect(refused("truncate t_a")).toContain("select");
	});

	it("拒加锁、真执行的 explain analyze、危险函数", () => {
		expect(refused("select * from t_a for update")).toContain("加锁");
		expect(refused("select * from t_a for no key update")).toContain("update");
		expect(refused("select * from t_a for share")).toContain("加锁");
		expect(refused("explain analyze select * from t_a")).toContain("真的执行");
		expect(refused("select nextval('seq_a')")).toContain("nextval");
		expect(refused("select set_config('transaction_read_only', 'off', false)")).toContain("set_config");
		expect(refused("select pg_sleep(100)")).toContain("pg_sleep");
		expect(refused("select pg_read_file('/etc/passwd')")).toContain("pg_read_file");
		expect(refused("select pg_terminate_backend(123)")).toContain("pg_terminate_backend");
		expect(refused("select * from dblink('x', 'delete from t')")).toContain("dblink");
		expect(refused("select lo_import('/tmp/x')")).toContain("lo_import");
	});

	it("函数只放行内置白名单：自定义函数、带业务分区前缀的、引号名字的一律拒", () => {
		expect(refused("select p_dropidx('t_a', 'idx_a')")).toContain("p_dropidx()");
		expect(refused("select demo_job_update()")).toContain("demo_job_update()");
		expect(refused("select fid from t_a where demo_flag(fid) = 1")).toContain("demo_flag()");
		expect(refused("select demo_de.fn_gcd(4, 6)")).toContain("pg_catalog");
		expect(refused('select "demo_fn"(1)')).toContain("双引号");
		expect(refused("select pg_stat_reset()")).toContain("pg_stat_reset()");
		const ok = allowed(
			"select pg_catalog.count(*), string_agg(fname, ',' order by fname), percentile_cont(0.5) within group (order by fqty)," +
				" cast(fqty as numeric(18, 2)), coalesce(nullif(trim(fname), ''), '-'), row_number() over (partition by fid order by fseq)" +
				" from t_a where exists (select 1 from t_b where t_b.fid = t_a.fid) and fid in (1, 2) and fdate >= date_trunc('day', now())",
		);
		expect(ok.functions).toEqual([
			"cast",
			"coalesce",
			"count",
			"date_trunc",
			"now",
			"nullif",
			"percentile_cont",
			"row_number",
			"string_agg",
			"trim",
		]);
	});

	it("CTE 和别名的列名单不当成函数调用", () => {
		allowed("with x(a, b) as (select fid, fseq from t_a), y as (select 1) select * from x");
		allowed("select * from (values (1, 'a'), (2, 'b')) as v(n, s)");
	});

	it("系统目录不报成「不在业务分区」的表", () => {
		const result = allowed(
			"select c.column_name from information_schema.columns c join pg_class p on p.relname = c.table_name join t_demo d on 1=1",
		);
		expect(result.tables).toEqual(["t_demo"]);
	});

	it("拒没闭合的引号和注释：认不全就不放", () => {
		expect(refused("select 'abc from t_a")).toContain("没有闭合");
		expect(refused("select 1 /* x")).toContain("没有闭合");
		expect(refused('select "a from t')).toContain("没有闭合");
		expect(refused("")).toContain("空");
	});

	it("报出语句里用到的表名（去 schema、去引号、小写）", () => {
		const result = allowed(
			'select * from zlgd_meta.T_META_FORMDESIGN f join "t_sm_salorder" s on 1=1 left join t_bd_material m on 1=1',
		);
		expect(result.tables).toEqual(["t_bd_material", "t_meta_formdesign", "t_sm_salorder"]);
	});

	it("抹字面量时保持长度，表名提取不被字符串里的 from 带偏", () => {
		const masked = maskLiterals("select 'from x' from t_a");
		expect(masked.text.length).toBe("select 'from x' from t_a".length);
		expect(allowed("select 'from fake' from t_real").tables).toEqual(["t_real"]);
	});
});
