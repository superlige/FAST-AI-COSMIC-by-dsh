/** Public product identity. Internal cosmic_* protocols remain stable by design. */

export const PRODUCT_ID = "fast-ai-cosmic";
export const PRODUCT_DISPLAY_NAME = "fast-ai-cosmic";
/** Human-facing title case. Package, command and binary names remain lowercase. */
export const PRODUCT_LOGO_NAME = "Fast-AI-COSMIC";
/**
 * The startup art draws the mark; the tag carries the rest of the name beneath
 * it. Split because the whole wordmark in a legible face is wider than the
 * terminal -- see src/agent/ui/banner.ts.
 */
export const PRODUCT_LOGO_MARK = "COSMIC";
export const PRODUCT_LOGO_TAG = "F A S T · A I";

/** 一行说清是什么，和一行说清怎么干活的。欢迎页只放这两句。 */
export const PRODUCT_SUBTITLE = "金蝶云·苍穹开发智能体";
export const PRODUCT_TAGLINE = "构建，在真实环境中验证";

/** Build scripts append platform extensions and temporary stage suffixes. */
export const PRODUCT_BINARY_BASENAME = "fast-ai-cosmic";
