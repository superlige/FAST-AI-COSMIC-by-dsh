/**
 * 挂在 dsh 工具流水线上的三处：执行前门槛、文件工具写完之后、读文件之后。
 *
 * 执行前（`tools/pre-execute`）：
 *   - 产品工具：排障会话里改东西的调用、同一失败第三次，在进工具之前拒；
 *   - 文件工具：排障会话里写工程文件（write / edit / apply_patch）拒，`.cosmic-ai/` 下自己的东西不拦；
 *     开发会话里，工程 Java 第一次被写之前记下原样（写法检查只报这次新加的），新建的源码 Java 记下要登记进 git。
 * 写完之后：记进本会话改过的文件（源码版本前进、编译新鲜度作废），附上这个插件族的知识卡片和这次新加的写法问题。
 * 读完之后：插件类第一次读到附上周边和知识卡片；大 Java 第一次整份读给提纲；原样再读一遍换成一句话。
 *
 * 拒绝时错误码写在理由文字里：dsh 交给模型的只有这段文字。
 */

import type { ToolExecution, ToolExecutionResult } from "@deepseek-ai/dsh-tools";
import { modeRefusal, PROD_MODE_REMEDY, prodModeBlocksFileWrite } from "../agent/state/prod-state.ts";
import { surroundingsForRead } from "../agent/tools/class-surroundings.ts";
import { outlineInsteadOfRead } from "../agent/tools/java-outline.ts";
import { isCosmicToolName } from "../agent/tools/names.ts";
import { noteRead } from "../agent/tools/read-ledger.ts";
import { rememberOriginal, styleAfterWrite } from "../agent/tools/style-check.ts";
import { comparablePath, toolFilePath } from "../agent/tools/tool-path.ts";
import { isAdHocProbeFile } from "../kernel/layout.ts";
import { metaWritePlan } from "../kernel/meta/parse.ts";
import type { CosmicHost } from "./host.ts";
import type { CosmicSession } from "./session.ts";
import { streakRefusal } from "./streak.ts";

type Decision = { kind: "allow" } | { kind: "deny"; reason: string; info: { name: string; code: string } };

const ALLOW: Decision = { kind: "allow" };

function deny(code: string, message: string, remedy: string): Decision {
	return { kind: "deny", reason: `[${code}] ${message}\n修复：${remedy}`, info: { name: "CosmicGate", code } };
}

/** apply_patch 补丁里动到的每个路径（新建、修改、删除、改名的目标）。 */
export function patchPaths(patch: string): string[] {
	const paths: string[] = [];
	for (const line of patch.split(/\r?\n/)) {
		const match = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/.exec(line.trim());
		if (match?.[1] !== undefined) paths.push(match[1].trim());
	}
	return paths;
}

/** 一次文件工具调用要写的路径；不是写文件的工具返回 null。 */
export function writtenPaths(name: string, args: unknown): string[] | null {
	const input = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
	if (name === "write" || name === "edit") return typeof input.file_path === "string" ? [input.file_path] : [];
	if (name === "apply_patch") return typeof input.input === "string" ? patchPaths(input.input) : [];
	return null;
}

function inside(root: string, file: string): boolean {
	return comparablePath(file).startsWith(`${comparablePath(root).replace(/\/$/, "")}/`);
}

export interface HookDeps {
	host: CosmicHost;
	/** 会话工作目录；没有会话时用进程当前目录。 */
	cwdOf(exec: Pick<ToolExecution, "agent" | "signal">): Promise<string>;
	/** 产品工具中不经门槛的那几种调用（问用法、按行取回）。 */
	ungated(name: string, args: unknown): boolean;
}

export function sessionOf(host: CosmicHost, exec: Pick<ToolExecution, "agent">): CosmicSession {
	return host.sessions.of(exec.agent?.id);
}

/** 执行前门槛。 */
export async function preExecute(deps: HookDeps, exec: ToolExecution): Promise<Decision> {
	const { host } = deps;
	const session = sessionOf(host, exec);
	if (isCosmicToolName(exec.name)) {
		if (deps.ungated(exec.name, exec.arguments)) return ALLOW;
		const mode = modeRefusal(host.mode, exec.name, exec.arguments, (argv) => metaWritePlan(argv) !== null);
		if (mode !== null) return deny(mode.code, mode.message, mode.remedy);
		const repeat = streakRefusal(session.streak, session.factsRevision, exec.name, exec.arguments);
		if (repeat !== null) return deny(repeat.code, repeat.message, repeat.remedy);
		return ALLOW;
	}
	const paths = writtenPaths(exec.name, exec.arguments);
	if (paths === null || paths.length === 0) return ALLOW;
	const root = session.project?.root ?? (await deps.cwdOf(exec));
	const files = paths.map((path) => toolFilePath(path, root));
	if (host.mode === "prod") {
		const blocked = files.filter((file) => prodModeBlocksFileWrite(file, root));
		if (blocked.length > 0)
			return deny("PROD_MODE_READ_ONLY", `生产排障会话里工程文件只读：${blocked.join("、")}`, PROD_MODE_REMEDY);
		return ALLOW;
	}
	// 先接回重开前落盘的原文：不然这次写之前的内容会被当成「会话开始时」。
	session.restore(root);
	for (const file of files) {
		if (!file.toLowerCase().endsWith(".java") || !inside(root, file) || isAdHocProbeFile(file)) continue;
		try {
			rememberOriginal(session.style, comparablePath(file), file);
		} catch {
			// 读不到原样就不查这个文件，写入照常
		}
		if (exec.name === "write") session.gitNewJava.beforeWrite(root, file);
	}
	return ALLOW;
}

