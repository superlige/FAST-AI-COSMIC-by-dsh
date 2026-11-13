/**
 * Config resolution. Ported from the frozen ref config.mjs (c7b8815).
 *
 * Four layers, later ones overriding earlier ones:
 *   1. auto-detection   -- from gradle.properties / settings.gradle / build.gradle
 *   2. 全局 config.json -- `<COSMIC_AGENT_DIR>/config.json`, one per machine
 *   3. 工程 config.json -- `<工程>/.cosmic-ai/config.json`, one per project
 *   4. environment      -- single-call override (COSMIC_ACCOUNT / COSMIC_USER / ...)
 *
 * Layer 3 is what makes this product usable on a machine that holds more than
 * one Cosmic project, which is the normal case: `account`, `user`, `isv`,
 * `codeModules` and `knowledgeRoot` are facts about ONE project, and a single
 * machine-wide file quietly applies project A's answers to project B. For
 * `account` that means connecting to somebody else's account set; for `user` it
 * has no symptom at all -- every write just records the wrong modifier. So the
 * project's own file wins over the machine's, and `doctor` names the file each
 * value came from rather than saying "config.json" and leaving the user to
 * guess which of the two it meant.
 *
 * The merge is per key, not per file: a machine-wide `user` stays in force for
 * every project that does not override it, which is the one field that really is
 * a property of the person rather than of the project.
 *
 * Defaults follow the frozen rule: isv / module names / launch class are always
 * detected and never defaulted; `account` gets no default because a wrong value
 * would turn "typo" into "connected to somebody else's account set"; `user` gets
 * no default because a wrong value has NO symptom at all -- every write silently
 * records the wrong modifier; `tenant` may default to ierp because a wrong value
 * fails loudly at connect time.
 *
 * Five deliberate departures from the frozen implementation, all recorded in
 * cosmic/docs/S2-skeleton.md -- (a)-(d) required by D9/S2.2, (e) by the fact that
 * one machine holds several Cosmic projects:
 *   (a) the module-level SOURCES map becomes a per-call record. In a one-command
 *       one-process CLI a module global was safe; in a resident agent it would
 *       leak the previous project's answer into this project's doctor output.
 *   (b) process.env is read only through an explicitly passed env object, so one
 *       kernel call cannot observe another call's environment mutation.
 *   (c) requireRuntime no longer prints and exits; it returns a KernelError.
 *   (d) cosmicHome is resolved separately (see resolveCosmicHome): agent config
 *       may not silently replace the project's own systemProp.cosmic_home.
 *   (e) the per-project layer above, and with it a per-field origin that names the
 *       file rather than just saying "config.json".
 */
import { join } from "node:path";
import { KernelError } from "../errors.ts";
import { type AutoDetected, detect, type FileSystemPort } from "./detect.ts";
import { applyModuleOverrides } from "./gradle.ts";

/** Where each field came from. doctor prints this: "did my config take effect" is never guessed. */
export type ConfigSource =
	| "环境变量"
	| "工程 .cosmic-ai/config.json"
	| "全局 config.json"
	| "自动探测"
	| "内置默认"
	| "(缺失)";

/** The two file layers, in precedence order. Named so doctor can say which file won. */
export type ConfigFileSource = "工程 .cosmic-ai/config.json" | "全局 config.json";

export interface FieldOrigin {
	source: ConfigSource;
	/** For env-sourced fields, the variable name; for file-sourced fields, the file path. */
	via: string;
}

export const ENV_KEYS = {
	isv: "COSMIC_ISV",
	tenant: "COSMIC_TENANT",
	account: "COSMIC_ACCOUNT",
	user: "COSMIC_USER",
	knowledgeRoot: "COSMIC_KNOWLEDGE_ROOT",
	jrebel: "COSMIC_JREBEL",
	dbLink: "COSMIC_DB_LINK",
} as const;

/**
 * 本机苍穹进程怎么连数据库（S59 §9）。
 * "fast"（默认）：一条 SQL 一趟发完、传输压缩——本机离数据库远，平台默认的三趟来回和不压缩都成了等待；
 * "platform"：照平台默认连，和服务器上一模一样（怀疑结果和连库方式有关时退回来对照）。
 */
export type DbLink = "fast" | "platform";

/** `<工程>/.cosmic-ai/config.json` -- the per-project layer, beside the delivery ledger it belongs to. */
export function projectConfigFile(root: string): string {
	return join(root, ".cosmic-ai", "config.json");
}

export interface UserConfig {
	[key: string]: unknown;
}

/** One config file, read and parsed. A parse failure is carried, never thrown (see loadConfig). */
export interface ConfigFileLayer {
	source: ConfigFileSource;
	file: string;
	exists: boolean;
	parseError: string | null;
	values: UserConfig;
}

