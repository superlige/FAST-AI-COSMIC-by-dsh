/**
 * The knowledge-retrieval eval batch (S7.5).
 *
 * The nine `history` cases are the frozen implementation's set, verbatim, down to
 * the wording. They are the reason the whole L2 design is shaped the way it is:
 * on them, literal `search` scored recall@3 = 3/10 while reading the filtered
 * scene table scored 9/9, and every later decision -- "questions go to the table,
 * symbols go to search" -- rests on that gap. Keeping the questions unchanged is
 * what makes "did anything regress" a question with an answer.
 *
 * The four new groups exist because the historical set only covers the case the
 * design is already good at: a tagged family, a question with a real answer.
 *
 *   gap-family     The six families the official scene index never tagged. No
 *                  facet can narrow the table for them, and two of the six have
 *                  no scene document at all -- their only answer is the guide.
 *                  This group is the fallback rate.
 *   business       New business-voiced questions with real scene answers, chosen
 *                  so the wording shares as little as possible with the index
 *                  keywords. A second batch, not a bigger first one: nine cases
 *                  that have been in the repository since the frozen skill are
 *                  nine cases the implementation could have been fitted to.
 *   low-confidence Questions this snapshot genuinely cannot answer. What is being
 *                  measured is not recall -- it is whether a miss arrives looking
 *                  like a miss, with a next step, rather than as a confident row.
 *   version-drift  The snapshot documents framework 8.0.1 and the user's JARs are
 *                  whatever they are. Every answer has to say which version it is
 *                  speaking for, and a document that was never checked against the
 *                  JAR must not be presented as if it had been.
 *
 * Targets are paths relative to `SCENE_PREFIX`, exactly as the scenes report
 * prints them. A target that stops existing fails the corpus test rather than
 * quietly scoring zero: an eval whose answers have drifted measures nothing.
 */

export type EvalKind = "history" | "gap-family" | "business" | "low-confidence" | "version-drift";

export interface EvalCase {
	id: string;
	kind: EvalKind;
	/** The question, as a user would type it. For version-drift cases, a class name. */
	query: string;
	/** Scene document that answers it, or null when the scene table has none. */
	scene: string | null;
	/** Guide that answers it. Set when no scene does; that pair is the fallback. */
	guide: string | null;
	/** The facet a caller would narrow by, or null for a family the index never tagged. */
	pluginType: string | null;
	/** version-drift only: the class whose answer must declare the version it speaks for. */
	fqcn?: string;
	/** Why this case is in the batch. One clause, so a failure is readable. */
	why: string;
}

