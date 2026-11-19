// fast-ai-cosmic S0.4 verification: run the compiled spike binary from an empty
// directory with a PATH that contains no Node/Bun, and prove the embedded probe
// resource is released intact. Run from cosmic/: node scripts/verify-empty-dir.mjs
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import process from "node:process";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
if (typeof packageJson.name !== "string" || packageJson.name === "") throw new Error("package.json name is required");
const artifactBase = `${packageJson.name}-spike`;
const exePath = resolve(process.platform === "win32" ? `dist/spike/${artifactBase}.exe` : `dist/spike/${artifactBase}`);
if (!existsSync(exePath)) {
	console.error(`missing binary: ${exePath}. Run node scripts/build.mjs first.`);
	process.exit(1);
}

const emptyDir = mkdtempSync(join(tmpdir(), "cosmic-empty-"));
const exeCopy = join(emptyDir, basename(exePath));
copyFileSync(exePath, exeCopy);

// PATH restricted to System32: no node, no bun, no repo tooling on PATH.
const env = {
	SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
	WINDIR: process.env.WINDIR ?? "C:\\Windows",
	TEMP: process.env.TEMP ?? emptyDir,
	TMP: process.env.TMP ?? emptyDir,
	PATH: "C:\\Windows\\System32",
};

const run = spawnSync(exeCopy, {
	cwd: emptyDir,
	env,
	encoding: "utf8",
	timeout: 60_000,
});

let failed = false;
const failures = [];
if (run.error) {
	failures.push(`spawn error: ${run.error.message}`);
	failed = true;
} else if (run.status !== 0) {
	failures.push(`exit code: ${run.status}\nstdout: ${run.stdout}\nstderr: ${run.stderr}`);
	failed = true;
}

let output;
if (!failed) {
	try {
		output = JSON.parse(run.stdout);
	} catch {
		failures.push(`stdout is not JSON:\n${run.stdout}\nstderr: ${run.stderr}`);
		failed = true;
	}
}

if (output) {
	const releasedPath = join(output.cacheDir, "probes", "SpikeProbe.java");
	if (!existsSync(releasedPath)) {
		failures.push(`released file missing: ${releasedPath}`);
		failed = true;
	} else {
		const source = readFileSync(resolve("resources/probes/SpikeProbe.java"), "utf8");
		const sourceHash = createHash("sha256").update(source, "utf8").digest("hex");
		const releasedHash = createHash("sha256").update(readFileSync(releasedPath, "utf8"), "utf8").digest("hex");
		if (sourceHash !== releasedHash) {
			failures.push(`hash mismatch: source ${sourceHash} vs released ${releasedHash}`);
			failed = true;
		}
		if (output.hashes["probes/SpikeProbe.java"] !== sourceHash) {
			failures.push("reported hash does not match source hash");
			failed = true;
		}
	}
}

const verdict = {
	binary: exePath,
	emptyDir,
	releasedTo: output?.cacheDir ?? null,
	cacheKey: output?.cacheKey ?? null,
	nodeOnPath: false,
	pathEnv: env.PATH,
	verdict: failed ? "FAIL" : "PASS",
	failures,
};

console.log(JSON.stringify(verdict, null, 3));
rmSync(emptyDir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
