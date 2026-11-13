/**
 * S37 2-A.1 的尺子：拿真机留下的探针原始输出，量人读通道留下了多少、留下的是什么。
 *
 * 用法：
 *   node --experimental-strip-types scripts/measure-probe-filter.ts [--rev <git 版本>] [--own zlgd.] [--show] [目录…]
 *
 * - 目录默认是 ~/.fast-ai-cosmic/cache/ 下每个运行环境的 probe-runs/（每份文件头两行 `# …` 是存档时加的，去掉再量）。
 * - `--rev HEAD` 用那个版本的 src/kernel/probe/output.ts 量，同一批样本前后对比用它。
 * - `--own` 传本工程包名前缀（`run` 会传，普通探针不传），可以多次。
 * - `--show` 列出留下的非 `[PROBE` 行（按内容归并，前 100 字）。
 *
 * 只读文件，不连环境。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
let rev: string | null = null;
const own: string[] = [];
let show = false;
const dirs: string[] = [];
for (let i = 0; i < args.length; i++) {
	const arg = args[i] as string;
	if (arg === "--rev") rev = args[++i] ?? null;
	else if (arg === "--own") own.push(args[++i] ?? "");
	else if (arg === "--show") show = true;
	else dirs.push(resolve(arg));
}
if (dirs.length === 0) {
	const cache = join(homedir(), ".fast-ai-cosmic", "cache");
	for (const key of existsSync(cache) ? readdirSync(cache) : []) {
		const dir = join(cache, key, "probe-runs");
		if (existsSync(dir)) dirs.push(dir);
	}
}

const repo = resolve(import.meta.dirname, "..");
let modulePath = join(repo, "src", "kernel", "probe", "output.ts");
if (rev !== null) {
	const text = execFileSync("git", ["show", `${rev}:src/kernel/probe/output.ts`], { cwd: repo, encoding: "utf8" });
	modulePath = join(mkdtempSync(join(tmpdir(), "cosmic-filter-ruler-")), "output.ts");
	writeFileSync(modulePath, text);
}
const { filterProbeOutput } = (await import(pathToFileURL(modulePath).href)) as {
	filterProbeOutput: (out: string, ownPackages?: readonly string[]) => { all: string[]; lines: string[] };
};

const files = dirs.flatMap((dir) =>
	readdirSync(dir)
		.filter((name) => name.endsWith(".out"))
		.map((name) => join(dir, name)),
);
const bytes = (lines: readonly string[]): number => Buffer.byteLength(lines.join("\n"), "utf8");
const probeOf = (file: string): string =>
	basename(file, ".out")
		.replace(/^.*?Z-/, "")
		.replace(/-\d+$/, "");

const byProbe = new Map<
	string,
	{ files: number; total: number; kept: number; keptBytes: number; unprefixed: number }
>();
const unprefixedLines = new Map<string, number>();
const totals = { files: files.length, total: 0, totalBytes: 0, kept: 0, keptBytes: 0, unprefixed: 0 };
for (const file of files) {
	const out = readFileSync(file, "utf8").split(/\r?\n/).slice(2).join("\n");
	const filtered = filterProbeOutput(out, own);
	const unprefixed = filtered.lines.filter((line) => !/\[PROBE/.test(line));
	totals.total += filtered.all.length;
	totals.totalBytes += Buffer.byteLength(out, "utf8");
	totals.kept += filtered.lines.length;
	totals.keptBytes += bytes(filtered.lines);
	totals.unprefixed += unprefixed.length;
	const row = byProbe.get(probeOf(file)) ?? { files: 0, total: 0, kept: 0, keptBytes: 0, unprefixed: 0 };
	row.files++;
	row.total += filtered.all.length;
	row.kept += filtered.lines.length;
	row.keptBytes += bytes(filtered.lines);
	row.unprefixed += unprefixed.length;
	byProbe.set(probeOf(file), row);
	for (const line of unprefixed) {
		const key = `${probeOf(file)} | ${line.slice(0, 100)}`;
		unprefixedLines.set(key, (unprefixedLines.get(key) ?? 0) + 1);
	}
}

console.log(
	JSON.stringify({ kind: "ruler", version: "s37-filter-v1", rev: rev ?? "working-tree", own, dirs: dirs.length }),
);
console.log(JSON.stringify({ totals }));
for (const [name, row] of [...byProbe].sort((a, b) => b[1].keptBytes - a[1].keptBytes)) {
	console.log(JSON.stringify({ probe: name, ...row }));
}
if (show) {
	for (const [line, count] of [...unprefixedLines].sort((a, b) => b[1] - a[1])) console.log(`${count}\t${line}`);
}
