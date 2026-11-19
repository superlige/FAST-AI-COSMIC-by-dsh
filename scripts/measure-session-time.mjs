#!/usr/bin/env node
/**
 * 一次会话的时间花在哪、上下文被什么撑大。
 *
 * 用法：node scripts/measure-session-time.mjs <会话.jsonl> [--rounds] [--seg=名称:起-止 …] [--kinds] [--prewrite] [--json]
 *
 * 出这几样数（2026-09-27 排查 S37 批 4 需求 1 用 20.7 分钟时写的）：
 *   - 时间：模型生成用了多久、工具执行用了多久。assistant 消息的时间戳是生成结束的时刻
 *     （`show` 这类不花时间的工具，返回紧跟在它后面），所以「上一批工具返回 → 这条 assistant」算模型，
 *     「这条 assistant → 它最后一个工具返回」算工具；
 *   - 产出：输出 token、其中思考 token、思考字数；
 *   - 上下文构成：最后一轮送进去的上下文 = 第一轮的固定部分 + 之前各轮自己的输出（思考会被原样回传）+ 工具返回，
 *     后两项是按「每轮上下文增量 − 上一轮输出」拆出来的估算；
 *   - 工具返回字节按工具分；
 *   - 思考里的犹豫：「hmm / actually / wait」和「重读需求」出现次数，以及和前面某轮一字不差的句子数。
 *     这些只是线索，难题本来就会多想，不能单独拿来说模型注意力散了。
 * --rounds 逐轮列出每次调用（耗时、返回字节、参数前 110 字）。
 * --seg=名称:起-止 按调用序号分段合计时间（可写多个，同名的段合在一起）。一轮按它第一次调用的序号归段，
 *   没有调用的一轮归到下一次调用所在的段；区间要人对着 --rounds 定，同一份会话复量用同一组区间
 *   （S37 批 6 排查"找样本拖慢多少"时加的）。只读会话记录。
 * --kinds 不用人定区间，按调用本身归类（开工程、读代码查元数据、找数据、造改数据、临时探针、写代码、验证、问用户、收尾），
 *   跨会话比时间花在哪用这个（S37 批 8 之后回看"几轮优化到底有没有提升"时加的）。
 * --prewrite 动手写代码之前那一段（S38 立项时加的）：第一次写代码在第几分钟、之前几轮几次调用、模型输出多少 token，
 *   第一次断言全过在第几分钟、之前输出多少 token，以及单次探针的净耗时中位数和服务商每秒出多少 token。
 *   「写代码」= cosmic_fast，或 write / edit 了 .cosmic-ai 以外的文件（和 S38 当时界面上"还未开始编码"那行提示同一口径）。
 *   比"想了多少"看输出 token，不看分钟：S37 批 4 和批 8 服务商出字速度差一倍（189 对 90 token/秒），
 *   测试环境响应也会变（批 8 单次探针中位 9 秒，其余 4 秒）。
 */
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const file = argv.find((arg) => !arg.startsWith("--"));
if (file === undefined) {
	console.error(
		"用法：node scripts/measure-session-time.mjs <会话.jsonl> [--rounds] [--seg=名称:起-止 …] [--kinds] [--prewrite] [--json]",
	);
	process.exit(2);
}
const entries = readFileSync(file, "utf8")
	.split(/\r?\n/)
	.filter((line) => line.trim() !== "")
	.map((line) => JSON.parse(line));

const at = (entry) => Date.parse(entry.timestamp);
const textOf = (content) =>
	Array.isArray(content) ? content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("") : "";
const partsOf = (message, type) => message.content.filter((part) => part.type === type);

const results = new Map();
for (const entry of entries) {
	if (entry.message?.role === "toolResult") results.set(entry.message.toolCallId, entry);
}

