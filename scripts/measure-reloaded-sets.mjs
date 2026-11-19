/**
 * 尺子：`run op` 给提交、审核、反审核这几类操作 `--set` 单据状态（或启用状态）的有几次，结果怎样。
 *
 *   node scripts/measure-reloaded-sets.mjs --dir <会话目录> [--from 日期] [--show]
 *   node scripts/measure-reloaded-sets.mjs <会话.jsonl…> [--show]
 *
 * 平台的提交、审核、反审核一开始就把这张单的单据状态从库里重读一遍（审核、反审核连「启用」一起），
 * 盖掉调用方在内存里设的值（反编译 `kd.bos.service.operation.Submit` / `Audit` / `UnAudit` 的 initialize 核过）。
 * 所以 `run op <单据> audit --pk X --set billstatus=B` 设的 B 根本到不了校验器：库里是什么就按什么判。
 * 这种运行要是记成一条没过的验证记录，同一条命令怎么重跑都过不了，交付就一直被它挡着。
 *
 * 这把尺子按命令文字数：操作标识是 submit / audit / unaudit（含 submitandnew），带 `--pk` 或 `--billno`、
 * `--set` 里写了表头的 billstatus 或 enable 的场景（批量 `--case` 逐个场景算）有几个；
 * 其中执行前被拒（返回里说「平台会从库里重读」）的、因别的原因判输入不成立的、照常跑了记成验证记录的，
 * 跑了的里面平台按库里的状态拦下（「单据状态必须…」「只有暂存的数据才允许提交」）的各几个；
 * 这几份会话后来交付预检报「有场景最后一次没过」的有几份。
 * 操作标识是自定义的、背后是不是这几类操作，只有平台元数据知道，这里认不出——数出来的是下限。
 *
 * 只读会话文件。`--show` 逐个列出。
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
	console.error("用法：measure-reloaded-sets.mjs --dir <会话目录> [--from 日期] [--show] | <会话.jsonl…>");
	process.exit(2);
}

const STATUS_OPS = new Set(["submit", "submitandnew", "audit", "unaudit"]);
const RELOADED = new Set(["billstatus", "enable"]);

/** `op <实体> <操作> …` 拆成场景：`--case` 之前的参数是各场景共用的，之后各归各的。 */
function scenarios(words) {
	const shared = [];
	const cases = [];
	let current = shared;
	for (let i = 3; i < words.length; i++) {
		const word = String(words[i] ?? "");
		if (word === "--case") {
			current = [];
			cases.push({ name: String(words[i + 1] ?? ""), words: current });
			i += 1;
			continue;
		}
		current.push(word);
	}
	if (cases.length === 0) return [{ name: "", words: shared }];
	return cases.map((entry) => ({ name: entry.name, words: [...shared, ...entry.words] }));
}

function valuesOf(words, flag) {
	const out = [];
	for (let i = 0; i < words.length; i++) {
		if (words[i] === flag && i + 1 < words.length) out.push(words[i + 1]);
		else if (words[i].startsWith(`${flag}=`)) out.push(words[i].slice(flag.length + 1));
	}
	return out;
}

/** `--set` 里写到的表头字段（不带分录前缀、不是 @上游 / @下游 那种）。 */
function reloadedFields(words) {
	const hits = [];
	for (const spec of valuesOf(words, "--set")) {
		for (const part of spec.split(";")) {
			const eq = part.indexOf("=");
			if (eq <= 0) continue;
			const path = part.slice(0, eq).trim();
			if (RELOADED.has(path)) hits.push(path);
		}
	}
	return hits;
}

let runCalls = 0;
const rows = [];
const blockedFiles = new Set();
const hitFiles = new Set();
for (const file of files) {
	const pending = new Map();
	const name = basename(file).slice(0, 19);
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
				if (part.name === "cosmic_verify") pending.set(part.id, { verify: true });
				if (part.name !== "cosmic_run" || !Array.isArray(input.argv)) continue;
				runCalls += 1;
				const words = input.argv.map((word) => String(word));
				if (words[0] !== "op" || !STATUS_OPS.has(String(words[2] ?? "").toLowerCase())) continue;
				const hits = scenarios(words)
					.filter((scenario) => scenario.words.includes("--pk") || scenario.words.includes("--billno"))
					.map((scenario) => ({ ...scenario, fields: reloadedFields(scenario.words) }))
					.filter((scenario) => scenario.fields.length > 0);
				if (hits.length > 0) pending.set(part.id, { file: name, words, hits });
			}
		}
		if (message.role === "toolResult" && pending.has(message.toolCallId)) {
			const call = pending.get(message.toolCallId);
			pending.delete(message.toolCallId);
			const text = (message.content ?? []).map((part) => part.text ?? "").join("");
			if (call.verify === true) {
				if (hitFiles.has(name) && text.includes("VERIFY_FAILING_SCENARIO")) blockedFiles.add(name);
				continue;
			}
			hitFiles.add(name);
			for (const scenario of call.hits) {
				const refused = text.includes("从库里重读");
				const otherInvalid = !refused && text.includes("输入不成立");
				const statusRejected = /\[校验\][^\n]{0,30}(单据状态|暂存的数据|已提交)/.test(text);
				rows.push({ file: call.file, scenario, refused, otherInvalid, statusRejected, words: call.words });
			}
		}
	}
}

const refused = rows.filter((row) => row.refused);
const otherInvalid = rows.filter((row) => row.otherInvalid);
const ran = rows.filter((row) => !row.refused && !row.otherInvalid);
const rejected = ran.filter((row) => row.statusRejected);
console.log(`会话 ${String(files.length)} 份，cosmic_run ${String(runCalls)} 次`);
console.log(
	`提交 / 审核 / 反审核带 --pk 又 --set 单据状态或启用的场景 ${String(rows.length)} 个（出现在 ${String(hitFiles.size)} 份会话）：` +
		`执行前因「平台会从库里重读」被拒 ${String(refused.length)} 个，因别的原因判输入不成立 ${String(otherInvalid.length)} 个，` +
		`照常跑了、记成验证记录的 ${String(ran.length)} 个（其中平台按库里状态拦下的 ${String(rejected.length)} 个）`,
);
console.log(`这几份会话里交付预检后来报「有场景最后一次没过」的 ${String(blockedFiles.size)} 份`);
if (argv.includes("--show")) {
	for (const row of rows) {
		console.log(
			`  ${row.file} ${row.refused ? "执行前被拒" : row.otherInvalid ? "别的原因输入不成立" : row.statusRejected ? "跑了·被状态校验拦下" : "跑了"}　` +
				`${row.scenario.name === "" ? "" : `[${row.scenario.name}] `}${row.scenario.fields.join("、")}　` +
				row.words.join(" ").slice(0, 160),
		);
	}
}