export interface LoadConfigInput {
	root: string;
	/** Directory holding the machine-wide config.json. Passed in by the caller -- never derived from a hardcoded skill path. */
	agentConfigDir: string;
	/** Explicit environment snapshot. Callers pass process.env once, at the edge. */
	env: Readonly<Record<string, string | undefined>>;
}

export interface CosmicHomeResolution {
	/** The value the runtime should use. Null when the project declares none and no agent value applies. */
	value: string | null;
	source:
		| "工程 gradle.properties"
		| "工程 .cosmic-ai/config.json（gradle 未声明）"
		| "全局 config.json（gradle 未声明）"
		| "(缺失)";
	/**
	 * Set when a config.json declares a cosmicHome that differs from the project's
	 * own systemProp.cosmic_home. S2.2 forbids the agent value silently replacing
	 * the project value, so the project value is used and the disagreement is
	 * surfaced here for doctor and for the runtime gate to report.
	 */
	conflict: { projectValue: string; agentValue: string } | null;
}

const AGENT_HOME_SOURCE = {
	"工程 .cosmic-ai/config.json": "工程 .cosmic-ai/config.json（gradle 未声明）",
	"全局 config.json": "全局 config.json（gradle 未声明）",
} as const;

/**
 * S2.2: the Cosmic runtime JARs belong to the user's project, so the project's
 * own `systemProp.cosmic_home` is authoritative. A config.json `cosmicHome` may
 * only fill in when the project declares none; when both exist and disagree the
 * project wins and the conflict is reported. Letting the agent value win
 * silently would compile probes against one runtime while the project runs
 * another -- a mismatch whose symptom is an unrelated NoSuchMethodError.
 */
export function resolveCosmicHome(
	projectValue: string | null,
	agentValue: unknown,
	agentSource: ConfigFileSource = "全局 config.json",
): CosmicHomeResolution {
	const agent = typeof agentValue === "string" && agentValue.trim() !== "" ? agentValue.trim() : null;
	if (projectValue !== null && projectValue !== "") {
		return {
			value: projectValue,
			source: "工程 gradle.properties",
			conflict: agent !== null && agent !== projectValue ? { projectValue, agentValue: agent } : null,
		};
	}
	if (agent !== null) return { value: agent, source: AGENT_HOME_SOURCE[agentSource], conflict: null };
	return { value: null, source: "(缺失)", conflict: null };
}

export interface KernelConfig {
	root: string;
	/** The machine-wide file. Still called `configFile` because it is the layer that predates the project one. */
	configFile: string;
	configExists: boolean;
	/** `<工程>/.cosmic-ai/config.json` -- the per-project layer, which overrides the machine-wide one. */
	projectConfigFile: string;
	projectConfigExists: boolean;
	/** JSON parse failure from whichever file failed (project first), or null. Reported, never thrown here. */
	parseError: string | null;
	/** The file `parseError` came from. Null when both files parsed. */
	parseErrorFile: string | null;
	/** Both file layers, in precedence order, for reporting. */
	fileLayers: readonly ConfigFileLayer[];

	isv: string | null;
	tenant: string | null;
	account: string | null;
	user: string | null;
	debugModule: string | null;
	codeModules: string[];
	appClass: string | null;
	appMethod: string | null;
	cosmicHome: string | null;
	cosmicHomeResolution: CosmicHomeResolution;
	knowledgeRoot: string | null;
	debugPort: number;
	probeServerPort: number;
	/**
	 * 常驻 JVM 挂不挂 JRebel 换类（S27 3.1）。null = 不挂（默认，用 JDK 自带的换类：方法体和 private static/final 方法）；
	 * "auto" = 在本机 IDEA 插件目录里找；其余是 JRebel 原生库的路径（jrebel64.dll / libjrebel64.so）。
	 * 配置里写 true 等于 "auto"，false / "off" 等于不挂。JRebel 是用户自己装、自己授权的商业软件，
	 * 所以默认关，产品不依赖它。
	 */
	jrebel: string | null;
	/** 本机进程连数据库的方式，见 {@link DbLink}。配置里写 "platform" / "off" / false 退回平台默认，其余都是 "fast"。 */
	dbLink: DbLink;

	/** Per-call field origins. Replaces the frozen module-level SOURCES map. */
	sources: Readonly<Record<string, FieldOrigin>>;
	auto: AutoDetected;
}

const MISSING: FieldOrigin = { source: "(缺失)", via: "" };

export function sourceOf(config: KernelConfig, field: string): FieldOrigin {
	return config.sources[field] ?? MISSING;
}

