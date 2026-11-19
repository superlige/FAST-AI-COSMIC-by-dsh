/**
 * 发给模型的文字只说现在怎样（AGENTS.md 第二节第 6 条）。
 *
 * 阶段号（「S27 起」）、带日期的事故注脚（「真机 2026-09-18：…」）、已取消的机制名、内部术语，模型读到都会当成
 * 现行规矩去琢磨。经过写在提交说明和代码注释里；模型读到的只说现在怎样。这里把每条会到模型那里的路都拼出来扫一遍，
 * 新写一句「S28 起」就在这里失败，而不是发出去。
 *
 * 路：两个模式的系统提示和每轮状态、挂上的每个工具的说明和参数（`src/dsh/fixed-text.ts`）、产品里的技能文档、
 * 自动附上的知识卡片背后的运行约定、技能族目录、已发布探针的用法文字、拼工具返回的源码字符串（提示、修复建议、警告）。
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { allFixedTextPieces, mountedToolSpecs } from "../../src/dsh/fixed-text.ts";
import { probeUsage } from "../../src/kernel/commands/probe.ts";
import { openKnowledgePack } from "../../src/knowledge/pack.ts";
import { REFERENCE_FAMILIES } from "../../src/knowledge/reference.ts";
import { RUN_ADAPTER_CONTRACTS } from "../../src/knowledge/run-adapter.ts";
import { EMBEDDED_RESOURCES } from "../../src/resources/embedded.generated.ts";

/** 模型读到的文字里不许有的，和为什么读起来不对。 */
const FORBIDDEN: { pattern: RegExp; why: string }[] = [
	{ pattern: /可重跑用例|反查旧需求和用例|探针（跑任意 Java）/, why: "目录不得宣传已删除或受限能力" },
	{ pattern: /driver (?:会)?自动降级冷进程|写后仍走冷进程回读|APPLY 一律走冷进程/, why: "元数据写入默认复用常驻进程" },
	{
		pattern: /元数据 \/ 业务数据时已获得授权|去 `cosmic_knowledge` 查一次|确认目标和回滚路径，再带授权/,
		why: "旧授权或解锁流程",
	},
	{ pattern: /S\d{1,2}(\.\d+)?\s*(起|之前|批)/, why: "阶段号：模型不知道 S27 是什么，直接说现在怎样" },
	{ pattern: /[（(，；：]\s*S\d{1,2}(\.\d+)?\s*[）)，；]/, why: "括号里的阶段号" },
	{
		pattern: /(真机|实测)\s*20\d\d-\d\d-\d\d|20\d\d-\d\d-\d\d\s*(真机|定|决定|起)|用户\s*20\d\d-\d\d-\d\d/,
		why: "带日期的事故注脚或决定记录：留规则，日期和经过放提交说明",
	},
	{ pattern: /打卡/, why: "已取消的门槛，模型没见过它，反复说「不用打卡」只会让它去琢磨" },
	{ pattern: /已退役|已经退役/, why: "退役历史：直接说现在走哪条路" },
	{ pattern: /ContractCard/, why: "内部术语" },
	{ pattern: /冻结\s*CLI/, why: "内部历史" },
	{ pattern: /Harness/, why: "内部术语" },
	{ pattern: /候选用例|自动转正/, why: "已删除的机制" },
	{ pattern: /未随产物分发/, why: "内部术语" },
];

/**
 * 只扫系统提示、工具说明、技能文档的那几条：已取消的工具和机制。源码里还有把老工具名指到新入口的对照表
 * （模型照老习惯调了 cosmic_verify，返回告诉它现在用 cosmic_facts），那是机制，不在这里扫。
 */
const RETIRED: { pattern: RegExp; why: string }[] = [
	{
		pattern: /cosmic_authorize|cosmic_verify|cosmic_finish/,
		why: "已取消的工具：写元数据在写调用里确认，事实用 cosmic_facts",
	},
	{ pattern: /事实账|交付回执|交付戳|preflight 预检|编译后的预检/, why: "已取消的机制：完成情况由模型照模板写" },
	{ pattern: /\/cosmic-(?:prod|dev)\b|--prod\b/, why: "模式在新建会话时选，没有切模式的命令" },
];

/**
 * 「去看文档」必须带着能直接走的那条路。
 *
 * 「按返回提示读 run 文档全文」「参数写法见某某三篇文档」这种话，模型读到了也走不过去：
 * 没说是哪个文件，没说怎么打开，它只能自己在磁盘上找。
 * 指向文档的话，同一句里要有一条可以直接调的路（问工具要用法、给出的绝对路径），否则算违规。
 */
