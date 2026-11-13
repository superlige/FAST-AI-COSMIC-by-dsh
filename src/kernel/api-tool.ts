/**
 * Running the frozen `ApiTool` (S7.2).
 *
 * `ApiTool` answers the one question reflection is the authority on: what does the
 * user's JAR actually declare. `lint` has needed that since S3.1 (its `suggest`
 * back end) and the D8 join needs it too, so the compile-if-stale-then-run dance
 * lives here rather than twice.
 *
 * Everything returns null rather than throwing when the tool cannot run at all --
 * source not released, javac failed, no pathing jar yet. A null is reported by the
 * caller as "reflection unavailable", never swallowed: an API join that silently
 * degrades to the document side alone would present a snapshot as verified fact,
 * which is the exact failure D8 exists to prevent.
 */
import { baseChildEnv, type KernelContext } from "./context.ts";
import { classpathOf, runJava, runJavac, type ToolRun } from "./toolchain.ts";

/** Compiles ApiTool if its class file is missing or older than its source. */
async function ensureCompiled(ctx: KernelContext): Promise<boolean> {
	const { fs } = ctx.ports;
	if (!fs.exists(ctx.layout.apiToolSrc)) return false;
	const classFile = `${ctx.layout.toolClasses}/ApiTool.class`;
	const classMs = fs.mtimeMs(classFile);
	const srcMs = fs.mtimeMs(ctx.layout.apiToolSrc);
	if (classMs !== null && (srcMs === null || srcMs <= classMs)) return true;
	fs.mkdirp(ctx.layout.toolClasses);
	const run = await runJavac(ctx, ["-encoding", "UTF-8", "-d", ctx.layout.toolClasses, ctx.layout.apiToolSrc]);
	return run.status === 0;
}

/** Runs one `ApiTool <args>` invocation, or null when the tool is unavailable. */
export async function runApiTool(ctx: KernelContext, args: readonly string[]): Promise<ToolRun | null> {
	if (!(await ensureCompiled(ctx))) return null;
	return runJava(
		ctx,
		["-Dfile.encoding=UTF-8", "-cp", classpathOf(ctx.layout.toolClasses, ctx.layout.pathingJar), "ApiTool", ...args],
		baseChildEnv(ctx),
	);
}

/**
 * Reflection's view of one class, as `sig` stdout.
 *
 * A class the JAR does not have is not an error here: `ApiTool` exits 3 and says
 * 找不到类, and that IS the answer -- a documented class missing from this JAR is
 * the class-level dangling anchor. The text is returned so the caller can tell that
 * apart from "the tool could not run", which is null.
 */
export async function reflectClass(ctx: KernelContext, fqcn: string): Promise<string | null> {
	const run = await runApiTool(ctx, ["sig", fqcn]);
	if (run === null) return null;
	// Exit 3 is 找不到类; anything else non-zero means the run itself went wrong.
	if (run.status !== 0 && run.status !== 3) return null;
	return run.out;
}

/**
 * The whole-snapshot sweep, in one JVM.
 *
 * `ApiTool suggest` takes a query FILE and answers all of it in a single process.
 * That is the only reason a 1,520-class anchor sweep is affordable at all: per-class
 * `sig` would be 1,520 JVM starts. Returns stdout so the caller parses it, keeping
 * this port free of knowledge-layer types.
 */
export async function reflectBatch(ctx: KernelContext, queryFileText: string): Promise<string | null> {
	const known = answersFor(ctx);
	const queries = queryFileText
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => {
			const tab = line.indexOf("\t");
			return { id: tab < 0 ? line : line.slice(0, tab), ask: tab < 0 ? "" : line.slice(tab + 1), line };
		});
	const missing = queries.filter((query) => !known.has(query.ask));
	if (missing.length > 0) {
		const queryFile = `${ctx.layout.agentCache}/anchor-queries.txt`;
		ctx.ports.fs.write(queryFile, missing.map((query) => query.line).join("\n"));
		const run = await runApiTool(ctx, ["suggest", queryFile, ctx.layout.javacArgs]);
		if (run === null || run.status !== 0) return null;
		const fresh = suggestSections(run.out);
		for (const query of missing) {
			const lines = fresh.get(query.id);
			if (lines !== undefined) known.set(query.ask, lines);
		}
	}
	return queries
		.flatMap((query) => {
			const lines = known.get(query.ask);
			return lines === undefined ? [] : [`@@ ${query.id}`, ...lines];
		})
		.map((line) => `${line}\n`)
		.join("");
}

