import { dirname } from "node:path";
import { KernelError, type KernelResult, ok } from "../errors.ts";
import type { FsPort } from "../ports.ts";
import { ensureCosmicIgnore } from "../project/layout-upkeep.ts";
import { projectConfigFile, type UserConfig } from "./load-config.ts";

export interface ProjectConfigAnswers {
	isv?: string;
	debugModule?: string;
	codeModules?: string[];
	appClass?: string;
	appMethod?: string;
	account?: string;
	user?: string;
}

export interface ProjectConfigInitialization {
	file: string;
	gitignoreFile: string;
	created: boolean;
	changed: boolean;
	writtenFields: string[];
}

export interface ProjectConfigInitializationInput {
	root: string;
	answers: ProjectConfigAnswers;
	/** Exact text observed by doctor. A mismatch refuses the write. */
	expectedText: string;
	expectedExists: boolean;
	declaredModules: readonly string[];
}

const JAVA_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const JAVA_CLASS = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+$/;

function blank(value: unknown): boolean {
	return value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
}

export function validateProjectConfigAnswers(
	answers: ProjectConfigAnswers,
	declaredModules: readonly string[],
): string[] {
	const problems: string[] = [];
	if (answers.isv !== undefined && !/^[a-z0-9]+$/.test(answers.isv)) problems.push("ISV 只能包含小写字母和数字");
	if (answers.debugModule !== undefined && !declaredModules.includes(answers.debugModule))
		problems.push(`调试模块不在 settings.gradle 中：${answers.debugModule}`);
	if (answers.codeModules !== undefined) {
		if (answers.codeModules.length === 0) problems.push("代码模块不能为空");
		for (const module of answers.codeModules)
			if (!declaredModules.includes(module)) problems.push(`代码模块不在 settings.gradle 中：${module}`);
	}
	if (answers.appClass !== undefined && !JAVA_CLASS.test(answers.appClass))
		problems.push("Java 类名必须是全限定名，例如 com.example.DebugApplication");
	if (answers.appMethod !== undefined && !JAVA_IDENTIFIER.test(answers.appMethod))
		problems.push("Java 方法名格式不合法");
	if (answers.account !== undefined && answers.account.trim() === "") problems.push("账套不能为空");
	if (answers.user !== undefined && answers.user.trim() === "") problems.push("用户不能为空");
	return problems;
}

function parseConfig(raw: string, file: string): KernelResult<UserConfig> {
	if (raw === "") return ok({});
	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
			throw new Error("config.json 顶层必须是对象");
		return ok(parsed as UserConfig);
	} catch (error) {
		return {
			ok: false,
			error: new KernelError(
				"CONFIG_PARSE_FAILED",
				`config.json 解析失败：${error instanceof Error ? error.message : String(error)}`,
				{
					detail: { configFile: file },
					remedy: `修好 ${file} 的 JSON 语法后重跑 doctor。`,
				},
			),
		};
	}
}

export function initializeProjectConfig(
	input: ProjectConfigInitializationInput,
	fs: FsPort,
): KernelResult<ProjectConfigInitialization> {
	const file = projectConfigFile(input.root);
	const current = fs.read(file);
	if (current !== input.expectedText || fs.exists(file) !== input.expectedExists) {
		return {
			ok: false,
			error: new KernelError("CONFIG_INIT_CONFLICT", "配置向导运行期间 config.json 已变化，拒绝覆盖", {
				detail: { configFile: file },
				remedy: "重新运行 doctor 和配置向导，确认刚刚的外部修改。",
			}),
		};
	}
	const problems = validateProjectConfigAnswers(input.answers, input.declaredModules);
	if (problems.length > 0) {
		return {
			ok: false,
			error: new KernelError("CONFIG_INIT_INVALID", problems.join("；"), {
				detail: { configFile: file, problems },
				remedy: "修正输入后重新确认。",
			}),
		};
	}
	const parsed = parseConfig(current, file);
	if (!parsed.ok) return parsed;
	const next: UserConfig = { ...parsed.value };
	const writtenFields: string[] = [];
	for (const [key, value] of Object.entries(input.answers)) {
		if (value === undefined || !blank(next[key])) continue;
		next[key] = value;
		writtenFields.push(key);
	}
	const text = `${JSON.stringify(next, null, 2)}\n`;
	const created = !input.expectedExists;
	if (created) {
		fs.mkdirp(dirname(file));
		if (!fs.tryCreate(file, text)) {
			return {
				ok: false,
				error: new KernelError("CONFIG_INIT_CONFLICT", "config.json 已被其他进程创建，拒绝覆盖", {
					detail: { configFile: file },
					remedy: "重新运行 doctor 和配置向导。",
				}),
			};
		}
	} else if (text !== current) {
		fs.write(file, text);
	}
	const gitignoreFile = ensureCosmicIgnore(dirname(file), fs).file;
	return ok({ file, gitignoreFile, created, changed: text !== current, writtenFields });
}