const HESITATE = /\bhmm\b|\bactually,|\bwait[,.]/gi;
const REREAD = /re-?read|re-examine|重新看|再读一遍/gi;
const rounds = [];
const byTool = {};
const seenSentences = new Set();
let repeatedSentences = 0;
let hesitations = 0;
let rereads = 0;
let previousEnd = null;
let callNo = 0;
const start = at(entries[0]);

for (const entry of entries) {
	const message = entry.message;
	if (message === undefined) continue;
	if (message.role === "user") {
		previousEnd = at(entry);
		continue;
	}
	if (message.role !== "assistant") continue;
	const thinking = partsOf(message, "thinking")
		.map((part) => part.thinking)
		.join("\n");
	hesitations += (thinking.match(HESITATE) ?? []).length;
	rereads += (thinking.match(REREAD) ?? []).length;
	for (const sentence of thinking.split(/(?<=[.!?。？])\s+|\n+/)) {
		const key = sentence.trim().toLowerCase();
		if (key.length <= 40) continue;
		if (seenSentences.has(key)) repeatedSentences++;
		else seenSentences.add(key);
	}
	let lastResult = at(entry);
	const calls = partsOf(message, "toolCall").map((call) => {
		callNo++;
		const result = results.get(call.id);
		const bytes = result === undefined ? 0 : Buffer.byteLength(textOf(result.message.content));
		if (result !== undefined) lastResult = Math.max(lastResult, at(result));
		byTool[call.name] ??= { calls: 0, bytes: 0 };
		const slot = byTool[call.name];
		slot.calls++;
		slot.bytes += bytes;
		const args = call.arguments ?? {};
		return {
			no: callNo,
			tool: call.name,
			error: result?.message.isError === true,
			bytes,
			seconds: result === undefined ? null : (at(result) - at(entry)) / 1000,
			args: String(args.command ?? args.path ?? JSON.stringify(args))
				.replace(/\s+/g, " ")
				.slice(0, 110),
		};
	});
	const usage = message.usage ?? {};
	rounds.push({
		minute: (at(entry) - start) / 60000,
		modelSeconds: previousEnd === null ? 0 : (at(entry) - previousEnd) / 1000,
		toolSeconds: (lastResult - at(entry)) / 1000,
		context: (usage.input ?? 0) + (usage.cacheRead ?? 0),
		output: usage.output ?? 0,
		reasoning: usage.reasoning ?? 0,
		thinkingChars: thinking.length,
		calls,
	});
	previousEnd = lastResult;
}

const sum = (pick) => rounds.reduce((total, round) => total + pick(round), 0);
const first = rounds[0];
const last = rounds.at(-1);
// Everything before the last round's own output went back in: its growth over round one
// splits into the model's earlier outputs (replayed, thinking included) and tool returns.
const replayedOutput = sum((round) => round.output) - (last?.output ?? 0);
const growth = (last?.context ?? 0) - (first?.context ?? 0);
const summary = {
	file,
	minutes: rounds.length === 0 ? 0 : Number(((at(entries.at(-1)) - start) / 60000).toFixed(1)),
	modelMinutes: Number((sum((round) => round.modelSeconds) / 60).toFixed(1)),
	toolMinutes: Number((sum((round) => round.toolSeconds) / 60).toFixed(1)),
	modelCalls: rounds.length,
	toolCalls: callNo,
	outputTokens: sum((round) => round.output),
	reasoningTokens: sum((round) => round.reasoning),
	thinkingChars: sum((round) => round.thinkingChars),
	context: {
		last: last?.context ?? 0,
		fixed: first?.context ?? 0,
		replayedOutput,
		toolReturnsEstimate: growth - replayedOutput,
	},
	byTool,
	thinking: { hesitations, rereads, repeatedSentences, sentences: seenSentences.size + repeatedSentences },
};

const segSpecs = argv
	.filter((arg) => arg.startsWith("--seg="))
	.map((arg) => {
		const match = /^--seg=(.+):(\d+)-(\d+)$/.exec(arg);
		if (match === null) {
			console.error(`看不懂 ${arg}，写成 --seg=名称:起-止`);
			process.exit(2);
		}
		return { name: match[1], from: Number(match[2]), to: Number(match[3]) };
	});
