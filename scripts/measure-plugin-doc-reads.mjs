/**
 * 改过业务代码的真机会话里，插件文档有没有被指到、有没有被读到。
 *
 * 用法：node scripts/measure-plugin-doc-reads.mjs <会话.jsonl 或目录>… [--from YYYY-MM-DD] [--json]
 *
 * 每份会话（工具调用不少于 10 次）记四件事：
 *   - 改业务 Java：edit / write 了工程里的 .java，临时探针（路径含 probes）不算；
 *   - 指过名字：工具返回里出现 `reference:cosmic-plugin-ui` 这种出处（只有胶囊这么写）；
 *   - 给过路径：工具返回里出现 `…/skills/cosmic-plugin-ui/SKILL.md`，胶囊出处、族索引正文、
 *     知识查询带出的本地文档都算；
 *   - 读过：read 打开了插件族索引或某篇插件文档（cosmic-plugin-*、cosmic-workflow）；
 *   - 读过非打印插件文档：去掉 cosmic-plugin-print-runtime。打印那篇从打印模板文档顺链接就能到，
 *     混在一起会把"插件文档读得到"看高。
 * `--from` 按文件名里的 UTC 日期过滤，含当天。
 * 只读会话记录，不代表读了之后做得对不对。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const args = process.argv.slice(2);
const json = args.includes("--json");
const fromIndex = args.indexOf("--from");
const from = fromIndex >= 0 ? args[fromIndex + 1] : undefined;
const inputs = args.filter((arg, index) => !arg.startsWith("--") && (fromIndex < 0 || index !== fromIndex + 1));
if (inputs.length === 0) {
	console.error("用法：measure-plugin-doc-reads.mjs <会话.jsonl 或目录>… [--from YYYY-MM-DD] [--json]");
	process.exit(2);
}

const files = inputs
	.flatMap((input) =>
		statSync(input).isDirectory()
			? readdirSync(input)
					.filter((name) => name.endsWith(".jsonl"))
					.map((name) => join(input, name))
			: [input],
	)
	.filter((file) => from === undefined || basename(file).slice(0, 10) >= from)
	.sort();

const PLUGIN_PAGE = /(cosmic-plugin(?:-[a-z]+)*|cosmic-workflow)[\\/]+SKILL\.md/i;
const PRINT_PAGE = "cosmic-plugin-print-runtime";

const rows = [];
for (const file of files) {
	const calls = [];
	const results = [];
	for (const line of readFileSync(file, "utf8").split("\n")) {
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		const message = entry.message;
		if (message?.role === "assistant" && Array.isArray(message.content)) {
			for (const part of message.content) if (part.type === "toolCall") calls.push(part);
		}
		if (message?.role === "toolResult") {
			results.push((message.content ?? []).map((part) => part.text ?? "").join(""));
		}
	}
	if (calls.length < 10) continue;
	const pathOf = (call) => String(call.arguments?.path ?? call.arguments?.file_path ?? "");
	const javaEdits = calls.filter(
		(call) =>
			(call.name === "edit" || call.name === "write") &&
			/\.java$/i.test(pathOf(call)) &&
			!/probes/i.test(pathOf(call)),
	).length;
	const read = new Set(
		calls
			.filter((call) => call.name === "read")
			.map((call) => PLUGIN_PAGE.exec(pathOf(call))?.[1]?.toLowerCase())
			.filter((name) => name !== undefined),
	);
	const byName = new Set();
	const byPath = new Set();
	for (const text of results) {
		for (const hit of text.matchAll(/reference:(cosmic-plugin(?:-[a-z]+)*|cosmic-workflow)/g)) byName.add(hit[1]);
		for (const hit of text.matchAll(/skills[\\/]+(cosmic-plugin(?:-[a-z]+)*|cosmic-workflow)[\\/]+SKILL\.md/gi)) {
			byPath.add(hit[1].toLowerCase());
		}
	}
	rows.push({
		session: basename(file).slice(0, 19),
		javaEdits,
		pointedByName: [...byName].sort(),
		pointedByPath: [...byPath].sort(),
		read: [...read].sort(),
	});
}

const edited = rows.filter((row) => row.javaEdits > 0);
const nonPrint = (names) => names.some((name) => name !== PRINT_PAGE);
const summary = {
	sessions: rows.length,
	editedJava: edited.length,
	pointedByName: edited.filter((row) => row.pointedByName.length > 0).length,
	pointedByPath: edited.filter((row) => row.pointedByPath.length > 0).length,
	readAnyPluginDoc: edited.filter((row) => row.read.length > 0).length,
	readNonPrintPluginDoc: edited.filter((row) => nonPrint(row.read)).length,
};

if (json) {
	console.log(JSON.stringify({ summary, rows }, null, 2));
} else {
	for (const row of rows) {
		const list = (names) => (names.length === 0 ? "-" : names.join(","));
		console.log(
			`${row.session}  改Java ${String(row.javaEdits).padStart(2)}  出处名字 ${list(row.pointedByName)}  给过路径 ${list(row.pointedByPath)}  读了 ${list(row.read)}`,
		);
	}
	console.log(
		`\n会话 ${summary.sessions}，改业务 Java ${summary.editedJava}：出处只给名字 ${summary.pointedByName}，返回里给过路径 ${summary.pointedByPath}，` +
			`读过插件文档 ${summary.readAnyPluginDoc}，读过非打印插件文档 ${summary.readNonPrintPluginDoc}`,
	);
}
