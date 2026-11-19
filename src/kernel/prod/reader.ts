/**
 * 生产只读通道的 Node 一侧：拉起本机常驻的 ProdReader、发请求、收答复。
 *
 * 为什么常驻：一次连接生产库要 1.8 秒，加上起 JVM 半秒；一次排障常常查十几二十次，
 * 每次都重来就是半分钟以上白等。常驻进程闲置 15 分钟自己退。
 *
 * 类路径只有两样：编好的 ProdReader 和数据库驱动 jar。驱动从工程编译参数的类路径里认出来
 * （苍穹运行时目录自带），不放整个苍穹类路径——那样 DriverManager 会顺手加载上百个别的驱动，
 * 也让这个进程有了够着平台的可能。
 *
 * 账号密码只走子进程的环境变量。状态文件里只有进程号、端口和一次性 token。
 */
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { classpathFromArgfile } from "../../runtime/jdk-probe.ts";
import { baseChildEnv, type KernelContext } from "../context.ts";
import { err, KernelError, type KernelResult, ok } from "../errors.ts";
import { classpathOf, runJavac } from "../toolchain.ts";
import { jdbcDriverClass, jdbcUrl, type ProdConfig } from "./config.ts";

export interface ProdTableSchema {
	schema: string;
	readable: boolean;
}

export interface ProdQueryReply {
	columns: string[];
	rows: (string | null)[][];
	rowCount: number;
	/** 行数到了上限，后面还有 */
	truncated: boolean;
	/** 答复体积到了上限，行没取完 */
	clipped: boolean;
	ms: number;
	/** 语句里用到的表各在哪个分区、能不能查 */
	tableSchemas: Record<string, ProdTableSchema[]>;
}

export interface ProdSchemaInfo {
	name: string;
	tables: number;
	readable: number;
}

export interface ProdInfoReply {
	version: string;
	user: string;
	database: string;
	sessionReadOnly: string;
	schemas: ProdSchemaInfo[];
	/** 业务分区里自定义函数的名字（小写）；语句闸放行的内置函数和它们同名时也拒 */
	userFunctions: string[];
	ms: number;
}

interface ReaderState {
	pid: number;
	port: number;
	token: string;
	startedAt: number;
}

const IDLE_MINUTES = 15;
const START_WAIT_MS = 20_000;
/** 驱动 jar 的文件名：按 driver 认 */
const DRIVER_JAR: Record<ProdConfig["db"]["driver"], RegExp> = {
	opengauss: /^opengaussjdbc[-\w.]*\.jar$/i,
	gaussdb: /^gsjdbc200[-\w.]*\.jar$/i,
	postgresql: /^postgresql-[\d.]+\.jar$/i,
};

function files(ctx: KernelContext, config: ProdConfig) {
	const dir = join(ctx.layout.agentCache, "prod");
	return {
		dir,
		state: join(dir, `${config.name}-reader.json`),
		key: join(dir, `${config.name}-reader.key`),
		log: join(dir, `${config.name}-reader.log`),
	};
}

/** 读取进程的指纹：换了库、账号、密码，或读取程序本身改了（答复的字段跟着变），旧进程就不能再用 */
function connectionKey(ctx: KernelContext, config: ProdConfig): string {
	const { fs } = ctx.ports;
	const source = fs.exists(ctx.layout.prodReaderSrc) ? fs.read(ctx.layout.prodReaderSrc) : "";
	return createHash("sha256")
		.update(JSON.stringify([config.db.driver, jdbcUrl(config.db), config.db.user, config.db.password, source]))
		.digest("hex")
		.slice(0, 32);
}

function failure(message: string, remedy: string, detail: Record<string, string> = {}): KernelError {
	return new KernelError("PROD_QUERY_FAILED", message, { detail, remedy });
}

/** 从编译参数的类路径里找驱动 jar */
export function findDriverJar(ctx: KernelContext, config: ProdConfig): string | null {
	const { fs } = ctx.ports;
	if (!fs.exists(ctx.layout.javacArgs)) return null;
	const pattern = DRIVER_JAR[config.db.driver];
	return classpathFromArgfile(fs.read(ctx.layout.javacArgs)).find((entry) => pattern.test(basename(entry))) ?? null;
}

