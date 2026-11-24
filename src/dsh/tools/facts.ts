/**
 * cosmic_facts：列出现在和本会话开始时相比，代码和元数据实际差了什么，写完成情况时照着它写。
 *
 * 只读、不开工程、不起进程。比的是净差别，不是过程：用户一次需求说不全、来回改好几轮，
 * 中间改过又改回的不算，同一处改了几次只看最后——完成情况要说的是「现在的逻辑是什么样」，
 * 不是「这一路编译了几次」。代码差别现算（会话开始时的原文 vs 磁盘上现在的），
 * 元数据按对象归拢、带用户确认过的那张表；真跑业务逐条标出跑的是不是现在的代码。
 * 每一节都报数，0 也报：漏一行，人和模型都会当成「没有」。
 */

import { existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { Type } from "typebox";
import { registeredEntities, styleDeliveryLines } from "../../agent/tools/style-check.ts";
import { isAdHocProbeFile } from "../../kernel/layout.ts";
import { diffLines, isBigHunk } from "../../kernel/meta/diff.ts";
import { nodeFs } from "../../kernel/ports.ts";
import { classNameOf } from "../../kernel/style/plugin-style.ts";
import { pluginBaseOf } from "../../knowledge/plugin-base.ts";
import type { CosmicToolSpec } from "../define.ts";
import { renderSuccess } from "../result.ts";
import type { CommittedBill, CosmicSession, MetaWriteFact, RunFact } from "../session.ts";

const OUTCOME_TEXT = {
	written: "已写入",
	declined: "用户没确认，没写",
	failed: "写入失败",
	"not-applied": "没有落库",
} as const;

/** 代码差别一共给多少行：再多就让模型自己读文件，这里只指到行号。 */
const DIFF_LINE_BUDGET = 400;
/** 一处差别最多给多少行。 */
const HUNK_LINES = 40;

function shown(root: string | undefined, file: string): string {
	if (root === undefined) return file;
	const rel = relative(root, file);
	return rel.startsWith("..") ? file : rel.replace(/\\/g, "/");
}

function indent(text: string, pad: string): string[] {
	return text.split("\n").map((line) => (line === "" ? "" : `${pad}${line}`));
}

/** 一个业务文件现在和会话开始时的差别；一样就是 null。 */
function codeSection(
	name: string,
	original: string | null,
	file: string,
	budget: { left: number },
): { lines: string[] } | null {
	const current = existsSync(file) ? readFileSync(file, "utf8").replace(/\r\n/g, "\n") : null;
	if (original === current) return null;
	if (current === null) return { lines: [`### ${name}（本会话删掉了）`] };
	if (original === null)
		return { lines: [`### ${name}（本会话新建，${String(current.split("\n").length)} 行，全文读这个文件）`] };
	const hunks = diffLines(original, current);
	if (hunks.length === 0) return null;
	const lines = [`### ${name}（改了 ${String(hunks.length)} 处，- 是会话开始时的，+ 是现在的）`];
	for (const [index, hunk] of hunks.entries()) {
		if (isBigHunk(hunk)) {
			lines.push(
				`  第 ${String(hunk.line)} 行起：-${String(hunk.removed)} 行 / +${String(hunk.added)} 行，差别太大，读文件看`,
			);
			continue;
		}
		const size = hunk.removed.length + hunk.added.length;
		if (budget.left <= 0) {
			const rest = hunks.slice(index).map((later) => String(later.line));
			lines.push(`  其余 ${String(rest.length)} 处（第 ${rest.join("、")} 行）这里放不下，读文件看`);
			break;
		}
		lines.push(`  第 ${String(hunk.line)} 行`);
		const removed = hunk.removed.slice(0, HUNK_LINES);
		const added = hunk.added.slice(0, HUNK_LINES);
		lines.push(...removed.map((line) => `  - ${line}`), ...added.map((line) => `  + ${line}`));
		if (hunk.removed.length > removed.length || hunk.added.length > added.length)
			lines.push(`  （这一处太长，只给了前 ${String(HUNK_LINES)} 行，读文件看全）`);
		budget.left -= Math.min(size, HUNK_LINES * 2);
	}
	return { lines };
}

/** 现在的代码编译过没有：只看最后一次改业务 Java 之后的那次编译。 */
function compileLine(session: CosmicSession, root: string | undefined): string {
	if (session.lastEditAt === null) return "- 现在的代码：本会话没改过业务代码";
	const last = session.compiles.at(-1);
	const which = session.lastEditFile === null ? "" : `（${shown(root, session.lastEditFile)}）`;
	if (last === undefined || last.at < session.lastEditAt) return `- 现在的代码：最后一次改代码${which}之后还没编译过`;
	return last.ok ? "- 现在的代码：最后一次改代码之后编译通过" : "- 现在的代码：最后一次改代码之后编译失败";
}

/** 一次运行验没验成：只看值、中断、全过、没过。 */
function verdictOf(run: RunFact): string {
	const asked = expectsAsked(run.argv);
	if (asked === 0) return "只看值，没有断言";
	if (run.passed + run.failed === 0)
		return `没验成：带了 ${String(asked)} 条 --expect，运行在断言之前就中断了，一条都没执行到`;
	if (run.exitCode === 0 && run.failed === 0) return `断言全过（${String(run.passed)} 条）`;
	return `没过（过 ${String(run.passed)} 条，不过 ${String(run.failed)} 条）`;
}

const staleOf = (session: CosmicSession, run: RunFact): string =>
	session.lastEditAt !== null && run.at < session.lastEditAt ? "；之后又改过代码，验的不是现在的代码" : "";

/** 会报「这次挂着哪些本工程插件」的子命令；其余子命令不报（见 pluginLines）。 */
const REPORTS_PLUGINS = new Set(["op", "form", "push", "call"]);

/** 本会话 cosmic_run 新建的一张单：哪次运行建的、现在什么样。 */
interface RunBill {
	first: CommittedBill;
	latest: CommittedBill;
	run: RunFact;
	index: number;
}

const billKey = (bill: CommittedBill): string => `${bill.entity}|${bill.pk}`;

function argAfter(argv: readonly string[], flag: string): string | null {
	const at = argv.indexOf(flag);
	return at >= 0 && at + 1 < argv.length ? (argv[at + 1] ?? null) : null;
}

/** 这张单是怎么造出来的：下推的带规则和源单，别的说清字段只有 --set 给的那些。 */
function howMade(item: RunBill): string {
	const { run } = item;
	if (run.kind === "push") {
		const source = argAfter(run.argv, "--pk") ?? argAfter(run.argv, "--billno");
		return `按转换规则 ${run.argv[1] ?? "?"} 下推生成${source === null ? "" : `（源单 ${source}）`}`;
	}
	if (run.kind === "form") return "开表单新建后保存：字段是 --set 填的和插件带出的，没走上游下推";
	return `run ${run.kind} 免界面直接新建：字段只有 --set 给的那些，没走上游下推`;
}

/** 本会话 cosmic_run 新建的单，按建的先后；后面的运行再碰到它，记下它最新的样子。 */
function runCreatedBills(session: CosmicSession): Map<string, RunBill> {
	const out = new Map<string, RunBill>();
	session.runs.forEach((run, index) => {
		for (const bill of run.bills ?? []) {
			const key = billKey(bill);
			const known = out.get(key);
			if (known !== undefined) known.latest = bill;
			else if (bill.created === true) out.set(key, { first: bill, latest: bill, run, index });
		}
	});
	return out;
}

function billLine(item: RunBill): string {
	const { first, latest, run } = item;
	const no = first.billno === null ? "" : ` 编号=${first.billno}`;
	const status = latest.status === null ? "" : `，现在单据状态=${latest.status}`;
	return `- ${first.entity} pk=${first.pk}${no}${status}：${howMade(item)}（${run.at} run ${run.argv.join(" ")}）`;
}

/** 这次运行碰到的单里，有本会话更早一次运行新建的：标出来。 */
function ownBillNote(run: RunFact, index: number, made: Map<string, RunBill>): string {
	for (const bill of run.bills ?? []) {
		const item = made.get(billKey(bill));
		if (item === undefined || item.index >= index) continue;
		const how = item.run.kind === "push" ? "下推生成" : "手工新建、没走上游下推";
		return `；跑的是本会话 ${item.run.at} 那次运行${how}的单 pk=${item.first.pk}`;
	}
	return "";
}

/**
 * 本会话改过的插件类，各被哪次运行跑到：那次运行真执行的操作、开的表单上挂着它，或 run call 直接调它。
 * 不是插件的类（服务类、常量类）靠调用它的插件跑到，只报个数；不报挂载的子命令跑过几次也报出来，
 * 只靠它们跑到的插件在这里算成没跑到，读的人得知道为什么。
 */
function pluginLines(session: CosmicSession, root: string | undefined, changed: readonly string[]): string[] {
	const plugins: { fqcn: string; name: string; base: string }[] = [];
	let others = 0;
	for (const file of changed) {
		if (!file.endsWith(".java") || !existsSync(file)) continue;
		const text = readFileSync(file, "utf8");
		const hit = pluginBaseOf(text, { file, source: nodeFs });
		if (hit === null || hit.tier === "loose") {
			others += 1;
			continue;
		}
		const name = classNameOf(file);
		const pkg = /^\s*package\s+([\w.]+)\s*;/m.exec(text)?.[1];
		plugins.push({ fqcn: pkg === undefined ? name : `${pkg}.${name}`, name, base: hit.route.base });
	}
	const lines: string[] = [];
	let reached = 0;
	for (const plugin of plugins) {
		const runs = session.runs.filter((run) => run.plugins?.includes(plugin.fqcn) === true);
		const last = runs.at(-1);
		if (last === undefined) {
			const hooked = [
				...new Set(
					session.metaWrites
						.filter((write) => write.outcome === "written" && (write.form ?? "").includes(plugin.fqcn))
						.map((write) => write.object),
				),
			];
			const listed = root === undefined ? [] : registeredEntities(root, plugin.fqcn);
			const where =
				hooked.length > 0
					? `；本会话把它挂到了 ${hooked.join("、")}`
					: listed.length > 0
						? `；代码关系表里它挂在 ${listed.join("、")}`
						: "；本会话没挂过它，代码关系表里也没登记它挂在哪";
			lines.push(`- ${plugin.name}（${plugin.base}）：没跑到，没有一次运行的操作、表单上挂着它${where}`);
			continue;
		}
		reached += 1;
		lines.push(
			`- ${plugin.name}（${plugin.base}）：跑到 ${String(runs.length)} 次，最后一次 ${last.at} ${verdictOf(last)}${staleOf(session, last)}：run ${last.argv.join(" ")}`,
		);
	}
	if (others > 0)
		lines.push(
			`- 另有 ${String(others)} 个改过的类不是插件（服务类、常量类这些）：靠调用它们的插件跑到，这里不单独判`,
		);
	const silent = session.runs.filter((run) => !REPORTS_PLUGINS.has(run.kind));
	if (silent.length > 0) {
		const kinds = [...new Set(silent.map((run) => run.kind))].join("、");
		lines.push(
			`- run ${kinds} 不报挂着哪些插件（本会话 ${String(silent.length)} 次）：只靠它们跑到的插件，上面算成没跑到`,
		);
	}
	return [
		`## 本会话改过的插件类：${String(plugins.length)} 个，有运行跑到 ${String(reached)} 个，没跑到 ${String(plugins.length - reached)} 个`,
		...lines,
	];
}

/** 本会话事实的文字版，每一节都有，空的写「0」。 */
export function factsText(session: CosmicSession): string {
	session.restore(session.project?.root);
	const root = session.project?.root ?? session.root;
	const lines: string[] = [];
	lines.push(`工程：${root ?? "本会话还没打开工程"}`);
	lines.push(
		`比对起点：本会话开始时（${session.startedAt}）。下面是现在和那时相比的净差别：改过又改回的不算，同一处改了几次只看最后。`,
	);

	// 代码：业务 Java 现算差别；临时探针只报个数。
	const budget = { left: DIFF_LINE_BUDGET };
	const sections: string[][] = [];
	let reverted = 0;
	const tracked = new Set<string>();
	const changedFiles: string[] = [];
	for (const [key, original] of session.style.originals) {
		const file = session.style.files.get(key);
		if (file === undefined) continue;
		tracked.add(file);
		const section = codeSection(shown(root, file), original, file, budget);
		if (section === null) reverted += 1;
		else {
			sections.push(section.lines);
			changedFiles.push(file);
		}
	}
	const files = [...session.files];
	const probes = files.filter((file) => isAdHocProbeFile(file));
	const others = files.filter((file) => !tracked.has(file) && !probes.includes(file));
	lines.push("", `## 代码：${String(sections.length)} 个业务文件和会话开始时不同`);
	for (const section of sections) lines.push(...section);
	if (reverted > 0) lines.push(`- 另有 ${String(reverted)} 个文件改过，现在和会话开始时一样`);
	lines.push(`- 其他文件（不比内容）：${String(others.length)}`, ...others.map((file) => `  - ${shown(root, file)}`));
	lines.push(`- 临时探针（验证用，不是业务改动）：${String(probes.length)}`);

	// 元数据：按对象归拢，写成的带确认单上那张表。
	const byObject = new Map<string, MetaWriteFact[]>();
	for (const write of session.metaWrites.filter((entry) => entry.outcome === "written")) {
		const list = byObject.get(write.object) ?? [];
		list.push(write);
		byObject.set(write.object, list);
	}
	const unwritten = session.metaWrites.filter((entry) => entry.outcome !== "written");
	lines.push("", `## 元数据：${String(byObject.size)} 个对象写进了测试环境`);
	for (const [object, writes] of byObject) {
		lines.push(
			writes.length === 1
				? `### ${object}`
				: `### ${object}（写了 ${String(writes.length)} 次，按先后列；同一项以后一次为准）`,
		);
		for (const write of writes) {
			lines.push(`- ${write.at} ${write.kind}：${write.purpose}`);
			if (write.form !== null && write.form !== undefined) lines.push(...indent(write.form, "    "));
			lines.push(`  - 撤销办法：${write.undo}`);
			if (write.backup !== null) lines.push(`  - 改前备份：${write.backup}`);
		}
	}
	lines.push(`- 没写成的：${String(unwritten.length)}`);
	for (const write of unwritten)
		lines.push(`  - ${write.at} ${OUTCOME_TEXT[write.outcome]}：${write.kind} ${write.object}（${write.purpose}）`);

	// 真跑业务：逐条，标出之后有没有再改过代码、跑的是不是本会话自己建的单。
	const made = runCreatedBills(session);
	lines.push("", `## 真跑业务（cosmic_run）：${String(session.runs.length)} 次`);
	lines.push(compileLine(session, root));
	session.runs.forEach((run, index) => {
		lines.push(
			`- ${run.at} ${verdictOf(run)}${staleOf(session, run)}${ownBillNote(run, index, made)}：run ${run.argv.join(" ")}`,
		);
	});

	lines.push("", ...pluginLines(session, root, changedFiles));

	const created = session.dataWrites.flatMap((write) => write.created);
	const changed = session.dataWrites.flatMap((write) => write.changed);
	lines.push(
		"",
		`## 留在测试环境的造数改数：造出 ${String(created.length + made.size)} 条（造数探针 ${String(created.length)} 条，cosmic_run 新建的单 ${String(made.size)} 张），改了 ${String(changed.length)} 条，失败 ${String(session.dataWrites.filter((write) => !write.ok).length)} 次`,
	);
	for (const row of created) lines.push(`- 造出：${row}`);
	for (const item of made.values()) lines.push(billLine(item));
	for (const row of changed) lines.push(`- 改掉（原值）：${row}`);

	let style: string[] = [];
	try {
		style = root === undefined ? [] : styleDeliveryLines(session.style, root);
	} catch {
		style = [];
	}
	lines.push(
		"",
		`## 写法提醒（本会话新加的，老代码原有的不算）：${String(style.length)} 条`,
		...style.map((line) => `- ${line}`),
	);
	return lines.join("\n");
}

/**
 * 这次运行要了几条断言：数参数里的 `--expect`，不看跑到了几条。
 * 按跑到的条数算，表单打开时就中断的运行会被说成「只看值」，读的人以为根本没打算验。
 */
function expectsAsked(argv: readonly string[]): number {
	return argv.filter((arg) => arg === "--expect" || arg.startsWith("--expect=")).length;
}

export function factsTool(): CosmicToolSpec<Record<string, never>> {
	return {
		name: "cosmic_facts",
		description:
			"列出现在和本会话开始时的净差别（改过又改回的不算）：业务代码改前改后、写进测试环境的元数据（按对象，带确认单和撤销办法）、" +
			"真跑业务断言过没过及之后改没改过代码、改过的插件类各被哪次运行跑到、留下的造数（含 cosmic_run 新建的单和它怎么造的）。0 也报。只读。写完成情况前调一次，照着写。",
		parameters: Type.Object({}),
		ungated: () => true,
		async execute(_args, call) {
			return renderSuccess(call.session, call.tool, { text: factsText(call.session) });
		},
	};
}
