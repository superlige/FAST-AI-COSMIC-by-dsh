/**
 * 尺子：一个苍穹进程在某段时间里到底在忙什么——隔一会儿抓一次线程栈，数时间落在哪类事情上。
 *
 *   node scripts/measure-jvm-stacks.mjs [--main CosmicProbeServer] [--thread "cosmic-probe|main"]
 *     [--seconds 60] [--interval 400] [--until "<日志里的一句话>" --log <日志文件>] [--jdk <JDK 的 bin 目录>]
 *     [--top 12] [--frames 14]
 *
 * 先启动这把尺子，再去做要量的事（起常驻进程、跑一个操作）。它等到主类名里带 --main 的进程出现，
 * 之后每隔 --interval 毫秒 jstack 一次，只看线程名匹配 --thread 的线程，到 --seconds 秒、进程退出、
 * 或者日志里出现 --until 那句话为止。
 *
 * 报两样：
 * - 按「在干什么」分：等数据库、等 redis、等 zookeeper、等别的网络、装类（含读 jar、JRebel）、编译 Java、
 *   解元数据（XML / JSON 反序列化）、其余在算；每类占多少次采样（次数 × 间隔 ≈ 时间）；
 * - 最常见的几处，各打出栈顶两层，再打出平台和宿主这一侧最靠上的 --frames 层（发 SQL、抢锁、读缓存这些
 *   谁都会走的底层不算），给人看是谁叫它去做的。
 *
 * 采样看到的是「那一刻栈顶在哪」，短于采样间隔的事会漏；数的是比例，不是精确毫秒。空闲等任务的线程不算。
 * 只读：只调 jps、jstack。口径和基线见 `docs/S60-resident-startup-and-first-touch.md` §2。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const one = (name, fallback) => {
	const at = argv.indexOf(name);
	return at >= 0 ? argv[at + 1] : fallback;
};
const mainClass = one("--main", "CosmicProbeServer");
const threadPattern = new RegExp(one("--thread", "cosmic-probe|^main$"));
const seconds = Number(one("--seconds", "60"));
const interval = Number(one("--interval", "400"));
const until = one("--until");
const logFile = one("--log");
const top = Number(one("--top", "12"));
const frameCount = Number(one("--frames", "14"));
const jdkCandidates = [
	one("--jdk"),
	process.env.JAVA_HOME && join(process.env.JAVA_HOME, "bin"),
	"D:/Program Files/Java/jdk1.8.0_191/bin",
];
const jdk = jdkCandidates.find(
	(dir) => dir && existsSync(join(dir, process.platform === "win32" ? "jstack.exe" : "jstack")),
);
if (jdk === undefined) {
	console.error("找不到 jstack：用 --jdk 指到 JDK 的 bin 目录");
	process.exit(2);
}
const tool = (name) => join(jdk, process.platform === "win32" ? `${name}.exe` : name);
const sleep = (ms) => new Promise((go) => setTimeout(go, ms));
const run = (file, args) => {
	try {
		return execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15000 });
	} catch {
		return "";
	}
};

/** 栈里从上往下第一处认得出的事：等谁、在装类、在编译…… */
const KINDS = [
	["等数据库", /^(com\.mysql\.|com\.zaxxer\.hikari\.|kd\.bos\.ksql\.|org\.mariadb\.)/],
	["等 redis", /^(redis\.clients\.|io\.lettuce\.|org\.redisson\.)/],
	["等 zookeeper", /^(org\.apache\.zookeeper\.|org\.apache\.curator\.)/],
	["编译 Java", /^(com\.sun\.tools\.javac\.|javax\.tools\.)/],
	["装类（JRebel）", /^(org\.zeroturnaround\.|com\.zeroturnaround\.)/],
	[
		"解元数据",
		/^(kd\.bos\.dataentity\.serialization\.|kd\.bos\.metadata\.|javax\.xml\.|com\.sun\.org\.apache\.xerces\.|com\.alibaba\.fastjson\.|com\.fasterxml\.jackson\.)/,
	],
];
const NETWORK_LEAF =
	/^(java\.net\.Socket|java\.net\.PlainSocketImpl|java\.net\.DualStackPlainSocketImpl|sun\.nio\.ch\.|java\.net\.Inet)/;
const CLASSLOAD =
	/^(java\.lang\.ClassLoader\.|java\.net\.URLClassLoader|sun\.misc\.URLClassPath|java\.util\.zip\.|java\.util\.jar\.|sun\.misc\.Launcher|java\.lang\.Class\.forName)/;
const PLATFORM = /^(kd\.|Cosmic|cosmic\.)/;
const PLUMBING =
	/^kd\.bos\.(ksql|db|dlock|orm|dataentity|cache|redis|bundle|util|threads|context|trace|logging|instance|extension)\./;
const IDLE = /^(sun\.misc\.Unsafe\.park|java\.lang\.Object\.wait|java\.lang\.Thread\.sleep)/;
const WAITING = /^(sun\.misc\.Unsafe\.park|java\.lang\.Object\.wait|java\.net\.\w+\.accept0)/;
const HOST_WAIT = /^(CosmicProbeServer\.(main|runInPool|serve|handle)|CosmicProbe\.runInPool)/;

