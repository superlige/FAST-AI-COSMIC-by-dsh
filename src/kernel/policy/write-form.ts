/**
 * 共享写入的确认单表单（S23）。
 *
 * 一段话看懂：以前授权确认框里的内容是模型自己写的四段话（对象 / 改什么 / 原来 / 改后）加风险、
 * 回滚两段，工具原样拼起来。真机里写出来的是「实验室检测单 zlgd_sys_test_bill 的拉伸试验布局
 * zlgd_sys_test_lssy（拉伸试验结果分录 zlgd_entryentity_lssy）」这种标识和中文名搅在一起的长句，
 * 13 个字段挤在一句话里，回滚写成探针命令——用户根本读不下去。现在确认单按写入类别分成固定的
 * 表单：哪几行、哪几列、影响和撤回怎么说，都由这里按 dry-run 的入参和探针报的记录填好；模型只
 * 能往两种格子里填值——标识的中文名（`names`）和少数必须翻成人话的格子（`slots`，例如界面规则
 * 的条件），外加一句目的和一句可选的注意事项。
 *
 * 为什么事实一律由这里填：确认单是用户放行共享写入的唯一依据。字段标识、类型、原值、新值这些
 * 东西 dry-run 的入参和探针输出里本来就有，交给模型转述一遍只会多出一个抄错、漏项的机会。
 */

import type { ProbeJsonRecord } from "../probe/output.ts";

/** 确认单里的一格。 */
export type FormCell =
	/** 工具填好的事实，原样显示。 */
	| { text: string }
	/** 一个标识的中文名：显示模型在 `names` 里给的名字（探针报过名字的直接用探针的）。 */
	| { name: string }
	/** 几个标识的中文名，用「、」连起来。 */
	| { names: string[] }
	/** 模型要填的人话格。 */
	| { slot: string };

/** 表头区的一行：「单据  实验室检测单  zlgd_sys_test_bill」。 */
export interface FormLine {
	label: string;
	cells: FormCell[];
}

export interface FormTable {
	columns: string[];
	rows: FormCell[][];
	/** 第一列连续相同时只在第一行显示（数据表：一条数据好几个字段）。 */
	group?: boolean;
}

/** 一个要模型填的人话格。 */
export interface FormSlot {
	key: string;
	/** 这一格填什么，给模型看，也进拒绝语。 */
	hint: string;
}

export interface WriteForm {
	/** 修改类别，例如「新增字段」。 */
	kind: string;
	category: "元数据" | "数据";
	/** 一句话概括，给执行结果和回执用，例如「新增 13 个字段」。 */
	summary: string;
	head: FormLine[];
	tables: FormTable[];
	/** 确认后会发生什么，按类别写死。 */
	impact: string;
	/** 怎么撤回，按类别写死。 */
	undo: string;
	/** 要模型给中文名的标识（小写），按出现顺序。 */
	names: string[];
	/** 探针已经报了名字的标识，不用模型填。 */
	known: Record<string, string>;
	slots: FormSlot[];
}

/** 模型为一项填的值。 */
export interface FormFill {
	purpose: string;
	names: Record<string, string>;
	slots: Record<string, string>;
	note?: string;
}

const OP_TEXT: Readonly<Record<string, string>> = {
	save: "保存",
	submit: "提交",
	audit: "审核",
	unaudit: "反审核",
	unsubmit: "撤销提交",
};

class Builder {
	readonly head: FormLine[] = [];
	readonly tables: FormTable[] = [];
	readonly names: string[] = [];
	readonly known: Record<string, string> = {};
	readonly slots: FormSlot[] = [];

	/** 一个标识的名字格；探针没报过名字的记进要模型填的清单。 */
	name(id: string): FormCell {
		const key = id.trim().toLowerCase();
		if (key !== "" && this.known[key] === undefined && !this.names.includes(key)) this.names.push(key);
		return { name: key };
	}

	nameList(ids: readonly string[]): FormCell {
		return { names: ids.map((id) => (this.name(id) as { name: string }).name) };
	}

	knownName(id: string, name: unknown): void {
		const key = id.trim().toLowerCase();
		if (typeof name !== "string" || name.trim() === "" || key === "") return;
		this.known[key] = name.trim();
		const at = this.names.indexOf(key);
		if (at >= 0) this.names.splice(at, 1);
	}

	/** 「单据  中文名  标识」这种表头行。 */
	object(label: string, id: string): void {
		if (id.trim() === "") return;
		this.head.push({ label, cells: [this.name(id), { text: id.trim() }] });
	}

	line(label: string, value: string): void {
		if (value.trim() !== "") this.head.push({ label, cells: [{ text: value.trim() }] });
	}

	slot(key: string, hint: string): FormCell {
		if (!this.slots.some((slot) => slot.key === key)) this.slots.push({ key, hint });
		return { slot: key };
	}

