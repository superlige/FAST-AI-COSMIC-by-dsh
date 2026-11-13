/**
 * lint -- compile without keeping anything, then look up what does exist (S3.1).
 *
 * It is `fast`'s compile step minus two things: writing classes and restarting
 * the resident JVM. javac accepts an @argfile (the only way to pass a classpath
 * of ~4500 jars), classes go to a throwaway directory, so lint pollutes neither
 * the module output tree nor the resident JVM. About five seconds; it starts no
 * Cosmic and touches no database, which is why it can be run freely.
 *
 * Structure change from the frozen driver: lintCore returned raw text and
 * reportDiags printed. Here the command returns a LintReport -- findings,
 * timings, and the queries that were answered -- and the caller decides how to
 * show it. There is no rendering module: an agent has to be able to decide "did
 * this pass" without parsing console prose (D9), so nothing in the kernel
 * formats for a terminal. (The probe side does have an output module,
 * probe/output.ts, but that is a different job: separating a probe's
 * machine-readable bypass from thousands of lines of Cosmic startup logging.)
 *
 * S7.4 added the knowledge half. lint is the necessary path before a compile --
 * `fast` runs it itself -- which makes it the one place that can say "this is a
 * plugin, here is the official entry point" before the code is written rather
 * than after. It previews the gate and never enforces it: diagnosis, probes and
 * verification all stay usable without any official document, and only turning
 * plugin code into reality (`fast`) is gated.
 */

import { relative } from "node:path";
import type { KnowledgeAdvice, KnowledgeAdvisor } from "../../knowledge/plugin-gate.ts";
import { runApiTool } from "../api-tool.ts";
import type { KernelContext } from "../context.ts";
import { applySuggestions, buildQueries, type Finding, parseDiags, parseSuggest } from "../diag/javac.ts";
import { err, type KernelResult, ok } from "../errors.ts";
import { ensureBuilt, runJavac, type ToolRun } from "../toolchain.ts";
import { stampClean } from "./sources.ts";

export interface LintReport {
	files: string[];
	findings: Finding[];
	/** javac exit status. Non-zero with no findings means an unparsed failure. */
	status: number;
	seconds: string;
	/** Raw javac output, kept for the "failed but produced no parsable diagnostic" case. */
	raw: string;
	/** True when the reflection lookup could not run, so hints are missing. */
	suggestionsUnavailable: boolean;
	/**
	 * The plugin-knowledge hints and the gate PREVIEW for these files (S7.4).
	 *
	 * lint previews, `fast` refuses, and both read the verdict produced by the
	 * same advisor closure. Null means no knowledge source was resolvable, which
	 * is not the same as "nothing recognised" (advice with an empty hint list).
	 */
	knowledge: KnowledgeAdvice | null;
}

export interface LintHooks {
	/**
	 * The same advisor `fast` gets. lint is a diagnosis and never refuses on its
	 * account -- it reports what fast would do, so that "lint says it will block"
	 * and "fast blocks" are one fact rather than two implementations of one.
	 */
	knowledge?: KnowledgeAdvisor;
}

/**
 * The compile-only pass. Shared by `lint` and by `fast`'s pre-flight check, so
 * the two can never disagree about what counts as clean.
 *
 * -sourcepath covers every code module's source dir: a linted file usually
 * references classes in its own module that may never have been compiled.
 * -implicit:none makes javac resolve them without writing their class files.
 * -Xdiags:verbose is the important one: the default diagnostic collapses an
 * overload mismatch into "incompatible types", while verbose lists every
 * candidate and says which argument is wrong.
 */
export async function lintCore(ctx: KernelContext, files: readonly string[]): Promise<KernelResult<ToolRun>> {
	const built = await ensureBuilt(ctx);
	if (!built.ok) return built;

	const { fs } = ctx.ports;
	fs.mkdirp(ctx.layout.lintClasses);
	const dirs = ctx.layout.moduleDirs.map((dir) => dir.src).filter((dir) => fs.exists(dir));
	// Probes reference shared classes (IsvGuard, MetaResolve); without probes/ on
	// the sourcepath lint reports those as "cannot find symbol", and a fake
	// problem is worse than no report. FormSim and ListSim also use the host's
	// headless views, which sit in a named package outside any sourcepath layout,
	// so that one file is handed to javac directly.
	const hostViews: string[] = [];
	if (files.some((file) => !relative(ctx.layout.resourcesDir, file).startsWith(".."))) {
		dirs.push(ctx.layout.probesDir);
		if (fs.exists(ctx.layout.viewsSrc) && !files.includes(ctx.layout.viewsSrc)) hostViews.push(ctx.layout.viewsSrc);
	}
	const sourcePath = dirs.join(ctx.platform === "win32" ? ";" : ":");

	return ok(
		await runJavac(ctx, [
			"-encoding",
			"UTF-8",
			`@${ctx.layout.javacArgs}`,
			"-nowarn",
			"-proc:none",
			"-implicit:none",
			"-Xdiags:verbose",
			"-d",
			ctx.layout.lintClasses,
			...(sourcePath ? ["-sourcepath", sourcePath] : []),
			...files,
			...hostViews,
		]),
	);
}

/**
 * Runs one suggest batch through the shared ApiTool runner.
 *
 * Returns null when the lookup cannot run at all (ApiTool source not released, or
 * its compile failed). That is reported as "hints unavailable" rather than being
 * swallowed: a lint run whose hints silently vanished looks like a lint that found
 * nothing worth saying.
 */
async function runSuggest(ctx: KernelContext, queries: readonly string[][]): Promise<Map<string, string[]> | null> {
	if (queries.length === 0) return new Map();
	const queryFile = `${ctx.layout.agentCache}/lint-queries.txt`;
	ctx.ports.fs.write(queryFile, queries.map((query) => query.join("\t")).join("\n"));
	const run = await runApiTool(ctx, ["suggest", queryFile, ctx.layout.javacArgs]);
	if (run === null || run.status !== 0) return null;
	return parseSuggest(run.out);
}

/** Runs the check and enriches its diagnostics with reflection candidates. */
export async function lint(
	ctx: KernelContext,
	files: readonly string[],
	hooks: LintHooks = {},
): Promise<KernelResult<LintReport>> {
	const run = await lintCore(ctx, files);
	if (!run.ok) return err(run.error);

	const diags = parseDiags(run.value.out, ctx.projectRoot);
	const { queries, findings } = buildQueries(diags, (file) => ctx.ports.fs.read(file));
	const suggestions = await runSuggest(ctx, queries);
	const enriched = suggestions === null ? [...findings] : applySuggestions(findings, suggestions);

	if (findings.length === 0 && run.value.status === 0) stampClean(ctx, files);

	return ok({
		files: [...files],
		findings: enriched,
		status: run.value.status,
		seconds: run.value.seconds,
		raw: run.value.out,
		suggestionsUnavailable: suggestions === null && queries.length > 0,
		knowledge: hooks.knowledge ? hooks.knowledge(files) : null,
	});
}
