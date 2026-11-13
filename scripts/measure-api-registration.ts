/**
 * 接口登记一次看全、探针输出里的本工程类名标出在不在工程里（S38）——固定样本的尺子。
 *
 * 用法：node --experimental-strip-types scripts/measure-api-registration.ts <真机工程> [--save <目录>]
 *
 * 为什么要有它：S37 需求 1 复测里，模型为弄清一条接口登记的入参和返回，先用 MetaProbe 摸登记表字段名、
 * 再用 DataQueryProbe 拼查询（09-28 批 8：3 + 5 次，两次字段名写错）；登记指向的实现类在工程里已经不存在，
 * 它又去 find / grep / 翻日志和 git 历史确认（批 6：十几次）。这把尺子对固定的几条 ApiMetaProbe 调用，
 * 量一次调用给出了什么：请求体、返回参数、Query 参数、配置参数各有没有，实现类有没有标出在不在工程里，
 * 以及耗时和输出大小。改前改后用同一批样本各跑一次，数并排写进阶段文档。
 *
 * 另外核对一件平台事实（写参考文档前要实测）：工程里带 @ApiController 的类，是不是都在登记表里有一条。
 * 有的没有，就说明登记不是部署后自动生成的。只读：只跑查询探针，不写任何东西。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { probe } from "../src/kernel/commands/probe.ts";
import { openProject } from "../src/kernel/open-project.ts";
import { stopServer } from "../src/kernel/probe/server.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";

const projectRoot = process.argv[2];
if (!projectRoot) {
	throw new Error(
		"用法：node --experimental-strip-types scripts/measure-api-registration.ts <真机工程> [--save <目录>]",
	);
}
const saveAt = process.argv.indexOf("--save");
const saveDir = saveAt > 0 ? process.argv[saveAt + 1] : undefined;
if (saveDir !== undefined) mkdirSync(saveDir, { recursive: true });

const scratch = mkdtempSync(join(tmpdir(), "cosmic-api-ruler-"));
const opened = await openProject({
	projectRoot: resolve(projectRoot),
	agentConfigDir: join(scratch, "agent"),
	cacheRoot: join(scratch, "cache"),
	agentVersion: "s38-ruler",
	resources: EMBEDDED_RESOURCES,
});
const ctx = opened.ctx;

// 样本：S37 复测里真查过的几种问法。wtdwithdraw/withdraw 是一条实现类已不在工程里的旧登记。
const samples = [
	{ id: "number-stale", env: { API_NUMBER: "wtdwithdraw/withdraw" } },
	{ id: "entity-test-bill", env: { API_ENTITY: "zlgd_sys_test_bill" } },
	{ id: "plugin-existing", env: { API_PLUGIN: "HandleReturenDataInter" } },
	{ id: "entity-wtd", env: { API_ENTITY: "zlgd_qty_wtd" } },
	{ id: "fields-wtd", env: { API_ENTITY: "zlgd_qty_wtd", API_FIELDS: "wtdh,org" } },
] as const;

console.log(JSON.stringify({ kind: "ruler", version: "s38-api-v1", runtimeKeyId: ctx.runtimeKeyId }));
try {
	for (const sample of samples) {
		const started = Date.now();
		const result = await probe(ctx, "ApiMetaProbe", { env: { ...sample.env } });
		if (!result.ok) throw new Error(`${sample.id}: ${result.error.message}`);
		const text = [result.value.output, ...result.value.notes].join("\n");
		if (saveDir !== undefined) writeFileSync(join(saveDir, `${sample.id}.txt`), text);
		console.log(
			JSON.stringify({
				kind: "sample",
				id: sample.id,
				env: sample.env,
				exitCode: result.value.exitCode,
				ms: Date.now() - started,
				outputBytes: Buffer.byteLength(text, "utf8"),
				lines: text.split("\n").length,
				apis: Number(/命中 (\d+) 个 API/.exec(text)?.[1] ?? -1),
				// 一次调用里各类参数实际列出了几行（只有计数、没列出来的不算）
				listed: listedRows(text),
				// 实现类、插件类在不在工程里有没有说出来
				classNote: /工程源码里没有|在工程里：/.test(text),
			}),
		);
	}

	// 平台事实：带 @ApiController 的类是不是都有登记
	const annotated = annotatedControllers(ctx.layout.moduleDirs.map((dir) => dir.src));
	const roots = [...new Set(annotated.map((cls) => cls.split(".")[0]))];
	const registered = new Set<string>();
	for (const root of roots) {
		const result = await probe(ctx, "ApiMetaProbe", { env: { API_PLUGIN: `${root}.` } });
		if (!result.ok) throw new Error(`API_PLUGIN=${root}.: ${result.error.message}`);
		for (const match of result.value.output.matchAll(/实现类 ([\w.$]+)/g)) registered.add(match[1] as string);
	}
	const missing = annotated.filter((cls) => !registered.has(cls));
	// 登记的实现类在不在本工程源码里：按包名拼路径看文件，不看有没有注解（旧写法的接口类不带 @ApiController）
	const hasSource = (cls: string): boolean =>
		ctx.layout.moduleDirs.some((dir) => existsSync(join(dir.src, `${cls.split("$")[0]?.split(".").join("/")}.java`)));
	const withoutSource = [...registered].filter((cls) => !hasSource(cls));
	console.log(
		JSON.stringify({
			kind: "fact",
			id: "annotated-vs-registered",
			annotated: annotated.length,
			registered: annotated.length - missing.length,
			withoutRegistration: missing,
			registrations: registered.size,
			registrationsWithoutSource: withoutSource.length,
			registrationsWithoutSourceSample: withoutSource.slice(0, 10),
		}),
	);
} finally {
	await stopServer(ctx);
}

/**
 * 每类参数列出的行数：跟在「请求体：」这类小标题下、缩进更深的 `[PROBE]` 行。
 * 改前的探针只有带 API_FIELDS 时打「请求体匹配 […] 共 N 个参数」再逐行列，也按请求体算。
 */
function listedRows(text: string): Record<string, number> {
	const rows: Record<string, number> = { query: 0, body: 0, response: 0, ext: 0 };
	const section: Record<string, string> = {
		"Query 参数：": "query",
		"请求体：": "body",
		"返回参数：": "response",
		"配置参数：": "ext",
	};
	let current: string | null = null;
	for (const line of text.split("\n")) {
		const head = /^\[PROBE\] {3}(\S.*)$/.exec(line)?.[1];
		if (head !== undefined) {
			current = section[head] ?? (head.startsWith("请求体匹配") ? "body" : null);
			continue;
		}
		if (current !== null && /^\[PROBE\] {5}\S/.test(line)) rows[current] = (rows[current] ?? 0) + 1;
		else current = null;
	}
	return rows;
}

/** 模块源码里带 @ApiController 注解的类，按包名 + 文件名拼全名。 */
function annotatedControllers(srcRoots: readonly string[]): string[] {
	const found: string[] = [];
	const walk = (dir: string): void => {
		for (const name of readdirSync(dir)) {
			const full = join(dir, name);
			if (statSync(full).isDirectory()) walk(full);
			else if (name.endsWith(".java")) {
				const text = readFileSync(full, "utf8");
				if (!/@ApiController\b/.test(text)) continue;
				const pkg = /^\s*package\s+([\w.]+)\s*;/m.exec(text)?.[1];
				found.push(pkg === undefined ? name.slice(0, -5) : `${pkg}.${name.slice(0, -5)}`);
			}
		}
	};
	for (const root of srcRoots) {
		try {
			walk(root);
		} catch {
			// 没有源码目录的模块跳过
		}
	}
	return found.sort();
}
