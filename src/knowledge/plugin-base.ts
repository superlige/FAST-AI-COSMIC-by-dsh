/**
 * Which plugin family a piece of Java belongs to (S7.4).
 *
 * This is the input to every L1 insertion point and to the L3 gate, and it is
 * the one part of the knowledge layer whose failure mode is invisible: "no hint"
 * and "this is not a plugin" look exactly the same from the outside, so a
 * recognition miss reads as a clean bill of health.
 *
 * Three tiers, widening in order. The first two need the file's path, the third
 * needs only a name:
 *
 *   direct   -- the class extends/implements a platform base class outright.
 *   climbed  -- it extends one of the PROJECT's own base classes, and that one
 *               (or its parent, up to 8 hops) extends a platform base.
 *   loose    -- a platform base name appears anywhere in the text. This is the
 *               tier `cosmic_knowledge api` uses, where the whole "text" is a
 *               fully-qualified class name.
 *
 * The middle tier is not a refinement. Measured on one real ISV project: of 315
 * classes with an `extends`, **43** reach a platform base only through a project
 * base class (the biggest single family, ExtOperationServicePlugin, is entirely
 * inside that 43), and direct-parent-only recognition says nothing at all about
 * any of them. The same measurement is why `loose` runs last rather than first:
 * on that project a full-text identifier scan named the WRONG family for 3
 * classes, and a wrong family is worse than no family -- it points at the wrong
 * guide with the same confidence as a right one. With the climb in place, 1 of
 * the 315 remained unrecognised.
 *
 * The tier is reported, not just used: a `loose` hit is a guess from an
 * identifier and the caller says so, whereas the frozen implementation gave all
 * three the same voice.
 */

import { PLUGIN_ROUTES, type PluginRoute } from "./catalog.ts";

/**
 * Reading project sources. Structurally a subset of the kernel's FsPort, so the
 * real one and the tests' MemoryFs both satisfy it without an adapter -- and the
 * climb cannot do anything but read.
 */
export interface JavaSourcePort {
	exists(path: string): boolean;
	/** File text, or "" when the file is absent or unreadable. */
	read(path: string): string;
}

export type PluginTier = "direct" | "climbed" | "loose";

export interface PluginBaseHit {
	route: PluginRoute;
	/** How it was recognised. `loose` is a guess from an identifier, not a declaration. */
	tier: PluginTier;
	/** The chain of project base classes walked through. Empty unless tier is "climbed". */
	via: string[];
}

/** Maximum climb, matching the frozen implementation. A deeper chain is a project problem, not a lookup problem. */
const MAX_CLIMB = 8;

const posix = (path: string): string => path.replace(/\\/g, "/");

function dirOf(file: string): string {
	const flat = posix(file);
	const cut = flat.lastIndexOf("/");
	return cut < 0 ? "." : flat.slice(0, cut);
}

/**
 * Every supertype a source declares (`extends` and `implements`), in order, as
 * simple names. `implements` counts because five of the routed families are
 * interfaces or are reached through one (ICustomApiServlet, IWorkflowPlugin).
 */
export function supertypesOf(text: string): string[] {
	return [...String(text ?? "").matchAll(/\b(?:extends|implements)\s+([\w.]+(?:\s*,\s*[\w.]+)*)/g)].flatMap((match) =>
		(match[1] ?? "")
			.split(",")
			.map((name) => name.trim().split(".").pop() ?? "")
			.filter((name) => name !== ""),
	);
}

/**
 * The source root a `.java` file sits under, derived from its own package
 * declaration. Imports and same-package siblings are located relative to it.
 */
function javaSourceRoot(file: string, text: string): string {
	const dir = dirOf(file);
	const pkg = /^[^\S\n]*package\s+([\w.]+)\s*;/m.exec(text)?.[1];
	if (pkg === undefined) return dir;
	const tail = pkg.split(".").join("/");
	// dir = root + "/" + tail, so the separator goes with it. A dir that IS the
	// package path leaves the filesystem root.
	return dir.endsWith(tail) ? dir.slice(0, -(tail.length + 1)) || "/" : dir;
}

