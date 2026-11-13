import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import {
	buildSourceManifest,
	CODE_SCOPE,
	EXCLUDED_TOP_LEVEL,
	ExportSourceError,
	KNOWLEDGE_SCOPE,
	PROTOCOL_SCOPE,
	resolveCommit,
	type SourceManifest,
	writeManifest,
} from "../../src/manifest/export-source.ts";

const execFileP = promisify(execFile);

const tempRoots: string[] = [];

function tempRoot(): string {
	const dir = mkdtempSync(join(tmpdir(), "cosmic-export-"));
	tempRoots.push(dir);
	return dir;
}

afterAll(() => {
	for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
});

async function git(repo: string, args: readonly string[]): Promise<string> {
	const { stdout } = await execFileP("git", ["-C", repo, ...args]);
	return stdout;
}

/** Builds a fixture repo shaped like long-cosmic-dev, returns [repoPath, ref]. */
async function createFixtureRepo(): Promise<{ repo: string; ref: string; committedDriver: string }> {
	const repo = join(tempRoot(), "fixture-src");
	await mkdir(join(repo, "tools"), { recursive: true });
	await mkdir(join(repo, "probes"), { recursive: true });
	await mkdir(join(repo, "runtime"), { recursive: true });
	await mkdir(join(repo, "reference"), { recursive: true });
	await mkdir(join(repo, "docs"), { recursive: true });
	await mkdir(join(repo, "protocol"), { recursive: true });
	await mkdir(join(repo, "scratchpad"), { recursive: true });

	const committedDriver = "export const ROOT = 'committed';\n";
	await writeFile(join(repo, "driver.mjs"), committedDriver, "utf8");
	await writeFile(join(repo, "config.mjs"), "export const CFG = 1;\n", "utf8");
	await writeFile(join(repo, "tools", "run.mjs"), "export const tool = 'a';\n", "utf8");
	await writeFile(join(repo, "tools", "Helper.java"), "class Helper {}\n", "utf8");
	await writeFile(join(repo, "probes", "P.java"), "class P {}\n", "utf8");
	await writeFile(join(repo, "runtime", "R.java"), "class R {}\n", "utf8");
	await writeFile(join(repo, "reference", "probes.md"), "# probes\n\nbody line\n", "utf8");
	await writeFile(join(repo, "docs", "design.md"), "# design\n", "utf8");
	await writeFile(join(repo, "SKILL.md"), "# skill\n", "utf8");
	await writeFile(join(repo, "protocol", "z.json"), "{}\n", "utf8");
	await writeFile(join(repo, "scratchpad", "tmp.txt"), "scratch\n", "utf8");
	await writeFile(join(repo, "README.md"), "# readme\n", "utf8");

	await git(repo, ["init", "-b", "main"]);
	await git(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "add", "."]);
	await git(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "fixture"]);
	const ref = (await git(repo, ["rev-parse", "HEAD"])).trim();

	// Uncommitted change that must NOT leak into the manifest.
	await writeFile(join(repo, "driver.mjs"), "export const ROOT = 'dirty-worktree';\n", "utf8");
	return { repo, ref, committedDriver };
}

