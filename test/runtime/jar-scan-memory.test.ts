/**
 * 苍穹运行时整扫过一次，放 JAR 的目录没动就不重扫。
 *
 * 真机 2026-10-10：每次工具调用重开工程都把运行时整扫一遍（4,878 个 JAR、五千多个目录），打包版约 1 秒；
 * 查一条数据在苍穹进程里只要 0.3 秒，工具整次却要 1.5 到 3 秒。JAR 其实只放在其中 6 个目录里。
 */
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	fingerprintCosmicRuntime,
	type JarEntry,
	type JarScanMemory,
	type JarScanner,
	jarBearingDirs,
	nodeJarScanner,
	rememberingJarScanner,
} from "../../src/runtime/fingerprint.ts";

const ENTRIES: JarEntry[] = [
	{ path: "mservice/lib/bos/bos-core-8.0.jar", bytes: 10 },
	{ path: "mservice/lib/cus/demo-1.0.jar", bytes: 20 },
	{ path: "static/report/launcher/lib/x.jar", bytes: 30 },
];

/** 数整扫了几次；目录时间由测试自己拨。 */
function harness(entries: () => JarEntry[] = () => ENTRIES) {
	let scans = 0;
	const inner: JarScanner = {
		scan: async () => {
			scans += 1;
			return entries();
		},
	};
	const mtimes = new Map<string, number | null>();
	const clock = { now: 1_000_000 };
	const memory: JarScanMemory = new Map();
	const scanner = rememberingJarScanner(inner, memory, {
		now: () => clock.now,
		mtimeOf: (dir) => (mtimes.has(dir) ? (mtimes.get(dir) ?? null) : 500),
		maxAgeMs: 600_000,
	});
	return { scanner, memory, mtimes, clock, scans: () => scans };
}

describe("看着哪些目录", () => {
	it("运行时根、每个直接放 JAR 的目录、和它们到根之间的每一层；别的目录不看", () => {
		expect(jarBearingDirs(ENTRIES)).toEqual([
			"",
			"mservice",
			"mservice/lib",
			"mservice/lib/bos",
			"mservice/lib/cus",
			"static",
			"static/report",
			"static/report/launcher",
			"static/report/launcher/lib",
		]);
		expect(jarBearingDirs([{ path: "a.jar", bytes: 1 }])).toEqual([""]);
	});
});

describe("目录没变就不重扫", () => {
	it("第二次起用记住的那份，算出来的指纹和整扫逐字相同", async () => {
		const h = harness();
		const first = await h.scanner.scan("D:/cosmic");
		const second = await h.scanner.scan("D:/cosmic");
		const third = await h.scanner.scan("D:/cosmic");
		expect(h.scans()).toBe(1);
		expect(fingerprintCosmicRuntime("D:/cosmic", third)).toEqual(fingerprintCosmicRuntime("D:/cosmic", first));
		expect(second).toEqual(ENTRIES);
	});

	it("放 JAR 的目录时间动了（加、删、改名）就重新整扫", async () => {
		const h = harness();
		await h.scanner.scan("D:/cosmic");
		h.mtimes.set(join("D:/cosmic", "mservice/lib/cus"), 900);
		await h.scanner.scan("D:/cosmic");
		expect(h.scans()).toBe(2);
		// 新的时间记下了，再问不扫
		await h.scanner.scan("D:/cosmic");
		expect(h.scans()).toBe(2);
	});

	it("上级目录时间动了（旁边多出一个目录）也重新整扫；看着的目录不在了同样", async () => {
		const h = harness();
		await h.scanner.scan("D:/cosmic");
		h.mtimes.set(join("D:/cosmic", "mservice/lib"), 901);
		await h.scanner.scan("D:/cosmic");
		expect(h.scans()).toBe(2);
		h.mtimes.set(join("D:/cosmic", "static/report/launcher/lib"), null);
		await h.scanner.scan("D:/cosmic");
		expect(h.scans()).toBe(3);
	});

	it("记住的那份到期就整扫一遍：同名文件原地换内容目录时间不动，靠这一条发现", async () => {
		let bytes = 20;
		const h = harness(() => [{ path: "lib/cus/demo-1.0.jar", bytes }]);
		const before = fingerprintCosmicRuntime("D:/cosmic", await h.scanner.scan("D:/cosmic"));
		bytes = 21;
		h.clock.now += 599_999;
		expect(fingerprintCosmicRuntime("D:/cosmic", await h.scanner.scan("D:/cosmic"))).toEqual(before);
		h.clock.now += 1;
		const after = fingerprintCosmicRuntime("D:/cosmic", await h.scanner.scan("D:/cosmic"));
		expect(h.scans()).toBe(2);
		expect(after.hash).not.toBe(before.hash);
	});

	it("清掉记住的那份（打开工程、部署之后）下一次就整扫", async () => {
		const h = harness();
		await h.scanner.scan("D:/cosmic");
		h.memory.clear();
		await h.scanner.scan("D:/cosmic");
		expect(h.scans()).toBe(2);
	});

	it("两个运行时各记各的", async () => {
		const h = harness();
		await h.scanner.scan("D:/cosmic-a");
		await h.scanner.scan("D:/cosmic-b");
		await h.scanner.scan("D:/cosmic-a");
		await h.scanner.scan("D:/cosmic-b");
		expect(h.scans()).toBe(2);
	});
});

