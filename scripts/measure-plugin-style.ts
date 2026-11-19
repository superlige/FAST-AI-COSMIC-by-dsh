/**
 * 尺子：插件代码的写法问题——类太长、方法太长、已有常量还写字符串、循环里查库查缓存、加了多少新插件类。
 *
 * 用法：
 *   node --experimental-strip-types scripts/measure-plugin-style.ts --project <工程目录> [--isv <前缀>]
 *        [<会话.jsonl…> | --dir <会话目录> [--from YYYY-MM-DD] [--to YYYY-MM-DD]] [--json] [--show]
 *
 * 两部分：
 *
 * 一、工程现状（按现在的源码，只读）：每个插件类的行数、最长方法、方法超线的个数；
 *     插件里直接写的本工程编码字符串（`<前缀>_` 开头），常量类里已经有同值常量的有几处、其中本文件已经在用那个常量类的有几处；
 *     插件自己又声明了一份常量类里已有的值；循环里直接查库（各种 ServiceHelper、DB、ORM、微服务调用）、
 *     经本文件的方法间接查库、循环里查缓存、循环里刷新界面；同一张单同一类插件挂了几个类（有代码关系表时）。
 *
 * 二、会话里模型写的代码（只算它这次新加的）：逐份会话回放 write / edit，工程代码模块里的 .java：
 *     改之前的样子取会话开始时工程 git 里的版本（新文件为空），一路套上 write 和 edit 得到改之后的样子，
 *     两边各跑一遍同样的检查，改之后比改之前多出来的就是这次新加的问题。
 *     会话开始时文件有没提交的改动、edit 的原文对不上，这个文件就回放不了，单独计数，不硬算。
 *
 * 检查和写完就查、编译前兜底用的是同一份代码（`src/kernel/style/plugin-style.ts`），源码级、不连环境、不编译：
 *   - 循环：for / while / do 的循环体，和 `.forEach(` 的参数；
 *   - 查库：`XxxServiceHelper.方法(`（缓存那几个除外）、`DB.`、`ORM.create`、`DispatchServiceHelper.invoke…`；
 *   - 查缓存：`loadFromCache`、`loadSingleFromCache`、`EntityMetadataCache.`、`MetadataServiceHelper.`、`CacheFactory.`；
 *   - 间接：循环里调了本文件的某个方法、那个方法（一路往下）查库；或调了别的类的静态方法、代码关系表说它查库
 *     （`--no-index` 不看关系表，和 2026-10-08 的基线同口径）；
 *   - 常量类：类名以 Con / Const / Constant(s) / Consts 结尾，或者没有方法、至少 3 个字符串常量。
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { isCode, outlineJava, scanJava } from "../src/kernel/impact/java-outline.ts";
import { nodeFs } from "../src/kernel/ports.ts";
import {
	analyseStyle,
	CLASS_LINE_LIMIT,
	METHOD_LINE_LIMIT,
	type StyleHit,
	styleDelta,
} from "../src/kernel/style/plugin-style.ts";
import { loadStyleProject, styleEnvFor } from "../src/kernel/style/style-env.ts";
import { sourceRootsOf } from "../src/knowledge/class-surroundings.ts";
import { pluginBaseOf } from "../src/knowledge/plugin-base.ts";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
	const at = args.indexOf(name);
	return at < 0 ? undefined : args[at + 1];
};
const json = args.includes("--json");
const show = args.includes("--show");
const project = flag("--project");
const dir = flag("--dir");
const from = flag("--from");
const to = flag("--to");
const noIndex = args.includes("--no-index");
const valued = new Set(["--project", "--dir", "--from", "--to"]);
const sessionFiles = args.filter((arg, at) => arg.endsWith(".jsonl") && !valued.has(args[at - 1] ?? ""));
if (dir !== undefined) {
	for (const name of readdirSync(dir).sort()) {
		if (!name.endsWith(".jsonl")) continue;
		const day = name.slice(0, 10);
		if (from !== undefined && day < from) continue;
		if (to !== undefined && day > to) continue;
		sessionFiles.push(join(dir, name));
	}
}
if (project === undefined) {
	console.error(
		"用法：measure-plugin-style.ts --project <工程目录> [--isv <前缀>] [<会话.jsonl…> | --dir <目录> [--from 日期] [--to 日期]] [--json] [--show]",
	);
	process.exit(2);
}
const root = project.replace(/\\/g, "/").replace(/\/$/, "");

const CLASS_LINES = [CLASS_LINE_LIMIT, 1000];
const METHOD_LINES = [50, METHOD_LINE_LIMIT, 150];
type Hit = StyleHit;

// ── 工程现状 ──────────────────────────────────────────────────────────────

const javaFiles: string[] = [];
const sourceDirs = sourceRootsOf(root, nodeFs);
for (const src of sourceDirs) javaFiles.push(...nodeFs.listJavaFiles(src));
const styleProject = loadStyleProject(nodeFs, sourceDirs, noIndex ? null : `${root}/.cosmic-ai/work/impact.json`);
const isv = styleProject.consts.isv;
const envOf = (file: string) => styleEnvFor(styleProject, file);

/** 本工程编码字符串直接出现的次数（不含常量声明行） */
function isvLiterals(text: string): number {
	const outline = outlineJava(text);
	const scanned = scanJava(text);
	if (outline === null || scanned === null) return 0;
	const constLines = new Set(outline.constants.map((c) => c.line));
	let count = 0;
	let line = 1;
	let at = 0;
	for (const literal of scanned.literals) {
		while (at < literal.offset) if (text[at++] === "\n") line++;
		if (isCode(literal.value) && literal.value.startsWith(`${isv}_`) && !constLines.has(line)) count++;
	}
	return count;
}

