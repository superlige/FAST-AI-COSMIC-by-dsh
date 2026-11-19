/**
 * 大 Java 提纲的尺子（S34 批 2）：一批 Java 文件各自的大小、提纲大小、解析成没成。
 *
 *   node --experimental-strip-types scripts/measure-java-outline.ts [--json] <工程目录> [文件或目录…]
 *
 * 只给工程目录时量批 0 基线里被整份读过的那几个文件（S34 批 0 基线 §3）；
 * 另给目录时递归量其中所有超过阈值的 `.java`。只读文件，不改任何东西。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { OUTLINE_MIN_BYTES, outlineJava, renderOutline } from "../src/agent/tools/java-outline.ts";

/** 五份基线样本里整份读过、超过 20 KiB 的文件（相对真机工程）。 */
const BASELINE = [
	"zlgd-hhx/src/main/java/zlgd/zljy/printplugin/MetallographicBilingualPrintPlugin.java",
	"zlgd-hhx/src/main/java/zlgd/zljy/printplugin/CNASReportPrintPlugin.java",
	"zlgd-hhx/src/main/java/zlgd/zljy/printplugin/MetallographicprePrintCommonPlugin.java",
	"zlgd-hhx/src/main/java/zlgd/zljy/formplugin/QTYXNLWTDFormPlugin.java",
];

function javaFiles(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		if (name === "build" || name === "node_modules" || name.startsWith(".")) continue;
		const path = join(dir, name);
		const stat = statSync(path);
		if (stat.isDirectory()) out.push(...javaFiles(path));
		else if (name.endsWith(".java") && stat.size > OUTLINE_MIN_BYTES) out.push(path);
	}
	return out;
}

const args = process.argv.slice(2);
const json = args.includes("--json");
const [root, ...targets] = args.filter((arg) => arg !== "--json");
if (root === undefined) {
	console.error("用法：measure-java-outline.ts [--json] <工程目录> [文件或目录…]");
	process.exit(2);
}
const files =
	targets.length === 0
		? BASELINE.map((file) => resolve(root, file))
		: targets.flatMap((target) => {
				const path = resolve(root, target);
				return statSync(path).isDirectory() ? javaFiles(path) : [path];
			});

const rows = files.map((file) => {
	const text = readFileSync(file, "utf8");
	const bytes = Buffer.byteLength(text, "utf8");
	const outline = outlineJava(text);
	const rendered = outline === null ? null : renderOutline(relative(root, file), outline, bytes);
	const outlineBytes = rendered === null ? null : Buffer.byteLength(rendered, "utf8");
	const verdict =
		bytes <= OUTLINE_MIN_BYTES
			? "小文件，给全文"
			: outline === null
				? "解析失败，给全文"
				: (outlineBytes as number) * 2 > bytes
					? "提纲超过一半，给全文"
					: "给提纲";
	return {
		file: relative(root, file).replace(/\\/g, "/"),
		bytes,
		lines: text.split("\n").length,
		outlineBytes,
		ratio: outlineBytes === null ? null : Number((outlineBytes / bytes).toFixed(4)),
		methods: outline?.methods.length ?? null,
		constants: outline?.constants.length ?? null,
		codes: outline?.codes.length ?? null,
		verdict,
	};
});

const outlined = rows.filter((row) => row.verdict === "给提纲");
const summary = {
	files: rows.length,
	outlined: outlined.length,
	parseFailed: rows.filter((row) => row.verdict === "解析失败，给全文").length,
	tooBig: rows.filter((row) => row.verdict === "提纲超过一半，给全文").length,
	fileBytes: outlined.reduce((sum, row) => sum + row.bytes, 0),
	outlineBytes: outlined.reduce((sum, row) => sum + (row.outlineBytes ?? 0), 0),
};

if (json) console.log(JSON.stringify({ threshold: OUTLINE_MIN_BYTES, summary, rows }, null, 2));
else {
	for (const row of rows)
		console.log(
			`${row.verdict}\t${String(row.bytes)} → ${String(row.outlineBytes ?? "-")}\t方法 ${String(row.methods ?? "-")}\t编码 ${String(row.codes ?? "-")}\t${row.file}`,
		);
	console.log(
		`\n共 ${String(summary.files)} 个；给提纲 ${String(summary.outlined)}，解析失败 ${String(summary.parseFailed)}，提纲过大 ${String(summary.tooBig)}；` +
			`给提纲的原文 ${String(summary.fileBytes)} 字节 → 提纲 ${String(summary.outlineBytes)} 字节`,
	);
}
