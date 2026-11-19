/**
 * 固定提醒的条目账：同一条提醒，一次会话里第一次完整说，之后只留编号（S34 批 1.7）。
 *
 * 真机 16 次会话量出来，cosmic 返回里「固定的提醒每次都念」约 100 KB：
 * 「验证记录：这次留下 N 条……finish 只认……」单次会话出现 8 次，「没带 --expect
 * 不算验证」6 次，还有 dry-run 说明、噪声说明、候选文件说明——每次调用都原样跟着走。
 * 念多了模型就不当回事了。
 *
 * 规矩：每条提醒有自己的编号；第一次出现时全文照发；再出现时只保留**这次运行
 * 自己的那部分**（几条记录、哪个文件），解释性的尾巴折成「（提醒 N，同上）」。
 * 「这次没验到」「证据过期」这类结果本身永远不折——折掉的只是解释。
 *
 * 匹配按文本模式，不按调用点：同一条提醒可能从几个工具嘴里说出来，账认的是
 * 模型看没看过，不认是谁说的。只活在内存里，和读取账同一个规矩——上下文被
 * 压缩、切分支时整本清空，那时提醒也确实不在上文里了，重说一遍是对的。
 */

export interface ReminderRule {
	/** 提醒编号，返回给模型看的那个 N。按登记顺序从 1 起。 */
	id: number;
	/** 认出这条提醒的模式。 */
	match: RegExp;
	/**
	 * 再出现时保留的头部：这次运行自己的事实。
	 * 返回空串表示整条都是解释，折成一句「（提醒 N，同上）」。
	 */
	head: (note: string) => string;
}

/** 取到 `stop` 第一次出现为止（含），找不到就取全文。 */
function upTo(stop: string): (note: string) => string {
	return (note) => {
		const at = note.indexOf(stop);
		return at < 0 ? note : note.slice(0, at + stop.length);
	};
}

/** 1.7 的一个例子：交付本来就会核对断言记录，这句解释念一遍就够。 */
const NO_EXPECT = "这次没有业务断言（没带 --expect），不算验证";

const RAW_RULES: Omit<ReminderRule, "id">[] = [
	{
		match: new RegExp(NO_EXPECT),
		head: (note) => `${upTo("不算验证")(note).trimEnd()}——`,
	},
	{
		// run.ts 的证据小结：条数和断言数是这次运行的事实，尾句是解释。
		match: /^验证记录：这次留下 \d+ 条/,
		head: upTo("）。"),
	},
	{
		// 临时探针的断言不算验过。
		match: /^这些断言是临时探针自己判的，不算验过/,
		head: upTo("不算验过"),
	},
	{
		// 内核那句「完整输出 N 行 → 文件」：行数和文件是这次的，取回建议是解释。
		match: /^完整输出 \d+ 行（这里只给了 \d+ 行）→ /,
		head: (note) => {
			const at = note.indexOf("；");
			return at < 0 ? note : note.slice(0, at);
		},
	},
	{
		// 噪声账的解释行，整行都是说明。
		match: /^「见过很多次」只说明它是这个环境的背景噪声/,
		head: () => "",
	},
	{
		// meta dry-run 的说明：这件事本身（dry-run 未落库）在结果字段里也有。
		match: /^dry-run：只演算不落库/,
		head: upTo("不落库。"),
	},
	{
		match: /^本地改候选文件，不落库/,
		head: upTo("不落库："),
	},
	{
		match: /^设计 JSON 按控件 id 对齐比较/,
		head: upTo("不是文本 diff"),
	},
	{
		// 正在拉起是这次的事件；要多久、为什么是解释。
		match: /^常驻 JVM 没在跑，正在拉起/,
		head: upTo("："),
	},
];

/** 登记表。编号在第一次导出时定死，中途插入会把编号挪位——所以集中在这一张表里加。 */
export const REMINDER_RULES: ReminderRule[] = RAW_RULES.map((rule, index) => ({ id: index + 1, ...rule }));

export interface ReminderLedger {
	/** 这次会话里已经完整说过的提醒编号。 */
	said: Set<number>;
}

export function createReminderLedger(): ReminderLedger {
	return { said: new Set() };
}

export function forgetAllReminders(ledger: ReminderLedger): void {
	ledger.said.clear();
}

/** 再出现时的那一句话。 */
function brief(rule: ReminderRule, head: string): string {
	return head === "" ? `（提醒 ${String(rule.id)}，同上）` : `${head}（提醒 ${String(rule.id)}，同上）`;
}

/**
 * 一条 note 过一遍提醒账：没见过就全文照发并记账；见过就折成头部加编号。
 * 不是登记过的提醒就原样返回——只有登记过的才有资格折。
 */
export function foldReminder(ledger: ReminderLedger, note: string): string {
	const rule = REMINDER_RULES.find((candidate) => candidate.match.test(note));
	if (rule === undefined) return note;
	if (!ledger.said.has(rule.id)) {
		ledger.said.add(rule.id);
		return note;
	}
	return brief(rule, rule.head(note).trimEnd());
}

/** 一段文字过一遍提醒账（按行），返回折完的文字和折掉的行数。 */
export function foldReminders(ledger: ReminderLedger, text: string): { text: string; folded: number } {
	if (!text.includes("\n")) {
		const folded = foldReminder(ledger, text);
		return { text: folded, folded: folded === text ? 0 : 1 };
	}
	const lines = text.split("\n");
	let count = 0;
	const next = lines.map((line) => {
		const folded = foldReminder(ledger, line);
		if (folded !== line) count += 1;
		return folded;
	});
	return { text: next.join("\n"), folded: count };
}

/**
 * 一个结果对象里每一处 `notes` 数组过一遍提醒账（S34 1.7）。
 *
 * extension 在渲染链里对整个结果跑它；回放测试（1.8）对夹具里的 envelope
 * 跑同一个函数——回放过的必须是发模型时真正用的那套规则。
 */
export function foldNotesInValue(value: unknown, ledger: ReminderLedger, depth = 3): unknown {
	if (depth === 0 || typeof value !== "object" || value === null || Array.isArray(value)) return value;
	const record = value as Record<string, unknown>;
	const next: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(record)) {
		if (key === "notes" && Array.isArray(item) && item.every((note) => typeof note === "string")) {
			next[key] = (item as string[]).map((note) => foldReminder(ledger, note));
			continue;
		}
		next[key] =
			typeof item === "object" && item !== null && !Array.isArray(item)
				? foldNotesInValue(item, ledger, depth - 1)
				: item;
	}
	return next;
}

/**
 * 一份工具结果里登记过的提醒文字一共多少字节。
 *
 * 1.8 的那条线量的是它：往提醒里加话之前先看这个数，超线就得在同一处删掉
 * 等量的旧话。只数登记过的（有资格被折的那部分），不把业务结果算进去。
 */
export function reminderBytes(notes: readonly string[]): number {
	const encoder = new TextEncoder();
	let total = 0;
	for (const note of notes) {
		if (REMINDER_RULES.some((rule) => rule.match.test(note))) total += encoder.encode(note).length;
	}
	return total;
}
