/**
 * S66 真机验证：`ptpl edit --plugin` 登记的打印插件，平台的整份提交认不认。
 *
 * 用法：
 *   node --experimental-strip-types scripts/verify-ptpl-plugin.ts <工程目录> <模板编码> <插件类全名>
 *        [--pk 单据ID或billno:编号] [--work 目录]
 *
 * 四步，都不落库：
 *   1. `meta ptpl dump <编码> --out <目录>/dump`（只读库，写两个本地文件）；
 *   2. `meta ptpl edit <目录>/cand --open …`、`--plugin <类全名>`、`--overview`（全在本地）；
 *   3. 看候选文件里 plugins 这一项是不是「字符串里的 JSON 数组」、原有的登记项动没动；
 *   4. `meta ptpl apply <编码> --file … --locale … [--pk …]` 预演（不带 apply，不写库）：
 *      差异里只有 plugins 一处、平台解析和保存前校验过得去，才说明这份登记平台读得懂；
 *      给了 --pk 再看候选在那张单上出预览时的输出。
 *
 * 目录默认 `.cosmic-ai/work/s66-plugin`（cosmic 自己的工作目录），每次重建。
 */
import { readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createKernelAdapter } from "../src/agent/tools/kernel-adapter.ts";
import { PRODUCT_ID } from "../src/brand.ts";
import { parseDesignText } from "../src/kernel/meta/ptpl-design.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
	const at = args.indexOf(`--${name}`);
	if (at < 0) return undefined;
	const value = args[at + 1];
	args.splice(at, 2);
	return value;
};
const pk = flag("pk");
const work = flag("work") ?? ".cosmic-ai/work/s66-plugin";
const [projectRoot, number, className] = args;
if (projectRoot === undefined || number === undefined || className === undefined) {
	console.error("用法：verify-ptpl-plugin.ts <工程目录> <模板编码> <插件类全名> [--pk 单据] [--work 目录]");
	process.exit(2);
}

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

const dir = resolve(projectRoot, work);
rmSync(dir, { recursive: true, force: true });
const dumpDir = join(dir, "dump");
const candDir = join(dir, "cand");

async function step(title: string, argv: string[]): Promise<string> {
	const started = Date.now();
	const done = await kernel.meta(project, argv, {});
	console.log(`== ${title}（${Date.now() - started} ms）`);
	if (!done.ok) {
		console.error(JSON.stringify(done.error.toJSON()));
		process.exit(1);
	}
	console.log(done.value.text);
	return done.value.text;
}

await step("1. dump", ["ptpl", "dump", number, "--out", dumpDir]);
await step("2a. 开候选", ["ptpl", "edit", candDir, "--open", dumpDir]);
await step("2b. 登记插件", ["ptpl", "edit", candDir, "--plugin", className, "--desc", "S66 真机验证"]);
await step("2c. 概览", ["ptpl", "edit", candDir, "--overview"]);

const safe = number.replace(/[^A-Za-z0-9._-]/g, "_");
const metaFile = join(candDir, `${safe}.meta.json`);
const localeFile = join(candDir, `${safe}.locale.json`);
const pluginsOf = (file: string): unknown =>
	(parseDesignText(readFileSync(file, "utf8")) as { plugins?: unknown }).plugins;
const before = pluginsOf(join(dumpDir, `${safe}.meta.json`));
const after = pluginsOf(metaFile);
console.log("== 3. 候选文件里的 plugins");
const kept = typeof before !== "string" || (typeof after === "string" && after.startsWith(before.slice(0, -1)));
console.log(JSON.stringify({ before, after, afterIsString: typeof after === "string", existingKept: kept }, null, 1));

const text = await step("4. apply 预演（不写库）", [
	"ptpl",
	"apply",
	number,
	"--file",
	metaFile,
	"--locale",
	localeFile,
	...(pk === undefined ? [] : ["--pk", pk]),
]);
const good =
	typeof after === "string" && kept && text.includes("plugins") && text.includes("dry-run 结束，数据库未修改");
console.log(good ? "== 结论：平台读得懂这份登记，预演走到了头" : "== 结论：没走通，见上面的输出");
process.exit(good ? 0 : 1);