	build(input: {
		kind: string;
		category: "元数据" | "数据";
		summary: string;
		impact: string;
		undo: string;
	}): WriteForm {
		return {
			...input,
			head: this.head,
			tables: this.tables.filter((table) => table.rows.length > 0),
			names: this.names,
			known: this.known,
			slots: this.slots,
		};
	}
}

const text = (value: string): FormCell => ({ text: value });

function splitList(raw: string | undefined, separator: RegExp = /,/): string[] {
	return (raw ?? "")
		.split(separator)
		.map((item) => item.trim())
		.filter((item) => item !== "");
}

/** `k=v;k=v` → 有序键值对，第一个 `=` 分左右。 */
function pairs(raw: string | undefined): [string, string][] {
	return splitList(raw, /;/)
		.map((item) => {
			const eq = item.indexOf("=");
			return eq <= 0 ? null : ([item.slice(0, eq).trim(), item.slice(eq + 1).trim()] as [string, string]);
		})
		.filter((pair): pair is [string, string] => pair !== null);
}

function str(value: unknown): string {
	return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}

function opsText(raw: string): string {
	return splitList(raw)
		.map((op) => OP_TEXT[op.toLowerCase()] ?? op)
		.join(" → ");
}

// ---------------------------------------------------------------- 元数据

function formRegisterForm(env: Readonly<Record<string, string>>): WriteForm {
	const b = new Builder();
	const removing = env.ROLLBACK === "1";
	b.object("表单", env.REG_FORM ?? "");
	if (removing) {
		b.line("动作", "删除这张表单的功能单元登记（元数据本体不动）");
		return b.build({
			kind: "功能单元登记",
			category: "元数据",
			summary: "删除功能单元登记",
			impact: "开发平台左侧树和搜索里找不到这张表单；运行时照常能用",
			undo: "重新登记一次",
		});
	}
	if ((env.REG_REF ?? "") !== "") b.object("照抄登记位置", env.REG_REF ?? "");
	b.line("功能单元", env.REG_UNIT ?? "");
	b.line("应用", env.REG_APP ?? "");
	return b.build({
		kind: "功能单元登记",
		category: "元数据",
		summary: "登记到功能单元",
		impact: "开发平台左侧树和搜索里能找到这张表单；运行时行为不变",
		undo: "带 ROLLBACK=1 删掉这条登记，元数据本体不动",
	});
}

const RULE_ACT: Readonly<Record<string, [string, string]>> = {
	show: ["显示", "隐藏"],
	lock: ["可编辑", "锁定"],
	control: ["显示面板", "隐藏面板"],
};

