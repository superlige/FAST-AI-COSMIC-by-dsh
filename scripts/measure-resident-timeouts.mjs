/** 只读真实会话：数执行超时、BUSY 降级和手动重启，列出前一次工具返回后隔了多久。 */
import { readFileSync } from "node:fs";

const files = process.argv.slice(2);
if (files.length === 0) throw new Error("用法：node scripts/measure-resident-timeouts.mjs <会话.jsonl…>");
for (const file of files) {
	let lastResult = null;
	const calls = new Map();
	const events = [];
	const counts = { timeouts: 0, busyFallbacks: 0, restarts: 0 };
	for (const [index, line] of readFileSync(file, "utf8").split(/\r?\n/).entries()) {
		if (!line.trim()) continue;
		const entry = JSON.parse(line);
		const message = entry.message;
		if (!message) continue;
		const at = Date.parse(entry.timestamp);
		for (const block of Array.isArray(message.content) ? message.content : []) {
			if (block.type === "toolCall")
				calls.set(block.id, {
					at,
					args: block.arguments,
					gap: lastResult === null ? null : (at - lastResult) / 1000,
				});
		}
		if (message.role !== "toolResult") continue;
		const body = (message.content ?? [])
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		const call = calls.get(message.toolCallId);
		const timeout = /探针超过 \d+ 秒未结束/.test(body);
		const busy = /常驻 BUSY，降级冷进程/.test(body);
		const restart =
			message.toolName === "cosmic_runtime" &&
			(call?.args?.action === "probe-restart" ||
				call?.args?.action === "restart" ||
				call?.args?.argv?.includes("restart"));
		if (timeout) counts.timeouts++;
		if (busy) counts.busyFallbacks++;
		if (restart) counts.restarts++;
		if (timeout || busy || restart)
			events.push({
				line: index + 1,
				at: entry.timestamp,
				tool: message.toolName,
				timeout,
				busy,
				restart,
				seconds: call ? (at - call.at) / 1000 : null,
				gapSincePreviousResult: call?.gap ?? null,
				args: call?.args ?? null,
			});
		lastResult = at;
	}
	console.log(JSON.stringify({ file, counts, events }, null, 2));
}