function isBlank(value: unknown): boolean {
	return value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
}

/**
 * Reads one config file. A missing file is the normal state, not an error, and a
 * malformed one is carried out as `parseError` so doctor can still print
 * everything else -- that command exists for the case where the config is broken.
 */
function readLayer(source: ConfigFileSource, file: string, fs: FileSystemPort): ConfigFileLayer {
	const raw = fs.read(file);
	if (raw === "") return { source, file, exists: false, parseError: null, values: {} };
	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			return { source, file, exists: true, parseError: "config.json 顶层必须是对象", values: {} };
		}
		const values = parsed as UserConfig;
		// The old name bizModules is still honoured, and per file: config.json lives
		// on each machine, is not in version control, so a rename cannot be migrated.
		if (values.codeModules === undefined && values.bizModules !== undefined) values.codeModules = values.bizModules;
		return { source, file, exists: true, parseError: null, values };
	} catch (error) {
		return {
			source,
			file,
			exists: true,
			parseError: error instanceof Error ? error.message : String(error),
			values: {},
		};
	}
}

/**
 * Loads config. Missing required fields are NOT thrown here: doctor must be able
 * to list everything that is missing at once instead of reporting the first one
 * and stopping. Use missingRequired()/requireRuntime() at the point of use.
 */
export function loadConfig(input: LoadConfigInput, fs: FileSystemPort): KernelConfig {
	const { root, agentConfigDir, env } = input;
	const auto = detect(root, fs);
	const projectLayer = readLayer("工程 .cosmic-ai/config.json", projectConfigFile(root), fs);
	const globalLayer = readLayer("全局 config.json", join(agentConfigDir, "config.json"), fs);
	// Precedence order, and the order every "which file owns this key" search uses.
	const layers: readonly ConfigFileLayer[] = [projectLayer, globalLayer];

	/** The highest-precedence file that actually supplies a key, or undefined. */
	const owner = (key: string): ConfigFileLayer | undefined => layers.find((layer) => !isBlank(layer.values[key]));

	// Merged per key rather than per file, so a machine-wide value stays in force
	// for the projects that do not override it. Only the module-override helper and
	// cosmicHome read this; every plain field goes through pick(), which keeps the
	// origin as well as the value.
	const user: UserConfig = {};
	for (const layer of [...layers].reverse()) {
		for (const [key, value] of Object.entries(layer.values)) if (!isBlank(value)) user[key] = value;
	}

	const sources: Record<string, FieldOrigin> = {};
	const pick = <T>(key: string, autoValue: T | null, fallback?: T): T | null => {
		const envKey = (ENV_KEYS as Record<string, string | undefined>)[key];
		const envValue = envKey ? env[envKey] : undefined;
		if (envKey !== undefined && envValue !== undefined && envValue !== "") {
			sources[key] = { source: "环境变量", via: envKey };
			return envValue as T;
		}
		const from = owner(key);
		if (from !== undefined) {
			sources[key] = { source: from.source, via: from.file };
			return from.values[key] as T;
		}
		if (!isBlank(autoValue)) {
			sources[key] = { source: "自动探测", via: "" };
			return autoValue;
		}
		if (fallback !== undefined) {
			sources[key] = { source: "内置默认", via: "" };
			return fallback;
		}
		sources[key] = MISSING;
		return null;
	};

	// Code modules take their own path: the value is a list, and besides wholesale
	// replacement it supports add/remove on top of detection, which pick() cannot
	// express.
	const mods = applyModuleOverrides(auto.codeModules, user);
	const modulesOwner = owner("codeModules");
	sources.codeModules =
		mods.modules.length === 0
			? MISSING
			: mods.explicit && modulesOwner !== undefined
				? { source: modulesOwner.source, via: modulesOwner.file }
				: { source: "自动探测", via: mods.source };

	const homeOwner = owner("cosmicHome");
	const cosmicHomeResolution = resolveCosmicHome(auto.cosmicHome, user.cosmicHome, homeOwner?.source);
	sources.cosmicHome =
		cosmicHomeResolution.value === null
			? MISSING
			: cosmicHomeResolution.source === "工程 gradle.properties"
				? { source: "自动探测", via: cosmicHomeResolution.source }
				: { source: homeOwner?.source ?? "全局 config.json", via: homeOwner?.file ?? "" };

	const debugPort = Number(pick<string | number>("debugPort", null, 8080));
	// PROBE_SERVER_PORT is not in ENV_KEYS because the frozen CLI checks it ahead
	// of the whole precedence chain rather than inside it; that ordering is kept.
	const probeServerPortEnv = env.PROBE_SERVER_PORT;
	let probeServerPort: number;
	if (probeServerPortEnv !== undefined && probeServerPortEnv !== "") {
		sources.probeServerPort = { source: "环境变量", via: "PROBE_SERVER_PORT" };
		probeServerPort = Number(probeServerPortEnv);
	} else {
		probeServerPort = Number(pick<string | number>("probeServerPort", null, 8099));
	}

	const jrebel = normalizeJrebel(pick<unknown>("jrebel", null));
	const dbLink = normalizeDbLink(pick<unknown>("dbLink", null, "fast"));

	// The project file is checked first: it is the one users are told to write, so
	// a syntax error in it must not hide behind the machine-wide file.
	const broken = layers.find((layer) => layer.parseError !== null);

	return {
		root,
		configFile: globalLayer.file,
		configExists: globalLayer.exists,
		projectConfigFile: projectLayer.file,
		projectConfigExists: projectLayer.exists,
		parseError: broken?.parseError ?? null,
		parseErrorFile: broken?.file ?? null,
		fileLayers: layers,
		isv: pick<string>("isv", auto.isv),
		tenant: pick<string>("tenant", null, "ierp"),
		account: pick<string>("account", null),
		user: pick<string>("user", null),
		debugModule: pick<string>("debugModule", auto.debugModule),
		codeModules: mods.modules,
		appClass: pick<string>("appClass", auto.appClass),
		appMethod: pick<string>("appMethod", auto.appMethod),
		cosmicHome: cosmicHomeResolution.value,
		cosmicHomeResolution,
		knowledgeRoot: pick<string>("knowledgeRoot", null),
		debugPort,
		probeServerPort,
		jrebel,
		dbLink,
		sources,
		auto,
	};
}

