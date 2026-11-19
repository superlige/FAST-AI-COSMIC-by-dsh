/**
 * 知识卡片（Knowledge Capsule）发了什么、什么时候发：S45 批 4 的尺子。
 *
 * 跑法：node --experimental-strip-types scripts/measure-capsules.ts
 *         [--dir <会话目录>] [--from 2026-09-11] [--to 2026-10-05] [--project D:/kingdee/zlgd_ygpt2.0] [--json]
 *
 * 两件事：
 * 1. 内容：每个插件族（`PLUGIN_ROUTES` 的基类）造一个 `class DemoPlugin extends <基类>`，渲染出现在会发的插件卡片，
 *    逐行列出"要点""签名"，标出疑似碎片（孤零零的"注意："、表格行、半截代码）。同一份内容的族归成一组。
 *    "怎么验"也列出来，数其中说了去哪查绑定的几张、说了没挂上怎么办的几张（工具能挂、要用户去配、不用登记分开数）。
 * 2. 时机：从真机会话里找出模型写过、改过的业务 Java（不含临时探针），按真机工程里的源码认插件族，
 *    记下模型第一次碰到它（`read` 这个文件，或者某次工具返回里出现这个类名）是第几次调用、第一次写它是第几次调用，
 *    以及中间查了几次平台知识、读了几次知识文档、反编译几次。卡片现在要等写完才发，中间这段就是"卡片本可以先到"的窗口。
 *
 * 口径：
 * - 调用序号按会话里模型发出的工具调用计，从 1 起。
 * - 业务 Java 按文件名（小写）认，同名文件算一个；插件族按真机工程磁盘上的现有源码认（只读）。
 * - 平台知识查询、知识文档、反编译的口径同 `knowledge-queries-from-sessions.ts`。
 * - 只读历史会话和源码，不代表重跑；卡片发了以后模型会不会照做，要批 5.2 真机看。
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import process from "node:process";
import { isAdHocProbeFile } from "../src/kernel/layout.ts";
import { type KnowledgeCapsule, renderKnowledgeCapsule, sourceKnowledgeCapsules } from "../src/knowledge/capsule.ts";
import { PLUGIN_ROUTES } from "../src/knowledge/catalog.ts";
import { nodeKnowledgeDocs, openKnowledgeBase } from "../src/knowledge/docs.ts";
import { loadKnowledgeSnapshot } from "../src/knowledge/embedded.ts";
import { type JavaSourcePort, pluginFamiliesIn } from "../src/knowledge/plugin-base.ts";
import { type LocalReferenceDoc, parseSkillFrontmatter } from "../src/knowledge/reference.ts";
import { releaseKnowledge } from "../src/knowledge/release.ts";

const argValue = (name: string): string | undefined => {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
};

const dir = argValue("--dir") ?? "C:/Users/Lige/.pi/agent/sessions/--D--kingdee-zlgd_ygpt2.0--";
const from = argValue("--from") ?? "0000-00-00";
const to = argValue("--to") ?? "9999-99-99";
const project = (argValue("--project") ?? "D:/kingdee/zlgd_ygpt2.0").replace(/\\/g, "/");
const asJson = process.argv.includes("--json");

const encoder = new TextEncoder();
const bytesOf = (text: string): number => encoder.encode(text).length;

// ------------------------------------------------------------------ 内容

/** 一行像不像从文档里摘断的碎片：短到没意思、表格行、半截代码、只剩个冒号。 */
function fragment(line: string): string | null {
	const text = line.trim();
	if (text.length < 8) return "太短";
	if (/^\|/.test(text) || /\|\s*$/.test(text)) return "表格行";
	if (/[:：]$/.test(text)) return "冒号结尾";
	if (/[{}]\s*$/.test(text) || /^\}/.test(text)) return "半截代码";
	if (/^(\/\/|\/\*|\*)/.test(text)) return "代码注释";
	return null;
}

function capsuleLines(capsule: KnowledgeCapsule): { section: string; line: string }[] {
	return [
		...capsule.must.map((line) => ({ section: "要点", line })),
		...capsule.signatures.map((line) => ({ section: "签名", line })),
	];
}

