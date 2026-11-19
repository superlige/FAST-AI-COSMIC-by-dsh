import { retiredToolRoute } from "./names.ts";

/** The one field this needs; every agent-layer failure envelope has it. */
export interface RemedyBearing {
	remedy: string;
}

/**
 * A remedy that names a retired tool, made followable.
 *
 * The kernel writes its remedies without knowing the agent surface -- it cannot
 * know it -- so `cosmic_build force=true` is still the literal text of several
 * kernel remedies, and `cosmic_doctor` is what carries it out. A remedy pointing
 * at a name the caller cannot call reads as "you did something wrong" when the
 * answer is "that is called something else now". Annotating rather than
 * rewriting the sentence: the kernel's own words stay legible next to the current
 * call, which is what tells a reader looking at an old document that the two are
 * the same thing.
 *
 * Until S25 this also annotated tools the current phase did not mount. There is
 * no phase and nothing is withheld any more, so that half is gone (D22).
 */
export function withReachableRemedy<T extends RemedyBearing>(failure: T): T {
	const remedy = failure.remedy;
	if (!remedy) return failure;
	const mentioned = [...new Set(remedy.match(/cosmic_[a-z_]+/g) ?? [])];
	const retired = mentioned
		.map((name) => ({ name, route: retiredToolRoute(name) }))
		.filter((entry): entry is { name: string; route: string } => entry.route !== null);
	if (retired.length === 0) return failure;
	const routes = retired.map((entry) => `${entry.name} 已不是独立工具，现在是 ${entry.route}`);
	return {
		...failure,
		remedy: `${remedy} —— 注意：这条 remedy 里的 ${routes.join("、")}`,
	};
}
