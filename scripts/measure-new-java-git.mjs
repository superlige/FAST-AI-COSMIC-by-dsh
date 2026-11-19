/**
 * 尺子：cosmic 会话里新建的文件，后来进没进 git。
 *
 *   node scripts/measure-new-java-git.mjs <会话.jsonl…>
 *   node scripts/measure-new-java-git.mjs --dir <会话目录> [--from 2026-09-25] [--show]
 *
 * 只看 pi 的 write 调用（edit 改不出新文件）。一个文件算「这次会话新建的」：会话里第一次 write 它之前，
 * git 历史里还没有它（`git log --diff-filter=A` 的最早一次提交晚于这次 write，或者根本没提交过）。
 * 写过之后又删掉、历史里也没有的，判断不了是不是新建的，单独记「已不在」。
 *
 * 按两类分：
 *  - **源码 Java**：`src/main/java/` 下的 `.java`——会自动登记进 git 的那一类；
 *  - **其他**：说明文档、别处的文件——不登记，只报个数。
 * 源码 Java 再按现在的状态分：已提交、只在暂存区（含 `git add -N` 登记过的）、未跟踪（漏 add 的）、已不在。
 *
 * 只读：只读会话文件和工程的 git 状态，不改工程。口径和基线见 `docs/S71-new-java-git-add.md` §2。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

const args = process.argv.slice(2);
const files = [];
let dir = null;
let from = null;
let show = false;
for (let i = 0; i < args.length; i++) {
	const arg = args[i];
	if (arg === "--dir") dir = args[++i];
	else if (arg === "--from") from = args[++i];
	else if (arg === "--show") show = true;
	else files.push(arg);
}
if (dir !== null) {
	for (const name of readdirSync(dir).sort()) {
		if (!name.endsWith(".jsonl")) continue;
		if (from !== null && name.slice(0, 10) < from) continue;
		files.push(join(dir, name));
	}
}
if (files.length === 0) {
	console.error("用法：node scripts/measure-new-java-git.mjs <会话.jsonl…> | --dir <会话目录> [--from 日期] [--show]");
	process.exit(2);
}

/** 和 `src/agent/tools/tool-path.ts` 同一套：`/d/x` 是 `D:\x`，开头的 `@` 去掉。 */
function toolFilePath(raw, root) {
	let path = raw.startsWith("@") ? raw.slice(1) : raw;
	if (process.platform === "win32" && path.startsWith("/") && !path.startsWith("//") && !path.includes("\\")) {
		const drive = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(path);
		if (drive) path = `${drive[1].toUpperCase()}:\\${(drive[2] ?? "").replace(/\//g, "\\")}`;
	}
	return isAbsolute(path) ? resolve(path) : resolve(root, path);
}

const git = (root, ...rest) => {
	try {
		return execFileSync("git", ["-C", root, ...rest], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
	} catch {
		return null;
	}
};

/** 工程根 → 相对路径（正斜杠，小写比较用）→ { file, rel, firstWrite, session } */
const writes = new Map();
for (const file of files) {
	let root = null;
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (line === "") continue;
		let row;
		try {
			row = JSON.parse(line);
		} catch {
			continue;
		}
		if (row.type === "session" && typeof row.cwd === "string") root = row.cwd;
		if (row.type !== "message" || root === null) continue;
		const content = row.message?.content;
		if (row.message?.role !== "assistant" || !Array.isArray(content)) continue;
		for (const part of content) {
			if (part?.type !== "toolCall" || part.name !== "write") continue;
			const raw = part.arguments?.path ?? part.arguments?.file_path;
			if (typeof raw !== "string") continue;
			const abs = toolFilePath(raw, root);
			const rel = relative(root, abs).replace(/\\/g, "/");
			if (rel.startsWith("..") || isAbsolute(rel)) continue;
			if (rel.toLowerCase().startsWith(".cosmic-ai/")) continue;
			const perRoot = writes.get(root) ?? new Map();
			writes.set(root, perRoot);
			const key = rel.toLowerCase();
			if (!perRoot.has(key)) perRoot.set(key, { abs, rel, firstWrite: row.timestamp, session: file });
		}
	}
}

const isSourceJava = (rel) => /\.java$/i.test(rel) && /(^|\/)src\/main\/java\//i.test(rel);

const totals = { sourceNew: 0, committed: 0, staged: 0, untracked: 0, gone: 0, otherNew: 0, otherByExt: new Map() };
const rows = [];
for (const [root, perRoot] of writes) {
	for (const entry of perRoot.values()) {
		const added = git(root, "log", "--diff-filter=A", "--format=%cI", "--", entry.rel);
		const firstAdd = added === null ? "" : (added.trim().split("\n").pop() ?? "");
		const existedBefore = firstAdd !== "" && new Date(firstAdd).getTime() < new Date(entry.firstWrite).getTime();
		if (existedBefore) continue;
		const present = existsSync(entry.abs);
		if (!isSourceJava(entry.rel)) {
			if (firstAdd !== "" || present) {
				totals.otherNew += 1;
				const ext = (/\.[^./]+$/.exec(entry.rel)?.[0] ?? "(无后缀)").toLowerCase();
				totals.otherByExt.set(ext, (totals.otherByExt.get(ext) ?? 0) + 1);
			}
			continue;
		}
		totals.sourceNew += 1;
		let state;
		if (!present && firstAdd === "") state = "已不在";
		else if (firstAdd !== "") state = "已提交";
		else if ((git(root, "ls-files", "--", entry.rel) ?? "").trim() !== "") state = "只在暂存区";
		else state = "未跟踪";
		if (state === "已提交") totals.committed += 1;
		else if (state === "只在暂存区") totals.staged += 1;
		else if (state === "未跟踪") totals.untracked += 1;
		else totals.gone += 1;
		rows.push({ state, rel: entry.rel, firstWrite: entry.firstWrite, firstAdd });
	}
}

console.log(`会话 ${files.length} 份`);
console.log(`新建的源码 Java（src/main/java 下）：${totals.sourceNew} 个`);
console.log(
	`  已提交 ${totals.committed}，只在暂存区 ${totals.staged}，未跟踪（漏 add）${totals.untracked}，已不在 ${totals.gone}`,
);
const ext = [...totals.otherByExt].map(([k, v]) => `${k} ${v}`).join("，");
console.log(`新建的其他文件（不登记）：${totals.otherNew} 个${ext === "" ? "" : `（${ext}）`}`);
if (show) {
	for (const row of rows.sort((a, b) => a.firstWrite.localeCompare(b.firstWrite))) {
		const when = row.firstAdd === "" ? "" : `  提交于 ${row.firstAdd.slice(0, 10)}`;
		console.log(`  ${row.state}\t${row.firstWrite.slice(0, 10)}  ${row.rel}${when}`);
	}
}
