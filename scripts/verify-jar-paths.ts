/**
 * S37 真机验证：cosmic 返回里提到平台 jar 时给的是完整路径，而且那个路径上真有这个 jar。
 *
 * 用法：node --experimental-strip-types scripts/verify-jar-paths.ts <工程目录>
 *
 * 三处：findclass 的 jarPaths、api 的 jar、公式目录（formula print）的 source。
 * 用的是真机上几次满盘 find 找过的那几个：bos-print-core（PWLayoutGrid）、bos-print-business（打印公式目录）。
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createKernelAdapter } from "../src/agent/tools/kernel-adapter.ts";
import { PRODUCT_ID } from "../src/brand.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";

const [projectRoot] = process.argv.slice(2);
if (projectRoot === undefined) {
	console.error("用法：verify-jar-paths.ts <工程目录>");
	process.exit(2);
}
const agentConfigDir = process.env.COSMIC_AGENT_DIR ?? join(homedir(), `.${PRODUCT_ID}`);
const kernel = createKernelAdapter({
	agentConfigDir,
	cacheRoot: process.env.COSMIC_CACHE_ROOT ?? join(agentConfigDir, "cache"),
	agentVersion: "0.1.0",
	resources: EMBEDDED_RESOURCES,
	knowledgePackFile: fileURLToPath(new URL("../knowledge/cosmic-kb.pack", import.meta.url)),
});
const opened = await kernel.open(projectRoot);
if (!opened.ok) {
	console.error(JSON.stringify(opened.error.toJSON()));
	process.exit(1);
}
const project = opened.value.handle;
let failures = 0;
function check(label: string, path: string | undefined): void {
	const ok = path !== undefined && /[\\/]/.test(path) && existsSync(path);
	console.log(`${ok ? "✔" : "✘"} ${label}：${path ?? "(没有)"}`);
	if (!ok) failures++;
}

const found = await kernel.knowledge({ action: "findclass", query: "PWLayoutGrid" }, projectRoot, project);
if (!found.ok) {
	console.log(JSON.stringify(found.error.toJSON()).slice(0, 800));
	failures++;
} else {
	const report = found.value as { hits?: { fqcn: string; jar: string }[]; jarPaths?: Record<string, string> };
	for (const hit of report.hits ?? []) check(`findclass ${hit.fqcn}`, report.jarPaths?.[hit.jar]);
}

const api = await kernel.knowledge(
	{ action: "api", query: "kd.bos.print.core.model.widget.grid.layoutgrid.PWLayoutGrid" },
	projectRoot,
	project,
);
if (!api.ok) {
	console.log(JSON.stringify(api.error.toJSON()).slice(0, 800));
	failures++;
} else {
	const jar = /"jar":"((?:[^"\\]|\\.)*)"/.exec(JSON.stringify(api.value))?.[1];
	check("api PWLayoutGrid 的 jar", jar === undefined ? undefined : JSON.parse(`"${jar}"`));
}

const formula = await kernel.meta(project, ["formula", "print", "--group", "集合函数"], {});
// 同一台常驻进程上已经原样问过两次时，工具拒绝再跑并指向上次的输出文件：从那份输出里读
const settled = formula.ok ? null : (formula.error.toJSON() as { code?: string; detail?: { outFile?: string } });
const formulaText = formula.ok
	? JSON.stringify(formula.value)
	: settled?.code === "PROBE_ANSWER_SETTLED" && settled.detail?.outFile
		? readFileSync(settled.detail.outFile, "utf8")
		: "";
if (formulaText === "") {
	console.log(JSON.stringify(settled).slice(0, 800));
	failures++;
} else {
	const source = /source=PrintInitFunction\.xml @ (.+?\.jar)/.exec(formulaText)?.[1];
	// JSON.stringify 过的文本里路径分隔符是双反斜杠，落盘的原始输出里是单个
	check("formula print 的 source", formula.ok ? source?.replace(/\\\\/g, "\\") : source);
}
console.log(failures === 0 ? "全部给了完整路径，路径上有这个 jar" : `${failures} 处不对`);
process.exit(failures === 0 ? 0 : 1);
