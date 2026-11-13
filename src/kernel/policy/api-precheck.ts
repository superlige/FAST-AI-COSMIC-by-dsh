/**
 * Exact import extraction for the ad-hoc probe prepare step.
 *
 * An ad-hoc probe has no package, so every 苍穹 class it leans on has to be
 * imported by name. That import list is therefore an exact, cheap answer to
 * "which APIs is this probe betting on". S15 answers that question automatically:
 * the prepare step batches the classes into one doc/JAR join and returns concrete
 * class/method/argument blockers before the Cosmic JVM starts. No session-level
 * "the model looked this up" ledger participates in admission.
 *
 * Only ad-hoc probes pass through here. A released probe is reviewed code whose
 * imports were settled when it was reviewed.
 */

import { blankJavaNoise } from "./probe-scan.ts";

/** Package prefix that marks a 苍穹 platform class. Nothing else is gated. */
const COSMIC_PACKAGE = "kd.";

const IMPORT_LINE = /^\s*import\s+(static\s+)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\.\*)?)\s*;/;

export interface ProbeImports {
	/** Fully qualified 苍穹 classes the probe imports, deduplicated and sorted. */
	classes: string[];
	/** Wildcard 苍穹 imports, which the precheck cannot resolve to classes. */
	wildcards: string[];
}

/**
 * The 苍穹 classes an ad-hoc probe imports.
 *
 * Comments and string literals are blanked first, for the same reason the write
 * scan blanks them: a probe that documents "别 import kd.bos.xxx" is talking
 * about an import, not performing one.
 *
 * A static import names a member, so its class is the FQCN minus the last
 * segment. A wildcard import names no class at all and is reported separately.
 */
export function probeImports(source: string): ProbeImports {
	const classes = new Set<string>();
	const wildcards = new Set<string>();
	for (const line of blankJavaNoise(source).split("\n")) {
		const match = IMPORT_LINE.exec(line);
		if (match === null) continue;
		const imported = match[2] as string;
		if (!imported.startsWith(COSMIC_PACKAGE)) continue;
		if (imported.endsWith(".*")) {
			wildcards.add(imported);
			continue;
		}
		if (match[1] === undefined) {
			classes.add(imported);
			continue;
		}
		// `import static kd.bos.X.method;` -- the class is everything but the member.
		const cut = imported.lastIndexOf(".");
		if (cut > 0) classes.add(imported.slice(0, cut));
	}
	return { classes: [...classes].sort(), wildcards: [...wildcards].sort() };
}