function formRuleForm(env: Readonly<Record<string, string>>): WriteForm {
	const b = new Builder();
	b.object("布局", env.RULE_FORM ?? "");
	if ((env.RULE_HOST ?? "") === "") b.line("挂在", env.RULE_BATCH ? "按规则 id 查找宿主" : "表头");
	else b.object("挂在", env.RULE_HOST ?? "");
	const kind = "表单界面规则";
	const category = "元数据";
	if ((env.RULE_BATCH ?? "") !== "") {
		const items = (env.RULE_BATCH ?? "").split(";").map((row) => row.split("|"));
		b.tables.push({
			columns: ["操作", "规则 id", "这条规则管什么", "原条件", "新条件"],
			rows: items.map((item, index) => [
				text(item[0] === "delete" ? "删除" : "修改条件"),
				text(item[1] ?? ""),
				b.slot(`r${String(index + 1)}`, `规则 ${item[1] ?? ""} 管什么，用人话说`),
				text(item[2] ?? ""),
				text(item[3] ?? "（删除整条规则）"),
			]),
		});
		return b.build({
			kind,
			category,
			summary: `批量修改或删除 ${String(items.length)} 条界面规则`,
			impact: "整份清单一起保存；修改条件保留动作，删除规则后其动作不再执行，最终显隐由剩余规则和布局决定",
			undo: "改条件可交换新旧条件后恢复；删除的规则需根据写前记录在设计器中恢复完整动作",
		});
	}
	if ((env.RULE_UPDATE_ID ?? "") !== "") {
		b.line("规则 id", env.RULE_UPDATE_ID ?? "");
		b.tables.push({
			columns: ["", "原来", "改后"],
			rows: [
				[
					text("条件"),
					b.slot("before", "原条件用人话说，例如「检验类型是拉伸试验」"),
					b.slot("after", "新条件用人话说"),
				],
				[text("条件原文"), text(env.RULE_EXPECT_CONDITION ?? ""), text(env.RULE_UPDATE_CONDITION ?? "")],
			],
		});
		return b.build({
			kind,
			category,
			summary: "修改 1 条界面规则的条件",
			impact: "所有人打开这张单据立即按新条件显示/隐藏或锁定；规则的动作不变",
			undo: "把原条件和新条件对调，再跑一次修改条件",
		});
	}
	if ((env.RULE_APPEND ?? "") !== "") {
		const groups = splitList(env.RULE_APPEND, /;/).map((group) => group.split("|").map((part) => part.trim()));
		b.tables.push({
			columns: ["规则 id", "这条规则管什么", "跟着这个字段", "新加的字段"],
			rows: groups.map((group, index) => [
				text(group[0] ?? ""),
				b.slot(
					`r${String(index + 1)}`,
					`规则 ${group[0] ?? ""} 现在管什么，用人话说，例如「选拉伸试验时显示抗拉强度」`,
				),
				b.name(group[1] ?? ""),
				b.nameList(splitList(group[2])),
			]),
		});
		const added = groups.reduce((sum, group) => sum + splitList(group[2]).length, 0);
		return b.build({
			kind,
			category,
			summary: `往 ${String(groups.length)} 条既有界面规则里追加 ${String(added)} 个字段`,
			impact: "新加的字段跟着原字段一起显示/隐藏或锁定；规则的条件和条数不变",
			undo: "没有一键撤回：要在设计器里把新加的字段从这些规则的动作里删掉",
		});
	}
	const removeIds = splitList(env.RULE_REMOVE_IDS);
	if (env.ROLLBACK === "1") {
		b.line("描述前缀", env.RULE_TAG ?? "");
		b.tables.push({
			columns: ["规则 id", "这条规则管什么"],
			rows: removeIds.map((id, index) => [text(id), b.slot(`r${String(index + 1)}`, `规则 ${id} 管什么，用人话说`)]),
		});
		return b.build({
			kind,
			category,
			summary: `摘掉 ${String(removeIds.length)} 条界面规则`,
			impact: "这些规则管的字段不再按条件显示/隐藏或锁定，一律按设计器里的默认状态",
			undo: "用原来的参数重新新增这些规则",
		});
	}
	const [on, off] = RULE_ACT[(env.RULE_ACT ?? "show").toLowerCase()] ?? RULE_ACT.show ?? ["显示", "隐藏"];
	const groups = splitList(env.RULE_GROUPS, /;/).map((group) => group.split("|").map((part) => part.trim()));
	b.line("动作", `条件成立${on}，不成立${off}`);
	b.line("描述前缀", env.RULE_TAG ?? "");
	if (removeIds.length > 0) b.line("同时摘掉", removeIds.join("、"));
	b.tables.push({
		columns: ["规则", "什么时候", "管的字段", "条件原文"],
		rows: groups.map((group, index) => [
			text(group[0] ?? ""),
			b.slot(`g${String(index + 1)}`, `规则「${group[0] ?? ""}」的条件用人话说，例如「检验项目选 JCXM-01」`),
			b.nameList(splitList(group[2])),
			text(group[1] ?? ""),
		]),
	});
	return b.build({
		kind,
		category,
		summary: `新增 ${String(groups.length)} 条界面规则`,
		impact: `所有人打开这张单据立即生效：条件成立时字段${on}，不成立时${off}`,
		undo: `按描述前缀「${env.RULE_TAG ?? ""}」摘掉这 ${String(groups.length)} 条规则`,
	});
}

/**
 * 原位改一条已有业务规则（`BIZ_RULE`）。入参里只有改后；改前、规则名、宿主只取探针按项报的 `t=biz-rule-change`，
 * 预演没报就明说，不拿入参顶替。
 */
function bizRuleEditForm(env: Readonly<Record<string, string>>, records: readonly ProbeJsonRecord[]): WriteForm {
	const b = new Builder();
	const rule = env.BIZ_RULE ?? "";
	const changes = records.filter((record) => record.t === "biz-rule-change");
	const name = str(changes[0]?.name);
	b.object("实体", env.BIZ_ENTITY ?? "");
	if (str(changes[0]?.host) !== "") b.object("挂在", str(changes[0]?.host));
	b.line("规则", name === "" ? `id ${rule}` : `${name}（id ${rule}）`);
	if ((env.BIZ_CONDITION ?? "") !== "")
		b.head.push({
			label: "改后的条件",
			cells: [b.slot("condition", "改后的条件用人话说，例如「组织是 0101 或 0301，且勾了去包覆层」")],
		});
	b.tables.push({
		columns: ["改哪一项", "改前", "改后"],
		rows:
			changes.length > 0
				? changes.map((record) => [
						text(str(record.item)),
						text(str(record.before) === "" ? "（空）" : str(record.before)),
						text(str(record.after)),
					])
				: [[text("（预演没报）"), text("—"), text("—")]],
	});
	const items = changes.map((record) => str(record.item));
	return b.build({
		kind: "业务规则",
		category: "元数据",
		summary: `改业务规则「${name === "" ? rule : name}」的${items.length > 0 ? items.join("、") : "内容"}`,
		impact: "所有人录单时立即按改后的条件、公式自动计算、赋值；还是原来那条规则，设计器里看到的就是改后的样子",
		undo: `用同一个 BIZ_RULE=${rule} 把这几项改回「改前」那一列`,
	});
}