/** 读、写一个继承该基类的源码时推给模型的卡片（和工具同一个入口 `sourceKnowledgeCapsules`）；不推就是空。 */
async function measureContent(base: ReturnType<typeof openKnowledgeBase>, local: readonly LocalReferenceDoc[]) {
	const families = [...new Map(PLUGIN_ROUTES.map((route) => [route.base, route])).values()];
	const rows = families.map((route) => {
		const file = `demo/${route.base}Demo.java`;
		const source: JavaSourcePort = {
			exists: (path) => path === file,
			read: (path) => (path === file ? `public class ${route.base}Demo extends ${route.base} {}` : ""),
		};
		const [capsule] = sourceKnowledgeCapsules({ base, source, files: [file], runtimeKeyId: null, local });
		if (capsule === undefined)
			return {
				base: route.base,
				guide: route.guide,
				bytes: 0,
				lines: [],
				verify: [] as string[],
				bindRead: false,
				bindWrite: false,
				bindByUser: false,
				bindInCode: false,
				fragments: 0,
				fingerprint: "",
			};
		const lines = capsuleLines(capsule).map((item) => ({ ...item, fragment: fragment(item.line) }));
		return {
			base: route.base,
			guide: route.guide,
			bytes: bytesOf(renderKnowledgeCapsule(capsule)),
			lines,
			// 「怎么验」里讲绑定的两件事：去哪查挂没挂上（确认真实绑定），没挂上去哪挂
			verify: capsule.verificationRoute,
			bindRead: capsule.verificationRoute.some((line) => line.includes("确认真实绑定")),
			bindWrite: capsule.verificationRoute.some((line) => line.startsWith("没挂上就用")),
			bindByUser: capsule.verificationRoute.some((line) => line.startsWith("没挂上的工具挂不了")),
			bindInCode: capsule.verificationRoute.some((line) => line.startsWith("不用登记")),
			fragments: lines.filter((item) => item.fragment !== null).length,
			// 去掉第一行"X 是 … 平台插件族"，剩下的一样就是同一张卡
			fingerprint: JSON.stringify(lines.slice(1).map((item) => item.line)),
		};
	});
	const groups = new Map<string, string[]>();
	for (const row of rows.filter((item) => item.bytes > 0))
		groups.set(row.fingerprint, [...(groups.get(row.fingerprint) ?? []), row.base]);
	return {
		families: rows.length,
		pushed: rows.filter((row) => row.bytes > 0).length,
		bindRead: rows.filter((row) => row.bindRead).length,
		bindWrite: rows.filter((row) => row.bindWrite).length,
		bindByUser: rows.filter((row) => row.bindByUser).length,
		bindInCode: rows.filter((row) => row.bindInCode).length,
		bytes: rows.reduce((sum, row) => sum + row.bytes, 0),
		lines: rows.reduce((sum, row) => sum + row.lines.length, 0),
		fragments: rows.reduce((sum, row) => sum + row.fragments, 0),
		sameContent: [...groups.values()].filter((group) => group.length > 1),
		rows,
	};
}

/**
 * 写临时探针时推的类卡片（probe-api）：拿评测集里真机 `api` 问过的 76 个类，各造一个只 import 它的探针，
 * 走和工具同一个入口 `sourceKnowledgeCapsules`。只数"要点""签名"里从文档摘来的行（去掉固定的"精确 import"那句）。
 * 跑探针前按 JAR 反射补签名那一步要真工程，这里不量。
 */
function measureProbeApi(base: ReturnType<typeof openKnowledgeBase>, local: readonly LocalReferenceDoc[]) {
	const checklist = JSON.parse(
		readFileSync(join(import.meta.dirname, "checklists", "knowledge-recall.json"), "utf8"),
	) as { apiClasses: string[] };
	const file = "demo/.cosmic-ai/probes/DemoProbe.java";
	const rows = checklist.apiClasses.map((fqcn) => {
		const source: JavaSourcePort = {
			exists: (path) => path === file,
			read: (path) => (path === file ? `import ${fqcn};\npublic class DemoProbe {}` : ""),
		};
		const [capsule] = sourceKnowledgeCapsules({ base, source, files: [file], runtimeKeyId: null, local });
		const lines =
			capsule === undefined
				? []
				: capsuleLines(capsule).filter((item) => !item.line.startsWith("临时探针精确 import"));
		return {
			fqcn,
			bytes: capsule === undefined ? 0 : bytesOf(renderKnowledgeCapsule(capsule)),
			lines: lines.length,
			fragments: lines.filter((item) => fragment(item.line) !== null).length,
		};
	});
	return {
		classes: rows.length,
		withLines: rows.filter((row) => row.lines > 0).length,
		bytes: rows.reduce((sum, row) => sum + row.bytes, 0),
		lines: rows.reduce((sum, row) => sum + row.lines, 0),
		fragments: rows.reduce((sum, row) => sum + row.fragments, 0),
	};
}

