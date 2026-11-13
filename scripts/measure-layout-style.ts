/**
 * S74 的尺子：单据布局上的样式（大小、颜色、圆角、边框、外边距、内边距），工具现在改得了几样。
 *
 * 用法：
 *   node --experimental-strip-types scripts/measure-layout-style.ts <工程目录> [--only 编号,…] [--show] [--json]
 *
 * 固定样本，全部是只读探针和写探针的试算（不带 APPLY，不落库）：
 *   - 读：属性清单里边框样式的当前值看不看得全；
 *   - 改：电脑端、移动端的常用样式和边框样式各几份改动清单；
 *   - 合并和清除：只改一条边，别的边留着；写空串清掉一条边；
 *   - 写错：格式不对、部位写错，要被拒并说清该怎么写。
 * 样本单据 zlgd_sys_bgjl（测试单据）：contentpanel 现有四边 10px 边框，billno、layoutflexap 现在没有边框样式。换工程要换样本。
 */

import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { probe } from "../src/kernel/commands/probe.ts";
import { openProject } from "../src/kernel/open-project.ts";
import { stopServer } from "../src/kernel/probe/server.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";

const argv = process.argv.slice(2);
const project = argv[0];
if (project === undefined || project.startsWith("--")) {
	console.error("用法：measure-layout-style.ts <工程目录> [--only 编号,…] [--show] [--json]");
	process.exit(2);
}
const onlyAt = argv.indexOf("--only");
const only = onlyAt < 0 ? null : new Set((argv[onlyAt + 1] ?? "").split(","));
const show = argv.includes("--show");
const asJson = argv.includes("--json");
const BILL = "zlgd_sys_bgjl";

interface Case {
	id: string;
	what: string;
	env: Record<string, string>;
	judge: (text: string, ok: boolean) => boolean;
}

const dryOk = (text: string, ok: boolean): boolean => ok && text.includes("dry-run 结束，数据库未修改");
/** 差异那几行（试算结束之前的部分）。 */
const diffPart = (text: string): string => text.split("dry-run 结束")[0] ?? "";
const edit = (id: string, what: string, lines: string[], judge?: (text: string, ok: boolean) => boolean): Case => ({
	id,
	what,
	env: { LAYOUT_FORM: BILL, LAYOUT_EDIT: lines.join("\n") },
	judge: judge ?? dryOk,
});
/** 写错的要被拒，拒的那句里要有能照着改的写法。 */
const refused =
	(hint: RegExp) =>
	(text: string, ok: boolean): boolean =>
		!ok && /一处都没写/.test(text) && hint.test(text) && !/不是简单值/.test(text);

