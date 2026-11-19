/**
 * 探针结构化记录的上下文预算（S20 批 1）。
 *
 * `budgetOutput` 治的是文字通道：探针打在屏幕上的那些 `[PROBE]` 行超长就切两头、
 * 全文落盘。同一次返回里还有第二条通道——`[PROBE-JSON]` 的结构化记录——它一直是
 * **原样发走的**，而真正撑爆上下文的就是它。
 *
 * 一次真机会话量出来的账：最贵的那次 `run rule` 返回 239,002 字节，其中
 * `json.records`（1,359 条）占 203,442，同一次返回的文字通道被预算从 37,502 切到
 * 3,650 并落了盘。**预算付了，上下文没省下来。** 那 1,359 条里有 1,352 条是
 * 「这个控件在布局里本来就是隐藏的」，调用方点名问的只有 5 个字段。
 *
 * 三条规矩，和 `output-budget.ts` 同一条分界线（都在 agent 边界切，内核和 CLI
 * 拿到的一个字节不少——它们没有上下文窗口）：
 *
 *   1. **索引类记录不进模型上下文。** 建代码关系表用的原料（字段清单、插件挂载、
 *      打印模板、用户、环境画像）是给 TypeScript 侧读的，没有人会一条一条看它们。
 *   2. **同形折叠。** 除掉字段标识之后形状相同的记录说的是同一句话，折成一条带
 *      计数的摘要：330 条「布局里本来就隐藏」变成一条「另有 330 个字段……」。
 *   3. **点名问的一定给全。** `rule-show` 是调用方明确点过名的，永远不折叠——
 *      折掉它等于把人家问的那个问题的答案删了。
 *
 * 剩下的仍超预算就交代省了多少条、怎么取：和文字通道一样用 raw 从这次的输出里取（S42 §16.8），
 * 不给落盘路径。
 */

import type { ProbeJsonRecord } from "../../kernel/probe/output.ts";

/**
 * 折叠之后还留给记录的位置。
 *
 * 和文字通道的 4,000 同一量级：两条通道各自 4 KB，一次返回的主体就压在 10 KB
 * 以内，而验收线是单次返回 15 KB。
 */
export const DEFAULT_RECORD_BUDGET = 4000;

/** 同形的记录到几条才值得折。两条折成一条摘要省不下什么，三条开始才划算。 */
export const FOLD_THRESHOLD = 3;

/** 这些键的值是「某个字段/控件/类的标识」，判断同形时要摘掉。 */
const IDENTIFIER_KEYS = new Set(["field", "key", "path", "id", "name", "class"]);

/**
 * 建索引和环境画像用的记录种类：TypeScript 侧读它们建表，模型不读。
 *
 * 判断依据是 `src/` 下的实际引用（`impact.ts` 读 field/fieldowners/binding/
 * template/name，`profile-environment.ts` 读 profile-env，`user-lookup.ts` 读
 * user/user-lookup），以及它们的形状——一条 `{"t":"field","entity":…,"key":…}`
 * 是建表原料，不是给人看的结论。
 *
 * 带判定含义的记录（`assert`、`scenario`、`mustinput`）**不在这里**：内核确实
 * 也读它们，但它们同时是这次运行的结论，条数又少（一次会话统共几千字节），
 * 摘掉省不下什么，却会让模型看不见「哪条断言挂了」。
 */
export const INDEX_RECORD_TYPES: ReadonlySet<string> = new Set([
	"field",
	"fieldowners",
	"binding",
	"binding-summary",
	"template",
	"name",
	"profile-env",
	"user",
	"user-lookup",
]);

/**
 * 只给本会话事实（`cosmic_facts`）记账的记录种类：run 之后库里那张单是不是这次新建的（`committed`）、
 * 这次真执行的操作和表单上挂着哪些本工程插件（`own-plugins`）。
 * 记账在工具里做完，模型从事实里读到结论；这里悄悄摘掉，也不算进「摘掉了几条索引记录」那段说明——
 * 每次运行都有，算进去每次返回都要多一段话。人读的那一行（「数据库现状」）照旧在文字通道里。
 */
export const FACTS_RECORD_TYPES: ReadonlySet<string> = new Set(["committed", "own-plugins"]);

