/**
 * Getting the knowledge pack's bytes at run time (S7.0, D13 criterion 2).
 *
 * The pack travels as a sidecar file next to the executable, not as a generated
 * TypeScript constant. Three reasons, in order of weight:
 *
 *   1. D13 criterion 2 rules out the EMBEDDED_RESOURCES shape. Even collapsed to
 *      a single base64 literal the snapshot would put a 1.4 MB string into the
 *      source tree, which tsgo, biome, vitest and esbuild would all re-read on
 *      every run for content none of them can say anything useful about.
 *   2. D12 already defines the v1 release as a reproducible ZIP/directory --
 *      exe plus brand sidecar plus licence plus pi's own resources -- so a
 *      sidecar is the shape the release already has, not a new concession.
 *   3. There is exactly one copy of the bytes. A generated module plus an
 *      on-disk pack would be two, and keeping two in agreement is the failure
 *      this codebase already pays a test to prevent for probe sources.
 *
 * The cost of the choice, stated plainly: the sidecar can be deleted, and then
 * the agent has no knowledge base. That is why absence throws KNOWLEDGE_UNAVAILABLE
 * naming the expected path instead of degrading to an empty knowledge base --
 * silently empty is defect D-3 in docs/knowledge-injection.md, and it is the one
 * failure mode this whole stage exists to remove.
 *
 * The path is passed in from the edge, never derived here from import.meta.url
 * or process.argv: the same rule that keeps loadConfig from reading process.env
 * on its own (D9).
 */
import { readFile } from "node:fs/promises";
import { KernelError } from "../kernel/errors.ts";
import { type KnowledgeSnapshot, openKnowledgePack } from "./pack.ts";

/** File name of the snapshot sidecar. Fixed, so a release layout is checkable. */
export const KNOWLEDGE_PACK_FILENAME = "cosmic-kb.pack";

/**
 * Reads and opens the snapshot. Both "no file" and "bad file" are errors, and
 * they are kept apart because they mean different things: absent is a broken
 * install, invalid is a corrupt or truncated download.
 */
export async function loadKnowledgeSnapshot(packFile: string): Promise<KnowledgeSnapshot> {
	const bytes = await readFile(packFile).catch(() => null);
	if (bytes === null) {
		throw new KernelError("KNOWLEDGE_UNAVAILABLE", `找不到内嵌知识快照：${packFile}`, {
			detail: { packFile },
			remedy: `发行物必须与 ${KNOWLEDGE_PACK_FILENAME} 同目录。开发时先运行 node scripts/export-knowledge.mjs <app-build 根目录> --write。`,
		});
	}
	return openKnowledgePack(bytes);
}
