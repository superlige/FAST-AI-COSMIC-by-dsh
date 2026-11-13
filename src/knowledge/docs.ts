/**
 * Reading the knowledge tree that is actually in force (S5.1).
 *
 * S7.0 decided WHICH tree wins (embedded snapshot vs. override) and released the
 * embedded one to disk. This module is the layer above that: given a resolved
 * root, hand the read-only commands a document view they can list, read and
 * bound-check, without any of them touching node:fs.
 *
 * Why a directory view rather than reading straight out of the pack: `show`,
 * `search` and `scenes` all hand the model an absolute path it is expected to
 * open later with its own `read` tool, and an override root is a live directory
 * that was never in a pack. One view over "a directory of Markdown" is the only
 * shape both sources share, and it keeps the commands identical in both modes --
 * a difference there would mean the embedded default and the override answer
 * differently, which is the failure D13 criterion 3 exists to make visible.
 *
 * The port is separate from the kernel's FsPort on purpose. FsPort is the effect
 * surface of the Java execution chain (D1) and every method on it is something
 * the compile/probe path needs; knowledge reading needs a Markdown walk, a byte
 * size and a symlink-resolving realpath, and none of those belong on the port
 * that governs writes into a Cosmic runtime.
 */
import { type Dirent, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export interface KnowledgeDocsPort {
	/** Markdown files under a directory, absolute, symlinks skipped. */
	walkMarkdown(dir: string): string[];
	/** UTF-8 text with a leading BOM stripped, or null when unreadable. */
	read(file: string): string | null;
	/** Byte size, or null when the path does not exist. */
	size(file: string): number | null;
	isFile(path: string): boolean;
	isDirectory(path: string): boolean;
	/** Symlinks resolved, or null when the path does not exist. */
	realPath(path: string): string | null;
}

/** Forward slashes everywhere: knowledge paths are quoted back to the user and compared as strings. */
export function toPosix(path: string): string {
	return path.split(sep).join("/").split("\\").join("/");
}

export const nodeKnowledgeDocs: KnowledgeDocsPort = {
	walkMarkdown(dir) {
		const out: string[] = [];
		const walk = (current: string): void => {
			let entries: Dirent[];
			try {
				entries = readdirSync(current, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				const file = join(current, entry.name);
				// Symlinks are skipped rather than followed: an override root is a
				// directory the user maintains, and a link out of it would put files
				// the bound check never saw into the answer.
				if (entry.isSymbolicLink()) continue;
				if (entry.isDirectory()) walk(file);
				else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) out.push(file);
			}
		};
		walk(dir);
		return out;
	},
	read(file) {
		try {
			return readFileSync(file, "utf8").replace(/^\uFEFF/, "");
		} catch {
			return null;
		}
	},
	size(file) {
		try {
			return statSync(file).size;
		} catch {
			return null;
		}
	},
	isFile(path) {
		try {
			return statSync(path).isFile();
		} catch {
			return false;
		}
	},
	isDirectory(path) {
		try {
			return statSync(path).isDirectory();
		} catch {
			return false;
		}
	},
	realPath(path) {
		try {
			return realpathSync(path);
		} catch {
			return null;
		}
	},
};

export interface KnowledgeDoc {
	/** Absolute path on disk. What the model is told to open. */
	file: string;
	/** Path relative to the knowledge root, forward slashes. */
	relativePath: string;
	bytes: number;
}

/**
 * A knowledge tree, rooted. Every command below takes one of these instead of a
 * path, so no command can decide for itself which tree it reads.
 */
export interface KnowledgeBase {
	/** The directory in force: the released snapshot, or the override. */
	root: string;
	/** Cached inventory; the tree does not change under one command. */
	docs(): readonly KnowledgeDoc[];
	/** Absolute path of a relative document path, without checking existence. */
	pathOf(relativePath: string): string;
	/** Text of a relative document path, or null when absent. */
	read(relativePath: string): string | null;
	exists(relativePath: string): boolean;
}

function inside(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function openKnowledgeBase(root: string, port: KnowledgeDocsPort): KnowledgeBase {
	const realRoot = port.realPath(root) ?? resolve(root);
	let inventory: KnowledgeDoc[] | null = null;
	return {
		root: realRoot,
		docs() {
			if (inventory === null) {
				inventory = port
					.walkMarkdown(realRoot)
					.sort()
					.map((file) => ({ file, relativePath: toPosix(relative(realRoot, file)), bytes: port.size(file) ?? 0 }));
			}
			return inventory;
		},
		pathOf(relativePath) {
			return resolve(realRoot, ...relativePath.split("/"));
		},
		read(relativePath) {
			return port.read(resolve(realRoot, ...relativePath.split("/")));
		},
		exists(relativePath) {
			return port.isFile(resolve(realRoot, ...relativePath.split("/")));
		},
	};
}

export type ResolvedDocPath = { ok: true; file: string; relativePath: string } | { ok: false; reason: string };

/**
 * Bound check for a caller-supplied relative path (`knowledge show`).
 *
 * Ported from the frozen knowledgeShow, including the second check after
 * realpath: rejecting `..` before resolving symlinks is not enough, because a
 * symlinked directory inside the root can still point out of it.
 */
export function resolveDocPath(base: KnowledgeBase, input: string, port: KnowledgeDocsPort): ResolvedDocPath {
	const raw = input.trim();
	if (raw === "" || isAbsolute(raw) || !raw.toLowerCase().endsWith(".md")) {
		return { ok: false, reason: "show 只接受知识根目录内的 Markdown 相对路径" };
	}
	const target = resolve(base.root, ...toPosix(raw).split("/"));
	if (!inside(base.root, target) || !port.isFile(target)) {
		return { ok: false, reason: "路径不存在或越过知识根目录" };
	}
	const real = port.realPath(target);
	if (real === null || !inside(base.root, real) || !port.isFile(real)) {
		return { ok: false, reason: "路径逃逸或不是文件" };
	}
	return { ok: true, file: real, relativePath: toPosix(relative(base.root, real)) };
}