if (segSpecs.length > 0) {
	const segments = {};
	let nextCall = 1;
	for (const round of rounds) {
		const no = round.calls[0]?.no ?? nextCall;
		const name = segSpecs.find((spec) => no >= spec.from && no <= spec.to)?.name ?? "（未分段）";
		segments[name] ??= { minutes: 0, modelMinutes: 0, toolMinutes: 0, rounds: 0, calls: 0, thinkingChars: 0 };
		const slot = segments[name];
		slot.modelMinutes += round.modelSeconds / 60;
		slot.toolMinutes += round.toolSeconds / 60;
		slot.rounds++;
		slot.calls += round.calls.length;
		slot.thinkingChars += round.thinkingChars;
		nextCall = (round.calls.at(-1)?.no ?? nextCall - 1) + 1;
	}
	for (const slot of Object.values(segments)) {
		slot.minutes = Number((slot.modelMinutes + slot.toolMinutes).toFixed(1));
		slot.modelMinutes = Number(slot.modelMinutes.toFixed(1));
		slot.toolMinutes = Number(slot.toolMinutes.toFixed(1));
	}
	summary.segments = segments;
}

// --kinds：不用人定区间，按调用本身归类（同一份规则量所有会话）。一轮的模型时间加工具时间平均摊给这一轮的各次调用，
// 没有调用的一轮（最后交代结果）记「收尾」。临时探针 = 名字不在开工程回执 releasedProbes 里的探针，或写进 .cosmic-ai/probes/ 的文件。
if (argv.includes("--kinds")) {
	const released = new Set();
	for (const entry of entries) {
		if (entry.message?.role !== "toolResult" || entry.message.toolName !== "cosmic_open_project") continue;
		const match = /"releasedProbes":\[([^\]]*)\]/.exec(textOf(entry.message.content));
		for (const name of match?.[1].match(/[A-Za-z0-9_]+/g) ?? []) released.add(name);
	}
	const argsByNo = new Map();
	let no = 0;
	for (const entry of entries) {
		if (entry.message?.role !== "assistant") continue;
		for (const call of partsOf(entry.message, "toolCall")) argsByNo.set(++no, call.arguments ?? {});
	}
	const kindOf = (call) => {
		const args = argsByNo.get(call.no) ?? {};
		const path = String(args.path ?? "").replace(/\\/g, "/");
		switch (call.tool) {
			case "cosmic_open_project":
				return "开工程";
			case "ask_question":
				return "问用户";
			case "cosmic_run":
			case "cosmic_verify":
				return "验证";
			case "cosmic_fast":
				return "写代码";
			case "write":
			case "edit":
				return path.includes(".cosmic-ai/probes/") ? "临时探针" : "写代码";
			case "cosmic_probe": {
				const name = String(args.name ?? "");
				// 查平台自己的配置表（接口登记、应用、表单、流程模型）是在读元数据，不是找业务数据
				if (/^Data(Query|)Probe$/.test(name)) {
					const entity = String(args.env?.QUERY_ENTITY ?? args.env?.DATA_ENTITY ?? "");
					return /^(openapi_|bos_devportal_|bos_formmeta|wf_model)/.test(entity) ? "读代码查元数据" : "找数据";
				}
				if (/^Data(Seed|Update)Probe$/.test(name)) return "造改数据";
				if (released.size > 0 && !released.has(name)) return "临时探针";
				return "读代码查元数据";
			}
			default:
				return "读代码查元数据";
		}
	};
	const kinds = {};
	for (const round of rounds) {
		const seconds = round.modelSeconds + round.toolSeconds;
		const names = round.calls.length === 0 ? ["收尾"] : round.calls.map(kindOf);
		for (const name of names) {
			kinds[name] ??= { minutes: 0, calls: 0 };
			kinds[name].minutes += seconds / names.length / 60;
			if (round.calls.length > 0) kinds[name].calls++;
		}
	}
	for (const slot of Object.values(kinds)) slot.minutes = Number(slot.minutes.toFixed(1));
	summary.kinds = kinds;
}