function textOf(result: Readonly<ToolExecutionResult>): string {
	return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

/** 写文件工具成功之后要附给模型的文字；没有返回 null。 */
export async function afterWrite(deps: HookDeps, exec: ToolExecution, result: Readonly<ToolExecutionResult>) {
	const { host } = deps;
	const session = sessionOf(host, exec);
	try {
		await session.gitNewJava.sweep();
	} catch {
		// 登记是顺手做的，失败了写文件照常
	}
	if (result.isError) return null;
	const paths = writtenPaths(exec.name, exec.arguments);
	if (paths === null || paths.length === 0) return null;
	const root = session.project?.root ?? (await deps.cwdOf(exec));
	const files = paths.map((path) => toolFilePath(path, root));
	const lines: string[] = [];
	const plugins: string[] = [];
	for (const file of files) {
		session.noteEdited(file);
		if (!file.toLowerCase().endsWith(".java") || !inside(root, file)) continue;
		if (exec.name === "write") {
			try {
				await session.gitNewJava.afterWrite(root, file);
			} catch {
				// 同上
			}
		}
		if (isAdHocProbeFile(file)) continue;
		plugins.push(file);
		const style = styleAfterWrite({ ledger: session.style, root, key: comparablePath(file) });
		if (style !== null) lines.push(style);
	}
	session.save(root);
	if (plugins.length > 0 && session.project !== undefined) {
		const capsules = await host.kernel.sourceCapsules(session.project.root, session.project.runtimeKeyId, plugins);
		const block = capsules.ok ? await host.deliverCapsules(callFor(deps, exec, session), capsules.value) : "";
		if (block !== "") lines.unshift(block);
	}
	return lines.length === 0 ? null : lines.join("\n");
}

/** 读文件之后：要换掉的正文和要附的文字；都没有返回 null。 */
export async function afterRead(
	deps: HookDeps,
	exec: ToolExecution,
	result: Readonly<ToolExecutionResult>,
): Promise<{ replace?: string; append: string[] } | null> {
	if (exec.name !== "read" || result.isError) return null;
	if (result.content.some((part) => part.type !== "text")) return null;
	const input = (typeof exec.arguments === "object" && exec.arguments !== null ? exec.arguments : {}) as Record<
		string,
		unknown
	>;
	const path = input.file_path;
	if (typeof path !== "string") return null;
	const offset = typeof input.offset === "number" ? input.offset : undefined;
	const limit = typeof input.limit === "number" ? input.limit : undefined;
	const { host } = deps;
	const session = sessionOf(host, exec);
	const root = session.project?.root;
	const append: string[] = [];
	if (root !== undefined) {
		const file = toolFilePath(path, root);
		const projectJava = inside(root, file) && !isAdHocProbeFile(file);
		if (projectJava && file.toLowerCase().endsWith(".java")) {
			const around = surroundingsForRead({ root, file, key: comparablePath(file), ledger: session.reads });
			if (around !== null) append.push(around);
			const capsules = await host.kernel.sourceCapsules(root, session.project?.runtimeKeyId ?? "", [file]);
			const block = capsules.ok ? await host.deliverCapsules(callFor(deps, exec, session), capsules.value) : "";
			if (block !== "") append.push(block);
		}
		const outline = projectJava
			? outlineInsteadOfRead({
					path,
					file,
					offset,
					limit,
					outlined: session.reads.outlined,
					key: comparablePath(file),
				})
			: null;
		if (outline !== null) {
			session.reads.reads += 1;
			return { replace: outline, append };
		}
	}
	const verdict = noteRead(session.reads, { path, offset, text: textOf(result) });
	if (verdict.repeat) return { replace: verdict.note, append };
	return append.length === 0 ? null : { append };
}

/** 钩子里交知识卡片也要一个调用上下文：卡片记在哪个会话的账上。 */
function callFor(deps: HookDeps, exec: ToolExecution, session: CosmicSession) {
	return {
		tool: "cosmic_fast" as const,
		session: session as CosmicSession<never>,
		agent: exec.agent,
		signal: exec.signal,
		startedAt: new Date().toISOString(),
		cwd: () => deps.cwdOf(exec),
	};
}
