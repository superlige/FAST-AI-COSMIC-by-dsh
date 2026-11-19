#!/usr/bin/env node
/**
 * S42 批 4.3 的尺子：旧元数据只读探针在真机会话里被怎么用。
 *
 *   node scripts/measure-meta-read-probes.mjs [会话目录] [--to 2026-09-29] [--probe FieldTypeProbe] [--json]
 *
 * 只数模型直接调 `cosmic_probe` 的次数（经 cosmic_run、cosmic_meta 间接调的不在内），和 S42 §11.6 的基线同一口径。
 * 逐条给出：会话日期、入参、调用前模型写的最后一段话（想查什么）、返回字节数和第一行 [PROBE] 内容，
 * 用来逐次判断「新入口 FormLayoutProbe 能不能答」。日期按会话文件名的 UTC 日期，首尾都算。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PROBES = [
	"MetaProbe",
	"FormRuleProbe",
	"DesignMetaProbe",
	"OpMetaProbe",
	"DbColumnProbe",
	"FormPluginProbe",
	"FieldTypeProbe",
	"FieldLimitProbe",
	"FormTreeProbe",
	"FormVisibleProbe",
	"ColumnProbe",
	"EntityFieldIndexProbe",
];

const args = process.argv.slice(2);
const flag = (name) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};
const dir =
	args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--")) ??
	"C:/Users/Lige/.pi/agent/sessions/--D--kingdee-zlgd_ygpt2.0--";
const to = flag("--to");
const only = flag("--probe");
const asJson = args.includes("--json");

const calls = [];
for (const file of readdirSync(dir)
	.filter((f) => f.endsWith(".jsonl"))
	.sort()) {
	const date = file.slice(0, 10);
	if (to !== undefined && date > to) continue;
	const results = new Map();
	const pending = [];
	for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
		if (line.trim() === "") continue;
		let o;
		try {
			o = JSON.parse(line);
		} catch {
			continue;
		}
		const m = o.message;
		if (m?.role === "toolResult") {
			const text = (m.content ?? []).map((c) => c.text ?? "").join("");
			results.set(m.toolCallId, text);
			continue;
		}
		if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
		let said = "";
		for (const c of m.content) {
			if (c.type === "text" && c.text?.trim()) said = c.text;
			else if (c.type === "thinking" && c.thinking?.trim()) said = c.thinking;
			else if (c.type === "toolCall" && c.name === "cosmic_probe") {
				const name = c.arguments?.name;
				if (!PROBES.includes(name) || (only !== undefined && name !== only)) continue;
				const env = { ...(c.arguments?.env ?? {}) };
				delete env.COSMIC_STALE;
				pending.push({ date, session: file.slice(25, 33), probe: name, env, said: tail(said), id: c.id });
			}
		}
	}
	for (const p of pending) {
		const out = results.get(p.id) ?? "";
		const first = /\[PROBE\][^\n"\\]*/.exec(out.replace(/\\n/g, "\n"))?.[0] ?? "";
		calls.push({ ...p, id: undefined, resultBytes: Buffer.byteLength(out), firstLine: first.slice(0, 160) });
	}
}

function tail(text) {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > 220 ? `…${flat.slice(-220)}` : flat;
}

if (asJson) {
	console.log(JSON.stringify(calls, null, 2));
} else {
	const count = new Map();
	for (const c of calls) count.set(c.probe, (count.get(c.probe) ?? 0) + 1);
	console.log(`会话目录 ${dir}${to ? `，截至 ${to}` : ""}：直接调用 ${calls.length} 次`);
	for (const [p, n] of [...count].sort((a, b) => b[1] - a[1])) console.log(`  ${p}  ${n}`);
	if (only !== undefined) {
		for (const c of calls) {
			console.log(`\n${c.date} ${c.session} ${JSON.stringify(c.env)}  返回 ${c.resultBytes} 字节`);
			console.log(`  想查：${c.said}`);
			console.log(`  返回：${c.firstLine}`);
		}
	}
}