if (argv.includes("--prewrite")) {
	const isCodeWrite = (call) =>
		call.name === "cosmic_fast" ||
		((call.name === "write" || call.name === "edit") &&
			!String(call.arguments?.path ?? "")
				.replace(/\\/g, "/")
				.includes(".cosmic-ai/"));
	const firstUser = entries.find((entry) => entry.message?.role === "user");
	const t0 = firstUser === undefined ? start : at(firstUser);
	const minuteOf = (entry) => Number(((at(entry) - t0) / 60000).toFixed(1));
	let output = 0;
	let calls = 0;
	let roundCount = 0;
	let write = null;
	let pass = null;
	const probeSeconds = [];
	const speeds = [];
	let last = null;
	for (const entry of entries) {
		const message = entry.message;
		if (message?.role === "user") last = at(entry);
		if (message?.role !== "assistant") continue;
		const toolCalls = partsOf(message, "toolCall");
		if (write === null && toolCalls.some(isCodeWrite)) {
			write = { minute: minuteOf(entry), rounds: roundCount, calls, outputTokens: output };
		}
		const modelSeconds = last === null ? 0 : (at(entry) - last) / 1000;
		// 等用户、卡住的轮不算速度
		if (modelSeconds > 5 && modelSeconds < 120 && (message.usage?.output ?? 0) > 200) {
			speeds.push(message.usage.output / modelSeconds);
		}
		output += message.usage?.output ?? 0;
		roundCount++;
		calls += toolCalls.length;
		// 同一轮的调用是一个接一个跑的：净耗时 = 自己的返回减去前一个返回
		let previous = at(entry);
		const done = toolCalls
			.map((call) => ({ call, result: results.get(call.id) }))
			.filter((item) => item.result !== undefined)
			.sort((a, b) => at(a.result) - at(b.result));
		for (const { call, result } of done) {
			if (call.name === "cosmic_probe") probeSeconds.push((at(result) - previous) / 1000);
			previous = at(result);
			if (pass === null && call.name === "cosmic_run" && /条断言全过/.test(textOf(result.message.content))) {
				const passed = textOf(result.message.content).match(/(\d+) 条断言全过/);
				if (passed !== null && Number(passed[1]) > 0) pass = { minute: minuteOf(result), outputTokens: output };
			}
		}
		last = done.length === 0 ? at(entry) : at(done.at(-1).result);
	}
	const median = (values) => {
		const sorted = [...values].sort((a, b) => a - b);
		return sorted.length === 0 ? null : Number(sorted[Math.floor(sorted.length / 2)].toFixed(1));
	};
	summary.prewrite = {
		firstWrite: write,
		firstPass: pass,
		probeSecondsMedian: median(probeSeconds),
		tokensPerSecondMedian: median(speeds),
	};
}

if (argv.includes("--json")) {
	console.log(JSON.stringify(argv.includes("--rounds") ? { ...summary, rounds } : summary, null, 2));
} else {
	if (argv.includes("--rounds")) {
		for (const round of rounds) {
			console.log(
				`[${round.minute.toFixed(1)}m] 模型 ${round.modelSeconds.toFixed(1)}s 工具 ${round.toolSeconds.toFixed(1)}s ` +
					`上下文 ${String(round.context)} 输出 ${String(round.output)} 思考 ${String(round.thinkingChars)} 字`,
			);
			for (const call of round.calls) {
				const seconds = call.seconds === null ? "?" : call.seconds.toFixed(1);
				console.log(
					`    #${String(call.no)} ${call.tool}${call.error ? "[错]" : ""} ${String(call.bytes)}B ${seconds}s | ${call.args}`,
				);
			}
		}
	}
	console.log(JSON.stringify(summary, null, 2));
}
