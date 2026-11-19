/**
 * One deterministic contract for each headless run adapter (S15.1).
 *
 * The kernel reads the accepted flags, hint and probe from this table, while
 * Knowledge Capsule rendering reads the boundary text. Keeping both consumers
 * on the same rows prevents the card from advertising a flag the parser drops.
 */

export const RUN_KINDS = ["op", "form", "list", "callback", "flow", "rule", "print", "call", "push", "wf"] as const;
export type RunKind = (typeof RUN_KINDS)[number];

/**
 * When a run needs a process of its own. Every run commits through the platform's
 * own path and the form simulators keep their Redis keys in a session of their own,
 * so the resident JVM serves them all.
 */
export type RunColdPolicy = "never";

/**
 * 一个子命令的完整写法，和它认的每个参数各一句说明。
 *
 * 参数说明写在这里，而不是散在工具描述和文档里：解析器认哪些参数（`accepted`）、
 * `cosmic_run ["help", 子命令]` 打什么、知识卡片和参数被拒时列什么，都从这一张表出。
 * 以前参数有三份——解析器一份、工具描述一份、文档一份——各漏各的：`run form --op`
 * 解析器认，工具描述没写，文档只在开头的命令概要里出现一次，一次真实会话为了找它
 * 翻了九轮磁盘。加一个参数不写说明，测试就过不去。
 */
interface RunAdapterSource {
	kind: RunKind;
	probe: string;
	/** 位置参数怎么排，一行，不含 `--` 参数。 */
	usage: string;
	/** 参数名（不带 `--`）→ 值怎么写 + 它做什么。键的集合就是这个子命令认的全部参数。 */
	flags: Readonly<Record<string, string>>;
	hint: string;
	cold: RunColdPolicy;
	must: readonly string[];
	avoid: readonly string[];
	/**
	 * 能照抄的完整命令，卡片里放在 SIGNATURES 下。
	 *
	 * 只给真机上有人翻过源码的那几个（S20 批 5）：两次拉伸试验会话一共 31 次去缓存里读
	 * 探针 Java，除了写界面规则那几次，其余都在弄清「弹窗确认之后回写父页」该怎么跑——
	 * 参数表列全了，缺的是一条连起来的命令。rule / op / list 没人翻过，不加。
	 */
	examples: readonly string[];
}

export interface RunAdapterContract extends RunAdapterSource {
	/** 这个子命令认的参数名，就是 `flags` 的键。 */
	accepted: readonly string[];
}

/** 几个子命令共用、意思也一样的参数。意思不一样的（--set、--show、--select…）各写各的。 */
const SHARED_FLAGS = {
	expect:
		"路径=值　断言，可重复；路径=@nonempty 验非空，路径=@literal:@nonempty 验字面值；/ 只表示斜杠；全过的那次运行才算验过",
	pk: "<内码>　打开已有单据",
	billno: "<单据编号>　只有编号时用，工具自己查内码；和 --pk 只给一个",
	skip: "插件简名,…　摘掉这些插件再跑；某个插件抛异常、把后面的插件截断了时用",
	events: "（不带值）打插件事件明细，默认只打每种事件几次",
	calls: "N　额外打最后 N 条原始客户端调用，只在输出看不懂时排查用",
	cache: "键=值　预置页面缓存，可重复；插件读的缓存键在真实会话里由前一个请求写入时用",
	schedule: "（不带值）先在常驻进程里起调度服务：提交要发起工作流、派发后台任务时用；起了开到常驻进程退出",
	user: "<用户名|工号|姓名|用户id>　以这个用户的身份跑整次运行（登录用户、权限、数据范围、修改人都是他）；不给是配置里的用户。只认唯一对得上的启用用户",
} as const;

