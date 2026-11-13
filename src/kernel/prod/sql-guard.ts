/**
 * 生产查询的语句闸：只放行一条只读查询，其余在发出去之前就拒。
 *
 * 生产只读不靠数据库账号——账号的权限给多给少都不影响这里。靠这一侧的三道闸，任何一道单独都挡得住写：
 * 这一道（语句闸）、读取进程连上就设的会话只读、每条查询在只读事务里跑完一律回滚（后两道在 ProdReader.java）。
 * 会话只读是可以被一条 SET 改回来的，自治事务的函数也能在只读事务外另开事务写——所以 SET 和函数调用
 * 都必须在这里拦住，不能指望数据库。
 *
 * 判法：先把字符串常量、带引号的标识符、注释抹成空白（里面的字不算关键字），再看
 *   ① 只有一条语句（末尾一个分号可以有）；
 *   ② 第一个词是 select / with / values / table / explain（explain 不带 analyze——那会真跑）；
 *   ③ 全文没有任何会写、会改会话、会加锁的关键字；
 *   ④ 调用的函数全在 ALLOWED_FUNCTIONS 里（白名单，不是黑名单：生产库业务分区里有 p_dropidx、
 *      p_altercolumn 这类会改结构的自定义函数，黑名单列不全）；带分区前缀的函数调用只认 pg_catalog；
 *      和业务分区里自定义函数同名的，由调用方拿读取进程报来的名单再拒一次（`userFunctions`）。
 * 按词边界比，列名 fupdatetime 不会被当成 update。宁可错拒：被拒的查询换个写法就行，漏放一条写进生产就回不去了。
 */

export type SqlCheck = { ok: true; tables: string[]; functions: string[] } | { ok: false; reason: string };

/** 出现就拒的词：写数据、改结构、改会话、事务控制、加锁、维护命令 */
const FORBIDDEN_WORDS = [
	"insert",
	"update",
	"delete",
	"merge",
	"upsert",
	"truncate",
	"drop",
	"alter",
	"create",
	"grant",
	"revoke",
	"comment",
	"copy",
	"call",
	"do",
	"execute",
	"exec",
	"prepare",
	"deallocate",
	"discard",
	"set",
	"reset",
	"begin",
	"commit",
	"rollback",
	"savepoint",
	// 没有 end：CASE … END 是普通查询里的写法；单独的 END 等于 COMMIT，但它前面必须有 begin/start，那两个已经拦了
	"start",
	"abort",
	"lock",
	"vacuum",
	"analyze",
	"analyse",
	"cluster",
	"reindex",
	"refresh",
	"notify",
	"listen",
	"unlisten",
	"load",
	"checkpoint",
	"security",
	"into",
] as const;

/**
 * 放行的函数：平台内置、只算不改的。聚合、窗口、条件、字符串、正则、数字、日期、类型转换、数组、JSON、XML，
 * 加上看表结构和权限用的目录函数。没有序列、配置、后台进程、文件、锁、跨库、睡眠一类，也没有任何自定义函数。
 */
const ALLOWED_FUNCTIONS = new Set([
	// 聚合
	"count",
	"sum",
	"avg",
	"min",
	"max",
	"string_agg",
	"array_agg",
	"json_agg",
	"jsonb_agg",
	"bool_and",
	"bool_or",
	"every",
	"listagg",
	"group_concat",
	"stddev",
	"variance",
	"median",
	"percentile_cont",
	"percentile_disc",
	"mode",
	// 窗口
	"row_number",
	"rank",
	"dense_rank",
	"percent_rank",
	"cume_dist",
	"ntile",
	"lag",
	"lead",
	"first_value",
	"last_value",
	"nth_value",
	// 条件
	"coalesce",
	"nullif",
	"greatest",
	"least",
	"nvl",
	"nvl2",
	"decode",
	// 字符串
	"length",
	"char_length",
	"character_length",
	"octet_length",
	"lower",
	"upper",
	"initcap",
	"trim",
	"ltrim",
	"rtrim",
	"btrim",
	"substr",
	"substring",
	"left",
	"right",
	"lpad",
	"rpad",
	"replace",
	"translate",
	"position",
	"strpos",
	"instr",
	"split_part",
	"concat",
	"concat_ws",
	"reverse",
	"repeat",
	"ascii",
	"chr",
	"md5",
	"encode",
	"convert_from",
	"to_hex",
	"starts_with",
	"format",
	"quote_literal",
	"quote_ident",
	"string_to_array",
	"array_to_string",
	// 正则
	"regexp_replace",
	"regexp_substr",
	"regexp_matches",
	"regexp_like",
	"regexp_count",
	"regexp_instr",
	"regexp_split_to_array",
	"regexp_split_to_table",
	// 数字
	"abs",
	"round",
	"trunc",
	"floor",
	"ceil",
	"ceiling",
	"mod",
	"power",
	"sqrt",
	"sign",
	"div",
	// 日期
	"now",
	"current_timestamp",
	"localtimestamp",
	"clock_timestamp",
	"statement_timestamp",
	"date_trunc",
	"date_part",
	"extract",
	"age",
	"make_date",
	"add_months",
	"last_day",
	"months_between",
	// 类型转换
	"cast",
	"date",
	"to_char",
	"to_date",
	"to_timestamp",
	"to_number",
	// 数组、集合
	"unnest",
	"array_length",
	"array_upper",
	"array_lower",
	"array_position",
	"cardinality",
	"generate_series",
	// JSON、XML（元数据原文是 XML 文本）
	"to_json",
	"to_jsonb",
	"row_to_json",
	"json_build_object",
	"jsonb_build_object",
	"json_extract_path_text",
	"jsonb_extract_path_text",
	"json_array_elements",
	"jsonb_array_elements",
	"json_array_elements_text",
	"jsonb_array_elements_text",
	"json_array_length",
	"jsonb_array_length",
	"json_object_keys",
	"jsonb_object_keys",
	"json_typeof",
	"jsonb_typeof",
	"xpath",
	"xpath_exists",
	"xmlparse",
	// 目录：看连到哪、表结构、权限、体积
	"version",
	"current_database",
	"current_schema",
	"current_schemas",
	"current_setting",
	"pg_typeof",
	"format_type",
	"obj_description",
	"col_description",
	"pg_get_viewdef",
	"pg_get_indexdef",
	"pg_get_constraintdef",
	"pg_get_expr",
	"pg_get_userbyid",
	"pg_table_is_visible",
	"has_table_privilege",
	"has_schema_privilege",
	"has_column_privilege",
	"to_regclass",
	"pg_relation_size",
	"pg_total_relation_size",
	"pg_table_size",
	"pg_indexes_size",
	"pg_column_size",
	"pg_size_pretty",
]);

