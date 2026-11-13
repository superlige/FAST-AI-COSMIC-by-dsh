/**
 * 元数据写探针的统一声明（S18）。
 *
 * 一段话看懂：苍穹共享环境里能改元数据的已发布探针一共 6 个，这里把它们列成一张表，
 * 并规定三件事——它们按平台档跑（不被别人没编译的 Java 拦）、什么样的输出才算「dry-run
 * 算出了一份计划」、同一个操作的指纹怎么算。以前这三件事分散在 `cosmic_meta` 的解析器和
 * `READ_MODES` 两张名单里，结果同一个能力换个入口，状态机的反应就不一样。
 *
 * 为什么是这 6 个、为什么可以放平台档：
 *   - 已发布探针里调用写 API（MetadataWriter / ConvertRuleWriter / updatePrintMeta /
 *     SaveServiceHelper / DeleteServiceHelper）又读 APPLY 的，正好是这 6 个；OpSandbox
 *     也碰 OperationServiceHelper，但它走回滚事务、不读 APPLY，不是元数据写入。
 *     `test/kernel/write-plan.test.ts` 从源码里重新数一遍，多一个少一个都会红。
 *   - 它们（连同共用的 MetaResolve / IsvGuard）不加载任何业务类，也不进表单、列表、
 *     操作、打印引擎。陈旧类门禁防的是「探针链到旧业务类、静默跑出错答案」，对它们
 *     不成立。2026-09-11 用户决定：纯元数据改动不再为无关的未编译 Java 买单。
 *
 * 为什么用「dry-run 结束」那一行当凭据，而不是退出码：BotpRuleSyncProbe 在「没选中任何
 * 目标规则，中止」时退出码也是 0，FormRegisterProbe「已经登记过了」也是 0。只看退出码，
 * 一次什么都没算出来的 dry-run 也会被当成待确认的计划。6 个探针每条 dry-run 成功路径
 * 都会打一行 `[PROBE] dry-run 结束…`（BOTP 还原是 `[PROBE] dry-run：…`），中止路径不打，
 * 测试把这一点也钉在源码上。
 *
 * APPLY 那一侧同理（S18 修正）：打印模板「基线已变，中止」「平台校验不通过，中止」、BOTP
 * 「保存失败，中止后续规则」、字段类 `save -> {success=false…}` 都是退出码 0。只看退出码，
 * 没写成的会被记成写成，回执照样列成「已改」。所以落库成功也要看探针自己打的那一行。
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

/** 写探针 → 给人看的修改类别（授权报告和回执里用）。 */
export const METADATA_WRITERS: Readonly<Record<string, string>> = {
	BizRuleProbe: "业务规则",
	BotpRuleSyncProbe: "BOTP 转换规则",
	FormLayoutWriteProbe: "单据布局",
	FormRegisterProbe: "功能单元登记",
	FormRuleProbe: "表单界面规则",
	PrintTplWriteProbe: "打印模板",
};

export function isMetadataWriter(cls: string): boolean {
	return Object.hasOwn(METADATA_WRITERS, cls);
}

/**
 * 往共享环境写**业务数据**的已发布探针（S21）→ 给人看的修改类别。
 *
 * 和上面 6 个分开登记，因为三件事对它们正好相反：
 *   - 它要跑单据的操作链，会加载业务插件，所以按严格档跑（工程要编译到最新），不能进平台档；
 *   - 它写的不是元数据，交付时不能因为「写成了一项」就被当成纯元数据交付、改出交用户验收回执；
 *   - 写入目标是 `data:<单据>`，不是实体本身。
 * S27 起（用户 2026-09-19 定：测试环境）流程也和元数据分开了：不记计划、不用确认，APPLY=1 在常驻
 * 进程里直接落库，写入记录照样进回执（编号 D1、D2…）。
 */
export const DATA_WRITERS: Readonly<Record<string, string>> = {
	DataSeedProbe: "造测试数据",
	// S23：改已有数据。流程、档位、写入目标和造数完全一样；多出来的只有「改前快照」这一道（见 dataBaseline）。
	DataUpdateProbe: "修改数据",
};

export function isDataWriter(cls: string): boolean {
	return Object.hasOwn(DATA_WRITERS, cls);
}