function bizRuleForm(env: Readonly<Record<string, string>>, records: readonly ProbeJsonRecord[]): WriteForm {
	if ((env.BIZ_RULE ?? "") !== "") return bizRuleEditForm(env, records);
	const b = new Builder();
	b.object("实体", env.BIZ_ENTITY ?? "");
	if ((env.BIZ_HOST ?? "") !== "") b.object("挂在", env.BIZ_HOST ?? "");
	const tag = env.BIZ_TAG ?? "";
	if (env.ROLLBACK === "1") {
		b.line("摘掉", `描述以「${tag}」开头的业务规则`);
		return b.build({
			kind: "业务规则",
			category: "元数据",
			summary: "摘掉业务规则",
			impact: "这些规则不再自动计算、赋值",
			undo: "用原来的参数重新新增",
		});
	}
	b.line("规则名", `${tag}${env.BIZ_NAME ?? ""}`);
	const rows: FormCell[][] = [
		[text("条件"), b.slot("condition", "条件用人话说，例如「数量和单价都填了」"), text(env.BIZ_CONDITION ?? "")],
	];
	if ((env.BIZ_TRUE ?? "") !== "") {
		rows.push([
			text("成立时"),
			b.slot("true", "条件成立时做什么，用人话说，例如「金额 = 数量 × 单价」"),
			text(env.BIZ_TRUE ?? ""),
		]);
	}
	if ((env.BIZ_FALSE ?? "") !== "") {
		rows.push([text("不成立时"), b.slot("false", "条件不成立时做什么，用人话说"), text(env.BIZ_FALSE ?? "")]);
	}
	b.tables.push({ columns: ["", "说明", "原文"], rows });
	return b.build({
		kind: "业务规则",
		category: "元数据",
		summary: `新增业务规则「${tag}${env.BIZ_NAME ?? ""}」`,
		impact: "所有人录单时立即按这条规则自动计算、赋值；描述前缀相同的旧规则会被替换掉",
		undo: `带 ROLLBACK=1 按描述前缀「${tag}」摘掉`,
	});
}

/** `SYNC_FIELDMAP` 一项的取值写成人话；前缀的认法和 BotpRuleSyncProbe.parseFieldMap 一致。 */
function botpMappingText(value: string): string {
	if (value.toLowerCase() === "clear") return "清掉映射（下推时不取值）";
	if (value.startsWith("src:")) return `取源单字段 ${value.slice(4).trim()}`;
	if (value.startsWith("const:")) return `常量（基础资料）${value.slice(6).trim()}`;
	if (value.startsWith("formula:")) return `公式 ${value.slice(8).trim()}`;
	return `公式 ${value}`;
}

/**
 * 改建行层级（`SYNC_LINK`）那几张表。改前是什么、上下游关联记在哪、改后哪些映射逐行取值，入参里都没有，
 * 只取探针按规则报的 `t=botp-link` 记录；预演没报就明说，不拿入参顶替。
 */
function botpLinkTables(b: Builder, records: readonly ProbeJsonRecord[]): string[] {
	const links = records.filter((record) => record.t === "botp-link");
	const linked = (value: unknown): string => (str(value) === "" ? "不记" : `记在 ${str(value)}`);
	b.tables.push({
		columns: ["规则 id", "源单建行", "目标单建行", "上下游关联"],
		rows:
			links.length > 0
				? links.map((record) => [
						text(str(record.rule)),
						text(`${str(record.sourceBefore)} → ${str(record.sourceAfter)}`),
						text(`${str(record.targetBefore)} → ${str(record.targetAfter)}`),
						text(`${linked(record.linkBefore)} → ${linked(record.linkAfter)}`),
					])
				: [[text("（预演没报）"), text("—"), text("—"), text("—")]],
	});
	const list = (value: unknown): string[] => (Array.isArray(value) ? value.map((one) => str(one)) : []);
	b.tables.push({
		columns: ["规则 id", "改后逐行取值的映射"],
		rows: links.flatMap((record) => {
			const rows = list(record.rows);
			return (rows.length > 0 ? rows : ["（一条都没有）"]).map((row) => [text(str(record.rule)), text(row)]);
		}),
		group: true,
	});
	return links.map((record) => {
		const others = list(record.others);
		const plugins = list(record.plugins);
		return (
			`规则 ${str(record.rule)} 下推时按源单${str(record.sourceAfter)}的每一行在目标单${str(record.targetAfter)}上建一行` +
			`（逐行取值 ${String(list(record.rows).length)} 条、表头 ${str(record.head)} 条、其他位置 ${String(others.length)} 条）` +
			(plugins.length > 0 ? `，启用的转换插件 ${String(plugins.length)} 个照旧执行：${plugins.join("、")}` : "")
		);
	});
}

