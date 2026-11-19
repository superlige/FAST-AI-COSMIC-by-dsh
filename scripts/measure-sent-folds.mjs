/**
 * 尺子：「N 行与前面发过的相同」这种折叠，折的段有多大、折完之后模型有没有回头去取被折掉的内容。
 *
 *   node scripts/measure-sent-folds.mjs --dir <会话目录> [--from 日期] [--show]
 *   node scripts/measure-sent-folds.mjs <会话.jsonl…> [--show]
 *
 * 同一次会话里前面原样发过的连续几行，工具返回里折成一句标记（src/agent/tools/sent-ledger.ts）。
 * 折大段背景（整份字段清单）省得多；折小段（查回来的一两行数据）省不了几个字，模型却看不到值，可能回头再取一遍。
 * 这把尺子从会话里数：
 *   - 标记按折掉的行数分档（2～3、4～9、10～49、50 以上）：各几处、一共折掉几行；
 *   - 带标记的返回之后紧接着的两次调用里，模型有没有回头取：同一个工具带 raw、直接读落盘的输出或运行日志、
 *     原样再发一遍同样的调用。按这次返回里最小的那处标记归档。
 *   - 对照：返回按「有没有这种折叠 × 有没有裁掉中段（超长输出的另一种省略）」分四组，各组回头取的比例。
 *     回头取也可能是冲着被裁的中段去的，所以要看「只有折叠」那一组比「两样都没有」那一组高多少。
 *
 * 折掉的字节会话里没有记（发给模型的已经是折完的），只能数行：一行至少 41 字节才会被折。
 * 「回头取」只是线索：模型读日志也可能是为了别的行，`--show` 逐次列出给人复核。只读会话文件。
 */
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

const argv = process.argv.slice(2);
const one = (name) => {
	const at = argv.indexOf(name);
	return at < 0 ? undefined : argv[at + 1];
};
const dir = one("--dir");
const from = one("--from");
const files =
	dir === undefined
		? argv.filter((arg) => arg.endsWith(".jsonl"))
		: readdirSync(dir)
				.filter((name) => name.endsWith(".jsonl") && (from === undefined || name.slice(0, 10) >= from))
				.sort()
				.map((name) => join(dir, name));
if (files.length === 0) {
	console.error("用法：measure-sent-folds.mjs --dir <会话目录> [--from 日期] [--show] | <会话.jsonl…>");
	process.exit(2);
}

const BUCKETS = [
	{ name: "2～3 行", max: 3 },
	{ name: "4～9 行", max: 9 },
	{ name: "10～49 行", max: 49 },
	{ name: "50 行以上", max: Number.POSITIVE_INFINITY },
];
const bucketOf = (lines) => BUCKETS.findIndex((bucket) => lines <= bucket.max);
const stats = BUCKETS.map(() => ({ markers: 0, lines: 0, results: 0, refetched: 0 }));
const MARKER = /（([0-9]+) 行与前面发过的相同：/g;
const CUT = /中间省略 [0-9]+ 行|中段按字节省略/;
/** 四组对照：[返回几次, 回头取几次]。 */
const groups = { 只有折叠: [0, 0], 折叠加裁中段: [0, 0], 只裁中段: [0, 0], 两样都没有: [0, 0] };
const every = [];

for (const file of files) {
	const calls = new Map();
	/** 还在等「之后两次调用」的返回。 */
	let watching = [];
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (line === "") continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		const message = entry.message;
		if (message === undefined) continue;
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const part of message.content) {
				if (part.type !== "toolCall") continue;
				const input = part.arguments ?? part.input ?? {};
				calls.set(part.id, { name: part.name, input });
				const text = JSON.stringify(input);
				const { raw: _raw, ...bare } = input;
				for (const watch of watching) {
					if (watch.left <= 0 || watch.how !== null) continue;
					watch.left -= 1;
					if (part.name === watch.tool && input.raw !== undefined && input.raw !== false)
						watch.how = "带 raw 再取";
					else if (part.name === watch.tool && JSON.stringify(bare) === watch.args) watch.how = "原样再发";
					else if (!part.name.startsWith("cosmic_") && /work[\\/]+out[\\/]|probe-runs/.test(text))
						watch.how = "直接读落盘输出";
				}
			}
		}
		if (message.role !== "toolResult" || !String(message.toolName ?? "").startsWith("cosmic_")) continue;
		const text = (message.content ?? []).map((part) => part.text ?? "").join("\n");
		const sizes = [...text.matchAll(MARKER)].map((hit) => Number(hit[1]));
		const cut = CUT.test(text);
		const call = calls.get(message.toolCallId);
		const { raw: _raw, ...bare } = call?.input ?? {};
		watching = watching.filter((watch) => watch.left > 0 && watch.how === null);
		const watch = {
			file: basename(file).slice(0, 19),
			tool: message.toolName,
			args: JSON.stringify(bare),
			sizes,
			group: sizes.length > 0 ? (cut ? "折叠加裁中段" : "只有折叠") : cut ? "只裁中段" : "两样都没有",
			left: 2,
			how: null,
		};
		watching.push(watch);
		every.push(watch);
	}
}

for (const watch of every) {
	groups[watch.group][0] += 1;
	if (watch.how !== null) groups[watch.group][1] += 1;
	if (watch.sizes.length === 0) continue;
	for (const size of watch.sizes) {
		stats[bucketOf(size)].markers += 1;
		stats[bucketOf(size)].lines += size;
	}
	const at = bucketOf(Math.min(...watch.sizes));
	stats[at].results += 1;
	if (watch.how !== null) stats[at].refetched += 1;
}

const folded = every.filter((watch) => watch.sizes.length > 0);
const totalLines = stats.reduce((sum, row) => sum + row.lines, 0);
console.log(
	`会话 ${String(files.length)} 份，cosmic 工具返回 ${String(every.length)} 次，其中带折叠标记的 ${String(folded.length)} 次`,
);
console.log(
	"按折掉的行数分档：标记几处｜一共折掉几行（占全部折掉的）｜最小标记在这一档的返回几次｜之后两次调用里回头取的",
);
stats.forEach((row, at) => {
	const share = totalLines === 0 ? "0" : ((row.lines / totalLines) * 100).toFixed(1);
	console.log(
		`  ${BUCKETS[at].name.padEnd(8)}　${String(row.markers).padStart(5)} 处｜${String(row.lines).padStart(6)} 行（${share}%）｜${String(row.results).padStart(4)} 次｜${String(row.refetched).padStart(3)} 次`,
	);
});
console.log("对照（返回几次｜之后两次调用里回头取的）：");
for (const [name, [count, refetched]] of Object.entries(groups)) {
	const rate = count === 0 ? "—" : `${((refetched / count) * 100).toFixed(1)}%`;
	console.log(`  ${name.padEnd(6)}　${String(count).padStart(5)} 次｜${String(refetched).padStart(3)} 次（${rate}）`);
}
if (argv.includes("--show")) {
	for (const watch of folded.filter((item) => item.how !== null)) {
		console.log(
			`  ${watch.file} ${watch.tool} ${watch.group} 标记 ${watch.sizes.join("、")} 行 → ${watch.how}　${watch.args.slice(0, 110)}`,
		);
	}
}
