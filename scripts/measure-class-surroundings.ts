/**
 * 尺子：读到插件类时附上的周边（父类链、用到的常量、同类写法），点到名的文件后来还被读了几次。
 *
 * 用法：
 *   node --experimental-strip-types scripts/measure-class-surroundings.ts --project <工程目录> <会话.jsonl…> [--json] [--show]
 *
 * 逐份会话按调用顺序回放：
 *   - 工程里 .java 的读取：read 工具读的，和 bash 里 cat / sed -n / head / tail / grep -n / Get-Content 点名某个文件的；
 *   - 周边只挂在 read 工具第一次读到某个插件类时（和实际实现一样），按现在的工程源码算，同一个父类一个会话只给一次；
 *   - 之后再读到周边里点过名的文件，记一次「点过名的读取」，按点名的原因（父类、常量类、同类写法的例子）分开数，
 *     连同那次读取返回的字节。
 *
 * 改之前的会话里还没有周边：数出来的是周边能替模型省下的读取的上限（点过名不等于不用读，父类的方法体、
 * 例子的写法可能还要看）。改之后的会话里真带着周边，就按模型当时看到的那份认点名的文件、不重算
 * （要改的类读完就被改了，现在重算的和当时的不一样），数「点过名还去读」的次数，并报周边自己的字节。
 * 历史会话跑在当时的源码上，现在的工程源码可能改过，一律按现在的算。
 *
 * `--all`：不看会话，把工程里每个类都当成「第一次读到」算一遍周边，按插件基类分组报几个类、几个给了周边、
 * 几个是工程基类（别人的周边，不给）、周边多大、算一个要多久。看所有插件类型是不是都覆盖到了。
 */
import { readFileSync } from "node:fs";
import { nodeFs } from "../src/kernel/ports.ts";
import {
	buildJavaIndex,
	classSurroundings,
	createSurroundingsSeen,
	sourceRootsOf,
} from "../src/knowledge/class-surroundings.ts";
import { pluginBaseOf } from "../src/knowledge/plugin-base.ts";

const args = process.argv.slice(2);
const json = args.includes("--json");
const show = args.includes("--show");
const projectAt = args.indexOf("--project");
const project = projectAt < 0 ? undefined : args[projectAt + 1];
const all = args.includes("--all");
const files = args.filter((arg, at) => arg.endsWith(".jsonl") && at !== projectAt + 1);
if (project === undefined || (files.length === 0 && !all)) {
	console.error("用法：measure-class-surroundings.ts --project <工程目录> (<会话.jsonl…> | --all) [--json] [--show]");
	process.exit(2);
}
const root = project.replace(/\\/g, "/").replace(/\/$/, "");
const indexStarted = performance.now();
const index = buildJavaIndex(root, sourceRootsOf(root, nodeFs), nodeFs);
const indexMs = performance.now() - indexStarted;

if (all) {
	interface Family {
		classes: number;
		given: number;
		projectBases: number;
		bytes: number;
		maxBytes: number;
		ms: number;
	}
	const families = new Map<string, Family>();
	let notPlugin = 0;
	let loose = 0;
	for (const facts of index.classes) {
		const hit = pluginBaseOf(nodeFs.read(facts.file), { file: facts.file, source: nodeFs });
		if (hit === null) {
			notPlugin += 1;
			continue;
		}
		if (hit.tier === "loose") {
			loose += 1;
			continue;
		}
		const family = families.get(hit.route.base) ?? {
			classes: 0,
			given: 0,
			projectBases: 0,
			bytes: 0,
			maxBytes: 0,
			ms: 0,
		};
		families.set(hit.route.base, family);
		family.classes += 1;
		const started = performance.now();
		const footer = classSurroundings({ index, file: facts.file, source: nodeFs, seen: createSurroundingsSeen() });
		family.ms += performance.now() - started;
		if (footer === null) {
			if (index.classes.some((other) => other.file !== facts.file && other.parent === facts.name)) {
				family.projectBases += 1;
			}
			continue;
		}
		family.given += 1;
		const bytes = Buffer.byteLength(footer.text, "utf8");
		family.bytes += bytes;
		family.maxBytes = Math.max(family.maxBytes, bytes);
		if (show) console.log(`---- ${facts.file}\n${footer.text}`);
	}
	const sorted = [...families].sort((a, b) => b[1].classes - a[1].classes);
	if (json) {
		console.log(
			JSON.stringify(
				{ classes: index.classes.length, indexMs, notPlugin, loose, families: Object.fromEntries(sorted) },
				null,
				2,
			),
		);
	} else {
		console.log(
			`工程 ${root}：${String(index.classes.length)} 个类，建索引 ${indexMs.toFixed(0)} ms；` +
				`不是插件 ${String(notPlugin)}，只凭名字猜是插件（不给）${String(loose)}`,
		);
		for (const [base, family] of sorted) {
			const quiet = family.classes - family.given - family.projectBases;
			console.log(
				`  ${base}：${String(family.classes)} 个类，给了 ${String(family.given)}` +
					(family.projectBases > 0 ? `，工程基类 ${String(family.projectBases)}` : "") +
					(quiet > 0 ? `，没什么可说 ${String(quiet)}` : "") +
					(family.given > 0
						? `；周边平均 ${String(Math.round(family.bytes / family.given))} B、最大 ${String(family.maxBytes)} B`
						: "") +
					`；平均 ${(family.ms / family.classes).toFixed(1)} ms`,
			);
		}
	}
	process.exit(0);
}
const byLower = new Map([...index.byFile.keys()].map((file) => [file.toLowerCase(), file]));
const byName = new Map<string, string[]>();
for (const file of index.byFile.keys()) {
	const name = (file.split("/").pop() ?? "").toLowerCase();
	byName.set(name, [...(byName.get(name) ?? []), file]);
}

