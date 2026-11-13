/**
 * Runtime fingerprints (S2.3). Every dimension that can change what a compiled
 * probe class actually means gets its own fingerprint, and all of them feed the
 * RuntimeKey. The rule from D10 is that a change in any dimension invalidates
 * caches and forces a recompile: reusing classes across a different Cosmic JAR
 * set or a different JDK produces a NoSuchMethodError whose symptom points at
 * business code rather than at the cache.
 *
 * All I/O goes through injected ports. Nothing here reads process.env or
 * process.cwd(), and nothing caches in module scope (D9).
 */
import { createHash } from "node:crypto";
import { type Dirent, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Canonical JSON: object keys sorted, so a fingerprint never depends on insertion order. */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function hashOf(value: unknown): string {
	return sha256(canonicalJson(value));
}

/* ── JDK ──────────────────────────────────────────────────────────────────── */

export interface JdkFingerprint {
	/** Absolute path of the JDK home actually used. */
	home: string;
	/** Version string as reported by the JDK itself, e.g. "1.8.0_392". */
	version: string;
	/** Vendor/build line when available; distinguishes two JDK 8 builds. */
	build: string | null;
	hash: string;
}

export interface JdkProbe {
	/** Returns the java version banner, or null when the JDK cannot be interrogated. */
	describe(javaHome: string): Promise<{ version: string; build: string | null } | null>;
	/** After a null describe: what java itself said (exit code, first lines), when known. */
	lastFailure?(): string | null;
}

/**
 * A JDK is identified by home + version + build, not by home alone: the same
 * path can be re-pointed at a different JDK (a reinstall, a symlink flip), and
 * two JDK 8 builds differ in what javac emits.
 */
export async function fingerprintJdk(javaHome: string, probe: JdkProbe): Promise<JdkFingerprint | null> {
	const described = await probe.describe(javaHome);
	if (described === null) return null;
	const parts = { home: javaHome, version: described.version, build: described.build };
	return { ...parts, hash: hashOf(parts) };
}

/* ── Cosmic runtime JARs ──────────────────────────────────────────────────── */

export interface JarEntry {
	/** Path relative to cosmicHome, forward slashes, so the fingerprint is portable. */
	path: string;
	bytes: number;
}

export interface CosmicRuntimeFingerprint {
	cosmicHome: string;
	/** Version derived from bos-*.jar names; null when it cannot be sampled. */
	version: string | null;
	jarCount: number;
	/** Hash over every jar path+size under cosmicHome -- the "JAR manifest fingerprint" of D10. */
	hash: string;
}

/**
 * Cosmic version from bos-*.jar file names: offline, zero cost. Ported from the
 * frozen ref tools/profile.mjs cosmicVersionOf. The most frequent version wins,
 * ties broken by the higher string -- a runtime directory can hold leftovers
 * from a previous upgrade, and the majority is the live one.
 */
export function cosmicVersionOf(jarNames: readonly string[]): string | null {
	const tally = new Map<string, number>();
	for (const name of jarNames) {
		const match = /^bos-.*?-(\d+\.\d+(?:\.\d+)*)\.jar$/.exec(String(name));
		if (match?.[1]) tally.set(match[1], (tally.get(match[1]) ?? 0) + 1);
	}
	if (tally.size === 0) return null;
	return [...tally.entries()].sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]))[0]?.[0] ?? null;
}

export interface JarScanner {
	/**
	 * Lists every .jar under a root as {path relative to root, bytes}. Missing root yields [].
	 *
	 * 异步，而这跟 I/O 快慢无关：真机上的苍穹运行时是 4,878 个 JAR，一趟同步的
	 * readdir+stat 会把 Node 的事件循环整个占住几秒。别处无所谓，但这一趟正好发生在
	 * TUI 启动的「打开中」——转圈停帧、按键不回显，跟卡死长得一模一样。所以走 async，
	 * 好让实现有地方交还事件循环。
	 */
	scan(root: string): Promise<JarEntry[]>;
}

/** Depth limit matches the frozen walk; a Cosmic runtime never nests jars deeper. */
const MAX_JAR_DEPTH = 6;

/**
 * 每处理这么多个目录项就把事件循环交还一次。
 *
 * 4,878 个 JAR 大约让出 25 次，代价可以忽略；而两次让出之间最多 200 个 stat，
 * footer 的转圈（80ms 一帧）不会明显掉帧。
 */
