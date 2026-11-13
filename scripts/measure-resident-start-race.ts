/**
 * S58 的尺子：常驻苍穹进程还在启动（约半分钟，端口没开）时又来一个要用它的，会不会再起一个；
 * 登记指着一个不在了的进程时，端口上还在跑的那个认不认得出来。
 *
 * 用法：
 *   node --experimental-strip-types scripts/measure-resident-start-race.ts <工程目录>
 *     [--gap 4] [--processes] [--force-second] [--keep] [--json]
 *
 * 做的事（探针全是只读的 EnvDiagProbe，走工具用的同一个入口）：
 *   1. 这个版本的常驻进程要是在跑，先停掉（按版本号认，只动本版本自己的）。
 *   2. 发第一个探针；隔 `--gap` 秒（默认 4，那时第一个还在启动）再发第二个。默认两个在同一个进程里
 *      （界面开机自检和恢复会话各触发一次就是这样）；`--processes` 改成两个各在一个进程里（两个窗口、
 *      或者界面开着又跑一次命令行）。
 *      第二个发出 10 秒后（还在启动）查一次状态，记下工具怎么说它。
 *   3. 两个都回来后数：这个版本起了几个进程、登记写的进程号、占着端口答话的进程号、认不认得出归属。
 *   4. 让登记指着一个不在了的进程：多起的那个（没占到端口的）结束掉——真机上它是空闲 30 分钟后自己退出，
 *      这里直接结束，不等半小时；没有多起的，就把登记和心跳文件改成一个不存在的进程号（事故里登记最后的样子）。
 *      再看一次归属，再发一个探针，看它搭常驻进程还是另起冷进程、用了多久、登记补回来没有。
 *   5. `--force-second`：绕过工具，直接照同一套启动参数再起一个同版本的进程，看它多久退出、退出码多少
 *      （最多等 120 秒，还活着就结束它）；再看登记和心跳文件对不对得上占端口的那个。
 *   6. 收尾：停掉这个版本的常驻进程（`--keep` 留着）。
 *
 * 口径和基线见 `docs/S58-resident-ownership.md` §2。
 */

import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { probe } from "../src/kernel/commands/probe.ts";
import { probeServer } from "../src/kernel/commands/probe-server.ts";
import { baseChildEnv } from "../src/kernel/context.ts";
import { openProject } from "../src/kernel/open-project.ts";
import { commandLineMatches } from "../src/kernel/probe/local-jvms.ts";
import {
	ping,
	readManifest,
	residentPort,
	residentServerArgs,
	resolveHotSwap,
	stopServer,
} from "../src/kernel/probe/server.ts";
import { findToolsJar } from "../src/kernel/toolchain.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";

const argv = process.argv.slice(2);
const one = (name: string): string | undefined => {
	const at = argv.indexOf(name);
	return at < 0 ? undefined : argv[at + 1];
};
const project = argv[0];
if (project === undefined || project.startsWith("--")) {
	console.error(
		"用法：measure-resident-start-race.ts <工程目录> [--gap 4] [--processes] [--force-second] [--keep] [--json]",
	);
	process.exit(2);
}
const gapMs = Number(one("--gap") ?? "4") * 1000;

const opened = await openProject({
	projectRoot: resolve(project),
	agentConfigDir: join(homedir(), ".fast-ai-cosmic"),
	cacheRoot: join(homedir(), ".fast-ai-cosmic", "cache"),
	agentVersion: "0.0.0-dev",
	resources: EMBEDDED_RESOURCES,
});
const ctx = opened.ctx;
const healthFile = `${ctx.layout.serverPid}.health`;

interface Outcome {
	path: string;
	ms: number;
}
async function ask(): Promise<Outcome> {
	const started = performance.now();
	const result = await probe(ctx, "EnvDiagProbe", { env: {}, countRepeats: false, coldFallback: false } as never);
	return {
		path: result.ok ? String((result.value as { path?: string }).path ?? "") : `失败 ${result.error.code}`,
		ms: Math.round(performance.now() - started),
	};
}

