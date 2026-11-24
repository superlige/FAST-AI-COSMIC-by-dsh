/**
 * In-memory kernel context for the S3 tests.
 *
 * Every port is faked, so a test can assert on the exact argv handed to javac,
 * the order the steps ran in, and what a second context does or does not see of
 * the first one's state. That last property is the point: the crosstalk tests
 * (S3.5) need two contexts side by side, which is impossible when commands read
 * process.env and module globals.
 */

import { join } from "node:path";
import type { KernelConfig } from "../../src/kernel/config/load-config.ts";
import { createContext, type KernelContext } from "../../src/kernel/context.ts";
import { type KernelLayout, kernelLayout } from "../../src/kernel/layout.ts";
import type {
	DetachedSpec,
	DirEntry,
	FsPort,
	JavaProcess,
	NetPort,
	Ports,
	ProcessPort,
	ProcessSpec,
} from "../../src/kernel/ports.ts";

const norm = (path: string): string => path.replace(/\\/g, "/").replace(/\/+$/, "");

/** Files are a flat map; directories exist implicitly when something lives under them. */
export class MemoryFs implements FsPort {
	readonly files = new Map<string, { content: string; mtimeMs: number }>();
	readonly dirs = new Set<string>();
	private tick = 1000;

	put(path: string, content: string, mtimeMs?: number): void {
		const key = norm(path);
		this.tick += 1;
		this.files.set(key, { content, mtimeMs: mtimeMs ?? this.tick });
		let parent = key.slice(0, key.lastIndexOf("/"));
		while (parent.length > 2) {
			this.dirs.add(parent);
			parent = parent.slice(0, parent.lastIndexOf("/"));
		}
	}

	exists(path: string): boolean {
		const key = norm(path);
		return this.files.has(key) || this.dirs.has(key);
	}

	read(path: string): string {
		return this.files.get(norm(path))?.content ?? "";
	}

	readBytes(path: string): Uint8Array | null {
		const content = this.files.get(norm(path))?.content;
		return content === undefined ? null : Buffer.from(content, "utf8");
	}

	write(path: string, content: string): void {
		this.put(path, content);
	}

	tryCreate(path: string, content: string): boolean {
		if (this.exists(path)) return false;
		this.put(path, content);
		return true;
	}

	tryRename(from: string, to: string): boolean {
		const source = this.files.get(norm(from));
		if (source === undefined || this.exists(to)) return false;
		this.files.delete(norm(from));
		this.put(to, source.content, source.mtimeMs);
		return true;
	}

	mtimeMs(path: string): number | null {
		const file = this.files.get(norm(path));
		if (file) return file.mtimeMs;
		return this.dirs.has(norm(path)) ? 0 : null;
	}

	readDir(path: string): DirEntry[] {
		const prefix = `${norm(path)}/`;
		const seen = new Map<string, boolean>();
		for (const key of [...this.files.keys(), ...this.dirs]) {
			if (!key.startsWith(prefix)) continue;
			const rest = key.slice(prefix.length);
			const slash = rest.indexOf("/");
			if (slash < 0) seen.set(rest, this.dirs.has(key) && !this.files.has(key));
			else seen.set(rest.slice(0, slash), true);
		}
		return [...seen].map(([name, isDirectory]) => ({ name, isDirectory }));
	}

	mkdirp(path: string): void {
		this.dirs.add(norm(path));
	}

	/** Recursive, like the real port's `rmSync(path, { recursive: true })`. */
	remove(path: string): void {
		const key = norm(path);
		const prefix = `${key}/`;
		this.files.delete(key);
		this.dirs.delete(key);
		for (const file of [...this.files.keys()]) if (file.startsWith(prefix)) this.files.delete(file);
		for (const dir of [...this.dirs]) if (dir.startsWith(prefix)) this.dirs.delete(dir);
	}

	listJavaFiles(dir: string): string[] {
		const prefix = `${norm(dir)}/`;
		return [...this.files.keys()].filter((key) => key.startsWith(prefix) && key.endsWith(".java"));
	}
}

export interface RecordedRun {
	command: string;
	args: string[];
	env: Record<string, string>;
	cwd: string;
}

export type RunHandler = (spec: ProcessSpec, index: number) => { status: number; stdout?: string; stderr?: string };

export class FakeProcess implements ProcessPort {
	readonly runs: RecordedRun[] = [];
	readonly detached: DetachedSpec[] = [];
	readonly killed: { pid: number; hard: boolean }[] = [];
	livePids = new Set<number>();
	/** startDetached 给出的进程号，和 detached 一一对应。 */
	readonly detachedPids: number[] = [];
	nextPid = 4242;
	handler: RunHandler = () => ({ status: 0 });
	pid = 1234;

