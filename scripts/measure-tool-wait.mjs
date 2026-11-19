/**
 * 尺子：会话里每批工具调用，第一个工具开跑前空等了多久、每个工具自己跑了多久。
 *
 *   node scripts/measure-tool-wait.mjs <会话.jsonl>
 *
 * pi 记的 `durationMs` 只算工具本身；工具前的检查、跑完后扩展挂的处理（cosmic 附类周边、写法检查）不算在里面。
 * cosmic 的工具是一个接一个跑的，结果消息在每个工具处理完时打时间，所以：
 * 「助手消息写完 → 第一条结果」减去第一个工具的运行时长，就是前后挂的处理花的时间。
 * 读文件本身 0 秒却隔了几秒，就是这里。口径和基线见 `docs/tui-blocking-diagnosis.md` 第二轮。
 *
 * 只读：只读会话文件。
 */
import { readFileSync } from "node:fs";

const lines = readFileSync(process.argv[2], "utf8")
	.split("\n")
	.filter(Boolean)
	.map((l) => JSON.parse(l));
let prev = null;
let batchStart = null;
let rows = [];
const flush = () => {
	if (rows.length) {
		console.log(rows.join("\n"));
		rows = [];
	}
};
for (const e of lines) {
	const m = e.message;
	if (!m) continue;
	if (m.role === "assistant") {
		flush();
		batchStart = Date.parse(e.timestamp);
		prev = null;
		continue;
	}
	if (m.role !== "toolResult") {
		prev = null;
		continue;
	}
	const t = m.timestamp;
	const firstGap = prev === null ? t - batchStart : null;
	const gap =
		prev === null ? "" : `发上一条后隔 ${((t - prev.t) / 1000).toFixed(1)}s(上一条 ${prev.name} ${prev.size}B)`;
	rows.push(
		`${new Date(t).toLocaleTimeString("zh-CN", { hour12: false })} ${m.toolName.padEnd(18)} 跑 ${((m.durationMs ?? 0) / 1000).toFixed(1).padStart(5)}s ${firstGap !== null ? `批开始到首条结果 ${(firstGap / 1000).toFixed(1)}s` : gap}`,
	);
	prev = { t, name: m.toolName, size: JSON.stringify(m.content).length };
}
flush();