if (argv.includes("--child")) {
	console.log(JSON.stringify(await ask()));
	process.exit(0);
}

function askInChild(): Promise<Outcome> {
	return new Promise((done) => {
		const child = spawn(
			process.execPath,
			["--experimental-strip-types", fileURLToPath(import.meta.url), resolve(project as string), "--child"],
			{ stdio: ["ignore", "pipe", "inherit"] },
		);
		let out = "";
		child.stdout.on("data", (chunk: Buffer) => {
			out += chunk.toString("utf8");
		});
		child.on("close", () => {
			try {
				done(JSON.parse(out.trim().split("\n").pop() ?? "") as Outcome);
			} catch {
				done({ path: "子进程没给出结果", ms: 0 });
			}
		});
	});
}

/** 这个版本的常驻进程，本机现在有哪几个（按命令行里的主类和版本号认）。 */
async function ownJvms(): Promise<number[]> {
	const list = await ctx.ports.proc.listJava();
	if (list === null) throw new Error("本机进程清单查不了，这把尺子量不了");
	return list
		.filter((process) => commandLineMatches("probe", ctx.runtimeKeyId, process.commandLine))
		.map((process) => process.pid);
}
async function listening(): Promise<number | null> {
	const reply = await ping(ctx);
	const pid = /^pid=(\d+)$/m.exec(reply.body)?.[1];
	return reply.ok && pid !== undefined ? Number(pid) : null;
}
async function ownership(): Promise<string> {
	const status = await probeServer(ctx, "status");
	return status.ok ? status.value.ownership : `失败 ${status.error.code}`;
}
const healthPid = (): number | null => {
	const pid = /^pid=(\d+)$/m.exec(ctx.ports.fs.read(healthFile))?.[1];
	return pid === undefined ? null : Number(pid);
};

if ((await ownJvms()).length > 0) await stopServer(ctx);
for (const pid of await ownJvms()) await ctx.ports.proc.kill(pid, true);

const inChildren = argv.includes("--processes");
const first = inChildren ? askInChild() : ask();
await new Promise((done) => setTimeout(done, gapMs));
const second = inChildren ? askInChild() : ask();
await new Promise((done) => setTimeout(done, 10_000));
const during = await probeServer(ctx, "status");
const saidWhileStarting = during.ok
	? `${during.value.state ?? (during.value.running ? "在跑" : "没在跑")}：${during.value.notes[0] ?? "（没有说明）"}`
	: `失败 ${during.error.code}`;
const asked = await Promise.all([first, second]);

const started = await ownJvms();
const recorded = readManifest(ctx)?.pid ?? null;
const onPort = await listening();
const ownershipAfterStart = await ownership();

// 没占到端口的那些：真机上空闲 30 分钟自己退出，这里直接结束
const extras = started.filter((pid) => pid !== onPort);
for (const pid of extras) await ctx.ports.proc.kill(pid, true);
// 没有多起的：把登记和心跳文件改成一个不存在的进程号，和事故里登记最后的样子一样
let recordBroken = false;
const before = readManifest(ctx);
if (before !== null && onPort !== null && ctx.ports.proc.isAlive(before.pid)) {
	let gone = 99_996;
	while (ctx.ports.proc.isAlive(gone)) gone -= 4;
	ctx.ports.fs.write(ctx.layout.serverPid, JSON.stringify({ ...before, pid: gone }));
	ctx.ports.fs.write(healthFile, `pid=${String(gone)}\nkey=${ctx.runtimeKeyId}\nport=1\n`);
	recordBroken = true;
}
const ownershipAfterExit = await ownership();
const next = await ask();
const recordedAfter = readManifest(ctx)?.pid ?? null;
const healthAfter = healthPid();

