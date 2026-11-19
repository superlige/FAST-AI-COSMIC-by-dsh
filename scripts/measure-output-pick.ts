/**
 * S37 2-A.2 的尺子：拿真机落盘的一份被裁输出，看模型现在收到的说明有多大、按条件取回拿到多少。
 *
 * 用法：
 *   node --experimental-strip-types scripts/measure-output-pick.ts <落盘文件> [--pick <行号或关键字>]… [--log <完整日志>]
 *
 * - 落盘文件是 `.cosmic-ai/work/out/<工具>-<n>.out`，就是当时被裁之前的整份文字。
 * - 先按默认预算裁一次，报省略范围、给模型的说明（remedy）字节；
 *   每个 `--pick` 再报取回的行数、字节，和第一行、最后一行（前 80 字）。
 *
 * - `--log` 给那次运行落盘的完整日志（缓存目录 `probe-runs/<时间>-<探针>.out`）：这时 <落盘文件> 当作
 *   显示给模型的那份，每个 `--pick` 走工具自己的两份一起找（`pickFromRun`），另报其中几行取自完整日志（S56）。
 *
 * 只读文件，不连环境。
 */
import { readFileSync } from "node:fs";
import {
	budgetOutput,
	outlineOf,
	outlineText,
	pickableRemedy,
	pickFromRun,
	pickLines,
} from "../src/agent/tools/output-budget.ts";

const args = process.argv.slice(2);
const file = args[0];
if (file === undefined) {
	console.error("用法：measure-output-pick.ts <落盘文件> [--pick <行号或关键字>]…");
	process.exit(2);
}
const picks: string[] = [];
let logFile: string | null = null;
for (let i = 1; i < args.length; i++) {
	if (args[i] === "--pick") picks.push(args[++i] ?? "");
	else if (args[i] === "--log") logFile = args[++i] ?? null;
}

const bytes = (text: string): number => Buffer.byteLength(text, "utf8");
const text = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
const budget = budgetOutput(text);
const span = budget.omittedFrom !== null && budget.omittedTo !== null;
const from = budget.omittedFrom as number;
const to = budget.omittedTo as number;
const remedy = span ? pickableRemedy(text, from, to) : null;

// 改之前模型收到的那块（S20 批 4.1 的写法）：remedy 带路径和 sed 命令，旁边还有一份结构化 outline。
const outline = span ? outlineOf(text, from, to) : [];
const contents = span ? outlineText(text, file, from, to) : "";
const oldRemedy =
	contents === ""
		? `全文在 ${file}；要看省略段就窄条件 grep 它，不要把整份取回上下文。`
		: `全文在 ${file}（共 ${String(budget.totalLines)} 行）。${contents}\n整份取回上下文没有必要。`;
const counts = {
	truncated: true,
	totalBytes: budget.totalBytes,
	totalLines: budget.totalLines,
	omittedLines: budget.omittedLines,
	omittedFrom: budget.omittedFrom,
	omittedTo: budget.omittedTo,
	spillError: null,
};
const oldBlock = { ...counts, ...(outline.length === 0 ? {} : { outline }), remedy: oldRemedy };
const newBlock = { ...counts, remedy };

console.log(JSON.stringify({ kind: "ruler", version: "s37-pick-v1", file }));
console.log(
	JSON.stringify({
		totalLines: budget.totalLines,
		totalBytes: budget.totalBytes,
		shownBytes: bytes(budget.shown),
		omitted: budget.truncated ? `${String(budget.omittedFrom)}-${String(budget.omittedTo)}` : null,
		remedyBytes: remedy === null ? null : bytes(remedy),
		// outputBudget 那块按 JSON 算（模型看到的就是 JSON），路径按这里传进来的文件名算。
		blockBytesBefore: budget.truncated ? bytes(JSON.stringify(oldBlock)) : null,
		blockBytesAfter: budget.truncated ? bytes(JSON.stringify(newBlock)) : null,
	}),
);
if (remedy !== null) console.log(remedy);
// 落盘时最前面加的两行（时间和探针、调用方式）不是输出，和工具读回时去掉的是同一处。
const log =
	logFile === null
		? null
		: readFileSync(logFile, "utf8")
				.replace(/\r\n/g, "\n")
				.replace(/^# [^\n]*\n# [^\n]*\n/, "")
				.replace(/\n$/, "");
for (const spec of log === null ? [] : picks) {
	const picked = pickFromRun(text.replace(/\n$/, ""), log, spec, false);
	const rows = (picked?.text ?? "").split("\n").filter((row) => row !== "");
	console.log(
		JSON.stringify({
			pick: spec,
			logLines: (log ?? "").split("\n").length,
			matched: picked?.matched ?? null,
			fromLog: rows.filter((row) => /^L\d+: /.test(row)).length,
			bytes: bytes(picked?.text ?? ""),
			first: rows[0]?.slice(0, 120),
			last: rows.at(-1)?.slice(0, 120),
			notes: picked?.notes ?? ["完整日志读不到"],
		}),
	);
}
for (const spec of log === null ? picks : []) {
	const picked = pickLines(text, spec);
	const rows = picked.text.split("\n");
	console.log(
		JSON.stringify({
			pick: spec,
			matched: picked.matched,
			shown: picked.shown,
			bytes: bytes(picked.text),
			first: rows[0]?.slice(0, 80),
			last: rows.at(-1)?.slice(0, 80),
		}),
	);
}
