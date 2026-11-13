/**
 * Prose leaves the JSON envelope (D14.4).
 *
 * A tool result is one `JSON.stringify` of `{ok, state, result}`, so every
 * document body inside it arrives as a single line with its newlines written out
 * as `\n`. Measured on a real `cosmic_knowledge show`: a 25,140-byte markdown
 * guide, 728 newlines, all of them escape sequences by the time the model reads
 * them. The byte cost of that escaping is small (3.4%); the cost is that a
 * document with headings, lists and fenced code blocks is handed over as one
 * flat line, and 91% of this tool's traffic is document bodies and rendered
 * signature lists.
 *
 * `AgentToolResult.content` is an array of content blocks, so the fix does not
 * need a new channel: the envelope stays block 0 and each body goes out as its
 * own block, unescaped, with real line breaks.
 *
 * This is a MOVE, not a copy. The field is replaced in the envelope by a one
 * line pointer saying where it went and how big it was -- emitting both would
 * pay for the same bytes twice, which is the thing the D14.2 cuts exist to stop.
 *
 * Only prose moves. A structured field the caller has to read exactly -- the
 * scene table `plugin` validates its stamp against, a `join`'s counts, a case
 * list -- stays in the envelope where it is machine-shaped, because turning it
 * into prose would make the one step of the six-step flow that is
 * machine-verifiable depend on parsing text back.
 *
 * The kernel is untouched, as with `budgetOutput` and `budgetApiAnswer`: it
 * keeps returning one object with everything in it, and the CLI keeps rendering
 * from that. This is an agent-boundary decision, and the agent boundary is the
 * only place that knows the difference between a terminal and a context window.
 */
import type { CosmicToolName } from "./names.ts";

export interface ProseBlock {
	/** What this body is, printed as the block's first line. */
	label: string;
	text: string;
}

export interface ExtractedProse {
	/** The envelope, with each moved field replaced by a pointer. */
	result: unknown;
	blocks: ProseBlock[];
}

const encoder = new TextEncoder();
const byteLength = (text: string): number => encoder.encode(text).length;

/** What replaces a moved field. Says where it went, so the envelope stays readable alone. */
function pointer(label: string, text: string): string {
	return `→ 见下方文本块「${label}」（${String(byteLength(text))} 字节）`;
}

/**
 * The free-text fields each tool renders its own output into.
 *
 * Deliberately the same set as `BUDGETED_FIELD` plus the two `knowledge`
 * channels: a field worth cutting for size is a field worth reading as text, and
 * the two lists disagreeing would mean some prose is budgeted but flattened, or
 * unflattened but unbudgeted. The budget runs first, so what moves here is
 * already within it.
 *
 * `knowledgeContext` is the exception to that rule and the reason this is a list
 * per tool rather than one field. It carries the delivered Knowledge Capsules,
 * which `selectKnowledgeCapsules` already caps at 8 KB, so it is not budgeted --
 * but it is markdown, up to ~200 lines of it, and the probe and run paths hand
 * it over inside the result object. The same Capsule text reaches the model as
 * clean markdown from the write/edit hook and from the system prompt, and as one
 * escaped line from here; whichever of the three is right, all three being
 * different is not.
 *
 * 导出给已发账用（S34 1.6）：折叠的就是会被挪成文本块的同一批字段，两张表
 * 不一致就会出现「折了一份永远不发的正文」或「发了正文却没折」。
 */
export const PROSE_FIELDS: Partial<Record<CosmicToolName, readonly string[]>> = {
	cosmic_probe: ["output", "knowledgeContext"],
	cosmic_run: ["output", "knowledgeContext"],
	cosmic_lint: ["raw"],
	cosmic_meta: ["text"],
	cosmic_runtime: ["log"],
	// S11: doctor's `index` / `reindex` render the impact index's own report into
	// `text`, the same field `cosmic_impact` uses -- so it is budgeted, and by the
	// rule above it is flattened too. Its other four actions carry no `text` and
	// fall through both tables untouched.
	cosmic_doctor: ["text"],
	cosmic_impact: ["text"],
};

/** What a moved field is called in its block. Falls back to `<tool> 输出`. */
const PROSE_LABEL: Record<string, string> = { knowledgeContext: "Knowledge Capsule" };

