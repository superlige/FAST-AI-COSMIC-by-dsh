/**
 * Plugin knowledge hints and the deterministic Capsule gate (S7.4, S15.2).
 *
 * Two layers with one judge between them:
 *
 *   L1 hints  -- attached to results the model is already reading (a `.java`
 *                write, a lint/fast run, an `api` lookup). Advisory.
 *   L3 gate   -- `cosmic_fast` requires a deterministic Capsule for every
 *                recognised family. It never requires a model-performed lookup.
 *
 * The old gate judged whether `cosmic_knowledge action=plugin` had written a
 * brief stamp. That proved a tool call happened, not that the target knowledge
 * entered the current reasoning turn, and added one or two calls before every
 * compile. S15 replaces it with a target Capsule generated from the same family,
 * guide and runtime facts. A missing Capsule is still a pre-Gradle refusal; a
 * missing human check-in is not.
 *
 * Three properties carried over from the frozen implementation, each of which is
 * a rule rather than an implementation detail:
 *
 *   1. **lint and fast read the same verdict.** Not "the same logic" -- the same
 *      function value, handed to both by the caller (`knowledgeAdvisor`). Two
 *      copies drift into "lint said it would block and fast did not", and either
 *      direction of that stops anyone believing either half.
 *   2. **The family key is the platform base class, never pluginType.** Two print
 *      bases share `printplugin` and have different event sets.
 *   3. **Delivery evidence lives under `.cosmic-ai/work` and is RuntimeKey-scoped.**
 *      It records only digest/source facts, never the Capsule body.
 *
 * The legacy `plugin-brief/1` stamp reader is gone (S19): nothing wrote it since
 * S15, nothing read what it returned, and its file was keyed by a RuntimeKey that
 * every agent upgrade changes.
 */

import {
	describeBinding,
	describeVerify,
	type FacetOptions,
	facetGate,
	type PluginAttach,
	referenceSkillName,
	sceneItems,
} from "./catalog.ts";
import type { KnowledgeBase } from "./docs.ts";
import { type JavaSourcePort, type PluginFamily, type PluginTier, pluginFamiliesIn } from "./plugin-base.ts";

// --------------------------------------------------------------------- hints

export interface PluginHint {
	base: string;
	pluginType: string | null;
	tier: PluginTier;
	/** Project base classes walked through to reach the platform base. */
	via: string[];
	/** The source (or the queried class name) this came from. */
	file: string;
	guide: string;
	/** Scenes the official index tagged for this family; null when it never tagged the family at all. */
	sceneCount: number | null;
	bind: string | null;
	/** 还没挂上时怎么挂；null = 没有探针能挂。 */
	attach: PluginAttach | null;
	/** Rendered through the command map. Empty means "no headless adapter", never "no verification needed". */
	verify: string;
	/** `show` 取这一族必知要点的写法（`reference:<篇名>#<标题>`）；这一族没写要点时为 null。 */
	essentials: string | null;
	/** Ready-to-show text. Every line is derived from the route table, none is written by hand here. */
	lines: string[];
}

function sceneCountFor(base: KnowledgeBase, pluginType: string | null): number | null {
	if (pluginType === null) return null;
	const facets: FacetOptions = { pluginType };
	return sceneItems(base, false).filter((item) => facetGate(item, facets) !== null).length;
}

/**
 * What to put in `action=plugin query=…`.
 *
 * A `.java` path when there is one: it is what the recogniser actually read, so
 * a family reached by climbing project base classes stays reproducible. The
 * other two insertion points (`api`, `findclass`) carry a class name instead,
 * and a fully qualified one is not a target `resolvePluginTarget` accepts --
 * only the simple base name is. Sending the FQCN would print a command that
 * answers "认不出「kd.bos.x.Y」是哪一族", which is worse than not printing one.
 */
function flowTarget(hint: Omit<PluginHint, "lines">): string {
	return hint.file.toLowerCase().endsWith(".java") ? hint.file : hint.base;
}

/**
 * The advisory half of L1.
 *
 * `action=plugin` is optional deep research after S15.2. The ordinary write path
 * already receives a target Capsule; this hint must not teach a check-in that
 * fast no longer requires. `scenes` / `show` remain lookup-only alternatives.
 */
function hintLines(hint: Omit<PluginHint, "lines">): string[] {
	const via = hint.via.length > 0 ? `（经工程基类 ${hint.via.join(" → ")}）` : "";
	const guessed = hint.tier === "loose" ? "（按出现的标识符判定，不是声明的父类；不对就忽略）" : "";
	const scenePhrase = hint.sceneCount === null ? "这一族没打过场景标签" : `${String(hint.sceneCount)} 篇场景的整表`;
	const lines = [
		`${hint.base}${via}${guessed} 属于官方${hint.pluginType === null ? "" : ` ${hint.pluginType} `}插件族。`,
		...(hint.essentials === null
			? []
			: [
					`这一族最容易出错的几条：cosmic_knowledge action=show query=${hint.essentials}   # 读、写这一族的源码时会作为知识卡片附上`,
				]),
		`复杂语义或低置信边界再用 cosmic_knowledge action=plugin query=${flowTarget(hint)}   # 按需展开指南和${scenePhrase}`,
	];
	if (hint.sceneCount === null) {
		lines.push("官方场景索引没给这一族打过标签，只有指南可读——这是「没标签」，不是「没有场景」。");
	}
	lines.push(
		hint.sceneCount === null
			? `只想查不打算写码：cosmic_knowledge action=show query=${hint.guide}`
			: `只想查不打算写码：cosmic_knowledge action=scenes pluginType=${hint.pluginType ?? ""}｜action=show query=${hint.guide}`,
	);
	const bind = describeBinding(hint.bind, hint.attach);
	lines.push(
		hint.verify === ""
			? `验证：这一族还没有无头适配器，${bind}，行为验证要起节点`
			: `验证：${hint.verify}（${bind}）`,
	);
	return lines;
}