	run(spec: ProcessSpec) {
		this.runs.push({ command: spec.command, args: [...spec.args], env: { ...spec.env }, cwd: spec.cwd });
		const result = this.handler(spec, this.runs.length - 1);
		return {
			status: result.status,
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? "",
			spawnError: null,
		};
	}

	async runAsync(spec: ProcessSpec, _signal?: AbortSignal) {
		return this.run(spec);
	}

	currentPid(): number {
		return this.pid;
	}

	startDetached(spec: DetachedSpec) {
		this.detached.push(spec);
		const pid = this.nextPid++;
		this.detachedPids.push(pid);
		this.livePids.add(pid);
		return { pid, error: null };
	}

	isAlive(pid: number): boolean {
		return this.livePids.has(pid);
	}

	/** 另外摆进进程清单的 java 进程（别的程序占了号、没登记的 JVM）。null 表示「查不了」。 */
	extraJava: JavaProcess[] | null = [];

	/** 自己起过、还活着的进程照真实命令行列出来，再加上 extraJava。 */
	async listJava(): Promise<JavaProcess[] | null> {
		if (this.extraJava === null) return null;
		const started = this.detached
			.map((spec, index) => ({ pid: this.detachedPids[index] ?? -1, spec }))
			.filter(({ pid }) => this.livePids.has(pid))
			.map(({ pid, spec }) => ({
				pid,
				commandLine: [spec.command, ...spec.args].join(" "),
				memoryBytes: null,
				startedAtMs: null,
			}));
		return [...started, ...this.extraJava];
	}

	kill(pid: number, hard: boolean): Promise<void> {
		this.killed.push({ pid, hard });
		this.livePids.delete(pid);
		return Promise.resolve();
	}

	/** argv of the nth run whose command matches. */
	runsOf(command: string): RecordedRun[] {
		return this.runs.filter((run) => run.command === command || run.command.endsWith(command));
	}
}

export type NetHandler = (port: number, lines: readonly string[]) => { ok: boolean; why?: string; text?: string };

export class FakeNet implements NetPort {
	readonly requests: { port: number; lines: string[] }[] = [];
	readonly connects: number[] = [];
	handler: NetHandler = () => ({ ok: false, why: "ECONNREFUSED" });
	/** Ports a plain TCP connect succeeds on (the debug node's, in S5.4 tests). */
	openPorts = new Set<number>();

	async request(port: number, lines: readonly string[], _timeoutMs: number) {
		this.requests.push({ port, lines: [...lines] });
		const result = this.handler(port, lines);
		return { ok: result.ok, why: result.why ?? null, text: result.text ?? "" };
	}

	async canConnect(port: number, _timeoutMs: number) {
		this.connects.push(port);
		return this.openPorts.has(port);
	}
}

export class FakeClock {
	private value = 0;
	readonly sleeps: number[] = [];
	now(): number {
		this.value += 100;
		return this.value;
	}
	async sleep(ms: number): Promise<void> {
		this.sleeps.push(ms);
	}
	/** 把时钟往前推，用来验「超过时间窗就不算数」这类规则。 */
	advance(ms: number): void {
		this.value += ms;
	}
}

export const ROOT = "D:/proj";
export const CACHE = "D:/cache/v1-abcdef";
export const RESOURCES = "D:/cache/v1-abcdef/resources";

export function baseConfig(overrides: Partial<KernelConfig> = {}): KernelConfig {
	return {
		root: ROOT,
		configFile: "D:/agent/config.json",
		configExists: true,
		projectConfigFile: `${ROOT}/.cosmic-ai/config.json`,
		projectConfigExists: false,
		parseError: null,
		parseErrorFile: null,
		fileLayers: [],
		isv: "zlgd",
		tenant: "ierp",
		account: "acct",
		user: "42",
		debugModule: "demo-debug",
		codeModules: ["demo-biz"],
		appClass: "com.demo.DebugApp",
		appMethod: "devRemote",
		cosmicHome: "D:/cosmic",
		cosmicHomeResolution: { value: "D:/cosmic", source: "工程 gradle.properties", conflict: null },
		knowledgeRoot: null,
		debugPort: 8080,
		probeServerPort: 8099,
		jrebel: null,
		dbLink: "fast",
		javaHome: null,
		jvmArgs: [],
		gradleArgs: ["--offline"],
		sources: {},
		auto: {
			isv: "zlgd",
			debugModule: "demo-debug",
			codeModules: ["demo-biz"],
			appClass: "com.demo.DebugApp",
			appMethod: "devRemote",
			cosmicHome: "D:/cosmic",
			modules: ["demo-debug", "demo-biz"],
			moduleDirs: {},
			unresolvedDeps: [],
			appFile: null,
			tenant: null,
			javaHome: null,
			gradleDirs: null,
		},
		...overrides,
	};
}