function kindOf(frames) {
	const leaf = frames[0] ?? "";
	const waitingOnNetwork = NETWORK_LEAF.test(leaf);
	for (const frame of frames.slice(0, 40)) {
		for (const [name, pattern] of KINDS) {
			if (!pattern.test(frame)) continue;
			// 解元数据、编译只有真在算时才算；人在网络上等就归给等的那一方
			if (waitingOnNetwork && !name.startsWith("等")) continue;
			return name;
		}
		if (!waitingOnNetwork && CLASSLOAD.test(frame)) return "装类（读 jar）";
	}
	return waitingOnNetwork ? "等别的网络" : "其余在算";
}

function parse(dump) {
	const threads = [];
	let current = null;
	for (const line of dump.split(/\r?\n/)) {
		const head = /^"([^"]*)"/.exec(line);
		if (head !== null) {
			current = { name: head[1], frames: [] };
			threads.push(current);
			continue;
		}
		const frame = /^\s+at (\S+)\(/.exec(line);
		if (frame !== null && current !== null) current.frames.push(frame[1]);
	}
	return threads;
}

let pid = null;
const waitStarted = Date.now();
while (pid === null && Date.now() - waitStarted < 180000) {
	const line = run(tool("jps"), ["-l"])
		.split(/\r?\n/)
		.find((row) => row.includes(mainClass));
	if (line) pid = line.trim().split(/\s+/)[0];
	else await sleep(300);
}
if (pid === null) {
	console.error(`等了 3 分钟没有主类带 ${mainClass} 的进程`);
	process.exit(1);
}
console.error(`进程 ${pid}，开始采样`);

const kinds = new Map();
const stacks = new Map();
let samples = 0;
let busy = 0;
const started = Date.now();
while (Date.now() - started < seconds * 1000) {
	const tick = Date.now();
	const dump = run(tool("jstack"), [pid]);
	if (dump === "") {
		if (!run(tool("jps"), ["-l"]).includes(`${pid} `)) break;
	} else {
		samples += 1;
		for (const thread of parse(dump)) {
			// 线程名里的请求号、时刻每次都不一样，去掉再比
			const name = thread.name.replace(/\/traceId:[^/]*\/time:\d+/, "").replace(/-\d+$/, "");
			if (!threadPattern.test(name) || thread.frames.length === 0) continue;
			if (IDLE.test(thread.frames[0]) && !thread.frames.some((frame) => /^(kd\.|Cosmic|cosmic\.)/.test(frame)))
				continue;
			// 宿主自己的两种等：等下一个请求进来、等池子里的线程把活干完（干活的那个线程另算）
			if (
				HOST_WAIT.test(thread.frames.find((frame) => /^Cosmic/.test(frame)) ?? "") &&
				WAITING.test(thread.frames[0])
			)
				continue;
			busy += 1;
			const kind = kindOf(thread.frames);
			kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
			// 同一件事的栈顶几层会抖，按「第一处不是底层设施的平台或宿主方法」归并：
			// 发 SQL、抢锁、读缓存这些谁都会走的层不算，要看的是谁叫它去做的
			const platform = thread.frames.filter((frame) => PLATFORM.test(frame));
			const callers = platform.filter((frame) => !PLUMBING.test(frame));
			const owner = callers[0] ?? platform[0] ?? thread.frames[0];
			const key = `${kind}｜${owner}`;
			const entry = stacks.get(key) ?? {
				count: 0,
				thread: name,
				frames: [
					...thread.frames.slice(0, 2),
					"…",
					...(callers.length > 0 ? callers : platform).slice(0, frameCount),
				],
			};
			entry.count += 1;
			stacks.set(key, entry);
		}
	}
	if (until && logFile && existsSync(logFile) && readFileSync(logFile, "utf8").includes(until)) break;
	const left = interval - (Date.now() - tick);
	if (left > 0) await sleep(left);
}

const elapsed = (Date.now() - started) / 1000;
const perSample = samples > 0 ? elapsed / samples : 0;
console.log(
	`采了 ${String(samples)} 次，共 ${elapsed.toFixed(1)} 秒（平均 ${perSample.toFixed(2)} 秒一次）；匹配的线程在忙 ${String(busy)} 次`,
);
for (const [kind, count] of [...kinds].sort((a, b) => b[1] - a[1])) {
	console.log(
		`  ${kind.padEnd(10)} ${String(count).padStart(4)} 次　约 ${(count * perSample).toFixed(1)} 秒（${String(Math.round((count / Math.max(1, busy)) * 100))}%）`,
	);
}
console.log(`最常见的 ${String(top)} 处：`);
for (const [key, entry] of [...stacks].sort((a, b) => b[1].count - a[1].count).slice(0, top)) {
	console.log(`  ${String(entry.count).padStart(4)} 次　${key}　[${entry.thread}]`);
	for (const frame of entry.frames) console.log(`           ${frame}`);
}
