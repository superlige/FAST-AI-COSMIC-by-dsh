/**
 * 代码关系表和元数据快照在盘上多大、读进来要多久（S17 7.2 的尺子）。
 *
 *   node --experimental-strip-types scripts/measure-index-file.ts <工程目录> [--json]
 *
 * 只读：读 `.cosmic-ai/work/impact.json` 和 `impact/meta-index.json`、`impact/src-index.json`，不重建、不改任何东西。
 *
 * 口径：
 *   字节      文件大小；各块是这一块 JSON 序列化后的字节，超过 50 KB 的才列。
 *   字段行    快照里每张单的字段归属行，平均每行多少字节。
 *   读入      `loadIndex`（读文件 + 解析）加建一次查找表的毫秒，跑 5 次取中位数。
 */
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadIndex } from "../src/kernel/commands/impact.ts";
import { lookup } from "../src/kernel/impact/model.ts";
import { openProject } from "../src/kernel/open-project.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";

const VERSION = "s17-index-file-v1";
const args = process.argv.slice(2);
const root = args.find((a) => !a.startsWith("--"));
if (root === undefined) {
	console.error("用法：node --experimental-strip-types scripts/measure-index-file.ts <工程目录> [--json]");
	process.exit(2);
}
const work = join(root, ".cosmic-ai", "work");
const files = {
	"impact.json": join(work, "impact.json"),
	"meta-index.json": join(work, "impact", "meta-index.json"),
	"src-index.json": join(work, "impact", "src-index.json"),
};

const blocks: Record<string, { bytes: number; parts: Record<string, number> }> = {};
let fieldRow = { rows: 0, bytes: 0 };
for (const [name, path] of Object.entries(files)) {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		continue;
	}
	const json = JSON.parse(text) as Record<string, unknown>;
	const parts: Record<string, number> = {};
	for (const [key, value] of Object.entries(json)) {
		const size = Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
		if (size > 50_000) parts[key] = size;
	}
	const asked = json.asked as Record<string, unknown> | undefined;
	if (asked) for (const [key, value] of Object.entries(asked)) parts[`asked.${key}`] = JSON.stringify(value).length;
	blocks[name] = { bytes: statSync(path).size, parts };
	if (name === "meta-index.json" && Array.isArray(json.fields)) {
		fieldRow = { rows: json.fields.length, bytes: Buffer.byteLength(JSON.stringify(json.fields), "utf8") };
	}
}

const opened = await openProject({
	projectRoot: root,
	agentConfigDir: join(homedir(), ".fast-ai-cosmic"),
	cacheRoot: mkdtempSync(join(tmpdir(), "index-file-")),
	agentVersion: "0.1.0",
	resources: EMBEDDED_RESOURCES,
});
const times: number[] = [];
for (let i = 0; i < 5; i++) {
	const started = performance.now();
	const loaded = loadIndex(opened.ctx);
	if (!loaded.ok) {
		console.error(`读不了代码关系表：${loaded.error.message}`);
		process.exit(1);
	}
	lookup(loaded.value);
	times.push(performance.now() - started);
}
times.sort((a, b) => a - b);
const summary = {
	version: VERSION,
	project: root,
	files: blocks,
	fieldRows: { ...fieldRow, perRow: fieldRow.rows === 0 ? 0 : Math.round(fieldRow.bytes / fieldRow.rows) },
	loadMs: Math.round(times[2] as number),
};
if (args.includes("--json")) {
	console.log(JSON.stringify(summary, null, 2));
} else {
	console.log(`${VERSION}  ${root}`);
	for (const [name, block] of Object.entries(blocks)) {
		console.log(`${name}  ${block.bytes.toLocaleString()} 字节`);
		for (const [key, size] of Object.entries(block.parts)) console.log(`    ${key}  ${size.toLocaleString()}`);
	}
	console.log(
		`快照字段行 ${fieldRow.rows.toLocaleString()} 行，${fieldRow.bytes.toLocaleString()} 字节，平均每行 ${summary.fieldRows.perRow} 字节`,
	);
	console.log(`读入 + 建查找表：中位数 ${summary.loadMs} 毫秒（5 次）`);
}
