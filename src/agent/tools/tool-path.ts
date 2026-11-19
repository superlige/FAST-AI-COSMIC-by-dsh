/**
 * The file a pi `write` / `edit` call actually touched, from the path it was given.
 *
 * pi's file tools accept two spellings node's `resolve` does not: a leading `@`,
 * and on Windows a Git Bash / MSYS / WSL drive path -- `/d/work/X.java` is opened
 * as `D:\work\X.java`. Resolving the raw argument instead turns that into
 * `D:\d\work\X.java`, a file that does not exist. One delivery receipt listed the
 * same plugin three times (`/d/…`, `D:\…` and relative), and anything that asks
 * "is this file still there" would call the real one deleted.
 *
 * pi does not export its normaliser (`normalizeWindowsShellPath` in its
 * utils/paths.ts), so its two rules are mirrored here; the kernel is not touched.
 */

import { isAbsolute, posix, resolve } from "node:path";

export function toolFilePath(raw: string, root: string, platform: NodeJS.Platform = process.platform): string {
	let path = raw.startsWith("@") ? raw.slice(1) : raw;
	if (platform === "win32" && path.startsWith("/") && !path.startsWith("//") && !path.includes("\\")) {
		const drive = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(path);
		if (drive) path = `${(drive[1] as string).toUpperCase()}:\\${(drive[2] ?? "").replace(/\//g, "\\")}`;
	}
	return isAbsolute(path) ? resolve(path) : resolve(root, path);
}

/**
 * A path in the one spelling a text match can rely on: forward slashes, `.`/`..`
 * and doubled separators folded, lower case. Windows file systems ignore case, so
 * `.COSMIC-AI/Cases/x.json` is the same file as `.cosmic-ai/cases/x.json`, and a
 * guard that matched only the latter had a door in it.
 */
export function comparablePath(raw: string): string {
	const slashed = (raw.startsWith("@") ? raw.slice(1) : raw).replace(/\\/g, "/");
	return posix.normalize(slashed).toLowerCase();
}