const SOURCES: Readonly<Record<RunKind, RunAdapterSource>> = {
	op: {
		kind: "op",
		probe: "OpSandbox",
		usage: "op <实体标识> <操作标识> [参数…] [--case <场景名> 参数… …]",
		flags: {
			set:
				"字段=值　造数，可重复；走 DynamicObject.set，不触发 propertyChanged。" +
				"@上游.<单据标识>.<字段>=值 改这张单连着的上游单（@下游. 改下游单，分录写 <分录>[行].<字段>），要配 --pk / --billno：" +
				"跑之前直接存库改上（不走那张单的校验器和插件），这个场景跑完改回",
			expect:
				"路径=值　断言，可重复；保留字断言操作结果：success=true|false 成没成，message=片段 界面弹出的提示里有这段（顶上那句和逐条列出的错都算），error=片段 只在逐条列出的错里找；success=false 带了 message / error 时，逐条列出的错每条都要对得上其中一句，有对不上的算输入不成立、不留验证记录",
			pk: SHARED_FLAGS.pk,
			billno: SHARED_FLAGS.billno,
			op: "<操作标识>　只在 --case 段里用：这一段换成跑这个操作",
			filter: "字段=值　缩小跑前跑后行数对照的范围，大表上省一次全表计数",
			schedule: SHARED_FLAGS.schedule,
			user: SHARED_FLAGS.user,
		},
		hint: "op 跑一次操作，真提交（和界面上点一下一样）：--set 造数、--expect 断结果（success/message/error 是保留字）、--case 分段批量。op 没有 --show，要看某个字段的终值就写成 --expect 断言它。",
		cold: "never",
		must: [
			"操作不自动回滚；「数据库现状」给出回读的 pk、编号和单据状态，不证明全部字段输入已保存，接着验这张单写 --pk",
			"同一实体的多个场景可以用 --case 一次跑完，按顺序提交",
			"操作执行最多等 5 分钟，多个场景最多等 10 分钟；超时不代表操作已停止，不自动重跑，下次调用先更换失效的常驻进程，先只读核对现状",
		],
		avoid: [
			"同一张单提交、审核过之后状态就变了，同一条命令再跑结果可能不同：先看「数据库现状」再决定换单还是先反审核",
			"没有 --expect 只证明跑起来，不算验证通过",
		],
		examples: [],
	},
	form: {
		kind: "form",
		probe: "FormSim",
		usage: "form <表单或布局标识> [参数…]",
		flags: {
			set: "字段=值　改值，可重复；走 model.setValue，会触发 propertyChanged（要验的正是这个）",
			expect:
				"路径=值　断言，可重复；路径=@nonempty 验非空，路径=@literal:@nonempty 验字面值；/ 只表示斜杠；全过的那次运行才算验过。字段终值写 字段=值、分录[行].字段=值；" +
				"界面状态写 控件.visible|enabled|mustInput=true|false，分录某一格 分录[行].字段.enabled，整列 分录.字段.visible，整行锁定 分录[行].enabled；" +
				"动作的效果用保留字：opened=页面标识,… 这次打开了哪些页面（不看顺序，留空是一个没开），" +
				"opened.参数=值 唯一打开的那个页面带的参数（插件 setCustomParam 放的，打开单据还有 pk；~= 是包含），" +
				"message=片段 弹给用户的话里有这段（提示、错误、消息框都算，留空是一句没弹）",
			show: "字段,…　跑完（在 --op / --click / --hyperlink 之后）只打终值、不断言；分录写 分录标识.字段；写界面路径（控件.visible 这种）或面板、按钮的标识，打它显示、可编辑、必录的结论和由来",
			pk: SHARED_FLAGS.pk,
			billno: SHARED_FLAGS.billno,
			status:
				"new|edit|view　按哪种页面状态打开；不写就按有没有 --pk 定新增或修改，view 和 edit 要带 --pk。" +
				"打开已有单据照平台的修改操作，已提交、已审核的单按已提交、已审核开",
			op: "<操作标识>　跑一个操作，等于点了绑它的按钮（真提交）；操作标识用 OpMetaProbe 查",
			click: "<按钮key>　点工具栏按钮（真提交），按钮绑的操作从元数据自己解析，不用另给 --op",
			hyperlink:
				"分录[行].字段　点分录这一格的超链接（子分录写 分录[行].子分录[行].字段），派发给插件挂在这个分录上的超链接监听；" +
				"不提交，插件自己写库、调外部接口的照做。点的是已有的一行，新单先用 --set 写出那一行；和 --click、--op 只给一个",
			toolbar: "<工具栏key>　--click 的按钮不在常见工具栏（tbmain、toolbarap、advcontoolbarap）里时指明它在哪",
			select: "分录标识=0,2　分录选中行；等号后留空表示一行没选；不给就按 --set 写过的行",
			f7: "<F7字段key>　模拟点开这个基础资料字段，只跑到 beforeF7Select，报插件加的过滤或把它拦住的理由",
			cache: SHARED_FLAGS.cache,
			skip: SHARED_FLAGS.skip,
			events: SHARED_FLAGS.events,
			calls: SHARED_FLAGS.calls,
			schedule: SHARED_FLAGS.schedule,
			user: SHARED_FLAGS.user,
		},
		hint: "form 起真 FormView：--set 造数、--click/--op/--hyperlink 触发、--show 打终值、--expect 断言、--select 定分录选中行。",
		cold: "never",
		must: [
			"--select 表示分录选中行，格式为 分录标识=0,2；空等号表示一行未选",
			"--show 只打印终值，验证结论必须写 --expect",
			"动作会弹子页、子页关闭时在 closedCallBack 回写父页的：form 只验到弹出为止，整条链用 run flow（照 SIGNATURES 那行改）；手里没有能触发弹窗的父动作才用 run callback",
		],
		avoid: [
			"当前行 getValue 与选中行 getSelectRows 不是同一状态",
			"按钮、操作不自动回滚；操作成功不等于表单输入已保存，再跑前核对数据库现状",
		],
		examples: [
			"run flow demo_bill_layout --pk 100001 --op demo_round --child demo_round_dialog --set demo_entry[0].demo_n=0.1234 --child-set demo_items[0].demo_step=0.05 --child-click btnok --expect demo_entry[0].demo_n=0.1",
		],
	},
	list: {
		kind: "list",
		probe: "ListSim",
		usage: "list <列表布局标识> [参数…]",
		flags: {
			expect: "rows / selected / filters / action / success / columns / pks=值　断言列表这一层的事实，可重复",
			filter: "字段=值　列表过滤条件，可重复",
			"main-org": "组织内码,…　在筛选栏里把主业务组织换成这几个；不给就是当前登录组织",
			limit: "1..200　首屏取几行，默认 20",
			summary: "（不带值）顺带查合计",
			mobile: "（不带值）开这张单据带的移动端列表（移动端列表插件挂在它上面）；不和 --main-org、左树一起用",
			select: "pk,…　先选中这些主键的行（是主键，不是分录行号）；只能选这次查出来的首屏里的行",
			click: "<按钮key>　点列表工具栏按钮（真提交）",
			op: "<操作标识>　对选中行跑一个操作（真提交）",
			"row-click": "<pk>　单击一行",
			"row-double-click": "<pk>　双击一行",
			hyperlink: "<pk>:<字段>　点这一行里的超链接字段",
			callback: "<回调id>:Yes|No|OK|Cancel　跟在主交互后面，模拟确认框点了哪个按钮",
			"tree-node": "<节点id>　点左树节点",
			"tree-toolbar": "<按钮key>　点左树工具栏按钮",
			cache: SHARED_FLAGS.cache,
			skip: SHARED_FLAGS.skip,
			events: SHARED_FLAGS.events,
			calls: SHARED_FLAGS.calls,
			user: SHARED_FLAGS.user,
		},
		hint: "list 验的是过滤、列和取数，不造单：--filter 过滤、--limit 限行、主交互一次只给一个（按钮、操作真提交）。",
		cold: "never",
		must: [
			"列表不造单，输入条件用 --filter，不用 --set",
			"click/op/row-click/row-double-click/hyperlink/tree-node/tree-toolbar 一次只能给一个主交互",
		],
		avoid: ["list 的 --select 是主键，不是 form 的分录行号", "无 --expect 的输出不能当回归结论"],
		examples: [],
	},
	callback: {
		kind: "callback",
		probe: "FormCallbackSim",
		usage: "callback <父表单标识> <子表单标识> --callback <父插件全类名>[:actionId] [参数…]",
		flags: {
			set: "字段=值　父页的值，可重复",
			"child-set": "字段=值　子页的值，可重复",
			expect: "路径=值　断言回写之后的父页，可重复",
			callback:
				'<父插件全类名>[:actionId]　必给；actionId 是插件里 new CloseCallBack(this, "…") 的第二个参数，省略时取父页实体标识',
			"parent-entry": "<分录标识>　父插件读分录当前行时，指明是哪个分录",
			"child-op": "<操作标识>　子页上确认的那个动作是操作时用；和 --child-click 只给一个",
			"child-click": "<按钮key>　子页上确认的那个动作是按钮时用；和 --child-op 只给一个",
			skip: SHARED_FLAGS.skip,
			user: SHARED_FLAGS.user,
		},
		hint: "callback 验父子回调：父页 --set、子页 --child-set、--callback 指父插件类[:actionId]。子页上的动作真提交。",
		cold: "never",
		must: ["同时给父表单、子表单和 --callback 父插件类[:actionId]", "父页值用 --set，子页值用 --child-set"],
		avoid: [
			"callback 验的是父子页回调，和普通 form 事件是两回事",
			"callback 的子页是手工拼的：父插件 showForm 时塞的自定义参数一概没有，父页也总是新建（不接 --pk）；子页靠这些参数初始化、或要用已有单据的，改用 run flow",
		],
		examples: [
			"run callback demo_bill_layout demo_round_dialog --callback demo.formplugin.DemoBillPlugin:demo_round --set demo_entry[0].demo_n=0.1234 --child-set demo_items[0].demo_step=0.05 --child-click btnok --expect demo_entry[0].demo_n=0.1",
			'--callback 写父插件全类名:actionId，actionId 就是插件里 new CloseCallBack(this, "…") 的第二个参数，省略时取父页实体标识',
		],
	},
	flow: {
		kind: "flow",
		probe: "FormFlowSim",
		usage: "flow <父表单标识> (--op <操作标识> | --click <按钮key> | --hyperlink <分录[行].字段>) [--child <子页标识>] [参数…]",
		flags: {
			set: "字段=值　父页的值，可重复",
			"child-set": "字段=值　子页弹出之后写进子页的值，可重复",
			expect: "路径=值　断言回写之后的父页，可重复",
			pk: SHARED_FLAGS.pk,
			billno: SHARED_FLAGS.billno,
			op: "<操作标识>　父页上会弹出子页的那个操作；和 --click、--hyperlink 只给一个",
			click: "<按钮key>　父页上会弹出子页的那个按钮；和 --op、--hyperlink 只给一个",
			hyperlink: "分录[行].字段　父页上会弹出子页的那一格超链接；和 --op、--click 只给一个",
			toolbar: "<工具栏key>　--click 的按钮不在常见工具栏里时指明它在哪",
			select: "分录标识=行号　父页分录选中行；配了 --parent-entry 可以只写行号",
			child: "<子页标识>　预期弹出的子页；run form 跑同一个动作时会把它打出来",
			"parent-entry": "<分录标识>　父动作读分录当前行时，指明是哪个分录",
			"child-op": "<操作标识>　子页上确认的那个动作是操作时用；和 --child-click 只给一个",
			"child-click": "<按钮key>　子页上确认的那个动作是按钮时用；和 --child-op 只给一个",
			skip: SHARED_FLAGS.skip,
			user: SHARED_FLAGS.user,
		},
		hint: "flow 验父子流程：父动作 --click、--op、--hyperlink 三选一、子页值用 --child-set。父子两页上的按钮、操作都真提交。",
		cold: "never",
		must: [
			"父动作 --click、--op、--hyperlink 必须且只能给一个",
			"子页目标与输入分别用 --child 和 --child-set",
			"子页确认动作是操作用 --child-op、是按钮控件用 --child-click，两个只能给一个",
		],
		avoid: ["父动作一次只给一个，否则分不清执行了哪条"],
		examples: [
			"run flow demo_bill_layout --pk 100001 --op demo_round --child demo_round_dialog --set demo_entry[0].demo_n=0.1234 --child-set demo_items[0].demo_step=0.05 --child-click btnok --expect demo_entry[0].demo_n=0.1",
			"--op/--click/--hyperlink 是父页上会弹子页的那个动作；--child 是弹出的子页标识（run form 跑同一个动作时会打出来）；--set 写父页、--child-set 写子页；--expect 断言回写之后的父页；父动作要读分录当前行时加 --parent-entry <分录标识>",
		],
	},
	rule: {
		kind: "rule",
		probe: "RuleSim",
		usage: "rule form <布局标识> [参数…]　或　rule biz <实体标识> [参数…]",
		flags: {
			set: "字段=值　造数，可重复；只支持表头和分录，子分录路径会跳过",
			expect: "form：字段.visible=true / 字段.enabled=false；biz：字段=值。断言，可重复",
			show: "标识,…　只打值、不断言；form 给控件标识（面板、分组也行）打可见/可编辑，biz 给字段路径打值",
			host: "<宿主标识>　只给 biz：只跑这一个宿主（主实体或某个分录），默认全部",
			row: "N　分录行号，默认 0",
			scene: "all|init|new|edit|view|submit|audit　按哪个场景算，默认 all",
			list: "visible|hidden|all　把判为显示 / 隐藏的字段全列出来",
			branch: "hide-wins|both|true-only　条件不成立时假分支怎么算，默认 hide-wins",
			user: SHARED_FLAGS.user,
		},
		hint: "rule 只算规则层：--set 造数、--show 只打值（form 可点名面板等容器）、--expect 断言、--scene/--branch/--list 控口径。",
		cold: "never",
		must: [
			"先写 rule form <布局> 或 rule biz <实体>",
			"它只计算规则层，不建 View、不安装插件",
			"改前看值用 --show：只打值、不断言",
		],
		avoid: [
			"rule 全绿只证明规则层对，证明不了表单插件事件跑过",
			"rule 明确不支持子分录路径",
			"--expect 是断言：改前写它等于断言旧样子是对的，改完代码重跑必红",
		],
		examples: [],
	},
	print: {
		kind: "print",
		probe: "PrintSim",
		usage: "print <打印模板编码> (--pk <单据内码> | --billno <单据编号>) [参数…]",
		flags: {
			set: "字段=值　先把单据改成这样并保存（真提交，只走保存、不走操作插件），再出打印",
			expect:
				"格子=值　断言打印出来的文字；格子写控件名或绑定字段，[1] 是第 2 行，~= 是包含；表格写 表格key[行]=a | b | c",
			show: "格子 | 表格key | 数据源　只打出来看、不断言；表格 key 逐行打整张表，数据源打插件拿到的数据行",
			pk: "<单据内码>　出打印的那张单，和 --billno 必给一个",
			billno: "<单据编号>　只有编号时用，工具自己查内码",
			user: SHARED_FLAGS.user,
		},
		hint: "print 拿一张真单据出一次打印（预览，不写打印记录），按格子断言最终文字：--pk 必给、--expect 格子=值 断言、--show 格子或表格 key 只打出来看、--set 先改字段并保存（真提交）再出打印。",
		cold: "never",
		must: [
			"改插件前先列取数表（字段完整路径、表头/分录、原值/显示文字、单位），在目标单上查一次核对；来源只用查询认出的字段；拿不准的放进那次提问一起问",
			"写成 run print <模板编码> --pk <单据ID> --expect <格子>=<值>；模板编码不是单据标识；手里只有单据编号就写 --billno <编号>，不用先去查内码",
			"格子写模板控件名（datacell9）或它绑的字段（zlgd_bz_jx）；[1] 指第 2 行明细（从 0 数），不写下标就是每一行都要等于；~= 表示包含",
			"插件新插的行、列用表格断言：--expect 表格key[行]=a | b | c（整行，格子用 | 隔开）或 表格key[行][列]=值，行号列号就是 --show 表格key 打出来的那个；插件写法照需求写，断言来适应它",
			"要的数据库里没有（例如备注全空），用 --set 把现成单据改成那样（真提交）",
			"断言靠的字段都在这次 --set 里给值：上次改的值会留在单上，不给就可能假通过",
			"想先看打出来什么，用 --show <表格key>（逐行，含插件新插的行）或 --show <格子>",
			"插件取字段取到空，先 --show 数据源 看数据行里有没有它（模板没绑的字段引擎不查）",
		],
		avoid: [
			"格子文字是打印插件改完之后的最终输出，不是单据字段原值；要断言字段原值用 run op",
			"--set 只走保存、不走操作插件",
			"格子断言只证明文字对，版面没验，交付时分开说",
			"--set 的 [i] 是分录第 i 条，--expect 的 [i] 是打印出来的第 i 行；插件合并行时两者对不上，先查清分录条数再写 --set",
			"插件新插的行、列按格子名看不到；格子只输出 1 行不等于插件没跑，看整张表",
		],
		examples: [
			"run print demo_bill_print_tpl --pk 100001 --set demo_entry[0].demo_remark= --expect datacell9[0]=/ --expect demo_sample[0]=1-1",
			"run print demo_bill_print_tpl --pk 100001 --expect demo_grid[1]=1-1 | 合格 | 不合格 --expect demo_grid[0][3]=检 测 结 果",
		],
	},
	call: {
		kind: "call",
		probe: "CallSim",
		usage: "call <类名>#<方法名>[(类型,…)] [参数…]",
		flags: {
			args: "<JSON 数组>　一项对一个方法参数，整个数组作为 argv 里的一项原样放进去",
			expect:
				"路径=值　断言返回值：[0].字段、size、$ 是返回值本身；args[0].x 读调用后的入参；error= 断言没抛异常，error~=片段 断言抛了",
			schedule: SHARED_FLAGS.schedule,
			user: SHARED_FLAGS.user,
		},
		hint: "call 直接调本工程一个类的方法（静态方法，或无参构造出对象再调），真提交：--args 是 JSON 数组、一项对一个参数，--expect 断言返回值。",
		cold: "never",
		must: [
			"写成 run call <类名>#<方法名> --args [参数1,参数2] --expect <路径>=<值>；类名写全类名或不重名的简单类名，重载分不清时写 #方法名(类型,类型)",
			'参数按方法签名造：字符串、数字、布尔、日期字符串、列表、Map 照 JSON 写；打印数据行 DataRowSet 写成 {字段:值}，分录写成对象数组；单据数据对象 DynamicObject 写成 {"@entity":"实体标识", 字段:值}，加 "@pk" 就先取那张现成单据再改；RequestContext 参数工具自己给，不占 --args 的位置',
			"--expect 路径：直接写就是返回值（[0].zlgd_bz_jx、size、$ 表示返回值本身）；args[0][1].x 读调用之后的第 1 个参数（给改入参的 void 方法用）；error~=片段 断言抛了异常、error= 断言没抛",
		],
		avoid: [
			"只能调本工程源码里的类；要表单、操作、打印环境的插件方法（用到 getView/getModel 的）调不起来，改用对应的 run 子命令",
			"方法写库、发消息、调接口都会真的发生（测试环境已放开）；前检会把走得到的这类动作列在提醒里",
			"--args 只收内联 JSON，不收文件：验证记录要原样记下这次喂进去的是什么",
		],
		examples: [
			'run call zlgd.demo.printplugin.DemoPrintPlugin#collapse --args [[{"demo_sample":"1-1","demo_remark":""},{"demo_sample":"1-1","demo_remark":null}],["显微组织"]] --expect [0].demo_remark=/ --expect size=1',
			'run call zlgd.demo.task.DemoTask#execute --args [{"days":365}] --expect error=',
			"--args 是 argv 里的一项，整个 JSON 数组原样放进去；error= 断言没抛异常（给 void 方法、调度任务用）",
		],
	},
	push: {
		kind: "push",
		probe: "PushSim",
		usage: "push <转换规则id> (--pk <源单内码> | --billno <源单编号>) [参数…]",
		flags: {
			expect:
				"路径=值　断言生成的目标单，可重复；success / message / bills 是保留字（下推成没成、提示里有这段、生成了几张），[1].字段 指第 2 张目标单",
			show: "字段,…　只打目标单上这些字段的值、不断言",
			pk: "<源单内码>　下推哪张源单，和 --billno 必给一个",
			billno: "<源单编号>　只有编号时用，工具自己查内码",
			user: SHARED_FLAGS.user,
		},
		hint: "push 按转换规则下推并保存目标单，再从数据库重新读取：--pk 给源单、--expect 断言回读字段、--show 打回读值；真提交，会触发保存和反写。",
		cold: "never",
		must: [
			"写成 run push <规则id> --pk <源单内码> --expect <目标单字段>=<值>；规则 id 用 cosmic_meta botp list --plugin <插件类名> 查",
			"规则按分录下推时，整张源单的分录行全部选中",
		],
		avoid: [
			"目标单必须落库并回读，保存及反写插件会执行；转换插件自己的写入也真提交",
			"输出里「转换插件」那行没有启用的本工程插件时，全过只证明规则的字段映射",
			"基础资料字段同时检查对象内码和外键；跳过复制要断言该字段及至少一个应被复制的对照字段，防止复制整块没执行却误过",
		],
		examples: [],
	},
	wf: {
		kind: "wf",
		probe: "WfSim",
		usage: "wf <插件类名>[#方法] [单据标识] (--pk <单据内码> | --billno <单据编号>) [参数…]",
		flags: {
			expect:
				"路径=值　断言，可重复；error= 断言插件没抛异常、error~=片段 断言抛了，result、result.字段 是方法返回值，其余是插件跑完后库里的单据字段；键后加 ~ 是包含",
			show: "字段,…　插件跑完后只打单据上这些字段的值、不断言",
			pk: "<单据内码>　流程挂的那张单，和 --billno 必给一个",
			billno: "<单据编号>　只有编号时用，工具自己查内码",
			node: "<节点名称或编码>　插件挂在好几个节点上时指定哪一个；不给按第一处",
			ctx: "键=值　流程上下文，可重复：decision=决策项编码、message=审批意见、approvers=审批人（id 或工号，逗号分隔）、starter=发起人、param.键=插件参数、var.键=流程变量、vote=用户:approve|reject[:决策项编码]（会审投票，可重复）、pending=还没投的票数",
			set: "字段=值　先把单据改成这样并保存（真提交，只走保存、不走操作插件），再调插件",
			user: SHARED_FLAGS.user,
		},
		hint: "wf 直接调一个工作流插件的方法，不真跑流程：挂在哪个节点、什么时机从已发布的流程定义里读，照引擎的样子拼出上下文；真提交，--ctx 给审批意见等上下文、--expect 断言返回值和插件跑完后的单据。",
		cold: "never",
		must: [
			"写成 run wf <插件类名> --pk <单据内码> --expect <字段>=<值>；调哪个方法、哪个节点、哪个决策项按它在已发布流程里挂的位置定，挂了好几处时加 --node 挑",
			"插件读的上下文用 --ctx 给：审批意见 message=…、决策项 decision=…（节点上配了的编码）、审批人 approvers=…",
			"流程里没挂它的，写成 run wf <类名>#<方法> <单据标识> --pk <单据内码>",
		],
		avoid: [
			"流程没有真跑：全过证明插件在这个上下文里的行为；引擎会不会在这个节点调它，看输出开头列的挂载位置",
			"插件里取当前用户（RequestContext）拿到的是这次运行的用户（--user 给的，没给是配置里的），不是审批人；审批人从上下文里取",
			"插件保存单据是真提交：同一张单再跑，上次写进去的值还在，留意输出里「跑之前单上就是这个值」那行",
		],
		examples: [],
	},
};