/** 调用方点名问过的记录种类，永不折叠。 */
export const NEVER_FOLDED: ReadonlySet<string> = new Set(["rule-show"]);

/**
 * 这次运行的结论，永不折叠也永不切，并排在最前面。
 *
 * 「超预算从尾巴切」原本假设尾巴上都是覆盖面小的摘要，但探针是**最后**才发断言和场景的：
 * 2026-09-15 真机回放 `run rule`，60 条规则碰过的字段各有各的归因、折不起来，
 * 预算装到第 29 条就满了，断言挂没挂模型根本看不到。它们条数少、每条一两百字符，
 * 永远给全花不了几个钱。`rule-state-rest` 是 RuleSim 把没人问的字段汇总成的那一条，
 * 切掉它就等于没说「另外还有 1,291 个字段」。`next-step` 是 run form 抓到弹窗时拼好的
 * run flow 命令（S20 批 5），一次运行至多几条，切掉它模型就又要去翻仿真探针的源码。
 * `run-incomplete` 说这次有一步没跑完（插件抛错、后面的插件没收到），断言全过也不算验证；
 * 它只在原始输出里的话，模型看到的是一排 PASS（2026-10-10 真机）。
 */
export const NEVER_CUT: ReadonlySet<string> = new Set([
	"rule-show",
	"assert",
	"assert-none",
	"input-invalid",
	"run-incomplete",
	"scenario",
	"rule-state-rest",
	"next-step",
	"ptpl-control",
	"formula-summary",
	"formula-item",
	"formula-miss",
	"formula-error",
]);

/** 一条折叠摘要里举几个字段名。 */
const SAMPLES_KEPT = 3;

export interface RecordBudgetSummary {
	/** 探针一共发了多少条。 */
	total: number;
	/** 模型这次看到多少条（含折叠摘要）。 */
	shown: number;
	/** 索引类记录，已从模型侧摘掉；内核拿到的那份一条不少。 */
	indexOnly: number;
	/** 被折进摘要里的原始记录条数。 */
	folded: number;
	/** 折完仍超预算、这次没发的条数。 */
	omitted: number;
	/** 全量记录的落盘位置。 */
	file: string | null;
	remedy: string;
}

export interface BudgetedRecords {
	records: ProbeJsonRecord[];
	/** 什么都没动时为 null——没被切过的返回不该多出一段解释。 */
	summary: RecordBudgetSummary | null;
}

const encoder = new TextEncoder();
// 按 UTF-8 字节算，不按字符算（S34 批 1）：预算上限说的是字节，中文一条记录一个
// 字符占三个字节，按字符量会让中文记录实际占用的空间三倍于账面。
const size = (value: unknown): number => encoder.encode(JSON.stringify(value ?? null)).length;

/** 除掉标识之后这条记录还剩什么形状。形状相同 = 对读的人说的是同一句话。 */
function shapeOf(record: ProbeJsonRecord): string {
	return JSON.stringify(Object.fromEntries(Object.entries(record).filter(([key]) => !IDENTIFIER_KEYS.has(key))));
}

/** 这条记录是在说哪个字段/控件。找不到就空着，折叠摘要里少举一个例子而已。 */
function identifierOf(record: ProbeJsonRecord): string {
	for (const key of IDENTIFIER_KEYS) {
		const value = record[key];
		if (typeof value === "string" && value !== "") return value;
	}
	return "";
}

/**
 * 把同形的一组折成一条。
 *
 * `n` 是「这条说的是 n 个字段」，`fields` 举三个例子——完整名单在落盘文件里，
 * 而列全 330 个字段名本身就要两万字符，那就白折了。
 */
function foldGroup(group: readonly ProbeJsonRecord[]): ProbeJsonRecord {
	const first = group[0] as ProbeJsonRecord;
	const names = group.map(identifierOf).filter((name) => name !== "");
	const samples = names.slice(0, SAMPLES_KEPT);
	const rest = names.length - samples.length;
	const shape = Object.fromEntries(Object.entries(first).filter(([key]) => !IDENTIFIER_KEYS.has(key)));
	return {
		...shape,
		n: group.length,
		...(samples.length === 0 ? {} : { fields: rest > 0 ? [...samples, `…另 ${String(rest)} 个`] : samples }),
	};
}