/** 后面能直接跟括号、但不是函数的词：语法关键字和带长度的类型名 */
const PAREN_KEYWORDS = new Set([
	"select",
	"from",
	"join",
	"on",
	"using",
	"in",
	"exists",
	"any",
	"all",
	"some",
	"and",
	"or",
	"not",
	"as",
	"with",
	"recursive",
	"materialized",
	"values",
	"over",
	"filter",
	"within",
	"group",
	"when",
	"then",
	"else",
	"case",
	"where",
	"having",
	"by",
	"is",
	"between",
	"like",
	"ilike",
	"similar",
	"escape",
	"union",
	"intersect",
	"except",
	"lateral",
	"only",
	"row",
	"array",
	"interval",
	"distinct",
	"table",
	"explain",
	"limit",
	"offset",
	"numeric",
	"decimal",
	"number",
	"varchar",
	"varchar2",
	"nvarchar2",
	"char",
	"character",
	"varying",
	"nchar",
	"bit",
	"timestamp",
	"time",
	"float",
]);

/** 系统目录，不在业务分区里，不去报「这张表在哪个分区」 */
const CATALOG_SCHEMAS = new Set(["information_schema", "pg_catalog"]);

const LEADING_WORDS = new Set(["select", "with", "values", "table", "explain"]);

/**
 * 把字符串常量、引号标识符、注释换成同长的空白，只留下「真正的 SQL 词」。
 * E'..' 里的反斜杠转义、$tag$..$tag$ 都按 PostgreSQL 的规矩认；认不全的（没闭合）整条拒。
 */
export function maskLiterals(sql: string): { text: string; error: string | null } {
	let out = "";
	let i = 0;
	const n = sql.length;
	while (i < n) {
		const c = sql[i] as string;
		const next = sql[i + 1];
		if (c === "-" && next === "-") {
			const end = sql.indexOf("\n", i);
			const stop = end < 0 ? n : end;
			out += " ".repeat(stop - i);
			i = stop;
			continue;
		}
		if (c === "/" && next === "*") {
			const end = sql.indexOf("*/", i + 2);
			if (end < 0) return { text: out, error: "注释 /* 没有闭合" };
			out += " ".repeat(end + 2 - i);
			i = end + 2;
			continue;
		}
		if (c === "'") {
			const escaped = i > 0 && /[eE]/.test(sql[i - 1] as string) && !/\w/.test(sql[i - 2] ?? " ");
			let j = i + 1;
			for (;;) {
				if (j >= n) return { text: out, error: "字符串常量没有闭合" };
				const d = sql[j] as string;
				if (escaped && d === "\\") {
					j += 2;
					continue;
				}
				if (d === "'") {
					if (sql[j + 1] === "'") {
						j += 2;
						continue;
					}
					break;
				}
				j++;
			}
			out += `'${" ".repeat(j - i - 1)}'`;
			i = j + 1;
			continue;
		}
		if (c === '"') {
			const end = sql.indexOf('"', i + 1);
			if (end < 0) return { text: out, error: "带双引号的名字没有闭合" };
			// 引号标识符当成一个普通名字留着，表名提取还要用；里面的字不当关键字
			out += `"${sql.slice(i + 1, end).replace(/[^\w.]/g, "_")}"`;
			i = end + 1;
			continue;
		}
		if (c === "$") {
			const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
			if (tag) {
				const end = sql.indexOf(tag[0], i + tag[0].length);
				if (end < 0) return { text: out, error: "$..$ 字符串没有闭合" };
				out += " ".repeat(end + tag[0].length - i);
				i = end + tag[0].length;
				continue;
			}
		}
		out += c;
		i++;
	}
	return { text: out, error: null };
}

