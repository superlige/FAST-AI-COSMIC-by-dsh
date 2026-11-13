/**
 * Write-target syntax (S5.4 / S14.3.1).
 *
 * `normTarget` is the one place that decides what a shared-metadata write target
 * looks like: `cosmic_authorize` normalises what the user confirmed with it, and
 * IsvGuard receives the same spelling through `-Dcosmic.targets`. The DRAFT.md
 * reader that used to live beside it went with the ledger (S14.3.1) -- with no
 * `spec action=target` to maintain that file, there is nothing for a second
 * parser to read.
 */

/** Prefixed objects: print template / BOTP rule / workflow model / test data in a bill (S21). */
const TAG_RE = /^(tpl|botp|wf|data):([a-z0-9_.-]{1,64})$/;
/** Entity / field: `<entity>`, `<entity>.<field>`, `<entity>.<entry>.<field>`. */
const PATH_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,2}$|^[a-z][a-z0-9_]*$/;

export const TARGET_HINT =
	"实体写 <实体标识>，字段写 <实体>.<字段> 或 <实体>.<分录>.<字段>，布局规则写 <实体>.<布局key>，打印模板写 tpl:<编码>，BOTP 规则写 botp:<规则id>，工作流模型写 wf:<模型key>";

/** Normalises one target. Unrecognised input is never silently dropped. */
export function normTarget(raw: unknown): string {
	const text = String(raw ?? "")
		.trim()
		.toLowerCase();
	if (!text) return "";
	const tag = text.match(TAG_RE);
	if (tag) return `${tag[1]}:${tag[2]}`;
	if (PATH_RE.test(text)) return text;
	throw new Error(`看不懂的目标 「${String(raw).trim()}」 —— ${TARGET_HINT}`);
}

/**
 * 写入对象清单的摘要：「25 个：zlgd_sys_bgjl 23 个、zlgd_sys_test_bill 2 个」。
 *
 * 写入对象写成 `单据.元素`（或 `类别:标识`），按点前那一段归到单据；归不出来的按原样算一组。
 */
export function targetsSummary(targets: readonly string[]): string {
	const groups = new Map<string, number>();
	for (const target of targets) {
		const owner = target.includes(".") ? target.slice(0, target.indexOf(".")) : target;
		groups.set(owner, (groups.get(owner) ?? 0) + 1);
	}
	const parts = [...groups.entries()].map(([owner, count]) => (count === 1 ? owner : `${owner} ${String(count)} 个`));
	return `${String(targets.length)} 个：${parts.join("、")}`;
}
