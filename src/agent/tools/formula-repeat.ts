/**
 * 同一处公式同一种错第二次出现时，把两次的真实输入和平台判据并排（S36 3.3）。
 *
 * 每一次失败本身已经说清错在哪（探针的 `t=formula-error`：卡在哪个记号、哪个函数或字段不存在、相近名字），
 * 缺的是跨调用的一层：第二次还错时，改动碰没碰到上次的错处。模型自己比两段长表达式容易看漏，
 * 真机会话里就有过改了别处、错处原样留着又跑一轮的情形。这里只比两次的事实，不猜修法、
 * 不按「同类错误」附一段通用例子——判断不了的就照实说判断不了。
 *
 * 键是「领域 + 写在哪 + 哪种错」：同一条规则的条件、同一个打印格子才算同一处。
 * 账只在内存里，进程重启就没了；说的都是两次的原文，不依赖上文还在不在。
 */

export interface FormulaError {
	domain: string;
	where: string;
	kind: string;
	input: string;
	/** 卡住的记号、不存在的函数或字段名；到结尾还没写完时是 null。 */
	token: string | null;
	/** 位置（「第 13 个字符」）、括号数或平台原话。 */
	detail: string | null;
}

interface Seen extends FormulaError {
	count: number;
}

export type FormulaErrorLedger = Map<string, Seen>;

export function createFormulaErrorLedger(): FormulaErrorLedger {
	return new Map();
}

const KIND_LABEL: Record<string, string> = {
	parse: "平台解析不过",
	function: "函数不存在",
	"function-case": "函数名大小写和登记名不一致",
	field: "字段不在单据上",
	"print-validate": "打印校验器报错",
};

const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/** 探针结果里的 `t=formula-error` 记录；`cosmic_meta` 的在 `probe.json.records` 下。 */
export function formulaErrorsOf(result: unknown): FormulaError[] {
	const out: FormulaError[] = [];
	for (const record of recordsOf(result)) {
		if (record.t !== "formula-error") continue;
		const domain = text(record.domain);
		const where = text(record.where);
		const kind = text(record.kind);
		const input = typeof record.input === "string" ? record.input : null;
		if (domain === null || where === null || kind === null || input === null) continue;
		out.push({ domain, where, kind, input, token: text(record.token), detail: text(record.detail) });
	}
	return out;
}

function recordsOf(result: unknown): Record<string, unknown>[] {
	if (typeof result !== "object" || result === null) return [];
	const carrier = result as Record<string, unknown>;
	const json = carrier.json as { records?: unknown } | undefined;
	if (Array.isArray(json?.records)) return json.records as Record<string, unknown>[];
	return carrier.probe === undefined ? [] : recordsOf(carrier.probe);
}

/**
 * 记下这一次的错，返回和上一次同一处同一种错的对比（第一次出现返回空）。
 * 同一次调用里同一处报了几条同种错（例如两个不存在的字段），各比各的。
 */
export function compareFormulaErrors(ledger: FormulaErrorLedger, errors: readonly FormulaError[]): string[] {
	// 先照上一次的账比完再记：同一次调用里报的两条，不能拿前一条当后一条的「上次」。
	const previous = new Map(ledger);
	const notes: string[] = [];
	const reported = new Set(errors.map(keyOf));
	for (const now of errors) {
		const key = keyOf(now);
		const exact = previous.get(key);
		// 换了名字的只和这次已经不报的旧名字配对；旧名字还在报，就由它自己那条去比。
		const renamed = exact === undefined ? sameSpotAnyToken(previous, now, reported) : undefined;
		const before = exact ?? renamed;
		const count = (before?.count ?? 0) + 1;
		ledger.set(key, { ...now, count });
		if (before !== undefined) notes.push(describe(before, now, count));
	}
	return notes;
}

function keyOf(error: FormulaError): string {
	return JSON.stringify([error.domain, error.where, error.kind, error.kind === "parse" ? "" : (error.token ?? "")]);
}

/**
 * 函数、字段错按名字各记一条；名字换了（上次 CONCATX、这次 CONCAT_X）也还是同一处的同一种错，
 * 找同一处同种错里最近记下的那条来比。
 */
function sameSpotAnyToken(ledger: FormulaErrorLedger, now: FormulaError, reported: Set<string>): Seen | undefined {
	let found: Seen | undefined;
	for (const seen of ledger.values())
		if (
			seen.domain === now.domain &&
			seen.where === now.where &&
			seen.kind === now.kind &&
			!reported.has(keyOf(seen))
		)
			found = seen;
	return found;
}

function describe(before: Seen, now: FormulaError, count: number): string {
	const label = KIND_LABEL[now.kind] ?? now.kind;
	const head = `「${now.where}」第 ${String(count)} 次${label}`;
	if (before.input === now.input) return `${head}，输入和上次一字不差：${now.input}`;
	const both = `上次：${before.input}；这次：${now.input}`;
	if (now.kind === "parse") {
		if (before.token === null && now.token === null)
			return `${head}，两次都是到结尾还没写完（上次${before.detail ?? ""}，这次${now.detail ?? ""}）。${both}`;
		if (before.token === now.token && before.detail === now.detail)
			return `${head}，还是在${now.detail ?? "同一位置"}的「${now.token ?? ""}」上卡住，这一处两次都没改。${both}`;
		return `${head}，错处挪了：上次在${place(before)}，这次在${place(now)}（平台只报第一处）。${both}`;
	}
	if (before.token === now.token && now.token !== null)
		return `${head}，还是「${now.token}」，这个名字两次都在。${both}`;
	return `${head}：上次是「${before.token ?? "?"}」（这次已不再报），这次是「${now.token ?? "?"}」。${both}`;
}

function place(error: FormulaError): string {
	return error.token === null ? `结尾（${error.detail ?? ""}）` : `${error.detail ?? "位置未知"}的「${error.token}」`;
}