const CASES: Case[] = [
	{
		id: "R1",
		what: "读：属性清单里边框样式的当前值四条边都看得到（contentpanel）",
		env: { LAYOUT_FORM: BILL, LAYOUT_PROPS: "contentpanel", LAYOUT_ONLY_PROPS: "Style" },
		judge: (text, ok) =>
			ok &&
			((text.match(/10px_solid_#E2E7EF/g) ?? []).length >= 4 ||
				/border"?\s*[:=]\s*"?10px_solid_#E2E7EF"?/.test(text)),
	},
	edit("W1", "改：电脑端宽高、字号、字重、颜色", [
		"set contentpanel.Width=600px",
		"set contentpanel.Height=400px",
		"set billno.FontSize=16",
		"set billno.FontWeight=bold",
		"set billno.ForeColor=#d93025",
		"set billno.FieldBackColor=#fff8e1",
	]),
	edit("W2", "改：电脑端圆角、对齐、背景图、自定义样式", [
		"set contentpanel.Radius=8px",
		"set contentpanel.JustifyContent=center",
		"set tbmain.BackgroundImg=/images/demo.png",
		"set fs_baseinfo.CustomeStyles=.demo{color:red}",
	]),
	edit("W3", "改：移动端背景色、高度、圆角、字号", [
		"layout mobile",
		"set layoutflexap.BackColor=#ffffff",
		"set layoutflexap.Height=200px",
		"set layoutflexap.Radius=12px",
		"set billno.FontSize=18",
	]),
	edit("W4", "改：电脑端四边同一条边框", ['set billno.Style={"border":"1px_solid_#e5e5e5"}']),
	edit("W5", "改：电脑端外边距、内边距分边设", [
		'set billno.Style={"margin":{"top":"10px"},"padding":{"left":"8px","right":"8px"}}',
	]),
	edit("W6", "改：移动端边框和内边距", [
		"layout mobile",
		'set layoutflexap.Style={"border":{"bottom":"0.5px_solid_#e5e5e5"},"padding":{"left":"12px","bottom":"12px"}}',
	]),
	edit(
		"M1",
		"合并：只改下边框，原有的上、左、右边框留着",
		['set contentpanel.Style={"border":{"bottom":"2px_solid_#000000"}}'],
		(text, ok) => {
			const after = /contentpanel\s+Style：.*→ (.*)$/m.exec(diffPart(text))?.[1] ?? "";
			return (
				dryOk(text, ok) && /2px_solid_#000000/.test(after) && (after.match(/10px_solid_#E2E7EF/g) ?? []).length >= 3
			);
		},
	),
	edit("M2", "清除：写空串清掉上边框，别的边留着", ['set contentpanel.Style={"border":{"top":""}}'], (text, ok) => {
		const diff = diffPart(text);
		const after = /contentpanel\s+Style：.*→ (.*)$/m.exec(diff)?.[1] ?? "";
		return dryOk(text, ok) && after !== "" && !/Top/i.test(after) && /Bottom/i.test(after);
	}),
	edit(
		"N1",
		"写错：边框少了线型，要被拒并给出写法",
		['set billno.Style={"border":"1px #cccccc"}'],
		refused(/1px_solid_#/),
	),
	edit(
		"N2",
		"写错：部位不是边框、外边距、内边距，要被拒并说清能写哪几样",
		['set billno.Style={"shadow":"2px"}'],
		refused(/border.*margin.*padding/),
	),
];

const selected = CASES.filter((entry) => only === null || only.has(entry.id));
const opened = await openProject({
	projectRoot: resolve(project),
	agentConfigDir: join(homedir(), ".fast-ai-cosmic"),
	cacheRoot: mkdtempSync(join(tmpdir(), "cosmic-style-")),
	agentVersion: "dev",
	resources: EMBEDDED_RESOURCES,
	env: { ...process.env, COSMIC_STALE: process.env.COSMIC_STALE ?? "fast" },
});

interface Row {
	id: string;
	what: string;
	pass: boolean;
	ms: number;
	head: string;
	text?: string;
}
const rows: Row[] = [];
try {
	for (const entry of selected) {
		const started = Date.now();
		const name = entry.id.startsWith("R") ? "FormLayoutProbe" : "FormLayoutWriteProbe";
		const result = await probe(opened.ctx, name, { env: entry.env });
		const text = result.ok
			? result.value.output
			: `${result.error.code}: ${result.error.message}\n${JSON.stringify(result.error.detail ?? {})}`;
		const pass = entry.judge(text, result.ok && result.value.exitCode === 0);
		// 做不到的给第一句原因：拒绝时探针把问题列在「一处都没写」后面
		const reason =
			/一处都没写：\s*\n\s*- (.+)/.exec(text)?.[1] ??
			text.split("\n").find((line) => /Style|不是|没有|拒/.test(line) && !/ISV 检查/.test(line));
		rows.push({
			id: entry.id,
			what: entry.what,
			pass,
			ms: Date.now() - started,
			head: (pass ? "" : (reason ?? text.split("\n")[0] ?? "")).replace(/^\[PROBE\]\s*/, "").slice(0, 200),
			...(show || asJson ? { text } : {}),
		});
		if (!asJson) {
			const last = rows[rows.length - 1] as Row;
			console.log(
				`${last.pass ? "✔" : "✘"} ${last.id} ${last.what}  ${(last.ms / 1000).toFixed(1)} 秒${last.head ? `\n    ${last.head}` : ""}`,
			);
			if (show)
				console.log(
					`${text
						.split("\n")
						.map((line) => `      | ${line}`)
						.join("\n")}`,
				);
		}
	}
} finally {
	await stopServer(opened.ctx).catch(() => undefined);
}
const passed = rows.filter((row) => row.pass).length;
if (asJson) console.log(JSON.stringify({ passed, total: rows.length, rows }, null, 2));
else console.log(`\n做得到 ${String(passed)} / ${String(rows.length)}`);