/**
 * 问过的不再问：同一份 JAR 上，「这个类在不在」「这个方法有哪些重载」的答案不会变。
 *
 * `suggest` 每次都要另起一个 Java 进程。临时探针每跑一次都先问一遍它用到的类和方法，源码一个字没改也照问：
 * 真机 2026-10-11 一场会话 5 次临时探针，发给常驻进程之前各多等 1.9 秒（头一回 10.9 秒），而普通查询探针是 0.2 秒。
 * 答案按「问的是什么」记（查询行去掉编号），一批里没问过的才发给小工具，都问过就不起进程。
 *
 * 只记在这个进程的内存里，按类路径文件的修改时间认：工程重新构建、类路径换了，就从头再问。
 * 不落盘——JAR 原地换掉而类路径文件没动时，落盘的答案会把能编过的调用拦下来，那比多等两秒贵。
 */
const answered = new Map<string, { stamp: string; answers: Map<string, string[]> }>();

/** 把记着的答案全忘掉：测试之间互不沾染，尺子拿它量「每次都重新问」是什么样。 */
export function forgetReflectionAnswers(): void {
	answered.clear();
}

function answersFor(ctx: KernelContext): Map<string, string[]> {
	const { fs } = ctx.ports;
	const stamp = [
		ctx.layout.pathingJar,
		String(fs.mtimeMs(ctx.layout.pathingJar)),
		String(fs.mtimeMs(ctx.layout.javacArgs)),
	].join("|");
	const held = answered.get(ctx.layout.javacArgs);
	if (held !== undefined && held.stamp === stamp) return held.answers;
	const answers = new Map<string, string[]>();
	answered.set(ctx.layout.javacArgs, { stamp, answers });
	return answers;
}

/** `suggest` 的输出按「@@ 编号」分段；和 `parseSuggest` 同一条规矩，放这里是为了不让这个端口依赖诊断层。 */
function suggestSections(output: string): Map<string, string[]> {
	const sections = new Map<string, string[]>();
	let current: string[] | null = null;
	for (const line of output.split("\n")) {
		const head = /^@@ (\S+)\s*$/.exec(line);
		if (head) {
			current = [];
			sections.set(head[1] as string, current);
			continue;
		}
		if (current && line.trim()) current.push(line.replace(/\r$/, ""));
	}
	return sections;
}

/**
 * Reverse lookup by class-name keyword, as `ApiTool find` stdout (S5.2).
 *
 * Not reflection at all: it walks the jars on the argfile's classpath and reads
 * their entry names, which is why it answers for a class the JVM could never
 * load. That is the point -- this is the command for "I do not remember the
 * package", and requiring the class to be loadable would fail exactly when the
 * name is wrong.
 *
 * The argfile is passed explicitly rather than left to ApiTool's own default,
 * which is the relative `build/cosmic-javac.args`: cosmic runs with the project
 * as cwd today, but a default that only works because of the cwd is one
 * refactor away from silently scanning nothing.
 */
export async function findClasses(ctx: KernelContext, keyword: string): Promise<string | null> {
	const run = await runApiTool(ctx, ["find", keyword, ctx.layout.javacArgs]);
	if (run === null || run.status !== 0) return null;
	return run.out;
}

/** The reflection side of the join, as a port so the kernel stays testable without a JAR. */
export interface ReflectionPort {
	/** `ApiTool sig <fqcn>` stdout, or null when reflection cannot run at all. */
	sig(fqcn: string): Promise<string | null>;
	/** `ApiTool suggest` stdout for a whole query file, or null when it cannot run. */
	batch(queryFileText: string): Promise<string | null>;
	/** `ApiTool find <keyword>` stdout, or null when the scan cannot run. */
	find(keyword: string): Promise<string | null>;
	/**
	 * Why every call answers null, when that is known before any call is made.
	 *
	 * Without it the only explanation on offer was "ApiTool 未释放或编译失败，也可能
	 * 还没跑过一次构建", printed with a rebuild hint -- also to a session whose
	 * project was built and whose port had simply never been given the project.
	 */
	readonly unavailable?: string;
}

export function nodeReflectionPort(ctx: KernelContext): ReflectionPort {
	return {
		sig: (fqcn) => reflectClass(ctx, fqcn),
		batch: (text) => reflectBatch(ctx, text),
		find: (keyword) => findClasses(ctx, keyword),
	};
}

/** A port for when no project is open, so there is no JAR to ask. Reports unavailable rather than empty. */
export const UNAVAILABLE_REFLECTION: ReflectionPort = {
	sig: async () => null,
	batch: async () => null,
	find: async () => null,
	unavailable: "还没打开工程，够不着当前 JAR：先 cosmic_open_project，再查",
};
