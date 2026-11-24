/**
 * Setting the project's own config.json from the model (`cosmic_doctor action=config`).
 *
 * Detection reads the project's files; when a project is shaped differently from the
 * templates detection knows, the model reads the same files and says what the answer is.
 * This is the one door for that answer, and it checks each value against the project
 * before writing it: a module name must be one settings.gradle includes, a launch method
 * must exist in the launch class source, a JDK must have a bin/java. A value that only
 * fails at JVM start costs a cold start (half a minute) to learn it was a typo.
 *
 * `account` and `user` are not settable here. Nothing in the project answers them and a
 * wrong value has no symptom at all (another account set's data, another person recorded
 * as modifier), so only the person picks them, in the setup prompt.
 *
 * Writing `null` removes the key, which hands the field back to detection or the default.
 * Every write reports each field before and after.
 */

import { dirname, join } from "node:path";
import { KernelError, type KernelResult, ok } from "../errors.ts";
import type { FsPort } from "../ports.ts";
import { ensureCosmicIgnore } from "../project/layout-upkeep.ts";
import { APP_METHOD_MAIN, type AutoDetected, methodBody } from "./detect.ts";
import { decomment, moduleRoot } from "./gradle.ts";
import { argList, projectConfigFile, USER_ANSWERED_FIELDS, type UserConfig } from "./load-config.ts";

/** What each settable field means, for the tool's own refusal text and for doctor. */
export const SETTABLE_FIELDS: Readonly<Record<string, string>> = {
	isv: "ISV 标识（小写字母和数字）",
	tenant: "租户编码",
	debugModule: "调试启动模块名（settings.gradle 里的）",
	codeModules: "代码模块，整体替换自动探测的结果",
	extraCodeModules: "在自动探测的代码模块上补几个",
	excludeCodeModules: "从自动探测的代码模块里去掉几个",
	appClass: "启动类全限定名",
	appMethod: "启动类里只配置、不起服务的无参静态方法名；配置和 start() 都写在 main 里的填 main",
	cosmicHome: "苍穹运行时目录（工程 gradle.properties 没写 systemProp.cosmic_home 时才用）",
	javaHome: "JDK 目录，盖过 gradle.properties 的 org.gradle.java.home 和 JAVA_HOME",
	jvmArgs: "追加给探针和调试节点 JVM 的参数；写了 -Xmx 等就替换默认的那项",
	gradleArgs: '每次调 gradlew 追加的参数，整体替换默认的 ["--offline"]',
	knowledgeRoot: "知识库覆盖目录",
	debugPort: "调试节点端口",
	probeServerPort: "常驻探针 JVM 端口",
	jrebel: "常驻 JVM 挂不挂 JRebel：auto / 原生库路径 / off",
	dbLink: "连库方式：fast / platform",
};

export interface ConfigChange {
	field: string;
	before: unknown;
	after: unknown;
}

export interface SetConfigReport {
	file: string;
	changes: ConfigChange[];
	/** Passed, but worth saying (a launch class whose source is not in the debug module, ...). */
	notes: string[];
}

export interface SetConfigInput {
	root: string;
	changes: Readonly<Record<string, unknown>>;
	/** Detection as it stands now: declared modules, module directories, the project's cosmic_home. */
	auto: AutoDetected;
	/** The debug module in force after this change (changed or current); null when none. */
	currentDebugModule: string | null;
	currentAppClass: string | null;
	currentAppMethod: string | null;
	platform: NodeJS.Platform;
}

const JAVA_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const JAVA_CLASS = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+$/;
/** These decide what the JVM runs; cosmic sets them itself, and a user copy breaks the launch. */
const LAUNCH_OWNED_JVM_ARGS = /^(-cp|-classpath|--class-path|-jar)$/;
const LIST_FIELDS = new Set(["codeModules", "extraCodeModules", "excludeCodeModules", "jvmArgs", "gradleArgs"]);

