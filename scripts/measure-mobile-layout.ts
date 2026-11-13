/**
 * S73 的尺子：移动端那几样事，工具现在做得到几样。
 *
 * 用法：
 *   node --experimental-strip-types scripts/measure-mobile-layout.ts <工程目录> [--only 编号,…] [--show] [--json]
 *
 * 一共三类、固定样本：
 *   - 读：只读探针 FormLayoutProbe 能不能看到单据带的移动端布局、移动端列表布局；
 *   - 改：写探针 FormLayoutWriteProbe 试算 `scripts/s73/m*.txt` 这几份改动清单（只试算，不落库）；
 *   - 跑和挂：`run form` 能不能打开独立移动表单、单据带的移动端页面，`run list --mobile` 能不能打开移动端列表；插件路线表里移动端三族有没有挂法和验证路线（不起 JVM）。
 *
 * 每项判「做得到 / 做不到」，判法写在样本旁边。只跑只读探针、写探针预演和不提交的 run form / run list；带 APPLY 的一律不跑。
 * 样本用的单据：zlgd_sys_bgjl（测试单据，带移动端布局和移动端列表）、zlgd_home_index_m（独立移动表单）、
 * zlgd_mobilesalreview（建在原厂合同实体上的本 ISV 移动单据）。换工程要换样本。
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { probe } from "../src/kernel/commands/probe.ts";
import { run } from "../src/kernel/commands/run.ts";
import { openProject } from "../src/kernel/open-project.ts";
import { stopServer } from "../src/kernel/probe/server.ts";
import { describeAttach, PLUGIN_ROUTES, verifyRouteOf } from "../src/knowledge/catalog.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";

const argv = process.argv.slice(2);
const project = argv[0];
if (project === undefined || project.startsWith("--")) {
	console.error("用法：measure-mobile-layout.ts <工程目录> [--only 编号,…] [--show] [--json]");
	process.exit(2);
}
const onlyAt = argv.indexOf("--only");
const only = onlyAt < 0 ? null : new Set((argv[onlyAt + 1] ?? "").split(","));
const show = argv.includes("--show");
const asJson = argv.includes("--json");
const SAMPLES = join(import.meta.dirname, "s73");
const BILL = "zlgd_sys_bgjl";

interface Case {
	id: string;
	what: string;
	/** 起 JVM 的才有；离线的直接给结论。 */
	exec?: { probe: string; env: Record<string, string> } | { run: string[] };
	judge: (text: string, ok: boolean) => boolean;
	offline?: () => { pass: boolean; text: string };
}

const dryOk = (text: string, ok: boolean): boolean => ok && text.includes("dry-run 结束，数据库未修改");
const edit = (id: string, what: string, form: string, file: string, extra?: (text: string) => boolean): Case => ({
	id,
	what,
	exec: {
		probe: "FormLayoutWriteProbe",
		env: { LAYOUT_FORM: form, LAYOUT_EDIT: readFileSync(join(SAMPLES, file), "utf8") },
	},
	judge: (text, ok) =>
		extra === undefined
			? dryOk(text, ok)
			: ok && (dryOk(text, ok) || text.includes("改完和现在一模一样")) && extra(text),
});
/** 放上去再撤下、加了再删：改完应和现在一样，或者差异里不再有移动端的控件。 */
const noMobileLeft = (text: string): boolean =>
	text.includes("改完和现在一模一样") || !/MobMeta|MobListMeta/.test(text.split("dry-run 结束")[0] ?? "");

const mobFamilies = PLUGIN_ROUTES.filter((route) => route.base.startsWith("AbstractMob"));

