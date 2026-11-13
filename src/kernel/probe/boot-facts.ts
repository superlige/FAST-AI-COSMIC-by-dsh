/**
 * 常驻 JVM 开机经过：从它的日志里只挑它自己写的那几行（`[PSERVER] ` 开头），
 * 整理成首页进程树要画的几项。
 *
 * 日志里绝大多数是平台和 JRebel 的输出（警告、zookeeper 断线重连的堆栈、GBK 乱码），
 * 一次开机七百多行里宿主自己只写九行左右。顺序由宿主的启动代码定死：
 * 启动中 → 编译器就绪 → 监视代码模块 → 换类方式 → 元数据预热完成 → 就绪，
 * 所以没写到的那一项就是正在做的那一项。
 */

const PREFIX = "[PSERVER] ";

export interface ServerBootFacts {
	/** 写过「启动中」：这份日志确实是宿主的。 */
	started: boolean;
	/** 编译器 classpath 上有几项；没写到是 null。 */
	classpath: number | null;
	/** 盯着的代码模块目录或 jar，原样路径。 */
	watched: string[];
	/** 换类方式（jrebel / hotswap …）；没写到是 null。 */
	hotswap: string | null;
	/** 元数据预热用了多少毫秒；没写到是 null。 */
	warmMs: number | null;
	/** 「就绪」那一行；没写到是 null。 */
	ready: { port: number; account: string; pid: number } | null;
	/** 最近一次热替换：变了几个类、换了几个、用了多久。 */
	lastSwap: { changed: number; swapped: number; ms: number } | null;
	/** 就绪之前宿主自己报的问题（`!! ` 开头），原话去掉前缀。 */
	warnings: string[];
	/** 写过「自动退出」或「收到 SHUTDOWN」：这台 JVM 已经不在了。 */
	exited: boolean;
}

export function parseServerBoot(text: string): ServerBootFacts {
	const facts: ServerBootFacts = {
		started: false,
		classpath: null,
		watched: [],
		hotswap: null,
		warmMs: null,
		ready: null,
		lastSwap: null,
		warnings: [],
		exited: false,
	};
	let at = text.indexOf(PREFIX);
	while (at !== -1) {
		const end = text.indexOf("\n", at);
		const line = text.slice(at + PREFIX.length, end === -1 ? text.length : end).replace(/\r$/, "");
		at = end === -1 ? -1 : text.indexOf(PREFIX, end);
		note(facts, line);
	}
	return facts;
}

function note(facts: ServerBootFacts, line: string): void {
	if (line.startsWith("启动中")) {
		// 同一份日志只写一次开机；万一出现第二次（写日志的方式变了），以最新那次为准。
		Object.assign(facts, parseServerBoot(""), { started: true });
		return;
	}
	if (line.startsWith("!! ")) {
		if (facts.ready === null) facts.warnings.push(line.slice(3).trim());
		return;
	}
	const classpath = /^编译器就绪，classpath (\d+) 项/.exec(line);
	if (classpath !== null) {
		facts.classpath = Number(classpath[1]);
		return;
	}
	const watched = /^监视 (.+?) mtime=/.exec(line);
	if (watched !== null) {
		facts.watched.push(watched[1] as string);
		return;
	}
	const hotswap = /^换类方式：(.+)$/.exec(line);
	if (hotswap !== null) {
		facts.hotswap = (hotswap[1] as string).trim();
		return;
	}
	const warm = /^元数据预热完成 (\d+) ms/.exec(line);
	if (warm !== null) {
		facts.warmMs = Number(warm[1]);
		return;
	}
	const ready = /^就绪 port=(\d+) account=(\S*) pid=(\d+)/.exec(line);
	if (ready !== null) {
		facts.ready = { port: Number(ready[1]), account: ready[2] as string, pid: Number(ready[3]) };
		return;
	}
	const swap = /^热替换（[^）]*）：变了 (\d+) 个类，换了 (\d+) 个，(\d+) ms/.exec(line);
	if (swap !== null) {
		facts.lastSwap = { changed: Number(swap[1]), swapped: Number(swap[2]), ms: Number(swap[3]) };
		return;
	}
	if (line.startsWith("空闲超过") || line.startsWith("收到 SHUTDOWN")) facts.exited = true;
}

/**
 * 读日志时最多读多少：开机那几行在头上，热替换写在后面。日志跑得久了会有几 MB 的平台噪音，
 * 超过这个数就只读头和尾各一半——中间是长时间运行的噪音，宿主自己的行几乎都在两头。
 */
export const BOOT_LOG_READ_BYTES = 2 * 1024 * 1024;