async function ensureCompiled(ctx: KernelContext): Promise<KernelResult<void>> {
	const { fs } = ctx.ports;
	const src = ctx.layout.prodReaderSrc;
	if (!fs.exists(src)) return err(failure("生产读取程序没有释放出来", "重新打开工程（cosmic_open_project）后再试。"));
	const classFile = join(ctx.layout.toolClasses, "ProdReader.class");
	const classMs = fs.mtimeMs(classFile);
	const srcMs = fs.mtimeMs(src);
	if (classMs !== null && srcMs !== null && srcMs <= classMs) return ok(undefined);
	fs.mkdirp(ctx.layout.toolClasses);
	const run = await runJavac(ctx, ["-encoding", "UTF-8", "-d", ctx.layout.toolClasses, src]);
	if (run.status !== 0)
		return err(failure(`生产读取程序编译失败：${run.out.slice(0, 500)}`, "检查本机 JDK（cosmic_doctor）。"));
	return ok(undefined);
}

function readState(ctx: KernelContext, file: string): ReaderState | null {
	const { fs } = ctx.ports;
	if (!fs.exists(file)) return null;
	try {
		const value = JSON.parse(fs.read(file)) as ReaderState;
		if (typeof value.port !== "number" || typeof value.token !== "string") return null;
		return value;
	} catch {
		return null;
	}
}

async function send(
	ctx: KernelContext,
	state: ReaderState,
	op: string,
	params: Record<string, string>,
	timeoutMs: number,
): Promise<{ ok: true; json: Record<string, unknown> } | { ok: false; why: string; connect: boolean }> {
	const lines = [state.token, op, ...Object.entries(params).map(([k, v]) => `${k}=${v}`), "END"];
	const reply = await ctx.ports.net.request(state.port, lines, timeoutMs);
	if (!reply.ok) return { ok: false, why: reply.why ?? "没有答复", connect: reply.text === "" };
	try {
		return { ok: true, json: JSON.parse(reply.text) as Record<string, unknown> };
	} catch {
		return { ok: false, why: `答复不是 JSON：${reply.text.slice(0, 200)}`, connect: false };
	}
}

async function start(ctx: KernelContext, config: ProdConfig): Promise<KernelResult<ReaderState>> {
	const { fs, proc, clock } = ctx.ports;
	const paths = files(ctx, config);
	const compiled = await ensureCompiled(ctx);
	if (!compiled.ok) return compiled;
	const driver = findDriverJar(ctx, config);
	if (driver === null)
		return err(
			failure(
				`工程类路径里找不到 ${config.db.driver} 的驱动 jar`,
				"驱动在苍穹运行时目录 lib/trd 下；先 cosmic_doctor action=rebuild 重建编译参数，或把配置里的 driver 换成类路径里有的那种。",
			),
		);
	fs.mkdirp(paths.dir);
	if (fs.exists(paths.state)) fs.remove(paths.state);
	const started = proc.startDetached({
		command: "java",
		args: [
			`-Dprod.state=${paths.state}`,
			`-Dprod.idleMinutes=${String(IDLE_MINUTES)}`,
			"-Dfile.encoding=UTF-8",
			"-Xmx512m",
			"-cp",
			classpathOf(ctx.layout.toolClasses, driver),
			"ProdReader",
		],
		cwd: ctx.projectRoot,
		env: {
			...baseChildEnv(ctx),
			PROD_DRIVER: jdbcDriverClass(config.db),
			PROD_URL: jdbcUrl(config.db),
			PROD_USER: config.db.user,
			PROD_PASS: config.db.password,
		},
		logFile: paths.log,
	});
	if (started.pid === null)
		return err(failure(`生产读取程序起不来：${started.error ?? "未知原因"}`, `看日志 ${paths.log}。`));
	const deadline = clock.now() + START_WAIT_MS;
	while (clock.now() < deadline) {
		const state = readState(ctx, paths.state);
		if (state !== null) {
			fs.write(paths.key, connectionKey(ctx, config));
			return ok(state);
		}
		if (!proc.isAlive(started.pid)) break;
		await clock.sleep(150);
	}
	return err(failure("生产读取程序没在规定时间内起来", `看日志 ${paths.log}。`, { log: paths.log }));
}