const CASES: Case[] = [
	{
		id: "R1",
		what: "读：单据目录里看得到移动端布局和移动端列表",
		exec: { probe: "FormLayoutProbe", env: { LAYOUT_FORM: BILL } },
		judge: (text, ok) => ok && text.includes("移动端布局") && text.includes("移动端列表"),
	},
	{
		id: "R2",
		what: "读：按标识找得到移动端上的控件（layoutflexap1）",
		exec: { probe: "FormLayoutProbe", env: { LAYOUT_FORM: BILL, LAYOUT_FIND: "layoutflexap1" } },
		judge: (text, ok) => ok && /移动端布局 >.*layoutflexap1|移动端布局 > layoutflexap1/.test(text),
	},
	{
		id: "R3",
		what: "读：移动端控件的属性清单（auditor 的 LabelDirection）",
		exec: {
			probe: "FormLayoutProbe",
			env: {
				LAYOUT_FORM: BILL,
				LAYOUT_PART: "mobile",
				LAYOUT_PROPS: "auditor",
				LAYOUT_ONLY_PROPS: "LabelDirection",
			},
		},
		judge: (text, ok) => ok && /移动端布局 auditor/.test(text) && /LabelDirection「[^」]+」：能设/.test(text),
	},
	edit("W1", "改：独立移动表单改属性、加控件、挂移动端插件", "zlgd_home_index_m", "m1-mob-form.txt"),
	edit("W2", "改：建在原厂实体上的本 ISV 移动单据改控件属性", "zlgd_mobilesalreview", "m2-mob-bill-standalone.txt"),
	edit("W3", "改：单据带的移动端布局改控件属性", BILL, "m3-set.txt"),
	edit("W4", "改：单据带的移动端布局挪控件", BILL, "m4-move.txt"),
	edit("W5", "改：单据带的移动端布局加控件", BILL, "m5-add-control.txt"),
	edit("W6", "改：把已有字段放到单据带的移动端布局上", BILL, "m6-show-field.txt"),
	edit("W7", "改：在单据带的移动端布局上挂移动端插件", BILL, "m7-plugin.txt"),
	edit("W8", "改：把已有字段放成移动端列表卡片上的一列", BILL, "m8-mobilelist-show.txt"),
	edit("W9", "改：删字段时移动端上它的控件一起删", BILL, "m9-remove-field-everywhere.txt", noMobileLeft),
	edit("W10", "改：撤下移动端上的字段控件、字段本身留着", BILL, "m10-remove-mobile-control.txt", noMobileLeft),
	{
		id: "X1",
		what: "跑：run form 打开独立移动表单",
		exec: { run: ["form", "zlgd_home_index_m"] },
		judge: (text, ok) => ok && !/FAIL|失败|不是实体/.test(text.split("\n").slice(0, 3).join("\n")),
	},
	{
		id: "X2",
		what: "跑：run form 打开单据带的移动端页面（<单据>_mob）",
		exec: { run: ["form", `${BILL}_mob`] },
		judge: (text, ok) => ok && !/既不是实体也不是表单布局|FAIL/.test(text),
	},
	{
		id: "X3",
		what: "跑：run list 打开单据带的移动端列表（移动端列表插件挂的那份）",
		exec: { run: ["list", BILL, "--mobile", "--limit", "3"] },
		judge: (text, ok) => ok && /MobListViewPluginProxy/.test(text) && /首屏 rows=/.test(text),
	},
	{
		id: "P1",
		what: "挂：移动端三族插件在路线表里有工具挂法",
		judge: () => false,
		offline: () => {
			const lines = mobFamilies.map((route) => `${route.base}：${describeAttach(route.attach)}`);
			return { pass: mobFamilies.every((route) => !("byUser" in route.attach)), text: lines.join("\n") };
		},
	},
	{
		id: "P2",
		what: "验：移动端三族插件有自动验证路线",
		judge: () => false,
		offline: () => {
			const routes = mobFamilies.map((route) => ({ base: route.base, route: verifyRouteOf(route) }));
			return {
				pass: routes.every((entry) => entry.route.kind === "run"),
				text: routes
					.map(
						(entry) => `${entry.base}：${entry.route.kind === "run" ? entry.route.command : "没有自动验证方法"}`,
					)
					.join("\n"),
			};
		},
	},
];

const selected = CASES.filter((entry) => only === null || only.has(entry.id));
const opened = selected.some((entry) => entry.exec !== undefined)
	? await openProject({
			projectRoot: resolve(project),
			agentConfigDir: join(homedir(), ".fast-ai-cosmic"),
			cacheRoot: mkdtempSync(join(tmpdir(), "cosmic-mobile-")),
			agentVersion: "dev",
			resources: EMBEDDED_RESOURCES,
			env: { ...process.env, COSMIC_STALE: process.env.COSMIC_STALE ?? "fast" },
		})
	: null;

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
		let pass: boolean;
		let text: string;
		if (entry.offline !== undefined) {
			({ pass, text } = entry.offline());
		} else if (opened !== null && entry.exec !== undefined) {
			const result =
				"probe" in entry.exec
					? await probe(opened.ctx, entry.exec.probe, { env: entry.exec.env })
					: await run(opened.ctx, entry.exec.run);
			text = result.ok
				? result.value.output
				: `${result.error.code}: ${result.error.message}\n${JSON.stringify(result.error.detail ?? {})}`;
			pass = entry.judge(text, result.ok && result.value.exitCode === 0);
		} else continue;
		// 做不到的给第一句原因：拒绝时探针把问题列在「一处都没写」后面
		const reason =
			/一处都没写：\s*\n\s*- (.+)/.exec(text)?.[1] ??
			text.split("\n").find((line) => /PROBE\] !!|不是|没有|拒/.test(line));
		rows.push({
			id: entry.id,
			what: entry.what,
			pass,
			ms: Date.now() - started,
			head: (pass ? "" : (reason ?? text.split("\n")[0] ?? "")).replace(/^\[PROBE\]\s*/, "").slice(0, 160),
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
	if (opened !== null) await stopServer(opened.ctx).catch(() => undefined);
}
const passed = rows.filter((row) => row.pass).length;
if (asJson) console.log(JSON.stringify({ passed, total: rows.length, rows }, null, 2));
else console.log(`\n做得到 ${String(passed)} / ${String(rows.length)}`);
