/**
 * Source resolution and staleness (S3.1).
 *
 * Ported from driver.mjs's resolveSource / moduleOf / staleSources. The frozen
 * versions printed and exited; these return KernelResult so a resident agent can
 * report "class name matches two files" as a value the caller renders, instead
 * of as a dead process.
 *
 * resolveSource and staleSources are used by both `lint` and `fast`, and the
 * frozen comment on that is worth keeping: the two must not drift, because a
 * file that lint finds and fast does not is a file that gets "checked" and never
 * compiled.
 */

import { isAbsolute, relative, resolve } from "node:path";
import type { KernelContext } from "../context.ts";
import { err, KernelError, type KernelResult, ok } from "../errors.ts";
import type { ModuleDirs } from "../layout.ts";
import { drain, drainSliced } from "../slices.ts";

const isPathLike = (name: string): boolean => /[\\/]/.test(name) || name.endsWith(".java");
/** `zlgd.ygpt.form.OrderPlugin`: a package plus a class, the spelling probes and the index print. */
const isQualifiedName = (name: string): boolean => /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/.test(name);

/** True when `file` sits inside `dir`. Path-based, so it never touches the disk. */
function isInside(dir: string, file: string): boolean {
	const rel = relative(dir, file);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Which code module owns a source file, or null when it belongs to none. */
export function moduleOf(ctx: KernelContext, file: string): ModuleDirs | null {
	return ctx.layout.moduleDirs.find((dir) => isInside(dir.src, file)) ?? null;
}

function findByClassName(ctx: KernelContext, name: string): string[] {
	const hits: string[] = [];
	const target = `${name}.java`;
	const walk = (dir: string): void => {
		for (const entry of ctx.ports.fs.readDir(dir)) {
			const full = resolve(dir, entry.name);
			if (entry.isDirectory) walk(full);
			else if (entry.name === target) hits.push(full);
		}
	};
	for (const dir of ctx.layout.moduleDirs) {
		if (ctx.ports.fs.exists(dir.src)) walk(dir.src);
	}
	return hits;
}

/**
 * A path spelled relative to a code module's source root -- `zlgd/zljy/formplugin/X.java`
 * rather than `<module>/src/main/java/zlgd/zljy/formplugin/X.java`.
 *
 * That is the spelling the package name hands you, so it is the one that gets
 * typed first, and it used to be the one answer that got refused: resolution was
 * project-root-only, and the remedy ("确认路径相对于工程根，或直接给类名") was true
 * and no help at all in working out which code module the file sits under.
 * Resolving it is not a guess -- the suffix either names exactly one file on disk
 * or it names several, and several is still an error.
 */
function findByModuleRelative(ctx: KernelContext, name: string): string[] {
	const suffix = name
		.split("\\")
		.join("/")
		.replace(/^\.?\//, "");
	const hits: string[] = [];
	for (const dir of ctx.layout.moduleDirs) {
		const path = resolve(dir.src, suffix);
		if (isInside(dir.src, path) && ctx.ports.fs.exists(path)) hits.push(path);
	}
	return hits;
}

/**
 * Argument -> source path. A path (or anything ending in .java) is taken as a
 * path; a full class name is turned into its package path under the code
 * modules; a simple name is searched for under the code modules. A path is tried
 * against the project root first, then against each code module's source root
 * (see `findByModuleRelative`).
 *
 * Several matches is an error rather than a pick: choosing one silently means
 * editing one file and compiling another, and nothing reports it.
 */
export function resolveSource(ctx: KernelContext, name: string): KernelResult<string> {
	if (isPathLike(name)) {
		const path = resolve(ctx.projectRoot, name);
		if (ctx.ports.fs.exists(path)) return ok(path);

		const inModule = findByModuleRelative(ctx, name);
		if (inModule.length === 1) return ok(inModule[0] as string);
		if (inModule.length > 1) {
			return err(
				new KernelError("SOURCE_AMBIGUOUS", `模块内相对路径 ${name} 在 ${inModule.length} 个代码模块下都有`, {
					detail: { requested: name, candidates: inModule.map((hit) => relative(ctx.projectRoot, hit)) },
					remedy: "用上面任一相对工程根的路径重试。",
				}),
			);
		}
		// Last resort, and reported rather than acted on: the class name is the part
		// of a wrong path that is usually still right, so saying where that class
		// actually lives turns "not found" into one retry instead of a hunt.
		const base = name.split("\\").join("/").split("/").pop() ?? name;
		const byName = findByClassName(ctx, base.replace(/\.java$/, ""));
		return err(
			new KernelError("SOURCE_NOT_FOUND", `找不到源文件：${path}`, {
				detail: {
					requested: name,
					resolved: path,
					candidates: byName.map((hit) => relative(ctx.projectRoot, hit)),
				},
				remedy:
					byName.length > 0
						? `同名的类在：${byName.map((hit) => relative(ctx.projectRoot, hit)).join(" / ")}。用其中一条重试。`
						: "路径可以相对工程根，也可以相对代码模块的源码根（就是包名那一段）；或者直接给类名让内核去搜。",
			}),
		);
	}

	// A full class name is a module-relative path in other clothes: the package is the
	// directory. It used to go to the simple-name search as is, which looks for a file
	// literally called `zlgd.ygpt.form.X.java` and answered SOURCE_NOT_FOUND for a class
	// sitting right there (真机 2026-10-09) -- while the tool description says 类名 works.
	if (isQualifiedName(name)) {
		const inModule = findByModuleRelative(ctx, `${name.split(".").join("/")}.java`);
		if (inModule.length === 1) return ok(inModule[0] as string);
		if (inModule.length > 1) {
			return err(
				new KernelError("SOURCE_AMBIGUOUS", `类 ${name} 在 ${inModule.length} 个代码模块下都有`, {
					detail: { requested: name, candidates: inModule.map((hit) => relative(ctx.projectRoot, hit)) },
					remedy: "用上面任一相对工程根的路径重试。",
				}),
			);
		}
		// Same as a wrong path: a different package with the same class name is a
		// different class, so it is named, not compiled.
		const byName = findByClassName(ctx, name.slice(name.lastIndexOf(".") + 1));
		return err(
			new KernelError("SOURCE_NOT_FOUND", `${ctx.config.codeModules.join(" / ")} 下找不到类 ${name}`, {
				detail: {
					requested: name,
					modules: ctx.config.codeModules,
					candidates: byName.map((hit) => relative(ctx.projectRoot, hit)),
				},
				remedy:
					byName.length > 0
						? `包名对不上；同名的类在：${byName.map((hit) => relative(ctx.projectRoot, hit)).join(" / ")}。是它就用这条路径重试。`
						: "检查类名拼写，或用相对工程根的路径指定文件。",
			}),
		);
	}

	const hits = findByClassName(ctx, name);
	if (hits.length === 0) {
		return err(
			new KernelError("SOURCE_NOT_FOUND", `${ctx.config.codeModules.join(" / ")} 下找不到类 ${name}`, {
				detail: { requested: name, modules: ctx.config.codeModules },
				remedy: "检查类名拼写，或用相对工程根的路径指定文件。",
			}),
		);
	}
	if (hits.length > 1) {
		return err(
			new KernelError("SOURCE_AMBIGUOUS", `类名 ${name} 有 ${hits.length} 处，必须用路径指定`, {
				detail: { requested: name, candidates: hits.map((hit) => relative(ctx.projectRoot, hit)) },
				remedy: "用上面任一相对路径重试。",
			}),
		);
	}
	return ok(hits[0] as string);
}

/** Resolves every argument, collecting all failures instead of stopping at the first. */
export function resolveSources(ctx: KernelContext, names: readonly string[]): KernelResult<string[]> {
	const files: string[] = [];
	for (const name of names) {
		const result = resolveSource(ctx, name);
		if (!result.ok) return result;
		files.push(result.value);
	}
	return ok(files);
}

/**
 * Source files newer than their .class.
 *
 * Deliberately not git status: a file that was edited, committed and never
 * compiled is clean in git and still needs compiling.
 */
export function staleSources(ctx: KernelContext): string[] {
	return drain(staleSourceSteps(ctx));
}

/** `staleSources` cut into slices for the async paths a tool call goes through (see `slices.ts`). */
export function staleSourcesAsync(ctx: KernelContext): Promise<string[]> {
	return drainSliced(staleSourceSteps(ctx));
}

function* staleSourceSteps(ctx: KernelContext): Generator<void, string[], void> {
	const out: string[] = [];
	for (const dir of ctx.layout.moduleDirs) yield* staleInModule(ctx, dir, out);
	return out;
}

/** Source files of one module newer than their .class (any module, not only code modules). */
export function staleSourcesIn(ctx: KernelContext, dir: ModuleDirs): string[] {
	const out: string[] = [];
	drain(staleInModule(ctx, dir, out));
	return out;
}

function* staleInModule(ctx: KernelContext, dir: ModuleDirs, out: string[]): Generator<void, void, void> {
	const { fs } = ctx.ports;
	if (!fs.exists(dir.src)) return;
	const walk = function* (current: string): Generator<void, void, void> {
		for (const entry of fs.readDir(current)) {
			const full = resolve(current, entry.name);
			if (entry.isDirectory) {
				yield* walk(full);
				continue;
			}
			if (!entry.name.endsWith(".java")) continue;
			const classFile = resolve(dir.out, relative(dir.src, full).replace(/\.java$/, ".class"));
			const classMs = fs.mtimeMs(classFile);
			const srcMs = fs.mtimeMs(full);
			if (classMs === null || (srcMs !== null && srcMs > classMs)) out.push(full);
			yield;
		}
	};
	yield* walk(dir.src);
}

export interface ModuleGroup {
	module: ModuleDirs;
	files: string[];
}

/**
 * Groups files by owning module. javac's -d and -sourcepath are single-valued,
 * so compiling a mixed set writes classes into the wrong module's output tree.
 */
export function groupByModule(ctx: KernelContext, files: readonly string[]): KernelResult<ModuleGroup[]> {
	const groups = new Map<string, ModuleGroup>();
	const orphans: string[] = [];
	for (const file of files) {
		const module = moduleOf(ctx, file);
		if (module === null) {
			orphans.push(relative(ctx.projectRoot, file));
			continue;
		}
		const existing = groups.get(module.name);
		if (existing) existing.files.push(file);
		else groups.set(module.name, { module, files: [file] });
	}
	if (orphans.length > 0) {
		return err(
			new KernelError("SOURCE_OUTSIDE_MODULES", `${orphans.length} 个文件不在任何代码模块里`, {
				detail: { files: orphans, modules: ctx.config.codeModules },
				remedy: `代码模块是 ${ctx.config.codeModules.join(" / ")}；调试模块的类不参与 fast。`,
			}),
		);
	}
	return ok([...groups.values()]);
}

// ------------------------------------------------------------- lint stamps

/**
 * Files that were clean at their current mtime last time lint ran.
 *
 * Only used to skip a repeated check: someone who ran `lint` before `fast`
 * should not pay the 5 seconds twice. Editing a file changes its mtime, so the
 * stamp expires by itself and can never let an unchecked file through.
 */
export function readStamps(ctx: KernelContext): Record<string, number> {
	const raw = ctx.ports.fs.read(ctx.layout.lintStamp);
	if (raw === "") return {};
	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return parsed as Record<string, number>;
	} catch {
		return {};
	}
}

export function stampClean(ctx: KernelContext, files: readonly string[]): void {
	const stamps = readStamps(ctx);
	for (const file of files) {
		const ms = ctx.ports.fs.mtimeMs(file);
		if (ms !== null) stamps[file] = ms;
	}
	ctx.ports.fs.write(ctx.layout.lintStamp, JSON.stringify(stamps));
}

export function stampedClean(ctx: KernelContext, files: readonly string[]): boolean {
	if (files.length === 0) return false;
	const stamps = readStamps(ctx);
	return files.every((file) => {
		const ms = ctx.ports.fs.mtimeMs(file);
		return ms !== null && stamps[file] === ms;
	});
}

/**
 * The java packages that currently have a stale class, derived from the stale
 * file list `staleSources` already produced.
 *
 * Used to judge an ad-hoc probe's freshness lane (see `policy/probe-freshness.ts`):
 * the question there is not "does this probe touch business code" but "does it
 * touch code that is out of date right now", and the answer is a substring test
 * against these names.
 *
 * A file sitting directly in a module's source root has no package, and there is
 * no name to match it by. That case is reported as `null` rather than skipped:
 * the caller must fall back to the strict lane, because "no package to check"
 * and "checked, no match" have opposite answers.
 */
export function stalePackages(ctx: KernelContext, files: readonly string[]): { packages: string[]; unnamed: boolean } {
	const packages = new Set<string>();
	let unnamed = false;
	for (const file of files) {
		const module = moduleOf(ctx, file);
		if (module === null) {
			unnamed = true;
			continue;
		}
		const dir = relative(module.src, file).split("\\").join("/").split("/").slice(0, -1);
		if (dir.length === 0) unnamed = true;
		else packages.add(dir.join("."));
	}
	return { packages: [...packages].sort(), unnamed };
}
