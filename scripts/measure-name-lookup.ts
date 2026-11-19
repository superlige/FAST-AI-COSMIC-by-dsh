/**
 * 拿中文名查 `cosmic_impact` 能不能对上对象（S17 批 7 的尺子）。
 *
 *   node --experimental-strip-types scripts/measure-name-lookup.ts <工程目录> [--json] [--show <词>] [--hits]
 *
 * 读工程里已建好的代码关系表，用和 `cosmic_impact` 同一个查询函数出答案。不连环境、不重建、不改任何东西。
 *
 * 样本（2026-10-04 固定）：
 *   单据名    真机会话里用户原话说过的 4 个单据中文名，各带它真正的单据标识；
 *   本工程    快照里挂了本工程插件的打印模板、调度任务、工作流各 1 个；
 *   没挂插件  快照里有名字、但登记的是别的模块类的调度任务、开放接口、工作流各 1 个；
 *   查不到    1 个字段的中文名、1 个不存在的名字：看拒绝时说没说清对照表收了哪几类。
 *   原话      真机会话（--sessions 目录，默认用户本机的 zlgd_ygpt2.0 会话）里用户的每一句原话，
 *             整句拿去对名字：对上几句、几个对象，`--hits` 逐句列出来人工看有没有"看着像、其实不是"。
 *
 * 口径：
 *   认出    这个词进了"中文名 → 对象"那一行，没进"没认出"，也没整个被拒。
 *   对准    认出的对象里有它真正的标识（整个编号对上，别的编号以它开头不算）。
 *   候选    这个词对上了几个对象（多于 1 个就是有歧义，答案让先跟用户确认）。
 *   没插件  答案里说了这个对象上没有本工程的插件。
 *   字节    答案正文（或拒绝的原因 + 补救）的 UTF-8 字节。
 */
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadIndex, queryImpact } from "../src/kernel/commands/impact.ts";
import { buildCatalog, resolveNames } from "../src/kernel/impact/catalog.ts";
import { openProject } from "../src/kernel/open-project.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";

const VERSION = "s17-name-lookup-v1";

interface Sample {
	group: string;
	term: string;
	/** The identifier the name really belongs to; absent when nothing should match. */
	id?: string;
}

const SAMPLES: Sample[] = [
	{ group: "单据名", term: "实验室检测单", id: "zlgd_sys_test_bill" },
	{ group: "单据名", term: "实验室检测试验者对照表", id: "zlgd_syrdz" },
	{ group: "单据名", term: "拉伸修约配置", id: "zlgd_lsxypz" },
	{ group: "单据名", term: "检验委托单", id: "zlgd_qty_wtd" },
	{ group: "本工程", term: "挤压棒材军用合格证打印模板", id: "zlgd_xnlzg_jybcjyhgz" },
	{ group: "本工程", term: "产销协同报表每周一生成", id: "CxxtBillTask" },
	{ group: "本工程", term: "销售合同审批流程V2", id: "Proc_conm_salcontract_audit_21" },
	{ group: "没挂插件", term: "报账状态查询接口", id: "zlgd_billstatussearch" },
	{ group: "没挂插件", term: "西南铝板带领料出库单自定义服务", id: "trd/sws/materailreq" },
	{ group: "没挂插件", term: "销售出库单审批流程", id: "Proc_im_saloutbill_audit_3" },
	{ group: "查不到", term: "加工方式" },
	{ group: "查不到", term: "不存在的某某单" },
];

const args = process.argv.slice(2);
const flagValue = (flag: string) => {
	const at = args.indexOf(flag);
	return at >= 0 ? args[at + 1] : undefined;
};
const root = args.find((a, i) => !a.startsWith("--") && !["--show", "--sessions"].includes(args[i - 1] ?? ""));
const show = flagValue("--show");
const sessions = flagValue("--sessions") ?? join(homedir(), ".pi", "agent", "sessions", "--D--kingdee-zlgd_ygpt2.0--");
if (root === undefined) {
	console.error(
		"用法：node --experimental-strip-types scripts/measure-name-lookup.ts <工程目录> [--json] [--show <词>] [--hits]",
	);
	process.exit(2);
}
const opened = await openProject({
	projectRoot: root,
	agentConfigDir: join(homedir(), ".fast-ai-cosmic"),
	cacheRoot: mkdtempSync(join(tmpdir(), "name-lookup-")),
	agentVersion: "0.1.0",
	resources: EMBEDDED_RESOURCES,
});
const loaded = loadIndex(opened.ctx);
if (!loaded.ok) {
	console.error(`读不了代码关系表：${loaded.error.message}`);
	process.exit(1);
}
const index = loaded.value;
const bytes = (text: string) => Buffer.byteLength(text, "utf8");