// ------------------------------------------------------------------ 时机

const PLATFORM_ACTIONS = new Set(["search", "api", "findclass", "scenes", "show", "plugin", "anchors"]);
const DECOMPILE = /\b(javap|cfr|procyon|jd-cli)\b/i;
const KNOWLEDGE_DOC = /\/cache\/(?:reference|knowledge)\//i;

interface Call {
	index: number;
	id: string;
	name: string;
	args: Record<string, unknown>;
	result: string;
}

const normal = (path: string): string =>
	path
		.replace(/\\/g, "/")
		.replace(/^@/, "")
		.replace(/^\/([a-z])\//i, "$1:/");
const baseName = (path: string): string => normal(path).split("/").at(-1)?.toLowerCase() ?? "";
const pathOf = (args: Record<string, unknown>): string | null => {
	const value = args.file_path ?? args.path;
	return typeof value === "string" ? value : null;
};

const nodeSource: JavaSourcePort = {
	exists: (path) => {
		try {
			readFileSync(path);
			return true;
		} catch {
			return false;
		}
	},
	read: (path) => {
		try {
			return readFileSync(path, "utf8");
		} catch {
			return "";
		}
	},
};

function callsOf(file: string): Call[] {
	const calls: Call[] = [];
	const byId = new Map<string, Call>();
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line.includes('"toolCall"') && !line.includes('"toolResult"')) continue;
		let entry: { message?: { role?: string; content?: unknown; toolCallId?: string } };
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		const message = entry.message;
		if (message?.role === "toolResult") {
			const call = byId.get(message.toolCallId ?? "");
			if (call !== undefined && Array.isArray(message.content))
				call.result = (message.content as { text?: string }[]).map((part) => part.text ?? "").join("");
			continue;
		}
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content as Record<string, unknown>[]) {
			if (block.type !== "toolCall") continue;
			const call: Call = {
				index: calls.length + 1,
				id: String(block.id),
				name: String(block.name),
				args: (block.arguments ?? {}) as Record<string, unknown>,
				result: "",
			};
			calls.push(call);
			byId.set(call.id, call);
		}
	}
	return calls;
}

interface Touch {
	session: string;
	file: string;
	family: string;
	firstSeen: number;
	how: string;
	/** 第一次 `read` 这个文件；没读过就直接写的，等于 firstWrite。卡片挂在 read 上，窗口从这里算。 */
	firstRead: number;
	firstWrite: number;
	between: { calls: number; queries: number; docReads: number; decompiles: number };
	capsuleAfterWrite: boolean;
	/** 按现在的规则卡片第几次调用到：这一族写了必知要点就是第一次读（没读过就是写），没写要点就不推（null）。 */
	capsuleNow: number | null;
}

