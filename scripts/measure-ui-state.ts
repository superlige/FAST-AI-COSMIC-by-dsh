/**
 * S46 的尺子：验证工具 `run form` 看不看得见插件改的界面（显示、锁定、必录），打开单据时插件回调走到哪一步。
 *
 * 用法：
 *   node --experimental-strip-types scripts/measure-ui-state.ts --project <工程> [--form <布局> …] [--pk <单据内码>]
 *     [--entry <分录> --field <分录字段>] [--open-form <布局>] [--raw <文件>] [--keep] [--json]
 *
 * 量三段，都只读、只在内存里开表单，不落库：
 *   一、各层控件 × 改界面的写法（`scripts/s46/UiStateRuler.java`，以内嵌探针的身份和 FormSim 一起编译）：
 *       每种写法收到几条发往浏览器的调用、「界面状态」报出什么、和实际调用一不一致、`--expect` 能不能判。
 *       每个 `--form` 跑一遍，默认委托单 + 物料（委托单没有页签）。`--entry` / `--field` 只给第一张布局用，别的布局取第一个分录。
 *   二、给了 `--pk`：平台按状态判字段能不能改（`checkEditFieldStatus`）当标准答案，和工具自己算的对一遍。
 *   三、`run form <--open-form>` 新增一次、带 `--pk` 打开一次（`--events`），记插件回调走到哪些、实际开的是哪张布局。
 * 默认样本写死的是 zlgd 真机工程（`zlgd_ygpt2.0`）的委托单，换工程要换样本。
 * 探针和 run form 都按完整输出解析：冷启动时平台的 SQL 日志很长，给模型看的那份会裁掉中间，用例行就在中间。
 * `--raw` 把探针和 run form 的原始输出存到文件（看每种写法实际发了哪条调用）。
 * 跑完停掉常驻进程；连着跑几次时加 `--keep`，最后一次去掉。
 */

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { probe } from "../src/kernel/commands/probe.ts";
import { run } from "../src/kernel/commands/run.ts";
import { openProject } from "../src/kernel/open-project.ts";
import { forgetRepeats } from "../src/kernel/probe/repeat.ts";
import { stopServer } from "../src/kernel/probe/server.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";

const argv = process.argv.slice(2);
const one = (name: string): string | undefined => {
	const at = argv.indexOf(name);
	return at < 0 ? undefined : argv[at + 1];
};
const many = (name: string): string[] =>
	argv.flatMap((arg, i) => (arg === name && argv[i + 1] ? [argv[i + 1] as string] : []));
const project = one("--project");
if (!project) {
	console.error("用法：--project <工程> [--form <布局> …] [--pk <单据内码>] [--open-form <布局>] [--json]");
	process.exit(2);
}
/** 委托单没有页签，物料（标品）补上页签和另一种分录。 */
const forms = many("--form").length > 0 ? many("--form") : ["zlgd_qty_wtd", "bd_material"];
const pk = one("--pk") ?? "2564046624720434176";
const openForm = one("--open-form") ?? "zlgd_qty_wtd";
/** 第一张布局的分录和分录字段：默认是 S45 批 5 那份需求按行锁定的那一列。 */
const entry = one("--entry") ?? "zlgd_syentry";
const field = one("--field") ?? "zlgd_diameter1";
/** 委托单的插件在 afterBindData 里写页面缓存、registerListener 再读；不预置就 NPE（真机会话里模型也是这么带的）。 */
const openCache = ["--cache", "jylx=jlgd_jylx", "--cache", "jylx_base=zlgd_basejylx", "--cache", "org=org"];

const rawFile = one("--raw");
if (rawFile) writeFileSync(rawFile, "");
const keepRaw = (title: string, text: string): void => {
	if (rawFile) appendFileSync(rawFile, `\n===== ${title}\n${text}\n`);
};

const ruler = readFileSync(new URL("./s46/UiStateRuler.java", import.meta.url), "utf8");
const opened = await openProject({
	projectRoot: resolve(project),
	agentConfigDir: join(homedir(), ".fast-ai-cosmic"),
	cacheRoot: join(homedir(), ".fast-ai-cosmic", "cache"),
	agentVersion: "dev",
	resources: [...EMBEDDED_RESOURCES, { relativePath: "probes/UiStateRuler.java", content: ruler }],
});

interface Case {
	form: string;
	no: number;
	label: string;
	path: string;
	received: number;
	reported: string;
	want: string;
	judged: string;
	skipped: boolean;
	error?: string;
}

const cases: Case[] = [];
const statusRows: string[] = [];
const notes: string[] = [];
const seconds: Record<string, number> = {};