export const RUN_ADAPTER_CONTRACTS: Readonly<Record<RunKind, RunAdapterContract>> = Object.fromEntries(
	RUN_KINDS.map((kind): [RunKind, RunAdapterContract] => [
		kind,
		{ ...SOURCES[kind], accepted: Object.keys(SOURCES[kind].flags) },
	]),
) as Record<RunKind, RunAdapterContract>;

/** 这个子命令的参数，一个一行：`--op <操作标识>　跑一个操作…`。 */
export function runFlagLines(kind: RunKind): string[] {
	return Object.entries(RUN_ADAPTER_CONTRACTS[kind].flags).map(([name, meaning]) => `--${name} ${meaning}`);
}

/** 用法怎么问：写进工具描述、参数被拒的提示和知识卡片，三处同一句。 */
export function runHelpCall(kind?: RunKind): string {
	return `cosmic_run argv=${JSON.stringify(kind === undefined ? ["help"] : ["help", kind])}`;
}

/**
 * `cosmic_run ["help", …]` 要附上的那几段文档原文。
 *
 * 由调用方从发布到磁盘的参考文档里读出来传进来；读不到就是 null，帮助照样出，
 * 只是少了原文那一段，并且明说少了。
 */
export interface RunHelpDocs {
	/** cosmic-run 那一篇的全文。 */
	run: string | null;
	/** cosmic-run-parent-child 那一篇的全文（callback / flow 的说明在这里）。 */
	parentChild: string | null;
}