describe("S1 export tooling (fixture repos only)", () => {
	it("resolves a ref to a full commit sha", async () => {
		const { repo, ref } = await createFixtureRepo();
		expect(await resolveCommit(repo, "HEAD")).toBe(ref);
		await expect(resolveCommit(repo, "no-such-ref")).rejects.toBeInstanceOf(ExportSourceError);
	});

	it("exports only scoped files from the committed ref and ignores dirty worktree changes", async () => {
		const { repo, ref, committedDriver } = await createFixtureRepo();
		const manifest = await buildSourceManifest(repo, ref, "code", {
			write: false,
			generatedAt: "2026-09-02T00:00:00.000Z",
		});

		const paths = manifest.files.map((f) => f.path);
		expect(paths).toContain("driver.mjs");
		expect(paths).toContain("config.mjs");
		expect(paths).toContain("tools/run.mjs");
		expect(paths).toContain("tools/Helper.java");
		expect(paths).toContain("probes/P.java");
		expect(paths).toContain("runtime/R.java");
		expect(paths).not.toContain("SKILL.md");
		expect(paths.some((p) => p.startsWith("docs/"))).toBe(false);
		expect(paths.some((p) => p.startsWith("reference/"))).toBe(false);

		// The dirty worktree copy of driver.mjs says 'dirty-worktree'; the export
		// must hash the committed blob instead.
		const driver = manifest.files.find((f) => f.path === "driver.mjs");
		expect(driver).toBeDefined();
		const content = await readFile(join(repo, "driver.mjs"), "utf8");
		expect(content).not.toBe(committedDriver);
		expect(await sha256OfString(committedDriver)).toBe(driver?.sha256);
		expect(driver?.lines).toBe(1);
	});

	it("records top-level dispositions and never drops unclassified entries silently", async () => {
		const { repo, ref } = await createFixtureRepo();
		const manifest = await buildSourceManifest(repo, ref, "code", { write: false });
		const byName = Object.fromEntries(manifest.topLevelDispositions.map((d) => [d.name, d.disposition]));
		expect(byName["driver.mjs"]).toBe("code");
		expect(byName.tools).toBe("code");
		expect(byName["SKILL.md"]).toBe("excluded");
		expect(byName.docs).toBe("excluded");
		expect(byName["README.md"]).toBe("excluded");
		// Directories owned by another kind are attributed to it, not reported as
		// open questions -- otherwise a real unclassified entry gets buried.
		expect(byName.reference).toBe("knowledge");
		expect(byName.protocol).toBe("protocol");
		expect(manifest.unclassified).toEqual([]);
	});

	it("flags a genuinely unclassified top-level entry", async () => {
		const { repo } = await createFixtureRepo();
		await writeFile(join(repo, "surprise.mjs"), "export const x = 1;\n", "utf8");
		await git(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "add", "surprise.mjs"]);
		await git(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "new top-level"]);
		const ref = (await git(repo, ["rev-parse", "HEAD"])).trim();
		const manifest = await buildSourceManifest(repo, ref, "code", { write: false });
		expect(manifest.unclassified).toEqual(["surprise.mjs"]);
		expect(manifest.files.map((f) => f.path)).not.toContain("surprise.mjs");
	});

	it("protocol manifest freezes protocol/ as the S6 input", async () => {
		const { repo, ref } = await createFixtureRepo();
		const manifest = await buildSourceManifest(repo, ref, "protocol", { write: false });
		expect(manifest.scope).toEqual(PROTOCOL_SCOPE);
		expect(manifest.files.map((f) => f.path)).toEqual(["protocol/z.json"]);
		expect(manifest.unclassified).toEqual([]);
		const byName = Object.fromEntries(manifest.topLevelDispositions.map((d) => [d.name, d.disposition]));
		expect(byName["driver.mjs"]).toBe("code");
		expect(byName.reference).toBe("knowledge");
	});

	it("knowledge manifest covers reference/ only", async () => {
		const { repo, ref } = await createFixtureRepo();
		const manifest = await buildSourceManifest(repo, ref, "knowledge", { write: false });
		expect(manifest.scope).toEqual(KNOWLEDGE_SCOPE);
		expect(manifest.files.map((f) => f.path)).toEqual(["reference/probes.md"]);
		expect(manifest.files[0]?.lines).toBe(3);
		expect(manifest.unclassified).toEqual([]);
	});

	it("is deterministic and byte-reproducible for the same ref", async () => {
		const { repo, ref } = await createFixtureRepo();
		const a = await buildSourceManifest(repo, ref, "code", { write: false, generatedAt: "fixed" });
		const b = await buildSourceManifest(repo, ref, "code", { write: false, generatedAt: "fixed" });
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
	});

	it("materializes the export tree on demand, identical to the committed blobs", async () => {
		const { repo, ref } = await createFixtureRepo();
		const outTree = join(tempRoot(), "out-tree");
		await buildSourceManifest(repo, ref, "code", { write: false, outTree });
		const exported = await readFile(join(outTree, "driver.mjs"), "utf8");
		expect(exported).toContain("committed");
		expect(exported).not.toContain("dirty-worktree");
	});

	it("writes manifests only with a confirmation record; dry-run never writes", async () => {
		const { repo, ref } = await createFixtureRepo();
		const outDir = join(tempRoot(), "manifests");

		await expect(buildSourceManifest(repo, ref, "code", { write: true })).rejects.toBeInstanceOf(ExportSourceError);

		const dry = await buildSourceManifest(repo, ref, "code", { write: false, generatedAt: "fixed" });
		expect(dry.confirmation.note).toContain("not confirmed");

		const manifest = await buildSourceManifest(repo, ref, "code", {
			write: true,
			generatedAt: "fixed",
			confirmation: { confirmedBy: "Lige", confirmedAt: "2026-09-02T09:00:00.000Z", note: "fixture confirmation" },
		});
		const path = await writeManifest(manifest, outDir);
		const written = JSON.parse(await readFile(path, "utf8")) as SourceManifest;
		expect(written.confirmation.confirmedBy).toBe("Lige");
		expect(written.source.resolvedCommit).toBe(ref);
		expect(written.totals.files).toBe(manifest.totals.files);
	});

	it("does not mutate the source repo (HEAD and status unchanged, no stray git files)", async () => {
		const { repo, ref } = await createFixtureRepo();
		const before = {
			head: await git(repo, ["rev-parse", "HEAD"]),
			status: await git(repo, ["status", "--porcelain"]),
			objects: (await git(repo, ["count-objects", "-v"])).trim(),
		};
		await buildSourceManifest(repo, ref, "code", { write: false, outTree: join(tempRoot(), "tree-readonly") });
		const after = {
			head: await git(repo, ["rev-parse", "HEAD"]),
			status: await git(repo, ["status", "--porcelain"]),
			objects: (await git(repo, ["count-objects", "-v"])).trim(),
		};
		expect(after.head).toBe(before.head);
		expect(after.status).toBe(before.status);
		expect(after.objects).toBe(before.objects);
	});

	it("declares the 5.1 scopes", () => {
		expect(CODE_SCOPE).toContain("driver.mjs");
		expect(CODE_SCOPE).toContain("config.mjs");
		expect(CODE_SCOPE).toContain("tools");
		expect(CODE_SCOPE).toContain("probes");
		expect(CODE_SCOPE).toContain("runtime");
		expect(EXCLUDED_TOP_LEVEL).toContain("docs");
		expect(EXCLUDED_TOP_LEVEL).toContain("SKILL.md");
	});
});

async function sha256OfString(text: string): Promise<string> {
	return createHash("sha256").update(text, "utf8").digest("hex");
}