interface PluginRow {
	file: string;
	base: string;
	report: NonNullable<ReturnType<typeof analyseStyle>> & { isvLiterals: number };
}
const plugins: PluginRow[] = [];
let unparsed = 0;
for (const file of javaFiles) {
	const text = nodeFs.read(file);
	const hit = pluginBaseOf(text, { file, source: nodeFs });
	if (hit === null || hit.tier === "loose") continue;
	const report = analyseStyle(text, envOf(file));
	if (report === null) {
		unparsed++;
		continue;
	}
	plugins.push({
		file: file.replace(/\\/g, "/").replace(`${root}/`, ""),
		base: hit.route.base,
		report: { ...report, isvLiterals: isvLiterals(text.replace(/\r\n/g, "\n")) },
	});
}

const quantile = (values: number[], q: number): number => {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
};
const tallyHits = (rows: Hit[][]) => {
	const out: Record<string, { hits: number; files: number }> = {};
	for (const hits of rows) {
		const kinds = new Set<string>();
		for (const hit of hits) {
			const kind = hit.exempt === null ? hit.kind : `${hit.kind}(豁免)`;
			out[kind] = out[kind] ?? { hits: 0, files: 0 };
			(out[kind] as { hits: number }).hits++;
			kinds.add(kind);
		}
		for (const kind of kinds) (out[kind] as { files: number }).files++;
	}
	return out;
};