/** 拿一个能用的读取进程：有就复用，连接身份变了或进程没了就重起 */
async function reader(ctx: KernelContext, config: ProdConfig): Promise<KernelResult<ReaderState>> {
	const { fs } = ctx.ports;
	const paths = files(ctx, config);
	const state = readState(ctx, paths.state);
	const sameKey = fs.exists(paths.key) && fs.read(paths.key).trim() === connectionKey(ctx, config);
	if (state !== null && sameKey && ctx.ports.proc.isAlive(state.pid)) {
		const ping = await send(ctx, state, "ping", {}, 3000);
		if (ping.ok && ping.json.ok === true) return ok(state);
	}
	if (state !== null && !sameKey && ctx.ports.proc.isAlive(state.pid)) await send(ctx, state, "stop", {}, 3000);
	return start(ctx, config);
}

async function call(
	ctx: KernelContext,
	config: ProdConfig,
	op: string,
	params: Record<string, string>,
	timeoutMs: number,
): Promise<KernelResult<Record<string, unknown>>> {
	const paths = files(ctx, config);
	for (let attempt = 0; attempt < 2; attempt++) {
		const got = await reader(ctx, config);
		if (!got.ok) return got;
		const reply = await send(ctx, got.value, op, params, timeoutMs);
		if (!reply.ok) {
			// 进程刚好闲置退出、或被人关了：重起一次再问
			if (reply.connect && attempt === 0) {
				if (ctx.ports.fs.exists(paths.state)) ctx.ports.fs.remove(paths.state);
				continue;
			}
			return err(failure(`生产读取程序没有答复：${reply.why}`, `看日志 ${paths.log}。`));
		}
		if (reply.json.ok !== true) {
			const message = String(reply.json.error ?? "未知错误");
			const sqlState = String(reply.json.sqlState ?? "");
			const detail: Record<string, string> = sqlState === "" ? {} : { sqlState };
			// 库收到了语句、按语句本身报的错（语法、类型、列名、超时、没权限）：报错就是答案，
			// 改了语句是在照着改，和「连不上」分成两个码，重复失败的闸才分得清是不是原样重放
			if (sqlState !== "" && !sqlState.startsWith("08"))
				return err(
					new KernelError("PROD_SQL_FAILED", `生产库报错：${message}`, {
						detail,
						remedy: remedyFor(message, sqlState),
					}),
				);
			return err(failure(`生产库报错：${message}`, remedyFor(message, sqlState), detail));
		}
		return ok(reply.json);
	}
	return err(failure("生产读取程序重起后仍然连不上", `看日志 ${paths.log}。`));
}

function remedyFor(message: string, sqlState: string): string {
	if (sqlState === "42501" || /permission denied|权限/i.test(message))
		return "这个只读账号没有这张表的查询权限：照实告诉用户是「没权限」，不是「没数据」。";
	if (sqlState === "57014" || /cancel|timeout|超时/i.test(message))
		return "查询超时被取消了：加上更窄的过滤条件（单据编号、时间段、fid），别对大表全表扫。";
	if (sqlState === "42703") return "列不存在：按库里的真实列名改写。";
	if (sqlState === "42P01" || (sqlState === "" && /relation .* does not exist/i.test(message)))
		return "表不存在：单据的表名用 cosmic_prod action=meta 看，再写查询。";
	if (sqlState.startsWith("08") || /connect|refused|timed out/i.test(message))
		return "连不上生产库：请用户确认 VPN 已连上。";
	return "按报错改写查询后再试。";
}

export async function prodInfo(ctx: KernelContext, config: ProdConfig): Promise<KernelResult<ProdInfoReply>> {
	const got = await call(ctx, config, "info", {}, 150_000);
	if (!got.ok) return got;
	const value = got.value as unknown as ProdInfoReply;
	// 没有这份名单就没法判「同名的自定义函数」：当成读取程序不对，不放行查询
	if (!Array.isArray(value.userFunctions))
		return err(failure("生产读取程序没报自定义函数名单", "关掉排障模式再打开（读取进程会重起）后再试。"));
	return ok(value);
}