/**
 * 造数据、改数据默认直接落库，`PREVIEW=1` 才只预演（S37 批 8，2026-09-28）。
 *
 * 预演是回滚事务：常驻进程的缓存回滚不了，只能起冷进程，每次 40～93 秒；事务后才跑的插件在里面也看不准
 *（造数落库同批改成按平台自己的事务逐条提交，见 DataSeedProbe），存不进去落库时照样当场报出来。以前不带 `APPLY` 就是预演，模型每次先预演再落库：
 * 09-28 复测 7 次预演约 6 分钟，落库 3 次走常驻 7～39 秒。`APPLY=1` 照旧认，写不写都落库。
 */
export function dataWriteOverlay(overlay: Readonly<Record<string, string>>): Record<string, string> {
	const out = { ...overlay };
	if (out.PREVIEW === "1") delete out.APPLY;
	else out.APPLY = "1";
	return out;
}

/** 走「dry-run → 一次确认 → 按清单落库」这套流程的全部已发布写探针：元数据 6 个 + 测试数据。 */
export function isSharedWriter(cls: string): boolean {
	return isMetadataWriter(cls) || isDataWriter(cls);
}

/** 修改类别，不是写探针时为 null。 */
export function writerKind(cls: string): string | null {
	if (Object.hasOwn(METADATA_WRITERS, cls)) return METADATA_WRITERS[cls] as string;
	return Object.hasOwn(DATA_WRITERS, cls) ? (DATA_WRITERS[cls] as string) : null;
}

/** 写探针 dry-run 成功结束时打的那一行。 */
const DRY_RUN_DONE = /\[PROBE\] dry-run[ ：]/;

/**
 * 这次运行是不是「一次算出了计划的 dry-run」：写元数据的探针、没带 APPLY、退出码 0、输出里有结束行。
 *
 * 读模式（FormRuleProbe / BizRuleProbe 不带写入参）、中止、无事可做都不打结束行，因此都不算。
 * 造数据、改数据的预演 S27 起不算：写数据不用确认（用户 2026-09-19 定），没有「待确认」可记。
 */
export function isPlannedDryRun(input: {
	cls: string;
	adHoc: boolean;
	env: Readonly<Record<string, string>>;
	exitCode: number;
	output: string;
}): boolean {
	return (
		!input.adHoc &&
		isMetadataWriter(input.cls) &&
		input.env.APPLY !== "1" &&
		input.exitCode === 0 &&
		DRY_RUN_DONE.test(input.output)
	);
}

/**
 * 真落库时探针要求一起给的备份目录：APPLY 前把改前原文存进去，不给就中止。
 *
 * 它只决定改前快照存在本机哪里，不改写进共享环境的内容，所以不进指纹。探针自己的 dry-run
 * 结束行就是「确认无误后加 APPLY=1 和 TPL_BACKUP=<目录>」——照着做的人 dry-run 时没给、
 * APPLY 时才给，指纹要是算进它，清单里那一项就永远对不上。
 */
const BACKUP_KEYS: Readonly<Record<string, string>> = {
	PrintTplWriteProbe: "TPL_BACKUP",
	BotpRuleSyncProbe: "SYNC_BACKUP",
	FormLayoutWriteProbe: "LAYOUT_BACKUP",
};

/**
 * 只在预演里起作用的入参：候选试算的字段值、要看的控件、真单预览的单据（S36 批 5）。
 *
 * 它们决定预演时拿什么数据试一次，不改写进共享环境的内容，所以和备份目录一样不进指纹：
 * 预演带着 RULE_SET 试过、APPLY 时不带，是同一个写操作。APPLY 那一次探针也不读它们。
 */
const TRIAL_KEYS: Readonly<Record<string, readonly string[]>> = {
	FormRuleProbe: ["RULE_SET", "RULE_SHOW", "RULE_ROW", "RULE_SCENE", "RULE_BRANCH"],
	BizRuleProbe: ["RULE_SET", "RULE_SHOW", "RULE_ROW"],
	PrintTplWriteProbe: ["PRINT_PK", "PRINT_SHOW"],
};

/**
 * APPLY 缺的备份目录入参名；不缺、或这个探针不要备份时为 null。
 *
 * BOTP 还原（SYNC_RESTORE）本身就是把备份写回去，探针不要求另给备份。在进内核之前查，
 * 缺了就当参数错误拒掉——不然探针打一行「中止」退出码 0，清单里那一项白白用掉。
 */
