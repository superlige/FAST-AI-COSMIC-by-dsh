#!/usr/bin/env node

/**
 * Turns knowledge/reference/*.md into pi-native skills (S7.1).
 *
 * The pages live in this repository (S86, 2026-11-11: the separate long-cosmic-dev
 * skill repository was merged in and retired). Before that the script took the
 * other repository's path as an argument and recorded its git HEAD; now the source
 * is fixed, and the manifest is a pure function of the page bytes -- no timestamp,
 * no git state -- so `--check` can regenerate it in memory and compare byte for
 * byte. `npm run build` runs `--write` before packaging, and
 * test/knowledge/reference.test.ts fails when a page changed without a re-export.
 *
 * Why skills rather than one routing table: the frozen SKILL.md carried a 31-row
 * "按任务取文档" table, which is nothing but each document's description copied
 * into one hand-maintained place. It is defect D-4 in docs/knowledge-injection.md
 * -- the table drifts from the documents and nothing notices. Making each document
 * a skill gives it its own description, and the table stops existing. That is the
 * point: one authoritative source per rule.
 *
 * Where a description comes from: each document's OWN frontmatter.
 *
 *     ---
 *     class: B
 *     when: 新建表单 / 实体、功能单元登记、开发平台搜不到
 *     note: 先读写入总则
 *     ---
 *
 * The first version of this script derived them from that routing table instead,
 * which only moved the defect: the table was still the single hand-maintained
 * place, and it lives in a document 5.1 schedules for deletion. After 切换日 a
 * newly written reference page would have had no description source at all. Now
 * adding a page means editing one file -- the page.
 *
 * `class` is the document's own membership in the four classes of
 * docs/S7-knowledge-design.md section 4.1; only what the classes MEAN stays here,
 * in CLASS_META, because that is cosmic's taxonomy rather than a property of any
 * one page. `when` is what the routing table's left column used to say, and `note`
 * is a routing dependency ("先读写入总则", "同时读 run") -- kept as a separate field
 * rather than folded into `when` because it is a prerequisite, and later stages
 * need to read it as one.
 *
 * Usage: node scripts/export-reference.mjs [--write | --check]
 *   (no flag)  dry-run: report what would be generated
 *   --write    regenerate knowledge/reference.pack and reference-manifest.json
 *   --check    exit 1 when either file differs from what the pages produce
 */

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { commandMapping, pendingCommands } from "../src/knowledge/command-map.ts";
import { scanReferenceCapabilities } from "../src/knowledge/reference-capabilities.ts";

/**
 * What the four classes of docs/S7-knowledge-design.md section 4.1 mean. Membership
 * is NOT here: each document declares its own `class` in frontmatter, so adding a
 * page cannot silently miss a table. What stays is the taxonomy itself, which is
 * cosmic's decision about how the knowledge divides, not a fact about any one page.
 */
const CLASS_META = {
	A: {
		title: "工具契约",
		why: "命令变工具后用法进工具 description + schema，这里留的是「什么时候用哪条」的选择判据",
	},
	B: { title: "领域知识与红线", why: "工具 schema 取代不了；共享写入红线是安全内容，必须保留" },
	C: { title: "插件开发", why: "与官方知识互补，本地只剩运行态差量" },
	D: { title: "元知识", why: "四篇分别处理，不能一起搬" },
};

/**
 * Documents deliberately NOT shipped as skills, each with the decision that
 * excluded it. Nothing may be dropped without a line here -- "归不进四类的显式列
 * 出，不许静默丢" applies to exclusions too, not only to classification.
 */
const NOT_A_SKILL = {
	"delivery-protocol": {
		why: "S6 的交付协议，已单独冻结在 protocol manifest；不归 S7（方案 §4.1）",
		instead: "完成情况照系统提示里的模板写，做过的事用 cosmic_facts 列",
	},
	"official-knowledge": {
		why:
			"它是「怎么用官方知识库」的规则，迁移后大部分变成 cosmic 的实现本身（路由、过滤判据、门禁）。" +
			"继续以文档形式存在就成了第二份权威出处。只有冲突登记表与下钻顺序保留为数据（方案 §4.1）",
		// Referenced 8 times from the other documents -- more than any other excluded
		// target. Telling the reader only "this is gone" would leave those 8 sites
		// without a destination, so the replacement names the tool that does it now.
		instead: "官方知识库用 cosmic_knowledge 查",
	},
};

