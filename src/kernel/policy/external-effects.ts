/**
 * 插件链上「事务回滚兜不住」的动作：附件、微服务调用、消息、HTTP、socket。
 *
 * 一段话看懂：一张单的插件链里只要有一个插件发消息、调外部接口，跑一次操作就会真的发出去，
 * 回滚事务也撤不回。S27（用户 2026-09-19 定：连的必然是纯测试环境）以前，`cosmic_run` 的回滚适配器和
 * 造数据、改数据的预演都在起 JVM 前拿这个判据拒；现在都只提醒一句「会真的发出去」，判据仍只放这一份。
 *
 * **判据是元数据里的插件登记，不是源码里提没提到这个标识。** 第一版按「源码提到了目标标识、
 * 又带着副作用关键字」判，真机上把 `run op zlgd_qty_wtd save` 拒了：一个*别的*单据的下推插件
 * 在代码里写了 `zlgd_qty_wtd`，而 OpMetaProbe 显示那条保存链上只有两个插件、都不是它。
 * 这个拒绝没有申诉通道，所以证据必须是平台自己读的那份——影响面索引里记的插件登记。
 * 没有索引时退回按源码判（放过一个撤不回的副作用更糟），但每一条都标明是这么判的。
 *
 * 插件自己的源文件里没有、经本工程工具类调到的也算：代码关系表按方法记了外部调用，顺着调用边往下找
 * （真机两个调度任务经 DateUtils 调节假日接口，只看插件文件时漏报）。
 */

import { relative } from "node:path";
import { type TargetRegistration, targetRegistrations } from "../commands/impact.ts";
import type { KernelContext } from "../context.ts";
import { blankJavaNoise } from "./probe-scan.ts";

export const EXTERNAL_EFFECT_TOKENS = [
	"AttachmentServiceHelper",
	"DispatchService",
	"MessagePublisher",
	"MQFactory",
	"HttpClient",
	"HttpURLConnection",
	"openConnection",
	"new Socket",
	"sendMessage",
] as const;

/** 目标插件链上一个带事务外副作用的业务类。 */
export interface ExternalEffectSite {
	file: string;
	/** 不带包名的类名，用在「摘掉它：--skip X」这种提示里。 */
	simple: string;
	class: string | null;
	effects: string[];
	/** `meta-registration`：元数据里真登记在这个目标上；`source-linkage`：没有索引，按源码里提到过目标判的，可能误判。 */
	basis: "source-linkage" | "meta-registration";
	sites: TargetRegistration[];
	/** 经工具类调到时的路径，`Plugin#execute → Util#getHolidaysFromApi`；插件自己的源文件里就有时为 null。 */
	via: string | null;
	/** 登记依据的快照，`快照 09-23，10 天前`；按源码判时为 null。 */
	snapshot: string | null;
}

/**
 * Maps an absolute business source path back to the class it declares.
 *
 * Derived from the path rather than read out of the index's `file` field: the
 * index records a project-relative path whose spelling depends on how the scan
 * was launched, while `module.src` + the relative path is the same fact the
 * compiler uses.
 */
function classOfSource(moduleSrc: string, file: string): string {
	const rel = relative(moduleSrc, file).replace(/\\/g, "/");
	return rel.replace(/\.java$/, "").replace(/\//g, ".");
}

/** 这个目标（单据 / 布局）的插件链上，哪些本工程的类带着回滚事务撤不回的动作。 */
export function externalEffectSites(ctx: KernelContext, target: string): ExternalEffectSite[] {
	const registrations = targetRegistrations(ctx, target);
	const byClass = new Map<string, TargetRegistration[]>();
	// 停用的登记平台不装，插件链上没有它：算进来就是一句「走到它时会真的发出去」的假话
	for (const registration of (registrations?.list ?? []).filter((entry) => entry.enabled)) {
		const list = byClass.get(registration.class);
		if (list) list.push(registration);
		else byClass.set(registration.class, [registration]);
	}
	// Nothing of ours is registered on this target: the chain is the platform's
	// own, and no business source can be on it.
	if (registrations !== null && byClass.size === 0) return [];

	const out: ExternalEffectSite[] = [];
	for (const module of ctx.layout.moduleDirs) {
		for (const file of ctx.ports.fs.listJavaFiles(module.src)) {
			const sites = registrations === null ? null : byClass.get(classOfSource(module.src, file));
			if (registrations !== null && sites === undefined) continue;
			const source = ctx.ports.fs.read(file);
			// Without registrations this is all there is: unrelated network code in
			// the same large module must not turn every run into a false refusal.
			if (registrations === null && !source.includes(target)) continue;
			const code = blankJavaNoise(source);
			const own = EXTERNAL_EFFECT_TOKENS.filter((token) => code.includes(token));
			const reached = own.length === 0 && sites?.[0] ? (registrations?.reach(sites[0].class) ?? null) : null;
			const effects = own.length > 0 ? own : (reached?.effects ?? []);
			if (effects.length === 0) continue;
			out.push({
				file,
				simple: file.slice(Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\")) + 1).replace(/\.java$/, ""),
				class: sites?.[0]?.class ?? null,
				effects: [...effects],
				basis: registrations === null ? "source-linkage" : "meta-registration",
				sites: sites ?? [],
				via: reached?.via ?? null,
				snapshot: registrations?.snapshot ?? null,
			});
		}
	}
	return out;
}

/** 拒绝消息里「登记在哪」那半句。 */
export function effectSiteWhere(site: ExternalEffectSite): string {
	if (site.sites.length === 0) return "（没有代码关系表，这条是按源码里提到过本目标判的，可能是误判）";
	const where = site.sites.map((entry) => `${entry.kind}${entry.layout === "" ? "" : ` ${entry.layout}`}`).join("、");
	return `（${site.via === null ? "" : `经 ${site.via}；`}登记位置：${where}，${site.snapshot}）`;
}

/** 只在界面上跑的登记位置：表单插件、打印插件。单据的保存/提交/审核操作链不会调到它们。 */
export const UI_ONLY_SITES = new Set(["form", "print"]);

/**
 * 造数据、改数据会不会顺带发消息、调接口（S21 / S23 的判据；S27 起只提醒，不拦）。
 *
 * 只登记成表单插件、打印插件的类不算：操作链不走界面，调不到它们。没有代码关系表时按源码判，
 * 提醒里会标明可能误判。
 */
export function dataWriteEffectNotes(ctx: KernelContext, entity: string, action: "seed" | "update"): string[] {
	if (entity.trim() === "") return [];
	return externalEffectSites(ctx, entity.trim())
		.filter((site) => site.basis === "source-linkage" || site.sites.some((entry) => !UI_ONLY_SITES.has(entry.kind)))
		.map(
			(site) =>
				`单据 ${entity} 的插件链上 ${site.simple} 会发消息 / 调接口 / 存附件（${site.effects.join(", ")}）${effectSiteWhere(site)}：` +
				(action === "seed" ? "造数据走它的操作链" : "改数据走它的保存") +
				"，预演（回滚事务）和落库都会真的发出去。" +
				(action === "update" ? "不想触发它就写 UPD_OP=direct 直接存库（不走校验器和插件）。" : ""),
		);
}