function invalid(message: string, problems: string[], file: string): KernelResult<never> {
	return {
		ok: false,
		error: new KernelError("CONFIG_SET_INVALID", message, {
			detail: { configFile: file, problems },
			remedy: "一项都没写。按 detail.problems 改了重发；要看每一项现在的值和出处，调 cosmic_doctor。",
		}),
	};
}

/** The launch class's source in the debug module, or null when it is not there (a jar on the classpath, say). */
function launchSource(input: SetConfigInput, fs: FsPort, debugModule: string | null, cls: string): string | null {
	if (debugModule === null) return null;
	const dirs = input.auto.gradleDirs?.[debugModule]?.src ?? [
		join(moduleRoot(input.root, debugModule, input.auto.moduleDirs), "src", "main", "java"),
	];
	for (const dir of dirs) {
		const file = join(dir, ...cls.split(".")) + ".java";
		const text = fs.read(file);
		if (text !== "") return decomment(text);
	}
	return null;
}

function checkOne(field: string, value: unknown, input: SetConfigInput, fs: FsPort, notes: string[]): string | null {
	const declared = input.auto.modules;
	if (LIST_FIELDS.has(field)) {
		if (!Array.isArray(value) && typeof value !== "string") return `${field} 要写成字符串数组`;
		const list = argList(value).map((item) => (field.endsWith("odules") ? item.replace(/^:+/, "") : item));
		if (field === "codeModules" && list.length === 0) return "codeModules 不能为空；想回到自动探测就写 null";
		if (field.endsWith("odules")) {
			const bad = list.filter((module) => !declared.includes(module));
			if (bad.length > 0)
				return `${field} 里 ${bad.join("、")} 不在 settings.gradle 的 include 里（有：${declared.join("、")}）`;
		}
		if (field === "jvmArgs") {
			const bad = list.filter((arg) => !arg.startsWith("-") || LAUNCH_OWNED_JVM_ARGS.test(arg));
			if (bad.length > 0) return `jvmArgs 只放以 - 开头的 JVM 选项，类路径和主类由 cosmic 定：${bad.join(" ")}`;
		}
		return null;
	}
	if (field === "debugPort" || field === "probeServerPort") {
		const port = Number(value);
		return Number.isInteger(port) && port > 0 && port < 65536 ? null : `${field} 要是 1～65535 的整数`;
	}
	if (field === "jrebel" && typeof value === "boolean") return null;
	if (typeof value !== "string" || value.trim() === "") return `${field} 要写成非空字符串；想删掉就写 null`;
	const text = value.trim();
	switch (field) {
		case "isv":
			return /^[a-z0-9]+$/.test(text) ? null : "isv 只能是小写字母和数字";
		case "debugModule": {
			const name = text.replace(/^:+/, "");
			return declared.includes(name)
				? null
				: `调试模块 ${name} 不在 settings.gradle 的 include 里（有：${declared.join("、")}）`;
		}
		case "appClass": {
			if (!JAVA_CLASS.test(text)) return "appClass 要写全限定名，例如 com.example.DebugApplication";
			if (launchSource(input, fs, input.currentDebugModule, text) === null)
				notes.push(`调试模块 ${input.currentDebugModule ?? "(未定)"} 的源码里没有 ${text}，按类路径上有它处理`);
			return null;
		}
		case "appMethod": {
			if (!JAVA_IDENTIFIER.test(text)) return "appMethod 要写一个 Java 方法名";
			const cls = input.currentAppClass;
			const source = cls === null ? null : launchSource(input, fs, input.currentDebugModule, cls);
			if (source === null) return null;
			if (text === APP_METHOD_MAIN)
				return /static\s+void\s+main\s*\(/.test(source) ? null : `${cls} 里没有 main 方法`;
			const head = new RegExp(String.raw`\bstatic\s+[\w.<>\[\],\s]+?\s+${text}\s*\(\s*\)`).exec(source);
			if (head === null)
				return methodBody(source, text) === null
					? `${cls} 里没有叫 ${text} 的方法`
					: `${cls}.${text} 要是不带参数的 static 方法：探针宿主不传参数、也没有实例可用`;
			return null;
		}
		case "cosmicHome": {
			if (!fs.exists(text)) return `目录不存在：${text}`;
			const declaredHome = input.auto.cosmicHome;
			if (declaredHome !== null && declaredHome !== text)
				return `工程 gradle.properties 已写 systemProp.cosmic_home=${declaredHome}，苍穹运行时以工程为准；要换就改工程那一行`;
			return null;
		}
		case "javaHome": {
			const home = text.replace(/[\\/]+$/, "");
			const java = input.platform === "win32" ? "java.exe" : "java";
			return fs.exists(join(home, "bin", java)) ? null : `${home} 下没有 bin/${java}，不是 JDK 目录`;
		}
		case "knowledgeRoot":
			return fs.exists(text) ? null : `目录不存在：${text}`;
		case "dbLink":
			return text === "fast" || text === "platform" ? null : "dbLink 只认 fast / platform";
		default:
			return null;
	}
}

function normalised(field: string, value: unknown): unknown {
	if (LIST_FIELDS.has(field))
		return argList(value).map((item) => (field.endsWith("odules") ? item.replace(/^:+/, "") : item));
	if (field === "debugPort" || field === "probeServerPort") return Number(value);
	if (typeof value === "string") return field === "debugModule" ? value.trim().replace(/^:+/, "") : value.trim();
	return value;
}

export function setProjectConfig(input: SetConfigInput, fs: FsPort): KernelResult<SetConfigReport> {
	const file = projectConfigFile(input.root);
	const entries = Object.entries(input.changes);
	if (entries.length === 0) return invalid("没有要改的项", ["set 里至少写一项"], file);

	const problems: string[] = [];
	const notes: string[] = [];
	for (const [field, value] of entries) {
		if (USER_ANSWERED_FIELDS.includes(field)) {
			problems.push(`${field} 只能由用户来选（打开工程时会弹框；弹不了请用户输入 /cosmic-env），这里不改`);
			continue;
		}
		if (SETTABLE_FIELDS[field] === undefined) {
			problems.push(`不认识 ${field}；能设的有：${Object.keys(SETTABLE_FIELDS).join("、")}`);
			continue;
		}
		if (value === null) continue;
		const problem = checkOne(field, value, input, fs, notes);
		if (problem !== null) problems.push(problem);
	}
	if (problems.length > 0) return invalid(`有 ${String(problems.length)} 项不能写`, problems, file);

	const raw = fs.read(file);
	let current: UserConfig = {};
	if (raw !== "") {
		try {
			const parsed: unknown = JSON.parse(raw);
			if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("顶层必须是对象");
			current = parsed as UserConfig;
		} catch (error) {
			return {
				ok: false,
				error: new KernelError(
					"CONFIG_PARSE_FAILED",
					`工程配置解析失败：${error instanceof Error ? error.message : String(error)}`,
					{
						detail: { configFile: file },
						remedy: `先修好 ${file} 的 JSON 语法；这次一项都没写。`,
					},
				),
			};
		}
	}
	const next: UserConfig = { ...current };
	const changes: ConfigChange[] = [];
	for (const [field, value] of entries) {
		const before = current[field] ?? null;
		if (value === null) delete next[field];
		else next[field] = normalised(field, value);
		const after = next[field] ?? null;
		if (JSON.stringify(before) !== JSON.stringify(after)) changes.push({ field, before, after });
	}
	if (changes.length > 0) {
		fs.mkdirp(dirname(file));
		fs.write(file, `${JSON.stringify(next, null, 2)}\n`);
		ensureCosmicIgnore(dirname(file), fs);
	}
	return ok({ file, changes, notes });
}