const historical = (query: string, scene: string, why: string): EvalCase => ({
	id: scene.replace(/\.md$/, "").replace(/\//g, "-"),
	kind: "history",
	query,
	scene,
	guide: null,
	pluginType: "billform",
	why,
});

/**
 * The frozen batch. Business wording, deliberately avoiding index keywords.
 *
 * Comment from the frozen test, kept because it is the measurement's premise:
 * "这十条按业务口吻提问，刻意不使用索引里的关键词" -- and the list has nine
 * entries, which is why the score is stated as 9/9 and not 10/10.
 */
const HISTORY: readonly EvalCase[] = [
	historical("单据保存时金额为负不让保存", "event/before-do-operation-validate.md", "保存前校验，最常见的一类"),
	historical("选完供应商自动带出联系人", "event/after-f7-select-process.md", "问句与关键词一个字都不重合"),
	historical("新增单据默认填当前组织", "event/after-create-new-data-set-value.md", "默认值"),
	historical("点按钮弹窗让用户选", "event/item-click-show-form.md", "按钮打开弹窗"),
	historical("子页面关掉回填主单", "event/closed-call-back-set-value.md", "弹窗回调"),
	historical("改表头字段联动分录", "event/property-changed-set-value.md", "字段联动"),
	historical("审核后不允许再改字段", "event/after-bind-data-set-enable.md", "按状态控制可编辑"),
	historical("查这个编码的单据存不存在", "data-access/query-service/query-exists.md", "跨族：数据访问，不是表单事件"),
	historical("分录行数多加载卡", "event/batch-load-entry.md", "性能类问法"),
];

/**
 * The six families the official index never tagged (`pluginType: null` in
 * `PLUGIN_ROUTES`).
 *
 * Two shapes, and the difference is the point. Operation / import / task /
 * workflow do have scene documents -- they are tagged `common`, so the table
 * holds the answer but no facet can narrow to it. BOTP and writeback have no
 * scene document at all: the table cannot answer them at any table size, and the
 * only correct behaviour is to hand over the guide and say so.
 */
const GAP_FAMILY: readonly EvalCase[] = [
	{
		id: "gap-operation-validator",
		kind: "gap-family",
		query: "提交的时候把整批单据一起查一遍不合格的挡下来",
		scene: "operation/custom-validator.md",
		guide: "platform/operation-plugin.md",
		pluginType: null,
		why: "操作族：官方没给标签，整表读不能靠过滤缩小",
	},
	{
		id: "gap-operation-post",
		kind: "gap-family",
		query: "单据审核成功之后再去更新别的表",
		scene: "operation/pre-post-operation.md",
		guide: "platform/operation-plugin.md",
		pluginType: null,
		why: "操作族事务前后处理",
	},
	{
		id: "gap-import",
		kind: "gap-family",
		query: "用户从 Excel 引数据进来要先挡掉不合规的行",
		scene: "common/batch-import-validate.md",
		guide: "platform/import-plugin.md",
		pluginType: null,
		why: "引入族：只有一篇场景，且标的是 common",
	},
	{
		id: "gap-task",
		kind: "gap-family",
		query: "每天夜里自动跑一次批量处理",
		scene: "infra/thread-pool/schedule-task.md",
		guide: "platform/task-plugin.md",
		pluginType: null,
		why: "任务族：场景在 infra 下，不在同名目录",
	},
	{
		id: "gap-botp",
		kind: "gap-family",
		query: "销售订单下推生成出库单的时候改一下带过去的值",
		scene: null,
		guide: "platform/botp-plugin.md",
		pluginType: null,
		why: "BOTP：整张场景表一条都没有，只有指南能答",
	},
	{
		id: "gap-writeback",
		kind: "gap-family",
		query: "下游单据审核后把数量反写回上游",
		scene: null,
		guide: "platform/writeback-plugin.md",
		pluginType: null,
		why: "反写：同上，兜底率的另一半",
	},
];

/** New business-voiced questions with real scene answers. */
const BUSINESS: readonly EvalCase[] = [
	{
		id: "biz-org-filter",
		kind: "business",
		query: "列表里只让看自己组织的数据",
		scene: "event/set-filter-tab-org.md",
		guide: null,
		pluginType: "listform",
		why: "列表族，权限口吻",
	},
	{
		id: "biz-confirm",
		kind: "business",
		query: "删之前先弹个框问一下",
		scene: "event/item-click-show-confirm.md",
		guide: null,
		pluginType: "billform",
		why: "与「按钮点击弹窗」相邻，考区分度",
	},
	{
		id: "biz-mutex",
		kind: "business",
		query: "两个人同时改同一张单要挡住",
		scene: "system-service/network-lock-control.md",
		guide: null,
		pluginType: "billform",
		why: "答案标的是 common，问句里没有一个索引词",
	},
	{
		id: "biz-stream",
		kind: "business",
		query: "几十万行数据不能一次全读进内存",
		scene: "data-access/query-service/query-dataset.md",
		guide: null,
		pluginType: null,
		why: "数据访问，量级口吻",
	},
	{
		id: "biz-transaction",
		kind: "business",
		query: "这几步要么全都成要么一起退回去",
		scene: "data-access/transaction/local-transaction.md",
		guide: null,
		pluginType: null,
		why: "事务，业务口吻里不会出现 TX",
	},
	{
		id: "biz-dist-lock",
		kind: "business",
		query: "集群里同一时刻只许一台机器在跑",
		scene: "infra/dist-lock/dist-lock-basic.md",
		guide: null,
		pluginType: null,
		why: "基础设施族",
	},
	{
		id: "biz-silent-set",
		kind: "business",
		query: "批量塞值的时候别每改一格就重算一次",
		scene: "common/model-begin-end-init.md",
		guide: null,
		pluginType: "billform",
		why: "性能反模式，问句与 beginInit/endInit 无字面交集",
	},
	{
		id: "biz-pass-param",
		kind: "business",
		query: "打开下一个页面时把这张单的信息带过去",
		scene: "common/form-show-param.md",
		guide: null,
		pluginType: "billform",
		why: "参数传递",
	},
	{
		id: "biz-report-data",
		kind: "business",
		query: "报表的数据要自己算不是直接查表",
		scene: "report/report-list-data-query.md",
		guide: null,
		pluginType: "reportlist",
		why: "报表族，考族过滤是否把答案筛掉",
	},
];

/**
 * Questions this snapshot has no answer for.
 *
 * The criterion is not recall. It is that a miss says so and names a next step:
 * a knowledge tool that returns "0 命中" and stops is the same failure shape as
 * defect D-3 -- the reader cannot tell "the knowledge base has nothing" from
 * "you asked it wrong".
 */
const LOW_CONFIDENCE: readonly EvalCase[] = [
	{
		id: "low-wecom-login",
		kind: "low-confidence",
		query: "接企业微信扫码登录",
		scene: null,
		guide: null,
		pluginType: null,
		why: "认证接入，官方场景表没有这一层",
	},
	{
		id: "low-excel-watermark",
		kind: "low-confidence",
		query: "导出的 Excel 上加水印",
		scene: null,
		guide: null,
		pluginType: null,
		why: "导出与文档处理，表里没有",
	},
	{
		id: "low-login-theme",
		kind: "low-confidence",
		query: "把登录页换成客户自己的配色",
		scene: null,
		guide: null,
		pluginType: null,
		why: "前端主题，不属于插件开发",
	},
	{
		id: "low-mobile-gesture",
		kind: "low-confidence",
		query: "移动端加一个自定义手势",
		scene: null,
		guide: null,
		pluginType: null,
		why: "问法贴着 mob 族，但表里确实没有——最容易被硬答的一类",
	},
];

/**
 * Version drift.
 *
 * Every API document in the snapshot declares framework 8.0.1; the JARs on the
 * user's machine declare whatever they declare. So the drift is not hypothetical
 * and cannot be resolved from the snapshot alone -- which is exactly why the
 * requirement is that the answer states its version and states whether it was
 * checked, never that it be silently right.
 */
const VERSION_DRIFT: readonly EvalCase[] = [
	{
		id: "drift-known-class",
		kind: "version-drift",
		query: "kd.bos.algo.Algo",
		fqcn: "kd.bos.algo.Algo",
		scene: null,
		guide: null,
		pluginType: null,
		why: "文档有这个类：答案必须自报框架版本，且自报有没有跟 JAR 对过",
	},
	{
		id: "drift-unknown-class",
		kind: "version-drift",
		query: "kd.bos.orm.query.QFilterRenamed",
		fqcn: "kd.bos.orm.query.QFilterRenamed",
		scene: null,
		guide: null,
		pluginType: null,
		why: "快照里没有这个类：必须报「没有」，不许拿最近的一篇顶上",
	},
	{
		id: "drift-plugin-base",
		kind: "version-drift",
		query: "kd.bos.form.plugin.AbstractFormPlugin",
		fqcn: "kd.bos.form.plugin.AbstractFormPlugin",
		scene: null,
		guide: "platform/form-plugin.md",
		pluginType: "form",
		why: "查的是插件基类：版本要报，L1 第三个插入点也要出现",
	},
];

export const EVAL_CASES: readonly EvalCase[] = [
	...HISTORY,
	...GAP_FAMILY,
	...BUSINESS,
	...LOW_CONFIDENCE,
	...VERSION_DRIFT,
];

/** Cases whose answer is a scene document -- the only ones recall is defined for. */
export function answerableCases(cases: readonly EvalCase[] = EVAL_CASES): EvalCase[] {
	return cases.filter((entry) => entry.scene !== null);
}
