/**
 * 新建的工程源码 Java 写完就登记进 git（`git add -N`，S71）。
 *
 * 改已有文件 git 本来就盯着；新文件 git 不认识，只出现在「未跟踪」里，和工程里别的未跟踪文件
 * （导出的文档、字体、临时文件）混在一起，提交时要人一个个找出来 add，容易漏。
 *
 * 只登记「这次 write 之前不存在、放在 `src/main/java/` 下的 `.java`」：
 *   - 说明文档、配置、别处的文件一概不碰——有的不该进 git，进不进由人定；
 *   - `-N` 只登记「有这个新文件」，内容不进暂存区：`git status` 把它列成新文件、`git diff` 看得到全文，
 *     提交时照样由人审、由人提交；
 *   - 被 `.gitignore` 排除的、工程不在 git 里的，git 自己会拒，拒了就算了，写文件照常。
 *
 * 登记过的文件之后又被删了，git 会一直挂着一条「已删除」。所以记下本次会话登记过哪些，
 * 每次工具调用之后看一眼还在不在；不在了、而且暂存区里还是登记时那个空内容，就撤掉登记。
 * 人已经真 add 过内容的不撤——那是人的操作。
 */

import { execFile } from "node:child_process";
import { relative } from "node:path";
import { nodeFs } from "../../kernel/ports.ts";

/** git 给空内容算的对象号：`-N` 登记的条目在暂存区里就是它。 */
const EMPTY_BLOB = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";

export type GitRunner = (root: string, args: readonly string[]) => Promise<{ ok: boolean; stdout: string }>;

const runGit: GitRunner = (root, args) =>
	new Promise((done) => {
		execFile("git", ["-C", root, ...args], { timeout: 10_000, windowsHide: true }, (error, stdout) => {
			done({ ok: error === null, stdout: String(stdout) });
		});
	});

/** 工程里的相对路径（正斜杠）；不在工程里返回 null。 */
function relativeInside(root: string, file: string): string | null {
	const rel = relative(root, file).replace(/\\/g, "/");
	if (rel === "" || rel.startsWith("../") || rel === ".." || /^[a-z]:/i.test(rel) || rel.startsWith("/")) return null;
	return rel;
}

/** 这个文件是不是会被登记的那一类：工程里、`src/main/java/` 下的 `.java`。 */
export function isSourceJava(root: string, file: string): boolean {
	const rel = relativeInside(root, file);
	return rel !== null && /\.java$/i.test(rel) && /(^|\/)src\/main\/java\//i.test(rel);
}

export interface GitNewJava {
	/** write 发出去之前：文件还不存在、又是源码 Java，就记成「这次新建」。 */
	beforeWrite(root: string, file: string): void;
	/** write 成功之后：是这次新建的就登记。返回登记上了没有。 */
	afterWrite(root: string, file: string): Promise<boolean>;
	/** 每次工具调用之后：本次会话登记过、现在不在了的，撤掉登记。返回撤了几个。 */
	sweep(): Promise<number>;
}

export function createGitNewJava(options: { git?: GitRunner; exists?: (file: string) => boolean } = {}): GitNewJava {
	const git = options.git ?? runGit;
	const exists = options.exists ?? ((file: string) => nodeFs.exists(file));
	const pending = new Set<string>();
	/** 文件 → 工程根 */
	const registered = new Map<string, string>();
	return {
		beforeWrite(root, file) {
			if (!isSourceJava(root, file)) return;
			if (exists(file)) pending.delete(file);
			else pending.add(file);
		},
		async afterWrite(root, file) {
			if (!pending.delete(file)) return false;
			const rel = relativeInside(root, file);
			if (rel === null) return false;
			const added = await git(root, ["add", "--intent-to-add", "--", rel]);
			if (added.ok) registered.set(file, root);
			return added.ok;
		},
		async sweep() {
			let dropped = 0;
			for (const [file, root] of registered) {
				if (exists(file)) continue;
				registered.delete(file);
				const rel = relativeInside(root, file);
				if (rel === null) continue;
				const staged = await git(root, ["ls-files", "--stage", "--", rel]);
				if (!staged.ok || !staged.stdout.includes(EMPTY_BLOB)) continue;
				const removed = await git(root, ["rm", "--cached", "--quiet", "--", rel]);
				if (removed.ok) dropped += 1;
			}
			return dropped;
		},
	};
}
