/**
 * The official knowledge snapshot's on-disk format (S7.0, D13).
 *
 * One gzipped block, not 1,763 files and not a generated TypeScript array. D13
 * criterion 2 rules out the EMBEDDED_RESOURCES shape explicitly: 55 probe files
 * already make embedded.generated.ts 704 KB, and 1,763 documents would produce
 * an 8 MB TS source that tsgo, biome and the bundler re-chew on every run. The
 * pack is opaque to all three.
 *
 * Layout, inside the gzip:
 *
 *   <headerJSON>\n<doc bytes><doc bytes>...
 *
 * The separator is unambiguous because JSON.stringify escapes newlines inside
 * strings, so the first 0x0A byte always ends the header. Documents follow in
 * header order and are located by running offset -- no per-document framing,
 * because the header already carries every length.
 *
 * Encode and decode live in this one module so the format has a single
 * definition and round-tripping is provable rather than assumed.
 */
import { gunzipSync, gzipSync } from "node:zlib";
import { KernelError } from "../kernel/errors.ts";
import { sha256 } from "../runtime/fingerprint.ts";

export const KNOWLEDGE_PACK_SCHEMA = "cosmic.knowledge-pack/1";

export interface KnowledgeDoc {
	/** Path relative to the knowledge root, forward slashes, e.g. "platform/scenes/_index.md". */
	path: string;
	/** Length of the UTF-8 encoding, not of the JavaScript string. */
	bytes: number;
	sha256: string;
}

export interface KnowledgePackHeader {
	schema: typeof KNOWLEDGE_PACK_SCHEMA;
	/** Content+layout digest of the whole snapshot. Names the cache directory. */
	snapshotId: string;
	/** app-build bundle version this snapshot came from, e.g. "2.2.1". */
	bundleVersion: string;
	files: readonly KnowledgeDoc[];
}

export interface KnowledgeSnapshot {
	header: KnowledgePackHeader;
	paths: readonly string[];
	/**
	 * UTF-8 text of one document, or null when the path is not in the snapshot.
	 *
	 * The recorded SHA-256 is verified here rather than at open time. This is the
	 * only place bytes become content, and verifying the whole 6 MB up front would
	 * cost every startup for a corruption that would be caught on use anyway.
	 */
	read(path: string): string | null;
}

function invalid(why: string, detail: Record<string, string | number> = {}): KernelError {
	return new KernelError("KNOWLEDGE_PACK_INVALID", `知识快照不可用：${why}`, {
		detail,
		remedy: "重新运行 scripts/export-knowledge.mjs 生成快照，或改用 COSMIC_KNOWLEDGE_ROOT 指向可用的官方知识库。",
	});
}

export function packKnowledge(
	header: Omit<KnowledgePackHeader, "schema" | "files">,
	docs: readonly { path: string; content: string }[],
): Uint8Array {
	const files: KnowledgeDoc[] = [];
	const payloads: Buffer[] = [];
	for (const doc of [...docs].sort((a, b) => a.path.localeCompare(b.path))) {
		const encoded = Buffer.from(doc.content, "utf8");
		files.push({ path: doc.path, bytes: encoded.length, sha256: sha256(doc.content) });
		payloads.push(encoded);
	}
	const full: KnowledgePackHeader = { schema: KNOWLEDGE_PACK_SCHEMA, ...header, files };
	return gzipSync(Buffer.concat([Buffer.from(JSON.stringify(full), "utf8"), Buffer.from("\n", "utf8"), ...payloads]), {
		level: 9,
	});
}

/**
 * Opens a pack. Every failure is a KernelError rather than a null: a knowledge
 * base that silently turns up empty is exactly the shape of defect D-3 in
 * docs/knowledge-injection.md -- the whole point of the snapshot is that
 * "knowledge is missing" must be loud.
 */
export function openKnowledgePack(bytes: Uint8Array): KnowledgeSnapshot {
	let raw: Buffer;
	try {
		raw = gunzipSync(bytes);
	} catch (error) {
		throw invalid("gzip 解压失败", { reason: error instanceof Error ? error.message : String(error) });
	}

	const separator = raw.indexOf(0x0a);
	if (separator < 0) throw invalid("找不到头部分隔符");

	let header: KnowledgePackHeader;
	try {
		header = JSON.parse(raw.subarray(0, separator).toString("utf8")) as KnowledgePackHeader;
	} catch (error) {
		throw invalid("头部不是合法 JSON", { reason: error instanceof Error ? error.message : String(error) });
	}
	if (header.schema !== KNOWLEDGE_PACK_SCHEMA) throw invalid(`不认识的 schema：${String(header.schema)}`);
	if (typeof header.snapshotId !== "string" || header.snapshotId === "") throw invalid("头部缺少 snapshotId");
	if (typeof header.bundleVersion !== "string" || header.bundleVersion === "") throw invalid("头部缺少 bundleVersion");
	if (!Array.isArray(header.files)) throw invalid("头部缺少文件表");

	const body = raw.subarray(separator + 1);
	const spans = new Map<string, { start: number; end: number; sha256: string }>();
	let offset = 0;
	for (const file of header.files) {
		spans.set(file.path, { start: offset, end: offset + file.bytes, sha256: file.sha256 });
		offset += file.bytes;
	}
	// A truncated pack must not degrade into "the last few documents are empty".
	if (offset !== body.length) {
		throw invalid("正文长度与文件表不符", { declared: offset, actual: body.length });
	}

	return {
		header,
		paths: header.files.map((file) => file.path),
		read(path) {
			const span = spans.get(path);
			if (span === undefined) return null;
			const content = body.subarray(span.start, span.end).toString("utf8");
			if (sha256(content) !== span.sha256) throw invalid(`文档校验失败：${path}`, { path });
			return content;
		},
	};
}
