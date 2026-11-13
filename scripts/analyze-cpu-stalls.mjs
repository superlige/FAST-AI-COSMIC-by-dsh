/**
 * 尺子：从一份 CPU 采样里找出主线程被一口气占住的那几段，各自卡在哪段代码上。
 *
 *   node scripts/analyze-cpu-stalls.mjs <采样.cpuprofile…> [--min 200] [--top 12] [--json]
 *
 * 界面和工具跑在同一条主线程上：主线程连着忙 N 毫秒，界面就 N 毫秒不画帧、不收按键。
 * 采样怎么来：TUI 用 bun 从源码跑、带上 `--cpu-prof`（命令见 `docs/tui-blocking-diagnosis.md`），
 * 复现卡顿后正常退出，采样写在 `--cpu-prof-dir` 指的目录里。node 的 `--cpu-prof` 也认。
 *
 * 怎么算「连着忙」：bun 只在跑 JS 时记样本（每毫秒一个），闲着不记；node 闲着也记，但记成
 * `(idle)` / `(program)`。所以一段忙 = 一串非闲样本、相邻两个隔不到 `GAP_MS`。
 * 每段报：从几点几分开始（bun 的时间戳是墙上时间，能和会话记录对上；node 的不是，只报相对秒数）、
 * 忙了多久、本仓库和 pi 的哪些函数在这段里出现得最多（含子调用）、自己最耗时的是哪几个函数。
 *
 * 只读：只读采样文件。
 */

import { readFileSync } from "node:fs";

const GAP_MS = 20;
const IDLE = new Set(["(idle)", "(program)"]);

function parseArgs(argv) {
	const files = [];
	let min = 200;
	let top = 12;
	let json = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--min") min = Number(argv[++i]);
		else if (arg === "--top") top = Number(argv[++i]);
		else if (arg === "--json") json = true;
		else files.push(arg);
	}
	return { files, min, top, json };
}

function frameLabel(node) {
	const frame = node.callFrame;
	const url = String(frame.url ?? "")
		.replace(/\\/g, "/")
		.replace(/^file:\/\/\/?/, "");
	const tail = url.match(/(?:^|\/)(cosmic\/(?:src|scripts)\/.*|pi\/packages\/.*|node_modules\/.*)$/)?.[1] ?? url;
	return `${frame.functionName || "(匿名)"} @ ${tail || "(内置)"}:${frame.lineNumber + 1}`;
}

/** 本仓库或 pi 自己的代码：卡在哪，最后要落到这两处的函数上。 */
function ownCode(label) {
	return /@ (cosmic\/|pi\/packages\/)/.test(label);
}

function analyze(file, min, top) {
	const profile = JSON.parse(readFileSync(file, "utf8"));
	const byId = new Map(profile.nodes.map((node) => [node.id, node]));
	const parent = new Map();
	for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
	const labels = new Map(profile.nodes.map((node) => [node.id, frameLabel(node)]));
	const stackOf = (id) => {
		const out = [];
		for (let cur = id; cur !== undefined; cur = parent.get(cur)) out.push(cur);
		return out;
	};
	// bun 的 startTime 是墙上时间（微秒）；node 的是单调时钟，换不成钟点。
	const wallClock = profile.startTime > 1e15;
	const runs = [];
	let run = null;
	let t = profile.startTime;
	for (let i = 0; i < profile.samples.length; i++) {
		const delta = profile.timeDeltas[i] ?? 0;
		t += delta;
		const id = profile.samples[i];
		const idle = IDLE.has(byId.get(id)?.callFrame.functionName);
		if (run !== null && (idle || delta > GAP_MS * 1000)) {
			runs.push(run);
			run = null;
		}
		if (idle) continue;
		if (run === null) run = { start: t, end: t, samples: [] };
		run.end = t;
		run.samples.push(id);
	}
	if (run !== null) runs.push(run);
	const busy = runs
		.map((r) => ({ ...r, ms: (r.end - r.start) / 1000 }))
		.filter((r) => r.ms >= min)
		.map((r) => {
			const inclusive = new Map();
			const self = new Map();
			for (const id of r.samples) {
				const own = labels.get(id);
				self.set(own, (self.get(own) ?? 0) + 1);
				const seen = new Set();
				for (const frame of stackOf(id)) {
					const label = labels.get(frame);
					if (seen.has(label) || !ownCode(label)) continue;
					seen.add(label);
					inclusive.set(label, (inclusive.get(label) ?? 0) + 1);
				}
			}
			const share = (entries) =>
				[...entries]
					.sort((a, b) => b[1] - a[1])
					.slice(0, top)
					.map(([label, count]) => ({ label, percent: Math.round((count / r.samples.length) * 100) }));
			return {
				at: wallClock
					? new Date(r.start / 1000).toLocaleTimeString("zh-CN", { hour12: false })
					: `+${((r.start - profile.startTime) / 1e6).toFixed(1)}s`,
				ms: Math.round(r.ms),
				samples: r.samples.length,
				inclusive: share(inclusive),
				self: share(self),
			};
		});
	const durationS = (profile.endTime - profile.startTime) / 1e6;
	return { file, durationS: Math.round(durationS), runs: busy };
}

const { files, min, top, json } = parseArgs(process.argv.slice(2));
if (files.length === 0) {
	console.error("用法：analyze-cpu-stalls.mjs <采样.cpuprofile…> [--min 200] [--top 12] [--json]");
	process.exit(2);
}
const results = files.map((file) => analyze(file, min, top));
if (json) {
	console.log(JSON.stringify(results, null, 2));
} else {
	for (const result of results) {
		const longest = Math.max(0, ...result.runs.map((r) => r.ms));
		console.log(
			`${result.file}\n采样 ${String(result.durationS)} 秒，主线程连着忙超过 ${String(min)} 毫秒的 ${String(result.runs.length)} 段，最长 ${String(longest)} 毫秒`,
		);
		for (const r of [...result.runs].sort((a, b) => b.ms - a.ms)) {
			console.log(`\n== ${r.at} 起，连着忙 ${String(r.ms)} 毫秒`);
			console.log("  这段里出现最多的本仓库 / pi 函数（含子调用）：");
			for (const f of r.inclusive) console.log(`    ${String(f.percent).padStart(3)}%  ${f.label}`);
			console.log("  自己最耗时的函数：");
			for (const f of r.self.slice(0, 6)) console.log(`    ${String(f.percent).padStart(3)}%  ${f.label}`);
		}
	}
}