/**
 * 省掉的记录怎么取（S42 §16.8 第 2 条）。
 *
 * 以前说「全部 N 条在 <落盘文件>，窄条件 grep 它」。同一份返回里文字通道说的是「加 raw 取回」、
 * 行号按纯文字算；落盘文件里文字和 JSON 记录交错，行号是另一套。真机上模型拿文字的行号去切文件，
 * 切错两次，一次会话 7 次 bash 翻这个文件。现在记录也跟着文字存进 raw 能取的那份（排在文字后面，
 * 文字的行号不变），两条通道只剩一种取法，不再给路径。
 */
function remedyFor(summary: Omit<RecordBudgetSummary, "remedy">): string {
	const folded =
		summary.folded === 0 ? "" : `带 n 的那几条是折叠摘要（n 表示同样的话对 n 个字段都成立，fields 只举了几个例子）；`;
	return `${folded}全部 ${summary.total} 条：同一调用加 raw="关键字" 取回，不重跑。`;
}

/**
 * 模型该看到的那份记录。
 *
 * 纯函数，不落盘也不碰内核结果：调用方传进来什么就还它一份新的数组，原数组不动。
 */
export function budgetRecords(
	records: readonly ProbeJsonRecord[],
	options: { limit?: number; file?: string | null } = {},
): BudgetedRecords {
	const limit = options.limit ?? DEFAULT_RECORD_BUDGET;
	const file = options.file ?? null;
	if (records.length === 0) return { records: [], summary: null };

	const pinned: ProbeJsonRecord[] = [];
	const kept: ProbeJsonRecord[] = [];
	const foldable = new Map<string, ProbeJsonRecord[]>();
	let indexOnly = 0;
	let total = 0;
	for (const record of records) {
		const type = typeof record.t === "string" ? record.t : "";
		if (FACTS_RECORD_TYPES.has(type)) continue;
		total++;
		if (INDEX_RECORD_TYPES.has(type)) {
			indexOnly++;
			continue;
		}
		if (NEVER_CUT.has(type)) {
			pinned.push(record);
			continue;
		}
		if (NEVER_FOLDED.has(type)) {
			kept.push(record);
			continue;
		}
		const shape = shapeOf(record);
		const group = foldable.get(shape);
		if (group) group.push(record);
		else foldable.set(shape, [record]);
	}

	// 够不上折叠门槛的，原样留着并回到它原来的位置附近——一条孤零零的记录折成摘要
	// 反而更长，而且它多半就是那条有意思的。
	const folds: ProbeJsonRecord[] = [];
	let foldedCount = 0;
	for (const group of foldable.values()) {
		if (group.length < FOLD_THRESHOLD) {
			kept.push(...group);
			continue;
		}
		folds.push(foldGroup(group));
		foldedCount += group.length;
	}
	folds.sort((a, b) => Number(b.n ?? 0) - Number(a.n ?? 0));

	// 结论（点名、断言、场景）排最前且永远给全；没折的跟在后面，折叠摘要按覆盖面从大到小
	// 垫底。超预算从尾巴切，切掉的是「覆盖面最小的那几条摘要」或字段明细，不是结论。
	const shown: ProbeJsonRecord[] = [...pinned];
	let bytes = pinned.reduce((sum, record) => sum + size(record) + 1, 0);
	let omitted = 0;
	// 只有真正的折叠摘要才按 n 计：探针自己发的记录也可能带一个叫 n 的字段。
	const foldSet = new Set(folds);
	for (const record of [...kept, ...folds]) {
		const cost = size(record) + 1;
		if (bytes + cost > limit && shown.length > 0) {
			omitted += foldSet.has(record) ? Number(record.n ?? 1) : 1;
			continue;
		}
		shown.push(record);
		bytes += cost;
	}

	if (indexOnly === 0 && foldedCount === 0 && omitted === 0) return { records: shown, summary: null };
	const summary: Omit<RecordBudgetSummary, "remedy"> = {
		total,
		shown: shown.length,
		indexOnly,
		folded: foldedCount,
		omitted,
		file,
	};
	return { records: shown, summary: { ...summary, remedy: remedyFor(summary) } };
}