const classLines = plugins.map((p) => p.report.lines);
const longest = plugins.map((p) => Math.max(0, ...p.report.methods.map((m) => m.lines)));
const projectSummary = {
	root,
	isv,
	javaFiles: javaFiles.length,
	constantClasses: styleProject.consts.classes.size,
	constantValues: styleProject.consts.byValue.size,
	crossFile: styleProject.hasIndex,
	pluginClasses: plugins.length,
	unparsed,
	classLines: {
		p50: quantile(classLines, 0.5),
		p90: quantile(classLines, 0.9),
		max: Math.max(0, ...classLines),
		over: Object.fromEntries(CLASS_LINES.map((n) => [n, classLines.filter((v) => v > n).length])),
	},
	longestMethod: {
		p50: quantile(longest, 0.5),
		p90: quantile(longest, 0.9),
		max: Math.max(0, ...longest),
		methodsOver: Object.fromEntries(
			METHOD_LINES.map((n) => [
				n,
				plugins.reduce((sum, p) => sum + p.report.methods.filter((m) => m.lines > n).length, 0),
			]),
		),
		classesWithMethodOver: Object.fromEntries(METHOD_LINES.map((n) => [n, longest.filter((v) => v > n).length])),
	},
	isvLiterals: plugins.reduce((sum, p) => sum + p.report.isvLiterals, 0),
	hits: tallyHits(plugins.map((p) => p.report.hits)),
	pluginsPerBill: null as null | Record<string, number>,
	crowdedBills: [] as string[],
};

const impactFile = `${root}/.cosmic-ai/work/impact.json`;
if (nodeFs.exists(impactFile)) {
	const impact = JSON.parse(readFileSync(impactFile, "utf8")) as {
		classes: { class: string; pluginType?: string; bindings?: { entity: string; kind: string }[] }[];
	};
	const per = new Map<string, Set<string>>();
	for (const c of impact.classes) {
		for (const b of c.bindings ?? []) {
			const key = `${b.entity} 的${c.pluginType ?? "?"}插件`;
			const set = per.get(key) ?? new Set<string>();
			set.add(c.class);
			per.set(key, set);
		}
	}
	const dist: Record<string, number> = {};
	for (const set of per.values()) {
		const bucket = set.size >= 5 ? "5+" : String(set.size);
		dist[bucket] = (dist[bucket] ?? 0) + 1;
	}
	projectSummary.pluginsPerBill = dist;
	projectSummary.crowdedBills = [...per]
		.filter(([, set]) => set.size >= 4)
		.sort((a, b) => b[1].size - a[1].size)
		.map(([key, set]) => `${key} ${set.size} 个`);
}

// ── 会话回放 ──────────────────────────────────────────────────────────────

interface FileChange {
	file: string;
	created: boolean;
	plugin: string | null;
	replayed: boolean;
	reason?: string;
	linesBefore: number;
	linesAfter: number;
	newHits: Hit[];
	/** 这次新出现或从线下长过线的方法（按 METHOD_LINES[1]） */
	newLongMethods: { label: string; lines: number }[];
}

interface SessionRow {
	session: string;
	files: FileChange[];
	/** 第一次写工程代码是第几轮（一条模型回复算一轮） */
	firstWriteRound: number;
	/** 第一次收到插件知识卡片是第几轮；没收到为 null */
	cardRound: number | null;
	/** 第一次写工程代码之前收到过类周边 */
	surroundingsBeforeWrite: boolean;
}

