/**
 * 尺子：常驻苍穹进程发出去的 SQL，时间花在哪一步；有没有哪一条干等了很久。
 *
 *   node scripts/measure-sql-stalls.mjs [--cache <缓存根>] [--key <版本目录名>] [--stall 3000] [--show] [--tables [N]]
 *   node scripts/measure-sql-stalls.mjs <日志文件…>
 *
 * 读的是常驻进程落在缓存目录里的日志（probe-server.log 和 probe-runs 下每次运行的完整日志）。
 * 苍穹给每条 SQL 记一行「#cost:总毫秒 …include(取连接、预编译、执行、取结果 各多少)」，这里按这一行算：
 *
 * - 一共多少条 SQL、合计多久，四步各占多少（取连接那一步是连接池借出前探活的一趟来回）；
 * - 干等：单条 ≥ --stall 毫秒的（默认 3 秒），列出时刻、卡在哪一步、它之前多久没有别的 SQL；
 *   连接「连上了却没人应」时，SQL 要等操作系统重传放弃，就是卡在预编译 20 秒上下的那种；
 *   卡在取连接 8～11 秒的是进程起来后第一次连库；
 * - 连接断开类报错出现几次。
 *
 * - `--tables [N]`：按 SQL 读写的第一张表分（默认列前 12 张），每张表几条、合计多久、其中取结果多久，
 *   再报一句「平台元数据表（T_META_ 开头）占多少」——一个进程第一次碰某类单据、某个操作时，
 *   平台要把它的元数据从库里读过来，慢就慢在这里；
 *
 * 不带 --key 时每个版本目录各报一行；--show 逐条列干等。probe-runs 只留最近 40 次运行，量的是这 40 次。
 *
 * 只读。口径和基线见 `docs/S59-call-overhead-idle-connections.md` §2.3。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const argv = process.argv.slice(2);
const one = (name) => {
	const at = argv.indexOf(name);
	return at >= 0 ? argv[at + 1] : undefined;
};
const flag = (name) => argv.includes(name);
const valued = new Set(["--cache", "--key", "--stall"]);
// --tables 后面可以跟个数，也可以不跟
if (argv.includes("--tables") && /^\d+$/.test(argv[argv.indexOf("--tables") + 1] ?? "")) valued.add("--tables");
const given = [];
for (let i = 0; i < argv.length; i++) {
	if (valued.has(argv[i])) i += 1;
	else if (!argv[i].startsWith("--")) given.push(argv[i]);
}
const stallMs = Number(one("--stall") ?? 3000);
const cacheRoot = one("--cache") ?? join(homedir(), ".fast-ai-cosmic", "cache");

const COST = /^#cost:(\d+)ms,time is:(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}), include\(([^)]*)/;
const STEP_NAMES = [
	["getconnection", "取连接"],
	["connection.prepareStatement", "预编译"],
	["execute", "执行"],
	["result_handle", "取结果"],
];
const LOST = /Failed to validate connection|Communications link failure|No operations allowed after connection closed/;
const STAMP = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3})\s/;
/** #cost 的下一行是 SQL 原文：取它读写的第一张表 */
const TABLE = /\b(?:from|update|into|join)\s+([A-Za-z_][\w$]*)/i;

function stepOf(name) {
	if (name === "getconnection") return "getconnection";
	if (name === "connection.prepareStatement") return "connection.prepareStatement";
	if (name === "result_handle") return "result_handle";
	if (/^(?:preparedStatement|statement)\.execute/.test(name)) return "execute";
	return null;
}

