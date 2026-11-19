/**
 * 探针结果的字段清单：这个结构里每个字段发不发模型，在这里登记（S34 批 1）。
 *
 * 改之前发给模型的方式是「删掉几个已知字段，剩下的整体转成文字」：
 * `meta` 只删了嵌套探针的 `output`、`notes`，`src` 等字段原样保留；内核的
 * `ProbeOutcome` 多加一个字段，它就自动进上下文。真机三次会话里光缓存目录的
 * 路径就出现 213 次、26 KB，模型还照着路径去翻它不该翻的缓存文件。
 *
 * 现在反过来：**只有登记过的字段才发**。清单是一张白名单，运行时没登记的
 * 字段一律不发；`unregisteredProbeFields` 供测试遍历一份填满所有字段的样本，
 * 新加字段没登记测试就红——逼着加字段的人当场决定发还是不发。
 *
 * 只动发给模型的那一份。`details.result` 里内核返回什么还是一个字节不少：
 * CLI 渲染、需求足迹、验证核对都从那一份读。
 */

/** 哨兵：这个字段这次不发。 */
export const DROP = Symbol("probe-manifest.drop");

/** `src` 的条件要用到：这次跑的是不是临时探针。 */
export interface PruneContext {
	/** 临时探针的源码是模型自己要改的文件，路径照旧给；内置探针只留探针名。 */
	adHoc: boolean;
}

type Rule = "send" | typeof DROP | ((value: unknown, ctx: PruneContext) => unknown);

/**
 * `ProbeOutcome` 逐字段的登记表；`RunReport` 继承它，多出的四个字段也在这里。
 *
 * 每条登记都写明是哪条决定：
 *  - 1.1 内置探针的 `src` 是缓存目录里的位置，发它等于给模型指路去翻探针源码
 *    （真机 26 KB 路径后面跟着 89 KB 的翻文件）；临时探针的 `src` 是它要改的文件。
 *  - 1.2 「省略的内容怎么取」每次返回只说一处：文字通道在 `outputBudget.remedy`
 *    （S37 2-A.2 起是用 raw 按条件取回，不给路径），记录通道在 `recordBudget.remedy`
 *    （S42 §16.8 起同样用 raw 取回，不给路径）。`json.file` 是 `last-probe.json`，
 *    每次运行都被下一次盖掉，发路径只会让模型去读一份即将过期的文件——不发。
 *    正常时的 `stale`（门禁没拦任何东西）和 `apiPrecheck`（核对全过）不发，
 *    出问题时才发。
 */
export const PROBE_OUTCOME_FIELDS: Record<string, Rule> = {
	probe: "send",
	src: (value, ctx) => (ctx.adHoc ? value : DROP),
	path: "send",
	coldReason: (value) => (value === null ? DROP : value),
	exitCode: "send",
	output: "send",
	// 结构化通道：records 有自己的预算（record-budget.ts），broken 是探针自己的坏行，照发。
	json: "send",
	// 位置信息已并入两处 remedy，字段本身不再单独发。
	outputFile: DROP,
	outputLines: (value) => {
		const lines = value as { total: number; shown: number };
		return lines.total === lines.shown ? DROP : value;
	},
	stale: (value) => {
		const verdict = value as { action?: string } | null;
		return verdict !== null && typeof verdict === "object" && verdict.action !== "none" ? value : DROP;
	},
	apiPrecheck: (value) => {
		const audit = value as { wildcards?: string[]; reflection?: string } | null;
		if (audit === null || typeof audit !== "object") return DROP;
		return (audit.wildcards?.length ?? 0) > 0 || audit.reflection === "unavailable" ? value : DROP;
	},
	// 用法卡片「第一次调这个探针才附」由 extension 的 probesExplained 账管，这里照发。
	usage: "send",
	notes: "send",
	// RunReport 在 ProbeOutcome 之上加的四个字段。
	kind: "send",
	target: "send",
	scenarios: "send",
	evidence: "send",
	// agent 边界加的两个预算块（S20）也在顶层；`outputBudget`、`recordBudget` 的
	// 内部字段按嵌套清单走（位置字段不发）。
	outputBudget: "send",
	recordBudget: "send",
};

/**
 * 验证记录发给模型的那一份：编号、结论，分场景跑的再带场景名和那个场景的命令。
 *
 * 落盘的记录是给交付核对用的整份（指纹、命令行、断言、提醒、日志位置）。整份照发时，同一条返回里
 * 断言在 `json.records` 有一份、提醒在 `notes` 有一份、命令行是模型自己刚写的；2026-10 的 223 次运行
 * 里这一块占返回的 28%（374 KB / 1.34 MB）。模型拿它做的事只有两样：知道留没留下记录、哪条没过，
 * 和在报告里引用编号——编号对得上 `.cosmic-ai/evidence/assertions/` 里那份完整的。日志位置不发，
 * 理由同 `writeLog`：同一调用加 raw 取得回。
 */
function filedForModel(value: unknown): unknown {
	if (!Array.isArray(value)) return value;
	return value.map((entry: unknown) => {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return entry;
		const record = entry as Record<string, unknown>;
		const scenario = record.scenario;
		return {
			id: record.id,
			result: record.result,
			// 分场景跑的（--case）每条记录各有一条能单独重跑的命令，红的那条要照它原样重跑才换得掉；
			// 不分场景时那条命令就是模型刚写的这一条。
			...(scenario === null || scenario === undefined ? {} : { scenario, scenarioKey: record.scenarioKey }),
		};
	});
}

