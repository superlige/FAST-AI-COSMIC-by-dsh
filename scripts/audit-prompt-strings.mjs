#!/usr/bin/env node
/**
 * 把源码里所有可能发给模型的中文字符串抽出来，逐条标出"像个案补丁"的信号，给人审读用。
 *
 * 范围：src/ 下除界面（src/agent/ui）、测试、生成文件之外的 .ts，以及 resources/probes 下探针打印的 [PROBE] 文字。
 * 只抽字符串字面量和模板字符串，跳过注释。信号是启发式的，只帮人排序，不下结论：
 *   named   点名具体探针、类、字段、子命令（XxxProbe、kd.、zlgd_ 一类）
 *   steer   指挥模型"别做 X / 先做 Y / 改用 Z / 拿不准时"的劝告
 *   history 带实测、往往、常常、通常这类从个案来的经验说法
 *
 * 用法：node scripts/audit-prompt-strings.mjs [--json] > 输出
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";

const require = createRequire(import.meta.url);
const ts = require("../../node_modules/typescript");

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const CJK = /[一-鿿]/;
const SIGNALS = {
	named: /\b[A-Z][A-Za-z]+(?:Probe|Sim|Sandbox|Service|Helper)\b|\bkd\.[a-z]|\bzlgd_|\b(?:QUERY|SEED|UPD|META|TPL|PRINT)_[A-Z]+\b/,
	steer: /不要|别(?!的|处|人|名)|先[^\s，。；]{0,12}再|改用|拿不准|慎用|直接用|用不着|不用再|照抄|一次.{0,6}就够/,
	history: /实测|往往|常常|通常|多半|容易|常见/,
};

function walk(dir, out) {
	for (const name of readdirSync(dir)) {
		const file = join(dir, name);
		if (statSync(file).isDirectory()) walk(file, out);
		else out.push(file);
	}
	return out;
}

const rows = [];
const skip = (file) =>
	/[\\/]agent[\\/]ui[\\/]|\.generated\.ts$|[\\/]spike[\\/]|[\\/]eval[\\/]|\.d\.ts$/.test(file) ||
	!file.endsWith(".ts");

for (const file of walk(join(root, "src"), []).filter((f) => !skip(f))) {
	const text = readFileSync(file, "utf8");
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
	const visit = (node) => {
		let value = null;
		if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) value = node.text;
		else if (ts.isTemplateExpression(node))
			value = node.head.text + node.templateSpans.map((span) => `\${…}${span.literal.text}`).join("");
		if (value !== null && CJK.test(value)) {
			// 抛给开发者的内部错误不发给模型：只跳过 `new Error(...)` 直接参数里的
			const parent = node.parent;
			const internal = parent && ts.isNewExpression(parent) && /Error$/.test(parent.expression.getText());
			if (!internal) {
				const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
				rows.push({ file: relative(root, file).replaceAll("\\", "/"), line, text: value });
			}
			if (ts.isTemplateExpression(node)) return;
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
}

for (const file of walk(join(root, "resources", "probes"), []).filter((f) => f.endsWith(".java"))) {
	readFileSync(file, "utf8")
		.split("\n")
		.forEach((raw, index) => {
			if (!/\[PROBE/.test(raw) || !CJK.test(raw) || /^\s*(\/\/|\*)/.test(raw)) return;
			rows.push({ file: relative(root, file).replaceAll("\\", "/"), line: index + 1, text: raw.trim() });
		});
}

for (const row of rows) {
	row.bytes = Buffer.byteLength(row.text, "utf8");
	row.signals = Object.entries(SIGNALS)
		.filter(([, pattern]) => pattern.test(row.text))
		.map(([name]) => name);
}

if (process.argv.includes("--json")) console.log(JSON.stringify(rows, null, "\t"));
else {
	const byFile = new Map();
	for (const row of rows) {
		const entry = byFile.get(row.file) ?? { strings: 0, bytes: 0, flagged: 0 };
		entry.strings++;
		entry.bytes += row.bytes;
		if (row.signals.length > 0) entry.flagged++;
		byFile.set(row.file, entry);
	}
	console.log("文件\t字符串数\t字节\t带信号");
	for (const [file, entry] of [...byFile].sort((a, b) => b[1].bytes - a[1].bytes))
		console.log(`${file}\t${entry.strings}\t${entry.bytes}\t${entry.flagged}`);
	const flagged = rows.filter((row) => row.signals.length > 0);
	console.log(
		`\n合计 ${rows.length} 条、${rows.reduce((s, r) => s + r.bytes, 0)} 字节；带信号 ${flagged.length} 条、${flagged.reduce((s, r) => s + r.bytes, 0)} 字节`,
	);
}