export function missingBackup(probe: string, env: Readonly<Record<string, string>>): string | null {
	if (!Object.hasOwn(BACKUP_KEYS, probe)) return null;
	if (probe === "BotpRuleSyncProbe" && (env.SYNC_RESTORE ?? "") !== "") return null;
	const key = BACKUP_KEYS[probe] as string;
	return (env[key] ?? "") === "" ? key : null;
}

/**
 * 备份目录落在工程的某个 `build/` 下时，给出入参名和那个目录；不在、或这个探针不要备份时为 null。
 *
 * 备份是改坏之后唯一的退路，而 Gradle clean 会把整个 `build/` 连同里面的备份一起删掉。
 * 目录按工程根解析（探针进程的工作目录就是工程根）；解析到工程外的不管——那里没有 Gradle 会去清。
 */
export function backupInBuild(
	probe: string,
	env: Readonly<Record<string, string>>,
	projectRoot: string,
): { key: string; dir: string } | null {
	if (!Object.hasOwn(BACKUP_KEYS, probe)) return null;
	const key = BACKUP_KEYS[probe] as string;
	const dir = (env[key] ?? "").trim();
	if (dir === "") return null;
	const inside = relative(resolve(projectRoot), resolve(projectRoot, dir));
	if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) return null;
	return inside.split(/[\\/]+/).some((segment) => segment.toLowerCase() === "build") ? { key, dir } : null;
}

/**
 * 写探针真落库成功时打的那一行，每个探针一种说法。只在落库那条路的最后打，中止路径都不打。
 * `test/kernel/write-plan.test.ts` 核对每一行在探针源码里真实存在。
 */
const APPLIED: Readonly<Record<string, RegExp>> = {
	BizRuleProbe: /\[PROBE\] rebuildRuntimeMetaById\(.*\) 完成/,
	BotpRuleSyncProbe: /\[PROBE\] 已(?:写入|还原) [1-9]\d* 条并清缓存/,
	// 保存成功、刷新运行态之后才打；平台没存上（success 不是 true）走「库里还是改前那份」，不打。
	FormLayoutWriteProbe: /\[PROBE\] 布局已落库：/,
	FormRegisterProbe: /\[PROBE\] (?:登记行已写入|已删除 [1-9]\d* 行)/,
	FormRuleProbe: /\[PROBE\] rebuildRuntimeMetaById\(.*\) 完成/,
	PrintTplWriteProbe: /\[PROBE\] 已落库。/,
	// 只在提交之后、按 pk 逐条回读都找到时才打；回读少一条就不打，按没写成算。
	DataSeedProbe: /\[PROBE\] 测试数据已落库 [1-9]\d* 条/,
	// 提交之后再按 pk 回读、要改的字段全是新值才打。
	DataUpdateProbe: /\[PROBE\] 数据已修改 [1-9]\d* 条/,
};

