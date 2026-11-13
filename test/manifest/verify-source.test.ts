import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { buildSourceManifest, type SourceManifest, writeManifest } from "../../src/manifest/export-source.ts";
import { verifySourceManifest } from "../../src/manifest/verify-source.ts";

const run = promisify(execFile);
const tempRoots: string[] = [];

function tempRoot(): string {
	const dir = mkdtempSync(join(tmpdir(), "cosmic-verify-"));
	tempRoots.push(dir);
	return dir;
}

afterAll(() => {
	for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
});

// Reuse the fixture shape from the export tests via a local minimal builder.
async function createFixtureRepo(): Promise<{ repo: string; ref: string }> {
	const repo = join(tempRoot(), "fixture-src");
	await mkdir(join(repo, "tools"), { recursive: true });
	await mkdir(join(repo, "probes"), { recursive: true });
	await mkdir(join(repo, "reference"), { recursive: true });
	await writeFile(join(repo, "driver.mjs"), "export const ROOT = 'committed';\n", "utf8");
	await writeFile(join(repo, "config.mjs"), "export const CFG = 1;\n", "utf8");
	await writeFile(join(repo, "tools", "run.mjs"), "export const tool = 'a';\n", "utf8");
	await writeFile(join(repo, "probes", "P.java"), "class P {}\n", "utf8");
	await writeFile(join(repo, "reference", "probes.md"), "# probes\n\nbody line\n", "utf8");
	await run("git", ["init", "-b", "main"], { cwd: repo });
	await run("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "."], { cwd: repo });
	await run("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "fixture"], { cwd: repo });
	const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" });
	return { repo, ref: stdout.trim() };
}

async function sha256File(path: string): Promise<string> {
	return createHash("sha256")
		.update(await readFile(path, "utf8"), "utf8")
		.digest("hex");
}

describe("S1.4 manifest verification (fixture repos only)", () => {
	it("verifies a freshly written manifest as reproducible with the repo untouched", async () => {
		const { repo, ref } = await createFixtureRepo();
		const outDir = join(tempRoot(), "manifests");
		const manifest = await buildSourceManifest(repo, ref, "code", {
			write: true,
			generatedAt: "2026-09-02T00:00:00.000Z",
			confirmation: { confirmedBy: "Lige", confirmedAt: "2026-09-02T09:00:00.000Z", note: "fixture" },
		});
		const path = await writeManifest(manifest, outDir);

		const result = await verifySourceManifest(repo, path);
		expect(result.ok).toBe(true);
		expect(result.byteIdentical).toBe(true);
		expect(result.failures).toEqual([]);
		expect(result.ref).toBe(ref);
		expect(result.repoReadonly.headBefore).toBe(result.repoReadonly.headAfter);
		expect(result.repoReadonly.statusBefore).toBe(result.repoReadonly.statusAfter);
		expect(result.kind).toBe("code");
	});

	it("detects a tampered manifest (hash or ref altered) as not reproducible", async () => {
		const { repo, ref } = await createFixtureRepo();
		const outDir = join(tempRoot(), "manifests");
		const manifest = await buildSourceManifest(repo, ref, "code", {
			write: true,
			generatedAt: "fixed",
			confirmation: { confirmedBy: "Lige", confirmedAt: "2026-09-02T09:00:00.000Z", note: "fixture" },
		});
		const path = await writeManifest(manifest, outDir);

		const tampered = JSON.parse(await readFile(path, "utf8")) as SourceManifest;
		tampered.files[0]!.sha256 = "0".repeat(64);
		const tamperedPath = join(outDir, "code-source.tampered.json");
		await writeFile(tamperedPath, JSON.stringify(tampered, null, 2), "utf8");

		const result = await verifySourceManifest(repo, tamperedPath);
		expect(result.ok).toBe(false);
		expect(result.byteIdentical).toBe(false);
		expect(result.failures.join("\n")).toContain("differs from the recorded manifest");

		// A manifest pointing at a ref that no longer resolves must fail cleanly.
		const badRef = JSON.parse(await readFile(path, "utf8")) as SourceManifest;
		badRef.source.ref = "no-such-ref-xyz";
		const badPath = join(outDir, "code-source.badref.json");
		await writeFile(badPath, JSON.stringify(badRef, null, 2), "utf8");
		const badResult = await verifySourceManifest(repo, badPath);
		expect(badResult.ok).toBe(false);
		expect(badResult.failures.join("\n")).toContain("rebuild failed");
	});

	it("rejects files that are not cosmic source manifests", async () => {
		const { repo } = await createFixtureRepo();
		const junk = join(tempRoot(), "junk.json");
		await writeFile(junk, "{}\n", "utf8");
		await expect(verifySourceManifest(repo, junk)).rejects.toThrow(/cannot read manifest/);
		expect(await sha256File(junk)).toBe(createHash("sha256").update("{}\n", "utf8").digest("hex"));
	});
});
