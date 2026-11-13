/**
 * Effect ports (S3.2).
 *
 * Every side effect the fast -> probe chain performs goes through one of these
 * interfaces, and the concrete implementations live at the bottom of this file.
 * The frozen driver.mjs called spawnSync / readFileSync / process.env directly
 * from command bodies, which made the commands untestable without a real Cosmic
 * install and made "did this call mutate global state" unanswerable.
 *
 * The ports are deliberately narrow. In particular ProcessPort does NOT accept a
 * command string: it takes an executable plus an argument array, so no caller --
 * and no model-supplied argument reaching a caller -- can smuggle a shell
 * fragment through it (D1). The single place a shell is used is the Windows
 * gradlew.bat launch, and that is expressed as an explicit flag on the spec
 * rather than as free-form text.
 */

import { spawn } from "node:child_process";
import {
	closeSync,
	type Dirent,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { dirname } from "node:path";

// ---------------------------------------------------------------- filesystem

export interface DirEntry {
	name: string;
	isDirectory: boolean;
}

export interface FsPort {
	exists(path: string): boolean;
	/** File content, or "" when the file is absent. Matches the frozen read helper. */
	read(path: string): string;
	/** Raw bytes, or null when the file is absent. Used for source/class evidence. */
	readBytes(path: string): Uint8Array | null;
	write(path: string, content: string): void;
	/** Atomic create; false means another process already owns the path. */
	tryCreate(path: string, content: string): boolean;
	/**
	 * Atomic move. False when the source is absent, so a caller can only ever act
	 * on the exact bytes it moved out of the way -- the compare/delete race a
	 * stale-lock cleanup would otherwise have. Callers pass a unique target name;
	 * POSIX rename replaces an existing target and Windows refuses it, and this
	 * port does not paper over that difference.
	 */
	tryRename(from: string, to: string): boolean;
	/** Modification time in ms, or null when the path does not exist. */
	mtimeMs(path: string): number | null;
	readDir(path: string): DirEntry[];
	mkdirp(path: string): void;
	remove(path: string): void;
	/** Java sources under a directory tree. Used by config detection. */
	listJavaFiles(dir: string): string[];
}

export const nodeFs: FsPort = {
	exists: (path) => existsSync(path),
	read(path) {
		try {
			return readFileSync(path, "utf8");
		} catch {
			return "";
		}
	},
	readBytes(path) {
		try {
			return readFileSync(path);
		} catch {
			return null;
		}
	},
	write(path, content) {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content, "utf8");
	},
	tryCreate(path, content) {
		mkdirSync(dirname(path), { recursive: true });
		let fd: number | undefined;
		try {
			fd = openSync(path, "wx");
			writeFileSync(fd, content, "utf8");
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
			throw error;
		} finally {
			if (fd !== undefined) closeSync(fd);
		}
	},
	tryRename(from, to) {
		try {
			mkdirSync(dirname(to), { recursive: true });
			renameSync(from, to);
			return true;
		} catch {
			return false;
		}
	},
	mtimeMs(path) {
		try {
			return statSync(path).mtimeMs;
		} catch {
			return null;
		}
	},
	readDir(path) {
		let entries: Dirent[] = [];
		try {
			entries = readdirSync(path, { withFileTypes: true });
		} catch {
			return [];
		}
		return entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }));
	},
	mkdirp(path) {
		mkdirSync(path, { recursive: true });
	},
	remove(path) {
		try {
			rmSync(path, { recursive: true, force: true });
		} catch {
			// Removal is best-effort everywhere it is used (stale pid files, temp dirs).
		}
	},
	listJavaFiles(dir) {
		const out: string[] = [];
		const walk = (current: string): void => {
			let entries: Dirent[] = [];
			try {
				entries = readdirSync(current, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				const full = `${current}/${entry.name}`;
				if (entry.isDirectory()) walk(full);
				else if (entry.name.endsWith(".java")) out.push(full);
			}
		};
		walk(dir);
		return out;
	},
};

// ------------------------------------------------------------------ process

export interface ProcessSpec {
	/** Executable name or absolute path. Never a command line. */
	command: string;
	args: readonly string[];
	cwd: string;
	/** Complete environment for the child. Callers compose it; nothing is inherited implicitly. */
	env: Readonly<Record<string, string>>;
	/**
	 * Windows-only escape hatch for gradlew.bat, which cmd.exe must interpret.
	 * Kept as a boolean rather than a shell string so no argument can become one.
	 */
	windowsBatch?: boolean;
	maxBufferBytes?: number;
}