/** true / "on" / "auto" → "auto"；false / "off" / "false" / 空 → null；别的字符串原样当路径。 */
function normalizeJrebel(value: unknown): string | null {
	if (value === true) return "auto";
	if (typeof value !== "string") return null;
	const text = value.trim();
	const lower = text.toLowerCase();
	if (lower === "" || lower === "off" || lower === "false" || lower === "0") return null;
	if (lower === "on" || lower === "true" || lower === "auto" || lower === "1") return "auto";
	return text;
}

function normalizeDbLink(value: unknown): DbLink {
	if (value === false) return "platform";
	if (typeof value !== "string") return "fast";
	const lower = value.trim().toLowerCase();
	return lower === "platform" || lower === "off" || lower === "false" || lower === "0" ? "platform" : "fast";
}

/** Fields that must be present before build / probe / fast. See the file header for why some have no default. */
export const REQUIRED: readonly (readonly [keyof KernelConfig, string])[] = [
	["isv", "ISV 标识（元数据写入红线靠它，缺了 IsvGuard 会拒绝一切写入）"],
	["debugModule", "调试启动模块名"],
	["codeModules", "代码模块名 —— 本地 Gradle 子工程（编译、classpath、部到 lib/cus 的那些）"],
	["appClass", "启动类全限定名"],
	["appMethod", "启动类里「只配置不 start」的那个方法名；配置和 start() 都写在 main 里的填 main"],
	["account", "账套编码或账套 id"],
	["user", "用户 id —— 写操作时它就是落库的修改人，没有默认值是故意的"],
];

export function missingRequired(config: KernelConfig): { field: string; why: string }[] {
	return REQUIRED.filter(([key]) => isBlank(config[key])).map(([key, why]) => ({ field: String(key), why }));
}

/**
 * Gate for commands that touch the runtime. Returns null when the config is
 * usable, otherwise a KernelError describing everything that is missing at once.
 * The frozen CLI printed and called process.exit(2) here; a resident agent must
 * hand the caller a value instead (D9).
 */
export function requireRuntime(config: KernelConfig): KernelError | null {
	if (config.parseError !== null) {
		const file = config.parseErrorFile ?? config.configFile;
		return new KernelError("CONFIG_PARSE_FAILED", `config.json 解析失败：${config.parseError}`, {
			detail: { configFile: file },
			remedy: `修好 ${file} 的 JSON 语法后重跑 doctor。`,
		});
	}
	const missing = missingRequired(config);
	if (missing.length === 0) return null;
	return new KernelError(
		"CONFIG_INCOMPLETE",
		`配置不全，缺 ${missing.length} 项：${missing.map((m) => m.field).join("、")}`,
		{
			detail: { configFile: config.projectConfigFile, missing: missing.map((m) => `${m.field}: ${m.why}`) },
			remedy:
				`补在 ${config.projectConfigFile}（工程级，只对这个工程生效，优先于全局 ${config.configFile}），` +
				"然后跑一次 doctor 复查。",
		},
	);
}
