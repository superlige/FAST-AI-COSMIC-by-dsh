/** Add the built-in Cosmic layer after the two layers it patches. */
export function withCosmicDesktopBundle(bundles: readonly string[] | undefined): readonly string[] | undefined {
	if (!Array.isArray(bundles) || bundles.includes("fast-ai-cosmic")) return bundles;
	const base = bundles.lastIndexOf("@deepseek-ai/dsh-base");
	const web = bundles.lastIndexOf("@deepseek-ai/dsh-web-app");
	if (base === -1 || web === -1) return bundles;
	const after = Math.max(base, web) + 1;
	return [...bundles.slice(0, after), "fast-ai-cosmic", ...bundles.slice(after)];
}
