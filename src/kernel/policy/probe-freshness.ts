/**
 * Which probes the stale-class gate actually protects.
 *
 * The gate in `probe.ts` asks one question -- "is any business source newer than
 * its .class" -- and refuses on yes. What it is protecting against is narrower
 * than that question: a probe that LOADS a project business class gets the old
 * one, and when only a method body changed nothing reports an error at all. That
 * is the expensive failure, and it is the only one the gate can see.
 *
 * The two are not the same thing, and treating them as the same is what made
 * `explore` a dead end. `MetaProbe` reads design-time metadata out of the
 * database; `DataProbe` runs a query. Neither loads a line of project code, and
 * both were refused because some unrelated form plugin three modules away had
 * been edited -- with a remedy naming `cosmic_fast`, which `explore` does not
 * mount. The way out was to compile code nobody had looked at yet, which is
 * exactly backwards from "探查在前，判断在后".
 *
 * So the lane is declared per probe rather than inferred from the scan:
 *
 *   business  The probe reaches project business classes, or writes the shared
 *             environment. Stale classes are refused, as before. This is the
 *             DEFAULT for anything not named below.
 *   platform  The probe is read-only AND reaches nothing but 苍穹 platform code:
 *             environment, design-time metadata, the database. Stale business
 *             classes are reported and let through.
 *
 * Whitelist, not blacklist, and the asymmetry is deliberate. Leaving a read-only
 * probe off this list costs a `cosmic_fast` nobody needed. Putting a business
 * probe on it by mistake silently returns a wrong answer from an old class,
 * which is the failure the gate exists for. When in doubt, leave it off.
 *
 * This replaces two ad-hoc exemptions that had already started to diverge: the
 * `cls === "EnvDiagProbe"` test in `probe.ts`, and an unconditional
 * `COSMIC_STALE: "warn"` injected by the config wizard in `kernel-adapter.ts`
 * (which, being written after the spread, also overrode an explicit `block` the
 * user had set). Both are the same judgement as the lane below; neither was
 * reviewable as a set.
 */

import { isMetadataWriter } from "./write-plan.ts";

export type FreshnessLane = "platform" | "business";

/**
 * The read-only, platform-only released probes.
 *
 * Classified by reading each source, not by name -- names are wrong often enough
 * here to matter. Two that read as read-only and are NOT on this list:
 *
 *   PrintMeasureProbe   Renders a real PDF through `kd.bos.print.core.ExecuteService`,
 *                       so any print plugin bound to the template runs. The other
 *                       print probes only touch `BosPrintServiceHelper` to read
 *                       template metadata, which loads nothing.
 *   FormRegisterProbe   Reads like a registration lookup; calls SaveServiceHelper
 *                       and DeleteServiceHelper.
 *
 * The five `*Sim` probes and `OpSandbox` load project plugins by design and stay
 * strict. So does `DataSeedProbe` (S21), although it shares the writers' approval
 * flow: it runs a bill's real operation chain, and seeding data through stale
 * plugins would write rows the current source would never have produced.
 *
 * The nine metadata writers (`METADATA_WRITERS` in policy/write-plan.ts) are
 * platform too, dry-run and APPLY alike, and that is a reversal (S18, user
 * decision 2026-09-11). They used to stay strict on the grounds that "a dry-run
 * one env var away from a write is not where this project relaxes a gate". But
 * the gate is not about writes -- IsvGuard and the one-time authorization are --
 * it is about loading stale business classes, and none of the nine (nor the
 * MetaResolve / IsvGuard helpers they share) loads one or enters an engine.
 * Keeping them strict made a print-template change on a project with someone
 * else's half-edited plugins compile those plugins first; a real session paid
 * for 18 of them, and one that did not compile would have blocked the change
 * outright. Since S36 batch 5 the rule writers' dry-run also evaluates the candidate
 * rule (RuleSim.tryForm / tryBiz) and the print writer can preview it (PrintSim.tryCandidate);
 * both run only classes loaded from platform JARs -- a rule function or action whose class
 * is not, the trial skips and says so -- so the lane still holds.
 * They are listed separately from the read-only set below because they
 * are NOT read-only -- the "admits nothing that writes" test still holds for
 * `PLATFORM_PROBES`.
 */