/**
 * 语句里 from / join 后面跟的表名（去掉 schema 前缀、去引号、小写），用来报「这张表在哪个分区」。
 * 系统目录（information_schema.*、pg_catalog.*、pg_ 开头的）不算：它们不在业务分区里。
 */
export function referencedTables(masked: string): string[] {
	const found = new Set<string>();
	const pattern = /\b(?:from|join)\s+((?:"?[\w$]+"?\.)?"?[\w$]+"?)/gi;
	for (const match of masked.matchAll(pattern)) {
		const name = (match[1] as string).replace(/"/g, "").toLowerCase();
		const [schema, bare] = name.includes(".") ? (name.split(".") as [string, string]) : [null, name];
		if (bare === "select" || bare === "lateral" || bare === "unnest") continue;
		if ((schema !== null && CATALOG_SCHEMAS.has(schema)) || bare.startsWith("pg_")) continue;
		found.add(bare);
	}
	return [...found].sort();
}

/** 从 open（左括号的位置）找到配对的右括号之后的位置；配不上就返回文本长度 */
function afterParen(text: string, open: number): number {
	let depth = 0;
	for (let i = open; i < text.length; i++) {
		if (text[i] === "(") depth++;
		else if (text[i] === ")") {
			depth--;
			if (depth === 0) return i + 1;
		}
	}
	return text.length;
}

/** 名字后面紧跟括号、但不是调用：CTE 的列名单 `with x(a, b) as (…)`、别名的列名单 `as t(a, b)` */
function isColumnList(body: string, start: number, open: number): boolean {
	if (/\bas\s*$/.test(body.slice(0, start))) return true;
	return /^\s*as\s+(?:not\s+)?(?:materialized\s+)?\(/.test(body.slice(afterParen(body, open)));
}

export function checkReadOnlySql(sql: string): SqlCheck {
	if (sql.trim() === "") return { ok: false, reason: "sql 是空的" };
	const masked = maskLiterals(sql);
	if (masked.error !== null) return { ok: false, reason: masked.error };
	// 引号标识符（"update" 这种列名）是名字不是关键字：判关键字时整个换成 x，提表名时用原样
	const lower = masked.text.toLowerCase().replace(/"[^"]*"/g, (quoted) => `"${"x".repeat(quoted.length - 2)}"`);
	const body = lower.trim().replace(/;\s*$/, "");
	if (body.includes(";")) return { ok: false, reason: "一次只能发一条语句（中间不能有分号）" };
	const first = /^[\s(]*([a-z_]+)/.exec(body)?.[1] ?? "";
	if (!LEADING_WORDS.has(first))
		return { ok: false, reason: `只放行查询：语句要以 select / with 开头，现在是「${first || body.slice(0, 20)}」` };
	if (/\bfor\s+(update|share|no\s+key\s+update|key\s+share)\b/.test(body))
		return { ok: false, reason: "不是只读查询：for update / for share 会给生产数据加锁" };
	for (const word of FORBIDDEN_WORDS) {
		if (new RegExp(`\\b${word}\\b`).test(body)) {
			const why =
				word === "into"
					? "select … into 会建表"
					: word === "analyze" || word === "analyse"
						? "explain analyze 会真的执行语句"
						: word === "set" || word === "reset"
							? "不许改会话设置（会话只读就是靠它守着的）"
							: `出现了「${word}」`;
			return { ok: false, reason: `不是只读查询：${why}` };
		}
	}
	if (/"\s*\(/.test(body)) return { ok: false, reason: "不许用带双引号的名字调函数" };
	const functions = new Set<string>();
	for (const call of body.matchAll(/(?:([a-z_][\w$]*)\s*\.\s*)?\b([a-z_][\w$]*)\s*\(/g)) {
		const schema = call[1];
		const name = call[2] as string;
		if (schema === undefined && PAREN_KEYWORDS.has(name)) continue;
		if (schema === undefined && isColumnList(body, call.index, call.index + call[0].length - 1)) continue;
		if (schema !== undefined && schema !== "pg_catalog")
			return {
				ok: false,
				reason: `不许调用 ${schema}.${name}()：带分区前缀的函数只认 pg_catalog（业务分区里的是自定义函数，可能改数据或结构）`,
			};
		if (!ALLOWED_FUNCTIONS.has(name))
			return {
				ok: false,
				reason: `不许调用 ${name}()：只放行内置的聚合、窗口、字符串、正则、数字、日期、类型转换、数组、JSON、XML 和目录函数，自定义函数和会改状态的函数一律不调`,
			};
		functions.add(name);
	}
	return { ok: true, tables: referencedTables(masked.text), functions: [...functions].sort() };
}
