/**
 * 生产凭据的门：模型的终端和文件工具不许碰本机存生产账号、monitor 登录、生产读取进程口令的地方。
 *
 * 为什么要这道门：查生产的确认框和只读闸都只管 `cosmic_prod` 这一条路。这几处文件里有明文的生产库密码、
 * monitor 密码、monitor 登录后的凭证、读取进程的端口和口令；模型用终端或读文件工具读到，就能自己连生产
 * （psql、curl、直连读取进程），既不经人同意，也不经只读闸。
 *
 * 拦的地方（都在 cosmic 的本机目录 `~/.fast-ai-cosmic/` 下）：
 *   - `prod/`：生产排障配置 `prod.json`、monitor 登录 `prod.monitor-session.json`、验证码图；
 *   - `cache/<RuntimeKey>/prod/`：读取进程的状态（端口、口令）和日志。
 * 怎么判：
 *   - 读写文件、搜文件的工具看路径：落在这两处里面就拒；grep / glob 从 `prod/` 的上级目录往下搜也拒（会搜进去）；
 *   - 终端看命令文字：同时写了 `.fast-ai-cosmic` 和 `prod`，或者写了 monitor 登录文件名、读取进程类名，就拒。
 * 终端里拼字符串、绕环境变量这类刻意的写法拦不住；这道门守的是顺手直接读这条路。
 * 人自己配、自己登走的是 `/cosmic-prod-setup`、`/cosmic-monitor-login`，不经这里。
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { comparablePath, toolFilePath } from "../agent/tools/tool-path.ts";

/** cosmic 的本机目录：全局配置、缓存、生产排障配置都在下面 */
export const COSMIC_AGENT_DIR = join(homedir(), ".fast-ai-cosmic");

export const PROD_SECRET_CODE = "PROD_SECRET_OFF_LIMITS";

/** 一次文件或终端调用要碰的地方；不是这几种工具返回空 */
function touchedTargets(name: string, args: Record<string, unknown>): { paths: string[]; commands: string[] } {
	const text = (key: string) => (typeof args[key] === "string" ? [args[key] as string] : []);
	switch (name) {
		case "read":
		case "write":
		case "edit":
			return { paths: text("file_path"), commands: [] };
		case "grep":
			return { paths: text("path"), commands: [] };
		case "glob":
			return { paths: [...text("path"), ...text("pattern")], commands: [] };
		case "bash":
			return { paths: text("workdir"), commands: text("command") };
		default:
			return { paths: [], commands: [] };
	}
}

function under(dir: string, file: string): boolean {
	return file === dir || file.startsWith(`${dir}/`);
}

/** 一段命令文字是不是在碰生产凭据 */
export function commandTouchesProdSecrets(command: string): boolean {
	const text = command.replace(/\\/g, "/").toLowerCase();
	if (text.includes("prod.monitor-session") || /\bprodreader\b/.test(text)) return true;
	return text.includes(".fast-ai-cosmic") && /\bprod\b/.test(text);
}

/**
 * 碰到生产凭据时返回拒绝理由，没碰返回 null。
 * `extraPaths`：apply_patch 这类自己带路径的写入，由调用方先拆好传进来。
 */
export function prodSecretRefusal(
	name: string,
	args: unknown,
	root: string,
	agentDir: string,
	extraPaths: readonly string[] = [],
): string | null {
	const input = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
	const { paths, commands } = touchedTargets(name, input);
	const home = comparablePath(agentDir).replace(/\/$/, "");
	const prodDir = `${home}/prod`;
	const cacheDir = `${home}/cache/`;
	const recursive = name === "grep" || name === "glob";
	const hit = [...paths, ...extraPaths].some((raw) => {
		// glob 的模式里带通配符：只取通配符前面那段当目录
		const plain = name === "glob" ? (raw.split(/[*?[{]/)[0] ?? "") : raw;
		if (plain === "") return false;
		const file = comparablePath(toolFilePath(plain, root));
		if (under(prodDir, file)) return true;
		if (file.startsWith(cacheDir) && /^[^/]+\/prod(\/|$)/.test(file.slice(cacheDir.length))) return true;
		return recursive && under(file, prodDir);
	});
	if (!hit && !commands.some(commandTouchesProdSecrets)) return null;
	return `${agentDir} 下的 prod/ 和 cache/<RuntimeKey>/prod/ 存着生产库账号、monitor 登录和生产读取进程的口令，终端和文件工具不能碰`;
}