/** 本机一个 java 进程：进程号、完整命令行、占的内存、什么时候起的。 */
export interface JavaProcess {
	pid: number;
	commandLine: string;
	/** 常驻内存（Windows 的工作集），字节；取不到是 null。 */
	memoryBytes: number | null;
	startedAtMs: number | null;
}

export interface ProcessResult {
	/** Null when the process could not be spawned at all. */
	status: number | null;
	stdout: string;
	stderr: string;
	/** Set when spawning itself failed (ENOENT for a missing javac, for example). */
	spawnError: string | null;
}

export interface DetachedSpec extends ProcessSpec {
	/** Both stdout and stderr are appended here; the child is detached and unref'd. */
	logFile: string;
}

export interface ProcessPort {
	/**
	 * 前台子进程，唯一一条。没有同步版本，是故意的。
	 *
	 * 这里曾经并排放着 `run`（spawnSync）和 `runAsync`。两扇门长得一样，代价差一个数量级：
	 * spawnSync 期间整条 Node 事件循环停住，而这些子进程是 javac、gradle、苍穹 JVM——
	 * 几十秒到几分钟。TUI 在那段时间不重绘、不回显按键、收不到 Esc，跟死了没有区别，
	 * 于是每加一处新调用就是一次「随手选了同步那扇门」的机会。摘掉之后没有门可选。
	 */
	runAsync(spec: ProcessSpec, signal?: AbortSignal): Promise<ProcessResult>;
	/** PID of the current agent process, recorded in cross-process lock manifests. */
	currentPid(): number;
	/** Starts a background process (the resident probe JVM) and returns its pid. */
	startDetached(spec: DetachedSpec): { pid: number | null; error: string | null };
	/** True when a pid names a live process. Never used to kill by port. */
	isAlive(pid: number): boolean;
	/**
	 * 本机所有 java 进程。查不了（系统命令起不来、超时）给 null，调用方要当「不知道」处理，
	 * 不能当「没有」。一进程号只说明「有个进程」，命令行才说明它是谁——
	 * 进程号会被系统分给别的程序，按号停进程之前要靠这个核对身份。
	 */
	listJava(): Promise<JavaProcess[] | null>;
	/**
	 * 结束一个进程。Windows 上硬杀要等 `taskkill /T` 收完整棵进程树，那是一个子进程，
	 * 所以是异步的：等它的时候界面照常重画、照常收按键。最多等 `KILL_WAIT_MS`，过了就不等。
	 */
	kill(pid: number, hard: boolean): Promise<void>;
}

/** 等 taskkill 的上限。它平常不到一秒；卡住了也不能让调用方一直等。 */
const KILL_WAIT_MS = 10_000;

const DEFAULT_MAX_BUFFER = 256 * 1024 * 1024;

