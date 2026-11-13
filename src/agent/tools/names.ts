export const COSMIC_TOOL_NAMES = [
	"cosmic_open_project",
	"cosmic_lint",
	"cosmic_fast",
	"cosmic_probe",
	"cosmic_doctor",
	"cosmic_knowledge",
	"cosmic_run",
	"cosmic_verify",
	"cosmic_impact",
	"cosmic_authorize",
	"cosmic_meta",
	"cosmic_runtime",
	"cosmic_prod",
] as const;
export type CosmicToolName = (typeof COSMIC_TOOL_NAMES)[number];

export function isCosmicToolName(name: string): name is CosmicToolName {
	return (COSMIC_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * Names that were tools until S11, and the call that replaced each one.
 *
 * The surface went 18 -> 13 because five of the eighteen were never reached by a
 * model choosing the cheapest route, and the three reasons were different:
 *
 *   1. `cosmic_build` and `cosmic_recover_write_lock` are escape hatches. Their
 *      moment is not "the model is picking a tool", it is "another tool just
 *      refused" -- NoClassDefFoundError from a stale classpath,
 *      PROJECT_WRITE_LOCKED from a crashed window. A tool that is only ever
 *      correct inside somebody else's failure does not belong on the surface
 *      waiting to be remembered; it belongs in that failure's remedy, which is
 *      what `RETIRED_TOOL_ROUTES` and `withReachableRemedy` now make happen.
 *   2. `cosmic_probe_server`, `cosmic_node` and `cosmic_deploy` were three tools
 *      over one object -- the local runtime's processes. All three descriptions
 *      opened by talking the reader out of the call ("probe 会按需自动拉起",
 *      "验插件逻辑用 cosmic_fast，别用它", "probe 和 fast 都不经过它"). Three
 *      rarely-right names cost more to carry than one `cosmic_runtime` whose
 *      action says which process is meant.
 *   3. `cosmic_bundle` computed a view over records `spec` and `verify` had
 *      already written; its own description admitted the only new fact it
 *      produces is the difference set. A view over the ledger is an action on
 *      the ledger, so it is `cosmic_spec action=bundle` -- reachable from the
 *      tool the model is already holding when it finishes a requirement, instead
 *      of one more name it has to think of afterwards.
 *
 * `cosmic_impact` survived but narrowed to its one irreplaceable act: reverse
 * lookup from a code identifier. `touches` left because the requirement record
 * it fed computed that block itself from the files it collected -- asking the
 * model to fetch and paste what the callee recomputes anyway was always
 * redundant; the record and `touches` are both gone since. `build` and `status` left because rebuilding a derived index
 * is maintenance on an artefact, which is what `cosmic_doctor` is for now.
 *
 * Kept as data rather than deleted, because a name does not stop existing when
 * the tool does: it is still written in the frozen CLI's documents, in reference
 * skills, in the user's memory of last week's session, and in kernel remedies
 * this layer does not own. 「没有 cosmic_build 这个工具」 is a true sentence that
 * strands the caller; naming the replacement is the same sentence made useful.
 */
export const RETIRED_TOOL_ROUTES: Readonly<Record<string, string>> = {
	cosmic_build: "cosmic_doctor action=rebuild（产物在但不对时加 force=true）",
	cosmic_recover_write_lock: "cosmic_doctor action=lock（不给 token 是只读查看，给 token 才回收）",
	cosmic_probe_server: "cosmic_runtime action=probe-status / probe-start / probe-stop / probe-restart",
	cosmic_node: "cosmic_runtime action=node-status / node-start / node-logs / node-stop",
	cosmic_deploy: "cosmic_runtime action=deploy",
	cosmic_bundle: "cosmic_verify action=show（交付回执取代批次台账视图）",
	cosmic_spec: "cosmic_verify action=finish",
};

/** The replacement call for a retired name, or null if the name was never a tool. */
export function retiredToolRoute(name: string): string | null {
	return RETIRED_TOOL_ROUTES[name] ?? null;
}

/**
 * All twelve are mounted from startup, project or not (S25, D2).
 *
 * Until S25 a phase table decided which subset the model saw. A withheld name drew
 * pi's `Tool ... not found` before any extension hook ran -- byte-identical to a
 * name that never existed, and read that way three times in twenty real sessions:
 * "this product has no such capability". What the table protected is now refused at
 * the call, from the facts each refusal needs (D22): a tool that needs a project
 * says 「先 cosmic_open_project」, a shared write without a confirmed grant is
 * refused, a run over uncompiled edits is refused. The order is the model's call.
 *
 * What can still come back as `not found` is a retired name, which is never
 * registered at all -- hence `retiredToolReason` below and the L0 retired line.
 */

/** What to say about a retired name that pi just answered with `Tool ... not found`. */
export function retiredToolReason(toolName: string): string | null {
	// A retired name is not a typo, it is the old name for a capability that
	// still exists. `cosmic_build` is `cosmic_doctor action=rebuild`, and it is still
	// written in the frozen CLI's documents and in whatever the model saw last week.
	// Answer the question that was actually asked.
	const route = retiredToolRoute(toolName);
	if (route === null) return null;
	return `${toolName} 已并入别的工具，现在是：${route}。`;
}