try {
	for (const [i, form] of forms.entries()) {
		const env: Record<string, string> = { RULER_FORM: form };
		if (i === 0) Object.assign(env, { RULER_PK: pk, RULER_ENTRY: entry, RULER_FIELD: field });
		const started = Date.now();
		const result = await probe(opened.ctx, "UiStateRuler", { env, raw: true });
		seconds[`ruler ${form}`] = (Date.now() - started) / 1000;
		if (!result.ok) {
			notes.push(`${form} 尺子探针没跑成：${JSON.stringify(result.error).slice(0, 2000)}`);
			continue;
		}
		keepRaw(`ruler ${form}`, result.value.output);
		// 完整输出是探针进程原样写的，Windows 上行尾带 \r
		const rulerLines = result.value.output.split(/\r?\n/);
		if (!result.value.output.includes("[RULER] case|")) {
			const why = rulerLines.find((line) => line.includes("[PROBE-ERR]")) ?? "（没有报错行）";
			notes.push(`${form} 尺子一个用例都没跑到：${why.trim().slice(0, 300)}`);
		}
		for (const line of rulerLines) {
			const at = line.indexOf("[RULER] ");
			if (at < 0) continue;
			const body = line.slice(at + 8);
			const parts = body.split("|");
			if (parts[0] === "case") {
				const [, no, label, path, a, b, c, d] = parts;
				const base = { form, no: Number(no), label: label ?? "", path: path ?? "" };
				if (a === "skip") cases.push({ ...base, received: 0, reported: "-", want: "", judged: "-", skipped: true });
				else if (a?.startsWith("error="))
					cases.push({
						...base,
						received: 0,
						reported: "-",
						want: "",
						judged: "-",
						skipped: false,
						error: a.slice(6),
					});
				else
					cases.push({
						...base,
						received: Number(a?.replace("收到=", "")),
						reported: b?.replace("报出=", "") ?? "-",
						want: c?.replace("应为=", "") ?? "",
						judged: d?.replace("断言=", "") ?? "-",
						skipped: false,
					});
			} else if (parts[0] === "status" || parts[0] === "status-sample" || parts[0] === "sample") {
				statusRows.push(`${form} ${body}`);
			} else if (parts[0] === "note") {
				notes.push(`${form} ${parts.slice(1).join("|")}`);
			}
		}
	}

	const openRuns: { label: string; argv: string[] }[] = [
		{ label: "新增", argv: ["form", openForm, ...openCache, "--events"] },
		{ label: "打开已有单据", argv: ["form", openForm, "--pk", pk, ...openCache, "--events"] },
	];
	const opens: { label: string; seconds: number; events: string[]; layout: string[]; errors: string[] }[] = [];
	for (const one of openRuns) {
		const started = Date.now();
		// 尺子每次都要真跑：同一条 run 输出连着两次一样，工具会让模型去读上次的原文而不是重跑
		forgetRepeats(opened.ctx);
		const result = await run(opened.ctx, one.argv, { raw: true });
		const took = (Date.now() - started) / 1000;
		if (!result.ok) {
			opens.push({
				label: one.label,
				seconds: took,
				events: [],
				layout: [],
				errors: [JSON.stringify(result.error).slice(0, 600)],
			});
			continue;
		}
		keepRaw(`run ${one.argv.join(" ")}`, result.value.output);
		const lines = result.value.output.split(/\r?\n/);
		const events = lines
			.filter((line) => /\[PROBE\] {3}\w+\(.*\)$/.test(line))
			.map((line) => line.replace(/^.*\[PROBE\] {3}/, ""));
		const layout = lines.filter((line) => /实际打开|开布局=|转去|布局方案/.test(line)).map((line) => line.trim());
		const errors = lines
			.filter((line) => (line.includes("⚠") || line.includes("[PROBE-ERR]")) && !layout.includes(line.trim()))
			.map((line) => line.trim().slice(0, 300));
		opens.push({ label: one.label, seconds: took, events, layout, errors });
	}

	const counted = cases.filter((c) => !c.skipped);
	const consistent = (c: Case): boolean =>
		c.reported !== "-" && c.reported !== "?" && c.want.endsWith(`=${c.reported}`);
	const summary = {
		cases: counted.length,
		received: counted.filter((c) => c.received > 0).length,
		reported: counted.filter((c) => c.reported !== "-").length,
		consistent: counted.filter(consistent).length,
		judged: counted.filter((c) => c.judged !== "-").length,
		judgedPass: counted.filter((c) => c.judged === "PASS").length,
		skipped: cases.filter((c) => c.skipped).map((c) => `${c.form} ${c.label}`),
	};
	const opensOut = opens.map((o) => ({
		label: o.label,
		seconds: o.seconds,
		reached: [...new Set(o.events.map((e) => e.replace(/\(.*$/, "")))],
		layout: o.layout,
		errors: o.errors,
	}));
	if (argv.includes("--json")) {
		console.log(JSON.stringify({ summary, cases, statusRows, opens: opensOut, notes, seconds }, null, 2));
	} else {
		console.log("== 一、各层控件 × 改界面的写法");
		for (const c of cases) {
			if (c.skipped) console.log(`  ${c.form} #${c.no} ${c.label}：这张布局没有`);
			else if (c.error) console.log(`  ${c.form} #${c.no} ${c.label}：调用报错 ${c.error}`);
			else
				console.log(
					`  ${c.form} #${c.no} ${c.label} ${c.path}：收到 ${c.received} 条，报出 ${c.reported}，应为 ${c.want}，断言 ${c.judged}`,
				);
		}
		console.log(
			`  合计 ${summary.cases} 种：收到 ${summary.received}，报出 ${summary.reported}，报对 ${summary.consistent}，` +
				`--expect 能判 ${summary.judged}（判对 ${summary.judgedPass}）`,
		);
		console.log("== 二、平台按状态判字段能不能改（status 行：平台结论 / 工具结论，≠ 是对不上）");
		for (const row of statusRows) console.log(`  ${row}`);
		console.log("== 三、打开单据");
		for (const o of opensOut) {
			console.log(`  ${o.label}（${o.seconds.toFixed(1)} 秒）：走到 ${o.reached.join("、") || "（无）"}`);
			for (const l of o.layout) console.log(`    ${l}`);
			for (const e of o.errors) console.log(`    ${e}`);
		}
		for (const n of notes) console.log(`  注：${n}`);
		console.log(`  耗时：${JSON.stringify(seconds)}`);
	}
} finally {
	if (!argv.includes("--keep")) await stopServer(opened.ctx).catch(() => undefined);
}
