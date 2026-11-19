/**
 * 尺子：模型找不找得到能做这件事的已发布探针。
 *
 *   node --experimental-strip-types scripts/measure-probe-lookup.ts [--dir <会话目录> [--from 日期] | <会话.jsonl…>] [--show] [--json]
 *
 * 已发布探针在系统提示里只有类名，名字不等于能力：改单据的写探针名字里是"布局"，实际还管字段、操作、挂插件。
 * 模型按名字判断"没有探针能做"，就把这一步交给用户去开发平台点（2026-10-12 真机：操作插件没挂上）。
 *
 * 量三件事：
 * 1. 固定样本（`scripts/checklists/probe-lookup.json`）：一句"要做的事"交给探针清单的查询（和工具同一个入口
 *    `knowledgeProbes`），该出现的探针排没排进前三；顺带报每条返回多少字节。只读内嵌的探针源码，不连环境。
 * 2. 历史会话里探针清单是怎么查的：不带词列全部几次、只给类名几次、给了不是类名的词几次。
 * 3. 历史会话里模型对用户说"没有工具能写、工具做不到"的句子有几处。这一项只是线索：说得对不对（真没有入口，
 *    还是有入口没找到）要人看，`--show` 逐句列出。
 *
 * 口径：
 * - 样本命中 = expect 里任一个探针在返回清单的前三条里；另报"返回的几条里有没有"（一次最多回五个）。
 * - 会话按文件名 UTC 日期筛，`--from` 当天算在内；只读会话文件，不代表重跑。
 */
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import process from "node:process";
import { knowledgeProbes } from "../src/kernel/commands/knowledge.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";
import { releasedProbeCatalog } from "../src/runtime/resources.ts";

const argv = process.argv.slice(2);
const one = (name: string): string | undefined => {
	const at = argv.indexOf(name);
	return at < 0 ? undefined : argv[at + 1];
};
const dir = one("--dir");
const from = one("--from");
const show = argv.includes("--show");
const asJson = argv.includes("--json");
const files =
	dir === undefined
		? argv.filter((arg) => arg.endsWith(".jsonl"))
		: readdirSync(dir)
				.filter((name) => name.endsWith(".jsonl") && (from === undefined || name.slice(0, 10) >= from))
				.sort()
				.map((name) => join(dir, name));

const bytesOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

// ------------------------------------------------------------------ 1. 固定样本

const catalog = releasedProbeCatalog(EMBEDDED_RESOURCES);
const names = new Set(catalog.map((entry) => entry.name.toLowerCase()));
/** 清单里一行是 `类名(必填入参)：说明`，取类名。 */
const nameOf = (line: string): string => /^[A-Za-z0-9_]+/.exec(line)?.[0] ?? "";

const checklist = JSON.parse(readFileSync(join(import.meta.dirname, "checklists", "probe-lookup.json"), "utf8")) as {
	samples: { query: string; expect: string[] }[];
};
const samples = checklist.samples.map((sample) => {
	const report = knowledgeProbes(catalog, sample.query);
	const listed = report.probes.map(nameOf);
	const rank = listed.findIndex((name) => sample.expect.includes(name));
	return { ...sample, listed, rank: rank < 0 ? null : rank + 1, bytes: bytesOf(report) };
});
const hit = samples.filter((sample) => sample.rank !== null && sample.rank <= 3).length;
const returned = samples.filter((sample) => sample.rank !== null).length;
const sampleBytes = samples.map((sample) => sample.bytes).sort((a, b) => a - b);
const medianBytes = sampleBytes[Math.floor(sampleBytes.length / 2)] ?? 0;
const listAllBytes = bytesOf(knowledgeProbes(catalog, ""));

// ------------------------------------------------------------------ 2、3. 历史会话

/** 模型对用户说"这一步工具做不了"的几种说法。只是线索，不判对错。 */
const HANDED_OVER =
	/[^。\n；]{0,60}(?:(?:没有|没|无)[^。\n；，]{0,8}(?:工具|写通道|探针|入口)[^。\n；，]{0,10}(?:能|可以|可)?(?:写|挂|绑|改|建|做)|工具做不到|现有工具没有|没有写通道|无法通过[^。\n；，]{0,6}工具)[^。\n；]{0,60}/g;

interface Lookup {
	file: string;
	query: string;
	kind: "all" | "names" | "words";
}

const lookups: Lookup[] = [];
const handed: { file: string; text: string }[] = [];
for (const file of files) {
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line.includes('"assistant"')) continue;
		let entry: { message?: { role?: string; content?: unknown } };
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		const message = entry.message;
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const part of message.content as Record<string, unknown>[]) {
			if (part.type === "toolCall" && part.name === "cosmic_knowledge") {
				const args = (part.arguments ?? {}) as { action?: string; query?: string };
				if (args.action !== "probes") continue;
				const query = String(args.query ?? "").trim();
				const words = query.split(/[\s,，]+/).filter((word) => word !== "");
				const kind =
					words.length === 0 ? "all" : words.every((word) => names.has(word.toLowerCase())) ? "names" : "words";
				lookups.push({ file: basename(file), query, kind });
			}
			if (part.type === "text" && typeof part.text === "string") {
				for (const text of part.text.match(HANDED_OVER) ?? []) {
					handed.push({ file: basename(file), text: text.replace(/\s+/g, " ").trim() });
				}
			}
		}
	}
}
const count = (kind: Lookup["kind"]): number => lookups.filter((lookup) => lookup.kind === kind).length;

// ------------------------------------------------------------------ 输出

if (asJson) {
	console.log(
		JSON.stringify(
			{
				samples: { total: samples.length, hit, returned, medianBytes, listAllBytes, rows: samples },
				sessions: files.length,
				lookups: { all: count("all"), names: count("names"), words: count("words") },
				handedOver: {
					sentences: handed.length,
					sessions: new Set(handed.map((item) => item.file)).size,
					rows: handed,
				},
			},
			null,
			2,
		),
	);
} else {
	console.log(
		`## 固定样本：${samples.length} 条"要做的事"，该出现的探针排进前三的 ${hit} 条，在返回的几条里的 ${returned} 条`,
	);
	console.log(`   每条返回中位 ${medianBytes} 字节（对照：不带词列全部探针，一次返回 ${listAllBytes} 字节）`);
	for (const sample of samples) {
		const mark = sample.rank !== null && sample.rank <= 3 ? "✔" : "✗";
		const where = sample.rank === null ? "没出现" : `第 ${sample.rank} 条`;
		console.log(`  ${mark} ${sample.query}　→ 要 ${sample.expect.join(" / ")}：${where}，返回 ${sample.bytes} 字节`);
		if (show) console.log(`      实际前几条：${sample.listed.join("、") || "（空）"}`);
	}
	if (files.length > 0) {
		console.log(`\n## 历史会话 ${files.length} 份里探针清单查了 ${lookups.length} 次`);
		console.log(
			`   不带词列全部 ${count("all")} 次；只给类名 ${count("names")} 次；给了不是类名的词 ${count("words")} 次`,
		);
		if (show)
			for (const lookup of lookups.filter((item) => item.kind === "words"))
				console.log(`   ${lookup.file.slice(0, 19)}　${lookup.query}`);
		console.log(
			`\n## 对用户说"工具做不了"的句子 ${handed.length} 处，出自 ${new Set(handed.map((item) => item.file)).size} 份会话（线索，对不对要人看）`,
		);
		if (show) for (const item of handed) console.log(`   ${item.file.slice(0, 19)}　${item.text}`);
	}
}