function measure(label, paths) {
	const seen = new Set();
	const sql = [];
	const lost = new Set();
	for (const path of paths) {
		let lastStamp = null;
		let awaitingText = null;
		for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
			if (awaitingText !== null) {
				awaitingText.table = (TABLE.exec(line)?.[1] ?? "（认不出表）").toUpperCase();
				awaitingText = null;
			}
			const stamp = STAMP.exec(line);
			if (stamp !== null) lastStamp = stamp[1];
			if (LOST.test(line)) lost.add(`${lastStamp ?? basename(path)}|${line.slice(0, 160)}`);
			const hit = COST.exec(line);
			if (hit === null) continue;
			// 同一条 SQL 会同时落在进程日志和那次运行的日志里：按「时刻 + 整行」只算一次
			if (seen.has(line)) continue;
			seen.add(line);
			const steps = {};
			for (const part of hit[3].split(",")) {
				const pair = /^\s*([\w.]+):(\d+)ms/.exec(part);
				if (pair === null) continue;
				const step = stepOf(pair[1]);
				if (step !== null) steps[step] = (steps[step] ?? 0) + Number(pair[2]);
			}
			awaitingText = {
				ms: Number(hit[1]),
				at: new Date(hit[2].replace(" ", "T")).getTime(),
				when: hit[2],
				steps,
				table: "（认不出表）",
			};
			sql.push(awaitingText);
		}
	}
	const tables = new Map();
	for (const one of sql) {
		const row = tables.get(one.table) ?? { table: one.table, count: 0, ms: 0, resultMs: 0 };
		row.count += 1;
		row.ms += one.ms;
		row.resultMs += one.steps.result_handle ?? 0;
		tables.set(one.table, row);
	}
	sql.sort((a, b) => a.at - b.at);
	const sum = { total: 0 };
	for (const one of sql) {
		sum.total += one.ms;
		for (const [step, ms] of Object.entries(one.steps)) sum[step] = (sum[step] ?? 0) + ms;
	}
	const stalls = [];
	for (let i = 0; i < sql.length; i++) {
		const one = sql[i];
		if (one.ms < stallMs) continue;
		const worst = Object.entries(one.steps).sort((a, b) => b[1] - a[1])[0];
		// 这条 SQL 是 at 时刻结束的；它开始之前，上一条是什么时候结束的
		const idleMs = i === 0 ? null : one.at - one.ms - sql[i - 1].at;
		stalls.push({ when: one.when, ms: one.ms, step: worst?.[0] ?? "?", stepMs: worst?.[1] ?? 0, idleMs });
	}
	return {
		label,
		files: paths.length,
		sql: sql.length,
		sum,
		stalls,
		lost: lost.size,
		tables: [...tables.values()].sort((a, b) => b.ms - a.ms),
	};
}

const targets = [];
if (given.length > 0) {
	targets.push(["给的日志", given]);
} else {
	const keys = one("--key") ? [one("--key")] : existsSync(cacheRoot) ? readdirSync(cacheRoot).sort() : [];
	for (const key of keys) {
		const keyDir = join(cacheRoot, key);
		const paths = [];
		if (!existsSync(keyDir)) continue;
		try {
			for (const name of readdirSync(keyDir)) if (/^probe-server.*\.log$/.test(name)) paths.push(join(keyDir, name));
			const runs = join(keyDir, "probe-runs");
			if (existsSync(runs))
				for (const name of readdirSync(runs)) if (name.endsWith(".out")) paths.push(join(runs, name));
		} catch {
			continue;
		}
		if (paths.length > 0) targets.push([key, paths]);
	}
}

const reports = targets.map(([label, paths]) => measure(label, paths)).filter((report) => report.sql > 0);
if (flag("--json")) {
	console.log(JSON.stringify(reports, null, 2));
} else {
	const sec = (ms) => ((ms ?? 0) / 1000).toFixed(1);
	const share = (ms, total) => (total > 0 ? `${String(Math.round(((ms ?? 0) / total) * 100))}%` : "0%");
	if (reports.length === 0) console.log("没有找到带 SQL 记录的日志。");
	for (const report of reports) {
		const stalled = report.stalls.reduce((sum, stall) => sum + stall.ms, 0);
		console.log(
			`${report.label}　日志 ${String(report.files)} 份　SQL ${String(report.sql)} 条，合计 ${sec(report.sum.total)} 秒：` +
				STEP_NAMES.map(
					([step, name]) => `${name} ${sec(report.sum[step])} 秒（${share(report.sum[step], report.sum.total)}）`,
				).join("、"),
		);
		console.log(
			`  干等（单条 ≥ ${sec(stallMs)} 秒）${String(report.stalls.length)} 条，共 ${sec(stalled)} 秒；连接断开类报错 ${String(report.lost)} 处`,
		);
		if (flag("--tables")) {
			const top = Number(one("--tables")) > 0 ? Number(one("--tables")) : 12;
			const meta = report.tables.filter((row) => row.table.startsWith("T_META_"));
			const metaMs = meta.reduce((sum, row) => sum + row.ms, 0);
			const metaCount = meta.reduce((sum, row) => sum + row.count, 0);
			console.log(
				`  平台元数据表（T_META_ 开头）${String(metaCount)} 条，共 ${sec(metaMs)} 秒，占 SQL 时间 ${share(metaMs, report.sum.total)}`,
			);
			for (const row of report.tables.slice(0, top)) {
				console.log(
					`    ${row.table.padEnd(30)} ${String(row.count).padStart(5)} 条　${sec(row.ms).padStart(6)} 秒（${share(row.ms, report.sum.total)}）　其中取结果 ${sec(row.resultMs)} 秒`,
				);
			}
		}
		if (flag("--show") || reports.length === 1) {
			for (const stall of report.stalls) {
				const stepName = STEP_NAMES.find(([step]) => step === stall.step)?.[1] ?? stall.step;
				console.log(
					`    ${stall.when}　${sec(stall.ms)} 秒，卡在${stepName}（${sec(stall.stepMs)} 秒）` +
						(stall.idleMs === null ? "" : `；它之前 ${sec(Math.max(0, stall.idleMs))} 秒没有别的 SQL`),
				);
			}
		}
	}
}
