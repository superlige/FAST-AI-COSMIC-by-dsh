/**
 * 尺子：在这个工程的类路径上找一个类要多久。
 *
 *   node --experimental-strip-types scripts/measure-classpath-lookup.ts <工程目录> [--hit <整类名>] [--rounds 200]
 *     [--jvm-opt <-D名=值>]… [--agent]
 *
 * 苍穹进程的类路径上有几千个包，Java 找类是从头到尾一个个翻：找到的平均翻一半，找不到的翻到底。
 * 这把尺子起一个只碰类加载器的冷进程（不进苍穹、不连环境），量：
 * - 第一次找（要把所有包打开一遍）多久；
 * - 之后找一个不存在的类、找一个存在的类各多久；
 * - 顺带量本机名反查（平台装数据库驱动时会做一次）。
 * 另报类路径上有几个包、几个目录。
 *
 * `--agent` 带上和探针进程一样的换类代理（配了 JRebel 时它会接管找类），看差多少。
 * 口径和基线见 `docs/S60-resident-startup-and-first-touch.md` §2。
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createKernelAdapter } from "../src/agent/tools/kernel-adapter.ts";
import { PRODUCT_ID } from "../src/brand.ts";
import { baseChildEnv, type KernelContext } from "../src/kernel/context.ts";
import { classpathOf, runJava, runJavac } from "../src/kernel/toolchain.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";

const argv = process.argv.slice(2);
const root = resolve(argv[0] ?? ".");
const one = (name: string): string | undefined => {
	const at = argv.indexOf(name);
	return at >= 0 ? argv[at + 1] : undefined;
};
const many = (name: string): string[] => argv.flatMap((arg, at) => (arg === name ? [argv[at + 1] ?? ""] : []));

const agentConfigDir = join(homedir(), `.${PRODUCT_ID}`);
const kernel = createKernelAdapter({
	agentConfigDir,
	cacheRoot: join(agentConfigDir, "cache"),
	agentVersion: "0.0.0-dev",
	resources: EMBEDDED_RESOURCES,
});
const opened = await kernel.open(root);
if (!opened.ok) {
	console.error(JSON.stringify(opened.error.toJSON()));
	process.exit(1);
}
const ctx = (opened.value.handle as unknown as { ctx: KernelContext }).ctx;

const entries = readFileSync(ctx.layout.javacArgs, "utf8")
	.split(/[;\r\n"]+/)
	.map((entry) => entry.trim())
	.filter((entry) => /[\\/]/.test(entry));
const jars = entries.filter((entry) => /\.jar$/i.test(entry)).length;
console.log(`类路径：${String(jars)} 个包，${String(entries.length - jars)} 个目录`);

const classes = mkdtempSync(join(tmpdir(), "cosmic-classpath-lookup-"));
let exitCode = 0;
try {
	const compiled = await runJavac(ctx, [
		"-encoding",
		"UTF-8",
		"-nowarn",
		"-proc:none",
		"-d",
		classes,
		join(import.meta.dirname, "classpath-lookup", "ClasspathLookupBench.java"),
	]);
	if (compiled.status !== 0) {
		console.log(`没编过：\n${compiled.out.slice(0, 3000)}`);
		exitCode = 1;
	} else {
		const run = await runJava(
			ctx,
			[
				"-Dfile.encoding=UTF-8",
				...many("--jvm-opt"),
				"-cp",
				classpathOf(classes, ctx.layout.probeClasses, ctx.layout.pathingJar),
				"ClasspathLookupBench",
				one("--hit") ?? "kd.bos.form.FormShowParameter",
				one("--rounds") ?? "200",
				...(argv.includes("--index") ? ["index"] : []),
			],
			baseChildEnv(ctx),
		);
		console.log(`冷进程跑了 ${run.seconds} 秒，退出码 ${String(run.status)}`);
		console.log(run.out.trim().slice(-3000));
		if (run.status !== 0) exitCode = 1;
	}
} finally {
	rmSync(classes, { recursive: true, force: true });
}
process.exit(exitCode);