/** Sections of official-knowledge.md kept as data rather than prose. */
const OFFICIAL_KNOWLEDGE_DATA_SECTIONS = ["下钻顺序", "冲突登记"];

const SKILL_PREFIX = "cosmic-";

/** This repository's root; the pages live in knowledge/reference/. */
const REPO_ROOT = resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const SOURCE_DIR = "knowledge/reference";

/** Lists <dir>/*.md by name (no extension), sorted. */
function listReferenceDocs(dir) {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		console.error(`[FAIL] 找不到 reference 目录：${dir}`);
		process.exit(1);
	}
	return entries
		.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
		.map((entry) => entry.name.replace(/\.md$/, ""))
		.sort((a, b) => a.localeCompare(b));
}

/**
 * Reads one source file, normalising CRLF to LF.
 *
 * Not cosmetic. The checkout has core.autocrlf=true and can hold a mixed working
 * tree -- one page CRLF, another LF -- so reading raw bytes would make the
 * snapshot id depend on how git happened to check the files out on this machine.
 * A fresh clone with different settings would produce a different snapshot for
 * identical text, and the symptom would be "the knowledge changed and I did not
 * touch it". Normalising makes the digest a function of the content alone; it also
 * keeps 1,909 bytes of pure carriage returns out of the pack.
 */
function readSource(root, relative) {
	try {
		return readFileSync(join(root, ...relative.split("/")), "utf8").replace(/\r\n/g, "\n");
	} catch {
		console.error(`[FAIL] 读不到源文件：${join(root, relative)}`);
		process.exit(1);
	}
}

/**
 * Checks every page's probe pins against the probes cosmic actually ships.
 *
 * The bytes compared are cosmic's own `resources/probes/`: those are the ones that
 * reach a user.
 *
 * Same CRLF normalisation as readSource, for the same reason: a digest must be a
 * function of the content, not of how git checked the file out.
 */