interface ForcedSecond {
	exitedAfterMs: number | null;
	exitCode: number | null;
	recorded: number | null;
	health: number | null;
	onPort: number | null;
}
let forced: ForcedSecond | null = null;
if (argv.includes("--force-second")) {
	const tools = await findToolsJar(ctx);
	if (tools === null) throw new Error("找不到 tools.jar，起不了第二个");
	const log = openSync(join(ctx.layout.serverLog, "..", "probe-server-second.log"), "w");
	const startedAt = performance.now();
	const child = spawn("java", residentServerArgs(ctx, resolveHotSwap(ctx), tools), {
		cwd: ctx.projectRoot,
		env: { ...baseChildEnv(ctx), PROBE_SERVER_PORT: String(residentPort(ctx)) },
		stdio: ["ignore", log, log],
	});
	const exit = await new Promise<number | null>((done) => {
		const timer = setTimeout(() => {
			child.kill();
			done(null);
		}, 120_000);
		child.on("exit", (code) => {
			clearTimeout(timer);
			done(code);
		});
	});
	closeSync(log);
	const exitedAfterMs = exit === null ? null : Math.round(performance.now() - startedAt);
	// 第二个一启动就把心跳文件盖成了自己的；问一次端口，看补回来没有
	const stillOnPort = await listening();
	forced = {
		exitedAfterMs,
		exitCode: exit,
		recorded: readManifest(ctx)?.pid ?? null,
		health: healthPid(),
		onPort: stillOnPort,
	};
}

if (!argv.includes("--keep")) {
	await stopServer(ctx);
	for (const pid of await ownJvms()) await ctx.ports.proc.kill(pid, true);
}

const report = {
	project: resolve(project),
	runtimeKey: ctx.runtimeKeyId,
	mode: inChildren ? "两个进程" : "同一个进程",
	gapSeconds: gapMs / 1000,
	asked,
	saidWhileStarting,
	started: started.length,
	recorded,
	onPort,
	recordMatchesPort: recorded !== null && recorded === onPort,
	ownershipAfterStart,
	extrasEnded: extras.length,
	recordBroken,
	ownershipAfterExit,
	recordedAfter,
	healthAfter,
	next,
	forced,
};

if (argv.includes("--json")) {
	console.log(JSON.stringify(report, null, 2));
} else {
	console.log(`${report.runtimeKey}（${report.mode}，第二个晚 ${String(report.gapSeconds)} 秒发）`);
	console.log(
		`  两个探针：${asked.map((outcome) => `${outcome.path} ${(outcome.ms / 1000).toFixed(1)} 秒`).join("；")}`,
	);
	console.log(`  启动途中查状态，工具说：${saidWhileStarting}`);
	console.log(
		`  这个版本起了 ${String(report.started)} 个进程；登记写的 ${String(recorded)}，占着端口的 ${String(onPort)}` +
			`（${report.recordMatchesPort ? "同一个" : "不是同一个"}）；归属：${ownershipAfterStart}`,
	);
	console.log(
		`  登记指着一个不在了的进程时（${recordBroken ? "没有多起的，登记是这把尺子改坏的" : `多起的 ${String(report.extrasEnded)} 个结束后`}）：` +
			`归属 ${ownershipAfterExit}；再发一个探针走 ${next.path}，${(next.ms / 1000).toFixed(1)} 秒；` +
			`之后登记写的 ${String(recordedAfter)}，心跳文件写的 ${String(healthAfter)}`,
	);
	if (forced !== null) {
		console.log(
			`  绕过工具再起一个同版本的：${forced.exitedAfterMs === null ? "120 秒后还活着（已结束它）" : `${(forced.exitedAfterMs / 1000).toFixed(1)} 秒后自己退出，退出码 ${String(forced.exitCode)}`}；` +
				`之后占着端口的 ${String(forced.onPort)}，登记写的 ${String(forced.recorded)}，心跳文件写的 ${String(forced.health)}`,
		);
	}
}