/**
 * 改源单过滤（`SYNC_FILTER`）、执行条件（`SYNC_RUN_CONDITION`）那张表。改前是平台把条件行和公式拼好的那一条，
 * 入参里没有，只取探针按规则报的 `t=botp-condition`；预演没报就明说。返回要并进影响那一句的话。
 */
function botpConditionTable(
	b: Builder,
	env: Readonly<Record<string, string>>,
	records: readonly ProbeJsonRecord[],
): string[] {
	const parts: [string, string][] = [
		["源单过滤", env.SYNC_FILTER ?? ""],
		["执行条件", env.SYNC_RUN_CONDITION ?? ""],
	];
	const asked = parts.filter(([, value]) => value.trim() !== "");
	if (asked.length === 0) return [];
	for (const [part, value] of asked)
		b.line(`${part}改成`, value.trim().toLowerCase() === "clear" ? "清掉，不再限制" : value.trim());
	if (asked.some(([, value]) => value.trim().toLowerCase() !== "clear"))
		b.head.push({
			label: "改后的条件",
			cells: [b.slot("condition", "改后的条件用人话说，例如「源单组织是 0101、0102 或 0301，且已审核」")],
		});
	const changes = records.filter((record) => record.t === "botp-condition");
	b.tables.push({
		columns: ["规则 id", "哪一处", "改前（下推时实际生效的条件）", "改后"],
		rows:
			changes.length > 0
				? changes.map((record) => [
						text(str(record.rule)),
						text(str(record.part)),
						text(str(record.before) === "" ? "（没有）" : str(record.before)),
						text(str(record.after) === "" ? "（清掉，不再限制）" : str(record.after)),
					])
				: [[text("（预演没报）"), text("—"), text("—"), text("—")]],
	});
	return [
		`下推、选单时按改后的${asked.map(([part]) => part).join("、")}挑源单；设计器里这一处以后显示成一条公式，原来的条件行清空`,
	];
}

function botpForm(
	env: Readonly<Record<string, string>>,
	targets: readonly string[],
	records: readonly ProbeJsonRecord[],
): WriteForm {
	const b = new Builder();
	const rules = targets.filter((target) => target.startsWith("botp:")).map((target) => target.slice("botp:".length));
	const ruleTable = (): FormTable => ({
		columns: ["转换规则", "规则 id"],
		rows: rules.map((id) => [b.name(id), text(id)]),
	});
	if ((env.SYNC_RESTORE ?? "") !== "") {
		b.line("备份目录", env.SYNC_RESTORE ?? "");
		b.tables.push(ruleTable());
		return b.build({
			kind: "BOTP 转换规则",
			category: "元数据",
			summary: `把 ${String(rules.length)} 条转换规则写回备份`,
			impact: "这些转换规则恢复成备份时的内容，下推立即按备份里的配置走",
			undo: "写回之前不会另存当前内容；需要的话先导一份备份",
		});
	}
	if ((env.SYNC_SRC ?? "") !== "") {
		b.head.push({ label: "复制业务规则自", cells: [b.name(env.SYNC_SRC ?? ""), text(env.SYNC_SRC ?? "")] });
		b.line("已有业务规则时", (env.SYNC_ON_EXIST ?? "skip") === "replace" ? "覆盖" : "跳过");
	}
	b.tables.push(ruleTable());
	const mapping = pairs(env.SYNC_FIELDMAP);
	if (mapping.length > 0) {
		b.tables.push({
			columns: ["目标字段", "标识", "改成"],
			rows: mapping.map(([field, value]) => [b.name(field), text(field), text(botpMappingText(value))]),
		});
	}
	const link = env.SYNC_LINK ?? "";
	if (link !== "") b.line("建行层级改成", link);
	const linkImpact = link === "" ? [] : botpLinkTables(b, records);
	const conditionImpact = botpConditionTable(b, env, records);
	return b.build({
		kind: "BOTP 转换规则",
		category: "元数据",
		summary: `改 ${String(rules.length)} 条转换规则`,
		impact: ["用这些规则下推时立即按新配置取值", ...linkImpact, ...conditionImpact].join("；"),
		undo: "执行时先把改前原文存进备份目录，用「BOTP 还原」写回",
	});
}

/**
 * 打印模板的确认单。三种改法各一张表，事实全部来自探针比出来的记录。
 *
 * 整份提交和整份恢复交上去的是一整份设计数据，入参里只有一条文件路径——「改了什么」只能由
 * 探针按控件 id 比出来（`t=tpl-change`），模型说了不算（S23、S32 §4.4）。公式改动再多带一张
 * 试算表（`t=tpl-formula`）：确认单要回答的是「这一格以后显示什么」，光给一串片段没人读得出来。
 */
