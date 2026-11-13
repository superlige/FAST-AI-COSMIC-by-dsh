/**
 * A `KnowledgeBase` backed by a `.pack` snapshot, without releasing it to disk.
 *
 * The production path releases the snapshot to a cache directory because the
 * model has to be able to `read` a document by absolute path. A test does not,
 * and paying a 1,763-file extraction per test file would make the real-corpus
 * tests slow enough that someone would eventually delete them.
 */

import { type KnowledgeBase, type KnowledgeDocsPort, openKnowledgeBase, toPosix } from "../../src/knowledge/docs.ts";
import type { KnowledgeSnapshot } from "../../src/knowledge/pack.ts";

/** Virtual root. Absolute so `resolve` behaves the way it does in production. */
const ROOT = process.platform === "win32" ? "C:/knowledge-snapshot" : "/knowledge-snapshot";

export function snapshotKnowledgeBase(snapshot: KnowledgeSnapshot): KnowledgeBase {
	const relativeOf = (file: string): string | null => {
		const posix = toPosix(file);
		if (!posix.startsWith(`${ROOT}/`)) return null;
		return posix.slice(ROOT.length + 1);
	};
	const port: KnowledgeDocsPort = {
		walkMarkdown: () => snapshot.paths.map((path) => `${ROOT}/${path}`),
		read: (file) => {
			const relative = relativeOf(file);
			return relative === null ? null : snapshot.read(relative);
		},
		size: (file) => {
			const relative = relativeOf(file);
			const text = relative === null ? null : snapshot.read(relative);
			return text === null ? null : Buffer.byteLength(text, "utf8");
		},
		isFile: (path) => {
			const relative = relativeOf(path);
			return relative !== null && snapshot.read(relative) !== null;
		},
		isDirectory: (path) => toPosix(path) === ROOT,
		realPath: (path) => (toPosix(path) === ROOT ? ROOT : null),
	};
	return openKnowledgeBase(ROOT, port);
}