const JAR_SCAN_YIELD_EVERY = 200;

export const nodeJarScanner: JarScanner = {
	async scan(root) {
		const out: JarEntry[] = [];
		let sinceYield = 0;
		const walk = async (dir: string, relative: string, depth: number): Promise<void> => {
			if (depth > MAX_JAR_DEPTH) return;
			let entries: Dirent[];
			try {
				entries = readdirSync(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				if (++sinceYield >= JAR_SCAN_YIELD_EVERY) {
					sinceYield = 0;
					await new Promise((resolve) => setImmediate(resolve));
				}
				const rel = relative === "" ? entry.name : `${relative}/${entry.name}`;
				const abs = join(dir, entry.name);
				if (entry.isDirectory()) await walk(abs, rel, depth + 1);
				else if (entry.name.endsWith(".jar")) {
					let bytes = -1;
					try {
						bytes = statSync(abs).size;
					} catch {
						bytes = -1;
					}
					out.push({ path: rel, bytes });
				}
			}
		};
		await walk(root, "", 0);
		return out;
	},
};

/* ── 扫过的运行时，目录没变就不重扫 ─────────────────────────────────────────── */

/** 一次整扫的结果，和当时看着的那几个目录的修改时间。 */
export interface RememberedJarScan {
	entries: JarEntry[];
	/** 运行时根、每个直接放着 JAR 的目录、以及它们到根之间的每一层；值是整扫那一刻的修改时间。 */
	watched: [dir: string, mtimeMs: number][];
	scannedAt: number;
}

/** 按运行时目录记；一个会话（一个内核适配器）一份。 */
export type JarScanMemory = Map<string, RememberedJarScan>;

/**
 * 记住的整扫结果最多用这么久，到点重新整扫一遍。
 *
 * 目录的修改时间只在「加了、删了、改了名」时变；同名文件原地换了内容（大小变了）目录时间不动，
 * 靠这一条兜住：最晚这么久之后发现。打开工程、部署之后是当场整扫，不等它（见内核适配器）。
 */
export const JAR_SCAN_MAX_AGE_MS = 10 * 60_000;

export interface JarScanRecall {
	now: () => number;
	/** 目录的修改时间（毫秒）；不在了、读不了是 null。 */
	mtimeOf: (dir: string) => number | null;
	maxAgeMs: number;
}

function directoryMtime(dir: string): number | null {
	try {
		const stat = statSync(dir);
		return stat.isDirectory() ? stat.mtimeMs : null;
	} catch {
		return null;
	}
}

/** 运行时根、每个直接放着 JAR 的目录、以及它们到根之间的每一层（相对路径，根是空串）。 */
export function jarBearingDirs(entries: readonly JarEntry[]): string[] {
	const dirs = new Set<string>([""]);
	for (const entry of entries) {
		let cut = entry.path.lastIndexOf("/");
		while (cut > 0) {
			const dir = entry.path.slice(0, cut);
			if (dirs.has(dir)) break;
			dirs.add(dir);
			cut = dir.lastIndexOf("/");
		}
	}
	return [...dirs].sort();
}

/**
 * 每次工具调用都要重开工程，重开就要知道苍穹运行时变没变。整扫一遍是 4,878 个 JAR 逐个取大小，
 * 外加把运行时下面五千多个目录列一遍，约 1 秒；而 JAR 实际只放在其中几个目录里。
 *
 * 所以整扫一次之后记住结果，再问时只看那几个放 JAR 的目录（和它们的上级）修改时间动没动：
 * 加、删、改名 JAR，或者旁边多出一个目录，都会动，动了就重新整扫。没动、又没过期，就用记住的。
 * 指纹照旧由调用方拿这份清单去算，所以算出来的和整扫逐字相同。
 *
 * 整扫期间目录正好被改过的那一次不记：记下的时间戳和清单可能对不上。
 */
export function rememberingJarScanner(
	scanner: JarScanner,
	memory: JarScanMemory,
	recall: Partial<JarScanRecall> = {},
): JarScanner {
	const now = recall.now ?? Date.now;
	const mtimeOf = recall.mtimeOf ?? directoryMtime;
	const maxAgeMs = recall.maxAgeMs ?? JAR_SCAN_MAX_AGE_MS;
	return {
		async scan(root) {
			const known = memory.get(root);
			if (
				known !== undefined &&
				now() - known.scannedAt < maxAgeMs &&
				known.watched.every(([dir, mtimeMs]) => mtimeOf(dir) === mtimeMs)
			) {
				return known.entries;
			}
			memory.delete(root);
			const startedAt = now();
			const entries = await scanner.scan(root);
			// 一个 JAR 都没有是出错的样子（目录不对、读不了），不记：下一次照常整扫
			if (entries.length === 0) return entries;
			const watched: [string, number][] = [];
			for (const relative of jarBearingDirs(entries)) {
				const dir = relative === "" ? root : join(root, relative);
				const mtimeMs = mtimeOf(dir);
				if (mtimeMs === null || mtimeMs >= startedAt) return entries;
				watched.push([dir, mtimeMs]);
			}
			memory.set(root, { entries, watched, scannedAt: startedAt });
			return entries;
		},
	};
}

/**
 * Fingerprints the user's Cosmic runtime from an already-scanned jar list.
 *
 * 扫盘留在调用方（`resolveCosmicRuntime`）而不是这里：那一趟在真机上是 4,878 个
 * readdir+stat，必须异步分片才不会占住事件循环，而指纹本身是纯函数——两件事混在
 * 一个签名里，纯的那半就再也没法同步地测了。
 *
 * Size is included alongside the path
 * because an in-place patch keeps every file name identical -- name-only
 * hashing would call a patched runtime unchanged. mtime is deliberately NOT
 * included: a plain re-copy of the same runtime would then invalidate every
 * cache for no semantic change.
 */
export function fingerprintCosmicRuntime(cosmicHome: string, scanned: readonly JarEntry[]): CosmicRuntimeFingerprint {
	const jars = [...scanned].sort((a, b) => a.path.localeCompare(b.path));
	const names = jars.map((jar) => jar.path.slice(jar.path.lastIndexOf("/") + 1));
	return {
		cosmicHome,
		version: cosmicVersionOf(names),
		jarCount: jars.length,
		// cosmicHome is part of the hash, not just a label: two runtimes with
		// byte-identical jars still compile to different absolute classpaths, and
		// sharing a class cache between them would make "which runtime did this
		// class come from" unanswerable after the fact.
		hash: hashOf({ cosmicHome: cosmicHome.replace(/\\/g, "/"), jars }),
	};
}

/* ── Project classpath ────────────────────────────────────────────────────── */

export interface ClasspathFingerprint {
	entryCount: number;
	hash: string;
}

/**
 * Classpath order is part of the identity, not just the set: Cosmic resolves a
 * duplicated class by first-on-the-path, so two orderings of the same entries
 * can load different classes. The list is therefore hashed as an ordered array.
 */
export function fingerprintClasspath(entries: readonly string[]): ClasspathFingerprint {
	const normalized = entries.map((entry) => entry.replace(/\\/g, "/"));
	return { entryCount: normalized.length, hash: hashOf(normalized) };
}

/* ── Project identity ─────────────────────────────────────────────────────── */

export interface ProjectFingerprint {
	root: string;
	isv: string | null;
	debugModule: string | null;
	codeModules: readonly string[];
	hash: string;
}

export interface ProjectFingerprintInput {
	root: string;
	isv: string | null;
	debugModule: string | null;
	codeModules: readonly string[];
}

/**
 * Project identity. `isv` is included because it is the metadata write red line:
 * the same source tree built under a different ISV flag produces classes that
 * IsvGuard treats differently, and sharing a cache between them would carry a
 * write authorization across projects.
 */
export function fingerprintProject(input: ProjectFingerprintInput): ProjectFingerprint {
	const parts = {
		root: input.root.replace(/\\/g, "/"),
		isv: input.isv,
		debugModule: input.debugModule,
		codeModules: [...input.codeModules].sort(),
	};
	return { ...parts, codeModules: parts.codeModules, hash: hashOf(parts) };
}

/* ── Agent-owned resources ────────────────────────────────────────────────── */

/** Hash over the agent's own embedded probe/runtime sources. Editing a probe forces a recompile. */
export function fingerprintResources(resources: readonly { relativePath: string; content: string }[]): string {
	const sorted = [...resources]
		.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
		.map((resource) => ({ path: resource.relativePath, sha256: sha256(resource.content) }));
	return hashOf(sorted);
}
