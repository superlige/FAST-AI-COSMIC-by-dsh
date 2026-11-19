import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const temporary: string[] = [];
const cli = new URL("../../scripts/analyze-session.mjs", import.meta.url);
const at = (s: number) => new Date(Date.UTC(2026, 8, 21, 0, 0, s)).toISOString();
const user = (s = 0) => ({
	type: "message",
	timestamp: at(s),
	message: { role: "user", content: [{ type: "text", text: "任务" }] },
});
function call(id: number, tool: string, args: object, response: object | string = { ok: true }, failed = false) {
	return [
		{
			type: "message",
			timestamp: at(id * 2),
			message: { role: "assistant", content: [{ type: "toolCall", id: `c${id}`, name: tool, arguments: args }] },
		},
		{
			type: "message",
			timestamp: at(id * 2 + 1),
			message: {
				role: "toolResult",
				toolCallId: `c${id}`,
				toolName: tool,
				isError: failed,
				content: [{ type: "text", text: typeof response === "string" ? response : JSON.stringify(response) }],
			},
		},
	] as const;
}
function fixture(records: unknown[], suffix = "") {
	const dir = mkdtempSync(join(tmpdir(), "cosmic-session-test-"));
	temporary.push(dir);
	const file = join(dir, "2026-09-21_sample.jsonl");
	writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + suffix);
	return { file, dir };
}
function analyze(records: unknown[], suffix = "") {
	const { file } = fixture(records, suffix);
	return JSON.parse(
		execFileSync(process.execPath, [fileURLToPath(cli), "--json", "--metrics-only", file], {
			encoding: "utf8",
		}),
	);
}
afterEach(() => {
	for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("session detour measurement CLI", () => {
	it("counts exact UTF-8 lines above 40 bytes, across tools but never across sessions", () => {
		const line = "中".repeat(14),
			short = "a".repeat(40);
		const r = analyze([
			user(),
			...call(1, "read", {}, `${line}\r\n${short}\r\n${line}`),
			{ type: "compaction" },
			...call(2, "bash", {}, `${line}\n ${line}\n${short}`),
		]);
		expect(r.metrics.intake.total.repeatedBytes).toBe(84);
		expect(r.metrics.intake.total.withinResultBytes).toBe(42);
		expect(r.metrics.intake.byTool.bash.repeatedBytes).toBe(42);
		expect(r.metrics.intake.total.eligibleBytes).toBe(169);
		expect(r.metrics.intake.compactions).toBe(1);
		expect(analyze([user(), ...call(1, "read", {}, line)]).metrics.intake.total.repeatedBytes).toBe(0);
	});
	it("partitions reminder fields without double counting nested usage and reports unparsed prose", () => {
		const notes = { usage: "中文", next: "原样" };
		const r = analyze([
			user(),
			...call(1, "cosmic_probe", {}, { notes, result: { usage: "帮助" }, outputBudget: { remedy: "提示" } }),
			...call(2, "cosmic_probe", {}, "plain response"),
			...call(3, "read", {}, { notes }),
		]);
		expect(r.metrics.intake.prompt.fields.notes).toBe(Buffer.byteLength(JSON.stringify(notes)));
		expect(r.metrics.intake.prompt.fields.usage).toBe(Buffer.byteLength(JSON.stringify("帮助")));
		expect(r.metrics.intake.prompt.unparsedCosmicBytes).toBe(14);
		expect(r.metrics.intake.resident).toEqual({ system: null, tools: null, skills: null });
		const capsule = "# Knowledge Capsule\n\n## Knowledge Capsule · probe-api\n要点：实际渲染文字";
		expect(analyze([user(), ...call(1, "cosmic_probe", {}, capsule)]).metrics.intake.prompt.fields.capsule).toBe(
			Buffer.byteLength(capsule),
		);
	});
	it("does not count temporary probes, failed edits, help or bare runs as progress", () => {
		const r = analyze([
			user(),
			...call(1, "write", { path: ".cosmic-ai/probes/Check.java", content: "class Check {}" }),
			...call(2, "edit", { path: "src/Business.java" }, "Could not find text", true),
			...call(3, "cosmic_run", { argv: ["help", "print"] }),
			...call(4, "cosmic_run", { argv: ["print", "template"] }),
			...call(5, "cosmic_run", { argv: ["print", "template", "--expect", "cell=甲"] }),
			...call(6, "edit", { path: "src/Business.java", newText: "// .cosmic-ai/probes/name.java" }),
		]);
		expect(r.metrics.firstProgress).toEqual({ seq: 5, elapsedMs: 10000 });
		expect(r.metrics.firstAction.seq).toBe(6);
		expect(r.metrics.longestNoProgress.calls).toBe(4);
		expect(r.metrics.counts).toMatchObject({ inspect: 1, failure: 1, help: 1, verify: 2, action: 1 });
	});
	it("measures elapsed time from user request, splits at user turns, and treats missing returns as unknown", () => {
		const r = analyze(
			[
				{ type: "session", timestamp: at(-600) },
				user(),
				...call(1, "read", { path: "src/A.java" }),
				user(4),
				...call(3, "read", { path: "src/B.java" }),
				call(4, "edit", { path: "src/B.java" })[0],
				...call(5, "ask_question", { question: "A or B?" }),
			],
			'\n{"type":',
		);
		expect(r.broken).toBe(1);
		expect(r.metrics.firstProgress.elapsedMs).toBe(10000);
		expect(r.metrics.longestNoProgress.calls).toBe(2);
		expect(r.metrics.missingResults).toEqual([3]);
	});
	it("does not mistake source literals for failures or unrelated success for recovery", () => {
		const r = analyze([
			user(),
			...call(1, "read", { path: "x.java" }, 'code example: {"ok":false}'),
			...call(2, "cosmic_run", { argv: ["print", "one"] }, { ok: false, error: { code: "BAD" } }),
			...call(3, "cosmic_run", { argv: ["print", "two"] }),
			...call(4, "cosmic_run", { argv: ["print", "one", "--show", "cell"] }),
			...call(5, "cosmic_run", { argv: ["print", "one"] }, { ok: false, error: { code: "BAD" } }),
			user(11),
			...call(6, "cosmic_run", { argv: ["print", "one"] }),
		]);
		expect(r.metrics.counts.failure).toBe(2);
		expect(r.metrics.recovery).toMatchObject([
			{ seq: 2, recoveredAt: 4, callsUntilSuccess: 2 },
			{ seq: 5, recoveredAt: null },
		]);
	});
	it("classifies Windows and shell reads while excluding a candidate edit from internal reads", () => {
		const r = analyze([
			user(),
			...call(1, "read", { path: "C:\\Users\\test\\.fast-ai-cosmic\\cache\\v1\\resources\\probes\\A.java" }, "中文"),
			...call(2, "bash", {
				command: "cd .cosmic-ai/work && python -c \"import json; print(json.load(open('candidate.json')))\"",
			}),
			...call(3, "cosmic_meta", {
				argv: ["ptpl", "edit", ".cosmic-ai/work/candidate", "--formula", "cell", "--line", "<value>"],
			}),
			...call(4, "read", { path: "src/A.java", limit: 20 }),
			...call(5, "bash", { command: "grep -n value src/A.java" }),
			...call(6, "bash", { command: "find . -name '*.java'" }),
		]);
		expect(r.metrics.internalReads).toBe(2);
		expect(r.metrics.pythonJsonReads).toBe(1);
		expect(r.metrics.reads.cache.bytes).toBe(6);
		expect(r.metrics.reads["java-range"].calls).toBe(1);
		expect(r.metrics.broadSearches).toBe(1);
		expect(r.metrics.firstAction.seq).toBe(3);
	});
	it("counts rereads of tool-written files apart from reference reads, including python that also writes", () => {
		const cache = "C:/Users/test/.fast-ai-cosmic/cache/v1";
		const r = analyze([
			user(),
			...call(1, "bash", { command: `cd "${cache}/probe-runs" && sed -n '1,20p' a-PrintSim.out | cat -A` }, "12345"),
			...call(2, "bash", {
				command:
					"cd /d/p/outputs/print-tpl-json && python - <<'EOF'\nimport json\njson.load(open('a.meta.json'))\nEOF",
			}),
			...call(3, "bash", {
				command:
					"python - <<'EOF'\nd=open('outputs/print-tpl-json/a.meta.json').read()\nopen('.cosmic-ai/work/c/a.meta.json','w')\nEOF",
			}),
			...call(4, "bash", {
				command: 'grep -n x "D:/p/.cosmic-ai/work/out/cosmic_probe-3.out" >/dev/null; echo ok >/dev/null',
			}),
			...call(5, "read", { path: "C:\\Users\\test\\.fast-ai-cosmic\\cache\\reference\\abc\\skills\\x\\SKILL.md" }),
			...call(6, "cosmic_probe", { name: "A" }, "中文"),
		]);
		expect(r.metrics.toolOutputReads).toMatchObject({ calls: 4, python: 2, showControl: 1, withWrite: 1 });
		expect(r.metrics.toolOutputReads.sequences).toEqual([1, 2, 3, 4]);
		expect(r.metrics.reads["probe-run"].bytes).toBe(5);
		expect(r.metrics.reads.export.calls).toBe(1);
		expect(r.metrics.reads["run-output"].calls).toBe(1);
		expect(r.metrics.reads.reference.calls).toBe(1);
		expect(r.metrics.cosmicByTool.cosmic_probe).toEqual({ calls: 1, bytes: 6 });
	});
	it("breaks a no-progress run into kinds without changing the progress count", () => {
		const cache = "C:/Users/test/.fast-ai-cosmic/cache/v1";
		const failed = { ok: false, error: { code: "PROBE_FAILED" } };
		const r = analyze([
			user(),
			...call(1, "cosmic_meta", { argv: ["ptpl", "dump", "tpl", "--out", ".cosmic-ai/work/tpl"] }),
			...call(2, "bash", { command: "cd /d/p/.cosmic-ai/work/tpl && python -c 'import json'" }),
			...call(3, "bash", { command: "ls /d/p/.cosmic-ai/work/old" }),
			...call(4, "bash", { command: `sed -n 1,80p "${cache}/resources/probes/PrintSim.java"` }),
			...call(5, "bash", { command: "cd D:/claudecode/pi/cosmic && grep -n skip src/kernel/commands/run.ts" }),
			...call(6, "bash", { command: "javap -cp bos-print.jar kd.bos.print.X" }),
			...call(7, "write", { path: ".cosmic-ai/probes/Check.java" }),
			...call(8, "cosmic_probe", { name: ".cosmic-ai/probes/Check.java" }),
			...call(9, "cosmic_probe", { name: "DataQueryProbe", env: { QUERY_ENTITY: "a" } }, failed),
			...call(10, "cosmic_probe", { name: "DataQueryProbe", env: { QUERY_ENTITY: "a", QUERY_WHERE: "x" } }, failed),
			...call(11, "read", { path: "src/A.java" }),
			...call(12, "read", { path: "src/A.java" }),
			...call(13, "cosmic_run", { argv: ["help", "print"] }),
			...call(14, "cosmic_run", { argv: ["print", "tpl"] }),
			...call(15, "cosmic_probe", { name: "MetaProbe" }, { ok: false, error: { code: "STALE_CLASSES" } }),
			...call(16, "cosmic_run", { argv: ["print", "tpl", "--expect", "a=1"] }),
			...call(17, "read", { path: "src/A.java" }),
		]);
		expect(r.metrics.longestNoProgress.calls).toBe(15);
		expect(r.metrics.stall.version).toBe("s36-stall-v1");
		expect(r.metrics.stall.runs).toEqual([
			expect.objectContaining({
				from: 1,
				to: 15,
				calls: 15,
				kinds: expect.objectContaining({
					investigate: 2,
					toolOutput: 1,
					history: 1,
					internals: 2,
					platformJar: 1,
					auxiliary: 2,
					failure: 1,
					retry: 1,
					repeat: 1,
					reference: 1,
					verify: 1,
					wait: 1,
				}),
			}),
		]);
		// A progress call has no kind, and after it the same read is a fresh look, not a repeat.
		expect(r.metrics.stall.kinds.investigate).toBe(3);
		expect(r.metrics.stall.kinds.repeat).toBe(1);
	});
	it("partitions UTF-8 payload exactly once and records weighted cache hit rate per model call", () => {
		const payload = {
			ok: true,
			result: {
				text: "中文",
				src: "C:\\test\\.fast-ai-cosmic\\cache\\A.java",
				outputBudget: { remedy: "中文" },
				notes: ["注释"],
			},
		};
		const usage = { input: 10, cacheRead: 20, cacheWrite: 5, output: 7 };
		const r = analyze([
			user(),
			{ type: "message", timestamp: at(1), message: { role: "assistant", content: [], usage } },
			...call(1, "cosmic_probe", { name: "A" }, payload),
		]);
		expect(Object.values(r.metrics.cosmic).reduce((a: number, b) => a + Number(b), 0)).toBe(
			Buffer.byteLength(JSON.stringify(payload)),
		);
		expect(r.metrics.cosmic.notes).toBe(Buffer.byteLength(JSON.stringify(payload.result.notes)));
		expect(r.metrics.modelUsage.cacheHitRate).toBeCloseTo(20 / 35);
		expect(r.metrics.modelUsage.peakContextTokens).toBe(42);
		const partial = analyze([
			user(),
			{ type: "message", timestamp: at(1), message: { role: "assistant", content: [], usage: { input: 10 } } },
		]);
		expect(partial.metrics.modelUsage.peakContextTokens).toBeNull();
	});
	it("supports reproducible directory selection and rejects ambiguous or invalid CLI options", () => {
		const { file, dir } = fixture([user(), ...call(1, "read", { path: "src/A.java" })]);
		writeFileSync(join(dir, "2026-09-20_old.jsonl"), "{}\n");
		const cliPath = fileURLToPath(cli);
		const output = execFileSync(
			process.execPath,
			[
				cliPath,
				"--dir",
				dir,
				"--from",
				"2026-09-21",
				"--to",
				"2026-09-21",
				"--min-bytes",
				"100",
				"--json",
				"--metrics-only",
			],
			{ encoding: "utf8" },
		);
		expect(JSON.parse(output).file).toBe(file);
		for (const args of [["--top", "NaN", file], ["--call"], ["--unknown"], ["--dir", dir, file]]) {
			expect(spawnSync(process.execPath, [cliPath, ...args]).status).toBe(2);
		}
	});
	it("keeps literal JSON reads successful and labels inferred failures as observed buckets", () => {
		const r = analyze([
			user(),
			...call(1, "read", { path: "fixture.json" }, '{"ok":false}'),
			...call(
				2,
				"cosmic_run",
				{ argv: ["print", "one"] },
				"[PROBE-ERR] java.lang.IllegalStateException: 断言失败",
				true,
			),
			...call(3, "bash", { command: "grep absent src/A.java" }, "Command exited with code 1", true),
		]);
		expect(r.metrics.counts.failure).toBe(2);
		expect(Object.keys(r.metrics.failures)).toEqual(["OBSERVED_ASSERTION", "OBSERVED_SHELL_EXIT"]);
	});
	it("does not match a concurrently dispatched success before the failure returned", () => {
		const first = call(1, "cosmic_run", { argv: ["print", "one"] }, { ok: false });
		const r = analyze([
			user(),
			first[0],
			...call(2, "cosmic_run", { argv: ["print", "one"] }),
			{ ...first[1], timestamp: at(10) },
		]);
		expect(r.metrics.recovery[0].recoveredAt).toBeNull();
	});
	it("aggregates selected sessions, preserving null progress and unknown usage", () => {
		const sameLine = "跨会话相同内容也不算重复".repeat(4);
		const { dir, file } = fixture([user(), ...call(1, "read", { path: "src/A.java" }, sameLine)]);
		writeFileSync(
			join(dir, "2026-09-21_second.jsonl"),
			[user(), ...call(1, "ask_question", {}, sameLine)].map((r) => JSON.stringify(r)).join("\n"),
		);
		const r = JSON.parse(
			execFileSync(process.execPath, [fileURLToPath(cli), "--dir", dir, "--json", "--metrics-only"], {
				encoding: "utf8",
			}),
		);
		expect(r.summary).toMatchObject({
			sessions: 2,
			calls: 2,
			counts: { inspect: 1, question: 1 },
			medianFirstProgressMs: 2000,
		});
		expect(r.sessions.find((s: { file: string }) => s.file === file).metrics.firstProgress).toBeNull();
		expect(r.sessions[0].metrics.modelUsage.peakContextTokens).toBeNull();
		expect(r.summary.intake.total.repeatedBytes).toBe(0);
		expect(r.summary.intake.total.textBytes).toBe(Buffer.byteLength(sameLine) * 2);
	});
});