/** 从一篇文档里切出 `## <标题开头>` 这一节（含下面的 ### 小节），切不到返回 null。 */
export function markdownSection(markdown: string, headingStart: string): string | null {
	const lines = markdown.split(/\r?\n/);
	const start = lines.findIndex((line) => line.startsWith(`## ${headingStart}`));
	if (start < 0) return null;
	let end = lines.length;
	let fenced = false;
	for (let i = start + 1; i < lines.length; i++) {
		const line = lines[i] as string;
		if (line.startsWith("```")) fenced = !fenced;
		if (!fenced && line.startsWith("## ")) {
			end = i;
			break;
		}
	}
	return lines.slice(start, end).join("\n").trim();
}

/**
 * `cosmic_run ["help"]` 和 `["help", 子命令]` 的全文。
 *
 * 不给子命令：每个子命令一行写法和用途，外加字段路径与值的通用写法。
 * 给了子命令：它的写法、认的每个参数、必须注意的和容易错的、能照抄的例子，
 * 再附文档里这个子命令那一节原文。
 */
export function renderRunHelp(kind: RunKind | undefined, docs: RunHelpDocs): string {
	if (kind === undefined) {
		const lines = [
			"# cosmic_run 用法",
			"",
			...RUN_KINDS.flatMap((one) => [
				`- ${RUN_ADAPTER_CONTRACTS[one].usage}`,
				`  ${RUN_ADAPTER_CONTRACTS[one].hint}`,
			]),
			"",
			`某个子命令的全部参数：${runHelpCall("form")}（form 换成要用的子命令）。`,
		];
		const paths = docs.run === null ? null : markdownSection(docs.run, "`--set` / `--expect` 的路径与值");
		if (paths !== null) lines.push("", paths);
		return lines.join("\n");
	}
	const contract = RUN_ADAPTER_CONTRACTS[kind];
	const lines = [
		`# cosmic_run ${kind} 用法`,
		"",
		contract.usage,
		contract.hint,
		"",
		"## 参数（只有这些，别的参数会被拒）",
		...runFlagLines(kind).map((line) => `- ${line}`),
		"",
		"值断言：路径=@nonempty 验非空（null、空串、空白不通过）；路径=@literal:@nonempty 验字面值。路径=/ 只验斜杠，不表示非空。",
	];
	if (contract.must.length > 0) lines.push("", "## 必须注意", ...contract.must.map((line) => `- ${line}`));
	if (contract.avoid.length > 0) lines.push("", "## 容易错", ...contract.avoid.map((line) => `- ${line}`));
	const commands = contract.examples.filter((line) => line.startsWith("run "));
	if (commands.length > 0)
		lines.push("", "## 能照抄的例子（argv 按空格拆开）", ...commands.map((line) => `- ${line}`));
	const source = kind === "callback" || kind === "flow" ? docs.parentChild : docs.run;
	const section = source === null ? null : markdownSection(source, `run ${kind}`);
	lines.push("", section ?? `（文档原文这次没读到，以上参数表是完整的。）`);
	return lines.join("\n");
}