export const nodeProcess: ProcessPort = {
	runAsync(spec, signal) {
		return new Promise<ProcessResult>((resolve) => {
			const stdout: Buffer[] = [];
			const stderr: Buffer[] = [];
			let stdoutBytes = 0;
			let stderrBytes = 0;
			let settled = false;
			let overflow: string | null = null;
			const maxBuffer = spec.maxBufferBytes ?? DEFAULT_MAX_BUFFER;
			const child = spawn(spec.windowsBatch ? `"${spec.command}"` : spec.command, [...spec.args], {
				cwd: spec.cwd,
				env: { ...spec.env },
				shell: spec.windowsBatch === true,
				stdio: ["ignore", "pipe", "pipe"],
			});
			const finish = (result: ProcessResult): void => {
				if (settled) return;
				settled = true;
				signal?.removeEventListener("abort", abort);
				resolve(result);
			};
			let killing = false;
			const stop = (reason: string): void => {
				if (overflow === null) overflow = reason;
				// 输出超量后每来一块输出都会走到这里；进程树只收一次。
				if (killing || child.pid === undefined) return;
				killing = true;
				void nodeProcess.kill(child.pid, true);
			};
			const abort = (): void => stop("构建已取消");
			child.stdout?.on("data", (chunk: Buffer) => {
				stdoutBytes += chunk.length;
				if (stdoutBytes + stderrBytes > maxBuffer) stop(`子进程输出超过 ${String(maxBuffer)} 字节`);
				else stdout.push(chunk);
			});
			child.stderr?.on("data", (chunk: Buffer) => {
				stderrBytes += chunk.length;
				if (stdoutBytes + stderrBytes > maxBuffer) stop(`子进程输出超过 ${String(maxBuffer)} 字节`);
				else stderr.push(chunk);
			});
			child.on("error", (error) => finish({ status: null, stdout: "", stderr: "", spawnError: error.message }));
			child.on("close", (status) =>
				finish({
					status: overflow === null ? status : 1,
					stdout: Buffer.concat(stdout).toString("utf8").replace(/\r\n/g, "\n"),
					stderr: `${Buffer.concat(stderr).toString("utf8")}${overflow === null ? "" : `\n${overflow}`}`.replace(
						/\r\n/g,
						"\n",
					),
					spawnError: null,
				}),
			);
			if (signal?.aborted === true) abort();
			else signal?.addEventListener("abort", abort, { once: true });
		});
	},
	currentPid() {
		return process.pid;
	},
	startDetached(spec) {
		let fd: number;
		try {
			mkdirSync(dirname(spec.logFile), { recursive: true });
			fd = openSync(spec.logFile, "w");
		} catch (error) {
			return { pid: null, error: error instanceof Error ? error.message : String(error) };
		}
		try {
			const child = spawn(spec.command, [...spec.args], {
				cwd: spec.cwd,
				env: { ...spec.env },
				detached: true,
				stdio: ["ignore", fd, fd],
			});
			child.unref();
			return { pid: child.pid ?? null, error: null };
		} catch (error) {
			return { pid: null, error: error instanceof Error ? error.message : String(error) };
		} finally {
			try {
				closeSync(fd);
			} catch {
				// The child holds its own duplicate of the descriptor.
			}
		}
	},
	listJava() {
		return process.platform === "win32" ? listJavaWindows() : listJavaPosix();
	},
	isAlive(pid) {
		if (!Number.isInteger(pid) || pid <= 0) return false;
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	},
	kill(pid, hard) {
		if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve();
		if (hard && process.platform === "win32") {
			// Cosmic spawns a thread tree; /T is what actually collects it.
			return new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, KILL_WAIT_MS);
				timer.unref?.();
				const done = (): void => {
					clearTimeout(timer);
					resolve();
				};
				try {
					const child = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
						stdio: "ignore",
						windowsHide: true,
					});
					child.on("error", done);
					child.on("close", done);
				} catch {
					done();
				}
			});
		}
		try {
			process.kill(pid, hard ? "SIGKILL" : "SIGTERM");
		} catch {
			// Already gone.
		}
		return Promise.resolve();
	},
};

/** 列 java 进程最多等多久。PowerShell 冷启动平常 0.5～1 秒。 */
const LIST_JAVA_WAIT_MS = 15_000;

/** 跑一个查询命令收它的标准输出；起不来、超时、退出码不为 0 都给 null。 */
function captureOutput(command: string, args: readonly string[]): Promise<string | null> {
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		let settled = false;
		const finish = (value: string | null): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(command, [...args], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
		} catch {
			resolve(null);
			return;
		}
		const timer = setTimeout(() => {
			child.kill();
			finish(null);
		}, LIST_JAVA_WAIT_MS);
		timer.unref?.();
		child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
		child.on("error", () => finish(null));
		child.on("close", (status) => finish(status === 0 ? Buffer.concat(chunks).toString("utf8") : null));
	});
}

const LIST_JAVA_POWERSHELL = [
	"[Console]::OutputEncoding=[Text.Encoding]::UTF8;",
	"$list=@(Get-CimInstance Win32_Process -Filter \"Name='java.exe' or Name='javaw.exe'\" | ForEach-Object {",
	"[pscustomobject]@{pid=[int]$_.ProcessId;cmd=[string]$_.CommandLine;mem=[double]$_.WorkingSetSize;",
	"start=$(if($_.CreationDate){([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()}else{$null})}});",
	"ConvertTo-Json -InputObject $list -Compress -Depth 2",
].join("");

