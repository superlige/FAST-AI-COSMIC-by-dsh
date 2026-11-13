#!/usr/bin/env node

/**
 * Exports the official Kingdee knowledge base into cosmic's own frozen snapshot
 * (S7.0, sanctioned by IMPLEMENTATION.md D13).
 *
 * This is the SECOND frozen input source, alongside long-cosmic-dev: the agent
 * ships the knowledge base itself, because the target users have no download
 * channel for the official skill bundle and cannot update it (D13). Everything
 * D13 requires of a frozen input applies here -- a manifest recording the source
 * path, the bundle version, the document count and a per-file SHA-256, so a
 * release build only ever accepts a recorded version.
 *
 * Two products, deliberately separate:
 *
 *   knowledge/manifest.json  -- the audit record. Human-readable, diffable, and
 *     what tells you WHICH documents moved when a snapshot changes.
 *   knowledge/cosmic-kb.pack -- the payload. One gzipped block (D13 criterion 2:
 *     NOT the base64 TS array of EMBEDDED_RESOURCES -- 1,763 documents would make
 *     an 8 MB TypeScript source file that tsgo, biome and the bundler all chew on
 *     every single run).
 *
 * Read-only with respect to the source bundle. Nothing is written back into
 * app-build, and only .md files under the three knowledge roots are read at all.
 *
 * Usage: node scripts/export-knowledge.mjs <app-build-root> [--write]
 */

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

/** Path of the knowledge tree inside the app-build bundle. */
const KB_RELATIVE = ".locales/zh/knowledge/cosmic";

/**
 * The only three trees that are knowledge. Anything else in the bundle
 * (capabilities/, schemas/, scripts/, skills/) is app-build's own machinery and
 * is NOT ours to redistribute or to reason about.
 */
const ALLOWED_ROOTS = ["arch", "platform", "requirements"];

/**
 * Knowledge is prose. The extension allow-list is not a formality: it is what
 * guarantees that no binary, no credential and no customer artefact can ride
 * into a cosmic release through this path, in the same way that
 * export-resources.mjs guarantees it for the Java side.
 */
const ALLOWED_EXTENSION = ".md";

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

function walk(dir, relative, out) {
	for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		const rel = relative === "" ? entry.name : `${relative}/${entry.name}`;
		const abs = join(dir, entry.name);
		if (entry.isDirectory()) walk(abs, rel, out);
		else if (entry.isFile()) out.push(rel);
	}
	return out;
}

/**
 * The bundle version, from the CHANGELOG the bundle itself declares as its
 * identity ("this file ships with the bundle, so a deployed runtime can be
 * identified by the version at the top"). It is NOT defaulted: a snapshot whose
 * provenance cannot be named is exactly the thing D13 forbids shipping.
 */
function bundleVersionOf(root) {
	for (const candidate of [join(root, "CHANGELOG.md"), join(root, ".locales", "zh", "CHANGELOG.md")]) {
		let text;
		try {
			text = readFileSync(candidate, "utf8");
		} catch {
			continue;
		}
		const match = /^##\s*\[(\d+\.\d+\.\d+)\]/m.exec(text);
		if (match?.[1]) return { version: match[1], from: candidate };
	}
	return null;
}

