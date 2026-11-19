#!/usr/bin/env node
/**
 * 交付效率和质量的尺子（S44 批 0）。口径见 `scripts/delivery-metrics.mjs` 文件头，只读会话记录。
 *
 * 用法：
 *   node scripts/measure-delivery.mjs <会话.jsonl …> [--checklist 名称|路径] [--long N] [--rounds] [--json]
 *   node scripts/measure-delivery.mjs --dir DIR [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--min-bytes N] …
 *
 *   --checklist  需求要点清单：`scripts/checklists/<名称>.json`，或直接给路径。只对同一份需求的会话用
 *   --long N     长思考轮门槛（输出 token，默认 2500）；前后比较必须用同一个门槛
 *   --rounds     列出每个长思考轮：耗时、输出 token、初判和复核类别、命中的关键字、思考开头摘录，供人工复核
 *                复核结果写进 `scripts/checklists/long-round-review.json`，每次都会读它
 *   --thinking 类别  打出这一类（platform / toolOutput / design / compose / other，按复核后的类别）长思考轮的完整思考，
 *                连同它之前试算过几次，供逐条查"卡在哪条知识上、那时拿不拿得到"（S44 §3.1 就是这么查的）
 *   --json       机读输出
 *   --dir 等     批量挑会话：文件名日期（UTC）在范围内、大小严格大于 N 字节，按文件名排序
 *
 * 例（S44 基线，S42 元数据需求 7 次复跑）：
 *   node scripts/measure-delivery.mjs --dir "C:\Users\Lige\.pi\agent\sessions\--D--kingdee-zlgd_ygpt2.0--" \
 *     --from 2026-10-01 --to 2026-10-04 --min-bytes 700000 --checklist s42-metadata
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LONG_ROUND_TOKENS, latencyByContext, measureDelivery, THOUGHT_LABELS } from "./delivery-metrics.mjs";
import { listSessionFiles, readSessionRecords, readSessionText } from "./session-reader.mjs";

const argv = process.argv.slice(2);
const option = (name) => {
	const i = argv.indexOf(name);
	return i < 0 ? undefined : argv[i + 1];
};
const valued = new Set(["--checklist", "--long", "--dir", "--from", "--to", "--min-bytes", "--thinking"]);
const files = argv.filter((a, i) => !a.startsWith("--") && !valued.has(argv[i - 1]));
const dir = option("--dir");
if (dir) {
	const from = option("--from") ?? "0000",
		to = option("--to") ?? "9999",
		min = Number(option("--min-bytes") ?? 0);
	for (const { name, file } of listSessionFiles(dir)) {
		const day = name.slice(0, 10);
		if (day >= from && day <= to && Buffer.byteLength(readSessionText(file), "utf8") > min) files.push(file);
	}
}
if (!files.length) {
	console.error(
		"用法：node scripts/measure-delivery.mjs <会话.jsonl …> | --dir DIR [--from] [--to] [--min-bytes] [--checklist] [--long N] [--rounds] [--json]",
	);
	process.exit(2);
}

const here = dirname(fileURLToPath(import.meta.url));
let checklist = null;
const named = option("--checklist");
if (named) {
	const path = /[\\/]|\.json$/.test(named) ? named : join(here, "checklists", `${named}.json`);
	checklist = JSON.parse(readFileSync(path, "utf8"));
}
const longTokens = Number(option("--long") ?? LONG_ROUND_TOKENS);
const review = JSON.parse(readFileSync(join(here, "checklists", "long-round-review.json"), "utf8")).labels;
const sessionKey = (file) => file.replace(/^.*[\\/]/, "").slice(0, 19);
const thinkingKind = option("--thinking");
if (thinkingKind && !(thinkingKind in THOUGHT_LABELS)) {
	console.error(`--thinking 要写类别：${Object.keys(THOUGHT_LABELS).join(" / ")}`);
	process.exit(2);
}

const read = (file) => readSessionRecords(file).records; // 半截写坏的行在读的时候跳过
const sessions = files.map((file) => ({
	file,
	...measureDelivery(read(file), {
		checklist,
		longTokens,
		sessionKey: sessionKey(file),
		review,
		fullThinking: !!thinkingKind,
	}),
}));
const latency = latencyByContext(sessions);

if (argv.includes("--json")) {
	console.log(JSON.stringify({ sessions: sessions.map(({ rounds, ...s }) => s), latencyByContext: latency }, null, 2));
	process.exit(0);
}

const min = (ms) => (ms === null ? "?" : (ms / 60_000).toFixed(1));
const name = (file) => file.replace(/^.*[\\/]/, "").slice(5, 16);
const kinds = Object.keys(THOUGHT_LABELS);
const reviewed = sessions.reduce((n, s) => n + s.long.reviewed, 0),
	changed = sessions.reduce((n, s) => n + s.long.changedByReview, 0),
	longTotal = sessions.reduce((n, s) => n + s.long.rounds, 0);
console.log(`长思考门槛：一轮输出 ≥ ${longTokens} token；类别顺序 ${kinds.map((k) => THOUGHT_LABELS[k]).join(" / ")}`);
console.log(`长思考 ${longTotal} 轮，人工复核过 ${reviewed} 轮（其中改判 ${changed} 轮），其余是规则初判`);
console.log(
	"会话        | 分钟 | 调用 | 模型轮 | 模型/工具分 | 输出千token | 长思考轮(各类) | 试算/被拒(处)/目标 | 失败/恢复 | 翻产物 | 口径条/提问 | 要点 做到/总(待人工) | 拍板点 写前/交付后/没说",
);
for (const s of sessions) {
	const t = s.trial,
		c = s.checklist;
	console.log(
		[
			name(s.file).padEnd(11),
			min(s.elapsedMs).padStart(4),
			String(s.calls).padStart(4),
			String(s.modelRounds).padStart(6),
			`${min(s.modelMs)}/${min(s.toolMs)}`.padStart(11),
			(s.outputTokens / 1000).toFixed(1).padStart(11),
			`${s.long.rounds}(${kinds.map((k) => s.long.byKind[k]).join("/")})`.padStart(14),
			`${t.dryRuns}/${t.dryRejected}(${t.rejectedItems})/${t.dryTargets}`.padStart(18),
			`${t.failures}/${t.recovered}`.padStart(9),
			String(t.toolOutputReads).padStart(6),
			`${s.decisions.stated}/${s.decisions.asked}`.padStart(11),
			(c ? `${c.done}/${c.total}(${c.manual})` : "-").padStart(20),
			(c ? `${c.decisions.beforeWrite}/${c.decisions.finalOnly}/${c.decisions.none}` : "-").padStart(22),
		].join(" | "),
	);
}
console.log("\n每轮耗时按上下文分桶（全部会话合计）：");
for (const [k, v] of Object.entries(latency))
	console.log(
		`  ${k.padEnd(9)} ${String(v.rounds).padStart(4)} 轮  平均 ${(v.avgLatencyMs / 1000).toFixed(1)} 秒  平均输出 ${v.avgOutputTokens} token  每 token ${v.msPerOutputToken} 毫秒`,
	);

if (checklist)
	for (const s of sessions) {
		const c = s.checklist;
		const missed = c.items.filter((i) => i.status !== "done");
		console.log(`\n${name(s.file)} 要点没做到 / 待人工：`);
		for (const i of missed)
			console.log(
				`  [${i.status === "manual" ? "待人工" : "没做到"}] ${i.id} ${i.text}${i.missing ? `（${i.missing.join("；")}）` : ""}`,
			);
		console.log(
			`  拍板点：${c.decisionDetails.map((d) => `${d.id}${{ beforeWrite: "写前", finalOnly: "交付后", none: "没说" }[d.shown]}`).join(" ")}`,
		);
	}

if (argv.includes("--rounds"))
	for (const s of sessions) {
		console.log(`\n== ${name(s.file)} 长思考轮`);
		for (const r of s.long.details)
			console.log(
				`  #${r.round} ${(r.latencyMs / 1000).toFixed(0)}秒 ${r.outputTokens}token 之前试算${r.dryRunsBefore}次 初判=${THOUGHT_LABELS[r.auto]}${r.reviewed ? ` 复核=${THOUGHT_LABELS[r.kind]}` : ""}${r.drafts ? " 含草稿" : ""} ${JSON.stringify(r.scores)}\n     命中 ${JSON.stringify(r.hits)}\n     ${r.excerpt}`,
			);
	}

if (thinkingKind)
	for (const s of sessions)
		for (const r of s.long.details.filter((d) => d.kind === thinkingKind))
			console.log(
				`\n==== ${name(s.file)} #${r.round}  ${(r.latencyMs / 1000).toFixed(0)}秒 ${r.outputTokens}token 之前试算${r.dryRunsBefore}次\n${r.thinking}`,
			);