export async function prodQuery(
	ctx: KernelContext,
	config: ProdConfig,
	sql: string,
	tables: readonly string[],
): Promise<KernelResult<ProdQueryReply>> {
	const encode = (text: string): string => Buffer.from(text, "utf8").toString("base64");
	const params: Record<string, string> = {
		sql: encode(sql),
		timeout: String(config.limits.timeoutSeconds),
		max: String(config.limits.maxRows),
	};
	const safeTables = tables.filter((name) => /^[a-z0-9_$]+$/.test(name));
	if (safeTables.length > 0) params.tables = encode(safeTables.join(","));
	const got = await call(ctx, config, "query", params, (config.limits.timeoutSeconds + 30) * 1000);
	if (!got.ok) return got;
	const value = got.value as unknown as ProdQueryReply;
	return ok({ ...value, tableSchemas: value.tableSchemas ?? {} });
}

export interface ProdTableColumns {
	table: string;
	schema: string;
	/** 按列序：列名和库里的真实类型（format_type 的写法，如 bigint、character varying(100)） */
	columns: { name: string; type: string }[];
}

export interface ProdColumnsReply {
	/** select version() 的原文：方言以它为准 */
	version: string;
	tables: ProdTableColumns[];
}

/** 一张表最多查回多少列：苍穹最宽的业务表也就两三百列，到这个数还没完说明表名认错了 */
const COLUMNS_PER_TABLE_CAP = 1000;

/**
 * 语句里用到的表在库里的真实列和类型，加上库的版本。
 *
 * 查询报错时给调用方看：模型照着报错改语句时，列名、列类型、方言都以库为准，不用再一次次试。
 * 同名表在多个分区时，和执行查询时一样按分区名排序取第一个。表名只收 [a-z0-9_$]，拼进语句前再挡一次。
 */
export async function prodColumns(
	ctx: KernelContext,
	config: ProdConfig,
	tables: readonly string[],
): Promise<KernelResult<ProdColumnsReply>> {
	const safe = [...new Set(tables.filter((name) => /^[a-z0-9_$]+$/.test(name)))];
	const wide = { ...config, limits: { ...config.limits, maxRows: COLUMNS_PER_TABLE_CAP * Math.max(1, safe.length) } };
	const version = await prodQuery(ctx, config, "select version()", []);
	if (!version.ok) return version;
	const reply: ProdColumnsReply = { version: version.value.rows[0]?.[0] ?? "", tables: [] };
	if (safe.length === 0) return ok(reply);
	const got = await prodQuery(
		ctx,
		wide,
		"select c.relname, n.nspname, a.attname, format_type(a.atttypid, a.atttypmod)" +
			" from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace" +
			` where c.relkind in ('r', 'v', 'm', 'p', 'f') and c.relname in (${safe.map((t) => `'${t}'`).join(", ")})` +
			" and n.nspname = any(current_schemas(false)) and a.attnum > 0 and not a.attisdropped" +
			" order by c.relname, n.nspname, a.attnum",
		[],
	);
	if (!got.ok) return got;
	const byTable = new Map<string, ProdTableColumns>();
	for (const [table, schema, name, type] of got.value.rows) {
		if (table == null || schema == null || name == null) continue;
		const seen = byTable.get(table);
		if (seen !== undefined && seen.schema !== schema) continue;
		const entry = seen ?? { table, schema, columns: [] };
		entry.columns.push({ name, type: type ?? "" });
		byTable.set(table, entry);
	}
	reply.tables = [...byTable.values()];
	return ok(reply);
}

/** 关掉读取进程（会话结束、配置改了）。没在跑就什么都不做 */
export async function stopProdReader(ctx: KernelContext, config: ProdConfig): Promise<void> {
	const state = readState(ctx, files(ctx, config).state);
	if (state !== null && ctx.ports.proc.isAlive(state.pid)) await send(ctx, state, "stop", {}, 3000);
}