/**
 * A row table as a table, not as an array of objects (S15).
 *
 * `scenes` is the channel the tool description points business-voiced questions
 * at -- measured recall 9/9 against 3/10 for literal search -- and it answers
 * with the whole table, so it is also the single biggest thing this tool says:
 * 27,540 bytes of `rows` on the real snapshot. Every one of those rows repeats
 * the same five keys, and `event` is empty on 88 of 167 rows while `control` is
 * empty on 89. Rendered as a table with the all-empty columns dropped, the same
 * content is 18,186 bytes.
 *
 * The keys stay as the header rather than becoming Chinese labels: `relativePath`
 * is what the caller pastes back into `show`, so renaming it in the one place
 * the model reads it would make the follow-up call a guess.
 */
function rowTable(rows: readonly Record<string, unknown>[]): string | null {
	if (rows.length === 0) return null;
	const cell = (value: unknown): string => {
		if (value === null) return "null";
		if (value === undefined) return "";
		// A pipe inside a cell would invent a column; a newline would invent a row.
		return String(value)
			.replace(/\|/g, "/")
			.replace(/\s*\r?\n\s*/g, " ")
			.trim();
	};
	const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))].filter((key) =>
		rows.some((row) => cell(row[key]) !== ""),
	);
	if (columns.length === 0) return null;
	return [columns, ...rows.map((row) => columns.map((key) => cell(row[key])))]
		.map((cells) => cells.join(" | "))
		.join("\n");
}

/** Every row of a knowledge report is a plain object, or the table is not one. */
function tableRows(value: unknown): Record<string, unknown>[] | null {
	if (!Array.isArray(value) || value.length === 0) return null;
	const rows: Record<string, unknown>[] = [];
	for (const row of value) {
		if (typeof row !== "object" || row === null || Array.isArray(row)) return null;
		rows.push(row as Record<string, unknown>);
	}
	return rows;
}

/** A document body carried by `knowledge`: `show`'s answer and `plugin`'s pages. */
interface Document {
	relativePath?: unknown;
	content?: unknown;
}

function documentBlock(value: unknown, fallbackLabel: string): { block: ProseBlock; replaced: Document } | null {
	if (typeof value !== "object" || value === null) return null;
	const doc = value as Document;
	if (typeof doc.content !== "string" || doc.content === "") return null;
	const label = typeof doc.relativePath === "string" && doc.relativePath !== "" ? doc.relativePath : fallbackLabel;
	return {
		block: { label, text: doc.content },
		replaced: { ...doc, content: pointer(label, doc.content) },
	};
}

/**
 * `knowledge`'s bodies: one document for `show`, the guide and the chosen pages
 * for `plugin`, and each class's rendered signature list for `api`.
 *
 * `api`'s methods are one block for the whole batch rather than one per class:
 * the call that needs this most answers a 13-import probe in one go, and 13
 * blocks of five lines each is a worse thing to read than one list with headings.
 */
