/**
 * Keeps a project's cosmic files where S19 puts them.
 *
 * Runs on every open, which is every tool call, so the common case -- nothing
 * left in the old places, `.gitignore` already complete -- must cost a handful
 * of `exists` checks and one small read, and say nothing.
 *
 * Two jobs:
 *
 *   1. **Move what older releases left under `build/`.** Only the files worth
 *      keeping move: filed verify results and receipts (re-verifying costs a run
 *      against the shared environment) and the impact index with its metadata
 *      side (a full rebuild needs the shared environment too). Files nothing
 *      reads any more are deleted. When the new place already has a file of the
 *      same name, the new one wins: it was written by this release.
 *
 *   2. **Keep `.cosmic-ai/.gitignore` complete.** It used to ignore only
 *      `config.json`, so on a project whose own `.gitignore` did not cover
 *      `.cosmic-ai/`, raw verify logs -- customer data -- were one `git add .`
 *      away from the repository. Existing lines are kept; missing ones are
 *      appended.
 *
 * The old write lock is never touched. A lock at the old path belongs to an older
 * release that may still be running; deleting it would be the one move here that
 * could let two writers in. It is reported instead.
 */

import { basename, dirname, join } from "node:path";
import type { KernelLayout } from "../layout.ts";
import type { FsPort } from "../ports.ts";

/**
 * Lines `.cosmic-ai/.gitignore` must contain.
 *
 * Everything cosmic writes per project is ignored. Until S22 `cases/` was the
 * one exception -- a directory of assets meant for Git -- and retiring the case
 * set removed it; nothing here is meant to be committed any more.
 */
export const COSMIC_IGNORE_LINES = ["/config.json", "/evidence/", "/work/", "/probes/"] as const;

export interface LayoutUpkeep {
	/** Old paths moved to the new layout (files, root-relative with forward slashes). */
	moved: string[];
	/** Old paths deleted because nothing reads them any more. */
	removed: string[];
	/** Whether `.cosmic-ai/.gitignore` was created or extended. */
	gitignoreChanged: boolean;
	/** One line each, for the open report. Empty when there was nothing to do. */
	notes: string[];
}

/** Appends whatever of `COSMIC_IGNORE_LINES` is missing. Returns the file and whether it changed. */
export function ensureCosmicIgnore(cosmicDir: string, fs: FsPort): { file: string; changed: boolean } {
	const file = join(cosmicDir, ".gitignore");
	const raw = fs.read(file);
	const lines = raw.replace(/\r\n/g, "\n").split("\n");
	const missing = COSMIC_IGNORE_LINES.filter((line) => !lines.includes(line));
	if (missing.length === 0) return { file, changed: false };
	const prefix = raw !== "" && !raw.endsWith("\n") ? `${raw}\n` : raw;
	fs.write(file, `${prefix}${missing.join("\n")}\n`);
	return { file, changed: true };
}

export function upkeepProjectLayout(layout: KernelLayout, fs: FsPort): LayoutUpkeep {
	const build = layout.projectBuild;
	const rel = (path: string): string => {
		const norm = path.replace(/\\/g, "/");
		const root = layout.root.replace(/\\/g, "/").replace(/\/$/, "");
		return norm.startsWith(`${root}/`) ? norm.slice(root.length + 1) : norm;
	};
	const moved: string[] = [];
	const removed: string[] = [];

	const moveFile = (from: string, to: string): void => {
		if (!fs.exists(from)) return;
		if (fs.exists(to)) {
			fs.remove(from);
			removed.push(rel(from));
			return;
		}
		if (fs.tryRename(from, to)) moved.push(rel(from));
	};
	const moveTree = (from: string, to: string): void => {
		if (!fs.exists(from)) return;
		for (const entry of fs.readDir(from)) {
			const source = join(from, entry.name);
			if (entry.isDirectory) moveTree(source, join(to, entry.name));
			else moveFile(source, join(to, entry.name));
		}
		if (fs.readDir(from).length === 0) fs.remove(from);
	};
	const drop = (path: string): void => {
		if (!fs.exists(path)) return;
		fs.remove(path);
		removed.push(rel(path));
	};

	// 旧版 build/verify/ 里只剩回执值得搬：`results/` 和 `latest.json` 存的是用例集执行结果，
	// S22 之后没有任何命令会读它们。也不顺手删——那是别人工程里的文件，不读就是不读。
	const oldVerify = join(build, "verify");
	if (fs.exists(oldVerify)) {
		for (const entry of fs.readDir(oldVerify)) {
			if (!entry.isDirectory && /^receipt-.+\.json$/.test(entry.name)) {
				moveFile(join(oldVerify, entry.name), join(layout.verifyDir, entry.name));
			}
		}
		if (fs.readDir(oldVerify).length === 0) fs.remove(oldVerify);
	}
	moveFile(join(build, "impact.json"), layout.impactIndex);
	moveTree(join(build, "cosmic-impact"), layout.impactWork);
	moveTree(join(build, "cosmic-knowledge-capsules"), dirname(layout.knowledgeCapsules));
	moveTree(join(build, "cosmic-out"), layout.outputDir);
	drop(join(build, "metadata-catalog.json"));
	drop(join(build, "cosmic-plugin-brief"));

	const ignore = ensureCosmicIgnore(layout.cosmicDir, fs);
	const notes: string[] = [];
	if (moved.length > 0 || removed.length > 0) {
		notes.push(
			`旧版放在 build/ 下的 cosmic 文件已搬到 .cosmic-ai/：搬了 ${moved.length} 个，删了 ${removed.length} 个没人再读或新位置已有的（build/ 以后只剩 Gradle 生成的两个文件）`,
		);
	}
	const oldLock = join(build, "cosmic-agent-write.lock");
	if (fs.exists(oldLock)) {
		notes.push(
			`build/ 下还有一把旧版的写锁 ${basename(oldLock)}，没有动它：可能有旧版本的窗口还在写这个工程。确认没有之后可以手动删掉。`,
		);
	}
	return { moved, removed, gitignoreChanged: ignore.changed, notes };
}