const git = (gitArgs: string[]): string | null => {
	try {
		return execFileSync("git", ["-C", root, ...gitArgs], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	} catch {
		return null;
	}
};

const isProjectCode = (rel: string): boolean =>
	/(^|\/)src\/main\/java\/.+\.java$/.test(rel) && !rel.startsWith(".cosmic-ai/") && !rel.startsWith("build/");

function relPath(path: string, cwd: string): string | null {
	const posix = path.replace(/\\/g, "/");
	const abs = isAbsolute(path) ? posix : `${cwd.replace(/\\/g, "/").replace(/\/$/, "")}/${posix.replace(/^\.\//, "")}`;
	const lower = abs.toLowerCase();
	const base = `${root.toLowerCase()}/`;
	return lower.startsWith(base) ? abs.slice(base.length) : null;
}

const sessions: SessionRow[] = [];
/** 改工程代码的那一轮用了多久：上一条记录到这条模型回复的间隔（模型想 + 写出这次修改）。 */
const editSeconds: number[] = [];
for (const sessionFile of sessionFiles) {
	const rows = readFileSync(sessionFile, "utf8").split("\n").filter(Boolean);
	let started = "";
	let cwd = root;
	type Op = { id: string; tool: "write" | "edit"; rel: string; args: Record<string, unknown> };
	const ops: Op[] = [];
	const failed = new Set<string>();
	let round = 0;
	let firstWriteRound = 0;
	let cardRound: number | null = null;
	let surroundingsSeen = false;
	let surroundingsBeforeWrite = false;
	let previousAt: number | null = null;
	for (const row of rows) {
		let entry: {
			type?: string;
			timestamp?: string;
			cwd?: string;
			message?: { role?: string; content?: unknown; toolCallId?: string; isError?: boolean };
		};
		try {
			entry = JSON.parse(row);
		} catch {
			continue;
		}
		if (entry.type === "session") {
			started = entry.timestamp ?? "";
			cwd = entry.cwd ?? root;
			continue;
		}
		const message = entry.message;
		const at = entry.timestamp === undefined ? null : Date.parse(entry.timestamp);
		const since = at !== null && previousAt !== null ? (at - previousAt) / 1000 : null;
		if (at !== null) previousAt = at;
		if (message?.role === "toolResult" && message.isError === true && message.toolCallId)
			failed.add(message.toolCallId);
		if (message?.role === "toolResult") {
			const text = JSON.stringify(message.content ?? "");
			if (cardRound === null && text.includes("Knowledge Capsule · plugin")) cardRound = round;
			if (text.includes("的周边（按本工程源码算")) surroundingsSeen = true;
		}
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		round++;
		for (const part of message.content as {
			type?: string;
			name?: string;
			id?: string;
			arguments?: Record<string, unknown>;
		}[]) {
			if (part.type !== "toolCall" || (part.name !== "write" && part.name !== "edit")) continue;
			const path = String(part.arguments?.path ?? part.arguments?.file_path ?? "");
			const rel = relPath(path, cwd);
			if (rel === null || !isProjectCode(rel)) continue;
			if (firstWriteRound === 0) {
				firstWriteRound = round;
				surroundingsBeforeWrite = surroundingsSeen;
			}
			if (part.name === "edit" && since !== null) editSeconds.push(since);
			ops.push({ id: part.id ?? "", tool: part.name, rel, args: part.arguments ?? {} });
		}
	}
	const byFile = new Map<string, Op[]>();
	for (const op of ops) {
		if (failed.has(op.id)) continue;
		const list = byFile.get(op.rel) ?? [];
		list.push(op);
		byFile.set(op.rel, list);
	}
	if (byFile.size === 0) continue;
	const session: SessionRow = {
		session: sessionFile.replace(/\\/g, "/").split("/").pop() ?? sessionFile,
		files: [],
		firstWriteRound,
		cardRound,
		surroundingsBeforeWrite,
	};
	sessions.push(session);
	for (const [rel, fileOps] of byFile) {
		const rev = git(["rev-list", "-1", `--before=${started}`, "HEAD", "--", rel])?.trim() ?? "";
		const before = rev === "" ? null : git(["show", `${rev}:${rel}`]);
		const change: FileChange = {
			file: rel,
			created: before === null,
			plugin: null,
			replayed: true,
			linesBefore: before === null ? 0 : before.split("\n").length,
			linesAfter: 0,
			newHits: [],
			newLongMethods: [],
		};
		session.files.push(change);
		let text = before === null ? null : before.replace(/\r\n/g, "\n");
		for (const op of fileOps) {
			if (op.tool === "write") {
				text = String(op.args.content ?? "").replace(/\r\n/g, "\n");
				continue;
			}
			if (text === null) {
				change.replayed = false;
				change.reason = "会话开始时 git 里没有这个文件，第一次就是 edit";
				break;
			}
			const edits = (op.args.edits as { oldText?: string; newText?: string }[] | undefined) ?? [
				{ oldText: String(op.args.oldText ?? ""), newText: String(op.args.newText ?? "") },
			];
			for (const edit of edits) {
				const oldText = String(edit.oldText ?? "").replace(/\r\n/g, "\n");
				const at: number = oldText === "" ? -1 : text.indexOf(oldText);
				if (at < 0) {
					change.replayed = false;
					change.reason = "edit 的原文和 git 版本对不上（会话开始时多半有没提交的改动）";
					break;
				}
				text =
					text.slice(0, at) + String(edit.newText ?? "").replace(/\r\n/g, "\n") + text.slice(at + oldText.length);
			}
			if (!change.replayed) break;
		}
		if (!change.replayed || text === null) continue;
		const delta = styleDelta(before === null ? null : before.replace(/\r\n/g, "\n"), text, envOf(rel));
		if (delta === null) {
			change.replayed = false;
			change.reason = "改之后的源码解析不了";
			continue;
		}
		change.linesAfter = delta.linesAfter;
		const hit = pluginBaseOf(text, { file: `${root}/${rel}`, source: nodeFs });
		change.plugin = hit === null || hit.tier === "loose" ? null : hit.route.base;
		change.newHits.push(...delta.added);
		change.newLongMethods.push(...delta.newLongMethods);
	}
}

// ── 输出 ──────────────────────────────────────────────────────────────────

const touched = sessions.flatMap((s) => s.files);
const replayed = touched.filter((f) => f.replayed);
const sessionSummary = {
	sessions: sessionFiles.length,
	sessionsWritingCode: sessions.length,
	filesTouched: touched.length,
	filesReplayed: replayed.length,
	notReplayed: touched.filter((f) => !f.replayed).map((f) => `${f.file}：${f.reason}`),
	newFiles: touched.filter((f) => f.created).length,
	cardBeforeFirstWrite: sessions.filter((s) => s.cardRound !== null && s.cardRound < s.firstWriteRound).length,
	surroundingsBeforeFirstWrite: sessions.filter((s) => s.surroundingsBeforeWrite).length,
	cardRounds: sessions
		.filter((s) => s.cardRound !== null && s.cardRound < s.firstWriteRound)
		.map((s) => `${s.session.slice(0, 16)} 卡片第 ${s.cardRound} 轮、第一次写第 ${s.firstWriteRound} 轮`),
	editRoundSeconds: {
		count: editSeconds.length,
		p50: quantile(editSeconds, 0.5),
		p75: quantile(editSeconds, 0.75),
		p90: quantile(editSeconds, 0.9),
	},
	newPluginClasses: touched.filter((f) => f.created && f.plugin !== null).map((f) => `${f.file}（${f.plugin}）`),
	newHits: tallyHits(replayed.map((f) => f.newHits)),
	newLongMethods: replayed.reduce((sum, f) => sum + f.newLongMethods.length, 0),
	grewPastClassLines: Object.fromEntries(
		CLASS_LINES.map((n) => [n, replayed.filter((f) => !f.created && f.linesBefore <= n && f.linesAfter > n).length]),
	),
	newFilesOver: Object.fromEntries(
		CLASS_LINES.map((n) => [n, replayed.filter((f) => f.created && f.linesAfter > n).length]),
	),
	addedToClassesOver: Object.fromEntries(
		CLASS_LINES.map((n) => [n, replayed.filter((f) => f.linesBefore > n && f.linesAfter > f.linesBefore).length]),
	),
};

if (json) {
	console.log(JSON.stringify({ project: projectSummary, sessions: sessionSummary }, null, 2));
} else {
	const p = projectSummary;
	console.log(
		`工程 ${p.root}（前缀 ${p.isv}）：${p.javaFiles} 个 .java，插件类 ${p.pluginClasses} 个（解析不了 ${p.unparsed}）`,
	);
	console.log(`  常量类 ${p.constantClasses} 个，里面不同的编码值 ${p.constantValues} 个`);
	console.log(
		`  插件类行数：中位 ${p.classLines.p50}，九成在 ${p.classLines.p90} 以内，最长 ${p.classLines.max}；` +
			CLASS_LINES.map((n) => `超 ${n} 行 ${p.classLines.over[n]} 个`).join("，"),
	);
	console.log(
		`  每类最长方法：中位 ${p.longestMethod.p50}，九成在 ${p.longestMethod.p90} 以内，最长 ${p.longestMethod.max}；` +
			METHOD_LINES.map(
				(n) =>
					`超 ${n} 行的方法 ${p.longestMethod.methodsOver[n]} 个（在 ${p.longestMethod.classesWithMethodOver[n]} 个类里）`,
			).join("，"),
	);
	console.log(`  插件里直接写的 ${p.isv}_ 编码字符串 ${p.isvLiterals} 处`);
	for (const [kind, t] of Object.entries(p.hits)) console.log(`  ${kind}：${t.hits} 处，${t.files} 个类`);
	if (p.pluginsPerBill) {
		console.log(`  同一张单同一类插件挂几个类：${JSON.stringify(p.pluginsPerBill)}`);
		for (const line of p.crowdedBills.slice(0, 10)) console.log(`    ${line}`);
	}
	if (sessionFiles.length > 0) {
		const s = sessionSummary;
		console.log(
			`\n会话 ${s.sessions} 份，其中改了工程代码的 ${s.sessionsWritingCode} 份；碰过 ${s.filesTouched} 个文件，回放成功 ${s.filesReplayed} 个，新建 ${s.newFiles} 个`,
		);
		for (const line of s.notReplayed) console.log(`  回放不了：${line}`);
		console.log(
			`  第一次写工程代码之前：收到过插件知识卡片的 ${s.cardBeforeFirstWrite} 份，收到过类周边的 ${s.surroundingsBeforeFirstWrite} 份`,
		);
		for (const line of s.cardRounds) console.log(`    ${line}`);
		const e = s.editRoundSeconds;
		console.log(
			`  改工程代码的一轮用时：${e.count} 次，中位 ${e.p50.toFixed(1)} 秒，四分之三在 ${e.p75.toFixed(1)} 秒以内，九成在 ${e.p90.toFixed(1)} 秒以内`,
		);
		console.log(`  新建的插件类：${s.newPluginClasses.length === 0 ? "无" : s.newPluginClasses.join("；")}`);
		for (const [kind, t] of Object.entries(s.newHits)) console.log(`  新加 ${kind}：${t.hits} 处，${t.files} 个文件`);
		console.log(`  新出现的超 ${METHOD_LINES[1]} 行方法：${s.newLongMethods} 个`);
		console.log(
			`  新建就超线的：${CLASS_LINES.map((n) => `超 ${n} 行 ${s.newFilesOver[n]} 个`).join("，")}；` +
				`改完长过线的：${CLASS_LINES.map((n) => `过 ${n} 行 ${s.grewPastClassLines[n]} 个`).join("，")}；` +
				`往本来就超线的类里继续加：${CLASS_LINES.map((n) => `超 ${n} 行的 ${s.addedToClassesOver[n]} 个`).join("，")}`,
		);
	}
}
if (show) {
	for (const p of plugins) {
		if (p.report.hits.length === 0) continue;
		console.log(`---- ${p.file}（${p.report.lines} 行）`);
		for (const h of p.report.hits)
			console.log(`  ${h.line}  ${h.text}${h.exempt === null ? "" : `（豁免：${h.exempt}）`}`);
	}
	for (const s of sessions) {
		for (const f of s.files) {
			if (!f.replayed || (f.newHits.length === 0 && f.newLongMethods.length === 0 && !f.created)) continue;
			console.log(
				`==== ${s.session}  ${f.file}${f.created ? "（新建）" : ""}  ${f.linesBefore} → ${f.linesAfter} 行`,
			);
			for (const h of f.newHits)
				console.log(`  ${h.line}  ${h.text}${h.exempt === null ? "" : `（豁免：${h.exempt}）`}`);
			for (const m of f.newLongMethods) console.log(`  方法 ${m.label} ${m.lines} 行`);
		}
	}
}