/** 嵌套结构也逐字段登记；`records` 数组里的条目是这次运行的结论，整组照发。 */
export const PROBE_NESTED_FIELDS: Record<string, Record<string, Rule>> = {
	json: { records: "send", broken: "send", file: DROP },
	outputLines: { total: "send", shown: "send" },
	stale: { files: "send", lane: "send", mode: "send", action: "send" },
	usage: { summary: "send", inputs: "send", required: "send" },
	apiPrecheck: { classes: "send", wildcards: "send", reflection: "send", queries: "send" },
	// `evidence.notes` 的每一句都已经并在顶层 `notes` 里，这里再发就是同一条返回里说两遍。
	evidence: { filed: filedForModel, notes: DROP },
	// agent 边界加的两个预算块（S20）：位置字段并入 remedy（见上），其余照发。
	outputBudget: {
		truncated: "send",
		totalBytes: "send",
		totalLines: "send",
		omittedLines: "send",
		omittedFrom: "send",
		omittedTo: "send",
		outputFile: DROP,
		spillError: "send",
		remedy: "send",
	},
	recordBudget: {
		total: "send",
		shown: "send",
		indexOnly: "send",
		folded: "send",
		omitted: "send",
		file: DROP,
		remedy: "send",
	},
};

/**
 * extension 在探针结果旁边加的兄弟字段（知识卡片、交付说明、写通道存档位置）。
 *
 * 写通道存档位置不发（S42 §16.13）：同一份输出用 raw 按行号、关键字就取得回，给了路径模型就离开
 * 工具去 grep 落盘文件——真机一次试算被预算省掉 27 行，模型 4 次 bash、1 次 read 翻这份存档。
 * 路径还在 `details` 里，审计和需求追踪照用。
 */
const AGENT_SIBLING_FIELDS: Record<string, Rule> = {
	knowledgeContext: "send",
	delivery: "send",
	writeLog: DROP,
	formulaRepeat: "send",
};

function applyRule(rule: Rule, value: unknown, ctx: PruneContext): unknown {
	if (rule === "send") return value;
	if (rule === DROP) return DROP;
	return rule(value, ctx);
}

/**
 * 清点样本里没登记的字段。测试用它逼着每个新字段做决定：返回非空就是红。
 *
 * 只查两层：ProbeOutcome 本身，加清单登记过的嵌套结构。`json.records`、
 * `evidence.filed` 这类结论数组的条目形状由探针自己定义，不归这张清单管。
 */
export function unregisteredProbeFields(sample: unknown): string[] {
	if (typeof sample !== "object" || sample === null || Array.isArray(sample)) return [];
	const top = { ...PROBE_OUTCOME_FIELDS, ...AGENT_SIBLING_FIELDS };
	const missing: string[] = [];
	for (const [key, value] of Object.entries(sample as Record<string, unknown>)) {
		if (!(key in top)) {
			missing.push(key);
			continue;
		}
		const nested = PROBE_NESTED_FIELDS[key];
		if (nested === undefined || typeof value !== "object" || value === null || Array.isArray(value)) continue;
		for (const child of Object.keys(value as Record<string, unknown>)) {
			if (!(child in nested)) missing.push(`${key}.${child}`);
		}
	}
	return missing;
}

/**
 * 模型该看到的那份探针结果。
 *
 * 返回原对象（没有任何字段被摘时）或一份浅拷贝。
 */
export function pruneProbeOutcome<T extends object>(outcome: T, ctx: PruneContext): T {
	const record = outcome as Record<string, unknown>;
	const next: Record<string, unknown> = {};
	const fields = { ...PROBE_OUTCOME_FIELDS, ...AGENT_SIBLING_FIELDS };
	for (const [key, value] of Object.entries(record)) {
		const rule = fields[key];
		if (rule === undefined) continue; // 白名单：没登记的不发（unregisteredProbeFields 让测试红）。
		if (applyRule(rule, value, ctx) === DROP) continue;
		const nested = PROBE_NESTED_FIELDS[key];
		next[key] =
			nested !== undefined && typeof value === "object" && value !== null && !Array.isArray(value)
				? pruneNested(value as Record<string, unknown>, nested, ctx)
				: value;
	}
	return next as T;
}

function pruneNested(
	value: Record<string, unknown>,
	nested: Record<string, Rule>,
	ctx: PruneContext,
): Record<string, unknown> {
	const next: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value)) {
		const rule = nested[key];
		if (rule === undefined) continue;
		const applied = applyRule(rule, child, ctx);
		if (applied === DROP) continue;
		next[key] = applied;
	}
	return next;
}

/**
 * `cosmic_meta` 的那份：嵌套探针照清单清，外加 1.4 的那处重复——
 * `meta diff` 的差异同时躺在顶层 `text`、`diff.text`、`diff.files[].lines` 三处，
 * 留顶层 `text` 一份（它会被挪进文本块），其余两处变成计数。
 */
export function pruneMetaReport<T extends object>(report: T, ctx: PruneContext): T {
	const record = report as Record<string, unknown>;
	const next: Record<string, unknown> = { ...record };
	if (typeof record.probe === "object" && record.probe !== null && !Array.isArray(record.probe))
		next.probe = pruneProbeOutcome(record.probe as object, ctx);
	delete next.writeLog; // 同 AGENT_SIBLING_FIELDS：raw 取得回，路径不发
	const diff = record.diff;
	if (typeof diff === "object" && diff !== null && !Array.isArray(diff)) {
		const source = diff as Record<string, unknown>;
		const { text: _twin, ...rest } = source;
		const files = Array.isArray(rest.files)
			? (rest.files as Record<string, unknown>[]).map((file) => {
					const { lines: _lines, ...summary } = file;
					return summary;
				})
			: rest.files;
		next.diff = { ...rest, files };
	}
	return next as T;
}
