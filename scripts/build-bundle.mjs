#!/usr/bin/env node
/**
 * 把组合包编成能装进安装包的 JS 包：`dist/fast-ai-cosmic/`。
 *
 * 用法：node scripts/build-bundle.mjs [--version <版本号>]
 *   --version 给包写的版本号；打桌面安装包时 dsh 只收和它自己同版本号的模块，由 package-desktop.mjs 传进来。
 *
 * 为什么要编：开发时 dsh 用 tsx 直接跑本仓库的 .ts；装进桌面版后组合包在 node_modules 下，
 * Node 不给 node_modules 里的 .ts 去类型，加载就失败。所以把产品插件和它用到的一切（含 typebox）
 * 合成一个 tools.js；dsh 的包只在类型层面引用，编完没有对 @deepseek-ai/* 的运行时依赖。
 *
 * 产物：
 *   tools.js          产品插件（src/dsh/index.ts）
 *   brand.js          品牌行的宿主半边（src/dsh/brand.ts）
 *   client.js         界面品牌（client/brand.js，原样拷）
 *   cordis.patch.yml  两个预设、关掉的行
 *   knowledge/        知识包、技能文档包
 *   package.json
 * 编完跑一遍产物审计（不带 JAR、客户配置、凭据），不过就失败。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { rolldown } from "rolldown";
import { auditReleaseTree, formatAuditReport } from "../src/runtime/release-audit.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const at = args.indexOf("--version");
const manifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
const version = at >= 0 ? args[at + 1] : manifest.version;
if (version === undefined || version === "") throw new Error("--version 后面要跟版本号");

const out = join(repo, "dist", manifest.name);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const started = Date.now();
const bundle = await rolldown({
	input: { tools: join(repo, "src/dsh/index.ts"), brand: join(repo, "src/dsh/brand.ts") },
	platform: "node",
	// dsh 的包只有类型引用，编完应当一个都不剩；剩了说明有运行时依赖，下面会查出来
	external: [/^node:/, /^@deepseek-ai\//],
	logLevel: "warn",
});
await bundle.write({ dir: out, format: "esm", entryFileNames: "[name].js", chunkFileNames: "chunks/[name]-[hash].js" });
await bundle.close();

const tools = readFileSync(join(out, "tools.js"), "utf8");
const leaked = [...new Set(tools.match(/from\s+["']@deepseek-ai\/[^"']+["']/g) ?? [])];
if (leaked.length > 0) throw new Error(`tools.js 还在运行时引用 dsh 的包：${leaked.join("、")}`);

cpSync(join(repo, "client/brand.js"), join(out, "client.js"));
cpSync(join(repo, "cordis.patch.yml"), join(out, "cordis.patch.yml"));
mkdirSync(join(out, "knowledge"), { recursive: true });
for (const pack of ["cosmic-kb.pack", "reference.pack"]) {
	const from = join(repo, "knowledge", pack);
	if (!existsSync(from)) throw new Error(`缺知识包：${from}`);
	cpSync(from, join(out, "knowledge", pack));
}

writeFileSync(
	join(out, "package.json"),
	`${JSON.stringify(
		{
			name: manifest.name,
			version,
			description: manifest.description,
			license: "UNLICENSED",
			type: "module",
			exports: {
				".": "./brand.js",
				"./tools": "./tools.js",
				"./client": "./client.js",
				"./package.json": "./package.json",
			},
			files: ["tools.js", "brand.js", "client.js", "chunks", "cordis.patch.yml", "knowledge"],
			dsh: manifest.dsh,
			engines: manifest.engines,
		},
		null,
		2,
	)}\n`,
);

// 编出来的东西能直接被 Node 加载（不经 tsx），插件入口的形状对
const loaded = await import(pathToFileURL(join(out, "tools.js")).href);
if (loaded.name !== "fast-ai-cosmic" || typeof loaded.apply !== "function")
	throw new Error("tools.js 加载后不是 dsh 插件（缺 name 或 apply）");
// 编出来的代码自己找得到两个知识包（找包的代码会被拆进 chunks/，按层数猜过路径，打包后就落空）
// （环境变量 COSMIC_KB_PACK / COSMIC_REFERENCE_PACK 会盖过包内路径，核对前清掉）
delete process.env.COSMIC_KB_PACK;
delete process.env.COSMIC_REFERENCE_PACK;
const packs = loaded.cosmicPackFiles();
for (const [key, file] of [
	["knowledgePackFile", "cosmic-kb.pack"],
	["referencePackFile", "reference.pack"],
]) {
	const want = join(out, "knowledge", file);
	if (packs[key] === undefined || resolve(packs[key]) !== resolve(want))
		throw new Error(`编出来的 tools.js 找不到 ${file}：解析到 ${String(packs[key])}，应为 ${want}`);
}

const audit = auditReleaseTree(out);
console.log(formatAuditReport(audit));
if (!audit.pass) process.exit(1);

const kb = (file) => `${(statSync(join(out, file)).size / 1024).toFixed(0)} KB`;
console.log(
	`组合包 ${manifest.name}@${version} → ${out}（${String(Date.now() - started)} ms）\n` +
		`  tools.js ${kb("tools.js")}，知识包 ${kb("knowledge/cosmic-kb.pack")}，技能文档包 ${kb("knowledge/reference.pack")}`,
);
