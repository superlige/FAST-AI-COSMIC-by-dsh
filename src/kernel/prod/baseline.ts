/**
 * 生产跑的是哪一版代码，本地源码离它多远。
 *
 * 这个工程的约定（用户定）：生产跑的是「昨天最后一次提交」。所以基线 = 今天零点之前的最后一个提交；
 * 之后的提交、还没提交的改动、新文件，都可能和生产不一样——堆栈行号落在这些文件里时要标出来，
 * 不然模型会拿本地新代码的行号去解释生产上旧代码的报错。
 *
 * git 不可用（不是 git 工程、没装 git）就照实说「不知道」，不当成「没有改动」。
 */
import { join, relative } from "node:path";
import { baseChildEnv, type KernelContext } from "../context.ts";
import type { SourceHit, SourceLookup } from "./log-view.ts";

export interface CodeBaseline {
	/** 基线提交，没有 git 或找不到时为 null */
	commit: string | null;
	date: string | null;
	/** 基线之后改过的文件（工程根目录的相对路径，正斜杠） */
	changed: ReadonlySet<string>;
	/** 一句话说明，给人和模型看 */
	note: string;
}

async function git(ctx: KernelContext, args: readonly string[]): Promise<string | null> {
	const result = await ctx.ports.proc.runAsync({
		command: "git",
		args: ["-c", "core.quotepath=false", ...args],
		cwd: ctx.projectRoot,
		env: baseChildEnv(ctx),
	});
	if (result.spawnError !== null || result.status !== 0) return null;
	return result.stdout;
}

function midnight(nowMs: number): string {
	const d = new Date(nowMs);
	const pad = (n: number): string => String(n).padStart(2, "0");
	return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} 00:00:00`;
}

export async function codeBaseline(ctx: KernelContext): Promise<CodeBaseline> {
	const head = await git(ctx, ["log", "-1", `--before=${midnight(ctx.ports.clock.now())}`, "--format=%H|%ci"]);
	if (head === null || head.trim() === "")
		return {
			commit: null,
			date: null,
			changed: new Set(),
			note: "认不出生产版本（不是 git 工程或没有今天以前的提交）：行号是否对得上无法判断",
		};
	const [commit, date] = head.trim().split("|") as [string, string];
	const changed = new Set<string>();
	const lists = await Promise.all([
		git(ctx, ["diff", "--name-only", "--relative", commit, "HEAD"]),
		git(ctx, ["diff", "--name-only", "--relative", "HEAD"]),
		git(ctx, ["ls-files", "--others", "--exclude-standard"]),
	]);
	for (const list of lists)
		for (const line of (list ?? "").split("\n")) if (line.trim() !== "") changed.add(line.trim().replace(/\\/g, "/"));
	const java = [...changed].filter((p) => p.endsWith(".java")).length;
	return {
		commit,
		date,
		changed,
		note: `按约定生产 = 今天以前最后一次提交 ${commit.slice(0, 8)}（${date}）；之后改过或未提交的 Java 文件 ${String(java)} 个，堆栈落在这些文件里会标出来`,
	};
}

/** 按全限定类名 + 堆栈里的文件名在各模块源码目录里找 */
export function sourceLookup(ctx: KernelContext, baseline: CodeBaseline): SourceLookup {
	const cache = new Map<string, SourceHit | null>();
	return (className, fileName) => {
		const pkg = className.includes(".") ? className.slice(0, className.lastIndexOf(".")).replace(/\$.*$/, "") : "";
		const file = fileName.endsWith(".java") ? fileName : `${className.split(".").pop()?.split("$")[0] ?? ""}.java`;
		const rel = `${pkg.replace(/\./g, "/")}/${file}`;
		const cached = cache.get(rel);
		if (cached !== undefined) return cached;
		let hit: SourceHit | null = null;
		for (const dirs of ctx.layout.moduleDirs) {
			const path = join(dirs.src, rel);
			if (!ctx.ports.fs.exists(path)) continue;
			const projectPath = relative(ctx.projectRoot, path).replace(/\\/g, "/");
			hit = {
				path: projectPath,
				lines: ctx.ports.fs.read(path).replace(/\r\n/g, "\n").split("\n"),
				changedSinceBaseline: baseline.changed.has(projectPath),
			};
			break;
		}
		cache.set(rel, hit);
		return hit;
	};
}