export interface FakeContext {
	ctx: KernelContext;
	fs: MemoryFs;
	proc: FakeProcess;
	net: FakeNet;
	clock: FakeClock;
}

export interface FakeContextInput {
	root?: string;
	cacheRoot?: string;
	runtimeKeyId?: string;
	env?: Record<string, string | undefined>;
	config?: Partial<KernelConfig>;
	/** Skip seeding the pathing jar / argfile, so ensureBuilt has to run gradle. */
	unbuilt?: boolean;
	/** Released probe class names -- the closed set `probe` may run. */
	probes?: readonly string[];
	/** Expected hashes for tests that exercise released-source integrity. */
	releasedProbeDigests?: Readonly<Record<string, string>>;
}

/** An argfile the way cosmic-run.gradle writes one: every code module's class directory first, then a platform jar. */
export function fakeArgfile(layout: KernelLayout): string {
	const heads = layout.moduleDirs.map((module) => module.out.replace(/\\/g, "/"));
	return `-cp "${[...heads, "D:/cosmic/lib/bos-core-8.0.jar"].join(";")}"\n`;
}

/** A context whose project already has the build artifacts and agent resources in place. */
export function makeContext(input: FakeContextInput = {}): FakeContext {
	const root = input.root ?? ROOT;
	const cacheRoot = input.cacheRoot ?? CACHE;
	const resourcesDir = join(cacheRoot, "resources").replace(/\\/g, "/");
	const config = baseConfig({ root, ...input.config });
	const runtimeKeyId = input.runtimeKeyId ?? "v0.0.0-deadbeef";
	const layout = kernelLayout({
		root,
		cacheRoot,
		runtimeKeyId,
		resourcesDir,
		codeModules: config.codeModules,
		debugModule: config.debugModule,
	});

	const fs = new MemoryFs();
	const proc = new FakeProcess();
	const net = new FakeNet();
	const clock = new FakeClock();

	if (input.unbuilt !== true) {
		fs.put(layout.pathingJar, "jar");
		fs.put(layout.javacArgs, fakeArgfile(layout));
	}
	fs.put(layout.hostSrc, "class CosmicProbe {}");
	fs.put(layout.bridgeSrc, "class ServiceBridge {}");
	fs.put(layout.viewsSrc, "package cosmic.headless; public final class HeadlessViews {}");
	fs.put(layout.bootStubSrc, "package kd.bos.service.bootstrap; public class Booter {}");
	fs.put(layout.serverSrc, "class CosmicProbeServer {}");
	fs.put(layout.initGradle, "// cosmic-run.gradle");
	fs.mkdirp(layout.probesDir);

	const ports: Ports = { fs, proc, net, clock };
	const ctx = createContext({
		projectRoot: root,
		config,
		layout,
		env: input.env ?? {},
		ports,
		runtimeKeyId,
		probes: input.probes ?? [],
		releasedProbeDigests: input.releasedProbeDigests,
		platform: "win32",
	});
	return { ctx, fs, proc, net, clock };
}

/** Adds a business source file plus, optionally, an up-to-date class file. */
export function addSource(
	fake: FakeContext,
	module: string,
	relPath: string,
	options: { compiled?: boolean } = {},
): string {
	const dir = fake.ctx.layout.moduleDirs.find((entry) => entry.name === module);
	if (!dir) throw new Error(`no such module in layout: ${module}`);
	const src = `${dir.src.replace(/\\/g, "/")}/${relPath}`;
	if (options.compiled === true) {
		// Class first, source second, so the source is NOT newer.
		fake.fs.put(`${dir.out.replace(/\\/g, "/")}/${relPath.replace(/\.java$/, ".class")}`, "class");
		fake.fs.put(src, "class X {}");
		const classKey = `${dir.out.replace(/\\/g, "/")}/${relPath.replace(/\.java$/, ".class")}`;
		const entry = fake.fs.files.get(classKey);
		const source = fake.fs.files.get(src);
		if (entry && source) entry.mtimeMs = source.mtimeMs + 10;
	} else {
		fake.fs.put(src, "class X {}");
	}
	return src;
}