function printTplForm(env: Readonly<Record<string, string>>, records: readonly ProbeJsonRecord[]): WriteForm {
	const restoring = (env.TPL_RESTORE ?? "") !== "";
	if (restoring || (env.TPL_FILE ?? "") !== "") return wholeTplForm(env, records, restoring);
	const b = new Builder();
	b.object("模板", env.TPL_NUMBER ?? "");
	const sets = records.filter((record) => record.t === "tpl-set");
	const rows: FormCell[][] =
		sets.length > 0
			? sets.map((record) => [
					text(str(record.control)),
					text(str(record.prop)),
					text(str(record.before)),
					text(str(record.after)),
				])
			: pairs(env.TPL_SET).map(([path, value]) => {
					const dot = path.indexOf(".");
					return [text(path.slice(0, dot)), text(path.slice(dot + 1)), text("（预演没报）"), text(value)];
				});
	b.tables.push({ columns: ["控件", "属性", "原值", "新值"], rows, group: true });
	return b.build({
		kind: "打印模板",
		category: "元数据",
		summary: `改打印模板 ${String(rows.length)} 处属性`,
		impact: "所有人打印这张模板立即按新样式出",
		undo: "执行时先把改前的模板存进备份目录，用它写回",
	});
}

/** 整份提交 / 整份恢复：改了什么由 `t=tpl-change` 说，公式显示成什么由 `t=tpl-formula` 说。 */
function wholeTplForm(
	env: Readonly<Record<string, string>>,
	records: readonly ProbeJsonRecord[],
	restoring: boolean,
): WriteForm {
	const b = new Builder();
	b.object("模板", env.TPL_NUMBER ?? "");
	b.line(restoring ? "恢复自备份目录" : "整份提交", restoring ? (env.TPL_RESTORE ?? "") : (env.TPL_FILE ?? ""));
	const changes = records.filter((record) => record.t === "tpl-change");
	b.tables.push({
		columns: ["控件", "改哪里", "原来", "改后"],
		rows:
			changes.length > 0
				? changes.map((record) => [
						text(str(record.owner)),
						text(str(record.path)),
						text(str(record.before)),
						text(str(record.after)),
					])
				: [[text("（预演没报）"), text("—"), text("—"), text("—")]],
		group: true,
	});
	const formulas = records.filter((record) => record.t === "tpl-formula");
	if (formulas.length > 0) {
		b.tables.push({
			columns: ["控件", "公式", "什么时候", "显示成"],
			rows: formulas.map((record) => [
				text(str(record.control)),
				text(str(record.formula)),
				text(str(record.case)),
				text(str(record.shown)),
			]),
			group: true,
		});
	}
	return b.build({
		kind: "打印模板",
		category: "元数据",
		summary: restoring
			? `把打印模板恢复成备份里那份（${String(changes.length)} 处退回）`
			: `整份改写打印模板（${String(changes.length)} 处差异）`,
		impact: "所有人打印这张模板立即按新的出",
		undo: "执行时先把改前的模板存进备份目录，用 meta ptpl restore <编码> <那个目录> 整份写回",
	});
}

/**
 * 单据布局（S42）：改了什么由探针把改前改后逐元素、逐属性比出来（`t=layout-change`）。
 * 入参里的改动清单是模型写的指令，不当事实用；整份恢复的入参只有一个目录，更只能靠比。
 * 没点名、只是被挤得顺延序号的控件合成一行（`t=layout-shift`），不然挪一个控件能列出几十行序号。
 */
