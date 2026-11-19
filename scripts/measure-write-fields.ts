/**
 * S37 2-B.2 的尺子：会落库的写入调用里，字段名写错了有没有照样保存；代码关系表拿来核字段靠不靠得住。
 *
 * 用法：
 *   node --experimental-strip-types scripts/measure-write-fields.ts [会话目录] [代码关系表 impact.json] [--tsv 文件]
 *
 * --tsv 另把每次调用写成一行「位置<TAB>实体<TAB>路径=;路径=」，给真机重放（scripts/verify-write-fields.ts）用同一批样本。
 *
 * 扫的写入调用（都走 OpSandbox.applySets 给字段赋值，之后保存）：
 *   cosmic_probe DataSeedProbe（SEED_SET / SEED_ROWS 里的 set=）、DataUpdateProbe（UPD_SET / UPD_ROWS）、
 *   cosmic_run op / print 的 --set。
 *
 * 每个字段的真相取探针自己的输出（返回正文，外加返回里点名的完整输出文件，还在的话）：
 *   `set <路径> =`                 → 字段存在
 *   `没有字段 X` / `没有分录 X` …   → 字段不存在
 *   两样都没看到                    → 未知（输出被截了、或没跑到赋值）
 * 字段不存在的那次调用，再看输出里有没有走到保存（`执行 save` / `跑之前行数` / `执行 <op>`）。
 *
 * 代码关系表一列：按「实体 + 字段标识（路径最后一段）」查 fields 表，看存在的字段里有多少表里查不到——
 * 那就是拿这张表当"字段全集"去核时会误拦的数。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const tsvAt = process.argv.indexOf("--tsv");
const tsvFile = tsvAt > 0 ? process.argv[tsvAt + 1] : undefined;
const args = tsvAt > 0 ? process.argv.slice(2, tsvAt) : process.argv.slice(2);
const sessions = args[0] ?? join(homedir(), ".pi", "agent", "sessions", "--D--kingdee-zlgd_ygpt2.0--");
const indexFile = args[1] ?? "D:/kingdee/zlgd_ygpt2.0/.cosmic-ai/work/impact.json";

interface Row {
	entity: string;
	key: string;
}
const indexRows: Row[] = existsSync(indexFile)
	? ((JSON.parse(readFileSync(indexFile, "utf8")) as { fields?: Row[] }).fields ?? [])
	: [];
const indexed = new Set(indexRows.map((row) => `${row.entity}|${row.key}`));
const indexedEntities = new Set(indexRows.map((row) => row.entity));

interface Write {
	where: string;
	tool: string;
	entity: string;
	paths: string[];
}

function splitSet(spec: string): string[] {
	return spec
		.split(";")
		.map((one) => one.trim())
		.filter((one) => one.includes("="))
		.map((one) => one.slice(0, one.indexOf("=")).trim());
}

function rowsSets(rows: string): string[] {
	return rows
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.startsWith("set="))
		.flatMap((line) => splitSet(line.slice(4)));
}

function writeOf(name: string, input: Record<string, unknown>): Omit<Write, "where"> | null {
	if (name === "cosmic_probe") {
		const env = (input.env ?? {}) as Record<string, string>;
		if (input.name === "DataSeedProbe") {
			const paths = env.SEED_ROWS ? rowsSets(env.SEED_ROWS) : splitSet(env.SEED_SET ?? "");
			return { tool: "DataSeedProbe", entity: env.SEED_ENTITY ?? "", paths };
		}
		if (input.name === "DataUpdateProbe") {
			const paths = env.UPD_ROWS ? rowsSets(env.UPD_ROWS) : splitSet(env.UPD_SET ?? "");
			return { tool: "DataUpdateProbe", entity: env.UPD_ENTITY ?? "", paths };
		}
		return null;
	}
	if (name !== "cosmic_run") return null;
	const argv = (input.argv ?? []) as string[];
	const kind = argv[0];
	if (kind !== "op" && kind !== "print") return null;
	const paths: string[] = [];
	for (let i = 0; i < argv.length - 1; i++) {
		if (argv[i] === "--set") paths.push(...splitSet(argv[i + 1] as string));
	}
	if (paths.length === 0) return null;
	// print 的实体不在 argv 里（按模板找单据），交给输出里的「单据」行；这里先记空
	return { tool: `run ${kind}`, entity: kind === "op" ? (argv[1] ?? "") : "", paths };
}

function outputOf(content: unknown): string {
	const text = (Array.isArray(content) ? content : [])
		.map((part: { text?: string }) => part.text ?? "")
		.join("\n")
		.replace(/\\n/g, "\n")
		.replace(/\\\\/g, "\\");
	const extra: string[] = [];
	for (const match of text.matchAll(/([A-Z]:\\[^"\s（]+?\.out)/g)) {
		const file = match[1] as string;
		if (existsSync(file)) extra.push(readFileSync(file, "utf8"));
	}
	return [text, ...extra].join("\n");
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type Status = "exists" | "missing" | "unknown";
function statusOf(output: string, path: string): Status {
	const leaf = path.split(".").pop() as string;
	const entry = path.includes("[") ? (path.split("[")[0] as string) : "";
	if (new RegExp(`\\bset ${escapeRegExp(path)} =`).test(output)) return "exists";
	if (new RegExp(`没有字段 ${escapeRegExp(leaf)}(?![\\w])|没有字段「${escapeRegExp(path)}」`).test(output))
		return "missing";
	if (entry !== "" && new RegExp(`没有(子)?分录 ${escapeRegExp(entry)}(?![\\w])`).test(output)) return "missing";
	// run print / run op 的「✘ 输入不成立 print-set <路径>[=值]  —— …没有这个字段 / 没有字段」
	if (new RegExp(`输入不成立 (?:\\S+ )?(?:print|op)-set ${escapeRegExp(path)}[=\\s][^\\n]*没有`).test(output))
		return "missing";
	// DataUpdateProbe 改前后一行：`<路径>：原值 → 新值`
	if (new RegExp(`\\[PROBE\\]\\s+${escapeRegExp(path)}：`).test(output)) return "exists";
	return "unknown";
}

const SAVED = /执行 save|跑之前行数|--- 执行 |改值、保存|→ 执行 /;

let calls = 0;
let fields = 0;
const tally = { exists: 0, missing: 0, unknown: 0 };
let existsNotIndexed = 0;
let existsEntityNotIndexed = 0;
let missingIndexed = 0;
const missingLines: string[] = [];
const falseBlocks = new Map<string, number>();
const tsv: string[] = [];

for (const file of readdirSync(sessions)
	.filter((name) => name.endsWith(".jsonl"))
	.sort()) {
	const pending = new Map<string, Write>();
	let n = 0;
	for (const line of readFileSync(join(sessions, file), "utf8").split("\n")) {
		if (line === "") continue;
		let row: {
			message?: {
				role?: string;
				toolCallId?: string;
				content?: { type?: string; id?: string; name?: string; arguments?: unknown }[];
			};
		};
		try {
			row = JSON.parse(line);
		} catch {
			continue;
		}
		const message = row.message;
		if (message === undefined) continue;
		if (message.role === "assistant") {
			for (const part of message.content ?? []) {
				if (part.type !== "toolCall") continue;
				n++;
				const write = writeOf(part.name ?? "", (part.arguments ?? {}) as Record<string, unknown>);
				if (write !== null && write.paths.length > 0 && part.id !== undefined) {
					pending.set(part.id, { ...write, where: `${file.slice(0, 16)} 第 ${n} 次` });
				}
			}
			continue;
		}
		if (message.role !== "toolResult" || message.toolCallId === undefined) continue;
		const write = pending.get(message.toolCallId);
		if (write === undefined) continue;
		pending.delete(message.toolCallId);
		calls++;
		const output = outputOf(message.content);
		const entity = write.entity || (/单据 (\w+)/.exec(output)?.[1] ?? "");
		if (entity !== "") tsv.push(`${write.where}\t${entity}\t${write.paths.map((path) => `${path}=`).join(";")}`);
		const missing: string[] = [];
		for (const path of write.paths) {
			fields++;
			const status = statusOf(output, path);
			tally[status]++;
			if (status === "unknown" && process.env.SHOW_UNKNOWN) console.log(`? ${write.where} ${write.tool} ${path}`);
			const key = path.split(".").pop() as string;
			const inIndex = indexed.has(`${entity}|${key}`);
			if (status === "exists" && !inIndex) {
				existsNotIndexed++;
				if (!indexedEntities.has(entity)) existsEntityNotIndexed++;
				falseBlocks.set(key, (falseBlocks.get(key) ?? 0) + 1);
			}
			if (status === "missing") {
				missing.push(path);
				if (inIndex) missingIndexed++;
			}
		}
		if (missing.length > 0) {
			missingLines.push(
				`${write.where} ${write.tool} ${entity}：写错 ${missing.join("、")}；${SAVED.test(output) ? "照样走到了保存" : "没走到保存"}`,
			);
		}
	}
}

console.log(`会话目录 ${sessions}`);
console.log(`代码关系表 ${indexFile}：${indexRows.length} 条字段归属，${indexedEntities.size} 个实体`);
console.log(
	`写入调用 ${calls} 次，字段 ${fields} 个：存在 ${tally.exists}，不存在 ${tally.missing}，看不出 ${tally.unknown}`,
);
console.log(`字段名写错的调用 ${missingLines.length} 次：`);
for (const line of missingLines) console.log(`  ${line}`);
console.log(
	`存在的字段里，代码关系表查不到的 ${existsNotIndexed} 个（其中整张单不在表里的 ${existsEntityNotIndexed} 个）`,
);
console.log(
	`  按字段：${[...falseBlocks.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 20)
		.map(([key, count]) => `${key}×${count}`)
		.join(" ")}`,
);
console.log(`不存在的字段里，代码关系表反而查得到的 ${missingIndexed} 个`);
if (tsvFile !== undefined) {
	writeFileSync(tsvFile, `${tsv.join("\n")}\n`);
	console.log(`已写 ${tsv.length} 行 → ${tsvFile}`);
}