function knowledgeProse(record: Record<string, unknown>): ExtractedProse | null {
	const action = record.action;
	// `scenes` and `routes` are the two answers that ARE a table. Everything the
	// caller does next -- pick a scene and `show` it, pick a family and read its
	// guide -- is reading, so the rows go out as one, and the envelope keeps the
	// facet accounting and warnings that say how to read them.
	//
	// `plugin`'s scene table is deliberately not here: `plugin` validates its
	// stamp against those rows, and the one machine-verifiable step of that flow
	// must not depend on parsing text back.
	if (action === "scenes" || action === "routes") {
		const rows = tableRows(record.rows);
		const table = rows === null ? null : rowTable(rows);
		if (rows === null || table === null) return null;
		const label = action === "scenes" ? "场景表" : "插件族路由表";
		return {
			result: { ...record, rows: pointer(label, table), rowCount: rows.length },
			blocks: [{ label, text: table }],
		};
	}
	// `search` 把排在前面的块的正文直接带回来：和 show 一样是要读的文字，挪成文本块，
	// 标签用这一块的 show 写法，模型要再取同一块时照抄。
	if (action === "search" && Array.isArray(record.results)) {
		const blocks: ProseBlock[] = [];
		const results = record.results.map((item) => {
			if (typeof item !== "object" || item === null) return item;
			const hit = item as Record<string, unknown>;
			if (typeof hit.text !== "string" || hit.text === "") return item;
			const label = typeof hit.show === "string" && hit.show !== "" ? hit.show : "检索命中";
			blocks.push({ label, text: hit.text });
			return { ...hit, text: pointer(label, hit.text) };
		});
		return blocks.length > 0 ? { result: { ...record, results }, blocks } : null;
	}
	if (action === "show") {
		if (typeof record.content !== "string" || record.content === "") return null;
		const label = typeof record.relativePath === "string" ? record.relativePath : "文档正文";
		return {
			result: { ...record, content: pointer(label, record.content) },
			blocks: [{ label, text: record.content }],
		};
	}
	if (action === "plugin") {
		const blocks: ProseBlock[] = [];
		const next = { ...record };
		const guide = documentBlock(record.guide, "官方指南");
		if (guide) {
			next.guide = guide.replaced;
			blocks.push(guide.block);
		}
		if (Array.isArray(record.chosen)) {
			next.chosen = record.chosen.map((item, index) => {
				const chosen = documentBlock(item, `选定场景 ${String(index + 1)}`);
				if (chosen === null) return item;
				blocks.push(chosen.block);
				return chosen.replaced;
			});
		}
		return blocks.length > 0 ? { result: next, blocks } : null;
	}
	if (action === "api" && Array.isArray(record.entries)) {
		const sections: string[] = [];
		// 按方法查时带回的本地块正文，和 search 一样挪成文本块，标签用它的 show 写法
		const passages: ProseBlock[] = [];
		const entries = record.entries.map((item) => {
			if (typeof item !== "object" || item === null) return item;
			let entry = item as Record<string, unknown>;
			if (Array.isArray(entry.local)) {
				const local = entry.local.map((raw) => {
					if (typeof raw !== "object" || raw === null) return raw;
					const passage = raw as Record<string, unknown>;
					if (typeof passage.text !== "string" || passage.text === "") return raw;
					const label = typeof passage.show === "string" && passage.show !== "" ? passage.show : "本地参考";
					passages.push({ label, text: passage.text });
					return { ...passage, text: pointer(label, passage.text) };
				});
				entry = { ...entry, local };
			}
			const strings = (value: unknown): string[] =>
				Array.isArray(value) ? value.filter((line): line is string => typeof line === "string") : [];
			const lines = strings(entry.methods);
			// 构造和字段（S72）跟在同一个类的方法后面：一个类的签名在一处读完。
			const constructors = strings(entry.constructors);
			const fields = strings(entry.fields);
			if (lines.length + constructors.length + fields.length === 0) return entry;
			const fqcn = typeof entry.fqcn === "string" ? entry.fqcn : "(未知类)";
			sections.push(
				[
					`### ${fqcn}`,
					...lines,
					...(constructors.length === 0 ? [] : ["构造：", ...constructors]),
					...(fields.length === 0 ? [] : ["字段：", ...fields]),
				].join("\n"),
			);
			const counted = [
				lines.length === 0 ? "" : `方法 ${String(lines.length)} 条`,
				constructors.length === 0 ? "" : `构造 ${String(constructors.length)} 个`,
				fields.length === 0 ? "" : `字段 ${String(fields.length)} 个`,
			].filter((part) => part !== "");
			const { constructors: _c, fields: _f, ...rest } = entry;
			return { ...rest, methods: `→ 见下方文本块「签名」中的 ${fqcn}（${counted.join("、")}）` };
		});
		const blocks = [...(sections.length === 0 ? [] : [{ label: "签名", text: sections.join("\n\n") }]), ...passages];
		if (blocks.length === 0) return null;
		return { result: { ...record, entries }, blocks };
	}
	return null;
}

/**
 * Moves a result's prose into its own content blocks.
 *
 * Returns the result unchanged and no blocks when there is nothing to move, so
 * the caller can keep emitting a single-block result in the ordinary case.
 */
export function extractProse(tool: CosmicToolName | undefined, result: unknown): ExtractedProse {
	const unchanged: ExtractedProse = { result, blocks: [] };
	if (tool === undefined || typeof result !== "object" || result === null || Array.isArray(result)) return unchanged;
	const record = result as Record<string, unknown>;
	if (tool === "cosmic_knowledge") return knowledgeProse(record) ?? unchanged;
	const fields = PROSE_FIELDS[tool];
	if (fields === undefined) return unchanged;
	const blocks: ProseBlock[] = [];
	const next = { ...record };
	for (const field of fields) {
		const text = record[field];
		// A one-line output is prose too, but a block for it costs a heading and
		// buys nothing: there are no line breaks to lose.
		if (typeof text !== "string" || !text.includes("\n")) continue;
		const label = PROSE_LABEL[field] ?? `${tool} 输出`;
		next[field] = pointer(label, text);
		blocks.push({ label, text });
	}
	return blocks.length === 0 ? unchanged : { result: next, blocks };
}
