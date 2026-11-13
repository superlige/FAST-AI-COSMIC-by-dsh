/**
 * Constants esbuild substitutes at build time (scripts/build.mjs `define`).
 *
 * Declared as possibly-undefined on purpose: when the entry runs straight from
 * the source tree there is no build step to substitute anything, so every read
 * must go through a `typeof` guard. Referencing an undeclared global would
 * throw ReferenceError; `typeof` on one does not, which is what makes the same
 * source run both compiled and un-compiled.
 */

/** `package.json` version, frozen into the artifact. Feeds RuntimeKey (N8). */
declare const __COSMIC_AGENT_VERSION__: string | undefined;

/** The pi version this artifact bundles. Reported by `update`; a label, not a cache key. */
declare const __PI_VERSION__: string | undefined;