function main() {
	const [rootArg, ...flags] = process.argv.slice(2);
	if (!rootArg) {
		console.error("用法: node scripts/export-knowledge.mjs <app-build-root> [--write]");
		process.exit(2);
	}
	const bundleRoot = resolve(rootArg);
	const write = flags.includes("--write");
	const kbRoot = join(bundleRoot, ...KB_RELATIVE.split("/"));

	try {
		if (!statSync(kbRoot).isDirectory()) throw new Error("not a directory");
	} catch {
		console.error(`[FAIL] 找不到知识库目录：${kbRoot}`);
		process.exit(1);
	}

	const bundle = bundleVersionOf(bundleRoot);
	if (bundle === null) {
		// Refusing beats guessing: an unversioned snapshot cannot be re-obtained,
		// and "which app-build did this knowledge come from" becomes unanswerable.
		console.error(`[FAIL] 无法从 ${bundleRoot} 的 CHANGELOG.md 读出 bundle 版本，拒绝导出无版本快照`);
		process.exit(1);
	}

	const listed = [];
	for (const root of ALLOWED_ROOTS) {
		let stat;
		try {
			stat = statSync(join(kbRoot, root));
		} catch {
			console.error(`[FAIL] 知识库缺少约定目录：${root}/`);
			process.exit(1);
		}
		if (!stat.isDirectory()) {
			console.error(`[FAIL] ${root} 不是目录`);
			process.exit(1);
		}
		for (const rel of walk(join(kbRoot, root), root, [])) listed.push(rel);
	}

	const rejected = listed.filter((path) => !path.toLowerCase().endsWith(ALLOWED_EXTENSION));
	if (rejected.length > 0) {
		// A .png or a .json turning up under the knowledge roots is not something to
		// skip quietly -- it means the bundle's shape changed and the snapshot
		// contract needs a human decision, not a filtered-out surprise.
		console.error(`[FAIL] 知识目录下出现了非 .md 文件，拒绝导出：\n  ${rejected.slice(0, 20).join("\n  ")}`);
		process.exit(1);
	}

	const files = [];
	const payloads = [];
	let bytes = 0;
	for (const path of listed.sort((a, b) => a.localeCompare(b))) {
		const content = readFileSync(join(kbRoot, path), "utf8");
		const encoded = Buffer.from(content, "utf8");
		files.push({ path, bytes: encoded.length, sha256: sha256(content) });
		payloads.push(encoded);
		bytes += encoded.length;
	}

	// The snapshot id covers content AND layout: a document that moved without
	// changing text is still a different snapshot, because every route into the
	// knowledge base is by path.
	const snapshotId = createHash("sha256")
		.update(canonicalJson(files.map((file) => [file.path, file.sha256])), "utf8")
		.digest("hex")
		.slice(0, 32);

	const manifest = {
		schema: "cosmic.knowledge/1",
		source: {
			// Recorded for provenance only. The runtime NEVER reads this path: the
			// released snapshot is the truth, so a machine without app-build behaves
			// identically to the machine that built the snapshot.
			bundleRoot,
			knowledgeRoot: KB_RELATIVE,
			bundleVersion: bundle.version,
			bundleVersionFrom: bundle.from,
		},
		snapshotId,
		counts: countsOf(files),
		bytes,
		files,
	};

	const header = {
		schema: "cosmic.knowledge-pack/1",
		snapshotId,
		bundleVersion: bundle.version,
		files,
	};
	const headerJson = Buffer.from(JSON.stringify(header), "utf8");
	const pack = gzipSync(Buffer.concat([headerJson, Buffer.from("\n", "utf8"), ...payloads]), { level: 9 });

	if (write) {
		const outRoot = resolve(new URL("../knowledge", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
		mkdirSync(outRoot, { recursive: true });
		writeFileSync(join(outRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
		writeFileSync(join(outRoot, "cosmic-kb.pack"), pack);
	}

	const mib = (n) => (n / 1024 / 1024).toFixed(2);
	console.log(
		`${write ? "已导出" : "dry-run"} ${files.length} 篇官方知识 / ${bytes} 字节（${mib(bytes)} MiB）` +
			`，压缩后 ${pack.length} 字节（${mib(pack.length)} MiB）`,
	);
	console.log(`  bundle 版本 ${bundle.version}，快照 ${snapshotId.slice(0, 12)}`);
	for (const [group, count] of Object.entries(manifest.counts)) console.log(`  ${group.padEnd(20)} ${count} 篇`);
}

/** Group counts, so a snapshot diff shows WHERE documents appeared or vanished. */
function countsOf(files) {
	const counts = {};
	for (const file of files) {
		const parts = file.path.split("/");
		const group = parts[0] === "platform" && parts.length > 2 ? `platform/${parts[1]}` : parts[0];
		counts[group] = (counts[group] ?? 0) + 1;
	}
	return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

main();