async function listJavaWindows(): Promise<JavaProcess[] | null> {
	const out = await captureOutput("powershell", [
		"-NoProfile",
		"-NonInteractive",
		"-ExecutionPolicy",
		"Bypass",
		"-Command",
		LIST_JAVA_POWERSHELL,
	]);
	if (out === null) return null;
	try {
		const parsed: unknown = JSON.parse(out.trim() === "" ? "[]" : out);
		const rows = Array.isArray(parsed) ? parsed : [parsed];
		return rows.flatMap((row): JavaProcess[] => {
			if (row === null || typeof row !== "object") return [];
			const r = row as { pid?: unknown; cmd?: unknown; mem?: unknown; start?: unknown };
			if (typeof r.pid !== "number") return [];
			return [
				{
					pid: r.pid,
					commandLine: typeof r.cmd === "string" ? r.cmd : "",
					memoryBytes: typeof r.mem === "number" ? r.mem : null,
					startedAtMs: typeof r.start === "number" ? r.start : null,
				},
			];
		});
	} catch {
		return null;
	}
}

async function listJavaPosix(): Promise<JavaProcess[] | null> {
	const out = await captureOutput("ps", ["-eo", "pid=,rss=,etimes=,args="]);
	if (out === null) return null;
	const now = Date.now();
	return out.split("\n").flatMap((line): JavaProcess[] => {
		const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
		if (match === null || !/\bjava\b/.test(match[4] ?? "")) return [];
		return [
			{
				pid: Number(match[1]),
				commandLine: match[4] ?? "",
				memoryBytes: Number(match[2]) * 1024,
				startedAtMs: now - Number(match[3]) * 1000,
			},
		];
	});
}

// ---------------------------------------------------------------------- net

export interface SocketReply {
	ok: boolean;
	/** Reason the exchange failed; null on success. */
	why: string | null;
	text: string;
}

export interface NetPort {
	/** Sends newline-terminated request lines to 127.0.0.1:<port> and reads the full reply. */
	request(port: number, lines: readonly string[], timeoutMs: number): Promise<SocketReply>;
	/**
	 * True when a TCP connection to 127.0.0.1:<port> is accepted (S5.4).
	 *
	 * Separate from `request` because the debug node speaks HTTP: sending it the
	 * line protocol and waiting for a reply reports "not listening" for a node
	 * that is listening perfectly well. Connect-and-drop is the only question
	 * `node status` actually asks.
	 */
	canConnect(port: number, timeoutMs: number): Promise<boolean>;
}

export const nodeNet: NetPort = {
	request(port, lines, timeoutMs) {
		return new Promise<SocketReply>((resolve) => {
			const chunks: Buffer[] = [];
			let settled = false;
			const done = (value: SocketReply): void => {
				if (settled) return;
				settled = true;
				resolve(value);
			};
			const socket = createConnection({ host: "127.0.0.1", port });
			socket.setTimeout(timeoutMs, () => {
				socket.destroy();
				done({ ok: false, why: `等了 ${timeoutMs / 1000}s 没响应`, text: "" });
			});
			socket.on("error", (error: NodeJS.ErrnoException) => {
				done({ ok: false, why: error.code ?? String(error), text: "" });
			});
			// No end(): the protocol's END line marks the request boundary, which avoids
			// the platform differences in half-close behaviour.
			socket.on("connect", () => socket.write(`${lines.join("\n")}\n`));
			socket.on("data", (chunk: Buffer) => chunks.push(chunk));
			socket.on("close", () => {
				// Concat before decoding: a chunk boundary can fall inside a multi-byte character.
				done({ ok: true, why: null, text: Buffer.concat(chunks).toString("utf8") });
			});
		});
	},
	canConnect(port, timeoutMs) {
		return new Promise<boolean>((resolve) => {
			let settled = false;
			const done = (value: boolean): void => {
				if (settled) return;
				settled = true;
				resolve(value);
			};
			const socket = createConnection({ host: "127.0.0.1", port });
			const timer = setTimeout(() => {
				socket.destroy();
				done(false);
			}, timeoutMs);
			timer.unref?.();
			socket.on("connect", () => {
				clearTimeout(timer);
				socket.destroy();
				done(true);
			});
			socket.on("error", () => {
				clearTimeout(timer);
				done(false);
			});
		});
	},
};

// -------------------------------------------------------------------- clock

export interface ClockPort {
	now(): number;
	sleep(ms: number): Promise<void>;
}

export const nodeClock: ClockPort = {
	now: () => Date.now(),
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface Ports {
	fs: FsPort;
	proc: ProcessPort;
	net: NetPort;
	clock: ClockPort;
}

export const nodePorts: Ports = { fs: nodeFs, proc: nodeProcess, net: nodeNet, clock: nodeClock };