function checkProbePins(pages) {
	const probesDir = resolve(new URL("../resources/probes", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
	const pins = [];
	const drift = [];
	for (const [doc, page] of pages) {
		for (const pin of page.probes) {
			let actual;
			try {
				actual = sha256(readFileSync(join(probesDir, pin.file), "utf8").replace(/\r\n/g, "\n")).slice(0, 12);
			} catch {
				drift.push({ doc, file: pin.file, pinned: pin.sha256, actual: null, why: "探针文件不存在" });
				continue;
			}
			pins.push({ doc, file: pin.file, sha256: actual });
			if (actual !== pin.sha256) {
				drift.push({ doc, file: pin.file, pinned: pin.sha256, actual, why: "探针改了，这篇没有跟着复核" });
			}
		}
	}
	return { pins, drift };
}

function sha256(text) {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function canonicalJson(value) {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const entries = Object.entries(value)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/**
 * Reads one reference page's frontmatter and splits off its body.
 *
 * Deliberately not a YAML parser. It accepts exactly the three keys this contract
 * defines and rejects everything else: a typo'd key that parsed into an ignored
 * field would put the page back in the state this whole change removes -- shipped
 * with a description nobody authored.
 */
const FRONTMATTER_KEYS = new Set(["class", "when", "note", "probes"]);

/**
 * D-4 again, one layer down: a page that describes what a PROBE does.
 *
 * The routing table drifted from the pages and nothing noticed, so each page now
 * carries its own description. The same failure exists between a page and the
 * Java it documents: `--set` grew sub-entry paths and a single value-conversion
 * contract, five probes changed, and reference/run.md went on showing two-segment
 * paths only -- every test still green, because no test knows the two are related.
 * COSMIC_OWNED in export-resources.mjs pins a local probe to the upstream blob it
 * was taken from for exactly this reason; this is that idea pointed at prose.
 *
 *     probes: ExpectSpec.java@1f4c0a9d2b71
 *
 * The pin says "this page describes that file's behaviour as of these bytes".
 * When the file changes the export STOPS -- not warns: a warning here is
 * indistinguishable from today, where the doc silently goes stale and ships. The
 * remedy is to re-read the page against the new source and, if it still holds,
 * paste in the new digest. That re-read is the point; the digest is only what
 * makes skipping it visible.
 *
 * Pin the file the contract LIVES in, not every file that touches it: pinning
 * FormSim.java (58 KB, edited for unrelated reasons) would fire so often that
 * updating the pin becomes reflex, which is the same as having no pin.
 */
function parseProbePins(raw, fail) {
	const text = String(raw).trim();
	if (text === "") return [];
	return text
		.split(/[,\s]+/)
		.filter(Boolean)
		.map((entry) => {
			const match = /^([A-Za-z][A-Za-z0-9_]*\.java)@([0-9a-f]{12})$/.exec(entry);
			if (!match) fail(`frontmatter 的 probes 项写法不对：${entry}（要 Xxx.java@<sha256 前 12 位>）`);
			return { file: match[1], sha256: match[2] };
		});
}

function parseDocFrontmatter(text, doc) {
	const fail = (why) => {
		console.error(`[FAIL] reference/${doc}.md ${why}`);
		console.error(
			"  每篇 reference 必须自带 frontmatter，description 与四类归属都从这里来：\n" +
				"    ---\n    class: A|B|C|D\n    when: 什么任务下该读这篇\n    note: 路由依赖（可选，如「先读写入总则」）\n    ---",
		);
		process.exit(1);
	};
	if (!text.startsWith("---\n")) fail("没有 frontmatter");
	const end = text.indexOf("\n---\n", 3);
	if (end < 0) fail("frontmatter 没有闭合的 ---");
	const fields = {};
	for (const line of text.slice(4, end + 1).split("\n")) {
		if (line.trim() === "") continue;
		const match = /^([a-z]+):\s*(.*)$/.exec(line);
		if (!match) fail(`frontmatter 有解析不了的一行：${line}`);
		const [, key, rawValue] = match;
		if (!FRONTMATTER_KEYS.has(key)) fail(`frontmatter 有未知键 ${key}（只认 ${[...FRONTMATTER_KEYS].join(" / ")}）`);
		let value = rawValue.trim();
		if (value.startsWith('"')) {
			try {
				value = JSON.parse(value);
			} catch {
				fail(`frontmatter 的 ${key} 是带引号的值但解析失败：${rawValue}`);
			}
		}
		fields[key] = value;
	}
	if (!(fields.class in CLASS_META)) {
		fail(`class 必须是 ${Object.keys(CLASS_META).join(" / ")} 之一，实际是 ${fields.class}`);
	}
	if (!fields.when) fail("frontmatter 缺 when，description 无出处");
	const probes = parseProbePins(fields.probes ?? "", fail);
	// The body starts after the closing --- and the blank line that follows it.
	// Unstripped, the source frontmatter would sit inside the generated SKILL.md
	// under a second frontmatter block, and pi would parse the wrong one.
	return {
		class: fields.class,
		when: fields.when,
		note: fields.note ?? "",
		probes,
		body: text.slice(end + 5).replace(/^\n/, ""),
	};
}

/** First H1 of a document. Used as the "what it is" half of the description. */
function titleOf(text, doc) {
	const match = /^#\s+(.+)$/m.exec(text);
	if (!match) throw new Error(`${doc}.md 没有 H1 标题，无法生成 description`);
	return match[1].trim();
}

/** Extracts one "## 标题" or "### 标题" section, body only, heading excluded. */
function sectionOf(text, heading) {
	const lines = text.split("\n");
	const start = lines.findIndex((line) => /^#{2,3}\s/.test(line) && line.replace(/^#+\s*/, "").trim() === heading);
	if (start < 0) return null;
	const level = (/^#+/.exec(lines[start]) ?? ["##"])[0].length;
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i += 1) {
		const depth = (/^#+/.exec(lines[i]) ?? [""])[0].length;
		if (depth > 0 && depth <= level) {
			end = i;
			break;
		}
	}
	return lines
		.slice(start + 1, end)
		.join("\n")
		.trim();
}

const LINK_RE = /\[([^\]]*)\]\(([^)]+)\)/g;
/**
 * One frozen invocation: an optional `node <path>` launcher, the driver, and the
 * command word. The launcher has to be part of the match -- most occurrences sit
 * inside fenced shell examples as a full `node .claude/.../driver.mjs probe X`
 * line, and replacing only the middle of that line would leave a command that is
 * neither a shell line nor a tool call.
 */
const DRIVER_RE = /(?:\bnode\s+)?(?:[^\s`]*[\\/])?driver\.mjs\s+([a-z][a-z0-9-]*)/g;

/**
 * Rewrites links for the skill layout and reports the ones that cannot survive.
 *
 * Three outcomes, and the third is the one that matters: a link to ../docs/ or
 * ../protocol/ points at something section 5.1 deliberately does NOT ship. Left as
 * a Markdown link the model will try to `read` a path that does not exist and burn
 * a turn on it, so those become plain text saying where the target actually lives.
 */
function rewriteLinks(text, doc, skillNames) {
	const dangling = [];
	let intra = 0;
	const out = text.replace(LINK_RE, (whole, label, target) => {
		const [path, anchor] = target.split("#");
		if (path === "") return whole; // same-page anchor
		if (path.startsWith("http")) return whole;
		const base = /^([a-z0-9-]+)\.md$/.exec(path);
		if (base) {
			const name = `${SKILL_PREFIX}${base[1]}`;
			if (skillNames.has(name)) {
				intra += 1;
				return `[${label}](../${name}/SKILL.md${anchor ? `#${anchor}` : ""})`;
			}
			const excluded = NOT_A_SKILL[base[1]];
			if (excluded) {
				dangling.push({ from: doc, target: path, kind: "excluded-doc" });
				return `${label}（${excluded.instead}）`;
			}
		}
		dangling.push({ from: doc, target: path, kind: "outside-migration-scope" });
		return `${label}（这份资料没有随产品提供）`;
	});
	return { text: out, intra, dangling };
}

/**
 * Rewrites `driver.mjs <cmd>` writings against the S5 parity table.
 *
 * A migrated command becomes the tool that performs it, with the original kept in
 * parentheses: the old invocation is still the best clue to what the passage
 * meant, and dropping it would silently rewrite the author's example. An
 * unmigrated command is left exactly as it is and counted -- guessing a tool name
 * for it would turn a stale instruction into a false one.
 */
function rewriteCommands(text) {
	const rewritten = [];
	const stale = [];
	const out = text.replace(DRIVER_RE, (whole, command) => {
		const mapping = commandMapping(command);
		if (mapping?.status === "migrated" && mapping.tool !== null) {
			rewritten.push(command);
			// Arguments are left in place: they still say what the example is about,
			// and the tool's own schema -- which the model always has -- is the
			// authority on their shape. Rewriting them per command would be a
			// per-occurrence semantic transform, which is how wrong examples get made.
			// The action is not an argument: on a tool that took over several commands it
			// IS which command this was. Dropped, `driver.mjs sig X` read as a bare
			// `cosmic_knowledge X`, a call the tool has no answer for (S72). A mapping whose
			// action lists alternatives ("a / b / c") names no single call, so it stays out.
			return mapping.action !== undefined && !mapping.action.includes("/")
				? `${mapping.tool} ${mapping.action}`
				: mapping.tool;
		}
		stale.push(command);
		return whole;
	});
	return { text: out, rewritten, stale };
}

function main() {
	const args = process.argv.slice(2);
	// --source <dir> reads the pages from somewhere else. It exists for tests that
	// feed the exporter a deliberately broken page; it never writes, so a stray
	// directory cannot overwrite the shipped pack.
	const sourceAt = args.indexOf("--source");
	const sourceOverride = sourceAt >= 0 ? args[sourceAt + 1] : undefined;
	const flags = sourceAt >= 0 ? args.filter((_, index) => index !== sourceAt && index !== sourceAt + 1) : args;
	const unknown = flags.filter((flag) => flag !== "--write" && flag !== "--check");
	if (
		unknown.length > 0 ||
		flags.length > 1 ||
		(sourceAt >= 0 && !sourceOverride) ||
		(sourceOverride && flags.includes("--write"))
	) {
		console.error(
			"用法: node scripts/export-reference.mjs [--write | --check]（--source <目录> 只能和 --check 或预演一起用）",
		);
		process.exit(2);
	}
	const root = REPO_ROOT;
	const sourceLabel = sourceOverride ?? SOURCE_DIR;
	const sourceDir = sourceOverride ? resolve(sourceOverride) : join(root, ...SOURCE_DIR.split("/"));
	const write = flags.includes("--write");
	const check = flags.includes("--check");
	const docs = listReferenceDocs(sourceDir);

	// ---- every page declares its own class / when / note ----
	const pages = new Map(
		docs.map((doc) => {
			const raw = readSource(sourceDir, `${doc}.md`);
			return [doc, { ...parseDocFrontmatter(raw, doc), raw }];
		}),
	);

	// ---- known capability contradictions fail before any generated output ----
	const capabilityIssues = [...pages].flatMap(([doc, page]) =>
		scanReferenceCapabilities(page.raw).map((issue) => ({ doc, ...issue })),
	);
	if (capabilityIssues.length > 0) {
		for (const issue of capabilityIssues) {
			console.error(`[FAIL] ${sourceLabel}/${issue.doc}.md:${issue.line} [${issue.rule}] ${issue.detail}`);
		}
		process.exit(1);
	}

	// ---- pages that document a probe's behaviour, pinned to that probe's bytes ----
	const probePins = checkProbePins(pages);
	if (probePins.drift.length > 0) {
		console.error(`[FAIL] ${probePins.drift.length} 处「文档描述的探针行为已经变了」：`);
		for (const item of probePins.drift) {
			console.error(
				`  reference/${item.doc}.md 钉着 ${item.file}@${item.pinned}，实际 ${item.actual ?? "<缺文件>"}`,
			);
			console.error(`    ${item.why}`);
		}
		console.error("  这不是自动改一下就行的：先重读那篇，确认它讲的行为在新代码下仍然成立（不成立就改正文），");
		console.error("  再把 frontmatter 的 probes 换成新摘要。摘要只是让「没复核」这件事看得见。");
		process.exit(1);
	}

	const skillDocs = docs.filter((doc) => !(doc in NOT_A_SKILL));
	const skillNames = new Set(skillDocs.map((doc) => `${SKILL_PREFIX}${doc}`));

	const entries = [];
	const allDangling = [];
	const staleCommands = {};
	const rewrittenCommands = {};
	let intraLinks = 0;

	for (const doc of skillDocs) {
		const page = pages.get(doc);
		const name = `${SKILL_PREFIX}${doc}`;
		const title = titleOf(page.body, doc);
		const description = `${title}。什么时候读：${page.when}${page.note ? `。${page.note}` : ""}。`;
		if (description.length > 1024) {
			console.error(`[FAIL] ${name} 的 description 超过 pi 的 1024 字符上限（${description.length}）`);
			process.exit(1);
		}
		if (!/^[a-z0-9-]+$/.test(name) || name.length > 64) {
			console.error(`[FAIL] ${name} 不符合 pi 的 skill 名规则`);
			process.exit(1);
		}

		const rewritten = rewriteLinks(page.body, doc, skillNames);
		intraLinks += rewritten.intra;
		allDangling.push(...rewritten.dangling);

		const commands = rewriteCommands(rewritten.text);
		rewritten.text = commands.text;
		if (commands.rewritten.length > 0) {
			rewrittenCommands[doc] = {
				count: commands.rewritten.length,
				commands: [...new Set(commands.rewritten)].sort(),
			};
		}
		if (commands.stale.length > 0) {
			staleCommands[doc] = { count: commands.stale.length, commands: [...new Set(commands.stale)].sort() };
		}

		// S5.1: a migrated command is rewritten in place to the tool that performs it,
		// so the banner now covers only what is genuinely still stale, and says which.
		// Keeping a blanket "everything here is stale" banner after half the commands
		// became tools would only train the reader to skip it.
		const staleList = [...new Set(commands.stale)].sort().join(" / ");
		const lines = [];
		if (commands.rewritten.length > 0) {
			lines.push(`> 本篇的命令示例写成了对应的工具名，说明的是这一步在做什么；**参数写法以工具说明为准**。`);
		}
		if (commands.stale.length > 0) {
			lines.push(
				`> 本篇有 ${commands.stale.length} 处 \`driver.mjs <命令>\`（${staleList}）没有对应的工具：` +
					`它们只说明该用哪条能力，这里执行不了。`,
			);
		}
		const banner = lines.length > 0 ? `${lines.join("\n>\n")}\n\n` : "";
		const front = ["---", `name: ${name}`, `description: ${JSON.stringify(description)}`, "---", "", banner].join(
			"\n",
		);
		entries.push({
			path: `${name}/SKILL.md`,
			content: `${front}${rewritten.text}`,
			doc,
			name,
			description,
			class: page.class,
			sourceSha256: sha256(page.raw),
			sourceLines: page.body.split("\n").length - 1,
		});
	}

	// ---- official-knowledge.md: two sections survive as data, the rest as implementation ----
	const officialRaw = pages.get("official-knowledge").body;
	const officialData = {};
	for (const heading of OFFICIAL_KNOWLEDGE_DATA_SECTIONS) {
		const body = sectionOf(officialRaw, heading);
		if (body === null) {
			console.error(`[FAIL] official-knowledge.md 里找不到要保留为数据的小节：${heading}`);
			process.exit(1);
		}
		officialData[heading] = body;
	}

	const files = [];
	const payloads = [];
	for (const entry of entries.sort((a, b) => a.path.localeCompare(b.path))) {
		const encoded = Buffer.from(entry.content, "utf8");
		files.push({ path: entry.path, bytes: encoded.length, sha256: sha256(entry.content) });
		payloads.push(encoded);
	}
	const snapshotId = createHash("sha256")
		.update(canonicalJson(files.map((file) => [file.path, file.sha256])), "utf8")
		.digest("hex")
		.slice(0, 32);

	const manifest = {
		schema: "cosmic.reference/1",
		// Repository-relative and timestamp-free on purpose: the manifest must be a pure
		// function of the pages, or `--check` could never tell "stale" from "re-run".
		// Every page's own bytes are hashed under skills[].sourceSha256.
		source: { dir: SOURCE_DIR },
		snapshotId,
		counts: {
			documents: docs.length,
			skills: entries.length,
			excluded: Object.keys(NOT_A_SKILL).length,
			intraLinksRewritten: intraLinks,
			danglingLinks: allDangling.length,
			staleCommandDocs: Object.keys(staleCommands).length,
			capabilityContradictions: capabilityIssues.length,
			staleCommandOccurrences: Object.values(staleCommands).reduce((sum, item) => sum + item.count, 0),
			rewrittenCommandDocs: Object.keys(rewrittenCommands).length,
			rewrittenCommandOccurrences: Object.values(rewrittenCommands).reduce((sum, item) => sum + item.count, 0),
		},
		classes: Object.fromEntries(
			Object.entries(CLASS_META).map(([key, meta]) => {
				const members = docs.filter((doc) => pages.get(doc).class === key);
				return [
					key,
					{
						title: meta.title,
						why: meta.why,
						docs: members,
						// 正文行数（不含 frontmatter），方案 §4.1 那张表因此可以逐格复核
						lines: members.reduce((sum, doc) => sum + pages.get(doc).body.split("\n").length - 1, 0),
					},
				];
			}),
		),
		// Which pages claim to describe a probe's behaviour, and against which bytes.
		// Empty is a legitimate state (no page makes that claim); a test holds the
		// pages that do make it to a non-empty list, so the mechanism cannot be
		// switched off by deleting a frontmatter line.
		probePins: probePins.pins,
		excluded: Object.entries(NOT_A_SKILL).map(([doc, entry]) => ({ doc, why: entry.why, instead: entry.instead })),
		skills: entries.map((entry) => ({
			name: entry.name,
			doc: entry.doc,
			class: entry.class,
			description: entry.description,
			descriptionChars: entry.description.length,
			sourceSha256: entry.sourceSha256,
			sourceLines: entry.sourceLines,
		})),
		// Kept as an explicit inventory rather than a note: S5.1 needs the exact
		// work list, and a test asserts the number so it cannot grow unnoticed.
		staleCommands,
		// What S5.1 already converted, and which commands the rest is still waiting on.
		rewrittenCommands,
		pendingCommands: pendingCommands(),
		danglingLinks: allDangling,
		officialKnowledgeData: officialData,
		files,
	};

	// The pack header's bundleVersion names the snapshot for this source; without a
	// commit to borrow, the content digest is the only honest identifier.
	const header = {
		schema: "cosmic.knowledge-pack/1",
		snapshotId,
		bundleVersion: `local-${snapshotId.slice(0, 12)}`,
		files,
	};
	const pack = gzipSync(
		Buffer.concat([Buffer.from(JSON.stringify(header), "utf8"), Buffer.from("\n", "utf8"), ...payloads]),
		{ level: 9 },
	);

	const outRoot = join(root, "knowledge");
	const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
	if (check) {
		// The pack is compared decompressed: gzip output may differ between zlib
		// builds for identical input, and the content is what ships.
		const read = (file) => {
			try {
				return readFileSync(join(outRoot, file));
			} catch {
				return null;
			}
		};
		const stale = [];
		const onDiskManifest = read("reference-manifest.json");
		if (onDiskManifest === null || onDiskManifest.toString("utf8").replace(/\r\n/g, "\n") !== manifestText) {
			stale.push("knowledge/reference-manifest.json");
		}
		const onDiskPack = read("reference.pack");
		if (onDiskPack === null || !gunzipSync(onDiskPack).equals(gunzipSync(pack)))
			stale.push("knowledge/reference.pack");
		if (stale.length > 0) {
			console.error(`[FAIL] ${SOURCE_DIR}/ 改过，下面的文件没跟着重新生成：${stale.join("、")}`);
			console.error("  运行: node scripts/export-reference.mjs --write");
			process.exit(1);
		}
		console.log(`参考文档与生成的技能包一致（${entries.length} 个 skill，快照 ${snapshotId.slice(0, 12)}）`);
		return;
	}
	if (write) {
		mkdirSync(outRoot, { recursive: true });
		writeFileSync(join(outRoot, "reference-manifest.json"), manifestText, "utf8");
		writeFileSync(join(outRoot, "reference.pack"), pack);
	}

	const bytes = files.reduce((sum, file) => sum + file.bytes, 0);
	console.log(
		`${write ? "已导出" : "dry-run"} ${entries.length} 个 skill / ${bytes} 字节，压缩后 ${pack.length} 字节，快照 ${snapshotId.slice(0, 12)}`,
	);
	console.log(`  源：${SOURCE_DIR}/（${docs.length} 篇）`);
	for (const [key, group] of Object.entries(manifest.classes)) {
		const shipped = group.docs.filter((doc) => !(doc in NOT_A_SKILL));
		console.log(
			`  ${key} ${group.title.padEnd(8)} ${group.docs.length} 篇 / ${group.lines} 行，其中 ${shipped.length} 篇做成 skill`,
		);
	}
	for (const [doc, entry] of Object.entries(NOT_A_SKILL)) console.log(`  排除 ${doc}：${entry.why.slice(0, 36)}…`);
	console.log(`  篇间链接改写 ${intraLinks} 条，无法保留 ${allDangling.length} 条`);
	console.log(
		`  已按命令映射改写 ${manifest.counts.rewrittenCommandOccurrences} 处，覆盖 ${manifest.counts.rewrittenCommandDocs} 篇`,
	);
	console.log(
		`  仍为陈旧 CLI 写法 ${manifest.counts.staleCommandOccurrences} 处，覆盖 ${manifest.counts.staleCommandDocs} 篇` +
			`（等这些命令迁移：${pendingCommands().join(" ")}）`,
	);
	const longest = manifest.skills.reduce((a, b) => (a.descriptionChars > b.descriptionChars ? a : b));
	console.log(`  description 最长 ${longest.descriptionChars} 字符（${longest.name}），上限 1024`);
}

main();