/** One hint per recognised family. Same family twice in one batch says it once. */
export function pluginHints(base: KnowledgeBase, families: readonly PluginFamily[]): PluginHint[] {
	return families.map((family) => {
		const partial: Omit<PluginHint, "lines"> = {
			base: family.route.base,
			pluginType: family.route.pluginType,
			tier: family.tier,
			via: [...family.via],
			file: family.file,
			guide: family.route.guide,
			sceneCount: sceneCountFor(base, family.route.pluginType),
			bind: family.route.bind,
			attach: family.route.attach,
			verify: describeVerify(family.route.verify),
			essentials:
				family.route.essentials === null
					? null
					: `reference:${referenceSkillName(family.route.local)}#${family.route.essentials}`,
		};
		return { ...partial, lines: hintLines(partial) };
	});
}

// ---------------------------------------------------------------------- gate

export type PluginGateReason = "no-families" | "capsule-ready" | "capsule-unavailable";

export interface PluginCapsuleAudit {
	base: string;
	digest: string;
	subject: string;
	confidence: "exact" | "partial";
	sourceRefs: string[];
	delivered: boolean;
}

export interface BlockedFamily {
	base: string;
	pluginType: string | null;
	file: string;
	tier: PluginTier;
	via: string[];
	/** What to do when deterministic knowledge cannot be produced. */
	remedy: string;
}

export interface PluginGateVerdict {
	allowed: boolean;
	reason: PluginGateReason;
	/** Empty when allowed. */
	blocked: BlockedFamily[];
	/** Capsule facts used for this verdict. Present on allowed verdicts too, so a pass is auditable. */
	capsules: PluginCapsuleAudit[];
	lines: string[];
}

/**
 * The judge. Called by `cosmic_lint` to preview and by `cosmic_fast` to refuse;
 * both get it as the same closure, so the two halves cannot disagree.
 */
export function pluginGate(
	families: readonly PluginFamily[],
	capsules: readonly PluginCapsuleAudit[],
): PluginGateVerdict {
	if (families.length === 0) {
		return { allowed: true, reason: "no-families", blocked: [], capsules: [], lines: [] };
	}
	const byBase = new Map(capsules.map((capsule) => [capsule.base, capsule]));
	const blocked: BlockedFamily[] = families
		.filter((family) => byBase.get(family.route.base) === undefined)
		.map((family) => ({
			base: family.route.base,
			pluginType: family.route.pluginType,
			file: family.file,
			tier: family.tier,
			via: [...family.via],
			remedy: `用 cosmic_doctor 检查内嵌知识包；完整语义可按需查 cosmic_knowledge action=plugin query=${family.file}`,
		}));
	if (blocked.length === 0) {
		return { allowed: true, reason: "capsule-ready", blocked: [], capsules: [...capsules], lines: [] };
	}
	const lines = [
		"这些已识别插件族无法生成目标 Capsule：",
		...blocked.flatMap((family) => [
			`  ${family.base}${family.pluginType === null ? "" : ` (${family.pluginType})`}  ← ${family.file}`,
			`    ${family.remedy}`,
		]),
		"修复知识包或目标识别后直接重试 fast；lint、探针和验证不受影响。",
	];
	return { allowed: false, reason: "capsule-unavailable", blocked, capsules: [...capsules], lines };
}

// ------------------------------------------------------------------- advisor

/**
 * What one batch of sources is owed: the hints to show, and the verdict.
 *
 * Bundled rather than fetched separately so a caller cannot take one without the
 * other -- showing the hint but skipping the verdict is precisely the "looks
 * like a gate, is not a gate" state this design refuses.
 */
export interface KnowledgeAdvice {
	hints: PluginHint[];
	gate: PluginGateVerdict;
	capsules: PluginCapsuleAudit[];
}

/**
 * Takes resolved sources and returns advice. Deliberately not given the kernel
 * context: it needs a knowledge base, Java reads, deterministic Capsule facts
 * and nothing else the compile chain owns.
 */
export type KnowledgeAdvisor = (files: readonly string[]) => KnowledgeAdvice;

export interface AdvisorInput {
	base: KnowledgeBase;
	source: JavaSourcePort;
	capsules(families: readonly PluginFamily[]): PluginCapsuleAudit[];
}

export function knowledgeAdvisor(input: AdvisorInput): KnowledgeAdvisor {
	return (files) => {
		const families = pluginFamiliesIn(files, input.source);
		const capsules = input.capsules(families);
		return {
			hints: pluginHints(input.base, families),
			gate: pluginGate(families, capsules),
			capsules,
		};
	};
}

/** Advice for a batch nothing recognised anything in. Used where no knowledge source could be resolved. */
export const NO_ADVICE: KnowledgeAdvice = {
	hints: [],
	gate: { allowed: true, reason: "no-families", blocked: [], capsules: [], lines: [] },
	capsules: [],
};
