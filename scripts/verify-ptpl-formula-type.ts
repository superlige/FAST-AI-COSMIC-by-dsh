/**
 * 真机验证：`ptpl edit --formula` 写进去的字段操作数带不带对字段类型，整份提交预演时公式试算过不过。
 *
 * 用法：
 *   node --experimental-strip-types scripts/verify-ptpl-formula-type.ts <工程目录> <模板编码> <模板目录> <控件> <公式行>
 *        [--work 目录] [--candidate]
 *
 * `<模板目录>` 是 `meta ptpl dump` 导出的那份（候选从它开）；加 `--candidate` 时它是一份已经开好、改过的候选，
 * 复制一份过来接着改（原目录不动），看在旧候选上重写同一格公式时会不会照抄它自己旧的类型。三步，都不落库：
 *   1. `meta ptpl edit <目录>/cand --open <模板目录>`，再 `--formula <控件> --line <公式行>`（全在本地）；
 *   2. 读候选文件，列出这个控件公式里每个字段操作数的 `textFormat`；
 *   3. `meta ptpl apply <编码> --file … --locale …` 预演（不带 apply，不写库），看公式试算报没报错、预演走没走到头。
 *
 * 2026-10-17 那次会话的复测（发布日期改取审核日期）：
 *   … D:/kingdee/zlgd_ygpt2.0 zlgd_sys_test_bill_prtpl_9_copy outputs/chemical-report/before/9 Text23 \
 *     "IF(<auditdate>=null,\"发布日期： 年  月  日\",CONCAT('发布日期：',YEAR(<auditdate>),\"年\",MONTH(<auditdate>),\"月\",DAY(<auditdate>),\"日\"))"
 *
 * 目录默认 `.cosmic-ai/work/ptpl-formula-type`（cosmic 自己的工作目录），每次重建。
 */
import { cpSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createKernelAdapter } from "../src/agent/tools/kernel-adapter.ts";
import { PRODUCT_ID } from "../src/brand.ts";
import { parseDesignText } from "../src/kernel/meta/ptpl-design.ts";
import { isOperand } from "../src/kernel/meta/ptpl-formula.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
	const at = args.indexOf(`--${name}`);
	if (at < 0) return undefined;
	const value = args[at + 1];
	args.splice(at, 2);
	return value;
};
const work = flag("work") ?? ".cosmic-ai/work/ptpl-formula-type";
const fromCandidate = args.includes("--candidate");
if (fromCandidate) args.splice(args.indexOf("--candidate"), 1);
const [projectRoot, number, fromDir, control, line] = args;
if ([projectRoot, number, fromDir, control, line].some((one) => one === undefined)) {
	console.error("用法：verify-ptpl-formula-type.ts <工程目录> <模板编码> <模板目录> <控件> <公式行> [--work 目录]");
	process.exit(2);
}
const root = projectRoot as string;

const agentConfigDir = process.env.COSMIC_AGENT_DIR ?? join(homedir(), `.${PRODUCT_ID}`);
const kernel = createKernelAdapter({
	agentConfigDir,
	cacheRoot: process.env.COSMIC_CACHE_ROOT ?? join(agentConfigDir, "cache"),
	agentVersion: "0.1.0",
	resources: EMBEDDED_RESOURCES,
});
const opened = await kernel.open(root);
if (!opened.ok) {
	console.error(JSON.stringify(opened.error.toJSON()));
	process.exit(1);
}
const project = opened.value.handle;

const dir = resolve(root, work);
rmSync(dir, { recursive: true, force: true });
const candDir = join(dir, "cand");
const source = isAbsolute(fromDir as string) ? (fromDir as string) : resolve(root, fromDir as string);

async function step(title: string, argv: string[], mayFail = false): Promise<string> {
	const started = Date.now();
	const done = await kernel.meta(project, argv, {});
	console.log(`== ${title}（${Date.now() - started} ms）`);
	if (!done.ok) {
		const text = JSON.stringify(done.error.toJSON());
		console.log(text);
		if (!mayFail) process.exit(1);
		return text;
	}
	console.log(done.value.text);
	return done.value.text;
}

if (fromCandidate) {
	cpSync(source, candDir, { recursive: true });
	console.log(`== 1a. 复制已有候选：${source} -> ${candDir}`);
} else {
	await step("1a. 开候选", ["ptpl", "edit", candDir, "--open", source]);
}
await step("1b. 改公式", ["ptpl", "edit", candDir, "--formula", control as string, "--line", line as string]);

const safe = (number as string).replace(/[^A-Za-z0-9._-]/g, "_");
const metaFile = join(candDir, `${safe}.meta.json`);
const localeFile = join(candDir, `${safe}.locale.json`);
const formats = new Map<string, string>();
const walk = (node: unknown): void => {
	if (Array.isArray(node)) {
		for (const one of node) walk(one);
		return;
	}
	if (node === null || typeof node !== "object") return;
	const cell = node as Record<string, unknown>;
	if ((cell.key === control || cell.id === control) && Array.isArray(cell.formulaData)) {
		for (const part of cell.formulaData) if (isOperand(part)) formats.set(part.bindField, String(part.textFormat));
	}
	for (const value of Object.values(cell)) walk(value);
};
walk(parseDesignText(readFileSync(metaFile, "utf8")));
console.log("== 2. 候选里公式字段的类型");
for (const [field, format] of formats) console.log(`  ${field}: ${format}`);

const text = await step(
	"3. apply 预演（不写库）",
	["ptpl", "apply", number as string, "--file", metaFile, "--locale", localeFile],
	true,
);
const passed = text.includes("dry-run 结束，数据库未修改") && !text.includes("formula-error");
console.log(passed ? "== 结论：公式试算过了，预演走到了头" : "== 结论：没走通，见上面的输出");
process.exit(passed ? 0 : 1);