describe("不该记的时候不记", () => {
	it("一个 JAR 都没扫到（目录不对、读不了）每次都整扫", async () => {
		const h = harness(() => []);
		await h.scanner.scan("D:/nowhere");
		await h.scanner.scan("D:/nowhere");
		expect(h.scans()).toBe(2);
		expect(h.memory.size).toBe(0);
	});

	it("整扫期间目录正好被改过（时间不早于开扫那一刻）这一次不记", async () => {
		const h = harness();
		h.mtimes.set(join("D:/cosmic", "mservice/lib/cus"), h.clock.now);
		await h.scanner.scan("D:/cosmic");
		expect(h.memory.size).toBe(0);
		h.mtimes.set(join("D:/cosmic", "mservice/lib/cus"), 600);
		await h.scanner.scan("D:/cosmic");
		await h.scanner.scan("D:/cosmic");
		expect(h.scans()).toBe(2);
	});

	it("看着的目录读不出时间就不记", async () => {
		const h = harness();
		h.mtimes.set(join("D:/cosmic", "static"), null);
		await h.scanner.scan("D:/cosmic");
		await h.scanner.scan("D:/cosmic");
		expect(h.scans()).toBe(2);
	});
});

describe("真磁盘上目录时间的行为", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	function runtime(): string {
		const root = mkdtempSync(join(tmpdir(), "cosmic-jar-scan-"));
		roots.push(root);
		mkdirSync(join(root, "lib", "bos"), { recursive: true });
		mkdirSync(join(root, "lib", "cus"), { recursive: true });
		mkdirSync(join(root, "static", "web", "deep"), { recursive: true });
		writeFileSync(join(root, "lib", "bos", "bos-core-8.0.jar"), "0123456789");
		writeFileSync(join(root, "lib", "cus", "demo-1.0.jar"), "01234");
		writeFileSync(join(root, "static", "web", "deep", "index.html"), "<html>");
		return root;
	}

	/** 开扫时刻往后拨，免得刚建的目录被当成「整扫期间改过」。 */
	function scannerFor(memory: JarScanMemory, counter: { scans: number }) {
		const counting: JarScanner = {
			scan: async (root) => {
				counter.scans += 1;
				return nodeJarScanner.scan(root);
			},
		};
		return rememberingJarScanner(counting, memory, { now: () => Date.now() + 60_000 });
	}

	it("加一个 JAR、删一个、改名、旁边多一个放 JAR 的目录，下一次都重新整扫", async () => {
		const root = runtime();
		const counter = { scans: 0 };
		const scanner = scannerFor(new Map(), counter);
		expect((await scanner.scan(root)).length).toBe(2);
		expect((await scanner.scan(root)).length).toBe(2);
		expect(counter.scans).toBe(1);

		writeFileSync(join(root, "lib", "cus", "extra-1.0.jar"), "x");
		expect((await scanner.scan(root)).length).toBe(3);
		expect(counter.scans).toBe(2);

		rmSync(join(root, "lib", "cus", "extra-1.0.jar"));
		expect((await scanner.scan(root)).length).toBe(2);
		expect(counter.scans).toBe(3);

		renameSync(join(root, "lib", "bos", "bos-core-8.0.jar"), join(root, "lib", "bos", "bos-core-8.1.jar"));
		expect((await scanner.scan(root)).map((jar) => jar.path)).toContain("lib/bos/bos-core-8.1.jar");
		expect(counter.scans).toBe(4);

		mkdirSync(join(root, "lib", "trd"));
		writeFileSync(join(root, "lib", "trd", "third-1.0.jar"), "xy");
		expect((await scanner.scan(root)).length).toBe(3);
		expect(counter.scans).toBe(5);

		expect((await scanner.scan(root)).length).toBe(3);
		expect(counter.scans).toBe(5);
	});

	it("不放 JAR 的目录里动文件不触发整扫", async () => {
		const root = runtime();
		const counter = { scans: 0 };
		const scanner = scannerFor(new Map(), counter);
		await scanner.scan(root);
		writeFileSync(join(root, "static", "web", "deep", "more.html"), "<p>");
		await scanner.scan(root);
		expect(counter.scans).toBe(1);
	});
});