export const RUN_PROBES: Readonly<Record<RunKind, string>> = Object.fromEntries(
	RUN_KINDS.map((kind) => [kind, RUN_ADAPTER_CONTRACTS[kind].probe]),
) as Record<RunKind, string>;

export function isRunKind(value: string | undefined): value is RunKind {
	return value !== undefined && (RUN_KINDS as readonly string[]).includes(value);
}

/**
 * Whether a run's argv writes business data (S27: runs commit). An operation, a
 * direct call and the parent/child flows always may; a print only with `--set`
 * (it saves the bill first); a form or list only when it presses something --
 * a bare `--set` on a form changes the view, not the database. A workflow plugin
 * run (`wf`) always may: the plugins save the bill they were called for.
 * `rule` never does. `push` saves target bills and reads them back from the database.
 *
 * Two readers: the receipt says which runs left the bills changed, and `run`
 * clears the repeated-question ledger before one of these (the answer may change).
 */
export function runCommits(argv: readonly string[]): boolean {
	const kind = argv[0];
	if (kind === "op" || kind === "call" || kind === "flow" || kind === "callback" || kind === "wf" || kind === "push")
		return true;
	if (kind === "print") return argv.includes("--set");
	if (kind === "form" || kind === "list") {
		return argv.some((arg) => arg === "--op" || arg === "--click" || arg === "--toolbar");
	}
	return false;
}
