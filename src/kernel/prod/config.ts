/**
 * 生产只读排障的连接配置：`<配置目录>/prod/<名字>.json`（默认名字 prod）。
 *
 * 放在用户目录、不放工程 `.cosmic-ai/config.json`：里面是生产库和 monitor 的账号密码，
 * 工程目录会进 git、会被打包、会被别人拷走。这个文件只在本机，读出来的密码只交给读取进程的环境变量，
 * 不进命令行（任务管理器看得见命令行）、不进日志、不进任何发给模型的文字——`describeProdConfig`
 * 是唯一给外面看的形状，里面没有密码。
 *
 * 带 `_说明` 的键是写给填表的人看的，读的时候忽略。
 */
import { join } from "node:path";
import { err, KernelError, type KernelResult, ok } from "../errors.ts";

export interface ProdDbConfig {
	/** opengauss（苍穹自带的高斯驱动）| gaussdb | postgresql */
	driver: "opengauss" | "gaussdb" | "postgresql";
	host: string;
	port: number;
	database: string;
	user: string;
	password: string;
	extraJdbcParams: string;
}

export interface ProdMonitorConfig {
	/** 形如 https://<主机>/monitor/eye */
	url: string;
	username: string;
	password: string;
}

export interface ProdConfig {
	name: string;
	file: string;
	db: ProdDbConfig;
	limits: { timeoutSeconds: number; maxRows: number };
	/** 没填 monitor 账号就是 null：日志查询那一块不可用，其余照常 */
	monitor: ProdMonitorConfig | null;
}

export const DEFAULT_PROD_NAME = "prod";
const DEFAULT_TIMEOUT_SECONDS = 15;
const DEFAULT_MAX_ROWS = 500;
/** 上限：再大就不是排障查询，是在搬数据；也防止一次把生产库拖慢 */
const MAX_TIMEOUT_SECONDS = 120;
const MAX_ROWS_CEILING = 5000;

export function prodConfigFile(agentConfigDir: string, name = DEFAULT_PROD_NAME): string {
	return join(agentConfigDir, "prod", `${name}.json`);
}

/** monitor 登录后的会话，和配置放在一起：同样是凭据，同样不进工程目录 */
export function prodMonitorSessionFile(agentConfigDir: string, name = DEFAULT_PROD_NAME): string {
	return join(agentConfigDir, "prod", `${name}.monitor-session.json`);
}

function text(value: unknown): string {
	if (typeof value === "string") return value.trim();
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return "";
}

function bounded(value: unknown, fallback: number, max: number): number {
	const n = typeof value === "number" ? value : Number.parseInt(text(value), 10);
	if (!Number.isFinite(n) || n <= 0) return fallback;
	return Math.min(Math.floor(n), max);
}

function missing(file: string, what: string): KernelError {
	return new KernelError("PROD_CONFIG_MISSING", `生产排障配置不全：${what}`, {
		detail: { file },
		remedy: `请用户在 ${file} 里把它填上（这个文件只在本机，里面是生产账号，不要把内容贴进对话）。`,
	});
}

/** 解析已经读出来的文件内容。纯函数：测试和 doctor 都走这里 */
export function parseProdConfig(raw: string, file: string, name = DEFAULT_PROD_NAME): KernelResult<ProdConfig> {
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch (error) {
		return err(
			new KernelError("PROD_CONFIG_MISSING", `生产排障配置不是合法 JSON：${(error as Error).message}`, {
				detail: { file },
				remedy: `请用户检查 ${file} 的格式（逗号、引号）。`,
			}),
		);
	}
	if (typeof json !== "object" || json === null) return err(missing(file, "文件内容不是一个对象"));
	const root = json as Record<string, unknown>;
	const db = (typeof root.db === "object" && root.db !== null ? root.db : {}) as Record<string, unknown>;
	const driverText = text(db.driver) || "opengauss";
	if (driverText !== "opengauss" && driverText !== "gaussdb" && driverText !== "postgresql")
		return err(missing(file, `db.driver 只认 opengauss / gaussdb / postgresql，现在是 ${driverText}`));
	const port = Number.parseInt(text(db.port), 10);
	for (const key of ["host", "database", "user", "password"] as const) {
		if (text(db[key]) === "") return err(missing(file, `db.${key} 没填`));
	}
	if (!Number.isInteger(port) || port <= 0 || port > 65535) return err(missing(file, "db.port 要填端口号数字"));
	const limits = (typeof root.limits === "object" && root.limits !== null ? root.limits : {}) as Record<
		string,
		unknown
	>;
	const mon = (typeof root.monitor === "object" && root.monitor !== null ? root.monitor : {}) as Record<
		string,
		unknown
	>;
	const monitorUrl = text(mon.url).replace(/\/+$/, "");
	const monitor =
		monitorUrl !== "" && text(mon.username) !== "" && text(mon.password) !== ""
			? { url: monitorUrl, username: text(mon.username), password: String(mon.password) }
			: null;
	return ok({
		name: text(root.name) || name,
		file,
		db: {
			driver: driverText,
			host: text(db.host),
			port,
			database: text(db.database),
			user: text(db.user),
			// 密码原样，不 trim：首尾空格也可能是密码的一部分
			password: String(db.password),
			extraJdbcParams: text(db.extraJdbcParams),
		},
		limits: {
			timeoutSeconds: bounded(limits.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS),
			maxRows: bounded(limits.maxRows, DEFAULT_MAX_ROWS, MAX_ROWS_CEILING),
		},
		monitor,
	});
}

/** JDBC 连接串。账号密码不在里面，走连接属性 */
export function jdbcUrl(db: ProdDbConfig): string {
	const scheme = db.driver === "postgresql" ? "postgresql" : db.driver === "gaussdb" ? "gaussdb" : "opengauss";
	const extra = db.extraJdbcParams === "" ? "" : `?${db.extraJdbcParams.replace(/^\?/, "")}`;
	return `jdbc:${scheme}://${db.host}:${String(db.port)}/${db.database}${extra}`;
}

/** 驱动类名：都是苍穹运行时目录里自带的，类路径上本来就有 */
export function jdbcDriverClass(db: ProdDbConfig): string {
	if (db.driver === "postgresql") return "org.postgresql.Driver";
	if (db.driver === "gaussdb") return "com.huawei.gauss200.jdbc.Driver";
	return "com.huawei.opengauss.jdbc.Driver";
}

/** 给人和模型看的配置摘要：没有密码，账号也只给名字 */
export function describeProdConfig(config: ProdConfig): string {
	const monitor =
		config.monitor === null ? "没配（日志查询不可用）" : `${config.monitor.url}（账号 ${config.monitor.username}）`;
	return [
		`配置 ${config.file}`,
		`生产库 ${config.db.host}:${String(config.db.port)}/${config.db.database}（${config.db.driver}，账号 ${config.db.user}）`,
		`每条查询最长 ${String(config.limits.timeoutSeconds)} 秒、最多 ${String(config.limits.maxRows)} 行`,
		`monitor ${monitor}`,
	].join("\n");
}
