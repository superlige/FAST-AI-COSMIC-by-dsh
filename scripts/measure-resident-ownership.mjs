/**
 * 尺子：常驻苍穹进程明明在跑，工具却认不出是自己的，于是每次运行都另起一个冷进程——这件事发生了几次、多花了多久。
 *
 *   node scripts/measure-resident-ownership.mjs <会话.jsonl…>
 *   node scripts/measure-resident-ownership.mjs --dir <会话目录> [--from 2026-09-25] [--show]
 *   node scripts/measure-resident-ownership.mjs --cache [缓存根]
 *
 * 会话部分：看每次 cosmic_probe / cosmic_run / cosmic_meta 的返回里写的是搭常驻进程（hot）还是另起冷进程（cold），
 * 冷进程按原因分开数；「常驻 JVM 归属存疑」那一类单列：几次、一共多久、每次中位多久，
 * 旁边给同一份会话里搭常驻进程的中位用时，差就是每次多等的。用时是 pi 记的工具自身用时。
 *
 * 缓存部分（`--cache`，默认 ~/.fast-ai-cosmic/cache）：逐个版本目录对两样东西——登记里写的进程号，
 * 和常驻进程自己在日志里报「就绪」时写的进程号。两个不一样，就是登记指着的不是占着端口的那个进程；
 * 同一份日志里出现两次「空闲超过 … 自动退出」，就是同一个版本同时起过两个。
 *
 * 只读：只读会话文件、登记和日志，不连环境、不动进程。口径和基线见 `docs/S58-resident-ownership.md` §2。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const TOOLS = new Set(["cosmic_run", "cosmic_probe", "cosmic_meta"]);
const UNOWNED = "常驻 JVM 归属存疑";
const args = process.argv.slice(2);
const files = [];
let dir = null;
let from = null;
let show = false;
let cache = null;
for (let i = 0; i < args.length; i++) {
	const arg = args[i];
	if (arg === "--dir") dir = args[++i];
	else if (arg === "--from") from = args[++i];
	else if (arg === "--show") show = true;
	else if (arg === "--cache")
		cache =
			args[i + 1] !== undefined && !args[i + 1].startsWith("--")
				? args[++i]
				: join(homedir(), ".fast-ai-cosmic", "cache");
	else files.push(arg);
}
if (dir !== null) {
	for (const name of readdirSync(dir).sort()) {
		if (!name.endsWith(".jsonl")) continue;
		if (from !== null && name.slice(0, 10) < from) continue;
		files.push(join(dir, name));
	}
}
if (files.length === 0 && cache === null) {
	console.error(
		"用法：measure-resident-ownership.mjs <会话.jsonl…> | --dir <会话目录> [--from 日期] [--show] | --cache [缓存根]",
	);
	process.exit(2);
}

const median = (values) =>
	values.length === 0 ? null : [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const seconds = (ms) => (ms === null ? "?" : (ms / 1000).toFixed(1));

function measureSession(file) {
	const hot = [];
	const coldByReason = new Map();
	const unowned = [];
	let statusUnknown = 0;
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (line === "") continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		const message = entry.message;
		if (message?.role !== "toolResult") continue;
		const text = (message.content ?? []).map((part) => part.text ?? "").join("");
		if (message.toolName === "cosmic_runtime" && /"ownership":"unknown"/.test(text)) statusUnknown++;
		if (!TOOLS.has(message.toolName)) continue;
		const path = /"path":"(hot|cold)"/.exec(text)?.[1];
		if (path === undefined) continue;
		const ms = typeof message.durationMs === "number" ? message.durationMs : null;
		if (path === "hot") {
			if (ms !== null) hot.push(ms);
			continue;
		}
		const reason = /"coldReason":"([^"]*)"/.exec(text)?.[1] ?? "（没写原因）";
		coldByReason.set(reason, (coldByReason.get(reason) ?? 0) + 1);
		if (reason === UNOWNED) unowned.push({ at: entry.timestamp ?? message.timestamp, tool: message.toolName, ms });
	}
	return { file, hot, coldByReason, unowned, statusUnknown };
}

if (files.length > 0) {
	const sessions = files.map(measureSession);
	const hit = sessions.filter((session) => session.unowned.length > 0);
	const allUnowned = hit.flatMap((session) => session.unowned);
	const timed = allUnowned.map((call) => call.ms).filter((ms) => ms !== null);
	const hotInHit = hit.flatMap((session) => session.hot);
	const coldTotal = new Map();
	for (const session of sessions)
		for (const [reason, count] of session.coldByReason) coldTotal.set(reason, (coldTotal.get(reason) ?? 0) + count);
	console.log(`${String(sessions.length)} 份会话`);
	console.log(
		`  搭常驻进程 ${String(sessions.reduce((sum, session) => sum + session.hot.length, 0))} 次；另起冷进程 ${String([...coldTotal.values()].reduce((sum, count) => sum + count, 0))} 次`,
	);
	for (const [reason, count] of [...coldTotal].sort((a, b) => b[1] - a[1]))
		console.log(`    ${String(count).padStart(4)} 次  ${reason}`);
	console.log(
		allUnowned.length === 0
			? `  其中「${UNOWNED}」：0 次`
			: `  其中「${UNOWNED}」：${String(hit.length)} 份会话、${String(allUnowned.length)} 次，一共 ${seconds(timed.reduce((sum, ms) => sum + ms, 0))} 秒，每次中位 ${seconds(median(timed))} 秒` +
					`（这几份会话里搭常驻进程的中位 ${seconds(median(hotInHit))} 秒）`,
	);
	for (const session of hit) {
		const name = session.file.split(/[\\/]/).pop();
		console.log(
			`    ${name}：${String(session.unowned.length)} 次，第一次 ${String(session.unowned[0]?.at ?? "?")}` +
				(session.statusUnknown > 0 ? `；查状态答「认不出归属」${String(session.statusUnknown)} 次` : ""),
		);
		if (show)
			for (const call of session.unowned)
				console.log(`      ${String(call.at)}  ${call.tool}  ${seconds(call.ms)} 秒`);
	}
}

if (cache !== null) {
	console.log(`缓存根 ${cache}`);
	let mismatched = 0;
	let doubled = 0;
	const names = existsSync(cache) ? readdirSync(cache).sort() : [];
	for (const name of names) {
		const logFile = join(cache, name, "probe-server.log");
		if (!existsSync(logFile)) continue;
		const log = readFileSync(logFile, "utf8");
		let recorded = null;
		try {
			recorded = JSON.parse(readFileSync(join(cache, name, "probe-server.pid"), "utf8")).pid ?? null;
		} catch {
			// 登记不在或者读不出来：只报日志里的
		}
		const ready = [...log.matchAll(/\[PSERVER\] 就绪 port=\d+ account=\S+ pid=(\d+)/g)].map((hit) => Number(hit[1]));
		const idleExits = (log.match(/\[PSERVER\] 空闲超过 \d+ 分钟，自动退出/g) ?? []).length;
		const wrong = recorded !== null && ready.length > 0 && !ready.includes(recorded);
		if (wrong) mismatched++;
		if (idleExits > 1) doubled++;
		if (wrong || idleExits > 1 || show)
			console.log(
				`  ${name}：登记 ${recorded === null ? "（没有）" : String(recorded)}，日志里就绪的 ${ready.length === 0 ? "（没有）" : ready.join("、")}，空闲退出 ${String(idleExits)} 次` +
					(wrong ? " ← 登记的不是占着端口的那个" : ""),
			);
	}
	console.log(
		`  登记和就绪的进程号对不上：${String(mismatched)} 个版本；同一份日志里两次空闲退出：${String(doubled)} 个版本`,
	);
}