if (show !== undefined) {
	const got = queryImpact(opened.ctx, { terms: [show] });
	console.log(got.ok ? got.value.text : `${got.error.message}\n${got.error.remedy ?? ""}`);
	process.exit(0);
}

interface Row extends Sample {
	recognised: boolean;
	aimed: boolean;
	candidates: number;
	noPlugin: boolean;
	bytes: number;
	head: string;
}

const rows: Row[] = SAMPLES.map((sample) => {
	const got = queryImpact(opened.ctx, { terms: [sample.term] });
	const text = got.ok ? got.value.text : `${got.error.message}\n${got.error.remedy ?? ""}`;
	const named = text.split("\n").find((line) => line.includes(`中文名「${sample.term}」`)) ?? "";
	const candidates = /对上了 (\d+) 个对象/.exec(named)?.[1];
	return {
		...sample,
		recognised: named !== "",
		// The label is `种类 编号「名字」`: match the whole number, not a prefix of a longer one.
		aimed: sample.id !== undefined && named.includes(` ${sample.id}「`),
		candidates: named === "" ? 0 : candidates ? Number(candidates) : 1,
		noPlugin: /没有本工程的插件/.test(text),
		bytes: bytes(text),
		head: (got.ok ? named : text).slice(0, 220),
	};
});

// Every sentence the user typed, matched whole against the catalog.
const prompts: string[] = [];
try {
	for (const file of readdirSync(sessions)
		.filter((f) => f.endsWith(".jsonl"))
		.sort()) {
		for (const line of readFileSync(join(sessions, file), "utf8").split("\n")) {
			if (line === "") continue;
			let entry: { message?: { role?: string; content?: unknown } };
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			const message = entry.message;
			if (message?.role !== "user") continue;
			const content =
				typeof message.content === "string"
					? message.content
					: Array.isArray(message.content)
						? (message.content as { type?: string; text?: string }[])
								.filter((part) => part.type === "text")
								.map((part) => part.text ?? "")
								.join(" ")
						: "";
			const text = content.replace(/\s+/g, " ").trim();
			if (text !== "" && !text.startsWith("<") && !prompts.includes(text)) prompts.push(text);
		}
	}
} catch {
	// No session directory: the prompt part reports zero.
}
const catalog = buildCatalog(index);
const promptHits = prompts.map((prompt) => ({
	prompt,
	hits: resolveNames(catalog, prompt).map((hit) => `${hit.entry.kind} ${hit.entry.id}「${hit.names[0]}」`),
}));
const kinds: Record<string, number> = {};
for (const entry of catalog.entries) kinds[entry.kind] = (kinds[entry.kind] ?? 0) + 1;

const summary = {
	version: VERSION,
	project: root,
	indexAt: index.at,
	metaAt: index.meta?.at ?? null,
	catalog: { objects: catalog.objects, named: catalog.entries.length, kinds },
	samples: rows,
	prompts: {
		total: prompts.length,
		withHits: promptHits.filter((p) => p.hits.length > 0).length,
		hits: promptHits.reduce((n, p) => n + p.hits.length, 0),
	},
};

if (args.includes("--json")) {
	console.log(JSON.stringify({ ...summary, promptHits: promptHits.filter((p) => p.hits.length > 0) }, null, 2));
	process.exit(0);
}

console.log(`${VERSION}  表 ${index.at}  快照 ${summary.metaAt}`);
console.log(
	`对照表：${catalog.objects} 个对象，${catalog.entries.length} 个有中文名（${Object.entries(kinds)
		.map(([k, n]) => `${k} ${n}`)
		.join("、")}）`,
);
console.log("");
console.log("组\t词\t认出\t对准\t候选\t没插件\t字节");
for (const row of rows) {
	console.log(
		[
			row.group,
			row.term,
			row.recognised ? "是" : "否",
			row.id === undefined ? "-" : row.aimed ? "是" : "否",
			row.candidates,
			row.noPlugin ? "是" : "否",
			row.bytes,
		].join("\t"),
	);
}
console.log("");
for (const row of rows) console.log(`  ${row.term}：${row.head.replace(/\n/g, " ⏎ ")}`);
console.log("");
console.log(
	`原话 ${summary.prompts.total} 句：对上名字的 ${summary.prompts.withHits} 句，共 ${summary.prompts.hits} 个对象`,
);
if (args.includes("--hits")) {
	for (const { prompt, hits } of promptHits.filter((p) => p.hits.length > 0)) {
		console.log(`  ${prompt.slice(0, 70)}`);
		console.log(`    → ${hits.join(" / ")}`);
	}
}
