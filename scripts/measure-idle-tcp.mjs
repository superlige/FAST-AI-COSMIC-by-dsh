/**
 * 尺子：本机到一台服务器之间，连接会不会「连上了却没人应」——新连接里有几条是坏的、闲置的连接闲多久会被掐。
 *
 *   node scripts/measure-idle-tcp.mjs <主机:端口> [--idle 120,240,300,360,480,600] [--send "PING\r\n"] [--wait 30]
 *     [--stagger 毫秒]
 *
 * 每个闲置时长开一条连接，连上以后什么都不发，闲够时间再发一小段字节，看对方有没有动静。
 * 闲置时长写 0 就是连上马上发，量的是「新连接本身有几条是坏的」，给闲置的当对照；
 * `--stagger` 让连接隔几毫秒建一条——同一瞬间开几十条，对方来不及接的那几条也会没人应，那是量法造成的。
 *
 * - 有应答、或者对方正常关连接：这条路还通，闲这么久没被掐；
 * - 被重置：中间设备（或对方）已经不认这条连接了，但本机马上就知道，不会干等；
 * - 等了 --wait 秒什么都没有：连接被悄悄掐了，两头都没收到通知——程序里表现为下一条 SQL 干等到操作系统重传放弃；
 * - 还没闲够对方就先关了：这个端口自己不留空连接，量不出中间设备，换个端口。
 *
 * 要挑一个肯留空连接的端口：苍穹环境里是 redis（`--send "PING\r\n"`，没登录它也会答一句）。
 * 数据库端口不行（没登录的连接十秒就关），zookeeper 也不行（空连接 16 秒就关）。`--send` 里的 \r、\n 会换成回车换行。
 * 量的是同一台主机、同一条网络路径，不是数据库连接本身。
 *
 * 只读：只建连接、发几个字节。口径和结果见 `docs/S59-call-overhead-idle-connections.md` §2.3。
 */
import { connect } from "node:net";

const argv = process.argv.slice(2);
const one = (name) => {
	const at = argv.indexOf(name);
	return at >= 0 ? argv[at + 1] : undefined;
};
const target = argv.find((arg, i) => !arg.startsWith("--") && !(argv[i - 1] ?? "").startsWith("--"));
if (target === undefined || !target.includes(":")) {
	console.error(
		"用法：node scripts/measure-idle-tcp.mjs <主机:端口> [--idle 120,240,300,360,480,600] [--send 要发的字] [--wait 30]",
	);
	process.exit(2);
}
const [host, portText] = target.split(":");
const port = Number(portText);
const idles = (one("--idle") ?? "120,240,300,360,480,600").split(",").map(Number);
const payload = (one("--send") ?? "PING\\r\\n").replace(/\\r/g, "\r").replace(/\\n/g, "\n");
const waitSeconds = Number(one("--wait") ?? "30");
const staggerMs = Number(one("--stagger") ?? "0");
const stamp = () => new Date().toTimeString().slice(0, 8);

function probe(idleSeconds) {
	return new Promise((done) => {
		const socket = connect({ host, port });
		const opened = Date.now();
		let sentAt = null;
		let settled = false;
		const finish = (outcome, detail = "") => {
			if (settled) return;
			settled = true;
			socket.destroy();
			const row = {
				idleSeconds,
				outcome,
				detail,
				afterSendMs: sentAt === null ? null : Date.now() - sentAt,
				aliveSeconds: Math.round((Date.now() - opened) / 1000),
			};
			console.error(
				`[${stamp()}] 闲 ${String(idleSeconds)} 秒：${outcome}${detail ? `（${detail}）` : ""}` +
					(sentAt === null ? "" : `，发出后 ${String(row.afterSendMs)} 毫秒`),
			);
			done(row);
		};
		socket.on("connect", () => {
			setTimeout(() => {
				if (settled) return;
				sentAt = Date.now();
				socket.write(payload);
				setTimeout(() => finish("没有动静", `等了 ${String(waitSeconds)} 秒`), waitSeconds * 1000);
			}, idleSeconds * 1000);
		});
		socket.on("data", (chunk) => {
			if (sentAt !== null) finish("有应答", JSON.stringify(chunk.toString("latin1").slice(0, 40)));
		});
		socket.on("end", () => {
			if (sentAt === null)
				finish("还没闲够对方就先关了", `连上 ${String(Math.round((Date.now() - opened) / 1000))} 秒后`);
			else finish("对方正常关了连接");
		});
		socket.on("error", (error) => {
			finish(
				error.code === "ECONNRESET" ? "被重置" : "出错",
				sentAt === null ? `还没发，${error.code}` : error.code,
			);
		});
	});
}

console.error(
	`[${stamp()}] ${host}:${String(port)}　闲置 ${idles.join("、")} 秒各一条连接，闲够后发 ${JSON.stringify(payload)}`,
);
const rows = await Promise.all(
	idles.map(async (idleSeconds, i) => {
		if (staggerMs > 0) await new Promise((go) => setTimeout(go, i * staggerMs));
		return probe(idleSeconds);
	}),
);
// 发出去以后 2 秒内有应答或者对方干脆地关了连接：这条路是通的。拖了很久才断、或者等到头都没动静：连上了却没人应
const early = rows.filter((row) => row.afterSendMs === null);
const sent = rows.filter((row) => row.afterSendMs !== null);
const silent = sent.filter((row) => row.outcome !== "有应答" && (row.afterSendMs ?? 0) > 2000);
const report = {
	host,
	port,
	opened: rows.length,
	alive: sent.length - silent.length,
	silent: silent.map((row) => ({ idleSeconds: row.idleSeconds, outcome: row.outcome, afterSendMs: row.afterSendMs })),
	closedBeforeIdle: early.length,
	rows,
};
if (argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
else {
	console.log(
		`${host}:${String(port)}　开了 ${String(report.opened)} 条：通的 ${String(report.alive)} 条；连上了却没人应 ${String(silent.length)} 条` +
			(early.length > 0 ? `；还没闲够对方就先关了 ${String(early.length)} 条（这个端口不留空连接，换一个）` : ""),
	);
	for (const row of silent) {
		console.log(
			`  闲 ${String(row.idleSeconds)} 秒的一条：${row.outcome}，发出后 ${((row.afterSendMs ?? 0) / 1000).toFixed(1)} 秒`,
		);
	}
}
// 已经有结果的连接，闲置的定时器还挂着；不退出的话进程要等到最长的那个闲置时长才走
process.exit(0);
