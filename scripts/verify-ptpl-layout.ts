/**
 * S37 2-A.3 真机验证：`ptpl dump` 写出的两份 JSON 是分行的，平台照样读得回来。
 *
 * 用法：
 *   node --experimental-strip-types scripts/verify-ptpl-layout.ts <工程目录> <模板编码> [输出目录]
 *
 * 三步，都不落库：
 *   1. `meta ptpl dump <编码> --out <输出目录>`（只读库，写两个本地文件）；
 *   2. 看两份文件的行数、最长一行、超过行宽的行是不是都只是一个拆不开的长字符串；
 *   3. 把刚导出的分行文件原样交给 `meta ptpl apply --file … --locale …` 预演（不带 apply，不写库）：
 *      平台读得回来、比出来没有改动，才说明分行只改了空白。
 *
 * 输出目录默认 `.cosmic-ai/work/s37-2a3-dump`（cosmic 自己的工作目录）。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createKernelAdapter } from "../src/agent/tools/kernel-adapter.ts";
import { PRODUCT_ID } from "../src/brand.ts";
import { JSON_LAYOUT_WIDTH } from "../src/kernel/json-layout.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";

const [projectRoot, number, outArg] = process.argv.slice(2);
if (projectRoot === undefined || number === undefined) {
	console.error("用法：verify-ptpl-layout.ts <工程目录> <模板编码> [输出目录]");
	process.exit(2);
}
const out = outArg ?? ".cosmic-ai/work/s37-2a3-dump";
const agentConfigDir = process.env.COSMIC_AGENT_DIR ?? join(homedir(), `.${PRODUCT_ID}`);
const kernel = createKernelAdapter({
	agentConfigDir,
	cacheRoot: process.env.COSMIC_CACHE_ROOT ?? join(agentConfigDir, "cache"),
	agentVersion: "0.1.0",
	resources: EMBEDDED_RESOURCES,
});

const opened = await kernel.open(projectRoot);
if (!opened.ok) {
	console.error(JSON.stringify(opened.error.toJSON()));
	process.exit(1);
}
const project = opened.value.handle;
const started = Date.now();
const dump = await kernel.meta(project, ["ptpl", "dump", number, "--out", out], {});
console.log(`== 1. dump（${Date.now() - started} ms）`);
if (!dump.ok) {
	console.error(JSON.stringify(dump.error.toJSON()));
	process.exit(1);
}
console.log(dump.value.text);

const safe = number.replace(/[^A-Za-z0-9._-]/g, "_");
const dir = resolve(projectRoot, out);
const metaFile = join(dir, `${safe}.meta.json`);
const localeFile = join(dir, `${safe}.locale.json`);
const LONE = /^\t*(?:"(?:[^"\\]|\\.)*":)?(?:"(?:[^"\\]|\\.)*"|[^,{}[\]"]+),?$/;
console.log("== 2. 文件形状");
let bad = 0;
for (const file of [metaFile, localeFile]) {
	const text = readFileSync(file, "utf8");
	const rows = text.replace(/\n$/, "").split("\n");
	const wide = rows.filter((row) => row.length > JSON_LAYOUT_WIDTH + 1);
	const notLone = wide.filter((row) => !LONE.test(row));
	bad += notLone.length;
	console.log(
		JSON.stringify({
			file,
			bytes: Buffer.byteLength(text),
			lines: rows.length,
			maxLine: Math.max(...rows.map((row) => row.length)),
			wideLines: wide.length,
			wideNotLoneScalar: notLone.length,
		}),
	);
}

const again = Date.now();
const apply = await kernel.meta(project, ["ptpl", "apply", number, "--file", metaFile, "--locale", localeFile], {});
console.log(`== 3. apply 预演（不写库，${Date.now() - again} ms）`);
if (!apply.ok) {
	console.error(JSON.stringify(apply.error.toJSON()));
	process.exit(1);
}
console.log(apply.value.text);
process.exit(bad === 0 ? 0 : 1);