function layoutForm(env: Readonly<Record<string, string>>, records: readonly ProbeJsonRecord[]): WriteForm {
	const b = new Builder();
	const restoring = (env.LAYOUT_RESTORE ?? "") !== "";
	b.object("布局", env.LAYOUT_FORM ?? "");
	if (restoring) b.line("恢复自备份目录", env.LAYOUT_RESTORE ?? "");
	const changes = records.filter((record) => record.t === "layout-change");
	const shifted = Number(records.find((record) => record.t === "layout-shift")?.count ?? 0);
	if (shifted > 0) b.line("顺延", `另有 ${String(shifted)} 个控件序号顺延`);
	// 新增、删除、挂摘插件那一侧本来就没有东西，写「—」；属性改回默认才写「（默认）」
	const whole = new Set(["（新增）", "（删除）", "插件"]);
	const shown = (record: ProbeJsonRecord, value: unknown): string =>
		str(value) !== "" ? str(value) : whole.has(str(record.prop)) ? "—" : "（默认）";
	b.tables.push({
		columns: ["元素", "改哪里", "原来", "改后"],
		rows:
			changes.length > 0
				? changes.map((record) => [
						text(elementLabel(str(record.scope), str(record.element))),
						text(str(record.prop)),
						text(shown(record, record.before)),
						text(shown(record, record.after)),
					])
				: [[text("（预演没报）"), text("—"), text("—"), text("—")]],
		group: true,
	});
	const onEntity = changes.some(
		(record) => record.scope === "字段" || record.scope === "分录" || record.scope === "操作",
	);
	// 字段的新增、删除连着业务表：加的落库时表里加一列，删的列和数据都留在表里
	const fields = (prop: string): number =>
		changes.filter((record) => record.scope === "字段" && record.prop === prop).length;
	const addedFields = fields("（新增）");
	const removedFields = fields("（删除）");
	// 新分录连着的是一整张表：探针核对过表名（`t=layout-entry-table`），新建还是接着用库里留下的，照它报的说
	const tables = records.filter((record) => record.t === "layout-entry-table");
	const newTables = tables.filter((record) => record.existing !== true).map((record) => str(record.table));
	const keptTables = tables.filter((record) => record.existing === true).map((record) => str(record.table));
	// 派生布局由探针按继承路径查出来（`t=layout-heirs`），模型不用猜它们要不要逐张再改
	const heirs = records.find((record) => record.t === "layout-heirs");
	// layouts= 只列了部分布局的新控件（`t=layout-scope`）：探针按派生布局清单算好在哪几张显示
	const scope = records.find((record) => record.t === "layout-scope");
	const impact = [
		"所有人打开这张单据立即按新的显示",
		...(onEntity ? ["标了（字段）（分录）（操作）的改在实体上，这张单据的每个布局都跟着变"] : []),
		...(heirs === undefined
			? []
			: [`派生布局 ${str(heirs.count)} 张跟着变（它们自己改过的属性不变）：${str(heirs.forms)}`]),
		...(scope === undefined ? [] : [`只在部分布局显示（其余布局上是隐藏元素）：${str(scope.items)}`]),
		...(newTables.length > 0 ? [`新建业务表 ${newTables.join("、")}`] : []),
		...(keptTables.length > 0
			? [`新分录接着用库里已有的表 ${keptTables.join("、")}（以前建过同名分录留下的，表里原有的行还在）`]
			: []),
		...(addedFields > 0 ? [`业务表加 ${String(addedFields)} 列`] : []),
		...(removedFields > 0 ? [`删掉的 ${String(removedFields)} 个字段界面上没了，数据库里的列和数据留着`] : []),
	];
	return b.build({
		kind: "单据布局",
		category: "元数据",
		summary: restoring
			? `把单据布局恢复成备份里那份（${String(changes.length)} 处退回）`
			: `改单据布局 ${String(changes.length)} 处`,
		impact: impact.join("；"),
		undo:
			"执行时先把改前的布局存进备份目录，用 LAYOUT_RESTORE=<那个目录> 整份写回" +
			(addedFields > 0 ? "；新加字段的列写回后还留在表里，没人用" : "") +
			(newTables.length > 0 ? "；新建的分录表写回后还留在库里，没人用" : ""),
	});
}

/** 布局里的控件不加标注；字段、操作、内嵌的列表和移动端布局各标一句，免得和同名控件混。 */
function elementLabel(scope: string, element: string): string {
	const nested: Record<string, string> = {
		字段: "字段",
		分录: "分录",
		操作: "操作",
		"布局 ListMeta": "列表布局",
		"布局 MobMeta": "移动端布局",
		"布局 MobListMeta": "移动列表布局",
	};
	const tag = nested[scope];
	return tag === undefined ? element : `${element}（${tag}）`;
}

// ---------------------------------------------------------------- 数据

function dataEntity(b: Builder, entity: string, records: readonly ProbeJsonRecord[]): void {
	const named = records.find((record) => record.t === "data-entity");
	if (named !== undefined) b.knownName(entity, named.name);
	b.object("单据", entity);
}