/** 平台保存接口自己说没存上：`save -> {success=false, …}`。之后探针照样往下走、照样退出码 0。 */
const SAVE_REFUSED = /save -> \{[^\n]*\bsuccess=false\b/;

/**
 * 一次 APPLY 是不是真写成了：写探针、退出码 0、打出了它的落库成功行、平台保存没说失败。
 *
 * 判不出来的一律按「没确认写成」处理：授权作废、回执里照实写。宁可让用户多确认一次，
 * 也不把一次中止记成已改。
 */
export function isAppliedWrite(input: { cls: string; exitCode: number; output: string }): boolean {
	if (!Object.hasOwn(APPLIED, input.cls) || input.exitCode !== 0) return false;
	return (APPLIED[input.cls] as RegExp).test(input.output) && !SAVE_REFUSED.test(input.output);
}

/**
 * 探针自己报的「这次会碰到的完整写入目标」那一行（`IsvGuard.reportTargets`）。
 *
 * 为什么要从输出里取，而不是在这边算：真正比对目标的是 JVM 里的 `IsvGuard`，它按三条独立
 * 规则判（实体前缀、`实体.布局` 全等、字段比末段）。TypeScript 这边再算一遍就是同一件事写
 * 两处，两处一漂移，被拦的是用户。现在由门禁自己一路记下来、dry-run 结束前打成一行，这边
 * 只负责读走。
 *
 * 2026-09-14 真机实测的代价：`FormRuleProbe` 当时打的是「写入目标 <实体>.<布局>」——只有布局、
 * 没有 5 个字段。照它授权，APPLY 被 `IsvGuard` 当场拒，**整份授权作废、dry-run 白做**，
 * 用户被多打扰一次确认。
 */
export function declaredTargets(output: string): string[] {
	const line = /\[PROBE\] 写入目标清单[^：]*：(.+)/.exec(output);
	if (line === null) return [];
	return [
		...new Set(
			(line[1] as string)
				.split(/[,，、]/)
				.map((target) => target.trim().toLowerCase())
				.filter((target) => target !== ""),
		),
	];
}

/**
 * 这次 APPLY 是**在写入之前**被拦下的：共享环境一个字节都没动。
 *
 * 和「写到一半失败」分开，因为读回执的人要做的事正好相反：后者可能已经落了一部分库，必须
 * 去核对现场；前者去核对现场是白跑一趟，还会让人以为共享环境被动过（2026-09-14 真机：回执
 * 把一次 `IsvGuard` 前置拦截记成「写入失败」，并建议「先按回滚方式核对现场」）。
 *
 * 判据是门禁自己打的那行 `未落库：`（只在 APPLY=1 时打），再加一条保险：输出里不能出现
 * 平台的 `save -> {…}`。有 save 就说明已经走到写入那一步，不管它成没成，都不算前置拦截。
 */
export function isBlockedWrite(input: { cls: string; output: string }): boolean {
	return isSharedWriter(input.cls) && /\[PROBE\] 未落库：/.test(input.output) && !/save -> \{/.test(input.output);
}

/**
 * 被拦下的那次 APPLY 里，`IsvGuard` 说「需要确认的目标」是哪几个。
 *
 * 拿它给放回待确认的那条 dry-run 记上必需目标：重新授权时少了它就当场拒，不会第二次撞同
 * 一堵墙。
 */
export function deniedTargets(output: string): string[] {
	return [
		...new Set(
			[...output.matchAll(/\[PROBE\] !! 需要确认的目标：(.+)/g)]
				.map((match) => (match[1] as string).trim().toLowerCase())
				.filter((target) => target !== ""),
		),
	];
}

/**
 * 从入参就能确定的写入目标，写法跟 `cosmic_authorize` 的 targets 一样。
 *
 * 打印模板：PrintTplWriteProbe 落库时 IsvGuard 要的是 `tpl:<模板编码>`。只写编码
 * 本身也能通过授权的格式检查（它长得像实体标识），要到 JVM 里才被拦，而那时清单里这一项
 * 已经用掉、整份授权作废。授权时就对上，用户只需确认一次。其余写探针的目标要么由筛选
 * 条件在库里选出，要么写法不止一种，这里不猜，照旧由 IsvGuard 在 JVM 里逐个比对。
 */
export function requiredTargets(probe: string, env: Readonly<Record<string, string>>): string[] {
	if (probe === "PrintTplWriteProbe") {
		const number = (env.TPL_NUMBER ?? "").trim().toLowerCase();
		return number === "" ? [] : [`tpl:${number}`];
	}
	// 造数据、改数据：IsvGuard.assertDataTarget 落库时要的就是 data:<单据>，入参里直接有。
	const dataEntity =
		probe === "DataSeedProbe" ? env.SEED_ENTITY : probe === "DataUpdateProbe" ? env.UPD_ENTITY : undefined;
	if (dataEntity !== undefined) {
		const entity = dataEntity.trim().toLowerCase();
		return entity === "" ? [] : [`data:${entity}`];
	}
	return [];
}

/**
 * 同一个写操作的指纹：探针类名 + 除 APPLY、备份目录和预演试算入参以外的全部入参，按名字排序。
 *
 * APPLY 不进指纹：它是「落不落库」的开关，不是改动内容；备份目录和预演试算入参也不进，理由见
 * `BACKUP_KEYS`、`TRIAL_KEYS`。其余入参一个不漏，包括 FormRuleProbe 的 RULE_EXPECT_CONDITION 这类
 * 「期望旧值」——确认之后改了期望的旧值或要写的新值，都是另一个操作。
 *
 * `cosmic_meta ptpl apply` 底下跑的就是 PrintTplWriteProbe + 同一组入参，所以两个入口对同一
 * 个改动算出同一个指纹：在哪边 dry-run、在哪边 APPLY 都认。空值入参视同没给（探针自己的
 * `env()` 也把 "" 当没给），免得 `{X:""}` 和不给 X 被当成两个操作。
 */
export function writePlanDigest(probe: string, env: Readonly<Record<string, string>>): string {
	const backup = Object.hasOwn(BACKUP_KEYS, probe) ? BACKUP_KEYS[probe] : undefined;
	const trial = TRIAL_KEYS[probe] ?? [];
	const canonical = [
		probe,
		...Object.entries(env)
			.filter(([key, value]) => key !== "APPLY" && key !== backup && !trial.includes(key) && value !== "")
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([key, value]) => `${key}=${value}${fileInputMark(probe, key, value)}`),
	].join("\n");
	return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/**
 * 入参是一个文件或目录的那些键（S32 1.4）。
 *
 * 这些入参的值是一条路径，**真正被写进共享环境的是路径底下的内容**。指纹只算路径的话，
 * 用户确认的是「把这个目录写回去」，执行时写进去的却可以是另一份东西 —— 预演一份、
 * 拿到确认、把文件换掉、再执行，指纹一个字不变，门禁看不出来。
 * `meta botp restore` 从 S5.4 起就是这样；打印模板的整份提交（`TPL_FILE`）会踩同一个坑，
 * 所以两个一起改，不做成打印专用。
 */
const FILE_INPUT_KEYS: Readonly<Record<string, readonly string[]>> = {
	BotpRuleSyncProbe: ["SYNC_RESTORE"],
	FormLayoutWriteProbe: ["LAYOUT_RESTORE"],
	PrintTplWriteProbe: ["TPL_FILE", "TPL_LOCALE", "TPL_RESTORE"],
};

/** 这个探针的哪几个入参是文件/目录路径。 */
export function fileInputKeys(probe: string): readonly string[] {
	return FILE_INPUT_KEYS[probe] ?? [];
}

/**
 * 路径入参在指纹里额外带上的那一段：内容的哈希。
 *
 * 读不到就写 `(读不到)` —— 也进指纹。预演时文件在、执行时没了，那不是同一个操作，
 * 让门禁当场说不对，比放过去让探针报一个文件不存在要早一步。
 */
function fileInputMark(probe: string, key: string, path: string): string {
	if (!fileInputKeys(probe).includes(key)) return "";
	return `\n${key}#内容=${pathDigest(path)}`;
}

/**
 * 一个文件或一整个目录的内容指纹。
 *
 * 目录按文件名排序后逐个算，名字也进指纹：少一个文件、多一个文件、换一个名字都是另一份内容。
 * 只看第一层——现有两个用法（BOTP 还原的 xml 目录、打印模板的 json 文件）都不嵌套。
 */
function pathDigest(path: string): string {
	const hash = createHash("sha256");
	try {
		const info = statSync(path);
		if (info.isDirectory()) {
			for (const name of readdirSync(path).sort()) {
				const child = join(path, name);
				if (!statSync(child).isFile()) continue;
				hash.update(name).update("\0").update(readFileSync(child)).update("\0");
			}
		} else {
			hash.update(readFileSync(path));
		}
	} catch {
		return "(读不到)";
	}
	return hash.digest("hex").slice(0, 16);
}

/** 一条落库的测试数据，从探针的 `t=seed-row` 记录里取。 */
export interface SeededRow {
	label: string;
	pk: string | null;
	number: string | null;
}

/**
 * 这次 APPLY 真造出来的数据（S21）：探针提交后按 pk 回读，每条发一条 `t=seed-row`。
 *
 * 用户决定测试数据留在共享环境、不清理，所以「造了哪几条」必须进回执——不然过几天没人说得出
 * 库里那几张单是谁、为什么造的。只收回读找到的（`found=true`）：没找到的那条不是造出来的数据。
 */
export function seededRows(records: readonly Record<string, unknown>[]): SeededRow[] {
	const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
	return records
		.filter((record) => record.t === "seed-row" && record.found === true)
		.map((record) => ({ label: text(record.label) ?? "", pk: text(record.pk), number: text(record.number) }));
}

/** 回执和交付说明里的一条：`编号（pk …）`，没有编号就只写 pk。 */
export function seededRowText(row: SeededRow): string {
	if (row.number !== null) return row.pk === null ? row.number : `${row.number}（pk ${row.pk}）`;
	return row.pk === null ? row.label : `pk ${row.pk}`;
}

/**
 * 改数据 dry-run 报的改前快照（S23）：选中的每条数据、每个要改字段的原值合成的指纹。
 *
 * 为什么要它：用户在确认单上看到的「原值」是 dry-run 那一刻的。确认之后、落库之前，别人可能改过
 * 这几条数据，按条件选中的也可能多了少了。APPLY 时把确认过的快照交回探针（`-Dcosmic.baseline`），
 * 对不上就一条都不改——不然用户确认的是「空 → 合格」，实际写的是「不合格 → 合格」。
 * 快照不进入参、不进指纹：它是探针算出来的，不是模型给的。
 */
export function dataBaseline(output: string): string | undefined {
	return /\[PROBE\] 改前快照=([0-9a-f]{16})/.exec(output)?.[1];
}

/**
 * 这次 APPLY 因为改前数据变了被探针拦下（S23）。它也是「未落库」，共享环境没动过；但和写入目标
 * 不够那种拦截不同，这一项的 dry-run 不能原样放回待确认：确认单上的原值已经不是真的，要重新 dry-run。
 */
export function isStaleBaseline(output: string): boolean {
	return /\[PROBE\] 未落库：(?:改前数据和预演时不一样了|没拿到用户确认过的改前快照)/.test(output);
}

/**
 * 这次 APPLY 真改掉的数据（S23）：探针报的 `t=data-change`，一格一行，`编号 字段：原值 → 新值`。
 *
 * 回执必须留原值：数据改了不会自动改回来，要恢复只能照原值再改一次，而那时 dry-run 输出早就不在手边了。
 */
/** 造数、改数真落了库的一张单：哪张单据、主键、回执里认它用的名字。 */
export interface WrittenRow {
	entity: string;
	pk: string;
	/** 改数据那几格开头的编号（`updatedRows` 的 `label`）；造数这里是单据编号，没有就是 pk。 */
	label: string;
}

/**
 * 这次写入落到库里的那几张单，交付前按它回读还在不在。
 *
 * 回执说「库里多了哪几条、哪几格改过」只是写入那一刻的事；之后跑的删除、插件联动删掉的单，写入记录里
 * 看不到。2026-10-14 真机：三张造出来的单都被删除断言验证过查不到了，回执仍写「保留」。
 */
export function writtenRows(records: readonly Record<string, unknown>[]): WrittenRow[] {
	const text = (value: unknown): string => (typeof value === "string" ? value : value == null ? "" : String(value));
	const rows: WrittenRow[] = [];
	for (const record of records) {
		const seeded = record.t === "seed-row" && record.found === true;
		if (!seeded && record.t !== "data-change") continue;
		const entity = text(record.entity);
		const pk = text(record.pk);
		if (entity === "" || pk === "" || pk === "0") continue;
		if (rows.some((row) => row.entity === entity && row.pk === pk)) continue;
		rows.push({ entity, pk, label: seeded ? text(record.number) || pk : text(record.label) });
	}
	return rows;
}

/**
 * DataQueryProbe 只列 id 时查到的那几个 id；查询没走到「只读结束」（入参被拒、查询失败）是 null。
 *
 * 交付前回读用它：条件和字段由调用方写死成 `id in …`、`id`，每行就是 `[PROBE] #序号  id=主键`。
 */
export function queriedIds(output: string): Set<string> | null {
	if (!output.includes("[PROBE] 只读结束")) return null;
	return new Set([...output.matchAll(/^\[PROBE\] #\d+\s+id=(\d+)/gmu)].map((match) => match[1] ?? ""));
}

export function updatedRows(records: readonly Record<string, unknown>[]): string[] {
	const text = (value: unknown): string => (typeof value === "string" ? value : value == null ? "" : String(value));
	return records
		.filter((record) => record.t === "data-change")
		.map((record) => `${text(record.label)} ${text(record.name)}：${text(record.before)} → ${text(record.after)}`);
}
