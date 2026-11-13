/**
 * Where a probe run's output is kept after the call returns (S5.2).
 *
 * Two files, both under the RuntimeKey cache, both rewritten on every run:
 *
 *   last-probe.json  the `[PROBE-JSON]` bypass records
 *   last-probe.out   the complete raw output
 *
 * plus one more that is NOT rewritten:
 *
 *   probe-runs/<时间>-<探针>.out   the same raw output, one file per run
 *
 * **Rewritten even when there is nothing to write.** Leaving the previous file
 * in place is how a later reader ends up treating some other probe's records as
 * this run's result -- the frozen driver hit exactly that and had to compare
 * mtimes to defend against it.
 *
 * The raw copy exists because a cold `run op` is ~80 seconds and the usual
 * reason to re-run one is to look at a different field. That was measured on the
 * real machine: the same command run twice, only to change `tail -18` into
 * `grep -E`, cost 89 seconds for nothing. With the stash it is a free local
 * read.
 *
 * 每次一份的副本（2026-09-15 AddFieldProbe 复盘 §3.6）：返回里「完整输出 → 某文件」
 * 以前指的是 `last-probe.out`，读起来像「全文替你存好了」，其实下一次任何探针一跑就被盖掉。
 * 真机上两次写探针失败的逐项原因，几十分钟后写复盘时已经取不回来——证据寿命由后面
 * 无关的调用决定。现在返回里给的是这一次自己的那份，`last-probe.out` 只留作「最近一次」的
 * 固定入口。副本只留最近 `KEEP_RUNS` 份，免得常驻会话把缓存目录越撑越大。
 */

import { join } from "node:path";
import type { KernelContext } from "../context.ts";
import { collectJsonRecords, type ProbeJsonRecord } from "./output.ts";

/** 每次一份的副本留几份。够一轮复盘回头核对，又不至于无限增长。 */
export const KEEP_RUNS = 40;

export interface ProbeEvidence {
	records: ProbeJsonRecord[];
	broken: string[];
	/** The bypass file for this run. */
	jsonFile: string;
	/** The complete raw output for this run -- this run's own copy when it could be written. */
	outFile: string;
}

export interface StashContext {
	cls: string | null;
	src: string | null;
	/** What produced this run, in one line -- the probe name or the run command. */
	invocation: string;
}

export function stashProbeOutput(ctx: KernelContext, about: StashContext, out: string): ProbeEvidence {
	const { records, broken } = collectJsonRecords(out);
	const at = new Date(ctx.ports.clock.now()).toISOString();
	const { fs } = ctx.ports;
	const jsonFile = ctx.layout.lastProbeJson;
	const raw = `# ${at}  ${about.cls ?? "?"}\n# ${about.invocation}\n${out}`;

	fs.write(
		jsonFile,
		`${JSON.stringify({ probe: about.cls, src: about.src, at, invocation: about.invocation, records, broken }, null, 2)}\n`,
	);
	// A stash failure must not take down a probe that actually ran, so the raw
	// copy is best effort -- unlike the bypass file, nothing grades on it.
	let outFile = ctx.layout.lastProbeOut;
	try {
		fs.write(ctx.layout.lastProbeOut, raw);
	} catch {
		// Keep the run's result; the caller still has `output` in hand.
	}
	try {
		outFile = archiveRun(ctx, at, about.cls, raw);
	} catch {
		// 副本没存下来就退回 last-probe.out：至少这一刻它还是这次的原文。
	}
	return { records, broken, jsonFile, outFile };
}

function archiveRun(ctx: KernelContext, at: string, cls: string | null, raw: string): string {
	const { fs } = ctx.ports;
	const dir = ctx.layout.probeRuns;
	fs.mkdirp(dir);
	// ISO 时间换掉冒号和点就能直接当文件名，而且按名字排序就是按时间排序。
	const stem = `${at.replace(/[:.]/g, "-")}-${(cls ?? "probe").replace(/[^\w$-]/g, "_")}`;
	let file = join(dir, `${stem}.out`);
	for (let n = 2; fs.exists(file); n++) file = join(dir, `${stem}-${String(n)}.out`);
	fs.write(file, raw);

	const runs = fs
		.readDir(dir)
		.filter((entry) => !entry.isDirectory && entry.name.endsWith(".out"))
		.map((entry) => entry.name)
		.sort();
	for (const name of runs.slice(0, Math.max(0, runs.length - KEEP_RUNS))) {
		try {
			fs.remove(join(dir, name));
		} catch {
			// 清不掉旧的不影响这一次。
		}
	}
	return file;
}
