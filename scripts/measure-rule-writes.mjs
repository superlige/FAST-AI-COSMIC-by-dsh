/** 只读会话，统计界面规则每次写入耗时；同一尺子可量批量入口。 */
import { readFileSync } from "node:fs";

const calls = new Map();
const totals = {};
for (const line of readFileSync(process.argv[2], "utf8").split("\n").filter(Boolean)) {
	const entry = JSON.parse(line);
	const message = entry.message ?? {};
	for (const block of Array.isArray(message.content) ? message.content : []) {
		if (
			block.type === "toolCall" &&
			block.arguments?.name === "FormRuleProbe" &&
			block.arguments?.env?.APPLY === "1" &&
			!block.arguments.raw
		)
			calls.set(block.id, { time: entry.timestamp, env: block.arguments.env });
	}
	const call = calls.get(message.toolCallId);
	if (message.role !== "toolResult" || !call) continue;
	const kind = call.env.RULE_BATCH ? "batch" : call.env.ROLLBACK === "1" ? "delete" : "update";
	const seconds = (Date.parse(entry.timestamp) - Date.parse(call.time)) / 1000;
	totals[kind] ??= { calls: 0, seconds: 0 };
	totals[kind].calls++;
	totals[kind].seconds += seconds;
	console.log(JSON.stringify({ time: call.time, kind, seconds }));
}
console.log(JSON.stringify(totals, null, 2));
