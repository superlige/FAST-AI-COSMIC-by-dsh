/**
 * 尺子：查平台类签名时，"这个类上有没有某个方法 / 字段"答得对不对，整类查时模型收到多少。
 *
 * 用法：
 *   node --experimental-strip-types scripts/measure-api-members.ts <工程目录> [--list scripts/checklists/api-members.json] [--json]
 *
 * 走工具同一个入口（cosmic_knowledge action=api）。清单里每条 `类#名字` 标着 JAR 里到底有没有
 * （javap 核过）：有的被说成"没有"（memberMissing）、没有的被说成"有"，都算答错。
 * 整类查的几个类，按交给模型时同一套裁剪（只留签名、方法和字段各最多 60 行）报几行、几个 protected、多少字节。
 *
 * 只读：不起苍穹进程、不连环境；要另起 Java 进程反射用户的 JAR。口径和基线见 `docs/S79-api-protected-inherited.md` §2。
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createKernelAdapter } from "../src/agent/tools/kernel-adapter.ts";
import { budgetApiMethods } from "../src/agent/tools/output-budget.ts";
import { PRODUCT_ID } from "../src/brand.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";

const argv = process.argv.slice(2);
const one = (name: string): string | undefined => {
	const at = argv.indexOf(name);
	return at < 0 ? undefined : argv[at + 1];
};
const project = argv[0];
if (project === undefined || project.startsWith("--")) {
	console.error("用法：measure-api-members.ts <工程目录> [--list <清单.json>] [--json]");
	process.exit(2);
}
const listFile = one("--list") ?? join(import.meta.dirname, "checklists", "api-members.json");
const list = JSON.parse(readFileSync(listFile, "utf8")) as {
	members: { query: string; exists: boolean; why: string }[];
	classes: string[];
};

const agentConfigDir = join(homedir(), `.${PRODUCT_ID}`);
const kernel = createKernelAdapter({
	agentConfigDir,
	cacheRoot: join(agentConfigDir, "cache"),
	agentVersion: "0.0.0-dev",
	resources: EMBEDDED_RESOURCES,
	knowledgePackFile: join(import.meta.dirname, "..", "knowledge", "cosmic-kb.pack"),
});
const root = resolve(project);
const opened = await kernel.open(root);
if (!opened.ok) {
	console.error(JSON.stringify(opened.error.toJSON()));
	process.exit(1);
}

interface Entry {
	memberMissing: boolean;
	methods: string[];
	fields?: string[];
	constructors?: string[];
	join: { joined: unknown[]; dangling: unknown[]; inherited: unknown[]; undocumented: unknown[] } | null;
}

async function api(query: string): Promise<Entry | string> {
	const result = await kernel.knowledge(
		{ action: "api", query } as never,
		root,
		opened.ok ? opened.value.handle : never(),
	);
	if (!result.ok) return `${result.error.code} ${result.error.message}`;
	const entry = (result.value as { entries?: Entry[] }).entries?.[0];
	return entry ?? "没有返回条目";
}

function never(): never {
	throw new Error("unreachable");
}

const members = [];
for (const item of list.members) {
	const entry = await api(item.query);
	if (typeof entry === "string") {
		members.push({ ...item, answered: null, right: false, first: entry });
		continue;
	}
	const found = !entry.memberMissing;
	const first = [...entry.methods, ...(entry.fields ?? []), ...(entry.constructors ?? [])][0] ?? "";
	members.push({ ...item, answered: found, right: found === item.exists, first });
}

const classes = [];
for (const fqcn of list.classes) {
	const entry = await api(fqcn);
	if (typeof entry === "string") {
		classes.push({ fqcn, error: entry });
		continue;
	}
	const methods = budgetApiMethods(entry.methods);
	const fields = budgetApiMethods(entry.fields ?? []);
	const view = {
		...entry,
		methods: methods.methods,
		fields: fields.methods,
		join:
			entry.join === null
				? null
				: {
						joined: entry.join.joined.length,
						dangling: entry.join.dangling.length,
						inherited: entry.join.inherited.length,
						undocumented: entry.join.undocumented.length,
					},
	};
	classes.push({
		fqcn,
		shown: methods.methods.length,
		omitted: methods.omittedMethods,
		protectedShown: [...methods.methods, ...fields.methods].filter((line) => line.startsWith("protected ")).length,
		dangling: entry.join?.dangling.length ?? null,
		bytes: Buffer.byteLength(JSON.stringify(view), "utf8"),
	});
}

if (argv.includes("--json")) {
	console.log(JSON.stringify({ members, classes }, null, 2));
} else {
	const wrong = members.filter((row) => !row.right);
	console.log(`按名字查 ${members.length} 条，答对 ${members.length - wrong.length} 条`);
	for (const row of members) {
		const said = row.answered === null ? "出错" : row.answered ? "有" : "没有";
		console.log(
			`  ${row.right ? "✔" : "✘"} ${row.query}  实际${row.exists ? "有" : "没有"}，答${said}  ${row.first.slice(0, 90)}`,
		);
	}
	console.log("\n整类查（交给模型时的样子）");
	for (const row of classes) {
		if ("error" in row) {
			console.log(`  ${row.fqcn}  出错：${row.error}`);
			continue;
		}
		console.log(
			`  ${row.fqcn}  方法 ${row.shown} 行${row.omitted > 0 ? `（另 ${row.omitted} 行没列）` : ""}，` +
				`protected ${row.protectedShown} 行，文档有而 JAR 没有 ${row.dangling ?? "-"} 个，${(row.bytes / 1024).toFixed(1)} KB`,
		);
	}
}
