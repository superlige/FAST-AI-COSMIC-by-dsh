/**
 * The generated reference skills (S7.1).
 *
 * Two things are under test and they are different in kind. checkSkillEntries is
 * about pi's contract: a skill pi refuses is dropped with a diagnostic nobody
 * reads, so the document silently stops existing -- defect D-2 coming back by
 * another door. The manifest assertions are about the migration promise: all 30
 * documents accounted for, nothing dropped quietly, and the routing table gone
 * rather than ported -- each page now declares its own class/when/note, so the
 * table has no reader left and a new page cannot appear without a description.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { openKnowledgePack } from "../../src/knowledge/pack.ts";
import {
	checkSkillEntries,
	estimateInjectionBudget,
	familyIndexText,
	parseSkillFrontmatter,
	REFERENCE_FAMILIES,
	referenceFamilyDir,
	referenceSkillPaths,
	referenceSourceResolver,
} from "../../src/knowledge/reference.ts";
import { knowledgeLayout } from "../../src/knowledge/release.ts";

interface ReferenceManifest {
	schema: string;
	source: { dir: string };
	snapshotId: string;
	counts: Record<string, number> & {
		documents: number;
		intraLinksRewritten: number;
		staleCommandOccurrences: number;
		staleCommandDocs: number;
		rewrittenCommandOccurrences: number;
		rewrittenCommandDocs: number;
	};
	classes: Record<string, { title: string; docs: string[]; lines: number }>;
	/** Pages that claim to describe a probe's behaviour, pinned to that probe's bytes. */
	probePins: { doc: string; file: string; sha256: string }[];
	excluded: { doc: string; why: string; instead: string }[];
	skills: { name: string; doc: string; class: string; description: string; descriptionChars: number }[];
	staleCommands: Record<string, { count: number; commands: string[] }>;
	/** S5.1: occurrences already rewritten to a tool name, per document. */
	rewrittenCommands: Record<string, { count: number; commands: string[] }>;
	pendingCommands: string[];
	danglingLinks: { from: string; target: string; kind: string }[];
	officialKnowledgeData: Record<string, string>;
	files: { path: string; bytes: number; sha256: string }[];
}

const manifest = JSON.parse(
	readFileSync(fileURLToPath(new URL("../../knowledge/reference-manifest.json", import.meta.url)), "utf8"),
) as ReferenceManifest;

const snapshot = openKnowledgePack(
	readFileSync(fileURLToPath(new URL("../../knowledge/reference.pack", import.meta.url))),
);

const EXPORT_SCRIPT = fileURLToPath(new URL("../../scripts/export-reference.mjs", import.meta.url));

const entries = snapshot.header.files.map((file) => ({ path: file.path, text: snapshot.read(file.path) as string }));

/** 族索引在盘上的路径形状，checkSkillEntries 要按它校验目录名与 name 一致。 */
function familyEntry(family: (typeof REFERENCE_FAMILIES)[number]): { path: string; text: string } {
	return { path: `${family.name}/SKILL.md`, text: familyIndexText(family, []) };
}