export const PLATFORM_PROBES: readonly string[] = [
	"ApiMetaProbe",
	"BotpRuleProbe",
	"DataProbe",
	"DataQueryProbe",
	"DbColumnProbe",
	"EntityFieldIndexProbe",
	"EnvDiagProbe",
	"FieldLimitProbe",
	"FormCatalogProbe",
	"FormLayoutProbe",
	"FormPluginProbe",
	"FormTreeProbe",
	"FormVisibleProbe",
	"FormulaFunctionProbe",
	"IsvCheckProbe",
	"IsvGuardProbe",
	"MetaChangeProbe",
	"MetaProbe",
	"MetaRowsProbe",
	"MustInputProbe",
	"OpMetaProbe",
	"PluginIndexProbe",
	"PrintGridDumpProbe",
	"PrintTplBackupProbe",
	"PrintTplControlAssertProbe",
	"PrintTplDesignProbe",
	"PrintTplJsonProbe",
	"PrintTplProbe",
	"RuleFunctionProbe",
	"TemplateProbe",
	"UserProbe",
	"WfModelProbe",
];

const PLATFORM_SET = new Set(PLATFORM_PROBES);

/**
 * A released probe's lane. Anything unregistered -- a project's own probe included -- is business.
 *
 * The metadata writers are platform whatever their inputs: read mode, dry-run
 * and APPLY reach the same platform-only code. This replaces `READ_MODES`, which
 * earned the platform lane only for the read branch of FormRuleProbe/BizRuleProbe
 * and was later borrowed as the phase machine's list of write channels -- two
 * jobs, and it did neither completely.
 */
export function releasedLane(cls: string, env: Readonly<Record<string, string>> = {}): FreshnessLane {
	// 只有预演会试：APPLY 那一次探针不读试算入参
	if (env.APPLY !== "1" && (BUSINESS_WHEN[cls] ?? []).some((key) => (env[key] ?? "").trim() !== "")) {
		return "business";
	}
	return PLATFORM_SET.has(cls) || isMetadataWriter(cls) ? "platform" : "business";
}

/**
 * A metadata writer that, given one of these inputs, runs business code after all.
 *
 * The print writer's real-bill preview (`PRINT_PK`, S36 batch 5) prints through the
 * template's print plugins, which are often the project's own classes -- exactly
 * what `run print` is strict about. Same work, same lane.
 */
const BUSINESS_WHEN: Readonly<Record<string, readonly string[]>> = {
	PrintTplWriteProbe: ["PRINT_PK"],
};

/**
 * An ad-hoc probe's lane, judged against the packages that are ACTUALLY stale.
 *
 * Declaring these would be pointless -- the source did not exist a turn ago --
 * but here the source itself is the evidence, and unlike a released probe it can
 * be trusted to be complete. `scanAdHocProbe` has already refused reflection,
 * dynamic class loading, script engines, subprocesses and
 * `OperationServiceHelper`, so an ad-hoc probe has no way to reach a project
 * class except by naming it: an import, or a fully-qualified reference. Both put
 * the package name in the text.
 *
 * Only the stale packages are matched, not every business package. The question
 * is not "does this probe touch business code" but "does it touch code that is
 * currently out of date", and answering the narrower one keeps the most common
 * ad-hoc use -- a throwaway `DB.query` to look at data -- out of the gate's way
 * while a form plugin sits half-edited in another module.
 *
 * An empty `stalePackages` after a non-empty stale file list means a package
 * could not be derived (a source sitting directly in the module root). That is
 * returned as business by the caller, not silently as platform.
 */
export function adHocLane(sourceText: string, stalePackages: readonly string[]): FreshnessLane {
	const text = withoutComments(sourceText);
	return stalePackages.some((pkg) => text.includes(pkg)) ? "business" : "platform";
}

/**
 * Comments blanked, string literals kept.
 *
 * A package name in a comment ("// 抄自 kd.zlgd.scm.OrderPlugin") is not a
 * reference and must not pull the probe into the strict lane. A package name in
 * a STRING, though, is how a class gets named for something else to load -- and
 * while the scan makes that unreachable today, matching it costs nothing and
 * fails in the safe direction.
 */
function withoutComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}