function measureTiming() {
	const sessions = readdirSync(dir)
		.filter((name) => name.endsWith(".jsonl"))
		.filter((name) => name.slice(0, 10) >= from && name.slice(0, 10) <= to)
		.sort();
	const touches: Touch[] = [];
	let notPlugin = 0;
	let capsuleBlocks = 0;
	/** 按现在的规则这份会话会推几张插件卡：读过或写过的业务 Java 里，写了要点的插件族各一张。 */
	let capsulesNow = 0;
	let sessionsWithCapsules = 0;
	for (const name of sessions) {
		const calls = callsOf(join(dir, name));
		for (const call of calls) {
			for (const block of call.result.split(/(?=## Knowledge Capsule · )/)) {
				if (!block.startsWith("## Knowledge Capsule · plugin")) continue;
				capsuleBlocks += 1;
			}
		}
		const touched = new Set<string>();
		for (const call of calls) {
			if (call.name !== "read" && call.name !== "write" && call.name !== "edit") continue;
			const path = pathOf(call.args);
			if (path === null || !path.toLowerCase().endsWith(".java") || isAdHocProbeFile(normal(path))) continue;
			const absolute = isAbsolute(normal(path)) ? normal(path) : `${project}/${normal(path)}`;
			if (!absolute.toLowerCase().startsWith(`${project.toLowerCase()}/`)) continue;
			const [family] = pluginFamiliesIn([absolute], nodeSource);
			// 和 sourceKnowledgeCapsules 同一条：只按标识符猜出来的（loose）不推
			if (family !== undefined && family.tier !== "loose" && family.route.essentials !== null) {
				touched.add(family.route.essentials);
			}
		}
		capsulesNow += touched.size;
		if (touched.size > 0) sessionsWithCapsules += 1;
		const written = new Map<string, { first: number; path: string }>();
		for (const call of calls) {
			if (call.name !== "write" && call.name !== "edit") continue;
			const path = pathOf(call.args);
			if (path === null || !path.toLowerCase().endsWith(".java") || isAdHocProbeFile(normal(path))) continue;
			const key = baseName(path);
			if (!written.has(key)) written.set(key, { first: call.index, path });
		}
		for (const [key, { first, path }] of written) {
			const absolute = isAbsolute(normal(path)) ? normal(path) : `${project}/${normal(path)}`;
			const [family] = pluginFamiliesIn([absolute], nodeSource);
			if (family === undefined) {
				notPlugin += 1;
				continue;
			}
			const className = key.replace(/\.java$/, "");
			const mention = new RegExp(`(?<![\\w$])${className}(?![\\w$])`, "i");
			let firstSeen = first;
			let how = "写";
			for (const call of calls) {
				if (call.index >= first) break;
				const readIt = call.name === "read" && baseName(pathOf(call.args) ?? "") === key;
				if (readIt || mention.test(call.result)) {
					firstSeen = call.index;
					how = readIt ? "read 这个文件" : `${call.name} 的返回里出现类名`;
					break;
				}
			}
			const firstRead =
				calls.find(
					(call) => call.index < first && call.name === "read" && baseName(pathOf(call.args) ?? "") === key,
				)?.index ?? first;
			const window = calls.filter((call) => call.index >= firstRead && call.index < first);
			touches.push({
				session: name.slice(0, 19),
				file: key,
				family: family.route.base,
				firstSeen,
				how,
				firstRead,
				firstWrite: first,
				between: {
					calls: window.length,
					queries: window.filter(
						(call) => call.name === "cosmic_knowledge" && PLATFORM_ACTIONS.has(String(call.args.action ?? "")),
					).length,
					docReads: window.filter(
						(call) => call.name === "read" && KNOWLEDGE_DOC.test(normal(pathOf(call.args) ?? "")),
					).length,
					decompiles: window.filter(
						(call) => call.name === "bash" && DECOMPILE.test(String(call.args.command ?? "")),
					).length,
				},
				capsuleNow: family.route.essentials === null || family.tier === "loose" ? null : firstRead,
				capsuleAfterWrite: calls.some(
					(call) => call.index >= first && call.result.includes("## Knowledge Capsule · plugin"),
				),
			});
		}
	}
	const sum = (pick: (touch: Touch) => number) => touches.reduce((total, touch) => total + pick(touch), 0);
	const sorted = touches.map((touch) => touch.between.calls).sort((a, b) => a - b);
	return {
		sessions: sessions.length,
		pluginFiles: touches.length,
		notPlugin,
		capsuleBlocks,
		capsulesNow,
		sessionsWithCapsules,
		window: {
			calls: sum((touch) => touch.between.calls),
			median: sorted[Math.floor(sorted.length / 2)] ?? 0,
			queries: sum((touch) => touch.between.queries),
			docReads: sum((touch) => touch.between.docReads),
			decompiles: sum((touch) => touch.between.decompiles),
		},
		touches,
	};
}

// ------------------------------------------------------------------ 跑

const cacheRoot = mkdtempSync(join(tmpdir(), "cosmic-capsules-"));
try {
	const snapshot = await loadKnowledgeSnapshot(join(import.meta.dirname, "..", "knowledge", "cosmic-kb.pack"));
	const released = await releaseKnowledge(cacheRoot, snapshot);
	const base = openKnowledgeBase(released.layout.docsDir, nodeKnowledgeDocs);
	const reference = await loadKnowledgeSnapshot(join(import.meta.dirname, "..", "knowledge", "reference.pack"));
	const local: LocalReferenceDoc[] = reference.paths.flatMap((path) => {
		const text = reference.read(path);
		const front = text === null ? null : parseSkillFrontmatter(text);
		return text === null || front === null
			? []
			: [{ name: front.name, description: front.description, file: path, text: text.toLowerCase(), source: text }];
	});
	const content = await measureContent(base, local);
	const probeApi = measureProbeApi(base, local);
	const timing = measureTiming();
	if (asJson) {
		console.log(JSON.stringify({ content, probeApi, timing }, null, 2));
	} else {
		console.log(`## 内容：${content.families} 个插件族，读写时推卡片的 ${content.pushed} 个`);
		for (const row of content.rows) {
			console.log(
				row.bytes === 0
					? `\n${row.base}（不推）`
					: `\n${row.base}（${row.bytes} B，${row.lines.length} 行，疑似碎片 ${row.fragments}）`,
			);
			for (const item of row.lines)
				console.log(`  ${item.section} ${item.fragment === null ? "  " : "✗ "}${item.line.slice(0, 110)}`);
			for (const line of row.verify) console.log(`  怎么验   ${line.slice(0, 110)}`);
		}
		console.log(
			`\n绑定：推的 ${content.pushed} 张卡片里，说了去哪查挂没挂上的 ${content.bindRead} 张，说了没挂上怎么办的 ${content.bindWrite + content.bindByUser + content.bindInCode} 张` +
				`（工具能挂、给了命令 ${content.bindWrite}，工具挂不了、说了登记在哪要用户去哪配 ${content.bindByUser}，不用登记 ${content.bindInCode}）`,
		);
		console.log(
			`\n合计 ${content.bytes} B、${content.lines} 行，疑似碎片 ${content.fragments} 行；内容相同的族：${content.sameContent.map((group) => group.join("/")).join("；") || "无"}`,
		);
		console.log(
			`\n## 探针类卡片：${probeApi.classes} 个类，有摘句的 ${probeApi.withLines} 个，摘句 ${probeApi.lines} 行（疑似碎片 ${probeApi.fragments}），卡片合计 ${probeApi.bytes} B`,
		);
		console.log(
			`\n## 时机：${timing.sessions} 份会话，写过的插件 Java ${timing.pluginFiles} 个（非插件 ${timing.notPlugin} 个）`,
		);
		for (const touch of timing.touches)
			console.log(
				`  ${touch.session} ${touch.file}（${touch.family}）第 ${touch.firstSeen} 次调用碰到（${touch.how}），第 ${touch.firstRead} 次读，第 ${touch.firstWrite} 次写；读→写中间 ${touch.between.calls} 次调用，查知识 ${touch.between.queries}、读知识文档 ${touch.between.docReads}、反编译 ${touch.between.decompiles}；写后有卡片 ${touch.capsuleAfterWrite ? "是" : "否"}；现在第 ${touch.capsuleNow ?? "—"} 次到`,
			);
		console.log(
			`\n读→写：合计 ${timing.window.calls} 次调用（中位 ${timing.window.median}），其间查知识 ${timing.window.queries}、读知识文档 ${timing.window.docReads}、反编译 ${timing.window.decompiles}`,
		);
		console.log(
			`会话里发出的插件卡片 ${timing.capsuleBlocks} 张；按现在的规则（读或写到就推，每族一次）${timing.sessionsWithCapsules} 份会话共 ${timing.capsulesNow} 张`,
		);
		const early = timing.touches.filter((touch) => touch.capsuleNow !== null && touch.capsuleNow < touch.firstWrite);
		console.log(
			`按现在的规则：${timing.touches.filter((touch) => touch.capsuleNow !== null).length}/${timing.touches.length} 个文件推卡片，其中 ${early.length} 个在写之前到，合计提前 ${early.reduce((sum, touch) => sum + touch.firstWrite - (touch.capsuleNow ?? 0), 0)} 次调用`,
		);
	}
} finally {
	rmSync(cacheRoot, { recursive: true, force: true });
}