/** 会话里写的路径 → 工程里的文件；认不出返回 null。 */
function projectFile(raw: string): string | null {
	let path = raw
		.trim()
		.replace(/^@/, "")
		.replace(/\\/g, "/")
		.replace(/^["']|["']$/g, "");
	path = path.replace(/^\/([a-zA-Z])\//, "$1:/");
	if (!/^[a-zA-Z]:\//.test(path)) path = `${root}/${path.replace(/^\.\//, "")}`;
	const hit = byLower.get(path.toLowerCase());
	if (hit !== undefined) return hit;
	const same = byName.get((path.split("/").pop() ?? "").toLowerCase()) ?? [];
	return same.length === 1 ? (same[0] as string) : null;
}

const READS = /\b(cat|sed\s+-n|head|tail|grep\s+-n|Get-Content|type|awk|less|more)\b/;

type Why = "parent" | "constant" | "sibling";
const FOOTER_HEAD = "的周边（按本工程源码算";

/** read 结果里真带着的周边：正文、按小节认出的点名文件。 */
function footerIn(result: string): { text: string; named: { file: string; why: Why }[] } | null {
	const at = result.indexOf(FOOTER_HEAD);
	if (at < 0) return null;
	const start = result.lastIndexOf("\n", at) + 1;
	const lines = result.slice(start).split("\n");
	const kept = [lines[0] as string];
	const named: { file: string; why: Why }[] = [];
	let why: Why = "parent";
	for (const line of lines.slice(1)) {
		if (line.startsWith("父类")) why = "parent";
		else if (line.startsWith("用到的本工程常量")) why = "constant";
		else if (line.startsWith("同一个父类的还有")) why = "sibling";
		else if (!line.startsWith("  ")) break;
		kept.push(line);
		for (const match of line.matchAll(/[\w./-]+\.java\b/g)) {
			const file = projectFile(match[0]);
			if (file !== null) named.push({ file, why });
		}
	}
	return { text: kept.join("\n"), named };
}

interface SessionRow {
	session: string;
	javaReads: number;
	viaReadTool: number;
	footers: number;
	footerBytes: number;
	/** 会话里真的带着周边的 read 结果（改之后的会话才有）。 */
	footersSeen: number;
	covered: { parent: number; constant: number; sibling: number };
	coveredBytes: number;
	examples: string[];
}

const rows: SessionRow[] = [];
for (const file of files) {
	const entries: Record<string, unknown>[] = [];
	for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
		if (line.trim() === "") continue;
		try {
			entries.push(JSON.parse(line) as Record<string, unknown>);
		} catch {
			// 写到一半的行跳过
		}
	}
	const results = new Map<string, string>();
	for (const entry of entries) {
		const message = entry.message as { role?: string; toolCallId?: string; content?: unknown[] } | undefined;
		if (message?.role !== "toolResult" || message.toolCallId === undefined) continue;
		// 一次结果分几段（正文、周边、知识卡片）：段间换行，周边才认得出从哪起、到哪止
		const text = (message.content ?? []).map((part) => (part as { text?: string }).text ?? "").join("\n");
		results.set(message.toolCallId, text);
	}
	const row: SessionRow = {
		session: (file.replace(/\\/g, "/").split("/").pop() ?? file).slice(0, 16),
		javaReads: 0,
		viaReadTool: 0,
		footers: 0,
		footerBytes: 0,
		footersSeen: 0,
		covered: { parent: 0, constant: 0, sibling: 0 },
		coveredBytes: 0,
		examples: [],
	};
	const named = new Map<string, Why>();
	const surrounded = new Set<string>();
	const seen = createSurroundingsSeen();
	// 会话里真带着周边（改之后的会话）：按模型当时看到的那份数，不按现在的源码重算——
	// 要改的类读完就被改了，现在重算出来的周边和当时的不一样
	const real = [...results.values()].some((text) => text.includes(FOOTER_HEAD));
	for (const entry of entries) {
		const message = entry.message as { role?: string; content?: unknown[] } | undefined;
		if (message?.role !== "assistant") continue;
		for (const part of message.content ?? []) {
			const call = part as { type?: string; id?: string; name?: string; arguments?: Record<string, unknown> };
			if (call.type !== "toolCall") continue;
			const input = call.arguments ?? {};
			const result = results.get(call.id ?? "") ?? "";
			let read: string[] = [];
			if (call.name === "read") {
				const target = projectFile(String(input.path ?? input.file_path ?? ""));
				if (target !== null) read = [target];
				if (result.includes(FOOTER_HEAD)) row.footersSeen += 1;
			} else if (call.name === "bash") {
				const command = String(input.command ?? "");
				if (READS.test(command)) {
					read = [
						...new Set(
							[...command.matchAll(/[\w./\\:-]+\.java\b/g)]
								.map((match) => projectFile(match[0]))
								.filter((one): one is string => one !== null),
						),
					];
				}
			}
			for (const target of read) {
				row.javaReads += 1;
				if (call.name === "read") row.viaReadTool += 1;
				const why = named.get(target);
				if (why !== undefined) {
					row.covered[why] += 1;
					row.coveredBytes += Buffer.byteLength(result, "utf8");
					if (row.examples.length < 12) row.examples.push(`${why} ${target.split("/").pop() ?? target}`);
				}
			}
			// 周边挂在 read 工具第一次读到的插件类上，挂完才算点过名：同一次读取不算省下
			if (real) {
				const footer = call.name === "read" ? footerIn(result) : null;
				if (footer === null) continue;
				row.footers += 1;
				row.footerBytes += Buffer.byteLength(footer.text, "utf8");
				if (show) console.log(`---- ${row.session} ${read[0] ?? ""}\n${footer.text}`);
				for (const one of footer.named) if (!named.has(one.file)) named.set(one.file, one.why);
				continue;
			}
			if (call.name === "read" && read.length === 1) {
				const target = read[0] as string;
				if (surrounded.has(target)) continue;
				surrounded.add(target);
				const footer = classSurroundings({ index, file: target, source: nodeFs, seen });
				if (footer === null) continue;
				row.footers += 1;
				row.footerBytes += Buffer.byteLength(footer.text, "utf8");
				if (show) console.log(`---- ${row.session} ${target}\n${footer.text}`);
				for (const one of footer.named) if (!named.has(one.file)) named.set(one.file, one.why);
			}
		}
	}
	rows.push(row);
}

const total = rows.reduce(
	(sum, row) => ({
		javaReads: sum.javaReads + row.javaReads,
		viaReadTool: sum.viaReadTool + row.viaReadTool,
		footers: sum.footers + row.footers,
		footerBytes: sum.footerBytes + row.footerBytes,
		footersSeen: sum.footersSeen + row.footersSeen,
		parent: sum.parent + row.covered.parent,
		constant: sum.constant + row.covered.constant,
		sibling: sum.sibling + row.covered.sibling,
		coveredBytes: sum.coveredBytes + row.coveredBytes,
	}),
	{
		javaReads: 0,
		viaReadTool: 0,
		footers: 0,
		footerBytes: 0,
		footersSeen: 0,
		parent: 0,
		constant: 0,
		sibling: 0,
		coveredBytes: 0,
	},
);
if (json) {
	console.log(JSON.stringify({ classes: index.classes.length, rows, total }, null, 2));
} else {
	console.log(`工程 ${root}：${String(index.classes.length)} 个类`);
	for (const row of rows) {
		const covered = row.covered.parent + row.covered.constant + row.covered.sibling;
		console.log(
			`${row.session}  读工程 Java ${String(row.javaReads)} 次（read ${String(row.viaReadTool)}）  ` +
				`周边 ${String(row.footers)} 份 ${String(row.footerBytes)} B  ` +
				`点过名又读 ${String(covered)} 次（父类 ${String(row.covered.parent)}、常量 ${String(row.covered.constant)}、` +
				`同类 ${String(row.covered.sibling)}，${String(row.coveredBytes)} B）` +
				(row.footersSeen > 0 ? `  会话里真带着周边 ${String(row.footersSeen)} 份` : "") +
				(row.examples.length > 0 ? `\n    ${row.examples.join("；")}` : ""),
		);
	}
	const covered = total.parent + total.constant + total.sibling;
	console.log(
		`合计 ${String(rows.length)} 份：读工程 Java ${String(total.javaReads)} 次（read ${String(total.viaReadTool)}），` +
			`周边 ${String(total.footers)} 份 ${String(total.footerBytes)} B；` +
			`点过名又读 ${String(covered)} 次（父类 ${String(total.parent)}、常量 ${String(total.constant)}、同类 ${String(total.sibling)}，` +
			`${String(total.coveredBytes)} B）` +
			(total.footersSeen > 0 ? `；会话里真带着周边 ${String(total.footersSeen)} 份` : ""),
	);
}