function seedForm(env: Readonly<Record<string, string>>, records: readonly ProbeJsonRecord[]): WriteForm {
	const b = new Builder();
	const entity = env.SEED_ENTITY ?? "";
	dataEntity(b, entity, records);
	const fields = records.filter((record) => record.t === "seed-field");
	let rows: FormCell[][];
	let count: number;
	if (fields.length > 0) {
		rows = fields.map((record) => [text(str(record.label)), text(str(record.name)), text(str(record.value))]);
		count = new Set(fields.map((record) => str(record.label))).size;
	} else {
		const specs =
			(env.SEED_ROWS ?? "").trim() === ""
				? [{ label: "1", set: env.SEED_SET ?? "" }]
				: (env.SEED_ROWS ?? "").split(/\r?\n/).reduce<{ label: string; set: string }[]>((out, raw) => {
						const line = raw.trim();
						if (line.startsWith("[row]")) out.push({ label: line.slice(5).trim(), set: "" });
						else if (line.startsWith("set=") && out.length > 0)
							(out.at(-1) as { set: string }).set = line.slice(4);
						return out;
					}, []);
		rows = specs.flatMap((spec) =>
			pairs(spec.set).map(([field, value]) => [text(spec.label), b.name(field), text(value)]),
		);
		count = specs.length;
	}
	// 照现成的复制、从上游下推时，表里只有这次另设的字段；带过来的值从哪来要在单子上写明
	const copies = records.filter((record) => record.t === "seed-copy");
	const templates = [...new Set(copies.map((record) => str(record.template)))];
	const copyFrom = templates.length > 0 ? templates.join("、") : (env.SEED_COPY ?? "").trim();
	if (copyFrom !== "") b.line("照着复制", `${copyFrom}（按字段的「是否复制」带值，下表只列这次另设的）`);
	const pushed = records.find((record) => record.t === "seed-from");
	if (pushed !== undefined) {
		b.line(
			"从上游下推",
			`${str(pushed.name)} ${str(pushed.source)}：${str(pushed.bills)}，规则「${str(pushed.rule)}」`,
		);
		count = Number(str(pushed.count)) || count;
	} else if ((env.SEED_FROM ?? "").trim() !== "") {
		const rule = (env.SEED_RULE ?? "").trim();
		b.line(
			"从上游下推",
			`${(env.SEED_FROM ?? "").trim()}${rule === "" ? "" : `，规则「${rule}」`}（推出几条造几条）`,
		);
	}
	b.line("操作", opsText(env.SEED_OPS ?? "save"));
	b.line("条数", `${String(count)} 条`);
	b.tables.push({ columns: ["第几条", "字段", "值"], rows, group: true });
	return b.build({
		kind: "造测试数据",
		category: "数据",
		summary: `新建 ${String(count)} 条数据`,
		impact: `共享环境多出 ${String(count)} 条数据，别人也看得到；本工具不自动清理`,
		undo: "按造数结果里列出的编号到单据列表里删除",
	});
}

function updateForm(env: Readonly<Record<string, string>>, records: readonly ProbeJsonRecord[]): WriteForm {
	const b = new Builder();
	const entity = env.UPD_ENTITY ?? "";
	dataEntity(b, entity, records);
	const direct = (env.UPD_OP ?? "").toLowerCase() === "direct";
	const changes = records.filter((record) => record.t === "data-change");
	const count = new Set(changes.map((record) => str(record.pk))).size;
	b.line("保存方式", direct ? "直接存库（不走校验器和插件）" : `${opsText(env.UPD_OP ?? "save")}（校验器和插件照跑）`);
	b.line("条数", `${String(count)} 条`);
	b.tables.push({
		columns: ["编号", "字段", "原值", "新值"],
		rows: changes.map((record) => [
			text(str(record.label)),
			text(str(record.name)),
			text(str(record.before)),
			text(str(record.after)),
		]),
		group: true,
	});
	return b.build({
		kind: "修改数据",
		category: "数据",
		summary: `修改 ${String(count)} 条数据`,
		impact: direct
			? "直接存库，不走校验器和插件；别人看到的数据立即变"
			: "走单据的保存，校验器和插件照跑；别人看到的数据立即变",
		undo: "按上表的原值再改回去（改数结果里保留原值）",
	});
}

function genericForm(probe: string, env: Readonly<Record<string, string>>, targets: readonly string[]): WriteForm {
	const b = new Builder();
	b.line("写入目标", targets.join("、"));
	b.tables.push({
		columns: ["参数", "值"],
		rows: Object.entries(env)
			.filter(([key, value]) => key !== "APPLY" && value !== "")
			.map(([key, value]) => [text(key), text(value.replace(/\r?\n/g, " / "))]),
	});
	b.slot("change", "改什么，用人话说");
	b.slot("after", "改完用户能看到什么效果");
	return b.build({
		kind: probe,
		category: "元数据",
		summary: probe,
		impact: "确认后立即写进共享环境",
		undo: "见 dry-run 输出",
	});
}

/**
 * 按写探针和它 dry-run 的入参、探针报的记录、写入目标，生成这一项的确认单表单。
 *
 * 入参就是这次写入的全部依据（指纹由它算），所以从入参排出来的表就是会写进去的东西；原值、
 * 显示名这类入参里没有的，只取探针自己报的 JSON 记录，不从中文输出里抠。
 */
export function buildWriteForm(input: {
	probe: string;
	env: Readonly<Record<string, string>>;
	records: readonly ProbeJsonRecord[];
	targets: readonly string[];
}): WriteForm {
	const { probe, env, records, targets } = input;
	switch (probe) {
		case "FormRegisterProbe":
			return formRegisterForm(env);
		case "FormRuleProbe":
			return formRuleForm(env);
		case "BizRuleProbe":
			return bizRuleForm(env, records);
		case "BotpRuleSyncProbe":
			return botpForm(env, targets, records);
		case "PrintTplWriteProbe":
			return printTplForm(env, records);
		case "FormLayoutWriteProbe":
			return layoutForm(env, records);
		case "DataSeedProbe":
			return seedForm(env, records);
		case "DataUpdateProbe":
			return updateForm(env, records);
		default:
			return genericForm(probe, env, targets);
	}
}
