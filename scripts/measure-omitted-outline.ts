/**
 * S43 批 1 的尺子：被裁输出的省略目录认不认得出结构、有多大、把省略段说清了多少。
 *
 * 用法：
 *   node --experimental-strip-types scripts/measure-omitted-outline.ts <落盘目录或文件>… [--impl <output-budget.ts 路径>] [--show <文件名>] [--json]
 *
 * - 落盘文件是 `.cosmic-ai/work/out/<工具>-<n>.out`，就是当时被裁之前的整份文字；按默认预算裁过还超的才算。
 * - `--impl` 换一份 output-budget 实现来量，用来出改前基线：
 *     git show HEAD:src/agent/tools/output-budget.ts > <临时目录>/output-budget.ts
 *   再指过去。同一批文件、同一口径，前后并排比。
 * - `--show` 把那一份给模型的说明（remedy）整段打印出来。
 *
 * 每份报：
 *   - 认出结构：省略段里有没有被认成段落标题的行（没有就是退回「均分 4 块」）；
 *   - 目录行数、说明字节（remedy 整段的 UTF-8 字节）；
 *   - 标题段：目录里起点是标题行的行数，和省略段里的标题行数比。没列出的段，模型只能凭关键字去捞。
 * 汇总按份数和行数分别算，不平均百分比。只读文件，不连环境。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const valued = new Set(["--impl", "--show"]);
const flag = (name: string): string | undefined => {
	const i = args.indexOf(name);
	return i < 0 ? undefined : args[i + 1];
};
const inputs = args.filter((arg, i) => !arg.startsWith("--") && !valued.has(args[i - 1] ?? ""));
if (inputs.length === 0) {
	console.error(
		"用法：measure-omitted-outline.ts <落盘目录或文件>… [--impl <output-budget.ts>] [--show <文件名>] [--json]",
	);
	process.exit(2);
}
const impl = resolve(flag("--impl") ?? join(import.meta.dirname, "../src/agent/tools/output-budget.ts"));
const show = flag("--show");
const asJson = args.includes("--json");

interface Entry {
	from: number;
	to: number;
	label: string;
	depth?: number;
}
const budgetModule = (await import(pathToFileURL(impl).href)) as {
	budgetOutput: (text: string) => { truncated: boolean; omittedFrom: number | null; omittedTo: number | null };
	outlineOf: (text: string, from: number, to: number) => Entry[];
	pickableRemedy: (text: string, from: number, to: number) => string;
};

const files: string[] = [];
for (const input of inputs) {
	if (statSync(input).isDirectory()) {
		for (const name of readdirSync(input).sort()) if (name.endsWith(".out")) files.push(join(input, name));
	} else files.push(input);
}

const bytes = (text: string): number => Buffer.byteLength(text, "utf8");
// 和实现里 isSectionHead 同一口径的「新写法」，只用来判断改前那份有没有认出结构；改后的实现自己认。
const HEAD = /^(?:={2,}|-{2,}|─|#{1,6}\s|【[^】]+】)/;
const LEVEL = /^\s*\[(?:PROBE-ERR|PROBE-WARN|RUNTIME-WARN|PLATFORM-WARN|IMPACT-WARN)\]/;
const isHeadLike = (line: string): boolean =>
	HEAD.test(line.replace(/^\s*\[[A-Z][A-Z0-9-]*\]/, "").trimStart()) || LEVEL.test(line);

interface Row {
	file: string;
	lines: number;
	omitted: number;
	headLike: number;
	structured: boolean;
	rows: number;
	remedyBytes: number;
	/** 目录里从标题行起头的那几行：列出来的标题段。 */
	headRows: number;
}
const rows: Row[] = [];
for (const file of files) {
	const text = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
	const budget = budgetModule.budgetOutput(text);
	if (!budget.truncated || budget.omittedFrom === null || budget.omittedTo === null) continue;
	const from = budget.omittedFrom;
	const to = budget.omittedTo;
	const lines = text.split("\n");
	const entries = budgetModule.outlineOf(text, from, to);
	const remedy = budgetModule.pickableRemedy(text, from, to);
	const headLike = lines.slice(from - 1, to).filter(isHeadLike).length;
	// 退回均分时每块的起点是那块第一行，碰巧是标题行的只有零星几块：列出的标题段 = 起点是标题行的目录行。
	const headRows = entries.filter((entry) => isHeadLike(lines[entry.from - 1] ?? "")).length;
	rows.push({
		file: basename(file),
		lines: lines.length,
		omitted: to - from + 1,
		headLike,
		structured: headRows > 0,
		rows: entries.length,
		remedyBytes: bytes(remedy),
		headRows,
	});
	if (show !== undefined && basename(file) === show) console.log(`---- ${basename(file)} 的说明 ----\n${remedy}\n`);
}

// 省略不到 40 行的本来就不做目录（实现里的 OUTLINE_MIN_LINES），不算在内。
const withHeads = rows.filter((row) => row.headLike > 0 && row.omitted >= 40);
const summary = {
	impl,
	files: rows.length,
	filesWithHeadLikeLines: withHeads.length,
	structuredAmongThem: withHeads.filter((row) => row.structured).length,
	headLikeLines: withHeads.reduce((sum, row) => sum + row.headLike, 0),
	headRows: withHeads.reduce((sum, row) => sum + row.headRows, 0),
	remedyBytesTotal: rows.reduce((sum, row) => sum + row.remedyBytes, 0),
	remedyBytesMax: Math.max(0, ...rows.map((row) => row.remedyBytes)),
	remedyOver3k: rows.filter((row) => row.remedyBytes > 3000).length,
};
if (asJson) {
	console.log(JSON.stringify({ summary, rows }, null, 2));
} else {
	console.log("文件\t总行\t省略行\t标题行\t认出\t目录行\t说明字节\t标题段");
	for (const row of rows) {
		console.log(
			[
				row.file,
				row.lines,
				row.omitted,
				row.headLike,
				row.structured ? "是" : "否",
				row.rows,
				row.remedyBytes,
				row.headRows,
			].join("\t"),
		);
	}
	console.log(`\n实现：${summary.impl}`);
	console.log(
		`被裁的 ${String(summary.files)} 份；省略段 40 行以上且有标题行的 ${String(summary.filesWithHeadLikeLines)} 份，其中认出结构 ${String(summary.structuredAmongThem)} 份`,
	);
	console.log(
		`这些份省略段里的标题行 ${String(summary.headLikeLines)}，目录列出 ${String(summary.headRows)}（${summary.headLikeLines === 0 ? "-" : `${((summary.headRows / summary.headLikeLines) * 100).toFixed(1)}%`}）`,
	);
	console.log(
		`说明合计 ${String(summary.remedyBytesTotal)} 字节，最大 ${String(summary.remedyBytesMax)}，超过 3 KB 的 ${String(summary.remedyOver3k)} 份`,
	);
}