/** One supertype name -> its source file: by import if there is one, else a same-package sibling. */
function javaFileFor(name: string, dir: string, root: string, text: string, source: JavaSourcePort): string | null {
	const imported = text
		.split(/\r?\n/)
		.map((line) => /^\s*import\s+([\w.]+)\s*;/.exec(line)?.[1])
		.find((fqcn) => fqcn?.endsWith(`.${name}`));
	const guesses = imported === undefined ? [] : [`${root}/${imported.split(".").join("/")}.java`];
	guesses.push(`${dir}/${name}.java`);
	return guesses.find((file) => source.exists(file)) ?? null;
}

/** Walks up through the project's own base classes until it hits a routed platform base. */
function climbToKnownBase(
	file: string,
	text: string,
	source: JavaSourcePort,
	seen: Set<string>,
): { route: PluginRoute; via: string[] } | null {
	const dir = dirOf(file);
	const root = javaSourceRoot(file, text);
	for (const name of supertypesOf(text)) {
		if (seen.has(name) || seen.size >= MAX_CLIMB) continue;
		seen.add(name);
		const next = javaFileFor(name, dir, root, text, source);
		if (next === null) continue;
		const parentText = source.read(next);
		if (parentText === "") continue;
		const declared = supertypesOf(parentText);
		const hit = PLUGIN_ROUTES.find((route) => declared.includes(route.base));
		if (hit) return { route: hit, via: [name] };
		const deeper = climbToKnownBase(next, parentText, source, seen);
		if (deeper) return { route: deeper.route, via: [name, ...deeper.via] };
	}
	return null;
}

export interface PluginBaseOptions {
	/** Absolute path of the source. Without it the climb tier is skipped -- it has nowhere to walk. */
	file?: string;
	/** Only consulted by the climb tier. Without it recognition never touches a filesystem. */
	source?: JavaSourcePort;
}

/**
 * Recognise a family from a piece of text. Null means "no family here", which
 * the caller must be careful to report as "not recognised" rather than as "not a
 * plugin" -- the two are indistinguishable at this boundary and only one of them
 * is safe to act on.
 */
export function pluginBaseOf(text: string, options: PluginBaseOptions = {}): PluginBaseHit | null {
	const body = String(text ?? "");
	const declared = new Set(supertypesOf(body));
	const direct = PLUGIN_ROUTES.find((route) => declared.has(route.base));
	if (direct) return { route: direct, tier: "direct", via: [] };

	if (options.file !== undefined && options.source !== undefined) {
		const climbed = climbToKnownBase(options.file, body, options.source, new Set());
		if (climbed) return { route: climbed.route, tier: "climbed", via: climbed.via };
	}

	const identifiers = new Set((body.match(/[\w.]+/g) ?? []).map((token) => token.split(".").pop() ?? ""));
	const loose = PLUGIN_ROUTES.find((route) => identifiers.has(route.base));
	return loose ? { route: loose, tier: "loose", via: [] } : null;
}

export interface PluginFamily extends PluginBaseHit {
	/** One representative file, so a refusal can name who dragged the family in. */
	file: string;
}

/**
 * The distinct families a batch of sources belongs to, keyed by platform base
 * class -- never by pluginType. Two bases under one type can have different
 * event sets (AbstractPrintPlugin vs AbstractPrintSeniorPlugin), and collapsing
 * them here would let reading one family's guide clear the other.
 */
export function pluginFamiliesIn(files: readonly string[], source: JavaSourcePort): PluginFamily[] {
	const found = new Map<string, PluginFamily>();
	for (const file of files) {
		const text = source.read(file);
		if (text === "") continue;
		const hit = pluginBaseOf(text, { file, source });
		if (hit && !found.has(hit.route.base)) found.set(hit.route.base, { ...hit, file: posix(file) });
	}
	return [...found.values()];
}