const DOC_POINTER = /(见|读|参考|看)[^。；，\n"'`]{0,60}?(文档|SKILL\.md|[两三几]篇)/g;
const ROUTE = /cosmic_[a-z]+ (argv|action)=|argv 给 \[\]|\["help"|read 它的路径|\$\{/;

function unroutedDocPointers(channel: string, text: string): string[] {
	const found: string[] = [];
	for (const match of text.matchAll(DOC_POINTER)) {
		const at = match.index ?? 0;
		const start = Math.max(text.lastIndexOf("。", at), text.lastIndexOf("\n", at)) + 1;
		const endAt = [text.indexOf("。", at), text.indexOf("\n", at)].filter((i) => i >= 0);
		const sentence = text.slice(start, endAt.length > 0 ? Math.min(...endAt) : text.length);
		if (!ROUTE.test(sentence)) found.push(`${channel}: 「${match[0]}」没给能直接走的路 … ${sentence.trim()} …`);
	}
	return found;
}

function violations(channel: string, text: string, rules = FORBIDDEN): string[] {
	const found: string[] = [];
	for (const { pattern, why } of rules) {
		const global = new RegExp(pattern.source, "g");
		for (const match of text.matchAll(global)) {
			const at = match.index ?? 0;
			const context = text.slice(Math.max(0, at - 30), at + match[0].length + 30).replace(/\s+/g, " ");
			found.push(`${channel}: 「${match[0]}」（${why}）… ${context} …`);
		}
	}
	return found;
}

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** 源码里的字符串行：注释是给人看的，可以讲历史。 */
function literalLines(file: string): string {
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => !/^\s*(\/\/|\*|\/\*\*)/.test(line))
		.filter((line) => /["`]/.test(line))
		.join("\n");
}

function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
		else if (name.endsWith(".ts")) out.push(path);
	}
	return out;
}

/** 到不了模型那里的源码：老命令对照表是给开发者的记录，生成的资源文件里是 Java 源码。 */
const NOT_MODEL_FACING = new Set(["command-map.ts", "embedded.generated.ts"]);

function modelFacingSources(): string[] {
	return ["src/agent", "src/kernel", "src/knowledge", "src/dsh"]
		.flatMap((dir) => sourceFiles(join(ROOT, dir)))
		.filter((file) => !NOT_MODEL_FACING.has(file.split(/[\\/]/).pop() ?? ""));
}

const pieces = allFixedTextPieces();

function skillDocs(): { path: string; text: string }[] {
	const pack = openKnowledgePack(readFileSync(join(ROOT, "knowledge/reference.pack")));
	return pack.header.files.map((file) => ({ path: file.path, text: pack.read(file.path) as string }));
}

describe("发给模型的文字不带历史沿革", () => {
	it("两个模式的系统提示、每轮状态、工具说明和参数", () => {
		expect(pieces.length).toBeGreaterThan(20);
		const found = pieces.flatMap((piece) => [
			...violations(piece.where, piece.text),
			...violations(piece.where, piece.text, RETIRED),
		]);
		expect(found).toEqual([]);
	});

	it("随产品分发的技能文档", () => {
		const found = skillDocs().flatMap((doc) => [
			...violations(doc.path, doc.text),
			...violations(doc.path, doc.text, RETIRED),
		]);
		expect(found).toEqual([]);
	});

	it("知识卡片背后的运行约定", () => {
		expect(violations("RUN_ADAPTER_CONTRACTS", JSON.stringify(RUN_ADAPTER_CONTRACTS))).toEqual([]);
	});

	it("技能族目录与已发布探针的用法文字", () => {
		const found = REFERENCE_FAMILIES.flatMap((family) => violations(family.name, family.description));
		for (const resource of EMBEDDED_RESOURCES) {
			if (!resource.relativePath.startsWith("probes/")) continue;
			found.push(...violations(resource.relativePath, probeUsage(resource.content).doc.join("\n")));
		}
		expect(found).toEqual([]);
	});

	it("工具返回里的提示（源码字符串）", () => {
		const found = modelFacingSources().flatMap((file) => violations(file.slice(ROOT.length), literalLines(file)));
		expect(found).toEqual([]);
	});

	it("规则本身抓得住老说法", () => {
		expect(violations("旧", "S27 起不再预演")).toHaveLength(1);
		expect(violations("旧", "落库前先调 cosmic_authorize", RETIRED)).toHaveLength(1);
		expect(violations("旧", "用 /cosmic-prod 切到排障", RETIRED)).toHaveLength(1);
		expect(violations("新", "写元数据时附 report，工具预演后弹确认单", RETIRED)).toEqual([]);
	});
});

describe("说「去看文档」的地方都带着能直接走的路", () => {
	it("系统提示、工具说明、运行约定、源码字符串", () => {
		const found = pieces.flatMap((piece) => unroutedDocPointers(piece.where, piece.text));
		found.push(...unroutedDocPointers("RUN_ADAPTER_CONTRACTS", JSON.stringify(RUN_ADAPTER_CONTRACTS)));
		for (const file of modelFacingSources())
			found.push(...unroutedDocPointers(file.slice(ROOT.length), literalLines(file)));
		expect(found).toEqual([]);
	});

	it("规则本身抓得住以前那两句", () => {
		expect(unroutedDocPointers("旧", "被拒、拿不准或第一次失败时，按返回提示读 run 文档全文。")).toHaveLength(1);
		expect(unroutedDocPointers("旧", "参数写法见 meta-cmd、metadata-botp、print-template 三篇文档。")).toHaveLength(
			1,
		);
		expect(
			unroutedDocPointers("新", '拿不准时先调 cosmic_run argv=["help","form"]，文档那一节原文随结果返回。'),
		).toEqual([]);
	});

	it("参数多的工具，自己的说明里写着怎么问用法", () => {
		const routes: Record<string, string> = {
			cosmic_run: 'cosmic_run argv=["help","form"]',
			cosmic_meta: "argv 给 []",
			cosmic_probe: "cosmic_knowledge action=probes",
		};
		const specs = mountedToolSpecs("dev");
		for (const [name, route] of Object.entries(routes)) {
			const spec = specs.find((one) => one.name === name);
			expect(spec?.description, name).toContain(route);
		}
	});
});
