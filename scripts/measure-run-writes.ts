/**
 * 回执里「哪些运行改了库」说得对不对：按命令种类猜（不回滚的就算落了库）和照运行日志里的写库语句认，逐次并排。
 *
 *   node --experimental-strip-types scripts/measure-run-writes.ts <回执.json…>
 *   node --experimental-strip-types scripts/measure-run-writes.ts --dir <工程>/.cosmic-ai/evidence/verify [--from 2026-10-14]
 *
 * 只读：读回执和每次运行落盘的完整日志，不起进程。日志已经被清掉的那次记「日志不在」。
 * 口径见 docs/S69-receipt-data-readback.md §5。
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { writtenTablesOf } from "../src/kernel/verify/evidence.ts";
import { runCommits } from "../src/knowledge/run-adapter.ts";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
	const at = args.indexOf(name);
	return at < 0 ? undefined : args[at + 1];
};
const dir = flag("--dir");
const from = flag("--from");
const files =
	dir === undefined
		? args.filter((arg) => arg.endsWith(".json"))
		: readdirSync(dir)
				.filter((name) => name.startsWith("receipt-") && name.endsWith(".json"))
				.map((name) => join(dir, name))
				.filter((file) => from === undefined || statSync(file).mtime.toISOString().slice(0, 10) >= from);
if (files.length === 0) {
	console.error("用法：measure-run-writes.ts <回执.json…> | --dir <回执目录> [--from 日期]");
	process.exit(2);
}

const total = {
	runs: 0,
	guessed: 0,
	wrote: 0,
	readOnly: 0,
	unknown: 0,
	missing: 0,
	guessedButRead: 0,
	wroteNotGuessed: 0,
};
for (const file of files) {
	const receipt = JSON.parse(readFileSync(file, "utf8")) as {
		verification: { runs: { cmd: string; log: string }[] } | null;
	};
	const runs = receipt.verification?.runs ?? [];
	if (runs.length === 0) continue;
	console.log(file);
	for (const run of runs) {
		total.runs += 1;
		const argv = run.cmd.split(" ");
		const guessed = runCommits(argv);
		if (guessed) total.guessed += 1;
		let verdict: string;
		if (run.log === "" || !existsSync(run.log)) {
			total.missing += 1;
			verdict = "日志不在";
		} else {
			const tables = writtenTablesOf(readFileSync(run.log, "utf8"));
			if (tables === undefined) {
				total.unknown += 1;
				verdict = "认不出（日志里没有 SQL）";
			} else if (tables.length === 0) {
				total.readOnly += 1;
				if (guessed) total.guessedButRead += 1;
				verdict = "只读";
			} else {
				total.wrote += 1;
				if (!guessed) total.wroteNotGuessed += 1;
				verdict = `写了 ${tables.join("、")}`;
			}
		}
		console.log(`  ${guessed ? "猜落库" : "猜只读"}  ${verdict.padEnd(24)}  ${run.cmd.slice(0, 100)}`);
	}
}
console.log(
	`\n回执 ${String(files.length)} 张，运行 ${String(total.runs)} 次：按命令种类会说落了库的 ${String(total.guessed)} 次；` +
		`日志里真写了库 ${String(total.wrote)} 次、只读 ${String(total.readOnly)} 次、认不出 ${String(total.unknown)} 次、日志不在 ${String(total.missing)} 次。` +
		`\n猜落库其实只读 ${String(total.guessedButRead)} 次；猜只读其实写了 ${String(total.wroteNotGuessed)} 次。`,
);