describe("S7.1 reference 分流与 skill 载体", () => {
	it("produces skills pi will actually load", () => {
		expect(checkSkillEntries(entries)).toEqual([]);
	});

	it("accounts for all exported documents: classified, or excluded with a reason", () => {
		const classified = Object.values(manifest.classes).flatMap((group) => group.docs);
		expect(new Set(classified).size).toBe(manifest.counts.documents);
		// The rule from the design doc: 归不进四类的显式列出，不许静默丢。Exclusions
		// count too -- a document that is neither a skill nor a listed exclusion has
		// been dropped, and this is what notices.
		const shipped = new Set(manifest.skills.map((skill) => skill.doc));
		const excluded = new Set(manifest.excluded.map((entry) => entry.doc));
		for (const doc of classified) {
			expect(shipped.has(doc) || excluded.has(doc), `${doc} 既没做成 skill 也没登记排除`).toBe(true);
		}
		expect(shipped.size + excluded.size).toBeGreaterThanOrEqual(manifest.counts.documents);
	});

	it("keeps the four class sizes the design doc was decided on", () => {
		expect(
			Object.fromEntries(Object.entries(manifest.classes).map(([key, group]) => [key, group.docs.length])),
		).toEqual({ A: 9, B: 13, C: 6, D: 3 });
		for (const group of Object.values(manifest.classes)) expect(group.lines).toBeGreaterThan(0);
	});

	it("is what knowledge/reference/ produces today, so a page edit cannot ship without a re-export", () => {
		// The pages and the pack live in the same repository. Without this, a page
		// edited and committed without `export-reference.mjs --write` would leave the
		// model reading the old text, and every other test here would stay green
		// against the stale pack.
		const result = spawnSync(process.execPath, [EXPORT_SCRIPT, "--check"], { encoding: "utf8" });
		expect(result.stderr + result.stdout, "运行 node scripts/export-reference.mjs --write").toContain(
			"参考文档与生成的技能包一致",
		);
		expect(result.status).toBe(0);
	});

	it("gives every excluded document a replacement destination, not just a reason", () => {
		// official-knowledge.md is linked to 8 times from the other documents. Saying
		// only "this is gone" would strand every one of those references.
		for (const entry of manifest.excluded) {
			expect(entry.why.length, entry.doc).toBeGreaterThan(0);
			expect(entry.instead.length, entry.doc).toBeGreaterThan(0);
		}
		expect(manifest.excluded.map((entry) => entry.doc).sort()).toEqual(["delivery-protocol", "official-knowledge"]);
	});

	it("builds every description from the page's own H1 and frontmatter", () => {
		for (const skill of manifest.skills) {
			// "<what it is>。什么时候读：<when>。" -- the first half is the page's H1 and
			// the second its frontmatter `when`, so both halves live in the page itself.
			// Nothing here is authored in the exporter, and nothing is copied from a table.
			expect(skill.description, skill.name).toContain("什么时候读：");
			expect(skill.descriptionChars, skill.name).toBeLessThanOrEqual(1024);
		}
	});

	it("keeps two pages that once shared one routing row distinguishable", () => {
		// The frozen table had one row for both ("界面规则 / 业务规则及函数目录"), split by
		// position at export time. That split is now materialised in each page's own
		// frontmatter, so this asserts the result rather than the derivation.
		const formRules = manifest.skills.find((skill) => skill.name === "cosmic-metadata-form-rules");
		const businessRules = manifest.skills.find((skill) => skill.name === "cosmic-metadata-business-rules");
		expect(formRules?.description).toContain("界面规则");
		expect(businessRules?.description).toContain("业务规则及函数目录");
		expect(formRules?.description).not.toBe(businessRules?.description);
	});

	it("carries routing dependencies into the description instead of losing them", () => {
		// "先读写入总则" is not decoration: reading the object page without the write
		// rules is exactly the shared-environment accident metadata-write exists for.
		// It is a separate `note` field in frontmatter, not folded into `when`, because
		// it is a prerequisite -- L3's gate will need to read it as one.
		const create = manifest.skills.find((skill) => skill.name === "cosmic-metadata-create");
		expect(create?.description).toContain("先读写入总则");
		const parentChild = manifest.skills.find((skill) => skill.name === "cosmic-run-parent-child");
		expect(parentChild?.description).toContain("同时读 run");
	});

	it("rewrites intra-reference links to sibling skills so they still resolve", () => {
		expect(manifest.counts.intraLinksRewritten).toBeGreaterThan(150);
		const text = snapshot.read("cosmic-metadata-create/SKILL.md") as string;
		expect(text).toContain("../cosmic-metadata-write/SKILL.md");
		// No link may still point at a bare reference/ filename.
		for (const entry of entries) {
			expect(entry.text, entry.path).not.toMatch(/\]\((?!\.\.\/|https?:|#)[a-z0-9-]+\.md/);
		}
	});

	it("does not leave links pointing at documents that were never shipped", () => {
		for (const entry of entries) {
			expect(entry.text, entry.path).not.toMatch(/\]\(\.\.\/(?:docs|protocol)\//);
			expect(entry.text, entry.path).not.toContain("](official-knowledge.md");
		}
		expect(manifest.danglingLinks.length).toBeGreaterThan(0);
		for (const link of manifest.danglingLinks) {
			expect(["excluded-doc", "outside-migration-scope"]).toContain(link.kind);
		}
	});

	it("按命令映射改写已迁移命令，剩余陈旧命令只减不增且逐篇挂横幅", () => {
		// A ceiling, not an equality. Shipping documents that tell the model to run a
		// CLI cosmic does not have is a real defect, so the number must not grow
		// unnoticed -- and S5 drives it down as each command migrates.
		expect(manifest.counts.staleCommandOccurrences).toBeLessThanOrEqual(137);
		expect(manifest.counts.staleCommandDocs).toBeLessThanOrEqual(25);
		// Removing a retired protocol legitimately reduces the source occurrence count.
		expect(manifest.counts.rewrittenCommandOccurrences + manifest.counts.staleCommandOccurrences).toBeLessThanOrEqual(
			137,
		);
		expect(manifest.counts.rewrittenCommandOccurrences).toBeGreaterThan(0);

		for (const doc of Object.keys(manifest.staleCommands)) {
			const text = snapshot.read(`cosmic-${doc}/SKILL.md`) as string;
			expect(text, doc).toContain("没有对应的工具");
		}
		for (const [doc, entry] of Object.entries(manifest.rewrittenCommands)) {
			const text = snapshot.read(`cosmic-${doc}/SKILL.md`) as string;
			expect(text, doc).toContain("参数写法以工具说明为准");
			// Nothing in a rewritten document may still hand the model a CLI launcher
			// for a command that is now a tool.
			for (const command of entry.commands) {
				expect(text, `${doc}/${command}`).not.toMatch(new RegExp(String.raw`driver\.mjs\s+${command}(?![a-z-])`));
			}
		}
	});

	it("keeps official-knowledge's two data sections and nothing else", () => {
		expect(Object.keys(manifest.officialKnowledgeData).sort()).toEqual(["下钻顺序", "冲突登记"]);
		// The conflict register is evidence-bearing: every row cites a sig or probe
		// result. It is the one part of that document that is data, not rules.
		expect(manifest.officialKnowledgeData.冲突登记).toContain("sig ");
		expect(manifest.officialKnowledgeData.下钻顺序).toContain("knowledge scenes");
		expect(snapshot.read("cosmic-official-knowledge/SKILL.md")).toBeNull();
	});

	it("pins the pages that describe probe behaviour to the probe cosmic ships", () => {
		// The gap this closes: `--set` grew sub-entry paths and one shared value
		// conversion, five probes changed, and run.md went on documenting two
		// segments only. Every test stayed green, because no test knew the two were
		// related. Recomputing the digest here means the pin cannot be satisfied by
		// editing the manifest either -- only by the export, which refuses to run
		// while a pinned page has not been re-read.
		expect(manifest.probePins.length).toBeGreaterThan(0);
		for (const pin of manifest.probePins) {
			const source = readFileSync(
				fileURLToPath(new URL(`../../resources/probes/${pin.file}`, import.meta.url)),
				"utf8",
			).replace(/\r\n/g, "\n");
			expect(createHash("sha256").update(source, "utf8").digest("hex").slice(0, 12), pin.file).toBe(pin.sha256);
		}
		// run.md is the page that carries the contract; losing its pin would put the
		// mechanism back to "nothing notices".
		expect(manifest.probePins.some((pin) => pin.doc === "run" && pin.file === "ExpectSpec.java")).toBe(true);
	});

	it("ships the whole --set contract, not just the two-segment half of it", () => {
		// What the pin protects, asserted directly: a model that reads this skill and
		// still cannot write a sub-entry path or a date is why the pin exists.
		const run = entries.find((entry) => entry.path === "cosmic-run/SKILL.md")?.text ?? "";
		expect(run).toContain("分录标识[2].子分录标识[1].字段");
		// The value side: every conversion that has no other documented home.
		for (const rule of ["yyyy-MM-dd HH:mm:ss", "now", "存储值", "逗号分隔", "null"]) {
			expect(run, rule).toContain(rule);
		}
		// And the scope differences, which are real rather than an omission.
		expect(run).toContain("run rule");
		expect(run).toContain("子分录");
	});

	it("matches the manifest file for file", () => {
		expect(snapshot.header.files).toHaveLength(manifest.files.length);
		const byPath = new Map(snapshot.header.files.map((file) => [file.path, file.sha256]));
		for (const file of manifest.files) expect(byPath.get(file.path), file.path).toBe(file.sha256);
	});

	it("records where the text came from as a repository path, with nothing that changes per run", () => {
		// A timestamp or an absolute path here would make every re-export a diff and
		// the --check above meaningless; the per-page hashes are the provenance.
		expect(manifest.source).toEqual({ dir: "knowledge/reference" });
		for (const file of manifest.files) expect(file.sha256, file.path).toMatch(/^[0-9a-f]{64}$/);
	});

	it("normalises line endings, so the snapshot does not depend on how git checked out", () => {
		// core.autocrlf=true can leave the pages mixed CRLF and LF. Without
		// normalising, a fresh clone with different
		// settings would produce a different snapshotId for identical text, and the
		// symptom would be "the knowledge changed and I did not touch it".
		for (const entry of entries) expect(entry.text, entry.path).not.toContain("\r");
	});

	it("costs less per skill than the design doc estimated, once measured", () => {
		const budget = estimateInjectionBudget(manifest.skills, "C:/cache/reference/abcdef/skills");
		expect(budget.skills).toBe(30);
		// The design doc estimated 350 B per skill and marked it 设计值，需实测校准.
		// Measured content cost is ~306 B, so the content half is under budget.
		expect((budget.bytes - budget.pathBytes) / budget.skills).toBeLessThan(350);
		// SKILL.md's 13312-byte budget is the figure real usage validated; the design
		// doc's 10.5 KB was an estimate. S7.5 sets the final number.
		expect(budget.bytes).toBeLessThan(13312);
	});

	it("separates the path term, because that is the half nobody controls", () => {
		// Same skills, deeper cache root: the difference is entirely location paths.
		// Without this split, a future "the budget grew" sends someone to shorten
		// descriptions when the real cause is where the user's cache happens to live.
		const shallow = estimateInjectionBudget(manifest.skills, "C:/c/reference/a/skills");
		const deep = estimateInjectionBudget(
			manifest.skills,
			`C:/Users/somebody/AppData/Local/Temp/${"x".repeat(40)}/reference/${"0".repeat(32)}/skills`,
		);
		expect(deep.bytes - shallow.bytes).toBe(deep.pathBytes - shallow.pathBytes);
		expect(deep.bytes - shallow.bytes).toBeGreaterThan(2000);
	});

	it("hands pi the family index directory, never the 28 documents themselves", () => {
		const layout = knowledgeLayout("C:/cache", "abc", { namespace: "reference", docsDirName: "skills" });
		// pi 把扫到的每个 `<子目录>/SKILL.md` 都注册成 skill：交出 docsDir 就等于回到 28 项，
		// 启动时列成八行灰字。族索引住在自己的目录里，正是为了不被一起扫走。
		expect(referenceSkillPaths(layout)).toEqual([referenceFamilyDir(layout)]);
		expect(referenceSkillPaths(layout)[0]).not.toBe(layout.docsDir);
		expect(referenceFamilyDir(layout)).toContain("reference");
	});

	it("files every document into exactly one family, and says so when one is left out", () => {
		// 少一篇没归族 = 这篇从此没人知道它存在，正是 D-2 那个缺陷本身。
		const names = manifest.skills.map((skill) => skill.name).sort();
		const filed = REFERENCE_FAMILIES.flatMap((family) => family.members).sort();
		expect(filed).toEqual(names);
		expect(new Set(filed).size).toBe(filed.length);
	});

	it("keeps family names inside pi's own name pattern", () => {
		// pi 只收 [a-z0-9-]：中文族名只能进 description 和正文，进了 name 就被静默丢弃。
		for (const family of REFERENCE_FAMILIES) {
			expect(family.name).toMatch(/^[a-z0-9-]+$/);
			expect(family.description.length).toBeGreaterThan(30);
			expect(family.description.length).toBeLessThanOrEqual(1024);
		}
		expect(checkSkillEntries(REFERENCE_FAMILIES.map((family) => familyEntry(family)))).toEqual([]);
	});

	it("writes each member's own description and absolute path into the index body", () => {
		const layout = knowledgeLayout("C:/cache", "abc", { namespace: "reference", docsDirName: "skills" });
		const family = REFERENCE_FAMILIES[0] as (typeof REFERENCE_FAMILIES)[number];
		const text = familyIndexText(family, [
			{ name: "cosmic-metadata-read", description: "元数据读取总入口。", file: `${layout.docsDir}/x/SKILL.md` },
		]);
		// 正文承接的正是原来 28 条常驻 description 的活：模型展开这一族就该看到「什么时候读」
		expect(text).toContain("元数据读取总入口。");
		expect(text).toContain(`${layout.docsDir}/x/SKILL.md`);
		expect(parseSkillFrontmatter(text)?.name).toBe(family.name);
	});

	it("turns a capsule's reference source into the released page path, and only when that page exists", () => {
		// 胶囊出处只写名字时模型打不开：pi 只认族名，成员页要绝对路径才能 read
		const docsDir = mkdtempSync(join(tmpdir(), "cosmic-reference-source-"));
		try {
			mkdirSync(join(docsDir, "cosmic-plugin-ui"));
			writeFileSync(join(docsDir, "cosmic-plugin-ui", "SKILL.md"), "---\nname: cosmic-plugin-ui\n---\n");
			const resolve = referenceSourceResolver(docsDir);
			expect(resolve("reference:cosmic-plugin-ui")).toBe(join(docsDir, "cosmic-plugin-ui", "SKILL.md"));
			expect(resolve("reference:cosmic-no-such-page")).toBe("reference:cosmic-no-such-page");
			expect(resolve("knowledge:platform/form-plugin.md")).toBe("knowledge:platform/form-plugin.md");
		} finally {
			rmSync(docsDir, { recursive: true, force: true });
		}
	});

	it("parses back exactly what it wrote", () => {
		const text = snapshot.read("cosmic-run/SKILL.md") as string;
		const front = parseSkillFrontmatter(text);
		expect(front?.name).toBe("cosmic-run");
		expect(front?.description).toBe(manifest.skills.find((skill) => skill.name === "cosmic-run")?.description);
	});
});
